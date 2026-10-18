import { readFileSync } from "node:fs";

type JsonRecord = Record<string, unknown>;

const REQUIRED_METRIC_IDS = [
  "resident_computation_latency_ms",
  "dispatch_to_first_tick_latency_ms",
  "useful_motion_ratio",
  "stationary_or_missed_ticks",
  "queue_depth",
  "successor_readiness_latency_ms",
  "committed_runway_ticks",
  "observation_to_reentry_latency_ms",
  "replan_delay_ms",
  "local_manual_takeover_latency_ms",
  "direct_user_cancellation_latency_ms",
  "duplicate_effect_count",
  "stale_effect_count",
  "evidence_volume_bytes",
  "evidence_event_count",
  "progress_per_model_tool_round_trip_blocks",
] as const;

type MetricId = (typeof REQUIRED_METRIC_IDS)[number];

export type NavEqMeasurementReadiness = {
  schema: "helix.nav_eq_measurement_readiness.v1";
  ready_for_acceptance: boolean;
  required_metric_count: number;
  measured_metric_count: number;
  open_metric_ids: string[];
  unavailable_metric_ids: string[];
  violations: string[];
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const metricsFrom = (value: unknown): JsonRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const hasNonemptyStrings = (value: unknown): boolean =>
  Array.isArray(value) && value.some((item) => typeof item === "string" && item.length > 0);

const validQuantiles = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const { p50, p95, p99 } = value;
  return (
    typeof p50 === "number" && Number.isFinite(p50) &&
    typeof p95 === "number" && Number.isFinite(p95) &&
    typeof p99 === "number" && Number.isFinite(p99) &&
    p50 <= p95 && p95 <= p99
  );
};

export const inspectNavEqMeasurementReadiness = (
  contract: unknown,
): NavEqMeasurementReadiness => {
  const violations: string[] = [];
  if (!isRecord(contract)) {
    return {
      schema: "helix.nav_eq_measurement_readiness.v1",
      ready_for_acceptance: false,
      required_metric_count: REQUIRED_METRIC_IDS.length,
      measured_metric_count: 0,
      open_metric_ids: [...REQUIRED_METRIC_IDS],
      unavailable_metric_ids: [],
      violations: ["measurement_contract_must_be_an_object"],
    };
  }
  if (contract.schema !== "helix.nav_eq_measurement_contract.v1") {
    violations.push("unsupported_measurement_contract_schema");
  }

  const metrics = metricsFrom(contract.metrics);
  const ids = metrics
    .map((metric) => metric.metric_id)
    .filter((value): value is string => typeof value === "string");
  for (const requiredId of REQUIRED_METRIC_IDS) {
    if (!ids.includes(requiredId)) violations.push(`missing_metric:${requiredId}`);
  }
  for (const id of ids.filter((value, index) => ids.indexOf(value) !== index)) {
    const violation = `duplicate_metric:${id}`;
    if (!violations.includes(violation)) violations.push(violation);
  }
  for (const id of ids) {
    if (!REQUIRED_METRIC_IDS.includes(id as MetricId)) {
      violations.push(`unexpected_metric:${id}`);
    }
  }

  const allowedStatuses = new Set(["pending", "measured", "unavailable"]);
  for (const metric of metrics) {
    const id = typeof metric.metric_id === "string" ? metric.metric_id : "unknown";
    if (!allowedStatuses.has(metric.status as string)) {
      violations.push(`invalid_metric_status:${id}`);
      continue;
    }
    const minimum = metric.minimum_sample_count;
    if (typeof minimum !== "number" || !Number.isInteger(minimum) || minimum < 1) {
      violations.push(`invalid_minimum_sample_count:${id}`);
    }
    if (metric.status === "measured") {
      if (
        typeof metric.sample_count !== "number" ||
        !Number.isInteger(metric.sample_count) ||
        metric.sample_count < (typeof minimum === "number" ? minimum : 1)
      ) {
        violations.push(`insufficient_sample_count:${id}`);
      }
      if (typeof metric.clock_origin_id !== "string" || metric.clock_origin_id.length === 0) {
        violations.push(`measured_metric_missing_clock_origin:${id}`);
      }
      if (!hasNonemptyStrings(metric.source_evidence_refs)) {
        violations.push(`measured_metric_missing_evidence:${id}`);
      }
      if (metric.aggregation === "p50_p95_p99") {
        if (!validQuantiles(metric.value)) violations.push(`invalid_quantiles:${id}`);
      } else if (metric.value === null || metric.value === undefined) {
        violations.push(`measured_metric_missing_value:${id}`);
      }
    }
    if (
      metric.status === "unavailable" &&
      (typeof metric.unavailable_reason !== "string" || metric.unavailable_reason.length === 0)
    ) {
      violations.push(`unavailable_metric_missing_reason:${id}`);
    }
  }

  const measuredIds = REQUIRED_METRIC_IDS.filter(
    (requiredId) => metrics.find((metric) => metric.metric_id === requiredId)?.status === "measured",
  );
  const unavailableIds = REQUIRED_METRIC_IDS.filter(
    (requiredId) => metrics.find((metric) => metric.metric_id === requiredId)?.status === "unavailable",
  );
  const openIds = REQUIRED_METRIC_IDS.filter(
    (requiredId) => metrics.find((metric) => metric.metric_id === requiredId)?.status !== "measured",
  );
  const allMeasured = measuredIds.length === REQUIRED_METRIC_IDS.length;

  if (allMeasured) {
    if (contract.frozen !== true) violations.push("complete_measurements_must_be_frozen");
    if (contract.status !== "frozen_complete") {
      violations.push("complete_measurements_must_declare_frozen_complete");
    }
  } else {
    if (contract.frozen === true) violations.push("incomplete_measurements_must_not_be_frozen");
    if (contract.status === "frozen_complete") {
      violations.push("incomplete_measurements_must_not_declare_complete");
    }
  }

  return {
    schema: "helix.nav_eq_measurement_readiness.v1",
    ready_for_acceptance: allMeasured && violations.length === 0,
    required_metric_count: REQUIRED_METRIC_IDS.length,
    measured_metric_count: measuredIds.length,
    open_metric_ids: openIds,
    unavailable_metric_ids: unavailableIds,
    violations,
  };
};

if (process.argv[1]?.endsWith("nav-eq-measurement-readiness.ts")) {
  const contractPath = process.argv[2];
  if (!contractPath) throw new Error("Expected a NAV-EQ measurement contract JSON path");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  process.stdout.write(`${JSON.stringify(inspectNavEqMeasurementReadiness(contract), null, 2)}\n`);
}
