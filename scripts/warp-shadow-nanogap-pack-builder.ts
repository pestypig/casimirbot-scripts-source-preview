import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_REGISTRY_PATH = path.join(
  'docs',
  'specs',
  'casimir-tile-experimental-parameter-registry-2026-03-04.md',
);
const DEFAULT_BASE_PATH = path.join('configs', 'warp-shadow-injection-scenarios.ng-primary-recovery.v1.json');
const DEFAULT_PASS1_OUT = path.join('configs', 'warp-shadow-injection-scenarios.ng-primary-recovery.v1.json');
const DEFAULT_PASS2_OUT = path.join('configs', 'warp-shadow-injection-scenarios.ng-primary-typed.v1.json');
const DEFAULT_REPORTABLE_OUT = path.join('configs', 'warp-shadow-injection-scenarios.ng-primary-reportable.v1.json');
const DEFAULT_REPORTABLE_REFERENCE_OUT = path.join(
  'configs',
  'warp-shadow-injection-scenarios.ng-primary-reportable-reference.v1.json',
);
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const PROFILE_IDS = ['NG-STD-10', 'NG-ADV-5'] as const;
type ProfileId = (typeof PROFILE_IDS)[number];

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
    overrides?: {
      params?: {
        gap_nm?: number;
      };
    };
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

const toIdToken = (value: number): string => Number(value).toExponential(0).replace('+', '').replace('-', 'm').replace('.', 'p');

const deriveGapGrid = (rowsById: Map<string, RegistryRow>, baseGapNm: number): number[] => {
  const candidateRefs = ['EXP-NG-001', 'EXP-NG-002', 'EXP-NG-011', 'EXP-NG-012', 'EXP-NG-019', 'EXP-NG-020'];
  const candidates = candidateRefs
    .map((id) => rowsById.get(id))
    .filter((row): row is RegistryRow => Boolean(row))
    .flatMap((row) => {
      const unit = String(row.unit).toLowerCase();
      if (!unit.includes('nm')) return [];
      return parseNumberCandidates(row.value).filter((value) => value > 0 && value <= 150);
    });

  const seeds = [5, 10, 20, 50, 100];
  const selectedFromCandidates = seeds.map((seed) => {
    if (!candidates.length) return seed;
    return candidates.reduce((best, value) => (Math.abs(value - seed) < Math.abs(best - seed) ? value : best), candidates[0]);
  });

  const merged = uniqueSorted([...selectedFromCandidates, Math.min(150, Math.max(5, baseGapNm))]);
  if (merged.length >= 5) return merged;

  const fill = [...merged];
  for (const seed of seeds) {
    if (fill.length >= 5) break;
    if (!fill.some((value) => Math.abs(value - seed) < 1e-9)) fill.push(seed);
  }
  return uniqueSorted(fill);
};

const deriveUncertainty = (rowsById: Map<string, RegistryRow>) => {
  const uCalibration = parsePositiveValue(rowsById.get('EXP-NG-002')?.value ?? '');
  const uNoise = parsePositiveValue(rowsById.get('EXP-NG-006')?.value ?? '');
  const uStress = parsePositiveValue(rowsById.get('EXP-NG-007')?.value ?? '');
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

  const blockedReasons: string[] = [];
  if (uMean == null) blockedReasons.push('missing_u_g_mean_anchor');
  if (uSigma == null) blockedReasons.push('missing_u_g_sigma_anchor');

  const reportableReady = blockedReasons.length === 0;
  return {
    uMean: uMean != null ? Number(uMean.toFixed(6)) : null,
    uSigma: uSigma != null ? Number(uSigma.toFixed(6)) : null,
    reportableReady,
    blockedReasons,
    method: reportableReady ? 'registry_anchor_derived' : 'conservative_fallback_missing_numeric',
  };
};

const profileThresholds: Record<ProfileId, { u_g_mean_nm_max: number; u_g_sigma_nm_max: number }> = {
  'NG-STD-10': { u_g_mean_nm_max: 2.0, u_g_sigma_nm_max: 2.0 },
  'NG-ADV-5': { u_g_mean_nm_max: 1.0, u_g_sigma_nm_max: 1.0 },
};

export const buildNanogapScenarioPacks = (options: {
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

  const orderedRequiredRefs = ['EXP-NG-002', 'EXP-NG-011', 'EXP-NG-012', 'EXP-NG-019', 'EXP-NG-020'];
  for (const required of orderedRequiredRefs) baseRefs.add(required);
  const extraRefs = [...baseRefs]
    .filter((ref) => !orderedRequiredRefs.includes(ref))
    .sort((a, b) => a.localeCompare(b));
  const registryRefs = [...orderedRequiredRefs, ...extraRefs];

  const baseGapNm = Number(basePack.scenarios?.[0]?.overrides?.params?.gap_nm ?? 96);
  const gapGrid = deriveGapGrid(rowsById, baseGapNm);
  const uncertainty = deriveUncertainty(rowsById);
  const tipMethod = registryRefs.includes('EXP-NG-019') || registryRefs.includes('EXP-NG-020') ? 'btr' : 'direct_ref';
  const fiducialPresent = registryRefs.includes('EXP-NG-011') && registryRefs.includes('EXP-NG-012');

  const baseEnvelopePack = {
    version: 1,
    mode: 'shadow_non_blocking',
    boundaryStatement: basePack.boundaryStatement ?? BOUNDARY_STATEMENT,
    recovery_goal: 'nanogap_compatibility_recovery',
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
      'Primary/standard nanogap evidence only.',
      'Non-blocking compatibility envelope mapping lane.',
      'No canonical override or promotion implied.',
      'Profile thresholds follow NG-STD-10 and NG-ADV-5 protocol bounds.',
    ],
    profileThresholds,
  };

  const pass1Scenarios = PROFILE_IDS.flatMap((profileId) =>
    gapGrid.map((gapNm) => ({
      id: `ng_primary_${profileId.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_gap_${toIdToken(gapNm)}nm`,
      lane: 'nanogap',
      description: `Pass-1 nanogap envelope: profile=${profileId}, gap_nm=${gapNm}.`,
      registryRefs,
      overrides: {
        params: {
          gap_nm: Number(gapNm.toFixed(6)),
        },
      },
    })),
  );

  const pass2Scenarios = PROFILE_IDS.flatMap((profileId) =>
    gapGrid.map((gapNm) => ({
      id: `ng_primary_typed_${profileId.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_gap_${toIdToken(gapNm)}nm`,
      lane: 'nanogap',
      description: `Pass-2 typed nanogap envelope: profile=${profileId}, gap_nm=${gapNm}.`,
      registryRefs,
      overrides: {
        params: {
          gap_nm: Number(gapNm.toFixed(6)),
        },
      },
      experimentalContext: {
        nanogap: {
          profileId,
          ...(uncertainty.uMean != null ? { u_g_mean_nm: uncertainty.uMean } : {}),
          ...(uncertainty.uSigma != null ? { u_g_sigma_nm: uncertainty.uSigma } : {}),
          tip_method: tipMethod,
          fiducial_present: fiducialPresent,
          sourceRefs: registryRefs,
          uncertainty: {
            method: uncertainty.method,
            reportableReady: uncertainty.reportableReady,
            blockedReasons: uncertainty.blockedReasons,
            sourceRefs: registryRefs,
          },
        },
      },
    })),
  );

  const pickReferenceId = (profileId: ProfileId): string => {
    const targetGap = Math.min(150, Math.max(5, baseGapNm));
    const profileScenarios = pass2Scenarios.filter((scenario) => scenario.experimentalContext.nanogap.profileId === profileId);
    const best = profileScenarios.reduce((acc, scenario) => {
      const gap = Number(scenario.overrides.params.gap_nm);
      if (!acc) return { id: scenario.id, dist: Math.abs(gap - targetGap) };
      const dist = Math.abs(gap - targetGap);
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
      gap_nm: gapGrid,
      profile_id: [...PROFILE_IDS],
    },
    scenarios: pass1Scenarios,
  };

  const pass2Payload = {
    ...baseEnvelopePack,
    pass: 'pass_2_typed_context',
    dimensions: {
      gap_nm: gapGrid,
      profile_id: [...PROFILE_IDS],
    },
    scenarios: pass2Scenarios,
  };

  const reportablePayload = {
    ...pass2Payload,
    profile: 'ng_primary_reportable_v1',
    preRegistrationProfile: {
      profileId: 'ng-primary-reportable-v1',
      lockedOn: DATE_STAMP,
      lane: 'nanogap',
      sourceClassAllowlist: ['primary', 'standard'],
      lockedRegistryRefs: registryRefs,
      lockedGapGridNm: gapGrid,
      lockedProfileIds: [...PROFILE_IDS],
      profileThresholds,
      uncertainty: {
        ...(uncertainty.uMean != null ? { u_g_mean_nm: uncertainty.uMean } : {}),
        ...(uncertainty.uSigma != null ? { u_g_sigma_nm: uncertainty.uSigma } : {}),
        method: uncertainty.method,
        sourceRefs: registryRefs,
      },
      reportableReady: uncertainty.reportableReady,
      blockedReasons: uncertainty.blockedReasons,
      stableCitationTargetProfileId: 'ng-primary-reportable-reference-v1',
      stableCitationTargetScenarioIds,
    },
  };

  const reportableReferencePayload = {
    ...pass2Payload,
    profile: 'ng_primary_reportable_reference_v1',
    reportableReferenceProfile: {
      profileId: 'ng-primary-reportable-reference-v1',
      lockedOn: DATE_STAMP,
      lane: 'nanogap',
      sourceClassAllowlist: ['primary', 'standard'],
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
      gapGrid,
      profileGrid: [...PROFILE_IDS],
      scenarioCount: pass2Scenarios.length,
      reportableReady: uncertainty.reportableReady,
      blockedReasons: uncertainty.blockedReasons,
    },
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = buildNanogapScenarioPacks({
    registryPath: readArgValue('--registry') ?? DEFAULT_REGISTRY_PATH,
    basePath: readArgValue('--base') ?? DEFAULT_BASE_PATH,
    pass1OutPath: readArgValue('--out-pass1') ?? DEFAULT_PASS1_OUT,
    pass2OutPath: readArgValue('--out-pass2') ?? DEFAULT_PASS2_OUT,
    reportableOutPath: readArgValue('--out-reportable') ?? DEFAULT_REPORTABLE_OUT,
    reportableReferenceOutPath: readArgValue('--out-reportable-reference') ?? DEFAULT_REPORTABLE_REFERENCE_OUT,
  });
  console.log(JSON.stringify(result, null, 2));
}
