import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  environmentActionDifferentialCaptureInputSchema,
  type EnvironmentActionDifferentialCaptureInput,
} from "../server/services/environment-connectors/actions/workflow-differential-trace-capture";

type JsonRecord = Record<string, unknown>;

export interface HelixDebugCaptureOptions {
  debugExport: unknown;
  prompt: string;
  scenarioId?: string | null;
  requestedCapabilityId?: string | null;
  lane?: "helix" | "helix_ask";
  startingState?: unknown;
}

const argument = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
};

const record = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};

const records = (value: unknown): JsonRecord[] =>
  Array.isArray(value) ? value.map(record) : [];

const readString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const readStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? Array.from(new Set(value.map(readString).filter(Boolean)))
    : [];

const actionObservationFromCall = (call: JsonRecord): JsonRecord => {
  const direct = record(call.observation);
  if (readString(direct.schema) === "helix.environment_action.observation.v1") {
    return direct;
  }
  const delegated = record(record(call.delegated_gateway_call_result).observation);
  return readString(delegated.schema) === "helix.environment_action.observation.v1"
    ? delegated
    : {};
};

const normalizeTerminalProgress = (observation: JsonRecord): JsonRecord[] => {
  const outcome = readString(observation.outcome);
  const result = record(observation.result);
  const verified = record(result.verified_terminal_measurements);
  const measurements = { ...verified };
  if (
    measurements.duration_ticks === undefined &&
    typeof result.duration_ticks === "number" &&
    Number.isFinite(result.duration_ticks)
  ) {
    measurements.duration_ticks = result.duration_ticks;
  }
  const succeeded = outcome === "succeeded";
  return [
    {
      sequence: 0,
      event_type: "workflow.started",
      workflow_state: "running",
      progress_fraction: 0,
      measurements: {},
      manual_override_detected: false,
      controls_released: false,
    },
    {
      sequence: 1,
      event_type: succeeded ? "workflow.succeeded" : `workflow.${outcome || "failed"}`,
      workflow_state: succeeded ? "succeeded" : outcome || "failed",
      progress_fraction: succeeded ? 1 : 0,
      measurements,
      manual_override_detected: result.manual_override_detected === true,
      controls_released: result.controls_released === true,
    },
  ];
};

/**
 * Builds a public, observer-only differential capture from the server-redacted
 * exact-turn debug export. It uses explicit lifecycle paths and never performs
 * recursive "first familiar field" selection, which could confuse a catalog
 * default with an executed capability.
 */
export const buildHelixDebugCapture = ({
  debugExport,
  prompt,
  scenarioId,
  requestedCapabilityId,
  lane = "helix",
  startingState,
}: HelixDebugCaptureOptions): EnvironmentActionDifferentialCaptureInput => {
  const root = record(debugExport);
  const askCapture = record(root.ask_response);
  const debugPayload = record(record(root.debug_export).payload);
  const payload = Object.keys(askCapture).length > 0
    ? askCapture
    : Object.keys(record(root.payload)).length > 0
      ? record(root.payload)
      : Object.keys(debugPayload).length > 0
        ? debugPayload
        : root;
  const finalStatus = readString(payload.final_status) || readString(payload.status);
  const actionCalls = records(payload.capability_lane_call_results).filter(
    (call) => Object.keys(actionObservationFromCall(call)).length > 0,
  );
  const matchingActionCalls = requestedCapabilityId
    ? actionCalls.filter(
        (call) =>
          readString(actionObservationFromCall(call).capability_id) ===
          requestedCapabilityId,
      )
    : actionCalls;
  const actionCall = requestedCapabilityId
    ? finalStatus === "final_answer"
      ? [...matchingActionCalls]
          .reverse()
          .find(
            (call) =>
              readString(actionObservationFromCall(call).outcome) === "succeeded",
          ) ?? matchingActionCalls.at(-1)
      : matchingActionCalls.at(-1)
    : matchingActionCalls.length === 1
      ? matchingActionCalls[0]
      : undefined;
  if (!actionCall) {
    throw new Error(
      requestedCapabilityId
        ? `No exact environment action observation matched ${requestedCapabilityId}.`
        : `Expected exactly one environment action observation; found ${actionCalls.length}.`,
    );
  }

  const observation = actionObservationFromCall(actionCall);
  const capabilityId = readString(observation.capability_id);
  const actionKind = readString(observation.action_kind);
  const outcome = readString(observation.outcome);
  const result = record(observation.result);
  const lifecycle = record(actionCall.tool_lifecycle_trace);
  const gatewayAdmission = record(actionCall.gateway_admission);
  const reentry = record(payload.provider_reasoning_reentry);
  const candidate = record(payload.provider_terminal_candidate);
  const presentation = record(payload.terminal_presentation);
  const singleWriter = record(payload.terminal_authority_single_writer);
  const authority = record(payload.terminal_answer_authority);
  const turnId =
    readString(payload.active_turn_id) ||
    readString(payload.backend_turn_id) ||
    readString(reentry.turn_id);
  const finalText =
    readString(payload.selected_final_answer) ||
    readString(singleWriter.visible_text) ||
    readString(presentation.concise_text);
  const routeText = readString(presentation.concise_text) || finalText;
  const writerText = readString(singleWriter.visible_text) || routeText;
  const visibleText = readString(payload.selected_final_answer) || writerText;
  const observationRefs = readStrings(lifecycle.observation_refs);
  const candidateSupportRefs = readStrings(candidate.grounded_in_observation_refs);
  const routeSupportRefs = readStrings(presentation.support_refs);
  const writerSupportRefs = readStrings(singleWriter.selected_terminal_support_refs);
  const sourceArtifactRefs = [
    turnId ? `ask_turn_debug_export:${turnId}` : "ask_turn_debug_export:unknown",
    readString(observation.evidence_ref),
    readString(authority.terminal_artifact_ref),
  ].filter(Boolean);

  if (!capabilityId || !actionKind || !outcome) {
    throw new Error("The exact action observation is missing capability, action, or outcome identity.");
  }
  if (observationRefs.length === 0) {
    throw new Error("The exact action tool lifecycle has no observation reference.");
  }
  if (!finalText) {
    throw new Error("The exact turn has no selected terminal text.");
  }

  const authorized =
    readString(payload.terminal_authority_status).startsWith("authorized_") &&
    authority.terminal_eligible === true;
  const terminalOutcome = finalStatus === "final_answer" && authorized
    ? "success"
    : finalStatus.includes("blocked")
      ? "blocked"
      : "typed_failure";
  const requiredPostconditions = records(result.postconditions).filter(
    (condition) => condition.required === true,
  );
  const postconditionStatus = requiredPostconditions.length === 0
    ? outcome === "succeeded" ? "unknown" : "not_satisfied"
    : requiredPostconditions.every(
        (condition) => readString(condition.status) === "satisfied",
      )
      ? "satisfied"
      : "not_satisfied";

  return environmentActionDifferentialCaptureInputSchema.parse({
    scenario_id: scenarioId ?? `minecraft_player_helix:${actionKind}`,
    lane,
    action_kind: actionKind,
    prompt,
    starting_state: startingState ?? {
      fixture_kind: "bounded_player_action",
      required_preconditions: ["connected", "on_ground"],
    },
    capability_contract: {
      capability_id: capabilityId,
      capability_version: observation.capability_version,
      control_engine: readString(result.control_engine),
      manual_override_required: true,
      postcondition_verification_required: true,
    },
    source_artifact_refs: sourceArtifactRefs,
    selected_capability_id: capabilityId,
    normalized_arguments: actionCall.arguments ?? null,
    admission_status:
      readString(gatewayAdmission.admission_status) === "admitted"
        ? "admitted"
        : readString(gatewayAdmission.admission_status) === "rejected"
          ? "rejected"
          : "not_observed",
    execution_outcome: outcome,
    normalized_progress: normalizeTerminalProgress(observation),
    postcondition_status: postconditionStatus,
    observation_refs: observationRefs,
    observation_reentered:
      reentry.observation_reentered === true &&
      observationRefs.every((ref) =>
        readStrings(reentry.reentered_observation_refs).includes(ref),
      ),
    final_candidate_text: finalText,
    final_candidate_support_refs: candidateSupportRefs,
    route_product_text: routeText,
    route_product_support_refs: routeSupportRefs,
    terminal_outcome: terminalOutcome,
    terminal_authority_status: authorized
      ? "passed"
      : readString(payload.terminal_authority_status).includes("failed_closed")
        ? "failed_closed"
        : "failed",
    terminal_writer_text: writerText,
    terminal_writer_support_refs: writerSupportRefs,
    visible_text: visibleText,
    voice_projection_status: "not_observed",
    voice_text: null,
    created_at:
      readString(observation.observed_at) ||
      readString(authority.created_at) ||
      new Date().toISOString(),
    hidden_reasoning_included: false,
  });
};

export const runHelixDebugCaptureCli = async (): Promise<void> => {
  const inputPath = argument("--input");
  const inputUrl = argument("--url");
  const outputPath = argument("--out");
  const prompt = argument("--prompt");
  if ((!inputPath && !inputUrl) || (inputPath && inputUrl) || !outputPath || !prompt) {
    throw new Error(
      "Usage: (--input <redacted-debug.json> | --url <exact-turn-debug-export>) --prompt <semantic-request> --out <public-capture.json> [--capability <id>] [--scenario <id>]",
    );
  }
  const debugExport = inputPath
    ? JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"))
    : await fetch(inputUrl!).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Exact-turn debug export failed with HTTP ${response.status}.`);
        }
        return response.json();
      });
  const capture = buildHelixDebugCapture({
    debugExport,
    prompt,
    requestedCapabilityId: argument("--capability"),
    scenarioId: argument("--scenario"),
    lane: process.argv.includes("--g2") ? "helix_ask" : "helix",
    startingState: argument("--starting-state")
      ? JSON.parse(fs.readFileSync(path.resolve(argument("--starting-state")!), "utf8"))
      : undefined,
  });
  const resolvedOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
  process.stdout.write(
    `CAPTURED helix ${capture.action_kind} ${capture.execution_outcome} reentered=${capture.observation_reentered}\n`,
  );
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  void runHelixDebugCaptureCli();
}
