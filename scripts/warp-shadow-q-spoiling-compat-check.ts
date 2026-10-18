import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_SCENARIO_PATH = path.join('configs', 'warp-shadow-injection-scenarios.qs-primary-typed.v1.json');
const DEFAULT_RUN_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  `shadow-injection-run-qs-primary-typed-${DATE_STAMP}.json`,
);
const DEFAULT_REGISTRY_PATH = path.join(
  'docs',
  'specs',
  'casimir-tile-experimental-parameter-registry-2026-03-04.md',
);
const DEFAULT_OUT_JSON = path.join('artifacts', 'research', 'full-solve', `qs-compat-check-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-qs-compat-check-${DATE_STAMP}.md`);

const MECHANISM_LANES = ['hydride_q_disease', 'trapped_flux', 'tls_oxide'] as const;
type MechanismLane = (typeof MECHANISM_LANES)[number];

type RegistryRow = {
  entry_id: string;
  value: string;
};

type MechanismThresholds = {
  mechanismLane: MechanismLane;
  q0_clean_floor: number;
  q0_spoiled_ceiling: number;
  f_q_spoil_floor: number;
  thresholdDerivation?: string;
  sourceRefs?: string[];
};

type Scenario = {
  id: string;
  lane: string;
  registryRefs?: string[];
  experimentalContext?: {
    qSpoiling?: {
      mechanismLane?: MechanismLane;
      q0Baseline?: number;
      f_q_spoil?: number;
      q0Spoiled?: number;
      q_spoil_ratio?: number;
      q_spoil_ratio_anchor?: string;
      sourceRefs?: string[];
      thresholds?: MechanismThresholds;
      uncertainty?: {
        u_q0_rel?: number;
        u_f_rel?: number;
        method?: string;
        reportableReady?: boolean;
        blockedReasons?: string[];
        sourceRefs?: string[];
      };
    };
  };
};

type ScenarioPack = {
  scenarios: Scenario[];
  thresholdsByMechanism?: Partial<Record<MechanismLane, MechanismThresholds>>;
};

type RunResult = {
  id: string;
  classification: 'compatible' | 'partial' | 'incompatible' | 'error';
  guard?: {
    congruentSolvePass?: boolean;
  } | null;
};

type RunPayload = {
  results?: RunResult[];
};

type Congruence = 'congruent' | 'incongruent' | 'unknown';
type ReducedReasonCategory =
  | 'missing_anchor_or_context'
  | 'missing_uncertainty_anchor'
  | 'threshold_violation'
  | 'uncertainty_edge_overlap'
  | 'source_admissibility'
  | 'reportable_contract'
  | 'other';

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const parseNumberCandidates = (raw: string): number[] => {
  const matches = String(raw).match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi);
  if (!matches) return [];
  return matches.map((token) => Number(token)).filter((value) => Number.isFinite(value));
};

const reduceReasonCode = (reasonCode: string): ReducedReasonCategory => {
  const code = String(reasonCode ?? '').trim().toLowerCase();
  if (!code) return 'other';
  if (code.includes('missing_numeric_uncertainty_anchor') || code.startsWith('missing_u_')) {
    return 'missing_uncertainty_anchor';
  }
  if (code.startsWith('missing_')) return 'missing_anchor_or_context';
  if (
    code.includes('below_floor') ||
    code.includes('above_ceiling') ||
    code.includes('exceeds_profile') ||
    code.includes('outside')
  ) {
    return 'threshold_violation';
  }
  if (code.includes('edge_uncertainty_overlap')) return 'uncertainty_edge_overlap';
  if (code.includes('source_class_not_allowed') || code.includes('strict_scope_ref_not_admissible')) {
    return 'source_admissibility';
  }
  if (code.includes('reportable_not_ready') || code.includes('reportable_ready_with_blocked_reasons')) {
    return 'reportable_contract';
  }
  return 'other';
};

const finiteOrNull = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
      value: cells[3],
    });
  }
  return rows;
};

const getThresholdsFromRegistry = (rows: RegistryRow[]): Record<MechanismLane, MechanismThresholds> => {
  const byId = new Map(rows.map((row) => [row.entry_id.toUpperCase(), row]));
  const valueOf = (id: string, fallback: number): number => {
    const values = parseNumberCandidates(byId.get(id)?.value ?? '').filter((value) => value > 0);
    return values.length > 0 ? values[0] : fallback;
  };

  const hydrideClean = valueOf('EXP-Q-001', 2e10);
  const hydrideSpoiled = valueOf('EXP-Q-002', 1e9);

  const fluxClean = valueOf('EXP-Q-003', hydrideClean);
  const fluxLow = valueOf('EXP-Q-004', 0.9);
  const fluxHigh = valueOf('EXP-Q-005', 3.9);
  const fluxFloor = Math.max(1, fluxHigh / Math.max(fluxLow, 1e-9));

  const tlsClean = hydrideClean;
  const ecValues = parseNumberCandidates(byId.get('EXP-Q-014')?.value ?? '').filter((value) => value > 0);
  const betaValues = parseNumberCandidates(byId.get('EXP-Q-015')?.value ?? '').filter((value) => value > 0);
  const ecFloor = ecValues.length >= 2 ? Math.max(ecValues[1] / Math.max(ecValues[0], 1e-9), 1) : 1;
  const betaFloor = betaValues.length >= 2 ? Math.max(betaValues[1] / Math.max(betaValues[0], 1e-9), 1) : 1;
  const tlsFloor = Math.max(ecFloor, betaFloor, 1);

  return {
    hydride_q_disease: {
      mechanismLane: 'hydride_q_disease',
      q0_clean_floor: hydrideClean,
      q0_spoiled_ceiling: hydrideSpoiled,
      f_q_spoil_floor: hydrideClean / hydrideSpoiled,
      thresholdDerivation: 'registry_fallback_hydride_exp_q_001_002',
      sourceRefs: ['EXP-Q-001', 'EXP-Q-002'],
    },
    trapped_flux: {
      mechanismLane: 'trapped_flux',
      q0_clean_floor: fluxClean,
      q0_spoiled_ceiling: fluxClean / fluxFloor,
      f_q_spoil_floor: fluxFloor,
      thresholdDerivation: 'registry_fallback_flux_exp_q_003_004_005',
      sourceRefs: ['EXP-Q-003', 'EXP-Q-004', 'EXP-Q-005'],
    },
    tls_oxide: {
      mechanismLane: 'tls_oxide',
      q0_clean_floor: tlsClean,
      q0_spoiled_ceiling: tlsClean / tlsFloor,
      f_q_spoil_floor: tlsFloor,
      thresholdDerivation: 'registry_fallback_tls_exp_q_014_015',
      sourceRefs: ['EXP-Q-001', 'EXP-Q-014', 'EXP-Q-015'],
    },
  };
};

const laneRequiredAnchors: Record<MechanismLane, string[]> = {
  hydride_q_disease: ['EXP-Q-001', 'EXP-Q-002', 'EXP-Q-020'],
  trapped_flux: ['EXP-Q-003', 'EXP-Q-004', 'EXP-Q-005', 'EXP-Q-021'],
  tls_oxide: ['EXP-Q-001', 'EXP-Q-014', 'EXP-Q-015', 'EXP-Q-022'],
};

const evaluateCongruence = (input: {
  refs: string[];
  mechanismLane: MechanismLane | null;
  q0Baseline: number | null;
  q0Spoiled: number | null;
  qSpoilRatio: number | null;
  fQSpool: number | null;
  uQ0Rel: number;
  uFRel: number;
  thresholds: MechanismThresholds;
}): { evidenceCongruence: Congruence; reasonCodes: string[] } => {
  const reasons: string[] = [];
  if (!input.mechanismLane) reasons.push('missing_mechanism_lane');

  if (input.mechanismLane) {
    for (const requiredRef of laneRequiredAnchors[input.mechanismLane]) {
      if (!input.refs.includes(requiredRef)) reasons.push(`missing_mechanism_anchor:${requiredRef}`);
    }
  }

  if (input.q0Baseline == null || input.q0Spoiled == null || input.fQSpool == null) reasons.push('missing_q_context_fields');

  const computedRatio =
    input.q0Baseline != null && input.q0Spoiled != null && input.q0Spoiled > 0
      ? input.q0Baseline / input.q0Spoiled
      : null;
  const ratio = input.qSpoilRatio ?? computedRatio;
  if (ratio == null || !Number.isFinite(ratio) || ratio <= 0) {
    reasons.push('missing_q_spoil_ratio_anchor');
  } else if (input.qSpoilRatio != null && computedRatio != null) {
    const relDiff = Math.abs(input.qSpoilRatio - computedRatio) / Math.max(Math.abs(computedRatio), Number.EPSILON);
    if (relDiff > 0.02) {
      return { evidenceCongruence: 'incongruent', reasonCodes: ['q_spoil_ratio_anchor_mismatch'] };
    }
  }

  if (reasons.length > 0) return { evidenceCongruence: 'unknown', reasonCodes: reasons };

  const mechanismLane = input.mechanismLane as MechanismLane;
  const q0Baseline = input.q0Baseline as number;
  const q0Spoiled = input.q0Spoiled as number;
  const fQSpool = input.fQSpool as number;
  const uQ0 = Math.max(0.01, input.uQ0Rel);
  const uF = Math.max(0.01, input.uFRel);

  const q0MinStrict = input.thresholds.q0_clean_floor * (1 + uQ0);
  const q0MinExpanded = input.thresholds.q0_clean_floor * (1 - uQ0);
  const q0SpoiledMaxStrict = input.thresholds.q0_spoiled_ceiling * (1 - uQ0);
  const q0SpoiledMaxExpanded = input.thresholds.q0_spoiled_ceiling * (1 + uQ0);
  const fMinStrict = input.thresholds.f_q_spoil_floor * (1 + uF);
  const fMinExpanded = input.thresholds.f_q_spoil_floor * (1 - uF);

  const localReasons: string[] = [];
  let hasUnknownBand = false;

  if (q0Baseline >= q0MinStrict) {
    // strict pass
  } else if (q0Baseline >= q0MinExpanded) {
    hasUnknownBand = true;
  } else {
    localReasons.push(`q0_baseline_below_floor:${mechanismLane}`);
  }

  if (q0Spoiled <= q0SpoiledMaxStrict) {
    // strict pass
  } else if (q0Spoiled <= q0SpoiledMaxExpanded) {
    hasUnknownBand = true;
  } else {
    localReasons.push(`q0_spoiled_above_ceiling:${mechanismLane}`);
  }

  if (fQSpool >= fMinStrict) {
    // strict pass
  } else if (fQSpool >= fMinExpanded) {
    hasUnknownBand = true;
  } else {
    localReasons.push(`f_q_spoil_below_floor:${mechanismLane}`);
  }

  if (localReasons.length > 0) return { evidenceCongruence: 'incongruent', reasonCodes: localReasons };
  if (hasUnknownBand) return { evidenceCongruence: 'unknown', reasonCodes: [`edge_uncertainty_overlap:${mechanismLane}`] };
  return { evidenceCongruence: 'congruent', reasonCodes: [] };
};

const renderMarkdown = (payload: any): string => {
  const reasonRows =
    Object.entries(payload.summary.reasonCounts as Record<string, number>)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => `| ${reason} | ${count} |`)
      .join('\n') || '| n/a | 0 |';

  const mechanismRows =
    Object.entries(payload.summary.byMechanism as Record<string, { congruent: number; incongruent: number; unknown: number }>)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([mechanism, counts]) => `| ${mechanism} | ${counts.congruent} | ${counts.incongruent} | ${counts.unknown} |`)
      .join('\n') || '| n/a | 0 | 0 | 0 |';

  const scenarioRows =
    (payload.scenarioChecks as Array<any>)
      .map(
        (row) =>
          `| ${row.id} | ${row.mechanismLane ?? 'n/a'} | ${row.q0Baseline ?? 'n/a'} | ${row.q0Spoiled ?? 'n/a'} | ${row.q_spoil_ratio ?? 'n/a'} | ${row.f_q_spoil ?? 'n/a'} | ${row.q0CleanFloor ?? 'n/a'} | ${row.q0SpoiledCeiling ?? 'n/a'} | ${row.fQSpoolFloor ?? 'n/a'} | ${row.u_q0_rel ?? 'n/a'} | ${row.u_f_rel ?? 'n/a'} | ${row.evidenceCongruence} | ${row.runClassification ?? 'n/a'} | ${row.reasonCodes.join(', ') || 'none'} |`,
      )
      .join('\n') || '| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unknown | n/a | n/a |';

  return `# Q-Spoiling Compatibility Check (${payload.generatedOn})

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

## Mechanism Summary
| mechanism_lane | congruent | incongruent | unknown |
|---|---:|---:|---:|
${mechanismRows}

## Scenario Checks
| scenario_id | mechanism_lane | q0_baseline | q0_spoiled | q_spoil_ratio | f_q_spoil | q0_clean_floor | q0_spoiled_ceiling | f_q_spoil_floor | u_q0_rel | u_f_rel | evidence_congruence | run_classification | reasons |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|
${scenarioRows}

## Dominant Reasons
| reason | count |
|---|---:|
${reasonRows}
`;
};

const coerceMechanismLane = (value: unknown): MechanismLane | null => {
  const normalized = String(value ?? '').trim().toLowerCase();
  return MECHANISM_LANES.includes(normalized as MechanismLane) ? (normalized as MechanismLane) : null;
};

const getScenarioThresholds = (
  scenario: Scenario,
  packThresholds: Partial<Record<MechanismLane, MechanismThresholds>>,
  fallbackThresholds: Record<MechanismLane, MechanismThresholds>,
): MechanismThresholds => {
  const mechanismLane = coerceMechanismLane(scenario.experimentalContext?.qSpoiling?.mechanismLane) ?? 'hydride_q_disease';
  const embedded = scenario.experimentalContext?.qSpoiling?.thresholds;
  if (embedded && Number.isFinite(embedded.q0_clean_floor) && Number.isFinite(embedded.f_q_spoil_floor)) {
    return embedded;
  }
  const fromPack = packThresholds[mechanismLane];
  if (fromPack && Number.isFinite(fromPack.q0_clean_floor) && Number.isFinite(fromPack.f_q_spoil_floor)) {
    return fromPack;
  }
  return fallbackThresholds[mechanismLane];
};

export const runQSpoilingCompatCheck = (options: {
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
  const fallbackThresholds = getThresholdsFromRegistry(registryRows);
  const packThresholds = scenarioPack.thresholdsByMechanism ?? {};
  const runById = new Map((runPayload.results ?? []).map((row) => [row.id, row]));

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
  const byMechanism: Record<string, { congruent: number; incongruent: number; unknown: number }> = {};

  const scenarioChecks = scenarioPack.scenarios.map((scenario) => {
    const refs = (scenario.registryRefs ?? []).map((ref) => ref.trim().toUpperCase());
    const qContext = scenario.experimentalContext?.qSpoiling;
    const mechanismLane = coerceMechanismLane(qContext?.mechanismLane);
    const thresholds = getScenarioThresholds(scenario, packThresholds, fallbackThresholds);

    const q0Baseline = finiteOrNull(qContext?.q0Baseline);
    const q0Spoiled = finiteOrNull(qContext?.q0Spoiled);
    const qSpoilRatio = finiteOrNull(qContext?.q_spoil_ratio);
    const fQSpool = finiteOrNull(qContext?.f_q_spoil);
    const uQ0Rel = finiteOrNull(qContext?.uncertainty?.u_q0_rel) ?? 0.3;
    const uFRel = finiteOrNull(qContext?.uncertainty?.u_f_rel) ?? 0.3;

    const evaluation = evaluateCongruence({
      refs,
      mechanismLane,
      q0Baseline,
      q0Spoiled,
      qSpoilRatio,
      fQSpool,
      uQ0Rel,
      uFRel,
      thresholds,
    });

    for (const reason of evaluation.reasonCodes) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
      const reduced = reduceReasonCode(reason);
      reducedReasonCounts[reduced] = (reducedReasonCounts[reduced] ?? 0) + 1;
    }

    const mechanismKey = mechanismLane ?? 'unknown';
    if (!byMechanism[mechanismKey]) byMechanism[mechanismKey] = { congruent: 0, incongruent: 0, unknown: 0 };
    byMechanism[mechanismKey][evaluation.evidenceCongruence] += 1;

    const runResult = runById.get(scenario.id);
    return {
      id: scenario.id,
      lane: scenario.lane,
      mechanismLane,
      q0Baseline,
      q0Spoiled,
      q_spoil_ratio: qSpoilRatio,
      f_q_spoil: fQSpool,
      q0CleanFloor: thresholds.q0_clean_floor,
      q0SpoiledCeiling: thresholds.q0_spoiled_ceiling,
      fQSpoolFloor: thresholds.f_q_spoil_floor,
      thresholdDerivation: thresholds.thresholdDerivation ?? null,
      thresholdSourceRefs: thresholds.sourceRefs ?? [],
      u_q0_rel: Number(uQ0Rel.toFixed(6)),
      u_f_rel: Number(uFRel.toFixed(6)),
      uncertaintyMethod: qContext?.uncertainty?.method ?? 'conservative_fallback_missing_numeric',
      reportableReady: qContext?.uncertainty?.reportableReady ?? false,
      blockedReasons: qContext?.uncertainty?.blockedReasons ?? [],
      registryRefs: refs,
      evidenceCongruence: evaluation.evidenceCongruence,
      reasonCodes: evaluation.reasonCodes,
      reducedReasonCodes: [...new Set(evaluation.reasonCodes.map((reason) => reduceReasonCode(reason)))].sort(),
      runClassification: runResult?.classification ?? null,
      runCongruentSolvePass: runResult?.guard?.congruentSolvePass === true,
    };
  });

  const summary = {
    scenarioCount: scenarioChecks.length,
    congruent: scenarioChecks.filter((row) => row.evidenceCongruence === 'congruent').length,
    incongruent: scenarioChecks.filter((row) => row.evidenceCongruence === 'incongruent').length,
    unknown: scenarioChecks.filter((row) => row.evidenceCongruence === 'unknown').length,
    byMechanism,
    reasonCounts,
    reducedReasonCounts,
  };

  const payload = {
    generatedOn: DATE_STAMP,
    boundaryStatement:
      'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.',
    scenarioPath,
    runPath,
    registryPath,
    thresholdsByMechanism: {
      ...fallbackThresholds,
      ...packThresholds,
    },
    summary,
    scenarioChecks,
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
  const result = runQSpoilingCompatCheck({
    scenarioPath: readArgValue('--scenarios') ?? DEFAULT_SCENARIO_PATH,
    runPath: readArgValue('--run') ?? DEFAULT_RUN_PATH,
    registryPath: readArgValue('--registry') ?? DEFAULT_REGISTRY_PATH,
    outJsonPath: readArgValue('--out') ?? DEFAULT_OUT_JSON,
    outMdPath: readArgValue('--out-md') ?? DEFAULT_OUT_MD,
  });
  console.log(JSON.stringify(result, null, 2));
}
