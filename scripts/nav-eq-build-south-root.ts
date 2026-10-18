/** Bind a frozen non-repeating NAV-EQ arena sweep to a measured frontier. */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { buildHelixEnvironmentTemporalPlan } from "../shared/helix-environment-time";
import { compileEnvironmentTimePlanToMinecraftFluidSequenceArtifact } from "../server/services/environment-connectors/temporal-plans/minecraft-environment-time-compiler";

const compileSelector = (encoded: string) => {
const selector = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
const protocolVersion = selector.protocol_version === "v20" ? "v20" : selector.protocol_version === "v19" ? "v19" : selector.protocol_version === "v18" ? "v18" : selector.protocol_version === "v17" ? "v17" : selector.protocol_version === "v16" ? "v16" : selector.protocol_version === "v15" ? "v15" : selector.protocol_version === "v14" ? "v14" : selector.protocol_version === "v13" ? "v13" : selector.protocol_version === "v12" ? "v12" : selector.protocol_version === "v11" ? "v11" : selector.protocol_version === "v10" ? "v10" : selector.protocol_version === "v9" ? "v9" : selector.protocol_version === "v8" ? "v8" : "v7";
const protocolFilename = protocolVersion === "v16" || protocolVersion === "v18" || protocolVersion === "v19"
  ? `2026-09-20-south-floor-return-protocol-${protocolVersion}.json`
  : `2026-09-20-south-floor-sweep-protocol-${protocolVersion}.json`;
const protocol = JSON.parse(readFileSync(
  `docs/evidence/eh-g8-nav-direct-mcp-execution-qualification-v1/${protocolFilename}`, "utf8"));
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
draft.maximum_total_units = protocol.root_max_total_ticks;
draft.monotonic_deadline_elapsed_ms = Math.floor(resident.monotonic.elapsed_ms) +
  protocol.root_monotonic_deadline_ms_after_frontier;
draft.watermarks = {
  decision_unit: protocol.root_decision_tick,
  stop_unit: protocol.root_stop_tick,
  committed_through_unit: protocol.root_stop_tick + 1,
  stabilization_node_id: "settled",
};

const checkpointTemplate = draft.nodes.find((node: any) => node.node_id === "progress");
const actionTemplate = draft.nodes.find((node: any) => node.node_id === "walk-0");
const nodes: any[] = [{
  ...structuredClone(draft.nodes.find((node: any) => node.node_id === "settled")),
  checkpoint_id: "checkpoint:south-sweep-start",
  on_satisfied_node_id: "walk-0",
}];
let cumulativeMs = 0;
protocol.root_actions.forEach((step: { direction: string; duration_ms: number }, i: number) => {
  const action = structuredClone(actionTemplate);
  action.node_id = `walk-${i}`;
  action.arguments = { action_kind: "walk", direction: step.direction,
    duration_ms: step.duration_ms, sprint: false };
  action.timing = { earliest_start_unit: 0,
    latest_start_unit: Math.ceil(cumulativeMs / 50) + 120,
    maximum_duration_units: Math.ceil(step.duration_ms / 50) + 10 };
  action.on_success_node_id = i === protocol.root_actions.length - 1
    ? (protocol.root_end_postcondition ? "end-pose" : "success") : `progress-${i}`;
  nodes.push(action);
  if (i !== protocol.root_actions.length - 1) {
    const checkpoint = structuredClone(checkpointTemplate);
    checkpoint.node_id = `progress-${i}`;
    checkpoint.checkpoint_id = `checkpoint:south-sweep-after-${i}`;
    checkpoint.on_satisfied_node_id = `walk-${i + 1}`;
    nodes.push(checkpoint);
  }
  cumulativeMs += step.duration_ms;
});
if (protocol.root_end_postcondition) {
  const endPose = structuredClone(checkpointTemplate);
  endPose.node_id = "end-pose";
  endPose.checkpoint_id = "checkpoint:south-sweep-end-pose";
  endPose.condition = {
    kind: "adapter_condition",
    condition_id: "minecraft.position_within",
    arguments: protocol.root_end_postcondition,
  };
  endPose.wait_up_to_units = 5;
  endPose.on_satisfied_node_id = "success";
  endPose.on_timeout_node_id = "failed";
  nodes.push(endPose);
}
nodes.push(...draft.nodes.filter((node: any) => node.kind === "terminal"));
draft.nodes = nodes;

const plan = buildHelixEnvironmentTemporalPlan(draft);
const artifact = compileEnvironmentTimePlanToMinecraftFluidSequenceArtifact({ plan,
  mutation_scope: { world_mutation_allowed: false, max_block_mutations: 0,
    max_inventory_transfers: 0, allowed_block_ids: [], allowed_regions: [], combat_allowed: false },
  resource_bindings: { "resource:locomotion": "locomotion" },
});
return { plan, compilation_hash: artifact.compilation_hash,
  native_node_count: artifact.arguments.nodes.length };
};

if (process.argv[2] === "--stream") {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const outputPath = join(tmpdir(), `casimir-nav-eq-root-${process.pid}.json`);
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
  if (!encoded) throw new Error("Expected a base64 JSON frontier/clock selector");
  process.stdout.write(JSON.stringify(compileSelector(encoded)));
}
