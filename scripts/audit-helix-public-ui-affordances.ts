import path from "node:path";

import { buildHelixPublicUiControlInventory } from "./lib/helix-public-ui-control-inventory";

const repoRoot = path.resolve(process.cwd());
const inventory = buildHelixPublicUiControlInventory(repoRoot);
const duplicateIds = [...new Set(
  inventory
    .map((entry) => entry.control_id)
    .filter((controlId, index, all) => all.indexOf(controlId) !== index),
)];
const canonicalControlIds = inventory
  .filter((entry) => entry.locator_kind === "helix_control_id")
  .map((entry) => entry.locator);
const duplicateCanonicalControlIds = [...new Set(
  canonicalControlIds.filter((controlId, index, all) => all.indexOf(controlId) !== index),
)];
const missingCanonicalControlIds = inventory
  .filter((entry) => entry.locator_kind !== "helix_control_id")
  .map((entry) => entry.control_id);
const missingExplicitInteractionClassifications = inventory
  .filter((entry) => entry.interaction_classification_source !== "explicit")
  .map((entry) => entry.control_id);
const missingExplicitAuthorityClassifications = inventory
  .filter((entry) => entry.authority_classification_source === "surface_default")
  .map((entry) => entry.control_id);

const counts = inventory.reduce<Record<string, number>>((result, entry) => {
  result[entry.surface_id] = (result[entry.surface_id] ?? 0) + 1;
  return result;
}, {});
const interactionCounts = inventory.reduce<Record<string, number>>((result, entry) => {
  result[entry.interaction_kind] = (result[entry.interaction_kind] ?? 0) + 1;
  return result;
}, {});
const authorityCounts = inventory.reduce<Record<string, number>>((result, entry) => {
  result[entry.authority_state] = (result[entry.authority_state] ?? 0) + 1;
  return result;
}, {});

const result = {
  schema: "helix.public_ui_affordance_audit.v1",
  verdict:
    duplicateIds.length === 0 &&
    duplicateCanonicalControlIds.length === 0 &&
    missingCanonicalControlIds.length === 0 &&
    missingExplicitInteractionClassifications.length === 0 &&
    missingExplicitAuthorityClassifications.length === 0
      ? "PASS"
      : "FAIL",
  control_count: inventory.length,
  canonical_control_id_count: canonicalControlIds.length,
  missing_canonical_control_id_count: missingCanonicalControlIds.length,
  explicit_interaction_classification_count:
    inventory.length - missingExplicitInteractionClassifications.length,
  explicit_authority_classification_count:
    inventory.length - missingExplicitAuthorityClassifications.length,
  explicit_semantic_id_count: inventory.filter((entry) => !entry.needs_explicit_semantic_id).length,
  classified_authority_count: inventory.filter((entry) => entry.authority_state !== "unmapped").length,
  mapped_authority_count: inventory.filter((entry) =>
    entry.authority_state === "shared_gateway" || entry.authority_state === "route_owned"
  ).length,
  capability_bound_control_count: inventory.filter((entry) =>
    entry.authority_state === "shared_gateway" || entry.authority_state === "route_owned"
  ).length,
  duplicate_control_ids: duplicateIds,
  duplicate_canonical_control_ids: duplicateCanonicalControlIds,
  missing_canonical_control_ids: missingCanonicalControlIds,
  missing_explicit_interaction_classifications: missingExplicitInteractionClassifications,
  missing_explicit_authority_classifications: missingExplicitAuthorityClassifications,
  surface_counts: counts,
  interaction_counts: interactionCounts,
  authority_counts: authorityCounts,
  inventory,
};

const summaryOnly = process.argv.includes("--summary");
process.stdout.write(`${JSON.stringify(summaryOnly ? {
  schema: result.schema,
  verdict: result.verdict,
  control_count: result.control_count,
  canonical_control_id_count: result.canonical_control_id_count,
  missing_canonical_control_id_count: result.missing_canonical_control_id_count,
  explicit_interaction_classification_count: result.explicit_interaction_classification_count,
  explicit_authority_classification_count: result.explicit_authority_classification_count,
  explicit_semantic_id_count: result.explicit_semantic_id_count,
  classified_authority_count: result.classified_authority_count,
  mapped_authority_count: result.mapped_authority_count,
  capability_bound_control_count: result.capability_bound_control_count,
  duplicate_control_ids: result.duplicate_control_ids,
  duplicate_canonical_control_ids: result.duplicate_canonical_control_ids,
  surface_counts: result.surface_counts,
  interaction_counts: result.interaction_counts,
  authority_counts: result.authority_counts,
} : result, null, 2)}\n`);
if (result.verdict !== "PASS") process.exitCode = 1;
