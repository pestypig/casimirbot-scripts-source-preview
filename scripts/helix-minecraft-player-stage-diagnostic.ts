import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  helixMinecraftPlayerActionArgumentsSchema,
  type HelixMinecraftPlayerActionArguments,
} from "../shared/helix-minecraft-player-capabilities";
import {
  helixMinecraftFluidSequenceArgumentsSchema,
  type HelixMinecraftFluidSequenceArguments,
} from "../shared/helix-minecraft-fluid-sequence";
import {
  helixMinecraftReactiveProgramArgumentsSchema,
  type HelixMinecraftReactiveProgramArguments,
} from "../shared/helix-minecraft-reactive-program";
import {
  helixMinecraftArmViabilityGuardianArgumentsSchema,
  helixMinecraftDisarmViabilityGuardianArgumentsSchema,
  type HelixMinecraftArmViabilityGuardianArguments,
  type HelixMinecraftDisarmViabilityGuardianArguments,
} from "../shared/helix-minecraft-viability-guardian";

const INBOX_FILE = "helix-fabric-player-agent.diagnostic-inbox.json";
const INBOX_SCHEMA = "helix.minecraft.player.direct_diagnostic_request.v1";
const SUBJECT_PATTERN = /^[a-zA-Z0-9:._/-]{1,320}$/;

type JsonRecord = Record<string, unknown>;
type DirectDiagnosticAction =
  | HelixMinecraftPlayerActionArguments
  | HelixMinecraftFluidSequenceArguments
  | HelixMinecraftReactiveProgramArguments
  | HelixMinecraftArmViabilityGuardianArguments
  | HelixMinecraftDisarmViabilityGuardianArguments;

export type DirectDiagnosticEnvelope = {
  schema: typeof INBOX_SCHEMA;
  request_id: string;
  action_kind: DirectDiagnosticAction["action_kind"];
  arguments: JsonRecord;
  max_duration_ticks: number;
  control_engine: "native_fabric" | "baritone";
};

const asRecord = (value: unknown): JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("player_diagnostic_action_must_be_an_object");
  }
  return value as JsonRecord;
};

const positiveInteger = (value: unknown, code: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(code);
  }
  return value;
};

const ceilingMsFor = (
  action: DirectDiagnosticAction,
): number => {
  switch (action.action_kind) {
    case "navigate_to":
      return 5 * 60_000;
    case "look_at":
    case "walk":
    case "jump":
    case "interact":
    case "equip":
      return 15_000;
    case "track_target":
      return Math.min(action.max_duration_ms + 5_000, 5 * 60_000);
    case "attack":
      return Math.min(action.max_duration_ms + 5_000, 60_000);
    case "consume":
      return Math.min(action.max_duration_ms + 5_000, 60_000);
    case "combat_guard":
      return Math.min(action.max_duration_ms + 5_000, 5 * 60_000);
    case "hotbar_select":
      return 10_000;
    case "follow":
      return Math.min(action.max_duration_ms + 5_000, 30 * 60_000);
    case "collect":
    case "craft":
    case "inventory_transfer":
      return 10 * 60_000;
    case "mine":
    case "place":
      return 30 * 60_000;
    case "execute_sequence":
      return Math.min(action.max_total_ticks * 50 + 5_000, 30 * 60_000);
    case "execute_reactive_program":
      return Math.min(action.max_total_ticks * 50 + 5_000, 30 * 60_000);
    case "arm_viability_guardian":
      return Math.min(action.duration_ticks * 50 + 5_000, 30 * 60_000);
    case "disarm_viability_guardian":
      return 5_000;
  }
};

const validateFollowDirectIdentity = (
  raw: JsonRecord,
): { nativeId: string; label?: string } => {
  const nativeId = typeof raw.target_subject_native_id === "string"
    ? raw.target_subject_native_id.trim()
    : "";
  if (!SUBJECT_PATTERN.test(nativeId)) {
    throw new Error("player_diagnostic_follow_target_native_id_required");
  }
  const label = typeof raw.target_subject_label === "string"
    ? raw.target_subject_label.trim()
    : undefined;
  if (label !== undefined && (label.length < 1 || label.length > 320)) {
    throw new Error("player_diagnostic_follow_target_label_invalid");
  }
  return { nativeId, label };
};

export const buildDirectDiagnosticEnvelope = (input: {
  action: unknown;
  maxDurationMs?: number;
  requestId?: string;
}): DirectDiagnosticEnvelope => {
  const raw = asRecord(input.action);
  const actionKind = typeof raw.action_kind === "string" ? raw.action_kind : "";
  let schemaInput: JsonRecord = raw;
  let followIdentity: ReturnType<typeof validateFollowDirectIdentity> | null = null;
  if (actionKind === "follow") {
    followIdentity = validateFollowDirectIdentity(raw);
    const {
      target_subject_native_id: _nativeId,
      target_subject_label: _label,
      ...modelFacing
    } = raw;
    schemaInput = modelFacing;
  }
  const parsed = actionKind === "execute_sequence"
    ? helixMinecraftFluidSequenceArgumentsSchema.safeParse(schemaInput)
    : actionKind === "execute_reactive_program"
    ? helixMinecraftReactiveProgramArgumentsSchema.safeParse(schemaInput)
    : actionKind === "arm_viability_guardian"
    ? helixMinecraftArmViabilityGuardianArgumentsSchema.safeParse(schemaInput)
    : actionKind === "disarm_viability_guardian"
    ? helixMinecraftDisarmViabilityGuardianArgumentsSchema.safeParse(schemaInput)
    : helixMinecraftPlayerActionArgumentsSchema.safeParse(schemaInput);
  if (!parsed.success) {
    throw new Error(
      `player_diagnostic_action_invalid:${parsed.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join(".")}:${issue.message}`)
        .join(";")}`,
    );
  }
  const action = parsed.data as DirectDiagnosticAction;
  const { action_kind: _actionKind, ...baseArguments } = action;
  const argumentsValue: JsonRecord = { ...baseArguments };
  if (followIdentity) {
    argumentsValue.target_subject_native_id = followIdentity.nativeId;
    if (followIdentity.label) {
      argumentsValue.target_subject_label = followIdentity.label;
    }
  }
  const ceilingMs = ceilingMsFor(action);
  const selectedDurationMs = input.maxDurationMs === undefined
    ? ceilingMs
    : Math.min(
        positiveInteger(
          input.maxDurationMs,
          "player_diagnostic_max_duration_ms_invalid",
        ),
        ceilingMs,
      );
  const controlEngine = action.action_kind === "navigate_to" &&
      action.engine_preference === "baritone"
    ? "baritone"
    : "native_fabric";
  const requestId = input.requestId?.trim() ||
    `direct_diagnostic_request:${crypto.randomUUID()}`;
  if (!/^[A-Za-z0-9:._-]{1,200}$/.test(requestId)) {
    throw new Error("player_diagnostic_request_id_invalid");
  }
  return {
    schema: INBOX_SCHEMA,
    request_id: requestId,
    action_kind: action.action_kind,
    arguments: argumentsValue,
    max_duration_ticks: Math.max(1, Math.min(36_000, Math.ceil(selectedDurationMs / 50))),
    control_engine: controlEngine,
  };
};

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name.slice(2).replaceAll("-", "_")}_missing`);
  }
  return value;
};

const stage = async (): Promise<void> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const rawInput = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawInput) throw new Error("player_diagnostic_stdin_json_required");
  const maxDurationRaw = option("--max-duration-ms");
  const envelope = buildDirectDiagnosticEnvelope({
    action: JSON.parse(rawInput),
    maxDurationMs: maxDurationRaw === undefined
      ? undefined
      : Number(maxDurationRaw),
    requestId: option("--request-id"),
  });

  const configuredRoot = option("--minecraft-root") ??
    (process.env.APPDATA ? path.join(process.env.APPDATA, ".minecraft") : "");
  if (!configuredRoot) throw new Error("minecraft_root_required");
  const minecraftRoot = path.resolve(configuredRoot);
  const configDirectory = path.resolve(minecraftRoot, "config");
  const relativeConfig = path.relative(minecraftRoot, configDirectory);
  if (relativeConfig.startsWith("..") || path.isAbsolute(relativeConfig)) {
    throw new Error("player_diagnostic_inbox_path_invalid");
  }
  await fs.mkdir(configDirectory, { recursive: true });
  const inboxPath = path.join(configDirectory, INBOX_FILE);
  const pendingPath = path.join(
    configDirectory,
    `${INBOX_FILE}.pending.${process.pid}.${crypto.randomUUID()}`,
  );
  try {
    try {
      await fs.access(inboxPath);
      throw new Error("player_diagnostic_inbox_already_pending");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "player_diagnostic_inbox_already_pending"
      ) throw error;
    }
    await fs.writeFile(
      pendingPath,
      `${JSON.stringify(envelope)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await fs.rename(pendingPath, inboxPath);
  } finally {
    await fs.rm(pendingPath, { force: true }).catch(() => undefined);
  }
  process.stdout.write(
    `STAGED ${envelope.action_kind} ${envelope.request_id} ${inboxPath}\n`,
  );
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  stage().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
