#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODE_SETUP = "setup";
const MODE_CLEANUP = "cleanup";
const DEFAULT_BASE_URL = "http://127.0.0.1:1522";
const DEFAULT_PROFILE_ID = "profile:minecraft-situation-awareness-local";
const PLATFORM_PAPER = "paper";
const PLATFORM_FABRIC = "fabric";
const PLATFORM_SETTINGS = {
  [PLATFORM_PAPER]: {
    domainAdapter: "minecraft.paper_plugin.v1",
    worldPrefix: "minecraft:local-paper",
    sourceLabel: "Minecraft Paper local situation sensor",
  },
  [PLATFORM_FABRIC]: {
    domainAdapter: "minecraft.fabric_mod.v1",
    worldPrefix: "minecraft:local-fabric-essential",
    sourceLabel: "Minecraft Fabric local situation sensor",
  },
};

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const templatePath = path.join(
  repositoryRoot,
  "minecraft",
  "helix-paper-sensor",
  "src",
  "main",
  "resources",
  "config.yml",
);

const fail = (code) => {
  throw new Error(code);
};

const requireRecord = (value, code) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
};

const requireString = (value, code) => {
  if (typeof value !== "string" || !value.trim()) fail(code);
  return value.trim();
};

const normalizeBaseUrl = (value) => {
  const parsed = new URL(value || DEFAULT_BASE_URL);
  if (
    parsed.protocol !== "http:" ||
    (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")
  ) {
    fail("local_base_url_required");
  }
  return parsed.origin;
};

const parseArgs = () => {
  const [
    mode,
    configPath,
    statePath,
    suppliedBaseUrl,
    suppliedPlatform,
    suppliedRoomId,
    suppliedProfileId,
  ] = process.argv.slice(2);
  if (mode !== MODE_SETUP && mode !== MODE_CLEANUP) {
    fail("usage_setup_or_cleanup_required");
  }
  if (!configPath || !statePath) fail("config_and_state_paths_required");
  const platform = suppliedPlatform || PLATFORM_PAPER;
  if (!PLATFORM_SETTINGS[platform]) fail("paper_or_fabric_platform_required");
  return {
    mode,
    configPath: path.resolve(configPath),
    statePath: path.resolve(statePath),
    baseUrl: normalizeBaseUrl(suppliedBaseUrl),
    platform,
    roomId: suppliedRoomId?.trim() || null,
    profileId: suppliedProfileId?.trim() || null,
  };
};

const parseSessionCookie = (response) => {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0]?.trim();
  if (!value || !/^helix_session=[^;\s]+$/u.test(value)) {
    fail("session_cookie_missing");
  }
  return value;
};

const readJson = async (response) => {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    fail(`invalid_json_response_${response.status}`);
  }
};

const signIn = async (baseUrl, profileId) => {
  const response = await fetch(`${baseUrl}/api/account/session/sign-in`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: baseUrl,
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify({
      profile_id: profileId,
      display_name: "Minecraft situation-awareness local test",
      account_type: "developer",
    }),
  });
  if (!response.ok) fail(`developer_sign_in_http_${response.status}`);
  return parseSessionCookie(response);
};

const request = async (
  baseUrl,
  cookie,
  requestPath,
  { method = "POST", body, idempotencyKey } = {},
) => {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: {
      Cookie: cookie,
      Origin: baseUrl,
      "Sec-Fetch-Site": "same-origin",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await readJson(response);
  if (!response.ok) {
    const code =
      result && typeof result.error === "string"
        ? result.error
        : `http_${response.status}`;
    fail(code);
  }
  return requireRecord(result, "response_body_missing");
};

const replaceYamlScalar = (source, key, value) => {
  const pattern = new RegExp(`^(\\s*${key}:)\\s*.*$`, "mu");
  if (!pattern.test(source)) fail(`plugin_template_missing_${key}`);
  return source.replace(pattern, `$1 ${JSON.stringify(value)}`);
};

const localIngressEndpoint = (pluginConfig, baseUrl) => {
  const ingress = new URL(
    requireString(pluginConfig.endpoint, "plugin_endpoint_missing"),
  );
  return `${baseUrl}${ingress.pathname}`;
};

const renderPaperPluginConfig = async (pluginConfig, baseUrl) => {
  const localEndpoint = localIngressEndpoint(pluginConfig, baseUrl);
  let output = await fs.readFile(templatePath, "utf8");
  output = replaceYamlScalar(output, "enabled", true);
  output = replaceYamlScalar(output, "endpoint", localEndpoint);
  output = replaceYamlScalar(
    output,
    "bearer_token",
    requireString(pluginConfig.bearer_token, "plugin_bearer_missing"),
  );
  output = replaceYamlScalar(
    output,
    "source_id",
    requireString(pluginConfig.source_id, "plugin_source_missing"),
  );
  output = replaceYamlScalar(
    output,
    "room_id",
    requireString(pluginConfig.room_id, "plugin_room_missing"),
  );
  output = replaceYamlScalar(
    output,
    "world_id",
    requireString(pluginConfig.world_id, "plugin_world_missing"),
  );
  output = replaceYamlScalar(
    output,
    "domain_adapter",
    requireString(pluginConfig.domain_adapter, "plugin_adapter_missing"),
  );
  output = replaceYamlScalar(output, "execution_enabled", false);
  return output;
};

const renderFabricPluginConfig = (pluginConfig, baseUrl) =>
  `${JSON.stringify(
    {
      enabled: true,
      endpoint: localIngressEndpoint(pluginConfig, baseUrl),
      bearer_token: requireString(
        pluginConfig.bearer_token,
        "plugin_bearer_missing",
      ),
      source_id: requireString(
        pluginConfig.source_id,
        "plugin_source_missing",
      ),
      room_id: requireString(pluginConfig.room_id, "plugin_room_missing"),
      world_id: requireString(pluginConfig.world_id, "plugin_world_missing"),
      domain_adapter: requireString(
        pluginConfig.domain_adapter,
        "plugin_adapter_missing",
      ),
      source_label: "Minecraft Fabric Sensor",
      execution_enabled: false,
      read_only_probes_enabled: true,
      snapshot_interval_ticks: 100,
      heartbeat_interval_ticks: 100,
      probe_poll_interval_ticks: 40,
      max_pending_probes_per_poll: 8,
      send_only_changed_sections: false,
      include_section_hashes: true,
      sensor_scope_default: "player_observable",
      allow_privileged_container_scan: false,
      allow_privileged_entity_scan: false,
    },
    null,
    2,
  )}\n`;

const renderPluginConfig = async (pluginConfig, baseUrl, platform) =>
  platform === PLATFORM_FABRIC
    ? renderFabricPluginConfig(pluginConfig, baseUrl)
    : renderPaperPluginConfig(pluginConfig, baseUrl);

const writePrivateFile = async (targetPath, contents) => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, contents, {
    encoding: "utf8",
    mode: 0o600,
  });
};

const resetPluginConfig = async (configPath, platform) => {
  if (platform === PLATFORM_FABRIC) {
    await writePrivateFile(
      configPath,
      `${JSON.stringify(
        {
          enabled: false,
          endpoint:
            "https://casimirbot.com/api/room-ingress/v1/bindings/replace-with-generated-id",
          bearer_token: "replace-me",
          source_id: "source:room-ingress:replace-with-generated-id",
          room_id: "room:minecraft",
          world_id: "minecraft:fabric-integrated-server",
          domain_adapter: "minecraft.fabric_mod.v1",
          source_label: "Minecraft Fabric Sensor",
          execution_enabled: false,
          read_only_probes_enabled: true,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  await writePrivateFile(configPath, await fs.readFile(templatePath, "utf8"));
};

const setup = async ({
  baseUrl,
  configPath,
  statePath,
  platform,
  roomId: suppliedRoomId,
  profileId: suppliedProfileId,
}) => {
  const platformSettings = PLATFORM_SETTINGS[platform];
  const profileId = suppliedProfileId || DEFAULT_PROFILE_ID;
  const cookie = await signIn(baseUrl, profileId);
  await request(baseUrl, cookie, "/api/account/session/experimental-rooms", {
    body: { enabled: true },
  });
  const nonce = crypto.randomUUID();
  const roomCreatedBySetup = suppliedRoomId === null;
  const roomId = roomCreatedBySetup
    ? requireString(
        requireRecord(
          (
            await request(baseUrl, cookie, "/api/agi/realtime/rooms", {
              body: { title: "Minecraft situation-awareness local test" },
              idempotencyKey: `minecraft-local-room-${nonce}`,
            })
          ).room,
          "room_missing",
        ).room_id,
        "room_id_missing",
      )
    : requireString(suppliedRoomId, "room_id_missing");
  if (!roomCreatedBySetup) {
    const roomReceipt = await request(
      baseUrl,
      cookie,
      `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}`,
      { method: "GET" },
    );
    requireRecord(roomReceipt.room, "room_missing");
  }
  await request(
    baseUrl,
    cookie,
    `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/presence`,
    { body: { presence: "present" } },
  );
  const sourceReceipt = await request(
    baseUrl,
    cookie,
    `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/source-bindings`,
    {
      body: {
        world_id: `${platformSettings.worldPrefix}:${nonce}`,
        domain_adapter: platformSettings.domainAdapter,
        source_label: platformSettings.sourceLabel,
      },
      idempotencyKey: `minecraft-local-source-${nonce}`,
    },
  );
  const binding = requireRecord(sourceReceipt.binding, "binding_missing");
  const delivery = requireRecord(
    sourceReceipt.credential_delivery,
    "credential_delivery_missing",
  );
  const bindingId = requireString(binding.binding_id, "binding_id_missing");
  const claimReceipt = await request(
    baseUrl,
    cookie,
    "/api/agi/realtime/room-source-credential-deliveries/claim",
    {
      body: {
        claim_handle: requireString(
          delivery.claim_handle,
          "claim_handle_missing",
        ),
      },
    },
  );
  if (
    claimReceipt.token_value_shown_once !== true ||
    claimReceipt.secret_stored_raw !== false
  ) {
    fail("credential_delivery_contract_failed");
  }
  const pluginConfig = requireRecord(
    claimReceipt.plugin_config,
    "plugin_config_missing",
  );
  if (
    pluginConfig.execution_enabled !== false ||
    pluginConfig.domain_adapter !== platformSettings.domainAdapter
  ) {
    fail("plugin_config_policy_failed");
  }
  const renderedConfig = await renderPluginConfig(
    pluginConfig,
    baseUrl,
    platform,
  );
  await writePrivateFile(configPath, renderedConfig);
  const state = {
    schema: "helix.minecraft_local_room_session.v1",
    created_at: new Date().toISOString(),
    base_url: baseUrl,
    profile_id: profileId,
    room_id: roomId,
    binding_id: bindingId,
    source_id: requireString(binding.source_id, "source_id_missing"),
    world_id: requireString(binding.world_id, "world_id_missing"),
    domain_adapter: requireString(
      binding.domain_adapter,
      "domain_adapter_missing",
    ),
    platform,
    plugin_config_path: configPath,
    credential_persisted_only_in_plugin_config: true,
    command_execution_enabled: false,
    room_created_by_setup: roomCreatedBySetup,
  };
  await writePrivateFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      mode: MODE_SETUP,
      room_id: state.room_id,
      binding_id: state.binding_id,
      source_id: state.source_id,
      world_id: state.world_id,
      plugin_config_written: true,
      credential_value_reported: false,
      command_execution_enabled: false,
      reused_existing_room: !roomCreatedBySetup,
    })}\n`,
  );
};

const cleanup = async ({ baseUrl, configPath, statePath }) => {
  const state = requireRecord(
    JSON.parse(await fs.readFile(statePath, "utf8")),
    "state_invalid",
  );
  const profileId = requireString(state.profile_id, "state_profile_missing");
  const roomId = requireString(state.room_id, "state_room_missing");
  const bindingId = requireString(state.binding_id, "state_binding_missing");
  const cookie = await signIn(baseUrl, profileId);
  const cleanupResults = {
    binding_revoked: false,
    room_closed: false,
    plugin_config_reset: false,
  };
  const errorIncludesAny = (error, codes) => {
    const message = String(error instanceof Error ? error.message : error);
    return codes.some((code) => message.includes(code));
  };
  try {
    await request(
      baseUrl,
      cookie,
      `/api/agi/realtime/rooms/${encodeURIComponent(
        roomId,
      )}/source-bindings/${encodeURIComponent(bindingId)}/revoke`,
      { body: {} },
    );
    cleanupResults.binding_revoked = true;
  } catch (error) {
    if (
      !errorIncludesAny(error, [
        "source_binding_not_found",
        "room_source_binding_not_found",
        "source_binding_closed",
        "room_source_binding_closed",
      ])
    ) {
      throw error;
    }
    cleanupResults.binding_revoked = true;
  }
  try {
    if (state.room_created_by_setup !== false) {
      try {
        await request(
          baseUrl,
          cookie,
          `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/leave`,
          { body: {} },
        );
        cleanupResults.room_closed = true;
      } catch (error) {
        if (
          !errorIncludesAny(error, [
            "room_closed",
            "shared_realtime_room_closed",
          ])
        ) {
          throw error;
        }
        cleanupResults.room_closed = true;
      }
    }
  } finally {
    const platform =
      state.platform === PLATFORM_FABRIC ? PLATFORM_FABRIC : PLATFORM_PAPER;
    await resetPluginConfig(configPath, platform);
    cleanupResults.plugin_config_reset = true;
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      mode: MODE_CLEANUP,
      ...cleanupResults,
      credential_value_reported: false,
    })}\n`,
  );
};

const args = parseArgs();
await (args.mode === MODE_SETUP ? setup(args) : cleanup(args));
