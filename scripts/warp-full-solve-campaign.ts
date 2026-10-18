import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { type GrAgentLoopAttempt, type GrAgentLoopOptions, type GrAgentLoopResult } from '../server/gr/gr-agent-loop.js';
import { PROMOTED_WARP_PROFILE, PROMOTED_WARP_PROFILE_VERSION } from '../shared/warp-promoted-profile.js';

type GateStatus = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_READY' | 'NOT_APPLICABLE';
type Wave = 'A' | 'B' | 'C' | 'D';
type WaveArg = Wave | 'all';

type ParsedArgs = {
  wave: WaveArg;
  out: string;
  seed: number;
  ci: boolean;
  ciFastPath: boolean;
  waveTimeoutMs: number;
  campaignTimeoutMs: number;
  promotionCheckPath: string | null;
  promoteCandidateId: string | null;
  autoPromoteReadyCandidate: boolean;
  forcePromotedProfile: boolean;
  allowExploratoryWaveProfiles: boolean;
};

export type CliResult = {
  ok: boolean;
  waves: Wave[];
  out: string;
  campaign: { counts: ReturnType<typeof summarizeScoreboard>['counts'] | null; decision: string; reconciled: boolean };
  mode: 'ci' | 'local';
};

type GateRecord = {
  status: GateStatus;
  reason: string;
  source: string;
};

const GATE_PRECEDENCE: Record<GateStatus, number> = {
  FAIL: 5,
  NOT_READY: 4,
  UNKNOWN: 3,
  PASS: 2,
  NOT_APPLICABLE: 1,
};

type EvidencePack = {
  commitSha: string;
  runTimestamp: string;
  completedAt: string;
  runId: string;
  traceId: string;
  wave: Wave;
  seed: number;
  provenance: {
    command: string;
    cwd: string;
    mode: 'ci' | 'local';
  };
  commandMetadata: {
    maxIterations: number;
    runCount: number;
    waveProfile: Record<string, unknown>;
  };
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
  gateStatus: Record<string, GateStatus>;
  gateDetails: Record<string, GateRecord>;
  firstFail: string;
  firstFailReason: string;
  parsedGateMap: Record<string, GateRecord>;
  evaluationSummary: {
    hardConstraintMap: Record<string, string>;
    gateStatusByAttempt: Array<{ runIndex: number; gateStatus: string; pass: boolean }>;
  };
  requiredSignals: Record<string, { required: boolean; present: boolean }>;
  missingSignals: string[];
  gateMissingSignalMap: Record<string, string[]>;
  notReadyClassCounts: {
    timeout_budget: number;
    missing_required_signals: number;
    policy_not_applicable_misuse: number;
    other: number;
  };
  gateCauseClass: Record<string, 'timeout_budget' | 'missing_required_signals' | 'policy_not_applicable_misuse' | 'other' | 'none'>;
  g4Diagnostics: {
    fordRomanStatus: 'pass' | 'fail' | 'unknown' | 'missing';
    thetaAuditStatus: 'pass' | 'fail' | 'unknown' | 'missing';
    source: 'evaluator_constraints' | 'synthesized_unknown';
    reason: string[];
    reasonCode: string[];
    lhs_Jm3?: number;
    bound_Jm3?: number;
    boundComputed_Jm3?: number;
    boundFloor_Jm3?: number;
    boundPolicyFloor_Jm3?: number;
    boundEnvFloor_Jm3?: number;
    boundDefaultFloor_Jm3?: number;
    boundFallbackAbs_Jm3?: number;
    boundUsed_Jm3?: number;
    boundFloorApplied?: boolean;
    marginRatio?: number;
    marginRatioRaw?: number;
    marginRatioRawComputed?: number;
    uncertaintySigma_Jm3?: number;
    uncertaintySigmaMeasurement_Jm3?: number;
    uncertaintySigmaModel_Jm3?: number;
    uncertaintySigmaBridge_Jm3?: number;
    uncertaintySigmaTau_Jm3?: number;
    uncertaintyModelSigmaConfigured_Jm3?: number;
    uncertaintyModelSigmaSource?: string;
    uncertaintyModelSigmaRationale?: string;
    uncertaintyModelSigmaRequired?: boolean;
    uncertaintyModelSigmaProvenanceReady?: boolean;
    uncertaintyModelSigmaProvenanceMissing?: string;
    uncertaintyDominantComponent?: 'measurement' | 'model' | 'bridge' | 'tau' | 'none';
    uncertaintyBandKSigma?: number;
    uncertaintySlackPolicy_Jm3?: number;
    uncertaintySlackComputed_Jm3?: number;
    uncertaintyBandLowerPolicy_Jm3?: number;
    uncertaintyBandUpperPolicy_Jm3?: number;
    uncertaintyBandLowerComputed_Jm3?: number;
    uncertaintyBandUpperComputed_Jm3?: number;
    uncertaintyDecisionClass?: 'robust_pass' | 'indeterminate' | 'robust_fail';
    uncertaintyCouldFlip?: boolean;
    uncertaintyInputsMissing?: string;
    g4FloorDominated?: boolean;
    g4PolicyExceeded?: boolean;
    g4ComputedExceeded?: boolean;
    g4DualFailMode?: 'policy_only' | 'computed_only' | 'both' | 'neither';
    couplingMode?: string;
    couplingAlpha?: number;
    rhoMetric_Jm3?: number;
    rhoMetricSource?: string;
    rhoProxy_Jm3?: number;
    rhoProxySource?: string;
    rhoCoupledShadow_Jm3?: number;
    couplingResidualRel?: number;
    couplingComparable?: boolean;
    couplingEquationRef?: string;
    couplingSemantics?: string;
    quantitySemanticBaseType?: string;
    quantitySemanticType?: string;
    quantitySemanticTargetType?: string;
    quantityWorldlineClass?: string;
    quantitySemanticComparable?: boolean;
    quantitySemanticReason?: string;
    quantitySemanticBridgeMode?: string;
    quantitySemanticBridgeReady?: boolean;
    quantitySemanticBridgeMissing?: string;
    qeiStateClass?: string;
    qeiRenormalizationScheme?: string;
    qeiSamplingNormalization?: string;
    qeiOperatorMapping?: string;
    congruentSolvePolicyMarginPass?: boolean;
    congruentSolveComputedMarginPass?: boolean;
    congruentSolveApplicabilityPass?: boolean;
    congruentSolveMetricPass?: boolean;
    congruentSolveSemanticPass?: boolean;
    congruentSolvePass?: boolean;
    congruentSolveFailReasons?: string[];
    rhoSource?: string;
    metricT00Ref?: string;
    metricT00Geom?: number;
    metricT00GeomSource?: string;
    metricT00Si?: number;
    metricT00SiFromGeom?: number;
    metricT00SiRelError?: number;
    metricContractStatus?: string;
    applicabilityStatus?: string;
    curvatureOk?: boolean;
    curvatureRatio?: number;
    curvatureScalar?: number;
    curvatureRadius_m?: number;
    curvatureFlatSpaceEquivalent?: boolean;
    curvatureEnforced?: boolean;
    tau_s?: number;
    tauConfigured_s?: number;
    tauWindow_s?: number;
    tauPulse_s?: number;
    tauLC_s?: number;
    tauSelected_s?: number;
    tauSelectedSource?: string;
    tauSelectorPolicy?: string;
    tauSelectorFallbackApplied?: boolean;
    tauProvenanceReady?: boolean;
    tauProvenanceMissing?: string;
    K?: number;
    safetySigma_Jm3?: number;
  };
  timeout?: { kind: 'wave_timeout' | 'campaign_timeout'; timeoutMs: number; elapsedMs: number; wave?: Wave };
  reproducibility: {
    repeatedRunGateAgreement: { status: GateStatus; agreementRatio: number | null; reason: string };
    constraintPayloadDrift: { status: GateStatus; driftRatio: number | null; reason: string };
    residualTrend: {
      status: GateStatus;
      fidelityLevels: number;
      trend: 'decreasing' | 'non_decreasing' | 'unknown';
      reason: string;
      series: number[];
    };
  };
  claimPosture: 'diagnostic/reduced-order';
  executiveTranslationRef: string;
  boundaryStatement: string;
};

type QiForensicsArtifact = {
  runId: string;
  wave: Wave;
  seed: number;
  timestamp: string;
  rhoSource: string | null;
  metricDerived: boolean | null;
  metricContractOk: boolean | null;
  effectiveRho_SI_Jm3: number | null;
  rhoOn_SI_Jm3: number | null;
  metricT00Ref: string | null;
  metricT00Geom_GeomStress: number | null;
  metricT00GeomSource: string | null;
  metricT00Si_Jm3: number | null;
  metricT00SiFromGeom_Jm3: number | null;
  metricT00SiRelError: number | null;
  lhs_Jm3: number | null;
  bound_Jm3: number | null;
  boundComputed_Jm3: number | null;
  boundFloor_Jm3: number | null;
  boundPolicyFloor_Jm3: number | null;
  boundEnvFloor_Jm3: number | null;
  boundDefaultFloor_Jm3: number | null;
  boundFallbackAbs_Jm3: number | null;
  boundUsed_Jm3: number | null;
  boundFloorApplied: boolean | null;
  marginRatioRaw: number | null;
  marginRatioRawComputed: number | null;
  uncertaintySigma_Jm3: number | null;
  uncertaintySigmaMeasurement_Jm3: number | null;
  uncertaintySigmaModel_Jm3: number | null;
  uncertaintySigmaBridge_Jm3: number | null;
  uncertaintySigmaTau_Jm3: number | null;
  uncertaintyModelSigmaConfigured_Jm3: number | null;
  uncertaintyModelSigmaSource: string | null;
  uncertaintyModelSigmaRationale: string | null;
  uncertaintyModelSigmaRequired: boolean | null;
  uncertaintyModelSigmaProvenanceReady: boolean | null;
  uncertaintyModelSigmaProvenanceMissing: string | null;
  uncertaintyDominantComponent: string | null;
  uncertaintyBandKSigma: number | null;
  uncertaintySlackPolicy_Jm3: number | null;
  uncertaintySlackComputed_Jm3: number | null;
  uncertaintyBandLowerPolicy_Jm3: number | null;
  uncertaintyBandUpperPolicy_Jm3: number | null;
  uncertaintyBandLowerComputed_Jm3: number | null;
  uncertaintyBandUpperComputed_Jm3: number | null;
  uncertaintyDecisionClass: string | null;
  uncertaintyCouldFlip: boolean | null;
  uncertaintyInputsMissing: string | null;
  g4FloorDominated: boolean | null;
  g4PolicyExceeded: boolean | null;
  g4ComputedExceeded: boolean | null;
  g4DualFailMode: 'policy_only' | 'computed_only' | 'both' | 'neither' | null;
  marginRatioClamped: number | null;
  couplingMode: string | null;
  couplingAlpha: number | null;
  rhoMetric_Jm3: number | null;
  rhoMetricSource: string | null;
  rhoProxy_Jm3: number | null;
  rhoProxySource: string | null;
  rhoCoupledShadow_Jm3: number | null;
  couplingResidualRel: number | null;
  couplingComparable: boolean | null;
  couplingEquationRef: string | null;
  couplingSemantics: string | null;
  quantitySemanticBaseType: string | null;
  quantitySemanticType: string | null;
  quantitySemanticTargetType: string | null;
  quantityWorldlineClass: string | null;
  quantitySemanticComparable: boolean | null;
  quantitySemanticReason: string | null;
  quantitySemanticBridgeMode: string | null;
  quantitySemanticBridgeReady: boolean | null;
  quantitySemanticBridgeMissing: string | null;
  qeiStateClass: string | null;
  qeiRenormalizationScheme: string | null;
  qeiSamplingNormalization: string | null;
  qeiOperatorMapping: string | null;
  congruentSolvePolicyMarginPass: boolean | null;
  congruentSolveComputedMarginPass: boolean | null;
  congruentSolveApplicabilityPass: boolean | null;
  congruentSolveMetricPass: boolean | null;
  congruentSolveSemanticPass: boolean | null;
  congruentSolvePass: boolean | null;
  congruentSolveFailReasons: string[];
  tau_s: number | null;
  tauConfigured_s: number | null;
  tauWindow_s: number | null;
  tauPulse_s: number | null;
  tauLC_s: number | null;
  tauSelected_s: number | null;
  tauSelectedSource: string | null;
  tauSelectorPolicy: string | null;
  tauSelectorFallbackApplied: boolean | null;
  tauProvenanceReady: boolean | null;
  tauProvenanceMissing: string | null;
  samplingKernelIdentity: string | null;
  samplingKernelNormalization: string | null;
  sampler: string | null;
  fieldType: string | null;
  K: number | null;
  KUnits: string | null;
  KProvenanceCommit: string | null;
  KDerivation: string | null;
  safetySigma_Jm3: number | null;
  curvatureScalar: number | null;
  curvatureRadius_m: number | null;
  curvatureRatio: number | null;
  curvatureRatioNonDegenerate: boolean | null;
  curvatureFlatSpaceEquivalent: boolean | null;
  curvatureEnforced: boolean | null;
  curvatureOk: boolean | null;
  applicabilityStatus: string | null;
  g4ReasonCodes: string[];
};

type TimeoutKind = 'wave_timeout' | 'campaign_timeout';
type NotReadyClass = 'timeout_budget' | 'missing_required_signals' | 'policy_not_applicable_misuse' | 'other';

const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const DATE_STAMP = '2026-02-24';
const CANONICAL_ARTIFACT_ROOT = path.join('artifacts', 'research', 'full-solve');
const DEFAULT_PROMOTION_CHECK_PATH = path.join('artifacts', 'research', 'full-solve', 'g4-candidate-promotion-check-2026-03-01.json');
const EXECUTIVE_TRANSLATION_DOC = `docs/audits/research/warp-gates-executive-translation-${DATE_STAMP}.md`;
const ALLOWED_WAVES: readonly WaveArg[] = ['A', 'B', 'C', 'D', 'all'] as const;
const FIRST_FAIL_ORDER = ['G0', 'G1', 'G2', 'G3', 'G4', 'G6', 'G7', 'G8'] as const;
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
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

type GovernanceClassResolution = {
  canonicalClass: string;
  freshness: 'fresh' | 'missing_artifact' | 'invalid_artifact' | 'stale_provenance';
  freshnessReason: string;
  artifactCommitHash: string | null;
  headCommitHash: string | null;
};

const resolveHeadCommitHash = (cwdCandidates: string[]): string | null => {
  for (const cwd of cwdCandidates) {
    try {
      return execSync('git rev-parse HEAD', { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      continue;
    }
  }
  return null;
};

const isResolvableCommitHash = (hash: string, cwd: string): boolean => {
  try {
    execFileSync('git', ['cat-file', '-e', `${hash}^{commit}`], { encoding: 'utf8', stdio: 'ignore', cwd });
    return true;
  } catch {
    return false;
  }
};

export const resolveGovernanceCanonicalClass = (
  governanceMatrixPath: string,
  rootDir = '.',
): GovernanceClassResolution => {
  if (!fs.existsSync(governanceMatrixPath)) {
    return {
      canonicalClass: 'evidence_path_blocked',
      freshness: 'missing_artifact',
      freshnessReason: 'governance_matrix_missing',
      artifactCommitHash: null,
      headCommitHash: resolveHeadCommitHash([rootDir, process.cwd()]),
    };
  }

  let governanceMatrix: any;
  try {
    governanceMatrix = JSON.parse(fs.readFileSync(governanceMatrixPath, 'utf8'));
  } catch {
    return {
      canonicalClass: 'evidence_path_blocked',
      freshness: 'invalid_artifact',
      freshnessReason: 'governance_matrix_invalid_json',
      artifactCommitHash: null,
      headCommitHash: resolveHeadCommitHash([rootDir, process.cwd()]),
    };
  }

  const canonicalClass =
    typeof governanceMatrix?.canonicalAuthoritativeClass === 'string' && governanceMatrix.canonicalAuthoritativeClass.length > 0
      ? governanceMatrix.canonicalAuthoritativeClass
      : 'evidence_path_blocked';
  const artifactCommitHash =
    typeof governanceMatrix?.commitHash === 'string' && governanceMatrix.commitHash.trim().length > 0
      ? governanceMatrix.commitHash.trim()
      : null;
  const headCommitHash = resolveHeadCommitHash([rootDir, process.cwd()]);
  const artifactCommitWellFormed = artifactCommitHash != null && COMMIT_HASH_RE.test(artifactCommitHash);
  const artifactCommitResolvable = artifactCommitWellFormed && isResolvableCommitHash(artifactCommitHash, rootDir);
  const artifactCommitFresh = artifactCommitResolvable && headCommitHash != null && artifactCommitHash === headCommitHash;

  if (!artifactCommitFresh) {
    const reasonParts = [
      `artifactCommitHash=${artifactCommitHash ?? 'null'}`,
      `headCommitHash=${headCommitHash ?? 'null'}`,
      `wellFormed=${artifactCommitWellFormed}`,
      `resolvable=${artifactCommitResolvable}`,
    ];
    return {
      canonicalClass: 'evidence_path_blocked',
      freshness: 'stale_provenance',
      freshnessReason: reasonParts.join(';'),
      artifactCommitHash,
      headCommitHash,
    };
  }

  return {
    canonicalClass,
    freshness: 'fresh',
    freshnessReason: 'none',
    artifactCommitHash,
    headCommitHash,
  };
};

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

const REQUIRED_SIGNAL_KEYS = [
  'initial_solver_status',
  'evaluation_gate_status',
  'hard_constraint_ford_roman_qi',
  'hard_constraint_theta_audit',
  'certificate_hash',
  'certificate_integrity',
  'provenance_chart',
  'provenance_observer',
  'provenance_normalization',
  'provenance_unit_system',
  'applicability_status',
  'applicability_curvature_ok',
  'applicability_curvature_ratio',
  'operator_quantity_semantic_base_type',
  'operator_quantity_semantic_type',
  'operator_quantity_semantic_target_type',
  'operator_worldline_timelike',
  'operator_qei_state_hadamard',
  'operator_qei_renormalization_point_splitting',
  'operator_qei_sampling_unit_integral',
  'operator_qei_mapping_t_munu_uu_ren',
  'operator_semantic_comparable',
  'operator_bridge_ready',
  'operator_mapping_derivation_ref',
  'uncertainty_model_sigma_source',
  'uncertainty_model_sigma_rationale',
  'uncertainty_model_sigma_required',
  'uncertainty_model_sigma_provenance_ready',
] as const;


const WAVE_PROFILES: Record<Wave, { runCount: number; options: GrAgentLoopOptions }> = {
  A: {
    runCount: 2,
    options: {
      maxIterations: 1,
      commitAccepted: false,
      useLiveSnapshot: false,
      proposals: [
        {
          label: 'wave-a-natario-baseline',
          params: {
            warpFieldType: 'natario',
            dutyCycle: 0.14,
            gammaGeo: 26,
            gammaVanDenBroeck: 38.3,
            qCavity: 1e9,
            qSpoilingFactor: 1,
            gap_nm: 1,
            bubbleRadius_m: 10,
          },
        },
      ],
    },
  },
  B: {
    runCount: 2,
    options: {
      maxIterations: 2,
      commitAccepted: false,
      useLiveSnapshot: false,
      proposals: [
        {
          label: 'wave-b-natario-sdf',
          params: {
            warpFieldType: 'natario_sdf',
            dutyCycle: 0.09,
            dutyShip: 0.09,
            dutyEffective_FR: 0.09,
            gammaGeo: 18,
            gammaVanDenBroeck: 64,
            qCavity: 5e8,
            qSpoilingFactor: 0.8,
            gap_nm: 0.7,
            bubbleRadius_m: 8,
          },
        },
      ],
    },
  },
  C: {
    runCount: 2,
    options: {
      maxIterations: 2,
      commitAccepted: false,
      useLiveSnapshot: false,
      proposals: [
        {
          label: 'wave-c-irrotational-low-duty',
          params: {
            warpFieldType: 'irrotational',
            dutyCycle: 0.04,
            dutyShip: 0.04,
            dutyEffective_FR: 0.04,
            gammaGeo: 8,
            gammaVanDenBroeck: 12,
            qCavity: 2e9,
            qSpoilingFactor: 1.6,
            gap_nm: 2,
            bubbleRadius_m: 6,
          },
        },
        {
          label: 'wave-c-irrotational-perturb',
          params: {
            warpFieldType: 'irrotational',
            dutyCycle: 0.05,
            dutyShip: 0.05,
            dutyEffective_FR: 0.05,
            gammaGeo: 7.5,
            gammaVanDenBroeck: 10,
            qCavity: 1.5e9,
            qSpoilingFactor: 1.8,
            gap_nm: 2.5,
            bubbleRadius_m: 6,
          },
        },
      ],
    },
  },
  D: {
    runCount: 2,
    options: {
      maxIterations: 2,
      commitAccepted: false,
      useLiveSnapshot: false,
      proposals: [
        {
          label: 'wave-d-natario-sdf-high-q',
          params: {
            warpFieldType: 'natario_sdf',
            dutyCycle: 0.22,
            dutyShip: 0.22,
            dutyEffective_FR: 0.22,
            gammaGeo: 55,
            gammaVanDenBroeck: 220,
            qCavity: 8e10,
            qSpoilingFactor: 0.4,
            gap_nm: 0.45,
            bubbleRadius_m: 14,
          },
        },
        {
          label: 'wave-d-natario-sdf-replica',
          params: {
            warpFieldType: 'natario_sdf',
            dutyCycle: 0.2,
            dutyShip: 0.2,
            dutyEffective_FR: 0.2,
            gammaGeo: 50,
            gammaVanDenBroeck: 180,
            qCavity: 1e11,
            qSpoilingFactor: 0.5,
            gap_nm: 0.5,
            bubbleRadius_m: 16,
          },
        },
      ],
    },
  },
};

type PromotionCheckCandidate = {
  id: string;
  params: Record<string, unknown>;
  applicabilityStatus?: string;
  marginRatioRaw?: number | null;
  marginRatioRawComputed?: number | null;
  comparabilityClass?: string;
};

const numericOrNull = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const finiteOrUndefined = (value: unknown): number | undefined => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
};

const LEGACY_RADIUS_KEY = `${'shipRadius'}_m` as const;
const resolveBubbleRadiusParam = (row: Record<string, unknown>): number | undefined =>
  finiteOrUndefined(row.bubbleRadius_m ?? row[LEGACY_RADIUS_KEY]);

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const asPromotionCandidate = (value: unknown): PromotionCheckCandidate | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : null;
  const params = record.params && typeof record.params === 'object' ? (record.params as Record<string, unknown>) : null;
  if (!id || !params) return null;
  return {
    id,
    params,
    applicabilityStatus: typeof record.applicabilityStatus === 'string' ? record.applicabilityStatus : undefined,
    marginRatioRaw: numericOrNull(record.marginRatioRaw),
    marginRatioRawComputed: numericOrNull(record.marginRatioRawComputed),
    comparabilityClass: typeof record.comparabilityClass === 'string' ? record.comparabilityClass : undefined,
  };
};

const isPromotableCandidate = (candidate: PromotionCheckCandidate | null): candidate is PromotionCheckCandidate => {
  if (!candidate) return false;
  const applicabilityPass = String(candidate.applicabilityStatus ?? '').toUpperCase() === 'PASS';
  const comparable = String(candidate.comparabilityClass ?? '') === 'comparable_canonical';
  const marginRaw = numericOrNull(candidate.marginRatioRaw);
  const marginRawComputed = numericOrNull(candidate.marginRatioRawComputed);
  return applicabilityPass && comparable && marginRaw != null && marginRaw < 1 && marginRawComputed != null && marginRawComputed < 1;
};

const buildPromotedProposalParams = (candidate: PromotionCheckCandidate): Record<string, unknown> => {
  const row = candidate.params;
  const dutyCycle = finiteOrUndefined(row.dutyCycle);
  const dutyShip = finiteOrUndefined(row.dutyShip ?? dutyCycle);
  const dutyEffectiveFR = finiteOrUndefined(row.dutyEffective_FR ?? dutyCycle);
  const sectorCount = finiteOrUndefined(row.sectorCount);
  const concurrentSectors = finiteOrUndefined(row.concurrentSectors);
  const warpFieldType = stringOrUndefined(row.warpFieldType);
  const qCavity = finiteOrUndefined(row.qCavity);
  const sampler = stringOrUndefined(row.sampler);
  const fieldType = stringOrUndefined(row.fieldType);
  const tau_s_ms = finiteOrUndefined(row.tau_s_ms);
  const bubbleRadius = resolveBubbleRadiusParam(row);

  return {
    ...(warpFieldType ? { warpFieldType } : {}),
    ...(finiteOrUndefined(row.gammaGeo) !== undefined ? { gammaGeo: finiteOrUndefined(row.gammaGeo) } : {}),
    ...(dutyCycle !== undefined ? { dutyCycle } : {}),
    ...(dutyShip !== undefined ? { dutyShip } : {}),
    ...(dutyEffectiveFR !== undefined ? { dutyEffective_FR: dutyEffectiveFR } : {}),
    ...(sectorCount !== undefined ? { sectorCount } : {}),
    ...(concurrentSectors !== undefined ? { concurrentSectors } : {}),
    ...(finiteOrUndefined(row.gammaVanDenBroeck) !== undefined ? { gammaVanDenBroeck: finiteOrUndefined(row.gammaVanDenBroeck) } : {}),
    ...(qCavity !== undefined ? { qCavity } : {}),
    ...(finiteOrUndefined(row.qSpoilingFactor) !== undefined ? { qSpoilingFactor: finiteOrUndefined(row.qSpoilingFactor) } : {}),
    ...(finiteOrUndefined(row.gap_nm) !== undefined ? { gap_nm: finiteOrUndefined(row.gap_nm) } : {}),
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
      ...(warpFieldType ? { warpFieldType } : {}),
      ...(dutyCycle !== undefined ? { dutyCycle } : {}),
      ...(sectorCount !== undefined ? { sectorCount } : {}),
      ...(concurrentSectors !== undefined ? { concurrentSectors } : {}),
      ...(qCavity !== undefined ? { cavityQ: qCavity } : {}),
    },
  };
};

const buildForcedPromotedProposalParams = (): Record<string, unknown> => ({
  warpFieldType: PROMOTED_WARP_PROFILE.warpFieldType,
  gammaGeo: PROMOTED_WARP_PROFILE.gammaGeo,
  dutyCycle: PROMOTED_WARP_PROFILE.dutyCycle,
  dutyShip: PROMOTED_WARP_PROFILE.dutyShip,
  dutyEffective_FR: PROMOTED_WARP_PROFILE.dutyShip,
  sectorCount: PROMOTED_WARP_PROFILE.sectorCount,
  concurrentSectors: PROMOTED_WARP_PROFILE.concurrentSectors,
  gammaVanDenBroeck: PROMOTED_WARP_PROFILE.gammaVanDenBroeck,
  qCavity: PROMOTED_WARP_PROFILE.qCavity,
  qSpoilingFactor: PROMOTED_WARP_PROFILE.qSpoilingFactor,
  gap_nm: PROMOTED_WARP_PROFILE.gap_nm,
  bubble: {
    R: PROMOTED_WARP_PROFILE.reducedOrderReference.radius_m,
  },
  R: PROMOTED_WARP_PROFILE.reducedOrderReference.radius_m,
  modulationFreq_GHz: PROMOTED_WARP_PROFILE.modulationFreq_GHz,
  tauLC_ms: PROMOTED_WARP_PROFILE.tauLC_ms,
  qi: {
    sampler: PROMOTED_WARP_PROFILE.qi.sampler,
    fieldType: PROMOTED_WARP_PROFILE.qi.fieldType,
    tau_s_ms: PROMOTED_WARP_PROFILE.qi.tau_s_ms,
  },
  dynamicConfig: {
    warpFieldType: PROMOTED_WARP_PROFILE.warpFieldType,
    dutyCycle: PROMOTED_WARP_PROFILE.dutyCycle,
    sectorCount: PROMOTED_WARP_PROFILE.sectorCount,
    concurrentSectors: PROMOTED_WARP_PROFILE.concurrentSectors,
    cavityQ: PROMOTED_WARP_PROFILE.qCavity,
  },
});

const buildWaveProfilesFromPromotedParams = (promotedParams: Record<string, unknown>, labelKey: string) =>
  (['A', 'B', 'C', 'D'] as Wave[]).reduce<Record<Wave, { runCount: number; options: GrAgentLoopOptions }>>((acc, wave) => {
    const baseProfile = WAVE_PROFILES[wave];
    const maxIterations = Math.max(1, Number(baseProfile.options.maxIterations ?? 1));
    const proposals = Array.from({ length: maxIterations }, (_, index) => ({
      label: `wave-${wave.toLowerCase()}-${labelKey}-iter-${index + 1}`,
      params: structuredClone(promotedParams),
    }));
    acc[wave] = {
      runCount: baseProfile.runCount,
      options: {
        ...baseProfile.options,
        proposals,
      },
    };
    return acc;
  }, {} as Record<Wave, { runCount: number; options: GrAgentLoopOptions }>);

const loadPromotedCandidateFromArtifact = (
  promotionCheckPath: string,
  requestedCandidateId: string | null,
): PromotionCheckCandidate => {
  if (!fs.existsSync(promotionCheckPath)) {
    throw new Error(`Promotion check artifact missing at ${promotionCheckPath}.`);
  }
  const raw = JSON.parse(fs.readFileSync(promotionCheckPath, 'utf8')) as Record<string, unknown>;
  const blockedReason = typeof raw.blockedReason === 'string' ? raw.blockedReason : null;
  if (blockedReason) {
    throw new Error(`Promotion check is blocked (${blockedReason}); cannot promote candidate wave profile.`);
  }
  const aggregate = (raw.aggregate && typeof raw.aggregate === 'object' ? raw.aggregate : {}) as Record<string, unknown>;
  if (aggregate.candidatePromotionReady !== true) {
    throw new Error('Promotion check artifact indicates candidatePromotionReady=false; refusing promotion.');
  }
  if (aggregate.candidatePromotionStable !== true) {
    throw new Error('Promotion check artifact indicates candidatePromotionStable=false; refusing promotion.');
  }

  const selected = asPromotionCandidate(raw.candidate);
  if (!selected) {
    throw new Error('Promotion check artifact is missing candidate payload.');
  }
  if (requestedCandidateId && selected.id !== requestedCandidateId) {
    throw new Error(`Requested candidate ${requestedCandidateId} does not match promotion artifact candidate ${selected.id}.`);
  }
  if (!isPromotableCandidate(selected)) {
    throw new Error(`Candidate ${selected.id} is not promotable under canonical-comparable PASS criteria.`);
  }
  return selected;
};

export const resolveWaveProfiles = (
  args: Pick<ParsedArgs, 'promotionCheckPath' | 'promoteCandidateId' | 'allowExploratoryWaveProfiles'> & {
    autoPromoteReadyCandidate?: boolean;
    forcePromotedProfile?: boolean;
  },
) => {
  if (args.forcePromotedProfile) {
    return buildWaveProfilesFromPromotedParams(
      buildForcedPromotedProposalParams(),
      `promoted-profile-${PROMOTED_WARP_PROFILE_VERSION}`,
    );
  }

  const explicitPromotionRequested = Boolean(args.promoteCandidateId);
  const autoPromotionRequested = Boolean(args.autoPromoteReadyCandidate);
  if (!explicitPromotionRequested && !autoPromotionRequested) {
    return WAVE_PROFILES;
  }

  const promotionCheckPath = args.promotionCheckPath ?? DEFAULT_PROMOTION_CHECK_PATH;
  let promotedCandidate: PromotionCheckCandidate;
  try {
    promotedCandidate = loadPromotedCandidateFromArtifact(promotionCheckPath, args.promoteCandidateId);
  } catch (error) {
    if (autoPromotionRequested && !explicitPromotionRequested) {
      return WAVE_PROFILES;
    }
    if (args.allowExploratoryWaveProfiles) {
      return WAVE_PROFILES;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Promoted-only wave profile resolution failed: ${detail} ` +
        '(pass --allow-exploratory-wave-profiles to run legacy exploratory profiles intentionally).',
    );
  }
  const promotedParams = buildPromotedProposalParams(promotedCandidate);

  return buildWaveProfilesFromPromotedParams(promotedParams, `promoted-${promotedCandidate.id}`);
};

const mkdirp = (p: string) => fs.mkdirSync(p, { recursive: true });
const sortDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortDeep((value as Record<string, unknown>)[key])])) as Record<string, unknown>;
};
const writeJson = (p: string, value: unknown) => {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, `${JSON.stringify(sortDeep(value), null, 2)}\n`);
};
const writeMd = (p: string, body: string) => {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, body);
};
const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const stringOrNull = (value: unknown): string | null => (typeof value === 'string' && value.trim().length > 0 ? value : null);
const booleanOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const hashId = (src: string) => Buffer.from(src).toString('hex').slice(0, 16);
const resolveTsxRunner = () => path.resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const resolveSingleRunCli = () => path.resolve(process.cwd(), 'scripts', 'warp-full-solve-single-runner.ts');

class CampaignTimeoutError extends Error {
  kind: TimeoutKind;
  timeoutMs: number;
  elapsedMs: number;
  wave?: Wave;

  constructor(kind: TimeoutKind, timeoutMs: number, elapsedMs: number, wave?: Wave) {
    super(`${kind}:${timeoutMs}`);
    this.name = 'CampaignTimeoutError';
    this.kind = kind;
    this.timeoutMs = timeoutMs;
    this.elapsedMs = elapsedMs;
    this.wave = wave;
  }
}

const withTimeout = async <T>(
  run: Promise<T>,
  timeoutMs: number,
  kind: TimeoutKind,
  elapsedBaseMs: number,
  wave?: Wave,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new CampaignTimeoutError(kind, timeoutMs, elapsedBaseMs + timeoutMs, wave));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const parseWaveArg = (value: string | undefined): WaveArg => {
  const normalized = (value ?? 'all').trim();
  if ((ALLOWED_WAVES as readonly string[]).includes(normalized)) {
    return normalized as WaveArg;
  }
  throw new Error(`Invalid --wave value "${value}". Allowed values: A|B|C|D|all`);
};

export const parseSeedArg = (value: string | undefined): number => {
  const normalized = (value ?? '').trim();
  if (!normalized) {
    throw new Error('Invalid --seed value "". Seed must be a finite integer.');
  }
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
    throw new Error(`Invalid --seed value "${value}". Seed must be a finite integer.`);
  }
  return numeric;
};

const runGrAgentLoopIsolated = async (
  args: { options: GrAgentLoopOptions; wave: Wave; runIndex: number; baseDir: string; ciFastPath?: boolean },
  timeoutMs: number,
  timeoutKind: TimeoutKind,
  elapsedBaseMs: number,
): Promise<GrAgentLoopResult> => {
  const tsxCli = resolveTsxRunner();
  const runnerCli = resolveSingleRunCli();
  if (!fs.existsSync(tsxCli)) {
    throw new Error(`Missing tsx runtime: ${tsxCli}`);
  }
  if (!fs.existsSync(runnerCli)) {
    throw new Error(`Missing isolated runner: ${runnerCli}`);
  }

  const runNonce = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const inputPath = path.join(args.baseDir, `run-${args.runIndex}-input-${runNonce}.json`);
  const outputPath = path.join(args.baseDir, `run-${args.runIndex}-isolated-${runNonce}.json`);
  writeJson(inputPath, {
    wave: args.wave,
    runIndex: args.runIndex,
    options: args.options,
    ciFastPath: Boolean(args.ciFastPath),
  });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, runnerCli, '--input', inputPath, '--output', outputPath], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        if (fs.existsSync(outputPath)) {
          try {
            const timeoutPayload = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as { ok?: boolean; result?: GrAgentLoopResult };
            if (timeoutPayload.ok && timeoutPayload.result) {
              resolve();
              return;
            }
          } catch {
            // Fall through to fail-closed timeout handling.
          }
        }
        reject(new CampaignTimeoutError(timeoutKind, timeoutMs, elapsedBaseMs + timeoutMs, args.wave));
        return;
      }
      if (code !== 0) {
        let message = `Isolated GR runner exited with code ${code}`;
        if (fs.existsSync(outputPath)) {
          try {
            const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as { ok?: boolean; error?: { message?: string } };
            if (payload?.error?.message) {
              message = payload.error.message;
            }
          } catch {
            // Preserve default message when parsing fails.
          }
        }
        reject(new Error(message));
        return;
      }
      resolve();
    });
  });

  if (!fs.existsSync(outputPath)) {
    throw new Error('Isolated GR runner completed without output artifact.');
  }
  const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as {
    ok?: boolean;
    result?: GrAgentLoopResult;
    error?: { message?: string };
  };
  if (!payload.ok || !payload.result) {
    throw new Error(payload.error?.message ?? 'Isolated GR runner returned missing result payload.');
  }
  return payload.result;
};

export const parsePositiveIntArg = (value: string | undefined, argName: string): number => {
  const normalized = (value ?? '').trim();
  if (!normalized) {
    throw new Error(`Invalid --${argName} value "". Value must be a positive integer in milliseconds.`);
  }
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`Invalid --${argName} value "${value}". Value must be a positive integer in milliseconds.`);
  }
  return numeric;
};

export const parseArgs = (argv = process.argv.slice(2)): ParsedArgs => {
  const args = argv;
  const read = (name: string, fallback?: string) => {
    const i = args.findIndex((v) => v === name || v.startsWith(`${name}=`));
    if (i < 0) return fallback;
    if (args[i].includes('=')) return args[i].split('=', 2)[1];
    return args[i + 1] ?? fallback;
  };

  const wave = parseWaveArg(read('--wave', 'all'));
  return {
    wave,
    out: read('--out', 'artifacts/research/full-solve')!,
    seed: parseSeedArg(read('--seed', '20260224')),
    ci: args.includes('--ci'),
    ciFastPath: args.includes('--ci-fast-path'),
    waveTimeoutMs: parsePositiveIntArg(read('--wave-timeout-ms', '120000'), 'wave-timeout-ms'),
    campaignTimeoutMs: parsePositiveIntArg(read('--campaign-timeout-ms', '600000'), 'campaign-timeout-ms'),
    promotionCheckPath: read('--promotion-check-path', DEFAULT_PROMOTION_CHECK_PATH) ?? DEFAULT_PROMOTION_CHECK_PATH,
    promoteCandidateId: read('--promote-candidate-id', '')?.trim() || null,
    autoPromoteReadyCandidate: args.includes('--auto-promote-ready-candidate'),
    forcePromotedProfile: args.includes('--force-promoted-profile'),
    allowExploratoryWaveProfiles: args.includes('--allow-exploratory-wave-profiles'),
  };
};

const SUPPORTED_EVALUATION_GATE_STATUSES = new Set(['pass', 'fail']);

const toGate = (status: string | undefined, source: string, reasonMissing: string): GateRecord => {
  if (!status) {
    return { status: 'NOT_READY', source, reason: reasonMissing };
  }
  if (status === 'pass') return { status: 'PASS', source, reason: 'Constraint passed from evaluation artifact.' };
  if (status === 'fail') return { status: 'FAIL', source, reason: 'Constraint failed from evaluation artifact.' };
  return { status: 'FAIL', source, reason: `Unrecognized status: ${status}; fail-closed for hard-constraint semantics.` };
};

export const extractLatestAttempt = (result: GrAgentLoopResult): GrAgentLoopAttempt | null =>
  result.attempts.length ? result.attempts[result.attempts.length - 1] : null;

const extractLatestEvaluation = (result: GrAgentLoopResult) => extractLatestAttempt(result)?.evaluation;

const collectMissingSignals = (
  evaluation: ReturnType<typeof extractLatestEvaluation>,
  required: { gateStatus?: boolean; constraints?: boolean },
) => {
  const missing: string[] = [];
  if (!evaluation) {
    missing.push('missing_latest_evaluation');
    if (required.gateStatus) missing.push('missing_gate_status');
    if (required.constraints) missing.push('missing_constraints_payload');
    return missing;
  }
  if (required.gateStatus && !evaluation.gate?.status) {
    missing.push('missing_gate_status');
  }
  if (required.constraints && !Array.isArray(evaluation.constraints)) {
    missing.push('missing_constraints_payload');
  }
  return missing;
};

const hasPersistedRawOutputFiles = (runArtifacts: EvidencePack['runArtifacts']) =>
  runArtifacts.some((artifact) => fs.existsSync(artifact.outputPath));

const canonicalizeConstraintPayload = (constraints: unknown[]): string => {
  const canonicalEntries = constraints
    .map((entry) => {
      const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id : '';
      const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';
      const reasonCodes = new Set<string>();
      const addReasonCodes = (value: unknown) => {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === 'string' && item.trim().length > 0) reasonCodes.add(item.trim());
          }
          return;
        }
        if (typeof value === 'string' && value.trim().length > 0) {
          reasonCodes.add(value.trim());
        }
      };
      addReasonCodes(record.reasonCode);
      addReasonCodes(record.reasonCodes);
      return {
        id,
        status,
        reasonCode: Array.from(reasonCodes).sort(),
      };
    })
    .sort((lhs, rhs) => {
      if (lhs.id !== rhs.id) return lhs.id.localeCompare(rhs.id);
      if (lhs.status !== rhs.status) return lhs.status.localeCompare(rhs.status);
      return JSON.stringify(lhs.reasonCode).localeCompare(JSON.stringify(rhs.reasonCode));
    });
  return JSON.stringify(canonicalEntries);
};

export const buildGateMap = (
  wave: Wave,
  runResults: GrAgentLoopResult[],
  runArtifacts: EvidencePack['runArtifacts'] = [],
): Record<string, GateRecord> => {
  const latest = runResults.length ? runResults[runResults.length - 1] : null;
  const attempt = latest ? extractLatestAttempt(latest) : null;
  const constraints = attempt?.evaluation?.constraints ?? [];
  const constraintById = new Map(constraints.map((entry) => [entry.id, entry]));

  const gateMap: Record<string, GateRecord> = {
    G0: latest
      ? { status: 'PASS', source: 'gr-agent-loop.result', reason: 'GR loop run artifact captured.' }
      : { status: 'NOT_READY', source: 'gr-agent-loop.result', reason: 'No GR loop run artifacts found.' },
    G1: attempt?.initial?.status
      ? attempt.initial.status === 'CERTIFIED'
        ? { status: 'PASS', source: 'gr-agent-loop.attempt.initial.status', reason: 'Initial data solve is CERTIFIED.' }
        : { status: 'FAIL', source: 'gr-agent-loop.attempt.initial.status', reason: `Initial data solve status=${attempt.initial.status}.` }
      : { status: 'NOT_READY', source: 'gr-agent-loop.attempt.initial.status', reason: 'Initial solver status missing in artifact.' },
    G2: attempt?.evaluation?.gate?.status
      ? attempt.evaluation.gate.status === 'pass'
        ? { status: 'PASS', source: 'gr-agent-loop.attempt.evaluation.gate.status', reason: 'GR constraint gate pass from evaluator.' }
        : attempt.evaluation.gate.status === 'fail'
          ? { status: 'FAIL', source: 'gr-agent-loop.attempt.evaluation.gate.status', reason: 'GR constraint gate fail from evaluator.' }
          : { status: 'UNKNOWN', source: 'gr-agent-loop.attempt.evaluation.gate.status', reason: `Unsupported evaluator gate status=${attempt.evaluation.gate.status}` }
      : { status: 'NOT_READY', source: 'gr-agent-loop.attempt.evaluation.gate.status', reason: 'Evaluation gate status missing in artifact.' },
    G3: attempt?.evaluation?.certificate
      ? attempt.evaluation.certificate.hasCertificate && attempt.evaluation.certificate.integrityOk
        ? { status: 'PASS', source: 'gr-agent-loop.attempt.evaluation.certificate', reason: 'Certificate present with integrityOk=true.' }
        : { status: 'FAIL', source: 'gr-agent-loop.attempt.evaluation.certificate', reason: 'Certificate missing or integrity check failed.' }
      : { status: 'NOT_READY', source: 'gr-agent-loop.attempt.evaluation.certificate', reason: 'Certificate data missing from evaluator output.' },
    G4: (() => {
      const ford = toGate(constraintById.get('FordRomanQI')?.status, 'gr-agent-loop.attempt.evaluation.constraints[FordRomanQI]', 'FordRomanQI missing from constraints.');
      const theta = toGate(constraintById.get('ThetaAudit')?.status, 'gr-agent-loop.attempt.evaluation.constraints[ThetaAudit]', 'ThetaAudit missing from constraints.');
      if (ford.status === 'NOT_READY' || theta.status === 'NOT_READY') {
        return { status: 'NOT_READY', source: 'gr-agent-loop.attempt.evaluation.constraints', reason: `${ford.reason} ${theta.reason}`.trim() };
      }
      if (ford.status === 'FAIL' || theta.status === 'FAIL') {
        return { status: 'FAIL', source: 'gr-agent-loop.attempt.evaluation.constraints', reason: `Hard guardrails failed: FordRomanQI=${ford.status}, ThetaAudit=${theta.status}.` };
      }
      if (ford.status === 'PASS' && theta.status === 'PASS') {
        return { status: 'PASS', source: 'gr-agent-loop.attempt.evaluation.constraints', reason: 'Hard guardrails passed from evaluator constraints.' };
      }
      return { status: 'UNKNOWN', source: 'gr-agent-loop.attempt.evaluation.constraints', reason: `Unexpected hard-guardrail states: FordRomanQI=${ford.status}, ThetaAudit=${theta.status}.` };
    })(),
    G5: {
      status: 'NOT_APPLICABLE',
      source: 'campaign.policy.reduced-order',
      reason: 'Reduced-order campaign; no physical-feasibility promotion claim is evaluated here.',
    },
    G6: {
      status: hasPersistedRawOutputFiles(runArtifacts)
        ? attempt?.evaluation
          ? 'PASS'
          : 'FAIL'
        : 'NOT_READY',
      source: 'campaign.artifacts',
      reason: hasPersistedRawOutputFiles(runArtifacts)
        ? attempt?.evaluation
          ? 'Raw run outputs persisted and evaluator signals are present.'
          : 'Raw run outputs persisted but evaluator signals are missing; fail-closed until evaluator output is present.'
        : 'Run outputs are missing for this wave.',
    },
    G7:
      wave === 'C' || wave === 'D'
        ? runResults.length >= 2
          ? (() => {
              const lhs = extractLatestEvaluation(runResults[0]);
              const rhs = extractLatestEvaluation(runResults[1]);
              const missing = [...collectMissingSignals(lhs, { gateStatus: true }), ...collectMissingSignals(rhs, { gateStatus: true })];
              if (missing.length > 0) {
                return {
                  status: 'NOT_READY' as const,
                  source: 'campaign.stability.check',
                  reason: `Missing stability signals: ${Array.from(new Set(missing)).join(', ')}.`,
                };
              }
              const lhsStatus = lhs?.gate?.status;
              const rhsStatus = rhs?.gate?.status;
              if (!SUPPORTED_EVALUATION_GATE_STATUSES.has(lhsStatus ?? '') || !SUPPORTED_EVALUATION_GATE_STATUSES.has(rhsStatus ?? '')) {
                return {
                  status: 'NOT_READY' as const,
                  source: 'campaign.stability.check',
                  reason: `Unsupported gate status values for latest attempts: lhs=${lhsStatus ?? 'missing'}, rhs=${rhsStatus ?? 'missing'}.`,
                };
              }
              const sameStatus = lhsStatus === rhsStatus;
              return {
                status: sameStatus ? 'PASS' : 'FAIL',
                source: 'campaign.stability.check',
                reason: sameStatus
                  ? 'First-order gate status remained stable across repeated runs.'
                  : 'Repeated runs produced inconsistent gate outcomes.',
              };
            })()
          : { status: 'NOT_READY', source: 'campaign.stability.check', reason: 'Need at least 2 runs for stability check.' }
        : { status: 'NOT_APPLICABLE', source: 'campaign.stability.check', reason: 'Stability check enabled for waves C and D only.' },
    G8:
      wave === 'D'
        ? runResults.length >= 2
          ? (() => {
              const lhs = extractLatestEvaluation(runResults[0]);
              const rhs = extractLatestEvaluation(runResults[1]);
              const missing = [...collectMissingSignals(lhs, { constraints: true }), ...collectMissingSignals(rhs, { constraints: true })];
              if (missing.length > 0) {
                return {
                  status: 'NOT_READY' as const,
                  source: 'campaign.replication.parity',
                  reason: `Missing replication signals: ${Array.from(new Set(missing)).join(', ')}.`,
                };
              }
              const lhsConstraints = lhs?.constraints;
              const rhsConstraints = rhs?.constraints;
              if (!Array.isArray(lhsConstraints) || !Array.isArray(rhsConstraints) || lhsConstraints.length === 0 || rhsConstraints.length === 0) {
                return {
                  status: 'NOT_READY' as const,
                  source: 'campaign.replication.parity',
                  reason: 'Constraints payload missing or structurally incomplete for replication parity.',
                };
              }
              const stableConstraints =
                canonicalizeConstraintPayload(lhsConstraints) === canonicalizeConstraintPayload(rhsConstraints);
              return {
                status: stableConstraints ? 'PASS' : 'FAIL',
                source: 'campaign.replication.parity',
                reason: stableConstraints
                  ? 'Replication parity matched on evaluator constraint payload.'
                  : 'Replication parity drift detected in evaluator constraints.',
              };
            })()
          : { status: 'NOT_READY', source: 'campaign.replication.parity', reason: 'Need replicated runs for wave D parity check.' }
        : { status: 'NOT_APPLICABLE', source: 'campaign.replication.parity', reason: 'Replication parity applies to wave D only.' },
  };

  return gateMap;
};

export const deriveFirstFail = (gateMap: Record<string, GateRecord>): { firstFail: string; reason: string } => {
  for (const gateId of FIRST_FAIL_ORDER) {
    const entry = gateMap[gateId];
    if (!entry) continue;
    if (entry.status === 'FAIL') return { firstFail: gateId, reason: entry.reason };
  }
  for (const gateId of FIRST_FAIL_ORDER) {
    const entry = gateMap[gateId];
    if (!entry) continue;
    if (entry.status === 'NOT_READY' || entry.status === 'UNKNOWN') {
      return { firstFail: gateId, reason: entry.reason };
    }
  }
  return { firstFail: 'none', reason: 'No FAIL/NOT_READY/UNKNOWN gate found.' };
};

export const summarizeScoreboard = (gateStatus: Record<string, GateStatus>) => {
  const statuses = Object.values(gateStatus);
  const counts = {
    PASS: statuses.filter((s) => s === 'PASS').length,
    FAIL: statuses.filter((s) => s === 'FAIL').length,
    UNKNOWN: statuses.filter((s) => s === 'UNKNOWN').length,
    NOT_READY: statuses.filter((s) => s === 'NOT_READY').length,
    NOT_APPLICABLE: statuses.filter((s) => s === 'NOT_APPLICABLE').length,
  };
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const gateCount = statuses.length;
  return { counts, total, gateCount, reconciled: total === gateCount };
};


export const aggregateGateStatusAcrossWaves = (waveStatuses: Array<Record<string, GateStatus>>) => {
  const gateIds = Array.from(new Set(waveStatuses.flatMap((statusMap) => Object.keys(statusMap)))).sort();
  return Object.fromEntries(
    gateIds.map((gateId) => {
      const gateStates = waveStatuses.map((map) => map[gateId] ?? 'UNKNOWN');
      const resolved = gateStates.reduce<GateStatus>((current, next) => (GATE_PRECEDENCE[next] > GATE_PRECEDENCE[current] ? next : current), 'NOT_APPLICABLE');
      return [gateId, resolved];
    }),
  ) as Record<string, GateStatus>;
};

export const deriveCampaignDecision = (counts: ReturnType<typeof summarizeScoreboard>['counts']) => {
  if (counts.FAIL > 0) return 'INADMISSIBLE';
  if (counts.NOT_READY > 0 || counts.UNKNOWN > 0) return 'NOT_READY';
  return 'REDUCED_ORDER_ADMISSIBLE';
};

const isMeaningfulValue = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value !== 'unknown' && value !== 'unspecified';

export const collectRequiredSignals = (attempt: GrAgentLoopAttempt | null, latestResult: GrAgentLoopResult | null) => {
  const finalState = latestResult?.finalState as Record<string, unknown> | undefined;
  const snapshot =
    (attempt?.evaluation as any)?.certificate?.payload?.snapshot &&
    typeof (attempt?.evaluation as any)?.certificate?.payload?.snapshot === 'object'
      ? ((attempt?.evaluation as any)?.certificate?.payload?.snapshot as Record<string, unknown>)
      : undefined;
  const finalWarp = (finalState?.warp as Record<string, unknown> | undefined) ?? {};
  const attemptWarp = (attempt?.grRequest?.warp as Record<string, unknown> | undefined) ?? {};

  const finalMetricAdapter = (finalWarp.metricAdapter as Record<string, unknown> | undefined) ?? {};
  const attemptMetricAdapter = (attemptWarp.metricAdapter as Record<string, unknown> | undefined) ?? {};
  const chartLabel =
    (finalMetricAdapter.chart as Record<string, unknown> | undefined)?.label ??
    (attemptMetricAdapter.chart as Record<string, unknown> | undefined)?.label;

  const finalMetricContract = (finalWarp.metricT00Contract as Record<string, unknown> | undefined) ?? {};
  const attemptMetricContract = (attemptWarp.metricT00Contract as Record<string, unknown> | undefined) ?? {};
  const observer =
    finalMetricContract.observer ??
    attemptMetricContract.observer ??
    finalWarp.metricT00Observer ??
    attemptWarp.metricT00Observer;
  const normalization =
    finalMetricContract.normalization ??
    attemptMetricContract.normalization ??
    finalWarp.metricT00Normalization ??
    attemptWarp.metricT00Normalization;
  const unitSystem =
    finalMetricContract.unitSystem ??
    attemptMetricContract.unitSystem ??
    finalWarp.metricT00UnitSystem ??
    attemptWarp.metricT00UnitSystem;
  const fordConstraintNote =
    (attempt?.evaluation?.constraints ?? []).find((entry) => entry.id === 'FordRomanQI')?.note ?? null;
  const constraintNotes = (attempt?.evaluation?.constraints ?? [])
    .map((entry) => (typeof entry?.note === 'string' ? entry.note.trim() : ''))
    .filter((note) => note.length > 0);
  const evaluationNotes = Array.isArray((attempt?.evaluation as any)?.notes)
    ? ((attempt?.evaluation as any).notes as unknown[])
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).note === 'string') {
            return (entry as Record<string, string>).note;
          }
          return '';
        })
        .map((note) => note.trim())
        .filter((note) => note.length > 0)
    : [];
  const signalNotes = Array.from(
    new Set(
      [fordConstraintNote, ...constraintNotes, ...evaluationNotes].filter(
        (note): note is string => typeof note === 'string' && note.trim().length > 0,
      ),
    ),
  );
  const parseSignalField = (key: string): string | null => {
    if (signalNotes.length === 0) return null;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matcher = new RegExp(`${escaped}=([^;|\\r\\n]+)`);
    for (const note of signalNotes) {
      const m = note.match(matcher);
      if (m?.[1]) return m[1].trim();
    }
    return null;
  };
  const parseSignalBoolean = (key: string): boolean | null => {
    const value = parseSignalField(key);
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
  };
  const parseSignalFinite = (key: string): number | null => {
    const value = parseSignalField(key);
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  const applicabilityStatus =
    finalState?.qi_applicability_status ?? snapshot?.qi_applicability_status ?? parseSignalField('applicabilityStatus');
  const applicabilityCurvatureOk =
    finalState?.qi_curvature_ok ?? snapshot?.qi_curvature_ok ?? parseSignalBoolean('curvatureOk');
  const applicabilityCurvatureRatio =
    finalState?.qi_curvature_ratio ?? snapshot?.qi_curvature_ratio ?? parseSignalFinite('curvatureRatio');
  const operatorQuantitySemanticBaseType =
    finalState?.qi_quantity_semantic_base_type ??
    snapshot?.qi_quantity_semantic_base_type ??
    parseSignalField('quantitySemanticBaseType');
  const operatorQuantitySemanticType =
    finalState?.qi_quantity_semantic_type ??
    snapshot?.qi_quantity_semantic_type ??
    parseSignalField('quantitySemanticType');
  const operatorQuantitySemanticTargetType =
    finalState?.qi_quantity_semantic_target_type ??
    snapshot?.qi_quantity_semantic_target_type ??
    parseSignalField('quantitySemanticTargetType');
  const operatorWorldlineClass =
    finalState?.qi_quantity_worldline_class ??
    snapshot?.qi_quantity_worldline_class ??
    parseSignalField('quantityWorldlineClass');
  const operatorQeiStateClass =
    finalState?.qi_qei_state_class ?? snapshot?.qi_qei_state_class ?? parseSignalField('qeiStateClass');
  const operatorQeiRenormalization =
    finalState?.qi_qei_renormalization_scheme ??
    snapshot?.qi_qei_renormalization_scheme ??
    parseSignalField('qeiRenormalizationScheme');
  const operatorQeiSampling =
    finalState?.qi_qei_sampling_normalization ??
    snapshot?.qi_qei_sampling_normalization ??
    parseSignalField('qeiSamplingNormalization');
  const operatorQeiMapping =
    finalState?.qi_qei_operator_mapping ?? snapshot?.qi_qei_operator_mapping ?? parseSignalField('qeiOperatorMapping');
  const operatorSemanticComparable =
    finalState?.qi_quantity_semantic_comparable ??
    snapshot?.qi_quantity_semantic_comparable ??
    parseSignalBoolean('quantitySemanticComparable');
  const operatorBridgeReady =
    finalState?.qi_quantity_semantic_bridge_ready ??
    snapshot?.qi_quantity_semantic_bridge_ready ??
    parseSignalBoolean('quantitySemanticBridgeReady');
  const operatorMappingDerivationRef =
    finalState?.qi_coupling_equation_ref ?? snapshot?.qi_coupling_equation_ref ?? parseSignalField('couplingEquationRef');
  const uncertaintyModelSigmaSource =
    finalState?.qi_uncertainty_model_sigma_source ??
    snapshot?.qi_uncertainty_model_sigma_source ??
    parseSignalField('uncertaintyModelSigmaSource');
  const uncertaintyModelSigmaRationale =
    finalState?.qi_uncertainty_model_sigma_rationale ??
    snapshot?.qi_uncertainty_model_sigma_rationale ??
    parseSignalField('uncertaintyModelSigmaRationale');
  const uncertaintyModelSigmaRequired =
    finalState?.qi_uncertainty_model_sigma_required ??
    snapshot?.qi_uncertainty_model_sigma_required ??
    parseSignalBoolean('uncertaintyModelSigmaRequired');
  const uncertaintyModelSigmaProvenanceReady =
    finalState?.qi_uncertainty_model_sigma_provenance_ready ??
    snapshot?.qi_uncertainty_model_sigma_provenance_ready ??
    parseSignalBoolean('uncertaintyModelSigmaProvenanceReady');

  // Producer/consumer contract: these keys are authoritative and deterministic for gate fail-closed wiring.
  const requiredSignals: EvidencePack['requiredSignals'] = {
    initial_solver_status: { required: true, present: Boolean(attempt?.initial?.status) },
    evaluation_gate_status: { required: true, present: Boolean(attempt?.evaluation?.gate?.status) },
    hard_constraint_ford_roman_qi: {
      required: true,
      present: (attempt?.evaluation?.constraints ?? []).some((entry) => entry.id === 'FordRomanQI' && Boolean(entry.status)),
    },
    hard_constraint_theta_audit: {
      required: true,
      present: (attempt?.evaluation?.constraints ?? []).some((entry) => entry.id === 'ThetaAudit' && Boolean(entry.status)),
    },
    certificate_hash: { required: true, present: Boolean(attempt?.evaluation?.certificate?.certificateHash) },
    certificate_integrity: { required: true, present: typeof attempt?.evaluation?.certificate?.integrityOk === 'boolean' },
    provenance_chart: { required: true, present: isMeaningfulValue(chartLabel) },
    provenance_observer: { required: true, present: isMeaningfulValue(observer) },
    provenance_normalization: { required: true, present: isMeaningfulValue(normalization) },
    provenance_unit_system: { required: true, present: isMeaningfulValue(unitSystem) },
    applicability_status: {
      required: true,
      present: isMeaningfulValue(applicabilityStatus),
    },
    applicability_curvature_ok: {
      required: true,
      present: typeof applicabilityCurvatureOk === 'boolean',
    },
    applicability_curvature_ratio: {
      required: true,
      present: Number.isFinite(applicabilityCurvatureRatio),
    },
    operator_quantity_semantic_base_type: {
      required: true,
      present: isMeaningfulValue(operatorQuantitySemanticBaseType),
    },
    operator_quantity_semantic_type: {
      required: true,
      present: isMeaningfulValue(operatorQuantitySemanticType),
    },
    operator_quantity_semantic_target_type: {
      required: true,
      present: isMeaningfulValue(operatorQuantitySemanticTargetType),
    },
    operator_worldline_timelike: {
      required: true,
      present: typeof operatorWorldlineClass === 'string' && operatorWorldlineClass.trim() === 'timelike',
    },
    operator_qei_state_hadamard: {
      required: true,
      present: typeof operatorQeiStateClass === 'string' && operatorQeiStateClass.trim() === 'hadamard',
    },
    operator_qei_renormalization_point_splitting: {
      required: true,
      present:
        typeof operatorQeiRenormalization === 'string' && operatorQeiRenormalization.trim() === 'point_splitting',
    },
    operator_qei_sampling_unit_integral: {
      required: true,
      present: typeof operatorQeiSampling === 'string' && operatorQeiSampling.trim() === 'unit_integral',
    },
    operator_qei_mapping_t_munu_uu_ren: {
      required: true,
      present: typeof operatorQeiMapping === 'string' && operatorQeiMapping.trim() === 't_munu_uu_ren',
    },
    operator_semantic_comparable: {
      required: true,
      present: operatorSemanticComparable === true,
    },
    operator_bridge_ready: {
      required: true,
      present: operatorBridgeReady === true,
    },
    operator_mapping_derivation_ref: {
      required: true,
      present: isMeaningfulValue(operatorMappingDerivationRef),
    },
    uncertainty_model_sigma_source: {
      required: true,
      present: isMeaningfulValue(uncertaintyModelSigmaSource),
    },
    uncertainty_model_sigma_rationale: {
      required: true,
      present: isMeaningfulValue(uncertaintyModelSigmaRationale),
    },
    uncertainty_model_sigma_required: {
      required: true,
      present: typeof uncertaintyModelSigmaRequired === 'boolean',
    },
    uncertainty_model_sigma_provenance_ready: {
      required: true,
      present: typeof uncertaintyModelSigmaProvenanceReady === 'boolean',
    },
  };
  const missingSignals = REQUIRED_SIGNAL_KEYS
    .filter((signal) => requiredSignals[signal]?.required && !requiredSignals[signal]?.present)
    .slice()
    .sort();
  return { requiredSignals, missingSignals };
};

export const buildGateMissingSignalMap = (missingSignals: string[], wave?: Wave) => {
  const appliesG7 = wave === 'C' || wave === 'D';
  const appliesG8 = wave === 'D';
  const mapping: EvidencePack['gateMissingSignalMap'] = {
    G1: missingSignals.filter((signal) => signal === 'initial_solver_status'),
    G2: missingSignals.filter((signal) => signal === 'evaluation_gate_status'),
    G3: missingSignals.filter((signal) => signal === 'certificate_hash' || signal === 'certificate_integrity'),
    G4: missingSignals.filter((signal) => signal === 'hard_constraint_ford_roman_qi' || signal === 'hard_constraint_theta_audit'),
    G6: missingSignals,
    G7: appliesG7 ? missingSignals.filter((signal) => signal === 'evaluation_gate_status') : [],
    G8: appliesG8 ? missingSignals.filter((signal) => signal.startsWith('hard_constraint_')) : [],
  };
  return Object.fromEntries(Object.entries(mapping).filter(([, signals]) => signals.length > 0));
};

const applyMissingSignalFailClosed = (gateMap: Record<string, GateRecord>, gateMissingSignalMap: Record<string, string[]>) => {
  for (const [gateId, signals] of Object.entries(gateMissingSignalMap)) {
    const gate = gateMap[gateId];
    if (!gate) continue;
    if (gate.status === 'NOT_APPLICABLE') continue;
    gateMap[gateId] = {
      status: 'NOT_READY',
      source: gate.source,
      reason: `${gate.reason} Missing required signals: ${signals.join(', ')}.`,
    };
  }
  return gateMap;
};

const classifyGateCause = (
  gateId: string,
  gate: GateRecord,
  gateMissingSignalMap: Record<string, string[]>,
  timeout?: EvidencePack['timeout'],
): EvidencePack['gateCauseClass'][string] => {
  if (gate.status !== 'NOT_READY') return 'none';
  if (gate.status === 'NOT_READY' && gate.source === 'campaign.policy.reduced-order') {
    return 'policy_not_applicable_misuse';
  }
  if (timeout && (timeout.kind === 'wave_timeout' || timeout.kind === 'campaign_timeout')) {
    return 'timeout_budget';
  }
  if ((gateMissingSignalMap[gateId] ?? []).length > 0) {
    return 'missing_required_signals';
  }
  return 'other';
};

export const buildNotReadyClassification = (
  gateMap: Record<string, GateRecord>,
  gateMissingSignalMap: Record<string, string[]>,
  timeout?: EvidencePack['timeout'],
) => {
  const gateCauseClass: EvidencePack['gateCauseClass'] = {};
  const notReadyClassCounts: EvidencePack['notReadyClassCounts'] = {
    timeout_budget: 0,
    missing_required_signals: 0,
    policy_not_applicable_misuse: 0,
    other: 0,
  };
  for (const [gateId, gate] of Object.entries(gateMap)) {
    const gateClass = classifyGateCause(gateId, gate, gateMissingSignalMap, timeout);
    gateCauseClass[gateId] = gateClass;
    if (gate.status === 'NOT_READY' && gateClass !== 'none') {
      notReadyClassCounts[gateClass] += 1;
    }
  }
  return { gateCauseClass, notReadyClassCounts };
};

export const deriveG4Diagnostics = (attempt: GrAgentLoopAttempt | null): EvidencePack['g4Diagnostics'] => {
  const constraints = attempt?.evaluation?.constraints ?? [];
  const snapshot = (attempt as any)?.certificate?.payload?.snapshot ?? {};
  const ford = constraints.find((entry) => entry.id === 'FordRomanQI');
  const theta = constraints.find((entry) => entry.id === 'ThetaAudit');
  const toStatus = (entry: { status?: string } | undefined): EvidencePack['g4Diagnostics']['fordRomanStatus'] => {
    if (!entry) return 'missing';
    if (entry.status === 'pass' || entry.status === 'fail' || entry.status === 'unknown') return entry.status;
    return 'unknown';
  };
  const readReason = (entry: { note?: string } | undefined): string | null => {
    if (typeof entry?.note !== 'string') return null;
    const text = entry.note.trim();
    return text.length > 0 ? text : null;
  };
  const readReasonCodes = (entry: { note?: string } | undefined): string[] => {
    if (typeof entry?.note !== 'string') return [];
    return Array.from(entry.note.matchAll(/reasonCode=([A-Z0-9_]+)/g)).map((m) => m[1]);
  };
  const parseFordField = (key: string): string | null => {
    if (typeof ford?.note !== 'string') return null;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = ford.note.match(new RegExp(`${escaped}=([^;|]+)`));
    return m?.[1]?.trim() ?? null;
  };
  const parseStrictNumber = (value: unknown): number | undefined => {
    if (value == null) return undefined;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (text.length === 0) return undefined;
    const lowered = text.toLowerCase();
    if (lowered === 'n/a' || lowered === 'unknown' || lowered === 'undefined' || lowered === 'null' || lowered === 'nan' || lowered === 'infinity' || lowered === '+infinity' || lowered === '-infinity') {
      return undefined;
    }
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
  };
  const parseNumberField = (key: string): number | undefined => parseStrictNumber(parseFordField(key));
  const parseSnapshotNumber = (value: unknown): number | undefined => parseStrictNumber(value);
  const readCanonicalNumber = (snapshotValue: unknown, fordKey: string): number | undefined =>
    parseSnapshotNumber(snapshotValue) ?? parseNumberField(fordKey);
  const readSnapshotString = (snapshotValue: unknown): string | undefined =>
    typeof snapshotValue === 'string' ? snapshotValue : undefined;
  const parseBooleanText = (value: string | null | undefined): boolean | undefined =>
    value === 'true' ? true : value === 'false' ? false : undefined;
  const readCanonicalBoolean = (snapshotValue: unknown, fordKey: string): boolean | undefined =>
    typeof snapshotValue === 'boolean' ? snapshotValue : parseBooleanText(parseFordField(fordKey));
  const readDelimitedStringList = (snapshotValue: unknown, fordKey: string): string[] | undefined => {
    const raw = readSnapshotString(snapshotValue) ?? parseFordField(fordKey);
    if (raw == null) return undefined;
    const items = raw
      .split('|')
      .map((item) => item.trim())
      .filter((item) => item.length > 0 && item.toLowerCase() !== 'n/a');
    return items.length > 0 ? items : [];
  };
  const readUncertaintyDecisionClass = (): EvidencePack['g4Diagnostics']['uncertaintyDecisionClass'] => {
    const raw = readSnapshotString(snapshot?.qi_uncertainty_decision_class) ?? parseFordField('uncertaintyDecisionClass');
    return raw === 'robust_pass' || raw === 'indeterminate' || raw === 'robust_fail' ? raw : undefined;
  };
  const hasSynthesizedTag = [ford, theta].some((entry) => typeof entry?.note === 'string' && entry.note.includes('source=synthesized_unknown'));
  const missingAnyHardSource = !ford || !theta;
  const source: EvidencePack['g4Diagnostics']['source'] = hasSynthesizedTag || missingAnyHardSource ? 'synthesized_unknown' : 'evaluator_constraints';
  const reason = [readReason(ford), readReason(theta)].filter((msg): msg is string => typeof msg === 'string');
  const reasonCode = [...readReasonCodes(ford), ...readReasonCodes(theta)];
  if ((!ford || !theta) && !reasonCode.includes(G4_REASON_CODES.signalMissing)) {
    reasonCode.push(G4_REASON_CODES.signalMissing);
    reason.push('source=synthesized_unknown;reasonCode=G4_QI_SIGNAL_MISSING;G4 hard-source payload incomplete in evaluation constraints.');
  }
  return {
    fordRomanStatus: toStatus(ford),
    thetaAuditStatus: toStatus(theta),
    source,
    reason,
    reasonCode: orderReasonCodes(reasonCode),
    lhs_Jm3: readCanonicalNumber(snapshot?.qi_lhs_Jm3, 'lhs_Jm3'),
    bound_Jm3: readCanonicalNumber(snapshot?.qi_bound_Jm3, 'bound_Jm3'),
    boundComputed_Jm3: readCanonicalNumber(snapshot?.qi_bound_computed_Jm3, 'boundComputed_Jm3'),
    boundFloor_Jm3: readCanonicalNumber(snapshot?.qi_bound_floor_Jm3, 'boundFloor_Jm3') ?? parseNumberField('boundFloor_Jm3'),
    boundPolicyFloor_Jm3:
      readCanonicalNumber(snapshot?.qi_bound_policy_floor_Jm3, 'boundPolicyFloor_Jm3') ?? parseNumberField('boundPolicyFloor_Jm3'),
    boundEnvFloor_Jm3:
      readCanonicalNumber(snapshot?.qi_bound_env_floor_Jm3, 'boundEnvFloor_Jm3') ?? parseNumberField('boundEnvFloor_Jm3'),
    boundDefaultFloor_Jm3:
      readCanonicalNumber(snapshot?.qi_bound_default_floor_Jm3, 'boundDefaultFloor_Jm3') ?? parseNumberField('boundDefaultFloor_Jm3'),
    boundFallbackAbs_Jm3:
      readCanonicalNumber(snapshot?.qi_bound_fallback_abs_Jm3, 'boundFallbackAbs_Jm3') ?? parseNumberField('boundFallbackAbs_Jm3'),
    boundUsed_Jm3: readCanonicalNumber(snapshot?.qi_bound_used_Jm3, 'boundUsed_Jm3') ?? parseNumberField('boundUsed_Jm3'),
    marginRatio: readCanonicalNumber(snapshot?.qi_margin_ratio, 'marginRatio'),
    marginRatioRaw: readCanonicalNumber(snapshot?.qi_margin_ratio_raw, 'marginRatioRaw'),
    marginRatioRawComputed:
      readCanonicalNumber(snapshot?.qi_margin_ratio_raw_computed, 'marginRatioRawComputed') ??
      parseNumberField('marginRatioRawComputed'),
    uncertaintySigma_Jm3:
      readCanonicalNumber(snapshot?.qi_uncertainty_sigma_Jm3, 'uncertaintySigma_Jm3') ??
      parseNumberField('uncertaintySigma_Jm3'),
    uncertaintySigmaMeasurement_Jm3:
      readCanonicalNumber(snapshot?.qi_uncertainty_sigma_measurement_Jm3, 'uncertaintySigmaMeasurement_Jm3') ??
      parseNumberField('uncertaintySigmaMeasurement_Jm3'),
    uncertaintySigmaModel_Jm3:
      readCanonicalNumber(snapshot?.qi_uncertainty_sigma_model_Jm3, 'uncertaintySigmaModel_Jm3') ??
      parseNumberField('uncertaintySigmaModel_Jm3'),
    uncertaintySigmaBridge_Jm3:
      readCanonicalNumber(snapshot?.qi_uncertainty_sigma_bridge_Jm3, 'uncertaintySigmaBridge_Jm3') ??
      parseNumberField('uncertaintySigmaBridge_Jm3'),
    uncertaintySigmaTau_Jm3:
      readCanonicalNumber(snapshot?.qi_uncertainty_sigma_tau_Jm3, 'uncertaintySigmaTau_Jm3') ??
      parseNumberField('uncertaintySigmaTau_Jm3'),
    uncertaintyModelSigmaConfigured_Jm3:
      readCanonicalNumber(
        snapshot?.qi_uncertainty_model_sigma_configured_Jm3,
        'uncertaintyModelSigmaConfigured_Jm3',
      ) ?? parseNumberField('uncertaintyModelSigmaConfigured_Jm3'),
    uncertaintyModelSigmaSource:
      readSnapshotString(snapshot?.qi_uncertainty_model_sigma_source) ??
      (parseFordField('uncertaintyModelSigmaSource') ?? undefined),
    uncertaintyModelSigmaRationale:
      readSnapshotString(snapshot?.qi_uncertainty_model_sigma_rationale) ??
      (parseFordField('uncertaintyModelSigmaRationale') ?? undefined),
    uncertaintyModelSigmaRequired:
      readCanonicalBoolean(snapshot?.qi_uncertainty_model_sigma_required, 'uncertaintyModelSigmaRequired'),
    uncertaintyModelSigmaProvenanceReady:
      readCanonicalBoolean(
        snapshot?.qi_uncertainty_model_sigma_provenance_ready,
        'uncertaintyModelSigmaProvenanceReady',
      ),
    uncertaintyModelSigmaProvenanceMissing:
      readSnapshotString(snapshot?.qi_uncertainty_model_sigma_provenance_missing) ??
      (parseFordField('uncertaintyModelSigmaProvenanceMissing') ?? undefined),
    uncertaintyDominantComponent:
      ((readSnapshotString(snapshot?.qi_uncertainty_dominant_component) ??
        parseFordField('uncertaintyDominantComponent') ??
        undefined) as 'measurement' | 'model' | 'bridge' | 'tau' | 'none' | undefined),
    uncertaintyBandKSigma:
      readCanonicalNumber(snapshot?.qi_uncertainty_k_sigma, 'uncertaintyBandKSigma') ??
      parseNumberField('uncertaintyBandKSigma'),
    uncertaintySlackPolicy_Jm3:
      readCanonicalNumber(snapshot?.qi_uncertainty_slack_policy_Jm3, 'uncertaintySlackPolicy_Jm3') ??
      parseNumberField('uncertaintySlackPolicy_Jm3'),
    uncertaintySlackComputed_Jm3:
      readCanonicalNumber(snapshot?.qi_uncertainty_slack_computed_Jm3, 'uncertaintySlackComputed_Jm3') ??
      parseNumberField('uncertaintySlackComputed_Jm3'),
    uncertaintyBandLowerPolicy_Jm3:
      readCanonicalNumber(snapshot?.qi_uncertainty_band_lower_policy_Jm3, 'uncertaintyBandLowerPolicy_Jm3') ??
      parseNumberField('uncertaintyBandLowerPolicy_Jm3'),
    uncertaintyBandUpperPolicy_Jm3:
      readCanonicalNumber(snapshot?.qi_uncertainty_band_upper_policy_Jm3, 'uncertaintyBandUpperPolicy_Jm3') ??
      parseNumberField('uncertaintyBandUpperPolicy_Jm3'),
    uncertaintyBandLowerComputed_Jm3:
      readCanonicalNumber(snapshot?.qi_uncertainty_band_lower_computed_Jm3, 'uncertaintyBandLowerComputed_Jm3') ??
      parseNumberField('uncertaintyBandLowerComputed_Jm3'),
    uncertaintyBandUpperComputed_Jm3:
      readCanonicalNumber(snapshot?.qi_uncertainty_band_upper_computed_Jm3, 'uncertaintyBandUpperComputed_Jm3') ??
      parseNumberField('uncertaintyBandUpperComputed_Jm3'),
    uncertaintyDecisionClass: readUncertaintyDecisionClass(),
    uncertaintyCouldFlip:
      typeof snapshot?.qi_uncertainty_could_flip === 'boolean'
        ? snapshot.qi_uncertainty_could_flip
        : parseFordField('uncertaintyCouldFlip') === 'true'
          ? true
          : parseFordField('uncertaintyCouldFlip') === 'false'
            ? false
            : undefined,
    uncertaintyInputsMissing:
      readSnapshotString(snapshot?.qi_uncertainty_inputs_missing) ??
      (parseFordField('uncertaintyInputsMissing') ?? undefined),
    g4FloorDominated:
      typeof snapshot?.qi_g4_floor_dominated === 'boolean'
        ? snapshot.qi_g4_floor_dominated
        : parseFordField('g4FloorDominated') === 'true'
          ? true
          : parseFordField('g4FloorDominated') === 'false'
            ? false
            : undefined,
    g4PolicyExceeded:
      typeof snapshot?.qi_g4_policy_exceeded === 'boolean'
        ? snapshot.qi_g4_policy_exceeded
        : parseFordField('g4PolicyExceeded') === 'true'
          ? true
          : parseFordField('g4PolicyExceeded') === 'false'
            ? false
            : undefined,
    g4ComputedExceeded:
      typeof snapshot?.qi_g4_computed_exceeded === 'boolean'
        ? snapshot.qi_g4_computed_exceeded
        : parseFordField('g4ComputedExceeded') === 'true'
          ? true
          : parseFordField('g4ComputedExceeded') === 'false'
            ? false
            : undefined,
    g4DualFailMode:
      ((readSnapshotString(snapshot?.qi_g4_dual_fail_mode) ?? parseFordField('g4DualFailMode') ?? undefined) as
        | 'policy_only'
        | 'computed_only'
        | 'both'
        | 'neither'
        | undefined),
    couplingMode:
      readSnapshotString(snapshot?.qi_coupling_mode) ?? (parseFordField('couplingMode') ?? undefined),
    couplingAlpha:
      readCanonicalNumber(snapshot?.qi_coupling_alpha, 'couplingAlpha') ?? parseNumberField('couplingAlpha'),
    rhoMetric_Jm3:
      readCanonicalNumber(snapshot?.qi_rho_metric_Jm3, 'rhoMetric_Jm3') ?? parseNumberField('rhoMetric_Jm3'),
    rhoMetricSource:
      readSnapshotString(snapshot?.qi_rho_metric_source) ?? (parseFordField('rhoMetricSource') ?? undefined),
    rhoProxy_Jm3:
      readCanonicalNumber(snapshot?.qi_rho_proxy_Jm3, 'rhoProxy_Jm3') ?? parseNumberField('rhoProxy_Jm3'),
    rhoProxySource:
      readSnapshotString(snapshot?.qi_rho_proxy_source) ?? (parseFordField('rhoProxySource') ?? undefined),
    rhoCoupledShadow_Jm3:
      readCanonicalNumber(snapshot?.qi_rho_coupled_shadow_Jm3, 'rhoCoupledShadow_Jm3') ??
      parseNumberField('rhoCoupledShadow_Jm3'),
    couplingResidualRel:
      readCanonicalNumber(snapshot?.qi_coupling_residual_rel, 'couplingResidualRel') ??
      parseNumberField('couplingResidualRel'),
    couplingComparable:
      typeof snapshot?.qi_coupling_comparable === 'boolean'
        ? snapshot.qi_coupling_comparable
        : parseFordField('couplingComparable') === 'true'
          ? true
          : parseFordField('couplingComparable') === 'false'
            ? false
            : undefined,
    couplingEquationRef:
      readSnapshotString(snapshot?.qi_coupling_equation_ref) ?? (parseFordField('couplingEquationRef') ?? undefined),
    couplingSemantics:
      readSnapshotString(snapshot?.qi_coupling_semantics) ?? (parseFordField('couplingSemantics') ?? undefined),
    quantitySemanticBaseType:
      readSnapshotString(snapshot?.qi_quantity_semantic_base_type) ?? (parseFordField('quantitySemanticBaseType') ?? undefined),
    quantitySemanticType:
      readSnapshotString(snapshot?.qi_quantity_semantic_type) ?? (parseFordField('quantitySemanticType') ?? undefined),
    quantitySemanticTargetType:
      readSnapshotString(snapshot?.qi_quantity_semantic_target_type) ?? (parseFordField('quantitySemanticTargetType') ?? undefined),
    quantityWorldlineClass:
      readSnapshotString(snapshot?.qi_quantity_worldline_class) ?? (parseFordField('quantityWorldlineClass') ?? undefined),
    quantitySemanticComparable:
      typeof snapshot?.qi_quantity_semantic_comparable === 'boolean'
        ? snapshot.qi_quantity_semantic_comparable
        : parseFordField('quantitySemanticComparable') === 'true'
          ? true
          : parseFordField('quantitySemanticComparable') === 'false'
            ? false
            : undefined,
    quantitySemanticReason:
      readSnapshotString(snapshot?.qi_quantity_semantic_reason) ?? (parseFordField('quantitySemanticReason') ?? undefined),
    quantitySemanticBridgeMode:
      readSnapshotString(snapshot?.qi_quantity_semantic_bridge_mode) ?? (parseFordField('quantitySemanticBridgeMode') ?? undefined),
    quantitySemanticBridgeReady:
      typeof snapshot?.qi_quantity_semantic_bridge_ready === 'boolean'
        ? snapshot.qi_quantity_semantic_bridge_ready
        : parseFordField('quantitySemanticBridgeReady') === 'true'
          ? true
          : parseFordField('quantitySemanticBridgeReady') === 'false'
            ? false
            : undefined,
    quantitySemanticBridgeMissing:
      readSnapshotString(snapshot?.qi_quantity_semantic_bridge_missing) ??
      (parseFordField('quantitySemanticBridgeMissing') ?? undefined),
    qeiStateClass:
      readSnapshotString(snapshot?.qi_qei_state_class) ?? (parseFordField('qeiStateClass') ?? undefined),
    qeiRenormalizationScheme:
      readSnapshotString(snapshot?.qi_qei_renormalization_scheme) ??
      (parseFordField('qeiRenormalizationScheme') ?? undefined),
    qeiSamplingNormalization:
      readSnapshotString(snapshot?.qi_qei_sampling_normalization) ??
      (parseFordField('qeiSamplingNormalization') ?? undefined),
    qeiOperatorMapping:
      readSnapshotString(snapshot?.qi_qei_operator_mapping) ?? (parseFordField('qeiOperatorMapping') ?? undefined),
    congruentSolvePolicyMarginPass:
      readCanonicalBoolean(snapshot?.qi_congruent_solve_policy_margin_pass, 'congruentSolvePolicyMarginPass'),
    congruentSolveComputedMarginPass:
      readCanonicalBoolean(snapshot?.qi_congruent_solve_computed_margin_pass, 'congruentSolveComputedMarginPass'),
    congruentSolveApplicabilityPass:
      readCanonicalBoolean(snapshot?.qi_congruent_solve_applicability_pass, 'congruentSolveApplicabilityPass'),
    congruentSolveMetricPass:
      readCanonicalBoolean(snapshot?.qi_congruent_solve_metric_pass, 'congruentSolveMetricPass'),
    congruentSolveSemanticPass:
      readCanonicalBoolean(snapshot?.qi_congruent_solve_semantic_pass, 'congruentSolveSemanticPass'),
    congruentSolvePass:
      readCanonicalBoolean(snapshot?.qi_congruent_solve_pass, 'congruentSolvePass'),
    congruentSolveFailReasons:
      readDelimitedStringList(snapshot?.qi_congruent_solve_fail_reasons, 'congruentSolveFailReasons'),
    rhoSource: readSnapshotString(snapshot?.qi_rho_source) ?? (parseFordField('rhoSource') ?? undefined),
    metricT00Ref:
      readSnapshotString(snapshot?.qi_metric_t00_ref) ?? (parseFordField('metricT00Ref') ?? undefined),
    metricT00Geom: readCanonicalNumber(snapshot?.qi_metric_t00_geom, 'metricT00Geom'),
    metricT00GeomSource:
      readSnapshotString(snapshot?.qi_metric_t00_geom_source) ?? (parseFordField('metricT00GeomSource') ?? undefined),
    metricT00Si: readCanonicalNumber(snapshot?.qi_metric_t00_si, 'metricT00Si'),
    metricT00SiFromGeom: readCanonicalNumber(snapshot?.qi_metric_t00_si_from_geom, 'metricT00SiFromGeom'),
    metricT00SiRelError: readCanonicalNumber(snapshot?.qi_metric_t00_si_rel_error, 'metricT00SiRelError'),
    metricContractStatus:
      readSnapshotString(snapshot?.qi_metric_contract_status) ?? (parseFordField('metricContractStatus') ?? undefined),
    applicabilityStatus:
      readSnapshotString(snapshot?.qi_applicability_status) ?? (parseFordField('applicabilityStatus') ?? undefined),
    curvatureOk:
      typeof snapshot?.qi_curvature_ok === 'boolean'
        ? snapshot.qi_curvature_ok
        : parseFordField('curvatureOk') === 'true'
          ? true
          : parseFordField('curvatureOk') === 'false'
            ? false
            : undefined,
    curvatureRatio: readCanonicalNumber(snapshot?.qi_curvature_ratio, 'curvatureRatio'),
    curvatureScalar:
      readCanonicalNumber(snapshot?.qi_curvature_scalar, 'curvatureScalar') ?? parseNumberField('curvatureScalar'),
    curvatureRadius_m:
      readCanonicalNumber(snapshot?.qi_curvature_radius_m, 'curvatureRadius_m') ?? parseNumberField('curvatureRadius_m'),
    curvatureFlatSpaceEquivalent:
      typeof snapshot?.qi_curvature_flat_space_equivalent === 'boolean'
        ? snapshot.qi_curvature_flat_space_equivalent
        : parseFordField('curvatureFlatSpaceEquivalent') === 'true'
          ? true
          : parseFordField('curvatureFlatSpaceEquivalent') === 'false'
            ? false
            : undefined,
    curvatureEnforced:
      typeof snapshot?.qi_curvature_enforced === 'boolean'
        ? snapshot.qi_curvature_enforced
        : parseFordField('curvatureEnforced') === 'true'
          ? true
          : parseFordField('curvatureEnforced') === 'false'
            ? false
            : undefined,
    boundFloorApplied:
      typeof snapshot?.qi_bound_floor_applied === 'boolean'
        ? snapshot.qi_bound_floor_applied
        : parseFordField('boundFloorApplied') === 'true'
          ? true
          : parseFordField('boundFloorApplied') === 'false'
            ? false
            : undefined,
    tau_s: readCanonicalNumber(snapshot?.qi_bound_tau_s, 'tau_s'),
    tauConfigured_s: readCanonicalNumber(snapshot?.qi_tau_configured_s, 'tauConfigured_s'),
    tauWindow_s: readCanonicalNumber(snapshot?.qi_tau_window_s, 'tauWindow_s'),
    tauPulse_s: readCanonicalNumber(snapshot?.qi_tau_pulse_s, 'tauPulse_s'),
    tauLC_s: readCanonicalNumber(snapshot?.qi_tau_lc_s, 'tauLC_s'),
    tauSelected_s: readCanonicalNumber(snapshot?.qi_tau_selected_s, 'tauSelected_s'),
    tauSelectedSource:
      readSnapshotString(snapshot?.qi_tau_selected_source) ?? (parseFordField('tauSelectedSource') ?? undefined),
    tauSelectorPolicy:
      readSnapshotString(snapshot?.qi_tau_selector_policy) ?? (parseFordField('tauSelectorPolicy') ?? undefined),
    tauSelectorFallbackApplied:
      typeof snapshot?.qi_tau_selector_fallback_applied === 'boolean'
        ? snapshot.qi_tau_selector_fallback_applied
        : parseFordField('tauSelectorFallbackApplied') === 'true'
          ? true
          : parseFordField('tauSelectorFallbackApplied') === 'false'
            ? false
            : undefined,
    tauProvenanceReady:
      typeof snapshot?.qi_tau_provenance_ready === 'boolean'
        ? snapshot.qi_tau_provenance_ready
        : parseFordField('tauProvenanceReady') === 'true'
          ? true
          : parseFordField('tauProvenanceReady') === 'false'
            ? false
            : undefined,
    tauProvenanceMissing:
      readSnapshotString(snapshot?.qi_tau_provenance_missing) ?? (parseFordField('tauProvenanceMissing') ?? undefined),
    K: readCanonicalNumber(snapshot?.qi_bound_K, 'K'),
    safetySigma_Jm3: readCanonicalNumber(snapshot?.qi_safetySigma_Jm3, 'safetySigma_Jm3'),
  };
};

export const buildQiForensicsArtifact = (pack: EvidencePack, attempt: GrAgentLoopAttempt | null): QiForensicsArtifact => {
  const snapshot = (attempt as any)?.certificate?.payload?.snapshot ?? {};
  const guard = snapshot?.qiGuardrail ?? {};
  const curvatureRatio = finiteOrNull(pack.g4Diagnostics?.curvatureRatio);
  const curvatureScalar =
    finiteOrNull(snapshot?.qi_curvature_scalar) ?? finiteOrNull(pack.g4Diagnostics?.curvatureScalar);
  const curvatureRadius_m =
    finiteOrNull(snapshot?.qi_curvature_radius_m) ?? finiteOrNull(pack.g4Diagnostics?.curvatureRadius_m);
  const curvatureFlatSpaceEquivalent =
    booleanOrNull(snapshot?.qi_curvature_flat_space_equivalent) ??
    booleanOrNull(pack.g4Diagnostics?.curvatureFlatSpaceEquivalent);
  const hasK = pack.g4Diagnostics?.K != null;
  const kProvenanceCommit = hasK
    ? stringOrNull(pack.commitSha) ?? resolveHeadCommitHash([process.cwd()])
    : null;
  return {
    runId: pack.runId,
    wave: pack.wave,
    seed: pack.seed,
    timestamp: pack.completedAt,
    rhoSource: stringOrNull(pack.g4Diagnostics?.rhoSource),
    metricDerived: booleanOrNull(snapshot?.qi_metric_derived),
    metricContractOk: booleanOrNull(snapshot?.qi_metric_contract_ok),
    effectiveRho_SI_Jm3: finiteOrNull(guard?.effectiveRho),
    rhoOn_SI_Jm3: finiteOrNull(guard?.rhoOn),
    metricT00Ref: stringOrNull(pack.g4Diagnostics?.metricT00Ref),
    metricT00Geom_GeomStress: finiteOrNull(pack.g4Diagnostics?.metricT00Geom),
    metricT00GeomSource: stringOrNull(pack.g4Diagnostics?.metricT00GeomSource),
    metricT00Si_Jm3: finiteOrNull(pack.g4Diagnostics?.metricT00Si),
    metricT00SiFromGeom_Jm3: finiteOrNull(pack.g4Diagnostics?.metricT00SiFromGeom),
    metricT00SiRelError: finiteOrNull(pack.g4Diagnostics?.metricT00SiRelError),
    lhs_Jm3: finiteOrNull(pack.g4Diagnostics?.lhs_Jm3),
    bound_Jm3: finiteOrNull(pack.g4Diagnostics?.bound_Jm3),
    boundComputed_Jm3: finiteOrNull(pack.g4Diagnostics?.boundComputed_Jm3),
    boundFloor_Jm3: finiteOrNull(pack.g4Diagnostics?.boundFloor_Jm3),
    boundPolicyFloor_Jm3: finiteOrNull(pack.g4Diagnostics?.boundPolicyFloor_Jm3),
    boundEnvFloor_Jm3: finiteOrNull(pack.g4Diagnostics?.boundEnvFloor_Jm3),
    boundDefaultFloor_Jm3: finiteOrNull(pack.g4Diagnostics?.boundDefaultFloor_Jm3),
    boundFallbackAbs_Jm3: finiteOrNull(pack.g4Diagnostics?.boundFallbackAbs_Jm3),
    boundUsed_Jm3: finiteOrNull(pack.g4Diagnostics?.boundUsed_Jm3),
    boundFloorApplied: booleanOrNull(pack.g4Diagnostics?.boundFloorApplied),
    marginRatioRaw: finiteOrNull(pack.g4Diagnostics?.marginRatioRaw),
    marginRatioRawComputed: finiteOrNull(pack.g4Diagnostics?.marginRatioRawComputed),
    uncertaintySigma_Jm3: finiteOrNull(pack.g4Diagnostics?.uncertaintySigma_Jm3),
    uncertaintySigmaMeasurement_Jm3: finiteOrNull(pack.g4Diagnostics?.uncertaintySigmaMeasurement_Jm3),
    uncertaintySigmaModel_Jm3: finiteOrNull(pack.g4Diagnostics?.uncertaintySigmaModel_Jm3),
    uncertaintySigmaBridge_Jm3: finiteOrNull(pack.g4Diagnostics?.uncertaintySigmaBridge_Jm3),
    uncertaintySigmaTau_Jm3: finiteOrNull(pack.g4Diagnostics?.uncertaintySigmaTau_Jm3),
    uncertaintyModelSigmaConfigured_Jm3: finiteOrNull(pack.g4Diagnostics?.uncertaintyModelSigmaConfigured_Jm3),
    uncertaintyModelSigmaSource: stringOrNull(pack.g4Diagnostics?.uncertaintyModelSigmaSource),
    uncertaintyModelSigmaRationale: stringOrNull(pack.g4Diagnostics?.uncertaintyModelSigmaRationale),
    uncertaintyModelSigmaRequired: booleanOrNull(pack.g4Diagnostics?.uncertaintyModelSigmaRequired),
    uncertaintyModelSigmaProvenanceReady: booleanOrNull(pack.g4Diagnostics?.uncertaintyModelSigmaProvenanceReady),
    uncertaintyModelSigmaProvenanceMissing: stringOrNull(pack.g4Diagnostics?.uncertaintyModelSigmaProvenanceMissing),
    uncertaintyDominantComponent: stringOrNull(pack.g4Diagnostics?.uncertaintyDominantComponent),
    uncertaintyBandKSigma: finiteOrNull(pack.g4Diagnostics?.uncertaintyBandKSigma),
    uncertaintySlackPolicy_Jm3: finiteOrNull(pack.g4Diagnostics?.uncertaintySlackPolicy_Jm3),
    uncertaintySlackComputed_Jm3: finiteOrNull(pack.g4Diagnostics?.uncertaintySlackComputed_Jm3),
    uncertaintyBandLowerPolicy_Jm3: finiteOrNull(pack.g4Diagnostics?.uncertaintyBandLowerPolicy_Jm3),
    uncertaintyBandUpperPolicy_Jm3: finiteOrNull(pack.g4Diagnostics?.uncertaintyBandUpperPolicy_Jm3),
    uncertaintyBandLowerComputed_Jm3: finiteOrNull(pack.g4Diagnostics?.uncertaintyBandLowerComputed_Jm3),
    uncertaintyBandUpperComputed_Jm3: finiteOrNull(pack.g4Diagnostics?.uncertaintyBandUpperComputed_Jm3),
    uncertaintyDecisionClass: stringOrNull(pack.g4Diagnostics?.uncertaintyDecisionClass),
    uncertaintyCouldFlip: booleanOrNull(pack.g4Diagnostics?.uncertaintyCouldFlip),
    uncertaintyInputsMissing: stringOrNull(pack.g4Diagnostics?.uncertaintyInputsMissing),
    g4FloorDominated: booleanOrNull(pack.g4Diagnostics?.g4FloorDominated),
    g4PolicyExceeded: booleanOrNull(pack.g4Diagnostics?.g4PolicyExceeded),
    g4ComputedExceeded: booleanOrNull(pack.g4Diagnostics?.g4ComputedExceeded),
    g4DualFailMode:
      pack.g4Diagnostics?.g4DualFailMode === 'policy_only' ||
      pack.g4Diagnostics?.g4DualFailMode === 'computed_only' ||
      pack.g4Diagnostics?.g4DualFailMode === 'both' ||
      pack.g4Diagnostics?.g4DualFailMode === 'neither'
        ? pack.g4Diagnostics.g4DualFailMode
        : null,
    marginRatioClamped: finiteOrNull(pack.g4Diagnostics?.marginRatio),
    couplingMode: stringOrNull(pack.g4Diagnostics?.couplingMode),
    couplingAlpha: finiteOrNull(pack.g4Diagnostics?.couplingAlpha),
    rhoMetric_Jm3: finiteOrNull(pack.g4Diagnostics?.rhoMetric_Jm3),
    rhoMetricSource: stringOrNull(pack.g4Diagnostics?.rhoMetricSource),
    rhoProxy_Jm3: finiteOrNull(pack.g4Diagnostics?.rhoProxy_Jm3),
    rhoProxySource: stringOrNull(pack.g4Diagnostics?.rhoProxySource),
    rhoCoupledShadow_Jm3: finiteOrNull(pack.g4Diagnostics?.rhoCoupledShadow_Jm3),
    couplingResidualRel: finiteOrNull(pack.g4Diagnostics?.couplingResidualRel),
    couplingComparable: booleanOrNull(pack.g4Diagnostics?.couplingComparable),
    couplingEquationRef: stringOrNull(pack.g4Diagnostics?.couplingEquationRef),
    couplingSemantics: stringOrNull(pack.g4Diagnostics?.couplingSemantics),
    quantitySemanticBaseType: stringOrNull(pack.g4Diagnostics?.quantitySemanticBaseType),
    quantitySemanticType: stringOrNull(pack.g4Diagnostics?.quantitySemanticType),
    quantitySemanticTargetType: stringOrNull(pack.g4Diagnostics?.quantitySemanticTargetType),
    quantityWorldlineClass: stringOrNull(pack.g4Diagnostics?.quantityWorldlineClass),
    quantitySemanticComparable: booleanOrNull(pack.g4Diagnostics?.quantitySemanticComparable),
    quantitySemanticReason: stringOrNull(pack.g4Diagnostics?.quantitySemanticReason),
    quantitySemanticBridgeMode: stringOrNull(pack.g4Diagnostics?.quantitySemanticBridgeMode),
    quantitySemanticBridgeReady: booleanOrNull(pack.g4Diagnostics?.quantitySemanticBridgeReady),
    quantitySemanticBridgeMissing: stringOrNull(pack.g4Diagnostics?.quantitySemanticBridgeMissing),
    qeiStateClass: stringOrNull(pack.g4Diagnostics?.qeiStateClass),
    qeiRenormalizationScheme: stringOrNull(pack.g4Diagnostics?.qeiRenormalizationScheme),
    qeiSamplingNormalization: stringOrNull(pack.g4Diagnostics?.qeiSamplingNormalization),
    qeiOperatorMapping: stringOrNull(pack.g4Diagnostics?.qeiOperatorMapping),
    congruentSolvePolicyMarginPass: booleanOrNull(pack.g4Diagnostics?.congruentSolvePolicyMarginPass),
    congruentSolveComputedMarginPass: booleanOrNull(pack.g4Diagnostics?.congruentSolveComputedMarginPass),
    congruentSolveApplicabilityPass: booleanOrNull(pack.g4Diagnostics?.congruentSolveApplicabilityPass),
    congruentSolveMetricPass: booleanOrNull(pack.g4Diagnostics?.congruentSolveMetricPass),
    congruentSolveSemanticPass: booleanOrNull(pack.g4Diagnostics?.congruentSolveSemanticPass),
    congruentSolvePass: booleanOrNull(pack.g4Diagnostics?.congruentSolvePass),
    congruentSolveFailReasons: Array.isArray(pack.g4Diagnostics?.congruentSolveFailReasons)
      ? pack.g4Diagnostics.congruentSolveFailReasons.slice()
      : [],
    tau_s: finiteOrNull(pack.g4Diagnostics?.tau_s),
    tauConfigured_s: finiteOrNull(pack.g4Diagnostics?.tauConfigured_s),
    tauWindow_s: finiteOrNull(pack.g4Diagnostics?.tauWindow_s),
    tauPulse_s: finiteOrNull(pack.g4Diagnostics?.tauPulse_s),
    tauLC_s: finiteOrNull(pack.g4Diagnostics?.tauLC_s),
    tauSelected_s: finiteOrNull(pack.g4Diagnostics?.tauSelected_s),
    tauSelectedSource: stringOrNull(pack.g4Diagnostics?.tauSelectedSource),
    tauSelectorPolicy: stringOrNull(pack.g4Diagnostics?.tauSelectorPolicy),
    tauSelectorFallbackApplied: booleanOrNull(pack.g4Diagnostics?.tauSelectorFallbackApplied),
    tauProvenanceReady: booleanOrNull(pack.g4Diagnostics?.tauProvenanceReady),
    tauProvenanceMissing: stringOrNull(pack.g4Diagnostics?.tauProvenanceMissing),
    samplingKernelIdentity: stringOrNull(guard?.sampler) ?? stringOrNull((pack.g4Diagnostics as any)?.sampler) ?? 'gaussian',
    samplingKernelNormalization: stringOrNull(pack.g4Diagnostics?.qeiSamplingNormalization),
    sampler: stringOrNull(guard?.sampler) ?? stringOrNull((pack.g4Diagnostics as any)?.sampler) ?? 'gaussian',
    fieldType: stringOrNull(guard?.fieldType) ?? stringOrNull((pack.g4Diagnostics as any)?.fieldType) ?? 'em',
    K: finiteOrNull(pack.g4Diagnostics?.K),
    KUnits: hasK ? 'J*s^4/m^3' : null,
    KProvenanceCommit: kProvenanceCommit,
    KDerivation: hasK ? 'ford_roman_bound_constant_from_qi_guard' : null,
    safetySigma_Jm3: finiteOrNull(pack.g4Diagnostics?.safetySigma_Jm3),
    curvatureScalar,
    curvatureRadius_m,
    curvatureRatio,
    curvatureRatioNonDegenerate:
      curvatureRatio == null
        ? null
        : Math.abs(curvatureRatio) > 0 || curvatureFlatSpaceEquivalent === true,
    curvatureFlatSpaceEquivalent,
    curvatureEnforced: booleanOrNull(pack.g4Diagnostics?.curvatureEnforced),
    curvatureOk: booleanOrNull(pack.g4Diagnostics?.curvatureOk),
    applicabilityStatus: stringOrNull(pack.g4Diagnostics?.applicabilityStatus),
    g4ReasonCodes: Array.isArray(pack.g4Diagnostics?.reasonCode) ? pack.g4Diagnostics.reasonCode.slice() : [],
  };
};


export const computeReproducibility = (runResults: GrAgentLoopResult[]): EvidencePack['reproducibility'] => {
  const evaluations = runResults.map((result) => extractLatestAttempt(result)?.evaluation).filter(Boolean);
  const gateStatuses = evaluations.map((evaluation) => evaluation?.gate?.status).filter((status): status is string => Boolean(status));
  const agreementRatio = gateStatuses.length >= 2 ? gateStatuses.filter((status) => status === gateStatuses[0]).length / gateStatuses.length : null;
  const payloads = evaluations.map((evaluation) => JSON.stringify(evaluation?.constraints ?? null));
  const driftRatio = payloads.length >= 2 ? payloads.slice(1).filter((value) => value !== payloads[0]).length / (payloads.length - 1) : null;
  const residualSeries = runResults
    .map((result) => extractLatestAttempt(result)?.initial?.residual)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const residualTrendReady = residualSeries.length >= 2;
  const decreasing = residualTrendReady && residualSeries[residualSeries.length - 1] < residualSeries[0];
  return {
    repeatedRunGateAgreement: {
      status: agreementRatio === null ? 'NOT_READY' : agreementRatio === 1 ? 'PASS' : 'FAIL',
      agreementRatio,
      reason: agreementRatio === null ? 'Need at least two repeated runs to compute agreement.' : 'Agreement computed from latest-attempt gate status values.',
    },
    constraintPayloadDrift: {
      status: driftRatio === null ? 'NOT_READY' : driftRatio === 0 ? 'PASS' : 'FAIL',
      driftRatio,
      reason: driftRatio === null ? 'Need at least two repeated runs to compute drift.' : 'Drift computed from serialized latest-attempt constraint payload.',
    },
    residualTrend: {
      status: residualTrendReady ? (decreasing ? 'PASS' : 'FAIL') : 'NOT_READY',
      fidelityLevels: residualSeries.length,
      trend: residualTrendReady ? (decreasing ? 'decreasing' : 'non_decreasing') : 'unknown',
      reason: !residualTrendReady
        ? 'Need at least 2 fidelity levels for residual trend.'
        : decreasing
          ? 'Residual trend is strictly decreasing across available fidelity levels.'
          : 'Residual trend is non-decreasing across available fidelity levels.',
      series: residualSeries,
    },
  };
};

const runWave = async (
  wave: Wave,
  waveProfiles: Record<Wave, { runCount: number; options: GrAgentLoopOptions }>,
  outDir: string,
  seed: number,
  ci: boolean,
  ciFastPath: boolean,
  waveTimeoutMs: number,
  campaignElapsedMs: number,
  campaignTimeoutMs: number,
): Promise<EvidencePack> => {
  const commitSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  const startIso = new Date().toISOString();
  const runId = `fs-${wave.toLowerCase()}-${seed}-${Date.now()}`;
  const traceId = `trace-${hashId(`${wave}-${seed}-${startIso}`)}`;
  const profile = waveProfiles[wave];
  const base = path.join(outDir, wave);
  mkdirp(base);

  const runResults: GrAgentLoopResult[] = [];
  const runArtifacts: EvidencePack['runArtifacts'] = [];
  const runErrors: Array<{ runIndex: number; error: string }> = [];

  for (let runIndex = 0; runIndex < profile.runCount; runIndex += 1) {
    const elapsedMs = Date.now() - Date.parse(startIso);
    if (campaignElapsedMs + elapsedMs > campaignTimeoutMs) {
      runErrors.push({ runIndex: runIndex + 1, error: `campaign_timeout:${campaignTimeoutMs}` });
      break;
    }
    const startedAt = new Date().toISOString();
    const started = Date.now();
    try {
      const perRunCampaignRemainingMs = Math.max(1, campaignTimeoutMs - (campaignElapsedMs + (Date.now() - Date.parse(startIso))));
      const effectiveRunTimeoutMs = Math.max(1, Math.min(waveTimeoutMs, perRunCampaignRemainingMs));
      const timeoutKind = perRunCampaignRemainingMs <= waveTimeoutMs ? 'campaign_timeout' : 'wave_timeout';
      const result = await withTimeout(
        runGrAgentLoopIsolated(
          {
            wave,
            runIndex: runIndex + 1,
            baseDir: base,
            ciFastPath,
            options: {
              ...profile.options,
              budget: {
                ...(profile.options.budget ?? {}),
                maxAttemptMs: effectiveRunTimeoutMs,
                maxTotalMs: effectiveRunTimeoutMs,
              },
            },
          },
          effectiveRunTimeoutMs,
          timeoutKind,
          campaignElapsedMs + (Date.now() - Date.parse(startIso)),
        ),
        effectiveRunTimeoutMs + 500,
        timeoutKind,
        campaignElapsedMs + (Date.now() - Date.parse(startIso)),
        wave,
      );
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - started;
      runResults.push(result);

      const outputPath = path.join(base, `run-${runIndex + 1}-raw-output.json`);
      writeJson(outputPath, {
        wave,
        runIndex: runIndex + 1,
        startedAt,
        completedAt,
        durationMs,
        options: profile.options,
        result,
      });

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
    } catch (error) {
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      const outputPath = path.join(base, `run-${runIndex + 1}-raw-output.json`);
      writeJson(outputPath, { wave, runIndex: runIndex + 1, startedAt, completedAt, durationMs, options: profile.options, error: message });
      runArtifacts.push({
        runIndex: runIndex + 1,
        startedAt,
        completedAt,
        durationMs,
        accepted: false,
        state: 'error',
        attemptCount: 0,
        outputPath,
      });
      runErrors.push({ runIndex: runIndex + 1, error: message });
      if (error instanceof CampaignTimeoutError) {
        break;
      }
    }
  }

  if (runArtifacts.length < profile.runCount) {
    const fallbackError = runErrors.length > 0 ? runErrors[runErrors.length - 1].error : 'campaign_incomplete';
    const fallbackState = fallbackError.startsWith('wave_timeout:') || fallbackError.startsWith('campaign_timeout:') ? 'timeout' : 'not_executed';
    for (let runIndex = runArtifacts.length; runIndex < profile.runCount; runIndex += 1) {
      const outputPath = path.join(base, `run-${runIndex + 1}-raw-output.json`);
      const nowIso = new Date().toISOString();
      writeJson(outputPath, {
        wave,
        runIndex: runIndex + 1,
        startedAt: nowIso,
        completedAt: nowIso,
        durationMs: 0,
        options: profile.options,
        error: fallbackError,
        skipped: true,
      });
      runArtifacts.push({
        runIndex: runIndex + 1,
        startedAt: nowIso,
        completedAt: nowIso,
        durationMs: 0,
        accepted: false,
        state: fallbackState,
        attemptCount: 0,
        outputPath,
      });
      runErrors.push({ runIndex: runIndex + 1, error: fallbackError });
    }
  }

  const gateMap = buildGateMap(wave, runResults, runArtifacts);
  const latestAttempt = runResults.length ? extractLatestAttempt(runResults[runResults.length - 1]) : null;
  const latestResult = runResults.length ? runResults[runResults.length - 1] : null;
  const { requiredSignals, missingSignals } = collectRequiredSignals(latestAttempt, latestResult);
  const gateMissingSignalMap = buildGateMissingSignalMap(missingSignals, wave);
  applyMissingSignalFailClosed(gateMap, gateMissingSignalMap);
  const gateStatus = Object.fromEntries(Object.entries(gateMap).map(([key, value]) => [key, value.status])) as Record<string, GateStatus>;
  const firstFail = deriveFirstFail(gateMap);

  const evaluationSummary = {
    hardConstraintMap: runResults.length
      ? Object.fromEntries(
          (extractLatestAttempt(runResults[runResults.length - 1])?.evaluation.constraints ?? [])
            .filter((entry) => entry.id === 'FordRomanQI' || entry.id === 'ThetaAudit')
            .map((entry) => [entry.id, entry.status]),
        )
      : {},
    gateStatusByAttempt: runResults.map((result, idx) => ({
      runIndex: idx + 1,
      gateStatus: extractLatestAttempt(result)?.evaluation?.gate?.status ?? 'missing',
      pass: Boolean(extractLatestAttempt(result)?.evaluation?.pass),
    })),
  };

  const reproducibility = computeReproducibility(runResults);
  const elapsedWaveMs = Date.now() - Date.parse(startIso);
  const timeoutError = runErrors
    .map((entry) => entry.error)
    .find((entry) => entry.startsWith('wave_timeout:') || entry.startsWith('campaign_timeout:'));
  const timeout = timeoutError
    ? timeoutError.startsWith('wave_timeout:')
      ? { kind: 'wave_timeout' as const, timeoutMs: waveTimeoutMs, elapsedMs: elapsedWaveMs, wave }
      : { kind: 'campaign_timeout' as const, timeoutMs: campaignTimeoutMs, elapsedMs: campaignElapsedMs + elapsedWaveMs, wave }
    : undefined;
  const { gateCauseClass, notReadyClassCounts } = buildNotReadyClassification(gateMap, gateMissingSignalMap, timeout);
  const g4Diagnostics = deriveG4Diagnostics(latestAttempt);

  const pack: EvidencePack = {
    commitSha,
    runTimestamp: startIso,
    completedAt: new Date().toISOString(),
    runId,
    traceId,
    wave,
    seed,
    provenance: {
      command: `npm run warp:full-solve:campaign -- --wave ${wave}${ci ? ' --ci' : ''}${ciFastPath ? ' --ci-fast-path' : ''}`,
      cwd: process.cwd(),
      mode: ci ? 'ci' : 'local',
    },
    commandMetadata: {
      maxIterations: profile.options.maxIterations ?? 0,
      runCount: profile.runCount,
      waveProfile: profile.options,
    },
    runArtifacts,
    gateStatus,
    gateDetails: gateMap,
    firstFail: firstFail.firstFail,
    firstFailReason: firstFail.reason,
    parsedGateMap: gateMap,
    evaluationSummary,
    requiredSignals,
    missingSignals,
    gateMissingSignalMap,
    notReadyClassCounts,
    gateCauseClass,
    g4Diagnostics,
    timeout,
    reproducibility,
    claimPosture: 'diagnostic/reduced-order',
    executiveTranslationRef: EXECUTIVE_TRANSLATION_DOC,
    boundaryStatement: BOUNDARY_STATEMENT,
  };

  writeJson(path.join(base, 'evidence-pack.json'), { ...pack, runErrors });
  writeJson(path.join(base, 'qi-forensics.json'), buildQiForensicsArtifact(pack, latestAttempt));
  writeJson(path.join(base, 'first-fail-map.json'), {
    wave,
    globalFirstFail: firstFail.firstFail,
    reason: firstFail.reason,
    perRun: runArtifacts.map((item) => ({ id: `${runId}-run${item.runIndex}`, state: item.state })),
  });
  return pack;
};

const regenCampaign = (outDir: string, waves: Wave[]) => {
  const packs = waves.map((w) => JSON.parse(fs.readFileSync(path.join(outDir, w, 'evidence-pack.json'), 'utf8')) as EvidencePack);
  const lane = packs.some((pack) => String(pack.provenance?.command ?? '').includes('--ci-fast-path')) ? 'readiness' : 'budget-stress';
  const campaignNotReadyClassCounts = packs.reduce((acc, pack) => ({
    timeout_budget: acc.timeout_budget + (pack.notReadyClassCounts?.timeout_budget ?? 0),
    missing_required_signals: acc.missing_required_signals + (pack.notReadyClassCounts?.missing_required_signals ?? 0),
    policy_not_applicable_misuse: acc.policy_not_applicable_misuse + (pack.notReadyClassCounts?.policy_not_applicable_misuse ?? 0),
    other: acc.other + (pack.notReadyClassCounts?.other ?? 0),
  }), { timeout_budget: 0, missing_required_signals: 0, policy_not_applicable_misuse: 0, other: 0 });
  const aggregatedGateStatus = aggregateGateStatusAcrossWaves(packs.map((pack) => pack.gateStatus));
  const scoreboard = summarizeScoreboard(aggregatedGateStatus);
  const decision = deriveCampaignDecision(scoreboard.counts);
  const aggregateFirstFail = deriveFirstFail(
    Object.fromEntries(
      Object.entries(aggregatedGateStatus).map(([gateId, status]) => [gateId, { status, reason: `Aggregated from waves: ${waves.join(',')}`, source: 'campaign.cross-wave.aggregate' }]),
    ) as Record<string, GateRecord>,
  );

  writeJson(path.join(outDir, `campaign-gate-scoreboard-${DATE_STAMP}.json`), {
    campaignId: `FS-CAMPAIGN-${DATE_STAMP}`,
    asOfDate: DATE_STAMP,
    executiveTranslationRef: EXECUTIVE_TRANSLATION_DOC,
    decision,
    statusCounts: scoreboard.counts,
    gateCount: scoreboard.gateCount,
    reconciled: scoreboard.reconciled,
    lane,
    notReadyClassCounts: campaignNotReadyClassCounts,
    gates: aggregatedGateStatus,
    perWaveGates: Object.fromEntries(packs.map((pack) => [pack.wave, pack.gateStatus])),
  });

  writeJson(path.join(outDir, `campaign-first-fail-map-${DATE_STAMP}.json`), {
    campaignId: `FS-CAMPAIGN-${DATE_STAMP}`,
    asOfDate: DATE_STAMP,
    executiveTranslationRef: EXECUTIVE_TRANSLATION_DOC,
    globalFirstFail: aggregateFirstFail.firstFail,
    perWave: Object.fromEntries(waves.map((w) => [w, (JSON.parse(fs.readFileSync(path.join(outDir, w, 'first-fail-map.json'), 'utf8')) as { globalFirstFail: string }).globalFirstFail])),
    lane,
    notReadyClassCounts: campaignNotReadyClassCounts,
  });

  writeJson(path.join(outDir, `campaign-action-plan-30-60-90-${DATE_STAMP}.json`), {
    campaignId: `FS-CAMPAIGN-${DATE_STAMP}`,
    executiveTranslationRef: EXECUTIVE_TRANSLATION_DOC,
    decision,
    lane,
    notReadyClassCounts: campaignNotReadyClassCounts,
    blockers: packs.flatMap((pack) =>
      Object.entries(pack.gateDetails)
        .filter(([, detail]) => detail.status === 'FAIL' || detail.status === 'NOT_READY')
        .map(([gateId, detail]) => ({ wave: pack.wave, gateId, status: detail.status, reason: detail.reason })),
    ),
    plan: {
      '30_days': ['Resolve first FAIL/NOT_READY hard gate from campaign-first-fail map and capture new evidence-pack outputs.'],
      '60_days': ['Demonstrate stable repeated-run outcomes for waves C and D from persisted raw outputs.'],
      '90_days': ['Close evidence gaps so gates are PASS/NOT_APPLICABLE with reproducible artifacts and replayable provenance.'],
    },
  });

  const g4WaveRows = packs
    .map((pack) => {
      const d = pack.g4Diagnostics ?? ({} as any);
      const lhs = Number.isFinite(d.lhs_Jm3) ? d.lhs_Jm3 : 'n/a';
      const bound = Number.isFinite(d.bound_Jm3) ? d.bound_Jm3 : 'n/a';
      const boundComputed = Number.isFinite(d.boundComputed_Jm3) ? d.boundComputed_Jm3 : 'n/a';
      const boundFloor = Number.isFinite(d.boundFloor_Jm3) ? d.boundFloor_Jm3 : 'n/a';
      const boundPolicyFloor = Number.isFinite(d.boundPolicyFloor_Jm3) ? d.boundPolicyFloor_Jm3 : 'n/a';
      const boundEnvFloor = Number.isFinite(d.boundEnvFloor_Jm3) ? d.boundEnvFloor_Jm3 : 'n/a';
      const boundDefaultFloor = Number.isFinite(d.boundDefaultFloor_Jm3) ? d.boundDefaultFloor_Jm3 : 'n/a';
      const boundUsed = Number.isFinite(d.boundUsed_Jm3) ? d.boundUsed_Jm3 : bound;
      const boundFloorApplied = typeof d.boundFloorApplied === 'boolean' ? d.boundFloorApplied : 'n/a';
      const raw = Number.isFinite(d.marginRatioRaw) ? d.marginRatioRaw : Number.isFinite(d.marginRatio) ? d.marginRatio : 'n/a';
      const rawComputed = Number.isFinite(d.marginRatioRawComputed) ? d.marginRatioRawComputed : 'n/a';
      const g4FloorDominated = typeof d.g4FloorDominated === 'boolean' ? d.g4FloorDominated : 'n/a';
      const g4PolicyExceeded = typeof d.g4PolicyExceeded === 'boolean' ? d.g4PolicyExceeded : 'n/a';
      const g4ComputedExceeded = typeof d.g4ComputedExceeded === 'boolean' ? d.g4ComputedExceeded : 'n/a';
      const g4DualFailMode = typeof d.g4DualFailMode === 'string' && d.g4DualFailMode.length > 0 ? d.g4DualFailMode : 'n/a';
      const rho = typeof d.rhoSource === 'string' && d.rhoSource.length > 0 ? d.rhoSource : 'unknown';
      const applicability = typeof d.applicabilityStatus === 'string' && d.applicabilityStatus.length > 0 ? d.applicabilityStatus : 'UNKNOWN';
      return `| ${pack.wave} | ${lhs} | ${boundComputed} | ${boundFloor} | ${boundPolicyFloor} | ${boundEnvFloor} | ${boundDefaultFloor} | ${boundUsed} | ${boundFloorApplied} | ${raw} | ${rawComputed} | ${g4FloorDominated} | ${g4PolicyExceeded} | ${g4ComputedExceeded} | ${g4DualFailMode} | ${rho} | ${applicability} |`;
    })
    .join('\n');
  const bestCasePack = packs.reduce<EvidencePack | null>((best, current) => {
    const currentRaw = Number.isFinite(current.g4Diagnostics?.marginRatioRaw)
      ? Number(current.g4Diagnostics?.marginRatioRaw)
      : Number.isFinite(current.g4Diagnostics?.marginRatio)
        ? Number(current.g4Diagnostics?.marginRatio)
        : Number.POSITIVE_INFINITY;
    if (!best) return current;
    const bestRaw = Number.isFinite(best.g4Diagnostics?.marginRatioRaw)
      ? Number(best.g4Diagnostics?.marginRatioRaw)
      : Number.isFinite(best.g4Diagnostics?.marginRatio)
        ? Number(best.g4Diagnostics?.marginRatio)
        : Number.POSITIVE_INFINITY;
    return currentRaw < bestRaw ? current : best;
  }, null);
  const bestCaseStatus = (() => {
    if (!bestCasePack) return 'evidence_path_blocked';
    const d = bestCasePack.g4Diagnostics ?? ({} as any);
    const raw = Number.isFinite(d.marginRatioRaw) ? Number(d.marginRatioRaw) : Number.POSITIVE_INFINITY;
    if (String(d.applicabilityStatus ?? 'UNKNOWN').toUpperCase() !== 'PASS') return 'applicability_limited';
    if (raw >= 1) return 'margin_limited';
    return 'candidate_pass_found';
  })();

  const sourceArtifactRoot = outDir.replace(/\\/g, '/');
  const canonicalArtifactRoot = CANONICAL_ARTIFACT_ROOT.replace(/\\/g, '/');
  const reportPath = path.join('docs/audits/research', `warp-full-solve-campaign-execution-report-${DATE_STAMP}.md`);
  const governanceMatrixPath = path.join(CANONICAL_ARTIFACT_ROOT, 'g4-governance-matrix-2026-02-27.json');
  const governanceClassResolution = resolveGovernanceCanonicalClass(governanceMatrixPath);
  const governanceCanonicalClass = governanceClassResolution.canonicalClass;

  const recoveryPath = path.join(CANONICAL_ARTIFACT_ROOT, 'g4-recovery-search-2026-02-27.json');
  const recovery = fs.existsSync(recoveryPath) ? JSON.parse(fs.readFileSync(recoveryPath, 'utf8')) : null;
  const recoveryBest = recovery?.bestCandidate ?? null;
  const recoveryCandidateFound = Boolean(recovery?.candidatePassFound);
  const recoveryCandidateFoundCanonical = Boolean(recovery?.candidatePassFoundCanonical ?? recovery?.candidatePassFound);
  const recoveryCandidateFoundComputedOnly = Boolean(recovery?.candidatePassFoundComputedOnly);
  const recoveryBlockedReason =
    typeof recovery?.blockedReason === 'string' && recovery.blockedReason.trim().length > 0
      ? recovery.blockedReason
      : null;
  const recoveryProvenanceCommit = typeof recovery?.provenance?.commitHash === 'string' ? recovery.provenance.commitHash : null;
  const recoveryHeadCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  const recoveryProvenanceFresh = recoveryProvenanceCommit != null && recoveryProvenanceCommit === recoveryHeadCommit;
  const recoveryParityPath = path.join(CANONICAL_ARTIFACT_ROOT, 'g4-recovery-parity-2026-02-27.json');
  const recoveryParity = fs.existsSync(recoveryParityPath) ? JSON.parse(fs.readFileSync(recoveryParityPath, 'utf8')) : null;
  const recoveryParityProvenanceCommit = typeof recoveryParity?.provenance?.commitHash === 'string' ? recoveryParity.provenance.commitHash : null;
  const recoveryParityProvenanceFresh = recoveryParityProvenanceCommit != null && recoveryParityProvenanceCommit === recoveryHeadCommit;
  const semanticBridgeMatrixPath = path.join(CANONICAL_ARTIFACT_ROOT, 'g4-semantic-bridge-matrix-2026-02-27.json');
  const semanticBridgeMatrix = fs.existsSync(semanticBridgeMatrixPath)
    ? JSON.parse(fs.readFileSync(semanticBridgeMatrixPath, 'utf8'))
    : null;
  const semanticBridgeProvenanceCommit =
    typeof semanticBridgeMatrix?.provenance?.commitHash === 'string' ? semanticBridgeMatrix.provenance.commitHash : null;
  const semanticBridgeProvenanceFresh =
    semanticBridgeProvenanceCommit != null && semanticBridgeProvenanceCommit === recoveryHeadCommit;
  const semanticBridgeTopRows = Array.isArray(semanticBridgeMatrix?.tokens)
    ? semanticBridgeMatrix.tokens.slice(0, 5)
    : [];
  const operatorMappingAuditPath = path.join(CANONICAL_ARTIFACT_ROOT, 'g4-operator-mapping-audit-2026-03-02.json');
  const operatorMappingAudit = fs.existsSync(operatorMappingAuditPath)
    ? JSON.parse(fs.readFileSync(operatorMappingAuditPath, 'utf8'))
    : null;
  const operatorMappingBlockedReason =
    typeof operatorMappingAudit?.blockedReason === 'string' && operatorMappingAudit.blockedReason.trim().length > 0
      ? operatorMappingAudit.blockedReason
      : null;
  const operatorMappingStatus =
    typeof operatorMappingAudit?.operatorEvidenceStatus === 'string' && operatorMappingAudit.operatorEvidenceStatus.length > 0
      ? operatorMappingAudit.operatorEvidenceStatus
      : operatorMappingBlockedReason == null
        ? 'pass'
        : 'blocked';
  const operatorMappingProvenanceCommit =
    typeof operatorMappingAudit?.provenance?.commitHash === 'string' ? operatorMappingAudit.provenance.commitHash : null;
  const operatorMappingProvenanceFresh =
    operatorMappingProvenanceCommit != null && operatorMappingProvenanceCommit === recoveryHeadCommit;
  const operatorMappingMissingFields = operatorMappingAudit?.mappingMissingFieldCounts ?? {};
  const operatorMappingMissingFieldRows = Object.entries(operatorMappingMissingFields as Record<string, unknown>)
    .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && Number(count) > 0)
    .map(([field, count]) => `${field}:${count}`)
    .sort((a, b) => a.localeCompare(b));
  const kernelProvenanceAuditPath = path.join(CANONICAL_ARTIFACT_ROOT, 'g4-kernel-provenance-audit-2026-03-02.json');
  const kernelProvenanceAudit = fs.existsSync(kernelProvenanceAuditPath)
    ? JSON.parse(fs.readFileSync(kernelProvenanceAuditPath, 'utf8'))
    : null;
  const kernelProvenanceBlockedReason =
    typeof kernelProvenanceAudit?.blockedReason === 'string' && kernelProvenanceAudit.blockedReason.trim().length > 0
      ? kernelProvenanceAudit.blockedReason
      : null;
  const kernelProvenanceStatus =
    typeof kernelProvenanceAudit?.kernelEvidenceStatus === 'string' && kernelProvenanceAudit.kernelEvidenceStatus.length > 0
      ? kernelProvenanceAudit.kernelEvidenceStatus
      : kernelProvenanceBlockedReason == null
        ? 'pass'
        : 'blocked';
  const kernelProvenanceCommit =
    typeof kernelProvenanceAudit?.provenance?.commitHash === 'string' ? kernelProvenanceAudit.provenance.commitHash : null;
  const kernelProvenanceFresh = kernelProvenanceCommit != null && kernelProvenanceCommit === recoveryHeadCommit;
  const kernelProvenanceTopRows = Array.isArray(kernelProvenanceAudit?.waves)
    ? kernelProvenanceAudit.waves.slice(0, 4)
    : [];
  const kernelProvenanceMissingFields = kernelProvenanceAudit?.missingFieldCounts ?? {};
  const kernelProvenanceMissingFieldRows = Object.entries(kernelProvenanceMissingFields as Record<string, unknown>)
    .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && Number(count) > 0)
    .map(([field, count]) => `${field}:${count}`)
    .sort((a, b) => a.localeCompare(b));
  const curvatureApplicabilityAuditPath = path.join(CANONICAL_ARTIFACT_ROOT, 'g4-curvature-applicability-audit-2026-03-02.json');
  const curvatureApplicabilityAudit = fs.existsSync(curvatureApplicabilityAuditPath)
    ? JSON.parse(fs.readFileSync(curvatureApplicabilityAuditPath, 'utf8'))
    : null;
  const curvatureApplicabilityBlockedReason =
    typeof curvatureApplicabilityAudit?.blockedReason === 'string' && curvatureApplicabilityAudit.blockedReason.trim().length > 0
      ? curvatureApplicabilityAudit.blockedReason
      : null;
  const curvatureApplicabilityStatus =
    typeof curvatureApplicabilityAudit?.curvatureEvidenceStatus === 'string' && curvatureApplicabilityAudit.curvatureEvidenceStatus.length > 0
      ? curvatureApplicabilityAudit.curvatureEvidenceStatus
      : curvatureApplicabilityBlockedReason == null
        ? 'pass'
        : 'blocked';
  const curvatureApplicabilityCommit =
    typeof curvatureApplicabilityAudit?.provenance?.commitHash === 'string'
      ? curvatureApplicabilityAudit.provenance.commitHash
      : null;
  const curvatureApplicabilityFresh = curvatureApplicabilityCommit != null && curvatureApplicabilityCommit === recoveryHeadCommit;
  const curvatureApplicabilityTopRows = Array.isArray(curvatureApplicabilityAudit?.waves)
    ? curvatureApplicabilityAudit.waves.slice(0, 4)
    : [];
  const curvatureApplicabilityMissingFields = curvatureApplicabilityAudit?.missingFieldCounts ?? {};
  const curvatureApplicabilityMissingFieldRows = Object.entries(curvatureApplicabilityMissingFields as Record<string, unknown>)
    .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && Number(count) > 0)
    .map(([field, count]) => `${field}:${count}`)
    .sort((a, b) => a.localeCompare(b));
  const uncertaintyAuditPath = path.join(CANONICAL_ARTIFACT_ROOT, 'g4-uncertainty-audit-2026-03-02.json');
  const uncertaintyAudit = fs.existsSync(uncertaintyAuditPath)
    ? JSON.parse(fs.readFileSync(uncertaintyAuditPath, 'utf8'))
    : null;
  const uncertaintyAuditBlockedReason =
    typeof uncertaintyAudit?.blockedReason === 'string' && uncertaintyAudit.blockedReason.trim().length > 0
      ? uncertaintyAudit.blockedReason
      : null;
  const uncertaintyAuditStatus =
    typeof uncertaintyAudit?.uncertaintyEvidenceStatus === 'string' && uncertaintyAudit.uncertaintyEvidenceStatus.length > 0
      ? uncertaintyAudit.uncertaintyEvidenceStatus
      : uncertaintyAuditBlockedReason == null
        ? 'pass'
        : 'blocked';
  const uncertaintyAuditCommit =
    typeof uncertaintyAudit?.provenance?.commitHash === 'string' ? uncertaintyAudit.provenance.commitHash : null;
  const uncertaintyAuditFresh = uncertaintyAuditCommit != null && uncertaintyAuditCommit === recoveryHeadCommit;
  const uncertaintyAuditTopRows = Array.isArray(uncertaintyAudit?.waves) ? uncertaintyAudit.waves.slice(0, 4) : [];
  const uncertaintyAuditMissingFields = uncertaintyAudit?.missingFieldCounts ?? {};
  const uncertaintyAuditMissingFieldRows = Object.entries(uncertaintyAuditMissingFields as Record<string, unknown>)
    .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && Number(count) > 0)
    .map(([field, count]) => `${field}:${count}`)
    .sort((a, b) => a.localeCompare(b));
  const uncertaintyAuditDecisionClassCounts = uncertaintyAudit?.decisionClassCounts ?? {};
  const uncertaintyAuditDecisionClassRows = Object.entries(uncertaintyAuditDecisionClassCounts as Record<string, unknown>)
    .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && Number(count) > 0)
    .map(([decisionClass, count]) => `${decisionClass}:${count}`)
    .sort((a, b) => a.localeCompare(b));

  if (sourceArtifactRoot === canonicalArtifactRoot) {
    writeMd(
      reportPath,
    `# Warp Full-Solve Campaign Execution Report (${DATE_STAMP})

## Executive verdict
**${decision}**

## Required companion
- Executive translation: \`${EXECUTIVE_TRANSLATION_DOC}\`

## Lane provenance
- sourceArtifactRoot: **${sourceArtifactRoot}**
- Artifact lane: **${lane}**
- Budget-stress lane can legitimately emit timeout-driven NOT_READY outcomes due to strict runtime budgets.
- Readiness lane (\`--ci-fast-path\`) is the source of gate evaluability and canonical campaign artifacts.

## Gate scoreboard (G0..G8)
- PASS: ${scoreboard.counts.PASS}
- FAIL: ${scoreboard.counts.FAIL}
- UNKNOWN: ${scoreboard.counts.UNKNOWN}
- NOT_READY: ${scoreboard.counts.NOT_READY}
- NOT_APPLICABLE: ${scoreboard.counts.NOT_APPLICABLE}
- Total gates: ${scoreboard.gateCount}
- Reconciled: ${scoreboard.reconciled}

## NOT_READY cause classes
- timeout_budget: ${campaignNotReadyClassCounts.timeout_budget}
- missing_required_signals: ${campaignNotReadyClassCounts.missing_required_signals}
- policy_not_applicable_misuse: ${campaignNotReadyClassCounts.policy_not_applicable_misuse}
- other: ${campaignNotReadyClassCounts.other}

Cross-wave aggregate gate status:
${Object.entries(aggregatedGateStatus).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

Per-wave gate status snapshots:
${packs.map((pack) => `### Wave ${pack.wave}
${Object.entries(pack.gateStatus).map(([k, v]) => `- ${k}: ${v}`).join('\n')}
- missingSignals: ${(pack.missingSignals ?? []).join(', ') || 'none'}
- notReadyClassCounts: timeout_budget=${pack.notReadyClassCounts?.timeout_budget ?? 0}, missing_required_signals=${pack.notReadyClassCounts?.missing_required_signals ?? 0}, policy_not_applicable_misuse=${pack.notReadyClassCounts?.policy_not_applicable_misuse ?? 0}, other=${pack.notReadyClassCounts?.other ?? 0}
- g4Diagnostics: FordRomanQI=${pack.g4Diagnostics?.fordRomanStatus ?? 'missing'}, ThetaAudit=${pack.g4Diagnostics?.thetaAuditStatus ?? 'missing'}, source=${pack.g4Diagnostics?.source ?? 'synthesized_unknown'}
- g4Reasons: ${(pack.g4Diagnostics?.reason ?? []).join(' | ') || 'none'}\n- g4ReasonCodes: ${(pack.g4Diagnostics?.reasonCode ?? []).join(' | ') || 'none'}
- reproducibility.gateAgreement: ${pack.reproducibility?.repeatedRunGateAgreement?.status ?? 'NOT_READY'}`).join('\n\n')}

## Per-wave G4 evidence table
| Wave | lhs_Jm3 | boundComputed_Jm3 | boundFloor_Jm3 | boundPolicyFloor_Jm3 | boundEnvFloor_Jm3 | boundDefaultFloor_Jm3 | boundUsed_Jm3 | boundFloorApplied | marginRatioRaw | marginRatioRawComputed | g4FloorDominated | g4PolicyExceeded | g4ComputedExceeded | g4DualFailMode | rhoSource | applicabilityStatus |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- | --- | --- | --- | --- | --- |
${g4WaveRows}

## G4 governance decomposition
- canonical authoritative class: ${governanceCanonicalClass}
- governance artifact freshness: ${governanceClassResolution.freshness}
- governance freshness reason: ${governanceClassResolution.freshnessReason}
- governance artifact commit: ${governanceClassResolution.artifactCommitHash ?? 'n/a'}
- current head commit: ${governanceClassResolution.headCommitHash ?? 'n/a'}
- policy floor dominated: ${bestCasePack?.g4Diagnostics?.g4FloorDominated ?? 'n/a'}
- policy exceeded (marginRatioRaw >= 1): ${bestCasePack?.g4Diagnostics?.g4PolicyExceeded ?? 'n/a'}
- computed exceeded (marginRatioRawComputed >= 1): ${bestCasePack?.g4Diagnostics?.g4ComputedExceeded ?? 'n/a'}

## Best-case G4 summary
- classification: ${bestCaseStatus}
- wave: ${bestCasePack?.wave ?? 'n/a'}
- lhs_Jm3: ${bestCasePack?.g4Diagnostics?.lhs_Jm3 ?? 'n/a'}
- boundComputed_Jm3: ${bestCasePack?.g4Diagnostics?.boundComputed_Jm3 ?? 'n/a'}
- boundFloor_Jm3: ${bestCasePack?.g4Diagnostics?.boundFloor_Jm3 ?? 'n/a'}
- boundUsed_Jm3: ${bestCasePack?.g4Diagnostics?.boundUsed_Jm3 ?? bestCasePack?.g4Diagnostics?.bound_Jm3 ?? 'n/a'}
- boundFloorApplied: ${bestCasePack?.g4Diagnostics?.boundFloorApplied ?? 'n/a'}
- marginRatioRaw: ${bestCasePack?.g4Diagnostics?.marginRatioRaw ?? bestCasePack?.g4Diagnostics?.marginRatio ?? 'n/a'}
- marginRatioRawComputed: ${bestCasePack?.g4Diagnostics?.marginRatioRawComputed ?? 'n/a'}
- uncertaintySigma_Jm3: ${bestCasePack?.g4Diagnostics?.uncertaintySigma_Jm3 ?? 'n/a'}
- uncertaintySigmaMeasurement_Jm3: ${bestCasePack?.g4Diagnostics?.uncertaintySigmaMeasurement_Jm3 ?? 'n/a'}
- uncertaintySigmaModel_Jm3: ${bestCasePack?.g4Diagnostics?.uncertaintySigmaModel_Jm3 ?? 'n/a'}
- uncertaintySigmaBridge_Jm3: ${bestCasePack?.g4Diagnostics?.uncertaintySigmaBridge_Jm3 ?? 'n/a'}
- uncertaintySigmaTau_Jm3: ${bestCasePack?.g4Diagnostics?.uncertaintySigmaTau_Jm3 ?? 'n/a'}
- uncertaintyModelSigmaConfigured_Jm3: ${bestCasePack?.g4Diagnostics?.uncertaintyModelSigmaConfigured_Jm3 ?? 'n/a'}
- uncertaintyModelSigmaSource: ${bestCasePack?.g4Diagnostics?.uncertaintyModelSigmaSource ?? 'n/a'}
- uncertaintyModelSigmaRationale: ${bestCasePack?.g4Diagnostics?.uncertaintyModelSigmaRationale ?? 'n/a'}
- uncertaintyModelSigmaRequired: ${bestCasePack?.g4Diagnostics?.uncertaintyModelSigmaRequired ?? 'n/a'}
- uncertaintyModelSigmaProvenanceReady: ${bestCasePack?.g4Diagnostics?.uncertaintyModelSigmaProvenanceReady ?? 'n/a'}
- uncertaintyModelSigmaProvenanceMissing: ${bestCasePack?.g4Diagnostics?.uncertaintyModelSigmaProvenanceMissing ?? 'none'}
- uncertaintyDominantComponent: ${bestCasePack?.g4Diagnostics?.uncertaintyDominantComponent ?? 'n/a'}
- uncertaintyBandKSigma: ${bestCasePack?.g4Diagnostics?.uncertaintyBandKSigma ?? 'n/a'}
- uncertaintySlackPolicy_Jm3: ${bestCasePack?.g4Diagnostics?.uncertaintySlackPolicy_Jm3 ?? 'n/a'}
- uncertaintySlackComputed_Jm3: ${bestCasePack?.g4Diagnostics?.uncertaintySlackComputed_Jm3 ?? 'n/a'}
- uncertaintyBandLowerPolicy_Jm3: ${bestCasePack?.g4Diagnostics?.uncertaintyBandLowerPolicy_Jm3 ?? 'n/a'}
- uncertaintyBandUpperPolicy_Jm3: ${bestCasePack?.g4Diagnostics?.uncertaintyBandUpperPolicy_Jm3 ?? 'n/a'}
- uncertaintyBandLowerComputed_Jm3: ${bestCasePack?.g4Diagnostics?.uncertaintyBandLowerComputed_Jm3 ?? 'n/a'}
- uncertaintyBandUpperComputed_Jm3: ${bestCasePack?.g4Diagnostics?.uncertaintyBandUpperComputed_Jm3 ?? 'n/a'}
- uncertaintyDecisionClass: ${bestCasePack?.g4Diagnostics?.uncertaintyDecisionClass ?? 'n/a'}
- uncertaintyCouldFlip: ${bestCasePack?.g4Diagnostics?.uncertaintyCouldFlip ?? 'n/a'}
- uncertaintyInputsMissing: ${bestCasePack?.g4Diagnostics?.uncertaintyInputsMissing ?? 'none'}
- applicabilityStatus: ${bestCasePack?.g4Diagnostics?.applicabilityStatus ?? 'UNKNOWN'}
- congruentSolvePolicyMarginPass: ${bestCasePack?.g4Diagnostics?.congruentSolvePolicyMarginPass ?? 'n/a'}
- congruentSolveComputedMarginPass: ${bestCasePack?.g4Diagnostics?.congruentSolveComputedMarginPass ?? 'n/a'}
- congruentSolveApplicabilityPass: ${bestCasePack?.g4Diagnostics?.congruentSolveApplicabilityPass ?? 'n/a'}
- congruentSolveMetricPass: ${bestCasePack?.g4Diagnostics?.congruentSolveMetricPass ?? 'n/a'}
- congruentSolveSemanticPass: ${bestCasePack?.g4Diagnostics?.congruentSolveSemanticPass ?? 'n/a'}
- congruentSolvePass: ${bestCasePack?.g4Diagnostics?.congruentSolvePass ?? 'n/a'}
- congruentSolveFailReasons: ${(bestCasePack?.g4Diagnostics?.congruentSolveFailReasons ?? []).join('|') || 'none'}
- rhoSource: ${bestCasePack?.g4Diagnostics?.rhoSource ?? 'unknown'}
- metricT00Ref: ${bestCasePack?.g4Diagnostics?.metricT00Ref ?? 'unknown'}
- metricT00Geom: ${bestCasePack?.g4Diagnostics?.metricT00Geom ?? 'n/a'}
- metricT00GeomSource: ${bestCasePack?.g4Diagnostics?.metricT00GeomSource ?? 'unknown'}
- metricT00Si: ${bestCasePack?.g4Diagnostics?.metricT00Si ?? 'n/a'}
- metricT00SiFromGeom: ${bestCasePack?.g4Diagnostics?.metricT00SiFromGeom ?? 'n/a'}
- metricT00SiRelError: ${bestCasePack?.g4Diagnostics?.metricT00SiRelError ?? 'n/a'}


## G4 recovery-search summary
- recovery artifact: ${fs.existsSync(recoveryPath) ? recoveryPath.replace(/\\/g, '/') : 'missing'}
- candidate found (backward-compatible canonical alias): ${recoveryCandidateFound ? 'yes' : 'no'}
- candidate found canonical/policy semantics: ${recoveryCandidateFoundCanonical ? 'yes' : 'no'}
- candidate found computed-only counterfactual semantics: ${recoveryCandidateFoundComputedOnly ? 'yes' : 'no'}
- blocked reason (fail-closed): ${recoveryBlockedReason ?? 'none'}
- case count: ${typeof recovery?.caseCount === 'number' ? recovery.caseCount : 'n/a'}
- attempted case universe: ${typeof recovery?.deterministicSearch?.attemptedCaseUniverse === 'number' ? recovery.deterministicSearch.attemptedCaseUniverse : 'n/a'}
- executed case count: ${typeof recovery?.deterministicSearch?.executedCaseCount === 'number' ? recovery.deterministicSearch.executedCaseCount : 'n/a'}
- min marginRatioRaw among applicability PASS: ${recovery?.minMarginRatioRawAmongApplicabilityPass ?? 'n/a'}
- min marginRatioRawComputed among applicability PASS: ${recovery?.minMarginRatioRawComputedAmongApplicabilityPass ?? 'n/a'}
- best candidate id: ${recoveryBest?.id ?? 'n/a'}
- best candidate marginRatioRawComputed: ${recoveryBest?.marginRatioRawComputed ?? 'n/a'}
- best candidate marginRatioRaw: ${recoveryBest?.marginRatioRaw ?? 'n/a'}
- best candidate applicabilityStatus: ${recoveryBest?.applicabilityStatus ?? 'UNKNOWN'}
- best candidate canonical-pass eligible: ${recovery?.bestCandidateEligibility?.canonicalPassEligible ?? 'n/a'}
- best candidate counterfactual-pass eligible: ${recovery?.bestCandidateEligibility?.counterfactualPassEligible ?? 'n/a'}
- best candidate semantics class: ${recovery?.bestCandidateEligibility?.class ?? 'n/a'}
- recovery provenance commit: ${recoveryProvenanceCommit ?? 'n/a'}
- recovery provenance freshness vs HEAD: ${recoveryProvenanceFresh ? 'fresh' : 'stale_or_missing'}

## G4 recovery parity summary
- candidate count checked: ${typeof recoveryParity?.candidateCountChecked === 'number' ? recoveryParity.candidateCountChecked : 'n/a'}
- anyCanonicalPassCandidate: ${recoveryParity?.anyCanonicalPassCandidate ?? 'n/a'}
- anyComputedOnlyPassCandidate: ${recoveryParity?.anyComputedOnlyPassCandidate ?? 'n/a'}
- dominantFailureMode: ${recoveryParity?.dominantFailureMode ?? 'n/a'}
- selectionPolicy: ${recoveryParity?.selectionPolicy ?? 'n/a'}
- parity artifact: ${fs.existsSync(recoveryParityPath) ? recoveryParityPath.replace(/\\/g, '/') : 'missing'}
- parity provenance commit: ${recoveryParityProvenanceCommit ?? 'n/a'}
- parity provenance freshness vs HEAD: ${recoveryParityProvenanceFresh ? 'fresh' : 'stale_or_missing'}
- canonical decision remains authoritative until wave profiles are promoted and rerun.

## G4 semantic bridge matrix summary
- semantic bridge matrix artifact: ${fs.existsSync(semanticBridgeMatrixPath) ? semanticBridgeMatrixPath.replace(/\\/g, '/') : 'missing'}
- blocked reason: ${semanticBridgeMatrix?.blockedReason ?? 'none'}
- canonical comparable count: ${semanticBridgeMatrix?.canonicalComparableCaseCount ?? 'n/a'}
- canonical structural comparable count: ${semanticBridgeMatrix?.canonicalStructuralComparableCaseCount ?? 'n/a'}
- recovery structural comparable count: ${semanticBridgeMatrix?.recoveryStructuralComparableCaseCount ?? 'n/a'}
- dominant blocker token: ${semanticBridgeMatrix?.dominantBlockerToken ?? 'n/a'}
- dominant blocker score: ${semanticBridgeMatrix?.dominantBlockerScore ?? 'n/a'}
- semantic bridge matrix provenance commit: ${semanticBridgeProvenanceCommit ?? 'n/a'}
- semantic bridge matrix provenance freshness vs HEAD: ${semanticBridgeProvenanceFresh ? 'fresh' : 'stale_or_missing'}
${semanticBridgeTopRows
  .map(
    (row: any, idx: number) =>
      `- blocker[${idx + 1}]: token=${row?.token ?? 'n/a'}; priority=${row?.closurePriority ?? 'n/a'}; canonicalWaves=${Array.isArray(row?.canonicalWaves) ? row.canonicalWaves.join(',') : 'n/a'}; recoveryCases=${row?.recoveryCaseCount ?? 'n/a'}`,
  )
  .join('\n')}

## G4 operator-mapping summary
- operator mapping artifact: ${fs.existsSync(operatorMappingAuditPath) ? operatorMappingAuditPath.replace(/\\/g, '/') : 'missing'}
- operator evidence status: ${operatorMappingStatus}
- blocked reason (fail-closed): ${operatorMappingBlockedReason ?? 'none'}
- canonical missing waves: ${Array.isArray(operatorMappingAudit?.canonicalMissingWaves) ? operatorMappingAudit.canonicalMissingWaves.join(',') || 'none' : 'n/a'}
- mapping comparable all waves: ${operatorMappingAudit?.mappingComparableAll ?? 'n/a'}
- mapping bridge ready all waves: ${operatorMappingAudit?.mappingBridgeReadyAll ?? 'n/a'}
- mapping missing field counts: ${operatorMappingMissingFieldRows.join(', ') || 'none'}
- operator mapping provenance commit: ${operatorMappingProvenanceCommit ?? 'n/a'}
- operator mapping provenance freshness vs HEAD: ${operatorMappingProvenanceFresh ? 'fresh' : 'stale_or_missing'}
- canonical-authoritative statement: canonical campaign decision remains authoritative; operator-mapping evidence is fail-closed.

## G4 sampling/K provenance summary
- sampling/K provenance artifact: ${fs.existsSync(kernelProvenanceAuditPath) ? kernelProvenanceAuditPath.replace(/\\/g, '/') : 'missing'}
- sampling/K evidence status: ${kernelProvenanceStatus}
- blocked reason (fail-closed): ${kernelProvenanceBlockedReason ?? 'none'}
- canonical missing waves: ${Array.isArray(kernelProvenanceAudit?.canonicalMissingWaves) ? kernelProvenanceAudit.canonicalMissingWaves.join(',') || 'none' : 'n/a'}
- normalization pass all waves: ${kernelProvenanceAudit?.normalizationPassAll ?? 'n/a'}
- units pass all waves: ${kernelProvenanceAudit?.unitsPassAll ?? 'n/a'}
- derivation pass all waves: ${kernelProvenanceAudit?.derivationPassAll ?? 'n/a'}
- provenance commit valid all waves: ${kernelProvenanceAudit?.provenanceCommitValidAll ?? 'n/a'}
- replay pass all waves: ${kernelProvenanceAudit?.replayPassAll ?? 'n/a'}
- missing field counts: ${kernelProvenanceMissingFieldRows.join(', ') || 'none'}
- sampling/K provenance commit: ${kernelProvenanceCommit ?? 'n/a'}
- sampling/K provenance freshness vs HEAD: ${kernelProvenanceFresh ? 'fresh' : 'stale_or_missing'}
${kernelProvenanceTopRows
  .map(
    (row: any, idx: number) =>
      `- wave[${idx + 1}] ${row?.wave ?? 'n/a'}: kernel=${row?.samplingKernelIdentity ?? 'n/a'}; normalization=${row?.samplingKernelNormalization ?? 'n/a'}; tau_s=${row?.tau_s ?? 'n/a'}; replayKernelScale=${row?.replayKernelScale ?? 'n/a'}; blockedTokens=${Array.isArray(row?.blockedReasonTokens) ? row.blockedReasonTokens.join('|') || 'none' : 'n/a'}`,
  )
  .join('\n')}
- canonical-authoritative statement: canonical campaign decision remains authoritative; sampling/K provenance evidence is fail-closed.

## G4 curvature applicability summary
- curvature applicability audit artifact: ${fs.existsSync(curvatureApplicabilityAuditPath) ? curvatureApplicabilityAuditPath.replace(/\\/g, '/') : 'missing'}
- curvature evidence status: ${curvatureApplicabilityStatus}
- blocked reason (fail-closed): ${curvatureApplicabilityBlockedReason ?? 'none'}
- canonical missing waves: ${Array.isArray(curvatureApplicabilityAudit?.canonicalMissingWaves) ? curvatureApplicabilityAudit.canonicalMissingWaves.join(',') || 'none' : 'n/a'}
- all applicability PASS: ${curvatureApplicabilityAudit?.allApplicabilityPass ?? 'n/a'}
- all curvature comparable: ${curvatureApplicabilityAudit?.allCurvatureComparable ?? 'n/a'}
- all ratio non-degenerate evidence: ${curvatureApplicabilityAudit?.allRatioNonDegenerateEvidence ?? 'n/a'}
- all scalar/radius present: ${curvatureApplicabilityAudit?.allScalarRadiusPresent ?? 'n/a'}
- all window evidence ready: ${curvatureApplicabilityAudit?.allWindowEvidenceReady ?? 'n/a'}
- min curvatureRatio: ${curvatureApplicabilityAudit?.minCurvatureRatio ?? 'n/a'}
- max curvatureRatio: ${curvatureApplicabilityAudit?.maxCurvatureRatio ?? 'n/a'}
- missing field counts: ${curvatureApplicabilityMissingFieldRows.join(', ') || 'none'}
- curvature applicability provenance commit: ${curvatureApplicabilityCommit ?? 'n/a'}
- curvature applicability provenance freshness vs HEAD: ${curvatureApplicabilityFresh ? 'fresh' : 'stale_or_missing'}
${curvatureApplicabilityTopRows
  .map(
    (row: any, idx: number) =>
      `- wave[${idx + 1}] ${row?.wave ?? 'n/a'}: applicability=${row?.applicabilityStatus ?? 'n/a'}; curvatureEnforced=${row?.curvatureEnforced ?? 'n/a'}; curvatureOk=${row?.curvatureOk ?? 'n/a'}; curvatureRatio=${row?.curvatureRatio ?? 'n/a'}; nonDegenerate=${row?.curvatureRatioNonDegenerate ?? 'n/a'}; flatSpaceEquivalent=${row?.curvatureFlatSpaceEquivalent ?? 'n/a'}; curvatureScalar=${row?.curvatureScalar ?? 'n/a'}; curvatureRadius_m=${row?.curvatureRadius_m ?? 'n/a'}; windowEvidenceReady=${row?.windowEvidenceReady ?? 'n/a'}; blockedTokens=${Array.isArray(row?.blockedReasonTokens) ? row.blockedReasonTokens.join('|') || 'none' : 'n/a'}`,
  )
  .join('\n')}
- canonical-authoritative statement: canonical campaign decision remains authoritative; curvature applicability evidence is fail-closed.

## G4 uncertainty-band summary
- uncertainty audit artifact: ${fs.existsSync(uncertaintyAuditPath) ? uncertaintyAuditPath.replace(/\\/g, '/') : 'missing'}
- uncertainty evidence status: ${uncertaintyAuditStatus}
- blocked reason (fail-closed): ${uncertaintyAuditBlockedReason ?? 'none'}
- canonical missing waves: ${Array.isArray(uncertaintyAudit?.canonicalMissingWaves) ? uncertaintyAudit.canonicalMissingWaves.join(',') || 'none' : 'n/a'}
- all applicability PASS: ${uncertaintyAudit?.allApplicabilityPass ?? 'n/a'}
- all decision classes robust_pass: ${uncertaintyAudit?.allDecisionRobustPass ?? 'n/a'}
- any uncertainty could flip: ${uncertaintyAudit?.anyCouldFlip ?? 'n/a'}
- all uncertainty slack positive: ${uncertaintyAudit?.allSlackPositive ?? 'n/a'}
- robust pass wave count: ${uncertaintyAudit?.robustPassWaveCount ?? 'n/a'}
- could flip wave count: ${uncertaintyAudit?.couldFlipWaveCount ?? 'n/a'}
- min uncertaintySlackPolicy_Jm3: ${uncertaintyAudit?.minUncertaintySlackPolicy_Jm3 ?? 'n/a'}
- min uncertaintySlackComputed_Jm3: ${uncertaintyAudit?.minUncertaintySlackComputed_Jm3 ?? 'n/a'}
- max uncertaintySigma_Jm3: ${uncertaintyAudit?.maxUncertaintySigma_Jm3 ?? 'n/a'}
- max uncertaintySigmaMeasurement_Jm3: ${uncertaintyAudit?.maxUncertaintySigmaMeasurement_Jm3 ?? 'n/a'}
- max uncertaintySigmaModel_Jm3: ${uncertaintyAudit?.maxUncertaintySigmaModel_Jm3 ?? 'n/a'}
- max uncertaintySigmaBridge_Jm3: ${uncertaintyAudit?.maxUncertaintySigmaBridge_Jm3 ?? 'n/a'}
- max uncertaintySigmaTau_Jm3: ${uncertaintyAudit?.maxUncertaintySigmaTau_Jm3 ?? 'n/a'}
- dominant component counts: ${Object.entries((uncertaintyAudit?.dominantComponentCounts ?? {}) as Record<string, unknown>)
  .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && Number(count) > 0)
  .map(([component, count]) => `${component}:${count}`)
  .sort((a, b) => a.localeCompare(b))
  .join(', ') || 'none'}
- decision class counts: ${uncertaintyAuditDecisionClassRows.join(', ') || 'none'}
- missing field counts: ${uncertaintyAuditMissingFieldRows.join(', ') || 'none'}
- uncertainty audit provenance commit: ${uncertaintyAuditCommit ?? 'n/a'}
- uncertainty audit provenance freshness vs HEAD: ${uncertaintyAuditFresh ? 'fresh' : 'stale_or_missing'}
${uncertaintyAuditTopRows
  .map(
    (row: any, idx: number) =>
      `- wave[${idx + 1}] ${row?.wave ?? 'n/a'}: applicability=${row?.applicabilityStatus ?? 'n/a'}; decision=${row?.uncertaintyDecisionClass ?? 'n/a'}; couldFlip=${row?.uncertaintyCouldFlip ?? 'n/a'}; sigmaMeasurement=${row?.uncertaintySigmaMeasurement_Jm3 ?? 'n/a'}; sigmaModel=${row?.uncertaintySigmaModel_Jm3 ?? 'n/a'}; sigmaBridge=${row?.uncertaintySigmaBridge_Jm3 ?? 'n/a'}; sigmaTau=${row?.uncertaintySigmaTau_Jm3 ?? 'n/a'}; modelSigmaSource=${row?.uncertaintyModelSigmaSource ?? 'n/a'}; modelSigmaRequired=${row?.uncertaintyModelSigmaRequired ?? 'n/a'}; modelSigmaProvenanceReady=${row?.uncertaintyModelSigmaProvenanceReady ?? 'n/a'}; dominant=${row?.uncertaintyDominantComponent ?? 'n/a'}; slackPolicy=${row?.uncertaintySlackPolicy_Jm3 ?? 'n/a'}; slackComputed=${row?.uncertaintySlackComputed_Jm3 ?? 'n/a'}; blockedTokens=${Array.isArray(row?.blockedReasonTokens) ? row.blockedReasonTokens.join('|') || 'none' : 'n/a'}`,
  )
  .join('\n')}
- canonical-authoritative statement: canonical campaign decision remains authoritative; uncertainty evidence is fail-closed.

## Operator translation
- What failed: ${aggregateFirstFail.firstFail} (${aggregateFirstFail.reason})
- Why it failed: hard gate and/or required signal deficits are fail-closed; see per-wave reason codes and missing-signal maps.
- What changed in this run: lane=${lane}; timeout_budget=${campaignNotReadyClassCounts.timeout_budget}; missing_required_signals=${campaignNotReadyClassCounts.missing_required_signals}.
- Can code fixes alone resolve it?: only if failures are signal/contract/scaling defects; true margin exceedance requires physics-side improvement.

## Decision output
- Final decision label: **${decision}**
- Claim posture: diagnostic/reduced-order (fail-closed on hard evidence gaps).

## Boundary statement
${BOUNDARY_STATEMENT}
`,
  );
  }

  return { counts: scoreboard.counts, decision, reconciled: scoreboard.reconciled };
};

export const runCampaignCli = async (argv = process.argv.slice(2)): Promise<CliResult> => {
  const args = parseArgs(argv);
  const waveProfiles = resolveWaveProfiles(args);
  const waves: Wave[] = args.wave === 'all' ? ['A', 'B', 'C', 'D'] : [args.wave];
  const campaignStarted = Date.now();
  for (const wave of waves) {
    const campaignElapsedMs = Date.now() - campaignStarted;
    if (campaignElapsedMs > args.campaignTimeoutMs) {
      const timeoutArtifact = path.join(args.out, wave, 'evidence-pack.json');
      // Producer/consumer contract: these keys are authoritative and deterministic for gate fail-closed wiring.
      const requiredSignals: EvidencePack['requiredSignals'] = {
        initial_solver_status: { required: true, present: false },
        evaluation_gate_status: { required: true, present: false },
        hard_constraint_ford_roman_qi: { required: true, present: false },
        hard_constraint_theta_audit: { required: true, present: false },
        certificate_hash: { required: true, present: false },
        certificate_integrity: { required: true, present: false },
        provenance_chart: { required: true, present: false },
        provenance_observer: { required: true, present: false },
        provenance_normalization: { required: true, present: false },
        provenance_unit_system: { required: true, present: false },
        applicability_status: { required: true, present: false },
        applicability_curvature_ok: { required: true, present: false },
        applicability_curvature_ratio: { required: true, present: false },
        operator_quantity_semantic_base_type: { required: true, present: false },
        operator_quantity_semantic_type: { required: true, present: false },
        operator_quantity_semantic_target_type: { required: true, present: false },
        operator_worldline_timelike: { required: true, present: false },
        operator_qei_state_hadamard: { required: true, present: false },
        operator_qei_renormalization_point_splitting: { required: true, present: false },
        operator_qei_sampling_unit_integral: { required: true, present: false },
        operator_qei_mapping_t_munu_uu_ren: { required: true, present: false },
        operator_semantic_comparable: { required: true, present: false },
        operator_bridge_ready: { required: true, present: false },
        operator_mapping_derivation_ref: { required: true, present: false },
      };
      const missingSignals = REQUIRED_SIGNAL_KEYS.slice().sort();
      const gateMissingSignalMap = buildGateMissingSignalMap(missingSignals, wave);
      const gateStatus: EvidencePack['gateStatus'] = {
        G0: 'NOT_READY',
        G1: 'NOT_READY',
        G2: 'NOT_READY',
        G3: 'NOT_READY',
        G4: 'NOT_READY',
        G5: 'NOT_APPLICABLE',
        G6: 'NOT_READY',
        G7: wave === 'C' || wave === 'D' ? 'NOT_READY' : 'NOT_APPLICABLE',
        G8: wave === 'D' ? 'NOT_READY' : 'NOT_APPLICABLE',
      };
      const gateDetails: EvidencePack['gateDetails'] = {
        G0: { status: 'NOT_READY', reason: 'Campaign timeout reached before wave execution.', source: 'campaign.timeout' },
        G1: { status: 'NOT_READY', reason: 'Initial solver status unavailable due campaign timeout.', source: 'campaign.timeout' },
        G2: { status: 'NOT_READY', reason: 'Evaluation gate status unavailable due campaign timeout.', source: 'campaign.timeout' },
        G3: { status: 'NOT_READY', reason: 'Certificate signal unavailable due campaign timeout.', source: 'campaign.timeout' },
        G4: { status: 'NOT_READY', reason: 'Hard constraint signals unavailable due campaign timeout.', source: 'campaign.timeout' },
        G5: { status: 'NOT_APPLICABLE', reason: 'Reduced-order campaign; physical feasibility gate not evaluated.', source: 'campaign.policy.reduced-order' },
        G6: { status: 'NOT_READY', reason: 'No run outputs persisted before campaign timeout.', source: 'campaign.timeout' },
        G7: { status: 'NOT_READY', reason: 'Stability check unavailable due campaign timeout.', source: 'campaign.timeout' },
        G8: { status: 'NOT_READY', reason: 'Replication parity unavailable due campaign timeout.', source: 'campaign.timeout' },
      };
      writeJson(timeoutArtifact, {
        commitSha: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
        runTimestamp: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        runId: `fs-${wave.toLowerCase()}-${args.seed}-${Date.now()}`,
        traceId: `trace-${hashId(`${wave}-${args.seed}-campaign-timeout`)}`,
        wave,
        seed: args.seed,
        provenance: {
          command: `npm run warp:full-solve:campaign -- --wave ${wave}${args.ci ? ' --ci' : ''}${args.ciFastPath ? ' --ci-fast-path' : ''}`,
          cwd: process.cwd(),
          mode: args.ci ? 'ci' : 'local',
        },
        commandMetadata: {
          maxIterations: waveProfiles[wave].options.maxIterations ?? 0,
          runCount: waveProfiles[wave].runCount,
          waveProfile: waveProfiles[wave].options,
        },
        runArtifacts: [],
        gateStatus,
        gateDetails,
        firstFail: 'G0',
        firstFailReason: 'Campaign timeout reached before wave execution.',
        parsedGateMap: gateDetails,
        evaluationSummary: { hardConstraintMap: {}, gateStatusByAttempt: [] },
        requiredSignals,
        missingSignals,
        gateMissingSignalMap,
        notReadyClassCounts: { timeout_budget: 7, missing_required_signals: 0, policy_not_applicable_misuse: 0, other: 0 },
        gateCauseClass: {
          G0: 'timeout_budget',
          G1: 'timeout_budget',
          G2: 'timeout_budget',
          G3: 'timeout_budget',
          G4: 'timeout_budget',
          G5: 'none',
          G6: 'timeout_budget',
          G7: wave === 'C' || wave === 'D' ? 'timeout_budget' : 'none',
          G8: wave === 'D' ? 'timeout_budget' : 'none',
        },
        g4Diagnostics: {
          fordRomanStatus: 'missing',
          thetaAuditStatus: 'missing',
          source: 'synthesized_unknown',
          reason: ['Hard-constraint signals unavailable due campaign timeout.'],
          reasonCode: ['G4_TIMEOUT_NO_SIGNALS'],
        },
        timeout: { kind: 'campaign_timeout', timeoutMs: args.campaignTimeoutMs, elapsedMs: campaignElapsedMs, wave },
        reproducibility: {
          repeatedRunGateAgreement: { status: 'NOT_READY', agreementRatio: null, reason: 'No runs executed before campaign timeout.' },
          constraintPayloadDrift: { status: 'NOT_READY', driftRatio: null, reason: 'No runs executed before campaign timeout.' },
          residualTrend: {
            status: 'NOT_READY',
            fidelityLevels: 0,
            trend: 'unknown',
            reason: 'No runs executed before campaign timeout.',
            series: [],
          },
        },
        claimPosture: 'diagnostic/reduced-order',
        executiveTranslationRef: EXECUTIVE_TRANSLATION_DOC,
        boundaryStatement: BOUNDARY_STATEMENT,
      });
      break;
    }
    await runWave(wave, waveProfiles, args.out, args.seed, args.ci, args.ciFastPath, args.waveTimeoutMs, campaignElapsedMs, args.campaignTimeoutMs);
  }
  const allWaves: Wave[] = ['A', 'B', 'C', 'D'];
  const campaign = allWaves.every((w) => fs.existsSync(path.join(args.out, w, 'evidence-pack.json')))
    ? regenCampaign(args.out, allWaves)
    : { counts: null, decision: 'NOT_READY', reconciled: false };
  return { ok: true, waves, out: args.out, campaign, mode: args.ci ? 'ci' : 'local' };
};

export const CAMPAIGN_USAGE =
  'Usage: npm run warp:full-solve:campaign -- --wave A|B|C|D|all [--out <dir>] [--seed <integer>] [--wave-timeout-ms <ms>] [--campaign-timeout-ms <ms>] [--ci] [--ci-fast-path] [--promote-candidate-id <id>] [--promotion-check-path <path>] [--auto-promote-ready-candidate] [--force-promoted-profile] [--allow-exploratory-wave-profiles]';
