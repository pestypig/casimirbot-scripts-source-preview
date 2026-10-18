import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const GENERATOR_VERSION = '1.0.0';
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const FULL_SOLVE_DIR = path.join('artifacts', 'research', 'full-solve');
const DOC_AUDIT_DIR = path.join('docs', 'audits', 'research');
const EXTERNAL_WORK_DIR = path.join(FULL_SOLVE_DIR, 'external-work');

const DEFAULT_OUT_JSON = path.join(FULL_SOLVE_DIR, `promotion-readiness-suite-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join(DOC_AUDIT_DIR, `warp-promotion-readiness-suite-${DATE_STAMP}.md`);
const DEFAULT_LATEST_JSON = path.join(FULL_SOLVE_DIR, 'promotion-readiness-suite-latest.json');
const DEFAULT_LATEST_MD = path.join(DOC_AUDIT_DIR, 'warp-promotion-readiness-suite-latest.md');

const DEFAULT_INTEGRITY_PATH = path.join(FULL_SOLVE_DIR, 'integrity-parity-suite-latest.json');
const DEFAULT_CAPSULE_PATH = path.join(FULL_SOLVE_DIR, 'full-solve-reference-capsule-latest.json');
const DEFAULT_EXTERNAL_MATRIX_PATH = path.join(EXTERNAL_WORK_DIR, 'external-work-comparison-matrix-latest.json');
const DEFAULT_SE_PAIRED_RUNS_DIR = path.join(FULL_SOLVE_DIR, 'se-paired-runs');

const DEFAULT_TRACE_OUT = path.join('artifacts', 'training-trace.jsonl');
const DEFAULT_TRACE_EXPORT_OUT = path.join('artifacts', 'training-trace-export.jsonl');
const DEFAULT_ADAPTER_URL = 'http://127.0.0.1:5050/api/agi/adapter/run';
const DEFAULT_TRACE_EXPORT_URL = 'http://127.0.0.1:5050/api/agi/training-trace/export';

const REQUIRED_GEOMETRY_CHECKS = [
  'metric_form_alignment',
  'shift_mapping',
  'york_time_sign_parity',
  'natario_control_behavior',
  'metric_derived_t00_path',
] as const;

const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';

type ReducedReasonCategory =
  | 'missing_anchor_or_context'
  | 'missing_uncertainty_anchor'
  | 'threshold_violation'
  | 'uncertainty_edge_overlap'
  | 'source_admissibility'
  | 'reportable_contract'
  | 'other';

type StepRecord = { id: string; command: string; status: 'pass' };
type Blocker = {
  code: string;
  category: 'integrity_rubric_failure' | 'lane_reportable_blocked' | 'contract_violation' | 'repeatability' | 'artifact_missing' | 'verification';
  detail: string;
  path: string | null;
};

type CasimirVerifyResponse = {
  traceId?: string;
  runId?: string | number;
  verdict?: string;
  pass?: boolean;
  firstFail?: unknown;
  certificate?: { status?: string; certificateHash?: string | null; integrityOk?: boolean } | null;
};

type LaneDef = {
  laneId: 'q_spoiling' | 'timing' | 'sem_ellipsometry';
  buildScenariosScript: string;
  buildPacksScript: string;
  injectScript: string;
  checkScript: string;
  reportableScenarioPath: string;
  runOutJsonPath: string;
  runOutMdPath: string;
  checkOutJsonPath: string;
  checkOutMdPath: string;
};

type LaneSummary = {
  laneId: LaneDef['laneId'];
  reportableReady: boolean;
  blockedReasons: string[];
  scenarioCount: number;
  evidenceCongruence: { congruent: number; incongruent: number; unknown: number };
  reasonCounts: Record<string, number>;
  reducedReasonCounts: Record<ReducedReasonCategory, number>;
  checkPath: string;
  runPath: string;
  scenarioPackPath: string;
};

type SePairedEvidenceResolution = {
  evidencePath: string | null;
  source: 'arg' | 'autodiscovered' | 'none';
  reason: string | null;
};

const LANE_DEFS: LaneDef[] = [
  {
    laneId: 'q_spoiling',
    buildScenariosScript: 'warp:shadow:build-scenarios:qs-primary',
    buildPacksScript: 'warp:shadow:build-qs-packs',
    injectScript: 'warp:shadow:inject:qs-primary-reportable',
    checkScript: 'warp:shadow:qs-compat-check',
    reportableScenarioPath: path.join('configs', 'warp-shadow-injection-scenarios.qs-primary-reportable.v1.json'),
    runOutJsonPath: path.join(FULL_SOLVE_DIR, `shadow-injection-run-qs-primary-reportable-readiness-${DATE_STAMP}.json`),
    runOutMdPath: path.join(DOC_AUDIT_DIR, `warp-shadow-injection-run-qs-primary-reportable-readiness-${DATE_STAMP}.md`),
    checkOutJsonPath: path.join(FULL_SOLVE_DIR, `qs-compat-check-readiness-${DATE_STAMP}.json`),
    checkOutMdPath: path.join(DOC_AUDIT_DIR, `warp-qs-compat-check-readiness-${DATE_STAMP}.md`),
  },
  {
    laneId: 'timing',
    buildScenariosScript: 'warp:shadow:build-scenarios:ti-primary',
    buildPacksScript: 'warp:shadow:build-ti-packs',
    injectScript: 'warp:shadow:inject:ti-primary-reportable',
    checkScript: 'warp:shadow:ti-compat-check',
    reportableScenarioPath: path.join('configs', 'warp-shadow-injection-scenarios.ti-primary-reportable.v1.json'),
    runOutJsonPath: path.join(FULL_SOLVE_DIR, `shadow-injection-run-ti-primary-reportable-readiness-${DATE_STAMP}.json`),
    runOutMdPath: path.join(DOC_AUDIT_DIR, `warp-shadow-injection-run-ti-primary-reportable-readiness-${DATE_STAMP}.md`),
    checkOutJsonPath: path.join(FULL_SOLVE_DIR, `ti-compat-check-readiness-${DATE_STAMP}.json`),
    checkOutMdPath: path.join(DOC_AUDIT_DIR, `warp-ti-compat-check-readiness-${DATE_STAMP}.md`),
  },
  {
    laneId: 'sem_ellipsometry',
    buildScenariosScript: 'warp:shadow:build-scenarios:se-primary',
    buildPacksScript: 'warp:shadow:build-se-packs',
    injectScript: 'warp:shadow:inject:se-primary-reportable',
    checkScript: 'warp:shadow:se-compat-check',
    reportableScenarioPath: path.join('configs', 'warp-shadow-injection-scenarios.se-primary-reportable.v1.json'),
    runOutJsonPath: path.join(FULL_SOLVE_DIR, `shadow-injection-run-se-primary-reportable-readiness-${DATE_STAMP}.json`),
    runOutMdPath: path.join(DOC_AUDIT_DIR, `warp-shadow-injection-run-se-primary-reportable-readiness-${DATE_STAMP}.md`),
    checkOutJsonPath: path.join(FULL_SOLVE_DIR, `se-compat-check-readiness-${DATE_STAMP}.json`),
    checkOutMdPath: path.join(DOC_AUDIT_DIR, `warp-se-compat-check-readiness-${DATE_STAMP}.md`),
  },
];

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const normalizePath = (filePath: string): string => filePath.replace(/\\/g, '/');
const resolvePathFromRoot = (filePath: string, cwd = process.cwd()): string =>
  path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
const ensureDirForFile = (filePath: string) => fs.mkdirSync(path.dirname(filePath), { recursive: true });
const readJson = (filePath: string): any => JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
const unique = (values: string[]): string[] => [...new Set(values.filter((value) => value.trim().length > 0))].sort();

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
  const volatileKeys = new Set(['generated_at', 'generated_on', 'checksum', 'normalized_checksum', 'traceId', 'runId', 'capsule_checksum']);
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

const runCommand = (command: string, args: string[], capture = false): SpawnSyncReturns<string> =>
  spawnSync(command, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
  });

const runNpm = (args: string[], steps: StepRecord[], stepId: string) => {
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  const result = runCommand(npmCommand, commandArgs, false);
  if (result.status !== 0) throw new Error(`Command failed: npm ${args.join(' ')} (exit=${String(result.status)})`);
  steps.push({ id: stepId, command: `npm ${args.join(' ')}`, status: 'pass' });
};

const parseJsonFromText = (text: string): any => {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Expected JSON output, got empty text.');
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    throw new Error(`Unable to parse JSON output: ${trimmed.slice(0, 200)}`);
  }
};

const runCasimirVerify = (adapterUrl: string, traceOutPath: string, steps: StepRecord[]): CasimirVerifyResponse => {
  const args = ['run', 'casimir:verify', '--', '--ci', '--url', adapterUrl, '--trace-out', traceOutPath];
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  const result = runCommand(npmCommand, commandArgs, true);
  if (result.status !== 0) throw new Error(`Casimir verify failed (exit=${String(result.status)}): ${(result.stderr ?? '').toString().trim()}`);
  const response = parseJsonFromText(result.stdout ?? '') as CasimirVerifyResponse;
  steps.push({ id: 'casimir_verify', command: `npm ${args.join(' ')}`, status: 'pass' });
  return response;
};

const exportTrainingTrace = async (url: string, outPath: string, steps: StepRecord[]) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Training trace export failed: HTTP ${response.status}`);
  ensureDirForFile(outPath);
  fs.writeFileSync(outPath, await response.text());
  steps.push({ id: 'casimir_trace_export', command: `GET ${url} -> ${normalizePath(outPath)}`, status: 'pass' });
};

const toReducedReasonCategory = (reasonCode: string): ReducedReasonCategory => {
  const code = String(reasonCode ?? '').trim().toLowerCase();
  if (!code) return 'other';
  if (code.includes('missing_numeric_uncertainty_anchor') || code.includes('missing_covariance_uncertainty_anchor')) return 'missing_uncertainty_anchor';
  if (code.startsWith('missing_')) return 'missing_anchor_or_context';
  if (code.includes('exceeds_profile') || code.includes('below_floor') || code.includes('above_ceiling') || code.includes('outside')) return 'threshold_violation';
  if (code.includes('edge_uncertainty_overlap')) return 'uncertainty_edge_overlap';
  if (code.includes('strict_scope_ref_not_admissible') || code.includes('source_class_not_allowed')) return 'source_admissibility';
  if (code.includes('reportable_not_ready') || code.includes('reportable_ready_with_blocked_reasons')) return 'reportable_contract';
  return 'other';
};

const zeroReducedReasonCounts = (): Record<ReducedReasonCategory, number> => ({
  missing_anchor_or_context: 0,
  missing_uncertainty_anchor: 0,
  threshold_violation: 0,
  uncertainty_edge_overlap: 0,
  source_admissibility: 0,
  reportable_contract: 0,
  other: 0,
});

const collectLaneSummary = (lane: LaneDef): LaneSummary => {
  const scenarioPack = readJson(resolvePathFromRoot(lane.reportableScenarioPath));
  const checkPayload = readJson(resolvePathFromRoot(lane.checkOutJsonPath));
  const scenarioChecks = Array.isArray(checkPayload?.scenarioChecks) ? checkPayload.scenarioChecks : [];
  const summary = checkPayload?.summary ?? {};

  const blockedReasons = unique([
    ...((scenarioPack?.preRegistrationProfile?.blockedReasons ?? []) as string[]),
    ...((scenarioPack?.reportableReferenceProfile?.blockedReasons ?? []) as string[]),
    ...scenarioChecks.flatMap((entry: any) => (Array.isArray(entry?.blockedReasons) ? entry.blockedReasons : [])),
  ]);

  const packReady = scenarioPack?.preRegistrationProfile?.reportableReady === true || scenarioPack?.reportableReferenceProfile?.reportableReady === true;
  const reportableReady = packReady && blockedReasons.length === 0;
  const reasonCounts = (summary?.reasonCounts ?? {}) as Record<string, number>;
  const reducedReasonCounts = ((summary?.reducedReasonCounts ?? null) as Record<ReducedReasonCategory, number> | null) ?? (() => {
    const out = zeroReducedReasonCounts();
    for (const [code, count] of Object.entries(reasonCounts)) {
      const reduced = toReducedReasonCategory(code);
      out[reduced] += asNumber(count) ?? 0;
    }
    return out;
  })();

  return {
    laneId: lane.laneId,
    reportableReady,
    blockedReasons,
    scenarioCount: asNumber(summary?.scenarioCount) ?? scenarioChecks.length,
    evidenceCongruence: {
      congruent: asNumber(summary?.congruent) ?? 0,
      incongruent: asNumber(summary?.incongruent) ?? 0,
      unknown: asNumber(summary?.unknown) ?? 0,
    },
    reasonCounts,
    reducedReasonCounts,
    checkPath: normalizePath(lane.checkOutJsonPath),
    runPath: normalizePath(lane.runOutJsonPath),
    scenarioPackPath: normalizePath(lane.reportableScenarioPath),
  };
};

const renderMarkdown = (payload: any): string => {
  const laneRows = (payload.lane_reportable_coverage?.lanes ?? [])
    .map((lane: any) => `| ${lane.laneId} | ${lane.reportableReady === true ? 'true' : 'false'} | ${lane.evidenceCongruence.congruent} | ${lane.evidenceCongruence.incongruent} | ${lane.evidenceCongruence.unknown} | ${lane.blockedReasons.join(', ') || 'none'} |`)
    .join('\n');
  return `# Promotion Readiness Suite (${payload.generated_on})

"${payload.boundary_statement}"

## Result
- artifact_type: \`${payload.artifact_type}\`
- commit_pin: \`${payload.commit_pin}\`
- final_readiness_verdict: \`${payload.final_readiness_verdict}\`
- readiness_gate_pass: \`${payload.readiness_gate_pass === true}\`
- checksum: \`${payload.checksum}\`

## Coverage
| lane | reportable_ready | congruent | incongruent | unknown | blocked_reasons |
|---|---|---:|---:|---:|---|
${laneRows || '| none | false | 0 | 0 | 0 | n/a |'}
`;
};

const getCommitPin = (): string => execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();

const resolveSePairedEvidence = (explicitPath?: string): SePairedEvidenceResolution => {
  if (explicitPath) {
    const resolved = resolvePathFromRoot(explicitPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`SE paired evidence path not found: ${explicitPath}`);
    }
    return {
      evidencePath: normalizePath(explicitPath),
      source: 'arg',
      reason: null,
    };
  }

  if (!fs.existsSync(DEFAULT_SE_PAIRED_RUNS_DIR)) {
    return {
      evidencePath: null,
      source: 'none',
      reason: 'paired_runs_dir_missing',
    };
  }

  const candidates = fs
    .readdirSync(DEFAULT_SE_PAIRED_RUNS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));

  for (const dirName of candidates) {
    const dirPath = path.join(DEFAULT_SE_PAIRED_RUNS_DIR, dirName);
    const validatePath = path.join(dirPath, 'se-paired-evidence-validate.v1.json');
    const evidencePath = path.join(dirPath, 'se-paired-run-evidence.v1.json');
    if (!fs.existsSync(validatePath) || !fs.existsSync(evidencePath)) continue;
    const validatePayload = readJson(validatePath);
    if (validatePayload?.reportableReadyCandidate === true && (asNumber(validatePayload?.issueCount) ?? 0) === 0) {
      return {
        evidencePath: normalizePath(evidencePath),
        source: 'autodiscovered',
        reason: null,
      };
    }
  }

  return {
    evidencePath: null,
    source: 'none',
    reason: 'no_reportable_ready_candidate_found',
  };
};

export const runPromotionReadinessSuite = async (options: {
  outJsonPath?: string;
  outMdPath?: string;
  latestJsonPath?: string;
  latestMdPath?: string;
  adapterUrl?: string;
  traceOutPath?: string;
  traceExportOutPath?: string;
  traceExportUrl?: string;
  sePairedEvidencePath?: string;
}) => {
  const outJsonPath = options.outJsonPath ?? DEFAULT_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_OUT_MD;
  const latestJsonPath = options.latestJsonPath ?? DEFAULT_LATEST_JSON;
  const latestMdPath = options.latestMdPath ?? DEFAULT_LATEST_MD;
  const adapterUrl = options.adapterUrl ?? DEFAULT_ADAPTER_URL;
  const traceOutPath = options.traceOutPath ?? DEFAULT_TRACE_OUT;
  const traceExportOutPath = options.traceExportOutPath ?? DEFAULT_TRACE_EXPORT_OUT;
  const traceExportUrl = options.traceExportUrl ?? DEFAULT_TRACE_EXPORT_URL;
  const sePairedEvidence = resolveSePairedEvidence(options.sePairedEvidencePath);

  const steps: StepRecord[] = [];
  const blockers: Blocker[] = [];
  const addBlocker = (code: Blocker['code'], category: Blocker['category'], detail: string, blockerPath: string | null = null) =>
    blockers.push({ code, category, detail, path: blockerPath ? normalizePath(blockerPath) : null });

  runNpm(['run', 'warp:external:refresh'], steps, 'external_refresh');
  for (const lane of LANE_DEFS) {
    runNpm(['run', lane.buildScenariosScript], steps, `${lane.laneId}_build_scenarios`);
    if (lane.laneId === 'sem_ellipsometry' && sePairedEvidence.evidencePath) {
      runNpm(
        ['run', lane.buildPacksScript, '--', '--paired-evidence', sePairedEvidence.evidencePath],
        steps,
        `${lane.laneId}_build_packs`,
      );
    } else {
      runNpm(['run', lane.buildPacksScript], steps, `${lane.laneId}_build_packs`);
    }
    runNpm(['run', lane.injectScript, '--', '--out', lane.runOutJsonPath, '--out-md', lane.runOutMdPath], steps, `${lane.laneId}_inject_reportable`);
    runNpm(['run', lane.checkScript, '--', '--scenarios', lane.reportableScenarioPath, '--run', lane.runOutJsonPath, '--out', lane.checkOutJsonPath, '--out-md', lane.checkOutMdPath], steps, `${lane.laneId}_check_reportable`);
  }
  runNpm(['run', 'warp:integrity:check'], steps, 'integrity_parity_suite');
  runNpm(['run', 'warp:full-solve:reference:validate', '--', '--capsule', DEFAULT_CAPSULE_PATH], steps, 'reference_capsule_validate');

  const casimirVerifyResponse = runCasimirVerify(adapterUrl, traceOutPath, steps);
  await exportTrainingTrace(traceExportUrl, traceExportOutPath, steps);

  const commitPin = getCommitPin();
  const integrity = readJson(resolvePathFromRoot(DEFAULT_INTEGRITY_PATH));
  const capsule = readJson(resolvePathFromRoot(DEFAULT_CAPSULE_PATH));
  const externalMatrix = readJson(resolvePathFromRoot(DEFAULT_EXTERNAL_MATRIX_PATH));
  const laneSummaries = LANE_DEFS.map((lane) => collectLaneSummary(lane));

  const canonicalDecision = asText(integrity?.canonical?.decision) ?? 'UNKNOWN';
  const canonicalDecisionOk = canonicalDecision === 'REDUCED_ORDER_ADMISSIBLE';
  if (!canonicalDecisionOk) addBlocker('canonical_decision_not_admissible', 'integrity_rubric_failure', `Expected REDUCED_ORDER_ADMISSIBLE, got ${canonicalDecision}`, DEFAULT_INTEGRITY_PATH);

  const geometryChecks = Array.isArray(integrity?.geometry?.checks) ? integrity.geometry.checks : [];
  const checkMap = new Map(geometryChecks.map((entry: any) => [asText(entry?.id), asText(entry?.status)]).filter((entry: [string | null, string | null]) => entry[0] != null));
  const geometryPassCount = REQUIRED_GEOMETRY_CHECKS.filter((id) => checkMap.get(id) === 'pass').length;
  const geometryAllPass = geometryPassCount === REQUIRED_GEOMETRY_CHECKS.length;
  if (!geometryAllPass) addBlocker('geometry_not_5_of_5', 'integrity_rubric_failure', `Expected geometry pass 5/5, got ${geometryPassCount}/5`, DEFAULT_INTEGRITY_PATH);

  const grStatuses = {
    mercury: asText(integrity?.mercury?.compare_status) ?? 'unknown',
    lensing: asText(integrity?.lensing?.compare_status) ?? 'unknown',
    frame_dragging: asText(integrity?.frame_dragging?.compare_status) ?? 'unknown',
    shapiro: asText(integrity?.shapiro?.compare_status) ?? 'unknown',
  };
  const grObservableSetOk = Object.values(grStatuses).every((status) => status === 'compatible');
  if (!grObservableSetOk) addBlocker('gr_observable_set_not_compatible', 'integrity_rubric_failure', JSON.stringify(grStatuses), DEFAULT_INTEGRITY_PATH);

  const staleCount = asNumber(externalMatrix?.stale_flags?.stale_count) ?? 0;
  const externalFreshOk = staleCount === 0;
  if (!externalFreshOk) addBlocker('external_matrix_stale_count_nonzero', 'integrity_rubric_failure', `stale_count=${staleCount}`, DEFAULT_EXTERNAL_MATRIX_PATH);

  for (const lane of laneSummaries) {
    if (lane.reportableReady && lane.blockedReasons.length > 0) addBlocker(`lane_reportable_contract_invalid:${lane.laneId}`, 'contract_violation', lane.blockedReasons.join(','), lane.scenarioPackPath);
    if (!lane.reportableReady) addBlocker(`lane_reportable_blocked:${lane.laneId}`, 'lane_reportable_blocked', lane.blockedReasons.join(',') || 'missing explicit blocked reason', lane.scenarioPackPath);
  }

  const casimirVerdict = asText(casimirVerifyResponse?.verdict) ?? (casimirVerifyResponse?.pass === true ? 'PASS' : 'FAIL');
  const casimirCertificateHash = asText(casimirVerifyResponse?.certificate?.certificateHash);
  const casimirIntegrityOk = casimirVerifyResponse?.certificate?.integrityOk === true;
  const casimirOk = casimirVerdict === 'PASS' && casimirIntegrityOk && Boolean(casimirCertificateHash);
  if (!casimirOk) addBlocker('casimir_verify_not_pass', 'verification', `verdict=${casimirVerdict} integrityOk=${String(casimirIntegrityOk)} cert=${String(casimirCertificateHash)}`, adapterUrl);

  const criticalFailure = !canonicalDecisionOk || !geometryAllPass || !grObservableSetOk || !externalFreshOk || !casimirOk;
  const hasLaneBlockers = blockers.some((entry) => entry.category === 'lane_reportable_blocked');

  const reducedReasonCounts = zeroReducedReasonCounts();
  for (const lane of laneSummaries) {
    for (const [key, value] of Object.entries(lane.reducedReasonCounts)) {
      const category = key as ReducedReasonCategory;
      reducedReasonCounts[category] += asNumber(value) ?? 0;
    }
  }

  const priorLatest = fs.existsSync(resolvePathFromRoot(latestJsonPath)) ? readJson(resolvePathFromRoot(latestJsonPath)) : null;
  const payloadBase: Record<string, unknown> = {
    artifact_type: 'promotion_readiness_suite/v1',
    generator_version: GENERATOR_VERSION,
    generated_on: DATE_STAMP,
    generated_at: new Date().toISOString(),
    boundary_statement: BOUNDARY_STATEMENT,
    commit_pin: commitPin,
    canonical: { decision: canonicalDecision, counts: integrity?.canonical?.counts ?? {} },
    geometry: { required_checks: REQUIRED_GEOMETRY_CHECKS, pass_count: geometryPassCount, required_count: REQUIRED_GEOMETRY_CHECKS.length, all_pass: geometryAllPass },
    gr_observable_compatibility: { ...grStatuses, all_compatible: grObservableSetOk },
    lane_reportable_coverage: {
      lane_count: laneSummaries.length,
      reportable_ready_count: laneSummaries.filter((lane) => lane.reportableReady).length,
      blocked_count: laneSummaries.filter((lane) => !lane.reportableReady).length,
      lanes: laneSummaries,
    },
    blocker_taxonomy: { reduced_reason_counts: reducedReasonCounts },
    casimir: {
      verdict: casimirVerdict,
      firstFail: casimirVerifyResponse?.firstFail ?? null,
      traceId: asText(casimirVerifyResponse?.traceId),
      runId: asText(casimirVerifyResponse?.runId),
      certificateHash: casimirCertificateHash,
      integrityOk: casimirIntegrityOk,
      status: asText(casimirVerifyResponse?.certificate?.status),
    },
    anchors: {
      integrity_parity_suite_latest: normalizePath(DEFAULT_INTEGRITY_PATH),
      full_solve_reference_capsule_latest: normalizePath(DEFAULT_CAPSULE_PATH),
      external_work_matrix_latest: normalizePath(DEFAULT_EXTERNAL_MATRIX_PATH),
    },
    se_paired_evidence: {
      evidence_path: sePairedEvidence.evidencePath,
      source: sePairedEvidence.source,
      reason: sePairedEvidence.reason,
    },
    capsule_checksum: asText(capsule?.checksum),
    external_matrix_stale_count: staleCount,
    rubric: {
      canonical_decision_ok: canonicalDecisionOk,
      geometry_5_of_5_ok: geometryAllPass,
      gr_observable_set_ok: grObservableSetOk,
      external_matrix_fresh_ok: externalFreshOk,
      casimir_verify_ok: casimirOk,
    },
    steps,
    blockers,
    blocker_count: blockers.length,
    final_readiness_verdict: criticalFailure ? 'FAIL' : hasLaneBlockers ? 'PARTIAL' : 'PASS',
    readiness_gate_pass: !criticalFailure && !hasLaneBlockers,
  };

  const normalizedChecksum = checksumPayload(payloadBase);
  const priorCommit = asText(priorLatest?.commit_pin);
  const priorGen = asText(priorLatest?.generator_version);
  const priorChecksum = asText(priorLatest?.normalized_checksum) ?? asText(priorLatest?.checksum);
  const sameCommitPriorFound = priorCommit != null && priorCommit === commitPin;
  const comparablePrior = sameCommitPriorFound && priorGen === GENERATOR_VERSION;
  const matchesPriorChecksum = !comparablePrior || priorChecksum === normalizedChecksum;
  if (!matchesPriorChecksum) blockers.push({ code: 'repeatability_checksum_mismatch', category: 'repeatability', detail: `prior=${String(priorChecksum)} new=${normalizedChecksum}`, path: normalizePath(latestJsonPath) });

  const payload = {
    ...payloadBase,
    repeatability: {
      same_commit_prior_found: sameCommitPriorFound,
      comparable_prior: comparablePrior,
      prior_generator_version: priorGen,
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
    ok: payload.final_readiness_verdict !== 'FAIL',
    outJsonPath,
    outMdPath,
    latestJsonPath,
    latestMdPath,
    finalReadinessVerdict: payload.final_readiness_verdict,
    blockerCount: payload.blocker_count,
    checksum,
    casimir: payload.casimir,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPromotionReadinessSuite({
    outJsonPath: readArgValue('--out-json') ?? DEFAULT_OUT_JSON,
    outMdPath: readArgValue('--out-md') ?? DEFAULT_OUT_MD,
    latestJsonPath: readArgValue('--latest-json') ?? DEFAULT_LATEST_JSON,
    latestMdPath: readArgValue('--latest-md') ?? DEFAULT_LATEST_MD,
    adapterUrl: readArgValue('--adapter-url') ?? DEFAULT_ADAPTER_URL,
    traceOutPath: readArgValue('--trace-out') ?? DEFAULT_TRACE_OUT,
    traceExportOutPath: readArgValue('--trace-export-out') ?? DEFAULT_TRACE_EXPORT_OUT,
    traceExportUrl: readArgValue('--trace-export-url') ?? DEFAULT_TRACE_EXPORT_URL,
    sePairedEvidencePath: readArgValue('--se-paired-evidence'),
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
