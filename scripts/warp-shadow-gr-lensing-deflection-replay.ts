import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const FULL_SOLVE_DIR = path.join('artifacts', 'research', 'full-solve');
const DEFAULT_SNAPSHOT_PATH = path.join('docs', 'specs', 'data', 'gr-lensing-deflection-observable.v1.json');
const DEFAULT_OUT_JSON = path.join(FULL_SOLVE_DIR, `gr-lensing-deflection-replay-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-gr-lensing-deflection-replay-${DATE_STAMP}.md`);
const ARCSEC_PER_RAD = 206264.80624709636;
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
  const signature = payload.gr_observable_signature.lensing_deflection;
  return `# GR Lensing Deflection Replay (${payload.work_id}, ${payload.generatedOn})

"${BOUNDARY_STATEMENT}"

## Inputs
- snapshot: \`${payload.inputs.snapshotPath}\`
- chain_id: \`${payload.chain_id}\`

## Derived Observable
- predicted_limb_arcsec: \`${signature.predicted_limb_arcsec}\`
- historical_observed_arcsec: \`${signature.historical_observed_arcsec}\`
- historical_residual_arcsec: \`${signature.historical_residual_arcsec}\`
- modern_gamma_measured: \`${signature.modern_gamma_measured}\`
- modern_gamma_residual: \`${signature.modern_gamma_residual}\`
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

export const runGrLensingDeflectionReplay = (options: {
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
  const workId = options.workId ?? asText(snapshot?.work_id) ?? 'EXT-GR-LENS-001';
  const blockers: string[] = [];
  const reasonCodes = new Set<string>();

  const equationAnchors = Array.isArray(snapshot?.equation_anchors) ? snapshot.equation_anchors : [];
  if (equationAnchors.length === 0) {
    blockers.push('missing_equation_anchor');
    reasonCodes.add('missing_equation_anchor');
  }

  const constants = (snapshot?.constants ?? {}) as Record<string, unknown>;
  const gmSun = asNumber(constants.gm_sun_m3_s2);
  const c = asNumber(constants.c_m_s);
  const impactParameter = asNumber(constants.solar_limb_impact_parameter_m);
  if (gmSun == null || c == null || impactParameter == null) {
    blockers.push('missing_constants');
    reasonCodes.add('missing_constants');
  }

  const observed = (snapshot?.observed ?? {}) as Record<string, unknown>;
  const historicalDeflectionArcsec = asNumber(observed.historical_deflection_arcsec);
  const historicalUncertaintyArcsec = asNumber(observed.historical_uncertainty_arcsec) ?? 0.16;
  const modernGamma = asNumber(observed.modern_gamma);
  const modernGammaUncertainty = asNumber(observed.modern_gamma_uncertainty) ?? 0.0003;
  if (modernGamma == null) {
    blockers.push('missing_modern_gamma_anchor');
    reasonCodes.add('missing_modern_gamma_anchor');
  }

  const acceptance = (snapshot?.acceptance ?? {}) as Record<string, unknown>;
  const maxAbsHistoricalResidualArcsec = asNumber(acceptance.max_abs_historical_residual_arcsec) ?? 0.5;
  const maxAbsGammaResidual = asNumber(acceptance.max_abs_gamma_residual) ?? 0.001;

  let predictedLimbArcsec: number | null = null;
  if (gmSun != null && c != null && impactParameter != null) {
    const alphaLimbRad = (4 * gmSun) / (c * c * impactParameter);
    predictedLimbArcsec = alphaLimbRad * ARCSEC_PER_RAD;
  }
  let historicalResidualArcsec: number | null = null;
  if (predictedLimbArcsec != null && historicalDeflectionArcsec != null) {
    historicalResidualArcsec = predictedLimbArcsec - historicalDeflectionArcsec;
  }
  const modernGammaResidual = modernGamma != null ? modernGamma - 1 : null;

  const historicalPass =
    historicalResidualArcsec != null ? Math.abs(historicalResidualArcsec) <= maxAbsHistoricalResidualArcsec : null;
  const modernPass = modernGammaResidual != null ? Math.abs(modernGammaResidual) <= maxAbsGammaResidual : null;

  let signatureStatus: 'pass' | 'fail' | 'unknown' = 'unknown';
  let signatureReason = 'insufficient_data';
  if (modernPass === true && (historicalPass === true || historicalPass === null)) {
    signatureStatus = 'pass';
    signatureReason = historicalPass === true ? 'historical_and_modern_within_tolerance' : 'modern_within_tolerance';
  } else if (modernPass === false || historicalPass === false) {
    signatureStatus = 'fail';
    signatureReason = modernPass === false ? 'modern_gamma_residual_exceeds_tolerance' : 'historical_residual_exceeds_tolerance';
  }
  reasonCodes.add(signatureReason);

  const hasHardBlocker = blockers.some((entry) => ['missing_equation_anchor', 'missing_constants', 'missing_modern_gamma_anchor'].includes(entry));
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
    artifactType: 'external_gr_lensing_deflection_replay/v1',
    generatedOn: DATE_STAMP,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    work_id: workId,
    title: asText(snapshot?.title),
    chain_id: 'CH-GR-002',
    source_refs: Array.isArray(snapshot?.source_refs) ? snapshot.source_refs : [],
    assumption_domain: snapshot?.assumption_domain ?? null,
    inputs: {
      snapshotPath: normalizePath(snapshotPath),
    },
    gr_observable_signature: {
      lensing_deflection: {
        status: signatureStatus,
        reason_code: signatureReason,
        predicted_limb_arcsec: predictedLimbArcsec,
        historical_observed_arcsec: historicalDeflectionArcsec,
        historical_residual_arcsec: historicalResidualArcsec,
        historical_uncertainty_arcsec: historicalUncertaintyArcsec,
        max_abs_historical_residual_arcsec: maxAbsHistoricalResidualArcsec,
        modern_gamma_measured: modernGamma,
        modern_gamma_residual: modernGammaResidual,
        modern_gamma_uncertainty: modernGammaUncertainty,
        max_abs_gamma_residual: maxAbsGammaResidual,
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
        predictedLimbArcsec: predictedLimbArcsec,
        historicalObservedArcsec: historicalDeflectionArcsec,
        historicalResidualArcsec: historicalResidualArcsec,
        modernGammaMeasured: modernGamma,
        modernGammaResidual: modernGammaResidual,
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
  const payload = runGrLensingDeflectionReplay({
    snapshotPath: readArgValue('--snapshot'),
    outJsonPath: readArgValue('--out-json'),
    outMdPath: readArgValue('--out-md'),
    workId: readArgValue('--work-id'),
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
