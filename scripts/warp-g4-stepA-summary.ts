import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = '2026-02-27';
const DEFAULT_ARTIFACT_ROOT = path.join('artifacts', 'research', 'full-solve');
const DEFAULT_OUT_PATH = path.join(DEFAULT_ARTIFACT_ROOT, 'g4-stepA-summary.json');
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';
const WAVES = ['A', 'B', 'C', 'D'] as const;
const REQUIRED_FIELDS = ['lhs_Jm3', 'boundComputed_Jm3', 'boundUsed_Jm3', 'marginRatioRaw', 'marginRatioRawComputed'] as const;
const CONTRACT_REASON_CODES = new Set(['G4_QI_SOURCE_NOT_METRIC', 'G4_QI_CONTRACT_MISSING']);

type Wave = (typeof WAVES)[number];
type ComparabilityClass =
  | 'comparable_canonical'
  | 'comparable_structural_semantic_gap'
  | 'non_comparable_missing_signals'
  | 'non_comparable_contract_mismatch'
  | 'non_comparable_other';

type CanonicalRow = {
  wave: Wave;
  lhs_Jm3: number | null;
  boundComputed_Jm3: number | null;
  boundUsed_Jm3: number | null;
  marginRatioRaw: number | null;
  marginRatioRawComputed: number | null;
  applicabilityStatus: string;
  reasonCode: string[];
  rhoSource: string | null;
  quantitySemanticType: string | null;
  quantitySemanticBaseType: string | null;
  quantitySemanticTargetType: string | null;
  quantityWorldlineClass: string | null;
  quantitySemanticComparable: boolean | null;
  quantitySemanticReason: string | null;
  quantitySemanticBridgeReady: boolean | null;
  quantitySemanticBridgeMode: string | null;
  quantitySemanticBridgeMissing: string | null;
  comparabilityClass: ComparabilityClass;
};

type GenerateStepASummaryOptions = {
  artifactRoot?: string;
  outPath?: string;
  getCommitHash?: () => string;
};

const finiteOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const stringOrNull = (value: unknown): string | null => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);

const parseReasonCodes = (payload: Record<string, unknown>): string[] => {
  const fromCanonical = Array.isArray(payload.g4ReasonCodes) ? payload.g4ReasonCodes : [];
  const fromLegacy = Array.isArray((payload as any).reasonCode) ? (payload as any).reasonCode : [];
  const merged = [...fromCanonical, ...fromLegacy]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);
  return Array.from(new Set(merged)).sort((a, b) => a.localeCompare(b));
};

const classifyComparability = (row: Omit<CanonicalRow, 'wave' | 'comparabilityClass'>): ComparabilityClass => {
  const missingRequired = REQUIRED_FIELDS.some((key) => row[key] == null);
  if (missingRequired) return 'non_comparable_missing_signals';
  const contractMismatch = row.reasonCode.some((code) => CONTRACT_REASON_CODES.has(code));
  if (contractMismatch || !row.rhoSource?.startsWith('warp.metric')) return 'non_comparable_contract_mismatch';
  const canonicalSemanticComparable =
    (row.quantitySemanticBridgeReady === true ||
      (row.quantitySemanticComparable === true &&
        row.quantitySemanticType === 'ren_expectation_timelike_energy_density')) &&
    row.quantityWorldlineClass === 'timelike';
  if (canonicalSemanticComparable) return 'comparable_canonical';
  const structuralSemanticComparable =
    row.quantityWorldlineClass === 'timelike' &&
    row.quantitySemanticBridgeReady === false &&
    (row.quantitySemanticBridgeMode === 'strict_evidence_gated' ||
      (row.quantitySemanticTargetType === 'ren_expectation_timelike_energy_density' &&
        row.quantitySemanticType === 'classical_proxy_from_curvature'));
  if (structuralSemanticComparable) return 'comparable_structural_semantic_gap';
  if (!canonicalSemanticComparable) return 'non_comparable_other';
  return 'comparable_canonical';
};

const readQiForensics = (artifactRoot: string, wave: Wave): CanonicalRow | null => {
  const qiPath = path.join(artifactRoot, wave, 'qi-forensics.json');
  if (!fs.existsSync(qiPath)) return null;
  const payload = JSON.parse(fs.readFileSync(qiPath, 'utf8')) as Record<string, unknown>;
  const rowInput = {
    lhs_Jm3: finiteOrNull(payload.lhs_Jm3),
    boundComputed_Jm3: finiteOrNull(payload.boundComputed_Jm3),
    boundUsed_Jm3: finiteOrNull(payload.boundUsed_Jm3 ?? payload.bound_Jm3),
    marginRatioRaw: finiteOrNull(payload.marginRatioRaw),
    marginRatioRawComputed: finiteOrNull(payload.marginRatioRawComputed),
    applicabilityStatus: String(payload.applicabilityStatus ?? 'UNKNOWN').toUpperCase(),
    reasonCode: parseReasonCodes(payload),
    rhoSource: stringOrNull(payload.rhoSource),
    quantitySemanticType: stringOrNull((payload as any).quantitySemanticType),
    quantitySemanticBaseType: stringOrNull((payload as any).quantitySemanticBaseType),
    quantitySemanticTargetType: stringOrNull((payload as any).quantitySemanticTargetType),
    quantityWorldlineClass: stringOrNull((payload as any).quantityWorldlineClass),
    quantitySemanticComparable:
      typeof (payload as any).quantitySemanticComparable === 'boolean'
        ? Boolean((payload as any).quantitySemanticComparable)
        : null,
    quantitySemanticReason: stringOrNull((payload as any).quantitySemanticReason),
    quantitySemanticBridgeReady:
      typeof (payload as any).quantitySemanticBridgeReady === 'boolean'
        ? Boolean((payload as any).quantitySemanticBridgeReady)
        : null,
    quantitySemanticBridgeMode: stringOrNull((payload as any).quantitySemanticBridgeMode),
    quantitySemanticBridgeMissing: stringOrNull((payload as any).quantitySemanticBridgeMissing),
  };
  return {
    wave,
    ...rowInput,
    comparabilityClass: classifyComparability(rowInput),
  };
};

export const generateStepASummary = (options: GenerateStepASummaryOptions = {}) => {
  const artifactRoot = options.artifactRoot ?? DEFAULT_ARTIFACT_ROOT;
  const outPath = options.outPath ?? DEFAULT_OUT_PATH;
  const getCommitHash =
    options.getCommitHash ??
    (() => execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());

  const rows = WAVES.map((wave) => readQiForensics(artifactRoot, wave)).filter((row): row is CanonicalRow => row != null);
  const presentWaves = new Set(rows.map((row) => row.wave));
  const canonicalMissingWaves = WAVES.filter((wave) => !presentWaves.has(wave));
  const canonicalComparableRows = rows.filter((row) => row.comparabilityClass === 'comparable_canonical');
  const structuralSemanticGapRows = rows.filter((row) => row.comparabilityClass === 'comparable_structural_semantic_gap');
  const structuralComparableRows = [...canonicalComparableRows, ...structuralSemanticGapRows];
  const nonComparableRows = rows.filter(
    (row) => row.comparabilityClass !== 'comparable_canonical' && row.comparabilityClass !== 'comparable_structural_semantic_gap',
  );

  const nonComparableBuckets = nonComparableRows.reduce(
    (acc, row) => {
      if (row.comparabilityClass === 'non_comparable_missing_signals') {
        acc.non_comparable_missing_signals += 1;
      } else if (row.comparabilityClass === 'non_comparable_contract_mismatch') {
        acc.non_comparable_contract_mismatch += 1;
      } else {
        acc.non_comparable_other += 1;
      }
      return acc;
    },
    {
      non_comparable_missing_signals: 0,
      non_comparable_contract_mismatch: 0,
      non_comparable_other: 0,
    },
  );

  const semanticBridgeMissingCounter = new Map<string, number>();
  for (const row of nonComparableRows) {
    if (row.comparabilityClass !== 'non_comparable_other') continue;
    const missing = row.quantitySemanticBridgeMissing ?? 'bridge_missing_unavailable';
    for (const token of missing.split('|').map((item) => item.trim()).filter((item) => item.length > 0)) {
      semanticBridgeMissingCounter.set(token, (semanticBridgeMissingCounter.get(token) ?? 0) + 1);
    }
  }
  const semanticBridgeMissingTop = [...semanticBridgeMissingCounter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));

  const structuralSemanticGapCounter = new Map<string, number>();
  for (const row of structuralSemanticGapRows) {
    const missing = row.quantitySemanticBridgeMissing ?? 'bridge_missing_unavailable';
    for (const token of missing.split('|').map((item) => item.trim()).filter((item) => item.length > 0)) {
      structuralSemanticGapCounter.set(token, (structuralSemanticGapCounter.get(token) ?? 0) + 1);
    }
  }
  const structuralSemanticGapTop = [...structuralSemanticGapCounter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));

  const minMarginRatioRawComputedComparable =
    canonicalComparableRows
      .map((row) => row.marginRatioRawComputed)
      .filter((value): value is number => value != null)
      .sort((a, b) => a - b)[0] ?? null;
  const minMarginRatioRawComputedStructuralComparable =
    structuralComparableRows
      .map((row) => row.marginRatioRawComputed)
      .filter((value): value is number => value != null)
      .sort((a, b) => a - b)[0] ?? null;
  const candidatePassFoundCanonicalComparable = canonicalComparableRows.some(
    (row) => row.applicabilityStatus === 'PASS' && (row.marginRatioRaw ?? Number.POSITIVE_INFINITY) < 1,
  );
  const candidatePassFoundStructuralComparable = structuralComparableRows.some(
    (row) => row.applicabilityStatus === 'PASS' && (row.marginRatioRaw ?? Number.POSITIVE_INFINITY) < 1,
  );

  const payload = {
    date: DATE_STAMP,
    boundaryStatement: BOUNDARY_STATEMENT,
    canonicalWaveCount: rows.length,
    canonicalMissingWaves,
    canonicalComparableCaseCount: canonicalComparableRows.length,
    canonicalStructuralComparableCaseCount: structuralComparableRows.length,
    canonicalSemanticGapCaseCount: structuralSemanticGapRows.length,
    nonComparableCaseCount: nonComparableRows.length,
    nonComparableBuckets,
    semanticBridgeMissingTop,
    structuralSemanticGapTop,
    minMarginRatioRawComputedComparable,
    minMarginRatioRawComputedStructuralComparable,
    candidatePassFoundCanonicalComparable,
    candidatePassFoundStructuralComparable,
    provenance: {
      commitHash: getCommitHash(),
    },
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

  return {
    ok: true,
    outPath,
    canonicalComparableCaseCount: canonicalComparableRows.length,
    canonicalStructuralComparableCaseCount: structuralComparableRows.length,
    nonComparableCaseCount: nonComparableRows.length,
    candidatePassFoundCanonicalComparable,
    candidatePassFoundStructuralComparable,
    minMarginRatioRawComputedComparable,
    minMarginRatioRawComputedStructuralComparable,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(generateStepASummary()));
}
