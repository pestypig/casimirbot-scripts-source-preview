import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HELIX_MINECRAFT_PLAYER_CAPABILITY_IDS,
  HELIX_MINECRAFT_PLAYER_ACTION_KINDS,
  minecraftPlayerCapabilityForActionKind,
  type HelixMinecraftPlayerActionArguments,
} from "../shared/helix-minecraft-player-capabilities";
import {
  HELIX_MINECRAFT_FLUID_CONDITION_KINDS,
  helixMinecraftFluidSequenceArgumentsSchema,
} from "../shared/helix-minecraft-fluid-sequence";
import {
  HELIX_MINECRAFT_ACTOR_STATUS_READ_CAPABILITY,
  HELIX_MINECRAFT_INVENTORY_CHECK_CAPABILITY,
  HELIX_MINECRAFT_SPATIAL_REGION_INSPECT_CAPABILITY,
} from "../shared/helix-environment-connector";
import { HELIX_MINECRAFT_SITUATION_DIGEST_READ_CAPABILITY } from
  "../shared/helix-environment-event-stream";

const fixturePath =
  "scripts/fixtures/minecraft-nether1-n0-readiness-v1.json";
const packetPath =
  "docs/work-packets/eh-mc-nether1-legitimate-nether-entry-v1.md";
const workProgramPath = "docs/helix-environment-harness-work-program-v1.md";
const compositionFixturePath =
  "scripts/fixtures/minecraft-nether1-n0-compositions-v1.json";
const courseFixturePath =
  "scripts/fixtures/minecraft-nether1-n0-course-v1.json";
const coursePlannerPath =
  "scripts/helix-minecraft-nether1-n0-course-plan.ts";
const playerRuntimePath =
  "minecraft/helix-fabric-player-agent/src/main/java/com/casimirbot/helixplayer/fabric/PlayerActionRuntime.java";

type Nether1N0Fixture = {
  schema: string;
  objective_id: string;
  program_gate: string;
  maturity: string;
  ruleset: string;
  execution_plane: string;
  required_player_capability_ids: string[];
  required_fabric_manifest_capability_ids: string[];
  required_read_capability_ids: string[];
  required_action_kinds: string[];
  required_condition_kinds: string[];
  required_compositions: Array<{
    composition_id: string;
    action_kinds: string[];
    condition_kinds: string[];
  }>;
  required_contract_files: string[];
  forbidden_capability_ids: string[];
  acceptance_shortcuts_forbidden: string[];
};

export type Nether1N0ReadinessResult = {
  schema: "helix.minecraft.nether1_n0_readiness_audit.v1";
  objective_id: string;
  program_gate: string;
  maturity: string;
  checks_run: number;
  capabilities_checked: number;
  action_kinds_checked: number;
  condition_kinds_checked: number;
  compositions_checked: number;
  contract_files_checked: number;
  ready_for_n0: boolean;
  failures: string[];
  live_acceptance_claimed: false;
};

const readText = (workspaceRoot: string, relativePath: string): string =>
  fs.readFileSync(path.resolve(workspaceRoot, relativePath), "utf8");

export const auditMinecraftNether1N0Readiness = (
  workspaceRoot = process.cwd(),
): Nether1N0ReadinessResult => {
  const fixture = JSON.parse(readText(workspaceRoot, fixturePath)) as
    Nether1N0Fixture;
  const packet = readText(workspaceRoot, packetPath);
  const workProgram = readText(workspaceRoot, workProgramPath);
  const playerRuntime = readText(workspaceRoot, playerRuntimePath);
  const compositionFixture = JSON.parse(
    readText(workspaceRoot, compositionFixturePath),
  ) as {
    schema: string;
    objective_id: string;
    ruleset: string;
    fixture_contract: Record<string, unknown>;
    compositions: Array<{
      composition_id: string;
      preconditions: string[];
      sequence: unknown;
    }>;
  };
  const courseFixture = JSON.parse(
    readText(workspaceRoot, courseFixturePath),
  ) as {
    schema: string;
    fixture_id: string;
    objective_id: string;
    program_gate: string;
    authority_contract: Record<string, unknown>;
    world_contract: Record<string, unknown>;
    composition_template: {
      path: string;
      origin: { x: number; y: number; z: number };
    };
    forbidden_setup_outputs: string[];
  };
  const coursePlanner = readText(workspaceRoot, coursePlannerPath);
  const failures: string[] = [];
  let checksRun = 0;

  const check = (condition: boolean, failure: string): void => {
    checksRun += 1;
    if (!condition) failures.push(failure);
  };

  check(
    fixture.schema === "helix.minecraft.nether1_n0_readiness.v1",
    `fixture_schema_invalid:${fixture.schema}`,
  );
  check(fixture.objective_id === "EH-MC-NETHER1", "objective_id_invalid");
  check(fixture.program_gate === "G8", "fixture_gate_not_g8");
  check(fixture.maturity === "specified", "fixture_maturity_not_specified");
  check(fixture.ruleset === "survival_tas", "ruleset_not_survival_tas");
  check(
    fixture.execution_plane === "player_embodiment",
    "execution_plane_not_player_embodiment",
  );
  check(
    compositionFixture.schema ===
      "helix.minecraft.nether1_n0_compositions.v1",
    "composition_fixture_schema_invalid",
  );
  check(
    compositionFixture.objective_id === fixture.objective_id,
    "composition_fixture_objective_mismatch",
  );
  check(
    compositionFixture.ruleset === fixture.ruleset,
    "composition_fixture_ruleset_mismatch",
  );
  check(
    compositionFixture.fixture_contract.world_kind ===
      "controlled_survival_course" &&
      compositionFixture.fixture_contract.world_authority_setup_only === true &&
      compositionFixture.fixture_contract.player_embodiment_execution_only === true &&
      compositionFixture.fixture_contract.restore_before_n1 === true,
    "composition_fixture_authority_boundary_invalid",
  );
  check(
    courseFixture.schema === "helix.minecraft.nether1_n0_course_fixture.v1" &&
      courseFixture.fixture_id === "EH-MC-NETHER1-N0-controlled-course-v1" &&
      courseFixture.objective_id === fixture.objective_id &&
      courseFixture.program_gate === fixture.program_gate,
    "course_fixture_identity_invalid",
  );
  check(
    courseFixture.authority_contract.setup_plane ===
      "world_authority_setup_only" &&
      courseFixture.authority_contract.execution_plane ===
        "player_embodiment_only" &&
      courseFixture.authority_contract.setup_receipts_acceptance_eligible ===
        false &&
      courseFixture.authority_contract.setup_authority_released_before_course ===
        true &&
      courseFixture.authority_contract.restore_before_n1 === true,
    "course_fixture_authority_boundary_invalid",
  );
  check(
    courseFixture.world_contract.dedicated_disposable_course_region_required ===
      true &&
      courseFixture.world_contract.pre_course_world_snapshot_required === true &&
      courseFixture.world_contract.restore_mode === "server_world_snapshot",
    "course_fixture_restore_boundary_invalid",
  );
  check(
    courseFixture.composition_template.path === compositionFixturePath &&
      courseFixture.composition_template.origin.x === 0 &&
      courseFixture.composition_template.origin.y === 64 &&
      courseFixture.composition_template.origin.z === 0,
    "course_fixture_composition_template_invalid",
  );
  check(
    [
      "active_nether_portal",
      "nether_dimension_checkpoint",
      "survival_resource_acquisition_checkpoint",
      "durable_goal_completion",
      "terminal_answer",
    ].every((value) => courseFixture.forbidden_setup_outputs.includes(value)),
    "course_fixture_forbidden_setup_outputs_incomplete",
  );
  check(
    coursePlanner.includes("buildNether1N0CoursePlan") &&
      coursePlanner.includes("credentials_included: false") &&
      coursePlanner.includes("setup_receipts_acceptance_eligible: false") &&
      !coursePlanner.includes("fetch(") &&
      !coursePlanner.includes("exec_command") &&
      !coursePlanner.includes("command-broker"),
    "course_fixture_planner_execution_boundary_invalid",
  );
  check(
    /^Active program gate: \*\*G8\*\*$/m.test(workProgram),
    "canonical_active_gate_not_g8",
  );
  check(
    /^\| G7 — Second-domain transfer \| closed \|/m.test(workProgram),
    "canonical_g7_not_closed",
  );
  check(
    packet.includes(
      "Program gate: G8 — Environment-harness release evaluation; post-G7 Minecraft integration lane",
    ),
    "packet_gate_header_not_reconciled",
  );
  check(
    !packet.includes("G7 remains the active prerequisite") &&
      !packet.includes("does not authorize implementation while G7 is active"),
    "packet_contains_stale_g7_blocker",
  );

  const playerCapabilities = new Set<string>(
    HELIX_MINECRAFT_PLAYER_CAPABILITY_IDS,
  );
  for (const capabilityId of fixture.required_player_capability_ids) {
    check(
      playerCapabilities.has(capabilityId),
      `player_capability_missing_from_shared_contract:${capabilityId}`,
    );
  }
  for (const capabilityId of fixture.required_fabric_manifest_capability_ids) {
    check(
      fixture.required_player_capability_ids.includes(capabilityId),
      `fabric_manifest_capability_not_in_course:${capabilityId}`,
    );
    check(
      playerRuntime.includes(`\"${capabilityId}\"`),
      `player_capability_missing_from_fabric_manifest:${capabilityId}`,
    );
  }

  const readCapabilities = new Set<string>([
    HELIX_MINECRAFT_ACTOR_STATUS_READ_CAPABILITY,
    HELIX_MINECRAFT_INVENTORY_CHECK_CAPABILITY,
    HELIX_MINECRAFT_SPATIAL_REGION_INSPECT_CAPABILITY,
    HELIX_MINECRAFT_SITUATION_DIGEST_READ_CAPABILITY,
  ]);
  for (const capabilityId of fixture.required_read_capability_ids) {
    check(
      readCapabilities.has(capabilityId),
      `read_capability_missing:${capabilityId}`,
    );
  }

  const actionKinds = new Set<string>(HELIX_MINECRAFT_PLAYER_ACTION_KINDS);
  for (const actionKind of fixture.required_action_kinds) {
    check(actionKinds.has(actionKind), `action_kind_missing:${actionKind}`);
    if (actionKinds.has(actionKind)) {
      const capabilityId = minecraftPlayerCapabilityForActionKind(
        actionKind as HelixMinecraftPlayerActionArguments["action_kind"],
      );
      check(
        fixture.required_player_capability_ids.includes(capabilityId),
        `action_capability_not_in_course:${actionKind}:${capabilityId}`,
      );
    }
  }

  const conditionKinds = new Set<string>(
    HELIX_MINECRAFT_FLUID_CONDITION_KINDS,
  );
  for (const conditionKind of fixture.required_condition_kinds) {
    check(
      conditionKinds.has(conditionKind),
      `condition_kind_missing:${conditionKind}`,
    );
  }

  const requiredCompositionIds = new Set([
    "standalone_collection",
    "furnace_smelting",
    "portal_ignition",
    "portal_dimension_transition",
  ]);
  const compositionIds = new Set<string>();
  for (const composition of fixture.required_compositions) {
    check(
      requiredCompositionIds.has(composition.composition_id),
      `composition_id_unrecognized:${composition.composition_id}`,
    );
    check(
      !compositionIds.has(composition.composition_id),
      `composition_id_duplicate:${composition.composition_id}`,
    );
    compositionIds.add(composition.composition_id);
    check(
      composition.action_kinds.length > 0,
      `composition_actions_empty:${composition.composition_id}`,
    );
    check(
      composition.condition_kinds.length > 0,
      `composition_conditions_empty:${composition.composition_id}`,
    );
    for (const actionKind of composition.action_kinds) {
      check(
        fixture.required_action_kinds.includes(actionKind),
        `composition_action_not_in_course:${composition.composition_id}:${actionKind}`,
      );
    }
    for (const conditionKind of composition.condition_kinds) {
      check(
        fixture.required_condition_kinds.includes(conditionKind),
        `composition_condition_not_in_course:${composition.composition_id}:${conditionKind}`,
      );
    }
  }
  for (const compositionId of requiredCompositionIds) {
    check(
      compositionIds.has(compositionId),
      `required_composition_missing:${compositionId}`,
    );
  }
  const executableCompositionIds = new Set<string>();
  for (const composition of compositionFixture.compositions) {
    check(
      composition.preconditions.length >= 3,
      `composition_preconditions_incomplete:${composition.composition_id}`,
    );
    const parsed = helixMinecraftFluidSequenceArgumentsSchema.safeParse(
      composition.sequence,
    );
    check(
      parsed.success,
      `composition_sequence_invalid:${composition.composition_id}:${
        parsed.success
          ? "unknown"
          : parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".")}:${issue.message}`)
            .join(";")
      }`,
    );
    if (parsed.success) executableCompositionIds.add(composition.composition_id);
  }
  for (const compositionId of [
    "furnace_smelting",
    "portal_ignition",
    "portal_dimension_transition",
  ]) {
    check(
      executableCompositionIds.has(compositionId),
      `executable_composition_missing:${compositionId}`,
    );
  }

  for (const relativePath of fixture.required_contract_files) {
    check(
      fs.existsSync(path.resolve(workspaceRoot, relativePath)),
      `required_contract_file_missing:${relativePath}`,
    );
  }

  for (const capabilityId of fixture.forbidden_capability_ids) {
    check(
      !playerCapabilities.has(capabilityId),
      `forbidden_monolithic_capability_present:${capabilityId}`,
    );
    check(
      !playerRuntime.includes(`\"${capabilityId}\"`),
      `forbidden_monolithic_fabric_capability_present:${capabilityId}`,
    );
  }
  check(
    fixture.acceptance_shortcuts_forbidden.length >= 6,
    "acceptance_shortcut_boundary_incomplete",
  );

  return {
    schema: "helix.minecraft.nether1_n0_readiness_audit.v1",
    objective_id: fixture.objective_id,
    program_gate: fixture.program_gate,
    maturity: fixture.maturity,
    checks_run: checksRun,
    capabilities_checked:
      fixture.required_player_capability_ids.length +
      fixture.required_read_capability_ids.length,
    action_kinds_checked: fixture.required_action_kinds.length,
    condition_kinds_checked: fixture.required_condition_kinds.length,
    compositions_checked: fixture.required_compositions.length,
    contract_files_checked: fixture.required_contract_files.length,
    ready_for_n0: failures.length === 0,
    failures,
    live_acceptance_claimed: false,
  };
};

const isCli =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const result = auditMinecraftNether1N0Readiness();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ready_for_n0) process.exitCode = 1;
}
