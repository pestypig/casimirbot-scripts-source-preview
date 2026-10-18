import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type RecordLike = Record<string, unknown>;

type CodexMethodologyRef = {
  id: string;
  path: string;
  methodology: string;
};

type DebugScenario = {
  id: string;
  kind: "atomic" | "adversarial" | "compound" | "control";
  family: string;
  prompt: string;
  seed?: "visual_capture";
  operator_sensitive?: boolean;
  expected_capabilities?: string[];
  forbidden_capabilities?: string[];
  methodology_refs?: string[];
  notes?: string;
};

type DebugPromptSet = {
  schema: string;
  description: string;
  codex_methodology_refs: CodexMethodologyRef[];
  scenarios: DebugScenario[];
};

type Preflight = {
  ok: boolean;
  status: number;
  reason: string;
  message: string;
  hint?: string;
};

const PROMPT_SET_PATH =
  process.env.HELIX_ASK_CODEX_DEBUG_SET ?? "scripts/helix-ask-codex-methodology-debug-set.json";
const BASE_URL = (process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:1498").replace(/\/+$/, "");
const OUT_DIR = process.env.HELIX_ASK_CODEX_DEBUG_OUT ?? "artifacts/helix-ask-codex-methodology-debug";
const TIMEOUT_MS = Math.max(1000, Number(process.env.HELIX_ASK_CODEX_DEBUG_TIMEOUT_MS ?? 300_000));
const INCLUDE_SENSITIVE = process.env.HELIX_ASK_CODEX_DEBUG_INCLUDE_SENSITIVE === "1";
const DRY_RUN = process.argv.includes("--dry-run") || process.env.HELIX_ASK_CODEX_DEBUG_DRY_RUN === "1";
const SCENARIO_FILTER = (process.env.HELIX_ASK_CODEX_DEBUG_SCENARIOS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

const readRecord = (value: unknown): RecordLike | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordLike) : null;

const readArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const readRecordArray = (value: unknown): RecordLike[] =>
  readArray(value)
    .map((entry) => readRecord(entry))
    .filter((entry: RecordLike | null): entry is RecordLike => Boolean(entry));

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const readStringArray = (value: unknown): string[] =>
  readArray(value)
    .filter((entry: unknown): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());

const getPath = (value: unknown, pathParts: string[]): unknown =>
  pathParts.reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as RecordLike)[key];
  }, value);

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

const loadPromptSet = async (): Promise<DebugPromptSet> => {
  const filePath = path.resolve(PROMPT_SET_PATH);
  const text = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(text) as DebugPromptSet;
  if (!Array.isArray(parsed.scenarios)) throw new Error(`Prompt set has no scenarios: ${filePath}`);
  return parsed;
};

const selectScenarios = (
  promptSet: DebugPromptSet,
): {
  scenarios: DebugScenario[];
  skippedSensitive: string[];
  requestedIds: string[];
  unknownIds: string[];
  availableIds: string[];
} => {
  const availableIds = promptSet.scenarios.map((scenario) => scenario.id);
  const known = new Set(availableIds);
  const requestedIds = Array.from(new Set(SCENARIO_FILTER));
  const unknownIds = requestedIds.filter((id) => !known.has(id));
  const filtered = requestedIds.length
    ? promptSet.scenarios.filter((scenario) => requestedIds.includes(scenario.id))
    : promptSet.scenarios;
  const scenarios = filtered.filter((scenario) => INCLUDE_SENSITIVE || !scenario.operator_sensitive);
  const skippedSensitive = filtered
    .filter((scenario) => scenario.operator_sensitive && !INCLUDE_SENSITIVE)
    .map((scenario) => scenario.id);
  return { scenarios, skippedSensitive, requestedIds, unknownIds, availableIds };
};

const debugPayload = (debugExport: unknown): RecordLike | null => {
  const debug = readRecord(debugExport);
  return readRecord(debug?.payload) ?? debug;
};

const railTables = (ask: RecordLike, debug: RecordLike | null, rawDebug: unknown): RecordLike[] => {
  const raw = readRecord(rawDebug);
  return [
    readRecord(ask.codex_parity_agent_spine_rail_table),
    readRecord(debug?.codex_parity_agent_spine_rail_table),
    readRecord(getPath(debug, ["debug", "codex_parity_agent_spine_rail_table"])),
    readRecord(getPath(debug, ["artifact_query_index", "codex_parity_agent_spine_rail_table"])),
    readRecord(getPath(raw, ["payload", "codex_parity_agent_spine_rail_table"])),
    readRecord(getPath(raw, ["payload", "debug", "codex_parity_agent_spine_rail_table"])),
    readRecord(getPath(raw, ["payload", "artifact_query_index", "codex_parity_agent_spine_rail_table"])),
  ].filter((entry: RecordLike | null): entry is RecordLike => Boolean(entry));
};

const compoundSubgoalRails = (ask: RecordLike, debug: RecordLike | null, rawDebug: unknown): RecordLike[] => {
  const raw = readRecord(rawDebug);
  for (const candidate of [
    ask.compound_subgoal_rail_statuses,
    debug?.compound_subgoal_rail_statuses,
    getPath(debug, ["debug", "compound_subgoal_rail_statuses"]),
    getPath(debug, ["artifact_query_index", "compound_subgoal_rail_statuses"]),
    getPath(raw, ["payload", "compound_subgoal_rail_statuses"]),
    getPath(raw, ["payload", "debug", "compound_subgoal_rail_statuses"]),
    getPath(raw, ["payload", "artifact_query_index", "compound_subgoal_rail_statuses"]),
  ]) {
    const records = readRecordArray(candidate);
    if (records.length) return records;
  }
  return [];
};

const loopTrace = (ask: RecordLike, debug: RecordLike | null): RecordLike | null =>
  readRecord(ask.loop_parity_trace) ?? readRecord(debug?.loop_parity_trace);

const solverTrace = (ask: RecordLike, debug: RecordLike | null): RecordLike | null =>
  readRecord(ask.ask_turn_solver_trace) ?? readRecord(debug?.ask_turn_solver_trace);

const routeAuthority = (ask: RecordLike, debug: RecordLike | null): RecordLike | null =>
  readRecord(ask.route_authority_audit) ?? readRecord(debug?.route_authority_audit);

const terminalAuthority = (ask: RecordLike, debug: RecordLike | null): RecordLike | null =>
  readRecord(ask.terminal_answer_authority) ?? readRecord(debug?.terminal_answer_authority);

const poisonAudit = (ask: RecordLike, debug: RecordLike | null): RecordLike | null =>
  readRecord(ask.poison_audit) ?? readRecord(debug?.poison_audit);

const actualToolCalls = (trace: RecordLike | null): string[] =>
  readRecordArray(trace?.actual_tool_calls)
    .map((entry) => readString(entry.tool_id) ?? readString(entry.capability_id) ?? readString(entry.name))
    .filter((entry: string | null): entry is string => Boolean(entry));

const selectedCapabilities = (ask: RecordLike, debug: RecordLike | null): string[] => {
  const result = readRecord(ask.capability_selection_result) ?? readRecord(debug?.capability_selection_result);
  return [
    readString(result?.capability_id),
    ...readRecordArray(ask.capability_selection_trace ?? debug?.capability_selection_trace).map((entry) =>
      readString(entry.selected_capability),
    ),
  ].filter((entry: string | null): entry is string => Boolean(entry));
};

const visibleToolSurface = (rail: RecordLike | null): string[] => readStringArray(rail?.visible_tool_surface);

const capabilityObserved = (capability: string, observed: string[]): boolean =>
  observed.some((entry) => entry === capability || entry.includes(capability) || capability.includes(entry));

const seedVisualCapture = async (threadId: string, scenarioId: string, scenarioDir: string): Promise<RecordLike> => {
  const seed = await fetchJson<RecordLike>(`${BASE_URL}/api/agi/situation/test-harness/live-visual-source`, {
    method: "POST",
    body: JSON.stringify({
      thread_id: threadId,
      source_id: `visual_source:codex-methodology:${scenarioId}:${Date.now()}`,
      scene_text: "A backend-seeded visual capture shows a Helix Ask debug panel with a visible Start button and trace table.",
      activity: "Inspecting a Helix Ask debug panel and visible controls.",
      objects: "debug panel, trace table, Start button, toolbar",
      confidence: 0.82,
    }),
  });
  await fs.writeFile(path.join(scenarioDir, "seed.json"), `${JSON.stringify(seed, null, 2)}\n`);
  return seed;
};

const summarizeScenario = (input: {
  scenario: DebugScenario;
  ask: RecordLike;
  debugExport: unknown;
  methodologyRefs: CodexMethodologyRef[];
}): RecordLike => {
  const { scenario, ask, debugExport, methodologyRefs } = input;
  const debug = debugPayload(debugExport);
  const loop = loopTrace(ask, debug);
  const solver = solverTrace(ask, debug);
  const route = routeAuthority(ask, debug);
  const terminal = terminalAuthority(ask, debug);
  const poison = poisonAudit(ask, debug);
  const rails = railTables(ask, debug, debugExport);
  const rail = rails[0] ?? null;
  const subgoalRails = compoundSubgoalRails(ask, debug, debugExport);
  const actualObserved = Array.from(new Set([
    ...actualToolCalls(loop),
    readString(rail?.executed_capability),
    ...subgoalRails.map((entry) => readString(entry.executed_capability)),
  ].filter((entry: string | null): entry is string => Boolean(entry))));
  const selectedOrAdmittedObserved = Array.from(new Set([
    ...selectedCapabilities(ask, debug),
    readString(rail?.requested_capability),
    readString(rail?.selected_capability),
    readString(rail?.admitted_capability),
    ...subgoalRails.flatMap((entry) => [
      readString(entry.requested_capability),
      readString(entry.runtime_capability),
      readString(entry.selected_capability),
    ]),
  ].filter((entry: string | null): entry is string => Boolean(entry))));
  const runtimeObserved = Array.from(new Set([
    ...actualObserved,
    ...selectedOrAdmittedObserved,
    ...subgoalRails.flatMap((entry) => [
      readString(entry.observation_kind),
    ]),
  ].filter((entry: string | null): entry is string => Boolean(entry))));
  const visibleObserved = visibleToolSurface(rail);
  const observed = Array.from(new Set([...runtimeObserved, ...visibleObserved]));

  const missingExpected = (scenario.expected_capabilities ?? []).filter((capability) =>
    !capabilityObserved(capability, runtimeObserved),
  );
  const forbiddenSeen = (scenario.forbidden_capabilities ?? []).filter((capability) =>
    capabilityObserved(capability, actualObserved),
  );
  const forbiddenSelectedOrAdmitted = (scenario.forbidden_capabilities ?? []).filter((capability) =>
    capabilityObserved(capability, selectedOrAdmittedObserved),
  );
  const failures = [
    !debug ? "debug_export_missing" : null,
    !solver ? "ask_turn_solver_trace_missing" : null,
    ...missingExpected.map((capability) => `expected_capability_missing:${capability}`),
    ...forbiddenSeen.map((capability) => `forbidden_capability_seen:${capability}`),
  ].filter((entry: string | null): entry is string => Boolean(entry));

  const terminalArtifactKind =
    readString(ask.terminal_artifact_kind) ??
    readString(debug?.terminal_artifact_kind) ??
    readString(getPath(debug, ["terminal_answer_authority", "terminal_artifact_kind"]));
  const finalAnswerSource =
    readString(ask.final_answer_source) ??
    readString(debug?.final_answer_source) ??
    readString(getPath(debug, ["terminal_answer_authority", "final_answer_source"]));
  const terminalErrorCode =
    readString(ask.terminal_error_code) ??
    readString(debug?.terminal_error_code) ??
    readString(getPath(debug, ["resolved_turn_summary", "terminal_error_code"]));

  return {
    schema: "helix.ask_codex_methodology_debug_result.v1",
    scenario_id: scenario.id,
    kind: scenario.kind,
    family: scenario.family,
    prompt: scenario.prompt,
    operator_sensitive: scenario.operator_sensitive === true,
    notes: scenario.notes ?? null,
    turn_id: readString(ask.turn_id),
    verdict: failures.length ? "FAIL" : "PASS",
    failures,
    expected_capabilities: scenario.expected_capabilities ?? [],
    forbidden_capabilities: scenario.forbidden_capabilities ?? [],
    actual_observed_capabilities: actualObserved,
    selected_or_admitted_capabilities: selectedOrAdmittedObserved,
    runtime_observed_capabilities: runtimeObserved,
    visible_surface_capabilities: visibleObserved,
    observed_capabilities: observed,
    missing_expected_capabilities: missingExpected,
    forbidden_capabilities_seen: forbiddenSeen,
    forbidden_selected_or_admitted_capabilities: forbiddenSelectedOrAdmitted,
    terminal_artifact_kind: terminalArtifactKind,
    final_answer_source: finalAnswerSource,
    terminal_error_code: terminalErrorCode,
    source_target:
      readString(getPath(debug, ["source_target_intent", "target_source"])) ??
      readString(getPath(route, ["source_target"])),
    selected_route:
      readString(ask.route_reason_code) ??
      readString(debug?.route_reason_code) ??
      readString(loop?.selected_route) ??
      readString(getPath(debug, ["resolved_turn_summary", "resolved_route_label"])),
    authority: {
      route_authority_ok: route?.route_authority_ok === true,
      route_authority_violation_codes: readStringArray(route?.violation_codes),
      terminal_authority_ok: terminal?.server_authoritative === true,
      poison_audit_ok: poison?.ok === true,
    },
    solver_trace: {
      present: Boolean(solver),
      completed_solver_path: solver?.completed_solver_path === true,
      selected_primary_intent: readString(solver?.selected_primary_intent),
      prompt_shape: readString(getPath(solver, ["prompt_interpretation", "prompt_shape"])),
      contextual_tool_mentions: readRecordArray(getPath(solver, ["prompt_interpretation", "contextual_tool_mentions"]))
        .map((entry) => readString(entry.verb_or_cue) ?? readString(entry.text))
        .filter((entry: string | null): entry is string => Boolean(entry)),
      executable_operator_commands_count: readArray(getPath(solver, ["prompt_interpretation", "executable_operator_commands"])).length,
      solver_short_circuit_flags: readStringArray(solver?.solver_short_circuit_flags),
    },
    loop_parity_trace: {
      admitted_tool_families: readStringArray(loop?.admitted_tool_families),
      actual_tool_calls: actualToolCalls(loop),
      unexpected_tool_calls: readStringArray(loop?.unexpected_tool_calls),
      short_circuit_risk_flags: readStringArray(loop?.short_circuit_risk_flags),
      observations_created_count: readArray(loop?.observations_created).length,
      evidence_selected_for_answer_count: readArray(loop?.evidence_selected_for_answer).length,
    },
    rail_table: rail
      ? {
          requested_capability: readString(rail.requested_capability),
          selected_capability: readString(rail.selected_capability),
          admitted_capability: readString(rail.admitted_capability),
          executed_capability: readString(rail.executed_capability),
          observation_kind: readString(rail.observation_kind),
          observation_ref: readString(rail.observation_ref),
          reentry_status: readString(rail.reentry_status),
          reentry_proof_source: readString(rail.reentry_proof_source),
          goal_satisfaction: readString(rail.goal_satisfaction),
          required_terminal_kind: readString(rail.required_terminal_kind),
          selected_terminal_kind: readString(rail.selected_terminal_kind),
          visible_terminal_kind: readString(rail.visible_terminal_kind),
          terminal_authority_proof_source: readString(rail.terminal_authority_proof_source),
          visible_projection_source: readString(rail.visible_projection_source),
          rail_status: readString(rail.rail_status),
          codex_parity_class: readString(rail.codex_parity_class),
          first_broken_rail: readString(rail.first_broken_rail),
          rail_failure_code: readString(rail.rail_failure_code),
          repair_target: readString(rail.repair_target),
          compound_subgoal_count: typeof rail.compound_subgoal_count === "number" ? rail.compound_subgoal_count : null,
          compound_first_broken_rail: readString(rail.compound_first_broken_rail),
          compound_rail_failure_code: readString(rail.compound_rail_failure_code),
          compound_repair_target: readString(rail.compound_repair_target),
        }
      : null,
    compound_subgoal_rails: subgoalRails.map((entry) => ({
      subgoal_id: readString(entry.subgoal_id),
      requested_capability: readString(entry.requested_capability),
      runtime_capability: readString(entry.runtime_capability),
      selected_capability: readString(entry.selected_capability),
      executed_capability: readString(entry.executed_capability),
      observation_kind: readString(entry.observation_kind),
      observation_ref: readString(entry.observation_ref),
      satisfaction: readString(entry.satisfaction),
      rail_status: readString(entry.rail_status),
      first_broken_rail: readString(entry.first_broken_rail),
      rail_failure_code: readString(entry.rail_failure_code),
      repair_target: readString(entry.repair_target),
    })),
    codex_methodology_refs: methodologyRefs,
  };
};

const probeAskTurnApi = async (): Promise<Preflight> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(TIMEOUT_MS, 10_000));
  const url = `${BASE_URL}/api/agi/ask/turn/__helix_codex_methodology_preflight__/debug-export?view=rail`;
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
      hint: "Start the operator-owned keyed Helix Ask server before running the debug batch.",
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      reason:
        error instanceof Error && error.name === "AbortError"
          ? "ask_turn_api_preflight_timeout"
          : "ask_turn_api_unreachable",
      message: error instanceof Error ? error.message : String(error),
      hint: "Start the operator-owned keyed Helix Ask server before running the debug batch.",
    };
  } finally {
    clearTimeout(timeout);
  }
};

const runScenario = async (
  scenario: DebugScenario,
  runId: string,
  outputDir: string,
  methodologyById: Map<string, CodexMethodologyRef>,
): Promise<RecordLike> => {
  const threadId = `helix-ask:codex-methodology:${runId}:${scenario.id}`;
  const scenarioDir = path.join(outputDir, scenario.id);
  await fs.mkdir(scenarioDir, { recursive: true });
  if (scenario.seed === "visual_capture") {
    await seedVisualCapture(threadId, scenario.id, scenarioDir);
  }
  await fs.writeFile(path.join(scenarioDir, "prompt.json"), `${JSON.stringify(scenario, null, 2)}\n`);

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
  const methodologyRefs = (scenario.methodology_refs ?? [])
    .map((id) => methodologyById.get(id))
    .filter((entry: CodexMethodologyRef | undefined): entry is CodexMethodologyRef => Boolean(entry));
  const result = summarizeScenario({ scenario, ask, debugExport: debug, methodologyRefs });

  await fs.writeFile(path.join(scenarioDir, "ask-response.json"), `${JSON.stringify(ask, null, 2)}\n`);
  await fs.writeFile(path.join(scenarioDir, "debug-export.json"), `${JSON.stringify(debug, null, 2)}\n`);
  await fs.writeFile(path.join(scenarioDir, "trace-summary.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
};

const renderMarkdownSummary = (input: {
  runId: string;
  outputDir: string;
  results: RecordLike[];
  preflight?: Preflight;
  selectedScenarioIds: string[];
  skippedSensitive: string[];
}): string => {
  const lines = [
    "# Helix Ask Codex Methodology Debug Batch",
    "",
    `- run_id: ${input.runId}`,
    `- base_url: ${BASE_URL}`,
    `- output_dir: ${input.outputDir}`,
    `- selected_scenarios: ${input.selectedScenarioIds.join(", ") || "none"}`,
    `- skipped_operator_sensitive: ${input.skippedSensitive.join(", ") || "none"}`,
  ];
  if (input.preflight) {
    lines.push(`- preflight: ${input.preflight.ok ? "ok" : "blocked"} (${input.preflight.reason})`);
    if (input.preflight.hint) lines.push(`- preflight_hint: ${input.preflight.hint}`);
  }
  lines.push(
    "",
    "| Verdict | Scenario | Family | Terminal | Rail | First rail | Repair | Missing expected | Forbidden seen |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const result of input.results) {
    const rail = readRecord(result.rail_table);
    lines.push(
      `| ${readString(result.verdict) ?? "FAIL"} | ${readString(result.scenario_id) ?? "-"} | ${
        readString(result.family) ?? "-"
      } | ${readString(result.terminal_artifact_kind) ?? "-"} | ${readString(rail?.codex_parity_class) ?? "-"} | ${
        readString(rail?.first_broken_rail) ?? "-"
      } | ${readString(rail?.repair_target) ?? "-"} | ${readStringArray(result.missing_expected_capabilities).join(", ") || "-"} | ${
        readStringArray(result.forbidden_capabilities_seen).join(", ") || "-"
      } |`,
    );
  }
  return `${lines.join("\n")}\n`;
};

const main = async (): Promise<0 | 1> => {
  const promptSet = await loadPromptSet();
  const methodologyById = new Map(promptSet.codex_methodology_refs.map((entry) => [entry.id, entry]));
  const selection = selectScenarios(promptSet);
  const runId = `codex-methodology-${Date.now()}`;
  const outputDir = path.resolve(OUT_DIR, runId);
  await fs.mkdir(outputDir, { recursive: true });
  const selectedScenarioIds = selection.scenarios.map((scenario) => scenario.id);

  if (selection.unknownIds.length || selectedScenarioIds.length === 0) {
    const summary = {
      schema: "helix.ask_codex_methodology_debug_summary.v1",
      ok: false,
      blocked: true,
      blocked_reason: selection.unknownIds.length ? "unknown_scenario_filter" : "no_scenarios_selected",
      run_id: runId,
      base_url: BASE_URL,
      output_dir: outputDir,
      prompt_set_path: path.resolve(PROMPT_SET_PATH),
      requested_scenarios: selection.requestedIds,
      selected_scenarios: selectedScenarioIds,
      unknown_scenarios: selection.unknownIds,
      skipped_operator_sensitive: selection.skippedSensitive,
      available_scenarios: selection.availableIds,
      results: [],
    };
    await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await fs.writeFile(
      path.join(outputDir, "summary.md"),
      renderMarkdownSummary({
        runId,
        outputDir,
        results: [],
        selectedScenarioIds,
        skippedSensitive: selection.skippedSensitive,
      }),
    );
    console.log(JSON.stringify(summary, null, 2));
    return 1;
  }

  if (DRY_RUN) {
    const summary = {
      schema: "helix.ask_codex_methodology_debug_summary.v1",
      ok: true,
      dry_run: true,
      run_id: runId,
      base_url: BASE_URL,
      output_dir: outputDir,
      prompt_set_path: path.resolve(PROMPT_SET_PATH),
      requested_scenarios: selection.requestedIds,
      selected_scenarios: selectedScenarioIds,
      skipped_operator_sensitive: selection.skippedSensitive,
      available_scenarios: selection.availableIds,
      codex_methodology_refs: promptSet.codex_methodology_refs,
      scenarios: selection.scenarios,
      results: [],
    };
    await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await fs.writeFile(
      path.join(outputDir, "summary.md"),
      renderMarkdownSummary({
        runId,
        outputDir,
        results: [],
        selectedScenarioIds,
        skippedSensitive: selection.skippedSensitive,
      }),
    );
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  const preflight = await probeAskTurnApi();
  if (!preflight.ok) {
    const summary = {
      schema: "helix.ask_codex_methodology_debug_summary.v1",
      ok: false,
      blocked: true,
      blocked_reason: preflight.reason,
      run_id: runId,
      base_url: BASE_URL,
      output_dir: outputDir,
      prompt_set_path: path.resolve(PROMPT_SET_PATH),
      selected_scenarios: selectedScenarioIds,
      skipped_operator_sensitive: selection.skippedSensitive,
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
        selectedScenarioIds,
        skippedSensitive: selection.skippedSensitive,
      }),
    );
    console.log(JSON.stringify(summary, null, 2));
    return 1;
  }

  const results: RecordLike[] = [];
  for (const scenario of selection.scenarios) {
    try {
      console.error(`[helix-codex-debug] ${scenario.id}: ${scenario.prompt}`);
      results.push(await runScenario(scenario, runId, outputDir, methodologyById));
    } catch (error) {
      results.push({
        schema: "helix.ask_codex_methodology_debug_result.v1",
        scenario_id: scenario.id,
        kind: scenario.kind,
        family: scenario.family,
        prompt: scenario.prompt,
        verdict: "FAIL",
        failures: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  const failCount = results.filter((result) => result.verdict === "FAIL").length;
  const summary = {
    schema: "helix.ask_codex_methodology_debug_summary.v1",
    ok: failCount === 0,
    run_id: runId,
    base_url: BASE_URL,
    output_dir: outputDir,
    prompt_set_path: path.resolve(PROMPT_SET_PATH),
    requested_scenarios: selection.requestedIds,
    selected_scenarios: selectedScenarioIds,
    skipped_operator_sensitive: selection.skippedSensitive,
    include_operator_sensitive: INCLUDE_SENSITIVE,
    counts: {
      pass: results.filter((result) => result.verdict === "PASS").length,
      fail: failCount,
    },
    preflight,
    codex_methodology_refs: promptSet.codex_methodology_refs,
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
      selectedScenarioIds,
      skippedSensitive: selection.skippedSensitive,
    }),
  );
  console.log(JSON.stringify(summary, null, 2));
  return summary.ok ? 0 : 1;
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
