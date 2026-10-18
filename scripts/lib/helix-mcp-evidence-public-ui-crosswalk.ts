import {
  HELIX_PUBLIC_UI_SURFACE_CATALOG,
  type HelixPublicUiControlCatalogEntry,
} from "../../shared/helix-public-ui-affordance";
import { HELIX_PUBLIC_UI_CONTROL_CATALOG } from
  "../../shared/helix-public-ui-control-catalog.generated";
import { HELIX_USER_ACCOUNT_POLICY } from "../../shared/helix-account-session";

export const HELIX_MCP_EVIDENCE_PUBLIC_UI_CROSSWALK_SCHEMA =
  "helix.mcp_evidence_public_ui_crosswalk.v1" as const;

export type HelixMcpEvidencePublicUiControlClass =
  | "presentation_not_applicable"
  | "human_only"
  | "blocked_pending_contract"
  | "semantic_capability_candidate";

export const buildHelixMcpEvidencePublicUiCrosswalk = () => {
  const sourceControls = HELIX_PUBLIC_UI_CONTROL_CATALOG as
    readonly HelixPublicUiControlCatalogEntry[];
  const controls = sourceControls.map((control) => {
    let classification: HelixMcpEvidencePublicUiControlClass;
    if (control.authority_state === "blocked_pending_contract") {
      classification = "blocked_pending_contract";
    } else if (control.interaction_kind === "human_only") {
      classification = "human_only";
    } else if (!control.capability_id ||
        control.authority_state === "client_local" ||
        control.authority_state === "not_applicable" ||
        control.interaction_kind === "navigate") {
      classification = "presentation_not_applicable";
    } else {
      classification = "semantic_capability_candidate";
    }
    return {
      control_id: control.control_id,
      surface_id: control.surface_id,
      capability_id: control.capability_id ?? null,
      interaction_kind: control.interaction_kind,
      authority_state: control.authority_state,
      classification,
      mcp_tool_name: null,
      remotely_clickable: false as const,
      grants_authority: false as const,
    };
  });
  const semanticGroups = new Map<string, string[]>();
  for (const control of controls) {
    if (control.classification !== "semantic_capability_candidate" || !control.capability_id) continue;
    const ids = semanticGroups.get(control.capability_id) ?? [];
    ids.push(control.control_id);
    semanticGroups.set(control.capability_id, ids);
  }
  for (const capabilityId of HELIX_USER_ACCOUNT_POLICY.allowed_workstation_capabilities) {
    if (!semanticGroups.has(capabilityId)) semanticGroups.set(capabilityId, []);
  }
  const groups = [...semanticGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([capability_id, control_ids]) => ({
      capability_id,
      control_ids: control_ids.sort(),
      control_count: control_ids.length,
      mcp_adoption_state: "not_assessed" as const,
      direct_dom_authority: false as const,
    }));
  const surfaceIds = new Set(HELIX_PUBLIC_UI_SURFACE_CATALOG.map((surface) => surface.surface_id));
  const seenControlIds = new Set<string>();
  const failures: string[] = [];
  for (const control of controls) {
    if (seenControlIds.has(control.control_id)) {
      failures.push(`public_ui_duplicate_control:${control.control_id}`);
    }
    seenControlIds.add(control.control_id);
    if (!surfaceIds.has(control.surface_id)) {
      failures.push(`public_ui_unknown_surface:${control.control_id}:${control.surface_id}`);
    }
    if (control.classification === "semantic_capability_candidate" && !control.capability_id) {
      failures.push(`public_ui_candidate_without_capability:${control.control_id}`);
    }
  }
  return {
    schema: HELIX_MCP_EVIDENCE_PUBLIC_UI_CROSSWALK_SCHEMA,
    catalog_observation_capability_id: "helix.public_ui.catalog.inspect",
    account_type: "user" as const,
    surface_count: HELIX_PUBLIC_UI_SURFACE_CATALOG.length,
    control_count: controls.length,
    semantic_group_count: groups.length,
    controls_with_explicit_capability_count: controls.filter((control) =>
      control.capability_id !== null).length,
    controls,
    semantic_groups: groups,
    per_button_tool_generation: false as const,
    direct_dom_authority: false as const,
    failures,
    ok: failures.length === 0,
  };
};
