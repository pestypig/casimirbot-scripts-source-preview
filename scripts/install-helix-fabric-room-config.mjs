import { readFile, writeFile } from "node:fs/promises";

const OBSERVATION_KEYS = [
  "endpoint",
  "bearer_token",
  "source_id",
  "room_id",
  "world_id",
  "domain_adapter",
];

const parseObservationConfig = (text) => {
  const values = {};
  for (const key of OBSERVATION_KEYS) {
    const match = text.match(new RegExp(`^\\s*${key}:\\s*"([^"]+)"\\s*$`, "m"));
    if (!match) throw new Error(`Observation config is missing ${key}.`);
    values[key] = match[1];
  }
  return values;
};

const requireConnectorIdentity = (observation, command) => {
  if (observation.domain_adapter !== "minecraft.fabric_mod.v1") {
    throw new Error("The observation config is not for the Fabric adapter.");
  }
  if (!observation.bearer_token.startsWith("helix_room_src_")) {
    throw new Error("The observation credential has an unexpected token type.");
  }
  if (!command) return;
  if (!command.bearer_token?.startsWith("helix_env_cmd_")) {
    throw new Error("The command credential has an unexpected token type.");
  }
  for (const key of ["room_id", "source_id", "world_id", "domain_adapter"]) {
    if (command[key] !== observation[key]) {
      throw new Error(`Observation and command configs disagree on ${key}.`);
    }
  }
  if (
    command.command_execution_enabled !== true ||
    command.host_access_enabled !== false ||
    command.automatic_retry_enabled !== false ||
    !Number.isInteger(command.policy_version) ||
    command.policy_version < 1
  ) {
    throw new Error("The command config violates the Fabric connector safety contract.");
  }
};

export const rebaseHelixFabricCommandEndpoint = (
  endpoint,
  loopbackOrigin,
) => {
  if (!loopbackOrigin) return endpoint;
  const origin = new URL(loopbackOrigin);
  if (
    origin.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(origin.hostname)
  ) {
    throw new Error("The command endpoint override must be a loopback HTTP origin.");
  }
  const source = new URL(endpoint);
  const rebased = new URL(`${source.pathname}${source.search}`, origin);
  return rebased.toString().replace(/\/$/u, "");
};

export const installHelixFabricRuntimeConfig = async ({
  configPath,
  observationConfigText = null,
  commandConfigText = null,
  commandEndpointOrigin = null,
}) => {
  const current = JSON.parse(await readFile(configPath, "utf8"));
  const observation = observationConfigText
    ? parseObservationConfig(observationConfigText)
    : Object.fromEntries(OBSERVATION_KEYS.map((key) => [key, current[key]]));
  const commandEnvelope = commandConfigText ? JSON.parse(commandConfigText) : null;
  const suppliedCommand = commandEnvelope?.command ?? null;
  const command = suppliedCommand
    ? {
        ...suppliedCommand,
        endpoint: rebaseHelixFabricCommandEndpoint(
          suppliedCommand.endpoint,
          commandEndpointOrigin,
        ),
      }
    : null;
  requireConnectorIdentity(observation, command);

  const next = {
    ...current,
    ...observation,
    execution_enabled: false,
    ...(command ? { command } : {}),
  };
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  return {
    adapter: next.domain_adapter,
    observation_configured: true,
    command_configured: Boolean(command),
    policy_version: command?.policy_version ?? null,
    host_access_enabled: command?.host_access_enabled ?? false,
    automatic_retry_enabled: command?.automatic_retry_enabled ?? false,
  };
};
