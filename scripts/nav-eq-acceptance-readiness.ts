import { readFileSync } from "node:fs";

type JsonRecord = Record<string, unknown>;

const REQUIRED_REQUIREMENT_IDS = [
  "matched_runtime_observation_qualified",
  "authenticated_direct_tool_callable",
  "frozen_pre_admission_protocol",
  "rolling_course_three_successors",
  "changed_affordance_replan",
  "direct_user_cancel_and_manual_takeover",
  "transport_reconnect_and_checkpoint_reconcile",
  "explicit_revoke_and_zero_effect_stale_rejection",
  "required_measurements_complete",
  "artifact_and_lineage_manifest_complete",
  "stop_fail_criteria_clear",
] as const;

type RequirementId = (typeof REQUIRED_REQUIREMENT_IDS)[number];

export type NavEqAcceptanceReadiness = {
  schema: "helix.nav_eq_acceptance_readiness.v1";
  ready_for_live_acceptance: boolean;
  required_requirement_count: number;
  passed_requirement_count: number;
  open_requirement_ids: string[];
  failed_requirement_ids: string[];
  violations: string[];
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRequirements = (value: unknown): JsonRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const evidenceRefs = (requirement: JsonRecord): string[] =>
  Array.isArray(requirement.evidence_refs)
    ? requirement.evidence_refs.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : [];

const findRequirement = (
  requirements: JsonRecord[],
  requirementId: RequirementId,
): JsonRecord | undefined =>
  requirements.find((requirement) => requirement.requirement_id === requirementId);

export const inspectNavEqAcceptanceReadiness = (
  matrix: unknown,
): NavEqAcceptanceReadiness => {
  const violations: string[] = [];
  if (!isRecord(matrix)) {
    return {
      schema: "helix.nav_eq_acceptance_readiness.v1",
      ready_for_live_acceptance: false,
      required_requirement_count: REQUIRED_REQUIREMENT_IDS.length,
      passed_requirement_count: 0,
      open_requirement_ids: [...REQUIRED_REQUIREMENT_IDS],
      failed_requirement_ids: [],
      violations: ["matrix_must_be_an_object"],
    };
  }

  if (matrix.schema !== "helix.nav_eq_acceptance_matrix.v1") {
    violations.push("unsupported_matrix_schema");
  }

  const requirements = asRequirements(matrix.requirements);
  const requirementIds = requirements
    .map((requirement) => requirement.requirement_id)
    .filter((value): value is string => typeof value === "string");
  const duplicateIds = requirementIds.filter(
    (value, index) => requirementIds.indexOf(value) !== index,
  );
  for (const duplicateId of new Set(duplicateIds)) {
    violations.push(`duplicate_requirement:${duplicateId}`);
  }

  const unexpectedIds = requirementIds.filter(
    (value) => !REQUIRED_REQUIREMENT_IDS.includes(value as RequirementId),
  );
  for (const unexpectedId of unexpectedIds) {
    violations.push(`unexpected_requirement:${unexpectedId}`);
  }

  const missingIds = REQUIRED_REQUIREMENT_IDS.filter(
    (requiredId) => !requirementIds.includes(requiredId),
  );
  for (const missingId of missingIds) {
    violations.push(`missing_requirement:${missingId}`);
  }

  const allowedStatuses = new Set(["not_started", "blocked", "partial", "passed", "failed"]);
  for (const requirement of requirements) {
    const id = typeof requirement.requirement_id === "string"
      ? requirement.requirement_id
      : "unknown";
    if (!allowedStatuses.has(requirement.status as string)) {
      violations.push(`invalid_requirement_status:${id}`);
    }
    if (requirement.status === "passed" && evidenceRefs(requirement).length === 0) {
      violations.push(`passed_requirement_missing_evidence:${id}`);
    }
  }

  const directTool = findRequirement(requirements, "authenticated_direct_tool_callable");
  if (directTool?.status === "passed") {
    const data = isRecord(directTool.acceptance_data) ? directTool.acceptance_data : {};
    if (data.authenticated_callable !== true || typeof data.authenticated_namespace !== "string") {
      violations.push("direct_tool_pass_requires_authenticated_callable_namespace");
    }
  }

  const frozenProtocol = findRequirement(requirements, "frozen_pre_admission_protocol");
  if (frozenProtocol?.status === "passed") {
    const data = isRecord(frozenProtocol.acceptance_data) ? frozenProtocol.acceptance_data : {};
    if (data.ready_to_freeze !== true || data.motion_authorized !== false) {
      violations.push("protocol_pass_requires_fail_closed_freeze_readiness");
    }
  }

  const rollingCourse = findRequirement(requirements, "rolling_course_three_successors");
  if (rollingCourse?.status === "passed") {
    const data = isRecord(rollingCourse.acceptance_data) ? rollingCourse.acceptance_data : {};
    if (
      data.external_mcp_route !== true ||
      typeof data.rolling_successor_count !== "number" ||
      data.rolling_successor_count < 3
    ) {
      violations.push("rolling_course_pass_requires_external_mcp_and_three_successors");
    }
  }

  const passedIds = REQUIRED_REQUIREMENT_IDS.filter(
    (requirementId) => findRequirement(requirements, requirementId)?.status === "passed",
  );
  const failedIds = REQUIRED_REQUIREMENT_IDS.filter(
    (requirementId) => findRequirement(requirements, requirementId)?.status === "failed",
  );
  const openIds = REQUIRED_REQUIREMENT_IDS.filter(
    (requirementId) => findRequirement(requirements, requirementId)?.status !== "passed",
  );
  const allPassed = passedIds.length === REQUIRED_REQUIREMENT_IDS.length;

  if (allPassed) {
    if (matrix.status !== "live_accepted") violations.push("all_passed_matrix_must_declare_live_accepted");
    if (matrix.declared_maturity !== "live accepted") {
      violations.push("all_passed_matrix_must_use_live_accepted_maturity");
    }
  } else {
    if (matrix.status === "live_accepted") violations.push("open_matrix_must_not_declare_live_accepted");
    if (matrix.declared_maturity === "live accepted") {
      violations.push("open_matrix_must_not_claim_live_accepted_maturity");
    }
  }

  return {
    schema: "helix.nav_eq_acceptance_readiness.v1",
    ready_for_live_acceptance: allPassed && violations.length === 0,
    required_requirement_count: REQUIRED_REQUIREMENT_IDS.length,
    passed_requirement_count: passedIds.length,
    open_requirement_ids: openIds,
    failed_requirement_ids: failedIds,
    violations,
  };
};

if (process.argv[1]?.endsWith("nav-eq-acceptance-readiness.ts")) {
  const matrixPath = process.argv[2];
  if (!matrixPath) throw new Error("Expected a NAV-EQ acceptance matrix JSON path");
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
  process.stdout.write(`${JSON.stringify(inspectNavEqAcceptanceReadiness(matrix), null, 2)}\n`);
}
