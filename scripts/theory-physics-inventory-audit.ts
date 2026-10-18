import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
import { buildNhm2TheoryBadgeGraphV1 } from "../shared/theory/nhm2-theory-badges";
import {
  buildTheoryPhysicsInventoryAuditReport,
  type TheoryPhysicsInventoryAuditReport,
} from "../shared/theory/theory-physics-inventory-audit";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const JSON_OUT = path.join(REPO_ROOT, "artifacts", "theory-physics-inventory-audit.json");
const DOC_OUT = path.join(REPO_ROOT, "docs", "theory-physics-inventory-audit.md");

const SCAN_PATTERNS = [
  "configs/**/*.{json,md}",
  "data/**/*.{json,md,ts}",
  "datasets/**/*.{json,md,ts}",
  "docs/**/*.{json,md}",
  "scripts/**/*.{ts,mjs,js,json}",
  "server/**/*.{ts,json,md}",
  "shared/**/*.{ts,json,md}",
  "tools/**/*.{ts,json,md,py}",
  "client/src/physics/**/*.{ts,json,md}",
  "modules/**/*.{ts,json,md}",
];

function markdownForReport(report: TheoryPhysicsInventoryAuditReport): string {
  const lines = [
    "# Theory Physics Inventory Audit",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "This audit compares repo-owned physics docs, configs, scripts, data, and shared modules against the current Physics Atlas and Theory Badge Graph. It does not execute simulations or runtime commands.",
    "",
    "## Summary",
    "",
    `- Graph: \`${report.graphId}\``,
    `- Badges in graph: ${report.graphBadgeCount}`,
    `- Atlas blocks: ${report.atlasBlockCount}`,
    `- Repo-owned paths scanned: ${report.scannedRepoPathCount}`,
    `- Represented domains: ${report.summary.representedCount}`,
    `- Partially represented domains: ${report.summary.partiallyRepresentedCount}`,
    `- Repo-present graph gaps: ${report.summary.repoPresentGraphGapCount}`,
    `- Not detected: ${report.summary.notDetectedCount}`,
    "",
    "## Domain Coverage",
    "",
    "| Domain | Status | Repo paths | Atlas blocks | Badges | Missing badge prefixes | Next patch |",
    "| --- | --- | ---: | --- | ---: | --- | --- |",
  ];

  for (const domain of report.domains) {
    lines.push(
      `| ${domain.title} | \`${domain.status}\` | ${domain.repoPathCount} | ${
        domain.atlasBlockIds.map((id) => `\`${id}\``).join(", ") || "-"
      } | ${domain.badgeIds.length} | ${
        domain.missingBadgePrefixes.map((prefix) => `\`${prefix}\``).join(", ") || "-"
      } | ${domain.recommendedNextPatch} |`,
    );
  }

  lines.push("", "## Gaps To Patch First", "");
  for (const domain of report.domains.filter((entry) => entry.status !== "represented")) {
    lines.push(
      `### ${domain.title}`,
      "",
      `- Status: \`${domain.status}\``,
      `- Recommended patch: ${domain.recommendedNextPatch}`,
      `- Claim boundary: ${domain.claimBoundaryNote}`,
      `- Sample repo paths: ${domain.sampleRepoPaths.map((filePath) => `\`${filePath}\``).join(", ") || "-"}`,
      "",
    );
  }

  lines.push(
    "## Guardrails",
    "",
    "- A repo path match means prior work exists; it does not mean the graph already represents the equations.",
    "- A badge match means the graph has some coverage; it does not imply runtime receipt coverage.",
    "- Solar restoration, nanoflare/sunquake, tidal-response, and Orch-OR rows must keep explicit claim boundaries.",
    "- This audit is intended to prevent repeated rediscovery and guide small badge-seed patches.",
    "",
  );

  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const filePaths = await fg(SCAN_PATTERNS, {
    cwd: REPO_ROOT,
    dot: false,
    onlyFiles: true,
    unique: true,
    ignore: ["external/**", "node_modules/**", "dist/**", ".git/**"],
  });
  const graph = buildNhm2TheoryBadgeGraphV1();
  const report = buildTheoryPhysicsInventoryAuditReport({ graph, filePaths });

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
