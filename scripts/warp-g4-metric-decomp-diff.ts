import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = '2026-02-27';
const DEFAULT_RECOVERY_PATH = path.join('artifacts/research/full-solve', `g4-recovery-search-${DATE_STAMP}.json`);
const DEFAULT_OUT_JSON = path.join('artifacts/research/full-solve', `g4-metric-decomp-diff-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join('docs/audits/research', `warp-g4-metric-decomp-diff-${DATE_STAMP}.md`);
const DEFAULT_REFERENCE_TOP_N = 5;
const DEFAULT_CANDIDATE_TOP_N = 10;
const EPS = 1e-12;
const MAG_RATIO_MIN = 0.02;
const MAG_RATIO_MAX = 50;
const Z_SCORE_MAX = 8;
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

type MetricField =
  | 'metricT00Si_Jm3'
  | 'metricStressRhoSiMean_Jm3'
  | 'metricStressRhoGeomMean_Geom'
  | 'metricStressKTraceMean'
  | 'metricStressKSquaredMean'
  | 'metricStressStep_m'
  | 'metricStressScale_m';

type RecoveryCase = {
  id: string;
  applicabilityStatus?: string;
  comparabilityClass?: string;
  reasonCode?: string[];
  marginRatioRawComputed?: number | null;
  marginRatioRaw?: number | null;
  rhoSource?: string | null;
  metricT00Ref?: string | null;
  metricT00Derivation?: string | null;
  metricT00ContractStatus?: string | null;
  metricT00Si_Jm3?: number | null;
  metricStressRhoSiMean_Jm3?: number | null;
  metricStressRhoGeomMean_Geom?: number | null;
  metricStressKTraceMean?: number | null;
  metricStressKSquaredMean?: number | null;
  metricStressStep_m?: number | null;
  metricStressScale_m?: number | null;
};

type FieldStats = {
  field: MetricField;
  count: number;
  mean: number | null;
  stddev: number | null;
};

type GenerateMetricDecompDiffOptions = {
  recoveryPath?: string;
  outJsonPath?: string;
  outMdPath?: string;
  referenceTopN?: number;
  candidateTopN?: number;
};

type ComparabilityClass =
  | 'comparable_canonical'
  | 'comparable_structural_semantic_gap'
  | 'non_comparable_missing_signals'
  | 'non_comparable_contract_mismatch'
  | 'non_comparable_other';

const METRIC_FIELDS: MetricField[] = [
  'metricT00Si_Jm3',
  'metricStressRhoSiMean_Jm3',
  'metricStressRhoGeomMean_Geom',
  'metricStressKTraceMean',
  'metricStressKSquaredMean',
  'metricStressStep_m',
  'metricStressScale_m',
];

const finiteOrNull = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
const safeReadJson = (p: string): any | null => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);

const isComparabilityClass = (value: unknown): value is ComparabilityClass =>
  value === 'comparable_canonical' ||
  value === 'comparable_structural_semantic_gap' ||
  value === 'non_comparable_missing_signals' ||
  value === 'non_comparable_contract_mismatch' ||
  value === 'non_comparable_other';

const resolveComparabilityClass = (entry: RecoveryCase): ComparabilityClass => {
  if (isComparabilityClass(entry.comparabilityClass)) return entry.comparabilityClass;

  const hasRequired =
    finiteOrNull(entry.marginRatioRawComputed) != null &&
    finiteOrNull(entry.metricT00Si_Jm3) != null &&
    finiteOrNull(entry.marginRatioRaw) != null;
  if (!hasRequired) return 'non_comparable_missing_signals';

  const rhoSource = asString(entry.rhoSource) ?? '';
  const reasonCodes = Array.isArray(entry.reasonCode)
    ? entry.reasonCode.map((code) => String(code).toUpperCase())
    : [];
  if (
    !rhoSource.startsWith('warp.metric') ||
    reasonCodes.includes('G4_QI_SOURCE_NOT_METRIC') ||
    reasonCodes.includes('G4_QI_CONTRACT_MISSING')
  ) {
    return 'non_comparable_contract_mismatch';
  }

  return 'comparable_structural_semantic_gap';
};

const compareByMarginThenId = (a: RecoveryCase, b: RecoveryCase): number =>
  (finiteOrNull(a.marginRatioRawComputed) ?? Number.POSITIVE_INFINITY) -
    (finiteOrNull(b.marginRatioRawComputed) ?? Number.POSITIVE_INFINITY) ||
  (a.id ?? '').localeCompare(b.id ?? '');

const computeFieldStats = (cases: RecoveryCase[]): FieldStats[] =>
  METRIC_FIELDS.map((field) => {
    const values = cases
      .map((entry) => finiteOrNull(entry[field]))
      .filter((value): value is number => value != null);
    if (values.length === 0) {
      return { field, count: 0, mean: null, stddev: null };
    }
    const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
    const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length;
    const stddev = Math.sqrt(Math.max(variance, 0));
    return { field, count: values.length, mean, stddev };
  });

const statByField = (stats: FieldStats[]): Record<MetricField, FieldStats> => {
  const record = {} as Record<MetricField, FieldStats>;
  for (const row of stats) record[row.field] = row;
  return record;
};

export const generateG4MetricDecompDiff = (options: GenerateMetricDecompDiffOptions = {}) => {
  const recoveryPath = options.recoveryPath ?? DEFAULT_RECOVERY_PATH;
  const outJsonPath = options.outJsonPath ?? DEFAULT_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_OUT_MD;
  const referenceTopN = Math.max(1, Math.floor(options.referenceTopN ?? DEFAULT_REFERENCE_TOP_N));
  const candidateTopN = Math.max(1, Math.floor(options.candidateTopN ?? DEFAULT_CANDIDATE_TOP_N));
  const recovery = safeReadJson(recoveryPath);
  const commitHash = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

  if (recovery == null || !Array.isArray(recovery.cases)) {
    const payload = {
      date: DATE_STAMP,
      generatedAt: new Date().toISOString(),
      boundaryStatement: BOUNDARY_STATEMENT,
      blockedReason: recovery == null ? 'recovery_artifact_missing' : 'recovery_cases_missing',
      recoveryPath,
      provenance: {
        commitHash,
        recoveryCommitHash: null,
      },
      reference: null,
      candidates: [],
      anyAbnormalCandidates: false,
      anomalyCountsByField: {},
    };
    fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
    fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
    fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
    fs.writeFileSync(outMdPath, `# G4 Metric Decomposition Diff (${DATE_STAMP})\n\n${BOUNDARY_STATEMENT}\n\n- blockedReason: ${payload.blockedReason}\n`);
    return { ok: false, blockedReason: payload.blockedReason, outJsonPath, outMdPath };
  }

  const cases = (recovery.cases as RecoveryCase[])
    .map((entry) => ({
      ...entry,
      comparabilityClass: resolveComparabilityClass(entry),
    }))
    .slice()
    .sort(compareByMarginThenId);
  const canonicalComparableCases = cases.filter((entry) => entry.comparabilityClass === 'comparable_canonical');
  const structuralComparableCases = cases.filter(
    (entry) =>
      entry.comparabilityClass === 'comparable_canonical' ||
      entry.comparabilityClass === 'comparable_structural_semantic_gap',
  );

  if (structuralComparableCases.length === 0) {
    const payload = {
      date: DATE_STAMP,
      generatedAt: new Date().toISOString(),
      boundaryStatement: BOUNDARY_STATEMENT,
      blockedReason: 'no_structural_comparable_cases',
      recoveryPath,
      provenance: {
        commitHash,
        recoveryCommitHash: asString(recovery?.provenance?.commitHash),
      },
      selectionMode: null,
      comparableCaseCounts: {
        canonicalComparable: 0,
        structuralComparable: 0,
      },
      reference: null,
      candidates: [],
      anyAbnormalCandidates: false,
      anomalyCountsByField: {},
    };
    fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
    fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
    fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
    fs.writeFileSync(outMdPath, `# G4 Metric Decomposition Diff (${DATE_STAMP})\n\n${BOUNDARY_STATEMENT}\n\n- blockedReason: ${payload.blockedReason}\n`);
    return { ok: false, blockedReason: payload.blockedReason, outJsonPath, outMdPath };
  }

  const selectionMode =
    canonicalComparableCases.length > 0 ? 'canonical' : 'structural_semantic_gap_fallback';
  const selectedComparableCases =
    canonicalComparableCases.length > 0 ? canonicalComparableCases : structuralComparableCases;

  const referencePoolPass = selectedComparableCases.filter(
    (entry) => String(entry.applicabilityStatus ?? 'UNKNOWN').toUpperCase() === 'PASS',
  );
  const referencePool = referencePoolPass.length > 0 ? referencePoolPass : selectedComparableCases;
  const referenceCases = referencePool.slice(0, referenceTopN);
  const referenceStats = computeFieldStats(referenceCases);
  const referenceByField = statByField(referenceStats);

  const selectedCandidates = selectedComparableCases.slice(0, candidateTopN);
  const anomalyCountsByField: Record<string, number> = {};
  const candidates = selectedCandidates.map((entry) => {
    const termComparisons = METRIC_FIELDS.map((field) => {
      const value = finiteOrNull(entry[field]);
      const stats = referenceByField[field];
      const refMean = stats.mean;
      const refStd = stats.stddev;
      const magnitudeRatio =
        value == null || refMean == null ? null : Math.abs(value) / Math.max(Math.abs(refMean), EPS);
      const signMismatch =
        value != null &&
        refMean != null &&
        Math.abs(value) > EPS &&
        Math.abs(refMean) > EPS &&
        Math.sign(value) !== Math.sign(refMean);
      const zScore =
        value == null || refMean == null || refStd == null || refStd <= EPS
          ? null
          : Math.abs(value - refMean) / refStd;
      const magnitudeOutlier =
        magnitudeRatio != null && (magnitudeRatio > MAG_RATIO_MAX || magnitudeRatio < MAG_RATIO_MIN);
      const zScoreOutlier = zScore != null && zScore > Z_SCORE_MAX;
      const abnormal = signMismatch || magnitudeOutlier || zScoreOutlier;
      if (abnormal) anomalyCountsByField[field] = (anomalyCountsByField[field] ?? 0) + 1;
      return {
        field,
        value,
        referenceMean: refMean,
        referenceStddev: refStd,
        magnitudeRatio,
        signMismatch,
        zScore,
        magnitudeOutlier,
        zScoreOutlier,
        abnormal,
      };
    });
    const abnormalTerms = termComparisons.filter((row) => row.abnormal).map((row) => row.field);
    return {
      id: entry.id,
      comparabilityClass: entry.comparabilityClass,
      applicabilityStatus: entry.applicabilityStatus ?? 'UNKNOWN',
      marginRatioRaw: finiteOrNull(entry.marginRatioRaw),
      marginRatioRawComputed: finiteOrNull(entry.marginRatioRawComputed),
      rhoSource: asString(entry.rhoSource),
      metricT00Ref: asString(entry.metricT00Ref),
      metricT00Derivation: asString(entry.metricT00Derivation),
      metricT00ContractStatus: asString(entry.metricT00ContractStatus),
      abnormal: abnormalTerms.length > 0,
      abnormalTerms,
      termComparisons,
    };
  });

  const anyAbnormalCandidates = candidates.some((entry) => entry.abnormal);
  const topAnomalyFields = Object.entries(anomalyCountsByField)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([field, count]) => ({ field, count }));

  const payload = {
    date: DATE_STAMP,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    blockedReason: null,
    thresholds: {
      magnitudeRatioMin: MAG_RATIO_MIN,
      magnitudeRatioMax: MAG_RATIO_MAX,
      zScoreMax: Z_SCORE_MAX,
    },
    recoveryPath,
    provenance: {
      commitHash,
      recoveryCommitHash: asString(recovery?.provenance?.commitHash),
    },
    selectionMode,
    comparableCaseCounts: {
      canonicalComparable: canonicalComparableCases.length,
      structuralComparable: structuralComparableCases.length,
    },
    reference: {
      mode:
        selectionMode === 'canonical'
          ? referencePoolPass.length > 0
            ? 'applicability_pass_canonical'
            : 'canonical_fallback'
          : referencePoolPass.length > 0
            ? 'applicability_pass_structural_semantic_gap'
            : 'structural_semantic_gap_fallback',
      caseCount: referenceCases.length,
      ids: referenceCases.map((entry) => entry.id),
      fieldStats: referenceStats,
    },
    candidateSelection: {
      caseCount: selectedCandidates.length,
      ids: selectedCandidates.map((entry) => entry.id),
    },
    anyAbnormalCandidates,
    anomalyCountsByField: topAnomalyFields,
    candidates,
  };

  fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
  fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);

  const mdRows = candidates
    .map(
      (entry) =>
        `| ${entry.id} | ${entry.applicabilityStatus} | ${entry.marginRatioRawComputed ?? 'n/a'} | ${entry.metricT00Ref ?? 'n/a'} | ${entry.abnormal} | ${entry.abnormalTerms.join(',') || 'none'} |`,
    )
    .join('\n');
  const md = `# G4 Metric Decomposition Diff (${DATE_STAMP})

${BOUNDARY_STATEMENT}

## Summary
- selection mode: ${selectionMode}
- canonical comparable cases analyzed: ${canonicalComparableCases.length}
- structural comparable cases analyzed: ${structuralComparableCases.length}
- reference mode: ${payload.reference.mode}
- reference case count: ${payload.reference.caseCount}
- candidate count: ${payload.candidateSelection.caseCount}
- any abnormal candidates: ${payload.anyAbnormalCandidates}

## Candidate matrix
| case | applicability | marginRatioRawComputed | metricT00Ref | abnormal | abnormal terms |
| --- | --- | ---: | --- | --- | --- |
${mdRows}
`;
  fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
  fs.writeFileSync(outMdPath, md);

  console.log(
    JSON.stringify({
      ok: true,
      outJsonPath,
      outMdPath,
      selectionMode,
      anyAbnormalCandidates,
      candidateCount: candidates.length,
    }),
  );
  return { ok: true, outJsonPath, outMdPath, selectionMode, anyAbnormalCandidates, candidateCount: candidates.length };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateG4MetricDecompDiff();
}
