import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateQiGuardrail, getGlobalPipelineState, updateParameters } from '../server/energy-pipeline.js';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const OUT_PATH = path.join('artifacts/research/full-solve', `g4-sensitivity-${DATE_STAMP}.json`);
const INFLUENCE_OUT_PATH = path.join('artifacts/research/full-solve', 'g4-influence-scan-2026-02-26.json');
const SEED = 424242;

type CaseResult = {
  inputs: {
    tau_s: number;
    sampler: string;
    fieldType: string;
    QI_POLICY_MAX_ZETA: number;
    gap_nm?: number;
    casimirModel?: string;
  };
  marginRatioRaw: number | null;
  marginRatioRawComputed: number | null;
  marginRatio: number | null;
  marginRatioDisplay: number | null;
  applicabilityStatus: string;
  applicabilityReasonCode: string | null;
  g4ReasonCodes: string[];
  classification: 'candidate_pass_found' | 'margin_limited' | 'applicability_limited' | 'evidence_path_blocked';
  classificationMismatchReason: string | null;
};

type InfluenceCase = {
  id: string;
  family: string;
  changed: Record<string, unknown>;
};

type InfluenceResult = {
  id: string;
  family: string;
  changed: Record<string, unknown>;
  lhs_Jm3: number | null;
  bound_Jm3: number | null;
  marginRatioRaw: number | null;
  marginRatioRawComputed: number | null;
  applicabilityStatus: string;
  applicabilityReasonCode: string | null;
  rhoSource: string | null;
  metricT00Ref: string | null;
  metricContractOk: boolean | null;
  metricContractStatus: string | null;
  metricDerived: boolean | null;
  metricDerivedSource: string | null;
  metricDerivedReason: string | null;
  absLhsDelta: number | null;
};

const finiteOrNull = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const normalizeDisplay = (n: number | null): number | null => (n == null ? null : Number(n.toPrecision(12)));

export const isMetricRhoSource = (rhoSource: unknown): boolean => {
  const src = String(rhoSource ?? '').toLowerCase();
  return src.startsWith('warp.metric') || src.startsWith('gr.rho_constraint') || src.startsWith('gr.metric');
};

const sortDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => [k, sortDeep((value as Record<string, unknown>)[k])]),
  );
};

const numberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? String(value) : null;
const boolOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

const classifyCanonicalSemantics = (
  marginRaw: number | null,
  applicabilityStatus: string,
): CaseResult['classification'] => {
  if (applicabilityStatus !== 'PASS') return 'applicability_limited';
  if ((marginRaw ?? Number.POSITIVE_INFINITY) >= 1) return 'margin_limited';
  return 'candidate_pass_found';
};

const classifyCase = (
  marginRaw: number | null,
  applicabilityStatus: string,
  reasonCodes: string[],
): { classification: CaseResult['classification']; mismatchReason: string | null } => {
  const canonical = classifyCanonicalSemantics(marginRaw, applicabilityStatus);
  let scanClass: CaseResult['classification'];
  if (reasonCodes.includes('G4_QI_SIGNAL_MISSING')) scanClass = 'evidence_path_blocked';
  else if (reasonCodes.includes('G4_QI_APPLICABILITY_NOT_PASS') || applicabilityStatus !== 'PASS') scanClass = 'applicability_limited';
  else if ((marginRaw ?? Number.POSITIVE_INFINITY) >= 1 || reasonCodes.includes('G4_QI_MARGIN_EXCEEDED')) scanClass = 'margin_limited';
  else scanClass = 'candidate_pass_found';
  const mismatchReason =
    scanClass === canonical
      ? null
      : `canonical=${canonical};scan=${scanClass};applicabilityStatus=${applicabilityStatus};marginRatioRaw=${marginRaw ?? 'null'}`;
  return { classification: scanClass, mismatchReason };
};


const classifyScanAggregate = (args: {
  hasCases: boolean;
  scanCandidatePassFound: boolean;
  scanAnyApplicabilityPass: boolean;
  scanMinMarginRatioRawAmongApplicabilityPass: number | null;
}): CaseResult['classification'] => {
  if (!args.hasCases) return 'evidence_path_blocked';
  if (args.scanCandidatePassFound) return 'candidate_pass_found';
  if (args.scanAnyApplicabilityPass) {
    const minRaw = args.scanMinMarginRatioRawAmongApplicabilityPass ?? Number.POSITIVE_INFINITY;
    return minRaw >= 1 ? 'margin_limited' : 'candidate_pass_found';
  }
  return 'applicability_limited';
};

type GuardSummary = {
  marginRatioRaw?: number | null;
  marginRatioRawComputed?: number | null;
  applicabilityStatus?: string | null;
  applicabilityReasonCode?: string | null;
  rhoSource?: string | null;
};

export const deriveSensitivityReasonCodes = (guard: GuardSummary): string[] => {
  const rawMargin = guard.marginRatioRaw;
  const marginRaw = finiteOrNull(rawMargin);
  const marginUnknownOrNonFinite = typeof rawMargin !== 'number' || !Number.isFinite(rawMargin);
  const applicabilityStatus = String(guard.applicabilityStatus ?? 'UNKNOWN').toUpperCase();
  const applicabilityReason = String(guard.applicabilityReasonCode ?? '').trim().toUpperCase();
  const reasonCodes = new Set<string>();
  if (applicabilityReason) reasonCodes.add(applicabilityReason);
  if (applicabilityStatus !== 'PASS') reasonCodes.add('G4_QI_APPLICABILITY_NOT_PASS');
  if ((marginRaw != null && marginRaw >= 1) || marginUnknownOrNonFinite) reasonCodes.add('G4_QI_MARGIN_EXCEEDED');
  if (!isMetricRhoSource(guard.rhoSource)) reasonCodes.add('G4_QI_SOURCE_NOT_METRIC');
  const order = [
    'G4_QI_SIGNAL_MISSING',
    'G4_QI_CURVATURE_WINDOW_FAIL',
    'G4_QI_APPLICABILITY_NOT_PASS',
    'G4_QI_MARGIN_EXCEEDED',
    'G4_QI_SOURCE_NOT_METRIC',
  ];
  return Array.from(reasonCodes).sort((a, b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    const av = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
    const bv = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
    return av === bv ? a.localeCompare(b) : av - bv;
  });
};

const baseCases = [
  { tau_s: 0.01, sampler: 'gaussian', fieldType: 'em', QI_POLICY_MAX_ZETA: 1 },
  { tau_s: 0.02, sampler: 'hann', fieldType: 'scalar', QI_POLICY_MAX_ZETA: 2 },
  { tau_s: 0.05, sampler: 'gaussian', fieldType: 'em', QI_POLICY_MAX_ZETA: 5 },
  { tau_s: 0.1, sampler: 'boxcar', fieldType: 'em', QI_POLICY_MAX_ZETA: 10 },
] as const;

const secondaryCases = [
  { gap_nm: 0.5, casimirModel: 'ideal_retarded' },
  { gap_nm: 5, casimirModel: 'lifshitz' },
] as const;

export async function runSensitivityCases(
  caseBases = baseCases,
  caseSecondary = secondaryCases,
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  let idx = 0;
  const baseline = structuredClone(getGlobalPipelineState());
  for (const base of caseBases) {
    for (const secondary of caseSecondary) {
      idx += 1;
      const initial = structuredClone(baseline);
      const next = await updateParameters(initial, {
        gap_nm: secondary.gap_nm,
        casimirModel: secondary.casimirModel as any,
        qi: {
          ...(initial.qi ?? {}),
          tau_s_ms: base.tau_s * 1000,
          sampler: base.sampler as any,
          fieldType: base.fieldType as any,
        } as any,
      } as any);
      const guard = evaluateQiGuardrail(next, {
        tau_ms: base.tau_s * 1000,
        sampler: base.sampler as any,
        qiPolicyMaxZeta: base.QI_POLICY_MAX_ZETA,
      });
      const marginRaw = finiteOrNull(guard.marginRatioRaw);
      const marginRawComputed = finiteOrNull((guard as any).marginRatioRawComputed);
      const marginRatio = finiteOrNull(guard.marginRatio);
      const marginRatioDisplay = normalizeDisplay(marginRatio);
      const applicabilityStatus = String(guard.applicabilityStatus ?? 'UNKNOWN').toUpperCase();
      const applicabilityReasonCode =
        typeof guard.applicabilityReasonCode === 'string' && guard.applicabilityReasonCode.trim().length > 0
          ? guard.applicabilityReasonCode.trim().toUpperCase()
          : null;
      const reasonCodes = deriveSensitivityReasonCodes(guard);
      const classificationOutcome = classifyCase(marginRaw, applicabilityStatus, reasonCodes);
      results.push({
        inputs: {
          tau_s: base.tau_s,
          sampler: base.sampler,
          fieldType: base.fieldType,
          QI_POLICY_MAX_ZETA: base.QI_POLICY_MAX_ZETA,
          gap_nm: secondary.gap_nm,
          casimirModel: secondary.casimirModel,
        },
        marginRatioRaw: marginRaw,
        marginRatioRawComputed: marginRawComputed,
        marginRatio,
        marginRatioDisplay,
        applicabilityStatus,
        applicabilityReasonCode,
        g4ReasonCodes: reasonCodes,
        classification: classificationOutcome.classification,
        classificationMismatchReason: classificationOutcome.mismatchReason,
      });
      if (idx >= 8) break;
    }
    if (idx >= 8) break;
  }
  return results;
}

const influenceCases: InfluenceCase[] = [
  { id: 'warpFieldType_natario_sdf', family: 'warpFieldType', changed: { warpFieldType: 'natario_sdf' } },
  { id: 'warpFieldType_irrotational', family: 'warpFieldType', changed: { warpFieldType: 'irrotational' } },
  { id: 'gammaGeo_low', family: 'gammaGeo', changed: { gammaGeo: 4 } },
  { id: 'gammaGeo_high', family: 'gammaGeo', changed: { gammaGeo: 120 } },
  { id: 'duty_low', family: 'duty', changed: { dutyCycle: 0.02, dutyShip: 0.02, dutyEffective_FR: 0.02 } },
  { id: 'duty_high', family: 'duty', changed: { dutyCycle: 0.45, dutyShip: 0.45, dutyEffective_FR: 0.45 } },
  { id: 'gammaVdB_low', family: 'gammaVanDenBroeck', changed: { gammaVanDenBroeck: 0.8 } },
  { id: 'gammaVdB_high', family: 'gammaVanDenBroeck', changed: { gammaVanDenBroeck: 2000 } },
  { id: 'qCavity_low', family: 'qCavity', changed: { qCavity: 1e7 } },
  { id: 'qCavity_high', family: 'qCavity', changed: { qCavity: 1e12 } },
  { id: 'qSpoiling_low', family: 'qSpoilingFactor', changed: { qSpoilingFactor: 0.2 } },
  { id: 'qSpoiling_high', family: 'qSpoilingFactor', changed: { qSpoilingFactor: 4 } },
  { id: 'gap_tight_nm', family: 'gap_nm', changed: { gap_nm: 0.4 } },
  { id: 'gap_wide_nm', family: 'gap_nm', changed: { gap_nm: 8 } },
  { id: 'bubbleRadius_small', family: 'bubbleRadius_m', changed: { bubble: { R: 2 }, R: 2 } },
  { id: 'bubbleRadius_large', family: 'bubbleRadius_m', changed: { bubble: { R: 40 }, R: 40 } },
];

export async function runInfluenceScan(): Promise<{ baseline: InfluenceResult; rankedEffects: InfluenceResult[] }> {
  const baselineState = await updateParameters(structuredClone(getGlobalPipelineState()), {} as any);
  const baselineGuard = evaluateQiGuardrail(baselineState);
  const baselineAbs = Math.abs(numberOrNull(baselineGuard.lhs_Jm3) ?? 0);

  const toResult = (id: string, family: string, changed: Record<string, unknown>, state: any, guard: any): InfluenceResult => {
    const lhs = numberOrNull(guard.lhs_Jm3);
    const absLhs = lhs == null ? null : Math.abs(lhs);
    return {
      id,
      family,
      changed,
      lhs_Jm3: lhs,
      bound_Jm3: numberOrNull(guard.bound_Jm3),
      marginRatioRaw: numberOrNull(guard.marginRatioRaw),
      marginRatioRawComputed: numberOrNull((guard as any).marginRatioRawComputed),
      applicabilityStatus: String(guard.applicabilityStatus ?? 'UNKNOWN').toUpperCase(),
      applicabilityReasonCode: stringOrNull(guard.applicabilityReasonCode)?.toUpperCase() ?? null,
      rhoSource: stringOrNull(guard.rhoSource),
      metricT00Ref: stringOrNull((state as any)?.warp?.metricT00Ref ?? (state as any)?.metricT00Ref),
      metricContractOk: boolOrNull(guard.metricContractOk),
      metricContractStatus: stringOrNull((state as any)?.warp?.metricT00Contract?.status ?? (state as any)?.warp?.metricT00ContractStatus),
      metricDerived: boolOrNull(guard.metricDerived),
      metricDerivedSource: stringOrNull(guard.metricDerivedSource),
      metricDerivedReason: stringOrNull(guard.metricDerivedReason),
      absLhsDelta: absLhs == null ? null : absLhs - baselineAbs,
    };
  };

  const baseline = toResult('baseline', 'baseline', {}, baselineState as any, baselineGuard as any);
  const effects: InfluenceResult[] = [];
  for (const scanCase of influenceCases) {
    const next = await updateParameters(structuredClone(getGlobalPipelineState()), scanCase.changed as any);
    const guard = evaluateQiGuardrail(next);
    effects.push(toResult(scanCase.id, scanCase.family, scanCase.changed, next as any, guard as any));
  }
  effects.sort((a, b) => (a.absLhsDelta ?? Number.POSITIVE_INFINITY) - (b.absLhsDelta ?? Number.POSITIVE_INFINITY));
  return { baseline, rankedEffects: effects };
}

export async function run() {
  const results = await runSensitivityCases();
  const influence = await runInfluenceScan();
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const mismatches = results.filter((entry) => entry.classificationMismatchReason != null);
  const payload = {
    runId: `g4-sensitivity-${SEED}-${DATE_STAMP}`,
    seed: SEED,
    generatedAt: new Date().toISOString(),
    cases: results,
    parity: {
      canonicalSemantics: 'classification=applicability_limited when applicabilityStatus!=PASS; else margin_limited when marginRatioRaw>=1; else candidate_pass_found',
      mismatchCount: mismatches.length,
      mismatchReasons: mismatches.map((entry) => entry.classificationMismatchReason),
    },
  };
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(sortDeep(payload), null, 2)}\n`);
  const scanCandidatePassFound = influence.rankedEffects.some(
    (entry) => entry.applicabilityStatus === 'PASS' && (entry.marginRatioRaw ?? Number.POSITIVE_INFINITY) < 1,
  );
  const scanAnyApplicabilityPass = influence.rankedEffects.some((entry) => entry.applicabilityStatus === 'PASS');
  const passMargins = influence.rankedEffects
    .filter((entry) => entry.applicabilityStatus === 'PASS')
    .map((entry) => entry.marginRatioRaw)
    .filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry));
  const scanMinMarginRatioRawAmongApplicabilityPass =
    passMargins.length > 0 ? Math.min(...passMargins) : null;
  const scanDecisionClass = classifyScanAggregate({
    hasCases: influence.rankedEffects.length > 0,
    scanCandidatePassFound,
    scanAnyApplicabilityPass,
    scanMinMarginRatioRawAmongApplicabilityPass,
  });
  const influencePayload = {
    runId: `g4-influence-scan-${SEED}-2026-02-26`,
    seed: SEED,
    generatedAt: new Date().toISOString(),
    baseline: influence.baseline,
    rankedEffects: influence.rankedEffects,
    decision: {
      classification: scanDecisionClass,
      scanCandidatePassFound,
      scanAnyApplicabilityPass,
      scanMinMarginRatioRawAmongApplicabilityPass,
    },
  };
  fs.writeFileSync(INFLUENCE_OUT_PATH, `${JSON.stringify(sortDeep(influencePayload), null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, out: OUT_PATH, influenceOut: INFLUENCE_OUT_PATH, cases: results.length }));
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
