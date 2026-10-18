import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const INITIAL_CANONICAL_COMMANDS = [
  ['run', 'warp:full-solve:canonical'],
  ['run', 'warp:full-solve:g4-sensitivity'],
] as const;

const FINALIZATION_COMMANDS = [
  ['run', 'warp:full-solve:g4-stepA-summary'],
  ['run', 'warp:full-solve:g4-recovery-search'],
  ['run', 'warp:full-solve:g4-recovery-parity'],
  ['run', 'warp:full-solve:g4-coupling-localization'],
  ['run', 'warp:full-solve:g4-coupling-ablation'],
  ['run', 'warp:full-solve:g4-semantic-bridge-matrix'],
  ['run', 'warp:full-solve:g4-operator-mapping-audit'],
  ['run', 'warp:full-solve:g4-kernel-provenance-audit'],
  ['run', 'warp:full-solve:g4-curvature-applicability-audit'],
  ['run', 'warp:full-solve:g4-uncertainty-audit'],
  ['run', 'warp:full-solve:g4-governance-matrix'],
  ['run', 'warp:full-solve:g4-decision-ledger'],
  ['run', 'warp:full-solve:g4-literature-parity-replay'],
  ['run', 'warp:full-solve:canonical'],
  ['run', 'warp:full-solve:promotion-bundle'],
  ['run', 'warp:full-solve:evidence-snapshot'],
] as const;

const LEDGER_PATH = path.join('artifacts', 'research', 'full-solve', 'g4-decision-ledger-2026-02-26.json');
const MATRIX_PATH = path.join('artifacts', 'research', 'full-solve', 'g4-governance-matrix-2026-02-27.json');
const STEP_A_PATH = path.join('artifacts', 'research', 'full-solve', 'g4-stepA-summary.json');
const RECOVERY_PATH = path.join('artifacts', 'research', 'full-solve', 'g4-recovery-search-2026-02-27.json');
const PARITY_PATH = path.join('artifacts', 'research', 'full-solve', 'g4-recovery-parity-2026-02-27.json');
const LOCALIZATION_PATH = path.join('artifacts', 'research', 'full-solve', 'g4-coupling-localization-2026-02-27.json');
const ABLATION_PATH = path.join('artifacts', 'research', 'full-solve', 'g4-coupling-ablation-2026-02-27.json');
const SEMANTIC_BRIDGE_MATRIX_PATH = path.join('artifacts', 'research', 'full-solve', 'g4-semantic-bridge-matrix-2026-02-27.json');
const OPERATOR_MAPPING_AUDIT_PATH = path.join('artifacts', 'research', 'full-solve', 'g4-operator-mapping-audit-2026-03-02.json');
const KERNEL_PROVENANCE_AUDIT_PATH = path.join('artifacts', 'research', 'full-solve', 'g4-kernel-provenance-audit-2026-03-02.json');
const CURVATURE_APPLICABILITY_AUDIT_PATH = path.join('artifacts', 'research', 'full-solve', 'g4-curvature-applicability-audit-2026-03-02.json');
const UNCERTAINTY_AUDIT_PATH = path.join('artifacts', 'research', 'full-solve', 'g4-uncertainty-audit-2026-03-02.json');
const LITERATURE_PARITY_REPLAY_PATH = path.join('artifacts', 'research', 'full-solve', 'g4-literature-parity-replay-2026-03-02.json');
const PROMOTION_BUNDLE_PATH = path.join('artifacts', 'research', 'full-solve', 'g4-promotion-bundle-2026-03-01.json');
const EVIDENCE_SNAPSHOT_PATH = path.join('artifacts', 'research', 'full-solve', 'warp-evidence-snapshot-2026-03-02.json');
const DEFAULT_COMMAND_TIMEOUT_MS = 8 * 60_000;
const DEFAULT_MAX_RETRIES = 1;

export type CanonicalBundleResult = {
  ok: boolean;
  boundaryStatement: string;
  headCommitHash: string;
  stepAPath: string;
  ledgerPath: string;
  matrixPath: string;
  recoveryPath: string;
  parityPath: string;
  localizationPath: string;
  ablationPath: string;
  semanticBridgeMatrixPath: string;
  operatorMappingAuditPath: string;
  kernelProvenanceAuditPath: string;
  curvatureApplicabilityAuditPath: string;
  uncertaintyAuditPath: string;
  literatureParityReplayPath: string;
  promotionBundlePath: string;
  evidenceSnapshotPath: string;
};

type RunCommandOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  runSpawnSync?: (command: string, args: string[], options: Record<string, unknown>) => SpawnSyncReturns<Buffer>;
};

const npmCli = process.env.npm_execpath;

const readJson = (filePath: string): any => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const readCommitHash = (payload: any): string | null => {
  const commitHash = payload?.commitHash ?? payload?.provenance?.commitHash;
  return typeof commitHash === 'string' && commitHash.trim().length > 0 ? commitHash.trim() : null;
};

export const assertEvidenceSnapshotStrongClaimClosure = (evidenceSnapshot: any) => {
  const strongClaimPassAll = evidenceSnapshot?.strongClaimClosure?.passAll === true;
  if (strongClaimPassAll) return;
  const blockedSpecs = Array.isArray(evidenceSnapshot?.strongClaimClosure?.blockedSpecs)
    ? evidenceSnapshot.strongClaimClosure.blockedSpecs
    : [];
  const blockedSummary = blockedSpecs
    .map((entry: any) => `${String(entry?.spec ?? 'unknown_spec')}:${String(entry?.blockedReason ?? 'unknown_reason')}`)
    .join(',');
  throw new Error(
    `Evidence snapshot strong-claim closure blocked fail-closed: ${blockedSummary || 'passAll=false;blockedSpecs_missing'}`,
  );
};

const hasTimedOut = (result: SpawnSyncReturns<Buffer>): boolean => {
  const message = String(result.error?.message ?? '').toLowerCase();
  return message.includes('timed out') || message.includes('etimedout');
};

export const runCommandWithRetry = (args: readonly string[], options: RunCommandOptions = {}) => {
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs ?? process.env.WARP_CANONICAL_BUNDLE_TIMEOUT_MS ?? DEFAULT_COMMAND_TIMEOUT_MS));
  const maxRetries = Math.max(0, Number(options.maxRetries ?? process.env.WARP_CANONICAL_BUNDLE_MAX_RETRIES ?? DEFAULT_MAX_RETRIES));
  const runSpawnSync = options.runSpawnSync ?? ((command, commandArgs, spawnOptions) => spawnSync(command, commandArgs, spawnOptions as any));
  const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const commandArgs = npmCli ? [npmCli, ...args] : [...args];
  const commandLabel = `npm ${args.join(' ')}`;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const result = runSpawnSync(command, commandArgs, {
      stdio: 'inherit',
      shell: false,
      timeout: timeoutMs,
    });
    if (result.status === 0) {
      return;
    }

    const timedOut = hasTimedOut(result);
    const spawnError = result.error ? `;error=${result.error.message}` : '';
    const reason = timedOut
      ? `timeout after ${timeoutMs}ms`
      : `exit=${result.status ?? 'null'}${result.signal ? `;signal=${result.signal}` : ''}${spawnError}`;

    if (timedOut) {
      throw new Error(`Command failed (${commandLabel}) with ${reason}; timeoutMs=${timeoutMs}`);
    }

    if (attempt < maxRetries) {
      console.warn(
        `[warp-full-solve-canonical-bundle] transient failure, retrying (${attempt + 1}/${maxRetries}) for ${commandLabel}: ${reason}`,
      );
      continue;
    }

    throw new Error(`Command failed (${commandLabel}) with ${reason}; timeoutMs=${timeoutMs}`);
  }
};

export const assertBundleProvenanceFresh = (
  headCommitHash: string,
  stepA: any,
  ledger: any,
  matrix: any,
  recovery: any,
  parity: any,
  localization: any,
  ablation: any,
  semanticBridgeMatrix: any,
  kernelProvenanceAudit: any,
) => {
  const stepACommitHash = readCommitHash(stepA);
  const ledgerCommitHash = readCommitHash(ledger);
  const matrixCommitHash = readCommitHash(matrix);
  const recoveryCommitHash = readCommitHash(recovery);
  const parityCommitHash = readCommitHash(parity);
  const localizationCommitHash = readCommitHash(localization);
  const ablationCommitHash = readCommitHash(ablation);
  const semanticBridgeMatrixCommitHash = readCommitHash(semanticBridgeMatrix);
  const kernelProvenanceAuditCommitHash = readCommitHash(kernelProvenanceAudit);

  if (stepACommitHash !== headCommitHash) {
    throw new Error(`Step A summary commit hash mismatch: stepA=${String(stepACommitHash ?? 'null')} head=${headCommitHash}`);
  }
  if (ledgerCommitHash !== headCommitHash) {
    throw new Error(`Ledger commit hash mismatch: ledger=${String(ledgerCommitHash ?? 'null')} head=${headCommitHash}`);
  }
  if (matrixCommitHash !== headCommitHash) {
    throw new Error(`Governance matrix commit hash mismatch: matrix=${String(matrixCommitHash ?? 'null')} head=${headCommitHash}`);
  }
  if (recoveryCommitHash !== headCommitHash) {
    throw new Error(
      `Recovery artifact provenance commit hash mismatch: recovery=${String(recoveryCommitHash ?? 'null')} head=${headCommitHash}`,
    );
  }
  if (parityCommitHash !== headCommitHash) {
    throw new Error(`Recovery parity provenance commit hash mismatch: parity=${String(parityCommitHash ?? 'null')} head=${headCommitHash}`);
  }
  if (localizationCommitHash !== headCommitHash) {
    throw new Error(
      `Coupling localization provenance commit hash mismatch: localization=${String(localizationCommitHash ?? 'null')} head=${headCommitHash}`,
    );
  }
  if (ablationCommitHash !== headCommitHash) {
    throw new Error(
      `Coupling ablation provenance commit hash mismatch: ablation=${String(ablationCommitHash ?? 'null')} head=${headCommitHash}`,
    );
  }
  if (semanticBridgeMatrixCommitHash !== headCommitHash) {
    throw new Error(
      `Semantic bridge matrix provenance commit hash mismatch: semanticBridgeMatrix=${String(semanticBridgeMatrixCommitHash ?? 'null')} head=${headCommitHash}`,
    );
  }
  if (kernelProvenanceAuditCommitHash !== headCommitHash) {
    throw new Error(
      `Kernel provenance audit provenance commit hash mismatch: kernelProvenanceAudit=${String(
        kernelProvenanceAuditCommitHash ?? 'null',
      )} head=${headCommitHash}`,
    );
  }
};

export const runCanonicalBundle = (): CanonicalBundleResult => {
  for (const args of INITIAL_CANONICAL_COMMANDS) runCommandWithRetry(args);
  for (const args of FINALIZATION_COMMANDS) runCommandWithRetry(args);

  const headCommitHash = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  const stepA = readJson(STEP_A_PATH);
  const ledger = readJson(LEDGER_PATH);
  const matrix = readJson(MATRIX_PATH);
  const recovery = readJson(RECOVERY_PATH);
  const parity = readJson(PARITY_PATH);
  const localization = readJson(LOCALIZATION_PATH);
  const ablation = readJson(ABLATION_PATH);
  const semanticBridgeMatrix = readJson(SEMANTIC_BRIDGE_MATRIX_PATH);
  const operatorMappingAudit = readJson(OPERATOR_MAPPING_AUDIT_PATH);
  const kernelProvenanceAudit = readJson(KERNEL_PROVENANCE_AUDIT_PATH);
  const curvatureApplicabilityAudit = readJson(CURVATURE_APPLICABILITY_AUDIT_PATH);
  const uncertaintyAudit = readJson(UNCERTAINTY_AUDIT_PATH);
  const literatureParityReplay = readJson(LITERATURE_PARITY_REPLAY_PATH);
  const promotionBundle = readJson(PROMOTION_BUNDLE_PATH);
  const evidenceSnapshot = readJson(EVIDENCE_SNAPSHOT_PATH);
  assertBundleProvenanceFresh(
    headCommitHash,
    stepA,
    ledger,
    matrix,
    recovery,
    parity,
    localization,
    ablation,
    semanticBridgeMatrix,
    kernelProvenanceAudit,
  );
  const operatorMappingAuditCommitHash = readCommitHash(operatorMappingAudit);
  if (operatorMappingAuditCommitHash !== headCommitHash) {
    throw new Error(
      `Operator mapping audit provenance commit hash mismatch: operatorMappingAudit=${String(
        operatorMappingAuditCommitHash ?? 'null',
      )} head=${headCommitHash}`,
    );
  }
  const uncertaintyAuditCommitHash = readCommitHash(uncertaintyAudit);
  if (uncertaintyAuditCommitHash !== headCommitHash) {
    throw new Error(
      `Uncertainty audit provenance commit hash mismatch: uncertaintyAudit=${String(
        uncertaintyAuditCommitHash ?? 'null',
      )} head=${headCommitHash}`,
    );
  }
  const literatureParityReplayCommitHash = readCommitHash(literatureParityReplay);
  if (literatureParityReplayCommitHash !== headCommitHash) {
    throw new Error(
      `Literature parity replay provenance commit hash mismatch: literatureParityReplay=${String(
        literatureParityReplayCommitHash ?? 'null',
      )} head=${headCommitHash}`,
    );
  }
  if (literatureParityReplay?.blockedReason != null || literatureParityReplay?.parityEvidenceStatus !== 'pass') {
    throw new Error(
      `Literature parity replay blocked fail-closed: blockedReason=${String(
        literatureParityReplay?.blockedReason ?? 'none',
      )};status=${String(literatureParityReplay?.parityEvidenceStatus ?? 'unknown')}`,
    );
  }
  const curvatureApplicabilityAuditCommitHash = readCommitHash(curvatureApplicabilityAudit);
  if (curvatureApplicabilityAuditCommitHash !== headCommitHash) {
    throw new Error(
      `Curvature applicability audit provenance commit hash mismatch: curvatureApplicabilityAudit=${String(
        curvatureApplicabilityAuditCommitHash ?? 'null',
      )} head=${headCommitHash}`,
    );
  }
  const evidenceSnapshotCommitHash = readCommitHash(evidenceSnapshot);
  if (evidenceSnapshotCommitHash !== headCommitHash) {
    throw new Error(
      `Evidence snapshot provenance commit hash mismatch: evidenceSnapshot=${String(
        evidenceSnapshotCommitHash ?? 'null',
      )} head=${headCommitHash}`,
    );
  }
  if (evidenceSnapshot?.blocked === true) {
    throw new Error(`Evidence snapshot blocked fail-closed: ${String(evidenceSnapshot?.stopReason ?? 'unknown_reason')}`);
  }
  assertEvidenceSnapshotStrongClaimClosure(evidenceSnapshot);
  const promotionBundleCommitHash = readCommitHash(promotionBundle);
  if (promotionBundleCommitHash !== headCommitHash) {
    throw new Error(
      `Promotion bundle provenance commit hash mismatch: promotionBundle=${String(
        promotionBundleCommitHash ?? 'null',
      )} head=${headCommitHash}`,
    );
  }
  if (promotionBundle?.blockedReason != null) {
    throw new Error(
      `Promotion bundle blocked fail-closed: ${String(promotionBundle?.blockedReason)}`,
    );
  }
  if (promotionBundle?.promotionLaneExecuted !== true) {
    throw new Error('Promotion bundle lane execution missing: promotionLaneExecuted=false');
  }
  if (promotionBundle?.candidatePromotionReady !== true || promotionBundle?.candidatePromotionStable !== true) {
    throw new Error(
      `Promotion bundle readiness mismatch: ready=${String(promotionBundle?.candidatePromotionReady)};stable=${String(
        promotionBundle?.candidatePromotionStable,
      )}`,
    );
  }

  return {
    ok: true,
    boundaryStatement: BOUNDARY_STATEMENT,
    headCommitHash,
    stepAPath: STEP_A_PATH,
    ledgerPath: LEDGER_PATH,
    matrixPath: MATRIX_PATH,
    recoveryPath: RECOVERY_PATH,
    parityPath: PARITY_PATH,
    localizationPath: LOCALIZATION_PATH,
    ablationPath: ABLATION_PATH,
    semanticBridgeMatrixPath: SEMANTIC_BRIDGE_MATRIX_PATH,
    operatorMappingAuditPath: OPERATOR_MAPPING_AUDIT_PATH,
    kernelProvenanceAuditPath: KERNEL_PROVENANCE_AUDIT_PATH,
    curvatureApplicabilityAuditPath: CURVATURE_APPLICABILITY_AUDIT_PATH,
    uncertaintyAuditPath: UNCERTAINTY_AUDIT_PATH,
    literatureParityReplayPath: LITERATURE_PARITY_REPLAY_PATH,
    promotionBundlePath: PROMOTION_BUNDLE_PATH,
    evidenceSnapshotPath: EVIDENCE_SNAPSHOT_PATH,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(runCanonicalBundle()));
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
