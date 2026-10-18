import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

type JsonRecord = Record<string, unknown>;

type Gate = {
  name: string;
  value: number | boolean | string | null;
  threshold: number | boolean;
  comparator: string;
  pass: boolean;
  source_path: string;
};

const ROOT = process.cwd();
const REPORT_JSON = "reports/helix-decision-package.json";
const REPORT_MD = "reports/helix-decision-package.md";
const INPUTS_MANIFEST_JSON = "reports/helix-decision-inputs.json";
const TIMELINE_POINTER_JSON = "reports/helix-decision-timeline.latest.json";
const OUTPUT_FILES = [REPORT_JSON, REPORT_MD, INPUTS_MANIFEST_JSON] as const;

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

const TIMELINE_CONTEXT = resolveTimelineContext();
const RUN_ID = TIMELINE_CONTEXT.runId;
const TIMELINE_JSON = TIMELINE_CONTEXT.timelinePath;

if (TIMELINE_CONTEXT.standaloneMode) {
  fs.mkdirSync(path.resolve(ROOT, "reports"), { recursive: true });
  atomicWrite(
    TIMELINE_POINTER_JSON,
    `${JSON.stringify({ run_id: RUN_ID, timeline_path: TIMELINE_JSON, source: "standalone_package" }, null, 2)}\n`,
  );
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

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith("--")) continue;
  const key = token.slice(2);
  const value = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "true";
  args.set(key, value);
}

function opt(name: string, fallback?: string): string {
  return args.get(name) ?? process.env[name.toUpperCase().replace(/-/g, "_")] ?? fallback ?? "";
}

function clearOutputs(): void {
  for (const filePath of OUTPUT_FILES) {
    const abs = path.resolve(ROOT, filePath);
    try {
      if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
    } catch {
      // best effort: keep failure path machine-readable
    }
  }
}

function appendTimeline(phase: string, event: string, options: { path?: string | null; details?: Record<string, unknown> } = {}): void {
  const timelinePath = path.resolve(ROOT, TIMELINE_JSON);
  const meta = options.path ? fileMeta(options.path) : { exists: null, size_bytes: null, mtime_iso: null, sha256: null };
  const nextEvent: TimelineEvent = {
    run_id: RUN_ID,
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
  fs.appendFileSync(timelinePath, `${JSON.stringify(nextEvent)}\n`);
}

function fail(reason: string, details?: Record<string, unknown>): never {
  appendTimeline("decision_package", "fail_path_before_clear_outputs", { details: { reason, ...(details ?? {}) } });
  clearOutputs();
  appendTimeline("decision_package", "fail_path_cleanup_complete", {
    details: {
      cleared: OUTPUT_FILES.map((filePath) => ({ file: filePath, exists: fs.existsSync(path.resolve(ROOT, filePath)) })),
    },
  });
  appendTimeline("decision_package", "package_end", { details: { ok: false, reason } });
  console.log(JSON.stringify({ ok: false, error: reason, ...(details ?? {}) }, null, 2));
  process.exit(1);
}

function atomicWrite(filePath: string, contents: string): void {
  const abs = path.resolve(ROOT, filePath);
  const temp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, contents);
  fs.renameSync(temp, abs);
}

function readJson(filePath: string): JsonRecord {
  const abs = path.resolve(ROOT, filePath);
  const raw = fs.readFileSync(abs, "utf8");
  return JSON.parse(raw) as JsonRecord;
}

function tryReadJson(filePath: string): JsonRecord | null {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function git(cmd: string): string | null {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function fileMeta(filePath: string) {
  const abs = path.resolve(ROOT, filePath);
  if (!fs.existsSync(abs)) {
    return { path: filePath, exists: false, sha256: null, size_bytes: null, mtime_iso: null };
  }
  const buf = fs.readFileSync(abs);
  const st = fs.statSync(abs);
  return {
    path: filePath,
    exists: true,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    size_bytes: st.size,
    mtime_iso: st.mtime.toISOString(),
  };
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseAheadBehind(raw: unknown): { ahead: number; behind: number } | null {
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
    const record = raw as JsonRecord;
    const ahead = Number(record.ahead ?? record["ahead_count"] ?? Number.NaN);
    const behind = Number(record.behind ?? record["behind_count"] ?? Number.NaN);
    return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null;
  }
  return null;
}

function equalAheadBehind(a: { ahead: number; behind: number } | null, b: { ahead: number; behind: number } | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a.ahead === b.ahead && a.behind === b.behind;
}

function walkFiles(root: string, maxDepth = 6): string[] {
  const absRoot = path.resolve(ROOT, root);
  if (!fs.existsSync(absRoot)) return [];
  const out: string[] = [];
  function visit(current: string, depth: number) {
    if (depth > maxDepth) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(next, depth + 1);
      } else if (entry.isFile()) {
        out.push(path.relative(ROOT, next).replace(/\\/g, "/"));
      }
    }
  }
  visit(absRoot, 0);
  return out;
}

function newestMatching(
  roots: string[],
  fileMatcher: string | ((relPath: string) => boolean),
  validator: (doc: JsonRecord, relPath: string) => boolean,
): string | null {
  const candidates: Array<{ relPath: string; mtime: number }> = [];
  const matches = typeof fileMatcher === "string" ? (relPath: string) => relPath.endsWith(`/${fileMatcher}`) || relPath === fileMatcher : fileMatcher;
  for (const root of roots) {
    for (const relPath of walkFiles(root)) {
      if (!matches(relPath)) continue;
      const doc = tryReadJson(relPath);
      if (!doc || !validator(doc, relPath)) continue;
      const mtime = fs.statSync(path.resolve(ROOT, relPath)).mtimeMs;
      candidates.push({ relPath, mtime });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.relPath ?? null;
}

function resolveSource(
  name: string,
  cliOrEnv: string,
  shapeValidator: (doc: JsonRecord, relPath: string) => boolean,
  roleValidator: (doc: JsonRecord, relPath: string) => boolean,
  discover: () => string | null,
): string {
  if (cliOrEnv) {
    if (!fs.existsSync(path.resolve(ROOT, cliOrEnv))) {
      fail(`required_source_missing:${name}`, { path: cliOrEnv });
    }
    const doc = tryReadJson(cliOrEnv);
    if (!doc || !shapeValidator(doc, cliOrEnv)) {
      fail(`required_source_invalid_shape:${name}:${cliOrEnv}`);
    }
    if (!roleValidator(doc, cliOrEnv)) fail(`required_source_invalid_role:${name}:${cliOrEnv}`);
    return cliOrEnv;
  }
  const found = discover();
  if (!found) {
    fail(`required_source_unresolved:${name}`);
  }
  return found;
}

const evaluationTier = (opt("evaluation-tier", "decision_grade") === "exploratory" ? "exploratory" : "decision_grade") as
  | "exploratory"
  | "decision_grade";

function hasMetricsObject(doc: JsonRecord): boolean {
  const candidate = (doc.metrics ?? doc.quality_rollup) as unknown;
  return !!candidate && typeof candidate === "object";
}

function isHeavySummary(doc: JsonRecord): boolean {
  return typeof doc.run_id === "string" && hasMetricsObject(doc);
}

function isHeavyRole(doc: JsonRecord, relPath: string): boolean {
  if (!isHeavySummary(doc)) return false;
  const pathLower = relPath.toLowerCase();
  if (/(^|[\/_.-])(narrow|precheck|smoke)([\/_.-]|$)/.test(pathLower)) return false;
  if (doc.run_complete !== true) return false;
  const totalRuns = asNumber(doc.total_runs) ?? asNumber(doc.runs_total) ?? asNumber((doc.summary as JsonRecord | undefined)?.total_runs);
  return (totalRuns ?? -1) >= 270;
}

function isRecommendation(doc: JsonRecord): boolean {
  return typeof doc.decision_grade_ready === "boolean";
}

function isAbSummary(doc: JsonRecord): boolean {
  const byFamily = (doc.novel_response_rate_by_family ?? {}) as JsonRecord;
  return (
    doc.summary_schema_version === 2 &&
    typeof doc.novel_response_rate === "number" &&
    typeof byFamily.relation === "number" &&
    typeof byFamily.repo_technical === "number" &&
    typeof byFamily.ambiguous_general === "number"
  );
}

function isNarrowSummary(doc: JsonRecord): boolean {
  return !!doc.strict_gates && typeof doc.strict_gates === "object";
}

function isNarrowRole(doc: JsonRecord): boolean {
  if (!isNarrowSummary(doc)) return false;
  const strict = doc.strict_gates as JsonRecord;
  return [strict.runtime_fallback_answer, strict.runtime_tdz_intentStrategy, strict.runtime_tdz_intentProfile].every((v) => typeof v === "number");
}

function isCasimirSummary(doc: JsonRecord): boolean {
  return typeof doc.verdict === "string" && typeof doc.integrityOk === "boolean";
}

function tempSourceValidator(expectedTemp: "t02" | "t035") {
  return (doc: JsonRecord, relPath: string) => {
    if (!isAbSummary(doc)) return false;
    const normalizedPath = relPath.toLowerCase();
    const variant = String(doc.variant ?? "").toLowerCase();
    const otherTemp = expectedTemp === "t02" ? "t035" : "t02";
    const pathHasExpected = normalizedPath.includes(`/${expectedTemp}/`);
    const pathHasOther = normalizedPath.includes(`/${otherTemp}/`);
    const pathMatch = pathHasExpected ? !pathHasOther : true;
    const variantMatch = variant.length > 0 && variant.includes(expectedTemp) && !variant.includes(otherTemp);
    return pathMatch && variantMatch;
  };
}

const modernExperimentRoots = [
  "artifacts/experiments/helix-ask-versatility-research",
  "artifacts/experiments/helix-step4-heavy-rerun",
  "artifacts/experiments",
  "artifacts",
  "reports",
];

const narrowDiscoveryMatcher = (relPath: string) => {
  const base = path.basename(relPath).toLowerCase();
  return base === "helix-self-tune-gate-summary.json" || (base === "summary.json" && relPath.toLowerCase().includes("narrow"));
};

const casimirDiscoveryMatcher = (relPath: string) => {
  const base = path.basename(relPath).toLowerCase();
  return base === "helix-self-tune-casimir.json" || base.includes("casimir");
};

try {
appendTimeline("decision_package", "package_start");

const narrowPath = resolveSource(
  "narrow",
  opt("narrow"),
  isNarrowSummary,
  isNarrowRole,
  () => newestMatching(modernExperimentRoots, narrowDiscoveryMatcher, isNarrowSummary),
);

const heavyPath = resolveSource(
  "heavy",
  opt("heavy"),
  isHeavySummary,
  isHeavyRole,
  () => newestMatching(modernExperimentRoots, "summary.json", isHeavyRole),
);

const heavyRecommendationPath = resolveSource("heavy-recommendation", opt("heavy-recommendation"), isRecommendation, isRecommendation, () => {
  const sibling = path.join(path.dirname(heavyPath), "recommendation.json").replace(/\\/g, "/");
  if (fs.existsSync(path.resolve(ROOT, sibling))) {
    const doc = tryReadJson(sibling);
    if (doc && isRecommendation(doc)) return sibling;
  }
  return newestMatching(modernExperimentRoots, "recommendation.json", isRecommendation);
});

if (path.dirname(heavyRecommendationPath) !== path.dirname(heavyPath)) {
  fail("required_source_pair_mismatch:heavy_recommendation", {
    heavy: heavyPath,
    heavy_recommendation: heavyRecommendationPath,
  });
}

const abT02Path = resolveSource(
  "ab-t02",
  opt("ab-t02"),
  tempSourceValidator("t02"),
  tempSourceValidator("t02"),
  () => newestMatching(["artifacts/experiments/helix-step4-ab-rerun", "artifacts/experiments", "artifacts"], "summary.json", tempSourceValidator("t02")),
);

const abT035Path = resolveSource(
  "ab-t035",
  opt("ab-t035"),
  tempSourceValidator("t035"),
  tempSourceValidator("t035"),
  () => newestMatching(["artifacts/experiments/helix-step4-ab-rerun", "artifacts/experiments", "artifacts"], "summary.json", tempSourceValidator("t035")),
);

const casimirPath = resolveSource(
  "casimir",
  opt("casimir"),
  isCasimirSummary,
  isCasimirSummary,
  () => newestMatching(modernExperimentRoots, casimirDiscoveryMatcher, isCasimirSummary),
);

const selectedSources = {
  narrow: narrowPath,
  heavy: heavyPath,
  recommendation: heavyRecommendationPath,
  ab_t02: abT02Path,
  ab_t035: abT035Path,
  casimir: casimirPath,
} as const;

const sourceSnapshots = Object.fromEntries(
  Object.entries(selectedSources).map(([name, filePath]) => {
    appendTimeline("decision_package", "source_selected_before_read", { path: filePath, details: { source_name: name } });
    return [name, fileMeta(filePath)];
  }),
) as Record<string, ReturnType<typeof fileMeta>>;

const narrow = readJson(narrowPath);
const heavy = readJson(heavyPath);
const heavyRec = readJson(heavyRecommendationPath);
const abT02 = readJson(abT02Path);
const abT035 = readJson(abT035Path);
const casimir = readJson(casimirPath);
for (const [name, filePath] of Object.entries(selectedSources)) {
  appendTimeline("decision_package", "source_read_parse_complete", { path: filePath, details: { source_name: name } });
}

const strictGates = (narrow.strict_gates ?? {}) as JsonRecord;
const heavyQuality = ((heavy.quality_rollup ?? heavy.metrics) ?? {}) as JsonRecord;
const heavyProvenance = (heavy.provenance ?? {}) as JsonRecord;

const gateDefs: Array<[string, number | boolean, string, unknown, string]> = [
  ["relation_packet_built_rate", 0.95, ">=", heavyQuality.relation_packet_built_rate ?? strictGates.relation_packet_built_rate, heavyPath],
  [
    "relation_dual_domain_ok_rate",
    0.95,
    ">=",
    heavyQuality.relation_dual_domain_ok_rate ?? strictGates.relation_dual_domain_ok_rate,
    heavyPath,
  ],
  ["report_mode_correct_rate", 0.98, ">=", heavyQuality.report_mode_correct_rate ?? strictGates.report_mode_correct_rate, heavyPath],
  ["citation_presence_rate", 0.99, ">=", heavyQuality.citation_presence_rate ?? strictGates.citation_presence_rate, heavyPath],
  ["stub_text_detected_rate", 0, "==", heavyQuality.stub_text_detected_rate ?? strictGates.stub_text_detected_rate, heavyPath],
  ["runtime_fallback_answer", 0, "==", strictGates.runtime_fallback_answer, narrowPath],
  ["runtime_tdz_intentStrategy", 0, "==", strictGates.runtime_tdz_intentStrategy, narrowPath],
  ["runtime_tdz_intentProfile", 0, "==", strictGates.runtime_tdz_intentProfile, narrowPath],
  ["provenance_gate_pass", true, "==", heavyProvenance.gate_pass, heavyPath],
  ["decision_grade_ready", true, "==", heavyRec.decision_grade_ready, heavyRecommendationPath],
  ["casimir_verdict_pass_integrity", true, "==", casimir.verdict === "PASS" && casimir.integrityOk === true, casimirPath],
];

const gates: Gate[] = gateDefs.map(([name, threshold, comparator, raw, source_path]) => {
  const value = typeof threshold === "number" ? asNumber(raw) : typeof raw === "boolean" ? raw : raw == null ? null : String(raw);
  let pass = false;
  if (typeof threshold === "number" && typeof value === "number") {
    pass = comparator === ">=" ? value >= threshold : value === threshold;
  } else if (typeof threshold === "boolean" && typeof value === "boolean") {
    pass = value === threshold;
  }
  return { name, value, threshold, comparator, pass, source_path };
});

function noveltyFrom(summary: JsonRecord, sourcePath: string) {
  const byFamily = (summary.novel_response_rate_by_family ?? {}) as JsonRecord;
  const overall = asNumber(summary.novel_response_rate) ?? -1;
  const relation = asNumber(byFamily.relation) ?? -1;
  const repoTechnical = asNumber(byFamily.repo_technical) ?? -1;
  const ambiguous = asNumber(byFamily.ambiguous_general) ?? -1;
  const target = 0.82;
  return {
    overall,
    by_family: {
      relation,
      repo_technical: repoTechnical,
      ambiguous_general: ambiguous,
    },
    target,
    pass: overall >= target && relation >= target && repoTechnical >= target && ambiguous >= target,
    source_path: sourcePath,
  };
}

const novelty = {
  t02: noveltyFrom(abT02, abT02Path),
  t035: noveltyFrom(abT035, abT035Path),
};

const branch = git("git rev-parse --abbrev-ref HEAD") ?? "unknown";
const head = git("git rev-parse --short HEAD") ?? "unknown";
const originMain = git("git rev-parse --short origin/main");
const aheadBehindRaw = git("git rev-list --left-right --count origin/main...HEAD");
const aheadBehind = aheadBehindRaw
  ? (() => {
      const [behind, ahead] = aheadBehindRaw.split(/\s+/).map((v) => Number(v));
      return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null;
    })()
  : null;

const heavyOriginMain = String((heavyProvenance.originMain ?? heavyProvenance.origin_main ?? "") || "") || null;
const heavyAheadBehind = parseAheadBehind(heavyProvenance.aheadBehind ?? heavyProvenance.ahead_behind ?? null);
const provenanceMismatch: string[] = [];
if (String((heavyProvenance.branch ?? "") || "") !== branch) provenanceMismatch.push("branch");
if (String((heavyProvenance.head ?? "") || "") !== head) provenanceMismatch.push("head");
if (heavyOriginMain !== (originMain ?? null)) provenanceMismatch.push("origin_main");
if (!equalAheadBehind(heavyAheadBehind, aheadBehind)) provenanceMismatch.push("ahead_behind");
if (evaluationTier === "decision_grade" && provenanceMismatch.length > 0) {
  fail(`required_source_provenance_mismatch:${provenanceMismatch.join(",")}`, {
    heavy: heavyPath,
  });
}

const allArtifacts = [
  narrowPath,
  heavyPath,
  heavyRecommendationPath,
  abT02Path,
  abT035Path,
  casimirPath,
  "schemas/helix-decision-package.schema.json",
];

const artifacts = allArtifacts.map(fileMeta);
for (const artifact of artifacts) {
  appendTimeline("decision_package", "artifact_metadata_captured", { path: artifact.path });
}
const hardBlockers = [
  ...gates.filter((g) => !g.pass).map((g) => `${g.name} failed (${String(g.value)} ${g.comparator} ${String(g.threshold)})`),
  ...(novelty.t02.pass ? [] : ["novelty.t02 below target >=0.82"]),
  ...(novelty.t035.pass ? [] : ["novelty.t035 below target >=0.82"]),
  ...artifacts.filter((a) => !a.exists).map((a) => `missing artifact: ${a.path}`),
];

const provenancePass = (heavyProvenance.gate_pass as boolean) === true;
const pkg = {
  schema_version: "1.0.0",
  generated_at: new Date().toISOString(),
  evaluation_tier: evaluationTier,
  git: {
    branch,
    head,
    origin_main: originMain,
    ahead_behind: aheadBehind,
  },
  runs: {
    narrow: String((narrow.precheck_run_id ?? narrow.run_id ?? "") || "") || null,
    heavy: String((heavy.run_id ?? "") || "") || null,
    ab_t02: String((abT02.run_id ?? "") || "") || null,
    ab_t035: String((abT035.run_id ?? "") || "") || null,
    casimir: String((casimir.runId ?? casimir.run_id ?? "") || "") || null,
  },
  gates,
  novelty,
  provenance: {
    pass: provenancePass,
    blocked_reason: provenancePass ? null : "provenance gate failed in heavy summary",
    warnings: Array.isArray(heavyProvenance.warnings) ? (heavyProvenance.warnings as string[]) : [],
  },
  casimir: {
    verdict: String(casimir.verdict ?? "UNKNOWN"),
    traceId: (casimir.traceId as string | undefined) ?? null,
    runId: String(casimir.runId ?? casimir.run_id ?? "") || null,
    certificateHash: String(casimir.certificateHash ?? casimir.certificate_hash ?? "") || null,
    integrityOk: casimir.integrityOk === true,
    source_path: casimirPath,
  },
  artifacts,
  decision: {
    value: hardBlockers.length === 0 ? "GO" : "NO-GO",
    hard_blockers: hardBlockers,
    reasoning: ["All metrics are sourced from machine JSON artifacts.", "Markdown report is rendered from this package JSON."],
  },
  report_paths: {
    json: REPORT_JSON,
    markdown: REPORT_MD,
  },
};

const md = [
  "# Helix Decision Package",
  "",
  `- generated_at: ${pkg.generated_at}`,
  `- evaluation_tier: ${pkg.evaluation_tier}`,
  `- decision: ${pkg.decision.value}`,
  "",
  "## Gates",
  "",
  "| gate | value | threshold | pass | source |",
  "| --- | ---: | ---: | :---: | --- |",
  ...pkg.gates.map((g) => `| ${g.name} | ${String(g.value)} | ${g.comparator} ${String(g.threshold)} | ${g.pass ? "✅" : "❌"} | ${g.source_path} |`),
  "",
  "## Novelty",
  "",
  `- t02 overall=${pkg.novelty.t02.overall} relation=${pkg.novelty.t02.by_family.relation} repo=${pkg.novelty.t02.by_family.repo_technical} ambiguous=${pkg.novelty.t02.by_family.ambiguous_general} target=${pkg.novelty.t02.target} pass=${pkg.novelty.t02.pass}`,
  `- t035 overall=${pkg.novelty.t035.overall} relation=${pkg.novelty.t035.by_family.relation} repo=${pkg.novelty.t035.by_family.repo_technical} ambiguous=${pkg.novelty.t035.by_family.ambiguous_general} target=${pkg.novelty.t035.target} pass=${pkg.novelty.t035.pass}`,
  "",
  "## Hard blockers",
  "",
  ...(pkg.decision.hard_blockers.length === 0 ? ["- none"] : pkg.decision.hard_blockers.map((b) => `- ${b}`)),
].join("\n");

fs.mkdirSync(path.resolve(ROOT, "reports"), { recursive: true });

const testDeleteSource = process.env.HELIX_DECISION_TEST_DELETE_SOURCE_BEFORE_WRITE;
if (testDeleteSource && selectedSources[testDeleteSource as keyof typeof selectedSources]) {
  const toDelete = selectedSources[testDeleteSource as keyof typeof selectedSources];
  try {
    fs.rmSync(path.resolve(ROOT, toDelete), { force: true });
  } catch {
    // test-only best effort
  }
  appendTimeline("decision_package", "source_deleted_for_test", {
    path: toDelete,
    details: { source_name: testDeleteSource },
  });
}

for (const [name, filePath] of Object.entries(selectedSources)) {
  const atWrite = fileMeta(filePath);
  const atSelect = sourceSnapshots[name];
  const mismatch =
    atWrite.exists !== atSelect.exists ||
    atWrite.size_bytes !== atSelect.size_bytes ||
    atWrite.mtime_iso !== atSelect.mtime_iso ||
    atWrite.sha256 !== atSelect.sha256;
  if (mismatch) {
    fail(`source_snapshot_mismatch:${name}`, { selected: atSelect, current: atWrite });
  }
}
appendTimeline("decision_package", "before_write", { details: { outputs: OUTPUT_FILES } });
const resolvedInputs = {
  generated_at: new Date().toISOString(),
  git: {
    branch,
    head,
    origin_main: originMain,
    ahead_behind: aheadBehind,
  },
  selected_paths: {
    narrow: narrowPath,
    heavy: heavyPath,
    recommendation: heavyRecommendationPath,
    ab_t02: abT02Path,
    ab_t035: abT035Path,
    casimir: casimirPath,
  },
  run_ids: {
    narrow: String((narrow.precheck_run_id ?? narrow.run_id ?? "") || "") || null,
    heavy: String((heavy.run_id ?? "") || "") || null,
    recommendation: String((heavyRec.run_id ?? heavyRec.recommendation_run_id ?? "") || "") || null,
    ab_t02: String((abT02.run_id ?? "") || "") || null,
    ab_t035: String((abT035.run_id ?? "") || "") || null,
    casimir: String((casimir.runId ?? casimir.run_id ?? "") || "") || null,
  },
  inputs: {
    narrow: fileMeta(narrowPath),
    heavy: fileMeta(heavyPath),
    recommendation: fileMeta(heavyRecommendationPath),
    ab_t02: fileMeta(abT02Path),
    ab_t035: fileMeta(abT035Path),
    casimir: fileMeta(casimirPath),
  },
};
atomicWrite(INPUTS_MANIFEST_JSON, `${JSON.stringify(resolvedInputs, null, 2)}\n`);
atomicWrite(REPORT_JSON, `${JSON.stringify(pkg, null, 2)}\n`);
atomicWrite(REPORT_MD, `${md}\n`);
appendTimeline("decision_package", "after_write", {
  details: {
    outputs: OUTPUT_FILES.map((filePath) => fileMeta(filePath)),
  },
});
appendTimeline("decision_package", "package_end", { details: { ok: true } });
console.log(JSON.stringify({ ok: true, output: REPORT_JSON, decision: pkg.decision.value, blockers: pkg.decision.hard_blockers }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail("package_generation_failed", { message });
}
