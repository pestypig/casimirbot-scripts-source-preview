import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const FULL_SOLVE_DIR = path.join('artifacts', 'research', 'full-solve');
const DEFAULT_SNAPSHOT_PATH = path.join('docs', 'specs', 'data', 'gr-mercury-perihelion-einstein-1915.v1.json');
const DEFAULT_OUT_JSON = path.join(FULL_SOLVE_DIR, `gr-mercury-precession-replay-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-gr-mercury-precession-replay-${DATE_STAMP}.md`);
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
  const signature = payload.gr_observable_signature.mercury_perihelion_precession;
  return `# GR Mercury Perihelion Replay (${payload.work_id}, ${payload.generatedOn})

"${BOUNDARY_STATEMENT}"

## Inputs
- snapshot: \`${payload.inputs.snapshotPath}\`
- chain_id: \`${payload.chain_id}\`

## Derived Observable
- predicted_arcsec_per_century: \`${signature.predicted_arcsec_per_century}\`
- observed_arcsec_per_century: \`${signature.observed_arcsec_per_century}\`
- residual_arcsec_per_century: \`${signature.residual_arcsec_per_century}\`
- residual_tolerance_arcsec_per_century: \`${signature.max_abs_residual_arcsec_per_century}\`
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

export const runGrMercuryPrecessionReplay = (options: {
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
  const workId = options.workId ?? asText(snapshot?.work_id) ?? 'EXT-GR-MERC-001';
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
  const a = asNumber(constants.a_m);
  const e = asNumber(constants.e);
  const orbitalPeriodDays = asNumber(constants.orbital_period_days);
  if (gmSun == null || c == null || a == null || e == null || orbitalPeriodDays == null) {
    blockers.push('missing_constants');
    reasonCodes.add('missing_constants');
  }

  const observed = (snapshot?.observed ?? {}) as Record<string, unknown>;
  const observedArcsecPerCentury = asNumber(observed.anomalous_arcsec_per_century);
  const observedUncertaintyArcsecPerCentury = asNumber(observed.uncertainty_arcsec_per_century) ?? 0.5;
  if (observedArcsecPerCentury == null) {
    blockers.push('missing_observed_anchor');
    reasonCodes.add('missing_observed_anchor');
  }

  const acceptance = (snapshot?.acceptance ?? {}) as Record<string, unknown>;
  const maxAbsResidualArcsecPerCentury = asNumber(acceptance.max_abs_residual_arcsec_per_century) ?? 1.0;

  let predictedArcsecPerCentury: number | null = null;
  let residualArcsecPerCentury: number | null = null;
  if (gmSun != null && c != null && a != null && e != null && orbitalPeriodDays != null && observedArcsecPerCentury != null) {
    const deltaPerOrbitRad = (6 * Math.PI * gmSun) / (a * (1 - e * e) * c * c);
    const orbitsPerCentury = 36525 / orbitalPeriodDays;
    predictedArcsecPerCentury = deltaPerOrbitRad * ARCSEC_PER_RAD * orbitsPerCentury;
    residualArcsecPerCentury = predictedArcsecPerCentury - observedArcsecPerCentury;
  }

  let signatureStatus: 'pass' | 'fail' | 'unknown' = 'unknown';
  let signatureReason = 'insufficient_data';
  if (residualArcsecPerCentury != null) {
    if (Math.abs(residualArcsecPerCentury) <= maxAbsResidualArcsecPerCentury) {
      signatureStatus = 'pass';
      signatureReason = 'residual_within_tolerance';
      reasonCodes.add(signatureReason);
    } else {
      signatureStatus = 'fail';
      signatureReason = 'residual_exceeds_tolerance';
      reasonCodes.add(signatureReason);
    }
  }

  const hasHardBlocker = blockers.some((entry) =>
    ['missing_equation_anchor', 'missing_constants', 'missing_observed_anchor'].includes(entry),
  );
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
    artifactType: 'external_gr_mercury_precession_replay/v1',
    generatedOn: DATE_STAMP,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    work_id: workId,
    title: asText(snapshot?.title),
    chain_id: 'CH-GR-001',
    source_refs: Array.isArray(snapshot?.source_refs) ? snapshot.source_refs : [],
    assumption_domain: snapshot?.assumption_domain ?? null,
    inputs: {
      snapshotPath: normalizePath(snapshotPath),
    },
    gr_observable_signature: {
      mercury_perihelion_precession: {
        status: signatureStatus,
        reason_code: signatureReason,
        predicted_arcsec_per_century: predictedArcsecPerCentury,
        observed_arcsec_per_century: observedArcsecPerCentury,
        residual_arcsec_per_century: residualArcsecPerCentury,
        observed_uncertainty_arcsec_per_century: observedUncertaintyArcsecPerCentury,
        max_abs_residual_arcsec_per_century: maxAbsResidualArcsecPerCentury,
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
        predictedArcsecPerCentury: predictedArcsecPerCentury,
        observedArcsecPerCentury: observedArcsecPerCentury,
        residualArcsecPerCentury: residualArcsecPerCentury,
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
  const payload = runGrMercuryPrecessionReplay({
    snapshotPath: readArgValue('--snapshot'),
    outJsonPath: readArgValue('--out-json'),
    outMdPath: readArgValue('--out-md'),
    workId: readArgValue('--work-id'),
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
