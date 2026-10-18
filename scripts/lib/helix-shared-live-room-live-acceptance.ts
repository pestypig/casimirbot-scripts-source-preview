import { createHash, randomUUID } from "node:crypto";
import { redactSecrets } from "./casimirbot-mcp-provider-conformance";

export const HELIX_SHARED_LIVE_ROOM_LIVE_ACCEPTANCE_SCHEMA =
  "helix.shared_live_room.live_acceptance.v1" as const;

const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_PUBLIC_BASE_URL = "https://casimirbot.com";
const DEFAULT_TIMEOUT_MS = 120_000;
const ACCEPTANCE_ROOM_TITLE = "Shared Live Room release acceptance";
const ACCEPTANCE_ROOM_IDEMPOTENCY_KEY =
  "shared-live-room-release-acceptance-v1";

export const HELIX_SHARED_LIVE_ROOM_MCP_TOOLS = [
  "helix_room_list",
  "helix_room_inspect",
  "helix_room_create",
  "helix_room_bind_run",
  "helix_room_claim_chat_binding",
  "helix_room_unbind_run",
  "helix_room_unbind_chat",
  "helix_room_command_request",
  "helix_room_source_list",
  "helix_room_source_create",
] as const;

type RoomToolName = (typeof HELIX_SHARED_LIVE_ROOM_MCP_TOOLS)[number];
type RecordLike = Record<string, unknown>;
type CheckStatus = "pass" | "fail" | "skipped";
type SectionStatus = CheckStatus;
type OverallStatus = "pass" | "fail" | "partial";

export type SharedLiveRoomAcceptanceCheck = {
  id: string;
  status: CheckStatus;
  summary: string;
  reason_code?: string;
  evidence?: RecordLike;
};

export type SharedLiveRoomAcceptanceSection = {
  status: SectionStatus;
  checks: SharedLiveRoomAcceptanceCheck[];
};

export type SharedLiveRoomLiveAcceptanceReport = {
  schema: typeof HELIX_SHARED_LIVE_ROOM_LIVE_ACCEPTANCE_SCHEMA;
  generated_at: string;
  status: OverallStatus;
  target: {
    public_base_url: string;
    mcp_url: string;
    agent_run_url: string;
    room_url: string;
  };
  configuration: {
    network_enabled: boolean;
    mutation_enabled: boolean;
    oauth_configured: boolean;
    loopback_http_allowed: boolean;
    timeout_ms: number;
    total_timeout_ms: number;
  };
  retained_resources: {
    stable_acceptance_room: boolean;
    reason: string;
  };
  sections: {
    preflight: SharedLiveRoomAcceptanceSection;
    public_discovery: SharedLiveRoomAcceptanceSection;
    oauth_challenge: SharedLiveRoomAcceptanceSection;
    authenticated_catalog: SharedLiveRoomAcceptanceSection;
    read_parity: SharedLiveRoomAcceptanceSection;
    mutation_lifecycle: SharedLiveRoomAcceptanceSection;
    cleanup: SharedLiveRoomAcceptanceSection;
    interactive_handoff: SharedLiveRoomAcceptanceSection;
  };
};

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type ProbeEnvironment = Record<string, string | undefined>;

export type SharedLiveRoomAcceptanceOptions = {
  env?: ProbeEnvironment;
  fetchImpl?: FetchLike;
  now?: () => Date;
  randomId?: () => string;
};

type ProbeConfig = {
  publicBaseUrl: string;
  mcpUrl: string;
  agentRunUrl: string;
  roomUrl: string;
  protectedResourceUrl: string;
  accessToken: string | null;
  networkEnabled: boolean;
  mutationEnabled: boolean;
  allowLoopbackHttp: boolean;
  timeoutMs: number;
  totalTimeoutMs: number;
  deadlineAtMs: number;
  roomIdempotencyKey: string;
};

type HttpResult = {
  ok: boolean;
  status: number;
  headers: Headers;
  contentType: string | null;
  body: unknown;
};

type McpCallResult = {
  http: HttpResult;
  result: RecordLike | null;
  structuredContent: RecordLike | null;
  isError: boolean;
};

type CleanupState = {
  activeRunBindingRef: string | null;
  runId: string | null;
  roomId: string | null;
  runStartAttempted: boolean;
  bindingAttempted: boolean;
};

type ToolPolicy = {
  scopes: readonly string[];
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
};

const ROOM_TOOL_POLICIES: Record<RoomToolName, ToolPolicy> = {
  helix_room_list: {
    scopes: ["helix.rooms.read"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  helix_room_inspect: {
    scopes: ["helix.rooms.read"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  helix_room_create: {
    scopes: ["helix.rooms.manage"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  helix_room_bind_run: {
    scopes: ["helix.rooms.manage", "helix.agent_runs.write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  helix_room_claim_chat_binding: {
    scopes: ["helix.rooms.manage", "helix.agent_runs.write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  helix_room_unbind_run: {
    scopes: ["helix.rooms.manage", "helix.agent_runs.write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  helix_room_unbind_chat: {
    scopes: ["helix.rooms.manage", "helix.agent_runs.write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  helix_room_command_request: {
    scopes: ["helix.rooms.manage"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  helix_room_source_list: {
    scopes: ["helix.room_sources.manage"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  helix_room_source_create: {
    scopes: ["helix.room_sources.manage"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
};

const ROOM_TOOL_INPUT_PROPERTIES: Record<RoomToolName, readonly string[]> = {
  helix_room_list: [],
  helix_room_inspect: ["room_id"],
  helix_room_create: ["idempotency_key", "request"],
  helix_room_bind_run: ["request"],
  helix_room_claim_chat_binding: ["request"],
  helix_room_unbind_run: ["binding_ref"],
  helix_room_unbind_chat: ["binding_ref"],
  helix_room_command_request: ["command", "room_id"],
  helix_room_source_list: ["room_id"],
  helix_room_source_create: ["idempotency_key", "request", "room_id"],
};

const RECEIPT_AUTHORITY_REQUIRED = [
  "answer_authority",
  "api_version",
  "assistant_answer",
  "content_role",
  "ok",
  "operation",
  "raw_content_included",
  "reentry_required",
  "schema",
  "terminal_eligible",
] as const;

const ROOM_TOOL_OUTPUT_REQUIRED: Record<RoomToolName, readonly string[]> = {
  helix_room_list: [...RECEIPT_AUTHORITY_REQUIRED, "rooms"],
  helix_room_inspect: [...RECEIPT_AUTHORITY_REQUIRED, "room"],
  helix_room_create: ["idempotency_replayed", "operation", "receipt"],
  helix_room_bind_run: [
    ...RECEIPT_AUTHORITY_REQUIRED,
    "binding_ref",
    "binding_status",
    "room_id",
    "run_id",
    "version",
  ],
  helix_room_claim_chat_binding: [
    ...RECEIPT_AUTHORITY_REQUIRED,
    "binding_ref",
    "binding_status",
    "context_char_count",
    "context_message_count",
    "context_snapshot_ref",
    "run_id",
  ],
  helix_room_unbind_run: [
    ...RECEIPT_AUTHORITY_REQUIRED,
    "binding_ref",
    "binding_status",
    "revocation_status",
  ],
  helix_room_unbind_chat: [
    ...RECEIPT_AUTHORITY_REQUIRED,
    "binding_ref",
    "binding_status",
    "revocation_status",
  ],
  helix_room_command_request: [
    "api_version",
    "content_role",
    "reentry_required",
    "answer_authority",
    "assistant_answer",
    "terminal_eligible",
    "error",
    "message",
    "request_id",
    "retryable",
    "schema",
  ],
  helix_room_source_list: [
    ...RECEIPT_AUTHORITY_REQUIRED,
    "bindings",
    "room_id",
  ],
  helix_room_source_create: ["idempotency_replayed", "operation", "receipt"],
};

type JsonSchemaObjectContract = {
  properties: Readonly<Record<string, string>>;
  required: readonly string[];
};

type JsonSchemaNestedOutputContract = {
  required: readonly string[];
  literals: Readonly<Record<string, unknown>>;
};

const ROOM_TOOL_INPUT_TYPES: Record<
  RoomToolName,
  Readonly<Record<string, string>>
> = {
  helix_room_list: {},
  helix_room_inspect: { room_id: "string" },
  helix_room_create: {
    idempotency_key: "string",
    request: "object",
  },
  helix_room_bind_run: { request: "object" },
  helix_room_claim_chat_binding: { request: "object" },
  helix_room_unbind_run: { binding_ref: "string" },
  helix_room_unbind_chat: { binding_ref: "string" },
  helix_room_command_request: {
    command: "string",
    room_id: "string",
  },
  helix_room_source_list: { room_id: "string" },
  helix_room_source_create: {
    idempotency_key: "string",
    request: "object",
    room_id: "string",
  },
};

const ROOM_TOOL_NESTED_INPUTS: Partial<
  Record<RoomToolName, Readonly<Record<string, JsonSchemaObjectContract>>>
> = {
  helix_room_create: {
    request: {
      properties: { title: "string" },
      required: [],
    },
  },
  helix_room_bind_run: {
    request: {
      properties: { room_id: "string", run_id: "string" },
      required: ["room_id", "run_id"],
    },
  },
  helix_room_claim_chat_binding: {
    request: {
      properties: { claim_handle: "string", run_id: "string" },
      required: ["claim_handle", "run_id"],
    },
  },
  helix_room_source_create: {
    request: {
      properties: {
        domain_adapter: "string",
        source_label: "string",
        ttl_ms: "integer",
        world_id: "string",
      },
      required: [],
    },
  },
};

const NONTERMINAL_OUTPUT_LITERALS = {
  answer_authority: false,
  api_version: "v1",
  assistant_answer: false,
  ok: true,
  raw_content_included: false,
  reentry_required: true,
  terminal_eligible: false,
} as const;

const ROOM_TOOL_OUTPUT_LITERALS: Record<
  RoomToolName,
  Readonly<Record<string, unknown>>
> = {
  helix_room_list: {
    ...NONTERMINAL_OUTPUT_LITERALS,
    content_role: "room_control_observation_not_assistant_answer",
    operation: "room.list",
    schema: "helix.shared_live_room.list_receipt.v1",
  },
  helix_room_inspect: {
    ...NONTERMINAL_OUTPUT_LITERALS,
    content_role: "room_control_observation_not_assistant_answer",
    operation: "room.inspect",
    schema: "helix.shared_live_room.inspect_receipt.v1",
  },
  helix_room_create: {
    operation: "room.create",
  },
  helix_room_bind_run: {
    ...NONTERMINAL_OUTPUT_LITERALS,
    binding_status: "active",
    content_role: "room_control_receipt_not_assistant_answer",
    operation: "room.run.bind",
    schema: "helix.shared_live_room.run_bind_receipt.v1",
  },
  helix_room_claim_chat_binding: {
    ...NONTERMINAL_OUTPUT_LITERALS,
    binding_status: "active",
    content_role: "room_control_receipt_not_assistant_answer",
    operation: "room.chat_binding.claim",
    schema: "helix.shared_live_room.chat_binding_claim_receipt.v1",
  },
  helix_room_unbind_run: {
    ...NONTERMINAL_OUTPUT_LITERALS,
    binding_status: "revoked",
    content_role: "room_control_receipt_not_assistant_answer",
    operation: "room.run.unbind",
    schema: "helix.shared_live_room.run_unbind_receipt.v1",
  },
  helix_room_unbind_chat: {
    ...NONTERMINAL_OUTPUT_LITERALS,
    binding_status: "revoked",
    content_role: "room_control_receipt_not_assistant_answer",
    operation: "room.chat_binding.unbind",
    schema: "helix.shared_live_room.chat_binding_unbind_receipt.v1",
  },
  helix_room_command_request: {
    api_version: "v1",
    schema: "helix.shared_live_room.error.v1",
    content_role: "room_control_error_not_assistant_answer",
    reentry_required: true,
    answer_authority: false,
    assistant_answer: false,
    terminal_eligible: false,
  },
  helix_room_source_list: {
    ...NONTERMINAL_OUTPUT_LITERALS,
    content_role: "source_binding_observation_not_assistant_answer",
    operation: "room.source.list",
    schema: "helix.shared_live_room.source_list_receipt.v1",
  },
  helix_room_source_create: {
    operation: "room.source.create",
  },
};

const ROOM_TOOL_NESTED_OUTPUTS: Partial<
  Record<RoomToolName, Readonly<Record<string, JsonSchemaNestedOutputContract>>>
> = {
  helix_room_create: {
    receipt: {
      required: [...RECEIPT_AUTHORITY_REQUIRED, "room"],
      literals: {
        ...NONTERMINAL_OUTPUT_LITERALS,
        content_role: "room_control_receipt_not_assistant_answer",
        operation: "room.create",
        schema: "helix.shared_live_room.create_receipt.v1",
      },
    },
  },
  helix_room_source_create: {
    receipt: {
      required: [
        ...RECEIPT_AUTHORITY_REQUIRED,
        "binding",
        "command_execution_enabled",
        "credential_delivery",
        "execution_enabled",
        "room_id",
      ],
      literals: {
        ...NONTERMINAL_OUTPUT_LITERALS,
        command_execution_enabled: false,
        content_role: "source_binding_receipt_not_assistant_answer",
        execution_enabled: false,
        operation: "room.source.create",
        schema: "helix.shared_live_room.source_create_receipt.v1",
      },
    },
  },
};

const asRecord = (value: unknown): RecordLike | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const isRoomId = (value: string | null): value is string =>
  Boolean(value && /^shared_realtime_room:[A-Za-z0-9._:-]+$/u.test(value));

const isRunId = (value: string | null): value is string =>
  Boolean(value && /^run_[A-Za-z0-9._:-]{8,200}$/u.test(value));

const isRunBindingRef = (value: string | null): value is string =>
  Boolean(value && /^agent_room_binding:[A-Za-z0-9._:-]{8,200}$/u.test(value));

const pass = (
  id: string,
  summary: string,
  evidence?: RecordLike,
): SharedLiveRoomAcceptanceCheck => ({
  id,
  status: "pass",
  summary,
  ...(evidence ? { evidence } : {}),
});

const fail = (
  id: string,
  summary: string,
  reasonCode: string,
  evidence?: RecordLike,
): SharedLiveRoomAcceptanceCheck => ({
  id,
  status: "fail",
  summary,
  reason_code: reasonCode,
  ...(evidence ? { evidence } : {}),
});

const skipped = (
  id: string,
  summary: string,
  reasonCode: string,
  evidence?: RecordLike,
): SharedLiveRoomAcceptanceCheck => ({
  id,
  status: "skipped",
  summary,
  reason_code: reasonCode,
  ...(evidence ? { evidence } : {}),
});

const summarizeSection = (
  checks: SharedLiveRoomAcceptanceCheck[],
): SharedLiveRoomAcceptanceSection => ({
  status: checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.every((check) => check.status === "skipped")
      ? "skipped"
      : "pass",
  checks,
});

const summarizeOverall = (
  sections: SharedLiveRoomLiveAcceptanceReport["sections"],
): OverallStatus => {
  const statuses = Object.values(sections).map((section) => section.status);
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("skipped")) return "partial";
  return "pass";
};

const isLoopbackHost = (hostname: string): boolean =>
  new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(
    hostname.toLowerCase(),
  );

const normalizeBaseUrl = (
  value: string,
  allowLoopbackHttp: boolean,
): string => {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" &&
    !(
      allowLoopbackHttp &&
      parsed.protocol === "http:" &&
      isLoopbackHost(parsed.hostname)
    )
  ) {
    throw new Error(
      "The acceptance base URL must use HTTPS; explicit HTTP is limited to loopback.",
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "The acceptance base URL must not contain credentials, query parameters, or a fragment.",
    );
  }
  return parsed.toString().replace(/\/+$/u, "");
};

const parseTimeout = (value: string | undefined): number => {
  if (!value) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 600_000) {
    throw new Error(
      "HELIX_SHARED_ROOM_ACCEPTANCE_TIMEOUT_MS must be an integer from 1000 to 600000.",
    );
  }
  return parsed;
};

const parseTotalTimeout = (value: string | undefined): number => {
  if (!value) return 600_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 30_000 || parsed > 3_600_000) {
    throw new Error(
      "HELIX_SHARED_ROOM_ACCEPTANCE_TOTAL_TIMEOUT_MS must be an integer from 30000 to 3600000.",
    );
  }
  return parsed;
};

const resolveConfig = (env: ProbeEnvironment): ProbeConfig => {
  const allowLoopbackHttp =
    env.HELIX_SHARED_ROOM_ACCEPTANCE_ALLOW_LOOPBACK_HTTP === "1";
  const publicBaseUrl = normalizeBaseUrl(
    env.HELIX_SHARED_ROOM_ACCEPTANCE_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL,
    allowLoopbackHttp,
  );
  const roomIdempotencyKey =
    env.HELIX_SHARED_ROOM_ACCEPTANCE_ROOM_IDEMPOTENCY_KEY?.trim() ||
    ACCEPTANCE_ROOM_IDEMPOTENCY_KEY;
  if (roomIdempotencyKey.length < 8 || roomIdempotencyKey.length > 200) {
    throw new Error(
      "HELIX_SHARED_ROOM_ACCEPTANCE_ROOM_IDEMPOTENCY_KEY must contain 8 to 200 characters.",
    );
  }
  const accessToken =
    env.HELIX_SHARED_ROOM_ACCEPTANCE_ACCESS_TOKEN?.trim() || null;
  return {
    publicBaseUrl,
    mcpUrl: `${publicBaseUrl}/mcp`,
    agentRunUrl: `${publicBaseUrl}/api/v1/agent-runs`,
    roomUrl: `${publicBaseUrl}/api/v1/rooms`,
    protectedResourceUrl: `${publicBaseUrl}/.well-known/oauth-protected-resource/mcp`,
    accessToken,
    networkEnabled: env.HELIX_SHARED_ROOM_ACCEPTANCE_NETWORK === "1",
    mutationEnabled:
      env.HELIX_SHARED_ROOM_ACCEPTANCE_NETWORK === "1" &&
      env.HELIX_SHARED_ROOM_ACCEPTANCE_ALLOW_MUTATION === "1",
    allowLoopbackHttp,
    timeoutMs: parseTimeout(env.HELIX_SHARED_ROOM_ACCEPTANCE_TIMEOUT_MS),
    totalTimeoutMs: parseTotalTimeout(
      env.HELIX_SHARED_ROOM_ACCEPTANCE_TOTAL_TIMEOUT_MS,
    ),
    deadlineAtMs: Number.POSITIVE_INFINITY,
    roomIdempotencyKey,
  };
};

const remainingTimeout = (config: ProbeConfig): number => {
  const remaining = config.deadlineAtMs - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    if (!Number.isFinite(config.deadlineAtMs)) return config.timeoutMs;
    throw new Error("shared_live_room_acceptance_deadline_exceeded");
  }
  return Math.max(1, Math.min(config.timeoutMs, Math.floor(remaining)));
};

const secretPattern =
  /\b(?:helix_room_src_|room_source_claim_|agent_chat_claim_)[A-Za-z0-9:._~-]+|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/giu;
const sensitiveKeyPattern =
  /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|credential|bearer(?:[-_]?token)?|source[-_]?bearer|auth[-_]?token|session[-_]?token|password|private[-_]?key|secret|token[-_]?value|claim[-_]?handle|claim[-_]?url|plugin[-_]?config|cookie/iu;
const secretAssignmentPattern =
  /((?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|credential|bearer(?:[-_]?token)?|source[-_]?bearer|auth[-_]?token|session[-_]?token|password|private[-_]?key|secret|token[-_]?value|claim[-_]?handle|claim[-_]?url|plugin[-_]?config|cookie)\s*[:=]\s*["']?)[^,\s"'}]+/giu;

const redactAcceptanceString = (
  value: string,
  secrets: readonly string[],
): string => {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(secretPattern, "[REDACTED]")
    .replace(secretAssignmentPattern, "$1[REDACTED]");
};

const redactAcceptanceSecrets = (
  value: unknown,
  secrets: readonly string[],
): unknown => {
  const initiallyRedacted = redactSecrets(value, secrets);
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): unknown => {
    if (typeof candidate === "string") {
      return redactAcceptanceString(candidate, secrets);
    }
    if (candidate === null || typeof candidate !== "object") {
      return candidate;
    }
    if (seen.has(candidate)) return "[CIRCULAR]";
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.map(visit);
    return Object.fromEntries(
      Object.entries(candidate as RecordLike).map(([key, nested]) => [
        key,
        sensitiveKeyPattern.test(key) ? "[REDACTED]" : visit(nested),
      ]),
    );
  };
  return visit(initiallyRedacted);
};

const containsProtectedSecretLike = (
  value: unknown,
  secrets: readonly string[],
): boolean => {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): boolean => {
    if (typeof candidate === "string") {
      if (secrets.some((secret) => secret && candidate.includes(secret))) {
        return true;
      }
      secretPattern.lastIndex = 0;
      const patternMatch = secretPattern.test(candidate);
      secretPattern.lastIndex = 0;
      secretAssignmentPattern.lastIndex = 0;
      const assignmentMatch = secretAssignmentPattern.test(candidate);
      secretAssignmentPattern.lastIndex = 0;
      return patternMatch || assignmentMatch;
    }
    if (candidate === null || typeof candidate !== "object") return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.some(visit);
    return Object.entries(candidate as RecordLike).some(([key, nested]) => {
      if (
        sensitiveKeyPattern.test(key) &&
        nested !== false &&
        nested !== null &&
        nested !== undefined
      ) {
        return true;
      }
      return visit(nested);
    });
  };
  return visit(value);
};

const safeEvidence = (
  value: RecordLike,
  secrets: readonly string[],
): RecordLike =>
  (redactAcceptanceSecrets(value, secrets) as RecordLike | null) ?? {};

const parseSseJson = (rawText: string, requestId: string): unknown => {
  const payloads = rawText
    .split(/\r?\n\r?\n/gu)
    .flatMap((event) =>
      event
        .split(/\r?\n/gu)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim()),
    )
    .filter((entry) => entry && entry !== "[DONE]")
    .flatMap((entry) => {
      try {
        return [JSON.parse(entry) as unknown];
      } catch {
        return [];
      }
    });
  return (
    payloads.find((entry) => asRecord(entry)?.id === requestId) ??
    payloads.at(-1) ??
    null
  );
};

const parseBody = (
  rawText: string,
  contentType: string | null,
  requestId?: string,
): unknown => {
  if (!rawText) return null;
  if (contentType?.includes("text/event-stream")) {
    return parseSseJson(rawText, requestId ?? "");
  }
  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
};

const requestHttp = async (
  fetchImpl: FetchLike,
  input: {
    method: "GET" | "POST" | "DELETE";
    url: string;
    token?: string | null;
    body?: RecordLike;
    idempotencyKey?: string;
    timeoutMs: number;
    requestId?: string;
    mcp?: boolean;
  },
): Promise<HttpResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetchImpl(input.url, {
      method: input.method,
      redirect: "error",
      headers: {
        Accept: input.mcp
          ? "application/json, text/event-stream"
          : "application/json",
        ...(input.body ? { "Content-Type": "application/json" } : {}),
        ...(input.mcp ? { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION } : {}),
        ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
        ...(input.idempotencyKey
          ? { "Idempotency-Key": input.idempotencyKey }
          : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type");
    const rawText = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      contentType,
      body: parseBody(rawText, contentType, input.requestId),
    };
  } finally {
    clearTimeout(timeout);
  }
};

const postMcp = async (
  fetchImpl: FetchLike,
  config: ProbeConfig,
  input: {
    id: string;
    method: "initialize" | "tools/list" | "tools/call";
    params: RecordLike;
    authenticated: boolean;
  },
): Promise<McpCallResult> => {
  const http = await requestHttp(fetchImpl, {
    method: "POST",
    url: config.mcpUrl,
    token: input.authenticated ? config.accessToken : null,
    timeoutMs: remainingTimeout(config),
    requestId: input.id,
    mcp: true,
    body: {
      jsonrpc: "2.0",
      id: input.id,
      method: input.method,
      params: input.params,
    },
  });
  const envelope = asRecord(http.body);
  const validEnvelope =
    envelope?.jsonrpc === "2.0" &&
    envelope.id === input.id &&
    envelope.error === undefined;
  const result = validEnvelope ? asRecord(envelope?.result) : null;
  let structuredContent = asRecord(result?.structuredContent);
  if (!structuredContent) {
    const text = asArray(result?.content)
      .map(asRecord)
      .find((entry) => entry?.type === "text" && asString(entry.text));
    if (text && typeof text.text === "string") {
      try {
        structuredContent = asRecord(JSON.parse(text.text));
      } catch {
        structuredContent = null;
      }
    }
  }
  return {
    http,
    result,
    structuredContent,
    isError: result?.isError === true,
  };
};

const callRoomTool = (
  fetchImpl: FetchLike,
  config: ProbeConfig,
  randomId: () => string,
  name: RoomToolName,
  args: RecordLike,
): Promise<McpCallResult> =>
  postMcp(fetchImpl, config, {
    id: `shared-room-${name}-${randomId()}`,
    method: "tools/call",
    params: { name, arguments: args },
    authenticated: true,
  });

const authorityFieldsAreFalse = (value: unknown): boolean => {
  const record = asRecord(value);
  return (
    record?.answer_authority === false &&
    record.assistant_answer === false &&
    record.terminal_eligible === false &&
    record.raw_content_included === false
  );
};

const isRoomControlReceipt = (
  value: unknown,
  schema: string,
  operation: string,
): boolean => {
  const record = asRecord(value);
  const expectedContentRole =
    operation === "room.list" || operation === "room.inspect"
      ? "room_control_observation_not_assistant_answer"
      : operation === "room.source.list"
        ? "source_binding_observation_not_assistant_answer"
        : operation === "room.source.create"
          ? "source_binding_receipt_not_assistant_answer"
          : "room_control_receipt_not_assistant_answer";
  return (
    authorityFieldsAreFalse(record) &&
    record?.api_version === "v1" &&
    record.ok === true &&
    record.schema === schema &&
    record.operation === operation &&
    record.content_role === expectedContentRole &&
    record.reentry_required === true
  );
};

const isAgentRunProjection = (value: unknown): boolean => {
  const record = asRecord(value);
  return (
    authorityFieldsAreFalse(record) &&
    record?.schema === "helix.agent_run.v1" &&
    record.api_version === "v1"
  );
};

const isDisabledCommandError = (value: unknown): boolean => {
  const record = asRecord(value);
  const details = asRecord(record?.details);
  return (
    record?.schema === "helix.shared_live_room.error.v1" &&
    record.api_version === "v1" &&
    record.error === "command_execution_not_enabled" &&
    record.retryable === false &&
    details?.execution_enabled === false &&
    details.sensor_credentials_accepted === false
  );
};

const roomIdsFromReceipt = (value: unknown): string[] =>
  asArray(asRecord(value)?.rooms)
    .map((room) => asString(asRecord(room)?.room_id))
    .filter((roomId): roomId is string => Boolean(roomId))
    .sort();

const sourceBindingIdsFromReceipt = (value: unknown): string[] =>
  asArray(asRecord(value)?.bindings)
    .map((binding) => asString(asRecord(binding)?.binding_id))
    .filter((bindingId): bindingId is string => Boolean(bindingId))
    .sort();

const opaqueSetDigest = (values: readonly string[]): string =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex");

const scopesFromSecuritySchemes = (value: unknown): string[] =>
  asArray(value)
    .map(asRecord)
    .filter((scheme): scheme is RecordLike => scheme?.type === "oauth2")
    .flatMap((scheme) =>
      asArray(scheme.scopes).filter(
        (scope): scope is string => typeof scope === "string",
      ),
    );

const sortedStrings = (value: unknown): string[] =>
  asArray(value)
    .filter((entry): entry is string => typeof entry === "string")
    .sort();

const sameStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

const resolveLocalJsonSchema = (
  root: RecordLike,
  schema: unknown,
): RecordLike | null => {
  let current = asRecord(schema);
  const visited = new Set<string>();
  while (current) {
    const reference = asString(current.$ref);
    if (!reference) return current;
    if (!reference.startsWith("#/") || visited.has(reference)) return null;
    visited.add(reference);
    let resolved: unknown = root;
    for (const rawSegment of reference.slice(2).split("/")) {
      const segment = rawSegment.replace(/~1/gu, "/").replace(/~0/gu, "~");
      resolved = asRecord(resolved)?.[segment];
    }
    current = asRecord(resolved);
  }
  return null;
};

export const validateSharedLiveRoomToolCatalog = (
  value: unknown,
): Array<{ tool: RoomToolName; code: string; message: string }> => {
  const tools = asArray(value)
    .map(asRecord)
    .filter((tool): tool is RecordLike => tool !== null);
  const byName = new Map(
    tools
      .map((tool) => [asString(tool.name), tool] as const)
      .filter((entry): entry is readonly [string, RecordLike] =>
        Boolean(entry[0]),
      ),
  );
  const issues: Array<{
    tool: RoomToolName;
    code: string;
    message: string;
  }> = [];
  for (const name of HELIX_SHARED_LIVE_ROOM_MCP_TOOLS) {
    const tool = byName.get(name);
    const policy = ROOM_TOOL_POLICIES[name];
    if (!tool) {
      issues.push({
        tool: name,
        code: "missing_tool",
        message: `${name} is absent from tools/list.`,
      });
      continue;
    }
    if (!asString(tool.title) || !asString(tool.description)) {
      issues.push({
        tool: name,
        code: "missing_documentation",
        message: `${name} is missing its title or description.`,
      });
    }
    const inputSchema = asRecord(tool.inputSchema);
    const outputSchema = asRecord(tool.outputSchema);
    if (inputSchema?.type !== "object" || outputSchema?.type !== "object") {
      issues.push({
        tool: name,
        code: "invalid_schema",
        message: `${name} must publish object input and output schemas.`,
      });
    } else {
      const expectedInput = ROOM_TOOL_INPUT_PROPERTIES[name];
      const inputProperties = asRecord(inputSchema.properties) ?? {};
      const invalidInputTypes = Object.entries(
        ROOM_TOOL_INPUT_TYPES[name],
      ).some(
        ([property, expectedType]) =>
          resolveLocalJsonSchema(inputSchema, inputProperties[property])
            ?.type !== expectedType,
      );
      const invalidNestedInputs = Object.entries(
        ROOM_TOOL_NESTED_INPUTS[name] ?? {},
      ).some(([property, contract]) => {
        const propertySchema = resolveLocalJsonSchema(
          inputSchema,
          inputProperties[property],
        );
        const nestedProperties = asRecord(propertySchema?.properties) ?? {};
        return (
          propertySchema?.type !== "object" ||
          propertySchema.additionalProperties !== false ||
          !sameStrings(
            Object.keys(nestedProperties),
            Object.keys(contract.properties),
          ) ||
          !sameStrings(
            sortedStrings(propertySchema.required),
            contract.required,
          ) ||
          Object.entries(contract.properties).some(
            ([nestedProperty, expectedType]) =>
              resolveLocalJsonSchema(
                inputSchema,
                nestedProperties[nestedProperty],
              )?.type !== expectedType,
          )
        );
      });
      if (
        inputSchema.additionalProperties !== false ||
        !sameStrings(Object.keys(inputProperties), expectedInput) ||
        !sameStrings(sortedStrings(inputSchema.required), expectedInput) ||
        invalidInputTypes ||
        invalidNestedInputs
      ) {
        issues.push({
          tool: name,
          code: "invalid_input_schema",
          message: `${name} must publish its exact strict input contract, including nested request fields and types.`,
        });
      }
      const outputRequired = sortedStrings(outputSchema.required);
      const expectedOutputRequired = ROOM_TOOL_OUTPUT_REQUIRED[name];
      const outputProperties = asRecord(outputSchema.properties) ?? {};
      const invalidOutputLiterals = Object.entries(
        ROOM_TOOL_OUTPUT_LITERALS[name],
      ).some(
        ([property, expected]) =>
          asRecord(outputProperties[property])?.const !== expected,
      );
      const invalidNestedOutputs = Object.entries(
        ROOM_TOOL_NESTED_OUTPUTS[name] ?? {},
      ).some(([property, contract]) => {
        const propertySchema = asRecord(outputProperties[property]);
        const nestedProperties = asRecord(propertySchema?.properties) ?? {};
        return (
          propertySchema?.type !== "object" ||
          !sameStrings(
            sortedStrings(propertySchema.required),
            contract.required,
          ) ||
          contract.required.some(
            (requiredProperty) =>
              !Object.prototype.hasOwnProperty.call(
                nestedProperties,
                requiredProperty,
              ),
          ) ||
          Object.entries(contract.literals).some(
            ([nestedProperty, expected]) =>
              asRecord(nestedProperties[nestedProperty])?.const !== expected,
          )
        );
      });
      if (
        !sameStrings(outputRequired, expectedOutputRequired) ||
        expectedOutputRequired.some(
          (property) =>
            !Object.prototype.hasOwnProperty.call(outputProperties, property),
        ) ||
        invalidOutputLiterals ||
        invalidNestedOutputs
      ) {
        issues.push({
          tool: name,
          code: "invalid_output_schema",
          message: `${name} must publish its exact required output and literal receipt contract.`,
        });
      }
    }
    const annotations = asRecord(tool.annotations);
    if (
      Object.entries(policy.annotations).some(
        ([key, expected]) => annotations?.[key] !== expected,
      )
    ) {
      issues.push({
        tool: name,
        code: "invalid_annotations",
        message: `${name} has incorrect side-effect annotations.`,
      });
    }
    const metaSecuritySchemes = asRecord(tool._meta)?.securitySchemes;
    const securitySchemeCollections = [
      tool.securitySchemes,
      metaSecuritySchemes,
    ].filter((candidate) => asArray(candidate).length > 0);
    const actualScopes = Array.from(
      new Set(securitySchemeCollections.flatMap(scopesFromSecuritySchemes)),
    );
    if (
      securitySchemeCollections.length === 0 ||
      securitySchemeCollections.some((collection) => {
        const schemes = asArray(collection).map(asRecord);
        return (
          schemes.length !== 1 ||
          schemes[0]?.type !== "oauth2" ||
          !sameStrings(scopesFromSecuritySchemes(collection), policy.scopes)
        );
      }) ||
      !sameStrings(actualScopes, policy.scopes)
    ) {
      issues.push({
        tool: name,
        code: "invalid_oauth_scopes",
        message: `${name} must publish exactly its required OAuth scope set.`,
      });
    }
  }
  return issues;
};

const normalizedError = (
  error: unknown,
  secrets: readonly string[],
): string => {
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  return String(redactAcceptanceSecrets(message, secrets)).slice(0, 2_000);
};

const makeInteractiveChecks = (): SharedLiveRoomAcceptanceCheck[] => [
  skipped(
    "browser_chat_authority",
    "A signed-in same-origin browser must select or create the chat, issue the one-time claim, and prove disconnect/rebind behavior.",
    "browser_checkpoint_required",
  ),
  skipped(
    "minecraft_source_producer",
    "The owner browser must claim source delivery and a real Minecraft producer must submit a fresh exact-provenance observation.",
    "producer_checkpoint_required",
  ),
  skipped(
    "observer_terminal_exactly_once",
    "The browser observer must prove after_seq ordering and exactly one canonical terminal chat append across reload.",
    "browser_checkpoint_required",
  ),
  skipped(
    "ask_realtime_voice_equivalence",
    "Representative keyed Ask, Realtime, text, and voice terminal-equivalence evidence remains a companion live battery.",
    "keyed_companion_battery_required",
  ),
];

export const runSharedLiveRoomLiveAcceptance = async (
  options: SharedLiveRoomAcceptanceOptions = {},
): Promise<SharedLiveRoomLiveAcceptanceReport> => {
  const env = options.env ?? process.env;
  const config = resolveConfig(env);
  const startedAtMs = Date.now();
  const overallDeadlineAtMs = startedAtMs + config.totalTimeoutMs;
  const cleanupReserveMs = Math.min(
    120_000,
    Math.floor(config.totalTimeoutMs / 4),
  );
  config.deadlineAtMs = overallDeadlineAtMs - cleanupReserveMs;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const secrets = [config.accessToken ?? ""].filter(Boolean);
  const executionId = randomId();
  const runIdempotencyKey = `shared-room-acceptance-run-${executionId}`.slice(
    0,
    200,
  );
  const cancelIdempotencyKey =
    `shared-room-acceptance-cancel-${executionId}`.slice(0, 200);
  const boundedRunRequest: RecordLike = {
    objective:
      "Create a bounded transport receipt for Shared Live Room binding acceptance. Do not research, continue, or execute commands.",
    constraints: [
      "Do not execute a Minecraft command.",
      "Treat room receipts as non-authoritative observations.",
    ],
    database_scope: [],
    completion_contract: {
      min_evidence_refs: 0,
      require_terminal_authority: false,
      required_output_fields: [],
      max_unresolved_requirements: 0,
      allow_conflicts: true,
    },
    budget: {
      max_steps: 1,
      expires_in_seconds: 60,
    },
  };
  const preflightChecks: SharedLiveRoomAcceptanceCheck[] = [
    pass(
      "safe_target",
      "The target URL satisfies HTTPS or explicit loopback-only HTTP policy.",
      {
        loopback_http_allowed: config.allowLoopbackHttp,
      },
    ),
    config.networkEnabled
      ? pass("network_opt_in", "Network probing was explicitly enabled.")
      : skipped(
          "network_opt_in",
          "Dry-run mode made no network requests.",
          "network_not_enabled",
        ),
    config.mutationEnabled
      ? pass(
          "mutation_opt_in",
          "The bounded mutation lifecycle was explicitly enabled.",
        )
      : skipped(
          "mutation_opt_in",
          "Room/run mutations require a separate explicit opt-in.",
          "mutation_not_enabled",
        ),
  ];
  const publicChecks: SharedLiveRoomAcceptanceCheck[] = [];
  const challengeChecks: SharedLiveRoomAcceptanceCheck[] = [];
  const catalogChecks: SharedLiveRoomAcceptanceCheck[] = [];
  const readChecks: SharedLiveRoomAcceptanceCheck[] = [];
  const mutationChecks: SharedLiveRoomAcceptanceCheck[] = [];
  const cleanupChecks: SharedLiveRoomAcceptanceCheck[] = [];
  const cleanup: CleanupState = {
    activeRunBindingRef: null,
    runId: null,
    roomId: null,
    runStartAttempted: false,
    bindingAttempted: false,
  };
  let stableRoomRetained = false;
  let stableRoomMayExist = false;

  if (!config.networkEnabled) {
    publicChecks.push(
      skipped(
        "agent_access_manifest",
        "Public discovery was not requested in dry-run mode.",
        "network_not_enabled",
      ),
    );
    challengeChecks.push(
      skipped(
        "mcp_bearer_challenge",
        "The unauthenticated MCP OAuth challenge was not requested.",
        "network_not_enabled",
      ),
    );
    catalogChecks.push(
      skipped(
        "room_tool_catalog",
        "The authenticated MCP catalog was not requested.",
        "network_not_enabled",
      ),
    );
    readChecks.push(
      skipped(
        "rest_mcp_room_list",
        "REST/MCP room-list parity was not requested.",
        "network_not_enabled",
      ),
    );
    mutationChecks.push(
      skipped(
        "bounded_room_lifecycle",
        "The bounded room lifecycle was not requested.",
        "network_not_enabled",
      ),
    );
    cleanupChecks.push(
      skipped(
        "cleanup",
        "No resources were created in dry-run mode.",
        "nothing_to_cleanup",
      ),
    );
  } else {
    try {
      const manifestResult = await requestHttp(fetchImpl, {
        method: "GET",
        url: `${config.publicBaseUrl}/agent-access.json`,
        timeoutMs: remainingTimeout(config),
      });
      const manifest = asRecord(manifestResult.body);
      const manifestMcp = asRecord(manifest?.mcp);
      const manifestRest = asRecord(manifest?.rest);
      const manifestValid =
        manifestResult.ok &&
        manifest?.metadata_kind === "casimirbot.agent_access" &&
        manifestMcp?.url === config.mcpUrl &&
        manifestRest?.base_url === config.agentRunUrl &&
        manifestRest?.room_base_url === config.roomUrl;
      publicChecks.push(
        manifestValid
          ? pass(
              "agent_access_manifest",
              "Discovery advertises the exact REST and MCP endpoints.",
              { http_status: manifestResult.status },
            )
          : fail(
              "agent_access_manifest",
              "Discovery did not advertise the expected REST/MCP contract.",
              "discovery_contract_mismatch",
              safeEvidence(
                {
                  http_status: manifestResult.status,
                  body: manifestResult.body,
                },
                secrets,
              ),
            ),
      );

      const metadataResult = await requestHttp(fetchImpl, {
        method: "GET",
        url: config.protectedResourceUrl,
        timeoutMs: remainingTimeout(config),
      });
      const metadata = asRecord(metadataResult.body);
      const scopes = new Set(
        asArray(metadata?.scopes_supported).filter(
          (scope): scope is string => typeof scope === "string",
        ),
      );
      const requiredScopes = [
        "helix.agent_runs.read",
        "helix.agent_runs.write",
        "helix.rooms.read",
        "helix.rooms.manage",
        "helix.room_sources.manage",
      ];
      publicChecks.push(
        metadataResult.ok &&
          asString(metadata?.resource) !== null &&
          asArray(metadata?.authorization_servers).length > 0 &&
          requiredScopes.every((scope) => scopes.has(scope))
          ? pass(
              "oauth_resource_metadata",
              "Protected-resource metadata advertises the run and room scopes.",
              { required_scopes_present: true },
            )
          : fail(
              "oauth_resource_metadata",
              "Protected-resource metadata is missing required ownership scopes.",
              "oauth_metadata_mismatch",
              safeEvidence(
                {
                  http_status: metadataResult.status,
                  scopes_supported: Array.from(scopes),
                },
                secrets,
              ),
            ),
      );

      const challenge = await postMcp(fetchImpl, config, {
        id: `shared-room-unauth-${randomId()}`,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: "casimirbot-shared-room-live-acceptance",
            version: "1.0.0",
          },
        },
        authenticated: false,
      });
      const challengeHeader =
        challenge.http.headers.get("www-authenticate") ?? "";
      const challengeBody = asRecord(challenge.http.body);
      challengeChecks.push(
        challenge.http.status === 401 &&
          challengeBody?.error === "unauthorized" &&
          /^Bearer\b/iu.test(challengeHeader) &&
          /resource_metadata=/iu.test(challengeHeader) &&
          /error="invalid_token"/iu.test(challengeHeader)
          ? pass(
              "mcp_bearer_challenge",
              "Unauthenticated MCP initialization returns a typed OAuth challenge.",
              { http_status: challenge.http.status },
            )
          : fail(
              "mcp_bearer_challenge",
              "Unauthenticated MCP initialization did not return the required challenge.",
              "oauth_challenge_mismatch",
              safeEvidence(
                {
                  http_status: challenge.http.status,
                  body: challenge.http.body,
                  challenge_present: Boolean(challengeHeader),
                },
                secrets,
              ),
            ),
      );
    } catch (error) {
      publicChecks.push(
        fail(
          "public_discovery_request",
          "Public discovery could not be completed.",
          "network_request_failed",
          { error: normalizedError(error, secrets) },
        ),
      );
      challengeChecks.push(
        skipped(
          "mcp_bearer_challenge",
          "The MCP OAuth challenge was not reached after discovery failed.",
          "dependency_failed",
        ),
      );
    }

    if (!config.accessToken) {
      catalogChecks.push(
        skipped(
          "room_tool_catalog",
          "Authenticated catalog verification needs an access token supplied through the environment.",
          "access_token_not_configured",
        ),
      );
      readChecks.push(
        skipped(
          "rest_mcp_room_list",
          "REST/MCP read parity needs an access token.",
          "access_token_not_configured",
        ),
      );
      mutationChecks.push(
        skipped(
          "bounded_room_lifecycle",
          "The mutation lifecycle needs an access token.",
          "access_token_not_configured",
        ),
      );
      cleanupChecks.push(
        skipped(
          "cleanup",
          "No authenticated mutation was attempted.",
          "nothing_to_cleanup",
        ),
      );
    } else {
      try {
        const initialized = await postMcp(fetchImpl, config, {
          id: `shared-room-init-${randomId()}`,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
              name: "casimirbot-shared-room-live-acceptance",
              version: "1.0.0",
            },
          },
          authenticated: true,
        });
        const serverInfo = asRecord(initialized.result?.serverInfo);
        catalogChecks.push(
          initialized.http.ok &&
            initialized.result !== null &&
            asString(serverInfo?.name) !== null
            ? pass(
                "mcp_initialize",
                "Authenticated stateless MCP initialization succeeded.",
                { http_status: initialized.http.status },
              )
            : fail(
                "mcp_initialize",
                "Authenticated MCP initialization failed.",
                "mcp_initialize_failed",
                safeEvidence(
                  {
                    http_status: initialized.http.status,
                    body: initialized.http.body,
                  },
                  secrets,
                ),
              ),
        );

        const listed = await postMcp(fetchImpl, config, {
          id: `shared-room-tools-${randomId()}`,
          method: "tools/list",
          params: {},
          authenticated: true,
        });
        const issues = validateSharedLiveRoomToolCatalog(listed.result?.tools);
        catalogChecks.push(
          listed.http.ok && listed.result !== null && issues.length === 0
            ? pass(
                "room_tool_catalog",
                "All ten Shared Live Room tools publish the required schemas, scopes, and side-effect annotations.",
                { tool_count: HELIX_SHARED_LIVE_ROOM_MCP_TOOLS.length },
              )
            : fail(
                "room_tool_catalog",
                "The authenticated Shared Live Room tool catalog is not release-equivalent.",
                "room_tool_catalog_mismatch",
                safeEvidence(
                  {
                    http_status: listed.http.status,
                    issues,
                  },
                  secrets,
                ),
              ),
        );
      } catch (error) {
        catalogChecks.push(
          fail(
            "authenticated_catalog_request",
            "Authenticated MCP catalog probing failed.",
            "network_request_failed",
            { error: normalizedError(error, secrets) },
          ),
        );
      }

      try {
        const restList = await requestHttp(fetchImpl, {
          method: "GET",
          url: config.roomUrl,
          token: config.accessToken,
          timeoutMs: remainingTimeout(config),
        });
        const mcpList = await callRoomTool(
          fetchImpl,
          config,
          randomId,
          "helix_room_list",
          {},
        );
        const restRoomIds = roomIdsFromReceipt(restList.body);
        const mcpRoomIds = roomIdsFromReceipt(mcpList.structuredContent);
        const parity =
          restList.ok &&
          mcpList.http.ok &&
          !mcpList.isError &&
          isRoomControlReceipt(
            restList.body,
            "helix.shared_live_room.list_receipt.v1",
            "room.list",
          ) &&
          isRoomControlReceipt(
            mcpList.structuredContent,
            "helix.shared_live_room.list_receipt.v1",
            "room.list",
          ) &&
          JSON.stringify(restRoomIds) === JSON.stringify(mcpRoomIds);
        readChecks.push(
          parity
            ? pass(
                "rest_mcp_room_list",
                "REST and MCP returned the same owner-scoped room IDs with nonterminal authority fields.",
                { room_count: restRoomIds.length },
              )
            : fail(
                "rest_mcp_room_list",
                "REST/MCP room-list projections diverged.",
                "room_list_parity_mismatch",
                safeEvidence(
                  {
                    rest_status: restList.status,
                    mcp_status: mcpList.http.status,
                    mcp_tool_error: mcpList.isError,
                    rest_room_count: restRoomIds.length,
                    mcp_room_count: mcpRoomIds.length,
                    rest_room_set_digest: opaqueSetDigest(restRoomIds),
                    mcp_room_set_digest: opaqueSetDigest(mcpRoomIds),
                  },
                  secrets,
                ),
              ),
        );
      } catch (error) {
        readChecks.push(
          fail(
            "rest_mcp_room_list",
            "REST/MCP room-list parity could not be completed.",
            "network_request_failed",
            { error: normalizedError(error, secrets) },
          ),
        );
      }

      const mutationPrerequisiteFailed = [
        ...publicChecks,
        ...challengeChecks,
        ...catalogChecks,
        ...readChecks,
      ].some((check) => check.status === "fail");
      if (!config.mutationEnabled) {
        mutationChecks.push(
          skipped(
            "bounded_room_lifecycle",
            "Set the explicit mutation opt-in to exercise create, bind, withdraw, rebind, and disabled-command contracts.",
            "mutation_not_enabled",
          ),
        );
        cleanupChecks.push(
          skipped(
            "cleanup",
            "No mutation was attempted.",
            "nothing_to_cleanup",
          ),
        );
      } else if (mutationPrerequisiteFailed) {
        mutationChecks.push(
          skipped(
            "bounded_room_lifecycle",
            "Mutation was withheld because a discovery, OAuth, catalog, or read-parity prerequisite failed.",
            "prerequisite_failed",
          ),
        );
        cleanupChecks.push(
          skipped(
            "cleanup",
            "No mutation was attempted after the prerequisite failure.",
            "nothing_to_cleanup",
          ),
        );
      } else {
        try {
          const roomRequest = { title: ACCEPTANCE_ROOM_TITLE };
          stableRoomMayExist = true;
          const restCreated = await requestHttp(fetchImpl, {
            method: "POST",
            url: config.roomUrl,
            token: config.accessToken,
            idempotencyKey: config.roomIdempotencyKey,
            timeoutMs: remainingTimeout(config),
            body: roomRequest,
          });
          const restRoomId = asString(
            asRecord(asRecord(restCreated.body)?.room)?.room_id,
          );
          if (isRoomId(restRoomId)) {
            cleanup.roomId = restRoomId;
            stableRoomRetained = true;
          }
          if (!restCreated.ok || !isRoomId(restRoomId)) {
            throw new Error(
              `REST room creation failed with HTTP ${restCreated.status}.`,
            );
          }
          const mcpCreated = await callRoomTool(
            fetchImpl,
            config,
            randomId,
            "helix_room_create",
            {
              idempotency_key: config.roomIdempotencyKey,
              request: roomRequest,
            },
          );
          const mcpCreateReceipt = asRecord(
            asRecord(mcpCreated.structuredContent)?.receipt,
          );
          const mcpRoomId = asString(asRecord(mcpCreateReceipt?.room)?.room_id);
          mutationChecks.push(
            mcpCreated.http.ok &&
              !mcpCreated.isError &&
              mcpRoomId === restRoomId &&
              isRoomControlReceipt(
                restCreated.body,
                "helix.shared_live_room.create_receipt.v1",
                "room.create",
              ) &&
              isRoomControlReceipt(
                mcpCreateReceipt,
                "helix.shared_live_room.create_receipt.v1",
                "room.create",
              ) &&
              asRecord(mcpCreated.structuredContent)?.operation ===
                "room.create" &&
              asRecord(mcpCreated.structuredContent)?.idempotency_replayed ===
                true
              ? pass(
                  "cross_transport_room_create_replay",
                  "REST creation and MCP replay resolved to the same stable acceptance room.",
                  {
                    room_id: restRoomId,
                    rest_idempotency_replayed:
                      restCreated.headers.get("idempotency-replayed") ===
                      "true",
                    mcp_idempotency_replayed:
                      asRecord(mcpCreated.structuredContent)
                        ?.idempotency_replayed === true,
                  },
                )
              : fail(
                  "cross_transport_room_create_replay",
                  "REST and MCP room creation did not share one idempotent result.",
                  "room_create_parity_mismatch",
                  safeEvidence(
                    {
                      rest_room_id: restRoomId,
                      mcp_room_id: mcpRoomId,
                      mcp_tool_error: mcpCreated.isError,
                    },
                    secrets,
                  ),
                ),
          );

          const restInspect = await requestHttp(fetchImpl, {
            method: "GET",
            url: `${config.roomUrl}/${encodeURIComponent(restRoomId)}`,
            token: config.accessToken,
            timeoutMs: remainingTimeout(config),
          });
          const mcpInspect = await callRoomTool(
            fetchImpl,
            config,
            randomId,
            "helix_room_inspect",
            { room_id: restRoomId },
          );
          mutationChecks.push(
            restInspect.ok &&
              mcpInspect.http.ok &&
              !mcpInspect.isError &&
              isRoomControlReceipt(
                restInspect.body,
                "helix.shared_live_room.inspect_receipt.v1",
                "room.inspect",
              ) &&
              isRoomControlReceipt(
                mcpInspect.structuredContent,
                "helix.shared_live_room.inspect_receipt.v1",
                "room.inspect",
              ) &&
              asString(asRecord(asRecord(restInspect.body)?.room)?.room_id) ===
                restRoomId &&
              asString(
                asRecord(asRecord(mcpInspect.structuredContent)?.room)?.room_id,
              ) === restRoomId
              ? pass(
                  "cross_transport_room_inspect",
                  "REST and MCP inspect the exact acceptance room.",
                )
              : fail(
                  "cross_transport_room_inspect",
                  "REST/MCP inspect did not resolve the same room.",
                  "room_inspect_parity_mismatch",
                ),
          );

          cleanup.runStartAttempted = true;
          const runStarted = await requestHttp(fetchImpl, {
            method: "POST",
            url: config.agentRunUrl,
            token: config.accessToken,
            idempotencyKey: runIdempotencyKey,
            timeoutMs: remainingTimeout(config),
            body: boundedRunRequest,
          });
          const runId = asString(asRecord(runStarted.body)?.run_id);
          if (isRunId(runId)) cleanup.runId = runId;
          if (
            !runStarted.ok ||
            !isRunId(runId) ||
            !isAgentRunProjection(runStarted.body) ||
            runStarted.headers.get("idempotency-replayed") !== "false"
          ) {
            throw new Error(
              `Bounded run creation failed with HTTP ${runStarted.status}.`,
            );
          }
          mutationChecks.push(
            pass(
              "bounded_run_created",
              "A fresh one-step run was created solely for binding lifecycle acceptance.",
              {
                run_id: runId,
                idempotency_replayed: false,
              },
            ),
          );

          cleanup.bindingAttempted = true;
          const firstBinding = await requestHttp(fetchImpl, {
            method: "POST",
            url: `${config.roomUrl}/run-bindings`,
            token: config.accessToken,
            timeoutMs: remainingTimeout(config),
            body: { run_id: runId, room_id: restRoomId },
          });
          const firstBindingRef = asString(
            asRecord(firstBinding.body)?.binding_ref,
          );
          if (isRunBindingRef(firstBindingRef)) {
            cleanup.activeRunBindingRef = firstBindingRef;
          }
          if (
            !firstBinding.ok ||
            !isRunBindingRef(firstBindingRef) ||
            !isRoomControlReceipt(
              firstBinding.body,
              "helix.shared_live_room.run_bind_receipt.v1",
              "room.run.bind",
            )
          ) {
            throw new Error(
              `REST run-room binding failed with HTTP ${firstBinding.status}.`,
            );
          }
          const mcpBindingReplay = await callRoomTool(
            fetchImpl,
            config,
            randomId,
            "helix_room_bind_run",
            {
              request: { run_id: runId, room_id: restRoomId },
            },
          );
          if (
            !mcpBindingReplay.http.ok ||
            mcpBindingReplay.isError ||
            !isRoomControlReceipt(
              mcpBindingReplay.structuredContent,
              "helix.shared_live_room.run_bind_receipt.v1",
              "room.run.bind",
            ) ||
            asString(
              asRecord(mcpBindingReplay.structuredContent)?.binding_ref,
            ) !== firstBindingRef
          ) {
            throw new Error(
              "MCP did not replay the exact active REST run-room binding.",
            );
          }
          mutationChecks.push(
            pass(
              "cross_transport_binding_replay",
              "MCP replay returned the exact active run-room binding created by REST.",
            ),
          );
          const mcpWithdrawn = await callRoomTool(
            fetchImpl,
            config,
            randomId,
            "helix_room_unbind_run",
            { binding_ref: firstBindingRef },
          );
          if (
            !mcpWithdrawn.http.ok ||
            mcpWithdrawn.isError ||
            !isRoomControlReceipt(
              mcpWithdrawn.structuredContent,
              "helix.shared_live_room.run_unbind_receipt.v1",
              "room.run.unbind",
            ) ||
            asRecord(mcpWithdrawn.structuredContent)?.revocation_status !==
              "revoked"
          ) {
            throw new Error("MCP run-room withdrawal failed.");
          }
          cleanup.activeRunBindingRef = null;
          const repeatedWithdrawal = await requestHttp(fetchImpl, {
            method: "DELETE",
            url:
              `${config.roomUrl}/run-bindings/` +
              encodeURIComponent(firstBindingRef),
            token: config.accessToken,
            timeoutMs: remainingTimeout(config),
          });
          mutationChecks.push(
            repeatedWithdrawal.ok &&
              isRoomControlReceipt(
                repeatedWithdrawal.body,
                "helix.shared_live_room.run_unbind_receipt.v1",
                "room.run.unbind",
              ) &&
              asRecord(repeatedWithdrawal.body)?.revocation_status ===
                "already_revoked"
              ? pass(
                  "cross_transport_withdrawal_replay",
                  "MCP withdrawal followed by REST replay returned already_revoked.",
                )
              : fail(
                  "cross_transport_withdrawal_replay",
                  "Exact withdrawal replay was not idempotent across transports.",
                  "withdrawal_replay_mismatch",
                ),
          );

          const rebound = await callRoomTool(
            fetchImpl,
            config,
            randomId,
            "helix_room_bind_run",
            {
              request: { run_id: runId, room_id: restRoomId },
            },
          );
          const replacementBindingRef = asString(
            asRecord(rebound.structuredContent)?.binding_ref,
          );
          if (isRunBindingRef(replacementBindingRef)) {
            cleanup.activeRunBindingRef = replacementBindingRef;
          }
          if (
            !rebound.http.ok ||
            rebound.isError ||
            !isRoomControlReceipt(
              rebound.structuredContent,
              "helix.shared_live_room.run_bind_receipt.v1",
              "room.run.bind",
            ) ||
            !isRunBindingRef(replacementBindingRef) ||
            replacementBindingRef === firstBindingRef
          ) {
            throw new Error(
              "MCP rebind did not return a fresh active binding reference.",
            );
          }
          mutationChecks.push(
            pass(
              "fresh_replacement_binding",
              "Rebinding after withdrawal created a fresh opaque binding reference.",
            ),
          );

          const restSources = await requestHttp(fetchImpl, {
            method: "GET",
            url:
              `${config.roomUrl}/${encodeURIComponent(restRoomId)}` +
              "/sources",
            token: config.accessToken,
            timeoutMs: remainingTimeout(config),
          });
          const mcpSources = await callRoomTool(
            fetchImpl,
            config,
            randomId,
            "helix_room_source_list",
            { room_id: restRoomId },
          );
          const restSourceIds = sourceBindingIdsFromReceipt(restSources.body);
          const mcpSourceIds = sourceBindingIdsFromReceipt(
            mcpSources.structuredContent,
          );
          const sourceSecretDetected = containsProtectedSecretLike(
            [restSources.body, mcpSources.structuredContent],
            secrets,
          );
          mutationChecks.push(
            restSources.ok &&
              mcpSources.http.ok &&
              !mcpSources.isError &&
              !sourceSecretDetected &&
              isRoomControlReceipt(
                restSources.body,
                "helix.shared_live_room.source_list_receipt.v1",
                "room.source.list",
              ) &&
              isRoomControlReceipt(
                mcpSources.structuredContent,
                "helix.shared_live_room.source_list_receipt.v1",
                "room.source.list",
              ) &&
              JSON.stringify(restSourceIds) === JSON.stringify(mcpSourceIds)
              ? pass(
                  "source_list_nonterminal_secret_free",
                  "REST/MCP source lists contain the same bindings as nonterminal projections without protected credential patterns.",
                )
              : fail(
                  "source_list_nonterminal_secret_free",
                  "A source-list projection violated authority or secret boundaries.",
                  "source_projection_violation",
                  {
                    rest_source_count: restSourceIds.length,
                    mcp_source_count: mcpSourceIds.length,
                    rest_source_set_digest: opaqueSetDigest(restSourceIds),
                    mcp_source_set_digest: opaqueSetDigest(mcpSourceIds),
                  },
                ),
          );

          const restCommand = await requestHttp(fetchImpl, {
            method: "POST",
            url:
              `${config.roomUrl}/${encodeURIComponent(restRoomId)}` +
              "/commands",
            token: config.accessToken,
            timeoutMs: remainingTimeout(config),
            body: { command: "/list" },
          });
          const restCommandBody = asRecord(restCommand.body);
          const mcpCommand = await callRoomTool(
            fetchImpl,
            config,
            randomId,
            "helix_room_command_request",
            { room_id: restRoomId, command: "/list" },
          );
          mutationChecks.push(
            restCommand.status === 501 &&
              isDisabledCommandError(restCommandBody) &&
              mcpCommand.http.ok &&
              mcpCommand.isError &&
              isDisabledCommandError(mcpCommand.structuredContent)
              ? pass(
                  "command_lane_disabled",
                  "REST and MCP both returned the stable disabled-command failure and executed nothing.",
                )
              : fail(
                  "command_lane_disabled",
                  "The disabled command contract diverged across REST/MCP.",
                  "command_disable_contract_mismatch",
                  safeEvidence(
                    {
                      rest_status: restCommand.status,
                      rest_error: restCommandBody?.error,
                      mcp_tool_error: mcpCommand.isError,
                      mcp_error: mcpCommand.structuredContent?.error,
                    },
                    secrets,
                  ),
                ),
          );
        } catch (error) {
          mutationChecks.push(
            fail(
              "bounded_room_lifecycle",
              "The bounded mutation lifecycle did not complete.",
              "mutation_lifecycle_failed",
              { error: normalizedError(error, secrets) },
            ),
          );
        } finally {
          config.deadlineAtMs = overallDeadlineAtMs;
          if (cleanup.runStartAttempted && !cleanup.runId) {
            let recoveredRun: HttpResult | null = null;
            let recoveredRunError: unknown = null;
            let recoveryAttempts = 0;
            while (recoveryAttempts < 2 && !cleanup.runId) {
              recoveryAttempts += 1;
              try {
                recoveredRun = await requestHttp(fetchImpl, {
                  method: "POST",
                  url: config.agentRunUrl,
                  token: config.accessToken,
                  idempotencyKey: runIdempotencyKey,
                  timeoutMs: remainingTimeout(config),
                  body: boundedRunRequest,
                });
              } catch (error) {
                recoveredRunError = error;
                continue;
              }
              const recoveredRunId = asString(
                asRecord(recoveredRun.body)?.run_id,
              );
              if (
                recoveredRun.ok &&
                isRunId(recoveredRunId) &&
                isAgentRunProjection(recoveredRun.body)
              ) {
                cleanup.runId = recoveredRunId;
              }
            }
            if (cleanup.runId) {
              cleanupChecks.push(
                pass(
                  "ambiguous_run_outcome_recovered",
                  "The bounded run identifier was recovered by bounded replay of its exact idempotency key before cleanup.",
                  {
                    attempts: recoveryAttempts,
                    idempotency_replayed:
                      recoveredRun?.headers.get("idempotency-replayed") ===
                      "true",
                  },
                ),
              );
            } else {
              cleanupChecks.push(
                fail(
                  "ambiguous_run_outcome_recovered",
                  "The bounded run outcome remained unknown after bounded exact idempotent replay.",
                  "cleanup_outcome_unknown",
                  recoveredRun
                    ? { http_status: recoveredRun.status }
                    : {
                        error: normalizedError(recoveredRunError, secrets),
                      },
                ),
              );
            }
          }

          if (
            cleanup.bindingAttempted &&
            cleanup.runId &&
            cleanup.roomId &&
            !cleanup.activeRunBindingRef
          ) {
            let recoveredBinding: HttpResult | null = null;
            let recoveredBindingError: unknown = null;
            let recoveryAttempts = 0;
            while (recoveryAttempts < 2 && !cleanup.activeRunBindingRef) {
              recoveryAttempts += 1;
              try {
                recoveredBinding = await requestHttp(fetchImpl, {
                  method: "POST",
                  url: `${config.roomUrl}/run-bindings`,
                  token: config.accessToken,
                  timeoutMs: remainingTimeout(config),
                  body: {
                    run_id: cleanup.runId,
                    room_id: cleanup.roomId,
                  },
                });
              } catch (error) {
                recoveredBindingError = error;
                continue;
              }
              const recoveredBindingRef = asString(
                asRecord(recoveredBinding.body)?.binding_ref,
              );
              if (
                recoveredBinding.ok &&
                isRunBindingRef(recoveredBindingRef) &&
                isRoomControlReceipt(
                  recoveredBinding.body,
                  "helix.shared_live_room.run_bind_receipt.v1",
                  "room.run.bind",
                )
              ) {
                cleanup.activeRunBindingRef = recoveredBindingRef;
              }
            }
            if (cleanup.activeRunBindingRef) {
              cleanupChecks.push(
                pass(
                  "ambiguous_binding_outcome_recovered",
                  "The active binding reference was recovered through bounded naturally idempotent exact run-room bind replay.",
                  { attempts: recoveryAttempts },
                ),
              );
            } else {
              cleanupChecks.push(
                fail(
                  "ambiguous_binding_outcome_recovered",
                  "The active run-room binding outcome remained unknown after bounded exact replay.",
                  "cleanup_outcome_unknown",
                  recoveredBinding
                    ? { http_status: recoveredBinding.status }
                    : {
                        error: normalizedError(recoveredBindingError, secrets),
                      },
                ),
              );
            }
          }

          if (cleanup.activeRunBindingRef) {
            let withdrawalResult: HttpResult | null = null;
            let withdrawalError: unknown = null;
            let withdrawalAttempts = 0;
            while (withdrawalAttempts < 2 && !withdrawalResult) {
              withdrawalAttempts += 1;
              try {
                withdrawalResult = await requestHttp(fetchImpl, {
                  method: "DELETE",
                  url:
                    `${config.roomUrl}/run-bindings/` +
                    encodeURIComponent(cleanup.activeRunBindingRef),
                  token: config.accessToken,
                  timeoutMs: remainingTimeout(config),
                });
              } catch (error) {
                withdrawalError = error;
              }
            }
            if (
              withdrawalResult?.ok &&
              isRoomControlReceipt(
                withdrawalResult.body,
                "helix.shared_live_room.run_unbind_receipt.v1",
                "room.run.unbind",
              ) &&
              asRecord(withdrawalResult.body)?.binding_status === "revoked"
            ) {
              cleanupChecks.push(
                pass(
                  "run_room_binding_cleanup",
                  "The active replacement run-room binding was withdrawn.",
                  { attempts: withdrawalAttempts },
                ),
              );
              cleanup.activeRunBindingRef = null;
            } else {
              cleanupChecks.push(
                fail(
                  "run_room_binding_cleanup",
                  "The active run-room binding could not be withdrawn after an exact retry.",
                  "cleanup_failed",
                  withdrawalResult
                    ? { http_status: withdrawalResult.status }
                    : {
                        error: normalizedError(withdrawalError, secrets),
                      },
                ),
              );
            }
          }

          if (cleanup.runId) {
            try {
              const inspected = await requestHttp(fetchImpl, {
                method: "GET",
                url:
                  `${config.agentRunUrl}/` + encodeURIComponent(cleanup.runId),
                token: config.accessToken,
                timeoutMs: remainingTimeout(config),
              });
              const run = asRecord(inspected.body);
              const lifecycle = asString(run?.lifecycle_status);
              if (
                inspected.ok &&
                isAgentRunProjection(inspected.body) &&
                ["completed", "failed", "cancelled"].includes(lifecycle ?? "")
              ) {
                cleanupChecks.push(
                  pass(
                    "bounded_run_cleanup",
                    "The bounded acceptance run was already terminal.",
                    { lifecycle_status: lifecycle },
                  ),
                );
              } else if (
                inspected.ok &&
                isAgentRunProjection(inspected.body) &&
                typeof run?.version === "number"
              ) {
                let cancelled: HttpResult | null = null;
                let cancelError: unknown = null;
                let cancelAttempts = 0;
                while (cancelAttempts < 2 && !cancelled) {
                  cancelAttempts += 1;
                  try {
                    cancelled = await requestHttp(fetchImpl, {
                      method: "POST",
                      url:
                        `${config.agentRunUrl}/` +
                        `${encodeURIComponent(cleanup.runId)}/cancel`,
                      token: config.accessToken,
                      idempotencyKey: cancelIdempotencyKey,
                      timeoutMs: remainingTimeout(config),
                      body: {
                        expected_version: run.version,
                        reason: "shared_live_room_acceptance_cleanup",
                      },
                    });
                  } catch (error) {
                    cancelError = error;
                  }
                }
                cleanupChecks.push(
                  cancelled?.ok &&
                    isAgentRunProjection(cancelled.body) &&
                    asRecord(cancelled.body)?.lifecycle_status === "cancelled"
                    ? pass(
                        "bounded_run_cleanup",
                        "The still-active bounded acceptance run was cancelled.",
                        { attempts: cancelAttempts },
                      )
                    : fail(
                        "bounded_run_cleanup",
                        "The still-active bounded acceptance run could not be cancelled after an exact idempotent retry.",
                        "cleanup_failed",
                        cancelled
                          ? { http_status: cancelled.status }
                          : {
                              error: normalizedError(cancelError, secrets),
                            },
                      ),
                );
              } else {
                cleanupChecks.push(
                  fail(
                    "bounded_run_cleanup",
                    "The bounded run could not be inspected for cleanup.",
                    "cleanup_failed",
                    { http_status: inspected.status },
                  ),
                );
              }
            } catch (error) {
              cleanupChecks.push(
                fail(
                  "bounded_run_cleanup",
                  "The bounded run cleanup request failed.",
                  "cleanup_failed",
                  { error: normalizedError(error, secrets) },
                ),
              );
            }
          }
          if (stableRoomRetained) {
            cleanupChecks.push(
              pass(
                "stable_room_retained",
                "One caller-stable idempotent acceptance room is intentionally retained because the external facade has no room-close operation.",
              ),
            );
          }
          if (cleanupChecks.length === 0) {
            cleanupChecks.push(
              skipped(
                "cleanup",
                "The lifecycle failed before a cleanup-capable resource was created.",
                "nothing_to_cleanup",
              ),
            );
          }
        }
      }
    }
  }

  const sections: SharedLiveRoomLiveAcceptanceReport["sections"] = {
    preflight: summarizeSection(preflightChecks),
    public_discovery: summarizeSection(publicChecks),
    oauth_challenge: summarizeSection(challengeChecks),
    authenticated_catalog: summarizeSection(catalogChecks),
    read_parity: summarizeSection(readChecks),
    mutation_lifecycle: summarizeSection(mutationChecks),
    cleanup: summarizeSection(cleanupChecks),
    interactive_handoff: summarizeSection(makeInteractiveChecks()),
  };
  const report: SharedLiveRoomLiveAcceptanceReport = {
    schema: HELIX_SHARED_LIVE_ROOM_LIVE_ACCEPTANCE_SCHEMA,
    generated_at: now().toISOString(),
    status: summarizeOverall(sections),
    target: {
      public_base_url: config.publicBaseUrl,
      mcp_url: config.mcpUrl,
      agent_run_url: config.agentRunUrl,
      room_url: config.roomUrl,
    },
    configuration: {
      network_enabled: config.networkEnabled,
      mutation_enabled: config.mutationEnabled,
      oauth_configured: Boolean(config.accessToken),
      loopback_http_allowed: config.allowLoopbackHttp,
      timeout_ms: config.timeoutMs,
      total_timeout_ms: config.totalTimeoutMs,
    },
    retained_resources: {
      stable_acceptance_room: stableRoomRetained,
      reason: stableRoomRetained
        ? "The external room facade has no close operation; the stable idempotency key prevents room accumulation."
        : stableRoomMayExist
          ? "Room creation was attempted with the stable key but its outcome was not confirmed; the next invocation safely replays that key."
          : "No room was created by this invocation.",
    },
    sections,
  };
  return redactAcceptanceSecrets(
    report,
    secrets,
  ) as SharedLiveRoomLiveAcceptanceReport;
};
