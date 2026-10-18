import fs from "node:fs/promises";
import path from "node:path";
import { precheckHelixAskAvailability } from "./helix-ask-availability-precheck";
import {
  evaluateEquationBenchmarkCase,
  type EquationBenchmarkCase,
  type EquationBenchmarkCaseFile,
} from "./lib/helix-ask-equation-benchmark";

type AskDebug = Record<string, unknown> & {
  intent_id?: string;
  intent_domain?: string;
  answer_path?: string[];
};

type AskResponse = {
  text?: string;
  answer?: string;
  debug?: AskDebug;
  error?: string;
  message?: string;
};

type BenchmarkCaseResult = {
  id: string;
  label: string;
  question: string;
  status: number;
  latency_ms: number;
  pass: boolean;
  score: number;
  failures: string[];
  warnings: string[];
  details: {
    sectionScore: number;
    topicScore: number;
    equationScore: number;
    sourceScore: number;
    mechanismScore: number;
    cleanlinessPenalty: number;
    threshold: number;
  };
  response_text: string;
  debug: AskDebug;
};

type BenchmarkSummary = {
  run_id: string;
  generated_at: string;
  version: string;
  base_url: string;
  ask_url: string;
  benchmark_file: string;
  total: number;
  pass: number;
  fail: number;
  pass_rate: number;
  avg_score: number;
  p50_score: number;
  p95_score: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  failure_histogram: Record<string, number>;
  low_score_cases: Array<{ id: string; score: number; failures: string[] }>;
};

const BASE_URL = process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:5050";
const ASK_URL = new URL("/api/agi/ask", BASE_URL).toString();
const BENCHMARK_PATH =
  process.env.HELIX_ASK_EQUATION_BENCHMARK_FILE ?? "scripts/helix-ask-equation-benchmark.json";
const OUT_ROOT =
  process.env.HELIX_ASK_EQUATION_BENCHMARK_OUT_DIR ??
  "artifacts/experiments/helix-ask-equation-benchmark";
const REPORT_PATH =
  process.env.HELIX_ASK_EQUATION_BENCHMARK_REPORT_PATH ??
  "reports/helix-ask-equation-benchmark-latest.md";
const REQUEST_TIMEOUT_MS = Number(process.env.HELIX_ASK_EQUATION_BENCHMARK_TIMEOUT_MS ?? 60000);
const PRECHECK_TIMEOUT_MS = Number(
  process.env.HELIX_ASK_EQUATION_BENCHMARK_PRECHECK_TIMEOUT_MS ??
    Math.min(REQUEST_TIMEOUT_MS, 15000),
);
const STRICT = process.env.HELIX_ASK_EQUATION_BENCHMARK_STRICT === "1";
const DRY_RUN = process.env.HELIX_ASK_EQUATION_BENCHMARK_DRY_RUN === "1";

const quantile = (values: number[], q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.max(0, Math.min(1, q));
  const idx = clamped * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] ?? 0;
  const weight = idx - lo;
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? 0;
  return a + (b - a) * weight;
};

const nowId = (): string => new Date().toISOString().replace(/[:.]/g, "-");

const readBenchmarkFile = async (filePath: string): Promise<EquationBenchmarkCaseFile> => {
  const fullPath = path.resolve(filePath);
  const raw = await fs.readFile(fullPath, "utf8");
  const parsed = JSON.parse(raw) as EquationBenchmarkCaseFile;
  if (!parsed || !Array.isArray(parsed.cases)) {
    throw new Error(`invalid_equation_benchmark_file:${fullPath}`);
  }
  return parsed;
};

const runAsk = async (question: string, sessionId: string): Promise<{
  status: number;
  latencyMs: number;
  payload: AskResponse;
}> => {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
    const latencyMs = Date.now() - started;
    const raw = await response.text();
    let payload: AskResponse;
    try {
      payload = raw ? (JSON.parse(raw) as AskResponse) : {};
    } catch (error) {
      const parseMessage = error instanceof Error ? error.message : String(error);
      payload = {
        text: raw,
        error: `response_json_parse_failed:${parseMessage}`,
      };
    }
    return { status: response.status, latencyMs, payload };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : typeof error === "string" ? error : "request_failed";
    return {
      status: 0,
      latencyMs: Date.now() - started,
      payload: { text: "", error: message },
    };
  } finally {
    clearTimeout(timer);
  }
};

const makeDryRunResult = (entry: EquationBenchmarkCase): BenchmarkCaseResult => ({
  id: entry.id,
  label: entry.label,
  question: entry.question,
  status: 0,
  latency_ms: 0,
  pass: true,
  score: 0,
  failures: [],
  warnings: ["dry_run"],
  details: {
    sectionScore: 0,
    topicScore: 0,
    equationScore: 0,
    sourceScore: 0,
    mechanismScore: 0,
    cleanlinessPenalty: 0,
    threshold: entry.expect?.passThreshold ?? 70,
  },
  response_text: "",
  debug: {},
});

const toHistogram = (results: BenchmarkCaseResult[]): Record<string, number> => {
  const histogram: Record<string, number> = {};
  for (const row of results) {
    for (const failure of row.failures) {
      histogram[failure] = (histogram[failure] ?? 0) + 1;
    }
  }
  return histogram;
};

const buildSummary = (
  runId: string,
  benchmarkFile: string,
  version: string,
  results: BenchmarkCaseResult[],
): BenchmarkSummary => {
  const total = results.length;
  const pass = results.filter((entry) => entry.pass).length;
  const fail = total - pass;
  const scores = results.map((entry) => entry.score);
  const latencies = results.map((entry) => entry.latency_ms);
  const avgScore = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0;
  const avgLatency = latencies.length
    ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
    : 0;

  return {
    run_id: runId,
    generated_at: new Date().toISOString(),
    version,
    base_url: BASE_URL,
    ask_url: ASK_URL,
    benchmark_file: benchmarkFile,
    total,
    pass,
    fail,
    pass_rate: total > 0 ? Number((pass / total).toFixed(4)) : 0,
    avg_score: Number(avgScore.toFixed(2)),
    p50_score: Number(quantile(scores, 0.5).toFixed(2)),
    p95_score: Number(quantile(scores, 0.95).toFixed(2)),
    avg_latency_ms: Number(avgLatency.toFixed(2)),
    p95_latency_ms: Number(quantile(latencies, 0.95).toFixed(2)),
    failure_histogram: toHistogram(results),
    low_score_cases: results
      .filter((entry) => !entry.pass || entry.score < 65)
      .sort((a, b) => a.score - b.score)
      .slice(0, 12)
      .map((entry) => ({
        id: entry.id,
        score: entry.score,
        failures: entry.failures.slice(0, 4),
      })),
  };
};

const renderReport = (summary: BenchmarkSummary, results: BenchmarkCaseResult[]): string => {
  const lines: string[] = [];
  lines.push("# Helix Ask Equation Benchmark");
  lines.push("");
  lines.push(`- run_id: \`${summary.run_id}\``);
  lines.push(`- generated_at: \`${summary.generated_at}\``);
  lines.push(`- benchmark_file: \`${summary.benchmark_file}\``);
  lines.push(`- pass_rate: \`${summary.pass_rate}\``);
  lines.push(`- avg_score: \`${summary.avg_score}\``);
  lines.push(`- p95_latency_ms: \`${summary.p95_latency_ms}\``);
  lines.push("");
  lines.push("## Top Failures");
  lines.push("");
  const failures = Object.entries(summary.failure_histogram).sort((a, b) => b[1] - a[1]);
  if (failures.length === 0) {
    lines.push("- none");
  } else {
    for (const [reason, count] of failures.slice(0, 10)) {
      lines.push(`- \`${reason}\`: ${count}`);
    }
  }
  lines.push("");
  lines.push("## Case Results");
  lines.push("");
  for (const row of results) {
    const marker = row.pass ? "PASS" : "FAIL";
    lines.push(`### ${row.id} (${marker})`);
    lines.push(`- label: ${row.label}`);
    lines.push(`- score: ${row.score}`);
    lines.push(`- latency_ms: ${row.latency_ms}`);
    if (row.failures.length > 0) {
      lines.push(`- failures: ${row.failures.join(", ")}`);
    }
    if (row.warnings.length > 0) {
      lines.push(`- warnings: ${row.warnings.join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
};

const ensureDir = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true });
};

async function main(): Promise<void> {
  const runId = nowId();
  const benchmark = await readBenchmarkFile(BENCHMARK_PATH);
  const outDir = path.resolve(OUT_ROOT, runId);
  await ensureDir(outDir);

  if (!DRY_RUN) {
    await precheckHelixAskAvailability({
      baseUrl: BASE_URL,
      timeoutMs: PRECHECK_TIMEOUT_MS,
      label: "equation_benchmark_precheck",
    });
  }

  const results: BenchmarkCaseResult[] = [];
  for (const testCase of benchmark.cases) {
    if (DRY_RUN) {
      results.push(makeDryRunResult(testCase));
      continue;
    }
    const sessionId = `helix-equation-bench-${runId}-${testCase.id}`;
    const ask = await runAsk(testCase.question, sessionId);
    const text = String(ask.payload.text ?? ask.payload.answer ?? "");
    const evalResult = evaluateEquationBenchmarkCase(text, testCase.expect);
    results.push({
      id: testCase.id,
      label: testCase.label,
      question: testCase.question,
      status: ask.status,
      latency_ms: ask.latencyMs,
      pass: evalResult.pass,
      score: evalResult.score,
      failures: evalResult.failures,
      warnings: evalResult.warnings,
      details: evalResult.details,
      response_text: text,
      debug: (ask.payload.debug ?? {}) as AskDebug,
    });
  }

  const summary = buildSummary(runId, BENCHMARK_PATH, benchmark.version, results);
  const report = renderReport(summary, results);

  const summaryPath = path.join(outDir, "summary.json");
  const resultsPath = path.join(outDir, "results.json");
  const reportPath = path.join(outDir, "report.md");
  await Promise.all([
    fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8"),
    fs.writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`, "utf8"),
    fs.writeFile(reportPath, `${report}\n`, "utf8"),
  ]);
  await fs.copyFile(summaryPath, path.resolve(OUT_ROOT, "summary-latest.json"));
  await fs.copyFile(resultsPath, path.resolve(OUT_ROOT, "results-latest.json"));
  await fs.writeFile(path.resolve(REPORT_PATH), `${report}\n`, "utf8");

  process.stdout.write(
    JSON.stringify(
      {
        ok: !STRICT || summary.fail === 0,
        run_id: runId,
        out_dir: outDir,
        summary_path: summaryPath,
        report_path: reportPath,
        pass_rate: summary.pass_rate,
        avg_score: summary.avg_score,
        failures: summary.failure_histogram,
      },
      null,
      2,
    ) + "\n",
  );

  if (STRICT && summary.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`helix-ask-equation-benchmark failed: ${message}\n`);
  process.exitCode = 1;
});
