import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

type Wave = 'A' | 'B' | 'C' | 'D';

type GenerateG4UncertaintyAuditOptions = {
  rootDir?: string;
  artifactRoot?: string;
  outJsonPath?: string;
  outMdPath?: string;
  waves?: Wave[];
  getCommitHash?: () => string;
};

type UncertaintyAuditRow = {
  wave: Wave;
  applicabilityStatus: string | null;
  uncertaintyDecisionClass: string | null;
  uncertaintyCouldFlip: boolean | null;
  uncertaintySigma_Jm3: number | null;
  uncertaintySigmaMeasurement_Jm3: number | null;
  uncertaintySigmaModel_Jm3: number | null;
  uncertaintySigmaBridge_Jm3: number | null;
  uncertaintySigmaTau_Jm3: number | null;
  uncertaintyDominantComponent: string | null;
  uncertaintyBandKSigma: number | null;
  uncertaintySlackPolicy_Jm3: number | null;
  uncertaintySlackComputed_Jm3: number | null;
  uncertaintyBandLowerPolicy_Jm3: number | null;
  uncertaintyBandUpperPolicy_Jm3: number | null;
  uncertaintyBandLowerComputed_Jm3: number | null;
  uncertaintyBandUpperComputed_Jm3: number | null;
  robustPass: boolean;
  couldFlip: boolean;
  slackPositive: boolean;
  applicabilityPass: boolean;
  missingFields: string[];
  blockedReasonTokens: string[];
};

type UncertaintyAuditBlockedReason =
  | 'missing_qi_forensics_wave_artifacts'
  | 'uncertainty_fields_missing'
  | 'uncertainty_components_missing'
  | 'uncertainty_applicability_not_pass'
  | 'uncertainty_decision_not_robust_pass'
  | 'uncertainty_could_flip_true'
  | 'uncertainty_slack_non_positive';

const DATE = '2026-03-02';
const DEFAULT_ARTIFACT_ROOT = path.join('artifacts', 'research', 'full-solve');
const DEFAULT_OUT_JSON = path.join(DEFAULT_ARTIFACT_ROOT, `g4-uncertainty-audit-${DATE}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-g4-uncertainty-audit-${DATE}.md`);
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

const classifyRow = (wave: Wave, qi: Record<string, unknown>): UncertaintyAuditRow => {
  const applicabilityStatus = stringOrNull(qi.applicabilityStatus);
  const uncertaintyDecisionClass = stringOrNull(qi.uncertaintyDecisionClass);
  const uncertaintyCouldFlip = boolOrNull(qi.uncertaintyCouldFlip);
  const uncertaintySigma_Jm3 = finiteOrNull(qi.uncertaintySigma_Jm3);
  const uncertaintySigmaMeasurement_Jm3 = finiteOrNull(qi.uncertaintySigmaMeasurement_Jm3);
  const uncertaintySigmaModel_Jm3 = finiteOrNull(qi.uncertaintySigmaModel_Jm3);
  const uncertaintySigmaBridge_Jm3 = finiteOrNull(qi.uncertaintySigmaBridge_Jm3);
  const uncertaintySigmaTau_Jm3 = finiteOrNull(qi.uncertaintySigmaTau_Jm3);
  const uncertaintyDominantComponent = stringOrNull(qi.uncertaintyDominantComponent);
  const uncertaintyBandKSigma = finiteOrNull(qi.uncertaintyBandKSigma);
  const uncertaintySlackPolicy_Jm3 = finiteOrNull(qi.uncertaintySlackPolicy_Jm3);
  const uncertaintySlackComputed_Jm3 = finiteOrNull(qi.uncertaintySlackComputed_Jm3);
  const uncertaintyBandLowerPolicy_Jm3 = finiteOrNull(qi.uncertaintyBandLowerPolicy_Jm3);
  const uncertaintyBandUpperPolicy_Jm3 = finiteOrNull(qi.uncertaintyBandUpperPolicy_Jm3);
  const uncertaintyBandLowerComputed_Jm3 = finiteOrNull(qi.uncertaintyBandLowerComputed_Jm3);
  const uncertaintyBandUpperComputed_Jm3 = finiteOrNull(qi.uncertaintyBandUpperComputed_Jm3);

  const missingFields: string[] = [];
  if (applicabilityStatus == null) missingFields.push('applicabilityStatus');
  if (uncertaintyDecisionClass == null) missingFields.push('uncertaintyDecisionClass');
  if (uncertaintyCouldFlip == null) missingFields.push('uncertaintyCouldFlip');
  if (uncertaintySigma_Jm3 == null) missingFields.push('uncertaintySigma_Jm3');
  if (uncertaintySigmaMeasurement_Jm3 == null) missingFields.push('uncertaintySigmaMeasurement_Jm3');
  if (uncertaintySigmaModel_Jm3 == null) missingFields.push('uncertaintySigmaModel_Jm3');
  if (uncertaintySigmaBridge_Jm3 == null) missingFields.push('uncertaintySigmaBridge_Jm3');
  if (uncertaintySigmaTau_Jm3 == null) missingFields.push('uncertaintySigmaTau_Jm3');
  if (uncertaintyDominantComponent == null) missingFields.push('uncertaintyDominantComponent');
  if (uncertaintyBandKSigma == null) missingFields.push('uncertaintyBandKSigma');
  if (uncertaintySlackPolicy_Jm3 == null) missingFields.push('uncertaintySlackPolicy_Jm3');
  if (uncertaintySlackComputed_Jm3 == null) missingFields.push('uncertaintySlackComputed_Jm3');
  if (uncertaintyBandLowerPolicy_Jm3 == null) missingFields.push('uncertaintyBandLowerPolicy_Jm3');
  if (uncertaintyBandUpperPolicy_Jm3 == null) missingFields.push('uncertaintyBandUpperPolicy_Jm3');
  if (uncertaintyBandLowerComputed_Jm3 == null) missingFields.push('uncertaintyBandLowerComputed_Jm3');
  if (uncertaintyBandUpperComputed_Jm3 == null) missingFields.push('uncertaintyBandUpperComputed_Jm3');

  const robustPass = uncertaintyDecisionClass === 'robust_pass';
  const couldFlip = uncertaintyCouldFlip === true;
  const slackPositive =
    (uncertaintySlackPolicy_Jm3 ?? Number.NEGATIVE_INFINITY) > 0 && (uncertaintySlackComputed_Jm3 ?? Number.NEGATIVE_INFINITY) > 0;
  const applicabilityPass = String(applicabilityStatus ?? 'UNKNOWN').toUpperCase() === 'PASS';

  const blockedReasonTokens: string[] = [];
  if (missingFields.length > 0) blockedReasonTokens.push('uncertainty_fields_missing');
  if (
    uncertaintySigmaMeasurement_Jm3 == null ||
    uncertaintySigmaModel_Jm3 == null ||
    uncertaintySigmaBridge_Jm3 == null ||
    uncertaintySigmaTau_Jm3 == null ||
    uncertaintyDominantComponent == null
  ) {
    blockedReasonTokens.push('uncertainty_components_missing');
  }
  if (!applicabilityPass) blockedReasonTokens.push('uncertainty_applicability_not_pass');
  if (!robustPass) blockedReasonTokens.push('uncertainty_decision_not_robust_pass');
  if (couldFlip) blockedReasonTokens.push('uncertainty_could_flip_true');
  if (!slackPositive) blockedReasonTokens.push('uncertainty_slack_non_positive');

  return {
    wave,
    applicabilityStatus,
    uncertaintyDecisionClass,
    uncertaintyCouldFlip,
    uncertaintySigma_Jm3,
    uncertaintySigmaMeasurement_Jm3,
    uncertaintySigmaModel_Jm3,
    uncertaintySigmaBridge_Jm3,
    uncertaintySigmaTau_Jm3,
    uncertaintyDominantComponent,
    uncertaintyBandKSigma,
    uncertaintySlackPolicy_Jm3,
    uncertaintySlackComputed_Jm3,
    uncertaintyBandLowerPolicy_Jm3,
    uncertaintyBandUpperPolicy_Jm3,
    uncertaintyBandLowerComputed_Jm3,
    uncertaintyBandUpperComputed_Jm3,
    robustPass,
    couldFlip,
    slackPositive,
    applicabilityPass,
    missingFields,
    blockedReasonTokens,
  };
};

export const generateG4UncertaintyAudit = (options: GenerateG4UncertaintyAuditOptions = {}) => {
  const rootDir = options.rootDir ?? '.';
  const artifactRoot = options.artifactRoot ?? path.join(rootDir, DEFAULT_ARTIFACT_ROOT);
  const outJsonPath = options.outJsonPath ?? path.join(rootDir, DEFAULT_OUT_JSON);
  const outMdPath = options.outMdPath ?? path.join(rootDir, DEFAULT_OUT_MD);
  const waves = options.waves ?? WAVES;
  const getCommitHash =
    options.getCommitHash ??
    (() => execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());

  const rows: UncertaintyAuditRow[] = [];
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

  const blockedReason: UncertaintyAuditBlockedReason | null =
    canonicalMissingWaves.length > 0
      ? 'missing_qi_forensics_wave_artifacts'
      : rows.some((row) => row.missingFields.length > 0)
        ? 'uncertainty_fields_missing'
        : rows.some(
              (row) =>
                row.uncertaintySigmaMeasurement_Jm3 == null ||
                row.uncertaintySigmaModel_Jm3 == null ||
                row.uncertaintySigmaBridge_Jm3 == null ||
                row.uncertaintySigmaTau_Jm3 == null ||
                row.uncertaintyDominantComponent == null,
            )
          ? 'uncertainty_components_missing'
        : rows.some((row) => !row.applicabilityPass)
          ? 'uncertainty_applicability_not_pass'
          : rows.some((row) => !row.robustPass)
            ? 'uncertainty_decision_not_robust_pass'
            : rows.some((row) => row.couldFlip)
              ? 'uncertainty_could_flip_true'
              : rows.some((row) => !row.slackPositive)
                ? 'uncertainty_slack_non_positive'
                : null;

  const decisionClassCounts = Object.fromEntries(
    [...new Set(rows.map((row) => row.uncertaintyDecisionClass ?? 'null'))]
      .sort((a, b) => a.localeCompare(b))
      .map((decisionClass) => [decisionClass, rows.filter((row) => (row.uncertaintyDecisionClass ?? 'null') === decisionClass).length]),
  );
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

  const minUncertaintySlackPolicy_Jm3 =
    rows
      .map((row) => row.uncertaintySlackPolicy_Jm3)
      .filter((value): value is number => value != null)
      .sort((a, b) => a - b)[0] ?? null;
  const minUncertaintySlackComputed_Jm3 =
    rows
      .map((row) => row.uncertaintySlackComputed_Jm3)
      .filter((value): value is number => value != null)
      .sort((a, b) => a - b)[0] ?? null;
  const maxUncertaintySigma_Jm3 =
    rows
      .map((row) => row.uncertaintySigma_Jm3)
      .filter((value): value is number => value != null)
      .sort((a, b) => b - a)[0] ?? null;
  const maxUncertaintySigmaMeasurement_Jm3 =
    rows
      .map((row) => row.uncertaintySigmaMeasurement_Jm3)
      .filter((value): value is number => value != null)
      .sort((a, b) => b - a)[0] ?? null;
  const maxUncertaintySigmaModel_Jm3 =
    rows
      .map((row) => row.uncertaintySigmaModel_Jm3)
      .filter((value): value is number => value != null)
      .sort((a, b) => b - a)[0] ?? null;
  const maxUncertaintySigmaBridge_Jm3 =
    rows
      .map((row) => row.uncertaintySigmaBridge_Jm3)
      .filter((value): value is number => value != null)
      .sort((a, b) => b - a)[0] ?? null;
  const maxUncertaintySigmaTau_Jm3 =
    rows
      .map((row) => row.uncertaintySigmaTau_Jm3)
      .filter((value): value is number => value != null)
      .sort((a, b) => b - a)[0] ?? null;
  const dominantComponentCounts = Object.fromEntries(
    [...new Set(rows.map((row) => row.uncertaintyDominantComponent ?? 'null'))]
      .sort((a, b) => a.localeCompare(b))
      .map((component) => [component, rows.filter((row) => (row.uncertaintyDominantComponent ?? 'null') === component).length]),
  );

  const commitHash = getCommitHash();
  const headCommitHash = resolveHeadCommitHash(rootDir);
  const payload = {
    date: DATE,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    blockedReason,
    canonicalMissingWaves,
    uncertaintyEvidenceStatus: blockedReason == null ? 'pass' : 'blocked',
    canonicalComparableWaveCount: rows.filter((row) => row.blockedReasonTokens.length === 0).length,
    allApplicabilityPass: rows.length > 0 && rows.every((row) => row.applicabilityPass),
    allDecisionRobustPass: rows.length > 0 && rows.every((row) => row.robustPass),
    anyCouldFlip: rows.some((row) => row.couldFlip),
    allSlackPositive: rows.length > 0 && rows.every((row) => row.slackPositive),
    robustPassWaveCount: rows.filter((row) => row.robustPass).length,
    couldFlipWaveCount: rows.filter((row) => row.couldFlip).length,
    decisionClassCounts,
    minUncertaintySlackPolicy_Jm3,
    minUncertaintySlackComputed_Jm3,
    maxUncertaintySigma_Jm3,
    maxUncertaintySigmaMeasurement_Jm3,
    maxUncertaintySigmaModel_Jm3,
    maxUncertaintySigmaBridge_Jm3,
    maxUncertaintySigmaTau_Jm3,
    dominantComponentCounts,
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
      (row) => {
        const components = [
          `measurement=${row.uncertaintySigmaMeasurement_Jm3 ?? 'n/a'}`,
          `model=${row.uncertaintySigmaModel_Jm3 ?? 'n/a'}`,
          `bridge=${row.uncertaintySigmaBridge_Jm3 ?? 'n/a'}`,
          `tau=${row.uncertaintySigmaTau_Jm3 ?? 'n/a'}`,
          `dominant=${row.uncertaintyDominantComponent ?? 'n/a'}`,
        ].join(';');
        return `| ${row.wave} | ${row.applicabilityStatus ?? 'n/a'} | ${row.uncertaintyDecisionClass ?? 'n/a'} | ${row.uncertaintyCouldFlip ?? 'n/a'} | ${row.uncertaintySlackPolicy_Jm3 ?? 'n/a'} | ${row.uncertaintySlackComputed_Jm3 ?? 'n/a'} | ${components} | ${row.blockedReasonTokens.join(', ') || 'none'} |`;
      },
    )
    .join('\n');

  const md = `# G4 Uncertainty Audit (${DATE})

${BOUNDARY_STATEMENT}

## Summary
- uncertainty evidence status: ${payload.uncertaintyEvidenceStatus}
- blocked reason: ${payload.blockedReason ?? 'none'}
- canonical missing waves: ${payload.canonicalMissingWaves.join(', ') || 'none'}
- all applicability PASS: ${payload.allApplicabilityPass}
- all decision classes robust_pass: ${payload.allDecisionRobustPass}
- any uncertainty could flip: ${payload.anyCouldFlip}
- all uncertainty slack positive: ${payload.allSlackPositive}
- min uncertaintySlackPolicy_Jm3: ${payload.minUncertaintySlackPolicy_Jm3 ?? 'n/a'}
- min uncertaintySlackComputed_Jm3: ${payload.minUncertaintySlackComputed_Jm3 ?? 'n/a'}
- max uncertaintySigma_Jm3: ${payload.maxUncertaintySigma_Jm3 ?? 'n/a'}
- max uncertaintySigmaMeasurement_Jm3: ${payload.maxUncertaintySigmaMeasurement_Jm3 ?? 'n/a'}
- max uncertaintySigmaModel_Jm3: ${payload.maxUncertaintySigmaModel_Jm3 ?? 'n/a'}
- max uncertaintySigmaBridge_Jm3: ${payload.maxUncertaintySigmaBridge_Jm3 ?? 'n/a'}
- max uncertaintySigmaTau_Jm3: ${payload.maxUncertaintySigmaTau_Jm3 ?? 'n/a'}
- dominant component counts: ${Object.entries(payload.dominantComponentCounts).map(([k, v]) => `${k}:${v}`).join(', ') || 'none'}
- provenance commit: ${commitHash}
- provenance freshness vs HEAD: ${payload.provenance.commitHashMatchesHead ? 'fresh' : 'stale_or_missing'}
- canonical-authoritative statement: canonical campaign decision remains authoritative; uncertainty evidence is fail-closed.

## Per-wave uncertainty evidence
| wave | applicabilityStatus | uncertaintyDecisionClass | uncertaintyCouldFlip | uncertaintySlackPolicy_Jm3 | uncertaintySlackComputed_Jm3 | uncertaintyComponents | blockedReasonTokens |
|---|---|---|---|---:|---:|---|---|
${waveRows || '| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |'}
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
  const result = generateG4UncertaintyAudit();
  console.log(JSON.stringify({ ok: result.ok, blockedReason: result.blockedReason, json: result.outJsonPath, markdown: result.outMdPath }));
}
