import fs from "node:fs/promises";
import path from "node:path";

import { listWorkstationGatewayCapabilities } from "../server/services/helix-ask/workstation-tool-gateway/registry";

type WorkflowStage = {
  id: string;
  observation_required: boolean;
  capability_groups: string[][];
  natural_markers?: string[];
};

const OUT_ROOT = process.env.HELIX_ASK_OBSERVATION_COVERAGE_OUT ??
  "artifacts/helix-ask-observation-coverage";

const explicitHarnessFiles = [
  "scripts/helix-ask-live-spine-smoke.ts",
  "scripts/helix-ask-tool-chain-matrix-probe.ts",
];

const naturalHarnessFiles = [
  "scripts/fixtures/helix-ask-natural-runtime-baseline.json",
  "scripts/helix-ask-research-workflow-conversation-probe.ts",
];

const canonicalWorkflowStages: WorkflowStage[] = [
  {
    id: "basic_model_reasoning",
    observation_required: false,
    capability_groups: [["model.direct_answer"]],
    natural_markers: ["natural_model_only_reasoning"],
  },
  {
    id: "compound_model_reasoning",
    observation_required: false,
    capability_groups: [["model.direct_answer"]],
    natural_markers: ["natural_compound_model_only_reasoning"],
  },
  {
    id: "named_document_search",
    observation_required: true,
    capability_groups: [["docs.search", "docs-viewer.search_docs"]],
  },
  {
    id: "named_document_read_and_summary",
    observation_required: true,
    capability_groups: [["docs-viewer.open_doc_by_path", "docs-viewer.summarize_doc", "research-library.read_document"]],
  },
  {
    id: "scholarly_paper_lookup",
    observation_required: true,
    capability_groups: [["scholarly-research.lookup_papers"]],
  },
  {
    id: "scholarly_full_text_fetch",
    observation_required: true,
    capability_groups: [["scholarly-research.fetch_full_text"]],
  },
  {
    id: "saved_research_document_read",
    observation_required: true,
    capability_groups: [["research-library.read_document"]],
  },
  {
    id: "pdf_page_visual_inspection",
    observation_required: true,
    capability_groups: [["visual_analysis.inspect_image_region", "image_lens.inspect"]],
  },
  {
    id: "equation_candidate_discovery",
    observation_required: true,
    capability_groups: [
      ["research-library.read_document"],
      ["visual_analysis.inspect_image_region", "image_lens.inspect"],
    ],
  },
  {
    id: "calculator_evaluation",
    observation_required: true,
    capability_groups: [["scientific-calculator.solve_expression", "scientific-calculator.solve_scalar_expression"]],
  },
  {
    id: "theory_graph_reflection",
    observation_required: true,
    capability_groups: [["helix_ask.reflect_theory_context", "theory-badge-graph.current_context"]],
  },
];

const normalizeHarnessSource = (source: string): string =>
  source.replaceAll("\\\\.", ".").replaceAll("\\.", ".");

const readHarnessSources = async (files: string[]): Promise<Record<string, string>> =>
  Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [file, normalizeHarnessSource(await fs.readFile(file, "utf8"))] as const),
    ),
  );

const referencedFiles = (capability: string, sources: Record<string, string>): string[] =>
  Object.entries(sources)
    .filter(([, source]) => source.includes(capability))
    .map(([file]) => file);

const stageCoverage = (
  stage: WorkflowStage,
  explicitSources: Record<string, string>,
  naturalSources: Record<string, string>,
) => {
  const inspect = (sources: Record<string, string>) => stage.capability_groups.map((group) => ({
    alternatives: group,
    referenced_capabilities: group.filter((capability) => referencedFiles(capability, sources).length > 0),
  }));
  const explicitGroups = inspect(explicitSources);
  const naturalGroups = inspect(naturalSources);
  const explicitComplete = explicitGroups.every((group) => group.referenced_capabilities.length > 0);
  const naturalMarkers = stage.natural_markers ?? [];
  const naturalMarkerFiles = naturalMarkers.flatMap((marker) => referencedFiles(marker, naturalSources));
  const naturalComplete = naturalGroups.every((group) => group.referenced_capabilities.length > 0) ||
    (naturalMarkers.length > 0 && naturalMarkerFiles.length > 0);
  return {
    ...stage,
    explicit_harness_groups: explicitGroups,
    natural_harness_groups: naturalGroups,
    natural_marker_files: Array.from(new Set(naturalMarkerFiles)),
    coverage_status: naturalComplete
      ? "natural_harness_declared"
      : explicitComplete
        ? "explicit_only"
        : "uncovered",
    live_verdict_required: true,
  };
};

const renderMarkdown = (report: any): string => {
  const lines = [
    "# Helix Ask Observation Coverage Audit",
    "",
    `- gateway_capability_count: ${report.gateway_capability_count}`,
    `- gateway_capabilities_missing_observation_schema: ${report.gateway_capabilities_missing_observation_schema.length}`,
    `- gateway_capabilities_without_post_tool_reasoning: ${report.gateway_capabilities_without_post_tool_reasoning.length}`,
    "",
    "| Workflow stage | Observation required | Harness status | Live proof |",
    "| --- | --- | --- | --- |",
  ];
  for (const stage of report.canonical_workflow_stages) {
    lines.push(
      `| ${stage.id} | ${stage.observation_required ? "yes" : "no"} | ${stage.coverage_status} | pending keyed verdict |`,
    );
  }
  lines.push("", "## Interpretation", "");
  lines.push(
    "A declared gateway observation schema proves only that an observation can be normalized. " +
      "It does not prove natural prompt selection, admission, execution, observation creation, evidence re-entry, or terminal authority.",
  );
  lines.push(
    "A natural harness declaration is also not a pass. The keyed corpus result must name the first broken lifecycle stage for every failed turn.",
  );
  return `${lines.join("\n")}\n`;
};

async function main(): Promise<void> {
  const explicitSources = await readHarnessSources(explicitHarnessFiles);
  const naturalSources = await readHarnessSources(naturalHarnessFiles);
  const allSources = { ...explicitSources, ...naturalSources };
  const gateway = listWorkstationGatewayCapabilities();
  const capabilities = gateway.capabilities.map((capability) => ({
    capability_id: capability.capability_id,
    observation_schema: capability.observation_schema,
    output_observation_schema: capability.output_observation_schema,
    post_tool_model_step_required: capability.post_tool_model_step_required,
    explicit_harness_files: referencedFiles(capability.capability_id, explicitSources),
    natural_harness_files: referencedFiles(capability.capability_id, naturalSources),
    any_harness_files: referencedFiles(capability.capability_id, allSources),
  }));
  const canonicalStages = canonicalWorkflowStages.map((stage) =>
    stageCoverage(stage, explicitSources, naturalSources),
  );
  const report = {
    schema: "helix.ask.observation_coverage_audit.v1",
    generated_at: new Date().toISOString(),
    gateway_manifest_version: gateway.manifest_version,
    gateway_capability_count: capabilities.length,
    gateway_capabilities_missing_observation_schema: capabilities
      .filter((capability) => !capability.observation_schema || !capability.output_observation_schema)
      .map((capability) => capability.capability_id),
    gateway_capabilities_without_post_tool_reasoning: capabilities
      .filter((capability) => capability.post_tool_model_step_required !== true)
      .map((capability) => capability.capability_id),
    canonical_workflow_stages: canonicalStages,
    canonical_stage_counts: {
      natural_harness_declared: canonicalStages.filter((stage) => stage.coverage_status === "natural_harness_declared").length,
      explicit_only: canonicalStages.filter((stage) => stage.coverage_status === "explicit_only").length,
      uncovered: canonicalStages.filter((stage) => stage.coverage_status === "uncovered").length,
    },
    capabilities,
  };

  const runDir = path.join(OUT_ROOT, `coverage-${Date.now()}`);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "coverage.json"), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(runDir, "coverage.md"), renderMarkdown(report));
  console.log(JSON.stringify({ ...report, capabilities: undefined, output_dir: runDir }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
