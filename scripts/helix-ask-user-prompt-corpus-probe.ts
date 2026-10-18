import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type RecordLike = Record<string, unknown>;
type Verdict = "PASS" | "WARN" | "FAIL" | "BLOCKED";

export type UserPromptScenario = {
  id: string;
  prompt: string;
  thread_group?: string;
  category:
    | "capability_catalog"
    | "calculator"
    | "workspace_status"
    | "docs"
    | "repo_code"
    | "theory_reflection"
    | "workstation_notes"
    | "moral_graph"
    | "voice_delivery"
    | "compound"
    | "negated_context";
  notes?: string;
  workspace_context_snapshot?: RecordLike;
  expected_tool_mode?: "none" | "optional" | "required";
  expected_capability_patterns?: string[];
  expected_minimum_observations?: number;
  expected_maximum_observations?: number;
  expected_terminal_kinds?: string[];
  expected_answer_patterns?: string[];
  expected_minimum_answer_chars?: number;
};

type ProbePreflight = {
  ok: boolean;
  status: number;
  reason: string;
  message: string;
  hint?: string;
};

export type UserPromptConversationContext = {
  turn_id: string;
  assistant_text: string;
  user_prompt: string;
  active_doc_path?: string | null;
  recent_assistant_answers?: Array<{
    turn_id: string;
    assistant_text: string;
  }>;
};

const BASE_URL = (process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:1498").replace(/\/+$/, "");
const OUT_DIR = process.env.HELIX_ASK_USER_PROMPT_OUT ?? "artifacts/helix-ask-user-prompt-corpus";
const TIMEOUT_MS = Math.max(1000, Number(process.env.HELIX_ASK_USER_PROMPT_TIMEOUT_MS ?? 240_000));
const DELAY_MS = Math.max(0, Number(process.env.HELIX_ASK_USER_PROMPT_DELAY_MS ?? 1000));
const DRY_RUN = process.argv.includes("--dry-run") || process.env.HELIX_ASK_USER_PROMPT_DRY_RUN === "1";
const FAIL_ON_WARN = process.env.HELIX_ASK_USER_PROMPT_FAIL_ON_WARN === "1";
const LOCAL_DEVELOPER_SIGN_IN =
  process.env.HELIX_ASK_USER_PROMPT_LOCAL_DEVELOPER === "1";
const TEST_MODEL = process.env.HELIX_ASK_TEST_MODEL?.trim() || "gpt-5.4-mini";
const TEST_MODEL_SELECTION = TEST_MODEL.toLowerCase() === "auto"
  ? { mode: "auto" as const }
  : { mode: "pinned" as const, model: TEST_MODEL };
const SCENARIO_FILTER = (process.env.HELIX_ASK_USER_PROMPT_SCENARIOS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
let requestCookie: string | null = null;

export const USER_PROMPT_CORPUS_SCENARIOS: UserPromptScenario[] = [
  {
    id: "catalog_available_tools",
    category: "capability_catalog",
    prompt: "What tools are available for Helix Ask to use?",
  },
  {
    id: "catalog_live_answer_tool_goals",
    category: "capability_catalog",
    prompt: "What about the live answer tool call goals?",
  },
  {
    id: "calculator_explicit_2_plus_2",
    category: "calculator",
    prompt: "Call scientific-calculator.solve_expression with this exact expression: 2 + 2.",
  },
  {
    id: "workspace_status_explicit",
    category: "workspace_status",
    prompt: "Use workspace_os.status to inspect workstation status.",
  },
  {
    id: "docs_terminal_authority_locate",
    category: "docs",
    prompt:
      "Use docs-viewer.locate_in_doc to find where terminal authority is discussed in docs/helix-ask-codex-loop-discipline.md.",
  },
  {
    id: "repo_receipts_observations",
    category: "repo_code",
    prompt: "Use repo-code.search_concept to explain receipts are observations, not answers.",
  },
  {
    id: "theory_context_reflection",
    category: "theory_reflection",
    prompt: "Use helix_ask.reflect_theory_context to locate Casimir cavities in the theory graph.",
  },
  {
    id: "docs_then_calculator",
    category: "compound",
    prompt:
      "Use docs-viewer.locate_in_doc to find where terminal authority is discussed, then call scientific-calculator.solve_expression with this exact expression: 19 + 23.",
  },
  {
    id: "catalog_then_workspace",
    category: "compound",
    prompt: "Call helix_ask.inspect_capability_catalog, then use workspace_os.status to inspect workstation status.",
  },
  {
    id: "negated_tool_receipts_explanation",
    category: "negated_context",
    prompt: "Do not call tools; explain why calculator receipts are observations, not answers.",
  },
];

const readRecord = (value: unknown): RecordLike | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordLike) : null;

const readArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const readRecordArray = (value: unknown): RecordLike[] =>
  readArray(value)
    .map((entry) => readRecord(entry))
    .filter((entry: RecordLike | null): entry is RecordLike => Boolean(entry));

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const readBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const getPath = (value: unknown, pathParts: string[]): unknown =>
  pathParts.reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as RecordLike)[key];
  }, value);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const slug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "scenario";

const parseJsonRecord = (text: string): RecordLike | null => {
  try {
    return readRecord(JSON.parse(text));
  } catch {
    return null;
  }
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
        Accept: "application/json",
        ...(requestCookie ? { Cookie: requestCookie } : {}),
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

export const isLoopbackUserPromptBaseUrl = (baseUrl: string): boolean => {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
};

const establishLocalDeveloperSession = async (
  runId: string,
): Promise<{ profile_id: string; account_type: "developer" }> => {
  if (!isLoopbackUserPromptBaseUrl(BASE_URL)) {
    throw new Error("local_developer_sign_in_requires_loopback_base_url");
  }
  const profileId = `helix-ask-user-prompt-probe:${runId}`;
  const receipt = await fetchJson<RecordLike>(`${BASE_URL}/api/account/session/sign-in`, {
    method: "POST",
    body: JSON.stringify({
      profile_id: profileId,
      display_name: "Helix Ask User Prompt Probe",
      account_type: "developer",
    }),
  });
  const sessionId = readString(readRecord(receipt.session)?.session_id);
  if (receipt.ok !== true || !sessionId) {
    throw new Error(
      `local_developer_sign_in_failed:${readString(receipt.error) ?? "session_missing"}`,
    );
  }
  requestCookie = `helix_session=${sessionId}`;
  const status = await fetchJson<RecordLike>(`${BASE_URL}/api/account/session`);
  const accountType = readString(getPath(status, ["account_policy", "account_type"]));
  if (accountType !== "developer") {
    try {
      await fetchJson<RecordLike>(`${BASE_URL}/api/account/session/sign-out`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    } finally {
      requestCookie = null;
    }
    throw new Error(`local_developer_policy_missing:${accountType ?? "unknown"}`);
  }
  return { profile_id: profileId, account_type: "developer" };
};

const releaseLocalDeveloperSession = async (): Promise<void> => {
  if (!requestCookie) return;
  try {
    await fetchJson<RecordLike>(`${BASE_URL}/api/account/session/sign-out`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  } finally {
    requestCookie = null;
  }
};

const probeAskTurnApi = async (): Promise<ProbePreflight> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(TIMEOUT_MS, 10_000));
  const url = `${BASE_URL}/api/agi/ask/turn/__helix_user_prompt_corpus_preflight__/debug-export?view=rail`;
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
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
        message: response.ok
          ? "Ask turn debug-export endpoint is available."
          : "Ask turn routes are mounted; fake turn was not found as expected.",
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
      hint: "Start the operator-owned keyed Helix Ask server before running this live corpus probe.",
    };
  } finally {
    clearTimeout(timeout);
  }
};

const extractPayload = (debugExport: unknown): RecordLike | null => {
  const debug = readRecord(debugExport);
  return readRecord(debug?.payload) ?? debug;
};

const firstRecord = (...values: unknown[]): RecordLike | null => {
  for (const value of values) {
    const record = readRecord(value);
    if (record) return record;
  }
  return null;
};

const firstNonEmptyRecords = (...values: unknown[]): RecordLike[] => {
  for (const value of values) {
    const records = readRecordArray(value);
    if (records.length > 0) return records;
  }
  return [];
};

const railTable = (ask: RecordLike, debugExport: unknown): RecordLike | null => {
  const debug = readRecord(debugExport);
  const payload = extractPayload(debugExport);
  return firstRecord(
    ask.codex_parity_agent_spine_rail_table,
    payload?.codex_parity_agent_spine_rail_table,
    getPath(payload, ["debug", "codex_parity_agent_spine_rail_table"]),
    getPath(payload, ["artifact_query_index", "codex_parity_agent_spine_rail_table"]),
    getPath(payload, ["debug", "artifact_query_index", "codex_parity_agent_spine_rail_table"]),
    debug?.codex_parity_agent_spine_rail_table,
    getPath(debug, ["payload", "codex_parity_agent_spine_rail_table"]),
    getPath(debug, ["payload", "debug", "codex_parity_agent_spine_rail_table"]),
  );
};

const compoundSubgoals = (ask: RecordLike, debugExport: unknown): RecordLike[] => {
  const debug = readRecord(debugExport);
  const payload = extractPayload(debugExport);
  return firstNonEmptyRecords(
    ask.compound_subgoal_rail_statuses,
    payload?.compound_subgoal_rail_statuses,
    getPath(payload, ["debug", "compound_subgoal_rail_statuses"]),
    getPath(payload, ["artifact_query_index", "compound_subgoal_rail_statuses"]),
    getPath(payload, ["debug", "artifact_query_index", "compound_subgoal_rail_statuses"]),
    debug?.compound_subgoal_rail_statuses,
    getPath(debug, ["payload", "compound_subgoal_rail_statuses"]),
    getPath(debug, ["payload", "debug", "compound_subgoal_rail_statuses"]),
  );
};

const gatewayCallResults = (ask: RecordLike, debugExport: unknown): RecordLike[] => {
  const debug = readRecord(debugExport);
  const payload = extractPayload(debugExport);
  return firstNonEmptyRecords(
    ask.workstation_gateway_call_results,
    payload?.workstation_gateway_call_results,
    getPath(payload, ["debug", "workstation_gateway_call_results"]),
    debug?.workstation_gateway_call_results,
    getPath(debug, ["payload", "workstation_gateway_call_results"]),
    getPath(debug, ["payload", "debug", "workstation_gateway_call_results"]),
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

const collectLifecycleStrings = (value: unknown, fieldNames: Set<string>): string[] => {
  const collected = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (entry: unknown, depth: number): void => {
    if (depth > 18 || entry === null || typeof entry !== "object" || seen.has(entry as object)) return;
    seen.add(entry as object);
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(entry as RecordLike)) {
      if (fieldNames.has(key)) {
        if (typeof item === "string" && item.trim()) collected.add(item.trim());
        if (Array.isArray(item)) {
          for (const candidate of item) {
            if (typeof candidate === "string" && candidate.trim()) collected.add(candidate.trim());
          }
        }
      }
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
  return Array.from(collected);
};

const compoundSynthesisTerminalKinds = new Set([
  "compound_evidence_synthesis_answer",
  "compound_research_locator_answer",
  "doc_evidence_synthesis_answer",
  "capability_workspace_synthesis_answer",
]);

const singleSubgoalTerminalKinds = new Set([
  "workstation_tool_evaluation",
  "capability_help_summary",
  "doc_location_matches",
  "doc_summary",
  "workspace_status_answer",
]);

const terminalErrorCode = (ask: RecordLike, debugExport: unknown): string | null => {
  const payload = extractPayload(debugExport);
  return (
    readString(ask.terminal_error_code) ??
    readString(payload?.terminal_error_code) ??
    readString(getPath(payload, ["resolved_turn_summary", "terminal_error_code"]))
  );
};

const readTerminalKind = (ask: RecordLike, debugExport: unknown, rail: RecordLike | null): string | null => {
  const payload = extractPayload(debugExport);
  return (
    readString(ask.terminal_artifact_kind) ??
    readString(payload?.terminal_artifact_kind) ??
    readString(rail?.selected_terminal_kind) ??
    readString(getPath(payload, ["terminal_answer_authority", "terminal_artifact_kind"]))
  );
};

export const summarizeTurn = (scenario: UserPromptScenario, ask: RecordLike, debugExport: unknown): RecordLike => {
  const payload = extractPayload(debugExport);
  const rail = railTable(ask, debugExport);
  const subgoals = compoundSubgoals(ask, debugExport);
  const gatewayResults = gatewayCallResults(ask, debugExport);
  const text = selectedFinalText(ask, debugExport);
  const terminalKind = readTerminalKind(ask, debugExport, rail);
  const visibleKind =
    readString(ask.visible_terminal_kind) ??
    readString(payload?.visible_terminal_kind) ??
    readString(rail?.visible_terminal_kind);
  const terminalError = terminalErrorCode(ask, debugExport);
  const finalAnswerSource = readString(ask.final_answer_source) ?? readString(payload?.final_answer_source);
  const railStatus = readString(rail?.rail_status);
  const codexParityClass = readString(rail?.codex_parity_class);
  const firstBrokenRail = readString(rail?.first_broken_rail);
  const railFailureCode = readString(rail?.rail_failure_code);
  const repairTarget = readString(rail?.repair_target);
  const requestedCapability = readString(rail?.requested_capability);
  const selectedCapability = readString(rail?.selected_capability);
  const admittedCapability = readString(rail?.admitted_capability);
  const executedCapability = readString(rail?.executed_capability);
  const observationKind = readString(rail?.observation_kind);
  const observationRef = readString(rail?.observation_ref);
  const reentryStatus = readString(rail?.reentry_status);
  const executedCapabilities = collectLifecycleStrings(
    { ask, debugExport },
    new Set(["executed_capability", "executed_capabilities"]),
  ).filter((capability) => !/^(?:none|null|model_only|model\.direct_answer)$/i.test(capability));
  const observationRefs = collectLifecycleStrings(
    { ask, debugExport },
    new Set(["observation_ref", "observation_refs", "observed_artifact_refs", "observation_reentry_refs"]),
  );
  // Policy and route projections may carry placeholder observation refs even
  // when no workstation capability ran. For model-only controls, execution is
  // the authoritative signal; those policy refs are not tool observations.
  const evaluatedObservationRefs = scenario.expected_tool_mode === "none" && executedCapabilities.length === 0
    ? []
    : observationRefs;
  const optionalToolExecuted =
    scenario.expected_tool_mode === "optional" && executedCapabilities.length > 0;
  const toolExecutionMustBeComplete =
    scenario.expected_tool_mode === "required" || optionalToolExecuted;
  const modelOnlyLifecycleHealthy =
    (scenario.expected_tool_mode === "none" || scenario.expected_tool_mode === "optional") &&
    executedCapabilities.length === 0 &&
    !terminalError &&
    terminalKind !== "typed_failure" &&
    finalAnswerSource !== "typed_failure";
  const evaluatedFirstBrokenRail = modelOnlyLifecycleHealthy ? null : firstBrokenRail;
  const evaluatedRailStatus = modelOnlyLifecycleHealthy ? "complete" : railStatus;
  const evaluatedCodexParityClass = modelOnlyLifecycleHealthy ? "complete" : codexParityClass;
  const expectedCapabilityPatterns = (scenario.expected_capability_patterns ?? []).map(
    (pattern) => new RegExp(pattern, "i"),
  );
  const gatewayResultSummaries = gatewayResults.map((result) => {
    const admission = readRecord(result.gateway_admission);
    const packet = readRecord(result.observation_packet);
    const capability =
      readString(result.capability_id) ??
      readString(admission?.requested_capability) ??
      "unknown";
    const packetStatus = readString(packet?.status) ?? "unknown";
    const ok = readBoolean(result.ok);
    return {
      capability,
      ok,
      packet_status: packetStatus,
      successful: ok === true && packetStatus === "succeeded",
      failure_reason:
        readString(result.error) ??
        readString(result.failure_reason) ??
        readString(getPath(result, ["tool_lifecycle_trace", "failure_reason"])) ??
        readString(getPath(result, ["tool_followup_decision", "reason"])),
    };
  });
  const expectedGatewayResults = expectedCapabilityPatterns.flatMap((pattern) =>
    gatewayResultSummaries.filter((result) => pattern.test(result.capability)),
  );
  const successfulSubgoalCapabilities = subgoals.flatMap((subgoal) => {
    if (!["satisfied", "completed", "complete"].includes(readString(subgoal.satisfaction) ?? "")) return [];
    return [
      readString(subgoal.executed_capability),
      readString(subgoal.selected_capability),
      readString(subgoal.requested_capability),
    ].filter((capability): capability is string => Boolean(capability));
  });
  const expectedCapabilitiesSuccessful =
    !toolExecutionMustBeComplete ||
    expectedCapabilityPatterns.length === 0 ||
    expectedCapabilityPatterns.every((pattern) =>
      gatewayResultSummaries.some((result) => pattern.test(result.capability) && result.successful) ||
      successfulSubgoalCapabilities.some((capability) => pattern.test(capability)),
    );
  const failedExpectedGatewayResults = expectedGatewayResults.filter((result) => !result.successful);
  const expectedCapabilityObserved =
    !toolExecutionMustBeComplete ||
    expectedCapabilityPatterns.length === 0 ||
    expectedCapabilityPatterns.every((pattern) => executedCapabilities.some((capability) => pattern.test(capability)));
  const expectedMinimumObservations = scenario.expected_minimum_observations ??
    (toolExecutionMustBeComplete ? 1 : 0);
  const expectedMaximumObservations = scenario.expected_maximum_observations ??
    (scenario.expected_tool_mode === "none" ? 0 : null);
  const expectedTerminalKinds = scenario.expected_terminal_kinds ?? [];
  const expectedAnswerPatterns = (scenario.expected_answer_patterns ?? []).map(
    (pattern) => new RegExp(pattern, "i"),
  );
  const expectedMinimumAnswerChars = scenario.expected_minimum_answer_chars ?? 0;
  const proposalOnlyText =
    /\bcapability\s+proposal\s*:|\bI(?:'ll|\s+will)\s+(?:look\s*up|search|find|open|read|inspect|use|call)\b/i.test(text);
  const observationVisibilityDenied =
    scenario.expected_tool_mode === "required" &&
    expectedCapabilitiesSuccessful &&
    /\b(?:not available [^.]{0,80}this turn|actual observation fields? [^.]{0,80}(?:not re-entered|not included)|only have (?:the )?observation references?|(?:can't|cannot|couldn't|unable to) (?:access|see|retrieve|read|use) (?:the )?(?:tool )?(?:observation|result|data))\b/i.test(
      text,
    );
  const goalSatisfaction =
    readString(rail?.goal_satisfaction) ??
    readString(getPath(payload, ["goal_satisfaction", "status"])) ??
    readString(getPath(payload, ["current_turn_goal_satisfaction", "status"]));
  const terminalAuthorityProven =
    typeof rail?.terminal_authority_proven === "boolean" ? rail.terminal_authority_proven : null;
  const visibleProjectionProven =
    typeof rail?.visible_projection_proven === "boolean" ? rail.visible_projection_proven : null;
  const compoundTerminalNotSynthesis =
    subgoals.length > 1 &&
    Boolean(terminalKind) &&
    !compoundSynthesisTerminalKinds.has(terminalKind ?? "") &&
    singleSubgoalTerminalKinds.has(terminalKind ?? "");
  const lifecycleFailureStage = (() => {
    if (evaluatedFirstBrokenRail) return evaluatedFirstBrokenRail;
    if (scenario.expected_tool_mode === "none") {
      if (executedCapabilities.length > 0) return "unexpected_tool_lifecycle";
      if (terminalError || terminalKind === "typed_failure" || finalAnswerSource === "typed_failure") {
        return "terminal_authority";
      }
      return "not_required";
    }
    if (scenario.expected_tool_mode === "optional" && executedCapabilities.length === 0) {
      if (terminalError || terminalKind === "typed_failure" || finalAnswerSource === "typed_failure") {
        return "terminal_authority";
      }
      return "complete";
    }
    if (!toolExecutionMustBeComplete) return null;
    if (executedCapabilities.length === 0) {
      if (admittedCapability) return "capability_execution";
      if (selectedCapability) return "tool_admission";
      if (requestedCapability || proposalOnlyText) return "proposal_without_admission";
      return "capability_selection";
    }
    if (!expectedCapabilitiesSuccessful || failedExpectedGatewayResults.length > 0) {
      return "capability_execution";
    }
    if (evaluatedObservationRefs.length === 0) return "observation_artifact";
    if (reentryStatus && !["reentered", "handoff_terminal_allowed"].includes(reentryStatus)) {
      return "evidence_reentry";
    }
    if (observationVisibilityDenied) return "evidence_reentry";
    if (terminalError || terminalKind === "typed_failure" || finalAnswerSource === "typed_failure") {
      return "terminal_authority";
    }
    return "complete";
  })();

  const qualityFlags = [
    !debugExport ? "debug_export_missing" : "",
    !rail ? "rail_table_missing" : "",
    terminalError ? `terminal_error:${terminalError}` : "",
    terminalKind === "typed_failure" || finalAnswerSource === "typed_failure" ? "typed_failure" : "",
    text.trim().length === 0 ? "empty_answer" : "",
    scenario.expected_minimum_answer_chars == null &&
      text.trim().length > 0 &&
      text.trim().length < 80 &&
      terminalKind !== "typed_failure"
      ? "short_answer"
      : "",
    terminalKind && visibleKind && terminalKind !== visibleKind ? `terminal_projection_mismatch:${terminalKind}!=${visibleKind}` : "",
    compoundTerminalNotSynthesis ? `compound_terminal_not_synthesis:${terminalKind}` : "",
    evaluatedRailStatus && !["complete", "satisfied"].includes(evaluatedRailStatus) ? `rail_status:${evaluatedRailStatus}` : "",
    evaluatedCodexParityClass && evaluatedCodexParityClass !== "complete" ? `codex_parity_class:${evaluatedCodexParityClass}` : "",
    scenario.expected_tool_mode === "none" && executedCapabilities.length > 0
      ? `unexpected_tool_execution:${executedCapabilities.join(",")}`
      : "",
    scenario.expected_tool_mode === "required" && executedCapabilities.length === 0
      ? "required_tool_not_executed"
      : "",
    scenario.expected_tool_mode === "required" && !expectedCapabilityObserved
      ? `expected_capability_not_executed:${scenario.expected_capability_patterns?.join("|") ?? "unspecified"}`
      : "",
    scenario.expected_tool_mode === "required" && !expectedCapabilitiesSuccessful
      ? `expected_capability_not_successful:${scenario.expected_capability_patterns?.join("|") ?? "unspecified"}`
      : "",
    optionalToolExecuted && !expectedCapabilityObserved
      ? `optional_tool_unexpected_capability:${executedCapabilities.join(",")}`
      : "",
    optionalToolExecuted && !expectedCapabilitiesSuccessful
      ? `optional_tool_not_successful:${scenario.expected_capability_patterns?.join("|") ?? "unspecified"}`
      : "",
    ...failedExpectedGatewayResults.map((result) =>
      `tool_observation_failed:${result.capability}:${result.packet_status}${result.failure_reason ? `:${result.failure_reason}` : ""}`
    ),
    evaluatedObservationRefs.length < expectedMinimumObservations
      ? `required_tool_observation_missing:${evaluatedObservationRefs.length}/${expectedMinimumObservations}`
      : "",
    expectedMaximumObservations !== null && evaluatedObservationRefs.length > expectedMaximumObservations
      ? `unexpected_tool_observation:${evaluatedObservationRefs.length}/${expectedMaximumObservations}`
      : "",
    expectedTerminalKinds.length > 0 && (!terminalKind || !expectedTerminalKinds.includes(terminalKind))
      ? `unexpected_terminal_kind:${terminalKind ?? "missing"}/${expectedTerminalKinds.join("|")}`
      : "",
    text.trim().length < expectedMinimumAnswerChars
      ? `answer_too_short:${text.trim().length}/${expectedMinimumAnswerChars}`
      : "",
    ...expectedAnswerPatterns
      .filter((pattern) => !pattern.test(text))
      .map((pattern) => `expected_answer_pattern_missing:${pattern.source}`),
    proposalOnlyText && executedCapabilities.length === 0 ? "proposal_only_without_execution" : "",
    observationVisibilityDenied ? "answer_denies_successful_observation_reentry" : "",
  ].filter(Boolean);

  const hardLifecycleFailure =
    toolExecutionMustBeComplete &&
    (
      !expectedCapabilitiesSuccessful ||
      failedExpectedGatewayResults.length > 0 ||
      observationVisibilityDenied
    );
  const verdict: Verdict =
    terminalError || terminalKind === "typed_failure" || finalAnswerSource === "typed_failure" ||
    evaluatedFirstBrokenRail || hardLifecycleFailure
      ? "FAIL"
      : !rail || qualityFlags.length > 0 || evaluatedRailStatus !== "complete" || evaluatedCodexParityClass !== "complete"
      ? "WARN"
      : "PASS";

  return {
    schema: "helix.ask_user_prompt_corpus_probe_result.v1",
    id: scenario.id,
    category: scenario.category,
    prompt: scenario.prompt,
    verdict,
    answer_quality_status: verdict === "PASS" ? "usable" : verdict === "WARN" ? "needs_review" : "failed",
    answer_quality_flags: qualityFlags,
    answer_excerpt: text.trim().slice(0, 500),
    final_answer_source: finalAnswerSource,
    terminal_artifact_kind: terminalKind,
    visible_terminal_kind: visibleKind,
    terminal_error_code: terminalError,
    requested_capability: requestedCapability,
    selected_capability: selectedCapability,
    admitted_capability: admittedCapability,
    executed_capability: executedCapability,
    executed_capabilities: executedCapabilities,
    gateway_call_results: gatewayResultSummaries,
    expected_capabilities_successful: expectedCapabilitiesSuccessful,
    observation_kind: observationKind,
    observation_ref: observationRef,
    observation_refs: observationRefs,
    reentry_status: reentryStatus,
    lifecycle_failure_stage: lifecycleFailureStage,
    expected_tool_mode: scenario.expected_tool_mode ?? null,
    expected_capability_patterns: scenario.expected_capability_patterns ?? [],
    expected_minimum_observations: expectedMinimumObservations,
    expected_maximum_observations: expectedMaximumObservations,
    expected_terminal_kinds: expectedTerminalKinds,
    expected_answer_patterns: scenario.expected_answer_patterns ?? [],
    expected_minimum_answer_chars: expectedMinimumAnswerChars,
    goal_satisfaction: goalSatisfaction,
    terminal_authority_proven: terminalAuthorityProven,
    visible_projection_proven: visibleProjectionProven,
    rail_status: railStatus,
    codex_parity_class: codexParityClass,
    first_broken_rail: firstBrokenRail,
    rail_failure_code: railFailureCode,
    repair_target: repairTarget,
    compound_subgoal_count: subgoals.length,
    compound_subgoals: subgoals.map((entry) => ({
      subgoal_id: readString(entry.subgoal_id),
      requested_capability: readString(entry.requested_capability),
      selected_capability: readString(entry.selected_capability),
      executed_capability: readString(entry.executed_capability),
      observation_kind: readString(entry.observation_kind),
      observation_ref: readString(entry.observation_ref),
      satisfaction: readString(entry.satisfaction),
      rail_status: readString(entry.rail_status),
      first_broken_rail: readString(entry.first_broken_rail),
      rail_failure_code: readString(entry.rail_failure_code),
    })),
  };
};

const loadScenarioFile = async (filePath: string): Promise<UserPromptScenario[]> => {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const entries = Array.isArray(parsed)
    ? parsed
    : readArray(readRecord(parsed)?.scenarios);
  return entries.map((entry, index) => {
    const record = readRecord(entry);
    const prompt = readString(record?.prompt);
    if (!record || !prompt) throw new Error(`Invalid prompt corpus scenario at index ${index}`);
    return {
      id: readString(record.id) ?? `custom_${index + 1}`,
      category: (readString(record.category) as UserPromptScenario["category"] | null) ?? "compound",
      prompt,
      thread_group: readString(record.thread_group) ?? undefined,
      notes: readString(record.notes) ?? undefined,
      workspace_context_snapshot: readRecord(record.workspace_context_snapshot) ?? undefined,
      expected_tool_mode: readString(record.expected_tool_mode) as UserPromptScenario["expected_tool_mode"] ?? undefined,
      expected_capability_patterns: readArray(record.expected_capability_patterns)
        .map((value) => readString(value))
        .filter((value): value is string => Boolean(value)),
      expected_minimum_observations:
        typeof record.expected_minimum_observations === "number"
          ? Math.max(0, Math.floor(record.expected_minimum_observations))
          : undefined,
      expected_maximum_observations:
        typeof record.expected_maximum_observations === "number"
          ? Math.max(0, Math.floor(record.expected_maximum_observations))
          : undefined,
      expected_terminal_kinds: readArray(record.expected_terminal_kinds)
        .map((value) => readString(value))
        .filter((value): value is string => Boolean(value)),
      expected_answer_patterns: readArray(record.expected_answer_patterns)
        .map((value) => readString(value))
        .filter((value): value is string => Boolean(value)),
      expected_minimum_answer_chars:
        typeof record.expected_minimum_answer_chars === "number"
          ? Math.max(0, Math.floor(record.expected_minimum_answer_chars))
          : undefined,
    };
  });
};

export const selectUserPromptCorpusScenarios = async (): Promise<UserPromptScenario[]> => {
  const customFile = readString(process.env.HELIX_ASK_USER_PROMPT_CORPUS_FILE);
  const scenarios = customFile ? await loadScenarioFile(customFile) : USER_PROMPT_CORPUS_SCENARIOS;
  if (SCENARIO_FILTER.length === 0) return scenarios;
  const requested = new Set(SCENARIO_FILTER);
  return scenarios.filter((scenario) => requested.has(scenario.id));
};

export const resolveUserPromptScenarioThreadId = (
  scenario: UserPromptScenario,
  runId: string,
): string =>
  scenario.thread_group
    ? `helix-ask:user-prompt-corpus:${runId}:journey:${slug(scenario.thread_group)}`
    : `helix-ask:user-prompt-corpus:${runId}:${scenario.id}`;

export const buildUserPromptConversationWorkspaceSnapshot = (
  context: UserPromptConversationContext | null | undefined,
): RecordLike | undefined => {
  if (!context?.assistant_text.trim()) return undefined;
  const sourceRef = `chat.final_answer.previous:${context.turn_id}`;
  const activeDocPath =
    readString(context.active_doc_path) ??
    context.assistant_text.match(/\bdocs[\\/][^\s)\]]+\.md\b/i)?.[0]?.replace(/\\/g, "/") ??
    null;
  const previousAnswer = {
    role: "assistant",
    reply_id: context.turn_id,
    source_ref: sourceRef,
    text: context.assistant_text,
  };
  const recentAnswers = (
    context.recent_assistant_answers?.length
      ? context.recent_assistant_answers
      : [{ turn_id: context.turn_id, assistant_text: context.assistant_text }]
  )
    .filter((answer) => answer.assistant_text.trim())
    .slice(0, 8)
    .map((answer) => ({
      role: "assistant",
      reply_id: answer.turn_id,
      source_ref: `chat.final_answer.recent:${answer.turn_id}`,
      text: answer.assistant_text,
    }));
  return {
    ...(activeDocPath
      ? {
          activeDocPath,
          active_doc_path: activeDocPath,
          activePanel: "docs-viewer",
          hasDocContext: true,
          source: "user_prompt_corpus_prior_answer",
        }
      : {}),
    chat_referent_context: {
      schema: "helix.ask.chat_referent_context.v1",
      previous_assistant_final_answer: previousAnswer,
      previous_chat_message: previousAnswer,
      recent_assistant_final_answers: recentAnswers,
      previous_user_message: {
        role: "user",
        source_ref: `chat.user.previous:${context.turn_id}`,
        text: context.user_prompt,
      },
    },
  };
};

export const mergeUserPromptWorkspaceSnapshots = (
  configured: RecordLike | null | undefined,
  conversation: RecordLike | null | undefined,
): RecordLike | undefined => {
  if (!configured && !conversation) return undefined;
  return {
    ...(configured ?? {}),
    ...(conversation ?? {}),
  };
};

const runScenario = async (
  scenario: UserPromptScenario,
  runId: string,
  outputDir: string,
  conversationContexts: Map<string, UserPromptConversationContext>,
): Promise<RecordLike> => {
  const threadId = resolveUserPromptScenarioThreadId(scenario, runId);
  const scenarioDir = path.join(outputDir, slug(scenario.id));
  await fs.mkdir(scenarioDir, { recursive: true });
  const workspaceContextSnapshot = mergeUserPromptWorkspaceSnapshots(
    scenario.workspace_context_snapshot,
    buildUserPromptConversationWorkspaceSnapshot(conversationContexts.get(threadId)),
  );

  const startedAtMs = Date.now();
  const ask = await fetchJson<RecordLike>(`${BASE_URL}/api/agi/ask/turn`, {
    method: "POST",
    body: JSON.stringify({
      sessionId: threadId,
      question: scenario.prompt,
      mode: "read",
      debug: true,
      ...(workspaceContextSnapshot
        ? {
            workspace_context_snapshot: workspaceContextSnapshot,
            workspaceContextSnapshot: workspaceContextSnapshot,
          }
        : {}),
      language_model_selection: TEST_MODEL_SELECTION,
      languageModelSelection: TEST_MODEL_SELECTION,
    }),
  });
  const turnId = readString(ask.turn_id);
  const debug = turnId
    ? await fetchJson<RecordLike>(`${BASE_URL}/api/agi/ask/turn/${encodeURIComponent(turnId)}/debug-export`)
    : null;
  const result = summarizeTurn(scenario, ask, debug);
  const finalText = selectedFinalText(ask, debug);
  if (turnId && finalText.trim()) {
    const previousContext = conversationContexts.get(threadId);
    const activeDocPath =
      finalText.match(/\bdocs[\\/][^\s)\]]+\.md\b/i)?.[0]?.replace(/\\/g, "/") ??
      readString(workspaceContextSnapshot?.activeDocPath);
    conversationContexts.set(threadId, {
      turn_id: turnId,
      assistant_text: finalText,
      user_prompt: scenario.prompt,
      active_doc_path: activeDocPath,
      recent_assistant_answers: [
        { turn_id: turnId, assistant_text: finalText },
        ...(previousContext?.recent_assistant_answers ?? (
          previousContext
            ? [{ turn_id: previousContext.turn_id, assistant_text: previousContext.assistant_text }]
            : []
        )),
      ].slice(0, 8),
    });
  }

  await fs.writeFile(path.join(scenarioDir, "ask-response.json"), `${JSON.stringify(ask, null, 2)}\n`);
  await fs.writeFile(path.join(scenarioDir, "debug-export.json"), `${JSON.stringify(debug, null, 2)}\n`);
  await fs.writeFile(path.join(scenarioDir, "probe-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return {
    ...result,
    elapsed_ms: Date.now() - startedAtMs,
    turn_id: turnId,
    thread_id: threadId,
    thread_group: scenario.thread_group ?? null,
    artifact_dir: scenarioDir,
  };
};

const verdictRank = (verdict: unknown): number =>
  verdict === "FAIL" ? 3 : verdict === "WARN" ? 2 : verdict === "BLOCKED" ? 1 : 0;

const renderMarkdownSummary = (input: {
  runId: string;
  outputDir: string;
  scenarios: UserPromptScenario[];
  results: RecordLike[];
  preflight?: ProbePreflight;
}): string => {
  const lines = [
    "# Helix Ask User Prompt Corpus Probe",
    "",
    `- run_id: ${input.runId}`,
    `- base_url: ${BASE_URL}`,
    `- output_dir: ${input.outputDir}`,
    `- scenario_count: ${input.scenarios.length}`,
    `- delay_ms: ${DELAY_MS}`,
  ];
  if (input.preflight) {
    lines.push(`- preflight: ${input.preflight.ok ? "ok" : "blocked"} (${input.preflight.reason})`);
    if (input.preflight.hint) lines.push(`- preflight_hint: ${input.preflight.hint}`);
  }
  lines.push("", "| Scenario | Verdict | Terminal | Lifecycle Stage | Rail | Capability | Answer Quality |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const result of input.results) {
    const id = readString(result.id) ?? "unknown";
    const verdict = readString(result.verdict) ?? "WARN";
    const terminal = readString(result.terminal_artifact_kind) ?? "missing";
    const rail = [readString(result.rail_status), readString(result.codex_parity_class)].filter(Boolean).join(" / ") || "missing";
    const lifecycleStage = readString(result.lifecycle_failure_stage) ?? readString(result.first_broken_rail) ?? "-";
    const capability = [
      readString(result.requested_capability),
      readString(result.selected_capability),
      readString(result.executed_capability),
    ].map((entry) => entry ?? "-").join(" -> ");
    const quality = readArray(result.answer_quality_flags).join("<br>") || readString(result.answer_quality_status) || "needs_review";
    lines.push(`| ${id} | ${verdict} | ${terminal} | ${lifecycleStage} | ${rail} | ${capability} | ${quality} |`);
  }
  lines.push("");
  lines.push("## Prompt Excerpts");
  for (const result of input.results) {
    lines.push("");
    lines.push(`### ${readString(result.id) ?? "unknown"} (${readString(result.verdict) ?? "WARN"})`);
    lines.push("");
    lines.push(`Prompt: ${readString(result.prompt) ?? ""}`);
    lines.push("");
    lines.push(readString(result.answer_excerpt) ?? "");
  }
  return `${lines.join("\n")}\n`;
};

const writeBlockedSummary = async (
  outputDir: string,
  runId: string,
  scenarios: UserPromptScenario[],
  preflight: ProbePreflight,
): Promise<RecordLike> => {
  const summary = {
    schema: "helix.ask_user_prompt_corpus_probe_summary.v1",
    run_id: runId,
    base_url: BASE_URL,
    output_dir: outputDir,
    ok: false,
    blocked: true,
    preflight,
    scenario_count: scenarios.length,
    model_selection: TEST_MODEL_SELECTION,
    results: [],
  };
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(path.join(outputDir, "summary.md"), renderMarkdownSummary({ runId, outputDir, scenarios, results: [], preflight }));
  return summary;
};

const main = async (): Promise<void> => {
  const runId = `user-prompt-corpus-${Date.now()}`;
  const outputDir = path.join(OUT_DIR, runId);
  const scenarios = await selectUserPromptCorpusScenarios();

  if (DRY_RUN) {
    const summary = {
      schema: "helix.ask_user_prompt_corpus_probe_summary.v1",
      run_id: runId,
      base_url: BASE_URL,
      output_dir: outputDir,
      dry_run: true,
      ok: true,
      scenario_count: scenarios.length,
      model_selection: TEST_MODEL_SELECTION,
      account_mode: LOCAL_DEVELOPER_SIGN_IN ? "local_developer" : "default",
      scenario_ids: scenarios.map((scenario) => scenario.id),
      scenarios,
    };
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await fs.writeFile(path.join(outputDir, "summary.md"), renderMarkdownSummary({ runId, outputDir, scenarios, results: [] }));
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const preflight = await probeAskTurnApi();
  if (!preflight.ok) {
    const summary = await writeBlockedSummary(outputDir, runId, scenarios, preflight);
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return;
  }

  let accountIdentity: { profile_id: string; account_type: "developer" } | null = null;
  if (LOCAL_DEVELOPER_SIGN_IN) {
    try {
      accountIdentity = await establishLocalDeveloperSession(runId);
    } catch (error) {
      const identityPreflight: ProbePreflight = {
        ok: false,
        status: 0,
        reason: "developer_session_unavailable",
        message: error instanceof Error ? error.message : String(error),
        hint:
          "Use the operator-started loopback keyed server; local developer sign-in is intentionally unavailable for remote base URLs.",
      };
      const summary = await writeBlockedSummary(
        outputDir,
        runId,
        scenarios,
        identityPreflight,
      );
      console.log(JSON.stringify(summary, null, 2));
      process.exitCode = 1;
      return;
    }
  }

  await fs.mkdir(outputDir, { recursive: true });
  const results: RecordLike[] = [];
  const conversationContexts = new Map<string, UserPromptConversationContext>();
  try {
    for (const [index, scenario] of scenarios.entries()) {
      if (index > 0 && DELAY_MS > 0) await sleep(DELAY_MS);
      console.log(`[helix-user-prompt-corpus] ${scenario.id}: ${scenario.prompt}`);
      try {
        results.push(await runScenario(
          scenario,
          runId,
          outputDir,
          conversationContexts,
        ));
      } catch (error) {
        const scenarioDir = path.join(outputDir, slug(scenario.id));
        await fs.mkdir(scenarioDir, { recursive: true });
        const result = {
          schema: "helix.ask_user_prompt_corpus_probe_result.v1",
          id: scenario.id,
          category: scenario.category,
          prompt: scenario.prompt,
          verdict: "FAIL" as Verdict,
          answer_quality_status: "failed",
          answer_quality_flags: ["probe_exception"],
          error: error instanceof Error ? error.message : String(error),
          artifact_dir: scenarioDir,
        };
        await fs.writeFile(path.join(scenarioDir, "probe-result.json"), `${JSON.stringify(result, null, 2)}\n`);
        results.push(result);
      }
    }
  } finally {
    if (LOCAL_DEVELOPER_SIGN_IN) await releaseLocalDeveloperSession();
  }

  const counts = results.reduce<Record<string, number>>((acc, result) => {
    const verdict = readString(result.verdict) ?? "WARN";
    acc[verdict] = (acc[verdict] ?? 0) + 1;
    return acc;
  }, {});
  const lifecycleStageCounts = results.reduce<Record<string, number>>((acc, result) => {
    const stage = readString(result.lifecycle_failure_stage) ?? "unclassified";
    acc[stage] = (acc[stage] ?? 0) + 1;
    return acc;
  }, {});
  const worst = results.reduce((max, result) => Math.max(max, verdictRank(result.verdict)), 0);
  const ok = worst < 3 && (!FAIL_ON_WARN || worst < 2);
  const summary = {
    schema: "helix.ask_user_prompt_corpus_probe_summary.v1",
    run_id: runId,
    base_url: BASE_URL,
    output_dir: outputDir,
    ok,
    blocked: false,
    preflight,
    scenario_count: scenarios.length,
    model_selection: TEST_MODEL_SELECTION,
    account_mode: accountIdentity?.account_type ?? "default",
    account_profile_id: accountIdentity?.profile_id ?? null,
    verdict_counts: counts,
    lifecycle_stage_counts: lifecycleStageCounts,
    results,
  };

  await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(path.join(outputDir, "summary.md"), renderMarkdownSummary({ runId, outputDir, scenarios, results, preflight }));
  console.log(JSON.stringify(summary, null, 2));
  if (!ok) process.exitCode = 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
