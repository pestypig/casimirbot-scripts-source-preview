import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  BOUNDARY_STATEMENT,
  DEFAULT_CITATION_PACK_PATH,
  DEFAULT_EXTERNAL_WORK_DIR,
  DEFAULT_EXTERNAL_WORK_DOC_DIR,
  DEFAULT_PROFILE_PATH,
  ExternalWorkProfile,
  ExternalWorkProfileConfig,
  asText,
  checksumPayload,
  consolidatedSourceClass,
  conservativeConfidenceTier,
  dottedGet,
  normalizePath,
  objectWithSortedKeys,
  parseCitationSourceMeta,
  readArgValue,
  resolvePathFromRoot,
  stableStringify,
} from './warp-external-work-utils.js';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_OUT_DIR = DEFAULT_EXTERNAL_WORK_DIR;
const DEFAULT_OUT_DOC_DIR = DEFAULT_EXTERNAL_WORK_DOC_DIR;

type TrackStatus = 'pass' | 'blocked' | 'not_available';

type RunBlocker = {
  code: string;
  detail: string;
  path?: string | null;
};

const readJson = (filePath: string): any => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const ensureDir = (filePath: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const headCommit = (): string => execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();

const shellQuote = (value: string): string => {
  if (/^[A-Za-z0-9_./:=,-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
};

const runTsx = (scriptPath: string, args: string[]): { ok: boolean; command: string; error?: string } => {
  const command = ['npx', 'tsx', scriptPath, ...args].map(shellQuote).join(' ');
  try {
    execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, command };
  } catch (error) {
    const execError = error as {
      message?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      status?: number;
    };
    const stdout = typeof execError.stdout === 'string' ? execError.stdout : execError.stdout?.toString('utf8') ?? '';
    const stderr = typeof execError.stderr === 'string' ? execError.stderr : execError.stderr?.toString('utf8') ?? '';
    return {
      ok: false,
      command,
      error: `${execError.message ?? ''}\n${stdout}\n${stderr}`.trim() || `exit_code=${execError.status ?? 'unknown'}`,
    };
  }
};

const countClassifications = (results: Array<{ classification?: string }> | undefined): Record<string, number> => {
  const counts: Record<string, number> = {
    compatible: 0,
    partial: 0,
    incompatible: 0,
    error: 0,
  };
  for (const row of results ?? []) {
    const key = String(row.classification ?? '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(counts, key)) {
      counts[key] += 1;
    }
  }
  return counts;
};

const renderMarkdown = (payload: any): string => {
  const blockerRows =
    payload.blockers.length === 0
      ? '| none | none | n/a |\n'
      : payload.blockers
          .map((blocker: any) => `| ${blocker.code} | ${blocker.path ?? 'n/a'} | ${blocker.detail} |`)
          .join('\n');

  const mirror = payload.mirror_track ?? {};
  const method = payload.method_track ?? {};
  return `# External Work Run (${payload.work_id}, ${DATE_STAMP})

"${payload.boundary_statement}"

## Identity
- artifact_type: \`${payload.artifact_type}\`
- work_id: \`${payload.work_id}\`
- title: ${payload.title}
- commit_pin: \`${payload.commit_pin}\`
- profile_commit_pin: \`${payload.profile_commit_pin}\`
- source_class: \`${payload.source_class}\`
- confidence_tier: \`${payload.confidence_tier}\`
- recompute_ready: \`${payload.recompute_ready}\`

## Mirror Track
- status: \`${mirror.status}\`
- lane: \`${mirror.lane ?? 'n/a'}\`
- scenario_pack: \`${mirror.scenario_pack ?? 'n/a'}\`
- run_artifact: \`${mirror.artifacts?.run_json ?? 'n/a'}\`
- compat_artifact: \`${mirror.artifacts?.compat_json ?? 'n/a'}\`
- deterministic_repeat_pass: \`${mirror.determinism?.pass === true}\`

## Method Track
- status: \`${method.status}\`
- script: \`${method.script ?? 'n/a'}\`
- output_artifact: \`${method.artifacts?.out_json ?? 'n/a'}\`
- deterministic_repeat_pass: \`${method.determinism?.pass === true}\`

## Blockers
| code | path | detail |
|---|---|---|
${blockerRows}
`;
};

const classifyRecomputeReady = (mirrorStatus: TrackStatus, methodStatus: TrackStatus, blockerCount: number): string => {
  if (blockerCount > 0) return 'blocked';
  if (mirrorStatus === 'pass' && methodStatus === 'pass') return 'full';
  if (mirrorStatus === 'pass' || methodStatus === 'pass') return 'partial';
  return 'blocked';
};

const buildProfilePaths = (workId: string, outDir: string, outDocDir: string) => {
  const id = workId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const runJson = path.join(outDir, `external-work-run-${id}-${DATE_STAMP}.json`);
  const runMd = path.join(outDocDir, `warp-external-work-run-${id}-${DATE_STAMP}.md`);
  const latestRunJson = path.join(outDir, `external-work-run-${id}-latest.json`);
  const latestRunMd = path.join(outDocDir, `warp-external-work-run-${id}-latest.md`);
  const mirrorRunJson = path.join(outDir, `shadow-injection-run-external-${id}-${DATE_STAMP}.json`);
  const mirrorRunMd = path.join(outDocDir, `warp-shadow-injection-run-external-${id}-${DATE_STAMP}.md`);
  const mirrorRunRepeatJson = path.join(outDir, `shadow-injection-run-external-${id}-${DATE_STAMP}-repeat.json`);
  const mirrorRunRepeatMd = path.join(outDocDir, `warp-shadow-injection-run-external-${id}-${DATE_STAMP}-repeat.md`);
  const mirrorCompatJson = path.join(outDir, `external-work-compat-${id}-${DATE_STAMP}.json`);
  const mirrorCompatMd = path.join(outDocDir, `warp-external-work-compat-${id}-${DATE_STAMP}.md`);
  const mirrorCompatRepeatJson = path.join(outDir, `external-work-compat-${id}-${DATE_STAMP}-repeat.json`);
  const mirrorCompatRepeatMd = path.join(outDocDir, `warp-external-work-compat-${id}-${DATE_STAMP}-repeat.md`);
  const methodOutJson = path.join(outDir, `external-work-method-${id}-${DATE_STAMP}.json`);
  const methodOutMd = path.join(outDocDir, `warp-external-work-method-${id}-${DATE_STAMP}.md`);
  const methodOutRepeatJson = path.join(outDir, `external-work-method-${id}-${DATE_STAMP}-repeat.json`);
  const methodOutRepeatMd = path.join(outDocDir, `warp-external-work-method-${id}-${DATE_STAMP}-repeat.md`);
  return {
    runJson,
    runMd,
    latestRunJson,
    latestRunMd,
    mirrorRunJson,
    mirrorRunMd,
    mirrorRunRepeatJson,
    mirrorRunRepeatMd,
    mirrorCompatJson,
    mirrorCompatMd,
    mirrorCompatRepeatJson,
    mirrorCompatRepeatMd,
    methodOutJson,
    methodOutMd,
    methodOutRepeatJson,
    methodOutRepeatMd,
  };
};

const runMirrorTrack = (
  profile: ExternalWorkProfile,
  paths: ReturnType<typeof buildProfilePaths>,
): { status: TrackStatus; payload: Record<string, unknown>; blockers: RunBlocker[] } => {
  const blockers: RunBlocker[] = [];
  const mirror = profile.track_mirror;
  if (!mirror.enabled) {
    return {
      status: 'not_available',
      payload: {
        status: 'not_available',
        lane: mirror.lane ?? null,
        reason: mirror.reason ?? 'mirror track disabled by profile',
      },
      blockers,
    };
  }

  const lane = mirror.lane ?? '';
  const scenarioPack = mirror.scenario_pack ?? '';
  const checkerScript = mirror.checker_script ?? '';
  const requiredAnchors = mirror.required_anchors ?? [];

  if (!scenarioPack) {
    blockers.push({ code: 'mirror_missing_scenario_pack', detail: 'scenario_pack is required.' });
    return { status: 'blocked', payload: { status: 'blocked', lane }, blockers };
  }
  if (!checkerScript) {
    blockers.push({ code: 'mirror_missing_checker_script', detail: 'checker_script is required.' });
    return { status: 'blocked', payload: { status: 'blocked', lane, scenario_pack: scenarioPack }, blockers };
  }

  const scenarioResolved = resolvePathFromRoot(scenarioPack);
  const checkerResolved = resolvePathFromRoot(checkerScript);
  if (!fs.existsSync(scenarioResolved)) {
    blockers.push({ code: 'mirror_scenario_pack_not_found', detail: 'scenario_pack does not exist.', path: scenarioPack });
    return { status: 'blocked', payload: { status: 'blocked', lane, scenario_pack: scenarioPack }, blockers };
  }
  if (!fs.existsSync(checkerResolved)) {
    blockers.push({ code: 'mirror_checker_not_found', detail: 'checker_script does not exist.', path: checkerScript });
    return { status: 'blocked', payload: { status: 'blocked', lane, scenario_pack: scenarioPack }, blockers };
  }

  const scenarioPayload = readJson(scenarioResolved) as { scenarios?: Array<{ registryRefs?: string[] }> };
  const refs = new Set<string>();
  for (const scenario of scenarioPayload.scenarios ?? []) {
    for (const ref of scenario.registryRefs ?? []) refs.add(String(ref).toUpperCase());
  }
  const missingAnchors = requiredAnchors.filter((anchor) => !refs.has(String(anchor).toUpperCase()));
  if (missingAnchors.length > 0) {
    blockers.push({
      code: 'mirror_missing_required_anchors',
      detail: `required anchors missing from scenario pack: ${missingAnchors.join(', ')}`,
      path: scenarioPack,
    });
    return {
      status: 'blocked',
      payload: {
        status: 'blocked',
        lane,
        scenario_pack: scenarioPack,
        missing_anchors: missingAnchors,
      },
      blockers,
    };
  }

  const runMain = runTsx('scripts/warp-shadow-injection-runner.ts', [
    '--scenarios',
    scenarioPack,
    '--out',
    paths.mirrorRunJson,
    '--out-md',
    paths.mirrorRunMd,
  ]);
  if (!runMain.ok) {
    blockers.push({
      code: 'mirror_runner_failed',
      detail: runMain.error ?? 'runner command failed',
      path: runMain.command,
    });
    return {
      status: 'blocked',
      payload: {
        status: 'blocked',
        lane,
        scenario_pack: scenarioPack,
        command: runMain.command,
      },
      blockers,
    };
  }

  const runRepeat = runTsx('scripts/warp-shadow-injection-runner.ts', [
    '--scenarios',
    scenarioPack,
    '--out',
    paths.mirrorRunRepeatJson,
    '--out-md',
    paths.mirrorRunRepeatMd,
  ]);
  if (!runRepeat.ok) {
    blockers.push({
      code: 'mirror_runner_repeat_failed',
      detail: runRepeat.error ?? 'repeat runner command failed',
      path: runRepeat.command,
    });
    return {
      status: 'blocked',
      payload: {
        status: 'blocked',
        lane,
        scenario_pack: scenarioPack,
      },
      blockers,
    };
  }

  const checkMain = runTsx(checkerScript, [
    '--scenarios',
    scenarioPack,
    '--run',
    paths.mirrorRunJson,
    '--out',
    paths.mirrorCompatJson,
    '--out-md',
    paths.mirrorCompatMd,
  ]);
  if (!checkMain.ok) {
    blockers.push({
      code: 'mirror_checker_failed',
      detail: checkMain.error ?? 'checker command failed',
      path: checkMain.command,
    });
    return {
      status: 'blocked',
      payload: {
        status: 'blocked',
        lane,
        scenario_pack: scenarioPack,
      },
      blockers,
    };
  }

  const checkRepeat = runTsx(checkerScript, [
    '--scenarios',
    scenarioPack,
    '--run',
    paths.mirrorRunRepeatJson,
    '--out',
    paths.mirrorCompatRepeatJson,
    '--out-md',
    paths.mirrorCompatRepeatMd,
  ]);
  if (!checkRepeat.ok) {
    blockers.push({
      code: 'mirror_checker_repeat_failed',
      detail: checkRepeat.error ?? 'repeat checker command failed',
      path: checkRepeat.command,
    });
    return {
      status: 'blocked',
      payload: {
        status: 'blocked',
        lane,
        scenario_pack: scenarioPack,
      },
      blockers,
    };
  }

  const runPayload = readJson(resolvePathFromRoot(paths.mirrorRunJson));
  const runRepeatPayload = readJson(resolvePathFromRoot(paths.mirrorRunRepeatJson));
  const compatPayload = readJson(resolvePathFromRoot(paths.mirrorCompatJson));
  const compatRepeatPayload = readJson(resolvePathFromRoot(paths.mirrorCompatRepeatJson));

  const determinismPass =
    stableStringify(runPayload.summary ?? null) === stableStringify(runRepeatPayload.summary ?? null) &&
    stableStringify(runPayload.winnerScenarioId ?? null) === stableStringify(runRepeatPayload.winnerScenarioId ?? null) &&
    stableStringify(runPayload.failureEnvelope ?? null) === stableStringify(runRepeatPayload.failureEnvelope ?? null) &&
    stableStringify(compatPayload.summary ?? null) === stableStringify(compatRepeatPayload.summary ?? null);

  return {
    status: 'pass',
    payload: {
      status: 'pass',
      lane,
      scenario_pack: normalizePath(scenarioPack),
      summary: runPayload.summary ?? null,
      classifications: countClassifications(runPayload.results),
      compat: {
        summary: compatPayload.summary ?? null,
      },
      determinism: {
        pass: determinismPass,
      },
      required_anchors: requiredAnchors,
      artifacts: {
        run_json: normalizePath(paths.mirrorRunJson),
        run_md: normalizePath(paths.mirrorRunMd),
        run_repeat_json: normalizePath(paths.mirrorRunRepeatJson),
        compat_json: normalizePath(paths.mirrorCompatJson),
        compat_md: normalizePath(paths.mirrorCompatMd),
        compat_repeat_json: normalizePath(paths.mirrorCompatRepeatJson),
      },
    },
    blockers,
  };
};

const buildMethodArgs = (args: Record<string, string>, outJson: string, outMd: string): string[] => {
  const cli: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    cli.push(`--${key}`);
    cli.push(String(value));
  }
  cli.push('--out-json');
  cli.push(outJson);
  cli.push('--out-md');
  cli.push(outMd);
  return cli;
};

const runMethodTrack = (
  profile: ExternalWorkProfile,
  paths: ReturnType<typeof buildProfilePaths>,
): { status: TrackStatus; payload: Record<string, unknown>; blockers: RunBlocker[] } => {
  const blockers: RunBlocker[] = [];
  const method = profile.track_method;
  if (!method.enabled) {
    return {
      status: 'not_available',
      payload: {
        status: 'not_available',
        reason: method.reason ?? 'method track disabled by profile',
      },
      blockers,
    };
  }

  const script = method.script ?? '';
  if (!script) {
    blockers.push({ code: 'method_missing_script', detail: 'method script is required.' });
    return { status: 'blocked', payload: { status: 'blocked' }, blockers };
  }
  const scriptResolved = resolvePathFromRoot(script);
  if (!fs.existsSync(scriptResolved)) {
    blockers.push({ code: 'method_script_not_found', detail: 'method script does not exist.', path: script });
    return { status: 'blocked', payload: { status: 'blocked', script: normalizePath(script) }, blockers };
  }

  const snapshots = method.input_snapshots ?? [];
  const missingSnapshots = snapshots.filter((snapshot) => !fs.existsSync(resolvePathFromRoot(snapshot)));
  if (missingSnapshots.length > 0) {
    blockers.push({
      code: 'method_snapshot_missing',
      detail: `missing snapshots: ${missingSnapshots.join(', ')}`,
      path: missingSnapshots[0] ?? null,
    });
    return { status: 'blocked', payload: { status: 'blocked', script: normalizePath(script) }, blockers };
  }

  const expectedOutputKeys = method.expected_output_keys ?? [];
  if (expectedOutputKeys.length === 0) {
    blockers.push({ code: 'method_expected_output_keys_missing', detail: 'expected_output_keys[] is required.' });
    return { status: 'blocked', payload: { status: 'blocked', script: normalizePath(script) }, blockers };
  }

  const args = method.args ?? {};
  const mainArgs = buildMethodArgs(args, paths.methodOutJson, paths.methodOutMd);
  const repeatArgs = buildMethodArgs(args, paths.methodOutRepeatJson, paths.methodOutRepeatMd);
  const runMain = runTsx(script, mainArgs);
  if (!runMain.ok) {
    blockers.push({
      code: 'method_run_failed',
      detail: runMain.error ?? 'method command failed',
      path: runMain.command,
    });
    return { status: 'blocked', payload: { status: 'blocked', script: normalizePath(script) }, blockers };
  }
  const runRepeat = runTsx(script, repeatArgs);
  if (!runRepeat.ok) {
    blockers.push({
      code: 'method_run_repeat_failed',
      detail: runRepeat.error ?? 'repeat method command failed',
      path: runRepeat.command,
    });
    return { status: 'blocked', payload: { status: 'blocked', script: normalizePath(script) }, blockers };
  }

  const methodPayload = readJson(resolvePathFromRoot(paths.methodOutJson));
  const methodRepeatPayload = readJson(resolvePathFromRoot(paths.methodOutRepeatJson));

  const extracted: Record<string, unknown> = {};
  const missingKeys: string[] = [];
  for (const key of expectedOutputKeys) {
    const value = dottedGet(methodPayload, key);
    extracted[key] = value;
    if (value === undefined) {
      missingKeys.push(key);
    }
  }
  if (missingKeys.length > 0) {
    blockers.push({
      code: 'method_expected_output_key_missing',
      detail: `missing output keys: ${missingKeys.join(', ')}`,
      path: normalizePath(paths.methodOutJson),
    });
  }

  const determinismPass = expectedOutputKeys.every(
    (key) => stableStringify(dottedGet(methodPayload, key)) === stableStringify(dottedGet(methodRepeatPayload, key)),
  );
  const methodStatusValue = String(dottedGet(methodPayload, 'replay.status') ?? '').toLowerCase();
  const status: TrackStatus = blockers.length === 0 && methodStatusValue.length > 0 ? 'pass' : blockers.length > 0 ? 'blocked' : 'pass';

  return {
    status,
    payload: {
      status,
      script: normalizePath(script),
      expected_output_keys: expectedOutputKeys,
      extracted: objectWithSortedKeys(extracted),
      determinism: {
        pass: determinismPass,
      },
      artifacts: {
        out_json: normalizePath(paths.methodOutJson),
        out_md: normalizePath(paths.methodOutMd),
        out_repeat_json: normalizePath(paths.methodOutRepeatJson),
      },
    },
    blockers,
  };
};

export const runExternalWorkProfiles = (options: {
  profilePath?: string;
  citationPackPath?: string;
  outDir?: string;
  outDocDir?: string;
  workId?: string;
}) => {
  const profilePath = options.profilePath ?? DEFAULT_PROFILE_PATH;
  const citationPackPath = options.citationPackPath ?? DEFAULT_CITATION_PACK_PATH;
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const outDocDir = options.outDocDir ?? DEFAULT_OUT_DOC_DIR;
  const workIdFilter = options.workId?.trim().toUpperCase() ?? null;

  const config = readJson(resolvePathFromRoot(profilePath)) as ExternalWorkProfileConfig;
  const citationMeta = parseCitationSourceMeta(fs.readFileSync(resolvePathFromRoot(citationPackPath), 'utf8'));
  const profiles = Array.isArray(config.profiles) ? config.profiles : [];
  const selectedProfiles = workIdFilter
    ? profiles.filter((profile) => String(profile.work_id).trim().toUpperCase() === workIdFilter)
    : profiles;

  if (selectedProfiles.length === 0) {
    throw new Error(workIdFilter ? `No profile found for work_id=${workIdFilter}` : 'No external work profiles found.');
  }

  const runArtifacts: string[] = [];
  const results = selectedProfiles.map((profile) => {
    const paths = buildProfilePaths(profile.work_id, outDir, outDocDir);
    const sourceMeta = profile.source_refs.map((sourceRef) => {
      const meta = citationMeta.get(String(sourceRef).toUpperCase());
      return {
        source_id: String(sourceRef).toUpperCase(),
        source_class: meta?.source_class ?? null,
        confidence_tier: meta?.confidence_tier ?? null,
      };
    });
    const sourceClass = consolidatedSourceClass(sourceMeta.map((entry) => entry.source_class));
    const confidenceTier = conservativeConfidenceTier(sourceMeta.map((entry) => entry.confidence_tier));

    const mirror = runMirrorTrack(profile, paths);
    const method = runMethodTrack(profile, paths);
    const blockers: RunBlocker[] = [...mirror.blockers, ...method.blockers];
    const recomputeReady = classifyRecomputeReady(mirror.status, method.status, blockers.length);

    const payloadBase: Record<string, unknown> = {
      artifact_type: 'external_work_run/v1',
      generated_on: DATE_STAMP,
      generated_at: new Date().toISOString(),
      boundary_statement: BOUNDARY_STATEMENT,
      commit_pin: headCommit(),
      profile_commit_pin: profile.commit_pin,
      work_id: profile.work_id,
      title: profile.title,
      source_refs: profile.source_refs,
      source_meta: sourceMeta,
      source_class: sourceClass,
      confidence_tier: confidenceTier,
      chain_ids: profile.chain_ids,
      posture: profile.posture,
      mirror_track: mirror.payload,
      method_track: method.payload,
      track_status: {
        mirror: mirror.status,
        method: method.status,
      },
      recompute_ready: recomputeReady,
      blockers: blockers.sort((a, b) => a.code.localeCompare(b.code)),
      comparison_keys: profile.comparison_keys,
      profile_path: normalizePath(profilePath),
    };
    const checksum = checksumPayload(payloadBase);
    const payload = {
      ...payloadBase,
      checksum,
    };

    const markdown = renderMarkdown(payload);
    ensureDir(paths.runJson);
    ensureDir(paths.runMd);
    ensureDir(paths.latestRunJson);
    ensureDir(paths.latestRunMd);
    fs.writeFileSync(paths.runJson, `${JSON.stringify(payload, null, 2)}\n`);
    fs.writeFileSync(paths.runMd, `${markdown}\n`);
    fs.writeFileSync(paths.latestRunJson, `${JSON.stringify(payload, null, 2)}\n`);
    fs.writeFileSync(paths.latestRunMd, `${markdown}\n`);
    runArtifacts.push(paths.runJson);
    return {
      work_id: profile.work_id,
      out_json: normalizePath(paths.runJson),
      out_md: normalizePath(paths.runMd),
      latest_json: normalizePath(paths.latestRunJson),
      latest_md: normalizePath(paths.latestRunMd),
      recompute_ready: recomputeReady,
      mirror_status: mirror.status,
      method_status: method.status,
      blocker_count: blockers.length,
    };
  });

  return {
    ok: true,
    generatedOn: DATE_STAMP,
    profilePath: normalizePath(profilePath),
    runArtifacts: runArtifacts.map((filePath) => normalizePath(filePath)),
    results,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runExternalWorkProfiles({
    profilePath: readArgValue('--profiles') ?? DEFAULT_PROFILE_PATH,
    citationPackPath: readArgValue('--citations') ?? DEFAULT_CITATION_PACK_PATH,
    outDir: readArgValue('--out-dir') ?? DEFAULT_OUT_DIR,
    outDocDir: readArgValue('--out-doc-dir') ?? DEFAULT_OUT_DOC_DIR,
    workId: readArgValue('--work-id'),
  });
  console.log(JSON.stringify(result, null, 2));
}
