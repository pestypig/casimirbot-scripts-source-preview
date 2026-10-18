/** Read-only, metadata-only comparison of a retained plan and its workflow events. */
import { readFileSync } from "node:fs";

const [snapshotPath, planId] = process.argv.slice(2);
if (!snapshotPath || !planId) throw new Error("Expected snapshot path and plan ID");
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const rows = (name: string): any[] => snapshot.tables[name] ?? [];
const json = (value: unknown): any => typeof value === "string" ? JSON.parse(value) : value;
const admission = rows("helix_environment_temporal_plan_admissions").find(row => row.plan_id === planId);
if (!admission) throw new Error("Plan admission not found");
const plan = json(admission.source_plan);
const action = rows("helix_environment_action_requests").find(row =>
  row.action_request_id === admission.resident_action_request_id);
if (!action) throw new Error("Resident action not found");
const actionPayload = json(action.request_payload);
const identity = plan.identity;
const goal = rows("helix_environment_durable_goals").find(row => row.goal_id === identity.goal_id);
if (!goal) throw new Error("Durable goal not found");
const goalEvents = rows("helix_environment_durable_goal_events")
  .filter(row => row.goal_id === identity.goal_id)
  .map(row => ({ sequence: row.sequence, occurred_at: row.occurred_at,
    producer_epoch_matches: row.producer_epoch_ref === identity.producer_epoch,
    room_matches: row.room_id === goal.room_id, world_matches: row.world_id === goal.world_id,
    event_kind: row.event_kind }));
const batches = new Map(rows("helix_environment_event_batches")
  .map(row => [row.batch_id, row]));
const entries = rows("helix_environment_events")
  .filter(row => row.workflow_ref === actionPayload.workflow_id)
  .sort((a, b) => a.sequence - b.sequence)
  .map(row => {
    const payload = json(row.event_payload);
    const batch = batches.get(row.batch_id);
    const conditions = {
      environment_binding_id: row.environment_binding_id === identity.environment_id,
      producer_epoch_ref: row.producer_epoch_ref === identity.producer_epoch,
      source_id: batch?.source_id === identity.source_id,
      event_source_id: payload?.source_id === identity.source_id,
      subject_ref: row.subject_ref === identity.subject_id,
      room_id: batch?.room_id === goal.room_id && payload?.room_id === goal.room_id,
      world_id: batch?.world_id === goal.world_id && payload?.world_id === goal.world_id,
      producer_plane: row.producer_plane === "player_embodiment",
      batch_epoch: batch?.producer_epoch_ref === row.producer_epoch_ref,
      batch_environment: batch?.environment_binding_id === row.environment_binding_id,
      batch_plane: batch?.producer_plane === row.producer_plane,
    };
    return {
      event_id: row.event_id,
      sequence: row.sequence,
      observed_at: row.observed_at,
      mismatch_fields: Object.entries(conditions).filter(([, matches]) => !matches).map(([field]) => field),
      event_payload_omits_batch_room_world: payload?.room_id === undefined && payload?.world_id === undefined,
      identity_room_world: row.sequence === 20 ? {
        goal_room_id: goal.room_id, goal_world_id: goal.world_id,
        plan_source_id: identity.source_id, event_source_id: payload?.source_id ?? null,
        event_room_id: payload?.room_id ?? null, event_world_id: payload?.world_id ?? null,
        batch_room_id: batch?.room_id ?? null, batch_world_id: batch?.world_id ?? null,
      } : undefined,
      checkpoint_count: payload?.attributes?.workflow_measurements?.checkpoint_settlements?.length ?? 0,
      native_plan_match: payload?.attributes?.workflow_measurements?.sequence_id ===
        json(admission.compilation_artifact)?.arguments?.sequence_id,
    };
  });
const actionEvents = rows("helix_environment_action_workflow_events")
  .filter(row => row.workflow_id === actionPayload.workflow_id)
  .sort((a, b) => a.sequence - b.sequence)
  .map(row => ({ sequence: row.sequence, created_at: row.created_at, event_type: row.event_type }));
const heartbeats = rows("helix_environment_action_connector_heartbeats")
  .filter(row => row.action_authority_id === identity.authority_id &&
    Date.parse(row.received_at) >= Date.parse(actionEvents[0]?.created_at ?? "") - 5_000 &&
    Date.parse(row.received_at) <= Date.parse(actionEvents.at(-1)?.created_at ?? "") + 5_000)
  .sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at))
  .map(row => ({ received_at: row.received_at, created_at: row.created_at,
    status: row.status, latest_event_sequence: row.latest_event_sequence,
    native_last_error: json(row.control_engines)?.find((engine: any) =>
      engine.control_engine === "native_fabric")?.last_error ?? null }));
const authorityHeartbeatRows = rows("helix_environment_action_connector_heartbeats")
  .filter(row => row.action_authority_id === identity.authority_id);
const nearestHeartbeats = [...authorityHeartbeatRows]
  .sort((a, b) => Math.abs(Date.parse(a.received_at) - Date.parse(actionEvents[0]?.created_at ?? "")) -
    Math.abs(Date.parse(b.received_at) - Date.parse(actionEvents[0]?.created_at ?? "")))
  .slice(0, 5)
  .sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at))
  .map(row => ({ received_at: row.received_at, status: row.status,
    latest_event_sequence: row.latest_event_sequence,
    native_last_error: json(row.control_engines)?.find((engine: any) =>
      engine.control_engine === "native_fabric")?.last_error ?? null }));
const frontiers = rows("helix_environment_temporal_frontiers")
  .filter(row => row.goal_id === identity.goal_id)
  .map(row => {
    const createdAt = Date.parse(row.created_at);
    const candidates = entries.filter(event => event.mismatch_fields.length === 0 &&
      Date.parse(event.observed_at) <= createdAt && Date.parse(event.observed_at) > createdAt - 5_000);
    return { frontier_id: row.frontier_id, observed_at: row.observed_at,
      created_at: row.created_at, matching_archived_events_in_five_seconds_at_create: candidates.length,
      newest_matching_event_at_create: candidates.at(-1)?.observed_at ?? null };
  });
console.log(JSON.stringify({ plan_id: planId, workflow_id: actionPayload.workflow_id,
  goal_id: identity.goal_id, run_id: actionPayload.run_id, events: entries,
  action_events: actionEvents,
  heartbeat_table_present: Object.hasOwn(snapshot.tables, "helix_environment_action_connector_heartbeats"),
  heartbeat_row_count: rows("helix_environment_action_connector_heartbeats").length,
  authority_heartbeat_row_count: authorityHeartbeatRows.length,
  authority_heartbeat_last_received_at: authorityHeartbeatRows.at(-1)?.received_at ?? null,
  heartbeats, nearest_heartbeats: nearestHeartbeats, goal_events: goalEvents, frontiers }, null, 2));
