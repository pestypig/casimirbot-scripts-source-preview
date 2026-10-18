import fs from "node:fs/promises";
import path from "node:path";

type RecordLike = Record<string, unknown>;

type SseEvent = {
  event: string;
  data: unknown;
};

type Scenario = {
  id: string;
  prompt: string;
  workspaceContextSnapshot?: RecordLike;
  expectNumericExecution?: boolean;
};

const BASE_URL = (process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:1522").replace(/\/+$/, "");
const OUT_ROOT = process.env.HELIX_ASK_SCHOLARLY_MEASUREMENTS_OUT ??
  "artifacts/helix-ask-live-validation/scholarly-measurements";
const TIMEOUT_MS = Math.max(30_000, Number(process.env.HELIX_ASK_SCHOLARLY_MEASUREMENTS_TIMEOUT_MS ?? 300_000));

const PAPER_SELECTION = [
  "A strong choice is **Observations of Radio Magnetars with the Deep Space Network** by Aaron B. Pearlman,",
  "Walid A. Majid, and Thomas A. Prince (2019).",
  "",
  "It presents original radio-telescope observations of several magnetars, making it a useful, data-driven",
  "introduction to magnetar behavior.",
  "",
  "[Read on arXiv](https://arxiv.org/abs/1902.10712v1) -",
  "[PDF](https://arxiv.org/pdf/1902.10712v1.pdf)",
].join(" ");

const contextualSnapshot = (): RecordLike => ({
  chat_referent_context: {
    schema: "helix.ask.chat_referent_context.v1",
    previous_assistant_final_answer: {
      role: "assistant",
      reply_id: "reply:paper-selection",
      source_ref: "chat.final_answer.previous:reply:paper-selection",
      text: PAPER_SELECTION,
    },
    recent_assistant_final_answers: [{
      role: "assistant",
      reply_id: "reply:paper-selection",
      source_ref: "chat.final_answer.previous:reply:paper-selection",
      text: PAPER_SELECTION,
    }],
  },
});

const scenarioFilter = new Set(
  (
    process.argv.find((entry) => entry.startsWith("--scenarios="))?.slice("--scenarios=".length) ??
    process.env.HELIX_ASK_SCHOLARLY_MEASUREMENTS_SCENARIOS ??
    ""
  )
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
);

const scenarios: Scenario[] = [
  {
    id: "direct-pdf-control",
    prompt: "Read https://arxiv.org/pdf/1902.10712v1.pdf and tell me three measurements it reports, with page numbers.",
  },
  {
    id: "contextual-natural-measurements",
    prompt: "Can you get the PDF for that paper and tell me what measurements it reports?",
    workspaceContextSnapshot: contextualSnapshot(),
  },
  {
    id: "contextual-structured-numeric",
    prompt: "Get the PDF for that paper and return a structured table of reported frequencies, bandwidths, durations, and dates with values, units, and page citations.",
    workspaceContextSnapshot: contextualSnapshot(),
    expectNumericExecution: true,
  },
].filter((scenario) => scenarioFilter.size === 0 || scenarioFilter.has(scenario.id));

const readRecord = (value: unknown): RecordLike | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordLike : null;

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const unique = (values: Array<string | null | undefined>): string[] =>
  Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));

const walk = (value: unknown, visit: (record: RecordLike) => void, seen = new WeakSet<object>(), depth = 0): void => {
  if (depth > 20 || value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit, seen, depth + 1);
    return;
  }
  const record = value as RecordLike;
  visit(record);
  for (const entry of Object.values(record)) walk(entry, visit, seen, depth + 1);
};

const parseSse = (text: string): SseEvent[] => text
  .split(/\r?\n\r?\n/)
  .map((block) => block.trim())
  .filter(Boolean)
  .map((block) => {
    const lines = block.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
    const dataText = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    try {
      return { event, data: dataText ? JSON.parse(dataText) : null };
    } catch {
      return { event, data: dataText };
    }
  });

const fetchText = async (url: string, init?: RequestInit): Promise<{ status: number; ok: boolean; text: string }> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { status: response.status, ok: response.ok, text: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
};

const finalPayloadFromEvents = (events: SseEvent[]): RecordLike | null => {
  const event = [...events].reverse().find((entry) => entry.event === "turn_final");
  return readRecord(event?.data);
};

const findTurnId = (value: unknown): string | null => {
  let found: string | null = null;
  walk(value, (record) => {
    found ??= readString(record.turn_id) ?? readString(record.turnId);
  });
  return found;
};

const summarize = (input: {
  scenario: Scenario;
  responseOk: boolean;
  responseStatus: number;
  events: SseEvent[];
  final: RecordLike | null;
  debug: unknown;
}) => {
  const executedCapabilities: string[] = [];
  const failedCapabilities: string[] = [];
  const executionFailureReasons: string[] = [];
  const finalStatuses: string[] = [];
  const terminalKinds: string[] = [];
  const compatibilityReasons: string[] = [];
  const routeUnobservedTools: string[] = [];
  walk({ events: input.events, debug: input.debug }, (record) => {
    if (Array.isArray(record.executed_tools)) {
      executedCapabilities.push(...record.executed_tools.map(readString).filter(Boolean));
    }
    const schema = readString(record.schema) ?? "";
    const gatewayCallResult = schema === "helix.workstation_tool_gateway.call_result.v1";
    const capability = gatewayCallResult
      ? readString(record.capability_id) ?? readString(record.capability_key)
      : null;
    if (capability) {
      executedCapabilities.push(capability);
      if (record.ok === false || ["failed", "blocked"].includes(readString(record.status) ?? "")) {
        failedCapabilities.push(capability);
        executionFailureReasons.push(
          ...unique([
            readString(record.reason),
            readString(record.error_code),
            readString(record.failure_code),
            readString(readRecord(record.error)?.code),
            readString(readRecord(record.error)?.reason),
          ]),
        );
      }
    }
    const finalStatus = readString(record.final_status) ?? readString(record.finalStatus);
    if (finalStatus) finalStatuses.push(finalStatus);
    const terminalKind = readString(record.terminal_artifact_kind) ?? readString(record.terminalArtifactKind);
    if (terminalKind) terminalKinds.push(terminalKind);
    const compatibilityReason = readString(record.compatibility_fallback_reason);
    if (compatibilityReason) compatibilityReasons.push(compatibilityReason);
    if (Array.isArray(record.route_unobserved_tools)) {
      routeUnobservedTools.push(...record.route_unobserved_tools.map(readString).filter(Boolean));
    }
  });

  const finalAnswer = unique([
    readString(input.final?.selected_final_answer),
    readString(input.final?.assistant_answer),
    readString(input.final?.finalAnswer),
    readString(input.final?.answer),
    readString(input.final?.text),
    readString(input.final?.message),
  ])[0] ?? "";
  const numericCapability = "scholarly-research.extract_numeric_parameters";
  const finalStatus = readString(input.final?.final_status) ?? readString(input.final?.finalStatus);
  const responseType = readString(input.final?.response_type) ?? readString(input.final?.responseType);
  const queuedAdmission = /^Ask turn queued:/i.test(finalAnswer) || finalStatus === "pending_input";
  const checks = {
    stream_http_ok: input.responseOk,
    turn_final_present: Boolean(input.final),
    final_answer_present: finalAnswer.length > 0,
    completed_final_answer:
      finalStatus === "completed" && responseType === "final_answer" && !queuedAdmission,
    no_text_evidence_required: !executionFailureReasons.some((reason) => /text_evidence_required/i.test(reason)),
    no_native_route_observation_missing: !compatibilityReasons.includes("native_route_observation_missing"),
    no_provider_preamble_leak: !/Reading prompt from stdin[\s\S]{0,400}OpenAI Codex v/i.test(finalAnswer),
    numeric_execution_when_expected:
      input.scenario.expectNumericExecution !== true || executedCapabilities.includes(numericCapability),
  };
  return {
    scenario: input.scenario.id,
    prompt: input.scenario.prompt,
    status: Object.values(checks).every(Boolean) ? "pass" : "fail",
    response_status: input.responseStatus,
    turn_id: findTurnId(input.final ?? input.events),
    final_status: finalStatus,
    response_type: responseType,
    checks,
    final_statuses: unique(finalStatuses),
    terminal_kinds: unique(terminalKinds),
    executed_capabilities: unique(executedCapabilities),
    failed_capabilities: unique(failedCapabilities),
    execution_failure_reasons: unique(executionFailureReasons),
    compatibility_fallback_reasons: unique(compatibilityReasons),
    route_unobserved_tools: unique(routeUnobservedTools),
    final_answer: finalAnswer,
  };
};

const main = async (): Promise<void> => {
  const runId = `scholarly-measurements-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runDir = path.resolve(OUT_ROOT, runId);
  await fs.mkdir(runDir, { recursive: true });
  const summaries: unknown[] = [];

  for (const [index, scenario] of scenarios.entries()) {
    const scenarioDir = path.join(runDir, `${String(index + 1).padStart(2, "0")}-${scenario.id}`);
    await fs.mkdir(scenarioDir, { recursive: true });
    const sessionId = `helix-ask:${runId}:${scenario.id}`;
    const request = {
      sessionId,
      session_id: sessionId,
      thread_id: sessionId,
      turn_id: `${sessionId}:turn`,
      agent_runtime: "codex",
      agentRuntime: "codex",
      debug: true,
      mode: "read",
      question: scenario.prompt,
      prompt: scenario.prompt,
      ...(scenario.workspaceContextSnapshot
        ? { workspace_context_snapshot: scenario.workspaceContextSnapshot }
        : {}),
    };
    await fs.writeFile(path.join(scenarioDir, "request.json"), `${JSON.stringify(request, null, 2)}\n`);
    console.log(`[scholarly-measurements] start ${scenario.id}`);
    const stream = await fetchText(`${BASE_URL}/api/agi/ask/turn/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(request),
    });
    await fs.writeFile(path.join(scenarioDir, "stream.sse"), stream.text);
    const events = parseSse(stream.text);
    const final = finalPayloadFromEvents(events);
    await fs.writeFile(path.join(scenarioDir, "turn-final.json"), `${JSON.stringify(final, null, 2)}\n`);
    const turnId = findTurnId(final ?? events);
    let debug: unknown = null;
    if (turnId) {
      const debugResponse = await fetchText(
        `${BASE_URL}/api/agi/ask/turn/${encodeURIComponent(turnId)}/debug-export`,
        { headers: { accept: "application/json" } },
      );
      try {
        debug = JSON.parse(debugResponse.text);
      } catch {
        debug = { status: debugResponse.status, raw: debugResponse.text };
      }
      await fs.writeFile(path.join(scenarioDir, "debug-export.json"), `${JSON.stringify(debug, null, 2)}\n`);
    }
    const summary = summarize({
      scenario,
      responseOk: stream.ok,
      responseStatus: stream.status,
      events,
      final,
      debug,
    });
    await fs.writeFile(path.join(scenarioDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    summaries.push(summary);
    console.log(JSON.stringify(summary, null, 2));
  }

  const aggregate = {
    schema: "helix.ask.scholarly_measurements_live_probe.v1",
    run_id: runId,
    base_url: BASE_URL,
    run_dir: runDir,
    status: summaries.every((entry) => readRecord(entry)?.status === "pass") ? "pass" : "fail",
    scenarios: summaries,
  };
  await fs.writeFile(path.join(runDir, "summary.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(JSON.stringify(aggregate, null, 2));
  if (aggregate.status !== "pass") process.exitCode = 1;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
