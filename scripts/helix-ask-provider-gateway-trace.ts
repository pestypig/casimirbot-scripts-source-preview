import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import request from "supertest";
import { codexProvider } from "../server/services/helix-ask/agent-providers/codex-provider";
import { planRouter } from "../server/routes/agi.plan";
import { callWorkstationGatewayCapability } from "../server/services/helix-ask/workstation-tool-gateway/registry";

type Scenario = {
  id: string;
  capabilityId: string;
  args: Record<string, unknown>;
  expectedOk: boolean;
  expectedObservationSchema?: string;
  expectedError?: string;
  mode?: "read" | "observe" | "act" | "verify";
  expectedCallResultCount?: number;
  expectedObservationPacketCount?: number;
};

const OUT_DIR = process.env.HELIX_ASK_PROVIDER_GATEWAY_TRACE_OUT ?? "artifacts/helix-ask-provider-gateway-trace";
const SPAWN_CODEX = process.env.HELIX_ASK_PROVIDER_GATEWAY_TRACE_SPAWN_CODEX === "1";
const LIVE_MODE = process.env.HELIX_ASK_PROVIDER_GATEWAY_TRACE_LIVE === "1";
const BASE_URL = (process.env.HELIX_ASK_BASE_URL ?? "").replace(/\/+$/, "");

const scenarios: Scenario[] = [
  {
    id: "workspace_status",
    capabilityId: "workspace_os.status",
    args: { capability_ids: ["runtime.memory"] },
    expectedOk: true,
    expectedObservationSchema: "helix.workspace_os_status_observation.v1",
  },
  {
    id: "calculator",
    capabilityId: "scientific-calculator.solve_expression",
    args: { expression: "8 * 9" },
    expectedOk: true,
    expectedObservationSchema: "helix.calculator_solve_observation.v1",
    expectedCallResultCount: 4,
    expectedObservationPacketCount: 4,
  },
  {
    id: "repo_search",
    capabilityId: "repo.search",
    args: { query: "workspace_os.status", paths: ["server/services/helix-ask"], max_hits: 3 },
    expectedOk: true,
    expectedObservationSchema: "helix.repo_search_observation.v1",
  },
  {
    id: "docs_search",
    capabilityId: "docs.search",
    args: { query: "Helix Ask", paths: ["docs"], max_hits: 3 },
    expectedOk: true,
    expectedObservationSchema: "helix.docs_search_observation.v1",
  },
  {
    id: "context_feed_trace_memory",
    capabilityId: "live_env.query_trace_memory",
    args: { source_id: "provider-gateway-trace-source", source_ref: "provider-gateway-trace-source", limit: 2 },
    expectedOk: true,
    expectedObservationSchema: "helix.live_environment_tool_observation.v1",
  },
  {
    id: "context_feed_narrator_events",
    capabilityId: "live_env.query_narrator_events",
    args: { source_id: "provider-gateway-trace-source", source_ref: "provider-gateway-trace-source", limit: 2 },
    expectedOk: true,
    expectedObservationSchema: "helix.live_environment_tool_observation.v1",
  },
  {
    id: "context_feed_audio_transcripts",
    capabilityId: "live_env.query_audio_transcripts",
    args: { source_id: "provider-gateway-trace-source", source_ref: "provider-gateway-trace-source", limit: 2 },
    expectedOk: true,
    expectedObservationSchema: "helix.live_environment_tool_observation.v1",
  },
  {
    id: "context_feed_live_answer_state",
    capabilityId: "live_env.query_live_answer_state",
    args: { source_id: "provider-gateway-trace-source", source_ref: "provider-gateway-trace-source", limit: 2 },
    expectedOk: true,
    expectedObservationSchema: "helix.live_environment_tool_observation.v1",
  },
  {
    id: "context_feed_route_evidence",
    capabilityId: "live_env.query_route_evidence",
    args: { source_id: "provider-gateway-trace-source", source_ref: "provider-gateway-trace-source", limit: 2 },
    expectedOk: true,
    expectedObservationSchema: "helix.live_environment_tool_observation.v1",
  },
  {
    id: "source_health",
    capabilityId: "live_env.query_source_health",
    args: { source_id: "provider-gateway-trace-source", source_ref: "provider-gateway-trace-source", limit: 2 },
    expectedOk: true,
    expectedObservationSchema: "helix.live_environment_tool_observation.v1",
  },
  {
    id: "loop_health",
    capabilityId: "live_env.query_live_source_loop_health",
    args: {
      source_id: "provider-gateway-trace-source",
      source_ref: "provider-gateway-trace-source",
      expected_cadence_ms: 10000,
    },
    expectedOk: true,
    expectedObservationSchema: "helix.live_environment_tool_observation.v1",
  },
  {
    id: "live_source_state",
    capabilityId: "live_env.query_live_source_quality",
    args: { source_id: "provider-gateway-trace-source", source_ref: "provider-gateway-trace-source", limit: 2 },
    expectedOk: true,
    expectedObservationSchema: "helix.live_environment_tool_observation.v1",
  },
  {
    id: "mailbox_read",
    capabilityId: "live_env.check_live_source_mail",
    args: {
      source_id: "provider-gateway-trace-source",
      source_ref: "provider-gateway-trace-source",
      limit: 2,
      read_only: true,
    },
    expectedOk: true,
    expectedObservationSchema: "helix.live_environment_tool_observation.v1",
  },
  {
    id: "interpreter_prediction_blocked",
    capabilityId: "live_env.predict_live_source_immediate",
    args: { source_id: "provider-gateway-trace-source", source_ref: "provider-gateway-trace-source", limit: 2 },
    expectedOk: false,
    expectedObservationSchema: "helix.live_environment_tool_observation.v1",
  },
  {
    id: "stage_builder_read",
    capabilityId: "live_env.describe_stage_builder",
    args: { limit: 2 },
    expectedOk: true,
    expectedObservationSchema: "helix.live_environment_tool_observation.v1",
  },
  {
    id: "micro_reasoner_presets",
    capabilityId: "live_env.query_micro_reasoner_presets",
    args: { source_id: "provider-gateway-trace-source", source_ref: "provider-gateway-trace-source", limit: 2 },
    expectedOk: true,
    expectedObservationSchema: "helix.live_environment_tool_observation.v1",
  },
  {
    id: "micro_reasoner_test_prompt",
    capabilityId: "live_env.test_micro_reasoner_prompt",
    args: {
      source_id: "provider-gateway-trace-source",
      source_ref: "provider-gateway-trace-source",
      role: "claim_extractor",
      prompt: "Extract bounded claims from this provider gateway trace check.",
    },
    expectedOk: true,
    expectedObservationSchema: "helix.live_environment_tool_observation.v1",
  },
  {
    id: "visual_observer_profiles",
    capabilityId: "live_env.query_visual_observer_profiles",
    args: { source_id: "provider-gateway-trace-source", source_ref: "provider-gateway-trace-source", limit: 2 },
    expectedOk: true,
    expectedObservationSchema: "helix.live_environment_tool_observation.v1",
  },
  {
    id: "visual_observer_test_blocked",
    capabilityId: "live_env.test_visual_observer_profile",
    args: { source_id: "provider-gateway-trace-source", source_ref: "provider-gateway-trace-source", limit: 2 },
    expectedOk: false,
    expectedObservationSchema: "helix.live_environment_tool_observation.v1",
  },
  {
    id: "narrator_say",
    capabilityId: "live_env.narrator_say",
    args: {
      text: "provider gateway narrator check",
      kind: "narrator_read",
      evidence_refs: ["ask:provider-gateway-trace:narrator_say"],
    },
    expectedOk: true,
    expectedObservationSchema: "helix.interim_voice_callout_tool_result.v1",
    mode: "act",
  },
  {
    id: "internet_search_missing_provider",
    capabilityId: "internet-search.search_web",
    args: { query: "Alcubierre metric energy requirements", limit: 2 },
    expectedOk: false,
    expectedObservationSchema: "helix.internet_search_observation.v1",
  },
  {
    id: "scholarly_research",
    capabilityId: "scholarly-research.lookup_papers",
    args: { query: "Alcubierre metric energy requirements", providers: ["arxiv"], limit: 2 },
    expectedOk: true,
    expectedObservationSchema: "helix.scholarly_research_observation.v1",
  },
  {
    id: "blocked_mutation",
    capabilityId: "filesystem.write_file",
    args: { path: "server/routes/agi.plan.ts", text: "blocked" },
    expectedOk: false,
    expectedError: "capability_not_registered",
  },
  {
    id: "held_back_live_control",
    capabilityId: "live_env.pause_workstation_loop",
    args: { reason: "provider gateway trace must not expose held-back live controls" },
    expectedOk: false,
    expectedError: "capability_not_registered",
  },
];

const readRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const readRecordArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.map(readRecord).filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];

const readStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

const expectedCallResultCountForScenario = (
  scenario: Scenario,
  providerId: "helix" | "codex" | "future" = "codex",
): number =>
  providerId === "codex" ? scenario.expectedCallResultCount ?? 1 : 1;

const expectedObservationPacketCountForScenario = (
  scenario: Scenario,
  providerId: "helix" | "codex" | "future" = "codex",
): number =>
  providerId === "codex"
    ? scenario.expectedObservationPacketCount ?? expectedCallResultCountForScenario(scenario, providerId)
    : 1;

const expectedCodexReentryStatusForScenario = (scenario: Scenario): string =>
  scenario.expectedOk ? "completed" : "pending_helix_solver_reentry";

const writeJson = async (filePath: string, value: unknown) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const createRouteTraceApp = () => {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/agi", planRouter);
  return app;
};

const addProviderGatewaySummaryFailures = (input: {
  failures: string[];
  prefix: string;
  source: Record<string, unknown> | null;
  expectedProvider: string;
  expectedCapabilityId: string;
  expectedOk: boolean;
  expectedReentryStatus: string;
  expectedTerminalAuthorityStatus: string;
  expectedFinalAnswerSource: string | null;
}) => {
  const summary = readRecord(input.source?.provider_gateway_debug_summary);
  if (!summary) {
    input.failures.push(`${input.prefix}_provider_gateway_debug_summary_missing`);
    return;
  }
  if (readString(summary.schema) !== "helix.provider_gateway_debug_summary.v1") {
    input.failures.push(`${input.prefix}_provider_gateway_debug_summary_schema:${readString(summary.schema) ?? "missing"}`);
  }
  if (readString(summary.selected_provider) !== input.expectedProvider) {
    input.failures.push(
      `${input.prefix}_summary_provider:${readString(summary.selected_provider) ?? "missing"}!=${input.expectedProvider}`,
    );
  }
  if (readString(summary.capability_manifest_version) !== "read-observe-act.v1") {
    input.failures.push(`${input.prefix}_summary_manifest_version:${readString(summary.capability_manifest_version) ?? "missing"}`);
  }
  const requestedCapabilities = readStringArray(summary.requested_capabilities);
  const admittedCapabilities = readStringArray(summary.admitted_capabilities);
  const executedCapabilities = readStringArray(summary.executed_capabilities);
  if (!requestedCapabilities.includes(input.expectedCapabilityId)) {
    input.failures.push(`${input.prefix}_summary_requested_capability_missing:${input.expectedCapabilityId}`);
  }
  if (input.expectedOk && !admittedCapabilities.includes(input.expectedCapabilityId)) {
    input.failures.push(`${input.prefix}_summary_admitted_capability_missing:${input.expectedCapabilityId}`);
  }
  if (input.expectedOk && !executedCapabilities.includes(input.expectedCapabilityId)) {
    input.failures.push(`${input.prefix}_summary_executed_capability_missing:${input.expectedCapabilityId}`);
  }
  if (!input.expectedOk) {
    const blockedCapabilities = readRecordArray(summary.blocked_capabilities);
    const blockedCapabilityIds = blockedCapabilities
      .map((entry) => readString(entry.capability_id))
      .filter((entry): entry is string => Boolean(entry));
    const capabilityWasStillTracked =
      requestedCapabilities.includes(input.expectedCapabilityId) ||
      admittedCapabilities.includes(input.expectedCapabilityId) ||
      executedCapabilities.includes(input.expectedCapabilityId);
    if (!blockedCapabilityIds.includes(input.expectedCapabilityId) && !capabilityWasStillTracked) {
      input.failures.push(`${input.prefix}_summary_blocked_capability_missing:${input.expectedCapabilityId}`);
    }
  }
  if (readString(summary.evidence_reentry_status) !== input.expectedReentryStatus) {
    input.failures.push(
      `${input.prefix}_summary_reentry_status:${readString(summary.evidence_reentry_status) ?? "missing"}!=${input.expectedReentryStatus}`,
    );
  }
  if (readString(summary.terminal_authority_result) !== input.expectedTerminalAuthorityStatus) {
    input.failures.push(
      `${input.prefix}_summary_terminal_authority:${readString(summary.terminal_authority_result) ?? "missing"}!=${input.expectedTerminalAuthorityStatus}`,
    );
  }
  if (readString(summary.final_answer_source) !== input.expectedFinalAnswerSource) {
    input.failures.push(
      `${input.prefix}_summary_final_answer_source:${readString(summary.final_answer_source) ?? "missing"}!=${input.expectedFinalAnswerSource ?? "null"}`,
    );
  }
};

const fetchJson = async (url: string, init?: RequestInit): Promise<{
  ok: boolean;
  status: number;
  json: unknown;
  error: string | null;
}> => {
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    let json: unknown = null;
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw_text: text.slice(0, 4000) };
      }
    }
    return { ok: response.ok, status: response.status, json, error: null };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      json: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const writeBlockedLiveSummary = async (reason: string, detail: Record<string, unknown> = {}) => {
  const summary = {
    schema: "helix.provider_gateway_trace_summary.v1",
    output_dir: OUT_DIR,
    mode: "live",
    status: "blocked",
    blocked_reason: reason,
    base_url: BASE_URL || null,
    spawn_codex: SPAWN_CODEX,
    scenario_count: scenarios.length,
    passed_count: 0,
    failed_count: 0,
    blocked_count: scenarios.length,
    detail,
    scenarios: scenarios.map((scenario) => ({
      schema: "helix.provider_gateway_trace_probe_result.v1",
      scenario_id: scenario.id,
      procedural_ok: false,
      blocked: true,
      failures: [reason],
    })),
  };
  await writeJson(path.join(OUT_DIR, "summary.json"), summary);
};

const buildGatewayCallSummary = (result: Record<string, unknown>) => {
  const observation = readRecord(result.observation);
  const observationPacket = readRecord(result.observation_packet);
  const lifecycleTrace = readRecord(result.tool_lifecycle_trace);
  const followupDecision = readRecord(result.tool_followup_decision);
  return {
    capability_id: readString(result.capability_id),
    ok: result.ok === true,
    error: readString(result.error),
    admission_status: readString(readRecord(result.gateway_admission)?.admission_status),
    blocked_reason: readString(readRecord(result.gateway_admission)?.blocked_reason),
    observation_schema: readString(observation?.schema),
    observation_packet_status: readString(observationPacket?.status),
    observation_packet_terminal_eligible: observationPacket?.terminal_eligible,
    observation_packet_post_tool_step: observationPacket?.post_tool_model_step_required,
    observation_packet_assistant_answer: observationPacket?.assistant_answer,
    observation_packet_raw_content_included: observationPacket?.raw_content_included,
    lifecycle_status: readString(lifecycleTrace?.status),
    lifecycle_terminal_eligible: lifecycleTrace?.terminal_eligible,
    lifecycle_assistant_answer: lifecycleTrace?.assistant_answer,
    lifecycle_raw_content_included: lifecycleTrace?.raw_content_included,
    followup_next_action: readString(followupDecision?.next_action),
    followup_evidence_reentered: followupDecision?.evidence_reentered,
    followup_assistant_answer: followupDecision?.assistant_answer,
    followup_raw_content_included: followupDecision?.raw_content_included,
  };
};

const buildManifestCapabilitySummary = (
  manifest: Record<string, unknown> | null,
  capabilityId: string | null,
) => {
  const capability = readRecordArray(manifest?.capabilities)
    .find((entry) => readString(entry.capability_id) === capabilityId);
  return {
    capability_id: readString(capability?.capability_id),
    mode: readString(capability?.mode),
    permission_profile_required: readString(capability?.permission_profile_required),
    output_observation_schema: readString(capability?.output_observation_schema),
    observation_schema: readString(capability?.observation_schema),
    mutating: capability?.mutating,
    code_mutation: capability?.code_mutation,
    shell_access: capability?.shell_access,
    terminal_eligible: capability?.terminal_eligible,
    post_tool_model_step_required: capability?.post_tool_model_step_required,
    assistant_answer: capability?.assistant_answer,
    raw_content_included: capability?.raw_content_included,
  };
};

const buildProviderCandidateSummary = (ask: Record<string, unknown>) => {
  const candidate = readRecord(ask.provider_terminal_candidate);
  const reentry = readRecord(ask.provider_reasoning_reentry);
  const review = readRecord(ask.terminal_authority_candidate_review);
  return {
    candidate_schema: readString(candidate?.schema),
    candidate_present: Boolean(candidate),
    candidate_ref: readString(candidate?.candidate_id),
    candidate_provider: readString(candidate?.selected_agent_provider),
    candidate_terminal_eligible: candidate?.terminal_eligible,
    candidate_assistant_answer: candidate?.assistant_answer,
    candidate_raw_content_included: candidate?.raw_content_included,
    reentry_schema: readString(reentry?.schema),
    reentry_status: readString(reentry?.status),
    reentry_evidence_reentered: reentry?.evidence_reentered,
    terminal_review_schema: readString(review?.schema),
    terminal_authority_status: readString(review?.terminal_authority_status),
    terminal_authority_granted: review?.terminal_authority_granted,
    final_visible_answer_authorized: review?.final_visible_answer_authorized,
  };
};

const readDebugExportEndpoint = (ask: Record<string, unknown>): string | null => {
  const ref = ask.debug_export_ref;
  if (typeof ref === "string" && ref.trim()) return ref.trim();
  const refRecord = readRecord(ref);
  return readString(refRecord?.endpoint);
};

const parseSseEvents = (text: string): Array<{ event: string; data: Record<string, unknown> }> =>
  text
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = block
        .split(/\n/)
        .find((line) => line.startsWith("event:"))
        ?.slice("event:".length)
        .trim() ?? "";
      const dataText = block
        .split(/\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(dataText);
      } catch {
        data = {};
      }
      return { event, data };
    });

const runRouteDebugExportProbe = async (input: {
  app: ReturnType<typeof createRouteTraceApp>;
  body: Record<string, unknown>;
  scenario: Scenario;
}) => {
  const turnId = readString(input.body.turn_id) ?? "ask:provider-gateway-trace";
  const response = await request(input.app)
    .post("/api/agi/ask/turn")
    .send({
      ...input.body,
      session_id: `${turnId}:codex-route-session`,
      sessionId: `${turnId}:codex-route-session`,
    });
  const ask = readRecord(response.body) ?? {};
  const endpoint = readDebugExportEndpoint(ask);
  const debugResponse = endpoint
    ? await request(input.app).get(endpoint)
    : null;
  const debugExport = readRecord(debugResponse?.body) ?? null;
  const debugPayload = readRecord(debugExport?.payload);
  const routeFailures: string[] = [];
  const expectedCallResultCount = expectedCallResultCountForScenario(input.scenario, "codex");
  const expectedObservationPacketCount = expectedObservationPacketCountForScenario(input.scenario, "codex");
  const expectedReentryStatus = expectedCodexReentryStatusForScenario(input.scenario);
  if (response.status !== 200) routeFailures.push(`route_status:${response.status}`);
  if (!endpoint) routeFailures.push("route_debug_export_ref_missing");
  if (endpoint && debugResponse?.status !== 200) routeFailures.push(`route_debug_export_status:${debugResponse?.status ?? "missing"}`);
  if (readString(ask.agent_runtime) !== "codex") routeFailures.push(`route_agent_runtime:${readString(ask.agent_runtime) ?? "missing"}!=codex`);
  if (readString(ask.workstation_gateway_manifest_version) !== "read-observe-act.v1") {
    routeFailures.push("route_manifest_version_missing");
  }
  if (readString(ask.workstation_gateway_reentry_status) !== expectedReentryStatus) {
    routeFailures.push(
      `route_reentry_status:${readString(ask.workstation_gateway_reentry_status) ?? "missing"}!=${expectedReentryStatus}`,
    );
  }
  if (input.scenario.expectedOk) {
    if (readString(ask.terminal_authority_status) !== "authorized_by_helix_provider_candidate_bridge") {
      routeFailures.push(`route_terminal_authority_status:${readString(ask.terminal_authority_status) ?? "missing"}`);
    }
    if (readString(ask.final_answer_source) !== "agent_provider_terminal_candidate") {
      routeFailures.push(`route_final_answer_source:${readString(ask.final_answer_source) ?? "missing"}`);
    }
  }
  if (debugPayload) {
    if (readString(debugPayload.agent_runtime) !== "codex") {
      routeFailures.push(`debug_agent_runtime:${readString(debugPayload.agent_runtime) ?? "missing"}!=codex`);
    }
    if (readString(debugPayload.workstation_gateway_manifest_version) !== "read-observe-act.v1") {
      routeFailures.push("debug_manifest_version_missing");
    }
    if (readRecordArray(debugPayload.workstation_gateway_call_results).length !== expectedCallResultCount) {
      routeFailures.push(
        `debug_gateway_call_result_count:${readRecordArray(debugPayload.workstation_gateway_call_results).length}`,
      );
    }
    if (readRecordArray(debugPayload.workstation_gateway_observation_packets).length !== expectedObservationPacketCount) {
      routeFailures.push(
        `debug_observation_packet_count:${readRecordArray(debugPayload.workstation_gateway_observation_packets).length}`,
      );
    }
    if (input.scenario.expectedOk) {
      if (readString(debugPayload.workstation_gateway_reentry_status) !== expectedReentryStatus) {
        routeFailures.push(
          `debug_reentry_status:${readString(debugPayload.workstation_gateway_reentry_status) ?? "missing"}!=${expectedReentryStatus}`,
        );
      }
      if (readString(debugPayload.terminal_authority_status) !== "authorized_by_helix_provider_candidate_bridge") {
        routeFailures.push(`debug_terminal_authority_status:${readString(debugPayload.terminal_authority_status) ?? "missing"}`);
      }
      if (readString(debugPayload.final_answer_source) !== "agent_provider_terminal_candidate") {
        routeFailures.push(`debug_final_answer_source:${readString(debugPayload.final_answer_source) ?? "missing"}`);
      }
    }
  }
  addProviderGatewaySummaryFailures({
    failures: routeFailures,
    prefix: "route",
    source: ask,
    expectedProvider: "codex",
    expectedCapabilityId: input.scenario.capabilityId,
    expectedOk: input.scenario.expectedOk,
    expectedReentryStatus,
    expectedTerminalAuthorityStatus: input.scenario.expectedOk
      ? "authorized_by_helix_provider_candidate_bridge"
      : "blocked_by_gateway_observation_state",
    expectedFinalAnswerSource: input.scenario.expectedOk ? "agent_provider_terminal_candidate" : null,
  });
  addProviderGatewaySummaryFailures({
    failures: routeFailures,
    prefix: "debug",
    source: debugPayload,
    expectedProvider: "codex",
    expectedCapabilityId: input.scenario.capabilityId,
    expectedOk: input.scenario.expectedOk,
    expectedReentryStatus,
    expectedTerminalAuthorityStatus: input.scenario.expectedOk
      ? "authorized_by_helix_provider_candidate_bridge"
      : "blocked_by_gateway_observation_state",
    expectedFinalAnswerSource: input.scenario.expectedOk ? "agent_provider_terminal_candidate" : null,
  });

  return {
    ask,
    debugExport,
    summary: {
      schema: "helix.provider_gateway_route_debug_export_probe.v1",
      response_status: response.status,
      debug_export_status: debugResponse?.status ?? null,
      debug_export_endpoint: endpoint,
      provider_selected: readString(ask.agent_runtime),
      manifest_version: readString(ask.workstation_gateway_manifest_version),
      gateway_call_result_count: readRecordArray(ask.workstation_gateway_call_results).length,
      debug_gateway_call_result_count: readRecordArray(debugPayload?.workstation_gateway_call_results).length,
      debug_observation_packet_count: readRecordArray(debugPayload?.workstation_gateway_observation_packets).length,
      reentry_status: readString(ask.workstation_gateway_reentry_status),
      debug_reentry_status: readString(debugPayload?.workstation_gateway_reentry_status),
      terminal_authority_status: readString(ask.terminal_authority_status),
      debug_terminal_authority_status: readString(debugPayload?.terminal_authority_status),
      final_answer_source: readString(ask.final_answer_source),
      debug_final_answer_source: readString(debugPayload?.final_answer_source),
      provider_gateway_debug_summary: readRecord(ask.provider_gateway_debug_summary),
      debug_provider_gateway_debug_summary: readRecord(debugPayload?.provider_gateway_debug_summary),
      procedural_ok: routeFailures.length === 0,
      failures: routeFailures,
    },
  };
};

const runHelixRouteDebugExportProbe = async (input: {
  app: ReturnType<typeof createRouteTraceApp>;
  body: Record<string, unknown>;
  scenario: Scenario;
}) => {
  const turnId = readString(input.body.turn_id) ?? "ask:provider-gateway-trace";
  const response = await request(input.app)
    .post("/api/agi/ask/turn")
    .send({
      ...input.body,
      agent_runtime: "helix",
      turn_id: `${turnId}:helix-route`,
      session_id: `${turnId}:helix-route-session`,
      sessionId: `${turnId}:helix-route-session`,
      question: `Use the provided Helix workstation gateway observation for ${input.scenario.id} through Helix Native.`,
    });
  const ask = readRecord(response.body) ?? {};
  const endpoint = readDebugExportEndpoint(ask);
  const debugResponse = endpoint
    ? await request(input.app).get(endpoint)
    : null;
  const debugExport = readRecord(debugResponse?.body) ?? null;
  const debugPayload = readRecord(debugExport?.payload);
  const routeFailures: string[] = [];
  const expectedCallResultCount = expectedCallResultCountForScenario(input.scenario, "helix");
  const expectedObservationPacketCount = expectedObservationPacketCountForScenario(input.scenario, "helix");
  if (response.status !== 200) routeFailures.push(`helix_route_status:${response.status}`);
  if (!endpoint) routeFailures.push("helix_route_debug_export_ref_missing");
  if (endpoint && debugResponse?.status !== 200) {
    routeFailures.push(`helix_route_debug_export_status:${debugResponse?.status ?? "missing"}`);
  }
  if (readString(ask.agent_runtime) !== "helix") {
    routeFailures.push(`helix_route_agent_runtime:${readString(ask.agent_runtime) ?? "missing"}!=helix`);
  }
  if (readString(ask.workstation_gateway_manifest_version) !== "read-observe-act.v1") {
    routeFailures.push("helix_route_manifest_version_missing");
  }
  if (readString(ask.workstation_gateway_reentry_status) !== "pending_helix_solver_reentry") {
    routeFailures.push(
      `helix_route_reentry_status:${readString(ask.workstation_gateway_reentry_status) ?? "missing"}!=pending_helix_solver_reentry`,
    );
  }
  if (readString(ask.terminal_authority_status) !== "not_authorized_observation_only") {
    routeFailures.push(
      `helix_route_terminal_authority_status:${readString(ask.terminal_authority_status) ?? "missing"}!=not_authorized_observation_only`,
    );
  }
  if (readString(ask.final_answer_source) !== null) {
    routeFailures.push(`helix_route_final_answer_source:${readString(ask.final_answer_source) ?? "missing"}!=null`);
  }
  if (debugPayload) {
    if (readString(debugPayload.agent_runtime) !== "helix") {
      routeFailures.push(`helix_debug_agent_runtime:${readString(debugPayload.agent_runtime) ?? "missing"}!=helix`);
    }
    if (readString(debugPayload.workstation_gateway_manifest_version) !== "read-observe-act.v1") {
      routeFailures.push("helix_debug_manifest_version_missing");
    }
    if (readRecordArray(debugPayload.workstation_gateway_call_results).length !== expectedCallResultCount) {
      routeFailures.push(
        `helix_debug_gateway_call_result_count:${readRecordArray(debugPayload.workstation_gateway_call_results).length}`,
      );
    }
    if (readRecordArray(debugPayload.workstation_gateway_observation_packets).length !== expectedObservationPacketCount) {
      routeFailures.push(
        `helix_debug_observation_packet_count:${readRecordArray(debugPayload.workstation_gateway_observation_packets).length}`,
      );
    }
    if (readString(debugPayload.workstation_gateway_reentry_status) !== "pending_helix_solver_reentry") {
      routeFailures.push(
        `helix_debug_reentry_status:${readString(debugPayload.workstation_gateway_reentry_status) ?? "missing"}!=pending_helix_solver_reentry`,
      );
    }
    if (readString(debugPayload.terminal_authority_status) !== "not_authorized_observation_only") {
      routeFailures.push(
        `helix_debug_terminal_authority_status:${readString(debugPayload.terminal_authority_status) ?? "missing"}!=not_authorized_observation_only`,
      );
    }
    if (readString(debugPayload.final_answer_source) !== null) {
      routeFailures.push(`helix_debug_final_answer_source:${readString(debugPayload.final_answer_source) ?? "missing"}!=null`);
    }
  }
  addProviderGatewaySummaryFailures({
    failures: routeFailures,
    prefix: "helix_route",
    source: ask,
    expectedProvider: "helix",
    expectedCapabilityId: input.scenario.capabilityId,
    expectedOk: input.scenario.expectedOk,
    expectedReentryStatus: "pending_helix_solver_reentry",
    expectedTerminalAuthorityStatus: "not_authorized_observation_only",
    expectedFinalAnswerSource: null,
  });
  addProviderGatewaySummaryFailures({
    failures: routeFailures,
    prefix: "helix_debug",
    source: debugPayload,
    expectedProvider: "helix",
    expectedCapabilityId: input.scenario.capabilityId,
    expectedOk: input.scenario.expectedOk,
    expectedReentryStatus: "pending_helix_solver_reentry",
    expectedTerminalAuthorityStatus: "not_authorized_observation_only",
    expectedFinalAnswerSource: null,
  });

  return {
    ask,
    debugExport,
    summary: {
      schema: "helix.provider_gateway_helix_route_debug_export_probe.v1",
      response_status: response.status,
      debug_export_status: debugResponse?.status ?? null,
      debug_export_endpoint: endpoint,
      provider_selected: readString(ask.agent_runtime),
      manifest_version: readString(ask.workstation_gateway_manifest_version),
      gateway_call_result_count: readRecordArray(ask.workstation_gateway_call_results).length,
      debug_gateway_call_result_count: readRecordArray(debugPayload?.workstation_gateway_call_results).length,
      debug_observation_packet_count: readRecordArray(debugPayload?.workstation_gateway_observation_packets).length,
      reentry_status: readString(ask.workstation_gateway_reentry_status),
      debug_reentry_status: readString(debugPayload?.workstation_gateway_reentry_status),
      terminal_authority_status: readString(ask.terminal_authority_status),
      debug_terminal_authority_status: readString(debugPayload?.terminal_authority_status),
      final_answer_source: readString(ask.final_answer_source),
      debug_final_answer_source: readString(debugPayload?.final_answer_source),
      provider_gateway_debug_summary: readRecord(ask.provider_gateway_debug_summary),
      debug_provider_gateway_debug_summary: readRecord(debugPayload?.provider_gateway_debug_summary),
      procedural_ok: routeFailures.length === 0,
      failures: routeFailures,
    },
  };
};

const runFutureRouteDebugExportProbe = async (input: {
  app: ReturnType<typeof createRouteTraceApp>;
  body: Record<string, unknown>;
  scenario: Scenario;
}) => {
  const turnId = readString(input.body.turn_id) ?? "ask:provider-gateway-trace";
  const response = await request(input.app)
    .post("/api/agi/ask/turn")
    .send({
      ...input.body,
      agent_runtime: "future",
      turn_id: `${turnId}:future`,
      session_id: `${turnId}:future-route-session`,
      sessionId: `${turnId}:future-route-session`,
      question: `Use the provided Helix workstation gateway observation for ${input.scenario.id} through the Future provider wrapper.`,
    });
  const ask = readRecord(response.body) ?? {};
  const endpoint = readDebugExportEndpoint(ask);
  const debugResponse = endpoint
    ? await request(input.app).get(endpoint)
    : null;
  const debugExport = readRecord(debugResponse?.body) ?? null;
  const debugPayload = readRecord(debugExport?.payload);
  const routeFailures: string[] = [];
  const expectedCallResultCount = expectedCallResultCountForScenario(input.scenario, "future");
  const expectedObservationPacketCount = expectedObservationPacketCountForScenario(input.scenario, "future");
  if (response.status !== 200) routeFailures.push(`future_route_status:${response.status}`);
  if (!endpoint) routeFailures.push("future_route_debug_export_ref_missing");
  if (endpoint && debugResponse?.status !== 200) {
    routeFailures.push(`future_route_debug_export_status:${debugResponse?.status ?? "missing"}`);
  }
  if (readString(ask.agent_runtime) !== "future") {
    routeFailures.push(`future_route_agent_runtime:${readString(ask.agent_runtime) ?? "missing"}!=future`);
  }
  if (readString(ask.workstation_gateway_manifest_version) !== "read-observe-act.v1") {
    routeFailures.push("future_route_manifest_version_missing");
  }
  if (readString(ask.workstation_gateway_reentry_status) !== "pending_helix_solver_reentry") {
    routeFailures.push(
      `future_route_reentry_status:${readString(ask.workstation_gateway_reentry_status) ?? "missing"}!=pending_helix_solver_reentry`,
    );
  }
  if (readString(ask.terminal_authority_status) !== "not_authorized_observation_only") {
    routeFailures.push(
      `future_route_terminal_authority_status:${readString(ask.terminal_authority_status) ?? "missing"}!=not_authorized_observation_only`,
    );
  }
  if (readString(ask.final_answer_source) !== null) {
    routeFailures.push(`future_route_final_answer_source:${readString(ask.final_answer_source) ?? "missing"}!=null`);
  }
  if (debugPayload) {
    if (readString(debugPayload.agent_runtime) !== "future") {
      routeFailures.push(`future_debug_agent_runtime:${readString(debugPayload.agent_runtime) ?? "missing"}!=future`);
    }
    if (readString(debugPayload.workstation_gateway_manifest_version) !== "read-observe-act.v1") {
      routeFailures.push("future_debug_manifest_version_missing");
    }
    if (readRecordArray(debugPayload.workstation_gateway_call_results).length !== expectedCallResultCount) {
      routeFailures.push(
        `future_debug_gateway_call_result_count:${readRecordArray(debugPayload.workstation_gateway_call_results).length}`,
      );
    }
    if (readRecordArray(debugPayload.workstation_gateway_observation_packets).length !== expectedObservationPacketCount) {
      routeFailures.push(
        `future_debug_observation_packet_count:${readRecordArray(debugPayload.workstation_gateway_observation_packets).length}`,
      );
    }
    if (readString(debugPayload.workstation_gateway_reentry_status) !== "pending_helix_solver_reentry") {
      routeFailures.push(
        `future_debug_reentry_status:${readString(debugPayload.workstation_gateway_reentry_status) ?? "missing"}!=pending_helix_solver_reentry`,
      );
    }
    if (readString(debugPayload.terminal_authority_status) !== "not_authorized_observation_only") {
      routeFailures.push(
        `future_debug_terminal_authority_status:${readString(debugPayload.terminal_authority_status) ?? "missing"}!=not_authorized_observation_only`,
      );
    }
    if (readString(debugPayload.final_answer_source) !== null) {
      routeFailures.push(`future_debug_final_answer_source:${readString(debugPayload.final_answer_source) ?? "missing"}!=null`);
    }
  }
  addProviderGatewaySummaryFailures({
    failures: routeFailures,
    prefix: "future_route",
    source: ask,
    expectedProvider: "future",
    expectedCapabilityId: input.scenario.capabilityId,
    expectedOk: input.scenario.expectedOk,
    expectedReentryStatus: "pending_helix_solver_reentry",
    expectedTerminalAuthorityStatus: "not_authorized_observation_only",
    expectedFinalAnswerSource: null,
  });
  addProviderGatewaySummaryFailures({
    failures: routeFailures,
    prefix: "future_debug",
    source: debugPayload,
    expectedProvider: "future",
    expectedCapabilityId: input.scenario.capabilityId,
    expectedOk: input.scenario.expectedOk,
    expectedReentryStatus: "pending_helix_solver_reentry",
    expectedTerminalAuthorityStatus: "not_authorized_observation_only",
    expectedFinalAnswerSource: null,
  });

  return {
    ask,
    debugExport,
    summary: {
      schema: "helix.provider_gateway_future_route_debug_export_probe.v1",
      response_status: response.status,
      debug_export_status: debugResponse?.status ?? null,
      debug_export_endpoint: endpoint,
      provider_selected: readString(ask.agent_runtime),
      manifest_version: readString(ask.workstation_gateway_manifest_version),
      gateway_call_result_count: readRecordArray(ask.workstation_gateway_call_results).length,
      debug_gateway_call_result_count: readRecordArray(debugPayload?.workstation_gateway_call_results).length,
      debug_observation_packet_count: readRecordArray(debugPayload?.workstation_gateway_observation_packets).length,
      reentry_status: readString(ask.workstation_gateway_reentry_status),
      debug_reentry_status: readString(debugPayload?.workstation_gateway_reentry_status),
      terminal_authority_status: readString(ask.terminal_authority_status),
      debug_terminal_authority_status: readString(debugPayload?.terminal_authority_status),
      final_answer_source: readString(ask.final_answer_source),
      debug_final_answer_source: readString(debugPayload?.final_answer_source),
      provider_gateway_debug_summary: readRecord(ask.provider_gateway_debug_summary),
      debug_provider_gateway_debug_summary: readRecord(debugPayload?.provider_gateway_debug_summary),
      procedural_ok: routeFailures.length === 0,
      failures: routeFailures,
    },
  };
};

const runStreamRouteDebugExportProbe = async (input: {
  app: ReturnType<typeof createRouteTraceApp>;
  body: Record<string, unknown>;
  scenario: Scenario;
  providerId: "helix" | "codex" | "future";
}) => {
  const turnId = readString(input.body.turn_id) ?? "ask:provider-gateway-trace";
  const providerLabels = {
    helix: "Helix Native",
    codex: "Codex Workstation Mode",
    future: "Future provider wrapper",
  };
  const body = {
    ...input.body,
    agent_runtime: input.providerId,
    turn_id: `${turnId}:${input.providerId}:stream`,
    session_id: `${turnId}:${input.providerId}:stream-session`,
    sessionId: `${turnId}:${input.providerId}:stream-session`,
    question: `Use the provided Helix workstation gateway observation for ${input.scenario.id} through ${providerLabels[input.providerId]} stream.`,
  };
  const response = await request(input.app)
    .post("/api/agi/ask/turn/stream")
    .send(body);
  const streamEvents = parseSseEvents(response.text);
  const finalEvent = streamEvents.find((entry) => entry.event === "turn_final") ?? null;
  const finalPayload = readRecord(finalEvent?.data) ?? {};
  const endpoint = readDebugExportEndpoint(finalPayload);
  const debugResponse = endpoint
    ? await request(input.app).get(endpoint)
    : null;
  const debugExport = readRecord(debugResponse?.body) ?? null;
  const debugPayload = readRecord(debugExport?.payload);
  const routeFailures: string[] = [];
  const expectedReentryStatus = input.providerId === "codex"
    ? expectedCodexReentryStatusForScenario(input.scenario)
    : "pending_helix_solver_reentry";
  const expectedTerminalAuthorityStatus = input.providerId === "codex"
    ? input.scenario.expectedOk
      ? "authorized_by_helix_provider_candidate_bridge"
      : "blocked_by_gateway_observation_state"
    : "not_authorized_observation_only";
  const expectedFinalAnswerSource = input.providerId === "codex" && input.scenario.expectedOk
    ? "agent_provider_terminal_candidate"
    : null;

  if (response.status !== 200) routeFailures.push(`${input.providerId}_stream_status:${response.status}`);
  if (!finalEvent) routeFailures.push(`${input.providerId}_stream_final_event_missing`);
  if (!endpoint) routeFailures.push(`${input.providerId}_stream_debug_export_ref_missing`);
  if (endpoint && debugResponse?.status !== 200) {
    routeFailures.push(`${input.providerId}_stream_debug_export_status:${debugResponse?.status ?? "missing"}`);
  }
  if (readString(finalPayload.agent_runtime) !== input.providerId) {
    routeFailures.push(
      `${input.providerId}_stream_agent_runtime:${readString(finalPayload.agent_runtime) ?? "missing"}!=${input.providerId}`,
    );
  }
  if (readString(finalPayload.workstation_gateway_manifest_version) !== "read-observe-act.v1") {
    routeFailures.push(`${input.providerId}_stream_manifest_version_missing`);
  }
  const expectedCallResultCount = expectedCallResultCountForScenario(input.scenario, input.providerId);
  const expectedObservationPacketCount = expectedObservationPacketCountForScenario(input.scenario, input.providerId);
  if (readRecordArray(finalPayload.workstation_gateway_call_results).length !== expectedCallResultCount) {
    routeFailures.push(
      `${input.providerId}_stream_gateway_call_result_count:${readRecordArray(finalPayload.workstation_gateway_call_results).length}`,
    );
  }
  if (readRecordArray(finalPayload.workstation_gateway_observation_packets).length !== expectedObservationPacketCount) {
    routeFailures.push(
      `${input.providerId}_stream_observation_packet_count:${readRecordArray(finalPayload.workstation_gateway_observation_packets).length}`,
    );
  }
  if (readString(finalPayload.workstation_gateway_reentry_status) !== expectedReentryStatus) {
    routeFailures.push(
      `${input.providerId}_stream_reentry_status:${readString(finalPayload.workstation_gateway_reentry_status) ?? "missing"}!=${expectedReentryStatus}`,
    );
  }
  if (readString(finalPayload.terminal_authority_status) !== expectedTerminalAuthorityStatus) {
    routeFailures.push(
      `${input.providerId}_stream_terminal_authority_status:${readString(finalPayload.terminal_authority_status) ?? "missing"}!=${expectedTerminalAuthorityStatus}`,
    );
  }
  if (readString(finalPayload.final_answer_source) !== expectedFinalAnswerSource) {
    routeFailures.push(
      `${input.providerId}_stream_final_answer_source:${readString(finalPayload.final_answer_source) ?? "missing"}!=${expectedFinalAnswerSource ?? "null"}`,
    );
  }
  if (debugPayload) {
    if (readString(debugPayload.agent_runtime) !== input.providerId) {
      routeFailures.push(
        `${input.providerId}_stream_debug_agent_runtime:${readString(debugPayload.agent_runtime) ?? "missing"}!=${input.providerId}`,
      );
    }
    if (readString(debugPayload.workstation_gateway_manifest_version) !== "read-observe-act.v1") {
      routeFailures.push(`${input.providerId}_stream_debug_manifest_version_missing`);
    }
    if (readRecordArray(debugPayload.workstation_gateway_call_results).length !== expectedCallResultCount) {
      routeFailures.push(
        `${input.providerId}_stream_debug_gateway_call_result_count:${readRecordArray(debugPayload.workstation_gateway_call_results).length}`,
      );
    }
    if (readRecordArray(debugPayload.workstation_gateway_observation_packets).length !== expectedObservationPacketCount) {
      routeFailures.push(
        `${input.providerId}_stream_debug_observation_packet_count:${readRecordArray(debugPayload.workstation_gateway_observation_packets).length}`,
      );
    }
    if (readString(debugPayload.workstation_gateway_reentry_status) !== expectedReentryStatus) {
      routeFailures.push(
        `${input.providerId}_stream_debug_reentry_status:${readString(debugPayload.workstation_gateway_reentry_status) ?? "missing"}!=${expectedReentryStatus}`,
      );
    }
    if (readString(debugPayload.terminal_authority_status) !== expectedTerminalAuthorityStatus) {
      routeFailures.push(
        `${input.providerId}_stream_debug_terminal_authority_status:${readString(debugPayload.terminal_authority_status) ?? "missing"}!=${expectedTerminalAuthorityStatus}`,
      );
    }
    if (readString(debugPayload.final_answer_source) !== expectedFinalAnswerSource) {
      routeFailures.push(
        `${input.providerId}_stream_debug_final_answer_source:${readString(debugPayload.final_answer_source) ?? "missing"}!=${expectedFinalAnswerSource ?? "null"}`,
      );
    }
  }

  addProviderGatewaySummaryFailures({
    failures: routeFailures,
    prefix: `${input.providerId}_stream`,
    source: finalPayload,
    expectedProvider: input.providerId,
    expectedCapabilityId: input.scenario.capabilityId,
    expectedOk: input.scenario.expectedOk,
    expectedReentryStatus,
    expectedTerminalAuthorityStatus,
    expectedFinalAnswerSource,
  });
  addProviderGatewaySummaryFailures({
    failures: routeFailures,
    prefix: `${input.providerId}_stream_debug`,
    source: debugPayload,
    expectedProvider: input.providerId,
    expectedCapabilityId: input.scenario.capabilityId,
    expectedOk: input.scenario.expectedOk,
    expectedReentryStatus,
    expectedTerminalAuthorityStatus,
    expectedFinalAnswerSource,
  });

  return {
    streamEvents,
    finalPayload,
    debugExport,
    summary: {
      schema: "helix.provider_gateway_stream_route_debug_export_probe.v1",
      provider_id: input.providerId,
      response_status: response.status,
      event_count: streamEvents.length,
      final_event_present: Boolean(finalEvent),
      debug_export_status: debugResponse?.status ?? null,
      debug_export_endpoint: endpoint,
      provider_selected: readString(finalPayload.agent_runtime),
      manifest_version: readString(finalPayload.workstation_gateway_manifest_version),
      gateway_call_result_count: readRecordArray(finalPayload.workstation_gateway_call_results).length,
      observation_packet_count: readRecordArray(finalPayload.workstation_gateway_observation_packets).length,
      debug_gateway_call_result_count: readRecordArray(debugPayload?.workstation_gateway_call_results).length,
      debug_observation_packet_count: readRecordArray(debugPayload?.workstation_gateway_observation_packets).length,
      reentry_status: readString(finalPayload.workstation_gateway_reentry_status),
      debug_reentry_status: readString(debugPayload?.workstation_gateway_reentry_status),
      terminal_authority_status: readString(finalPayload.terminal_authority_status),
      debug_terminal_authority_status: readString(debugPayload?.terminal_authority_status),
      final_answer_source: readString(finalPayload.final_answer_source),
      debug_final_answer_source: readString(debugPayload?.final_answer_source),
      provider_gateway_debug_summary: readRecord(finalPayload.provider_gateway_debug_summary),
      debug_provider_gateway_debug_summary: readRecord(debugPayload?.provider_gateway_debug_summary),
      procedural_ok: routeFailures.length === 0,
      failures: routeFailures,
    },
  };
};

const addGatewayInvariantFailures = (input: {
  failures: string[];
  prefix: string;
  result: Record<string, unknown>;
  scenario: Scenario;
}) => {
  const { failures, prefix, result, scenario } = input;
  const observation = readRecord(result.observation);
  const observationPacket = readRecord(result.observation_packet);
  const lifecycleTrace = readRecord(result.tool_lifecycle_trace);
  const followupDecision = readRecord(result.tool_followup_decision);

  if (result.ok !== scenario.expectedOk) {
    failures.push(`${prefix}_gateway_ok:${String(result.ok)}!=${String(scenario.expectedOk)}`);
  }
  if (scenario.expectedError && readString(result.error) !== scenario.expectedError) {
    failures.push(`${prefix}_gateway_error:${readString(result.error) ?? "missing"}!=${scenario.expectedError}`);
  }
  if (scenario.expectedObservationSchema && readString(observation?.schema) !== scenario.expectedObservationSchema) {
    failures.push(`${prefix}_observation_schema:${readString(observation?.schema) ?? "missing"}!=${scenario.expectedObservationSchema}`);
  }
  for (const [label, record] of [
    ["observation_packet", observationPacket],
    ["tool_lifecycle_trace", lifecycleTrace],
    ["tool_followup_decision", followupDecision],
  ] as const) {
    if (!record) {
      failures.push(`${prefix}_${label}_missing`);
      continue;
    }
    if (record.assistant_answer !== false) failures.push(`${prefix}_${label}_assistant_answer_not_false`);
    if (record.raw_content_included !== false) failures.push(`${prefix}_${label}_raw_content_included_not_false`);
  }
  if (observationPacket?.terminal_eligible !== false) failures.push(`${prefix}_observation_packet_terminal_eligible_not_false`);
  if (observationPacket?.post_tool_model_step_required !== true) failures.push(`${prefix}_observation_packet_missing_post_tool_step`);
  if (lifecycleTrace?.terminal_eligible !== false) failures.push(`${prefix}_lifecycle_trace_terminal_eligible_not_false`);
  if (followupDecision?.evidence_reentered !== false) failures.push(`${prefix}_followup_evidence_reentered_not_false`);
};

const runScenario = async (scenario: Scenario, routeTraceApp: ReturnType<typeof createRouteTraceApp>) => {
  const turnId = `ask:provider-gateway-trace:${scenario.id}`;
  const seed = {
    schema: "helix.provider_gateway_trace_seed.v1",
    scenario_id: scenario.id,
    agent_runtime: "codex",
    spawn_codex: SPAWN_CODEX,
    turn_id: turnId,
    workstation_gateway_call: {
      capability_id: scenario.capabilityId,
      arguments: scenario.args,
      mode: scenario.mode ?? "read",
    },
    mode: scenario.mode ?? "read",
  };
  const body: Record<string, unknown> = {
    agent_runtime: "codex",
    turn_id: turnId,
    mode: scenario.mode ?? "read",
    question: `Use the provided Helix workstation gateway observation for ${scenario.id}.`,
    workstation_gateway_call: seed.workstation_gateway_call,
  };

  const helixGatewayResult = await callWorkstationGatewayCapability({
    agentRuntime: "helix",
    mode: scenario.mode ?? "read",
    capabilityId: scenario.capabilityId,
    arguments: scenario.args,
    turnId: `${turnId}:helix`,
    iteration: 1,
  });
  process.env.ENABLE_CODEX_AGENT = "1";
  const originalFakeStdout = process.env.CODEX_AGENT_FAKE_STDOUT;
  const originalFakeExitCode = process.env.CODEX_AGENT_FAKE_EXIT_CODE;
  if (!SPAWN_CODEX) {
    process.env.CODEX_AGENT_FAKE_STDOUT = scenario.expectedOk
      ? `Provider candidate for ${scenario.id} is grounded in the Helix gateway observation.`
      : `Provider candidate for ${scenario.id} reports that the requested workstation capability was blocked.`;
    process.env.CODEX_AGENT_FAKE_EXIT_CODE = "0";
  }
  let providerResult: Awaited<ReturnType<typeof codexProvider.runTurn>>;
  try {
    providerResult = await codexProvider.runTurn({
      runtime: "codex",
      route: "/ask/turn",
      body,
    });
  } finally {
    if (!SPAWN_CODEX) {
      if (originalFakeStdout === undefined) {
        delete process.env.CODEX_AGENT_FAKE_STDOUT;
      } else {
        process.env.CODEX_AGENT_FAKE_STDOUT = originalFakeStdout;
      }
      if (originalFakeExitCode === undefined) {
        delete process.env.CODEX_AGENT_FAKE_EXIT_CODE;
      } else {
        process.env.CODEX_AGENT_FAKE_EXIT_CODE = originalFakeExitCode;
      }
    }
  }
  if (!SPAWN_CODEX) {
    process.env.CODEX_AGENT_FAKE_STDOUT = scenario.expectedOk
      ? `Route provider candidate for ${scenario.id} is grounded in the Helix gateway observation.`
      : `Route provider candidate for ${scenario.id} reports that the requested workstation capability was blocked.`;
    process.env.CODEX_AGENT_FAKE_EXIT_CODE = "0";
  }
  let routeProbe: Awaited<ReturnType<typeof runRouteDebugExportProbe>>;
  try {
    routeProbe = await runRouteDebugExportProbe({
      app: routeTraceApp,
      body,
      scenario,
    });
  } finally {
    if (!SPAWN_CODEX) {
      if (originalFakeStdout === undefined) {
        delete process.env.CODEX_AGENT_FAKE_STDOUT;
      } else {
        process.env.CODEX_AGENT_FAKE_STDOUT = originalFakeStdout;
      }
      if (originalFakeExitCode === undefined) {
        delete process.env.CODEX_AGENT_FAKE_EXIT_CODE;
      } else {
        process.env.CODEX_AGENT_FAKE_EXIT_CODE = originalFakeExitCode;
      }
    }
  }
  const helixRouteProbe = await runHelixRouteDebugExportProbe({
    app: routeTraceApp,
    body,
    scenario,
  });
  const originalEnableFutureAgent = process.env.ENABLE_FUTURE_AGENT;
  process.env.ENABLE_FUTURE_AGENT = "1";
  let futureRouteProbe: Awaited<ReturnType<typeof runFutureRouteDebugExportProbe>>;
  try {
    futureRouteProbe = await runFutureRouteDebugExportProbe({
      app: routeTraceApp,
      body,
      scenario,
    });
  } finally {
    if (originalEnableFutureAgent === undefined) {
      delete process.env.ENABLE_FUTURE_AGENT;
    } else {
      process.env.ENABLE_FUTURE_AGENT = originalEnableFutureAgent;
    }
  }
  const helixStreamRouteProbe = await runStreamRouteDebugExportProbe({
    app: routeTraceApp,
    body,
    scenario,
    providerId: "helix",
  });
  if (!SPAWN_CODEX) {
    process.env.CODEX_AGENT_FAKE_STDOUT = scenario.expectedOk
      ? `Stream route provider candidate for ${scenario.id} is grounded in the Helix gateway observation.`
      : `Stream route provider candidate for ${scenario.id} reports that the requested workstation capability was blocked.`;
    process.env.CODEX_AGENT_FAKE_EXIT_CODE = "0";
  }
  let codexStreamRouteProbe: Awaited<ReturnType<typeof runStreamRouteDebugExportProbe>>;
  try {
    codexStreamRouteProbe = await runStreamRouteDebugExportProbe({
      app: routeTraceApp,
      body,
      scenario,
      providerId: "codex",
    });
  } finally {
    if (!SPAWN_CODEX) {
      if (originalFakeStdout === undefined) {
        delete process.env.CODEX_AGENT_FAKE_STDOUT;
      } else {
        process.env.CODEX_AGENT_FAKE_STDOUT = originalFakeStdout;
      }
      if (originalFakeExitCode === undefined) {
        delete process.env.CODEX_AGENT_FAKE_EXIT_CODE;
      } else {
        process.env.CODEX_AGENT_FAKE_EXIT_CODE = originalFakeExitCode;
      }
    }
  }
  process.env.ENABLE_FUTURE_AGENT = "1";
  let futureStreamRouteProbe: Awaited<ReturnType<typeof runStreamRouteDebugExportProbe>>;
  try {
    futureStreamRouteProbe = await runStreamRouteDebugExportProbe({
      app: routeTraceApp,
      body,
      scenario,
      providerId: "future",
    });
  } finally {
    if (originalEnableFutureAgent === undefined) {
      delete process.env.ENABLE_FUTURE_AGENT;
    } else {
      process.env.ENABLE_FUTURE_AGENT = originalEnableFutureAgent;
    }
  }
  const providerDebug = readRecord(providerResult.debug) ?? {};
  const ask = {
    ...providerResult,
    agent_runtime: "codex",
    agent_runtime_selection_trace: providerDebug.agent_runtime_selection_trace,
    selected_agent_provider: {
      id: "codex",
      label: codexProvider.label,
      permission_profile: codexProvider.permissionProfile,
      supports: codexProvider.supports,
    },
    workstation_gateway_manifest: providerDebug.workstation_gateway_manifest,
    workstation_gateway_manifest_version: providerDebug.workstation_gateway_manifest_version,
    workstation_gateway_capability_ids: providerDebug.workstation_gateway_capability_ids,
    workstation_gateway_call_results: providerDebug.workstation_gateway_call_results,
    workstation_gateway_observation_packets: providerDebug.workstation_gateway_observation_packets,
    tool_lifecycle_traces: providerDebug.tool_lifecycle_traces,
    tool_followup_decisions: providerDebug.tool_followup_decisions,
    provider_terminal_candidate: providerDebug.provider_terminal_candidate,
    provider_reasoning_reentry: providerDebug.provider_reasoning_reentry,
    terminal_authority_candidate_review: providerDebug.terminal_authority_candidate_review,
    workstation_gateway_reentry_status: providerDebug.workstation_gateway_reentry_status,
    terminal_authority_status: providerDebug.terminal_authority_status,
  };
  const debugExport = readRecord(ask.debug) ?? {};
  const callResults = readRecordArray(ask.workstation_gateway_call_results);
  const firstResult = callResults[0] ?? {};
  const codexSummary = buildGatewayCallSummary(firstResult);
  const helixSummary = buildGatewayCallSummary(helixGatewayResult as unknown as Record<string, unknown>);
  const manifestSummary = buildManifestCapabilitySummary(
    readRecord(ask.workstation_gateway_manifest),
    codexSummary.capability_id,
  );
  const candidateSummary = buildProviderCandidateSummary(ask);
  const failures: string[] = [];

  if (readString(ask.agent_runtime) !== "codex") failures.push("agent_runtime_not_codex");
  if (readString(readRecord(ask.agent_runtime_selection_trace)?.selected_runtime) !== "codex") {
    failures.push("provider_selection_trace_missing_codex");
  }
  if (readString(ask.workstation_gateway_manifest_version) !== "read-observe-act.v1") {
    failures.push("manifest_version_missing");
  }
  if (scenario.expectedOk && manifestSummary.capability_id !== scenario.capabilityId) {
    failures.push(`manifest_capability_missing:${scenario.capabilityId}`);
  }
  if (manifestSummary.capability_id) {
    if (!["read", "observe", "act"].includes(manifestSummary.mode ?? "")) {
      failures.push(`manifest_capability_mode:${manifestSummary.mode ?? "missing"}`);
    }
    if (manifestSummary.output_observation_schema !== manifestSummary.observation_schema) {
      failures.push(
        `manifest_output_observation_schema_mismatch:${manifestSummary.output_observation_schema ?? "missing"}!=${manifestSummary.observation_schema ?? "missing"}`,
      );
    }
    for (const [field, expected] of [
      ["mutating", false],
      ["code_mutation", false],
      ["shell_access", false],
      ["terminal_eligible", false],
      ["post_tool_model_step_required", true],
      ["assistant_answer", false],
      ["raw_content_included", false],
    ] as const) {
      if (manifestSummary[field] !== expected) failures.push(`manifest_${field}_not_${String(expected)}`);
    }
  }
  const expectedCallResultCount = expectedCallResultCountForScenario(scenario);
  if (callResults.length !== expectedCallResultCount) failures.push(`gateway_call_result_count:${callResults.length}`);
  if (!candidateSummary.candidate_present) failures.push("provider_terminal_candidate_missing");
  if (candidateSummary.candidate_terminal_eligible !== false) failures.push("provider_terminal_candidate_terminal_eligible_not_false");
  if (candidateSummary.candidate_assistant_answer !== false) failures.push("provider_terminal_candidate_assistant_answer_not_false");
  if (candidateSummary.candidate_raw_content_included !== false) failures.push("provider_terminal_candidate_raw_content_included_not_false");
  const expectedProviderReentryStatus = expectedCodexReentryStatusForScenario(scenario);
  if (candidateSummary.reentry_status !== expectedProviderReentryStatus) {
    failures.push(`provider_reentry_status:${candidateSummary.reentry_status ?? "missing"}`);
  }
  const expectedAuthorityStatus = scenario.expectedOk
    ? "authorized_by_helix_provider_candidate_bridge"
    : "blocked_by_gateway_observation_state";
  if (candidateSummary.terminal_authority_status !== expectedAuthorityStatus) {
    failures.push(`terminal_authority_status:${candidateSummary.terminal_authority_status ?? "missing"}!=${expectedAuthorityStatus}`);
  }
  if (candidateSummary.terminal_authority_granted !== scenario.expectedOk) {
    failures.push(`terminal_authority_granted:${String(candidateSummary.terminal_authority_granted)}!=${String(scenario.expectedOk)}`);
  }
  if (candidateSummary.final_visible_answer_authorized !== scenario.expectedOk) {
    failures.push(`final_visible_answer_authorized:${String(candidateSummary.final_visible_answer_authorized)}!=${String(scenario.expectedOk)}`);
  }
  for (const routeFailure of routeProbe.summary.failures) {
    failures.push(`route_debug_export_${routeFailure}`);
  }
  for (const helixRouteFailure of helixRouteProbe.summary.failures) {
    failures.push(`helix_route_debug_export_${helixRouteFailure}`);
  }
  for (const futureRouteFailure of futureRouteProbe.summary.failures) {
    failures.push(`future_route_debug_export_${futureRouteFailure}`);
  }
  for (const helixStreamRouteFailure of helixStreamRouteProbe.summary.failures) {
    failures.push(`helix_stream_route_debug_export_${helixStreamRouteFailure}`);
  }
  for (const codexStreamRouteFailure of codexStreamRouteProbe.summary.failures) {
    failures.push(`codex_stream_route_debug_export_${codexStreamRouteFailure}`);
  }
  for (const futureStreamRouteFailure of futureStreamRouteProbe.summary.failures) {
    failures.push(`future_stream_route_debug_export_${futureStreamRouteFailure}`);
  }
  addGatewayInvariantFailures({ failures, prefix: "codex", result: firstResult, scenario });
  addGatewayInvariantFailures({
    failures,
    prefix: "helix",
    result: helixGatewayResult as unknown as Record<string, unknown>,
    scenario,
  });
  const helixRouteCallResults = readRecordArray(helixRouteProbe.ask.workstation_gateway_call_results);
  const helixRouteFirstResult = helixRouteCallResults[0] ?? {};
  const helixRouteSummary = buildGatewayCallSummary(helixRouteFirstResult);
  addGatewayInvariantFailures({
    failures,
    prefix: "helix_route",
    result: helixRouteFirstResult,
    scenario,
  });
  for (const field of [
    "capability_id",
    "ok",
    "error",
    "observation_schema",
    "observation_packet_terminal_eligible",
    "observation_packet_post_tool_step",
    "observation_packet_assistant_answer",
    "observation_packet_raw_content_included",
    "lifecycle_terminal_eligible",
    "lifecycle_assistant_answer",
    "lifecycle_raw_content_included",
    "followup_evidence_reentered",
    "followup_assistant_answer",
    "followup_raw_content_included",
  ] as const) {
    if (JSON.stringify(codexSummary[field]) !== JSON.stringify(helixSummary[field])) {
      failures.push(`provider_parity_${field}:${String(codexSummary[field])}!=${String(helixSummary[field])}`);
    }
    if (JSON.stringify(codexSummary[field]) !== JSON.stringify(helixRouteSummary[field])) {
      failures.push(`provider_route_parity_${field}:${String(codexSummary[field])}!=${String(helixRouteSummary[field])}`);
    }
  }

  const probeResult = {
    schema: "helix.provider_gateway_trace_probe_result.v1",
    scenario_id: scenario.id,
    turn_id: turnId,
    response_status: 200,
    provider_selected: readString(ask.agent_runtime),
    manifest_version: readString(ask.workstation_gateway_manifest_version),
    manifest_capability: manifestSummary,
    capability_id: codexSummary.capability_id,
    gateway_ok: codexSummary.ok,
    gateway_error: codexSummary.error,
    observation_schema: codexSummary.observation_schema,
    observation_packet_status: codexSummary.observation_packet_status,
    lifecycle_status: codexSummary.lifecycle_status,
    followup_next_action: codexSummary.followup_next_action,
    provider_terminal_candidate: candidateSummary,
    route_debug_export: routeProbe.summary,
    helix_route_debug_export: helixRouteProbe.summary,
    future_route_debug_export: futureRouteProbe.summary,
    helix_stream_route_debug_export: helixStreamRouteProbe.summary,
    codex_stream_route_debug_export: codexStreamRouteProbe.summary,
    future_stream_route_debug_export: futureStreamRouteProbe.summary,
    provider_parity: {
      helix: helixSummary,
      helix_route: helixRouteSummary,
      codex: codexSummary,
    },
    procedural_ok: failures.length === 0,
    failures,
  };

  const scenarioDir = path.join(OUT_DIR, scenario.id);
  await writeJson(path.join(scenarioDir, "seed.json"), seed);
  await writeJson(path.join(scenarioDir, "ask-response.json"), ask);
  await writeJson(path.join(scenarioDir, "debug-export.json"), debugExport);
  await writeJson(path.join(scenarioDir, "route-ask-response.json"), routeProbe.ask);
  await writeJson(path.join(scenarioDir, "route-debug-export.json"), routeProbe.debugExport);
  await writeJson(path.join(scenarioDir, "route-debug-export-probe.json"), routeProbe.summary);
  await writeJson(path.join(scenarioDir, "helix-route-ask-response.json"), helixRouteProbe.ask);
  await writeJson(path.join(scenarioDir, "helix-route-debug-export.json"), helixRouteProbe.debugExport);
  await writeJson(path.join(scenarioDir, "helix-route-debug-export-probe.json"), helixRouteProbe.summary);
  await writeJson(path.join(scenarioDir, "future-route-ask-response.json"), futureRouteProbe.ask);
  await writeJson(path.join(scenarioDir, "future-route-debug-export.json"), futureRouteProbe.debugExport);
  await writeJson(path.join(scenarioDir, "future-route-debug-export-probe.json"), futureRouteProbe.summary);
  await writeJson(path.join(scenarioDir, "helix-stream-route-events.json"), helixStreamRouteProbe.streamEvents);
  await writeJson(path.join(scenarioDir, "helix-stream-route-final-event.json"), helixStreamRouteProbe.finalPayload);
  await writeJson(path.join(scenarioDir, "helix-stream-route-debug-export.json"), helixStreamRouteProbe.debugExport);
  await writeJson(path.join(scenarioDir, "helix-stream-route-debug-export-probe.json"), helixStreamRouteProbe.summary);
  await writeJson(path.join(scenarioDir, "codex-stream-route-events.json"), codexStreamRouteProbe.streamEvents);
  await writeJson(path.join(scenarioDir, "codex-stream-route-final-event.json"), codexStreamRouteProbe.finalPayload);
  await writeJson(path.join(scenarioDir, "codex-stream-route-debug-export.json"), codexStreamRouteProbe.debugExport);
  await writeJson(path.join(scenarioDir, "codex-stream-route-debug-export-probe.json"), codexStreamRouteProbe.summary);
  await writeJson(path.join(scenarioDir, "future-stream-route-events.json"), futureStreamRouteProbe.streamEvents);
  await writeJson(path.join(scenarioDir, "future-stream-route-final-event.json"), futureStreamRouteProbe.finalPayload);
  await writeJson(path.join(scenarioDir, "future-stream-route-debug-export.json"), futureStreamRouteProbe.debugExport);
  await writeJson(path.join(scenarioDir, "future-stream-route-debug-export-probe.json"), futureStreamRouteProbe.summary);
  await writeJson(path.join(scenarioDir, "helix-gateway-result.json"), helixGatewayResult);
  await writeJson(path.join(scenarioDir, "codex-gateway-result.json"), firstResult);
  await writeJson(path.join(scenarioDir, "probe-result.json"), probeResult);
  return probeResult;
};

const runLiveScenario = async (scenario: Scenario) => {
  const turnId = `ask:provider-gateway-trace:${scenario.id}:live`;
  const seed = {
    schema: "helix.provider_gateway_trace_seed.v1",
    scenario_id: scenario.id,
    agent_runtime: "codex",
    mode: "live",
    base_url: BASE_URL,
    spawn_codex: SPAWN_CODEX,
    turn_id: turnId,
    workstation_gateway_call: {
      capability_id: scenario.capabilityId,
      arguments: scenario.args,
      mode: scenario.mode ?? "read",
    },
    mode: scenario.mode ?? "read",
  };
  const body: Record<string, unknown> = {
    agent_runtime: "codex",
    turn_id: turnId,
    mode: scenario.mode ?? "read",
    question: `Use the provided Helix workstation gateway observation for ${scenario.id}.`,
    workstation_gateway_call: seed.workstation_gateway_call,
  };
  const askResponse = await fetchJson(`${BASE_URL}/api/agi/ask/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const ask = readRecord(askResponse.json) ?? {};
  const debugExportEndpoint = readDebugExportEndpoint(ask);
  const debugExport = debugExportEndpoint
    ? await fetchJson(`${BASE_URL}${debugExportEndpoint}`)
    : { ok: false, status: 0, json: null, error: "debug_export_ref_missing" };
  const debugPayload = readRecord(readRecord(debugExport.json)?.payload);
  const callResults = readRecordArray(ask.workstation_gateway_call_results);
  const firstResult = callResults[0] ?? {};
  const codexSummary = buildGatewayCallSummary(firstResult);
  const failures: string[] = [];
  if (!askResponse.ok) failures.push(`http_status:${askResponse.status || "fetch_failed"}`);
  if (askResponse.error) failures.push(`fetch_error:${askResponse.error}`);
  if (readString(ask.agent_runtime) !== "codex") failures.push(`agent_runtime:${readString(ask.agent_runtime) ?? "missing"}!=codex`);
  if (readString(readRecord(ask.agent_runtime_selection_trace)?.selected_runtime) !== "codex") {
    failures.push("provider_selection_trace_missing_codex");
  }
  if (readString(ask.workstation_gateway_manifest_version) !== "read-observe-act.v1") {
    failures.push("manifest_version_missing");
  }
  const expectedCallResultCount = expectedCallResultCountForScenario(scenario);
  const expectedObservationPacketCount = expectedObservationPacketCountForScenario(scenario);
  if (callResults.length !== expectedCallResultCount) failures.push(`gateway_call_result_count:${callResults.length}`);
  addGatewayInvariantFailures({ failures, prefix: "codex", result: firstResult, scenario });
  if (!debugExport.ok) failures.push(`debug_export_unavailable:${debugExport.status || debugExport.error || "missing"}`);
  if (debugExport.ok) {
    if (readString(debugPayload?.agent_runtime) !== "codex") {
      failures.push(`debug_agent_runtime:${readString(debugPayload?.agent_runtime) ?? "missing"}!=codex`);
    }
    if (readRecordArray(debugPayload?.workstation_gateway_call_results).length !== expectedCallResultCount) {
      failures.push(`debug_gateway_call_result_count:${readRecordArray(debugPayload?.workstation_gateway_call_results).length}`);
    }
    if (readRecordArray(debugPayload?.workstation_gateway_observation_packets).length !== expectedObservationPacketCount) {
      failures.push(`debug_observation_packet_count:${readRecordArray(debugPayload?.workstation_gateway_observation_packets).length}`);
    }
  }

  const probeResult = {
    schema: "helix.provider_gateway_trace_probe_result.v1",
    scenario_id: scenario.id,
    turn_id: turnId,
    mode: "live",
    response_status: askResponse.status,
    provider_selected: readString(ask.agent_runtime),
    manifest_version: readString(ask.workstation_gateway_manifest_version),
    capability_id: codexSummary.capability_id,
    gateway_ok: codexSummary.ok,
    gateway_error: codexSummary.error,
    observation_schema: codexSummary.observation_schema,
    observation_packet_status: codexSummary.observation_packet_status,
    lifecycle_status: codexSummary.lifecycle_status,
    followup_next_action: codexSummary.followup_next_action,
    debug_export_available: debugExport.ok,
    debug_export_endpoint: debugExportEndpoint,
    debug_gateway_call_result_count: readRecordArray(debugPayload?.workstation_gateway_call_results).length,
    debug_observation_packet_count: readRecordArray(debugPayload?.workstation_gateway_observation_packets).length,
    procedural_ok: failures.length === 0,
    failures,
  };
  const scenarioDir = path.join(OUT_DIR, scenario.id);
  await writeJson(path.join(scenarioDir, "seed.json"), seed);
  await writeJson(path.join(scenarioDir, "ask-response.json"), ask);
  await writeJson(path.join(scenarioDir, "debug-export.json"), debugExport.json);
  await writeJson(path.join(scenarioDir, "codex-gateway-result.json"), firstResult);
  await writeJson(path.join(scenarioDir, "probe-result.json"), probeResult);
  return probeResult;
};

const main = async () => {
  const originalEnableCodexAgent = process.env.ENABLE_CODEX_AGENT;
  const originalEnableFutureAgent = process.env.ENABLE_FUTURE_AGENT;
  const originalActiveUserTurnBurstLimit = process.env.RUNTIME_TASK_ACTIVE_USER_TURN_BURST_LIMIT;
  try {
    if (!LIVE_MODE) {
      process.env.RUNTIME_TASK_ACTIVE_USER_TURN_BURST_LIMIT =
        process.env.RUNTIME_TASK_ACTIVE_USER_TURN_BURST_LIMIT ?? "200";
    }
    if (LIVE_MODE) {
      if (!BASE_URL) {
        await writeBlockedLiveSummary("helix_ask_base_url_missing");
        return;
      }
      const preflight = await fetchJson(`${BASE_URL}/api/agi/agent-providers`);
      await writeJson(path.join(OUT_DIR, "preflight.json"), {
        schema: "helix.provider_gateway_trace_live_preflight.v1",
        base_url: BASE_URL,
        ok: preflight.ok,
        status: preflight.status,
        error: preflight.error,
        response: preflight.json,
      });
      if (!preflight.ok) {
        await writeBlockedLiveSummary("operator_keyed_server_unavailable", {
          preflight_status: preflight.status,
          preflight_error: preflight.error,
        });
        return;
      }
      const results = [];
      for (const scenario of scenarios) {
        results.push(await runLiveScenario(scenario));
      }
      const summary = {
        schema: "helix.provider_gateway_trace_summary.v1",
        output_dir: OUT_DIR,
        mode: "live",
        status: "completed",
        base_url: BASE_URL,
        spawn_codex: SPAWN_CODEX,
        scenario_count: results.length,
        passed_count: results.filter((result) => result.procedural_ok).length,
        failed_count: results.filter((result) => !result.procedural_ok).length,
        scenarios: results,
      };
      await writeJson(path.join(OUT_DIR, "summary.json"), summary);
      if (summary.failed_count > 0) process.exitCode = 1;
      return;
    }
    const results = [];
    const routeTraceApp = createRouteTraceApp();
    for (const scenario of scenarios) {
      results.push(await runScenario(scenario, routeTraceApp));
    }
    const summary = {
      schema: "helix.provider_gateway_trace_summary.v1",
      output_dir: OUT_DIR,
      spawn_codex: SPAWN_CODEX,
      scenario_count: results.length,
      passed_count: results.filter((result) => result.procedural_ok).length,
      failed_count: results.filter((result) => !result.procedural_ok).length,
      scenarios: results,
    };
    await writeJson(path.join(OUT_DIR, "summary.json"), summary);
    if (summary.failed_count > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (originalEnableCodexAgent === undefined) {
      delete process.env.ENABLE_CODEX_AGENT;
    } else {
      process.env.ENABLE_CODEX_AGENT = originalEnableCodexAgent;
    }
    if (originalEnableFutureAgent === undefined) {
      delete process.env.ENABLE_FUTURE_AGENT;
    } else {
      process.env.ENABLE_FUTURE_AGENT = originalEnableFutureAgent;
    }
    if (originalActiveUserTurnBurstLimit === undefined) {
      delete process.env.RUNTIME_TASK_ACTIVE_USER_TURN_BURST_LIMIT;
    } else {
      process.env.RUNTIME_TASK_ACTIVE_USER_TURN_BURST_LIMIT = originalActiveUserTurnBurstLimit;
    }
  }
};

main()
  .then(() => {
    if (process.env.HELIX_ASK_PROVIDER_GATEWAY_TRACE_NATURAL_EXIT !== "1") {
      process.exit(process.exitCode ?? 0);
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
