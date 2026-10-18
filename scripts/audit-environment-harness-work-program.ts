import fs from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();
const workProgramPath = "docs/helix-environment-harness-work-program-v1.md";

const requiredBacklinks = [
  "README.md",
  "AGENTS.md",
  "docs/architecture/casimirbot-environment-harness-product-goal-v1.md",
  "docs/architecture/helix-environment-agent-reasoning-v1.md",
  "docs/architecture/helix-minecraft-dual-plane-adapter-v1.md",
  "docs/architecture/helix-minecraft-companion-embodiment-v1.md",
] as const;

const canonicalLinkedTargets = [
  "docs/architecture/casimirbot-environment-harness-product-goal-v1.md",
  "docs/architecture/helix-environment-agent-reasoning-v1.md",
  "docs/architecture/helix-minecraft-dual-plane-adapter-v1.md",
  "docs/architecture/helix-minecraft-companion-embodiment-v1.md",
  "docs/helix-ask-readiness-debug-loop.md",
  "docs/helix-ask-codex-loop-discipline.md",
  "AGENTS.md",
] as const;

const allowedMaturityTerms = new Set([
  "projected",
  "specified",
  "implemented",
  "deterministically verified",
  "live accepted",
  "integrated accepted",
  "release-ready",
]);

const acceptanceMaturityTerms = new Set([
  "live accepted",
  "integrated accepted",
  "release-ready",
]);

const failures: string[] = [];

const readWorkspaceFile = (relativePath: string): string => {
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`missing_file:${relativePath}`);
    return "";
  }
  return fs.readFileSync(absolutePath, "utf8");
};

const workProgram = readWorkspaceFile(workProgramPath);

for (const requiredTerm of [
  "Resident closed-loop capability",
  "`none`",
  "`monitor_only`",
  "`bounded_reflex`",
  "`continuous_control`",
  "EH-RCC1",
  "resident.minecraft.companion-follow.v1",
  "`player_proxy`",
  "`companion_entity`",
  "actor_entity_id",
  "actor_incarnation_id",
  "observation_origin",
  "EH-FW-CLOUD",
  "semantic escalation",
]) {
  if (workProgram && !workProgram.includes(requiredTerm)) {
    failures.push(`resident_control_program_term_missing:${requiredTerm}`);
  }
}

for (const backlinkPath of requiredBacklinks) {
  const content = readWorkspaceFile(backlinkPath);
  if (content && !content.includes(workProgramPath)) {
    failures.push(`canonical_backlink_missing:${backlinkPath}`);
  }
}

for (const targetPath of canonicalLinkedTargets) {
  readWorkspaceFile(targetPath);
  if (workProgram && !workProgram.includes(targetPath)) {
    failures.push(`canonical_target_link_missing:${targetPath}`);
  }
}

const activeMarkerMatches = [
  ...workProgram.matchAll(/^Active program gate: \*\*(G\d+)\*\*$/gm),
];
if (activeMarkerMatches.length !== 1) {
  failures.push(
    `active_gate_marker_count:${activeMarkerMatches.length}:expected_1`,
  );
}

const activeTableMatches = [
  ...workProgram.matchAll(/^\| (G\d+) — [^|]+ \| active \|/gm),
];
if (activeTableMatches.length !== 1) {
  failures.push(
    `active_gate_table_count:${activeTableMatches.length}:expected_1`,
  );
}

const activeMarker = activeMarkerMatches[0]?.[1] ?? null;
const activeTableGate = activeTableMatches[0]?.[1] ?? null;
if (activeMarker && activeTableGate && activeMarker !== activeTableGate) {
  failures.push(
    `active_gate_mismatch:marker_${activeMarker}:table_${activeTableGate}`,
  );
}

for (let index = 0; index <= 7; index += 1) {
  if (!new RegExp(`^\\| G${index} — `, "m").test(workProgram)) {
    failures.push(`program_gate_missing:G${index}`);
  }
}

const statusSectionMatch = workProgram.match(
  /## Canonical capability status\s+([\s\S]*?)(?=\n## )/,
);
if (!statusSectionMatch) {
  failures.push("canonical_capability_status_section_missing");
}

type CapabilityStatusRow = {
  capability: string;
  maturity: string;
  evidence: string;
  openRequirement: string;
};

const statusRows: CapabilityStatusRow[] = [];
if (statusSectionMatch) {
  const tableLines = statusSectionMatch[1]
    .split(/\r?\n/)
    .filter((line) => line.startsWith("| "));
  for (const line of tableLines.slice(2)) {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 4) {
      failures.push(`malformed_capability_status_row:${line}`);
      continue;
    }
    statusRows.push({
      capability: cells[0],
      maturity: cells[1].replace(/^`|`$/g, ""),
      evidence: cells[2],
      openRequirement: cells[3],
    });
  }
}

if (statusRows.length === 0) {
  failures.push("canonical_capability_status_rows_missing");
}

for (const row of statusRows) {
  if (!allowedMaturityTerms.has(row.maturity)) {
    failures.push(
      `invalid_maturity:${row.capability}:${row.maturity || "empty"}`,
    );
  }
  const isAcceptedMinecraftGuardian =
    row.capability === "Minecraft deterministic resident guardian baseline" &&
    row.maturity === "live accepted" &&
    activeMarker !== "G3" &&
    row.evidence.includes(
      "docs/audits/helix-environment-harness-g3-closure-audit-2026-08-21.md",
    );
  if (
    /resident closed-loop|resident guardian|resident policies|flywire|companion-entity embodiment/i.test(
      row.capability,
    ) &&
    !new Set(["specified", "projected"]).has(row.maturity) &&
    !isAcceptedMinecraftGuardian
  ) {
    failures.push(`resident_maturity_premature:${row.capability}:${row.maturity}`);
  }
  if (!acceptanceMaturityTerms.has(row.maturity)) continue;

  const evidenceRefs = [
    ...row.evidence.matchAll(/`((?:artifacts|docs|server|shared)\/[^`]+)`/g),
  ].map((match) => match[1]);
  if (evidenceRefs.length === 0) {
    failures.push(`acceptance_evidence_missing:${row.capability}`);
    continue;
  }
  const repositoryEvidenceRefs = evidenceRefs.filter(
    (evidenceRef) => !evidenceRef.startsWith("artifacts/"),
  );
  if (repositoryEvidenceRefs.length === 0) {
    failures.push(`acceptance_repository_evidence_missing:${row.capability}`);
  }
  for (const evidenceRef of repositoryEvidenceRefs) {
    if (!fs.existsSync(path.resolve(workspaceRoot, evidenceRef))) {
      failures.push(
        `acceptance_evidence_ref_missing:${row.capability}:${evidenceRef}`,
      );
    }
  }
}

const reasoningDocument = readWorkspaceFile(
  "docs/architecture/helix-environment-agent-reasoning-v1.md",
);
if (
  reasoningDocument.includes(
    "1. Complete the unchanged keyed water-bucket rescue with exact current-turn",
  )
) {
  failures.push("stale_status:keyed_water_bucket_rescue_still_first_open_gate");
}

const dualPlaneDocument = readWorkspaceFile(
  "docs/architecture/helix-minecraft-dual-plane-adapter-v1.md",
);
if (!dualPlaneDocument.includes("water-bucket rescue accepted")) {
  failures.push("status_reconciliation_missing:dual_plane_water_bucket_rescue");
}

const result = {
  schema: "casimirbot.environment_harness_work_program_audit.v1",
  work_program: workProgramPath,
  active_gate: activeMarker,
  backlink_files_checked: requiredBacklinks.length,
  canonical_link_targets_checked: canonicalLinkedTargets.length,
  capability_status_rows_checked: statusRows.length,
  allowed_maturity_terms: [...allowedMaturityTerms],
  acceptance_claims_checked: statusRows.filter((row) =>
    acceptanceMaturityTerms.has(row.maturity),
  ).length,
  ok: failures.length === 0,
  failures,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
