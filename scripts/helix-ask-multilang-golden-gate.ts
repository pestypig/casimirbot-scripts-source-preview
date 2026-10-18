import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  canonicalTermPreservationRatio,
  findCanonicalTermsInText,
  normalizeLanguageTag,
} from "../server/services/helix-ask/multilang";

type GoldenExpect = {
  intent_domain?: string;
  intent_id?: string;
};

type GoldenCase = {
  id: string;
  group: "zh" | "zh_en_mixed" | "ja";
  source_question: string;
  pivot_question: string;
  source_language: string;
  language_confidence?: number;
  pivot_confidence?: number;
  code_mixed?: boolean;
  response_language?: string;
  expect?: GoldenExpect;
  expect_term_prior_applied?: boolean;
  expect_prior_impact?: "helped" | "harmed" | "neutral";
};

type LowConfidenceCase = {
  id: string;
  source_question: string;
  pivot_question: string;
  source_language: string;
  language_confidence?: number;
  pivot_confidence?: number;
  code_mixed?: boolean;
  response_language?: string;
};

type GoldenPack = {
  schema_version: string;
  cases: GoldenCase[];
  low_confidence_cases: LowConfidenceCase[];
};

type AskDebug = {
  intent_domain?: string;
  intent_id?: string;
  term_prior_applied?: boolean;
  term_prior_impact?: "helped" | "harmed" | "neutral";
};

type AskResponse = {
  ok?: boolean;
  text?: string;
  fail_reason?: string;
  dispatch_state?: "auto" | "confirm" | "blocked";
  response_language?: string | null;
  debug?: AskDebug;
};

type RegularCaseResult = {
  id: string;
  group: GoldenCase["group"];
  route_ok: boolean;
  route_domain_ok: boolean;
  route_intent_ok: boolean;
  language_ok: boolean;
  expected_response_language: string;
  actual_response_language: string;
  canonical_ratio: number;
  canonical_terms: string[];
  intent_domain_actual: string;
  intent_id_actual: string;
  term_prior_applied: boolean;
  term_prior_impact: "helped" | "harmed" | "neutral";
  term_prior_applied_ok: boolean;
  term_prior_impact_ok: boolean;
  duration_ms: number;
  error?: string;
};

type LowConfidenceResult = {
  id: string;
  blocked: boolean;
  fail_reason: string | null;
  dispatch_state: string | null;
  duration_ms: number;
  error?: string;
};

const BASE_URL =
  process.env.HELIX_ASK_BASE_URL ??
  process.env.EVAL_BASE_URL ??
  "http://localhost:5050";
const ASK_URL = new URL("/api/agi/ask", BASE_URL).toString();
const REQUEST_TIMEOUT_MS = Number(process.env.HELIX_ASK_MULTILANG_GOLDEN_TIMEOUT_MS ?? 60_000);
const PACK_PATH = path.resolve(
  process.env.HELIX_ASK_MULTILANG_GOLDEN_PACK ?? "scripts/helix-ask-multilang-golden-pack.json",
);
const OUTPUT_DIR = path.resolve(
  process.env.HELIX_ASK_MULTILANG_GOLDEN_OUT_DIR ?? "artifacts/experiments/helix-ask-multilang-golden",
);

const REQUIRED_BARS = {
  zh_route_accuracy_min: Number(process.env.HELIX_ASK_MULTILANG_GOLDEN_ZH_ROUTE_MIN ?? 0.92),
  mixed_route_accuracy_min: Number(process.env.HELIX_ASK_MULTILANG_GOLDEN_MIXED_ROUTE_MIN ?? 0.9),
  ja_route_accuracy_min: Number(process.env.HELIX_ASK_MULTILANG_GOLDEN_JA_ROUTE_MIN ?? 0),
  canonical_term_preservation_min: Number(
    process.env.HELIX_ASK_MULTILANG_GOLDEN_TERM_PRES_MIN ?? 0.995,
  ),
  response_language_correctness_min: Number(
    process.env.HELIX_ASK_MULTILANG_GOLDEN_LANG_OK_MIN ?? 0.99,
  ),
  low_conf_dispatch_violations_max: Number(
    process.env.HELIX_ASK_MULTILANG_GOLDEN_LOW_CONF_VIOLATIONS_MAX ?? 0,
  ),
  prior_harmed_rate_max: Number(
    process.env.HELIX_ASK_MULTILANG_GOLDEN_PRIOR_HARMED_RATE_MAX ?? 0.1,
  ),
} as const;

const nowStamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");

const readJson = async <T>(filePath: string): Promise<T> => {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
};

const normalizeLang = (value: string | null | undefined): string =>
  normalizeLanguageTag(value ?? null) ?? "en";

const buildSessionId = (prefix: string): string => {
  const digest = crypto.createHash("sha256").update(`${prefix}:${Date.now()}:${Math.random()}`).digest("hex");
  return `multilang-golden:${digest.slice(0, 16)}`;
};

const runAsk = async (body: Record<string, unknown>): Promise<{ ok: boolean; durationMs: number; payload?: AskResponse; error?: string }> => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(ASK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        durationMs,
        error: `request_failed_${response.status}${text ? `:${text.slice(0, 200)}` : ""}`,
      };
    }
    const payload = (await response.json()) as AskResponse;
    return { ok: true, durationMs, payload };
  } catch (error) {
    clearTimeout(timeout);
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const runRegularCase = async (entry: GoldenCase): Promise<RegularCaseResult> => {
  const expectedResponseLanguage = normalizeLang(entry.response_language ?? entry.source_language);
  const body: Record<string, unknown> = {
    question: entry.pivot_question,
    sourceQuestion: entry.source_question,
    sourceLanguage: entry.source_language,
    languageDetected: entry.source_language,
    languageConfidence: entry.language_confidence ?? 0.9,
    pivotConfidence: entry.pivot_confidence ?? 0.9,
    codeMixed: entry.code_mixed ?? false,
    translated: true,
    responseLanguage: expectedResponseLanguage,
    lang_schema_version: "helix.lang.v1",
    multilangConfirm: true,
    debug: true,
    sessionId: buildSessionId(entry.id),
  };
  const response = await runAsk(body);
  if (!response.ok || !response.payload) {
    return {
      id: entry.id,
      group: entry.group,
      route_ok: false,
      route_domain_ok: false,
      route_intent_ok: false,
      language_ok: false,
      expected_response_language: expectedResponseLanguage,
      actual_response_language: "unknown",
      canonical_ratio: 0,
      canonical_terms: [],
      intent_domain_actual: "",
      intent_id_actual: "",
      duration_ms: response.durationMs,
      error: response.error ?? "request_failed",
    };
  }
  const payload = response.payload;
  const actualDomain = String(payload.debug?.intent_domain ?? "").trim();
  const actualIntent = String(payload.debug?.intent_id ?? "").trim();
  const domainOk = entry.expect?.intent_domain ? actualDomain === entry.expect.intent_domain : true;
  const intentOk = entry.expect?.intent_id ? actualIntent === entry.expect.intent_id : true;
  const routeOk = domainOk && intentOk;
  const actualResponseLanguage = normalizeLang(payload.response_language ?? null);
  const languageOk = actualResponseLanguage === expectedResponseLanguage;
  const canonicalTerms = findCanonicalTermsInText(entry.source_question);
  const canonicalRatio = canonicalTermPreservationRatio(entry.source_question, entry.pivot_question);
  const termPriorApplied = payload.debug?.term_prior_applied === true;
  const termPriorImpact =
    payload.debug?.term_prior_impact === "helped" ||
    payload.debug?.term_prior_impact === "harmed" ||
    payload.debug?.term_prior_impact === "neutral"
      ? payload.debug.term_prior_impact
      : "neutral";
  const termPriorAppliedOk =
    typeof entry.expect_term_prior_applied === "boolean"
      ? termPriorApplied === entry.expect_term_prior_applied
      : true;
  const termPriorImpactOk =
    entry.expect_prior_impact
      ? termPriorImpact === entry.expect_prior_impact
      : true;
  return {
    id: entry.id,
    group: entry.group,
    route_ok: routeOk,
    route_domain_ok: domainOk,
    route_intent_ok: intentOk,
    language_ok: languageOk,
    expected_response_language: expectedResponseLanguage,
    actual_response_language: actualResponseLanguage,
    canonical_ratio: Number(canonicalRatio.toFixed(6)),
    canonical_terms: canonicalTerms,
    intent_domain_actual: actualDomain,
    intent_id_actual: actualIntent,
    term_prior_applied: termPriorApplied,
    term_prior_impact: termPriorImpact,
    term_prior_applied_ok: termPriorAppliedOk,
    term_prior_impact_ok: termPriorImpactOk,
    duration_ms: response.durationMs,
  };
};

const runLowConfidenceCase = async (entry: LowConfidenceCase): Promise<LowConfidenceResult> => {
  const body: Record<string, unknown> = {
    question: entry.pivot_question,
    sourceQuestion: entry.source_question,
    sourceLanguage: entry.source_language,
    languageDetected: entry.source_language,
    languageConfidence: entry.language_confidence ?? 0.85,
    pivotConfidence: entry.pivot_confidence ?? 0.64,
    codeMixed: entry.code_mixed ?? false,
    translated: true,
    responseLanguage: normalizeLang(entry.response_language ?? entry.source_language),
    lang_schema_version: "helix.lang.v1",
    multilangConfirm: false,
    debug: true,
    sessionId: buildSessionId(`low-${entry.id}`),
  };
  const response = await runAsk(body);
  if (!response.ok || !response.payload) {
    return {
      id: entry.id,
      blocked: false,
      fail_reason: null,
      dispatch_state: null,
      duration_ms: response.durationMs,
      error: response.error ?? "request_failed",
    };
  }
  const payload = response.payload;
  const failReason = typeof payload.fail_reason === "string" ? payload.fail_reason : null;
  const dispatchState = typeof payload.dispatch_state === "string" ? payload.dispatch_state : null;
  const blocked =
    dispatchState === "blocked" ||
    failReason === "HELIX_MULTILANG_PIVOT_CONFIDENCE_BLOCK" ||
    failReason === "HELIX_MULTILANG_CONFIRM_REQUIRED";
  return {
    id: entry.id,
    blocked,
    fail_reason: failReason,
    dispatch_state: dispatchState,
    duration_ms: response.durationMs,
  };
};

const ratio = (num: number, den: number): number => (den > 0 ? num / den : 0);

async function main() {
  const pack = await readJson<GoldenPack>(PACK_PATH);
  if (!Array.isArray(pack.cases) || pack.cases.length === 0) {
    throw new Error("golden pack has no cases");
  }

  const regularResults: RegularCaseResult[] = [];
  for (const entry of pack.cases) {
    regularResults.push(await runRegularCase(entry));
  }

  const lowConfidenceResults: LowConfidenceResult[] = [];
  for (const entry of pack.low_confidence_cases ?? []) {
    lowConfidenceResults.push(await runLowConfidenceCase(entry));
  }

  const zh = regularResults.filter((entry) => entry.group === "zh");
  const mixed = regularResults.filter((entry) => entry.group === "zh_en_mixed");
  const ja = regularResults.filter((entry) => entry.group === "ja");
  const zhRouteAccuracy = ratio(zh.filter((entry) => entry.route_ok).length, zh.length);
  const mixedRouteAccuracy = ratio(mixed.filter((entry) => entry.route_ok).length, mixed.length);
  const jaRouteAccuracy = ratio(ja.filter((entry) => entry.route_ok).length, ja.length);
  const responseLanguageCorrectness = ratio(
    regularResults.filter((entry) => entry.language_ok).length,
    regularResults.length,
  );
  let weightedCanonicalSum = 0;
  let weightedCanonicalDen = 0;
  for (const entry of regularResults) {
    const weight = Math.max(1, entry.canonical_terms.length);
    weightedCanonicalSum += entry.canonical_ratio * weight;
    weightedCanonicalDen += weight;
  }
  const canonicalTermPreservation = ratio(weightedCanonicalSum, weightedCanonicalDen);
  const lowConfidenceViolations = lowConfidenceResults.filter((entry) => !entry.blocked).length;
  const priorHelped = regularResults.filter((entry) => entry.term_prior_impact === "helped").length;
  const priorHarmed = regularResults.filter((entry) => entry.term_prior_impact === "harmed").length;
  const priorNeutral = regularResults.filter((entry) => entry.term_prior_impact === "neutral").length;
  const priorHarmedRate = ratio(priorHarmed, regularResults.length);
  const priorCaseAppliedOkRate = ratio(
    regularResults.filter((entry) => entry.term_prior_applied_ok).length,
    regularResults.length,
  );
  const priorCaseImpactOkRate = ratio(
    regularResults.filter((entry) => entry.term_prior_impact_ok).length,
    regularResults.length,
  );

  const failures: string[] = [];
  if (zhRouteAccuracy < REQUIRED_BARS.zh_route_accuracy_min) {
    failures.push(
      `zh_route_accuracy ${zhRouteAccuracy.toFixed(4)} < ${REQUIRED_BARS.zh_route_accuracy_min.toFixed(4)}`,
    );
  }
  if (mixedRouteAccuracy < REQUIRED_BARS.mixed_route_accuracy_min) {
    failures.push(
      `zh_en_mixed_route_accuracy ${mixedRouteAccuracy.toFixed(4)} < ${REQUIRED_BARS.mixed_route_accuracy_min.toFixed(4)}`,
    );
  }
  if (
    REQUIRED_BARS.ja_route_accuracy_min > 0 &&
    jaRouteAccuracy < REQUIRED_BARS.ja_route_accuracy_min
  ) {
    failures.push(
      `ja_route_accuracy ${jaRouteAccuracy.toFixed(4)} < ${REQUIRED_BARS.ja_route_accuracy_min.toFixed(4)}`,
    );
  }
  if (canonicalTermPreservation < REQUIRED_BARS.canonical_term_preservation_min) {
    failures.push(
      `canonical_term_preservation ${canonicalTermPreservation.toFixed(4)} < ${REQUIRED_BARS.canonical_term_preservation_min.toFixed(4)}`,
    );
  }
  if (responseLanguageCorrectness < REQUIRED_BARS.response_language_correctness_min) {
    failures.push(
      `response_language_correctness ${responseLanguageCorrectness.toFixed(4)} < ${REQUIRED_BARS.response_language_correctness_min.toFixed(4)}`,
    );
  }
  if (lowConfidenceViolations > REQUIRED_BARS.low_conf_dispatch_violations_max) {
    failures.push(
      `low_conf_dispatch_violations ${lowConfidenceViolations} > ${REQUIRED_BARS.low_conf_dispatch_violations_max}`,
    );
  }
  if (priorHarmedRate > REQUIRED_BARS.prior_harmed_rate_max) {
    failures.push(
      `prior_harmed_rate ${priorHarmedRate.toFixed(4)} > ${REQUIRED_BARS.prior_harmed_rate_max.toFixed(4)}`,
    );
  }
  if (priorHelped + priorHarmed > 0 && priorHelped <= priorHarmed) {
    failures.push(`prior_helped_not_greater_than_harmed helped=${priorHelped} harmed=${priorHarmed}`);
  }

  const summary = {
    schema_version: "helix_ask_multilang_golden_gate/1",
    generated_at: new Date().toISOString(),
    base_url: BASE_URL,
    ask_url: ASK_URL,
    pack_path: PACK_PATH,
    bars: REQUIRED_BARS,
    metrics: {
      zh_route_accuracy: Number(zhRouteAccuracy.toFixed(6)),
      zh_en_mixed_route_accuracy: Number(mixedRouteAccuracy.toFixed(6)),
      ja_route_accuracy: Number(jaRouteAccuracy.toFixed(6)),
      canonical_term_preservation: Number(canonicalTermPreservation.toFixed(6)),
      response_language_correctness: Number(responseLanguageCorrectness.toFixed(6)),
      low_conf_dispatch_violations: lowConfidenceViolations,
      prior_helped: priorHelped,
      prior_harmed: priorHarmed,
      prior_neutral: priorNeutral,
      prior_harmed_rate: Number(priorHarmedRate.toFixed(6)),
      prior_applied_expectation_ok_rate: Number(priorCaseAppliedOkRate.toFixed(6)),
      prior_impact_expectation_ok_rate: Number(priorCaseImpactOkRate.toFixed(6)),
    },
    totals: {
      regular_cases: regularResults.length,
      low_confidence_cases: lowConfidenceResults.length,
    },
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    failures,
    regular_results: regularResults,
    low_confidence_results: lowConfidenceResults,
  };

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, `helix-ask-multilang-golden-gate.${nowStamp()}.json`);
  await fs.writeFile(outPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify({ ...summary, artifact: outPath }, null, 2));

  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[helix-ask-multilang-golden-gate] ${message}`);
  process.exit(1);
});
