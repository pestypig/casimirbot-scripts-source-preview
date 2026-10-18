import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_RUN_DIR = path.join('artifacts', 'research', 'full-solve', 'se-paired-runs', DATE_STAMP);
const DEFAULT_SEM_PATH = path.join(DEFAULT_RUN_DIR, 'sem-measurements.csv');
const DEFAULT_ELLIPS_PATH = path.join(DEFAULT_RUN_DIR, 'ellips-measurements.csv');
const DEFAULT_MANIFEST_PATH = path.join(DEFAULT_RUN_DIR, 'pairing-manifest.json');
const DEFAULT_COVARIANCE_PATH = path.join(DEFAULT_RUN_DIR, 'covariance-budget.json');
const DEFAULT_OUT_EVIDENCE_PATH = path.join(DEFAULT_RUN_DIR, 'se-paired-run-evidence.v1.json');
const DEFAULT_OUT_SUMMARY_JSON_PATH = path.join(DEFAULT_RUN_DIR, 'se-paired-run-summary.v1.json');
const DEFAULT_OUT_SUMMARY_MD_PATH = path.join(DEFAULT_RUN_DIR, 'se-paired-run-summary.md');
const DEFAULT_SOURCE_REFS = ['EXP-SE-001', 'EXP-SE-002', 'EXP-SE-003', 'EXP-SE-009', 'EXP-SE-012', 'EXP-SE-013'];
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

type CsvRow = Record<string, string>;

type PairingManifest = {
  pairedRunId?: string;
  sourceClass?: string;
  sourceRefs?: string[];
  provenance?: {
    data_origin?: string;
    instrument_run_ids?: string[];
    raw_artifact_refs?: string[];
    raw_artifact_sha256?: Record<string, string>;
    operator_id?: string;
    acquisition_date_utc?: string;
  };
  semDefaults?: {
    scale_factor_sem?: number;
    b_sem_nm?: number;
    u_scale_sem?: number;
  };
  uncertainty?: {
    method?: string;
    k?: number;
    u_common_nm?: number;
    rho_sem_ellip?: number;
    covariance_sem_ellip_nm2?: number;
  };
};

type CovarianceBudget = {
  method?: string;
  k?: number;
  u_common_nm?: number;
  rho_sem_ellip?: number;
  covariance_sem_ellip_nm2?: number;
};

type SamplePair = {
  sampleId: string;
  dSemCorrNm: number;
  uSemNm: number;
  dEllipNm: number;
  uEllipNm: number;
  deltaSeNm: number;
  dFusedNm: number;
  uFusedNm: number;
  UFusedNm: number;
};

type NumericSummary = {
  nPairs: number;
  meanDeltaSeNm: number;
  meanAbsDeltaSeNm: number;
  stdDeltaSeNm: number;
  uSemNmRms: number;
  uEllipNmRms: number;
  uFusedNmMean: number;
  UFusedNmMean: number;
  seStd2PassCount: number;
  seAdv1PassCount: number;
};

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const readOptionalJson = <T>(filePath: string): T | null => {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
};

const finiteOrNull = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const finiteOrFallback = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const normalizePathRef = (value: string): string => value.replace(/\\/g, '/').trim();

const isSha256Hex = (value: string): boolean => /^[a-f0-9]{64}$/i.test(value);

const sha256File = (filePath: string): string => {
  const digest = crypto.createHash('sha256');
  digest.update(fs.readFileSync(filePath));
  return digest.digest('hex');
};

const parseCsvLine = (line: string): string[] => {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
};

const parseCsv = (filePath: string): CsvRow[] => {
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (lines.length < 2) {
    throw new Error(`CSV file has insufficient rows: ${filePath}`);
  }
  const header = parseCsvLine(lines[0]);
  const rows: CsvRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const row: CsvRow = {};
    for (let i = 0; i < header.length; i += 1) {
      row[header[i]] = cells[i] ?? '';
    }
    rows.push(row);
  }
  return rows;
};

const ensureSampleId = (row: CsvRow): string => {
  const sampleId = String(row.sample_id ?? row.sampleId ?? '').trim();
  if (!sampleId) {
    throw new Error('Missing sample_id in paired-run CSV row.');
  }
  return sampleId;
};

const getFirstNumeric = (row: CsvRow, keys: string[]): number | null => {
  for (const key of keys) {
    const value = finiteOrNull(row[key]);
    if (value != null) return value;
  }
  return null;
};

const mean = (values: number[]): number => {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const stdSample = (values: number[]): number => {
  if (values.length < 2) return 0;
  const mu = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - mu) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
};

const rms = (values: number[]): number => {
  if (values.length === 0) return 0;
  const squared = values.reduce((sum, value) => sum + value ** 2, 0) / values.length;
  return Math.sqrt(Math.max(squared, 0));
};

const pearson = (xs: number[], ys: number[]): number | null => {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return null;
  return cov / Math.sqrt(vx * vy);
};

const parseSourceRefs = (
  argValue: string | undefined,
  manifestValue: string[] | undefined,
): string[] => {
  if (argValue?.trim()) {
    return argValue
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }
  const fromManifest = (manifestValue ?? []).map((value) => String(value).trim()).filter((value) => value.length > 0);
  return fromManifest.length > 0 ? fromManifest : DEFAULT_SOURCE_REFS;
};

const toFixedNumber = (value: number, digits = 6): number => Number(value.toFixed(digits));

const buildMarkdown = (payload: {
  semPath: string;
  ellipsPath: string;
  manifestPath: string | null;
  covariancePath: string | null;
  evidencePath: string;
  pairedRunId: string;
  sourceClass: string;
  sourceRefs: string[];
  uncertaintyMethod: string;
  k: number;
  dataOrigin: string;
  instrumentRunIds: string[];
  rawArtifactRefs: string[];
  rawArtifactHashCount: number;
  rhoSemEllip: number | null;
  covarianceSemEllipNm2: number | null;
  summary: NumericSummary;
  issues: string[];
}): string => {
  const rows =
    payload.issues.length === 0
      ? '| none |'
      : payload.issues.map((issue) => `| ${issue} |`).join('\n');

  return `# SEM+Ellipsometry Paired-Run Summary (${DATE_STAMP})

"${BOUNDARY_STATEMENT}"

## Inputs
- sem_csv: \`${payload.semPath}\`
- ellips_csv: \`${payload.ellipsPath}\`
- pairing_manifest: \`${payload.manifestPath ?? 'none'}\`
- covariance_budget: \`${payload.covariancePath ?? 'none'}\`

## Evidence Output
- evidence_json: \`${payload.evidencePath}\`
- pairedRunId: \`${payload.pairedRunId}\`
- sourceClass: \`${payload.sourceClass}\`
- sourceRefs: ${payload.sourceRefs.map((ref) => `\`${ref}\``).join(', ')}
- uncertainty_method: \`${payload.uncertaintyMethod}\`
- k: \`${payload.k}\`
- data_origin: \`${payload.dataOrigin}\`
- instrument_run_ids: ${payload.instrumentRunIds.map((id) => `\`${id}\``).join(', ') || 'none'}
- raw_artifact_refs: ${payload.rawArtifactRefs.map((ref) => `\`${ref}\``).join(', ') || 'none'}
- raw_artifact_sha256_count: \`${payload.rawArtifactHashCount}\`
- rho_sem_ellip: \`${payload.rhoSemEllip}\`
- covariance_sem_ellip_nm2: \`${payload.covarianceSemEllipNm2}\`

## Numeric Summary
| metric | value |
|---|---:|
| n_pairs | ${payload.summary.nPairs} |
| mean_delta_se_nm | ${payload.summary.meanDeltaSeNm} |
| mean_abs_delta_se_nm | ${payload.summary.meanAbsDeltaSeNm} |
| std_delta_se_nm | ${payload.summary.stdDeltaSeNm} |
| u_sem_nm_rms | ${payload.summary.uSemNmRms} |
| u_ellip_nm_rms | ${payload.summary.uEllipNmRms} |
| u_fused_nm_mean | ${payload.summary.uFusedNmMean} |
| U_fused_nm_mean | ${payload.summary.UFusedNmMean} |
| se_std_2_pass_count | ${payload.summary.seStd2PassCount} |
| se_adv_1_pass_count | ${payload.summary.seAdv1PassCount} |

## Issues
| issue |
|---|
${rows}
`;
};

export const ingestSemEllipsPairedRunEvidence = (options: {
  semPath?: string;
  ellipsPath?: string;
  manifestPath?: string;
  covariancePath?: string;
  sourceClass?: string;
  sourceRefs?: string;
  pairedRunId?: string;
  outEvidencePath?: string;
  outSummaryJsonPath?: string;
  outSummaryMdPath?: string;
}) => {
  const semPath = options.semPath ?? DEFAULT_SEM_PATH;
  const ellipsPath = options.ellipsPath ?? DEFAULT_ELLIPS_PATH;
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const covariancePath = options.covariancePath ?? DEFAULT_COVARIANCE_PATH;
  const outEvidencePath = options.outEvidencePath ?? DEFAULT_OUT_EVIDENCE_PATH;
  const outSummaryJsonPath = options.outSummaryJsonPath ?? DEFAULT_OUT_SUMMARY_JSON_PATH;
  const outSummaryMdPath = options.outSummaryMdPath ?? DEFAULT_OUT_SUMMARY_MD_PATH;

  if (!fs.existsSync(semPath)) {
    throw new Error(`Missing SEM CSV input: ${semPath}`);
  }
  if (!fs.existsSync(ellipsPath)) {
    throw new Error(`Missing ellipsometry CSV input: ${ellipsPath}`);
  }

  const manifest = readOptionalJson<PairingManifest>(manifestPath);
  const covariance = readOptionalJson<CovarianceBudget>(covariancePath);

  const sourceClass = (
    options.sourceClass?.trim() ||
    manifest?.sourceClass?.trim() ||
    'primary'
  ).toLowerCase();
  const sourceRefs = parseSourceRefs(options.sourceRefs, manifest?.sourceRefs);
  const pairedRunId =
    options.pairedRunId?.trim() ||
    manifest?.pairedRunId?.trim() ||
    path.basename(path.dirname(outEvidencePath)) ||
    `se_paired_run_${DATE_STAMP}`;
  const dataOrigin = String(manifest?.provenance?.data_origin ?? '').trim().toLowerCase() || 'unspecified';
  const instrumentRunIds = (manifest?.provenance?.instrument_run_ids ?? [])
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0);
  const rawArtifactRefsFromManifest = (manifest?.provenance?.raw_artifact_refs ?? [])
    .map((value) => normalizePathRef(String(value)))
    .filter((value) => value.length > 0);
  const rawArtifactRefsAuto = [
    semPath,
    ellipsPath,
    ...(fs.existsSync(manifestPath) ? [manifestPath] : []),
    ...(fs.existsSync(covariancePath) ? [covariancePath] : []),
  ].map((value) => normalizePathRef(value));
  const rawArtifactRefs = unique([...rawArtifactRefsFromManifest, ...rawArtifactRefsAuto]);
  const rawArtifactSha256Manifest = manifest?.provenance?.raw_artifact_sha256 ?? {};
  const rawArtifactSha256: Record<string, string> = {};
  for (const ref of rawArtifactRefs) {
    const fromManifest =
      String(rawArtifactSha256Manifest[ref] ?? rawArtifactSha256Manifest[ref.replace(/\//g, '\\')] ?? '').trim().toLowerCase();
    if (isSha256Hex(fromManifest)) {
      rawArtifactSha256[ref] = fromManifest;
      continue;
    }
    if (fs.existsSync(ref) && fs.statSync(ref).isFile()) {
      rawArtifactSha256[ref] = sha256File(ref);
    }
  }

  const semRows = parseCsv(semPath);
  const ellipsRows = parseCsv(ellipsPath);

  const semBySample = new Map<string, CsvRow>();
  for (const row of semRows) semBySample.set(ensureSampleId(row), row);
  const ellipsBySample = new Map<string, CsvRow>();
  for (const row of ellipsRows) ellipsBySample.set(ensureSampleId(row), row);

  const pairedSampleIds = [...semBySample.keys()].filter((sampleId) => ellipsBySample.has(sampleId)).sort();
  if (pairedSampleIds.length === 0) {
    throw new Error('No paired sample_id entries found between SEM and ellipsometry CSV files.');
  }

  const semScaleDefault = finiteOrFallback(manifest?.semDefaults?.scale_factor_sem, 1);
  const semBiasDefaultNm = finiteOrFallback(manifest?.semDefaults?.b_sem_nm, 0);
  const semUScaleDefault = finiteOrFallback(manifest?.semDefaults?.u_scale_sem, 0);
  const uCommonNm = finiteOrFallback(covariance?.u_common_nm ?? manifest?.uncertainty?.u_common_nm, 0);
  const k = finiteOrFallback(covariance?.k ?? manifest?.uncertainty?.k, 2);
  const methodBase =
    covariance?.method?.trim() ||
    manifest?.uncertainty?.method?.trim() ||
    'paired_dual_instrument_covariance_numeric';

  const providedRho = finiteOrNull(covariance?.rho_sem_ellip ?? manifest?.uncertainty?.rho_sem_ellip);
  const providedCov = finiteOrNull(
    covariance?.covariance_sem_ellip_nm2 ?? manifest?.uncertainty?.covariance_sem_ellip_nm2,
  );

  const prePairs = pairedSampleIds.map((sampleId) => {
    const semRow = semBySample.get(sampleId) as CsvRow;
    const ellipsRow = ellipsBySample.get(sampleId) as CsvRow;

    const dSemRawNm = getFirstNumeric(semRow, ['d_sem_raw_nm', 'd_sem_nm']);
    if (dSemRawNm == null) {
      throw new Error(`Missing numeric d_sem_raw_nm for sample_id=${sampleId}`);
    }

    const scaleFactorSem = getFirstNumeric(semRow, ['scale_factor_sem']) ?? semScaleDefault;
    const bSemNm = getFirstNumeric(semRow, ['b_sem_nm']) ?? semBiasDefaultNm;
    const uScaleSem = getFirstNumeric(semRow, ['u_scale_sem']) ?? semUScaleDefault;
    const uEdgeSemNm = getFirstNumeric(semRow, ['u_edge_sem_nm']) ?? 0;
    const uDriftSemNm = getFirstNumeric(semRow, ['u_drift_sem_nm']) ?? 0;
    const uRepeatSemNm = getFirstNumeric(semRow, ['u_repeat_sem_nm']) ?? 0;
    const uTempSemNm = getFirstNumeric(semRow, ['u_temp_sem_nm']) ?? 0;

    const dSemCorrNm = dSemRawNm * scaleFactorSem + bSemNm;
    const uSemNm = Math.sqrt(
      (dSemRawNm * uScaleSem) ** 2 + uEdgeSemNm ** 2 + uDriftSemNm ** 2 + uRepeatSemNm ** 2 + uTempSemNm ** 2,
    );

    const dEllipNm = getFirstNumeric(ellipsRow, ['d_ellip_nm', 'd_ellip_raw_nm']);
    if (dEllipNm == null) {
      throw new Error(`Missing numeric d_ellip_nm (or d_ellip_raw_nm) for sample_id=${sampleId}`);
    }

    const uFitEllipNm = getFirstNumeric(ellipsRow, ['u_fit_ellip_nm']) ?? 0;
    const uModelEllipNm = getFirstNumeric(ellipsRow, ['u_model_ellip_nm']) ?? 0;
    const uRefIndexEllipNm = getFirstNumeric(ellipsRow, ['u_refindex_ellip_nm']) ?? 0;
    const uRepeatEllipNm = getFirstNumeric(ellipsRow, ['u_repeat_ellip_nm']) ?? 0;
    const uTempEllipNm = getFirstNumeric(ellipsRow, ['u_temp_ellip_nm']) ?? 0;

    const uEllipNm = Math.sqrt(
      uFitEllipNm ** 2 + uModelEllipNm ** 2 + uRefIndexEllipNm ** 2 + uRepeatEllipNm ** 2 + uTempEllipNm ** 2,
    );

    return {
      sampleId,
      dSemCorrNm,
      uSemNm,
      dEllipNm,
      uEllipNm,
      deltaSeNm: dSemCorrNm - dEllipNm,
    };
  });

  const semSeries = prePairs.map((row) => row.dSemCorrNm);
  const ellipsSeries = prePairs.map((row) => row.dEllipNm);
  const semStd = stdSample(semSeries);
  const ellipsStd = stdSample(ellipsSeries);
  const rhoMeasured = pearson(semSeries, ellipsSeries);
  const covMeasured =
    rhoMeasured != null && Number.isFinite(semStd) && Number.isFinite(ellipsStd) ? rhoMeasured * semStd * ellipsStd : null;

  let rhoSemEllip = providedRho;
  let covarianceSemEllipNm2 = providedCov;
  let method = methodBase;
  if (covarianceSemEllipNm2 == null && rhoSemEllip != null) {
    covarianceSemEllipNm2 = rhoSemEllip * rms(prePairs.map((row) => row.uSemNm)) * rms(prePairs.map((row) => row.uEllipNm));
  }
  if (rhoSemEllip == null && covarianceSemEllipNm2 != null) {
    const uSemRef = rms(prePairs.map((row) => row.uSemNm));
    const uEllipRef = rms(prePairs.map((row) => row.uEllipNm));
    if (uSemRef > 0 && uEllipRef > 0) rhoSemEllip = covarianceSemEllipNm2 / (uSemRef * uEllipRef);
  }
  if (rhoSemEllip == null && covarianceSemEllipNm2 == null && rhoMeasured != null && covMeasured != null) {
    rhoSemEllip = rhoMeasured;
    covarianceSemEllipNm2 = covMeasured;
    method = `${methodBase}+measured_pair_correlation`;
  }

  const issues: string[] = [];
  if (!['primary', 'standard'].includes(sourceClass)) {
    issues.push('paired_evidence_source_not_admissible');
  }
  if (dataOrigin !== 'instrument_export') {
    issues.push('measurement_provenance_not_instrument_export');
  }
  if (instrumentRunIds.length === 0) {
    issues.push('missing_measurement_provenance_run_ids');
  }
  if (rawArtifactRefs.length === 0) {
    issues.push('missing_measurement_provenance_raw_refs');
  }
  if (Object.keys(rawArtifactSha256).length === 0) {
    issues.push('missing_measurement_provenance_raw_hashes');
  }
  for (const ref of rawArtifactRefs) {
    if (!rawArtifactSha256[ref]) {
      issues.push(`missing_measurement_provenance_raw_hash_for_ref:${ref}`);
    }
  }

  if (rhoSemEllip != null && Math.abs(rhoSemEllip) >= 1) {
    issues.push('invalid_covariance_correlation_range');
  }

  const pairs: SamplePair[] = prePairs.map((row) => {
    const invSemVar = row.uSemNm > 0 ? 1 / (row.uSemNm ** 2) : 0;
    const invEllipVar = row.uEllipNm > 0 ? 1 / (row.uEllipNm ** 2) : 0;
    if (invSemVar <= 0 || invEllipVar <= 0) {
      issues.push(`nonpositive_instrument_uncertainty:${row.sampleId}`);
    }

    const denom = invSemVar + invEllipVar;
    const wSem = denom > 0 ? invSemVar / denom : 0.5;
    const wEllip = denom > 0 ? invEllipVar / denom : 0.5;

    const covTermNm2 =
      covarianceSemEllipNm2 ??
      (rhoSemEllip != null ? rhoSemEllip * row.uSemNm * row.uEllipNm : 0);
    const fusedVarianceNm2 =
      wSem ** 2 * row.uSemNm ** 2 +
      wEllip ** 2 * row.uEllipNm ** 2 +
      2 * wSem * wEllip * covTermNm2 +
      uCommonNm ** 2;

    const clampedVarianceNm2 = Math.max(fusedVarianceNm2, 0);
    if (fusedVarianceNm2 < 0) {
      issues.push(`negative_fused_variance_clamped:${row.sampleId}`);
    }

    const uFusedNm = Math.sqrt(clampedVarianceNm2);
    const dFusedNm = wSem * row.dSemCorrNm + wEllip * row.dEllipNm;

    return {
      sampleId: row.sampleId,
      dSemCorrNm: toFixedNumber(row.dSemCorrNm),
      uSemNm: toFixedNumber(row.uSemNm),
      dEllipNm: toFixedNumber(row.dEllipNm),
      uEllipNm: toFixedNumber(row.uEllipNm),
      deltaSeNm: toFixedNumber(row.deltaSeNm),
      dFusedNm: toFixedNumber(dFusedNm),
      uFusedNm: toFixedNumber(uFusedNm),
      UFusedNm: toFixedNumber(k * uFusedNm),
    };
  });

  const summary: NumericSummary = {
    nPairs: pairs.length,
    meanDeltaSeNm: toFixedNumber(mean(pairs.map((pair) => pair.deltaSeNm))),
    meanAbsDeltaSeNm: toFixedNumber(mean(pairs.map((pair) => Math.abs(pair.deltaSeNm)))),
    stdDeltaSeNm: toFixedNumber(stdSample(pairs.map((pair) => pair.deltaSeNm))),
    uSemNmRms: toFixedNumber(rms(pairs.map((pair) => pair.uSemNm))),
    uEllipNmRms: toFixedNumber(rms(pairs.map((pair) => pair.uEllipNm))),
    uFusedNmMean: toFixedNumber(mean(pairs.map((pair) => pair.uFusedNm))),
    UFusedNmMean: toFixedNumber(mean(pairs.map((pair) => pair.UFusedNm))),
    seStd2PassCount: pairs.filter((pair) => Math.abs(pair.deltaSeNm) <= 2 && pair.UFusedNm <= 2).length,
    seAdv1PassCount: pairs.filter((pair) => Math.abs(pair.deltaSeNm) <= 1 && pair.UFusedNm <= 1).length,
  };

  const pairedRunPresent = pairs.length > 0;
  const covarianceAnchorPresent = rhoSemEllip != null || covarianceSemEllipNm2 != null;

  const evidencePayload = {
    version: 1,
    lane: 'sem_ellipsometry',
    profilePolicy: ['SE-STD-2', 'SE-ADV-1'],
    pairedRunPresent,
    covarianceAnchorPresent,
    pairedRunId,
    sourceClass,
    sourceRefs,
    provenance: {
      data_origin: dataOrigin,
      instrument_run_ids: instrumentRunIds,
      raw_artifact_refs: rawArtifactRefs,
      raw_artifact_sha256: rawArtifactSha256,
      operator_id: manifest?.provenance?.operator_id ?? null,
      acquisition_date_utc: manifest?.provenance?.acquisition_date_utc ?? null,
    },
    uncertainty: {
      method,
      u_sem_nm: summary.uSemNmRms,
      u_ellip_nm: summary.uEllipNmRms,
      rho_sem_ellip: rhoSemEllip != null ? toFixedNumber(rhoSemEllip) : null,
      covariance_sem_ellip_nm2: covarianceSemEllipNm2 != null ? toFixedNumber(covarianceSemEllipNm2) : null,
      k,
      u_common_nm: toFixedNumber(uCommonNm),
    },
    stats: {
      ...summary,
      sem_sample_std_nm: toFixedNumber(semStd),
      ellips_sample_std_nm: toFixedNumber(ellipsStd),
      measured_rho_sem_ellip: rhoMeasured != null ? toFixedNumber(rhoMeasured) : null,
      measured_covariance_sem_ellip_nm2: covMeasured != null ? toFixedNumber(covMeasured) : null,
    },
    notes: [
      'Generated from paired SEM and ellipsometry sample IDs.',
      'Use this file with --paired-evidence to unlock SE reportable pack readiness when admissibility checks pass.',
    ],
  };

  const summaryPayload = {
    ok: true,
    boundaryStatement: BOUNDARY_STATEMENT,
    generatedOn: new Date().toISOString(),
    inputs: {
      semPath,
      ellipsPath,
      manifestPath: fs.existsSync(manifestPath) ? manifestPath : null,
      covariancePath: fs.existsSync(covariancePath) ? covariancePath : null,
    },
    pairedRunId,
    sourceClass,
    sourceRefs,
    provenance: {
      data_origin: dataOrigin,
      instrument_run_ids: instrumentRunIds,
      raw_artifact_refs: rawArtifactRefs,
      raw_artifact_sha256: rawArtifactSha256,
      operator_id: manifest?.provenance?.operator_id ?? null,
      acquisition_date_utc: manifest?.provenance?.acquisition_date_utc ?? null,
    },
    uncertaintyMethod: method,
    k,
    dataOrigin,
    instrumentRunIds,
    rawArtifactRefs,
    rawArtifactHashCount: Object.keys(rawArtifactSha256).length,
    rhoSemEllip: evidencePayload.uncertainty.rho_sem_ellip,
    covarianceSemEllipNm2: evidencePayload.uncertainty.covariance_sem_ellip_nm2,
    reportableReadyCandidate:
      pairedRunPresent && covarianceAnchorPresent && ['primary', 'standard'].includes(sourceClass) && issues.length === 0,
    summary,
    issues: [...new Set(issues)].sort((a, b) => a.localeCompare(b)),
    pairs,
  };

  fs.mkdirSync(path.dirname(outEvidencePath), { recursive: true });
  fs.mkdirSync(path.dirname(outSummaryJsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(outSummaryMdPath), { recursive: true });

  fs.writeFileSync(outEvidencePath, `${JSON.stringify(evidencePayload, null, 2)}\n`);
  fs.writeFileSync(outSummaryJsonPath, `${JSON.stringify(summaryPayload, null, 2)}\n`);
  fs.writeFileSync(
    outSummaryMdPath,
    `${buildMarkdown({
      semPath,
      ellipsPath,
      manifestPath: fs.existsSync(manifestPath) ? manifestPath : null,
      covariancePath: fs.existsSync(covariancePath) ? covariancePath : null,
      evidencePath: outEvidencePath,
      pairedRunId,
      sourceClass,
      sourceRefs,
      uncertaintyMethod: method,
      k,
      dataOrigin,
      instrumentRunIds,
      rawArtifactRefs,
      rawArtifactHashCount: Object.keys(rawArtifactSha256).length,
      rhoSemEllip: evidencePayload.uncertainty.rho_sem_ellip,
      covarianceSemEllipNm2: evidencePayload.uncertainty.covariance_sem_ellip_nm2,
      summary,
      issues: summaryPayload.issues,
    })}\n`,
  );

  return {
    ok: true,
    outEvidencePath,
    outSummaryJsonPath,
    outSummaryMdPath,
    nPairs: summary.nPairs,
    reportableReadyCandidate: summaryPayload.reportableReadyCandidate,
    issueCount: summaryPayload.issues.length,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = ingestSemEllipsPairedRunEvidence({
    semPath: readArgValue('--sem') ?? DEFAULT_SEM_PATH,
    ellipsPath: readArgValue('--ellips') ?? DEFAULT_ELLIPS_PATH,
    manifestPath: readArgValue('--manifest') ?? DEFAULT_MANIFEST_PATH,
    covariancePath: readArgValue('--covariance') ?? DEFAULT_COVARIANCE_PATH,
    sourceClass: readArgValue('--source-class'),
    sourceRefs: readArgValue('--source-refs'),
    pairedRunId: readArgValue('--paired-run-id'),
    outEvidencePath: readArgValue('--out-evidence') ?? DEFAULT_OUT_EVIDENCE_PATH,
    outSummaryJsonPath: readArgValue('--out-summary-json') ?? DEFAULT_OUT_SUMMARY_JSON_PATH,
    outSummaryMdPath: readArgValue('--out-summary-md') ?? DEFAULT_OUT_SUMMARY_MD_PATH,
  });
  console.log(JSON.stringify(result, null, 2));
}
