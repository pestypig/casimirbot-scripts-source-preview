import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  evaluateQiGuardrail,
  getGlobalPipelineState,
  setGlobalPipelineState,
  updateParameters,
} from '../server/energy-pipeline.js';
import { runGrAgentLoop, type GrAgentLoopOptions, type GrAgentLoopResult } from '../server/gr/gr-agent-loop.js';
import {
  buildGateMap,
  deriveCampaignDecision,
  deriveFirstFail,
  deriveG4Diagnostics,
  extractLatestAttempt,
  summarizeScoreboard,
} from './warp-full-solve-campaign.js';
import { PROMOTED_WARP_PROFILE_VERSION, WARP_SOLUTION_CATEGORY } from '../shared/warp-promoted-profile.js';

type Wave = 'A' | 'B' | 'C' | 'D';
type GateStatus = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_READY' | 'NOT_APPLICABLE';
type PromotionLane = 'fixed_candidate' | 'adaptive_profile';
type PromotionMismatchClass = 'param_carry_mismatch' | 'evaluator_drift' | 'none';

type PromotionCandidate = {
  id: string;
  params: Record<string, unknown>;
  applicabilityStatus?: string;
  marginRatioRaw?: number | null;
  marginRatioRawComputed?: number | null;
  comparabilityClass?: string;
  reasonCode?: string[];
};

type PromotionCheckResult = {
  ok: boolean;
  blockedReason: string | null;
  outPath: string;
  candidateId: string | null;
  candidatePromotionReady: boolean;
  candidatePromotionStable: boolean;
  executedLanes: PromotionLane[];
  aggregateDecision: string | null;
  aggregateFirstFail: string | null;
  aggregateG4: string | null;
};

const DATE_STAMP = '2026-03-01';
const DEFAULT_RECOVERY_PATH = path.join('artifacts', 'research', 'full-solve', 'g4-recovery-search-2026-02-27.json');
const DEFAULT_OUT_PATH = path.join('artifacts', 'research', 'full-solve', `g4-candidate-promotion-check-${DATE_STAMP}.json`);
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const ADAPTIVE_WAVE_SETTINGS: Record<Wave, { runCount: number; maxIterations: number }> = {
  A: { runCount: 1, maxIterations: 1 },
  B: { runCount: 1, maxIterations: 2 },
  C: { runCount: 2, maxIterations: 2 },
  D: { runCount: 2, maxIterations: 2 },
};

const FIXED_WAVE_SETTINGS: Record<Wave, { runCount: number; maxIterations: number }> = {
  A: { runCount: 1, maxIterations: 1 },
  B: { runCount: 1, maxIterations: 1 },
  C: { runCount: 2, maxIterations: 1 },
  D: { runCount: 2, maxIterations: 1 },
};

const GATE_STATUS_PRECEDENCE: Record<GateStatus, number> = {
  FAIL: 5,
  NOT_READY: 4,
  UNKNOWN: 3,
  PASS: 2,
  NOT_APPLICABLE: 1,
};

const finiteOrNull = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const str = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''));
const finiteOrUndefined = (n: unknown): number | undefined => {
  const value = Number(n);
  return Number.isFinite(value) ? value : undefined;
};
const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const resolveLaneOrder = (laneArg: string | undefined): PromotionLane[] => {
  const normalized = String(laneArg ?? 'both').trim().toLowerCase();
  if (normalized === 'fixed' || normalized === 'fixed_candidate') return ['fixed_candidate'];
  if (normalized === 'adaptive' || normalized === 'adaptive_profile') return ['adaptive_profile'];
  return ['fixed_candidate', 'adaptive_profile'];
};

const ensureDir = (dirPath: string) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const writeJson = (filePath: string, payload: unknown) => {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
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

const LEGACY_RADIUS_KEY = `${'shipRadius'}_m` as const;
const resolveBubbleRadiusParam = (row: Record<string, unknown>): number | undefined =>
  finiteOrUndefined(row.bubbleRadius_m ?? row[LEGACY_RADIUS_KEY]);

const buildCandidateProposalParams = (candidate: PromotionCandidate): Record<string, unknown> => {
  const row = (candidate.params ?? {}) as Record<string, unknown>;
  const dutyCycle = finiteOrUndefined(row.dutyCycle);
  const dutyShip = finiteOrUndefined(row.dutyShip ?? dutyCycle);
  const dutyEffectiveFR = finiteOrUndefined(row.dutyEffective_FR ?? dutyCycle);
  const dynamicDutyCycle = finiteOrUndefined(row.dutyCycle);
  const dynamicSectorCount = finiteOrUndefined(row.sectorCount);
  const dynamicConcurrentSectors = finiteOrUndefined(row.concurrentSectors);
  const dynamicWarpFieldType = stringOrUndefined(row.warpFieldType);
  const dynamicCavityQ = finiteOrUndefined(row.qCavity);
  const sampler = stringOrUndefined(row.sampler);
  const fieldType = stringOrUndefined(row.fieldType);
  const tau_s_ms = finiteOrUndefined(row.tau_s_ms);
  const bubbleRadius = resolveBubbleRadiusParam(row);

  return {
    warpFieldType: dynamicWarpFieldType,
    gammaGeo: finiteOrUndefined(row.gammaGeo),
    dutyCycle,
    dutyShip,
    dutyEffective_FR: dutyEffectiveFR,
    sectorCount: dynamicSectorCount,
    concurrentSectors: dynamicConcurrentSectors,
    gammaVanDenBroeck: finiteOrUndefined(row.gammaVanDenBroeck),
    qCavity: dynamicCavityQ,
    qSpoilingFactor: finiteOrUndefined(row.qSpoilingFactor),
    gap_nm: finiteOrUndefined(row.gap_nm),
    ...(bubbleRadius !== undefined
      ? {
          bubble: { R: bubbleRadius },
          R: bubbleRadius,
        }
      : {}),
    qi: {
      sampler,
      fieldType,
      tau_s_ms,
    },
    dynamicConfig: {
      ...(dynamicWarpFieldType ? { warpFieldType: dynamicWarpFieldType } : {}),
      ...(dynamicDutyCycle !== undefined ? { dutyCycle: dynamicDutyCycle } : {}),
      ...(dynamicSectorCount !== undefined ? { sectorCount: dynamicSectorCount } : {}),
      ...(dynamicConcurrentSectors !== undefined ? { concurrentSectors: dynamicConcurrentSectors } : {}),
      ...(dynamicCavityQ !== undefined ? { cavityQ: dynamicCavityQ } : {}),
    },
  };
};

type GuardSnapshot = {
  lhs_Jm3: number | null;
  boundComputed_Jm3: number | null;
  marginRatioRawComputed: number | null;
  applicabilityStatus: string | null;
  rhoSource: string | null;
  tauConfigured_s: number | null;
  tauSelected_s: number | null;
};

const snapshotFromGuard = (guard: any): GuardSnapshot => ({
  lhs_Jm3: finiteOrNull(guard?.lhs_Jm3),
  boundComputed_Jm3: finiteOrNull(guard?.boundComputed_Jm3),
  marginRatioRawComputed: finiteOrNull(guard?.marginRatioRawComputed),
  applicabilityStatus: typeof guard?.applicabilityStatus === 'string' ? guard.applicabilityStatus : null,
  rhoSource: typeof guard?.rhoSource === 'string' ? guard.rhoSource : null,
  tauConfigured_s: finiteOrNull(guard?.tauConfigured_s),
  tauSelected_s: finiteOrNull(guard?.tauSelected_s),
});

type PromotionMismatchAssessment = {
  class: PromotionMismatchClass;
  reasons: string[];
  compared: boolean;
};

export const assessPromotionMismatch = (
  candidate: PromotionCandidate,
  preLoopGuard: GuardSnapshot | null,
  firstAttemptDiagnostics: ReturnType<typeof deriveG4Diagnostics> | null,
): PromotionMismatchAssessment => {
  if (!preLoopGuard || !firstAttemptDiagnostics) {
    return { class: 'none', reasons: ['comparison_unavailable'], compared: false };
  }

  const reasons: string[] = [];
  const candidateWarpFieldType = stringOrUndefined(candidate.params?.warpFieldType);
  const firstRhoSource = typeof firstAttemptDiagnostics.rhoSource === 'string' ? firstAttemptDiagnostics.rhoSource : null;
  const preLoopRhoSource = preLoopGuard.rhoSource;
  const firstMargin = finiteOrNull(firstAttemptDiagnostics.marginRatioRawComputed);
  const preLoopMargin = preLoopGuard.marginRatioRawComputed;

  if (candidateWarpFieldType && firstRhoSource && !firstRhoSource.includes(`.${candidateWarpFieldType}.`)) {
    reasons.push(`rho_source_mismatch:expected=${candidateWarpFieldType};actual=${firstRhoSource}`);
  }
  if (preLoopRhoSource && firstRhoSource && preLoopRhoSource !== firstRhoSource) {
    reasons.push(`rho_source_changed:pre=${preLoopRhoSource};post=${firstRhoSource}`);
  }

  const expectedTau = finiteOrUndefined(candidate.params?.tau_s_ms);
  const firstTau = finiteOrNull(firstAttemptDiagnostics.tauConfigured_s);
  if (expectedTau != null && firstTau != null) {
    const expectedTau_s = expectedTau / 1000;
    const rel = expectedTau_s > 0 ? Math.abs(firstTau - expectedTau_s) / expectedTau_s : Number.POSITIVE_INFINITY;
    if (rel > 0.05) reasons.push(`tau_mismatch:expected=${expectedTau_s};actual=${firstTau}`);
  }

  const preLoopPass = preLoopMargin != null && preLoopMargin < 1;
  const firstAttemptFail = firstMargin == null || firstMargin >= 1;
  if (preLoopPass && firstAttemptFail) {
    reasons.push(`margin_drift:pre=${preLoopMargin};post=${String(firstMargin)}`);
  }

  const hasCarryMismatch = reasons.some(
    (reason) => reason.startsWith('rho_source_mismatch') || reason.startsWith('rho_source_changed') || reason.startsWith('tau_mismatch'),
  );
  if (hasCarryMismatch) return { class: 'param_carry_mismatch', reasons, compared: true };
  if (preLoopPass && firstAttemptFail) return { class: 'evaluator_drift', reasons, compared: true };
  return { class: 'none', reasons, compared: true };
};

const isCandidatePassComparable = (entry: PromotionCandidate | null | undefined): entry is PromotionCandidate => {
  if (!entry) return false;
  const applicability = str(entry.applicabilityStatus).toUpperCase();
  const marginRaw = finiteOrNull(entry.marginRatioRaw);
  const marginRawComputed = finiteOrNull(entry.marginRatioRawComputed);
  const comparable = str(entry.comparabilityClass) === 'comparable_canonical';
  return applicability === 'PASS' && comparable && marginRaw != null && marginRaw < 1 && marginRawComputed != null && marginRawComputed < 1;
};

export const choosePromotionCandidate = (
  recovery: any,
  requestedCandidateId: string | null = null,
): { candidate: PromotionCandidate | null; blockedReason: string | null } => {
  const bestCandidate = recovery?.bestCandidate as PromotionCandidate | undefined;
  const topComparable = Array.isArray(recovery?.topComparableCandidates) ? (recovery.topComparableCandidates as PromotionCandidate[]) : [];
  const all = [bestCandidate, ...topComparable].filter(Boolean) as PromotionCandidate[];

  if (requestedCandidateId) {
    const requested = all.find((entry) => str(entry.id) === requestedCandidateId) ?? null;
    if (!requested) return { candidate: null, blockedReason: `requested_candidate_not_found:${requestedCandidateId}` };
    if (!isCandidatePassComparable(requested)) return { candidate: null, blockedReason: `requested_candidate_not_promotable:${requestedCandidateId}` };
    return { candidate: requested, blockedReason: null };
  }

  if (isCandidatePassComparable(bestCandidate)) {
    return { candidate: bestCandidate, blockedReason: null };
  }
  const firstPass = topComparable.find((entry) => isCandidatePassComparable(entry)) ?? null;
  if (!firstPass) return { candidate: null, blockedReason: 'no_pass_comparable_candidate_in_recovery_artifact' };
  return { candidate: firstPass, blockedReason: null };
};

type AggregatedGateMap = Record<string, { status: GateStatus; reason: string; source: string }>;

export const aggregateGateMaps = (waveGateMaps: Array<{ wave: Wave; gateMap: Record<string, { status: GateStatus; reason: string; source: string }> }>): AggregatedGateMap => {
  const gateIds = new Set<string>();
  for (const entry of waveGateMaps) {
    for (const gateId of Object.keys(entry.gateMap)) gateIds.add(gateId);
  }
  const aggregated: AggregatedGateMap = {};
  for (const gateId of gateIds) {
    let chosen: { status: GateStatus; reason: string; source: string } | null = null;
    for (const entry of waveGateMaps) {
      const current = entry.gateMap[gateId];
      if (!current) continue;
      if (!chosen || GATE_STATUS_PRECEDENCE[current.status] > GATE_STATUS_PRECEDENCE[chosen.status]) {
        chosen = {
          status: current.status,
          reason: `[wave ${entry.wave}] ${current.reason}`,
          source: current.source,
        };
      }
    }
    if (chosen) aggregated[gateId] = chosen;
  }
  return aggregated;
};

const runWaveWithCandidate = async (
  lane: PromotionLane,
  wave: Wave,
  candidate: PromotionCandidate,
  baseOutDir: string,
): Promise<{
  lane: PromotionLane;
  wave: Wave;
  runCount: number;
  gateMap: Record<string, { status: GateStatus; reason: string; source: string }>;
  firstFail: { firstFail: string; reason: string };
  preLoopGuard: GuardSnapshot;
  firstAttemptDiagnostics: ReturnType<typeof deriveG4Diagnostics> | null;
  mismatch: PromotionMismatchAssessment;
  g4Diagnostics: ReturnType<typeof deriveG4Diagnostics>;
  runArtifacts: Array<{
    runIndex: number;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    accepted: boolean;
    state: string;
    acceptedIteration?: number;
    attemptCount: number;
    outputPath: string;
  }>;
}> => {
  const settings = lane === 'fixed_candidate' ? FIXED_WAVE_SETTINGS[wave] : ADAPTIVE_WAVE_SETTINGS[wave];
  const proposalParams = buildCandidateProposalParams(candidate);
  const runResults: GrAgentLoopResult[] = [];
  const runPreLoopGuards: GuardSnapshot[] = [];
  const runFirstAttemptDiagnostics: Array<ReturnType<typeof deriveG4Diagnostics> | null> = [];
  const runMismatch: PromotionMismatchAssessment[] = [];
  const runArtifacts: Array<{
    runIndex: number;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    accepted: boolean;
    state: string;
    acceptedIteration?: number;
    attemptCount: number;
    outputPath: string;
  }> = [];

  const waveDir = path.join(baseOutDir, lane, wave);
  ensureDir(waveDir);

  for (let runIndex = 0; runIndex < settings.runCount; runIndex += 1) {
    const originalState = structuredClone(getGlobalPipelineState() as any);
    const seededState = await updateParameters(structuredClone(originalState), proposalParams as any);
    const preLoopGuard = snapshotFromGuard(
      evaluateQiGuardrail(ensureRecoveryCurvatureSignals(structuredClone(seededState as any)), {
        sampler: stringOrUndefined((proposalParams as any)?.qi?.sampler) ?? 'gaussian',
        tau_ms: finiteOrUndefined((proposalParams as any)?.qi?.tau_s_ms) ?? 5,
      }),
    );
    if (lane === 'fixed_candidate') {
      setGlobalPipelineState(seededState as any);
    }

    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const options: GrAgentLoopOptions & { ciFastPath: boolean } = {
      maxIterations: settings.maxIterations,
      commitAccepted: false,
      useLiveSnapshot: false,
      ciFastPath: true,
      proposals: [
        {
          label: `promotion-${candidate.id}-${wave.toLowerCase()}-run-${runIndex + 1}`,
          params: proposalParams as any,
        },
      ],
    };

    try {
      const result = await runGrAgentLoop(options);
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startedMs;
      const outputPath = path.join(waveDir, `run-${runIndex + 1}-raw-output.json`);
      const firstAttempt = result.attempts[0] ?? null;
      const firstAttemptDiagnostics = firstAttempt ? deriveG4Diagnostics(firstAttempt) : null;
      const mismatch = assessPromotionMismatch(candidate, preLoopGuard, firstAttemptDiagnostics);
      writeJson(outputPath, {
        wave,
        lane,
        runIndex: runIndex + 1,
        startedAt,
        completedAt,
        durationMs,
        options,
        preLoopGuard,
        firstAttemptDiagnostics,
        mismatch,
        result,
      });
      runResults.push(result);
      runPreLoopGuards.push(preLoopGuard);
      runFirstAttemptDiagnostics.push(firstAttemptDiagnostics);
      runMismatch.push(mismatch);
      runArtifacts.push({
        runIndex: runIndex + 1,
        startedAt,
        completedAt,
        durationMs,
        accepted: result.accepted,
        state: result.state,
        acceptedIteration: result.acceptedIteration,
        attemptCount: result.attempts.length,
        outputPath,
      });
    } finally {
      setGlobalPipelineState(originalState as any);
    }
  }

  const gateMap = buildGateMap(wave, runResults, runArtifacts) as Record<string, { status: GateStatus; reason: string; source: string }>;
  const firstFail = deriveFirstFail(gateMap);
  const firstAttemptDiagnostics = runFirstAttemptDiagnostics[0] ?? null;
  const latestAttempt = runResults.length > 0 ? extractLatestAttempt(runResults[runResults.length - 1]) : null;
  const g4Diagnostics = deriveG4Diagnostics(latestAttempt);
  const preLoopGuard = runPreLoopGuards[0] ?? {
    lhs_Jm3: null,
    boundComputed_Jm3: null,
    marginRatioRawComputed: null,
    applicabilityStatus: null,
    rhoSource: null,
    tauConfigured_s: null,
    tauSelected_s: null,
  };
  const mismatch = runMismatch[0] ?? assessPromotionMismatch(candidate, preLoopGuard, firstAttemptDiagnostics);

  return {
    lane,
    wave,
    runCount: settings.runCount,
    gateMap,
    firstFail,
    preLoopGuard,
    firstAttemptDiagnostics,
    mismatch,
    g4Diagnostics,
    runArtifacts,
  };
};

type LaneAggregate = {
  lane: PromotionLane;
  perWave: Array<{
    wave: Wave;
    runCount: number;
    gateStatus: Record<string, GateStatus>;
    firstFail: string;
    firstFailReason: string;
    preLoopGuard: GuardSnapshot;
    firstAttemptDiagnostics: ReturnType<typeof deriveG4Diagnostics> | null;
    mismatch: PromotionMismatchAssessment;
    g4Diagnostics: ReturnType<typeof deriveG4Diagnostics>;
  }>;
  aggregateGateStatus: Record<string, GateStatus>;
  aggregateScoreboard: ReturnType<typeof summarizeScoreboard>;
  aggregateDecision: string;
  aggregateFirstFail: ReturnType<typeof deriveFirstFail>;
  aggregateG4: string | null;
  candidatePromotionReady: boolean;
};

export const derivePromotionReadiness = (
  aggregateGateMap: Record<string, { status: GateStatus; reason: string; source: string }>,
): {
  aggregateGateStatus: Record<string, GateStatus>;
  aggregateScoreboard: ReturnType<typeof summarizeScoreboard>;
  aggregateDecision: string;
  aggregateFirstFail: ReturnType<typeof deriveFirstFail>;
  aggregateG4: string | null;
  candidatePromotionReady: boolean;
} => {
  const aggregateGateStatus = Object.fromEntries(
    Object.entries(aggregateGateMap).map(([gateId, record]) => [gateId, record.status]),
  ) as Record<string, GateStatus>;
  const aggregateScoreboard = summarizeScoreboard(aggregateGateStatus as any);
  const aggregateDecision = deriveCampaignDecision(aggregateScoreboard.counts);
  const aggregateFirstFail = deriveFirstFail(aggregateGateMap as any);
  const aggregateG4 = aggregateGateMap.G4?.status ?? null;
  // Promotion readiness focuses on G4 closure and deterministic absence of fail/not-ready/unknown states.
  const candidatePromotionReady = aggregateG4 === 'PASS' && aggregateFirstFail.firstFail === 'none';
  return {
    aggregateGateStatus,
    aggregateScoreboard,
    aggregateDecision,
    aggregateFirstFail,
    aggregateG4,
    candidatePromotionReady,
  };
};

const runLaneAggregate = async (lane: PromotionLane, candidate: PromotionCandidate): Promise<LaneAggregate> => {
  const waveRuns = await Promise.all(
    (['A', 'B', 'C', 'D'] as Wave[]).map((wave) =>
      runWaveWithCandidate(lane, wave, candidate, path.join('artifacts', 'research', 'full-solve', 'promotion-check')),
    ),
  );

  const aggregatedGateMap = aggregateGateMaps(waveRuns.map((entry) => ({ wave: entry.wave, gateMap: entry.gateMap })));
  const {
    aggregateGateStatus,
    aggregateScoreboard,
    aggregateDecision,
    aggregateFirstFail,
    aggregateG4,
    candidatePromotionReady,
  } = derivePromotionReadiness(aggregatedGateMap);

  return {
    lane,
    perWave: waveRuns.map((entry) => ({
      wave: entry.wave,
      runCount: entry.runCount,
      gateStatus: Object.fromEntries(Object.entries(entry.gateMap).map(([gateId, gate]) => [gateId, gate.status])),
      firstFail: entry.firstFail.firstFail,
      firstFailReason: entry.firstFail.reason,
      preLoopGuard: entry.preLoopGuard,
      firstAttemptDiagnostics: entry.firstAttemptDiagnostics,
      mismatch: entry.mismatch,
      g4Diagnostics: entry.g4Diagnostics,
    })),
    aggregateGateStatus,
    aggregateScoreboard,
    aggregateDecision,
    aggregateFirstFail,
    aggregateG4,
    candidatePromotionReady,
  };
};

export const runCandidatePromotionCheck = async (
  opts: { recoveryPath?: string; outPath?: string; candidateId?: string; lane?: string } = {},
): Promise<PromotionCheckResult> => {
  const recoveryPath = opts.recoveryPath ?? DEFAULT_RECOVERY_PATH;
  const outPath = opts.outPath ?? DEFAULT_OUT_PATH;
  const requestedCandidateId = opts.candidateId ?? null;
  const laneOrder = resolveLaneOrder(opts.lane);
  const headCommitHash = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();

  if (!fs.existsSync(recoveryPath)) {
    writeJson(outPath, {
      runId: `g4-candidate-promotion-check-${DATE_STAMP}`,
      generatedAt: new Date().toISOString(),
      boundaryStatement: BOUNDARY_STATEMENT,
      solutionCategory: WARP_SOLUTION_CATEGORY,
      promotedProfileVersion: PROMOTED_WARP_PROFILE_VERSION,
      blockedReason: 'recovery_artifact_missing',
      recoveryPath,
      candidateId: null,
      candidatePromotionReady: false,
      candidatePromotionStable: false,
      executedLanes: laneOrder,
      provenance: { commitHash: headCommitHash },
    });
    return {
      ok: true,
      blockedReason: 'recovery_artifact_missing',
      outPath,
      candidateId: null,
      candidatePromotionReady: false,
      candidatePromotionStable: false,
      executedLanes: laneOrder,
      aggregateDecision: null,
      aggregateFirstFail: null,
      aggregateG4: null,
    };
  }

  const recovery = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
  const selected = choosePromotionCandidate(recovery, requestedCandidateId);
  if (!selected.candidate) {
    writeJson(outPath, {
      runId: `g4-candidate-promotion-check-${DATE_STAMP}`,
      generatedAt: new Date().toISOString(),
      boundaryStatement: BOUNDARY_STATEMENT,
      solutionCategory: WARP_SOLUTION_CATEGORY,
      promotedProfileVersion: PROMOTED_WARP_PROFILE_VERSION,
      blockedReason: selected.blockedReason,
      recoveryPath,
      candidateId: requestedCandidateId,
      candidatePromotionReady: false,
      candidatePromotionStable: false,
      executedLanes: laneOrder,
      provenance: { commitHash: headCommitHash },
    });
    return {
      ok: true,
      blockedReason: selected.blockedReason,
      outPath,
      candidateId: null,
      candidatePromotionReady: false,
      candidatePromotionStable: false,
      executedLanes: laneOrder,
      aggregateDecision: null,
      aggregateFirstFail: null,
      aggregateG4: null,
    };
  }

  const candidate = selected.candidate;
  const laneResults = await Promise.all(laneOrder.map((lane) => runLaneAggregate(lane, candidate)));
  const fixedLane = laneResults.find((entry) => entry.lane === 'fixed_candidate') ?? laneResults[0];
  const candidatePromotionReady = fixedLane?.candidatePromotionReady ?? false;
  const candidatePromotionStable = laneResults.every((entry) => entry.candidatePromotionReady);
  const seedMarginRawComputed = finiteOrNull(candidate.marginRatioRawComputed);
  const seedPassComparable =
    str(candidate.applicabilityStatus).toUpperCase() === 'PASS' &&
    str(candidate.comparabilityClass) === 'comparable_canonical' &&
    seedMarginRawComputed != null &&
    seedMarginRawComputed < 1;
  const promotionPathMismatch = seedPassComparable && !candidatePromotionReady;
  const aggregateDecision = fixedLane?.aggregateDecision ?? null;
  const aggregateFirstFail = fixedLane?.aggregateFirstFail?.firstFail ?? null;
  const aggregateG4 = fixedLane?.aggregateG4 ?? null;

  const payload = {
    runId: `g4-candidate-promotion-check-${DATE_STAMP}`,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    solutionCategory: WARP_SOLUTION_CATEGORY,
    promotedProfileVersion: PROMOTED_WARP_PROFILE_VERSION,
    blockedReason: null,
    recoveryPath,
    candidate: {
      id: candidate.id,
      params: candidate.params,
      applicabilityStatus: candidate.applicabilityStatus ?? null,
      marginRatioRaw: finiteOrNull(candidate.marginRatioRaw),
      marginRatioRawComputed: finiteOrNull(candidate.marginRatioRawComputed),
      comparabilityClass: candidate.comparabilityClass ?? null,
      reasonCode: Array.isArray(candidate.reasonCode) ? candidate.reasonCode : [],
    },
    laneOrder,
    laneResults: laneResults.map((entry) => ({
      lane: entry.lane,
      perWave: entry.perWave,
      aggregate: {
        gateStatus: entry.aggregateGateStatus,
        scoreboard: entry.aggregateScoreboard,
        decision: entry.aggregateDecision,
        firstFail: entry.aggregateFirstFail,
        g4Status: entry.aggregateG4,
        candidatePromotionReady: entry.candidatePromotionReady,
      },
    })),
    aggregate: {
      referenceLane: fixedLane?.lane ?? null,
      gateStatus: fixedLane?.aggregateGateStatus ?? {},
      scoreboard: fixedLane?.aggregateScoreboard ?? null,
      decision: fixedLane?.aggregateDecision ?? null,
      firstFail: fixedLane?.aggregateFirstFail ?? null,
      g4Status: fixedLane?.aggregateG4 ?? null,
      candidatePromotionReady,
      candidatePromotionStable,
    },
    analysis: {
      seedPassComparable,
      promotionPathMismatch,
      mismatchReason: promotionPathMismatch ? 'recovery_seed_pass_but_wave_promotion_failed' : 'none',
      seedMarginRatioRawComputed: seedMarginRawComputed,
      seedApplicabilityStatus: candidate.applicabilityStatus ?? null,
    },
    governance: {
      canonicalDecisionRemainsAuthoritative: true,
      note: 'Exploratory promotion check only. Canonical wave profile changes require explicit promotion and rerun.',
      adaptiveLaneMayDivergeFromFixedCandidate: true,
    },
    provenance: {
      commitHash: headCommitHash,
      recoveryProvenanceCommitHash: typeof recovery?.provenance?.commitHash === 'string' ? recovery.provenance.commitHash : null,
    },
  };
  writeJson(outPath, payload);

  return {
    ok: true,
    blockedReason: null,
    outPath,
    candidateId: candidate.id,
    candidatePromotionReady,
    candidatePromotionStable,
    executedLanes: laneOrder,
    aggregateDecision,
    aggregateFirstFail,
    aggregateG4,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCandidatePromotionCheck({
    recoveryPath: readArgValue('--recovery-path'),
    outPath: readArgValue('--out'),
    candidateId: readArgValue('--candidate-id'),
    lane: readArgValue('--lane'),
  })
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    });
}
