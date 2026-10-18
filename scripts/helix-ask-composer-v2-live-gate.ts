type LiveGateSample = {
  question: string;
  ok: boolean;
  statusCode?: number;
  requestError?: string;
  fallbackReason: string | null;
  llmErrorCode: string | null;
  bestStage: string | null;
  handoffBlocks: number;
  handoffChars: number;
  handoffTruncated: boolean;
  preLinkFailReasons: string[];
  postLinkFailReasons: string[];
  stage05Cards: number | null;
  stage05TotalMs: number | null;
};

type LiveGateSummary = {
  total: number;
  successCount: number;
  requestErrorCount: number;
  handoffSurvivalCount: number;
  handoffSurvivalRate: number;
  projectionCount: number;
  projectionRate: number;
  expandModelErrorCount: number;
  expandModelErrorRate: number;
  llmUnavailableCount: number;
  llmUnavailableRate: number;
  llm429Count: number;
  llm429Rate: number;
};

type LiveGateThresholds = {
  minHandoffSurvivalRate: number;
  maxProjectionRate: number;
  maxExpandModelErrorRate: number;
  maxLlmUnavailableRate: number;
  maxLlm429Rate: number;
};

const DEFAULT_PROMPTS = [
  "How do we solve for the warp bubble in the code base. Like Needle Hull Mark 2?",
  "What is a warp bubble and how is it solved in the codebase?",
  "Explain warp bubble mechanism in this repo with code path and constraints.",
  "Define warp bubble in this repository and why it matters.",
  "How is the warp bubble runtime orchestrated across modules?",
];

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const parseNumberFlag = (args: string[], flag: string, fallback: number): number => {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const raw = args[index + 1];
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

const parseStringFlag = (args: string[], flag: string, fallback: string): string => {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const raw = args[index + 1];
  if (!raw || raw.startsWith("--")) return fallback;
  return raw;
};

const parsePromptList = (args: string[]): string[] => {
  const index = args.indexOf("--prompts");
  if (index < 0) return DEFAULT_PROMPTS;
  const raw = args[index + 1];
  if (!raw || raw.startsWith("--")) return DEFAULT_PROMPTS;
  const prompts = raw
    .split("||")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return prompts.length > 0 ? prompts : DEFAULT_PROMPTS;
};

const readStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
};

const readNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const readOptionalNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const run = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const url = parseStringFlag(args, "--url", "http://127.0.0.1:5050/api/agi/ask");
  const timeoutMs = Math.max(5_000, parseNumberFlag(args, "--timeout-ms", 120_000));
  const thresholds: LiveGateThresholds = {
    minHandoffSurvivalRate: clamp01(parseNumberFlag(args, "--min-handoff-survival-rate", 0.9)),
    maxProjectionRate: clamp01(parseNumberFlag(args, "--max-projection-rate", 0.5)),
    maxExpandModelErrorRate: clamp01(parseNumberFlag(args, "--max-expand-model-error-rate", 0.25)),
    maxLlmUnavailableRate: clamp01(parseNumberFlag(args, "--max-llm-unavailable-rate", 0.25)),
    maxLlm429Rate: clamp01(parseNumberFlag(args, "--max-llm-429-rate", 0.05)),
  };
  const prompts = parsePromptList(args);
  const samples: LiveGateSample[] = [];

  for (const question of prompts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question,
          debug: true,
          includeReasoning: true,
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      const debug =
        payload && typeof payload === "object" && payload.debug && typeof payload.debug === "object"
          ? (payload.debug as Record<string, unknown>)
          : null;
      if (!response.ok || !debug) {
        samples.push({
          question,
          ok: false,
          statusCode: response.status,
          requestError: `http_${response.status}`,
          fallbackReason: null,
          llmErrorCode: null,
          bestStage: null,
          handoffBlocks: 0,
          handoffChars: 0,
          handoffTruncated: true,
          preLinkFailReasons: [],
          postLinkFailReasons: [],
          stage05Cards: null,
          stage05TotalMs: null,
        });
        continue;
      }
      const preLinkFailReasons = readStringArray(debug.composer_v2_pre_link_fail_reasons);
      const postLinkFailReasons = readStringArray(debug.composer_v2_post_link_fail_reasons);
      samples.push({
        question,
        ok: true,
        fallbackReason: readString(debug.fallback_reason),
        llmErrorCode: readString(debug.llm_error_code),
        bestStage: readString(debug.composer_v2_best_attempt_stage),
        handoffBlocks: Math.max(0, Math.floor(readNumber(debug.composer_v2_handoff_block_count))),
        handoffChars: Math.max(0, Math.floor(readNumber(debug.composer_v2_handoff_chars))),
        handoffTruncated: Boolean(debug.composer_v2_handoff_truncated),
        preLinkFailReasons,
        postLinkFailReasons,
        stage05Cards: readOptionalNumber(debug.stage05_card_count),
        stage05TotalMs: readOptionalNumber(debug.stage05_total_ms),
      });
    } catch (error) {
      samples.push({
        question,
        ok: false,
        requestError: error instanceof Error ? error.message : String(error),
        fallbackReason: null,
        llmErrorCode: null,
        bestStage: null,
        handoffBlocks: 0,
        handoffChars: 0,
        handoffTruncated: true,
        preLinkFailReasons: [],
        postLinkFailReasons: [],
        stage05Cards: null,
        stage05TotalMs: null,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const total = samples.length;
  const successCount = samples.filter((sample) => sample.ok).length;
  const requestErrorCount = total - successCount;
  const handoffSurvivalCount = samples.filter(
    (sample) => sample.ok && sample.handoffBlocks >= 2 && !sample.handoffTruncated,
  ).length;
  const projectionCount = samples.filter((sample) => sample.bestStage === "projection").length;
  const expandModelErrorCount = samples.filter((sample) =>
    sample.preLinkFailReasons.includes("expand_model_error"),
  ).length;
  const llmUnavailableCount = samples.filter((sample) =>
    sample.llmErrorCode === "llm_http_429" || sample.llmErrorCode === "llm_http_circuit_open",
  ).length;
  const llm429Count = samples.filter((sample) => sample.llmErrorCode === "llm_http_429").length;
  const summary: LiveGateSummary = {
    total,
    successCount,
    requestErrorCount,
    handoffSurvivalCount,
    handoffSurvivalRate: total > 0 ? handoffSurvivalCount / total : 0,
    projectionCount,
    projectionRate: total > 0 ? projectionCount / total : 0,
    expandModelErrorCount,
    expandModelErrorRate: total > 0 ? expandModelErrorCount / total : 0,
    llmUnavailableCount,
    llmUnavailableRate: total > 0 ? llmUnavailableCount / total : 0,
    llm429Count,
    llm429Rate: total > 0 ? llm429Count / total : 0,
  };

  const failures: string[] = [];
  if (summary.handoffSurvivalRate < thresholds.minHandoffSurvivalRate) {
    failures.push(
      `handoff_survival_rate ${summary.handoffSurvivalRate.toFixed(3)} < ${thresholds.minHandoffSurvivalRate.toFixed(3)}`,
    );
  }
  if (summary.projectionRate > thresholds.maxProjectionRate) {
    failures.push(
      `projection_rate ${summary.projectionRate.toFixed(3)} > ${thresholds.maxProjectionRate.toFixed(3)}`,
    );
  }
  if (summary.expandModelErrorRate > thresholds.maxExpandModelErrorRate) {
    failures.push(
      `expand_model_error_rate ${summary.expandModelErrorRate.toFixed(3)} > ${thresholds.maxExpandModelErrorRate.toFixed(3)}`,
    );
  }
  if (summary.llmUnavailableRate > thresholds.maxLlmUnavailableRate) {
    failures.push(
      `llm_unavailable_rate ${summary.llmUnavailableRate.toFixed(3)} > ${thresholds.maxLlmUnavailableRate.toFixed(3)}`,
    );
  }
  if (summary.llm429Rate > thresholds.maxLlm429Rate) {
    failures.push(`llm_429_rate ${summary.llm429Rate.toFixed(3)} > ${thresholds.maxLlm429Rate.toFixed(3)}`);
  }

  const report = {
    url,
    timeoutMs,
    thresholds,
    summary,
    samples,
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    process.exitCode = 1;
  }
};

run().catch((error) => {
  console.error(
    JSON.stringify(
      {
        verdict: "ERROR",
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
