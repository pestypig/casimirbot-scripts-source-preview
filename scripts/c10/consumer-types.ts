import {
  type HelixEnvironmentSourceManifest,
  type HelixEnvironmentSourceHeartbeat,
  type HelixEnvironmentConnectorProbeResult,
  HELIX_SYSTEM_CLOCK_READ_CAPABILITY,
} from '@casimirbot/environment-connector-kit';
import { HelixEnvironmentConnectorClient, type ConnectorLease } from '@casimirbot/environment-connector-kit/sdk';
import { handleSystemClockLease } from '@casimirbot/environment-connector-kit/examples/system-clock';
import { runReadOnlyConnectorOnce } from '@casimirbot/environment-connector-kit/templates/read-only';

export function read(lease: ConnectorLease): HelixEnvironmentConnectorProbeResult {
  return handleSystemClockLease(lease);
}
export const useClient = (client: HelixEnvironmentConnectorClient) => runReadOnlyConnectorOnce(client);
export const domain = (manifest: HelixEnvironmentSourceManifest) => manifest.domain;
export const heartbeat = (value: HelixEnvironmentSourceHeartbeat) => value.source_id;
export const capability: string = HELIX_SYSTEM_CLOCK_READ_CAPABILITY;
// @ts-expect-error Deferred symbols must not become package exports.
import { HELIX_MINECRAFT_INVENTORY_CHECK_CAPABILITY } from '@casimirbot/environment-connector-kit';
// @ts-expect-error Private package internals are not supported entry points.
import {} from '@casimirbot/environment-connector-kit/dist/shared/helix-environment-connector.js';
