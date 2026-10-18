import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import manifestFixture from "../fixtures/environment-source/minecraft/plugin-manifest.mvp.json";
import {
  createSucceededProbeResult,
  createConnectorPairingIdentity,
  HelixEnvironmentConnectorClient,
} from "../connectors/environment/sdk/typescript";
import { redactSecrets } from "./lib/casimirbot-mcp-provider-conformance";

export const HELIX_ENVIRONMENT_CONNECTOR_LIVE_ACCEPTANCE_SCHEMA =
  "helix.environment_connector.live_acceptance.v1" as const;

const MINECRAFT_PACKAGE_VERSION_ID =
  "connector_package_version:com.casimirbot.minecraft.paper:1.1.0";
const MINECRAFT_INVENTORY_CAPABILITY =
  "com.casimirbot.minecraft.inventory.check";
const DEFAULT_BASE_URL = "http://127.0.0.1:1522";
const DEFAULT_PROFILE_ID = "profile:environment-connector-live-acceptance";
const DEFAULT_TIMEOUT_MS = 30_000;
const AGENT_API_TURN_TIMEOUT_MS = 90_000;
const AGENT_API_DATABASE_SCOPE = "bound_room_environment_probe";

type RecordLike = Record<string, unknown>;
type CheckStatus = "pass" | "fail" | "skipped";
type OverallStatus = "pass" | "partial" | "fail";
type FetchLike = typeof fetch;

export type EnvironmentConnectorAcceptanceCheck = {
  id: string;
  status: CheckStatus;
  reason_code: string | null;
  summary: string;
  evidence?: RecordLike;
};

export type EnvironmentConnectorLiveAcceptanceReport = {
  schema: typeof HELIX_ENVIRONMENT_CONNECTOR_LIVE_ACCEPTANCE_SCHEMA;
  generated_at: string;
  status: OverallStatus;
  target: {
    base_url: string;
    loopback: boolean;
  };
  configuration: {
    network_enabled: boolean;
    mutation_enabled: boolean;
    agent_api_access_configured: boolean;
    timeout_ms: number;
  };
  checks: EnvironmentConnectorAcceptanceCheck[];
  cleanup: EnvironmentConnectorAcceptanceCheck[];
  limitations: string[];
  security: {
    source_credential_persisted: false;
    device_credential_persisted: false;
    credential_values_reported: false;
    private_routing_reported: false;
    command_execution: "command_execution_not_enabled";
  };
};

export type EnvironmentConnectorAcceptanceOptions = {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  now?: () => Date;
  randomId?: () => string;
};

type HttpResult = {
  status: number;
  ok: boolean;
  headers: Headers;
  body: unknown;
};

const normalizeBaseUrl = (value: string): {
  baseUrl: string;
  loopback: boolean;
} => {
  const parsed = new URL(value);
  const loopback = new Set(["127.0.0.1", "localhost", "::1"]).has(
    parsed.hostname,
  );
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && loopback)
  ) {
    throw new Error("acceptance_target_transport_invalid");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return {
    baseUrl: parsed.toString().replace(/\/+$/, ""),
    loopback,
  };
};

const parseTimeout = (value: string | undefined): number => {
  const parsed = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new Error("acceptance_timeout_invalid");
  }
  return parsed;
};

const asRecord = (value: unknown): RecordLike =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : {};

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const stringField = (value: unknown, key: string): string => {
  const field = asRecord(value)[key];
  if (typeof field !== "string" || !field.trim()) {
    throw new Error(`acceptance_response_missing_${key}`);
  }
  return field;
};

const positiveIntegerField = (value: unknown, key: string): number => {
  const field = asRecord(value)[key];
  if (!Number.isInteger(field) || Number(field) <= 0) {
    throw new Error(`acceptance_response_missing_${key}`);
  }
  return Number(field);
};

const safeMessage = (
  error: unknown,
  secrets: readonly string[] = [],
): string =>
  String(
    redactSecrets(
      error instanceof Error ? error.message : "acceptance_request_failed",
      secrets,
    ),
  ).slice(0, 500);

const parseSessionCookie = (response: Response): string => {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0]?.trim();
  if (!value || !/^helix_session=[^;\s]+$/u.test(value)) {
    throw new Error("acceptance_session_cookie_missing");
  }
  return value;
};

const sha256Digest = (body: string): string =>
  `sha-256=${crypto
    .createHash("sha256")
    .update(body, "utf8")
    .digest("base64")}`;

const check = (
  id: string,
  status: CheckStatus,
  summary: string,
  reasonCode: string | null = null,
  evidence?: RecordLike,
): EnvironmentConnectorAcceptanceCheck => ({
  id,
  status,
  reason_code: reasonCode,
  summary,
  ...(evidence ? { evidence } : {}),
});

export const runEnvironmentConnectorLiveAcceptance = async (
  options: EnvironmentConnectorAcceptanceOptions = {},
): Promise<EnvironmentConnectorLiveAcceptanceReport> => {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const target = normalizeBaseUrl(
    env.HELIX_ENVIRONMENT_CONNECTOR_ACCEPTANCE_BASE_URL ?? DEFAULT_BASE_URL,
  );
  const timeoutMs = parseTimeout(
    env.HELIX_ENVIRONMENT_CONNECTOR_ACCEPTANCE_TIMEOUT_MS,
  );
  const networkEnabled =
    env.HELIX_ENVIRONMENT_CONNECTOR_ACCEPTANCE_NETWORK === "1";
  const mutationEnabled =
    networkEnabled &&
    env.HELIX_ENVIRONMENT_CONNECTOR_ACCEPTANCE_ALLOW_MUTATION === "1";
  const loopbackAllowed =
    env.HELIX_ENVIRONMENT_CONNECTOR_ACCEPTANCE_ALLOW_LOOPBACK_HTTP === "1";
  const accessToken =
    env.HELIX_ENVIRONMENT_CONNECTOR_ACCEPTANCE_ACCESS_TOKEN?.trim() ||
    env.HELIX_SHARED_ROOM_ACCEPTANCE_ACCESS_TOKEN?.trim() ||
    env.CASIMIRBOT_MCP_ACCESS_TOKEN?.trim() ||
    null;
  const secrets = accessToken ? [accessToken] : [];
  if (
    new URL(target.baseUrl).protocol === "http:" &&
    (!target.loopback || !loopbackAllowed)
  ) {
    throw new Error("acceptance_loopback_http_not_allowed");
  }

  const checks: EnvironmentConnectorAcceptanceCheck[] = [];
  const cleanup: EnvironmentConnectorAcceptanceCheck[] = [];
  const limitations: string[] = [];
  const report = (): EnvironmentConnectorLiveAcceptanceReport => {
    const failed = checks.some((entry) => entry.status === "fail");
    const skipped = checks.some((entry) => entry.status === "skipped");
    const value: EnvironmentConnectorLiveAcceptanceReport = {
      schema: HELIX_ENVIRONMENT_CONNECTOR_LIVE_ACCEPTANCE_SCHEMA,
      generated_at: now().toISOString(),
      status: failed ? "fail" : skipped ? "partial" : "pass",
      target: {
        base_url: target.baseUrl,
        loopback: target.loopback,
      },
      configuration: {
        network_enabled: networkEnabled,
        mutation_enabled: mutationEnabled,
        agent_api_access_configured: Boolean(accessToken),
        timeout_ms: timeoutMs,
      },
      checks,
      cleanup,
      limitations,
      security: {
        source_credential_persisted: false,
        device_credential_persisted: false,
        credential_values_reported: false,
        private_routing_reported: false,
        command_execution: "command_execution_not_enabled",
      },
    };
    return JSON.parse(
      String(redactSecrets(JSON.stringify(value), secrets)),
    ) as EnvironmentConnectorLiveAcceptanceReport;
  };

  if (!networkEnabled || !mutationEnabled) {
    checks.push(
      check(
        "live_mutation_opt_in",
        "skipped",
        "Live room, source, and pairing mutations require both explicit opt-ins.",
        "acceptance_live_mutation_not_enabled",
      ),
    );
    limitations.push(
      "No network or mutable connector lifecycle was executed in dry-run mode.",
    );
    return report();
  }

  let sessionCookie: string | null = null;
  let roomId: string | null = null;
  let sourceBindingId: string | null = null;
  let deviceId: string | null = null;
  let agentRunId: string | null = null;
  let agentRunVersion: number | null = null;
  let agentRunBindingRef: string | null = null;
  const producerEpoch = `connector-acceptance:${randomId()}`;
  let sequence = 0;

  const request = async (
    path: string,
    init: RequestInit = {},
    cookieAuthenticated = false,
    requestTimeoutMs = timeoutMs,
  ): Promise<HttpResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(`${target.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...(cookieAuthenticated && sessionCookie
            ? {
                Cookie: sessionCookie,
                Origin: target.baseUrl,
                "Sec-Fetch-Site": "same-origin",
              }
            : {}),
          ...(init.headers ?? {}),
        },
      });
      let body: unknown = null;
      const text = await response.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      if (!response.ok) {
        const record = asRecord(body);
        const code =
          typeof record.error === "string"
            ? record.error
            : `http_${response.status}`;
        throw new Error(code);
      }
      return {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        body,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const jsonRequest = async (
    path: string,
    body: unknown,
    input: {
      method?: string;
      cookieAuthenticated?: boolean;
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ): Promise<HttpResult> =>
    request(
      path,
      {
        method: input.method ?? "POST",
        headers: {
          "content-type": "application/json",
          ...(input.headers ?? {}),
        },
        body: JSON.stringify(body),
      },
      input.cookieAuthenticated ?? false,
      input.timeoutMs ?? timeoutMs,
    );

  try {
    const signInResponse = await fetchImpl(
      `${target.baseUrl}/api/account/session/sign-in`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: target.baseUrl,
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({
          profile_id:
            env.HELIX_ENVIRONMENT_CONNECTOR_ACCEPTANCE_PROFILE_ID ??
            DEFAULT_PROFILE_ID,
          display_name: "Environment Connector live acceptance",
          account_type: "developer",
        }),
      },
    );
    if (!signInResponse.ok) throw new Error("developer_session_sign_in_failed");
    sessionCookie = parseSessionCookie(signInResponse);
    checks.push(
      check(
        "developer_session",
        "pass",
        "A developer account session was established; its cookie remains memory-only.",
      ),
    );

    const room = await jsonRequest(
      "/api/agi/realtime/rooms",
      { title: "Environment Connector live acceptance" },
      {
        cookieAuthenticated: true,
        headers: { "Idempotency-Key": `env-room-${randomId()}` },
      },
    );
    roomId = stringField(asRecord(room.body).room, "room_id");
    checks.push(
      check("room_create", "pass", "A developer-owned live room was created."),
    );

    const sourceCreate = await jsonRequest(
      `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/source-bindings`,
      {
        world_id: `minecraft:acceptance:${randomId()}`,
        domain_adapter: "minecraft.paper_plugin.v1",
        source_label: "Minecraft Paper acceptance connector",
      },
      {
        cookieAuthenticated: true,
        headers: { "Idempotency-Key": `env-source-${randomId()}` },
      },
    );
    const sourceCreateBody = asRecord(sourceCreate.body);
    const sourceBindingProjection = asRecord(sourceCreateBody.binding);
    sourceBindingId = stringField(
      sourceBindingProjection,
      "binding_id",
    );
    const sourceId = stringField(sourceBindingProjection, "source_id");
    const worldId = stringField(sourceBindingProjection, "world_id");
    const domainAdapter = stringField(
      sourceBindingProjection,
      "domain_adapter",
    );
    const credentialDelivery = asRecord(
      sourceCreateBody.credential_delivery,
    );
    const claimHandle = stringField(credentialDelivery, "claim_handle");
    checks.push(
      check(
        "source_binding_create",
        "pass",
        "The room source binding returned only a deferred credential-delivery handle.",
        null,
        {
          bearer_included: credentialDelivery.bearer_included === true,
          plugin_config_included:
            credentialDelivery.plugin_config_included === true,
        },
      ),
    );

    const sourceClaim = await jsonRequest(
      "/api/agi/realtime/room-source-credential-deliveries/claim",
      { claim_handle: claimHandle },
      { cookieAuthenticated: true },
    );
    const sourceClaimBody = asRecord(sourceClaim.body);
    const sourceCredential = stringField(sourceClaimBody, "token_value");
    if (!sourceCredential.startsWith("helix_room_src_")) {
      throw new Error("source_credential_invalid");
    }
    checks.push(
      check(
        "source_credential_claim",
        "pass",
        "The source credential was delivered once and retained only in process memory.",
        null,
        {
          token_value_shown_once:
            sourceClaimBody.token_value_shown_once === true,
          secret_stored_raw: sourceClaimBody.secret_stored_raw === true,
        },
      ),
    );

    const sourceRequest = async (
      suffix: string,
      bodyValue: unknown,
      method = "POST",
    ): Promise<HttpResult> => {
      const raw = bodyValue === null ? "" : JSON.stringify(bodyValue);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${sourceCredential}`,
        "X-Helix-Ingress-Version": "1",
        "X-Helix-Request-Id": randomId(),
        "X-Helix-Producer-Epoch": producerEpoch,
        "X-Helix-Sequence": String(++sequence),
        "X-Helix-Sent-At": now().toISOString(),
        Digest: sha256Digest(raw),
      };
      if (bodyValue !== null) headers["content-type"] = "application/json";
      return request(
        `/api/room-ingress/v1/bindings/${encodeURIComponent(sourceBindingId!)}/${suffix}`,
        {
          method,
          headers,
          ...(bodyValue !== null ? { body: raw } : {}),
        },
      );
    };

    const manifest = {
      ...manifestFixture,
      manifest_id: `manifest:${sourceId}:acceptance`,
      source_id: sourceId,
      room_id: roomId,
      domain_adapter: domainAdapter,
      created_at: now().toISOString(),
    };
    const manifestResponse = await sourceRequest("manifest", manifest);
    const manifestObservation = asRecord(
      asRecord(manifestResponse.body).observation_ref,
    );
    checks.push(
      check(
        "minecraft_manifest_admission",
        "pass",
        "The Minecraft Paper manifest passed the code-owned adapter contract.",
        null,
        {
          audit_ok: manifestObservation.audit_ok === true,
          adapter_profile_id: asRecord(
            manifestObservation.adapter_admission,
          ).adapter_profile_id,
        },
      ),
    );

    const heartbeatResponse = await sourceRequest("heartbeat", {
      schema: "helix.environment_source_heartbeat.v1",
      heartbeat_id: `heartbeat:${randomId()}`,
      source_id: sourceId,
      room_id: roomId,
      domain: "minecraft",
      domain_adapter: domainAdapter,
      status: "active",
      active_players: [
        {
          actor_id: "minecraft:player:acceptance",
          stable_actor_id: "00000000-0000-4000-8000-000000000001",
          actor_label: "AcceptancePlayer",
          dimension: "minecraft:overworld",
        },
      ],
      pending_probe_count: 0,
      evidence_refs: [`manifest:${sourceId}:acceptance`],
      assistant_answer: false,
      raw_content_included: false,
      created_at: now().toISOString(),
    });
    checks.push(
      check(
        "source_heartbeat",
        "pass",
        "A fresh exact-source Minecraft heartbeat was accepted.",
        null,
        {
          status: asRecord(
            asRecord(heartbeatResponse.body).observation_ref,
          ).status,
        },
      ),
    );

    const identity = createConnectorPairingIdentity();
    const connector = new HelixEnvironmentConnectorClient(
      target.baseUrl,
      fetchImpl,
    );
    const pairing = await connector.startPairing({
      packageVersionId: MINECRAFT_PACKAGE_VERSION_ID,
      identity,
      requestedCapabilityIds: [MINECRAFT_INVENTORY_CAPABILITY],
    });
    checks.push(
      check(
        "device_pairing_start",
        "pass",
        "The outbound connector proved possession of a fresh Ed25519 device key.",
      ),
    );

    await jsonRequest(
      "/api/agi/environment-connectors/pairing/approve",
      {
        user_code: pairing.session.user_code,
        room_id: roomId,
        room_source_binding_id: sourceBindingId,
        approved_capability_ids: [MINECRAFT_INVENTORY_CAPABILITY],
      },
      { cookieAuthenticated: true },
    );
    checks.push(
      check(
        "device_pairing_approval",
        "pass",
        "The room owner approved only the Minecraft inventory capability.",
      ),
    );

    const paired = await connector.claimPairing({
      pairingSessionId: pairing.session.pairing_session_id,
      claimChallenge: pairing.claimChallenge,
      identity,
    });
    deviceId = paired.deviceId;
    checks.push(
      check(
        "device_pairing_claim",
        "pass",
        "The connector claimed one scoped device credential; only nonsecret identities were projected.",
        null,
        {
          device_id: paired.deviceId,
          environment_binding_id: paired.environmentBindingId,
          catalog_snapshot_id: paired.catalogSnapshotId,
          scopes: paired.scopes,
        },
      ),
    );

    const deviceHeartbeat = await connector.heartbeat();
    checks.push(
      check(
        "device_heartbeat",
        "pass",
        "The paired device authenticated and reported healthy.",
        null,
        {
          health: deviceHeartbeat.health,
          command_execution: deviceHeartbeat.commandExecution,
        },
      ),
    );

    const environmentsResponse = await request(
      `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/environments`,
      { method: "GET" },
      true,
    );
    const environment = asArray(
      asRecord(environmentsResponse.body).environments,
    )
      .map(asRecord)
      .find(
        (candidate) =>
          candidate.room_source_binding_id === sourceBindingId,
      );
    if (!environment) {
      throw new Error("acceptance_environment_projection_missing");
    }
    const environmentBindingId = stringField(
      environment,
      "environment_binding_id",
    );
    const subjects = asArray(
      asRecord(environment.subject_directory).subjects,
    ).map(asRecord);
    const acceptanceSubject = subjects.find(
      (candidate) => candidate.display_label === "AcceptancePlayer",
    );
    if (!acceptanceSubject) {
      throw new Error("acceptance_environment_subject_missing");
    }
    const subjectRef = stringField(acceptanceSubject, "subject_ref");
    const subjectBindingResponse = await jsonRequest(
      `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/environments/${encodeURIComponent(environmentBindingId)}/me`,
      { subject_ref: subjectRef },
      { method: "PUT", cookieAuthenticated: true },
    );
    const subjectBinding = asRecord(subjectBindingResponse.body).binding;
    checks.push(
      check(
        "room_environment_subject_binding",
        "pass",
        "The room member selected the fresh stable Minecraft player identity before current-actor routing.",
        null,
        {
          environment_binding_id: environmentBindingId,
          subject_kind: asRecord(subjectBinding).subject_kind,
          subject_label: asRecord(subjectBinding).subject_label,
          verification_method: asRecord(subjectBinding).verification_method,
          raw_native_identity_reported: false,
        },
      ),
    );

    const pending = await connector.poll(1);
    if (pending.length > 0) {
      throw new Error("unexpected_pending_probe_for_fresh_acceptance_device");
    }
    checks.push(
      check(
        "device_probe_poll",
        "pass",
        "The outbound-only device poll succeeded with no unrelated lease delivery.",
        null,
        { pending_count: pending.length },
      ),
    );

    const metadata = await request(
      "/.well-known/oauth-protected-resource/api/v1/agent-runs",
    ).catch((error) => ({
      status: /auth_not_configured/u.test(safeMessage(error, secrets))
        ? 503
        : 0,
      ok: false,
      headers: new Headers(),
      body: null,
    }));
    if (metadata.ok) {
      checks.push(
        check(
          "agent_api_oauth",
          "pass",
          "The Agent API protected-resource metadata is available.",
        ),
      );
      if (!accessToken) {
        checks.push(
          check(
            "agent_api_environment_probe",
            "skipped",
            "A successful bound Agent API probe requires a legitimate OAuth access token supplied only through the acceptance environment.",
            "access_token_not_configured",
          ),
        );
        limitations.push(
          "Protected-resource metadata is ready, but no memory-only acceptance access token was supplied.",
        );
      } else {
        try {
          const agentHeaders = {
            Authorization: `Bearer ${accessToken}`,
          };
          const runStart = await jsonRequest(
            "/api/v1/agent-runs",
            {
              objective:
                "Check my current Minecraft inventory now using the connected environment.",
              constraints: [
                "Use only the exact bound read-only Minecraft inventory capability.",
                "Do not execute commands or mutate the environment.",
                "Answer only after current-turn probe evidence re-enters the waiting tool call.",
              ],
              database_scope: [AGENT_API_DATABASE_SCOPE],
              completion_contract: {
                min_evidence_refs: 1,
                require_terminal_authority: true,
                required_output_fields: [
                  "text",
                  "supporting_evidence_refs",
                ],
                max_unresolved_requirements: 0,
                allow_conflicts: false,
              },
              budget: {
                max_steps: 2,
                expires_in_seconds: 180,
              },
            },
            {
              headers: {
                ...agentHeaders,
                "Idempotency-Key": `env-agent-start-${randomId()}`,
              },
            },
          );
          agentRunId = stringField(runStart.body, "run_id");
          agentRunVersion = positiveIntegerField(runStart.body, "version");

          const runBinding = await jsonRequest(
            "/api/v1/rooms/run-bindings",
            {
              run_id: agentRunId,
              room_id: roomId,
            },
            { headers: agentHeaders },
          );
          agentRunBindingRef = stringField(
            runBinding.body,
            "binding_ref",
          );

          let continuationSettled = false;
          const continuationTask = jsonRequest(
            `/api/v1/agent-runs/${encodeURIComponent(agentRunId)}/continue`,
            {
              expected_version: agentRunVersion,
              instruction:
                "Perform the requested inventory check now and ground the final answer in the fresh connector observation.",
              answers: [],
            },
            {
              headers: {
                ...agentHeaders,
                "Idempotency-Key": `env-agent-continue-${randomId()}`,
              },
              timeoutMs: Math.max(
                timeoutMs,
                AGENT_API_TURN_TIMEOUT_MS,
              ),
            },
          )
            .then(
              (value) => ({ ok: true as const, value }),
              (error: unknown) => ({ ok: false as const, error }),
            )
            .finally(() => {
              continuationSettled = true;
            });

          const leaseDeadline =
            Date.now() + Math.max(timeoutMs, AGENT_API_TURN_TIMEOUT_MS);
          let lease: (typeof pending)[number] | null = null;
          while (
            !lease &&
            !continuationSettled &&
            Date.now() < leaseDeadline
          ) {
            const leases = await connector.poll(1);
            if (leases.length > 0) {
              lease = leases[0];
              break;
            }
            await new Promise<void>((resolve) =>
              setTimeout(resolve, 200),
            );
          }
          if (!lease) {
            const continuation = await continuationTask;
            if (!continuation.ok) throw continuation.error;
            throw new Error(
              "agent_api_environment_probe_lease_not_delivered",
            );
          }
          if (
            lease.capability_id !== MINECRAFT_INVENTORY_CAPABILITY ||
            lease.capability_request.capability_id !==
              MINECRAFT_INVENTORY_CAPABILITY ||
            lease.capability_request.arguments.target !== "current_actor"
          ) {
            throw new Error(
              "agent_api_environment_probe_lease_identity_mismatch",
            );
          }

          await connector.submit(
            lease,
            createSucceededProbeResult({
              request: lease.capability_request,
              summary:
                "The current actor has 20 items in two occupied inventory slots.",
              result: {
                result_summary:
                  "The current actor has 12 oak logs and 8 torches.",
                item_count: 20,
                slots: [
                  { slot: 0, item: "minecraft:oak_log", count: 12 },
                  { slot: 1, item: "minecraft:torch", count: 8 },
                ],
              },
            }),
          );

          const continuation = await continuationTask;
          if (!continuation.ok) throw continuation.error;
          const run = asRecord(continuation.value.body);
          agentRunVersion = positiveIntegerField(run, "version");
          const evidence = asRecord(run.evidence);
          const observationRefs = asArray(
            evidence.observation_refs,
          ).filter((entry): entry is string => typeof entry === "string");
          const eventsResponse = await request(
            `/api/v1/agent-runs/${encodeURIComponent(agentRunId)}/events?after_seq=0&limit=100`,
            { headers: agentHeaders },
          );
          const eventTypes = asArray(
            asRecord(eventsResponse.body).events,
          )
            .map((entry) => asRecord(entry).event_type)
            .filter(
              (entry): entry is string => typeof entry === "string",
            );
          const completed =
            run.lifecycle_status === "completed" &&
            run.completion_status === "completed" &&
            run.terminal_authority_status === "authorized" &&
            observationRefs.length > 0 &&
            eventTypes.includes("evidence_reentered") &&
            eventTypes.includes("terminal_authority_evaluated") &&
            eventTypes.includes("run_completed");
          if (!completed) {
            throw new Error(
              "agent_api_environment_probe_terminal_contract_incomplete",
            );
          }
          checks.push(
            check(
              "agent_api_environment_probe",
              "pass",
              "The authenticated Agent API run dispatched one exact Minecraft lease, re-entered its fresh observation, performed post-observation reasoning, and completed under Helix terminal authority.",
              null,
              {
                run_id: agentRunId,
                observation_ref_count: observationRefs.length,
                evidence_reentered: true,
                terminal_authority_evaluated: true,
                terminal_authority_status:
                  run.terminal_authority_status,
                lifecycle_status: run.lifecycle_status,
                command_execution:
                  "command_execution_not_enabled",
              },
            ),
          );
        } catch (error) {
          checks.push(
            check(
              "agent_api_environment_probe",
              "fail",
              safeMessage(error, secrets),
              "agent_api_environment_probe_failed",
            ),
          );
        }
      }
    } else {
      checks.push(
        check(
          "agent_api_oauth",
          "skipped",
          "The external Agent API cannot run a legitimate bound continuation until OAuth is configured.",
          "auth_not_configured",
        ),
      );
      limitations.push(
        "A successful model-backed Agent API environment probe remains deployment-blocked by missing OAuth protected-resource configuration.",
      );
      checks.push(
        check(
          "agent_api_environment_probe",
          "skipped",
          "The governed Agent API probe was not attempted because the protected resource is not configured.",
          "auth_not_configured",
        ),
      );
    }
  } catch (error) {
    checks.push(
      check(
        "live_connector_lifecycle",
        "fail",
        safeMessage(error, secrets),
        "environment_connector_live_acceptance_failed",
      ),
    );
  } finally {
    if (agentRunBindingRef && accessToken) {
      try {
        await request(
          `/api/v1/rooms/run-bindings/${encodeURIComponent(agentRunBindingRef)}`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          },
        );
        cleanup.push(
          check(
            "agent_run_room_binding_revoke",
            "pass",
            "The temporary authenticated run-room binding was revoked.",
          ),
        );
        agentRunBindingRef = null;
      } catch (error) {
        cleanup.push(
          check(
            "agent_run_room_binding_revoke",
            "fail",
            safeMessage(error, secrets),
            "agent_run_binding_cleanup_failed",
          ),
        );
      }
    }
    if (agentRunId && accessToken) {
      try {
        const inspected = await request(
          `/api/v1/agent-runs/${encodeURIComponent(agentRunId)}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          },
        );
        const run = asRecord(inspected.body);
        const lifecycle = String(run.lifecycle_status ?? "");
        if (["completed", "failed", "cancelled"].includes(lifecycle)) {
          cleanup.push(
            check(
              "agent_run_cleanup",
              "pass",
              "The authenticated acceptance run was already terminal.",
              null,
              { lifecycle_status: lifecycle },
            ),
          );
        } else {
          agentRunVersion = positiveIntegerField(run, "version");
          const cancelled = await jsonRequest(
            `/api/v1/agent-runs/${encodeURIComponent(agentRunId)}/cancel`,
            {
              expected_version: agentRunVersion,
              reason: "environment_connector_acceptance_cleanup",
            },
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Idempotency-Key": `env-agent-cancel-${randomId()}`,
              },
            },
          );
          const cancelledLifecycle = asRecord(
            cancelled.body,
          ).lifecycle_status;
          cleanup.push(
            check(
              "agent_run_cleanup",
              cancelledLifecycle === "cancelled" ? "pass" : "fail",
              "The nonterminal authenticated acceptance run was cancelled.",
              cancelledLifecycle === "cancelled"
                ? null
                : "agent_run_cancel_contract_mismatch",
            ),
          );
        }
      } catch (error) {
        cleanup.push(
          check(
            "agent_run_cleanup",
            "fail",
            safeMessage(error, secrets),
            "agent_run_cleanup_failed",
          ),
        );
      }
    }
    if (deviceId && roomId && sessionCookie) {
      try {
        await jsonRequest(
          `/api/agi/environment-connectors/devices/${encodeURIComponent(deviceId)}`,
          { room_id: roomId },
          { method: "DELETE", cookieAuthenticated: true },
        );
        cleanup.push(
          check(
            "device_revoke",
            "pass",
            "The temporary paired device credential was revoked.",
          ),
        );
      } catch (error) {
        cleanup.push(
          check(
            "device_revoke",
            "fail",
            safeMessage(error, secrets),
            "device_cleanup_failed",
          ),
        );
      }
    }
    if (sourceBindingId && roomId && sessionCookie) {
      try {
        await jsonRequest(
          `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/source-bindings/${encodeURIComponent(sourceBindingId)}/revoke`,
          {},
          { cookieAuthenticated: true },
        );
        cleanup.push(
          check(
            "source_binding_revoke",
            "pass",
            "The temporary source binding and its credential were revoked.",
          ),
        );
      } catch (error) {
        cleanup.push(
          check(
            "source_binding_revoke",
            "fail",
            safeMessage(error, secrets),
            "source_binding_cleanup_failed",
          ),
        );
      }
    }
    if (roomId && sessionCookie) {
      try {
        await jsonRequest(
          `/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/leave`,
          {},
          { cookieAuthenticated: true },
        );
        cleanup.push(
          check(
            "room_close",
            "pass",
            "The temporary owner room was closed.",
          ),
        );
      } catch (error) {
        cleanup.push(
          check(
            "room_close",
            "fail",
            safeMessage(error, secrets),
            "room_cleanup_failed",
          ),
        );
      }
    }
    if (sessionCookie) {
      try {
        await jsonRequest(
          "/api/account/session/sign-out",
          {},
          { cookieAuthenticated: true },
        );
        cleanup.push(
          check(
            "developer_session_sign_out",
            "pass",
            "The temporary developer session was signed out.",
          ),
        );
      } catch (error) {
        cleanup.push(
          check(
            "developer_session_sign_out",
            "fail",
            safeMessage(error, secrets),
            "session_cleanup_failed",
          ),
        );
      }
      sessionCookie = null;
    }
  }

  const finalReport = report();
  if (cleanup.some((entry) => entry.status === "fail")) {
    finalReport.status = "fail";
  }
  return finalReport;
};

const main = async (): Promise<void> => {
  try {
    const report = await runEnvironmentConnectorLiveAcceptance();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status === "fail") process.exitCode = 1;
    if (
      report.status === "partial" &&
      process.env.HELIX_ENVIRONMENT_CONNECTOR_ACCEPTANCE_REQUIRE_COMPLETE ===
        "1"
    ) {
      process.exitCode = 2;
    }
  } catch {
    process.stdout.write(
      `${JSON.stringify(
        {
          schema: HELIX_ENVIRONMENT_CONNECTOR_LIVE_ACCEPTANCE_SCHEMA,
          status: "fail",
          error: "acceptance_configuration_invalid",
          message:
            "The connector acceptance configuration is invalid; no environment values were printed.",
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
