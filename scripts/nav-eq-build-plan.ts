/** Local NAV-EQ acceptance aid: validate and hash a caller-authored temporal plan. */
import { buildHelixEnvironmentTemporalPlan } from "../shared/helix-environment-time";
import { compileEnvironmentTimePlanToMinecraftFluidSequenceArtifact } from "../server/services/environment-connectors/temporal-plans/minecraft-environment-time-compiler";

const encoded = process.argv[2];
if (!encoded) throw new Error("Expected a base64-encoded JSON plan draft");
const input = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
const plan = buildHelixEnvironmentTemporalPlan(input.plan ?? input);
const artifact = compileEnvironmentTimePlanToMinecraftFluidSequenceArtifact({
  plan,
  mutation_scope: input.mutation_scope ?? {
    world_mutation_allowed: false,
    max_block_mutations: 0,
    max_inventory_transfers: 0,
    allowed_block_ids: [],
    allowed_regions: [],
    combat_allowed: false,
  },
  resource_bindings: input.resource_bindings ?? {
    "resource:locomotion": "locomotion",
  },
});
process.stdout.write(JSON.stringify({
  plan_hash: plan.plan_hash,
  compilation_hash: artifact.compilation_hash,
  plan_id: plan.plan_id,
  native_node_count: artifact.arguments.nodes.length,
}));
