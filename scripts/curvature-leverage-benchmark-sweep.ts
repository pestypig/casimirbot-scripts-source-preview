import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CONSTANTS_PATH = "configs/constants/codata-2022.v1.json";
const DEFAULT_NHM2_REPORT_PATH =
  "artifacts/research/full-solve/curvature-leverage/nhm2-curvature-leverage-latest.json";
const DEFAULT_OUT_DIR = "artifacts/research/curvature-leverage/sweeps";

const GAP_SWEEP_M = [1e-10, 1e-9, 1e-8, 1e-7] as const;
const LEVER_LENGTH_SWEEP_M = [10, 100, 1000, 10000] as const;
const FIXED_CASIMIR_GAP_M = 1e-9;

type ConstantValue = {
  value: number;
};

type ConstantsConfig = {
  constants: Record<string, ConstantValue>;
};

type CoreConstants = {
  c: number;
  G: number;
  hbar: number;
};

type Nhm2Region = {
  region?: string;
  tensorNorm_m2?: number;
  leverLength_m?: number;
  leverage?: number;
  promotionAllowed?: boolean;
};

type Nhm2Report = {
  regions?: Nhm2Region[];
};

export type CasimirSweepSample = {
  gap_m: number;
  leverLength_m: number;
  leverage: number;
  log10Leverage: number;
  promotionAllowed: false;
};

export type Nhm2RegionSweepSample = {
  region: string;
  leverLength_m: number;
  tensorNorm_m2: number;
  leverage: number;
  log10Leverage: number;
  promotionAllowed: false;
};

export type CurvatureLeverageSweepArtifact<TSample> = {
  artifactId:
    | "curvature_leverage_gap_scale_sweep"
    | "curvature_leverage_lever_length_sweep"
    | "curvature_leverage_nhm2_region_scale_sweep";
  schemaVersion: "v1";
  generatedAt: string;
  source: {
    constantsRef: string;
    nhm2ReportRef?: string | null;
    claimRoute: "cross_scale_diagnostic_only";
  };
  sweep: {
    variable: "casimir_gap_m" | "leverLength_m" | "nhm2_region_leverLength_m";
    fixed: Record<string, number | string>;
    expectedLogLogSlope: number | null;
  };
  promotionAllowed: false;
  samples: TSample[];
};

export type CurvatureLeverageBenchmarkSweep = {
  gapScaleSweep: CurvatureLeverageSweepArtifact<CasimirSweepSample>;
  leverLengthSweep: CurvatureLeverageSweepArtifact<CasimirSweepSample>;
  nhm2RegionScaleSweep: CurvatureLeverageSweepArtifact<Nhm2RegionSweepSample>;
};

export type BuildBenchmarkSweepOptions = {
  constantsPath?: string;
  nhm2ReportPath?: string;
  generatedAt?: string;
};

export type WriteBenchmarkSweepOptions = BuildBenchmarkSweepOptions & {
  outDir?: string;
};

export function buildCurvatureLeverageBenchmarkSweep(
  options: BuildBenchmarkSweepOptions = {},
): CurvatureLeverageBenchmarkSweep {
  const constantsPath = normalizeRepoPath(options.constantsPath ?? DEFAULT_CONSTANTS_PATH);
  const nhm2ReportPath = normalizeRepoPath(options.nhm2ReportPath ?? DEFAULT_NHM2_REPORT_PATH);
  const core = coreConstants(readJson<ConstantsConfig>(constantsPath));
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const nhm2Report = fs.existsSync(nhm2ReportPath) ? readJson<Nhm2Report>(nhm2ReportPath) : null;

  return {
    gapScaleSweep: {
      artifactId: "curvature_leverage_gap_scale_sweep",
      schemaVersion: "v1",
      generatedAt,
      source: {
        constantsRef: constantsPath,
        claimRoute: "cross_scale_diagnostic_only",
      },
      sweep: {
        variable: "casimir_gap_m",
        fixed: { leverLength_m: 1000, model: "ideal_parallel_plate_raw_casimir" },
        expectedLogLogSlope: -4,
      },
      promotionAllowed: false,
      samples: GAP_SWEEP_M.map((gap_m) => casimirSample(core, gap_m, 1000)),
    },
    leverLengthSweep: {
      artifactId: "curvature_leverage_lever_length_sweep",
      schemaVersion: "v1",
      generatedAt,
      source: {
        constantsRef: constantsPath,
        claimRoute: "cross_scale_diagnostic_only",
      },
      sweep: {
        variable: "leverLength_m",
        fixed: { gap_m: FIXED_CASIMIR_GAP_M, model: "ideal_parallel_plate_raw_casimir" },
        expectedLogLogSlope: 2,
      },
      promotionAllowed: false,
      samples: LEVER_LENGTH_SWEEP_M.map((leverLength_m) =>
        casimirSample(core, FIXED_CASIMIR_GAP_M, leverLength_m),
      ),
    },
    nhm2RegionScaleSweep: {
      artifactId: "curvature_leverage_nhm2_region_scale_sweep",
      schemaVersion: "v1",
      generatedAt,
      source: {
        constantsRef: constantsPath,
        nhm2ReportRef: nhm2Report ? nhm2ReportPath : null,
        claimRoute: "cross_scale_diagnostic_only",
      },
      sweep: {
        variable: "nhm2_region_leverLength_m",
        fixed: { source: "tensorNorm_m2 from NHM2 full-solve report" },
        expectedLogLogSlope: 2,
      },
      promotionAllowed: false,
      samples: nhm2RegionSamples(nhm2Report),
    },
  };
}

export function writeCurvatureLeverageBenchmarkSweep(
  options: WriteBenchmarkSweepOptions = {},
): CurvatureLeverageBenchmarkSweep {
  const outDir = normalizeRepoPath(options.outDir ?? DEFAULT_OUT_DIR);
  const sweep = buildCurvatureLeverageBenchmarkSweep(options);
  fs.mkdirSync(outDir, { recursive: true });
  writeJson(path.join(outDir, "gap-scale-sweep-latest.json"), sweep.gapScaleSweep);
  writeJson(path.join(outDir, "lever-length-sweep-latest.json"), sweep.leverLengthSweep);
  writeJson(path.join(outDir, "nhm2-region-scale-sweep-latest.json"), sweep.nhm2RegionScaleSweep);
  return sweep;
}

function casimirSample(
  core: CoreConstants,
  gap_m: number,
  leverLength_m: number,
): CasimirSweepSample {
  const energyPerAreaAbs = (Math.PI * Math.PI * core.hbar * core.c) / (720 * gap_m ** 3);
  const energyDensityAbs = energyPerAreaAbs / gap_m;
  const kappa = ((8 * Math.PI * core.G) / core.c ** 4) * energyDensityAbs;
  const leverage = Math.abs(kappa) * leverLength_m * leverLength_m;
  return {
    gap_m,
    leverLength_m,
    leverage,
    log10Leverage: Math.log10(leverage),
    promotionAllowed: false,
  };
}

function nhm2RegionSamples(report: Nhm2Report | null): Nhm2RegionSweepSample[] {
  if (!report) return [];
  return (report.regions ?? []).flatMap((region) => {
    const tensorNorm = tensorNormForRegion(region);
    if (!Number.isFinite(tensorNorm) || tensorNorm <= 0) return [];
    const regionId = textOr(region.region, "unknown");
    return LEVER_LENGTH_SWEEP_M.map((leverLength_m) => {
      const leverage = tensorNorm * leverLength_m * leverLength_m;
      return {
        region: regionId,
        leverLength_m,
        tensorNorm_m2: tensorNorm,
        leverage,
        log10Leverage: Math.log10(leverage),
        promotionAllowed: false,
      };
    });
  });
}

function tensorNormForRegion(region: Nhm2Region): number {
  const tensorNorm = Number(region.tensorNorm_m2);
  if (Number.isFinite(tensorNorm) && tensorNorm > 0) return tensorNorm;
  const leverage = Number(region.leverage);
  const leverLength = Number(region.leverLength_m);
  if (Number.isFinite(leverage) && leverage > 0 && Number.isFinite(leverLength) && leverLength > 0) {
    return leverage / (leverLength * leverLength);
  }
  return Number.NaN;
}

function coreConstants(config: ConstantsConfig): CoreConstants {
  return {
    c: constantValue(config, "c_m_s"),
    G: constantValue(config, "G_m3_kg_s2"),
    hbar: constantValue(config, "hbar_J_s"),
  };
}

function constantValue(config: ConstantsConfig, key: string): number {
  const value = Number(config.constants[key]?.value);
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${key} must be positive and finite`);
  }
  return value;
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizeRepoPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function readJson<T>(pathname: string): T {
  return JSON.parse(fs.readFileSync(pathname, "utf8")) as T;
}

function writeJson(pathname: string, value: unknown): void {
  fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseArgs(argv: string[]): WriteBenchmarkSweepOptions {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  return {
    constantsPath: get("constants"),
    nhm2ReportPath: get("nhm2-report"),
    outDir: get("out-dir"),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const sweep = writeCurvatureLeverageBenchmarkSweep(args);
  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir: normalizeRepoPath(args.outDir ?? DEFAULT_OUT_DIR),
        gapSamples: sweep.gapScaleSweep.samples.length,
        leverLengthSamples: sweep.leverLengthSweep.samples.length,
        nhm2RegionSamples: sweep.nhm2RegionScaleSweep.samples.length,
        promotionAllowed: false,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
