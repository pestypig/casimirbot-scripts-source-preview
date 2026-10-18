import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type RecordLike = Record<string, unknown>;

const BASE_URL = (process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:5050").replace(/\/+$/, "");
const OUT_DIR = process.env.HELIX_ASK_RUNTIME_GOAL_OUT ?? "artifacts/helix-ask-runtime-goal";
const TIMEOUT_MS = Math.max(1000, Number(process.env.HELIX_ASK_RUNTIME_GOAL_TIMEOUT_MS ?? 180_000));
const AGENT_RUNTIME = process.env.HELIX_ASK_RUNTIME_GOAL_AGENT_RUNTIME ?? "codex";
const TRANSPORT = process.env.HELIX_ASK_RUNTIME_GOAL_TRANSPORT ?? "json";
const WAKE_MODE = process.env.HELIX_ASK_RUNTIME_GOAL_WAKE_MODE ?? "candidate";
const EVENT_KIND = process.env.HELIX_ASK_RUNTIME_GOAL_EVENT_KIND ?? "visible_source_changed";
const OBJECTIVE =
  process.env.HELIX_ASK_RUNTIME_GOAL_OBJECTIVE ??
  "Keep a cumulative summary of the visible document section.";
const DOC_PATH =
  process.env.HELIX_ASK_RUNTIME_GOAL_DOC_PATH ??
  "docs/audits/research/civilization-bounds-nation-procedural-network-fit-2026-06-17.md";
const VISIBLE_TEXT =
  process.env.HELIX_ASK_RUNTIME_GOAL_VISIBLE_TEXT ??
  "The visible document section says nations should be treated as transient, multi-axis evidence states instead of fixed civilization classes.";

const readRecord = (value: unknown): RecordLike | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordLike) : null;

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const readStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

const readRecordArray = (value: unknown): RecordLike[] =>
  Array.isArray(value)
    ? value.map(readRecord).filter((entry): entry is RecordLike => Boolean(entry))
    : [];

const hasStage = (debugExport: RecordLike | null, stage: string): boolean =>
  readRecordArray(debugExport?.debug_events).some((event) => readString(event.stage) === stage);

const hasTranscriptEvent = (payload: RecordLike | null, type: string, lane: string): boolean =>
  readRecordArray(payload?.turn_transcript_events).some(
    (event) => readString(event.type) === type && readString(event.lane) === lane,
  );

const unwrapDebugExportPayload = (value: RecordLike | null | undefined): RecordLike | null => {
  const payload = readRecord(value?.payload);
  return payload ?? value ?? null;
};

export type HelixRuntimeGoalProbeSseEvent = {
  event: string;
  data: unknown;
};

export const parseRuntimeGoalProbeSseEvents = (text: string): HelixRuntimeGoalProbeSseEvent[] =>
  text
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const event = lines
        .find((line) => line.startsWith("event:"))
        ?.slice("event:".length)
        .trim() || "message";
      const dataText = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");
      let data: unknown = dataText;
      if (dataText) {
        try {
          data = JSON.parse(dataText);
        } catch {
          data = dataText;
        }
      }
      return { event, data };
    });

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 800)}`);
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timeout);
  }
};

const fetchAskTurnJson = async (body: RecordLike): Promise<RecordLike> =>
  fetchJson<RecordLike>(`${BASE_URL}/api/agi/ask/turn`, {
    method: "POST",
    body: JSON.stringify(body),
  });

const fetchWakeCandidateJson = async (body: RecordLike): Promise<RecordLike> =>
  fetchJson<RecordLike>(`${BASE_URL}/api/agi/runtime-goals/wake-candidate`, {
    method: "POST",
    body: JSON.stringify(body),
  });

const fetchAskTurnStreamFinal = async (body: RecordLike): Promise<{
  final: RecordLike;
  events: HelixRuntimeGoalProbeSseEvent[];
  text: string;
}> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}/api/agi/ask/turn/stream`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 800)}`);
    const events = parseRuntimeGoalProbeSseEvents(text);
    const finalEvent = [...events].reverse().find((event) => event.event === "turn_final");
    const final = readRecord(finalEvent?.data);
    if (!final) throw new Error("stream turn_final payload missing or not an object");
    return { final, events, text };
  } finally {
    clearTimeout(timeout);
  }
};

export type HelixRuntimeGoalProbeValidation = {
  schema: "helix.runtime_goal_probe.validation.v1";
  ok: boolean;
  failures: string[];
  summary: {
    start_job_title: string | null;
    start_runtime_agent_provider: string | null;
    start_console_summary_present: boolean;
    goal_id: string | null;
    runtime_agent_provider: string | null;
    selected_final_answer: string | null;
    observed_source: string | null;
    requested_observation_or_lane: string | null;
    current_progress_summary: string | null;
    terminal_authority_status: string | null;
    console_summary_present: boolean;
    observation_refs: string[];
  };
};

export const validateRuntimeGoalProbeArtifacts = (input: {
  start: RecordLike | null;
  wake: RecordLike | null;
  debugExport?: RecordLike | null;
  expectedWakeEventKind?: string | null;
}): HelixRuntimeGoalProbeValidation => {
  const failures: string[] = [];
  const expectedWakeEventKind = readString(input.expectedWakeEventKind);
  const debugExportPayload = unwrapDebugExportPayload(input.debugExport);
  const startCommand = readRecord(input.start?.runtime_goal_command);
  const startSession = readRecord(input.start?.runtime_goal_session);
  const startJobBrief = readRecord(input.start?.runtime_goal_job_brief ?? startSession?.job_brief);
  const startRuntimeGoalDebugSummary = readRecord(input.start?.runtime_goal_debug_summary);
  const wakeCommand = readRecord(input.wake?.runtime_goal_command);
  const wakeSession = readRecord(input.wake?.runtime_goal_session);
  const wakeAdmission = readRecord(input.wake?.runtime_goal_wake_admission);
  const wakeCandidate = readRecord(input.wake?.runtime_goal_wake_candidate);
  const wakeEvent = readRecord(input.wake?.runtime_goal_wake_event);
  const startGoalId =
    readString(startSession?.goal_id) ??
    readString(startCommand?.goal_id) ??
    readString(startRuntimeGoalDebugSummary?.goal_id);
  const wakeGoalId =
    readString(wakeSession?.goal_id) ??
    readString(wakeCommand?.goal_id);
  const startRuntimeSessionId =
    readString(startSession?.runtime_session_id) ??
    readString(startRuntimeGoalDebugSummary?.runtime_session_id);
  const wakeRuntimeSessionId = readString(wakeSession?.runtime_session_id);
  const wakePlan = readRecord(input.wake?.runtime_goal_wake_plan ?? wakeSession?.latest_wake_plan);
  const progress = readRecord(input.wake?.runtime_goal_progress_summary ?? wakeSession?.latest_progress_summary);
  const source = readRecord(input.wake?.runtime_goal_source_binding ?? wakeSession?.latest_source_binding ?? progress?.observed_source);
  const evidence = readRecord(progress?.evidence_used);
  const terminalAuthority = readRecord(input.wake?.terminal_answer_authority);
  const runtimeGoalDebugExport = readRecord(input.wake?.runtime_goal_debug_export ?? debugExportPayload?.runtime_goal_debug_export);
  const runtimeGoalDebugSummary = readRecord(input.wake?.runtime_goal_debug_summary ?? debugExportPayload?.runtime_goal_debug_summary);
  const endpointRuntimeGoalDebugExport = readRecord(debugExportPayload?.runtime_goal_debug_export);
  const endpointRuntimeGoalDebugSummary = readRecord(debugExportPayload?.runtime_goal_debug_summary);
  const selectedFinalAnswer =
    readString(input.wake?.selected_final_answer) ??
    readString(input.wake?.answer) ??
    readString(input.wake?.text);
  const startFinalAnswer =
    readString(input.start?.selected_final_answer) ??
    readString(input.start?.answer) ??
    readString(input.start?.text);
  const observationRefs = [
    ...readStringArray(input.wake?.runtime_goal_observation_refs),
    ...readStringArray(wakeSession?.latest_observation_refs),
    ...readStringArray(evidence?.observation_refs),
  ];

  if (readString(startCommand?.command) !== "start") failures.push("start_command_missing");
  if (readString(startSession?.runtime_agent_provider) !== AGENT_RUNTIME) failures.push("start_runtime_agent_provider_mismatch");
  if (!startFinalAnswer?.includes("Goal:")) failures.push("start_answer_goal_missing");
  if (!startFinalAnswer?.includes(readString(startJobBrief?.user_goal_text) ?? OBJECTIVE)) {
    failures.push("start_answer_job_brief_missing");
  }
  if (!startFinalAnswer?.includes("Wake behavior:")) failures.push("start_answer_wake_behavior_missing");
  if (!startRuntimeGoalDebugSummary) {
    failures.push("start_runtime_goal_debug_summary_missing");
  } else {
    if (readString(startRuntimeGoalDebugSummary.job_title) !== readString(startJobBrief?.user_goal_text)) {
      failures.push("start_runtime_goal_console_job_title_missing");
    }
    if (readString(startRuntimeGoalDebugSummary.runtime_agent_provider) !== AGENT_RUNTIME) {
      failures.push("start_runtime_goal_console_runtime_provider_mismatch");
    }
    if (!readString(startRuntimeGoalDebugSummary.next_wake_behavior)) {
      failures.push("start_runtime_goal_console_wake_behavior_missing");
    }
    if (!readString(startRuntimeGoalDebugSummary.wake_timer_status)) {
      failures.push("start_runtime_goal_console_timer_status_missing");
    }
  }
  if (readString(wakeCommand?.command) !== "wake") failures.push("wake_command_missing");
  if (expectedWakeEventKind && !wakeAdmission) failures.push("wake_candidate_admission_missing");
  if (expectedWakeEventKind && !wakeCandidate) failures.push("wake_candidate_missing");
  if (expectedWakeEventKind && !wakeEvent) failures.push("wake_event_missing");
  if (wakeAdmission || wakeCandidate || wakeEvent || expectedWakeEventKind) {
    if (readString(wakeAdmission?.status) !== "admitted") failures.push("wake_candidate_not_admitted");
    if (!readString(wakeAdmission?.reason)) failures.push("wake_candidate_admission_reason_missing");
    const actualWakeCandidateEventKind = readString(wakeCandidate?.event_kind);
    if (!actualWakeCandidateEventKind) failures.push("wake_candidate_event_kind_missing");
    if (expectedWakeEventKind && actualWakeCandidateEventKind && actualWakeCandidateEventKind !== expectedWakeEventKind) {
      failures.push("wake_candidate_event_kind_mismatch");
    }
    if (!readString(wakeCandidate?.dedupe_key)) failures.push("wake_candidate_dedupe_key_missing");
    if (!readString(wakeEvent?.wake_event_id)) failures.push("wake_event_id_missing");
    const actualWakeEventKind = readString(wakeEvent?.kind);
    if (expectedWakeEventKind && actualWakeEventKind && actualWakeEventKind !== expectedWakeEventKind) {
      failures.push("wake_event_kind_mismatch");
    }
    if (readString(wakeEvent?.goal_id) && wakeGoalId && readString(wakeEvent?.goal_id) !== wakeGoalId) {
      failures.push("wake_event_goal_continuity_mismatch");
    }
  }
  if (readString(wakeSession?.runtime_agent_provider) !== AGENT_RUNTIME) failures.push("wake_runtime_agent_provider_mismatch");
  if (!startGoalId || !wakeGoalId || startGoalId !== wakeGoalId) {
    failures.push("goal_session_continuity_mismatch");
  }
  if (startRuntimeSessionId && wakeRuntimeSessionId && startRuntimeSessionId !== wakeRuntimeSessionId) {
    failures.push("runtime_session_continuity_mismatch");
  }
  if (endpointRuntimeGoalDebugExport) {
    const endpointGoalId = readString(endpointRuntimeGoalDebugExport.goal_id);
    const endpointRuntimeSessionId = readString(endpointRuntimeGoalDebugExport.runtime_session_id);
    if (wakeGoalId && endpointGoalId && endpointGoalId !== wakeGoalId) {
      failures.push("debug_export_goal_continuity_mismatch");
    }
    if (wakeRuntimeSessionId && endpointRuntimeSessionId && endpointRuntimeSessionId !== wakeRuntimeSessionId) {
      failures.push("debug_export_runtime_session_continuity_mismatch");
    }
  }
  if (endpointRuntimeGoalDebugSummary) {
    const endpointSummaryGoalId = readString(endpointRuntimeGoalDebugSummary.goal_id);
    const endpointSummaryRuntimeSessionId = readString(endpointRuntimeGoalDebugSummary.runtime_session_id);
    if (wakeGoalId && endpointSummaryGoalId && endpointSummaryGoalId !== wakeGoalId) {
      failures.push("debug_export_summary_goal_continuity_mismatch");
    }
    if (wakeRuntimeSessionId && endpointSummaryRuntimeSessionId && endpointSummaryRuntimeSessionId !== wakeRuntimeSessionId) {
      failures.push("debug_export_summary_runtime_session_continuity_mismatch");
    }
  }
  if (readString(wakePlan?.requested_observation_or_lane) !== "docs-viewer.read_visible_surface") {
    failures.push("wake_visible_surface_observation_not_requested");
  }
  if (!readString(source?.doc_path) && !readString(source?.source_label)) failures.push("wake_source_missing");
  if (observationRefs.length === 0) failures.push("wake_observation_refs_missing");
  if (!readString(progress?.current_summary)) failures.push("wake_progress_summary_missing");
  if (!selectedFinalAnswer?.includes("Goal:")) failures.push("wake_answer_goal_missing");
  if (!selectedFinalAnswer?.includes("Observed source:")) failures.push("wake_answer_source_missing");
  if (!selectedFinalAnswer?.includes("Evidence used:")) failures.push("wake_answer_evidence_missing");
  if (terminalAuthority?.server_authoritative !== true) failures.push("terminal_authority_not_server_authoritative");
  if (readString(wakeSession?.terminal_authority_status) !== "authorized") failures.push("runtime_goal_terminal_authority_not_authorized");
  if (!runtimeGoalDebugSummary) {
    failures.push("runtime_goal_debug_summary_missing");
  } else {
    if (!readString(runtimeGoalDebugSummary.job_title)) failures.push("runtime_goal_console_job_title_missing");
    if (readString(runtimeGoalDebugSummary.runtime_agent_provider) !== AGENT_RUNTIME) {
      failures.push("runtime_goal_console_runtime_provider_mismatch");
    }
    if (!readString(runtimeGoalDebugSummary.session_status)) failures.push("runtime_goal_console_session_status_missing");
    if (!readString(runtimeGoalDebugSummary.last_wake_at)) failures.push("runtime_goal_console_last_wake_missing");
    if (!readString(runtimeGoalDebugSummary.observed_source_label) && !readString(runtimeGoalDebugSummary.observed_source_doc_path)) {
      failures.push("runtime_goal_console_source_missing");
    }
    if (!readString(runtimeGoalDebugSummary.observed_source_kind)) {
      failures.push("runtime_goal_console_source_kind_missing");
    }
    if (typeof runtimeGoalDebugSummary.observed_source_freshness_ms !== "number") {
      failures.push("runtime_goal_console_source_freshness_missing");
    }
    if (readString(runtimeGoalDebugSummary.requested_observation_or_lane) !== "docs-viewer.read_visible_surface") {
      failures.push("runtime_goal_console_tool_missing");
    }
    if (!readString(runtimeGoalDebugSummary.wake_relevance_reason)) {
      failures.push("runtime_goal_console_wake_reason_missing");
    }
    if (readString(runtimeGoalDebugSummary.wake_expected_terminal_product) !== "job_progress_report") {
      failures.push("runtime_goal_console_terminal_product_missing");
    }
    if (!readString(runtimeGoalDebugSummary.current_progress_summary)) {
      failures.push("runtime_goal_console_progress_missing");
    }
    if (!readString(runtimeGoalDebugSummary.wake_timer_status)) {
      failures.push("runtime_goal_console_timer_status_missing");
    }
    if (readString(runtimeGoalDebugSummary.terminal_authority_status) !== "authorized") {
      failures.push("runtime_goal_console_terminal_authority_missing");
    }
    if (runtimeGoalDebugSummary.terminal_answer_server_authoritative !== true) {
      failures.push("runtime_goal_console_server_authority_missing");
    }
    if (readStringArray(runtimeGoalDebugSummary.latest_observation_refs).length === 0) {
      failures.push("runtime_goal_console_observation_refs_missing");
    }
  }
  for (const stage of [
    "tool_or_lane_requested",
    "tool_or_lane_admitted",
    "evidence_reentered",
    "terminal_authority_evaluated",
  ]) {
    if (!hasStage(runtimeGoalDebugExport, stage)) failures.push(`runtime_goal_debug_stage_missing:${stage}`);
  }
  if (!hasTranscriptEvent(input.wake, "runtime_goal_command", "runtime_goal")) {
    failures.push("runtime_goal_command_transcript_missing");
  }
  if (!hasTranscriptEvent(input.wake, "terminal_answer", "terminal_authority")) {
    failures.push("runtime_goal_terminal_transcript_missing");
  }

  return {
    schema: "helix.runtime_goal_probe.validation.v1",
    ok: failures.length === 0,
    failures,
    summary: {
      start_job_title:
        readString(startRuntimeGoalDebugSummary?.job_title) ??
        readString(startJobBrief?.user_goal_text),
      start_runtime_agent_provider: readString(startSession?.runtime_agent_provider),
      start_console_summary_present: Boolean(startRuntimeGoalDebugSummary),
      goal_id: wakeGoalId,
      runtime_agent_provider: readString(wakeSession?.runtime_agent_provider),
      selected_final_answer: selectedFinalAnswer,
      observed_source: readString(source?.doc_path) ?? readString(source?.source_label),
      requested_observation_or_lane: readString(wakePlan?.requested_observation_or_lane),
      current_progress_summary: readString(progress?.current_summary),
      terminal_authority_status: readString(wakeSession?.terminal_authority_status),
      console_summary_present: Boolean(runtimeGoalDebugSummary),
      observation_refs: Array.from(new Set(observationRefs)),
    },
  };
};

const maybeFetchDebugExport = async (turnId: unknown): Promise<RecordLike | null> => {
  const id = readString(turnId);
  if (!id) return null;
  try {
    return await fetchJson<RecordLike>(`${BASE_URL}/api/agi/ask/turn/${encodeURIComponent(id)}/debug-export`);
  } catch (error) {
    return {
      schema: "helix.runtime_goal_probe.debug_export_fetch_error.v1",
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const buildStartBody = (sessionId: string): RecordLike => ({
  sessionId,
  agent_runtime: AGENT_RUNTIME,
  question: `/goal ${OBJECTIVE}`,
  mode: "read",
  debug: true,
});

const buildWakeBody = (sessionId: string): RecordLike => ({
  sessionId,
  agent_runtime: AGENT_RUNTIME,
  question: "/goal wake",
  mode: "read",
  debug: true,
  source_freshness_ms: 0,
  workspace_context_snapshot: {
    activePanel: "docs-viewer",
    active_doc_path: DOC_PATH,
    active_doc_visible_translation_context: {
      schema: "helix.ask.active_doc_visible_translation_context.v1",
      doc_path: DOC_PATH,
      source_id: `document_markdown:${DOC_PATH}`,
      source_hash: "runtime-goal-probe-visible-v1",
      chunks: [
        {
          chunk_id: "runtime-goal-probe-visible-1",
          source_text_hash: "runtime-goal-probe-visible-text-v1",
          visible_text: VISIBLE_TEXT,
        },
      ],
    },
  },
});

const readGoalIdFromStart = (start: RecordLike): string | null => {
  const session = readRecord(start.runtime_goal_session);
  const command = readRecord(start.runtime_goal_command);
  const summary = readRecord(start.runtime_goal_debug_summary);
  return readString(session?.goal_id) ?? readString(command?.goal_id) ?? readString(summary?.goal_id);
};

const buildWakeCandidateBody = (sessionId: string, start: RecordLike): RecordLike => {
  const goalId = readGoalIdFromStart(start);
  const eventKind = EVENT_KIND === "visible_surface_changed" ? "visible_surface_changed" : "visible_source_changed";
  return {
    ...buildWakeBody(sessionId),
    ...(goalId ? { goal_id: goalId } : {}),
    event_kind: eventKind,
    source_kind: "docs_viewer_visible_surface",
    source_id: `document_markdown:${DOC_PATH}`,
    source_hash: "runtime-goal-probe-visible-v1",
    source_label: DOC_PATH,
    active_panel_id: "docs-viewer",
    reason: eventKind === "visible_surface_changed"
      ? "docs_viewer_visible_surface_changed"
      : "docs_viewer_active_doc_changed",
    dedupe_key: [
      "runtime-goal-probe",
      sessionId,
      goalId ?? "active-goal",
      eventKind,
      DOC_PATH,
      "runtime-goal-probe-visible-v1",
      eventKind === "visible_surface_changed" ? "runtime-goal-probe-visible-1" : null,
      eventKind === "visible_surface_changed" ? "runtime-goal-probe-visible-text-v1" : null,
    ].filter(Boolean).join(":"),
    source_identity_key: eventKind === "visible_surface_changed"
      ? [
          `document_markdown:${DOC_PATH}`,
          "runtime-goal-probe-visible-v1",
          "runtime-goal-probe-visible-1",
          "runtime-goal-probe-visible-text-v1",
        ].join("::")
      : undefined,
    proposed_tool: "docs-viewer.read_visible_surface",
    requires_user_visible_turn: true,
    observed_at_ms: Date.now(),
  };
};

const fetchRuntimeGoalWake = async (sessionId: string, start: RecordLike): Promise<RecordLike> => {
  if (WAKE_MODE === "manual") return fetchAskTurnJson(buildWakeBody(sessionId));
  return fetchWakeCandidateJson(buildWakeCandidateBody(sessionId, start));
};

const expectedWakeEventKind = (): string | null => {
  if (WAKE_MODE === "manual") return null;
  return EVENT_KIND === "visible_surface_changed" ? "visible_surface_changed" : "visible_source_changed";
};

const main = async (): Promise<void> => {
  const runId = `runtime-goal-${Date.now()}`;
  const outputDir = path.resolve(OUT_DIR, runId);
  await fs.mkdir(outputDir, { recursive: true });
  const artifactFiles: string[] = [];
  const writeArtifact = async (name: string, value: unknown): Promise<void> => {
    await fs.writeFile(path.join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`);
    artifactFiles.push(name);
  };
  const sessionId = `helix-runtime-goal-probe:${runId}:json`;

  try {
    const start = await fetchAskTurnJson(buildStartBody(sessionId));
    const wake = await fetchRuntimeGoalWake(sessionId, start);

    const debugExport = await maybeFetchDebugExport(wake.turn_id);
    const validation = validateRuntimeGoalProbeArtifacts({
      start,
      wake,
      debugExport,
      expectedWakeEventKind: expectedWakeEventKind(),
    });
    const streamEnabled = TRANSPORT === "stream" || TRANSPORT === "both";
    let streamArtifacts: {
      start: RecordLike;
      wake: RecordLike;
      startEvents: HelixRuntimeGoalProbeSseEvent[];
      wakeEvents: HelixRuntimeGoalProbeSseEvent[];
      debugExport: RecordLike | null;
      validation: HelixRuntimeGoalProbeValidation;
    } | null = null;
    if (streamEnabled) {
      const streamSessionId = `helix-runtime-goal-probe:${runId}:stream`;
      const streamStart = await fetchAskTurnStreamFinal(buildStartBody(streamSessionId));
      const streamWake = await fetchAskTurnStreamFinal(buildWakeBody(streamSessionId));
      const streamDebugExport = await maybeFetchDebugExport(streamWake.final.turn_id);
      streamArtifacts = {
        start: streamStart.final,
        wake: streamWake.final,
        startEvents: streamStart.events,
        wakeEvents: streamWake.events,
        debugExport: streamDebugExport,
        validation: validateRuntimeGoalProbeArtifacts({
          start: streamStart.final,
          wake: streamWake.final,
          debugExport: streamDebugExport,
        }),
      };
      await writeArtifact("stream-start-response.json", streamStart.final);
      await writeArtifact("stream-wake-response.json", streamWake.final);
      await writeArtifact("stream-start-events.json", streamStart.events);
      await writeArtifact("stream-wake-events.json", streamWake.events);
      await writeArtifact("stream-debug-export.json", streamDebugExport);
      await writeArtifact("stream-validation.json", streamArtifacts.validation);
    }

    await writeArtifact("start-response.json", start);
    await writeArtifact("wake-response.json", wake);
    await writeArtifact("debug-export.json", debugExport);
    await writeArtifact("validation.json", validation);

    const artifactManifest = {
      schema: "helix.runtime_goal_probe.artifact_manifest.v1",
      run_id: runId,
      base_url: BASE_URL,
      transport: TRANSPORT,
      wake_mode: WAKE_MODE,
      event_kind: EVENT_KIND,
      runtime_agent_provider: AGENT_RUNTIME,
      output_dir: outputDir,
      artifact_files: [...artifactFiles, "artifact-manifest.json"],
      json_validation_ok: validation.ok,
      stream_validation_ok: streamArtifacts?.validation.ok ?? null,
    };
    await writeArtifact("artifact-manifest.json", artifactManifest);

    console.log(JSON.stringify({
      schema: "helix.runtime_goal_probe.result.v1",
      run_id: runId,
      base_url: BASE_URL,
      transport: TRANSPORT,
      wake_mode: WAKE_MODE,
      event_kind: EVENT_KIND,
      output_dir: outputDir,
      artifact_files: artifactManifest.artifact_files,
      validation,
      stream_validation: streamArtifacts?.validation ?? null,
    }, null, 2));

    if (!validation.ok || streamArtifacts?.validation.ok === false) process.exitCode = 1;
  } catch (error) {
    const errorPayload = {
      schema: "helix.runtime_goal_probe.error.v1",
      run_id: runId,
      base_url: BASE_URL,
      transport: TRANSPORT,
      wake_mode: WAKE_MODE,
      event_kind: EVENT_KIND,
      runtime_agent_provider: AGENT_RUNTIME,
      message: error instanceof Error ? error.message : String(error),
    };
    await writeArtifact("probe-error.json", errorPayload);
    const artifactManifest = {
      schema: "helix.runtime_goal_probe.artifact_manifest.v1",
      run_id: runId,
      base_url: BASE_URL,
      transport: TRANSPORT,
      wake_mode: WAKE_MODE,
      event_kind: EVENT_KIND,
      runtime_agent_provider: AGENT_RUNTIME,
      output_dir: outputDir,
      artifact_files: [...artifactFiles, "artifact-manifest.json"],
      json_validation_ok: false,
      stream_validation_ok: TRANSPORT === "stream" || TRANSPORT === "both" ? false : null,
      probe_error: errorPayload,
    };
    await writeArtifact("artifact-manifest.json", artifactManifest);
    console.log(JSON.stringify({
      schema: "helix.runtime_goal_probe.result.v1",
      run_id: runId,
      base_url: BASE_URL,
      transport: TRANSPORT,
      wake_mode: WAKE_MODE,
      event_kind: EVENT_KIND,
      output_dir: outputDir,
      artifact_files: artifactManifest.artifact_files,
      validation: null,
      stream_validation: null,
      probe_error: errorPayload,
    }, null, 2));
    process.exitCode = 1;
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
