/** Read-only replay of one packaged local snapshot's checkpoint pair at a cutoff. */
import { readFileSync } from "node:fs";
import { readTemporalCheckpointEvidence } from "../server/services/environment-connectors/temporal-plans/temporal-checkpoint-evidence";

const [snapshotPath, planId, cutoff] = process.argv.slice(2);
if (!snapshotPath || !planId || !cutoff) throw new Error("Expected snapshot path, plan ID and ISO cutoff");
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const rows = (name: string): any[] => snapshot.tables[name] ?? [];
const json = (value: unknown): any => typeof value === "string" ? JSON.parse(value) : value;
const admission = rows("helix_environment_temporal_plan_admissions").find(row => row.plan_id === planId);
if (!admission) throw new Error("Plan admission not found");
const plan = json(admission.source_plan);
const compilation = json(admission.compilation_artifact);
const action = rows("helix_environment_action_requests").find(row => row.action_request_id === admission.resident_action_request_id);
if (!action) throw new Error("Resident action not found");
const actionPayload = json(action.request_payload);
const events = rows("helix_environment_events").filter(row => row.workflow_ref === actionPayload.workflow_id &&
  row.producer_epoch_ref === plan.identity.producer_epoch && Date.parse(row.observed_at) <= Date.parse(cutoff));
const actionEvents = rows("helix_environment_action_workflow_events").filter(row =>
  row.action_request_id === admission.resident_action_request_id && row.workflow_id === actionPayload.workflow_id &&
  Date.parse(row.created_at) <= Date.parse(cutoff));
const latest = [...events].sort((a, b) => b.sequence - a.sequence)[0];
const latestAction = [...actionEvents].sort((a, b) => b.sequence - a.sequence)[0];
if (!latest || !latestAction) throw new Error("No paired event at cutoff");
const latestPayload = json(latest.event_payload);
const sourceIds = new Set(plan.nodes.filter((node: any) => node.kind === "checkpoint").map((node: any) => node.checkpoint_id));
const checkpoint = latestPayload.attributes.workflow_measurements.checkpoint_settlements
  .filter((settlement: any) => sourceIds.has(settlement.checkpoint_id)).at(-1);
if (!checkpoint) throw new Error("No source checkpoint at cutoff");
const query = async (sql: string, args: unknown[] = []) => {
  if (sql.includes("FROM helix_environment_temporal_plan_admissions")) return { rows: [admission] };
  if (sql.includes("FROM helix_environment_action_requests")) return { rows: [action] };
  if (sql.includes("FROM helix_environment_action_workflow_events")) {
    return { rows: sql.includes("event_id=$3")
      ? actionEvents.filter(row => row.event_id === args[2]).slice(0, 1)
      : [latestAction] };
  }
  if (sql.includes("FROM helix_environment_events")) {
    if (sql.includes("sequence<=$4")) return { rows: [...events].filter(row => row.sequence <= Number(args[3]))
      .sort((a, b) => b.sequence - a.sequence).slice(0, 256) };
    if (sql.includes("event_id=$1")) return { rows: events.filter(row => row.event_id === args[0]).slice(0, 1) };
    return { rows: [latest] };
  }
  throw new Error(`Unexpected query: ${sql.slice(0, 100)}`);
};
try {
  const result = await readTemporalCheckpointEvidence({ query } as never, {
    plan, compilation, actionRequestId: admission.action_request_id,
    eventId: latest.event_id, checkpointId: checkpoint.checkpoint_id, runId: actionPayload.run_id,
  });
  console.log(JSON.stringify({ cutoff, result: "verified", latest_environment_sequence: latest.sequence,
    latest_action_sequence: latestAction.sequence, checkpoint_id: result.checkpoint_id }));
} catch (error) {
  console.log(JSON.stringify({ cutoff, result: "rejected", latest_environment_sequence: latest.sequence,
    latest_action_sequence: latestAction.sequence, error_code: error instanceof Error ? error.message : String(error) }));
}
