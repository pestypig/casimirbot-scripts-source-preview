import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_REGISTRY_PATH = path.join(
  'docs',
  'specs',
  'casimir-tile-experimental-parameter-registry-2026-03-04.md',
);
const DEFAULT_BASE_PATH = path.join('configs', 'warp-shadow-injection-scenarios.ti-primary-recovery.v1.json');
const DEFAULT_PASS1_OUT = path.join('configs', 'warp-shadow-injection-scenarios.ti-primary-recovery.v1.json');
const DEFAULT_PASS2_OUT = path.join('configs', 'warp-shadow-injection-scenarios.ti-primary-typed.v1.json');
const DEFAULT_REPORTABLE_OUT = path.join('configs', 'warp-shadow-injection-scenarios.ti-primary-reportable.v1.json');
const DEFAULT_REPORTABLE_REFERENCE_OUT = path.join(
  'configs',
  'warp-shadow-injection-scenarios.ti-primary-reportable-reference.v1.json',
);
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const PROFILE_IDS = ['WR-SHORT-PS', 'WR-LONGHAUL-EXP'] as const;
type ProfileId = (typeof PROFILE_IDS)[number];
type TimingProfileThresholds = {
  sigma_t_ps_max: number | null;
  tie_pp_ps_max: number | null;
  pdv_pp_ps_max: number | null;
};

type RegistryRow = {
  entry_id: string;
  value: string;
  uncertainty: string;
  unit: string;
  source_class: string;
  status: string;
};

type BaseScenarioPack = {
  boundaryStatement?: string;
  scenarios?: Array<{
    registryRefs?: string[];
  }>;
};

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

const parsePositiveValue = (raw: string): number | null => {
  const values = parseNumberCandidates(raw).filter((value) => value > 0);
  return values.length > 0 ? values[0] : null;
};

const uniqueSorted = (values: number[]): number[] =>
  [...new Set(values.map((value) => Number(value.toFixed(6))))].sort((a, b) => a - b);

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
      unit: cells[4],
      uncertainty: cells[5],
      source_class: cells[9],
      status: cells[11],
    });
  }
  return rows;
};

const toIdToken = (value: number): string => {
  const normalized = Number(value.toFixed(6));
  const token = Number.isInteger(normalized) ? String(normalized) : String(normalized).replace('.', 'p');
  return token.replace('-', 'm');
};

const sigmaBoundByProfile: Record<ProfileId, number | null> = {
  'WR-SHORT-PS': 100,
  'WR-LONGHAUL-EXP': null,
};

const deriveSigmaGrid = (rowsById: Map<string, RegistryRow>): number[] => {
  const sigmaAnchor = parsePositiveValue(rowsById.get('EXP-T-003')?.value ?? '') ?? 6;
  const shortBound = sigmaBoundByProfile['WR-SHORT-PS'] ?? 100;
  const grid = uniqueSorted([
    sigmaAnchor,
    Math.max(1, Math.round(sigmaAnchor * 2)),
    Math.max(10, Math.round(shortBound * 0.5)),
    shortBound,
    Math.round(shortBound * 1.2),
    Math.round(shortBound * 3),
  ]);
  return grid;
};

const parseValuePs = (row: RegistryRow | undefined): number | null => {
  if (!row) return null;
  const value = parsePositiveValue(row.value);
  if (value == null) return null;
  const unit = String(row.unit).toLowerCase();
  if (unit.includes('ps')) return Number(value.toFixed(6));
  if (unit.includes('ns')) return Number((value * 1000).toFixed(6));
  return Number(value.toFixed(6));
};

const parseUnitBearingPsValue = (raw: string): number | null => {
  const unitMatches = [...String(raw).matchAll(/(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(ps|ns)\b/gi)];
  for (const match of unitMatches) {
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const unit = String(match[2]).toLowerCase();
    if (unit === 'ns') return Number((value * 1000).toFixed(6));
    return Number(value.toFixed(6));
  }
  return null;
};

const parseUncertaintyPs = (row: RegistryRow | undefined, options?: { preferValueField?: boolean }): number | null => {
  if (!row) return null;
  if (options?.preferValueField) {
    const valuePs = parseValuePs(row);
    if (valuePs != null) return valuePs;
  }

  const uncertainty = String(row.uncertainty);
  const normalized = uncertainty.trim().toLowerCase();
  if (!normalized || ['unknown', 'n/a', 'na', 'none', 'null'].includes(normalized)) return null;

  const unitBearing = parseUnitBearingPsValue(uncertainty);
  if (unitBearing != null) return unitBearing;

  // Avoid mis-parsing coverage factors such as "k=1" as uncertainty magnitudes.
  if (/\bk\s*=/.test(normalized)) return null;

  const magnitude = parsePositiveValue(uncertainty);
  if (magnitude == null) return null;
  const unit = String(row.unit).toLowerCase();
  if (unit.includes('ns')) return Number((magnitude * 1000).toFixed(6));
  return Number(magnitude.toFixed(6));
};

const deriveTieThresholdByProfile = (rowsById: Map<string, RegistryRow>): Record<ProfileId, number> => {
  const shortThresholdPs =
    parseValuePs(rowsById.get('EXP-T-022')) ??
    parseValuePs(rowsById.get('EXP-T-021')) ??
    parseValuePs(rowsById.get('EXP-T-002')) ??
    parseValuePs(rowsById.get('EXP-T-004')) ??
    200;
  const longhaulThresholdPs =
    parseValuePs(rowsById.get('EXP-T-023')) ??
    parseValuePs(rowsById.get('EXP-T-021')) ??
    shortThresholdPs ??
    500;
  return {
    'WR-SHORT-PS': Number(shortThresholdPs.toFixed(6)),
    'WR-LONGHAUL-EXP': Number(longhaulThresholdPs.toFixed(6)),
  };
};

const deriveTiePointByProfile = (tieThresholdByProfile: Record<ProfileId, number>): Record<ProfileId, number> => {
  // Treat literature inequality anchors as ceilings and place sweep points conservatively below each ceiling.
  const toPoint = (limit: number): number => Number((limit * 0.75).toFixed(6));
  return {
    'WR-SHORT-PS': toPoint(tieThresholdByProfile['WR-SHORT-PS']),
    'WR-LONGHAUL-EXP': toPoint(tieThresholdByProfile['WR-LONGHAUL-EXP']),
  };
};

const deriveProfileThresholds = (
  tieThresholdByProfile: Record<ProfileId, number>,
): Record<ProfileId, TimingProfileThresholds> => {
  return {
    'WR-SHORT-PS': {
      sigma_t_ps_max: sigmaBoundByProfile['WR-SHORT-PS'],
      tie_pp_ps_max: tieThresholdByProfile['WR-SHORT-PS'],
      pdv_pp_ps_max: null,
    },
    'WR-LONGHAUL-EXP': {
      sigma_t_ps_max: sigmaBoundByProfile['WR-LONGHAUL-EXP'],
      tie_pp_ps_max: tieThresholdByProfile['WR-LONGHAUL-EXP'],
      pdv_pp_ps_max: null,
    },
  };
};

const deriveUncertainty = (rows: RegistryRow[], rowsById: Map<string, RegistryRow>, refs: string[]) => {
  const strictRows = rows.filter(
    (row) =>
      refs.includes(row.entry_id.toUpperCase()) &&
      String(row.status).toLowerCase() === 'extracted' &&
      ['primary', 'standard'].includes(String(row.source_class).toLowerCase()),
  );
  const numericUncertaintyRows = strictRows.filter((row) => {
    const normalized = String(row.uncertainty).trim().toLowerCase();
    return normalized.length > 0 && !['unknown', 'n/a', 'na', 'none', 'null'].includes(normalized);
  });

  const namedSigma = parseUncertaintyPs(rowsById.get('EXP-T-030'), { preferValueField: true });
  const namedTie = parseUncertaintyPs(rowsById.get('EXP-T-031'), { preferValueField: true });
  const fallbackUncertainties = numericUncertaintyRows
    .map((row) => parseUncertaintyPs(row))
    .filter((value): value is number => value != null);
  const fallbackSigma = fallbackUncertainties[0] ?? null;
  const fallbackTie = fallbackUncertainties[1] ?? fallbackUncertainties[0] ?? null;

  const uSigmaPs = namedSigma ?? fallbackSigma;
  const uTiePs = namedTie ?? uSigmaPs ?? fallbackTie;
  const blockedReasons: string[] = [];
  if (uSigmaPs == null) blockedReasons.push('missing_u_sigma_t_ps_anchor');
  if (uTiePs == null) blockedReasons.push('missing_u_tie_pp_ps_anchor');

  const reportableReady = blockedReasons.length === 0;
  if (!reportableReady) blockedReasons.push('missing_numeric_uncertainty_anchor');

  const method =
    namedSigma != null || namedTie != null
      ? 'registry_named_uncertainty_anchor'
      : reportableReady
        ? 'registry_numeric_uncertainty_anchor'
        : 'conservative_fallback_missing_numeric';

  return {
    reportableReady,
    blockedReasons,
    method,
    uSigmaPs,
    uTiePs,
  };
};

export const buildTimingScenarioPacks = (options: {
  registryPath?: string;
  basePath?: string;
  pass1OutPath?: string;
  pass2OutPath?: string;
  reportableOutPath?: string;
  reportableReferenceOutPath?: string;
}) => {
  const registryPath = options.registryPath ?? DEFAULT_REGISTRY_PATH;
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;
  const pass1OutPath = options.pass1OutPath ?? DEFAULT_PASS1_OUT;
  const pass2OutPath = options.pass2OutPath ?? DEFAULT_PASS2_OUT;
  const reportableOutPath = options.reportableOutPath ?? DEFAULT_REPORTABLE_OUT;
  const reportableReferenceOutPath = options.reportableReferenceOutPath ?? DEFAULT_REPORTABLE_REFERENCE_OUT;

  const registryRows = parseRegistryRows(fs.readFileSync(registryPath, 'utf8'));
  const rowsById = new Map(registryRows.map((row) => [row.entry_id.toUpperCase(), row]));
  const basePack = JSON.parse(fs.readFileSync(basePath, 'utf8')) as BaseScenarioPack;

  const baseRefs = new Set<string>();
  for (const scenario of basePack.scenarios ?? []) {
    for (const ref of scenario.registryRefs ?? []) baseRefs.add(String(ref).trim().toUpperCase());
  }

  const orderedRequiredRefs = ['EXP-T-001', 'EXP-T-003', 'EXP-T-002', 'EXP-T-004', 'EXP-T-029'];
  const orderedUncertaintyRefs = ['EXP-T-030', 'EXP-T-031'].filter((entryId) => rowsById.has(entryId));
  for (const required of [...orderedRequiredRefs, ...orderedUncertaintyRefs]) baseRefs.add(required);
  const extraRefs = [...baseRefs]
    .filter((ref) => !orderedRequiredRefs.includes(ref) && !orderedUncertaintyRefs.includes(ref))
    .sort((a, b) => a.localeCompare(b));
  const registryRefs = [...orderedRequiredRefs, ...orderedUncertaintyRefs, ...extraRefs];

  const sigmaGrid = deriveSigmaGrid(rowsById);
  const tieThresholdByProfile = deriveTieThresholdByProfile(rowsById);
  const tiePointByProfile = deriveTiePointByProfile(tieThresholdByProfile);
  const profileThresholds = deriveProfileThresholds(tieThresholdByProfile);
  const uncertainty = deriveUncertainty(registryRows, rowsById, registryRefs);

  const baseEnvelopePack = {
    version: 1,
    mode: 'shadow_non_blocking',
    boundaryStatement: basePack.boundaryStatement ?? BOUNDARY_STATEMENT,
    recovery_goal: 'timing_compatibility_recovery',
    success_bar: 'map_only',
    baseline_reference: {
      path: `artifacts/research/full-solve/shadow-injection-run-generated-${DATE_STAMP}.json`,
      keys: [
        'marginRatioRaw',
        'marginRatioRawComputed',
        'applicabilityStatus',
        'congruentSolvePass',
        'congruentSolveFailReasons',
        'sampler',
        'fieldType',
        'tauSelected_s',
      ],
    },
    notes: [
      'Primary/standard timing evidence only.',
      'Non-blocking compatibility envelope mapping lane.',
      'No canonical override or promotion implied.',
      'Sweep dimensions are sigma_t_ps x profile_id.',
    ],
    profileThresholds,
  };

  const pass1Scenarios = PROFILE_IDS.flatMap((profileId) =>
    sigmaGrid.map((sigmaPs) => ({
      id: `ti_primary_${profileId.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_sigma_${toIdToken(sigmaPs)}ps`,
      lane: 'timing',
      description: `Pass-1 timing envelope: profile=${profileId}, sigma_t_ps=${sigmaPs}.`,
      registryRefs,
      overrides: {
        params: {
          clocking: {
            tauLC_ms: 3.34,
            tauPulse_ms: 0.00001,
            metricDerived: true,
            metricDerivedSource: 'shadow_builder_timing',
            metricDerivedReason: 'timing_profile_sigma_sweep',
          },
        },
      },
    })),
  );

  const pass2Scenarios = PROFILE_IDS.flatMap((profileId) =>
    sigmaGrid.map((sigmaPs) => ({
      id: `ti_primary_typed_${profileId.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_sigma_${toIdToken(sigmaPs)}ps`,
      lane: 'timing',
      description: `Pass-2 typed timing envelope: profile=${profileId}, sigma_t_ps=${sigmaPs}.`,
      registryRefs,
      overrides: {
        params: {
          clocking: {
            tauLC_ms: 3.34,
            tauPulse_ms: 0.00001,
            metricDerived: true,
            metricDerivedSource: 'shadow_builder_timing',
            metricDerivedReason: 'timing_profile_sigma_sweep',
          },
        },
      },
      experimentalContext: {
        timing: {
          profileId,
          sigma_t_ps: sigmaPs,
          tie_pp_ps: tiePointByProfile[profileId],
          pdv_pp_ps: null,
          timestamping_mode: 'hardware',
          synce_enabled: profileId === 'WR-SHORT-PS',
          clock_mode: 'transparent',
          topology_class: profileId === 'WR-SHORT-PS' ? 'wr_short_fiber' : 'wr_longhaul_unrepeated',
          sourceRefs: registryRefs,
          uncertainty: {
            u_sigma_t_ps: uncertainty.uSigmaPs,
            u_tie_pp_ps: uncertainty.uTiePs,
            u_pdv_pp_ps: null,
            method: uncertainty.method,
            reportableReady: uncertainty.reportableReady,
            blockedReasons: uncertainty.blockedReasons,
          },
        },
      },
    })),
  );

  const pickReferenceId = (profileId: ProfileId): string => {
    const targetSigma =
      profileId === 'WR-SHORT-PS'
        ? Math.max(1, Math.floor(((profileThresholds['WR-SHORT-PS'].sigma_t_ps_max ?? 100) - (uncertainty.uSigmaPs ?? 0)) / 2))
        : sigmaGrid[0] ?? 6;
    const profileScenarios = pass2Scenarios.filter(
      (scenario) => scenario.experimentalContext.timing.profileId === profileId,
    );
    const best = profileScenarios.reduce((acc, scenario) => {
      const sigma = Number(scenario.experimentalContext.timing.sigma_t_ps);
      if (!acc) return { id: scenario.id, dist: Math.abs(sigma - targetSigma) };
      const dist = Math.abs(sigma - targetSigma);
      if (dist < acc.dist) return { id: scenario.id, dist };
      return acc;
    }, null as null | { id: string; dist: number });
    return best?.id ?? profileScenarios[0]?.id ?? '';
  };

  const stableCitationTargetScenarioIds = PROFILE_IDS.map((profileId) => pickReferenceId(profileId)).filter(
    (value) => value.length > 0,
  );

  const pass1Payload = {
    ...baseEnvelopePack,
    pass: 'pass_1_existing_knobs',
    dimensions: {
      sigma_t_ps: sigmaGrid,
      profile_id: [...PROFILE_IDS],
    },
    scenarios: pass1Scenarios,
  };

  const pass2Payload = {
    ...baseEnvelopePack,
    pass: 'pass_2_typed_context',
    dimensions: {
      sigma_t_ps: sigmaGrid,
      profile_id: [...PROFILE_IDS],
    },
    scenarios: pass2Scenarios,
  };

  const reportablePayload = {
    ...pass2Payload,
    profile: 'ti_primary_reportable_v1',
    preRegistrationProfile: {
      profileId: 'ti-primary-reportable-v1',
      lockedOn: DATE_STAMP,
      lane: 'timing',
      sourceClassAllowlist: ['primary', 'standard'],
      lockedRegistryRefs: registryRefs,
      lockedSigmaGridPs: sigmaGrid,
      lockedProfileIds: [...PROFILE_IDS],
      profileThresholds,
      uncertainty: {
        u_sigma_t_ps: uncertainty.uSigmaPs,
        u_tie_pp_ps: uncertainty.uTiePs,
        u_pdv_pp_ps: null,
        method: uncertainty.method,
        sourceRefs: registryRefs,
      },
      reportableReady: uncertainty.reportableReady,
      blockedReasons: uncertainty.blockedReasons,
      stableCitationTargetProfileId: 'ti-primary-reportable-reference-v1',
      stableCitationTargetScenarioIds,
    },
  };

  const reportableReferencePayload = {
    ...pass2Payload,
    profile: 'ti_primary_reportable_reference_v1',
    reportableReferenceProfile: {
      profileId: 'ti-primary-reportable-reference-v1',
      lockedOn: DATE_STAMP,
      lane: 'timing',
      sourceClassAllowlist: ['primary', 'standard'],
      selectionPolicy: 'interior_congruent_target',
      scenarioIds: stableCitationTargetScenarioIds,
      sourceRefs: registryRefs,
      reportableReady: uncertainty.reportableReady,
      blockedReasons: uncertainty.blockedReasons,
    },
    scenarios: pass2Scenarios.filter((scenario) => stableCitationTargetScenarioIds.includes(scenario.id)),
  };

  fs.mkdirSync(path.dirname(pass1OutPath), { recursive: true });
  fs.writeFileSync(pass1OutPath, `${JSON.stringify(pass1Payload, null, 2)}\n`);
  fs.writeFileSync(pass2OutPath, `${JSON.stringify(pass2Payload, null, 2)}\n`);
  fs.writeFileSync(reportableOutPath, `${JSON.stringify(reportablePayload, null, 2)}\n`);
  fs.writeFileSync(reportableReferenceOutPath, `${JSON.stringify(reportableReferencePayload, null, 2)}\n`);

  return {
    ok: true,
    out: {
      pass1: pass1OutPath,
      pass2: pass2OutPath,
      reportable: reportableOutPath,
      reportableReference: reportableReferenceOutPath,
    },
    summary: {
      sigmaGrid,
      profileGrid: [...PROFILE_IDS],
      scenarioCount: pass2Scenarios.length,
      reportableReady: uncertainty.reportableReady,
      blockedReasons: uncertainty.blockedReasons,
      stableCitationTargetScenarioIds,
    },
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = buildTimingScenarioPacks({
    registryPath: readArgValue('--registry') ?? DEFAULT_REGISTRY_PATH,
    basePath: readArgValue('--base') ?? DEFAULT_BASE_PATH,
    pass1OutPath: readArgValue('--out-pass1') ?? DEFAULT_PASS1_OUT,
    pass2OutPath: readArgValue('--out-pass2') ?? DEFAULT_PASS2_OUT,
    reportableOutPath: readArgValue('--out-reportable') ?? DEFAULT_REPORTABLE_OUT,
    reportableReferenceOutPath: readArgValue('--out-reportable-reference') ?? DEFAULT_REPORTABLE_REFERENCE_OUT,
  });
  console.log(JSON.stringify(result, null, 2));
}
