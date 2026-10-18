import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

type Wave = 'A' | 'B' | 'C' | 'D';

type GenerateG4CurvatureApplicabilityAuditOptions = {
  rootDir?: string;
  artifactRoot?: string;
  outJsonPath?: string;
  outMdPath?: string;
  waves?: Wave[];
  getCommitHash?: () => string;
};

type CurvatureAuditRow = {
  wave: Wave;
  applicabilityStatus: string | null;
  curvatureEnforced: boolean | null;
  curvatureOk: boolean | null;
  curvatureRatio: number | null;
  curvatureRatioNonDegenerate: boolean | null;
  curvatureFlatSpaceEquivalent: boolean | null;
  curvatureScalar: number | null;
  curvatureRadius_m: number | null;
  tau_s: number | null;
  applicabilityPass: boolean;
  curvatureComparable: boolean;
  ratioNonDegenerateEvidence: boolean;
  ratioOrFlatEvidence: boolean;
  scalarRadiusPresent: boolean;
  windowEvidenceReady: boolean;
  missingFields: string[];
  blockedReasonTokens: string[];
};

type CurvatureAuditBlockedReason =
  | 'missing_qi_forensics_wave_artifacts'
  | 'curvature_fields_missing'
  | 'curvature_applicability_not_pass'
  | 'curvature_enforcement_not_true'
  | 'curvature_ok_not_true'
  | 'curvature_ratio_degenerate'
  | 'curvature_scalar_radius_missing';

const DATE = '2026-03-02';
const DEFAULT_ARTIFACT_ROOT = path.join('artifacts', 'research', 'full-solve');
const DEFAULT_OUT_JSON = path.join(DEFAULT_ARTIFACT_ROOT, `g4-curvature-applicability-audit-${DATE}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-g4-curvature-applicability-audit-${DATE}.md`);
const WAVES: Wave[] = ['A', 'B', 'C', 'D'];
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const boolOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

const finiteOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const readJson = (filePath: string): Record<string, unknown> | null => {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const writeJson = (filePath: string, payload: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
};

const writeMarkdown = (filePath: string, text: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
};

const resolveHeadCommitHash = (rootDir: string): string | null => {
  for (const cwd of [rootDir, process.cwd()]) {
    try {
      return execSync('git rev-parse HEAD', { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      continue;
    }
  }
  return null;
};

const classifyRow = (wave: Wave, qi: Record<string, unknown>): CurvatureAuditRow => {
  const applicabilityStatus = stringOrNull(qi.applicabilityStatus);
  const curvatureEnforced = boolOrNull(qi.curvatureEnforced);
  const curvatureOk = boolOrNull(qi.curvatureOk);
  const curvatureRatio = finiteOrNull(qi.curvatureRatio);
  const curvatureRatioNonDegenerate = boolOrNull(qi.curvatureRatioNonDegenerate);
  const curvatureFlatSpaceEquivalent = boolOrNull(qi.curvatureFlatSpaceEquivalent);
  const curvatureScalar = finiteOrNull(qi.curvatureScalar);
  const curvatureRadius_m = finiteOrNull(qi.curvatureRadius_m);
  const tau_s = finiteOrNull(qi.tau_s);

  const missingFields: string[] = [];
  if (applicabilityStatus == null) missingFields.push('applicabilityStatus');
  if (curvatureEnforced == null) missingFields.push('curvatureEnforced');
  if (curvatureOk == null) missingFields.push('curvatureOk');
  if (curvatureRatio == null) missingFields.push('curvatureRatio');
  if (curvatureRatioNonDegenerate == null) missingFields.push('curvatureRatioNonDegenerate');
  if (tau_s == null) missingFields.push('tau_s');

  const applicabilityPass = String(applicabilityStatus ?? 'UNKNOWN').toUpperCase() === 'PASS';
  const curvatureComparable = applicabilityPass && curvatureEnforced === true && curvatureOk === true;
  const ratioNonDegenerateEvidence =
    curvatureRatioNonDegenerate === true && curvatureRatio != null && Number.isFinite(curvatureRatio) && Math.abs(curvatureRatio) > 0;
  const flatSpaceEquivalentEvidence =
    curvatureFlatSpaceEquivalent === true &&
    curvatureScalar != null &&
    curvatureScalar === 0 &&
    curvatureRatio != null &&
    curvatureRatio === 0 &&
    curvatureOk === true;
  const ratioOrFlatEvidence = ratioNonDegenerateEvidence || flatSpaceEquivalentEvidence;
  const scalarRadiusPresent =
    curvatureScalar != null &&
    Number.isFinite(curvatureScalar) &&
    ((curvatureRadius_m != null && Number.isFinite(curvatureRadius_m) && curvatureRadius_m > 0) ||
      flatSpaceEquivalentEvidence);
  const windowEvidenceReady = curvatureComparable && ratioOrFlatEvidence && scalarRadiusPresent;

  const blockedReasonTokens: string[] = [];
  if (missingFields.length > 0) blockedReasonTokens.push('curvature_fields_missing');
  if (!applicabilityPass) blockedReasonTokens.push('curvature_applicability_not_pass');
  if (curvatureEnforced !== true) blockedReasonTokens.push('curvature_enforcement_not_true');
  if (curvatureOk !== true) blockedReasonTokens.push('curvature_ok_not_true');
  if (!ratioOrFlatEvidence) blockedReasonTokens.push('curvature_ratio_degenerate');
  if (!scalarRadiusPresent) blockedReasonTokens.push('curvature_scalar_radius_missing');

  return {
    wave,
    applicabilityStatus,
    curvatureEnforced,
    curvatureOk,
    curvatureRatio,
    curvatureRatioNonDegenerate,
    curvatureFlatSpaceEquivalent,
    curvatureScalar,
    curvatureRadius_m,
    tau_s,
    applicabilityPass,
    curvatureComparable,
    ratioNonDegenerateEvidence,
    ratioOrFlatEvidence,
    scalarRadiusPresent,
    windowEvidenceReady,
    missingFields,
    blockedReasonTokens,
  };
};

export const generateG4CurvatureApplicabilityAudit = (options: GenerateG4CurvatureApplicabilityAuditOptions = {}) => {
  const rootDir = options.rootDir ?? '.';
  const artifactRoot = options.artifactRoot ?? path.join(rootDir, DEFAULT_ARTIFACT_ROOT);
  const outJsonPath = options.outJsonPath ?? path.join(rootDir, DEFAULT_OUT_JSON);
  const outMdPath = options.outMdPath ?? path.join(rootDir, DEFAULT_OUT_MD);
  const waves = options.waves ?? WAVES;
  const getCommitHash =
    options.getCommitHash ??
    (() => execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());

  const rows: CurvatureAuditRow[] = [];
  const canonicalMissingWaves: Wave[] = [];
  for (const wave of waves) {
    const qiPath = path.join(artifactRoot, wave, 'qi-forensics.json');
    const qi = readJson(qiPath);
    if (!qi) {
      canonicalMissingWaves.push(wave);
      continue;
    }
    rows.push(classifyRow(wave, qi));
  }

  const blockedReason: CurvatureAuditBlockedReason | null =
    canonicalMissingWaves.length > 0
      ? 'missing_qi_forensics_wave_artifacts'
      : rows.some((row) => row.missingFields.length > 0)
        ? 'curvature_fields_missing'
        : rows.some((row) => !row.applicabilityPass)
          ? 'curvature_applicability_not_pass'
              : rows.some((row) => row.curvatureEnforced !== true)
                ? 'curvature_enforcement_not_true'
                : rows.some((row) => row.curvatureOk !== true)
                  ? 'curvature_ok_not_true'
                  : rows.some((row) => !row.ratioOrFlatEvidence)
                    ? 'curvature_ratio_degenerate'
                    : rows.some((row) => !row.scalarRadiusPresent)
                      ? 'curvature_scalar_radius_missing'
                  : null;

  const missingFieldCounts = Object.fromEntries(
    [...new Set(rows.flatMap((row) => row.missingFields))]
      .sort((a, b) => a.localeCompare(b))
      .map((field) => [field, rows.filter((row) => row.missingFields.includes(field)).length]),
  );
  const blockedTokenCounts = Object.fromEntries(
    [...new Set(rows.flatMap((row) => row.blockedReasonTokens))]
      .sort((a, b) => a.localeCompare(b))
      .map((token) => [token, rows.filter((row) => row.blockedReasonTokens.includes(token)).length]),
  );

  const curvatureRatios = rows
    .map((row) => row.curvatureRatio)
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b);
  const minCurvatureRatio = curvatureRatios.length > 0 ? curvatureRatios[0] : null;
  const maxCurvatureRatio = curvatureRatios.length > 0 ? curvatureRatios[curvatureRatios.length - 1] : null;

  const commitHash = getCommitHash();
  const headCommitHash = resolveHeadCommitHash(rootDir);
  const payload = {
    date: DATE,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    blockedReason,
    curvatureEvidenceStatus: blockedReason == null ? 'pass' : 'blocked',
    canonicalMissingWaves,
    allApplicabilityPass: rows.length > 0 && rows.every((row) => row.applicabilityPass),
    allCurvatureComparable: rows.length > 0 && rows.every((row) => row.curvatureComparable),
    allRatioNonDegenerateEvidence: rows.length > 0 && rows.every((row) => row.ratioNonDegenerateEvidence),
    allRatioOrFlatEvidence: rows.length > 0 && rows.every((row) => row.ratioOrFlatEvidence),
    allScalarRadiusPresent: rows.length > 0 && rows.every((row) => row.scalarRadiusPresent),
    allWindowEvidenceReady: rows.length > 0 && rows.every((row) => row.windowEvidenceReady),
    comparableWaveCount: rows.filter((row) => row.curvatureComparable).length,
    nonDegenerateWaveCount: rows.filter((row) => row.ratioNonDegenerateEvidence).length,
    ratioOrFlatWaveCount: rows.filter((row) => row.ratioOrFlatEvidence).length,
    flatSpaceEquivalentWaveCount: rows.filter((row) => row.curvatureFlatSpaceEquivalent === true).length,
    scalarRadiusPresentWaveCount: rows.filter((row) => row.scalarRadiusPresent).length,
    minCurvatureRatio,
    maxCurvatureRatio,
    missingFieldCounts,
    blockedTokenCounts,
    waves: rows,
    provenance: {
      commitHash,
      headCommitHash,
      commitHashMatchesHead: headCommitHash != null && commitHash === headCommitHash,
    },
  };

  writeJson(outJsonPath, payload);

  const waveRows = rows
    .map(
      (row) =>
        `| ${row.wave} | ${row.applicabilityStatus ?? 'n/a'} | ${row.curvatureEnforced ?? 'n/a'} | ${row.curvatureOk ?? 'n/a'} | ${row.curvatureRatio ?? 'n/a'} | ${row.curvatureRatioNonDegenerate ?? 'n/a'} | ${row.curvatureFlatSpaceEquivalent ?? 'n/a'} | ${row.curvatureScalar ?? 'n/a'} | ${row.curvatureRadius_m ?? 'n/a'} | ${row.tau_s ?? 'n/a'} | ${row.windowEvidenceReady} | ${row.blockedReasonTokens.join(', ') || 'none'} |`,
    )
    .join('\n');

  const md = `# G4 Curvature Applicability Audit (${DATE})

${BOUNDARY_STATEMENT}

## Summary
- curvature evidence status: ${payload.curvatureEvidenceStatus}
- blocked reason: ${payload.blockedReason ?? 'none'}
- canonical missing waves: ${payload.canonicalMissingWaves.join(', ') || 'none'}
- all applicability PASS: ${payload.allApplicabilityPass}
- all curvature comparable: ${payload.allCurvatureComparable}
- all ratio non-degenerate evidence: ${payload.allRatioNonDegenerateEvidence}
- all ratio-or-flat evidence: ${payload.allRatioOrFlatEvidence}
- all scalar/radius present: ${payload.allScalarRadiusPresent}
- all window evidence ready: ${payload.allWindowEvidenceReady}
- min curvatureRatio: ${payload.minCurvatureRatio ?? 'n/a'}
- max curvatureRatio: ${payload.maxCurvatureRatio ?? 'n/a'}
- provenance commit: ${commitHash}
- provenance freshness vs HEAD: ${payload.provenance.commitHashMatchesHead ? 'fresh' : 'stale_or_missing'}
- canonical-authoritative statement: canonical campaign decision remains authoritative; curvature applicability evidence is fail-closed.

## Per-wave curvature applicability evidence
| wave | applicabilityStatus | curvatureEnforced | curvatureOk | curvatureRatio | curvatureRatioNonDegenerate | curvatureFlatSpaceEquivalent | curvatureScalar | curvatureRadius_m | tau_s | windowEvidenceReady | blockedReasonTokens |
|---|---|---|---|---:|---|---:|---:|---:|---:|---|---|
${waveRows || '| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |'}
`;
  writeMarkdown(outMdPath, `${md}\n`);

  return {
    ok: blockedReason == null,
    blockedReason,
    outJsonPath,
    outMdPath,
    payload,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = generateG4CurvatureApplicabilityAudit();
  console.log(JSON.stringify({ ok: result.ok, blockedReason: result.blockedReason, json: result.outJsonPath, markdown: result.outMdPath }));
}
