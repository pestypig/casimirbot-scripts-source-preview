import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

type Wave = 'A' | 'B' | 'C' | 'D';

type GenerateG4KernelProvenanceAuditOptions = {
  rootDir?: string;
  artifactRoot?: string;
  outJsonPath?: string;
  outMdPath?: string;
  waves?: Wave[];
  getCommitHash?: () => string;
};

type KernelAuditRow = {
  wave: Wave;
  samplingKernelIdentity: string | null;
  samplingKernelNormalization: string | null;
  tau_s: number | null;
  K: number | null;
  KUnits: string | null;
  KDerivation: string | null;
  KProvenanceCommit: string | null;
  boundComputed_Jm3: number | null;
  replayKernelScale: number | null;
  normalizationPass: boolean;
  unitsPass: boolean;
  derivationPass: boolean;
  provenanceCommitValid: boolean;
  replayPass: boolean;
  missingFields: string[];
  blockedReasonTokens: string[];
};

type KernelAuditBlockedReason =
  | 'missing_qi_forensics_wave_artifacts'
  | 'sampling_kernel_evidence_missing'
  | 'sampling_kernel_normalization_mismatch'
  | 'k_units_mismatch'
  | 'k_derivation_mismatch'
  | 'k_provenance_missing_or_invalid'
  | 'replay_consistency_failed';

const DATE = '2026-03-02';
const DEFAULT_ARTIFACT_ROOT = path.join('artifacts', 'research', 'full-solve');
const DEFAULT_OUT_JSON = path.join(DEFAULT_ARTIFACT_ROOT, `g4-kernel-provenance-audit-${DATE}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-g4-kernel-provenance-audit-${DATE}.md`);
const WAVES: Wave[] = ['A', 'B', 'C', 'D'];
const EXPECTED_KERNEL_NORMALIZATION = 'unit_integral';
const EXPECTED_K_UNITS = 'J*s^4/m^3';
const EXPECTED_K_DERIVATION = 'ford_roman_bound_constant_from_qi_guard';
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

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

const classifyRow = (wave: Wave, qi: Record<string, unknown>): KernelAuditRow => {
  const samplingKernelIdentity = stringOrNull(qi.samplingKernelIdentity);
  const samplingKernelNormalization = stringOrNull(qi.samplingKernelNormalization);
  const tau_s = finiteOrNull(qi.tau_s);
  const K = finiteOrNull(qi.K);
  const KUnits = stringOrNull(qi.KUnits);
  const KDerivation = stringOrNull(qi.KDerivation);
  const KProvenanceCommit = stringOrNull(qi.KProvenanceCommit);
  const boundComputed_Jm3 = finiteOrNull(qi.boundComputed_Jm3);

  const missingFields: string[] = [];
  if (samplingKernelIdentity == null) missingFields.push('samplingKernelIdentity');
  if (samplingKernelNormalization == null) missingFields.push('samplingKernelNormalization');
  if (tau_s == null) missingFields.push('tau_s');
  if (K == null) missingFields.push('K');
  if (KUnits == null) missingFields.push('KUnits');
  if (KDerivation == null) missingFields.push('KDerivation');
  if (KProvenanceCommit == null) missingFields.push('KProvenanceCommit');
  if (boundComputed_Jm3 == null) missingFields.push('boundComputed_Jm3');

  const normalizationPass = samplingKernelNormalization === EXPECTED_KERNEL_NORMALIZATION;
  const unitsPass = KUnits === EXPECTED_K_UNITS;
  const derivationPass = KDerivation === EXPECTED_K_DERIVATION;
  const provenanceCommitValid = KProvenanceCommit != null && COMMIT_HASH_RE.test(KProvenanceCommit);

  const replayKernelScale =
    K != null && tau_s != null && tau_s > 0 && boundComputed_Jm3 != null && K !== 0
      ? Math.abs(boundComputed_Jm3) * Math.pow(tau_s, 4) / Math.abs(K)
      : null;
  const replayPass = replayKernelScale != null && Number.isFinite(replayKernelScale) && replayKernelScale > 0;

  const blockedReasonTokens: string[] = [];
  if (missingFields.length > 0) blockedReasonTokens.push('sampling_kernel_evidence_missing');
  if (!normalizationPass) blockedReasonTokens.push('sampling_kernel_normalization_mismatch');
  if (!unitsPass) blockedReasonTokens.push('k_units_mismatch');
  if (!derivationPass) blockedReasonTokens.push('k_derivation_mismatch');
  if (!provenanceCommitValid) blockedReasonTokens.push('k_provenance_missing_or_invalid');
  if (!replayPass) blockedReasonTokens.push('replay_consistency_failed');

  return {
    wave,
    samplingKernelIdentity,
    samplingKernelNormalization,
    tau_s,
    K,
    KUnits,
    KDerivation,
    KProvenanceCommit,
    boundComputed_Jm3,
    replayKernelScale,
    normalizationPass,
    unitsPass,
    derivationPass,
    provenanceCommitValid,
    replayPass,
    missingFields,
    blockedReasonTokens,
  };
};

export const generateG4KernelProvenanceAudit = (options: GenerateG4KernelProvenanceAuditOptions = {}) => {
  const rootDir = options.rootDir ?? '.';
  const artifactRoot = options.artifactRoot ?? path.join(rootDir, DEFAULT_ARTIFACT_ROOT);
  const outJsonPath = options.outJsonPath ?? path.join(rootDir, DEFAULT_OUT_JSON);
  const outMdPath = options.outMdPath ?? path.join(rootDir, DEFAULT_OUT_MD);
  const waves = options.waves ?? WAVES;
  const getCommitHash =
    options.getCommitHash ??
    (() => execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());

  const rows: KernelAuditRow[] = [];
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

  const blockedReason: KernelAuditBlockedReason | null =
    canonicalMissingWaves.length > 0
      ? 'missing_qi_forensics_wave_artifacts'
      : rows.some((row) => row.missingFields.length > 0)
        ? 'sampling_kernel_evidence_missing'
        : rows.some((row) => !row.normalizationPass)
          ? 'sampling_kernel_normalization_mismatch'
          : rows.some((row) => !row.unitsPass)
            ? 'k_units_mismatch'
            : rows.some((row) => !row.derivationPass)
              ? 'k_derivation_mismatch'
              : rows.some((row) => !row.provenanceCommitValid)
                ? 'k_provenance_missing_or_invalid'
                : rows.some((row) => !row.replayPass)
                  ? 'replay_consistency_failed'
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

  const commitHash = getCommitHash();
  const headCommitHash = resolveHeadCommitHash(rootDir);
  const payload = {
    date: DATE,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    blockedReason,
    canonicalMissingWaves,
    kernelEvidenceStatus: blockedReason == null ? 'pass' : 'blocked',
    canonicalComparableWaveCount: rows.filter((row) => row.blockedReasonTokens.length === 0).length,
    normalizationPassAll: rows.length > 0 && rows.every((row) => row.normalizationPass),
    unitsPassAll: rows.length > 0 && rows.every((row) => row.unitsPass),
    derivationPassAll: rows.length > 0 && rows.every((row) => row.derivationPass),
    provenanceCommitValidAll: rows.length > 0 && rows.every((row) => row.provenanceCommitValid),
    replayPassAll: rows.length > 0 && rows.every((row) => row.replayPass),
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
        `| ${row.wave} | ${row.samplingKernelIdentity ?? 'n/a'} | ${row.samplingKernelNormalization ?? 'n/a'} | ${row.tau_s ?? 'n/a'} | ${row.K ?? 'n/a'} | ${row.replayKernelScale ?? 'n/a'} | ${row.blockedReasonTokens.join(', ') || 'none'} |`,
    )
    .join('\n');

  const md = `# G4 Sampling/K Provenance Audit (${DATE})

${BOUNDARY_STATEMENT}

## Summary
- kernel evidence status: ${payload.kernelEvidenceStatus}
- blocked reason: ${payload.blockedReason ?? 'none'}
- canonical missing waves: ${payload.canonicalMissingWaves.join(', ') || 'none'}
- normalization pass all waves: ${payload.normalizationPassAll}
- units pass all waves: ${payload.unitsPassAll}
- derivation pass all waves: ${payload.derivationPassAll}
- provenance commit valid all waves: ${payload.provenanceCommitValidAll}
- replay pass all waves: ${payload.replayPassAll}
- provenance commit: ${commitHash}
- provenance freshness vs HEAD: ${payload.provenance.commitHashMatchesHead ? 'fresh' : 'stale_or_missing'}
- canonical-authoritative statement: canonical campaign decision remains authoritative; sampling/K provenance evidence is fail-closed.

## Per-wave sampling/K evidence
| wave | samplingKernelIdentity | samplingKernelNormalization | tau_s | K | replayKernelScale | blockedReasonTokens |
|---|---|---|---:|---:|---:|---|
${waveRows || '| n/a | n/a | n/a | n/a | n/a | n/a | n/a |'}
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
  const result = generateG4KernelProvenanceAudit();
  console.log(JSON.stringify({ ok: result.ok, blockedReason: result.blockedReason, json: result.outJsonPath, markdown: result.outMdPath }));
}
