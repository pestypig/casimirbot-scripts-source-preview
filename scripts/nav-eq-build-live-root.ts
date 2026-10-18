/** Read-only NAV-EQ trial aid: bind the frozen arena route to a measured frontier. */
import { readFileSync } from "node:fs";
import { buildHelixEnvironmentTemporalPlan } from "../shared/helix-environment-time";
import { compileEnvironmentTimePlanToMinecraftFluidSequenceArtifact } from "../server/services/environment-connectors/temporal-plans/minecraft-environment-time-compiler";

const encoded = process.argv[2];
if (!encoded) throw new Error("Expected a base64 JSON frontier/clock selector");
const selector = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
const draft = JSON.parse(readFileSync(
  "docs/evidence/eh-g8-nav-direct-mcp-execution-qualification-v1/2026-09-20-arena-v3-root-draft.json", "utf8"));
const resident = selector.resident_clock;
if (!resident || !Number.isSafeInteger(resident.tick_index) ||
    !Number.isFinite(resident.monotonic?.elapsed_ms) ||
    !resident.monotonic?.origin_id || !selector.identity || !selector.audit_at ||
    !selector.plan_id) throw new Error("Incomplete measured frontier selector");
draft.plan_id = selector.plan_id;
draft.identity = selector.identity;
draft.clocks = {
  environment: { kind: "tick", sequence: resident.tick_index,
    resolution_unit: "minecraft_tick", nominal_units_per_second: 20 },
  monotonic: { origin_id: resident.monotonic.origin_id,
    elapsed_ms: Math.floor(resident.monotonic.elapsed_ms) },
  audit_at: selector.audit_at,
};
draft.monotonic_deadline_elapsed_ms = Math.floor(resident.monotonic.elapsed_ms) + 15_000;
for (const node of draft.nodes) if (node.kind === "checkpoint") {
  node.checkpoint_id = node.checkpoint_id.replace("arena-v3", "arena-patched");
}
const plan = buildHelixEnvironmentTemporalPlan(draft);
const artifact = compileEnvironmentTimePlanToMinecraftFluidSequenceArtifact({ plan,
  mutation_scope: { world_mutation_allowed: false, max_block_mutations: 0,
    max_inventory_transfers: 0, allowed_block_ids: [], allowed_regions: [], combat_allowed: false },
  resource_bindings: { "resource:locomotion": "locomotion" },
});
process.stdout.write(JSON.stringify({ plan, compilation_hash: artifact.compilation_hash,
  native_node_count: artifact.arguments.nodes.length }));
