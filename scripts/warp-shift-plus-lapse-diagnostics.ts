import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Buffer } from "node:buffer";
import {
  initializePipelineState,
  setGlobalPipelineState,
  updateParameters,
} from "../server/energy-pipeline.js";
import { buildGrEvolveBrick } from "../server/gr-evolve-brick.js";
import { computeCabinLapseDiagnosticsFromBrick } from "../shared/time-dilation-diagnostics.js";
import {
  buildMildCabinGravityReferenceCalibration,
  deriveWarpMetricFamilySemantics,
  evaluateWarpMetricLapseField,
} from "../modules/warp/warp-metric-adapter.js";

const DATE_STAMP = "2026-04-01";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_JSON = path.join(
  ROOT,
  "artifacts",
  "research",
  "full-solve",
  "nhm2-shift-plus-lapse-diagnostics-latest.json",
);
const OUT_MD = path.join(
  ROOT,
  "docs",
  "audits",
  "research",
  "warp-nhm2-shift-plus-lapse-diagnostics-latest.md",
);

const toFinite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

type ScalarSummary = {
  min: number | null;
  max: number | null;
  absMax: number | null;
  mean: number | null;
};

const summarizeChannel = (data: Float32Array | undefined) => {
  if (!data || data.length === 0) {
    return { min: null, max: null, absMax: null, mean: null };
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let absMax = 0;
  let sum = 0;
  for (const value of data) {
    if (value < min) min = value;
    if (value > max) max = value;
    const abs = Math.abs(value);
    if (abs > absMax) absMax = abs;
    sum += value;
  }
  return {
    min,
    max,
    absMax,
    mean: sum / data.length,
  };
};

const summarizeScalar = (value: number | null | undefined): ScalarSummary => {
  const finite = toFinite(value);
  if (finite == null) {
    return { min: null, max: null, absMax: null, mean: null };
  }
  return {
    min: finite,
    max: finite,
    absMax: Math.abs(finite),
    mean: finite,
  };
};

const annotateSummary = (
  summary: ScalarSummary,
  source: string,
  numericType: string,
) => ({
  ...summary,
  source,
  numericType,
});

const maxSummaryAbs = (...summaries: ScalarSummary[]): number =>
  Math.max(...summaries.map((summary) => Math.abs(summary.absMax ?? 0)), 0);

const percentile = (values: number[], fraction: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)));
  return sorted[idx] ?? null;
};

const sampleBrickChannelAtPoint = (
  brick: {
    dims: [number, number, number];
    bounds: { min: [number, number, number]; max: [number, number, number] };
    channels: Record<string, { data: Float32Array } | undefined>;
  },
  channelId: string,
  point: [number, number, number],
): number | null => {
  const channel = brick.channels[channelId];
  if (!channel?.data) return null;
  const [nx, ny, nz] = brick.dims;
  const clampIndex = (value: number, size: number) =>
    Math.max(0, Math.min(size - 1, value));
  const xNorm =
    (point[0] - brick.bounds.min[0]) /
    Math.max(1e-12, brick.bounds.max[0] - brick.bounds.min[0]);
  const yNorm =
    (point[1] - brick.bounds.min[1]) /
    Math.max(1e-12, brick.bounds.max[1] - brick.bounds.min[1]);
  const zNorm =
    (point[2] - brick.bounds.min[2]) /
    Math.max(1e-12, brick.bounds.max[2] - brick.bounds.min[2]);
  const ix = clampIndex(Math.floor(xNorm * nx), nx);
  const iy = clampIndex(Math.floor(yNorm * ny), ny);
  const iz = clampIndex(Math.floor(zNorm * nz), nz);
  const idx = iz * nx * ny + iy * nx + ix;
  return toFinite(channel.data[idx]);
};

const buildAnalyticFieldSummary = (
  lapseSummary: any,
  axes: [number, number, number],
) => {
  const centerPoint: [number, number, number] = [0, 0, 0];
  const halfSeparation =
    toFinite(lapseSummary?.referenceCalibration?.targetCabinHeight_m) != null
      ? Math.max(
          1e-6,
          Math.min(
            Number(lapseSummary.referenceCalibration.targetCabinHeight_m) * 0.5,
            axes[2],
          ),
        )
      : Math.max(1e-6, axes[2] * 0.25);
  const topPoint: [number, number, number] = [0, 0, halfSeparation];
  const bottomPoint: [number, number, number] = [0, 0, -halfSeparation];
  const centerlineAlpha =
    evaluateWarpMetricLapseField({
      lapseSummary,
      point: centerPoint,
      hullAxes: axes,
    }) ?? null;
  const topAlpha =
    evaluateWarpMetricLapseField({
      lapseSummary,
      point: topPoint,
      hullAxes: axes,
    }) ?? null;
  const bottomAlpha =
    evaluateWarpMetricLapseField({
      lapseSummary,
      point: bottomPoint,
      hullAxes: axes,
    }) ?? null;
  const gradientVec = Array.isArray(lapseSummary?.alphaGradientVec_m_inv)
    ? [
        toFinite(lapseSummary.alphaGradientVec_m_inv[0]) ?? 0,
        toFinite(lapseSummary.alphaGradientVec_m_inv[1]) ?? 0,
        toFinite(lapseSummary.alphaGradientVec_m_inv[2]) ?? 0,
      ]
    : [0, 0, 0];
  const alphaSafe = Math.max(1e-12, Math.abs(centerlineAlpha ?? lapseSummary?.alphaCenterline ?? 1));
  const accelVec = gradientVec.map((component) => component / alphaSafe) as [number, number, number];
  return {
    alphaSamples: {
      centerlineAlpha,
      topAlpha,
      bottomAlpha,
      analyticExpectedDeltaAlpha:
        topAlpha != null && bottomAlpha != null ? Math.abs(topAlpha - bottomAlpha) : null,
      cabinSampleSeparation_m: halfSeparation * 2,
      samplePoints: {
        centerline: centerPoint,
        top_z_zenith: topPoint,
        bottom_z_zenith: bottomPoint,
      },
    },
    lapseGradientDiagnostics: {
      units: "1/m",
      alpha_grad_x: annotateSummary(
        summarizeScalar(gradientVec[0]),
        "analytic_lapse_summary_companion",
        "float64_analytic",
      ),
      alpha_grad_y: annotateSummary(
        summarizeScalar(gradientVec[1]),
        "analytic_lapse_summary_companion",
        "float64_analytic",
      ),
      alpha_grad_z: annotateSummary(
        summarizeScalar(gradientVec[2]),
        "analytic_lapse_summary_companion",
        "float64_analytic",
      ),
    },
    eulerianAccelerationDiagnostics: {
      units: "1/m",
      eulerian_accel_geom_x: annotateSummary(
        summarizeScalar(accelVec[0]),
        "analytic_lapse_summary_companion",
        "float64_analytic",
      ),
      eulerian_accel_geom_y: annotateSummary(
        summarizeScalar(accelVec[1]),
        "analytic_lapse_summary_companion",
        "float64_analytic",
      ),
      eulerian_accel_geom_z: annotateSummary(
        summarizeScalar(accelVec[2]),
        "analytic_lapse_summary_companion",
        "float64_analytic",
      ),
      eulerian_accel_geom_mag: annotateSummary(
        summarizeScalar(Math.hypot(...accelVec)),
        "analytic_lapse_summary_companion",
        "float64_analytic",
      ),
    },
  };
};

const MILD_REFERENCE_CALIBRATION = buildMildCabinGravityReferenceCalibration({
  targetCabinGravity_si: 0.5 * 9.80665,
  targetCabinHeight_m: 2.5,
});

const SHIFT_PLUS_LAPSE_SCENARIOS = {
  mild_cabin_gravity_reference: {
    scenarioId: "mild_cabin_gravity_reference",
    alphaProfileKind: "linear_gradient_tapered",
    alphaCenterline: 1,
    alphaGradientVec_m_inv: [0, 0, MILD_REFERENCE_CALIBRATION.expectedAlphaGradientGeom] as [number, number, number],
    alphaInteriorSupportKind: "hull_interior",
    alphaWallTaper_m: 8,
    referenceCalibration: MILD_REFERENCE_CALIBRATION,
  },
} as const;

type ShiftPlusLapseScenarioId = keyof typeof SHIFT_PLUS_LAPSE_SCENARIOS;

type ShiftPlusLapseScenario = (typeof SHIFT_PLUS_LAPSE_SCENARIOS)[ShiftPlusLapseScenarioId];

const buildCombinedShiftLapseSafety = (
  gauge: Record<string, unknown> | null | undefined,
) => {
  const betaOverAlphaMax = toFinite(gauge?.betaOverAlphaMax);
  const betaOverAlphaP98 = toFinite(gauge?.betaOverAlphaP98);
  const betaOutwardOverAlphaWallMax = toFinite(gauge?.betaOutwardOverAlphaWallMax);
  const betaOutwardOverAlphaWallP98 = toFinite(gauge?.betaOutwardOverAlphaWallP98);
  const wallHorizonMargin = toFinite(gauge?.wallHorizonMargin);
  if (betaOverAlphaMax == null) {
    return {
      status: "unknown" as const,
      betaOverAlphaMax: null,
      betaOverAlphaP98,
      betaOutwardOverAlphaWallMax,
      betaOutwardOverAlphaWallP98,
      wallHorizonMargin,
      note:
        "Combined shift/lapse safety unavailable because betaOverAlpha diagnostics were not present in the GR gauge summary.",
    };
  }
  const dominantRatio = Math.max(betaOverAlphaMax, betaOutwardOverAlphaWallMax ?? 0);
  return {
    status: dominantRatio < 1 ? ("pass" as const) : ("warn" as const),
    betaOverAlphaMax,
    betaOverAlphaP98,
    betaOutwardOverAlphaWallMax,
    betaOutwardOverAlphaWallP98,
    wallHorizonMargin,
    note:
      betaOutwardOverAlphaWallMax == null
        ? "Outward wall-normal beta/alpha safety is unavailable; using bulk betaOverAlpha metrics only."
        : "Combined shift/lapse safety remains advisory-only for this diagnostics-first reference branch.",
  };
};

const buildPrecisionAwareDiagnostics = (args: {
  brick: ReturnType<typeof buildGrEvolveBrick>;
  lapseSummary: any;
  axes: [number, number, number];
}) => {
  const { brick, lapseSummary, axes } = args;
  const halfSeparation =
    toFinite(lapseSummary?.referenceCalibration?.targetCabinHeight_m) != null
      ? Math.max(
          1e-6,
          Math.min(
            Number(lapseSummary.referenceCalibration.targetCabinHeight_m) * 0.5,
            axes[2],
          ),
        )
      : Math.max(1e-6, axes[2] * 0.25);
  const rawBrickDiagnostics = {
    source: "brick_float32_direct",
    numericType: "float32",
    alphaSamples: {
      centerlineAlpha: sampleBrickChannelAtPoint(brick, "alpha", [0, 0, 0]),
      topAlpha: sampleBrickChannelAtPoint(brick, "alpha", [0, 0, halfSeparation]),
      bottomAlpha: sampleBrickChannelAtPoint(brick, "alpha", [0, 0, -halfSeparation]),
      cabinSampleSeparation_m: halfSeparation * 2,
    },
    lapseGradientDiagnostics: {
      units: "1/m",
      alpha_grad_x: annotateSummary(
        summarizeChannel(brick.channels.alpha_grad_x?.data),
        "brick_float32_direct",
        "float32",
      ),
      alpha_grad_y: annotateSummary(
        summarizeChannel(brick.channels.alpha_grad_y?.data),
        "brick_float32_direct",
        "float32",
      ),
      alpha_grad_z: annotateSummary(
        summarizeChannel(brick.channels.alpha_grad_z?.data),
        "brick_float32_direct",
        "float32",
      ),
    },
    eulerianAccelerationDiagnostics: {
      units: "1/m",
      eulerian_accel_geom_x: annotateSummary(
        summarizeChannel(brick.channels.eulerian_accel_geom_x?.data),
        "brick_float32_direct",
        "float32",
      ),
      eulerian_accel_geom_y: annotateSummary(
        summarizeChannel(brick.channels.eulerian_accel_geom_y?.data),
        "brick_float32_direct",
        "float32",
      ),
      eulerian_accel_geom_z: annotateSummary(
        summarizeChannel(brick.channels.eulerian_accel_geom_z?.data),
        "brick_float32_direct",
        "float32",
      ),
      eulerian_accel_geom_mag: annotateSummary(
        summarizeChannel(brick.channels.eulerian_accel_geom_mag?.data),
        "brick_float32_direct",
        "float32",
      ),
    },
  };
  const analyticCompanionDiagnostics = buildAnalyticFieldSummary(lapseSummary, axes);
  const rawBrickDeltaAlpha =
    rawBrickDiagnostics.alphaSamples.topAlpha != null &&
    rawBrickDiagnostics.alphaSamples.bottomAlpha != null
      ? Math.abs(
          rawBrickDiagnostics.alphaSamples.topAlpha - rawBrickDiagnostics.alphaSamples.bottomAlpha,
        )
      : null;
  const analyticExpectedDeltaAlpha =
    analyticCompanionDiagnostics.alphaSamples.analyticExpectedDeltaAlpha;
  const rawGradientAbsMax = maxSummaryAbs(
    rawBrickDiagnostics.lapseGradientDiagnostics.alpha_grad_x,
    rawBrickDiagnostics.lapseGradientDiagnostics.alpha_grad_y,
    rawBrickDiagnostics.lapseGradientDiagnostics.alpha_grad_z,
  );
  const analyticGradientAbsMax = maxSummaryAbs(
    analyticCompanionDiagnostics.lapseGradientDiagnostics.alpha_grad_x,
    analyticCompanionDiagnostics.lapseGradientDiagnostics.alpha_grad_y,
    analyticCompanionDiagnostics.lapseGradientDiagnostics.alpha_grad_z,
  );
  const rawAccelAbsMax = maxSummaryAbs(
    rawBrickDiagnostics.eulerianAccelerationDiagnostics.eulerian_accel_geom_x,
    rawBrickDiagnostics.eulerianAccelerationDiagnostics.eulerian_accel_geom_y,
    rawBrickDiagnostics.eulerianAccelerationDiagnostics.eulerian_accel_geom_z,
    rawBrickDiagnostics.eulerianAccelerationDiagnostics.eulerian_accel_geom_mag,
  );
  const analyticAccelAbsMax = maxSummaryAbs(
    analyticCompanionDiagnostics.eulerianAccelerationDiagnostics.eulerian_accel_geom_x,
    analyticCompanionDiagnostics.eulerianAccelerationDiagnostics.eulerian_accel_geom_y,
    analyticCompanionDiagnostics.eulerianAccelerationDiagnostics.eulerian_accel_geom_z,
    analyticCompanionDiagnostics.eulerianAccelerationDiagnostics.eulerian_accel_geom_mag,
  );
  const alphaUnderResolved =
    analyticExpectedDeltaAlpha != null &&
    analyticExpectedDeltaAlpha > 0 &&
    (rawBrickDeltaAlpha ?? 0) <= analyticExpectedDeltaAlpha * 1e-3;
  const gradientUnderResolved =
    analyticGradientAbsMax > 0 &&
    rawGradientAbsMax <= analyticGradientAbsMax * 1e-3;
  const accelUnderResolved =
    analyticAccelAbsMax > 0 &&
    rawAccelAbsMax <= analyticAccelAbsMax * 1e-3;
  const underResolutionDetected =
    alphaUnderResolved || gradientUnderResolved || accelUnderResolved;
  const underResolutionReasons = [
    alphaUnderResolved
      ? "raw brick alpha top-bottom delta is below analytic mild-reference expectation"
      : null,
    gradientUnderResolved
      ? "raw float32 alpha_grad channels under-resolve the calibrated weak-field gradient"
      : null,
    accelUnderResolved
      ? "raw float32 Eulerian acceleration channels under-resolve the calibrated weak-field acceleration"
      : null,
  ].filter((reason): reason is string => typeof reason === "string");
  const useAnalyticCompanion = underResolutionDetected;
  const preferSource = useAnalyticCompanion
    ? "analytic_lapse_summary_companion"
    : "brick_float32_direct";
  const effectiveDiagnostics = {
    sourcePolicy: useAnalyticCompanion
      ? "mixed_source_prefer_analytic_for_underflow"
      : "brick_float32_direct",
    lapseGradientDiagnostics: {
      units: "1/m",
      alpha_grad_x: useAnalyticCompanion
        ? analyticCompanionDiagnostics.lapseGradientDiagnostics.alpha_grad_x
        : rawBrickDiagnostics.lapseGradientDiagnostics.alpha_grad_x,
      alpha_grad_y: useAnalyticCompanion
        ? analyticCompanionDiagnostics.lapseGradientDiagnostics.alpha_grad_y
        : rawBrickDiagnostics.lapseGradientDiagnostics.alpha_grad_y,
      alpha_grad_z: useAnalyticCompanion
        ? analyticCompanionDiagnostics.lapseGradientDiagnostics.alpha_grad_z
        : rawBrickDiagnostics.lapseGradientDiagnostics.alpha_grad_z,
    },
    eulerianAccelerationDiagnostics: {
      units: "1/m",
      eulerian_accel_geom_x: useAnalyticCompanion
        ? analyticCompanionDiagnostics.eulerianAccelerationDiagnostics.eulerian_accel_geom_x
        : rawBrickDiagnostics.eulerianAccelerationDiagnostics.eulerian_accel_geom_x,
      eulerian_accel_geom_y: useAnalyticCompanion
        ? analyticCompanionDiagnostics.eulerianAccelerationDiagnostics.eulerian_accel_geom_y
        : rawBrickDiagnostics.eulerianAccelerationDiagnostics.eulerian_accel_geom_y,
      eulerian_accel_geom_z: useAnalyticCompanion
        ? analyticCompanionDiagnostics.eulerianAccelerationDiagnostics.eulerian_accel_geom_z
        : rawBrickDiagnostics.eulerianAccelerationDiagnostics.eulerian_accel_geom_z,
      eulerian_accel_geom_mag: useAnalyticCompanion
        ? analyticCompanionDiagnostics.eulerianAccelerationDiagnostics.eulerian_accel_geom_mag
        : rawBrickDiagnostics.eulerianAccelerationDiagnostics.eulerian_accel_geom_mag,
    },
  };
  return {
    mildLapseFidelityStatus: useAnalyticCompanion
      ? "mixed_source_prefer_analytic_for_underflow"
      : "brick_float32_direct",
    channelPrecisionPolicy: useAnalyticCompanion
      ? "mixed_source_prefer_analytic_for_underflow"
      : "brick_float32_direct",
    preferredCompanionSource: preferSource,
    underResolutionDetected,
    underResolutionReason:
      underResolutionReasons.length > 0
        ? underResolutionReasons.join("; ")
        : "raw brick mild-lapse channels resolve the published scenario directly",
    rawBrickDeltaAlpha,
    analyticExpectedDeltaAlpha,
    rawBrickDiagnostics,
    analyticCompanionDiagnostics: {
      source: "analytic_lapse_summary_companion",
      numericType: "float64_analytic",
      ...analyticCompanionDiagnostics,
    },
    effectiveDiagnostics,
  };
};

const buildMarkdown = (payload: any) => {
  const lines = [
    "# NHM2 Shift-Plus-Lapse Diagnostics",
    "",
    `- date: ${DATE_STAMP}`,
    `- familySourceId: ${payload.familySourceId}`,
    `- scenarioId: ${payload.scenarioId}`,
    `- diagnosticTier: ${payload.diagnosticTier}`,
    `- authoritativeProofSurface: ${payload.proofPolicy.authoritativeProofSurface}`,
    `- laneAUnchanged: ${payload.proofPolicy.laneAUnchanged ? "yes" : "no"}`,
    "",
    "## Reference Calibration",
    "",
    `- targetCabinGravity_si: ${payload.referenceCalibration?.targetCabinGravity_si ?? "n/a"}`,
    `- targetCabinHeight_m: ${payload.referenceCalibration?.targetCabinHeight_m ?? "n/a"}`,
    `- expectedAlphaGradientGeom: ${payload.referenceCalibration?.expectedAlphaGradientGeom ?? "n/a"}`,
    `- calibrationNote: ${payload.referenceCalibration?.calibrationNote ?? "n/a"}`,
    "",
    "## Branch",
    "",
    `- warpFieldType: ${payload.branch.warpFieldType}`,
    `- metricT00Ref: ${payload.branch.metricT00Ref}`,
    `- metricAdapterFamily: ${payload.branch.metricAdapterFamily}`,
    `- familyAuthorityStatus: ${payload.branch.familyAuthorityStatus ?? "unknown"}`,
    `- transportCertificationStatus: ${payload.branch.transportCertificationStatus ?? "unknown"}`,
    `- familySemanticsNote: ${payload.branch.familySemanticsNote ?? "n/a"}`,
    "",
    "## Alpha Profile",
    "",
    `- alphaProfileKind: ${payload.alphaProfileMetadata?.alphaProfileKind ?? "unknown"}`,
    `- alphaCenterline: ${payload.alphaProfileMetadata?.alphaCenterline ?? "n/a"}`,
    `- alphaMin: ${payload.alphaProfileMetadata?.alphaMin ?? "n/a"}`,
    `- alphaMax: ${payload.alphaProfileMetadata?.alphaMax ?? "n/a"}`,
    `- alphaGradientAxis: ${payload.alphaProfileMetadata?.alphaGradientAxis ?? "unknown"}`,
    `- alphaGradientVec_m_inv: ${JSON.stringify(payload.alphaProfileMetadata?.alphaGradientVec_m_inv ?? null)}`,
    "",
    "## Precision Context",
    "",
    `- mildLapseFidelityStatus: ${payload.mildLapseFidelityStatus}`,
    `- channelPrecisionPolicy: ${payload.channelPrecisionPolicy}`,
    `- preferredCompanionSource: ${payload.preferredCompanionSource}`,
    `- underResolutionDetected: ${payload.underResolutionDetected ? "yes" : "no"}`,
    `- underResolutionReason: ${payload.underResolutionReason}`,
    `- rawBrickDeltaAlpha: ${payload.rawBrickDeltaAlpha ?? "n/a"}`,
    `- analyticExpectedDeltaAlpha: ${payload.analyticExpectedDeltaAlpha ?? "n/a"}`,
    `- brickNumericType: ${payload.precisionContext?.brickNumericType ?? "n/a"}`,
    `- companionNumericType: ${payload.precisionContext?.companionNumericType ?? "n/a"}`,
    `- wallSafetySource: ${payload.precisionContext?.wallSafetySource ?? "n/a"}`,
    "",
    "## Effective Companion Diagnostics",
    "",
    `- effective alpha_grad_z absMax: ${payload.effectiveDiagnostics?.lapseGradientDiagnostics?.alpha_grad_z?.absMax ?? "n/a"}`,
    `- effective eulerian_accel_geom_mag absMax: ${payload.effectiveDiagnostics?.eulerianAccelerationDiagnostics?.eulerian_accel_geom_mag?.absMax ?? "n/a"}`,
    `- effective source policy: ${payload.effectiveDiagnostics?.sourcePolicy ?? "n/a"}`,
    "",
    "## Cabin Observables",
    "",
    `- centerline_alpha: ${payload.cabinObservables.centerline_alpha ?? "n/a"}`,
    `- centerline_dtau_dt: ${payload.cabinObservables.centerline_dtau_dt ?? "n/a"}`,
    `- cabin_clock_split_fraction: ${payload.cabinObservables.cabin_clock_split_fraction ?? "n/a"}`,
    `- cabin_clock_split_per_day_s: ${payload.cabinObservables.cabin_clock_split_per_day_s ?? "n/a"}`,
    `- cabin_clock_split_per_year_s: ${payload.cabinObservables.cabin_clock_split_per_year_s ?? "n/a"}`,
    `- cabin_gravity_gradient_geom: ${payload.cabinObservables.cabin_gravity_gradient_geom ?? "n/a"}`,
    `- cabin_gravity_gradient_si: ${payload.cabinObservables.cabin_gravity_gradient_si ?? "n/a"}`,
    `- cabinSampleAxis: ${payload.cabinObservables.cabinSampleAxis ?? "n/a"}`,
    `- cabinSampleSeparation_m: ${payload.cabinObservables.cabinSampleSeparation_m ?? "n/a"}`,
    `- cabinSamplePolicy: ${payload.cabinObservables.cabinSamplePolicy ?? "n/a"}`,
    `- cabin details source: ${payload.cabinObservables.details?.source ?? "n/a"}`,
    `- centerlineAlphaSource: ${payload.cabinObservables.details?.centerlineAlphaSource ?? "n/a"}`,
    `- topBottomAlphaSource: ${payload.cabinObservables.details?.topBottomAlphaSource ?? "n/a"}`,
    `- gravityGradientSource: ${payload.cabinObservables.details?.gravityGradientSource ?? "n/a"}`,
    "",
    "## Wall Safety",
    "",
    `- betaOutwardOverAlphaWallMax: ${payload.wallSafetySummary?.betaOutwardOverAlphaWallMax ?? "n/a"}`,
    `- betaOutwardOverAlphaWallP98: ${payload.wallSafetySummary?.betaOutwardOverAlphaWallP98 ?? "n/a"}`,
    `- wallHorizonMargin: ${payload.wallSafetySummary?.wallHorizonMargin ?? "n/a"}`,
    `- wallSamplingPolicy: ${payload.wallSafetySummary?.wallSamplingPolicy ?? "n/a"}`,
    `- wallNormalModel: ${payload.wallSafetySummary?.wallNormalModel ?? "n/a"}`,
    `- wallSampleCount: ${payload.wallSafetySummary?.wallSampleCount ?? "n/a"}`,
    `- wallRegionDefinition: ${payload.wallSafetySummary?.wallRegionDefinition ?? "n/a"}`,
    `- source: ${payload.wallSafetySummary?.source ?? "n/a"}`,
    "",
    "## Combined Shift/Lapse Safety",
    "",
    `- status: ${payload.combinedShiftLapseSafety.status}`,
    `- betaOverAlphaMax: ${payload.combinedShiftLapseSafety.betaOverAlphaMax ?? "n/a"}`,
    `- betaOverAlphaP98: ${payload.combinedShiftLapseSafety.betaOverAlphaP98 ?? "n/a"}`,
    `- betaOutwardOverAlphaWallMax: ${payload.combinedShiftLapseSafety.betaOutwardOverAlphaWallMax ?? "n/a"}`,
    `- betaOutwardOverAlphaWallP98: ${payload.combinedShiftLapseSafety.betaOutwardOverAlphaWallP98 ?? "n/a"}`,
    `- wallHorizonMargin: ${payload.combinedShiftLapseSafety.wallHorizonMargin ?? "n/a"}`,
    `- note: ${payload.combinedShiftLapseSafety.note ?? "n/a"}`,
    "",
    "## Proof Policy",
    "",
    `- familyAuthorityStatus: ${payload.proofPolicy.familyAuthorityStatus ?? "unknown"}`,
    `- transportCertificationStatus: ${payload.proofPolicy.transportCertificationStatus ?? "unknown"}`,
    `- boundedTransportFailClosed: ${payload.proofPolicy.boundedTransportFailClosed ? "yes" : "no"}`,
    ...payload.proofPolicy.disclaimer.map((line: string) => `- ${line}`),
    "",
  ];
  return `${lines.join("\n")}\n`;
};

const attachReferenceMetadata = (
  state: any,
  scenario: ShiftPlusLapseScenario,
): any => {
  const enrichedSummary = {
    ...((state as any)?.warp?.lapseSummary ?? {}),
    scenarioId: scenario.scenarioId,
    referenceCalibration: scenario.referenceCalibration,
  };
  if ((state as any)?.warp) {
    (state as any).warp.lapseSummary = enrichedSummary;
    if ((state as any).warp.metricAdapter) {
      (state as any).warp.metricAdapter.lapseSummary = {
        ...((state as any).warp.metricAdapter.lapseSummary ?? {}),
        ...enrichedSummary,
      };
    }
  }
  if ((state as any)?.natario) {
    (state as any).natario.lapseSummary = enrichedSummary;
    if ((state as any).natario.metricAdapter) {
      (state as any).natario.metricAdapter.lapseSummary = {
        ...((state as any).natario.metricAdapter.lapseSummary ?? {}),
        ...enrichedSummary,
      };
    }
  }
  return state;
};

export const buildShiftPlusLapseDiagnosticsPayload = async () => {
  const scenario = SHIFT_PLUS_LAPSE_SCENARIOS.mild_cabin_gravity_reference;
  let state = initializePipelineState();
  state = await updateParameters(
    state,
    {
      warpFieldType: "nhm2_shift_lapse",
      dynamicConfig: {
        ...(state.dynamicConfig ?? {}),
        warpFieldType: "nhm2_shift_lapse",
        alphaProfileKind: scenario.alphaProfileKind,
        alphaCenterline: scenario.alphaCenterline,
        alphaGradientVec_m_inv: scenario.alphaGradientVec_m_inv,
        alphaInteriorSupportKind: scenario.alphaInteriorSupportKind,
        alphaWallTaper_m: scenario.alphaWallTaper_m,
      },
      alphaProfileKind: scenario.alphaProfileKind,
      alphaCenterline: scenario.alphaCenterline,
      alphaGradientVec_m_inv: scenario.alphaGradientVec_m_inv,
      alphaInteriorSupportKind: scenario.alphaInteriorSupportKind,
      alphaWallTaper_m: scenario.alphaWallTaper_m,
    } as any,
    { includeReadinessSignals: true },
  );
  state = attachReferenceMetadata(state, scenario);

  setGlobalPipelineState(state);

  const hull = state.hull ?? { Lx_m: 1007, Ly_m: 264, Lz_m: 173 };
  const axes: [number, number, number] = [
    Math.max(1e-6, hull.Lx_m / 2),
    Math.max(1e-6, hull.Ly_m / 2),
    Math.max(1e-6, hull.Lz_m / 2),
  ];
  const bounds = {
    min: [-axes[0], -axes[1], -axes[2]] as [number, number, number],
    max: [axes[0], axes[1], axes[2]] as [number, number, number],
  };
  const lapseSummary =
    (state as any)?.warp?.lapseSummary ??
    (state as any)?.warp?.metricAdapter?.lapseSummary ??
    (state as any)?.natario?.metricAdapter?.lapseSummary ??
    (state as any)?.natario?.lapseSummary ??
    null;

  if (!lapseSummary) {
    throw new Error(
      "Shift-plus-lapse diagnostic branch did not expose lapseSummary on the pipeline state.",
    );
  }
  const brick = buildGrEvolveBrick({
    dims: [48, 48, 48],
    bounds,
    includeMatter: false,
    includeConstraints: false,
    includeKij: false,
    includeInvariants: false,
  });
  const encodeChannel = (data: Float32Array | undefined) =>
    data ? { data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64") } : undefined;
  const serializedBrick = {
    dims: brick.dims,
    bounds: brick.bounds,
    channels: Object.fromEntries(
      Object.entries(brick.channels).map(([key, value]) => [key, encodeChannel(value?.data)]),
    ),
  };
  const cabin = computeCabinLapseDiagnosticsFromBrick(state, serializedBrick, axes);
  const ratioValues = Array.from(brick.channels.beta_over_alpha_mag?.data ?? []);
  const betaX = brick.channels.beta_x?.data ?? new Float32Array();
  const betaY = brick.channels.beta_y?.data ?? new Float32Array();
  const betaZ = brick.channels.beta_z?.data ?? new Float32Array();
  const betaMagnitudes = Array.from(betaX, (_, index) =>
    Math.hypot(betaX[index] ?? 0, betaY[index] ?? 0, betaZ[index] ?? 0),
  );
  const wallSafetySummary = brick.stats.wallSafety ?? {
    betaOutwardOverAlphaWallMax: null,
    betaOutwardOverAlphaWallP98: null,
    wallHorizonMargin: null,
    wallSamplingPolicy: "unavailable",
    wallNormalModel: "unavailable",
    wallSampleCount: 0,
    wallRegionDefinition: "unavailable",
    sampleOffsetInsideWall_m: null,
  };
  const precisionDiagnostics = buildPrecisionAwareDiagnostics({
    brick,
    lapseSummary,
    axes,
  });
  const metricT00Contract =
    ((state as any)?.warp?.metricT00Contract as Record<string, unknown> | undefined) ?? undefined;
  const branchSemantics = deriveWarpMetricFamilySemantics("nhm2_shift_lapse");
  const gauge = {
    lapseMin: toFinite(lapseSummary?.alphaMin) ?? brick.channels.alpha?.min ?? summarizeChannel(brick.channels.alpha?.data).min,
    lapseMax: toFinite(lapseSummary?.alphaMax) ?? brick.channels.alpha?.max ?? summarizeChannel(brick.channels.alpha?.data).max,
    betaMaxAbs: betaMagnitudes.length > 0 ? Math.max(...betaMagnitudes) : null,
    betaOverAlphaMax: ratioValues.length > 0 ? Math.max(...ratioValues) : null,
    betaOverAlphaP98: percentile(ratioValues, 0.98),
    betaOutwardOverAlphaWallMax: wallSafetySummary.betaOutwardOverAlphaWallMax,
    betaOutwardOverAlphaWallP98: wallSafetySummary.betaOutwardOverAlphaWallP98,
    wallHorizonMargin: wallSafetySummary.wallHorizonMargin,
  } as Record<string, unknown>;

  const payload = {
    artifactId: "nhm2_shift_plus_lapse_diagnostics",
    capturedAt: new Date().toISOString(),
    date: DATE_STAMP,
    diagnosticTier: "diagnostic",
    scenarioId: scenario.scenarioId,
    familySourceId: "warp.metric.T00.nhm2.shift_lapse",
    referenceCalibration: scenario.referenceCalibration,
    branch: {
      warpFieldType: state.warpFieldType ?? state.dynamicConfig?.warpFieldType ?? null,
      metricT00Ref: (state as any)?.warp?.metricT00Ref ?? (state as any)?.natario?.metricT00Ref ?? null,
      metricAdapterFamily: (state as any)?.warp?.metricAdapter?.family ?? null,
      familyAuthorityStatus:
        (metricT00Contract?.familyAuthorityStatus as string | undefined) ??
        (state as any)?.warp?.metricAdapter?.familyAuthorityStatus ??
        branchSemantics.familyAuthorityStatus,
      transportCertificationStatus:
        (metricT00Contract?.transportCertificationStatus as string | undefined) ??
        (state as any)?.warp?.metricAdapter?.transportCertificationStatus ??
        branchSemantics.transportCertificationStatus,
      familySemanticsNote:
        (metricT00Contract?.familySemanticsNote as string | undefined) ??
        (state as any)?.warp?.metricAdapter?.semanticsNote ??
        branchSemantics.semanticsNote,
    },
    alphaProfileMetadata: {
      ...lapseSummary,
      scenarioId: scenario.scenarioId,
      referenceCalibration: scenario.referenceCalibration,
    },
    mildLapseFidelityStatus: precisionDiagnostics.mildLapseFidelityStatus,
    channelPrecisionPolicy: precisionDiagnostics.channelPrecisionPolicy,
    preferredCompanionSource: precisionDiagnostics.preferredCompanionSource,
    underResolutionDetected: precisionDiagnostics.underResolutionDetected,
    underResolutionReason: precisionDiagnostics.underResolutionReason,
    rawBrickDeltaAlpha: precisionDiagnostics.rawBrickDeltaAlpha,
    analyticExpectedDeltaAlpha: precisionDiagnostics.analyticExpectedDeltaAlpha,
    precisionContext: {
      brickNumericType: "float32",
      companionNumericType: "float64_analytic",
      mildLapseFidelityStatus: precisionDiagnostics.mildLapseFidelityStatus,
      channelPrecisionPolicy: precisionDiagnostics.channelPrecisionPolicy,
      underResolutionDetected: precisionDiagnostics.underResolutionDetected,
      preferredCompanionSource: precisionDiagnostics.preferredCompanionSource,
      wallSafetySource: "brick_float32_direct",
    },
    gaugeSummary: gauge,
    wallSafetySummary: {
      ...wallSafetySummary,
      source: "brick_float32_direct",
    },
    rawBrickDiagnostics: precisionDiagnostics.rawBrickDiagnostics,
    analyticCompanionDiagnostics: precisionDiagnostics.analyticCompanionDiagnostics,
    effectiveDiagnostics: precisionDiagnostics.effectiveDiagnostics,
    lapseGradientDiagnostics: precisionDiagnostics.effectiveDiagnostics.lapseGradientDiagnostics,
    eulerianAccelerationDiagnostics:
      precisionDiagnostics.effectiveDiagnostics.eulerianAccelerationDiagnostics,
    cabinObservables: cabin,
    combinedShiftLapseSafety: buildCombinedShiftLapseSafety(gauge),
    contract: {
      contractId: "adm_gravity_diagnostic_contract",
      contractPath: "configs/adm-gravity-diagnostic-contract.v1.json",
      laneId: "adm_lane_reference_local_static_shift_plus_lapse",
      authoritativeStatus: "reference_only",
    },
    proofPolicy: {
      authoritativeProofSurface: "lane_a_eulerian_comoving_theta_minus_trk",
      laneAUnchanged: true,
      familyAuthorityStatus:
        (metricT00Contract?.familyAuthorityStatus as string | undefined) ??
        branchSemantics.familyAuthorityStatus,
      transportCertificationStatus:
        (metricT00Contract?.transportCertificationStatus as string | undefined) ??
        branchSemantics.transportCertificationStatus,
      boundedTransportFailClosed:
        ((metricT00Contract?.transportCertificationStatus as string | undefined) ??
          branchSemantics.transportCertificationStatus) ===
        "bounded_transport_fail_closed_reference_only",
      disclaimer: [
        "Diagnostic tier only.",
        "Lane A remains authoritative and unchanged.",
        "nhm2_shift_lapse is a candidate authoritative solve family in full-solve provenance/model-selection.",
        "Bounded transport proof-bearing surfaces remain fail-closed and reference-only for nhm2_shift_lapse in this patch.",
        "Cabin gravity and wall-safety diagnostics do not supersede York proof semantics.",
        "No route-time compression claim is made from these reduced-order lapse diagnostics.",
        "Stronger centerline lapse suppression remains deferred to a later new-solve patch.",
        "epsilonTilt remains a shift/shear proxy under the current Natario path.",
      ],
    },
  };
  return payload;
};

export const writeShiftPlusLapseDiagnosticsArtifacts = (payload: any) => {
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.writeFileSync(OUT_MD, buildMarkdown(payload), "utf8");
};

const run = async () => {
  const payload = await buildShiftPlusLapseDiagnosticsPayload();
  writeShiftPlusLapseDiagnosticsArtifacts(payload);
  process.stdout.write(`${JSON.stringify({ ok: true, outJson: OUT_JSON, outMd: OUT_MD }, null, 2)}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
