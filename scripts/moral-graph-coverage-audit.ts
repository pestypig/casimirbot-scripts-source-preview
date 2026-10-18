import { auditMoralGraphCoverage } from "../shared/moral-graph/audit-moral-graph-coverage";
import { loadIdeologyGraphFromFile } from "../shared/moral-graph/load-ideology-graph";

function formatCsvValue(value: unknown): string {
  const text = Array.isArray(value) ? value.join(";") : String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function printMarkdown(report: ReturnType<typeof auditMoralGraphCoverage>): void {
  console.log(`# MoralGraph Coverage Audit`);
  console.log("");
  console.log(`- artifact: ${report.artifactId}`);
  console.log(`- schema: ${report.schemaVersion}`);
  console.log(`- root: ${report.rootId}`);
  console.log(`- total: ${report.summary.total}`);
  console.log(`- mapped: ${report.summary.mapped}`);
  console.log(`- partial: ${report.summary.partial}`);
  console.log(`- conceptual_only: ${report.summary.conceptual_only}`);
  console.log(`- unmapped: ${report.summary.unmapped}`);
  console.log("");
  console.log(
    [
      "ideologyNodeId",
      "ideologyNodeLabel",
      "coverageStatus",
      "mappedBadgeIds",
      "mappedPrincipleIds",
      "mappedActionIds",
      "missingProceduralPieces",
      "recommendedPatchType",
    ].join(","),
  );
  for (const node of report.nodes) {
    console.log(
      [
        node.ideologyNodeId,
        node.ideologyNodeLabel,
        node.coverageStatus,
        node.mappedBadgeIds,
        node.mappedPrincipleIds,
        node.mappedActionIds,
        node.missingProceduralPieces,
        node.recommendedPatchType,
      ]
        .map(formatCsvValue)
        .join(","),
    );
  }
}

async function main(): Promise<void> {
  const graph = await loadIdeologyGraphFromFile();
  const report = auditMoralGraphCoverage(graph);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printMarkdown(report);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
