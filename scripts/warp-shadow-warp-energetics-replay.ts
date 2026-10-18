import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const FULL_SOLVE_DIR = path.join('artifacts', 'research', 'full-solve');
const DEFAULT_SNAPSHOT_PATH = path.join('docs', 'specs', 'data', 'warp-core4-alcubierre-1994-energetics.v1.json');
const DEFAULT_BASELINE_PATH = path.join(FULL_SOLVE_DIR, 'full-solve-reference-capsule-latest.json');
const DEFAULT_OUT_JSON = path.join(FULL_SOLVE_DIR, `warp-energetics-replay-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-energetics-replay-${DATE_STAMP}.md`);
const REQUIRED_KEYS = [
  'negative_energy_branch_policy',
  'qei_worldline_requirement',
  'stress_source_contract',
  'assumption_domain_disclosure',
  'physical_feasibility_boundary',
] as const;
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

type SignatureStatus = 'pass' | 'fail' | 'unknown';

type SignatureEntry = {
  status: SignatureStatus;
  reason_code: string;
  local_status: SignatureStatus;
  comparison: 'pass' | 'fail' | 'inconclusive';
};

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

const normalizePath = (filePath: string) => filePath.replace(/\\/g, '/');

const parseStatus = (value: unknown): SignatureStatus => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'pass' || normalized === 'fail') return normalized;
  return 'unknown';
};

const ensureDir = (filePath: string) => fs.mkdirSync(path.dirname(filePath), { recursive: true });

const readJson = (filePath: string): any => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const getHeadCommit = (): string | null => {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const computeChecksum = (payload: Record<string, unknown>): string => {
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(payload));
  delete copy.generatedAt;
  delete copy.generatedOn;
  delete copy.checksum;
  const canonical = JSON.stringify(copy, Object.keys(copy).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

const loadBaselineSignature = (baselinePath: string): Record<string, SignatureStatus> => {
  if (!fs.existsSync(baselinePath)) return {};
  const baseline = readJson(baselinePath);
  const signature = (baseline?.energetics_qei_conformance?.signature ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, SignatureStatus> = {};
  for (const key of REQUIRED_KEYS) {
    out[key] = parseStatus(signature?.[key]?.status);
  }
  return out;
};

const renderMarkdown = (payload: any): string => {
  const rows = Object.entries(payload.energetics_signature as Record<string, SignatureEntry>)
    .map(
      ([key, value]) =>
        `| ${key} | ${value.local_status} | ${value.status} | ${value.comparison} | ${value.reason_code} |`,
    )
    .join('\n');
  const blockers = (payload.blockers as string[]).length
    ? (payload.blockers as string[]).map((entry) => `- ${entry}`).join('\n')
    : '- none';
  return `# Warp Energetics/QEI Replay (${payload.work_id}, ${payload.generatedOn})

"${BOUNDARY_STATEMENT}"

## Inputs
- snapshot: \`${payload.inputs.snapshotPath}\`
- baseline: \`${payload.inputs.baselinePath}\`
- chain_id: \`${payload.chain_id}\`

## Signature Comparison
| key | local_status | external_status | comparison | reason_code |
|---|---|---|---|---|
${rows}

## Result
- comparison_status: \`${payload.comparison_result.status}\`
- pass_count: \`${payload.comparison_result.pass_count}\`
- fail_count: \`${payload.comparison_result.fail_count}\`
- inconclusive_count: \`${payload.comparison_result.inconclusive_count}\`
- recompute_ready: \`${payload.recompute_ready}\`
- replay_status: \`${payload.replay.status}\`

## Reason Codes
- ${(payload.reason_codes as string[]).join(', ') || 'none'}

## Blockers
${blockers}
`;
};

export const runWarpEnergeticsReplay = (options: {
  snapshotPath?: string;
  baselinePath?: string;
  outJsonPath?: string;
  outMdPath?: string;
  workId?: string;
}) => {
  const snapshotPath = options.snapshotPath ?? DEFAULT_SNAPSHOT_PATH;
  const baselinePath = options.baselinePath ?? DEFAULT_BASELINE_PATH;
  const outJsonPath = options.outJsonPath ?? DEFAULT_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_OUT_MD;
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`Missing snapshot: ${snapshotPath}`);
  }
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`Missing baseline capsule: ${baselinePath}`);
  }

  const snapshot = readJson(snapshotPath);
  const workId = options.workId ?? asText(snapshot?.work_id) ?? 'UNKNOWN_WORK';
  const blockers: string[] = [];
  const reasonCodes = new Set<string>();

  const equationAnchors = Array.isArray(snapshot?.equation_anchors) ? snapshot.equation_anchors : [];
  if (equationAnchors.length === 0) {
    blockers.push('missing_equation_anchor');
    reasonCodes.add('missing_equation_anchor');
  }

  const snapshotWorkId = asText(snapshot?.work_id);
  if (snapshotWorkId && snapshotWorkId !== workId) {
    blockers.push('work_id_mismatch');
    reasonCodes.add('work_id_mismatch');
  }

  const assumptionComparability = asText(snapshot?.assumption_domain?.comparability) ?? 'unknown';
  if (assumptionComparability === 'non_comparable') {
    reasonCodes.add('non_comparable_assumption_domain');
  }

  const baselineSignature = loadBaselineSignature(baselinePath);
  const externalSignature = (snapshot?.energetics_signature ?? {}) as Record<string, Record<string, unknown>>;
  const normalizedSignature: Record<string, SignatureEntry> = {};
  let passCount = 0;
  let failCount = 0;
  let inconclusiveCount = 0;

  for (const key of REQUIRED_KEYS) {
    const entry = externalSignature[key];
    const localStatus = baselineSignature[key] ?? 'unknown';
    if (!entry) {
      blockers.push(`missing_snapshot_field:${key}`);
      reasonCodes.add(`missing_snapshot_field:${key}`);
      normalizedSignature[key] = {
        status: 'unknown',
        reason_code: `missing_snapshot_field:${key}`,
        local_status: localStatus,
        comparison: 'inconclusive',
      };
      inconclusiveCount += 1;
      continue;
    }

    const externalStatus = parseStatus(entry.status);
    const reasonCode = asText(entry.reason_code) ?? 'reason_code_unspecified';
    const comparable =
      assumptionComparability !== 'non_comparable' &&
      externalStatus !== 'unknown' &&
      localStatus !== 'unknown';

    if (!comparable) {
      normalizedSignature[key] = {
        status: externalStatus,
        reason_code: reasonCode,
        local_status: localStatus,
        comparison: 'inconclusive',
      };
      reasonCodes.add(reasonCode);
      inconclusiveCount += 1;
      continue;
    }

    const comparison = externalStatus === localStatus ? 'pass' : 'fail';
    normalizedSignature[key] = {
      status: externalStatus,
      reason_code: comparison === 'pass' ? reasonCode : `status_mismatch:${key}`,
      local_status: localStatus,
      comparison,
    };
    if (comparison === 'pass') {
      passCount += 1;
      if (reasonCode !== 'reason_code_unspecified') reasonCodes.add(reasonCode);
    } else {
      failCount += 1;
      reasonCodes.add(`status_mismatch:${key}`);
    }
  }

  let comparisonStatus: 'compatible' | 'partial' | 'inconclusive' = 'inconclusive';
  if (passCount > 0 && failCount === 0 && inconclusiveCount === 0) comparisonStatus = 'compatible';
  else if (passCount > 0 || failCount > 0) comparisonStatus = 'partial';

  const hasHardBlocker = blockers.some(
    (entry) => entry === 'missing_equation_anchor' || entry.startsWith('missing_snapshot_field:'),
  );
  const recomputeReady = hasHardBlocker ? 'blocked' : comparisonStatus === 'compatible' ? 'full' : 'partial';
  const replayStatus = hasHardBlocker ? 'blocked_partial' : comparisonStatus === 'compatible' ? 'pass_full' : 'pass_partial';

  const payloadBase: Record<string, unknown> = {
    artifactType: 'external_warp_energetics_replay/v1',
    generatedOn: DATE_STAMP,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    work_id: workId,
    title: asText(snapshot?.title),
    chain_id: 'CH-WARP-002',
    source_refs: Array.isArray(snapshot?.source_refs) ? snapshot.source_refs : [],
    assumption_domain: snapshot?.assumption_domain ?? null,
    inputs: {
      snapshotPath: normalizePath(snapshotPath),
      baselinePath: normalizePath(baselinePath),
    },
    energetics_signature: normalizedSignature,
    comparison_result: {
      status: comparisonStatus,
      pass_count: passCount,
      fail_count: failCount,
      inconclusive_count: inconclusiveCount,
    },
    reason_codes: [...reasonCodes].sort(),
    recompute_ready: recomputeReady,
    blockers: [...new Set(blockers)].sort(),
    replay: {
      status: replayStatus,
      note: 'Energetics/QEI parity replay is reference-only and non-blocking.',
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
  const payload = runWarpEnergeticsReplay({
    snapshotPath: readArgValue('--snapshot'),
    baselinePath: readArgValue('--baseline'),
    outJsonPath: readArgValue('--out-json'),
    outMdPath: readArgValue('--out-md'),
    workId: readArgValue('--work-id'),
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
