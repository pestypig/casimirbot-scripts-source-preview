import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_EVIDENCE_PATH = path.join(
  'docs',
  'specs',
  'templates',
  'casimir-tile-sem-ellipsometry-paired-run-evidence-template.v1.json',
);
const DEFAULT_OUT_JSON = path.join(
  'artifacts',
  'research',
  'full-solve',
  `se-paired-evidence-validate-${DATE_STAMP}.json`,
);
const DEFAULT_OUT_MD = path.join(
  'docs',
  'audits',
  'research',
  `warp-se-paired-evidence-validate-${DATE_STAMP}.md`,
);
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

type PairedEvidence = {
  version?: number;
  lane?: string;
  pairedRunPresent?: boolean;
  covarianceAnchorPresent?: boolean;
  pairedRunId?: string;
  sourceClass?: string;
  sourceRefs?: string[];
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
    u_sem_nm?: number | null;
    u_ellip_nm?: number | null;
    rho_sem_ellip?: number | null;
    covariance_sem_ellip_nm2?: number | null;
    k?: number;
  };
};

type Issue = {
  code: string;
  severity: 'error' | 'warn';
  detail: string;
};

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const finiteOrNull = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isSha256Hex = (value: string): boolean => /^[a-f0-9]{64}$/i.test(value);
const normalizeRef = (value: string): string => value.replace(/\\/g, '/').trim().toLowerCase();
const isTemplateRef = (value: string): boolean => normalizeRef(value).includes('docs/specs/data/se-paired-runs-template-');

const renderMarkdown = (payload: {
  evidencePath: string;
  reportableReadyCandidate: boolean;
  issues: Issue[];
  summary: {
    pairedRunPresent: boolean | null;
    covarianceAnchorPresent: boolean | null;
    sourceClass: string | null;
    pairedRunId: string | null;
    dataOrigin: string | null;
    instrumentRunIdCount: number;
    rawArtifactRefCount: number;
    rawArtifactHashCount: number;
    uSemNm: number | null;
    uEllipNm: number | null;
    rhoSemEllip: number | null;
    covarianceSemEllipNm2: number | null;
  };
}) => {
  const rows =
    payload.issues.length === 0
      ? '| none | none | none |\n'
      : payload.issues
          .map((issue) => `| ${issue.code} | ${issue.severity} | ${issue.detail} |`)
          .join('\n');

  return `# SEM+Ellips Paired Evidence Validation (${DATE_STAMP})

"${BOUNDARY_STATEMENT}"

## Inputs
- evidence path: \`${payload.evidencePath}\`

## Summary
- reportableReadyCandidate: \`${payload.reportableReadyCandidate}\`
- pairedRunPresent: \`${payload.summary.pairedRunPresent}\`
- covarianceAnchorPresent: \`${payload.summary.covarianceAnchorPresent}\`
- sourceClass: \`${payload.summary.sourceClass}\`
- pairedRunId: \`${payload.summary.pairedRunId}\`
- dataOrigin: \`${payload.summary.dataOrigin}\`
- instrumentRunIdCount: \`${payload.summary.instrumentRunIdCount}\`
- rawArtifactRefCount: \`${payload.summary.rawArtifactRefCount}\`
- rawArtifactHashCount: \`${payload.summary.rawArtifactHashCount}\`
- u_sem_nm: \`${payload.summary.uSemNm}\`
- u_ellip_nm: \`${payload.summary.uEllipNm}\`
- rho_sem_ellip: \`${payload.summary.rhoSemEllip}\`
- covariance_sem_ellip_nm2: \`${payload.summary.covarianceSemEllipNm2}\`

## Issues
| code | severity | detail |
|---|---|---|
${rows}
`;
};

export const validateSemEllipsPairedEvidence = (options: {
  evidencePath?: string;
  outJsonPath?: string;
  outMdPath?: string;
}) => {
  const evidencePath = options.evidencePath ?? DEFAULT_EVIDENCE_PATH;
  const outJsonPath = options.outJsonPath ?? DEFAULT_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_OUT_MD;

  const payload = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as PairedEvidence;
  const issues: Issue[] = [];

  const pairedRunPresent =
    typeof payload.pairedRunPresent === 'boolean' ? payload.pairedRunPresent : null;
  const covarianceAnchorPresent =
    typeof payload.covarianceAnchorPresent === 'boolean' ? payload.covarianceAnchorPresent : null;
  const sourceClass = payload.sourceClass?.trim().toLowerCase() || null;
  const pairedRunId = payload.pairedRunId?.trim() || null;
  const dataOrigin = payload.provenance?.data_origin?.trim().toLowerCase() || null;
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
  const rawArtifactSha256 = Object.fromEntries(
    rawArtifactSha256Entries.filter(([ref]) => ref.length > 0),
  );
  const templateRefPresent = rawArtifactRefs.some((ref) => isTemplateRef(ref));
  const templateRunId = pairedRunId?.toLowerCase().includes('template') ?? false;
  const uSemNm = finiteOrNull(payload.uncertainty?.u_sem_nm);
  const uEllipNm = finiteOrNull(payload.uncertainty?.u_ellip_nm);
  const rhoSemEllip = finiteOrNull(payload.uncertainty?.rho_sem_ellip);
  const covarianceSemEllipNm2 = finiteOrNull(payload.uncertainty?.covariance_sem_ellip_nm2);

  if (payload.lane && payload.lane !== 'sem_ellipsometry') {
    issues.push({
      code: 'lane_mismatch',
      severity: 'error',
      detail: `Expected lane=sem_ellipsometry, received lane=${payload.lane}.`,
    });
  }

  if (pairedRunPresent !== true) {
    issues.push({
      code: 'missing_paired_dual_instrument_run',
      severity: 'error',
      detail: 'pairedRunPresent must be true.',
    });
  }

  if (covarianceAnchorPresent !== true) {
    issues.push({
      code: 'missing_covariance_uncertainty_anchor',
      severity: 'error',
      detail: 'covarianceAnchorPresent must be true.',
    });
  }

  if (!sourceClass || !['primary', 'standard'].includes(sourceClass)) {
    issues.push({
      code: 'paired_evidence_source_not_admissible',
      severity: 'error',
      detail: 'sourceClass must be primary or standard for strict reportable lane.',
    });
  }

  if (!pairedRunId) {
    issues.push({
      code: 'missing_paired_run_id',
      severity: 'error',
      detail: 'pairedRunId is required.',
    });
  }

  if (dataOrigin !== 'instrument_export') {
    issues.push({
      code: 'measurement_provenance_not_instrument_export',
      severity: 'error',
      detail: 'provenance.data_origin must be instrument_export for reportable readiness.',
    });
  }

  if (instrumentRunIds.length === 0) {
    issues.push({
      code: 'missing_measurement_provenance_run_ids',
      severity: 'error',
      detail: 'provenance.instrument_run_ids must include at least one instrument run id.',
    });
  }

  if (rawArtifactRefs.length === 0) {
    issues.push({
      code: 'missing_measurement_provenance_raw_refs',
      severity: 'error',
      detail: 'provenance.raw_artifact_refs must include at least one raw artifact reference.',
    });
  }
  if (Object.keys(rawArtifactSha256).length === 0) {
    issues.push({
      code: 'missing_measurement_provenance_raw_hashes',
      severity: 'error',
      detail: 'provenance.raw_artifact_sha256 must include SHA-256 hashes for raw artifact refs.',
    });
  }
  for (const ref of rawArtifactRefs) {
    const hash = rawArtifactSha256[ref];
    if (!hash) {
      issues.push({
        code: 'missing_measurement_provenance_raw_hash_for_ref',
        severity: 'error',
        detail: `Missing SHA-256 for raw artifact ref: ${ref}`,
      });
      continue;
    }
    if (!isSha256Hex(hash)) {
      issues.push({
        code: 'invalid_measurement_provenance_raw_hash_format',
        severity: 'error',
        detail: `Invalid SHA-256 hash format for raw artifact ref: ${ref}`,
      });
    }
  }

  if (templateRefPresent || templateRunId) {
    issues.push({
      code: 'template_placeholder_input',
      severity: 'error',
      detail:
        'Template bundle inputs are rehearsal-only and cannot unlock reportable readiness. Use commit-tracked instrument-export artifacts.',
    });
  }

  if (uSemNm == null || uSemNm <= 0) {
    issues.push({
      code: 'missing_u_sem_nm',
      severity: 'error',
      detail: 'uncertainty.u_sem_nm must be numeric and > 0.',
    });
  }

  if (uEllipNm == null || uEllipNm <= 0) {
    issues.push({
      code: 'missing_u_ellip_nm',
      severity: 'error',
      detail: 'uncertainty.u_ellip_nm must be numeric and > 0.',
    });
  }

  if (rhoSemEllip == null && covarianceSemEllipNm2 == null) {
    issues.push({
      code: 'missing_covariance_numeric_anchor',
      severity: 'error',
      detail: 'Provide uncertainty.rho_sem_ellip or uncertainty.covariance_sem_ellip_nm2.',
    });
  }

  if (rhoSemEllip != null && Math.abs(rhoSemEllip) >= 1) {
    issues.push({
      code: 'invalid_covariance_correlation_range',
      severity: 'error',
      detail: 'uncertainty.rho_sem_ellip must satisfy -1 < rho < 1.',
    });
  }

  if ((payload.sourceRefs ?? []).length === 0) {
    issues.push({
      code: 'missing_source_refs',
      severity: 'warn',
      detail: 'sourceRefs is empty; include strict-anchor refs for traceability.',
    });
  }

  const reportableReadyCandidate = issues.every((issue) => issue.severity !== 'error');

  const result = {
    ok: true,
    boundaryStatement: BOUNDARY_STATEMENT,
    evidencePath,
    reportableReadyCandidate,
    issueCount: issues.length,
    issues,
    summary: {
      pairedRunPresent,
      covarianceAnchorPresent,
      sourceClass,
      pairedRunId,
      dataOrigin,
      instrumentRunIdCount: instrumentRunIds.length,
      rawArtifactRefCount: rawArtifactRefs.length,
      rawArtifactHashCount: Object.keys(rawArtifactSha256).length,
      uSemNm,
      uEllipNm,
      rhoSemEllip,
      covarianceSemEllipNm2,
    },
  };

  fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
  fs.writeFileSync(outJsonPath, `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(
    outMdPath,
    `${renderMarkdown({
      evidencePath,
      reportableReadyCandidate,
      issues,
      summary: result.summary,
    })}\n`,
  );

  return {
    ok: true,
    outJsonPath,
    outMdPath,
    reportableReadyCandidate,
    issueCount: issues.length,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = validateSemEllipsPairedEvidence({
    evidencePath: readArgValue('--evidence') ?? DEFAULT_EVIDENCE_PATH,
    outJsonPath: readArgValue('--out') ?? DEFAULT_OUT_JSON,
    outMdPath: readArgValue('--out-md') ?? DEFAULT_OUT_MD,
  });
  console.log(JSON.stringify(result, null, 2));
}
