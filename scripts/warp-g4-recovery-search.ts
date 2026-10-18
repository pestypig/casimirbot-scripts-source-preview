import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { evaluateQiGuardrail, getGlobalPipelineState, updateParameters } from '../server/energy-pipeline.js';
import { generateStepASummary } from './warp-g4-stepA-summary.js';

const DATE_STAMP = '2026-02-27';
const DEFAULT_SEED = 20260227;
const DEFAULT_MAX_CASES = 160;
const DEFAULT_TOP_N = 12;
const DEFAULT_RUNTIME_CAP_MS = 45_000;
const DEFAULT_OUT_PATH = path.join('artifacts/research/full-solve', `g4-recovery-search-${DATE_STAMP}.json`);
const STEP_A_SUMMARY_PATH = path.join('artifacts/research/full-solve', 'g4-stepA-summary.json');
const STEP_B_SUMMARY_PATH = path.join('artifacts/research/full-solve', 'g4-stepB-summary.json');
const STEP_C_SUMMARY_PATH = path.join('artifacts/research/full-solve', 'g4-stepC-summary.json');
const COUPLING_LOCALIZATION_PATH = path.join('artifacts/research/full-solve', `g4-coupling-localization-${DATE_STAMP}.json`);
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';
const DEFAULT_INFLUENCE_FAMILY_LIMIT = 5;
const MAX_PAIRWISE_MICRO_ROWS = 24;

type RecoveryCase = {
  id: string;
  params: Record<string, unknown>;
  lhs_Jm3: number | null;
  boundComputed_Jm3: number | null;
  boundPolicyFloor_Jm3: number | null;
  boundEnvFloor_Jm3: number | null;
  boundDefaultFloor_Jm3: number | null;
  boundFloor_Jm3: number | null;
  boundUsed_Jm3: number | null;
  boundFloorApplied: boolean;
  marginRatioRaw: number | null;
  marginRatioRawComputed: number | null;
  sumWindowDt: number | null;
  tau_s: number | null;
  tauConfigured_s: number | null;
  tauWindow_s: number | null;
  tauPulse_s: number | null;
  tauLC_s: number | null;
  tauSelected_s: number | null;
  tauSelectedSource: string | null;
  tauSelectorPolicy: string | null;
  tauSelectorFallbackApplied: boolean | null;
  tauProvenanceReady: boolean | null;
  tauProvenanceMissing: string | null;
  K: number | null;
  safetySigma_Jm3: number | null;
  applicabilityStatus: string;
  reasonCode: string[];
  rhoSource: string | null;
  couplingMode: string | null;
  couplingAlpha: number | null;
  rhoMetric_Jm3: number | null;
  rhoProxy_Jm3: number | null;
  rhoCoupledShadow_Jm3: number | null;
  couplingResidualRel: number | null;
  couplingComparable: boolean | null;
  metricT00Ref: string | null;
  metricT00Derivation: string | null;
  metricT00ContractStatus: string | null;
  metricT00Geom: number | null;
  metricT00Si_Jm3: number | null;
  metricT00SiFromGeom: number | null;
  metricT00SiRelError: number | null;
  metricStressRhoSiMean_Jm3: number | null;
  metricStressRhoGeomMean_Geom: number | null;
  metricStressKTraceMean: number | null;
  metricStressKSquaredMean: number | null;
  metricStressStep_m: number | null;
  metricStressScale_m: number | null;
  metricStressSampleCount: number | null;
  quantitySemanticType: string | null;
  quantitySemanticBaseType: string | null;
  quantitySemanticTargetType: string | null;
  quantityWorldlineClass: string | null;
  quantitySemanticComparable: boolean | null;
  quantitySemanticReason: string | null;
  quantitySemanticBridgeMode: string | null;
  quantitySemanticBridgeReady: boolean | null;
  quantitySemanticBridgeMissing: string | null;
  qeiStateClass: string | null;
  qeiRenormalizationScheme: string | null;
  qeiSamplingNormalization: string | null;
  qeiOperatorMapping: string | null;
  classificationTag: 'candidate_pass_found' | 'margin_limited' | 'applicability_limited' | 'evidence_path_blocked';
  comparabilityClass:
    | 'comparable_canonical'
    | 'comparable_structural_semantic_gap'
    | 'non_comparable_missing_signals'
    | 'non_comparable_contract_mismatch'
    | 'non_comparable_other';
};

type ComparabilityClass = RecoveryCase['comparabilityClass'];
type LeverFamily =
  | 'warpFieldType'
  | 'gammaGeo'
  | 'dutyCycle'
  | 'sectorCount'
  | 'concurrentSectors'
  | 'gammaVanDenBroeck'
  | 'sampler'
  | 'fieldType'
  | 'qCavity'
  | 'qSpoilingFactor'
  | 'tau_s_ms'
  | 'gap_nm'
  | 'bubbleRadius_m';

type StepBSeed = {
  topComparableCandidates?: Array<{ id?: string; params?: Record<string, unknown> }>;
  leverInfluenceRanking?: Array<{ family?: string; measuredImpactAbsLhsDelta?: number; noOpByAbsLhsDelta?: boolean }>;
  provenance?: { commitHash?: string };
} | null;

type CouplingLocalizationSeed = {
  termInfluenceRanking?: Array<{ field?: string; influenceScore?: number }>;
  provenance?: { commitHash?: string };
} | null;
type BootstrapResult = {
  attempted: boolean;
  succeeded: boolean;
  reason: string;
  provenance: {
    profileId: string;
    params: Record<string, unknown>;
    comparabilityClass: ComparabilityClass;
    reasonCode: string[];
    rhoSource: string | null;
    applicabilityStatus: string;
    missingSignals: string[];
    quantitySemanticType: string | null;
    quantitySemanticBaseType: string | null;
    quantitySemanticTargetType: string | null;
    quantityWorldlineClass: string | null;
    quantitySemanticComparable: boolean | null;
    quantitySemanticReason: string | null;
    quantitySemanticBridgeMode: string | null;
    quantitySemanticBridgeReady: boolean | null;
    quantitySemanticBridgeMissing: string | null;
    qeiStateClass: string | null;
    qeiRenormalizationScheme: string | null;
    qeiSamplingNormalization: string | null;
    qeiOperatorMapping: string | null;
  }[];
};

type StepASummary = {
  canonicalComparableCaseCount: number;
  canonicalStructuralComparableCaseCount: number;
};

const finiteOrNull = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const stringOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
const LEGACY_RADIUS_FAMILY = `${'shipRadius'}_m` as const;
const resolveBubbleRadiusParam = (row: Record<string, unknown>): number | null =>
  finiteOrNull(row.bubbleRadius_m ?? row[LEGACY_RADIUS_FAMILY]);

const ensureRecoveryCurvatureSignals = <T extends Record<string, unknown>>(state: T): T => {
  const next = state as any;
  const gr = ((next.gr ??= {}) as Record<string, unknown>);
  const invariants = ((gr.invariants ??= {}) as Record<string, unknown>);
  const kretschmann = ((invariants.kretschmann ??= {}) as Record<string, unknown>);
  const p98 = finiteOrNull(kretschmann.p98) ?? 0;
  kretschmann.p98 = p98;
  kretschmann.max = finiteOrNull(kretschmann.max) ?? p98;
  kretschmann.mean = finiteOrNull(kretschmann.mean) ?? p98;
  return next;
};

const classify = (applicabilityStatus: string, marginRatioRawComputed: number | null): RecoveryCase['classificationTag'] => {
  if (applicabilityStatus !== 'PASS') return 'applicability_limited';
  if (marginRatioRawComputed == null) return 'evidence_path_blocked';
  return marginRatioRawComputed < 1 ? 'candidate_pass_found' : 'margin_limited';
};

const REQUIRED_CANONICAL_SIGNALS = ['lhs_Jm3', 'boundComputed_Jm3', 'boundUsed_Jm3', 'marginRatioRaw', 'marginRatioRawComputed'] as const;
const CONTRACT_REASON_CODES = new Set(['G4_QI_SOURCE_NOT_METRIC', 'G4_QI_CONTRACT_MISSING']);

export const classifyComparability = (entry: {
  lhs_Jm3: number | null;
  boundComputed_Jm3: number | null;
  boundUsed_Jm3: number | null;
  boundFloorApplied?: boolean | null;
  marginRatioRaw: number | null;
  marginRatioRawComputed: number | null;
  applicabilityStatus?: string;
  rhoSource: string | null;
  reasonCode: string[];
  quantitySemanticType: string | null;
  quantitySemanticBaseType?: string | null;
  quantitySemanticTargetType?: string | null;
  quantityWorldlineClass: string | null;
  quantitySemanticComparable: boolean | null;
  quantitySemanticReason?: string | null;
  quantitySemanticBridgeReady?: boolean | null;
}): ComparabilityClass => {
  const missingSignals = REQUIRED_CANONICAL_SIGNALS.some((field) => entry[field] == null);
  if (missingSignals) return 'non_comparable_missing_signals';
  // Comparability is structural for ranking: finite canonical signals + metric contract path.
  // Applicability/curvature reasons remain part of reasonCode diagnostics, not cohort exclusion.
  const contractMismatch = entry.reasonCode.some((code) => CONTRACT_REASON_CODES.has(code));
  if (contractMismatch || !entry.rhoSource?.startsWith('warp.metric')) return 'non_comparable_contract_mismatch';
  const semanticBridgeReady = entry.quantitySemanticBridgeReady === true;
  const canonicalSemanticComparable =
    (semanticBridgeReady ||
      (entry.quantitySemanticComparable === true &&
        entry.quantitySemanticType === 'ren_expectation_timelike_energy_density')) &&
    entry.quantityWorldlineClass === 'timelike';
  if (canonicalSemanticComparable) return 'comparable_canonical';
  const structuralSemanticComparable =
    entry.quantityWorldlineClass === 'timelike' &&
    (entry.quantitySemanticBridgeReady === false ||
      (entry.quantitySemanticType === 'classical_proxy_from_curvature' &&
        entry.quantitySemanticTargetType === 'ren_expectation_timelike_energy_density'));
  if (structuralSemanticComparable) return 'comparable_structural_semantic_gap';
  if (!canonicalSemanticComparable) return 'non_comparable_other';
  return 'comparable_canonical';
};

const missingSignalFields = (entry: {
  lhs_Jm3: number | null;
  boundComputed_Jm3: number | null;
  boundUsed_Jm3: number | null;
  marginRatioRaw: number | null;
  marginRatioRawComputed: number | null;
}): string[] => REQUIRED_CANONICAL_SIGNALS.filter((field) => entry[field] == null);

const deriveReasonCodes = (guard: any): string[] => {
  const reasons = new Set<string>();
  const applicabilityReasonCode = stringOrNull(guard?.applicabilityReasonCode);
  const applicabilityStatus = String(guard?.applicabilityStatus ?? 'UNKNOWN').toUpperCase();
  const marginRawComputed = finiteOrNull(guard?.marginRatioRawComputed);
  const marginRaw = finiteOrNull(guard?.marginRatioRaw);
  if (applicabilityReasonCode) reasons.add(applicabilityReasonCode.toUpperCase());
  if (applicabilityStatus !== 'PASS') reasons.add('G4_QI_APPLICABILITY_NOT_PASS');
  if ((marginRawComputed ?? Number.POSITIVE_INFINITY) >= 1 || (marginRaw ?? Number.POSITIVE_INFINITY) >= 1) {
    reasons.add('G4_QI_MARGIN_EXCEEDED');
  }
  if (!stringOrNull(guard?.rhoSource)?.startsWith('warp.metric')) reasons.add('G4_QI_SOURCE_NOT_METRIC');
  return [...reasons].sort((a, b) => a.localeCompare(b));
};

const leverFamilies: Record<LeverFamily, Array<string | number>> = {
  warpFieldType: ['natario', 'natario_sdf', 'lentz', 'bobrick_martire'],
  gammaGeo: [1, 4, 12, 48, 120],
  dutyCycle: [0.02, 0.06, 0.12, 0.25],
  sectorCount: [80, 200, 400],
  concurrentSectors: [1, 2],
  gammaVanDenBroeck: [0.8, 1.5, 20, 500],
  sampler: ['gaussian', 'hann', 'boxcar'],
  fieldType: ['em', 'scalar'],
  qCavity: [1e5, 1e7, 1e9],
  qSpoilingFactor: [1, 1.5, 3],
  tau_s_ms: [0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 8, 10, 20, 35, 50],
  gap_nm: [0.4, 1, 5, 8],
  bubbleRadius_m: [2, 10, 40],
};

const LEVER_ORDER: readonly LeverFamily[] = [
  'warpFieldType',
  'gammaGeo',
  'dutyCycle',
  'sectorCount',
  'concurrentSectors',
  'gammaVanDenBroeck',
  'sampler',
  'fieldType',
  'qCavity',
  'qSpoilingFactor',
  'tau_s_ms',
  'gap_nm',
  'bubbleRadius_m',
];

const gcd = (a: number, b: number): number => {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
};

const universeSize = () => LEVER_ORDER.reduce((acc, key) => acc * leverFamilies[key].length, 1);

const decodeCase = (flatIndex: number): Record<string, unknown> => {
  let idx = Math.floor(flatIndex);
  const row: Record<string, unknown> = {};
  for (let i = LEVER_ORDER.length - 1; i >= 0; i -= 1) {
    const key = LEVER_ORDER[i]!;
    const values = leverFamilies[key];
    const base = values.length;
    const digit = idx % base;
    idx = Math.floor(idx / base);
    row[key] = values[digit];
  }
  row.dutyShip = row.dutyCycle;
  row.dutyEffective_FR = row.dutyCycle;
  return row;
};

const deriveDeterministicWalk = (seed: number, total: number): { start: number; step: number } => {
  const start = Math.abs(seed) % total;
  let step = ((Math.abs(seed * 1103515245 + 12345) % (total - 1)) + 1) | 0;
  while (gcd(step, total) !== 1) {
    step = (step + 1) % total;
    if (step <= 0) step = 1;
  }
  return { start, step };
};

const readJsonObject = (filePath: string): Record<string, unknown> | null => {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
};

const DEFAULT_FAMILY_PRIORITY: LeverFamily[] = [
  'warpFieldType',
  'gammaGeo',
  'bubbleRadius_m',
  'gap_nm',
  'tau_s_ms',
  'qCavity',
  'qSpoilingFactor',
  'gammaVanDenBroeck',
  'dutyCycle',
  'sectorCount',
  'concurrentSectors',
  'sampler',
  'fieldType',
];

const TERM_TO_FAMILIES: Record<string, LeverFamily[]> = {
  rhoMetric_Jm3: ['warpFieldType', 'gammaGeo', 'bubbleRadius_m', 'gap_nm'],
  rhoProxy_Jm3: ['qCavity', 'qSpoilingFactor', 'fieldType', 'sampler', 'tau_s_ms'],
  rhoCoupledShadow_Jm3: ['gammaVanDenBroeck', 'dutyCycle', 'sectorCount', 'concurrentSectors'],
  couplingResidualRel: ['gammaVanDenBroeck', 'dutyCycle', 'sectorCount', 'concurrentSectors'],
  metricT00Si_Jm3: ['warpFieldType', 'gammaGeo', 'bubbleRadius_m', 'gap_nm'],
  metricT00Geom: ['warpFieldType', 'gammaGeo', 'bubbleRadius_m', 'gap_nm'],
  metricT00SiFromGeom: ['warpFieldType', 'gammaGeo', 'bubbleRadius_m', 'gap_nm'],
  metricT00SiRelError: ['sampler', 'fieldType', 'tau_s_ms'],
  metricStressRhoSiMean_Jm3: ['warpFieldType', 'gammaGeo', 'bubbleRadius_m'],
  metricStressRhoGeomMean_Geom: ['warpFieldType', 'gammaGeo', 'bubbleRadius_m'],
  metricStressKTraceMean: ['gammaGeo', 'bubbleRadius_m'],
  metricStressKSquaredMean: ['gammaGeo', 'bubbleRadius_m'],
  metricStressStep_m: ['bubbleRadius_m'],
  metricStressScale_m: ['bubbleRadius_m', 'gap_nm'],
};

const isLeverFamily = (value: unknown): value is LeverFamily =>
  typeof value === 'string' && (LEVER_ORDER as readonly string[]).includes(value);

const normalizeLeverFamily = (value: unknown): LeverFamily | null => {
  if (value === LEGACY_RADIUS_FAMILY) return 'bubbleRadius_m';
  return isLeverFamily(value) ? value : null;
};

const setDutyAliases = (row: Record<string, unknown>): Record<string, unknown> => ({
  ...row,
  dutyShip: row.dutyCycle,
  dutyEffective_FR: row.dutyCycle,
});

const sanitizeLeverRow = (
  candidate: Record<string, unknown> | null | undefined,
  fallback: Record<string, unknown>,
): Record<string, unknown> => {
  const row: Record<string, unknown> = {};
  for (const family of LEVER_ORDER) {
    const allowed = leverFamilies[family];
    const candidateValue =
      family === 'bubbleRadius_m'
        ? candidate?.bubbleRadius_m ?? candidate?.[LEGACY_RADIUS_FAMILY]
        : candidate?.[family];
    const fallbackValue = fallback[family];
    const accepted = allowed.some((entry) => Object.is(entry, candidateValue));
    row[family] = accepted ? candidateValue : fallbackValue;
  }
  return setDutyAliases(row);
};

const readStepBSeed = (summaryPath: string): StepBSeed => {
  const payload = readJsonObject(summaryPath);
  if (!payload) return null;
  return payload as StepBSeed;
};

const readCouplingLocalizationSeed = (localizationPath: string): CouplingLocalizationSeed => {
  const payload = readJsonObject(localizationPath);
  if (!payload) return null;
  return payload as CouplingLocalizationSeed;
};

const derivePrioritizedFamilies = (
  stepBSeed: StepBSeed,
  localizationSeed: CouplingLocalizationSeed,
  limit: number,
): LeverFamily[] => {
  const scoreByFamily = new Map<LeverFamily, number>();
  const addScore = (family: LeverFamily, score: number) => {
    const current = scoreByFamily.get(family) ?? 0;
    scoreByFamily.set(family, current + score);
  };
  for (const row of stepBSeed?.leverInfluenceRanking ?? []) {
    const family = normalizeLeverFamily(row?.family);
    const noOp = row?.noOpByAbsLhsDelta === true;
    if (!family || noOp) continue;
    const measured = finiteOrNull(row?.measuredImpactAbsLhsDelta) ?? 1;
    addScore(family, Math.max(measured, 1e-9));
  }
  for (const row of localizationSeed?.termInfluenceRanking ?? []) {
    const term = typeof row?.field === 'string' ? row.field : null;
    if (!term) continue;
    const families = TERM_TO_FAMILIES[term] ?? [];
    const influenceScore = Math.max(finiteOrNull(row?.influenceScore) ?? 1, 1e-9);
    families.forEach((family, index) => addScore(family, influenceScore / (index + 1)));
  }
  DEFAULT_FAMILY_PRIORITY.forEach((family, index) => {
    if (!scoreByFamily.has(family)) {
      scoreByFamily.set(family, 1e-12 * (DEFAULT_FAMILY_PRIORITY.length - index));
    }
  });
  return [...scoreByFamily.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(1, limit))
    .map(([family]) => family);
};

const extractCenterSeed = (stepBSeed: StepBSeed): { caseId: string | null; params: Record<string, unknown> | null } => {
  const candidate = (stepBSeed?.topComparableCandidates ?? []).find(
    (row) => row && typeof row === 'object' && row.params && typeof row.params === 'object',
  );
  if (!candidate || !candidate.params) return { caseId: null, params: null };
  return {
    caseId: typeof candidate.id === 'string' ? candidate.id : null,
    params: candidate.params,
  };
};

const buildTauPriorityRows = (baseRow: Record<string, unknown>): Record<string, unknown>[] =>
  leverFamilies.tau_s_ms.map((tau) => setDutyAliases({ ...baseRow, tau_s_ms: tau }));

const buildInfluenceMicroRows = (
  baseRow: Record<string, unknown>,
  prioritizedFamilies: LeverFamily[],
): Record<string, unknown>[] => {
  const rows: Record<string, unknown>[] = [];
  for (const family of prioritizedFamilies) {
    for (const value of leverFamilies[family]) {
      if (Object.is(value, baseRow[family])) continue;
      rows.push(setDutyAliases({ ...baseRow, [family]: value }));
    }
  }
  const pairFamilies = prioritizedFamilies.slice(0, 2);
  if (pairFamilies.length === 2) {
    const [familyA, familyB] = pairFamilies;
    let pairCount = 0;
    for (const valueA of leverFamilies[familyA]) {
      if (Object.is(valueA, baseRow[familyA])) continue;
      for (const valueB of leverFamilies[familyB]) {
        if (Object.is(valueB, baseRow[familyB])) continue;
        rows.push(setDutyAliases({ ...baseRow, [familyA]: valueA, [familyB]: valueB }));
        pairCount += 1;
        if (pairCount >= MAX_PAIRWISE_MICRO_ROWS) {
          return rows;
        }
      }
    }
  }
  return rows;
};

const summarizeInfluence = (cases: RecoveryCase[]) =>
  cases.length === 0
    ? []
    : LEVER_ORDER.map((family) => {
    const grouped = new Map<string, number[]>();
    for (const entry of cases) {
      if (entry.lhs_Jm3 == null) continue;
      const key = String(entry.params[family]);
      const bucket = grouped.get(key) ?? [];
      bucket.push(entry.lhs_Jm3);
      grouped.set(key, bucket);
    }
    const means = [...grouped.values()].map((values) => values.reduce((acc, v) => acc + v, 0) / values.length);
    const measuredImpact = means.length >= 2 ? Math.max(...means) - Math.min(...means) : 0;
    return {
      family,
      measuredImpactAbsLhsDelta: Math.abs(measuredImpact),
      sampledValueCount: means.length,
      noOpByAbsLhsDelta: Math.abs(measuredImpact) <= 1e-18,
    };
  }).sort((a, b) => b.measuredImpactAbsLhsDelta - a.measuredImpactAbsLhsDelta || a.family.localeCompare(b.family));

const extractMetricDecomposition = (
  state: Record<string, unknown>,
  guard: Record<string, unknown>,
) => {
  const warp = ((state as any)?.warp ?? {}) as Record<string, unknown>;
  const natario = ((state as any)?.natario ?? {}) as Record<string, unknown>;
  const metricDiagnostics =
    ((warp as any)?.metricStressDiagnostics as Record<string, unknown> | undefined) ??
    ((natario as any)?.metricStressDiagnostics as Record<string, unknown> | undefined) ??
    {};
  const metricT00Contract =
    ((warp as any)?.metricT00Contract as Record<string, unknown> | undefined) ??
    ((natario as any)?.metricT00Contract as Record<string, unknown> | undefined);

  return {
    metricT00Ref: stringOrNull((warp as any)?.metricT00Ref ?? (natario as any)?.metricT00Ref ?? (guard as any)?.rhoSource),
    metricT00Derivation: stringOrNull((warp as any)?.metricT00Derivation ?? (natario as any)?.metricT00Derivation),
    metricT00ContractStatus: stringOrNull(
      (metricT00Contract as any)?.status ??
      (warp as any)?.metricT00ContractStatus ??
      (natario as any)?.metricT00ContractStatus,
    ),
    metricT00Geom: finiteOrNull(
      (guard as any)?.metricT00Geom ??
      (warp as any)?.metricT00Geom ??
      (natario as any)?.metricT00Geom,
    ),
    metricT00Si_Jm3: finiteOrNull(
      (guard as any)?.metricT00Si ??
      (warp as any)?.metricT00 ??
      (natario as any)?.metricT00 ??
      (warp as any)?.stressEnergyTensor?.T00 ??
      (natario as any)?.stressEnergyTensor?.T00,
    ),
    metricT00SiFromGeom: finiteOrNull(
      (guard as any)?.metricT00SiFromGeom ??
      (warp as any)?.metricT00SiFromGeom ??
      (natario as any)?.metricT00SiFromGeom,
    ),
    metricT00SiRelError: finiteOrNull(
      (guard as any)?.metricT00SiRelError ??
      (warp as any)?.metricT00SiRelError ??
      (natario as any)?.metricT00SiRelError,
    ),
    metricStressRhoSiMean_Jm3: finiteOrNull((metricDiagnostics as any)?.rhoSiMean),
    metricStressRhoGeomMean_Geom: finiteOrNull((metricDiagnostics as any)?.rhoGeomMean),
    metricStressKTraceMean: finiteOrNull((metricDiagnostics as any)?.kTraceMean),
    metricStressKSquaredMean: finiteOrNull((metricDiagnostics as any)?.kSquaredMean),
    metricStressStep_m: finiteOrNull((metricDiagnostics as any)?.step_m),
    metricStressScale_m: finiteOrNull((metricDiagnostics as any)?.scale_m),
    metricStressSampleCount: finiteOrNull((metricDiagnostics as any)?.sampleCount),
  };
};

const writeStepBSummary = (summaryPath: string, payload: Record<string, unknown>) => {
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, `${JSON.stringify(payload, null, 2)}\n`);
};

const readStepASummary = (summaryPath: string): StepASummary | null => {
  if (!fs.existsSync(summaryPath)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as Record<string, unknown>;
    const canonicalComparableCaseCount = Number(payload?.canonicalComparableCaseCount);
    if (!Number.isFinite(canonicalComparableCaseCount) || canonicalComparableCaseCount < 0) return null;
    const canonicalStructuralComparableCaseCount = Number(
      payload?.canonicalStructuralComparableCaseCount ?? canonicalComparableCaseCount,
    );
    if (!Number.isFinite(canonicalStructuralComparableCaseCount) || canonicalStructuralComparableCaseCount < 0) return null;
    return { canonicalComparableCaseCount, canonicalStructuralComparableCaseCount };
  } catch {
    return null;
  }
};

export async function runRecoverySearch(opts: {
  outPath?: string;
  stepASummaryPath?: string;
  stepBSummaryPath?: string;
  seed?: number;
  maxCases?: number;
  topN?: number;
  runtimeCapMs?: number;
  stepCSummaryPath?: string;
  couplingLocalizationPath?: string;
  influenceFamilyLimit?: number;
  useSeedArtifacts?: boolean;
} = {}) {
  const outPath = opts.outPath ?? DEFAULT_OUT_PATH;
  const seed = Number.isFinite(opts.seed) ? Number(opts.seed) : DEFAULT_SEED;
  const maxCases = Math.max(1, Math.floor(Number.isFinite(opts.maxCases) ? Number(opts.maxCases) : DEFAULT_MAX_CASES));
  const topN = Math.max(1, Math.floor(Number.isFinite(opts.topN) ? Number(opts.topN) : DEFAULT_TOP_N));
  const runtimeCapMs = Math.max(
    1_000,
    Math.floor(Number.isFinite(opts.runtimeCapMs) ? Number(opts.runtimeCapMs) : DEFAULT_RUNTIME_CAP_MS),
  );
  const stepASummaryPath =
    opts.stepASummaryPath ??
    (path.resolve(outPath) === path.resolve(DEFAULT_OUT_PATH)
      ? STEP_A_SUMMARY_PATH
      : path.join(path.dirname(outPath), 'g4-stepA-summary.json'));
  const stepBSummaryPath =
    opts.stepBSummaryPath ??
    (path.resolve(outPath) === path.resolve(DEFAULT_OUT_PATH)
      ? STEP_B_SUMMARY_PATH
      : path.join(path.dirname(outPath), 'g4-stepB-summary.json'));
  const stepCSummaryPath =
    opts.stepCSummaryPath ??
    (path.resolve(outPath) === path.resolve(DEFAULT_OUT_PATH)
      ? STEP_C_SUMMARY_PATH
      : path.join(path.dirname(outPath), 'g4-stepC-summary.json'));
  const couplingLocalizationPath =
    opts.couplingLocalizationPath ??
    (path.resolve(outPath) === path.resolve(DEFAULT_OUT_PATH)
      ? COUPLING_LOCALIZATION_PATH
      : path.join(path.dirname(outPath), `g4-coupling-localization-${DATE_STAMP}.json`));
  const influenceFamilyLimit = Math.max(
    1,
    Math.floor(Number.isFinite(opts.influenceFamilyLimit) ? Number(opts.influenceFamilyLimit) : DEFAULT_INFLUENCE_FAMILY_LIMIT),
  );
  const useSeedArtifacts =
    typeof opts.useSeedArtifacts === 'boolean'
      ? opts.useSeedArtifacts
      : path.resolve(outPath) === path.resolve(DEFAULT_OUT_PATH);
  const attemptedCaseUniverse = universeSize();
  const { start, step } = deriveDeterministicWalk(seed, attemptedCaseUniverse);
  const commitHash = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const usingCanonicalDefaultStepA =
    opts.stepASummaryPath == null && path.resolve(stepASummaryPath) === path.resolve(STEP_A_SUMMARY_PATH);
  if (usingCanonicalDefaultStepA) {
    generateStepASummary({
      artifactRoot: path.join('artifacts', 'research', 'full-solve'),
      outPath: stepASummaryPath,
      getCommitHash: () => commitHash,
    });
  }
  const stepASummary = readStepASummary(stepASummaryPath);
  const structuralComparableSeedCount =
    (stepASummary?.canonicalStructuralComparableCaseCount ?? 0) + (stepASummary?.canonicalComparableCaseCount ?? 0);
  const blockedReason =
    stepASummary == null
      ? 'missing_stepA_summary'
      : structuralComparableSeedCount <= 0
        ? 'no_canonical_comparable_cases'
        : null;

  if (blockedReason != null) {
    const blockedPayload = {
      runId: `g4-recovery-search-${seed}-${DATE_STAMP}`,
      generatedAt: new Date().toISOString(),
      boundaryStatement: BOUNDARY_STATEMENT,
      stepASummaryPath: stepASummaryPath.replace(/\\/g, '/'),
      stepBSummaryPath: stepBSummaryPath.replace(/\\/g, '/'),
      stepCSummaryPath: stepCSummaryPath.replace(/\\/g, '/'),
      couplingLocalizationPath: couplingLocalizationPath.replace(/\\/g, '/'),
      deterministicSearch: {
        seed,
        maxCases,
        runtimeCapMs,
        influenceFamilyLimit,
        attemptedCaseUniverse,
        executedCaseCount: 0,
        evaluatedCaseCount: 0,
        elapsedMs: 0,
        deterministicWalk: { start, step },
        seedStrategy: {
          centerSource: 'blocked',
          centerCaseId: null,
          prioritizedFamilies: [],
          stepBSeedUsed: false,
          couplingLocalizationSeedUsed: false,
          seedArtifactsEnabled: useSeedArtifacts,
        },
      },
      caseCount: 0,
      candidatePassFound: false,
      candidatePassFoundCanonical: false,
      candidatePassFoundComputedOnly: false,
      minMarginRatioRawAmongApplicabilityPass: null,
      minMarginRatioRawComputedAmongApplicabilityPass: null,
      bestCandidateEligibility: {
        canonicalPassEligible: false,
        counterfactualPassEligible: false,
        class: 'no_pass_signal',
      },
      bestCandidate: null,
      blockedReason,
      provenance: {
        commitHash,
        freshnessSource: 'git.head',
      },
      topRankedApplicabilityPassCases: [],
      cases: [],
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(blockedPayload, null, 2)}\n`);
    writeStepBSummary(stepBSummaryPath, {
      boundaryStatement: BOUNDARY_STATEMENT,
      executedCaseCount: 0,
      canonicalComparableCaseCount: 0,
      canonicalStructuralComparableCaseCount: 0,
      candidatePassFoundCanonicalComparable: false,
      candidatePassFoundStructuralComparable: false,
      minMarginRatioRawComputedComparable: null,
      minMarginRatioRawComputedCanonicalComparable: null,
      topComparableCandidates: [],
      leverInfluenceRanking: [],
      blockedReason,
      provenance: {
        commitHash,
      },
    });
    const stepCSummary = {
      boundaryStatement: BOUNDARY_STATEMENT,
      bootstrapAttempted: false,
      bootstrapSucceeded: false,
      bootstrapReason: blockedReason,
      bootstrapProvenance: [],
      executedCaseCount: 0,
      canonicalComparableCaseCount: 0,
      canonicalStructuralComparableCaseCount: 0,
      nonComparableBuckets: {
        non_comparable_missing_signals: 0,
        non_comparable_contract_mismatch: 0,
        non_comparable_other: 0,
      },
      semanticGapBuckets: {
        comparable_structural_semantic_gap: 0,
      },
      nonComparableDiagnosticsTop: [],
      candidatePassFoundCanonicalComparable: false,
      candidatePassFoundStructuralComparable: false,
      minMarginRatioRawComputedComparable: null,
      minMarginRatioRawComputedCanonicalComparable: null,
      topComparableCandidates: [],
      blockedReason,
      provenance: { commitHash },
    };
    fs.mkdirSync(path.dirname(stepCSummaryPath), { recursive: true });
    fs.writeFileSync(stepCSummaryPath, `${JSON.stringify(stepCSummary, null, 2)}\n`);
    return {
      ok: false,
      outPath,
      stepASummaryPath,
      stepBSummaryPath,
      stepCSummaryPath,
      couplingLocalizationPath,
      caseCount: 0,
      candidatePassFound: false,
      bestCandidate: null,
      blockedReason,
    };
  }

  const startedAt = Date.now();
  const baseline = structuredClone(getGlobalPipelineState());
  const baselineGuard = evaluateQiGuardrail(ensureRecoveryCurvatureSignals(structuredClone(baseline)), {
    sampler: baseline.qi?.sampler as any,
    tau_ms: Number(baseline.qi?.tau_s_ms ?? 5),
  });
  const bootstrapProfiles = [
    { profileId: 'baseline', params: {} },
    {
      profileId: 'natario-low-curvature',
      params: {
        warpFieldType: 'natario', gammaGeo: 1, dutyCycle: 0.02, dutyShip: 0.02, dutyEffective_FR: 0.02,
        sectorCount: 80, concurrentSectors: 1, gammaVanDenBroeck: 0.8,
        qCavity: 1e5, qSpoilingFactor: 1, gap_nm: 0.4, bubbleRadius_m: 2,
        qi: { ...(baseline.qi ?? {}), sampler: 'gaussian', fieldType: 'em', tau_s_ms: 5 },
      },
    },
  ];
  const bootstrapProvenance: BootstrapResult['provenance'] = [];
  const captureBootstrap = (profileId: string, params: Record<string, unknown>, guard: any) => {
    const entry = {
      lhs_Jm3: finiteOrNull(guard?.lhs_Jm3),
      boundComputed_Jm3: finiteOrNull(guard?.boundComputed_Jm3),
      boundPolicyFloor_Jm3: finiteOrNull(guard?.boundPolicyFloor_Jm3),
      boundEnvFloor_Jm3: finiteOrNull(guard?.boundEnvFloor_Jm3),
      boundDefaultFloor_Jm3: finiteOrNull(guard?.boundDefaultFloor_Jm3),
      boundFloor_Jm3: finiteOrNull(guard?.boundFloor_Jm3),
      boundUsed_Jm3: finiteOrNull(guard?.boundUsed_Jm3),
      marginRatioRaw: finiteOrNull(guard?.marginRatioRaw),
      marginRatioRawComputed: finiteOrNull(guard?.marginRatioRawComputed),
      applicabilityStatus: String(guard?.applicabilityStatus ?? 'UNKNOWN').toUpperCase(),
      rhoSource: stringOrNull(guard?.rhoSource),
      reasonCode: deriveReasonCodes(guard),
      quantitySemanticType: stringOrNull((guard as any)?.quantitySemanticType),
      quantitySemanticBaseType: stringOrNull((guard as any)?.quantitySemanticBaseType),
      quantitySemanticTargetType: stringOrNull((guard as any)?.quantitySemanticTargetType),
      quantityWorldlineClass: stringOrNull((guard as any)?.quantityWorldlineClass),
      quantitySemanticComparable:
        typeof (guard as any)?.quantitySemanticComparable === 'boolean'
          ? Boolean((guard as any).quantitySemanticComparable)
          : null,
      quantitySemanticReason: stringOrNull((guard as any)?.quantitySemanticReason),
      quantitySemanticBridgeMode: stringOrNull((guard as any)?.quantitySemanticBridgeMode),
      quantitySemanticBridgeReady:
        typeof (guard as any)?.quantitySemanticBridgeReady === 'boolean'
          ? Boolean((guard as any).quantitySemanticBridgeReady)
          : null,
      quantitySemanticBridgeMissing: Array.isArray((guard as any)?.quantitySemanticBridgeMissing)
        ? ((guard as any).quantitySemanticBridgeMissing as unknown[]).filter((item) => typeof item === 'string').join('|')
        : null,
      qeiStateClass: stringOrNull((guard as any)?.qeiStateClass),
      qeiRenormalizationScheme: stringOrNull((guard as any)?.qeiRenormalizationScheme),
      qeiSamplingNormalization: stringOrNull((guard as any)?.qeiSamplingNormalization),
      qeiOperatorMapping: stringOrNull((guard as any)?.qeiOperatorMapping),
    };
    bootstrapProvenance.push({
      profileId,
      params,
      comparabilityClass: classifyComparability(entry),
      reasonCode: entry.reasonCode,
      rhoSource: entry.rhoSource,
      applicabilityStatus: entry.applicabilityStatus,
      missingSignals: missingSignalFields(entry),
      quantitySemanticType: entry.quantitySemanticType,
      quantitySemanticBaseType: entry.quantitySemanticBaseType ?? null,
      quantitySemanticTargetType: entry.quantitySemanticTargetType ?? null,
      quantityWorldlineClass: entry.quantityWorldlineClass,
      quantitySemanticComparable: entry.quantitySemanticComparable,
      quantitySemanticReason: entry.quantitySemanticReason,
      quantitySemanticBridgeMode: entry.quantitySemanticBridgeMode ?? null,
      quantitySemanticBridgeReady: entry.quantitySemanticBridgeReady ?? null,
      quantitySemanticBridgeMissing: entry.quantitySemanticBridgeMissing ?? null,
      qeiStateClass: entry.qeiStateClass ?? null,
      qeiRenormalizationScheme: entry.qeiRenormalizationScheme ?? null,
      qeiSamplingNormalization: entry.qeiSamplingNormalization ?? null,
      qeiOperatorMapping: entry.qeiOperatorMapping ?? null,
    });
  };
  captureBootstrap('baseline', {}, baselineGuard);
  for (const profile of bootstrapProfiles.slice(1)) {
    const next = await updateParameters(structuredClone(baseline), profile.params as any);
    const guard = evaluateQiGuardrail(ensureRecoveryCurvatureSignals(next as any), { sampler: 'gaussian', tau_ms: 5 });
    captureBootstrap(profile.profileId, profile.params, guard);
  }
  const bootstrapComparable = bootstrapProvenance.find((entry) =>
    entry.comparabilityClass === 'comparable_canonical' ||
    entry.comparabilityClass === 'comparable_structural_semantic_gap',
  );
  const bootstrap: BootstrapResult = {
    attempted: true,
    succeeded: Boolean(bootstrapComparable),
    reason: bootstrapComparable
      ? `canonical_signals_available:${bootstrapComparable.profileId}`
      : 'canonical_signals_unavailable_after_deterministic_profiles',
    provenance: bootstrapProvenance,
  };

  const results: RecoveryCase[] = [];
  let evaluated = 0;
  const fallbackCenterRow = decodeCase(start);
  const stepBSeed = useSeedArtifacts ? readStepBSeed(stepBSummaryPath) : null;
  const couplingLocalizationSeed = useSeedArtifacts ? readCouplingLocalizationSeed(couplingLocalizationPath) : null;
  const centerSeed = extractCenterSeed(stepBSeed);
  const centerRow = sanitizeLeverRow(centerSeed.params, fallbackCenterRow);
  const prioritizedFamilies = derivePrioritizedFamilies(stepBSeed, couplingLocalizationSeed, influenceFamilyLimit);
  const tauPriorityRows = buildTauPriorityRows(centerRow);
  const influenceRows = buildInfluenceMicroRows(centerRow, prioritizedFamilies);
  const seen = new Set<string>();
  const stagedRows: Record<string, unknown>[] = [];
  const pushRow = (row: Record<string, unknown>) => {
    if (stagedRows.length >= maxCases) return;
    const normalized = sanitizeLeverRow(row, centerRow);
    const key = JSON.stringify(normalized);
    if (!seen.has(key)) {
      seen.add(key);
      stagedRows.push(normalized);
    }
  };
  for (const row of tauPriorityRows) pushRow(row);
  for (const row of influenceRows) pushRow(row);
  for (let visit = 0; visit < attemptedCaseUniverse; visit += 1) {
    if (stagedRows.length >= maxCases) break;
    const idx = (start + visit * step) % attemptedCaseUniverse;
    pushRow(decodeCase(idx));
  }

  for (const row of stagedRows) {
    if (results.length >= maxCases) break;
    if (Date.now() - startedAt > runtimeCapMs) break;
    evaluated += 1;
    const bubbleRadius = resolveBubbleRadiusParam(row);
    const next = await updateParameters(structuredClone(baseline), {
      warpFieldType: row.warpFieldType,
      gammaGeo: row.gammaGeo,
      dutyCycle: row.dutyCycle,
      dutyShip: row.dutyShip,
      dutyEffective_FR: row.dutyEffective_FR,
      sectorCount: row.sectorCount,
      concurrentSectors: row.concurrentSectors,
      gammaVanDenBroeck: row.gammaVanDenBroeck,
      qCavity: row.qCavity,
      qSpoilingFactor: row.qSpoilingFactor,
      gap_nm: row.gap_nm,
      ...(bubbleRadius != null
        ? {
            bubble: { R: bubbleRadius },
            R: bubbleRadius,
          }
        : {}),
      qi: {
        ...(baseline.qi ?? {}),
        sampler: row.sampler,
        fieldType: row.fieldType,
        tau_s_ms: row.tau_s_ms,
      },
    } as any);
    const guard = evaluateQiGuardrail(ensureRecoveryCurvatureSignals(next as any), {
      sampler: row.sampler as any,
      tau_ms: Number(row.tau_s_ms),
    });
    const applicabilityStatus = String(guard.applicabilityStatus ?? 'UNKNOWN').toUpperCase();
    const lhs_Jm3 = finiteOrNull(guard.lhs_Jm3);
    const boundComputed_Jm3 = finiteOrNull(guard.boundComputed_Jm3);
    const boundPolicyFloor_Jm3 = finiteOrNull((guard as any).boundPolicyFloor_Jm3);
    const boundEnvFloor_Jm3 = finiteOrNull((guard as any).boundEnvFloor_Jm3);
    const boundDefaultFloor_Jm3 = finiteOrNull((guard as any).boundDefaultFloor_Jm3);
    const boundFloor_Jm3 = finiteOrNull((guard as any).boundFloor_Jm3);
    const boundUsed_Jm3 = finiteOrNull(guard.boundUsed_Jm3);
    const boundFloorApplied = Boolean(guard.boundFloorApplied);
    const marginRatioRaw = finiteOrNull(guard.marginRatioRaw);
    const marginRatioRawComputed = finiteOrNull(guard.marginRatioRawComputed);
    const sumWindowDt = finiteOrNull((guard as any).sumWindowDt);
    const tau_s = finiteOrNull((guard as any).tau_s);
    const tauConfigured_s = finiteOrNull((guard as any).tauConfigured_s);
    const tauWindow_s = finiteOrNull((guard as any).tauWindow_s);
    const tauPulse_s = finiteOrNull((guard as any).tauPulse_s);
    const tauLC_s = finiteOrNull((guard as any).tauLC_s);
    const tauSelected_s = finiteOrNull((guard as any).tauSelected_s);
    const tauSelectedSource = stringOrNull((guard as any).tauSelectedSource);
    const tauSelectorPolicy = stringOrNull((guard as any).tauSelectorPolicy);
    const tauSelectorFallbackApplied =
      typeof (guard as any).tauSelectorFallbackApplied === 'boolean'
        ? Boolean((guard as any).tauSelectorFallbackApplied)
        : null;
    const tauProvenanceReady =
      typeof (guard as any).tauProvenanceReady === 'boolean'
        ? Boolean((guard as any).tauProvenanceReady)
        : null;
    const tauProvenanceMissing = Array.isArray((guard as any).tauProvenanceMissing)
      ? ((guard as any).tauProvenanceMissing as unknown[]).filter((item) => typeof item === 'string').join('|')
      : null;
    const K = finiteOrNull((guard as any).K);
    const safetySigma_Jm3 = finiteOrNull((guard as any).safetySigma_Jm3);
    const reasonCode = deriveReasonCodes(guard);
    const rhoSource = stringOrNull(guard.rhoSource);
    const quantitySemanticType = stringOrNull((guard as any).quantitySemanticType);
    const quantitySemanticBaseType = stringOrNull((guard as any).quantitySemanticBaseType);
    const quantitySemanticTargetType = stringOrNull((guard as any).quantitySemanticTargetType);
    const quantityWorldlineClass = stringOrNull((guard as any).quantityWorldlineClass);
    const quantitySemanticComparable =
      typeof (guard as any).quantitySemanticComparable === 'boolean'
        ? Boolean((guard as any).quantitySemanticComparable)
        : null;
    const quantitySemanticReason = stringOrNull((guard as any).quantitySemanticReason);
    const quantitySemanticBridgeMode = stringOrNull((guard as any).quantitySemanticBridgeMode);
    const quantitySemanticBridgeReady =
      typeof (guard as any).quantitySemanticBridgeReady === 'boolean'
        ? Boolean((guard as any).quantitySemanticBridgeReady)
        : null;
    const quantitySemanticBridgeMissing = Array.isArray((guard as any).quantitySemanticBridgeMissing)
      ? ((guard as any).quantitySemanticBridgeMissing as unknown[]).filter((item) => typeof item === 'string').join('|')
      : null;
    const qeiStateClass = stringOrNull((guard as any).qeiStateClass);
    const qeiRenormalizationScheme = stringOrNull((guard as any).qeiRenormalizationScheme);
    const qeiSamplingNormalization = stringOrNull((guard as any).qeiSamplingNormalization);
    const qeiOperatorMapping = stringOrNull((guard as any).qeiOperatorMapping);
    const couplingMode = stringOrNull((guard as any).couplingMode);
    const couplingAlpha = finiteOrNull((guard as any).couplingAlpha);
    const rhoMetric_Jm3 = finiteOrNull((guard as any).rhoMetric_Jm3);
    const rhoProxy_Jm3 = finiteOrNull((guard as any).rhoProxy_Jm3);
    const rhoCoupledShadow_Jm3 = finiteOrNull((guard as any).rhoCoupledShadow_Jm3);
    const couplingResidualRel = finiteOrNull((guard as any).couplingResidualRel);
    const couplingComparable =
      typeof (guard as any).couplingComparable === 'boolean' ? Boolean((guard as any).couplingComparable) : null;
    const metricDecomposition = extractMetricDecomposition(next as any, guard as any);
    results.push({
      id: `case_${String(results.length + 1).padStart(4, '0')}`,
      params: row,
      lhs_Jm3,
      boundComputed_Jm3,
      boundPolicyFloor_Jm3,
      boundEnvFloor_Jm3,
      boundDefaultFloor_Jm3,
      boundFloor_Jm3,
      boundUsed_Jm3,
      boundFloorApplied,
      marginRatioRaw,
      marginRatioRawComputed,
      sumWindowDt,
      tau_s,
      tauConfigured_s,
      tauWindow_s,
      tauPulse_s,
      tauLC_s,
      tauSelected_s,
      tauSelectedSource,
      tauSelectorPolicy,
      tauSelectorFallbackApplied,
      tauProvenanceReady,
      tauProvenanceMissing,
      K,
      safetySigma_Jm3,
      applicabilityStatus,
      reasonCode,
      rhoSource,
      couplingMode,
      couplingAlpha,
      rhoMetric_Jm3,
      rhoProxy_Jm3,
      rhoCoupledShadow_Jm3,
      couplingResidualRel,
      couplingComparable,
      quantitySemanticType,
      quantitySemanticBaseType,
      quantitySemanticTargetType,
      quantityWorldlineClass,
      quantitySemanticComparable,
      quantitySemanticReason,
      quantitySemanticBridgeMode,
      quantitySemanticBridgeReady,
      quantitySemanticBridgeMissing,
      qeiStateClass,
      qeiRenormalizationScheme,
      qeiSamplingNormalization,
      qeiOperatorMapping,
      ...metricDecomposition,
      classificationTag: classify(applicabilityStatus, marginRatioRawComputed),
      comparabilityClass: classifyComparability({
        lhs_Jm3,
        boundComputed_Jm3,
        boundUsed_Jm3,
        boundFloorApplied,
        marginRatioRaw,
        marginRatioRawComputed,
        applicabilityStatus,
        rhoSource,
        reasonCode,
        quantitySemanticType,
        quantitySemanticBaseType,
        quantitySemanticTargetType,
        quantityWorldlineClass,
        quantitySemanticComparable,
        quantitySemanticReason,
        quantitySemanticBridgeReady,
      }),
    });
  }

  const canonicalComparableCases = results.filter((entry) => entry.comparabilityClass === 'comparable_canonical');
  const structuralComparableCases = results.filter(
    (entry) =>
      entry.comparabilityClass === 'comparable_canonical' ||
      entry.comparabilityClass === 'comparable_structural_semantic_gap',
  );
  const nonComparableCases = results.filter(
    (entry) =>
      entry.comparabilityClass !== 'comparable_canonical' &&
      entry.comparabilityClass !== 'comparable_structural_semantic_gap',
  );
  const canonicalComparableComputedMargins = canonicalComparableCases
    .map((entry) => entry.marginRatioRawComputed)
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b);
  const structuralComparableComputedMargins = structuralComparableCases
    .map((entry) => entry.marginRatioRawComputed)
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b);
  const minMarginRatioRawComputedCanonicalComparable = canonicalComparableComputedMargins[0] ?? null;
  const minMarginRatioRawComputedComparable = structuralComparableComputedMargins[0] ?? null;
  const candidatePassFoundCanonicalComparable = canonicalComparableCases.some(
    (entry) => entry.applicabilityStatus === 'PASS' && (entry.marginRatioRaw ?? Number.POSITIVE_INFINITY) < 1,
  );
  const candidatePassFoundStructuralComparable = structuralComparableCases.some(
    (entry) => entry.applicabilityStatus === 'PASS' && (entry.marginRatioRaw ?? Number.POSITIVE_INFINITY) < 1,
  );
  const nonComparableBuckets = nonComparableCases.reduce<
    Record<Exclude<ComparabilityClass, 'comparable_canonical' | 'comparable_structural_semantic_gap'>, number>
  >(
    (acc, entry) => {
      if (entry.comparabilityClass === 'non_comparable_missing_signals') {
        acc.non_comparable_missing_signals += 1;
      } else if (entry.comparabilityClass === 'non_comparable_contract_mismatch') {
        acc.non_comparable_contract_mismatch += 1;
      } else {
        acc.non_comparable_other += 1;
      }
      return acc;
    },
    {
      non_comparable_missing_signals: 0,
      non_comparable_contract_mismatch: 0,
      non_comparable_other: 0,
    },
  );
  const semanticGapBuckets = {
    comparable_structural_semantic_gap: results.filter(
      (entry) => entry.comparabilityClass === 'comparable_structural_semantic_gap',
    ).length,
  };
  const nonComparableDiagnostics = new Map<string, number>();
  for (const entry of nonComparableCases) {
    if (entry.comparabilityClass === 'non_comparable_missing_signals') {
      for (const field of missingSignalFields(entry)) {
        nonComparableDiagnostics.set(`missing_signal:${field}`, (nonComparableDiagnostics.get(`missing_signal:${field}`) ?? 0) + 1);
      }
      for (const code of entry.reasonCode) {
        nonComparableDiagnostics.set(`missing_signal_reason:${code}`, (nonComparableDiagnostics.get(`missing_signal_reason:${code}`) ?? 0) + 1);
      }
    } else if (entry.comparabilityClass === 'non_comparable_contract_mismatch') {
      const contractCodes = entry.reasonCode.filter((code) => CONTRACT_REASON_CODES.has(code) || code === 'G4_QI_SOURCE_NOT_METRIC');
      if (contractCodes.length === 0) {
        nonComparableDiagnostics.set(`contract_mismatch:rhoSource:${entry.rhoSource ?? 'null'}`, (nonComparableDiagnostics.get(`contract_mismatch:rhoSource:${entry.rhoSource ?? 'null'}`) ?? 0) + 1);
      }
      for (const code of contractCodes) {
        nonComparableDiagnostics.set(`contract_mismatch_reason:${code}`, (nonComparableDiagnostics.get(`contract_mismatch_reason:${code}`) ?? 0) + 1);
      }
    } else {
      const semanticReason = entry.quantitySemanticReason ?? 'semantic_untyped';
      nonComparableDiagnostics.set(
        `semantic_mismatch:${semanticReason}`,
        (nonComparableDiagnostics.get(`semantic_mismatch:${semanticReason}`) ?? 0) + 1,
      );
    }
  }
  const nonComparableDiagnosticsTop = [...nonComparableDiagnostics.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));

  const canonicalApplicabilityPass = canonicalComparableCases.filter((entry) => entry.applicabilityStatus === 'PASS');
  const comparableApplicabilityPass = structuralComparableCases.filter((entry) => entry.applicabilityStatus === 'PASS');
  const rankedCandidates = comparableApplicabilityPass
    .slice()
    .sort(
      (a, b) =>
        (a.marginRatioRawComputed ?? Number.POSITIVE_INFINITY) - (b.marginRatioRawComputed ?? Number.POSITIVE_INFINITY) ||
        a.id.localeCompare(b.id),
    );
  const bestCandidate =
    rankedCandidates[0] ??
    results.slice().sort((a, b) => (a.marginRatioRawComputed ?? Number.POSITIVE_INFINITY) - (b.marginRatioRawComputed ?? Number.POSITIVE_INFINITY) || a.id.localeCompare(b.id))[0] ?? null;
  const minMarginRatioRawComputedAmongApplicabilityPass = rankedCandidates[0]?.marginRatioRawComputed ?? null;
  const minMarginRatioRawAmongApplicabilityPass = comparableApplicabilityPass
    .map((entry) => entry.marginRatioRaw ?? Number.POSITIVE_INFINITY)
    .sort((a, b) => a - b)[0] ?? null;
  const candidatePassFoundCanonical = canonicalApplicabilityPass.some(
    (entry) => (entry.marginRatioRaw ?? Number.POSITIVE_INFINITY) < 1,
  );
  const candidatePassFoundComputedOnly = rankedCandidates.some(
    (entry) => (entry.marginRatioRawComputed ?? Number.POSITIVE_INFINITY) < 1,
  );
  const candidatePassFound = candidatePassFoundCanonical;
  const bestCandidateCanonicalPassEligible = (bestCandidate?.marginRatioRaw ?? Number.POSITIVE_INFINITY) < 1;
  const bestCandidateComputedPassEligible = (bestCandidate?.marginRatioRawComputed ?? Number.POSITIVE_INFINITY) < 1;
  const bestCandidateEligibility = {
    canonicalPassEligible: bestCandidateCanonicalPassEligible,
    counterfactualPassEligible: bestCandidateComputedPassEligible,
    class: bestCandidateCanonicalPassEligible
      ? 'canonical_pass_eligible'
      : bestCandidateComputedPassEligible
        ? 'counterfactual_only'
        : 'no_pass_signal',
  };
  const rankedComparableCandidates = structuralComparableCases
    .slice()
    .sort(
      (a, b) =>
        (a.marginRatioRawComputed ?? Number.POSITIVE_INFINITY) - (b.marginRatioRawComputed ?? Number.POSITIVE_INFINITY) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, 10)
    .map((entry) => ({
      id: entry.id,
      comparabilityClass: entry.comparabilityClass,
      params: entry.params,
      lhs_Jm3: entry.lhs_Jm3,
      boundComputed_Jm3: entry.boundComputed_Jm3,
      boundPolicyFloor_Jm3: entry.boundPolicyFloor_Jm3,
      boundEnvFloor_Jm3: entry.boundEnvFloor_Jm3,
      boundDefaultFloor_Jm3: entry.boundDefaultFloor_Jm3,
      boundFloor_Jm3: entry.boundFloor_Jm3,
      boundUsed_Jm3: entry.boundUsed_Jm3,
      marginRatioRaw: entry.marginRatioRaw,
      marginRatioRawComputed: entry.marginRatioRawComputed,
      sumWindowDt: entry.sumWindowDt,
      tau_s: entry.tau_s,
      tauConfigured_s: entry.tauConfigured_s,
      tauWindow_s: entry.tauWindow_s,
      tauPulse_s: entry.tauPulse_s,
      tauLC_s: entry.tauLC_s,
      tauSelected_s: entry.tauSelected_s,
      tauSelectedSource: entry.tauSelectedSource,
      tauSelectorPolicy: entry.tauSelectorPolicy,
      tauSelectorFallbackApplied: entry.tauSelectorFallbackApplied,
      tauProvenanceReady: entry.tauProvenanceReady,
      tauProvenanceMissing: entry.tauProvenanceMissing,
      K: entry.K,
      safetySigma_Jm3: entry.safetySigma_Jm3,
      applicabilityStatus: entry.applicabilityStatus,
      reasonCode: entry.reasonCode,
      quantitySemanticType: entry.quantitySemanticType,
      quantitySemanticBaseType: entry.quantitySemanticBaseType,
      quantitySemanticTargetType: entry.quantitySemanticTargetType,
      quantityWorldlineClass: entry.quantityWorldlineClass,
      quantitySemanticComparable: entry.quantitySemanticComparable,
      quantitySemanticReason: entry.quantitySemanticReason,
      quantitySemanticBridgeMode: entry.quantitySemanticBridgeMode,
      quantitySemanticBridgeReady: entry.quantitySemanticBridgeReady,
      quantitySemanticBridgeMissing: entry.quantitySemanticBridgeMissing,
      qeiStateClass: entry.qeiStateClass,
      qeiRenormalizationScheme: entry.qeiRenormalizationScheme,
      qeiSamplingNormalization: entry.qeiSamplingNormalization,
      qeiOperatorMapping: entry.qeiOperatorMapping,
      couplingMode: entry.couplingMode,
      couplingAlpha: entry.couplingAlpha,
      rhoMetric_Jm3: entry.rhoMetric_Jm3,
      rhoProxy_Jm3: entry.rhoProxy_Jm3,
      rhoCoupledShadow_Jm3: entry.rhoCoupledShadow_Jm3,
      couplingResidualRel: entry.couplingResidualRel,
      couplingComparable: entry.couplingComparable,
      metricT00Ref: entry.metricT00Ref,
      metricT00Derivation: entry.metricT00Derivation,
      metricT00ContractStatus: entry.metricT00ContractStatus,
      metricT00Geom: entry.metricT00Geom,
      metricT00Si_Jm3: entry.metricT00Si_Jm3,
      metricT00SiFromGeom: entry.metricT00SiFromGeom,
      metricT00SiRelError: entry.metricT00SiRelError,
      metricStressRhoSiMean_Jm3: entry.metricStressRhoSiMean_Jm3,
      metricStressRhoGeomMean_Geom: entry.metricStressRhoGeomMean_Geom,
      metricStressKTraceMean: entry.metricStressKTraceMean,
      metricStressKSquaredMean: entry.metricStressKSquaredMean,
      metricStressStep_m: entry.metricStressStep_m,
      metricStressScale_m: entry.metricStressScale_m,
      metricStressSampleCount: entry.metricStressSampleCount,
    }));
  const leverInfluenceRanking = summarizeInfluence(structuralComparableCases);
  const postBootstrapBlockedReason = structuralComparableCases.length === 0 ? 'no_canonical_comparable_cases_after_bootstrap' : null;
  const normalizedTopRankedApplicabilityPassCases = postBootstrapBlockedReason == null ? rankedCandidates.slice(0, topN) : [];
  const normalizedCandidatePassFoundCanonical = postBootstrapBlockedReason == null ? candidatePassFoundCanonical : false;
  const normalizedCandidatePassFoundComputedOnly = postBootstrapBlockedReason == null ? candidatePassFoundComputedOnly : false;
  const normalizedCandidatePassFound = postBootstrapBlockedReason == null ? candidatePassFound : false;
  const normalizedMinMarginRatioRawAmongApplicabilityPass =
    postBootstrapBlockedReason == null ? minMarginRatioRawAmongApplicabilityPass : null;
  const normalizedMinMarginRatioRawComputedAmongApplicabilityPass =
    postBootstrapBlockedReason == null ? minMarginRatioRawComputedAmongApplicabilityPass : null;

  const payload = {
    runId: `g4-recovery-search-${seed}-${DATE_STAMP}`,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    deterministicSearch: {
      seed,
      maxCases,
      runtimeCapMs,
      influenceFamilyLimit,
      attemptedCaseUniverse,
      executedCaseCount: results.length,
      evaluatedCaseCount: evaluated,
      elapsedMs: Date.now() - startedAt,
      deterministicWalk: { start, step },
      stagedCounts: {
        tauPriorityRows: tauPriorityRows.length,
        influenceRows: influenceRows.length,
        stagedRows: stagedRows.length,
      },
      seedStrategy: {
        centerSource: centerSeed.params ? 'stepB_top_comparable' : 'deterministic_walk_seed',
        centerCaseId: centerSeed.caseId,
        prioritizedFamilies,
        stepBSeedUsed: Boolean(centerSeed.params),
        couplingLocalizationSeedUsed: Boolean(couplingLocalizationSeed?.termInfluenceRanking),
        seedArtifactsEnabled: useSeedArtifacts,
      },
    },
    caseCount: results.length,
    canonicalComparableCaseCount: canonicalComparableCases.length,
    canonicalStructuralComparableCaseCount: structuralComparableCases.length,
    canonicalSemanticGapCaseCount: semanticGapBuckets.comparable_structural_semantic_gap,
    candidatePassFound: normalizedCandidatePassFound,
    candidatePassFoundCanonical: normalizedCandidatePassFoundCanonical,
    candidatePassFoundComputedOnly: normalizedCandidatePassFoundComputedOnly,
    candidatePassFoundCanonicalComparable,
    candidatePassFoundStructuralComparable,
    minMarginRatioRawAmongApplicabilityPass: normalizedMinMarginRatioRawAmongApplicabilityPass,
    minMarginRatioRawComputedAmongApplicabilityPass: normalizedMinMarginRatioRawComputedAmongApplicabilityPass,
    minMarginRatioRawComputedCanonicalComparable,
    minMarginRatioRawComputedComparable,
    bestCandidateEligibility,
    bestCandidate,
    blockedReason: postBootstrapBlockedReason,
    stepASummaryPath: stepASummaryPath.replace(/\\/g, '/'),
    stepBSummaryPath: stepBSummaryPath.replace(/\\/g, '/'),
    stepCSummaryPath: stepCSummaryPath.replace(/\\/g, '/'),
    couplingLocalizationPath: couplingLocalizationPath.replace(/\\/g, '/'),
    provenance: {
      commitHash,
      freshnessSource: 'git.head',
      stepBSeedCommitHash:
        typeof stepBSeed?.provenance?.commitHash === 'string' ? stepBSeed.provenance.commitHash : null,
      couplingLocalizationSeedCommitHash:
        typeof couplingLocalizationSeed?.provenance?.commitHash === 'string'
          ? couplingLocalizationSeed.provenance.commitHash
          : null,
    },
    topRankedApplicabilityPassCases: normalizedTopRankedApplicabilityPassCases,
    cases: results,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  writeStepBSummary(stepBSummaryPath, {
    boundaryStatement: BOUNDARY_STATEMENT,
    executedCaseCount: results.length,
    canonicalComparableCaseCount: canonicalComparableCases.length,
    canonicalStructuralComparableCaseCount: structuralComparableCases.length,
    candidatePassFoundCanonicalComparable,
    candidatePassFoundStructuralComparable,
    minMarginRatioRawComputedComparable,
    minMarginRatioRawComputedCanonicalComparable,
    topComparableCandidates: rankedComparableCandidates,
    leverInfluenceRanking,
    blockedReason: postBootstrapBlockedReason,
    provenance: {
      commitHash,
    },
  });
  const stepCSummary = {
    boundaryStatement: BOUNDARY_STATEMENT,
    bootstrapAttempted: bootstrap.attempted,
    bootstrapSucceeded: bootstrap.succeeded,
    bootstrapReason: bootstrap.reason,
    bootstrapProvenance: bootstrap.provenance,
    executedCaseCount: results.length,
    canonicalComparableCaseCount: canonicalComparableCases.length,
    canonicalStructuralComparableCaseCount: structuralComparableCases.length,
    nonComparableBuckets,
    semanticGapBuckets,
    nonComparableDiagnosticsTop,
    candidatePassFoundCanonicalComparable,
    candidatePassFoundStructuralComparable,
    minMarginRatioRawComputedComparable,
    minMarginRatioRawComputedCanonicalComparable,
    topComparableCandidates: rankedComparableCandidates,
    blockedReason: postBootstrapBlockedReason,
    provenance: { commitHash },
  };
  fs.mkdirSync(path.dirname(stepCSummaryPath), { recursive: true });
  fs.writeFileSync(stepCSummaryPath, `${JSON.stringify(stepCSummary, null, 2)}\n`);
  return {
    ok: postBootstrapBlockedReason == null,
    outPath,
    stepASummaryPath,
    stepBSummaryPath,
    stepCSummaryPath,
    couplingLocalizationPath,
    caseCount: results.length,
    candidatePassFound: normalizedCandidatePassFound,
    bestCandidate,
    blockedReason: postBootstrapBlockedReason,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRecoverySearch()
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
