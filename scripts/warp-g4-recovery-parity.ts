import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { evaluateQiGuardrail, getGlobalPipelineState, updateParameters } from '../server/energy-pipeline.js';

const DATE_STAMP = '2026-02-27';
const DEFAULT_TOP_N = 5;
const RECOVERY_PATH = path.join('artifacts', 'research', 'full-solve', `g4-recovery-search-${DATE_STAMP}.json`);
const OUT_PATH = path.join('artifacts', 'research', 'full-solve', `g4-recovery-parity-${DATE_STAMP}.json`);
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const finiteOrNull = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const LEGACY_RADIUS_KEY = `${'shipRadius'}_m` as const;
const resolveBubbleRadiusParam = (params: Record<string, unknown>): number | null =>
  finiteOrNull(params.bubbleRadius_m ?? params[LEGACY_RADIUS_KEY]);
const str = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? 'UNKNOWN'));
const boolOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
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
const numEq = (a: number | null, b: number | null, absEps = 1e-12, relEps = 1e-9) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const diff = Math.abs(a - b);
  if (diff <= absEps) return true;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return diff <= relEps * scale;
};


type ComparabilityClass =
  | 'comparable_canonical'
  | 'comparable_structural_semantic_gap'
  | 'non_comparable_missing_signals'
  | 'non_comparable_contract_mismatch'
  | 'non_comparable_other';

const COMPARABILITY_CLASSES: ComparabilityClass[] = [
  'comparable_canonical',
  'comparable_structural_semantic_gap',
  'non_comparable_missing_signals',
  'non_comparable_contract_mismatch',
  'non_comparable_other',
];

const classifyComparability = (entry: any): ComparabilityClass => {
  const existing = typeof entry?.comparabilityClass === 'string' ? entry.comparabilityClass : null;
  if (existing && COMPARABILITY_CLASSES.includes(existing as ComparabilityClass)) {
    return existing as ComparabilityClass;
  }
  const required = [entry?.lhs_Jm3, entry?.boundComputed_Jm3, entry?.boundUsed_Jm3, entry?.marginRatioRaw, entry?.marginRatioRawComputed];
  if (required.some((value) => !Number.isFinite(value))) return 'non_comparable_missing_signals';
  const reasonCode = Array.isArray(entry?.reasonCode) ? entry.reasonCode.map((code: unknown) => str(code).toUpperCase()) : [];
  // Comparability excludes only missing structural signals and contract/source mismatches.
  // Applicability reasons are preserved as diagnostics and parity failure modes.
  if (reasonCode.includes('G4_QI_SOURCE_NOT_METRIC') || reasonCode.includes('G4_QI_CONTRACT_MISSING')) {
    return 'non_comparable_contract_mismatch';
  }
  if (!str(entry?.rhoSource).startsWith('warp.metric')) return 'non_comparable_contract_mismatch';
  const semanticType = typeof entry?.quantitySemanticType === 'string' ? entry.quantitySemanticType : null;
  const semanticTargetType = typeof entry?.quantitySemanticTargetType === 'string' ? entry.quantitySemanticTargetType : null;
  const worldlineClass = typeof entry?.quantityWorldlineClass === 'string' ? entry.quantityWorldlineClass : null;
  const semanticBridgeReady = typeof entry?.quantitySemanticBridgeReady === 'boolean' ? entry.quantitySemanticBridgeReady : null;
  const canonicalSemanticComparable =
    (semanticBridgeReady === true) ||
    (typeof entry?.quantitySemanticComparable === 'boolean'
      ? entry.quantitySemanticComparable
      : semanticType === 'ren_expectation_timelike_energy_density' && worldlineClass === 'timelike');
  if (canonicalSemanticComparable) return 'comparable_canonical';
  const structuralSemanticComparable =
    worldlineClass === 'timelike' &&
    (semanticBridgeReady === false ||
      (semanticType === 'classical_proxy_from_curvature' && semanticTargetType === 'ren_expectation_timelike_energy_density'));
  if (structuralSemanticComparable) return 'comparable_structural_semantic_gap';
  if (!canonicalSemanticComparable) return 'non_comparable_other';
  return 'comparable_canonical';
};

type SelectionPolicy =
  | 'comparable_canonical'
  | 'comparable_structural_semantic_gap'
  | 'fallback_no_canonical_structural_comparable';

type MismatchReason =
  | 'none'
  | 'applicability_status_mismatch'
  | 'margin_ratio_raw_mismatch'
  | 'margin_ratio_raw_computed_mismatch'
  | 'bound_computed_mismatch'
  | 'bound_used_mismatch'
  | 'bound_floor_applied_mismatch';

const classifyMismatch = (scan: any, parity: any): { parityStatus: 'match' | 'mismatch'; mismatchReason: MismatchReason } => {
  if (scan.applicabilityStatus !== parity.applicabilityStatus) {
    return { parityStatus: 'mismatch', mismatchReason: 'applicability_status_mismatch' };
  }
  if (!numEq(scan.marginRatioRaw, parity.marginRatioRaw)) {
    return { parityStatus: 'mismatch', mismatchReason: 'margin_ratio_raw_mismatch' };
  }
  if (!numEq(scan.marginRatioRawComputed, parity.marginRatioRawComputed)) {
    return { parityStatus: 'mismatch', mismatchReason: 'margin_ratio_raw_computed_mismatch' };
  }
  if (!numEq(scan.boundComputed_Jm3, parity.boundComputed_Jm3)) {
    return { parityStatus: 'mismatch', mismatchReason: 'bound_computed_mismatch' };
  }
  if (!numEq(scan.boundUsed_Jm3, parity.boundUsed_Jm3)) {
    return { parityStatus: 'mismatch', mismatchReason: 'bound_used_mismatch' };
  }
  if (scan.boundFloorApplied != null && scan.boundFloorApplied !== parity.boundFloorApplied) {
    return { parityStatus: 'mismatch', mismatchReason: 'bound_floor_applied_mismatch' };
  }
  return { parityStatus: 'match', mismatchReason: 'none' };
};

const dominantFailureMode = (rows: any[]): 'applicability_limited' | 'margin_limited' | 'policy_floor_dominated' | 'evidence_path_blocked' => {
  if (rows.length === 0) return 'evidence_path_blocked';
  const applicabilityLimited = rows.every((row) => row.parity.applicabilityStatus !== 'PASS');
  if (applicabilityLimited) return 'applicability_limited';

  const anyPolicyFloorDominated = rows.some(
    (row) => row.parity.applicabilityStatus === 'PASS' && row.parity.boundFloorApplied === true && (row.parity.marginRatioRawComputed ?? Infinity) < 1,
  );
  if (anyPolicyFloorDominated) return 'policy_floor_dominated';

  const anyMarginLimited = rows.some(
    (row) => row.parity.applicabilityStatus === 'PASS' && (row.parity.marginRatioRaw ?? Infinity) >= 1 && (row.parity.marginRatioRawComputed ?? Infinity) >= 1,
  );
  if (anyMarginLimited) return 'margin_limited';

  return 'evidence_path_blocked';
};

export async function runRecoveryParity(opts: { topN?: number; recoveryPath?: string; outPath?: string } = {}) {
  const topN = Math.max(1, Math.floor(Number(opts.topN ?? DEFAULT_TOP_N)));
  const recoveryPath = opts.recoveryPath ?? RECOVERY_PATH;
  const outPath = opts.outPath ?? OUT_PATH;
  const headCommitHash = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

  const recovery = JSON.parse(fs.readFileSync(recoveryPath, 'utf8')) as any;
  const recoveryCommitHash = typeof recovery?.provenance?.commitHash === 'string' ? recovery.provenance.commitHash : null;
  const candidatePool = Array.isArray(recovery?.topComparableCandidates) && recovery.topComparableCandidates.length > 0
    ? recovery.topComparableCandidates
    : Array.isArray(recovery?.cases)
      ? recovery.cases
          .sort((a: any, b: any) => {
            const aRawComputed = finiteOrNull(a?.marginRatioRawComputed) ?? Number.POSITIVE_INFINITY;
            const bRawComputed = finiteOrNull(b?.marginRatioRawComputed) ?? Number.POSITIVE_INFINITY;
            if (aRawComputed !== bRawComputed) return aRawComputed - bRawComputed;
            return str(a?.id).localeCompare(str(b?.id));
          })
      : [];
  const canonicalCandidates = candidatePool.filter((entry: any) => classifyComparability(entry) === 'comparable_canonical');
  const structuralGapCandidates = candidatePool.filter(
    (entry: any) => classifyComparability(entry) === 'comparable_structural_semantic_gap',
  );

  const selectionPolicy: SelectionPolicy =
    canonicalCandidates.length > 0
      ? 'comparable_canonical'
      : structuralGapCandidates.length > 0
        ? 'comparable_structural_semantic_gap'
        : 'fallback_no_canonical_structural_comparable';
  const blockedReason =
    selectionPolicy === 'fallback_no_canonical_structural_comparable'
      ? 'no_canonical_structural_comparable_candidates'
      : null;
  const selectedSource =
    selectionPolicy === 'comparable_canonical'
      ? canonicalCandidates
      : selectionPolicy === 'comparable_structural_semantic_gap'
        ? structuralGapCandidates
        : [];
  const selected = selectedSource.slice(0, topN);
  const baseline = structuredClone(getGlobalPipelineState());
  const rows: any[] = [];

  for (const entry of selected) {
    const params = entry?.params ?? {};
    const bubbleRadius = resolveBubbleRadiusParam(params);
    const next = await updateParameters(structuredClone(baseline), {
      warpFieldType: params.warpFieldType,
      gammaGeo: params.gammaGeo,
      dutyCycle: params.dutyCycle,
      dutyShip: params.dutyShip,
      dutyEffective_FR: params.dutyEffective_FR,
      sectorCount: params.sectorCount,
      concurrentSectors: params.concurrentSectors,
      gammaVanDenBroeck: params.gammaVanDenBroeck,
      qCavity: params.qCavity,
      qSpoilingFactor: params.qSpoilingFactor,
      gap_nm: params.gap_nm,
      ...(bubbleRadius != null
        ? {
            bubble: { R: bubbleRadius },
            R: bubbleRadius,
          }
        : {}),
      qi: {
        ...(baseline.qi ?? {}),
        sampler: params.sampler,
        fieldType: params.fieldType,
        tau_s_ms: params.tau_s_ms,
      },
    } as any);
    const guard = evaluateQiGuardrail(ensureRecoveryCurvatureSignals(next as any), {
      sampler: params.sampler,
      tau_ms: Number(params.tau_s_ms),
    });

    const scan = {
      applicabilityStatus: str(entry?.applicabilityStatus).toUpperCase(),
      marginRatioRaw: finiteOrNull(entry?.marginRatioRaw),
      marginRatioRawComputed: finiteOrNull(entry?.marginRatioRawComputed),
      boundComputed_Jm3: finiteOrNull(entry?.boundComputed_Jm3),
      boundUsed_Jm3: finiteOrNull(entry?.boundUsed_Jm3),
      boundFloorApplied: boolOrNull(entry?.boundFloorApplied),
    };
    const parity = {
      applicabilityStatus: str(guard?.applicabilityStatus).toUpperCase(),
      marginRatioRaw: finiteOrNull(guard?.marginRatioRaw),
      marginRatioRawComputed: finiteOrNull(guard?.marginRatioRawComputed),
      lhs_Jm3: finiteOrNull(guard?.lhs_Jm3),
      boundComputed_Jm3: finiteOrNull(guard?.boundComputed_Jm3),
      boundUsed_Jm3: finiteOrNull(guard?.boundUsed_Jm3),
      boundPolicyFloor_Jm3: finiteOrNull(guard?.boundPolicyFloor_Jm3),
      boundDefaultFloor_Jm3: finiteOrNull(guard?.boundDefaultFloor_Jm3),
      boundEnvFloor_Jm3: finiteOrNull(guard?.boundEnvFloor_Jm3),
      boundFloorApplied: Boolean(guard?.boundFloorApplied),
      metricT00Geom: finiteOrNull(guard?.metricT00Geom),
      metricT00Si: finiteOrNull(guard?.metricT00Si),
      metricT00SiFromGeom: finiteOrNull(guard?.metricT00SiFromGeom),
      metricT00SiRelError: finiteOrNull(guard?.metricT00SiRelError),
    };

    const parityResolution = classifyMismatch(scan, parity);
    rows.push({
      id: str(entry?.id),
      params,
      scan,
      parity,
      parityStatus: parityResolution.parityStatus,
      mismatchReason: parityResolution.mismatchReason,
      comparabilityClass: classifyComparability(entry),
    });
  }

  const anyCanonicalPassCandidate = rows.some(
    (row) => row.parity.applicabilityStatus === 'PASS' && (row.parity.marginRatioRaw ?? Number.POSITIVE_INFINITY) < 1,
  );
  const anyComputedOnlyPassCandidate = rows.some(
    (row) => row.parity.applicabilityStatus === 'PASS' && (row.parity.marginRatioRawComputed ?? Number.POSITIVE_INFINITY) < 1,
  );


  const comparabilityCountSource = Array.isArray(recovery?.cases)
    ? recovery.cases
    : Array.isArray(recovery?.topComparableCandidates)
      ? recovery.topComparableCandidates
      : [];
  const comparabilityCounts = comparabilityCountSource.reduce<Record<ComparabilityClass, number>>(
    (acc, row: any) => {
      const klass = classifyComparability(row);
      acc[klass] += 1;
      return acc;
    },
    {
      comparable_canonical: 0,
      comparable_structural_semantic_gap: 0,
      non_comparable_missing_signals: 0,
      non_comparable_contract_mismatch: 0,
      non_comparable_other: 0,
    },
  );

  const payload = {
    runId: `g4-recovery-parity-${DATE_STAMP}`,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    recoveryArtifactPath: recoveryPath,
    topN,
    candidateCountChecked: rows.length,
    selectionPolicy,
    blockedReason,
    anyCanonicalPassCandidate,
    anyComputedOnlyPassCandidate,
    dominantFailureMode: dominantFailureMode(rows),
    comparability: {
      canonicalComparableCaseCount: comparabilityCounts.comparable_canonical,
      canonicalStructuralComparableCaseCount:
        comparabilityCounts.comparable_canonical + comparabilityCounts.comparable_structural_semantic_gap,
      nonComparableCaseCount:
        comparabilityCounts.non_comparable_missing_signals +
        comparabilityCounts.non_comparable_contract_mismatch +
        comparabilityCounts.non_comparable_other,
      semanticGapCaseCount: comparabilityCounts.comparable_structural_semantic_gap,
      nonComparableBuckets: {
        non_comparable_missing_signals: comparabilityCounts.non_comparable_missing_signals,
        non_comparable_contract_mismatch: comparabilityCounts.non_comparable_contract_mismatch,
        non_comparable_other: comparabilityCounts.non_comparable_other,
      },
    },
    selectionPool: {
      canonicalComparableCandidateCount: canonicalCandidates.length,
      structuralSemanticGapCandidateCount: structuralGapCandidates.length,
    },
    provenance: {
      commitHash: headCommitHash,
      recoveryProvenanceCommitHash: recoveryCommitHash,
      recoveryProvenanceFresh: recoveryCommitHash != null && recoveryCommitHash === headCommitHash,
    },
    candidates: rows,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  return {
    ok: true,
    outPath,
    candidateCountChecked: rows.length,
    selectionPolicy,
    blockedReason,
    anyCanonicalPassCandidate,
    anyComputedOnlyPassCandidate,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRecoveryParity()
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
