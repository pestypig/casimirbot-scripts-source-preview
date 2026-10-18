import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_G2_SCOPES = [
  "helix.rooms.read",
  "helix.environment_actions.read",
  "helix.environment_actions.write",
] as const;

const REQUIRED_G8_MONITOR_SCOPES = [
  ...REQUIRED_G2_SCOPES,
  "helix.agent_runs.write",
  "helix.agent_runs.developer",
  "helix.brokerage.paper_observer.process",
] as const;

export type CodexMcpOAuthCapabilityProfile = "g2-action" | "g8-monitor";

const DEFAULT_BASE_URL = "http://127.0.0.1:1522";
const DEFAULT_CALLBACK_PORT = 8766;

type JsonRecord = Record<string, unknown>;
type FetchLike = typeof fetch;

export type CodexMcpOAuthPreflight = {
  schema: "casimirbot.codex_mcp_oauth_preflight.v1";
  capability_profile: CodexMcpOAuthCapabilityProfile;
  status:
    | "ready_for_interactive_login"
    | "client_registration_required"
    | "derived_callback_registration_required";
  resource: string;
  resource_discovery_authoritative: true;
  oauth_resource_override_required: false;
  authorization_server: string;
  protected_resource_metadata_url: string;
  authorization_server_metadata_url: string;
  authorization_endpoint_present: boolean;
  token_endpoint_present: boolean;
  jwks_uri_present: boolean;
  pkce_s256_supported: boolean;
  registration_endpoint_advertised: boolean;
  dynamic_registration_verified: false;
  required_scopes: string[];
  missing_scopes: string[];
  oauth_client_id_configured: boolean;
  oauth_client_secret_required: false;
  callback_port: number;
  callback_base_url: string;
  callback_url: string;
  derived_callback_url: string | null;
  derived_callback_valid: boolean;
  next_action: string;
  mutating_request_performed: false;
  credentials_included: false;
};

const record = (value: unknown, code: string): JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as JsonRecord;
};

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const requiredString = (value: unknown, code: string): string => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(code);
  return normalized;
};

const fetchJson = async (
  fetcher: FetchLike,
  url: string,
  code: string,
): Promise<JsonRecord> => {
  const response = await fetcher(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${code}:http_${response.status}`);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    throw new Error(`${code}:non_json_response:${contentType || "missing_content_type"}`);
  }
  try {
    return record(await response.json(), `${code}:invalid_json_object`);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("invalid_json_object")) {
      throw error;
    }
    throw new Error(`${code}:invalid_json`);
  }
};

export const inspectCodexMcpOAuthReadiness = async (input: {
  baseUrl?: string;
  oauthClientId?: string | null;
  callbackPort?: number;
  derivedCallbackUrl?: string | null;
  capabilityProfile?: CodexMcpOAuthCapabilityProfile;
  fetcher?: FetchLike;
}): Promise<CodexMcpOAuthPreflight> => {
  const capabilityProfile = input.capabilityProfile ?? "g2-action";
  const requiredScopes = capabilityProfile === "g8-monitor"
    ? REQUIRED_G8_MONITOR_SCOPES
    : REQUIRED_G2_SCOPES;
  const baseUrl = new URL(input.baseUrl ?? DEFAULT_BASE_URL);
  if (!new Set(["http:", "https:"]).has(baseUrl.protocol)) {
    throw new Error("codex_mcp_oauth_base_url_invalid");
  }
  const basePath = baseUrl.pathname.replace(/\/+$/u, "");
  const callbackPort = input.callbackPort ?? DEFAULT_CALLBACK_PORT;
  if (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65_535) {
    throw new Error("codex_mcp_oauth_callback_port_invalid");
  }
  const callbackUrl = `http://127.0.0.1:${callbackPort}/callback`;
  const derivedCallbackCandidate = input.derivedCallbackUrl?.trim() ?? "";
  let derivedCallbackUrl: string | null = null;
  if (derivedCallbackCandidate) {
    let parsed: URL;
    try {
      parsed = new URL(derivedCallbackCandidate);
    } catch {
      throw new Error("codex_mcp_derived_callback_url_invalid");
    }
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      Number(parsed.port) !== callbackPort ||
      !/^\/callback\/[A-Za-z0-9_-]{6,128}$/u.test(parsed.pathname) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("codex_mcp_derived_callback_url_invalid");
    }
    derivedCallbackUrl = parsed.toString();
  }
  const protectedResourceMetadataUrl =
    `${baseUrl.origin}${basePath}/.well-known/oauth-protected-resource/mcp`;
  const fetcher = input.fetcher ?? fetch;
  const protectedResource = await fetchJson(
    fetcher,
    protectedResourceMetadataUrl,
    "codex_mcp_protected_resource_discovery_failed",
  );
  const resource = requiredString(
    protectedResource.resource,
    "codex_mcp_resource_missing",
  );
  const authorizationServer = requiredString(
    strings(protectedResource.authorization_servers)[0],
    "codex_mcp_authorization_server_missing",
  );
  const authorizationServerMetadataUrl =
    `${authorizationServer.replace(/\/$/u, "")}/.well-known/openid-configuration`;
  const discovery = await fetchJson(
    fetcher,
    authorizationServerMetadataUrl,
    "codex_mcp_authorization_server_discovery_failed",
  );
  const advertisedScopes = new Set([
    ...strings(protectedResource.scopes_supported),
    ...strings(discovery.scopes_supported),
  ]);
  const missingScopes = requiredScopes.filter(
    (scope) => !advertisedScopes.has(scope),
  );
  const pkceS256Supported = strings(
    discovery.code_challenge_methods_supported,
  ).includes("S256");
  if (!discovery.authorization_endpoint || !discovery.token_endpoint) {
    throw new Error("codex_mcp_authorization_code_endpoints_missing");
  }
  if (!discovery.jwks_uri) throw new Error("codex_mcp_jwks_uri_missing");
  if (!pkceS256Supported) throw new Error("codex_mcp_pkce_s256_missing");
  if (missingScopes.length > 0) {
    throw new Error(`codex_mcp_required_scopes_missing:${missingScopes.join(",")}`);
  }
  const oauthClientIdConfigured = Boolean(input.oauthClientId?.trim());
  const status: CodexMcpOAuthPreflight["status"] = !oauthClientIdConfigured
    ? "client_registration_required"
    : !derivedCallbackUrl
      ? "derived_callback_registration_required"
      : "ready_for_interactive_login";
  return {
    schema: "casimirbot.codex_mcp_oauth_preflight.v1",
    capability_profile: capabilityProfile,
    status,
    resource,
    resource_discovery_authoritative: true,
    oauth_resource_override_required: false,
    authorization_server: authorizationServer,
    protected_resource_metadata_url: protectedResourceMetadataUrl,
    authorization_server_metadata_url: authorizationServerMetadataUrl,
    authorization_endpoint_present: true,
    token_endpoint_present: true,
    jwks_uri_present: true,
    pkce_s256_supported: true,
    registration_endpoint_advertised: Boolean(discovery.registration_endpoint),
    // Discovery can advertise an endpoint even when the tenant rejects DCR.
    // This observer deliberately performs no registration request.
    dynamic_registration_verified: false,
    required_scopes: [...requiredScopes],
    missing_scopes: [],
    oauth_client_id_configured: oauthClientIdConfigured,
    oauth_client_secret_required: false,
    callback_port: callbackPort,
    callback_base_url: callbackUrl,
    callback_url: callbackUrl,
    derived_callback_url: derivedCallbackUrl,
    derived_callback_valid: Boolean(derivedCallbackUrl),
    next_action: status === "client_registration_required"
      ? "Create one Auth0 Native/public client, then derive and register Codex's exact server-specific callback URL."
      : status === "derived_callback_registration_required"
        ? "Run one Codex MCP login to obtain its server-specific callback URL, register that exact URL with Auth0, then rerun this preflight."
        : "Run native Codex MCP login without an oauth_resource override and complete Auth0 Universal Login.",
    mutating_request_performed: false,
    credentials_included: false,
  };
};

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name.slice(2).replaceAll("-", "_")}_missing`);
  }
  return value;
};

const run = async (): Promise<void> => {
  const callbackPortRaw = option("--callback-port");
  const capabilityProfileRaw = option("--capability-profile");
  if (
    capabilityProfileRaw !== undefined &&
    capabilityProfileRaw !== "g2-action" &&
    capabilityProfileRaw !== "g8-monitor"
  ) {
    throw new Error("capability_profile_invalid");
  }
  const result = await inspectCodexMcpOAuthReadiness({
    baseUrl: option("--base-url"),
    oauthClientId: option("--oauth-client-id"),
    callbackPort: callbackPortRaw === undefined
      ? undefined
      : Number(callbackPortRaw),
    derivedCallbackUrl: option("--derived-callback-url"),
    capabilityProfile: capabilityProfileRaw,
  });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const outputPath = option("--out");
  if (outputPath) {
    const resolvedOutput = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
    await fs.writeFile(resolvedOutput, serialized, "utf8");
  }
  process.stdout.write(serialized);
  if (result.status !== "ready_for_interactive_login") process.exitCode = 2;
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
