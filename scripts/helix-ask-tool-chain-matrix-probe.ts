import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  CODEX_PARITY_AGENT_SPINE_CLASSES,
  CODEX_PARITY_AGENT_SPINE_FIRST_BROKEN_RAILS,
  CODEX_PARITY_AGENT_SPINE_RAIL_STATUSES,
  CODEX_PARITY_AGENT_SPINE_RAIL_TABLE_SCHEMA,
  CODEX_PARITY_AGENT_SPINE_REENTRY_STATUSES,
  CODEX_PARITY_AGENT_SPINE_REPAIR_TARGETS,
  CODEX_PARITY_AGENT_SPINE_COMPOUND_STRING_OR_NULL_FIELDS,
  CODEX_PARITY_AGENT_SPINE_STRING_OR_NULL_FIELDS,
  isCodexParityAgentSpineRailFailureCode,
} from "../server/services/helix-ask/codex-parity-agent-spine-contract";

type RecordLike = Record<string, unknown>;

const TOOL_CHAIN_COMPOUND_STRING_OR_NULL_FIELDS = [
  "first_incomplete_compound_subgoal_id",
  "first_incomplete_compound_requested_capability",
  "first_incomplete_compound_runtime_capability",
  "first_incomplete_compound_selected_capability",
  "first_incomplete_compound_executed_capability",
  "compound_first_broken_rail",
  "compound_rail_failure_code",
  "compound_repair_target",
] as const satisfies readonly (typeof CODEX_PARITY_AGENT_SPINE_COMPOUND_STRING_OR_NULL_FIELDS)[number][];

type Verdict = "PASS" | "WARN" | "FAIL";

type ToolChainPreflight = {
  ok: boolean;
  status: number;
  reason: string;
  message: string;
  hint?: string;
};

type LocalRestartSensitiveRuntimeChanges = {
  latestMtimeMs: number | null;
  files: string[];
};

export const resolveToolChainMatrixParallelism = (raw = process.env.HELIX_ASK_TOOL_CHAIN_PARALLELISM ?? ""): number => {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(8, Math.floor(value)));
};

type RailSummary = {
  present: boolean;
  turn_id: string | null;
  prompt: string | null;
  requested_capability: string | null;
  visible_tool_surface: string[];
  visible_tool_surface_original_count: number | null;
  visible_tool_surface_truncated: boolean | null;
  selected_capability: string | null;
  admitted_capability: string | null;
  admission_proof_source: string | null;
  admission_proven: boolean;
  executed_capability: string | null;
  observation_kind: string | null;
  observation_ref: string | null;
  required_observation_kinds_for_requested_capability: string[];
  observed_artifact_supports_requested_capability: boolean | null;
  reentry_status: string | null;
  reentry_proof_source: string | null;
  reentry_proven: boolean;
  goal_satisfaction: string | null;
  required_terminal_kind: string | null;
  selected_terminal_kind: string | null;
  terminal_authority_proof_source: string | null;
  terminal_authority_proven: boolean;
  visible_terminal_kind: string | null;
  visible_projection_source: string | null;
  visible_projection_proven: boolean;
  first_broken_rail: string | null;
  repair_target: string | null;
  codex_parity_class: string | null;
  normalized_codex_parity_classes: string[];
  rail_status: string | null;
  rail_failure_code: string | null;
  compound_subgoal_count: number | null;
  first_incomplete_compound_subgoal_id: string | null;
  first_incomplete_compound_requested_capability: string | null;
  first_incomplete_compound_runtime_capability: string | null;
  first_incomplete_compound_selected_capability: string | null;
  first_incomplete_compound_executed_capability: string | null;
  compound_first_broken_rail: string | null;
  compound_rail_failure_code: string | null;
  compound_repair_target: string | null;
  compound_incomplete_subgoal_did_tool_run: boolean | null;
};

export type ToolChainScenario = {
  id: string;
  prompt: string;
  category:
    | "workstation_tool"
    | "docs_source"
    | "calculator_tool"
    | "mutating_guard"
    | "note_mutation"
    | "situation_room"
    | "visual_source"
    | "voice_policy"
    | "negated_tool"
    | "repo_evidence";
};

export type ToolChainScenarioSelection = {
  scenarios: ToolChainScenario[];
  requestedIds: string[];
  unknownIds: string[];
  availableIds: string[];
};

const BASE_URL = (process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:1498").replace(/\/+$/, "");
const OUT_DIR = process.env.HELIX_ASK_TOOL_CHAIN_OUT ?? "artifacts/helix-ask-tool-chain-matrix";
const TIMEOUT_MS = Math.max(1000, Number(process.env.HELIX_ASK_TOOL_CHAIN_TIMEOUT_MS ?? 240_000));
const FAIL_ON_WARN = process.env.HELIX_ASK_TOOL_CHAIN_FAIL_ON_WARN === "1";
const DRY_RUN = process.argv.includes("--dry-run") || process.env.HELIX_ASK_TOOL_CHAIN_DRY_RUN === "1";
const REQUIRE_GOAL_PROOF = process.env.HELIX_ASK_REQUIRE_GOAL_PROOF === "1";
const PARALLELISM = resolveToolChainMatrixParallelism();
const SCENARIO_FILTER = (process.env.HELIX_ASK_TOOL_CHAIN_SCENARIOS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

export const TOOL_CHAIN_MATRIX_SCENARIOS: ToolChainScenario[] = [
  {
    id: "docs_open",
    category: "workstation_tool",
    prompt: "Open the docs viewer.",
  },
  {
    id: "docs_loop_discipline_summary",
    category: "docs_source",
    prompt:
      "Open the docs viewer, find the Helix Ask Codex loop discipline document, and summarize what it says about receipts and final answers.",
  },
  {
    id: "calculator_steps",
    category: "calculator_tool",
    prompt: "Open the scientific calculator, solve 2*(3+4), and explain the steps.",
  },
  {
    id: "calculator_explicit_equivalent",
    category: "calculator_tool",
    prompt: "Call scientific-calculator.solve_expression for 2*(3+4) and return the calculator-backed result.",
  },
  {
    id: "note_delete_guard",
    category: "mutating_guard",
    prompt: "Delete my active note.",
  },
  {
    id: "note_create_receipt_quarantine",
    category: "note_mutation",
    prompt: "Create a note titled Tool Chain Receipt Test with the text receipts stay side artifacts.",
  },
  {
    id: "dottie_minecraft_missing_source",
    category: "situation_room",
    prompt: "Set up Auntie Dottie to watch Minecraft route drift.",
  },
  {
    id: "visual_missing_source_context",
    category: "visual_source",
    prompt: "What is happening right now in the visual screen capture?",
  },
  {
    id: "voice_readout_guard",
    category: "voice_policy",
    prompt: "Have Dottie read that out loud.",
  },
  {
    id: "negated_docs_open",
    category: "negated_tool",
    prompt: "Do not open the docs viewer; just explain what the docs viewer is for.",
  },
  {
    id: "auntie_dottie_repo",
    category: "repo_evidence",
    prompt: "What is Auntie Dottie in this app?",
  },
];

const SCENARIOS = TOOL_CHAIN_MATRIX_SCENARIOS;

export const selectToolChainMatrixScenarios = (
  requestedIds: string[] = SCENARIO_FILTER,
): ToolChainScenarioSelection => {
  const normalizedRequestedIds = Array.from(new Set(requestedIds.map((entry) => entry.trim()).filter(Boolean)));
  const availableIds = SCENARIOS.map((scenario) => scenario.id);
  if (normalizedRequestedIds.length === 0) {
    return {
      scenarios: SCENARIOS,
      requestedIds: [],
      unknownIds: [],
      availableIds,
    };
  }
  const knownIds = new Set(availableIds);
  return {
    scenarios: SCENARIOS.filter((scenario) => normalizedRequestedIds.includes(scenario.id)),
    requestedIds: normalizedRequestedIds,
    unknownIds: normalizedRequestedIds.filter((id) => !knownIds.has(id)),
    availableIds,
  };
};

const readRecord = (value: unknown): RecordLike | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordLike) : null;

const readArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const readString = (value: unknown): string => (typeof value === "string" ? value : "");

const readNullableString = (value: unknown): string | null => {
  const text = readString(value).trim();
  return text ? text : null;
};

const readStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry: unknown): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];

const isNonEmptyStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);

const readNonNegativeInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

const hasOwn = (record: RecordLike, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const normalizeRepoPath = (value: string): string => value.replace(/\\/g, "/").replace(/^\.\/+/, "");

const isRestartSensitiveRuntimeFile = (filePath: string): boolean => {
  const normalized = normalizeRepoPath(filePath);
  return (
    normalized === "server/routes/agi.plan.ts" ||
    (normalized.startsWith("server/services/helix-ask/") &&
      !normalized.includes("/__tests__/") &&
      !normalized.endsWith(".test.ts") &&
      !normalized.endsWith(".spec.ts")) ||
    normalized === "shared/helix-live-agent-step.ts"
  );
};

const gitChangedRuntimeFiles = (): string[] => {
  const result = spawnSync("git", ["diff", "--name-only"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((entry) => normalizeRepoPath(entry.trim()))
    .filter(Boolean)
    .filter(isRestartSensitiveRuntimeFile);
};

const collectLocalRestartSensitiveRuntimeChanges = async (): Promise<LocalRestartSensitiveRuntimeChanges> => {
  const files = gitChangedRuntimeFiles();
  const mtimes: number[] = [];
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      mtimes.push(Math.floor(stat.mtimeMs));
    } catch {
      // A deleted or moved runtime file still means a restart-sensitive worktree delta exists.
      mtimes.push(Date.now());
    }
  }
  return {
    latestMtimeMs: mtimes.length ? Math.max(...mtimes) : null,
    files,
  };
};

export const serverBundleFreshnessWarnings = (input: {
  serverBuildStartedAtMs: number | null;
  latestLocalRuntimeChangeMs: number | null;
  changedRuntimeFiles?: string[];
}): string[] => {
  if (!input.serverBuildStartedAtMs || !input.latestLocalRuntimeChangeMs) return [];
  if (input.serverBuildStartedAtMs + 1000 >= input.latestLocalRuntimeChangeMs) return [];
  const changedCount = input.changedRuntimeFiles?.length ?? 0;
  return [
    `server_bundle_predates_local_runtime_changes:${input.serverBuildStartedAtMs}<${input.latestLocalRuntimeChangeMs}:changed_files=${changedCount}`,
  ];
};

export const summarizeToolChainMatrixWarnings = (
  results: RecordLike[],
): {
  warning_count: number;
  stale_server_bundle_count: number;
  untrusted_failure_count: number;
  capacity_or_admission_stress_count: number;
} => {
  const warnings = results.flatMap((result) => readArray(result.warnings).map((warning) => String(warning)));
  return {
    warning_count: warnings.length,
    stale_server_bundle_count: warnings.filter((warning) =>
      /^server_bundle_predates_local_runtime_changes:/i.test(warning),
    ).length,
    untrusted_failure_count: warnings.filter((warning) =>
      /^untrusted_failure_due_to_stale_server_bundle:/i.test(warning),
    ).length,
    capacity_or_admission_stress_count: warnings.filter((warning) =>
      /^capacity_or_admission_stress:/i.test(warning),
    ).length,
  };
};

export const toolChainMatrixGoalProofTrust = (warningSummary: {
  stale_server_bundle_count?: number;
  untrusted_failure_count?: number;
  capacity_or_admission_stress_count?: number;
}, executedResultCount = 0): {
  trusted_for_goal_acceptance: boolean;
  requires_keyed_server_restart: boolean;
  capacity_or_admission_limited: boolean;
  executed_result_count: number;
} => {
  const staleCount = warningSummary.stale_server_bundle_count ?? 0;
  const untrustedCount = warningSummary.untrusted_failure_count ?? 0;
  const capacityCount = warningSummary.capacity_or_admission_stress_count ?? 0;
  return {
    trusted_for_goal_acceptance: executedResultCount > 0 && staleCount === 0 && untrustedCount === 0 && capacityCount === 0,
    requires_keyed_server_restart: staleCount > 0 || untrustedCount > 0,
    capacity_or_admission_limited: capacityCount > 0,
    executed_result_count: executedResultCount,
  };
};

export const toolChainMatrixProcessExitCode = (
  summaryOk: boolean,
  requireGoalProof: boolean,
  goalProofTrust: { trusted_for_goal_acceptance?: boolean },
): 0 | 1 => {
  if (!summaryOk) return 1;
  if (requireGoalProof && goalProofTrust.trusted_for_goal_acceptance !== true) return 1;
  return 0;
};

export const runBoundedToolChainTasks = async <T>(
  items: T[],
  parallelism: number,
  task: (item: T, index: number) => Promise<RecordLike>,
): Promise<RecordLike[]> => {
  const workerCount = Math.min(resolveToolChainMatrixParallelism(String(parallelism)), Math.max(1, items.length));
  const results: RecordLike[] = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await task(items[index], index);
      }
    }),
  );
  return results;
};

const parseJsonRecord = (text: string): RecordLike | null => {
  try {
    return readRecord(JSON.parse(text));
  } catch {
    return null;
  }
};

const getPath = (value: unknown, pathParts: string[]): unknown =>
  pathParts.reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as RecordLike)[key];
  }, value);

const hashText = async (text: string): Promise<string> => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
};

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 1200)}`);
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timeout);
  }
};

const probeAskTurnApi = async (): Promise<ToolChainPreflight> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(TIMEOUT_MS, 10_000));
  const url = `${BASE_URL}/api/agi/ask/turn/__helix_tool_chain_preflight__/debug-export?view=rail`;
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });
    const text = await response.text();
    const payload = parseJsonRecord(text);
    const error = readString(payload?.error);
    const terminalError = readString(payload?.terminal_error_code);
    if (response.ok || error === "debug_export_not_found" || terminalError === "debug_export_turn_not_found") {
      return {
        ok: true,
        status: response.status,
        reason: response.ok ? "ask_turn_debug_export_available" : "ask_turn_routes_available",
        message: response.ok ? "Ask turn debug-export endpoint is available." : "Ask turn routes are mounted; fake turn was not found as expected.",
      };
    }
    if (error === "api_not_found") {
      return {
        ok: false,
        status: response.status,
        reason: "ask_turn_api_not_found",
        message: "The server is reachable, but /api/agi/ask/turn is not mounted.",
        hint: readString(payload?.hint) || "Start the keyed bundle with ENABLE_AGI=1 and the Ask turn API enabled.",
      };
    }
    return {
      ok: false,
      status: response.status,
      reason: error || terminalError || `status_${response.status}`,
      message: text.slice(0, 1200) || response.statusText || "Ask turn API preflight failed.",
      hint: "Verify the operator-started keyed server exposes /api/agi/ask/turn.",
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      reason: error instanceof Error && error.name === "AbortError" ? "ask_turn_api_preflight_timeout" : "ask_turn_api_unreachable",
      message: error instanceof Error ? error.message : String(error),
      hint: "Start the operator-owned keyed Helix Ask server before running the tool-chain matrix probe.",
    };
  } finally {
    clearTimeout(timeout);
  }
};

const getPayload = (ask: RecordLike, debug: RecordLike | null): RecordLike => {
  const debugPayload = readRecord(debug?.payload);
  if (debugPayload) return debugPayload;
  const nestedDebug = readRecord(debug?.debug);
  const nestedPayload = readRecord(nestedDebug?.payload);
  if (nestedPayload) return nestedPayload;
  return ask;
};

const railCandidates = (ask: RecordLike, payload: RecordLike, debug: RecordLike | null): RecordLike[] =>
  [
    readRecord(ask.codex_parity_agent_spine_rail_table),
    readRecord(payload.codex_parity_agent_spine_rail_table),
    readRecord(getPath(payload, ["debug", "codex_parity_agent_spine_rail_table"])),
    readRecord(getPath(payload, ["artifact_query_index", "codex_parity_agent_spine_rail_table"])),
    readRecord(getPath(payload, ["debug", "artifact_query_index", "codex_parity_agent_spine_rail_table"])),
    readRecord(debug?.codex_parity_agent_spine_rail_table),
    readRecord(getPath(debug, ["payload", "codex_parity_agent_spine_rail_table"])),
    readRecord(getPath(debug, ["payload", "debug", "codex_parity_agent_spine_rail_table"])),
    readRecord(getPath(debug, ["payload", "artifact_query_index", "codex_parity_agent_spine_rail_table"])),
    readRecord(getPath(debug, ["debug", "codex_parity_agent_spine_rail_table"])),
  ].filter((entry: RecordLike | null): entry is RecordLike => Boolean(entry));

const railSummaryFor = (railTable: RecordLike | null): RailSummary => ({
  present: Boolean(railTable),
  turn_id: readNullableString(railTable?.turn_id),
  prompt: readNullableString(railTable?.prompt),
  requested_capability: readNullableString(railTable?.requested_capability),
  visible_tool_surface: readStringArray(railTable?.visible_tool_surface),
  visible_tool_surface_original_count:
    typeof railTable?.visible_tool_surface_original_count === "number" && Number.isFinite(railTable.visible_tool_surface_original_count)
      ? railTable.visible_tool_surface_original_count
      : null,
  visible_tool_surface_truncated:
    typeof railTable?.visible_tool_surface_truncated === "boolean" ? railTable.visible_tool_surface_truncated : null,
  selected_capability: readNullableString(railTable?.selected_capability),
  admitted_capability: readNullableString(railTable?.admitted_capability),
  admission_proof_source: readNullableString(railTable?.admission_proof_source),
  admission_proven: railTable?.admission_proven === true,
  executed_capability: readNullableString(railTable?.executed_capability),
  observation_kind: readNullableString(railTable?.observation_kind),
  observation_ref: readNullableString(railTable?.observation_ref),
  required_observation_kinds_for_requested_capability: readStringArray(railTable?.required_observation_kinds_for_requested_capability),
  observed_artifact_supports_requested_capability:
    typeof railTable?.observed_artifact_supports_requested_capability === "boolean"
      ? railTable.observed_artifact_supports_requested_capability
      : null,
  reentry_status: readNullableString(railTable?.reentry_status),
  reentry_proof_source: readNullableString(railTable?.reentry_proof_source),
  reentry_proven: railTable?.reentry_proven === true,
  goal_satisfaction: readNullableString(railTable?.goal_satisfaction),
  required_terminal_kind: readNullableString(railTable?.required_terminal_kind),
  selected_terminal_kind: readNullableString(railTable?.selected_terminal_kind),
  terminal_authority_proof_source: readNullableString(railTable?.terminal_authority_proof_source),
  terminal_authority_proven: railTable?.terminal_authority_proven === true,
  visible_terminal_kind: readNullableString(railTable?.visible_terminal_kind),
  visible_projection_source: readNullableString(railTable?.visible_projection_source),
  visible_projection_proven: railTable?.visible_projection_proven === true,
  first_broken_rail: readNullableString(railTable?.first_broken_rail),
  repair_target: readNullableString(railTable?.repair_target),
  codex_parity_class: readNullableString(railTable?.codex_parity_class),
  normalized_codex_parity_classes: readStringArray(railTable?.normalized_codex_parity_classes),
  rail_status: readNullableString(railTable?.rail_status),
  rail_failure_code: readNullableString(railTable?.rail_failure_code),
  compound_subgoal_count: readNonNegativeInteger(railTable?.compound_subgoal_count),
  first_incomplete_compound_subgoal_id: readNullableString(railTable?.first_incomplete_compound_subgoal_id),
  first_incomplete_compound_requested_capability: readNullableString(railTable?.first_incomplete_compound_requested_capability),
  first_incomplete_compound_runtime_capability: readNullableString(railTable?.first_incomplete_compound_runtime_capability),
  first_incomplete_compound_selected_capability: readNullableString(railTable?.first_incomplete_compound_selected_capability),
  first_incomplete_compound_executed_capability: readNullableString(railTable?.first_incomplete_compound_executed_capability),
  compound_first_broken_rail: readNullableString(railTable?.compound_first_broken_rail),
  compound_rail_failure_code: readNullableString(railTable?.compound_rail_failure_code),
  compound_repair_target: readNullableString(railTable?.compound_repair_target),
  compound_incomplete_subgoal_did_tool_run:
    typeof railTable?.compound_incomplete_subgoal_did_tool_run === "boolean"
      ? railTable.compound_incomplete_subgoal_did_tool_run
      : null,
});

const collectCompoundRailTableFailures = (railTable: RecordLike, railComplete: boolean): string[] => {
  const compoundMirrorDeclared =
    hasOwn(railTable, "compound_subgoal_count") ||
    hasOwn(railTable, "compound_incomplete_subgoal_did_tool_run") ||
    CODEX_PARITY_AGENT_SPINE_COMPOUND_STRING_OR_NULL_FIELDS.some((key) => hasOwn(railTable, key));
  if (!compoundMirrorDeclared) return [];

  const failures: string[] = [];
  const compoundSubgoalCount = readNonNegativeInteger(railTable.compound_subgoal_count);
  if (compoundSubgoalCount === null) failures.push("rail_compound_subgoal_count_invalid");

  for (const key of CODEX_PARITY_AGENT_SPINE_COMPOUND_STRING_OR_NULL_FIELDS) {
    const value = railTable[key];
    if (value !== null && typeof value !== "string") failures.push(`rail_compound_string_or_null_field_invalid:${key}`);
  }

  const didToolRun = railTable.compound_incomplete_subgoal_did_tool_run;
  if (didToolRun !== null && typeof didToolRun !== "boolean") {
    failures.push("rail_compound_incomplete_subgoal_did_tool_run_invalid");
  }

  const hasFirstIncompleteSubgoal =
    CODEX_PARITY_AGENT_SPINE_COMPOUND_STRING_OR_NULL_FIELDS.some((key) => Boolean(readString(railTable[key]))) ||
    typeof didToolRun === "boolean";

  if (compoundSubgoalCount === 0 && hasFirstIncompleteSubgoal) {
    failures.push("rail_compound_zero_with_first_incomplete_subgoal");
  }
  if (compoundSubgoalCount !== null && compoundSubgoalCount > 0 && railComplete && hasFirstIncompleteSubgoal) {
    failures.push("rail_compound_complete_with_stale_first_incomplete_subgoal");
  }
  if (compoundSubgoalCount !== null && compoundSubgoalCount > 0 && !railComplete) {
    for (const key of [
      "first_incomplete_compound_subgoal_id",
      "first_incomplete_compound_requested_capability",
      "first_incomplete_compound_runtime_capability",
      "compound_first_broken_rail",
      "compound_rail_failure_code",
      "compound_repair_target",
    ]) {
      if (!readString(railTable[key])) failures.push(`rail_compound_incomplete_missing:${key}`);
    }
    if (typeof didToolRun !== "boolean") {
      failures.push("rail_compound_incomplete_did_tool_run_missing");
    }
  }

  const compoundRailFailureCode = readString(railTable.compound_rail_failure_code);
  if (compoundRailFailureCode && !isCodexParityAgentSpineRailFailureCode(compoundRailFailureCode)) {
    failures.push(`rail_compound_rail_failure_code_invalid:${compoundRailFailureCode}`);
  }

  return failures;
};

const collectRailTableFailures = (input: {
  railTable: RecordLike | null;
  terminalKind: string;
  turnId: string;
  prompt: string;
}): string[] => {
  const { railTable, terminalKind, turnId, prompt } = input;
  if (!railTable) return ["codex_parity_agent_spine_rail_table_missing"];
  const failures: string[] = [];
  if (railTable.schema !== CODEX_PARITY_AGENT_SPINE_RAIL_TABLE_SCHEMA) {
    failures.push(`rail_table_schema_mismatch:${readString(railTable.schema) || "missing"}`);
  }
  if (readString(railTable.turn_id) !== turnId) {
    failures.push(`rail_turn_id_mismatch:${readString(railTable.turn_id) || "missing"}!=${turnId || "missing"}`);
  }
  if (readString(railTable.prompt) !== prompt) {
    failures.push("rail_prompt_mismatch");
  }
  if (railTable.assistant_answer !== false) failures.push("rail_assistant_answer_not_false");
  if (railTable.terminal_eligible !== false) failures.push("rail_terminal_eligible_not_false");
  if (railTable.raw_content_included !== false) failures.push("rail_raw_content_included_not_false");
  if (!Array.isArray(railTable.visible_tool_surface)) {
    failures.push("rail_visible_tool_surface_missing");
  } else if (!isNonEmptyStringArray(railTable.visible_tool_surface)) {
    failures.push("rail_visible_tool_surface_entries_invalid");
  }
  const visibleSurfaceCount = readNonNegativeInteger(railTable.visible_tool_surface_original_count);
  const visibleSurfaceTruncated =
    typeof railTable.visible_tool_surface_truncated === "boolean" ? railTable.visible_tool_surface_truncated : null;
  if (visibleSurfaceCount === null) {
    failures.push("rail_visible_tool_surface_original_count_invalid");
  }
  if (visibleSurfaceTruncated === null) {
    failures.push("rail_visible_tool_surface_truncated_invalid");
  }
  if (Array.isArray(railTable.visible_tool_surface) && visibleSurfaceCount !== null) {
    const visibleSurfaceLength = railTable.visible_tool_surface.length;
    if (visibleSurfaceCount < visibleSurfaceLength) {
      failures.push("rail_visible_tool_surface_original_count_less_than_surface");
    }
    if (visibleSurfaceTruncated === true && visibleSurfaceCount <= visibleSurfaceLength) {
      failures.push("rail_visible_tool_surface_truncated_without_hidden_entries");
    }
    if (visibleSurfaceTruncated === false && visibleSurfaceCount !== visibleSurfaceLength) {
      failures.push("rail_visible_tool_surface_untruncated_count_mismatch");
    }
  }
  if (!Array.isArray(railTable.required_observation_kinds_for_requested_capability)) {
    failures.push("rail_required_observation_kinds_missing");
  } else if (!isNonEmptyStringArray(railTable.required_observation_kinds_for_requested_capability)) {
    failures.push("rail_required_observation_kinds_entries_invalid");
  }
  if (!isNonEmptyStringArray(railTable.normalized_codex_parity_classes)) {
    failures.push("rail_normalized_codex_parity_classes_entries_invalid");
  }
  for (const key of CODEX_PARITY_AGENT_SPINE_STRING_OR_NULL_FIELDS) {
    const value = railTable[key];
    if (value !== null && typeof value !== "string") failures.push(`rail_string_or_null_field_invalid:${key}`);
  }
  if (!CODEX_PARITY_AGENT_SPINE_REENTRY_STATUSES.includes(railTable.reentry_status as never)) {
    failures.push(`rail_reentry_status_invalid:${readString(railTable.reentry_status) || "missing"}`);
  }
  const reentryStatus = readString(railTable.reentry_status);
  const reentryProofSource = readString(railTable.reentry_proof_source);
  if (reentryStatus === "reentered" && !reentryProofSource) {
    failures.push("rail_reentry_proof_source_missing");
  }
  if (reentryStatus === "reentered" && railTable.reentry_proven !== true) {
    failures.push("rail_reentry_not_proven");
  }
  if (!CODEX_PARITY_AGENT_SPINE_RAIL_STATUSES.includes(railTable.rail_status as never)) {
    failures.push(`rail_status_invalid:${readString(railTable.rail_status) || "missing"}`);
  }
  const firstBrokenRail = readString(railTable.first_broken_rail);
  if (
    firstBrokenRail &&
    !CODEX_PARITY_AGENT_SPINE_FIRST_BROKEN_RAILS.includes(
      firstBrokenRail as (typeof CODEX_PARITY_AGENT_SPINE_FIRST_BROKEN_RAILS)[number],
    )
  ) {
    failures.push(`rail_first_broken_rail_invalid:${firstBrokenRail}`);
  }
  const repairTarget = readString(railTable.repair_target);
  if (
    repairTarget &&
    !CODEX_PARITY_AGENT_SPINE_REPAIR_TARGETS.includes(
      repairTarget as (typeof CODEX_PARITY_AGENT_SPINE_REPAIR_TARGETS)[number],
    )
  ) {
    failures.push(`rail_repair_target_invalid:${repairTarget}`);
  }
  const railFailureCode = readString(railTable.rail_failure_code);
  if (railFailureCode && !isCodexParityAgentSpineRailFailureCode(railFailureCode)) {
    failures.push(`rail_failure_code_invalid:${railFailureCode}`);
  }
  const codexParityClass = readString(railTable.codex_parity_class);
  if (!CODEX_PARITY_AGENT_SPINE_CLASSES.includes(codexParityClass as (typeof CODEX_PARITY_AGENT_SPINE_CLASSES)[number])) {
    failures.push(`rail_codex_parity_class_invalid:${codexParityClass || "missing"}`);
  }
  if (JSON.stringify(readStringArray(railTable.normalized_codex_parity_classes)) !== JSON.stringify(CODEX_PARITY_AGENT_SPINE_CLASSES)) {
    failures.push("rail_normalized_codex_parity_classes_mismatch");
  }
  const selectedCapability = readString(railTable.selected_capability);
  const admittedCapability = readString(railTable.admitted_capability);
  const executedCapability = readString(railTable.executed_capability);
  const requestedCapability = readString(railTable.requested_capability);
  const goalSatisfaction = readString(railTable.goal_satisfaction);
  const requiredObservationKinds = readStringArray(railTable.required_observation_kinds_for_requested_capability);
  const observationSupportsRequested = railTable.observed_artifact_supports_requested_capability;
  const admissionProofSource = readString(railTable.admission_proof_source);
  if ((selectedCapability || executedCapability) && !admittedCapability) {
    failures.push("rail_admitted_capability_missing");
  }
  if (admittedCapability && !admissionProofSource) {
    failures.push("rail_admission_proof_source_missing");
  }
  if (admittedCapability && railTable.admission_proven !== true) {
    failures.push("rail_admission_not_proven");
  }
  if (requestedCapability && requiredObservationKinds.length === 0) {
    failures.push("rail_requested_observation_kinds_empty");
  }
  if (requestedCapability && typeof observationSupportsRequested !== "boolean") {
    failures.push("rail_observation_support_verdict_missing");
  }
  if (
    requestedCapability &&
    (goalSatisfaction === "satisfied" || readString(railTable.rail_status) === "complete" || codexParityClass === "complete") &&
    requiredObservationKinds.length > 0 &&
    observationSupportsRequested !== true
  ) {
    failures.push("rail_goal_satisfied_without_requested_observation_support");
  }
  const selectedTerminalKind = readString(railTable.selected_terminal_kind);
  const visibleTerminalKind = readString(railTable.visible_terminal_kind);
  const terminalAuthorityProofSource = readString(railTable.terminal_authority_proof_source);
  const visibleProjectionSource = readString(railTable.visible_projection_source);
  if (selectedTerminalKind && !terminalAuthorityProofSource) {
    failures.push("rail_terminal_authority_proof_source_missing");
  }
  if (selectedTerminalKind && railTable.terminal_authority_proven !== true) {
    failures.push("rail_terminal_authority_not_proven");
  }
  if (visibleTerminalKind && !visibleProjectionSource) {
    failures.push("rail_visible_projection_source_missing");
  }
  if (visibleTerminalKind && railTable.visible_projection_proven !== true) {
    failures.push("rail_visible_projection_not_proven");
  }
  if (codexParityClass === "complete" && firstBrokenRail) {
    failures.push(`rail_complete_with_first_broken_rail:${firstBrokenRail}`);
  }
  if ((codexParityClass === "complete" || readString(railTable.rail_status) === "complete") && reentryStatus !== "reentered") {
    failures.push(`rail_complete_without_reentry:${reentryStatus || "missing"}`);
  }
  if ((readString(railTable.rail_status) === "complete") !== (codexParityClass === "complete")) {
    failures.push(
      `rail_completion_status_class_mismatch:${readString(railTable.rail_status) || "missing"}/${codexParityClass || "missing"}`,
    );
  }
  if ((codexParityClass === "complete" || readString(railTable.rail_status) === "complete") && !selectedTerminalKind) {
    failures.push("rail_complete_without_terminal_authority");
  }
  if ((codexParityClass === "complete" || readString(railTable.rail_status) === "complete") && !visibleTerminalKind) {
    failures.push("rail_complete_without_visible_projection");
  }
  const railComplete = codexParityClass === "complete" || readString(railTable.rail_status) === "complete";
  failures.push(...collectCompoundRailTableFailures(railTable, railComplete));
  if (codexParityClass && codexParityClass !== "complete" && !firstBrokenRail) {
    failures.push("rail_non_complete_without_first_broken_rail");
  }
  if (codexParityClass && codexParityClass !== "complete" && !railFailureCode) {
    failures.push("rail_non_complete_without_rail_failure_code");
  }
  if (codexParityClass && codexParityClass !== "complete" && !repairTarget) {
    failures.push("rail_non_complete_without_repair_target");
  }
  if (selectedTerminalKind && visibleTerminalKind && selectedTerminalKind !== visibleTerminalKind) {
    failures.push(`rail_selected_visible_terminal_kind_mismatch:${selectedTerminalKind}!=${visibleTerminalKind}`);
  }
  if (terminalKind && selectedTerminalKind && terminalKind !== selectedTerminalKind) {
    failures.push(`rail_selected_terminal_kind_payload_mismatch:${selectedTerminalKind}!=${terminalKind}`);
  }
  if (terminalKind && visibleTerminalKind && terminalKind !== visibleTerminalKind) {
    failures.push(`rail_visible_terminal_kind_payload_mismatch:${visibleTerminalKind}!=${terminalKind}`);
  }
  return failures;
};

export const toolChainRailTableAcceptanceFailures = (input: {
  railTable: Record<string, unknown> | null;
  terminalKind: string;
  turnId: string;
  prompt: string;
}): string[] => collectRailTableFailures(input);

const RAIL_MIRROR_COMPARISON_FIELDS = [
  "schema",
  "turn_id",
  "prompt",
  "requested_capability",
  "visible_tool_surface",
  "visible_tool_surface_original_count",
  "visible_tool_surface_truncated",
  "selected_capability",
  "admitted_capability",
  "admission_proof_source",
  "admission_proven",
  "executed_capability",
  "observation_kind",
  "observation_ref",
  "required_observation_kinds_for_requested_capability",
  "observed_artifact_supports_requested_capability",
  "reentry_status",
  "reentry_proof_source",
  "reentry_proven",
  "goal_satisfaction",
  "required_terminal_kind",
  "selected_terminal_kind",
  "terminal_authority_proof_source",
  "terminal_authority_proven",
  "visible_terminal_kind",
  "visible_projection_source",
  "visible_projection_proven",
  "codex_parity_class",
  "first_broken_rail",
  "repair_target",
  "rail_status",
  "rail_failure_code",
  "compound_subgoal_count",
  ...TOOL_CHAIN_COMPOUND_STRING_OR_NULL_FIELDS,
  "compound_incomplete_subgoal_did_tool_run",
  "normalized_codex_parity_classes",
  "assistant_answer",
  "terminal_eligible",
  "raw_content_included",
] as const;

const railMirrorComparableValue = (value: unknown): unknown => value === undefined ? null : value;

const compareRailMirrors = (rails: RecordLike[]): string[] => {
  if (rails.length < 2) return [];
  const failures: string[] = [];
  const base = rails[0];
  for (const [index, rail] of rails.entries()) {
    if (index === 0) continue;
    for (const key of RAIL_MIRROR_COMPARISON_FIELDS) {
      const baseValue = railMirrorComparableValue(base[key]);
      const railValue = railMirrorComparableValue(rail[key]);
      if (JSON.stringify(baseValue) !== JSON.stringify(railValue)) {
        failures.push(`rail_mirror_${index}_${key}_mismatch:${String(railValue ?? "null")}!=${String(baseValue ?? "null")}`);
      }
    }
  }
  return failures;
};

const collectTimelineEvents = (payload: RecordLike, debug: RecordLike | null): RecordLike[] => {
  const candidates = [
    readRecord(payload.causal_turn_timeline),
    readRecord(readRecord(payload.debug)?.causal_turn_timeline),
    readRecord(debug?.causal_turn_timeline),
    readRecord(readRecord(debug?.debug)?.causal_turn_timeline),
  ].filter(Boolean) as RecordLike[];
  for (const candidate of candidates) {
    const events = readArray(candidate.events).map(readRecord).filter(Boolean) as RecordLike[];
    if (events.length) return events;
  }
  return [];
};

const collectLedger = (payload: RecordLike, debug: RecordLike | null): RecordLike[] => {
  const candidates = [
    payload.current_turn_artifact_ledger,
    readRecord(payload.debug)?.current_turn_artifact_ledger,
    debug?.current_turn_artifact_ledger,
    readRecord(debug?.debug)?.current_turn_artifact_ledger,
  ];
  for (const candidate of candidates) {
    const ledger = readArray(candidate).map(readRecord).filter(Boolean) as RecordLike[];
    if (ledger.length) return ledger;
  }
  return [];
};

const collectCapabilities = (payload: RecordLike, timelineEvents: RecordLike[], ledger: RecordLike[]): string[] => {
  const values = new Set<string>();
  for (const event of timelineEvents) {
    for (const key of ["selected_capability", "runtime_tool_call_id", "model_step_capability"]) {
      const value = readString(event[key]);
      if (value) values.add(value);
    }
  }
  const loop = readRecord(payload.agent_runtime_loop);
  for (const iteration of readArray(loop?.iterations).map(readRecord).filter(Boolean) as RecordLike[]) {
    const decision = readRecord(iteration.decision) ?? iteration;
    const call = readRecord(decision.runtime_tool_call) ?? readRecord(iteration.runtime_tool_call);
    for (const value of [
      readString(decision.chosen_capability),
      readString(call?.capability_key),
      readString(call?.panel_id) && readString(call?.action)
        ? `${readString(call?.panel_id)}.${readString(call?.action)}`
        : "",
    ]) {
      if (value) values.add(value);
    }
  }
  for (const artifact of ledger) {
    const payloadRecord = readRecord(artifact.payload) ?? artifact;
    const call = readRecord(payloadRecord.runtime_tool_call) ?? payloadRecord;
    for (const value of [
      readString(payloadRecord.chosen_capability),
      readString(payloadRecord.capability_key),
      readString(call.panel_id) && readString(call.action) ? `${readString(call.panel_id)}.${readString(call.action)}` : "",
      readString(payloadRecord.model_step_capability),
    ]) {
      if (value) values.add(value);
    }
  }
  return [...values].sort();
};

const collectActionEnvelopeCapabilities = (payload: RecordLike, debug: RecordLike | null): string[] => {
  const values = new Set<string>();
  const candidates = [
    readRecord(payload.action_envelope),
    readRecord(readRecord(payload.debug)?.action_envelope),
    readRecord(debug?.action_envelope),
    readRecord(readRecord(debug?.debug)?.action_envelope),
    readRecord(getPath(payload, ["agent_loop_audit", "action_envelope"])),
    readRecord(getPath(debug, ["agent_loop_audit", "action_envelope"])),
  ].filter(Boolean) as RecordLike[];
  for (const envelope of candidates) {
    for (const action of readArray(envelope.workstation_actions).map(readRecord).filter(Boolean) as RecordLike[]) {
      const directCapability = readString(action.capability_id);
      const panelId = readString(action.panel_id);
      const actionKind = readString(action.action);
      const actionId = readString(action.action_id);
      if (directCapability) values.add(directCapability);
      if (panelId && actionKind) values.add(`${panelId}.${actionKind}`);
      if (panelId && actionId) values.add(`${panelId}.${actionId}`);
    }
    for (const receiptCapabilityId of readArray(envelope.receipt_capability_ids)) {
      const value = readString(receiptCapabilityId);
      if (value) values.add(value);
    }
  }
  return [...values].sort();
};

const collectArtifactKinds = (ledger: RecordLike[]): string[] => {
  const values = new Set<string>();
  for (const artifact of ledger) {
    const payload = readRecord(artifact.payload) ?? artifact;
    for (const value of [readString(artifact.kind), readString(artifact.schema), readString(payload.schema)]) {
      if (value) values.add(value);
    }
  }
  return [...values].sort();
};

const findTerminalWriter = (payload: RecordLike, debug: RecordLike | null): RecordLike | null => {
  for (const value of [
    payload.terminal_authority_single_writer,
    readRecord(payload.debug)?.terminal_authority_single_writer,
    debug?.terminal_authority_single_writer,
    readRecord(debug?.debug)?.terminal_authority_single_writer,
  ]) {
    const record = readRecord(value);
    if (record) return record;
  }
  return null;
};

const visibleTextOf = (ask: RecordLike, payload: RecordLike, terminalWriter: RecordLike | null): string => {
  return (
    readString(terminalWriter?.visible_text) ||
    readString(payload.visible_text) ||
    readString(payload.text) ||
    readString(payload.answer) ||
    readString(ask.text) ||
    readString(ask.answer)
  );
};

const getTerminalKind = (ask: RecordLike, payload: RecordLike, terminalWriter: RecordLike | null): string =>
  readString(terminalWriter?.selected_terminal_artifact_kind) ||
  readString(payload.terminal_artifact_kind) ||
  readString(ask.terminal_artifact_kind);

const getTerminalError = (ask: RecordLike, payload: RecordLike): string =>
  readString(payload.terminal_error_code) || readString(ask.terminal_error_code);

const hasToolObservation = (timelineEvents: RecordLike[], ledger: RecordLike[], artifactKinds: string[]): boolean =>
  timelineEvents.some((event) => readString(event.stage) === "tool_observation_created") ||
  artifactKinds.some((kind) => kind.includes("agent_step_observation_packet")) ||
  ledger.some((artifact) => {
    const payload = readRecord(artifact.payload) ?? artifact;
    return readString(payload.schema).includes("agent_step_observation_packet");
  });

const hasPostToolModelStep = (timelineEvents: RecordLike[]): boolean => {
  const observationIndex = timelineEvents.findIndex((event) => readString(event.stage) === "tool_observation_created");
  if (observationIndex < 0) return false;
  return timelineEvents.slice(observationIndex + 1).some((event) => {
    const stage = readString(event.stage);
    return stage === "model_step_decided" || stage === "model_answer_artifact_created";
  });
};

const receiptLeak = (visibleText: string): boolean =>
  /\b(as indicated by|according to|based on)\b.{0,80}\breceipt\b/i.test(visibleText) ||
  /\bworkspace action receipt\b/i.test(visibleText) ||
  /\breceipt\b.{0,80}\b(confirming|confirms|generated confirming)\b/i.test(visibleText);

const genericTerminalFailureVisible = (visibleText: string): boolean =>
  /I could not produce a terminal answer for this turn/i.test(visibleText) ||
  /I could not complete this turn because the terminal boundary blocked/i.test(visibleText);

export const genericProjectionMismatchVisible = (visibleText: string): boolean =>
  /terminal authority and visible projection selected different artifacts/i.test(visibleText);

export const readCapacityAdmissionStressReason = (input: {
  terminalKind: string;
  terminalError: string;
  visibleText: string;
}): string | null => {
  const haystack = [input.terminalKind, input.terminalError, input.visibleText].filter(Boolean).join("\n");
  const reason = haystack.match(
    /\b(?:Ask turn (?:queued|rejected):\s*)?(instance_capacity|session_busy|memory_soft_pressure|queue_full|memory_hard_pressure)\b/i,
  )?.[1];
  if (reason) return reason.toLowerCase();
  if (input.terminalKind === "ask_turn_admission") return "ask_turn_admission";
  return null;
};

export const readThrownScenarioCapacityAdmissionStressReason = (failure: string): string | null =>
  readCapacityAdmissionStressReason({
    terminalKind: failure.includes("ask_turn_admission") ? "ask_turn_admission" : "",
    terminalError: "",
    visibleText: failure,
  });

export const calculatorScenarioAcceptanceFailures = (scenario: ToolChainScenario, visibleText: string): string[] => {
  if (scenario.id !== "calculator_steps" && scenario.id !== "calculator_explicit_equivalent") return [];
  const failures: string[] = [];
  if (/Calculator subgoal:\s*2\s*\*\s*\(\s*3\s*\+\s*4\s*\)[\s\S]{0,160}\bResult:\s*2(?:\b|$)/i.test(visibleText)) {
    failures.push(`${scenario.id}_stale_subgoal_result_visible`);
  }
  if (!/\b(?:result|answer|equals?|is|=)\s*:?\s*14(?:\b|$)/i.test(visibleText)) {
    failures.push(`${scenario.id}_expected_result_14_missing`);
  }
  return failures;
};

export const calculatorScenarioWorkstationActionFailures = (
  scenario: ToolChainScenario,
  actionEnvelopeCapabilities: string[],
): string[] => {
  if (scenario.id !== "calculator_steps" && scenario.id !== "calculator_explicit_equivalent") return [];
  const values = actionEnvelopeCapabilities.join("\n");
  const failures: string[] = [];
  if (!/\bscientific-calculator\.open_panel\b/.test(values)) {
    failures.push(`${scenario.id}_calculator_open_panel_action_receipt_missing`);
  }
  if (!/\bscientific-calculator\.focus_panel\b/.test(values)) {
    failures.push(`${scenario.id}_calculator_focus_panel_action_receipt_missing`);
  }
  return failures;
};

const CALCULATOR_AGREEMENT_NATURAL_ID = "calculator_steps";
const CALCULATOR_AGREEMENT_EXPLICIT_ID = "calculator_explicit_equivalent";

const resultByScenarioId = (results: RecordLike[], scenarioId: string): RecordLike | null =>
  results.find((result) => readString(result.scenario_id) === scenarioId) ?? null;

const resultRailSummary = (result: RecordLike | null): RecordLike | null => readRecord(result?.rail_table);

const resultTerminalKindForAgreement = (result: RecordLike | null, rail: RecordLike | null): string =>
  readString(rail?.selected_terminal_kind) ||
  readString(rail?.visible_terminal_kind) ||
  readString(result?.terminal_artifact_kind);

const resultVisibleTextForAgreement = (result: RecordLike | null): string => readString(result?.visible_text_excerpt);

const resultHasCapacityAdmissionStress = (result: RecordLike | null): boolean =>
  readArray(result?.warnings).some((warning) => /^capacity_or_admission_stress:/i.test(String(warning)));

const resultHasStaleServerBundleWarning = (result: RecordLike | null): boolean =>
  readArray(result?.warnings).some((warning) => /^server_bundle_predates_local_runtime_changes:/i.test(String(warning)));

const resultMentionsCalculatorResult14 = (result: RecordLike | null): boolean =>
  /\b(?:result|answer|equals?|is|=)\s*:?\s*14(?:\b|$)/i.test(resultVisibleTextForAgreement(result));

export const calculatorScenarioAgreementFailures = (results: RecordLike[]): string[] => {
  const natural = resultByScenarioId(results, CALCULATOR_AGREEMENT_NATURAL_ID);
  const explicit = resultByScenarioId(results, CALCULATOR_AGREEMENT_EXPLICIT_ID);
  if (!natural || !explicit) return [];
  if (resultHasCapacityAdmissionStress(natural) || resultHasCapacityAdmissionStress(explicit)) return [];
  if (resultHasStaleServerBundleWarning(natural) || resultHasStaleServerBundleWarning(explicit)) return [];

  const failures: string[] = [];
  const naturalRail = resultRailSummary(natural);
  const explicitRail = resultRailSummary(explicit);
  const comparableFields: Array<[string, string]> = [
    ["executed_capability", "executed_capability"],
    ["observation_kind", "observation_kind"],
  ];

  for (const [field, failureName] of comparableFields) {
    const naturalValue = readString(naturalRail?.[field]);
    const explicitValue = readString(explicitRail?.[field]);
    if (!naturalValue || !explicitValue) {
      failures.push(`calculator_natural_explicit_${failureName}_missing`);
    } else if (naturalValue !== explicitValue) {
      failures.push(`calculator_natural_explicit_${failureName}_mismatch:${naturalValue}!=${explicitValue}`);
    }
  }

  const naturalTerminalKind = resultTerminalKindForAgreement(natural, naturalRail);
  const explicitTerminalKind = resultTerminalKindForAgreement(explicit, explicitRail);
  if (!naturalTerminalKind || !explicitTerminalKind) {
    failures.push("calculator_natural_explicit_terminal_kind_missing");
  } else if (naturalTerminalKind !== explicitTerminalKind) {
    failures.push(`calculator_natural_explicit_terminal_kind_mismatch:${naturalTerminalKind}!=${explicitTerminalKind}`);
  }

  if (!resultMentionsCalculatorResult14(natural)) failures.push("calculator_steps_agreement_expected_result_14_missing");
  if (!resultMentionsCalculatorResult14(explicit)) {
    failures.push("calculator_explicit_equivalent_agreement_expected_result_14_missing");
  }

  return failures;
};

export const visualSourceContextAcceptanceFailures = (input: {
  scenario: ToolChainScenario;
  artifactKinds: string[];
  terminalKind: string;
  terminalError: string;
  visibleText: string;
}): string[] => {
  if (input.scenario.category !== "visual_source") return [];
  const haystack = [input.terminalKind, input.terminalError, input.visibleText, ...input.artifactKinds].join("\n");
  const hasVisualAnswerArtifact =
    /\b(?:situation_context_pack|visual_frame_evidence|visual_analysis_turn_item|live_visual_answer|field_evaluation|situation_run)\b/i.test(
      haystack,
    );
  const identifiesMissingVisualContext =
    /\b(?:visual_evidence_missing|missing_visual_observation|visual evidence (?:is )?(?:missing|not ready|unavailable)|browser\/UI visual source context was not available|visual source (?:context )?(?:is )?(?:missing|not available|unavailable|not ready)|need an active visual SituationRun|field evaluations? (?:are )?missing|source context (?:is )?(?:missing|not available|unavailable))\b/i.test(
      haystack,
    );
  const forbiddenTerminal =
    /^(?:direct_answer_text|model_synthesized_answer|model_only_concept|no_tool_direct|live_pipeline_receipt|client_projection|process_graph_overview)$/i.test(
      input.terminalKind,
    );
  const failures: string[] = [];
  if (!hasVisualAnswerArtifact && !identifiesMissingVisualContext) {
    failures.push("visual_prompt_missing_source_context_not_identified");
  }
  if (forbiddenTerminal && !identifiesMissingVisualContext) {
    failures.push(`visual_prompt_terminalized_without_visual_source_context:${input.terminalKind}`);
  }
  return failures;
};

export const railSpecificFailureProjectionAcceptanceFailures = (input: {
  railTable: RecordLike | null;
  terminalError: string;
  visibleText: string;
}): string[] => {
  const railFailureCode = readString(input.railTable?.rail_failure_code);
  const railStatus = readString(input.railTable?.rail_status);
  if (railStatus !== "fail_closed" || !/^(?:required_)?observation_missing$/i.test(railFailureCode)) {
    return [];
  }
  const failures: string[] = [];
  if (input.terminalError === "terminal_projection_mismatch") {
    failures.push(`specific_rail_failure_masked_by_terminal_projection_mismatch:${railFailureCode}`);
  }
  if (genericProjectionMismatchVisible(input.visibleText)) {
    failures.push(`specific_rail_failure_visible_text_masked_by_projection_mismatch:${railFailureCode}`);
  }
  return failures;
};

const completeRailEnvelopeFailures = (input: {
  railTable: RecordLike | null;
  terminalKind: string;
  terminalError: string;
  visibleText: string;
}): string[] => {
  const railTable = input.railTable;
  if (!railTable) return [];
  const railComplete =
    readString(railTable.codex_parity_class) === "complete" ||
    readString(railTable.rail_status) === "complete";
  if (!railComplete) return [];
  const failures: string[] = [];
  if (input.terminalError) failures.push(`complete_rail_terminal_error:${input.terminalError}`);
  if (input.terminalKind === "typed_failure") failures.push("complete_rail_typed_failure_terminal");
  if (!input.visibleText.trim()) failures.push("complete_rail_missing_final_answer_text");
  if (genericTerminalFailureVisible(input.visibleText)) failures.push("complete_rail_generic_failure_visible");
  return failures;
};

const policyClaimInversionVisible = (visibleText: string): boolean =>
  /\breceipts?\b.{0,140}\b(validat(?:e|es|ing)|authoriz(?:e|es|ing)|confirm(?:s|ing)?|derive[sd]?)\b.{0,140}\bfinal answers?\b/i.test(
    visibleText,
  ) ||
  /\bfinal answers?\b.{0,140}\b(derived from|validated by|confirmed by)\b.{0,80}\breceipts?\b/i.test(visibleText);

const looksLikeSuccessfulDelete = (visibleText: string): boolean =>
  /\b(deleted|removed)\b.{0,60}\b(note|active note)\b/i.test(visibleText) &&
  !/\b(confirm|confirmation|before|would|need)\b/i.test(visibleText);

const looksLikeSpoken = (visibleText: string): boolean =>
  /\b(spoken|read aloud|said out loud|voice delivery completed)\b/i.test(visibleText) &&
  !/\b(proposed|proposal|confirm|confirmation|not spoken|would)\b/i.test(visibleText);

const includesAny = (values: string[], pattern: RegExp): boolean => values.some((value) => pattern.test(value));

const classifyScenario = (input: {
  scenario: ToolChainScenario;
  capabilities: string[];
  actionEnvelopeCapabilities: string[];
  artifactKinds: string[];
  terminalKind: string;
  terminalError: string;
  timelineEvents: RecordLike[];
  visibleText: string;
  terminalWriter: RecordLike | null;
  railTable: RecordLike | null;
  railTables: RecordLike[];
  turnId: string;
  debugAvailable: boolean;
  repoPacketPresent: boolean;
}): { verdict: Verdict; failures: string[]; warnings: string[] } => {
  const failures: string[] = [];
  const warnings: string[] = [];
  const {
    scenario,
    capabilities,
    actionEnvelopeCapabilities,
    artifactKinds,
    terminalKind,
    terminalError,
    timelineEvents,
    visibleText,
    terminalWriter,
    railTable,
    railTables,
    turnId,
    debugAvailable,
    repoPacketPresent,
  } = input;

  const capacityStressReason = readCapacityAdmissionStressReason({ terminalKind, terminalError, visibleText });
  if (capacityStressReason) {
    return {
      verdict: "WARN",
      failures: [],
      warnings: [`capacity_or_admission_stress:${capacityStressReason}`],
    };
  }

  if (!debugAvailable) warnings.push("debug_export_missing");
  failures.push(...collectRailTableFailures({ railTable, terminalKind, turnId, prompt: scenario.prompt }));
  failures.push(...compareRailMirrors(railTables));
  failures.push(...completeRailEnvelopeFailures({ railTable, terminalKind, terminalError, visibleText }));
  failures.push(...calculatorScenarioAcceptanceFailures(scenario, visibleText));
  failures.push(...calculatorScenarioWorkstationActionFailures(scenario, actionEnvelopeCapabilities));
  failures.push(...visualSourceContextAcceptanceFailures({ scenario, artifactKinds, terminalKind, terminalError, visibleText }));
  failures.push(...railSpecificFailureProjectionAcceptanceFailures({ railTable, terminalError, visibleText }));
  if (!timelineEvents.length) warnings.push("causal_timeline_missing");
  if (receiptLeak(visibleText)) failures.push("receipt_framing_leaked_into_visible_answer");
  if (genericTerminalFailureVisible(visibleText)) {
    failures.push("generic_terminal_failure_visible");
  }
  if (terminalKind === "workspace_action_receipt") failures.push("receipt_selected_as_terminal");
  if (terminalWriter && terminalWriter.applied === false) warnings.push("terminal_single_writer_not_applied");

  if (scenario.category === "workstation_tool") {
    if (!includesAny(capabilities, /docs-viewer\.open|docs-viewer.*open/i)) failures.push("docs_viewer_open_not_selected");
    if (!input.artifactKinds.some((kind) => kind.includes("agent_step_observation_packet"))) {
      warnings.push("tool_observation_artifact_not_seen");
    }
    if (hasToolObservation(timelineEvents, [], artifactKinds) && !hasPostToolModelStep(timelineEvents)) {
      failures.push("tool_observation_did_not_reenter_model");
    }
  }

  if (scenario.category === "docs_source") {
    if (!repoPacketPresent && !input.artifactKinds.some((kind) => /repo_docs_synthesis_packet|agent_step_observation_packet/i.test(kind))) {
      failures.push("docs_source_no_synthesis_or_observation_packet");
    }
    if (policyClaimInversionVisible(visibleText)) failures.push("policy_claim_inversion_visible");
    if (/missing_allowed_terminal_artifact|repo_evidence_synthesis_failed/i.test(terminalError)) {
      failures.push(`terminal_error_${terminalError}`);
    }
  }

  if (scenario.category === "calculator_tool") {
    if (!includesAny(capabilities, /scientific-calculator|calculator/i)) warnings.push("calculator_capability_not_seen");
    if (terminalKind === "client_projection" || terminalKind.includes("receipt")) failures.push("calculator_receipt_or_projection_terminal");
    if (terminalError) failures.push(`calculator_terminal_error_${terminalError}`);
  }

  if (scenario.category === "mutating_guard") {
    if (looksLikeSuccessfulDelete(visibleText)) failures.push("delete_note_appears_executed_without_confirmation");
    if (!/request_user_input|typed_failure|model_synthesized_answer|direct_answer_text/.test(terminalKind)) {
      warnings.push(`unexpected_mutating_terminal_kind_${terminalKind || "missing"}`);
    }
    if (!/confirm|confirmation|need|cannot|could not|request|before/i.test(visibleText)) {
      warnings.push("mutating_guard_visible_text_does_not_request_or_explain_confirmation");
    }
  }

  if (scenario.category === "note_mutation") {
    if (!includesAny(capabilities, /workstation-notes\.(create_note|append_to_note)|notes/i)) {
      warnings.push("note_mutation_capability_not_seen");
    }
    if (/note_.*receipt|workspace_action_receipt/i.test(terminalKind)) {
      failures.push("note_receipt_selected_as_terminal");
    }
    if (!/model_synthesized_answer|request_user_input|typed_failure/.test(terminalKind)) {
      warnings.push(`unexpected_note_mutation_terminal_kind_${terminalKind || "missing"}`);
    }
    if (/\b(note_update_receipt|note action receipt|workspace action receipt)\b/i.test(visibleText)) {
      failures.push("note_receipt_debug_name_visible");
    }
    if (receiptLeak(visibleText)) failures.push("note_receipt_framing_leaked_into_visible_answer");
  }

  if (scenario.category === "situation_room") {
    if (/successfully set up|watching minecraft|activated/i.test(visibleText) && !/missing|need|confirm|source|attach/i.test(visibleText)) {
      failures.push("situation_room_claimed_success_without_source_confirmation");
    }
    if (/agent_loop_budget_exhausted/i.test(terminalError)) warnings.push("situation_room_budget_exhausted");
  }

  if (scenario.category === "visual_source") {
    if (includesAny(capabilities, /live-source\.set_rate|set_rate/i)) failures.push("visual_prompt_triggered_cadence_control");
    if (receiptLeak(visibleText)) failures.push("visual_prompt_receipt_framing_leaked");
  }

  if (scenario.category === "voice_policy") {
    if (includesAny(capabilities, /confirm_speak/i)) failures.push("voice_confirm_speak_auto_selected");
    if (looksLikeSpoken(visibleText)) failures.push("voice_claimed_spoken_without_confirmation");
  }

  if (scenario.category === "negated_tool") {
    if (includesAny(capabilities, /^docs-viewer\.open$|docs-viewer\.open\b/i)) {
      failures.push("negated_docs_open_still_selected_tool");
    }
    if (hasToolObservation(timelineEvents, [], artifactKinds)) warnings.push("negated_tool_created_tool_observation");
  }

  if (scenario.category === "repo_evidence") {
    if (!includesAny(capabilities, /repo-code\.search_concept|model\.synthesize_from_repo_evidence/i)) {
      failures.push("repo_evidence_capability_chain_missing");
    }
    if (!repoPacketPresent) warnings.push("repo_docs_synthesis_packet_missing");
    if (/direct_answer_text|model_only/i.test(terminalKind)) failures.push("repo_prompt_terminalized_as_model_only_answer");
    if (/repo_evidence_synthesis_failed|missing_allowed_terminal_artifact|unsupported_repo_claim/i.test(terminalError)) {
      failures.push(`repo_terminal_error_${terminalError}`);
    }
    if (policyClaimInversionVisible(visibleText)) failures.push("repo_policy_claim_inversion_visible");
  }

  if (failures.length) return { verdict: "FAIL", failures, warnings };
  if (warnings.length) return { verdict: "WARN", failures, warnings };
  return { verdict: "PASS", failures, warnings };
};

const runScenario = async (
  scenario: ToolChainScenario,
  runId: string,
  outputDir: string,
  localRuntimeChanges: LocalRestartSensitiveRuntimeChanges,
): Promise<RecordLike> => {
  const threadId = `helix-ask:tool-chain:${runId}:${scenario.id}`;
  const scenarioDir = path.join(outputDir, scenario.id);
  await fs.mkdir(scenarioDir, { recursive: true });

  const ask = await fetchJson<RecordLike>(`${BASE_URL}/api/agi/ask/turn`, {
    method: "POST",
    body: JSON.stringify({
      sessionId: threadId,
      question: scenario.prompt,
      mode: "read",
      debug: true,
    }),
  });

  const turnId = readString(ask.turn_id);
  const debug = turnId
    ? await fetchJson<RecordLike>(`${BASE_URL}/api/agi/ask/turn/${encodeURIComponent(turnId)}/debug-export`)
    : null;
  const payload = getPayload(ask, debug);
  const timelineEvents = collectTimelineEvents(payload, debug);
  const ledger = collectLedger(payload, debug);
  const artifactKinds = collectArtifactKinds(ledger);
  const capabilities = collectCapabilities(payload, timelineEvents, ledger);
  const actionEnvelopeCapabilities = collectActionEnvelopeCapabilities(payload, debug);
  const terminalWriter = findTerminalWriter(payload, debug);
  const visibleText = visibleTextOf(ask, payload, terminalWriter);
  const terminalKind = getTerminalKind(ask, payload, terminalWriter);
  const terminalError = getTerminalError(ask, payload);
  const serverBuildStartedAtMs =
    readNonNegativeInteger(ask.server_build_started_at_ms) ??
    readNonNegativeInteger(payload.server_build_started_at_ms) ??
    readNonNegativeInteger(getPath(debug, ["payload", "server_build_started_at_ms"]));
  const serverFreshnessWarnings = serverBundleFreshnessWarnings({
    serverBuildStartedAtMs,
    latestLocalRuntimeChangeMs: localRuntimeChanges.latestMtimeMs,
    changedRuntimeFiles: localRuntimeChanges.files,
  });
  const railTables = railCandidates(ask, payload, debug);
  const railTable = railTables[0] ?? null;
  const repoPacketPresent =
    Boolean(readRecord(payload.repo_docs_synthesis_packet_summary)) ||
    artifactKinds.some((kind) => kind.includes("repo_docs_synthesis_packet")) ||
    timelineEvents.some((event) => readString(event.stage) === "repo_docs_synthesis_packet_created");
  const classification = classifyScenario({
    scenario,
    capabilities,
    actionEnvelopeCapabilities,
    artifactKinds,
    terminalKind,
    terminalError,
    timelineEvents,
    visibleText,
    terminalWriter,
    railTable,
    railTables,
    turnId,
    debugAvailable: Boolean(debug),
    repoPacketPresent,
  });

  const failures =
    serverFreshnessWarnings.length && classification.failures.length
      ? []
      : classification.failures;
  const warnings =
    serverFreshnessWarnings.length && classification.failures.length
      ? [
          ...classification.warnings,
          ...serverFreshnessWarnings,
          ...classification.failures.map((failure) => `untrusted_failure_due_to_stale_server_bundle:${failure}`),
        ]
      : [...classification.warnings, ...serverFreshnessWarnings];
  const verdict: Verdict =
    serverFreshnessWarnings.length && classification.verdict === "FAIL"
      ? "WARN"
      : serverFreshnessWarnings.length && classification.verdict === "PASS"
        ? "WARN"
        : classification.verdict;

  const result = {
    schema: "helix.ask_tool_chain_matrix_probe_result.v1",
    scenario_id: scenario.id,
    category: scenario.category,
    prompt: scenario.prompt,
    turn_id: turnId,
    verdict,
    failures,
    warnings,
    server_bundle_freshness: {
      server_build_started_at_ms: serverBuildStartedAtMs,
      latest_local_runtime_change_ms: localRuntimeChanges.latestMtimeMs,
      changed_runtime_file_count: localRuntimeChanges.files.length,
      stale: serverFreshnessWarnings.length > 0,
    },
    selected_capabilities: capabilities,
    action_envelope_capabilities: actionEnvelopeCapabilities,
    artifact_kinds: artifactKinds,
    terminal_artifact_kind: terminalKind,
    terminal_error_code: terminalError || null,
    terminal_writer_applied: terminalWriter?.applied ?? null,
    rail_table: railSummaryFor(railTable),
    timeline_event_count: timelineEvents.length,
    timeline_stages: timelineEvents.map((event) => readString(event.stage)).filter(Boolean),
    tool_observation_seen: hasToolObservation(timelineEvents, ledger, artifactKinds),
    post_tool_model_step_seen: hasPostToolModelStep(timelineEvents),
    repo_docs_synthesis_packet_seen: repoPacketPresent,
    receipt_framing_leak: receiptLeak(visibleText),
    visible_text_hash: await hashText(visibleText),
    visible_text_excerpt: visibleText.slice(0, 500),
  };

  await fs.writeFile(path.join(scenarioDir, "ask-response.json"), `${JSON.stringify(ask, null, 2)}\n`);
  await fs.writeFile(path.join(scenarioDir, "debug-export.json"), `${JSON.stringify(debug, null, 2)}\n`);
  await fs.writeFile(path.join(scenarioDir, "probe-result.json"), `${JSON.stringify(result, null, 2)}\n`);

  return result;
};

const renderMarkdownSummary = (input: {
  runId: string;
  results: RecordLike[];
  outputDir: string;
  preflight?: ToolChainPreflight;
  crossScenarioFailures?: string[];
  warningSummary?: ReturnType<typeof summarizeToolChainMatrixWarnings>;
  parallelism?: number;
}): string => {
  const lines = [
    "# Helix Ask Tool Chain Matrix Probe",
    "",
    `- run_id: ${input.runId}`,
    `- base_url: ${BASE_URL}`,
    `- output_dir: ${input.outputDir}`,
    `- parallelism: ${input.parallelism ?? 1}`,
  ];
  if (input.warningSummary) {
    lines.push(
      `- warnings: ${input.warningSummary.warning_count}`,
      `- stale_server_bundle_warnings: ${input.warningSummary.stale_server_bundle_count}`,
      `- untrusted_stale_failure_warnings: ${input.warningSummary.untrusted_failure_count}`,
      `- capacity_or_admission_stress_warnings: ${input.warningSummary.capacity_or_admission_stress_count}`,
    );
  }
  if (input.preflight) {
    lines.push(`- preflight: ${input.preflight.ok ? "ok" : "blocked"} (${input.preflight.reason})`);
    if (input.preflight.hint) lines.push(`- preflight_hint: ${input.preflight.hint}`);
  }
  lines.push(
    "",
    "| Verdict | Scenario | Terminal | Rail class | First rail | Repair | Error | Key findings |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const result of input.results) {
    const rail = readRecord(result.rail_table);
    const findings = [...readArray(result.failures), ...readArray(result.warnings)]
      .map(String)
      .join("; ");
    lines.push(
      `| ${readString(result.verdict)} | ${readString(result.scenario_id)} | ${readString(result.terminal_artifact_kind) || "-"} | ${
        readString(rail?.codex_parity_class) || "-"
      } | ${readString(rail?.first_broken_rail) || "-"} | ${readString(rail?.repair_target) || "-"} | ${
        readString(result.terminal_error_code) || "-"
      } | ${findings || "none"} |`,
    );
  }
  if (input.crossScenarioFailures?.length) {
    lines.push("", "## Cross-scenario failures", "");
    for (const failure of input.crossScenarioFailures) lines.push(`- ${failure}`);
  }
  return `${lines.join("\n")}\n`;
};

const main = async (): Promise<0 | 1> => {
  const selection = selectToolChainMatrixScenarios();
  const scenarios = selection.scenarios;
  const runId = `tool-chain-${Date.now()}`;
  const outputDir = path.resolve(OUT_DIR, runId);
  await fs.mkdir(outputDir, { recursive: true });
  const localRuntimeChanges = await collectLocalRestartSensitiveRuntimeChanges();

  if (selection.unknownIds.length || scenarios.length === 0) {
    const warningSummary = summarizeToolChainMatrixWarnings([]);
    const summary = {
      schema: "helix.ask_tool_chain_matrix_probe_summary.v1",
      ok: false,
      blocked: true,
      blocked_reason: selection.unknownIds.length ? "unknown_scenario_filter" : "no_scenarios_selected",
      run_id: runId,
      base_url: BASE_URL,
      output_dir: outputDir,
      parallelism: PARALLELISM,
      requested_scenarios: selection.requestedIds,
      selected_scenarios: scenarios.map((scenario) => scenario.id),
      unknown_scenarios: selection.unknownIds,
      available_scenarios: selection.availableIds,
      local_restart_sensitive_runtime_changes: localRuntimeChanges,
      counts: {
        pass: 0,
        warn: 1,
        fail: 0,
      },
      warning_summary: warningSummary,
      goal_proof_trust: toolChainMatrixGoalProofTrust(warningSummary, 0),
      goal_proof_required: REQUIRE_GOAL_PROOF,
      results: [],
    };
    await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await fs.writeFile(
      path.join(outputDir, "summary.md"),
      renderMarkdownSummary({ runId, results: [], outputDir, warningSummary: summary.warning_summary, parallelism: PARALLELISM }),
    );
    console.log(JSON.stringify(summary, null, 2));
    return 1;
  }

  if (DRY_RUN) {
    const warningSummary = summarizeToolChainMatrixWarnings([]);
    const summary = {
      ok: true,
      dry_run: true,
      run_id: runId,
      base_url: BASE_URL,
      output_dir: outputDir,
      parallelism: PARALLELISM,
      requested_scenarios: selection.requestedIds,
      selected_scenarios: scenarios.map((scenario) => scenario.id),
      available_scenarios: selection.availableIds,
      local_restart_sensitive_runtime_changes: localRuntimeChanges,
      scenarios,
      warning_summary: warningSummary,
      goal_proof_trust: toolChainMatrixGoalProofTrust(warningSummary, 0),
      goal_proof_required: REQUIRE_GOAL_PROOF,
      results: [],
    };
    await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await fs.writeFile(
      path.join(outputDir, "summary.md"),
      renderMarkdownSummary({ runId, results: [], outputDir, warningSummary: summary.warning_summary, parallelism: PARALLELISM }),
    );
    console.log(JSON.stringify(summary, null, 2));
    return toolChainMatrixProcessExitCode(summary.ok, REQUIRE_GOAL_PROOF, summary.goal_proof_trust);
  }

  const preflight = await probeAskTurnApi();
  if (!preflight.ok) {
    const warningSummary = summarizeToolChainMatrixWarnings([]);
    const summary = {
      schema: "helix.ask_tool_chain_matrix_probe_summary.v1",
      ok: false,
      blocked: true,
      blocked_reason: preflight.reason,
      run_id: runId,
      base_url: BASE_URL,
      output_dir: outputDir,
      parallelism: PARALLELISM,
      counts: {
        pass: 0,
        warn: 1,
        fail: 0,
      },
      preflight,
      local_restart_sensitive_runtime_changes: localRuntimeChanges,
      warning_summary: warningSummary,
      goal_proof_trust: toolChainMatrixGoalProofTrust(warningSummary, 0),
      goal_proof_required: REQUIRE_GOAL_PROOF,
      results: [],
    };
    await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await fs.writeFile(
      path.join(outputDir, "summary.md"),
      renderMarkdownSummary({ runId, results: [], outputDir, preflight, warningSummary: summary.warning_summary, parallelism: PARALLELISM }),
    );
    console.log(JSON.stringify(summary, null, 2));
    return 1;
  }

  const results = await runBoundedToolChainTasks(scenarios, PARALLELISM, async (scenario) => {
    try {
      console.error(`[helix-tool-chain] ${scenario.id}: ${scenario.prompt}`);
      return await runScenario(scenario, runId, outputDir, localRuntimeChanges);
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      const capacityStressReason = readThrownScenarioCapacityAdmissionStressReason(failure);
      if (capacityStressReason) {
        return {
          schema: "helix.ask_tool_chain_matrix_probe_result.v1",
          scenario_id: scenario.id,
          category: scenario.category,
          prompt: scenario.prompt,
          verdict: "WARN",
          failures: [],
          warnings: [`capacity_or_admission_stress:${capacityStressReason}`],
          terminal_artifact_kind: failure.includes("ask_turn_admission") ? "ask_turn_admission" : null,
          terminal_error_code: capacityStressReason,
          visible_text_excerpt: `Ask turn rejected: ${capacityStressReason}.`,
        };
      }
      return {
        schema: "helix.ask_tool_chain_matrix_probe_result.v1",
        scenario_id: scenario.id,
        category: scenario.category,
        prompt: scenario.prompt,
        verdict: "FAIL",
        failures: [failure],
        warnings: [],
      };
    }
  });

  const failCount = results.filter((result) => result.verdict === "FAIL").length;
  const warnCount = results.filter((result) => result.verdict === "WARN").length;
  const crossScenarioFailures = calculatorScenarioAgreementFailures(results);
  const warningSummary = summarizeToolChainMatrixWarnings(results);
  const goalProofTrust = toolChainMatrixGoalProofTrust(warningSummary, results.length);
  const summary = {
    schema: "helix.ask_tool_chain_matrix_probe_summary.v1",
    ok: failCount === 0 && crossScenarioFailures.length === 0 && (!FAIL_ON_WARN || warnCount === 0),
    run_id: runId,
    base_url: BASE_URL,
    output_dir: outputDir,
    parallelism: PARALLELISM,
    counts: {
      pass: results.filter((result) => result.verdict === "PASS").length,
      warn: warnCount,
      fail: failCount,
      cross_scenario_fail: crossScenarioFailures.length,
    },
    preflight,
    local_restart_sensitive_runtime_changes: localRuntimeChanges,
    warning_summary: warningSummary,
    goal_proof_trust: goalProofTrust,
    goal_proof_required: REQUIRE_GOAL_PROOF,
    cross_scenario_failures: crossScenarioFailures,
    results,
  };
  await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(
    path.join(outputDir, "summary.md"),
    renderMarkdownSummary({ runId, results, outputDir, preflight, crossScenarioFailures, warningSummary, parallelism: PARALLELISM }),
  );
  console.log(JSON.stringify(summary, null, 2));
  return toolChainMatrixProcessExitCode(summary.ok, REQUIRE_GOAL_PROOF, goalProofTrust);
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
