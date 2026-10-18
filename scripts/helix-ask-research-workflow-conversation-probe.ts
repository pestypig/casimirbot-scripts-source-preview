import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type RecordLike = Record<string, unknown>;

type CapturedRefs = {
  scholarlyMemoryRefs: string[];
  researchDocumentRefs: string[];
  scholarlyPdfArtifactRefs: string[];
  renderedPageRefs: string[];
  imageLensRefs: string[];
  arxivIds: string[];
  dois: string[];
  pdfUrls: string[];
  canonicalUrls: string[];
};

type StageTelemetry = {
  selectedCapabilities: string[];
  admittedCapabilities: string[];
  executedCapabilities: string[];
  observationKinds: string[];
  observationRefs: string[];
  sourceTargets: string[];
  terminalKinds: string[];
  finalStatuses: string[];
  runtimeLifecycleAuthorities: string[];
  runtimeLifecycleIntegrityOk: boolean[];
  runtimeLifecycleObservationReentryRefs: string[];
  runtimeLifecyclePostObservationReasoningCompleted: boolean[];
  runtimeLifecycleTerminalOutcomes: string[];
  reentryAuthorities: string[];
  refs: CapturedRefs;
  answerRefs: CapturedRefs;
  finalAnswer: string;
};

type StageResult = {
  id: string;
  prompt: string;
  status: "pass" | "fail" | "blocked" | "skipped";
  failedChecks: string[];
  blockerReasons: string[];
  turnId: string | null;
  httpStatus: number | null;
  debugHttpStatus: number | null;
  elapsedMs: number;
  telemetry: StageTelemetry | null;
  artifactDir: string;
};

type ReplayContext = {
  topic: string;
  paperRef: string | null;
  researchDocumentRef: string | null;
  pdfArtifactRef: string | null;
  renderedPageRef: string | null;
  imageLensRef: string | null;
  arxivId: string | null;
  doi: string | null;
  pdfUrl: string | null;
  canonicalUrl: string | null;
  identityAuthority: "discovered" | "fixture" | null;
};

type HarnessRecovery = {
  afterStage: string;
  reason: string;
  seededArxivId: string;
};

type StageExpectation = {
  requestMode?: "read" | "act";
  requireAnyExecuted?: string[];
  requireAllExecuted?: string[];
  forbidExecuted?: string[];
  requireAnyText?: RegExp[];
  forbidText?: RegExp[];
  requireRef?: keyof CapturedRefs;
  requireAnyRef?: Array<keyof CapturedRefs>;
  allowTypedEquationBlocker?: boolean;
  requiresAuthenticatedProfile?: boolean;
  requireVerifiedRuntimeLifecycle?: boolean;
  requireObservationReentry?: boolean;
  requirePostObservationReasoning?: boolean;
};

type ReplayPreflight = {
  accountSessionHttpStatus: number;
  accountSessionAvailable: boolean;
  authenticatedProfile: boolean;
};

type PriorAssistantAnswer = {
  replyId: string;
  sourceRef: string;
  text: string;
};

const BASE_URL = (process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:1522").replace(/\/+$/, "");
const OUT_ROOT = process.env.HELIX_ASK_RESEARCH_WORKFLOW_OUT ??
  "artifacts/helix-ask-live-validation/research-workflow-conversation";
const TIMEOUT_MS = Math.max(10_000, Number(process.env.HELIX_ASK_RESEARCH_WORKFLOW_TIMEOUT_MS ?? 300_000));
const TOPIC = process.env.HELIX_ASK_RESEARCH_WORKFLOW_TOPIC?.trim() || "Magnetar";
const FALLBACK_ARXIV_ID =
  process.env.HELIX_ASK_RESEARCH_WORKFLOW_FALLBACK_ARXIV_ID?.trim() || "astro-ph/0503030v1";
const DRY_RUN = process.argv.includes("--dry-run") || process.env.HELIX_ASK_RESEARCH_WORKFLOW_DRY_RUN === "1";
const TEST_MODEL = process.env.HELIX_ASK_TEST_MODEL?.trim() || "gpt-4o-mini";
const TEST_MODEL_SELECTION = TEST_MODEL.toLowerCase() === "auto"
  ? { mode: "auto" as const }
  : { mode: "pinned" as const, model: TEST_MODEL };
const STAGE_FILTER = new Set(
  (
    process.argv.find((entry) => entry.startsWith("--stages="))?.slice("--stages=".length) ??
    process.env.HELIX_ASK_RESEARCH_WORKFLOW_STAGES ??
    ""
  )
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
);
const stageEnabled = (stageId: string): boolean => STAGE_FILTER.size === 0 || STAGE_FILTER.has(stageId);

const LOOKUP_CAPABILITY = "scholarly-research.lookup_papers";
const FETCH_CAPABILITY = "scholarly-research.fetch_full_text";
const LIBRARY_READ_CAPABILITY = "research-library.read_document";
const VISUAL_CAPABILITY = "visual_analysis.inspect_image_region";
const CALCULATOR_CAPABILITY = "scientific-calculator.solve_expression";
const THEORY_REFLECTION_CAPABILITY = "helix_ask.reflect_theory_context";
const TOOL_STAGE_LIFECYCLE_EXPECTATION: Pick<
  StageExpectation,
  "requireVerifiedRuntimeLifecycle" | "requireObservationReentry" | "requirePostObservationReasoning"
> = {
  requireVerifiedRuntimeLifecycle: true,
  requireObservationReentry: true,
  requirePostObservationReasoning: true,
};

const readRecord = (value: unknown): RecordLike | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordLike : null;

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const unique = (values: Array<string | null | undefined>): string[] =>
  Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));

const hashShort = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 12);

const safeSegment = (value: string): string => value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");

const walk = (value: unknown, visit: (record: RecordLike) => void, seen = new WeakSet<object>(), depth = 0): void => {
  if (depth > 18 || value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit, seen, depth + 1);
    return;
  }
  const record = value as RecordLike;
  visit(record);
  for (const entry of Object.values(record)) walk(entry, visit, seen, depth + 1);
};

const collectMatches = (text: string, pattern: RegExp): string[] => {
  const matches: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = (match[1] ?? match[0] ?? "").trim().replace(/[),.;]+$/, "");
    if (value) matches.push(value);
  }
  return unique(matches);
};

const collectUrlMatches = (text: string, pattern: RegExp): string[] =>
  unique(Array.from(text.matchAll(pattern), (match) => (match[1] ?? match[0] ?? "").trim()));

const collectRefs = (payload: unknown): CapturedRefs => {
  const serialized = JSON.stringify(payload ?? null);
  const arxivUrlIds = collectMatches(
    serialized,
    /arxiv\.org\/(?:abs|pdf)\/((?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?)(?:\.pdf)?/gi,
  );
  return {
    scholarlyMemoryRefs: collectMatches(
      serialized,
      /(ask:[^\s"'`]+:scholarly_followup_memory:[a-z0-9_-]+)/gi,
    ),
    researchDocumentRefs: collectMatches(serialized, /\b(research:[a-z0-9_-]+)\b/gi),
    scholarlyPdfArtifactRefs: collectMatches(
      serialized,
      /(artifact:\/\/scholarly-pdf\/[a-z0-9._/-]+\.pdf)/gi,
    ),
    renderedPageRefs: collectMatches(serialized, /\b(pdf-page-render:[a-z0-9_-]+)\b/gi),
    imageLensRefs: collectMatches(
      serialized,
      /\b((?:visual_frame:)?image_lens_region:[a-z0-9_-]+)\b/gi,
    ),
    arxivIds: unique([
      ...collectMatches(serialized, /\barxiv:(\d{4}\.\d{4,5}(?:v\d+)?|[a-z.-]+\/\d{7}(?:v\d+)?)\b/gi),
      ...arxivUrlIds,
    ]),
    dois: collectMatches(serialized, /\b(10\.\d{4,9}\/[a-z0-9._;()/:%+-]+)\b/gi),
    pdfUrls: collectUrlMatches(
      serialized,
      /(https?:\/\/[^\s"'\\<>\])]+\.pdf(?:\?[^\s"'\\<>\])]+)?)/gi,
    ),
    canonicalUrls: unique([
      ...collectUrlMatches(
        serialized,
        /(https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?(?:\.pdf)?)/gi,
      ),
      ...collectUrlMatches(
        serialized,
        /(https?:\/\/doi\.org\/[^\s"'\\<>\])]+)/gi,
      ),
    ]),
  };
};

const collectTelemetry = (response: unknown, debug: unknown): StageTelemetry => {
  const selectedCapabilities: string[] = [];
  const admittedCapabilities: string[] = [];
  const executedCapabilities: string[] = [];
  const observationKinds: string[] = [];
  const observationRefs: string[] = [];
  const sourceTargets: string[] = [];
  const terminalKinds: string[] = [];
  const finalStatuses: string[] = [];
  const runtimeLifecycleAuthorities: string[] = [];
  const runtimeLifecycleIntegrityOk: boolean[] = [];
  const runtimeLifecycleObservationReentryRefs: string[] = [];
  const runtimeLifecyclePostObservationReasoningCompleted: boolean[] = [];
  const runtimeLifecycleTerminalOutcomes: string[] = [];
  const reentryAuthorities: string[] = [];
  const responseRootRecord = readRecord(response);
  const debugRootRecord = readRecord(debug);
  const debugPayload = readRecord(debugRootRecord?.payload);
  const authoritativeLifecycle = [
    readRecord(responseRootRecord?.turn_lifecycle),
    readRecord(debugRootRecord?.turn_lifecycle),
    readRecord(debugPayload?.turn_lifecycle),
    readRecord(readRecord(responseRootRecord?.debug)?.turn_lifecycle),
    readRecord(readRecord(debugPayload?.debug)?.turn_lifecycle),
  ].find((record) => readString(record?.schema) === "helix.turn_lifecycle.v1") ?? null;
  const roots = [response, debug];

  if (authoritativeLifecycle) {
    const authority = readString(authoritativeLifecycle.authority);
    if (authority) runtimeLifecycleAuthorities.push(authority);
    const integrity = readRecord(authoritativeLifecycle.integrity);
    if (typeof integrity?.ok === "boolean") runtimeLifecycleIntegrityOk.push(integrity.ok);
    const reduction = readRecord(authoritativeLifecycle.reduction);
    if (Array.isArray(reduction?.observation_reentry_refs)) {
      runtimeLifecycleObservationReentryRefs.push(
        ...reduction.observation_reentry_refs.map(readString).filter((value): value is string => Boolean(value)),
      );
    }
    if (typeof reduction?.post_observation_reasoning_completed === "boolean") {
      runtimeLifecyclePostObservationReasoningCompleted.push(reduction.post_observation_reasoning_completed);
    }
    const terminalOutcome = readString(reduction?.terminal_outcome);
    if (terminalOutcome) runtimeLifecycleTerminalOutcomes.push(terminalOutcome);
    walk(authoritativeLifecycle, (record) => {
      const reentryAuthority = readString(record.reentry_authority) ?? readString(record.reentryAuthority);
      if (reentryAuthority) reentryAuthorities.push(reentryAuthority);
    });
  }

  for (const root of roots) {
    walk(root, (record) => {
      for (const key of ["selected_capability", "selectedCapability"]) {
        const value = readString(record[key]);
        if (value) selectedCapabilities.push(value);
      }
      for (const key of ["admitted_capability", "admittedCapability"]) {
        const value = readString(record[key]);
        if (value) admittedCapabilities.push(value);
      }
      for (const key of ["executed_capability", "executedCapability"]) {
        const value = readString(record[key]);
        if (value) executedCapabilities.push(value);
      }
      const capability = unique([
        readString(record.capability_id),
        readString(record.capabilityId),
        readString(record.capability_key),
        readString(record.capabilityKey),
        readString(record.source_capability_id),
        readString(record.sourceCapabilityId),
        readString(record.capability),
      ])[0];
      const schema = readString(record.schema) ?? "";
      const reentryAuthority = readString(record.reentry_authority) ?? readString(record.reentryAuthority);
      if (reentryAuthority && !authoritativeLifecycle) reentryAuthorities.push(reentryAuthority);
      if (schema === "helix.turn_lifecycle.v1" && !authoritativeLifecycle) {
        const authority = readString(record.authority);
        if (authority) runtimeLifecycleAuthorities.push(authority);
        const integrity = readRecord(record.integrity);
        if (typeof integrity?.ok === "boolean") runtimeLifecycleIntegrityOk.push(integrity.ok);
        const reduction = readRecord(record.reduction);
        if (Array.isArray(reduction?.observation_reentry_refs)) {
          runtimeLifecycleObservationReentryRefs.push(
            ...reduction.observation_reentry_refs.map(readString).filter((value): value is string => Boolean(value)),
          );
        }
        if (typeof reduction?.post_observation_reasoning_completed === "boolean") {
          runtimeLifecyclePostObservationReasoningCompleted.push(reduction.post_observation_reasoning_completed);
        }
        const terminalOutcome = readString(reduction?.terminal_outcome);
        if (terminalOutcome) runtimeLifecycleTerminalOutcomes.push(terminalOutcome);
      }
      const laneExecuted = record.lane_executed === true || record.laneExecuted === true || record.executed === true;
      const hasObservation = Boolean(
        readString(record.observation_ref) ??
        readString(record.observationRef) ??
        readString(record.observation_kind) ??
        readString(record.observationKind),
      );
      const executionStatus = unique([
        readString(record.execution_status),
        readString(record.executionStatus),
        readString(record.status),
      ]).join(" ");
      const resultLike = /(?:observation|receipt|gateway_call_result|capability_result)/i.test(schema);
      if (capability && (laneExecuted || hasObservation || resultLike || /\b(?:executed|completed|succeeded)\b/i.test(executionStatus))) {
        executedCapabilities.push(capability);
      }
      for (const key of ["observation_kind", "observationKind", "artifact_kind", "artifactKind"]) {
        const value = readString(record[key]);
        if (value) observationKinds.push(value);
      }
      for (const key of ["observation_ref", "observationRef", "evidence_ref", "evidenceRef", "receipt_ref", "receiptRef"]) {
        const value = readString(record[key]);
        if (value) observationRefs.push(value);
      }
      for (const key of ["source_target", "sourceTarget", "selected_source_target", "selectedSourceTarget"]) {
        const value = readString(record[key]);
        if (value) sourceTargets.push(value);
      }
      for (const key of ["terminal_artifact_kind", "terminalArtifactKind", "visible_terminal_kind", "selected_terminal_kind"]) {
        const value = readString(record[key]);
        if (value) terminalKinds.push(value);
      }
      for (const key of ["final_status", "finalStatus", "status"]) {
        const value = readString(record[key]);
        if (value && /^(?:final_answer|typed_failure|route_execution_failure|completed|failed)$/i.test(value)) {
          finalStatuses.push(value);
        }
      }
    });
  }

  const responseRecord = readRecord(response);
  const finalAnswer = unique([
    readString(responseRecord?.selected_final_answer),
    readString(responseRecord?.assistant_answer),
    readString(responseRecord?.text),
    readString(responseRecord?.message),
  ])[0] ?? "";

  const refs = collectRefs({ response, debug });
  const answerRefs = collectRefs(finalAnswer);
  return {
    selectedCapabilities: unique(selectedCapabilities),
    admittedCapabilities: unique(admittedCapabilities),
    executedCapabilities: unique(executedCapabilities),
    observationKinds: unique(observationKinds),
    observationRefs: unique(observationRefs),
    sourceTargets: unique(sourceTargets),
    terminalKinds: unique(terminalKinds),
    finalStatuses: unique(finalStatuses),
    runtimeLifecycleAuthorities: unique(runtimeLifecycleAuthorities),
    runtimeLifecycleIntegrityOk: Array.from(new Set(runtimeLifecycleIntegrityOk)),
    runtimeLifecycleObservationReentryRefs: unique(runtimeLifecycleObservationReentryRefs),
    runtimeLifecyclePostObservationReasoningCompleted: Array.from(
      new Set(runtimeLifecyclePostObservationReasoningCompleted),
    ),
    runtimeLifecycleTerminalOutcomes: unique(runtimeLifecycleTerminalOutcomes),
    reentryAuthorities: unique(reentryAuthorities),
    refs: Object.fromEntries(
      Object.keys(refs).map((key) => [
        key,
        unique([
          ...answerRefs[key as keyof CapturedRefs],
          ...refs[key as keyof CapturedRefs],
        ]),
      ]),
    ) as CapturedRefs,
    answerRefs,
    finalAnswer,
  };
};

const fetchJson = async (url: string, init?: RequestInit): Promise<{
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
}> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json, text };
  } finally {
    clearTimeout(timeout);
  }
};

const updateContext = (
  context: ReplayContext,
  refs: CapturedRefs,
  answerRefs: CapturedRefs,
): void => {
  context.paperRef ??= refs.scholarlyMemoryRefs[0] ?? null;
  context.researchDocumentRef ??= refs.researchDocumentRefs[0] ?? null;
  context.pdfArtifactRef ??= refs.scholarlyPdfArtifactRefs[0] ?? null;
  context.renderedPageRef ??= refs.renderedPageRefs[0] ?? null;
  context.imageLensRef ??= refs.imageLensRefs[0] ?? null;
  context.arxivId ??= answerRefs.arxivIds[0] ?? refs.arxivIds[0] ?? null;
  context.doi ??= answerRefs.dois[0] ?? null;
  context.pdfUrl ??= answerRefs.pdfUrls[0] ?? refs.pdfUrls[0] ?? null;
  context.canonicalUrl ??= answerRefs.canonicalUrls[0] ?? refs.canonicalUrls[0] ?? null;
  if (!context.identityAuthority && (context.arxivId || context.doi || context.pdfUrl || context.canonicalUrl)) {
    context.identityAuthority = "discovered";
  }
};

const seedFixtureIdentityIfMissing = (
  context: ReplayContext,
  recoveries: HarnessRecovery[],
  afterStage: string,
): void => {
  if (context.arxivId || context.doi || context.pdfUrl || context.canonicalUrl) return;
  context.arxivId = FALLBACK_ARXIV_ID;
  context.pdfUrl = `https://arxiv.org/pdf/${FALLBACK_ARXIV_ID}.pdf`;
  context.canonicalUrl = `https://arxiv.org/abs/${FALLBACK_ARXIV_ID}`;
  context.identityAuthority = "fixture";
  recoveries.push({
    afterStage,
    reason: "upstream_discovery_produced_no_stable_paper_identity",
    seededArxivId: FALLBACK_ARXIV_ID,
  });
};

const assess = (input: {
  response: unknown;
  debug: unknown;
  responseOk: boolean;
  debugOk: boolean;
  turnId: string | null;
  telemetry: StageTelemetry;
  expectation: StageExpectation;
  authenticatedProfile: boolean;
}): { status: "pass" | "fail" | "blocked"; failedChecks: string[]; blockerReasons: string[] } => {
  const failedChecks: string[] = [];
  const serialized = JSON.stringify({ response: input.response, debug: input.debug });
  const combinedText = `${input.telemetry.finalAnswer}\n${serialized}`;
  const responseRecord = readRecord(input.response);
  const debugPayload = readRecord(readRecord(input.debug)?.payload);
  const activeControlText = JSON.stringify({
    turn_lifecycle:
      responseRecord?.turn_lifecycle ??
      debugPayload?.turn_lifecycle ??
      readRecord(responseRecord?.debug)?.turn_lifecycle ??
      null,
    agent_continuation_state:
      responseRecord?.agent_continuation_state ??
      debugPayload?.agent_continuation_state ??
      null,
    terminal_error_code: responseRecord?.terminal_error_code ?? debugPayload?.terminal_error_code ?? null,
  });
  const finalStatus = unique([
    readString(responseRecord?.final_status),
    readString(responseRecord?.finalStatus),
    readString(responseRecord?.status),
  ])[0] ?? "unknown";
  const typedEquationBlocker = /no_(?:ocr|text)_or_latex_candidate|typed blocker|no exact equation/i.test(combinedText);
  if (!input.responseOk) failedChecks.push("ask_http_ok");
  if (
    (responseRecord?.ok === false || /^(?:final_failure|typed_failure|route_execution_failure|failed)$/i.test(finalStatus)) &&
    !(input.expectation.allowTypedEquationBlocker && typedEquationBlocker)
  ) {
    failedChecks.push(`terminal_status:${finalStatus}`);
  }
  if (!input.turnId) failedChecks.push("turn_id_present");
  if (!input.debugOk) failedChecks.push("debug_export_available");
  if (/memory_hard_pressure/i.test(combinedText)) failedChecks.push("no_memory_hard_pressure");
  if (/solver_continuation_pending|provider_followup_reasoning_missing|observation_reentry_missing/i.test(activeControlText)) {
    failedChecks.push("no_continuation_soft_lock");
  }
  if (/Reading prompt from stdin[\s\S]{0,400}OpenAI Codex v/i.test(input.telemetry.finalAnswer)) {
    failedChecks.push("no_provider_preamble_leak");
  }
  if (input.telemetry.runtimeLifecycleIntegrityOk.includes(false)) {
    failedChecks.push("runtime_lifecycle_integrity");
  }
  if (
    input.expectation.requireVerifiedRuntimeLifecycle &&
    (
      !input.telemetry.runtimeLifecycleAuthorities.includes("runtime_event_log") ||
      !input.telemetry.runtimeLifecycleIntegrityOk.includes(true)
    )
  ) {
    failedChecks.push("verified_runtime_lifecycle");
  }
  if (
    input.expectation.requireObservationReentry &&
    input.telemetry.runtimeLifecycleObservationReentryRefs.length === 0
  ) {
    failedChecks.push("runtime_observation_reentry");
  }
  if (
    input.expectation.requireObservationReentry &&
    input.telemetry.reentryAuthorities.some((authority) => authority !== "runtime_event_log")
  ) {
    failedChecks.push("runtime_reentry_authority");
  }
  if (
    input.expectation.requirePostObservationReasoning &&
    !input.telemetry.runtimeLifecyclePostObservationReasoningCompleted.includes(true)
  ) {
    failedChecks.push("post_observation_reasoning_completed");
  }
  if (input.expectation.requireAllExecuted) {
    for (const capability of input.expectation.requireAllExecuted) {
      if (!input.telemetry.executedCapabilities.includes(capability)) {
        failedChecks.push(`executed:${capability}`);
      }
    }
  }
  if (
    input.expectation.requireAnyExecuted?.length &&
    !input.expectation.requireAnyExecuted.some((capability) => input.telemetry.executedCapabilities.includes(capability))
  ) {
    failedChecks.push(`executed_any:${input.expectation.requireAnyExecuted.join("|")}`);
  }
  for (const capability of input.expectation.forbidExecuted ?? []) {
    if (input.telemetry.executedCapabilities.includes(capability)) failedChecks.push(`forbidden_execution:${capability}`);
  }
  if (
    input.expectation.requireAnyText?.length &&
    !input.expectation.requireAnyText.some((pattern) => pattern.test(combinedText))
  ) {
    failedChecks.push(`required_evidence_text:${input.expectation.requireAnyText.map(String).join("|")}`);
  }
  for (const pattern of input.expectation.forbidText ?? []) {
    if (pattern.test(input.telemetry.finalAnswer)) failedChecks.push(`forbidden_answer:${String(pattern)}`);
  }
  if (input.expectation.requireRef && input.telemetry.refs[input.expectation.requireRef].length === 0) {
    failedChecks.push(`required_ref:${input.expectation.requireRef}`);
  }
  if (
    input.expectation.requireAnyRef?.length &&
    !input.expectation.requireAnyRef.some((refKind) => input.telemetry.refs[refKind].length > 0)
  ) {
    failedChecks.push(`required_any_ref:${input.expectation.requireAnyRef.join("|")}`);
  }

  if (input.expectation.allowTypedEquationBlocker) {
    if (typedEquationBlocker) {
      const capabilityIndex = failedChecks.findIndex((entry) => entry === `executed:${VISUAL_CAPABILITY}`);
      if (capabilityIndex >= 0 && input.telemetry.observationKinds.length > 0) failedChecks.splice(capabilityIndex, 1);
    }
  }

  const blockerReasons = unique([
    ...collectMatches(combinedText, /\b(memory_hard_pressure)\b/gi),
    ...collectMatches(combinedText, /\b(?:http_)?(429|rate[_ -]?limited)\b/gi),
    ...collectMatches(combinedText, /\b((?:semantic_scholar|core|unpaywall)[a-z0-9_.:-]*(?:requires|unavailable|429)[a-z0-9_.:-]*)\b/gi),
    ...collectMatches(combinedText, /\b((?:provider|transport|network)_[a-z0-9_.:-]*(?:unavailable|timeout|failed))\b/gi),
    ...collectMatches(combinedText, /\b(profile_session_required)\b/gi),
  ]);
  const authenticatedProfileBlock = Boolean(
    input.expectation.requiresAuthenticatedProfile &&
    !input.authenticatedProfile &&
    blockerReasons.includes("profile_session_required"),
  );
  return {
    status: authenticatedProfileBlock || (failedChecks.length > 0 && blockerReasons.length > 0)
      ? "blocked"
      : failedChecks.length === 0
        ? "pass"
        : "fail",
    failedChecks,
    blockerReasons,
  };
};

const paperLookupPrompt = (topic: string): string => {
  return `Find me one strong PDF-accessible primary research paper about ${topic} that we can use for a multi-step analysis. ` +
    "Show me a short candidate list, recommend the best one, and then get the recommended paper's full text if it is available. " +
    "Tell me its DOI or arXiv ID and whether the text is actually usable.";
};

const renderPagePrompt = (context: ReplayContext): string =>
  `Use the ${context.topic} paper you just fetched. Open page 2 in Image Lens, but do not analyze it yet. ` +
  "Tell me whether that page is ready and still tied to the same paper.";

const equationCandidatePrompt = (context: ReplayContext): string =>
  `Inspect the page that is already open from the ${context.topic} paper. ` +
  "List any equations or mathematical candidates you can actually read and where they appear on the page so I can choose one. " +
  "If the page has none, say so and recommend the smallest useful next step instead of switching papers.";

const exactExtractPrompt = (context: ReplayContext): string => {
  return `Use the ${context.topic} paper you just selected. Put its full text into my Research Library and tell me whether the saved document is usable.`;
};

const renderSummary = (input: {
  runId: string;
  sessionId: string;
  context: ReplayContext;
  stages: StageResult[];
  preflight: ReplayPreflight;
  recoveries: HarnessRecovery[];
}): string => {
  const lines = [
    "# Helix Ask Research Workflow Conversation Replay",
    "",
    `- run_id: ${input.runId}`,
    `- session_id: ${input.sessionId}`,
    `- base_url: ${BASE_URL}`,
    `- topic: ${input.context.topic}`,
    `- authenticated_profile: ${input.preflight.authenticatedProfile}`,
    `- identity_authority: ${input.context.identityAuthority ?? "missing"}`,
    `- harness_recoveries: ${input.recoveries.length}`,
    "",
    "| Stage | Status | Failed checks | Executed capabilities | Lifecycle authority | Re-entry refs | Post-observation reasoning | Terminal |",
    "|---|---|---|---|---|---:|---|---|",
  ];
  for (const stage of input.stages) {
    lines.push(
      `| ${stage.id} | ${stage.status} | ${stage.failedChecks.join("<br>") || "-"} | ` +
      `${stage.telemetry?.executedCapabilities.join("<br>") || "-"} | ` +
      `${stage.telemetry?.runtimeLifecycleAuthorities.join("<br>") || "-"} | ` +
      `${stage.telemetry?.runtimeLifecycleObservationReentryRefs.length ?? 0} | ` +
      `${stage.telemetry?.runtimeLifecyclePostObservationReasoningCompleted.join("<br>") || "-"} | ` +
      `${stage.telemetry?.runtimeLifecycleTerminalOutcomes.join("<br>") || stage.telemetry?.terminalKinds.join("<br>") || "-"} |`,
    );
  }
  lines.push(
    "",
    "## Final retained identity",
    "",
    `- paper_ref: ${input.context.paperRef ?? "missing"}`,
    `- research_document_ref: ${input.context.researchDocumentRef ?? "missing"}`,
    `- pdf_artifact_ref: ${input.context.pdfArtifactRef ?? "missing"}`,
    `- rendered_page_ref: ${input.context.renderedPageRef ?? "missing"}`,
    `- arxiv_id: ${input.context.arxivId ?? "missing"}`,
    `- doi: ${input.context.doi ?? "missing"}`,
  );
  if (input.recoveries.length > 0) {
    lines.push(
      "",
      "## Harness recoveries",
      "",
      ...input.recoveries.map((recovery) =>
        `- after ${recovery.afterStage}: ${recovery.reason}; seeded arXiv ${recovery.seededArxivId}`),
    );
  }
  return `${lines.join("\n")}\n`;
};

async function main(): Promise<void> {
  const runId = `research-workflow-${new Date().toISOString().replace(/[:.]/g, "-")}-${hashShort(TOPIC)}`;
  const runDir = path.resolve(OUT_ROOT, runId);
  const sessionId = `helix-ask:research-workflow:${runId}`;
  const context: ReplayContext = {
    topic: TOPIC,
    paperRef: null,
    researchDocumentRef: null,
    pdfArtifactRef: null,
    renderedPageRef: null,
    imageLensRef: null,
    arxivId: null,
    doi: null,
    pdfUrl: null,
    canonicalUrl: null,
    identityAuthority: null,
  };
  const stages: StageResult[] = [];
  const recoveries: HarnessRecovery[] = [];
  const priorAssistantAnswers: PriorAssistantAnswer[] = [];
  await fs.mkdir(runDir, { recursive: true });
  const accountSession = DRY_RUN ? null : await fetchJson(`${BASE_URL}/api/account/session`);
  const accountSessionRecord = readRecord(accountSession?.json);
  const preflight: ReplayPreflight = accountSession ? {
    accountSessionHttpStatus: accountSession.status,
    accountSessionAvailable: accountSession.ok,
    authenticatedProfile: Boolean(readRecord(accountSessionRecord?.session)),
  } : {
    accountSessionHttpStatus: 0,
    accountSessionAvailable: false,
    authenticatedProfile: false,
  };
  await fs.writeFile(path.join(runDir, "preflight.json"), `${JSON.stringify(preflight, null, 2)}\n`);

  const runStage = async (
    id: string,
    prompt: string,
    expectation: StageExpectation,
  ): Promise<StageResult> => {
    const artifactDir = path.join(runDir, `${String(stages.length + 1).padStart(2, "0")}-${safeSegment(id)}`);
    await fs.mkdir(artifactDir, { recursive: true });
    const request = {
      turn_id: `${sessionId}:${id}`,
      sessionId,
      session_id: sessionId,
      thread_id: sessionId,
      agent_runtime: "codex",
      agentRuntime: "codex",
      debug: true,
      mode: expectation.requestMode ?? "read",
      language_model_selection: TEST_MODEL_SELECTION,
      languageModelSelection: TEST_MODEL_SELECTION,
      question: prompt,
      prompt,
      ...(priorAssistantAnswers.length > 0 ? {
        workspace_context_snapshot: {
          chat_referent_context: {
            schema: "helix.ask.chat_referent_context.v1",
            previous_assistant_final_answer: {
              role: "assistant",
              reply_id: priorAssistantAnswers.at(-1)?.replyId,
              source_ref: priorAssistantAnswers.at(-1)?.sourceRef,
              text: priorAssistantAnswers.at(-1)?.text,
            },
            recent_assistant_final_answers: priorAssistantAnswers.slice(-4).map((answer) => ({
              role: "assistant",
              reply_id: answer.replyId,
              source_ref: answer.sourceRef,
              text: answer.text,
            })),
          },
        },
      } : {}),
    };
    await fs.writeFile(path.join(artifactDir, "request.json"), `${JSON.stringify(request, null, 2)}\n`);
    console.log(`[research-workflow] start ${id}`);
    const startedAt = Date.now();
    let ask: Awaited<ReturnType<typeof fetchJson>> | null = null;
    let debug: Awaited<ReturnType<typeof fetchJson>> | null = null;
    let turnId: string | null = null;
    try {
      ask = await fetchJson(`${BASE_URL}/api/agi/ask/turn`, {
        method: "POST",
        body: JSON.stringify(request),
      });
      await fs.writeFile(path.join(artifactDir, "response.json"), `${JSON.stringify(ask.json, null, 2)}\n`);
      const askRecord = readRecord(ask.json);
      turnId = readString(askRecord?.turn_id) ?? readString(askRecord?.id);
      if (turnId) {
        debug = await fetchJson(`${BASE_URL}/api/agi/ask/turn/${encodeURIComponent(turnId)}/debug-export`);
        await fs.writeFile(path.join(artifactDir, "debug-export.json"), `${JSON.stringify(debug.json, null, 2)}\n`);
      }
      const telemetry = collectTelemetry(ask.json, debug?.json ?? null);
      updateContext(context, telemetry.refs, telemetry.answerRefs);
      if (telemetry.finalAnswer) {
        const replyId = `reply:${id}:${hashShort(telemetry.finalAnswer)}`;
        priorAssistantAnswers.push({
          replyId,
          sourceRef: `chat.final_answer.previous:${replyId}`,
          text: telemetry.finalAnswer,
        });
      }
      const assessment = assess({
        response: ask.json,
        debug: debug?.json ?? null,
        responseOk: ask.ok,
        debugOk: debug?.ok ?? false,
        turnId,
        telemetry,
        expectation,
        authenticatedProfile: preflight.authenticatedProfile,
      });
      const result: StageResult = {
        id,
        prompt,
        status: assessment.status,
        failedChecks: assessment.failedChecks,
        blockerReasons: assessment.blockerReasons,
        turnId,
        httpStatus: ask.status,
        debugHttpStatus: debug?.status ?? null,
        elapsedMs: Date.now() - startedAt,
        telemetry,
        artifactDir,
      };
      await fs.writeFile(path.join(artifactDir, "assessment.json"), `${JSON.stringify(result, null, 2)}\n`);
      stages.push(result);
      console.log(
        `[research-workflow] ${id} ${result.status} ${result.elapsedMs}ms ` +
        `executed=${telemetry.executedCapabilities.join(",") || "none"} terminal=${telemetry.terminalKinds.join(",") || "none"}`,
      );
      return result;
    } catch (error) {
      const result: StageResult = {
        id,
        prompt,
        status: /abort|timeout|fetch|socket|ECONN/i.test(error instanceof Error ? error.message : String(error))
          ? "blocked"
          : "fail",
        failedChecks: [error instanceof Error ? error.message : String(error)],
        blockerReasons: [],
        turnId,
        httpStatus: ask?.status ?? null,
        debugHttpStatus: debug?.status ?? null,
        elapsedMs: Date.now() - startedAt,
        telemetry: null,
        artifactDir,
      };
      await fs.mkdir(artifactDir, { recursive: true });
      await fs.writeFile(path.join(artifactDir, "assessment.json"), `${JSON.stringify(result, null, 2)}\n`);
      stages.push(result);
      console.log(`[research-workflow] ${id} ${result.status}: ${result.failedChecks.join(", ")}`);
      return result;
    }
  };

  if (DRY_RUN) {
    const dryRun = {
      schema: "helix.ask.research_workflow_conversation_replay.v1",
      status: "dry_run",
      run_id: runId,
      session_id: sessionId,
      base_url: BASE_URL,
      topic: TOPIC,
      preflight,
      fallback_arxiv_id: FALLBACK_ARXIV_ID,
      model_selection: TEST_MODEL_SELECTION,
      stages: [
        "paper_lookup",
        "extract_exact_pdf_into_research_docs",
        "extract_by_identity_retry",
        "mount_pdf_page_2",
        "inspect_page_2_equation_candidate",
        "natural_equation_followup",
        "natural_library_correction",
        "explicit_library_ref_equation_search",
        "bounded_adjacent_page_search",
        "calculator_sanity_check",
        "theory_badge_graph_reflection",
      ].filter(stageEnabled),
    };
    await fs.writeFile(path.join(runDir, "summary.json"), `${JSON.stringify(dryRun, null, 2)}\n`);
    console.log(JSON.stringify(dryRun, null, 2));
    return;
  }

  if (stageEnabled("paper_lookup")) {
    await runStage("paper_lookup", paperLookupPrompt(context.topic), {
      ...TOOL_STAGE_LIFECYCLE_EXPECTATION,
      requireAllExecuted: [LOOKUP_CAPABILITY, FETCH_CAPABILITY],
      requireAnyText: [/\b(?:arxiv|doi|pdf|full[- ]text)\b/i],
      requireAnyRef: ["scholarlyPdfArtifactRefs", "pdfUrls"],
      forbidText: [/memory_hard_pressure/i],
    });
  }
  seedFixtureIdentityIfMissing(context, recoveries, "paper_lookup");

  if (stageEnabled("extract_exact_pdf_into_research_docs")) {
    await runStage("extract_exact_pdf_into_research_docs", exactExtractPrompt(context), {
      ...TOOL_STAGE_LIFECYCLE_EXPECTATION,
      requestMode: "act",
      requireAnyExecuted: [FETCH_CAPABILITY, LIBRARY_READ_CAPABILITY],
      forbidExecuted: [LOOKUP_CAPABILITY],
      requireRef: "researchDocumentRefs",
      requiresAuthenticatedProfile: true,
      requireAnyText: [context.arxivId ? new RegExp(context.arxivId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : /research:/i],
      forbidText: [/misidentified/i, /unrelated paper/i],
    });
  }

  if (stageEnabled("extract_by_identity_retry") && !context.researchDocumentRef) {
    const retryIdentity = context.arxivId ?? context.doi ?? context.pdfUrl ?? context.canonicalUrl ?? "the selected Magnetar paper";
    await runStage("extract_by_identity_retry", `extract that magnetar paper, ${retryIdentity}`, {
      ...TOOL_STAGE_LIFECYCLE_EXPECTATION,
      requireAnyExecuted: [FETCH_CAPABILITY, LIBRARY_READ_CAPABILITY],
      forbidExecuted: [LOOKUP_CAPABILITY],
      requireAnyRef: ["researchDocumentRefs", "scholarlyPdfArtifactRefs"],
      forbidText: [/Reading prompt from stdin/i],
    });
  } else if (stageEnabled("extract_by_identity_retry")) {
    const artifactDir = path.join(runDir, `${String(stages.length + 1).padStart(2, "0")}-extract-by-identity-retry`);
    const skipped: StageResult = {
      id: "extract_by_identity_retry",
      prompt: "",
      status: "skipped",
      failedChecks: [],
      blockerReasons: ["exact_url_extraction_already_produced_research_document_ref"],
      turnId: null,
      httpStatus: null,
      debugHttpStatus: null,
      elapsedMs: 0,
      telemetry: null,
      artifactDir,
    };
    stages.push(skipped);
  }

  if (stageEnabled("mount_pdf_page_2")) {
    await runStage("mount_pdf_page_2", renderPagePrompt(context), {
      ...TOOL_STAGE_LIFECYCLE_EXPECTATION,
      requireAllExecuted: [VISUAL_CAPABILITY],
      forbidExecuted: [LOOKUP_CAPABILITY],
      requireRef: "renderedPageRefs",
      requireAnyText: [/page\s*2/i, /typed page[- ]mount evidence/i],
      forbidText: [/\b(?:ocr|latex candidate)\b/i],
    });
  }

  if (stageEnabled("inspect_page_2_equation_candidate")) {
    await runStage("inspect_page_2_equation_candidate", equationCandidatePrompt(context), {
      ...TOOL_STAGE_LIFECYCLE_EXPECTATION,
      requireAllExecuted: [VISUAL_CAPABILITY],
      forbidExecuted: [LOOKUP_CAPABILITY],
      requireAnyText: [/equation/i, /latex/i, /no_(?:ocr|text)_or_latex_candidate/i],
      allowTypedEquationBlocker: true,
    });
  }

  if (stageEnabled("natural_equation_followup")) {
    await runStage("natural_equation_followup", "Ok can you find an equation we can use in this doc?", {
    ...TOOL_STAGE_LIFECYCLE_EXPECTATION,
    requireAnyExecuted: [LIBRARY_READ_CAPABILITY, VISUAL_CAPABILITY],
    forbidExecuted: [LOOKUP_CAPABILITY],
    requireAnyText: [/equation/i, /typed blocker/i, /no exact equation/i],
    forbidText: [/no accessible PDF\/full text/i, /wasn['’]t attached to this turn/i],
    });
  }

  if (stageEnabled("natural_library_correction")) {
    await runStage(
    "natural_library_correction",
    "But it is already in my research library. Use the saved document from this conversation and look for equation candidates without selecting another paper.",
    {
      ...TOOL_STAGE_LIFECYCLE_EXPECTATION,
      requireAnyExecuted: [LIBRARY_READ_CAPABILITY, VISUAL_CAPABILITY],
      forbidExecuted: [LOOKUP_CAPABILITY, FETCH_CAPABILITY],
      requiresAuthenticatedProfile: true,
      requireAnyText: [/equation/i, /research:/i, /page/i],
      forbidText: [/wasn['’]t attached to this turn/i, /ask me to search\/retrieve it/i],
    },
    );
  }

  if (stageEnabled("explicit_library_ref_equation_search") && context.researchDocumentRef) {
    await runStage(
      "explicit_library_ref_equation_search",
      `look for equation candidates in ${context.researchDocumentRef}`,
      {
        ...TOOL_STAGE_LIFECYCLE_EXPECTATION,
        requireAnyExecuted: [LIBRARY_READ_CAPABILITY, VISUAL_CAPABILITY],
        forbidExecuted: [LOOKUP_CAPABILITY, FETCH_CAPABILITY],
        requiresAuthenticatedProfile: true,
        requireAnyText: [/equation/i, /page/i, /research:/i],
        forbidText: [/no accessible PDF\/full text/i],
      },
    );
  }

  if (stageEnabled("bounded_adjacent_page_search")) {
    await runStage(
      "bounded_adjacent_page_search",
      "Can you look on other pages of that same saved paper for equation candidates? Inspect at most two adjacent pages and stop after the first usable candidate.",
      {
        ...TOOL_STAGE_LIFECYCLE_EXPECTATION,
        requireAnyExecuted: [LIBRARY_READ_CAPABILITY, VISUAL_CAPABILITY],
        forbidExecuted: [LOOKUP_CAPABILITY, FETCH_CAPABILITY],
        requiresAuthenticatedProfile: true,
        requireAnyText: [/equation/i, /page/i, /candidate/i],
        forbidText: [/which pages should I inspect/i, /what kind of equation candidates/i],
        allowTypedEquationBlocker: true,
      },
    );
  }

  if (stageEnabled("calculator_sanity_check")) {
    await runStage(
      "calculator_sanity_check",
      "Can you use the calculator to check 8 times 9, then explain how that simple check differs from evaluating the paper's equation candidate?",
      {
        ...TOOL_STAGE_LIFECYCLE_EXPECTATION,
        requireAllExecuted: [CALCULATOR_CAPABILITY],
        requireAnyText: [/(?=[\s\S]*\b72\b)(?=[\s\S]*(?:paper|equation))(?=[\s\S]*(?:arithmetic|calculator|simple check))/i],
        forbidText: [/calculator unavailable/i, /cannot access the calculator/i],
      },
    );
  }

  if (stageEnabled("theory_badge_graph_reflection")) {
    await runStage(
      "theory_badge_graph_reflection",
      "Now reflect what we learned from this paper, the equation search, and the calculator check into the Theory Badge Graph. Separate what the evidence supports from what remains unresolved.",
      {
        ...TOOL_STAGE_LIFECYCLE_EXPECTATION,
        requireAllExecuted: [THEORY_REFLECTION_CAPABILITY],
        requireAnyText: [/(?=[\s\S]*(?:graph|badge))(?=[\s\S]*(?:support|evidence))(?=[\s\S]*unresolved)/i],
        forbidText: [/represented probability mass:\s*0/i, /no badge was highlighted or promoted/i],
      },
    );
  }

  const summary = {
    schema: "helix.ask.research_workflow_conversation_replay.v1",
    run_id: runId,
    session_id: sessionId,
    base_url: BASE_URL,
    topic: TOPIC,
    preflight,
    recoveries,
    model_selection: TEST_MODEL_SELECTION,
    status: stages.some((stage) => stage.status === "fail")
      ? "fail"
      : stages.some((stage) => stage.status === "blocked")
        ? "blocked"
        : "pass",
    counts: {
      pass: stages.filter((stage) => stage.status === "pass").length,
      fail: stages.filter((stage) => stage.status === "fail").length,
      blocked: stages.filter((stage) => stage.status === "blocked").length,
      skipped: stages.filter((stage) => stage.status === "skipped").length,
    },
    context,
    stages,
    run_dir: runDir,
  };
  await fs.writeFile(path.join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(
    path.join(runDir, "summary.md"),
    renderSummary({ runId, sessionId, context, stages, preflight, recoveries }),
  );
  console.log(JSON.stringify(summary, null, 2));
  if (summary.status === "fail") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
