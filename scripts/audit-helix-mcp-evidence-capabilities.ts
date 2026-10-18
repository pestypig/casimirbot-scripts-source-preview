import { buildHelixMcpEvidenceConformanceAudit } from
  "./lib/helix-mcp-evidence-conformance";

const strict = process.argv.includes("--strict");
const summary = process.argv.includes("--summary");
const result = buildHelixMcpEvidenceConformanceAudit({
  workspaceRoot: process.cwd(),
});

console.log(JSON.stringify(summary
  ? {
      schema: result.schema,
      evaluated_at: result.evaluated_at,
      ...result.inventory,
      gap_reason_summary: {
        mcp_evidence_capability_descriptor_missing: result.inventory.gap_tool_count,
      },
      public_ui: result.public_ui,
      live_test_boundary_reached: result.live_test_boundary_reached,
      live_convergence_claimed: result.live_convergence_claimed,
      deterministic_framework_ok: result.deterministic_framework_ok,
      report_sha256: result.report_sha256,
      failures: result.failures,
    }
  : result, null, 2));

if (!result.deterministic_framework_ok ||
    (strict && result.inventory.gap_tool_count > 0)) {
  process.exitCode = 1;
}
