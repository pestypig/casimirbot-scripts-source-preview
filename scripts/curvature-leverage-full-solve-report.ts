import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildNhm2FullSolveCurvatureLeverage,
  type NHM2FullSolveCurvatureLeverage,
  type Nhm2CurvatureLeverageRegion,
  type Nhm2EvidenceStatus,
} from "../shared/curvature-leverage";
import { kappa_u } from "../shared/curvature-proxy";

const DEFAULT_METRIC_REQUIRED_PATH =
  "artifacts/research/full-solve/selected-family/nhm2-shift-lapse/nhm2-source-closure-metric-required-tensor-latest.json";
const DEFAULT_REGIONAL_EVIDENCE_PATH =
  "artifacts/research/full-solve/reference/nhm2-reference-ledger-2026-05-05-v1/nhm2-regional-source-closure-evidence.json";
const DEFAULT_OUT_PATH =
  "artifacts/research/full-solve/curvature-leverage/nhm2-curvature-leverage-latest.json";

const REGION_IDS: Nhm2CurvatureLeverageRegion[] = ["global", "hull", "wall", "exterior_shell"];
const DEFAULT_REGION_LEVER_LENGTHS_M: Record<Nhm2CurvatureLeverageRegion, number> = {
  global: 1_200,
  hull: 1_200,
  wall: 1_200,
  exterior_shell: 1_200,
};

type TensorComponents = Partial<Record<"T00" | "T11" | "T22" | "T33", number | null>>;

type RegionalEvidenceRegion = {
  regionId?: string | null;
  status?: string | null;
  comparisonBasisStatus?: string | null;
  metricRequired?: {
    tensorRef?: string | null;
    tensor?: TensorComponents | null;
    unitsRef?: string | null;
  } | null;
  tileEffectiveCounterpart?: {
    tensorRef?: string | null;
  } | null;
  residuals?: {
    relLInf?: number | null;
  } | null;
  blockers?: string[] | null;
};

export type Nhm2CurvatureLeverageReportRegion = NHM2FullSolveCurvatureLeverage & {
  tensorNormInput: number;
  tensorNormInputUnits: string;
  tensorNormRoute: "energy_density_to_kappa_u" | "geometric_tensor_norm";
  sourceRegionStatus: string;
  comparisonBasisStatus: string;
  blockers: string[];
};

export type Nhm2CurvatureLeverageReport = {
  artifactId: "nhm2_curvature_leverage_report";
  schemaVersion: "v1";
  generatedAt: string;
  source: {
    metricRequiredTensorRef: string;
    regionalEvidenceRef: string | null;
    claimRoute: "full_solve_tensor_required_only";
    leverLengthSource: "defaults_cli_overridable";
  };
  equationRefs: string[];
  claimIds: string[];
  promotionAllowed: false;
  regions: Nhm2CurvatureLeverageReportRegion[];
  forbiddenClaims: string[];
};

export type BuildNhm2CurvatureLeverageReportOptions = {
  metricRequiredPath?: string;
  regionalEvidencePath?: string;
  leverLengths?: Partial<Record<Nhm2CurvatureLeverageRegion, number>>;
  qeiStatus?: Nhm2EvidenceStatus;
  conservationStatus?: Nhm2EvidenceStatus;
  generatedAt?: string;
};

export type WriteNhm2CurvatureLeverageReportOptions = BuildNhm2CurvatureLeverageReportOptions & {
  outPath?: string;
};

export function buildNhm2CurvatureLeverageReport(
  options: BuildNhm2CurvatureLeverageReportOptions = {},
): Nhm2CurvatureLeverageReport {
  const metricRequiredPath = normalizeRepoPath(options.metricRequiredPath ?? DEFAULT_METRIC_REQUIRED_PATH);
  const regionalEvidencePath = normalizeRepoPath(options.regionalEvidencePath ?? DEFAULT_REGIONAL_EVIDENCE_PATH);
  const leverLengths = { ...DEFAULT_REGION_LEVER_LENGTHS_M, ...(options.leverLengths ?? {}) };
  const qeiStatus = options.qeiStatus ?? "missing";
  const conservationStatus = options.conservationStatus ?? "missing";

  const regions = loadRegions(metricRequiredPath, regionalEvidencePath).map((region) =>
    buildRegionLeverage({
      region,
      fallbackMetricRequiredPath: metricRequiredPath,
      leverLength_m: leverLengths[toRegionId(region.regionId)],
      qeiStatus,
      conservationStatus,
    }),
  );

  return {
    artifactId: "nhm2_curvature_leverage_report",
    schemaVersion: "v1",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    source: {
      metricRequiredTensorRef: metricRequiredPath,
      regionalEvidenceRef: fs.existsSync(regionalEvidencePath) ? regionalEvidencePath : null,
      claimRoute: "full_solve_tensor_required_only",
      leverLengthSource: "defaults_cli_overridable",
    },
    equationRefs: [
      "curvature_leverage_scale_normalization",
      "nhm2_full_solve_regional_tensor_leverage",
    ],
    claimIds: [
      "claim:curvature.leverage:scale_normalized_dimensionless",
      "claim:curvature.leverage:nhm2_full_solve_tensor_precedence",
    ],
    promotionAllowed: false,
    regions,
    forbiddenClaims: [
      "does not validate NHM2",
      "does not certify source closure",
      "does not promote physical mechanism",
      "does not import external gravitational observables as proof",
    ],
  };
}

export function writeNhm2CurvatureLeverageReport(
  options: WriteNhm2CurvatureLeverageReportOptions = {},
): Nhm2CurvatureLeverageReport {
  const outPath = normalizeRepoPath(options.outPath ?? DEFAULT_OUT_PATH);
  const report = buildNhm2CurvatureLeverageReport(options);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function buildRegionLeverage(args: {
  region: RegionalEvidenceRegion;
  fallbackMetricRequiredPath: string;
  leverLength_m: number;
  qeiStatus: Nhm2EvidenceStatus;
  conservationStatus: Nhm2EvidenceStatus;
}): Nhm2CurvatureLeverageReportRegion {
  const region = toRegionId(args.region.regionId);
  const tensor = args.region.metricRequired?.tensor ?? {};
  const inputNorm = tensorLInfNorm(tensor);
  const inputUnits = args.region.metricRequired?.unitsRef ?? "unknown";
  const converted = tensorNormToCurvatureNorm(inputNorm, inputUnits);
  const base = buildNhm2FullSolveCurvatureLeverage({
    metricRequiredTensorRef:
      asText(args.region.metricRequired?.tensorRef) ?? args.fallbackMetricRequiredPath,
    tileEffectiveTensorRef: asText(args.region.tileEffectiveCounterpart?.tensorRef) ?? undefined,
    region,
    leverLength_m: args.leverLength_m,
    tensorNorm_m2: converted.tensorNorm_m2,
    residualRelLInf: finiteOrUndefined(args.region.residuals?.relLInf),
    observerClosureStatus: closureStatus(args.region.status),
    qeiStatus: args.qeiStatus,
    conservationStatus: args.conservationStatus,
  });

  return {
    ...base,
    tensorNormInput: inputNorm,
    tensorNormInputUnits: inputUnits,
    tensorNormRoute: converted.tensorNormRoute,
    sourceRegionStatus: asText(args.region.status) ?? "unknown",
    comparisonBasisStatus: asText(args.region.comparisonBasisStatus) ?? "unknown",
    blockers: Array.isArray(args.region.blockers) ? args.region.blockers.filter(isText) : [],
  };
}

function loadRegions(metricRequiredPath: string, regionalEvidencePath: string): RegionalEvidenceRegion[] {
  if (fs.existsSync(regionalEvidencePath)) {
    const evidence = readJson<{ regions?: RegionalEvidenceRegion[] }>(regionalEvidencePath);
    if (Array.isArray(evidence.regions) && evidence.regions.length > 0) {
      return evidence.regions;
    }
  }

  const metric = readJson<{
    regionId?: string | null;
    diagonalTensor?: TensorComponents | null;
  }>(metricRequiredPath);
  return [
    {
      regionId: metric.regionId ?? "global",
      status: "review",
      comparisonBasisStatus: "unknown",
      metricRequired: {
        tensorRef: metricRequiredPath,
        tensor: metric.diagonalTensor ?? {},
        unitsRef: "J/m^3",
      },
      tileEffectiveCounterpart: null,
      residuals: null,
      blockers: ["regional_evidence_missing"],
    },
  ];
}

function tensorLInfNorm(tensor: TensorComponents): number {
  const values = ["T00", "T11", "T22", "T33"]
    .map((key) => Number(tensor[key as keyof TensorComponents]))
    .filter(Number.isFinite);
  if (values.length === 0) return 0;
  return Math.max(...values.map((value) => Math.abs(value)));
}

function tensorNormToCurvatureNorm(
  inputNorm: number,
  unitsRef: string,
): Pick<Nhm2CurvatureLeverageReportRegion, "tensorNorm_m2" | "tensorNormRoute"> {
  const units = unitsRef.trim().toLowerCase();
  if (units === "geometric_units" || units === "1/m^2" || units === "m^-2") {
    return { tensorNorm_m2: inputNorm, tensorNormRoute: "geometric_tensor_norm" };
  }
  return { tensorNorm_m2: kappa_u(inputNorm), tensorNormRoute: "energy_density_to_kappa_u" };
}

function closureStatus(value: unknown): "pass" | "review" | "fail" {
  const text = asText(value);
  if (text === "pass") return "pass";
  if (text === "fail") return "fail";
  return "review";
}

function toRegionId(value: unknown): Nhm2CurvatureLeverageRegion {
  const text = asText(value);
  if (text && REGION_IDS.includes(text as Nhm2CurvatureLeverageRegion)) {
    return text as Nhm2CurvatureLeverageRegion;
  }
  return "global";
}

function finiteOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asText(value: unknown): string | null {
  return isText(value) ? value.trim() : null;
}

function normalizeRepoPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function readJson<T>(pathname: string): T {
  return JSON.parse(fs.readFileSync(pathname, "utf8")) as T;
}

function parseArgs(argv: string[]): WriteNhm2CurvatureLeverageReportOptions {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  return {
    metricRequiredPath: get("metric-required"),
    regionalEvidencePath: get("regional-evidence"),
    outPath: get("out"),
    leverLengths: parseLeverLengths(argv),
    qeiStatus: parseEvidenceStatus(get("qei-status")),
    conservationStatus: parseEvidenceStatus(get("conservation-status")),
  };
}

function parseLeverLengths(argv: string[]): Partial<Record<Nhm2CurvatureLeverageRegion, number>> {
  const out: Partial<Record<Nhm2CurvatureLeverageRegion, number>> = {};
  for (const region of REGION_IDS) {
    const index = argv.indexOf(`--${region}-lever-length-m`);
    if (index >= 0) {
      const n = Number(argv[index + 1]);
      if (Number.isFinite(n) && n > 0) out[region] = n;
    }
  }

  const listIndex = argv.indexOf("--lever-length");
  if (listIndex >= 0) {
    for (const part of String(argv[listIndex + 1] ?? "").split(",")) {
      const [regionRaw, valueRaw] = part.split("=");
      const region = toRegionId(regionRaw);
      const n = Number(valueRaw);
      if (Number.isFinite(n) && n > 0) out[region] = n;
    }
  }
  return out;
}

function parseEvidenceStatus(value: string | undefined): Nhm2EvidenceStatus | undefined {
  if (value === "present" || value === "missing" || value === "fail") return value;
  return undefined;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const report = writeNhm2CurvatureLeverageReport(args);
  console.log(
    JSON.stringify(
      {
        ok: true,
        out: normalizeRepoPath(args.outPath ?? DEFAULT_OUT_PATH),
        regions: report.regions.length,
        promotionAllowed: report.promotionAllowed,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
