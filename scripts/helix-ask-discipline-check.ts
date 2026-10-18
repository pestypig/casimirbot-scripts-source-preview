import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

type CheckLevel = "failure" | "warning";

type CheckMessage = {
  level: CheckLevel;
  code: string;
  message: string;
  file?: string;
};

type DisciplinePatchFileReport = {
  changed_file: string;
  discipline_category: string;
  closest_codex_analog: string;
  helix_owned_policy_or_runtime_duplication: string;
  required_tests: string[];
  shortcut_risks: string[];
};

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check-only");
const runFull = args.has("--run-full");
const runRequired = args.has("--run-required") || (!checkOnly && !runFull);
const strict = args.has("--strict");
const force = args.has("--force");

const repoRoot = process.cwd();
const codexRoot = path.join(repoRoot, "external", "openai-codex-compare");
const helixAskPillNoGrowthPath = "client/src/components/helix/HelixAskPill.tsx";
const helixAskPillNoGrowthMaxLines = 25_485;
const codexReferenceFiles = [
  "codex-rs/core/src/session/turn.rs",
  "codex-rs/mcp-server/src/codex_tool_runner.rs",
  "codex-rs/core/src/exec.rs",
];

const sensitivePathPatterns = [
  /^server\/routes\/agi\.plan\.ts$/,
  /^server\/services\/helix-ask\//,
  /^server\/__tests__\/helix\.ask/,
  /^scripts\/helix-ask/,
  /^client\/src\/lib\/agi\//,
  /^client\/src\/store\/useLiveAnswerEnvironmentStore\.ts$/,
  /^client\/src\/components\/helix\//,
  /^client\/src\/components\/workstation\/LiveAnswerEnvironmentPanel\.tsx$/,
];

const sourceCodePatterns = [
  /^server\/routes\//,
  /^server\/services\/helix-ask\//,
  /^scripts\/helix-ask/,
  /^client\/src\//,
];

const classificationKeywords: Array<[string, RegExp]> = [
  ["prompt interpretation", /prompt-interpretation|prompt_interpretation|contextual_tool_mentions|negative_constraints/i],
  ["intent arbitration", /intent-arbitration|intent-hypothesis|intent_arbitration|intent_hypotheses|selected_primary_intent/i],
  ["source admission", /source-target|source_admission|source_target|live-source-identity|visual_capture/i],
  ["tool admission", /tool-admission|tool_admission|actual_tool_calls|mutating/i],
  ["evidence normalization", /evidence_selection|evidence_results|artifact_ledger|provenance/i],
  ["evidence re-entry", /evidence-reentry|evidence_reentry|receipts_reentered|selected_evidence_refs/i],
  ["follow-up reasoning", /followup|follow-up|reasoning_followup|post_evidence_reasoning/i],
  ["terminal authority", /terminal_authority|route-authority|route_authority|route_product|terminal_artifact_kind|typed_failure/i],
  ["presentation", /presentation|finalAnswer|LiveAnswerEnvironment|visibleAnswerState/i],
  ["Codex-owned runtime behavior", /sampling|sandbox|approval|subagent|compaction|session lifecycle|tool execution runtime/i],
];

const requiredTestByCategory: Array<[RegExp, string[]]> = [
  [/terminal_authority|presentation|stream_ui_backend_equivalence/i, [
    "npx vitest run server/__tests__/helix.ask.terminal-equivalence-harness.test.ts --pool=forks",
    "npx vitest run server/__tests__/helix.ask.api-parity-matrix.test.ts --pool=forks",
    "npx vitest run server/__tests__/helix.ask.prompt-solving-benchmark.test.ts --pool=forks",
  ]],
  [/capability_admission|capability_lifecycle|runtime_adapter/i, [
    "npx vitest run server/__tests__/helix.ask.capability-plan-contract.test.ts --pool=forks",
    "npx vitest run server/__tests__/helix.ask.capability-lifecycle-ledger.test.ts --pool=forks",
    "npx vitest run server/__tests__/helix.ask.api-parity-matrix.test.ts --pool=forks",
  ]],
  [/evidence_retrieval|procedure_memory|debug_diagnosis/i, [
    "npx vitest run server/__tests__/helix.ask.procedure-evidence-retriever.test.ts --pool=forks",
    "npx vitest run server/__tests__/helix.ask.api-parity-matrix.test.ts --pool=forks",
  ]],
  [/subgoal|retry|instruction/i, [
    "npx vitest run server/__tests__/helix.ask.solver-subgoal-ledger.test.ts --pool=forks",
    "npx vitest run server/__tests__/helix.ask.solver-retry-policy.test.ts --pool=forks",
    "npx vitest run server/__tests__/helix.ask.solver-instruction-frame.test.ts --pool=forks",
  ]],
  [/test_harness|discipline_guard/i, [
    "npm run helix:ask:discipline:quick",
  ]],
];

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/");
}

function commandName(name: string): string {
  if (process.platform !== "win32") return name;
  return name === "npm" || name === "npx" ? `${name}.cmd` : name;
}

function runText(command: string, commandArgs: string[], cwd = repoRoot): string {
  const result = spawnSync(commandName(command), commandArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return "";
  return String(result.stdout ?? "");
}

function gitLines(commandArgs: string[]): string[] {
  return runText("git", commandArgs)
    .split(/\r?\n/)
    .map(normalizePath)
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isSensitive(file: string): boolean {
  return sensitivePathPatterns.some((pattern) => pattern.test(file));
}

function isSourceCode(file: string): boolean {
  return sourceCodePatterns.some((pattern) => pattern.test(file)) && !file.includes("__tests__/");
}

function fileExists(file: string): boolean {
  return existsSync(path.join(repoRoot, file));
}

function readUtf8(file: string): string | null {
  const absolute = path.join(repoRoot, file);
  if (!existsSync(absolute)) return null;
  const stat = statSync(absolute);
  if (!stat.isFile() || stat.size > 1_500_000) return null;
  return readFileSync(absolute, "utf8");
}

function inferClassifications(files: string[]): string[] {
  const labels = new Set<string>();
  for (const file of files) {
    const content = readUtf8(file) ?? "";
    const haystack = `${file}\n${content}`;
    for (const [label, pattern] of classificationKeywords) {
      if (pattern.test(haystack)) labels.add(label);
    }
  }
  return [...labels];
}

function inferDisciplineCategory(file: string, content: string): string {
  const haystack = `${file}\n${content}`;
  if (/scripts\/helix-ask-discipline-check\.ts$/.test(file)) return "discipline_guard";
  if (/__tests__\//.test(file)) return "test_harness";
  if (/^server\/routes\/agi\.plan\.ts$/.test(file)) return "route_authority / terminal_authority / presentation";
  if (/ask-turn-solver\.ts$/.test(file)) return "intent_arbitration / route_authority / terminal_authority";
  if (/terminal-equivalence|visibleAnswerState|client_server_terminal_match|stream_terminal/i.test(haystack)) {
    return "stream_ui_backend_equivalence / terminal_authority / presentation";
  }
  if (/procedure-evidence-retriever|procedure_evidence_retrieval/i.test(haystack)) return "evidence_retrieval";
  if (/capability-lifecycle|capability_lifecycle/i.test(haystack)) {
    return "capability_lifecycle / capability_admission / evidence_reentry";
  }
  if (/capability-result-gate|capability_result|reentered_solver/i.test(haystack)) {
    return "capability_admission / evidence_reentry";
  }
  if (/capability-planner|capability_plan|operator_command_required/i.test(haystack)) return "capability_admission";
  if (/solver-subgoal|solver_subgoal/i.test(haystack)) return "subgoal_evaluation";
  if (/solver-retry|solver_retry/i.test(haystack)) return "retry_policy";
  if (/solver-instruction|solver_instruction/i.test(haystack)) return "instruction_reinstallation";
  if (/workstation-action|workspace_action|client-capabilit|adapter_acknowledged/i.test(haystack)) return "runtime_adapter";
  if (/ask-turn-solver|route_authority|terminal_authority|terminal_artifact_kind|typed_failure/i.test(haystack)) {
    return "intent_arbitration / route_authority / terminal_authority";
  }
  if (/source_target|visual_capture|live-source-identity/i.test(haystack)) return "source_admission";
  if (/presentation|finalAnswer|LiveAnswerEnvironment/i.test(haystack)) return "presentation";
  return "helix_policy";
}

function closestCodexAnalogForCategory(category: string): string {
  if (/stream_ui_backend_equivalence|terminal_authority|presentation/i.test(category)) {
    return "turn.rs terminal item completion / final assistant message";
  }
  if (/capability_admission|capability_lifecycle/i.test(category)) {
    return "codex_tool_runner.rs tool result events";
  }
  if (/evidence_retrieval|evidence_reentry|procedure_memory/i.test(category)) {
    return "tool result re-entry / turn continuation";
  }
  if (/runtime_adapter/i.test(category)) return "exec.rs / tool execution";
  if (/subgoal|retry|instruction/i.test(category)) return "turn.rs task progression and continuation policy";
  if (/prompt_interpretation|intent_arbitration|source_admission|route_authority/i.test(category)) {
    return "turn.rs model/tool arbitration boundary";
  }
  if (/test_harness|discipline_guard/i.test(category)) return "Codex regression tests / runtime invariant checks";
  return "turn.rs procedural turn lifecycle";
}

function verdictForCategory(category: string, file: string, content: string): string {
  if (/runtime_adapter/i.test(category)) return "allowed only as thin adapter";
  if (/test_harness|discipline_guard/i.test(category)) return "Helix-owned verification policy";
  if (/Codex-owned runtime behavior|sampling|sandbox|approval|subagent orchestration|private execution queue/i.test(content)) {
    return "review for unsafe Codex-owned runtime duplication";
  }
  if (/shared\//.test(file)) return "Helix-owned data contract";
  return "Helix-owned policy";
}

function shortcutRisksForFile(file: string, content: string): string[] {
  if (/scripts\/helix-ask-discipline-check\.ts$/.test(file)) {
    return ["discipline_report_can_mask_runtime_duplication_if_codex_analog_missing"];
  }
  const risks = new Set<string>();
  const haystack = `${file}\n${content}`;
  if (/receipt|workspace_action_receipt|doc_open_receipt|live_pipeline_receipt/i.test(haystack)) {
    risks.add("receipt_becomes_answer_without_goal_authority");
  }
  if (/projection|visibleAnswerState|finalAnswer|LiveAnswerEnvironment/i.test(haystack)) {
    risks.add("projection_or_visible_state_overrides_terminal_authority");
  }
  if (/typed_failure|terminal_error_code|final_failure/i.test(haystack)) {
    risks.add("typed_failure_hidden_by_stale_presentation");
  }
  if (/actual_tool_calls|set_rate|mutating|operator_command/i.test(haystack)) {
    risks.add("contextual_tool_mention_becomes_executable_action");
  }
  if (/retrieval_plan|procedure_evidence_retrieval/i.test(haystack)) {
    risks.add("retrieval_plan_used_without_result");
  }
  if (/capability_plan|capability_result|capability_lifecycle/i.test(haystack)) {
    risks.add("capability_result_not_reentered_before_terminal");
  }
  if (/route_authority|route_reason_code|terminal_artifact_kind/i.test(haystack)) {
    risks.add("route_label_or_terminal_kind_used_as_authority");
  }
  if (/stream|turn_final|terminal_answer_authority|poison_audit/i.test(haystack)) {
    risks.add("stream_debug_ui_terminal_mismatch");
  }
  return [...risks];
}

function requiredTestsForCategory(category: string): string[] {
  const tests = new Set<string>();
  for (const [pattern, commands] of requiredTestByCategory) {
    if (pattern.test(category)) commands.forEach((command) => tests.add(command));
  }
  if (tests.size === 0) tests.add("npm run helix:ask:discipline:quick");
  return [...tests];
}

function buildPatchFileReport(file: string): DisciplinePatchFileReport {
  const content = readUtf8(file) ?? "";
  const disciplineCategory = inferDisciplineCategory(file, content);
  return {
    changed_file: file,
    discipline_category: disciplineCategory,
    closest_codex_analog: closestCodexAnalogForCategory(disciplineCategory),
    helix_owned_policy_or_runtime_duplication: verdictForCategory(disciplineCategory, file, content),
    required_tests: requiredTestsForCategory(disciplineCategory),
    shortcut_risks: shortcutRisksForFile(file, content),
  };
}

function printPatchFileReports(reports: DisciplinePatchFileReport[]): void {
  if (reports.length === 0) return;
  console.log("[helix:ask:discipline] per-file Codex comparison report");
  for (const report of reports) {
    console.log(`- changed_file: ${report.changed_file}`);
    console.log(`  discipline_category: ${report.discipline_category}`);
    console.log(`  closest_codex_analog: ${report.closest_codex_analog}`);
    console.log(`  helix_owned_policy_or_runtime_duplication: ${report.helix_owned_policy_or_runtime_duplication}`);
    console.log(`  required_tests: ${report.required_tests.length ? report.required_tests.join("; ") : "none"}`);
    console.log(`  shortcut_risks: ${report.shortcut_risks.length ? report.shortcut_risks.join("; ") : "none_detected"}`);
  }
}

function checkCodexReference(messages: CheckMessage[], hasSensitiveChanges: boolean): void {
  if (!hasSensitiveChanges) return;
  if (!existsSync(codexRoot)) {
    messages.push({
      level: process.env.HELIX_ASK_DISCIPLINE_ALLOW_MISSING_CODEX === "1" ? "warning" : "failure",
      code: "codex_reference_missing",
      message:
        "Missing external/openai-codex-compare. Helix Ask discipline checks require the ignored Codex runtime reference checkout.",
    });
    return;
  }

  for (const refFile of codexReferenceFiles) {
    if (!existsSync(path.join(codexRoot, refFile))) {
      messages.push({
        level: "failure",
        code: "codex_reference_file_missing",
        message: `Missing Codex reference file ${refFile}.`,
      });
    }
  }
}

function scanFiles(files: string[], messages: CheckMessage[]): void {
  for (const file of files) {
    if (!fileExists(file)) continue;
    if (!isSourceCode(file)) continue;
    if (file === "scripts/helix-ask-discipline-check.ts") continue;

    const content = readUtf8(file);
    if (content == null) continue;

    if (/\bassistant_answer\s*:\s*true\b/.test(content)) {
      messages.push({
        level: "failure",
        code: "assistant_answer_true_in_helix_source",
        file,
        message:
          "Helix Ask trace/evidence artifacts must not claim assistant_answer=true. Only terminal presentation may become visible text.",
      });
    }

    if (/\braw_content_included\s*:\s*true\b/.test(content)) {
      messages.push({
        level: "failure",
        code: "raw_content_included_true_in_helix_source",
        file,
        message: "Helix Ask debug and evidence artifacts must not include raw content by default.",
      });
    }

    if (/\ballow_no_tool_direct\s*:\s*true\b/.test(content)) {
      messages.push({
        level: "warning",
        code: "allow_no_tool_direct_touched",
        file,
        message:
          "Review any allow_no_tool_direct change against hard source-target rules. Hard source-targeted turns must not fall back to no_tool_direct.",
      });
    }

    if (/\blive_pipeline_receipt\b/.test(content)) {
      messages.push({
        level: "warning",
        code: "live_pipeline_receipt_touched",
        file,
        message:
          "Receipts are observations, not answers. Confirm this path is pure control/status or guarded by solver arbitration and re-entry.",
      });
    }

    if (/\b(model_only_concept|client_projection|panel_generated_answer|process_graph_overview)\b/.test(content)) {
      messages.push({
        level: "warning",
        code: "shortcut_terminal_product_touched",
        file,
        message:
          "Shortcut-like terminal products must be suppressed for hard source-targeted and complex prompts unless route authority explicitly allows them.",
      });
    }

    const terminalAuthorityFile = /^server\/services\/helix-ask\/(?:ask-turn-solver|evidence-reentry-gate)\.ts$/.test(file);
    const receiptTerminalExceptionTouched =
      /\b(?:[a-z0-9_]+_receipt|receipt_terminal_without_reentry|tool_evaluation|workstation_tool_evaluation)\b/i.test(content) ||
      /\/receipt\/i\.test/.test(content);
    const hasGoalAuthorityGuard =
      /\b(?:canonical_goal_frame|universal_goal_frame|required_terminal_kind|goal_kind|goalFrame|GoalFrame)\b/.test(content);
    if (terminalAuthorityFile && receiptTerminalExceptionTouched && !hasGoalAuthorityGuard) {
      messages.push({
        level: "failure",
        code: "receipt_terminal_without_goal_authority_guard",
        file,
        message:
          "Receipt terminal exceptions in solver/evidence gates must be bound to canonical goal authority (goal_kind and required_terminal_kind), not only terminal kind or route label.",
      });
    }

    if (
      terminalAuthorityFile &&
      /\b(?:[a-z0-9_]+_receipt|tool_evaluation|workstation_tool_evaluation)\b[\s\S]{0,700}\bdispatch:act\b/i.test(content)
    ) {
      messages.push({
        level: "failure",
        code: "receipt_terminal_dispatch_shortcut",
        file,
        message:
          "dispatch:act is a planner route, not terminal receipt authority. Bind receipt eligibility to the canonical goal frame instead.",
      });
    }

    if (terminalAuthorityFile && /\b(?:terminal|terminalArtifactKind|terminal_artifact_kind)\s*={0,2}\s*["'][a-z0-9_]+_receipt["']/i.test(content)) {
      messages.push({
        level: "failure",
        code: "receipt_terminal_name_specific_gate",
        file,
        message:
          "Terminal authority gates must not name individual receipt products. Use the canonical goal contract and generic receipt/evidence predicates.",
      });
    }
  }
}

function runCommand(
  label: string,
  command: string,
  commandArgs: string[],
  envOverrides: NodeJS.ProcessEnv = {},
): boolean {
  console.log(`\n[helix:ask:discipline] ${label}`);
  console.log(`> ${command} ${commandArgs.join(" ")}`);
  const result =
    process.platform === "win32"
      ? spawnSync([command, ...commandArgs].map(quoteWindowsShellArg).join(" "), {
          cwd: repoRoot,
          encoding: "utf8",
          shell: true,
          stdio: "inherit",
          env: { ...process.env, ...envOverrides },
        })
      : spawnSync(command, commandArgs, {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: "inherit",
          env: { ...process.env, ...envOverrides },
        });
  if (result.status === 0) return true;
  if (result.error) console.error(result.error.message);
  console.error(`[helix:ask:discipline] failed: ${label}`);
  return false;
}

function quoteWindowsShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function printMessages(messages: CheckMessage[]): void {
  for (const message of messages) {
    const prefix = message.level === "failure" ? "FAIL" : "WARN";
    const location = message.file ? ` ${message.file}` : "";
    console.log(`[${prefix}] ${message.code}${location}: ${message.message}`);
  }
}

function checkHelixAskPillNoGrowth(messages: CheckMessage[]): void {
  const content = readUtf8(helixAskPillNoGrowthPath);
  if (!content) return;
  const lineCount = content.split(/\r?\n/).length;
  if (lineCount <= helixAskPillNoGrowthMaxLines) return;
  messages.push({
    level: "failure",
    code: "helix_ask_pill_growth_blocked",
    file: helixAskPillNoGrowthPath,
    message:
      `HelixAskPill.tsx grew to ${lineCount} lines over the recrown ceiling of ${helixAskPillNoGrowthMaxLines}. ` +
      "Move new UI/display/pure behavior into client/src/components/helix/ask-console/ and leave only thin bridge wiring in the pill. " +
      "Only lower this ceiling after extraction shrinks the file.",
  });
}

const changedFiles = unique([
  ...gitLines(["diff", "--name-only"]),
  ...gitLines(["diff", "--name-only", "--cached"]),
  ...gitLines(["ls-files", "--others", "--exclude-standard"]),
]).sort();
const sensitiveFiles = changedFiles.filter(isSensitive);
const classificationFiles = sensitiveFiles.filter((file) => file !== "scripts/helix-ask-discipline-check.ts");
const patchFileReports = sensitiveFiles.map(buildPatchFileReport);
const messages: CheckMessage[] = [];

checkCodexReference(messages, sensitiveFiles.length > 0);
scanFiles(sensitiveFiles, messages);
checkHelixAskPillNoGrowth(messages);

const inferredClassifications = inferClassifications(classificationFiles);
const declaredClassification = process.env.HELIX_ASK_DISCIPLINE_CLASSIFICATION?.trim();
if (sensitiveFiles.length > 0 && !declaredClassification) {
  messages.push({
    level: strict ? "failure" : "warning",
    code: "classification_not_declared",
    message:
      "Set HELIX_ASK_DISCIPLINE_CLASSIFICATION for patch review, or record the inferred categories in the handoff.",
  });
}

const codexHead = existsSync(codexRoot) ? runText("git", ["rev-parse", "--short", "HEAD"], codexRoot).trim() : "missing";

console.log("[helix:ask:discipline] Codex discipline guard");
console.log(`repo: ${repoRoot}`);
console.log(`codex_reference: external/openai-codex-compare (${codexHead || "unknown"})`);
console.log(`changed_files: ${changedFiles.length}`);
console.log(`sensitive_helix_ask_files: ${sensitiveFiles.length}`);
if (sensitiveFiles.length > 0) {
  for (const file of sensitiveFiles) console.log(`  - ${file}`);
}
printPatchFileReports(patchFileReports);
console.log(
  `classification: ${
    declaredClassification || (inferredClassifications.length ? inferredClassifications.join(", ") : "none inferred")
  }`,
);

printMessages(messages);

const failures = messages.filter((message) => message.level === "failure");
if (failures.length > 0) {
  console.error(`\n[helix:ask:discipline] failed static discipline checks: ${failures.length}`);
  process.exit(1);
}

if (sensitiveFiles.length === 0 && !force) {
  console.log("[helix:ask:discipline] no Helix Ask-sensitive changes detected; skipping test battery");
  process.exit(0);
}

if (checkOnly) {
  console.log("[helix:ask:discipline] static checks passed");
  process.exit(0);
}

type TestCommand = [string, string, string[], NodeJS.ProcessEnv?];

const singleWorkerArgs = ["--pool=forks", "--maxWorkers=1", "--minWorkers=1"];
const promptBenchmarkCaseShards = [
  [
    "contextual_environment_probe_explanation",
    "negated_minecraft_inventory_probe",
    "future_conditional_environment_probe",
    "historical_environment_probe",
    "quoted_screen_environment_probe",
    "mixed_environment_probe_explanation_only",
    "negated_interval_check_first",
    "negated_click_no_action",
  ],
  [
    "historical_set_rate_justified",
    "historical_tool_call_without_repeat",
    "conceptual_review_no_settings",
    "explain_before_future_click",
    "quoted_start_capture",
    "screen_visible_start_button",
    "negated_calculator_open_no_action",
    "future_calculator_prefill_no_action",
  ],
  [
    "historical_calculator_tool_call_no_repeat",
    "quoted_calculator_label_no_action",
    "curly_quoted_theory_procedure_no_action",
    "debug_facts_rank_failure",
    "capture_running_no_evidence_causes",
    "ambiguous_capture_status",
    "ambiguous_it_failed",
    "open_run_nothing_debug_export",
  ],
  [
    "do_not_repair_reason_only",
    "fresh_producer_no_selected_observations",
    "counterfactual_field_empty",
    "implementation_plan_no_runtime",
    "implementation_question_no_receipt",
    "helix_codex_policy_comparison",
    "poison_clean_not_route_authority",
  ],
] as const;
const apiParityScenarioShards = [
  [
    "visual_content_active_source",
    "visual_content_negated_cadence",
    "visual_content_original_interval_regression",
    "procedure_epoch_interval_status",
  ],
  [
    "affirmative_cadence_control",
    "contextual_click",
    "capability_catalog_runtime",
    "screen_text_start_button",
  ],
  [
    "historical_tool_mention",
    "live_source_identity_active_bound",
    "live_source_identity_fresh_unbound",
    "live_source_identity_wrong_environment",
  ],
  [
    "live_source_identity_missing_environment_source",
    "live_source_identity_no_situation_run",
    "live_source_identity_no_field_evaluations",
    "live_source_identity_stale_interpretation",
  ],
] as const;

const testCommands: TestCommand[] = [
  [
    "prompt-solving benchmark prelude",
    commandName("npx"),
    ["vitest", "run", "server/__tests__/helix.ask.prompt-solving-benchmark.test.ts", ...singleWorkerArgs],
    { HELIX_PROMPT_BENCHMARK_PRELUDE_ONLY: "1" },
  ],
  ...promptBenchmarkCaseShards.map<TestCommand>((ids, index) => [
    `prompt-solving adversarial benchmark shard ${index + 1}/${promptBenchmarkCaseShards.length}`,
    commandName("npx"),
    ["vitest", "run", "server/__tests__/helix.ask.prompt-solving-benchmark.test.ts", ...singleWorkerArgs],
    { HELIX_PROMPT_BENCHMARK_CASE_IDS: ids.join(",") },
  ]),
  [
    "API parity fixed rail and route contracts",
    commandName("npx"),
    ["vitest", "run", "server/__tests__/helix.ask.api-parity-matrix.test.ts", ...singleWorkerArgs],
    { HELIX_API_PARITY_SCENARIO_IDS: "__none__" },
  ],
  ...apiParityScenarioShards.map<TestCommand>((ids, index) => [
    `API parity scenario shard ${index + 1}/${apiParityScenarioShards.length}`,
    commandName("npx"),
    [
      "vitest",
      "run",
      "server/__tests__/helix.ask.api-parity-matrix.test.ts",
      ...singleWorkerArgs,
      "-t",
      "stays procedural through top-level Ask",
    ],
    { HELIX_API_PARITY_SCENARIO_IDS: ids.join(",") },
  ]),
];

if (runFull) {
  testCommands.push(
    [
      "live source continuation routing",
      commandName("npx"),
      ["vitest", "run", "server/__tests__/helix.ask.turn.live-source-continuation-routing.test.ts", ...singleWorkerArgs],
    ],
    [
      "live source identity audit",
      commandName("npx"),
      ["vitest", "run", "server/__tests__/helix.ask.live-source-identity-audit.test.ts", ...singleWorkerArgs],
    ],
  );
}

if (runRequired || runFull) {
  testCommands.push(["server build", commandName("npm"), ["run", "build:server"]]);
}

for (const [label, command, commandArgs, envOverrides] of testCommands) {
  if (!runCommand(label, command, commandArgs, envOverrides)) process.exit(1);
}

console.log("\n[helix:ask:discipline] passed");
