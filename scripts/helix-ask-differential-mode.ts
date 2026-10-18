import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type CorpusPrompt = {
  id: string;
  question: string;
  expect?: {
    intent_domain?: string;
    intent_id?: string;
    require_sources?: boolean;
  };
  tags?: string[];
};

type Corpus = {
  version: string;
  prompts: CorpusPrompt[];
};

type AskDebug = Record<string, unknown> & {
  intent_id?: string;
  intent_domain?: string;
  objective_count?: number;
  objective_finalize_gate_mode?: string;
  objective_finalize_gate_passed?: boolean;
  objective_coverage_unresolved_count?: number;
  objective_unknown_block_count?: number;
  objective_unresolved_without_unknown_block_count?: number;
  objective_assembly_blocked_reason?: string | null;
  answer_obligations_missing?: unknown[];
  objective_loop_patch_revision?: string;
  stage05_used?: boolean;
  context_files?: unknown[];
  live_events?: unknown[];
  trace_events?: unknown[];
  reasoning_sidebar_enabled?: boolean;
  reasoning_sidebar_step_count?: number;
  reasoning_sidebar_event_count?: number;
  event_journal?: Record<string, unknown>;
  objective_recovery_no_context_retryable_count?: number;
  objective_recovery_no_context_terminal_count?: number;
  objective_recovery_error_retryable_count?: number;
  objective_recovery_error_terminal_count?: number;
  objective_scoped_retrieval_recovery_no_context_retryable_count?: number;
  objective_scoped_retrieval_recovery_no_context_terminal_count?: number;
  objective_scoped_retrieval_recovery_error_retryable_count?: number;
  objective_scoped_retrieval_recovery_error_terminal_count?: number;
};

type AskResponse = {
  text?: string;
  debug?: AskDebug;
};

type Divergence = {
  code: string;
  severity: "major" | "minor";
  detail: string;
};

type CheckRow = {
  id: string;
  pass: boolean;
};

type PromptResult = {
  id: string;
  question: string;
  tags: string[];
  score: number;
  grade: "aligned" | "mostly_aligned" | "partial" | "divergent";
  checks: CheckRow[];
  divergences: Divergence[];
  debug: {
    intent_domain: string | null;
    intent_id: string | null;
    objective_finalize_gate_mode: string | null;
    objective_finalize_gate_passed: boolean | null;
    objective_coverage_unresolved_count: number | null;
    objective_unknown_block_count: number | null;
    objective_unresolved_without_unknown_block_count: number | null;
    objective_assembly_blocked_reason: string | null;
    answer_obligations_missing_count: number;
    objective_loop_patch_revision: string | null;
    stage05_used: boolean | null;
    context_file_count: number;
    retrieval_error_count: number;
    retrieval_error_label_rate: number | null;
    reasoning_sidebar_enabled: boolean | null;
    reasoning_sidebar_step_count: number | null;
    reasoning_sidebar_event_count: number | null;
    event_journal_deterministic: boolean | null;
  };
  text_preview: string;
};

type RunSummary = {
  schema_version: "helix_ask_differential_mode/1";
  run_id: string;
  generated_at: string;
  base_url: string;
  corpus_path: string;
  corpus_version: string;
  prompt_count: number;
  major_divergence_prompt_count: number;
  pass_without_major_count: number;
  pass_without_major_rate: number;
  average_score: number;
  grade_counts: Record<string, number>;
  divergence_counts: Record<string, number>;
  artifacts: {
    output_dir: string;
    results_json: string;
    summary_json: string;
    report_md: string;
  };
  results: PromptResult[];
};

const DEFAULT_BASE_URL =
  process.env.HELIX_ASK_BASE_URL ?? process.env.EVAL_BASE_URL ?? "http://127.0.0.1:5050";
const DEFAULT_CORPUS_PATH = "configs/helix-ask-differential-corpus.v1.json";
const DEFAULT_OUT_ROOT = "artifacts/experiments/helix-ask-differential-mode";
const DEFAULT_TIMEOUT_MS = Math.max(1000, Number(process.env.HELIX_ASK_DIFF_TIMEOUT_MS ?? 70000));
const DEFAULT_EXPECTED_PATCH_REVISION =
  process.env.HELIX_ASK_OBJECTIVE_LOOP_EXPECTED_PATCH_REVISION ??
  "2026-03-23-objective-loop-final-resolution-v3";

const argValue = (flag: string): string | null => {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
};

const toObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const toArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const toStringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const toBoolOrNull = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const toNumberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const firstFiniteNumber = (values: unknown[]): number | null => {
  for (const value of values) {
    const parsed = toNumberOrNull(value);
    if (parsed !== null) return parsed;
  }
  return null;
};

const seedFromString = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const shuffleWithSeed = <T>(items: T[], seed: number): T[] => {
  const rng = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

const fetchAsk = async (
  baseUrl: string,
  question: string,
  sessionId: string,
  timeoutMs: number,
): Promise<{ status: number; payload: AskResponse; text: string }> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/agi/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        question,
        debug: true,
        verbosity: "extended",
        sessionId,
        max_tokens: 512,
        temperature: 0.2,
      }),
    });
    const rawText = await response.text();
    let payload: AskResponse = {};
    try {
      payload = (rawText ? JSON.parse(rawText) : {}) as AskResponse;
    } catch {
      payload = {};
    }
    return { status: response.status, payload, text: rawText };
  } finally {
    clearTimeout(timeout);
  }
};

const normalizePreview = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 280);

const gradeFromScore = (score: number): PromptResult["grade"] => {
  if (score >= 0.9) return "aligned";
  if (score >= 0.75) return "mostly_aligned";
  if (score >= 0.5) return "partial";
  return "divergent";
};

const evaluatePrompt = (prompt: CorpusPrompt, payload: AskResponse): PromptResult => {
  const text = String(payload.text ?? "");
  const debug = payload.debug ?? {};
  const checks: CheckRow[] = [];
  const divergences: Divergence[] = [];
  const addDivergence = (code: string, severity: Divergence["severity"], detail: string): void => {
    divergences.push({ code, severity, detail });
  };
  const registerCheck = (id: string, pass: boolean): void => {
    checks.push({ id, pass });
  };

  // 1) Strict terminal contract.
  const placeholderPatterns = [
    /^objective:\s/i,
    /\bkeep existing draft as-is\b/i,
    /\bplan_initialized\b/i,
    /\bReturn strict JSON only\b/i,
    /\bNo markdown\. No commentary\./i,
  ];
  const shortText = text.trim().length < 40;
  const placeholderHit = placeholderPatterns.some((pattern) => pattern.test(text));
  const strictTerminalPass = !shortText && !placeholderHit;
  registerCheck("strict_terminal_contract", strictTerminalPass);
  if (shortText) addDivergence("answer_too_short", "major", `answer length ${text.trim().length} < 40`);
  if (placeholderHit) addDivergence("placeholder_answer", "major", "final answer contains placeholder/procedural residue");

  // 2) Plan/answer separation.
  const planLeakPatterns = [
    /\bobjective checkpoints?\b/i,
    /\bstatus=partial\b/i,
    /\bmissing_slots?\b/i,
    /\bobjective_id\b/i,
    /\btraceId=ask:/i,
    /\bReasoning Sidebar\b/i,
  ];
  const planLeakHits = planLeakPatterns.filter((pattern) => pattern.test(text)).length;
  const separationPass = planLeakHits === 0;
  registerCheck("plan_answer_separation", separationPass);
  if (!separationPass) {
    addDivergence("plan_artifact_leak", "major", `detected ${planLeakHits} planner/debug token pattern hits in final text`);
  }

  // 3) Intent alignment.
  const observedIntentDomain = toStringOrNull(debug.intent_domain);
  const observedIntentId = toStringOrNull(debug.intent_id);
  let intentPass = true;
  if (prompt.expect?.intent_domain && observedIntentDomain !== prompt.expect.intent_domain) {
    intentPass = false;
    addDivergence(
      "intent_domain_mismatch",
      "major",
      `expected ${prompt.expect.intent_domain}, got ${observedIntentDomain ?? "missing"}`,
    );
  }
  if (prompt.expect?.intent_id && observedIntentId !== prompt.expect.intent_id) {
    intentPass = false;
    addDivergence(
      "intent_id_mismatch",
      "minor",
      `expected ${prompt.expect.intent_id}, got ${observedIntentId ?? "missing"}`,
    );
  }
  registerCheck("intent_alignment", intentPass);

  // 4) Objective + mode/gate consistency.
  const finalizeMode = toStringOrNull(debug.objective_finalize_gate_mode);
  const finalizePassed = toBoolOrNull(debug.objective_finalize_gate_passed);
  const objectiveCoverageUnresolved = toNumberOrNull(debug.objective_coverage_unresolved_count);
  const unknownBlockCount = toNumberOrNull(debug.objective_unknown_block_count);
  const unresolvedNoUnknown = toNumberOrNull(debug.objective_unresolved_without_unknown_block_count);
  const blockedReason = toStringOrNull(debug.objective_assembly_blocked_reason);
  const obligationsMissing = Array.isArray(debug.answer_obligations_missing)
    ? debug.answer_obligations_missing.length
    : 0;
  let gatePass = true;
  if (finalizeMode === "strict_covered") {
    if (finalizePassed !== true) {
      gatePass = false;
      addDivergence("strict_covered_without_pass", "major", "finalize mode strict_covered but gate not passed");
    }
    if ((objectiveCoverageUnresolved ?? 0) > 0) {
      gatePass = false;
      addDivergence(
        "strict_covered_with_unresolved",
        "major",
        `strict_covered with objective_coverage_unresolved_count=${objectiveCoverageUnresolved}`,
      );
    }
    if (obligationsMissing > 0) {
      gatePass = false;
      addDivergence("strict_covered_with_missing_obligations", "major", `missing obligations=${obligationsMissing}`);
    }
    if (blockedReason) {
      gatePass = false;
      addDivergence("strict_covered_with_blocked_assembly", "major", `blocked_reason=${blockedReason}`);
    }
  }
  if ((finalizeMode === "unknown_terminal" || finalizeMode === "blocked") && finalizePassed === true) {
    gatePass = false;
    addDivergence("terminal_mode_marked_pass", "major", `mode=${finalizeMode} with finalize_gate_passed=true`);
  }
  if ((unresolvedNoUnknown ?? 0) > 0) {
    gatePass = false;
    addDivergence(
      "unresolved_without_unknown_block",
      "major",
      `objective_unresolved_without_unknown_block_count=${unresolvedNoUnknown}`,
    );
  }
  registerCheck("mode_gate_consistency", gatePass);

  // 5) Recovery semantics + event labels.
  const eventRowsRaw = [...toArray(debug.live_events), ...toArray(debug.trace_events)]
    .map((entry) => toObject(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  const eventRows: Record<string, unknown>[] = [];
  const eventKeys = new Set<string>();
  for (const entry of eventRowsRaw) {
    const key = [
      String(entry.ts ?? ""),
      String(entry.stage ?? ""),
      String(entry.detail ?? ""),
      String(entry.ok ?? ""),
      String(entry.text ?? ""),
    ].join("|");
    if (eventKeys.has(key)) continue;
    eventKeys.add(key);
    eventRows.push(entry);
  }
  const retrievalRows = eventRows.filter((entry) => {
    const stage = String(entry.stage ?? "");
    return stage.toLowerCase().includes("retrieval objective-recovery");
  });
  const retrievalErrorRows = retrievalRows.filter((entry) => entry.ok === false);
  const retrievalEventErrors = retrievalErrorRows.filter((entry) => String(entry.tool ?? "") === "helix.ask.event");
  const retrievalErrors = retrievalEventErrors.length > 0 ? retrievalEventErrors : retrievalErrorRows;
  const labeledErrors = retrievalErrors.filter((entry) => {
    const surface = `${String(entry.detail ?? "")} ${String(entry.text ?? "")}`;
    return /\bretryable\b/i.test(surface) || /\bterminal\b/i.test(surface);
  });
  const telemetryNoContextRetryable =
    firstFiniteNumber([
      debug.objective_scoped_retrieval_recovery_no_context_retryable_count,
      debug.objective_recovery_no_context_retryable_count,
    ]) ?? 0;
  const telemetryNoContextTerminal =
    firstFiniteNumber([
      debug.objective_scoped_retrieval_recovery_no_context_terminal_count,
      debug.objective_recovery_no_context_terminal_count,
    ]) ?? 0;
  const telemetryErrorRetryable =
    firstFiniteNumber([
      debug.objective_scoped_retrieval_recovery_error_retryable_count,
      debug.objective_recovery_error_retryable_count,
    ]) ?? 0;
  const telemetryErrorTerminal =
    firstFiniteNumber([
      debug.objective_scoped_retrieval_recovery_error_terminal_count,
      debug.objective_recovery_error_terminal_count,
    ]) ?? 0;
  const telemetryLabeledTotal = Math.max(
    0,
    telemetryNoContextRetryable + telemetryNoContextTerminal + telemetryErrorRetryable + telemetryErrorTerminal,
  );
  const effectiveLabeledErrors = Math.max(
    labeledErrors.length,
    Math.min(retrievalErrors.length, telemetryLabeledTotal),
  );
  let recoveryPass = true;
  if (retrievalErrors.length > 0 && effectiveLabeledErrors !== retrievalErrors.length) {
    recoveryPass = false;
    addDivergence(
      "retrieval_error_unlabeled",
      "minor",
      `retrieval errors with retryable|terminal labels: ${effectiveLabeledErrors}/${retrievalErrors.length}`,
    );
  }
  if ((objectiveCoverageUnresolved ?? 0) > 0 && (unknownBlockCount ?? 0) <= 0) {
    recoveryPass = false;
    addDivergence(
      "coverage_unresolved_without_unknown",
      "major",
      `objective_coverage_unresolved_count=${objectiveCoverageUnresolved}, objective_unknown_block_count=${unknownBlockCount ?? 0}`,
    );
  }
  registerCheck("recovery_semantics", recoveryPass);

  // 6) Deterministic UI/event visibility.
  const sidebarEnabled = toBoolOrNull(debug.reasoning_sidebar_enabled);
  const sidebarSteps = toNumberOrNull(debug.reasoning_sidebar_step_count);
  const sidebarEvents = toNumberOrNull(debug.reasoning_sidebar_event_count);
  const journalDeterministic = toBoolOrNull(toObject(debug.event_journal)?.deterministic);
  let deterministicPass = true;
  if (sidebarEnabled !== true) {
    deterministicPass = false;
    addDivergence("reasoning_sidebar_disabled", "minor", "reasoning_sidebar_enabled is not true");
  }
  if ((sidebarSteps ?? 0) <= 0 || (sidebarEvents ?? 0) <= 0) {
    deterministicPass = false;
    addDivergence(
      "reasoning_sidebar_empty",
      "minor",
      `step_count=${sidebarSteps ?? "missing"}, event_count=${sidebarEvents ?? "missing"}`,
    );
  }
  if (journalDeterministic === false) {
    deterministicPass = false;
    addDivergence("event_journal_nondeterministic", "major", "event_journal.deterministic=false");
  }
  registerCheck("deterministic_event_mapping", deterministicPass);

  // 7) Repo grounding and sources (when expected).
  const requireSources =
    prompt.expect?.require_sources === true ||
    prompt.expect?.intent_domain === "repo" ||
    prompt.expect?.intent_domain === "hybrid";
  let groundingPass = true;
  if (requireSources) {
    if (!/\bsources:\s*/i.test(text)) {
      groundingPass = false;
      addDivergence("missing_sources_line", "major", "repo/hybrid prompt returned answer without Sources line");
    }
    const stage05Used = toBoolOrNull(debug.stage05_used);
    const contextFileCount = toArray(debug.context_files).length;
    if (stage05Used !== true && contextFileCount <= 0) {
      groundingPass = false;
      addDivergence("missing_repo_grounding_signals", "major", "stage05_used!=true and context_files empty");
    }
  }
  registerCheck("repo_grounding_expectations", groundingPass);

  // 8) Objective-loop patch revision consistency.
  const patchRevision = toStringOrNull(debug.objective_loop_patch_revision);
  const revisionPass =
    patchRevision === null ||
    patchRevision === "" ||
    patchRevision === DEFAULT_EXPECTED_PATCH_REVISION;
  registerCheck("patch_revision_alignment", revisionPass);
  if (!revisionPass) {
    addDivergence(
      "patch_revision_mismatch",
      "minor",
      `objective_loop_patch_revision=${patchRevision} expected=${DEFAULT_EXPECTED_PATCH_REVISION}`,
    );
  }

  const passedChecks = checks.filter((check) => check.pass).length;
  const score = checks.length > 0 ? Number((passedChecks / checks.length).toFixed(4)) : 0;
  const grade = gradeFromScore(score);

  return {
    id: prompt.id,
    question: prompt.question,
    tags: Array.isArray(prompt.tags) ? prompt.tags.map((item) => String(item)) : [],
    score,
    grade,
    checks,
    divergences,
    debug: {
      intent_domain: observedIntentDomain,
      intent_id: observedIntentId,
      objective_finalize_gate_mode: finalizeMode,
      objective_finalize_gate_passed: finalizePassed,
      objective_coverage_unresolved_count: objectiveCoverageUnresolved,
      objective_unknown_block_count: unknownBlockCount,
      objective_unresolved_without_unknown_block_count: unresolvedNoUnknown,
      objective_assembly_blocked_reason: blockedReason,
      answer_obligations_missing_count: obligationsMissing,
      objective_loop_patch_revision: patchRevision,
      stage05_used: toBoolOrNull(debug.stage05_used),
      context_file_count: toArray(debug.context_files).length,
      retrieval_error_count: retrievalErrors.length,
      retrieval_error_label_rate:
        retrievalErrors.length > 0
          ? Number((effectiveLabeledErrors / retrievalErrors.length).toFixed(4))
          : null,
      reasoning_sidebar_enabled: sidebarEnabled,
      reasoning_sidebar_step_count: sidebarSteps,
      reasoning_sidebar_event_count: sidebarEvents,
      event_journal_deterministic: journalDeterministic,
    },
    text_preview: normalizePreview(text),
  };
};

const renderReport = (summary: RunSummary): string => {
  const lines: string[] = [];
  lines.push("# Helix Ask Differential Mode Report");
  lines.push("");
  lines.push(`- run_id: \`${summary.run_id}\``);
  lines.push(`- generated_at: \`${summary.generated_at}\``);
  lines.push(`- base_url: \`${summary.base_url}\``);
  lines.push(`- corpus: \`${summary.corpus_path}\` (version \`${summary.corpus_version}\`)`);
  lines.push(`- prompts: ${summary.prompt_count}`);
  lines.push(`- pass_without_major_rate: ${(summary.pass_without_major_rate * 100).toFixed(1)}%`);
  lines.push(`- average_score: ${(summary.average_score * 100).toFixed(1)}%`);
  lines.push("");
  lines.push("## Grade Counts");
  for (const [grade, count] of Object.entries(summary.grade_counts)) {
    lines.push(`- ${grade}: ${count}`);
  }
  lines.push("");
  lines.push("## Divergence Counts");
  if (Object.keys(summary.divergence_counts).length === 0) {
    lines.push("- none");
  } else {
    for (const [code, count] of Object.entries(summary.divergence_counts).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${code}: ${count}`);
    }
  }
  lines.push("");
  lines.push("## Per-Prompt Results");
  lines.push("| id | grade | score | major_divergences | notes |");
  lines.push("|---|---|---:|---:|---|");
  for (const result of summary.results) {
    const majorCount = result.divergences.filter((entry) => entry.severity === "major").length;
    const note = result.divergences.slice(0, 2).map((entry) => entry.code).join(", ");
    lines.push(
      `| ${result.id} | ${result.grade} | ${(result.score * 100).toFixed(1)}% | ${majorCount} | ${note || "ok"} |`,
    );
  }
  lines.push("");
  lines.push("## Detailed Divergences");
  for (const result of summary.results) {
    if (result.divergences.length === 0) continue;
    lines.push(`### ${result.id}`);
    lines.push(`- question: ${result.question}`);
    lines.push(`- preview: ${result.text_preview || "(empty)"}`);
    for (const divergence of result.divergences) {
      lines.push(`- [${divergence.severity}] ${divergence.code}: ${divergence.detail}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
};

async function main(): Promise<void> {
  const baseUrl = (argValue("--base-url") ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const corpusPath = path.resolve(argValue("--corpus") ?? DEFAULT_CORPUS_PATH);
  const outRoot = path.resolve(argValue("--out-dir") ?? DEFAULT_OUT_ROOT);
  const timeoutMs = Math.max(1000, Number(argValue("--timeout-ms") ?? DEFAULT_TIMEOUT_MS));
  const maxPromptsRaw = argValue("--max-prompts");
  const maxPrompts = maxPromptsRaw ? Math.max(1, Number(maxPromptsRaw)) : null;
  const seedRaw = argValue("--seed");
  const seed = seedRaw ? Number(seedRaw) >>> 0 : null;

  const corpus = JSON.parse(await fs.readFile(corpusPath, "utf8")) as Corpus;
  if (!Array.isArray(corpus.prompts) || corpus.prompts.length === 0) {
    throw new Error(`Corpus has no prompts: ${corpusPath}`);
  }
  let prompts = corpus.prompts;
  if (typeof maxPrompts === "number" && Number.isFinite(maxPrompts) && maxPrompts < prompts.length) {
    const effectiveSeed =
      seed !== null && Number.isFinite(seed)
        ? seed >>> 0
        : seedFromString(`${path.basename(corpusPath)}:${prompts.length}`);
    prompts = shuffleWithSeed(prompts, effectiveSeed).slice(0, maxPrompts);
  }

  const runId = `helix-ask-diff:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "").replace(/-/g, "");
  const outputDir = path.join(outRoot, stamp);
  await fs.mkdir(outputDir, { recursive: true });

  const results: PromptResult[] = [];
  for (const entry of prompts) {
    console.log(`Running differential prompt: ${entry.id}`);
    const sessionId = `helix-ask-diff:${entry.id}:${Date.now()}`;
    let payload: AskResponse = {};
    try {
      const response = await fetchAsk(baseUrl, entry.question, sessionId, timeoutMs);
      if (response.status < 200 || response.status >= 300) {
        payload = { text: "", debug: {} };
        const result = evaluatePrompt(entry, payload);
        result.divergences.push({
          code: "request_failed",
          severity: "major",
          detail: `status=${response.status}`,
        });
        result.score = 0;
        result.grade = "divergent";
        results.push(result);
        continue;
      }
      payload = response.payload;
    } catch (error) {
      payload = { text: "", debug: {} };
      const result = evaluatePrompt(entry, payload);
      const message = error instanceof Error ? error.message : String(error);
      result.divergences.push({
        code: "request_failed",
        severity: "major",
        detail: message,
      });
      result.score = 0;
      result.grade = "divergent";
      results.push(result);
      continue;
    }
    results.push(evaluatePrompt(entry, payload));
  }

  const divergenceCounts: Record<string, number> = {};
  const gradeCounts: Record<string, number> = {
    aligned: 0,
    mostly_aligned: 0,
    partial: 0,
    divergent: 0,
  };
  for (const result of results) {
    gradeCounts[result.grade] = (gradeCounts[result.grade] ?? 0) + 1;
    for (const divergence of result.divergences) {
      divergenceCounts[divergence.code] = (divergenceCounts[divergence.code] ?? 0) + 1;
    }
  }
  const majorDivergencePromptCount = results.filter((result) =>
    result.divergences.some((entry) => entry.severity === "major"),
  ).length;
  const passWithoutMajorCount = results.length - majorDivergencePromptCount;
  const averageScore =
    results.length > 0
      ? Number((results.reduce((sum, result) => sum + result.score, 0) / results.length).toFixed(4))
      : 0;

  const summary: RunSummary = {
    schema_version: "helix_ask_differential_mode/1",
    run_id: runId,
    generated_at: new Date().toISOString(),
    base_url: baseUrl,
    corpus_path: corpusPath,
    corpus_version: String(corpus.version ?? "unknown"),
    prompt_count: results.length,
    major_divergence_prompt_count: majorDivergencePromptCount,
    pass_without_major_count: passWithoutMajorCount,
    pass_without_major_rate:
      results.length > 0 ? Number((passWithoutMajorCount / results.length).toFixed(4)) : 0,
    average_score: averageScore,
    grade_counts: gradeCounts,
    divergence_counts: divergenceCounts,
    artifacts: {
      output_dir: outputDir,
      results_json: path.join(outputDir, "results.json"),
      summary_json: path.join(outputDir, "summary.json"),
      report_md: path.join(outputDir, "report.md"),
    },
    results,
  };

  const report = renderReport(summary);
  await fs.writeFile(summary.artifacts.results_json, JSON.stringify(results, null, 2), "utf8");
  await fs.writeFile(summary.artifacts.summary_json, JSON.stringify(summary, null, 2), "utf8");
  await fs.writeFile(summary.artifacts.report_md, report, "utf8");

  console.log(
    `Differential summary: prompts=${summary.prompt_count} pass_without_major=${summary.pass_without_major_count}/${summary.prompt_count} avgScore=${(summary.average_score * 100).toFixed(1)}%`,
  );
  console.log(`Artifacts: ${outputDir}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`helix-ask:differential error: ${message}`);
  process.exitCode = 1;
});
