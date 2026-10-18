import fs from "node:fs/promises";
import path from "node:path";

type AskTurnResponse = {
  turn_id?: string;
  selected_final_answer?: string;
  finalAnswer?: string;
  answer?: string;
  route_reason_code?: string;
  terminal_artifact_kind?: string;
  terminal_error_code?: string | null;
};

const BASE_URL = (process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:5050").replace(/\/+$/, "");
const SESSION_ID = process.env.HELIX_ASK_TOP_DEBUG_SESSION ?? "helix-ask:desktop";
const OUT_DIR = process.env.HELIX_ASK_TOP_DEBUG_OUT ?? "artifacts/helix-ask-top-debug-smoke";
const TIMEOUT_MS = Math.max(1000, Number(process.env.HELIX_ASK_TOP_DEBUG_TIMEOUT_MS ?? 180_000));
const SCENARIO = process.env.HELIX_ASK_TOP_DEBUG_SCENARIO ?? "active_run_with_unbound_visual_source";

const DEFAULT_PROMPTS = [
  "Okay, can you review what is happening right now in the visual screen capture?",
  "Okay, what are we looking at now and how does it compare to the last scene epoch?",
  "Can you open up the scientific calculator panel?",
];

const prompts = (process.env.HELIX_ASK_TOP_DEBUG_PROMPTS ?? "")
  .split("||")
  .map((entry) => entry.trim())
  .filter(Boolean);

const promptList = prompts.length ? prompts : DEFAULT_PROMPTS;

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
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timeout);
  }
};

const getPath = (value: unknown, pathParts: string[]): unknown =>
  pathParts.reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const debugSummaryFor = (debug: Record<string, unknown> | null): Record<string, unknown> => {
  const payload = ((debug?.payload && typeof debug.payload === "object") ? debug.payload : debug) as Record<string, unknown> | null;
  if (!payload) return {};
  const preflight = getPath(payload, ["ask_turn_preflight_context"]) ?? {};
  const context =
    getPath(payload, ["canonical_goal_frame"]) ? getPath(preflight, ["active_situation_context"]) : undefined;
  const activeContext =
    context && typeof context === "object"
      ? context
      : getPath(payload, ["current_turn_artifact_ledger"]) ?? null;
  const preflightActiveContext = getPath(preflight, ["active_situation_context"]);
  const preflightSelection = getPath(preflight, ["situation_evidence_selection"]);
  const ledger = asArray(getPath(payload, ["current_turn_artifact_ledger"]));
  const selectionFromLedger = ledger
    .map((entry) => getPath(entry, ["payload"]))
    .find((entry) => getPath(entry, ["schema"]) === "helix.situation_evidence_selection.v1");
  const windowFromLedger = ledger
    .map((entry) => getPath(entry, ["payload"]))
    .find((entry) => getPath(entry, ["schema"]) === "helix.live_context_window_binding.v1");
  const selectedSelection = preflightSelection ?? selectionFromLedger;
  const selectedContext = preflightActiveContext ?? activeContext;
  const watermarks = asArray(getPath(windowFromLedger, ["source_watermarks"])).map((entry) => ({
    source_id: getPath(entry, ["source_id"]),
    stale: getPath(entry, ["stale"]),
    freshness_ms: getPath(entry, ["freshness_ms"]),
  }));
  return {
    active_context_status: getPath(selectedContext, ["status"]) ?? null,
    situation_run_id: getPath(selectedContext, ["situation_run_id"]) ?? null,
    environment_id: getPath(selectedContext, ["environment_id"]) ?? null,
    answerable: getPath(selectedSelection, ["answerable"]) ?? null,
    answerability_reason: getPath(selectedSelection, ["answerability_reason"]) ?? null,
    selected_sources: getPath(selectedSelection, ["selected_source_refs"]) ?? [],
    selected_observations: getPath(selectedSelection, ["selected_observation_refs"]) ?? [],
    selected_field_evaluations: getPath(selectedSelection, ["selected_field_evaluation_refs"]) ?? [],
    rejected_unbound_sources: getPath(selectedSelection, ["rejected_unbound_source_refs"]) ?? [],
    exclusion_reasons: getPath(selectedSelection, ["exclusion_reasons"]) ?? [],
    window_included_observations: getPath(windowFromLedger, ["included_observation_refs"]) ?? [],
    window_source_watermarks: watermarks,
    poison_ok: getPath(payload, ["poison_audit", "ok"]) ?? null,
    terminal_authority: getPath(payload, ["terminal_answer_authority", "terminal_artifact_kind"]) ?? null,
    route_authority_ok: getPath(payload, ["route_authority_audit", "route_authority_ok"]) ?? null,
    route_authority_violation_code: getPath(payload, ["route_authority_audit", "route_authority_violation_code"]) ?? null,
    route_authority_violation_codes: getPath(payload, ["route_authority_audit", "violation_codes"]) ?? [],
    loop_trace_present: getPath(payload, ["loop_parity_trace", "schema"]) === "helix.loop_parity_trace.v1",
    loop_selected_route: getPath(payload, ["loop_parity_trace", "selected_route"]) ?? null,
    loop_admitted_tool_families: getPath(payload, ["loop_parity_trace", "admitted_tool_families"]) ?? [],
    loop_actual_tool_calls: getPath(payload, ["loop_parity_trace", "actual_tool_calls"]) ?? [],
    loop_unexpected_tool_calls: getPath(payload, ["loop_parity_trace", "unexpected_tool_calls"]) ?? [],
    loop_short_circuit_risk_flags: getPath(payload, ["loop_parity_trace", "short_circuit_risk_flags"]) ?? [],
    poison_clean_but_authority_failed:
      getPath(payload, ["poison_audit", "ok"]) === true &&
      getPath(payload, ["route_authority_audit", "route_authority_ok"]) === false,
  };
};

const renderMarkdownSummary = (input: {
  runId: string;
  baseUrl: string;
  scenario: string;
  seed: Record<string, unknown>;
  summary: Array<Record<string, unknown>>;
}): string => {
  const lines = [
    `# Helix Ask Top Debug Smoke`,
    ``,
    `- run_id: ${input.runId}`,
    `- base_url: ${input.baseUrl}`,
    `- scenario: ${input.scenario}`,
    `- seed_schema: ${input.seed.schema ?? "unknown"}`,
    ``,
    `## Turns`,
  ];
  for (const entry of input.summary) {
    lines.push(
      ``,
      `### ${entry.index}. ${entry.question}`,
      ``,
      `- ok: ${entry.ok}`,
      `- route: ${entry.route_reason_code ?? "unknown"}`,
      `- terminal: ${entry.terminal_artifact_kind ?? "unknown"}${entry.terminal_error_code ? ` (${entry.terminal_error_code})` : ""}`,
      `- final: ${String(entry.final_answer ?? "").replace(/\s+/g, " ").slice(0, 260)}`,
    );
    const debug = entry.debug_summary as Record<string, unknown> | undefined;
    if (debug) {
      lines.push(
        `- active_context_status: ${debug.active_context_status}`,
        `- answerable: ${debug.answerable}`,
        `- selected_sources: ${JSON.stringify(debug.selected_sources ?? [])}`,
        `- selected_observations: ${JSON.stringify(debug.selected_observations ?? [])}`,
        `- rejected_unbound_sources: ${JSON.stringify(debug.rejected_unbound_sources ?? [])}`,
        `- exclusion_reasons: ${JSON.stringify(debug.exclusion_reasons ?? [])}`,
        `- source_watermarks: ${JSON.stringify(debug.window_source_watermarks ?? [])}`,
        `- poison_ok: ${debug.poison_ok}`,
        `- route_authority_ok: ${debug.route_authority_ok}`,
        `- route_authority_violation_codes: ${JSON.stringify(debug.route_authority_violation_codes ?? [])}`,
        `- loop_trace_present: ${debug.loop_trace_present}`,
        `- loop_admitted_tool_families: ${JSON.stringify(debug.loop_admitted_tool_families ?? [])}`,
        `- loop_actual_tool_calls: ${JSON.stringify(debug.loop_actual_tool_calls ?? [])}`,
        `- loop_unexpected_tool_calls: ${JSON.stringify(debug.loop_unexpected_tool_calls ?? [])}`,
        `- loop_short_circuit_risk_flags: ${JSON.stringify(debug.loop_short_circuit_risk_flags ?? [])}`,
      );
    }
    if (entry.error) lines.push(`- error: ${entry.error}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
};

const main = async (): Promise<void> => {
  const runId = `top-debug-${Date.now()}`;
  const outputDir = path.resolve(OUT_DIR, runId);
  await fs.mkdir(outputDir, { recursive: true });

  const seed = await fetchJson<Record<string, unknown>>(`${BASE_URL}/api/agi/situation/test-harness/live-visual-source`, {
    method: "POST",
    body: JSON.stringify({
      scenario: SCENARIO,
      thread_id: SESSION_ID,
      source_id: "visual_source:top-debug-smoke",
      bound_source_id: "visual_source:top-debug-bound-seed",
      unbound_source_id: "visual_source:top-debug-fresh-capture",
      scene_text: "A backend-seeded visual capture shows File Explorer open to a research folder.",
      unbound_scene_text: "A fresh visual capture shows the Helix Ask UI with worker-lane debug output and a command prompt log panel.",
      activity: "Reviewing a research folder in File Explorer.",
      objects: "File Explorer window, research folder, visible file list.",
    }),
  });
  await fs.writeFile(path.join(outputDir, "00-seed-live-visual-source.json"), `${JSON.stringify(seed, null, 2)}\n`);

  const summary: Array<Record<string, unknown>> = [];
  for (const [index, question] of promptList.entries()) {
    const prefix = String(index + 1).padStart(2, "0");
    try {
      const ask = await fetchJson<AskTurnResponse>(`${BASE_URL}/api/agi/ask/turn`, {
        method: "POST",
        body: JSON.stringify({
          sessionId: SESSION_ID,
          question,
          mode: "read",
          debug: true,
        }),
      });
      const turnId = ask.turn_id;
      const debug = turnId
        ? await fetchJson<Record<string, unknown>>(`${BASE_URL}/api/agi/ask/turn/${encodeURIComponent(turnId)}/debug-export`)
        : null;
      const perTurnDebugSummary = debugSummaryFor(debug);
      await fs.writeFile(path.join(outputDir, `${prefix}-ask-response.json`), `${JSON.stringify(ask, null, 2)}\n`);
      await fs.writeFile(path.join(outputDir, `${prefix}-debug-export.json`), `${JSON.stringify(debug, null, 2)}\n`);
      await fs.writeFile(path.join(outputDir, `${prefix}-debug-summary.json`), `${JSON.stringify(perTurnDebugSummary, null, 2)}\n`);
      summary.push({
        index: index + 1,
        question,
        ok: true,
        turn_id: turnId ?? null,
        route_reason_code: ask.route_reason_code ?? null,
        terminal_artifact_kind: ask.terminal_artifact_kind ?? null,
        terminal_error_code: ask.terminal_error_code ?? null,
        final_answer: ask.selected_final_answer ?? ask.finalAnswer ?? ask.answer ?? null,
        debug_summary: perTurnDebugSummary,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorPayload = { index: index + 1, question, ok: false, error: message };
      await fs.writeFile(path.join(outputDir, `${prefix}-error.json`), `${JSON.stringify(errorPayload, null, 2)}\n`);
      summary.push(errorPayload);
    }
  }

  await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify({ run_id: runId, base_url: BASE_URL, scenario: SCENARIO, seed, summary }, null, 2)}\n`);
  await fs.writeFile(path.join(outputDir, "summary.md"), renderMarkdownSummary({
    runId,
    baseUrl: BASE_URL,
    scenario: SCENARIO,
    seed,
    summary,
  }));
  console.log(JSON.stringify({ ok: true, run_id: runId, output_dir: outputDir, summary }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
