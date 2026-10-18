import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

type Wave = 'A' | 'B' | 'C' | 'D';

type GenerateG4LiteratureParityReplayOptions = {
  rootDir?: string;
  artifactRoot?: string;
  outJsonPath?: string;
  outMdPath?: string;
  getCommitHash?: () => string;
};

type ParityWaveRow = {
  wave: Wave;
  mappingPass: boolean;
  kernelPass: boolean;
  curvaturePass: boolean;
  uncertaintyPass: boolean;
  gateComparable: boolean;
  parityPass: boolean;
  applicabilityStatus: string | null;
  marginRatioRaw: number | null;
  samplingKernelIdentity: string | null;
  samplingKernelNormalization: string | null;
  qeiStateClass: string | null;
  qeiRenormalizationScheme: string | null;
  qeiOperatorMapping: string | null;
  K: number | null;
  tau_s: number | null;
  boundComputed_Jm3: number | null;
  boundReplay_Jm3: number | null;
  boundReplayResidualAbs_Jm3: number | null;
  missingFields: string[];
  blockedReasonTokens: string[];
};

type ParityBlockedReason =
  | 'missing_required_artifacts'
  | 'parity_provenance_mismatch'
  | 'parity_fields_missing'
  | 'literature_parity_not_pass';

const DATE = '2026-03-02';
const WAVES: Wave[] = ['A', 'B', 'C', 'D'];
const DEFAULT_ARTIFACT_ROOT = path.join('artifacts', 'research', 'full-solve');
const DEFAULT_OUT_JSON = path.join(DEFAULT_ARTIFACT_ROOT, `g4-literature-parity-replay-${DATE}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-g4-literature-parity-replay-${DATE}.md`);
const REPLAY_REL_TOL = 1e-9;
const REPLAY_ABS_TOL = 1e-9;
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

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

const upper = (value: string | null): string => String(value ?? '').toUpperCase();

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
};

const indexByWave = (rows: unknown): Record<Wave, Record<string, unknown> | null> => {
  const output: Record<Wave, Record<string, unknown> | null> = { A: null, B: null, C: null, D: null };
  if (!Array.isArray(rows)) return output;
  for (const candidate of rows) {
    const row = candidate as Record<string, unknown>;
    const wave = stringOrNull(row.wave) as Wave | null;
    if (wave && output[wave] == null) output[wave] = row;
  }
  return output;
};

const replayResidualPass = (residualAbs: number | null, baseline: number | null): boolean => {
  if (residualAbs == null || baseline == null) return false;
  const tol = Math.max(REPLAY_ABS_TOL, Math.abs(baseline) * REPLAY_REL_TOL);
  return residualAbs <= tol;
};

export const generateG4LiteratureParityReplay = (options: GenerateG4LiteratureParityReplayOptions = {}) => {
  const rootDir = options.rootDir ?? '.';
  const artifactRoot = options.artifactRoot ?? path.join(rootDir, DEFAULT_ARTIFACT_ROOT);
  const outJsonPath = options.outJsonPath ?? path.join(rootDir, DEFAULT_OUT_JSON);
  const outMdPath = options.outMdPath ?? path.join(rootDir, DEFAULT_OUT_MD);
  const getCommitHash =
    options.getCommitHash ??
    (() => execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());

  const kernelPath = path.join(artifactRoot, 'g4-kernel-provenance-audit-2026-03-02.json');
  const operatorPath = path.join(artifactRoot, 'g4-operator-mapping-audit-2026-03-02.json');
  const curvaturePath = path.join(artifactRoot, 'g4-curvature-applicability-audit-2026-03-02.json');
  const uncertaintyPath = path.join(artifactRoot, 'g4-uncertainty-audit-2026-03-02.json');
  const ledgerPath = path.join(artifactRoot, 'g4-decision-ledger-2026-02-26.json');

  const kernel = readJson(kernelPath);
  const operator = readJson(operatorPath);
  const curvature = readJson(curvaturePath);
  const uncertainty = readJson(uncertaintyPath);
  const ledger = readJson(ledgerPath);

  const missingArtifacts = [
    kernel ? null : 'g4-kernel-provenance-audit-2026-03-02.json',
    operator ? null : 'g4-operator-mapping-audit-2026-03-02.json',
    curvature ? null : 'g4-curvature-applicability-audit-2026-03-02.json',
    uncertainty ? null : 'g4-uncertainty-audit-2026-03-02.json',
    ledger ? null : 'g4-decision-ledger-2026-02-26.json',
  ].filter((entry): entry is string => entry != null);

  const commitHash = getCommitHash();
  const headCommitHash = resolveHeadCommitHash(rootDir);

  const artifactCommits = {
    kernel: stringOrNull(kernel?.provenance?.commitHash),
    operator: stringOrNull(operator?.provenance?.commitHash),
    curvature: stringOrNull(curvature?.provenance?.commitHash),
    uncertainty: stringOrNull(uncertainty?.provenance?.commitHash),
    ledger: stringOrNull(ledger?.commitHash ?? ledger?.provenance?.commitHash),
  };

  const artifactCommitsMatchHead =
    Object.values(artifactCommits).every((value) => value != null && value === commitHash) && headCommitHash === commitHash;

  const kernelRows = indexByWave(kernel?.waves);
  const operatorRows = indexByWave(operator?.waves);
  const curvatureRows = indexByWave(curvature?.waves);
  const uncertaintyRows = indexByWave(uncertainty?.waves);
  const ledgerWaves = (ledger?.waves as Record<string, unknown> | undefined) ?? {};

  const replayScales = WAVES.map((wave) => finiteOrNull(kernelRows[wave]?.replayKernelScale)).filter(
    (value): value is number => value != null && value > 0,
  );
  const replayScaleReference = median(replayScales);

  const rows: ParityWaveRow[] = WAVES.map((wave) => {
    const kRow = kernelRows[wave];
    const oRow = operatorRows[wave];
    const cRow = curvatureRows[wave];
    const uRow = uncertaintyRows[wave];
    const lRow = (ledgerWaves[wave] as Record<string, unknown> | undefined) ?? {};

    const applicabilityStatus = stringOrNull(lRow.applicabilityStatus);
    const marginRatioRaw = finiteOrNull(lRow.marginRatioRaw);
    const K = finiteOrNull(kRow?.K);
    const tau_s = finiteOrNull(kRow?.tau_s);
    const boundComputed_Jm3 = finiteOrNull(kRow?.boundComputed_Jm3);
    const boundReplay_Jm3 =
      K != null && tau_s != null && tau_s > 0 && replayScaleReference != null
        ? -(Math.abs(K) / Math.pow(tau_s, 4)) * replayScaleReference
        : null;
    const boundReplayResidualAbs_Jm3 =
      boundReplay_Jm3 != null && boundComputed_Jm3 != null ? Math.abs(boundReplay_Jm3 - boundComputed_Jm3) : null;

    const mappingPass = oRow?.mappingComparable === true && oRow?.mappingBridgeReady === true;
    const kernelPass =
      kRow?.normalizationPass === true &&
      kRow?.unitsPass === true &&
      kRow?.derivationPass === true &&
      kRow?.replayPass === true &&
      replayResidualPass(boundReplayResidualAbs_Jm3, boundComputed_Jm3);
    const curvaturePass = cRow?.applicabilityPass === true && cRow?.ratioOrFlatEvidence === true && cRow?.windowEvidenceReady === true;
    const uncertaintyPass = uRow?.robustPass === true && uRow?.couldFlip === false && uRow?.slackPositive === true;
    const gateComparable = upper(applicabilityStatus) === 'PASS' && marginRatioRaw != null && marginRatioRaw < 1;

    const missingFields: string[] = [];
    if (!kRow) missingFields.push('kernelRow');
    if (!oRow) missingFields.push('operatorRow');
    if (!cRow) missingFields.push('curvatureRow');
    if (!uRow) missingFields.push('uncertaintyRow');
    if (applicabilityStatus == null) missingFields.push('ledger.applicabilityStatus');
    if (marginRatioRaw == null) missingFields.push('ledger.marginRatioRaw');
    if (K == null) missingFields.push('kernel.K');
    if (tau_s == null) missingFields.push('kernel.tau_s');
    if (boundComputed_Jm3 == null) missingFields.push('kernel.boundComputed_Jm3');
    if (boundReplay_Jm3 == null) missingFields.push('boundReplay_Jm3');

    const blockedReasonTokens: string[] = [];
    if (!mappingPass) blockedReasonTokens.push('operator_mapping_not_pass');
    if (!kernelPass) blockedReasonTokens.push('kernel_replay_not_pass');
    if (!curvaturePass) blockedReasonTokens.push('curvature_applicability_not_pass');
    if (!uncertaintyPass) blockedReasonTokens.push('uncertainty_robustness_not_pass');
    if (!gateComparable) blockedReasonTokens.push('gate_comparability_not_pass');
    if (missingFields.length > 0) blockedReasonTokens.push('parity_fields_missing');

    const parityPass = missingFields.length === 0 && mappingPass && kernelPass && curvaturePass && uncertaintyPass && gateComparable;

    return {
      wave,
      mappingPass,
      kernelPass,
      curvaturePass,
      uncertaintyPass,
      gateComparable,
      parityPass,
      applicabilityStatus,
      marginRatioRaw,
      samplingKernelIdentity: stringOrNull(kRow?.samplingKernelIdentity),
      samplingKernelNormalization: stringOrNull(kRow?.samplingKernelNormalization),
      qeiStateClass: stringOrNull(oRow?.qeiStateClass),
      qeiRenormalizationScheme: stringOrNull(oRow?.qeiRenormalizationScheme),
      qeiOperatorMapping: stringOrNull(oRow?.qeiOperatorMapping),
      K,
      tau_s,
      boundComputed_Jm3,
      boundReplay_Jm3,
      boundReplayResidualAbs_Jm3,
      missingFields,
      blockedReasonTokens,
    };
  });

  const topMismatches = rows
    .filter((row) => !row.parityPass)
    .map((row) => ({
      wave: row.wave,
      tokens: row.blockedReasonTokens,
      residualAbs_Jm3: row.boundReplayResidualAbs_Jm3,
      marginRatioRaw: row.marginRatioRaw,
      applicabilityStatus: row.applicabilityStatus,
    }));

  const blockedReason: ParityBlockedReason | null =
    missingArtifacts.length > 0
      ? 'missing_required_artifacts'
      : !artifactCommitsMatchHead
        ? 'parity_provenance_mismatch'
        : rows.some((row) => row.missingFields.length > 0)
          ? 'parity_fields_missing'
          : rows.some((row) => !row.parityPass)
            ? 'literature_parity_not_pass'
            : null;

  const payload = {
    date: DATE,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    blockedReason,
    parityEvidenceStatus: blockedReason == null ? 'pass' : 'blocked',
    missingArtifacts,
    replayScaleReference,
    waveParityPassCount: rows.filter((row) => row.parityPass).length,
    allWaveParityPass: rows.length > 0 && rows.every((row) => row.parityPass),
    candidateComparablePassAllWaves: rows.length > 0 && rows.every((row) => row.gateComparable),
    topMismatches,
    waves: rows,
    literatureAnchors: [
      'ford_roman_qi',
      'fewster_eveson_sampling_dependence',
      'pfenning_ford_curvature_applicability',
      'wald_point_splitting_renormalization',
    ],
    provenance: {
      commitHash,
      headCommitHash,
      commitHashMatchesHead: headCommitHash != null && commitHash === headCommitHash,
      artifactCommits,
      artifactCommitsMatchHead,
    },
  };

  writeJson(outJsonPath, payload);

  const waveRows = rows
    .map(
      (row) =>
        `| ${row.wave} | ${row.parityPass} | ${row.mappingPass} | ${row.kernelPass} | ${row.curvaturePass} | ${row.uncertaintyPass} | ${row.gateComparable} | ${row.boundReplayResidualAbs_Jm3 ?? 'n/a'} | ${row.blockedReasonTokens.join(', ') || 'none'} |`,
    )
    .join('\n');

  const md = `# G4 Literature Parity Replay (${DATE})

${BOUNDARY_STATEMENT}

## Summary
- parity evidence status: ${payload.parityEvidenceStatus}
- blocked reason: ${payload.blockedReason ?? 'none'}
- missing artifacts: ${payload.missingArtifacts.join(', ') || 'none'}
- replay scale reference: ${payload.replayScaleReference ?? 'n/a'}
- wave parity pass count: ${payload.waveParityPassCount}/${rows.length}
- all wave parity pass: ${payload.allWaveParityPass}
- candidate comparable pass all waves: ${payload.candidateComparablePassAllWaves}
- provenance commit: ${commitHash}
- provenance freshness vs HEAD: ${payload.provenance.commitHashMatchesHead ? 'fresh' : 'stale_or_missing'}
- artifact commits match HEAD: ${payload.provenance.artifactCommitsMatchHead}

## Per-wave parity replay
| wave | parityPass | mappingPass | kernelPass | curvaturePass | uncertaintyPass | gateComparable | boundReplayResidualAbs_Jm3 | blockedReasonTokens |
|---|---|---|---|---|---|---|---:|---|
${waveRows || '| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |'}
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
  const result = generateG4LiteratureParityReplay();
  console.log(JSON.stringify({ ok: result.ok, blockedReason: result.blockedReason, json: result.outJsonPath, markdown: result.outMdPath }));
}

