import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  helixMinecraftPlayerActionArgumentsSchema,
  minecraftPlayerCapabilityForActionKind,
} from "../shared/helix-minecraft-player-capabilities";
import {
  HELIX_MINECRAFT_PLAYER_EXECUTE_SEQUENCE_CAPABILITY,
  helixMinecraftFluidSequenceArgumentsSchema,
} from "../shared/helix-minecraft-fluid-sequence";
import {
  HELIX_MINECRAFT_PLAYER_EXECUTE_REACTIVE_PROGRAM_CAPABILITY,
  helixMinecraftReactiveProgramArgumentsSchema,
} from "../shared/helix-minecraft-reactive-program";
import { helixEnvironmentActionObservationSchema } from "../shared/helix-environment-action";
import {
  environmentActionDifferentialCaptureInputSchema,
  type EnvironmentActionDifferentialCaptureInput,
} from "../server/services/environment-connectors/actions/workflow-differential-trace-capture";

const actionSchema = z.union([
  helixMinecraftPlayerActionArgumentsSchema,
  helixMinecraftFluidSequenceArgumentsSchema,
  helixMinecraftReactiveProgramArgumentsSchema,
]);
const publicMcpCaptureSchema = z.object({
  prompt: z.string().min(1).max(200_000),
  scenario_id: z.string().min(1).max(320),
  starting_state: z.unknown(),
  action: actionSchema,
  mcp_result: z.object({
    operation: z.literal("minecraft.player.action"),
    room_id: z.string().min(1),
    ok: z.boolean(),
    status: z.enum(["completed", "blocked", "failed"]),
    summary: z.string(),
    idempotency_replayed: z.boolean(),
    observation: helixEnvironmentActionObservationSchema,
    answer_authority: z.literal(false),
    assistant_answer: z.literal(false),
    terminal_eligible: z.literal(false),
  }).strict(),
  codex_final_text: z.string().trim().min(1).max(200_000),
  codex_final_support_refs: z.array(z.string().trim().min(1).max(512)).min(1).max(128),
  created_at: z.string().datetime(),
  hidden_reasoning_included: z.literal(false),
}).strict();

export type PublicMinecraftMcpCapture = z.infer<typeof publicMcpCaptureSchema>;

const capabilityIdFor = (action: PublicMinecraftMcpCapture["action"]): string =>
  action.action_kind === "execute_sequence"
    ? HELIX_MINECRAFT_PLAYER_EXECUTE_SEQUENCE_CAPABILITY
    : action.action_kind === "execute_reactive_program"
      ? HELIX_MINECRAFT_PLAYER_EXECUTE_REACTIVE_PROGRAM_CAPABILITY
      : minecraftPlayerCapabilityForActionKind(action.action_kind);

const terminalProgress = (
  observation: z.infer<typeof helixEnvironmentActionObservationSchema>,
) => {
  const result = observation.result;
  const measurements = {
    ...(result.verified_terminal_measurements ?? {}),
    ...(typeof result.duration_ticks === "number" &&
      result.verified_terminal_measurements?.duration_ticks === undefined
      ? { duration_ticks: result.duration_ticks }
      : {}),
  };
  const succeeded = observation.outcome === "succeeded";
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
      event_type: succeeded ? "workflow.succeeded" : `workflow.${observation.outcome}`,
      workflow_state: succeeded ? "succeeded" : observation.outcome,
      progress_fraction: succeeded ? 1 : 0,
      measurements,
      manual_override_detected: result.manual_override_detected === true,
      controls_released: result.controls_released === true,
    },
  ];
};

export const buildMinecraftMcpDifferentialCapture = (
  raw: PublicMinecraftMcpCapture,
): EnvironmentActionDifferentialCaptureInput => {
  const input = publicMcpCaptureSchema.parse(raw);
  const { observation } = input.mcp_result;
  const capabilityId = capabilityIdFor(input.action);
  if (observation.capability_id !== capabilityId || observation.action_kind !== input.action.action_kind) {
    throw new Error("mcp_action_observation_identity_mismatch");
  }
  if (!input.codex_final_support_refs.includes(observation.evidence_ref)) {
    throw new Error("mcp_codex_candidate_missing_observation_support");
  }
  const requiredPostconditions = observation.result.postconditions.filter(
    (condition) => condition.required,
  );
  const postconditionStatus = requiredPostconditions.length === 0
    ? observation.outcome === "succeeded" ? "unknown" : "not_satisfied"
    : requiredPostconditions.every((condition) => condition.status === "satisfied")
      ? "satisfied"
      : "not_satisfied";
  const sourceHash = crypto.createHash("sha256")
    .update(JSON.stringify(input.mcp_result), "utf8")
    .digest("hex");
  const { action_kind: _actionKind, ...normalizedArguments } = input.action;
  return environmentActionDifferentialCaptureInputSchema.parse({
    scenario_id: input.scenario_id,
    lane: "codex_mcp",
    action_kind: input.action.action_kind,
    prompt: input.prompt,
    starting_state: input.starting_state,
    capability_contract: {
      capability_id: capabilityId,
      capability_version: observation.capability_version,
      control_engine: observation.result.control_engine,
      manual_override_required: true,
      postcondition_verification_required: true,
    },
    source_artifact_refs: [
      `mcp_public_result_sha256:${sourceHash}`,
      observation.evidence_ref,
    ],
    selected_capability_id: capabilityId,
    normalized_arguments: normalizedArguments,
    admission_status: input.mcp_result.status === "completed" ? "admitted" : "rejected",
    execution_outcome: observation.outcome,
    normalized_progress: terminalProgress(observation),
    postcondition_status: postconditionStatus,
    observation_refs: [observation.evidence_ref],
    observation_reentered: true,
    final_candidate_text: input.codex_final_text,
    final_candidate_support_refs: input.codex_final_support_refs,
    route_product_text: null,
    route_product_support_refs: [],
    terminal_outcome: "not_applicable",
    terminal_authority_status: "not_applicable",
    terminal_writer_text: null,
    terminal_writer_support_refs: [],
    visible_text: null,
    voice_projection_status: "not_applicable",
    voice_text: null,
    created_at: input.created_at,
    hidden_reasoning_included: false,
  });
};

const argument = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
};

export const runMinecraftMcpCaptureCli = (): void => {
  const inputPath = argument("--input");
  const outputPath = argument("--out");
  if (!inputPath || !outputPath) {
    throw new Error("Usage: --input <public-mcp-turn.json> --out <public-capture.json>");
  }
  const capture = buildMinecraftMcpDifferentialCapture(
    JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8")),
  );
  const resolvedOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
  process.stdout.write(`CAPTURED codex_mcp ${capture.action_kind} ${capture.execution_outcome} reentered=${capture.observation_reentered}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runMinecraftMcpCaptureCli();
}
