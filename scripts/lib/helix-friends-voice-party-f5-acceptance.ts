import crypto from "node:crypto";

export const HELIX_F5_DEVICE_RECEIPT_SCHEMA =
  "helix.friends_voice_party.f5_device_acceptance_receipt.v1" as const;
export const HELIX_F5_DUAL_EXE_RECEIPT_SCHEMA =
  "helix.friends_voice_party.f5_dual_exe_acceptance_receipt.v1" as const;

export type F5CandidateType = "host" | "srflx" | "prflx" | "relay";
export type F5DeviceRole = "owner" | "friend";

export type F5DeviceAcceptanceInput = {
  runId: string;
  role: F5DeviceRole;
  deviceLabel: string;
  packageVersion: string;
  executableSha256: string;
  partyId: string;
  startedAt: string;
  endedAt: string;
  nativeReadyReceiptObserved: boolean;
  authenticatedCoordinationObserved: boolean;
  direct: {
    connected: boolean;
    localCandidateType: F5CandidateType;
    remoteCandidateType: F5CandidateType;
  };
  relay: {
    connected: boolean;
    localCandidateType: F5CandidateType;
    remoteCandidateType: F5CandidateType;
  };
  recoveryTransitions: string[];
  recoveredWithinWindow: boolean;
  cleanup: {
    microphoneTracksEnded: boolean;
    peerConnectionClosed: boolean;
    signalingPollingStopped: boolean;
    ephemeralCredentialsDisposed: boolean;
  };
};

export type F5DeviceAcceptanceReceipt = Readonly<{
  schema: typeof HELIX_F5_DEVICE_RECEIPT_SCHEMA;
  evidence_kind: "operator_attested_with_native_preflight";
  automated_media_proof: false;
  run_id: string;
  role: F5DeviceRole;
  device_label: string;
  package_version: string;
  executable_sha256: string;
  party_id_hash: string;
  started_at: string;
  ended_at: string;
  native_ready_receipt_observed: true;
  authenticated_coordination_observed: true;
  direct: Readonly<{
    policy: "all";
    connected: true;
    local_candidate_type: F5CandidateType;
    remote_candidate_type: F5CandidateType;
  }>;
  relay: Readonly<{
    policy: "relay";
    connected: true;
    local_candidate_type: "relay";
    remote_candidate_type: F5CandidateType;
  }>;
  recovery: Readonly<{
    transitions: readonly string[];
    recovered_within_window: true;
  }>;
  cleanup: Readonly<{
    microphone_tracks_ended: true;
    peer_connection_closed: true;
    signaling_polling_stopped: true;
    ephemeral_credentials_disposed: true;
  }>;
  model_visible: false;
  debug_exportable: false;
  persistable_transport_material: false;
  promotion_authority: false;
}>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REQUIRED_RECOVERY = ["connected", "degraded", "reconnecting", "active", "closed"];
const CANDIDATE_TYPES = new Set<F5CandidateType>(["host", "srflx", "prflx", "relay"]);
const TRANSITION_TYPES = new Set([
  "connected", "direct", "relayed", "degraded", "reconnecting", "active",
  "closed", "stopped", "failed",
]);

const hasExactKeys = (value: object, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
};

const assertSafe = (value: string, name: string): string => {
  const normalized = value.trim();
  if (!SAFE_ID.test(normalized)) throw new Error(`f5_${name}_invalid`);
  return normalized;
};

const assertIso = (value: string, name: string): string => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`f5_${name}_invalid`);
  return new Date(parsed).toISOString();
};

const hasOrderedTransitions = (transitions: readonly string[]): boolean => {
  let cursor = 0;
  for (const transition of transitions) {
    if (transition === REQUIRED_RECOVERY[cursor]) cursor += 1;
    if (cursor === REQUIRED_RECOVERY.length) return true;
  }
  return false;
};

export const buildF5DeviceAcceptanceReceipt = (
  input: F5DeviceAcceptanceInput,
): F5DeviceAcceptanceReceipt => {
  const startedAt = assertIso(input.startedAt, "started_at");
  const endedAt = assertIso(input.endedAt, "ended_at");
  if (Date.parse(endedAt) <= Date.parse(startedAt)) {
    throw new Error("f5_acceptance_interval_invalid");
  }
  if (!SHA256.test(input.executableSha256)) {
    throw new Error("f5_executable_sha256_invalid");
  }
  if (!input.partyId.trim() || input.partyId.length > 512 || /[\x00-\x1f\x7f]/u.test(input.partyId)) {
    throw new Error("f5_party_id_invalid");
  }
  if (input.role !== "owner" && input.role !== "friend") {
    throw new Error("f5_role_invalid");
  }
  if (
    !CANDIDATE_TYPES.has(input.direct.localCandidateType) ||
    !CANDIDATE_TYPES.has(input.direct.remoteCandidateType) ||
    !CANDIDATE_TYPES.has(input.relay.localCandidateType) ||
    !CANDIDATE_TYPES.has(input.relay.remoteCandidateType)
  ) throw new Error("f5_candidate_type_invalid");
  if (!input.nativeReadyReceiptObserved || !input.authenticatedCoordinationObserved) {
    throw new Error("f5_authenticated_native_preflight_incomplete");
  }
  if (
    !input.direct.connected ||
    input.direct.localCandidateType === "relay" ||
    input.direct.remoteCandidateType === "relay"
  ) {
    throw new Error("f5_direct_candidate_pair_not_proven");
  }
  if (!input.relay.connected || input.relay.localCandidateType !== "relay") {
    throw new Error("f5_relay_candidate_pair_not_proven");
  }
  if (!input.recoveredWithinWindow || !hasOrderedTransitions(input.recoveryTransitions)) {
    throw new Error("f5_reconnect_sequence_not_proven");
  }
  if (input.recoveryTransitions.some((transition) => !TRANSITION_TYPES.has(transition))) {
    throw new Error("f5_recovery_transition_invalid");
  }
  if (Object.values(input.cleanup).some((value) => value !== true)) {
    throw new Error("f5_cleanup_not_proven");
  }
  const partyIdHash = crypto.createHash("sha256").update(input.partyId).digest("hex");
  return Object.freeze({
    schema: HELIX_F5_DEVICE_RECEIPT_SCHEMA,
    evidence_kind: "operator_attested_with_native_preflight",
    automated_media_proof: false,
    run_id: assertSafe(input.runId, "run_id"),
    role: input.role,
    device_label: assertSafe(input.deviceLabel, "device_label"),
    package_version: assertSafe(input.packageVersion, "package_version"),
    executable_sha256: input.executableSha256,
    party_id_hash: `sha256:${partyIdHash}`,
    started_at: startedAt,
    ended_at: endedAt,
    native_ready_receipt_observed: true,
    authenticated_coordination_observed: true,
    direct: Object.freeze({
      policy: "all",
      connected: true,
      local_candidate_type: input.direct.localCandidateType,
      remote_candidate_type: input.direct.remoteCandidateType,
    }),
    relay: Object.freeze({
      policy: "relay",
      connected: true,
      local_candidate_type: "relay",
      remote_candidate_type: input.relay.remoteCandidateType,
    }),
    recovery: Object.freeze({
      transitions: Object.freeze([...input.recoveryTransitions]),
      recovered_within_window: true,
    }),
    cleanup: Object.freeze({
      microphone_tracks_ended: true,
      peer_connection_closed: true,
      signaling_polling_stopped: true,
      ephemeral_credentials_disposed: true,
    }),
    model_visible: false,
    debug_exportable: false,
    persistable_transport_material: false,
    promotion_authority: false,
  });
};

const assertDeviceReceipt = (value: unknown): F5DeviceAcceptanceReceipt => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("f5_device_receipt_invalid");
  }
  const receipt = value as F5DeviceAcceptanceReceipt;
  if (
    !hasExactKeys(receipt, [
      "schema", "evidence_kind", "automated_media_proof", "run_id", "role",
      "device_label", "package_version", "executable_sha256", "party_id_hash",
      "started_at", "ended_at", "native_ready_receipt_observed",
      "authenticated_coordination_observed", "direct", "relay", "recovery",
      "cleanup", "model_visible", "debug_exportable",
      "persistable_transport_material", "promotion_authority",
    ]) ||
    !receipt.direct || !hasExactKeys(receipt.direct, [
      "policy", "connected", "local_candidate_type", "remote_candidate_type",
    ]) ||
    !receipt.relay || !hasExactKeys(receipt.relay, [
      "policy", "connected", "local_candidate_type", "remote_candidate_type",
    ]) ||
    !receipt.recovery || !hasExactKeys(receipt.recovery, [
      "transitions", "recovered_within_window",
    ]) ||
    !receipt.cleanup || !hasExactKeys(receipt.cleanup, [
      "microphone_tracks_ended", "peer_connection_closed",
      "signaling_polling_stopped", "ephemeral_credentials_disposed",
    ]) ||
    receipt.schema !== HELIX_F5_DEVICE_RECEIPT_SCHEMA ||
    receipt.evidence_kind !== "operator_attested_with_native_preflight" ||
    receipt.automated_media_proof !== false ||
    receipt.native_ready_receipt_observed !== true ||
    receipt.authenticated_coordination_observed !== true ||
    (receipt.role !== "owner" && receipt.role !== "friend") ||
    !SAFE_ID.test(receipt.run_id) || !SAFE_ID.test(receipt.device_label) ||
    !SAFE_ID.test(receipt.package_version) ||
    receipt.direct?.connected !== true || receipt.direct.policy !== "all" ||
    !CANDIDATE_TYPES.has(receipt.direct.local_candidate_type) ||
    !CANDIDATE_TYPES.has(receipt.direct.remote_candidate_type) ||
    receipt.direct.local_candidate_type === "relay" ||
    receipt.direct.remote_candidate_type === "relay" ||
    receipt.relay?.connected !== true || receipt.relay.policy !== "relay" ||
    receipt.relay.local_candidate_type !== "relay" ||
    !CANDIDATE_TYPES.has(receipt.relay.remote_candidate_type) ||
    receipt.recovery?.recovered_within_window !== true ||
    !hasOrderedTransitions(receipt.recovery.transitions) ||
    receipt.recovery.transitions.some((transition) => !TRANSITION_TYPES.has(transition)) ||
    receipt.cleanup?.microphone_tracks_ended !== true ||
    receipt.cleanup.peer_connection_closed !== true ||
    receipt.cleanup.signaling_polling_stopped !== true ||
    receipt.cleanup.ephemeral_credentials_disposed !== true ||
    receipt.model_visible !== false || receipt.debug_exportable !== false ||
    receipt.persistable_transport_material !== false ||
    receipt.promotion_authority !== false ||
    !Number.isFinite(Date.parse(receipt.started_at)) ||
    !Number.isFinite(Date.parse(receipt.ended_at)) ||
    Date.parse(receipt.ended_at) <= Date.parse(receipt.started_at) ||
    !SHA256.test(receipt.executable_sha256) ||
    !/^sha256:[a-f0-9]{64}$/u.test(receipt.party_id_hash)
  ) {
    throw new Error("f5_device_receipt_invalid");
  }
  return receipt;
};

export const verifyF5DualExeAcceptance = (
  first: unknown,
  second: unknown,
) => {
  const receipts = [assertDeviceReceipt(first), assertDeviceReceipt(second)];
  const roles = new Set(receipts.map((receipt) => receipt.role));
  if (roles.size !== 2 || !roles.has("owner") || !roles.has("friend")) {
    throw new Error("f5_dual_exe_roles_invalid");
  }
  if (new Set(receipts.map((receipt) => receipt.device_label)).size !== 2) {
    throw new Error("f5_distinct_devices_not_proven");
  }
  for (const field of ["run_id", "package_version", "executable_sha256", "party_id_hash"] as const) {
    if (receipts[0][field] !== receipts[1][field]) {
      throw new Error(`f5_dual_exe_${field}_mismatch`);
    }
  }
  return Object.freeze({
    schema: HELIX_F5_DUAL_EXE_RECEIPT_SCHEMA,
    ok: true,
    evidence_kind: "paired_operator_attestation_with_native_preflight",
    run_id: receipts[0].run_id,
    package_version: receipts[0].package_version,
    executable_sha256: receipts[0].executable_sha256,
    party_id_hash: receipts[0].party_id_hash,
    device_labels: Object.freeze(receipts.map((receipt) => receipt.device_label).sort()),
    direct_candidate_pair_proven: true,
    relay_candidate_pair_proven: true,
    reconnect_and_cleanup_attested: true,
    automated_media_proof: false,
    physical_acceptance_candidate: true,
    live_accepted: false,
    promotion_authority: false,
    model_visible: false,
    debug_exportable: false,
  });
};
