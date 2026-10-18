import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ProbeFamily =
  | "ideology_social"
  | "repo_technical"
  | "hybrid"
  | "general";

type ProbeExpectation = {
  intent_domain?: string;
  intent_id?: string;
  forbid_concept_ids?: string[];
  require_context_contains?: string[];
  min_coverage_ratio?: number;
  max_belief_unsupported_rate?: number;
};

type ProbeCase = {
  id: string;
  label: string;
  family: ProbeFamily;
  question: string;
  expect: ProbeExpectation;
};

type AskDebug = Record<string, unknown> & {
  intent_id?: string;
  intent_domain?: string;
  concept_id?: string;
  coverage_ratio?: number;
  belief_unsupported_rate?: number;
  context_files?: string[];
  objective_count?: number;
  objective_loop_state?: Array<Record<string, unknown>>;
  objective_transition_log?: Array<Record<string, unknown>>;
  objective_retrieval_queries?: Array<Record<string, unknown>>;
  objective_mini_answers?: Array<Record<string, unknown>>;
  objective_mini_critic_mode?: string;
  objective_assembly_mode?: string;
  objective_assembly_blocked_reason?: string;
  objective_finalize_gate_passed?: boolean;
  objective_finalize_gate_mode?: string;
  objective_unknown_block_count?: number;
  objective_unresolved_without_unknown_block_count?: number;
  objective_oes_scores?: Array<Record<string, unknown>>;
  objective_terminalization_reason?: string | null;
  objective_terminalization_reasons?: Record<string, string>;
  objective_loop_patch_revision?: string;
  objective_scoped_retrieval_budget_bypass_applied?: boolean;
  objective_scoped_retrieval_budget_bypass_count?: number;
  objective_scoped_retrieval_recovery_applied?: boolean;
  objective_scoped_retrieval_recovery_count?: number;
  objective_scoped_retrieval_recovery_error_count?: number;
  composer_soft_enforce_action?: string;
  objective_loop_primary_composer_guard?: boolean;
  composer_family_degrade_suppressed?: boolean;
  composer_family_degrade_suppressed_reason?: string;
};

type AskResponse = {
  text?: string;
  debug?: AskDebug;
};

type ProbeResult = {
  id: string;
  label: string;
  family: ProbeFamily;
  question: string;
  ok: boolean;
  failures: string[];
  duration_ms: number;
  debug: {
    intent_id?: string;
    intent_domain?: string;
    concept_id?: string;
    coverage_ratio?: number;
    belief_unsupported_rate?: number;
    context_files_count?: number;
    objective_count?: number;
    objective_transition_count?: number;
    objective_retrieval_query_count?: number;
    objective_mini_answer_count?: number;
    objective_mini_critic_mode?: string;
    objective_assembly_mode?: string;
    objective_assembly_blocked_reason?: string;
    objective_finalize_gate_passed?: boolean;
    objective_finalize_gate_mode?: string;
    objective_unknown_block_count?: number;
    objective_unresolved_without_unknown_block_count?: number;
    objective_oes_score_count?: number;
    objective_oes_avg_score?: number;
    objective_terminalization_reason?: string | null;
    objective_loop_patch_revision?: string;
    objective_scoped_retrieval_budget_bypass_applied?: boolean;
    objective_scoped_retrieval_budget_bypass_count?: number;
    objective_scoped_retrieval_recovery_applied?: boolean;
    objective_scoped_retrieval_recovery_count?: number;
    objective_scoped_retrieval_recovery_error_count?: number;
    coverage_ratio_exempt_unknown_terminal?: boolean;
    composer_soft_enforce_action?: string;
    objective_loop_primary_composer_guard?: boolean;
    composer_family_degrade_suppressed?: boolean;
    composer_family_degrade_suppressed_reason?: string;
  } | null;
};

type ProbeSummary = {
  schema_version: "helix_ask_patch_probe/1";
  run_id: string;
  generated_at: string;
  base_url: string;
  ask_url: string;
  seed: number;
  sample_count: number;
  total_cases_available: number;
  objective_loop_patch_revision_expected: string;
  objective_loop_patch_revision_required: boolean;
  objective_loop_patch_revision_pass_rate: number;
  pass_count: number;
  fail_count: number;
  pass_rate: number;
  plan_context: {
    path: string;
    required: boolean;
    loaded: boolean;
    sha256?: string;
  };
  family_stats: Array<{
    family: ProbeFamily;
    total: number;
    pass: number;
    fail: number;
    pass_rate: number;
  }>;
  artifacts: {
    output_dir: string;
    results_json: string;
    summary_json: string;
    report_md: string;
  };
  objective_loop_snapshot: {
    sampled_cases: number;
    finalize_gate_pass_rate: number;
    retrieval_success_rate: number;
    assembly_success_rate: number;
    bypass_applied_rate: number;
    avg_bypass_count: number;
    recovery_applied_rate: number;
    avg_recovery_count: number;
    avg_transition_count: number;
    oes_present_rate: number;
    avg_oes_score: number;
  };
};

const BASE_URL =
  process.env.HELIX_ASK_BASE_URL ??
  process.env.EVAL_BASE_URL ??
  "http://localhost:5050";
const ASK_URL = new URL("/api/agi/ask", BASE_URL).toString();
const REQUEST_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.HELIX_ASK_PATCH_PROBE_TIMEOUT_MS ?? 70000),
);
const MAX_RETRIES = Math.max(
  0,
  Number(process.env.HELIX_ASK_PATCH_PROBE_MAX_RETRIES ?? 1),
);
const RETRY_BASE_MS = Math.max(
  250,
  Number(process.env.HELIX_ASK_PATCH_PROBE_RETRY_BASE_MS ?? 1000),
);
const RETRY_MAX_MS = Math.max(
  RETRY_BASE_MS,
  Number(process.env.HELIX_ASK_PATCH_PROBE_RETRY_MAX_MS ?? 8000),
);
const SAMPLE_COUNT = Math.max(
  1,
  Number(process.env.HELIX_ASK_PATCH_PROBE_SAMPLES ?? 10),
);
const FAIL_ON_MISS = process.env.HELIX_ASK_PATCH_PROBE_FAIL_ON_MISS !== "0";
const OBJECTIVE_LOOP_EXPECTED_PATCH_REVISION =
  process.env.HELIX_ASK_OBJECTIVE_LOOP_EXPECTED_PATCH_REVISION ??
  "2026-03-23-objective-loop-final-resolution-v3";
const REQUIRE_OBJECTIVE_LOOP_PATCH_REVISION =
  process.env.HELIX_ASK_PATCH_PROBE_REQUIRE_OBJECTIVE_LOOP_PATCH_REVISION !== "0";
const REQUIRE_GENERAL_DEGRADE_SUPPRESSION =
  process.env.HELIX_ASK_PATCH_PROBE_REQUIRE_GENERAL_DEGRADE_SUPPRESSION !== "0";
const REQUIRE_PLAN_CONTEXT =
  process.env.HELIX_ASK_PATCH_PROBE_REQUIRE_PLAN_CONTEXT !== "0";
const resolveDefaultPlanPath = (): string => {
  const preferred = path.resolve("docs/helix-ask-reasoning-ladder-optimization-plan.md");
  if (process.env.HELIX_ASK_PATCH_PROBE_PLAN_PATH?.trim()) {
    return path.resolve(process.env.HELIX_ASK_PATCH_PROBE_PLAN_PATH);
  }
  return preferred;
};
const PLAN_PATH = resolveDefaultPlanPath();
const OUTPUT_ROOT = path.resolve(
  process.env.HELIX_ASK_PATCH_PROBE_OUT_DIR ??
    "artifacts/experiments/helix-ask-patch-probe",
);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const PROBE_BANK: ProbeCase[] = [
  {
    id: "ideology_child_love_1",
    label: "Child-love vulnerability policy",
    family: "ideology_social",
    question:
      "If a child would look forward to celebrating love, how can a society condition this vulnerability?",
    expect: {
      intent_domain: "repo",
      forbid_concept_ids: ["energy-conditions", "boundary-conditions-modes"],
      require_context_contains: ["docs/ethos/ideology.json"],
      min_coverage_ratio: 0.3,
      max_belief_unsupported_rate: 0.6,
    },
  },
  {
    id: "ideology_rumor_spike_1",
    label: "Rumor spike civic response",
    family: "ideology_social",
    question:
      "How should a town council respond to online rumor spikes using the ideology tree values in this repo?",
    expect: {
      intent_domain: "repo",
      intent_id: "repo.ideology_reference",
      require_context_contains: ["docs/ethos/ideology.json"],
      max_belief_unsupported_rate: 0.5,
    },
  },
  {
    id: "ideology_feedback_hygiene_1",
    label: "Feedback loop hygiene narrative",
    family: "ideology_social",
    question:
      "Explain Feedback Loop Hygiene as practical social guidance for a school community, rooted in this repo's ideology tree.",
    expect: {
      intent_domain: "repo",
      intent_id: "repo.ideology_reference",
      require_context_contains: ["docs/ethos/ideology.json"],
      max_belief_unsupported_rate: 0.5,
    },
  },
  {
    id: "ideology_societal_signal_1",
    label: "Societal signal routing",
    family: "ideology_social",
    question:
      "When social trust is fragile, what ideology-rooted principles should guide policy communication?",
    expect: {
      intent_domain: "repo",
      forbid_concept_ids: ["energy-conditions", "ford-roman-quantum-inequality"],
      require_context_contains: ["docs/ethos/ideology.json"],
      max_belief_unsupported_rate: 0.6,
    },
  },
  {
    id: "repo_pipeline_1",
    label: "Helix Ask pipeline explain",
    family: "repo_technical",
    question: "How does the Helix Ask pipeline work in this repo?",
    expect: {
      intent_domain: "repo",
      intent_id: "repo.helix_ask_pipeline_explain",
      min_coverage_ratio: 0.3,
    },
  },
  {
    id: "repo_debug_1",
    label: "Repo startup debug",
    family: "repo_technical",
    question: "This repo throws an error on startup. How do I fix it?",
    expect: {
      intent_domain: "repo",
      intent_id: "repo.repo_debugging_root_cause",
    },
  },
  {
    id: "repo_change_1",
    label: "Repo change request",
    family: "repo_technical",
    question: "Update this repo to add a new API endpoint.",
    expect: {
      intent_domain: "repo",
      intent_id: "repo.repo_change_request",
    },
  },
  {
    id: "hybrid_method_system_1",
    label: "Scientific method + system mapping",
    family: "hybrid",
    question:
      "What is the scientific method, and how does this system use it for verification?",
    expect: {
      intent_domain: "hybrid",
      intent_id: "hybrid.concept_plus_system_mapping",
      min_coverage_ratio: 0.25,
    },
  },
  {
    id: "hybrid_composite_1",
    label: "Composite system synthesis",
    family: "hybrid",
    question:
      "Using the repo, synthesize how save-the-Sun planning, warp viability, ideology gates, and uncertainty mechanics fit together.",
    expect: {
      intent_domain: "hybrid",
      intent_id: "hybrid.composite_system_synthesis",
      min_coverage_ratio: 0.3,
    },
  },
  {
    id: "general_epistemology_1",
    label: "General conceptual",
    family: "general",
    question: "What is epistemology and why does it matter?",
    expect: {
      intent_domain: "general",
      intent_id: "general.conceptual_define_compare",
    },
  },
];

const seedFromString = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const resolveSeed = (): number => {
  const raw = process.env.HELIX_ASK_PATCH_PROBE_SEED?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed) >>> 0;
    return seedFromString(raw);
  }
  return seedFromString(`${Date.now()}:${process.pid}:${Math.random()}`);
};

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const shuffleWithSeed = <T>(items: T[], seed: number): T[] => {
  const rng = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

const sampleCases = (cases: ProbeCase[], count: number, seed: number): ProbeCase[] => {
  if (count >= cases.length) {
    return shuffleWithSeed(cases, seed);
  }

  const families: ProbeFamily[] = [
    "ideology_social",
    "repo_technical",
    "hybrid",
    "general",
  ];
  const selected: ProbeCase[] = [];
  const selectedIds = new Set<string>();

  const familyPools = new Map<ProbeFamily, ProbeCase[]>(
    families.map((family, index) => [
      family,
      shuffleWithSeed(
        cases.filter((entry) => entry.family === family),
        seed + index + 1,
      ),
    ]),
  );

  for (const family of families) {
    if (selected.length >= count) break;
    const candidate = (familyPools.get(family) ?? [])[0];
    if (candidate) {
      selected.push(candidate);
      selectedIds.add(candidate.id);
    }
  }

  if (selected.length >= count) return selected.slice(0, count);

  const remainder = shuffleWithSeed(
    cases.filter((entry) => !selectedIds.has(entry.id)),
    seed + 99,
  );
  for (const entry of remainder) {
    if (selected.length >= count) break;
    selected.push(entry);
  }
  return selected;
};

const readPlanContext = async (): Promise<{
  loaded: boolean;
  sha256?: string;
}> => {
  try {
    const raw = await fs.readFile(PLAN_PATH, "utf8");
    const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
    return { loaded: true, sha256 };
  } catch {
    return { loaded: false };
  }
};

const askOneAttempt = async (entry: ProbeCase, runId: string): Promise<ProbeResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(ASK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        question: entry.question,
        debug: true,
        verbosity: "extended",
        sessionId: runId,
        max_tokens: 400,
        temperature: 0.2,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        id: entry.id,
        label: entry.label,
        family: entry.family,
        question: entry.question,
        ok: false,
        failures: [
          `request_failed:${response.status}${detail ? `:${detail.slice(0, 200)}` : ""}`,
        ],
        duration_ms: Date.now() - started,
        debug: null,
      };
    }
    const payload = (await response.json()) as AskResponse;
    const debug = payload.debug ?? {};
    const failures: string[] = [];
    const objectiveLoopPatchRevision =
      typeof debug.objective_loop_patch_revision === "string"
        ? debug.objective_loop_patch_revision.trim()
        : "";

    if (!payload.text || payload.text.trim().length < 32) {
      failures.push("answer_too_short");
    }
    if (
      REQUIRE_OBJECTIVE_LOOP_PATCH_REVISION &&
      objectiveLoopPatchRevision !== OBJECTIVE_LOOP_EXPECTED_PATCH_REVISION
    ) {
      failures.push(
        `objective_loop_patch_revision:${objectiveLoopPatchRevision || "missing"}!=${OBJECTIVE_LOOP_EXPECTED_PATCH_REVISION}`,
      );
    }

    if (entry.expect.intent_domain) {
      const got = debug.intent_domain ?? "";
      if (got !== entry.expect.intent_domain) {
        failures.push(`intent_domain:${got || "missing"}!=${entry.expect.intent_domain}`);
      }
    }

    if (entry.expect.intent_id) {
      const got = debug.intent_id ?? "";
      if (got !== entry.expect.intent_id) {
        failures.push(`intent_id:${got || "missing"}!=${entry.expect.intent_id}`);
      }
    }

    if (entry.expect.forbid_concept_ids?.length) {
      const concept = String(debug.concept_id ?? "");
      if (entry.expect.forbid_concept_ids.includes(concept)) {
        failures.push(`forbidden_concept_id:${concept}`);
      }
    }

    if (entry.expect.require_context_contains?.length) {
      const contextFiles = Array.isArray(debug.context_files)
        ? debug.context_files.map((value) => String(value))
        : [];
      for (const required of entry.expect.require_context_contains) {
        const hit = contextFiles.some((filePath) => filePath.includes(required));
        if (!hit) {
          failures.push(`missing_context:${required}`);
        }
      }
    }

    if (typeof entry.expect.min_coverage_ratio === "number") {
      const coverage = Number(debug.coverage_ratio);
      const finalizeGateMode =
        typeof debug.objective_finalize_gate_mode === "string"
          ? String(debug.objective_finalize_gate_mode).trim()
          : "";
      const finalizeGatePassed = debug.objective_finalize_gate_passed === true;
      const unknownBlockCount = Number(debug.objective_unknown_block_count);
      const unresolvedWithoutUnknownBlockCount = Number(
        debug.objective_unresolved_without_unknown_block_count,
      );
      const unknownTerminalCoverageExempt =
        finalizeGatePassed &&
        finalizeGateMode === "unknown_terminal" &&
        Number.isFinite(unknownBlockCount) &&
        unknownBlockCount > 0 &&
        Number.isFinite(unresolvedWithoutUnknownBlockCount) &&
        unresolvedWithoutUnknownBlockCount === 0;
      if (
        (!Number.isFinite(coverage) || coverage < entry.expect.min_coverage_ratio) &&
        !unknownTerminalCoverageExempt
      ) {
        failures.push(
          `coverage_ratio:${Number.isFinite(coverage) ? coverage.toFixed(3) : "missing"}<${entry.expect.min_coverage_ratio.toFixed(3)}`,
        );
      }
    }

    if (typeof entry.expect.max_belief_unsupported_rate === "number") {
      const belief = Number(debug.belief_unsupported_rate);
      if (
        Number.isFinite(belief) &&
        belief > entry.expect.max_belief_unsupported_rate
      ) {
        failures.push(
          `belief_unsupported_rate:${belief.toFixed(3)}>${entry.expect.max_belief_unsupported_rate.toFixed(3)}`,
        );
      }
    }

    const composerSoftEnforceAction =
      typeof debug.composer_soft_enforce_action === "string"
        ? debug.composer_soft_enforce_action.trim()
        : "";
    const objectiveLoopPrimaryComposerGuard =
      debug.objective_loop_primary_composer_guard === true;
    const composerFamilyDegradeSuppressed = debug.composer_family_degrade_suppressed === true;
    const composerFamilyDegradeSuppressedReason =
      typeof debug.composer_family_degrade_suppressed_reason === "string"
        ? debug.composer_family_degrade_suppressed_reason.trim()
        : "";
    const generalFamilyDegradeActive =
      entry.family === "general" &&
      (composerSoftEnforceAction === "composer_v2_family_degrade" ||
        composerSoftEnforceAction === "family_degrade");
    if (
      REQUIRE_GENERAL_DEGRADE_SUPPRESSION &&
      generalFamilyDegradeActive &&
      !composerFamilyDegradeSuppressed
    ) {
      failures.push(
        `general_family_degrade_active:${composerSoftEnforceAction || "unknown_action"}`,
      );
    }
    if (
      entry.family === "general" &&
      /Atomic outputs are diagnostic\/reduced-order only and non-certifying/i.test(
        payload.text ?? "",
      )
    ) {
      failures.push("general_objective_leak:atomic_outputs_notice");
    }
    if (
      entry.family === "general" &&
      /\btargeting slots?\s*:/i.test(payload.text ?? "")
    ) {
      failures.push("general_objective_leak:targeting_slots");
    }
    if (
      entry.family === "general" &&
      /\(\s*missing\s*:[^)]+\)/i.test(payload.text ?? "")
    ) {
      failures.push("general_objective_leak:missing_slots_paren");
    }

    const objectiveLoopState = Array.isArray(debug.objective_loop_state)
      ? debug.objective_loop_state
      : [];
    const objectiveTransitionLog = Array.isArray(debug.objective_transition_log)
      ? debug.objective_transition_log
      : [];
    const objectiveRetrievalQueries = Array.isArray(debug.objective_retrieval_queries)
      ? debug.objective_retrieval_queries
      : [];
    const objectiveMiniAnswers = Array.isArray(debug.objective_mini_answers)
      ? debug.objective_mini_answers
      : [];
    const objectiveOesScoresRaw = Array.isArray(debug.objective_oes_scores)
      ? debug.objective_oes_scores
      : [];
    const objectiveOesScores = objectiveOesScoresRaw
      .map((entry) => Number((entry as Record<string, unknown>)?.score))
      .filter((score) => Number.isFinite(score));
    const objectiveOesAvgScore = objectiveOesScores.length
      ? objectiveOesScores.reduce((sum, score) => sum + score, 0) / objectiveOesScores.length
      : undefined;
    return {
      id: entry.id,
      label: entry.label,
      family: entry.family,
      question: entry.question,
      ok: failures.length === 0,
      failures,
      duration_ms: Date.now() - started,
      debug: {
        intent_id: debug.intent_id,
        intent_domain: debug.intent_domain,
        concept_id: String(debug.concept_id ?? ""),
        coverage_ratio:
          typeof debug.coverage_ratio === "number" ? debug.coverage_ratio : undefined,
        belief_unsupported_rate:
          typeof debug.belief_unsupported_rate === "number"
            ? debug.belief_unsupported_rate
            : undefined,
        context_files_count: Array.isArray(debug.context_files)
          ? debug.context_files.length
          : 0,
        objective_count:
          typeof debug.objective_count === "number"
            ? debug.objective_count
            : objectiveLoopState.length,
        objective_transition_count: objectiveTransitionLog.length,
        objective_retrieval_query_count: objectiveRetrievalQueries.length,
        objective_mini_answer_count: objectiveMiniAnswers.length,
        objective_mini_critic_mode:
          typeof debug.objective_mini_critic_mode === "string"
            ? debug.objective_mini_critic_mode
            : undefined,
        objective_assembly_mode:
          typeof debug.objective_assembly_mode === "string"
            ? debug.objective_assembly_mode
            : undefined,
        objective_assembly_blocked_reason:
          typeof debug.objective_assembly_blocked_reason === "string"
            ? debug.objective_assembly_blocked_reason
            : undefined,
        objective_finalize_gate_passed:
          typeof debug.objective_finalize_gate_passed === "boolean"
            ? debug.objective_finalize_gate_passed
            : undefined,
        objective_finalize_gate_mode:
          typeof debug.objective_finalize_gate_mode === "string"
            ? debug.objective_finalize_gate_mode
            : undefined,
        objective_unknown_block_count:
          typeof debug.objective_unknown_block_count === "number"
            ? debug.objective_unknown_block_count
            : undefined,
        objective_unresolved_without_unknown_block_count:
          typeof debug.objective_unresolved_without_unknown_block_count === "number"
            ? debug.objective_unresolved_without_unknown_block_count
            : undefined,
        objective_oes_score_count: objectiveOesScores.length,
        objective_oes_avg_score:
          typeof objectiveOesAvgScore === "number"
            ? Number(objectiveOesAvgScore.toFixed(4))
            : undefined,
        objective_terminalization_reason:
          typeof debug.objective_terminalization_reason === "string" ||
          debug.objective_terminalization_reason === null
            ? (debug.objective_terminalization_reason as string | null)
            : undefined,
        objective_loop_patch_revision: objectiveLoopPatchRevision || undefined,
        objective_scoped_retrieval_budget_bypass_applied:
          typeof debug.objective_scoped_retrieval_budget_bypass_applied === "boolean"
            ? debug.objective_scoped_retrieval_budget_bypass_applied
            : undefined,
        objective_scoped_retrieval_budget_bypass_count:
          typeof debug.objective_scoped_retrieval_budget_bypass_count === "number"
            ? debug.objective_scoped_retrieval_budget_bypass_count
            : undefined,
        objective_scoped_retrieval_recovery_applied:
          typeof debug.objective_scoped_retrieval_recovery_applied === "boolean"
            ? debug.objective_scoped_retrieval_recovery_applied
            : undefined,
        objective_scoped_retrieval_recovery_count:
          typeof debug.objective_scoped_retrieval_recovery_count === "number"
            ? debug.objective_scoped_retrieval_recovery_count
            : undefined,
        objective_scoped_retrieval_recovery_error_count:
          typeof debug.objective_scoped_retrieval_recovery_error_count === "number"
            ? debug.objective_scoped_retrieval_recovery_error_count
            : undefined,
        composer_soft_enforce_action: composerSoftEnforceAction || undefined,
        objective_loop_primary_composer_guard:
          typeof debug.objective_loop_primary_composer_guard === "boolean"
            ? objectiveLoopPrimaryComposerGuard
            : undefined,
        composer_family_degrade_suppressed:
          typeof debug.composer_family_degrade_suppressed === "boolean"
            ? composerFamilyDegradeSuppressed
            : undefined,
        composer_family_degrade_suppressed_reason:
          composerFamilyDegradeSuppressedReason || undefined,
        coverage_ratio_exempt_unknown_terminal:
          typeof debug.objective_finalize_gate_mode === "string" &&
          debug.objective_finalize_gate_mode === "unknown_terminal" &&
          debug.objective_finalize_gate_passed === true &&
          typeof debug.objective_unknown_block_count === "number" &&
          debug.objective_unknown_block_count > 0 &&
          typeof debug.objective_unresolved_without_unknown_block_count === "number" &&
          debug.objective_unresolved_without_unknown_block_count === 0,
      },
    };
  } catch (error) {
    const message =
      (error as { message?: string })?.message ??
      (typeof error === "string" ? error : "fetch_failed");
    return {
      id: entry.id,
      label: entry.label,
      family: entry.family,
      question: entry.question,
      ok: false,
      failures: [message],
      duration_ms: Date.now() - started,
      debug: null,
    };
  } finally {
    clearTimeout(timeout);
  }
};

const isRetryableProbeFailure = (result: ProbeResult): boolean => {
  if (result.ok) return false;
  const joined = result.failures.join(" ").toLowerCase();
  return (
    joined.includes("this operation was aborted") ||
    joined.includes("fetch_failed") ||
    joined.includes("request_failed:0") ||
    joined.includes("request_failed:408") ||
    joined.includes("request_failed:429") ||
    joined.includes("request_failed:500") ||
    joined.includes("request_failed:502") ||
    joined.includes("request_failed:503") ||
    joined.includes("request_failed:504")
  );
};

const askOne = async (entry: ProbeCase, runId: string): Promise<ProbeResult> => {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const result = await askOneAttempt(entry, runId);
    if (result.ok) return result;
    if (attempt >= MAX_RETRIES || !isRetryableProbeFailure(result)) {
      return result;
    }
    const delayMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
    await sleep(delayMs);
  }
  return {
    id: entry.id,
    label: entry.label,
    family: entry.family,
    question: entry.question,
    ok: false,
    failures: ["unexpected_retry_flow"],
    duration_ms: 0,
    debug: null,
  };
};

const buildReportMarkdown = (summary: ProbeSummary, results: ProbeResult[]): string => {
  const failed = results.filter((entry) => !entry.ok);
  const lines: string[] = [
    "# Helix Ask Patch Probe Report",
    "",
    `- run_id: ${summary.run_id}`,
    `- generated_at: ${summary.generated_at}`,
    `- base_url: ${summary.base_url}`,
    `- seed: ${summary.seed}`,
    `- sample_count: ${summary.sample_count}`,
    `- objective_loop_patch_revision_expected: ${summary.objective_loop_patch_revision_expected}`,
    `- objective_loop_patch_revision_required: ${String(summary.objective_loop_patch_revision_required)}`,
    `- general_degrade_suppression_required: ${String(REQUIRE_GENERAL_DEGRADE_SUPPRESSION)}`,
    `- objective_loop_patch_revision_pass_rate: ${(summary.objective_loop_patch_revision_pass_rate * 100).toFixed(1)}%`,
    `- pass_rate: ${(summary.pass_rate * 100).toFixed(1)}%`,
    `- plan_context_loaded: ${String(summary.plan_context.loaded)}`,
    `- plan_context_sha256: ${summary.plan_context.sha256 ?? "missing"}`,
    `- objective_sampled_cases: ${summary.objective_loop_snapshot.sampled_cases}`,
    `- objective_finalize_gate_pass_rate: ${(summary.objective_loop_snapshot.finalize_gate_pass_rate * 100).toFixed(1)}%`,
    `- objective_retrieval_success_rate: ${(summary.objective_loop_snapshot.retrieval_success_rate * 100).toFixed(1)}%`,
    `- objective_assembly_success_rate: ${(summary.objective_loop_snapshot.assembly_success_rate * 100).toFixed(1)}%`,
    `- objective_bypass_applied_rate: ${(summary.objective_loop_snapshot.bypass_applied_rate * 100).toFixed(1)}%`,
    `- objective_avg_bypass_count: ${summary.objective_loop_snapshot.avg_bypass_count.toFixed(2)}`,
    `- objective_recovery_applied_rate: ${(summary.objective_loop_snapshot.recovery_applied_rate * 100).toFixed(1)}%`,
    `- objective_avg_recovery_count: ${summary.objective_loop_snapshot.avg_recovery_count.toFixed(2)}`,
    `- objective_avg_transition_count: ${summary.objective_loop_snapshot.avg_transition_count.toFixed(2)}`,
    `- objective_oes_present_rate: ${(summary.objective_loop_snapshot.oes_present_rate * 100).toFixed(1)}%`,
    `- objective_avg_oes_score: ${summary.objective_loop_snapshot.avg_oes_score.toFixed(3)}`,
    "",
    "## Family Stats",
    "| family | total | pass | fail | pass_rate |",
    "|---|---:|---:|---:|---:|",
    ...summary.family_stats.map(
      (entry) =>
        `| ${entry.family} | ${entry.total} | ${entry.pass} | ${entry.fail} | ${(entry.pass_rate * 100).toFixed(1)}% |`,
    ),
    "",
    "## Failed Cases",
  ];

  if (!failed.length) {
    lines.push("- none");
  } else {
    for (const entry of failed) {
      lines.push(`### ${entry.label} (${entry.id})`);
      lines.push(`- family: ${entry.family}`);
      lines.push(`- failures: ${entry.failures.join(", ")}`);
      lines.push(`- intent_id: ${entry.debug?.intent_id ?? "missing"}`);
      lines.push(`- intent_domain: ${entry.debug?.intent_domain ?? "missing"}`);
      lines.push(`- concept_id: ${entry.debug?.concept_id ?? "missing"}`);
      lines.push(`- coverage_ratio: ${entry.debug?.coverage_ratio ?? "missing"}`);
      lines.push(
        `- coverage_ratio_exempt_unknown_terminal: ${entry.debug?.coverage_ratio_exempt_unknown_terminal ?? "missing"}`,
      );
      lines.push(
        `- belief_unsupported_rate: ${entry.debug?.belief_unsupported_rate ?? "missing"}`,
      );
      lines.push(`- objective_count: ${entry.debug?.objective_count ?? "missing"}`);
      lines.push(`- objective_transition_count: ${entry.debug?.objective_transition_count ?? "missing"}`);
      lines.push(`- objective_retrieval_query_count: ${entry.debug?.objective_retrieval_query_count ?? "missing"}`);
      lines.push(`- objective_mini_answer_count: ${entry.debug?.objective_mini_answer_count ?? "missing"}`);
      lines.push(`- objective_mini_critic_mode: ${entry.debug?.objective_mini_critic_mode ?? "missing"}`);
      lines.push(`- objective_assembly_mode: ${entry.debug?.objective_assembly_mode ?? "missing"}`);
      lines.push(`- objective_assembly_blocked_reason: ${entry.debug?.objective_assembly_blocked_reason ?? "missing"}`);
      lines.push(`- objective_finalize_gate_passed: ${entry.debug?.objective_finalize_gate_passed ?? "missing"}`);
      lines.push(`- objective_finalize_gate_mode: ${entry.debug?.objective_finalize_gate_mode ?? "missing"}`);
      lines.push(`- objective_unknown_block_count: ${entry.debug?.objective_unknown_block_count ?? "missing"}`);
      lines.push(
        `- objective_unresolved_without_unknown_block_count: ${entry.debug?.objective_unresolved_without_unknown_block_count ?? "missing"}`,
      );
      lines.push(`- objective_oes_score_count: ${entry.debug?.objective_oes_score_count ?? "missing"}`);
      lines.push(`- objective_oes_avg_score: ${entry.debug?.objective_oes_avg_score ?? "missing"}`);
      lines.push(`- objective_terminalization_reason: ${entry.debug?.objective_terminalization_reason ?? "missing"}`);
      lines.push(`- objective_loop_patch_revision: ${entry.debug?.objective_loop_patch_revision ?? "missing"}`);
      lines.push(
        `- objective_scoped_retrieval_budget_bypass_applied: ${entry.debug?.objective_scoped_retrieval_budget_bypass_applied ?? "missing"}`,
      );
      lines.push(
        `- objective_scoped_retrieval_budget_bypass_count: ${entry.debug?.objective_scoped_retrieval_budget_bypass_count ?? "missing"}`,
      );
      lines.push(
        `- objective_scoped_retrieval_recovery_applied: ${entry.debug?.objective_scoped_retrieval_recovery_applied ?? "missing"}`,
      );
      lines.push(
        `- objective_scoped_retrieval_recovery_count: ${entry.debug?.objective_scoped_retrieval_recovery_count ?? "missing"}`,
      );
      lines.push(
        `- objective_scoped_retrieval_recovery_error_count: ${entry.debug?.objective_scoped_retrieval_recovery_error_count ?? "missing"}`,
      );
      lines.push(
        `- composer_soft_enforce_action: ${entry.debug?.composer_soft_enforce_action ?? "missing"}`,
      );
      lines.push(
        `- objective_loop_primary_composer_guard: ${entry.debug?.objective_loop_primary_composer_guard ?? "missing"}`,
      );
      lines.push(
        `- composer_family_degrade_suppressed: ${entry.debug?.composer_family_degrade_suppressed ?? "missing"}`,
      );
      lines.push(
        `- composer_family_degrade_suppressed_reason: ${entry.debug?.composer_family_degrade_suppressed_reason ?? "missing"}`,
      );
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
};

async function main(): Promise<void> {
  const seed = resolveSeed();
  const runId = `helix-ask-patch-probe:${Date.now()}:${seed}`;
  const sampledCases = sampleCases(PROBE_BANK, SAMPLE_COUNT, seed);
  const planContext = await readPlanContext();

  if (REQUIRE_PLAN_CONTEXT && !planContext.loaded) {
    throw new Error(`Required plan context file not found: ${PLAN_PATH}`);
  }

  const results: ProbeResult[] = [];
  for (const entry of sampledCases) {
    console.log(`Running patch probe case: ${entry.label}`);
    const result = await askOne(entry, runId);
    results.push(result);
  }

  const passCount = results.filter((entry) => entry.ok).length;
  const failCount = results.length - passCount;
  const objectiveLoopRevisionRows = results.filter((entry) => {
    const revision = String(entry.debug?.objective_loop_patch_revision ?? "").trim();
    return revision.length > 0;
  });
  const objectiveLoopPatchRevisionPass = objectiveLoopRevisionRows.filter((entry) => {
    const revision = String(entry.debug?.objective_loop_patch_revision ?? "").trim();
    return revision === OBJECTIVE_LOOP_EXPECTED_PATCH_REVISION;
  }).length;
  const objectiveRows = results.filter((entry) => {
    if (!entry.debug) return false;
    const objectiveCount = Number(entry.debug.objective_count ?? 0);
    const transitionCount = Number(entry.debug.objective_transition_count ?? 0);
    const miniAnswerCount = Number(entry.debug.objective_mini_answer_count ?? 0);
    return objectiveCount > 0 || transitionCount > 0 || miniAnswerCount > 0;
  });
  const objectiveFinalizePass = objectiveRows.filter(
    (entry) => entry.debug?.objective_finalize_gate_passed === true,
  ).length;
  const objectiveRetrievalPass = objectiveRows.filter((entry) => {
    const objectiveCount = Math.max(0, Math.floor(Number(entry.debug?.objective_count ?? 0)));
    const retrievalCount = Math.max(
      0,
      Math.floor(Number(entry.debug?.objective_retrieval_query_count ?? 0)),
    );
    return objectiveCount > 0 ? retrievalCount >= objectiveCount : retrievalCount > 0;
  }).length;
  const objectiveAssemblyPass = objectiveRows.filter((entry) => {
    const objectiveCount = Math.max(0, Math.floor(Number(entry.debug?.objective_count ?? 0)));
    const miniAnswerCount = Math.max(
      0,
      Math.floor(Number(entry.debug?.objective_mini_answer_count ?? 0)),
    );
    const unresolvedWithoutUnknownCount = Math.max(
      0,
      Math.floor(
        Number(entry.debug?.objective_unresolved_without_unknown_block_count ?? 0),
      ),
    );
    const assemblyMode = String(entry.debug?.objective_assembly_mode ?? "").trim().toLowerCase();
    const assemblyOk = assemblyMode === "llm" || assemblyMode === "deterministic_fallback";
    return objectiveCount > 0
      ? assemblyOk &&
          miniAnswerCount >= objectiveCount &&
          unresolvedWithoutUnknownCount === 0
      : assemblyOk;
  }).length;
  const objectiveBypassApplied = objectiveRows.filter(
    (entry) => entry.debug?.objective_scoped_retrieval_budget_bypass_applied === true,
  ).length;
  const avgObjectiveBypassCount = objectiveRows.length
    ? objectiveRows.reduce(
        (sum, entry) =>
          sum +
          Math.max(
            0,
            Math.floor(
              Number(entry.debug?.objective_scoped_retrieval_budget_bypass_count ?? 0),
            ),
          ),
        0,
      ) / objectiveRows.length
    : 0;
  const objectiveRecoveryApplied = objectiveRows.filter(
    (entry) => entry.debug?.objective_scoped_retrieval_recovery_applied === true,
  ).length;
  const avgObjectiveRecoveryCount = objectiveRows.length
    ? objectiveRows.reduce(
        (sum, entry) =>
          sum +
          Math.max(
            0,
            Math.floor(
              Number(entry.debug?.objective_scoped_retrieval_recovery_count ?? 0),
            ),
          ),
        0,
      ) / objectiveRows.length
    : 0;
  const avgObjectiveTransitionCount = objectiveRows.length
    ? objectiveRows.reduce(
        (sum, entry) =>
          sum + Math.max(0, Math.floor(Number(entry.debug?.objective_transition_count ?? 0))),
        0,
      ) / objectiveRows.length
    : 0;
  const objectiveOesPresent = objectiveRows.filter((entry) => {
    const count = Number(entry.debug?.objective_oes_score_count ?? 0);
    return Number.isFinite(count) && count > 0;
  }).length;
  const avgObjectiveOesScore = objectiveRows.length
    ? objectiveRows.reduce((sum, entry) => {
        const score = Number(entry.debug?.objective_oes_avg_score ?? NaN);
        return sum + (Number.isFinite(score) ? score : 0);
      }, 0) / objectiveRows.length
    : 0;

  const families: ProbeFamily[] = [
    "ideology_social",
    "repo_technical",
    "hybrid",
    "general",
  ];
  const familyStats = families
    .map((family) => {
      const scoped = results.filter((entry) => entry.family === family);
      const pass = scoped.filter((entry) => entry.ok).length;
      const total = scoped.length;
      return {
        family,
        total,
        pass,
        fail: total - pass,
        pass_rate: total > 0 ? pass / total : 0,
      };
    })
    .filter((entry) => entry.total > 0);

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const outDir = path.resolve(OUTPUT_ROOT, stamp);
  await fs.mkdir(outDir, { recursive: true });

  const summary: ProbeSummary = {
    schema_version: "helix_ask_patch_probe/1",
    run_id: runId,
    generated_at: new Date().toISOString(),
    base_url: BASE_URL,
    ask_url: ASK_URL,
    seed,
    sample_count: sampledCases.length,
    total_cases_available: PROBE_BANK.length,
    objective_loop_patch_revision_expected: OBJECTIVE_LOOP_EXPECTED_PATCH_REVISION,
    objective_loop_patch_revision_required: REQUIRE_OBJECTIVE_LOOP_PATCH_REVISION,
    objective_loop_patch_revision_pass_rate:
      objectiveLoopRevisionRows.length > 0
        ? objectiveLoopPatchRevisionPass / objectiveLoopRevisionRows.length
        : 0,
    pass_count: passCount,
    fail_count: failCount,
    pass_rate: sampledCases.length > 0 ? passCount / sampledCases.length : 0,
    plan_context: {
      path: PLAN_PATH,
      required: REQUIRE_PLAN_CONTEXT,
      loaded: planContext.loaded,
      sha256: planContext.sha256,
    },
    family_stats: familyStats,
    artifacts: {
      output_dir: outDir,
      results_json: path.resolve(outDir, "results.json"),
      summary_json: path.resolve(outDir, "summary.json"),
      report_md: path.resolve(outDir, "report.md"),
    },
    objective_loop_snapshot: {
      sampled_cases: objectiveRows.length,
      finalize_gate_pass_rate:
        objectiveRows.length > 0 ? objectiveFinalizePass / objectiveRows.length : 0,
      retrieval_success_rate:
        objectiveRows.length > 0 ? objectiveRetrievalPass / objectiveRows.length : 0,
      assembly_success_rate:
        objectiveRows.length > 0 ? objectiveAssemblyPass / objectiveRows.length : 0,
      bypass_applied_rate:
        objectiveRows.length > 0 ? objectiveBypassApplied / objectiveRows.length : 0,
      avg_bypass_count: Number(avgObjectiveBypassCount.toFixed(2)),
      recovery_applied_rate:
        objectiveRows.length > 0 ? objectiveRecoveryApplied / objectiveRows.length : 0,
      avg_recovery_count: Number(avgObjectiveRecoveryCount.toFixed(2)),
      avg_transition_count: Number(avgObjectiveTransitionCount.toFixed(2)),
      oes_present_rate:
        objectiveRows.length > 0 ? objectiveOesPresent / objectiveRows.length : 0,
      avg_oes_score: Number(avgObjectiveOesScore.toFixed(4)),
    },
  };

  const report = buildReportMarkdown(summary, results);
  await fs.writeFile(summary.artifacts.results_json, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  await fs.writeFile(summary.artifacts.summary_json, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(summary.artifacts.report_md, report, "utf8");

  console.log(
    `Patch probe summary: pass=${summary.pass_count}/${summary.sample_count} fail=${summary.fail_count} passRate=${(summary.pass_rate * 100).toFixed(1)}%`,
  );
  console.log(`Artifacts: ${summary.artifacts.output_dir}`);

  if (FAIL_ON_MISS && summary.fail_count > 0) {
    process.exit(1);
  }
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  main().catch((error) => {
    console.error("[helix-ask-patch-probe] failed:", error);
    process.exit(1);
  });
}
