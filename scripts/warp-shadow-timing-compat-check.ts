import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_SCENARIO_PATH = path.join('configs', 'warp-shadow-injection-scenarios.ti-primary-typed.v1.json');
const DEFAULT_RUN_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  `shadow-injection-run-ti-primary-typed-${DATE_STAMP}.json`,
);
const DEFAULT_REGISTRY_PATH = path.join(
  'docs',
  'specs',
  'casimir-tile-experimental-parameter-registry-2026-03-04.md',
);
const DEFAULT_OUT_JSON = path.join('artifacts', 'research', 'full-solve', `ti-compat-check-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-ti-compat-check-${DATE_STAMP}.md`);
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

type ProfileId = 'WR-SHORT-PS' | 'WR-LONGHAUL-EXP';
type Congruence = 'congruent' | 'incongruent' | 'unknown';
type ReducedReasonCategory =
  | 'missing_anchor_or_context'
  | 'missing_uncertainty_anchor'
  | 'threshold_violation'
  | 'uncertainty_edge_overlap'
  | 'source_admissibility'
  | 'reportable_contract'
  | 'other';
type TimingProfileThreshold = {
  sigma_t_ps_max: number | null;
  tie_pp_ps_max: number | null;
  pdv_pp_ps_max: number | null;
};

type RegistryRow = {
  entry_id: string;
  source_class: string;
  status: string;
  uncertainty: string;
  parameter: string;
  conditions: string;
};

type Scenario = {
  id: string;
  lane: string;
  registryRefs?: string[];
  experimentalContext?: {
    timing?: {
      profileId?: ProfileId;
      sigma_t_ps?: number;
      tie_pp_ps?: number | null;
      pdv_pp_ps?: number | null;
      timestamping_mode?: string;
      synce_enabled?: boolean;
      clock_mode?: string;
      topology_class?: string;
      sourceRefs?: string[];
      uncertainty?: {
        u_sigma_t_ps?: number | null;
        u_tie_pp_ps?: number | null;
        u_pdv_pp_ps?: number | null;
        method?: string;
        reportableReady?: boolean;
        blockedReasons?: string[];
      };
    };
  };
};

type ScenarioPack = {
  boundaryStatement?: string;
  profileThresholds?: Partial<Record<ProfileId, TimingProfileThreshold>>;
  scenarios: Scenario[];
};

type RunResult = {
  id: string;
  classification: 'compatible' | 'partial' | 'incompatible' | 'error';
};

type RunPayload = {
  results?: RunResult[];
};

const profileThresholdDefaults: Record<ProfileId, TimingProfileThreshold> = {
  'WR-SHORT-PS': { sigma_t_ps_max: 100, tie_pp_ps_max: 200, pdv_pp_ps_max: null },
  'WR-LONGHAUL-EXP': { sigma_t_ps_max: null, tie_pp_ps_max: 500, pdv_pp_ps_max: null },
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

const reduceReasonCode = (reasonCode: string): ReducedReasonCategory => {
  const code = String(reasonCode ?? '').trim().toLowerCase();
  if (!code) return 'other';
  if (code.includes('missing_numeric_uncertainty_anchor') || code.startsWith('missing_u_')) {
    return 'missing_uncertainty_anchor';
  }
  if (code.startsWith('missing_')) return 'missing_anchor_or_context';
  if (
    code.includes('exceeds_profile') ||
    code.includes('outside') ||
    code.includes('not_hardware') ||
    code.includes('not_enabled')
  ) {
    return 'threshold_violation';
  }
  if (code.includes('edge_uncertainty_overlap')) return 'uncertainty_edge_overlap';
  if (code.includes('strict_scope_ref_not_admissible') || code.includes('not_admissible_in_strict_scope')) {
    return 'source_admissibility';
  }
  if (code.includes('reportable_not_ready') || code.includes('reportable_ready_with_blocked_reasons')) {
    return 'reportable_contract';
  }
  return 'other';
};

const parseRegistryRows = (markdown: string): RegistryRow[] => {
  const rows: RegistryRow[] = [];
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
      parameter: cells[2],
      uncertainty: cells[5],
      conditions: cells[6],
      source_class: cells[9],
      status: cells[11],
    });
  }
  return rows;
};

const isKnownUncertainty = (value: string): boolean => {
  const normalized = String(value).trim().toLowerCase();
  return normalized.length > 0 && !['unknown', 'n/a', 'na', 'none', 'null'].includes(normalized);
};

const hasAllTimingAnchors = (refs: string[]): { ok: boolean; missing: string[] } => {
  const missing: string[] = [];
  if (!refs.includes('EXP-T-001')) missing.push('missing_timing_topology_anchor');
  if (!refs.includes('EXP-T-003')) missing.push('missing_timing_precision_anchor');
  if (!refs.includes('EXP-T-002') && !refs.includes('EXP-T-004')) missing.push('missing_timing_accuracy_anchor');
  if (!refs.includes('EXP-T-029')) missing.push('missing_timing_longhaul_anchor');
  return { ok: missing.length === 0, missing };
};

const edgeBand = (limit: number): number => Math.max(0.05 * limit, 5);

const evaluateCongruence = (input: {
  refs: string[];
  profileId: ProfileId | null;
  sigmaPs: number | null;
  tiePpPs: number | null;
  timestampingMode: string | null;
  synceEnabled: boolean | null;
  topologyClass: string | null;
  uSigmaPs: number | null;
  thresholds: Record<ProfileId, TimingProfileThreshold>;
  strictScopeLonghaulEvidence: boolean;
  reportableReady: boolean | null;
}): { evidenceCongruence: Congruence; reasonCodes: string[] } => {
  const reasons: string[] = [];
  const anchorState = hasAllTimingAnchors(input.refs);
  reasons.push(...anchorState.missing);

  if (!input.profileId) reasons.push('missing_profile_id');
  if (input.sigmaPs == null || input.sigmaPs <= 0) reasons.push('missing_sigma_t_ps');
  if (input.tiePpPs == null || input.tiePpPs <= 0) reasons.push('missing_tie_pp_ps');
  if (input.timestampingMode == null) reasons.push('missing_timestamping_mode');
  if (input.synceEnabled == null) reasons.push('missing_synce_state');
  if (input.reportableReady === false) reasons.push('missing_numeric_uncertainty_anchor');
  if (reasons.length > 0) return { evidenceCongruence: 'unknown', reasonCodes: reasons };

  const profile = input.profileId as ProfileId;
  const sigma = input.sigmaPs as number;
  const tie = input.tiePpPs as number;
  const timestampingMode = String(input.timestampingMode ?? '').toLowerCase();
  const synceEnabled = input.synceEnabled === true;
  const uSigma = Math.max(0, input.uSigmaPs ?? 0.3 * sigma);

  if (profile === 'WR-LONGHAUL-EXP') {
    if (!input.strictScopeLonghaulEvidence) {
      return { evidenceCongruence: 'unknown', reasonCodes: ['longhaul_evidence_not_admissible_in_strict_scope'] };
    }
    if (timestampingMode !== 'hardware') {
      return { evidenceCongruence: 'incongruent', reasonCodes: ['timestamping_not_hardware'] };
    }
    const tieMaxLonghaul = input.thresholds[profile].tie_pp_ps_max;
    if (tieMaxLonghaul != null && tie > tieMaxLonghaul) {
      return { evidenceCongruence: 'incongruent', reasonCodes: ['tie_exceeds_profile:WR-LONGHAUL-EXP'] };
    }
    return { evidenceCongruence: 'congruent', reasonCodes: [] };
  }

  if (timestampingMode !== 'hardware') {
    return { evidenceCongruence: 'incongruent', reasonCodes: ['timestamping_not_hardware'] };
  }
  if (!synceEnabled) {
    return { evidenceCongruence: 'incongruent', reasonCodes: ['synce_not_enabled'] };
  }

  const sigmaMax = input.thresholds[profile].sigma_t_ps_max ?? 100;
  const tieMax = input.thresholds[profile].tie_pp_ps_max;
  if (tieMax != null && tie > tieMax) {
    return { evidenceCongruence: 'incongruent', reasonCodes: ['tie_exceeds_profile:WR-SHORT-PS'] };
  }
  const strictLimit = sigmaMax - uSigma;
  const expandedLimit = sigmaMax + edgeBand(sigmaMax) + uSigma;
  if (sigma <= strictLimit) return { evidenceCongruence: 'congruent', reasonCodes: [] };
  if (sigma <= expandedLimit) return { evidenceCongruence: 'unknown', reasonCodes: ['edge_uncertainty_overlap'] };
  return { evidenceCongruence: 'incongruent', reasonCodes: ['sigma_exceeds_profile:WR-SHORT-PS'] };
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
          `| ${row.id} | ${row.profileId ?? 'n/a'} | ${row.sigma_t_ps ?? 'n/a'} | ${row.tie_pp_ps ?? 'n/a'} | ${row.u_sigma_t_ps ?? 'n/a'} | ${row.timestamping_mode ?? 'n/a'} | ${row.synce_enabled ?? 'n/a'} | ${row.topology_class ?? 'n/a'} | ${row.evidenceCongruence} | ${row.runClassification ?? 'n/a'} | ${row.reasonCodes.join(', ') || 'none'} |`,
      )
      .join('\n') || '| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unknown | n/a | n/a |';

  return `# Timing Compatibility Check (${payload.generatedOn})

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
| scenario_id | profile_id | sigma_t_ps | tie_pp_ps | u_sigma_t_ps | timestamping_mode | synce_enabled | topology_class | evidence_congruence | run_classification | reasons |
|---|---|---:|---:|---:|---|---|---|---|---|---|
${scenarioRows}

## Dominant Reasons
| reason | count |
|---|---:|
${reasonRows}
`;
};

export const runTimingCompatCheck = (options: {
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
  const thresholds: Record<ProfileId, TimingProfileThreshold> = {
    ...profileThresholdDefaults,
    ...(scenarioPack.profileThresholds ?? {}),
  };

  const reasonCounts: Record<string, number> = {};
  const reducedReasonCounts: Record<ReducedReasonCategory, number> = {
    missing_anchor_or_context: 0,
    missing_uncertainty_anchor: 0,
    threshold_violation: 0,
    uncertainty_edge_overlap: 0,
    source_admissibility: 0,
    reportable_contract: 0,
    other: 0,
  };
  const byProfile: Record<string, { congruent: number; incongruent: number; unknown: number }> = {};

  const scenarioChecks = scenarioPack.scenarios.map((scenario) => {
    const refs = (scenario.registryRefs ?? []).map((ref) => ref.trim().toUpperCase());
    const timing = scenario.experimentalContext?.timing;
    const profileId = (timing?.profileId as ProfileId | undefined) ?? null;
    const sigmaPs = finiteOrNull(timing?.sigma_t_ps);
    const tiePpPs = finiteOrNull(timing?.tie_pp_ps);
    const uSigmaPs = finiteOrNull(timing?.uncertainty?.u_sigma_t_ps);
    const timestampingMode = String(timing?.timestamping_mode ?? '').trim() || null;
    const synceEnabled =
      typeof timing?.synce_enabled === 'boolean'
        ? timing.synce_enabled
        : null;
    const topologyClass = String(timing?.topology_class ?? '').trim() || null;
    const reportableReady =
      typeof timing?.uncertainty?.reportableReady === 'boolean' ? timing.uncertainty.reportableReady : null;
    const blockedReasons = timing?.uncertainty?.blockedReasons ?? [];

    const uncertaintyAnchorOk = refs.some((ref) => {
      const row = rowsById.get(ref);
      if (!row) return false;
      const cls = String(row.source_class).toLowerCase();
      const status = String(row.status).toLowerCase();
      return ['primary', 'standard'].includes(cls) && status === 'extracted' && isKnownUncertainty(row.uncertainty);
    });

    const longhaulAnchor = rowsById.get('EXP-T-029');
    const strictScopeLonghaulEvidence =
      refs.includes('EXP-T-029') &&
      !!longhaulAnchor &&
      ['primary', 'standard'].includes(String(longhaulAnchor.source_class).toLowerCase()) &&
      String(longhaulAnchor.status).toLowerCase() === 'extracted' &&
      isKnownUncertainty(longhaulAnchor.uncertainty);

    const baseEval = evaluateCongruence({
      refs,
      profileId,
      sigmaPs,
      tiePpPs,
      timestampingMode,
      synceEnabled,
      topologyClass,
      uSigmaPs,
      thresholds,
      strictScopeLonghaulEvidence,
      reportableReady,
    });
    const reasonCodes = [...baseEval.reasonCodes];
    if (!uncertaintyAnchorOk && !reasonCodes.includes('missing_numeric_uncertainty_anchor')) {
      reasonCodes.push('missing_numeric_uncertainty_anchor');
    }

    const evidenceCongruence: Congruence =
      !uncertaintyAnchorOk && baseEval.evidenceCongruence === 'congruent' ? 'unknown' : baseEval.evidenceCongruence;

    if (profileId) {
      const bucket = (byProfile[profileId] ??= { congruent: 0, incongruent: 0, unknown: 0 });
      bucket[evidenceCongruence] += 1;
    }

    for (const reason of reasonCodes) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
      const reduced = reduceReasonCode(reason);
      reducedReasonCounts[reduced] = (reducedReasonCounts[reduced] ?? 0) + 1;
    }

    return {
      id: scenario.id,
      lane: scenario.lane,
      profileId,
      sigma_t_ps: sigmaPs,
      tie_pp_ps: tiePpPs,
      u_sigma_t_ps: uSigmaPs,
      timestamping_mode: timestampingMode,
      synce_enabled: synceEnabled,
      topology_class: topologyClass,
      reportableReady,
      blockedReasons,
      evidenceCongruence,
      reasonCodes,
      reducedReasonCodes: [...new Set(reasonCodes.map((reason) => reduceReasonCode(reason)))].sort(),
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
    reducedReasonCounts,
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
  fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
  fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(outMdPath, `${renderMarkdown(payload)}\n`);

  return {
    ok: true,
    outJsonPath,
    outMdPath,
    summary,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runTimingCompatCheck({
    scenarioPath: readArgValue('--scenarios') ?? DEFAULT_SCENARIO_PATH,
    runPath: readArgValue('--run') ?? DEFAULT_RUN_PATH,
    registryPath: readArgValue('--registry') ?? DEFAULT_REGISTRY_PATH,
    outJsonPath: readArgValue('--out') ?? DEFAULT_OUT_JSON,
    outMdPath: readArgValue('--out-md') ?? DEFAULT_OUT_MD,
  });
  console.log(JSON.stringify(result, null, 2));
}
