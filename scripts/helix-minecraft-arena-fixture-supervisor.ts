#!/usr/bin/env node

import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export type ArenaReadiness = {
  action_authority_id?: string;
  ready_for_actions?: boolean;
  heartbeat_fresh?: boolean;
  active_workflow_count?: number;
  controls_asserted?: boolean;
};

export type ArenaFixture = {
  schema: "helix.minecraft.arena_fixture.v1";
  fixture_id: string;
  setup_commands: string[];
  release_commands: string[];
  cleanup_commands: string[];
};

export type SupervisorEvent = {
  event:
    | "fixture_staged"
    | "workflow_admission_confirmed"
    | "fixture_released"
    | "containment_triggered"
    | "fixture_cleaned"
    | "supervisor_complete";
  at: string;
  fixture_id: string;
  reason?: string;
  active_workflow_count?: number;
  controls_asserted?: boolean;
};

export type SupervisorOptions = {
  actionAuthorityId: string;
  fixture: ArenaFixture;
  readReadiness: () => Promise<ArenaReadiness[]>;
  executeCommands: (commands: readonly string[]) => Promise<void>;
  emit?: (event: SupervisorEvent) => void;
  pollIntervalMs?: number;
  admissionTimeoutMs?: number;
  activeTimeoutMs?: number;
  requiredEligibleSamples?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
};

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const fail = (code: string): never => {
  throw new Error(code);
};

const requireString = (value: unknown, code: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
};

const requireStringArray = (value: unknown, code: string): string[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error(code);
  return value.map((entry) => {
    const command = requireString(entry, code);
    if (Buffer.byteLength(command, "utf8") > 2_048) fail(code);
    return command;
  });
};

export const parseArenaFixture = (value: unknown): ArenaFixture => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("arena_fixture_invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== "helix.minecraft.arena_fixture.v1") {
    fail("arena_fixture_schema_invalid");
  }
  return {
    schema: "helix.minecraft.arena_fixture.v1",
    fixture_id: requireString(record.fixture_id, "arena_fixture_id_missing"),
    setup_commands: requireStringArray(
      record.setup_commands,
      "arena_fixture_setup_commands_invalid",
    ),
    release_commands: requireStringArray(
      record.release_commands,
      "arena_fixture_release_commands_invalid",
    ),
    cleanup_commands: requireStringArray(
      record.cleanup_commands,
      "arena_fixture_cleanup_commands_invalid",
    ),
  };
};

export const parseServerProperties = (contents: string) => {
  const properties = new Map<string, string>();
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    properties.set(
      trimmed.slice(0, separator).trim(),
      trimmed.slice(separator + 1).trim(),
    );
  }
  return properties;
};

export const parseStdinReadinessLine = (contents: string): ArenaReadiness[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    fail("arena_readiness_line_json_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("arena_readiness_line_invalid");
  }
  const candidates = (parsed as Record<string, unknown>).connector_readiness;
  if (!Array.isArray(candidates)) {
    throw new Error("arena_readiness_line_entries_invalid");
  }
  return candidates.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      fail("arena_readiness_line_entry_invalid");
    }
    const entry = candidate as Record<string, unknown>;
    return {
      action_authority_id:
        typeof entry.action_authority_id === "string"
          ? entry.action_authority_id
          : undefined,
      ready_for_actions: entry.ready_for_actions === true,
      heartbeat_fresh: entry.heartbeat_fresh === true,
      active_workflow_count:
        typeof entry.active_workflow_count === "number" &&
        Number.isFinite(entry.active_workflow_count)
          ? entry.active_workflow_count
          : 0,
      controls_asserted: entry.controls_asserted === true,
    };
  });
};

export const parseLocalPlayerRuntimeStatus = (
  contents: string,
  nowMs = Date.now(),
): ArenaReadiness[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    fail("arena_local_player_status_json_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("arena_local_player_status_invalid");
  }
  const status = parsed as Record<string, unknown>;
  if (status.schema !== "helix.minecraft.player_local_runtime_status.v1") {
    fail("arena_local_player_status_schema_invalid");
  }
  const authorityId = requireString(
    status.action_authority_id,
    "arena_local_player_status_authority_missing",
  );
  const updatedAtMs = Date.parse(String(status.updated_at ?? ""));
  const heartbeatAtMs = Date.parse(
    String(status.last_heartbeat_accepted_at ?? ""),
  );
  const statusFresh =
    Number.isFinite(updatedAtMs) &&
    nowMs - updatedAtMs >= -5_000 &&
    nowMs - updatedAtMs <= 2_000;
  const heartbeatFresh =
    Number.isFinite(heartbeatAtMs) &&
    nowMs - heartbeatAtMs >= -5_000 &&
    nowMs - heartbeatAtMs <= 30_000;
  const workflowId =
    typeof status.active_workflow_id === "string" &&
    status.active_workflow_id.trim()
      ? status.active_workflow_id.trim()
      : null;
  const safe =
    status.ready_for_actions === true &&
    statusFresh &&
    heartbeatFresh &&
    status.emergency_stop_latched !== true &&
    status.manual_input_detected !== true;
  return [{
    action_authority_id: authorityId,
    ready_for_actions: safe,
    heartbeat_fresh: heartbeatFresh && statusFresh,
    active_workflow_count: workflowId ? 1 : 0,
    controls_asserted: status.controls_asserted === true,
  }];
};

const eligibleReadiness = (
  readiness: ArenaReadiness,
  actionAuthorityId: string,
) =>
  readiness.action_authority_id === actionAuthorityId &&
  readiness.ready_for_actions === true &&
  readiness.heartbeat_fresh === true &&
  Number(readiness.active_workflow_count ?? 0) > 0;

export async function runArenaFixtureSupervisor(
  options: SupervisorOptions,
): Promise<void> {
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 250);
  const admissionTimeoutMs = Math.max(1, options.admissionTimeoutMs ?? 90_000);
  const activeTimeoutMs = Math.max(1, options.activeTimeoutMs ?? 90_000);
  const requiredEligibleSamples = Math.max(
    2,
    options.requiredEligibleSamples ?? 2,
  );
  const emit = options.emit ?? (() => undefined);
  const fixtureId = options.fixture.fixture_id;
  const event = (
    name: SupervisorEvent["event"],
    detail: Omit<SupervisorEvent, "event" | "at" | "fixture_id"> = {},
  ) => emit({ event: name, at: new Date(now()).toISOString(), fixture_id: fixtureId, ...detail });

  let released = false;
  let containmentReason = "normal_terminal";
  try {
    await options.executeCommands(options.fixture.setup_commands);
    event("fixture_staged");

    const admissionDeadline = now() + admissionTimeoutMs;
    let eligibleSamples = 0;
    let admitted: ArenaReadiness | undefined;
    while (now() < admissionDeadline) {
      if (options.signal?.aborted) fail("arena_supervisor_aborted");
      const readiness = await options.readReadiness();
      const exact = readiness.find(
        (entry) => entry.action_authority_id === options.actionAuthorityId,
      );
      if (exact && eligibleReadiness(exact, options.actionAuthorityId)) {
        eligibleSamples += 1;
        admitted = exact;
        if (eligibleSamples >= requiredEligibleSamples) break;
      } else {
        eligibleSamples = 0;
        admitted = undefined;
      }
      await wait(pollIntervalMs);
    }
    if (!admitted || eligibleSamples < requiredEligibleSamples) {
      fail("arena_workflow_admission_timeout");
    }
    event("workflow_admission_confirmed", {
      active_workflow_count: Number(admitted.active_workflow_count ?? 0),
      controls_asserted: admitted.controls_asserted === true,
    });

    await options.executeCommands(options.fixture.release_commands);
    released = true;
    event("fixture_released");

    const activeDeadline = now() + activeTimeoutMs;
    while (now() < activeDeadline) {
      if (options.signal?.aborted) {
        containmentReason = "operator_abort";
        break;
      }
      const readiness = await options.readReadiness();
      const exact = readiness.find(
        (entry) => entry.action_authority_id === options.actionAuthorityId,
      );
      if (!exact) {
        containmentReason = "authority_projection_missing";
        break;
      }
      if (exact.ready_for_actions !== true || exact.heartbeat_fresh !== true) {
        containmentReason = "connector_not_fresh";
        break;
      }
      if (Number(exact.active_workflow_count ?? 0) <= 0) {
        containmentReason = "workflow_inactive";
        break;
      }
      await wait(pollIntervalMs);
    }
    if (now() >= activeDeadline) containmentReason = "active_deadline_reached";
    event("containment_triggered", { reason: containmentReason });
  } catch (error) {
    containmentReason = error instanceof Error ? error.message : "unknown_failure";
    event("containment_triggered", { reason: containmentReason });
    throw error;
  } finally {
    await options.executeCommands(options.fixture.cleanup_commands);
    event("fixture_cleaned", { reason: containmentReason });
    event("supervisor_complete", {
      reason: released ? containmentReason : `unreleased:${containmentReason}`,
    });
  }
}

type RconPacket = { id: number; type: number; body: string };

export const encodeRconPacket = (id: number, type: number, body: string) => {
  const bodyBytes = Buffer.from(body, "utf8");
  const packet = Buffer.allocUnsafe(4 + 4 + 4 + bodyBytes.length + 2);
  packet.writeInt32LE(packet.length - 4, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  bodyBytes.copy(packet, 12);
  packet.writeInt16LE(0, packet.length - 2);
  return packet;
};

class RconClient {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private packets: RconPacket[] = [];
  private waiter: (() => void) | null = null;
  private nextId = 1;

  constructor(
    private readonly port: number,
    private readonly password: string,
    private readonly timeoutMs = 5_000,
  ) {}

  async connect() {
    this.socket = net.createConnection({ host: "127.0.0.1", port: this.port });
    this.socket.on("data", (chunk) => this.onData(chunk));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("rcon_connect_timeout")), this.timeoutMs);
      this.socket?.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket?.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const response = await this.request(3, this.password);
    if (response.id === -1) fail("rcon_authentication_failed");
  }

  async command(command: string) {
    await this.request(2, command);
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0);
      if (length < 10 || length > 4 * 1024 * 1024) {
        this.socket?.destroy(new Error("rcon_packet_length_invalid"));
        return;
      }
      if (this.buffer.length < length + 4) return;
      const packet = this.buffer.subarray(0, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      this.packets.push({
        id: packet.readInt32LE(4),
        type: packet.readInt32LE(8),
        body: packet.subarray(12, packet.length - 2).toString("utf8"),
      });
      this.waiter?.();
      this.waiter = null;
    }
  }

  private async request(type: number, body: string) {
    if (!this.socket) fail("rcon_not_connected");
    const id = this.nextId++;
    this.socket.write(encodeRconPacket(id, type, body));
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const index = this.packets.findIndex((packet) => packet.id === id || packet.id === -1);
      if (index >= 0) return this.packets.splice(index, 1)[0];
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now())));
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    fail("rcon_response_timeout");
  }
}

type CliConfig = {
  schema: "helix.minecraft.arena_fixture_supervisor_config.v1";
  readiness_transport?: "local_http" | "stdin_jsonl" | "local_player_status_file";
  base_url?: string;
  profile_id?: string;
  room_id: string;
  environment_binding_id: string;
  action_authority_id: string;
  server_run_directory: string;
  player_game_directory?: string;
  fixture_path: string;
  admission_timeout_ms?: number;
  active_timeout_ms?: number;
};

const normalizeLoopbackBaseUrl = (value: unknown) => {
  const parsed = new URL(requireString(value, "arena_base_url_missing"));
  if (
    parsed.protocol !== "http:" ||
    (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")
  ) {
    fail("arena_loopback_base_url_required");
  }
  return parsed.origin;
};

const readJson = async (response: Response) => {
  const contents = await response.text();
  try {
    return contents ? JSON.parse(contents) : {};
  } catch {
    fail(`arena_http_json_invalid_${response.status}`);
  }
};

const main = async () => {
  const configPath = process.argv[2];
  if (!configPath) fail("arena_supervisor_config_path_required");
  const config = JSON.parse(await fs.readFile(path.resolve(configPath), "utf8")) as CliConfig;
  if (config.schema !== "helix.minecraft.arena_fixture_supervisor_config.v1") {
    fail("arena_supervisor_config_schema_invalid");
  }
  const readinessTransport = config.readiness_transport ?? "local_http";
  const roomId = requireString(config.room_id, "arena_room_id_missing");
  const environmentBindingId = requireString(
    config.environment_binding_id,
    "arena_environment_binding_id_missing",
  );
  const actionAuthorityId = requireString(
    config.action_authority_id,
    "arena_action_authority_id_missing",
  );
  const runDirectory = path.resolve(
    requireString(config.server_run_directory, "arena_server_run_directory_missing"),
  );
  const fixture = parseArenaFixture(
    JSON.parse(await fs.readFile(path.resolve(config.fixture_path), "utf8")),
  );
  const properties = parseServerProperties(
    await fs.readFile(path.join(runDirectory, "server.properties"), "utf8"),
  );
  if (properties.get("enable-rcon") !== "true") fail("arena_rcon_not_enabled");
  const serverIp = properties.get("server-ip") ?? "";
  if (serverIp && serverIp !== "127.0.0.1" && serverIp !== "localhost") {
    fail("arena_rcon_server_not_loopback_bound");
  }
  const rconPort = Number(properties.get("rcon.port"));
  if (!Number.isInteger(rconPort) || rconPort < 1 || rconPort > 65_535) {
    fail("arena_rcon_port_invalid");
  }
  const rconPassword = requireString(
    properties.get("rcon.password"),
    "arena_rcon_password_missing",
  );

  let readReadiness: () => Promise<ArenaReadiness[]>;
  if (readinessTransport === "local_http") {
    const baseUrl = normalizeLoopbackBaseUrl(config.base_url);
    const profileId = requireString(config.profile_id, "arena_profile_id_missing");
    const signIn = await fetch(`${baseUrl}/api/account/session/sign-in`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: baseUrl,
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({
        profile_id: profileId,
        display_name: "Minecraft arena fixture supervisor",
        account_type: "developer",
      }),
    });
    if (!signIn.ok) fail(`arena_sign_in_http_${signIn.status}`);
    const cookie = signIn.headers.get("set-cookie")?.split(";", 1)[0]?.trim();
    if (!cookie) fail("arena_session_cookie_missing");
    const headers = { Cookie: cookie, Origin: baseUrl, "Sec-Fetch-Site": "same-origin" };
    const experimental = await fetch(`${baseUrl}/api/account/session/experimental-rooms`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    if (!experimental.ok) fail(`arena_experimental_rooms_http_${experimental.status}`);
    const readinessUrl =
      `${baseUrl}/api/agi/realtime/rooms/${encodeURIComponent(roomId)}` +
      `/environments/${encodeURIComponent(environmentBindingId)}/action-authorities`;
    readReadiness = async () => {
      const response = await fetch(readinessUrl, { headers });
      if (!response.ok) fail(`arena_readiness_http_${response.status}`);
      const payload = await readJson(response) as { connector_readiness?: ArenaReadiness[] };
      return Array.isArray(payload.connector_readiness) ? payload.connector_readiness : [];
    };
  } else if (readinessTransport === "stdin_jsonl") {
    const lines: ArenaReadiness[][] = [];
    let wake: (() => void) | null = null;
    const input = readline.createInterface({ input: process.stdin, terminal: false });
    input.on("line", (line) => {
      lines.push(parseStdinReadinessLine(line));
      wake?.();
      wake = null;
    });
    readReadiness = async () => {
      if (lines.length > 0) return lines.shift() ?? [];
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      return lines.shift() ?? [];
    };
  } else if (readinessTransport === "local_player_status_file") {
    const gameDirectory = path.resolve(
      requireString(
        config.player_game_directory,
        "arena_player_game_directory_missing",
      ),
    );
    const statusPath = path.join(
      gameDirectory,
      "config",
      "helix-fabric-player-agent.runtime-status.json",
    );
    readReadiness = async () => {
      try {
        return parseLocalPlayerRuntimeStatus(
          await fs.readFile(statusPath, "utf8"),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
        throw error;
      }
    };
  } else {
    fail("arena_readiness_transport_invalid");
  }

  const rcon = new RconClient(rconPort, rconPassword);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  await rcon.connect();
  try {
    await runArenaFixtureSupervisor({
      actionAuthorityId,
      fixture,
      signal: controller.signal,
      admissionTimeoutMs: config.admission_timeout_ms,
      activeTimeoutMs: config.active_timeout_ms,
      readReadiness,
      executeCommands: async (commands) => {
        for (const command of commands) await rcon.command(command);
      },
      emit: (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
    });
  } finally {
    rcon.close();
  }
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    const reason = error instanceof Error ? error.message : "arena_supervisor_failed";
    process.stderr.write(`${JSON.stringify({ event: "supervisor_failed", reason })}\n`);
    process.exitCode = 1;
  });
}
