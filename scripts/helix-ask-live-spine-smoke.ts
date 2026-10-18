import fs from "node:fs/promises";
import path from "node:path";
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
import { HELIX_TOOL_RAIL_TERMINAL_FAILURE_RECONCILIATION_VERSION } from "../server/services/helix-ask/terminal-rail-failure-reconciliation";

type RecordLike = Record<string, unknown>;

const LIVE_SPINE_COMPOUND_STRING_OR_NULL_FIELDS = [
  "first_incomplete_compound_subgoal_id",
  "first_incomplete_compound_requested_capability",
  "first_incomplete_compound_runtime_capability",
  "first_incomplete_compound_selected_capability",
  "first_incomplete_compound_executed_capability",
  "compound_first_broken_rail",
  "compound_rail_failure_code",
  "compound_repair_target",
] as const satisfies readonly (typeof CODEX_PARITY_AGENT_SPINE_COMPOUND_STRING_OR_NULL_FIELDS)[number][];

type Verdict = "PASS" | "FAIL";
type ExpectedValue = string | null | Array<string | null>;
export type LiveSpineCoverage =
  | "calculator"
  | "docs"
  | "repo_code"
  | "workspace_directory"
  | "workspace_status"
  | "live_source_mail"
  | "internet_search"
  | "scholarly_research"
  | "theory_context_reflection"
  | "visual_capture"
  | "image_lens"
  | "capability_catalog"
  | "civilization_bounds"
  | "moral_graph_reflection"
  | "negated_contextual_tool_mentions";

export const REQUIRED_LIVE_SPINE_COVERAGE: LiveSpineCoverage[] = [
  "calculator",
  "docs",
  "repo_code",
  "workspace_directory",
  "workspace_status",
  "live_source_mail",
  "internet_search",
  "scholarly_research",
  "theory_context_reflection",
  "visual_capture",
  "image_lens",
  "capability_catalog",
  "civilization_bounds",
  "moral_graph_reflection",
  "negated_contextual_tool_mentions",
];

type LiveSmokePreflight = {
  ok: boolean;
  status: number;
  reason: string;
  message: string;
  hint?: string;
};

export type LiveSpineScenarioSelection = {
  scenarios: LiveSpineScenario[];
  requestedIds: string[];
  unknownIds: string[];
};

export type LiveSpineCoverageSummary = {
  required: LiveSpineCoverage[];
  covered: LiveSpineCoverage[];
  missing: LiveSpineCoverage[];
  complete: boolean;
};

export type LiveSpineScenario = {
  id: string;
  prompt: string;
  coverage: LiveSpineCoverage[];
  seed?: "visual_capture";
  expected: {
    requestedCapability?: string | null;
    selectedCapability?: ExpectedValue;
    admittedCapability?: ExpectedValue;
    executedCapability?: ExpectedValue;
    observationKind?: ExpectedValue;
    requiredTerminalKind?: ExpectedValue;
    selectedTerminalKind?: ExpectedValue;
    visibleTerminalKind?: ExpectedValue;
    reentryStatus?: ExpectedValue;
    goalSatisfaction?: ExpectedValue;
    railStatus?: ExpectedValue;
    codexParityClass?: ExpectedValue;
    railFailureCode?: ExpectedValue;
    firstBrokenRail?: ExpectedValue;
    repairTarget?: ExpectedValue;
    visibleToolSurfaceIncludes?: string[];
    visibleToolSurfaceExcludes?: string[];
    actionEnvelopeIncludes?: string[];
    forbidTerminalErrorCodes?: string[];
  };
};

const CODEX_PARITY_CLASSES = CODEX_PARITY_AGENT_SPINE_CLASSES;

const BASE_URL = (process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:1498").replace(/\/+$/, "");
const OUT_DIR = process.env.HELIX_ASK_LIVE_SPINE_OUT ?? "artifacts/helix-ask-live-spine-smoke";
const TIMEOUT_MS = Math.max(1000, Number(process.env.HELIX_ASK_LIVE_SPINE_TIMEOUT_MS ?? 240_000));
const FAIL_ON_WARN = process.env.HELIX_ASK_LIVE_SPINE_FAIL_ON_WARN === "1";
const DRY_RUN = process.argv.includes("--dry-run") || process.env.HELIX_ASK_LIVE_SPINE_DRY_RUN === "1";
const SCENARIO_FILTER = (process.env.HELIX_ASK_LIVE_SPINE_SCENARIOS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

export const LIVE_SPINE_SMOKE_SCENARIOS: LiveSpineScenario[] = [
  {
    id: "calculator_explicit",
    coverage: ["calculator"],
    prompt:
      "Call scientific-calculator.solve_expression with this exact expression: 2 + 2. Wait for calculator_receipt and answer from workstation_tool_evaluation.",
    expected: {
      requestedCapability: "scientific-calculator.solve_expression",
      selectedCapability: "scientific-calculator.solve_expression",
      admittedCapability: "scientific-calculator.solve_expression",
      executedCapability: "scientific-calculator.solve_expression",
      observationKind: "calculator_receipt",
      reentryStatus: "reentered",
      goalSatisfaction: "satisfied",
      requiredTerminalKind: "workstation_tool_evaluation",
      selectedTerminalKind: "workstation_tool_evaluation",
      visibleTerminalKind: "workstation_tool_evaluation",
      railStatus: "complete",
      codexParityClass: "complete",
      railFailureCode: null,
      firstBrokenRail: null,
      repairTarget: null,
      visibleToolSurfaceIncludes: ["scientific-calculator.solve_expression"],
      actionEnvelopeIncludes: ["scientific-calculator.open_panel", "scientific-calculator.focus_panel"],
    },
  },
  {
    id: "workspace_status_explicit",
    coverage: ["workspace_status"],
    prompt: "Use workspace_os.status to inspect workstation status.",
    expected: {
      requestedCapability: "workspace_os.status",
      selectedCapability: "workspace_os.status",
      admittedCapability: "workspace_os.status",
      executedCapability: "workspace_os.status",
      observationKind: "workspace_os_status_observation",
      reentryStatus: "reentered",
      goalSatisfaction: "satisfied",
      requiredTerminalKind: ["model_synthesized_answer", "workspace_status_answer", "workstation_tool_evaluation"],
      selectedTerminalKind: ["model_synthesized_answer", "workspace_status_answer", "workstation_tool_evaluation"],
      visibleTerminalKind: ["model_synthesized_answer", "workspace_status_answer", "workstation_tool_evaluation"],
      railStatus: "complete",
      codexParityClass: "complete",
      firstBrokenRail: null,
      visibleToolSurfaceIncludes: ["workspace_os.status"],
    },
  },
  {
    id: "docs_locate_explicit",
    coverage: ["docs"],
    prompt: "Use docs-viewer.locate_in_doc to locate the rule of thumb in docs/helix-ask-codex-loop-discipline.md.",
    expected: {
      requestedCapability: "docs-viewer.locate_in_doc",
      selectedCapability: "docs-viewer.locate_in_doc",
      admittedCapability: "docs-viewer.locate_in_doc",
      executedCapability: "docs-viewer.locate_in_doc",
      observationKind: ["doc_location_matches", "doc_evidence_location"],
      reentryStatus: "reentered",
      requiredTerminalKind: ["doc_location_matches", "doc_evidence_location", "doc_location_result"],
      railStatus: ["complete", "fail_closed"],
      codexParityClass: ["complete", "goal_contract_mismatch"],
      firstBrokenRail: [null, "terminal_materialization"],
      repairTarget: [null, "terminal_materializer"],
      visibleToolSurfaceIncludes: ["docs-viewer.locate_in_doc"],
    },
  },
  {
    id: "repo_search_explicit",
    coverage: ["repo_code"],
    prompt: "Use repo-code.search_concept to find where terminal authority selects the answer.",
    expected: {
      requestedCapability: "repo-code.search_concept",
      selectedCapability: "repo-code.search_concept",
      admittedCapability: "repo-code.search_concept",
      executedCapability: "repo-code.search_concept",
      observationKind: "repo_code_evidence_observation",
      reentryStatus: "reentered",
      requiredTerminalKind: "repo_code_evidence_answer",
      railStatus: ["complete", "fail_closed"],
      codexParityClass: ["complete", "observation_not_reentered"],
      firstBrokenRail: [null, "evidence_reentry"],
      repairTarget: [null, "repo_retrieval_repair_policy"],
      visibleToolSurfaceIncludes: ["repo-code.search_concept"],
    },
  },
  {
    id: "workspace_directory_resolve_explicit",
    coverage: ["workspace_directory"],
    prompt: "Use workspace-directory.resolve to resolve docs/helix-ask-codex-loop-discipline.md.",
    expected: {
      requestedCapability: "workspace-directory.resolve",
      selectedCapability: "workspace-directory.resolve",
      admittedCapability: "workspace-directory.resolve",
      executedCapability: "workspace-directory.resolve",
      observationKind: "workspace_directory_resolution",
      reentryStatus: "reentered",
      goalSatisfaction: "satisfied",
      requiredTerminalKind: ["workspace_directory_resolution", "model_synthesized_answer"],
      selectedTerminalKind: ["workspace_directory_resolution", "model_synthesized_answer"],
      visibleTerminalKind: ["workspace_directory_resolution", "model_synthesized_answer"],
      railStatus: "complete",
      codexParityClass: "complete",
      firstBrokenRail: null,
      visibleToolSurfaceIncludes: ["workspace-directory.resolve"],
      forbidTerminalErrorCodes: ["agent_loop_budget_exhausted"],
    },
  },
  {
    id: "internet_search_config_or_complete",
    coverage: ["internet_search"],
    prompt: "Use internet_search.web_research to find current public evidence about OpenAI Codex.",
    expected: {
      requestedCapability: "internet_search.web_research",
      selectedCapability: ["internet-search.search_web", "internet_search.web_research"],
      admittedCapability: ["internet-search.search_web", "internet_search.web_research"],
      executedCapability: ["internet-search.search_web", "internet_search.web_research"],
      observationKind: ["internet_search_observation", "reasoning_context"],
      reentryStatus: ["reentered", "no_observation"],
      requiredTerminalKind: "internet_search_answer",
      railStatus: ["complete", "fail_closed"],
      codexParityClass: ["complete", "provider_config_missing"],
      firstBrokenRail: [null, "config"],
      repairTarget: [null, "operator_config"],
      visibleToolSurfaceIncludes: ["internet_search.web_research"],
    },
  },
  {
    id: "scholarly_research_lookup_config_or_complete",
    coverage: ["scholarly_research"],
    prompt:
      "Use scholarly-research.lookup_papers to find scholarly papers about Alcubierre metric energy estimates.",
    expected: {
      requestedCapability: "scholarly-research.lookup_papers",
      selectedCapability: "scholarly-research.lookup_papers",
      admittedCapability: "scholarly-research.lookup_papers",
      executedCapability: "scholarly-research.lookup_papers",
      observationKind: ["scholarly_research_observation", "reasoning_context"],
      reentryStatus: ["reentered", "no_observation"],
      requiredTerminalKind: ["scholarly_research_answer", "compound_research_locator_answer"],
      railStatus: ["complete", "fail_closed"],
      codexParityClass: ["complete", "provider_config_missing", "observation_missing"],
      firstBrokenRail: [null, "config", "observation_artifact"],
      repairTarget: [null, "operator_config", "observation_materializer"],
      visibleToolSurfaceIncludes: ["scholarly-research.lookup_papers"],
      forbidTerminalErrorCodes: ["agent_loop_budget_exhausted"],
    },
  },
  {
    id: "live_source_mail_observation_or_fail_closed",
    coverage: ["live_source_mail"],
    prompt: "Use live_env.read_processed_live_source_mail to inspect the latest processed live-source mail.",
    expected: {
      requestedCapability: "live_env.read_processed_live_source_mail",
      selectedCapability: "live_env.read_processed_live_source_mail",
      admittedCapability: "live_env.read_processed_live_source_mail",
      executedCapability: "live_env.read_processed_live_source_mail",
      reentryStatus: ["reentered", "no_observation"],
      railStatus: ["complete", "fail_closed"],
      codexParityClass: ["complete", "observation_missing"],
      firstBrokenRail: [null, "observation_artifact"],
      repairTarget: [null, "observation_materializer"],
      visibleToolSurfaceIncludes: ["live_env.read_processed_live_source_mail"],
    },
  },
  {
    id: "capability_catalog_runtime",
    coverage: ["capability_catalog"],
    prompt: "What tools are available for the helix ask to use?",
    expected: {
      requestedCapability: "helix_ask.inspect_capability_catalog",
      selectedCapability: "helix_ask.inspect_capability_catalog",
      admittedCapability: "helix_ask.inspect_capability_catalog",
      executedCapability: "helix_ask.inspect_capability_catalog",
      observationKind: "capability_registry",
      requiredTerminalKind: "capability_help_summary",
      selectedTerminalKind: "capability_help_summary",
      visibleTerminalKind: "capability_help_summary",
      reentryStatus: "reentered",
      goalSatisfaction: "satisfied",
      railStatus: "complete",
      codexParityClass: "complete",
      firstBrokenRail: null,
      visibleToolSurfaceIncludes: ["helix_ask.inspect_capability_catalog"],
      forbidTerminalErrorCodes: ["terminal_kind_not_required", "agent_loop_budget_exhausted"],
    },
  },
  {
    id: "theory_context_reflection_explicit",
    coverage: ["theory_context_reflection"],
    prompt: "Use helix_ask.reflect_theory_context to reflect on the Alcubierre metric theory context.",
    expected: {
      requestedCapability: "helix_ask.reflect_theory_context",
      selectedCapability: "helix_ask.reflect_theory_context",
      admittedCapability: "helix_ask.reflect_theory_context",
      executedCapability: "helix_ask.reflect_theory_context",
      observationKind: ["helix_theory_context_reflection_tool_receipt", "theory_context_reflection"],
      reentryStatus: "reentered",
      goalSatisfaction: "satisfied",
      requiredTerminalKind: ["theory_context_reflection_answer", "model_synthesized_answer"],
      selectedTerminalKind: ["theory_context_reflection_answer", "model_synthesized_answer"],
      visibleTerminalKind: ["theory_context_reflection_answer", "model_synthesized_answer"],
      railStatus: "complete",
      codexParityClass: "complete",
      firstBrokenRail: null,
      visibleToolSurfaceIncludes: ["helix_ask.reflect_theory_context"],
      forbidTerminalErrorCodes: ["agent_loop_budget_exhausted", "solver_path_incomplete_before_terminal"],
    },
  },
  {
    id: "civilization_bounds_reflection_explicit",
    coverage: ["civilization_bounds"],
    prompt:
      "Use helix_ask.reflect_civilization_bounds to reflect civilization bounds for energy budget, material inventory, and governance review.",
    expected: {
      requestedCapability: "helix_ask.reflect_civilization_bounds",
      selectedCapability: "helix_ask.reflect_civilization_bounds",
      admittedCapability: "helix_ask.reflect_civilization_bounds",
      executedCapability: "helix_ask.reflect_civilization_bounds",
      observationKind: ["civilization_bounds_roadmap/v1", "helix_civilization_bounds_tool_result"],
      reentryStatus: "reentered",
      goalSatisfaction: "satisfied",
      requiredTerminalKind: ["model_synthesized_answer", "compound_evidence_synthesis_answer"],
      selectedTerminalKind: ["model_synthesized_answer", "compound_evidence_synthesis_answer"],
      visibleTerminalKind: ["model_synthesized_answer", "compound_evidence_synthesis_answer"],
      railStatus: "complete",
      codexParityClass: "complete",
      firstBrokenRail: null,
      visibleToolSurfaceIncludes: ["helix_ask.reflect_civilization_bounds"],
      forbidTerminalErrorCodes: ["agent_loop_budget_exhausted", "solver_path_incomplete_before_terminal"],
    },
  },
  {
    id: "moral_graph_reflection_explicit",
    coverage: ["moral_graph_reflection"],
    prompt:
      "Use helix_ask.reflect_ideology_context to reflect through the moral graph on this rule: receipts are observations and terminal authority selects the answer.",
    expected: {
      requestedCapability: "helix_ask.reflect_ideology_context",
      selectedCapability: "helix_ask.reflect_ideology_context",
      admittedCapability: "helix_ask.reflect_ideology_context",
      executedCapability: "helix_ask.reflect_ideology_context",
      observationKind: [
        "ideology_context_reflection/v1",
        "procedural_moral_classification/v1",
        "helix_moral_graph_reflection_tool_result",
        "workstation_tool_evaluation",
      ],
      reentryStatus: "reentered",
      goalSatisfaction: "satisfied",
      requiredTerminalKind: ["model_synthesized_answer", "compound_evidence_synthesis_answer"],
      selectedTerminalKind: ["model_synthesized_answer", "compound_evidence_synthesis_answer"],
      visibleTerminalKind: ["model_synthesized_answer", "compound_evidence_synthesis_answer"],
      railStatus: "complete",
      codexParityClass: "complete",
      firstBrokenRail: null,
      visibleToolSurfaceIncludes: ["helix_ask.reflect_ideology_context"],
      forbidTerminalErrorCodes: ["agent_loop_budget_exhausted", "solver_path_incomplete_before_terminal"],
    },
  },
  {
    id: "negated_calculator_context",
    coverage: ["negated_contextual_tool_mentions"],
    prompt:
      "Do not call scientific-calculator.solve_expression. Explain why calculator receipts are observations rather than terminal authority.",
    expected: {
      requestedCapability: null,
      selectedCapability: "model.direct_answer",
      admittedCapability: "model.direct_answer",
      executedCapability: "model.direct_answer",
      requiredTerminalKind: "direct_answer_text",
      selectedTerminalKind: "direct_answer_text",
      visibleTerminalKind: "direct_answer_text",
      railStatus: "complete",
      codexParityClass: "complete",
      firstBrokenRail: null,
      visibleToolSurfaceIncludes: ["model.direct_answer"],
      visibleToolSurfaceExcludes: ["scientific-calculator.solve_expression", "repo-code.search_concept"],
    },
  },
  {
    id: "visual_capture_current_screen",
    coverage: ["visual_capture"],
    seed: "visual_capture",
    prompt: "What is happening right now in the visual screen capture?",
    expected: {
      selectedCapability: "situation-room.describe_visual_capture",
      admittedCapability: "situation-room.describe_visual_capture",
      executedCapability: "situation-room.describe_visual_capture",
      railStatus: "complete",
      codexParityClass: "complete",
      firstBrokenRail: null,
      visibleToolSurfaceIncludes: ["situation-room.describe_visual_capture"],
    },
  },
  {
    id: "image_lens_alias",
    coverage: ["image_lens", "visual_capture"],
    seed: "visual_capture",
    prompt: "Use image_lens.inspect to inspect the current image lens visual source.",
    expected: {
      requestedCapability: "image_lens.inspect",
      selectedCapability: "situation-room.describe_visual_capture",
      admittedCapability: "situation-room.describe_visual_capture",
      executedCapability: "situation-room.describe_visual_capture",
      observationKind: ["visual_frame_evidence", "situation_context_pack", "visual_context_pack"],
      reentryStatus: "reentered",
      goalSatisfaction: "satisfied",
      requiredTerminalKind: "situation_context_pack",
      railStatus: "complete",
      codexParityClass: "complete",
      firstBrokenRail: null,
      visibleToolSurfaceIncludes: ["image_lens.inspect", "situation-room.describe_visual_capture"],
    },
  },
];

const SCENARIOS = LIVE_SPINE_SMOKE_SCENARIOS;

export const selectLiveSpineSmokeScenarios = (
  requestedIds: string[] = SCENARIO_FILTER,
): LiveSpineScenarioSelection => {
  const normalizedRequestedIds = Array.from(new Set(requestedIds.map((entry) => entry.trim()).filter(Boolean)));
  if (normalizedRequestedIds.length === 0) {
    return {
      scenarios: LIVE_SPINE_SMOKE_SCENARIOS,
      requestedIds: [],
      unknownIds: [],
    };
  }

  const knownIds = new Set(LIVE_SPINE_SMOKE_SCENARIOS.map((scenario) => scenario.id));
  return {
    scenarios: LIVE_SPINE_SMOKE_SCENARIOS.filter((scenario) => normalizedRequestedIds.includes(scenario.id)),
    requestedIds: normalizedRequestedIds,
    unknownIds: normalizedRequestedIds.filter((id) => !knownIds.has(id)),
  };
};

export const summarizeLiveSpineSmokeCoverage = (
  scenarios: LiveSpineScenario[] = LIVE_SPINE_SMOKE_SCENARIOS,
): LiveSpineCoverageSummary => {
  const covered = Array.from(new Set(scenarios.flatMap((scenario) => scenario.coverage))).sort() as LiveSpineCoverage[];
  const missing = REQUIRED_LIVE_SPINE_COVERAGE.filter((required) => !covered.includes(required));
  return {
    required: [...REQUIRED_LIVE_SPINE_COVERAGE],
    covered,
    missing,
    complete: missing.length === 0,
  };
};

const readRecord = (value: unknown): RecordLike | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordLike) : null;

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const readStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry: unknown): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];

const readRecordArray = (value: unknown): RecordLike[] =>
  Array.isArray(value)
    ? value
        .map((entry) => readRecord(entry))
        .filter((entry: RecordLike | null): entry is RecordLike => Boolean(entry))
    : [];

const isNonEmptyStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);

const readNonNegativeInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

const hasOwn = (record: RecordLike, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const getPath = (value: unknown, pathParts: string[]): unknown =>
  pathParts.reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as RecordLike)[key];
  }, value);

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

const parseJsonRecord = (text: string): RecordLike | null => {
  try {
    return readRecord(JSON.parse(text));
  } catch {
    return null;
  }
};

const probeAskTurnApi = async (): Promise<LiveSmokePreflight> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(TIMEOUT_MS, 10_000));
  const url = `${BASE_URL}/api/agi/ask/turn/__helix_live_spine_preflight__/debug-export?view=rail`;
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
        hint: readString(payload?.hint) ?? "Start the keyed bundle with ENABLE_AGI=1 and the Ask turn API enabled.",
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
      hint: "Start the operator-owned keyed Helix Ask server before running live spine smoke.",
    };
  } finally {
    clearTimeout(timeout);
  }
};

const extractPayload = (debugExport: unknown): RecordLike | null => {
  const debug = readRecord(debugExport);
  return readRecord(debug?.payload) ?? debug;
};

const railCandidates = (ask: RecordLike, debugExport: unknown): RecordLike[] => {
  const rawDebug = readRecord(debugExport);
  const payload = extractPayload(debugExport);
  return [
    readRecord(ask.codex_parity_agent_spine_rail_table),
    readRecord(payload?.codex_parity_agent_spine_rail_table),
    readRecord(getPath(payload, ["debug", "codex_parity_agent_spine_rail_table"])),
    readRecord(getPath(payload, ["artifact_query_index", "codex_parity_agent_spine_rail_table"])),
    readRecord(getPath(payload, ["debug", "artifact_query_index", "codex_parity_agent_spine_rail_table"])),
    readRecord(rawDebug?.codex_parity_agent_spine_rail_table),
    readRecord(getPath(rawDebug, ["payload", "codex_parity_agent_spine_rail_table"])),
    readRecord(getPath(rawDebug, ["payload", "debug", "codex_parity_agent_spine_rail_table"])),
    readRecord(getPath(rawDebug, ["payload", "artifact_query_index", "codex_parity_agent_spine_rail_table"])),
    readRecord(getPath(rawDebug, ["debug", "codex_parity_agent_spine_rail_table"])),
  ].filter((entry: RecordLike | null): entry is RecordLike => Boolean(entry));
};

const actionEnvelopeCapabilities = (ask: RecordLike, debugExport: unknown): string[] => {
  const rawDebug = readRecord(debugExport);
  const payload = extractPayload(debugExport);
  const values = new Set<string>();
  const candidates = [
    readRecord(ask.action_envelope),
    readRecord(getPath(ask, ["debug", "action_envelope"])),
    readRecord(payload?.action_envelope),
    readRecord(getPath(payload, ["debug", "action_envelope"])),
    readRecord(rawDebug?.action_envelope),
    readRecord(getPath(rawDebug, ["payload", "action_envelope"])),
    readRecord(getPath(rawDebug, ["payload", "debug", "action_envelope"])),
    readRecord(getPath(rawDebug, ["debug", "action_envelope"])),
  ].filter((entry: RecordLike | null): entry is RecordLike => Boolean(entry));
  for (const envelope of candidates) {
    for (const action of readRecordArray(envelope.workstation_actions)) {
      const directCapability = readString(action.capability_id);
      const panelId = readString(action.panel_id);
      const actionKind = readString(action.action);
      const actionId = readString(action.action_id);
      if (directCapability) values.add(directCapability);
      if (panelId && actionKind) values.add(`${panelId}.${actionKind}`);
      if (panelId && actionId) values.add(`${panelId}.${actionId}`);
    }
    for (const receiptCapabilityId of readStringArray(envelope.receipt_capability_ids)) {
      values.add(receiptCapabilityId);
    }
  }
  return [...values].sort();
};

const compoundSubgoalRailCandidates = (ask: RecordLike, debugExport: unknown): RecordLike[] => {
  const rawDebug = readRecord(debugExport);
  const payload = extractPayload(debugExport);
  for (const candidate of [
    ask.compound_subgoal_rail_statuses,
    payload?.compound_subgoal_rail_statuses,
    getPath(payload, ["debug", "compound_subgoal_rail_statuses"]),
    getPath(payload, ["artifact_query_index", "compound_subgoal_rail_statuses"]),
    getPath(payload, ["debug", "artifact_query_index", "compound_subgoal_rail_statuses"]),
    rawDebug?.compound_subgoal_rail_statuses,
    getPath(rawDebug, ["payload", "compound_subgoal_rail_statuses"]),
    getPath(rawDebug, ["payload", "debug", "compound_subgoal_rail_statuses"]),
    getPath(rawDebug, ["payload", "artifact_query_index", "compound_subgoal_rail_statuses"]),
    getPath(rawDebug, ["payload", "debug", "artifact_query_index", "compound_subgoal_rail_statuses"]),
    getPath(rawDebug, ["debug", "compound_subgoal_rail_statuses"]),
  ]) {
    const records = readRecordArray(candidate);
    if (records.length > 0) return records;
  }
  return [];
};

const terminalErrorCode = (ask: RecordLike, debugExport: unknown): string | null => {
  const payload = extractPayload(debugExport);
  return (
    readString(ask.terminal_error_code) ??
    readString(payload?.terminal_error_code) ??
    readString(getPath(payload, ["resolved_turn_summary", "terminal_error_code"]))
  );
};

const terminalFailureReconciliationRuntime = (ask: RecordLike, debugExport: unknown): RecordLike | null => {
  const payload = extractPayload(debugExport);
  return (
    readRecord(ask.tool_rail_terminal_failure_reconciliation_runtime) ??
    readRecord(payload?.tool_rail_terminal_failure_reconciliation_runtime) ??
    readRecord(getPath(payload, ["debug", "tool_rail_terminal_failure_reconciliation_runtime"]))
  );
};

const selectedFinalText = (ask: RecordLike, debugExport: unknown): string => {
  const payload = extractPayload(debugExport);
  return (
    readString(ask.selected_final_answer) ??
    readString(ask.finalAnswer) ??
    readString(ask.answer) ??
    readString(payload?.selected_final_answer) ??
    readString(payload?.answer) ??
    ""
  );
};

const completeRailEnvelopeFailures = (input: {
  rail: RecordLike | null;
  ask: RecordLike;
  debugExport: unknown;
}): string[] => {
  if (!input.rail) return [];
  const railComplete =
    readString(input.rail.codex_parity_class) === "complete" ||
    readString(input.rail.rail_status) === "complete";
  if (!railComplete) return [];
  const failures: string[] = [];
  const payload = extractPayload(input.debugExport);
  const errorCode = terminalErrorCode(input.ask, input.debugExport);
  const finalStatus = readString(input.ask.final_status) ?? readString(payload?.final_status);
  const responseType = readString(input.ask.response_type) ?? readString(payload?.response_type);
  const finalAnswerSource = readString(input.ask.final_answer_source) ?? readString(payload?.final_answer_source);
  const terminalArtifactKind =
    readString(input.ask.terminal_artifact_kind) ??
    readString(payload?.terminal_artifact_kind) ??
    readString(getPath(payload, ["terminal_answer_authority", "terminal_artifact_kind"]));
  const text = selectedFinalText(input.ask, input.debugExport);

  if (errorCode) failures.push(`complete_rail_terminal_error:${errorCode}`);
  if (finalAnswerSource === "typed_failure" || terminalArtifactKind === "typed_failure") {
    failures.push("complete_rail_typed_failure_terminal");
  }
  if ((finalStatus && finalStatus !== "final_answer") || (responseType && responseType !== "final_answer")) {
    failures.push(`complete_rail_non_final_response:${finalStatus ?? "missing"}/${responseType ?? "missing"}`);
  }
  if (!text) failures.push("complete_rail_missing_final_answer_text");
  return failures;
};

const failClosedRailEnvelopeFailures = (input: {
  rail: RecordLike | null;
  ask: RecordLike;
  debugExport: unknown;
}): string[] => {
  if (!input.rail) return [];
  const railStatus = readString(input.rail.rail_status);
  const parityClass = readString(input.rail.codex_parity_class);
  if (railStatus !== "fail_closed" && parityClass === "complete") return [];
  if (railStatus !== "fail_closed") return [];

  const failures: string[] = [];
  const payload = extractPayload(input.debugExport);
  const errorCode = terminalErrorCode(input.ask, input.debugExport);
  const finalStatus = readString(input.ask.final_status) ?? readString(payload?.final_status);
  const responseType = readString(input.ask.response_type) ?? readString(payload?.response_type);
  const finalAnswerSource = readString(input.ask.final_answer_source) ?? readString(payload?.final_answer_source);
  const terminalArtifactKind =
    readString(input.ask.terminal_artifact_kind) ??
    readString(payload?.terminal_artifact_kind) ??
    readString(getPath(payload, ["terminal_answer_authority", "terminal_artifact_kind"]));
  const text = selectedFinalText(input.ask, input.debugExport);

  if (!errorCode) failures.push("fail_closed_rail_missing_terminal_error_code");
  if (finalAnswerSource !== "typed_failure" && terminalArtifactKind !== "typed_failure") {
    failures.push(`fail_closed_rail_not_typed_failure:${finalAnswerSource ?? "missing"}/${terminalArtifactKind ?? "missing"}`);
  }
  if ((finalStatus && finalStatus !== "final_failure") || (responseType && responseType !== "final_failure")) {
    failures.push(`fail_closed_rail_non_failure_response:${finalStatus ?? "missing"}/${responseType ?? "missing"}`);
  }
  if (!text) failures.push("fail_closed_rail_missing_failure_text");
  return failures;
};

const matchesExpected = (actual: unknown, expected: ExpectedValue | undefined): boolean => {
  const value = actual === null || actual === undefined ? null : String(actual);
  if (expected === undefined) return true;
  if (expected === null) return value === null;
  const expectedValues = Array.isArray(expected) ? expected : expected.includes("|") ? expected.split("|") : [expected];
  return expectedValues.some((entry) => entry === null ? value === null : value === entry);
};

const expectField = (failures: string[], rail: RecordLike, key: string, expected: ExpectedValue | undefined): void => {
  if (expected === undefined) return;
  if (!matchesExpected(rail[key], expected)) {
    failures.push(`${key}_mismatch:${String(rail[key] ?? "null")}!=${Array.isArray(expected) ? expected.join("|") : String(expected)}`);
  }
};

const terminalArtifactKindFor = (ask: RecordLike, debugExport: unknown): string | null => {
  const payload = extractPayload(debugExport);
  return (
    readString(ask.terminal_artifact_kind) ??
    readString(payload?.terminal_artifact_kind) ??
    readString(getPath(payload, ["terminal_answer_authority", "terminal_artifact_kind"]))
  );
};

const collectCompoundRailShapeFailures = (
  rail: RecordLike,
  railComplete: boolean,
  compoundSubgoalRailStatuses: RecordLike[] = [],
): string[] => {
  const compoundMirrorDeclared =
    hasOwn(rail, "compound_subgoal_count") ||
    hasOwn(rail, "compound_incomplete_subgoal_did_tool_run") ||
    CODEX_PARITY_AGENT_SPINE_COMPOUND_STRING_OR_NULL_FIELDS.some((key) => hasOwn(rail, key));
  if (!compoundMirrorDeclared) return [];

  const failures: string[] = [];
  const compoundSubgoalCount = readNonNegativeInteger(rail.compound_subgoal_count);
  if (compoundSubgoalCount === null) failures.push("compound_subgoal_count_invalid");

  for (const key of CODEX_PARITY_AGENT_SPINE_COMPOUND_STRING_OR_NULL_FIELDS) {
    const value = rail[key];
    if (value !== null && typeof value !== "string") failures.push(`compound_string_or_null_field_invalid:${key}`);
  }

  const didToolRun = rail.compound_incomplete_subgoal_did_tool_run;
  if (didToolRun !== null && typeof didToolRun !== "boolean") {
    failures.push("compound_incomplete_subgoal_did_tool_run_invalid");
  }

  const hasFirstIncompleteSubgoal =
    CODEX_PARITY_AGENT_SPINE_COMPOUND_STRING_OR_NULL_FIELDS.some((key) => Boolean(readString(rail[key]))) ||
    typeof didToolRun === "boolean";

  if (compoundSubgoalCount === 0 && hasFirstIncompleteSubgoal) {
    failures.push("compound_zero_with_first_incomplete_subgoal");
  }
  if (compoundSubgoalCount !== null && compoundSubgoalCount > 0 && railComplete && hasFirstIncompleteSubgoal) {
    failures.push("compound_complete_with_stale_first_incomplete_subgoal");
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
      if (!readString(rail[key])) failures.push(`compound_incomplete_missing:${key}`);
    }
    if (typeof didToolRun !== "boolean") {
      failures.push("compound_incomplete_did_tool_run_missing");
    }
  }

  if (compoundSubgoalCount !== null && compoundSubgoalCount > 0) {
    if (compoundSubgoalRailStatuses.length < compoundSubgoalCount) {
      failures.push(`compound_subgoal_rail_statuses_dropped:${compoundSubgoalRailStatuses.length}<${compoundSubgoalCount}`);
    }

    for (const [index, subgoalRail] of compoundSubgoalRailStatuses.entries()) {
      const prefix = `compound_subgoal_${index + 1}`;
      const order = readNonNegativeInteger(subgoalRail.order);
      const satisfaction = readString(subgoalRail.satisfaction);
      const railStatus = readString(subgoalRail.rail_status);
      const firstBrokenRail = readString(subgoalRail.first_broken_rail);
      const railFailureCode = readString(subgoalRail.rail_failure_code);
      const repairTarget = readString(subgoalRail.repair_target);
      const observationRef = readString(subgoalRail.observation_ref);

      if (!readString(subgoalRail.subgoal_id)) failures.push(`${prefix}_subgoal_id_missing`);
      if (order === null) failures.push(`${prefix}_order_invalid`);
      if (order !== null && order !== index + 1) failures.push(`${prefix}_order_mismatch:${order}!=${index + 1}`);
      if (!readString(subgoalRail.requested_capability)) failures.push(`${prefix}_requested_capability_missing`);
      if (!readString(subgoalRail.runtime_capability)) failures.push(`${prefix}_runtime_capability_missing`);
      if (!readString(subgoalRail.selected_capability)) failures.push(`${prefix}_selected_capability_missing`);
      if (!hasOwn(subgoalRail, "args")) failures.push(`${prefix}_args_field_missing`);
      if (!hasOwn(subgoalRail, "executed_capability")) failures.push(`${prefix}_executed_capability_field_missing`);
      if (!hasOwn(subgoalRail, "observation_kind")) failures.push(`${prefix}_observation_kind_field_missing`);
      if (!hasOwn(subgoalRail, "observation_ref")) failures.push(`${prefix}_observation_ref_field_missing`);
      if (!satisfaction) failures.push(`${prefix}_satisfaction_missing`);
      if (!railStatus) failures.push(`${prefix}_rail_status_missing`);
      if (railStatus && !CODEX_PARITY_AGENT_SPINE_RAIL_STATUSES.includes(railStatus as never)) {
        failures.push(`${prefix}_rail_status_invalid:${railStatus}`);
      }
      if (satisfaction === "satisfied" && !observationRef) {
        failures.push(`${prefix}_satisfied_observation_ref_missing`);
      }
      if (railStatus === "complete") {
        if (satisfaction !== "satisfied") failures.push(`${prefix}_complete_satisfaction_not_satisfied`);
        if (!observationRef) failures.push(`${prefix}_complete_observation_ref_missing`);
      }
      if (railStatus === "fail_closed") {
        if (!firstBrokenRail) failures.push(`${prefix}_first_broken_rail_missing`);
        if (!railFailureCode) failures.push(`${prefix}_rail_failure_code_missing`);
        if (!repairTarget) failures.push(`${prefix}_repair_target_missing`);
      }
      if (
        firstBrokenRail &&
        !CODEX_PARITY_AGENT_SPINE_FIRST_BROKEN_RAILS.includes(
          firstBrokenRail as (typeof CODEX_PARITY_AGENT_SPINE_FIRST_BROKEN_RAILS)[number],
        )
      ) {
        failures.push(`${prefix}_first_broken_rail_invalid:${firstBrokenRail}`);
      }
      if (railFailureCode && !isCodexParityAgentSpineRailFailureCode(railFailureCode)) {
        failures.push(`${prefix}_rail_failure_code_invalid:${railFailureCode}`);
      }
      if (
        repairTarget &&
        !CODEX_PARITY_AGENT_SPINE_REPAIR_TARGETS.includes(
          repairTarget as (typeof CODEX_PARITY_AGENT_SPINE_REPAIR_TARGETS)[number],
        )
      ) {
        failures.push(`${prefix}_repair_target_invalid:${repairTarget}`);
      }
    }
  }

  const compoundRailFailureCode = readString(rail.compound_rail_failure_code);
  if (compoundRailFailureCode && !isCodexParityAgentSpineRailFailureCode(compoundRailFailureCode)) {
    failures.push(`compound_rail_failure_code_invalid:${compoundRailFailureCode}`);
  }

  return failures;
};

const shapeFailures = (
  rail: RecordLike,
  turnId: string,
  prompt: string,
  compoundSubgoalRailStatuses: RecordLike[] = [],
): string[] => {
  const failures: string[] = [];
  if (rail.schema !== CODEX_PARITY_AGENT_SPINE_RAIL_TABLE_SCHEMA) failures.push("rail_schema_mismatch");
  if (rail.turn_id !== turnId) failures.push(`rail_turn_id_mismatch:${String(rail.turn_id ?? "missing")}!=${turnId}`);
  if (readString(rail.prompt) !== prompt) failures.push("rail_prompt_mismatch");
  if (rail.assistant_answer !== false) failures.push("rail_assistant_answer_not_false");
  if (rail.terminal_eligible !== false) failures.push("rail_terminal_eligible_not_false");
  if (rail.raw_content_included !== false) failures.push("rail_raw_content_included_not_false");
  if (!Array.isArray(rail.visible_tool_surface)) {
    failures.push("visible_tool_surface_not_array");
  } else if (!isNonEmptyStringArray(rail.visible_tool_surface)) {
    failures.push("visible_tool_surface_entries_invalid");
  }
  const visibleSurfaceCount = readNonNegativeInteger(rail.visible_tool_surface_original_count);
  const visibleSurfaceTruncated =
    typeof rail.visible_tool_surface_truncated === "boolean" ? rail.visible_tool_surface_truncated : null;
  if (visibleSurfaceCount === null) {
    failures.push("visible_tool_surface_original_count_invalid");
  }
  if (visibleSurfaceTruncated === null) {
    failures.push("visible_tool_surface_truncated_invalid");
  }
  if (Array.isArray(rail.visible_tool_surface) && visibleSurfaceCount !== null) {
    const visibleSurfaceLength = rail.visible_tool_surface.length;
    if (visibleSurfaceCount < visibleSurfaceLength) {
      failures.push("visible_tool_surface_original_count_less_than_surface");
    }
    if (visibleSurfaceTruncated === true && visibleSurfaceCount <= visibleSurfaceLength) {
      failures.push("visible_tool_surface_truncated_without_hidden_entries");
    }
    if (visibleSurfaceTruncated === false && visibleSurfaceCount !== visibleSurfaceLength) {
      failures.push("visible_tool_surface_untruncated_count_mismatch");
    }
  }
  if (!Array.isArray(rail.required_observation_kinds_for_requested_capability)) {
    failures.push("required_observation_kinds_not_array");
  } else if (!isNonEmptyStringArray(rail.required_observation_kinds_for_requested_capability)) {
    failures.push("required_observation_kinds_entries_invalid");
  }
  if (!isNonEmptyStringArray(rail.normalized_codex_parity_classes)) {
    failures.push("normalized_codex_parity_classes_entries_invalid");
  }
  for (const key of CODEX_PARITY_AGENT_SPINE_STRING_OR_NULL_FIELDS) {
    const value = rail[key];
    if (value !== null && typeof value !== "string") failures.push(`rail_string_or_null_field_invalid:${key}`);
  }
  if (!CODEX_PARITY_AGENT_SPINE_REENTRY_STATUSES.includes(rail.reentry_status as never)) {
    failures.push(`invalid_reentry_status:${String(rail.reentry_status ?? "missing")}`);
  }
  const reentryStatus = readString(rail.reentry_status);
  const reentryProofSource = readString(rail.reentry_proof_source);
  if (reentryStatus === "reentered" && !reentryProofSource) {
    failures.push("reentry_proof_source_missing");
  }
  if (reentryStatus === "reentered" && rail.reentry_proven !== true) {
    failures.push("reentry_not_proven");
  }
  if (!CODEX_PARITY_AGENT_SPINE_RAIL_STATUSES.includes(rail.rail_status as never)) {
    failures.push(`invalid_rail_status:${String(rail.rail_status ?? "missing")}`);
  }
  const firstBrokenRail = readString(rail.first_broken_rail);
  if (
    firstBrokenRail &&
    !CODEX_PARITY_AGENT_SPINE_FIRST_BROKEN_RAILS.includes(
      firstBrokenRail as (typeof CODEX_PARITY_AGENT_SPINE_FIRST_BROKEN_RAILS)[number],
    )
  ) {
    failures.push(`invalid_first_broken_rail:${firstBrokenRail}`);
  }
  const repairTarget = readString(rail.repair_target);
  if (
    repairTarget &&
    !CODEX_PARITY_AGENT_SPINE_REPAIR_TARGETS.includes(
      repairTarget as (typeof CODEX_PARITY_AGENT_SPINE_REPAIR_TARGETS)[number],
    )
  ) {
    failures.push(`invalid_repair_target:${repairTarget}`);
  }
  const railFailureCode = readString(rail.rail_failure_code);
  if (railFailureCode && !isCodexParityAgentSpineRailFailureCode(railFailureCode)) {
    failures.push(`invalid_rail_failure_code:${railFailureCode}`);
  }
  if (!CODEX_PARITY_CLASSES.includes(rail.codex_parity_class as (typeof CODEX_PARITY_CLASSES)[number])) {
    failures.push(`invalid_codex_parity_class:${String(rail.codex_parity_class ?? "missing")}`);
  }
  if (JSON.stringify(rail.normalized_codex_parity_classes) !== JSON.stringify(CODEX_PARITY_CLASSES)) {
    failures.push("normalized_codex_parity_classes_mismatch");
  }
  const selectedCapability = readString(rail.selected_capability);
  const admittedCapability = readString(rail.admitted_capability);
  const executedCapability = readString(rail.executed_capability);
  const requestedCapability = readString(rail.requested_capability);
  const goalSatisfaction = readString(rail.goal_satisfaction);
  const requiredObservationKinds = readStringArray(rail.required_observation_kinds_for_requested_capability);
  const observationSupportsRequested = rail.observed_artifact_supports_requested_capability;
  const admissionProofSource = readString(rail.admission_proof_source);
  if ((selectedCapability || executedCapability) && !admittedCapability) {
    failures.push("admitted_capability_missing");
  }
  if (admittedCapability && !admissionProofSource) {
    failures.push("admission_proof_source_missing");
  }
  if (admittedCapability && rail.admission_proven !== true) {
    failures.push("admission_not_proven");
  }
  if (requestedCapability && requiredObservationKinds.length === 0) {
    failures.push("requested_observation_kinds_empty");
  }
  if (requestedCapability && typeof observationSupportsRequested !== "boolean") {
    failures.push("observation_support_verdict_missing");
  }
  if (
    requestedCapability &&
    (goalSatisfaction === "satisfied" || rail.rail_status === "complete" || rail.codex_parity_class === "complete") &&
    requiredObservationKinds.length > 0 &&
    observationSupportsRequested !== true
  ) {
    failures.push("goal_satisfied_without_requested_observation_support");
  }
  const selectedTerminalKind = readString(rail.selected_terminal_kind);
  const visibleTerminalKind = readString(rail.visible_terminal_kind);
  const terminalAuthorityProofSource = readString(rail.terminal_authority_proof_source);
  const visibleProjectionSource = readString(rail.visible_projection_source);
  if (selectedTerminalKind && !terminalAuthorityProofSource) {
    failures.push("terminal_authority_proof_source_missing");
  }
  if (selectedTerminalKind && rail.terminal_authority_proven !== true) {
    failures.push("terminal_authority_not_proven");
  }
  if (visibleTerminalKind && !visibleProjectionSource) {
    failures.push("visible_projection_source_missing");
  }
  if (visibleTerminalKind && rail.visible_projection_proven !== true) {
    failures.push("visible_projection_not_proven");
  }
  if (rail.codex_parity_class === "complete" && firstBrokenRail) {
    failures.push(`complete_with_first_broken_rail:${firstBrokenRail}`);
  }
  if ((rail.codex_parity_class === "complete" || rail.rail_status === "complete") && reentryStatus !== "reentered") {
    failures.push(`complete_without_reentry:${reentryStatus || "missing"}`);
  }
  if ((rail.rail_status === "complete") !== (rail.codex_parity_class === "complete")) {
    failures.push(`completion_status_class_mismatch:${String(rail.rail_status ?? "missing")}/${String(rail.codex_parity_class ?? "missing")}`);
  }
  if ((rail.codex_parity_class === "complete" || rail.rail_status === "complete") && !selectedTerminalKind) {
    failures.push("complete_without_terminal_authority");
  }
  if ((rail.codex_parity_class === "complete" || rail.rail_status === "complete") && !visibleTerminalKind) {
    failures.push("complete_without_visible_projection");
  }
  const railComplete = rail.codex_parity_class === "complete" || rail.rail_status === "complete";
  failures.push(...collectCompoundRailShapeFailures(rail, railComplete, compoundSubgoalRailStatuses));
  if (rail.codex_parity_class !== "complete" && !firstBrokenRail) {
    failures.push("non_complete_without_first_broken_rail");
  }
  if (rail.codex_parity_class !== "complete" && !railFailureCode) {
    failures.push("non_complete_without_rail_failure_code");
  }
  if (rail.codex_parity_class !== "complete" && !repairTarget) {
    failures.push("non_complete_without_repair_target");
  }
  return failures;
};

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
  ...LIVE_SPINE_COMPOUND_STRING_OR_NULL_FIELDS,
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

export const classifyLiveSpineSmokeResult = (
  scenario: LiveSpineScenario,
  ask: RecordLike,
  debugExport: unknown,
): RecordLike => {
  const failures: string[] = [];
  const warnings: string[] = [];
  const turnId = readString(ask.turn_id) ?? "missing";
  const rails = railCandidates(ask, debugExport);
  const rail = rails[0];
  const compoundSubgoalRailStatuses = compoundSubgoalRailCandidates(ask, debugExport);
  const errorCode = terminalErrorCode(ask, debugExport);
  const terminalArtifactKind = terminalArtifactKindFor(ask, debugExport);
  const reconciliationRuntime = terminalFailureReconciliationRuntime(ask, debugExport);
  const reconciliationRuntimeVersion = readString(reconciliationRuntime?.version);
  const actionEnvelopeCapabilityIds = actionEnvelopeCapabilities(ask, debugExport);

  if (!reconciliationRuntime) {
    failures.push("server_runtime_marker_missing:tool_rail_terminal_failure_reconciliation");
  } else if (reconciliationRuntimeVersion !== HELIX_TOOL_RAIL_TERMINAL_FAILURE_RECONCILIATION_VERSION) {
    failures.push(
      `server_runtime_marker_version_mismatch:${String(reconciliationRuntimeVersion ?? "null")}!=${HELIX_TOOL_RAIL_TERMINAL_FAILURE_RECONCILIATION_VERSION}`,
    );
  }

  if (!debugExport) failures.push("debug_export_missing");
  if (!rail) {
    failures.push("codex_parity_agent_spine_rail_table_missing");
  } else {
    failures.push(...shapeFailures(rail, turnId, scenario.prompt, compoundSubgoalRailStatuses), ...compareRailMirrors(rails));
    expectField(failures, rail, "requested_capability", scenario.expected.requestedCapability);
    expectField(failures, rail, "selected_capability", scenario.expected.selectedCapability);
    expectField(failures, rail, "admitted_capability", scenario.expected.admittedCapability);
    expectField(failures, rail, "executed_capability", scenario.expected.executedCapability);
    expectField(failures, rail, "observation_kind", scenario.expected.observationKind);
    expectField(failures, rail, "reentry_status", scenario.expected.reentryStatus);
    expectField(failures, rail, "goal_satisfaction", scenario.expected.goalSatisfaction);
    expectField(failures, rail, "required_terminal_kind", scenario.expected.requiredTerminalKind);
    expectField(failures, rail, "selected_terminal_kind", scenario.expected.selectedTerminalKind);
    expectField(failures, rail, "visible_terminal_kind", scenario.expected.visibleTerminalKind);
    expectField(failures, rail, "rail_status", scenario.expected.railStatus);
    expectField(failures, rail, "codex_parity_class", scenario.expected.codexParityClass);
    expectField(failures, rail, "rail_failure_code", scenario.expected.railFailureCode);
    expectField(failures, rail, "first_broken_rail", scenario.expected.firstBrokenRail);
    expectField(failures, rail, "repair_target", scenario.expected.repairTarget);

    if (rail.selected_terminal_kind !== rail.visible_terminal_kind) {
      failures.push(
        `terminal_projection_mismatch:${String(rail.selected_terminal_kind ?? "null")}!=${String(rail.visible_terminal_kind ?? "null")}`,
      );
    }
    if (terminalArtifactKind && rail.selected_terminal_kind && rail.selected_terminal_kind !== terminalArtifactKind) {
      failures.push(`rail_selected_terminal_response_mismatch:${String(rail.selected_terminal_kind)}!=${terminalArtifactKind}`);
    }
    if (terminalArtifactKind && rail.visible_terminal_kind && rail.visible_terminal_kind !== terminalArtifactKind) {
      failures.push(`rail_visible_terminal_response_mismatch:${String(rail.visible_terminal_kind)}!=${terminalArtifactKind}`);
    }
    failures.push(...completeRailEnvelopeFailures({ rail, ask, debugExport }));
    failures.push(...failClosedRailEnvelopeFailures({ rail, ask, debugExport }));

    const visibleToolSurface = readStringArray(rail.visible_tool_surface);
    for (const required of scenario.expected.visibleToolSurfaceIncludes ?? []) {
      if (!visibleToolSurface.includes(required)) failures.push(`visible_tool_surface_missing:${required}`);
    }
    for (const forbidden of scenario.expected.visibleToolSurfaceExcludes ?? []) {
      if (visibleToolSurface.includes(forbidden)) failures.push(`visible_tool_surface_forbidden:${forbidden}`);
    }
  }

  for (const required of scenario.expected.actionEnvelopeIncludes ?? []) {
    if (!actionEnvelopeCapabilityIds.includes(required)) failures.push(`action_envelope_missing:${required}`);
  }

  for (const forbidden of scenario.expected.forbidTerminalErrorCodes ?? []) {
    if (errorCode === forbidden) failures.push(`forbidden_terminal_error_code:${forbidden}`);
  }
  if (/agent_loop_budget_exhausted|max_tool_calls/i.test(errorCode ?? "")) {
    failures.push(`budget_exhaustion_visible:${errorCode}`);
  }

  const verdict: Verdict = failures.length ? "FAIL" : "PASS";
  return {
    schema: "helix.ask_live_spine_smoke_result.v1",
    scenario_id: scenario.id,
    coverage: scenario.coverage,
    prompt: scenario.prompt,
    turn_id: turnId,
    verdict,
    failures,
    warnings,
    terminal_error_code: errorCode,
    terminal_artifact_kind: terminalArtifactKind,
    final_answer_source: readString(ask.final_answer_source) ?? null,
    action_envelope_capabilities: actionEnvelopeCapabilityIds,
    tool_rail_terminal_failure_reconciliation_runtime: reconciliationRuntime
      ? {
          version: reconciliationRuntimeVersion,
          available: reconciliationRuntime.available === true,
        }
      : null,
    selected_final_answer_excerpt: selectedFinalText(ask, debugExport).slice(0, 500),
    rail_table: rail
      ? {
          prompt: rail.prompt ?? null,
          requested_capability: rail.requested_capability ?? null,
          visible_tool_surface: rail.visible_tool_surface ?? [],
          visible_tool_surface_original_count: rail.visible_tool_surface_original_count ?? null,
          visible_tool_surface_truncated: rail.visible_tool_surface_truncated ?? null,
          selected_capability: rail.selected_capability ?? null,
          admitted_capability: rail.admitted_capability ?? null,
          admission_proof_source: rail.admission_proof_source ?? null,
          admission_proven: rail.admission_proven ?? null,
          executed_capability: rail.executed_capability ?? null,
          observation_kind: rail.observation_kind ?? null,
          observation_ref: rail.observation_ref ?? null,
          required_observation_kinds_for_requested_capability:
            rail.required_observation_kinds_for_requested_capability ?? [],
          observed_artifact_supports_requested_capability:
            rail.observed_artifact_supports_requested_capability ?? null,
          reentry_status: rail.reentry_status ?? null,
          reentry_proof_source: rail.reentry_proof_source ?? null,
          reentry_proven: rail.reentry_proven ?? null,
          goal_satisfaction: rail.goal_satisfaction ?? null,
          required_terminal_kind: rail.required_terminal_kind ?? null,
          selected_terminal_kind: rail.selected_terminal_kind ?? null,
          terminal_authority_proof_source: rail.terminal_authority_proof_source ?? null,
          terminal_authority_proven: rail.terminal_authority_proven ?? null,
          visible_terminal_kind: rail.visible_terminal_kind ?? null,
          visible_projection_source: rail.visible_projection_source ?? null,
          visible_projection_proven: rail.visible_projection_proven ?? null,
          first_broken_rail: rail.first_broken_rail ?? null,
          repair_target: rail.repair_target ?? null,
          rail_status: rail.rail_status ?? null,
          rail_failure_code: rail.rail_failure_code ?? null,
          compound_subgoal_count: rail.compound_subgoal_count ?? null,
          first_incomplete_compound_subgoal_id: rail.first_incomplete_compound_subgoal_id ?? null,
          first_incomplete_compound_requested_capability:
            rail.first_incomplete_compound_requested_capability ?? null,
          first_incomplete_compound_runtime_capability:
            rail.first_incomplete_compound_runtime_capability ?? null,
          first_incomplete_compound_selected_capability:
            rail.first_incomplete_compound_selected_capability ?? null,
          first_incomplete_compound_executed_capability:
            rail.first_incomplete_compound_executed_capability ?? null,
          compound_first_broken_rail: rail.compound_first_broken_rail ?? null,
          compound_rail_failure_code: rail.compound_rail_failure_code ?? null,
          compound_repair_target: rail.compound_repair_target ?? null,
          compound_incomplete_subgoal_did_tool_run:
            rail.compound_incomplete_subgoal_did_tool_run ?? null,
          compound_subgoal_rail_statuses_count: compoundSubgoalRailStatuses.length,
          compound_subgoal_rail_statuses: compoundSubgoalRailStatuses.map((entry) => ({
            subgoal_id: entry.subgoal_id ?? null,
            order: entry.order ?? null,
            requested_capability: entry.requested_capability ?? null,
            runtime_capability: entry.runtime_capability ?? null,
            selected_capability: entry.selected_capability ?? null,
            executed_capability: entry.executed_capability ?? null,
            observation_kind: entry.observation_kind ?? null,
            observation_ref: entry.observation_ref ?? null,
            observation_provenance: entry.observation_provenance ?? null,
            satisfaction: entry.satisfaction ?? null,
            rail_status: entry.rail_status ?? null,
            first_broken_rail: entry.first_broken_rail ?? null,
            rail_failure_code: entry.rail_failure_code ?? null,
            repair_target: entry.repair_target ?? null,
          })),
          codex_parity_class: rail.codex_parity_class ?? null,
          normalized_codex_parity_classes: rail.normalized_codex_parity_classes ?? [],
        }
      : null,
  };
};

const seedVisualCapture = async (threadId: string): Promise<RecordLike> =>
  fetchJson<RecordLike>(`${BASE_URL}/api/agi/situation/test-harness/live-visual-source`, {
    method: "POST",
    body: JSON.stringify({
      thread_id: threadId,
      source_id: `visual_source:live-spine:${Date.now()}`,
      scene_text: "A backend-seeded visual capture shows a workstation panel with a visible status table.",
      activity: "Reviewing a workstation panel with status rows.",
      objects: "workstation panel, status table, visible controls",
      confidence: 0.82,
    }),
  });

const runScenario = async (scenario: LiveSpineScenario, runId: string, outputDir: string): Promise<RecordLike> => {
  const threadId = `helix-ask:live-spine:${runId}:${scenario.id}`;
  const scenarioDir = path.join(outputDir, scenario.id);
  await fs.mkdir(scenarioDir, { recursive: true });

  const seed = scenario.seed === "visual_capture" ? await seedVisualCapture(threadId) : null;
  if (seed) await fs.writeFile(path.join(scenarioDir, "seed.json"), `${JSON.stringify(seed, null, 2)}\n`);

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
  const result = classifyLiveSpineSmokeResult(scenario, ask, debug);

  await fs.writeFile(path.join(scenarioDir, "ask-response.json"), `${JSON.stringify(ask, null, 2)}\n`);
  await fs.writeFile(path.join(scenarioDir, "debug-export.json"), `${JSON.stringify(debug, null, 2)}\n`);
  await fs.writeFile(path.join(scenarioDir, "probe-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
};

const renderMarkdownSummary = (input: {
  runId: string;
  outputDir: string;
  results: RecordLike[];
  preflight?: LiveSmokePreflight;
  coverageSummary?: LiveSpineCoverageSummary;
  requestedScenarioIds?: string[];
  selectedScenarioIds?: string[];
}): string => {
  const lines = [
    "# Helix Ask Live Spine Smoke",
    "",
    `- run_id: ${input.runId}`,
    `- base_url: ${BASE_URL}`,
    `- output_dir: ${input.outputDir}`,
  ];
  if (input.requestedScenarioIds?.length) lines.push(`- requested_scenarios: ${input.requestedScenarioIds.join(", ")}`);
  if (input.selectedScenarioIds?.length) lines.push(`- selected_scenarios: ${input.selectedScenarioIds.join(", ")}`);
  if (input.preflight) {
    lines.push(`- preflight: ${input.preflight.ok ? "ok" : "blocked"} (${input.preflight.reason})`);
    if (input.preflight.hint) lines.push(`- preflight_hint: ${input.preflight.hint}`);
  }
  if (input.coverageSummary) {
    lines.push(`- coverage_complete: ${input.coverageSummary.complete ? "yes" : "no"}`);
    if (input.coverageSummary.missing.length) lines.push(`- coverage_missing: ${input.coverageSummary.missing.join(", ")}`);
  }
  lines.push(
    "",
    "| Verdict | Scenario | Class | Rail | Repair | Terminal Error |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const result of input.results) {
    const rail = readRecord(result.rail_table);
    lines.push(
      `| ${readString(result.verdict) || "FAIL"} | ${readString(result.scenario_id)} | ${String(rail?.codex_parity_class ?? "-")} | ${
        String(rail?.first_broken_rail ?? "-")
      } | ${String(rail?.repair_target ?? "-")} | ${String(result.terminal_error_code ?? "-")} |`,
    );
  }
  return `${lines.join("\n")}\n`;
};

const main = async (): Promise<void> => {
  const selection = selectLiveSpineSmokeScenarios();
  const scenarios = selection.scenarios;
  const selectedScenarioIds = scenarios.map((scenario) => scenario.id);
  const coverageSummary = summarizeLiveSpineSmokeCoverage(scenarios);

  if (DRY_RUN) {
    if (selection.unknownIds.length || scenarios.length === 0) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            dry_run: true,
            base_url: BASE_URL,
            requested_scenarios: selection.requestedIds,
            selected_scenarios: selectedScenarioIds,
            unknown_scenarios: selection.unknownIds,
            available_scenarios: SCENARIOS.map((scenario) => scenario.id),
            coverage_summary: coverageSummary,
            scenarios,
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          dry_run: true,
          base_url: BASE_URL,
          requested_scenarios: selection.requestedIds,
          selected_scenarios: selectedScenarioIds,
          available_scenarios: SCENARIOS.map((scenario) => scenario.id),
          coverage_summary: coverageSummary,
          scenarios,
        },
        null,
        2,
      ),
    );
    return;
  }

  const runId = `live-spine-${Date.now()}`;
  const outputDir = path.resolve(OUT_DIR, runId);
  await fs.mkdir(outputDir, { recursive: true });

  if (selection.unknownIds.length || scenarios.length === 0) {
    const summary = {
      schema: "helix.ask_live_spine_smoke_summary.v1",
      ok: false,
      blocked: true,
      blocked_reason: selection.unknownIds.length ? "unknown_scenario_filter" : "no_scenarios_selected",
      run_id: runId,
      base_url: BASE_URL,
      output_dir: outputDir,
      requested_scenarios: selection.requestedIds,
      selected_scenarios: selectedScenarioIds,
      unknown_scenarios: selection.unknownIds,
      available_scenarios: SCENARIOS.map((scenario) => scenario.id),
      coverage_summary: coverageSummary,
      counts: {
        pass: 0,
        fail: 0,
        warn: 1,
      },
      results: [],
    };
    await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await fs.writeFile(
      path.join(outputDir, "summary.md"),
      renderMarkdownSummary({
        runId,
        outputDir,
        results: [],
        coverageSummary,
        requestedScenarioIds: selection.requestedIds,
        selectedScenarioIds,
      }),
    );
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return;
  }

  const preflight = await probeAskTurnApi();
  if (!preflight.ok) {
    const summary = {
      schema: "helix.ask_live_spine_smoke_summary.v1",
      ok: false,
      blocked: true,
      blocked_reason: preflight.reason,
      run_id: runId,
      base_url: BASE_URL,
      output_dir: outputDir,
      requested_scenarios: selection.requestedIds,
      selected_scenarios: selectedScenarioIds,
      available_scenarios: SCENARIOS.map((scenario) => scenario.id),
      coverage_summary: coverageSummary,
      counts: {
        pass: 0,
        fail: 0,
        warn: 1,
      },
      preflight,
      results: [],
    };
    await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await fs.writeFile(
      path.join(outputDir, "summary.md"),
      renderMarkdownSummary({
        runId,
        outputDir,
        results: [],
        preflight,
        coverageSummary,
        requestedScenarioIds: selection.requestedIds,
        selectedScenarioIds,
      }),
    );
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return;
  }

  const results: RecordLike[] = [];
  for (const scenario of scenarios) {
    try {
      console.error(`[helix-live-spine] ${scenario.id}: ${scenario.prompt}`);
      results.push(await runScenario(scenario, runId, outputDir));
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      results.push({
        schema: "helix.ask_live_spine_smoke_result.v1",
        scenario_id: scenario.id,
        prompt: scenario.prompt,
        verdict: "FAIL",
        failures: [failure],
        warnings: [],
      });
    }
  }

  const failCount = results.filter((result) => result.verdict === "FAIL").length;
  const warnCount = results.reduce((count, result) => count + (Array.isArray(result.warnings) && result.warnings.length ? 1 : 0), 0);
  const summary = {
    schema: "helix.ask_live_spine_smoke_summary.v1",
    ok: failCount === 0 && (!FAIL_ON_WARN || warnCount === 0),
    run_id: runId,
    base_url: BASE_URL,
    output_dir: outputDir,
    requested_scenarios: selection.requestedIds,
    selected_scenarios: selectedScenarioIds,
    available_scenarios: SCENARIOS.map((scenario) => scenario.id),
    coverage_summary: coverageSummary,
    counts: {
      pass: results.filter((result) => result.verdict === "PASS").length,
      fail: failCount,
      warn: warnCount,
    },
    preflight,
    results,
  };
  await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(
    path.join(outputDir, "summary.md"),
    renderMarkdownSummary({
      runId,
      outputDir,
      results,
      preflight,
      coverageSummary,
      requestedScenarioIds: selection.requestedIds,
      selectedScenarioIds,
    }),
  );
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
};

const isDirectRun = (): boolean => {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return import.meta.url === pathToFileURL(path.resolve(entrypoint)).href;
};

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
