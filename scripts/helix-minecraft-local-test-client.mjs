#!/usr/bin/env node

import path from "node:path";
import { createRequire } from "node:module";

const [
  moduleRoot,
  host = "127.0.0.1",
  portValue = "25565",
  username = "HelixRoomTester",
  version = "1.21.8",
] = process.argv.slice(2);

if (!moduleRoot) {
  throw new Error("minecraft_protocol_module_root_required");
}

const requireFromRuntime = createRequire(
  path.join(path.resolve(moduleRoot), "package.json"),
);
const minecraftProtocol = requireFromRuntime("minecraft-protocol");
const port = Number.parseInt(portValue, 10);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error("minecraft_server_port_invalid");
}

const client = minecraftProtocol.createClient({
  host,
  port,
  username,
  version,
  auth: "offline",
  hideErrors: true,
});

let admitted = false;
let configurationPacketCount = 0;

client.once("connect", () => {
  process.stdout.write(
    `${JSON.stringify({
      event: "minecraft_test_client_connected",
      host,
      port,
    })}\n`,
  );
});

client.on("state", (state) => {
  process.stdout.write(
    `${JSON.stringify({
      event: "minecraft_test_client_state",
      state: typeof state === "string" ? state : "unknown",
    })}\n`,
  );
});

client.on("packet", (_packet, metadata) => {
  if (
    client.state !== "configuration" ||
    configurationPacketCount >= 64 ||
    typeof metadata?.name !== "string"
  ) {
    return;
  }
  configurationPacketCount += 1;
  process.stdout.write(
    `${JSON.stringify({
      event: "minecraft_test_client_configuration_packet",
      packet: metadata.name,
    })}\n`,
  );
});

// Vanilla 1.21.8 can issue a configuration-state ping before registry data.
// minecraft-protocol 1.66.2 does not yet answer that packet for clients.
client.on("ping", (packet) => {
  if (client.state === "configuration" && Number.isInteger(packet?.id)) {
    client.write("pong", { id: packet.id });
  }
});

client.once("login", () => {
  admitted = true;
  process.stdout.write(
    `${JSON.stringify({
      event: "minecraft_test_client_login",
      username,
      host,
      port,
      version,
      auth: "offline_loopback_only",
    })}\n`,
  );
  setTimeout(() => {
    client.write("client_command", { actionId: 0 });
  }, 250);
});

client.on("death_combat_event", () => {
  client.write("client_command", { actionId: 0 });
  process.stdout.write(
    `${JSON.stringify({
      event: "minecraft_test_client_respawn_requested",
      username,
    })}\n`,
  );
});

client.once("error", (error) => {
  process.stderr.write(
    `${JSON.stringify({
      event: "minecraft_test_client_error",
      code:
        typeof error?.code === "string"
          ? error.code
          : "minecraft_test_client_error",
    })}\n`,
  );
  if (!admitted) process.exitCode = 1;
});

client.once("end", (reason) => {
  process.stdout.write(
    `${JSON.stringify({
      event: "minecraft_test_client_end",
      reason: typeof reason === "string" ? reason.slice(0, 120) : "ended",
    })}\n`,
  );
});

const close = () => {
  try {
    client.end("local_test_complete");
  } finally {
    setTimeout(() => process.exit(0), 250).unref();
  }
};

process.once("SIGINT", close);
process.once("SIGTERM", close);
