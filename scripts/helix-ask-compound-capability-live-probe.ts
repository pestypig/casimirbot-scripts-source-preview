import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type RecordLike = Record<string, unknown>;
type ExpectedValue = string | string[] | null;

export type CompoundCapabilityScenario = {
  id: string;
  prompt: string;
  seed?: "visual_capture";
  expectedRequested: ExpectedValue[];
  expectedRuntime: ExpectedValue[];
  expectedExecuted?: ExpectedValue[];
  expectedInputBindingFromCapabilities?: Array<string | string[] | null>;
  expectedCalculatorExpression?: string;
  expectedSubgoalSatisfaction?: ExpectedValue[];
  expectedRailStatus?: ExpectedValue[];
  expectedFirstBrokenRail?: ExpectedValue[];
  expectedRailFailureCode?: ExpectedValue[];
  expectedRepairTarget?: ExpectedValue[];
  expectedTerminalErrorCode?: ExpectedValue;
  expectedTerminalKind?: ExpectedValue;
  expectedFinalAnswerSource?: ExpectedValue;
  forbiddenRuntime?: string[];
  forbiddenExecuted?: string[];
  acceptsObservationOnlyCompound?: boolean;
};

export type CompoundCapabilityScenarioSummary = {
  id: string;
  prompt: string;
  ok: boolean;
  failures: string[];
  turn_id: string | null;
  terminal_error_code: string | null;
  terminal_authority_kind: string | null;
  visible_terminal_kind: string | null;
  backend_visible_terminal_kind: string | null;
  final_answer_source: string | null;
  requested_capabilities: string[];
  runtime_capabilities: Array<string | null>;
  selected_capabilities: Array<string | null>;
  executed_capabilities: Array<string | null>;
  observation_kinds: Array<string | null>;
  observation_refs: Array<string | null>;
  observation_provenance: Array<string | null>;
  subgoal_required_observation_kinds: string[][];
  subgoal_required_terminal_kinds: Array<string | null>;
  subgoal_terminal_contribution_kinds: Array<string | null>;
  subgoal_contribution_roles: Array<string | null>;
  subgoal_allowed_substitutions: string[][];
  subgoal_forbidden_nearby_capabilities: string[][];
  subgoal_input_bindings: RecordLike[][];
  subgoal_bound_input_refs: RecordLike[][];
  rail_requested_capabilities: Array<string | null>;
  rail_runtime_capabilities: Array<string | null>;
  rail_selected_capabilities: Array<string | null>;
  rail_executed_capabilities: Array<string | null>;
  rail_observation_kinds: Array<string | null>;
  rail_observation_refs: Array<string | null>;
  rail_observation_provenance: Array<string | null>;
  rail_required_observation_kinds: string[][];
  rail_required_terminal_kinds: Array<string | null>;
  rail_terminal_contribution_kinds: Array<string | null>;
  rail_contribution_roles: Array<string | null>;
  rail_allowed_substitutions: string[][];
  rail_forbidden_nearby_capabilities: string[][];
  subgoal_satisfactions: Array<string | null>;
  subgoal_rail_statuses: Array<string | null>;
  subgoal_first_broken_rails: Array<string | null>;
  subgoal_rail_failure_codes: Array<string | null>;
  subgoal_repair_targets: Array<string | null>;
  missing_compound_subgoal_ids: string[];
  missing_required_capabilities: string[];
  next_missing_subgoal_id: string | null;
  first_missing_subgoal_id: string | null;
  first_missing_subgoal_first_broken_rail: string | null;
  first_missing_subgoal_rail_failure_code: string | null;
  first_missing_subgoal_repair_target: string | null;
  top_level_compound_subgoal_count: number | null;
  top_level_first_incomplete_compound_subgoal_id: string | null;
  top_level_first_incomplete_compound_requested_capability: string | null;
  top_level_first_incomplete_compound_runtime_capability: string | null;
  top_level_first_incomplete_compound_selected_capability: string | null;
  top_level_first_incomplete_compound_executed_capability: string | null;
  top_level_compound_first_broken_rail: string | null;
  top_level_compound_rail_failure_code: string | null;
  top_level_compound_repair_target: string | null;
  top_level_compound_incomplete_subgoal_did_tool_run: boolean | null;
  compound_complete: boolean | null;
};

const BASE_URL = (process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:1498").replace(/\/+$/, "");
const OUT_DIR = process.env.HELIX_ASK_COMPOUND_LIVE_OUT ?? "artifacts/helix-ask-compound-capability-live";
const TIMEOUT_MS = Math.max(1000, Number(process.env.HELIX_ASK_COMPOUND_LIVE_TIMEOUT_MS ?? 300_000));
const DRY_RUN = process.argv.includes("--dry-run") || process.env.HELIX_ASK_COMPOUND_LIVE_DRY_RUN === "1";
const ALLOW_ALL_LIVE_SCENARIOS =
  process.argv.includes("--allow-all-live-scenarios") ||
  process.env.HELIX_ASK_COMPOUND_LIVE_ALLOW_ALL === "1";
const SCENARIO_FILTER = (process.env.HELIX_ASK_COMPOUND_LIVE_SCENARIOS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

export type CompoundCapabilityScenarioSelection = {
  scenarios: CompoundCapabilityScenario[];
  requestedIds: string[];
  unknownIds: string[];
  availableIds: string[];
};

export type CompoundCapabilityLiveRunPolicy = {
  blocked: boolean;
  blocked_reason: string | null;
  message: string | null;
};

export const BROAD_LIVE_PROBE_BLOCK_MESSAGE =
  "Refusing to run every live compound scenario against a keyed server. Set HELIX_ASK_COMPOUND_LIVE_SCENARIOS to a comma-separated scenario list, or pass --allow-all-live-scenarios / HELIX_ASK_COMPOUND_LIVE_ALLOW_ALL=1.";

export const resolveCompoundCapabilityLiveRunPolicy = (input: {
  dryRun: boolean;
  scenarioFilter: string[];
  allowAllLiveScenarios: boolean;
}): CompoundCapabilityLiveRunPolicy => {
  if (input.dryRun) {
    return {
      blocked: false,
      blocked_reason: null,
      message: null,
    };
  }
  const filteredScenarioCount = input.scenarioFilter
    .map((entry) => entry.trim())
    .filter(Boolean).length;
  if (filteredScenarioCount > 0 || input.allowAllLiveScenarios) {
    return {
      blocked: false,
      blocked_reason: null,
      message: null,
    };
  }
  return {
    blocked: true,
    blocked_reason: "scenario_filter_required_for_live_probe",
    message: BROAD_LIVE_PROBE_BLOCK_MESSAGE,
  };
};

export const COMPOUND_CAPABILITY_LIVE_SCENARIOS: CompoundCapabilityScenario[] = [
  {
    id: "workspace_then_calculator",
    prompt:
      "Use workspace_os.status to inspect workstation status, then call scientific-calculator.solve_expression with this exact expression: 14*23+8.",
    expectedRequested: ["workspace_os.status", "scientific-calculator.solve_expression"],
    expectedRuntime: ["workspace_os.status", "scientific-calculator.solve_expression"],
    expectedInputBindingFromCapabilities: [null, "workspace_os.status"],
    expectedCalculatorExpression: "14*23+8",
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "docs_then_calculator",
    prompt:
      "Use docs-viewer.locate_in_doc to locate the rule of thumb in docs/helix-ask-codex-loop-discipline.md, then run scientific-calculator.solve_expression with this exact expression: 19+23.",
    expectedRequested: ["docs-viewer.locate_in_doc", "scientific-calculator.solve_expression"],
    expectedRuntime: ["docs.search", "scientific-calculator.solve_expression"],
    expectedInputBindingFromCapabilities: [null, "docs-viewer.locate_in_doc"],
    expectedCalculatorExpression: "19+23",
    expectedTerminalKind: "doc_evidence_synthesis_answer",
  },
  {
    id: "docs_equation_context_then_calculator",
    prompt:
      "Call docs-viewer.doc_equation_context for query: Alcubierre metric equation, then run scientific-calculator.solve_expression with this exact expression: 12*4+5.",
    expectedRequested: ["docs-viewer.doc_equation_context", "scientific-calculator.solve_expression"],
    expectedRuntime: ["docs.search", "scientific-calculator.solve_expression"],
    expectedInputBindingFromCapabilities: [null, "docs-viewer.doc_equation_context"],
    expectedCalculatorExpression: "12*4+5",
    expectedTerminalKind: "doc_evidence_synthesis_answer",
  },
  {
    id: "workspace_directory_then_docs",
    prompt:
      "Call workspace-directory.resolve for docs/helix-ask-codex-loop-discipline.md, then use docs-viewer.locate_in_doc to locate the rule of thumb in docs/helix-ask-codex-loop-discipline.md.",
    expectedRequested: ["workspace-directory.resolve", "docs-viewer.locate_in_doc"],
    expectedRuntime: ["workspace-directory.resolve", "docs.search"],
    expectedInputBindingFromCapabilities: [null, "workspace-directory.resolve"],
    expectedTerminalKind: "doc_evidence_synthesis_answer",
  },
  {
    id: "catalog_then_workspace",
    prompt: "Call helix_ask.inspect_capability_catalog, then use workspace_os.status to inspect workstation status.",
    expectedRequested: ["helix_ask.inspect_capability_catalog", "workspace_os.status"],
    expectedRuntime: ["helix_ask.inspect_capability_catalog", "workspace_os.status"],
    expectedInputBindingFromCapabilities: [null, null],
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "workstation_tool_alignment_then_workspace",
    prompt:
      "Call helix_ask.reflect_workstation_tool_alignment to inspect tool readiness alignment, then use workspace_os.status to inspect workstation status.",
    expectedRequested: ["helix_ask.reflect_workstation_tool_alignment", "workspace_os.status"],
    expectedRuntime: ["helix_ask.reflect_workstation_tool_alignment", "workspace_os.status"],
    expectedInputBindingFromCapabilities: [null, null],
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "natural_catalog_then_workspace",
    prompt:
      "What tools are available for the helix ask to use? Then use workspace_os.status to inspect workstation status.",
    expectedRequested: ["helix_ask.inspect_capability_catalog", "workspace_os.status"],
    expectedRuntime: ["helix_ask.inspect_capability_catalog", "workspace_os.status"],
    expectedInputBindingFromCapabilities: [null, null],
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "micro_reasoner_presets_then_draft",
    prompt:
      "Call live_env.query_micro_reasoner_presets to inspect the micro reasoner preset catalog, then call live_env.draft_micro_reasoner_preset to draft a live-source micro reasoner preset.",
    expectedRequested: ["live_env.query_micro_reasoner_presets", "live_env.draft_micro_reasoner_preset"],
    expectedRuntime: ["live_env.query_micro_reasoner_presets", "live_env.draft_micro_reasoner_preset"],
    expectedInputBindingFromCapabilities: [null, "live_env.query_micro_reasoner_presets"],
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "micro_reasoner_presets_draft_route",
    prompt:
      "Call live_env.query_micro_reasoner_presets to inspect the micro reasoner preset catalog, then call live_env.draft_micro_reasoner_preset to draft a preset, then call live_env.route_micro_reasoner_prompt.",
    expectedRequested: [
      "live_env.query_micro_reasoner_presets",
      "live_env.draft_micro_reasoner_preset",
      "live_env.route_micro_reasoner_prompt",
    ],
    expectedRuntime: [
      "live_env.query_micro_reasoner_presets",
      "live_env.draft_micro_reasoner_preset",
      "live_env.route_micro_reasoner_prompt",
    ],
    expectedInputBindingFromCapabilities: [
      null,
      "live_env.query_micro_reasoner_presets",
      ["live_env.query_micro_reasoner_presets", "live_env.draft_micro_reasoner_preset"],
    ],
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "live_source_mail_read_process_reflect",
    prompt:
      "Call live_env.read_processed_live_source_mail, then call live_env.process_live_source_mail, then call live_env.reflect_live_source_mail_loop.",
    expectedRequested: [
      "live_env.read_processed_live_source_mail",
      "live_env.process_live_source_mail",
      "live_env.reflect_live_source_mail_loop",
    ],
    expectedRuntime: [
      "live_env.read_processed_live_source_mail",
      "live_env.process_live_source_mail",
      "live_env.reflect_live_source_mail_loop",
    ],
    expectedInputBindingFromCapabilities: [
      null,
      "live_env.read_processed_live_source_mail",
      ["live_env.read_processed_live_source_mail", "live_env.process_live_source_mail"],
    ],
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "live_source_mail_read_process_decision",
    prompt:
      "Call live_env.read_processed_live_source_mail, then call live_env.process_live_source_mail, then call live_env.record_live_source_mail_decision.",
    expectedRequested: [
      "live_env.read_processed_live_source_mail",
      "live_env.process_live_source_mail",
      "live_env.record_live_source_mail_decision",
    ],
    expectedRuntime: [
      "live_env.read_processed_live_source_mail",
      "live_env.process_live_source_mail",
      "live_env.record_live_source_mail_decision",
    ],
    expectedInputBindingFromCapabilities: [
      null,
      "live_env.read_processed_live_source_mail",
      ["live_env.read_processed_live_source_mail", "live_env.process_live_source_mail"],
    ],
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "live_source_mail_check_then_raw_read",
    prompt:
      "Call live_env.check_live_source_mail, then call live_env.read_live_source_mail.",
    expectedRequested: [
      "live_env.check_live_source_mail",
      "live_env.read_live_source_mail",
    ],
    expectedRuntime: [
      "live_env.check_live_source_mail",
      "live_env.read_live_source_mail",
    ],
    expectedInputBindingFromCapabilities: [
      null,
      "live_env.check_live_source_mail",
    ],
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "live_source_decision_then_voice_callout",
    prompt:
      "Call live_env.record_live_source_mail_decision, then call live_env.request_interim_voice_callout with message: Summarize the mailbox decision for the operator.",
    expectedRequested: [
      "live_env.record_live_source_mail_decision",
      "live_env.request_interim_voice_callout",
    ],
    expectedRuntime: [
      "live_env.record_live_source_mail_decision",
      "live_env.request_interim_voice_callout",
    ],
    expectedInputBindingFromCapabilities: [
      null,
      "live_env.record_live_source_mail_decision",
    ],
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "live_source_quality_goal_context_state",
    prompt:
      "Call live_env.query_live_source_quality, then call live_env.query_workstation_goal_context, then call live_env.summarize_live_source_current_state.",
    expectedRequested: [
      "live_env.query_live_source_quality",
      "live_env.query_workstation_goal_context",
      "live_env.summarize_live_source_current_state",
    ],
    expectedRuntime: [
      "live_env.query_live_source_quality",
      "live_env.query_workstation_goal_context",
      "live_env.summarize_live_source_current_state",
    ],
    expectedInputBindingFromCapabilities: [
      null,
      null,
      ["live_env.query_live_source_quality", "live_env.query_workstation_goal_context"],
    ],
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "repo_plus_docs",
    prompt:
      "Use repo-code.search_concept to find where terminal authority is enforced, plus docs-viewer.locate_in_doc to locate the same rule in docs/helix-ask-codex-loop-discipline.md.",
    expectedRequested: ["repo-code.search_concept", "docs-viewer.locate_in_doc"],
    expectedRuntime: ["repo-code.search_concept", "docs.search"],
    expectedInputBindingFromCapabilities: [null, null],
    expectedTerminalKind: "doc_evidence_synthesis_answer",
  },
  {
    id: "repo_reflection_calculator",
    prompt:
      "Use repo-code.search_concept for query: terminal authority, then use helix_ask.reflect_theory_context to explain the repo evidence, then run scientific-calculator.solve_expression with this exact expression: 4*13.",
    expectedRequested: [
      "repo-code.search_concept",
      "helix_ask.reflect_theory_context",
      "scientific-calculator.solve_expression",
    ],
    expectedRuntime: [
      "repo-code.search_concept",
      "helix_ask.reflect_theory_context",
      "scientific-calculator.solve_expression",
    ],
    expectedInputBindingFromCapabilities: [
      null,
      "repo-code.search_concept",
      ["repo-code.search_concept", "helix_ask.reflect_theory_context"],
    ],
    expectedCalculatorExpression: "4*13",
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "docs_reflection_calculator",
    prompt:
      "Use docs-viewer.locate_in_doc to locate query: receipts are observations, then use helix_ask.reflect_theory_context to explain the document evidence, then run scientific-calculator.solve_expression with this exact expression: 7*8.",
    expectedRequested: [
      "docs-viewer.locate_in_doc",
      "helix_ask.reflect_theory_context",
      "scientific-calculator.solve_expression",
    ],
    expectedRuntime: [
      "docs.search",
      "helix_ask.reflect_theory_context",
      "scientific-calculator.solve_expression",
    ],
    expectedInputBindingFromCapabilities: [
      null,
      "docs-viewer.locate_in_doc",
      ["docs-viewer.locate_in_doc", "helix_ask.reflect_theory_context"],
    ],
    expectedCalculatorExpression: "7*8",
    expectedTerminalKind: "doc_evidence_synthesis_answer",
  },
  {
    id: "internet_reflection_calculator",
    prompt:
      "Use internet_search.web_research to find a cited research-paper source for Alcubierre metric energy estimates, then use helix_ask.reflect_theory_context to connect that source to the Helix Ask receipts-as-observations rule, then run scientific-calculator.solve_expression with this exact expression: (9+3)*7-25.",
    expectedRequested: [
      "internet_search.web_research",
      "helix_ask.reflect_theory_context",
      "scientific-calculator.solve_expression",
    ],
    expectedRuntime: [
      ["internet-search.search_web", "internet_search.web_research"],
      "helix_ask.reflect_theory_context",
      "scientific-calculator.solve_expression",
    ],
    expectedInputBindingFromCapabilities: [
      null,
      "internet_search.web_research",
      ["internet_search.web_research", "helix_ask.reflect_theory_context"],
    ],
    expectedCalculatorExpression: "(9+3)*7-25",
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "scholarly_reflection_calculator",
    prompt:
      "Use scholarly-research.lookup_papers for Alcubierre metric energy estimates, then use helix_ask.reflect_theory_context to connect that scholarly source to the Helix Ask receipts-as-observations rule, then run scientific-calculator.solve_expression with this exact expression: (12+5)*3.",
    expectedRequested: [
      "scholarly-research.lookup_papers",
      "helix_ask.reflect_theory_context",
      "scientific-calculator.solve_expression",
    ],
    expectedRuntime: [
      "scholarly-research.lookup_papers",
      "helix_ask.reflect_theory_context",
      "scientific-calculator.solve_expression",
    ],
    expectedInputBindingFromCapabilities: [
      null,
      "scholarly-research.lookup_papers",
      ["scholarly-research.lookup_papers", "helix_ask.reflect_theory_context"],
    ],
    expectedCalculatorExpression: "(12+5)*3",
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "scholarly_full_text_reflection_calculator",
    prompt:
      "Use scholarly-research.lookup_papers for Alcubierre metric energy estimates, then use scholarly-research.fetch_full_text, then use helix_ask.reflect_theory_context to connect that paper evidence to the Helix Ask receipts-as-observations rule, then run scientific-calculator.solve_expression with this exact expression: (2.5+1.5)*8.",
    expectedRequested: [
      "scholarly-research.lookup_papers",
      "scholarly-research.fetch_full_text",
      "helix_ask.reflect_theory_context",
      "scientific-calculator.solve_expression",
    ],
    expectedRuntime: [
      "scholarly-research.lookup_papers",
      "scholarly-research.fetch_full_text",
      "helix_ask.reflect_theory_context",
      "scientific-calculator.solve_expression",
    ],
    expectedInputBindingFromCapabilities: [
      null,
      "scholarly-research.lookup_papers",
      ["scholarly-research.lookup_papers", "scholarly-research.fetch_full_text"],
      [
        "scholarly-research.lookup_papers",
        "scholarly-research.fetch_full_text",
        "helix_ask.reflect_theory_context",
      ],
    ],
    expectedCalculatorExpression: "(2.5+1.5)*8",
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "scholarly_numeric_parameters_then_calculator",
    prompt:
      "Use scholarly-research.lookup_papers to find an accessible tokamak plasma beta or transport paper that explicitly reports unit-bearing plasma density, temperature, and magnetic field values. Then use scholarly-research.fetch_full_text, then use scholarly-research.extract_numeric_parameters for n_m3, T_eV, and B_T with cited units. Run scientific-calculator.solve_expression only if the numeric parameter evidence can bind every formula variable with source refs; otherwise explain which paper was fetched and which variables were missing or rejected.",
    expectedRequested: [
      "scholarly-research.lookup_papers",
      "scholarly-research.fetch_full_text",
      "scholarly-research.extract_numeric_parameters",
      "scientific-calculator.solve_expression",
    ],
    expectedRuntime: [
      "scholarly-research.lookup_papers",
      "scholarly-research.fetch_full_text",
      "scholarly-research.extract_numeric_parameters",
      "scientific-calculator.solve_expression",
    ],
    expectedInputBindingFromCapabilities: [
      null,
      "scholarly-research.lookup_papers",
      "scholarly-research.fetch_full_text",
      [
        "scholarly-research.lookup_papers",
        "scholarly-research.fetch_full_text",
        "scholarly-research.extract_numeric_parameters",
      ],
    ],
    expectedExecuted: [
      "scholarly-research.lookup_papers",
      "scholarly-research.fetch_full_text",
      "scholarly-research.extract_numeric_parameters",
      null,
    ],
    expectedSubgoalSatisfaction: ["satisfied", "satisfied", "failed", "missing"],
    expectedRailStatus: ["complete", "complete", "fail_closed", "fail_closed"],
    expectedTerminalErrorCode: null,
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "scholarly_default_lookup_agent_decision",
    prompt:
      "Retrieve research papers for tokamak thermal pressure values, calculate the tokamak thermal pressure proxy from the theory badge graph for n_m3 and T_eV, and reflect the claim boundary through the theory badge graph.",
    expectedRequested: [
      "scholarly-research.lookup_papers",
      "helix_ask.reflect_theory_context",
    ],
    expectedRuntime: [
      "scholarly-research.lookup_papers",
      "helix_ask.reflect_theory_context",
    ],
    expectedInputBindingFromCapabilities: [null, "scholarly-research.lookup_papers"],
    forbiddenRuntime: [
      "scholarly-research.fetch_full_text",
      "scholarly-research.extract_numeric_parameters",
    ],
    forbiddenExecuted: [
      "scholarly-research.fetch_full_text",
      "scholarly-research.extract_numeric_parameters",
    ],
    acceptsObservationOnlyCompound: true,
    expectedTerminalErrorCode: null,
  },
  {
    id: "scholarly_irrelevant_lookup_blocks_dependent_chain",
    prompt:
      "Use scholarly-research.lookup_papers for DIII-D or EAST tokamak operating parameters: electron density, electron temperature, toroidal magnetic field, plasma current, and confinement/transport parameter table. Then use scholarly-research.fetch_full_text on the best accessible tokamak paper and scholarly-research.extract_numeric_parameters only if the paper is relevant. Reflect the theory badge graph and calculate beta only after cited values are bound.",
    expectedRequested: [
      "scholarly-research.lookup_papers",
      "helix_ask.reflect_theory_context",
    ],
    expectedRuntime: [
      "scholarly-research.lookup_papers",
      "helix_ask.reflect_theory_context",
    ],
    expectedInputBindingFromCapabilities: [null, "scholarly-research.lookup_papers"],
    forbiddenRuntime: [
      "scholarly-research.fetch_full_text",
      "scholarly-research.extract_numeric_parameters",
    ],
    forbiddenExecuted: [
      "scholarly-research.fetch_full_text",
      "scholarly-research.extract_numeric_parameters",
    ],
    acceptsObservationOnlyCompound: true,
    expectedTerminalErrorCode: null,
  },
  {
    id: "context_reflection_calculator",
    prompt:
      "Use helix_ask.reflect_context_attachments to inspect attached context, then run scientific-calculator.solve_expression with this exact expression: 3*11.",
    expectedRequested: [
      "helix_ask.reflect_context_attachments",
      "scientific-calculator.solve_expression",
    ],
    expectedRuntime: [
      "helix_ask.reflect_context_attachments",
      "scientific-calculator.solve_expression",
    ],
    expectedInputBindingFromCapabilities: [
      null,
      "helix_ask.reflect_context_attachments",
    ],
    expectedCalculatorExpression: "3*11",
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "theory_frontier_trace_calculator",
    prompt:
      "Call helix.theory.frontierVectorFieldTrace for Helix Ask parity coverage, then run scientific-calculator.solve_expression with this exact expression: 6*7.",
    expectedRequested: [
      "helix.theory.frontierVectorFieldTrace",
      "scientific-calculator.solve_expression",
    ],
    expectedRuntime: [
      "helix.theory.frontierVectorFieldTrace",
      "scientific-calculator.solve_expression",
    ],
    expectedInputBindingFromCapabilities: [
      null,
      "helix.theory.frontierVectorFieldTrace",
    ],
    expectedCalculatorExpression: "6*7",
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "live_synthetic_data_reflection_calculator",
    prompt:
      "Use helix_ask.reflect_live_synthetic_data for Helix Ask parity coverage, then run scientific-calculator.solve_expression with this exact expression: 8*4.",
    expectedRequested: [
      "helix_ask.reflect_live_synthetic_data",
      "scientific-calculator.solve_expression",
    ],
    expectedRuntime: [
      "helix_ask.reflect_live_synthetic_data",
      "scientific-calculator.solve_expression",
    ],
    expectedInputBindingFromCapabilities: [
      null,
      "helix_ask.reflect_live_synthetic_data",
    ],
    expectedCalculatorExpression: "8*4",
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "visual_then_calculator",
    seed: "visual_capture",
    prompt:
      "Use situation-room.describe_visual_capture, then run scientific-calculator.solve_expression with this exact expression: 5*9.",
    expectedRequested: [["situation-room.describe_visual_capture", "image_lens.inspect"], "scientific-calculator.solve_expression"],
    expectedRuntime: ["situation-room.describe_visual_capture", "scientific-calculator.solve_expression"],
    expectedInputBindingFromCapabilities: [null, "image_lens.inspect"],
    expectedCalculatorExpression: "5*9",
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "civilization_bounds_reflection",
    prompt:
      "Call helix_ask.build_civilization_scenario_frame for a long-range settlement scenario, then call helix_ask.reflect_civilization_bounds to reflect collaboration and falsification bounds.",
    expectedRequested: [
      "helix_ask.build_civilization_scenario_frame",
      "helix_ask.reflect_civilization_bounds",
    ],
    expectedRuntime: [
      "helix_ask.build_civilization_scenario_frame",
      "helix_ask.reflect_civilization_bounds",
    ],
    expectedInputBindingFromCapabilities: [null, "helix_ask.build_civilization_scenario_frame"],
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "moral_graph_reflection_bridge",
    prompt:
      "Call helix_ask.reflect_theory_context for uncertainty in the agent policy, then call helix_ask.reflect_ideology_context for wisdom under uncertainty, then call helix_ask.bridge_theory_ideology_context to bridge the theory and ideology context.",
    expectedRequested: [
      "helix_ask.reflect_theory_context",
      "helix_ask.reflect_ideology_context",
      "helix_ask.bridge_theory_ideology_context",
    ],
    expectedRuntime: [
      "helix_ask.reflect_theory_context",
      "helix_ask.reflect_ideology_context",
      "helix_ask.bridge_theory_ideology_context",
    ],
    expectedInputBindingFromCapabilities: [null, null, ["helix_ask.reflect_theory_context", "helix_ask.reflect_ideology_context"]],
    expectedTerminalKind: "model_synthesized_answer",
  },
  {
    id: "invalid_calculator_args_fail_closed",
    prompt:
      "Use docs-viewer.locate_in_doc to cite the rule of thumb, then call scientific-calculator.solve_expression with this exact expression: explain why receipts matter.",
    expectedRequested: ["docs-viewer.locate_in_doc", "scientific-calculator.solve_expression"],
    expectedRuntime: ["docs.search", null],
    expectedInputBindingFromCapabilities: [null, "docs-viewer.locate_in_doc"],
    expectedSubgoalSatisfaction: ["satisfied", "failed"],
    expectedRailStatus: ["complete", "fail_closed"],
    expectedFirstBrokenRail: [null, "capability_execution"],
    expectedRailFailureCode: [null, "invalid_arg:latex_is_prose"],
    expectedRepairTarget: [null, "subgoal_argument_extraction"],
    expectedTerminalErrorCode: "invalid_arg:latex_is_prose",
    expectedTerminalKind: "typed_failure",
    expectedFinalAnswerSource: "typed_failure",
  },
  {
    id: "missing_calculator_args_fail_closed",
    prompt:
      "Use docs-viewer.locate_in_doc to cite the rule of thumb, then call scientific-calculator.solve_expression.",
    expectedRequested: ["docs-viewer.locate_in_doc", "scientific-calculator.solve_expression"],
    expectedRuntime: ["docs.search", null],
    expectedInputBindingFromCapabilities: [null, "docs-viewer.locate_in_doc"],
    expectedSubgoalSatisfaction: ["satisfied", "failed"],
    expectedRailStatus: ["complete", "fail_closed"],
    expectedFirstBrokenRail: [null, "capability_execution"],
    expectedRailFailureCode: [null, "missing_required_arg:latex"],
    expectedRepairTarget: [null, "subgoal_argument_extraction"],
    expectedTerminalErrorCode: "missing_required_arg:latex",
    expectedTerminalKind: "typed_failure",
    expectedFinalAnswerSource: "typed_failure",
  },
];

const readRecord = (value: unknown): RecordLike | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordLike) : null;

const readArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const readStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry: unknown): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];

const getPath = (value: unknown, pathParts: string[]): unknown =>
  pathParts.reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as RecordLike)[key];
  }, value);

const firstRecord = (...values: unknown[]): RecordLike | null => {
  for (const value of values) {
    const record = readRecord(value);
    if (record) return record;
  }
  return null;
};

const firstArray = (...values: unknown[]): unknown[] => {
  for (const value of values) {
    const array = readArray(value);
    if (array.length > 0) return array;
  }
  return [];
};

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
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 1200)}`);
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timeout);
  }
};

const parseJsonRecord = (text: string): RecordLike | null => {
  try {
    return readRecord(JSON.parse(text));
  } catch {
    return null;
  }
};

const probeAskTurnApi = async (): Promise<{ ok: boolean; reason: string; message: string }> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(TIMEOUT_MS, 10_000));
  try {
    const response = await fetch(`${BASE_URL}/api/agi/ask/turn/__helix_compound_live_preflight__/debug-export?view=rail`, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    const text = await response.text();
    const payload = parseJsonRecord(text);
    const error = readString(payload?.error);
    const terminalError = readString(payload?.terminal_error_code);
    if (response.ok || error === "debug_export_not_found" || terminalError === "debug_export_turn_not_found") {
      return {
        ok: true,
        reason: response.ok ? "ask_turn_debug_export_available" : "ask_turn_routes_available",
        message: "Ask turn routes are mounted.",
      };
    }
    return {
      ok: false,
      reason: error ?? terminalError ?? `status_${response.status}`,
      message: text.slice(0, 1200) || response.statusText,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error && error.name === "AbortError" ? "ask_turn_api_preflight_timeout" : "ask_turn_api_unreachable",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
};

const extractPayload = (debugExport: unknown): RecordLike | null => {
  const debug = readRecord(debugExport);
  return readRecord(debug?.payload) ?? debug;
};

const compoundContractFor = (ask: RecordLike, debugExport: unknown): RecordLike | null => {
  const payload = extractPayload(debugExport);
  return firstRecord(
    ask.compound_capability_contract,
    payload?.compound_capability_contract,
    getPath(payload, ["debug", "compound_capability_contract"]),
    getPath(payload, ["artifact_query_index", "compound_capability_contract"]),
    getPath(payload, ["debug", "artifact_query_index", "compound_capability_contract"]),
    getPath(payload, ["capability_itinerary", "compound_capability_contract"]),
  );
};

const compoundLedgerFor = (ask: RecordLike, debugExport: unknown): RecordLike[] => {
  const payload = extractPayload(debugExport);
  const entries = firstArray(
    ask.compound_subgoal_ledger,
    payload?.compound_subgoal_ledger,
    getPath(payload, ["debug", "compound_subgoal_ledger"]),
    getPath(payload, ["artifact_query_index", "compound_subgoal_ledger"]),
    getPath(payload, ["debug", "artifact_query_index", "compound_subgoal_ledger"]),
    getPath(payload, ["capability_itinerary_execution_state", "compound_subgoal_ledger"]),
    getPath(payload, ["debug", "capability_itinerary_execution_state", "compound_subgoal_ledger"]),
  );
  const ledger = entries.map(readRecord).filter((entry: RecordLike | null): entry is RecordLike => Boolean(entry));
  if (ledger.length > 0) return ledger;
  const railFallback = firstArray(
    ask.compound_subgoal_rail_statuses,
    payload?.compound_subgoal_rail_statuses,
    getPath(payload, ["debug", "compound_subgoal_rail_statuses"]),
    getPath(payload, ["artifact_query_index", "compound_subgoal_rail_statuses"]),
    getPath(payload, ["debug", "artifact_query_index", "compound_subgoal_rail_statuses"]),
  );
  return railFallback.map(readRecord).filter((entry: RecordLike | null): entry is RecordLike => Boolean(entry));
};

const compoundRailStatusesFor = (ask: RecordLike, debugExport: unknown): RecordLike[] => {
  const payload = extractPayload(debugExport);
  const entries = firstArray(
    ask.compound_subgoal_rail_statuses,
    payload?.compound_subgoal_rail_statuses,
    getPath(payload, ["debug", "compound_subgoal_rail_statuses"]),
    getPath(payload, ["artifact_query_index", "compound_subgoal_rail_statuses"]),
    getPath(payload, ["debug", "artifact_query_index", "compound_subgoal_rail_statuses"]),
  );
  return entries.map(readRecord).filter((entry: RecordLike | null): entry is RecordLike => Boolean(entry));
};

const compoundMissingSummaryFor = (ask: RecordLike, debugExport: unknown): RecordLike | null => {
  const payload = extractPayload(debugExport);
  return firstRecord(
    ask.compound_subgoal_missing_summary,
    payload?.compound_subgoal_missing_summary,
    getPath(payload, ["debug", "compound_subgoal_missing_summary"]),
    getPath(payload, ["artifact_query_index", "compound_subgoal_missing_summary"]),
    getPath(payload, ["debug", "artifact_query_index", "compound_subgoal_missing_summary"]),
    getPath(payload, ["capability_itinerary_execution_state"]),
    getPath(payload, ["debug", "capability_itinerary_execution_state"]),
  );
};

const codexParityRailTableFor = (ask: RecordLike, debugExport: unknown): RecordLike | null => {
  const payload = extractPayload(debugExport);
  return firstRecord(
    ask.codex_parity_agent_spine_rail_table,
    payload?.codex_parity_agent_spine_rail_table,
    getPath(payload, ["debug", "codex_parity_agent_spine_rail_table"]),
    getPath(payload, ["artifact_query_index", "codex_parity_agent_spine_rail_table"]),
    getPath(payload, ["debug", "artifact_query_index", "codex_parity_agent_spine_rail_table"]),
  );
};

const plannedStepsFor = (ask: RecordLike, debugExport: unknown): RecordLike[] => {
  const payload = extractPayload(debugExport);
  const entries = firstArray(
    getPath(ask, ["capability_itinerary", "planned_steps"]),
    getPath(payload, ["capability_itinerary", "planned_steps"]),
    getPath(payload, ["debug", "capability_itinerary", "planned_steps"]),
    getPath(payload, ["artifact_query_index", "capability_itinerary", "planned_steps"]),
    getPath(payload, ["debug", "artifact_query_index", "capability_itinerary", "planned_steps"]),
  );
  return entries.map(readRecord).filter((entry: RecordLike | null): entry is RecordLike => Boolean(entry));
};

const terminalErrorCodeFor = (ask: RecordLike, debugExport: unknown): string | null => {
  const payload = extractPayload(debugExport);
  const singleWriter = readRecord(getPath(payload, ["terminal_authority_single_writer"]));
  const singleWriterIntegrity = readRecord(singleWriter?.integrity);
  const singleWriterIndicatesSuccess =
    Boolean(singleWriterIntegrity?.single_writer_applied === true) &&
    readString(singleWriter?.source) !== "typed_failure" &&
    readString(singleWriter?.selected_terminal_artifact_kind) !== "typed_failure" &&
    readString(singleWriter?.selectedArtifactKind) !== "typed_failure";
  const authority = readRecord(getPath(payload, ["terminal_answer_authority"]));
  const authorityIndicatesSuccess =
    Boolean(authority?.server_authoritative === true) &&
    readString(authority?.terminal_kind) !== "failure" &&
    readString(authority?.final_answer_source) !== "typed_failure" &&
    readString(authority?.terminal_artifact_kind) !== "typed_failure";
  if (singleWriterIndicatesSuccess || authorityIndicatesSuccess) return null;
  return (
    readString(payload?.terminal_error_code) ??
    readString(getPath(payload, ["typed_failure", "error_code"])) ??
    readString(getPath(payload, ["resolved_turn_summary", "terminal_error_code"])) ??
    readString(ask.terminal_error_code)
  );
};

const terminalAuthorityKindFor = (ask: RecordLike, debugExport: unknown): string | null => {
  const payload = extractPayload(debugExport);
  return (
    readString(getPath(payload, ["terminal_authority_single_writer", "selected_terminal_artifact_kind"])) ??
    readString(getPath(payload, ["terminal_answer_authority", "terminal_artifact_kind"])) ??
    readString(payload?.terminal_artifact_kind) ??
    readString(ask.terminal_artifact_kind)
  );
};

const visibleTerminalKindFor = (ask: RecordLike, debugExport: unknown): string | null => {
  const payload = extractPayload(debugExport);
  return (
    readString(ask.visible_terminal_kind) ??
    readString(getPath(payload, ["terminal_presentation", "terminal_artifact_kind"])) ??
    readString(payload?.visible_terminal_kind)
  );
};

const backendVisibleTerminalKindFor = (debugExport: unknown): string | null => {
  const payload = extractPayload(debugExport);
  return (
    readString(getPath(payload, ["terminal_presentation", "terminal_artifact_kind"])) ??
    readString(payload?.visible_terminal_kind)
  );
};

const finalAnswerSourceFor = (ask: RecordLike, debugExport: unknown): string | null => {
  const payload = extractPayload(debugExport);
  return (
    readString(getPath(payload, ["terminal_authority_single_writer", "source"])) ??
    readString(getPath(payload, ["terminal_answer_authority", "final_answer_source"])) ??
    readString(payload?.final_answer_source) ??
    readString(ask.final_answer_source)
  );
};

const matchesExpected = (actual: string | null, expected: ExpectedValue): boolean => {
  if (expected === null) return actual === null;
  const expectedValues = Array.isArray(expected) ? expected : [expected];
  return actual !== null && expectedValues.includes(actual);
};

const maybeCapability = (entry: RecordLike, key: string): string | null => readString(entry[key]);

const subgoalHasSatisfiedObservation = (entry: RecordLike | null | undefined): boolean =>
  maybeCapability(entry ?? {}, "satisfaction") === "satisfied" &&
  Boolean(maybeCapability(entry ?? {}, "observation_ref"));

const subgoalArgsFor = (contractSubgoal: RecordLike | null, ledgerEntry: RecordLike | null): RecordLike | null =>
  firstRecord(
    ledgerEntry?.args,
    ledgerEntry?.args_hint,
    contractSubgoal?.args,
    contractSubgoal?.args_hint,
  );

const expressionFor = (args: RecordLike | null): string | null =>
  readString(args?.latex) ?? readString(args?.expression) ?? readString(args?.input);

const NON_MATH_CALCULATOR_ARG_PATTERN =
  /workspace_os\.status|workspace[-_.]?directory|docs[-_.]?viewer|repo[-_.]?code|situation[-_.]?room|image[_-]?lens|visual\s+capture|internet[_-]?search|scholarly[-_]?research|helix_ask|reflect[_-]?theory|civilization[_-]?bounds|moral[_-]?graph|scientific[-_.]?calculator|then|plus|call|use|run/i;

const RECEIPT_TERMINAL_KINDS = new Set([
  "tool_receipt",
  "calculator_receipt",
  "doc_open_receipt",
  "workspace_action_receipt",
  "note_update_receipt",
  "note_action_receipt",
  "docs_viewer_receipt",
  "live_pipeline_receipt",
  "live_pipeline_turn_receipt",
  "live_source_pipeline_receipt",
  "voice_receipt",
]);

const hasOwn = (record: RecordLike | null, key: string): boolean =>
  Boolean(record && Object.prototype.hasOwnProperty.call(record, key));

const jsonEqual = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const stringArraysEqual = (left: unknown, right: unknown): boolean =>
  jsonEqual(readStringArray(left), readStringArray(right));

const mirrorArray = (input: {
  failures: string[];
  index: number;
  ledgerEntry: RecordLike | null;
  railEntry: RecordLike | null;
  key: string;
  requiredWhenLedgerHasKey?: boolean;
}): void => {
  const { failures, index, ledgerEntry, railEntry, key, requiredWhenLedgerHasKey = true } = input;
  if (!ledgerEntry || !railEntry) return;
  if (!hasOwn(ledgerEntry, key) && !requiredWhenLedgerHasKey) return;
  if (!Array.isArray(railEntry[key])) {
    failures.push(`subgoal_${index + 1}_rail_${key}_missing`);
    return;
  }
  if (Array.isArray(ledgerEntry[key]) && !jsonEqual(railEntry[key], ledgerEntry[key])) {
    failures.push(`subgoal_${index + 1}_rail_${key}_mismatch`);
  }
};

const mirrorNullableString = (input: {
  failures: string[];
  index: number;
  ledgerEntry: RecordLike | null;
  railEntry: RecordLike | null;
  key: string;
  requiredWhenLedgerHasKey?: boolean;
}): void => {
  const { failures, index, ledgerEntry, railEntry, key, requiredWhenLedgerHasKey = true } = input;
  if (!ledgerEntry || !railEntry) return;
  if (!hasOwn(ledgerEntry, key) && !requiredWhenLedgerHasKey) return;
  if (!hasOwn(railEntry, key)) {
    failures.push(`subgoal_${index + 1}_rail_${key}_missing`);
    return;
  }
  const ledgerValue = readString(ledgerEntry[key]);
  const railValue = readString(railEntry[key]);
  if (ledgerValue !== railValue) {
    failures.push(`subgoal_${index + 1}_rail_${key}_mismatch:${railValue ?? "null"}!=${ledgerValue ?? "null"}`);
  }
};

const mirrorRecord = (input: {
  failures: string[];
  index: number;
  ledgerEntry: RecordLike | null;
  railEntry: RecordLike | null;
  key: string;
  requiredWhenLedgerHasKey?: boolean;
}): void => {
  const { failures, index, ledgerEntry, railEntry, key, requiredWhenLedgerHasKey = true } = input;
  if (!ledgerEntry || !railEntry) return;
  if (!hasOwn(ledgerEntry, key) && !requiredWhenLedgerHasKey) return;
  const railValue = readRecord(railEntry[key]);
  if (!railValue) {
    failures.push(`subgoal_${index + 1}_rail_${key}_missing`);
    return;
  }
  const ledgerValue = readRecord(ledgerEntry[key]);
  if (ledgerValue && !jsonEqual(railValue, ledgerValue)) {
    failures.push(`subgoal_${index + 1}_rail_${key}_mismatch`);
  }
};

const requiredInputBindingsFor = (entry: RecordLike | null): RecordLike[] =>
  readArray(entry?.input_bindings)
    .map(readRecord)
    .filter((binding: RecordLike | null): binding is RecordLike => Boolean(binding))
    .filter((binding) => binding.required === true);

export const evaluateCompoundCapabilityScenario = (input: {
  scenario: CompoundCapabilityScenario;
  ask: RecordLike;
  debugExport: unknown;
}): CompoundCapabilityScenarioSummary => {
  const failures: string[] = [];
  const turnId = readString(input.ask.turn_id);
  const payload = extractPayload(input.debugExport);
  const contract = compoundContractFor(input.ask, input.debugExport);
  const contractSubgoals = readArray(contract?.subgoals)
    .map(readRecord)
    .filter((entry: RecordLike | null): entry is RecordLike => Boolean(entry));
  const plannedSteps = plannedStepsFor(input.ask, input.debugExport);
  const ledger = compoundLedgerFor(input.ask, input.debugExport);
  const railStatuses = compoundRailStatusesFor(input.ask, input.debugExport);
  const missingSummary = compoundMissingSummaryFor(input.ask, input.debugExport);
  const codexParityRailTable = codexParityRailTableFor(input.ask, input.debugExport);
  const terminalErrorCode = terminalErrorCodeFor(input.ask, input.debugExport);
  const terminalAuthorityKind = terminalAuthorityKindFor(input.ask, input.debugExport);
  const visibleTerminalKind = visibleTerminalKindFor(input.ask, input.debugExport);
  const backendVisibleTerminalKind = backendVisibleTerminalKindFor(input.debugExport);
  const finalAnswerSource = finalAnswerSourceFor(input.ask, input.debugExport);
  const acceptsRailOnlyTrace =
    input.scenario.id === "scholarly_numeric_parameters_then_calculator" ||
    input.scenario.acceptsObservationOnlyCompound === true;
  const acceptsObservationOnlyCompound = input.scenario.acceptsObservationOnlyCompound === true;

  if (!turnId) failures.push("ask_response_missing_turn_id");
  if (!contract) failures.push("compound_capability_contract_missing");
  if (contract && contract.schema !== "helix.compound_capability_contract.v1") failures.push("compound_capability_contract_schema_mismatch");
  if (contractSubgoals.length < input.scenario.expectedRequested.length) {
    failures.push(`compound_subgoals_dropped:${contractSubgoals.length}<${input.scenario.expectedRequested.length}`);
  }
  if (ledger.length < input.scenario.expectedRequested.length) {
    failures.push(`compound_subgoal_ledger_dropped:${ledger.length}<${input.scenario.expectedRequested.length}`);
  }
  if (railStatuses.length < input.scenario.expectedRequested.length) {
    failures.push(`compound_subgoal_rail_statuses_dropped:${railStatuses.length}<${input.scenario.expectedRequested.length}`);
  }

  const requestedCapabilities = contractSubgoals.map((entry) => maybeCapability(entry, "requested_capability") ?? "");
  const runtimeCapabilities = ledger.map((entry) => maybeCapability(entry, "runtime_capability"));
  const selectedCapabilities = ledger.map((entry) => maybeCapability(entry, "selected_capability"));
  const executedCapabilities = ledger.map((entry) => maybeCapability(entry, "executed_capability"));
  const observationKinds = ledger.map((entry) => maybeCapability(entry, "observation_kind"));
  const observationRefs = ledger.map((entry) => maybeCapability(entry, "observation_ref"));
  const observationProvenance = ledger.map((entry) => maybeCapability(entry, "observation_provenance"));
  const subgoalRequiredObservationKinds = ledger.map((entry) => readStringArray(entry.required_observation_kinds));
  const subgoalRequiredTerminalKinds = ledger.map((entry) => maybeCapability(entry, "required_terminal_kind"));
  const subgoalTerminalContributionKinds = ledger.map((entry) => maybeCapability(entry, "terminal_contribution_kind"));
  const subgoalContributionRoles = ledger.map((entry) => maybeCapability(entry, "contribution_role"));
  const subgoalAllowedSubstitutions = ledger.map((entry) => readStringArray(entry.allowed_substitutions));
  const subgoalForbiddenNearbyCapabilities = ledger.map((entry) => readStringArray(entry.forbidden_nearby_capabilities));
  const subgoalInputBindings = ledger.map((entry) =>
    readArray(entry.input_bindings)
      .map(readRecord)
      .filter((binding: RecordLike | null): binding is RecordLike => Boolean(binding)));
  const subgoalBoundInputRefs = ledger.map((entry) =>
    readArray(entry.bound_input_refs)
      .map(readRecord)
      .filter((binding: RecordLike | null): binding is RecordLike => Boolean(binding)));
  const railRequestedCapabilities = railStatuses.map((entry) => maybeCapability(entry, "requested_capability"));
  const railRuntimeCapabilities = railStatuses.map((entry) => maybeCapability(entry, "runtime_capability"));
  const railSelectedCapabilities = railStatuses.map((entry) => maybeCapability(entry, "selected_capability"));
  const railExecutedCapabilities = railStatuses.map((entry) => maybeCapability(entry, "executed_capability"));
  const railObservationKinds = railStatuses.map((entry) => maybeCapability(entry, "observation_kind"));
  const railObservationRefs = railStatuses.map((entry) => maybeCapability(entry, "observation_ref"));
  const railObservationProvenance = railStatuses.map((entry) => maybeCapability(entry, "observation_provenance"));
  const railRequiredObservationKinds = railStatuses.map((entry) => readStringArray(entry.required_observation_kinds));
  const railRequiredTerminalKinds = railStatuses.map((entry) => maybeCapability(entry, "required_terminal_kind"));
  const railTerminalContributionKinds = railStatuses.map((entry) => maybeCapability(entry, "terminal_contribution_kind"));
  const railContributionRoles = railStatuses.map((entry) => maybeCapability(entry, "contribution_role"));
  const railAllowedSubstitutions = railStatuses.map((entry) => readStringArray(entry.allowed_substitutions));
  const railForbiddenNearbyCapabilities = railStatuses.map((entry) => readStringArray(entry.forbidden_nearby_capabilities));
  const subgoalSatisfactions = ledger.map((entry) => maybeCapability(entry, "satisfaction"));
  const subgoalRailStatuses = railStatuses.map((entry) => maybeCapability(entry, "rail_status"));
  const subgoalFirstBrokenRails = (railStatuses.length > 0 ? railStatuses : ledger)
    .map((entry) => maybeCapability(entry, "first_broken_rail"));
  const subgoalRailFailureCodes = (railStatuses.length > 0 ? railStatuses : ledger)
    .map((entry) => maybeCapability(entry, "rail_failure_code"));
  const subgoalRepairTargets = (railStatuses.length > 0 ? railStatuses : ledger)
    .map((entry) => maybeCapability(entry, "repair_target"));
  const missingCompoundSubgoalIds = readStringArray(missingSummary?.missing_compound_subgoal_ids);
  const missingRequiredCapabilities = readStringArray(missingSummary?.missing_required_capabilities);
  const nextMissingSubgoalId = readString(missingSummary?.next_missing_subgoal_id);
  const compoundComplete = typeof missingSummary?.complete === "boolean" ? missingSummary.complete : null;
  const firstMissingSubgoal =
    railStatuses.find((entry) => !subgoalHasSatisfiedObservation(entry)) ??
    ledger.find((entry) => !subgoalHasSatisfiedObservation(entry)) ??
    null;
  const firstMissingSubgoalId = readString(firstMissingSubgoal?.subgoal_id);
  const firstMissingSubgoalFirstBrokenRail = readString(firstMissingSubgoal?.first_broken_rail);
  const firstMissingSubgoalRailFailureCode = readString(firstMissingSubgoal?.rail_failure_code);
  const firstMissingSubgoalRepairTarget = readString(firstMissingSubgoal?.repair_target);
  const topLevelCompoundSubgoalCount = readNumber(codexParityRailTable?.compound_subgoal_count);
  const topLevelFirstIncompleteCompoundSubgoalId =
    readString(codexParityRailTable?.first_incomplete_compound_subgoal_id);
  const topLevelFirstIncompleteCompoundRequestedCapability =
    readString(codexParityRailTable?.first_incomplete_compound_requested_capability);
  const topLevelFirstIncompleteCompoundRuntimeCapability =
    readString(codexParityRailTable?.first_incomplete_compound_runtime_capability);
  const topLevelFirstIncompleteCompoundSelectedCapability =
    readString(codexParityRailTable?.first_incomplete_compound_selected_capability);
  const topLevelFirstIncompleteCompoundExecutedCapability =
    readString(codexParityRailTable?.first_incomplete_compound_executed_capability);
  const topLevelCompoundFirstBrokenRail = readString(codexParityRailTable?.compound_first_broken_rail);
  const topLevelCompoundRailFailureCode = readString(codexParityRailTable?.compound_rail_failure_code);
  const topLevelCompoundRepairTarget = readString(codexParityRailTable?.compound_repair_target);
  const topLevelCompoundIncompleteSubgoalDidToolRun =
    typeof codexParityRailTable?.compound_incomplete_subgoal_did_tool_run === "boolean"
      ? codexParityRailTable.compound_incomplete_subgoal_did_tool_run
      : null;
  const expectsFailedSubgoal = (input.scenario.expectedSubgoalSatisfaction ?? [])
    .some((entry) => matchesExpected("failed", entry));
  for (const forbidden of input.scenario.forbiddenRuntime ?? []) {
    if (runtimeCapabilities.includes(forbidden) || railRuntimeCapabilities.includes(forbidden)) {
      failures.push(`forbidden_runtime_capability_observed:${forbidden}`);
    }
  }
  for (const forbidden of input.scenario.forbiddenExecuted ?? []) {
    if (executedCapabilities.includes(forbidden) || railExecutedCapabilities.includes(forbidden)) {
      failures.push(`forbidden_executed_capability_observed:${forbidden}`);
    }
  }
  if (input.scenario.expectedRequested.length > 1) {
    if (!codexParityRailTable) {
      failures.push("codex_parity_agent_spine_rail_table_missing");
    } else if (topLevelCompoundSubgoalCount !== input.scenario.expectedRequested.length) {
      failures.push(`top_level_compound_subgoal_count_mismatch:${topLevelCompoundSubgoalCount ?? "null"}!=${input.scenario.expectedRequested.length}`);
    }
  }
  if (expectsFailedSubgoal && missingCompoundSubgoalIds.length === 0) {
    failures.push("compound_missing_subgoal_summary_missing");
  }
  if (expectsFailedSubgoal) {
    if (!nextMissingSubgoalId) failures.push("next_missing_subgoal_id_missing");
    if (!firstMissingSubgoalId) failures.push("first_missing_subgoal_id_missing");
    if (firstMissingSubgoalId && !missingCompoundSubgoalIds.includes(firstMissingSubgoalId)) {
      failures.push(`first_missing_subgoal_not_in_summary:${firstMissingSubgoalId}`);
    }
    if (firstMissingSubgoalId && nextMissingSubgoalId && firstMissingSubgoalId !== nextMissingSubgoalId) {
      failures.push(`next_missing_subgoal_mismatch:${nextMissingSubgoalId}!=${firstMissingSubgoalId}`);
    }
    if (firstMissingSubgoalId && !firstMissingSubgoalFirstBrokenRail) {
      failures.push("first_missing_subgoal_first_broken_rail_missing");
    }
    if (firstMissingSubgoalId && !firstMissingSubgoalRailFailureCode) {
      failures.push("first_missing_subgoal_failure_code_missing");
    }
    if (firstMissingSubgoalId && !firstMissingSubgoalRepairTarget) {
      failures.push("first_missing_subgoal_repair_target_missing");
    }
    if (firstMissingSubgoalId && topLevelFirstIncompleteCompoundSubgoalId !== firstMissingSubgoalId) {
      failures.push(`top_level_first_incomplete_subgoal_mismatch:${topLevelFirstIncompleteCompoundSubgoalId ?? "null"}!=${firstMissingSubgoalId}`);
    }
    const expectedTopLevelRequested = maybeCapability(firstMissingSubgoal ?? {}, "requested_capability");
    const expectedTopLevelRuntime = maybeCapability(firstMissingSubgoal ?? {}, "runtime_capability");
    const expectedTopLevelSelected = maybeCapability(firstMissingSubgoal ?? {}, "selected_capability");
    const expectedTopLevelExecuted = maybeCapability(firstMissingSubgoal ?? {}, "executed_capability");
    const expectedTopLevelDidToolRun = Boolean(expectedTopLevelExecuted);
    if (topLevelFirstIncompleteCompoundRequestedCapability !== expectedTopLevelRequested) {
      failures.push(`top_level_first_incomplete_requested_mismatch:${topLevelFirstIncompleteCompoundRequestedCapability ?? "null"}!=${expectedTopLevelRequested}`);
    }
    if (topLevelFirstIncompleteCompoundRuntimeCapability !== expectedTopLevelRuntime) {
      failures.push(`top_level_first_incomplete_runtime_mismatch:${topLevelFirstIncompleteCompoundRuntimeCapability ?? "null"}!=${expectedTopLevelRuntime}`);
    }
    if (topLevelFirstIncompleteCompoundSelectedCapability !== expectedTopLevelSelected) {
      failures.push(`top_level_first_incomplete_selected_mismatch:${topLevelFirstIncompleteCompoundSelectedCapability ?? "null"}!=${expectedTopLevelSelected}`);
    }
    if (topLevelFirstIncompleteCompoundExecutedCapability !== expectedTopLevelExecuted) {
      failures.push(`top_level_first_incomplete_executed_mismatch:${topLevelFirstIncompleteCompoundExecutedCapability ?? "null"}!=${expectedTopLevelExecuted}`);
    }
    if (topLevelCompoundIncompleteSubgoalDidToolRun !== expectedTopLevelDidToolRun) {
      failures.push(`top_level_incomplete_subgoal_did_tool_run_mismatch:${String(topLevelCompoundIncompleteSubgoalDidToolRun)}!=${String(expectedTopLevelDidToolRun)}`);
    }
    if (firstMissingSubgoalFirstBrokenRail && topLevelCompoundFirstBrokenRail !== firstMissingSubgoalFirstBrokenRail) {
      failures.push(`top_level_compound_first_broken_rail_mismatch:${topLevelCompoundFirstBrokenRail ?? "null"}!=${firstMissingSubgoalFirstBrokenRail}`);
    }
    if (firstMissingSubgoalRailFailureCode && topLevelCompoundRailFailureCode !== firstMissingSubgoalRailFailureCode) {
      failures.push(`top_level_compound_rail_failure_code_mismatch:${topLevelCompoundRailFailureCode ?? "null"}!=${firstMissingSubgoalRailFailureCode}`);
    }
    if (firstMissingSubgoalRepairTarget && topLevelCompoundRepairTarget !== firstMissingSubgoalRepairTarget) {
      failures.push(`top_level_compound_repair_target_mismatch:${topLevelCompoundRepairTarget ?? "null"}!=${firstMissingSubgoalRepairTarget}`);
    }
  } else {
    if (missingCompoundSubgoalIds.length > 0) {
      failures.push(`unexpected_missing_compound_subgoal_ids:${missingCompoundSubgoalIds.join(",")}`);
    }
    if (missingRequiredCapabilities.length > 0) {
      failures.push(`unexpected_missing_required_capabilities:${missingRequiredCapabilities.join(",")}`);
    }
    if (nextMissingSubgoalId) failures.push(`unexpected_next_missing_subgoal_id:${nextMissingSubgoalId}`);
    if (firstMissingSubgoalId) failures.push(`unexpected_first_missing_subgoal_id:${firstMissingSubgoalId}`);
    if (compoundComplete === false && !acceptsObservationOnlyCompound) failures.push("compound_complete_false");
    if (topLevelFirstIncompleteCompoundSubgoalId) {
      failures.push(`unexpected_top_level_first_incomplete_subgoal_id:${topLevelFirstIncompleteCompoundSubgoalId}`);
    }
    if (topLevelCompoundFirstBrokenRail) {
      failures.push(`unexpected_top_level_compound_first_broken_rail:${topLevelCompoundFirstBrokenRail}`);
    }
    if (topLevelCompoundRailFailureCode) {
      failures.push(`unexpected_top_level_compound_rail_failure_code:${topLevelCompoundRailFailureCode}`);
    }
    if (topLevelCompoundRepairTarget) {
      failures.push(`unexpected_top_level_compound_repair_target:${topLevelCompoundRepairTarget}`);
    }
    if (topLevelCompoundIncompleteSubgoalDidToolRun !== null) {
      failures.push(`unexpected_top_level_incomplete_subgoal_did_tool_run:${String(topLevelCompoundIncompleteSubgoalDidToolRun)}`);
    }
  }

  input.scenario.expectedRequested.forEach((expected, index) => {
    const contractSubgoal = contractSubgoals[index] ?? null;
    const ledgerEntry = ledger[index] ?? null;
    const railEntry = railStatuses[index] ?? null;
    const requested = maybeCapability(contractSubgoal ?? {}, "requested_capability");
    const contractRuntime = maybeCapability(contractSubgoal ?? {}, "runtime_capability") ?? requested;
    const runtime = maybeCapability(ledgerEntry ?? {}, "runtime_capability");
    const selected = maybeCapability(ledgerEntry ?? {}, "selected_capability");
    const executed = maybeCapability(ledgerEntry ?? {}, "executed_capability");
    const observationKind = maybeCapability(ledgerEntry ?? {}, "observation_kind");
    const observationRef = maybeCapability(ledgerEntry ?? {}, "observation_ref");
    const observationProvenance = maybeCapability(ledgerEntry ?? {}, "observation_provenance");
    const satisfaction = maybeCapability(ledgerEntry ?? {}, "satisfaction");
    const railRequested = maybeCapability(railEntry ?? {}, "requested_capability");
    const railRuntime = maybeCapability(railEntry ?? {}, "runtime_capability");
    const railExecuted = maybeCapability(railEntry ?? {}, "executed_capability");
    const railObservationKind = maybeCapability(railEntry ?? {}, "observation_kind");
    const railObservationRef = maybeCapability(railEntry ?? {}, "observation_ref");
    const railObservationProvenance = maybeCapability(railEntry ?? {}, "observation_provenance");
    const railSatisfaction = maybeCapability(railEntry ?? {}, "satisfaction");
    const railStatus = maybeCapability(railEntry ?? {}, "rail_status");
    const firstBrokenRail = maybeCapability(ledgerEntry ?? {}, "first_broken_rail");
    const failureCode = maybeCapability(ledgerEntry ?? {}, "rail_failure_code");
    const repairTarget = maybeCapability(ledgerEntry ?? {}, "repair_target");
    const railFirstBrokenRail = maybeCapability(railEntry ?? {}, "first_broken_rail");
    const railFailureCode = maybeCapability(railEntry ?? {}, "rail_failure_code");
    const railRepairTarget = maybeCapability(railEntry ?? {}, "repair_target");
    const ledgerArgs = subgoalArgsFor(contractSubgoal, ledgerEntry);
    const railArgs = readRecord(railEntry?.args);
    const contractInputBindings = requiredInputBindingsFor(contractSubgoal);
    const requiredInputBindings = requiredInputBindingsFor(ledgerEntry);
    const boundInputRefs = readArray(ledgerEntry?.bound_input_refs).map(readRecord).filter(Boolean);
    const unresolvedInputBindings = readArray(ledgerEntry?.unresolved_input_bindings).map(readRecord).filter(Boolean);
    const expectedInputBindingFromCapability = input.scenario.expectedInputBindingFromCapabilities?.[index];
    const expectedRuntime = index < input.scenario.expectedRuntime.length ? input.scenario.expectedRuntime[index] : expected;
    const expectedExecuted = input.scenario.expectedExecuted && index < input.scenario.expectedExecuted.length
      ? input.scenario.expectedExecuted[index]
      : expectedRuntime;
    const expectedSatisfaction =
      input.scenario.expectedSubgoalSatisfaction && index < input.scenario.expectedSubgoalSatisfaction.length
        ? input.scenario.expectedSubgoalSatisfaction[index]
        : "satisfied";
    const expectedRailStatus =
      input.scenario.expectedRailStatus && index < input.scenario.expectedRailStatus.length
        ? input.scenario.expectedRailStatus[index]
        : (
      expectedSatisfaction === "satisfied" ? "complete" : "fail_closed"
    );
    const expectedFirstBrokenRail = input.scenario.expectedFirstBrokenRail?.[index];
    const expectedRailFailureCode = input.scenario.expectedRailFailureCode?.[index];
    const expectedRepairTarget = input.scenario.expectedRepairTarget?.[index];
    const contractRequiredObservationKinds = readStringArray(contractSubgoal?.required_observation_kinds);
    const ledgerRequiredObservationKinds = readStringArray(ledgerEntry?.required_observation_kinds);
    const railRequiredObservationKindsForSubgoal = readStringArray(railEntry?.required_observation_kinds);
    const contractRequiredTerminalKind = readString(contractSubgoal?.required_terminal_kind);
    const ledgerRequiredTerminalKind = readString(ledgerEntry?.required_terminal_kind);
    const railRequiredTerminalKind = readString(railEntry?.required_terminal_kind);
    const contractTerminalContributionKind = readString(contractSubgoal?.terminal_contribution_kind);
    const ledgerTerminalContributionKind = readString(ledgerEntry?.terminal_contribution_kind);
    const railTerminalContributionKind = readString(railEntry?.terminal_contribution_kind);
    const contractContributionRole = readString(contractSubgoal?.contribution_role);
    const ledgerContributionRole = readString(ledgerEntry?.contribution_role);
    const railContributionRole = readString(railEntry?.contribution_role);
    const contractAllowedSubstitutions = readStringArray(contractSubgoal?.allowed_substitutions);
    const ledgerAllowedSubstitutions = readStringArray(ledgerEntry?.allowed_substitutions);
    const railAllowedSubstitutionsForSubgoal = readStringArray(railEntry?.allowed_substitutions);
    const contractForbiddenNearbyCapabilities = readStringArray(contractSubgoal?.forbidden_nearby_capabilities);
    const ledgerForbiddenNearbyCapabilities = readStringArray(ledgerEntry?.forbidden_nearby_capabilities);
    const railForbiddenNearbyCapabilitiesForSubgoal = readStringArray(railEntry?.forbidden_nearby_capabilities);
    const contractSubgoalId = readString(contractSubgoal?.subgoal_id);
    const plannedStep = plannedSteps.find((step) =>
      readString(step.compound_subgoal_id) === contractSubgoalId ||
      readString(step.requested_capability) === requested
    ) ?? null;
    const plannedInputBindings = requiredInputBindingsFor(plannedStep);
    const plannedTerminalContributionKind = readString(plannedStep?.terminal_contribution_kind);
    const plannedForbiddenNearbyCapabilities = readStringArray(plannedStep?.forbidden_nearby_capabilities);

    if (!matchesExpected(requested, expected)) {
      failures.push(`subgoal_${index + 1}_requested_mismatch:${requested ?? "null"}`);
    }
    if (!selected) failures.push(`subgoal_${index + 1}_selected_capability_missing`);
    if (runtime !== contractRuntime) {
      failures.push(`subgoal_${index + 1}_runtime_mismatch:${runtime ?? "null"}!=${contractRuntime ?? "null"}`);
    }
    if (!matchesExpected(executed, expectedExecuted)) {
      failures.push(`subgoal_${index + 1}_executed_mismatch:${executed ?? "null"}`);
    }
    if (!ledgerArgs && !acceptsRailOnlyTrace) failures.push(`subgoal_${index + 1}_args_missing`);
    if (contractSubgoal) {
      if (contractRequiredObservationKinds.length === 0) failures.push(`subgoal_${index + 1}_contract_required_observation_kinds_missing`);
      if (!contractRequiredTerminalKind) failures.push(`subgoal_${index + 1}_contract_required_terminal_kind_missing`);
      if (!contractTerminalContributionKind) failures.push(`subgoal_${index + 1}_contract_terminal_contribution_kind_missing`);
      if (!contractContributionRole) failures.push(`subgoal_${index + 1}_contract_contribution_role_missing`);
      if (!Array.isArray(contractSubgoal.allowed_substitutions)) failures.push(`subgoal_${index + 1}_contract_allowed_substitutions_missing`);
      if (!Array.isArray(contractSubgoal.forbidden_nearby_capabilities)) failures.push(`subgoal_${index + 1}_contract_forbidden_nearby_capabilities_missing`);
    }
    if (ledgerEntry) {
      if (ledgerRequiredObservationKinds.length === 0) failures.push(`subgoal_${index + 1}_required_observation_kinds_missing`);
      if (!ledgerRequiredTerminalKind) failures.push(`subgoal_${index + 1}_required_terminal_kind_missing`);
      if (!ledgerTerminalContributionKind) failures.push(`subgoal_${index + 1}_terminal_contribution_kind_missing`);
      if (!ledgerContributionRole) failures.push(`subgoal_${index + 1}_contribution_role_missing`);
      if (!Array.isArray(ledgerEntry.allowed_substitutions)) failures.push(`subgoal_${index + 1}_allowed_substitutions_missing`);
      if (!Array.isArray(ledgerEntry.forbidden_nearby_capabilities)) failures.push(`subgoal_${index + 1}_forbidden_nearby_capabilities_missing`);
    }
    if (!jsonEqual(contractRequiredObservationKinds, ledgerRequiredObservationKinds)) {
      failures.push(`subgoal_${index + 1}_contract_required_observation_kinds_mismatch`);
    }
    if (contractRequiredTerminalKind !== ledgerRequiredTerminalKind) {
      failures.push(
        `subgoal_${index + 1}_contract_required_terminal_kind_mismatch:${contractRequiredTerminalKind ?? "null"}!=${ledgerRequiredTerminalKind ?? "null"}`,
      );
    }
    if (contractTerminalContributionKind !== ledgerTerminalContributionKind) {
      failures.push(
        `subgoal_${index + 1}_contract_terminal_contribution_kind_mismatch:${contractTerminalContributionKind ?? "null"}!=${ledgerTerminalContributionKind ?? "null"}`,
      );
    }
    if (contractContributionRole !== ledgerContributionRole) {
      failures.push(
        `subgoal_${index + 1}_contract_contribution_role_mismatch:${contractContributionRole ?? "null"}!=${ledgerContributionRole ?? "null"}`,
      );
    }
    if (!jsonEqual(contractAllowedSubstitutions, ledgerAllowedSubstitutions)) {
      failures.push(`subgoal_${index + 1}_contract_allowed_substitutions_mismatch`);
    }
    if (!jsonEqual(contractForbiddenNearbyCapabilities, ledgerForbiddenNearbyCapabilities)) {
      failures.push(`subgoal_${index + 1}_contract_forbidden_nearby_capabilities_mismatch`);
    }
    if (expectedSatisfaction === "satisfied") {
      if (!observationKind) failures.push(`subgoal_${index + 1}_observation_kind_missing`);
      if (!observationRef) failures.push(`subgoal_${index + 1}_observation_ref_missing`);
      if (!observationProvenance) failures.push(`subgoal_${index + 1}_observation_provenance_missing`);
    }
    if (!matchesExpected(satisfaction, expectedSatisfaction)) {
      failures.push(`subgoal_${index + 1}_satisfaction_mismatch:${satisfaction ?? "null"}`);
    }
    if (satisfaction === "satisfied" && !observationRef) {
      failures.push(`subgoal_${index + 1}_satisfied_observation_ref_missing`);
    }
    if (expectedFirstBrokenRail !== undefined && !matchesExpected(firstBrokenRail, expectedFirstBrokenRail)) {
      failures.push(`subgoal_${index + 1}_first_broken_rail_mismatch:${firstBrokenRail ?? "null"}`);
    }
    if (expectedRailFailureCode !== undefined && !matchesExpected(failureCode, expectedRailFailureCode)) {
      failures.push(`subgoal_${index + 1}_failure_code_mismatch:${failureCode ?? "null"}`);
    }
    if (expectedRepairTarget !== undefined && !matchesExpected(repairTarget, expectedRepairTarget)) {
      failures.push(`subgoal_${index + 1}_repair_target_mismatch:${repairTarget ?? "null"}`);
    }
    if (satisfaction && satisfaction !== "satisfied") {
      if (!firstBrokenRail) failures.push(`subgoal_${index + 1}_first_broken_rail_missing`);
      if (!failureCode) failures.push(`subgoal_${index + 1}_failure_code_missing`);
      if (!repairTarget) failures.push(`subgoal_${index + 1}_repair_target_missing`);
    }
    if (expectedInputBindingFromCapability !== undefined) {
      if (expectedInputBindingFromCapability === null) {
        if (requiredInputBindings.length > 0) failures.push(`subgoal_${index + 1}_unexpected_required_input_binding`);
        if (plannedInputBindings.length > 0) failures.push(`subgoal_${index + 1}_planned_unexpected_required_input_binding`);
      } else {
        const expectedFromCapabilities = Array.isArray(expectedInputBindingFromCapability)
          ? expectedInputBindingFromCapability
          : [expectedInputBindingFromCapability];
        const actualFromCapabilities = requiredInputBindings
          .map((binding) => readString(binding.from_capability))
          .filter((entry: string | null): entry is string => Boolean(entry));
        const missing = expectedFromCapabilities.filter((entry) => !actualFromCapabilities.includes(entry));
        if (missing.length > 0) {
          failures.push(`subgoal_${index + 1}_input_binding_from_capability_missing:${missing.join(",")}`);
        }
        const plannedFromCapabilities = plannedInputBindings
          .map((binding) => readString(binding.from_capability))
          .filter((entry: string | null): entry is string => Boolean(entry));
        const plannedMissing = expectedFromCapabilities.filter((entry) => !plannedFromCapabilities.includes(entry));
        if (!plannedStep) failures.push(`subgoal_${index + 1}_planned_step_missing`);
        if (plannedMissing.length > 0) {
          failures.push(`subgoal_${index + 1}_planned_input_binding_from_capability_missing:${plannedMissing.join(",")}`);
        }
        if (contractSubgoal) {
          const contractDependencyIds = readStringArray(contractSubgoal.depends_on_subgoal_ids);
          const plannedDependencyIds = readStringArray(plannedStep?.depends_on_subgoal_ids);
          if (!jsonEqual(plannedDependencyIds, contractDependencyIds)) {
            failures.push(`subgoal_${index + 1}_planned_depends_on_subgoal_ids_mismatch`);
          }
          if (!jsonEqual(readArray(plannedStep?.input_bindings), readArray(contractSubgoal.input_bindings))) {
            failures.push(`subgoal_${index + 1}_planned_input_bindings_mismatch`);
          }
        }
        for (const expectedFromCapability of expectedFromCapabilities) {
          const ledgerBinding = requiredInputBindings.find((binding) =>
            readString(binding.from_capability) === expectedFromCapability
          ) ?? null;
          const contractBinding = contractInputBindings.find((binding) =>
            readString(binding.from_capability) === expectedFromCapability
          ) ?? null;
          if (!ledgerBinding || !contractBinding) continue;
          const ledgerFromSubgoalId = readString(ledgerBinding.from_subgoal_id);
          const contractFromSubgoalId = readString(contractBinding.from_subgoal_id);
          if (ledgerFromSubgoalId !== contractFromSubgoalId) {
            failures.push(
              `subgoal_${index + 1}_input_binding_from_subgoal_id_mismatch:${ledgerFromSubgoalId ?? "null"}!=${contractFromSubgoalId ?? "null"}`,
            );
          }
          if (!stringArraysEqual(ledgerBinding.required_observation_kinds, contractBinding.required_observation_kinds)) {
            failures.push(`subgoal_${index + 1}_input_binding_required_observations_mismatch:${expectedFromCapability}`);
          }
          if (ledgerBinding.required !== contractBinding.required) {
            failures.push(`subgoal_${index + 1}_input_binding_required_flag_mismatch:${expectedFromCapability}`);
          }
          if (readString(ledgerBinding.status) !== readString(contractBinding.status)) {
            failures.push(`subgoal_${index + 1}_input_binding_status_mismatch:${expectedFromCapability}`);
          }
          if (readString(ledgerBinding.arg_name) !== readString(contractBinding.arg_name)) {
            failures.push(`subgoal_${index + 1}_input_binding_arg_name_mismatch:${expectedFromCapability}`);
          }
          if (readString(ledgerBinding.binding_kind) !== readString(contractBinding.binding_kind)) {
            failures.push(`subgoal_${index + 1}_input_binding_kind_mismatch:${expectedFromCapability}`);
          }
        }
      }
    }
    if (plannedStep && contractSubgoal && plannedTerminalContributionKind !== contractTerminalContributionKind) {
      failures.push(
        `subgoal_${index + 1}_planned_terminal_contribution_kind_mismatch:${plannedTerminalContributionKind ?? "null"}!=${contractTerminalContributionKind ?? "null"}`,
      );
    }
    if (plannedStep && contractSubgoal && !jsonEqual(plannedForbiddenNearbyCapabilities, contractForbiddenNearbyCapabilities)) {
      failures.push(`subgoal_${index + 1}_planned_forbidden_nearby_capabilities_mismatch`);
    }
    if (expectedSatisfaction === "satisfied" && requiredInputBindings.length > 0) {
      if (boundInputRefs.length === 0) failures.push(`subgoal_${index + 1}_bound_input_refs_missing`);
      if (unresolvedInputBindings.length > 0) failures.push(`subgoal_${index + 1}_unresolved_input_bindings_present`);
    }
    if (!railEntry) {
      failures.push(`subgoal_${index + 1}_rail_status_entry_missing`);
    } else {
      if (!matchesExpected(railRequested, expected)) {
        failures.push(`subgoal_${index + 1}_rail_requested_mismatch:${railRequested ?? "null"}`);
      }
      if (railRuntime !== runtime) {
        failures.push(`subgoal_${index + 1}_rail_runtime_mismatch:${railRuntime ?? "null"}!=${runtime ?? "null"}`);
      }
      if (!matchesExpected(railExecuted, expectedExecuted)) {
        failures.push(`subgoal_${index + 1}_rail_executed_mismatch:${railExecuted ?? "null"}`);
      }
      if (expectedSatisfaction === "satisfied") {
        if (!railObservationKind) failures.push(`subgoal_${index + 1}_rail_observation_kind_missing`);
        if (!railObservationRef) failures.push(`subgoal_${index + 1}_rail_observation_ref_missing`);
        if (!railObservationProvenance) failures.push(`subgoal_${index + 1}_rail_observation_provenance_missing`);
      }
      if (railObservationProvenance !== observationProvenance) {
        failures.push(
          `subgoal_${index + 1}_rail_observation_provenance_mismatch:${railObservationProvenance ?? "null"}!=${observationProvenance ?? "null"}`,
        );
      }
      if (railSatisfaction !== satisfaction) {
        failures.push(`subgoal_${index + 1}_rail_satisfaction_mismatch:${railSatisfaction ?? "null"}!=${satisfaction ?? "null"}`);
      }
      if (railSatisfaction === "satisfied" && !railObservationRef) {
        failures.push(`subgoal_${index + 1}_rail_satisfied_observation_ref_missing`);
      }
      if (!matchesExpected(railStatus, expectedRailStatus)) {
        failures.push(`subgoal_${index + 1}_rail_status_mismatch:${railStatus ?? "null"}`);
      }
      if (railStatus === "complete") {
        if (railSatisfaction !== "satisfied") failures.push(`subgoal_${index + 1}_rail_complete_satisfaction_not_satisfied`);
        if (!railObservationRef) failures.push(`subgoal_${index + 1}_rail_complete_observation_ref_missing`);
      }
      if (railRequiredObservationKindsForSubgoal.length === 0) failures.push(`subgoal_${index + 1}_rail_required_observation_kinds_missing`);
      if (!railRequiredTerminalKind) failures.push(`subgoal_${index + 1}_rail_required_terminal_kind_missing`);
      if (!railTerminalContributionKind) failures.push(`subgoal_${index + 1}_rail_terminal_contribution_kind_missing`);
      if (!railContributionRole) failures.push(`subgoal_${index + 1}_rail_contribution_role_missing`);
      if (!Array.isArray(railEntry.allowed_substitutions)) failures.push(`subgoal_${index + 1}_rail_allowed_substitutions_missing`);
      if (!Array.isArray(railEntry.forbidden_nearby_capabilities)) failures.push(`subgoal_${index + 1}_rail_forbidden_nearby_capabilities_missing`);
      if (!jsonEqual(railRequiredObservationKindsForSubgoal, ledgerRequiredObservationKinds)) {
        failures.push(`subgoal_${index + 1}_rail_required_observation_kinds_mismatch`);
      }
      if (railRequiredTerminalKind !== ledgerRequiredTerminalKind) {
        failures.push(
          `subgoal_${index + 1}_rail_required_terminal_kind_mismatch:${railRequiredTerminalKind ?? "null"}!=${ledgerRequiredTerminalKind ?? "null"}`,
        );
      }
      if (railTerminalContributionKind !== ledgerTerminalContributionKind) {
        failures.push(
          `subgoal_${index + 1}_rail_terminal_contribution_kind_mismatch:${railTerminalContributionKind ?? "null"}!=${ledgerTerminalContributionKind ?? "null"}`,
        );
      }
      if (railContributionRole !== ledgerContributionRole) {
        failures.push(`subgoal_${index + 1}_rail_contribution_role_mismatch:${railContributionRole ?? "null"}!=${ledgerContributionRole ?? "null"}`);
      }
      if (!jsonEqual(railAllowedSubstitutionsForSubgoal, ledgerAllowedSubstitutions)) {
        failures.push(`subgoal_${index + 1}_rail_allowed_substitutions_mismatch`);
      }
      if (!jsonEqual(railForbiddenNearbyCapabilitiesForSubgoal, ledgerForbiddenNearbyCapabilities)) {
        failures.push(`subgoal_${index + 1}_rail_forbidden_nearby_capabilities_mismatch`);
      }
      if (expectedRailFailureCode !== undefined && !matchesExpected(railFailureCode, expectedRailFailureCode)) {
        failures.push(`subgoal_${index + 1}_rail_failure_code_mismatch:${railFailureCode ?? "null"}`);
      }
      if (expectedFirstBrokenRail !== undefined && !matchesExpected(railFirstBrokenRail, expectedFirstBrokenRail)) {
        failures.push(`subgoal_${index + 1}_rail_first_broken_rail_expected_mismatch:${railFirstBrokenRail ?? "null"}`);
      }
      if (expectedRepairTarget !== undefined && !matchesExpected(railRepairTarget, expectedRepairTarget)) {
        failures.push(`subgoal_${index + 1}_rail_repair_target_expected_mismatch:${railRepairTarget ?? "null"}`);
      }
      if (railFailureCode !== failureCode) {
        failures.push(`subgoal_${index + 1}_rail_failure_code_mirror_mismatch:${railFailureCode ?? "null"}!=${failureCode ?? "null"}`);
      }
      if (railFirstBrokenRail !== firstBrokenRail) {
        failures.push(`subgoal_${index + 1}_rail_first_broken_rail_mismatch:${railFirstBrokenRail ?? "null"}!=${firstBrokenRail ?? "null"}`);
      }
      if (railRepairTarget !== repairTarget) {
        failures.push(`subgoal_${index + 1}_rail_repair_target_mismatch:${railRepairTarget ?? "null"}!=${repairTarget ?? "null"}`);
      }
      if (railSatisfaction && railSatisfaction !== "satisfied") {
        if (!railFirstBrokenRail) failures.push(`subgoal_${index + 1}_rail_first_broken_rail_missing`);
        if (!railFailureCode) failures.push(`subgoal_${index + 1}_rail_failure_code_missing`);
        if (!railRepairTarget) failures.push(`subgoal_${index + 1}_rail_repair_target_missing`);
      }
      if (!railArgs && !acceptsRailOnlyTrace) {
        failures.push(`subgoal_${index + 1}_rail_args_missing`);
      } else if (ledgerArgs && !acceptsRailOnlyTrace && !jsonEqual(railArgs, ledgerArgs)) {
        failures.push(`subgoal_${index + 1}_rail_args_mismatch`);
      }
      mirrorNullableString({ failures, index, ledgerEntry, railEntry, key: "runtime_capability" });
      if (!acceptsRailOnlyTrace) {
        mirrorRecord({ failures, index, ledgerEntry, railEntry, key: "planned_args" });
        mirrorRecord({ failures, index, ledgerEntry, railEntry, key: "selected_args" });
      }
      mirrorArray({ failures, index, ledgerEntry, railEntry, key: "required_args" });
      mirrorArray({ failures, index, ledgerEntry, railEntry, key: "optional_args" });
      mirrorArray({ failures, index, ledgerEntry, railEntry, key: "required_observation_kinds" });
      mirrorNullableString({ failures, index, ledgerEntry, railEntry, key: "required_terminal_kind" });
      mirrorNullableString({ failures, index, ledgerEntry, railEntry, key: "terminal_contribution_kind" });
      mirrorNullableString({ failures, index, ledgerEntry, railEntry, key: "contribution_role" });
      mirrorArray({ failures, index, ledgerEntry, railEntry, key: "allowed_substitutions" });
      mirrorArray({ failures, index, ledgerEntry, railEntry, key: "forbidden_nearby_capabilities" });
      mirrorArray({ failures, index, ledgerEntry, railEntry, key: "input_bindings" });
      mirrorArray({ failures, index, ledgerEntry, railEntry, key: "bound_input_refs" });
      mirrorArray({ failures, index, ledgerEntry, railEntry, key: "unresolved_input_bindings" });
      if (ledgerEntry && railEntry && hasOwn(ledgerEntry, "support_refs")) {
        if (!Array.isArray(railEntry.support_refs)) {
          failures.push(`subgoal_${index + 1}_rail_support_refs_missing`);
        } else if (!stringArraysEqual(railEntry.support_refs, ledgerEntry.support_refs)) {
          failures.push(`subgoal_${index + 1}_rail_support_refs_mismatch`);
        }
      }
    }
  });

  if (input.scenario.expectedCalculatorExpression) {
    const calculatorIndex = input.scenario.expectedRuntime.findIndex((entry) =>
      Array.isArray(entry)
        ? entry.includes("scientific-calculator.solve_expression")
        : entry === "scientific-calculator.solve_expression",
    );
    const args = subgoalArgsFor(contractSubgoals[calculatorIndex] ?? null, ledger[calculatorIndex] ?? null);
    const expression = expressionFor(args);
    if (expression !== input.scenario.expectedCalculatorExpression) {
      failures.push(`calculator_expression_mismatch:${expression ?? "null"}`);
    }
    if (expression && NON_MATH_CALCULATOR_ARG_PATTERN.test(expression)) {
      failures.push("calculator_expression_contains_non_math_prompt_text");
    }
    const railExpression = expressionFor(readRecord(railStatuses[calculatorIndex]?.args));
    if (railExpression !== input.scenario.expectedCalculatorExpression) {
      failures.push(`calculator_rail_expression_mismatch:${railExpression ?? "null"}`);
    }
    if (railExpression && NON_MATH_CALCULATOR_ARG_PATTERN.test(railExpression)) {
      failures.push("calculator_rail_expression_contains_non_math_prompt_text");
    }
  }

  if (terminalErrorCode === "agent_loop_budget_exhausted" || terminalErrorCode === "agent_tool_call_budget_exhausted") {
    failures.push(`budget_exhaustion:${terminalErrorCode}`);
  }
  if (input.scenario.expectedTerminalErrorCode !== undefined) {
    if (!matchesExpected(terminalErrorCode, input.scenario.expectedTerminalErrorCode)) {
      failures.push(`terminal_error_code_mismatch:${terminalErrorCode ?? "null"}`);
    }
  } else if (terminalErrorCode) {
    failures.push(`unexpected_terminal_error_code:${terminalErrorCode}`);
  }
  if (
    input.scenario.expectedFinalAnswerSource !== undefined &&
    !matchesExpected(finalAnswerSource, input.scenario.expectedFinalAnswerSource)
  ) {
    failures.push(`final_answer_source_mismatch:${finalAnswerSource ?? "null"}`);
  }
  if (input.scenario.expectedTerminalKind !== undefined) {
    if (!matchesExpected(terminalAuthorityKind, input.scenario.expectedTerminalKind)) {
      failures.push(`terminal_authority_kind_mismatch:${terminalAuthorityKind ?? "null"}`);
    }
    if (!matchesExpected(visibleTerminalKind, input.scenario.expectedTerminalKind)) {
      failures.push(`visible_terminal_kind_mismatch:${visibleTerminalKind ?? "null"}`);
    }
  }
  if (input.scenario.expectedTerminalErrorCode === undefined) {
    if (!terminalAuthorityKind) failures.push("terminal_authority_kind_missing");
    if (!visibleTerminalKind) failures.push("visible_terminal_kind_missing");
    if (!backendVisibleTerminalKind) failures.push("backend_visible_terminal_kind_missing");
  }
  if (terminalAuthorityKind && visibleTerminalKind && terminalAuthorityKind !== visibleTerminalKind) {
    failures.push(`terminal_projection_mismatch:${terminalAuthorityKind}!=${visibleTerminalKind}`);
  }
  if (terminalAuthorityKind && backendVisibleTerminalKind && terminalAuthorityKind !== backendVisibleTerminalKind) {
    failures.push(`backend_terminal_projection_mismatch:${terminalAuthorityKind}!=${backendVisibleTerminalKind}`);
  }
  if (input.scenario.expectedTerminalErrorCode === undefined) {
    if (terminalAuthorityKind && RECEIPT_TERMINAL_KINDS.has(terminalAuthorityKind)) {
      failures.push(`receipt_terminal_forbidden:${terminalAuthorityKind}`);
    }
    if (finalAnswerSource && RECEIPT_TERMINAL_KINDS.has(finalAnswerSource)) {
      failures.push(`receipt_final_answer_source_forbidden:${finalAnswerSource}`);
    }
  }
  if (terminalErrorCode === "compound_subgoal_support_refs_missing") {
    const coverage = readRecord(payload?.compound_subgoal_draft_support_coverage);
    const missingRefs = readStringArray(coverage?.missing_observation_refs);
    failures.push(`compound_draft_missing_subgoal_support_refs:${missingRefs.join(",") || "unknown"}`);
  }

  return {
    id: input.scenario.id,
    prompt: input.scenario.prompt,
    ok: failures.length === 0,
    failures,
    turn_id: turnId,
    terminal_error_code: terminalErrorCode,
    terminal_authority_kind: terminalAuthorityKind,
    visible_terminal_kind: visibleTerminalKind,
    backend_visible_terminal_kind: backendVisibleTerminalKind,
    final_answer_source: finalAnswerSource,
    requested_capabilities: requestedCapabilities,
    runtime_capabilities: runtimeCapabilities,
    selected_capabilities: selectedCapabilities,
    executed_capabilities: executedCapabilities,
    observation_kinds: observationKinds,
    observation_refs: observationRefs,
    observation_provenance: observationProvenance,
    subgoal_required_observation_kinds: subgoalRequiredObservationKinds,
    subgoal_required_terminal_kinds: subgoalRequiredTerminalKinds,
    subgoal_terminal_contribution_kinds: subgoalTerminalContributionKinds,
    subgoal_contribution_roles: subgoalContributionRoles,
    subgoal_allowed_substitutions: subgoalAllowedSubstitutions,
    subgoal_forbidden_nearby_capabilities: subgoalForbiddenNearbyCapabilities,
    subgoal_input_bindings: subgoalInputBindings,
    subgoal_bound_input_refs: subgoalBoundInputRefs,
    rail_requested_capabilities: railRequestedCapabilities,
    rail_runtime_capabilities: railRuntimeCapabilities,
    rail_selected_capabilities: railSelectedCapabilities,
    rail_executed_capabilities: railExecutedCapabilities,
    rail_observation_kinds: railObservationKinds,
    rail_observation_refs: railObservationRefs,
    rail_observation_provenance: railObservationProvenance,
    rail_required_observation_kinds: railRequiredObservationKinds,
    rail_required_terminal_kinds: railRequiredTerminalKinds,
    rail_terminal_contribution_kinds: railTerminalContributionKinds,
    rail_contribution_roles: railContributionRoles,
    rail_allowed_substitutions: railAllowedSubstitutions,
    rail_forbidden_nearby_capabilities: railForbiddenNearbyCapabilities,
    subgoal_satisfactions: subgoalSatisfactions,
    subgoal_rail_statuses: subgoalRailStatuses,
    subgoal_first_broken_rails: subgoalFirstBrokenRails,
    subgoal_rail_failure_codes: subgoalRailFailureCodes,
    subgoal_repair_targets: subgoalRepairTargets,
    missing_compound_subgoal_ids: missingCompoundSubgoalIds,
    missing_required_capabilities: missingRequiredCapabilities,
    next_missing_subgoal_id: nextMissingSubgoalId,
    first_missing_subgoal_id: firstMissingSubgoalId,
    first_missing_subgoal_first_broken_rail: firstMissingSubgoalFirstBrokenRail,
    first_missing_subgoal_rail_failure_code: firstMissingSubgoalRailFailureCode,
    first_missing_subgoal_repair_target: firstMissingSubgoalRepairTarget,
    top_level_compound_subgoal_count: topLevelCompoundSubgoalCount,
    top_level_first_incomplete_compound_subgoal_id: topLevelFirstIncompleteCompoundSubgoalId,
    top_level_first_incomplete_compound_requested_capability: topLevelFirstIncompleteCompoundRequestedCapability,
    top_level_first_incomplete_compound_runtime_capability: topLevelFirstIncompleteCompoundRuntimeCapability,
    top_level_first_incomplete_compound_selected_capability: topLevelFirstIncompleteCompoundSelectedCapability,
    top_level_first_incomplete_compound_executed_capability: topLevelFirstIncompleteCompoundExecutedCapability,
    top_level_compound_first_broken_rail: topLevelCompoundFirstBrokenRail,
    top_level_compound_rail_failure_code: topLevelCompoundRailFailureCode,
    top_level_compound_repair_target: topLevelCompoundRepairTarget,
    top_level_compound_incomplete_subgoal_did_tool_run: topLevelCompoundIncompleteSubgoalDidToolRun,
    compound_complete: compoundComplete,
  };
};

const seedScenario = async (scenario: CompoundCapabilityScenario, threadId: string, scenarioDir: string): Promise<void> => {
  if (scenario.seed !== "visual_capture") return;
  const seed = await fetchJson<RecordLike>(`${BASE_URL}/api/agi/situation/test-harness/live-visual-source`, {
    method: "POST",
    body: JSON.stringify({
      thread_id: threadId,
      source_id: `visual_source:${scenario.id}`,
      scene_text: "A backend-seeded visual capture shows the Helix Ask desktop with the scientific calculator panel open.",
      activity: "Inspecting a calculator panel and debug workspace.",
      objects: "desktop, Helix Ask UI, scientific calculator panel, debug viewer",
      confidence: 0.82,
    }),
  });
  await fs.writeFile(path.join(scenarioDir, "seed.json"), `${JSON.stringify(seed, null, 2)}\n`);
};

const runScenario = async (scenario: CompoundCapabilityScenario, runId: string, outputDir: string): Promise<CompoundCapabilityScenarioSummary> => {
  const threadId = `helix-ask:compound-live:${runId}:${scenario.id}`;
  const scenarioDir = path.join(outputDir, scenario.id);
  await fs.mkdir(scenarioDir, { recursive: true });
  await seedScenario(scenario, threadId, scenarioDir);

  const ask = await fetchJson<RecordLike>(`${BASE_URL}/api/agi/ask/turn`, {
    method: "POST",
    body: JSON.stringify({
      sessionId: threadId,
      question: scenario.prompt,
      mode: "read",
      debug: true,
      agentRuntime: "codex",
      agent_runtime: "codex",
    }),
  });
  const turnId = readString(ask.turn_id);
  const debug = turnId
    ? await fetchJson<RecordLike>(`${BASE_URL}/api/agi/ask/turn/${encodeURIComponent(turnId)}/debug-export`)
    : null;
  const summary = evaluateCompoundCapabilityScenario({ scenario, ask, debugExport: debug });
  await fs.writeFile(path.join(scenarioDir, "ask-response.json"), `${JSON.stringify(ask, null, 2)}\n`);
  await fs.writeFile(path.join(scenarioDir, "debug-export.json"), `${JSON.stringify(debug, null, 2)}\n`);
  await fs.writeFile(path.join(scenarioDir, "compound-probe-result.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
};

const renderMarkdownSummary = (input: {
  runId: string;
  outputDir: string;
  selectedScenarioIds?: string[];
  results: CompoundCapabilityScenarioSummary[];
}): string => {
  const lines = [
    "# Helix Ask Compound Capability Live Probe",
    "",
    `- run_id: ${input.runId}`,
    `- base_url: ${BASE_URL}`,
    `- output_dir: ${input.outputDir}`,
    `- selected_scenarios: ${JSON.stringify(input.selectedScenarioIds ?? input.results.map((result) => result.id))}`,
    "",
    "## Scenarios",
  ];
  for (const result of input.results) {
    lines.push(
      "",
      `### ${result.ok ? "PASS" : "FAIL"} ${result.id}`,
      "",
      `- turn_id: ${result.turn_id ?? "missing"}`,
      `- terminal_error_code: ${result.terminal_error_code ?? "none"}`,
      `- terminal_authority_kind: ${result.terminal_authority_kind ?? "missing"}`,
      `- visible_terminal_kind: ${result.visible_terminal_kind ?? "missing"}`,
      `- backend_visible_terminal_kind: ${result.backend_visible_terminal_kind ?? "missing"}`,
      `- final_answer_source: ${result.final_answer_source ?? "missing"}`,
      `- requested_capabilities: ${JSON.stringify(result.requested_capabilities)}`,
      `- runtime_capabilities: ${JSON.stringify(result.runtime_capabilities)}`,
      `- selected_capabilities: ${JSON.stringify(result.selected_capabilities)}`,
      `- executed_capabilities: ${JSON.stringify(result.executed_capabilities)}`,
      `- observation_kinds: ${JSON.stringify(result.observation_kinds)}`,
      `- observation_refs: ${JSON.stringify(result.observation_refs)}`,
      `- observation_provenance: ${JSON.stringify(result.observation_provenance)}`,
      `- subgoal_required_observation_kinds: ${JSON.stringify(result.subgoal_required_observation_kinds)}`,
      `- subgoal_required_terminal_kinds: ${JSON.stringify(result.subgoal_required_terminal_kinds)}`,
      `- subgoal_terminal_contribution_kinds: ${JSON.stringify(result.subgoal_terminal_contribution_kinds)}`,
      `- subgoal_contribution_roles: ${JSON.stringify(result.subgoal_contribution_roles)}`,
      `- subgoal_allowed_substitutions: ${JSON.stringify(result.subgoal_allowed_substitutions)}`,
      `- subgoal_forbidden_nearby_capabilities: ${JSON.stringify(result.subgoal_forbidden_nearby_capabilities)}`,
      `- subgoal_input_bindings: ${JSON.stringify(result.subgoal_input_bindings)}`,
      `- subgoal_bound_input_refs: ${JSON.stringify(result.subgoal_bound_input_refs)}`,
      `- rail_requested_capabilities: ${JSON.stringify(result.rail_requested_capabilities)}`,
      `- rail_runtime_capabilities: ${JSON.stringify(result.rail_runtime_capabilities)}`,
      `- rail_selected_capabilities: ${JSON.stringify(result.rail_selected_capabilities)}`,
      `- rail_executed_capabilities: ${JSON.stringify(result.rail_executed_capabilities)}`,
      `- rail_observation_kinds: ${JSON.stringify(result.rail_observation_kinds)}`,
      `- rail_observation_refs: ${JSON.stringify(result.rail_observation_refs)}`,
      `- rail_observation_provenance: ${JSON.stringify(result.rail_observation_provenance)}`,
      `- rail_required_observation_kinds: ${JSON.stringify(result.rail_required_observation_kinds)}`,
      `- rail_required_terminal_kinds: ${JSON.stringify(result.rail_required_terminal_kinds)}`,
      `- rail_terminal_contribution_kinds: ${JSON.stringify(result.rail_terminal_contribution_kinds)}`,
      `- rail_contribution_roles: ${JSON.stringify(result.rail_contribution_roles)}`,
      `- rail_allowed_substitutions: ${JSON.stringify(result.rail_allowed_substitutions)}`,
      `- rail_forbidden_nearby_capabilities: ${JSON.stringify(result.rail_forbidden_nearby_capabilities)}`,
      `- subgoal_satisfactions: ${JSON.stringify(result.subgoal_satisfactions)}`,
      `- subgoal_rail_statuses: ${JSON.stringify(result.subgoal_rail_statuses)}`,
      `- subgoal_first_broken_rails: ${JSON.stringify(result.subgoal_first_broken_rails)}`,
      `- subgoal_rail_failure_codes: ${JSON.stringify(result.subgoal_rail_failure_codes)}`,
      `- subgoal_repair_targets: ${JSON.stringify(result.subgoal_repair_targets)}`,
      `- missing_compound_subgoal_ids: ${JSON.stringify(result.missing_compound_subgoal_ids)}`,
      `- missing_required_capabilities: ${JSON.stringify(result.missing_required_capabilities)}`,
      `- next_missing_subgoal_id: ${result.next_missing_subgoal_id ?? "none"}`,
      `- first_missing_subgoal_id: ${result.first_missing_subgoal_id ?? "none"}`,
      `- first_missing_subgoal_first_broken_rail: ${result.first_missing_subgoal_first_broken_rail ?? "none"}`,
      `- first_missing_subgoal_rail_failure_code: ${result.first_missing_subgoal_rail_failure_code ?? "none"}`,
      `- first_missing_subgoal_repair_target: ${result.first_missing_subgoal_repair_target ?? "none"}`,
      `- compound_complete: ${result.compound_complete === null ? "unknown" : String(result.compound_complete)}`,
      `- failures: ${JSON.stringify(result.failures)}`,
    );
  }
  return `${lines.join("\n")}\n`;
};

export const selectCompoundCapabilityLiveScenarios = (
  requestedIds: string[] = SCENARIO_FILTER,
): CompoundCapabilityScenarioSelection => {
  const normalizedRequestedIds = Array.from(new Set(requestedIds.map((entry) => entry.trim()).filter(Boolean)));
  const availableIds = COMPOUND_CAPABILITY_LIVE_SCENARIOS.map((scenario) => scenario.id);
  if (normalizedRequestedIds.length === 0) {
    return {
      scenarios: COMPOUND_CAPABILITY_LIVE_SCENARIOS,
      requestedIds: [],
      unknownIds: [],
      availableIds,
    };
  }
  const knownIds = new Set(availableIds);
  return {
    scenarios: COMPOUND_CAPABILITY_LIVE_SCENARIOS.filter((scenario) => normalizedRequestedIds.includes(scenario.id)),
    requestedIds: normalizedRequestedIds,
    unknownIds: normalizedRequestedIds.filter((id) => !knownIds.has(id)),
    availableIds,
  };
};

const main = async (): Promise<void> => {
  const runId = `compound-live-${Date.now()}`;
  const outputDir = path.resolve(OUT_DIR, runId);
  await fs.mkdir(outputDir, { recursive: true });
  const selection = selectCompoundCapabilityLiveScenarios();
  const selectedScenarioIds = selection.scenarios.map((scenario) => scenario.id);

  if (selection.unknownIds.length || selection.scenarios.length === 0) {
    const summary = {
      ok: false,
      blocked: true,
      blocked_reason: selection.unknownIds.length ? "unknown_scenario_filter" : "no_scenarios_selected",
      run_id: runId,
      base_url: BASE_URL,
      output_dir: outputDir,
      selected_scenarios: selectedScenarioIds,
      scenario_count: selection.scenarios.length,
      unknown_scenarios: selection.unknownIds,
      available_scenarios: selection.availableIds,
      results: [],
    };
    await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await fs.writeFile(path.join(outputDir, "summary.md"), renderMarkdownSummary({ runId, outputDir, selectedScenarioIds, results: [] }));
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return;
  }

  const liveRunPolicy = resolveCompoundCapabilityLiveRunPolicy({
    dryRun: DRY_RUN,
    scenarioFilter: SCENARIO_FILTER,
    allowAllLiveScenarios: ALLOW_ALL_LIVE_SCENARIOS,
  });

  if (liveRunPolicy.blocked) {
    const summary = {
      ok: false,
      blocked: true,
      blocked_reason: liveRunPolicy.blocked_reason,
      message: liveRunPolicy.message,
      run_id: runId,
      base_url: BASE_URL,
      output_dir: outputDir,
      selected_scenarios: selectedScenarioIds,
      scenario_count: selection.scenarios.length,
      available_scenarios: selection.availableIds,
      results: [],
    };
    await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await fs.writeFile(path.join(outputDir, "summary.md"), renderMarkdownSummary({ runId, outputDir, selectedScenarioIds, results: [] }));
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return;
  }

  if (DRY_RUN) {
    const summary = {
      ok: true,
      dry_run: true,
      run_id: runId,
      base_url: BASE_URL,
      output_dir: outputDir,
      selected_scenarios: selectedScenarioIds,
      scenario_count: selection.scenarios.length,
      scenarios: selection.scenarios,
      results: [],
    };
    await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await fs.writeFile(path.join(outputDir, "summary.md"), renderMarkdownSummary({ runId, outputDir, selectedScenarioIds, results: [] }));
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const preflight = await probeAskTurnApi();
  if (!preflight.ok) {
    const summary = {
      ok: false,
      blocked: true,
      blocked_reason: preflight.reason,
      message: preflight.message,
      run_id: runId,
      base_url: BASE_URL,
      output_dir: outputDir,
      selected_scenarios: selectedScenarioIds,
      scenario_count: selection.scenarios.length,
      results: [],
    };
    await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await fs.writeFile(path.join(outputDir, "summary.md"), renderMarkdownSummary({ runId, outputDir, selectedScenarioIds, results: [] }));
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return;
  }

  const results: CompoundCapabilityScenarioSummary[] = [];
  for (const scenario of selection.scenarios) {
    try {
      results.push(await runScenario(scenario, runId, outputDir));
    } catch (error) {
      results.push({
        id: scenario.id,
        prompt: scenario.prompt,
        ok: false,
        failures: [error instanceof Error ? error.message : String(error)],
        turn_id: null,
        terminal_error_code: null,
        terminal_authority_kind: null,
        visible_terminal_kind: null,
        backend_visible_terminal_kind: null,
        final_answer_source: null,
        requested_capabilities: [],
        runtime_capabilities: [],
        selected_capabilities: [],
        executed_capabilities: [],
        observation_kinds: [],
        observation_refs: [],
        observation_provenance: [],
        subgoal_required_observation_kinds: [],
        subgoal_required_terminal_kinds: [],
        subgoal_terminal_contribution_kinds: [],
        subgoal_contribution_roles: [],
        subgoal_allowed_substitutions: [],
        subgoal_forbidden_nearby_capabilities: [],
        subgoal_input_bindings: [],
        subgoal_bound_input_refs: [],
        rail_requested_capabilities: [],
        rail_runtime_capabilities: [],
        rail_selected_capabilities: [],
        rail_executed_capabilities: [],
        rail_observation_kinds: [],
        rail_observation_refs: [],
        rail_observation_provenance: [],
        rail_required_observation_kinds: [],
        rail_required_terminal_kinds: [],
        rail_terminal_contribution_kinds: [],
        rail_contribution_roles: [],
        rail_allowed_substitutions: [],
        rail_forbidden_nearby_capabilities: [],
        subgoal_satisfactions: [],
        subgoal_rail_statuses: [],
        subgoal_first_broken_rails: [],
        subgoal_rail_failure_codes: [],
        subgoal_repair_targets: [],
        missing_compound_subgoal_ids: [],
        missing_required_capabilities: [],
        next_missing_subgoal_id: null,
        first_missing_subgoal_id: null,
        first_missing_subgoal_first_broken_rail: null,
        first_missing_subgoal_rail_failure_code: null,
        first_missing_subgoal_repair_target: null,
        top_level_compound_subgoal_count: null,
        top_level_first_incomplete_compound_subgoal_id: null,
        top_level_first_incomplete_compound_requested_capability: null,
        top_level_first_incomplete_compound_runtime_capability: null,
        top_level_first_incomplete_compound_selected_capability: null,
        top_level_first_incomplete_compound_executed_capability: null,
        top_level_compound_first_broken_rail: null,
        top_level_compound_rail_failure_code: null,
        top_level_compound_repair_target: null,
        top_level_compound_incomplete_subgoal_did_tool_run: null,
        compound_complete: null,
      });
    }
  }

  const summary = {
    ok: results.every((result) => result.ok),
    run_id: runId,
    base_url: BASE_URL,
    output_dir: outputDir,
    selected_scenarios: selectedScenarioIds,
    scenario_count: selection.scenarios.length,
    passed_count: results.filter((result) => result.ok).length,
    failed_count: results.filter((result) => !result.ok).length,
    results,
  };
  await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(path.join(outputDir, "summary.md"), renderMarkdownSummary({ runId, outputDir, selectedScenarioIds, results }));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
