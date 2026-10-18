#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "http://127.0.0.1:1522";
const DEFAULT_PLAYER_LABEL = "DatDamPig";
const CAPABILITY_IDS = Object.freeze([
  "com.casimirbot.minecraft.player.navigate",
  "com.casimirbot.minecraft.player.look",
  "com.casimirbot.minecraft.player.camera.track",
  "com.casimirbot.minecraft.player.walk",
  "com.casimirbot.minecraft.player.jump",
  "com.casimirbot.minecraft.player.interact",
  "com.casimirbot.minecraft.player.hotbar.select",
  "com.casimirbot.minecraft.player.equipment.equip",
  "com.casimirbot.minecraft.player.follow",
  "com.casimirbot.minecraft.player.collect",
  "com.casimirbot.minecraft.player.mine",
  "com.casimirbot.minecraft.player.place",
  "com.casimirbot.minecraft.player.craft",
  "com.casimirbot.minecraft.player.inventory.transfer",
  "com.casimirbot.minecraft.player.sequence.execute",
  "com.casimirbot.minecraft.player.guardian.execute",
  "com.casimirbot.minecraft.player.viability_guardian.arm",
  "com.casimirbot.minecraft.player.viability_guardian.disarm",
]);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const pairingInboxHelper = path.join(
  repositoryRoot,
  "scripts",
  "helix-minecraft-player-pairing-inbox.ps1",
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
  const [statePath, minecraftRoot, suppliedBaseUrl, suppliedPlayerLabel] =
    process.argv.slice(2);
  if (!statePath || !minecraftRoot) {
    fail("room_state_and_minecraft_root_required");
  }
  return {
    statePath: path.resolve(statePath),
    minecraftRoot: path.resolve(minecraftRoot),
    baseUrl: normalizeBaseUrl(suppliedBaseUrl),
    playerLabel: suppliedPlayerLabel?.trim() || DEFAULT_PLAYER_LABEL,
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
      display_name: "Minecraft G2 local parity test",
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
  { method = "GET", body, idempotencyKey } = {},
) => {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: {
      Cookie: cookie,
      Origin: baseUrl,
      "Sec-Fetch-Site": "same-origin",
      Accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await readJson(response);
  if (!response.ok || result?.ok === false) {
    fail(
      typeof result?.error === "string"
        ? result.error
        : `http_${response.status}`,
    );
  }
  return requireRecord(result, "response_body_missing");
};

const stagePairingCommand = async (command, minecraftRoot) => {
  if (
    typeof command !== "string" ||
    !/^\/helix-player\s+pair\s+[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}(?:\s+\S+)?\s*$/u.test(
      command,
    ) ||
    Buffer.byteLength(command, "utf8") > 512
  ) {
    fail("player_pairing_command_invalid");
  }
  await new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        pairingInboxHelper,
        "-MinecraftRoot",
        minecraftRoot,
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (
        code !== 0 ||
        stdout.trim() !== "player_pairing_inbox_staged" ||
        stderr.trim()
      ) {
        reject(new Error("player_pairing_inbox_handoff_failed"));
        return;
      }
      resolve();
    });
    child.stdin.end(command);
  });
};

const waitForReadiness = async ({
  baseUrl,
  cookie,
  roomId,
  environmentBindingId,
  actionAuthorityId,
}) => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const receipt = await request(
      baseUrl,
      cookie,
      `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/environments/${encodeURIComponent(environmentBindingId)}/action-authorities`,
    );
    const entries = Array.isArray(receipt.connector_readiness)
      ? receipt.connector_readiness
      : [];
    const readiness = entries.find(
      (entry) => entry?.action_authority_id === actionAuthorityId,
    );
    if (readiness?.state === "ready" || readiness?.ready_for_actions === true) {
      return requireRecord(readiness, "connector_readiness_invalid");
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail("player_connector_readiness_timeout");
};

const setup = async ({ statePath, minecraftRoot, baseUrl, playerLabel }) => {
  const state = requireRecord(
    JSON.parse(await fs.readFile(statePath, "utf8")),
    "room_state_invalid",
  );
  const roomId = requireString(state.room_id, "room_id_missing");
  const profileId = requireString(state.profile_id, "profile_id_missing");
  const cookie = await signIn(baseUrl, profileId);
  // An authenticated API session is not itself room presence. Mirror the
  // explicit UI lifecycle before deriving participant or environment
  // authority so a restarted keyed server cannot leave a valid test session
  // attached to a restored `away` membership.
  await request(
    baseUrl,
    cookie,
    `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/presence`,
    {
      method: "POST",
      body: { presence: "present" },
    },
  );
  const roomReceipt = await request(
    baseUrl,
    cookie,
    `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}`,
  );
  const room = requireRecord(roomReceipt.room, "room_missing");
  const participantId = requireString(
    room.self_participant_id,
    "self_participant_id_missing",
  );
  const environmentsReceipt = await request(
    baseUrl,
    cookie,
    `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/environments`,
  );
  const environments = Array.isArray(environmentsReceipt.environments)
    ? environmentsReceipt.environments
    : [];
  const environment = environments.find(
    (entry) =>
      entry?.domain_adapter === "minecraft.fabric_mod.v1" &&
      (
        (typeof state.binding_id === "string" &&
          entry?.room_source_binding_id === state.binding_id) ||
        (typeof state.source_id === "string" &&
          entry?.source_id === state.source_id) ||
        (typeof state.environment_binding_id === "string" &&
          entry?.environment_binding_id === state.environment_binding_id)
      ),
  );
  if (!environment) fail("fabric_environment_unavailable");
  const subjects = Array.isArray(environment.subject_directory?.subjects)
    ? environment.subject_directory.subjects
    : [];
  const subject =
    subjects.find(
      (entry) =>
        entry?.display_label === playerLabel &&
        entry?.presence === "online" &&
        entry?.freshness === "fresh",
    ) ??
    subjects.find(
      (entry) => entry?.presence === "online" && entry?.freshness === "fresh",
    );
  if (!subject) fail("fresh_online_player_unavailable");
  const environmentBindingId = requireString(
    environment.environment_binding_id,
    "environment_binding_id_missing",
  );
  const bindingReceipt = await request(
    baseUrl,
    cookie,
    `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/environments/${encodeURIComponent(environmentBindingId)}/me`,
    {
      method: "PUT",
      body: {
        subject_ref: requireString(subject.subject_ref, "subject_ref_missing"),
      },
    },
  );
  const subjectBinding = requireRecord(
    bindingReceipt.binding,
    "subject_binding_missing",
  );
  const authorityReceipt = await request(
    baseUrl,
    cookie,
    `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/environments/${encodeURIComponent(environmentBindingId)}/action-authorities`,
    {
      method: "PUT",
      body: {
        participant_id: participantId,
        domain_adapter: "minecraft.fabric_client.v1",
        allowed_capability_ids: CAPABILITY_IDS,
        autonomy_mode: "approved_capabilities",
        manual_override_policy: "cancel",
        expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      },
    },
  );
  const authority = requireRecord(
    authorityReceipt.authority,
    "action_authority_missing",
  );
  const actionAuthorityId = requireString(
    authority.action_authority_id,
    "action_authority_id_missing",
  );
  const pairingsReceipt = await request(
    baseUrl,
    cookie,
    `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/connector-pairings`,
  );
  const pendingPairings = Array.isArray(pairingsReceipt.pairings)
    ? pairingsReceipt.pairings.filter(
        (entry) =>
          entry?.status === "pending" &&
          entry?.action_credential_requested === true,
      )
    : [];
  for (const pairing of pendingPairings) {
    await request(
      baseUrl,
      cookie,
      `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/connector-pairings/${encodeURIComponent(requireString(pairing.pairing_id, "pairing_id_missing"))}`,
      { method: "DELETE" },
    );
  }
  const pairingReceipt = await request(
    baseUrl,
    cookie,
    `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/connector-pairings`,
    {
      method: "POST",
      idempotencyKey: `minecraft-g2-player-${crypto.randomUUID()}`,
      body: {
        purpose: "rotate",
        binding_id: requireString(
          environment.room_source_binding_id,
          "room_source_binding_id_missing",
        ),
        domain_adapter: requireString(
          environment.domain_adapter,
          "environment_adapter_missing",
        ),
        source_label: requireString(
          environment.source_label,
          "source_label_missing",
        ),
        command_credential_requested: false,
        action_credential_requested: true,
        action_authority_id: actionAuthorityId,
        credential_ttl_ms: 2 * 60 * 60 * 1000,
      },
    },
  );
  let pairingCommand = requireString(
    pairingReceipt.pairing_command,
    "player_pairing_command_missing",
  );
  try {
    await stagePairingCommand(pairingCommand, minecraftRoot);
  } finally {
    pairingCommand = "";
  }
  const readiness = await waitForReadiness({
    baseUrl,
    cookie,
    roomId,
    environmentBindingId,
    actionAuthorityId,
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      room_id: roomId,
      environment_binding_id: environmentBindingId,
      subject_binding_id: requireString(
        subjectBinding.subject_binding_id,
        "subject_binding_id_missing",
      ),
      subject_label: requireString(
        subjectBinding.subject_label,
        "subject_label_missing",
      ),
      action_authority_id: actionAuthorityId,
      allowed_capability_count: CAPABILITY_IDS.length,
      sequence_capability_allowed: CAPABILITY_IDS.includes(
        "com.casimirbot.minecraft.player.sequence.execute",
      ),
      connector_readiness: readiness.state,
      credential_value_reported: false,
    })}\n`,
  );
};

await setup(parseArgs());
