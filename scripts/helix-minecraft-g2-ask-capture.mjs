#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const DEFAULT_BASE_URL = "http://127.0.0.1:1522";
const DEFAULT_PROMPT =
  "Complete the G2 fluid micro-course: inspect the current player state, perform the bounded look/sprint/jump, interact with the verified reachable target, equip the stick, craft four oak planks, verify every checkpoint, and release all controls.";

const fail = (code) => {
  throw new Error(code);
};

const record = (value, code) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
};

const string = (value, code) => {
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
  const [statePath, outputPath, suppliedBaseUrl, suppliedPrompt] =
    process.argv.slice(2);
  if (!statePath || !outputPath) fail("state_and_output_paths_required");
  return {
    statePath: path.resolve(statePath),
    outputPath: path.resolve(outputPath),
    baseUrl: normalizeBaseUrl(suppliedBaseUrl),
    prompt: suppliedPrompt?.trim() || DEFAULT_PROMPT,
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

const request = async (baseUrl, cookie, requestPath, options = {}) => {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method: options.method || "GET",
    headers: {
      Cookie: cookie,
      Origin: baseUrl,
      "Sec-Fetch-Site": "same-origin",
      Accept: "application/json",
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const payload = await readJson(response);
  if (
    !response.ok ||
    (payload?.ok === false && options.allowApplicationFailure !== true)
  ) {
    fail(
      typeof payload?.error === "string"
        ? payload.error
        : `http_${response.status}`,
    );
  }
  return record(payload, "response_body_missing");
};

// A complete provider-selected Minecraft turn can legitimately exceed the
// Fetch implementation's default response-header deadline while Codex performs
// several admitted capability continuations. Keep the local capture transport
// open without changing the bounded Ask lifecycle itself.
const requestLongRunningTurn = async (
  baseUrl,
  cookie,
  requestPath,
  options = {},
) =>
  new Promise((resolve, reject) => {
    const bodyText = JSON.stringify(options.body ?? {});
    const requestHandle = http.request(
      new URL(requestPath, baseUrl),
      {
        method: options.method || "POST",
        headers: {
          Cookie: cookie,
          Origin: baseUrl,
          "Sec-Fetch-Site": "same-origin",
          Accept: "application/json",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(bodyText),
        },
      },
      (response) => {
        let responseText = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseText += chunk;
        });
        response.on("end", () => {
          let payload = {};
          try {
            payload = responseText ? JSON.parse(responseText) : {};
          } catch {
            reject(new Error(`invalid_json_response_${response.statusCode}`));
            return;
          }
          if (
            (response.statusCode ?? 500) < 200 ||
            (response.statusCode ?? 500) >= 300 ||
            (payload?.ok === false && options.allowApplicationFailure !== true)
          ) {
            reject(
              new Error(
                typeof payload?.error === "string"
                  ? payload.error
                  : `http_${response.statusCode}`,
              ),
            );
            return;
          }
          resolve(record(payload, "response_body_missing"));
        });
      },
    );
    requestHandle.setTimeout(12 * 60_000, () => {
      requestHandle.destroy(new Error("ask_turn_capture_timeout"));
    });
    requestHandle.once("error", reject);
    requestHandle.end(bodyText);
  });

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
      display_name: "Minecraft G2 Helix Ask parity test",
      account_type: "developer",
    }),
  });
  if (!response.ok) fail(`developer_sign_in_http_${response.status}`);
  return parseSessionCookie(response);
};

const queuedAdmission = (payload) => {
  if (
    payload?.response_type !== "queued" ||
    payload?.final_status !== "pending_input"
  ) {
    return null;
  }
  const admission = payload.ask_turn_admission;
  if (
    !admission ||
    admission.schema !== "helix.ask_turn_admission.v1" ||
    admission.status !== "queued"
  ) {
    fail("invalid_queued_admission");
  }
  return admission;
};

const readTurnId = (payload, fallback) =>
  [
    payload?.turn_id,
    payload?.active_turn_id,
    payload?.backend_turn_id,
    payload?.ask_turn_solver_trace?.turn_id,
  ].find((value) => typeof value === "string" && value.trim()) || fallback;

const wait = (durationMs) =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

const run = async ({ statePath, outputPath, baseUrl, prompt }) => {
  const state = record(
    JSON.parse(await fs.readFile(statePath, "utf8")),
    "room_state_invalid",
  );
  const roomId = string(state.room_id, "room_id_missing");
  const profileId = string(state.profile_id, "profile_id_missing");
  const cookie = await signIn(baseUrl, profileId);
  if (state.enable_experimental_rooms === true) {
    await request(baseUrl, cookie, "/api/account/session/experimental-rooms", {
      method: "POST",
      body: { enabled: true },
    });
  }
  // API parity must reproduce the UI's explicit room-presence lifecycle. The
  // signed-in account alone is not authority to observe or mutate a room.
  await request(
    baseUrl,
    cookie,
    `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/presence`,
    { method: "POST", body: { presence: "present" } },
  );
  // A multi-step keyed turn can outlive the room client's ordinary presence
  // refresh interval. Keep this API participant explicitly present for the
  // duration of the capture, just as the interactive room client does.
  const presenceHeartbeat = setInterval(() => {
    void request(
      baseUrl,
      cookie,
      `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/presence`,
      { method: "POST", body: { presence: "present" } },
    ).catch(() => undefined);
  }, 15_000);
  presenceHeartbeat.unref();
  const body = {
    question: prompt,
    sessionId: `helix-ask:room:${roomId}`,
    traceId: `minecraft-g2-fluid-${crypto.randomUUID()}`,
    turnId: `ask:${crypto.randomUUID()}`,
    agentRuntime: "codex",
    agent_runtime: "codex",
    goldenPathRuntime: true,
    golden_path_runtime: true,
    mode: "act",
    context_mode: "isolated",
    debug: true,
    max_tokens: 3200,
  };
  const pendingPath = `${outputPath}.pending.json`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(
    pendingPath,
    `${JSON.stringify({
      schema: "helix.minecraft.g2_ask_capture_pending.v1",
      started_at: new Date().toISOString(),
      room_id: roomId,
      turn_id: body.turnId,
      trace_id: body.traceId,
      prompt,
      credentials_included: false,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );

  let askPayload = null;
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    askPayload = await requestLongRunningTurn(
      baseUrl,
      cookie,
      "/api/agi/ask/turn",
      {
      method: "POST",
      body,
      // A typed Ask failure is still a valid G2 differential artifact. Do not
      // confuse the application's terminal status with an HTTP transport
      // failure or discard the exact-turn debug export that explains it.
      allowApplicationFailure: true,
      },
    );
    const queued = queuedAdmission(askPayload);
    if (!queued) break;
    body.turnId = string(queued.turn_id, "queued_turn_id_missing");
    await wait(
      Math.min(
        10_000,
        Math.max(100, Number(queued.retry_after_ms) || 1000),
      ),
    );
  }
  if (!askPayload || queuedAdmission(askPayload)) {
    fail("ask_admission_did_not_resume");
  }

  const turnId = readTurnId(askPayload, body.turnId);
  const debugExport = await request(
    baseUrl,
    cookie,
    `/api/agi/ask/turn/${encodeURIComponent(turnId)}/debug-export`,
  );
  const artifact = {
    schema: "helix.minecraft.g2_ask_capture.v1",
    captured_at: new Date().toISOString(),
    prompt,
    room_id: roomId,
    turn_id: turnId,
    ask_response: askPayload,
    debug_export: debugExport,
    credentials_included: false,
    hidden_reasoning_included: false,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rm(pendingPath, { force: true });
  clearInterval(presenceHeartbeat);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      turn_id: turnId,
      response_type: askPayload.response_type ?? null,
      final_status: askPayload.final_status ?? null,
      output_path: outputPath,
    })}\n`,
  );
};

run(parseArgs()).catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "g2_ask_capture_failed"}\n`,
  );
  process.exitCode = 1;
});
