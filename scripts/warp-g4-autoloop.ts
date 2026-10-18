import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runCanonicalBundle } from './warp-full-solve-canonical-bundle';

type LoopClass =
  | 'evidence_path_blocked'
  | 'applicability_limited'
  | 'margin_limited'
  | 'candidate_pass_found'
  | 'solved'
  | 'stalled'
  | 'budget_exhausted';

type Mode = 'analyze' | 'status' | 'cycle';

const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const DEFAULTS = {
  mode: 'analyze' as Mode,
  maxIterations: 10,
  maxWallClockMinutes: 30,
  stallCycles: 3,
  artifactRoot: path.join('artifacts', 'research', 'full-solve'),
  statePath: path.join('artifacts', 'research', 'full-solve', 'g4-autoloop-state.json'),
  historyPath: path.join('artifacts', 'research', 'full-solve', 'g4-autoloop-history.jsonl'),
  promptPath: path.join('docs', 'audits', 'research', 'warp-g4-autoloop-next-prompt.md'),
  casimirPath: path.join('artifacts', 'casimir-verify.json'),
};

const files = {
  scoreboard: 'campaign-gate-scoreboard-2026-02-24.json',
  firstFail: 'campaign-first-fail-map-2026-02-24.json',
  decisionLedger: 'g4-decision-ledger-2026-02-26.json',
  governanceMatrix: 'g4-governance-matrix-2026-02-27.json',
  recovery: 'g4-recovery-search-2026-02-27.json',
  parity: 'g4-recovery-parity-2026-02-27.json',
  promotionBundle: 'g4-promotion-bundle-2026-03-01.json',
  canonicalReport: path.join('docs', 'audits', 'research', 'warp-full-solve-campaign-execution-report-2026-02-24.md'),
  ideology: path.join('docs', 'ethos', 'ideology.json'),
};

const parseArgs = (argv: string[]) => {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    const next = argv[i + 1];
    if (tok === '--mode' && (next === 'analyze' || next === 'status' || next === 'cycle')) out.mode = next;
    if (tok === '--max-iterations' && next) out.maxIterations = Math.max(0, Number(next));
    if (tok === '--max-wall-clock-minutes' && next) out.maxWallClockMinutes = Math.max(1, Number(next));
    if (tok === '--stall-cycles' && next) out.stallCycles = Math.max(1, Number(next));
    if (tok === '--artifact-root' && next) out.artifactRoot = next;
    if (tok === '--state-path' && next) out.statePath = next;
    if (tok === '--history-path' && next) out.historyPath = next;
    if (tok === '--prompt-path' && next) out.promptPath = next;
    if (tok === '--casimir-path' && next) out.casimirPath = next;
  }
  return out;
};

const stripBom = (input: string): string => input.replace(/^\uFEFF/, '');

const readIfExists = (p: string): any | null => {
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p);

  try {
    return JSON.parse(stripBom(raw.toString('utf8')));
  } catch {
    // PowerShell redirection/Set-Content may emit UTF-16LE JSON; fallback keeps status mode resilient.
    try {
      return JSON.parse(stripBom(raw.toString('utf16le')));
    } catch {
      return null;
    }
  }
};

const classify = (inputs: Record<string, any>): { loopClass: LoopClass; solved: boolean; stopReason: string } => {
  const requiredMissing = Object.entries(inputs)
    .filter(
      ([k, v]) =>
        k !== 'casimir' &&
        k !== 'ideology' &&
        k !== 'prevState' &&
        k !== 'canonicalReport' &&
        k !== 'promotionBundle' &&
        v == null,
    )
    .map(([k]) => k);
  if (requiredMissing.length > 0) {
    return { loopClass: 'evidence_path_blocked', solved: false, stopReason: `missing_required_artifacts:${requiredMissing.join(',')}` };
  }

  const scoreboardDecision = String(inputs.scoreboard?.decision ?? '').toUpperCase();
  const g4Status = String(inputs.scoreboard?.gateStatus?.G4 ?? 'UNKNOWN').toUpperCase();
  const canonicalClass = String(inputs.decisionLedger?.canonicalDecisionClass ?? 'evidence_path_blocked');
  const finalClass = canonicalClass === 'candidate_pass_found' ? 'candidate_pass_found' : canonicalClass;

  const casimirVerdict = String(inputs.casimir?.verdict ?? '').toUpperCase();
  const casimirIntegrityOk = inputs.casimir?.integrityOk === true;

  const solved = g4Status === 'PASS' && !['INADMISSIBLE', 'NOT_READY'].includes(scoreboardDecision) && casimirVerdict === 'PASS' && casimirIntegrityOk;
  if (solved) return { loopClass: 'solved', solved: true, stopReason: 'solve_criteria_met' };

  if (finalClass === 'applicability_limited' || finalClass === 'margin_limited' || finalClass === 'candidate_pass_found') {
    return { loopClass: finalClass, solved: false, stopReason: 'analyze_complete' };
  }

  return { loopClass: 'evidence_path_blocked', solved: false, stopReason: 'analyze_complete' };
};

const derivePromotionDelta = (scoreboard: any, promotionBundle: any) => {
  const canonicalDecision = String(scoreboard?.decision ?? 'UNKNOWN').toUpperCase();
  if (!promotionBundle) {
    return {
      class: 'missing' as const,
      reason: 'promotion_bundle_missing',
      candidateId: null,
      blockedReason: null,
      promotionLaneDecision: null,
      promotionLaneFirstFail: null,
      promotionLaneG4ComparablePassAllWaves: null,
      promotionLaneExecuted: false,
      canonicalDecision,
      promotable: false,
    };
  }

  const blockedReason =
    typeof promotionBundle?.blockedReason === 'string' && promotionBundle.blockedReason.trim().length > 0
      ? promotionBundle.blockedReason.trim()
      : null;
  const promotionLaneDecision =
    typeof promotionBundle?.promotionLaneDecision === 'string' ? promotionBundle.promotionLaneDecision.trim() : null;
  const promotionLaneFirstFail =
    typeof promotionBundle?.promotionLaneFirstFail === 'string' ? promotionBundle.promotionLaneFirstFail.trim() : null;
  const promotionLaneExecuted = promotionBundle?.promotionLaneExecuted === true;
  const promotionLaneG4ComparablePassAllWaves = promotionBundle?.promotionLaneG4ComparablePassAllWaves === true;
  const candidateId = typeof promotionBundle?.candidateId === 'string' ? promotionBundle.candidateId.trim() : null;

  if (blockedReason) {
    return {
      class: 'blocked' as const,
      reason: `promotion_bundle_blocked:${blockedReason}`,
      candidateId,
      blockedReason,
      promotionLaneDecision,
      promotionLaneFirstFail,
      promotionLaneG4ComparablePassAllWaves,
      promotionLaneExecuted,
      canonicalDecision,
      promotable: false,
    };
  }

  const laneAdmissible = String(promotionLaneDecision ?? '').toUpperCase() === 'REDUCED_ORDER_ADMISSIBLE';
  const laneFirstFailNone = String(promotionLaneFirstFail ?? 'none').toLowerCase() === 'none';
  if (promotionLaneExecuted && laneAdmissible && laneFirstFailNone && promotionLaneG4ComparablePassAllWaves) {
    return {
      class: 'candidate_viable' as const,
      reason: 'promotion_lane_reduced_order_admissible_with_g4_comparable_pass',
      candidateId,
      blockedReason: null,
      promotionLaneDecision,
      promotionLaneFirstFail,
      promotionLaneG4ComparablePassAllWaves,
      promotionLaneExecuted,
      canonicalDecision,
      promotable: true,
    };
  }

  return {
    class: 'not_viable' as const,
    reason: 'promotion_lane_not_admissible_or_g4_not_comparable_pass',
    candidateId,
    blockedReason: null,
    promotionLaneDecision,
    promotionLaneFirstFail,
    promotionLaneG4ComparablePassAllWaves,
    promotionLaneExecuted,
    canonicalDecision,
    promotable: false,
  };
};

const summarizeIdeology = (payload: any): string[] => {
  const rootId = String(payload?.rootId ?? 'mission-ethos');
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  const root = nodes.find((n: any) => n?.id === rootId) ?? nodes[0] ?? {};
  const children = Array.isArray(root?.children) ? root.children.slice(0, 5) : [];
  return [
    `- ideology root: ${String(root?.id ?? 'n/a')}`,
    `- ideology title: ${String(root?.title ?? 'n/a')}`,
    `- ideology advisory branches: ${children.length > 0 ? children.join(', ') : 'n/a'}`,
  ];
};

type AutoloopDeps = {
  runCycle: () => unknown;
};

export const runAutoloop = (argv = process.argv.slice(2), deps: Partial<AutoloopDeps> = {}) => {
  const opts = parseArgs(argv);
  const runCycle = deps.runCycle ?? runCanonicalBundle;
  const startedAt = new Date().toISOString();
  const nowMs = Date.now();

  const previousState = readIfExists(opts.statePath);
  const previousIterationCount = Number(previousState?.iterationCount ?? 0);
  const previousClass = String(previousState?.class ?? '');
  const previousStallCounter = Number(previousState?.stallCounter ?? 0);

  if (opts.mode === 'cycle' && previousIterationCount >= opts.maxIterations) {
    const iterationCount = previousIterationCount;
    const remainingIterations = Math.max(0, opts.maxIterations - iterationCount);
    const state = {
      runId: `g4-autoloop-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
      generatedAt: startedAt,
      boundaryStatement: BOUNDARY_STATEMENT,
      mode: opts.mode,
      class: 'budget_exhausted' as LoopClass,
      solved: false,
      stopReason: 'max_iterations_reached',
      stallCounter: previousStallCounter,
      iterationCount,
      remainingIterations,
      maxIterations: opts.maxIterations,
      maxWallClockMinutes: opts.maxWallClockMinutes,
      stallCycles: opts.stallCycles,
    };

    if (opts.mode !== 'status') {
      fs.mkdirSync(path.dirname(opts.statePath), { recursive: true });
      fs.mkdirSync(path.dirname(opts.historyPath), { recursive: true });
      fs.mkdirSync(path.dirname(opts.promptPath), { recursive: true });
      fs.writeFileSync(opts.statePath, `${JSON.stringify(state, null, 2)}\n`);
      fs.appendFileSync(opts.historyPath, `${JSON.stringify({
        ts: startedAt,
        class: state.class,
        solved: state.solved,
        stopReason: state.stopReason,
        stallCounter: state.stallCounter,
        iterationCount: state.iterationCount,
        remainingIterations: state.remainingIterations,
      })}\n`);
      fs.writeFileSync(
        opts.promptPath,
        `# Warp G4 DEGA autoloop next step\n\n## Hard boundary statement\n${BOUNDARY_STATEMENT}\n\n## Current deterministic state\n- class: ${state.class}\n- solved: ${state.solved}\n- iteration count: ${state.iterationCount}\n- remaining iterations: ${state.remainingIterations}\n`,
      );
    }

    console.log(JSON.stringify({ ok: true, class: state.class, solved: state.solved, statePath: opts.statePath, historyPath: opts.historyPath, promptPath: opts.promptPath }));
    return { ok: true, mode: opts.mode, statePath: opts.statePath, historyPath: opts.historyPath, promptPath: opts.promptPath, class: state.class };
  }

  if (opts.mode === 'cycle') {
    runCycle();
  }

  const inputPaths = {
    scoreboard: path.join(opts.artifactRoot, files.scoreboard),
    firstFail: path.join(opts.artifactRoot, files.firstFail),
    decisionLedger: path.join(opts.artifactRoot, files.decisionLedger),
    governanceMatrix: path.join(opts.artifactRoot, files.governanceMatrix),
    recovery: path.join(opts.artifactRoot, files.recovery),
    parity: path.join(opts.artifactRoot, files.parity),
    promotionBundle: path.join(opts.artifactRoot, files.promotionBundle),
    canonicalReport: files.canonicalReport,
    ideology: files.ideology,
    casimir: opts.casimirPath,
  };

  const inputs: Record<string, any> = {
    scoreboard: readIfExists(inputPaths.scoreboard),
    firstFail: readIfExists(inputPaths.firstFail),
    decisionLedger: readIfExists(inputPaths.decisionLedger),
    governanceMatrix: readIfExists(inputPaths.governanceMatrix),
    recovery: readIfExists(inputPaths.recovery),
    parity: readIfExists(inputPaths.parity),
    promotionBundle: readIfExists(inputPaths.promotionBundle),
    canonicalReport: fs.existsSync(inputPaths.canonicalReport) ? fs.readFileSync(inputPaths.canonicalReport, 'utf8') : null,
    ideology: readIfExists(inputPaths.ideology),
    casimir: readIfExists(inputPaths.casimir),
    prevState: previousState,
  };

  const outcome = classify(inputs);
  const parityClass = String(inputs.parity?.dominantFailureMode ?? 'evidence_path_blocked');
  const headCommitHash = (() => {
    try {
      return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  })();
  const parityCommitHash = typeof inputs.parity?.provenance?.commitHash === 'string' ? inputs.parity.provenance.commitHash : null;
  const recoveryCommitHash = typeof inputs.recovery?.provenance?.commitHash === 'string' ? inputs.recovery.provenance.commitHash : null;
  const parityFresh =
    headCommitHash != null &&
    parityCommitHash != null &&
    recoveryCommitHash != null &&
    parityCommitHash === headCommitHash &&
    recoveryCommitHash === headCommitHash;
  const promotionDelta = derivePromotionDelta(inputs.scoreboard, inputs.promotionBundle);
  const canonicalFirstFail = String(
    inputs.firstFail?.firstFail?.gate ??
      inputs.firstFail?.firstFail ??
      inputs.firstFail?.global?.firstFail?.gate ??
      inputs.firstFail?.global?.firstFail ??
      inputs.decisionLedger?.canonical?.firstFail ??
      'UNKNOWN',
  );

  const iterationIncrement = opts.mode === 'analyze' || opts.mode === 'cycle' ? 1 : 0;
  const iterationCount = previousIterationCount + iterationIncrement;
  const remainingIterations = Math.max(0, opts.maxIterations - iterationCount);
  const nextStallCounter = !outcome.solved && previousClass === outcome.loopClass ? previousStallCounter + 1 : 0;

  let loopClass: LoopClass = outcome.loopClass;
  let solved = outcome.solved;
  let stopReason = outcome.stopReason;

  if (!solved && (opts.mode === 'analyze' || opts.mode === 'cycle')) {
    if (previousIterationCount >= opts.maxIterations) {
      loopClass = 'budget_exhausted';
      stopReason = 'max_iterations_reached';
    } else if (nextStallCounter >= opts.stallCycles) {
      loopClass = 'stalled';
      stopReason = 'stall_cycles_reached';
    } else if (opts.mode === 'cycle' && !String(stopReason).startsWith('missing_required_artifacts:')) {
      stopReason = 'cycle_complete';
    }
  }

  const stallCounter = solved ? 0 : nextStallCounter;

  const state = {
    runId: `g4-autoloop-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
    generatedAt: startedAt,
    boundaryStatement: BOUNDARY_STATEMENT,
    mode: opts.mode,
    class: loopClass,
    solved,
    stopReason,
    stallCounter,
    iterationCount,
    remainingIterations,
    maxIterations: opts.maxIterations,
    maxWallClockMinutes: opts.maxWallClockMinutes,
    stallCycles: opts.stallCycles,
    canonicalDecision: String(inputs.scoreboard?.decision ?? 'UNKNOWN'),
    canonicalFirstFail,
    canonicalClass: String(inputs.decisionLedger?.canonicalDecisionClass ?? 'evidence_path_blocked'),
    parityClass,
    parityFreshness: parityFresh ? 'fresh' : 'stale_or_missing',
    parityCommitHash,
    recoveryCommitHash,
    headCommitHash,
    promotionDelta,
    artifacts: inputPaths,
    counters: {
      elapsedMs: 0,
      wallClockBudgetMs: Math.round(opts.maxWallClockMinutes * 60_000),
      stallCycles: opts.stallCycles,
      maxIterations: opts.maxIterations,
      iterationCount,
      remainingIterations,
      nowMs,
    },
  };

  const historyRecord = {
    ts: startedAt,
    class: state.class,
    solved: state.solved,
    stopReason: state.stopReason,
    stallCounter: state.stallCounter,
    iterationCount: state.iterationCount,
    remainingIterations: state.remainingIterations,
    canonicalDecision: state.canonicalDecision,
    canonicalFirstFail: state.canonicalFirstFail,
    promotionDeltaClass: promotionDelta.class,
    promotionDeltaReason: promotionDelta.reason,
  };

  const ideologyLines = summarizeIdeology(inputs.ideology);
  const prompt = `# Warp G4 DEGA autoloop next step\n\n## Hard boundary statement\n${BOUNDARY_STATEMENT}\n\n## Current deterministic state\n- class: ${state.class}\n- solved: ${state.solved}\n- canonical decision: ${state.canonicalDecision}\n- canonical first fail: ${state.canonicalFirstFail}\n- canonical class: ${state.canonicalClass}\n- parity class: ${state.parityClass}\n- parity freshness: ${state.parityFreshness}\n- iteration count: ${state.iterationCount}\n- remaining iterations: ${state.remainingIterations}\n\n## Canonical vs Promotion Delta\n- canonical decision: ${promotionDelta.canonicalDecision}\n- promotion delta class: ${promotionDelta.class}\n- promotion delta reason: ${promotionDelta.reason}\n- promotion candidate id: ${promotionDelta.candidateId ?? 'n/a'}\n- promotion blocked reason: ${promotionDelta.blockedReason ?? 'none'}\n- promotion lane decision: ${promotionDelta.promotionLaneDecision ?? 'n/a'}\n- promotion lane first fail: ${promotionDelta.promotionLaneFirstFail ?? 'n/a'}\n- promotion lane G4 comparable pass all waves: ${promotionDelta.promotionLaneG4ComparablePassAllWaves == null ? 'n/a' : promotionDelta.promotionLaneG4ComparablePassAllWaves}\n- promotion lane executed: ${promotionDelta.promotionLaneExecuted}\n- promotion promotable: ${promotionDelta.promotable}\n- canonical-authoritative rule: canonical remains decision-authoritative until explicit promotion governance accepts lane changes.\n\n## Stop criteria\n- maxIterations: ${opts.maxIterations}\n- maxWallClockMinutes: ${opts.maxWallClockMinutes}\n- stallCycles: ${opts.stallCycles}\n\n## Ideology context\n${ideologyLines.join('\n')}\nIdeology context is advisory only and cannot override evidence gates, guardrails, or completion criteria.\n`;

  if (opts.mode === 'status') {
    console.log(JSON.stringify({
      class: state.class,
      solved: state.solved,
      stopReason: state.stopReason,
      canonicalDecision: state.canonicalDecision,
      canonicalFirstFail: state.canonicalFirstFail,
      parityFreshness: state.parityFreshness,
      promotionDeltaClass: promotionDelta.class,
      promotionDeltaReason: promotionDelta.reason,
      promotionCandidateId: promotionDelta.candidateId,
      promotionPromotable: promotionDelta.promotable,
      promotionLaneDecision: promotionDelta.promotionLaneDecision,
      iterationCount: state.iterationCount,
      remainingIterations: state.remainingIterations,
      stallCounter: state.stallCounter,
    }));
    return { ok: true, mode: opts.mode, statePath: opts.statePath, historyPath: opts.historyPath, promptPath: opts.promptPath, class: state.class };
  }

  fs.mkdirSync(path.dirname(opts.statePath), { recursive: true });
  fs.mkdirSync(path.dirname(opts.historyPath), { recursive: true });
  fs.mkdirSync(path.dirname(opts.promptPath), { recursive: true });
  fs.writeFileSync(opts.statePath, `${JSON.stringify(state, null, 2)}\n`);
  fs.appendFileSync(opts.historyPath, `${JSON.stringify(historyRecord)}\n`);
  fs.writeFileSync(opts.promptPath, prompt);

  console.log(JSON.stringify({ ok: true, class: state.class, solved: state.solved, statePath: opts.statePath, historyPath: opts.historyPath, promptPath: opts.promptPath }));
  return { ok: true, mode: opts.mode, statePath: opts.statePath, historyPath: opts.historyPath, promptPath: opts.promptPath, class: state.class };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve(runAutoloop())
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
