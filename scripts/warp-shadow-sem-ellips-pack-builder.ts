import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_REGISTRY_PATH = path.join(
  'docs',
  'specs',
  'casimir-tile-experimental-parameter-registry-2026-03-04.md',
);
const DEFAULT_BASE_PATH = path.join('configs', 'warp-shadow-injection-scenarios.se-primary-recovery.v1.json');
const DEFAULT_PASS1_OUT = path.join('configs', 'warp-shadow-injection-scenarios.se-primary-recovery.v1.json');
const DEFAULT_PASS2_OUT = path.join('configs', 'warp-shadow-injection-scenarios.se-primary-typed.v1.json');
const DEFAULT_REPORTABLE_OUT = path.join('configs', 'warp-shadow-injection-scenarios.se-primary-reportable.v1.json');
const DEFAULT_REPORTABLE_REFERENCE_OUT = path.join(
  'configs',
  'warp-shadow-injection-scenarios.se-primary-reportable-reference.v1.json',
);
const DEFAULT_PAIRED_EVIDENCE_TEMPLATE = path.join(
  'docs',
  'specs',
  'templates',
  'casimir-tile-sem-ellipsometry-paired-run-evidence-template.v1.json',
);
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const PROFILE_IDS = ['SE-STD-2', 'SE-ADV-1'] as const;
const PROFILE_BOUNDS_NM = {
  'SE-STD-2': 2.0,
  'SE-ADV-1': 1.0,
} as const;
const MULTIPLIERS = [0.5, 1.0, 1.2] as const;
const REPORTABLE_BLOCKED_REASONS = ['missing_paired_dual_instrument_run', 'missing_covariance_uncertainty_anchor'];

type ProfileId = (typeof PROFILE_IDS)[number];

type RegistryRow = {
  entry_id: string;
  source_class: string;
  status: string;
};

type BaseScenarioPack = {
  boundaryStatement?: string;
  scenarios?: Array<{
    registryRefs?: string[];
  }>;
};

type SemEllipsPairedEvidence = {
  pairedRunPresent?: boolean;
  covarianceAnchorPresent?: boolean;
  pairedRunId?: string;
  sourceClass?: string;
  provenance?: {
    data_origin?: string | null;
    instrument_run_ids?: string[] | null;
    raw_artifact_refs?: string[] | null;
    raw_artifact_sha256?: Record<string, string> | null;
    operator_id?: string | null;
    acquisition_date_utc?: string | null;
  };
  uncertainty?: {
    method?: string;
    u_sem_nm?: number;
    u_ellip_nm?: number;
    rho_sem_ellip?: number;
    covariance_sem_ellip_nm2?: number;
    k?: number;
  };
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
    if (!trimmed.startsWith('| EXP-')) continue;
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 12) continue;
    rows.push({
      entry_id: cells[0],
      source_class: cells[9],
      status: cells[11],
    });
  }
  return rows;
};

const finiteOrNull = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const isSha256Hex = (value: string): boolean => /^[a-f0-9]{64}$/i.test(value);
const normalizeRef = (value: string): string => value.replace(/\\/g, '/').trim().toLowerCase();
const isTemplateRef = (value: string): boolean => normalizeRef(value).includes('docs/specs/data/se-paired-runs-template-');

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const resolveReportableUnlock = (
  pairedEvidencePath: string | undefined,
): {
  reportableReady: boolean;
  blockedReasons: string[];
  method: string;
  pairedRunId: string | null;
  dataOrigin: string | null;
  instrumentRunIds: string[];
  rawArtifactRefs: string[];
  rawArtifactSha256: Record<string, string>;
  uSemNm: number | null;
  uEllipNm: number | null;
  rhoSemEllip: number | null;
  covarianceSemEllipNm2: number | null;
  evidencePath: string | null;
} => {
  if (!pairedEvidencePath) {
    return {
      reportableReady: false,
      blockedReasons: REPORTABLE_BLOCKED_REASONS,
      method: 'profile_envelope_from_primary_standard_anchors',
      pairedRunId: null,
      dataOrigin: null,
      instrumentRunIds: [],
      rawArtifactRefs: [],
      rawArtifactSha256: {},
      uSemNm: null,
      uEllipNm: null,
      rhoSemEllip: null,
      covarianceSemEllipNm2: null,
      evidencePath: null,
    };
  }

  const payload = JSON.parse(fs.readFileSync(pairedEvidencePath, 'utf8')) as SemEllipsPairedEvidence;
  const errors: string[] = [];

  if (payload.pairedRunPresent !== true) errors.push('missing_paired_dual_instrument_run');
  if (payload.covarianceAnchorPresent !== true) errors.push('missing_covariance_uncertainty_anchor');
  if (payload.sourceClass && !['primary', 'standard'].includes(payload.sourceClass.toLowerCase())) {
    errors.push('paired_evidence_source_not_admissible');
  }
  const dataOrigin = String(payload.provenance?.data_origin ?? '').trim().toLowerCase();
  const instrumentRunIds = (payload.provenance?.instrument_run_ids ?? [])
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0);
  const rawArtifactRefs = (payload.provenance?.raw_artifact_refs ?? [])
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0);
  const rawArtifactSha256Entries = Object.entries(payload.provenance?.raw_artifact_sha256 ?? {}).map(([ref, hash]) => [
    String(ref).trim(),
    String(hash).trim().toLowerCase(),
  ] as const);
  const rawArtifactSha256 = Object.fromEntries(rawArtifactSha256Entries.filter(([ref]) => ref.length > 0));
  const templateRefPresent = rawArtifactRefs.some((ref) => isTemplateRef(ref));
  const templateRunId = payload.pairedRunId?.trim().toLowerCase().includes('template') ?? false;
  if (dataOrigin !== 'instrument_export') {
    errors.push('measurement_provenance_not_instrument_export');
  }
  if (instrumentRunIds.length === 0) {
    errors.push('missing_measurement_provenance_run_ids');
  }
  if (rawArtifactRefs.length === 0) {
    errors.push('missing_measurement_provenance_raw_refs');
  }
  if (Object.keys(rawArtifactSha256).length === 0) {
    errors.push('missing_measurement_provenance_raw_hashes');
  }
  for (const ref of rawArtifactRefs) {
    const hash = rawArtifactSha256[ref];
    if (!hash) {
      errors.push('missing_measurement_provenance_raw_hash_for_ref');
      continue;
    }
    if (!isSha256Hex(hash)) {
      errors.push('invalid_measurement_provenance_raw_hash_format');
    }
  }

  if (templateRefPresent || templateRunId) {
    errors.push('template_placeholder_input');
  }

  const uSemNm = finiteOrNull(payload.uncertainty?.u_sem_nm);
  const uEllipNm = finiteOrNull(payload.uncertainty?.u_ellip_nm);
  const rhoSemEllip = finiteOrNull(payload.uncertainty?.rho_sem_ellip);
  const covarianceSemEllipNm2 = finiteOrNull(payload.uncertainty?.covariance_sem_ellip_nm2);

  if (uSemNm == null || uSemNm <= 0 || uEllipNm == null || uEllipNm <= 0) {
    errors.push('missing_paired_dual_instrument_run');
  }

  if (rhoSemEllip == null && covarianceSemEllipNm2 == null) {
    errors.push('missing_covariance_uncertainty_anchor');
  }

  if (rhoSemEllip != null && Math.abs(rhoSemEllip) >= 1) {
    errors.push('invalid_covariance_correlation_range');
  }

  return {
    reportableReady: errors.length === 0,
    blockedReasons: unique(errors),
    method:
      payload.uncertainty?.method?.trim() ||
      (errors.length === 0
        ? 'paired_dual_instrument_covariance_numeric'
        : 'profile_envelope_from_primary_standard_anchors'),
    pairedRunId: payload.pairedRunId?.trim() || null,
    dataOrigin: dataOrigin || null,
    instrumentRunIds,
    rawArtifactRefs,
    rawArtifactSha256,
    uSemNm,
    uEllipNm,
    rhoSemEllip,
    covarianceSemEllipNm2,
    evidencePath: pairedEvidencePath,
  };
};

const toIdToken = (value: number): string => {
  const rounded = Number(value.toFixed(3));
  const token = Number.isInteger(rounded) ? String(rounded) : String(rounded).replace('.', 'p');
  return token.replace('-', 'm');
};

const buildScenarioId = (prefix: string, profileId: ProfileId, deltaSeNm: number, UFusedNm: number): string =>
  `${prefix}_${profileId.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_delta_${toIdToken(deltaSeNm)}_u_${toIdToken(UFusedNm)}`
    .replace(/__+/g, '_')
    .toLowerCase();

const deriveTypedContext = (
  input: { profileId: ProfileId; deltaSeNm: number; uFusedNm: number; refs: string[] },
  reportable: {
    reportableReady: boolean;
    blockedReasons: string[];
    method: string;
    pairedRunId: string | null;
    dataOrigin: string | null;
    instrumentRunIds: string[];
    rawArtifactRefs: string[];
    rawArtifactSha256: Record<string, string>;
    uSemNm: number | null;
    uEllipNm: number | null;
    rhoSemEllip: number | null;
    covarianceSemEllipNm2: number | null;
  },
) => {
  const dEllipNm = 100;
  const dSemCorrNm = Number((dEllipNm + input.deltaSeNm).toFixed(6));
  const uFusedStdNm = Number((input.uFusedNm / 2).toFixed(6));
  const defaultUInstrumentNm = Number((uFusedStdNm * Math.SQRT2).toFixed(6));
  const uSemNm = reportable.uSemNm ?? defaultUInstrumentNm;
  const uEllipNm = reportable.uEllipNm ?? defaultUInstrumentNm;
  const dFusedNm = Number(((dSemCorrNm + dEllipNm) / 2).toFixed(6));

  return {
    profileId: input.profileId,
    d_sem_corr_nm: dSemCorrNm,
    u_sem_nm: uSemNm,
    d_ellip_nm: dEllipNm,
    u_ellip_nm: uEllipNm,
    delta_se_nm: Number(input.deltaSeNm.toFixed(6)),
    d_fused_nm: dFusedNm,
    u_fused_nm: uFusedStdNm,
    U_fused_nm: Number(input.uFusedNm.toFixed(6)),
    paired_run_id: reportable.pairedRunId,
    data_origin: reportable.dataOrigin,
    instrument_run_ids: reportable.instrumentRunIds,
    raw_artifact_refs: reportable.rawArtifactRefs,
    raw_artifact_sha256: reportable.rawArtifactSha256,
    rho_sem_ellip: reportable.rhoSemEllip,
    covariance_sem_ellip_nm2: reportable.covarianceSemEllipNm2,
    sourceRefs: input.refs,
    uncertainty: {
      method: reportable.method,
      reportableReady: reportable.reportableReady,
      blockedReasons: reportable.blockedReasons,
      sourceRefs: input.refs,
    },
  };
};

export const buildSemEllipsScenarioPacks = (options: {
  registryPath?: string;
  basePath?: string;
  pass1OutPath?: string;
  pass2OutPath?: string;
  reportableOutPath?: string;
  reportableReferenceOutPath?: string;
  pairedEvidencePath?: string;
}) => {
  const registryPath = options.registryPath ?? DEFAULT_REGISTRY_PATH;
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;
  const pass1OutPath = options.pass1OutPath ?? DEFAULT_PASS1_OUT;
  const pass2OutPath = options.pass2OutPath ?? DEFAULT_PASS2_OUT;
  const reportableOutPath = options.reportableOutPath ?? DEFAULT_REPORTABLE_OUT;
  const reportableReferenceOutPath = options.reportableReferenceOutPath ?? DEFAULT_REPORTABLE_REFERENCE_OUT;
  const pairedEvidencePath = options.pairedEvidencePath;
  const reportableUnlock = resolveReportableUnlock(pairedEvidencePath);

  const registryRows = parseRegistryRows(fs.readFileSync(registryPath, 'utf8'));
  const basePack = JSON.parse(fs.readFileSync(basePath, 'utf8')) as BaseScenarioPack;
  const baseRefs = new Set<string>();
  for (const scenario of basePack.scenarios ?? []) {
    for (const ref of scenario.registryRefs ?? []) baseRefs.add(String(ref).trim().toUpperCase());
  }

  const orderedRequiredRefs = ['EXP-SE-001', 'EXP-SE-002', 'EXP-SE-003', 'EXP-SE-009', 'EXP-SE-012', 'EXP-SE-013'];
  for (const required of orderedRequiredRefs) baseRefs.add(required);

  const strictAllowedRefSet = new Set(
    registryRows
      .filter(
        (row) =>
          String(row.status).toLowerCase() === 'extracted' &&
          ['primary', 'standard'].includes(String(row.source_class).toLowerCase()),
      )
      .map((row) => row.entry_id.toUpperCase()),
  );

  const extraRefs = [...baseRefs]
    .filter((ref) => !orderedRequiredRefs.includes(ref) && strictAllowedRefSet.has(ref))
    .sort((a, b) => a.localeCompare(b));
  const registryRefs = [...orderedRequiredRefs, ...extraRefs].filter((ref) => strictAllowedRefSet.has(ref));

  const pairedGrid = PROFILE_IDS.flatMap((profileId) => {
    const bound = PROFILE_BOUNDS_NM[profileId];
    const axis = MULTIPLIERS.map((multiplier) => Number((bound * multiplier).toFixed(6)));
    return axis.flatMap((deltaMagnitude, deltaIdx) =>
      axis.map((uValue) => {
        const sign = deltaIdx % 2 === 0 ? 1 : -1;
        const deltaSeNm = Number((deltaMagnitude * sign).toFixed(6));
        const uFusedNm = Number(uValue.toFixed(6));
        return {
          profileId,
          deltaSeNm,
          uFusedNm,
        };
      }),
    );
  });

  const pass1Scenarios = pairedGrid.map((point) => ({
    id: buildScenarioId('se_primary', point.profileId, point.deltaSeNm, point.uFusedNm),
    lane: 'sem_ellipsometry',
    description: `Pass-1 SEM+ellips envelope: profile=${point.profileId}, delta_se_nm=${point.deltaSeNm}, U_fused_nm=${point.uFusedNm}.`,
    registryRefs,
    overrides: {
      params: {
        gap_nm: 96,
      },
    },
  }));

  const pass2Scenarios = pairedGrid.map((point) => ({
    id: buildScenarioId('se_primary_typed', point.profileId, point.deltaSeNm, point.uFusedNm),
    lane: 'sem_ellipsometry',
    description: `Pass-2 typed SEM+ellips envelope: profile=${point.profileId}, delta_se_nm=${point.deltaSeNm}, U_fused_nm=${point.uFusedNm}.`,
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
        refs: registryRefs,
      }, {
        reportableReady: false,
        blockedReasons: REPORTABLE_BLOCKED_REASONS,
        method: 'profile_envelope_from_primary_standard_anchors',
        pairedRunId: null,
        dataOrigin: null,
        instrumentRunIds: [],
        rawArtifactRefs: [],
        rawArtifactSha256: {},
        uSemNm: null,
        uEllipNm: null,
        rhoSemEllip: null,
        covarianceSemEllipNm2: null,
      }),
    },
  }));

  const reportableScenarios = pairedGrid.map((point) => ({
    id: buildScenarioId('se_primary_typed', point.profileId, point.deltaSeNm, point.uFusedNm),
    lane: 'sem_ellipsometry',
    description: `Pass-2 typed SEM+ellips envelope: profile=${point.profileId}, delta_se_nm=${point.deltaSeNm}, U_fused_nm=${point.uFusedNm}.`,
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
        refs: registryRefs,
      }, reportableUnlock),
    },
  }));

  const stableCitationTargetScenarioIds = PROFILE_IDS.map((profileId) => {
    const targetDelta = Number((PROFILE_BOUNDS_NM[profileId] * 0.5).toFixed(6));
    const targetU = Number((PROFILE_BOUNDS_NM[profileId] * 0.5).toFixed(6));
    const id = buildScenarioId('se_primary_typed', profileId, targetDelta, targetU);
    return pass2Scenarios.find((scenario) => scenario.id === id)?.id ?? '';
  }).filter((value) => value.length > 0);

  const baseEnvelopePack = {
    version: 1,
    mode: 'shadow_non_blocking',
    boundaryStatement: basePack.boundaryStatement ?? BOUNDARY_STATEMENT,
    recovery_goal: 'sem_ellipsometry_compatibility_recovery',
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
      'Primary/standard SEM+ellipsometry evidence only.',
      'Non-blocking compatibility envelope mapping lane.',
      'No canonical override or promotion implied.',
      'Reportable profile is fail-closed blocked until paired-run, covariance uncertainty, and measurement provenance anchors are present.',
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
  };

  const pass1Payload = {
    ...baseEnvelopePack,
    pass: 'pass_1_existing_knobs',
    dimensions: {
      profile_id: [...PROFILE_IDS],
      delta_se_nm: MULTIPLIERS,
      U_fused_nm: MULTIPLIERS,
    },
    scenarios: pass1Scenarios,
  };

  const pass2Payload = {
    ...baseEnvelopePack,
    pass: 'pass_2_typed_context',
    dimensions: {
      profile_id: [...PROFILE_IDS],
      delta_se_nm: MULTIPLIERS,
      U_fused_nm: MULTIPLIERS,
    },
    scenarios: pass2Scenarios,
  };

  const reportablePayload = {
    ...pass2Payload,
    profile: 'se_primary_reportable_v1',
    reportableUnlockEvidence: reportableUnlock.evidencePath
      ? {
          evidencePath: reportableUnlock.evidencePath,
          reportableReady: reportableUnlock.reportableReady,
          blockedReasons: reportableUnlock.blockedReasons,
        }
      : {
          evidencePath: DEFAULT_PAIRED_EVIDENCE_TEMPLATE,
          reportableReady: false,
          blockedReasons: REPORTABLE_BLOCKED_REASONS,
        },
    preRegistrationProfile: {
      profileId: 'se-primary-reportable-v1',
      lockedOn: DATE_STAMP,
      lane: 'sem_ellipsometry',
      sourceClassAllowlist: ['primary', 'standard'],
      lockedRegistryRefs: registryRefs,
      lockedProfiles: [...PROFILE_IDS],
      lockedMultipliers: [...MULTIPLIERS],
      reportableReady: reportableUnlock.reportableReady,
      blockedReasons: reportableUnlock.blockedReasons,
      stableCitationTargetProfileId: 'se-primary-reportable-reference-v1',
      stableCitationTargetScenarioIds,
    },
    scenarios: reportableScenarios,
  };

  const reportableReferencePayload = {
    ...pass2Payload,
    profile: 'se_primary_reportable_reference_v1',
    reportableReferenceProfile: {
      profileId: 'se-primary-reportable-reference-v1',
      lockedOn: DATE_STAMP,
      lane: 'sem_ellipsometry',
      sourceClassAllowlist: ['primary', 'standard'],
      scenarioIds: stableCitationTargetScenarioIds,
      sourceRefs: registryRefs,
      reportableReady: reportableUnlock.reportableReady,
      blockedReasons: reportableUnlock.blockedReasons,
    },
    scenarios: reportableScenarios.filter((scenario) => stableCitationTargetScenarioIds.includes(scenario.id)),
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
      profileGrid: [...PROFILE_IDS],
      multiplierGrid: [...MULTIPLIERS],
      scenarioCount: pass2Scenarios.length,
      reportableReady: reportableUnlock.reportableReady,
      blockedReasons: reportableUnlock.blockedReasons,
      stableCitationTargetScenarioIds,
    },
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = buildSemEllipsScenarioPacks({
    registryPath: readArgValue('--registry') ?? DEFAULT_REGISTRY_PATH,
    basePath: readArgValue('--base') ?? DEFAULT_BASE_PATH,
    pass1OutPath: readArgValue('--out-pass1') ?? DEFAULT_PASS1_OUT,
    pass2OutPath: readArgValue('--out-pass2') ?? DEFAULT_PASS2_OUT,
    reportableOutPath: readArgValue('--out-reportable') ?? DEFAULT_REPORTABLE_OUT,
    reportableReferenceOutPath: readArgValue('--out-reportable-reference') ?? DEFAULT_REPORTABLE_REFERENCE_OUT,
    pairedEvidencePath: readArgValue('--paired-evidence'),
  });
  console.log(JSON.stringify(result, null, 2));
}
