import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const GENERATOR_VERSION = '1.1.1';
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const FULL_SOLVE_DIR = path.join('artifacts', 'research', 'full-solve');
const EXTERNAL_WORK_DIR = path.join(FULL_SOLVE_DIR, 'external-work');
const DOC_AUDIT_DIR = path.join('docs', 'audits', 'research');

const DEFAULT_OUT_JSON = path.join(FULL_SOLVE_DIR, `integrity-parity-suite-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join(DOC_AUDIT_DIR, `warp-integrity-parity-suite-${DATE_STAMP}.md`);
const DEFAULT_LATEST_JSON = path.join(FULL_SOLVE_DIR, 'integrity-parity-suite-latest.json');
const DEFAULT_LATEST_MD = path.join(DOC_AUDIT_DIR, 'warp-integrity-parity-suite-latest.md');

const DEFAULT_CAPSULE_PATH = path.join(FULL_SOLVE_DIR, 'full-solve-reference-capsule-latest.json');
const DEFAULT_EXTERNAL_MATRIX_PATH = path.join(EXTERNAL_WORK_DIR, 'external-work-comparison-matrix-latest.json');
const DEFAULT_MERCURY_COMPARE_PATH = path.join(
  EXTERNAL_WORK_DIR,
  'external-work-compare-ext-gr-merc-001-latest.json',
);
const DEFAULT_MERCURY_RUN_PATH = path.join(EXTERNAL_WORK_DIR, 'external-work-run-ext-gr-merc-001-latest.json');
const DEFAULT_LENSING_COMPARE_PATH = path.join(
  EXTERNAL_WORK_DIR,
  'external-work-compare-ext-gr-lens-001-latest.json',
);
const DEFAULT_LENSING_RUN_PATH = path.join(EXTERNAL_WORK_DIR, 'external-work-run-ext-gr-lens-001-latest.json');
const DEFAULT_FRAME_DRAGGING_COMPARE_PATH = path.join(
  EXTERNAL_WORK_DIR,
  'external-work-compare-ext-gr-fd-001-latest.json',
);
const DEFAULT_FRAME_DRAGGING_RUN_PATH = path.join(
  EXTERNAL_WORK_DIR,
  'external-work-run-ext-gr-fd-001-latest.json',
);
const DEFAULT_SHAPIRO_COMPARE_PATH = path.join(
  EXTERNAL_WORK_DIR,
  'external-work-compare-ext-gr-shap-001-latest.json',
);
const DEFAULT_SHAPIRO_RUN_PATH = path.join(EXTERNAL_WORK_DIR, 'external-work-run-ext-gr-shap-001-latest.json');
const DEFAULT_TRACE_OUT = path.join('artifacts', 'training-trace.jsonl');
const DEFAULT_TRACE_EXPORT_OUT = path.join('artifacts', 'training-trace-export.jsonl');
const DEFAULT_ADAPTER_URL = 'http://127.0.0.1:5050/api/agi/adapter/run';
const DEFAULT_TRACE_EXPORT_URL = 'http://127.0.0.1:5050/api/agi/training-trace/export';

const EXPECTED_CANONICAL_COUNTS = {
  PASS: 8,
  FAIL: 0,
  UNKNOWN: 0,
  NOT_READY: 0,
  NOT_APPLICABLE: 1,
};

const REQUIRED_GEOMETRY_CHECKS = [
  'metric_form_alignment',
  'shift_mapping',
  'york_time_sign_parity',
  'natario_control_behavior',
  'metric_derived_t00_path',
] as const;

const ALLOWED_REDUCED_REASON_CODES = new Set([
  'non_comparable_or_unknown',
  'domain_mismatch',
  'assumption_domain_non_comparable',
  'missing_snapshot_field',
  'missing_equation_anchor',
  'missing_method_track_plugin',
  'run_artifact_missing',
  'stale_run_commit_pin',
  'compare_artifact_missing',
  'missing_external_value',
  'missing_local_value',
]);

type StepRecord = {
  id: string;
  command: string;
  status: 'pass';
};

type Blocker = {
  code: string;
  detail: string;
  path: string | null;
};

type CanonicalCounts = {
  PASS: number;
  FAIL: number;
  UNKNOWN: number;
  NOT_READY: number;
  NOT_APPLICABLE: number;
};

type CasimirVerifyResponse = {
  traceId?: string;
  runId?: string | number;
  verdict?: string;
  pass?: boolean;
  firstFail?: unknown;
  certificate?: {
    status?: string;
    certificateHash?: string | null;
    integrityOk?: boolean;
  } | null;
};

const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const normalizePath = (filePath: string): string => filePath.replace(/\\/g, '/');

const resolvePathFromRoot = (filePath: string, cwd = process.cwd()): string =>
  path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);

const ensureDirForFile = (filePath: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const readJson = (filePath: string): any => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const listFiles = (dirPath: string): string[] => {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
};

const findLatestByRegex = (dirPath: string, regex: RegExp): string | null => {
  const candidates = listFiles(dirPath).filter((entry) => regex.test(entry));
  if (candidates.length === 0) return null;
  const ranked = candidates
    .map((entry) => {
      const fullPath = path.join(dirPath, entry);
      const stat = fs.statSync(fullPath);
      return { fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return ranked[0]?.fullPath ?? null;
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
    for (const key of Object.keys(source).sort()) {
      out[key] = objectWithSortedKeys(source[key]);
    }
    return out;
  }
  return value;
};

const checksumPayload = (payload: Record<string, unknown>, skipKeys: string[] = []): string => {
  const volatileKeys = new Set([
    'generated_at',
    'checksum',
    'traceId',
    'runId',
    'capsule_checksum',
    'durationMs',
    'elapsedMs',
    ...skipKeys,
  ]);
  const stripVolatile = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const sanitizedEntries = value.map((entry) => stripVolatile(entry));
      return sanitizedEntries.sort((left, right) => {
        const leftKey = JSON.stringify(objectWithSortedKeys(left));
        const rightKey = JSON.stringify(objectWithSortedKeys(right));
        return leftKey.localeCompare(rightKey);
      });
    }
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
  const sanitized = stripVolatile(JSON.parse(JSON.stringify(payload))) as Record<string, unknown>;
  const canonical = JSON.stringify(objectWithSortedKeys(sanitized));
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

const resolveSourceState = (): SourceState => {
  const statusOutput = execSync('git status --porcelain', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const normalizedStatus = statusOutput
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .sort()
    .join('\n');
  if (!normalizedStatus) {
    return {
      workspace_dirty: false,
      status_fingerprint: null,
    };
  }
  return {
    workspace_dirty: true,
    status_fingerprint: crypto.createHash('sha256').update(normalizedStatus).digest('hex'),
  };
};

const parseCounts = (value: unknown): CanonicalCounts => {
  const source = (value ?? {}) as Record<string, unknown>;
  return {
    PASS: asNumber(source.PASS) ?? 0,
    FAIL: asNumber(source.FAIL) ?? 0,
    UNKNOWN: asNumber(source.UNKNOWN) ?? 0,
    NOT_READY: asNumber(source.NOT_READY) ?? 0,
    NOT_APPLICABLE: asNumber(source.NOT_APPLICABLE) ?? 0,
  };
};

type SourceState = {
  workspace_dirty: boolean;
  status_fingerprint: string | null;
};

const countsEqual = (left: CanonicalCounts, right: CanonicalCounts): boolean =>
  left.PASS === right.PASS &&
  left.FAIL === right.FAIL &&
  left.UNKNOWN === right.UNKNOWN &&
  left.NOT_READY === right.NOT_READY &&
  left.NOT_APPLICABLE === right.NOT_APPLICABLE;

const runCommand = (command: string, args: string[], capture = false): SpawnSyncReturns<string> => {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
  });
};

const runNpm = (args: string[], steps: StepRecord[], stepId: string) => {
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  const result = runCommand(npmCommand, commandArgs, false);
  if (result.status !== 0) {
    throw new Error(`Command failed: npm ${args.join(' ')} (exit=${String(result.status)})`);
  }
  steps.push({
    id: stepId,
    command: `npm ${args.join(' ')}`,
    status: 'pass',
  });
};

const parseJsonFromText = (text: string): any => {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Expected JSON output, got empty text.');
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
    throw new Error(`Unable to parse JSON output: ${trimmed.slice(0, 200)}`);
  }
};

const runCasimirVerify = (
  adapterUrl: string,
  traceOutPath: string,
  steps: StepRecord[],
): CasimirVerifyResponse => {
  const args = [
    'run',
    'casimir:verify',
    '--',
    '--ci',
    '--url',
    adapterUrl,
    '--trace-out',
    traceOutPath,
  ];
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  const result = runCommand(npmCommand, commandArgs, true);
  if (result.status !== 0) {
    const errorMessage = result.error?.message ? `error=${result.error.message}` : 'no error message';
    const stderr = (result.stderr ?? '').toString().trim();
    throw new Error(
      `Casimir verify failed (exit=${String(result.status)};${errorMessage}): ${stderr || 'no stderr'}`,
    );
  }
  const response = parseJsonFromText(result.stdout ?? '') as CasimirVerifyResponse;
  steps.push({
    id: 'casimir_verify',
    command: `npm ${args.join(' ')}`,
    status: 'pass',
  });
  return response;
};

const exportTrainingTrace = async (url: string, outPath: string, steps: StepRecord[]) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Training trace export failed: HTTP ${response.status}`);
  }
  const body = await response.text();
  ensureDirForFile(outPath);
  fs.writeFileSync(outPath, body);
  steps.push({
    id: 'casimir_trace_export',
    command: `GET ${url} -> ${normalizePath(outPath)}`,
    status: 'pass',
  });
};

const summarizeReasonCodes = (matrixPayload: any) => {
  const works = Array.isArray(matrixPayload?.works) ? matrixPayload.works : [];
  const violations: Array<{ work_id: string; reason: string }> = [];
  for (const work of works) {
    const status = asText(work?.status) ?? 'inconclusive';
    if (status !== 'partial' && status !== 'inconclusive') continue;
    const reasonCodes = Array.isArray(work?.reason_codes) ? work.reason_codes.map(String) : [];
    const reducedReasonCodes = Array.isArray(work?.reduced_reason_codes)
      ? work.reduced_reason_codes.map(String)
      : [];
    if (reasonCodes.length === 0) {
      violations.push({
        work_id: String(work?.work_id ?? 'UNKNOWN_WORK'),
        reason: 'missing_reason_codes',
      });
      continue;
    }
    if (reducedReasonCodes.length === 0) {
      violations.push({
        work_id: String(work?.work_id ?? 'UNKNOWN_WORK'),
        reason: 'missing_reduced_reason_codes',
      });
      continue;
    }
    const disallowed = reducedReasonCodes.filter((code) => !ALLOWED_REDUCED_REASON_CODES.has(code));
    if (disallowed.length > 0) {
      violations.push({
        work_id: String(work?.work_id ?? 'UNKNOWN_WORK'),
        reason: `reduced_reason_code_not_allowed:${disallowed.join(',')}`,
      });
    }
  }
  return {
    works,
    violations,
    reasonCounts: (matrixPayload?.reduced_reason_counts ?? {}) as Record<string, number>,
  };
};

const renderMarkdown = (payload: any): string => {
  const blockers = Array.isArray(payload.blockers) ? payload.blockers : [];
  const blockerRows =
    blockers.length > 0
      ? blockers
          .map((entry: any) => `| ${entry.code} | ${entry.path ?? 'n/a'} | ${entry.detail} |`)
          .join('\n')
      : '| none | n/a | none |';

  const geometryRows = Array.isArray(payload.geometry?.checks)
    ? payload.geometry.checks.map((entry: any) => `| ${entry.id} | ${entry.status} | ${entry.testFile ?? 'n/a'} |`).join('\n')
    : '';
  const geometryRowsSafe = geometryRows.length > 0 ? geometryRows : '| none | unknown | n/a |';

  const externalRows = Array.isArray(payload.external_work?.works)
    ? payload.external_work.works
        .map(
          (entry: any) =>
            `| ${entry.work_id} | ${entry.status} | ${entry.pass_count ?? 0} | ${entry.fail_count ?? 0} | ${
              entry.inconclusive_count ?? 0
            } | ${entry.stale_run_vs_capsule === true ? 'true' : 'false'} |`,
        )
        .join('\n')
    : '';
  const externalRowsSafe = externalRows.length > 0 ? externalRows : '| none | n/a | 0 | 0 | 0 | false |';

  const stepRows = Array.isArray(payload.steps)
    ? payload.steps.map((entry: any) => `| ${entry.id} | ${entry.command} | ${entry.status} |`).join('\n')
    : '';
  const stepRowsSafe = stepRows.length > 0 ? stepRows : '| none | n/a | unknown |';

  return `# Warp Integrity Parity Suite (${payload.generated_on})

"${payload.boundary_statement}"

## Result
- artifact_type: \`${payload.artifact_type}\`
- commit_pin: \`${payload.commit_pin}\`
- checksum: \`${payload.checksum}\`
- final_parity_verdict: \`${payload.final_parity_verdict}\`
- blocker_count: \`${payload.blocker_count}\`

## Rubric
- canonical_decision_ok: \`${payload.rubric?.canonical_decision?.pass === true}\`
- canonical_count_shape_ok: \`${payload.rubric?.canonical_count_shape?.pass === true}\`
- geometry_baseline_ok: \`${payload.rubric?.geometry_baseline?.pass === true}\`
- mercury_observable_ok: \`${payload.rubric?.mercury_observable?.pass === true}\`
- lensing_observable_ok: \`${payload.rubric?.lensing_observable?.pass === true}\`
- frame_dragging_observable_ok: \`${payload.rubric?.frame_dragging_observable?.pass === true}\`
- shapiro_observable_ok: \`${payload.rubric?.shapiro_observable?.pass === true}\`
- external_stale_ok: \`${payload.rubric?.external_staleness?.pass === true}\`
- external_reason_taxonomy_ok: \`${payload.rubric?.external_reason_taxonomy?.pass === true}\`
- capsule_validate_ok: \`${payload.rubric?.capsule_validation?.pass === true}\`
- casimir_verify_ok: \`${payload.rubric?.casimir_verification?.pass === true}\`

## Canonical Summary
- decision: \`${payload.canonical?.decision ?? 'UNKNOWN'}\`
- counts: \`PASS=${payload.canonical?.counts?.PASS ?? 0}, FAIL=${payload.canonical?.counts?.FAIL ?? 0}, UNKNOWN=${
    payload.canonical?.counts?.UNKNOWN ?? 0
  }, NOT_READY=${payload.canonical?.counts?.NOT_READY ?? 0}, NOT_APPLICABLE=${
    payload.canonical?.counts?.NOT_APPLICABLE ?? 0
  }\`
- expected_counts: \`PASS=${payload.canonical?.expected_counts?.PASS ?? 0}, FAIL=${
    payload.canonical?.expected_counts?.FAIL ?? 0
  }, UNKNOWN=${payload.canonical?.expected_counts?.UNKNOWN ?? 0}, NOT_READY=${
    payload.canonical?.expected_counts?.NOT_READY ?? 0
  }, NOT_APPLICABLE=${payload.canonical?.expected_counts?.NOT_APPLICABLE ?? 0}\`

## Geometry Baseline Checks
| check | status | test_file |
|---|---|---|
${geometryRowsSafe}

## Mercury Observable Parity
- compare_status: \`${payload.mercury?.compare_status ?? 'unknown'}\`
- signature_status: \`${payload.mercury?.signature_status ?? 'unknown'}\`
- residual_arcsec_per_century: \`${payload.mercury?.residual_arcsec_per_century ?? 'UNKNOWN'}\`
- tolerance_arcsec_per_century: \`${payload.mercury?.tolerance_arcsec_per_century ?? 'UNKNOWN'}\`

## Lensing Observable Parity
- compare_status: \`${payload.lensing?.compare_status ?? 'unknown'}\`
- signature_status: \`${payload.lensing?.signature_status ?? 'unknown'}\`
- historical_residual_arcsec: \`${payload.lensing?.historical_residual_arcsec ?? 'UNKNOWN'}\`
- historical_tolerance_arcsec: \`${payload.lensing?.historical_tolerance_arcsec ?? 'UNKNOWN'}\`
- gamma_residual: \`${payload.lensing?.gamma_residual ?? 'UNKNOWN'}\`
- gamma_tolerance: \`${payload.lensing?.gamma_tolerance ?? 'UNKNOWN'}\`

## Frame-Dragging Observable Parity
- compare_status: \`${payload.frame_dragging?.compare_status ?? 'unknown'}\`
- signature_status: \`${payload.frame_dragging?.signature_status ?? 'unknown'}\`
- gpb_residual_mas_per_year: \`${payload.frame_dragging?.gpb_residual_mas_per_year ?? 'UNKNOWN'}\`
- gpb_tolerance_mas_per_year: \`${payload.frame_dragging?.gpb_tolerance_mas_per_year ?? 'UNKNOWN'}\`
- lageos_residual_ratio: \`${payload.frame_dragging?.lageos_residual_ratio ?? 'UNKNOWN'}\`
- lageos_tolerance_ratio: \`${payload.frame_dragging?.lageos_tolerance_ratio ?? 'UNKNOWN'}\`

## Shapiro Observable Parity
- compare_status: \`${payload.shapiro?.compare_status ?? 'unknown'}\`
- signature_status: \`${payload.shapiro?.signature_status ?? 'unknown'}\`
- gamma_residual: \`${payload.shapiro?.gamma_residual ?? 'UNKNOWN'}\`
- gamma_tolerance: \`${payload.shapiro?.gamma_tolerance ?? 'UNKNOWN'}\`

## External Work Matrix
- total: \`${payload.external_work?.summary_counts?.total ?? 0}\`
- compatible: \`${payload.external_work?.summary_counts?.compatible ?? 0}\`
- partial: \`${payload.external_work?.summary_counts?.partial ?? 0}\`
- inconclusive: \`${payload.external_work?.summary_counts?.inconclusive ?? 0}\`
- stale_count: \`${payload.external_work?.stale_count ?? 0}\`

| work_id | status | pass | fail | inconclusive | stale |
|---|---|---:|---:|---:|---|
${externalRowsSafe}

## Casimir Certificate
- verdict: \`${payload.casimir?.verdict ?? 'UNKNOWN'}\`
- firstFail: \`${payload.casimir?.firstFail ?? 'null'}\`
- traceId: \`${payload.casimir?.traceId ?? 'UNKNOWN'}\`
- runId: \`${payload.casimir?.runId ?? 'UNKNOWN'}\`
- certificateHash: \`${payload.casimir?.certificateHash ?? 'UNKNOWN'}\`
- integrityOk: \`${payload.casimir?.integrityOk === true}\`
- status: \`${payload.casimir?.status ?? 'UNKNOWN'}\`

## Repeatability
- same_commit_prior_found: \`${payload.repeatability?.same_commit_prior_found === true}\`
- matches_prior_checksum: \`${payload.repeatability?.matches_prior_checksum === true}\`
- prior_checksum: \`${payload.repeatability?.prior_checksum ?? 'none'}\`

## Executed Steps
| id | command | status |
|---|---|---|
${stepRowsSafe}

## Blockers
| code | path | detail |
|---|---|---|
${blockerRows}
`;
};

export const runIntegrityParitySuite = async (options: {
  outJsonPath?: string;
  outMdPath?: string;
  latestJsonPath?: string;
  latestMdPath?: string;
  adapterUrl?: string;
  traceExportUrl?: string;
  traceOutPath?: string;
  traceExportOutPath?: string;
}) => {
  const outJsonPath = options.outJsonPath ?? DEFAULT_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_OUT_MD;
  const latestJsonPath = options.latestJsonPath ?? DEFAULT_LATEST_JSON;
  const latestMdPath = options.latestMdPath ?? DEFAULT_LATEST_MD;
  const adapterUrl = options.adapterUrl ?? DEFAULT_ADAPTER_URL;
  const traceExportUrl = options.traceExportUrl ?? DEFAULT_TRACE_EXPORT_URL;
  const traceOutPath = options.traceOutPath ?? DEFAULT_TRACE_OUT;
  const traceExportOutPath = options.traceExportOutPath ?? DEFAULT_TRACE_EXPORT_OUT;

  const steps: StepRecord[] = [];
  const blockers: Blocker[] = [];
  const addBlocker = (code: string, detail: string, blockerPath: string | null = null) => {
    blockers.push({ code, detail, path: blockerPath ? normalizePath(blockerPath) : null });
  };

  // Integrity parity is reduced-order and reference-only; use canonical campaign
  // reconciliation instead of strong-claim bundle closure.
  runNpm(['run', 'warp:full-solve:canonical'], steps, 'canonical_reconciliation');
  runNpm(['run', 'warp:full-solve:geometry:conformance'], steps, 'geometry_conformance');
  runNpm(['run', 'warp:external:refresh'], steps, 'external_refresh');
  runNpm(['run', 'warp:external:run', '--', '--work-id', 'EXT-GR-MERC-001'], steps, 'mercury_external_run');
  runNpm(['run', 'warp:external:compare', '--', '--work-id', 'EXT-GR-MERC-001'], steps, 'mercury_external_compare');
  runNpm(['run', 'warp:external:run', '--', '--work-id', 'EXT-GR-LENS-001'], steps, 'lensing_external_run');
  runNpm(['run', 'warp:external:compare', '--', '--work-id', 'EXT-GR-LENS-001'], steps, 'lensing_external_compare');
  runNpm(
    ['run', 'warp:external:run', '--', '--work-id', 'EXT-GR-FD-001'],
    steps,
    'frame_dragging_external_run',
  );
  runNpm(
    ['run', 'warp:external:compare', '--', '--work-id', 'EXT-GR-FD-001'],
    steps,
    'frame_dragging_external_compare',
  );
  runNpm(['run', 'warp:external:run', '--', '--work-id', 'EXT-GR-SHAP-001'], steps, 'shapiro_external_run');
  runNpm(
    ['run', 'warp:external:compare', '--', '--work-id', 'EXT-GR-SHAP-001'],
    steps,
    'shapiro_external_compare',
  );
  runNpm(['run', 'warp:external:matrix'], steps, 'external_matrix');
  runNpm(['run', 'warp:full-solve:reference:capsule'], steps, 'reference_capsule');
  runNpm(
    [
      'run',
      'warp:full-solve:reference:validate',
      '--',
      '--capsule',
      'artifacts/research/full-solve/full-solve-reference-capsule-latest.json',
    ],
    steps,
    'reference_capsule_validate',
  );

  const casimirVerifyResponse = runCasimirVerify(adapterUrl, traceOutPath, steps);
  await exportTrainingTrace(traceExportUrl, traceExportOutPath, steps);

  const commitPin = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const sourceState = resolveSourceState();
  const decisionLedgerPath = findLatestByRegex(FULL_SOLVE_DIR, /^g4-decision-ledger-\d{4}-\d{2}-\d{2}\.json$/);
  const geometryPath = findLatestByRegex(FULL_SOLVE_DIR, /^geometry-conformance-\d{4}-\d{2}-\d{2}\.json$/);
  const capsuleValidatePath = findLatestByRegex(
    FULL_SOLVE_DIR,
    /^full-solve-reference-capsule-validate-\d{4}-\d{2}-\d{2}\.json$/,
  );

  const capsulePath = resolvePathFromRoot(DEFAULT_CAPSULE_PATH);
  const externalMatrixPath = resolvePathFromRoot(DEFAULT_EXTERNAL_MATRIX_PATH);
  const mercuryComparePath = resolvePathFromRoot(DEFAULT_MERCURY_COMPARE_PATH);
  const mercuryRunPath = resolvePathFromRoot(DEFAULT_MERCURY_RUN_PATH);
  const lensingComparePath = resolvePathFromRoot(DEFAULT_LENSING_COMPARE_PATH);
  const lensingRunPath = resolvePathFromRoot(DEFAULT_LENSING_RUN_PATH);
  const frameDraggingComparePath = resolvePathFromRoot(DEFAULT_FRAME_DRAGGING_COMPARE_PATH);
  const frameDraggingRunPath = resolvePathFromRoot(DEFAULT_FRAME_DRAGGING_RUN_PATH);
  const shapiroComparePath = resolvePathFromRoot(DEFAULT_SHAPIRO_COMPARE_PATH);
  const shapiroRunPath = resolvePathFromRoot(DEFAULT_SHAPIRO_RUN_PATH);

  if (!decisionLedgerPath || !fs.existsSync(decisionLedgerPath)) {
    throw new Error('Missing decision ledger artifact after canonical bundle.');
  }
  if (!geometryPath || !fs.existsSync(geometryPath)) {
    throw new Error('Missing geometry conformance artifact after geometry run.');
  }
  if (!fs.existsSync(externalMatrixPath)) {
    throw new Error('Missing external matrix latest artifact after external refresh.');
  }
  if (!fs.existsSync(mercuryComparePath)) {
    throw new Error('Missing Mercury compare latest artifact.');
  }
  if (!fs.existsSync(mercuryRunPath)) {
    throw new Error('Missing Mercury run latest artifact.');
  }
  if (!fs.existsSync(lensingComparePath)) {
    throw new Error('Missing lensing compare latest artifact.');
  }
  if (!fs.existsSync(lensingRunPath)) {
    throw new Error('Missing lensing run latest artifact.');
  }
  if (!fs.existsSync(frameDraggingComparePath)) {
    throw new Error('Missing frame-dragging compare latest artifact.');
  }
  if (!fs.existsSync(frameDraggingRunPath)) {
    throw new Error('Missing frame-dragging run latest artifact.');
  }
  if (!fs.existsSync(shapiroComparePath)) {
    throw new Error('Missing Shapiro compare latest artifact.');
  }
  if (!fs.existsSync(shapiroRunPath)) {
    throw new Error('Missing Shapiro run latest artifact.');
  }
  if (!fs.existsSync(capsulePath)) {
    throw new Error('Missing full-solve reference capsule latest artifact.');
  }

  const decisionLedger = readJson(decisionLedgerPath);
  const geometry = readJson(geometryPath);
  const externalMatrix = readJson(externalMatrixPath);
  const mercuryCompare = readJson(mercuryComparePath);
  const mercuryRun = readJson(mercuryRunPath);
  const lensingCompare = readJson(lensingComparePath);
  const lensingRun = readJson(lensingRunPath);
  const frameDraggingCompare = readJson(frameDraggingComparePath);
  const frameDraggingRun = readJson(frameDraggingRunPath);
  const shapiroCompare = readJson(shapiroComparePath);
  const shapiroRun = readJson(shapiroRunPath);
  const capsule = readJson(capsulePath);
  const capsuleValidate = capsuleValidatePath && fs.existsSync(capsuleValidatePath) ? readJson(capsuleValidatePath) : null;

  const canonicalDecision = asText(decisionLedger?.canonical?.decision) ?? 'UNKNOWN';
  const canonicalCounts = parseCounts(decisionLedger?.canonical?.counts);
  const canonicalDecisionPass = canonicalDecision === 'REDUCED_ORDER_ADMISSIBLE';
  const canonicalCountShapePass = countsEqual(canonicalCounts, EXPECTED_CANONICAL_COUNTS);
  if (!canonicalDecisionPass) {
    addBlocker(
      'canonical_decision_mismatch',
      `Expected REDUCED_ORDER_ADMISSIBLE, got ${canonicalDecision}`,
      decisionLedgerPath,
    );
  }
  if (!canonicalCountShapePass) {
    addBlocker(
      'canonical_count_shape_mismatch',
      `Expected ${JSON.stringify(EXPECTED_CANONICAL_COUNTS)}, got ${JSON.stringify(canonicalCounts)}`,
      decisionLedgerPath,
    );
  }

  const geometryChecks = Array.isArray(geometry?.checks) ? geometry.checks : [];
  const geometryCheckMap = new Map<string, string>();
  for (const check of geometryChecks) {
    const id = asText(check?.id);
    if (!id) continue;
    geometryCheckMap.set(id, asText(check?.status) ?? 'unknown');
  }
  const missingGeometry = REQUIRED_GEOMETRY_CHECKS.filter((id) => !geometryCheckMap.has(id));
  const failedGeometry = REQUIRED_GEOMETRY_CHECKS.filter((id) => geometryCheckMap.get(id) !== 'pass');
  const geometrySummaryAllPass = geometry?.summary?.allPass === true;
  const geometryPass = missingGeometry.length === 0 && failedGeometry.length === 0 && geometrySummaryAllPass;
  if (!geometryPass) {
    addBlocker(
      'geometry_conformance_failed',
      `missing=[${missingGeometry.join(',')}] failed=[${failedGeometry.join(',')}] allPass=${String(geometrySummaryAllPass)}`,
      geometryPath,
    );
  }

  const mercuryCompareStatus = asText(mercuryCompare?.summary?.status) ?? 'inconclusive';
  const mercurySignatureStatus =
    asText(mercuryRun?.method_track?.extracted?.['gr_observable_signature.mercury_perihelion_precession.status']) ?? 'unknown';
  const mercuryResidual = asNumber(
    mercuryRun?.method_track?.extracted?.['gr_observable_signature.mercury_perihelion_precession.residual_arcsec_per_century'],
  );
  const mercuryMethodOutPath = asText(mercuryRun?.method_track?.artifacts?.out_json);
  const mercuryMethodPayload =
    mercuryMethodOutPath != null && fs.existsSync(resolvePathFromRoot(mercuryMethodOutPath))
      ? readJson(resolvePathFromRoot(mercuryMethodOutPath))
      : null;
  const mercuryTolerance = asNumber(
    mercuryMethodPayload?.gr_observable_signature?.mercury_perihelion_precession?.max_abs_residual_arcsec_per_century,
  );
  const mercuryResidualPass = mercuryResidual != null && mercuryTolerance != null ? Math.abs(mercuryResidual) <= mercuryTolerance : false;
  const mercuryPass =
    mercuryCompareStatus === 'compatible' && mercurySignatureStatus === 'pass' && mercuryResidualPass;
  if (!mercuryPass) {
    addBlocker(
      'mercury_parity_mismatch',
      `compare=${mercuryCompareStatus} signature=${mercurySignatureStatus} residual=${String(
        mercuryResidual,
      )} tolerance=${String(mercuryTolerance)}`,
      mercuryComparePath,
    );
  }

  const lensingCompareStatus = asText(lensingCompare?.summary?.status) ?? 'inconclusive';
  const lensingSignatureStatus =
    asText(lensingRun?.method_track?.extracted?.['gr_observable_signature.lensing_deflection.status']) ?? 'unknown';
  const lensingHistoricalResidual = asNumber(
    lensingRun?.method_track?.extracted?.['gr_observable_signature.lensing_deflection.historical_residual_arcsec'],
  );
  const lensingGammaResidual = asNumber(
    lensingRun?.method_track?.extracted?.['gr_observable_signature.lensing_deflection.modern_gamma_residual'],
  );
  const lensingMethodOutPath = asText(lensingRun?.method_track?.artifacts?.out_json);
  const lensingMethodPayload =
    lensingMethodOutPath != null && fs.existsSync(resolvePathFromRoot(lensingMethodOutPath))
      ? readJson(resolvePathFromRoot(lensingMethodOutPath))
      : null;
  const lensingHistoricalTolerance = asNumber(
    lensingMethodPayload?.gr_observable_signature?.lensing_deflection?.max_abs_historical_residual_arcsec,
  );
  const lensingGammaTolerance = asNumber(
    lensingMethodPayload?.gr_observable_signature?.lensing_deflection?.max_abs_gamma_residual,
  );
  const lensingHistoricalPass =
    lensingHistoricalResidual != null && lensingHistoricalTolerance != null
      ? Math.abs(lensingHistoricalResidual) <= lensingHistoricalTolerance
      : false;
  const lensingGammaPass =
    lensingGammaResidual != null && lensingGammaTolerance != null
      ? Math.abs(lensingGammaResidual) <= lensingGammaTolerance
      : false;
  const lensingPass =
    lensingCompareStatus === 'compatible' &&
    lensingSignatureStatus === 'pass' &&
    lensingHistoricalPass &&
    lensingGammaPass;
  if (!lensingPass) {
    addBlocker(
      'lensing_parity_mismatch',
      `compare=${lensingCompareStatus} signature=${lensingSignatureStatus} historicalResidual=${String(
        lensingHistoricalResidual,
      )} historicalTol=${String(lensingHistoricalTolerance)} gammaResidual=${String(
        lensingGammaResidual,
      )} gammaTol=${String(lensingGammaTolerance)}`,
      lensingComparePath,
    );
  }

  const frameDraggingCompareStatus = asText(frameDraggingCompare?.summary?.status) ?? 'inconclusive';
  const frameDraggingSignatureStatus =
    asText(frameDraggingRun?.method_track?.extracted?.['gr_observable_signature.frame_dragging.status']) ?? 'unknown';
  const frameDraggingGpbResidual = asNumber(
    frameDraggingRun?.method_track?.extracted?.['gr_observable_signature.frame_dragging.gpb_residual_mas_per_year'],
  );
  const frameDraggingLageosResidual = asNumber(
    frameDraggingRun?.method_track?.extracted?.['gr_observable_signature.frame_dragging.lageos_residual_ratio'],
  );
  const frameDraggingMethodOutPath = asText(frameDraggingRun?.method_track?.artifacts?.out_json);
  const frameDraggingMethodPayload =
    frameDraggingMethodOutPath != null && fs.existsSync(resolvePathFromRoot(frameDraggingMethodOutPath))
      ? readJson(resolvePathFromRoot(frameDraggingMethodOutPath))
      : null;
  const frameDraggingGpbTolerance = asNumber(
    frameDraggingMethodPayload?.gr_observable_signature?.frame_dragging?.max_abs_gpb_residual_mas_per_year,
  );
  const frameDraggingLageosTolerance = asNumber(
    frameDraggingMethodPayload?.gr_observable_signature?.frame_dragging?.max_abs_lageos_ratio_residual,
  );
  const frameDraggingGpbPass =
    frameDraggingGpbResidual != null && frameDraggingGpbTolerance != null
      ? Math.abs(frameDraggingGpbResidual) <= frameDraggingGpbTolerance
      : false;
  const frameDraggingLageosPass =
    frameDraggingLageosResidual != null && frameDraggingLageosTolerance != null
      ? Math.abs(frameDraggingLageosResidual) <= frameDraggingLageosTolerance
      : false;
  const frameDraggingPass =
    frameDraggingCompareStatus === 'compatible' &&
    frameDraggingSignatureStatus === 'pass' &&
    frameDraggingGpbPass &&
    frameDraggingLageosPass;
  if (!frameDraggingPass) {
    addBlocker(
      'frame_dragging_parity_mismatch',
      `compare=${frameDraggingCompareStatus} signature=${frameDraggingSignatureStatus} gpbResidual=${String(
        frameDraggingGpbResidual,
      )} gpbTol=${String(frameDraggingGpbTolerance)} lageosResidual=${String(
        frameDraggingLageosResidual,
      )} lageosTol=${String(frameDraggingLageosTolerance)}`,
      frameDraggingComparePath,
    );
  }

  const shapiroCompareStatus = asText(shapiroCompare?.summary?.status) ?? 'inconclusive';
  const shapiroSignatureStatus =
    asText(shapiroRun?.method_track?.extracted?.['gr_observable_signature.shapiro_delay.status']) ?? 'unknown';
  const shapiroGammaResidual = asNumber(
    shapiroRun?.method_track?.extracted?.['gr_observable_signature.shapiro_delay.gamma_residual'],
  );
  const shapiroMethodOutPath = asText(shapiroRun?.method_track?.artifacts?.out_json);
  const shapiroMethodPayload =
    shapiroMethodOutPath != null && fs.existsSync(resolvePathFromRoot(shapiroMethodOutPath))
      ? readJson(resolvePathFromRoot(shapiroMethodOutPath))
      : null;
  const shapiroGammaTolerance = asNumber(
    shapiroMethodPayload?.gr_observable_signature?.shapiro_delay?.max_abs_gamma_minus_one,
  );
  const shapiroResidualPass =
    shapiroGammaResidual != null && shapiroGammaTolerance != null
      ? Math.abs(shapiroGammaResidual) <= shapiroGammaTolerance
      : false;
  const shapiroPass =
    shapiroCompareStatus === 'compatible' && shapiroSignatureStatus === 'pass' && shapiroResidualPass;
  if (!shapiroPass) {
    addBlocker(
      'shapiro_parity_mismatch',
      `compare=${shapiroCompareStatus} signature=${shapiroSignatureStatus} residual=${String(
        shapiroGammaResidual,
      )} tolerance=${String(shapiroGammaTolerance)}`,
      shapiroComparePath,
    );
  }

  const staleCount = asNumber(externalMatrix?.stale_flags?.stale_count) ?? 0;
  const externalStalePass = staleCount === 0;
  if (!externalStalePass) {
    addBlocker('external_matrix_stale_count_nonzero', `Expected stale_count=0, got ${String(staleCount)}`, externalMatrixPath);
  }

  const reasonSummary = summarizeReasonCodes(externalMatrix);
  const reasonTaxonomyPass = reasonSummary.violations.length === 0;
  if (!reasonTaxonomyPass) {
    for (const violation of reasonSummary.violations) {
      addBlocker(
        'external_reason_taxonomy_violation',
        `${violation.work_id}:${violation.reason}`,
        externalMatrixPath,
      );
    }
  }

  const capsuleValidationPass = capsuleValidate?.pass === true;
  if (!capsuleValidationPass) {
    addBlocker(
      'reference_capsule_validation_failed',
      `Validation pass=${String(capsuleValidate?.pass)} issues=${String(capsuleValidate?.summary?.issueCount ?? 'unknown')}`,
      capsuleValidatePath,
    );
  }

  const casimirVerdict = asText(casimirVerifyResponse?.verdict) ?? (casimirVerifyResponse?.pass === true ? 'PASS' : 'FAIL');
  const casimirFirstFail = casimirVerifyResponse?.firstFail ?? null;
  const casimirTraceId = asText(casimirVerifyResponse?.traceId);
  const casimirRunId = asText(casimirVerifyResponse?.runId);
  const casimirCertificateHash = asText(casimirVerifyResponse?.certificate?.certificateHash);
  const casimirIntegrityOk = casimirVerifyResponse?.certificate?.integrityOk === true;
  const casimirStatus = asText(casimirVerifyResponse?.certificate?.status);
  const casimirPass = casimirVerdict === 'PASS' && casimirIntegrityOk && Boolean(casimirCertificateHash);
  if (!casimirPass) {
    addBlocker(
      'casimir_verify_not_pass',
      `verdict=${casimirVerdict} integrityOk=${String(casimirIntegrityOk)} certificateHash=${String(casimirCertificateHash)}`,
      adapterUrl,
    );
  }

  const priorLatest = fs.existsSync(resolvePathFromRoot(latestJsonPath))
    ? readJson(resolvePathFromRoot(latestJsonPath))
    : null;

  const payloadBase: Record<string, unknown> = {
    artifact_type: 'integrity_parity_suite/v1',
    generator_version: GENERATOR_VERSION,
    generated_on: DATE_STAMP,
    generated_at: new Date().toISOString(),
    boundary_statement: BOUNDARY_STATEMENT,
    commit_pin: commitPin,
    source_state: sourceState,
    capsule_checksum: asText(capsule?.checksum),
    capsule_path: normalizePath(DEFAULT_CAPSULE_PATH),
    canonical: {
      decision: canonicalDecision,
      counts: canonicalCounts,
      expected_counts: EXPECTED_CANONICAL_COUNTS,
      decision_ledger_path: normalizePath(decisionLedgerPath),
    },
    geometry: {
      path: normalizePath(geometryPath),
      summary: geometry?.summary ?? {},
      checks: geometryChecks,
      required_checks: REQUIRED_GEOMETRY_CHECKS,
    },
    external_work: {
      path: normalizePath(DEFAULT_EXTERNAL_MATRIX_PATH),
      summary_counts: externalMatrix?.summary_counts ?? {},
      stale_count: staleCount,
      reduced_reason_counts: reasonSummary.reasonCounts,
      works: reasonSummary.works,
      reason_taxonomy_violations: reasonSummary.violations,
    },
    mercury: {
      compare_path: normalizePath(DEFAULT_MERCURY_COMPARE_PATH),
      run_path: normalizePath(DEFAULT_MERCURY_RUN_PATH),
      method_out_path: mercuryMethodOutPath ? normalizePath(mercuryMethodOutPath) : null,
      compare_status: mercuryCompareStatus,
      signature_status: mercurySignatureStatus,
      residual_arcsec_per_century: mercuryResidual,
      tolerance_arcsec_per_century: mercuryTolerance,
    },
    lensing: {
      compare_path: normalizePath(DEFAULT_LENSING_COMPARE_PATH),
      run_path: normalizePath(DEFAULT_LENSING_RUN_PATH),
      method_out_path: lensingMethodOutPath ? normalizePath(lensingMethodOutPath) : null,
      compare_status: lensingCompareStatus,
      signature_status: lensingSignatureStatus,
      historical_residual_arcsec: lensingHistoricalResidual,
      historical_tolerance_arcsec: lensingHistoricalTolerance,
      gamma_residual: lensingGammaResidual,
      gamma_tolerance: lensingGammaTolerance,
    },
    frame_dragging: {
      compare_path: normalizePath(DEFAULT_FRAME_DRAGGING_COMPARE_PATH),
      run_path: normalizePath(DEFAULT_FRAME_DRAGGING_RUN_PATH),
      method_out_path: frameDraggingMethodOutPath ? normalizePath(frameDraggingMethodOutPath) : null,
      compare_status: frameDraggingCompareStatus,
      signature_status: frameDraggingSignatureStatus,
      gpb_residual_mas_per_year: frameDraggingGpbResidual,
      gpb_tolerance_mas_per_year: frameDraggingGpbTolerance,
      lageos_residual_ratio: frameDraggingLageosResidual,
      lageos_tolerance_ratio: frameDraggingLageosTolerance,
    },
    shapiro: {
      compare_path: normalizePath(DEFAULT_SHAPIRO_COMPARE_PATH),
      run_path: normalizePath(DEFAULT_SHAPIRO_RUN_PATH),
      method_out_path: shapiroMethodOutPath ? normalizePath(shapiroMethodOutPath) : null,
      compare_status: shapiroCompareStatus,
      signature_status: shapiroSignatureStatus,
      gamma_residual: shapiroGammaResidual,
      gamma_tolerance: shapiroGammaTolerance,
    },
    capsule_validation: {
      path: capsuleValidatePath ? normalizePath(capsuleValidatePath) : null,
      pass: capsuleValidate?.pass === true,
      issueCount: asNumber(capsuleValidate?.summary?.issueCount) ?? null,
      errorCount: asNumber(capsuleValidate?.summary?.errorCount) ?? null,
      warningCount: asNumber(capsuleValidate?.summary?.warningCount) ?? null,
    },
    casimir: {
      adapter_url: adapterUrl,
      trace_export_url: traceExportUrl,
      trace_out_path: normalizePath(traceOutPath),
      trace_export_out_path: normalizePath(traceExportOutPath),
      verdict: casimirVerdict,
      firstFail: casimirFirstFail,
      traceId: casimirTraceId,
      runId: casimirRunId,
      certificateHash: casimirCertificateHash,
      integrityOk: casimirIntegrityOk,
      status: casimirStatus,
    },
    rubric: {
      canonical_decision: { pass: canonicalDecisionPass },
      canonical_count_shape: { pass: canonicalCountShapePass },
      geometry_baseline: {
        pass: geometryPass,
        missing_checks: missingGeometry,
        failed_checks: failedGeometry,
      },
      mercury_observable: {
        pass: mercuryPass,
      },
      lensing_observable: {
        pass: lensingPass,
      },
      frame_dragging_observable: {
        pass: frameDraggingPass,
      },
      shapiro_observable: {
        pass: shapiroPass,
      },
      external_staleness: {
        pass: externalStalePass,
        stale_count: staleCount,
      },
      external_reason_taxonomy: {
        pass: reasonTaxonomyPass,
        violation_count: reasonSummary.violations.length,
      },
      capsule_validation: {
        pass: capsuleValidationPass,
      },
      casimir_verification: {
        pass: casimirPass,
      },
    },
    steps,
    blockers,
    blocker_count: blockers.length,
    final_parity_verdict: blockers.length === 0 ? 'PASS' : 'FAIL',
    paths: {
      dated_json: normalizePath(outJsonPath),
      latest_json: normalizePath(latestJsonPath),
      dated_md: normalizePath(outMdPath),
      latest_md: normalizePath(latestMdPath),
    },
  };

  const checksum = checksumPayload(payloadBase);
  const priorCommit = asText(priorLatest?.commit_pin);
  const priorGeneratorVersion = asText(priorLatest?.generator_version);
  const priorPayloadChecksum = asText(priorLatest?.checksum);
  const priorNormalizedChecksum = asText(priorLatest?.normalized_checksum) ?? priorPayloadChecksum;
  const priorSourceState = ((priorLatest?.source_state as Partial<SourceState>) ?? {}) as Partial<SourceState>;
  const priorWorkspaceDirty = priorSourceState.workspace_dirty === true;
  const priorStatusFingerprint = asText(priorSourceState.status_fingerprint);
  const sameCommitPriorFound = priorCommit != null && priorCommit === commitPin;
  const sameSourceFingerprint =
    sourceState.workspace_dirty === priorWorkspaceDirty &&
    (sourceState.workspace_dirty ? priorStatusFingerprint === sourceState.status_fingerprint : true);
  const comparablePrior = sameCommitPriorFound && priorGeneratorVersion === GENERATOR_VERSION && sameSourceFingerprint;
  const matchesPriorChecksum = !comparablePrior || priorNormalizedChecksum === checksum;
  if (!matchesPriorChecksum) {
    addBlocker(
      'repeatability_checksum_mismatch',
      `same commit ${commitPin} has prior checksum ${String(priorNormalizedChecksum)} and new checksum ${checksum}`,
      latestJsonPath,
    );
  }

  const payloadWithRepeatability = {
    ...payloadBase,
    repeatability: {
      same_commit_prior_found: sameCommitPriorFound,
      comparable_prior: comparablePrior,
      same_source_fingerprint: sameSourceFingerprint,
      source_workspace_dirty: sourceState.workspace_dirty,
      source_status_fingerprint: sourceState.status_fingerprint,
      prior_workspace_dirty: priorWorkspaceDirty,
      prior_status_fingerprint: priorStatusFingerprint,
      prior_generator_version: priorGeneratorVersion,
      prior_checksum: priorNormalizedChecksum,
      prior_payload_checksum: priorPayloadChecksum,
      matches_prior_checksum: matchesPriorChecksum,
    },
    blockers,
    blocker_count: blockers.length,
    final_parity_verdict: blockers.length === 0 ? 'PASS' : 'FAIL',
  } as Record<string, unknown>;

  const finalChecksum = checksumPayload(payloadWithRepeatability);
  const payload = {
    ...payloadWithRepeatability,
    normalized_checksum: checksum,
    checksum: finalChecksum,
  };
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
    ok: blockers.length === 0,
    outJsonPath,
    outMdPath,
    latestJsonPath,
    latestMdPath,
    finalParityVerdict: payload.final_parity_verdict,
    blockerCount: blockers.length,
    checksum: finalChecksum,
    casimir: payload.casimir,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIntegrityParitySuite({
    outJsonPath: readArgValue('--out-json') ?? DEFAULT_OUT_JSON,
    outMdPath: readArgValue('--out-md') ?? DEFAULT_OUT_MD,
    latestJsonPath: readArgValue('--latest-json') ?? DEFAULT_LATEST_JSON,
    latestMdPath: readArgValue('--latest-md') ?? DEFAULT_LATEST_MD,
    adapterUrl: readArgValue('--adapter-url') ?? DEFAULT_ADAPTER_URL,
    traceExportUrl: readArgValue('--trace-export-url') ?? DEFAULT_TRACE_EXPORT_URL,
    traceOutPath: readArgValue('--trace-out') ?? DEFAULT_TRACE_OUT,
    traceExportOutPath: readArgValue('--trace-export-out') ?? DEFAULT_TRACE_EXPORT_OUT,
  })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) process.exit(1);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
