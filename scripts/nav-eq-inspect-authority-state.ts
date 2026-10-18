/** Read-only, metadata-only inspection of one local authority handoff. */
import { readFileSync } from "node:fs";

const [snapshotPath, environmentId, participantId] = process.argv.slice(2);
if (!snapshotPath || !environmentId || !participantId) {
  throw new Error("Expected snapshot path, environment binding ID and participant ID");
}
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const rows = (name: string): any[] => snapshot.tables[name] ?? [];
const authorities = rows("helix_environment_action_authorities")
  .filter(row => row.environment_binding_id === environmentId && row.participant_id === participantId)
  .map(row => ({ id: row.action_authority_id, status: row.status,
    policy_version: row.policy_version, expires_at: row.expires_at,
    domain_adapter: row.domain_adapter, adapter_profile_id: row.adapter_profile_id,
    subject_binding_id: row.subject_binding_id, created_at: row.created_at,
    revoked_at: row.revoked_at }));
const environment = rows("helix_environment_connector_bindings")
  .find(row => row.environment_binding_id === environmentId);
const sourceBinding = rows("helix_room_source_bindings")
  .find(row => row.binding_id === environment?.room_source_binding_id);
const adapterAdmission = rows("helix_environment_adapter_admissions")
  .find(row => row.admission_id === environment?.adapter_admission_id);
const room = rows("helix_shared_realtime_rooms")
  .find(row => row.room_id === environment?.room_id);
const subjects = rows("helix_room_environment_subject_bindings")
  .filter(row => row.environment_binding_id === environmentId && row.participant_id === participantId)
  .map(row => ({ id: row.subject_binding_id, status: row.status,
    producer_epoch_ref: row.producer_epoch_ref, verified_at: row.verified_at,
    revoked_at: row.revoked_at }));
const requests = rows("helix_environment_action_requests")
  .filter(row => authorities.some(authority => authority.id === row.action_authority_id));
const byStatus = requests.reduce((counts: Record<string, number>, row: any) => {
  counts[row.status] = (counts[row.status] ?? 0) + 1;
  return counts;
}, {});
const priorId = authorities.find(row => row.status === "active")?.id;
const priorCredentials = rows("helix_environment_action_connector_credentials")
  .filter(row => row.action_authority_id === priorId)
  .reduce((counts: Record<string, number>, row: any) => {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  }, {});
const priorManifests = rows("helix_environment_action_connector_manifests")
  .filter(row => row.action_authority_id === priorId)
  .reduce((counts: Record<string, number>, row: any) => {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  }, {});
console.log(JSON.stringify({ environment: {
  binding_status: environment?.status ?? null, source_binding_status: sourceBinding?.status ?? null,
  adapter_admission_status: adapterAdmission?.status ?? null,
  adapter_profile_id: adapterAdmission?.adapter_profile_id ?? null,
  room_status: room?.status ?? null,
}, authorities, subjects, action_request_status_counts: byStatus,
  active_stored_authority_credential_status_counts: priorCredentials,
  active_stored_authority_manifest_status_counts: priorManifests }, null, 2));
