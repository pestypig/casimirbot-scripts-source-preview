import fs from "node:fs/promises";
import path from "node:path";
import { precheckHelixAskAvailability } from "./helix-ask-availability-precheck";
import {
  evaluateEquationBenchmarkCase,
  type EquationBenchmarkCase,
  type EquationBenchmarkCaseFile,
} from "./lib/helix-ask-equation-benchmark";
import {
  recommendEquationBenchmarkProfile,
  type EquationBenchmarkMatrixSummary,
} from "./lib/helix-ask-equation-benchmark-matrix";

type AskDebug = Record<string, unknown>;
type AskResponse = {
  text?: string;
  answer?: string;
  debug?: AskDebug;
  error?: string;
  message?: string;
};

type MatrixProfile = {
  name: string;
  temperature?: number;
  verbosity?: "brief" | "normal" | "extended";
  topK?: number;
  max_tokens?: number;
  tuning?: Record<string, unknown>;
};

type MatrixFile = {
  version: string;
  description?: string;
  baseline?: string;
  profiles: MatrixProfile[];
};

type MatrixCaseResult = {
  profile: string;
  id: string;
  label: string;
  status: number;
  latency_ms: number;
  pass: boolean;
  score: number;
  failures: string[];
  response_text: string;
  debug: AskDebug;
};

type MatrixOutput = {
  run_id: string;
  generated_at: string;
  base_url: string;
  ask_url: string;
  benchmark_file: string;
  matrix_file: string;
  summaries: EquationBenchmarkMatrixSummary[];
  recommendation:
    | ReturnType<typeof recommendEquationBenchmarkProfile>
    | null;
  results: MatrixCaseResult[];
};

const BASE_URL = process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:5050";
const ASK_URL = new URL("/api/agi/ask", BASE_URL).toString();
const BENCHMARK_PATH =
  process.env.HELIX_ASK_EQUATION_BENCHMARK_FILE ?? "scripts/helix-ask-equation-benchmark.json";
const MATRIX_PATH =
  process.env.HELIX_ASK_EQUATION_BENCHMARK_MATRIX_FILE ??
  "scripts/helix-ask-equation-benchmark-matrix.json";
const OUT_ROOT =
  process.env.HELIX_ASK_EQUATION_BENCHMARK_MATRIX_OUT_DIR ??
  "artifacts/experiments/helix-ask-equation-benchmark-matrix";
const REPORT_PATH =
  process.env.HELIX_ASK_EQUATION_BENCHMARK_MATRIX_REPORT_PATH ??
  "reports/helix-ask-equation-benchmark-matrix-latest.md";
const REQUEST_TIMEOUT_MS = Number(
  process.env.HELIX_ASK_EQUATION_BENCHMARK_MATRIX_TIMEOUT_MS ?? 60000,
);
const PRECHECK_TIMEOUT_MS = Number(
  process.env.HELIX_ASK_EQUATION_BENCHMARK_MATRIX_PRECHECK_TIMEOUT_MS ??
    Math.min(REQUEST_TIMEOUT_MS, 15000),
);
const DRY_RUN = process.env.HELIX_ASK_EQUATION_BENCHMARK_DRY_RUN === "1";
const STRICT = process.env.HELIX_ASK_EQUATION_BENCHMARK_MATRIX_STRICT === "1";

const nowId = (): string => new Date().toISOString().replace(/[:.]/g, "-");

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

const readJson = async <T>(filePath: string): Promise<T> => {
  const raw = await fs.readFile(path.resolve(filePath), "utf8");
  return JSON.parse(raw) as T;
};

const runAsk = async (
  question: string,
  sessionId: string,
  profile: MatrixProfile,
): Promise<{ status: number; latencyMs: number; payload: AskResponse }> => {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = {
      question,
      debug: true,
      sessionId,
      temperature: typeof profile.temperature === "number" ? profile.temperature : 0.2,
      verbosity: profile.verbosity ?? "extended",
    };
    if (typeof profile.max_tokens === "number") body.max_tokens = profile.max_tokens;
    if (typeof profile.topK === "number") body.topK = profile.topK;
    if (profile.tuning) body.tuning = profile.tuning;

    const response = await fetch(ASK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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
    return { status: 0, latencyMs: Date.now() - started, payload: { text: "", error: message } };
  } finally {
    clearTimeout(timer);
  }
};

const ensureDir = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true });
};

const summarizeProfile = (profileName: string, rows: MatrixCaseResult[]): EquationBenchmarkMatrixSummary => {
  const total = rows.length;
  const pass = rows.filter((entry) => entry.pass).length;
  const fail = total - pass;
  const scores = rows.map((entry) => entry.score);
  const latencies = rows.map((entry) => entry.latency_ms);
  return {
    name: profileName,
    total,
    pass,
    fail,
    passRate: total > 0 ? Number((pass / total).toFixed(4)) : 0,
    avgScore:
      total > 0
        ? Number((scores.reduce((sum, value) => sum + value, 0) / total).toFixed(2))
        : 0,
    p95LatencyMs: Number(quantile(latencies, 0.95).toFixed(2)),
    failureCount: rows.reduce((sum, entry) => sum + entry.failures.length, 0),
  };
};

const renderReport = (output: MatrixOutput): string => {
  const lines: string[] = [];
  lines.push("# Helix Ask Equation Benchmark Matrix");
  lines.push("");
  lines.push(`- run_id: \`${output.run_id}\``);
  lines.push(`- benchmark_file: \`${output.benchmark_file}\``);
  lines.push(`- matrix_file: \`${output.matrix_file}\``);
  lines.push("");
  lines.push("## Profiles");
  lines.push("");
  for (const summary of output.summaries) {
    lines.push(
      `- \`${summary.name}\`: pass_rate=${summary.passRate}, avg_score=${summary.avgScore}, p95_latency_ms=${summary.p95LatencyMs}, failures=${summary.failureCount}`,
    );
  }
  if (output.recommendation) {
    lines.push("");
    lines.push("## Recommendation");
    lines.push("");
    lines.push(`- best_profile: \`${output.recommendation.best.name}\``);
    if (output.recommendation.baseline && output.recommendation.deltasFromBaseline) {
      const d = output.recommendation.deltasFromBaseline;
      lines.push(`- baseline_profile: \`${output.recommendation.baseline.name}\``);
      lines.push(`- delta_pass_rate: \`${d.passRateDelta}\``);
      lines.push(`- delta_avg_score: \`${d.avgScoreDelta}\``);
      lines.push(`- delta_p95_latency_ms: \`${d.p95LatencyDeltaMs}\``);
      lines.push(`- delta_failure_count: \`${d.failureCountDelta}\``);
    }
  }
  return lines.join("\n");
};

async function main(): Promise<void> {
  const runId = nowId();
  const benchmark = await readJson<EquationBenchmarkCaseFile>(BENCHMARK_PATH);
  const matrix = await readJson<MatrixFile>(MATRIX_PATH);
  if (!Array.isArray(matrix.profiles) || matrix.profiles.length === 0) {
    throw new Error(`invalid_matrix_file:${MATRIX_PATH}`);
  }
  if (!Array.isArray(benchmark.cases) || benchmark.cases.length === 0) {
    throw new Error(`invalid_benchmark_file:${BENCHMARK_PATH}`);
  }

  const outDir = path.resolve(OUT_ROOT, runId);
  await ensureDir(outDir);

  if (!DRY_RUN) {
    await precheckHelixAskAvailability({
      baseUrl: BASE_URL,
      timeoutMs: PRECHECK_TIMEOUT_MS,
      label: "equation_benchmark_matrix_precheck",
    });
  }

  const allResults: MatrixCaseResult[] = [];
  for (const profile of matrix.profiles) {
    for (const testCase of benchmark.cases as EquationBenchmarkCase[]) {
      if (DRY_RUN) {
        allResults.push({
          profile: profile.name,
          id: testCase.id,
          label: testCase.label,
          status: 0,
          latency_ms: 0,
          pass: true,
          score: 0,
          failures: [],
          response_text: "",
          debug: { dry_run: true },
        });
        continue;
      }
      const sessionId = `helix-equation-matrix-${runId}-${profile.name}-${testCase.id}`;
      const ask = await runAsk(testCase.question, sessionId, profile);
      const text = String(ask.payload.text ?? ask.payload.answer ?? "");
      const evalResult = evaluateEquationBenchmarkCase(text, testCase.expect);
      allResults.push({
        profile: profile.name,
        id: testCase.id,
        label: testCase.label,
        status: ask.status,
        latency_ms: ask.latencyMs,
        pass: evalResult.pass,
        score: evalResult.score,
        failures: evalResult.failures,
        response_text: text,
        debug: (ask.payload.debug ?? {}) as AskDebug,
      });
    }
  }

  const summaries = matrix.profiles.map((profile) =>
    summarizeProfile(
      profile.name,
      allResults.filter((entry) => entry.profile === profile.name),
    ),
  );
  const recommendation = recommendEquationBenchmarkProfile({
    summaries,
    baselineName: matrix.baseline ?? "baseline",
  });

  const output: MatrixOutput = {
    run_id: runId,
    generated_at: new Date().toISOString(),
    base_url: BASE_URL,
    ask_url: ASK_URL,
    benchmark_file: BENCHMARK_PATH,
    matrix_file: MATRIX_PATH,
    summaries,
    recommendation,
    results: allResults,
  };

  const summaryPath = path.join(outDir, "summary.json");
  const resultsPath = path.join(outDir, "results.json");
  const reportPath = path.join(outDir, "report.md");
  const reportText = renderReport(output);

  await Promise.all([
    fs.writeFile(summaryPath, `${JSON.stringify(output, null, 2)}\n`, "utf8"),
    fs.writeFile(resultsPath, `${JSON.stringify(allResults, null, 2)}\n`, "utf8"),
    fs.writeFile(reportPath, `${reportText}\n`, "utf8"),
  ]);
  await fs.copyFile(summaryPath, path.resolve(OUT_ROOT, "summary-latest.json"));
  await fs.copyFile(resultsPath, path.resolve(OUT_ROOT, "results-latest.json"));
  await fs.writeFile(path.resolve(REPORT_PATH), `${reportText}\n`, "utf8");

  const best = recommendation?.best?.name ?? null;
  process.stdout.write(
    JSON.stringify(
      {
        ok: !STRICT || summaries.every((entry) => entry.fail === 0),
        run_id: runId,
        out_dir: outDir,
        best_profile: best,
        summaries: summaries.map((entry) => ({
          name: entry.name,
          pass_rate: entry.passRate,
          avg_score: entry.avgScore,
          p95_latency_ms: entry.p95LatencyMs,
          failure_count: entry.failureCount,
        })),
      },
      null,
      2,
    ) + "\n",
  );

  if (STRICT && summaries.some((entry) => entry.fail > 0)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`helix-ask-equation-benchmark-matrix failed: ${message}\n`);
  process.exitCode = 1;
});
