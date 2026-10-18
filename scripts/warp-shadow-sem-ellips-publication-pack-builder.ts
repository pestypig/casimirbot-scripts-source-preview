import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_REGISTRY_PATH = path.join(
  'docs',
  'specs',
  'casimir-tile-experimental-parameter-registry-2026-03-04.md',
);
const DEFAULT_OUT_PATH = path.join('configs', 'warp-shadow-injection-scenarios.se-publication-typed.v1.json');
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const PROFILE_IDS = ['SE-STD-2', 'SE-ADV-1'] as const;
const PROFILE_BOUNDS_NM = {
  'SE-STD-2': 2.0,
  'SE-ADV-1': 1.0,
} as const;

type ProfileId = (typeof PROFILE_IDS)[number];

type RegistryRow = {
  entry_id: string;
  source_class: string;
  status: string;
  parameter: string;
  value: string;
  unit: string;
  uncertainty: string;
  maps_to_spec: string;
};

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const parseRegistryRows = (markdown: string): RegistryRow[] => {
  const rows: RegistryRow[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('| EXP-SE-')) continue;
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
      uncertainty: cells[5],
      source_class: cells[9],
      maps_to_spec: cells[10],
      status: cells[11],
    });
  }
  return rows;
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

const pickFirstPositive = (values: number[]): number | null => values.find((value) => value > 0) ?? null;

const toIdToken = (value: number): string => {
  const rounded = Number(value.toFixed(3));
  const token = Number.isInteger(rounded) ? String(rounded) : String(rounded).replace('.', 'p');
  return token.replace('-', 'm');
};

const buildScenarioId = (profileId: ProfileId, label: string, deltaSeNm: number, uFusedNm: number): string =>
  `se_publication_typed_${profileId.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${label}_delta_${toIdToken(
    deltaSeNm,
  )}_u_${toIdToken(uFusedNm)}`
    .replace(/__+/g, '_')
    .toLowerCase();

const deriveAnchors = (rows: RegistryRow[]) => {
  const byId = new Map(rows.map((row) => [row.entry_id.toUpperCase(), row]));
  const row41 = byId.get('EXP-SE-041');
  const row40 = byId.get('EXP-SE-040');
  const row18 = byId.get('EXP-SE-018');
  const row39 = byId.get('EXP-SE-039');

  const deltaBaseline = pickFirstPositive(parseNumberCandidates(row41?.value ?? '')) ?? 3;
  const deltaStress = pickFirstPositive(parseNumberCandidates(row18?.value ?? '')) ?? 46;
  const uBaseline =
    pickFirstPositive(parseNumberCandidates(row39?.uncertainty ?? '')) ??
    pickFirstPositive(parseNumberCandidates(row39?.value ?? '')) ??
    1.2;
  const uStress = pickFirstPositive(parseNumberCandidates(row40?.value ?? '')) ?? 3.8;

  return {
    deltaBaseline: Number(deltaBaseline.toFixed(6)),
    deltaStress: Number(deltaStress.toFixed(6)),
    uBaseline: Number(uBaseline.toFixed(6)),
    uStress: Number(uStress.toFixed(6)),
  };
};

const deriveTypedContext = (
  input: { profileId: ProfileId; deltaSeNm: number; uFusedNm: number; label: string; refs: string[] },
) => {
  const dEllipNm = 100;
  const dSemCorrNm = Number((dEllipNm + input.deltaSeNm).toFixed(6));
  const uFusedStdNm = Number((input.uFusedNm / 2).toFixed(6));
  const uInstrumentNm = Number((Math.max(0.05, uFusedStdNm * Math.SQRT2)).toFixed(6));
  const dFusedNm = Number(((dSemCorrNm + dEllipNm) / 2).toFixed(6));

  return {
    profileId: input.profileId,
    d_sem_corr_nm: dSemCorrNm,
    u_sem_nm: uInstrumentNm,
    d_ellip_nm: dEllipNm,
    u_ellip_nm: uInstrumentNm,
    delta_se_nm: Number(input.deltaSeNm.toFixed(6)),
    d_fused_nm: dFusedNm,
    u_fused_nm: uFusedStdNm,
    U_fused_nm: Number(input.uFusedNm.toFixed(6)),
    sourceRefs: input.refs,
    uncertainty: {
      method: 'publication_cross_study_synthesis',
      reportableReady: false,
      blockedReasons: ['publication_cross_study_not_paired_instrument_design', 'reference_only_overlay'],
      sourceRefs: input.refs,
    },
    publicationOverlay: {
      profileLabel: input.label,
      sourceMode: 'multi_study_overlay',
      lanePosture: 'reference_only',
    },
  };
};

export const buildSemEllipsPublicationOverlayPack = (options: {
  registryPath?: string;
  outPath?: string;
}) => {
  const registryPath = options.registryPath ?? DEFAULT_REGISTRY_PATH;
  const outPath = options.outPath ?? DEFAULT_OUT_PATH;
  const registryRows = parseRegistryRows(fs.readFileSync(registryPath, 'utf8'));

  const selectedRows = registryRows
    .filter((row) => ['primary', 'standard'].includes(String(row.source_class).toLowerCase()))
    .filter((row) => String(row.status).toLowerCase() === 'extracted')
    .sort((a, b) => a.entry_id.localeCompare(b.entry_id));

  const selectedRefSet = new Set(selectedRows.map((row) => row.entry_id.toUpperCase()));
  const requiredRefs = [
    'EXP-SE-001',
    'EXP-SE-002',
    'EXP-SE-003',
    'EXP-SE-009',
    'EXP-SE-012',
    'EXP-SE-013',
    'EXP-SE-018',
    'EXP-SE-039',
    'EXP-SE-040',
    'EXP-SE-041',
  ].filter((ref) => selectedRefSet.has(ref));

  const extraRefs = [...selectedRefSet]
    .filter((ref) => !requiredRefs.includes(ref))
    .sort((a, b) => a.localeCompare(b));
  const registryRefs = [...requiredRefs, ...extraRefs];

  const anchors = deriveAnchors(selectedRows);

  const scenarioPoints = PROFILE_IDS.flatMap((profileId) => {
    const bound = PROFILE_BOUNDS_NM[profileId];
    return [
      {
        profileId,
        label: 'ideal_target',
        deltaSeNm: Number((bound * 0.5).toFixed(6)),
        uFusedNm: Number((bound * 0.5).toFixed(6)),
      },
      {
        profileId,
        label: 'publication_baseline',
        deltaSeNm: anchors.deltaBaseline,
        uFusedNm: anchors.uBaseline,
      },
      {
        profileId,
        label: 'publication_stress',
        deltaSeNm: anchors.deltaStress,
        uFusedNm: anchors.uStress,
      },
    ];
  });

  const scenarios = scenarioPoints.map((point) => ({
    id: buildScenarioId(point.profileId, point.label, point.deltaSeNm, point.uFusedNm),
    lane: 'sem_ellipsometry',
    description: `Publication-overlay SEM+ellips lane: profile=${point.profileId}, label=${point.label}, delta_se_nm=${point.deltaSeNm}, U_fused_nm=${point.uFusedNm}.`,
    registryRefs,
    overrides: {
      params: {
        gap_nm: 96,
      },
    },
    experimentalContext: {
      semEllips: deriveTypedContext({
        profileId: point.profileId,
        deltaSeNm: point.deltaSeNm,
        uFusedNm: point.uFusedNm,
        label: point.label,
        refs: registryRefs,
      }),
    },
  }));

  const payload = {
    version: 1,
    mode: 'shadow_non_blocking',
    boundaryStatement: BOUNDARY_STATEMENT,
    recovery_goal: 'sem_ellipsometry_publication_overlay',
    success_bar: 'map_only',
    baseline_reference: {
      path: `artifacts/research/full-solve/shadow-injection-run-generated-${DATE_STAMP}.json`,
      keys: [
        'marginRatioRaw',
        'marginRatioRawComputed',
        'applicabilityStatus',
        'congruentSolvePass',
        'congruentSolveFailReasons',
      ],
    },
    notes: [
      'Publication cross-study synthesis lane for SEM+ellipsometry convergence mapping.',
      'Reference-only overlay; not paired instrument-export evidence.',
      'Does not unlock strict reportable SEM+ellipsometry profile.',
    ],
    profileThresholds: {
      'SE-STD-2': {
        delta_se_nm_abs_max: PROFILE_BOUNDS_NM['SE-STD-2'],
        U_fused_nm_max: PROFILE_BOUNDS_NM['SE-STD-2'],
      },
      'SE-ADV-1': {
        delta_se_nm_abs_max: PROFILE_BOUNDS_NM['SE-ADV-1'],
        U_fused_nm_max: PROFILE_BOUNDS_NM['SE-ADV-1'],
      },
    },
    publicationOverlay: {
      sourceScope: ['primary', 'standard'],
      statusScope: ['extracted'],
      lanePosture: 'reference_only',
      reportableUnlock: false,
      numericAnchors: {
        delta_baseline_nm: anchors.deltaBaseline,
        delta_stress_nm: anchors.deltaStress,
        u_baseline_nm: anchors.uBaseline,
        u_stress_nm: anchors.uStress,
      },
    },
    scenarios,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

  return {
    ok: true,
    outPath,
    summary: {
      scenarioCount: scenarios.length,
      registryRefCount: registryRefs.length,
      profileIds: [...PROFILE_IDS],
      anchors,
    },
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = buildSemEllipsPublicationOverlayPack({
    registryPath: readArgValue('--registry') ?? DEFAULT_REGISTRY_PATH,
    outPath: readArgValue('--out') ?? DEFAULT_OUT_PATH,
  });
  console.log(JSON.stringify(result, null, 2));
}
