import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  HELIX_MINECRAFT_PLAYER_ACTION_KINDS,
  minecraftPlayerCapabilityForActionKind,
  type HelixMinecraftPlayerActionArguments,
} from "../shared/helix-minecraft-player-capabilities";
import { HELIX_MINECRAFT_PLAYER_EXECUTE_SEQUENCE_CAPABILITY } from "../shared/helix-minecraft-fluid-sequence";
import { HELIX_MINECRAFT_PLAYER_EXECUTE_REACTIVE_PROGRAM_CAPABILITY } from
  "../shared/helix-minecraft-reactive-program";
import {
  environmentActionDifferentialCaptureInputSchema,
  type EnvironmentActionDifferentialCaptureInput,
} from "../server/services/environment-connectors/actions/workflow-differential-trace-capture";

type JsonRecord = Record<string, unknown>;

export const HELIX_PLAYER_DIRECT_DIAGNOSTIC_MARKER =
  "HELIX_PLAYER_DIRECT_DIAGNOSTIC ";

export interface DirectDiagnosticCaptureOptions {
  logText: string;
  prompt: string;
  requestedWorkflowId?: string | null;
  scenarioId?: string | null;
  comparisonMode?: boolean;
  comparisonStartingState?: unknown;
}

const argument = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
};

const readString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const capabilityIdForActionKind = (actionKind: string): string | null =>
  actionKind === "execute_reactive_program"
    ? HELIX_MINECRAFT_PLAYER_EXECUTE_REACTIVE_PROGRAM_CAPABILITY
    : actionKind === "execute_sequence"
    ? HELIX_MINECRAFT_PLAYER_EXECUTE_SEQUENCE_CAPABILITY
    : (HELIX_MINECRAFT_PLAYER_ACTION_KINDS as readonly string[]).includes(actionKind)
    ? minecraftPlayerCapabilityForActionKind(
        actionKind as HelixMinecraftPlayerActionArguments["action_kind"],
      )
    : null;

export const parseDirectDiagnosticRecords = (logText: string): JsonRecord[] =>
  logText.split(/\r?\n/u).flatMap((line): JsonRecord[] => {
    const markerIndex = line.indexOf(HELIX_PLAYER_DIRECT_DIAGNOSTIC_MARKER);
    if (markerIndex < 0) return [];
    try {
      const parsed: unknown = JSON.parse(
        line.slice(markerIndex + HELIX_PLAYER_DIRECT_DIAGNOSTIC_MARKER.length),
      );
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? [parsed as JsonRecord]
        : [];
    } catch {
      return [];
    }
  });

export const buildDirectDiagnosticCapture = ({
  logText,
  prompt,
  requestedWorkflowId,
  scenarioId,
  comparisonMode = false,
  comparisonStartingState,
}: DirectDiagnosticCaptureOptions): EnvironmentActionDifferentialCaptureInput => {
  const records = parseDirectDiagnosticRecords(logText);
  const requests = records.filter(
    (record) =>
      readString(record.schema) ===
      "helix.minecraft.player.direct_diagnostic_request.v1",
  );
  const request = [...requests]
    .reverse()
    .find(
      (candidate) =>
        !requestedWorkflowId ||
        readString(candidate.workflow_id) === requestedWorkflowId,
    );
  if (!request) {
    throw new Error("No matching direct diagnostic request was found in the log.");
  }

  const workflowId = readString(request.workflow_id);
  const actionKind = readString(request.action_kind);
  const events = records.filter(
    (record) =>
      readString(record.schema) ===
        "helix.minecraft.player.direct_diagnostic_event.v1" &&
      readString(record.workflow_id) === workflowId,
  );
  const terminalStates = new Set([
    "canceled",
    "succeeded",
    "failed",
    "timed_out",
    "emergency_stopped",
    "connector_offline",
  ]);
  const terminal = [...events]
    .reverse()
    .find((event) => terminalStates.has(readString(event.workflow_state)));
  if (!terminal) {
    throw new Error(
      `Direct diagnostic ${workflowId} has no terminal workflow event.`,
    );
  }

  const manualOverride = terminal.manual_override_detected === true;
  const executionOutcome = (() => {
    switch (readString(terminal.workflow_state)) {
      case "succeeded":
        return "succeeded" as const;
      case "canceled":
        return manualOverride
          ? ("manual_override" as const)
          : ("request_canceled" as const);
      case "timed_out":
        return "workflow_timeout" as const;
      case "emergency_stopped":
        return "emergency_stopped" as const;
      case "connector_offline":
        return "connector_offline" as const;
      default:
        return "failed" as const;
    }
  })();

  const capabilityId = capabilityIdForActionKind(actionKind);
  const controlEngine = readString(request.control_engine) || "native_fabric";
  const requestArguments = request.arguments &&
      typeof request.arguments === "object" &&
      !Array.isArray(request.arguments)
    ? request.arguments as JsonRecord
    : null;
  const normalizedArguments = requestArguments
    ? Object.fromEntries(
        Object.entries(requestArguments).filter(([key]) => key !== "action_kind"),
      )
    : null;

  const logHash = crypto
    .createHash("sha256")
    .update(logText, "utf8")
    .digest("hex");
  const terminalSequence =
    typeof terminal.sequence === "number" && Number.isFinite(terminal.sequence)
      ? terminal.sequence
      : events.indexOf(terminal);
  const terminalObservationRef =
    `direct_diagnostic_observation:${workflowId}:${terminalSequence}`;
  const terminalMeasurements =
    terminal.measurements &&
    typeof terminal.measurements === "object" &&
    !Array.isArray(terminal.measurements)
      ? (terminal.measurements as JsonRecord)
      : {};
  const comparisonMeasurements = terminalMeasurements;
  const commonCapabilityContract = {
    capability_id: capabilityId,
    capability_version: 1,
    control_engine: controlEngine,
    manual_override_required: true,
    postcondition_verification_required: true,
  };
  const normalizedProgress = comparisonMode
    ? [
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
          event_type: readString(terminal.event_type),
          workflow_state: readString(terminal.workflow_state),
          progress_fraction: terminal.progress_fraction,
          measurements: comparisonMeasurements,
          manual_override_detected: manualOverride,
          controls_released: terminal.controls_released === true,
        },
      ]
    : events.map((event) => ({
        sequence: event.sequence,
        event_type: event.event_type,
        workflow_state: event.workflow_state,
        progress_fraction: event.progress_fraction,
        measurements: event.measurements,
        manual_override_detected: event.manual_override_detected,
        controls_released: event.controls_released,
      }));
  return environmentActionDifferentialCaptureInputSchema.parse({
    scenario_id: scenarioId ?? `minecraft_player_direct:${actionKind}`,
    lane: "direct_codex",
    action_kind: actionKind,
    prompt,
    starting_state: comparisonMode
      ? comparisonStartingState ?? {
          fixture_kind: "bounded_player_action",
          required_preconditions: ["connected", "on_ground"],
        }
      : request.starting_state ?? null,
    capability_contract: comparisonMode
      ? commonCapabilityContract
      : { ...commonCapabilityContract, local_reference_lane: true },
    source_artifact_refs: [
      `minecraft_client_log_sha256:${logHash}`,
      `direct_diagnostic_workflow:${workflowId}`,
    ],
    selected_capability_id: capabilityId,
    normalized_arguments: normalizedArguments,
    admission_status: "not_applicable",
    execution_outcome: executionOutcome,
    normalized_progress: normalizedProgress,
    postcondition_status:
      executionOutcome === "succeeded" ? "satisfied" : "not_satisfied",
    // Direct diagnostics do not pass through Helix re-entry, but the public
    // terminal controller event is still an executed observation. Retaining a
    // stable reference lets the observer distinguish "direct evidence exists"
    // from "Helix re-entered that evidence" without granting answer authority.
    observation_refs: [terminalObservationRef],
    observation_reentered: false,
    final_candidate_text: null,
    final_candidate_support_refs: [],
    route_product_text: null,
    route_product_support_refs: [],
    terminal_outcome: comparisonMode
      ? executionOutcome === "succeeded"
        ? "success"
        : "typed_failure"
      : "not_applicable",
    terminal_authority_status: "not_applicable",
    terminal_writer_text: null,
    terminal_writer_support_refs: [],
    visible_text: null,
    voice_projection_status: "not_applicable",
    voice_text: null,
    created_at:
      readString(terminal.created_at) || readString(request.started_at),
    hidden_reasoning_included: false,
  });
};

export const runDirectDiagnosticCaptureCli = (): void => {
  const logPath = argument("--log");
  const outputPath = argument("--out");
  const prompt = argument("--prompt");
  if (!logPath || !outputPath || !prompt) {
    throw new Error(
      "Usage: --log <minecraft-latest.log> --prompt <semantic-request> --out <public-capture.json> [--workflow-id <id>] [--scenario <id>]",
    );
  }

  const resolvedLog = path.resolve(logPath);
  const capture = buildDirectDiagnosticCapture({
    logText: fs.readFileSync(resolvedLog, "utf8"),
    prompt,
    requestedWorkflowId: argument("--workflow-id"),
    scenarioId: argument("--scenario"),
    comparisonMode: process.argv.includes("--comparison-mode"),
    comparisonStartingState: argument("--starting-state")
      ? JSON.parse(fs.readFileSync(path.resolve(argument("--starting-state")!), "utf8"))
      : undefined,
  });
  const resolvedOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
  const workflowRef = capture.source_artifact_refs.find((ref) =>
    ref.startsWith("direct_diagnostic_workflow:"),
  );
  process.stdout.write(
    `CAPTURED direct_codex ${capture.action_kind} ${workflowRef?.slice("direct_diagnostic_workflow:".length) ?? "unknown"} ${capture.execution_outcome}\n`,
  );
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runDirectDiagnosticCaptureCli();
}
