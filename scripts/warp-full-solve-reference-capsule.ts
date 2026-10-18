import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';
const GENERATOR_VERSION = '1.3.0';

const FULL_SOLVE_DIR = path.join('artifacts', 'research', 'full-solve');
const EXTERNAL_WORK_DIR = path.join(FULL_SOLVE_DIR, 'external-work');
const DOC_AUDIT_DIR = path.join('docs', 'audits', 'research');
const DEFAULT_GR_MERCURY_SNAPSHOT_PATH = path.join(
  'docs',
  'specs',
  'data',
  'gr-mercury-perihelion-einstein-1915.v1.json',
);
const DEFAULT_GR_LENSING_SNAPSHOT_PATH = path.join(
  'docs',
  'specs',
  'data',
  'gr-lensing-deflection-observable.v1.json',
);
const DEFAULT_GR_FRAME_DRAGGING_SNAPSHOT_PATH = path.join(
  'docs',
  'specs',
  'data',
  'gr-frame-dragging-observable.v1.json',
);
const DEFAULT_GR_SHAPIRO_SNAPSHOT_PATH = path.join(
  'docs',
  'specs',
  'data',
  'gr-shapiro-delay-observable.v1.json',
);
const DEFAULT_OUT_JSON = path.join(FULL_SOLVE_DIR, `full-solve-reference-capsule-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join(DOC_AUDIT_DIR, `warp-full-solve-reference-capsule-${DATE_STAMP}.md`);
const DEFAULT_LATEST_JSON = path.join(FULL_SOLVE_DIR, 'full-solve-reference-capsule-latest.json');
const DEFAULT_LATEST_MD = path.join(DOC_AUDIT_DIR, 'warp-full-solve-reference-capsule-latest.md');
const ARCSEC_PER_RAD = 206264.80624709636;

type BlockerSeverity = 'HARD' | 'SOFT';

type Blocker = {
  id: string;
  severity: BlockerSeverity;
  path: string | null;
  reason: string;
};

type LaneConfig = {
  lane: string;
  compatPrefix: string;
  required: boolean;
};

type CanonicalCounts = {
  PASS: number;
  FAIL: number;
  UNKNOWN: number;
  NOT_READY: number;
  NOT_APPLICABLE: number;
};

type CanonicalReportSummary = {
  decision: string | null;
  counts: CanonicalCounts | null;
};

const LANE_CONFIGS: LaneConfig[] = [
  { lane: 'casimir_sign_control', compatPrefix: 'cs', required: true },
  { lane: 'q_spoiling', compatPrefix: 'qs', required: true },
  { lane: 'nanogap', compatPrefix: 'ng', required: true },
  { lane: 'timing', compatPrefix: 'ti', required: true },
  { lane: 'sem_ellipsometry', compatPrefix: 'se', required: true },
];

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const normalizePath = (filePath: string) => filePath.replace(/\\/g, '/');

const listFiles = (dirPath: string): string[] => {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
};

const findLatestByRegex = (dirPath: string, regex: RegExp): string | null => {
  const candidates = listFiles(dirPath).filter((entry) => regex.test(entry));
  if (candidates.length === 0) return null;
  const ranked = candidates
    .map((entry) => {
      const fullPath = path.join(dirPath, entry);
      const stat = fs.statSync(fullPath);
      return {
        fullPath,
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return ranked[0]?.fullPath ?? null;
};

const readJson = (filePath: string): any => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const readJsonSafe = (filePath: string | null): any | null => {
  if (!filePath) return null;
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
};

const readTextSafe = (filePath: string | null): string | null => {
  if (!filePath) return null;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
};

const getCommitHash = () =>
  execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const getLastCommitForPath = (filePath: string | null): string | null => {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const result = spawnSync('git', ['log', '-n', '1', '--format=%H', '--', filePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;
  const value = (result.stdout ?? '').trim();
  return value.length > 0 ? value : null;
};

const asText = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
};

const asNumber = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const objectWithSortedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => objectWithSortedKeys(entry));
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = objectWithSortedKeys(source[key]);
    }
    return out;
  }
  return value;
};

const checksumPayload = (payload: Record<string, unknown>): string => {
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(payload));
  delete copy.generated_at;
  delete copy.checksum;
  const canonical = JSON.stringify(objectWithSortedKeys(copy));
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

const parseSummaryCounts = (payload: any) => {
  const summary = payload?.summary ?? {};
  return {
    scenarioCount: asNumber(summary?.scenarioCount) ?? 0,
    congruent: asNumber(summary?.congruent) ?? 0,
    incongruent: asNumber(summary?.incongruent) ?? 0,
    unknown: asNumber(summary?.unknown) ?? 0,
    reasonCounts: (summary?.reasonCounts ?? {}) as Record<string, number>,
  };
};

const parseCountsObject = (value: unknown): CanonicalCounts => {
  const source = (value ?? {}) as Record<string, unknown>;
  return {
    PASS: asNumber(source.PASS) ?? 0,
    FAIL: asNumber(source.FAIL) ?? 0,
    UNKNOWN: asNumber(source.UNKNOWN) ?? 0,
    NOT_READY: asNumber(source.NOT_READY) ?? 0,
    NOT_APPLICABLE: asNumber(source.NOT_APPLICABLE) ?? 0,
  };
};

const countsEqual = (left: CanonicalCounts | null, right: CanonicalCounts | null): boolean => {
  if (!left || !right) return false;
  return (
    left.PASS === right.PASS &&
    left.FAIL === right.FAIL &&
    left.UNKNOWN === right.UNKNOWN &&
    left.NOT_READY === right.NOT_READY &&
    left.NOT_APPLICABLE === right.NOT_APPLICABLE
  );
};

const parseCanonicalReportSummary = (markdown: string | null): CanonicalReportSummary => {
  if (!markdown) return { decision: null, counts: null };

  const decisionMatch = markdown.match(/##\s*Executive verdict[\s\S]*?\*\*([A-Z_]+)\*\*/m);
  const countMatch = (key: string) =>
    markdown.match(new RegExp(`-\\s*${key}\\s*:\\s*([0-9]+)`, 'm'))?.[1] ?? null;

  const pass = countMatch('PASS');
  const fail = countMatch('FAIL');
  const unknown = countMatch('UNKNOWN');
  const notReady = countMatch('NOT_READY');
  const notApplicable = countMatch('NOT_APPLICABLE');

  const counts =
    pass != null && fail != null && unknown != null && notReady != null && notApplicable != null
      ? {
          PASS: Number(pass),
          FAIL: Number(fail),
          UNKNOWN: Number(unknown),
          NOT_READY: Number(notReady),
          NOT_APPLICABLE: Number(notApplicable),
        }
      : null;

  return {
    decision: asText(decisionMatch?.[1]),
    counts,
  };
};

const readCommitHashFromArtifact = (payload: any): string | null => {
  const candidates = [
    payload?.commitHash,
    payload?.commit,
    payload?.headCommitHash,
    payload?.provenance?.commitHash,
    payload?.commit_pin,
  ];
  for (const candidate of candidates) {
    const value = asText(candidate);
    if (value) return value;
  }
  return null;
};

const maybeAddBlocker = (
  blockers: Blocker[],
  candidate: { id: string; severity: BlockerSeverity; path?: string | null; reason?: string | null },
) => {
  if (!candidate.reason) return;
  blockers.push({
    id: candidate.id,
    severity: candidate.severity,
    path: candidate.path ?? null,
    reason: candidate.reason,
  });
};

const resolveLatestCompatPath = (
  prefix: string,
  mode: 'typed' | 'reportable' | 'reportable_reference',
): string | null => {
  if (mode === 'typed') {
    return findLatestByRegex(FULL_SOLVE_DIR, new RegExp(`^${prefix}-compat-check-\\d{4}-\\d{2}-\\d{2}\\.json$`));
  }
  if (mode === 'reportable') {
    return findLatestByRegex(
      FULL_SOLVE_DIR,
      new RegExp(`^${prefix}-compat-check-reportable-\\d{4}-\\d{2}-\\d{2}\\.json$`),
    );
  }
  return findLatestByRegex(
    FULL_SOLVE_DIR,
    new RegExp(`^${prefix}-compat-check-reportable-reference-\\d{4}-\\d{2}-\\d{2}\\.json$`),
  );
};

const buildGeometrySignature = (geometryPayload: any): Record<string, { status: string; testFile: string | null }> => {
  const signature: Record<string, { status: string; testFile: string | null }> = {};
  const checks = Array.isArray(geometryPayload?.checks) ? geometryPayload.checks : [];
  for (const check of checks) {
    const id = asText(check?.id);
    if (!id) continue;
    signature[id] = {
      status: asText(check?.status) ?? 'unknown',
      testFile: asText(check?.testFile),
    };
  }
  return signature;
};

const buildEnergeticsQeiSignature = (
  geometrySignature: Record<string, { status: string; testFile: string | null }>,
): Record<string, { status: string; source: string; reason_code: string }> => ({
  negative_energy_branch_policy: {
    status: 'pass',
    source: 'canonical_policy',
    reason_code: 'negative_energy_branch_allowed_under_qei_gate',
  },
  qei_worldline_requirement: {
    status: 'pass',
    source: 'canonical_policy',
    reason_code: 'worldline_qei_required_for_gate_admissibility',
  },
  stress_source_contract: {
    status: geometrySignature.metric_derived_t00_path?.status ?? 'unknown',
    source: 'geometry_conformance.metric_derived_t00_path',
    reason_code:
      geometrySignature.metric_derived_t00_path?.status === 'pass'
        ? 'metric_derived_stress_lane_verified'
        : 'metric_derived_stress_lane_unverified',
  },
  assumption_domain_disclosure: {
    status: 'pass',
    source: 'canonical_policy',
    reason_code: 'assumption_domain_must_be_explicit_for_external_comparison',
  },
  physical_feasibility_boundary: {
    status: 'pass',
    source: 'boundary_statement',
    reason_code: 'non_feasibility_boundary_is_explicit',
  },
});

const buildMercuryPerihelionBaseline = (snapshot: any) => {
  const constants = (snapshot?.constants ?? {}) as Record<string, unknown>;
  const gmSun = asNumber(constants.gm_sun_m3_s2);
  const c = asNumber(constants.c_m_s);
  const a = asNumber(constants.a_m);
  const e = asNumber(constants.e);
  const orbitalPeriodDays = asNumber(constants.orbital_period_days);
  const observedArcsecPerCentury = asNumber(snapshot?.observed?.anomalous_arcsec_per_century);
  const observedUncertainty = asNumber(snapshot?.observed?.uncertainty_arcsec_per_century) ?? 0.5;
  const tolerance = asNumber(snapshot?.acceptance?.max_abs_residual_arcsec_per_century) ?? 1.0;

  if (
    gmSun == null ||
    c == null ||
    a == null ||
    e == null ||
    orbitalPeriodDays == null ||
    observedArcsecPerCentury == null
  ) {
    return {
      status: 'unknown',
      reason_code: 'insufficient_snapshot_constants',
      predicted_arcsec_per_century: null,
      observed_arcsec_per_century: observedArcsecPerCentury,
      residual_arcsec_per_century: null,
      observed_uncertainty_arcsec_per_century: observedUncertainty,
      max_abs_residual_arcsec_per_century: tolerance,
      formula: '6*pi*G*M/(a*(1-e^2)*c^2)',
    };
  }

  const deltaPerOrbitRad = (6 * Math.PI * gmSun) / (a * (1 - e * e) * c * c);
  const orbitsPerCentury = 36525 / orbitalPeriodDays;
  const predictedArcsecPerCentury = deltaPerOrbitRad * ARCSEC_PER_RAD * orbitsPerCentury;
  const residualArcsecPerCentury = predictedArcsecPerCentury - observedArcsecPerCentury;
  const status = Math.abs(residualArcsecPerCentury) <= tolerance ? 'pass' : 'fail';
  return {
    status,
    reason_code: status === 'pass' ? 'residual_within_tolerance' : 'residual_exceeds_tolerance',
    predicted_arcsec_per_century: predictedArcsecPerCentury,
    observed_arcsec_per_century: observedArcsecPerCentury,
    residual_arcsec_per_century: residualArcsecPerCentury,
    observed_uncertainty_arcsec_per_century: observedUncertainty,
    max_abs_residual_arcsec_per_century: tolerance,
    formula: '6*pi*G*M/(a*(1-e^2)*c^2)',
  };
};

const buildLensingDeflectionBaseline = (snapshot: any) => {
  const constants = (snapshot?.constants ?? {}) as Record<string, unknown>;
  const gmSun = asNumber(constants.gm_sun_m3_s2);
  const c = asNumber(constants.c_m_s);
  const impactParameter = asNumber(constants.solar_limb_impact_parameter_m);
  const historicalObservedArcsec = asNumber(snapshot?.observed?.historical_deflection_arcsec);
  const historicalUncertaintyArcsec = asNumber(snapshot?.observed?.historical_uncertainty_arcsec) ?? null;
  const modernGammaMeasured = asNumber(snapshot?.observed?.modern_gamma);
  const modernGammaUncertainty = asNumber(snapshot?.observed?.modern_gamma_uncertainty) ?? null;
  const historicalTolerance = asNumber(snapshot?.acceptance?.max_abs_historical_residual_arcsec) ?? 0.5;
  const gammaTolerance = asNumber(snapshot?.acceptance?.max_abs_gamma_residual) ?? 0.001;

  if (gmSun == null || c == null || impactParameter == null || historicalObservedArcsec == null || modernGammaMeasured == null) {
    return {
      status: 'unknown',
      reason_code: 'insufficient_snapshot_constants',
      predicted_limb_arcsec: null,
      historical_observed_arcsec: historicalObservedArcsec,
      historical_residual_arcsec: null,
      historical_uncertainty_arcsec: historicalUncertaintyArcsec,
      max_abs_historical_residual_arcsec: historicalTolerance,
      modern_gamma_measured: modernGammaMeasured,
      modern_gamma_uncertainty: modernGammaUncertainty,
      modern_gamma_residual: null,
      max_abs_gamma_residual: gammaTolerance,
      formula: 'alpha_limb_rad = 4*G*M_sun/(c^2*b)',
    };
  }

  const alphaLimbRad = (4 * gmSun) / (c * c * impactParameter);
  const predictedLimbArcsec = alphaLimbRad * ARCSEC_PER_RAD;
  const historicalResidualArcsec = predictedLimbArcsec - historicalObservedArcsec;
  const modernGammaResidual = modernGammaMeasured - 1;
  const historicalPass = Math.abs(historicalResidualArcsec) <= historicalTolerance;
  const gammaPass = Math.abs(modernGammaResidual) <= gammaTolerance;
  const status = historicalPass && gammaPass ? 'pass' : 'fail';

  return {
    status,
    reason_code:
      status === 'pass'
        ? 'historical_and_modern_within_tolerance'
        : !gammaPass
        ? 'modern_gamma_residual_exceeds_tolerance'
        : 'historical_residual_exceeds_tolerance',
    predicted_limb_arcsec: predictedLimbArcsec,
    historical_observed_arcsec: historicalObservedArcsec,
    historical_residual_arcsec: historicalResidualArcsec,
    historical_uncertainty_arcsec: historicalUncertaintyArcsec,
    max_abs_historical_residual_arcsec: historicalTolerance,
    modern_gamma_measured: modernGammaMeasured,
    modern_gamma_uncertainty: modernGammaUncertainty,
    modern_gamma_residual: modernGammaResidual,
    max_abs_gamma_residual: gammaTolerance,
    formula: 'alpha_limb_rad = 4*G*M_sun/(c^2*b)',
  };
};

const buildFrameDraggingBaseline = (snapshot: any) => {
  const constants = (snapshot?.constants ?? {}) as Record<string, unknown>;
  const gpbPredicted = asNumber(constants.gpb_gr_predicted_mas_per_year);
  const lageosExpectedRatio = asNumber(constants.lageos_ratio_expected);
  const gpbObserved = asNumber(snapshot?.observed?.gpb_measured_mas_per_year);
  const gpbUncertainty = asNumber(snapshot?.observed?.gpb_uncertainty_mas_per_year) ?? null;
  const lageosObservedRatio = asNumber(snapshot?.observed?.lageos_ratio_measured);
  const lageosUncertainty = asNumber(snapshot?.observed?.lageos_ratio_uncertainty) ?? null;
  const laresAccuracyPercent = asNumber(snapshot?.observed?.lares_accuracy_percent_reported);
  const gpbTolerance = asNumber(snapshot?.acceptance?.max_abs_gpb_residual_mas_per_year) ?? 14.4;
  const lageosTolerance = asNumber(snapshot?.acceptance?.max_abs_lageos_ratio_residual) ?? 0.2;

  if (gpbPredicted == null || lageosExpectedRatio == null || gpbObserved == null || lageosObservedRatio == null) {
    return {
      status: 'unknown',
      reason_code: 'insufficient_snapshot_constants',
      gpb_predicted_mas_per_year: gpbPredicted,
      gpb_observed_mas_per_year: gpbObserved,
      gpb_residual_mas_per_year: null,
      gpb_uncertainty_mas_per_year: gpbUncertainty,
      max_abs_gpb_residual_mas_per_year: gpbTolerance,
      lageos_expected_ratio: lageosExpectedRatio,
      lageos_observed_ratio: lageosObservedRatio,
      lageos_residual_ratio: null,
      lageos_uncertainty: lageosUncertainty,
      max_abs_lageos_ratio_residual: lageosTolerance,
      lares_accuracy_percent_reported: laresAccuracyPercent,
      formula: 'delta = measured - predicted',
    };
  }

  const gpbResidual = gpbObserved - gpbPredicted;
  const lageosResidual = lageosObservedRatio - lageosExpectedRatio;
  const gpbPass = Math.abs(gpbResidual) <= gpbTolerance;
  const lageosPass = Math.abs(lageosResidual) <= lageosTolerance;
  const status = gpbPass && lageosPass ? 'pass' : 'fail';

  return {
    status,
    reason_code:
      status === 'pass'
        ? 'gpb_and_lageos_within_tolerance'
        : !gpbPass
        ? 'gpb_residual_exceeds_tolerance'
        : 'lageos_ratio_residual_exceeds_tolerance',
    gpb_predicted_mas_per_year: gpbPredicted,
    gpb_observed_mas_per_year: gpbObserved,
    gpb_residual_mas_per_year: gpbResidual,
    gpb_uncertainty_mas_per_year: gpbUncertainty,
    max_abs_gpb_residual_mas_per_year: gpbTolerance,
    lageos_expected_ratio: lageosExpectedRatio,
    lageos_observed_ratio: lageosObservedRatio,
    lageos_residual_ratio: lageosResidual,
    lageos_uncertainty: lageosUncertainty,
    max_abs_lageos_ratio_residual: lageosTolerance,
    lares_accuracy_percent_reported: laresAccuracyPercent,
    formula: 'delta = measured - predicted',
  };
};

const buildShapiroDelayBaseline = (snapshot: any) => {
  const gammaMinusOneMeasured = asNumber(snapshot?.observed?.gamma_minus_one);
  const gammaMinusOneUncertainty = asNumber(snapshot?.observed?.gamma_minus_one_uncertainty) ?? null;
  const maxAbsGammaMinusOne = asNumber(snapshot?.acceptance?.max_abs_gamma_minus_one) ?? 7e-5;

  if (gammaMinusOneMeasured == null) {
    return {
      status: 'unknown',
      reason_code: 'insufficient_snapshot_constants',
      gamma_minus_one_measured: null,
      gamma_minus_one_uncertainty: gammaMinusOneUncertainty,
      gamma_estimated: null,
      gamma_residual: null,
      max_abs_gamma_minus_one: maxAbsGammaMinusOne,
      formula:
        'Delta_t_shapiro = (1+gamma)*(2*G*M_sun/c^3)*ln((r_E+r_R+R)/(r_E+r_R-R)); gamma_estimated = 1 + (gamma_minus_one)',
    };
  }

  const gammaEstimated = 1 + gammaMinusOneMeasured;
  const gammaResidual = gammaMinusOneMeasured;
  const status = Math.abs(gammaResidual) <= maxAbsGammaMinusOne ? 'pass' : 'fail';
  return {
    status,
    reason_code: status === 'pass' ? 'gamma_minus_one_within_tolerance' : 'gamma_minus_one_exceeds_tolerance',
    gamma_minus_one_measured: gammaMinusOneMeasured,
    gamma_minus_one_uncertainty: gammaMinusOneUncertainty,
    gamma_estimated: gammaEstimated,
    gamma_residual: gammaResidual,
    max_abs_gamma_minus_one: maxAbsGammaMinusOne,
    formula:
      'Delta_t_shapiro = (1+gamma)*(2*G*M_sun/c^3)*ln((r_E+r_R+R)/(r_E+r_R-R)); gamma_estimated = 1 + (gamma_minus_one)',
  };
};

const formatReasonCounts = (counts: Record<string, number> | null | undefined): string => {
  const entries = Object.entries(counts ?? {}).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (entries.length === 0) return 'none';
  return entries.map(([reason, count]) => `${reason}=${count}`).join(', ');
};

const renderMarkdown = (payload: any): string => {
  const blockers = Array.isArray(payload.blocking_inventory?.blockers)
    ? payload.blocking_inventory.blockers
    : [];
  const blockerRows = blockers.length
    ? blockers
        .map(
          (entry: any) =>
            `| ${entry.id} | ${entry.severity} | ${entry.path ?? 'n/a'} | ${entry.reason} |`,
        )
        .join('\n')
    : '| none | n/a | n/a | none |';

  const laneRows = Object.entries(payload.evidence_lanes ?? {})
    .map(([lane, lanePayload]: [string, any]) => {
      const typed = lanePayload?.typed?.summary ?? {};
      const reportable = lanePayload?.reportable?.summary ?? {};
      return `| ${lane} | ${typed.congruent ?? 0} / ${typed.incongruent ?? 0} / ${typed.unknown ?? 0} | ${reportable.congruent ?? 0} / ${reportable.incongruent ?? 0} / ${reportable.unknown ?? 0} |`;
    })
    .join('\n');

  const geometryRows = Array.isArray(payload.geometry_conformance?.checks)
    ? payload.geometry_conformance.checks
        .map((entry: any) => `| ${entry.id} | ${entry.status} | ${entry.testFile} |`)
        .join('\n')
    : '';
  const energeticsRows = Object.entries(payload.energetics_qei_conformance?.signature ?? {})
    .map(([key, value]: [string, any]) => `| ${key} | ${value?.status ?? 'unknown'} | ${value?.reason_code ?? 'n/a'} |`)
    .join('\n');
  const energeticsRowsSafe = energeticsRows.length > 0 ? energeticsRows : '| none | unknown | n/a |';

  const externalRows = Array.isArray(payload.external_work_comparison?.works)
    ? payload.external_work_comparison.works
        .map(
          (entry: any) =>
            `| ${entry.work_id} | ${entry.status} | ${entry.pass_count ?? 0} | ${entry.fail_count ?? 0} | ${entry.inconclusive_count ?? 0} | ${entry.stale_run_vs_capsule === true ? 'true' : 'false'} |`,
        )
        .join('\n')
    : '';
  const externalRowsSafe = externalRows.length > 0 ? externalRows : '| none | n/a | 0 | 0 | 0 | false |';

  return `# Full-Solve Reference Capsule (${payload.generated_on})

"${payload.boundary_statement}"

## Identity
- artifact_type: \`${payload.artifact_type}\`
- generator_version: \`${payload.generator_version}\`
- commit_pin: \`${payload.commit_pin}\`
- checksum: \`${payload.checksum}\`
- blocked: \`${payload.status?.blocked === true}\`

## Canonical State
- decision: \`${payload.canonical_state?.decision ?? 'UNKNOWN'}\`
- counts: \`PASS=${payload.canonical_state?.counts?.PASS ?? 0}, FAIL=${payload.canonical_state?.counts?.FAIL ?? 0}, UNKNOWN=${payload.canonical_state?.counts?.UNKNOWN ?? 0}, NOT_READY=${payload.canonical_state?.counts?.NOT_READY ?? 0}, NOT_APPLICABLE=${payload.canonical_state?.counts?.NOT_APPLICABLE ?? 0}\`
- strong_claim_pass_all: \`${payload.canonical_state?.strong_claim_closure?.passAll === true}\`

## Certification
- trace_id: \`${payload.certification?.latest_trace?.traceId ?? 'UNKNOWN'}\`
- run_id: \`${payload.certification?.latest_trace?.runId ?? 'UNKNOWN'}\`
- certificate_hash: \`${payload.certification?.latest_trace?.certificateHash ?? 'UNKNOWN'}\`
- integrity_ok: \`${payload.certification?.latest_trace?.integrityOk === true}\`
- status: \`${payload.certification?.latest_trace?.status ?? 'UNKNOWN'}\`

## Geometry Conformance
| check | status | test_file |
|---|---|---|
${geometryRows}

## Energetics/QEI Baseline
| key | status | reason_code |
|---|---|---|
${energeticsRowsSafe}

## GR Observable Baseline
- mercury_perihelion_status: \`${payload.gr_observables?.mercury_perihelion?.status ?? 'unknown'}\`
- predicted_arcsec_per_century: \`${payload.gr_observables?.mercury_perihelion?.predicted_arcsec_per_century ?? 'UNKNOWN'}\`
- observed_arcsec_per_century: \`${payload.gr_observables?.mercury_perihelion?.observed_arcsec_per_century ?? 'UNKNOWN'}\`
- residual_arcsec_per_century: \`${payload.gr_observables?.mercury_perihelion?.residual_arcsec_per_century ?? 'UNKNOWN'}\`
- tolerance_arcsec_per_century: \`${payload.gr_observables?.mercury_perihelion?.max_abs_residual_arcsec_per_century ?? 'UNKNOWN'}\`
- lensing_deflection_status: \`${payload.gr_observables?.lensing_deflection?.status ?? 'unknown'}\`
- lensing_predicted_limb_arcsec: \`${payload.gr_observables?.lensing_deflection?.predicted_limb_arcsec ?? 'UNKNOWN'}\`
- lensing_historical_residual_arcsec: \`${payload.gr_observables?.lensing_deflection?.historical_residual_arcsec ?? 'UNKNOWN'}\`
- lensing_modern_gamma_residual: \`${payload.gr_observables?.lensing_deflection?.modern_gamma_residual ?? 'UNKNOWN'}\`
- frame_dragging_status: \`${payload.gr_observables?.frame_dragging?.status ?? 'unknown'}\`
- frame_dragging_gpb_residual_mas_per_year: \`${payload.gr_observables?.frame_dragging?.gpb_residual_mas_per_year ?? 'UNKNOWN'}\`
- frame_dragging_lageos_residual_ratio: \`${payload.gr_observables?.frame_dragging?.lageos_residual_ratio ?? 'UNKNOWN'}\`
- shapiro_delay_status: \`${payload.gr_observables?.shapiro_delay?.status ?? 'unknown'}\`
- shapiro_gamma_minus_one: \`${payload.gr_observables?.shapiro_delay?.gamma_minus_one_measured ?? 'UNKNOWN'}\`
- shapiro_gamma_residual: \`${payload.gr_observables?.shapiro_delay?.gamma_residual ?? 'UNKNOWN'}\`
- source_snapshot_paths: \`${JSON.stringify(payload.gr_observables?.source_snapshot_paths ?? {})}\`

## Evidence Lanes (C/I/U)
| lane | typed | reportable |
|---|---|---|
${laneRows}

## External Work Comparison
- matrix_path: \`${payload.external_work_comparison?.path ?? 'UNKNOWN'}\`
- total: \`${payload.external_work_comparison?.summary_counts?.total ?? 0}\`
- compatible: \`${payload.external_work_comparison?.summary_counts?.compatible ?? 0}\`
- partial: \`${payload.external_work_comparison?.summary_counts?.partial ?? 0}\`
- inconclusive: \`${payload.external_work_comparison?.summary_counts?.inconclusive ?? 0}\`
- stale_count: \`${payload.external_work_comparison?.stale_flags?.stale_count ?? 0}\`
- reduced_reason_counts: \`${formatReasonCounts(payload.external_work_comparison?.reduced_reason_counts)}\`

| work_id | status | pass | fail | inconclusive | stale |
|---|---|---:|---:|---:|---|
${externalRowsSafe}

## Blockers
| id | severity | path | reason |
|---|---|---|---|
${blockerRows}
`;
};

export const generateFullSolveReferenceCapsule = (options: {
  outJsonPath?: string;
  outMdPath?: string;
  latestJsonPath?: string;
  latestMdPath?: string;
} = {}) => {
  const outJsonPath = options.outJsonPath ?? DEFAULT_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_OUT_MD;
  const latestJsonPath = options.latestJsonPath ?? DEFAULT_LATEST_JSON;
  const latestMdPath = options.latestMdPath ?? DEFAULT_LATEST_MD;
  const blockers: Blocker[] = [];
  const commitPin = getCommitHash();

  const canonicalReportPath = findLatestByRegex(
    DOC_AUDIT_DIR,
    /^warp-full-solve-campaign-execution-report-\d{4}-\d{2}-\d{2}\.md$/,
  );
  const decisionLedgerPath = findLatestByRegex(FULL_SOLVE_DIR, /^g4-decision-ledger-\d{4}-\d{2}-\d{2}\.json$/);
  const governanceMatrixPath = findLatestByRegex(
    FULL_SOLVE_DIR,
    /^g4-governance-matrix-\d{4}-\d{2}-\d{2}\.json$/,
  );
  const evidenceSnapshotPath = findLatestByRegex(
    FULL_SOLVE_DIR,
    /^warp-evidence-snapshot-\d{4}-\d{2}-\d{2}\.json$/,
  );
  const promotionBundlePath = findLatestByRegex(FULL_SOLVE_DIR, /^g4-promotion-bundle-\d{4}-\d{2}-\d{2}\.json$/);
  const geometryConformancePath = findLatestByRegex(
    FULL_SOLVE_DIR,
    /^geometry-conformance-\d{4}-\d{2}-\d{2}\.json$/,
  );
  const qcdReplayPath = findLatestByRegex(FULL_SOLVE_DIR, /^qcd-analog-replay-\d{4}-\d{2}-\d{2}\.json$/);
  const grMercurySnapshotPath = fs.existsSync(DEFAULT_GR_MERCURY_SNAPSHOT_PATH)
    ? DEFAULT_GR_MERCURY_SNAPSHOT_PATH
    : null;
  const grLensingSnapshotPath = fs.existsSync(DEFAULT_GR_LENSING_SNAPSHOT_PATH)
    ? DEFAULT_GR_LENSING_SNAPSHOT_PATH
    : null;
  const grFrameDraggingSnapshotPath = fs.existsSync(DEFAULT_GR_FRAME_DRAGGING_SNAPSHOT_PATH)
    ? DEFAULT_GR_FRAME_DRAGGING_SNAPSHOT_PATH
    : null;
  const grShapiroSnapshotPath = fs.existsSync(DEFAULT_GR_SHAPIRO_SNAPSHOT_PATH)
    ? DEFAULT_GR_SHAPIRO_SNAPSHOT_PATH
    : null;
  const externalWorkMatrixPath = findLatestByRegex(
    EXTERNAL_WORK_DIR,
    /^external-work-comparison-matrix-\d{4}-\d{2}-\d{2}\.json$/,
  );

  const canonicalReportText = readTextSafe(canonicalReportPath);
  const canonicalReport = parseCanonicalReportSummary(canonicalReportText);
  const decisionLedger = readJsonSafe(decisionLedgerPath);
  const governanceMatrix = readJsonSafe(governanceMatrixPath);
  const evidenceSnapshot = readJsonSafe(evidenceSnapshotPath);
  const promotionBundle = readJsonSafe(promotionBundlePath);
  const geometryConformance = readJsonSafe(geometryConformancePath);
  const qcdReplay = readJsonSafe(qcdReplayPath);
  const grMercurySnapshot = readJsonSafe(grMercurySnapshotPath);
  const grLensingSnapshot = readJsonSafe(grLensingSnapshotPath);
  const grFrameDraggingSnapshot = readJsonSafe(grFrameDraggingSnapshotPath);
  const grShapiroSnapshot = readJsonSafe(grShapiroSnapshotPath);
  const externalWorkMatrix = readJsonSafe(externalWorkMatrixPath);

  maybeAddBlocker(blockers, {
    id: 'missing_canonical_execution_report',
    severity: 'HARD',
    path: canonicalReportPath,
    reason: canonicalReportText ? null : 'required canonical report missing or unreadable',
  });
  maybeAddBlocker(blockers, {
    id: 'missing_decision_ledger',
    severity: 'HARD',
    path: decisionLedgerPath,
    reason: decisionLedger ? null : 'required decision ledger missing or unreadable',
  });
  maybeAddBlocker(blockers, {
    id: 'missing_governance_matrix',
    severity: 'HARD',
    path: governanceMatrixPath,
    reason: governanceMatrix ? null : 'required governance matrix missing or unreadable',
  });
  maybeAddBlocker(blockers, {
    id: 'missing_evidence_snapshot',
    severity: 'HARD',
    path: evidenceSnapshotPath,
    reason: evidenceSnapshot ? null : 'required evidence snapshot missing or unreadable',
  });
  maybeAddBlocker(blockers, {
    id: 'missing_promotion_bundle',
    severity: 'HARD',
    path: promotionBundlePath,
    reason: promotionBundle ? null : 'required promotion bundle missing or unreadable',
  });
  maybeAddBlocker(blockers, {
    id: 'missing_geometry_conformance',
    severity: 'HARD',
    path: geometryConformancePath,
    reason: geometryConformance ? null : 'geometry conformance artifact missing; run geometry conformance first',
  });
  maybeAddBlocker(blockers, {
    id: 'missing_qcd_replay',
    severity: 'HARD',
    path: qcdReplayPath,
    reason: qcdReplay ? null : 'required exploratory qcd replay artifact missing',
  });
  maybeAddBlocker(blockers, {
    id: 'missing_gr_mercury_snapshot',
    severity: 'SOFT',
    path: grMercurySnapshotPath,
    reason: grMercurySnapshot ? null : 'optional GR observable snapshot for Mercury precession replay is missing',
  });
  maybeAddBlocker(blockers, {
    id: 'missing_gr_lensing_snapshot',
    severity: 'SOFT',
    path: grLensingSnapshotPath,
    reason: grLensingSnapshot ? null : 'optional GR observable snapshot for lensing deflection replay is missing',
  });
  maybeAddBlocker(blockers, {
    id: 'missing_gr_frame_dragging_snapshot',
    severity: 'SOFT',
    path: grFrameDraggingSnapshotPath,
    reason: grFrameDraggingSnapshot ? null : 'optional GR observable snapshot for frame-dragging replay is missing',
  });
  maybeAddBlocker(blockers, {
    id: 'missing_gr_shapiro_snapshot',
    severity: 'SOFT',
    path: grShapiroSnapshotPath,
    reason: grShapiroSnapshot ? null : 'optional GR observable snapshot for Shapiro-delay replay is missing',
  });
  maybeAddBlocker(blockers, {
    id: 'missing_external_work_matrix',
    severity: 'HARD',
    path: externalWorkMatrixPath,
    reason: externalWorkMatrix ? null : 'external work comparison matrix artifact missing',
  });

  const reportDecision = canonicalReport.decision;
  const reportCounts = canonicalReport.counts;
  const ledgerDecision = asText(decisionLedger?.canonical?.decision);
  const ledgerCounts = parseCountsObject(decisionLedger?.canonical?.counts);
  const snapshotDecision = asText(evidenceSnapshot?.canonicalAuthoritative?.decisionLabel);
  const snapshotCounts = parseCountsObject(evidenceSnapshot?.canonicalAuthoritative?.counts);

  if (reportDecision && ledgerDecision && reportDecision !== ledgerDecision) {
    maybeAddBlocker(blockers, {
      id: 'canonical_report_vs_ledger_decision_mismatch',
      severity: 'HARD',
      path: canonicalReportPath,
      reason: `canonical report decision (${reportDecision}) differs from decision ledger (${ledgerDecision})`,
    });
  }
  if (reportCounts && !countsEqual(reportCounts, ledgerCounts)) {
    maybeAddBlocker(blockers, {
      id: 'canonical_report_vs_ledger_count_mismatch',
      severity: 'HARD',
      path: canonicalReportPath,
      reason: 'canonical report scoreboard differs from decision ledger scoreboard',
    });
  }
  if (ledgerDecision && snapshotDecision && ledgerDecision !== snapshotDecision) {
    maybeAddBlocker(blockers, {
      id: 'ledger_vs_snapshot_decision_mismatch',
      severity: 'HARD',
      path: evidenceSnapshotPath,
      reason: `snapshot decision (${snapshotDecision}) differs from decision ledger (${ledgerDecision})`,
    });
  }
  if (!countsEqual(ledgerCounts, snapshotCounts)) {
    maybeAddBlocker(blockers, {
      id: 'ledger_vs_snapshot_count_mismatch',
      severity: 'HARD',
      path: evidenceSnapshotPath,
      reason: 'snapshot canonical counts differ from decision-ledger canonical counts',
    });
  }

  if (governanceMatrix?.mismatch === true) {
    maybeAddBlocker(blockers, {
      id: 'governance_matrix_mismatch',
      severity: 'HARD',
      path: governanceMatrixPath,
      reason: asText(governanceMatrix?.mismatchReason) ?? 'governance matrix mismatch=true',
    });
  }

  const latestTrace = evidenceSnapshot?.certification?.latestTrace ?? null;
  const latestExportTrace = evidenceSnapshot?.certification?.latestExportTrace ?? null;
  const certificateHash = asText(latestTrace?.certificateHash) ?? asText(latestExportTrace?.certificateHash);
  const integrityOk = latestTrace?.integrityOk === true || latestExportTrace?.integrityOk === true;

  maybeAddBlocker(blockers, {
    id: 'missing_certificate_hash',
    severity: 'HARD',
    path: evidenceSnapshotPath,
    reason: certificateHash ? null : 'missing certificate hash in snapshot certification block',
  });
  maybeAddBlocker(blockers, {
    id: 'certificate_integrity_not_ok',
    severity: 'HARD',
    path: evidenceSnapshotPath,
    reason: integrityOk ? null : 'certificate integrity is not OK in snapshot certification block',
  });

  if (geometryConformance?.summary?.allPass !== true) {
    maybeAddBlocker(blockers, {
      id: 'geometry_conformance_failed',
      severity: 'HARD',
      path: geometryConformancePath,
      reason:
        geometryConformance?.summary != null
          ? `geometry checks failed: pass=${String(geometryConformance?.summary?.passCount ?? 0)} fail=${String(
              geometryConformance?.summary?.failCount ?? 0,
            )}`
          : 'geometry conformance summary missing',
    });
  }

  const sourceCommitMap = {
    decision_ledger: readCommitHashFromArtifact(decisionLedger),
    governance_matrix: readCommitHashFromArtifact(governanceMatrix),
    evidence_snapshot: readCommitHashFromArtifact(evidenceSnapshot),
    promotion_bundle: readCommitHashFromArtifact(promotionBundle),
    geometry_conformance: readCommitHashFromArtifact(geometryConformance),
    qcd_replay: readCommitHashFromArtifact(qcdReplay),
    external_work_matrix: readCommitHashFromArtifact(externalWorkMatrix),
  } as const;

  for (const [sourceKey, sourceCommit] of Object.entries(sourceCommitMap)) {
    if (!sourceCommit) continue;
    if (sourceCommit !== commitPin) {
      maybeAddBlocker(blockers, {
        id: `commit_pin_mismatch_${sourceKey}`,
        severity: 'HARD',
        path: null,
        reason: `source commit ${sourceCommit} does not match capsule commit pin ${commitPin}`,
      });
    }
  }

  const laneSummaries: Record<string, unknown> = {};
  const unknownInventoryByLane: Record<string, number> = {};
  for (const laneConfig of LANE_CONFIGS) {
    const typedPath = resolveLatestCompatPath(laneConfig.compatPrefix, 'typed');
    const reportablePath = resolveLatestCompatPath(laneConfig.compatPrefix, 'reportable');
    const reportableReferencePath = resolveLatestCompatPath(laneConfig.compatPrefix, 'reportable_reference');
    const typedPayload = readJsonSafe(typedPath);
    const reportablePayload = readJsonSafe(reportablePath);
    const reportableReferencePayload = readJsonSafe(reportableReferencePath);

    if (laneConfig.required && !typedPayload) {
      maybeAddBlocker(blockers, {
        id: `missing_${laneConfig.lane}_typed_summary`,
        severity: 'HARD',
        path: typedPath,
        reason: 'required lane typed compat-check artifact missing',
      });
    }

    const typedSummary = parseSummaryCounts(typedPayload ?? {});
    const reportableSummary = parseSummaryCounts(reportablePayload ?? {});
    const reportableReferenceSummary = parseSummaryCounts(reportableReferencePayload ?? {});
    unknownInventoryByLane[laneConfig.lane] = typedSummary.unknown;

    laneSummaries[laneConfig.lane] = {
      dependency_mode: 'reference_only',
      canonical_blocking: false,
      typed: {
        path: typedPath ? normalizePath(typedPath) : null,
        summary: typedSummary,
      },
      reportable: {
        path: reportablePath ? normalizePath(reportablePath) : null,
        summary: reportableSummary,
      },
      reportable_reference: {
        path: reportableReferencePath ? normalizePath(reportableReferencePath) : null,
        summary: reportableReferenceSummary,
      },
    };
  }

  const qcdStatus = asText(qcdReplay?.replay?.status);
  laneSummaries.qcd_analog = {
    dependency_mode: 'reference_only',
    canonical_blocking: false,
    replay: {
      path: qcdReplayPath ? normalizePath(qcdReplayPath) : null,
      status: qcdStatus ?? 'UNKNOWN',
      z_score_short: asNumber(qcdReplay?.replay?.derived?.shortZScore),
      z_score_long: asNumber(qcdReplay?.replay?.derived?.longZScore),
      dr_near_far_ratio: asNumber(qcdReplay?.replay?.derived?.drNearFarRatio),
      recompute_ready: asText(qcdReplay?.replay?.recomputeReady),
    },
  };

  const externalWorks = Array.isArray(externalWorkMatrix?.works) ? externalWorkMatrix.works : [];
  const externalSummaryCounts = externalWorkMatrix?.summary_counts ?? {
    total: externalWorks.length,
    compatible: 0,
    partial: 0,
    inconclusive: externalWorks.length,
  };
  const externalStaleFlags = externalWorkMatrix?.stale_flags ?? {
    stale_count: 0,
    works: [],
  };
  const externalInconclusiveReasons = externalWorkMatrix?.inconclusive_reasons ?? {};
  const externalReducedReasonCounts = externalWorkMatrix?.reduced_reason_counts ?? {};

  const canonicalDecision = reportDecision ?? ledgerDecision ?? snapshotDecision ?? 'UNKNOWN';
  const canonicalCounts = reportCounts ?? ledgerCounts ?? snapshotCounts;
  const strongClaimClosure = evidenceSnapshot?.strongClaimClosure ?? {};
  if (strongClaimClosure?.passAll !== true) {
    maybeAddBlocker(blockers, {
      id: 'strong_claim_closure_not_pass_all',
      severity: 'SOFT',
      path: evidenceSnapshotPath,
      reason: `strongClaimClosure.passAll=${String(strongClaimClosure?.passAll)}`,
    });
  }

  const hardBlockers = blockers.filter((entry) => entry.severity === 'HARD').length;
  const softBlockers = blockers.length - hardBlockers;
  const geometrySignature = buildGeometrySignature(geometryConformance);
  const energeticsQeiSignature = buildEnergeticsQeiSignature(geometrySignature);
  const mercuryPerihelionBaseline = buildMercuryPerihelionBaseline(grMercurySnapshot);
  const lensingDeflectionBaseline = buildLensingDeflectionBaseline(grLensingSnapshot);
  const frameDraggingBaseline = buildFrameDraggingBaseline(grFrameDraggingSnapshot);
  const shapiroDelayBaseline = buildShapiroDelayBaseline(grShapiroSnapshot);

  const payloadBase: Record<string, unknown> = {
    artifact_type: 'full_solve_reference_capsule/v1',
    artifactType: 'full_solve_reference_capsule/v1',
    generator_version: GENERATOR_VERSION,
    generated_on: DATE_STAMP,
    generated_at: new Date().toISOString(),
    commit_pin: commitPin,
    boundary_statement: BOUNDARY_STATEMENT,
    status: {
      blocked: hardBlockers > 0,
      blocker_count: blockers.length,
      hard_blocker_count: hardBlockers,
      soft_blocker_count: softBlockers,
    },
    canonical_state: {
      decision: canonicalDecision,
      counts: canonicalCounts,
      first_fail:
        asText(decisionLedger?.canonical?.firstFail) ?? asText(evidenceSnapshot?.canonicalAuthoritative?.firstFail),
      strong_claim_closure: {
        passAll: strongClaimClosure?.passAll === true,
        blockedSpecs: Array.isArray(strongClaimClosure?.blockedSpecs) ? strongClaimClosure.blockedSpecs : [],
      },
      precedence: {
        order: [
          'canonical_report',
          'decision_ledger',
          'governance_matrix',
          'summary_packs',
          'exploratory_overlays',
        ],
        authority: 'canonical_report',
      },
      source_commits: sourceCommitMap,
      source_file_commits: {
        canonical_report: getLastCommitForPath(canonicalReportPath),
        decision_ledger: getLastCommitForPath(decisionLedgerPath),
        governance_matrix: getLastCommitForPath(governanceMatrixPath),
        evidence_snapshot: getLastCommitForPath(evidenceSnapshotPath),
        promotion_bundle: getLastCommitForPath(promotionBundlePath),
        geometry_conformance: getLastCommitForPath(geometryConformancePath),
        qcd_replay: getLastCommitForPath(qcdReplayPath),
        gr_mercury_snapshot: getLastCommitForPath(grMercurySnapshotPath),
        gr_lensing_snapshot: getLastCommitForPath(grLensingSnapshotPath),
        gr_frame_dragging_snapshot: getLastCommitForPath(grFrameDraggingSnapshotPath),
        gr_shapiro_snapshot: getLastCommitForPath(grShapiroSnapshotPath),
        external_work_matrix: getLastCommitForPath(externalWorkMatrixPath),
      },
      source_paths: {
        canonical_report: canonicalReportPath ? normalizePath(canonicalReportPath) : null,
        decision_ledger: decisionLedgerPath ? normalizePath(decisionLedgerPath) : null,
        governance_matrix: governanceMatrixPath ? normalizePath(governanceMatrixPath) : null,
        evidence_snapshot: evidenceSnapshotPath ? normalizePath(evidenceSnapshotPath) : null,
        promotion_bundle: promotionBundlePath ? normalizePath(promotionBundlePath) : null,
      },
    },
    geometry_conformance: {
      path: geometryConformancePath ? normalizePath(geometryConformancePath) : null,
      summary: geometryConformance?.summary ?? null,
      checks: geometryConformance?.checks ?? [],
      signature: geometrySignature,
    },
    energetics_qei_conformance: {
      source: 'local_reduced_order_policy',
      summary: {
        scope: 'reference_only',
        note: 'Energetics/QEI signature is a local baseline for external method-track comparison and does not alter canonical thresholds.',
      },
      signature: energeticsQeiSignature,
    },
    gr_observables: {
      source: 'local_observable_baseline',
      source_snapshot_path: grMercurySnapshotPath ? normalizePath(grMercurySnapshotPath) : null,
      source_snapshot_paths: {
        mercury_perihelion: grMercurySnapshotPath ? normalizePath(grMercurySnapshotPath) : null,
        lensing_deflection: grLensingSnapshotPath ? normalizePath(grLensingSnapshotPath) : null,
        frame_dragging: grFrameDraggingSnapshotPath ? normalizePath(grFrameDraggingSnapshotPath) : null,
        shapiro_delay: grShapiroSnapshotPath ? normalizePath(grShapiroSnapshotPath) : null,
      },
      mercury_perihelion: mercuryPerihelionBaseline,
      lensing_deflection: lensingDeflectionBaseline,
      frame_dragging: frameDraggingBaseline,
      shapiro_delay: shapiroDelayBaseline,
    },
    external_work_comparison: {
      path: externalWorkMatrixPath ? normalizePath(externalWorkMatrixPath) : null,
      summary_counts: externalSummaryCounts,
      inconclusive_reasons: externalInconclusiveReasons,
      reduced_reason_counts: externalReducedReasonCounts,
      stale_flags: externalStaleFlags,
      works: externalWorks,
    },
    evidence_lanes: laneSummaries,
    certification: {
      latest_trace: {
        traceId: asText(latestTrace?.traceId),
        runId: asText(latestTrace?.runId),
        pass: latestTrace?.pass === true,
        firstFail: latestTrace?.firstFail ?? null,
        certificateHash: certificateHash,
        integrityOk: integrityOk,
        status: asText(latestTrace?.status) ?? asText(latestExportTrace?.status),
      },
      latest_export_trace: {
        traceId: asText(latestExportTrace?.traceId),
        runId: asText(latestExportTrace?.runId),
        pass: latestExportTrace?.pass === true,
        firstFail: latestExportTrace?.firstFail ?? null,
        certificateHash: asText(latestExportTrace?.certificateHash),
        integrityOk: latestExportTrace?.integrityOk === true,
        status: asText(latestExportTrace?.status),
      },
    },
    blocking_inventory: {
      blockers: blockers.sort((a, b) => a.id.localeCompare(b.id)),
      unknowns: {
        canonical_unknown_count: canonicalCounts.UNKNOWN,
        lane_unknowns: unknownInventoryByLane,
      },
    },
    stable_source_refs: {
      default_capsule_json: normalizePath(DEFAULT_LATEST_JSON),
      default_capsule_md: normalizePath(DEFAULT_LATEST_MD),
      draft_a: normalizePath(path.join(DOC_AUDIT_DIR, 'warp-paper-draft-A-defensible-now.md')),
      draft_b: normalizePath(path.join(DOC_AUDIT_DIR, 'warp-paper-draft-B-strong-claim-upgrade-spec.md')),
      lane_status: normalizePath(path.join(DOC_AUDIT_DIR, 'warp-evidence-lane-status-2026-03-06.md')),
      external_work_matrix_latest_json: normalizePath(path.join(EXTERNAL_WORK_DIR, 'external-work-comparison-matrix-latest.json')),
      external_work_matrix_latest_md: normalizePath(path.join(DOC_AUDIT_DIR, 'warp-external-work-comparison-matrix-latest.md')),
      external_work_profiles: normalizePath(path.join('configs', 'warp-external-work-profiles.v1.json')),
      gr_mercury_snapshot: normalizePath(DEFAULT_GR_MERCURY_SNAPSHOT_PATH),
      gr_lensing_snapshot: normalizePath(DEFAULT_GR_LENSING_SNAPSHOT_PATH),
      gr_frame_dragging_snapshot: normalizePath(DEFAULT_GR_FRAME_DRAGGING_SNAPSHOT_PATH),
      gr_shapiro_snapshot: normalizePath(DEFAULT_GR_SHAPIRO_SNAPSHOT_PATH),
    },
    paths: {
      dated_json: normalizePath(outJsonPath),
      latest_json: normalizePath(latestJsonPath),
      dated_md: normalizePath(outMdPath),
      latest_md: normalizePath(latestMdPath),
    },
  };

  const checksum = checksumPayload(payloadBase);
  const payload = { ...payloadBase, checksum };
  const markdown = renderMarkdown(payload);

  fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
  fs.mkdirSync(path.dirname(latestJsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(latestMdPath), { recursive: true });

  fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(outMdPath, `${markdown}\n`);
  fs.writeFileSync(latestJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(latestMdPath, `${markdown}\n`);

  return {
    ok: hardBlockers === 0,
    outJsonPath,
    outMdPath,
    latestJsonPath,
    latestMdPath,
    hardBlockerCount: hardBlockers,
    softBlockerCount: softBlockers,
    checksum,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = generateFullSolveReferenceCapsule({
    outJsonPath: readArgValue('--out-json') ?? DEFAULT_OUT_JSON,
    outMdPath: readArgValue('--out-md') ?? DEFAULT_OUT_MD,
    latestJsonPath: readArgValue('--latest-json') ?? DEFAULT_LATEST_JSON,
    latestMdPath: readArgValue('--latest-md') ?? DEFAULT_LATEST_MD,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}
