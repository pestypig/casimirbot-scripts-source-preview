import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildNhm2TheoryBadgeGraphV1 } from "../shared/theory/nhm2-theory-badges";
import { buildTheoryRuntimeAdapterGapReport } from "../shared/theory/theory-runtime-adapter-gap";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const JSON_OUT = path.join(REPO_ROOT, "artifacts", "theory-runtime-adapter-gap-report.json");
const DOC_OUT = path.join(REPO_ROOT, "docs", "theory-runtime-adapter-gap-report.md");

function bool(value: boolean): string {
  return value ? "yes" : "no";
}

function markdownForReport(report: ReturnType<typeof buildTheoryRuntimeAdapterGapReport>): string {
  const lines = [
    "# Theory Runtime Adapter Gap Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "This report inventories adapter coverage per Physics Atlas lane. It is metadata-only: it reads registered atlas blocks, runtime entrypoints, adapter declarations, static/reference trace declarations, and theory badges. It does not execute runtime commands.",
    "",
    "## Summary",
    "",
    `- Graph: \`${report.graphId}\``,
    `- Badges in graph: ${report.graphBadgeCount}`,
    `- Lanes: ${report.laneCount}`,
    `- Static/reference trace coverage: ${report.summary.staticReferenceCount}`,
    `- Artifact reader coverage: ${report.summary.artifactReaderCount}`,
    `- Quick runtime coverage: ${report.summary.quickRuntimeCount}`,
    `- Long runtime manifest coverage: ${report.summary.longRuntimeManifestCount}`,
    `- Live runtime coverage: ${report.summary.liveRuntimeCount}`,
    "",
    "## Lane Coverage",
    "",
    "| Lane | Primary | Roots | Boundaries | Calculator examples | Runtime actions | Entrypoints | Adapters | Static | Artifact reader | Quick runtime | Long manifest | Live runtime | Missing | Next patch |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const lane of report.lanes) {
    lines.push(
      `| ${[
        `\`${lane.laneId}\``,
        lane.primaryBadgeIdsCount,
        lane.rootBadgeIdsCount,
        lane.claimBoundaryBadgeIdsCount,
        lane.calculatorExamplesCount,
        lane.runtimeActionsCount,
        lane.registeredEntrypoints.map((id) => `\`${id}\``).join(", ") || "-",
        lane.implementedAdapters.map((id) => `\`${id}\``).join(", ") || "-",
        bool(lane.staticTraceAvailable),
        bool(lane.artifactReaderAvailable),
        bool(lane.quickRuntimeAvailable),
        bool(lane.longRuntimeManifestAvailable),
        bool(lane.liveRuntimeAvailable),
        lane.missingAdapterKinds.map((kind) => `\`${kind}\``).join(", ") || "-",
        lane.recommendedNextPatch,
      ].join(" | ")} |`,
    );
  }

  lines.push(
    "",
    "## Guardrails",
    "",
    "- `static_reference` means a reference/static shell trace exists. It is not backend tensor/runtime execution.",
    "- `artifact_reader` means existing artifacts can be inspected. Missing or stale artifacts still fail closed.",
    "- `quick_runtime` means an allowlisted small runtime adapter exists. This report does not run it.",
    "- `long_job_manifest` means a manifest/status shell exists for a long job. It does not imply a worker ran.",
    "- `live_runtime` is false unless an adapter explicitly declares live runtime coverage.",
    "- Claim-boundary badge IDs are preserved per lane in the JSON artifact.",
    "",
  );

  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const graph = buildNhm2TheoryBadgeGraphV1();
  const report = buildTheoryRuntimeAdapterGapReport({ graph });
  await fs.mkdir(path.dirname(JSON_OUT), { recursive: true });
  await fs.mkdir(path.dirname(DOC_OUT), { recursive: true });
  await fs.writeFile(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(DOC_OUT, markdownForReport(report), "utf8");
  console.log(`Wrote ${path.relative(REPO_ROOT, JSON_OUT)}`);
  console.log(`Wrote ${path.relative(REPO_ROOT, DOC_OUT)}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
