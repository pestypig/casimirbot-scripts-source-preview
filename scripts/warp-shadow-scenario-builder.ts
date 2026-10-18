import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_REGISTRY_PATH = path.join(
  'docs',
  'specs',
  'casimir-tile-experimental-parameter-registry-2026-03-04.md',
);
const DEFAULT_RULEBOOK_PATH = path.join('configs', 'warp-shadow-scenario-builder-rulebook.v1.json');
const DEFAULT_OUT_PATH = path.join('configs', 'warp-shadow-injection-scenarios.generated.v1.json');
const DATE_STAMP = new Date().toISOString().slice(0, 10);

type RegistryRow = {
  entry_id: string;
  source_id: string;
  parameter: string;
  value: string;
  unit: string;
  uncertainty: string;
  conditions: string;
  paper_ref: string;
  extraction_method: string;
  source_class: string;
  maps_to_spec: string;
  status: string;
};

type Rulebook = {
  version: number;
  boundaryStatement?: string;
  laneFromEntryPrefix: Record<string, string>;
  runnableLanes: string[];
  strictLaneRequirements?: Record<string, StrictLaneRequirement>;
  laneTemplates: Record<string, Record<string, unknown>>;
};

type StrictSignalRequirement = {
  id: string;
  anchors?: string[];
  anyPatterns?: string[];
};

type StrictLaneRequirement = {
  flag:
    | 'strict_qei'
    | 'strict_casimir_sign'
    | 'strict_q_spoiling'
    | 'strict_nanogap'
    | 'strict_timing'
    | 'strict_sem_ellips';
  requiredSourceClasses?: string[];
  requiredSignals: StrictSignalRequirement[];
};

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
  uncertainty?: {
    u_gap_nm?: number;
    u_window_nm?: number;
    method?: string;
    sourceRefs?: string[];
  };
};

type ExperimentalContext = {
  casimirSign?: CasimirSignContext;
  nanogap?: {
    profileId?: 'NG-STD-10' | 'NG-ADV-5';
    u_g_mean_nm?: number;
    u_g_sigma_nm?: number;
    tip_method?: 'btr' | 'direct_ref';
    fiducial_present?: boolean;
    sourceRefs?: string[];
    uncertainty?: {
      method?: string;
      reportableReady?: boolean;
      blockedReasons?: string[];
      sourceRefs?: string[];
    };
  };
  qSpoiling?: {
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
  semEllips?: {
    profileId?: 'SE-STD-2' | 'SE-ADV-1';
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
};

type BuiltScenario = {
  id: string;
  lane: string;
  description: string;
  registryRefs: string[];
  sourceSelection: {
    statuses: string[];
    sourceClasses: string[];
    maxPerLane: number;
  };
  overrides: ScenarioOverrides;
  experimentalContext?: ExperimentalContext;
};

type StrictLaneSkip = {
  lane: string;
  reason: string;
  missingSignals: string[];
  registryRefs: string[];
};

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const parseListArg = (value?: string): string[] =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const finiteOrNull = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const parseBoolArg = (name: string, argv = process.argv.slice(2)): boolean => {
  const raw = readArgValue(name, argv);
  if (raw == null) return argv.includes(name);
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return argv.includes(name);
};

const parseNumberCandidates = (raw: string): number[] => {
  const matches = String(raw).match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi);
  if (!matches) return [];
  return matches
    .map((token) => Number(token))
    .filter((value) => Number.isFinite(value));
};

const parsePositiveNumberFromValue = (raw: string): number | null => {
  const candidates = parseNumberCandidates(raw).filter((value) => value > 0);
  return candidates.length > 0 ? candidates[0] : null;
};

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const isUnknownValue = (value: unknown): boolean => {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized.length === 0 || ['unknown', 'n/a', 'na', 'none', 'null'].includes(normalized);
};

const parseRegistryRows = (markdown: string): RegistryRow[] => {
  const rows: RegistryRow[] = [];
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('| EXP-')) continue;
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 12) continue;
    rows.push({
      entry_id: cells[0],
      source_id: cells[1],
      parameter: cells[2],
      value: cells[3],
      unit: cells[4],
      uncertainty: cells[5],
      conditions: cells[6],
      paper_ref: cells[7],
      extraction_method: cells[8],
      source_class: cells[9],
      maps_to_spec: cells[10],
      status: cells[11],
    });
  }
  return rows;
};

const resolveLane = (entryId: string, laneFromPrefix: Record<string, string>): string | null => {
  const ordered = Object.entries(laneFromPrefix).sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, lane] of ordered) {
    if (entryId.startsWith(prefix)) return lane;
  }
  return null;
};

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const buildRowText = (row: RegistryRow): string =>
  `${row.entry_id} ${row.parameter} ${row.value} ${row.unit} ${row.uncertainty} ${row.conditions} ${row.paper_ref} ${row.maps_to_spec}`.toLowerCase();

const rowMatchesStrictSignal = (row: RegistryRow, signal: StrictSignalRequirement): boolean => {
  if (signal.id === 'uncertainty_fields_anchor' || signal.id === 'uncertainty_anchor') {
    return !isUnknownValue(row.uncertainty);
  }
  const entryId = String(row.entry_id).trim().toUpperCase();
  const anchors = (signal.anchors ?? []).map((value) => value.trim().toUpperCase());
  if (anchors.includes(entryId)) return true;
  if (isUnknownValue(row.value)) return false;
  const text = buildRowText(row);
  const patterns = signal.anyPatterns ?? [];
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, 'i').test(text)) return true;
    } catch {
      if (text.includes(String(pattern).toLowerCase())) return true;
    }
  }
  return false;
};

const rowHasQeiNormalizationSignal = (row: RegistryRow): boolean =>
  rowMatchesStrictSignal(row, {
    id: 'sampler_normalization',
    anyPatterns: ['samplingkernelnormalization', 'normalize_ok', 'normalization', 'unit_integral', 'integral'],
  });

const rowHasQeiTauSignal = (row: RegistryRow): boolean =>
  rowMatchesStrictSignal(row, {
    id: 'tau',
    anyPatterns: ['\\btau\\b', 'tau_s', 'tau0', 't_0', 'sampling time', 'averaging time'],
  });

const rowHasQeiApplicabilitySignal = (row: RegistryRow): boolean => {
  if (!rowMatchesStrictSignal(row, { id: 'worldline_applicability', anyPatterns: ['applicability', 'worldline'] })) {
    return false;
  }
  const verdict = String(row.value).toLowerCase();
  const positive = /pass|admissible|required|present|short_sampling_required|stationary_worldline_qei|timelike|inertial/.test(
    verdict,
  );
  const negative = /fail|not_admissible|inapplicable|invalid|unknown/.test(verdict);
  return positive && !negative;
};

const selectStrictLaneRows = (
  rows: RegistryRow[],
  maxPerLane: number,
  strictRequirement: StrictLaneRequirement,
): { selectedRows: RegistryRow[]; missingSignals: string[] } => {
  const sorted = rows.slice().sort((a, b) => a.entry_id.localeCompare(b.entry_id));
  const selected: RegistryRow[] = [];
  const signalMatches = new Map<string, string[]>();

  const addFirstMatch = (signal: StrictSignalRequirement) => {
    const signalRows = sorted.filter((row) => rowMatchesStrictSignal(row, signal));
    signalMatches.set(
      signal.id,
      signalRows.map((row) => row.entry_id),
    );
    const anchorOrder = (signal.anchors ?? []).map((value) => value.trim().toUpperCase());
    let found = signalRows.find(
      (row) => !selected.some((candidate) => candidate.entry_id.toUpperCase() === row.entry_id.toUpperCase()),
    );
    if (anchorOrder.length > 0) {
      for (const anchor of anchorOrder) {
        const anchored = signalRows.find(
          (row) =>
            row.entry_id.toUpperCase() === anchor &&
            !selected.some((candidate) => candidate.entry_id.toUpperCase() === row.entry_id.toUpperCase()),
        );
        if (anchored) {
          found = anchored;
          break;
        }
      }
    }
    if (found && selected.length < Math.max(1, maxPerLane)) selected.push(found);
  };

  for (const signal of strictRequirement.requiredSignals) {
    addFirstMatch(signal);
  }

  for (const row of sorted) {
    if (selected.length >= Math.max(1, maxPerLane)) break;
    if (selected.some((candidate) => candidate.entry_id.toUpperCase() === row.entry_id.toUpperCase())) continue;
    selected.push(row);
  }

  const missingSignals = strictRequirement.requiredSignals
    .filter((signal) => {
      const matches = signalMatches.get(signal.id) ?? [];
      if (matches.length === 0) return true;
      return !selected.some((row) => matches.includes(row.entry_id));
    })
    .map((signal) => signal.id);

  return { selectedRows: selected, missingSignals };
};

const selectLaneRows = (rows: RegistryRow[], maxPerLane: number): RegistryRow[] =>
  rows
    .slice()
    .sort((a, b) => a.entry_id.localeCompare(b.entry_id))
    .slice(0, Math.max(1, maxPerLane));

const selectStrictQeiRows = (rows: RegistryRow[], maxPerLane: number): { selectedRows: RegistryRow[]; missingSignals: string[] } => {
  const requirement: StrictLaneRequirement = {
    flag: 'strict_qei',
    requiredSignals: [
      { id: 'sampler_normalization', anyPatterns: ['samplingkernelnormalization', 'normalize_ok', 'unit_integral'] },
      { id: 'tau', anyPatterns: ['\\btau\\b', 'tau_s', 'tau0', 't_0'] },
      { id: 'worldline_applicability', anyPatterns: ['qei_worldline_applicability', 'worldline', 'timelike'] },
    ],
  };
  const strictSelection = selectStrictLaneRows(rows, maxPerLane, requirement);
  const selectedRows = strictSelection.selectedRows;
  return {
    selectedRows: selectedRows.slice(0, Math.max(1, maxPerLane)),
    missingSignals: strictSelection.missingSignals,
  };
};

const canDeriveQSpoilRatio = (rows: RegistryRow[]): boolean => {
  const textOf = (row: RegistryRow): string =>
    `${row.parameter} ${row.maps_to_spec} ${row.conditions}`.toLowerCase();
  const baselineRow =
    rows.find((row) => row.entry_id.toUpperCase() === 'EXP-Q-001') ??
    rows.find((row) => /q0_baseline|post-treatment|quality factor/.test(textOf(row)));
  const spoiledRow =
    rows.find((row) => row.entry_id.toUpperCase() === 'EXP-Q-002') ??
    rows.find((row) => /q_spoil_factor|q disease|degraded|spoil/.test(textOf(row)));
  const q0Baseline = baselineRow ? parsePositiveNumberFromValue(baselineRow.value) : null;
  const q0Spoiled = spoiledRow ? parsePositiveNumberFromValue(spoiledRow.value) : null;
  if (q0Baseline == null || q0Spoiled == null) return false;
  const ratio = q0Baseline / q0Spoiled;
  return Number.isFinite(ratio) && ratio > 1;
};

const applyLaneDerivedOverrides = (lane: string, rows: RegistryRow[], overrides: ScenarioOverrides) => {
  if (lane === 'nanogap') {
    const nmCandidates = rows
      .filter((row) => row.unit.toLowerCase().includes('nm') && /gap|window|transition/i.test(row.parameter))
      .flatMap((row) => parseNumberCandidates(row.value))
      .filter((value) => value > 0 && value <= 1000);
    const candidateGap = median(nmCandidates);
    if (candidateGap != null) {
      overrides.params = { ...(overrides.params ?? {}), gap_nm: candidateGap };
    }
  }

  if (lane === 'casimir_sign_control') {
    const nmCandidates = rows
      .filter((row) => row.unit.toLowerCase().includes('nm'))
      .flatMap((row) => parseNumberCandidates(row.value))
      .filter((value) => value >= 5 && value <= 500);
    const candidateGap = median(nmCandidates);
    if (candidateGap != null) {
      overrides.params = { ...(overrides.params ?? {}), gap_nm: candidateGap };
    }
  }

  if (lane === 'q_spoiling') {
    const qCandidates = rows
      .filter((row) => /q0|quality factor/i.test(row.parameter))
      .flatMap((row) => parseNumberCandidates(row.value))
      .filter((value) => value >= 1e3 && value <= 1e12);
    const candidateQ = median(qCandidates);
    if (candidateQ != null) {
      overrides.params = { ...(overrides.params ?? {}), qCavity: Math.round(candidateQ) };
    }
  }

  if (lane === 'qei_worldline') {
    const allText = `${rows.map((row) => `${row.parameter} ${row.value} ${row.conditions}`).join(' ')}`.toLowerCase();
    let sampler: 'gaussian' | 'lorentzian' | 'compact' | null = null;
    if (allText.includes('compact')) sampler = 'compact';
    else if (allText.includes('gaussian')) sampler = 'gaussian';
    else if (allText.includes('lorentzian')) sampler = 'lorentzian';
    const tauCandidates = rows
      .filter((row) => /tau/i.test(row.parameter) && !/[a-z]/i.test(row.value.replace(/e[+-]?\d+/gi, '')))
      .flatMap((row) => parseNumberCandidates(row.value))
      .filter((value) => value > 0 && value < 1);
    const tauCandidate = median(tauCandidates);
    const qi = {
      ...overrides.qi,
      ...(sampler ? { sampler } : {}),
      ...(tauCandidate != null ? { tau_s_ms: tauCandidate * 1000 } : {}),
    };
    overrides.qi = qi;
  }
};

const deriveCasimirSignContext = (rows: RegistryRow[]): CasimirSignContext => {
  const text = rows.map((row) => buildRowText(row)).join(' ');
  const gapCandidates = rows
    .filter((row) => String(row.unit).toLowerCase().includes('nm'))
    .flatMap((row) => parseNumberCandidates(row.value))
    .filter((value) => value > 0 && value <= 500);
  const gapEstimate = median(gapCandidates);
  const branchHypothesis: 'attractive' | 'repulsive' | 'transition' =
    text.includes('repulsive') && !text.includes('attractive')
      ? 'repulsive'
      : text.includes('attractive') && !text.includes('repulsive')
        ? 'attractive'
        : gapEstimate != null && gapEstimate >= 100
          ? 'repulsive'
          : 'transition';

  let materialPair = 'gold_silica';
  if (text.includes('polystyrene') && text.includes('teflon')) materialPair = 'polystyrene_teflon';
  if (text.includes('gold') && text.includes('gold')) materialPair = 'gold_gold';
  if (text.includes('ptfe') && text.includes('polystyrene')) materialPair = 'ptfe_polystyrene';

  let interveningMedium = 'ethanol';
  if (text.includes('bromobenzene')) interveningMedium = 'bromobenzene';
  if (text.includes('ferrofluid')) interveningMedium = 'ferrofluid';
  if (text.includes('methanol')) interveningMedium = 'methanol';

  const parseUncertaintyNm = (row: RegistryRow): number[] => {
    if (isUnknownValue(row.uncertainty)) return [];
    const numeric = parseNumberCandidates(row.uncertainty).filter((value) => value > 0);
    if (!numeric.length) return [];
    const unit = String(row.unit).toLowerCase();
    if (unit.includes('um')) return numeric.map((value) => value * 1000);
    if (unit.includes('nm')) return numeric;
    return [];
  };

  const signWindowRows = rows.filter((row) => String(row.maps_to_spec).toLowerCase().includes('casimir_sign_window_nm'));
  const uncertaintyCandidatesNm = signWindowRows.flatMap(parseUncertaintyNm);
  const conservativeFallbackNm = 5;
  const uWindowNm = median(uncertaintyCandidatesNm) ?? conservativeFallbackNm;
  const uGapNm = uWindowNm;
  const uncertaintyMethod =
    uncertaintyCandidatesNm.length > 0 ? 'registry_uncertainty_median' : 'conservative_fallback_no_nm_uncertainty';
  const uncertaintySourceRefs = signWindowRows.map((row) => row.entry_id);

  return {
    branchHypothesis,
    materialPair,
    interveningMedium,
    sourceRefs: rows.map((row) => row.entry_id),
    uncertainty: {
      u_gap_nm: Number(uGapNm.toFixed(3)),
      u_window_nm: Number(uWindowNm.toFixed(3)),
      method: uncertaintyMethod,
      sourceRefs: uncertaintySourceRefs,
    },
  };
};

const deriveQSpoilingContext = (rows: RegistryRow[]): NonNullable<ExperimentalContext['qSpoiling']> => {
  const textOf = (row: RegistryRow): string =>
    `${row.parameter} ${row.maps_to_spec} ${row.conditions}`.toLowerCase();
  const baselineRow =
    rows.find((row) => row.entry_id.toUpperCase() === 'EXP-Q-001') ??
    rows.find((row) => /q0_baseline|post-treatment|quality factor/.test(textOf(row)));
  const spoiledRow =
    rows.find((row) => row.entry_id.toUpperCase() === 'EXP-Q-002') ??
    rows.find((row) => /q_spoil_factor|q disease|degraded|spoil/.test(textOf(row)));
  const q0Baseline = baselineRow ? parsePositiveNumberFromValue(baselineRow.value) : null;
  const q0Spoiled = spoiledRow ? parsePositiveNumberFromValue(spoiledRow.value) : null;
  const fQSpool =
    q0Baseline != null && q0Spoiled != null && q0Spoiled > 0 ? Number((q0Baseline / q0Spoiled).toFixed(6)) : null;

  const rowHasRelativeUncertaintyAnchor = (row: RegistryRow): boolean => {
    const text = `${row.parameter} ${row.maps_to_spec}`.toLowerCase();
    return /u_q0_rel|u_f_rel|relative uncertainty/.test(text);
  };

  const parseRelativeUncertaintyCandidates = (row: RegistryRow): number[] => {
    const fromUncertainty = isUnknownValue(row.uncertainty)
      ? []
      : parseNumberCandidates(row.uncertainty)
          .filter((value) => value > 0)
          .map((value) => {
            if (value <= 1) return value;
            const base = parsePositiveNumberFromValue(row.value);
            if (base != null && base > 0) return value / base;
            return Number.NaN;
          })
          .filter((value) => Number.isFinite(value) && value > 0);

    if (fromUncertainty.length > 0) return fromUncertainty;
    if (!rowHasRelativeUncertaintyAnchor(row)) return [];

    return parseNumberCandidates(row.value)
      .filter((value) => value > 0)
      .map((value) => {
        if (value <= 1) return value;
        if (value <= 100) return value / 100;
        return Number.NaN;
      })
      .filter((value) => Number.isFinite(value) && value > 0);
  };

  const uncertaintyCandidates = rows.flatMap(parseRelativeUncertaintyCandidates);
  const numericReady = uncertaintyCandidates.length > 0;
  const uRel = numericReady ? Math.min(0.5, Math.max(0.01, median(uncertaintyCandidates) ?? 0.3)) : 0.3;
  const uncertaintyMethod = numericReady ? 'registry_numeric_anchor' : 'conservative_fallback_missing_numeric';
  const mechanismLane = rows.some((row) => /hydride|q disease/i.test(textOf(row)))
    ? 'hydride'
    : rows.some((row) => /flux/i.test(textOf(row)))
      ? 'flux'
      : rows.some((row) => /tls|oxide/i.test(textOf(row)))
        ? 'oxide_tls'
        : 'mixed_reference';

  return {
    mechanismLane,
    q0Baseline: q0Baseline ?? undefined,
    f_q_spoil: fQSpool ?? undefined,
    q0Spoiled: q0Spoiled ?? undefined,
    sourceRefs: rows.map((row) => row.entry_id),
    uncertainty: {
      u_q0_rel: Number(uRel.toFixed(6)),
      u_f_rel: Number(uRel.toFixed(6)),
      method: uncertaintyMethod,
      reportableReady: numericReady,
      blockedReasons: numericReady ? [] : ['missing_numeric_uncertainty_anchor'],
      sourceRefs: numericReady ? rows.map((row) => row.entry_id) : [],
    },
  };
};

const deriveNanogapContext = (rows: RegistryRow[]): NonNullable<ExperimentalContext['nanogap']> => {
  const refs = rows.map((row) => row.entry_id.toUpperCase());
  const byId = new Map(rows.map((row) => [row.entry_id.toUpperCase(), row]));
  const parseRowValue = (entryId: string): number | null => parsePositiveNumberFromValue(byId.get(entryId)?.value ?? '');

  const uCalibration = parseRowValue('EXP-NG-002');
  const uNoise = parseRowValue('EXP-NG-006');
  const uStress = parseRowValue('EXP-NG-007');

  const uMean =
    uCalibration != null
      ? Math.max(uCalibration, uNoise ?? 0)
      : uNoise != null
        ? uNoise
        : null;
  const uSigma =
    uCalibration != null
      ? Math.max(uCalibration, uStress ?? uNoise ?? 0)
      : uStress != null
        ? uStress
        : uNoise != null
          ? uNoise
          : null;

  const reportableReady = uMean != null && uSigma != null;
  const blockedReasons: string[] = [];
  if (uMean == null) blockedReasons.push('missing_u_g_mean_anchor');
  if (uSigma == null) blockedReasons.push('missing_u_g_sigma_anchor');

  const profileId: 'NG-STD-10' | 'NG-ADV-5' =
    (uMean ?? Number.POSITIVE_INFINITY) <= 1 && (uSigma ?? Number.POSITIVE_INFINITY) <= 1 ? 'NG-ADV-5' : 'NG-STD-10';

  return {
    profileId,
    ...(uMean != null ? { u_g_mean_nm: Number(uMean.toFixed(6)) } : {}),
    ...(uSigma != null ? { u_g_sigma_nm: Number(uSigma.toFixed(6)) } : {}),
    tip_method: refs.includes('EXP-NG-019') || refs.includes('EXP-NG-020') ? 'btr' : 'direct_ref',
    fiducial_present: refs.includes('EXP-NG-011') && refs.includes('EXP-NG-012'),
    sourceRefs: rows.map((row) => row.entry_id),
    uncertainty: {
      method: reportableReady ? 'registry_anchor_derived' : 'conservative_fallback_missing_numeric',
      reportableReady,
      blockedReasons,
      sourceRefs: rows.map((row) => row.entry_id),
    },
  };
};

const toScenario = (
  lane: string,
  selectedRows: RegistryRow[],
  rulebook: Rulebook,
  maxPerLane: number,
  statuses: string[],
  sourceClasses: string[],
): BuiltScenario => {
  const template = deepClone((rulebook.laneTemplates[lane] ?? {}) as ScenarioOverrides);
  const overrides: ScenarioOverrides = {
    params: typeof template.params === 'object' && template.params ? template.params : undefined,
    qi: typeof template.qi === 'object' && template.qi ? template.qi : undefined,
  };
  applyLaneDerivedOverrides(lane, selectedRows, overrides);
  const experimentalContext: ExperimentalContext | undefined =
    lane === 'casimir_sign_control'
      ? { casimirSign: deriveCasimirSignContext(selectedRows) }
      : lane === 'nanogap'
        ? { nanogap: deriveNanogapContext(selectedRows) }
      : lane === 'q_spoiling'
        ? { qSpoiling: deriveQSpoilingContext(selectedRows) }
        : undefined;

  return {
    id: `auto_${lane}_${DATE_STAMP}`.replace(/[^a-z0-9_]+/gi, '_').toLowerCase(),
    lane,
    description: `Auto-built from ${selectedRows.length} registry rows in lane ${lane}.`,
    registryRefs: selectedRows.map((row) => row.entry_id),
    sourceSelection: {
      statuses,
      sourceClasses,
      maxPerLane,
    },
    overrides,
    ...(experimentalContext ? { experimentalContext } : {}),
  };
};

export const buildWarpShadowScenarios = (options: {
  registryPath?: string;
  rulebookPath?: string;
  outPath?: string;
  laneFilter?: string[];
  statusFilter?: string[];
  sourceClassFilter?: string[];
  entryFilter?: string[];
  maxPerLane?: number;
  strictQei?: boolean;
  strictCasimirSign?: boolean;
  strictQSpoiling?: boolean;
  strictNanogap?: boolean;
  strictTiming?: boolean;
  strictSemEllips?: boolean;
}) => {
  const registryPath = options.registryPath ?? DEFAULT_REGISTRY_PATH;
  const rulebookPath = options.rulebookPath ?? DEFAULT_RULEBOOK_PATH;
  const outPath = options.outPath ?? DEFAULT_OUT_PATH;
  const maxPerLane = Math.max(1, Number.isFinite(options.maxPerLane) ? Number(options.maxPerLane) : 3);
  const laneFilter = new Set((options.laneFilter ?? []).map((value) => value.toLowerCase()));
  const statusFilter = new Set((options.statusFilter ?? ['extracted']).map((value) => value.toLowerCase()));
  const sourceClassFilter = new Set((options.sourceClassFilter ?? []).map((value) => value.toLowerCase()));
  const entryFilter = new Set((options.entryFilter ?? []).map((value) => value.toUpperCase()));
  const strictQei = options.strictQei === true;
  const strictCasimirSign = options.strictCasimirSign === true;
  const strictQSpoiling = options.strictQSpoiling === true;
  const strictNanogap = options.strictNanogap === true;
  const strictTiming = options.strictTiming === true;
  const strictSemEllips = options.strictSemEllips === true;

  const rulebook = JSON.parse(fs.readFileSync(rulebookPath, 'utf8')) as Rulebook;
  const rows = parseRegistryRows(fs.readFileSync(registryPath, 'utf8'));

  const enrichedRows = rows
    .map((row) => ({ ...row, lane: resolveLane(row.entry_id, rulebook.laneFromEntryPrefix) }))
    .filter((row) => row.lane != null) as Array<RegistryRow & { lane: string }>;

  const filtered = enrichedRows.filter((row) => {
    if (entryFilter.size > 0 && !entryFilter.has(row.entry_id.toUpperCase())) return false;
    if (laneFilter.size > 0 && !laneFilter.has(row.lane.toLowerCase())) return false;
    if (statusFilter.size > 0 && !statusFilter.has(String(row.status).toLowerCase())) return false;
    if (sourceClassFilter.size > 0 && !sourceClassFilter.has(String(row.source_class).toLowerCase())) return false;
    return true;
  });

  const byLane = new Map<string, RegistryRow[]>();
  for (const row of filtered) {
    if (!rulebook.runnableLanes.includes(row.lane)) continue;
    const list = byLane.get(row.lane) ?? [];
    list.push(row);
    byLane.set(row.lane, list);
  }

  const scenarios: BuiltScenario[] = [];
  const strictSkips: StrictLaneSkip[] = [];

  const isStrictLaneEnabled = (lane: string, requirement: StrictLaneRequirement | undefined): boolean => {
    if (!requirement) return false;
    if (requirement.flag === 'strict_qei') return strictQei && lane === 'qei_worldline';
    if (requirement.flag === 'strict_casimir_sign') return strictCasimirSign && lane === 'casimir_sign_control';
    if (requirement.flag === 'strict_q_spoiling') return strictQSpoiling && lane === 'q_spoiling';
    if (requirement.flag === 'strict_nanogap') return strictNanogap && lane === 'nanogap';
    if (requirement.flag === 'strict_timing') return strictTiming && lane === 'timing';
    if (requirement.flag === 'strict_sem_ellips') return strictSemEllips && lane === 'sem_ellipsometry';
    return false;
  };

  for (const [lane, laneRows] of [...byLane.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (laneRows.length === 0) continue;
    const strictRequirement = rulebook.strictLaneRequirements?.[lane];
    const strictEnabled = isStrictLaneEnabled(lane, strictRequirement);
    const strictSelection =
      strictEnabled && lane === 'qei_worldline'
        ? selectStrictQeiRows(laneRows, maxPerLane)
        : strictEnabled && strictRequirement
          ? selectStrictLaneRows(laneRows, maxPerLane, strictRequirement)
          : { selectedRows: selectLaneRows(laneRows, maxPerLane), missingSignals: [] };

    const selectedRows = strictSelection.selectedRows;
    const missingSignals = [...strictSelection.missingSignals];
    if (strictEnabled && lane === 'q_spoiling' && !canDeriveQSpoilRatio(selectedRows)) {
      if (!missingSignals.includes('q_spoil_ratio_anchor')) missingSignals.push('q_spoil_ratio_anchor');
    }

    const sourceClassViolations =
      strictEnabled && strictRequirement?.requiredSourceClasses?.length
        ? selectedRows
            .filter(
              (row) =>
                !strictRequirement.requiredSourceClasses!
                  .map((value) => value.toLowerCase())
                  .includes(String(row.source_class).toLowerCase()),
            )
            .map((row) => `${row.entry_id}:${row.source_class}`)
        : [];

    if (strictEnabled && (missingSignals.length > 0 || sourceClassViolations.length > 0)) {
      strictSkips.push({
        lane,
        reason:
          sourceClassViolations.length > 0
            ? `strict_${lane}_source_class_not_allowed`
            : `strict_${lane}_missing_signals`,
        missingSignals: [...missingSignals, ...sourceClassViolations.map((value) => `source_class:${value}`)],
        registryRefs: selectedRows.map((row) => row.entry_id),
      });
      continue;
    }

    scenarios.push(
      toScenario(
        lane,
        selectedRows,
        rulebook,
        maxPerLane,
        [...statusFilter.values()],
        [...sourceClassFilter.values()],
      ),
    );
  }

  const payload = {
    version: 1,
    mode: 'shadow_non_blocking',
    boundaryStatement: rulebook.boundaryStatement,
    generatedBy: 'warp-shadow-scenario-builder',
    generatedAt: new Date().toISOString(),
      selection: {
      registryPath,
      rulebookPath,
      laneFilter: [...laneFilter.values()],
      statusFilter: [...statusFilter.values()],
      sourceClassFilter: [...sourceClassFilter.values()],
      entryFilter: [...entryFilter.values()],
      maxPerLane,
      strictQei,
      strictCasimirSign,
      strictQSpoiling,
      strictNanogap,
      strictTiming,
      strictSemEllips,
    },
    summary: {
      registryRowsParsed: rows.length,
      registryRowsEligible: enrichedRows.length,
      registryRowsSelected: filtered.length,
      scenariosBuilt: scenarios.length,
      strictLaneSkips: strictSkips.length,
      strictQeiSkips: strictSkips.filter((row) => row.lane === 'qei_worldline').length,
      strictQSpoilingSkips: strictSkips.filter((row) => row.lane === 'q_spoiling').length,
      strictNanogapSkips: strictSkips.filter((row) => row.lane === 'nanogap').length,
      strictTimingSkips: strictSkips.filter((row) => row.lane === 'timing').length,
      strictSemEllipsSkips: strictSkips.filter((row) => row.lane === 'sem_ellipsometry').length,
    },
    strictLaneSkips: strictSkips,
    strictQeiSkips: strictSkips.filter((row) => row.lane === 'qei_worldline'),
    strictTimingSkips: strictSkips.filter((row) => row.lane === 'timing'),
    strictSemEllipsSkips: strictSkips.filter((row) => row.lane === 'sem_ellipsometry'),
    scenarios,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  return { ok: true, outPath, summary: payload.summary };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const laneFilter = parseListArg(readArgValue('--lane'));
  const statusFilter = parseListArg(readArgValue('--status'));
  const sourceClassFilter = parseListArg(readArgValue('--source-class'));
  const entryFilter = parseListArg(readArgValue('--entry'));
  const maxPerLaneRaw = finiteOrNull(readArgValue('--max-per-lane'));
  const strictQei = parseBoolArg('--strict-qei');
  const strictCasimirSign = parseBoolArg('--strict-casimir-sign');
  const strictQSpoiling = parseBoolArg('--strict-q-spoiling');
  const strictNanogap = parseBoolArg('--strict-nanogap');
  const strictTiming = parseBoolArg('--strict-timing');
  const strictSemEllips = parseBoolArg('--strict-sem-ellips');
  const result = buildWarpShadowScenarios({
    registryPath: readArgValue('--registry') ?? DEFAULT_REGISTRY_PATH,
    rulebookPath: readArgValue('--rulebook') ?? DEFAULT_RULEBOOK_PATH,
    outPath: readArgValue('--out') ?? DEFAULT_OUT_PATH,
    laneFilter,
    statusFilter: statusFilter.length ? statusFilter : undefined,
    sourceClassFilter,
    entryFilter,
    maxPerLane: maxPerLaneRaw ?? undefined,
    strictQei,
    strictCasimirSign,
    strictQSpoiling,
    strictNanogap,
    strictTiming,
    strictSemEllips,
  });
  console.log(JSON.stringify(result, null, 2));
}
