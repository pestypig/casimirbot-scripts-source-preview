import fs from "node:fs/promises";
import path from "node:path";

type RecordLike = Record<string, unknown>;
type Verdict = "PASS" | "WARN" | "FAIL";

type ScenarioExpectation = {
  targetSource?: string;
  requiredTools?: string[];
  forbiddenAnswerPatterns?: RegExp[];
  decision?: string;
  terminalKind?: string;
  requiresPolicy?: boolean;
  requiresNarrative?: boolean;
  requiresDecisionTurnRef?: boolean;
};

type Scenario = {
  id: string;
  label: string;
  prompt: string;
  expectation: ScenarioExpectation;
};

type ScenarioResult = {
  id: string;
  label: string;
  prompt: string;
  verdict: Verdict;
  failures: string[];
  warnings: string[];
  turnId: string | null;
  answer: string | null;
  selectedTargetSource: string | null;
  sourceTarget: string | null;
  terminalKind: string | null;
  tools: string[];
  decision: string | null;
  decisionId: string | null;
  decisionEvidenceHasTurnId: boolean | null;
  narrativeStateRef: string | null;
  watchPolicyRef: string | null;
  trajectory: {
    route: string | null;
    capability: string | null;
    mailIds: string[];
    decisionId: string | null;
    narrativeStateId: string | null;
    traceId: string | null;
    cycleId: string | null;
    askTurnId: string | null;
  };
  mailboxBefore: MailboxCounts;
  mailboxAfter: MailboxCounts;
  artifacts: {
    scenarioDir: string;
    mailboxBeforePath: string;
    askPath: string;
    debugPath: string | null;
    mailboxAfterPath: string;
  };
};

type MailboxCounts = {
  total: number;
  byStatus: Record<string, number>;
  latestMailId: string | null;
  latestPreview: string | null;
  policyCount: number;
  latestPolicyRef: string | null;
  latestDecisionRef: string | null;
  unreadCount: number;
};

const BASE_URL = (process.env.HELIX_LIVE_SOURCE_PLAYBOOK_BASE_URL ?? process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:5050").replace(/\/+$/, "");
const THREAD_ID = process.env.HELIX_LIVE_SOURCE_PLAYBOOK_THREAD_ID ?? "helix-ask:desktop";
const OUT_DIR = process.env.HELIX_LIVE_SOURCE_PLAYBOOK_OUT ?? "artifacts/helix-ask-live-source-playbook";
const TIMEOUT_MS = Math.max(1000, Number(process.env.HELIX_LIVE_SOURCE_PLAYBOOK_TIMEOUT_MS ?? 240_000));
const SCENARIO_FILTER = (process.env.HELIX_LIVE_SOURCE_PLAYBOOK_SCENARIOS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const FAIL_ON_WARN = process.env.HELIX_LIVE_SOURCE_PLAYBOOK_FAIL_ON_WARN === "1";

const SCENARIOS: Scenario[] = [
  {
    id: "one_time_latest_mail",
    label: "One-time visual mail read",
    prompt: "What does the latest visual mail show?",
    expectation: {
      targetSource: "live_source_mailbox",
      requiredTools: ["live_env.read_live_source_mail", "live_env.record_live_source_mail_decision"],
      decision: "draft_text_answer",
      terminalKind: "model_synthesized_answer",
      requiresDecisionTurnRef: true,
      forbiddenAnswerPatterns: [/visual evidence (?:is )?unavailable/i, /unread live-source mail item\(s\) were read/i],
    },
  },
  {
    id: "interpretive_mail_loop",
    label: "Interpretive mail loop",
    prompt: "Read the visual mail and interpret what is happening. Say what should be watched next.",
    expectation: {
      targetSource: "live_source_mailbox",
      requiredTools: ["live_env.read_live_source_mail", "live_env.record_live_source_mail_decision"],
      decision: "record_interpretation",
      terminalKind: "model_synthesized_answer",
      requiresNarrative: true,
      requiresDecisionTurnRef: true,
      forbiddenAnswerPatterns: [/visual evidence (?:is )?unavailable/i, /Latest preview:/i],
    },
  },
  {
    id: "standing_watch_policy",
    label: "Standing watch policy",
    prompt: "Watch the active visual source and describe each new mail batch in one sentence.",
    expectation: {
      targetSource: "live_source_mailbox",
      requiredTools: ["live_env.configure_live_source_watch_job"],
      terminalKind: "model_synthesized_answer",
      requiresPolicy: true,
      forbiddenAnswerPatterns: [/visual evidence (?:is )?unavailable/i],
    },
  },
  {
    id: "salience_watch_policy",
    label: "Salience watch policy",
    prompt: "Keep watching the visual source and only tell me if something important changes.",
    expectation: {
      targetSource: "live_source_mailbox",
      requiredTools: ["live_env.configure_live_source_watch_job"],
      terminalKind: "model_synthesized_answer",
      requiresPolicy: true,
      forbiddenAnswerPatterns: [/visual evidence (?:is )?unavailable/i],
    },
  },
  {
    id: "interpreter_profile_config",
    label: "Interpreter profile configuration",
    prompt: "Create an interpreter profile for this Minecraft visual source. Act like a survival coach. Call out danger, rare resources, and strategic decision points. Ignore routine walking.",
    expectation: {
      targetSource: "live_source_mailbox",
      requiredTools: ["live_env.configure_interpreter_profile"],
      terminalKind: "model_synthesized_answer",
      forbiddenAnswerPatterns: [/visual evidence (?:is )?unavailable/i],
    },
  },
];

const readRecord = (value: unknown): RecordLike | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordLike : null;

const readArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const readBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const uniqueStrings = (values: unknown[]): string[] =>
  [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];

const safeName = (value: string): string => value.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "scenario";

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
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 1200)}`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timeout);
  }
};

const unwrapPayload = (value: RecordLike | null): RecordLike | null => {
  if (!value) return null;
  return readRecord(value.payload) ?? value;
};

const mailboxCounts = (mailbox: RecordLike | null): MailboxCounts => {
  const mailItems = readArray(mailbox?.mailItems).map(readRecord).filter(Boolean) as RecordLike[];
  const policies = readArray(mailbox?.watchJobPolicies).map(readRecord).filter(Boolean) as RecordLike[];
  const decisions = readArray(mailbox?.decisions).map(readRecord).filter(Boolean) as RecordLike[];
  const byStatus: Record<string, number> = {};
  for (const item of mailItems) {
    const status = readString(item.status) ?? "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  const latestMail = mailItems.at(-1) ?? null;
  const latestSummary = readRecord(latestMail?.summary);
  return {
    total: mailItems.length,
    byStatus,
    latestMailId: readString(latestMail?.mailId),
    latestPreview: readString(latestSummary?.preview) ?? readString(latestSummary?.text),
    policyCount: policies.length,
    latestPolicyRef: readString(policies.at(-1)?.policyId),
    latestDecisionRef: readString(decisions.at(-1)?.decisionId),
    unreadCount: byStatus.unread ?? 0,
  };
};

const listToolNames = (ask: RecordLike, debugPayload: RecordLike | null): string[] => {
  const ledger = [
    ...readArray(ask.current_turn_artifact_ledger),
    ...readArray(debugPayload?.current_turn_artifact_ledger),
  ].map(readRecord).filter(Boolean) as RecordLike[];
  const toolNames = ledger.flatMap((artifact) => {
    const payload = readRecord(artifact.payload);
    return [
      readString(payload?.tool_name),
      readString(payload?.toolName),
      readString(payload?.capability_key),
      readString(payload?.chosen_capability),
    ];
  });
  const loop = readRecord(debugPayload?.agent_runtime_loop);
  for (const iteration of readArray(loop?.iterations).map(readRecord).filter(Boolean) as RecordLike[]) {
    const decision = readRecord(iteration.decision);
    toolNames.push(readString(decision?.chosen_capability));
  }
  return uniqueStrings(toolNames);
};

const findToolObservation = (ask: RecordLike, debugPayload: RecordLike | null, toolName: string): RecordLike | null => {
  const ledger = [
    ...readArray(ask.current_turn_artifact_ledger),
    ...readArray(debugPayload?.current_turn_artifact_ledger),
  ].map(readRecord).filter(Boolean) as RecordLike[];
  for (const artifact of ledger.reverse()) {
    const payload = readRecord(artifact.payload);
    if (readString(payload?.tool_name) !== toolName) continue;
    return readRecord(payload?.observation) ?? readRecord(payload?.result) ?? payload;
  }
  return null;
};

const extractDecision = (ask: RecordLike, debugPayload: RecordLike | null): RecordLike | null =>
  findToolObservation(ask, debugPayload, "live_env.record_live_source_mail_decision");

const extractPolicyRef = (ask: RecordLike, debugPayload: RecordLike | null): string | null => {
  const observation = findToolObservation(ask, debugPayload, "live_env.configure_live_source_watch_job");
  const policy = readRecord(observation?.policy);
  return readString(policy?.policyId) ?? readString(observation?.watchJobPolicyRef);
};

const selectedTargetSource = (ask: RecordLike, debugPayload: RecordLike | null): string | null => {
  const arbitration = readRecord(debugPayload?.evidence_target_arbitration) ?? readRecord(ask.evidence_target_arbitration);
  return readString(arbitration?.selected_target_source) ?? readString(readRecord(ask.source_target_intent)?.target_source);
};

const terminalKind = (ask: RecordLike, debugPayload: RecordLike | null): string | null => {
  const resolved = readRecord(debugPayload?.resolved_turn_summary) ?? readRecord(ask.resolved_turn_summary);
  return readString(resolved?.terminal_artifact_kind) ?? readString(debugPayload?.terminal_artifact_kind);
};

const mailboxDebug = (ask: RecordLike, debugPayload: RecordLike | null): RecordLike | null =>
  readRecord(debugPayload?.stage_play_live_source_mailbox_debug) ??
  readRecord(ask.stage_play_live_source_mailbox_debug);

const extractTrajectory = (input: {
  ask: RecordLike;
  debugPayload: RecordLike | null;
  turnId: string | null;
  tools: string[];
  target: string | null;
  decisionId: string | null;
  narrativeStateRef: string | null;
}): ScenarioResult["trajectory"] => {
  const debug = mailboxDebug(input.ask, input.debugPayload);
  const trajectory = readRecord(debug?.trajectory);
  const readWindow = readRecord(debug?.read_window);
  const mailIds = uniqueStrings([
    ...readArray(trajectory?.mailIds),
    ...readArray(trajectory?.mail_ids),
    ...readArray(debug?.mail_ids),
    ...readArray(readWindow?.mailIds),
    ...readArray(readWindow?.mail_ids),
  ]);
  return {
    route:
      readString(trajectory?.route) ??
      readString(debug?.route) ??
      input.target,
    capability:
      readString(trajectory?.capability) ??
      readString(debug?.capability) ??
      input.tools.find((tool) => tool.startsWith("live_env.")) ??
      null,
    mailIds,
    decisionId:
      readString(trajectory?.decisionId) ??
      readString(trajectory?.decision_id) ??
      readString(debug?.decision_id) ??
      input.decisionId,
    narrativeStateId:
      readString(trajectory?.narrativeStateId) ??
      readString(trajectory?.narrative_state_id) ??
      readString(debug?.narrative_state_id) ??
      input.narrativeStateRef,
    traceId:
      readString(trajectory?.traceId) ??
      readString(trajectory?.trace_id) ??
      readString(debug?.trace_id),
    cycleId:
      readString(trajectory?.cycleId) ??
      readString(trajectory?.cycle_id) ??
      readString(debug?.cycle_id),
    askTurnId:
      readString(trajectory?.askTurnId) ??
      readString(trajectory?.ask_turn_id) ??
      readString(debug?.ask_turn_id) ??
      input.turnId,
  };
};

const askTurn = async (scenario: Scenario, scenarioDir: string): Promise<{
  ask: RecordLike;
  debug: RecordLike | null;
  debugPayload: RecordLike | null;
  turnId: string | null;
  askPath: string;
  debugPath: string | null;
}> => {
  const ask = await fetchJson<RecordLike>(`${BASE_URL}/api/agi/ask/turn`, {
    method: "POST",
    body: JSON.stringify({
      question: scenario.prompt,
      prompt: scenario.prompt,
      sessionId: THREAD_ID,
      debug: true,
    }),
  });
  const askPath = path.join(scenarioDir, "ask-response.json");
  await fs.writeFile(askPath, `${JSON.stringify(ask, null, 2)}\n`);
  const turnId = readString(ask.turn_id) ?? readString(ask.trace_id);
  if (!turnId) {
    return { ask, debug: null, debugPayload: null, turnId: null, askPath, debugPath: null };
  }
  const debug = await fetchJson<RecordLike>(`${BASE_URL}/api/agi/ask/turn/${encodeURIComponent(turnId)}/debug-export`);
  const debugPath = path.join(scenarioDir, "debug-export.json");
  await fs.writeFile(debugPath, `${JSON.stringify(debug, null, 2)}\n`);
  return { ask, debug, debugPayload: unwrapPayload(debug), turnId, askPath, debugPath };
};

const fetchMailbox = async (): Promise<RecordLike> =>
  fetchJson<RecordLike>(`${BASE_URL}/api/helix/stage-play/live-source-mail?threadId=${encodeURIComponent(THREAD_ID)}&limit=100`);

const evaluateScenario = (input: {
  scenario: Scenario;
  ask: RecordLike;
  debugPayload: RecordLike | null;
  turnId: string | null;
  mailboxBefore: MailboxCounts;
  mailboxAfter: MailboxCounts;
  scenarioDir: string;
  mailboxBeforePath: string;
  askPath: string;
  debugPath: string | null;
  mailboxAfterPath: string;
}): ScenarioResult => {
  const { scenario, ask, debugPayload, turnId } = input;
  const failures: string[] = [];
  const warnings: string[] = [];
  const tools = listToolNames(ask, debugPayload);
  const decision = extractDecision(ask, debugPayload);
  const decisionKind = readString(decision?.decision);
  const decisionId = readString(decision?.decisionId);
  const decisionEvidenceRefs = readArray(decision?.evidenceRefs);
  const decisionEvidenceHasTurnId = turnId ? decisionEvidenceRefs.includes(turnId) : null;
  const narrativeStateRef = readString(decision?.narrativeStateRef) ?? readString(readRecord(decision?.narrativeState)?.narrativeStateId);
  const policyRef = extractPolicyRef(ask, debugPayload);
  const target = selectedTargetSource(ask, debugPayload);
  const sourceTarget = readString(readRecord(ask.source_target_intent)?.target_source);
  const terminal = terminalKind(ask, debugPayload);
  const answer = readString(ask.answer) ?? readString(debugPayload?.selected_final_answer);
  const trajectory = extractTrajectory({
    ask,
    debugPayload,
    turnId,
    tools,
    target,
    decisionId,
    narrativeStateRef,
  });

  if (scenario.expectation.targetSource && target !== scenario.expectation.targetSource && sourceTarget !== scenario.expectation.targetSource) {
    failures.push(`expected target ${scenario.expectation.targetSource}, got ${target ?? sourceTarget ?? "none"}`);
  }
  if (scenario.expectation.targetSource === "live_source_mailbox") {
    if (trajectory.route !== "live_source_mailbox") failures.push(`trajectory route missing or wrong: ${trajectory.route ?? "none"}`);
    if (!trajectory.capability) failures.push("trajectory capability missing");
    if (!trajectory.askTurnId) failures.push("trajectory askTurnId missing");
    if (!trajectory.traceId) failures.push("trajectory traceId missing");
    if (!trajectory.cycleId) failures.push("trajectory cycleId missing");
  }
  for (const tool of scenario.expectation.requiredTools ?? []) {
    if (!tools.includes(tool)) failures.push(`missing tool ${tool}`);
  }
  if (scenario.expectation.decision && decisionKind !== scenario.expectation.decision) {
    failures.push(`expected decision ${scenario.expectation.decision}, got ${decisionKind ?? "none"}`);
  }
  if (scenario.expectation.terminalKind && terminal !== scenario.expectation.terminalKind) {
    failures.push(`expected terminal ${scenario.expectation.terminalKind}, got ${terminal ?? "none"}`);
  }
  if (scenario.expectation.requiresPolicy && !policyRef && input.mailboxAfter.policyCount <= input.mailboxBefore.policyCount) {
    failures.push("expected a watch policy ref or increased policy count");
  }
  if (scenario.expectation.requiresNarrative && !narrativeStateRef) {
    failures.push("expected narrative state ref");
  }
  if (scenario.expectation.requiresNarrative && !trajectory.narrativeStateId) {
    failures.push("trajectory narrativeStateId missing");
  }
  if (scenario.expectation.decision && !trajectory.decisionId) {
    failures.push("trajectory decisionId missing");
  }
  if (scenario.expectation.requiredTools?.includes("live_env.read_live_source_mail") && trajectory.mailIds.length === 0) {
    failures.push("trajectory mailIds missing");
  }
  if (scenario.expectation.requiresDecisionTurnRef && decisionKind && decisionEvidenceHasTurnId !== true) {
    failures.push("decision evidence refs do not include owning Ask turn id");
  }
  for (const pattern of scenario.expectation.forbiddenAnswerPatterns ?? []) {
    if (answer && pattern.test(answer)) failures.push(`answer matched forbidden pattern ${String(pattern)}`);
  }
  if (input.mailboxBefore.unreadCount === 0 && scenario.expectation.requiredTools?.includes("live_env.read_live_source_mail")) {
    warnings.push("mailbox had no unread mail before read scenario");
  }
  if (readBoolean(debugPayload?.causal_turn_timeline_summary && readRecord(debugPayload.causal_turn_timeline_summary)?.deterministic_fallback_used) === true) {
    failures.push("deterministic fallback was used");
  }
  const verdict: Verdict = failures.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS";
  return {
    id: scenario.id,
    label: scenario.label,
    prompt: scenario.prompt,
    verdict,
    failures,
    warnings,
    turnId,
    answer,
    selectedTargetSource: target,
    sourceTarget,
    terminalKind: terminal,
    tools,
    decision: decisionKind,
    decisionId,
    decisionEvidenceHasTurnId,
    narrativeStateRef,
    watchPolicyRef: policyRef ?? input.mailboxAfter.latestPolicyRef,
    trajectory,
    mailboxBefore: input.mailboxBefore,
    mailboxAfter: input.mailboxAfter,
    artifacts: {
      scenarioDir: input.scenarioDir,
      mailboxBeforePath: input.mailboxBeforePath,
      askPath: input.askPath,
      debugPath: input.debugPath,
      mailboxAfterPath: input.mailboxAfterPath,
    },
  };
};

const runScenario = async (scenario: Scenario, outputDir: string): Promise<ScenarioResult> => {
  const scenarioDir = path.join(outputDir, safeName(scenario.id));
  await fs.mkdir(scenarioDir, { recursive: true });
  const mailboxBefore = await fetchMailbox();
  const mailboxBeforePath = path.join(scenarioDir, "mailbox-before.json");
  await fs.writeFile(mailboxBeforePath, `${JSON.stringify(mailboxBefore, null, 2)}\n`);
  const ask = await askTurn(scenario, scenarioDir);
  const mailboxAfter = await fetchMailbox();
  const mailboxAfterPath = path.join(scenarioDir, "mailbox-after.json");
  await fs.writeFile(mailboxAfterPath, `${JSON.stringify(mailboxAfter, null, 2)}\n`);
  const result = evaluateScenario({
    scenario,
    ask: ask.ask,
    debugPayload: ask.debugPayload,
    turnId: ask.turnId,
    mailboxBefore: mailboxCounts(mailboxBefore),
    mailboxAfter: mailboxCounts(mailboxAfter),
    scenarioDir,
    mailboxBeforePath,
    askPath: ask.askPath,
    debugPath: ask.debugPath,
    mailboxAfterPath,
  });
  await fs.writeFile(path.join(scenarioDir, "scenario-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
};

const renderMarkdown = (input: {
  runId: string;
  outputDir: string;
  results: ScenarioResult[];
}): string => {
  const lines = [
    "# Live Source Agent Goal Playbook Probe",
    "",
    `- run_id: ${input.runId}`,
    `- base_url: ${BASE_URL}`,
    `- thread_id: ${THREAD_ID}`,
    `- output_dir: ${input.outputDir}`,
    "",
    "## Results",
  ];
  for (const result of input.results) {
    lines.push(
      "",
      `### ${result.verdict} ${result.id}`,
      "",
      `- prompt: ${result.prompt}`,
      `- turn_id: ${result.turnId ?? "none"}`,
      `- target: ${result.selectedTargetSource ?? result.sourceTarget ?? "none"}`,
      `- terminal: ${result.terminalKind ?? "none"}`,
      `- tools: ${result.tools.join(", ") || "none"}`,
      `- decision: ${result.decision ?? "none"}`,
      `- decision_turn_ref: ${String(result.decisionEvidenceHasTurnId)}`,
      `- narrative: ${result.narrativeStateRef ?? "none"}`,
      `- policy: ${result.watchPolicyRef ?? "none"}`,
      `- trajectory.route: ${result.trajectory.route ?? "none"}`,
      `- trajectory.capability: ${result.trajectory.capability ?? "none"}`,
      `- trajectory.mailIds: ${result.trajectory.mailIds.join(", ") || "none"}`,
      `- trajectory.decisionId: ${result.trajectory.decisionId ?? "none"}`,
      `- trajectory.narrativeStateId: ${result.trajectory.narrativeStateId ?? "none"}`,
      `- trajectory.traceId: ${result.trajectory.traceId ?? "none"}`,
      `- trajectory.cycleId: ${result.trajectory.cycleId ?? "none"}`,
      `- trajectory.askTurnId: ${result.trajectory.askTurnId ?? "none"}`,
      `- mailbox_before: ${JSON.stringify(result.mailboxBefore.byStatus)}`,
      `- mailbox_after: ${JSON.stringify(result.mailboxAfter.byStatus)}`,
      `- failures: ${result.failures.length ? result.failures.join("; ") : "none"}`,
      `- warnings: ${result.warnings.length ? result.warnings.join("; ") : "none"}`,
    );
  }
  return `${lines.join("\n")}\n`;
};

const main = async (): Promise<void> => {
  const selected = new Set(SCENARIO_FILTER);
  const scenarios = SCENARIO_FILTER.length
    ? SCENARIOS.filter((scenario) => selected.has(scenario.id))
    : SCENARIOS;
  const missing = SCENARIO_FILTER.filter((id) => !SCENARIOS.some((scenario) => scenario.id === id));
  if (missing.length) throw new Error(`Unknown scenario id(s): ${missing.join(", ")}`);
  const runId = `live-source-playbook-${Date.now()}`;
  const outputDir = path.resolve(OUT_DIR, runId);
  await fs.mkdir(outputDir, { recursive: true });

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    console.log(`[live-source-playbook] running ${scenario.id}`);
    try {
      results.push(await runScenario(scenario, outputDir));
    } catch (error) {
      const scenarioDir = path.join(outputDir, safeName(scenario.id));
      await fs.mkdir(scenarioDir, { recursive: true });
      const result: ScenarioResult = {
        id: scenario.id,
        label: scenario.label,
        prompt: scenario.prompt,
        verdict: "FAIL",
        failures: [error instanceof Error ? error.message : String(error)],
        warnings: [],
        turnId: null,
        answer: null,
        selectedTargetSource: null,
        sourceTarget: null,
        terminalKind: null,
        tools: [],
        decision: null,
        decisionId: null,
        decisionEvidenceHasTurnId: null,
        narrativeStateRef: null,
        watchPolicyRef: null,
        trajectory: {
          route: null,
          capability: null,
          mailIds: [],
          decisionId: null,
          narrativeStateId: null,
          traceId: null,
          cycleId: null,
          askTurnId: null,
        },
        mailboxBefore: { total: 0, byStatus: {}, latestMailId: null, latestPreview: null, policyCount: 0, latestPolicyRef: null, latestDecisionRef: null, unreadCount: 0 },
        mailboxAfter: { total: 0, byStatus: {}, latestMailId: null, latestPreview: null, policyCount: 0, latestPolicyRef: null, latestDecisionRef: null, unreadCount: 0 },
        artifacts: {
          scenarioDir,
          mailboxBeforePath: path.join(scenarioDir, "mailbox-before.json"),
          askPath: path.join(scenarioDir, "ask-response.json"),
          debugPath: null,
          mailboxAfterPath: path.join(scenarioDir, "mailbox-after.json"),
        },
      };
      results.push(result);
      await fs.writeFile(path.join(scenarioDir, "scenario-result.json"), `${JSON.stringify(result, null, 2)}\n`);
    }
  }
  const summary = {
    schema: "helix.live_source_agent_goal_playbook_probe_summary.v1",
    ok: results.every((result) => result.verdict === "PASS" || (!FAIL_ON_WARN && result.verdict === "WARN")),
    passCount: results.filter((result) => result.verdict === "PASS").length,
    warnCount: results.filter((result) => result.verdict === "WARN").length,
    failCount: results.filter((result) => result.verdict === "FAIL").length,
    runId,
    baseUrl: BASE_URL,
    threadId: THREAD_ID,
    outputDir,
    results,
  };
  await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(path.join(outputDir, "summary.md"), renderMarkdown({ runId, outputDir, results }));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
};

main().catch((error) => {
  console.error("[live-source-playbook] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
