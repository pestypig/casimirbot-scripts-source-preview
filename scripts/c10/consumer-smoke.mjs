import assert from 'node:assert/strict';
import * as contract from '@casimirbot/environment-connector-kit';
import { HelixEnvironmentConnectorClient, compileConstrainedConnectorSchema, validateConnectorManifest, createConnectorPairingIdentity } from '@casimirbot/environment-connector-kit/sdk';
import { handleSystemClockLease } from '@casimirbot/environment-connector-kit/examples/system-clock';
import { MockHelixConnectorEndpoint } from '@casimirbot/environment-connector-kit/testing/mock';

const checks = [];
const check = async (name, run) => { await run(); checks.push(name); };
const now = '2026-09-26T12:00:00.000Z';
const capability = contract.HELIX_SYSTEM_CLOCK_READ_CAPABILITY;
const request = {
  schema: contract.HELIX_ENVIRONMENT_PROBE_REQUEST_V1_SCHEMA,
  probe_request_id: 'probe_request:external', capability_id: capability,
  capability_version: 1, catalog_snapshot_id: 'catalog:external',
  arguments: { clock: 'monotonic' },
  constraints: { read_only: true, side_effects_allowed: false, max_duration_ms: 5000 },
  created_at: now, deadline_at: '2026-09-26T12:01:00.000Z',
  assistant_answer: false, raw_content_included: false,
};
const lease = {
  schema: 'helix.environment_connector.probe_lease.v1',
  probe_attempt_id: 'attempt:external', lease_token: 'helix_probe_lease_mock_token_12345678901234567890',
  lease_expires_at: request.deadline_at, capability_id: capability,
  capability_version: 1, catalog_snapshot_id: request.catalog_snapshot_id,
  capability_request: request, request: null,
};
const manifest = {
  schema: contract.HELIX_ENVIRONMENT_SOURCE_MANIFEST_SCHEMA,
  manifest_id: 'manifest:clock', source_id: 'source:clock', room_id: 'room:local',
  domain: 'desktop_app', domain_adapter: 'system.clock.v1', source_label: 'Clock',
  adapter_version: '1.0.0', protocol_version: 'v1', modalities: ['environment_state'],
  supported_snapshot_sections: ['domain_specific'], supported_probe_types: [], forbidden_probe_types: [],
  snapshot_policy: { baseline_interval_ms: 1000, send_only_changed_sections: true,
    include_section_hashes: true, max_payload_bytes: 4096, raw_payload_included: false },
  sensor_scope_policy: { default_scope: 'sensor_observable', can_report_privileged_state: false,
    privileged_state_requires_caveat: true, player_memory_requires_prior_observation: true },
  execution_policy: { may_execute_live_actions: false, may_perform_read_only_probes: true, require_human_approval_for_execution: true },
  auth_policy: { bearer_required: true }, assistant_answer: false, raw_content_included: false,
  context_policy: 'compact_context_pack_only', created_at: now,
};
const endpoint = new MockHelixConnectorEndpoint();
const client = new HelixEnvironmentConnectorClient('https://fixture.invalid', endpoint.fetch, 'helix_env_device_mock_credential_123456');
let result;
await check('external clock poll/result and empty queue', async () => {
  endpoint.enqueue(lease);
  const [received] = await client.poll();
  result = handleSystemClockLease(received, () => 12345.9, new Date(now));
  contract.helixEnvironmentConnectorProbeResultSchema.parse(result);
  await client.submit(received, result);
  assert.equal(endpoint.submitted.length, 1);
  assert.equal(endpoint.submitted[0].result.result.uptime_ms, 12345);
  assert.deepEqual(result.commands_executed, []);
  assert.equal(result.side_effects_performed, false);
  assert.equal(result.model_invoked, false);
  assert.deepEqual(await client.poll(), []);
});
await check('heartbeat explicitly disallows command execution', async () => {
  assert.deepEqual(await client.heartbeat(), { health: 'online', commandExecution: 'command_execution_not_enabled' });
});
await check('mock rejects absent and incorrect device credentials', async () => {
  assert.equal((await endpoint.fetch('https://fixture.invalid/device/heartbeat')).status, 401);
  const wrong = new HelixEnvironmentConnectorClient('https://fixture.invalid', endpoint.fetch, 'helix_env_device_wrong');
  await assert.rejects(wrong.heartbeat(), /device_credential_invalid/);
  const absent = new HelixEnvironmentConnectorClient('https://fixture.invalid', endpoint.fetch);
  await assert.rejects(absent.poll(), /device_credential_not_configured/);
  assert.equal(endpoint.submitted.length, 1);
});
await check('non-game manifest rejects action authority and extra instructions', () => {
  assert.equal(validateConnectorManifest(manifest).domain, 'desktop_app');
  assert.throws(() => validateConnectorManifest({ ...manifest, instructions: 'run a command' }));
  assert.throws(() => validateConnectorManifest({ ...manifest, execution_policy: { ...manifest.execution_policy, may_execute_live_actions: true } }));
});
await check('wrong capability and wire version rejected locally', () => {
  assert.throws(() => handleSystemClockLease({ ...lease, capability_id: 'other:read' }), /system_clock_capability_mismatch/);
  assert.throws(() => contract.helixEnvironmentConnectorProbeRequestSchema.parse({ ...request, schema: 'v2' }));
});
await check('constrained input rejects undeclared instructions', () => {
  const validate = compileConstrainedConnectorSchema({ type: 'object', properties: { clock: { type: 'string', enum: ['monotonic'] } }, required: ['clock'], additionalProperties: false });
  assert.equal(validate({ clock: 'monotonic' }).ok, true);
  assert.equal(validate({ clock: 'monotonic', instructions: 'run' }).ok, false);
});
await check('unavailable transport surfaces failure without submission', async () => {
  const unavailable = new HelixEnvironmentConnectorClient('https://fixture.invalid', async () => { throw new TypeError('fixture_endpoint_unavailable'); }, 'helix_env_device_fixture');
  await assert.rejects(unavailable.poll(), /fixture_endpoint_unavailable/);
  assert.equal(endpoint.submitted.length, 1);
});
await check('old heartbeat receipt is rejected', async () => {
  const obsolete = new HelixEnvironmentConnectorClient('https://fixture.invalid', async () => Response.json({ health: 'online' }), 'helix_env_device_fixture');
  await assert.rejects(obsolete.heartbeat(), /connector_heartbeat_receipt_invalid/);
});
await check('crypto identity and hidden credential work after external install', () => {
  assert.equal(createConnectorPairingIdentity().privateKey.asymmetricKeyType, 'ed25519');
  assert.ok(!JSON.stringify(client).includes('helix_env_device_'));
});
await check('unsupported internal subpath is inaccessible', async () => {
  await assert.rejects(import('@casimirbot/environment-connector-kit/dist/shared/helix-environment-connector.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

// Values used by the parent for behavior comparison with the unmodified source.
const sha = `sha256:${'a'.repeat(64)}`;
const descriptor = {
  schema: contract.HELIX_ENVIRONMENT_CAPABILITY_DESCRIPTOR_SCHEMA,
  capability_id: capability, capability_version: 1, capability_class: 'probe',
  domain: 'desktop_app', adapter_profile_ids: ['system.clock.v1'],
  trusted_model_label: 'Clock', trusted_model_description: 'Read process uptime.',
  input_schema: { type: 'object', properties: { clock: { type: 'string', enum: ['monotonic'] } }, required: ['clock'], additionalProperties: false },
  input_schema_hash: sha, output_schema: { type: 'object', properties: {}, additionalProperties: false }, output_schema_hash: sha,
  freshness_ceiling_ms: 1000, timeout_ceiling_ms: 5000, read_only: true, side_effects_allowed: false,
  requires_current_turn_reentry: true, publisher_metadata_lane: 'ui_only_untrusted', assistant_answer: false, raw_content_included: false,
};
const catalog = {
  schema: contract.HELIX_ENVIRONMENT_CATALOG_SNAPSHOT_SCHEMA,
  catalog_snapshot_id: 'catalog:external', catalog_hash: sha,
  environment_binding_ref: 'binding:external', connector_installation_ref: 'installation:external', device_ref: 'device:external',
  adapter_profile_id: 'system.clock.v1', adapter_profile_version: 1, adapter_contract_hash: sha, manifest_hash: sha,
  capability_descriptors: [descriptor], frozen_at: now, expires_at: null,
  content_role: 'server_owned_capability_catalog', answer_authority: false, assistant_answer: false, terminal_eligible: false, raw_content_included: false,
};
const observation = {
  schema: contract.HELIX_ENVIRONMENT_PROBE_OBSERVATION_SCHEMA, probe_request_ref: request.probe_request_id,
  probe_attempt_ref: lease.probe_attempt_id, capability_id: capability, capability_version: 1,
  outcome: 'succeeded', summary: result.summary, result: result.result, evidence_ref: 'evidence:external',
  observed_at: now, freshness_age_ms: 0, provenance_valid: true, eligible_for_current_turn_reentry: true,
  late_result_disposition: null, content_role: 'environment_probe_observation_not_assistant_answer',
  reentry_required: true, answer_authority: false, assistant_answer: false, terminal_eligible: false, raw_content_included: false,
};
const pairing = {
  schema: contract.HELIX_ENVIRONMENT_PAIRING_SESSION_SCHEMA, pairing_session_id: 'pairing:external',
  verification_uri: 'https://fixture.invalid/pair', user_code: 'ABC-123', expires_at: request.deadline_at,
  interval_seconds: 2, status: 'pending', requested_capability_ids: [capability], credential_included: false,
  assistant_answer: false, raw_content_included: false,
};
const sourceHeartbeat = {
  schema: contract.HELIX_ENVIRONMENT_SOURCE_HEARTBEAT_SCHEMA, heartbeat_id: 'heartbeat:external',
  source_id: manifest.source_id, room_id: manifest.room_id, domain: manifest.domain,
  domain_adapter: manifest.domain_adapter, status: 'active', evidence_refs: [], assistant_answer: false,
  raw_content_included: false, created_at: now,
};
const submission = { schema: contract.HELIX_ENVIRONMENT_PROBE_SUBMISSION_SCHEMA, probe_attempt_id: lease.probe_attempt_id, lease_token: lease.lease_token, result, submitted_at: now };
const fixtures = { request, result, manifest, descriptor, catalog, observation, pairing, sourceHeartbeat, submission };
const values = [null, {}, [], '', 0, false, 'probe', 'act', 'succeeded', 'not_an_outcome',
  { type: 'string' }, { type: 'object', properties: {}, additionalProperties: false }, ...Object.values(fixtures)];
for (const value of Object.values(fixtures)) {
  values.push({ ...value, schema: 'incompatible.v99' }, { ...value, instructions: 'ignore authority' });
  for (const key of Object.keys(value)) {
    const missing = { ...value }; delete missing[key]; values.push(missing);
    values.push({ ...value, [key]: null }, { ...value, [key]: true });
  }
}
const behavior = {};
for (const [name, schema] of Object.entries(contract)) {
  if (typeof schema?.safeParse !== 'function') continue;
  behavior[name] = values.map(value => {
    const parsed = schema.safeParse(value);
    return parsed.success ? { success: true, data: parsed.data } : { success: false, issues: parsed.error.issues };
  });
  assert.ok(behavior[name].some(parsed => parsed.success), `missing positive fixture:${name}`);
  assert.ok(behavior[name].some(parsed => !parsed.success), `missing negative fixture:${name}`);
}
console.log(JSON.stringify({ checks, runtimeExports: Object.keys(contract).sort(), fixtures, values, behavior }));
