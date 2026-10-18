import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  helixMinecraftCombatArenaManifestSchema,
  type HelixMinecraftCombatArenaManifest,
} from "../shared/helix-minecraft-combat";
import { classifyKnownMinecraftCommand } from
  "../server/services/helix-ask/workstation-tool-gateway/minecraft-command-risk";

const FIXTURE_PATH =
  "scripts/fixtures/minecraft-combat-c0-zombie-baseline-v1.json";

const coordinateSchema = z.number().int().min(-29_999_000).max(29_999_000);
export const combatC0ArenaPlanRequestSchema = z.object({
  schema: z.literal("helix.minecraft_combat_arena_plan_request.v1"),
  server_instance_id: z.string().trim().regex(/^[A-Za-z0-9:._/-]{1,160}$/),
  player_name: z.string().trim().regex(/^[A-Za-z0-9_]{1,16}$/),
  origin: z.object({
    x: coordinateSchema,
    y: z.number().int().min(-60).max(310),
    z: coordinateSchema,
  }).strict(),
  world_snapshot_ref: z.string().trim().regex(/^snapshot:[A-Za-z0-9:._/-]{1,180}$/),
  disposable_arena_region_acknowledged: z.literal(true),
}).strict();

type Position = { x: number; y: number; z: number };
type CommandDeclaration = {
  command: string;
  category: string;
  effect: string;
};

export type CombatC0ArenaPlan = {
  schema: "helix.minecraft_combat_arena_plan.v1";
  arena_id: string;
  arena_version: number;
  arena_manifest_sha256: string;
  program_gate: "G8";
  tier: "C0";
  acceptance_class: "deterministic_fixture";
  server_instance_id: string;
  player_name: string;
  origin: Position;
  world_snapshot_ref: string;
  authority: {
    setup_plane: "world_authority_setup_only";
    measurement_plane: "player_embodiment_only";
    setup_receipts_acceptance_eligible: false;
    world_authority_must_be_released_before_measurement: true;
  };
  admitted_target: {
    fixture_label: "primary_zombie";
    entity_type_id: "minecraft:zombie";
    classification: "hostile";
    runtime_target_ref_required: true;
    implicit_nearest_attack_forbidden: true;
  };
  setup_commands: string[];
  verification_commands: string[];
  setup_command_declarations: CommandDeclaration[];
  verification_command_declarations: Array<{
    command: string;
    category: "query";
    effect: "read_only";
  }>;
  restore: {
    mode: "server_world_snapshot";
    snapshot_ref: string;
    required_after_trial: true;
  };
  credentials_included: false;
  hidden_reasoning_included: false;
  plan_sha256: string;
};

const add = (origin: Position, offset: Position): Position => ({
  x: origin.x + offset.x,
  y: origin.y + offset.y,
  z: origin.z + offset.z,
});
const xyz = (position: Position): string =>
  `${position.x} ${position.y} ${position.z}`;
const inDimension = (dimensionId: string, command: string): string =>
  `execute in ${dimensionId} run ${command}`;

const readManifest = (
  workspaceRoot: string,
): { raw: string; manifest: HelixMinecraftCombatArenaManifest } => {
  const raw = fs.readFileSync(path.resolve(workspaceRoot, FIXTURE_PATH), "utf8");
  return {
    raw,
    manifest: helixMinecraftCombatArenaManifestSchema.parse(JSON.parse(raw)),
  };
};

export const buildCombatC0ArenaPlan = (
  rawRequest: unknown,
  workspaceRoot = process.cwd(),
): CombatC0ArenaPlan => {
  const request = combatC0ArenaPlanRequestSchema.parse(rawRequest);
  const { raw: manifestRaw, manifest } = readManifest(workspaceRoot);
  if (
    manifest.tier !== "C0" ||
    manifest.acceptance_class !== "deterministic_fixture" ||
    manifest.rules.world_authority_released_before_measurement !== true
  ) {
    throw new Error("minecraft_combat_c0_manifest_authority_contract_invalid");
  }

  const regionMin = add(request.origin, manifest.bounds.min);
  const regionMax = add(request.origin, manifest.bounds.max);
  const playerStart = add(request.origin, manifest.spawn_points.player.offset);
  const zombieSpawn = add(
    request.origin,
    manifest.spawn_points.entities.find((spawn) =>
      spawn.label === "primary_zombie"
    )!.offset,
  );
  const zombieSelector =
    "@e[type=minecraft:zombie,tag=helix_c0_primary_zombie,limit=1]";

  const setupCommands = [
    inDimension(
      manifest.dimension_id,
      `fill ${xyz(regionMin)} ${xyz(regionMax)} minecraft:stone hollow`,
    ),
    inDimension(
      manifest.dimension_id,
      `fill ${regionMin.x + 1} ${regionMin.y + 1} ${regionMin.z + 1} ${regionMax.x - 1} ${regionMax.y - 1} ${regionMax.z - 1} minecraft:air replace`,
    ),
    "difficulty normal",
    "gamerule doMobSpawning false",
    "gamerule doDaylightCycle false",
    "gamerule keepInventory true",
    "time set noon",
    `kill @e[tag=helix_c0_primary_zombie]`,
    `gamemode survival ${request.player_name}`,
    `effect clear ${request.player_name}`,
    `clear ${request.player_name}`,
    `give ${request.player_name} minecraft:iron_sword 1`,
    `give ${request.player_name} minecraft:bread 4`,
    inDimension(
      manifest.dimension_id,
      `summon minecraft:zombie ${xyz(zombieSpawn)} {IsBaby:0b,PersistenceRequired:1b,CanPickUpLoot:0b,ArmorItems:[{},{},{},{}],HandItems:[{},{}],Tags:["helix_c0_primary_zombie"]}`,
    ),
    inDimension(
      manifest.dimension_id,
      `tp ${request.player_name} ${xyz(playerStart)} ${manifest.spawn_points.player.yaw_degrees} ${manifest.spawn_points.player.pitch_degrees}`,
    ),
  ];
  const verificationCommands = [
    "difficulty",
    "gamerule doMobSpawning",
    "gamerule doDaylightCycle",
    "gamerule keepInventory",
    `data get entity ${request.player_name} Pos`,
    `data get entity ${zombieSelector}`,
  ];
  const setupCommandDeclarations = setupCommands.map((command) => {
    const declaration = classifyKnownMinecraftCommand(command);
    if (!declaration || declaration.effect === "read_only") {
      throw new Error(`minecraft_combat_c0_setup_command_unclassified:${command}`);
    }
    return { command, ...declaration };
  });
  const verificationCommandDeclarations = verificationCommands.map((command) => {
    const declaration = classifyKnownMinecraftCommand(command);
    if (
      declaration?.category !== "query" ||
      declaration.effect !== "read_only"
    ) {
      throw new Error(`minecraft_combat_c0_verification_command_not_read_only:${command}`);
    }
    return {
      command,
      category: "query" as const,
      effect: "read_only" as const,
    };
  });
  const manifestHash = crypto.createHash("sha256").update(manifestRaw).digest("hex");
  const unsigned = {
    schema: "helix.minecraft_combat_arena_plan.v1" as const,
    arena_id: manifest.arena_id,
    arena_version: manifest.arena_version,
    arena_manifest_sha256: manifestHash,
    program_gate: "G8" as const,
    tier: "C0" as const,
    acceptance_class: "deterministic_fixture" as const,
    server_instance_id: request.server_instance_id,
    player_name: request.player_name,
    origin: request.origin,
    world_snapshot_ref: request.world_snapshot_ref,
    authority: {
      setup_plane: "world_authority_setup_only" as const,
      measurement_plane: "player_embodiment_only" as const,
      setup_receipts_acceptance_eligible: false as const,
      world_authority_must_be_released_before_measurement: true as const,
    },
    admitted_target: {
      fixture_label: "primary_zombie" as const,
      entity_type_id: "minecraft:zombie" as const,
      classification: "hostile" as const,
      runtime_target_ref_required: true as const,
      implicit_nearest_attack_forbidden: true as const,
    },
    setup_commands: setupCommands,
    verification_commands: verificationCommands,
    setup_command_declarations: setupCommandDeclarations,
    verification_command_declarations: verificationCommandDeclarations,
    restore: {
      mode: "server_world_snapshot" as const,
      snapshot_ref: request.world_snapshot_ref,
      required_after_trial: true as const,
    },
    credentials_included: false as const,
    hidden_reasoning_included: false as const,
  };
  return {
    ...unsigned,
    plan_sha256: crypto
      .createHash("sha256")
      .update(JSON.stringify(unsigned))
      .digest("hex"),
  };
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
};
const isCli =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  readStdin()
    .then((value) => {
      if (!value) throw new Error("minecraft_combat_c0_arena_plan_stdin_required");
      process.stdout.write(`${JSON.stringify(buildCombatC0ArenaPlan(JSON.parse(value)), null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
