import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_REGISTRY_PATH = path.join(
  'docs',
  'specs',
  'casimir-tile-experimental-parameter-registry-2026-03-04.md',
);
const DEFAULT_BASE_PATH = path.join('configs', 'warp-shadow-injection-scenarios.cs-primary-recovery.v1.json');
const DEFAULT_PASS1_OUT = path.join('configs', 'warp-shadow-injection-scenarios.cs-primary-recovery.v1.json');
const DEFAULT_PASS2_OUT = path.join('configs', 'warp-shadow-injection-scenarios.cs-primary-typed.v1.json');
const DEFAULT_REPORTABLE_OUT = path.join('configs', 'warp-shadow-injection-scenarios.cs-primary-reportable.v1.json');
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

type RegistryRow = {
  entry_id: string;
  value: string;
};

type BaseScenarioPack = {
  boundaryStatement?: string;
  scenarios?: Array<{
    registryRefs?: string[];
    experimentalContext?: {
      casimirSign?: {
        materialPair?: string;
        interveningMedium?: string;
        uncertainty?: {
          u_gap_nm?: number;
          u_window_nm?: number;
          method?: string;
          sourceRefs?: string[];
        };
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

const toIdToken = (value: number): string => String(value).replace('.', 'p').replace('-', 'm');

const parseRegistryRows = (markdown: string): RegistryRow[] => {
  const rows: RegistryRow[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('| EXP-')) continue;
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 4) continue;
    rows.push({
      entry_id: cells[0],
      value: cells[3],
    });
  }
  return rows;
};

const getWindowAnchors = (rows: RegistryRow[]): { attractiveMin: number; attractiveMax: number; repulsiveMin: number } => {
  const attractiveRow = rows.find((row) => row.entry_id.toUpperCase() === 'EXP-CS-001');
  const repulsiveRow = rows.find((row) => row.entry_id.toUpperCase() === 'EXP-CS-002');
  const attractive = attractiveRow ? parseNumberCandidates(attractiveRow.value) : [];
  const repulsive = repulsiveRow ? parseNumberCandidates(repulsiveRow.value) : [];

  const attractiveMin = attractive.length >= 1 ? attractive[0] : 3;
  const attractiveMax = attractive.length >= 2 ? attractive[1] : 100;
  const repulsiveMin = repulsive.length >= 1 ? repulsive[0] : attractiveMax;
  return { attractiveMin, attractiveMax, repulsiveMin };
};

const uniqueSorted = (values: number[]): number[] =>
  [...new Set(values.map((value) => Number(value.toFixed(3))))].sort((a, b) => a - b);

export const buildCasimirSignScenarioPacks = (options: {
  registryPath?: string;
  basePath?: string;
  pass1OutPath?: string;
  pass2OutPath?: string;
  reportableOutPath?: string;
}) => {
  const registryPath = options.registryPath ?? DEFAULT_REGISTRY_PATH;
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;
  const pass1OutPath = options.pass1OutPath ?? DEFAULT_PASS1_OUT;
  const pass2OutPath = options.pass2OutPath ?? DEFAULT_PASS2_OUT;
  const reportableOutPath = options.reportableOutPath ?? DEFAULT_REPORTABLE_OUT;

  const registryRows = parseRegistryRows(fs.readFileSync(registryPath, 'utf8'));
  const windows = getWindowAnchors(registryRows);
  const basePack = JSON.parse(fs.readFileSync(basePath, 'utf8')) as BaseScenarioPack;
  const baseRefs = new Set<string>();
  for (const scenario of basePack.scenarios ?? []) {
    for (const ref of scenario.registryRefs ?? []) baseRefs.add(String(ref).trim().toUpperCase());
  }

  // Keep explicit sign/window/material anchors present in every scenario.
  const orderedRequiredRefs = ['EXP-CS-001', 'EXP-CS-002', 'EXP-CS-005', 'EXP-CS-006', 'EXP-CS-007', 'EXP-CS-011'];
  for (const required of orderedRequiredRefs) {
    baseRefs.add(required);
  }
  const extraRefs = [...baseRefs]
    .filter((ref) => !orderedRequiredRefs.includes(ref))
    .sort((a, b) => a.localeCompare(b));
  const registryRefs = [...orderedRequiredRefs, ...extraRefs];

  const materialPair =
    basePack.scenarios?.[0]?.experimentalContext?.casimirSign?.materialPair?.trim() || 'gold_silica';
  const interveningMedium =
    basePack.scenarios?.[0]?.experimentalContext?.casimirSign?.interveningMedium?.trim() || 'ethanol';
  const baseUncertainty = basePack.scenarios?.[0]?.experimentalContext?.casimirSign?.uncertainty;
  const uGapNm = Number.isFinite(Number(baseUncertainty?.u_gap_nm)) ? Number(baseUncertainty?.u_gap_nm) : 5;
  const uWindowNm = Number.isFinite(Number(baseUncertainty?.u_window_nm)) ? Number(baseUncertainty?.u_window_nm) : 5;
  const uncertaintyMethod = baseUncertainty?.method?.trim() || 'conservative_fallback_no_nm_uncertainty';
  const uncertaintySourceRefs =
    baseUncertainty?.sourceRefs?.length && Array.isArray(baseUncertainty.sourceRefs)
      ? baseUncertainty.sourceRefs
      : registryRefs.filter((ref) => ['EXP-CS-001', 'EXP-CS-002'].includes(ref));

  const gapGrid = uniqueSorted([
    Math.max(5, windows.attractiveMin + 7),
    (windows.attractiveMin + windows.attractiveMax) / 2,
    Math.max(5, windows.attractiveMax - 10),
    windows.repulsiveMin,
    windows.repulsiveMin + 40,
    windows.repulsiveMin + 120,
  ]);
  const branches: Array<'attractive' | 'transition' | 'repulsive'> = ['attractive', 'transition', 'repulsive'];

  const baseEnvelopePack = {
    version: 1,
    mode: 'shadow_non_blocking',
    boundaryStatement: basePack.boundaryStatement ?? BOUNDARY_STATEMENT,
    recovery_goal: 'casimir_sign_control_recovery',
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
      'Primary/standard Casimir sign-control evidence only.',
      'Non-blocking compatibility envelope mapping lane.',
      'No canonical override or promotion implied.',
      'Branch-wise congruence is uncertainty-aware via u_gap_nm and u_window_nm.',
    ],
  };

  const pass1Scenarios = branches.flatMap((branch) =>
    gapGrid.map((gapNm) => ({
      id: `cs_primary_${branch}_gap_${toIdToken(gapNm)}nm`,
      lane: 'casimir_sign_control',
      description: `Pass-1 Casimir sign envelope: branch=${branch}, gap_nm=${gapNm}.`,
      registryRefs,
      overrides: {
        params: {
          gap_nm: gapNm,
        },
        qi: {
          fieldType: 'scalar',
        },
      },
    })),
  );

  const pass2Scenarios = branches.flatMap((branch) =>
    gapGrid.map((gapNm) => ({
      id: `cs_primary_typed_${branch}_gap_${toIdToken(gapNm)}nm`,
      lane: 'casimir_sign_control',
      description: `Pass-2 typed Casimir sign envelope: branch=${branch}, gap_nm=${gapNm}.`,
      registryRefs,
      overrides: {
        params: {
          gap_nm: gapNm,
        },
        qi: {
          fieldType: 'scalar',
        },
      },
      experimentalContext: {
        casimirSign: {
          branchHypothesis: branch,
          materialPair,
          interveningMedium,
          sourceRefs: registryRefs,
          uncertainty: {
            u_gap_nm: Number(uGapNm.toFixed(3)),
            u_window_nm: Number(uWindowNm.toFixed(3)),
            method: uncertaintyMethod,
            sourceRefs: uncertaintySourceRefs,
          },
        },
      },
    })),
  );

  const pass1Payload = {
    ...baseEnvelopePack,
    pass: 'pass_1_existing_knobs',
    dimensions: {
      gap_nm: gapGrid,
      branch_tag: branches,
      fieldType: 'scalar',
    },
    scenarios: pass1Scenarios,
  };

  const pass2Payload = {
    ...baseEnvelopePack,
    pass: 'pass_2_typed_context',
    dimensions: {
      gap_nm: gapGrid,
      branch_tag: branches,
      fieldType: 'scalar',
    },
    scenarios: pass2Scenarios,
  };

  const reportablePayload = {
    ...pass2Payload,
    profile: 'cs_primary_reportable_v1',
    preRegistrationProfile: {
      profileId: 'cs-primary-reportable-v1',
      lockedOn: DATE_STAMP,
      lane: 'casimir_sign_control',
      sourceClassAllowlist: ['primary', 'standard'],
      lockedRegistryRefs: registryRefs,
      lockedGapGridNm: gapGrid,
      lockedBranches: branches,
      lockedFieldType: 'scalar',
      uncertainty: {
        u_gap_nm: Number(uGapNm.toFixed(3)),
        u_window_nm: Number(uWindowNm.toFixed(3)),
        method: uncertaintyMethod,
        sourceRefs: uncertaintySourceRefs,
      },
    },
  };

  fs.mkdirSync(path.dirname(pass1OutPath), { recursive: true });
  fs.writeFileSync(pass1OutPath, `${JSON.stringify(pass1Payload, null, 2)}\n`);
  fs.mkdirSync(path.dirname(pass2OutPath), { recursive: true });
  fs.writeFileSync(pass2OutPath, `${JSON.stringify(pass2Payload, null, 2)}\n`);
  fs.mkdirSync(path.dirname(reportableOutPath), { recursive: true });
  fs.writeFileSync(reportableOutPath, `${JSON.stringify(reportablePayload, null, 2)}\n`);

  return {
    ok: true,
    pass1OutPath,
    pass2OutPath,
    reportableOutPath,
    gapGrid,
    branches,
    scenarioCounts: {
      pass1: pass1Scenarios.length,
      pass2: pass2Scenarios.length,
      reportable: pass2Scenarios.length,
    },
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = buildCasimirSignScenarioPacks({
    registryPath: readArgValue('--registry') ?? DEFAULT_REGISTRY_PATH,
    basePath: readArgValue('--base') ?? DEFAULT_BASE_PATH,
    pass1OutPath: readArgValue('--out-pass1') ?? DEFAULT_PASS1_OUT,
    pass2OutPath: readArgValue('--out-pass2') ?? DEFAULT_PASS2_OUT,
    reportableOutPath: readArgValue('--out-reportable') ?? DEFAULT_REPORTABLE_OUT,
  });
  console.log(JSON.stringify(result, null, 2));
}
