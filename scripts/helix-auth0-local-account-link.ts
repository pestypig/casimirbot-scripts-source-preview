import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";

const baseUrl = "http://127.0.0.1:1522";
const callbackUrl = "http://127.0.0.1:8767/callback";
const clientId = process.argv[2]?.trim() ?? "";

if (!/^[A-Za-z0-9_-]{8,256}$/u.test(clientId)) {
  throw new Error("public_client_id_required");
}

const base64url = (value: Buffer): string => value.toString("base64url");
const verifier = base64url(crypto.randomBytes(64));
const challenge = base64url(
  crypto.createHash("sha256").update(verifier).digest(),
);
const state = base64url(crypto.randomBytes(32));

const signIn = await fetch(`${baseUrl}/api/account/session/sign-in`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    profile_id: "profile:g2-a1-codex",
    display_name: "G2 A1 Codex",
    account_type: "developer",
  }),
});
if (!signIn.ok) throw new Error("helix_session_sign_in_failed");
const cookie = signIn.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
if (!cookie) throw new Error("helix_session_cookie_missing");

const resourceResponse = await fetch(
  `${baseUrl}/.well-known/oauth-protected-resource`,
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
authorizationUrl.searchParams.set("scope", "openid profile helix.rooms.read");
authorizationUrl.searchParams.set("audience", resource.resource);
authorizationUrl.searchParams.set("state", state);
authorizationUrl.searchParams.set("code_challenge", challenge);
authorizationUrl.searchParams.set("code_challenge_method", "S256");

const callback = new Promise<{ code: string }>((resolve, reject) => {
  const timeout = setTimeout(() => {
    server.close();
    reject(new Error("authorization_callback_timeout"));
  }, 5 * 60_000);
  const server = http.createServer((request, response) => {
    const incoming = new URL(request.url ?? "/", callbackUrl);
    const code = incoming.searchParams.get("code");
    const returnedState = incoming.searchParams.get("state");
    const denied = incoming.searchParams.get("error");
    if (incoming.pathname !== "/callback" || returnedState !== state) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Invalid account-link callback.");
      return;
    }
    clearTimeout(timeout);
    response.writeHead(denied || !code ? 403 : 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(
      denied || !code
        ? "<p>Account linking was not authorized.</p>"
        : "<p>Helix account-link authorization received. You may close this window.</p>",
    );
    server.close();
    if (denied || !code) reject(new Error("authorization_denied"));
    else resolve({ code });
  });
  server.listen(8767, "127.0.0.1", () => {
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

const bindingResponse = await fetch(
  `${baseUrl}/api/account/session/agent-bindings/oauth/complete`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      Cookie: cookie,
      "X-Helix-Agent-Link-Confirm": "bind-current-oauth-subject",
    },
  },
);
const binding = (await bindingResponse.json().catch(() => null)) as {
  operation?: unknown;
  binding?: { status?: unknown };
  bearer_included?: unknown;
  raw_identity_included?: unknown;
  error?: unknown;
} | null;
if (!bindingResponse.ok) {
  throw new Error(
    typeof binding?.error === "string"
      ? `account_binding_failed:${binding.error}`
      : "account_binding_failed",
  );
}
console.log(
  JSON.stringify({
    ok: true,
    operation: binding?.operation,
    binding_status: binding?.binding?.status,
    bearer_included: binding?.bearer_included,
    raw_identity_included: binding?.raw_identity_included,
  }),
);
