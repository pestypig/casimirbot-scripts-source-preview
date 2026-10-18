import { readFileSync } from "node:fs";

type JsonRecord = Record<string, unknown>;

export type NavEqProtocolReadiness = {
  schema: "helix.nav_eq_protocol_freeze_readiness.v1";
  ready_to_freeze: boolean;
  motion_authorized: false;
  missing_live_fields: string[];
  violations: string[];
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readPath = (root: unknown, path: string): unknown => {
  let value: unknown = root;
  for (const segment of path.split(".")) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value;
};

const isPresent = (value: unknown): boolean => {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return value;
  return true;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isPositiveNumber = (value: unknown): value is number =>
  isFiniteNumber(value) && value > 0;

const parseTimestamp = (value: unknown): number | null => {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isSha256 = (value: unknown): boolean =>
  typeof value === "string" && /^(?:sha256:)?[a-f0-9]{64}$/i.test(value);

export const inspectNavEqProtocolFreezeReadiness = (
  protocol: unknown,
): NavEqProtocolReadiness => {
  const violations: string[] = [];
  if (!isRecord(protocol)) {
    return {
      schema: "helix.nav_eq_protocol_freeze_readiness.v1",
      ready_to_freeze: false,
      motion_authorized: false,
      missing_live_fields: ["protocol"],
      violations: ["protocol_must_be_an_object"],
    };
  }

  if (protocol.schema !== "helix.nav_eq_pre_admission_protocol.v21") {
    violations.push("unsupported_protocol_schema");
  }
  if (
    protocol.status !== "draft_pending_authenticated_direct_tool_and_fresh_geometry" &&
    protocol.status !== "frozen_before_admission"
  ) {
    violations.push("unsupported_protocol_status");
  }
  if (protocol.motion_authorized !== false) {
    violations.push("pre_admission_protocol_must_not_authorize_motion");
  }

  const required = Array.isArray(protocol.required_live_fields_before_freeze)
    ? protocol.required_live_fields_before_freeze.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : [];
  if (required.length === 0) violations.push("required_live_field_manifest_missing");

  const missing = required.filter((path) => !isPresent(readPath(protocol, path)));
  if (readPath(protocol, "direct_tool.unconnected_v2_must_not_be_used") !== true) {
    violations.push("unauthenticated_v2_fail_closed_rule_missing");
  }
  if (readPath(protocol, "course.historical_candidate_only.reusable_without_fresh_probe") !== false) {
    violations.push("historical_course_must_be_non_reusable");
  }
  if (readPath(protocol, "movement_authority.status") !== undefined &&
      readPath(protocol, "movement_authority.status") !== null &&
      readPath(protocol, "movement_authority.status") !== "active") {
    violations.push("movement_authority_must_be_active_before_freeze");
  }

  for (const path of [
    "runtime.desktop_executable_sha256",
    "runtime.desktop_app_asar_sha256",
    "runtime.fabric_jar_sha256",
    "runtime.runtime_manifest_sha256",
    "runtime.runtime_manifest_server_sha256",
  ]) {
    const value = readPath(protocol, path);
    if (isPresent(value) && !isSha256(value)) {
      violations.push(`invalid_sha256:${path}`);
    }
  }
  const geometryFingerprint = readPath(protocol, "course.geometry_semantic_fingerprint");
  if (isPresent(geometryFingerprint) && !isSha256(geometryFingerprint)) {
    violations.push("invalid_sha256:course.geometry_semantic_fingerprint");
  }

  const geometryCurrent = readPath(protocol, "course.geometry_current_for_freeze");
  if (geometryCurrent === true) {
    const geometryAt = parseTimestamp(readPath(protocol, "course.geometry_observed_at"));
    const auditAt = parseTimestamp(readPath(protocol, "clocks.audit_at"));
    const maxAgeMs = readPath(protocol, "measurement_limits.geometry_freeze_max_age_ms");
    if (geometryAt === null) violations.push("geometry_observed_at_invalid");
    if (auditAt === null) violations.push("audit_at_invalid");
    if (isPresent(maxAgeMs) && !isPositiveNumber(maxAgeMs)) {
      violations.push("geometry_freeze_max_age_must_be_positive");
    }
    if (geometryAt !== null && auditAt !== null) {
      const ageMs = auditAt - geometryAt;
      if (ageMs < 0) violations.push("geometry_observation_after_audit");
      if (isPositiveNumber(maxAgeMs) && ageMs > maxAgeMs) {
        violations.push("geometry_stale_at_freeze");
      }
    }
  }

  const authorityStatus = readPath(protocol, "movement_authority.status");
  const authorityExpiresAt = parseTimestamp(readPath(protocol, "movement_authority.expires_at"));
  const auditAt = parseTimestamp(readPath(protocol, "clocks.audit_at"));
  if (authorityStatus === "active" && authorityExpiresAt === null) {
    violations.push("movement_authority_expiry_invalid");
  }
  if (
    authorityStatus === "active" &&
    authorityExpiresAt !== null &&
    auditAt !== null &&
    authorityExpiresAt <= auditAt
  ) {
    violations.push("movement_authority_not_live_at_freeze");
  }

  const rootMaxTicks = readPath(protocol, "measurement_limits.root_max_total_ticks");
  const decisionTick = readPath(protocol, "measurement_limits.decision_tick");
  const stopTick = readPath(protocol, "measurement_limits.stop_tick");
  if (isPresent(rootMaxTicks) && !isPositiveNumber(rootMaxTicks)) {
    violations.push("root_max_total_ticks_must_be_positive");
  }
  if (isPresent(decisionTick) && !isPositiveNumber(decisionTick)) {
    violations.push("decision_tick_must_be_positive");
  }
  if (isPresent(stopTick) && !isPositiveNumber(stopTick)) {
    violations.push("stop_tick_must_be_positive");
  }
  if (isPositiveNumber(decisionTick) && isPositiveNumber(stopTick) && decisionTick >= stopTick) {
    violations.push("decision_tick_must_precede_stop_tick");
  }
  if (isPositiveNumber(stopTick) && isPositiveNumber(rootMaxTicks) && stopTick > rootMaxTicks) {
    violations.push("stop_tick_exceeds_root_max_total_ticks");
  }

  const requiredRollingSuccessors = readPath(protocol, "lineage.required_rolling_successor_count");
  if (!isFiniteNumber(requiredRollingSuccessors) || requiredRollingSuccessors < 3) {
    violations.push("at_least_three_rolling_successors_required");
  }

  const ready = missing.length === 0 && violations.length === 0;
  if (ready && protocol.status !== "frozen_before_admission") {
    violations.push("complete_protocol_must_be_explicitly_frozen");
  }

  return {
    schema: "helix.nav_eq_protocol_freeze_readiness.v1",
    ready_to_freeze: missing.length === 0 && violations.length === 0,
    motion_authorized: false,
    missing_live_fields: missing,
    violations,
  };
};

if (process.argv[1]?.endsWith("nav-eq-protocol-readiness.ts")) {
  const protocolPath = process.argv[2];
  if (!protocolPath) throw new Error("Expected a NAV-EQ protocol JSON path");
  const protocol = JSON.parse(readFileSync(protocolPath, "utf8"));
  process.stdout.write(`${JSON.stringify(inspectNavEqProtocolFreezeReadiness(protocol), null, 2)}\n`);
}
