import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runWarpShadowInjection } from './warp-shadow-injection-runner.js';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const FULL_SOLVE_DIR = path.join('artifacts', 'research', 'full-solve');
const DOC_AUDIT_DIR = path.join('docs', 'audits', 'research');

const DEFAULT_PROFILE_PATH = path.join('configs', 'warp-casimir-tile-recommended-run-profile.v1.json');
const DEFAULT_OUT_JSON = path.join(FULL_SOLVE_DIR, `recommended-profile-replay-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join(DOC_AUDIT_DIR, `warp-recommended-profile-replay-${DATE_STAMP}.md`);
const DEFAULT_LATEST_JSON = path.join(FULL_SOLVE_DIR, 'recommended-profile-replay-latest.json');
const DEFAULT_LATEST_MD = path.join(DOC_AUDIT_DIR, 'warp-recommended-profile-replay-latest.md');

const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

type LaneId = 'q_spoiling' | 'nanogap' | 'timing' | 'sem_ellipsometry';

type LaneConfig = {
  scenario_pack_path?: string;
  reportableReady_expected?: boolean;
  blockedReasons_expected?: string[];
};

type RecommendedRunProfile = {
  profile_id?: string;
  boundaryStatement?: string;
  lane_reference_targets?: Record<string, LaneConfig>;
  notes?: string[];
};

type LaneReplayResult = {
  laneId: LaneId;
  scenarioPackPath: string | null;
  runJsonPath: string | null;
  runMdPath: string | null;
  status: 'pass' | 'missing_pack_path' | 'missing_pack_file' | 'error';
  error: string | null;
  summary: {
    scenarioCount: number;
    compatible: number;
    partial: number;
    incompatible: number;
    error: number;
  } | null;
  expectedReportableReady: boolean | null;
  scenarioPackReportableReady: boolean | null;
  scenarioPackBlockedReasons: string[];
};

const LANE_ORDER: Array<{ laneId: LaneId; shortTag: string }> = [
  { laneId: 'q_spoiling', shortTag: 'qs' },
  { laneId: 'nanogap', shortTag: 'ng' },
  { laneId: 'timing', shortTag: 'ti' },
  { laneId: 'sem_ellipsometry', shortTag: 'se' },
];

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const normalizePath = (filePath: string): string => filePath.replace(/\\/g, '/');

const ensureDirForFile = (filePath: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const readJson = <T>(filePath: string): T => JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;

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
  const volatile = new Set(['generated_at', 'checksum']);
  const sanitize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
    if (value && typeof value === 'object') {
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(source)) {
        if (volatile.has(key)) continue;
        out[key] = sanitize(source[key]);
      }
      return out;
    }
    return value;
  };
  const canonical = JSON.stringify(objectWithSortedKeys(sanitize(payload)));
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

const toBooleanOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

const loadScenarioPackReadiness = (
  scenarioPackPath: string,
): { reportableReady: boolean | null; blockedReasons: string[] } => {
  const raw = readJson<Record<string, unknown>>(scenarioPackPath);
  const candidateProfiles = [
    raw.reportableReferenceProfile,
    raw.preRegistrationProfile,
    raw.reportableProfile,
  ] as Array<Record<string, unknown> | undefined>;
  const profile = candidateProfiles.find((entry) => Boolean(entry)) ?? null;
  if (!profile) {
    return { reportableReady: null, blockedReasons: [] };
  }

  const blockedReasons = Array.isArray(profile.blockedReasons)
    ? profile.blockedReasons
        .map((value) => String(value ?? '').trim())
        .filter((value) => value.length > 0)
    : [];

  return {
    reportableReady: toBooleanOrNull(profile.reportableReady),
    blockedReasons,
  };
};

const renderMarkdown = (payload: {
  generated_on: string;
  boundaryStatement: string;
  profile_id: string;
  profile_path: string;
  commit_pin: string;
  verdict: string;
  lane_results: LaneReplayResult[];
  blockers: string[];
  checksum: string;
}): string => {
  const rows = payload.lane_results
    .map((lane) => {
      const summary = lane.summary;
      const summaryText = summary
        ? `S=${summary.scenarioCount}, C=${summary.compatible}, P=${summary.partial}, I=${summary.incompatible}, E=${summary.error}`
        : 'n/a';
      const blocked = lane.scenarioPackBlockedReasons.length > 0 ? lane.scenarioPackBlockedReasons.join(', ') : 'none';
      return `| ${lane.laneId} | ${lane.status} | ${lane.expectedReportableReady ?? 'n/a'} | ${lane.scenarioPackReportableReady ?? 'n/a'} | ${summaryText} | ${blocked} |`;
    })
    .join('\n');

  const blockersRows =
    payload.blockers.length > 0 ? payload.blockers.map((item) => `| ${item} |`).join('\n') : '| none |';

  return `# Recommended Profile Replay (${payload.generated_on})

"${payload.boundaryStatement}"

## Summary
- profile_id: \`${payload.profile_id}\`
- profile_path: \`${payload.profile_path}\`
- commit_pin: \`${payload.commit_pin}\`
- verdict: \`${payload.verdict}\`
- checksum: \`${payload.checksum}\`

## Lane Results
| lane | status | expected_reportable_ready | scenario_pack_reportable_ready | run_summary | scenario_pack_blocked_reasons |
|---|---|---:|---:|---|---|
${rows}

## Blockers
| blocker |
|---|
${blockersRows}
`;
};

export const runRecommendedProfileReplay = async (options: {
  profilePath?: string;
  outJsonPath?: string;
  outMdPath?: string;
  outLatestJsonPath?: string;
  outLatestMdPath?: string;
}) => {
  const profilePath = options.profilePath ?? DEFAULT_PROFILE_PATH;
  const outJsonPath = options.outJsonPath ?? DEFAULT_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_OUT_MD;
  const outLatestJsonPath = options.outLatestJsonPath ?? DEFAULT_LATEST_JSON;
  const outLatestMdPath = options.outLatestMdPath ?? DEFAULT_LATEST_MD;

  const profile = readJson<RecommendedRunProfile>(profilePath);
  const laneTargets = profile.lane_reference_targets ?? {};

  const laneResults: LaneReplayResult[] = [];
  const blockers: string[] = [];

  for (const { laneId, shortTag } of LANE_ORDER) {
    const laneConfig = laneTargets[laneId] ?? {};
    const scenarioPackPathRaw = laneConfig.scenario_pack_path;
    const scenarioPackPath = scenarioPackPathRaw ? normalizePath(scenarioPackPathRaw) : null;

    if (!scenarioPackPath) {
      const blocker = `${laneId}:missing_scenario_pack_path`;
      blockers.push(blocker);
      laneResults.push({
        laneId,
        scenarioPackPath: null,
        runJsonPath: null,
        runMdPath: null,
        status: 'missing_pack_path',
        error: blocker,
        summary: null,
        expectedReportableReady: toBooleanOrNull(laneConfig.reportableReady_expected),
        scenarioPackReportableReady: null,
        scenarioPackBlockedReasons: [],
      });
      continue;
    }

    if (!fs.existsSync(scenarioPackPath)) {
      const blocker = `${laneId}:missing_scenario_pack_file:${scenarioPackPath}`;
      blockers.push(blocker);
      laneResults.push({
        laneId,
        scenarioPackPath,
        runJsonPath: null,
        runMdPath: null,
        status: 'missing_pack_file',
        error: blocker,
        summary: null,
        expectedReportableReady: toBooleanOrNull(laneConfig.reportableReady_expected),
        scenarioPackReportableReady: null,
        scenarioPackBlockedReasons: [],
      });
      continue;
    }

    const runJsonPath = path.join(FULL_SOLVE_DIR, `shadow-injection-run-${shortTag}-recommended-profile-${DATE_STAMP}.json`);
    const runMdPath = path.join(DOC_AUDIT_DIR, `warp-shadow-injection-run-${shortTag}-recommended-profile-${DATE_STAMP}.md`);

    try {
      const runResult = await runWarpShadowInjection({
        scenarioPath: scenarioPackPath,
        outJsonPath: runJsonPath,
        outMdPath: runMdPath,
      });
      const runPayload = readJson<{ summary?: LaneReplayResult['summary'] }>(runJsonPath);
      const readiness = loadScenarioPackReadiness(scenarioPackPath);

      laneResults.push({
        laneId,
        scenarioPackPath,
        runJsonPath: normalizePath(runResult.outJsonPath),
        runMdPath: normalizePath(runResult.outMdPath),
        status: 'pass',
        error: null,
        summary:
          runPayload.summary ??
          ({
            scenarioCount: runResult.summary.scenarioCount,
            compatible: runResult.summary.compatible,
            partial: runResult.summary.partial,
            incompatible: runResult.summary.incompatible,
            error: runResult.summary.error,
          } as LaneReplayResult['summary']),
        expectedReportableReady: toBooleanOrNull(laneConfig.reportableReady_expected),
        scenarioPackReportableReady: readiness.reportableReady,
        scenarioPackBlockedReasons: readiness.blockedReasons,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const blocker = `${laneId}:run_error:${message}`;
      blockers.push(blocker);
      laneResults.push({
        laneId,
        scenarioPackPath,
        runJsonPath: normalizePath(runJsonPath),
        runMdPath: normalizePath(runMdPath),
        status: 'error',
        error: message,
        summary: null,
        expectedReportableReady: toBooleanOrNull(laneConfig.reportableReady_expected),
        scenarioPackReportableReady: null,
        scenarioPackBlockedReasons: [],
      });
    }
  }

  const commitPin = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  const passCount = laneResults.filter((entry) => entry.status === 'pass').length;
  const verdict = blockers.length === 0 && passCount === LANE_ORDER.length ? 'pass' : 'partial';

  const payload: Record<string, unknown> = {
    artifact_type: 'recommended_profile_replay/v1',
    generated_on: DATE_STAMP,
    generated_at: new Date().toISOString(),
    boundaryStatement: profile.boundaryStatement ?? BOUNDARY_STATEMENT,
    profile_id: profile.profile_id ?? 'warp-casimir-tile-recommended-run-profile-v1',
    profile_path: normalizePath(profilePath),
    commit_pin: commitPin,
    verdict,
    lane_counts: {
      total: laneResults.length,
      pass: passCount,
      blocked: laneResults.filter((entry) => entry.status !== 'pass').length,
    },
    lane_results: laneResults,
    blockers,
    notes: Array.isArray(profile.notes) ? profile.notes : [],
  };
  payload.checksum = checksumPayload(payload);

  ensureDirForFile(outJsonPath);
  fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  ensureDirForFile(outMdPath);
  fs.writeFileSync(
    outMdPath,
    `${renderMarkdown({
      generated_on: DATE_STAMP,
      boundaryStatement: String(payload.boundaryStatement),
      profile_id: String(payload.profile_id),
      profile_path: String(payload.profile_path),
      commit_pin: commitPin,
      verdict,
      lane_results: laneResults,
      blockers,
      checksum: String(payload.checksum),
    })}\n`,
  );

  ensureDirForFile(outLatestJsonPath);
  fs.copyFileSync(outJsonPath, outLatestJsonPath);
  ensureDirForFile(outLatestMdPath);
  fs.copyFileSync(outMdPath, outLatestMdPath);

  return {
    ok: true,
    outJsonPath: normalizePath(outJsonPath),
    outMdPath: normalizePath(outMdPath),
    outLatestJsonPath: normalizePath(outLatestJsonPath),
    outLatestMdPath: normalizePath(outLatestMdPath),
    verdict,
    laneCounts: payload.lane_counts,
    blockers,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const profilePath = readArgValue('--profile') ?? DEFAULT_PROFILE_PATH;
  const outJsonPath = readArgValue('--out') ?? DEFAULT_OUT_JSON;
  const outMdPath = readArgValue('--out-md') ?? DEFAULT_OUT_MD;
  const outLatestJsonPath = readArgValue('--out-latest') ?? DEFAULT_LATEST_JSON;
  const outLatestMdPath = readArgValue('--out-latest-md') ?? DEFAULT_LATEST_MD;

  runRecommendedProfileReplay({ profilePath, outJsonPath, outMdPath, outLatestJsonPath, outLatestMdPath })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
