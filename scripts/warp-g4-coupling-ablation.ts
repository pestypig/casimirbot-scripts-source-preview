import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = '2026-02-27';
const DEFAULT_LOCALIZATION_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  `g4-coupling-localization-${DATE_STAMP}.json`,
);
const DEFAULT_OUT_JSON = path.join('artifacts', 'research', 'full-solve', `g4-coupling-ablation-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-g4-coupling-ablation-${DATE_STAMP}.md`);
const DEFAULT_TOP_N = 10;
const EPS = 1e-12;
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

type AblationInputCase = {
  id: string;
  applicabilityStatus?: string;
  marginRatioRawComputed?: number | null;
  termDeltas?: Array<{
    field?: string;
    value?: number | null;
    referenceMean?: number | null;
  }>;
};

type AblationInputRanking = {
  field?: string;
  influenceScore?: number | null;
  slopeToMarginRatioRawComputed?: number | null;
  pearsonRWithMarginRatioRawComputed?: number | null;
};

type GenerateCouplingAblationOptions = {
  localizationPath?: string;
  outJsonPath?: string;
  outMdPath?: string;
  topN?: number;
};

type BlockedPayload = {
  date: string;
  generatedAt: string;
  boundaryStatement: string;
  blockedReason: string;
  localizationPath: string;
  provenance: {
    commitHash: string;
    localizationCommitHash: string | null;
  };
  analysisMode: 'blocked';
  baselineCaseId: null;
  baselineMarginRatioRawComputed: null;
  candidatePassFoundCounterfactual: false;
  bestCounterfactualMarginRatioRawComputed: null;
  topAblations: [];
};

const finiteOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const writeJson = (filePath: string, payload: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
};

const writeMd = (filePath: string, body: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
};

const compareByBaseline = (a: AblationInputCase, b: AblationInputCase): number =>
  (finiteOrNull(a.marginRatioRawComputed) ?? Number.POSITIVE_INFINITY) -
    (finiteOrNull(b.marginRatioRawComputed) ?? Number.POSITIVE_INFINITY) ||
  String(a.id ?? '').localeCompare(String(b.id ?? ''));

const asAblationCases = (value: unknown): AblationInputCase[] =>
  Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object' && typeof (item as any).id === 'string') as AblationInputCase[]
    : [];

const asAblationRanking = (value: unknown): AblationInputRanking[] =>
  Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object' && typeof (item as any).field === 'string') as AblationInputRanking[]
    : [];

const writeBlockedArtifacts = (
  blockedReason: string,
  localizationPath: string,
  outJsonPath: string,
  outMdPath: string,
  commitHash: string,
  localizationCommitHash: string | null,
) => {
  const payload: BlockedPayload = {
    date: DATE_STAMP,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    blockedReason,
    localizationPath: localizationPath.replace(/\\/g, '/'),
    provenance: {
      commitHash,
      localizationCommitHash,
    },
    analysisMode: 'blocked',
    baselineCaseId: null,
    baselineMarginRatioRawComputed: null,
    candidatePassFoundCounterfactual: false,
    bestCounterfactualMarginRatioRawComputed: null,
    topAblations: [],
  };
  writeJson(outJsonPath, payload);
  writeMd(
    outMdPath,
    `# G4 Coupling Ablation (${DATE_STAMP})\n\n${BOUNDARY_STATEMENT}\n\n- blockedReason: ${blockedReason}\n`,
  );
  return {
    ok: false as const,
    blockedReason,
    outJsonPath,
    outMdPath,
  };
};

export const generateG4CouplingAblation = (options: GenerateCouplingAblationOptions = {}) => {
  const localizationPath = options.localizationPath ?? DEFAULT_LOCALIZATION_PATH;
  const outJsonPath = options.outJsonPath ?? DEFAULT_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_OUT_MD;
  const topN = Math.max(1, Math.floor(options.topN ?? DEFAULT_TOP_N));
  const commitHash = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

  if (!fs.existsSync(localizationPath)) {
    return writeBlockedArtifacts('coupling_localization_missing', localizationPath, outJsonPath, outMdPath, commitHash, null);
  }

  let localization: any;
  try {
    localization = JSON.parse(fs.readFileSync(localizationPath, 'utf8'));
  } catch {
    return writeBlockedArtifacts('coupling_localization_invalid_json', localizationPath, outJsonPath, outMdPath, commitHash, null);
  }

  const localizationCommitHash = stringOrNull(localization?.provenance?.commitHash);
  const inputCases = asAblationCases(localization?.cases).sort(compareByBaseline);
  if (inputCases.length === 0) {
    return writeBlockedArtifacts(
      'coupling_localization_cases_missing',
      localizationPath,
      outJsonPath,
      outMdPath,
      commitHash,
      localizationCommitHash,
    );
  }

  const baseline = inputCases[0];
  const baselineMargin = finiteOrNull(baseline.marginRatioRawComputed);
  if (baselineMargin == null) {
    return writeBlockedArtifacts(
      'baseline_margin_ratio_missing',
      localizationPath,
      outJsonPath,
      outMdPath,
      commitHash,
      localizationCommitHash,
    );
  }

  const rankingRows = asAblationRanking(localization?.termInfluenceRanking)
    .slice()
    .sort(
      (a, b) =>
        (finiteOrNull(b.influenceScore) ?? Number.NEGATIVE_INFINITY) -
          (finiteOrNull(a.influenceScore) ?? Number.NEGATIVE_INFINITY) ||
        String(a.field ?? '').localeCompare(String(b.field ?? '')),
    );
  const baselineTermRows = Array.isArray(baseline.termDeltas)
    ? baseline.termDeltas.filter((entry) => entry && typeof entry === 'object')
    : [];
  const baselineTermMap = new Map(
    baselineTermRows
      .map((row) => [String(row.field ?? ''), row] as const)
      .filter(([field]) => field.length > 0),
  );

  const ablations = rankingRows.slice(0, topN).map((row) => {
    const field = String(row.field ?? '');
    const baselineTerm = baselineTermMap.get(field);
    const baselineValue = finiteOrNull((baselineTerm as any)?.value);
    const referenceMean = finiteOrNull((baselineTerm as any)?.referenceMean);
    const slope = finiteOrNull(row.slopeToMarginRatioRawComputed);
    const correlation = finiteOrNull(row.pearsonRWithMarginRatioRawComputed);
    const influenceScore = finiteOrNull(row.influenceScore);

    let counterfactualMarginRatioRawComputed: number | null = null;
    let improvementAbs: number | null = null;
    let improvementRel: number | null = null;
    let estimationMode: string;
    let blockedReason: string | null = null;

    if (baselineValue == null || referenceMean == null) {
      estimationMode = 'blocked_missing_term_delta';
      blockedReason = 'missing_baseline_or_reference_term_value';
    } else if (slope == null) {
      estimationMode = 'blocked_missing_slope';
      blockedReason = 'missing_term_slope';
    } else {
      estimationMode = 'linear_slope_reference_substitution';
      const deltaX = referenceMean - baselineValue;
      const estimated = baselineMargin + slope * deltaX;
      counterfactualMarginRatioRawComputed = Number.isFinite(estimated) ? Math.max(0, estimated) : null;
      if (counterfactualMarginRatioRawComputed != null) {
        improvementAbs = baselineMargin - counterfactualMarginRatioRawComputed;
        improvementRel = Math.abs(baselineMargin) > EPS ? improvementAbs / Math.abs(baselineMargin) : null;
      }
    }

    return {
      field,
      estimationMode,
      blockedReason,
      baselineValue,
      referenceMean,
      slopeToMarginRatioRawComputed: slope,
      pearsonRWithMarginRatioRawComputed: correlation,
      influenceScore,
      baselineMarginRatioRawComputed: baselineMargin,
      counterfactualMarginRatioRawComputed,
      improvementAbs,
      improvementRel,
      counterfactualPass: counterfactualMarginRatioRawComputed != null ? counterfactualMarginRatioRawComputed < 1 : false,
    };
  });

  const rankedCounterfactuals = ablations
    .slice()
    .sort(
      (a, b) =>
        (a.counterfactualMarginRatioRawComputed ?? Number.POSITIVE_INFINITY) -
          (b.counterfactualMarginRatioRawComputed ?? Number.POSITIVE_INFINITY) ||
        String(a.field).localeCompare(String(b.field)),
    );

  const bestCounterfactualMarginRatioRawComputed =
    rankedCounterfactuals
      .map((row) => row.counterfactualMarginRatioRawComputed)
      .find((value): value is number => value != null) ?? null;

  const payload = {
    date: DATE_STAMP,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    blockedReason: null,
    analysisMode: stringOrNull(localization?.analysisMode) ?? 'unknown',
    diagnosticFallbackUsed: Boolean(localization?.diagnosticFallbackUsed),
    diagnosticFallbackSource: stringOrNull(localization?.diagnosticFallbackSource),
    localizationPath: localizationPath.replace(/\\/g, '/'),
    baselineCaseId: String(baseline.id),
    baselineApplicabilityStatus: String(baseline.applicabilityStatus ?? 'UNKNOWN').toUpperCase(),
    baselineMarginRatioRawComputed: baselineMargin,
    candidatePassFoundCounterfactual: ablations.some((row) => row.counterfactualPass),
    bestCounterfactualMarginRatioRawComputed,
    topAblations: rankedCounterfactuals,
    provenance: {
      commitHash,
      localizationCommitHash,
    },
  };

  writeJson(outJsonPath, payload);

  const mdLines = [
    `# G4 Coupling Ablation (${DATE_STAMP})`,
    '',
    BOUNDARY_STATEMENT,
    '',
    `- analysisMode: ${payload.analysisMode}`,
    `- diagnosticFallbackUsed: ${payload.diagnosticFallbackUsed}`,
    `- diagnosticFallbackSource: ${payload.diagnosticFallbackSource ?? 'n/a'}`,
    `- baselineCaseId: ${payload.baselineCaseId}`,
    `- baselineApplicabilityStatus: ${payload.baselineApplicabilityStatus}`,
    `- baselineMarginRatioRawComputed: ${payload.baselineMarginRatioRawComputed}`,
    `- candidatePassFoundCounterfactual: ${payload.candidatePassFoundCounterfactual}`,
    `- bestCounterfactualMarginRatioRawComputed: ${payload.bestCounterfactualMarginRatioRawComputed ?? 'null'}`,
    '',
    '## Counterfactual Term Ablations',
    '',
    '| field | mode | slope | baseline | reference | counterfactual margin | improvement rel | blockedReason |',
    '|---|---|---:|---:|---:|---:|---:|---|',
    ...payload.topAblations.slice(0, topN).map(
      (row) =>
        `| ${row.field} | ${row.estimationMode} | ${row.slopeToMarginRatioRawComputed ?? 'null'} | ${row.baselineValue ?? 'null'} | ${row.referenceMean ?? 'null'} | ${row.counterfactualMarginRatioRawComputed ?? 'null'} | ${row.improvementRel ?? 'null'} | ${row.blockedReason ?? ''} |`,
    ),
    '',
  ];
  writeMd(outMdPath, `${mdLines.join('\n')}\n`);

  return {
    ok: true as const,
    outJsonPath,
    outMdPath,
    baselineCaseId: payload.baselineCaseId,
    baselineMarginRatioRawComputed: payload.baselineMarginRatioRawComputed,
    bestCounterfactualMarginRatioRawComputed: payload.bestCounterfactualMarginRatioRawComputed,
    candidatePassFoundCounterfactual: payload.candidatePassFoundCounterfactual,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(generateG4CouplingAblation()));
}
