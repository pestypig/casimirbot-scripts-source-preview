import assert from 'node:assert/strict';
import test from 'node:test';
import { ledger, selectedClosure } from './build-local-kit.mjs';

test('selected closure retains transitive types but excludes unrelated private declarations', () => {
  const { files, selected } = selectedClosure();
  assert.equal(selected.length, 43);
  assert.match(files['shared/helix-environment-state-snapshot.ts'], /HelixEnvironmentDomain/);
  assert.doesNotMatch(files['shared/helix-environment-state-snapshot.ts'], /EnvironmentPosition|STATE_SNAPSHOT_SCHEMA/);
  assert.match(files['shared/helix-environment-sensor-scope.ts'], /isHelixEnvironmentSensorScope/);
  assert.doesNotMatch(files['shared/helix-environment-sensor-scope.ts'], /SCOPE_POLICIES/);
  assert.equal(files['shared/helix-environment-adapter-profile.ts'], undefined);
  for (const row of ledger().filter(row => row.candidate === 'defer'))
    assert.ok(!Object.values(files).join('\n').includes(row.symbol), row.symbol);
});
test('missing selected export fails instead of emitting a partial package', () => {
  const rows = ledger(); rows[0].symbol = 'DOES_NOT_EXIST';
  assert.throws(() => selectedClosure(rows), /selected_export_missing/);
});
test('expanded public ledger requires a new boundary decision', () => {
  const rows = ledger(); rows.find(row => row.candidate === 'defer').candidate = 'include';
  assert.throws(() => selectedClosure(rows), /expected_exactly_43/);
});
