import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_SCENARIO_PATH = path.join('configs', 'warp-shadow-injection-scenarios.ng-primary-typed.v1.json');
const DEFAULT_RUN_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  `shadow-injection-run-ng-primary-typed-${DATE_STAMP}.json`,
);
const DEFAULT_REGISTRY_PATH = path.join(
  'docs',
  'specs',
  'casimir-tile-experimental-parameter-registry-2026-03-04.md',
);
const DEFAULT_OUT_JSON = path.join('artifacts', 'research', 'full-solve', `ng-compat-check-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-ng-compat-check-${DATE_STAMP}.md`);
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

type ProfileId = 'NG-STD-10' | 'NG-ADV-5';
type Congruence = 'congruent' | 'incongruent' | 'unknown';

type Scenario = {
  id: string;
  lane: string;
  registryRefs?: string[];
  overrides?: {
    params?: Record<string, unknown>;
  };
  experimentalContext?: {
    nanogap?: {
      profileId?: ProfileId;
      u_g_mean_nm?: number;
      u_g_sigma_nm?: number;
      tip_method?: string;
      fiducial_present?: boolean;
      sourceRefs?: string[];
      uncertainty?: {
        method?: string;
        reportableReady?: boolean;
        blockedReasons?: string[];
        sourceRefs?: string[];
      };
    };
  };
};

type ScenarioPack = {
  boundaryStatement?: string;
  profileThresholds?: Partial<Record<ProfileId, { u_g_mean_nm_max: number; u_g_sigma_nm_max: number }>>;
  scenarios: Scenario[];
};

type RunResult = {
  id: string;
  classification: 'compatible' | 'partial' | 'incompatible' | 'error';
};

type RunPayload = {
  results?: RunResult[];
};

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const finiteOrNull = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const parseRegistryRows = (markdown: string): Array<{ entry_id: string; source_class: string; status: string; uncertainty: string }> => {
  const rows: Array<{ entry_id: string; source_class: string; status: string; uncertainty: string }> = [];
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('| EXP-')) continue;
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 12) continue;
    rows.push({
      entry_id: cells[0],
      source_class: cells[9],
      status: cells[11],
      uncertainty: cells[5],
    });
  }
  return rows;
};

const profileThresholdDefaults: Record<ProfileId, { u_g_mean_nm_max: number; u_g_sigma_nm_max: number }> = {
  'NG-STD-10': { u_g_mean_nm_max: 2.0, u_g_sigma_nm_max: 2.0 },
  'NG-ADV-5': { u_g_mean_nm_max: 1.0, u_g_sigma_nm_max: 1.0 },
};

const hasAllAnchors = (refs: string[]): { ok: boolean; missing: string[] } => {
  const missing: string[] = [];
  if (!refs.includes('EXP-NG-002')) missing.push('missing_nanogap_calibration_anchor');
  if (!refs.includes('EXP-NG-011') || !refs.includes('EXP-NG-012')) missing.push('missing_fiducial_anchor');
  if (!refs.includes('EXP-NG-019') && !refs.includes('EXP-NG-020')) missing.push('missing_tip_state_anchor');
  return { ok: missing.length === 0, missing };
};

const edgeBand = (limit: number): number => Math.max(0.05 * limit, 0.05);

const evaluateCongruence = (input: {
  refs: string[];
  profileId: ProfileId | null;
  gapNm: number | null;
  uMean: number | null;
  uSigma: number | null;
  reportableReady: boolean | null;
  thresholds: Record<ProfileId, { u_g_mean_nm_max: number; u_g_sigma_nm_max: number }>;
}): { evidenceCongruence: Congruence; reasonCodes: string[] } => {
  const reasons: string[] = [];
  const anchorState = hasAllAnchors(input.refs);
  reasons.push(...anchorState.missing);

  if (!input.profileId) reasons.push('missing_profile_id');
  if (input.gapNm == null) reasons.push('missing_gap_value');
  if (input.uMean == null || input.uSigma == null) reasons.push('missing_uncertainty_fields');
  if ((input.uMean ?? 0) <= 0 || (input.uSigma ?? 0) <= 0) reasons.push('invalid_uncertainty_values');
  if (input.reportableReady === false) reasons.push('reportable_not_ready');
  if (reasons.length > 0) return { evidenceCongruence: 'unknown', reasonCodes: reasons };

  const gap = input.gapNm as number;
  const profileId = input.profileId as ProfileId;
  const uMean = input.uMean as number;
  const uSigma = input.uSigma as number;
  const threshold = input.thresholds[profileId] ?? profileThresholdDefaults[profileId];

  const protocolMinGap = 5;
  const protocolMaxGap = 150;
  if (gap < protocolMinGap - 1 || gap > protocolMaxGap + 1) {
    return { evidenceCongruence: 'incongruent', reasonCodes: ['gap_outside_protocol_bounds'] };
  }
  if (gap < protocolMinGap || gap > protocolMaxGap) {
    return { evidenceCongruence: 'unknown', reasonCodes: ['edge_uncertainty_overlap'] };
  }

  const meanMax = threshold.u_g_mean_nm_max;
  const sigmaMax = threshold.u_g_sigma_nm_max;
  const meanBand = edgeBand(meanMax);
  const sigmaBand = edgeBand(sigmaMax);

  const incongruentReasons: string[] = [];
  let hasUnknownBand = false;

  if (uMean <= meanMax) {
    // strict pass
  } else if (uMean <= meanMax + meanBand) {
    hasUnknownBand = true;
  } else {
    incongruentReasons.push(`u_g_mean_exceeds_profile:${profileId}`);
  }

  if (uSigma <= sigmaMax) {
    // strict pass
  } else if (uSigma <= sigmaMax + sigmaBand) {
    hasUnknownBand = true;
  } else {
    incongruentReasons.push(`u_g_sigma_exceeds_profile:${profileId}`);
  }

  if (incongruentReasons.length > 0) return { evidenceCongruence: 'incongruent', reasonCodes: incongruentReasons };
  if (hasUnknownBand) return { evidenceCongruence: 'unknown', reasonCodes: ['edge_uncertainty_overlap'] };
  return { evidenceCongruence: 'congruent', reasonCodes: [] };
};

const renderMarkdown = (payload: any): string => {
  const reasonRows =
    Object.entries(payload.summary.reasonCounts as Record<string, number>)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => `| ${reason} | ${count} |`)
      .join('\n') || '| n/a | 0 |';

  const profileRows =
    Object.entries(payload.summary.byProfile as Record<string, { congruent: number; incongruent: number; unknown: number }>)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([profile, counts]) => `| ${profile} | ${counts.congruent} | ${counts.incongruent} | ${counts.unknown} |`)
      .join('\n') || '| n/a | 0 | 0 | 0 |';

  const scenarioRows =
    (payload.scenarioChecks as Array<any>)
      .map(
        (row) =>
          `| ${row.id} | ${row.profileId ?? 'n/a'} | ${row.gap_nm ?? 'n/a'} | ${row.u_g_mean_nm ?? 'n/a'} | ${row.u_g_sigma_nm ?? 'n/a'} | ${row.reportableReady ?? 'n/a'} | ${row.evidenceCongruence} | ${row.runClassification ?? 'n/a'} | ${row.reasonCodes.join(', ') || 'none'} |`,
      )
      .join('\n') || '| n/a | n/a | n/a | n/a | n/a | n/a | unknown | n/a | n/a |';

  return `# Nanogap Compatibility Check (${payload.generatedOn})

${payload.boundaryStatement}

## Inputs
- scenario_pack: \`${payload.scenarioPath}\`
- run_artifact: \`${payload.runPath}\`
- registry: \`${payload.registryPath}\`

## Summary
- scenario_count: ${payload.summary.scenarioCount}
- congruent: ${payload.summary.congruent}
- incongruent: ${payload.summary.incongruent}
- unknown: ${payload.summary.unknown}

## Profile Summary
| profile_id | congruent | incongruent | unknown |
|---|---:|---:|---:|
${profileRows}

## Scenario Checks
| scenario_id | profile_id | gap_nm | u_g_mean_nm | u_g_sigma_nm | reportable_ready | evidence_congruence | run_classification | reasons |
|---|---|---:|---:|---:|---|---|---|---|
${scenarioRows}

## Dominant Reasons
| reason | count |
|---|---:|
${reasonRows}
`;
};

export const runNanogapCompatCheck = (options: {
  scenarioPath?: string;
  runPath?: string;
  registryPath?: string;
  outJsonPath?: string;
  outMdPath?: string;
}) => {
  const scenarioPath = options.scenarioPath ?? DEFAULT_SCENARIO_PATH;
  const runPath = options.runPath ?? DEFAULT_RUN_PATH;
  const registryPath = options.registryPath ?? DEFAULT_REGISTRY_PATH;
  const outJsonPath = options.outJsonPath ?? DEFAULT_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_OUT_MD;

  const scenarioPack = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as ScenarioPack;
  const runPayload = JSON.parse(fs.readFileSync(runPath, 'utf8')) as RunPayload;
  const registryRows = parseRegistryRows(fs.readFileSync(registryPath, 'utf8'));
  const rowsById = new Map(registryRows.map((row) => [row.entry_id.toUpperCase(), row]));
  const runById = new Map((runPayload.results ?? []).map((row) => [row.id, row]));
  const thresholds = {
    ...profileThresholdDefaults,
    ...(scenarioPack.profileThresholds ?? {}),
  };

  const reasonCounts: Record<string, number> = {};
  const byProfile: Record<string, { congruent: number; incongruent: number; unknown: number }> = {};

  const scenarioChecks = scenarioPack.scenarios.map((scenario) => {
    const refs = (scenario.registryRefs ?? []).map((ref) => ref.trim().toUpperCase());
    const ngContext = scenario.experimentalContext?.nanogap;
    const profileId = (ngContext?.profileId as ProfileId | undefined) ?? null;
    const gapNm = finiteOrNull(scenario.overrides?.params?.gap_nm);
    const uMean = finiteOrNull(ngContext?.u_g_mean_nm);
    const uSigma = finiteOrNull(ngContext?.u_g_sigma_nm);
    const reportableReady =
      typeof ngContext?.uncertainty?.reportableReady === 'boolean' ? ngContext.uncertainty.reportableReady : null;

    const uncertaintyAnchorOk = refs.some((ref) => {
      const row = rowsById.get(ref);
      if (!row) return false;
      return String(row.status).toLowerCase() === 'extracted' && String(row.source_class).toLowerCase() !== 'preprint' && row.uncertainty.toLowerCase() !== 'unknown';
    });
    const baseEval = evaluateCongruence({
      refs,
      profileId,
      gapNm,
      uMean,
      uSigma,
      reportableReady,
      thresholds,
    });
    const reasonCodes = [...baseEval.reasonCodes];
    if (!uncertaintyAnchorOk) {
      reasonCodes.push('missing_uncertainty_anchor');
    }

    const evidenceCongruence: Congruence =
      !uncertaintyAnchorOk && baseEval.evidenceCongruence === 'congruent' ? 'unknown' : baseEval.evidenceCongruence;

    if (profileId) {
      const bucket = (byProfile[profileId] ??= { congruent: 0, incongruent: 0, unknown: 0 });
      bucket[evidenceCongruence] += 1;
    }
    for (const reason of reasonCodes) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }

    return {
      id: scenario.id,
      lane: scenario.lane,
      profileId,
      gap_nm: gapNm,
      u_g_mean_nm: uMean,
      u_g_sigma_nm: uSigma,
      reportableReady,
      evidenceCongruence,
      reasonCodes,
      runClassification: runById.get(scenario.id)?.classification ?? null,
    };
  });

  const summary = {
    scenarioCount: scenarioChecks.length,
    congruent: scenarioChecks.filter((row) => row.evidenceCongruence === 'congruent').length,
    incongruent: scenarioChecks.filter((row) => row.evidenceCongruence === 'incongruent').length,
    unknown: scenarioChecks.filter((row) => row.evidenceCongruence === 'unknown').length,
    byProfile,
    reasonCounts,
  };

  const payload = {
    generatedOn: new Date().toISOString(),
    boundaryStatement: scenarioPack.boundaryStatement ?? BOUNDARY_STATEMENT,
    scenarioPath,
    runPath,
    registryPath,
    summary,
    scenarioChecks,
  };

  fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
  fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
  fs.writeFileSync(outMdPath, renderMarkdown(payload));

  return {
    ok: true,
    outJsonPath,
    outMdPath,
    summary,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runNanogapCompatCheck({
    scenarioPath: readArgValue('--scenarios') ?? DEFAULT_SCENARIO_PATH,
    runPath: readArgValue('--run') ?? DEFAULT_RUN_PATH,
    registryPath: readArgValue('--registry') ?? DEFAULT_REGISTRY_PATH,
    outJsonPath: readArgValue('--out') ?? DEFAULT_OUT_JSON,
    outMdPath: readArgValue('--out-md') ?? DEFAULT_OUT_MD,
  });
  console.log(JSON.stringify(result, null, 2));
}
