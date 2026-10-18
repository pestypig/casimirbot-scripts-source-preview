import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type CitationsPolicy = "require" | "forbid" | "optional";

type SweepExpectation = {
  intent_id?: string;
  intent_domain?: string;
  format?: string;
  citations?: CitationsPolicy;
  must_include?: string[];
  allow_clarify?: boolean;
};

type SweepCase = {
  label: string;
  question: string;
  expect?: SweepExpectation;
};

type SweepPack = {
  cases: SweepCase[];
};

type SweepConfig = {
  name: string;
  tuning?: Record<string, unknown>;
  topK?: number;
  temperature?: number;
  max_tokens?: number;
  verbosity?: "brief" | "normal" | "extended";
};

type HelixAskDebug = {
  intent_id?: string;
  intent_domain?: string;
  format?: string;
  evidence_gate_ok?: boolean;
  coverage_ratio?: number;
  coverage_gate_applied?: boolean;
  belief_gate_applied?: boolean;
  rattling_gate_applied?: boolean;
  belief_unsupported_rate?: number;
  evidence_claim_gate_ok?: boolean;
  evidence_claim_unsupported?: number;
  evidence_claim_missing?: string[];
  retrieval_confidence?: number;
  retrieval_doc_share?: number;
  overflow_retry_applied?: boolean;
  answer_raw_text?: string;
  answer_short_tokens?: number;
  answer_short_sentences?: number;
  preflight_evidence_ratio?: number;
  preflight_slot_coverage_ratio?: number;
  preflight_doc_hit_count?: number;
  claim_unsupported_count?: number;
  claim_supported_count?: number;
  micro_pass?: boolean;
  micro_pass_auto?: boolean;
  micro_pass_reason?: string;
  arbiter_mode?: "repo_grounded" | "hybrid" | "general" | "clarify";
  arbiter_strictness?: "low" | "med" | "high";
  stage_tags?: boolean;
  context_files?: string[];
  context_files_count?: number;
  stage0_used?: boolean;
  stage0_canary_hit?: boolean;
  stage0_policy_decision?: string | null;
  stage0_fail_open_reason?: string | null;
  stage0_fallback_reason?: string | null;
  open_world_bypass_mode?: "off" | "active";
  alignment_gate_decision?: "PASS" | "BORDERLINE" | "FAIL";
  alignment_gate_metrics?: {
    alignment_real?: number;
    alignment_decoy?: number;
    coincidence_margin?: number;
    stability_3_rewrites?: number;
    contradiction_rate?: number;
    lower95_p_align?: number;
  };
};

type CaseQuality = {
  evidence_gate_ok?: boolean;
  coverage_ratio?: number;
  belief_unsupported_rate?: number;
  belief_gate_applied?: boolean;
  rattling_gate_applied?: boolean;
  evidence_claim_gate_ok?: boolean;
  evidence_claim_unsupported?: number;
  retrieval_confidence?: number;
  retrieval_doc_share?: number;
  micro_pass?: boolean;
  micro_pass_auto?: boolean;
  overflow_retry_applied?: boolean;
};

type AskResponse = {
  text?: string;
  debug?: HelixAskDebug;
  duration_ms?: number;
};

type CaseResult = {
  label: string;
  ok: boolean;
  clarify: boolean;
  duration_ms?: number;
  hard_failures: string[];
  decorative_citations: string[];
  prompt_leak: boolean;
  cited_paths: string[];
  context_paths: string[];
  answer_length: number;
  quality_score: number;
  quality_signals: CaseQuality;
  citation_missing: boolean;
  runtime_fallback_answer: boolean;
  stage0_eligible: boolean;
  stage0_used_active: boolean;
  stage0_fail_open_reason: string | null;
  stage0_policy_decision: string | null;
  stage0_technical_fail_open: boolean;
  debug?: HelixAskDebug;
};

type SweepSummary = {
  config: string;
  total: number;
  ok: number;
  hard_fail: number;
  clarify_rate: number;
  prompt_leak_rate: number;
  decorative_citation_rate: number;
  avg_duration_ms?: number;
  p50_duration_ms?: number;
  p95_duration_ms?: number;
  avg_quality_score: number;
  quality_rate: number;
};

export type Stage0SweepGateMetrics = {
  citation_missing: number;
  runtime_fallback_answer: number;
  eligible_turn_count: number;
  stage0_active_used_count: number;
  stage0_active_usage_rate: number;
  stage0_technical_fail_open_count: number;
  stage0_technical_fail_open_rate: number;
  fail_open_reason_histogram: Record<string, number>;
  policy_decision_histogram: Record<string, number>;
};

export type Stage0SweepPromotionGate = {
  baseline_config: string;
  candidate_config: string;
  baseline: Stage0SweepGateMetrics;
  candidate: Stage0SweepGateMetrics;
  verdict: "pass" | "fail";
  failing_rules: string[];
};

type QualityBaselineThresholds = {
  min_ok_rate: number;
  max_clarify_rate: number;
  max_prompt_leak_rate: number;
  max_decorative_citation_rate: number;
  min_avg_quality_score: number;
  min_quality_rate: number;
};

type QualityBaselineEvaluation = {
  ok_rate: number;
  status: "pass" | "fail";
  failing_thresholds: string[];
};

export type QualityBaselineContract = {
  schema_version: "helix_ask_quality_baseline_contract/1";
  generated_at: string;
  source_report: string;
  config: string;
  summary: SweepSummary;
  thresholds: QualityBaselineThresholds;
  evaluation: QualityBaselineEvaluation;
};

const BASE_URL =
  process.env.HELIX_ASK_BASE_URL ??
  process.env.EVAL_BASE_URL ??
  "http://localhost:5050";

const ASK_URL = new URL("/api/agi/ask", BASE_URL).toString();
const REQUEST_TIMEOUT_MS = Number(process.env.HELIX_ASK_SWEEP_TIMEOUT_MS ?? 120000);
const PACK_PATH = process.env.HELIX_ASK_SWEEP_PACK ?? "scripts/helix-ask-sweep-pack.json";
const MATRIX_PATH = process.env.HELIX_ASK_SWEEP_MATRIX;
const OUTPUT_DIR = process.env.HELIX_ASK_SWEEP_OUT_DIR ?? "artifacts";
const STAGE0_GATE_ENABLED = String(process.env.HELIX_ASK_SWEEP_STAGE0_GATE ?? "0").trim() !== "0";
const STAGE0_GATE_BASELINE_CONFIG = process.env.HELIX_ASK_SWEEP_GATE_BASELINE_CONFIG?.trim() || null;
const STAGE0_GATE_CANDIDATE_CONFIG = process.env.HELIX_ASK_SWEEP_GATE_CANDIDATE_CONFIG?.trim() || null;
const STAGE0_GATE_BASELINE_ARTIFACT = process.env.HELIX_ASK_SWEEP_GATE_BASELINE_ARTIFACT?.trim() || null;
const STAGE0_ROLLOUT_ACTION_OUT_PATH = process.env.HELIX_ASK_SWEEP_ROLLOUT_ACTION_PATH?.trim() || null;
const QUALITY_BASELINE_OUT_PATH =
  process.env.HELIX_ASK_QUALITY_BASELINE_OUT_PATH ??
  path.join("docs", "audits", "helix-ask-quality", "baseline-contract.json");

const DEFAULT_BASELINE_THRESHOLDS: QualityBaselineThresholds = {
  min_ok_rate: 0.8,
  max_clarify_rate: 0.35,
  max_prompt_leak_rate: 0,
  max_decorative_citation_rate: 0.1,
  min_avg_quality_score: 0.7,
  min_quality_rate: 0.6,
};

const DEFAULT_MATRIX: SweepConfig[] = [
  {
    name: "baseline",
  },
];

const FILE_PATH_PATTERN =
  /\b[a-zA-Z0-9_\-./]+?\.(?:ts|tsx|js|mjs|cjs|md|json|html|yml|yaml)\b/g;

const PROMPT_LEAK_PATTERNS: RegExp[] = [
  /\buse only the\b/i,
  /\bdo not add\b/i,
  /\bquestion:\b/i,
  /\bcontext sources\b/i,
  /\bevidence (?:bullets|steps)\b/i,
  /\brespond with only the answer\b/i,
];
const SOURCES_RE = /\bSources?:\s+/i;
const RUNTIME_FALLBACK_RE = /\bruntime fallback\b/i;
const STAGE0_HARD_BYPASS_REASONS = new Set(["explicit_repo_query", "explicit_path_query"]);
const STAGE0_TECH_FAIL_OPEN_TOKENS = [
  "index_stale",
  "index_commit_mismatch",
  "index_unavailable",
  "index_version_mismatch",
  "index_build",
  "index_refresh",
  "git_tracked_scan_",
  "rg_failed",
  "rg_not_found",
  "runtime_",
  "scan_",
];

const clamp01 = (value: number | undefined, fallback = 0): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
};

const quantile = (values: number[], ratio: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clampedRatio = clamp01(ratio);
  const index = clampedRatio * (sorted.length - 1);
  const floor = Math.floor(index);
  const ceil = Math.ceil(index);
  if (floor === ceil) return sorted[floor] ?? 0;
  const weight = index - floor;
  const lower = sorted[floor] ?? 0;
  const upper = sorted[ceil] ?? 0;
  return lower + (upper - lower) * weight;
};

const toFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
};

const toBoolean = (value: unknown): boolean | undefined => {
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
};

const extractFilePaths = (text: string): string[] => {
  if (!text) return [];
  const matches = text.match(FILE_PATH_PATTERN) ?? [];
  const unique = new Set<string>();
  for (const match of matches) {
    if (!match) continue;
    unique.add(match.trim());
  }
  return Array.from(unique);
};

const hasPromptLeak = (text: string): boolean =>
  PROMPT_LEAK_PATTERNS.some((pattern) => pattern.test(text));

const hasCitationSignal = (text: string, citedPaths: string[]): boolean =>
  citedPaths.length > 0 || SOURCES_RE.test(text) || /docs\//i.test(text) || /server\//i.test(text);

const toHistogramKey = (value: string | null | undefined): string =>
  value && value.trim().length > 0 ? value.trim() : "none";

const incrementHistogram = (histogram: Record<string, number>, value: string | null | undefined): void => {
  const key = toHistogramKey(value);
  histogram[key] = (histogram[key] ?? 0) + 1;
};

const isStage0TechnicalFailOpenReason = (reason: string | null | undefined): boolean => {
  const normalized = String(reason ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return STAGE0_TECH_FAIL_OPEN_TOKENS.some((token) => normalized.includes(token));
};

const isStage0EligibleTurn = (debug: HelixAskDebug | undefined): boolean => {
  const domain = String(debug?.intent_domain ?? "")
    .trim()
    .toLowerCase();
  if (domain !== "repo" && domain !== "hybrid") return false;
  if (debug?.stage0_canary_hit !== true) return false;
  const policy = String(debug?.stage0_policy_decision ?? "")
    .trim()
    .toLowerCase();
  const failOpen = String(debug?.stage0_fail_open_reason ?? debug?.stage0_fallback_reason ?? "")
    .trim()
    .toLowerCase();
  if (STAGE0_HARD_BYPASS_REASONS.has(policy) || STAGE0_HARD_BYPASS_REASONS.has(failOpen)) return false;
  return true;
};

const readJsonFile = async <T>(filePath: string): Promise<T> => {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content) as T;
};

const resolveSweepMatrix = async (): Promise<SweepConfig[]> => {
  if (!MATRIX_PATH) return DEFAULT_MATRIX;
  const fullPath = path.resolve(MATRIX_PATH);
  const matrix = await readJsonFile<SweepConfig[]>(fullPath);
  return Array.isArray(matrix) && matrix.length ? matrix : DEFAULT_MATRIX;
};

const buildRequestBody = (entry: SweepCase, config: SweepConfig, sessionId: string) => {
  const body: Record<string, unknown> = {
    question: entry.question,
    debug: true,
    sessionId,
  };
  if (typeof config.max_tokens === "number") body.max_tokens = config.max_tokens;
  if (typeof config.temperature === "number") body.temperature = config.temperature;
  if (typeof config.topK === "number") body.topK = config.topK;
  if (config.verbosity) body.verbosity = config.verbosity;
  if (config.tuning) body.tuning = config.tuning;
  return body;
};

const fetchCase = async (entry: SweepCase, config: SweepConfig, sessionId: string) => {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(ASK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRequestBody(entry, config, sessionId)),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      const text = await response.text();
      return {
        ok: false,
        duration_ms: Date.now() - startedAt,
        error: `request failed (${response.status})${text ? `: ${text.slice(0, 240)}` : ""}`,
      };
    }
    const payload = (await response.json()) as AskResponse;
    return {
      ok: true,
      duration_ms: Date.now() - startedAt,
      payload,
    };
  } catch (error) {
    clearTimeout(timeout);
    const message =
      (error as { message?: string })?.message ?? (error ? String(error) : "fetch_failed");
    return { ok: false, duration_ms: Date.now() - startedAt, error: message };
  }
};

const buildQualitySignals = (debug: HelixAskDebug | undefined): CaseQuality => ({
  evidence_gate_ok: toBoolean(debug?.evidence_gate_ok),
  coverage_ratio: toFiniteNumber(debug?.coverage_ratio),
  belief_unsupported_rate: toFiniteNumber(debug?.belief_unsupported_rate),
  belief_gate_applied: toBoolean(debug?.belief_gate_applied),
  rattling_gate_applied: toBoolean(debug?.rattling_gate_applied),
  evidence_claim_gate_ok: toBoolean(debug?.evidence_claim_gate_ok),
  evidence_claim_unsupported: toFiniteNumber(debug?.evidence_claim_unsupported),
  retrieval_confidence: toFiniteNumber(debug?.retrieval_confidence),
  retrieval_doc_share: toFiniteNumber(debug?.retrieval_doc_share),
  micro_pass: toBoolean(debug?.micro_pass),
  micro_pass_auto: toBoolean(debug?.micro_pass_auto),
  overflow_retry_applied: toBoolean(debug?.overflow_retry_applied),
});

const computeQualityScore = (
  answerText: string,
  hardFailures: string[],
  qualitySignals: CaseQuality,
): number => {
  let score = 0;
  if (hardFailures.length === 0) {
    score += 0.35;
  }
  if (qualitySignals.evidence_gate_ok === true) {
    score += 0.25;
  } else if (qualitySignals.evidence_gate_ok === false) {
    score += 0;
  } else {
    score += 0.1;
  }

  const coverageRatio = qualitySignals.coverage_ratio;
  score += coverageRatio !== undefined ? clamp01(coverageRatio, 0) * 0.2 : 0.08;

  const claimSupport = qualitySignals.evidence_claim_gate_ok;
  if (claimSupport === true) score += 0.1;
  if (claimSupport === false) score -= 0.05;

  const beliefRate = qualitySignals.belief_unsupported_rate;
  if (beliefRate !== undefined) {
    score += (1 - clamp01(beliefRate, 0.25)) * 0.1;
  } else {
    score += 0.05;
  }

  const overflowPenalty = qualitySignals.overflow_retry_applied === true ? 0.02 : 0;
  score -= overflowPenalty;

  if (answerText.trim().length < 80) {
    score -= 0.02;
  }

  if (hardFailures.length > 0) {
    score -= 0.1 * hardFailures.length;
  }

  return Number(clamp01(score, 0).toFixed(3));
};

const evaluateCase = (
  entry: SweepCase,
  payload: AskResponse,
  durationMs?: number,
): CaseResult => {
  const answerText = payload.text ?? "";
  const debug = payload.debug;
  const citedPaths = extractFilePaths(answerText);
  const hasCitation = hasCitationSignal(answerText, citedPaths);
  const contextPaths = debug?.context_files ?? [];
  const contextSet = new Set(contextPaths);
  const decorative = citedPaths.filter((path) => !contextSet.has(path));
  const clarify =
    debug?.arbiter_mode === "clarify" ||
    /please point to the relevant files|narrow the request/i.test(answerText);
  const runtimeFallbackAnswer = RUNTIME_FALLBACK_RE.test(answerText);
  const stage0Eligible = isStage0EligibleTurn(debug);
  const stage0UsedActive = stage0Eligible && debug?.stage0_used === true;
  const stage0FailOpenReason = (debug?.stage0_fail_open_reason ?? debug?.stage0_fallback_reason ?? null) || null;
  const stage0PolicyDecision = (debug?.stage0_policy_decision ?? null) || null;
  const stage0TechnicalFailOpen = stage0Eligible && isStage0TechnicalFailOpenReason(stage0FailOpenReason);

  const hardFailures: string[] = [];
  const expect = entry.expect ?? {};
  const allowClarify = expect.allow_clarify === true;

  const checkExpectation = (
    ok: boolean,
    message: string,
  ) => {
    if (!ok && !(allowClarify && clarify)) {
      hardFailures.push(message);
    }
  };

  if (expect.intent_id) {
    checkExpectation(
      debug?.intent_id === expect.intent_id,
      `intent_id ${debug?.intent_id ?? "missing"} !== ${expect.intent_id}`,
    );
  }
  if (expect.intent_domain) {
    checkExpectation(
      debug?.intent_domain === expect.intent_domain,
      `intent_domain ${debug?.intent_domain ?? "missing"} !== ${expect.intent_domain}`,
    );
  }
  if (expect.format) {
    checkExpectation(
      debug?.format === expect.format,
      `format ${debug?.format ?? "missing"} !== ${expect.format}`,
    );
  }

  const citationsPolicy = expect.citations ?? "optional";
  const citationMissing = citationsPolicy === "require" && !hasCitation;
  if (citationsPolicy === "require") {
    checkExpectation(hasCitation, "missing citations");
  } else if (citationsPolicy === "forbid") {
    checkExpectation(!hasCitation, "unexpected citations");
  }

  if (expect.must_include?.length) {
    const missing = expect.must_include.filter(
      (value) =>
        !contextSet.has(value) &&
        !answerText.includes(value),
    );
    checkExpectation(missing.length === 0, `missing must_include: ${missing.join(", ")}`);
  }

  if (decorative.length > 0) {
    checkExpectation(false, `decorative citations: ${decorative.join(", ")}`);
  }

  const promptLeak = hasPromptLeak(answerText);
  if (promptLeak) {
    checkExpectation(false, "prompt leakage");
  }

  const qualitySignals = buildQualitySignals(debug);
  const qualityScore = computeQualityScore(answerText, hardFailures, qualitySignals);

  return {
    label: entry.label,
    ok: hardFailures.length === 0,
    clarify,
    duration_ms: durationMs,
    hard_failures: hardFailures,
    decorative_citations: decorative,
    prompt_leak: promptLeak,
    cited_paths: citedPaths,
    context_paths: contextPaths,
    answer_length: answerText.length,
    quality_score: qualityScore,
    quality_signals: qualitySignals,
    citation_missing: citationMissing,
    runtime_fallback_answer: runtimeFallbackAnswer,
    stage0_eligible: stage0Eligible,
    stage0_used_active: stage0UsedActive,
    stage0_fail_open_reason: stage0FailOpenReason,
    stage0_policy_decision: stage0PolicyDecision,
    stage0_technical_fail_open: stage0TechnicalFailOpen,
    debug,
  };
};

const summarize = (configName: string, results: CaseResult[]): SweepSummary => {
  const total = results.length;
  const ok = results.filter((entry) => entry.ok).length;
  const hardFail = total - ok;
  const clarifyCount = results.filter((entry) => entry.clarify).length;
  const promptLeakCount = results.filter((entry) => entry.prompt_leak).length;
  const decorativeCount = results.filter((entry) => entry.decorative_citations.length > 0).length;
  const highQualityCount = results.filter((entry) => entry.quality_score >= 0.75).length;
  const durations = results
    .map((entry) => entry.duration_ms)
    .filter((value): value is number => typeof value === "number") as number[];
  const qualityScores = results.map((entry) => entry.quality_score);
  const avgDuration =
    durations.length > 0
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : undefined;
  const avgQuality =
    qualityScores.length > 0
      ? Number((qualityScores.reduce((sum, score) => sum + score, 0) / qualityScores.length).toFixed(3))
      : 0;
  return {
    config: configName,
    total,
    ok,
    hard_fail: hardFail,
    clarify_rate: total > 0 ? Number((clarifyCount / total).toFixed(3)) : 0,
    prompt_leak_rate: total > 0 ? Number((promptLeakCount / total).toFixed(3)) : 0,
    decorative_citation_rate: total > 0 ? Number((decorativeCount / total).toFixed(3)) : 0,
    avg_duration_ms: avgDuration,
    p50_duration_ms: durations.length > 0 ? Math.round(quantile(durations, 0.5)) : undefined,
    p95_duration_ms: durations.length > 0 ? Math.round(quantile(durations, 0.95)) : undefined,
    avg_quality_score: avgQuality,
    quality_rate: total > 0 ? Number((highQualityCount / total).toFixed(3)) : 0,
  };
};

const buildStage0SweepGateMetrics = (results: CaseResult[]): Stage0SweepGateMetrics => {
  const failOpenReasonHistogram: Record<string, number> = {};
  const policyDecisionHistogram: Record<string, number> = {};
  let citationMissing = 0;
  let runtimeFallback = 0;
  let eligibleTurns = 0;
  let activeUsedTurns = 0;
  let technicalFailOpenTurns = 0;

  for (const result of results) {
    if (result.citation_missing) citationMissing += 1;
    if (result.runtime_fallback_answer) runtimeFallback += 1;
    incrementHistogram(failOpenReasonHistogram, result.stage0_fail_open_reason);
    incrementHistogram(policyDecisionHistogram, result.stage0_policy_decision);
    if (!result.stage0_eligible) continue;
    eligibleTurns += 1;
    if (result.stage0_used_active) activeUsedTurns += 1;
    if (result.stage0_technical_fail_open) technicalFailOpenTurns += 1;
  }

  return {
    citation_missing: citationMissing,
    runtime_fallback_answer: runtimeFallback,
    eligible_turn_count: eligibleTurns,
    stage0_active_used_count: activeUsedTurns,
    stage0_active_usage_rate:
      eligibleTurns > 0 ? Number((activeUsedTurns / eligibleTurns).toFixed(4)) : 0,
    stage0_technical_fail_open_count: technicalFailOpenTurns,
    stage0_technical_fail_open_rate:
      eligibleTurns > 0 ? Number((technicalFailOpenTurns / eligibleTurns).toFixed(4)) : 0,
    fail_open_reason_histogram: failOpenReasonHistogram,
    policy_decision_histogram: policyDecisionHistogram,
  };
};

const evaluateStage0PromotionGate = (
  baselineConfig: string,
  baseline: Stage0SweepGateMetrics,
  candidateConfig: string,
  candidate: Stage0SweepGateMetrics,
): Stage0SweepPromotionGate => {
  const failingRules: string[] = [];
  if (candidate.citation_missing > baseline.citation_missing) {
    failingRules.push(
      `citation_missing increased baseline=${baseline.citation_missing} candidate=${candidate.citation_missing}`,
    );
  }
  if (candidate.runtime_fallback_answer > baseline.runtime_fallback_answer) {
    failingRules.push(
      `runtime_fallback_answer increased baseline=${baseline.runtime_fallback_answer} candidate=${candidate.runtime_fallback_answer}`,
    );
  }
  if (candidate.eligible_turn_count <= 0) {
    failingRules.push("stage0_active_usage_rate unavailable (eligible_turn_count=0)");
  } else if (candidate.stage0_active_usage_rate < 0.99) {
    failingRules.push(
      `stage0_active_usage_rate below threshold candidate=${candidate.stage0_active_usage_rate} threshold=0.99`,
    );
  }
  if (candidate.stage0_technical_fail_open_rate >= 0.01) {
    failingRules.push(
      `stage0_technical_fail_open_rate above threshold candidate=${candidate.stage0_technical_fail_open_rate} threshold=0.01`,
    );
  }

  return {
    baseline_config: baselineConfig,
    candidate_config: candidateConfig,
    baseline,
    candidate,
    verdict: failingRules.length === 0 ? "pass" : "fail",
    failing_rules: failingRules,
  };
};

type Stage0RolloutActionArtifact = {
  schema_version: "helix_ask_stage0_rollout_action/1";
  generated_at: string;
  verdict: "pass" | "fail";
  recommendation: {
    mode: "shadow" | "full";
    canary_pct: number;
  };
  gate: Stage0SweepPromotionGate;
};

const buildStage0RolloutActionArtifact = (
  gate: Stage0SweepPromotionGate,
): Stage0RolloutActionArtifact => ({
  schema_version: "helix_ask_stage0_rollout_action/1",
  generated_at: new Date().toISOString(),
  verdict: gate.verdict,
  recommendation:
    gate.verdict === "fail"
      ? { mode: "shadow", canary_pct: 0 }
      : { mode: "full", canary_pct: 100 },
  gate,
});

const resolveGateEntry = async (
  runResults: Array<{ config: SweepConfig; results: CaseResult[]; gate_metrics: Stage0SweepGateMetrics }>,
  configName: string | null,
  artifactPath: string | null,
): Promise<{ config: string; metrics: Stage0SweepGateMetrics } | null> => {
  if (artifactPath) {
    const artifact = await readJsonFile<
      Array<{ config: SweepConfig; gate_metrics?: Stage0SweepGateMetrics }>
    >(path.resolve(artifactPath));
    const configuredName = configName?.trim();
    const foundFromArtifact =
      (configuredName
        ? artifact.find((entry) => entry.config?.name === configuredName)
        : artifact[0]) ?? null;
    if (foundFromArtifact?.gate_metrics) {
      return {
        config: foundFromArtifact.config.name,
        metrics: foundFromArtifact.gate_metrics,
      };
    }
    return null;
  }
  const configuredName = configName?.trim();
  const found =
    (configuredName
      ? runResults.find((entry) => entry.config.name === configuredName)
      : runResults[0]) ?? null;
  if (!found) return null;
  return {
    config: found.config.name,
    metrics: found.gate_metrics,
  };
};

export const __testOnlyBuildStage0SweepGateMetrics = buildStage0SweepGateMetrics;
export const __testOnlyEvaluateStage0PromotionGate = evaluateStage0PromotionGate;
export const __testOnlyIsStage0TechnicalFailOpenReason = isStage0TechnicalFailOpenReason;
export const __testOnlyBuildStage0RolloutActionArtifact = buildStage0RolloutActionArtifact;

export const buildQualityBaselineContract = (
  summary: SweepSummary,
  sourceReport: string,
  generatedAt = new Date().toISOString(),
  thresholds: QualityBaselineThresholds = DEFAULT_BASELINE_THRESHOLDS,
): QualityBaselineContract => {
  const okRate = summary.total > 0 ? summary.ok / summary.total : 0;
  const failingThresholds: string[] = [];
  if (okRate < thresholds.min_ok_rate) failingThresholds.push("min_ok_rate");
  if (summary.clarify_rate > thresholds.max_clarify_rate) failingThresholds.push("max_clarify_rate");
  if (summary.prompt_leak_rate > thresholds.max_prompt_leak_rate) {
    failingThresholds.push("max_prompt_leak_rate");
  }
  if (summary.decorative_citation_rate > thresholds.max_decorative_citation_rate) {
    failingThresholds.push("max_decorative_citation_rate");
  }
  if (summary.avg_quality_score < thresholds.min_avg_quality_score) {
    failingThresholds.push("min_avg_quality_score");
  }
  if (summary.quality_rate < thresholds.min_quality_rate) failingThresholds.push("min_quality_rate");

  return {
    schema_version: "helix_ask_quality_baseline_contract/1",
    generated_at: generatedAt,
    source_report: sourceReport,
    config: summary.config,
    summary,
    thresholds,
    evaluation: {
      ok_rate: Number(okRate.toFixed(3)),
      status: failingThresholds.length === 0 ? "pass" : "fail",
      failing_thresholds: failingThresholds,
    },
  };
};

const writeQualityBaselineContract = async (
  runResults: Array<{ config: SweepConfig; summary: SweepSummary; gate_metrics: Stage0SweepGateMetrics }>,
  sourceReport: string,
) => {
  const baseline = runResults.find((entry) => entry.config.name === "baseline") ?? runResults[0];
  if (!baseline) return;
  const contract = buildQualityBaselineContract(baseline.summary, sourceReport);
  await fs.mkdir(path.dirname(QUALITY_BASELINE_OUT_PATH), { recursive: true });
  await fs.writeFile(QUALITY_BASELINE_OUT_PATH, JSON.stringify(contract, null, 2) + "\n", "utf8");
  console.log(
    `Saved quality baseline contract: ${QUALITY_BASELINE_OUT_PATH} (${contract.evaluation.status.toUpperCase()})`,
  );
};

const toPercentDelta = (a: number, b: number): string => {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return "n/a";
  return `${(((b - a) / a) * 100).toFixed(1)}%`;
};

const printPairwiseStudySummary = (
  results: Array<{ config: SweepConfig; summary: SweepSummary; gate_metrics: Stage0SweepGateMetrics }>,
) => {
  if (results.length < 2) return;
  const base = results[0];
  const candidate = results[results.length - 1];
  const latencyDelta = toPercentDelta(
    base.summary.avg_duration_ms ?? 0,
    candidate.summary.avg_duration_ms ?? 0,
  );
  const p50Delta = toPercentDelta(
    base.summary.p50_duration_ms ?? 0,
    candidate.summary.p50_duration_ms ?? 0,
  );
  const p95Delta = toPercentDelta(
    base.summary.p95_duration_ms ?? 0,
    candidate.summary.p95_duration_ms ?? 0,
  );
  const qualityDelta = Number(
    (candidate.summary.avg_quality_score - base.summary.avg_quality_score).toFixed(3),
  );
  const qualityRateDelta = Number(
    (candidate.summary.quality_rate - base.summary.quality_rate).toFixed(3),
  );
  console.log(
    `Study comparison (base=${base.config.name} -> candidate=${candidate.config.name}):` +
      ` latencyAvg=${latencyDelta}, latencyP50=${p50Delta}, latencyP95=${p95Delta},` +
      ` qualityDelta=${qualityDelta}, qualityRateDelta=${qualityRateDelta}`,
  );
};

async function main(): Promise<void> {
  const pack = await readJsonFile<SweepPack>(path.resolve(PACK_PATH));
  const matrix = await resolveSweepMatrix();
  if (!pack.cases?.length) {
    throw new Error(`Sweep pack is empty: ${PACK_PATH}`);
  }
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const sessionId = `helix-ask-sweep:${Date.now()}`;
  const runResults: Array<{
    config: SweepConfig;
    results: CaseResult[];
    summary: SweepSummary;
    gate_metrics: Stage0SweepGateMetrics;
  }> = [];

  for (const config of matrix) {
    const results: CaseResult[] = [];
    for (const entry of pack.cases) {
      console.log(`Running [${config.name}] ${entry.label}`);
      const response = await fetchCase(entry, config, sessionId);
      if (!response.ok) {
        results.push({
          label: entry.label,
          ok: false,
          clarify: false,
          duration_ms: response.duration_ms,
          hard_failures: [response.error ?? "request failed"],
          decorative_citations: [],
          prompt_leak: false,
          cited_paths: [],
          context_paths: [],
          answer_length: 0,
          quality_score: 0,
          quality_signals: {},
        });
        continue;
      }
      results.push(evaluateCase(entry, response.payload, response.duration_ms));
    }
    const summary = summarize(config.name, results);
    const gateMetrics = buildStage0SweepGateMetrics(results);
    runResults.push({ config, results, summary, gate_metrics: gateMetrics });
    console.log(
      `Summary [${config.name}] ok=${summary.ok}/${summary.total} clarifyRate=${summary.clarify_rate} ` +
        `quality=${summary.avg_quality_score} latencyP50=${summary.p50_duration_ms ?? "n/a"}ms latencyP95=${summary.p95_duration_ms ?? "n/a"}ms ` +
        `citationMissing=${gateMetrics.citation_missing} runtimeFallback=${gateMetrics.runtime_fallback_answer} ` +
        `stage0Usage=${gateMetrics.stage0_active_usage_rate} stage0TechFailOpen=${gateMetrics.stage0_technical_fail_open_rate}`,
    );
  }

  printPairwiseStudySummary(runResults);

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const outPath = path.join(OUTPUT_DIR, `helix-ask-sweep.${stamp}.json`);
  await fs.writeFile(outPath, JSON.stringify(runResults, null, 2), "utf8");
  console.log(`Saved sweep report: ${outPath}`);
  await writeQualityBaselineContract(runResults, outPath);

  if (STAGE0_GATE_ENABLED) {
    const baselineEntry = await resolveGateEntry(
      runResults,
      STAGE0_GATE_BASELINE_CONFIG,
      STAGE0_GATE_BASELINE_ARTIFACT,
    );
    const candidateEntry = await resolveGateEntry(runResults, STAGE0_GATE_CANDIDATE_CONFIG, null);
    if (!baselineEntry || !candidateEntry) {
      throw new Error("stage0 gate enabled but baseline/candidate entries could not be resolved");
    }
    const gate = evaluateStage0PromotionGate(
      baselineEntry.config,
      baselineEntry.metrics,
      candidateEntry.config,
      candidateEntry.metrics,
    );
    const action = buildStage0RolloutActionArtifact(gate);
    const actionOutPath =
      STAGE0_ROLLOUT_ACTION_OUT_PATH ??
      path.join(OUTPUT_DIR, `helix-ask-stage0-rollout-action.${stamp}.json`);
    const actionPath = path.resolve(actionOutPath);
    await fs.mkdir(path.dirname(actionPath), { recursive: true });
    await fs.writeFile(actionPath, JSON.stringify(action, null, 2), "utf8");
    console.log(`Saved stage0 rollout action: ${actionPath}`);
    console.log(`Stage0 promotion gate verdict: ${gate.verdict.toUpperCase()}`);
    if (gate.verdict === "fail") {
      console.error(`Stage0 promotion gate failures: ${gate.failing_rules.join(" | ")}`);
      process.exit(1);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("[helix-ask-sweep] failed:", error);
    process.exit(1);
  });
}
