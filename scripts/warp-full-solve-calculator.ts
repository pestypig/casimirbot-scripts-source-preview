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
import {
  PROMOTED_WARP_PROFILE,
  PROMOTED_WARP_PROFILE_VERSION,
  WARP_SOLUTION_CATEGORY,
} from '../shared/warp-promoted-profile.js';

const DATE_STAMP = '2026-03-01';
const DEFAULT_OUT_PATH = path.join('artifacts', 'research', 'full-solve', `g4-calculator-${DATE_STAMP}.json`);
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

type CalculatorInput = {
  label?: string;
  params?: Record<string, unknown>;
  qi?: {
    sampler?: string;
    fieldType?: string;
    tau_s_ms?: number;
  };
  injectCurvatureSignals?: boolean;
};

type RunWarpFullSolveCalculatorOptions = {
  inputPath?: string;
  outPath?: string;
  writeOutput?: boolean;
  getCommitHash?: () => string;
  inputPayload?: CalculatorInput;
  injectCurvatureSignals?: boolean;
};

const finiteOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const stringOrNull = (value: unknown): string | null => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);
const finiteOrUndefined = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const resolveCommitHash = (): string => {
  const envHash = (
    process.env.GIT_SHA ??
    process.env.COMMIT_SHA ??
    process.env.GITHUB_SHA ??
    process.env.REPLIT_GIT_COMMIT
  )?.trim();
  if (envHash) {
    return envHash;
  }
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
};

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const hasArg = (name: string, argv = process.argv.slice(2)): boolean => argv.includes(name);

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

const G4_REASON_CODES = {
  marginExceeded: 'G4_QI_MARGIN_EXCEEDED',
  sourceNotMetric: 'G4_QI_SOURCE_NOT_METRIC',
  contractMissing: 'G4_QI_CONTRACT_MISSING',
  curvatureWindowFail: 'G4_QI_CURVATURE_WINDOW_FAIL',
  applicabilityNotPass: 'G4_QI_APPLICABILITY_NOT_PASS',
  signalMissing: 'G4_QI_SIGNAL_MISSING',
} as const;

const G4_REASON_CODE_ORDER = [
  G4_REASON_CODES.signalMissing,
  G4_REASON_CODES.sourceNotMetric,
  G4_REASON_CODES.contractMissing,
  G4_REASON_CODES.curvatureWindowFail,
  G4_REASON_CODES.applicabilityNotPass,
  G4_REASON_CODES.marginExceeded,
] as const;

const orderReasonCodes = (codes: string[]): string[] => {
  const unique = Array.from(new Set(codes));
  return unique.sort((a, b) => {
    const ia = G4_REASON_CODE_ORDER.indexOf(a as (typeof G4_REASON_CODE_ORDER)[number]);
    const ib = G4_REASON_CODE_ORDER.indexOf(b as (typeof G4_REASON_CODE_ORDER)[number]);
    const na = ia === -1 ? Number.MAX_SAFE_INTEGER : ia;
    const nb = ib === -1 ? Number.MAX_SAFE_INTEGER : ib;
    return na - nb || a.localeCompare(b);
  });
};

const deriveReasonCodes = (guard: ReturnType<typeof evaluateQiGuardrail>): string[] => {
  const reasons: string[] = [];
  if (guard.applicabilityReasonCode) reasons.push(guard.applicabilityReasonCode);
  if (String(guard.applicabilityStatus ?? 'UNKNOWN').toUpperCase() !== 'PASS') {
    reasons.push(G4_REASON_CODES.applicabilityNotPass);
  }
  if ((guard.marginRatioRawComputed ?? Number.POSITIVE_INFINITY) >= 1 || (guard.marginRatioRaw ?? Number.POSITIVE_INFINITY) >= 1) {
    reasons.push(G4_REASON_CODES.marginExceeded);
  }
  if (!stringOrNull(guard.rhoSource)?.startsWith('warp.metric')) reasons.push(G4_REASON_CODES.sourceNotMetric);
  if (guard.metricContractOk === false) reasons.push(G4_REASON_CODES.contractMissing);
  return orderReasonCodes(reasons);
};

const classifyDecision = (guard: ReturnType<typeof evaluateQiGuardrail>) => {
  const applicabilityPass = String(guard.applicabilityStatus ?? 'UNKNOWN').toUpperCase() === 'PASS';
  if (!applicabilityPass) return 'applicability_limited' as const;
  if ((guard.marginRatioRawComputed ?? Number.POSITIVE_INFINITY) >= 1) return 'margin_limited' as const;
  if ((guard.marginRatioRaw ?? Number.POSITIVE_INFINITY) >= 1) return 'margin_limited' as const;
  if (guard.congruentSolvePass) return 'candidate_pass_found' as const;
  return 'evidence_path_blocked' as const;
};

const loadInputPayload = (inputPath?: string, inputPayload?: CalculatorInput): CalculatorInput => {
  if (inputPayload) return inputPayload;
  if (!inputPath) return {};
  const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as CalculatorInput;
  return payload ?? {};
};

const buildPromotedBaseParams = (): Partial<EnergyPipelineState> => ({
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
    sampler: PROMOTED_WARP_PROFILE.qi.sampler as any,
    fieldType: PROMOTED_WARP_PROFILE.qi.fieldType as any,
    tau_s_ms: PROMOTED_WARP_PROFILE.qi.tau_s_ms as any,
  } as any,
  dynamicConfig: {
    warpFieldType: PROMOTED_WARP_PROFILE.warpFieldType,
    dutyCycle: PROMOTED_WARP_PROFILE.dutyCycle,
    sectorCount: PROMOTED_WARP_PROFILE.sectorCount,
    concurrentSectors: PROMOTED_WARP_PROFILE.concurrentSectors,
    cavityQ: PROMOTED_WARP_PROFILE.qCavity,
  } as any,
});

const buildOverrideParams = (payload: CalculatorInput): Partial<EnergyPipelineState> => {
  const params = ((payload.params ?? {}) as Record<string, unknown>);
  const qiInput = payload.qi ?? {};
  const qi = {
    ...(params.qi && typeof params.qi === 'object' ? (params.qi as Record<string, unknown>) : {}),
    ...(qiInput.sampler ? { sampler: qiInput.sampler } : {}),
    ...(qiInput.fieldType ? { fieldType: qiInput.fieldType } : {}),
    ...(finiteOrUndefined(qiInput.tau_s_ms) !== undefined ? { tau_s_ms: finiteOrUndefined(qiInput.tau_s_ms) } : {}),
  };
  return {
    ...params,
    qi,
  } as Partial<EnergyPipelineState>;
};

export const runWarpFullSolveCalculator = async (
  options: RunWarpFullSolveCalculatorOptions = {},
) => {
  const outPath = options.outPath ?? DEFAULT_OUT_PATH;
  const payload = loadInputPayload(options.inputPath, options.inputPayload);
  const getCommitHash = options.getCommitHash ?? resolveCommitHash;

  let state = initializePipelineState();
  state = await updateParameters(state, buildPromotedBaseParams(), { includeReadinessSignals: true });
  state = await updateParameters(state, buildOverrideParams(payload), { includeReadinessSignals: true });

  const injectCurvatureSignals = options.injectCurvatureSignals ?? payload.injectCurvatureSignals ?? true;
  const guardInput = injectCurvatureSignals ? ensureRecoveryCurvatureSignals(state as any) : state;
  const guard = evaluateQiGuardrail(guardInput as any, {
    sampler: (guardInput as any)?.qi?.sampler,
    tau_ms: finiteOrUndefined((guardInput as any)?.qi?.tau_s_ms),
  });
  const reasonCode = deriveReasonCodes(guard);
  const decisionClass = classifyDecision(guard);

  const output = {
    date: DATE_STAMP,
    boundaryStatement: BOUNDARY_STATEMENT,
    label: stringOrNull(payload.label) ?? 'calculator-run',
    mode: 'single_case',
    profile: {
      base: 'promoted',
      source: options.inputPath ? 'input_file' : options.inputPayload ? 'input_payload' : 'default_promoted',
      solutionCategory: WARP_SOLUTION_CATEGORY,
      profileVersion: PROMOTED_WARP_PROFILE_VERSION,
    },
    input: {
      inputPath: options.inputPath ?? null,
      injectCurvatureSignals,
      overrides: {
        params: payload.params ?? {},
        qi: payload.qi ?? {},
      },
    },
    result: {
      lhs_Jm3: finiteOrNull(guard.lhs_Jm3),
      boundComputed_Jm3: finiteOrNull(guard.boundComputed_Jm3),
      boundUsed_Jm3: finiteOrNull(guard.boundUsed_Jm3),
      boundFloorApplied: Boolean(guard.boundFloorApplied),
      marginRatioRaw: finiteOrNull(guard.marginRatioRaw),
      marginRatioRawComputed: finiteOrNull(guard.marginRatioRawComputed),
      applicabilityStatus: stringOrNull(guard.applicabilityStatus) ?? 'UNKNOWN',
      reasonCode,
      rhoSource: stringOrNull(guard.rhoSource),
      metricContractOk: guard.metricContractOk === true,
      quantitySemanticType: stringOrNull(guard.quantitySemanticType),
      quantityWorldlineClass: stringOrNull(guard.quantityWorldlineClass),
      quantitySemanticComparable: Boolean(guard.quantitySemanticComparable),
      qeiStateClass: stringOrNull(guard.qeiStateClass),
      qeiRenormalizationScheme: stringOrNull(guard.qeiRenormalizationScheme),
      qeiSamplingNormalization: stringOrNull(guard.qeiSamplingNormalization),
      qeiOperatorMapping: stringOrNull(guard.qeiOperatorMapping),
      congruentSolvePolicyMarginPass: guard.congruentSolvePolicyMarginPass === true,
      congruentSolveComputedMarginPass: guard.congruentSolveComputedMarginPass === true,
      congruentSolveApplicabilityPass: guard.congruentSolveApplicabilityPass === true,
      congruentSolveMetricPass: guard.congruentSolveMetricPass === true,
      congruentSolveSemanticPass: guard.congruentSolveSemanticPass === true,
      congruentSolvePass: guard.congruentSolvePass === true,
      congruentSolveFailReasons: [...(guard.congruentSolveFailReasons ?? [])],
      decisionClass,
    },
    provenance: {
      commitHash: getCommitHash(),
    },
  };

  if (options.writeOutput !== false) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
  }

  return {
    ok: true,
    outPath,
    decisionClass,
    congruentSolvePass: output.result.congruentSolvePass,
    marginRatioRaw: output.result.marginRatioRaw,
    marginRatioRawComputed: output.result.marginRatioRawComputed,
  };
};

const isDirectScriptExecution = () => {
  const entryArg = process.argv[1];
  if (!entryArg) return false;
  const entryAbs = path.resolve(entryArg);
  const directUrl = pathToFileURL(entryAbs).href;
  if (import.meta.url !== directUrl) return false;
  const entryBase = path.basename(entryAbs).toLowerCase();
  return entryBase.includes('warp-full-solve-calculator');
};

if (isDirectScriptExecution()) {
  const inputPath = readArgValue('--input');
  const outPath = readArgValue('--out') ?? DEFAULT_OUT_PATH;
  const injectCurvatureSignals = !hasArg('--no-inject-curvature-signals');

  runWarpFullSolveCalculator({
    inputPath,
    outPath,
    injectCurvatureSignals,
  })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
