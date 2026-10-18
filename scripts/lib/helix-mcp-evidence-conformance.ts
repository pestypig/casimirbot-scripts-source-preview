import crypto from "node:crypto";

import {
  HELIX_MCP_EVIDENCE_CONFORMANCE_ROW_SCHEMA,
  helixMcpEvidenceConformanceRowSchema,
  type HelixMcpEvidenceConformanceDimensions,
} from "../../shared/contracts/helix-mcp-evidence-capability.v1";
import { buildHelixMcpEvidenceInventoryAudit } from
  "./helix-mcp-evidence-capability-inventory";
import { buildHelixMcpEvidencePublicUiCrosswalk } from
  "./helix-mcp-evidence-public-ui-crosswalk";

export const HELIX_MCP_EVIDENCE_CONFORMANCE_AUDIT_SCHEMA =
  "helix.mcp_evidence_conformance_audit.v1" as const;
export const HELIX_MCP_EVIDENCE_CONFORMANCE_V1_EVALUATED_AT =
  "2026-08-29T00:00:00.000Z" as const;

const adoptedDimensions = (
  toolName: string,
): HelixMcpEvidenceConformanceDimensions => ({
  catalog_identity: "conforms",
  account_admission: "conforms",
  handler_parity: "conforms",
  effect_boundary: "conforms",
  observation_schema: "conforms",
  observation_identity: "conforms",
  secret_exclusion: "conforms",
  durable_retrieval: "conforms",
  reentry: "conforms",
  followup_ownership: "conforms",
  terminal_grounding: "conforms",
  ui_crosswalk: toolName === "helix_public_ui_catalog" ? "conforms" : "not_applicable",
  deterministic_evidence: "conforms",
  live_convergence: "not_assessed",
});

const gapDimensions = (): HelixMcpEvidenceConformanceDimensions => ({
  catalog_identity: "gap",
  account_admission: "not_assessed",
  handler_parity: "not_assessed",
  effect_boundary: "not_assessed",
  observation_schema: "not_assessed",
  observation_identity: "not_assessed",
  secret_exclusion: "not_assessed",
  durable_retrieval: "not_assessed",
  reentry: "not_assessed",
  followup_ownership: "not_assessed",
  terminal_grounding: "not_assessed",
  ui_crosswalk: "not_assessed",
  deterministic_evidence: "not_assessed",
  live_convergence: "not_assessed",
});

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalize(entry)]));
};

export const buildHelixMcpEvidenceConformanceAudit = (input: {
  workspaceRoot: string;
  evaluatedAt?: string;
}) => {
  const inventory = buildHelixMcpEvidenceInventoryAudit({
    workspaceRoot: input.workspaceRoot,
  });
  const crosswalk = buildHelixMcpEvidencePublicUiCrosswalk();
  const evaluatedAt = input.evaluatedAt ??
    HELIX_MCP_EVIDENCE_CONFORMANCE_V1_EVALUATED_AT;
  const adoptedEvidenceRefs = [
    "shared/contracts/helix-mcp-evidence-capability.v1.ts",
    "shared/helix-mcp-evidence-capability-registry.ts",
    "server/services/mcp-evidence/observation.ts",
    "server/services/mcp-evidence/observation-store.ts",
    "server/services/mcp-evidence/reentry-lifecycle.ts",
    "tests/helix-mcp-evidence-capability-inventory.spec.ts",
  ];
  const rows = inventory.tools.map((tool) => helixMcpEvidenceConformanceRowSchema.parse({
    schema: HELIX_MCP_EVIDENCE_CONFORMANCE_ROW_SCHEMA,
    capability_id: tool.capability_id ?? `unadopted:${tool.mcp_tool_name}`,
    mcp_tool_name: tool.mcp_tool_name,
    dimensions: tool.descriptor_state === "joined"
      ? adoptedDimensions(tool.mcp_tool_name)
      : gapDimensions(),
    evidence_refs: tool.descriptor_state === "joined" ? adoptedEvidenceRefs : [],
    gap_reason_codes: tool.gap_reason_codes,
    evaluated_at: evaluatedAt,
  }));
  const body = {
    schema: HELIX_MCP_EVIDENCE_CONFORMANCE_AUDIT_SCHEMA,
    evaluated_at: evaluatedAt,
    inventory: {
      registration_count: inventory.registration_count,
      unique_tool_count: inventory.unique_tool_count,
      joined_tool_count: inventory.joined_tool_count,
      gap_tool_count: inventory.gap_tool_count,
    },
    public_ui: {
      surface_count: crosswalk.surface_count,
      control_count: crosswalk.control_count,
      semantic_group_count: crosswalk.semantic_group_count,
      controls_with_explicit_capability_count:
        crosswalk.controls_with_explicit_capability_count,
      per_button_tool_generation: crosswalk.per_button_tool_generation,
      direct_dom_authority: crosswalk.direct_dom_authority,
    },
    rows,
    live_test_boundary_reached: true,
    live_convergence_claimed: false,
    deterministic_framework_ok: inventory.ok && crosswalk.ok,
    failures: [...inventory.failures, ...crosswalk.failures].sort(),
  };
  const reportSha256 = `sha256:${crypto.createHash("sha256")
    .update(JSON.stringify(canonicalize(body))).digest("hex")}`;
  return { ...body, report_sha256: reportSha256 };
};
