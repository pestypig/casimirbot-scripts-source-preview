import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

type GenerateWarpEvidenceSnapshotOptions = {
  rootDir?: string;
  outPath?: string;
  requiredPaths?: string[];
  getCommitHash?: () => string;
};

type SnapshotSpecStatus = 'pass' | 'blocked';

const DATE = '2026-03-02';
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';
const DEFAULT_OUT_PATH = path.join('artifacts', 'research', 'full-solve', `warp-evidence-snapshot-${DATE}.json`);
const WAVES = ['A', 'B', 'C', 'D'] as const;
const DEFAULT_REQUIRED_PATHS = [
  'WARP_AGENTS.md',
  'docs/audits/research/warp-full-solve-campaign-execution-report-2026-02-24.md',
  'artifacts/research/full-solve/g4-calculator-2026-03-01.json',
  'artifacts/research/full-solve/g4-candidate-promotion-check-2026-03-01.json',
  'artifacts/research/full-solve/g4-promotion-bundle-2026-03-01.json',
  'artifacts/research/full-solve/g4-operator-mapping-audit-2026-03-02.json',
  'artifacts/research/full-solve/g4-kernel-provenance-audit-2026-03-02.json',
  'artifacts/research/full-solve/g4-curvature-applicability-audit-2026-03-02.json',
  'artifacts/research/full-solve/g4-uncertainty-audit-2026-03-02.json',
  'artifacts/research/full-solve/g4-literature-parity-replay-2026-03-02.json',
  'reports/math-report.json',
  'artifacts/training-trace.jsonl',
  'artifacts/training-trace-export.jsonl',
];

const readJsonOrNull = (filePath: string): Record<string, unknown> | null => {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const jsonlLastObject = (filePath: string): Record<string, unknown> | null => {
  if (!fs.existsSync(filePath)) return null;
  try {
    const rows = fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (let idx = rows.length - 1; idx >= 0; idx -= 1) {
      try {
        return JSON.parse(rows[idx]) as Record<string, unknown>;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
};

const fileInfo = (rootDir: string, relativePath: string) => {
  const abs = path.join(rootDir, relativePath);
  try {
    const stat = fs.statSync(abs);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    return {
      path: relativePath.replace(/\\/g, '/'),
      readable: true,
      sizeBytes: stat.size,
      mtimeUtc: stat.mtime.toISOString(),
      sha256,
      error: null as string | null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      path: relativePath.replace(/\\/g, '/'),
      readable: false,
      sizeBytes: null as number | null,
      mtimeUtc: null as string | null,
      sha256: null as string | null,
      error: message,
    };
  }
};

const statusFromEvidence = (pass: boolean, blockedReason: string | null): { status: SnapshotSpecStatus; blockedReason: string | null } => ({
  status: pass ? 'pass' : 'blocked',
  blockedReason: pass ? null : blockedReason ?? 'evidence_missing',
});

export const generateWarpEvidenceSnapshot = (options: GenerateWarpEvidenceSnapshotOptions = {}) => {
  const rootDir = options.rootDir ?? '.';
  const outPath = options.outPath ?? path.join(rootDir, DEFAULT_OUT_PATH);
  const requiredPaths = options.requiredPaths ?? DEFAULT_REQUIRED_PATHS;
  const getCommitHash =
    options.getCommitHash ??
    (() => execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());

  const commitHash = getCommitHash();
  const requiredFiles = requiredPaths.map((relativePath) => fileInfo(rootDir, relativePath));
  const unreadablePaths = requiredFiles.filter((entry) => !entry.readable).map((entry) => entry.path);
  const blocked = unreadablePaths.length > 0;
  const stopReason = blocked
    ? `fail_closed_required_files_unreadable:${unreadablePaths.join(',')}`
    : null;

  const scoreboard = readJsonOrNull(path.join(rootDir, 'artifacts', 'research', 'full-solve', 'campaign-gate-scoreboard-2026-02-24.json'));
  const firstFail = readJsonOrNull(path.join(rootDir, 'artifacts', 'research', 'full-solve', 'campaign-first-fail-map-2026-02-24.json'));
  const calculator = readJsonOrNull(path.join(rootDir, 'artifacts', 'research', 'full-solve', 'g4-calculator-2026-03-01.json'));
  const promotionCheck = readJsonOrNull(
    path.join(rootDir, 'artifacts', 'research', 'full-solve', 'g4-candidate-promotion-check-2026-03-01.json'),
  );
  const promotionBundle = readJsonOrNull(path.join(rootDir, 'artifacts', 'research', 'full-solve', 'g4-promotion-bundle-2026-03-01.json'));
  const operatorAudit = readJsonOrNull(path.join(rootDir, 'artifacts', 'research', 'full-solve', 'g4-operator-mapping-audit-2026-03-02.json'));
  const kernelAudit = readJsonOrNull(path.join(rootDir, 'artifacts', 'research', 'full-solve', 'g4-kernel-provenance-audit-2026-03-02.json'));
  const curvatureAudit = readJsonOrNull(
    path.join(rootDir, 'artifacts', 'research', 'full-solve', 'g4-curvature-applicability-audit-2026-03-02.json'),
  );
  const uncertaintyAudit = readJsonOrNull(path.join(rootDir, 'artifacts', 'research', 'full-solve', 'g4-uncertainty-audit-2026-03-02.json'));
  const literatureParityReplay = readJsonOrNull(
    path.join(rootDir, 'artifacts', 'research', 'full-solve', 'g4-literature-parity-replay-2026-03-02.json'),
  );
  const latestTrace = jsonlLastObject(path.join(rootDir, 'artifacts', 'training-trace.jsonl'));
  const latestExportTrace = jsonlLastObject(path.join(rootDir, 'artifacts', 'training-trace-export.jsonl'));
  const calculatorResult = (calculator?.result as Record<string, unknown> | undefined) ?? calculator;

  const normalizeTrace = (trace: Record<string, unknown> | null) => {
    if (!trace) return null;
    const certificate = (trace.certificate as Record<string, unknown> | undefined) ?? {};
    const runIdRaw = trace.runId ?? trace.id ?? trace.seq;
    return {
      traceId: stringOrNull(trace.traceId),
      runId:
        stringOrNull(runIdRaw) ??
        (typeof runIdRaw === 'number' && Number.isFinite(runIdRaw) ? String(runIdRaw) : null),
      pass: trace.pass === true,
      firstFail: trace.firstFail ?? null,
      certificateHash: stringOrNull(trace.certificateHash) ?? stringOrNull(certificate.certificateHash),
      integrityOk: trace.integrityOk === true || certificate.integrityOk === true,
      status: stringOrNull(trace.status) ?? stringOrNull(certificate.status),
    };
  };

  const reproducibilityByWave = Object.fromEntries(
    WAVES.map((wave) => {
      const pack = readJsonOrNull(path.join(rootDir, 'artifacts', 'research', 'full-solve', wave, 'evidence-pack.json'));
      const status = stringOrNull((pack?.reproducibility as any)?.repeatedRunGateAgreement?.status);
      return [wave, status];
    }),
  ) as Record<(typeof WAVES)[number], string | null>;
  const reproducibilityMissingWaves = WAVES.filter((wave) => reproducibilityByWave[wave] == null);
  const reproducibilityNonPassWaves = WAVES.filter(
    (wave) => String(reproducibilityByWave[wave] ?? 'NOT_READY').toUpperCase() !== 'PASS',
  );

  const specA = statusFromEvidence(
    stringOrNull(operatorAudit?.operatorEvidenceStatus) === 'pass',
    stringOrNull(operatorAudit?.blockedReason) ?? 'operator_mapping_audit_blocked',
  );
  const specB = statusFromEvidence(
    stringOrNull(kernelAudit?.kernelEvidenceStatus) === 'pass',
    stringOrNull(kernelAudit?.blockedReason) ?? 'kernel_provenance_audit_blocked',
  );
  const specC = statusFromEvidence(
    stringOrNull(curvatureAudit?.curvatureEvidenceStatus) === 'pass',
    stringOrNull(curvatureAudit?.blockedReason) ?? 'curvature_applicability_audit_blocked',
  );
  const specD = statusFromEvidence(
    stringOrNull(uncertaintyAudit?.uncertaintyEvidenceStatus) === 'pass',
    stringOrNull(uncertaintyAudit?.blockedReason) ?? 'uncertainty_audit_blocked',
  );
  const specE = statusFromEvidence(
    stringOrNull(literatureParityReplay?.parityEvidenceStatus) === 'pass',
    stringOrNull(literatureParityReplay?.blockedReason) ?? 'literature_parity_replay_blocked',
  );
  const specF = statusFromEvidence(
    reproducibilityMissingWaves.length === 0 && reproducibilityNonPassWaves.length === 0,
    reproducibilityMissingWaves.length > 0
      ? `reproducibility_missing_waves:${reproducibilityMissingWaves.join(',')}`
      : reproducibilityNonPassWaves.length > 0
        ? `reproducibility_non_pass_waves:${reproducibilityNonPassWaves.join(',')}`
        : null,
  );
  const candidatePromotionReady = (promotionCheck?.aggregate as any)?.candidatePromotionReady === true;
  const candidatePromotionStable = (promotionCheck?.aggregate as any)?.candidatePromotionStable === true;
  const promotionBundleExecuted = promotionBundle?.promotionLaneExecuted === true;
  const promotionBundleBlockedReason = stringOrNull(promotionBundle?.blockedReason);
  const specG = statusFromEvidence(
    candidatePromotionReady && candidatePromotionStable && promotionBundleExecuted && promotionBundleBlockedReason == null,
    !candidatePromotionReady || !candidatePromotionStable
      ? 'promotion_readiness_or_stability_false'
      : !promotionBundleExecuted || promotionBundleBlockedReason != null
        ? `promotion_bundle_blocked:${promotionBundleBlockedReason ?? 'promotion_lane_not_executed'}`
        : null,
  );

  const specStatus = {
    A_operatorMapping: specA,
    B_samplingKernelProvenance: specB,
    C_curvatureApplicability: specC,
    D_uncertaintyDecisionBand: specD,
    E_literatureParityReplay: specE,
    F_reproducibilityAgreement: specF,
    G_promotionReadinessAndStability: specG,
  };
  const blockedSpecs = Object.entries(specStatus)
    .filter(([, value]) => value.status !== 'pass')
    .map(([key, value]) => ({ spec: key, blockedReason: value.blockedReason }));

  const payload = {
    snapshotId: `warp-evidence-snapshot-${DATE}`,
    generatedAtUtc: new Date().toISOString(),
    commitHash,
    boundaryStatement: BOUNDARY_STATEMENT,
    blocked,
    stopReason,
    requiredFiles,
    canonicalAuthoritative: {
      decisionLabel: stringOrNull(scoreboard?.decision),
      counts: (scoreboard?.counts ?? scoreboard?.statusCounts ?? null) as Record<string, unknown> | null,
      firstFail: stringOrNull(firstFail?.globalFirstFail),
      canonicalDecisionRemainsAuthoritative: true,
    },
    promotedCandidate: {
      calculator: {
        decisionClass: stringOrNull(calculatorResult?.decisionClass),
        congruentSolvePass: calculatorResult?.congruentSolvePass === true,
        marginRatioRawComputed:
          typeof calculatorResult?.marginRatioRawComputed === 'number' ? calculatorResult.marginRatioRawComputed : null,
        applicabilityStatus: stringOrNull(calculatorResult?.applicabilityStatus),
      },
      promotionCheck: {
        aggregateDecision: stringOrNull((promotionCheck?.aggregate as any)?.decision),
        aggregateFirstFail: stringOrNull((promotionCheck?.aggregate as any)?.firstFail?.firstFail),
        candidatePromotionReady,
        candidatePromotionStable,
      },
      promotionBundle: {
        blockedReason: promotionBundleBlockedReason,
        promotionLaneExecuted: promotionBundleExecuted,
      },
    },
    certification: {
      latestTrace: normalizeTrace(latestTrace),
      latestExportTrace: normalizeTrace(latestExportTrace),
    },
    strongClaimClosure: {
      specStatus,
      blockedSpecs,
      passAll: blockedSpecs.length === 0,
      reproducibilityByWave,
    },
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

  return {
    ok: !blocked,
    blocked,
    stopReason,
    outPath,
    blockedSpecs,
    passAllSpecs: blockedSpecs.length === 0,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = generateWarpEvidenceSnapshot();
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
