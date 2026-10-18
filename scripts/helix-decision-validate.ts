import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import crypto from "node:crypto";

const ROOT = process.cwd();
const packagePath = process.argv.includes("--package")
  ? process.argv[process.argv.indexOf("--package") + 1]
  : "reports/helix-decision-package.json";
const reportPath = "reports/helix-decision-validate.json";
const schemaPath = "schemas/helix-decision-package.schema.json";
const timelinePointerPath = "reports/helix-decision-timeline.latest.json";

function compactUtcTimestamp(now = new Date()): string {
  return now.toISOString().replace(/[-:.TZ]/g, "");
}

function createStandaloneRunId(): string {
  return `${compactUtcTimestamp()}-${crypto.randomUUID().slice(0, 8)}`;
}

function resolveTimelineContext(): { runId: string; timelinePath: string; standaloneMode: boolean } {
  const envRunId = process.env.HELIX_DECISION_RUN_ID;
  const envTimelinePath = process.env.HELIX_DECISION_TIMELINE_PATH;
  if (envRunId && envTimelinePath) {
    return { runId: envRunId, timelinePath: envTimelinePath, standaloneMode: false };
  }
  const runId = envRunId ?? createStandaloneRunId();
  const timelinePath = envTimelinePath ?? `reports/helix-decision-timeline-${runId}.jsonl`;
  return { runId, timelinePath, standaloneMode: true };
}

const timelineContext = resolveTimelineContext();
const runId = timelineContext.runId;
const timelinePath = timelineContext.timelinePath;

function atomicWrite(filePath: string, contents: string): void {
  const abs = path.resolve(ROOT, filePath);
  const temp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, contents);
  fs.renameSync(temp, abs);
}

if (timelineContext.standaloneMode) {
  fs.mkdirSync(path.resolve(ROOT, "reports"), { recursive: true });
  const pointerPayload = { run_id: runId, timeline_path: timelinePath, source: "standalone_validate" };
  atomicWrite(timelinePointerPath, `${JSON.stringify(pointerPayload, null, 2)}\n`);
}

type TimelineEvent = {
  run_id: string;
  ts_iso: string;
  phase: string;
  event: string;
  pid: number;
  path: string | null;
  exists: boolean | null;
  size_bytes: number | null;
  mtime_iso: string | null;
  sha256: string | null;
  details: Record<string, unknown>;
};

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(path.resolve(ROOT, filePath), "utf8"));
}

function exists(filePath: string): boolean {
  return fs.existsSync(path.resolve(ROOT, filePath));
}

function fileMeta(filePath: string): { exists: boolean; size_bytes: number | null; mtime_iso: string | null; sha256: string | null } {
  const abs = path.resolve(ROOT, filePath);
  if (!fs.existsSync(abs)) return { exists: false, size_bytes: null, mtime_iso: null, sha256: null };
  const stat = fs.statSync(abs);
  const buf = fs.readFileSync(abs);
  return {
    exists: true,
    size_bytes: stat.size,
    mtime_iso: stat.mtime.toISOString(),
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  };
}

function appendTimeline(phase: string, event: string, options: { path?: string | null; details?: Record<string, unknown> } = {}): void {
  const abs = path.resolve(ROOT, timelinePath);
  const meta = options.path ? fileMeta(options.path) : { exists: null, size_bytes: null, mtime_iso: null, sha256: null };
  const eventRow: TimelineEvent = {
    run_id: runId,
    ts_iso: new Date().toISOString(),
    phase,
    event,
    pid: process.pid,
    path: options.path ?? null,
    exists: meta.exists,
    size_bytes: meta.size_bytes,
    mtime_iso: meta.mtime_iso,
    sha256: meta.sha256,
    details: options.details ?? {},
  };
  fs.mkdirSync(path.resolve(ROOT, "reports"), { recursive: true });
  fs.appendFileSync(abs, `${JSON.stringify(eventRow)}\n`);
}

function isUtilityAbSummary(obj: any): boolean {
  return (
    obj &&
    typeof obj === "object" &&
    obj.summary_schema_version === 2 &&
    typeof obj.novel_response_rate === "number" &&
    obj.novel_response_rate_by_family &&
    typeof obj.novel_response_rate_by_family.relation === "number" &&
    typeof obj.novel_response_rate_by_family.repo_technical === "number" &&
    typeof obj.novel_response_rate_by_family.ambiguous_general === "number"
  );
}

function normalizeAheadBehind(raw: any): { ahead: number; behind: number } | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const parts = raw
      .trim()
      .split(/\s+/)
      .map((v) => Number(v));
    if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      return { ahead: parts[1], behind: parts[0] };
    }
    return null;
  }
  if (typeof raw === "object") {
    const ahead = Number(raw.ahead ?? raw.ahead_count ?? Number.NaN);
    const behind = Number(raw.behind ?? raw.behind_count ?? Number.NaN);
    return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null;
  }
  return null;
}

function equalAheadBehind(a: { ahead: number; behind: number } | null, b: { ahead: number; behind: number } | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a.ahead === b.ahead && a.behind === b.behind;
}

const failures: string[] = [];
appendTimeline("decision_validate", "validate_start", { path: packagePath });
let pkg: any = null;
let schema: any = null;

try {
  schema = readJson(schemaPath);
} catch (err) {
  failures.push(`schema_unreadable:${String(err)}`);
}

try {
  pkg = readJson(packagePath);
} catch (err) {
  failures.push(`package_unreadable:${String(err)}`);
}

if (pkg && schema) {
  const ajv = new Ajv({ allErrors: true, jsonPointers: true });
  const validate = ajv.compile(schema);
  const valid = validate(pkg);
  if (!valid) {
    failures.push("schema_validation_failed");
    for (const err of validate.errors ?? []) {
      const pathLabel = err.instancePath || "/";
      failures.push(`schema_error:${pathLabel}:${err.message ?? "unknown"}`);
    }
  }

  if (!Array.isArray(pkg.gates)) {
    failures.push("gates_not_array");
  } else {
    for (const gate of pkg.gates) {
      if (!gate?.source_path || typeof gate.source_path !== "string") failures.push(`metric_missing_source:${gate?.name ?? "unknown"}`);
      else if (!exists(gate.source_path)) failures.push(`source_path_missing:${gate.name}:${gate.source_path}`);
    }
  }

  for (const [key, entry] of Object.entries(pkg.novelty ?? {})) {
    if (!entry || typeof (entry as any).source_path !== "string") {
      failures.push(`novelty_missing_source:${key}`);
      continue;
    }
    if (!exists((entry as any).source_path)) {
      failures.push(`novelty_source_missing:${key}:${(entry as any).source_path}`);
      continue;
    }
    try {
      const source = readJson((entry as any).source_path);
      if (!isUtilityAbSummary(source)) failures.push(`novelty_wrong_source_format:${key}:${(entry as any).source_path}`);
    } catch (err) {
      failures.push(`novelty_source_unreadable:${key}:${String(err)}`);
    }
  }

  if (!Array.isArray(pkg.artifacts)) {
    failures.push("artifacts_not_array");
  } else {
    for (const art of pkg.artifacts) {
      const liveExists = exists(art.path);
      if (art.exists === true && !liveExists) failures.push(`artifact_exists_true_but_missing:${art.path}`);
      if (art.exists === false && liveExists) failures.push(`artifact_exists_false_but_present:${art.path}`);
    }
  }

  const manifestPath = "reports/helix-decision-inputs.json";
  if (exists(manifestPath)) {
    try {
      const manifest = readJson(manifestPath);
      const selected = manifest?.selected_paths;
      const fieldChecks: Array<[string, any, any]> = [
        ["narrow", selected?.narrow ?? null, (pkg.gates ?? []).find((g: any) => g.name === "runtime_fallback_answer")?.source_path ?? null],
        ["heavy", selected?.heavy ?? null, (pkg.gates ?? []).find((g: any) => g.name === "relation_packet_built_rate")?.source_path ?? null],
        ["recommendation", selected?.recommendation ?? null, (pkg.gates ?? []).find((g: any) => g.name === "decision_grade_ready")?.source_path ?? null],
        ["ab_t02", selected?.ab_t02 ?? null, pkg.novelty?.t02?.source_path ?? null],
        ["ab_t035", selected?.ab_t035 ?? null, pkg.novelty?.t035?.source_path ?? null],
        ["casimir", selected?.casimir ?? null, pkg.casimir?.source_path ?? null],
      ];
      for (const [field, expected, actual] of fieldChecks) {
        if ((expected ?? null) !== (actual ?? null)) failures.push(`decision_inputs_manifest_mismatch:${field}`);
      }
    } catch (err) {
      failures.push(`decision_inputs_manifest_unreadable:${String(err)}`);
    }
  }

  if (pkg.evaluation_tier === "decision_grade") {
    if (!(pkg.casimir?.verdict === "PASS" && pkg.casimir?.integrityOk === true)) {
      failures.push("decision_grade_requires_casimir_pass_integrity");
    }
    if (!(pkg.provenance?.pass === true)) {
      failures.push("decision_grade_requires_provenance_pass");
    }

    const heavyGate = (pkg.gates ?? []).find((g: any) => g.name === "provenance_gate_pass");
    if (heavyGate?.source_path && exists(heavyGate.source_path)) {
      const heavy = readJson(heavyGate.source_path);
      const p = heavy?.provenance;
      if (p && typeof p === "object") {
        const mismatch: string[] = [];
        if ((p.branch ?? null) !== (pkg.git.branch ?? null)) mismatch.push("branch");
        if ((p.head ?? null) !== (pkg.git.head ?? null)) mismatch.push("head");
        const originMain = (p.originMain ?? p.origin_main ?? null) as string | null;
        if (originMain !== (pkg.git.origin_main ?? null)) mismatch.push("origin_main");
        const ab = normalizeAheadBehind(p.aheadBehind ?? p.ahead_behind ?? null);
        const expectedAb = normalizeAheadBehind(pkg.git.ahead_behind ?? null);
        if (!equalAheadBehind(ab, expectedAb)) {
          mismatch.push("ahead_behind");
        }
        if (mismatch.length > 0) failures.push(`decision_grade_git_provenance_mismatch:${mismatch.join(",")}`);
      }
    }
  }
}

const out = {
  ok: failures.length === 0,
  package_path: packagePath,
  failures,
  failure_count: failures.length,
};
fs.mkdirSync(path.resolve(ROOT, "reports"), { recursive: true });
fs.writeFileSync(path.resolve(ROOT, reportPath), `${JSON.stringify(out, null, 2)}\n`);
if (!out.ok) {
  appendTimeline("decision_validate", "validator_first_blocker", {
    path: packagePath,
    details: { blocker: failures[0] ?? "unknown" },
  });
  appendTimeline("decision_validate", "validate_end", { path: packagePath, details: { ok: false, failure_count: failures.length } });
  console.log(JSON.stringify(out, null, 2));
  process.exit(1);
}
appendTimeline("decision_validate", "validator_pass", { path: packagePath, details: { failure_count: 0 } });
appendTimeline("decision_validate", "validate_end", { path: packagePath, details: { ok: true, failure_count: 0 } });
console.log(JSON.stringify(out, null, 2));
