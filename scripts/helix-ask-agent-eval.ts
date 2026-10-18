import fs from "node:fs/promises";
import path from "node:path";

type AgentEvalExpectation = {
  clarify?: boolean;
};

type AgentEvalCase = {
  id: string;
  question: string;
  tags?: string[];
  expect?: AgentEvalExpectation;
  session?: string;
};

type AgentEvalPack = {
  name: string;
  cases: AgentEvalCase[];
};

type AgentEvalDebug = {
  arbiter_mode?: string;
  proof_span_rate?: number;
  agent_loop_steps?: number;
  agent_stop_reason?: string;
  agent_loop_actions?: Array<{ action: string }>;
};

type AgentEvalResponse = {
  text?: string;
  report_blocks?: Array<{ mode?: string }>;
  debug?: AgentEvalDebug;
};

type AgentEvalCaseResult = {
  id: string;
  ok: boolean;
  error?: string;
  duration_ms?: number;
  grounded_rate?: number;
  grounded_blocks?: number;
  total_blocks?: number;
  clarify?: boolean;
  expected_clarify?: boolean;
  proof_span_rate?: number;
  agent_loop_steps?: number;
  agent_actions?: string[];
  agent_stop_reason?: string | null;
  tags?: string[];
};

type AgentEvalSummary = {
  pack: string;
  total: number;
  ok: number;
  grounded_rate: number;
  clarify_rate: number;
  clarify_precision?: number;
  clarify_recall?: number;
  proof_span_rate: number;
  avg_duration_ms: number;
  avg_agent_steps: number;
  agent_loop_efficiency: number;
  mixed_prompt_success_rate?: number;
  errors: number;
};

const BASE_URL =
  process.env.HELIX_ASK_AGENT_EVAL_BASE_URL ??
  process.env.HELIX_ASK_BASE_URL ??
  "http://localhost:5173";
const ASK_URL = new URL("/api/agi/ask", BASE_URL).toString();
const REQUEST_TIMEOUT_MS = Number(process.env.HELIX_ASK_AGENT_EVAL_TIMEOUT_MS ?? 180000);
const PACK_PATH = process.env.HELIX_ASK_AGENT_EVAL_PACK ?? "tests/evals/helix-ask-agent.json";
const OUTPUT_PATH = process.env.HELIX_ASK_AGENT_EVAL_OUT ?? "artifacts/helix-ask-agent-eval.json";

const isGroundedMode = (mode?: string): boolean =>
  mode === "repo_grounded" || mode === "hybrid" || mode === "general";

const readJson = async <T>(filePath: string): Promise<T> => {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
};

const resolveSessionId = (
  session: string | undefined,
  runId: string,
  index: number,
  sessionMap: Map<string, string>,
): string => {
  if (!session) return `agent-eval-${runId}-${index}`;
  const existing = sessionMap.get(session);
  if (existing) return existing;
  const resolved = `agent-eval-${runId}-${session}`;
  sessionMap.set(session, resolved);
  return resolved;
};

const fetchCase = async (entry: AgentEvalCase, sessionId: string) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(ASK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: entry.question,
        debug: true,
        sessionId,
        traceId: `agent-eval:${sessionId}:${entry.id}`,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      const text = await response.text();
      return {
        ok: false,
        error: `request failed (${response.status})${text ? `: ${text.slice(0, 240)}` : ""}`,
        durationMs,
      };
    }
    const payload = (await response.json()) as AgentEvalResponse;
    return { ok: true, payload, durationMs };
  } catch (error) {
    clearTimeout(timeout);
    const message =
      (error as { message?: string })?.message ?? (error ? String(error) : "fetch_failed");
    return { ok: false, error: message };
  }
};

const evaluateCase = (
  entry: AgentEvalCase,
  payload: AgentEvalResponse,
  durationMs?: number,
): AgentEvalCaseResult => {
  const reportBlocks = payload.report_blocks ?? [];
  const blockModes = reportBlocks.map((block) => block.mode ?? "");
  const groundedBlocks = blockModes.filter((mode) => isGroundedMode(mode)).length;
  const totalBlocks = blockModes.length;
  const groundedRate =
    totalBlocks > 0
      ? groundedBlocks / totalBlocks
      : isGroundedMode(payload.debug?.arbiter_mode)
        ? 1
        : 0;
  const text = payload.text ?? "";
  const clarify =
    blockModes.includes("clarify") ||
    payload.debug?.arbiter_mode === "clarify" ||
    /please point to the relevant files|narrow the request|clarify/i.test(text);
  const expectedClarify = entry.expect?.clarify === true;
  const proofSpanRate = payload.debug?.proof_span_rate ?? 0;
  const agentSteps = payload.debug?.agent_loop_steps ?? 0;
  const agentActions = payload.debug?.agent_loop_actions?.map((action) => action.action) ?? [];
  const agentStopReason = payload.debug?.agent_stop_reason ?? null;

  return {
    id: entry.id,
    ok: true,
    duration_ms: durationMs,
    grounded_rate: groundedRate,
    grounded_blocks: groundedBlocks,
    total_blocks: totalBlocks,
    clarify,
    expected_clarify: expectedClarify,
    proof_span_rate: proofSpanRate,
    agent_loop_steps: agentSteps,
    agent_actions: agentActions,
    agent_stop_reason: agentStopReason,
    tags: entry.tags ?? [],
  };
};

const main = async () => {
  const packPath = path.resolve(PACK_PATH);
  const pack = await readJson<AgentEvalPack>(packPath);
  if (!pack.cases?.length) {
    throw new Error(`No cases found in ${packPath}`);
  }
  const runId = Date.now().toString(36);
  const sessionMap = new Map<string, string>();
  const results: AgentEvalCaseResult[] = [];
  for (let i = 0; i < pack.cases.length; i += 1) {
    const entry = pack.cases[i];
    const sessionId = resolveSessionId(entry.session, runId, i + 1, sessionMap);
    const response = await fetchCase(entry, sessionId);
    if (!response.ok) {
      results.push({
        id: entry.id,
        ok: false,
        error: response.error ?? "request_failed",
        tags: entry.tags ?? [],
      });
      continue;
    }
    results.push(evaluateCase(entry, response.payload, response.durationMs));
  }

  const okResults = results.filter((result) => result.ok);
  const total = results.length;
  const okCount = okResults.length;
  const groundedRate = okCount
    ? okResults.reduce((sum, result) => sum + (result.grounded_rate ?? 0), 0) / okCount
    : 0;
  const clarifyCount = okResults.filter((result) => result.clarify).length;
  const clarifyRate = okCount ? clarifyCount / okCount : 0;
  const expectedClarifyCount = okResults.filter((result) => result.expected_clarify).length;
  const trueClarifyCount = okResults.filter(
    (result) => result.expected_clarify && result.clarify,
  ).length;
  const clarifyPrecision =
    clarifyCount > 0 ? trueClarifyCount / clarifyCount : undefined;
  const clarifyRecall =
    expectedClarifyCount > 0 ? trueClarifyCount / expectedClarifyCount : undefined;
  const proofSpanRate = okCount
    ? okResults.reduce((sum, result) => sum + (result.proof_span_rate ?? 0), 0) / okCount
    : 0;
  const avgDurationMs = okCount
    ? okResults.reduce((sum, result) => sum + (result.duration_ms ?? 0), 0) / okCount
    : 0;
  const avgAgentSteps = okCount
    ? okResults.reduce((sum, result) => sum + (result.agent_loop_steps ?? 0), 0) / okCount
    : 0;
  const actionsPerGrounded = okResults
    .filter((result) => (result.grounded_blocks ?? 0) > 0)
    .map((result) => (result.agent_loop_steps ?? 0) / (result.grounded_blocks ?? 1));
  const agentLoopEfficiency =
    actionsPerGrounded.length > 0
      ? actionsPerGrounded.reduce((sum, value) => sum + value, 0) / actionsPerGrounded.length
      : 0;
  const mixedCases = okResults.filter((result) => result.tags?.includes("mixed"));
  const mixedSuccesses = mixedCases.filter((result) => (result.grounded_rate ?? 0) >= 0.5);
  const mixedPromptSuccessRate =
    mixedCases.length > 0 ? mixedSuccesses.length / mixedCases.length : undefined;

  const summary: AgentEvalSummary = {
    pack: pack.name ?? path.basename(packPath),
    total,
    ok: okCount,
    grounded_rate: groundedRate,
    clarify_rate: clarifyRate,
    clarify_precision: clarifyPrecision,
    clarify_recall: clarifyRecall,
    proof_span_rate: proofSpanRate,
    avg_duration_ms: avgDurationMs,
    avg_agent_steps: avgAgentSteps,
    agent_loop_efficiency: agentLoopEfficiency,
    mixed_prompt_success_rate: mixedPromptSuccessRate,
    errors: results.filter((result) => !result.ok).length,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(
    OUTPUT_PATH,
    JSON.stringify({ summary, results }, null, 2),
    "utf8",
  );

  console.log("Agent eval summary:");
  console.log(JSON.stringify(summary, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
