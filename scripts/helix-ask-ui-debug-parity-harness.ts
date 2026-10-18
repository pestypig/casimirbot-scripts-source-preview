import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "@playwright/test";
import {
  CODEX_PARITY_AGENT_SPINE_CLASSES,
  CODEX_PARITY_AGENT_SPINE_COMPOUND_STRING_OR_NULL_FIELDS,
  CODEX_PARITY_AGENT_SPINE_FIRST_BROKEN_RAILS,
  CODEX_PARITY_AGENT_SPINE_RAIL_STATUSES,
  CODEX_PARITY_AGENT_SPINE_RAIL_TABLE_SCHEMA,
  CODEX_PARITY_AGENT_SPINE_REENTRY_STATUSES,
  CODEX_PARITY_AGENT_SPINE_REPAIR_TARGETS,
  CODEX_PARITY_AGENT_SPINE_STRING_OR_NULL_FIELDS,
  isCodexParityAgentSpineRailFailureCode,
} from "../server/services/helix-ask/codex-parity-agent-spine-contract";

const UI_DEBUG_COMPOUND_STRING_OR_NULL_FIELDS = [
  "first_incomplete_compound_subgoal_id",
  "first_incomplete_compound_requested_capability",
  "first_incomplete_compound_runtime_capability",
  "first_incomplete_compound_selected_capability",
  "first_incomplete_compound_executed_capability",
  "compound_first_broken_rail",
  "compound_rail_failure_code",
  "compound_repair_target",
] as const satisfies readonly (typeof CODEX_PARITY_AGENT_SPINE_COMPOUND_STRING_OR_NULL_FIELDS)[number][];

export type HarnessPrompt = {
  prompt: string;
  expectCoverage?: boolean;
  expectCalculatorPanel?: boolean;
};

type HarnessResult = {
  prompt: string;
  visible_final_answer: string;
  debug_export: Record<string, unknown> | null;
  api_response?: Record<string, unknown> | null;
  api_debug_export?: Record<string, unknown> | null;
  ui_api_terminal_parity_violations?: string[];
  terminal_authority: unknown;
  codex_parity_agent_spine_rail_table: unknown;
  goal_satisfaction: unknown;
  agent_runtime_loop: unknown;
  coverage_artifacts: unknown[];
  calculator_panel_state: Record<string, unknown> | null;
  server_bundle_freshness?: Record<string, unknown>;
  warnings: string[];
  violations: string[];
};

type LocalRestartSensitiveRuntimeChanges = {
  latestMtimeMs: number | null;
  files: string[];
};

const BASE_URL = process.env.HELIX_ASK_UI_URL ?? process.env.PLAYWRIGHT_TEST_BASE_URL ?? "http://localhost:5050/desktop";
const API_BASE_URL = (
  process.env.HELIX_ASK_BASE_URL ??
  (() => {
    try {
      return new URL(BASE_URL).origin;
    } catch {
      return "http://localhost:5050";
    }
  })()
).replace(/\/+$/, "");
const OUT_PATH =
  process.env.HELIX_ASK_UI_DEBUG_PARITY_OUT ??
  path.resolve(process.cwd(), "artifacts/helix-ask/ui-debug-parity-latest.json");
const COMPARE_API = process.env.HELIX_ASK_UI_DEBUG_PARITY_COMPARE_API === "1";
const API_SESSION_ID = process.env.HELIX_ASK_UI_DEBUG_PARITY_API_SESSION_ID?.trim() || "";
const API_TIMEOUT_MS = Math.max(1000, Number(process.env.HELIX_ASK_UI_DEBUG_PARITY_API_TIMEOUT_MS ?? 180_000));
const PROMPT_PRESET = process.env.HELIX_ASK_UI_DEBUG_PARITY_PRESET?.trim() || "default";
const REQUIRE_GOAL_PROOF = process.env.HELIX_ASK_REQUIRE_GOAL_PROOF === "1";

export const HELIX_ASK_NATURAL_CALCULATOR_PROMPT =
  "Open the scientific calculator, solve 2*(3+4), and explain the steps.";
export const HELIX_ASK_EXPLICIT_CALCULATOR_PROMPT =
  "Call scientific-calculator.solve_expression for 2*(3+4) and return the calculator-backed result.";
export const HELIX_ASK_TOOL_CATALOG_PROMPT = "What tools are available for Helix Ask to use right now?";
export const HELIX_ASK_DOCS_LOCATE_PROMPT =
  "Use docs-viewer.locate_in_doc to find where the Helix Ask Codex loop discipline says receipts are observations.";
export const HELIX_ASK_VISUAL_CONTEXT_PROMPT = "What is happening right now in the visual screen capture?";

export const DEFAULT_PROMPTS: HarnessPrompt[] = [
  { prompt: "Open docs panel." },
  { prompt: "What doc are we looking at right now?" },
  { prompt: HELIX_ASK_NATURAL_CALCULATOR_PROMPT, expectCoverage: true, expectCalculatorPanel: true },
];

export const BROAD_PARITY_PROMPTS: HarnessPrompt[] = [
  { prompt: HELIX_ASK_TOOL_CATALOG_PROMPT },
  { prompt: "Open docs panel." },
  { prompt: HELIX_ASK_DOCS_LOCATE_PROMPT },
  { prompt: HELIX_ASK_NATURAL_CALCULATOR_PROMPT, expectCoverage: true, expectCalculatorPanel: true },
  { prompt: HELIX_ASK_EXPLICIT_CALCULATOR_PROMPT, expectCoverage: true, expectCalculatorPanel: true },
  { prompt: "Use workspace_os.status to inspect workstation status." },
  { prompt: HELIX_ASK_VISUAL_CONTEXT_PROMPT },
  { prompt: "Do not open the docs viewer; just explain what the docs viewer is for." },
];

export const resolveUiDebugParityPromptPreset = (preset = PROMPT_PRESET): HarnessPrompt[] => {
  const normalized = preset.trim().toLowerCase();
  if (normalized === "broad" || normalized === "full" || normalized === "goal") return BROAD_PARITY_PROMPTS;
  return DEFAULT_PROMPTS;
};

const normalizeHarnessPrompt = (value: unknown): HarnessPrompt | null => {
  if (typeof value === "string") {
    const prompt = value.trim();
    return prompt ? { prompt } : null;
  }
  const record = asRecord(value);
  const prompt = readString(record?.prompt);
  if (!prompt) return null;
  return {
    prompt,
    expectCoverage: record?.expectCoverage === true,
    expectCalculatorPanel: record?.expectCalculatorPanel === true,
  };
};

export const resolveUiDebugParityPrompts = (
  raw = process.env.HELIX_ASK_UI_DEBUG_PARITY_PROMPTS ?? "",
  preset = PROMPT_PRESET,
): HarnessPrompt[] => {
  const trimmed = raw.trim();
  if (!trimmed) return resolveUiDebugParityPromptPreset(preset);
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const prompts = values.map(normalizeHarnessPrompt).filter((entry): entry is HarnessPrompt => Boolean(entry));
    if (prompts.length > 0) return prompts;
  } catch {
    // Fall through to the lightweight delimiter format below.
  }
  const prompts = trimmed
    .split(/\n|\|{3,}/)
    .map((entry) => normalizeHarnessPrompt(entry))
    .filter((entry): entry is HarnessPrompt => Boolean(entry));
  return prompts.length > 0 ? prompts : resolveUiDebugParityPromptPreset(preset);
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const readString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const readStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry: unknown): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];

const isNonEmptyStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);

const readNonNegativeInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

const normalizeRepoPath = (value: string): string => value.replace(/\\/g, "/").replace(/^\.\/+/, "");

const isRestartSensitiveRuntimeFile = (filePath: string): boolean => {
  const normalized = normalizeRepoPath(filePath);
  return (
    normalized === "server/routes/agi.plan.ts" ||
    (normalized.startsWith("server/services/helix-ask/") &&
      !normalized.includes("/__tests__/") &&
      !normalized.endsWith(".test.ts") &&
      !normalized.endsWith(".spec.ts")) ||
    normalized === "shared/helix-live-agent-step.ts"
  );
};

const gitChangedRuntimeFiles = (): string[] => {
  const result = spawnSync("git", ["diff", "--name-only"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((entry) => normalizeRepoPath(entry.trim()))
    .filter(Boolean)
    .filter(isRestartSensitiveRuntimeFile);
};

const collectLocalRestartSensitiveRuntimeChanges = (): LocalRestartSensitiveRuntimeChanges => {
  const files = gitChangedRuntimeFiles();
  const mtimes: number[] = [];
  for (const file of files) {
    try {
      mtimes.push(Math.floor(fs.statSync(file).mtimeMs));
    } catch {
      mtimes.push(Date.now());
    }
  }
  return {
    latestMtimeMs: mtimes.length ? Math.max(...mtimes) : null,
    files,
  };
};

export const uiServerBundleFreshnessWarnings = (input: {
  serverBuildStartedAtMs: number | null;
  latestLocalRuntimeChangeMs: number | null;
  changedRuntimeFiles?: string[];
}): string[] => {
  if (!input.serverBuildStartedAtMs || !input.latestLocalRuntimeChangeMs) return [];
  if (input.serverBuildStartedAtMs + 1000 >= input.latestLocalRuntimeChangeMs) return [];
  const changedCount = input.changedRuntimeFiles?.length ?? 0;
  return [
    `server_bundle_predates_local_runtime_changes:${input.serverBuildStartedAtMs}<${input.latestLocalRuntimeChangeMs}:changed_files=${changedCount}`,
  ];
};

export const summarizeUiDebugParityWarnings = (
  results: Array<Record<string, unknown>>,
): {
  warning_count: number;
  stale_server_bundle_count: number;
  untrusted_violation_count: number;
  capacity_or_admission_stress_count: number;
} => {
  const warnings = results.flatMap((result) =>
    Array.isArray(result.warnings) ? result.warnings.map((warning) => String(warning)) : [],
  );
  return {
    warning_count: warnings.length,
    stale_server_bundle_count: warnings.filter((warning) =>
      /^server_bundle_predates_local_runtime_changes:/i.test(warning),
    ).length,
    untrusted_violation_count: warnings.filter((warning) =>
      /^untrusted_violation_due_to_stale_server_bundle:/i.test(warning),
    ).length,
    capacity_or_admission_stress_count: warnings.filter((warning) =>
      /^capacity_or_admission_stress:/i.test(warning),
    ).length,
  };
};

export const uiDebugParityGoalProofTrust = (warningSummary: {
  stale_server_bundle_count?: number;
  untrusted_violation_count?: number;
  capacity_or_admission_stress_count?: number;
}, executedResultCount = 0): {
  trusted_for_goal_acceptance: boolean;
  requires_keyed_server_restart: boolean;
  capacity_or_admission_limited: boolean;
  executed_result_count: number;
} => {
  const staleCount = warningSummary.stale_server_bundle_count ?? 0;
  const untrustedCount = warningSummary.untrusted_violation_count ?? 0;
  const capacityCount = warningSummary.capacity_or_admission_stress_count ?? 0;
  return {
    trusted_for_goal_acceptance: executedResultCount > 0 && staleCount === 0 && untrustedCount === 0 && capacityCount === 0,
    requires_keyed_server_restart: staleCount > 0 || untrustedCount > 0,
    capacity_or_admission_limited: capacityCount > 0,
    executed_result_count: executedResultCount,
  };
};

export const uiDebugParityProcessExitCode = (
  summaryOk: boolean,
  requireGoalProof: boolean,
  goalProofTrust: { trusted_for_goal_acceptance?: boolean },
): 0 | 1 => {
  if (!summaryOk) return 1;
  if (requireGoalProof && goalProofTrust.trusted_for_goal_acceptance !== true) return 1;
  return 0;
};

const resultHasWarning = (result: Record<string, unknown> | null, pattern: RegExp): boolean =>
  Array.isArray(result?.warnings) && result.warnings.some((warning) => pattern.test(String(warning)));

const resultHasStaleServerBundleWarning = (result: Record<string, unknown> | null): boolean =>
  resultHasWarning(result, /^server_bundle_predates_local_runtime_changes:/i);

const resultHasCapacityAdmissionWarning = (result: Record<string, unknown> | null): boolean =>
  resultHasWarning(result, /^capacity_or_admission_stress:/i);

const uiHarnessResultByPrompt = (results: Array<Record<string, unknown>>, prompt: string): Record<string, unknown> | null =>
  results.find((result) => readString(result.prompt) === prompt) ?? null;

const uiHarnessRailTable = (result: Record<string, unknown> | null): Record<string, unknown> | null =>
  asRecord(result?.codex_parity_agent_spine_rail_table);

const uiHarnessTerminalKind = (result: Record<string, unknown> | null, rail: Record<string, unknown> | null): string =>
  firstNonEmptyString(
    rail?.selected_terminal_kind,
    rail?.visible_terminal_kind,
    getPath(result, ["debug_export", "terminal_artifact_kind"]),
  );

const uiHarnessTerminalError = (result: Record<string, unknown> | null): string =>
  firstNonEmptyString(
    getPath(result, ["debug_export", "terminal_error_code"]),
    getPath(result, ["debug_export", "payload", "terminal_error_code"]),
  );

const uiHarnessVisibleAnswer = (result: Record<string, unknown> | null): string =>
  readString(result?.visible_final_answer);

const uiHarnessMentionsCalculatorResult14 = (result: Record<string, unknown> | null): boolean =>
  /\b(?:result|answer|equals?|is|=)\s*:?\s*14(?:\b|$)/i.test(uiHarnessVisibleAnswer(result));

const uiHarnessActionEnvelopeCapabilities = (result: Record<string, unknown> | null): string[] => {
  const values = new Set<string>();
  const candidates = [
    asRecord(result?.action_envelope),
    asRecord(getPath(result, ["debug_export", "action_envelope"])),
    asRecord(getPath(result, ["debug_export", "payload", "action_envelope"])),
    asRecord(getPath(result, ["debug_export", "payload", "debug", "action_envelope"])),
    asRecord(getPath(result, ["api_response", "action_envelope"])),
    asRecord(getPath(result, ["api_debug_export", "action_envelope"])),
    asRecord(getPath(result, ["api_debug_export", "payload", "action_envelope"])),
  ].filter(Boolean) as Array<Record<string, unknown>>;
  for (const envelope of candidates) {
    const actions = Array.isArray(envelope.workstation_actions) ? envelope.workstation_actions : [];
    for (const actionValue of actions) {
      const action = asRecord(actionValue);
      if (!action) continue;
      const capabilityId = readString(action.capability_id);
      const panelId = readString(action.panel_id);
      const actionKind = readString(action.action);
      const actionId = readString(action.action_id);
      if (capabilityId) values.add(capabilityId);
      if (panelId && actionKind) values.add(`${panelId}.${actionKind}`);
      if (panelId && actionId) values.add(`${panelId}.${actionId}`);
    }
    for (const receiptCapabilityId of readStringArray(envelope.receipt_capability_ids)) {
      values.add(receiptCapabilityId);
    }
  }
  return [...values].sort();
};

export const summarizeUiDebugParityGoalAcceptance = (
  results: Array<Record<string, unknown>>,
): {
  ok: boolean;
  calculator_pair_selected: boolean;
  calculator_pair_skipped_reason: string | null;
  calculator_pair_failures: string[];
  docs_locate_selected: boolean;
  docs_locate_skipped_reason: string | null;
  docs_locate_failures: string[];
  visual_context_selected: boolean;
  visual_context_skipped_reason: string | null;
  visual_context_failures: string[];
} => {
  const natural = uiHarnessResultByPrompt(results, HELIX_ASK_NATURAL_CALCULATOR_PROMPT);
  const explicit = uiHarnessResultByPrompt(results, HELIX_ASK_EXPLICIT_CALCULATOR_PROMPT);
  const calculatorPair = (() => {
    if (!natural && !explicit) {
      return {
        selected: false,
        skippedReason: "calculator_pair_not_selected",
        failures: [] as string[],
      };
    }
    if (!natural || !explicit) {
      return {
        selected: false,
        skippedReason: natural ? "explicit_calculator_prompt_not_selected" : "natural_calculator_prompt_not_selected",
        failures: [] as string[],
      };
    }
    if (resultHasStaleServerBundleWarning(natural) || resultHasStaleServerBundleWarning(explicit)) {
      return {
        selected: true,
        skippedReason: "stale_server_bundle",
        failures: [] as string[],
      };
    }
    if (resultHasCapacityAdmissionWarning(natural) || resultHasCapacityAdmissionWarning(explicit)) {
      return {
        selected: true,
        skippedReason: "capacity_or_admission_stress",
        failures: [] as string[],
      };
    }

    const failures: string[] = [];
    const naturalRail = uiHarnessRailTable(natural);
    const explicitRail = uiHarnessRailTable(explicit);
    for (const field of ["executed_capability", "observation_kind"] as const) {
      const naturalValue = readString(naturalRail?.[field]);
      const explicitValue = readString(explicitRail?.[field]);
      if (!naturalValue || !explicitValue) {
        failures.push(`ui_calculator_natural_explicit_${field}_missing`);
      } else if (naturalValue !== explicitValue) {
        failures.push(`ui_calculator_natural_explicit_${field}_mismatch:${naturalValue}!=${explicitValue}`);
      }
    }

    const naturalTerminalKind = uiHarnessTerminalKind(natural, naturalRail);
    const explicitTerminalKind = uiHarnessTerminalKind(explicit, explicitRail);
    if (!naturalTerminalKind || !explicitTerminalKind) {
      failures.push("ui_calculator_natural_explicit_terminal_kind_missing");
    } else if (naturalTerminalKind !== explicitTerminalKind) {
      failures.push(`ui_calculator_natural_explicit_terminal_kind_mismatch:${naturalTerminalKind}!=${explicitTerminalKind}`);
    }

    if (!uiHarnessMentionsCalculatorResult14(natural)) {
      failures.push("ui_calculator_natural_expected_result_14_missing");
    }
    if (!uiHarnessMentionsCalculatorResult14(explicit)) {
      failures.push("ui_calculator_explicit_expected_result_14_missing");
    }
    for (const [label, result] of [
      ["natural", natural],
      ["explicit", explicit],
    ] as const) {
      const actionEnvelopeCapabilities = uiHarnessActionEnvelopeCapabilities(result);
      if (!actionEnvelopeCapabilities.includes("scientific-calculator.open_panel")) {
        failures.push(`ui_calculator_${label}_open_panel_action_receipt_missing`);
      }
      if (!actionEnvelopeCapabilities.includes("scientific-calculator.focus_panel")) {
        failures.push(`ui_calculator_${label}_focus_panel_action_receipt_missing`);
      }
    }

    return { selected: true, skippedReason: null, failures };
  })();

  const docsLocate = (() => {
    const result = uiHarnessResultByPrompt(results, HELIX_ASK_DOCS_LOCATE_PROMPT);
    if (!result) return { selected: false, skippedReason: "docs_locate_prompt_not_selected", failures: [] as string[] };
    if (resultHasStaleServerBundleWarning(result)) return { selected: true, skippedReason: "stale_server_bundle", failures: [] as string[] };
    if (resultHasCapacityAdmissionWarning(result)) {
      return { selected: true, skippedReason: "capacity_or_admission_stress", failures: [] as string[] };
    }

    const failures: string[] = [];
    const rail = uiHarnessRailTable(result);
    const terminalKind = uiHarnessTerminalKind(result, rail);
    const terminalError = uiHarnessTerminalError(result);
    const visibleAnswer = uiHarnessVisibleAnswer(result);
    const railStatus = readString(rail?.rail_status);
    const codexParityClass = readString(rail?.codex_parity_class);
    const railFailureCode = readString(rail?.rail_failure_code);
    const firstBrokenRail = readString(rail?.first_broken_rail);
    const observationKind = readString(rail?.observation_kind);
    if (terminalError === "terminal_projection_mismatch" || /terminal authority and visible projection selected different artifacts/i.test(visibleAnswer)) {
      failures.push("ui_docs_locate_terminal_projection_mismatch");
    }
    if (railStatus === "fail_closed" || codexParityClass === "broken") {
      if (!firstBrokenRail) failures.push("ui_docs_locate_fail_closed_first_broken_rail_missing");
      if (!railFailureCode) failures.push("ui_docs_locate_fail_closed_failure_code_missing");
      if (railFailureCode === "terminal_projection_mismatch") {
        failures.push("ui_docs_locate_fail_closed_as_terminal_projection_mismatch");
      }
      return { selected: true, skippedReason: null, failures };
    }

    if (railStatus === "complete" || codexParityClass === "complete") {
      if (terminalKind === "typed_failure") failures.push("ui_docs_locate_complete_typed_failure_terminal");
      if (rail?.observed_artifact_supports_requested_capability !== true) {
        failures.push("ui_docs_locate_complete_without_requested_observation_support");
      }
      if (!/doc_(?:location|evidence)/i.test([terminalKind, observationKind].join("\n"))) {
        failures.push(`ui_docs_locate_unexpected_terminal_or_observation:${terminalKind || "missing"}/${observationKind || "missing"}`);
      }
      return { selected: true, skippedReason: null, failures };
    }

    failures.push(`ui_docs_locate_no_complete_or_fail_closed_rail:${railStatus || codexParityClass || "missing"}`);
    return { selected: true, skippedReason: null, failures };
  })();

  const visualContext = (() => {
    const result = uiHarnessResultByPrompt(results, HELIX_ASK_VISUAL_CONTEXT_PROMPT);
    if (!result) return { selected: false, skippedReason: "visual_context_prompt_not_selected", failures: [] as string[] };
    if (resultHasStaleServerBundleWarning(result)) return { selected: true, skippedReason: "stale_server_bundle", failures: [] as string[] };
    if (resultHasCapacityAdmissionWarning(result)) {
      return { selected: true, skippedReason: "capacity_or_admission_stress", failures: [] as string[] };
    }

    const failures: string[] = [];
    const rail = uiHarnessRailTable(result);
    const terminalKind = uiHarnessTerminalKind(result, rail);
    const terminalError = uiHarnessTerminalError(result);
    const haystack = [
      terminalKind,
      terminalError,
      uiHarnessVisibleAnswer(result),
      readString(rail?.observation_kind),
      readString(rail?.rail_failure_code),
    ].join("\n");
    const hasVisualAnswerArtifact =
      /\b(?:situation_context_pack|visual_frame_evidence|visual_analysis_turn_item|live_visual_answer|field_evaluation|situation_run)\b/i.test(
        haystack,
      );
    const identifiesMissingVisualContext =
      /\b(?:visual_evidence_missing|missing_visual_observation|visual evidence (?:is )?(?:missing|not ready|unavailable)|browser\/UI visual source context was not available|visual source (?:context )?(?:is )?(?:missing|not available|unavailable|not ready)|need an active visual SituationRun|field evaluations? (?:are )?missing|source context (?:is )?(?:missing|not available|unavailable))\b/i.test(
        haystack,
      );
    const forbiddenTerminal =
      /^(?:direct_answer_text|model_synthesized_answer|model_only_concept|no_tool_direct|live_pipeline_receipt|client_projection|process_graph_overview)$/i.test(
        terminalKind,
      );
    if (!hasVisualAnswerArtifact && !identifiesMissingVisualContext) {
      failures.push("ui_visual_prompt_missing_source_context_not_identified");
    }
    if (forbiddenTerminal && !identifiesMissingVisualContext) {
      failures.push(`ui_visual_prompt_terminalized_without_visual_source_context:${terminalKind}`);
    }
    return { selected: true, skippedReason: null, failures };
  })();

  const allFailures = [...calculatorPair.failures, ...docsLocate.failures, ...visualContext.failures];

  return {
    ok: allFailures.length === 0,
    calculator_pair_selected: calculatorPair.selected,
    calculator_pair_skipped_reason: calculatorPair.skippedReason,
    calculator_pair_failures: calculatorPair.failures,
    docs_locate_selected: docsLocate.selected,
    docs_locate_skipped_reason: docsLocate.skippedReason,
    docs_locate_failures: docsLocate.failures,
    visual_context_selected: visualContext.selected,
    visual_context_skipped_reason: visualContext.skippedReason,
    visual_context_failures: visualContext.failures,
  };
};

const getPath = (value: unknown, pathParts: string[]): unknown =>
  pathParts.reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);

const normalizeParityText = (value: string): string =>
  value.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();

const firstNonEmptyString = (...values: unknown[]): string => {
  for (const value of values) {
    const text = readString(value);
    if (text) return text;
  }
  return "";
};

const expectedCompoundSubgoalCount = (
  ...rails: Array<Record<string, unknown> | null | undefined>
): number => {
  let count = 0;
  for (const rail of rails) {
    const value = readNonNegativeInteger(rail?.compound_subgoal_count);
    if (value !== null && value > count) count = value;
  }
  return count;
};

export const buildUiApiParitySessionId = (input: {
  configuredSessionId?: string | null;
  prompt: string;
  turnId?: string | null;
  index?: number;
}): string => {
  const configured = input.configuredSessionId?.trim();
  if (configured) return configured;
  const stablePrompt = input.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
  const turn = input.turnId?.trim().replace(/[^a-zA-Z0-9:_-]+/g, "-").slice(0, 80);
  const suffix = turn || stablePrompt || `prompt-${input.index ?? 0}`;
  return `helix-ask:ui-api-parity:${suffix}`;
};

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
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

const collectCoverageArtifacts = (debugExport: Record<string, unknown> | null): unknown[] => {
  if (!debugExport) return [];
  if (Array.isArray(debugExport.coverage_artifacts)) return debugExport.coverage_artifacts;
  const ledger = Array.isArray(debugExport.current_turn_artifact_ledger) ? debugExport.current_turn_artifact_ledger : [];
  return ledger.filter((entry) => {
    const kind = readString(asRecord(entry)?.kind);
    return kind === "calculator_plan_coverage" || /_coverage$/.test(kind);
  });
};

export const collectUiDebugRailCandidates = (
  debugExport: Record<string, unknown> | null,
): Record<string, unknown>[] => {
  const payload = asRecord(debugExport?.payload);
  return [
    asRecord(debugExport?.codex_parity_agent_spine_rail_table),
    asRecord(getPath(debugExport, ["debug", "codex_parity_agent_spine_rail_table"])),
    asRecord(getPath(debugExport, ["artifact_query_index", "codex_parity_agent_spine_rail_table"])),
    asRecord(getPath(debugExport, ["debug", "artifact_query_index", "codex_parity_agent_spine_rail_table"])),
    asRecord(payload?.codex_parity_agent_spine_rail_table),
    asRecord(getPath(payload, ["debug", "codex_parity_agent_spine_rail_table"])),
    asRecord(getPath(payload, ["artifact_query_index", "codex_parity_agent_spine_rail_table"])),
    asRecord(getPath(payload, ["debug", "artifact_query_index", "codex_parity_agent_spine_rail_table"])),
  ].filter((entry): entry is Record<string, unknown> => Boolean(entry));
};

const asRecordArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];

export const collectUiDebugCompoundSubgoalRailStatuses = (
  debugExport: Record<string, unknown> | null,
): Record<string, unknown>[] => {
  const payload = asRecord(debugExport?.payload);
  for (const candidate of [
    debugExport?.compound_subgoal_rail_statuses,
    getPath(debugExport, ["debug", "compound_subgoal_rail_statuses"]),
    getPath(debugExport, ["artifact_query_index", "compound_subgoal_rail_statuses"]),
    getPath(debugExport, ["debug", "artifact_query_index", "compound_subgoal_rail_statuses"]),
    payload?.compound_subgoal_rail_statuses,
    getPath(payload, ["debug", "compound_subgoal_rail_statuses"]),
    getPath(payload, ["artifact_query_index", "compound_subgoal_rail_statuses"]),
    getPath(payload, ["debug", "artifact_query_index", "compound_subgoal_rail_statuses"]),
  ]) {
    const records = asRecordArray(candidate);
    if (records.length > 0) return records;
  }
  return [];
};

const findRailTable = (debugExport: Record<string, unknown> | null): Record<string, unknown> | null =>
  collectUiDebugRailCandidates(debugExport)[0] ?? null;

const compoundSubgoalRailComparisonFields = [
  "subgoal_id",
  "order",
  "requested_capability",
  "runtime_capability",
  "selected_capability",
  "executed_capability",
  "args",
  "args_source",
  "planned_args",
  "selected_args",
  "required_args",
  "optional_args",
  "input_bindings",
  "bound_input_refs",
  "unresolved_input_bindings",
  "observation_kind",
  "observation_ref",
  "observation_provenance",
  "support_refs",
  "required_observation_kinds",
  "required_terminal_kind",
  "terminal_contribution_kind",
  "contribution_role",
  "allowed_substitutions",
  "forbidden_nearby_capabilities",
  "satisfaction",
  "rail_status",
  "first_broken_rail",
  "rail_failure_code",
  "repair_target",
] as const;

const comparableCompoundSubgoalRails = (
  rails: Record<string, unknown>[],
): Array<Record<string, unknown>> =>
  rails.map((rail) =>
    Object.fromEntries(
      compoundSubgoalRailComparisonFields.map((field) => [
        field,
        comparableRailValue(rail[field]),
      ]),
    ),
  );

const compoundSubgoalRailProofViolations = (
  source: "ui" | "api",
  rails: Record<string, unknown>[],
): string[] => {
  const violations: string[] = [];
  rails.forEach((rail, index) => {
    const prefix = `${source}_compound_subgoal_${index + 1}`;
    const satisfaction = readString(rail.satisfaction);
    const railStatus = readString(rail.rail_status);
    const observationRef = readString(rail.observation_ref);
    if (satisfaction === "satisfied" && !observationRef) {
      violations.push(`${prefix}_satisfied_observation_ref_missing`);
    }
    if (railStatus === "complete") {
      if (satisfaction !== "satisfied") violations.push(`${prefix}_complete_satisfaction_not_satisfied`);
      if (!observationRef) violations.push(`${prefix}_complete_observation_ref_missing`);
    }
  });
  return violations;
};

const collectApiCompoundSubgoalRailStatuses = (
  apiResponse: Record<string, unknown> | null,
  apiDebugExport: Record<string, unknown> | null,
): Record<string, unknown>[] => {
  for (const candidate of [
    apiResponse?.compound_subgoal_rail_statuses,
    getPath(apiResponse, ["artifact_query_index", "compound_subgoal_rail_statuses"]),
    getPath(apiResponse, ["debug", "compound_subgoal_rail_statuses"]),
    getPath(apiResponse, ["debug", "artifact_query_index", "compound_subgoal_rail_statuses"]),
  ]) {
    const records = asRecordArray(candidate);
    if (records.length > 0) return records;
  }
  return collectUiDebugCompoundSubgoalRailStatuses(apiDebugExport);
};

const readTerminalArtifactKind = (
  response: Record<string, unknown> | null,
  debugExport: Record<string, unknown> | null,
): string =>
  firstNonEmptyString(
    response?.terminal_artifact_kind,
    getPath(response, ["terminal_answer_authority", "terminal_artifact_kind"]),
    debugExport?.terminal_artifact_kind,
    getPath(debugExport, ["terminal_answer_authority", "terminal_artifact_kind"]),
    getPath(debugExport, ["payload", "terminal_artifact_kind"]),
    getPath(debugExport, ["payload", "terminal_answer_authority", "terminal_artifact_kind"]),
    getPath(debugExport, ["resolved_turn_summary", "terminal_artifact_kind"]),
  );

const readTerminalErrorCode = (
  response: Record<string, unknown> | null,
  debugExport: Record<string, unknown> | null,
): string =>
  firstNonEmptyString(
    response?.terminal_error_code,
    debugExport?.terminal_error_code,
    getPath(debugExport, ["payload", "terminal_error_code"]),
    getPath(debugExport, ["resolved_turn_summary", "terminal_error_code"]),
  );

const readVisibleFinalText = (
  response: Record<string, unknown> | null,
  debugExport: Record<string, unknown> | null,
): string =>
  firstNonEmptyString(
    getPath(debugExport, ["ui_debug_parity_harness", "visible_final_answer"]),
    response?.selected_final_answer,
    debugExport?.selected_final_answer,
    getPath(response, ["terminal_answer_authority", "terminal_text_preview"]),
    getPath(debugExport, ["terminal_answer_authority", "terminal_text_preview"]),
    response?.answer,
    response?.text,
    response?.content,
  );

const readTurnId = (response: Record<string, unknown> | null, debugExport: Record<string, unknown> | null): string =>
  firstNonEmptyString(
    response?.turn_id,
    response?.active_turn_id,
    debugExport?.turn_id,
    debugExport?.active_turn_id,
    getPath(debugExport, ["payload", "turn_id"]),
    getPath(debugExport, ["payload", "active_turn_id"]),
  );

const readServerBuildStartedAtMs = (
  response: Record<string, unknown> | null,
  debugExport: Record<string, unknown> | null,
): number | null =>
  readNonNegativeInteger(response?.server_build_started_at_ms) ??
  readNonNegativeInteger(debugExport?.server_build_started_at_ms) ??
  readNonNegativeInteger(getPath(debugExport, ["payload", "server_build_started_at_ms"])) ??
  readNonNegativeInteger(getPath(debugExport, ["debug", "server_build_started_at_ms"])) ??
  readNonNegativeInteger(getPath(debugExport, ["payload", "debug", "server_build_started_at_ms"]));

const readPrompt = (response: Record<string, unknown> | null, debugExport: Record<string, unknown> | null): string =>
  firstNonEmptyString(
    response?.question,
    response?.prompt,
    response?.active_prompt,
    debugExport?.active_prompt,
    getPath(debugExport, ["payload", "active_prompt"]),
    getPath(debugExport, ["payload", "selectedDebugQuestion"]),
  );

export const collectUiApiTerminalParityViolations = (input: {
  uiDebugExport: Record<string, unknown> | null;
  apiResponse: Record<string, unknown> | null;
  apiDebugExport?: Record<string, unknown> | null;
  uiVisibleFinalAnswer?: string;
  requireSameTurnText?: boolean;
}): string[] => {
  const violations: string[] = [];
  const uiDebugExport = input.uiDebugExport;
  const apiResponse = input.apiResponse;
  const apiDebugExport = input.apiDebugExport ?? null;
  if (!uiDebugExport) violations.push("ui_debug_export_missing");
  if (!apiResponse) violations.push("api_response_missing");
  if (!uiDebugExport || !apiResponse) return violations;

  const uiPrompt = readPrompt(null, uiDebugExport);
  const apiPrompt = readPrompt(apiResponse, apiDebugExport);
  if (uiPrompt && apiPrompt && normalizeParityText(uiPrompt) !== normalizeParityText(apiPrompt)) {
    violations.push("ui_api_prompt_mismatch");
  }

  const uiKind = readTerminalArtifactKind(null, uiDebugExport);
  const apiKind = readTerminalArtifactKind(apiResponse, apiDebugExport);
  if (uiKind && apiKind && uiKind !== apiKind) {
    violations.push(`ui_api_terminal_kind_mismatch:${uiKind}!=${apiKind}`);
  }

  const uiError = readTerminalErrorCode(null, uiDebugExport);
  const apiError = readTerminalErrorCode(apiResponse, apiDebugExport);
  if (uiError !== apiError) {
    violations.push(`ui_api_terminal_error_mismatch:${uiError || "null"}!=${apiError || "null"}`);
  }

  const uiRail = findRailTable(uiDebugExport);
  const apiRail = findRailTable(apiDebugExport) ?? asRecord(apiResponse.codex_parity_agent_spine_rail_table);
  const railFields = [
    "requested_capability",
    "selected_capability",
    "executed_capability",
    "compound_subgoal_count",
    ...UI_DEBUG_COMPOUND_STRING_OR_NULL_FIELDS,
    "compound_incomplete_subgoal_did_tool_run",
    "observation_kind",
    "selected_terminal_kind",
    "visible_terminal_kind",
    "rail_status",
    "rail_failure_code",
  ] as const;
  if (uiRail && apiRail) {
    for (const field of railFields) {
      const uiValue = comparableRailValue(uiRail[field]);
      const apiValue = comparableRailValue(apiRail[field]);
      if (JSON.stringify(uiValue) !== JSON.stringify(apiValue)) {
        violations.push(`ui_api_rail_${field}_mismatch:${String(uiValue ?? "null")}!=${String(apiValue ?? "null")}`);
      }
    }
  }
  const uiCompoundSubgoalRails = collectUiDebugCompoundSubgoalRailStatuses(uiDebugExport);
  const apiCompoundSubgoalRails = collectApiCompoundSubgoalRailStatuses(apiResponse, apiDebugExport);
  violations.push(...compoundSubgoalRailProofViolations("ui", uiCompoundSubgoalRails));
  violations.push(...compoundSubgoalRailProofViolations("api", apiCompoundSubgoalRails));
  const expectedSubgoalCount = expectedCompoundSubgoalCount(uiRail, apiRail);
  if (expectedSubgoalCount > 0) {
    if (uiCompoundSubgoalRails.length < expectedSubgoalCount) {
      violations.push(
        `ui_compound_subgoal_rails_missing:${uiCompoundSubgoalRails.length}<${expectedSubgoalCount}`,
      );
    }
    if (apiCompoundSubgoalRails.length < expectedSubgoalCount) {
      violations.push(
        `api_compound_subgoal_rails_missing:${apiCompoundSubgoalRails.length}<${expectedSubgoalCount}`,
      );
    }
  }
  if (uiCompoundSubgoalRails.length > 0 || apiCompoundSubgoalRails.length > 0) {
    const uiComparableRails = comparableCompoundSubgoalRails(uiCompoundSubgoalRails);
    const apiComparableRails = comparableCompoundSubgoalRails(apiCompoundSubgoalRails);
    if (JSON.stringify(uiComparableRails) !== JSON.stringify(apiComparableRails)) {
      violations.push("ui_api_compound_subgoal_rails_mismatch");
    }
  }

  const uiTurnId = readTurnId(null, uiDebugExport);
  const apiTurnId = readTurnId(apiResponse, apiDebugExport);
  const shouldCompareText = input.requireSameTurnText === true || Boolean(uiTurnId && apiTurnId && uiTurnId === apiTurnId);
  if (shouldCompareText) {
    const uiText = normalizeParityText(input.uiVisibleFinalAnswer ?? readVisibleFinalText(null, uiDebugExport));
    const apiText = normalizeParityText(readVisibleFinalText(apiResponse, apiDebugExport));
    if (uiText && apiText && uiText !== apiText) {
      violations.push("ui_api_visible_answer_mismatch");
    }
  }

  return violations;
};

const RAIL_MIRROR_COMPARISON_FIELDS = [
  "schema",
  "turn_id",
  "prompt",
  "requested_capability",
  "visible_tool_surface",
  "visible_tool_surface_original_count",
  "visible_tool_surface_truncated",
  "selected_capability",
  "admitted_capability",
  "admission_proof_source",
  "admission_proven",
  "executed_capability",
  "compound_subgoal_count",
  ...UI_DEBUG_COMPOUND_STRING_OR_NULL_FIELDS,
  "compound_incomplete_subgoal_did_tool_run",
  "observation_kind",
  "observation_ref",
  "required_observation_kinds_for_requested_capability",
  "observed_artifact_supports_requested_capability",
  "reentry_status",
  "reentry_proof_source",
  "reentry_proven",
  "goal_satisfaction",
  "required_terminal_kind",
  "selected_terminal_kind",
  "terminal_authority_proof_source",
  "terminal_authority_proven",
  "visible_terminal_kind",
  "visible_projection_source",
  "visible_projection_proven",
  "codex_parity_class",
  "first_broken_rail",
  "repair_target",
  "rail_status",
  "rail_failure_code",
  "normalized_codex_parity_classes",
  "assistant_answer",
  "terminal_eligible",
  "raw_content_included",
] as const;

const comparableRailValue = (value: unknown): unknown => value === undefined ? null : value;

export const collectUiDebugRailMirrorViolations = (
  railTables: Record<string, unknown>[],
): string[] => {
  if (railTables.length < 2) return [];
  const violations: string[] = [];
  const base = railTables[0];
  for (const [index, railTable] of railTables.entries()) {
    if (index === 0) continue;
    for (const key of RAIL_MIRROR_COMPARISON_FIELDS) {
      const baseValue = comparableRailValue(base[key]);
      const mirrorValue = comparableRailValue(railTable[key]);
      if (JSON.stringify(baseValue) !== JSON.stringify(mirrorValue)) {
        violations.push(`rail_mirror_${index}_${key}_mismatch:${String(mirrorValue ?? "null")}!=${String(baseValue ?? "null")}`);
      }
    }
  }
  return violations;
};

export const collectRailTableViolations = (
  railTable: Record<string, unknown> | null,
  terminalAuthority: Record<string, unknown> | null,
  turnId?: string | null,
  debugTerminalKind?: string | null,
): string[] => {
  if (!railTable) return ["codex_parity_agent_spine_rail_table_missing"];
  const violations: string[] = [];
  if (railTable.schema !== CODEX_PARITY_AGENT_SPINE_RAIL_TABLE_SCHEMA) {
    violations.push("codex_parity_agent_spine_rail_table_schema_mismatch");
  }
  if (turnId && readString(railTable.turn_id) !== turnId) {
    violations.push(`rail_turn_id_mismatch:${readString(railTable.turn_id) || "missing"}!=${turnId}`);
  }
  if (railTable.assistant_answer !== false) violations.push("rail_assistant_answer_not_false");
  if (railTable.terminal_eligible !== false) violations.push("rail_terminal_eligible_not_false");
  if (railTable.raw_content_included !== false) violations.push("rail_raw_content_included_not_false");
  if (!Array.isArray(railTable.visible_tool_surface)) {
    violations.push("rail_visible_tool_surface_missing");
  } else if (!isNonEmptyStringArray(railTable.visible_tool_surface)) {
    violations.push("rail_visible_tool_surface_entries_invalid");
  }
  const visibleSurfaceCount = readNonNegativeInteger(railTable.visible_tool_surface_original_count);
  const visibleSurfaceTruncated =
    typeof railTable.visible_tool_surface_truncated === "boolean" ? railTable.visible_tool_surface_truncated : null;
  if (visibleSurfaceCount === null) {
    violations.push("rail_visible_tool_surface_original_count_invalid");
  }
  if (visibleSurfaceTruncated === null) {
    violations.push("rail_visible_tool_surface_truncated_invalid");
  }
  if (Array.isArray(railTable.visible_tool_surface) && visibleSurfaceCount !== null) {
    const visibleSurfaceLength = railTable.visible_tool_surface.length;
    if (visibleSurfaceCount < visibleSurfaceLength) {
      violations.push("rail_visible_tool_surface_original_count_less_than_surface");
    }
    if (visibleSurfaceTruncated === true && visibleSurfaceCount <= visibleSurfaceLength) {
      violations.push("rail_visible_tool_surface_truncated_without_hidden_entries");
    }
    if (visibleSurfaceTruncated === false && visibleSurfaceCount !== visibleSurfaceLength) {
      violations.push("rail_visible_tool_surface_untruncated_count_mismatch");
    }
  }
  if (!Array.isArray(railTable.required_observation_kinds_for_requested_capability)) {
    violations.push("rail_required_observation_kinds_missing");
  } else if (!isNonEmptyStringArray(railTable.required_observation_kinds_for_requested_capability)) {
    violations.push("rail_required_observation_kinds_entries_invalid");
  }
  if (!isNonEmptyStringArray(railTable.normalized_codex_parity_classes)) {
    violations.push("rail_normalized_codex_parity_classes_entries_invalid");
  }
  for (const key of CODEX_PARITY_AGENT_SPINE_STRING_OR_NULL_FIELDS) {
    const value = railTable[key];
    if (value !== null && typeof value !== "string") {
      violations.push(`rail_string_or_null_field_invalid:${key}`);
    }
  }
  if (!CODEX_PARITY_AGENT_SPINE_REENTRY_STATUSES.includes(railTable.reentry_status as never)) {
    violations.push("rail_reentry_status_invalid");
  }
  if (!CODEX_PARITY_AGENT_SPINE_RAIL_STATUSES.includes(railTable.rail_status as never)) {
    violations.push("rail_status_invalid");
  }
  const firstBrokenRail = readString(railTable.first_broken_rail);
  if (
    firstBrokenRail &&
    !CODEX_PARITY_AGENT_SPINE_FIRST_BROKEN_RAILS.includes(
      firstBrokenRail as (typeof CODEX_PARITY_AGENT_SPINE_FIRST_BROKEN_RAILS)[number],
    )
  ) {
    violations.push("rail_first_broken_rail_invalid");
  }
  const repairTarget = readString(railTable.repair_target);
  if (
    repairTarget &&
    !CODEX_PARITY_AGENT_SPINE_REPAIR_TARGETS.includes(
      repairTarget as (typeof CODEX_PARITY_AGENT_SPINE_REPAIR_TARGETS)[number],
    )
  ) {
    violations.push("rail_repair_target_invalid");
  }
  const compoundSubgoalCount = readNonNegativeInteger(railTable.compound_subgoal_count);
  const railStatus = readString(railTable.rail_status);
  const firstIncompleteCompoundSubgoalId = readString(railTable.first_incomplete_compound_subgoal_id);
  const firstIncompleteCompoundRequestedCapability = readString(railTable.first_incomplete_compound_requested_capability);
  const firstIncompleteCompoundRuntimeCapability = readString(railTable.first_incomplete_compound_runtime_capability);
  const compoundFirstBrokenRail = readString(railTable.compound_first_broken_rail);
  const compoundRailFailureCode = readString(railTable.compound_rail_failure_code);
  const compoundRepairTarget = readString(railTable.compound_repair_target);
  const compoundDidToolRun =
    typeof railTable.compound_incomplete_subgoal_did_tool_run === "boolean"
      ? railTable.compound_incomplete_subgoal_did_tool_run
      : null;
  const compoundMirrorDeclared =
    railTable.compound_subgoal_count !== undefined ||
    firstIncompleteCompoundSubgoalId !== null ||
    firstIncompleteCompoundRequestedCapability !== null ||
    firstIncompleteCompoundRuntimeCapability !== null ||
    compoundFirstBrokenRail !== null ||
    compoundRailFailureCode !== null ||
    compoundRepairTarget !== null ||
    railTable.compound_incomplete_subgoal_did_tool_run !== undefined;
  if (compoundSubgoalCount === null && compoundMirrorDeclared) {
    violations.push("rail_compound_subgoal_count_invalid");
  }
  if (compoundMirrorDeclared) {
    for (const key of CODEX_PARITY_AGENT_SPINE_COMPOUND_STRING_OR_NULL_FIELDS) {
      const value = railTable[key];
      if (value !== null && typeof value !== "string") {
        violations.push(`rail_compound_string_or_null_field_invalid:${key}`);
      }
    }
  }
  if (compoundSubgoalCount === 0) {
    if (firstIncompleteCompoundSubgoalId) violations.push("rail_noncompound_first_incomplete_subgoal_present");
    if (compoundFirstBrokenRail) violations.push("rail_noncompound_first_broken_rail_present");
    if (compoundRailFailureCode) violations.push("rail_noncompound_rail_failure_code_present");
    if (compoundRepairTarget) violations.push("rail_noncompound_repair_target_present");
    if (compoundDidToolRun !== null) violations.push("rail_noncompound_did_tool_run_present");
  }
  if (compoundSubgoalCount !== null && compoundSubgoalCount > 0 && railStatus === "complete") {
    if (firstIncompleteCompoundSubgoalId) violations.push("rail_complete_compound_first_incomplete_subgoal_present");
    if (compoundFirstBrokenRail) violations.push("rail_complete_compound_first_broken_rail_present");
    if (compoundRailFailureCode) violations.push("rail_complete_compound_rail_failure_code_present");
    if (compoundRepairTarget) violations.push("rail_complete_compound_repair_target_present");
    if (compoundDidToolRun !== null) violations.push("rail_complete_compound_did_tool_run_present");
  }
  if (compoundSubgoalCount !== null && compoundSubgoalCount > 0 && railStatus !== "complete") {
    if (!firstIncompleteCompoundSubgoalId) violations.push("rail_incomplete_compound_first_incomplete_subgoal_missing");
    if (!firstIncompleteCompoundRequestedCapability) violations.push("rail_incomplete_compound_requested_capability_missing");
    if (!firstIncompleteCompoundRuntimeCapability) violations.push("rail_incomplete_compound_runtime_capability_missing");
    if (!compoundFirstBrokenRail) violations.push("rail_incomplete_compound_first_broken_rail_missing");
    if (!compoundRailFailureCode) violations.push("rail_incomplete_compound_rail_failure_code_missing");
    if (!compoundRepairTarget) violations.push("rail_incomplete_compound_repair_target_missing");
    if (compoundDidToolRun === null) violations.push("rail_incomplete_compound_did_tool_run_missing");
  }
  if (
    compoundFirstBrokenRail &&
    !CODEX_PARITY_AGENT_SPINE_FIRST_BROKEN_RAILS.includes(
      compoundFirstBrokenRail as (typeof CODEX_PARITY_AGENT_SPINE_FIRST_BROKEN_RAILS)[number],
    )
  ) {
    violations.push("rail_compound_first_broken_rail_invalid");
  }
  if (
    compoundRepairTarget &&
    !CODEX_PARITY_AGENT_SPINE_REPAIR_TARGETS.includes(
      compoundRepairTarget as (typeof CODEX_PARITY_AGENT_SPINE_REPAIR_TARGETS)[number],
    )
  ) {
    violations.push("rail_compound_repair_target_invalid");
  }
  if (compoundRailFailureCode && !isCodexParityAgentSpineRailFailureCode(compoundRailFailureCode)) {
    violations.push("rail_compound_rail_failure_code_invalid");
  }
  const railFailureCode = readString(railTable.rail_failure_code);
  if (railFailureCode && !isCodexParityAgentSpineRailFailureCode(railFailureCode)) {
    violations.push("rail_failure_code_invalid");
  }
  const normalizedClasses = readStringArray(railTable.normalized_codex_parity_classes);
  if (JSON.stringify(normalizedClasses) !== JSON.stringify(CODEX_PARITY_AGENT_SPINE_CLASSES)) {
    violations.push("rail_normalized_codex_parity_classes_mismatch");
  }
  const codexParityClass = readString(railTable.codex_parity_class);
  if (!CODEX_PARITY_AGENT_SPINE_CLASSES.includes(codexParityClass as (typeof CODEX_PARITY_AGENT_SPINE_CLASSES)[number])) {
    violations.push("rail_codex_parity_class_invalid");
  }
  const selectedCapability = readString(railTable.selected_capability);
  const admittedCapability = readString(railTable.admitted_capability);
  const executedCapability = readString(railTable.executed_capability);
  const requestedCapability = readString(railTable.requested_capability);
  const goalSatisfaction = readString(railTable.goal_satisfaction);
  const requiredObservationKinds = readStringArray(railTable.required_observation_kinds_for_requested_capability);
  const observationSupportsRequested = railTable.observed_artifact_supports_requested_capability;
  const admissionProofSource = readString(railTable.admission_proof_source);
  if ((selectedCapability || executedCapability) && !admittedCapability) {
    violations.push("rail_admitted_capability_missing");
  }
  if (admittedCapability && !admissionProofSource) {
    violations.push("rail_admission_proof_source_missing");
  }
  if (admittedCapability && railTable.admission_proven !== true) {
    violations.push("rail_admission_not_proven");
  }
  if (requestedCapability && requiredObservationKinds.length === 0) {
    violations.push("rail_requested_observation_kinds_empty");
  }
  if (requestedCapability && typeof observationSupportsRequested !== "boolean") {
    violations.push("rail_observation_support_verdict_missing");
  }
  if (
    requestedCapability &&
    (goalSatisfaction === "satisfied" || readString(railTable.rail_status) === "complete" || codexParityClass === "complete") &&
    requiredObservationKinds.length > 0 &&
    observationSupportsRequested !== true
  ) {
    violations.push("rail_goal_satisfied_without_requested_observation_support");
  }
  const reentryStatus = readString(railTable.reentry_status);
  const reentryProofSource = readString(railTable.reentry_proof_source);
  if (reentryStatus === "reentered" && !reentryProofSource) {
    violations.push("rail_reentry_proof_source_missing");
  }
  if (reentryStatus === "reentered" && railTable.reentry_proven !== true) {
    violations.push("rail_reentry_not_proven");
  }
  if ((codexParityClass === "complete" || readString(railTable.rail_status) === "complete") && reentryStatus !== "reentered") {
    violations.push("rail_complete_without_reentry");
  }
  if ((readString(railTable.rail_status) === "complete") !== (codexParityClass === "complete")) {
    violations.push("rail_completion_status_class_mismatch");
  }
  if (codexParityClass === "complete" && firstBrokenRail) {
    violations.push("rail_complete_with_first_broken_rail");
  }
  if (codexParityClass && codexParityClass !== "complete" && !firstBrokenRail) {
    violations.push("rail_non_complete_without_first_broken_rail");
  }
  if (codexParityClass && codexParityClass !== "complete" && !railFailureCode) {
    violations.push("rail_non_complete_without_rail_failure_code");
  }
  if (codexParityClass && codexParityClass !== "complete" && !repairTarget) {
    violations.push("rail_non_complete_without_repair_target");
  }
  const selectedTerminalKind = readString(railTable.selected_terminal_kind);
  const visibleTerminalKind = readString(railTable.visible_terminal_kind);
  const terminalAuthorityProofSource = readString(railTable.terminal_authority_proof_source);
  const visibleProjectionSource = readString(railTable.visible_projection_source);
  if (selectedTerminalKind && !terminalAuthorityProofSource) {
    violations.push("rail_terminal_authority_proof_source_missing");
  }
  if (selectedTerminalKind && railTable.terminal_authority_proven !== true) {
    violations.push("rail_terminal_authority_not_proven");
  }
  if (visibleTerminalKind && !visibleProjectionSource) {
    violations.push("rail_visible_projection_source_missing");
  }
  if (visibleTerminalKind && railTable.visible_projection_proven !== true) {
    violations.push("rail_visible_projection_not_proven");
  }
  if ((codexParityClass === "complete" || readString(railTable.rail_status) === "complete") && !selectedTerminalKind) {
    violations.push("rail_complete_without_terminal_authority");
  }
  if ((codexParityClass === "complete" || readString(railTable.rail_status) === "complete") && !visibleTerminalKind) {
    violations.push("rail_complete_without_visible_projection");
  }
  if (selectedTerminalKind && visibleTerminalKind && selectedTerminalKind !== visibleTerminalKind) {
    violations.push("rail_selected_visible_terminal_kind_mismatch");
  }
  if (debugTerminalKind && selectedTerminalKind && debugTerminalKind !== selectedTerminalKind) {
    violations.push("rail_selected_terminal_debug_export_mismatch");
  }
  if (debugTerminalKind && visibleTerminalKind && debugTerminalKind !== visibleTerminalKind) {
    violations.push("rail_visible_terminal_debug_export_mismatch");
  }
  const terminalAuthorityKind =
    readString(terminalAuthority?.selected_terminal_artifact_kind) ||
    readString(terminalAuthority?.terminal_artifact_kind);
  if (terminalAuthorityKind && selectedTerminalKind && terminalAuthorityKind !== selectedTerminalKind) {
    violations.push("rail_terminal_authority_kind_mismatch");
  }
  return violations;
};

export const collectCompleteRailEnvelopeViolations = (input: {
  railTable: Record<string, unknown> | null;
  debugExport: Record<string, unknown> | null;
  visibleFinalAnswer: string;
}): string[] => {
  const railTable = input.railTable;
  if (!railTable) return [];
  const railComplete =
    readString(railTable.codex_parity_class) === "complete" ||
    readString(railTable.rail_status) === "complete";
  if (!railComplete) return [];
  const violations: string[] = [];
  const terminalErrorCode =
    readString(input.debugExport?.terminal_error_code) ||
    readString(getPath(input.debugExport, ["resolved_turn_summary", "terminal_error_code"]));
  const finalStatus = readString(input.debugExport?.final_status);
  const responseType = readString(input.debugExport?.response_type);
  const finalAnswerSource = readString(input.debugExport?.final_answer_source);
  const terminalKind =
    readString(input.debugExport?.terminal_artifact_kind) ||
    readString(getPath(input.debugExport, ["terminal_answer_authority", "terminal_artifact_kind"]));

  if (terminalErrorCode) violations.push(`complete_rail_terminal_error:${terminalErrorCode}`);
  if (finalAnswerSource === "typed_failure" || terminalKind === "typed_failure") {
    violations.push("complete_rail_typed_failure_terminal");
  }
  if ((finalStatus && finalStatus !== "final_answer") || (responseType && responseType !== "final_answer")) {
    violations.push(`complete_rail_non_final_response:${finalStatus ?? "missing"}/${responseType ?? "missing"}`);
  }
  if (!input.visibleFinalAnswer) violations.push("complete_rail_missing_visible_final_answer");
  return violations;
};

async function installClipboardFailureShim(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("harness_clipboard_write_denied");
        },
        readText: async () => {
          throw new Error("harness_clipboard_read_denied");
        },
      },
    });
  });
}

async function submitPrompt(page: Page, prompt: string): Promise<void> {
  const input = page.locator('textarea[aria-label="Ask Helix"]');
  await input.fill(prompt);
  await page.locator('button[aria-label="Submit prompt"]').click();
  await page.waitForFunction(
    (expected) => {
      const question = document.querySelector('[data-testid="helix-ask-latest-question"]')?.textContent ?? "";
      const final = document.querySelector('[data-testid="helix-ask-latest-final-answer"]');
      return question.includes(String(expected)) && Boolean(final);
    },
    prompt,
    { timeout: 90_000 },
  );
}

async function collectDebugExport(page: Page): Promise<Record<string, unknown> | null> {
  const debugButton = page.locator('[data-testid="helix-ask-latest-debug-copy"]');
  if ((await debugButton.count()) === 0) return null;
  await debugButton.click();
  await page.waitForFunction(
    () => Boolean((window as unknown as { __HELIX_LAST_UNIFIED_DEBUG_COPY__?: string }).__HELIX_LAST_UNIFIED_DEBUG_COPY__),
    undefined,
    { timeout: 15_000 },
  );
  const raw = await page.evaluate(() => (window as unknown as { __HELIX_LAST_UNIFIED_DEBUG_COPY__?: string }).__HELIX_LAST_UNIFIED_DEBUG_COPY__ ?? "");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function collectCalculatorPanelState(page: Page): Promise<Record<string, unknown> | null> {
  const log = page.locator('[data-testid="scientific-calculator-debug-log"]');
  if ((await log.count()) === 0) return null;
  return await log.evaluate((node) => {
    const element = node as HTMLElement;
    const events = [...element.querySelectorAll('[data-testid="scientific-calculator-debug-event"]')].map((entry) => ({
      text: (entry.textContent ?? "").trim(),
      compound_run_id: (entry as HTMLElement).dataset.compoundRunId ?? "",
      compound_subgoal_id: (entry as HTMLElement).dataset.compoundSubgoalId ?? "",
    }));
    return {
      current_compound_run_id: element.dataset.currentCompoundRunId ?? "",
      visible_compound_run_ids: (element.dataset.visibleCompoundRunIds ?? "").split(",").filter(Boolean),
      stale_compound_run_visible: element.dataset.staleCompoundRunVisible === "true",
      visible_events: events,
    };
  });
}

const runApiCompanionTurn = async (input: {
  prompt: string;
  sessionId: string;
}): Promise<{ response: Record<string, unknown> | null; debugExport: Record<string, unknown> | null }> => {
  const response = await fetchJson<Record<string, unknown>>(`${API_BASE_URL}/api/agi/ask/turn`, {
    method: "POST",
    body: JSON.stringify({
      sessionId: input.sessionId,
      question: input.prompt,
      mode: "read",
      debug: true,
    }),
  });
  const turnId = readString(response.turn_id);
  const debugExport = turnId
    ? await fetchJson<Record<string, unknown>>(`${API_BASE_URL}/api/agi/ask/turn/${encodeURIComponent(turnId)}/debug-export`)
    : null;
  return { response, debugExport };
};

async function runPrompt(
  page: Page,
  item: HarnessPrompt,
  index: number,
  localRuntimeChanges: LocalRestartSensitiveRuntimeChanges,
): Promise<HarnessResult> {
  await submitPrompt(page, item.prompt);
  const visibleFinalAnswer = await page
    .locator('[data-testid="helix-ask-latest-final-answer"]')
    .getAttribute("data-final-answer-text")
    .then((value) => value ?? "");
  const debugExport = await collectDebugExport(page);
  const terminalAuthority = asRecord(debugExport?.terminal_answer_authority);
  const railCandidates = collectUiDebugRailCandidates(debugExport);
  const railTable = railCandidates[0] ?? null;
  const turnId =
    readString(debugExport?.turn_id) ||
    readString(debugExport?.active_turn_id) ||
    readString(getPath(debugExport, ["payload", "turn_id"]));
  const terminalAuthorityText = readString(terminalAuthority?.terminal_text_preview);
  const selectedFinalAnswer = readString(debugExport?.selected_final_answer);
  const debugTerminalKind =
    readString(debugExport?.terminal_artifact_kind) ||
    readString(getPath(debugExport, ["payload", "terminal_artifact_kind"])) ||
    readString(getPath(debugExport, ["resolved_turn_summary", "terminal_artifact_kind"]));
  const coverageArtifacts = collectCoverageArtifacts(debugExport);
  const calculatorPanelState = await collectCalculatorPanelState(page);
  const parity = asRecord(debugExport?.ui_debug_parity_harness);
  const violations: string[] = [];
  const warnings: string[] = [];

  if (!debugExport) violations.push("debug_export_missing");
  violations.push(...collectRailTableViolations(railTable, terminalAuthority, turnId || null, debugTerminalKind || null));
  violations.push(...collectUiDebugRailMirrorViolations(railCandidates));
  violations.push(...collectCompleteRailEnvelopeViolations({ railTable, debugExport, visibleFinalAnswer }));
  if (!visibleFinalAnswer) violations.push("visible_final_answer_missing");
  if (terminalAuthorityText && visibleFinalAnswer !== terminalAuthorityText) {
    violations.push("ui_terminal_authority_text_mismatch");
  }
  if (selectedFinalAnswer && visibleFinalAnswer !== selectedFinalAnswer) {
    violations.push("ui_selected_final_answer_mismatch");
  }
  if (!terminalAuthority) violations.push("terminal_authority_missing");
  if (!asRecord(debugExport?.goal_satisfaction_evaluation)) violations.push("goal_satisfaction_missing");
  if (!asRecord(debugExport?.agent_runtime_loop) && !asRecord(debugExport?.agent_step_loop)) {
    violations.push("agent_loop_missing");
  }
  if (item.expectCoverage && coverageArtifacts.length === 0) violations.push("coverage_artifact_missing");
  if (item.expectCalculatorPanel) {
    if (!calculatorPanelState) violations.push("calculator_panel_state_missing");
    if (calculatorPanelState?.stale_compound_run_visible === true) violations.push("calculator_panel_stale_compound_run_visible");
  }
  if (parity?.clipboard_debug_copy_required_for_prompt_submission !== false) {
    violations.push("clipboard_debug_copy_can_block_prompt_submission");
  }
  const apiSessionId = buildUiApiParitySessionId({
    configuredSessionId: API_SESSION_ID,
    prompt: item.prompt,
    turnId,
    index,
  });
  let apiResponse: Record<string, unknown> | null | undefined;
  let apiDebugExport: Record<string, unknown> | null | undefined;
  let uiApiTerminalParityViolations: string[] | undefined;
  if (COMPARE_API) {
    try {
      const api = await runApiCompanionTurn({ prompt: item.prompt, sessionId: apiSessionId });
      apiResponse = api.response;
      apiDebugExport = api.debugExport;
      uiApiTerminalParityViolations = collectUiApiTerminalParityViolations({
        uiDebugExport: debugExport,
        apiResponse,
        apiDebugExport,
        uiVisibleFinalAnswer: visibleFinalAnswer,
      });
      violations.push(...uiApiTerminalParityViolations);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      uiApiTerminalParityViolations = [`ui_api_companion_turn_failed:${message.slice(0, 240)}`];
      violations.push(...uiApiTerminalParityViolations);
    }
  }
  const serverBuildStartedAtMs = Math.min(
    ...[
      readServerBuildStartedAtMs(null, debugExport),
      readServerBuildStartedAtMs(apiResponse ?? null, apiDebugExport ?? null),
    ].filter((entry): entry is number => typeof entry === "number"),
  );
  const normalizedServerBuildStartedAtMs = Number.isFinite(serverBuildStartedAtMs) ? serverBuildStartedAtMs : null;
  const staleBundleWarnings = uiServerBundleFreshnessWarnings({
    serverBuildStartedAtMs: normalizedServerBuildStartedAtMs,
    latestLocalRuntimeChangeMs: localRuntimeChanges.latestMtimeMs,
    changedRuntimeFiles: localRuntimeChanges.files,
  });
  if (staleBundleWarnings.length && violations.length) {
    warnings.push(
      ...staleBundleWarnings,
      ...violations.map((violation) => `untrusted_violation_due_to_stale_server_bundle:${violation}`),
    );
    violations.length = 0;
  } else {
    warnings.push(...staleBundleWarnings);
  }

  return {
    prompt: item.prompt,
    visible_final_answer: visibleFinalAnswer,
    debug_export: debugExport,
    api_response: apiResponse,
    api_debug_export: apiDebugExport,
    ui_api_terminal_parity_violations: uiApiTerminalParityViolations,
    terminal_authority: terminalAuthority,
    codex_parity_agent_spine_rail_table: railTable,
    goal_satisfaction: debugExport?.goal_satisfaction_evaluation ?? null,
    agent_runtime_loop: debugExport?.agent_runtime_loop ?? debugExport?.agent_step_loop ?? null,
    coverage_artifacts: coverageArtifacts,
    calculator_panel_state: calculatorPanelState,
    server_bundle_freshness: {
      server_build_started_at_ms: normalizedServerBuildStartedAtMs,
      latest_local_runtime_change_ms: localRuntimeChanges.latestMtimeMs,
      changed_runtime_file_count: localRuntimeChanges.files.length,
      stale: staleBundleWarnings.length > 0,
    },
    warnings,
    violations,
  };
}

async function main(): Promise<0 | 1> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await installClipboardFailureShim(page);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  const results: HarnessResult[] = [];
  const prompts = resolveUiDebugParityPrompts();
  const localRuntimeChanges = collectLocalRestartSensitiveRuntimeChanges();
  try {
    for (const [index, item] of prompts.entries()) {
      results.push(await runPrompt(page, item, index, localRuntimeChanges));
    }
  } finally {
    await browser.close();
  }

  const warningSummary = summarizeUiDebugParityWarnings(results as Array<Record<string, unknown>>);
  const goalAcceptance = summarizeUiDebugParityGoalAcceptance(results as Array<Record<string, unknown>>);
  const goalProofTrust = uiDebugParityGoalProofTrust(warningSummary, results.length);
  const output = {
    schema: "helix.ask.ui_debug_parity_harness_report.v1",
    url: BASE_URL,
    api_url: API_BASE_URL,
    api_comparison_enabled: COMPARE_API,
    prompt_preset: PROMPT_PRESET,
    local_restart_sensitive_runtime_changes: localRuntimeChanges,
    created_at: new Date().toISOString(),
    prompts,
    counts: {
      pass: results.filter((result) => result.violations.length === 0 && result.warnings.length === 0).length,
      warn: results.filter((result) => result.violations.length === 0 && result.warnings.length > 0).length,
      fail: results.filter((result) => result.violations.length > 0).length,
    },
    warning_summary: warningSummary,
    goal_acceptance: goalAcceptance,
    goal_proof_trust: goalProofTrust,
    goal_proof_required: REQUIRE_GOAL_PROOF,
    results,
    ok: results.every((result) => result.violations.length === 0) && goalAcceptance.ok,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  if (!output.ok) {
    console.error(JSON.stringify(output, null, 2));
  } else if (!goalProofTrust.trusted_for_goal_acceptance) {
    console.warn(`Helix Ask UI/debug parity classified, but is not trusted goal proof: ${OUT_PATH}`);
  } else {
    console.log(`Helix Ask UI/debug parity passed: ${OUT_PATH}`);
  }
  return uiDebugParityProcessExitCode(output.ok, REQUIRE_GOAL_PROOF, goalProofTrust);
}

const invokedAsCli = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (invokedAsCli) {
  void main()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
