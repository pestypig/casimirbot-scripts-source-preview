import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_SCENARIO_PATH = path.join('configs', 'warp-shadow-injection-scenarios.se-primary-typed.v1.json');
const DEFAULT_RUN_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  `shadow-injection-run-se-primary-typed-${DATE_STAMP}.json`,
);
const DEFAULT_REGISTRY_PATH = path.join(
  'docs',
  'specs',
  'casimir-tile-experimental-parameter-registry-2026-03-04.md',
);
const DEFAULT_OUT_JSON = path.join('artifacts', 'research', 'full-solve', `se-compat-check-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-se-compat-check-${DATE_STAMP}.md`);
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

type ProfileId = 'SE-STD-2' | 'SE-ADV-1';
type Congruence = 'congruent' | 'incongruent' | 'unknown';
type ReducedReasonCategory =
  | 'missing_anchor_or_context'
  | 'missing_uncertainty_anchor'
  | 'threshold_violation'
  | 'uncertainty_edge_overlap'
  | 'source_admissibility'
  | 'reportable_contract'
  | 'other';

type RegistryRow = {
  entry_id: string;
  source_class: string;
  status: string;
};

type Scenario = {
  id: string;
  lane: string;
  registryRefs?: string[];
  experimentalContext?: {
    semEllips?: {
      profileId?: ProfileId;
      d_sem_corr_nm?: number;
      u_sem_nm?: number;
      d_ellip_nm?: number;
      u_ellip_nm?: number;
      delta_se_nm?: number;
      d_fused_nm?: number;
      u_fused_nm?: number;
      U_fused_nm?: number;
      paired_run_id?: string;
      data_origin?: string;
      instrument_run_ids?: string[];
      raw_artifact_refs?: string[];
      raw_artifact_sha256?: Record<string, string>;
      rho_sem_ellip?: number;
      covariance_sem_ellip_nm2?: number;
      sourceRefs?: string[];
      uncertainty?: {
        method?: string;
        reportableReady?: boolean;
        blockedReasons?: string[];
      };
    };
  };
};

type ScenarioPack = {
  boundaryStatement?: string;
  profileThresholds?: Partial<Record<ProfileId, { delta_se_nm_abs_max: number; U_fused_nm_max: number }>>;
  preRegistrationProfile?: {
    reportableReady?: boolean;
    blockedReasons?: string[];
  };
  reportableReferenceProfile?: {
    reportableReady?: boolean;
    blockedReasons?: string[];
  };
  scenarios: Scenario[];
};

type RunResult = {
  id: string;
  classification: 'compatible' | 'partial' | 'incompatible' | 'error';
};

type RunPayload = {
  results?: RunResult[];
};

const PROFILE_THRESHOLDS_DEFAULT: Record<ProfileId, { delta_se_nm_abs_max: number; U_fused_nm_max: number }> = {
  'SE-STD-2': { delta_se_nm_abs_max: 2.0, U_fused_nm_max: 2.0 },
  'SE-ADV-1': { delta_se_nm_abs_max: 1.0, U_fused_nm_max: 1.0 },
};

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const finiteOrNull = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const isSha256Hex = (value: string): boolean => /^[a-f0-9]{64}$/i.test(value);
const normalizeRef = (value: string): string => value.replace(/\\/g, '/').trim().toLowerCase();
const isTemplateRef = (value: string): boolean => normalizeRef(value).includes('docs/specs/data/se-paired-runs-template-');

const reduceReasonCode = (reasonCode: string): ReducedReasonCategory => {
  const code = String(reasonCode ?? '').trim().toLowerCase();
  if (!code) return 'other';
  if (code.includes('missing_covariance_uncertainty_anchor') || code.includes('missing_numeric_uncertainty_anchor')) {
    return 'missing_uncertainty_anchor';
  }
  if (code.startsWith('missing_')) return 'missing_anchor_or_context';
  if (code.includes('exceeds_profile') || code.includes('outside')) return 'threshold_violation';
  if (code.includes('edge_uncertainty_overlap')) return 'uncertainty_edge_overlap';
  if (code.includes('strict_scope_ref_not_admissible')) return 'source_admissibility';
  if (code.includes('measurement_provenance')) return 'reportable_contract';
  if (code.includes('template_placeholder_input')) return 'reportable_contract';
  if (code.includes('reportable_not_ready') || code.includes('reportable_ready_with_blocked_reasons')) {
    return 'reportable_contract';
  }
  return 'other';
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

const hasRequiredSignals = (refs: string[]): { ok: boolean; missing: string[] } => {
  const missing: string[] = [];
  if (!refs.includes('EXP-SE-003')) missing.push('missing_sem_calibration_anchor');
  if (!refs.includes('EXP-SE-012') && !refs.includes('EXP-SE-013')) missing.push('missing_ellipsometry_anchor');
  if (!refs.includes('EXP-SE-009') && !refs.includes('EXP-SE-013')) missing.push('missing_uncertainty_reporting_anchor');
  if (!refs.includes('EXP-SE-001') || !refs.includes('EXP-SE-002')) missing.push('missing_traceability_anchor');
  return { ok: missing.length === 0, missing };
};

const isStrictAdmissibleRef = (row: RegistryRow | undefined): boolean =>
  !!row &&
  String(row.status).toLowerCase() === 'extracted' &&
  ['primary', 'standard'].includes(String(row.source_class).toLowerCase());

const edgeBand = (limit: number, uFused: number): number => Math.max(0.05 * limit, 0.05) + Math.max(0, uFused);

const renderMarkdown = (payload: any): string => {
  const reasonRows =
    Object.entries(payload.summary.reasonCounts as Record<string, number>)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => `| ${reason} | ${count} |`)
      .join('\n') || '| n/a | 0 |';

  const profileRows =
    Object.entries(payload.summary.byProfile as Record<string, { congruent: number; incongruent: number; unknown: number }>)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([profile, counts]) => `| ${profile} | ${counts.congruent} | ${counts.incongruent} | ${counts.unknown} |`)
      .join('\n') || '| n/a | 0 | 0 | 0 |';

  const scenarioRows =
    (payload.scenarioChecks as Array<any>)
      .map(
        (row) =>
          `| ${row.id} | ${row.profileId ?? 'n/a'} | ${row.delta_se_nm ?? 'n/a'} | ${row.U_fused_nm ?? 'n/a'} | ${row.u_fused_nm ?? 'n/a'} | ${row.reportableReady ?? 'n/a'} | ${row.evidenceCongruence} | ${row.runClassification ?? 'n/a'} | ${row.reasonCodes.join(', ') || 'none'} |`,
      )
      .join('\n') || '| n/a | n/a | n/a | n/a | n/a | n/a | unknown | n/a | n/a |';

  return `# SEM+Ellipsometry Compatibility Check (${payload.generatedOn})

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

## Profile Summary
| profile_id | congruent | incongruent | unknown |
|---|---:|---:|---:|
${profileRows}

## Scenario Checks
| scenario_id | profile_id | delta_se_nm | U_fused_nm | u_fused_nm | reportable_ready | evidence_congruence | run_classification | reasons |
|---|---|---:|---:|---:|---|---|---|---|
${scenarioRows}

## Dominant Reasons
| reason | count |
|---|---:|
${reasonRows}
`;
};

export const runSemEllipsCompatCheck = (options: {
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
  const rowsById = new Map(registryRows.map((row) => [row.entry_id.toUpperCase(), row]));
  const runById = new Map((runPayload.results ?? []).map((row) => [row.id, row]));
  const profileThresholds = {
    ...PROFILE_THRESHOLDS_DEFAULT,
    ...(scenarioPack.profileThresholds ?? {}),
  };

  const isReportablePack = Boolean(scenarioPack.preRegistrationProfile || scenarioPack.reportableReferenceProfile);
  const reportableBlockedReasonsFromPack = [
    ...(scenarioPack.preRegistrationProfile?.blockedReasons ?? []),
    ...(scenarioPack.reportableReferenceProfile?.blockedReasons ?? []),
  ];

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
  const byProfile: Record<string, { congruent: number; incongruent: number; unknown: number }> = {};

  const scenarioChecks = scenarioPack.scenarios.map((scenario) => {
    const refs = (scenario.registryRefs ?? []).map((ref) => String(ref).trim().toUpperCase());
    const context = scenario.experimentalContext?.semEllips;
    const profileId = (context?.profileId as ProfileId | undefined) ?? null;
    const deltaSeNm = finiteOrNull(context?.delta_se_nm);
    const uFusedNm = finiteOrNull(context?.u_fused_nm);
    const UFusedNm = finiteOrNull(context?.U_fused_nm);
    const reportableReady =
      typeof context?.uncertainty?.reportableReady === 'boolean' ? context.uncertainty.reportableReady : null;
    const threshold = profileId ? profileThresholds[profileId] : null;

    const reasons: string[] = [];
    const signalCheck = hasRequiredSignals(refs);
    reasons.push(...signalCheck.missing);

    const strictScopeRefsOk = refs.every((ref) => isStrictAdmissibleRef(rowsById.get(ref)));
    if (!strictScopeRefsOk) reasons.push('strict_scope_ref_not_admissible');

    if (!context) reasons.push('missing_semellips_context_fields');
    if (!profileId) reasons.push('missing_profile_id');
    if (deltaSeNm == null || UFusedNm == null || uFusedNm == null) reasons.push('missing_semellips_context_fields');
    if (!threshold) reasons.push('missing_profile_threshold');

    const blockedReasons = [
      ...(context?.uncertainty?.blockedReasons ?? []),
      ...reportableBlockedReasonsFromPack,
    ];
    const blockedReasonsUnique = [...new Set(blockedReasons.map((reason) => String(reason).trim()).filter(Boolean))];
    if (isReportablePack) {
      const dataOrigin = String(context?.data_origin ?? '').trim().toLowerCase();
      const instrumentRunIds = (context?.instrument_run_ids ?? [])
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0);
      const rawArtifactRefs = (context?.raw_artifact_refs ?? [])
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0);
      const rawArtifactSha256Entries = Object.entries(context?.raw_artifact_sha256 ?? {}).map(([ref, hash]) => [
        String(ref).trim(),
        String(hash).trim().toLowerCase(),
      ] as const);
      const rawArtifactSha256 = Object.fromEntries(rawArtifactSha256Entries.filter(([ref]) => ref.length > 0));
      const templateRefPresent = rawArtifactRefs.some((ref) => isTemplateRef(ref));
      const templateRunId = String(context?.paired_run_id ?? '')
        .trim()
        .toLowerCase()
        .includes('template');
      if (reportableReady === true) {
        if (blockedReasonsUnique.length > 0) reasons.push('reportable_ready_with_blocked_reasons');
        const uSemNm = finiteOrNull(context?.u_sem_nm);
        const uEllipNm = finiteOrNull(context?.u_ellip_nm);
        const rhoSemEllip = finiteOrNull(context?.rho_sem_ellip);
        const covarianceSemEllipNm2 = finiteOrNull(context?.covariance_sem_ellip_nm2);
        if (uSemNm == null || uSemNm <= 0 || uEllipNm == null || uEllipNm <= 0) {
          reasons.push('missing_paired_dual_instrument_run');
        }
        if (rhoSemEllip == null && covarianceSemEllipNm2 == null) {
          reasons.push('missing_covariance_uncertainty_anchor');
        }
        if (rhoSemEllip != null && Math.abs(rhoSemEllip) >= 1) {
          reasons.push('invalid_covariance_correlation_range');
        }
        if (dataOrigin !== 'instrument_export') {
          reasons.push('measurement_provenance_not_instrument_export');
        }
        if (instrumentRunIds.length === 0) {
          reasons.push('missing_measurement_provenance_run_ids');
        }
        if (rawArtifactRefs.length === 0) {
          reasons.push('missing_measurement_provenance_raw_refs');
        }
        if (Object.keys(rawArtifactSha256).length === 0) {
          reasons.push('missing_measurement_provenance_raw_hashes');
        }
        for (const ref of rawArtifactRefs) {
          const hash = rawArtifactSha256[ref];
          if (!hash) {
            reasons.push('missing_measurement_provenance_raw_hash_for_ref');
            continue;
          }
          if (!isSha256Hex(hash)) {
            reasons.push('invalid_measurement_provenance_raw_hash_format');
          }
        }
        if (templateRefPresent || templateRunId) {
          reasons.push('template_placeholder_input');
        }
      } else {
        reasons.push('reportable_not_ready');
        if (blockedReasonsUnique.length > 0) {
          reasons.push(...blockedReasonsUnique);
          if ((templateRefPresent || templateRunId) && !blockedReasonsUnique.includes('template_placeholder_input')) {
            reasons.push('template_placeholder_input');
          }
        } else {
          reasons.push('missing_reportable_blocked_reasons');
          if (templateRefPresent || templateRunId) {
            reasons.push('template_placeholder_input');
          }
        }
      }
    }

    let evidenceCongruence: Congruence = 'unknown';
    if (reasons.length === 0 && profileId && threshold && deltaSeNm != null && UFusedNm != null && uFusedNm != null) {
      const deltaAbs = Math.abs(deltaSeNm);
      const deltaLimit = threshold.delta_se_nm_abs_max;
      const uLimit = threshold.U_fused_nm_max;
      const deltaEdge = deltaLimit + edgeBand(deltaLimit, uFusedNm);
      const uEdge = uLimit + edgeBand(uLimit, uFusedNm);

      const incongruentReasons: string[] = [];
      let edgeOverlap = false;

      if (deltaAbs <= deltaLimit) {
        // strict pass
      } else if (deltaAbs <= deltaEdge) {
        edgeOverlap = true;
      } else {
        incongruentReasons.push(`delta_exceeds_profile:${profileId}`);
      }

      if (UFusedNm <= uLimit) {
        // strict pass
      } else if (UFusedNm <= uEdge) {
        edgeOverlap = true;
      } else {
        incongruentReasons.push(`U_fused_exceeds_profile:${profileId}`);
      }

      if (incongruentReasons.length > 0) {
        evidenceCongruence = 'incongruent';
        reasons.push(...incongruentReasons);
      } else if (edgeOverlap) {
        evidenceCongruence = 'unknown';
        reasons.push('edge_uncertainty_overlap');
      } else {
        evidenceCongruence = 'congruent';
      }
    }

    if (!isReportablePack && reasons.length > 0) {
      evidenceCongruence = 'unknown';
    }

    const profileBucket = (byProfile[profileId ?? 'unknown'] ??= { congruent: 0, incongruent: 0, unknown: 0 });
    profileBucket[evidenceCongruence] += 1;

    for (const reason of reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    for (const reason of reasons) {
      const reduced = reduceReasonCode(reason);
      reducedReasonCounts[reduced] = (reducedReasonCounts[reduced] ?? 0) + 1;
    }

    return {
      id: scenario.id,
      lane: scenario.lane,
      profileId,
      delta_se_nm: deltaSeNm,
      U_fused_nm: UFusedNm,
      u_fused_nm: uFusedNm,
      reportableReady,
      blockedReasons: blockedReasonsUnique,
      evidenceCongruence,
      reasonCodes: reasons,
      reducedReasonCodes: [...new Set(reasons.map((reason) => reduceReasonCode(reason)))].sort(),
      runClassification: runById.get(scenario.id)?.classification ?? null,
    };
  });

  const summary = {
    scenarioCount: scenarioChecks.length,
    congruent: scenarioChecks.filter((row) => row.evidenceCongruence === 'congruent').length,
    incongruent: scenarioChecks.filter((row) => row.evidenceCongruence === 'incongruent').length,
    unknown: scenarioChecks.filter((row) => row.evidenceCongruence === 'unknown').length,
    byProfile,
    reasonCounts,
    reducedReasonCounts,
  };

  const payload = {
    generatedOn: new Date().toISOString(),
    boundaryStatement: scenarioPack.boundaryStatement ?? BOUNDARY_STATEMENT,
    scenarioPath,
    runPath,
    registryPath,
    isReportablePack,
    summary,
    scenarioChecks,
  };

  fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
  fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(outMdPath, `${renderMarkdown(payload)}\n`);

  return {
    ok: true,
    outJsonPath,
    outMdPath,
    summary,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runSemEllipsCompatCheck({
    scenarioPath: readArgValue('--scenarios') ?? DEFAULT_SCENARIO_PATH,
    runPath: readArgValue('--run') ?? DEFAULT_RUN_PATH,
    registryPath: readArgValue('--registry') ?? DEFAULT_REGISTRY_PATH,
    outJsonPath: readArgValue('--out') ?? DEFAULT_OUT_JSON,
    outMdPath: readArgValue('--out-md') ?? DEFAULT_OUT_MD,
  });
  console.log(JSON.stringify(result, null, 2));
}
