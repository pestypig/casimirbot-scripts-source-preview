import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CONSTANTS_PATH = "configs/constants/codata-2022.v1.json";
const DEFAULT_BENCHMARKS_PATH = "configs/curvature-leverage-benchmarks.v1.json";
const DEFAULT_NHM2_REPORT_PATH =
  "artifacts/research/full-solve/curvature-leverage/nhm2-curvature-leverage-latest.json";
const DEFAULT_OUT_PATH =
  "artifacts/research/curvature-leverage/curvature-leverage-benchmark-ladder-latest.json";

type ConstantValue = {
  value: number;
  relativeUncertainty?: number;
  sourceId?: string;
};

type ConstantsConfig = {
  registryId?: string;
  constants: Record<string, ConstantValue>;
};

type BenchmarkFixture = {
  id: string;
  label: string;
  marginKind?: MarginKind;
  referenceNote?: string;
  sourceIds?: string[];
  empiricalGravityBenchmark?: boolean;
  massParameterKey?: string;
  massKey?: string;
  centralMassKey?: string;
  radiusKey?: string;
  mass_kg?: number;
  radius_m?: number;
  density_kg_m3?: number;
  gap_m?: number;
  leverLength_m?: number;
  orbitalRadius_m?: number;
  waveLength_m?: number;
  expectedLeverage?: number;
  densityMode?: "mu_first" | "g_density";
  formula?: string;
  observable?: string;
};

type BenchmarkGroup = {
  lane: BenchmarkLane;
  description?: string;
  fixtures: BenchmarkFixture[];
};

type BenchmarkConfig = {
  registryId?: string;
  claimTier?: "diagnostic" | "reduced_order";
  promotionAllowed?: false;
  benchmarkGroups: BenchmarkGroup[];
  comparisonPolicy?: {
    nearestBenchmarkExcludes?: string[];
    rawCasimirOneKilometerBenchmarkId?: string;
    horizonBenchmarkId?: string;
    epsilon?: number;
  };
  forbiddenClaims?: string[];
};

export type BenchmarkLane =
  | "compactness_identity"
  | "quantum_scale_floor"
  | "casimir_raw_energy"
  | "external_observable_calibration"
  | "ring_response_calibration"
  | "horizon_reference";

export type MarginKind =
  | "identity_check"
  | "constant_anchor"
  | "model_self_reference"
  | "empirical_reference";

export type BenchmarkMarginBand =
  | "sub_quantum_gravity_floor"
  | "quantum_particle_floor"
  | "laboratory_macro_floor"
  | "small_body_compactness"
  | "planetary_compactness"
  | "stellar_compactness"
  | "horizon_order"
  | "beyond_horizon_reference";

export type CurvatureLeverageBenchmarkRecord = {
  id: string;
  label: string;
  lane: BenchmarkLane;
  formula: string;
  leverage: number;
  referenceLeverage: number;
  relativeError: number;
  referenceUncertaintyRel: number;
  sigmaMargin: number | null;
  marginKind: MarginKind;
  marginBand: BenchmarkMarginBand;
  ordersFromHorizon: number;
  empiricalGravityBenchmark: boolean;
  referenceNote: string | null;
  sourceIds: string[];
  promotionAllowed: false;
  inputs: Record<string, number | string>;
};

export type Nhm2BenchmarkComparison = {
  region: string;
  leverage: number;
  nearestBenchmark: {
    id: string;
    label: string;
    lane: BenchmarkLane;
    leverage: number;
    ordersFromReference: number;
  };
  nearestEmpiricalGravityBenchmark: {
    id: string;
    label: string;
    lane: BenchmarkLane;
    leverage: number;
    ordersFromReference: number;
  } | null;
  ordersAboveRawCasimir1km: number | null;
  ordersBelowBlackHoleHorizon: number | null;
  sourceClosureStatus: string;
  observerClosureStatus: string;
  qeiStatus: string;
  conservationStatus: string;
  promotionAllowed: false;
};

export type CurvatureLeverageBenchmarkLadderReport = {
  artifactId: "curvature_leverage_benchmark_ladder";
  schemaVersion: "v1";
  generatedAt: string;
  source: {
    constantsRef: string;
    benchmarksRef: string;
    nhm2ReportRef: string | null;
    claimRoute: "cross_scale_diagnostic_only";
  };
  equationRefs: string[];
  claimIds: string[];
  promotionAllowed: false;
  benchmarks: CurvatureLeverageBenchmarkRecord[];
  nhm2Comparisons: Nhm2BenchmarkComparison[];
  forbiddenClaims: string[];
};

export type BuildBenchmarkLadderOptions = {
  constantsPath?: string;
  benchmarksPath?: string;
  nhm2ReportPath?: string;
  generatedAt?: string;
};

export type WriteBenchmarkLadderOptions = BuildBenchmarkLadderOptions & {
  outPath?: string;
};

type Nhm2LeverageReport = {
  regions?: Array<{
    region?: string;
    leverage?: number;
    sourceRegionStatus?: string;
    observerClosureStatus?: string;
    qeiStatus?: string;
    conservationStatus?: string;
    promotionAllowed?: boolean;
  }>;
};

type CoreConstants = {
  c: number;
  G: number;
  hbar: number;
};

export function buildCurvatureLeverageBenchmarkLadder(
  options: BuildBenchmarkLadderOptions = {},
): CurvatureLeverageBenchmarkLadderReport {
  const constantsPath = normalizeRepoPath(options.constantsPath ?? DEFAULT_CONSTANTS_PATH);
  const benchmarksPath = normalizeRepoPath(options.benchmarksPath ?? DEFAULT_BENCHMARKS_PATH);
  const nhm2ReportPath = normalizeRepoPath(options.nhm2ReportPath ?? DEFAULT_NHM2_REPORT_PATH);
  const constants = readJson<ConstantsConfig>(constantsPath);
  const config = readJson<BenchmarkConfig>(benchmarksPath);
  const core = coreConstants(constants);
  const benchmarks = config.benchmarkGroups.flatMap((group) =>
    group.fixtures.map((fixture) => buildBenchmarkRecord(group.lane, fixture, constants, core)),
  );

  return {
    artifactId: "curvature_leverage_benchmark_ladder",
    schemaVersion: "v1",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    source: {
      constantsRef: constantsPath,
      benchmarksRef: benchmarksPath,
      nhm2ReportRef: fs.existsSync(nhm2ReportPath) ? nhm2ReportPath : null,
      claimRoute: "cross_scale_diagnostic_only",
    },
    equationRefs: [
      "curvature_leverage_scale_normalization",
      "nhm2_full_solve_regional_tensor_leverage",
    ],
    claimIds: [
      "claim:curvature.leverage:scale_normalized_dimensionless",
      "claim:curvature.leverage:external_observables_are_calibrators",
      "claim:curvature.leverage:benchmark_ladder_compactness_anchor",
    ],
    promotionAllowed: false,
    benchmarks,
    nhm2Comparisons: fs.existsSync(nhm2ReportPath)
      ? compareNhm2Report(readJson<Nhm2LeverageReport>(nhm2ReportPath), benchmarks, config)
      : [],
    forbiddenClaims: config.forbiddenClaims ?? [
      "does not validate NHM2",
      "does not certify source closure",
      "does not promote physical mechanism",
    ],
  };
}

export function writeCurvatureLeverageBenchmarkLadder(
  options: WriteBenchmarkLadderOptions = {},
): CurvatureLeverageBenchmarkLadderReport {
  const outPath = normalizeRepoPath(options.outPath ?? DEFAULT_OUT_PATH);
  const report = buildCurvatureLeverageBenchmarkLadder(options);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function buildBenchmarkRecord(
  lane: BenchmarkLane,
  fixture: BenchmarkFixture,
  constants: ConstantsConfig,
  core: CoreConstants,
): CurvatureLeverageBenchmarkRecord {
  const result = computeFixture(lane, fixture, constants, core);
  const reference = result.referenceLeverage;
  const relativeError = relativeErrorFor(result.leverage, reference, 1e-300);
  const referenceUncertaintyRel = result.referenceUncertaintyRel;
  return {
    id: fixture.id,
    label: fixture.label,
    lane,
    formula: result.formula,
    leverage: result.leverage,
    referenceLeverage: reference,
    relativeError,
    referenceUncertaintyRel,
    sigmaMargin:
      referenceUncertaintyRel > 0 ? relativeError / referenceUncertaintyRel : null,
    marginKind: result.marginKind,
    marginBand: marginBand(result.leverage),
    ordersFromHorizon: log10Ratio(result.leverage, 1),
    empiricalGravityBenchmark: fixture.empiricalGravityBenchmark === true,
    referenceNote: result.referenceNote,
    sourceIds: result.sourceIds,
    promotionAllowed: false,
    inputs: result.inputs,
  };
}

function computeFixture(
  lane: BenchmarkLane,
  fixture: BenchmarkFixture,
  constants: ConstantsConfig,
  core: CoreConstants,
): {
  leverage: number;
  referenceLeverage: number;
  referenceUncertaintyRel: number;
  marginKind: MarginKind;
  referenceNote: string | null;
  sourceIds: string[];
  formula: string;
  inputs: Record<string, number | string>;
} {
  if (fixture.id === "planck_mass_planck_length") {
    const planckMass = Math.sqrt((core.hbar * core.c) / core.G);
    const planckLength = Math.sqrt((core.hbar * core.G) / core.c ** 3);
    const leverage = compactnessFromMass(planckMass, planckLength, core);
    return {
      leverage,
      referenceLeverage: fixture.expectedLeverage ?? 2,
      referenceUncertaintyRel: constantUncertainty(constants, "G_m3_kg_s2"),
      marginKind: fixture.marginKind ?? "constant_anchor",
      referenceNote: fixture.referenceNote ?? null,
      sourceIds: fixture.sourceIds ?? sourceIdsForKeys(constants, ["G_m3_kg_s2", "hbar_J_s", "c_m_s"]),
      formula: fixture.formula ?? "2*G*m_P/(l_P*c^2)",
      inputs: {
        planckMass_kg: planckMass,
        planckLength_m: planckLength,
      },
    };
  }

  if (fixture.expectedLeverage !== undefined) {
    return {
      leverage: fixture.expectedLeverage,
      referenceLeverage: fixture.expectedLeverage,
      referenceUncertaintyRel: 0,
      marginKind: fixture.marginKind ?? "constant_anchor",
      referenceNote: fixture.referenceNote ?? null,
      sourceIds: fixture.sourceIds ?? [],
      formula: fixture.formula ?? "declared_reference_leverage",
      inputs: {},
    };
  }

  if (lane === "casimir_raw_energy") {
    const gap = positiveNumber(fixture.gap_m, `${fixture.id}.gap_m`);
    const leverLength = positiveNumber(fixture.leverLength_m, `${fixture.id}.leverLength_m`);
    const energyPerAreaAbs = (Math.PI * Math.PI * core.hbar * core.c) / (720 * gap ** 3);
    const energyDensityAbs = energyPerAreaAbs / gap;
    const kappa = kappaU(energyDensityAbs, core);
    const leverage = Math.abs(kappa) * leverLength * leverLength;
    return {
      leverage,
      referenceLeverage: leverage,
      referenceUncertaintyRel: constantUncertainty(constants, "G_m3_kg_s2"),
      marginKind: fixture.marginKind ?? "model_self_reference",
      referenceNote:
        fixture.referenceNote ??
        "Raw Casimir leverage is generated from the same ideal parallel-plate model used for the displayed value; zero residual is not an empirical accuracy margin.",
      sourceIds: fixture.sourceIds ?? sourceIdsForKeys(constants, ["G_m3_kg_s2", "hbar_J_s", "c_m_s"]),
      formula: "abs((8*pi*G/c^4) * abs(E/A)/a) * L^2",
      inputs: {
        gap_m: gap,
        leverLength_m: leverLength,
        energyPerAreaAbs_J_m2: energyPerAreaAbs,
        energyDensityAbs_J_m3: energyDensityAbs,
        kappa_m2: kappa,
      },
      };
  }

  if (lane === "ring_response_calibration") {
    const mass = positiveNumber(
      fixture.centralMassKey ? constantValue(constants, fixture.centralMassKey) : fixture.mass_kg,
      `${fixture.id}.centralMass`,
    );
    const orbitalRadius = positiveNumber(fixture.orbitalRadius_m, `${fixture.id}.orbitalRadius_m`);
    const waveLength = positiveNumber(fixture.waveLength_m, `${fixture.id}.waveLength_m`);
    const mu = core.G * mass;
    const tidalCurvature = Math.abs((2 * mu) / (orbitalRadius ** 3 * core.c ** 2));
    const leverage = tidalCurvature * waveLength * waveLength;
    return {
      leverage,
      referenceLeverage: leverage,
      referenceUncertaintyRel: fixture.centralMassKey
        ? combinedUncertainty(constants, ["G_m3_kg_s2", fixture.centralMassKey])
        : constantUncertainty(constants, "G_m3_kg_s2"),
      marginKind: fixture.marginKind ?? "model_self_reference",
      referenceNote:
        fixture.referenceNote ??
        "Ring response leverage is a reduced-order tidal-curvature calibration; it is not a compactness identity or NHM2 validation.",
      sourceIds: fixture.sourceIds ?? sourceIdsForKeys(constants, ["G_m3_kg_s2", fixture.centralMassKey]),
      formula: fixture.formula ?? "abs(2*G*M/(r^3*c^2))*lambda_wave^2",
      inputs: {
        centralMassKey: fixture.centralMassKey ?? "inline",
        centralMass_kg: mass,
        orbitalRadius_m: orbitalRadius,
        waveLength_m: waveLength,
        tidalCurvature_m2: tidalCurvature,
        observable: fixture.observable ?? "ring_density_wave",
      },
    };
  }

  if (fixture.massParameterKey && fixture.radiusKey) {
    const mu = constantValue(constants, fixture.massParameterKey);
    const radius = constantValue(constants, fixture.radiusKey);
    const mass = mu / core.G;
    const density = meanDensity(mass, radius);
    const leverage = kappaBody(density, core) * radius * radius;
    const referenceLeverage = compactnessFromMu(mu, radius, core.c);
    return {
      leverage,
      referenceLeverage,
      referenceUncertaintyRel: 0,
      marginKind: fixture.marginKind ?? "identity_check",
      referenceNote:
        fixture.referenceNote ??
        "IAU nominal conversion constant; exact by convention, not an empirical current-best-estimate.",
      sourceIds: fixture.sourceIds ?? sourceIdsForKeys(constants, [fixture.massParameterKey, fixture.radiusKey]),
      formula: "kappa_body(3M/(4*pi*R^3))*R^2 = 2*mu/(R*c^2)",
      inputs: {
        massParameterKey: fixture.massParameterKey,
        radiusKey: fixture.radiusKey,
        mu_m3_s2: mu,
        radius_m: radius,
        meanDensity_kg_m3: density,
      },
    };
  }

  if (fixture.massKey && fixture.radiusKey) {
    const mass = constantValue(constants, fixture.massKey);
    const radius = constantValue(constants, fixture.radiusKey);
    const leverage = compactnessFromMass(mass, radius, core);
    return {
      leverage,
      referenceLeverage: leverage,
      referenceUncertaintyRel: combinedUncertainty(constants, [
        "G_m3_kg_s2",
        fixture.massKey,
        fixture.radiusKey,
      ]),
      marginKind: fixture.marginKind ?? "model_self_reference",
      referenceNote:
        fixture.referenceNote ??
        "Reference leverage is computed from the same mass/radius compactness formula; zero residual is a unit-scale self check.",
      sourceIds: fixture.sourceIds ?? sourceIdsForKeys(constants, ["G_m3_kg_s2", fixture.massKey, fixture.radiusKey]),
      formula: "2*G*M/(R*c^2)",
      inputs: {
        massKey: fixture.massKey,
        radiusKey: fixture.radiusKey,
        mass_kg: mass,
        radius_m: radius,
      },
    };
  }

  if (fixture.mass_kg !== undefined && fixture.radius_m !== undefined) {
    const mass = positiveNumber(fixture.mass_kg, `${fixture.id}.mass_kg`);
    const radius = positiveNumber(fixture.radius_m, `${fixture.id}.radius_m`);
    const leverage = compactnessFromMass(mass, radius, core);
    return {
      leverage,
      referenceLeverage: leverage,
      referenceUncertaintyRel: constantUncertainty(constants, "G_m3_kg_s2"),
      marginKind: fixture.marginKind ?? "model_self_reference",
      referenceNote:
        fixture.referenceNote ??
        "Reference leverage is computed from the same inline mass/radius compactness formula; zero residual is a scale self check.",
      sourceIds: fixture.sourceIds ?? sourceIdsForKeys(constants, ["G_m3_kg_s2"]),
      formula: "2*G*M/(R*c^2)",
      inputs: { mass_kg: mass, radius_m: radius },
    };
  }

  if (fixture.density_kg_m3 !== undefined && fixture.radius_m !== undefined) {
    const density = positiveNumber(fixture.density_kg_m3, `${fixture.id}.density_kg_m3`);
    const radius = positiveNumber(fixture.radius_m, `${fixture.id}.radius_m`);
    const leverage = kappaBody(density, core) * radius * radius;
    return {
      leverage,
      referenceLeverage: leverage,
      referenceUncertaintyRel: constantUncertainty(constants, "G_m3_kg_s2"),
      marginKind: fixture.marginKind ?? "model_self_reference",
      referenceNote:
        fixture.referenceNote ??
        "Reference leverage is generated from the same density/radius model; zero residual is not an empirical accuracy margin.",
      sourceIds: fixture.sourceIds ?? sourceIdsForKeys(constants, ["G_m3_kg_s2"]),
      formula: "kappa_body(rho)*R^2",
      inputs: {
        density_kg_m3: density,
        radius_m: radius,
        observable: fixture.observable ?? "unspecified",
      },
    };
  }

  throw new Error(`Unsupported benchmark fixture: ${fixture.id}`);
}

function compareNhm2Report(
  report: Nhm2LeverageReport,
  benchmarks: CurvatureLeverageBenchmarkRecord[],
  config: BenchmarkConfig,
): Nhm2BenchmarkComparison[] {
  const excluded = new Set(config.comparisonPolicy?.nearestBenchmarkExcludes ?? []);
  const candidates = benchmarks.filter((entry) => !excluded.has(entry.id) && entry.leverage > 0);
  const empiricalGravityCandidates = candidates.filter(
    (entry) => entry.empiricalGravityBenchmark === true,
  );
  const rawCasimir = benchmarks.find(
    (entry) => entry.id === config.comparisonPolicy?.rawCasimirOneKilometerBenchmarkId,
  );
  const horizon = benchmarks.find(
    (entry) => entry.id === config.comparisonPolicy?.horizonBenchmarkId,
  );

  return (report.regions ?? [])
    .filter((region) => Number.isFinite(region.leverage))
    .map((region) => {
      const leverage = Number(region.leverage);
      const nearest = nearestBenchmark(leverage, candidates);
      const nearestEmpirical =
        empiricalGravityCandidates.length > 0
          ? nearestBenchmark(leverage, empiricalGravityCandidates)
          : null;
      return {
        region: textOr(region.region, "unknown"),
        leverage,
        nearestBenchmark: {
          id: nearest.id,
          label: nearest.label,
          lane: nearest.lane,
          leverage: nearest.leverage,
          ordersFromReference: log10Ratio(leverage, nearest.leverage),
        },
        nearestEmpiricalGravityBenchmark: nearestEmpirical
          ? {
              id: nearestEmpirical.id,
              label: nearestEmpirical.label,
              lane: nearestEmpirical.lane,
              leverage: nearestEmpirical.leverage,
              ordersFromReference: log10Ratio(leverage, nearestEmpirical.leverage),
            }
          : null,
        ordersAboveRawCasimir1km: rawCasimir ? log10Ratio(leverage, rawCasimir.leverage) : null,
        ordersBelowBlackHoleHorizon: horizon ? log10Ratio(horizon.leverage, leverage) : null,
        sourceClosureStatus: textOr(region.sourceRegionStatus, "unknown"),
        observerClosureStatus: textOr(region.observerClosureStatus, "unknown"),
        qeiStatus: textOr(region.qeiStatus, "unknown"),
        conservationStatus: textOr(region.conservationStatus, "unknown"),
        promotionAllowed: false,
      };
    });
}

function nearestBenchmark(
  leverage: number,
  candidates: CurvatureLeverageBenchmarkRecord[],
): CurvatureLeverageBenchmarkRecord {
  if (candidates.length === 0) {
    throw new Error("At least one benchmark candidate is required");
  }
  const logLeverage = Math.log10(Math.max(Math.abs(leverage), 1e-300));
  return candidates.reduce((best, entry) => {
    const bestDelta = Math.abs(logLeverage - Math.log10(best.leverage));
    const entryDelta = Math.abs(logLeverage - Math.log10(entry.leverage));
    return entryDelta < bestDelta ? entry : best;
  }, candidates[0]);
}

function meanDensity(massKg: number, radiusM: number): number {
  return (3 * massKg) / (4 * Math.PI * radiusM ** 3);
}

function compactnessFromMass(massKg: number, radiusM: number, core: CoreConstants): number {
  return (2 * core.G * massKg) / (radiusM * core.c * core.c);
}

function compactnessFromMu(muM3S2: number, radiusM: number, c: number): number {
  return (2 * muM3S2) / (radiusM * c * c);
}

function kappaBody(densityKgM3: number, core: CoreConstants): number {
  return ((8 * Math.PI * core.G) / (3 * core.c * core.c)) * densityKgM3;
}

function kappaU(energyDensityJm3: number, core: CoreConstants): number {
  return ((8 * Math.PI * core.G) / core.c ** 4) * energyDensityJm3;
}

function coreConstants(config: ConstantsConfig): CoreConstants {
  return {
    c: constantValue(config, "c_m_s"),
    G: constantValue(config, "G_m3_kg_s2"),
    hbar: constantValue(config, "hbar_J_s"),
  };
}

function constantValue(config: ConstantsConfig, key: string): number {
  const value = config.constants[key]?.value;
  return positiveNumber(value, key);
}

function constantUncertainty(config: ConstantsConfig, key: string): number {
  const value = config.constants[key]?.relativeUncertainty;
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : 0;
}

function combinedUncertainty(config: ConstantsConfig, keys: string[]): number {
  return Math.sqrt(
    keys.reduce((sum, key) => {
      const uncertainty = constantUncertainty(config, key);
      return sum + uncertainty * uncertainty;
    }, 0),
  );
}

function sourceIdsForKeys(config: ConstantsConfig, keys: Array<string | undefined>): string[] {
  return Array.from(
    new Set(
      keys
        .map((key) => (key ? config.constants[key]?.sourceId : undefined))
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  );
}

function positiveNumber(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new TypeError(`${name} must be positive and finite`);
  }
  return n;
}

function relativeErrorFor(value: number, reference: number, epsilon: number): number {
  return Math.abs(value - reference) / Math.max(Math.abs(reference), epsilon);
}

function log10Ratio(value: number, reference: number): number {
  if (value <= 0 || reference <= 0) return Number.NaN;
  return Math.log10(value / reference);
}

function marginBand(leverage: number): BenchmarkMarginBand {
  if (leverage < 1e-45) return "sub_quantum_gravity_floor";
  if (leverage < 1e-38) return "quantum_particle_floor";
  if (leverage < 1e-20) return "laboratory_macro_floor";
  if (leverage < 1e-10) return "small_body_compactness";
  if (leverage < 1e-7) return "planetary_compactness";
  if (leverage < 1e-3) return "stellar_compactness";
  if (leverage <= 2) return "horizon_order";
  return "beyond_horizon_reference";
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

function parseArgs(argv: string[]): WriteBenchmarkLadderOptions {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  return {
    constantsPath: get("constants"),
    benchmarksPath: get("benchmarks"),
    nhm2ReportPath: get("nhm2-report"),
    outPath: get("out"),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const report = writeCurvatureLeverageBenchmarkLadder(args);
  console.log(
    JSON.stringify(
      {
        ok: true,
        out: normalizeRepoPath(args.outPath ?? DEFAULT_OUT_PATH),
        benchmarks: report.benchmarks.length,
        nhm2Comparisons: report.nhm2Comparisons.length,
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
