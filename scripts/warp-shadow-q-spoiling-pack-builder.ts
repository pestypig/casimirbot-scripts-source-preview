import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_REGISTRY_PATH = path.join(
  'docs',
  'specs',
  'casimir-tile-experimental-parameter-registry-2026-03-04.md',
);
const DEFAULT_BASE_PATH = path.join('configs', 'warp-shadow-injection-scenarios.qs-primary-recovery.v1.json');
const DEFAULT_PASS1_OUT = path.join('configs', 'warp-shadow-injection-scenarios.qs-primary-recovery.v1.json');
const DEFAULT_PASS2_OUT = path.join('configs', 'warp-shadow-injection-scenarios.qs-primary-typed.v1.json');
const DEFAULT_REPORTABLE_OUT = path.join('configs', 'warp-shadow-injection-scenarios.qs-primary-reportable.v1.json');
const DEFAULT_REPORTABLE_REFERENCE_OUT = path.join(
  'configs',
  'warp-shadow-injection-scenarios.qs-primary-reportable-reference.v1.json',
);
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const MECHANISM_LANES = ['hydride_q_disease', 'trapped_flux', 'tls_oxide'] as const;
type MechanismLane = (typeof MECHANISM_LANES)[number];

type RegistryRow = {
  entry_id: string;
  value: string;
  uncertainty: string;
  source_class: string;
  source_id: string;
  parameter: string;
  conditions: string;
  maps_to_spec: string;
  status: string;
};

type BaseScenarioPack = {
  boundaryStatement?: string;
  scenarios?: Array<{
    registryRefs?: string[];
  }>;
};

type MechanismThresholds = {
  mechanismLane: MechanismLane;
  q0_clean_floor: number;
  q0_spoiled_ceiling: number;
  f_q_spoil_floor: number;
  thresholdDerivation: string;
  sourceRefs: string[];
};

type MechanismUncertainty = {
  mechanismLane: MechanismLane;
  uRel: number;
  sourceRefs: string[];
  method: string;
  reportableReady: boolean;
  blockedReasons: string[];
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

const toIdToken = (value: number): string =>
  Number(value).toExponential(0).replace('+', '').replace('-', 'm').replace('.', 'p');

const uniqueSorted = (values: number[]): number[] =>
  [...new Set(values.map((value) => Number(value.toPrecision(6))))].sort((a, b) => a - b);

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
      source_id: cells[1],
      parameter: cells[2],
      value: cells[3],
      uncertainty: cells[5],
      conditions: cells[6],
      source_class: cells[9],
      maps_to_spec: cells[10],
      status: cells[11],
    });
  }
  return rows;
};

const parseRelativeCandidate = (raw: string): number | null => {
  const text = String(raw);
  const normalized = text.trim().toLowerCase();
  if (!normalized || ['unknown', 'n/a', 'na', 'none', 'null'].includes(normalized)) return null;

  // Prefer explicit percent tokens when present.
  const percentMatch = text.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (percentMatch) {
    const value = Number(percentMatch[1]);
    if (Number.isFinite(value) && value > 0) return Number((value / 100).toFixed(6));
  }

  const values = parseNumberCandidates(text).filter((value) => value > 0);
  if (!values.length) return null;

  // Avoid treating coverage factors (e.g., "k=1") as relative uncertainty.
  const hasCoverageFactor = /\bk\s*=/.test(normalized);
  if (hasCoverageFactor) {
    const nonUnity = values.filter((value) => Math.abs(value - 1) > 1e-12);
    if (!nonUnity.length) return null;
    const best = nonUnity[0];
    if (best <= 1) return Number(best.toFixed(6));
    if (best <= 100) return Number((best / 100).toFixed(6));
    return null;
  }

  const value = values[0];
  if (value <= 1) return Number(value.toFixed(6));
  if (value <= 100) return Number((value / 100).toFixed(6));
  return null;
};

const getRowById = (rowsById: Map<string, RegistryRow>, entryId: string): RegistryRow | null =>
  rowsById.get(entryId.toUpperCase()) ?? null;

const getThresholdsByMechanism = (rowsById: Map<string, RegistryRow>): Record<MechanismLane, MechanismThresholds> => {
  const q0HydrideClean = parsePositiveValue(getRowById(rowsById, 'EXP-Q-001')?.value ?? '') ?? 2e10;
  const q0HydrideSpoiled = parsePositiveValue(getRowById(rowsById, 'EXP-Q-002')?.value ?? '') ?? 1e9;
  const hydrideFloor = q0HydrideClean / q0HydrideSpoiled;

  const q0FluxClean =
    parsePositiveValue(getRowById(rowsById, 'EXP-Q-003')?.value ?? '') ??
    parsePositiveValue(getRowById(rowsById, 'EXP-Q-001')?.value ?? '') ??
    1.8e10;
  const fluxLow = parsePositiveValue(getRowById(rowsById, 'EXP-Q-004')?.value ?? '') ?? 0.9;
  const fluxHigh = parsePositiveValue(getRowById(rowsById, 'EXP-Q-005')?.value ?? '') ?? 3.9;
  const fluxFloor = Math.max(1, fluxHigh / Math.max(fluxLow, 1e-9));
  const q0FluxSpoiled = q0FluxClean / fluxFloor;

  const q0TlsClean = parsePositiveValue(getRowById(rowsById, 'EXP-Q-001')?.value ?? '') ?? 2e10;
  const ecRange = parseNumberCandidates(getRowById(rowsById, 'EXP-Q-014')?.value ?? '').filter((value) => value > 0);
  const betaRange = parseNumberCandidates(getRowById(rowsById, 'EXP-Q-015')?.value ?? '').filter((value) => value > 0);
  const ecFloor = ecRange.length >= 2 ? Math.max(ecRange[1] / Math.max(ecRange[0], 1e-9), 1) : 1;
  const betaFloor = betaRange.length >= 2 ? Math.max(betaRange[1] / Math.max(betaRange[0], 1e-9), 1) : 1;
  const tlsFloor = Math.max(ecFloor, betaFloor, 1);
  const q0TlsSpoiled = q0TlsClean / tlsFloor;

  return {
    hydride_q_disease: {
      mechanismLane: 'hydride_q_disease',
      q0_clean_floor: q0HydrideClean,
      q0_spoiled_ceiling: q0HydrideSpoiled,
      f_q_spoil_floor: hydrideFloor,
      thresholdDerivation: 'EXP-Q-001 / EXP-Q-002 measured hydride pair',
      sourceRefs: ['EXP-Q-001', 'EXP-Q-002'],
    },
    trapped_flux: {
      mechanismLane: 'trapped_flux',
      q0_clean_floor: q0FluxClean,
      q0_spoiled_ceiling: q0FluxSpoiled,
      f_q_spoil_floor: fluxFloor,
      thresholdDerivation: 'EXP-Q-003 baseline with flux-sensitivity spread ratio EXP-Q-005 / EXP-Q-004',
      sourceRefs: ['EXP-Q-003', 'EXP-Q-004', 'EXP-Q-005'],
    },
    tls_oxide: {
      mechanismLane: 'tls_oxide',
      q0_clean_floor: q0TlsClean,
      q0_spoiled_ceiling: q0TlsSpoiled,
      f_q_spoil_floor: tlsFloor,
      thresholdDerivation: 'TLS fit-range spread from EXP-Q-014/EXP-Q-015',
      sourceRefs: ['EXP-Q-001', 'EXP-Q-014', 'EXP-Q-015'],
    },
  };
};

const getMechanismUncertaintyRows = (rowsById: Map<string, RegistryRow>): Record<MechanismLane, RegistryRow | null> => ({
  hydride_q_disease: getRowById(rowsById, 'EXP-Q-020'),
  trapped_flux: getRowById(rowsById, 'EXP-Q-021'),
  tls_oxide: getRowById(rowsById, 'EXP-Q-022'),
});

const toMechanismUncertainty = (input: {
  mechanismLane: MechanismLane;
  row: RegistryRow | null;
  allowedSourceClasses: Set<string>;
}): MechanismUncertainty => {
  const fallbackRel = 0.3;
  const valueRel = input.row ? parseRelativeCandidate(input.row.value) : null;
  const uncertaintyRel = input.row ? parseRelativeCandidate(input.row.uncertainty) : null;
  const uRel = Math.min(0.8, Math.max(0.01, valueRel ?? uncertaintyRel ?? fallbackRel));

  const blockedReasons: string[] = [];
  const extracted = input.row != null && String(input.row.status).toLowerCase() === 'extracted';
  if (!input.row || !extracted) blockedReasons.push(`missing_numeric_uncertainty_anchor:${input.mechanismLane}`);

  const sourceClass = String(input.row?.source_class ?? '').toLowerCase();
  const sourceAllowed = sourceClass.length > 0 && input.allowedSourceClasses.has(sourceClass);
  if (input.row && !sourceAllowed) blockedReasons.push(`uncertainty_anchor_source_class_not_allowed:${input.mechanismLane}`);

  const reportableReady = blockedReasons.length === 0;

  return {
    mechanismLane: input.mechanismLane,
    uRel,
    sourceRefs: input.row ? [input.row.entry_id] : [],
    method:
      input.row && valueRel != null
        ? 'measured_spread_registry_anchor'
        : input.row && uncertaintyRel != null
          ? 'reported_uncertainty_registry_anchor'
          : 'conservative_fallback_missing_numeric',
    reportableReady,
    blockedReasons,
  };
};

const getMechanismRefs = (baseRefs: string[], lane: MechanismLane): string[] => {
  const requiredByLane: Record<MechanismLane, string[]> = {
    hydride_q_disease: ['EXP-Q-001', 'EXP-Q-002', 'EXP-Q-020'],
    trapped_flux: ['EXP-Q-003', 'EXP-Q-004', 'EXP-Q-005', 'EXP-Q-021'],
    tls_oxide: ['EXP-Q-001', 'EXP-Q-014', 'EXP-Q-015', 'EXP-Q-022'],
  };
  const refs = new Set<string>(baseRefs.map((ref) => ref.toUpperCase()));
  for (const required of requiredByLane[lane]) refs.add(required);
  return [...refs].sort((a, b) => a.localeCompare(b));
};

const buildReferenceScenarioId = (lane: MechanismLane, q0: number, f: number): string =>
  `qs_primary_typed_${lane}_q0_${toIdToken(q0)}_f_${toIdToken(f)}`.toLowerCase();

export const buildQSpoilingScenarioPacks = (options: {
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
  const orderedRequiredRefs = ['EXP-Q-001', 'EXP-Q-002'];
  for (const required of orderedRequiredRefs) baseRefs.add(required);

  const thresholdMap = getThresholdsByMechanism(rowsById);
  const allowedSourceClasses = new Set(['primary', 'standard']);
  const uncertaintyRows = getMechanismUncertaintyRows(rowsById);
  const uncertaintyMap: Record<MechanismLane, MechanismUncertainty> = {
    hydride_q_disease: toMechanismUncertainty({
      mechanismLane: 'hydride_q_disease',
      row: uncertaintyRows.hydride_q_disease,
      allowedSourceClasses,
    }),
    trapped_flux: toMechanismUncertainty({
      mechanismLane: 'trapped_flux',
      row: uncertaintyRows.trapped_flux,
      allowedSourceClasses,
    }),
    tls_oxide: toMechanismUncertainty({
      mechanismLane: 'tls_oxide',
      row: uncertaintyRows.tls_oxide,
      allowedSourceClasses,
    }),
  };

  const q0Grid = uniqueSorted([1.0e10, 2.0e10, 3.0e10]);
  const fQSpoolGrid = uniqueSorted([1, 3, 10, 20, 40, 80]);

  const mechanismRefsMap: Record<MechanismLane, string[]> = {
    hydride_q_disease: getMechanismRefs([...baseRefs], 'hydride_q_disease'),
    trapped_flux: getMechanismRefs([...baseRefs], 'trapped_flux'),
    tls_oxide: getMechanismRefs([...baseRefs], 'tls_oxide'),
  };

  const pass1Scenarios = MECHANISM_LANES.flatMap((mechanismLane) =>
    q0Grid.flatMap((q0) =>
      fQSpoolGrid.map((fQSpool) => ({
        id: `qs_primary_${mechanismLane}_q0_${toIdToken(q0)}_f_${toIdToken(fQSpool)}`.toLowerCase(),
        lane: 'q_spoiling',
        description: `Pass-1 q-spoiling envelope: mechanism=${mechanismLane}, q0=${q0}, f_q_spoil=${fQSpool}.`,
        registryRefs: mechanismRefsMap[mechanismLane],
        overrides: {
          params: {
            qCavity: q0,
            qSpoilingFactor: fQSpool,
          },
          qi: {
            fieldType: 'em',
          },
        },
      })),
    ),
  );

  const pass2Scenarios = MECHANISM_LANES.flatMap((mechanismLane) =>
    q0Grid.flatMap((q0) =>
      fQSpoolGrid.map((fQSpool) => {
        const mechanismUncertainty = uncertaintyMap[mechanismLane];
        const mechanismThresholds = thresholdMap[mechanismLane];
        const q0Spoiled = Number((q0 / fQSpool).toPrecision(6));
        const qSpoilRatio = Number((q0 / Math.max(q0Spoiled, Number.EPSILON)).toPrecision(6));
        return {
          id: buildReferenceScenarioId(mechanismLane, q0, fQSpool),
          lane: 'q_spoiling',
          description: `Pass-2 typed q-spoiling envelope: mechanism=${mechanismLane}, q0=${q0}, f_q_spoil=${fQSpool}.`,
          registryRefs: mechanismRefsMap[mechanismLane],
          overrides: {
            params: {
              qCavity: q0,
              qSpoilingFactor: fQSpool,
            },
            qi: {
              fieldType: 'em',
            },
          },
          experimentalContext: {
            qSpoiling: {
              mechanismLane,
              q0Baseline: q0,
              f_q_spoil: fQSpool,
              q0Spoiled,
              q_spoil_ratio: qSpoilRatio,
              q_spoil_ratio_anchor: 'derived_q0_baseline_over_q0_spoiled',
              sourceRefs: mechanismRefsMap[mechanismLane],
              uncertainty: {
                u_q0_rel: Number(mechanismUncertainty.uRel.toFixed(6)),
                u_f_rel: Number(mechanismUncertainty.uRel.toFixed(6)),
                method: mechanismUncertainty.method,
                reportableReady: mechanismUncertainty.reportableReady,
                blockedReasons: mechanismUncertainty.blockedReasons,
                sourceRefs: mechanismUncertainty.sourceRefs,
              },
              thresholds: mechanismThresholds,
            },
          },
        };
      }),
    ),
  );

  const referenceScenarioIds = [
    buildReferenceScenarioId('hydride_q_disease', 2.0e10, 20),
    buildReferenceScenarioId('trapped_flux', 2.0e10, 10),
    buildReferenceScenarioId('tls_oxide', 2.0e10, 20),
  ];
  const referenceScenarios = pass2Scenarios.filter((scenario) => referenceScenarioIds.includes(scenario.id));

  const reportableBlockedReasons = MECHANISM_LANES.flatMap((mechanismLane) => uncertaintyMap[mechanismLane].blockedReasons);
  const reportableReady = reportableBlockedReasons.length === 0;

  const baseEnvelopePack = {
    version: 1,
    mode: 'shadow_non_blocking',
    boundaryStatement: basePack.boundaryStatement ?? BOUNDARY_STATEMENT,
    recovery_goal: 'q_spoiling_recovery',
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
      'Q-spoiling mechanism lanes are split into hydride/Q-disease, trapped-flux, and TLS/oxide.',
      'Mechanism uncertainty anchors are measurement-led (`EXP-Q-020..EXP-Q-022`) and replace the prior policy-only uncertainty anchor.',
      'Non-blocking compatibility envelope mapping lane; canonical campaign remains unchanged.',
      reportableReady
        ? 'Reportable profile readiness: all mechanism uncertainty anchors satisfy source-policy constraints.'
        : 'Reportable profile readiness: frozen profile generated but blocked until all mechanism uncertainty anchors satisfy source-policy constraints.',
    ],
  };

  const pass1Payload = {
    ...baseEnvelopePack,
    pass: 'pass_1_existing_knobs',
    dimensions: {
      mechanism_lane: MECHANISM_LANES,
      q0: q0Grid,
      f_q_spoil: fQSpoolGrid,
      fieldType: 'em',
    },
    thresholdsByMechanism: thresholdMap,
    scenarios: pass1Scenarios,
  };

  const pass2Payload = {
    ...baseEnvelopePack,
    pass: 'pass_2_typed_context',
    dimensions: {
      mechanism_lane: MECHANISM_LANES,
      q0: q0Grid,
      f_q_spoil: fQSpoolGrid,
      fieldType: 'em',
    },
    thresholdsByMechanism: thresholdMap,
    scenarios: pass2Scenarios,
  };

  const reportablePayload = {
    ...pass2Payload,
    profile: 'qs_primary_reportable_v1',
    preRegistrationProfile: {
      profileId: 'qs-primary-reportable-v1',
      lockedOn: DATE_STAMP,
      lane: 'q_spoiling',
      sourceClassAllowlist: ['primary', 'standard'],
      lockedMechanismLanes: MECHANISM_LANES,
      lockedRegistryRefsByMechanism: mechanismRefsMap,
      lockedQ0Grid: q0Grid,
      lockedFQSpoolGrid: fQSpoolGrid,
      lockedFieldType: 'em',
      thresholdsByMechanism: thresholdMap,
      uncertaintyByMechanism: uncertaintyMap,
      reportableReady,
      blockedReasons: reportableBlockedReasons,
      stableCitationTargetProfileId: 'qs-primary-reportable-reference-v1',
      stableCitationTargetScenarioIds: referenceScenarioIds,
    },
    reportableReferenceProfile: {
      profileId: 'qs-primary-reportable-reference-v1',
      stableCitationTarget: true,
      referenceScenarioIds,
      referenceScenarioCount: referenceScenarioIds.length,
      citationPackPath: DEFAULT_REPORTABLE_REFERENCE_OUT,
      note: 'Use this fixed scenario-id set as manuscript-stable citation target across reruns.',
    },
  };

  const reportableReferencePayload = {
    ...baseEnvelopePack,
    pass: 'reportable_reference_profile',
    profile: 'qs_primary_reportable_reference_v1',
    dimensions: {
      mechanism_lane: MECHANISM_LANES,
      q0: [2.0e10],
      f_q_spoil: [10, 20],
      fieldType: 'em',
    },
    thresholdsByMechanism: thresholdMap,
    preRegistrationProfile: {
      profileId: 'qs-primary-reportable-reference-v1',
      lockedOn: DATE_STAMP,
      lane: 'q_spoiling',
      sourceClassAllowlist: ['primary', 'standard'],
      lockedScenarioIds: referenceScenarioIds,
      reportableReady,
      blockedReasons: reportableBlockedReasons,
    },
    scenarios: referenceScenarios,
  };

  fs.mkdirSync(path.dirname(pass1OutPath), { recursive: true });
  fs.writeFileSync(pass1OutPath, `${JSON.stringify(pass1Payload, null, 2)}\n`);
  fs.mkdirSync(path.dirname(pass2OutPath), { recursive: true });
  fs.writeFileSync(pass2OutPath, `${JSON.stringify(pass2Payload, null, 2)}\n`);
  fs.mkdirSync(path.dirname(reportableOutPath), { recursive: true });
  fs.writeFileSync(reportableOutPath, `${JSON.stringify(reportablePayload, null, 2)}\n`);
  fs.mkdirSync(path.dirname(reportableReferenceOutPath), { recursive: true });
  fs.writeFileSync(reportableReferenceOutPath, `${JSON.stringify(reportableReferencePayload, null, 2)}\n`);

  return {
    ok: true,
    pass1OutPath,
    pass2OutPath,
    reportableOutPath,
    reportableReferenceOutPath,
    q0Grid,
    fQSpoolGrid,
    mechanismLanes: MECHANISM_LANES,
    reportableReady,
    blockedReasons: reportableBlockedReasons,
    referenceScenarioIds,
    scenarioCounts: {
      pass1: pass1Scenarios.length,
      pass2: pass2Scenarios.length,
      reportable: pass2Scenarios.length,
      reportableReference: referenceScenarios.length,
    },
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = buildQSpoilingScenarioPacks({
    registryPath: readArgValue('--registry') ?? DEFAULT_REGISTRY_PATH,
    basePath: readArgValue('--base') ?? DEFAULT_BASE_PATH,
    pass1OutPath: readArgValue('--out-pass1') ?? DEFAULT_PASS1_OUT,
    pass2OutPath: readArgValue('--out-pass2') ?? DEFAULT_PASS2_OUT,
    reportableOutPath: readArgValue('--out-reportable') ?? DEFAULT_REPORTABLE_OUT,
    reportableReferenceOutPath: readArgValue('--out-reportable-reference') ?? DEFAULT_REPORTABLE_REFERENCE_OUT,
  });
  console.log(JSON.stringify(result, null, 2));
}
