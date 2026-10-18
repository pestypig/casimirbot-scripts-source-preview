import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  evaluateQiGuardrail,
  initializePipelineState,
  type EnergyPipelineState,
  updateParameters,
} from '../server/energy-pipeline.js';
import { PROMOTED_WARP_PROFILE } from '../shared/warp-promoted-profile.js';

const DEFAULT_SCENARIO_PATH = path.join('configs', 'warp-shadow-injection-scenarios.v1.json');
const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_OUT_JSON = path.join('artifacts', 'research', 'full-solve', `shadow-injection-run-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-shadow-injection-run-${DATE_STAMP}.md`);
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

type ScenarioOverrides = {
  params?: Record<string, unknown>;
  qi?: {
    sampler?: string;
    fieldType?: string;
    tau_s_ms?: number;
  };
};

type CasimirSignContext = {
  branchHypothesis?: 'attractive' | 'repulsive' | 'transition';
  materialPair?: string;
  interveningMedium?: string;
  sourceRefs?: string[];
};

type QSpoilingContext = {
  mechanismLane?: string;
  q0Baseline?: number;
  f_q_spoil?: number;
  q0Spoiled?: number;
  sourceRefs?: string[];
  uncertainty?: {
    u_q0_rel?: number;
    u_f_rel?: number;
    method?: string;
    reportableReady?: boolean;
    blockedReasons?: string[];
    sourceRefs?: string[];
  };
};

type NanogapContext = {
  profileId?: string;
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

type TimingContext = {
  profileId?: string;
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

type SemEllipsContext = {
  profileId?: string;
  d_sem_corr_nm?: number;
  u_sem_nm?: number;
  d_ellip_nm?: number;
  u_ellip_nm?: number;
  delta_se_nm?: number;
  d_fused_nm?: number;
  u_fused_nm?: number;
  U_fused_nm?: number;
  sourceRefs?: string[];
  uncertainty?: {
    method?: string;
    reportableReady?: boolean;
    blockedReasons?: string[];
    sourceRefs?: string[];
  };
};

type ExperimentalContext = {
  casimirSign?: CasimirSignContext;
  qSpoiling?: QSpoilingContext;
  nanogap?: NanogapContext;
  timing?: TimingContext;
  semEllips?: SemEllipsContext;
};

type ShadowScenario = {
  id: string;
  lane: string;
  description: string;
  registryRefs?: string[];
  experimentalContext?: ExperimentalContext;
  overrides?: ScenarioOverrides;
};

type ShadowScenarioPack = {
  version: number;
  boundaryStatement?: string;
  mode?: string;
  notes?: string[];
  recovery_goal?: string;
  success_bar?: string;
  baseline_reference?: {
    path?: string;
    keys?: string[];
  };
  scenarios: ShadowScenario[];
};

type GuardSummary = {
  marginRatioRaw: number | null;
  marginRatioRawComputed: number | null;
  lhs_Jm3: number | null;
  boundUsed_Jm3: number | null;
  boundComputed_Jm3: number | null;
  applicabilityStatus: string | null;
  congruentSolvePass: boolean;
  congruentSolveFailReasons: string[];
  sampler: string | null;
  fieldType: string | null;
  tauSelected_s: number | null;
  tauSelectedSource: string | null;
  rhoSource: string | null;
  metricContractOk: boolean;
  quantitySemanticComparable: boolean;
  uncertaintyDecisionClass: string | null;
};

type ScenarioResult = {
  id: string;
  lane: string;
  description: string;
  registryRefs: string[];
  experimentalContext?: ExperimentalContext;
  classification: 'compatible' | 'partial' | 'incompatible' | 'error';
  guard: GuardSummary | null;
  deltaFromBaseline:
    | {
        marginRatioRaw: number | null;
        marginRatioRawComputed: number | null;
        lhs_Jm3: number | null;
        boundUsed_Jm3: number | null;
      }
    | null;
  error: string | null;
};

type FailureEnvelope = {
  failReasonCounts: Record<string, number>;
  nearPassScenario: {
    id: string;
    lane: string;
    marginRatioRaw: number | null;
    sampler: string | null;
    tauSelected_s: number | null;
    failReasons: string[];
  } | null;
  recurrentIncompatibilityRegions: Array<{
    sampler: string | null;
    tauSelected_s: number | null;
    count: number;
  }>;
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

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const toSamplingKind = (value: unknown): 'gaussian' | 'lorentzian' | 'compact' => {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'gaussian' || v === 'lorentzian' || v === 'compact') return v;
  return 'lorentzian';
};

const toFieldType = (value: unknown): 'scalar' | 'em' | 'dirac' => {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'scalar' || v === 'em' || v === 'dirac') return v;
  return 'em';
};

const ensureRecoveryCurvatureSignals = <T extends Record<string, unknown>>(state: T): T => {
  const next = state as any;
  const gr = ((next.gr ??= {}) as Record<string, unknown>);
  const invariants = ((gr.invariants ??= {}) as Record<string, unknown>);
  const kretschmann = ((invariants.kretschmann ??= {}) as Record<string, unknown>);
  const p98 = finiteOrNull(kretschmann.p98) ?? 0;
  kretschmann.p98 = p98;
  kretschmann.max = finiteOrNull(kretschmann.max) ?? p98;
  kretschmann.mean = finiteOrNull(kretschmann.mean) ?? p98;
  return next;
};

const buildPromotedBaseParams = (): Partial<EnergyPipelineState> => {
  const promotedSampler = toSamplingKind(PROMOTED_WARP_PROFILE.qi.sampler);
  const promotedField = toFieldType(PROMOTED_WARP_PROFILE.qi.fieldType);
  return {
    warpFieldType: PROMOTED_WARP_PROFILE.warpFieldType as any,
    gammaGeo: PROMOTED_WARP_PROFILE.gammaGeo as any,
    dutyCycle: PROMOTED_WARP_PROFILE.dutyCycle as any,
    dutyShip: PROMOTED_WARP_PROFILE.dutyShip as any,
    dutyEffective_FR: PROMOTED_WARP_PROFILE.dutyCycle as any,
    sectorCount: PROMOTED_WARP_PROFILE.sectorCount as any,
    concurrentSectors: PROMOTED_WARP_PROFILE.concurrentSectors as any,
    qSpoilingFactor: PROMOTED_WARP_PROFILE.qSpoilingFactor as any,
    qCavity: PROMOTED_WARP_PROFILE.qCavity as any,
    gammaVanDenBroeck: PROMOTED_WARP_PROFILE.gammaVanDenBroeck as any,
    gap_nm: PROMOTED_WARP_PROFILE.gap_nm as any,
    bubble: {
      R: PROMOTED_WARP_PROFILE.reducedOrderReference.radius_m,
    } as any,
    R: PROMOTED_WARP_PROFILE.reducedOrderReference.radius_m as any,
    qi: {
      sampler: promotedSampler as any,
      fieldType: promotedField as any,
      tau_s_ms: PROMOTED_WARP_PROFILE.qi.tau_s_ms as any,
    } as any,
    dynamicConfig: {
      warpFieldType: PROMOTED_WARP_PROFILE.warpFieldType,
      dutyCycle: PROMOTED_WARP_PROFILE.dutyCycle,
      sectorCount: PROMOTED_WARP_PROFILE.sectorCount,
      concurrentSectors: PROMOTED_WARP_PROFILE.concurrentSectors,
      cavityQ: PROMOTED_WARP_PROFILE.qCavity,
    } as any,
  };
};

const buildOverrideParams = (scenario: ShadowScenario): Partial<EnergyPipelineState> => {
  const rawParams =
    scenario.overrides?.params && typeof scenario.overrides.params === 'object'
      ? (scenario.overrides.params as Record<string, unknown>)
      : {};
  const qiOverrides = scenario.overrides?.qi ?? {};
  const mergedQi = {
    ...(rawParams.qi && typeof rawParams.qi === 'object' ? (rawParams.qi as Record<string, unknown>) : {}),
    ...(qiOverrides.sampler ? { sampler: toSamplingKind(qiOverrides.sampler) } : {}),
    ...(qiOverrides.fieldType ? { fieldType: toFieldType(qiOverrides.fieldType) } : {}),
    ...(Number.isFinite(qiOverrides.tau_s_ms) && (qiOverrides.tau_s_ms as number) > 0
      ? { tau_s_ms: Number(qiOverrides.tau_s_ms) }
      : {}),
  };

  return {
    ...rawParams,
    qi: mergedQi,
  } as Partial<EnergyPipelineState>;
};

const summarizeGuard = (guard: ReturnType<typeof evaluateQiGuardrail>): GuardSummary => ({
  marginRatioRaw: finiteOrNull(guard.marginRatioRaw),
  marginRatioRawComputed: finiteOrNull(guard.marginRatioRawComputed),
  lhs_Jm3: finiteOrNull(guard.lhs_Jm3),
  boundUsed_Jm3: finiteOrNull(guard.boundUsed_Jm3),
  boundComputed_Jm3: finiteOrNull(guard.boundComputed_Jm3),
  applicabilityStatus: stringOrNull(guard.applicabilityStatus),
  congruentSolvePass: guard.congruentSolvePass === true,
  congruentSolveFailReasons: Array.isArray(guard.congruentSolveFailReasons)
    ? [...guard.congruentSolveFailReasons]
    : [],
  sampler: stringOrNull(guard.sampler),
  fieldType: stringOrNull(guard.fieldType),
  tauSelected_s: finiteOrNull(guard.tauSelected_s),
  tauSelectedSource: stringOrNull(guard.tauSelectedSource),
  rhoSource: stringOrNull(guard.rhoSource),
  metricContractOk: guard.metricContractOk === true,
  quantitySemanticComparable: guard.quantitySemanticComparable === true,
  uncertaintyDecisionClass: stringOrNull(guard.uncertaintyDecisionClass),
});

const classifyScenario = (summary: GuardSummary): 'compatible' | 'partial' | 'incompatible' => {
  if (summary.congruentSolvePass) return 'compatible';
  const policyMarginPass = summary.marginRatioRaw != null && summary.marginRatioRaw < 1;
  const computedMarginPass = summary.marginRatioRawComputed != null && summary.marginRatioRawComputed < 1;
  const applicabilityPass = String(summary.applicabilityStatus ?? 'UNKNOWN').toUpperCase() === 'PASS';
  if (policyMarginPass && computedMarginPass && applicabilityPass) return 'partial';
  return 'incompatible';
};

const computeDelta = (baseline: GuardSummary, scenario: GuardSummary) => ({
  marginRatioRaw:
    baseline.marginRatioRaw != null && scenario.marginRatioRaw != null
      ? scenario.marginRatioRaw - baseline.marginRatioRaw
      : null,
  marginRatioRawComputed:
    baseline.marginRatioRawComputed != null && scenario.marginRatioRawComputed != null
      ? scenario.marginRatioRawComputed - baseline.marginRatioRawComputed
      : null,
  lhs_Jm3: baseline.lhs_Jm3 != null && scenario.lhs_Jm3 != null ? scenario.lhs_Jm3 - baseline.lhs_Jm3 : null,
  boundUsed_Jm3:
    baseline.boundUsed_Jm3 != null && scenario.boundUsed_Jm3 != null
      ? scenario.boundUsed_Jm3 - baseline.boundUsed_Jm3
      : null,
});

const pickWinnerScenarioId = (results: ScenarioResult[], baselineTauSelectedS: number | null): string | null => {
  const candidates = results.filter((row) => row.classification === 'compatible' && row.guard != null);
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const marginA = finiteOrNull(a.guard?.marginRatioRaw);
    const marginB = finiteOrNull(b.guard?.marginRatioRaw);
    const scoreA = marginA ?? Number.POSITIVE_INFINITY;
    const scoreB = marginB ?? Number.POSITIVE_INFINITY;
    if (scoreA !== scoreB) return scoreA - scoreB;

    const tauA = finiteOrNull(a.guard?.tauSelected_s);
    const tauB = finiteOrNull(b.guard?.tauSelected_s);
    const deltaA =
      baselineTauSelectedS != null && tauA != null ? Math.abs(tauA - baselineTauSelectedS) : Number.POSITIVE_INFINITY;
    const deltaB =
      baselineTauSelectedS != null && tauB != null ? Math.abs(tauB - baselineTauSelectedS) : Number.POSITIVE_INFINITY;
    if (deltaA !== deltaB) return deltaA - deltaB;
    return a.id.localeCompare(b.id);
  });
  return sorted[0]?.id ?? null;
};

const buildFailureEnvelope = (results: ScenarioResult[]): FailureEnvelope => {
  const failReasonCounts: Record<string, number> = {};
  const reasonRows = results.filter((row) => row.classification !== 'compatible');
  for (const row of reasonRows) {
    const reasons =
      row.guard?.congruentSolveFailReasons && row.guard.congruentSolveFailReasons.length > 0
        ? row.guard.congruentSolveFailReasons
        : row.error
          ? [`error:${row.error}`]
          : ['unknown_failure'];
    for (const reason of reasons) {
      failReasonCounts[reason] = (failReasonCounts[reason] ?? 0) + 1;
    }
  }

  const nearPass = reasonRows
    .filter((row) => row.guard != null)
    .sort((a, b) => {
      const marginA = finiteOrNull(a.guard?.marginRatioRaw) ?? Number.POSITIVE_INFINITY;
      const marginB = finiteOrNull(b.guard?.marginRatioRaw) ?? Number.POSITIVE_INFINITY;
      if (marginA !== marginB) return marginA - marginB;
      return a.id.localeCompare(b.id);
    })[0];

  const regionCounts = new Map<string, { sampler: string | null; tauSelected_s: number | null; count: number }>();
  for (const row of reasonRows) {
    const sampler = row.guard?.sampler ?? null;
    const tauSelectedS = finiteOrNull(row.guard?.tauSelected_s);
    const key = `${sampler ?? 'null'}|${tauSelectedS ?? 'null'}`;
    const prev = regionCounts.get(key);
    if (prev) {
      prev.count += 1;
    } else {
      regionCounts.set(key, { sampler, tauSelected_s: tauSelectedS, count: 1 });
    }
  }

  return {
    failReasonCounts,
    nearPassScenario: nearPass
      ? {
          id: nearPass.id,
          lane: nearPass.lane,
          marginRatioRaw: finiteOrNull(nearPass.guard?.marginRatioRaw),
          sampler: nearPass.guard?.sampler ?? null,
          tauSelected_s: finiteOrNull(nearPass.guard?.tauSelected_s),
          failReasons: nearPass.guard?.congruentSolveFailReasons ?? [],
        }
      : null,
    recurrentIncompatibilityRegions: [...regionCounts.values()].sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      const ta = a.tauSelected_s ?? Number.POSITIVE_INFINITY;
      const tb = b.tauSelected_s ?? Number.POSITIVE_INFINITY;
      if (ta !== tb) return ta - tb;
      return String(a.sampler ?? '').localeCompare(String(b.sampler ?? ''));
    }),
  };
};

const evaluateSuccessAchieved = (
  successBar: string | null,
  winnerScenarioId: string | null,
  summary: { error: number },
): boolean => {
  const normalized = String(successBar ?? '').trim().toLowerCase();
  if (normalized === 'at_least_one_compatible') return winnerScenarioId != null;
  if (normalized === 'map_only') return summary.error === 0;
  return winnerScenarioId != null;
};

const renderMarkdown = (payload: any): string => {
  const rows = (payload.results as ScenarioResult[])
    .map((row) => {
      const margin = row.guard?.marginRatioRaw ?? 'n/a';
      const delta = row.deltaFromBaseline?.marginRatioRaw ?? 'n/a';
      const csContext = row.experimentalContext?.casimirSign;
      const qsContext = row.experimentalContext?.qSpoiling;
      const ngContext = row.experimentalContext?.nanogap;
      const tiContext = row.experimentalContext?.timing;
      const seContext = row.experimentalContext?.semEllips;
      const contextSummary = csContext
        ? `${csContext.branchHypothesis ?? 'n/a'};${csContext.materialPair ?? 'n/a'};${csContext.interveningMedium ?? 'n/a'}`
        : qsContext
          ? `${qsContext.mechanismLane ?? 'n/a'};Q0=${qsContext.q0Baseline ?? 'n/a'};F=${qsContext.f_q_spoil ?? 'n/a'}`
          : ngContext
            ? `${ngContext.profileId ?? 'n/a'};u_mean=${ngContext.u_g_mean_nm ?? 'n/a'};u_sigma=${ngContext.u_g_sigma_nm ?? 'n/a'}`
            : tiContext
              ? `${tiContext.profileId ?? 'n/a'};sigma=${tiContext.sigma_t_ps ?? 'n/a'};ts=${tiContext.timestamping_mode ?? 'n/a'}`
              : seContext
                ? `${seContext.profileId ?? 'n/a'};delta=${seContext.delta_se_nm ?? 'n/a'};U=${seContext.U_fused_nm ?? 'n/a'}`
              : 'n/a';
      const failReasons =
        row.guard?.congruentSolveFailReasons && row.guard.congruentSolveFailReasons.length > 0
          ? row.guard.congruentSolveFailReasons.join(', ')
          : row.error ?? 'none';
      return `| ${row.id} | ${row.lane} | ${contextSummary} | ${row.classification} | ${row.guard?.congruentSolvePass ?? 'n/a'} | ${margin} | ${delta} | ${failReasons} |`;
    })
    .join('\n');

  const failReasonRows = payload.failureEnvelope?.failReasonCounts
    ? Object.entries(payload.failureEnvelope.failReasonCounts)
        .map(([reason, count]) => `| ${reason} | ${count} |`)
        .join('\n')
    : '';
  const regionRows = payload.failureEnvelope?.recurrentIncompatibilityRegions
    ? (payload.failureEnvelope.recurrentIncompatibilityRegions as Array<any>)
        .map((row) => `| ${row.sampler ?? 'n/a'} | ${row.tauSelected_s ?? 'n/a'} | ${row.count} |`)
        .join('\n')
    : '';

  return `# Warp Shadow Injection Run (${payload.generatedOn})

${payload.boundaryStatement}

## Summary
- mode: ${payload.mode}
- non_blocking: ${payload.nonBlocking}
- scenario_count: ${payload.summary.scenarioCount}
- compatible: ${payload.summary.compatible}
- partial: ${payload.summary.partial}
- incompatible: ${payload.summary.incompatible}
- error: ${payload.summary.error}
- scenario_pack: \`${payload.scenarioPackPath}\`
- commit_pin: \`${payload.provenance.commitHash}\`

## Recovery Contract
- recovery_goal: ${payload.recovery_goal ?? 'n/a'}
- success_bar: ${payload.success_bar ?? 'n/a'}
- winnerScenarioId: ${payload.winnerScenarioId ?? 'null'}
- success_achieved: ${payload.successAchieved ?? 'n/a'}
- baseline_reference_path: ${payload.baselineReference?.path ?? 'n/a'}

## Baseline
- marginRatioRaw: ${payload.baseline.marginRatioRaw ?? 'n/a'}
- marginRatioRawComputed: ${payload.baseline.marginRatioRawComputed ?? 'n/a'}
- applicabilityStatus: ${payload.baseline.applicabilityStatus ?? 'n/a'}
- congruentSolvePass: ${payload.baseline.congruentSolvePass}
- sampler: ${payload.baseline.sampler ?? 'n/a'}
- fieldType: ${payload.baseline.fieldType ?? 'n/a'}
- tauSelected_s: ${payload.baseline.tauSelected_s ?? 'n/a'}

## Scenario Results
| scenario_id | lane | experimental_context | classification | congruentSolvePass | marginRatioRaw | deltaMarginRatioRaw | fail_or_error |
|---|---|---|---|---|---:|---:|---|
${rows || '| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |'}

## Failure Envelope
${payload.failureEnvelope ? '' : '- n/a (winner found)'}
${payload.failureEnvelope ? `- near_pass_scenario: ${payload.failureEnvelope.nearPassScenario?.id ?? 'n/a'}
- near_pass_marginRatioRaw: ${payload.failureEnvelope.nearPassScenario?.marginRatioRaw ?? 'n/a'}` : ''}
${payload.failureEnvelope ? `
### Fail Reasons
| reason | count |
|---|---:|
${failReasonRows || '| n/a | 0 |'}

### Recurrent Incompatibility Regions
| sampler | tauSelected_s | count |
|---|---:|---:|
${regionRows || '| n/a | n/a | 0 |'}
` : ''}
`;
};

const loadScenarioPack = (scenarioPath: string): ShadowScenarioPack => {
  const raw = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as ShadowScenarioPack;
  if (!raw || !Array.isArray(raw.scenarios)) {
    throw new Error(`Invalid scenario pack at ${scenarioPath}: missing scenarios[]`);
  }
  return raw;
};

export const runWarpShadowInjection = async (options: {
  scenarioPath?: string;
  outJsonPath?: string;
  outMdPath?: string;
}) => {
  const scenarioPath = options.scenarioPath ?? DEFAULT_SCENARIO_PATH;
  const outJsonPath = options.outJsonPath ?? DEFAULT_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_OUT_MD;
  const scenarioPack = loadScenarioPack(scenarioPath);

  const commitHash = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

  let baselineState = initializePipelineState();
  baselineState = await updateParameters(baselineState, buildPromotedBaseParams(), { includeReadinessSignals: true });
  baselineState = ensureRecoveryCurvatureSignals(baselineState as any);
  const baselineGuard = evaluateQiGuardrail(baselineState, {
    sampler: toSamplingKind((baselineState as any)?.qi?.sampler),
    tau_ms: finiteOrNull((baselineState as any)?.qi?.tau_s_ms) ?? undefined,
  });
  const baseline = summarizeGuard(baselineGuard);

  const results: ScenarioResult[] = [];
  for (const scenario of scenarioPack.scenarios) {
    try {
      let state = initializePipelineState();
      state = await updateParameters(state, buildPromotedBaseParams(), { includeReadinessSignals: true });
      state = await updateParameters(state, buildOverrideParams(scenario), { includeReadinessSignals: true });
      state = ensureRecoveryCurvatureSignals(state as any);

      const guard = evaluateQiGuardrail(state, {
        sampler: toSamplingKind((state as any)?.qi?.sampler),
        tau_ms: finiteOrNull((state as any)?.qi?.tau_s_ms) ?? undefined,
      });
      const summary = summarizeGuard(guard);
      results.push({
        id: scenario.id,
        lane: scenario.lane,
        description: scenario.description,
        registryRefs: Array.isArray(scenario.registryRefs) ? scenario.registryRefs : [],
        experimentalContext: scenario.experimentalContext,
        classification: classifyScenario(summary),
        guard: summary,
        deltaFromBaseline: computeDelta(baseline, summary),
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        id: scenario.id,
        lane: scenario.lane,
        description: scenario.description,
        registryRefs: Array.isArray(scenario.registryRefs) ? scenario.registryRefs : [],
        experimentalContext: scenario.experimentalContext,
        classification: 'error',
        guard: null,
        deltaFromBaseline: null,
        error: message,
      });
    }
  }

  const summary = {
    scenarioCount: results.length,
    compatible: results.filter((r) => r.classification === 'compatible').length,
    partial: results.filter((r) => r.classification === 'partial').length,
    incompatible: results.filter((r) => r.classification === 'incompatible').length,
    error: results.filter((r) => r.classification === 'error').length,
  };

  const recoveryGoal = stringOrNull(scenarioPack.recovery_goal);
  const successBar = stringOrNull(scenarioPack.success_bar);
  const computedWinnerScenarioId = pickWinnerScenarioId(results, baseline.tauSelected_s);
  const winnerScenarioId =
    String(successBar ?? '')
      .trim()
      .toLowerCase() === 'at_least_one_compatible'
      ? computedWinnerScenarioId
      : null;
  const successAchieved = evaluateSuccessAchieved(successBar, winnerScenarioId, summary);
  const failureEnvelope = winnerScenarioId == null ? buildFailureEnvelope(results) : null;

  const payload = {
    generatedOn: DATE_STAMP,
    mode: 'shadow_non_blocking',
    nonBlocking: true,
    boundaryStatement: scenarioPack.boundaryStatement ?? BOUNDARY_STATEMENT,
    notes: scenarioPack.notes ?? [],
    recovery_goal: recoveryGoal,
    success_bar: successBar,
    winnerScenarioId,
    successAchieved,
    failureEnvelope,
    baselineReference: scenarioPack.baseline_reference ?? null,
    scenarioPackPath: scenarioPath,
    baseline,
    summary,
    results,
    provenance: {
      commitHash,
    },
  };

  fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
  fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);

  fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
  fs.writeFileSync(outMdPath, `${renderMarkdown(payload)}\n`);

  return {
    ok: true,
    outJsonPath,
    outMdPath,
    summary,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scenarioPath = readArgValue('--scenarios') ?? DEFAULT_SCENARIO_PATH;
  const outJsonPath = readArgValue('--out') ?? DEFAULT_OUT_JSON;
  const outMdPath = readArgValue('--out-md') ?? DEFAULT_OUT_MD;
  runWarpShadowInjection({ scenarioPath, outJsonPath, outMdPath })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
