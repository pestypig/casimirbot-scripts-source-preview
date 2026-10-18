import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BOUNDARY_STATEMENT,
  DEFAULT_EXTERNAL_WORK_DIR,
  DEFAULT_EXTERNAL_WORK_DOC_DIR,
  DEFAULT_PROFILE_PATH,
  DEFAULT_REFERENCE_CAPSULE_PATH,
  ExternalWorkProfile,
  ExternalWorkProfileConfig,
  asNumber,
  asText,
  checksumPayload,
  dottedGet,
  normalizePath,
  readArgValue,
  resolvePathFromRoot,
  stableStringify,
} from './warp-external-work-utils.js';
import { reduceReasonCodes } from './warp-external-work-reason-reducer.js';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_OUT_DIR = DEFAULT_EXTERNAL_WORK_DIR;
const DEFAULT_OUT_DOC_DIR = DEFAULT_EXTERNAL_WORK_DOC_DIR;

type ComparisonResult = {
  id: string;
  mode: string;
  local_reference_path: string;
  external_path: string;
  local_value: unknown;
  external_value: unknown;
  tolerance: number | null;
  delta: number | null;
  pass: boolean | null;
  reason: string | null;
};

const UNKNOWN_TOKENS = new Set(['unknown', 'n/a', 'na', 'not_comparable', 'inconclusive']);

const isUnknownLike = (value: unknown): boolean => {
  if (value == null) return false;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && (UNKNOWN_TOKENS.has(normalized) || normalized.startsWith('unknown:'));
};

const readJson = (filePath: string): any => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const ensureDir = (filePath: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const sanitizeId = (workId: string): string => workId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');

const classify = (rows: ComparisonResult[]): { status: 'compatible' | 'partial' | 'inconclusive'; reasonCodes: string[] } => {
  const evaluated = rows.filter((row) => row.pass !== null);
  const passCount = evaluated.filter((row) => row.pass === true).length;
  const failCount = evaluated.filter((row) => row.pass === false).length;
  const inconclusiveRows = rows.filter((row) => row.pass === null);
  const reasons = [...new Set(rows.map((row) => row.reason).filter(Boolean) as string[])];

  if (evaluated.length === 0) {
    return { status: 'inconclusive', reasonCodes: reasons.length > 0 ? reasons : ['no_evaluable_keys'] };
  }
  if (failCount === 0 && inconclusiveRows.length === 0 && passCount === evaluated.length) {
    return { status: 'compatible', reasonCodes: reasons };
  }
  return {
    status: failCount > 0 || passCount > 0 ? 'partial' : 'inconclusive',
    reasonCodes: reasons,
  };
};

const getByPath = (payload: unknown, dottedPath: string): unknown => {
  const tokens = dottedPath
    .split('.')
    .map((token) => token.trim())
    .filter(Boolean);
  let cursor: unknown = payload;
  for (let index = 0; index < tokens.length; index += 1) {
    if (cursor == null) return undefined;
    const key = tokens[index];
    if (Array.isArray(cursor) && /^\d+$/.test(key)) {
      cursor = cursor[Number(key)];
      continue;
    }
    if (typeof cursor === 'object') {
      const objectCursor = cursor as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(objectCursor, key)) {
        cursor = objectCursor[key];
        continue;
      }
      const remainingPath = tokens.slice(index).join('.');
      if (Object.prototype.hasOwnProperty.call(objectCursor, remainingPath)) {
        return objectCursor[remainingPath];
      }
      return undefined;
    }
    return undefined;
  }
  return cursor;
};

const compareKey = (profile: ExternalWorkProfile, runPayload: any, capsulePayload: any): ComparisonResult[] => {
  const results: ComparisonResult[] = [];
  for (const key of profile.comparison_keys) {
    const localValue = dottedGet(capsulePayload, key.local_reference_path);
    const externalValue = getByPath(runPayload, key.external_path);
    const mode = String(key.mode).toLowerCase();
    const tolerance = asNumber(key.tolerance);

    if (localValue === undefined) {
      results.push({
        id: key.id,
        mode,
        local_reference_path: key.local_reference_path,
        external_path: key.external_path,
        local_value: null,
        external_value: externalValue,
        tolerance: tolerance,
        delta: null,
        pass: null,
        reason: `missing_local_value:${key.id}`,
      });
      continue;
    }

    if (externalValue === undefined) {
      results.push({
        id: key.id,
        mode,
        local_reference_path: key.local_reference_path,
        external_path: key.external_path,
        local_value: localValue,
        external_value: null,
        tolerance: tolerance,
        delta: null,
        pass: null,
        reason: `missing_external_value:${key.id}`,
      });
      continue;
    }

    if (isUnknownLike(localValue) || isUnknownLike(externalValue)) {
      results.push({
        id: key.id,
        mode,
        local_reference_path: key.local_reference_path,
        external_path: key.external_path,
        local_value: localValue,
        external_value: externalValue,
        tolerance: tolerance,
        delta: null,
        pass: null,
        reason: `non_comparable_or_unknown:${key.id}`,
      });
      continue;
    }

    if (mode === 'delta') {
      const localNum = asNumber(localValue);
      const externalNum = asNumber(externalValue);
      if (localNum == null || externalNum == null) {
        results.push({
          id: key.id,
          mode,
          local_reference_path: key.local_reference_path,
          external_path: key.external_path,
          local_value: localValue,
          external_value: externalValue,
          tolerance: tolerance,
          delta: null,
          pass: null,
          reason: `non_numeric_delta:${key.id}`,
        });
        continue;
      }
      const effectiveTolerance = tolerance ?? 0;
      const delta = externalNum - localNum;
      const pass = Math.abs(delta) <= effectiveTolerance;
      results.push({
        id: key.id,
        mode,
        local_reference_path: key.local_reference_path,
        external_path: key.external_path,
        local_value: localNum,
        external_value: externalNum,
        tolerance: effectiveTolerance,
        delta,
        pass,
        reason: pass ? null : `delta_exceeds_tolerance:${key.id}`,
      });
      continue;
    }

    const pass = stableStringify(localValue) === stableStringify(externalValue);
    results.push({
      id: key.id,
      mode,
      local_reference_path: key.local_reference_path,
      external_path: key.external_path,
      local_value: localValue,
      external_value: externalValue,
      tolerance: null,
      delta: null,
      pass,
      reason: pass ? null : `equals_mismatch:${key.id}`,
    });
  }
  return results;
};

const renderMarkdown = (payload: any): string => {
  const rows = (payload.comparisons ?? [])
    .map(
      (row: ComparisonResult) =>
        `| ${row.id} | ${row.mode} | ${row.pass === null ? 'inconclusive' : row.pass ? 'pass' : 'fail'} | ${
          row.delta ?? 'n/a'
        } | ${row.reason ?? 'none'} |`,
    )
    .join('\n');
  return `# External Work Compare (${payload.work_id}, ${DATE_STAMP})

"${payload.boundary_statement}"

## Result
- status: \`${payload.summary.status}\`
- pass_count: \`${payload.summary.pass_count}\`
- fail_count: \`${payload.summary.fail_count}\`
- inconclusive_count: \`${payload.summary.inconclusive_count}\`
- stale_run_vs_capsule: \`${payload.stale_flags.run_vs_capsule}\`
- reduced_reason_codes: \`${(payload.summary.reduced_reason_codes ?? []).join(', ') || 'none'}\`

## Key Results
| key_id | mode | result | delta | reason |
|---|---|---|---|---|
${rows}
`;
};

export const compareExternalWorkProfiles = (options: {
  profilePath?: string;
  capsulePath?: string;
  outDir?: string;
  outDocDir?: string;
  workId?: string;
}) => {
  const profilePath = options.profilePath ?? DEFAULT_PROFILE_PATH;
  const capsulePath = options.capsulePath ?? DEFAULT_REFERENCE_CAPSULE_PATH;
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const outDocDir = options.outDocDir ?? DEFAULT_OUT_DOC_DIR;
  const workIdFilter = options.workId?.trim().toUpperCase() ?? null;

  const config = readJson(resolvePathFromRoot(profilePath)) as ExternalWorkProfileConfig;
  const capsule = readJson(resolvePathFromRoot(capsulePath));
  const localCommitPin = asText(capsule?.commit_pin);
  const profiles = Array.isArray(config.profiles) ? config.profiles : [];
  const selectedProfiles = workIdFilter
    ? profiles.filter((profile) => String(profile.work_id).trim().toUpperCase() === workIdFilter)
    : profiles;

  if (selectedProfiles.length === 0) {
    throw new Error(workIdFilter ? `No profile found for work_id=${workIdFilter}` : 'No external work profiles found.');
  }

  const written: string[] = [];
  const results = selectedProfiles.map((profile) => {
    const id = sanitizeId(profile.work_id);
    const runLatestPath = path.join(outDir, `external-work-run-${id}-latest.json`);
    const compareOutPath = path.join(outDir, `external-work-compare-${id}-${DATE_STAMP}.json`);
    const compareOutMdPath = path.join(outDocDir, `warp-external-work-compare-${id}-${DATE_STAMP}.md`);
    const compareLatestPath = path.join(outDir, `external-work-compare-${id}-latest.json`);
    const compareLatestMdPath = path.join(outDocDir, `warp-external-work-compare-${id}-latest.md`);

    const blockers: string[] = [];
    let comparisons: ComparisonResult[] = [];
    let runPayload: any = null;
    if (!fs.existsSync(resolvePathFromRoot(runLatestPath))) {
      blockers.push('run_artifact_missing');
    } else {
      runPayload = readJson(resolvePathFromRoot(runLatestPath));
      comparisons = compareKey(profile, runPayload, capsule);
    }

    if (comparisons.length === 0 && blockers.length > 0) {
      comparisons = profile.comparison_keys.map((key) => ({
        id: key.id,
        mode: key.mode,
        local_reference_path: key.local_reference_path,
        external_path: key.external_path,
        local_value: dottedGet(capsule, key.local_reference_path) ?? null,
        external_value: null,
        tolerance: asNumber(key.tolerance),
        delta: null,
        pass: null,
        reason: 'run_artifact_missing',
      }));
    }

    const passCount = comparisons.filter((row) => row.pass === true).length;
    const failCount = comparisons.filter((row) => row.pass === false).length;
    const inconclusiveCount = comparisons.filter((row) => row.pass === null).length;
    const classification = classify(comparisons);
    const runCommitPin = asText(runPayload?.commit_pin);
    const staleRunVsCapsule = Boolean(localCommitPin && runCommitPin && localCommitPin !== runCommitPin);
    if (staleRunVsCapsule) {
      classification.reasonCodes.push('stale_run_commit_pin');
    }

    const rawReasonCodes = [...new Set([...classification.reasonCodes, ...blockers])];
    const reducedReasons = reduceReasonCodes(rawReasonCodes);
    const payloadBase: Record<string, unknown> = {
      artifact_type: 'external_work_compare/v1',
      generated_on: DATE_STAMP,
      generated_at: new Date().toISOString(),
      boundary_statement: BOUNDARY_STATEMENT,
      work_id: profile.work_id,
      title: profile.title,
      profile_path: normalizePath(profilePath),
      run_artifact: normalizePath(runLatestPath),
      capsule_path: normalizePath(capsulePath),
      local_commit_pin: localCommitPin,
      run_commit_pin: runCommitPin,
      stale_flags: {
        run_vs_capsule: staleRunVsCapsule,
      },
      posture: profile.posture,
      comparisons,
      summary: {
        status: classification.status,
        pass_count: passCount,
        fail_count: failCount,
        inconclusive_count: inconclusiveCount,
        reason_codes: rawReasonCodes,
        reduced_reason_codes: reducedReasons.reduced_reason_codes,
        reduced_reason_counts: reducedReasons.reduced_reason_counts,
        reason_reducer_version: reducedReasons.reason_reducer_version,
      },
      blockers,
      reduced_reasons: reducedReasons.reduced_reasons,
    };
    const checksum = checksumPayload(payloadBase);
    const payload = { ...payloadBase, checksum };
    const markdown = renderMarkdown(payload);

    ensureDir(compareOutPath);
    ensureDir(compareOutMdPath);
    ensureDir(compareLatestPath);
    ensureDir(compareLatestMdPath);
    fs.writeFileSync(compareOutPath, `${JSON.stringify(payload, null, 2)}\n`);
    fs.writeFileSync(compareOutMdPath, `${markdown}\n`);
    fs.writeFileSync(compareLatestPath, `${JSON.stringify(payload, null, 2)}\n`);
    fs.writeFileSync(compareLatestMdPath, `${markdown}\n`);
    written.push(compareOutPath);
    return {
      work_id: profile.work_id,
      out_json: normalizePath(compareOutPath),
      out_md: normalizePath(compareOutMdPath),
      latest_json: normalizePath(compareLatestPath),
      latest_md: normalizePath(compareLatestMdPath),
      status: classification.status,
      reason_codes: payload.summary.reason_codes,
    };
  });

  return {
    ok: true,
    generatedOn: DATE_STAMP,
    profilePath: normalizePath(profilePath),
    capsulePath: normalizePath(capsulePath),
    compareArtifacts: written.map((filePath) => normalizePath(filePath)),
    results,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = compareExternalWorkProfiles({
    profilePath: readArgValue('--profiles') ?? DEFAULT_PROFILE_PATH,
    capsulePath: readArgValue('--capsule') ?? DEFAULT_REFERENCE_CAPSULE_PATH,
    outDir: readArgValue('--out-dir') ?? DEFAULT_OUT_DIR,
    outDocDir: readArgValue('--out-doc-dir') ?? DEFAULT_OUT_DOC_DIR,
    workId: readArgValue('--work-id'),
  });
  console.log(JSON.stringify(result, null, 2));
}
