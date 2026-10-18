import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_SCENARIO_PATH = path.join('configs', 'warp-shadow-injection-scenarios.cs-primary-typed.v1.json');
const DEFAULT_RUN_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  `shadow-injection-run-cs-primary-typed-${DATE_STAMP}.json`,
);
const DEFAULT_REGISTRY_PATH = path.join(
  'docs',
  'specs',
  'casimir-tile-experimental-parameter-registry-2026-03-04.md',
);
const DEFAULT_OUT_JSON = path.join('artifacts', 'research', 'full-solve', `cs-compat-check-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-cs-compat-check-${DATE_STAMP}.md`);

type RegistryRow = {
  entry_id: string;
  parameter: string;
  value: string;
  unit: string;
  conditions: string;
  source_class: string;
  maps_to_spec: string;
  status: string;
};

type Scenario = {
  id: string;
  lane: string;
  registryRefs?: string[];
  overrides?: {
    params?: Record<string, unknown>;
  };
  experimentalContext?: {
    casimirSign?: {
      branchHypothesis?: 'attractive' | 'repulsive' | 'transition';
      materialPair?: string;
      interveningMedium?: string;
      sourceRefs?: string[];
      uncertainty?: {
        u_gap_nm?: number;
        u_window_nm?: number;
        method?: string;
        sourceRefs?: string[];
      };
    };
  };
};

type ScenarioPack = {
  scenarios: Scenario[];
};

type RunResult = {
  id: string;
  classification: 'compatible' | 'partial' | 'incompatible' | 'error';
  guard?: {
    congruentSolvePass?: boolean;
  } | null;
};

type RunPayload = {
  summary?: {
    scenarioCount?: number;
    compatible?: number;
    partial?: number;
    incompatible?: number;
    error?: number;
  };
  results?: RunResult[];
};

type Congruence = 'congruent' | 'incongruent' | 'unknown';

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
      parameter: cells[2],
      value: cells[3],
      unit: cells[4],
      conditions: cells[6],
      source_class: cells[9],
      maps_to_spec: cells[10],
      status: cells[11],
    });
  }
  return rows;
};

const getPrimaryWindows = (rows: RegistryRow[]) => {
  const rowAttractive = rows.find((row) => row.entry_id.toUpperCase() === 'EXP-CS-001');
  const rowRepulsive = rows.find((row) => row.entry_id.toUpperCase() === 'EXP-CS-002');

  const attractiveCandidates = rowAttractive ? parseNumberCandidates(rowAttractive.value) : [];
  const repulsiveCandidates = rowRepulsive ? parseNumberCandidates(rowRepulsive.value) : [];

  const attractiveMin = attractiveCandidates.length >= 1 ? attractiveCandidates[0] : 3;
  const attractiveMax = attractiveCandidates.length >= 2 ? attractiveCandidates[1] : 100;
  const repulsiveMin = repulsiveCandidates.length >= 1 ? repulsiveCandidates[0] : 100;

  return { attractiveMin, attractiveMax, repulsiveMin };
};

const hasSignAnchor = (refs: string[]): boolean =>
  refs.some((ref) => ['EXP-CS-003', 'EXP-CS-010', 'EXP-CS-011'].includes(ref.toUpperCase()));

const hasGapWindowAnchor = (refs: string[]): boolean =>
  refs.some((ref) => ['EXP-CS-001', 'EXP-CS-002'].includes(ref.toUpperCase()));

const hasMaterialAnchor = (refs: string[]): boolean =>
  refs.some((ref) => ['EXP-CS-005', 'EXP-CS-006', 'EXP-CS-007'].includes(ref.toUpperCase()));

const isWithin = (value: number, min: number, max: number): boolean => value >= min && value <= max;

const evaluateCongruence = (input: {
  branch: string | null;
  gapNm: number | null;
  refs: string[];
  materialPair: string | null;
  interveningMedium: string | null;
  uGapNm: number | null;
  uWindowNm: number | null;
  windows: { attractiveMin: number; attractiveMax: number; repulsiveMin: number };
}): { evidenceCongruence: Congruence; reasonCodes: string[] } => {
  const reasons: string[] = [];
  if (input.gapNm == null) reasons.push('missing_gap_value');
  if (!input.branch) reasons.push('missing_branch_hypothesis');
  if (!hasSignAnchor(input.refs)) reasons.push('missing_sign_anchor');
  if (!hasGapWindowAnchor(input.refs)) reasons.push('missing_gap_window_anchor');
  if (!hasMaterialAnchor(input.refs)) reasons.push('missing_material_anchor');
  if (!input.materialPair || !input.interveningMedium) reasons.push('missing_material_medium_context');
  if (input.uGapNm == null || input.uWindowNm == null) reasons.push('missing_uncertainty_fields');
  if ((input.uGapNm ?? 0) <= 0 || (input.uWindowNm ?? 0) <= 0) reasons.push('invalid_uncertainty_values');
  if (reasons.length > 0) return { evidenceCongruence: 'unknown', reasonCodes: reasons };

  const gap = input.gapNm as number;
  const branch = (input.branch as string).toLowerCase();
  const uGapNm = input.uGapNm as number;
  const uWindowNm = input.uWindowNm as number;
  const uncertaintyBand = Math.sqrt(uGapNm * uGapNm + uWindowNm * uWindowNm);

  if (branch === 'attractive') {
    const strictMin = input.windows.attractiveMin + uWindowNm;
    const strictMax = input.windows.repulsiveMin - uWindowNm;
    const expandedMin = input.windows.attractiveMin - uncertaintyBand;
    const expandedMax = input.windows.repulsiveMin + uncertaintyBand;
    if (strictMin < strictMax && gap >= strictMin && gap < strictMax) {
      return { evidenceCongruence: 'congruent', reasonCodes: [] };
    }
    if (isWithin(gap, expandedMin, expandedMax)) {
      return { evidenceCongruence: 'unknown', reasonCodes: ['edge_uncertainty_overlap'] };
    }
    return { evidenceCongruence: 'incongruent', reasonCodes: ['gap_outside_primary_window'] };
  }
  if (branch === 'repulsive') {
    const strictMin = input.windows.repulsiveMin + uWindowNm;
    const expandedMin = input.windows.repulsiveMin - uncertaintyBand;
    if (gap >= strictMin) return { evidenceCongruence: 'congruent', reasonCodes: [] };
    if (gap >= expandedMin) {
      return { evidenceCongruence: 'unknown', reasonCodes: ['edge_uncertainty_overlap'] };
    }
    return { evidenceCongruence: 'incongruent', reasonCodes: ['gap_outside_primary_window'] };
  }
  if (branch === 'transition') {
    const halfBand = Math.max(5, uWindowNm);
    const strictMin = input.windows.repulsiveMin - halfBand;
    const strictMax = input.windows.repulsiveMin + halfBand;
    const expandedMin = strictMin - uncertaintyBand;
    const expandedMax = strictMax + uncertaintyBand;
    if (isWithin(gap, strictMin, strictMax)) return { evidenceCongruence: 'congruent', reasonCodes: [] };
    if (isWithin(gap, expandedMin, expandedMax)) {
      return { evidenceCongruence: 'unknown', reasonCodes: ['edge_uncertainty_overlap'] };
    }
    return { evidenceCongruence: 'incongruent', reasonCodes: ['gap_outside_transition_band'] };
  }
  return { evidenceCongruence: 'unknown', reasonCodes: ['unknown_branch_hypothesis'] };
};

const renderMarkdown = (payload: any): string => {
  const reasonRows =
    Object.entries(payload.summary.reasonCounts as Record<string, number>)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => `| ${reason} | ${count} |`)
      .join('\n') || '| n/a | 0 |';

  const scenarioRows =
    (payload.scenarioChecks as Array<any>)
      .map(
        (row) =>
          `| ${row.id} | ${row.branchHypothesis ?? 'n/a'} | ${row.gap_nm ?? 'n/a'} | ${row.u_gap_nm ?? 'n/a'} | ${row.u_window_nm ?? 'n/a'} | ${row.evidenceCongruence} | ${row.runClassification ?? 'n/a'} | ${row.reasonCodes.join(', ') || 'none'} |`,
      )
      .join('\n') || '| n/a | n/a | n/a | n/a | n/a | unknown | n/a | n/a |';

  return `# Casimir Sign Compatibility Check (${payload.generatedOn})

${payload.boundaryStatement}

## Inputs
- scenario_pack: \`${payload.scenarioPath}\`
- run_artifact: \`${payload.runPath}\`
- registry: \`${payload.registryPath}\`

## Primary Window Anchors
- attractive_window_nm: [${payload.primaryWindows.attractiveMin}, ${payload.primaryWindows.attractiveMax}]
- repulsive_window_nm: [${payload.primaryWindows.repulsiveMin}, inf)

## Summary
- scenario_count: ${payload.summary.scenarioCount}
- congruent: ${payload.summary.congruent}
- incongruent: ${payload.summary.incongruent}
- unknown: ${payload.summary.unknown}

## Scenario Checks
| scenario_id | branch_hypothesis | gap_nm | u_gap_nm | u_window_nm | evidence_congruence | run_classification | reasons |
|---|---|---:|---:|---:|---|---|---|
${scenarioRows}

## Dominant Reasons
| reason | count |
|---|---:|
${reasonRows}
`;
};

export const runCasimirSignCompatCheck = (options: {
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
  const windows = getPrimaryWindows(registryRows);
  const runById = new Map((runPayload.results ?? []).map((row) => [row.id, row]));

  const reasonCounts: Record<string, number> = {};
  const scenarioChecks = scenarioPack.scenarios.map((scenario) => {
    const refs = (scenario.registryRefs ?? []).map((ref) => ref.trim().toUpperCase());
    const csContext = scenario.experimentalContext?.casimirSign;
    const branch = csContext?.branchHypothesis ?? null;
    const gapNm = finiteOrNull((scenario.overrides?.params ?? {}).gap_nm);
    const uGapNm = finiteOrNull(csContext?.uncertainty?.u_gap_nm);
    const uWindowNm = finiteOrNull(csContext?.uncertainty?.u_window_nm);
    const evaluation = evaluateCongruence({
      branch,
      gapNm,
      refs,
      materialPair: csContext?.materialPair ?? null,
      interveningMedium: csContext?.interveningMedium ?? null,
      uGapNm,
      uWindowNm,
      windows,
    });
    for (const reason of evaluation.reasonCodes) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    const runResult = runById.get(scenario.id);
    return {
      id: scenario.id,
      lane: scenario.lane,
      gap_nm: gapNm,
      u_gap_nm: uGapNm,
      u_window_nm: uWindowNm,
      branchHypothesis: branch,
      materialPair: csContext?.materialPair ?? null,
      interveningMedium: csContext?.interveningMedium ?? null,
      registryRefs: refs,
      evidenceCongruence: evaluation.evidenceCongruence,
      reasonCodes: evaluation.reasonCodes,
      runClassification: runResult?.classification ?? null,
      runCongruentSolvePass: runResult?.guard?.congruentSolvePass === true,
    };
  });

  const summary = {
    scenarioCount: scenarioChecks.length,
    congruent: scenarioChecks.filter((row) => row.evidenceCongruence === 'congruent').length,
    incongruent: scenarioChecks.filter((row) => row.evidenceCongruence === 'incongruent').length,
    unknown: scenarioChecks.filter((row) => row.evidenceCongruence === 'unknown').length,
    reasonCounts,
  };

  const payload = {
    generatedOn: DATE_STAMP,
    boundaryStatement:
      'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.',
    scenarioPath,
    runPath,
    registryPath,
    primaryWindows: windows,
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
  const result = runCasimirSignCompatCheck({
    scenarioPath: readArgValue('--scenarios') ?? DEFAULT_SCENARIO_PATH,
    runPath: readArgValue('--run') ?? DEFAULT_RUN_PATH,
    registryPath: readArgValue('--registry') ?? DEFAULT_REGISTRY_PATH,
    outJsonPath: readArgValue('--out') ?? DEFAULT_OUT_JSON,
    outMdPath: readArgValue('--out-md') ?? DEFAULT_OUT_MD,
  });
  console.log(JSON.stringify(result, null, 2));
}
