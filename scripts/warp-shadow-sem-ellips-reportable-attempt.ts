import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { prepareSemEllipsPairingManifest } from './warp-shadow-sem-ellips-paired-manifest-prepare.js';
import { ingestSemEllipsPairedRunEvidence } from './warp-shadow-sem-ellips-paired-run-ingest.js';
import { validateSemEllipsPairedEvidence } from './warp-shadow-sem-ellips-paired-evidence-validate.js';
import { buildSemEllipsScenarioPacks } from './warp-shadow-sem-ellips-pack-builder.js';
import { runWarpShadowInjection } from './warp-shadow-injection-runner.js';
import { runSemEllipsCompatCheck } from './warp-shadow-sem-ellips-compat-check.js';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const FULL_SOLVE_DIR = path.join('artifacts', 'research', 'full-solve');
const DOC_AUDIT_DIR = path.join('docs', 'audits', 'research');
const DEFAULT_BUNDLE_DIR = path.join('docs', 'specs', 'data', 'se-paired-runs-template-2026-03-08');
const DEFAULT_BUNDLE_OUT_DIR = path.join(FULL_SOLVE_DIR, 'se-paired-runs', DATE_STAMP);

const DEFAULT_SCENARIO_BASE = path.join('configs', 'warp-shadow-injection-scenarios.se-primary-recovery.v1.json');
const DEFAULT_SCENARIO_PASS1 = path.join('configs', 'warp-shadow-injection-scenarios.se-primary-recovery.v1.json');
const DEFAULT_SCENARIO_PASS2 = path.join('configs', 'warp-shadow-injection-scenarios.se-primary-typed.v1.json');
const DEFAULT_SCENARIO_REPORTABLE = path.join('configs', 'warp-shadow-injection-scenarios.se-primary-reportable.v1.json');
const DEFAULT_SCENARIO_REPORTABLE_REFERENCE = path.join(
  'configs',
  'warp-shadow-injection-scenarios.se-primary-reportable-reference.v1.json',
);

const DEFAULT_RUN_OUT_JSON = path.join(FULL_SOLVE_DIR, `shadow-injection-run-se-primary-reportable-attempt-${DATE_STAMP}.json`);
const DEFAULT_RUN_OUT_MD = path.join(DOC_AUDIT_DIR, `warp-shadow-injection-run-se-primary-reportable-attempt-${DATE_STAMP}.md`);
const DEFAULT_CHECK_OUT_JSON = path.join(FULL_SOLVE_DIR, `se-compat-check-attempt-${DATE_STAMP}.json`);
const DEFAULT_CHECK_OUT_MD = path.join(DOC_AUDIT_DIR, `warp-se-compat-check-attempt-${DATE_STAMP}.md`);
const DEFAULT_RUN_REF_OUT_JSON = path.join(
  FULL_SOLVE_DIR,
  `shadow-injection-run-se-primary-reportable-reference-attempt-${DATE_STAMP}.json`,
);
const DEFAULT_RUN_REF_OUT_MD = path.join(
  DOC_AUDIT_DIR,
  `warp-shadow-injection-run-se-primary-reportable-reference-attempt-${DATE_STAMP}.md`,
);
const DEFAULT_CHECK_REF_OUT_JSON = path.join(FULL_SOLVE_DIR, `se-compat-check-reference-attempt-${DATE_STAMP}.json`);
const DEFAULT_CHECK_REF_OUT_MD = path.join(DOC_AUDIT_DIR, `warp-se-compat-check-reference-attempt-${DATE_STAMP}.md`);
const DEFAULT_SUMMARY_OUT_JSON = path.join(FULL_SOLVE_DIR, `se-reportable-attempt-${DATE_STAMP}.json`);
const DEFAULT_SUMMARY_OUT_MD = path.join(DOC_AUDIT_DIR, `warp-se-reportable-attempt-${DATE_STAMP}.md`);
const DEFAULT_SUMMARY_LATEST_JSON = path.join(FULL_SOLVE_DIR, 'se-reportable-attempt-latest.json');
const DEFAULT_SUMMARY_LATEST_MD = path.join(DOC_AUDIT_DIR, 'warp-se-reportable-attempt-latest.md');

const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

type AttemptVerdict = 'ready' | 'blocked';

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const normalizePath = (filePath: string): string => filePath.replace(/\\/g, '/');

const parseList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

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
  const canonical = JSON.stringify(objectWithSortedKeys(payload));
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

const loadReportableReferenceProfile = (
  scenarioPath: string,
): {
  profileReady: boolean;
  blockedReasons: string[];
} => {
  const raw = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as {
    reportableReferenceProfile?: {
      reportableReady?: boolean;
      blockedReasons?: unknown[];
    };
  };
  const profile = raw.reportableReferenceProfile;
  const blockedReasons = Array.isArray(profile?.blockedReasons)
    ? profile!.blockedReasons
        .map((value) => String(value ?? '').trim())
        .filter((value) => value.length > 0)
    : [];
  return {
    profileReady: profile?.reportableReady === true,
    blockedReasons,
  };
};

const renderMarkdown = (payload: any): string => {
  const blockedReasons = (payload.blockedReasons as string[]).length > 0 ? payload.blockedReasons : ['none'];
  const blockedRows = blockedReasons.map((reason: string) => `| ${reason} |`).join('\n');
  return `# SEM+Ellipsometry Reportable Attempt (${payload.generatedOn})

"${payload.boundaryStatement}"

## Result
- verdict: \`${payload.verdict}\`
- reportable_ready_candidate: \`${payload.reportableReadyCandidate}\`
- reportable_reference_pack_ready: \`${payload.reportableReferencePackReady}\`
- reportable_mapping_pack_ready: \`${payload.reportableMappingPackReady}\`
- reportable_pack_ready_legacy_alias: \`${payload.reportablePackReady}\`
- readiness_evaluation_track: \`${payload.readinessEvaluationTrack}\`
- mapping_compat_summary: congruent=${payload.mappingCompatSummary.congruent}, incongruent=${payload.mappingCompatSummary.incongruent}, unknown=${payload.mappingCompatSummary.unknown}
- reportable_reference_compat_summary: congruent=${payload.reportableReferenceCompatSummary.congruent}, incongruent=${payload.reportableReferenceCompatSummary.incongruent}, unknown=${payload.reportableReferenceCompatSummary.unknown}
- checksum: \`${payload.checksum}\`
- commit_pin: \`${payload.commitPin}\`

## Paths
- bundle_dir: \`${payload.paths.bundleDir}\`
- prepared_manifest: \`${payload.paths.preparedManifest}\`
- evidence_json: \`${payload.paths.evidenceJson}\`
- validate_json: \`${payload.paths.validateJson}\`
- reportable_pack: \`${payload.paths.reportableScenarioPack}\`
- reportable_reference_pack: \`${payload.paths.reportableReferenceScenarioPack}\`
- mapping_run_json: \`${payload.paths.mappingRunJson}\`
- mapping_compat_json: \`${payload.paths.mappingCompatJson}\`
- reportable_reference_run_json: \`${payload.paths.reportableReferenceRunJson}\`
- reportable_reference_compat_json: \`${payload.paths.reportableReferenceCompatJson}\`

## Blocked Reasons
| reason |
|---|
${blockedRows}
`;
};

export const runSemEllipsReportableAttempt = async (options: {
  bundleDir?: string;
  semPath?: string;
  ellipsPath?: string;
  manifestPath?: string;
  covariancePath?: string;
  preparedManifestPath?: string;
  runIds?: string;
  rawRefs?: string;
  pairedRunId?: string;
  sourceClass?: string;
  outJsonPath?: string;
  outMdPath?: string;
  outLatestJsonPath?: string;
  outLatestMdPath?: string;
  runOutJsonPath?: string;
  runOutMdPath?: string;
  checkOutJsonPath?: string;
  checkOutMdPath?: string;
  runReferenceOutJsonPath?: string;
  runReferenceOutMdPath?: string;
  checkReferenceOutJsonPath?: string;
  checkReferenceOutMdPath?: string;
}) => {
  const bundleDir = options.bundleDir ?? DEFAULT_BUNDLE_DIR;
  const bundleOutDir = DEFAULT_BUNDLE_OUT_DIR;
  const semPath = options.semPath ?? path.join(bundleDir, 'sem-measurements.csv');
  const ellipsPath = options.ellipsPath ?? path.join(bundleDir, 'ellips-measurements.csv');
  const manifestPath = options.manifestPath ?? path.join(bundleDir, 'pairing-manifest.json');
  const covariancePath = options.covariancePath ?? path.join(bundleDir, 'covariance-budget.json');
  const preparedManifestPath = options.preparedManifestPath ?? path.join(bundleOutDir, 'pairing-manifest.prepared.json');

  const evidencePath = path.join(bundleOutDir, 'se-paired-run-evidence.v1.json');
  const summaryJsonPath = path.join(bundleOutDir, 'se-paired-run-summary.v1.json');
  const summaryMdPath = path.join(bundleOutDir, 'se-paired-run-summary.md');
  const validateJsonPath = path.join(bundleOutDir, 'se-paired-evidence-validate.v1.json');
  const validateMdPath = path.join(bundleOutDir, 'se-paired-evidence-validate.md');

  const runOutJsonPath = options.runOutJsonPath ?? DEFAULT_RUN_OUT_JSON;
  const runOutMdPath = options.runOutMdPath ?? DEFAULT_RUN_OUT_MD;
  const checkOutJsonPath = options.checkOutJsonPath ?? DEFAULT_CHECK_OUT_JSON;
  const checkOutMdPath = options.checkOutMdPath ?? DEFAULT_CHECK_OUT_MD;
  const runReferenceOutJsonPath = options.runReferenceOutJsonPath ?? DEFAULT_RUN_REF_OUT_JSON;
  const runReferenceOutMdPath = options.runReferenceOutMdPath ?? DEFAULT_RUN_REF_OUT_MD;
  const checkReferenceOutJsonPath = options.checkReferenceOutJsonPath ?? DEFAULT_CHECK_REF_OUT_JSON;
  const checkReferenceOutMdPath = options.checkReferenceOutMdPath ?? DEFAULT_CHECK_REF_OUT_MD;
  const outJsonPath = options.outJsonPath ?? DEFAULT_SUMMARY_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_SUMMARY_OUT_MD;
  const outLatestJsonPath = options.outLatestJsonPath ?? DEFAULT_SUMMARY_LATEST_JSON;
  const outLatestMdPath = options.outLatestMdPath ?? DEFAULT_SUMMARY_LATEST_MD;

  const runIds = parseList(options.runIds);
  if (runIds.length === 0) {
    throw new Error('runIds are required. Pass --run-ids <SEM_RUN_ID,ELLIPS_RUN_ID,...>.');
  }

  const preparedManifestResult = prepareSemEllipsPairingManifest({
    manifestPath,
    outPath: preparedManifestPath,
    runIds: runIds.join(','),
    dataOrigin: 'instrument_export',
    rawRefs: options.rawRefs,
    pairedRunId: options.pairedRunId,
  });

  const ingestResult = ingestSemEllipsPairedRunEvidence({
    semPath,
    ellipsPath,
    manifestPath: preparedManifestPath,
    covariancePath,
    sourceClass: options.sourceClass,
    outEvidencePath: evidencePath,
    outSummaryJsonPath: summaryJsonPath,
    outSummaryMdPath: summaryMdPath,
  });

  const validateResult = validateSemEllipsPairedEvidence({
    evidencePath,
    outJsonPath: validateJsonPath,
    outMdPath: validateMdPath,
  });

  const buildResult = buildSemEllipsScenarioPacks({
    basePath: DEFAULT_SCENARIO_BASE,
    outPass1Path: DEFAULT_SCENARIO_PASS1,
    outPass2Path: DEFAULT_SCENARIO_PASS2,
    outReportablePath: DEFAULT_SCENARIO_REPORTABLE,
    outReportableReferencePath: DEFAULT_SCENARIO_REPORTABLE_REFERENCE,
    pairedEvidencePath: evidencePath,
  });

  const mappingRunResult = await runWarpShadowInjection({
    scenarioPath: DEFAULT_SCENARIO_REPORTABLE,
    outJsonPath: runOutJsonPath,
    outMdPath: runOutMdPath,
  });

  const mappingCompatResult = runSemEllipsCompatCheck({
    scenarioPath: DEFAULT_SCENARIO_REPORTABLE,
    runPath: runOutJsonPath,
    outJsonPath: checkOutJsonPath,
    outMdPath: checkOutMdPath,
  });

  const reportableReferenceRunResult = await runWarpShadowInjection({
    scenarioPath: DEFAULT_SCENARIO_REPORTABLE_REFERENCE,
    outJsonPath: runReferenceOutJsonPath,
    outMdPath: runReferenceOutMdPath,
  });

  const reportableReferenceCompatResult = runSemEllipsCompatCheck({
    scenarioPath: DEFAULT_SCENARIO_REPORTABLE_REFERENCE,
    runPath: runReferenceOutJsonPath,
    outJsonPath: checkReferenceOutJsonPath,
    outMdPath: checkReferenceOutMdPath,
  });

  const reportableReferenceProfile = loadReportableReferenceProfile(DEFAULT_SCENARIO_REPORTABLE_REFERENCE);

  const blockedReasons = [
    ...reportableReferenceProfile.blockedReasons,
    ...Object.entries((reportableReferenceCompatResult.summary.reasonCounts ?? {}) as Record<string, number>)
      .filter(([, count]) => Number(count) > 0)
      .map(([reason]) => reason),
  ].filter((reason, index, arr) => reason.trim().length > 0 && arr.indexOf(reason) === index);

  const reportableReadyCandidate = validateResult.reportableReadyCandidate === true;
  const reportableMappingPackReady = buildResult.summary.reportableReady === true;
  const reportableReferencePackReady = reportableReferenceProfile.profileReady;
  const mappingCompatSummary = mappingCompatResult.summary;
  const reportableReferenceCompatSummary = reportableReferenceCompatResult.summary;
  const verdict: AttemptVerdict =
    reportableReadyCandidate &&
    reportableReferencePackReady &&
    reportableReferenceCompatSummary.incongruent === 0 &&
    reportableReferenceCompatSummary.unknown === 0
      ? 'ready'
      : 'blocked';

  const commitPin = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();

  const payload = {
    artifactType: 'se_reportable_attempt/v1',
    generatedOn: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    commitPin,
    verdict,
    readinessEvaluationTrack: 'reportable_reference_profile_and_reference_compat',
    reportableReadyCandidate,
    reportablePackReady: reportableReferencePackReady,
    reportableReferencePackReady,
    reportableMappingPackReady,
    compatSummary: {
      scenarioCount: reportableReferenceCompatSummary.scenarioCount ?? 0,
      congruent: reportableReferenceCompatSummary.congruent ?? 0,
      incongruent: reportableReferenceCompatSummary.incongruent ?? 0,
      unknown: reportableReferenceCompatSummary.unknown ?? 0,
    },
    mappingCompatSummary: {
      scenarioCount: mappingCompatSummary.scenarioCount ?? 0,
      congruent: mappingCompatSummary.congruent ?? 0,
      incongruent: mappingCompatSummary.incongruent ?? 0,
      unknown: mappingCompatSummary.unknown ?? 0,
    },
    reportableReferenceCompatSummary: {
      scenarioCount: reportableReferenceCompatSummary.scenarioCount ?? 0,
      congruent: reportableReferenceCompatSummary.congruent ?? 0,
      incongruent: reportableReferenceCompatSummary.incongruent ?? 0,
      unknown: reportableReferenceCompatSummary.unknown ?? 0,
    },
    blockedReasons,
    steps: {
      prepareManifest: preparedManifestResult,
      ingest: ingestResult,
      validate: validateResult,
      build: { summary: buildResult.summary },
      mappingInject: mappingRunResult,
      mappingCompat: mappingCompatResult,
      reportableReferenceInject: reportableReferenceRunResult,
      reportableReferenceCompat: reportableReferenceCompatResult,
    },
    paths: {
      bundleDir: normalizePath(bundleDir),
      preparedManifest: normalizePath(preparedManifestPath),
      evidenceJson: normalizePath(evidencePath),
      validateJson: normalizePath(validateJsonPath),
      reportableScenarioPack: normalizePath(DEFAULT_SCENARIO_REPORTABLE),
      reportableReferenceScenarioPack: normalizePath(DEFAULT_SCENARIO_REPORTABLE_REFERENCE),
      mappingRunJson: normalizePath(runOutJsonPath),
      mappingCompatJson: normalizePath(checkOutJsonPath),
      reportableReferenceRunJson: normalizePath(runReferenceOutJsonPath),
      reportableReferenceCompatJson: normalizePath(checkReferenceOutJsonPath),
    },
  };

  const checksum = checksumPayload(payload as unknown as Record<string, unknown>);
  const finalPayload = {
    ...payload,
    checksum,
  };

  fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
  fs.writeFileSync(outJsonPath, `${JSON.stringify(finalPayload, null, 2)}\n`);
  fs.writeFileSync(outMdPath, `${renderMarkdown(finalPayload)}\n`);
  fs.copyFileSync(outJsonPath, outLatestJsonPath);
  fs.copyFileSync(outMdPath, outLatestMdPath);

  return {
    ok: true,
    outJsonPath,
    outMdPath,
    outLatestJsonPath,
    outLatestMdPath,
    verdict,
    reportableReadyCandidate,
    reportablePackReady: finalPayload.reportablePackReady,
    reportableReferencePackReady,
    reportableMappingPackReady,
    compatSummary: finalPayload.compatSummary,
    mappingCompatSummary: finalPayload.mappingCompatSummary,
    reportableReferenceCompatSummary: finalPayload.reportableReferenceCompatSummary,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSemEllipsReportableAttempt({
    bundleDir: readArgValue('--bundle-dir'),
    semPath: readArgValue('--sem'),
    ellipsPath: readArgValue('--ellips'),
    manifestPath: readArgValue('--manifest'),
    covariancePath: readArgValue('--covariance'),
    preparedManifestPath: readArgValue('--prepared-manifest-out'),
    runIds: readArgValue('--run-ids'),
    rawRefs: readArgValue('--raw-refs'),
    pairedRunId: readArgValue('--paired-run-id'),
    sourceClass: readArgValue('--source-class'),
    outJsonPath: readArgValue('--out'),
    outMdPath: readArgValue('--out-md'),
    outLatestJsonPath: readArgValue('--out-latest-json'),
    outLatestMdPath: readArgValue('--out-latest-md'),
    runOutJsonPath: readArgValue('--run-out'),
    runOutMdPath: readArgValue('--run-out-md'),
    checkOutJsonPath: readArgValue('--check-out'),
    checkOutMdPath: readArgValue('--check-out-md'),
    runReferenceOutJsonPath: readArgValue('--run-reference-out'),
    runReferenceOutMdPath: readArgValue('--run-reference-out-md'),
    checkReferenceOutJsonPath: readArgValue('--check-reference-out'),
    checkReferenceOutMdPath: readArgValue('--check-reference-out-md'),
  })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
