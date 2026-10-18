import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildSemEllipsPublicationOverlayPack } from './warp-shadow-sem-ellips-publication-pack-builder.js';
import { runWarpShadowInjection } from './warp-shadow-injection-runner.js';
import { runSemEllipsCompatCheck } from './warp-shadow-sem-ellips-compat-check.js';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_PACK_PATH = path.join('configs', 'warp-shadow-injection-scenarios.se-publication-typed.v1.json');
const DEFAULT_RUN_JSON = path.join(
  'artifacts',
  'research',
  'full-solve',
  `shadow-injection-run-se-publication-typed-${DATE_STAMP}.json`,
);
const DEFAULT_RUN_MD = path.join(
  'docs',
  'audits',
  'research',
  `warp-shadow-injection-run-se-publication-typed-${DATE_STAMP}.md`,
);
const DEFAULT_CHECK_JSON = path.join('artifacts', 'research', 'full-solve', `se-compat-check-publication-${DATE_STAMP}.json`);
const DEFAULT_CHECK_MD = path.join('docs', 'audits', 'research', `warp-se-compat-check-publication-${DATE_STAMP}.md`);
const DEFAULT_SUMMARY_JSON = path.join('artifacts', 'research', 'full-solve', `se-publication-overlay-${DATE_STAMP}.json`);
const DEFAULT_SUMMARY_MD = path.join('docs', 'audits', 'research', `warp-se-publication-overlay-${DATE_STAMP}.md`);
const DEFAULT_LATEST_SUMMARY_JSON = path.join('artifacts', 'research', 'full-solve', 'se-publication-overlay-latest.json');
const DEFAULT_LATEST_SUMMARY_MD = path.join('docs', 'audits', 'research', 'warp-se-publication-overlay-latest.md');
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const normalizePath = (filePath: string): string => filePath.replace(/\\/g, '/');

const stableSortObject = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => stableSortObject(entry));
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = stableSortObject(source[key]);
    return out;
  }
  return value;
};

const checksumPayload = (payload: Record<string, unknown>): string => {
  const canonical = JSON.stringify(stableSortObject(payload));
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

const renderMarkdown = (payload: any): string => {
  const blockedReasons = (payload.policy?.blockedReasons ?? []) as string[];
  const blockedRows =
    blockedReasons.length > 0
      ? blockedReasons.map((reason) => `| ${reason} |`).join('\n')
      : '| none |';

  return `# SEM+Ellipsometry Publication Overlay (${payload.generatedOn})

${payload.boundaryStatement}

## Summary
- artifact_type: \`${payload.artifactType}\`
- commit_pin: \`${payload.commitPin}\`
- lane_posture: \`${payload.policy.lanePosture}\`
- reportable_unlock: \`${payload.policy.reportableUnlock}\`
- scenario_count: ${payload.run.summary.scenarioCount}
- compatible: ${payload.run.summary.compatible}
- partial: ${payload.run.summary.partial}
- incompatible: ${payload.run.summary.incompatible}
- error: ${payload.run.summary.error}
- congruent: ${payload.compat.summary.congruent}
- incongruent: ${payload.compat.summary.incongruent}
- unknown: ${payload.compat.summary.unknown}
- checksum: \`${payload.checksum}\`

## Paths
- scenario_pack: \`${payload.paths.packPath}\`
- run_json: \`${payload.paths.runJsonPath}\`
- compat_json: \`${payload.paths.compatJsonPath}\`
- summary_json: \`${payload.paths.summaryJsonPath}\`

## Policy Blocked Reasons
| reason |
|---|
${blockedRows}
`;
};

export const runSemEllipsPublicationOverlay = async (options: {
  registryPath?: string;
  packPath?: string;
  runJsonPath?: string;
  runMdPath?: string;
  compatJsonPath?: string;
  compatMdPath?: string;
  summaryJsonPath?: string;
  summaryMdPath?: string;
  latestSummaryJsonPath?: string;
  latestSummaryMdPath?: string;
}) => {
  const packPath = options.packPath ?? DEFAULT_PACK_PATH;
  const runJsonPath = options.runJsonPath ?? DEFAULT_RUN_JSON;
  const runMdPath = options.runMdPath ?? DEFAULT_RUN_MD;
  const compatJsonPath = options.compatJsonPath ?? DEFAULT_CHECK_JSON;
  const compatMdPath = options.compatMdPath ?? DEFAULT_CHECK_MD;
  const summaryJsonPath = options.summaryJsonPath ?? DEFAULT_SUMMARY_JSON;
  const summaryMdPath = options.summaryMdPath ?? DEFAULT_SUMMARY_MD;
  const latestSummaryJsonPath = options.latestSummaryJsonPath ?? DEFAULT_LATEST_SUMMARY_JSON;
  const latestSummaryMdPath = options.latestSummaryMdPath ?? DEFAULT_LATEST_SUMMARY_MD;

  const build = buildSemEllipsPublicationOverlayPack({
    registryPath: options.registryPath,
    outPath: packPath,
  });

  const run = await runWarpShadowInjection({
    scenarioPath: packPath,
    outJsonPath: runJsonPath,
    outMdPath: runMdPath,
  });

  const compat = runSemEllipsCompatCheck({
    scenarioPath: packPath,
    runPath: runJsonPath,
    outJsonPath: compatJsonPath,
    outMdPath: compatMdPath,
  });

  const commitPin = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  const payloadBase: Record<string, unknown> = {
    artifactType: 'sem_ellips_publication_overlay/v1',
    generatedOn: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    commitPin,
    policy: {
      lanePosture: 'reference_only',
      reportableUnlock: false,
      blockedReasons: [
        'publication_cross_study_not_paired_instrument_design',
        'reportable_unlock_reserved_for_instrument_export_paired_runs',
      ],
    },
    build,
    run: {
      summary: run.summary,
      outJsonPath: normalizePath(run.outJsonPath),
      outMdPath: normalizePath(run.outMdPath),
    },
    compat: {
      summary: compat.summary,
      outJsonPath: normalizePath(compat.outJsonPath),
      outMdPath: normalizePath(compat.outMdPath),
    },
    paths: {
      packPath: normalizePath(packPath),
      runJsonPath: normalizePath(runJsonPath),
      runMdPath: normalizePath(runMdPath),
      compatJsonPath: normalizePath(compatJsonPath),
      compatMdPath: normalizePath(compatMdPath),
      summaryJsonPath: normalizePath(summaryJsonPath),
      summaryMdPath: normalizePath(summaryMdPath),
    },
  };
  const checksum = checksumPayload(payloadBase);
  const payload = {
    ...payloadBase,
    checksum,
  };

  fs.mkdirSync(path.dirname(summaryJsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(summaryMdPath), { recursive: true });
  fs.writeFileSync(summaryJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(summaryMdPath, `${renderMarkdown(payload)}\n`);
  fs.copyFileSync(summaryJsonPath, latestSummaryJsonPath);
  fs.copyFileSync(summaryMdPath, latestSummaryMdPath);

  return {
    ok: true,
    summaryJsonPath,
    summaryMdPath,
    latestSummaryJsonPath,
    latestSummaryMdPath,
    runSummary: run.summary,
    compatSummary: compat.summary,
    checksum,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSemEllipsPublicationOverlay({
    registryPath: readArgValue('--registry'),
    packPath: readArgValue('--pack'),
    runJsonPath: readArgValue('--run-out'),
    runMdPath: readArgValue('--run-out-md'),
    compatJsonPath: readArgValue('--compat-out'),
    compatMdPath: readArgValue('--compat-out-md'),
    summaryJsonPath: readArgValue('--out'),
    summaryMdPath: readArgValue('--out-md'),
    latestSummaryJsonPath: readArgValue('--latest-out'),
    latestSummaryMdPath: readArgValue('--latest-out-md'),
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
