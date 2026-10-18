import fs from "node:fs/promises";
import path from "node:path";
import { precheckHelixAskAvailability } from "./helix-ask-availability-precheck";

type BatteryCaseClass = "deterministic_compute" | "generic_reasoning" | "warp_certificate_required";

type BatteryCaseExpect = {
  expectMathSolverOk?: boolean;
  expectMathReasonEq?: string;
  expectMathReasonIn?: string[];
  expectForcedMath?: boolean;
  expectAnswerIncludes?: string[];
  expectAnswerExcludes?: string[];
  expectBypassMode?: "off" | "active";
};

type BatteryCase = {
  id: string;
  label: string;
  class: BatteryCaseClass;
  question: string;
  expect?: BatteryCaseExpect;
};

type BatteryFile = {
  version: string;
  description?: string;
  cases: BatteryCase[];
};

type AskDebug = {
  intent_id?: string;
  intent_domain?: string;
  open_world_bypass_mode?: "off" | "active";
  math_solver_ok?: boolean;
  math_solver_kind?: string;
  math_solver_final?: string;
  math_solver_reason?: string;
  math_solver_residual_pass?: boolean;
  math_solver_residual_max?: number | null;
  answer_path?: string[];
};

type AskResponse = {
  text?: string;
  debug?: AskDebug;
  error?: string;
  message?: string;
};

type CheckResult = {
  name: string;
  pass: boolean;
  detail: string;
};

type CaseResult = {
  id: string;
  label: string;
  class: BatteryCaseClass;
  question: string;
  status: number;
  latencyMs: number;
  requestOk: boolean;
  responseText: string;
  debug: AskDebug;
  observed: {
    mathSolverOk: boolean;
    mathSolverReason: string;
    mathSolverKind: string;
    forcedMath: boolean;
    forcedMathWarpGuard: boolean;
    bypassMode: string;
    answerPath: string[];
  };
  checks: CheckResult[];
  pass: boolean;
  failureCount: number;
  skipped?: boolean;
  error?: string;
};

type ClassSummary = {
  total: number;
  pass: number;
};

type RunSummary = {
  runId: string;
  runLabel: string;
  batteryVersion: string;
  batteryPath: string;
  baseUrl: string;
  askUrl: string;
  total: number;
  pass: number;
  fail: number;
  classSummary: Record<BatteryCaseClass, ClassSummary>;
  metrics: {
    forcedMathRateDeterministic: number;
    mathSolverOkRateDeterministic: number;
    silentBypassCountDeterministic: number;
    warpGuardCoverage: number;
  };
  reasonHistogram: Record<string, number>;
  topFailures: Array<{
    id: string;
    class: BatteryCaseClass;
    failureCount: number;
    failedChecks: string[];
  }>;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

const BASE_URL = process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:5173";
const ASK_URL = new URL("/api/agi/ask", BASE_URL).toString();
const BATTERY_PATH = process.env.HELIX_ASK_MATH_ROUTER_BATTERY ?? "scripts/helix-ask-math-router-battery.json";
const OUT_ROOT =
  process.env.HELIX_ASK_MATH_ROUTER_OUT ?? "artifacts/experiments/helix-ask-math-router-evidence";
const REPORT_DIR = process.env.HELIX_ASK_MATH_ROUTER_REPORT_DIR ?? "reports";
const REPORT_LATEST_PATH =
  process.env.HELIX_ASK_MATH_ROUTER_REPORT_LATEST ?? "reports/helix-ask-math-router-evidence-latest.md";
const REQUEST_TIMEOUT_MS = Number(process.env.HELIX_ASK_MATH_ROUTER_TIMEOUT_MS ?? 45000);
const STRICT = process.env.HELIX_ASK_MATH_ROUTER_STRICT === "1";
const DRY_RUN = process.env.HELIX_ASK_MATH_ROUTER_DRY_RUN === "1";
const RUN_LABEL = process.env.HELIX_ASK_MATH_ROUTER_RUN_LABEL ?? "baseline-local";

const toStr = (value: unknown): string => (typeof value === "string" ? value : "");
const toBool = (value: unknown): boolean => value === true;
const toAnswerPath = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const timestampId = (): string => new Date().toISOString().replace(/[:.]/g, "-");

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
};

async function readBattery(filePath: string): Promise<BatteryFile> {
  const fullPath = path.resolve(filePath);
  const raw = await fs.readFile(fullPath, "utf8");
  const parsed = JSON.parse(raw) as BatteryFile;
  if (!parsed || !Array.isArray(parsed.cases)) {
    throw new Error(`invalid_battery_format:${fullPath}`);
  }
  return parsed;
}

async function runAsk(question: string, sessionId: string): Promise<{ status: number; latencyMs: number; payload?: AskResponse; error?: string }> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(ASK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question,
        debug: true,
        verbosity: "extended",
        temperature: 0.2,
        sessionId,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        status: response.status,
        latencyMs,
        error: text ? `http_${response.status}:${text.slice(0, 240)}` : `http_${response.status}`,
      };
    }
    const payload = (await response.json()) as AskResponse;
    return { status: response.status, latencyMs, payload };
  } catch (error) {
    clearTimeout(timeout);
    const message =
      error instanceof Error ? error.message : typeof error === "string" ? error : "request_failed";
    return { status: 0, latencyMs: Date.now() - started, error: message };
  }
}

function evaluate(caseDef: BatteryCase, observed: CaseResult): CheckResult[] {
  const checks: CheckResult[] = [];
  const expect = caseDef.expect;
  if (!expect) return checks;

  if (typeof expect.expectMathSolverOk === "boolean") {
    checks.push({
      name: "math_solver_ok",
      pass: observed.observed.mathSolverOk === expect.expectMathSolverOk,
      detail: `expected=${expect.expectMathSolverOk} actual=${observed.observed.mathSolverOk}`,
    });
  }
  if (typeof expect.expectMathReasonEq === "string") {
    checks.push({
      name: "math_solver_reason_eq",
      pass: observed.observed.mathSolverReason === expect.expectMathReasonEq,
      detail: `expected=${expect.expectMathReasonEq} actual=${observed.observed.mathSolverReason || "<empty>"}`,
    });
  }
  if (Array.isArray(expect.expectMathReasonIn) && expect.expectMathReasonIn.length > 0) {
    const pass = expect.expectMathReasonIn.some((needle) =>
      observed.observed.mathSolverReason.toLowerCase().includes(needle.toLowerCase()),
    );
    checks.push({
      name: "math_solver_reason_in",
      pass,
      detail: `needles=${expect.expectMathReasonIn.join("|")} actual=${observed.observed.mathSolverReason || "<empty>"}`,
    });
  }
  if (typeof expect.expectForcedMath === "boolean") {
    checks.push({
      name: "forced_math_path",
      pass: observed.observed.forcedMath === expect.expectForcedMath,
      detail: `expected=${expect.expectForcedMath} actual=${observed.observed.forcedMath}`,
    });
  }
  if (typeof expect.expectBypassMode === "string") {
    checks.push({
      name: "open_world_bypass_mode",
      pass: observed.observed.bypassMode === expect.expectBypassMode,
      detail: `expected=${expect.expectBypassMode} actual=${observed.observed.bypassMode || "<empty>"}`,
    });
  }
  for (const mustInclude of expect.expectAnswerIncludes ?? []) {
    checks.push({
      name: "answer_includes",
      pass: observed.responseText.toLowerCase().includes(mustInclude.toLowerCase()),
      detail: `needle=${mustInclude}`,
    });
  }
  for (const mustExclude of expect.expectAnswerExcludes ?? []) {
    checks.push({
      name: "answer_excludes",
      pass: !observed.responseText.toLowerCase().includes(mustExclude.toLowerCase()),
      detail: `needle=${mustExclude}`,
    });
  }
  return checks;
}

function toCaseResult(caseDef: BatteryCase, run: { status: number; latencyMs: number; payload?: AskResponse; error?: string }): CaseResult {
  const payload = run.payload ?? {};
  const debug = payload.debug ?? {};
  const answerPath = toAnswerPath(debug.answer_path);
  const forcedMath = answerPath.includes("forcedAnswer:math_solver") || answerPath.includes("forcedAnswer:math_solver_warp_guard");
  const observed: CaseResult = {
    id: caseDef.id,
    label: caseDef.label,
    class: caseDef.class,
    question: caseDef.question,
    status: run.status,
    latencyMs: run.latencyMs,
    requestOk: run.status >= 200 && run.status < 300,
    responseText: toStr(payload.text),
    debug,
    observed: {
      mathSolverOk: toBool(debug.math_solver_ok),
      mathSolverReason: toStr(debug.math_solver_reason),
      mathSolverKind: toStr(debug.math_solver_kind),
      forcedMath,
      forcedMathWarpGuard: answerPath.includes("forcedAnswer:math_solver_warp_guard"),
      bypassMode: toStr(debug.open_world_bypass_mode),
      answerPath,
    },
    checks: [],
    pass: false,
    failureCount: 0,
    ...(run.error ? { error: run.error } : {}),
  };
  const checks = evaluate(caseDef, observed);
  if (run.error) {
    checks.push({ name: "request_ok", pass: false, detail: run.error });
  }
  observed.checks = checks;
  observed.failureCount = checks.filter((entry) => !entry.pass).length;
  observed.pass = observed.failureCount === 0;
  return observed;
}

function buildSummary(
  runId: string,
  batteryPath: string,
  batteryVersion: string,
  runLabel: string,
  startedAt: string,
  finishedAt: string,
  results: CaseResult[],
): RunSummary {
  const total = results.length;
  const pass = results.filter((entry) => entry.pass).length;
  const fail = total - pass;
  const classSummary: Record<BatteryCaseClass, ClassSummary> = {
    deterministic_compute: { total: 0, pass: 0 },
    generic_reasoning: { total: 0, pass: 0 },
    warp_certificate_required: { total: 0, pass: 0 },
  };
  const reasonHistogram: Record<string, number> = {};

  for (const entry of results) {
    classSummary[entry.class].total += 1;
    if (entry.pass) classSummary[entry.class].pass += 1;
    const key = entry.observed.mathSolverReason || "none";
    reasonHistogram[key] = (reasonHistogram[key] ?? 0) + 1;
  }

  const deterministic = results.filter((entry) => entry.class === "deterministic_compute");
  const deterministicForced = deterministic.filter((entry) => entry.observed.forcedMath).length;
  const deterministicMathSolverOk = deterministic.filter((entry) => entry.observed.mathSolverOk).length;
  const deterministicSilentBypass = deterministic.filter(
    (entry) =>
      !entry.observed.forcedMath &&
      !entry.observed.mathSolverOk &&
      !entry.observed.mathSolverReason,
  ).length;

  const warpCases = results.filter((entry) => entry.class === "warp_certificate_required");
  const warpGuardHits = warpCases.filter((entry) => entry.observed.forcedMathWarpGuard).length;

  const topFailures = results
    .filter((entry) => entry.failureCount > 0)
    .sort((a, b) => b.failureCount - a.failureCount)
    .slice(0, 8)
    .map((entry) => ({
      id: entry.id,
      class: entry.class,
      failureCount: entry.failureCount,
      failedChecks: entry.checks.filter((check) => !check.pass).map((check) => check.name),
    }));

  return {
    runId,
    runLabel,
    batteryVersion,
    batteryPath: path.resolve(batteryPath),
    baseUrl: BASE_URL,
    askUrl: ASK_URL,
    total,
    pass,
    fail,
    classSummary,
    metrics: {
      forcedMathRateDeterministic: deterministic.length ? clamp01(deterministicForced / deterministic.length) : 0,
      mathSolverOkRateDeterministic: deterministic.length ? clamp01(deterministicMathSolverOk / deterministic.length) : 0,
      silentBypassCountDeterministic: deterministicSilentBypass,
      warpGuardCoverage: warpCases.length ? clamp01(warpGuardHits / warpCases.length) : 0,
    },
    reasonHistogram,
    topFailures,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
  };
}

function buildReport(summary: RunSummary, results: CaseResult[], runDir: string): string {
  const lines: string[] = [];
  lines.push(`# Helix Ask Math Router Evidence (${summary.runId})`);
  lines.push("");
  lines.push(`- Run label: \`${summary.runLabel}\``);
  lines.push(`- Battery: \`${summary.batteryPath}\``);
  lines.push(`- Base URL: \`${summary.baseUrl}\``);
  lines.push(`- Started: \`${summary.startedAt}\``);
  lines.push(`- Finished: \`${summary.finishedAt}\``);
  lines.push(`- Artifacts: \`${runDir}\``);
  lines.push("");
  lines.push("## Scorecard");
  lines.push("");
  lines.push(`- Total: **${summary.total}**`);
  lines.push(`- Pass: **${summary.pass}**`);
  lines.push(`- Fail: **${summary.fail}**`);
  lines.push(`- Deterministic forced-math rate: **${(summary.metrics.forcedMathRateDeterministic * 100).toFixed(1)}%**`);
  lines.push(`- Deterministic math-solver-ok rate: **${(summary.metrics.mathSolverOkRateDeterministic * 100).toFixed(1)}%**`);
  lines.push(`- Deterministic silent bypass count: **${summary.metrics.silentBypassCountDeterministic}**`);
  lines.push(`- Warp-guard coverage: **${(summary.metrics.warpGuardCoverage * 100).toFixed(1)}%**`);
  lines.push("");
  lines.push("## By Class");
  lines.push("");
  lines.push("| Class | Total | Pass |");
  lines.push("| --- | ---: | ---: |");
  lines.push(
    `| deterministic_compute | ${summary.classSummary.deterministic_compute.total} | ${summary.classSummary.deterministic_compute.pass} |`,
  );
  lines.push(
    `| generic_reasoning | ${summary.classSummary.generic_reasoning.total} | ${summary.classSummary.generic_reasoning.pass} |`,
  );
  lines.push(
    `| warp_certificate_required | ${summary.classSummary.warp_certificate_required.total} | ${summary.classSummary.warp_certificate_required.pass} |`,
  );
  lines.push("");
  lines.push("## Math Reason Histogram");
  lines.push("");
  for (const [reason, count] of Object.entries(summary.reasonHistogram).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${reason}\`: ${count}`);
  }
  lines.push("");
  lines.push("## Top Failures");
  lines.push("");
  if (!summary.topFailures.length) {
    lines.push("- none");
  } else {
    for (const failure of summary.topFailures) {
      lines.push(
        `- \`${failure.id}\` (${failure.class}) failed ${failure.failureCount} check(s): ${failure.failedChecks.join(", ")}`,
      );
    }
  }
  lines.push("");
  lines.push("## Case Snapshot");
  lines.push("");
  for (const entry of results) {
    lines.push(`- \`${entry.id}\` [${entry.class}] pass=${entry.pass} status=${entry.status} latencyMs=${entry.latencyMs} reason=\`${entry.observed.mathSolverReason || "none"}\` forcedMath=${entry.observed.forcedMath}`);
  }
  lines.push("");
  lines.push("## Next Tuning Targets");
  lines.push("");
  lines.push("1. Reduce deterministic silent bypass count to 0.");
  lines.push("2. Keep warp-guard coverage at 100% for certificate-required prompts.");
  lines.push("3. Validate deterministic path before any single-pipeline migration.");
  lines.push("");
  return lines.join("\n");
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const runId = timestampId();
  const battery = await readBattery(BATTERY_PATH);
  const runDir = path.resolve(OUT_ROOT, runId);
  const rawDir = path.join(runDir, "raw");
  await fs.mkdir(rawDir, { recursive: true });

  if (!DRY_RUN) {
    await precheckHelixAskAvailability({
      baseUrl: BASE_URL,
      timeoutMs: Math.min(10000, REQUEST_TIMEOUT_MS),
      label: "helix-ask-math-router-evidence",
    });
  }

  const results: CaseResult[] = [];
  for (let index = 0; index < battery.cases.length; index += 1) {
    const caseDef = battery.cases[index];
    const sessionId = `helix-ask-math-router-evidence:${runId}:${caseDef.id}`;
    let result: CaseResult;
    if (DRY_RUN) {
      result = toCaseResult(caseDef, {
        status: 200,
        latencyMs: 0,
        payload: { text: "", debug: {} },
      });
      result.checks = [{ name: "dry_run", pass: true, detail: "skipped_live_request" }];
      result.pass = true;
      result.failureCount = 0;
      result.skipped = true;
    } else {
      const run = await runAsk(caseDef.question, sessionId);
      result = toCaseResult(caseDef, run);
    }
    results.push(result);
    const rawPath = path.join(rawDir, `${String(index + 1).padStart(2, "0")}-${slug(caseDef.id)}.json`);
    await writeJson(rawPath, result);
    const statusMark = result.pass ? "PASS" : "FAIL";
    console.log(`[${statusMark}] ${caseDef.id} latency=${result.latencyMs}ms reason=${result.observed.mathSolverReason || "none"}`);
  }

  const finishedAt = new Date().toISOString();
  const summary = buildSummary(runId, BATTERY_PATH, battery.version, RUN_LABEL, startedAt, finishedAt, results);
  const report = buildReport(summary, results, runDir);

  const summaryPath = path.join(runDir, "summary.json");
  const resultsPath = path.join(runDir, "results.json");
  const reportPath = path.resolve(REPORT_DIR, `helix-ask-math-router-evidence-${runId}.md`);
  const latestJsonPath = path.resolve(OUT_ROOT, "latest.json");
  const latestReportPath = path.resolve(REPORT_LATEST_PATH);

  await writeJson(summaryPath, summary);
  await writeJson(resultsPath, results);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, report, "utf8");
  await writeJson(latestJsonPath, { summaryPath, resultsPath, reportPath, runId, summary });
  await fs.mkdir(path.dirname(latestReportPath), { recursive: true });
  await fs.writeFile(latestReportPath, report, "utf8");

  console.log(`\nRun complete: ${runId}`);
  console.log(`Summary: ${summaryPath}`);
  console.log(`Results: ${resultsPath}`);
  console.log(`Report: ${reportPath}`);
  console.log(`Latest report: ${latestReportPath}`);

  if (STRICT && summary.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
