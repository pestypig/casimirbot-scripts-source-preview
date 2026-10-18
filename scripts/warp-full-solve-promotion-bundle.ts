import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runCommandWithRetry } from './warp-full-solve-canonical-bundle.js';
import { PROMOTED_WARP_PROFILE_VERSION, WARP_SOLUTION_CATEGORY } from '../shared/warp-promoted-profile.js';

type Wave = 'A' | 'B' | 'C' | 'D';

type PromotionBundleOptions = {
  rootDir?: string;
  promotionCheckPath?: string;
  promotionLaneOutDir?: string;
  outPath?: string;
  requestedCandidateId?: string | null;
  getCommitHash?: () => string;
  runCommand?: (args: readonly string[]) => void;
};

type WaveG4Row = {
  wave: Wave;
  lhs_Jm3: number | null;
  boundComputed_Jm3: number | null;
  boundUsed_Jm3: number | null;
  marginRatioRawComputed: number | null;
  applicabilityStatus: string | null;
  rhoSource: string | null;
};

type PromotionBundleResult = {
  ok: boolean;
  blockedReason: string | null;
  outPath: string;
  promotionCheckPath: string;
  promotionLaneOutDir: string;
  candidateId: string | null;
  candidatePromotionReady: boolean;
  candidatePromotionStable: boolean;
  promotionLaneExecuted: boolean;
  promotionLaneDecision: string | null;
  promotionLaneFirstFail: string | null;
  promotionLaneCounts: Record<string, number> | null;
  promotionLaneG4ComparablePassAllWaves: boolean | null;
  solutionCategory: string;
  promotedProfileVersion: string;
  boundaryStatement: string;
  commitHash: string;
};

const DATE = '2026-03-01';
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';
const DEFAULT_PROMOTION_CHECK_PATH = path.join('artifacts', 'research', 'full-solve', `g4-candidate-promotion-check-${DATE}.json`);
const DEFAULT_PROMOTION_LANE_OUT = path.join('artifacts', 'research', 'full-solve', 'promotion-lane');
const DEFAULT_OUT_PATH = path.join('artifacts', 'research', 'full-solve', `g4-promotion-bundle-${DATE}.json`);
const STRONG_CLAIM_AUDIT_PATHS = {
  operator: path.join('artifacts', 'research', 'full-solve', 'g4-operator-mapping-audit-2026-03-02.json'),
  kernel: path.join('artifacts', 'research', 'full-solve', 'g4-kernel-provenance-audit-2026-03-02.json'),
  curvature: path.join('artifacts', 'research', 'full-solve', 'g4-curvature-applicability-audit-2026-03-02.json'),
  uncertainty: path.join('artifacts', 'research', 'full-solve', 'g4-uncertainty-audit-2026-03-02.json'),
} as const;
const STRONG_CLAIM_AUDITS: ReadonlyArray<{
  label: string;
  path: string;
  statusField: string;
}> = [
  { label: 'operator', path: STRONG_CLAIM_AUDIT_PATHS.operator, statusField: 'operatorEvidenceStatus' },
  { label: 'kernel', path: STRONG_CLAIM_AUDIT_PATHS.kernel, statusField: 'kernelEvidenceStatus' },
  { label: 'curvature', path: STRONG_CLAIM_AUDIT_PATHS.curvature, statusField: 'curvatureEvidenceStatus' },
  { label: 'uncertainty', path: STRONG_CLAIM_AUDIT_PATHS.uncertainty, statusField: 'uncertaintyEvidenceStatus' },
];
const SCOREBOARD_PATH = path.join(`campaign-gate-scoreboard-2026-02-24.json`);
const FIRST_FAIL_PATH = path.join(`campaign-first-fail-map-2026-02-24.json`);

const readJson = (filePath: string): any => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const finiteOrNull = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const stringOrNull = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
};

const ensureDir = (filePath: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const writeJson = (filePath: string, payload: unknown) => {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
};

const resolveRootPath = (rootDir: string, filePath: string): string => {
  return path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath);
};

const resolveCandidate = (payload: any, requestedCandidateId: string | null): { id: string | null; blockedReason: string | null } => {
  const candidateId = stringOrNull(payload?.candidate?.id);
  if (!requestedCandidateId) {
    return { id: candidateId, blockedReason: candidateId ? null : 'promotion_check_missing_candidate_id' };
  }
  if (!candidateId) {
    return { id: null, blockedReason: `requested_candidate_not_resolved:${requestedCandidateId}` };
  }
  if (candidateId !== requestedCandidateId) {
    return {
      id: null,
      blockedReason: `requested_candidate_mismatch:requested=${requestedCandidateId};actual=${candidateId}`,
    };
  }
  return { id: candidateId, blockedReason: null };
};

const readWaveRows = (outDir: string): WaveG4Row[] => {
  return (['A', 'B', 'C', 'D'] as Wave[]).map((wave) => {
    const qiPath = path.join(outDir, wave, 'qi-forensics.json');
    if (!fs.existsSync(qiPath)) {
      return {
        wave,
        lhs_Jm3: null,
        boundComputed_Jm3: null,
        boundUsed_Jm3: null,
        marginRatioRawComputed: null,
        applicabilityStatus: null,
        rhoSource: null,
      };
    }
    const qi = readJson(qiPath);
    return {
      wave,
      lhs_Jm3: finiteOrNull(qi?.lhs_Jm3),
      boundComputed_Jm3: finiteOrNull(qi?.boundComputed_Jm3),
      boundUsed_Jm3: finiteOrNull(qi?.boundUsed_Jm3 ?? qi?.bound_Jm3),
      marginRatioRawComputed: finiteOrNull(qi?.marginRatioRawComputed),
      applicabilityStatus: stringOrNull(qi?.applicabilityStatus),
      rhoSource: stringOrNull(qi?.rhoSource),
    };
  });
};

const isComparablePassRow = (row: WaveG4Row): boolean => {
  return (
    String(row.applicabilityStatus ?? '').toUpperCase() === 'PASS' &&
    row.marginRatioRawComputed != null &&
    row.marginRatioRawComputed < 1
  );
};

const extractPromotionCounts = (scoreboard: any): Record<string, number> | null => {
  const candidate = scoreboard?.counts ?? scoreboard?.statusCounts;
  if (!candidate || typeof candidate !== 'object') return null;
  const output: Record<string, number> = {};
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) output[key] = numeric;
  }
  return Object.keys(output).length > 0 ? output : null;
};

const extractPromotionFirstFail = (firstFailPayload: any): string | null => {
  return stringOrNull(firstFailPayload?.global?.firstFail ?? firstFailPayload?.globalFirstFail);
};

const buildBlockedPayload = (
  blockedReason: string,
  outPath: string,
  promotionCheckPath: string,
  promotionLaneOutDir: string,
  commitHash: string,
): PromotionBundleResult => {
  const payload: PromotionBundleResult = {
    ok: true,
    blockedReason,
    outPath: outPath.replace(/\\/g, '/'),
    promotionCheckPath: promotionCheckPath.replace(/\\/g, '/'),
    promotionLaneOutDir: promotionLaneOutDir.replace(/\\/g, '/'),
    candidateId: null,
    candidatePromotionReady: false,
    candidatePromotionStable: false,
    promotionLaneExecuted: false,
    promotionLaneDecision: null,
    promotionLaneFirstFail: null,
    promotionLaneCounts: null,
    promotionLaneG4ComparablePassAllWaves: null,
    solutionCategory: WARP_SOLUTION_CATEGORY,
    promotedProfileVersion: PROMOTED_WARP_PROFILE_VERSION,
    boundaryStatement: BOUNDARY_STATEMENT,
    commitHash,
  };
  return payload;
};

const validateStrongClaimEvidence = (rootDir: string, commitHash: string): string | null => {
  for (const audit of STRONG_CLAIM_AUDITS) {
    const auditPath = resolveRootPath(rootDir, audit.path);
    if (!fs.existsSync(auditPath)) {
      return `strong_claim_evidence_missing:${audit.path.replace(/\\/g, '/')}`;
    }
    const payload = readJson(auditPath);
    const status = stringOrNull(payload?.[audit.statusField]);
    if (status !== 'pass') {
      const blockedReason = stringOrNull(payload?.blockedReason) ?? 'none';
      return `strong_claim_evidence_blocked:${audit.label}:${blockedReason}`;
    }
    const auditCommitHash = stringOrNull(payload?.provenance?.commitHash);
    if (auditCommitHash !== commitHash) {
      return `strong_claim_evidence_commit_stale:${audit.label}=${auditCommitHash ?? 'null'};head=${commitHash}`;
    }
  }
  return null;
};

export const runPromotionBundle = (options: PromotionBundleOptions = {}): PromotionBundleResult => {
  const rootDir = options.rootDir ?? '.';
  const promotionCheckPath = resolveRootPath(rootDir, options.promotionCheckPath ?? DEFAULT_PROMOTION_CHECK_PATH);
  const promotionLaneOutDir = resolveRootPath(rootDir, options.promotionLaneOutDir ?? DEFAULT_PROMOTION_LANE_OUT);
  const outPath = resolveRootPath(rootDir, options.outPath ?? DEFAULT_OUT_PATH);
  const requestedCandidateId = options.requestedCandidateId ?? null;
  const getCommitHash =
    options.getCommitHash ?? (() => execSync('git rev-parse HEAD', { encoding: 'utf8', cwd: rootDir }).trim());
  const runCommand = options.runCommand ?? runCommandWithRetry;
  const commitHash = getCommitHash();

  runCommand(['run', 'warp:full-solve:g4-candidate-promotion-check', '--', '--lane', 'fixed_candidate']);

  if (!fs.existsSync(promotionCheckPath)) {
    const blockedPayload = buildBlockedPayload(
      'promotion_check_missing_after_generation',
      outPath,
      promotionCheckPath,
      promotionLaneOutDir,
      commitHash,
    );
    writeJson(outPath, blockedPayload);
    return blockedPayload;
  }

  const promotionCheck = readJson(promotionCheckPath);
  const promotionBlockedReason = stringOrNull(promotionCheck?.blockedReason);
  if (promotionBlockedReason) {
    const blockedPayload = buildBlockedPayload(
      `promotion_check_blocked:${promotionBlockedReason}`,
      outPath,
      promotionCheckPath,
      promotionLaneOutDir,
      commitHash,
    );
    writeJson(outPath, blockedPayload);
    return blockedPayload;
  }
  const promotionCheckCommitHash = stringOrNull(promotionCheck?.provenance?.commitHash);
  if (promotionCheckCommitHash !== commitHash) {
    const blockedPayload = buildBlockedPayload(
      `promotion_check_commit_stale:promotion_check=${promotionCheckCommitHash ?? 'null'};head=${commitHash}`,
      outPath,
      promotionCheckPath,
      promotionLaneOutDir,
      commitHash,
    );
    writeJson(outPath, blockedPayload);
    return blockedPayload;
  }

  const candidatePromotionReady = Boolean(promotionCheck?.aggregate?.candidatePromotionReady === true);
  const candidatePromotionStable = Boolean(promotionCheck?.aggregate?.candidatePromotionStable === true);
  if (!candidatePromotionReady || !candidatePromotionStable) {
    const blockedPayload = buildBlockedPayload(
      `promotion_check_not_ready:ready=${candidatePromotionReady};stable=${candidatePromotionStable}`,
      outPath,
      promotionCheckPath,
      promotionLaneOutDir,
      commitHash,
    );
    writeJson(outPath, blockedPayload);
    return blockedPayload;
  }

  const candidateResolution = resolveCandidate(promotionCheck, requestedCandidateId);
  if (candidateResolution.blockedReason || !candidateResolution.id) {
    const blockedPayload = buildBlockedPayload(
      candidateResolution.blockedReason ?? 'promotion_candidate_resolution_failed',
      outPath,
      promotionCheckPath,
      promotionLaneOutDir,
      commitHash,
    );
    writeJson(outPath, blockedPayload);
    return blockedPayload;
  }

  const strongClaimEvidenceBlockedReason = validateStrongClaimEvidence(rootDir, commitHash);
  if (strongClaimEvidenceBlockedReason) {
    const blockedPayload = buildBlockedPayload(
      `promotion_strong_claim_blocked:${strongClaimEvidenceBlockedReason}`,
      outPath,
      promotionCheckPath,
      promotionLaneOutDir,
      commitHash,
    );
    blockedPayload.candidateId = candidateResolution.id;
    blockedPayload.candidatePromotionReady = true;
    blockedPayload.candidatePromotionStable = true;
    writeJson(outPath, blockedPayload);
    return blockedPayload;
  }

  runCommand([
    'run',
    'warp:full-solve:campaign',
    '--',
    '--wave',
    'all',
    '--out',
    promotionLaneOutDir,
    '--ci',
    '--ci-fast-path',
    '--wave-timeout-ms',
    '120000',
    '--campaign-timeout-ms',
    '600000',
    '--promote-candidate-id',
    candidateResolution.id,
    '--promotion-check-path',
    promotionCheckPath,
  ]);

  const scoreboardPath = path.join(promotionLaneOutDir, SCOREBOARD_PATH);
  const firstFailPath = path.join(promotionLaneOutDir, FIRST_FAIL_PATH);
  if (!fs.existsSync(scoreboardPath) || !fs.existsSync(firstFailPath)) {
    const blockedPayload = buildBlockedPayload(
      'promotion_lane_missing_scoreboard_or_first_fail',
      outPath,
      promotionCheckPath,
      promotionLaneOutDir,
      commitHash,
    );
    blockedPayload.candidateId = candidateResolution.id;
    blockedPayload.candidatePromotionReady = true;
    blockedPayload.candidatePromotionStable = true;
    writeJson(outPath, blockedPayload);
    return blockedPayload;
  }

  const scoreboard = readJson(scoreboardPath);
  const firstFail = readJson(firstFailPath);
  const waveRows = readWaveRows(promotionLaneOutDir);
  const promotionLaneG4ComparablePassAllWaves =
    waveRows.length === 4 && waveRows.every((row) => isComparablePassRow(row));

  const payload: PromotionBundleResult & {
    promotionLaneWaveRows: WaveG4Row[];
    governance: { canonicalDecisionRemainsAuthoritative: true; note: string };
    provenance: {
      promotionCheckCommitHash: string | null;
      promotionCheckCommitFresh: boolean;
    };
  } = {
    ok: true,
    blockedReason: null,
    outPath: outPath.replace(/\\/g, '/'),
    promotionCheckPath: promotionCheckPath.replace(/\\/g, '/'),
    promotionLaneOutDir: promotionLaneOutDir.replace(/\\/g, '/'),
    candidateId: candidateResolution.id,
    candidatePromotionReady: true,
    candidatePromotionStable: true,
    promotionLaneExecuted: true,
    promotionLaneDecision: stringOrNull(scoreboard?.decision),
    promotionLaneFirstFail: extractPromotionFirstFail(firstFail),
    promotionLaneCounts: extractPromotionCounts(scoreboard),
    promotionLaneG4ComparablePassAllWaves,
    solutionCategory: WARP_SOLUTION_CATEGORY,
    promotedProfileVersion: PROMOTED_WARP_PROFILE_VERSION,
    boundaryStatement: BOUNDARY_STATEMENT,
    commitHash,
    promotionLaneWaveRows: waveRows,
    governance: {
      canonicalDecisionRemainsAuthoritative: true,
      note: 'Promotion lane is exploratory evidence. Canonical lane remains authoritative for campaign decision labels.',
    },
    provenance: {
      promotionCheckCommitHash: stringOrNull(promotionCheck?.provenance?.commitHash),
      promotionCheckCommitFresh: stringOrNull(promotionCheck?.provenance?.commitHash) === commitHash,
    },
  };

  writeJson(outPath, payload);
  return payload;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const candidateArg = process.argv.find((arg) => arg.startsWith('--candidate-id='));
  const requestedCandidateId = candidateArg ? candidateArg.split('=', 2)[1] : null;
  console.log(
    JSON.stringify(
      runPromotionBundle({
        requestedCandidateId,
      }),
      null,
      2,
    ),
  );
}
