import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { precheckHelixAskAvailability } from "./helix-ask-availability-precheck";

type AskDebug = {
  intent_id?: string;
  intent_domain?: string;
  intent_strategy?: string;
  report_mode?: boolean;
  report_mode_reason?: string;
  relation_packet_built?: boolean;
  relation_packet_bridge_count?: number;
  relation_packet_evidence_count?: number;
  relation_dual_domain_ok?: boolean;
};

type AskResponse = {
  text?: string;
  debug?: AskDebug;
  report_mode?: boolean;
};

type GoalExpect = {
  intent_id?: string;
  intent_strategy?: string;
  report_mode?: boolean;
  relation_packet_built?: boolean;
  relation_dual_domain_ok?: boolean;
  min_bridge_count?: number;
  min_evidence_count?: number;
  min_text_chars?: number;
  must_include_text?: string[];
  must_not_include_text?: string[];
  disallow_report_sections?: boolean;
};

type GoalCase = {
  id: string;
  question: string;
  expect: GoalExpect;
};

type GoalPack = {
  name?: string;
  max_iterations?: number;
  min_case_pass_rate?: number;
  allow_stub_text?: boolean;
  cases: GoalCase[];
};

type SeedResult = {
  seed: number;
  status: number;
  latency_ms: number;
  pass: boolean;
  failures: string[];
  text_preview: string;
  debug: AskDebug | null;
};

type CaseResult = {
  id: string;
  question: string;
  pass_rate: number;
  pass: boolean;
  seed_results: SeedResult[];
};

type IterationResult = {
  iteration: number;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  pass: boolean;
  pass_rate: number;
  failed_cases: number;
  total_cases: number;
  case_results: CaseResult[];
  failure_counts: Record<string, number>;
  next_patch_targets: string[];
  consistency_warnings?: string[];
};

const BASE_URL = process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:5173";
const PACK_PATH =
  process.env.HELIX_ASK_GOAL_PACK ?? "bench/helix_ask_goal_zone_pack.json";
const OUT_DIR =
  process.env.HELIX_ASK_GOAL_OUT ?? "artifacts/helix-ask-goal-zone";
const REPORT_PATH =
  process.env.HELIX_ASK_GOAL_REPORT ?? "reports/helix-ask-goal-zone-latest.md";
const START_SERVER = (process.env.HELIX_ASK_GOAL_START_SERVER ?? "0") === "1";
const SERVER_COMMAND = process.env.HELIX_ASK_GOAL_SERVER_CMD ?? "npm";
const SERVER_ARGS =
  process.env.HELIX_ASK_GOAL_SERVER_ARGS?.split(/\s+/).filter(Boolean) ??
  ["run", "dev:agi:5173"];
const REQUEST_TIMEOUT_MS = Number(
  process.env.HELIX_ASK_GOAL_TIMEOUT_MS ?? 120000,
);
const MAX_ITERATIONS_ENV = Number(process.env.HELIX_ASK_GOAL_ITERATIONS ?? "0");
const MIN_CASE_PASS_RATE_ENV = Number(
  process.env.HELIX_ASK_GOAL_MIN_CASE_PASS_RATE ?? "0",
);
const ALLOW_STUB_TEXT_ENV = process.env.HELIX_ASK_GOAL_ALLOW_STUB;
const SEEDS = (process.env.HELIX_ASK_GOAL_SEEDS ?? "7,11,13")
  .split(",")
  .map((entry) => Number(entry.trim()))
  .filter((entry) => Number.isFinite(entry));

const REPORT_SECTION_RE =
  /(Executive summary:|Coverage map:|Point-by-point:|Report covers)/i;
const STUB_TEXT_RE = /llm\.local stub result/i;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const clamp01 = (value: number, fallback = 1): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
};

const toNumber = (value: unknown, fallback = 0): number => {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

const readPack = async (): Promise<GoalPack> => {
  const raw = await fs.readFile(path.resolve(PACK_PATH), "utf8");
  const parsed = JSON.parse(raw) as GoalPack;
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error("goal pack has no cases");
  }
  return parsed;
};

const ensureServerReady = async (timeoutMs = 120000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(new URL("/api/ready", BASE_URL), {
        cache: "no-store",
      });
      if (response.status === 200) {
        const payload = (await response.json().catch(() => null)) as
          | { ready?: boolean }
          | null;
        if (!payload || payload.ready !== false) return;
      }
    } catch {
      // retry
    }
    await sleep(1000);
  }
  await precheckHelixAskAvailability({
    baseUrl: BASE_URL,
    timeoutMs: Math.min(10000, timeoutMs),
    label: "server readiness precheck",
  });
};

const startServer = async () => {
  const child = spawn(SERVER_COMMAND, SERVER_ARGS, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[goal-zone:server] ${chunk}`));
  child.stderr?.on("data", (chunk) =>
    process.stderr.write(`[goal-zone:server:err] ${chunk}`),
  );
  await ensureServerReady();
  return child;
};

const stopServer = async (child: ReturnType<typeof spawn>) => {
  if (child.killed) return;
  child.kill("SIGINT");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolve();
    }, 10000);
  });
};

const ask = async (question: string, seed: number, sessionId: string) => {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(new URL("/api/agi/ask", BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question,
        debug: true,
        seed,
        temperature: 0.2,
        verbosity: "extended",
        sessionId,
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    clearTimeout(timeout);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      const text = await response.text();
      return {
        status: response.status,
        latency_ms: latencyMs,
        payload: { text } as AskResponse,
      };
    }
    const payload = (await response.json()) as AskResponse;
    return { status: response.status, latency_ms: latencyMs, payload };
  } catch (error) {
    clearTimeout(timeout);
    const message =
      error instanceof Error ? error.message : typeof error === "string" ? error : "request_failed";
    return {
      status: 0,
      latency_ms: Date.now() - started,
      payload: { text: message } as AskResponse,
    };
  }
};

const toPreview = (value: string): string =>
  value.replace(/\s+/g, " ").trim().slice(0, 280);

const evaluateSeed = (
  testCase: GoalCase,
  seed: number,
  response: { status: number; latency_ms: number; payload: AskResponse },
  allowStubText: boolean,
): SeedResult => {
  const failures: string[] = [];
  const text = String(response.payload.text ?? "");
  const debug = response.payload.debug ?? null;
  const expect = testCase.expect;
  const reportModeActual =
    typeof debug?.report_mode === "boolean"
      ? debug.report_mode
      : typeof response.payload.report_mode === "boolean"
        ? response.payload.report_mode
        : undefined;

  if (response.status !== 200) {
    failures.push(`request_failed:${response.status || "network"}`);
  }
  if (expect.intent_id && debug?.intent_id !== expect.intent_id) {
    failures.push(`intent_id_mismatch:${debug?.intent_id ?? "missing"}`);
  }
  if (expect.intent_strategy && debug?.intent_strategy !== expect.intent_strategy) {
    failures.push(`intent_strategy_mismatch:${debug?.intent_strategy ?? "missing"}`);
  }
  if (
    typeof expect.report_mode === "boolean" &&
    reportModeActual !== expect.report_mode
  ) {
    failures.push(`report_mode_mismatch:${String(reportModeActual)}`);
  }
  if (
    typeof expect.relation_packet_built === "boolean" &&
    debug?.relation_packet_built !== expect.relation_packet_built
  ) {
    failures.push(
      `relation_packet_built_mismatch:${String(debug?.relation_packet_built)}`,
    );
  }
  if (
    typeof expect.relation_dual_domain_ok === "boolean" &&
    debug?.relation_dual_domain_ok !== expect.relation_dual_domain_ok
  ) {
    failures.push(
      `relation_dual_domain_mismatch:${String(debug?.relation_dual_domain_ok)}`,
    );
  }
  if (
    typeof expect.min_bridge_count === "number" &&
    toNumber(debug?.relation_packet_bridge_count) < expect.min_bridge_count
  ) {
    failures.push(
      `bridge_count_low:${toNumber(debug?.relation_packet_bridge_count)}`,
    );
  }
  if (
    typeof expect.min_evidence_count === "number" &&
    toNumber(debug?.relation_packet_evidence_count) < expect.min_evidence_count
  ) {
    failures.push(
      `evidence_count_low:${toNumber(debug?.relation_packet_evidence_count)}`,
    );
  }

  const isStubText = STUB_TEXT_RE.test(text);
  if (isStubText && !allowStubText) {
    failures.push("stub_text_detected");
  }

  const shouldRunTextChecks = !isStubText || !allowStubText;
  if (shouldRunTextChecks) {
    if (
      typeof expect.min_text_chars === "number" &&
      text.trim().length < expect.min_text_chars
    ) {
      failures.push(`text_too_short:${text.trim().length}`);
    }
    if (expect.disallow_report_sections && REPORT_SECTION_RE.test(text)) {
      failures.push("report_sections_detected");
    }
    if (!allowStubText) {
      for (const token of expect.must_include_text ?? []) {
        if (!text.toLowerCase().includes(token.toLowerCase())) {
          failures.push(`text_missing:${token}`);
        }
      }
    }
    for (const token of expect.must_not_include_text ?? []) {
      if (text.toLowerCase().includes(token.toLowerCase())) {
        failures.push(`text_forbidden:${token}`);
      }
    }
  }

  return {
    seed,
    status: response.status,
    latency_ms: response.latency_ms,
    pass: failures.length === 0,
    failures,
    text_preview: toPreview(text),
    debug,
  };
};

const toFailureCounts = (cases: CaseResult[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const entry of cases) {
    for (const seedResult of entry.seed_results) {
      for (const failure of seedResult.failures) {
        const key = failure.split(":")[0] ?? failure;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
  }
  return counts;
};

const buildNextPatchTargets = (failureCounts: Record<string, number>): string[] => {
  const targets: string[] = [];
  const has = (key: string) => (failureCounts[key] ?? 0) > 0;
  if (has("report_mode_mismatch") || has("report_sections_detected")) {
    targets.push(
      "Bypass auto report-mode fanout for relation prompts unless explicit report request.",
    );
  }
  if (has("intent_id_mismatch") || has("intent_strategy_mismatch")) {
    targets.push(
      "Stabilize relation routing to hybrid.warp_ethos_relation with hybrid_explain strategy.",
    );
  }
  if (has("relation_packet_built_mismatch") || has("relation_dual_domain_mismatch")) {
    targets.push(
      "Ensure RAP is built after dual-domain topology detection and surfaced in debug payload.",
    );
  }
  if (has("bridge_count_low") || has("evidence_count_low")) {
    targets.push(
      "Increase deterministic relation assembly density (bridge claims and cross-domain evidence).",
    );
  }
  if (has("text_too_short") || has("text_missing")) {
    targets.push(
      "Raise relation answer minimum detail and enforce core narrative sections for warp+ethos linkage.",
    );
  }
  if (has("text_forbidden")) {
    targets.push("Tighten answer cleaner to strip metadata/code noise and report scaffolding text.");
  }
  if (has("request_failed")) {
    targets.push("Fix server reliability first (route availability/timeouts) before quality tuning.");
  }
  if (has("stub_text_detected")) {
    targets.push("Run with real local model enabled; stub output cannot validate narrative quality.");
  }
  if (targets.length === 0) {
    targets.push("No blocking failures detected.");
  }
  return targets;
};

const renderMarkdown = (result: IterationResult): string => {
  const lines: string[] = [];
  lines.push(`# Helix Ask Goal Zone - Iteration ${result.iteration}`);
  lines.push("");
  lines.push(`- pass: ${result.pass ? "yes" : "no"}`);
  lines.push(`- pass_rate: ${(result.pass_rate * 100).toFixed(1)}%`);
  lines.push(`- failed_cases: ${result.failed_cases}/${result.total_cases}`);
  lines.push(`- duration_ms: ${result.duration_ms}`);
  if (result.consistency_warnings?.length) {
    lines.push(`- consistency_warnings: ${result.consistency_warnings.length}`);
  }
  lines.push("");
  lines.push("## Case Summary");
  for (const entry of result.case_results) {
    lines.push(
      `- ${entry.id}: ${entry.pass ? "PASS" : "FAIL"} (${(entry.pass_rate * 100).toFixed(0)}%)`,
    );
  }
  lines.push("");
  lines.push("## Failure Counts");
  const failureEntries = Object.entries(result.failure_counts).sort((a, b) => b[1] - a[1]);
  if (!failureEntries.length) {
    lines.push("- none");
  } else {
    for (const [reason, count] of failureEntries) {
      lines.push(`- ${reason}: ${count}`);
    }
  }
  lines.push("");
  lines.push("## Next Patch Targets");
  for (const target of result.next_patch_targets) {
    lines.push(`- ${target}`);
  }
  if (result.consistency_warnings?.length) {
    lines.push("");
    lines.push("## Consistency Warnings");
    for (const warning of result.consistency_warnings) {
      lines.push(`- ${warning}`);
    }
  }
  lines.push("");
  return lines.join("\n");
};

const normalizeIterationResult = (
  result: IterationResult,
): IterationResult => {
  const warnings: string[] = [];
  const totalCases = result.case_results.length;
  const failedCases = result.case_results.filter((entry) => !entry.pass).length;
  const passRate =
    totalCases > 0
      ? result.case_results.filter((entry) => entry.pass).length / totalCases
      : 0;
  const pass = failedCases === 0;
  const failureCounts = toFailureCounts(result.case_results);

  if (result.total_cases !== totalCases) {
    warnings.push(
      `total_cases corrected ${result.total_cases} -> ${totalCases}`,
    );
  }
  if (result.failed_cases !== failedCases) {
    warnings.push(
      `failed_cases corrected ${result.failed_cases} -> ${failedCases}`,
    );
  }
  if (Math.abs(result.pass_rate - passRate) > 1e-6) {
    warnings.push(
      `pass_rate corrected ${(result.pass_rate * 100).toFixed(1)}% -> ${(passRate * 100).toFixed(1)}%`,
    );
  }
  if (result.pass !== pass) {
    warnings.push(`pass corrected ${result.pass ? "yes" : "no"} -> ${pass ? "yes" : "no"}`);
  }
  if (JSON.stringify(result.failure_counts) !== JSON.stringify(failureCounts)) {
    warnings.push("failure_counts corrected from seed_results");
  }

  return {
    ...result,
    pass,
    pass_rate: passRate,
    failed_cases: failedCases,
    total_cases: totalCases,
    failure_counts: failureCounts,
    consistency_warnings: warnings.length ? warnings : undefined,
  };
};

const writeAtomic = async (filePath: string, content: string) => {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, filePath);
};

const runIteration = async (
  pack: GoalPack,
  iteration: number,
  minCasePassRate: number,
  allowStubText: boolean,
): Promise<IterationResult> => {
  const startedAt = Date.now();
  const caseResults: CaseResult[] = [];
  for (const testCase of pack.cases) {
    const seedResults: SeedResult[] = [];
    for (const seed of SEEDS) {
      const sessionId = `goal-zone:${iteration}:${testCase.id}:seed${seed}`.slice(0, 120);
      const response = await ask(testCase.question, seed, sessionId);
      const evaluated = evaluateSeed(testCase, seed, response, allowStubText);
      seedResults.push(evaluated);
    }
    const passCount = seedResults.filter((entry) => entry.pass).length;
    const passRate = seedResults.length > 0 ? passCount / seedResults.length : 0;
    caseResults.push({
      id: testCase.id,
      question: testCase.question,
      pass_rate: passRate,
      pass: passRate >= minCasePassRate,
      seed_results: seedResults,
    });
  }
  const failedCases = caseResults.filter((entry) => !entry.pass).length;
  const passRate =
    caseResults.length > 0
      ? caseResults.filter((entry) => entry.pass).length / caseResults.length
      : 0;
  const failureCounts = toFailureCounts(caseResults);
  return {
    iteration,
    started_at: new Date(startedAt).toISOString(),
    ended_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    pass: failedCases === 0,
    pass_rate: passRate,
    failed_cases: failedCases,
    total_cases: caseResults.length,
    case_results: caseResults,
    failure_counts: failureCounts,
    next_patch_targets: buildNextPatchTargets(failureCounts),
  };
};

const writeIterationArtifacts = async (result: IterationResult) => {
  const normalized = normalizeIterationResult(result);
  const iterDir = path.join(OUT_DIR, `iter-${String(result.iteration).padStart(2, "0")}`);
  await fs.mkdir(iterDir, { recursive: true });
  await writeAtomic(
    path.join(iterDir, "results.json"),
    JSON.stringify(normalized, null, 2),
  );
  await writeAtomic(path.join(OUT_DIR, "latest.json"), JSON.stringify(normalized, null, 2));
  const markdown = renderMarkdown(normalized);
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeAtomic(REPORT_PATH, markdown);
  if (normalized.consistency_warnings?.length) {
    console.warn(
      `[goal-zone] normalized iteration ${normalized.iteration}: ${normalized.consistency_warnings.join("; ")}`,
    );
  }
};

const main = async () => {
  const pack = await readPack();
  const maxIterations = Math.max(
    1,
    MAX_ITERATIONS_ENV > 0 ? MAX_ITERATIONS_ENV : toNumber(pack.max_iterations, 1),
  );
  const minCasePassRate = clamp01(
    MIN_CASE_PASS_RATE_ENV > 0
      ? MIN_CASE_PASS_RATE_ENV
      : toNumber(pack.min_case_pass_rate, 1),
    1,
  );
  const allowStubText =
    ALLOW_STUB_TEXT_ENV !== undefined
      ? ALLOW_STUB_TEXT_ENV === "1"
      : Boolean(pack.allow_stub_text);
  await fs.mkdir(OUT_DIR, { recursive: true });

  let server: ReturnType<typeof spawn> | null = null;
  if (START_SERVER) {
    server = await startServer();
  } else {
    await ensureServerReady();
  }
  await precheckHelixAskAvailability({
    baseUrl: BASE_URL,
    timeoutMs: Math.min(10000, REQUEST_TIMEOUT_MS),
    label: "goal-zone campaign precheck",
  });

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      const result = await runIteration(pack, iteration, minCasePassRate, allowStubText);
      await writeIterationArtifacts(result);
      console.log(
        `[goal-zone] iter=${iteration} pass=${result.pass} passRate=${(result.pass_rate * 100).toFixed(1)}% failedCases=${result.failed_cases}/${result.total_cases}`,
      );
      if (result.pass) {
        console.log("[goal-zone] goal reached.");
        process.exit(0);
      }
    }
    console.error("[goal-zone] goal not reached within max iterations.");
    process.exit(2);
  } finally {
    if (server) {
      await stopServer(server);
    }
  }
};

main().catch((error) => {
  console.error("[helix-ask-goal-zone] failed:", error);
  process.exit(1);
});
