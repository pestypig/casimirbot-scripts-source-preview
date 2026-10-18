import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = '2026-02-27';
const DEFAULT_RECOVERY_PATH = path.join('artifacts', 'research', 'full-solve', `g4-recovery-search-${DATE_STAMP}.json`);
const DEFAULT_OUT_JSON = path.join('artifacts', 'research', 'full-solve', `g4-coupling-localization-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-g4-coupling-localization-${DATE_STAMP}.md`);
const DEFAULT_CANONICAL_ROOT = path.join('artifacts', 'research', 'full-solve');
const DEFAULT_TOP_N = 10;
const DEFAULT_REFERENCE_TOP_N = 5;
const EPS = 1e-12;
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

type TermField =
  | 'rhoMetric_Jm3'
  | 'rhoProxy_Jm3'
  | 'rhoCoupledShadow_Jm3'
  | 'couplingResidualRel'
  | 'metricT00Si_Jm3'
  | 'metricT00Geom'
  | 'metricT00SiFromGeom'
  | 'metricT00SiRelError'
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
  marginRatioRaw?: number | null;
  marginRatioRawComputed?: number | null;
  lhs_Jm3?: number | null;
  boundComputed_Jm3?: number | null;
  boundUsed_Jm3?: number | null;
  rhoMetric_Jm3?: number | null;
  rhoProxy_Jm3?: number | null;
  rhoCoupledShadow_Jm3?: number | null;
  couplingResidualRel?: number | null;
  metricT00Si_Jm3?: number | null;
  metricT00Geom?: number | null;
  metricT00SiFromGeom?: number | null;
  metricT00SiRelError?: number | null;
  metricStressRhoSiMean_Jm3?: number | null;
  metricStressRhoGeomMean_Geom?: number | null;
  metricStressKTraceMean?: number | null;
  metricStressKSquaredMean?: number | null;
  metricStressStep_m?: number | null;
  metricStressScale_m?: number | null;
};

type GenerateCouplingLocalizationOptions = {
  recoveryPath?: string;
  outJsonPath?: string;
  outMdPath?: string;
  canonicalRoot?: string;
  topN?: number;
  referenceTopN?: number;
};

type DiagnosticFallbackPayload = {
  analysisMode: 'diagnostic_fallback_noncomparable_other';
  source: 'recovery_non_comparable_other' | 'canonical_qi_forensics';
  fallbackPoolCaseCount: number;
  fallbackSelectedCaseCount: number;
  fallbackMinMarginRatioRawComputed: number | null;
  fallbackBestCaseId: string | null;
  termInfluenceRanking: Array<{
    field: TermField;
    sampleCount: number;
    influenceCaseCount: number;
    pearsonRWithMarginRatioRawComputed: number | null;
    slopeToMarginRatioRawComputed: number | null;
    maxRelativeDeltaAbs: number;
    scoreMode: string;
    influenceScore: number;
  }>;
  cases: Array<{
    id: string;
    applicabilityStatus: string;
    marginRatioRaw: number | null;
    marginRatioRawComputed: number | null;
    lhs_Jm3: number | null;
    boundComputed_Jm3: number | null;
    boundUsed_Jm3: number | null;
    dominantTerms: Array<{ field: TermField; relativeDeltaAbs: number | null; delta: number | null }>;
    termDeltas: Array<{
      field: TermField;
      value: number | null;
      referenceMean: number | null;
      delta: number | null;
      relativeDeltaAbs: number | null;
      zScoreAbs: number | null;
    }>;
  }>;
};

const TERM_FIELDS: TermField[] = [
  'rhoMetric_Jm3',
  'rhoProxy_Jm3',
  'rhoCoupledShadow_Jm3',
  'couplingResidualRel',
  'metricT00Si_Jm3',
  'metricT00Geom',
  'metricT00SiFromGeom',
  'metricT00SiRelError',
  'metricStressRhoSiMean_Jm3',
  'metricStressRhoGeomMean_Geom',
  'metricStressKTraceMean',
  'metricStressKSquaredMean',
  'metricStressStep_m',
  'metricStressScale_m',
];

const finiteOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const asString = (value: unknown): string | null => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);
const safeReadJson = (filePath: string): any | null => (fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null);
const CANONICAL_WAVES = ['A', 'B', 'C', 'D'] as const;

const isComparableCanonical = (entry: RecoveryCase): boolean => {
  if (entry.comparabilityClass === 'comparable_canonical') return true;
  return false;
};

const isComparableStructuralSemanticGap = (entry: RecoveryCase): boolean => {
  if (entry.comparabilityClass === 'comparable_structural_semantic_gap') return true;
  return false;
};

const isComparableForLocalization = (entry: RecoveryCase): boolean =>
  isComparableCanonical(entry) || isComparableStructuralSemanticGap(entry);

const compareByComputedMarginThenId = (a: RecoveryCase, b: RecoveryCase): number =>
  (finiteOrNull(a.marginRatioRawComputed) ?? Number.POSITIVE_INFINITY) -
    (finiteOrNull(b.marginRatioRawComputed) ?? Number.POSITIVE_INFINITY) ||
  (a.id ?? '').localeCompare(b.id ?? '');

const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((acc, value) => acc + value, 0) / values.length;

const stddev = (values: number[], avg: number): number =>
  Math.sqrt(values.reduce((acc, value) => acc + (value - avg) ** 2, 0) / values.length);

const correlationAndSlope = (x: number[], y: number[]): { correlation: number | null; slope: number | null } => {
  if (x.length < 2 || y.length < 2 || x.length !== y.length) return { correlation: null, slope: null };
  const xMean = mean(x);
  const yMean = mean(y);
  if (xMean == null || yMean == null) return { correlation: null, slope: null };
  const xDev = x.map((value) => value - xMean);
  const yDev = y.map((value) => value - yMean);
  const covariance = xDev.reduce((acc, value, idx) => acc + value * yDev[idx], 0) / x.length;
  const xVar = xDev.reduce((acc, value) => acc + value ** 2, 0) / x.length;
  const yVar = yDev.reduce((acc, value) => acc + value ** 2, 0) / y.length;
  if (xVar <= EPS || yVar <= EPS) return { correlation: null, slope: null };
  return {
    correlation: covariance / (Math.sqrt(xVar) * Math.sqrt(yVar)),
    slope: covariance / xVar,
  };
};

const computeLocalizationRows = (
  sourceCases: RecoveryCase[],
  topN: number,
  referenceTopN: number,
) => {
  const comparablePass = sourceCases.filter(
    (entry) => String(entry.applicabilityStatus ?? 'UNKNOWN').toUpperCase() === 'PASS',
  );
  const referencePool = comparablePass.length > 0 ? comparablePass : sourceCases;
  const referenceCases = referencePool.slice(0, referenceTopN);
  const selectedCases = sourceCases.slice(0, topN);
  const influenceCases = sourceCases;

  const referenceStats = TERM_FIELDS.map((field) => {
    const values = referenceCases
      .map((entry) => finiteOrNull(entry[field]))
      .filter((value): value is number => value != null);
    const avg = mean(values);
    const sigma = avg == null || values.length < 2 ? null : stddev(values, avg);
    const minValue = values.length > 0 ? Math.min(...values) : null;
    const maxValue = values.length > 0 ? Math.max(...values) : null;
    return {
      field,
      sampleCount: values.length,
      mean: avg,
      stddev: sigma,
      min: minValue,
      max: maxValue,
    };
  });
  const referenceByField = Object.fromEntries(referenceStats.map((row) => [row.field, row])) as Record<
    TermField,
    (typeof referenceStats)[number]
  >;

  const rows = selectedCases.map((entry) => {
    const termDeltas = TERM_FIELDS.map((field) => {
      const value = finiteOrNull(entry[field]);
      const ref = referenceByField[field];
      const refMean = ref.mean;
      const delta = value == null || refMean == null ? null : value - refMean;
      const relativeDeltaAbs =
        delta == null || refMean == null ? null : Math.abs(delta) / Math.max(Math.abs(refMean), EPS);
      const zScore =
        delta == null || ref.stddev == null || ref.stddev <= EPS ? null : Math.abs(delta) / ref.stddev;
      return {
        field,
        value,
        referenceMean: refMean,
        delta,
        relativeDeltaAbs,
        zScoreAbs: zScore,
      };
    });
    const dominantTerms = termDeltas
      .slice()
      .sort((a, b) => (b.relativeDeltaAbs ?? -1) - (a.relativeDeltaAbs ?? -1) || a.field.localeCompare(b.field))
      .slice(0, 3)
      .map((row) => ({
        field: row.field,
        relativeDeltaAbs: row.relativeDeltaAbs,
        delta: row.delta,
      }));
    return {
      id: entry.id,
      applicabilityStatus: String(entry.applicabilityStatus ?? 'UNKNOWN').toUpperCase(),
      marginRatioRaw: finiteOrNull(entry.marginRatioRaw),
      marginRatioRawComputed: finiteOrNull(entry.marginRatioRawComputed),
      lhs_Jm3: finiteOrNull(entry.lhs_Jm3),
      boundComputed_Jm3: finiteOrNull(entry.boundComputed_Jm3),
      boundUsed_Jm3: finiteOrNull(entry.boundUsed_Jm3),
      dominantTerms,
      termDeltas,
    };
  });

  const termInfluenceRanking = TERM_FIELDS.map((field) => {
    const paired = influenceCases
      .map((entry) => ({
        x: finiteOrNull(entry[field]),
        y: finiteOrNull(entry.marginRatioRawComputed),
      }))
      .filter((row): row is { x: number; y: number } => row.x != null && row.y != null);
    const xValues = paired.map((row) => row.x);
    const yValues = paired.map((row) => row.y);
    const link = correlationAndSlope(xValues, yValues);
    const corrAbs = link.correlation == null ? 0 : Math.abs(link.correlation);
    const relDeltaMax = rows.reduce((acc, row) => {
      const term = row.termDeltas.find((item) => item.field === field);
      return Math.max(acc, term?.relativeDeltaAbs ?? 0);
    }, 0);
    const scoreMode = corrAbs > 0 ? 'correlation' : 'delta_fallback';
    return {
      field,
      sampleCount: paired.length,
      influenceCaseCount: influenceCases.length,
      pearsonRWithMarginRatioRawComputed: link.correlation,
      slopeToMarginRatioRawComputed: link.slope,
      maxRelativeDeltaAbs: relDeltaMax,
      scoreMode,
      influenceScore: scoreMode === 'correlation' ? corrAbs * (1 + Math.log10(1 + relDeltaMax)) : relDeltaMax,
    };
  }).sort((a, b) => b.influenceScore - a.influenceScore || a.field.localeCompare(b.field));

  const minMarginRatioRawComputed =
    sourceCases
      .map((entry) => finiteOrNull(entry.marginRatioRawComputed))
      .filter((value): value is number => value != null)
      .sort((a, b) => a - b)[0] ?? null;

  return {
    referenceCases,
    referenceStats,
    rows,
    termInfluenceRanking,
    minMarginRatioRawComputed,
    bestCaseId: sourceCases[0]?.id ?? null,
  };
};

export const generateG4CouplingLocalization = (options: GenerateCouplingLocalizationOptions = {}) => {
  const recoveryPath = options.recoveryPath ?? DEFAULT_RECOVERY_PATH;
  const outJsonPath = options.outJsonPath ?? DEFAULT_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_OUT_MD;
  const canonicalRoot = options.canonicalRoot ?? DEFAULT_CANONICAL_ROOT;
  const topN = Math.max(1, Math.floor(options.topN ?? DEFAULT_TOP_N));
  const referenceTopN = Math.max(1, Math.floor(options.referenceTopN ?? DEFAULT_REFERENCE_TOP_N));
  const commitHash = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const recovery = safeReadJson(recoveryPath);

  const writeBlocked = (blockedReason: string, diagnosticFallback?: DiagnosticFallbackPayload) => {
    const payload = {
      date: DATE_STAMP,
      generatedAt: new Date().toISOString(),
      boundaryStatement: BOUNDARY_STATEMENT,
      blockedReason,
      analysisMode: diagnosticFallback?.analysisMode ?? 'blocked',
      diagnosticFallbackUsed: Boolean(diagnosticFallback),
      diagnosticFallbackSource: diagnosticFallback?.source ?? null,
      recoveryPath,
      canonicalRoot: canonicalRoot.replace(/\\/g, '/'),
      provenance: {
        commitHash,
        recoveryCommitHash: asString(recovery?.provenance?.commitHash),
      },
      canonicalComparableCaseCount: 0,
      canonicalStructuralComparableCaseCount: 0,
      selectedCaseCount: 0,
      candidatePassFoundComparable: false,
      candidatePassFoundComparableComputedOnly: false,
      minMarginRatioRawComputedComparable: null,
      bestComparableCaseId: null,
      fallbackPoolCaseCount: diagnosticFallback?.fallbackPoolCaseCount ?? 0,
      fallbackSelectedCaseCount: diagnosticFallback?.fallbackSelectedCaseCount ?? 0,
      fallbackMinMarginRatioRawComputed: diagnosticFallback?.fallbackMinMarginRatioRawComputed ?? null,
      fallbackBestCaseId: diagnosticFallback?.fallbackBestCaseId ?? null,
      reference: null,
      termInfluenceRanking: diagnosticFallback?.termInfluenceRanking ?? [],
      cases: diagnosticFallback?.cases ?? [],
    };
    fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
    fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
    fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
    const mdDiagnostics = diagnosticFallback
      ? [
          '',
          '- diagnosticFallbackUsed: true',
          `- diagnosticFallbackSource: ${diagnosticFallback.source}`,
          `- fallbackPoolCaseCount: ${diagnosticFallback.fallbackPoolCaseCount}`,
          `- fallbackSelectedCaseCount: ${diagnosticFallback.fallbackSelectedCaseCount}`,
          `- fallbackMinMarginRatioRawComputed: ${diagnosticFallback.fallbackMinMarginRatioRawComputed ?? 'null'}`,
          `- fallbackBestCaseId: ${diagnosticFallback.fallbackBestCaseId ?? 'null'}`,
          '',
          '## Top Influence Terms (diagnostic fallback)',
          '',
          '| field | scoreMode | influenceScore | pearsonR | slope | maxRelativeDeltaAbs |',
          '|---|---|---:|---:|---:|---:|',
          ...diagnosticFallback.termInfluenceRanking.slice(0, 10).map(
            (row) =>
              `| ${row.field} | ${row.scoreMode} | ${row.influenceScore} | ${row.pearsonRWithMarginRatioRawComputed ?? 'null'} | ${row.slopeToMarginRatioRawComputed ?? 'null'} | ${row.maxRelativeDeltaAbs} |`,
          ),
        ]
      : [];
    fs.writeFileSync(
      outMdPath,
      `# G4 Coupling Localization (${DATE_STAMP})\n\n${BOUNDARY_STATEMENT}\n\n- blockedReason: ${blockedReason}\n${mdDiagnostics.join('\n')}\n`,
    );
    return {
      ok: false,
      blockedReason,
      outJsonPath,
      outMdPath,
    };
  };

  if (recovery == null || !Array.isArray(recovery.cases)) {
    return writeBlocked(recovery == null ? 'recovery_artifact_missing' : 'recovery_cases_missing');
  }

  const canonicalFallbackPool: RecoveryCase[] = CANONICAL_WAVES.map((wave) => {
    const qiPath = path.join(canonicalRoot, wave, 'qi-forensics.json');
    const payload = safeReadJson(qiPath);
    if (payload == null || typeof payload !== 'object') return null;
    return {
      id: `canonical_${String(wave).toLowerCase()}`,
      comparabilityClass: String((payload as any).comparabilityClass ?? 'non_comparable_other'),
      applicabilityStatus: asString((payload as any).applicabilityStatus) ?? 'UNKNOWN',
      marginRatioRaw: finiteOrNull((payload as any).marginRatioRaw),
      marginRatioRawComputed: finiteOrNull((payload as any).marginRatioRawComputed),
      lhs_Jm3: finiteOrNull((payload as any).lhs_Jm3),
      boundComputed_Jm3: finiteOrNull((payload as any).boundComputed_Jm3),
      boundUsed_Jm3: finiteOrNull((payload as any).boundUsed_Jm3 ?? (payload as any).bound_Jm3),
      rhoMetric_Jm3: finiteOrNull((payload as any).rhoMetric_Jm3),
      rhoProxy_Jm3: finiteOrNull((payload as any).rhoProxy_Jm3),
      rhoCoupledShadow_Jm3: finiteOrNull((payload as any).rhoCoupledShadow_Jm3),
      couplingResidualRel: finiteOrNull((payload as any).couplingResidualRel),
      metricT00Si_Jm3: finiteOrNull((payload as any).metricT00Si_Jm3),
      metricT00Geom: finiteOrNull((payload as any).metricT00Geom_GeomStress),
      metricT00SiFromGeom: finiteOrNull((payload as any).metricT00SiFromGeom_Jm3),
      metricT00SiRelError: finiteOrNull((payload as any).metricT00SiRelError),
      metricStressRhoSiMean_Jm3: finiteOrNull((payload as any).metricStressRhoSiMean_Jm3),
      metricStressRhoGeomMean_Geom: finiteOrNull((payload as any).metricStressRhoGeomMean_Geom),
      metricStressKTraceMean: finiteOrNull((payload as any).metricStressKTraceMean),
      metricStressKSquaredMean: finiteOrNull((payload as any).metricStressKSquaredMean),
      metricStressStep_m: finiteOrNull((payload as any).metricStressStep_m),
      metricStressScale_m: finiteOrNull((payload as any).metricStressScale_m),
    } as RecoveryCase;
  }).filter((entry): entry is RecoveryCase => entry != null);

  const canonicalComparableCases = (recovery.cases as RecoveryCase[])
    .filter(isComparableCanonical)
    .sort(compareByComputedMarginThenId);
  const structuralComparableCases = (recovery.cases as RecoveryCase[])
    .filter(isComparableStructuralSemanticGap)
    .sort(compareByComputedMarginThenId);
  const comparableCases = (recovery.cases as RecoveryCase[])
    .filter(isComparableForLocalization)
    .sort(compareByComputedMarginThenId);
  if (comparableCases.length === 0) {
    const fallbackPool = (recovery.cases as RecoveryCase[])
      .filter((entry) => String(entry.comparabilityClass ?? '') === 'non_comparable_other')
      .sort(compareByComputedMarginThenId);
    if (fallbackPool.length > 0) {
      const fallbackRows = computeLocalizationRows(fallbackPool, topN, referenceTopN);
      return writeBlocked('no_canonical_comparable_cases', {
        analysisMode: 'diagnostic_fallback_noncomparable_other',
        source: 'recovery_non_comparable_other',
        fallbackPoolCaseCount: fallbackPool.length,
        fallbackSelectedCaseCount: fallbackRows.rows.length,
        fallbackMinMarginRatioRawComputed: fallbackRows.minMarginRatioRawComputed,
        fallbackBestCaseId: fallbackRows.bestCaseId,
        termInfluenceRanking: fallbackRows.termInfluenceRanking,
        cases: fallbackRows.rows,
      });
    }
    if (canonicalFallbackPool.length > 0) {
      const fallbackRows = computeLocalizationRows(canonicalFallbackPool, topN, referenceTopN);
      return writeBlocked('no_canonical_comparable_cases', {
        analysisMode: 'diagnostic_fallback_noncomparable_other',
        source: 'canonical_qi_forensics',
        fallbackPoolCaseCount: canonicalFallbackPool.length,
        fallbackSelectedCaseCount: fallbackRows.rows.length,
        fallbackMinMarginRatioRawComputed: fallbackRows.minMarginRatioRawComputed,
        fallbackBestCaseId: fallbackRows.bestCaseId,
        termInfluenceRanking: fallbackRows.termInfluenceRanking,
        cases: fallbackRows.rows,
      });
    }
    return writeBlocked('no_canonical_comparable_cases');
  }

  const localization = computeLocalizationRows(comparableCases, topN, referenceTopN);
  const minMarginRatioRawComputedComparable = localization.minMarginRatioRawComputed;
  const candidatePassFoundComparable = comparableCases.some(
    (entry) =>
      String(entry.applicabilityStatus ?? 'UNKNOWN').toUpperCase() === 'PASS' &&
      (finiteOrNull(entry.marginRatioRaw) ?? Number.POSITIVE_INFINITY) < 1,
  );
  const candidatePassFoundComparableComputedOnly = comparableCases.some(
    (entry) =>
      String(entry.applicabilityStatus ?? 'UNKNOWN').toUpperCase() === 'PASS' &&
      (finiteOrNull(entry.marginRatioRawComputed) ?? Number.POSITIVE_INFINITY) < 1,
  );
  const bestComparableCaseId = localization.bestCaseId;

  const payload = {
    date: DATE_STAMP,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    analysisMode: 'canonical_comparable',
    diagnosticFallbackUsed: false,
    blockedReason: null,
    recoveryPath,
    canonicalRoot: canonicalRoot.replace(/\\/g, '/'),
    canonicalComparableCaseCount: canonicalComparableCases.length,
    canonicalStructuralComparableCaseCount: structuralComparableCases.length,
    selectedCaseCount: localization.rows.length,
    candidatePassFoundComparable,
    candidatePassFoundComparableComputedOnly,
    minMarginRatioRawComputedComparable,
    bestComparableCaseId,
    provenance: {
      commitHash,
      recoveryCommitHash: asString(recovery?.provenance?.commitHash),
    },
    fallbackPoolCaseCount: 0,
    fallbackSelectedCaseCount: 0,
    fallbackMinMarginRatioRawComputed: null,
    fallbackBestCaseId: null,
    reference: {
      mode:
        localization.referenceCases.some(
          (entry) => String(entry.applicabilityStatus ?? 'UNKNOWN').toUpperCase() === 'PASS',
        )
          ? 'comparable_applicability_pass'
          : 'comparable_fallback',
      caseCount: localization.referenceCases.length,
      caseIds: localization.referenceCases.map((entry) => entry.id),
      termStats: localization.referenceStats,
    },
    termInfluenceRanking: localization.termInfluenceRanking,
    cases: localization.rows,
  };

  fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
  fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);

  const mdLines = [
    `# G4 Coupling Localization (${DATE_STAMP})`,
    '',
    BOUNDARY_STATEMENT,
    '',
    `- canonicalComparableCaseCount: ${payload.canonicalComparableCaseCount}`,
    `- canonicalStructuralComparableCaseCount: ${payload.canonicalStructuralComparableCaseCount}`,
    `- selectedCaseCount: ${payload.selectedCaseCount}`,
    `- candidatePassFoundComparable: ${payload.candidatePassFoundComparable}`,
    `- candidatePassFoundComparableComputedOnly: ${payload.candidatePassFoundComparableComputedOnly}`,
    `- minMarginRatioRawComputedComparable: ${payload.minMarginRatioRawComputedComparable ?? 'null'}`,
    `- bestComparableCaseId: ${payload.bestComparableCaseId ?? 'null'}`,
    '',
    '## Top Influence Terms',
    '',
    '| field | scoreMode | influenceScore | pearsonR | slope | maxRelativeDeltaAbs |',
    '|---|---|---:|---:|---:|---:|',
    ...localization.termInfluenceRanking.slice(0, 10).map(
      (row) =>
        `| ${row.field} | ${row.scoreMode} | ${row.influenceScore} | ${row.pearsonRWithMarginRatioRawComputed ?? 'null'} | ${row.slopeToMarginRatioRawComputed ?? 'null'} | ${row.maxRelativeDeltaAbs} |`,
    ),
    '',
    '## Selected Cases',
    '',
    '| id | applicabilityStatus | marginRatioRawComputed | topDominantTerms |',
    '|---|---|---:|---|',
    ...localization.rows.map(
      (row) =>
        `| ${row.id} | ${row.applicabilityStatus} | ${row.marginRatioRawComputed ?? 'null'} | ${row.dominantTerms
          .map((term) => term.field)
          .join(', ')} |`,
    ),
    '',
  ];
  fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
  fs.writeFileSync(outMdPath, `${mdLines.join('\n')}\n`);

  return {
    ok: true,
    outJsonPath,
    outMdPath,
    selectedCaseCount: localization.rows.length,
    canonicalComparableCaseCount: canonicalComparableCases.length,
    canonicalStructuralComparableCaseCount: structuralComparableCases.length,
    candidatePassFoundComparable,
    candidatePassFoundComparableComputedOnly,
    minMarginRatioRawComputedComparable,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(generateG4CouplingLocalization()));
}
