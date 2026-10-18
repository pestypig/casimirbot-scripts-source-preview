/** Compile one post-observation NAV-EQ child against a verified live predecessor. */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { buildHelixEnvironmentTemporalPlan } from "../shared/helix-environment-time";
import { compileEnvironmentTimePlanToMinecraftFluidSequenceArtifact } from "../server/services/environment-connectors/temporal-plans/minecraft-environment-time-compiler";

const compileSelector = (encoded: string) => {
const selector = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
const draft = JSON.parse(readFileSync(
  "docs/evidence/eh-g8-nav-direct-mcp-execution-qualification-v1/2026-09-20-arena-v3-root-draft.json", "utf8"));
const isV16 = selector.protocol_version === "v16";
const isV17 = selector.protocol_version === "v17";
const isV18 = selector.protocol_version === "v18";
const isV19 = selector.protocol_version === "v19";
const isV20 = selector.protocol_version === "v20";
const protocol = JSON.parse(readFileSync(
  `docs/evidence/eh-g8-nav-direct-mcp-execution-qualification-v1/${isV20 ? "2026-09-20-south-floor-sweep-protocol-v20.json" : isV19 ? "2026-09-20-south-floor-return-protocol-v19.json" : isV18 ? "2026-09-20-south-floor-return-protocol-v18.json" : isV16 ? "2026-09-20-south-floor-return-protocol-v16.json" : isV17 ? "2026-09-20-south-floor-sweep-protocol-v17.json" : "2026-09-20-south-floor-sweep-protocol-v15.json"}`, "utf8"));
const resident = selector.resident_clock;
const predecessor = selector.successor_context;
const pose = selector.observed_position;
if (!resident || !Number.isSafeInteger(resident.tick_index) ||
    !Number.isFinite(resident.monotonic?.elapsed_ms) || !resident.monotonic?.origin_id ||
    !selector.identity || !selector.audit_at || !selector.plan_id ||
    !predecessor?.available || !predecessor.previous_plan_id?.startsWith(isV20 ? "nav_eq:south_sweep:v20:root:" : isV19 ? "nav_eq:south_return:v19:root:" : isV18 ? "nav_eq:south_return:v18:root:" : isV16 ? "nav_eq:south_return:v16:root:" : isV17 ? "nav_eq:south_sweep:v17:root:" : "nav_eq:south_sweep:v15:root:") ||
    !predecessor.previous_plan_hash || !predecessor.checkpoint?.event_id ||
    !predecessor.checkpoint?.checkpoint_id ||
    !Number.isFinite(pose?.x) || !Number.isFinite(pose?.z) ||
    pose.x < protocol.course_envelope_for_player_center.x_min ||
    pose.x > protocol.course_envelope_for_player_center.x_max ||
    pose.z < protocol.course_envelope_for_player_center.z_min ||
    pose.z > protocol.course_envelope_for_player_center.z_max) {
  throw new Error("Missing or out-of-envelope live successor evidence");
}
const priorClock = predecessor.predecessor_clocks;
if (priorClock?.environment?.kind !== "tick" ||
    priorClock.environment.resolution_unit !== "minecraft_tick" ||
    priorClock.monotonic?.origin_id !== resident.monotonic.origin_id) {
  throw new Error("Predecessor/resident clock mismatch");
}
const boundary = priorClock.environment.sequence +
  predecessor.predecessor_watermarks.committed_through_unit;
const earliest = Math.max(0, boundary - resident.tick_index);
if (!Number.isSafeInteger(earliest) || earliest > 500) {
  throw new Error("Predecessor committed window is not reachable in this child horizon");
}

draft.plan_id = selector.plan_id;
draft.previous_plan_id = predecessor.previous_plan_id;
draft.previous_plan_hash = predecessor.previous_plan_hash;
draft.identity = selector.identity;
draft.clocks = {
  environment: { kind: "tick", sequence: resident.tick_index,
    resolution_unit: "minecraft_tick", nominal_units_per_second: 20 },
  monotonic: { origin_id: resident.monotonic.origin_id,
    elapsed_ms: Math.floor(resident.monotonic.elapsed_ms) },
  audit_at: selector.audit_at,
};
draft.maximum_total_units = earliest + 100;
draft.monotonic_deadline_elapsed_ms = Math.floor(resident.monotonic.elapsed_ms) + 40000;
draft.watermarks = { decision_unit: earliest + 15, stop_unit: earliest + 65,
  committed_through_unit: earliest + 66, stabilization_node_id: "settled" };
const initial = structuredClone(draft.nodes.find((node: any) => node.node_id === "settled"));
initial.checkpoint_id = "checkpoint:south-child-grounded";
initial.on_satisfied_node_id = "walk-0";
const walk = structuredClone(draft.nodes.find((node: any) => node.node_id === "walk-0"));
walk.arguments = { action_kind: "walk", direction: "left", duration_ms: 500, sprint: false };
walk.preconditions = [...walk.preconditions, { kind: "adapter_condition",
  condition_id: "minecraft.position_within",
  arguments: protocol.root_end_postcondition }];
walk.timing = { earliest_start_unit: earliest, latest_start_unit: earliest + 45,
  maximum_duration_units: 20 };
walk.on_success_node_id = "success";
draft.nodes = [initial, walk, ...draft.nodes.filter((node: any) => node.kind === "terminal")];
const plan = buildHelixEnvironmentTemporalPlan(draft);
const artifact = compileEnvironmentTimePlanToMinecraftFluidSequenceArtifact({ plan,
  mutation_scope: { world_mutation_allowed: false, max_block_mutations: 0,
    max_inventory_transfers: 0, allowed_block_ids: [], allowed_regions: [], combat_allowed: false },
  resource_bindings: { "resource:locomotion": "locomotion" },
});
return { plan, compilation_hash: artifact.compilation_hash,
  native_node_count: artifact.arguments.nodes.length, earliest_start_unit: earliest,
  boundary_tick: boundary };
};

if (process.argv[2] === "--stream") {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const outputPath = join(tmpdir(), `casimir-nav-eq-child-${process.pid}.json`);
  for await (const encoded of lines) {
    try {
      const result = compileSelector(encoded);
      const serialized = JSON.stringify(result);
      writeFileSync(outputPath, serialized, "utf8");
      const encodedResult = Buffer.from(serialized, "utf8").toString("base64");
      process.stdout.write("NAV_EQ_PLAN_BEGIN\n");
      for (let i = 0; i < encodedResult.length; i += 64) {
        process.stdout.write(`${encodedResult.slice(i, i + 64)}\n`);
      }
      process.stdout.write("NAV_EQ_PLAN_END\n");
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
} else {
  const encoded = process.argv[2];
  if (!encoded) throw new Error("Expected a base64 JSON verified-successor selector");
  process.stdout.write(JSON.stringify(compileSelector(encoded)));
}
