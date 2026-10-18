import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

const baseUrl = "http://127.0.0.1:1522";
const callbackUrl = "http://127.0.0.1:8766/callback";
const roomId =
  "shared_realtime_room:1ac9e158-c650-4644-8485-29974d406ef7";
const clientId = process.argv[2]?.trim() ?? "";
const prompt =
  "Using the canonical durable Minecraft goal in this room, report whether it completed. Summarize the verified wake-driven replanning, connector-epoch recovery, restored viable control, and terminal milestone state. Use current room evidence; do not execute a new game action or invent progress.";

if (!/^[A-Za-z0-9_-]{8,256}$/u.test(clientId)) {
  throw new Error("public_client_id_required");
}

const base64url = (value: Buffer): string => value.toString("base64url");
const verifier = base64url(crypto.randomBytes(64));
const challenge = base64url(
  crypto.createHash("sha256").update(verifier).digest(),
);
const state = base64url(crypto.randomBytes(32));

const resourceResponse = await fetch(
  `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
);
if (!resourceResponse.ok) throw new Error("resource_metadata_unavailable");
const resource = (await resourceResponse.json()) as {
  resource?: unknown;
  authorization_servers?: unknown;
};
if (
  typeof resource.resource !== "string" ||
  !Array.isArray(resource.authorization_servers) ||
  typeof resource.authorization_servers[0] !== "string"
) {
  throw new Error("resource_metadata_invalid");
}

const issuer = resource.authorization_servers[0];
const oidcResponse = await fetch(
  new URL(".well-known/openid-configuration", issuer).toString(),
);
if (!oidcResponse.ok) throw new Error("authorization_metadata_unavailable");
const oidc = (await oidcResponse.json()) as {
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
};
if (
  typeof oidc.authorization_endpoint !== "string" ||
  typeof oidc.token_endpoint !== "string"
) {
  throw new Error("authorization_metadata_invalid");
}

const authorizationUrl = new URL(oidc.authorization_endpoint);
authorizationUrl.searchParams.set("response_type", "code");
authorizationUrl.searchParams.set("client_id", clientId);
authorizationUrl.searchParams.set("redirect_uri", callbackUrl);
authorizationUrl.searchParams.set(
  "scope",
  [
    "openid",
    "profile",
    "helix.agent_runs.read",
    "helix.agent_runs.write",
    "helix.rooms.read",
    "helix.rooms.manage",
  ].join(" "),
);
authorizationUrl.searchParams.set("audience", resource.resource);
authorizationUrl.searchParams.set("state", state);
authorizationUrl.searchParams.set("code_challenge", challenge);
authorizationUrl.searchParams.set("code_challenge_method", "S256");
authorizationUrl.searchParams.set("prompt", "none");

const callback = new Promise<{ code: string }>((resolve, reject) => {
  const timeout = setTimeout(() => {
    server.close();
    reject(new Error("authorization_callback_timeout"));
  }, 3 * 60_000);
  const server = http.createServer((request, response) => {
    const incoming = new URL(request.url ?? "/", callbackUrl);
    const code = incoming.searchParams.get("code");
    const returnedState = incoming.searchParams.get("state");
    const denied = incoming.searchParams.get("error");
    if (incoming.pathname !== "/callback" || returnedState !== state) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Invalid OAuth callback.");
      return;
    }
    clearTimeout(timeout);
    response.writeHead(denied || !code ? 403 : 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(
      denied || !code
        ? "<p>OAuth authorization was not available silently.</p>"
        : "<p>Helix G5 report authorization received. You may close this window.</p>",
    );
    server.close();
    if (denied || !code) {
      reject(new Error(`authorization_denied:${denied ?? "code_missing"}`));
    } else {
      resolve({ code });
    }
  });
  server.listen(8766, "127.0.0.1", () => {
    spawn(
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", authorizationUrl.toString()],
      { detached: true, stdio: "ignore", windowsHide: true },
    ).unref();
  });
});

const { code } = await callback;
const tokenResponse = await fetch(oidc.token_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: callbackUrl,
  }),
});
const tokenBody = (await tokenResponse.json().catch(() => null)) as {
  access_token?: unknown;
} | null;
if (!tokenResponse.ok || typeof tokenBody?.access_token !== "string") {
  throw new Error("authorization_token_exchange_failed");
}
const accessToken = tokenBody.access_token;

const api = async (
  pathname: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    const error = typeof body.error === "string" ? body.error : "request_failed";
    throw new Error(`${pathname}:${response.status}:${error}`);
  }
  return { status: response.status, body };
};

const executionId = crypto.randomUUID();
const started = await api("/api/v1/agent-runs", {
  method: "POST",
  headers: { "Idempotency-Key": `g5-report-start-${executionId}` },
  body: JSON.stringify({
    objective: prompt,
    constraints: [
      "Use only the current bound Shared Live Room evidence.",
      "Do not execute a Minecraft action or invent progress.",
      "Treat room and durable-goal observations as evidence, not answer authority.",
    ],
    database_scope: ["bound_room_evidence"],
    completion_contract: {
      min_evidence_refs: 1,
      require_terminal_authority: true,
      required_output_fields: ["text"],
      max_unresolved_requirements: 1,
      allow_conflicts: false,
    },
    budget: { max_steps: 4, expires_in_seconds: 900 },
  }),
});
const runId = String(started.body.run_id ?? "");
const firstVersion = Number(started.body.version ?? 0);
if (!runId || !Number.isInteger(firstVersion) || firstVersion < 1) {
  throw new Error("agent_run_start_projection_invalid");
}

const binding = await api("/api/v1/rooms/run-bindings", {
  method: "POST",
  body: JSON.stringify({ run_id: runId, room_id: roomId }),
});

const continued = await api(
  `/api/v1/agent-runs/${encodeURIComponent(runId)}/continue`,
  {
    method: "POST",
    headers: { "Idempotency-Key": `g5-report-continue-${executionId}` },
    body: JSON.stringify({
      expected_version: firstVersion,
      instruction: prompt,
      answers: [],
    }),
  },
);
const inspected = await api(
  `/api/v1/agent-runs/${encodeURIComponent(runId)}`,
);
const events = await api(
  `/api/v1/agent-runs/${encodeURIComponent(runId)}/events?after_seq=0&limit=100`,
);
const evidence = await api(
  `/api/v1/agent-runs/${encodeURIComponent(runId)}/evidence`,
);

const run = inspected.body;
const latestResult =
  run.latest_result && typeof run.latest_result === "object"
    ? (run.latest_result as Record<string, unknown>)
    : {};
const eventRows = Array.isArray(events.body.events)
  ? events.body.events
  : [];
const sanitized = {
  schema: "helix.g5.oauth_bound_room_report_acceptance.v1",
  captured_at: new Date().toISOString(),
  oauth_authorized: true,
  bearer_included: false,
  run_id: runId,
  room_id: roomId,
  room_binding_ref: binding.body.binding_ref ?? null,
  start: {
    status: started.status,
    version: firstVersion,
    lifecycle_status: started.body.lifecycle_status ?? null,
    completion_status: started.body.completion_status ?? null,
  },
  continuation: {
    status: continued.status,
    version: continued.body.version ?? null,
  },
  result: {
    lifecycle_status: run.lifecycle_status ?? null,
    completion_status: run.completion_status ?? null,
    terminal_authority_status: run.terminal_authority_status ?? null,
    summary: run.summary ?? null,
    unresolved_requirements: run.unresolved_requirements ?? [],
    terminal_product: latestResult.terminal_product ?? null,
    terminal_authority_reason: latestResult.terminal_authority_reason ?? null,
    solver_path_completed: latestResult.solver_path_completed ?? null,
    observation_refs: latestResult.observation_refs ?? [],
    evidence_refs: latestResult.evidence_refs ?? [],
    receipt_refs: latestResult.receipt_refs ?? [],
  },
  events: eventRows.map((event) => {
    const row = event as Record<string, unknown>;
    return {
      seq: row.seq ?? null,
      event_id: row.event_id ?? null,
      event_type: row.event_type ?? null,
    };
  }),
  evidence: {
    observation_refs: evidence.body.observation_refs ?? [],
    evidence_refs: evidence.body.evidence_refs ?? [],
    receipt_refs: evidence.body.receipt_refs ?? [],
    provider_terminal_candidate_ref:
      evidence.body.provider_terminal_candidate_ref ?? null,
    terminal_authority_ref: evidence.body.terminal_authority_ref ?? null,
    answer_authority: false,
  },
};

const artifactDirectory = path.resolve(
  "artifacts",
  "g5-durable-survival-goal",
);
await fs.mkdir(artifactDirectory, { recursive: true });
const artifactPath = path.join(
  artifactDirectory,
  `oauth-bound-room-report-${executionId}.json`,
);
await fs.writeFile(artifactPath, `${JSON.stringify(sanitized, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
console.log(
  JSON.stringify({
    ok: true,
    artifact_path: artifactPath,
    lifecycle_status: sanitized.result.lifecycle_status,
    completion_status: sanitized.result.completion_status,
    terminal_authority_status: sanitized.result.terminal_authority_status,
    solver_path_completed: sanitized.result.solver_path_completed,
    terminal_text:
      sanitized.result.terminal_product &&
      typeof sanitized.result.terminal_product === "object"
        ? (sanitized.result.terminal_product as Record<string, unknown>).text ??
          null
        : null,
    bearer_included: false,
  }),
);
