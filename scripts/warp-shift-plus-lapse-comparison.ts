import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  initializePipelineState,
  setGlobalPipelineState,
  updateParameters,
} from "../server/energy-pipeline.js";
import { buildGrEvolveBrick } from "../server/gr-evolve-brick.js";
import { deriveWarpMetricFamilySemantics } from "../modules/warp/warp-metric-adapter.js";
import { computeCabinLapseDiagnosticsFromBrick } from "../shared/time-dilation-diagnostics.js";
import { PROMOTED_WARP_PROFILE } from "../shared/warp-promoted-profile.js";
import { buildShiftPlusLapseDiagnosticsPayload } from "./warp-shift-plus-lapse-diagnostics.js";
const DATE_STAMP = "2026-04-01";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_JSON = path.join(
  ROOT,
  "artifacts",
  "research",
  "full-solve",
  "nhm2-shift-plus-lapse-comparison-latest.json",
);
const OUT_AUDIT = path.join(
  ROOT,
  "docs",
  "audits",
  "research",
  "warp-nhm2-shift-plus-lapse-comparison-latest.md",
);
const OUT_MEMO = path.join(
  ROOT,
  "docs",
  "research",
  "nhm2-shift-plus-lapse-comparison-memo-2026-04-01.md",
);
type SourceKind =
  | "brick_float32_direct"
  | "analytic_lapse_summary_companion"
  | "mixed_source_prefer_analytic_for_underflow";
type Vector3 = [number, number, number];
type ComparedValue = number | Vector3 | null;
const SPEED_OF_LIGHT_MPS = 299_792_458;
const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_YEAR = 365.25 * SECONDS_PER_DAY;
const toFinite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const percentile = (values: number[], fraction: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(
    0,
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)),
  );
  return sorted[idx] ?? null;
};
const encodeBrickChannels = (brick: ReturnType<typeof buildGrEvolveBrick>) => {
  const encodeChannel = (data: Float32Array | undefined) =>
    data
      ? {
          data: Buffer.from(
            data.buffer,
            data.byteOffset,
            data.byteLength,
          ).toString("base64"),
        }
      : undefined;
  return {
    dims: brick.dims,
    bounds: brick.bounds,
    channels: Object.fromEntries(
      Object.entries(brick.channels).map(([key, value]) => [
        key,
        encodeChannel(value?.data),
      ]),
    ),
  };
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
const mapDiagnosticSourceKind = (
  source: unknown,
  fallback: SourceKind = "brick_float32_direct",
): SourceKind => {
  if (source === "mixed_source_prefer_analytic_for_underflow") {
    return "mixed_source_prefer_analytic_for_underflow";
  }
  if (typeof source === "string" && source.includes("analytic")) {
    return "analytic_lapse_summary_companion";
  }
  return fallback;
};
const resolveSourceKindSummary = (
  baseline: SourceKind,
  generalized: SourceKind,
): SourceKind =>
  baseline === generalized
    ? baseline
    : "mixed_source_prefer_analytic_for_underflow";
const resolveHullAxes = (state: any): Vector3 => {
  const hull = state.hull ?? PROMOTED_WARP_PROFILE.fullHull;
  return [
    Math.max(
      1e-6,
      Number(hull.Lx_m ?? PROMOTED_WARP_PROFILE.fullHull.Lx_m) / 2,
    ),
    Math.max(
      1e-6,
      Number(hull.Ly_m ?? PROMOTED_WARP_PROFILE.fullHull.Ly_m) / 2,
    ),
    Math.max(
      1e-6,
      Number(hull.Lz_m ?? PROMOTED_WARP_PROFILE.fullHull.Lz_m) / 2,
    ),
  ];
};
const buildReferenceBounds = (axes: Vector3) => ({
  min: [-axes[0], -axes[1], -axes[2]] as Vector3,
  max: [axes[0], axes[1], axes[2]] as Vector3,
});
const resolveMetricT00Ref = (state: any): string | null =>
  state?.warp?.metricT00Ref ??
  state?.natario?.metricT00Ref ??
  state?.warp?.metricAdapter?.metricT00Ref ??
  null;
const buildBaselineReferenceCalibration = (sampleSeparation_m: number) => ({
  targetCabinGravity_si: 0,
  targetCabinHeight_m: sampleSeparation_m,
  expectedAlphaGradientGeom: 0,
  calibrationNote:
    "Unit-lapse NHM2 comparison baseline: use the same cabin sampling separation as the mild shift-plus-lapse reference while keeping alpha(x)=1.",
});
const buildBaselineCabinObservables = (args: {
  brick: ReturnType<typeof buildGrEvolveBrick>;
  sampleSeparation_m: number;
}) => {
  const { brick, sampleSeparation_m } = args;
  const halfSeparation = Math.max(1e-6, sampleSeparation_m * 0.5);
  const centerPoint: Vector3 = [0, 0, 0];
  const topPoint: Vector3 = [0, 0, halfSeparation];
  const bottomPoint: Vector3 = [0, 0, -halfSeparation];
  const centerlineAlpha = sampleBrickChannelAtPoint(
    brick,
    "alpha",
    centerPoint,
  );
  const topAlpha = sampleBrickChannelAtPoint(brick, "alpha", topPoint);
  const bottomAlpha = sampleBrickChannelAtPoint(brick, "alpha", bottomPoint);
  const centerAccelGeom = sampleBrickChannelAtPoint(
    brick,
    "eulerian_accel_geom_mag",
    centerPoint,
  );
  const splitFraction =
    centerlineAlpha != null &&
    topAlpha != null &&
    bottomAlpha != null &&
    Math.abs(centerlineAlpha) > 1e-12
      ? Math.abs(topAlpha - bottomAlpha) / Math.abs(centerlineAlpha)
      : null;
  const accelFromSplit =
    topAlpha != null && bottomAlpha != null && topAlpha > 0 && bottomAlpha > 0
      ? Math.abs(Math.log(topAlpha) - Math.log(bottomAlpha)) /
        Math.max(1e-12, sampleSeparation_m)
      : null;
  const gravityGradientGeom = Math.max(
    Math.abs(centerAccelGeom ?? 0),
    Math.abs(accelFromSplit ?? 0),
  );
  return {
    valid:
      centerlineAlpha != null &&
      splitFraction != null &&
      Number.isFinite(gravityGradientGeom),
    centerline_alpha: centerlineAlpha,
    centerline_dtau_dt: centerlineAlpha,
    cabin_clock_split_fraction: splitFraction,
    cabin_clock_split_per_day_s:
      splitFraction != null ? splitFraction * SECONDS_PER_DAY : null,
    cabin_clock_split_per_year_s:
      splitFraction != null ? splitFraction * SECONDS_PER_YEAR : null,
    cabin_gravity_gradient_geom: gravityGradientGeom,
    cabin_gravity_gradient_si:
      gravityGradientGeom * SPEED_OF_LIGHT_MPS * SPEED_OF_LIGHT_MPS,
    cabinSampleAxis: "z_zenith",
    cabinSampleSeparation_m: sampleSeparation_m,
    cabinSamplePolicy: "comparison_aligned_symmetric_centerline_z",
    details: {
      source: "gr_evolve_brick_alpha",
      centerlineAlphaSource: "gr_evolve_brick_alpha",
      topBottomAlphaSource: "gr_evolve_brick_alpha",
      gravityGradientSource: "gr_evolve_brick_eulerian_accel",
      usedAnalyticLapseSamples: false,
      usedAnalyticGradientCompanion: false,
      samplePoints: {
        centerline: centerPoint,
        top_z_zenith: topPoint,
        bottom_z_zenith: bottomPoint,
      },
      sampleSeparation_m,
      cabinSampleAxis: "z_zenith",
      cabinSamplePolicy: "comparison_aligned_symmetric_centerline_z",
      rawBrickSamples: {
        centerline_alpha: centerlineAlpha,
        top_alpha: topAlpha,
        bottom_alpha: bottomAlpha,
        eulerian_accel_geom_centerline: centerAccelGeom,
      },
      formulas: {
        centerline_dtau_dt:
          "static cabin observer: dtau/dt = alpha(centerline)",
        cabin_clock_split_fraction:
          "|alpha_top - alpha_bottom| / alpha_centerline",
        cabin_gravity_gradient_geom:
          "max(eulerian_accel_geom_mag(centerline), |ln(alpha_top)-ln(alpha_bottom)| / delta_z)",
      },
    },
    missingFields: [],
  };
};
const buildGaugeSummary = (
  brick: ReturnType<typeof buildGrEvolveBrick>,
  lapseSummary: any,
) => {
  const ratioValues = Array.from(
    brick.channels.beta_over_alpha_mag?.data ?? [],
  );
  const betaX = brick.channels.beta_x?.data ?? new Float32Array();
  const betaY = brick.channels.beta_y?.data ?? new Float32Array();
  const betaZ = brick.channels.beta_z?.data ?? new Float32Array();
  const betaMagnitudes = Array.from(betaX, (_, index) =>
    Math.hypot(betaX[index] ?? 0, betaY[index] ?? 0, betaZ[index] ?? 0),
  );
  return {
    lapseMin:
      toFinite(lapseSummary?.alphaMin) ??
      toFinite(brick.channels.alpha?.min) ??
      null,
    lapseMax:
      toFinite(lapseSummary?.alphaMax) ??
      toFinite(brick.channels.alpha?.max) ??
      null,
    betaMaxAbs: betaMagnitudes.length > 0 ? Math.max(...betaMagnitudes) : null,
    betaOverAlphaMax: ratioValues.length > 0 ? Math.max(...ratioValues) : null,
    betaOverAlphaP98: percentile(ratioValues, 0.98),
    betaOutwardOverAlphaWallMax:
      toFinite(brick.stats.wallSafety?.betaOutwardOverAlphaWallMax) ?? null,
    betaOutwardOverAlphaWallP98:
      toFinite(brick.stats.wallSafety?.betaOutwardOverAlphaWallP98) ?? null,
    wallHorizonMargin:
      toFinite(brick.stats.wallSafety?.wallHorizonMargin) ?? null,
  };
};
const buildBaselineCase = async (sampleSeparation_m: number) => {
  let state = initializePipelineState();
  state = await updateParameters(
    state,
    {
      warpFieldType: PROMOTED_WARP_PROFILE.warpFieldType,
      dynamicConfig: {
        ...(state.dynamicConfig ?? {}),
        warpFieldType: PROMOTED_WARP_PROFILE.warpFieldType,
      },
      gammaGeo: PROMOTED_WARP_PROFILE.gammaGeo,
      gammaVanDenBroeck: PROMOTED_WARP_PROFILE.gammaVanDenBroeck,
      qSpoilingFactor: PROMOTED_WARP_PROFILE.qSpoilingFactor,
      qCavity: PROMOTED_WARP_PROFILE.qCavity,
      dutyCycle: PROMOTED_WARP_PROFILE.dutyCycle,
      dutyShip: PROMOTED_WARP_PROFILE.dutyShip,
      sectorCount: PROMOTED_WARP_PROFILE.sectorCount,
      gap_nm: PROMOTED_WARP_PROFILE.gap_nm,
    } as any,
    { includeReadinessSignals: true },
  );
  setGlobalPipelineState(state);
  const axes = resolveHullAxes(state);
  const bounds = buildReferenceBounds(axes);
  const brick = buildGrEvolveBrick({
    dims: [48, 48, 48],
    bounds,
    includeMatter: false,
    includeConstraints: false,
    includeKij: false,
    includeInvariants: false,
  });
  const serializedBrick = encodeBrickChannels(brick);
  const directCabin = computeCabinLapseDiagnosticsFromBrick(
    state,
    serializedBrick,
    axes,
  );
  const cabin = buildBaselineCabinObservables({ brick, sampleSeparation_m });
  const referenceCalibration =
    buildBaselineReferenceCalibration(sampleSeparation_m);
  const lapseSummary = {
    alphaCenterline: 1,
    alphaMin: 1,
    alphaMax: 1,
    alphaProfileKind: "unit",
    alphaGradientAxis: "z_zenith",
    alphaGradientVec_m_inv: [0, 0, 0] as Vector3,
    alphaInteriorSupportKind: "hull_interior",
    alphaWallTaper_m: null,
    diagnosticTier: "diagnostic",
    signConvention:
      "Unit-lapse comparison baseline: alpha(x)=1 everywhere; no lapse gradient is introduced on the baseline branch.",
    scenarioId: "unit_lapse_nhm2_baseline",
    referenceCalibration,
  };
  const gaugeSummary = buildGaugeSummary(brick, lapseSummary);
  return {
    caseId: "nhm2_unit_lapse_baseline",
    caseLabel: "Current Unit-Lapse NHM2 Baseline",
    scenarioId: "unit_lapse_nhm2_baseline",
    authoritativeStatus: "baseline_comparison_only",
    branch: {
      warpFieldType:
        state.warpFieldType ?? state.dynamicConfig?.warpFieldType ?? null,
      metricT00Ref: resolveMetricT00Ref(state),
      metricAdapterFamily:
        (state as any)?.warp?.metricAdapter?.family ??
        (state as any)?.natario?.metricAdapter?.family ??
        null,
      sourcePath: "warp.metric.T00.natario_sdf.shift",
    },
    alphaProfileMetadata: lapseSummary,
    precisionContext: {
      brickNumericType: "float32",
      companionNumericType: "none",
      mildLapseFidelityStatus: "brick_float32_direct",
      channelPrecisionPolicy: "brick_float32_direct",
      underResolutionDetected: false,
      preferredCompanionSource: "brick_float32_direct",
      wallSafetySource: "brick_float32_direct",
    },
    gaugeSummary,
    wallSafetySummary: {
      ...(brick.stats.wallSafety ?? {
        betaOutwardOverAlphaWallMax: null,
        betaOutwardOverAlphaWallP98: null,
        wallHorizonMargin: null,
      }),
      source: "brick_float32_direct",
    },
    cabinObservables: {
      ...cabin,
      comparisonCompanionNote:
        "Baseline cabin observables use the same 2.5 m comparison sampling separation as the mild generalized reference. Direct pipeline cabin diagnostics remain unchanged.",
      directPipelineCabinObservables: directCabin,
    },
  };
};
const computeDelta = (
  baselineValue: ComparedValue,
  generalizedValue: ComparedValue,
): ComparedValue => {
  if (
    Array.isArray(baselineValue) &&
    Array.isArray(generalizedValue) &&
    baselineValue.length >= 3 &&
    generalizedValue.length >= 3
  ) {
    return [
      Number(generalizedValue[0]) - Number(baselineValue[0]),
      Number(generalizedValue[1]) - Number(baselineValue[1]),
      Number(generalizedValue[2]) - Number(baselineValue[2]),
    ];
  }
  const baselineNumber = toFinite(baselineValue);
  const generalizedNumber = toFinite(generalizedValue);
  if (baselineNumber == null || generalizedNumber == null) return null;
  return generalizedNumber - baselineNumber;
};
const buildQuantityComparison = (args: {
  quantityId: string;
  label: string;
  units: string;
  baselineValue: ComparedValue;
  generalizedValue: ComparedValue;
  baselineSourceKind: SourceKind;
  generalizedSourceKind: SourceKind;
  quantityRole: "cabin_gravity" | "wall_safety" | "meta";
  note?: string;
}) => {
  const baselineSourceKind = args.baselineSourceKind;
  const generalizedSourceKind = args.generalizedSourceKind;
  return {
    quantityId: args.quantityId,
    label: args.label,
    baselineValue: args.baselineValue,
    generalizedValue: args.generalizedValue,
    delta: computeDelta(args.baselineValue, args.generalizedValue),
    units: args.units,
    baselineSourceKind,
    generalizedSourceKind,
    sourceKind: resolveSourceKindSummary(
      baselineSourceKind,
      generalizedSourceKind,
    ),
    crossCaseSourceMismatch: baselineSourceKind !== generalizedSourceKind,
    quantityRole: args.quantityRole,
    note: args.note ?? null,
  };
};
const buildComparisonMarkdownTable = (rows: any[]) => {
  const header =
    "| quantity | baseline | generalized | delta | units | baseline source | generalized source | mismatch |\n| --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = rows.map((row) => {
    const baseline = Array.isArray(row.baselineValue)
      ? `[${row.baselineValue.join(", ")}]`
      : `${row.baselineValue ?? "n/a"}`;
    const generalized = Array.isArray(row.generalizedValue)
      ? `[${row.generalizedValue.join(", ")}]`
      : `${row.generalizedValue ?? "n/a"}`;
    const delta = Array.isArray(row.delta)
      ? `[${row.delta.join(", ")}]`
      : `${row.delta ?? "n/a"}`;
    return `| ${row.quantityId} | ${baseline} | ${generalized} | ${delta} | ${row.units} | ${row.baselineSourceKind} | ${row.generalizedSourceKind} | ${row.crossCaseSourceMismatch ? "yes" : "no"} |`;
  });
  return [header, ...body].join("\n");
};
const buildAuditMarkdown = (payload: any) => {
  const cabinTable = buildComparisonMarkdownTable(
    payload.cabinGravityComparison.quantities,
  );
  const wallTable = buildComparisonMarkdownTable(
    payload.wallSafetyComparison.quantities,
  );
  const warnings =
    payload.provenanceWarnings.length > 0
      ? payload.provenanceWarnings
          .map(
            (warning: any) =>
              `- ${warning.quantityId}: ${warning.note} (${warning.baselineSourceKind} vs ${warning.generalizedSourceKind})`,
          )
          .join("\n")
      : "- none";
  return [
    "# NHM2 Shift-Plus-Lapse Comparison Companion",
    "",
    `- date: ${payload.date}`,
    `- comparisonId: ${payload.comparisonId}`,
    `- scenarioId: ${payload.scenarioId}`,
    `- LaneAStatus: ${payload.proofPolicy.laneAUnchanged ? "unchanged" : "changed"}`,
    `- baselineMetricSource: ${payload.baselineCase.branch.metricT00Ref}`,
    `- generalizedMetricSource: ${payload.generalizedCase.branch.metricT00Ref}`,
    `- comparisonPrecisionPolicy: ${payload.comparisonPrecisionPolicy.policyId}`,
    "",
    "## Precision Context",
    "",
    `- baselinePrecisionContext: ${JSON.stringify(payload.baselinePrecisionContext)}`,
    `- generalizedPrecisionContext: ${JSON.stringify(payload.generalizedPrecisionContext)}`,
    `- provenanceWarningsCount: ${payload.provenanceWarnings.length}`,
    "- nestedProvenanceNormalization: baseline directPipeline cabin observables now use unresolved_gravity_gradient when no analytic companion value is present.",
    "",
    "## Cabin Gravity Comparison",
    "",
    cabinTable,
    "",
    "## Wall Safety Comparison",
    "",
    wallTable,
    "",
    "## Proof Policy Comparison",
    "",
    `- authoritativeProofSurface: ${payload.proofPolicyComparison.authoritativeProofSurface}`,
    `- baselineBranchStatus: ${payload.proofPolicyComparison.baselineBranchStatus}`,
    `- generalizedBranchStatus: ${payload.proofPolicyComparison.generalizedBranchStatus}`,
    `- baselineFamilyAuthorityStatus: ${payload.proofPolicyComparison.baselineFamilyAuthorityStatus}`,
    `- generalizedFamilyAuthorityStatus: ${payload.proofPolicyComparison.generalizedFamilyAuthorityStatus}`,
    `- baselineTransportCertificationStatus: ${payload.proofPolicyComparison.baselineTransportCertificationStatus}`,
    `- generalizedTransportCertificationStatus: ${payload.proofPolicyComparison.generalizedTransportCertificationStatus}`,
    `- note: ${payload.proofPolicyComparison.note}`,
    "",
    "## Provenance Warnings",
    "",
    warnings,
    "",
    "## Comparison Summary",
    "",
    `- comparisonStatus: ${payload.comparisonSummary.comparisonStatus}`,
    `- crossCaseSourceMismatchCount: ${payload.comparisonSummary.crossCaseSourceMismatchCount}`,
    `- wallSafetySourceParity: ${payload.comparisonSummary.wallSafetySourceParity ? "yes" : "no"}`,
    `- cabinGravityUsesAnalyticCompanion: ${payload.comparisonSummary.cabinGravityUsesAnalyticCompanion ? "yes" : "no"}`,
    `- proofHierarchyUnchanged: ${payload.comparisonSummary.proofHierarchyUnchanged ? "yes" : "no"}`,
    "",
  ].join("\n");
};
const buildMemoMarkdown = (payload: any) => {
  const mismatchIds = payload.provenanceWarnings.map(
    (warning: any) => warning.quantityId,
  );
  return [
    "# NHM2 Shift-Plus-Lapse Comparison Memo",
    "",
    "This companion compares the current promoted unit-lapse NHM2 baseline against the calibrated mild nhm2_shift_lapse reference branch.",
    "",
    "It is a diagnostic comparison companion only:",
    "",
    "- Lane A remains authoritative and unchanged.",
    "- warp.metric.T00.nhm2.shift_lapse is a candidate authoritative solve family in provenance/model-selection; proof-bearing bounded transport admission remains separately controlled by the authoritative shift-lapse transport-promotion gate and is not claimed by this comparison surface.",
    "- Cabin gravity and wall safety are presented side by side but remain separate diagnostic families.",
    "- No route-time-compression claim is made.",
    "",
    "## What The Generalized Branch Adds",
    "",
    "- a nontrivial lapse profile alpha(x)",
    "- explicit cabin clock-split and gravity-gradient diagnostics",
    "- the ability to compare local lapse observables against wall-normal beta_outward/alpha safety without overloading York proof semantics",
    "",
    "## What Remains Unchanged",
    "",
    "- the unit-lapse NHM2 baseline branch",
    "- Lane A proof semantics",
    "- the requirement to keep wall safety brick-derived in this comparison",
    "",
    "## Precision Limits",
    "",
    "The mild generalized branch remains weak enough that some cabin-gravity quantities are published from the analytic lapse-summary companion rather than raw float32 brick channels.",
    "",
    `- precisionComparisonStatus: ${payload.precisionComparisonStatus}`,
    `- mismatchedQuantityIds: ${mismatchIds.length > 0 ? mismatchIds.join(", ") : "none"}`,
    `- wallSafetySourceParity: ${payload.comparisonSummary.wallSafetySourceParity ? "brick-aligned" : "mixed"}`,
    "",
    "Wall safety remains brick-derived in both cases. The source mismatches are confined to mild-reference lapse/cabin observables where the generalized branch intentionally prefers analytic companion reporting under float32 under-resolution.",
    "The nested baseline direct-pipeline cabin block is now normalized so unresolved gravity gradients are labeled unresolved rather than analytic fallback.",
    "",
    "## Deferred Work",
    "",
    "- stronger centerline lapse suppression",
    "- any proof-promotion of the generalized branch",
    "- any field-render or OptiX presentation companion for shift-plus-lapse diagnostics",
    "",
    `- comparisonStatus: ${payload.comparisonStatus}`,
    `- baselineBranchStatus: ${payload.baselineBranchStatus}`,
    `- generalizedBranchStatus: ${payload.generalizedBranchStatus}`,
    `- generalizedFamilyAuthorityStatus: ${payload.generalizedFamilyAuthorityStatus}`,
    `- generalizedTransportCertificationStatus: ${payload.generalizedTransportCertificationStatus}`,
    `- precisionComparisonStatus: ${payload.precisionComparisonStatus}`,
    `- recommendedNextAction: ${payload.recommendedNextAction}`,
    "",
  ].join("\n");
};
export const buildShiftPlusLapseComparisonPayload = async () => {
  const generalized = await buildShiftPlusLapseDiagnosticsPayload();
  const baseline = await buildBaselineCase(
    generalized.referenceCalibration?.targetCabinHeight_m ?? 2.5,
  );
  const baselineSemantics = deriveWarpMetricFamilySemantics("natario_sdf");
  const generalizedSemantics = deriveWarpMetricFamilySemantics("nhm2_shift_lapse");
  const baselineAlphaGradient =
    (baseline.alphaProfileMetadata?.alphaGradientVec_m_inv as
      | Vector3
      | undefined) ?? ([0, 0, 0] as Vector3);
  const generalizedAlphaGradient =
    (generalized.alphaProfileMetadata?.alphaGradientVec_m_inv as
      | Vector3
      | undefined) ?? ([0, 0, 0] as Vector3);
  const cabinGravityComparison = {
    sectionRole: "diagnostic_comparison",
    note: "Cabin gravity observables are local lapse diagnostics. They are not a proof surface and they are not interchangeable with wall-normal horizon safety.",
    quantities: [
      buildQuantityComparison({
        quantityId: "alphaCenterline",
        label: "Centerline Lapse",
        units: "dimensionless",
        baselineValue: baseline.alphaProfileMetadata.alphaCenterline,
        generalizedValue:
          generalized.alphaProfileMetadata?.alphaCenterline ?? null,
        baselineSourceKind: "brick_float32_direct",
        generalizedSourceKind: mapDiagnosticSourceKind(
          generalized.cabinObservables?.details?.centerlineAlphaSource,
          "brick_float32_direct",
        ),
        quantityRole: "cabin_gravity",
      }),
      buildQuantityComparison({
        quantityId: "alphaGradientVec_m_inv",
        label: "Lapse Gradient Vector",
        units: "1/m",
        baselineValue: baselineAlphaGradient,
        generalizedValue: generalizedAlphaGradient,
        baselineSourceKind: "brick_float32_direct",
        generalizedSourceKind: "analytic_lapse_summary_companion",
        quantityRole: "cabin_gravity",
        note: "Generalized mild-reference gradient is carried from the explicit calibrated lapse summary rather than inferred from under-resolved float32 brick channels.",
      }),
      buildQuantityComparison({
        quantityId: "centerline_dtau_dt",
        label: "Centerline dtau/dt",
        units: "dimensionless",
        baselineValue: baseline.cabinObservables.centerline_dtau_dt,
        generalizedValue:
          generalized.cabinObservables?.centerline_dtau_dt ?? null,
        baselineSourceKind: "brick_float32_direct",
        generalizedSourceKind: mapDiagnosticSourceKind(
          generalized.cabinObservables?.details?.centerlineAlphaSource,
          "brick_float32_direct",
        ),
        quantityRole: "cabin_gravity",
      }),
      buildQuantityComparison({
        quantityId: "cabin_clock_split_fraction",
        label: "Cabin Clock Split Fraction",
        units: "dimensionless",
        baselineValue: baseline.cabinObservables.cabin_clock_split_fraction,
        generalizedValue:
          generalized.cabinObservables?.cabin_clock_split_fraction ?? null,
        baselineSourceKind: "brick_float32_direct",
        generalizedSourceKind: mapDiagnosticSourceKind(
          generalized.cabinObservables?.details?.topBottomAlphaSource,
          "analytic_lapse_summary_companion",
        ),
        quantityRole: "cabin_gravity",
      }),
      buildQuantityComparison({
        quantityId: "cabin_clock_split_per_day_s",
        label: "Cabin Clock Split Per Day",
        units: "s/day",
        baselineValue: baseline.cabinObservables.cabin_clock_split_per_day_s,
        generalizedValue:
          generalized.cabinObservables?.cabin_clock_split_per_day_s ?? null,
        baselineSourceKind: "brick_float32_direct",
        generalizedSourceKind: mapDiagnosticSourceKind(
          generalized.cabinObservables?.details?.topBottomAlphaSource,
          "analytic_lapse_summary_companion",
        ),
        quantityRole: "cabin_gravity",
      }),
      buildQuantityComparison({
        quantityId: "cabin_gravity_gradient_geom",
        label: "Cabin Gravity Gradient",
        units: "1/m",
        baselineValue: baseline.cabinObservables.cabin_gravity_gradient_geom,
        generalizedValue:
          generalized.cabinObservables?.cabin_gravity_gradient_geom ?? null,
        baselineSourceKind: "brick_float32_direct",
        generalizedSourceKind: mapDiagnosticSourceKind(
          generalized.cabinObservables?.details?.gravityGradientSource,
          "analytic_lapse_summary_companion",
        ),
        quantityRole: "cabin_gravity",
      }),
      buildQuantityComparison({
        quantityId: "cabin_gravity_gradient_si",
        label: "Cabin Gravity Gradient (SI)",
        units: "m/s^2",
        baselineValue: baseline.cabinObservables.cabin_gravity_gradient_si,
        generalizedValue:
          generalized.cabinObservables?.cabin_gravity_gradient_si ?? null,
        baselineSourceKind: "brick_float32_direct",
        generalizedSourceKind: mapDiagnosticSourceKind(
          generalized.cabinObservables?.details?.gravityGradientSource,
          "analytic_lapse_summary_companion",
        ),
        quantityRole: "cabin_gravity",
      }),
    ],
  };
  const wallSafetyComparison = {
    sectionRole: "diagnostic_comparison",
    note: "Wall safety remains a combined shift/lapse horizon proxy. It stays brick-derived in both cases and is not a comfort metric.",
    quantities: [
      buildQuantityComparison({
        quantityId: "betaOverAlphaMax",
        label: "Bulk |beta|/alpha Max",
        units: "dimensionless",
        baselineValue: baseline.gaugeSummary.betaOverAlphaMax,
        generalizedValue: generalized.gaugeSummary?.betaOverAlphaMax ?? null,
        baselineSourceKind: "brick_float32_direct",
        generalizedSourceKind: "brick_float32_direct",
        quantityRole: "wall_safety",
      }),
      buildQuantityComparison({
        quantityId: "betaOutwardOverAlphaWallMax",
        label: "Wall-Normal beta_outward/alpha Max",
        units: "dimensionless",
        baselineValue: baseline.wallSafetySummary.betaOutwardOverAlphaWallMax,
        generalizedValue:
          generalized.wallSafetySummary?.betaOutwardOverAlphaWallMax ?? null,
        baselineSourceKind: "brick_float32_direct",
        generalizedSourceKind: mapDiagnosticSourceKind(
          generalized.wallSafetySummary?.source,
          "brick_float32_direct",
        ),
        quantityRole: "wall_safety",
      }),
      buildQuantityComparison({
        quantityId: "wallHorizonMargin",
        label: "Wall Horizon Margin",
        units: "dimensionless",
        baselineValue: baseline.wallSafetySummary.wallHorizonMargin,
        generalizedValue:
          generalized.wallSafetySummary?.wallHorizonMargin ?? null,
        baselineSourceKind: "brick_float32_direct",
        generalizedSourceKind: mapDiagnosticSourceKind(
          generalized.wallSafetySummary?.source,
          "brick_float32_direct",
        ),
        quantityRole: "wall_safety",
      }),
    ],
  };
  const proofPolicyComparison = {
    authoritativeProofSurface:
      generalized.proofPolicy?.authoritativeProofSurface ??
      "lane_a_eulerian_comoving_theta_minus_trk",
    baselineBranchStatus: "unit_lapse_baseline_unchanged",
    generalizedBranchStatus:
      "candidate_authoritative_family_transport_gate_controlled_not_claimed_here",
    baselineFamilyAuthorityStatus: baselineSemantics.familyAuthorityStatus,
    generalizedFamilyAuthorityStatus: generalizedSemantics.familyAuthorityStatus,
    baselineTransportCertificationStatus:
      baselineSemantics.transportCertificationStatus,
    generalizedTransportCertificationStatus:
      generalizedSemantics.transportCertificationStatus,
    laneAUnchanged: generalized.proofPolicy?.laneAUnchanged === true,
    note: "This comparison companion does not supersede York proof semantics. It compares a candidate authoritative solve family in provenance/model-selection against the current bounded baseline while treating proof-bearing bounded transport admission for the generalized family as separately controlled by the authoritative shift-lapse transport-promotion gate, not claimed by this comparison surface.",
  };
  const allQuantities = [
    ...cabinGravityComparison.quantities,
    ...wallSafetyComparison.quantities,
  ];
  const provenanceWarnings = allQuantities
    .filter((quantity) => quantity.crossCaseSourceMismatch)
    .map((quantity) => ({
      quantityId: quantity.quantityId,
      baselineSourceKind: quantity.baselineSourceKind,
      generalizedSourceKind: quantity.generalizedSourceKind,
      note:
        quantity.quantityRole === "cabin_gravity"
          ? "Cross-case comparison mixes raw brick baseline values with analytic-companion mild-reference values. Interpret as conceptually aligned but not identical numeric pipelines."
          : "Cross-case source mismatch detected.",
    }));
  return {
    artifactId: "nhm2_shift_plus_lapse_comparison",
    capturedAt: new Date().toISOString(),
    date: DATE_STAMP,
    comparisonId: "nhm2_unit_lapse_vs_mild_shift_plus_lapse",
    comparisonStatus: "available",
    baselineBranchStatus: "unit_lapse_baseline_unchanged",
    generalizedBranchStatus:
      "candidate_authoritative_family_transport_gate_controlled_not_claimed_here",
    baselineFamilyAuthorityStatus: baselineSemantics.familyAuthorityStatus,
    generalizedFamilyAuthorityStatus: generalizedSemantics.familyAuthorityStatus,
    baselineTransportCertificationStatus:
      baselineSemantics.transportCertificationStatus,
    generalizedTransportCertificationStatus:
      generalizedSemantics.transportCertificationStatus,
    precisionComparisonStatus:
      provenanceWarnings.length > 0
        ? "mixed_source_comparison_explicit"
        : "raw_source_aligned",
    recommendedNextAction:
      "Profile-graph presentation companions must keep per-quantity raw-vs-analytic badges visible, keep cabin gravity separate from wall safety, and avoid any field-map presentation that overstates mild-branch raw resolution.",
    scenarioId: generalized.scenarioId,
    baselineCase: {
      ...baseline,
      familyAuthorityStatus: baselineSemantics.familyAuthorityStatus,
      transportCertificationStatus:
        baselineSemantics.transportCertificationStatus,
      familySemanticsNote: baselineSemantics.semanticsNote,
    },
    generalizedCase: {
      caseId: "nhm2_shift_plus_lapse_mild_reference",
      caseLabel: "Mild Shift-Plus-Lapse Reference",
      scenarioId: generalized.scenarioId,
      authoritativeStatus: generalizedSemantics.familyAuthorityStatus,
      diagnosticContractAuthoritativeStatus:
        generalized.contract?.authoritativeStatus ?? "reference_only",
      familyAuthorityStatus: generalizedSemantics.familyAuthorityStatus,
      transportCertificationStatus:
        generalizedSemantics.transportCertificationStatus,
      familySemanticsNote: generalizedSemantics.semanticsNote,
      branch: generalized.branch,
      alphaProfileMetadata: generalized.alphaProfileMetadata,
      precisionContext: generalized.precisionContext,
      gaugeSummary: generalized.gaugeSummary,
      wallSafetySummary: generalized.wallSafetySummary,
      cabinObservables: generalized.cabinObservables,
    },
    baselinePrecisionContext: baseline.precisionContext,
    generalizedPrecisionContext: generalized.precisionContext,
    precisionPolicy: {
      policyId: "nhm2_shift_plus_lapse_comparison_precision_v1",
      rule: "Preserve per-quantity source provenance and flag cross-case source mismatches rather than flattening analytic companion values into unlabeled comparison rows.",
    },
    comparisonPrecisionPolicy: {
      policyId: "nhm2_shift_plus_lapse_comparison_precision_v1",
      sourceKindEnum: [
        "brick_float32_direct",
        "analytic_lapse_summary_companion",
        "mixed_source_prefer_analytic_for_underflow",
      ],
      crossCaseMismatchPolicy:
        "When baseline and generalized source kinds differ, emit crossCaseSourceMismatch=true and add a provenance warning.",
    },
    provenanceWarnings,
    comparisonSummary: {
      comparisonStatus: "available",
      quantitiesCompared: allQuantities.length,
      crossCaseSourceMismatchCount: provenanceWarnings.length,
      wallSafetySourceParity: wallSafetyComparison.quantities.every(
        (quantity) => quantity.crossCaseSourceMismatch === false,
      ),
      cabinGravityUsesAnalyticCompanion: cabinGravityComparison.quantities.some(
        (quantity) =>
          quantity.generalizedSourceKind === "analytic_lapse_summary_companion",
      ),
      proofHierarchyUnchanged: proofPolicyComparison.laneAUnchanged,
    },
    cabinGravityComparison,
    wallSafetyComparison,
    proofPolicyComparison,
    proofPolicy: {
      authoritativeProofSurface:
        generalized.proofPolicy?.authoritativeProofSurface ??
        "lane_a_eulerian_comoving_theta_minus_trk",
      laneAUnchanged: generalized.proofPolicy?.laneAUnchanged === true,
      disclaimer: [
        "Lane A remains authoritative.",
        "nhm2_shift_lapse is a candidate authoritative solve family in provenance/model-selection.",
        "Proof-bearing bounded transport admission for nhm2_shift_lapse remains separately controlled by the authoritative shift-lapse transport-promotion gate and is not claimed by this comparison.",
        "This comparison companion does not supersede York proof semantics.",
        "Cabin gravity and wall safety are analysis diagnostics, not proof promotion.",
        "No route-time-compression claim is made.",
      ],
    },
  };
};
export const writeShiftPlusLapseComparisonArtifacts = (payload: any) => {
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_AUDIT), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_MEMO), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.writeFileSync(OUT_AUDIT, buildAuditMarkdown(payload), "utf8");
  fs.writeFileSync(OUT_MEMO, buildMemoMarkdown(payload), "utf8");
};
const run = async () => {
  const payload = await buildShiftPlusLapseComparisonPayload();
  writeShiftPlusLapseComparisonArtifacts(payload);
  process.stdout.write(
    `${JSON.stringify({ ok: true, outJson: OUT_JSON, outAudit: OUT_AUDIT, outMemo: OUT_MEMO }, null, 2)}\n`,
  );
};
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
