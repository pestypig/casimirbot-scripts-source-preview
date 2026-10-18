import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const FULL_SOLVE_DIR = path.join('artifacts', 'research', 'full-solve');
const DEFAULT_SNAPSHOT_PATH = path.join('docs', 'specs', 'data', 'gr-shapiro-delay-observable.v1.json');
const DEFAULT_OUT_JSON = path.join(FULL_SOLVE_DIR, `gr-shapiro-delay-replay-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-gr-shapiro-delay-replay-${DATE_STAMP}.md`);
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

type ReplayStatus = 'pass_full' | 'pass_partial' | 'blocked_partial';

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const asText = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
};

const asNumber = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const normalizePath = (filePath: string) => filePath.replace(/\\/g, '/');

const readJson = (filePath: string): any => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const ensureDir = (filePath: string) => fs.mkdirSync(path.dirname(filePath), { recursive: true });

const getHeadCommit = (): string | null => {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const computeChecksum = (payload: Record<string, unknown>): string => {
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(payload));
  delete copy.generatedOn;
  delete copy.generatedAt;
  delete copy.checksum;
  const canonical = JSON.stringify(copy, Object.keys(copy).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

const renderMarkdown = (payload: any): string => {
  const blockers =
    payload.blockers.length === 0
      ? '- none'
      : payload.blockers.map((entry: string) => `- ${entry}`).join('\n');
  const signature = payload.gr_observable_signature.shapiro_delay;
  return `# GR Shapiro Delay Replay (${payload.work_id}, ${payload.generatedOn})

"${BOUNDARY_STATEMENT}"

## Inputs
- snapshot: \`${payload.inputs.snapshotPath}\`
- chain_id: \`${payload.chain_id}\`

## Derived Observable
- gamma_minus_one_measured: \`${signature.gamma_minus_one_measured}\`
- gamma_estimated: \`${signature.gamma_estimated}\`
- gamma_residual: \`${signature.gamma_residual}\`
- status: \`${signature.status}\`
- reason_code: \`${signature.reason_code}\`

## Replay Result
- comparison_status: \`${payload.comparison_result.status}\`
- recompute_ready: \`${payload.recompute_ready}\`
- replay_status: \`${payload.replay.status}\`

## Reason Codes
- ${(payload.reason_codes as string[]).join(', ') || 'none'}

## Blockers
${blockers}
`;
};

export const runGrShapiroDelayReplay = (options: {
  snapshotPath?: string;
  outJsonPath?: string;
  outMdPath?: string;
  workId?: string;
}) => {
  const snapshotPath = options.snapshotPath ?? DEFAULT_SNAPSHOT_PATH;
  const outJsonPath = options.outJsonPath ?? DEFAULT_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_OUT_MD;
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`Missing snapshot: ${snapshotPath}`);
  }

  const snapshot = readJson(snapshotPath);
  const workId = options.workId ?? asText(snapshot?.work_id) ?? 'EXT-GR-SHAP-001';
  const blockers: string[] = [];
  const reasonCodes = new Set<string>();

  const equationAnchors = Array.isArray(snapshot?.equation_anchors) ? snapshot.equation_anchors : [];
  if (equationAnchors.length === 0) {
    blockers.push('missing_equation_anchor');
    reasonCodes.add('missing_equation_anchor');
  }

  const observed = (snapshot?.observed ?? {}) as Record<string, unknown>;
  const gammaMinusOne = asNumber(observed.gamma_minus_one);
  const gammaMinusOneUncertainty = asNumber(observed.gamma_minus_one_uncertainty) ?? 2.3e-5;
  if (gammaMinusOne == null) {
    blockers.push('missing_observed_anchor');
    reasonCodes.add('missing_observed_anchor');
  }

  const acceptance = (snapshot?.acceptance ?? {}) as Record<string, unknown>;
  const maxAbsGammaMinusOne = asNumber(acceptance.max_abs_gamma_minus_one) ?? 7e-5;

  const gammaEstimated = gammaMinusOne != null ? 1 + gammaMinusOne : null;
  const gammaResidual = gammaMinusOne;
  const pass = gammaResidual != null ? Math.abs(gammaResidual) <= maxAbsGammaMinusOne : null;

  let signatureStatus: 'pass' | 'fail' | 'unknown' = 'unknown';
  let signatureReason = 'insufficient_data';
  if (pass === true) {
    signatureStatus = 'pass';
    signatureReason = 'gamma_minus_one_within_tolerance';
  } else if (pass === false) {
    signatureStatus = 'fail';
    signatureReason = 'gamma_minus_one_exceeds_tolerance';
  }
  reasonCodes.add(signatureReason);

  const hasHardBlocker = blockers.some((entry) => ['missing_equation_anchor', 'missing_observed_anchor'].includes(entry));
  const comparisonStatus: 'compatible' | 'partial' | 'inconclusive' =
    signatureStatus === 'pass' && !hasHardBlocker
      ? 'compatible'
      : signatureStatus === 'fail' || !hasHardBlocker
      ? 'partial'
      : 'inconclusive';
  const recomputeReady =
    hasHardBlocker ? 'blocked' : signatureStatus === 'pass' ? 'full' : 'partial';
  const replayStatus: ReplayStatus = hasHardBlocker
    ? 'blocked_partial'
    : signatureStatus === 'pass'
    ? 'pass_full'
    : 'pass_partial';

  const payloadBase: Record<string, unknown> = {
    artifactType: 'external_gr_shapiro_delay_replay/v1',
    generatedOn: DATE_STAMP,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    work_id: workId,
    title: asText(snapshot?.title),
    chain_id: 'CH-GR-004',
    source_refs: Array.isArray(snapshot?.source_refs) ? snapshot.source_refs : [],
    assumption_domain: snapshot?.assumption_domain ?? null,
    inputs: {
      snapshotPath: normalizePath(snapshotPath),
    },
    gr_observable_signature: {
      shapiro_delay: {
        status: signatureStatus,
        reason_code: signatureReason,
        gamma_minus_one_measured: gammaMinusOne,
        gamma_minus_one_uncertainty: gammaMinusOneUncertainty,
        gamma_estimated: gammaEstimated,
        gamma_residual: gammaResidual,
        max_abs_gamma_minus_one: maxAbsGammaMinusOne,
      },
    },
    comparison_result: {
      status: comparisonStatus,
      pass_count: signatureStatus === 'pass' ? 1 : 0,
      fail_count: signatureStatus === 'fail' ? 1 : 0,
      inconclusive_count: signatureStatus === 'unknown' ? 1 : 0,
    },
    reason_codes: [...reasonCodes].sort(),
    recompute_ready: recomputeReady,
    blockers: [...new Set(blockers)].sort(),
    replay: {
      status: replayStatus,
      note: 'Observable GR replay is reference-only and non-blocking.',
      derived: {
        gammaMinusOneMeasured: gammaMinusOne,
        gammaEstimated: gammaEstimated,
        gammaResidual: gammaResidual,
      },
    },
    provenance: {
      commitHash: getHeadCommit(),
    },
  };
  const payload = {
    ...payloadBase,
    checksum: computeChecksum(payloadBase),
  };

  ensureDir(outJsonPath);
  ensureDir(outMdPath);
  fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(outMdPath, `${renderMarkdown(payload)}\n`);
  return payload;
};

const isEntryPoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  const payload = runGrShapiroDelayReplay({
    snapshotPath: readArgValue('--snapshot'),
    outJsonPath: readArgValue('--out-json'),
    outMdPath: readArgValue('--out-md'),
    workId: readArgValue('--work-id'),
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
