import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type RecordLike = Record<string, unknown>;

type Assertion = {
  id: string;
  ok: boolean;
  detail: string;
};

type TurnResult = {
  id: string;
  prompt: string;
  turn_id: string;
  handoff_id: string;
  selected_route: string | null;
  required_grounding_capability_ids: string[];
  called_capability_ids: string[];
  executed_capability_ids: string[];
  selected_model: string | null;
  terminal_artifact_kind: string | null;
  final_answer_source: string | null;
  final_answer: string;
  solver_completed: boolean;
  server_authoritative: boolean;
  feedback_recorded: boolean;
  grounding_evidence_status: string | null;
  grounding_proof_source: string | null;
  relay_status: string | null;
  relay_reason: string | null;
  relay_failure_code: string | null;
  relay_terminal_speech_authority_status: string | null;
  relay_grounding_status: string | null;
  grounding_authority_status: string | null;
  grounding_authority_failure_codes: string[];
  provisional_kind: string | null;
  provisional_utterance_code: string | null;
  provisional_answer_authority: boolean;
  continuity_evidence_refs: string[];
  handoff_evidence_refs: string[];
  scientific_closure_identity_count: number;
  scientific_closure_statuses: string[];
  scientific_closure_canonical_within_enrollment: boolean[];
};

export type RealtimeDocProbeTurn = {
  id: string;
  prompt: string;
  documentRef?: string;
  focusPanelId?: string;
  expectedText: RegExp[];
  requireDocsSearch?: boolean;
  expectedCapabilities?: string[];
  requireGroundedVoiceRelay?: boolean;
  allowTypedCapabilityFailure?: boolean;
};

export type RealtimeDocProbeScenario = {
  id: string;
  requiresDeveloper: boolean;
  focusPanelId: string;
  turns: RealtimeDocProbeTurn[];
};

const BASE_URL = (process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:1522")
  .replace(/\/+$/, "");
const TEST_MODEL = process.env.HELIX_ASK_TEST_MODEL?.trim() || "gpt-4o-mini";
const TEST_SCENARIO = process.env.HELIX_ASK_REALTIME_DOC_SCENARIO?.trim() || "conversation";
const CAPTURE_DEBUG = process.env.HELIX_ASK_REALTIME_DOC_CAPTURE_DEBUG === "1";
const DRY_RUN =
  process.argv.includes("--dry-run") ||
  process.env.HELIX_ASK_REALTIME_DOC_DRY_RUN === "1";
const LOCAL_DEVELOPER_SIGN_IN =
  process.env.HELIX_ASK_REALTIME_DOC_LOCAL_DEVELOPER === "1";
const TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.HELIX_ASK_REALTIME_DOC_TIMEOUT_MS ?? 180_000),
);
const RUN_ID = `realtime-doc-conversation-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const PROBE_THREAD_ID =
  process.env.HELIX_ASK_REALTIME_DOC_THREAD_ID?.trim() ||
  `helix-ask:${RUN_ID}`;
const OUTPUT_PATH = path.resolve(
  process.env.HELIX_ASK_REALTIME_DOC_PROBE_OUT ??
    path.join("artifacts", "helix-ask-live-validation", "realtime-doc-conversation", `${RUN_ID}.json`),
);
let requestCookie: string | null = null;

export const THEORY_EXPERIMENT_PROCEDURE_REALTIME_SCENARIO: RealtimeDocProbeScenario = {
  id: "theory-experiment-procedure",
  requiresDeveloper: true,
  focusPanelId: "workflow-demo-lab",
  turns: [
    {
      id: "theory-procedure-prepare",
      prompt:
        "Prepare a seven-stage theory experiment procedure comparing badge study.casimir_dp.evidence_map_stage3 with physics.energy.energy_density, using the pinned Lanyon case advection_diffusion_full_1d. Keep dependency order separate from scale checkpoints. Prepare only; do not start formal, numerical, or shell work.",
      focusPanelId: "workflow-demo-lab",
      expectedText: [
        /seven|7/i,
        /procedure|prepared/i,
        /dependency|DAG|order/i,
        /scale|checkpoint|biome/i,
        /Lanyon|advection.?diffusion/i,
      ],
      expectedCapabilities: ["theory-experiment-procedure.prepare"],
      requireGroundedVoiceRelay: true,
    },
    {
      id: "theory-procedure-missing-requirements",
      prompt:
        "Continue that same comparison. Re-prepare the procedure so its evidence is current for this turn, then identify the missing semantic admission, bridge or boundary-condition, formal-certificate, independent numerical, and observable or empirical requirements. Keep the interpretation bounded: preparation is not proof or physical validation, and do not start downstream jobs.",
      focusPanelId: "workflow-demo-lab",
      expectedText: [
        /semantic|admission/i,
        /bridge|boundary|initial condition/i,
        /formal|Lean|certificate/i,
        /numerical/i,
        /observable|empirical/i,
        /not proof|not.*validat|missing|requires/i,
      ],
      expectedCapabilities: ["theory-experiment-procedure.prepare"],
      requireGroundedVoiceRelay: true,
    },
    {
      id: "gr-maxwell-formal-source-scope",
      prompt:
        "Now call theory-formal-verifier.inspect_artifact_family for formal artifact casimir:lanyon:gr_hyperbolic_maxwell_1d:formal_source and theorem xHyperbolicity. Explain its exact claim ceiling and denied promotions. Do not start Lean, numerical work, or any downstream job.",
      focusPanelId: "workflow-demo-lab",
      expectedText: [
        /xHyperbolicity|hyperbolicity/i,
        /definition.?well.?typed|well.?typed|Real/i,
        /does not|not prove|denied|blocked/i,
        /not run|not executed|did not.*Lean|replay/i,
      ],
      expectedCapabilities: [
        "theory-formal-verifier.inspect_artifact_family",
      ],
      requireGroundedVoiceRelay: true,
    },
  ],
};

export const SCIENTIFIC_EVIDENCE_CLOSURE_REALTIME_SCENARIO:
  RealtimeDocProbeScenario = {
    id: "scientific-evidence-closure",
    requiresDeveloper: true,
    focusPanelId: "workflow-demo-lab",
    turns: [
      {
        id: "scientific-closure-inspect",
        prompt:
          "Inspect the conformed scientific-evidence enrollment for advection_diffusion_full_1d. Show the selected Theory Badge orientation, registered source claim, permitted Dxx intervention, exact Lanyon and Lean bindings, numerical lineages, and the maximum claim ceiling. Inspect only; do not prepare, evaluate, or start any runtime.",
        expectedText: [
          /advection.?diffusion|Dxx/i,
          /badge|orientation/i,
          /Lanyon/i,
          /Lean|formal/i,
          /numerical|lineage/i,
          /bounded|claim|synthetic/i,
        ],
        expectedCapabilities: [
          "scientific-evidence-closure.inspect_enrollment",
        ],
        requireGroundedVoiceRelay: true,
      },
      {
        id: "scientific-closure-prepare",
        prompt:
          "Continue with that exact enrollment. Prepare a current-turn execution plan changing permitted Dxx from 0.01 to 0.02 while freezing every other registered input. Bind the plan to the same badge orientation, source claim, Lanyon semantics, pinned Lean contract, primary and independent numerics, confirmation policy, and closure evaluator. Prepare only; do not start or evaluate.",
        expectedText: [
          /0\.01/,
          /0\.02/,
          /plan|prepared/i,
          /Lanyon|semantic/i,
          /Lean|formal/i,
          /primary|independent|numerical/i,
          /confirmation|approval/i,
        ],
        expectedCapabilities: ["scientific-evidence-closure.prepare"],
        requireGroundedVoiceRelay: true,
      },
      {
        id: "scientific-closure-evaluate-or-block",
        prompt:
          "Now call scientific-evidence-closure.evaluate for that exact current-turn plan, using only current-turn confirmation, formal, and numerical artifacts that actually exist. If trusted confirmation or external sandbox attestations are absent, return the exact actionable blockers. Do not invent receipts, do not call the result canonical, and do not promote synthetic closure to empirical or physical evidence.",
        expectedText: [
          /current-turn/i,
          /closure input ref/i,
          /execution-plan ref/i,
          /plan ID/i,
          /required/i,
        ],
        expectedCapabilities: ["scientific-evidence-closure.evaluate"],
        allowTypedCapabilityFailure: true,
      },
    ],
  };

export const COMPOUND_DOC_SCHOLARLY_REALTIME_SCENARIO:
  RealtimeDocProbeScenario = {
    id: "compound-doc-scholarly-comparison",
    requiresDeveloper: true,
    focusPanelId: "docs-viewer",
    turns: [
      {
        id: "nhm2-arxiv-source-closure-comparison",
        prompt:
          "Open the NHM2 current status whitepaper in the local docs and compare its source-closure caution with the primary paper arXiv:2105.03079. Explain where they agree and where the paper does not validate NHM2, citing both sources.",
        expectedText: [
          /NHM2/i,
          /2105\.03079|arXiv/i,
          /source|closure|observer|energy/i,
          /does not validate|not.*validat|cannot.*validat/i,
        ],
        expectedCapabilities: [
          "docs.search",
          "scholarly-research.lookup_papers",
          "scholarly-research.fetch_full_text",
        ],
        requireGroundedVoiceRelay: true,
      },
      {
        id: "nhm2-arxiv-assumption-mismatch-followup",
        prompt:
          "Which assumption mismatch matters most if someone tries to apply that paper directly to NHM2? Use the sources you just inspected, and separate what follows from the paper from what remains unresolved.",
        expectedText: [
          /unit lapse|flat[-\s]?slice|flat spatial|spatial 3.?metric|spatial metric|g_?\{?ij\}?\s*=\s*\\delta|standard[-\s]?(?:general relativity|GR)|generic Nat[aá]rio/i,
          /all timelike|observer|smooth and bounded|subsidiary conditions?/i,
          /does not|unresolved|cannot|not enough/i,
          /artifact:\/\/scholarly-pdf|arxiv\.org|\bp(?:age|\.)\s*\d+/i,
        ],
        requireGroundedVoiceRelay: true,
      },
    ],
  };

const readRecord = (value: unknown): RecordLike | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordLike : null;

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const readRecords = (value: unknown): RecordLike[] =>
  Array.isArray(value)
    ? value.map(readRecord).filter((entry): entry is RecordLike => Boolean(entry))
    : [];

const readStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(readString).filter((entry): entry is string => Boolean(entry))
    : [];

const requestJson = async (
  route: string,
  init?: { method?: "GET" | "POST"; body?: RecordLike },
): Promise<{ status: number; body: RecordLike }> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${route}`, {
      method: init?.method ?? "GET",
      headers: init?.body
        ? {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(requestCookie ? { Cookie: requestCookie } : {}),
          }
        : {
            Accept: "application/json",
            ...(requestCookie ? { Cookie: requestCookie } : {}),
          },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    const body = readRecord(text ? JSON.parse(text) : null);
    if (!body) throw new Error(`invalid_json_response:${route}`);
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
};

const assertions: Assertion[] = [];

const assert = (id: string, ok: boolean, detail: string): void => {
  assertions.push({ id, ok, detail });
};

export const isLoopbackRealtimeDocBaseUrl = (baseUrl: string): boolean => {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
};

export const resolveRealtimeDocProbeScenario = (
  scenarioId: string,
): RealtimeDocProbeScenario | null =>
  scenarioId === THEORY_EXPERIMENT_PROCEDURE_REALTIME_SCENARIO.id
    ? THEORY_EXPERIMENT_PROCEDURE_REALTIME_SCENARIO
    : scenarioId === SCIENTIFIC_EVIDENCE_CLOSURE_REALTIME_SCENARIO.id
      ? SCIENTIFIC_EVIDENCE_CLOSURE_REALTIME_SCENARIO
      : scenarioId === COMPOUND_DOC_SCHOLARLY_REALTIME_SCENARIO.id
        ? COMPOUND_DOC_SCHOLARLY_REALTIME_SCENARIO
    : null;

const establishLocalDeveloperSession = async (): Promise<void> => {
  if (!isLoopbackRealtimeDocBaseUrl(BASE_URL)) {
    throw new Error("local_developer_sign_in_requires_loopback_base_url");
  }
  const receipt = await requestJson("/api/account/session/sign-in", {
    method: "POST",
    body: {
      profile_id: `helix-ask-realtime-doc-probe:${RUN_ID}`,
      display_name: "Helix Ask Realtime Theory Probe",
      account_type: "developer",
    },
  });
  const sessionId = readString(readRecord(receipt.body.session)?.session_id);
  if (receipt.status !== 200 || receipt.body.ok !== true || !sessionId) {
    throw new Error(
      `local_developer_sign_in_failed:${receipt.status}:${readString(receipt.body.error) ?? "session_missing"}`,
    );
  }
  requestCookie = `helix_session=${sessionId}`;
  const status = await requestJson("/api/account/session");
  const accountPolicy = readRecord(status.body.account_policy);
  const accountType = readString(accountPolicy?.account_type);
  if (status.status !== 200 || accountType !== "developer") {
    try {
      await requestJson("/api/account/session/sign-out", {
        method: "POST",
        body: {},
      });
    } finally {
      requestCookie = null;
    }
    throw new Error(`local_developer_policy_missing:${accountType ?? "unknown"}`);
  }
};

const releaseLocalDeveloperSession = async (): Promise<void> => {
  if (!requestCookie) return;
  try {
    await requestJson("/api/account/session/sign-out", {
      method: "POST",
      body: {},
    });
  } finally {
    requestCookie = null;
  }
};

const sourceBinding = (
  documentRef?: string,
  focusPanelId = "docs-viewer",
): RecordLike => ({
  thread_id: PROBE_THREAD_ID,
  source_id: PROBE_THREAD_ID,
  source_kind: "helix_ask_workstation",
  focus_panel_id: focusPanelId,
  ...(documentRef ? { document_ref: documentRef } : {}),
});

const runLiveProbe = async (): Promise<void> => {
  const selectedScenario = resolveRealtimeDocProbeScenario(TEST_SCENARIO);
  const account = await requestJson("/api/account/session");
  const pipeline = await requestJson("/api/helix/pipeline");
  const providers = await requestJson("/api/agi/agent-providers");
  const codex = readRecords(providers.body.providers)
    .find((provider) => readString(provider.id) === "codex") ?? null;
  const runtimeStatus = readRecord(codex?.runtime_status);
  assert("preflight_account", account.status === 200, `HTTP ${account.status}`);
  if (selectedScenario?.requiresDeveloper) {
    assert(
      "preflight_developer_account",
      readString(readRecord(account.body.account_policy)?.account_type) === "developer",
      `account_type=${String(readRecord(account.body.account_policy)?.account_type)}`,
    );
  }
  assert("preflight_pipeline", pipeline.status === 200, `HTTP ${pipeline.status}`);
  assert(
    "preflight_codex_launchable",
    codex?.enabled === true && runtimeStatus?.launchable === true,
    `enabled=${String(codex?.enabled)} launchable=${String(runtimeStatus?.launchable)}`,
  );

  const now = Date.now();
  const consentReceipt = `receipt:realtime-doc-probe:${now}`;
  const start = await requestJson("/api/agi/realtime/session", {
    method: "POST",
    body: {
      runtime_agent_mode: "live_voice_mini",
      runtime_agent_authority: "suggest_actions",
      selected_runtime_agent_provider: "codex",
      transport: "webrtc",
      sdp_exchange_mode: "server",
      requested_backend_provider: "realtime_session.openai_realtime",
      selected_model_or_service: "gpt-realtime-2.1-mini",
      selected_realtime_voice: "marin",
      source_binding: sourceBinding(undefined, selectedScenario?.focusPanelId),
      visible_user_consent_receipt: consentReceipt,
    },
  });
  const realtimeSessionId = readString(start.body.realtime_session_id);
  if (start.status !== 200 || !realtimeSessionId) {
    throw new Error(`realtime_session_admission_failed:${start.status}:${readString(start.body.error) ?? "unknown"}`);
  }

  const turns: TurnResult[] = [];
  const runTurn = async (input: RealtimeDocProbeTurn): Promise<void> => {
    const observedAtMs = Date.now();
    const event = await requestJson(
      `/api/agi/realtime/session/${encodeURIComponent(realtimeSessionId)}/event`,
      {
        method: "POST",
        body: {
          runtime_agent_mode: "live_voice_mini",
          runtime_agent_authority: "suggest_actions",
          event_type: "transcript.final",
          event_ref: `event:${RUN_ID}:${input.id}`,
          transcript_text: input.prompt,
          observed_at_ms: observedAtMs,
          client_receipt_ref: consentReceipt,
          workstation_source_binding: sourceBinding(
            input.documentRef,
            input.focusPanelId ?? selectedScenario?.focusPanelId,
          ),
        },
      },
    );
    const handoff = readRecord(event.body.realtime_stage_play_ask_handoff);
    const routeMetadata = readRecord(handoff?.route_metadata);
    const binding = readRecord(routeMetadata?.realtime_grounded_feedback_binding);
    const handoffId = readString(handoff?.handoff_id);
    if (!handoff || !routeMetadata || !binding || !handoffId) {
      throw new Error(`realtime_handoff_missing:${input.id}`);
    }
    const workerAdmission = readRecord(handoff.worker_admission);
    const workerAdmissionId = readString(workerAdmission?.admission_id);
    const dispatch = readRecord(workerAdmission?.dispatch);
    const dispatchRequested = dispatch?.requested === true;
    const interactionMode = readString(workerAdmission?.interaction_mode);
    const immediateProvisional = readRecord(event.body.realtime_provisional_response);
    const immediateParallelConversationIsSafe =
      interactionMode === "parallel_conversation" &&
      readString(immediateProvisional?.kind) === "parallel_conversation" &&
      readString(immediateProvisional?.handoff_id) === handoffId &&
      readString(immediateProvisional?.worker_admission_id) === workerAdmissionId &&
      immediateProvisional?.requested_after_worker_dispatch_receipt === false &&
      immediateProvisional?.answer_authority === false &&
      immediateProvisional?.assistant_answer === false &&
      immediateProvisional?.terminal_eligible === false;
    assert(
      `${input.id}_no_pre_dispatch_worker_answer`,
      !dispatchRequested ||
        (
          interactionMode === "parallel_conversation"
            ? immediateParallelConversationIsSafe
            : immediateProvisional === null
        ),
      `dispatch_requested=${String(dispatchRequested)} interaction_mode=${String(interactionMode)} provisional_kind=${String(immediateProvisional?.kind)} authority=${String(immediateProvisional?.answer_authority)}`,
    );
    const dispatchReceipt = dispatchRequested && workerAdmissionId
      ? await requestJson(
          `/api/agi/realtime/session/${encodeURIComponent(realtimeSessionId)}/client-receipt`,
          {
            method: "POST",
            body: {
              client_receipt_ref: `receipt:${RUN_ID}:worker-dispatch:${input.id}`,
              receipt_kind: "worker_dispatch_requested",
              status: "requested",
              observed_at_ms: Date.now(),
              lifecycle_state: "active",
              handoff_id: handoffId,
              worker_admission_id: workerAdmissionId,
              worker_dispatch_kind: readString(dispatch.kind),
              worker_dispatch_state: "requested",
              worker_turn_dispatched: true,
              workstation_action_executed: false,
              realtime_provider_tool_executed: false,
              answer_authority: false,
              assistant_answer: false,
              terminal_eligible: false,
              raw_content_included: false,
              reentry_required: true,
            },
          },
        )
      : null;
    const dispatchProvisional = readRecord(
      dispatchReceipt?.body.realtime_provisional_response,
    );
    const postReceiptParallelConversationIsSafe =
      dispatchProvisional === null ||
      (
        readString(dispatchProvisional.kind) === "parallel_conversation" &&
        readString(dispatchProvisional.handoff_id) === handoffId &&
        readString(dispatchProvisional.worker_admission_id) === workerAdmissionId &&
        dispatchProvisional.answer_authority === false &&
        dispatchProvisional.assistant_answer === false &&
        dispatchProvisional.terminal_eligible === false
      );
    assert(
      `${input.id}_status_only_after_dispatch_receipt`,
      !dispatchRequested ||
        (
          dispatchReceipt?.status === 200 &&
          (
            interactionMode === "parallel_conversation"
              ? postReceiptParallelConversationIsSafe
              : (
                  readString(dispatchProvisional?.kind) === "worker_dispatch_status" &&
                  dispatchProvisional?.answer_authority === false &&
                  dispatchProvisional?.assistant_answer === false &&
                  dispatchProvisional?.terminal_eligible === false
                )
          )
        ),
      `dispatch_requested=${String(dispatchRequested)} interaction_mode=${String(interactionMode)} status=${String(dispatchReceipt?.status)} kind=${String(dispatchProvisional?.kind)} authority=${String(dispatchProvisional?.answer_authority)}`,
    );
    const turnId = `ask:${RUN_ID}:${input.id}`;
    const ask = await requestJson("/api/agi/ask/turn", {
      method: "POST",
      body: {
        question: input.prompt,
        prompt: input.prompt,
        sessionId: PROBE_THREAD_ID,
        threadId: PROBE_THREAD_ID,
        turnId,
        turn_id: turnId,
        traceId: turnId,
        debug: true,
        agentRuntime: "codex",
        agent_runtime: "codex",
        language_model_profile: "fast",
        language_model_override: TEST_MODEL,
        route_metadata: routeMetadata,
        realtime_grounded_feedback_binding: binding,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const realtimeDebug = await requestJson(
      `/api/agi/realtime/session/${encodeURIComponent(realtimeSessionId)}/debug`,
    );
    const handoffDebug = readRecords(realtimeDebug.body.handoffs)
      .find((entry) => readString(entry.handoff_id) === handoffId) ?? null;
    if (CAPTURE_DEBUG) {
      const debugDir = path.dirname(OUTPUT_PATH);
      await fs.mkdir(debugDir, { recursive: true });
      await fs.writeFile(
        path.join(debugDir, `${RUN_ID}-${input.id}-debug.json`),
        JSON.stringify({
          schema: "helix.ask.realtime_doc_conversation_turn_debug.v1",
          ask_status: ask.status,
          ask_body: ask.body,
          handoff_debug: handoffDebug,
        }, null, 2),
        "utf8",
      );
    }
    const audit = readRecord(handoffDebug?.feedback_observer_audit);
    const relay = readRecord(handoffDebug?.grounded_relay);
    const groundedAnswer = readRecord(handoffDebug?.grounded_answer);
    const scientificClosureIdentities = readRecords(
      groundedAnswer?.scientific_evidence_closure_identities,
    );
    const answer = readString(
      ask.body.selected_final_answer ?? ask.body.content ?? ask.body.answer ?? ask.body.text,
    ) ?? "";
    const solverTrace = readRecord(ask.body.ask_turn_solver_trace);
    const terminalAuthority = readRecord(ask.body.terminal_answer_authority);
    const groundingAuthority = readRecord(ask.body.terminal_grounding_authority);
    const requiredCapabilities = readStrings(handoff.required_grounding_capability_ids);
    const gatewayCallResults = readRecords(
      ask.body.workstation_gateway_call_results,
    );
    const calledCapabilities = gatewayCallResults
      .map((result) => readString(result.capability_id ?? result.capabilityId))
      .filter((entry): entry is string => Boolean(entry));
    const executedCapabilities = gatewayCallResults
      .filter((result) => result.ok === true)
      .map((result) => readString(result.capability_id ?? result.capabilityId))
      .filter((entry): entry is string => Boolean(entry));
    const continuityRefs = readStrings(workerAdmission?.evidence_refs);

    turns.push({
      id: input.id,
      prompt: input.prompt,
      turn_id: turnId,
      handoff_id: handoffId,
      selected_route: readString(workerAdmission?.selected_route),
      required_grounding_capability_ids: requiredCapabilities,
      called_capability_ids: calledCapabilities,
      executed_capability_ids: executedCapabilities,
      selected_model: readString(ask.body.llm_model),
      terminal_artifact_kind: readString(ask.body.terminal_artifact_kind),
      final_answer_source: readString(ask.body.final_answer_source),
      final_answer: answer,
      solver_completed: solverTrace?.completed_solver_path === true,
      server_authoritative: terminalAuthority?.server_authoritative === true,
      feedback_recorded: Boolean(groundedAnswer),
      grounding_evidence_status: readString(audit?.grounding_evidence_status),
      grounding_proof_source: readString(audit?.grounding_proof_source),
      relay_status: readString(relay?.status),
      relay_reason: readString(relay?.status_reason),
      relay_failure_code: readString(relay?.failure_code),
      relay_terminal_speech_authority_status: readString(
        relay?.terminal_speech_authority_status,
      ),
      relay_grounding_status: readString(relay?.grounding_status),
      grounding_authority_status: readString(groundingAuthority?.status),
      grounding_authority_failure_codes: readStrings(groundingAuthority?.failure_codes),
      provisional_kind: readString(dispatchProvisional?.kind),
      provisional_utterance_code: readString(dispatchProvisional?.utterance_code),
      provisional_answer_authority: dispatchProvisional?.answer_authority === true,
      continuity_evidence_refs: continuityRefs,
      handoff_evidence_refs: readStrings(handoff.evidence_refs).concat(
        [
          readString(handoff.provider_event_ref),
          readString(handoff.transcript_observation_ref),
          readString(handoff.stage_play_event_ref),
          readString(handoff.context_pack_id),
        ].filter((entry): entry is string => Boolean(entry)),
      ),
      scientific_closure_identity_count:
        scientificClosureIdentities.length,
      scientific_closure_statuses: scientificClosureIdentities
        .map((identity) => readString(identity.status))
        .filter((entry): entry is string => Boolean(entry)),
      scientific_closure_canonical_within_enrollment:
        scientificClosureIdentities.map(
          (identity) => identity.canonical_within_enrollment === true,
        ),
    });

    assert(`${input.id}_http`, ask.status === 200, `HTTP ${ask.status}`);
    assert(`${input.id}_answer_present`, answer.length >= 60, `answer_chars=${answer.length}`);
    assert(
      `${input.id}_no_internal_tool_marker`,
      !/HELIX_(?:CAPABILITY_LANE|WORKSTATION_TOOL)_REQUEST_JSON:/i.test(answer),
      `answer=${answer.slice(0, 360)}`,
    );
    assert(
      `${input.id}_answer_content`,
      input.expectedText.every((pattern) => pattern.test(answer)),
      `answer=${answer.slice(0, 360)}`,
    );
    assert(
      `${input.id}_solver_terminal_authority`,
      input.allowTypedCapabilityFailure
        ? readString(ask.body.terminal_artifact_kind) === "typed_failure" &&
          readString(ask.body.final_answer_source) === "typed_failure" &&
          terminalAuthority?.server_authoritative === true
        : solverTrace?.completed_solver_path === true &&
          terminalAuthority?.server_authoritative === true,
      `typed_failure_allowed=${String(input.allowTypedCapabilityFailure === true)} solver=${String(solverTrace?.completed_solver_path)} terminal=${String(ask.body.terminal_artifact_kind)} source=${String(ask.body.final_answer_source)} authoritative=${String(terminalAuthority?.server_authoritative)}`,
    );
    assert(
      `${input.id}_grounded_feedback`,
      input.allowTypedCapabilityFailure
        ? !groundedAnswer &&
          audit?.feedback_status === "suppressed" &&
          readString(relay?.status) === "suppressed" &&
          readString(relay?.failure_code) === "typed_failure_not_spoken"
        : Boolean(groundedAnswer) &&
          audit?.feedback_status === "recorded" &&
          readString(relay?.failure_code) !==
            "required_grounding_evidence_missing",
      `feedback=${String(audit?.feedback_status)} grounding=${String(audit?.grounding_evidence_status)} relay=${String(relay?.status)} failure=${String(relay?.failure_code)} authority=${String(groundingAuthority?.status)} authority_failures=${readStrings(groundingAuthority?.failure_codes).join(",")}`,
    );
    if (input.requireDocsSearch) {
      const acceptedGroundingProofSources = new Set([
        "gateway_call_results",
        "canonical_terminal_boundary_compatibility",
      ]);
      assert(
        `${input.id}_docs_search_reentered`,
        requiredCapabilities.includes("docs.search") &&
          executedCapabilities.includes("docs.search") &&
          audit?.grounding_evidence_status === "validated" &&
          acceptedGroundingProofSources.has(
            readString(audit?.grounding_proof_source) ?? "",
          ),
        `required=${requiredCapabilities.join(",")} executed=${executedCapabilities.join(",")} proof=${String(audit?.grounding_proof_source)}`,
      );
    }
    for (const capabilityId of input.expectedCapabilities ?? []) {
      const capabilityWasObserved = input.allowTypedCapabilityFailure
        ? calledCapabilities.includes(capabilityId)
        : executedCapabilities.includes(capabilityId);
      assert(
        `${input.id}_${capabilityId}_required_and_${input.allowTypedCapabilityFailure ? "called" : "executed"}`,
        requiredCapabilities.includes(capabilityId) &&
          capabilityWasObserved,
        `required=${requiredCapabilities.join(",")} called=${calledCapabilities.join(",")} executed=${executedCapabilities.join(",")}`,
      );
    }
    if (input.requireGroundedVoiceRelay) {
      const relayStatus = readString(relay?.status);
      const admittedRelayStatuses = new Set([
        "result_ready",
        "relay_queued_busy",
        "response_requested",
        "provider_acknowledged",
        "speaking",
        "delivered",
      ]);
      assert(
        `${input.id}_grounded_voice_relay`,
        Boolean(groundedAnswer) &&
          audit?.feedback_status === "recorded" &&
          audit?.grounding_evidence_status === "validated" &&
          relay?.terminal_speech_authority_status === "validated" &&
          relay?.grounding_status === "validated" &&
          admittedRelayStatuses.has(relayStatus ?? ""),
        `feedback=${String(audit?.feedback_status)} evidence=${String(audit?.grounding_evidence_status)} relay=${String(relayStatus)} speech_authority=${String(relay?.terminal_speech_authority_status)} relay_grounding=${String(relay?.grounding_status)}`,
      );
    }
    const previous = turns.at(-2);
    if (previous) {
      const priorContinuityRefs = [
        previous.handoff_id,
        previous.turn_id,
        ...previous.handoff_evidence_refs,
      ];
      assert(
        `${input.id}_conversation_continuity`,
        priorContinuityRefs.some((ref) => continuityRefs.includes(ref)),
        `prior_handoff=${previous.handoff_id} prior_refs=${priorContinuityRefs.length} refs=${continuityRefs.length}`,
      );
    }
  };

  try {
    if (selectedScenario) {
      for (const turn of selectedScenario.turns) {
        await runTurn(turn);
      }
    } else if (TEST_SCENARIO === "magnetar-scholarly-voice") {
      await runTurn({
        id: "magnetar-citations",
        prompt: "Okay, can you cite research about magnetars?",
        expectedText: [/magnetar/i, /research|paper|citation|doi|arxiv|evidence/i],
        expectedCapabilities: ["scholarly-research.lookup_papers"],
      });
    } else if (TEST_SCENARIO === "nhm-current-status-voice") {
      await runTurn({
        id: "nhm-current-status-locate",
        prompt: "Find the NHM2 current status whitepaper.",
        expectedText: [/NHM2/i, /current status|white\s*paper|whitepaper|docs\/research/i],
        requireDocsSearch: true,
      });
      await runTurn({
        id: "nhm-current-status-main-idea",
        prompt: "Can you explain what this paper is about?",
        documentRef: "docs/research/nhm2-current-status-whitepaper.md",
        expectedText: [/NHM2|Needle Hull/i, /metric|warp|framework|diagnostic/i],
        requireDocsSearch: true,
      });
      await runTurn({
        id: "nhm-current-status-excitement",
        prompt: "Do you think that idea is exciting?",
        documentRef: "docs/research/nhm2-current-status-whitepaper.md",
        expectedText: [/exciting|interesting|worth studying/i, /research|speculative|warp/i],
        requireDocsSearch: false,
      });
    } else if (TEST_SCENARIO === "nhm-warp-profile-continuation") {
      await runTurn({
        id: "nhm-status-main-idea",
        prompt: "Look at the NHM2 Status Document and give me the main idea.",
        expectedText: [/NHM2|Needle Hull/i, /metric|warp|framework/i],
        requireDocsSearch: true,
      });
      await runTurn({
        id: "nhm-warp-profile-trip-comparison",
        prompt:
          "So can you tell me about the warp profile? Is it a relativistic profile? And how fast does that go, like in terms of saving time? I think we have some comparisons on days that it saves?",
        documentRef: "docs/research/nhm2-current-status-whitepaper.md",
        expectedText: [/relativ|spacetime|lapse|shift|metric/i, /day|time|clock|trip/i],
        requireDocsSearch: true,
      });
    } else if (TEST_SCENARIO === "nhm-casimir-continuation") {
      await runTurn({
        id: "nhm-status-main-idea",
        prompt: "Look at the NHM2 Status Document and give me the main idea.",
        expectedText: [/NHM2|Needle Hull/i, /metric|warp|framework/i],
        requireDocsSearch: true,
      });
      await runTurn({
        id: "casimir-connection",
        prompt: "What does this have to do with the Casimir effect?",
        expectedText: [/Casimir/i, /negative energy|vacuum|stress-energy|warp/i],
        requireDocsSearch: false,
      });
      await runTurn({
        id: "casimir-dp-relation",
        prompt: "And how does this relate to the Casimir DP quantum foam document?",
        expectedText: [/Casimir/i, /DP|Diosi|Penrose|quantum foam|bridge/i],
        requireDocsSearch: true,
      });
    } else if (TEST_SCENARIO === "nhm-status-main-idea") {
      await runTurn({
        id: "nhm-status-main-idea",
        prompt: "Look at the NHM2 Status Document and give me the main idea.",
        expectedText: [/NHM2|Needle Hull/i, /metric|warp|framework/i],
        requireDocsSearch: true,
      });
    } else if (TEST_SCENARIO === "nhm-doc") {
      await runTurn({
        id: "nhm-doc",
        prompt: "Okay, can you look at the NHM tube doc and explain what it's about?",
        expectedText: [/NHM2|Needle Hull/i, /metric|warp|cavity|framework/i],
        requireDocsSearch: true,
      });
    } else {
      await runTurn({
        id: "locate",
        prompt: 'Find the document called "Casimir Dp Quantum Foam Study", open the best match, and tell me what it is about.',
        expectedText: [/Casimir/i, /quantum|foam/i],
        requireDocsSearch: true,
      });
      const documentRef = "docs/research/casimir-dp-quantum-foam-study.md";
      await runTurn({
        id: "meaning",
        prompt: "What does it mean by saying some response functions are noncomputable until a model and falsifier are registered?",
        documentRef,
        expectedText: [/model|operator|response/i, /falsif|test|specified|registered/i],
        requireDocsSearch: true,
      });
      await runTurn({
        id: "quote",
        prompt: "Can you quote the exact passage where it says that and explain what the surrounding section is doing?",
        documentRef,
        expectedText: [
          /intentionally noncomputable|No parameter fit|not executable|deliberately unregistered|declared model.{0,120}(?:units|parameters|provenance|falsifiers)|registered (?:generator|model).{0,120}(?:parameter|falsifier)/is,
          /response|operator|model|observable.separation|hard boundary|hypothesis|null result|overclaim/i,
        ],
        requireDocsSearch: true,
      });
      await runTurn({
        id: "correction",
        prompt: "Is 'noncomputable' here claiming Turing incomputability, or only that the response operator is not specified yet? Correct the earlier explanation if needed.",
        documentRef,
        expectedText: [
          /not.{0,80}Turing|not claiming Turing/is,
          /not (?:yet )?(?:uniquely |fully )?(?:specified|registered|instantiated|computable|defined|identified)|undefined|under.?specified|missing (?:specification|dynamics)/i,
        ],
        requireDocsSearch: true,
      });
    }
  } finally {
    await requestJson(`/api/agi/realtime/session/${encodeURIComponent(realtimeSessionId)}/stop`, {
      method: "POST",
      body: {
        runtime_agent_mode: "live_voice_mini",
        runtime_agent_authority: "suggest_actions",
      },
    }).catch(() => null);
  }

  const report = {
    schema: "helix.ask.realtime_doc_conversation_probe.v1",
    run_id: RUN_ID,
    base_url: BASE_URL,
    requested_model: TEST_MODEL,
    scenario: TEST_SCENARIO,
    realtime_session_id: realtimeSessionId,
    turns,
    assertions,
    summary: {
      passed: assertions.filter((entry) => entry.ok).length,
      failed: assertions.filter((entry) => !entry.ok).length,
      ok: assertions.every((entry) => entry.ok),
    },
  };
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report.summary, output: OUTPUT_PATH })}\n`);
  if (!report.summary.ok) {
    for (const failure of assertions.filter((entry) => !entry.ok)) {
      process.stderr.write(`[realtime-doc-probe] ${failure.id}: ${failure.detail}\n`);
    }
    process.exitCode = 1;
  }
};

const writeDryRunReport = async (): Promise<void> => {
  const selectedScenario = resolveRealtimeDocProbeScenario(TEST_SCENARIO);
  if (!selectedScenario) {
    throw new Error(
      `dry_run_not_available_for_legacy_scenario:${TEST_SCENARIO}`,
    );
  }
  const report = {
    schema: "helix.ask.realtime_doc_conversation_probe_dry_run.v1",
    run_id: RUN_ID,
    base_url: BASE_URL,
    requested_model: TEST_MODEL,
    scenario: selectedScenario.id,
    dry_run: true,
    requires_developer: selectedScenario.requiresDeveloper,
    local_developer_sign_in_requested: LOCAL_DEVELOPER_SIGN_IN,
    focus_panel_id: selectedScenario.focusPanelId,
    turns: selectedScenario.turns.map((turn) => ({
      id: turn.id,
      prompt: turn.prompt,
      focus_panel_id: turn.focusPanelId ?? selectedScenario.focusPanelId,
      expected_capabilities: turn.expectedCapabilities ?? [],
      expected_text_patterns: turn.expectedText.map((pattern) => pattern.source),
      require_grounded_voice_relay: turn.requireGroundedVoiceRelay === true,
      allow_typed_capability_failure:
        turn.allowTypedCapabilityFailure === true,
    })),
    summary: {
      passed: selectedScenario.turns.length,
      failed: 0,
      ok: true,
    },
  };
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report.summary, output: OUTPUT_PATH })}\n`);
};

const main = async (): Promise<void> => {
  const selectedScenario = resolveRealtimeDocProbeScenario(TEST_SCENARIO);
  if (DRY_RUN) {
    await writeDryRunReport();
    return;
  }
  if (selectedScenario?.requiresDeveloper && !LOCAL_DEVELOPER_SIGN_IN) {
    throw new Error(
      "selected_realtime_probe_scenario_requires_explicit_local_developer_sign_in",
    );
  }

  try {
    if (LOCAL_DEVELOPER_SIGN_IN) {
      await establishLocalDeveloperSession();
    }
    await runLiveProbe();
  } finally {
    if (LOCAL_DEVELOPER_SIGN_IN) {
      await releaseLocalDeveloperSession();
    }
  }
};

const isEntrypoint =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  void main().catch((error) => {
    process.stderr.write(
      `[realtime-doc-probe] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
