import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const GENERATOR_VERSION = '1.0.0';
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const FULL_SOLVE_DIR = path.join('artifacts', 'research', 'full-solve');
const DOC_AUDIT_DIR = path.join('docs', 'audits', 'research');
const EXTERNAL_WORK_DIR = path.join(FULL_SOLVE_DIR, 'external-work');

const DEFAULT_OUT_JSON = path.join(FULL_SOLVE_DIR, `warp-deliverable-dossier-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join(DOC_AUDIT_DIR, `warp-deliverable-dossier-${DATE_STAMP}.md`);
const DEFAULT_LATEST_JSON = path.join(FULL_SOLVE_DIR, 'warp-deliverable-dossier-latest.json');
const DEFAULT_LATEST_MD = path.join(DOC_AUDIT_DIR, 'warp-deliverable-dossier-latest.md');

const DEFAULT_READINESS_PATH = path.join(FULL_SOLVE_DIR, 'promotion-readiness-suite-latest.json');
const DEFAULT_INTEGRITY_PATH = path.join(FULL_SOLVE_DIR, 'integrity-parity-suite-latest.json');
const DEFAULT_CAPSULE_PATH = path.join(FULL_SOLVE_DIR, 'full-solve-reference-capsule-latest.json');
const DEFAULT_EXTERNAL_MATRIX_PATH = path.join(EXTERNAL_WORK_DIR, 'external-work-comparison-matrix-latest.json');

const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';

type StepRecord = {
  id: string;
  command: string;
  status: 'pass';
};

type BlockerCategory =
  | 'artifact_missing'
  | 'integrity'
  | 'readiness'
  | 'verification'
  | 'external'
  | 'repeatability';

type Blocker = {
  code: string;
  category: BlockerCategory;
  detail: string;
  path: string | null;
};

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const hasFlag = (name: string, argv = process.argv.slice(2)): boolean => argv.includes(name);

const normalizePath = (filePath: string): string => filePath.replace(/\\/g, '/');

const resolvePathFromRoot = (filePath: string, cwd = process.cwd()): string =>
  path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);

const ensureDirForFile = (filePath: string) => fs.mkdirSync(path.dirname(filePath), { recursive: true });

const readJson = (filePath: string): any => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const readJsonSafe = (filePath: string): any | null => {
  try {
    return readJson(resolvePathFromRoot(filePath));
  } catch {
    return null;
  }
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
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const objectWithSortedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => objectWithSortedKeys(entry));
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = objectWithSortedKeys(source[key]);
    return out;
  }
  return value;
};

const checksumPayload = (payload: Record<string, unknown>): string => {
  const volatileKeys = new Set(['generated_at', 'checksum', 'normalized_checksum', 'traceId', 'runId']);
  const stripVolatile = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((entry) => stripVolatile(entry));
    if (value && typeof value === 'object') {
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(source)) {
        if (volatileKeys.has(key)) continue;
        out[key] = stripVolatile(source[key]);
      }
      return out;
    }
    return value;
  };
  const canonical = JSON.stringify(objectWithSortedKeys(stripVolatile(JSON.parse(JSON.stringify(payload)))));
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

const runCommand = (command: string, args: string[]) =>
  spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'inherit',
    shell: false,
  });

const runNpm = (args: string[], steps: StepRecord[], stepId: string) => {
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  const result = runCommand(npmCommand, commandArgs);
  if (result.status !== 0) {
    throw new Error(`Command failed: npm ${args.join(' ')} (exit=${String(result.status)})`);
  }
  steps.push({ id: stepId, command: `npm ${args.join(' ')}`, status: 'pass' });
};

const getCommitPin = (): string => execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();

const renderMarkdown = (payload: any): string => {
  const laneRows = Array.isArray(payload?.lane_reportable_coverage?.lanes)
    ? payload.lane_reportable_coverage.lanes
        .map(
          (lane: any) =>
            `| ${lane.laneId} | ${lane.reportableReady === true ? 'true' : 'false'} | ${lane.evidenceCongruence?.congruent ?? 0} | ${
              lane.evidenceCongruence?.incongruent ?? 0
            } | ${lane.evidenceCongruence?.unknown ?? 0} | ${Array.isArray(lane.blockedReasons) && lane.blockedReasons.length > 0 ? lane.blockedReasons.join(', ') : 'none'} |`,
        )
        .join('\n')
    : '';

  const blockerRows = Array.isArray(payload?.blockers)
    ? payload.blockers
        .map((entry: any) => `| ${entry.code} | ${entry.category} | ${entry.path ?? 'n/a'} | ${entry.detail} |`)
        .join('\n')
    : '';

  return `# Warp Deliverable Dossier (${payload.generated_on})

"${payload.boundary_statement}"

## Result
- artifact_type: \`${payload.artifact_type}\`
- commit_pin: \`${payload.commit_pin}\`
- final_deliverable_status: \`${payload.final_deliverable_status}\`
- checksum: \`${payload.checksum}\`

## Canonical
- decision: \`${payload.canonical?.decision ?? 'UNKNOWN'}\`
- counts: \`PASS=${payload.canonical?.counts?.PASS ?? 0}, FAIL=${payload.canonical?.counts?.FAIL ?? 0}, UNKNOWN=${
    payload.canonical?.counts?.UNKNOWN ?? 0
  }, NOT_READY=${payload.canonical?.counts?.NOT_READY ?? 0}, NOT_APPLICABLE=${payload.canonical?.counts?.NOT_APPLICABLE ?? 0}\`

## Integrity + Readiness
- integrity_final_parity_verdict: \`${payload.integrity?.final_parity_verdict ?? 'UNKNOWN'}\`
- integrity_blocker_count: \`${payload.integrity?.blocker_count ?? 'UNKNOWN'}\`
- readiness_final_verdict: \`${payload.readiness?.final_readiness_verdict ?? 'UNKNOWN'}\`
- readiness_gate_pass: \`${payload.readiness?.readiness_gate_pass === true}\`

## Casimir Certificate
- verdict: \`${payload.certification?.verdict ?? 'UNKNOWN'}\`
- firstFail: \`${payload.certification?.firstFail ?? 'null'}\`
- traceId: \`${payload.certification?.traceId ?? 'UNKNOWN'}\`
- runId: \`${payload.certification?.runId ?? 'UNKNOWN'}\`
- certificateHash: \`${payload.certification?.certificateHash ?? 'UNKNOWN'}\`
- integrityOk: \`${payload.certification?.integrityOk === true}\`
- status: \`${payload.certification?.status ?? 'UNKNOWN'}\`

## Lane Coverage
| lane | reportable_ready | congruent | incongruent | unknown | blocked_reasons |
|---|---|---:|---:|---:|---|
${laneRows || '| none | false | 0 | 0 | 0 | n/a |'}

## External Matrix
- total: \`${payload.external_work?.summary_counts?.total ?? 0}\`
- compatible: \`${payload.external_work?.summary_counts?.compatible ?? 0}\`
- partial: \`${payload.external_work?.summary_counts?.partial ?? 0}\`
- inconclusive: \`${payload.external_work?.summary_counts?.inconclusive ?? 0}\`
- stale_count: \`${payload.external_work?.stale_count ?? 0}\`

## Repeatability
- same_commit_prior_found: \`${payload.repeatability?.same_commit_prior_found === true}\`
- comparable_prior: \`${payload.repeatability?.comparable_prior === true}\`
- matches_prior_checksum: \`${payload.repeatability?.matches_prior_checksum === true}\`
- prior_checksum: \`${payload.repeatability?.prior_checksum ?? 'none'}\`

## Executed Steps
| id | command | status |
|---|---|---|
${Array.isArray(payload.steps) && payload.steps.length > 0 ? payload.steps.map((entry: any) => `| ${entry.id} | ${entry.command} | ${entry.status} |`).join('\n') : '| none | n/a | unknown |'}

## Blockers
| code | category | path | detail |
|---|---|---|---|
${blockerRows || '| none | n/a | n/a | none |'}
`;
};

export const runWarpDeliverableBuild = (options: {
  outJsonPath?: string;
  outMdPath?: string;
  latestJsonPath?: string;
  latestMdPath?: string;
  skipReadinessChain?: boolean;
}) => {
  const outJsonPath = options.outJsonPath ?? DEFAULT_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_OUT_MD;
  const latestJsonPath = options.latestJsonPath ?? DEFAULT_LATEST_JSON;
  const latestMdPath = options.latestMdPath ?? DEFAULT_LATEST_MD;
  const skipReadinessChain = options.skipReadinessChain === true;

  const steps: StepRecord[] = [];
  const blockers: Blocker[] = [];
  const addBlocker = (
    code: string,
    category: BlockerCategory,
    detail: string,
    blockerPath: string | null = null,
  ) =>
    blockers.push({
      code,
      category,
      detail,
      path: blockerPath ? normalizePath(blockerPath) : null,
    });

  if (!skipReadinessChain) {
    try {
      runNpm(['run', 'warp:promotion:readiness:check'], steps, 'promotion_readiness_check');
    } catch (error) {
      addBlocker(
        'readiness_chain_command_failed',
        'readiness',
        error instanceof Error ? error.message : String(error),
        DEFAULT_READINESS_PATH,
      );
    }
  }

  const readiness = readJsonSafe(DEFAULT_READINESS_PATH);
  const integrity = readJsonSafe(DEFAULT_INTEGRITY_PATH);
  const capsule = readJsonSafe(DEFAULT_CAPSULE_PATH);
  const externalMatrix = readJsonSafe(DEFAULT_EXTERNAL_MATRIX_PATH);

  if (!readiness) addBlocker('missing_readiness_suite', 'artifact_missing', 'promotion readiness suite missing', DEFAULT_READINESS_PATH);
  if (!integrity) addBlocker('missing_integrity_suite', 'artifact_missing', 'integrity parity suite missing', DEFAULT_INTEGRITY_PATH);
  if (!capsule) addBlocker('missing_reference_capsule', 'artifact_missing', 'reference capsule missing', DEFAULT_CAPSULE_PATH);
  if (!externalMatrix)
    addBlocker(
      'missing_external_work_matrix',
      'artifact_missing',
      'external work comparison matrix missing',
      DEFAULT_EXTERNAL_MATRIX_PATH,
    );

  const canonicalDecision = asText(capsule?.canonical_state?.decision) ?? 'UNKNOWN';
  const canonicalCounts = (capsule?.canonical_state?.counts ?? {}) as Record<string, unknown>;

  const integrityVerdict = asText(integrity?.final_parity_verdict) ?? 'UNKNOWN';
  const integrityBlockerCount = asNumber(integrity?.blocker_count) ?? null;
  if (integrityVerdict !== 'PASS') {
    addBlocker(
      'integrity_verdict_not_pass',
      'integrity',
      `expected PASS, got ${integrityVerdict}`,
      DEFAULT_INTEGRITY_PATH,
    );
  }

  const readinessVerdict = asText(readiness?.final_readiness_verdict) ?? 'UNKNOWN';
  const readinessGatePass = readiness?.readiness_gate_pass === true;
  const laneCoverage = (readiness?.lane_reportable_coverage ?? {}) as Record<string, unknown>;
  const lanes = Array.isArray(laneCoverage.lanes) ? laneCoverage.lanes : [];
  if (!readinessGatePass) {
    addBlocker(
      'readiness_gate_not_pass',
      'readiness',
      `readiness_gate_pass=false final_readiness_verdict=${readinessVerdict}`,
      DEFAULT_READINESS_PATH,
    );
  }

  const staleCount = asNumber(externalMatrix?.stale_flags?.stale_count) ?? 0;
  if (staleCount > 0) {
    addBlocker(
      'external_stale_count_nonzero',
      'external',
      `stale_count=${staleCount}`,
      DEFAULT_EXTERNAL_MATRIX_PATH,
    );
  }

  const cert = (readiness?.casimir ?? {}) as Record<string, unknown>;
  const certVerdict = asText(cert.verdict) ?? 'UNKNOWN';
  const certIntegrityOk = cert.integrityOk === true;
  const certHash = asText(cert.certificateHash);
  if (!(certVerdict === 'PASS' && certIntegrityOk && certHash)) {
    addBlocker(
      'casimir_certificate_not_green',
      'verification',
      `verdict=${certVerdict} integrityOk=${String(certIntegrityOk)} certificateHash=${String(certHash)}`,
      DEFAULT_READINESS_PATH,
    );
  }

  const isHardFailure = () =>
    blockers.some((entry) =>
      ['artifact_missing', 'integrity', 'verification', 'external'].includes(entry.category),
    );

  const priorLatest = fs.existsSync(resolvePathFromRoot(latestJsonPath))
    ? readJson(resolvePathFromRoot(latestJsonPath))
    : null;

  const commitPin = getCommitPin();
  const payloadBase: Record<string, unknown> = {
    artifact_type: 'warp_deliverable_dossier/v1',
    generator_version: GENERATOR_VERSION,
    generated_on: DATE_STAMP,
    generated_at: new Date().toISOString(),
    commit_pin: commitPin,
    boundary_statement: BOUNDARY_STATEMENT,
    canonical: {
      decision: canonicalDecision,
      counts: canonicalCounts,
      source_path: normalizePath(DEFAULT_CAPSULE_PATH),
    },
    integrity: {
      final_parity_verdict: integrityVerdict,
      blocker_count: integrityBlockerCount,
      source_path: normalizePath(DEFAULT_INTEGRITY_PATH),
    },
    readiness: {
      final_readiness_verdict: readinessVerdict,
      readiness_gate_pass: readinessGatePass,
      blocker_count: asNumber(readiness?.blocker_count) ?? null,
      source_path: normalizePath(DEFAULT_READINESS_PATH),
    },
    lane_reportable_coverage: {
      lane_count: asNumber(laneCoverage.lane_count) ?? lanes.length,
      reportable_ready_count: asNumber(laneCoverage.reportable_ready_count) ?? 0,
      blocked_count: asNumber(laneCoverage.blocked_count) ?? 0,
      lanes,
    },
    external_work: {
      source_path: normalizePath(DEFAULT_EXTERNAL_MATRIX_PATH),
      summary_counts: externalMatrix?.summary_counts ?? {},
      stale_count: staleCount,
      reduced_reason_counts: externalMatrix?.reduced_reason_counts ?? {},
    },
    certification: {
      verdict: certVerdict,
      firstFail: cert.firstFail ?? null,
      traceId: asText(cert.traceId),
      runId: asText(cert.runId),
      certificateHash: certHash,
      integrityOk: certIntegrityOk,
      status: asText(cert.status),
    },
    anchors: {
      full_solve_reference_capsule_latest: normalizePath(DEFAULT_CAPSULE_PATH),
      integrity_parity_suite_latest: normalizePath(DEFAULT_INTEGRITY_PATH),
      promotion_readiness_suite_latest: normalizePath(DEFAULT_READINESS_PATH),
      external_work_comparison_matrix_latest: normalizePath(DEFAULT_EXTERNAL_MATRIX_PATH),
    },
    steps,
    blockers,
    blocker_count: blockers.length,
    final_deliverable_status: isHardFailure() ? 'FAIL' : readinessGatePass ? 'PASS' : 'PARTIAL',
  };

  let normalizedChecksum = checksumPayload(payloadBase);
  const priorCommit = asText(priorLatest?.commit_pin);
  const priorVersion = asText(priorLatest?.generator_version);
  const priorChecksum = asText(priorLatest?.normalized_checksum) ?? asText(priorLatest?.checksum);
  const sameCommitPriorFound = priorCommit != null && priorCommit === commitPin;
  const comparablePrior = sameCommitPriorFound && priorVersion === GENERATOR_VERSION;
  let matchesPriorChecksum = !comparablePrior || priorChecksum === normalizedChecksum;
  if (!matchesPriorChecksum) {
    addBlocker(
      'repeatability_checksum_mismatch',
      'repeatability',
      `prior=${String(priorChecksum)} new=${normalizedChecksum}`,
      latestJsonPath,
    );
    normalizedChecksum = checksumPayload(payloadBase);
    matchesPriorChecksum = priorChecksum === normalizedChecksum;
  }

  const finalDeliverableStatus = isHardFailure() ? 'FAIL' : readinessGatePass ? 'PASS' : 'PARTIAL';
  const payload = {
    ...payloadBase,
    blockers,
    blocker_count: blockers.length,
    final_deliverable_status: finalDeliverableStatus,
    repeatability: {
      same_commit_prior_found: sameCommitPriorFound,
      comparable_prior: comparablePrior,
      prior_generator_version: priorVersion,
      prior_checksum: priorChecksum,
      matches_prior_checksum: matchesPriorChecksum,
    },
    normalized_checksum: normalizedChecksum,
  } as Record<string, unknown>;
  const checksum = checksumPayload(payload);
  payload.checksum = checksum;

  const markdown = renderMarkdown(payload);
  ensureDirForFile(outJsonPath);
  ensureDirForFile(outMdPath);
  ensureDirForFile(latestJsonPath);
  ensureDirForFile(latestMdPath);
  fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(outMdPath, `${markdown}\n`);
  fs.writeFileSync(latestJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(latestMdPath, `${markdown}\n`);

  return {
    ok: finalDeliverableStatus !== 'FAIL',
    outJsonPath,
    outMdPath,
    latestJsonPath,
    latestMdPath,
    finalDeliverableStatus,
    blockerCount: blockers.length,
    checksum,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const skipReadinessChain = hasFlag('--skip-readiness-chain');
  try {
    const result = runWarpDeliverableBuild({
      outJsonPath: readArgValue('--out-json') ?? DEFAULT_OUT_JSON,
      outMdPath: readArgValue('--out-md') ?? DEFAULT_OUT_MD,
      latestJsonPath: readArgValue('--latest-json') ?? DEFAULT_LATEST_JSON,
      latestMdPath: readArgValue('--latest-md') ?? DEFAULT_LATEST_MD,
      skipReadinessChain,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exit(1);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
