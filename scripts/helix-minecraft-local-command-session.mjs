#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import { installHelixFabricRuntimeConfig } from "./install-helix-fabric-room-config.mjs";

const fail = (code) => {
  throw new Error(code);
};

const record = (value, code) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
};

const text = (value, code) => {
  if (typeof value !== "string" || !value.trim()) fail(code);
  return value.trim();
};

const [configArg, stateArg, baseUrlArg] = process.argv.slice(2);
if (!configArg || !stateArg) {
  fail("config_and_state_paths_required");
}
const configPath = path.resolve(configArg);
const statePath = path.resolve(stateArg);
const baseUrl = new URL(baseUrlArg || "http://127.0.0.1:1522").origin;
if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(baseUrl)) {
  fail("local_base_url_required");
}

const parseCookie = (response) => {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]?.trim();
  if (!cookie || !/^helix_session=[^;\s]+$/u.test(cookie)) {
    fail("session_cookie_missing");
  }
  return cookie;
};

const readJson = async (response) => {
  const body = await response.json();
  if (!response.ok) {
    fail(typeof body?.error === "string" ? body.error : `http_${response.status}`);
  }
  return record(body, "response_body_missing");
};

const signIn = async (profileId) => {
  const response = await fetch(`${baseUrl}/api/account/session/sign-in`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: baseUrl,
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify({
      profile_id: profileId,
      display_name: "Minecraft command local test",
      account_type: "developer",
    }),
  });
  if (!response.ok) fail(`developer_sign_in_http_${response.status}`);
  return parseCookie(response);
};

const request = async (cookie, requestPath, { method = "GET", body } = {}) =>
  readJson(
    await fetch(`${baseUrl}${requestPath}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: baseUrl,
        "Sec-Fetch-Site": "same-origin",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const state = record(
  JSON.parse(await fs.readFile(statePath, "utf8")),
  "state_invalid",
);
const profileId = text(state.profile_id, "state_profile_missing");
const roomId = text(state.room_id, "state_room_missing");
const sourceId = text(state.source_id, "state_source_missing");
const cookie = await signIn(profileId);

const environmentReceipt = await request(
  cookie,
  `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/environments`,
);
const environments = Array.isArray(environmentReceipt.environments)
  ? environmentReceipt.environments
  : [];
const matching = environments.filter(
  (candidate) =>
    candidate?.source_id === sourceId &&
    candidate?.domain_adapter === "minecraft.fabric_mod.v1" &&
    candidate?.connection_status === "active",
);
if (matching.length !== 1) {
  fail(matching.length === 0 ? "active_fabric_environment_missing" : "fabric_environment_ambiguous");
}
const environmentBindingId = text(
  matching[0].environment_binding_id,
  "environment_binding_missing",
);

const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1_000).toISOString();
const authorityReceipt = await request(
  cookie,
  `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/environments/${encodeURIComponent(environmentBindingId)}/command-authority`,
  {
    method: "PUT",
    body: {
      authority_profile: "server_administrator",
      autonomy_mode: "autonomous",
      approved_categories: [],
      expires_at: expiresAt,
    },
  },
);
const authority = record(authorityReceipt.authority, "command_authority_missing");
const credentialReceipt = await request(
  cookie,
  `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/environments/${encodeURIComponent(environmentBindingId)}/command-credential`,
  { method: "POST", body: { ttl_ms: 6 * 60 * 60 * 1_000 } },
);
if (
  credentialReceipt.token_value_shown_once !== true ||
  credentialReceipt.secret_stored_raw !== false
) {
  fail("command_credential_delivery_contract_failed");
}
const commandConfig = record(
  credentialReceipt.command_config,
  "command_config_missing",
);
const installation = await installHelixFabricRuntimeConfig({
  configPath,
  commandConfigText: JSON.stringify({ command: commandConfig }),
  commandEndpointOrigin: baseUrl,
});
const nextState = {
  ...state,
  environment_binding_id: environmentBindingId,
  command_authority_id: text(
    authority.command_authority_id,
    "command_authority_id_missing",
  ),
  command_policy_version: Number(authority.policy_version),
  command_authority_profile: authority.authority_profile,
  command_autonomy_mode: authority.autonomy_mode,
  command_expires_at: authority.expires_at,
  command_execution_enabled: installation.command_configured,
  command_credential_persisted_only_in_plugin_config: true,
};
await fs.writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    room_id: roomId,
    environment_binding_id: environmentBindingId,
    authority_profile: authority.authority_profile,
    autonomy_mode: authority.autonomy_mode,
    policy_version: Number(authority.policy_version),
    command_config_written: installation.command_configured,
    host_access_enabled: installation.host_access_enabled,
    automatic_retry_enabled: installation.automatic_retry_enabled,
    credential_value_reported: false,
  })}\n`,
);
