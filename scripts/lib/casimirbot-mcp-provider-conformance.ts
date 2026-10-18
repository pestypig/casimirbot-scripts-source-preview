
export const CASIMIRBOT_MCP_CONFORMANCE_SCHEMA =
  "casimirbot.mcp_provider_conformance.v1" as const;

export const CASIMIRBOT_MCP_PROTOCOL_VERSION = "2025-06-18" as const;

export const CASIMIRBOT_CORE_MCP_TOOLS = [
  "helix_run_start",
  "helix_run_evidence_reenter",
  "helix_run_continue",
  "helix_run_inspect",
  "helix_run_fetch_evidence",
  "helix_run_list_events",
  "helix_run_cancel",
] as const;

export const CASIMIRBOT_FREE_READ_MCP_TOOLS = [
  "helix_workstation_capability_list",
  "helix_public_ui_catalog",
] as const;

export type CasimirbotCoreMcpTool =
  (typeof CASIMIRBOT_CORE_MCP_TOOLS)[number];

export type ConformanceCheckStatus = "pass" | "fail" | "skipped";
export type ConformanceSectionStatus = ConformanceCheckStatus;
export type ConformanceOverallStatus = "pass" | "fail" | "partial";

export type ConformanceCheck = {
  id: string;
  status: ConformanceCheckStatus;
  summary: string;
  reason_code?: string;
  evidence?: Record<string, unknown>;
};

export type ConformanceSection = {
  status: ConformanceSectionStatus;
  checks: ConformanceCheck[];
};

export type CasimirbotMcpConformanceReport = {
  schema: typeof CASIMIRBOT_MCP_CONFORMANCE_SCHEMA;
  generated_at: string;
  status: ConformanceOverallStatus;
  target: {
    public_base_url: string;
    mcp_url: string;
  };
  configuration: {
    loopback_http_allowed: boolean;
    mcp_access_configured: boolean;
    openai_provider_configured: boolean;
    gemini_provider_configured: boolean;
    expected_account_type: "user" | "developer" | null;
  };
  bounded_core_tools: readonly CasimirbotCoreMcpTool[];
  sections: {
    public_discovery: ConformanceSection;
    oauth_challenge: ConformanceSection;
    authenticated_mcp: ConformanceSection;
    openai_responses: ConformanceSection;
    gemini_interactions: ConformanceSection;
  };
};

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type HttpRequestDescriptor = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

type RecordLike = Record<string, unknown>;

type ProbeEnvironment = Record<string, string | undefined>;

type ProbeOptions = {
  env?: ProbeEnvironment;
  fetchImpl?: FetchLike;
  now?: () => Date;
};

type ProbeConfig = {
  allowLoopbackHttp: boolean;
  publicBaseUrl: string;
  mcpUrl: string;
  protectedResourceUrl: string;
  accessToken: string | null;
  openAiApiKey: string | null;
  geminiApiKey: string | null;
  openAiModel: string;
  geminiModel: string;
  openAiResponsesUrl: string;
  geminiInteractionsUrl: string;
  timeoutMs: number;
  expectedAccountType: "user" | "developer" | null;
};

type HttpResult = {
  ok: boolean;
  status: number;
  contentType: string | null;
  headers: Headers;
  body: unknown;
  rawText: string;
};

type ToolPolicy = {
  scope: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
};

export type CoreToolCatalogIssue = {
  tool: CasimirbotCoreMcpTool;
  code:
    | "missing_tool"
    | "missing_title"
    | "missing_description"
    | "invalid_input_schema"
    | "invalid_output_schema"
    | "invalid_annotations"
    | "missing_oauth_security_scheme"
    | "unexpected_noauth_security_scheme";
  message: string;
};

const CORE_TOOL_POLICIES: Record<CasimirbotCoreMcpTool, ToolPolicy> = {
  helix_run_start: {
    scope: "helix.agent_runs.write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  helix_run_evidence_reenter: {
    scope: "helix.agent_runs.write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  helix_run_continue: {
    scope: "helix.agent_runs.write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  helix_run_inspect: {
    scope: "helix.agent_runs.read",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  helix_run_fetch_evidence: {
    scope: "helix.agent_runs.read",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  helix_run_list_events: {
    scope: "helix.agent_runs.read",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  helix_run_cancel: {
    scope: "helix.agent_runs.write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
};

const asRecord = (value: unknown): RecordLike | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const trimTrailingSlashes = (value: string): string =>
  value.replace(/\/+$/u, "");

const normalizePublicUrl = (
  value: string,
  label: string,
  allowLoopbackHttp = false,
): string => {
  const parsed = new URL(value);
  const loopbackHost = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])
    .has(parsed.hostname.toLowerCase());
  if (
    parsed.protocol !== "https:" &&
    !(
      allowLoopbackHttp &&
      parsed.protocol === "http:" &&
      loopbackHost
    )
  ) {
    throw new Error(
      `${label} must use HTTPS; explicitly opted-in HTTP is limited to loopback.`,
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      `${label} must not contain credentials, query parameters, or a fragment.`,
    );
  }
  return trimTrailingSlashes(parsed.toString());
};

const optionalSecret = (value: string | undefined): string | null => {
  const normalized = value?.trim();
  return normalized ? normalized : null;
};

const parseTimeout = (value: string | undefined): number => {
  if (!value) return 120_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 600_000) {
    throw new Error(
      "CASIMIRBOT_MCP_CONFORMANCE_TIMEOUT_MS must be an integer from 1000 to 600000.",
    );
  }
  return parsed;
};

const parseExpectedAccountType = (
  value: string | undefined,
): "user" | "developer" | null => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "user" || normalized === "developer") return normalized;
  throw new Error("CASIMIRBOT_MCP_EXPECT_ACCOUNT_TYPE must be user or developer.");
};

const resolveProbeConfig = (env: ProbeEnvironment): ProbeConfig => {
  const allowLoopbackHttp =
    env.CASIMIRBOT_MCP_CONFORMANCE_ALLOW_LOOPBACK_HTTP === "1";
  const publicBaseUrl = normalizePublicUrl(
    env.CASIMIRBOT_MCP_PUBLIC_BASE_URL ??
      env.CASIMIR_PUBLIC_BASE_URL ??
      "https://casimirbot.com",
    "CasimirBot public base URL",
    allowLoopbackHttp,
  );
  const mcpUrl = normalizePublicUrl(
    env.CASIMIRBOT_MCP_URL ?? `${publicBaseUrl}/mcp`,
    "CasimirBot MCP URL",
    allowLoopbackHttp,
  );
  const protectedResourceUrl = normalizePublicUrl(
    env.CASIMIRBOT_MCP_PROTECTED_RESOURCE_URL ??
      `${publicBaseUrl}/.well-known/oauth-protected-resource/mcp`,
    "CasimirBot protected-resource metadata URL",
    allowLoopbackHttp,
  );
  return {
    allowLoopbackHttp,
    publicBaseUrl,
    mcpUrl,
    protectedResourceUrl,
    accessToken: optionalSecret(env.CASIMIRBOT_MCP_ACCESS_TOKEN),
    openAiApiKey: optionalSecret(env.OPENAI_API_KEY),
    geminiApiKey: optionalSecret(env.GEMINI_API_KEY),
    openAiModel:
      env.CASIMIRBOT_OPENAI_MCP_MODEL?.trim() || "gpt-5.4-mini",
    geminiModel:
      env.CASIMIRBOT_GEMINI_MCP_MODEL?.trim() || "gemini-3.8-flash",
    openAiResponsesUrl: normalizePublicUrl(
      env.CASIMIRBOT_OPENAI_RESPONSES_URL ??
        "https://api.openai.com/v1/responses",
      "OpenAI Responses URL",
    ),
    geminiInteractionsUrl: normalizePublicUrl(
      env.CASIMIRBOT_GEMINI_INTERACTIONS_URL ??
        "https://generativelanguage.googleapis.com/v1beta/interactions",
      "Gemini Interactions URL",
    ),
    timeoutMs: parseTimeout(env.CASIMIRBOT_MCP_CONFORMANCE_TIMEOUT_MS),
    expectedAccountType: parseExpectedAccountType(env.CASIMIRBOT_MCP_EXPECT_ACCOUNT_TYPE),
  };
};

const sensitiveKeyPattern =
  /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|credential/iu;

const redactString = (value: string, secrets: readonly string[]): string => {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(
      /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/giu,
      "Bearer [REDACTED]",
    )
    .replace(
      /([?&](?:key|api_key|access_token)=)[^&\s#]+/giu,
      "$1[REDACTED]",
    )
    .replace(
      /((?:authorization|x-goog-api-key|api[-_]?key|access[-_]?token)\s*[:=]\s*["']?)([^,\s"'}]+)/giu,
      "$1[REDACTED]",
    );
};

export const redactSecrets = (
  value: unknown,
  secrets: readonly string[] = [],
): unknown => {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): unknown => {
    if (typeof candidate === "string") {
      return redactString(candidate, secrets);
    }
    if (
      candidate === null ||
      typeof candidate !== "object"
    ) {
      return candidate;
    }
    if (seen.has(candidate)) return "[CIRCULAR]";
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.map(visit);
    const output: RecordLike = {};
    for (const [key, nested] of Object.entries(candidate as RecordLike)) {
      output[key] = sensitiveKeyPattern.test(key)
        ? "[REDACTED]"
        : visit(nested);
    }
    return output;
  };
  return visit(value);
};

const normalizedError = (
  error: unknown,
  secrets: readonly string[],
): string => {
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  return redactString(message, secrets).slice(0, 2_000);
};

const pass = (
  id: string,
  summary: string,
  evidence?: Record<string, unknown>,
): ConformanceCheck => ({
  id,
  status: "pass",
  summary,
  ...(evidence ? { evidence } : {}),
});

const fail = (
  id: string,
  summary: string,
  reasonCode: string,
  evidence?: Record<string, unknown>,
): ConformanceCheck => ({
  id,
  status: "fail",
  summary,
  reason_code: reasonCode,
  ...(evidence ? { evidence } : {}),
});

const skipped = (
  id: string,
  summary: string,
  missingEnvironmentVariables: string[],
): ConformanceCheck => ({
  id,
  status: "skipped",
  summary,
  reason_code: "not_configured",
  evidence: {
    missing_environment_variables: missingEnvironmentVariables,
  },
});

export const summarizeConformanceSection = (
  checks: ConformanceCheck[],
): ConformanceSection => ({
  status: checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.every((check) => check.status === "skipped")
      ? "skipped"
      : "pass",
  checks,
});

const summarizeOverall = (
  sections: CasimirbotMcpConformanceReport["sections"],
): ConformanceOverallStatus => {
  const values = Object.values(sections).map((section) => section.status);
  if (values.includes("fail")) return "fail";
  if (values.includes("skipped")) return "partial";
  return "pass";
};

const parseSseJson = (value: string): unknown => {
  const payloads = value
    .split(/\r?\n\r?\n/gu)
    .flatMap((event) =>
      event
        .split(/\r?\n/gu)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim()),
    )
    .filter((entry) => entry && entry !== "[DONE]");
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(payloads[index]);
    } catch {
      // Continue until a JSON event is found.
    }
  }
  return null;
};

const parseHttpBody = (rawText: string, contentType: string | null): unknown => {
  if (!rawText) return null;
  if (contentType?.includes("text/event-stream")) {
    return parseSseJson(rawText);
  }
  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
};

const request = async (
  fetchImpl: FetchLike,
  descriptor: HttpRequestDescriptor,
  timeoutMs: number,
): Promise<HttpResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(descriptor.url, {
      method: "POST",
      headers: descriptor.headers,
      body: JSON.stringify(descriptor.body),
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type");
    const rawText = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      contentType,
      headers: response.headers,
      body: parseHttpBody(rawText, contentType),
      rawText,
    };
  } finally {
    clearTimeout(timeout);
  }
};

const get = async (
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
): Promise<HttpResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type");
    const rawText = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      contentType,
      headers: response.headers,
      body: parseHttpBody(rawText, contentType),
      rawText,
    };
  } finally {
    clearTimeout(timeout);
  }
};

const httpFailureEvidence = (
  result: HttpResult,
  secrets: readonly string[],
): Record<string, unknown> => ({
  http_status: result.status,
  content_type: result.contentType,
  response_excerpt: redactSecrets(result.body, secrets),
});

export const buildMcpJsonRpcRequest = (input: {
  mcpUrl: string;
  id: string | number;
  method: "initialize" | "tools/list" | "tools/call";
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  accessToken?: string | null;
}): HttpRequestDescriptor => ({
  url: input.mcpUrl,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": CASIMIRBOT_MCP_PROTOCOL_VERSION,
    ...(input.accessToken
      ? { Authorization: `Bearer ${input.accessToken}` }
      : {}),
  },
  body: {
    jsonrpc: "2.0",
    id: input.id,
    method: input.method,
    params:
      input.method === "initialize"
        ? {
            protocolVersion: CASIMIRBOT_MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
              name: "casimirbot-provider-conformance",
              version: "1.0.0",
            },
          }
        : input.method === "tools/call"
          ? { name: input.toolName, arguments: input.toolArguments ?? {} }
          : {},
  },
});

const PROVIDER_READ_TOOL = "helix_public_ui_catalog" as const;
const PROVIDER_READ_ARGUMENTS = {
  search: "agent-access",
  include_capabilities: false,
  include_mcp_bindings: false,
} as const;

export const providerReadToolIsAdmitted = (tools: unknown): boolean => {
  if (!Array.isArray(tools)) return false;
  const tool = tools.map(asRecord).find((candidate) =>
    candidate?.name === PROVIDER_READ_TOOL);
  if (!tool || asRecord(tool.inputSchema)?.type !== "object" ||
      asRecord(tool.outputSchema)?.type !== "object") return false;
  const annotations = asRecord(tool.annotations);
  if (annotations?.readOnlyHint !== true || annotations?.destructiveHint !== false) return false;
  const schemes = Array.isArray(tool.securitySchemes)
    ? tool.securitySchemes.map(asRecord)
    : [];
  return schemes.some((scheme) => scheme?.type === "oauth2" &&
    asStringArray(scheme.scopes).includes("helix.agent_runs.read")) &&
    !schemes.some((scheme) => scheme?.type === "noauth");
};

const providerPrompt = (
  provider: "openai_responses" | "gemini_interactions",
): string =>
  [
    "Run a bounded remote-MCP transport conformance check.",
    `Call the only admitted read-only tool, ${PROVIDER_READ_TOOL}, exactly once with these JSON arguments: ${JSON.stringify(PROVIDER_READ_ARGUMENTS)}.`,
    "Do not call any other tool or start a hosted run.",
    "After the tool returns, state only whether the receipt preserved answer_authority=false, assistant_answer=false, and terminal_eligible=false.",
    `Provider route under test: ${provider}.`,
  ].join("\n");

export const buildOpenAiResponsesRequest = (input: {
  apiKey: string;
  accessToken: string;
  mcpUrl: string;
  model: string;
  responsesUrl?: string;
}): HttpRequestDescriptor => {
  return {
    url: input.responsesUrl ?? "https://api.openai.com/v1/responses",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: {
      model: input.model,
      input: providerPrompt("openai_responses"),
      max_output_tokens: 800,
      tools: [
        {
          type: "mcp",
          server_label: "casimirbot",
          server_description:
            "CasimirBot public UI catalog observation. Tool output is supporting evidence, not terminal answer authority.",
          server_url: input.mcpUrl,
          authorization: input.accessToken,
          allowed_tools: [PROVIDER_READ_TOOL],
          require_approval: "never",
        },
      ],
    },
  };
};

export const buildGeminiInteractionsRequest = (input: {
  apiKey: string;
  accessToken: string;
  mcpUrl: string;
  model: string;
  interactionsUrl?: string;
}): HttpRequestDescriptor => {
  return {
    url:
      input.interactionsUrl ??
      "https://generativelanguage.googleapis.com/v1beta/interactions",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": input.apiKey,
    },
    body: {
      model: input.model,
      input: providerPrompt("gemini_interactions"),
      tools: [
        {
          type: "mcp_server",
          name: "casimirbot",
          url: input.mcpUrl,
          headers: {
            Authorization: `Bearer ${input.accessToken}`,
          },
          allowed_tools: [PROVIDER_READ_TOOL],
        },
      ],
      generation_config: {
        max_output_tokens: 800,
        tool_choice: "any",
      },
    },
  };
};

export const validateCoreToolCatalog = (
  tools: unknown,
): CoreToolCatalogIssue[] => {
  const toolRecords = Array.isArray(tools)
    ? tools.map(asRecord).filter((tool): tool is RecordLike => tool !== null)
    : [];
  const byName = new Map(
    toolRecords
      .filter((tool) => typeof tool.name === "string")
      .map((tool) => [tool.name as string, tool]),
  );
  const issues: CoreToolCatalogIssue[] = [];

  for (const name of CASIMIRBOT_CORE_MCP_TOOLS) {
    const tool = byName.get(name);
    const policy = CORE_TOOL_POLICIES[name];
    if (!tool) {
      issues.push({
        tool: name,
        code: "missing_tool",
        message: `${name} is absent from the authenticated tools/list result.`,
      });
      continue;
    }
    if (typeof tool.title !== "string" || !tool.title.trim()) {
      issues.push({
        tool: name,
        code: "missing_title",
        message: `${name} must publish a non-empty title.`,
      });
    }
    if (typeof tool.description !== "string" || !tool.description.trim()) {
      issues.push({
        tool: name,
        code: "missing_description",
        message: `${name} must publish a non-empty description.`,
      });
    }
    const inputSchema = asRecord(tool.inputSchema);
    if (!inputSchema || inputSchema.type !== "object") {
      issues.push({
        tool: name,
        code: "invalid_input_schema",
        message: `${name} must publish an object inputSchema.`,
      });
    }
    const outputSchema = asRecord(tool.outputSchema);
    if (!outputSchema || outputSchema.type !== "object") {
      issues.push({
        tool: name,
        code: "invalid_output_schema",
        message: `${name} must publish an object outputSchema.`,
      });
    }
    const annotations = asRecord(tool.annotations);
    if (
      !annotations ||
      Object.entries(policy.annotations).some(
        ([key, expected]) => annotations[key] !== expected,
      )
    ) {
      issues.push({
        tool: name,
        code: "invalid_annotations",
        message: `${name} annotations do not match its bounded side-effect policy.`,
      });
    }
    const securitySchemes = Array.isArray(tool.securitySchemes)
      ? tool.securitySchemes.map(asRecord).filter(
          (scheme): scheme is RecordLike => scheme !== null,
        )
      : [];
    if (securitySchemes.some((scheme) => scheme.type === "noauth")) {
      issues.push({
        tool: name,
        code: "unexpected_noauth_security_scheme",
        message: `${name} must not advertise anonymous invocation.`,
      });
    }
    const hasRequiredOAuthScheme = securitySchemes.some(
      (scheme) =>
        scheme.type === "oauth2" &&
        asStringArray(scheme.scopes).includes(policy.scope),
    );
    if (!hasRequiredOAuthScheme) {
      issues.push({
        tool: name,
        code: "missing_oauth_security_scheme",
        message: `${name} must advertise OAuth scope ${policy.scope}.`,
      });
    }
  }
  return issues;
};

const probePublicDiscovery = async (
  config: ProbeConfig,
  fetchImpl: FetchLike,
  secrets: readonly string[],
): Promise<ConformanceSection> => {
  const checks: ConformanceCheck[] = [];
  for (const [id, accept] of [
    ["discovery.browser_mcp_link", "text/html"],
    ["discovery.generic_mcp_link", "*/*"],
  ] as const) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      let linkResponse: Response;
      try {
        linkResponse = await fetchImpl(config.mcpUrl, {
          method: "GET",
          headers: { Accept: accept },
          redirect: "manual",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      const location = linkResponse.headers.get("location");
      const expectedLocation = `${config.publicBaseUrl}/agent-access`;
      if (id === "discovery.browser_mcp_link") {
        checks.push(linkResponse.status === 303 &&
          (location === "/agent-access" || location === expectedLocation)
          ? pass(id, "An explicit HTML request opens public connection guidance.", {
              http_status: linkResponse.status, location, accept,
            })
          : fail(id, "The explicit HTML request did not open public connection guidance.",
              "link_not_public_guidance", {
                http_status: linkResponse.status,
                location: location === "/agent-access" || location === expectedLocation ? location : null,
                accept,
              }));
      } else {
        const challenge = linkResponse.headers.get("www-authenticate") ?? "";
        const validChallenge = linkResponse.status === 401 &&
          challenge.includes("Bearer") &&
          challenge.includes(`${config.publicBaseUrl}/.well-known/oauth-protected-resource/mcp`);
        checks.push(validChallenge
          ? pass(id, "A generic MCP request receives the OAuth resource challenge.", {
              http_status: linkResponse.status, accept, bearer_challenge: true,
            })
          : fail(id, "A generic MCP request did not receive the OAuth resource challenge.",
              "missing_oauth_challenge", {
                http_status: linkResponse.status, accept, bearer_challenge: challenge.includes("Bearer"),
              }));
      }
    } catch {
      checks.push(fail(id, "The MCP URL could not be reached by a retrieval client.",
        "link_unreachable", { accept }));
    }
  }
  try {
    const manifestUrl = `${config.publicBaseUrl}/agent-access.json`;
    const manifestResult = await get(fetchImpl, manifestUrl, config.timeoutMs);
    if (!manifestResult.ok) {
      checks.push(
        fail(
          "discovery.agent_access_manifest",
          "The Agent Access manifest request failed.",
          "http_error",
          httpFailureEvidence(manifestResult, secrets),
        ),
      );
    } else {
      const manifest = asRecord(manifestResult.body);
      const connection = asRecord(manifest?.connection);
      const mcp = asRecord(manifest?.mcp);
      const manifestTools = asStringArray(mcp?.tools);
      const manifestFreeReadTools = asStringArray(mcp?.free_read_tools);
      const expectedTools = [...CASIMIRBOT_CORE_MCP_TOOLS].sort();
      const expectedFreeReadTools = [...CASIMIRBOT_FREE_READ_MCP_TOOLS].sort();
      const valid =
        manifest?.metadata_kind === "casimirbot.agent_access" &&
        manifest?.standard === false &&
        connection?.explicit_configuration_required === true &&
        connection?.retrieval_only_clients_can_invoke === false &&
        mcp?.url === config.mcpUrl &&
        mcp?.transport === "streamable_http" &&
        JSON.stringify([...manifestTools].sort()) ===
          JSON.stringify(expectedTools) &&
        JSON.stringify([...manifestFreeReadTools].sort()) ===
          JSON.stringify(expectedFreeReadTools);
      checks.push(
        valid
          ? pass(
              "discovery.agent_access_manifest",
              "Agent Access discovery distinguishes retrieval from an explicitly configured Streamable HTTP connection.",
              {
                manifest_url: manifestUrl,
                mcp_url: config.mcpUrl,
                core_tools: expectedTools,
                free_read_tools: expectedFreeReadTools,
              },
            )
          : fail(
              "discovery.agent_access_manifest",
              "The Agent Access manifest does not match the provider-neutral MCP contract.",
              "manifest_contract_mismatch",
              {
                http_status: manifestResult.status,
                metadata_kind: manifest?.metadata_kind ?? null,
                standard: manifest?.standard ?? null,
                explicit_configuration_required:
                  connection?.explicit_configuration_required ?? null,
                retrieval_only_clients_can_invoke:
                  connection?.retrieval_only_clients_can_invoke ?? null,
                mcp_url: mcp?.url ?? null,
                transport: mcp?.transport ?? null,
                tools: manifestTools,
                free_read_tools: manifestFreeReadTools,
              },
            ),
      );
    }
  } catch (error) {
    checks.push(
      fail(
        "discovery.agent_access_manifest",
        "The Agent Access manifest could not be read.",
        "request_failed",
        { error: normalizedError(error, secrets) },
      ),
    );
  }

  try {
    const metadataResult = await get(
      fetchImpl,
      config.protectedResourceUrl,
      config.timeoutMs,
    );
    if (!metadataResult.ok) {
      checks.push(
        fail(
          "discovery.oauth_protected_resource",
          "OAuth protected-resource metadata request failed.",
          "http_error",
          httpFailureEvidence(metadataResult, secrets),
        ),
      );
    } else {
      const metadata = asRecord(metadataResult.body);
      const authorizationServers = asStringArray(
        metadata?.authorization_servers,
      );
      const scopes = asStringArray(metadata?.scopes_supported);
      const valid =
        metadata?.resource === config.mcpUrl &&
        authorizationServers.length > 0 &&
        authorizationServers.every((url) => {
          try {
            return new URL(url).protocol === "https:";
          } catch {
            return false;
          }
        }) &&
        scopes.includes("helix.agent_runs.read") &&
        scopes.includes("helix.agent_runs.write");
      checks.push(
        valid
          ? pass(
              "discovery.oauth_protected_resource",
              "OAuth protected-resource metadata identifies the MCP audience, authorization server, and core scopes.",
              {
                metadata_url: config.protectedResourceUrl,
                resource: metadata?.resource,
                authorization_server_count: authorizationServers.length,
                core_scopes: [
                  "helix.agent_runs.read",
                  "helix.agent_runs.write",
                ],
              },
            )
          : fail(
              "discovery.oauth_protected_resource",
              "OAuth protected-resource metadata is incomplete or identifies a different MCP audience.",
              "oauth_metadata_mismatch",
              {
                http_status: metadataResult.status,
                resource: metadata?.resource ?? null,
                authorization_servers: authorizationServers,
                scopes_supported: scopes,
              },
            ),
      );
    }
  } catch (error) {
    checks.push(
      fail(
        "discovery.oauth_protected_resource",
        "OAuth protected-resource metadata could not be read.",
        "request_failed",
        { error: normalizedError(error, secrets) },
      ),
    );
  }
  return summarizeConformanceSection(checks);
};

const challengeMetadataUrl = (header: string | null): string | null => {
  if (!header) return null;
  const match = header.match(/\bresource_metadata="([^"]+)"/iu);
  return match?.[1] ?? null;
};

const probeOAuthChallenge = async (
  config: ProbeConfig,
  fetchImpl: FetchLike,
  secrets: readonly string[],
): Promise<ConformanceSection> => {
  const id = "oauth.unauthenticated_mcp_challenge";
  try {
    const result = await request(
      fetchImpl,
      buildMcpJsonRpcRequest({
        mcpUrl: config.mcpUrl,
        id: "oauth-challenge",
        method: "initialize",
      }),
      config.timeoutMs,
    );
    const challenge = result.headers.get("www-authenticate");
    const metadataUrl = challengeMetadataUrl(challenge);
    const allowedMetadataUrls = new Set([
      config.protectedResourceUrl,
      `${config.publicBaseUrl}/.well-known/oauth-protected-resource`,
    ]);
    const body = asRecord(result.body);
    const valid =
      result.status === 401 &&
      !result.contentType?.includes("text/html") &&
      challenge?.startsWith("Bearer ") === true &&
      challenge.includes('error="invalid_token"') &&
      challenge.includes('error_description="') &&
      metadataUrl !== null &&
      allowedMetadataUrls.has(trimTrailingSlashes(metadataUrl)) &&
      body?.error === "unauthorized";
    return summarizeConformanceSection([
      valid
        ? pass(
            id,
            "The unauthenticated MCP resource returns a typed OAuth challenge instead of the website shell.",
            {
              http_status: result.status,
              content_type: result.contentType,
              resource_metadata_url: metadataUrl,
              error: body?.error,
            },
          )
        : fail(
            id,
            "The unauthenticated MCP response does not satisfy the OAuth challenge contract.",
            "oauth_challenge_mismatch",
            {
              http_status: result.status,
              content_type: result.contentType,
              has_bearer_challenge: challenge?.startsWith("Bearer ") ?? false,
              resource_metadata_url: metadataUrl,
              response: redactSecrets(result.body, secrets),
            },
          ),
    ]);
  } catch (error) {
    return summarizeConformanceSection([
      fail(id, "The OAuth challenge request failed.", "request_failed", {
        error: normalizedError(error, secrets),
      }),
    ]);
  }
};

const probeAuthenticatedMcp = async (
  config: ProbeConfig,
  fetchImpl: FetchLike,
  secrets: readonly string[],
): Promise<ConformanceSection> => {
  if (!config.accessToken) {
    return summarizeConformanceSection([
      skipped(
        "mcp.initialize_and_tools_list",
        "Authenticated MCP initialize and tools/list were not run because no access token is configured.",
        ["CASIMIRBOT_MCP_ACCESS_TOKEN"],
      ),
    ]);
  }
  const checks: ConformanceCheck[] = [];
  let providerToolReady = false;
  try {
    const initialized = await request(
      fetchImpl,
      buildMcpJsonRpcRequest({
        mcpUrl: config.mcpUrl,
        id: "initialize",
        method: "initialize",
        accessToken: config.accessToken,
      }),
      config.timeoutMs,
    );
    const envelope = asRecord(initialized.body);
    const result = asRecord(envelope?.result);
    const serverInfo = asRecord(result?.serverInfo);
    const instructions =
      typeof result?.instructions === "string" ? result.instructions : "";
    const valid =
      initialized.ok &&
      envelope?.jsonrpc === "2.0" &&
      serverInfo?.name === "casimirbot-helix-agent" &&
      typeof result?.protocolVersion === "string" &&
      instructions.includes("run_id") &&
      instructions.includes("terminal_authority_status");
    checks.push(
      valid
        ? pass(
            "mcp.initialize",
            "The authenticated MCP initialize exchange returns the Helix server identity and terminal-authority instructions.",
            {
              http_status: initialized.status,
              server_name: serverInfo?.name,
              server_version: serverInfo?.version ?? null,
              protocol_version: result?.protocolVersion,
            },
          )
        : fail(
            "mcp.initialize",
            "The authenticated MCP initialize exchange is incomplete or invalid.",
            "initialize_contract_mismatch",
            initialized.ok
              ? {
                  http_status: initialized.status,
                  server_name: serverInfo?.name ?? null,
                  protocol_version: result?.protocolVersion ?? null,
                  has_run_id_instruction: instructions.includes("run_id"),
                  has_terminal_authority_instruction: instructions.includes(
                    "terminal_authority_status",
                  ),
                }
              : httpFailureEvidence(initialized, secrets),
          ),
    );
  } catch (error) {
    checks.push(
      fail(
        "mcp.initialize",
        "The authenticated MCP initialize request failed.",
        "request_failed",
        { error: normalizedError(error, secrets) },
      ),
    );
  }

  try {
    const listed = await request(
      fetchImpl,
      buildMcpJsonRpcRequest({
        mcpUrl: config.mcpUrl,
        id: "tools-list",
        method: "tools/list",
        accessToken: config.accessToken,
      }),
      config.timeoutMs,
    );
    const envelope = asRecord(listed.body);
    const result = asRecord(envelope?.result);
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    const issues = validateCoreToolCatalog(tools);
    providerToolReady = listed.ok && providerReadToolIsAdmitted(tools);
    const toolNames = tools
      .map(asRecord)
      .filter((tool): tool is RecordLike => tool !== null)
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === "string");
    checks.push(
      listed.ok && issues.length === 0
        ? pass(
            "mcp.tools_list",
            "The authenticated catalog publishes every bounded core tool with typed schemas, side-effect annotations, and per-tool OAuth policy.",
            {
              http_status: listed.status,
              core_tools: [...CASIMIRBOT_CORE_MCP_TOOLS],
              advertised_tool_count: toolNames.length,
              additional_tools: toolNames.filter(
                (name) =>
                  !CASIMIRBOT_CORE_MCP_TOOLS.includes(
                    name as CasimirbotCoreMcpTool,
                  ),
              ),
            },
          )
        : fail(
            "mcp.tools_list",
            "The authenticated MCP tool catalog does not satisfy the bounded core-tool metadata contract.",
            listed.ok ? "tool_catalog_mismatch" : "http_error",
            listed.ok
              ? {
                  advertised_tools: toolNames,
                  issues,
                }
              : httpFailureEvidence(listed, secrets),
          ),
    );
    checks.push(providerToolReady
      ? pass("mcp.provider_read_tool", "The public read-only catalog tool is present with typed schemas and run-read OAuth policy.")
      : fail("mcp.provider_read_tool", "The public provider tool is absent or lacks its read-only OAuth contract.",
          "provider_tool_unavailable", { http_status: listed.status }));
  } catch (error) {
    checks.push(
      fail(
        "mcp.tools_list",
        "The authenticated MCP tools/list request failed.",
        "request_failed",
        { error: normalizedError(error, secrets) },
      ),
    );
    checks.push(fail("mcp.provider_read_tool", "The public provider tool could not be checked.",
      "provider_tool_unavailable"));
  }
  if (providerToolReady) {
    try {
      const called = await request(fetchImpl, buildMcpJsonRpcRequest({
        mcpUrl: config.mcpUrl,
        id: "provider-read",
        method: "tools/call",
        toolName: PROVIDER_READ_TOOL,
        toolArguments: PROVIDER_READ_ARGUMENTS,
        accessToken: config.accessToken,
      }), config.timeoutMs);
      const result = asRecord(asRecord(called.body)?.result);
      const valid = called.ok && result?.isError !== true &&
        readCatalogSucceeded(result?.structuredContent);
      checks.push(valid
        ? pass("mcp.provider_read_call", "The ordinary authenticated MCP call returned a bounded, non-authoritative public catalog receipt.")
        : fail("mcp.provider_read_call", "The authenticated public catalog call did not return its required receipt.",
            "provider_read_call_failed", { http_status: called.status, is_error: result?.isError === true }));
    } catch (error) {
      checks.push(fail("mcp.provider_read_call", "The authenticated public catalog call failed.",
        "request_failed", { error: normalizedError(error, secrets) }));
    }
  } else {
    checks.push(skipped("mcp.provider_read_call", "The public catalog call was withheld because its tool contract was not admitted.", []));
  }
  if (config.expectedAccountType) {
    try {
      const checked = await request(
        fetchImpl,
        buildMcpJsonRpcRequest({
          mcpUrl: config.mcpUrl,
          id: "account-type",
          method: "tools/call",
          toolName: "helix_workstation_capability_list",
          accessToken: config.accessToken,
        }),
        config.timeoutMs,
      );
      const envelope = asRecord(checked.body);
      const result = asRecord(envelope?.result);
      const receipt = asRecord(result?.structuredContent);
      const observedType = receipt?.account_type;
      checks.push(
        checked.ok && result?.isError !== true &&
        receipt?.schema === "helix.workstation_mcp_capability_list.v1" &&
        receipt?.assistant_answer === false &&
        receipt?.raw_content_included === false &&
        observedType === config.expectedAccountType
          ? pass(
              "mcp.account_type",
              "The authenticated read-only capability receipt confirms the expected account type.",
              { account_type: observedType },
            )
          : fail(
              "mcp.account_type",
              "The authenticated MCP account type did not match the required qualification identity.",
              "account_type_mismatch_or_unverified",
              {
                http_status: checked.status,
                expected_account_type: config.expectedAccountType,
                observed_account_type: observedType === "user" || observedType === "developer"
                  ? observedType : null,
                receipt_schema_valid:
                  receipt?.schema === "helix.workstation_mcp_capability_list.v1",
                is_error: result?.isError === true,
              },
            ),
      );
    } catch (error) {
      checks.push(fail(
        "mcp.account_type",
        "The authenticated MCP account type could not be verified.",
        "request_failed",
        { error: normalizedError(error, secrets) },
      ));
    }
  }
  return summarizeConformanceSection(checks);
};

const readCatalogSucceeded = (value: unknown): boolean => {
  if (typeof value === "string") {
    try {
      return readCatalogSucceeded(JSON.parse(value));
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some(readCatalogSucceeded);
  const result = asRecord(value);
  if (!result) return false;
  if (result.isError === true || result.ok === false) return false;
  if (result.schema === "helix.public_ui_agent_catalog.v1" &&
      result.content_role === "public_ui_catalog_observation_not_assistant_answer" &&
      result.credential_included === false &&
      result.private_state_included === false &&
      asRecord(result.mcp_evidence)?.schema === "helix.mcp_evidence_observation.v1") {
    return result.answer_authority === false &&
      result.assistant_answer === false &&
      result.terminal_eligible === false;
  }
  return Object.values(result).some(readCatalogSucceeded);
};

const probeOpenAiResponses = async (
  config: ProbeConfig,
  fetchImpl: FetchLike,
  secrets: readonly string[],
): Promise<ConformanceSection> => {
  const openAiApiKey = config.openAiApiKey;
  const accessToken = config.accessToken;
  const missing = [
    !openAiApiKey ? "OPENAI_API_KEY" : null,
    !accessToken ? "CASIMIRBOT_MCP_ACCESS_TOKEN" : null,
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    return summarizeConformanceSection([
      skipped(
        "provider.openai_responses_remote_mcp",
        "OpenAI Responses remote-MCP conformance was not run because required credentials are not configured.",
        missing,
      ),
    ]);
  }
  try {
    const result = await request(
      fetchImpl,
      buildOpenAiResponsesRequest({
        apiKey: openAiApiKey as string,
        accessToken: accessToken as string,
        mcpUrl: config.mcpUrl,
        model: config.openAiModel,
        responsesUrl: config.openAiResponsesUrl,
      }),
      config.timeoutMs,
    );
    if (!result.ok) {
      return summarizeConformanceSection([
        fail(
          "provider.openai_responses_tool_import",
          "OpenAI Responses rejected or could not import the remote MCP tool.",
          "provider_http_error",
          httpFailureEvidence(result, secrets),
        ),
        fail(
          "provider.openai_responses_tool_invocation",
          "OpenAI Responses could not invoke the admitted remote MCP tool because the provider request failed.",
          "provider_http_error",
          { http_status: result.status },
        ),
      ]);
    }
    const response = asRecord(result.body);
    const output = Array.isArray(response?.output) ? response.output : [];
    const items = output
      .map(asRecord)
      .filter((item): item is RecordLike => item !== null);
    const listItem = items.find((item) =>
      item.type === "mcp_list_tools" && item.server_label === "casimirbot");
    const callItem = items.find(
      (item) =>
        item.type === "mcp_call" && item.name === PROVIDER_READ_TOOL &&
        item.server_label === "casimirbot",
    );
    const importedTools = Array.isArray(listItem?.tools)
      ? listItem.tools
          .map(asRecord)
          .filter((tool): tool is RecordLike => tool !== null)
          .map((tool) => tool.name)
          .filter((name): name is string => typeof name === "string")
      : [];
    const importValid =
      importedTools.length === 1 &&
      importedTools[0] === PROVIDER_READ_TOOL;
    const invocationValid =
      response?.status === "completed" &&
      callItem !== undefined &&
      (callItem.error === null || callItem.error === undefined) &&
      readCatalogSucceeded(callItem.output);
    return summarizeConformanceSection([
      importValid
        ? pass(
            "provider.openai_responses_tool_import",
            "OpenAI Responses fetched the remote MCP catalog and imported only the admitted core tool.",
            {
              http_status: result.status,
              model: config.openAiModel,
              provider_response_id: response?.id ?? null,
              imported_tools: importedTools,
              explicit_tool_list_item: true,
            },
          )
        : fail(
            "provider.openai_responses_tool_import",
            "OpenAI Responses did not return the required bounded mcp_list_tools item.",
            "provider_tool_import_mismatch",
            {
              http_status: result.status,
              model: config.openAiModel,
              provider_response_id: response?.id ?? null,
              imported_tools: importedTools,
              explicit_tool_list_item: listItem !== undefined,
            },
          ),
      invocationValid
        ? pass(
            "provider.openai_responses_tool_invocation",
            "OpenAI Responses invoked the admitted MCP tool and preserved the Helix authority boundary in the receipt.",
            {
              http_status: result.status,
              model: config.openAiModel,
              provider_response_id: response?.id ?? null,
              called_tool: callItem?.name ?? null,
              non_authoritative_receipt: true,
            },
          )
        : fail(
            "provider.openai_responses_tool_invocation",
            "OpenAI Responses completed without the required bounded MCP call and non-authoritative receipt.",
            "provider_invocation_mismatch",
            {
              http_status: result.status,
              model: config.openAiModel,
              provider_status: response?.status ?? null,
              provider_response_id: response?.id ?? null,
              imported_tools: importedTools,
              called_tool: callItem?.name ?? null,
              call_error_present:
                callItem?.error !== null && callItem?.error !== undefined,
              non_authoritative_receipt: callItem
                ? readCatalogSucceeded(callItem.output)
                : false,
            },
          ),
    ]);
  } catch (error) {
    return summarizeConformanceSection([
      fail(
        "provider.openai_responses_tool_import",
        "OpenAI Responses remote-MCP conformance request failed.",
        "request_failed",
        { error: normalizedError(error, secrets) },
      ),
      fail(
        "provider.openai_responses_tool_invocation",
        "OpenAI Responses did not reach MCP invocation because the provider request failed.",
        "request_failed",
      ),
    ]);
  }
};

const probeGeminiInteractions = async (
  config: ProbeConfig,
  fetchImpl: FetchLike,
  secrets: readonly string[],
): Promise<ConformanceSection> => {
  const geminiApiKey = config.geminiApiKey;
  const accessToken = config.accessToken;
  const missing = [
    !geminiApiKey ? "GEMINI_API_KEY" : null,
    !accessToken ? "CASIMIRBOT_MCP_ACCESS_TOKEN" : null,
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    return summarizeConformanceSection([
      skipped(
        "provider.gemini_interactions_remote_mcp",
        "Gemini Interactions remote-MCP conformance was not run because required credentials are not configured.",
        missing,
      ),
    ]);
  }
  try {
    const result = await request(
      fetchImpl,
      buildGeminiInteractionsRequest({
        apiKey: geminiApiKey as string,
        accessToken: accessToken as string,
        mcpUrl: config.mcpUrl,
        model: config.geminiModel,
        interactionsUrl: config.geminiInteractionsUrl,
      }),
      config.timeoutMs,
    );
    if (!result.ok) {
      return summarizeConformanceSection([
        fail(
          "provider.gemini_interactions_tool_resolution",
          "Gemini Interactions rejected or could not resolve the remote MCP tool.",
          "provider_http_error",
          httpFailureEvidence(result, secrets),
        ),
        fail(
          "provider.gemini_interactions_tool_invocation",
          "Gemini Interactions could not invoke the admitted remote MCP tool because the provider request failed.",
          "provider_http_error",
          { http_status: result.status },
        ),
      ]);
    }
    const response = asRecord(result.body);
    const steps = Array.isArray(response?.steps) ? response.steps : [];
    const records = steps
      .map(asRecord)
      .filter((step): step is RecordLike => step !== null);
    const callStep = records.find(
      (step) =>
        step.type === "mcp_server_tool_call" &&
        step.name === PROVIDER_READ_TOOL &&
        step.server_name === "casimirbot",
    );
    const resultStep = records.find(
      (step) =>
        step.type === "mcp_server_tool_result" &&
        typeof callStep?.id === "string" &&
        step.call_id === callStep.id &&
        step.name === PROVIDER_READ_TOOL &&
        step.server_name === "casimirbot",
    );
    const resolutionValid = callStep !== undefined;
    const invocationValid =
      response?.status === "completed" &&
      resolutionValid &&
      resultStep !== undefined &&
      readCatalogSucceeded(resultStep.result);
    return summarizeConformanceSection([
      resolutionValid
        ? pass(
            "provider.gemini_interactions_tool_resolution",
            "Gemini Interactions resolved the one admitted remote MCP tool and emitted its typed MCP call step.",
            {
              http_status: result.status,
              model: config.geminiModel,
              provider_interaction_id: response?.id ?? null,
              called_tool: callStep?.name ?? null,
              server_name: callStep?.server_name ?? null,
              explicit_tool_list_item: false,
              resolution_evidence:
                "Gemini Interactions exposes the resolved mcp_server_tool_call step rather than a standalone tool-list step.",
            },
          )
        : fail(
            "provider.gemini_interactions_tool_resolution",
            "Gemini Interactions did not resolve the admitted remote MCP tool.",
            "provider_tool_resolution_mismatch",
            {
              http_status: result.status,
              model: config.geminiModel,
              provider_interaction_id: response?.id ?? null,
              provider_status: response?.status ?? null,
            },
          ),
      invocationValid
        ? pass(
            "provider.gemini_interactions_tool_invocation",
            "Gemini Interactions received the MCP tool result and preserved the Helix authority boundary.",
            {
              http_status: result.status,
              model: config.geminiModel,
              provider_interaction_id: response?.id ?? null,
              called_tool: callStep?.name ?? null,
              non_authoritative_receipt: true,
            },
          )
        : fail(
            "provider.gemini_interactions_tool_invocation",
            "Gemini Interactions completed without the required bounded MCP call and non-authoritative receipt.",
            "provider_invocation_mismatch",
            {
              http_status: result.status,
              model: config.geminiModel,
              provider_status: response?.status ?? null,
              provider_interaction_id: response?.id ?? null,
              called_tool: callStep?.name ?? null,
              result_step_present: resultStep !== undefined,
              non_authoritative_receipt: resultStep
                ? readCatalogSucceeded(resultStep.result)
                : false,
            },
          ),
    ]);
  } catch (error) {
    return summarizeConformanceSection([
      fail(
        "provider.gemini_interactions_tool_resolution",
        "Gemini Interactions remote-MCP conformance request failed.",
        "request_failed",
        { error: normalizedError(error, secrets) },
      ),
      fail(
        "provider.gemini_interactions_tool_invocation",
        "Gemini Interactions did not reach MCP invocation because the provider request failed.",
        "request_failed",
      ),
    ]);
  }
};

export const runCasimirbotMcpProviderConformance = async (
  options: ProbeOptions = {},
): Promise<CasimirbotMcpConformanceReport> => {
  const env = options.env ?? process.env;
  const config = resolveProbeConfig(env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const secrets = [
    config.accessToken,
    config.openAiApiKey,
    config.geminiApiKey,
  ].filter((value): value is string => value !== null);

  const publicDiscovery = await probePublicDiscovery(
    config,
    fetchImpl,
    secrets,
  );
  const oauthChallenge = await probeOAuthChallenge(
    config,
    fetchImpl,
    secrets,
  );
  const authenticatedMcp = await probeAuthenticatedMcp(
    config,
    fetchImpl,
    secrets,
  );
  const accountTypeVerified = !config.expectedAccountType ||
    authenticatedMcp.checks.some((check) =>
      check.id === "mcp.account_type" && check.status === "pass");
  const providerReadVerified = authenticatedMcp.checks.some((check) =>
    check.id === "mcp.provider_read_call" && check.status === "pass");
  const accountTypeBlocked = () => summarizeConformanceSection([{
    id: "provider.account_type_preflight",
    status: "skipped",
    summary: "Provider invocation was withheld because the required OAuth account type was not verified.",
    reason_code: "account_type_unverified",
    evidence: { expected_account_type: config.expectedAccountType },
  }]);
  const providerToolBlocked = () => summarizeConformanceSection([{
    id: "provider.public_tool_preflight",
    status: "skipped",
    summary: "Provider invocation was withheld because the public MCP tool call was not verified.",
    reason_code: "provider_read_unverified",
  }]);
  const openAiResponses = !config.openAiApiKey || !config.accessToken
    ? await probeOpenAiResponses(config, fetchImpl, secrets)
    : !accountTypeVerified
    ? accountTypeBlocked()
    : providerReadVerified
    ? await probeOpenAiResponses(config, fetchImpl, secrets)
    : providerToolBlocked();
  const geminiInteractions = !config.geminiApiKey || !config.accessToken
    ? await probeGeminiInteractions(config, fetchImpl, secrets)
    : !accountTypeVerified
    ? accountTypeBlocked()
    : providerReadVerified
    ? await probeGeminiInteractions(config, fetchImpl, secrets)
    : providerToolBlocked();

  const sections: CasimirbotMcpConformanceReport["sections"] = {
    public_discovery: publicDiscovery,
    oauth_challenge: oauthChallenge,
    authenticated_mcp: authenticatedMcp,
    openai_responses: openAiResponses,
    gemini_interactions: geminiInteractions,
  };
  const report: CasimirbotMcpConformanceReport = {
    schema: CASIMIRBOT_MCP_CONFORMANCE_SCHEMA,
    generated_at: now().toISOString(),
    status: summarizeOverall(sections),
    target: {
      public_base_url: config.publicBaseUrl,
      mcp_url: config.mcpUrl,
    },
    configuration: {
      loopback_http_allowed: config.allowLoopbackHttp,
      mcp_access_configured: config.accessToken !== null,
      openai_provider_configured:
        config.openAiApiKey !== null && config.accessToken !== null,
      gemini_provider_configured:
        config.geminiApiKey !== null && config.accessToken !== null,
      expected_account_type: config.expectedAccountType,
    },
    bounded_core_tools: CASIMIRBOT_CORE_MCP_TOOLS,
    sections,
  };
  return redactSecrets(report, secrets) as CasimirbotMcpConformanceReport;
};
