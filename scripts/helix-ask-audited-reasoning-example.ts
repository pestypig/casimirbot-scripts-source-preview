import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type AskDebug = Record<string, unknown>;

type AskResponse = {
  status?: number;
  text?: string;
  debug?: AskDebug;
};

type RetrievalQueryRow = {
  objective_id?: string;
  pass_index?: number;
  queries?: string[];
};

type TransitionRow = {
  objective_id?: string;
  from?: string;
  to?: string;
  reason?: string;
  at?: string;
};

const BASE_URL =
  process.env.HELIX_ASK_BASE_URL ??
  process.env.EVAL_BASE_URL ??
  "http://127.0.0.1:5050";

const DEFAULT_PROMPT =
  "What is Needle Hull Mark 2 and how does it relate to Mercury precession?";

const argValues = (flag: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === flag) {
      const value = process.argv[i + 1];
      if (typeof value === "string" && value.trim()) out.push(value.trim());
    }
  }
  return out;
};

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean)
    : [];

const clip = (value: string, max = 600): string => {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max)} ...`;
};

const extractSourcesLine = (text: string): string | null => {
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (/^sources\s*:/i.test(line)) return line;
  }
  return null;
};

const renderList = (entries: string[], empty = "(none)"): string =>
  entries.length > 0 ? entries.map((entry) => `- ${entry}`).join("\n") : `- ${empty}`;

const toRetrievalRows = (value: unknown): RetrievalQueryRow[] =>
  Array.isArray(value) ? value.filter((row) => row && typeof row === "object") as RetrievalQueryRow[] : [];

const toTransitionRows = (value: unknown): TransitionRow[] =>
  Array.isArray(value) ? value.filter((row) => row && typeof row === "object") as TransitionRow[] : [];

const main = async (): Promise<void> => {
  const prompt = argValues("--prompt")[0] ?? DEFAULT_PROMPT;
  const outPathArg = argValues("--out")[0];
  const outPath =
    outPathArg && outPathArg.trim()
      ? outPathArg.trim()
      : "docs/helix-ask-audited-reasoning-example.md";
  const traceId = `ask:audited-reasoning:${crypto.randomUUID()}`;

  const response = await fetch(`${BASE_URL.replace(/\/$/, "")}/api/agi/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      question: prompt,
      debug: true,
      traceId,
    }),
  });

  let payload: AskResponse = {};
  try {
    payload = (await response.json()) as AskResponse;
  } catch {
    payload = {};
  }

  const debugObj = (asObject(payload.debug) ?? {}) as AskDebug;
  const answerText = typeof payload.text === "string" ? payload.text : "";

  const retrievalRows = toRetrievalRows(debugObj.objective_retrieval_queries);
  const transitionRows = toTransitionRows(debugObj.objective_transition_log);
  const reasoningSidebarObj = asObject(debugObj.reasoning_sidebar);
  const reasoningSidebarMarkdown =
    asString(debugObj.reasoning_sidebar_markdown) ??
    asString(reasoningSidebarObj?.markdown) ??
    "";
  const reasoningSidebarEventClock = Array.isArray(reasoningSidebarObj?.event_clock)
    ? (reasoningSidebarObj?.event_clock as Array<Record<string, unknown>>)
        .slice(-12)
        .map((entry) => {
          const idx = asNumber(entry.idx);
          const ts = asString(entry.ts) ?? "n/a";
          const stage = asString(entry.stage) ?? "unknown";
          const detail = asString(entry.detail);
          const ok =
            typeof entry.ok === "boolean" ? String(entry.ok) : entry.ok == null ? "null" : "n/a";
          const duration = asNumber(entry.duration_ms);
          return `[${idx ?? "?"}] ${ts} | ${stage} | ok=${ok}${
            duration != null ? ` | ${duration}ms` : ""
          }${detail ? ` | ${clip(detail, 120)}` : ""}`;
        })
    : [];

  const retrievalPromptLines = retrievalRows
    .flatMap((row) =>
      asStringArray(row.queries).map(
        (query) =>
          `objective=${asString(row.objective_id) ?? "unknown"} pass=${String(row.pass_index ?? "n/a")} query=${query}`,
      ),
    )
    .slice(0, 20);

  const transitionLines = transitionRows
    .map((row) => {
      const objectiveId = asString(row.objective_id) ?? "unknown";
      const from = asString(row.from) ?? "unknown";
      const to = asString(row.to) ?? "unknown";
      const reason = asString(row.reason) ?? "unknown";
      return `${objectiveId}: ${from} -> ${to} (${reason})`;
    })
    .slice(0, 24);

  const objectiveLabels = Array.isArray(debugObj.objective_loop_state)
    ? (debugObj.objective_loop_state as Array<Record<string, unknown>>)
        .map((row) => asString(row.objective_label))
        .filter((row): row is string => Boolean(row))
        .slice(0, 12)
    : [];

  const miniCriticPromptPreview = asString(debugObj.objective_mini_critic_prompt_preview) ?? "";
  const assemblyPromptPreview = asString(debugObj.objective_assembly_prompt_preview) ?? "";
  const assemblyRescuePromptPreview =
    asString(debugObj.objective_assembly_rescue_prompt_preview) ?? "";

  const markdown = [
    "# Helix Ask Audited Reasoning Example",
    "",
    "## Session",
    `- timestamp: ${new Date().toISOString()}`,
    `- base_url: ${BASE_URL}`,
    `- trace_id: ${traceId}`,
    `- http_status: ${response.status}`,
    `- objective_loop_patch_revision: ${asString(debugObj.objective_loop_patch_revision) ?? "n/a"}`,
    "",
    "## Debug Sidebar (Native)",
    `- reasoning_sidebar_enabled: ${String(asBoolean(debugObj.reasoning_sidebar_enabled))}`,
    `- reasoning_sidebar_step_count: ${String(asNumber(debugObj.reasoning_sidebar_step_count))}`,
    `- reasoning_sidebar_event_count: ${String(asNumber(debugObj.reasoning_sidebar_event_count))}`,
    "```markdown",
    reasoningSidebarMarkdown || "(no reasoning sidebar markdown in debug)",
    "```",
    "",
    "### Event Clock Preview",
    renderList(reasoningSidebarEventClock, "(no event_clock entries)"),
    "",
    "## User Prompt",
    `- ${prompt}`,
    "",
    "## Step 1: Routing + Policy",
    `- intent_domain: ${asString(debugObj.intent_domain) ?? "n/a"}`,
    `- policy_prompt_family: ${asString(debugObj.policy_prompt_family) ?? "n/a"}`,
    `- objective_finalize_gate_mode: ${asString(debugObj.objective_finalize_gate_mode) ?? "n/a"}`,
    `- objective_assembly_mode: ${asString(debugObj.objective_assembly_mode) ?? "n/a"}`,
    `- objective_assembly_rescue_attempted: ${String(asBoolean(debugObj.objective_assembly_rescue_attempted))}`,
    `- objective_assembly_rescue_success: ${String(asBoolean(debugObj.objective_assembly_rescue_success))}`,
    "",
    "## Step 2: Planner Objectives",
    renderList(objectiveLabels, "(no objective labels in debug)"),
    "",
    "## Step 3: Retrieval Step Prompts (Queries)",
    renderList(retrievalPromptLines, "(no objective retrieval query prompts recorded)"),
    "",
    "## Step 4: Objective State Transitions",
    renderList(transitionLines, "(no objective transitions recorded)"),
    "",
    "## Step 5: Mini-Critic Prompt (LLM)",
    "```text",
    miniCriticPromptPreview || "(no mini-critic prompt preview in debug)",
    "```",
    "",
    "## Step 6: Assembly Prompt (LLM)",
    "```text",
    assemblyPromptPreview || "(no primary assembly prompt preview in debug)",
    "```",
    "",
    "## Step 7: Assembly Rescue Prompt (LLM)",
    "```text",
    assemblyRescuePromptPreview || "(no rescue assembly prompt preview in debug)",
    "```",
    "",
    "## Step 8: Final Answer Output",
    "```text",
    answerText || "(no answer text)",
    "```",
    "",
    "## Sources Line",
    `- ${extractSourcesLine(answerText) ?? "(none in final answer text)"}`,
    "",
    "## Audit Snapshot",
    "```json",
    JSON.stringify(
      {
        objective_loop_enabled: asBoolean(debugObj.objective_loop_enabled),
        objective_total_count: asNumber(debugObj.objective_total_count),
        objective_unresolved_count: asNumber(debugObj.objective_unresolved_count),
        objective_mini_critic_mode: asString(debugObj.objective_mini_critic_mode),
        objective_unknown_block_count: asNumber(debugObj.objective_unknown_block_count),
        routing_salvage_applied: asBoolean(debugObj.routing_salvage_applied),
        routing_salvage_reason: asString(debugObj.routing_salvage_reason),
        routing_salvage_retrieval_added_count: asNumber(
          debugObj.routing_salvage_retrieval_added_count,
        ),
        routing_salvage_pre_eligible: asBoolean(debugObj.routing_salvage_pre_eligible),
        routing_salvage_anchor_cue: asBoolean(debugObj.routing_salvage_anchor_cue),
        routing_salvage_objective_cue: asBoolean(debugObj.routing_salvage_objective_cue),
      },
      null,
      2,
    ),
    "```",
    "",
  ].join("\n");

  const absoluteOutPath = path.resolve(process.cwd(), outPath);
  await fs.mkdir(path.dirname(absoluteOutPath), { recursive: true });
  await fs.writeFile(absoluteOutPath, markdown, "utf8");

  console.log(`wrote ${absoluteOutPath}`);
  console.log(`trace_id=${traceId}`);
  console.log(`intent_domain=${asString(debugObj.intent_domain) ?? "n/a"} policy_family=${asString(debugObj.policy_prompt_family) ?? "n/a"}`);
  console.log(`assembly=${asString(debugObj.objective_assembly_mode) ?? "n/a"} rescue=${String(asBoolean(debugObj.objective_assembly_rescue_success))}`);
  console.log(`salvage=${String(asBoolean(debugObj.routing_salvage_applied))} pre_eligible=${String(asBoolean(debugObj.routing_salvage_pre_eligible))}`);
  console.log(`answer_preview=${clip(answerText, 240)}`);
};

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
