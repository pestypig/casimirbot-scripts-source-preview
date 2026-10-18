import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";

type SourceKey = "narrow" | "heavy" | "recommendation" | "ab_t02" | "ab_t035" | "casimir";
type SourceMap = Record<SourceKey, string | null>;
type ModeUsed = "legacy" | "bundle";

type RunSummary = {
  ok: boolean;
  decision: "GO" | "NO-GO" | "UNKNOWN";
  blockers: string[];
  package_path: string;
  validate_path: string;
  selected_sources: SourceMap;
  commands: Array<{ name: string; cmd: string; status: number }>;
  mode_used: ModeUsed;
  first_blocker: string | null;
  verifier_ok: boolean;
};

const SUMMARY_PATH = "reports/helix-decision-run-summary.json";
const TIMELINE_POINTER_PATH = "reports/helix-decision-timeline.latest.json";

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

function makeRunId(): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const short = crypto.randomUUID().split("-")[0];
  return `${ts}-${short}`;
}
const timelinePathForRun = (runId: string): string => `reports/helix-decision-timeline-${runId}.jsonl`;
const rootDir = (): string => process.env.HELIX_DECISION_ROOT ?? process.cwd();

function writeTimelinePointer(runId: string, timelinePath: string): void {
  fs.mkdirSync(path.resolve(rootDir(), "reports"), { recursive: true });
  fs.writeFileSync(path.resolve(rootDir(), TIMELINE_POINTER_PATH), `${JSON.stringify({ run_id: runId, timeline_path: timelinePath }, null, 2)}\n`);
}

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    args.set(key, value);
  }
  return args;
}

function fileMeta(relPath: string): { exists: boolean; size_bytes: number | null; mtime_iso: string | null; sha256: string | null } {
  const abs = path.resolve(rootDir(), relPath);
  if (!fs.existsSync(abs)) return { exists: false, size_bytes: null, mtime_iso: null, sha256: null };
  const st = fs.statSync(abs);
  const buf = fs.readFileSync(abs);
  return { exists: true, size_bytes: st.size, mtime_iso: st.mtime.toISOString(), sha256: crypto.createHash("sha256").update(buf).digest("hex") };
}

function appendTimeline(runId: string, timelinePath: string, phase: string, event: string, options: { path?: string | null; details?: Record<string, unknown> } = {}): void {
  const timelineAbs = path.resolve(rootDir(), timelinePath);
  const meta = options.path ? fileMeta(options.path) : { exists: null, size_bytes: null, mtime_iso: null, sha256: null };
  const row: TimelineEvent = {
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
  fs.mkdirSync(path.resolve(rootDir(), "reports"), { recursive: true });
  fs.appendFileSync(timelineAbs, `${JSON.stringify(row)}\n`);
}

function runCommand(name: string, cmd: string, options: { allowFail?: boolean; env?: Record<string, string> } = {}): { status: number; stdout: string; stderr: string } {
  const child = spawnSync(cmd, {
    cwd: rootDir(), shell: true, encoding: "utf8", stdio: ["inherit", "pipe", "pipe"], env: { ...process.env, ...(options.env ?? {}) },
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  const status = child.status ?? 1;
  if (status !== 0 && !options.allowFail) throw new Error(`command_failed:${name}:${status}`);
  return { status, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}

function tryReadJson(filePath: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(path.resolve(rootDir(), filePath), "utf8")); } catch { return null; }
}

function walkFiles(rootRel: string, maxDepth = 7): string[] {
  const absRoot = path.resolve(rootDir(), rootRel);
  if (!fs.existsSync(absRoot)) return [];
  const out: string[] = [];
  function visit(current: string, depth: number): void {
    if (depth > maxDepth) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) visit(next, depth + 1);
      else if (entry.isFile()) out.push(path.relative(rootDir(), next).replace(/\\/g, "/"));
    }
  }
  visit(absRoot, 0);
  return out;
}

function newestMatching(roots: string[], matcher: (relPath: string) => boolean, validator: (doc: Record<string, unknown>, relPath: string) => boolean): string | null {
  const candidates: Array<{ relPath: string; mtimeMs: number }> = [];
  for (const root of roots) {
    for (const relPath of walkFiles(root)) {
      if (!matcher(relPath)) continue;
      const doc = tryReadJson(relPath);
      if (!doc || !validator(doc, relPath)) continue;
      candidates.push({ relPath, mtimeMs: fs.statSync(path.resolve(rootDir(), relPath)).mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.relPath ?? null;
}

function isABTempSource(doc: Record<string, unknown>, relPath: string, expected: "t02" | "t035"): boolean {
  if (doc.summary_schema_version !== 2) return false;
  const variant = String(doc.variant ?? "").toLowerCase();
  const normalizedPath = relPath.toLowerCase();
  const other = expected === "t02" ? "t035" : "t02";
  return variant.includes(expected) && !variant.includes(other) && normalizedPath.includes(`/${expected}/`) && !normalizedPath.includes(`/${other}/`);
}

function validateResolvedSources(resolved: SourceMap): void {
  if (path.dirname(resolved.heavy!) !== path.dirname(resolved.recommendation!)) throw new Error(`source_pair_mismatch:heavy_recommendation:${resolved.heavy}:${resolved.recommendation}`);
  const abT02 = tryReadJson(resolved.ab_t02!);
  const abT035 = tryReadJson(resolved.ab_t035!);
  if (!abT02 || !isABTempSource(abT02, resolved.ab_t02!, "t02")) throw new Error(`source_invalid_role:ab_t02:${resolved.ab_t02}`);
  if (!abT035 || !isABTempSource(abT035, resolved.ab_t035!, "t035")) throw new Error(`source_invalid_role:ab_t035:${resolved.ab_t035}`);
}

function resolveSources(overrides: Partial<SourceMap>, allowDiscovery: boolean): SourceMap {
  const fromOverride = (key: SourceKey): string | null => {
    const value = overrides[key] ?? null;
    if (!value) return null;
    if (!fs.existsSync(path.resolve(rootDir(), value))) throw new Error(`source_missing:${key}:${value}`);
    return value;
  };

  const requireExplicit = (key: SourceKey): string => {
    const value = fromOverride(key);
    if (!value) throw new Error(`bundle_mode_requires_explicit_source:${key}`);
    return value;
  };

  const resolved: SourceMap = allowDiscovery
    ? {
        narrow: fromOverride("narrow") ?? newestMatching(["reports", "artifacts/experiments", "artifacts"], (relPath) => relPath.endsWith("/helix-self-tune-gate-summary.json") || relPath === "reports/helix-self-tune-gate-summary.json" || relPath.toLowerCase().includes("narrow") && relPath.endsWith("/summary.json"), (doc) => typeof doc.strict_gates === "object"),
        heavy: fromOverride("heavy") ?? newestMatching(["artifacts/experiments/helix-step4-heavy-rerun", "artifacts/experiments", "artifacts"], (relPath) => relPath.endsWith("/summary.json"), (doc, relPath) => {
          const lower = relPath.toLowerCase();
          if (lower.includes("narrow") || lower.includes("precheck") || lower.includes("ab-rerun")) return false;
          const metrics = doc.metrics as Record<string, unknown> | undefined;
          return typeof metrics?.relation_packet_built_rate === "number" && typeof doc.provenance === "object";
        }),
        recommendation: fromOverride("recommendation") ?? null,
        ab_t02: fromOverride("ab_t02") ?? newestMatching(["artifacts/experiments/helix-step4-ab-rerun", "artifacts/experiments", "artifacts"], (relPath) => relPath.endsWith("/summary.json"), (doc, relPath) => isABTempSource(doc, relPath, "t02")),
        ab_t035: fromOverride("ab_t035") ?? newestMatching(["artifacts/experiments/helix-step4-ab-rerun", "artifacts/experiments", "artifacts"], (relPath) => relPath.endsWith("/summary.json"), (doc, relPath) => isABTempSource(doc, relPath, "t035")),
        casimir: fromOverride("casimir") ?? newestMatching(["reports", "artifacts/experiments", "artifacts"], (relPath) => relPath.endsWith("casimir.json"), (doc) => typeof doc.verdict === "string"),
      }
    : {
        narrow: requireExplicit("narrow"),
        heavy: requireExplicit("heavy"),
        recommendation: requireExplicit("recommendation"),
        ab_t02: requireExplicit("ab_t02"),
        ab_t035: requireExplicit("ab_t035"),
        casimir: requireExplicit("casimir"),
      };

  if (allowDiscovery && !resolved.recommendation && resolved.heavy) {
    const sibling = path.posix.join(path.posix.dirname(resolved.heavy), "recommendation.json");
    const siblingDoc = tryReadJson(sibling);
    if (siblingDoc && typeof siblingDoc.decision_grade_ready === "boolean") resolved.recommendation = sibling;
  }

  for (const [key, value] of Object.entries(resolved) as Array<[SourceKey, string | null]>) {
    if (!value) throw new Error(`source_unresolved:${key}`);
  }
  validateResolvedSources(resolved);
  return resolved;
}

export function buildSummaryShape(input: Partial<RunSummary>): RunSummary {
  return {
    ok: input.ok === true,
    decision: input.decision ?? "UNKNOWN",
    blockers: input.blockers ?? [],
    package_path: input.package_path ?? "reports/helix-decision-package.json",
    validate_path: input.validate_path ?? "reports/helix-decision-validate.json",
    selected_sources: input.selected_sources ?? { narrow: null, heavy: null, recommendation: null, ab_t02: null, ab_t035: null, casimir: null },
    commands: input.commands ?? [],
    mode_used: input.mode_used ?? "legacy",
    first_blocker: input.first_blocker ?? null,
    verifier_ok: input.verifier_ok ?? false,
  };
}

export function resolveSourcesForTest(overrides: Partial<SourceMap>, allowDiscovery = true): SourceMap {
  return resolveSources(overrides, allowDiscovery);
}

function main(): void {
  const args = parseArgs(process.argv);
  const freshEnabled = (args.get("fresh") ?? "true") !== "false";
  const bundleMode = (args.get("bundle-mode") ?? "false") === "true";
  const bundlePath = args.get("bundle") ?? null;
  const overrides: Partial<SourceMap> = {
    narrow: args.get("narrow") ?? null,
    heavy: args.get("heavy") ?? null,
    recommendation: args.get("recommendation") ?? null,
    ab_t02: args.get("ab_t02") ?? args.get("ab-t02") ?? null,
    ab_t035: args.get("ab_t035") ?? args.get("ab-t035") ?? null,
    casimir: args.get("casimir") ?? null,
  };

  const commands: Array<{ name: string; cmd: string; status: number }> = [];
  const runId = process.env.HELIX_DECISION_RUN_ID ?? makeRunId();
  const timelinePath = process.env.HELIX_DECISION_TIMELINE_PATH ?? timelinePathForRun(runId);
  writeTimelinePointer(runId, timelinePath);
  appendTimeline(runId, timelinePath, "decision_run", "run_start", { details: { fresh_enabled: freshEnabled, bundle_mode: bundleMode } });

  const timelineEnv = { HELIX_DECISION_RUN_ID: runId, HELIX_DECISION_TIMELINE_PATH: timelinePath };

  if (!bundleMode && freshEnabled) {
    const needsNarrow = !overrides.narrow;
    const needsHeavy = !overrides.heavy || !overrides.recommendation;
    const needsAB = !overrides.ab_t02 || !overrides.ab_t035;
    const needsCasimir = !overrides.casimir;
    if (needsNarrow) commands.push({ name: "fresh:narrow", cmd: "npm run helix:decision:eval:narrow --if-present", status: runCommand("fresh:narrow", "npm run helix:decision:eval:narrow --if-present", { allowFail: true }).status });
    if (needsHeavy) commands.push({ name: "fresh:heavy", cmd: "npm run helix:decision:eval:heavy --if-present", status: runCommand("fresh:heavy", "npm run helix:decision:eval:heavy --if-present", { allowFail: true }).status });
    if (needsAB) {
      commands.push({ name: "fresh:ab_t02", cmd: "npm run helix:decision:eval:ab:t02 --if-present", status: runCommand("fresh:ab_t02", "npm run helix:decision:eval:ab:t02 --if-present", { allowFail: true }).status });
      commands.push({ name: "fresh:ab_t035", cmd: "npm run helix:decision:eval:ab:t035 --if-present", status: runCommand("fresh:ab_t035", "npm run helix:decision:eval:ab:t035 --if-present", { allowFail: true }).status });
    }
    if (needsCasimir) commands.push({ name: "fresh:casimir", cmd: "npm run helix:decision:eval:casimir --if-present", status: runCommand("fresh:casimir", "npm run helix:decision:eval:casimir --if-present", { allowFail: true }).status });
  }

  let summary: RunSummary;
  if (bundleMode) {
    if (bundlePath && Object.values(overrides).some(Boolean)) throw new Error("bundle_mode_conflict:provide_bundle_or_explicit_sources");
    let selected: SourceMap = { narrow: null, heavy: null, recommendation: null, ab_t02: null, ab_t035: null, casimir: null };
    let targetBundle = bundlePath ?? "reports/helix-decision-bundle.json";
    if (!bundlePath) {
      selected = resolveSources(overrides, false);
      const bundleCmd = ["npm run helix:decision:bundle --", `--narrow ${selected.narrow}`, `--heavy ${selected.heavy}`, `--heavy-recommendation ${selected.recommendation}`, `--ab-t02 ${selected.ab_t02}`, `--ab-t035 ${selected.ab_t035}`, `--casimir ${selected.casimir}`].join(" ");
      const b = runCommand("decision:bundle", bundleCmd, { allowFail: true, env: timelineEnv });
      commands.push({ name: "decision:bundle", cmd: bundleCmd, status: b.status });
      if (b.status !== 0) throw new Error(`command_failed:decision:bundle:${b.status}`);
    }
    const verifyCmd = `npm run helix:decision:bundle:verify -- --bundle ${targetBundle}`;
    const v = runCommand("decision:bundle:verify", verifyCmd, { allowFail: true, env: timelineEnv });
    commands.push({ name: "decision:bundle:verify", cmd: verifyCmd, status: v.status });
    const bundleDoc = tryReadJson(targetBundle) ?? {};
    const verifyDoc = tryReadJson("reports/helix-decision-bundle-verify.json") ?? {};
    const blockers = v.status === 0 ? [] : [String((verifyDoc as any).first_blocker ?? "bundle_verifier_failed")];
    summary = buildSummaryShape({
      ok: v.status === 0,
      decision: String((bundleDoc as any)?.decision?.value ?? "UNKNOWN") as any,
      blockers,
      package_path: targetBundle,
      validate_path: "reports/helix-decision-bundle-verify.json",
      selected_sources: selected,
      commands,
      mode_used: "bundle",
      first_blocker: blockers[0] ?? null,
      verifier_ok: v.status === 0,
    });
  } else {
    appendTimeline(runId, timelinePath, "resolve_sources", "resolve_sources_start", { details: { overrides, legacy: true } });
    const sources = resolveSources(overrides, true);
    appendTimeline(runId, timelinePath, "resolve_sources", "resolve_sources_end", { details: { selected_sources: sources } });
    for (const [name, src] of Object.entries(sources)) {
      appendTimeline(runId, timelinePath, "resolve_sources", "source_selected", { path: src, details: { source_name: name } });
    }
    const packageCmd = ["npm run helix:decision:package --", `--narrow ${sources.narrow}`, `--heavy ${sources.heavy}`, `--heavy-recommendation ${sources.recommendation}`, `--ab-t02 ${sources.ab_t02}`, `--ab-t035 ${sources.ab_t035}`, `--casimir ${sources.casimir}`].join(" ");
    appendTimeline(runId, timelinePath, "decision_package", "decision_package_start", { details: { cmd: packageCmd } });
    const packageRes = runCommand("decision:package", packageCmd, { allowFail: true, env: timelineEnv });
    appendTimeline(runId, timelinePath, "decision_package", "decision_package_end", { details: { status: packageRes.status } });
    commands.push({ name: "decision:package", cmd: packageCmd, status: packageRes.status });

    if (packageRes.status !== 0) {
      summary = buildSummaryShape({ ok: false, blockers: ["decision_package_blocker:package_generation_failed", `command_failed:decision:package:${packageRes.status}`], selected_sources: sources, commands, mode_used: "legacy", first_blocker: "decision_package_blocker:package_generation_failed", verifier_ok: false });
    } else {
      const validateCmd = "npm run helix:decision:validate -- --package reports/helix-decision-package.json";
      appendTimeline(runId, timelinePath, "decision_validate", "decision_validate_start", { details: { cmd: validateCmd } });
      const validateRes = runCommand("decision:validate", validateCmd, { allowFail: true, env: timelineEnv });
      appendTimeline(runId, timelinePath, "decision_validate", "decision_validate_end", { details: { status: validateRes.status } });
      commands.push({ name: "decision:validate", cmd: validateCmd, status: validateRes.status });
      const pkg = tryReadJson("reports/helix-decision-package.json") ?? {};
      const blockers = Array.isArray((pkg as any)?.decision?.hard_blockers) ? (pkg as any).decision.hard_blockers : [];
      summary = buildSummaryShape({
        ok: validateRes.status === 0,
        decision: ["GO", "NO-GO"].includes(String((pkg as any)?.decision?.value ?? "UNKNOWN")) ? (pkg as any).decision.value : "UNKNOWN",
        blockers,
        selected_sources: sources,
        commands,
        mode_used: "legacy",
        first_blocker: validateRes.status === 0 ? null : blockers[0] ?? "legacy_validator_failed",
        verifier_ok: validateRes.status === 0,
      });
    }
  }

  fs.mkdirSync(path.resolve(rootDir(), "reports"), { recursive: true });
  fs.writeFileSync(path.resolve(rootDir(), SUMMARY_PATH), `${JSON.stringify(summary, null, 2)}\n`);
  appendTimeline(runId, timelinePath, "decision_run", "run_end", { details: { ok: summary.ok, mode_used: summary.mode_used } });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.ok) process.exit(1);
}

const isEntrypoint = (() => {
  const entryArg = process.argv[1];
  if (!entryArg) return false;
  try { return import.meta.url === pathToFileURL(path.resolve(entryArg)).href; } catch { return false; }
})();

if (isEntrypoint) {
  try { main(); }
  catch (error) {
    const args = parseArgs(process.argv);
    const mode_used: ModeUsed = (args.get("bundle-mode") ?? "false") === "true" ? "bundle" : "legacy";
    const summary = buildSummaryShape({ ok: false, blockers: [error instanceof Error ? error.message : String(error)], first_blocker: error instanceof Error ? error.message : String(error), mode_used });
    fs.mkdirSync(path.resolve(rootDir(), "reports"), { recursive: true });
    fs.writeFileSync(path.resolve(rootDir(), SUMMARY_PATH), `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exit(1);
  }
}
