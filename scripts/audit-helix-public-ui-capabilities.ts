import { auditHelixPublicUserUiCapabilities } from "../server/services/helix-ask/public-ui-capability-audit";

const audit = auditHelixPublicUserUiCapabilities();
const summaryOnly = process.argv.includes("--summary");
const authorityCounts = audit.rows.reduce<Record<string, number>>((counts, row) => {
  counts[row.authority_state] = (counts[row.authority_state] ?? 0) + 1;
  return counts;
}, {});
const projectionCounts = audit.rows.reduce<Record<string, number>>((counts, row) => {
  counts[row.projection_surface_id] = (counts[row.projection_surface_id] ?? 0) + 1;
  return counts;
}, {});

process.stdout.write(`${JSON.stringify(summaryOnly ? {
  schema: audit.schema,
  verdict: audit.verdict,
  account_type: audit.account_type,
  capability_count: audit.rows.length,
  authority_counts: authorityCounts,
  projection_counts: projectionCounts,
  orphan_capability_ids: audit.orphan_capability_ids,
  control_binding_failures: audit.control_binding_failures,
} : audit, null, 2)}\n`);

if (audit.verdict !== "PASS") process.exitCode = 1;
