import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { classifyKnownMinecraftCommand } from
  "../server/services/helix-ask/workstation-tool-gateway/minecraft-command-risk";

const FIXTURE_PATH =
  "scripts/fixtures/minecraft-nether1-n0-course-v1.json";

const coordinateSchema = z.number().int().min(-29_999_000).max(29_999_000);
const offsetSchema = z.object({
  x: z.number().int().min(-64).max(64),
  y: z.number().int().min(-64).max(64),
  z: z.number().int().min(-64).max(64),
}).strict();

export const nether1N0CoursePlanRequestSchema = z.object({
  schema: z.literal("helix.minecraft.nether1_n0_course_plan_request.v1"),
  server_instance_id: z.string().trim().regex(/^[A-Za-z0-9:._/-]{1,160}$/),
  dimension_id: z.string().trim().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/),
  player_name: z.string().trim().regex(/^[A-Za-z0-9_]{1,16}$/),
  origin: z.object({
    x: coordinateSchema,
    y: z.number().int().min(-60).max(310),
    z: coordinateSchema,
  }).strict(),
  world_snapshot_ref: z.string().trim().regex(
    /^snapshot:[A-Za-z0-9:._/-]{1,180}$/,
  ),
  disposable_course_region_acknowledged: z.literal(true),
}).strict();

type CourseFixture = {
  schema: string;
  fixture_id: string;
  objective_id: string;
  program_gate: string;
  ruleset: string;
  authority_contract: {
    setup_plane: string;
    execution_plane: string;
    setup_receipts_acceptance_eligible: boolean;
    setup_authority_released_before_course: boolean;
    restore_before_n1: boolean;
    forbidden_acceptance_stages: string[];
  };
  world_contract: {
    dedicated_disposable_course_region_required: boolean;
    pre_course_world_snapshot_required: boolean;
    restore_mode: string;
    region_min_offset: z.infer<typeof offsetSchema>;
    region_max_offset: z.infer<typeof offsetSchema>;
  };
  composition_template: {
    path: string;
    origin: z.infer<typeof offsetSchema>;
  };
  stations: {
    player_start_offset: z.infer<typeof offsetSchema>;
    collection_item_offset: z.infer<typeof offsetSchema>;
    furnace_offset: z.infer<typeof offsetSchema>;
    crafting_table_offset: z.infer<typeof offsetSchema>;
    portal: {
      plane: string;
      interior_min_offset: z.infer<typeof offsetSchema>;
      interior_max_offset: z.infer<typeof offsetSchema>;
      frame_block_id: string;
    };
  };
  setup_inventory: Array<{ item_id: string; count: number }>;
  forbidden_setup_outputs: string[];
};

export type Nether1N0CoursePlanRequest = z.infer<
  typeof nether1N0CoursePlanRequestSchema
>;

export type Nether1N0CoursePlan = {
  schema: "helix.minecraft.nether1_n0_course_plan.v1";
  fixture_id: string;
  objective_id: string;
  program_gate: string;
  ruleset: string;
  server_instance_id: string;
  dimension_id: string;
  player_name: string;
  origin: { x: number; y: number; z: number };
  world_snapshot_ref: string;
  authority: {
    setup_plane: "world_authority_setup_only";
    course_plane: "player_embodiment_only";
    setup_receipts_acceptance_eligible: false;
    setup_authority_must_be_released_before_course: true;
  };
  setup_commands: string[];
  verification_commands: string[];
  setup_command_declarations: Array<{
    command: string;
    category: string;
    effect: string;
  }>;
  verification_command_declarations: Array<{
    command: string;
    category: "query";
    effect: "read_only";
  }>;
  materialized_compositions: Array<Record<string, unknown>>;
  restore: {
    mode: "server_world_snapshot";
    snapshot_ref: string;
    required_before_stages: string[];
  };
  forbidden_setup_outputs: string[];
  credentials_included: false;
  hidden_reasoning_included: false;
  plan_sha256: string;
};

const add = (
  origin: { x: number; y: number; z: number },
  offset: { x: number; y: number; z: number },
): { x: number; y: number; z: number } => ({
  x: origin.x + offset.x,
  y: origin.y + offset.y,
  z: origin.z + offset.z,
});

const xyz = (position: { x: number; y: number; z: number }): string =>
  `${position.x} ${position.y} ${position.z}`;

const inDimension = (dimensionId: string, command: string): string =>
  `execute in ${dimensionId} run ${command}`;

const readFixture = (workspaceRoot: string): CourseFixture =>
  JSON.parse(
    fs.readFileSync(path.resolve(workspaceRoot, FIXTURE_PATH), "utf8"),
  ) as CourseFixture;

const materializeCompositions = (
  workspaceRoot: string,
  fixture: CourseFixture,
  origin: { x: number; y: number; z: number },
): Array<Record<string, unknown>> => {
  const source = JSON.parse(
    fs.readFileSync(
      path.resolve(workspaceRoot, fixture.composition_template.path),
      "utf8",
    ),
  ) as { compositions?: Array<Record<string, unknown>> };
  if (!Array.isArray(source.compositions)) {
    throw new Error("nether1_n0_composition_template_invalid");
  }
  const delta = {
    x: origin.x - fixture.composition_template.origin.x,
    y: origin.y - fixture.composition_template.origin.y,
    z: origin.z - fixture.composition_template.origin.z,
  };
  const shiftPosition = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(shiftPosition);
    if (!value || typeof value !== "object") {
      if (typeof value === "string") {
        return value.replace(
          /\b0,65,0\b/g,
          `${origin.x},${origin.y + 1},${origin.z}`,
        );
      }
      return value;
    }
    const record = value as Record<string, unknown>;
    const isPosition =
      typeof record.x === "number" &&
      typeof record.y === "number" &&
      typeof record.z === "number" &&
      Object.keys(record).every((key) => ["x", "y", "z"].includes(key));
    if (isPosition) {
      return {
        x: (record.x as number) + delta.x,
        y: (record.y as number) + delta.y,
        z: (record.z as number) + delta.z,
      };
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [key, shiftPosition(child)]),
    );
  };
  return source.compositions.map((composition) =>
    shiftPosition(composition) as Record<string, unknown>
  );
};

export const buildNether1N0CoursePlan = (
  rawRequest: unknown,
  workspaceRoot = process.cwd(),
): Nether1N0CoursePlan => {
  const request = nether1N0CoursePlanRequestSchema.parse(rawRequest);
  const fixture = readFixture(workspaceRoot);
  if (
    fixture.schema !== "helix.minecraft.nether1_n0_course_fixture.v1" ||
    fixture.fixture_id !== "EH-MC-NETHER1-N0-controlled-course-v1" ||
    fixture.authority_contract.setup_plane !== "world_authority_setup_only" ||
    fixture.authority_contract.execution_plane !== "player_embodiment_only" ||
    fixture.authority_contract.setup_receipts_acceptance_eligible !== false ||
    fixture.world_contract.restore_mode !== "server_world_snapshot"
  ) {
    throw new Error("nether1_n0_course_fixture_authority_contract_invalid");
  }

  const regionMin = add(request.origin, fixture.world_contract.region_min_offset);
  const regionMax = add(request.origin, fixture.world_contract.region_max_offset);
  const start = add(request.origin, fixture.stations.player_start_offset);
  const collection = add(request.origin, fixture.stations.collection_item_offset);
  const furnace = add(request.origin, fixture.stations.furnace_offset);
  const craftingTable = add(
    request.origin,
    fixture.stations.crafting_table_offset,
  );
  const portalInteriorMin = add(
    request.origin,
    fixture.stations.portal.interior_min_offset,
  );
  const portalInteriorMax = add(
    request.origin,
    fixture.stations.portal.interior_max_offset,
  );
  const portalLeftX = portalInteriorMin.x - 1;
  const portalRightX = portalInteriorMax.x + 1;
  const portalBottomY = portalInteriorMin.y - 1;
  const portalTopY = portalInteriorMax.y + 1;
  const portalZ = portalInteriorMin.z;

  const setupCommands = [
    inDimension(
      request.dimension_id,
      `fill ${xyz(regionMin)} ${xyz(regionMax)} minecraft:air replace`,
    ),
    inDimension(
      request.dimension_id,
      `fill ${regionMin.x} ${request.origin.y - 1} ${regionMin.z} ${regionMax.x} ${request.origin.y - 1} ${regionMax.z} minecraft:stone replace`,
    ),
    inDimension(
      request.dimension_id,
      `setblock ${xyz(furnace)} minecraft:furnace replace`,
    ),
    inDimension(
      request.dimension_id,
      `setblock ${xyz(craftingTable)} minecraft:crafting_table replace`,
    ),
    inDimension(
      request.dimension_id,
      `fill ${portalLeftX} ${portalBottomY} ${portalZ} ${portalRightX} ${portalBottomY} ${portalZ} ${fixture.stations.portal.frame_block_id} replace`,
    ),
    inDimension(
      request.dimension_id,
      `fill ${portalLeftX} ${portalTopY} ${portalZ} ${portalRightX} ${portalTopY} ${portalZ} ${fixture.stations.portal.frame_block_id} replace`,
    ),
    inDimension(
      request.dimension_id,
      `fill ${portalLeftX} ${portalInteriorMin.y} ${portalZ} ${portalLeftX} ${portalInteriorMax.y} ${portalZ} ${fixture.stations.portal.frame_block_id} replace`,
    ),
    inDimension(
      request.dimension_id,
      `fill ${portalRightX} ${portalInteriorMin.y} ${portalZ} ${portalRightX} ${portalInteriorMax.y} ${portalZ} ${fixture.stations.portal.frame_block_id} replace`,
    ),
    `gamemode survival ${request.player_name}`,
    `effect clear ${request.player_name}`,
    `clear ${request.player_name}`,
    ...fixture.setup_inventory.map(
      (item) => `give ${request.player_name} ${item.item_id} ${item.count}`,
    ),
    inDimension(
      request.dimension_id,
      `summon minecraft:item ${xyz(collection)} {Item:{id:"minecraft:cobblestone",count:1}}`,
    ),
    inDimension(
      request.dimension_id,
      `tp ${request.player_name} ${xyz(start)} -90 0`,
    ),
  ];

  const verificationCommands = [
    inDimension(
      request.dimension_id,
      `execute if block ${xyz(furnace)} minecraft:furnace run data get entity ${request.player_name} Pos`,
    ),
    inDimension(
      request.dimension_id,
      `execute if block ${xyz(craftingTable)} minecraft:crafting_table run data get entity ${request.player_name} Pos`,
    ),
    inDimension(
      request.dimension_id,
      `execute unless block ${xyz(portalInteriorMin)} minecraft:nether_portal run data get entity ${request.player_name} Pos`,
    ),
  ];
  const setupCommandDeclarations = setupCommands.map((command) => {
    const declaration = classifyKnownMinecraftCommand(command);
    if (!declaration || declaration.effect === "read_only") {
      throw new Error("nether1_n0_setup_command_risk_unclassified");
    }
    return { command, ...declaration };
  });
  const verificationCommandDeclarations = verificationCommands.map((command) => {
    const declaration = classifyKnownMinecraftCommand(command);
    if (
      !declaration ||
      declaration.category !== "query" ||
      declaration.effect !== "read_only"
    ) {
      throw new Error("nether1_n0_verification_command_not_read_only");
    }
    return {
      command,
      category: "query" as const,
      effect: "read_only" as const,
    };
  });
  const materializedCompositions = materializeCompositions(
    workspaceRoot,
    fixture,
    request.origin,
  );

  const unsigned = {
    schema: "helix.minecraft.nether1_n0_course_plan.v1" as const,
    fixture_id: fixture.fixture_id,
    objective_id: fixture.objective_id,
    program_gate: fixture.program_gate,
    ruleset: fixture.ruleset,
    server_instance_id: request.server_instance_id,
    dimension_id: request.dimension_id,
    player_name: request.player_name,
    origin: request.origin,
    world_snapshot_ref: request.world_snapshot_ref,
    authority: {
      setup_plane: "world_authority_setup_only" as const,
      course_plane: "player_embodiment_only" as const,
      setup_receipts_acceptance_eligible: false as const,
      setup_authority_must_be_released_before_course: true as const,
    },
    setup_commands: setupCommands,
    verification_commands: verificationCommands,
    setup_command_declarations: setupCommandDeclarations,
    verification_command_declarations: verificationCommandDeclarations,
    materialized_compositions: materializedCompositions,
    restore: {
      mode: "server_world_snapshot" as const,
      snapshot_ref: request.world_snapshot_ref,
      required_before_stages: fixture.authority_contract.forbidden_acceptance_stages,
    },
    forbidden_setup_outputs: fixture.forbidden_setup_outputs,
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
      if (!value) throw new Error("nether1_n0_course_plan_stdin_required");
      const plan = buildNether1N0CoursePlan(JSON.parse(value));
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
