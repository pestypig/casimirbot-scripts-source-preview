import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BOUNDARY_STATEMENT,
  DEFAULT_EXTERNAL_WORK_DIR,
  DEFAULT_EXTERNAL_WORK_DOC_DIR,
  DEFAULT_PROFILE_PATH,
  ExternalWorkProfileConfig,
  asText,
  checksumPayload,
  normalizePath,
  readArgValue,
  resolvePathFromRoot,
} from './warp-external-work-utils.js';
import { reduceReasonCodes } from './warp-external-work-reason-reducer.js';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_OUT_JSON = path.join(DEFAULT_EXTERNAL_WORK_DIR, `external-work-comparison-matrix-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join(
  DEFAULT_EXTERNAL_WORK_DOC_DIR,
  `warp-external-work-comparison-matrix-${DATE_STAMP}.md`,
);
const DEFAULT_LATEST_JSON = path.join(DEFAULT_EXTERNAL_WORK_DIR, 'external-work-comparison-matrix-latest.json');
const DEFAULT_LATEST_MD = path.join(DEFAULT_EXTERNAL_WORK_DOC_DIR, 'warp-external-work-comparison-matrix-latest.md');

const readJson = (filePath: string): any => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const ensureDir = (filePath: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const sanitizeId = (workId: string): string => workId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');

const sanitizeReasonCounts = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== 'object') return {};
  const counts: Record<string, number> = {};
  for (const [key, rawCount] of Object.entries(value as Record<string, unknown>)) {
    const count = Number(rawCount);
    if (Number.isFinite(count) && count > 0) counts[key] = count;
  }
  return counts;
};

const formatReasonCounts = (counts: Record<string, number>): string => {
  const entries = Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (entries.length === 0) return 'none';
  return entries.map(([reason, count]) => `${reason}=${count}`).join(', ');
};

const renderMarkdown = (payload: any): string => {
  const rows = payload.works
    .map(
      (work: any) =>
        `| ${work.work_id} | ${work.status} | ${work.pass_count} | ${work.fail_count} | ${work.inconclusive_count} | ${
          work.stale_run_vs_capsule ? 'true' : 'false'
        } | ${work.reason_codes.join(', ') || 'none'} | ${work.reduced_reason_codes.join(', ') || 'none'} |`,
    )
    .join('\n');
  return `# External Work Comparison Matrix (${DATE_STAMP})

"${BOUNDARY_STATEMENT}"

## Summary
- total: \`${payload.summary_counts.total}\`
- compatible: \`${payload.summary_counts.compatible}\`
- partial: \`${payload.summary_counts.partial}\`
- inconclusive: \`${payload.summary_counts.inconclusive}\`
- stale_count: \`${payload.stale_flags.stale_count}\`
- reduced_reason_counts: \`${formatReasonCounts(payload.reduced_reason_counts ?? {})}\`

## Works
| work_id | status | pass | fail | inconclusive | stale | reason_codes | reduced_reason_codes |
|---|---|---:|---:|---:|---|---|---|
${rows}
`;
};

export const buildExternalWorkMatrix = (options: {
  profilePath?: string;
  outJsonPath?: string;
  outMdPath?: string;
  latestJsonPath?: string;
  latestMdPath?: string;
}) => {
  const profilePath = options.profilePath ?? DEFAULT_PROFILE_PATH;
  const outJsonPath = options.outJsonPath ?? DEFAULT_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_OUT_MD;
  const latestJsonPath = options.latestJsonPath ?? DEFAULT_LATEST_JSON;
  const latestMdPath = options.latestMdPath ?? DEFAULT_LATEST_MD;

  const config = readJson(resolvePathFromRoot(profilePath)) as ExternalWorkProfileConfig;
  const profiles = Array.isArray(config.profiles) ? config.profiles : [];

  const works = profiles
    .map((profile) => {
      const id = sanitizeId(profile.work_id);
      const comparePath = path.join(DEFAULT_EXTERNAL_WORK_DIR, `external-work-compare-${id}-latest.json`);
      const compareResolved = resolvePathFromRoot(comparePath);
      if (!fs.existsSync(compareResolved)) {
        const reducedReasons = reduceReasonCodes(['compare_artifact_missing']);
        return {
          work_id: profile.work_id,
          title: profile.title,
          compare_path: normalizePath(comparePath),
          status: 'inconclusive',
          pass_count: 0,
          fail_count: 0,
          inconclusive_count: 0,
          reason_codes: ['compare_artifact_missing'],
          reduced_reason_codes: reducedReasons.reduced_reason_codes,
          reduced_reason_counts: reducedReasons.reduced_reason_counts,
          reason_reducer_version: reducedReasons.reason_reducer_version,
          stale_run_vs_capsule: false,
        };
      }

      const comparePayload = readJson(compareResolved);
      const reasonCodes = Array.isArray(comparePayload?.summary?.reason_codes) ? comparePayload.summary.reason_codes : [];
      const reducedReasonsFromCompare = sanitizeReasonCounts(comparePayload?.summary?.reduced_reason_counts);
      const reducedReasonSummary =
        Object.keys(reducedReasonsFromCompare).length > 0
          ? {
              reason_reducer_version: String(comparePayload?.summary?.reason_reducer_version ?? '1.0.0'),
              reduced_reason_codes: Object.keys(reducedReasonsFromCompare).sort((a, b) => a.localeCompare(b)),
              reduced_reason_counts: reducedReasonsFromCompare,
            }
          : reduceReasonCodes(reasonCodes);
      return {
        work_id: profile.work_id,
        title: profile.title,
        compare_path: normalizePath(comparePath),
        status: asText(comparePayload?.summary?.status) ?? 'inconclusive',
        pass_count: Number(comparePayload?.summary?.pass_count ?? 0),
        fail_count: Number(comparePayload?.summary?.fail_count ?? 0),
        inconclusive_count: Number(comparePayload?.summary?.inconclusive_count ?? 0),
        reason_codes: reasonCodes,
        reduced_reason_codes: reducedReasonSummary.reduced_reason_codes,
        reduced_reason_counts: reducedReasonSummary.reduced_reason_counts,
        reason_reducer_version: reducedReasonSummary.reason_reducer_version,
        stale_run_vs_capsule: comparePayload?.stale_flags?.run_vs_capsule === true,
      };
    })
    .sort((a, b) => String(a.work_id).localeCompare(String(b.work_id)));

  const summary_counts = {
    total: works.length,
    compatible: works.filter((work) => work.status === 'compatible').length,
    partial: works.filter((work) => work.status === 'partial').length,
    inconclusive: works.filter((work) => work.status === 'inconclusive').length,
  };

  const inconclusive_reasons: Record<string, number> = {};
  const reduced_reason_counts: Record<string, number> = {};
  for (const work of works) {
    if (work.status !== 'inconclusive' && work.status !== 'partial') continue;
    for (const reason of work.reason_codes) {
      inconclusive_reasons[reason] = (inconclusive_reasons[reason] ?? 0) + 1;
    }
    for (const [reason, count] of Object.entries(work.reduced_reason_counts ?? {})) {
      reduced_reason_counts[reason] = (reduced_reason_counts[reason] ?? 0) + Number(count);
    }
  }

  const stale_flags = {
    stale_count: works.filter((work) => work.stale_run_vs_capsule).length,
    works: works.filter((work) => work.stale_run_vs_capsule).map((work) => work.work_id),
  };

  const payloadBase: Record<string, unknown> = {
    artifact_type: 'external_work_matrix/v1',
    generated_on: DATE_STAMP,
    generated_at: new Date().toISOString(),
    boundary_statement: BOUNDARY_STATEMENT,
    profile_path: normalizePath(profilePath),
    works,
    summary_counts,
    inconclusive_reasons,
    reduced_reason_counts,
    stale_flags,
  };
  const checksum = checksumPayload(payloadBase);
  const payload = { ...payloadBase, checksum };
  const markdown = renderMarkdown(payload);

  ensureDir(outJsonPath);
  ensureDir(outMdPath);
  ensureDir(latestJsonPath);
  ensureDir(latestMdPath);
  fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(outMdPath, `${markdown}\n`);
  fs.writeFileSync(latestJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(latestMdPath, `${markdown}\n`);

  return {
    ok: true,
    outJsonPath,
    outMdPath,
    latestJsonPath,
    latestMdPath,
    summary: summary_counts,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = buildExternalWorkMatrix({
    profilePath: readArgValue('--profiles') ?? DEFAULT_PROFILE_PATH,
    outJsonPath: readArgValue('--out') ?? DEFAULT_OUT_JSON,
    outMdPath: readArgValue('--out-md') ?? DEFAULT_OUT_MD,
    latestJsonPath: readArgValue('--latest-json') ?? DEFAULT_LATEST_JSON,
    latestMdPath: readArgValue('--latest-md') ?? DEFAULT_LATEST_MD,
  });
  console.log(JSON.stringify(result, null, 2));
}
