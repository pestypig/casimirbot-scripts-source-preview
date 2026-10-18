import fs from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();
const crosswalkPath =
  "docs/work-packets/eh-hci-0a-repository-harness-capability-crosswalk-v1.md";
const consumingPlanPath =
  "docs/work-packets/eh-mhud-0-motorcycle-helmet-hud-build-plan-v1.md";

const failures: string[] = [];

const readWorkspaceFile = (relativePath: string): string => {
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`missing_file:${relativePath}`);
    return "";
  }
  return fs.readFileSync(absolutePath, "utf8").replace(/\r\n/g, "\n");
};

const crosswalk = readWorkspaceFile(crosswalkPath);
const consumingPlan = readWorkspaceFile(consumingPlanPath);

const requiredSections = [
  "## Decision",
  "## Disposition vocabulary",
  "## Authority classes used by the crosswalk",
  "## Crosswalk A — identity, installation and collaboration",
  "## Crosswalk B — sources, capture and visual surfaces",
  "## Crosswalk C — orchestration, reasoning and control",
  "## Crosswalk D — resources, artifacts and domain adapters",
  "## Reconciliation of proposed top-level concepts",
  "## Missing capabilities that remain genuinely new",
  "## Ordered implementation consequences",
  "## Stop/fail criteria",
  "## Deterministic verification plan",
] as const;

for (const section of requiredSections) {
  if (!crosswalk.includes(section)) {
    failures.push(`required_section_missing:${section}`);
  }
}

const requiredDispositionTerms = [
  "`reuse`",
  "`extend`",
  "`bridge`",
  "`compose`",
  "`specialize`",
  "`reserve_new`",
  "`retire_after_migration`",
] as const;

for (const term of requiredDispositionTerms) {
  if (!crosswalk.includes(`| ${term} |`)) {
    failures.push(`disposition_definition_missing:${term}`);
  }
}

const reconciliationGuards = [
  "Do not implement it as a second room, run store or model session.",
  "Reserve one new session/alignment manifest",
  "Do not create a second general graph runner.",
  "Reserve a cross-modal budget manifest, not a scheduler.",
  "does not become a second live-device registry",
  "They do not copy\nregistry state into panel-local stores",
] as const;

for (const guard of reconciliationGuards) {
  if (!crosswalk.includes(guard)) {
    failures.push(`reconciliation_guard_missing:${guard.replace(/\s+/g, "_")}`);
  }
}

const referencedPaths = [
  ...crosswalk.matchAll(/`((?:docs|shared|server|client)\/[^`]+)`/g),
].map((match) => match[1]);
const uniqueReferencedPaths = [...new Set(referencedPaths)].sort();

for (const referencedPath of uniqueReferencedPaths) {
  if (!fs.existsSync(path.resolve(workspaceRoot, referencedPath))) {
    failures.push(`referenced_path_missing:${referencedPath}`);
  }
}

if (!consumingPlan.includes(crosswalkPath)) {
  failures.push(`consuming_plan_backlink_missing:${consumingPlanPath}`);
}

const expectedConceptHeadings = [
  "### `ConnectedReasoningSession`",
  "### `MultimodalCaptureSession`",
  "### `CapabilityRecipe`",
  "### `InformationFlowBudget`",
  "### `HardwareEnvironmentProfile`",
  "### Surface Workspace and Capture Session Composer",
] as const;

for (const heading of expectedConceptHeadings) {
  const count = crosswalk.split(heading).length - 1;
  if (count !== 1) {
    failures.push(`concept_reconciliation_count:${heading}:${count}:expected_1`);
  }
}

const crosswalkSections = ["A", "B", "C", "D"] as const;
const crosswalkRowCounts: Record<(typeof crosswalkSections)[number], number> = {
  A: 0,
  B: 0,
  C: 0,
  D: 0,
};

for (const sectionId of crosswalkSections) {
  const sectionMatch = crosswalk.match(
    new RegExp(`## Crosswalk ${sectionId}[^\\n]*\\n([\\s\\S]*?)(?=\\n## )`),
  );
  if (!sectionMatch) {
    failures.push(`crosswalk_table_missing:${sectionId}`);
    continue;
  }
  const rows = sectionMatch[1]
    .split(/\r?\n/)
    .filter((line) => line.startsWith("| "))
    .slice(2);
  crosswalkRowCounts[sectionId] = rows.length;
  if (rows.length < 5) {
    failures.push(`crosswalk_table_underfilled:${sectionId}:${rows.length}`);
  }
  for (const row of rows) {
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 6) {
      failures.push(`crosswalk_row_malformed:${sectionId}:${row}`);
      continue;
    }
    if (!requiredDispositionTerms.some((term) => cells[5].includes(term))) {
      failures.push(`crosswalk_row_disposition_missing:${sectionId}:${cells[0]}`);
    }
  }
}

const headerMaturity = crosswalk.match(/^Current maturity: (.+)$/m)?.[1] ?? null;
if (headerMaturity !== "deterministically verified") {
  failures.push(
    `unexpected_crosswalk_maturity:${headerMaturity ?? "missing"}:expected_deterministically_verified`,
  );
}

const result = {
  schema: "casimirbot.harness_capability_crosswalk_audit.v1",
  crosswalk: crosswalkPath,
  consuming_plan: consumingPlanPath,
  referenced_paths_checked: uniqueReferencedPaths.length,
  required_sections_checked: requiredSections.length,
  reconciled_concepts_checked: expectedConceptHeadings.length,
  crosswalk_rows_checked: Object.values(crosswalkRowCounts).reduce(
    (total, count) => total + count,
    0,
  ),
  crosswalk_rows_by_section: crosswalkRowCounts,
  ok: failures.length === 0,
  failures,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
