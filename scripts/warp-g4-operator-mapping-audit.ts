import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

type Wave = 'A' | 'B' | 'C' | 'D';

type GenerateG4OperatorMappingAuditOptions = {
  rootDir?: string;
  artifactRoot?: string;
  outJsonPath?: string;
  outMdPath?: string;
  waves?: Wave[];
  getCommitHash?: () => string;
};

type MappingAuditRow = {
  wave: Wave;
  operatorTarget: string;
  quantitySemanticBaseType: string | null;
  quantitySemanticType: string | null;
  quantitySemanticTargetType: string | null;
  quantityWorldlineClass: string | null;
  qeiStateClass: string | null;
  qeiRenormalizationScheme: string | null;
  qeiOperatorMapping: string | null;
  qeiSamplingNormalization: string | null;
  mappingComparable: boolean;
  mappingBridgeReady: boolean;
  mappingMissingFields: string[];
  mappingDerivationRef: string | null;
  blockedReasonTokens: string[];
};

type MappingBlockedReason =
  | 'missing_qi_forensics_wave_artifacts'
  | 'operator_mapping_fields_missing'
  | 'operator_mapping_not_comparable'
  | 'operator_mapping_bridge_not_ready';

const DATE = '2026-03-02';
const DEFAULT_ARTIFACT_ROOT = path.join('artifacts', 'research', 'full-solve');
const DEFAULT_OUT_JSON = path.join(DEFAULT_ARTIFACT_ROOT, `g4-operator-mapping-audit-${DATE}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-g4-operator-mapping-audit-${DATE}.md`);
const WAVES: Wave[] = ['A', 'B', 'C', 'D'];
const OPERATOR_TARGET = 'ren_expectation_timelike_energy_density:timelike:t_munu_uu_ren:unit_integral';
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const boolOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

const readJson = (filePath: string): any | null => {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const writeJson = (filePath: string, payload: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
};

const writeMarkdown = (filePath: string, text: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
};

const resolveHeadCommitHash = (rootDir: string): string | null => {
  for (const cwd of [rootDir, process.cwd()]) {
    try {
      return execSync('git rev-parse HEAD', { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      continue;
    }
  }
  return null;
};

const classifyRow = (wave: Wave, qi: Record<string, unknown>): MappingAuditRow => {
  const quantitySemanticBaseType = stringOrNull(qi.quantitySemanticBaseType);
  const quantitySemanticType = stringOrNull(qi.quantitySemanticType);
  const quantitySemanticTargetType = stringOrNull(qi.quantitySemanticTargetType);
  const quantityWorldlineClass = stringOrNull(qi.quantityWorldlineClass);
  const qeiStateClass = stringOrNull(qi.qeiStateClass);
  const qeiRenormalizationScheme = stringOrNull(qi.qeiRenormalizationScheme);
  const qeiOperatorMapping = stringOrNull(qi.qeiOperatorMapping);
  const qeiSamplingNormalization = stringOrNull(qi.qeiSamplingNormalization);
  const quantitySemanticComparable = boolOrNull(qi.quantitySemanticComparable);
  const quantitySemanticBridgeReady = boolOrNull(qi.quantitySemanticBridgeReady);
  const mappingDerivationRef = stringOrNull(qi.couplingEquationRef) ?? stringOrNull(qi.KDerivation);

  const mappingMissingFields: string[] = [];
  if (quantitySemanticBaseType == null) mappingMissingFields.push('quantitySemanticBaseType');
  if (quantitySemanticType == null) mappingMissingFields.push('quantitySemanticType');
  if (quantitySemanticTargetType == null) mappingMissingFields.push('quantitySemanticTargetType');
  if (quantityWorldlineClass == null) mappingMissingFields.push('quantityWorldlineClass');
  if (qeiStateClass == null) mappingMissingFields.push('qeiStateClass');
  if (qeiRenormalizationScheme == null) mappingMissingFields.push('qeiRenormalizationScheme');
  if (qeiOperatorMapping == null) mappingMissingFields.push('qeiOperatorMapping');
  if (qeiSamplingNormalization == null) mappingMissingFields.push('qeiSamplingNormalization');
  if (quantitySemanticComparable == null) mappingMissingFields.push('quantitySemanticComparable');
  if (quantitySemanticBridgeReady == null) mappingMissingFields.push('quantitySemanticBridgeReady');
  if (mappingDerivationRef == null) mappingMissingFields.push('mappingDerivationRef');

  const mappingComparable =
    quantitySemanticComparable === true &&
    quantitySemanticType === 'ren_expectation_timelike_energy_density' &&
    quantitySemanticTargetType === 'ren_expectation_timelike_energy_density' &&
    quantityWorldlineClass === 'timelike' &&
    qeiStateClass === 'hadamard' &&
    qeiRenormalizationScheme === 'point_splitting' &&
    qeiOperatorMapping === 't_munu_uu_ren' &&
    qeiSamplingNormalization === 'unit_integral';
  const mappingBridgeReady = quantitySemanticBridgeReady === true;

  const blockedReasonTokens: string[] = [];
  if (mappingMissingFields.length > 0) blockedReasonTokens.push('operator_mapping_fields_missing');
  if (!mappingComparable) blockedReasonTokens.push('operator_mapping_not_comparable');
  if (!mappingBridgeReady) blockedReasonTokens.push('operator_mapping_bridge_not_ready');

  return {
    wave,
    operatorTarget: OPERATOR_TARGET,
    quantitySemanticBaseType,
    quantitySemanticType,
    quantitySemanticTargetType,
    quantityWorldlineClass,
    qeiStateClass,
    qeiRenormalizationScheme,
    qeiOperatorMapping,
    qeiSamplingNormalization,
    mappingComparable,
    mappingBridgeReady,
    mappingMissingFields,
    mappingDerivationRef,
    blockedReasonTokens,
  };
};

export const generateG4OperatorMappingAudit = (options: GenerateG4OperatorMappingAuditOptions = {}) => {
  const rootDir = options.rootDir ?? '.';
  const artifactRoot = options.artifactRoot ?? path.join(rootDir, DEFAULT_ARTIFACT_ROOT);
  const outJsonPath = options.outJsonPath ?? path.join(rootDir, DEFAULT_OUT_JSON);
  const outMdPath = options.outMdPath ?? path.join(rootDir, DEFAULT_OUT_MD);
  const waves = options.waves ?? WAVES;
  const getCommitHash =
    options.getCommitHash ??
    (() => execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());

  const rows: MappingAuditRow[] = [];
  const canonicalMissingWaves: Wave[] = [];

  for (const wave of waves) {
    const qiPath = path.join(artifactRoot, wave, 'qi-forensics.json');
    const qi = readJson(qiPath);
    if (!qi) {
      canonicalMissingWaves.push(wave);
      continue;
    }
    rows.push(classifyRow(wave, qi as Record<string, unknown>));
  }

  const allMissingFields = rows.flatMap((row) => row.mappingMissingFields);
  const mappingMissingFieldCounts = Object.fromEntries(
    [...new Set(allMissingFields)].sort((a, b) => a.localeCompare(b)).map((field) => [field, allMissingFields.filter((f) => f === field).length]),
  );
  const blockedTokenCounts = Object.fromEntries(
    [...new Set(rows.flatMap((row) => row.blockedReasonTokens))]
      .sort((a, b) => a.localeCompare(b))
      .map((token) => [token, rows.filter((row) => row.blockedReasonTokens.includes(token)).length]),
  );

  const blockedReason: MappingBlockedReason | null =
    canonicalMissingWaves.length > 0
      ? 'missing_qi_forensics_wave_artifacts'
      : rows.some((row) => row.mappingMissingFields.length > 0)
        ? 'operator_mapping_fields_missing'
        : rows.some((row) => !row.mappingComparable)
          ? 'operator_mapping_not_comparable'
          : rows.some((row) => !row.mappingBridgeReady)
            ? 'operator_mapping_bridge_not_ready'
            : null;

  const commitHash = getCommitHash();
  const headCommitHash = resolveHeadCommitHash(rootDir);
  const payload = {
    date: DATE,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    operatorTarget: OPERATOR_TARGET,
    blockedReason,
    operatorEvidenceStatus: blockedReason == null ? 'pass' : 'blocked',
    canonicalMissingWaves,
    canonicalComparableWaveCount: rows.filter((row) => row.mappingComparable).length,
    mappingComparableAll: rows.length > 0 && rows.every((row) => row.mappingComparable),
    mappingBridgeReadyAll: rows.length > 0 && rows.every((row) => row.mappingBridgeReady),
    mappingMissingFieldCounts,
    blockedTokenCounts,
    waves: rows,
    provenance: {
      commitHash,
      headCommitHash,
      commitHashMatchesHead: headCommitHash != null && commitHash === headCommitHash,
    },
  };

  writeJson(outJsonPath, payload);

  const waveRows = rows
    .map(
      (row) =>
        `| ${row.wave} | ${row.mappingComparable} | ${row.mappingBridgeReady} | ${row.mappingMissingFields.join(', ') || 'none'} | ${row.blockedReasonTokens.join(', ') || 'none'} |`,
    )
    .join('\n');

  const md = `# G4 Operator Mapping Audit (${DATE})

${BOUNDARY_STATEMENT}

## Summary
- operator evidence status: ${payload.operatorEvidenceStatus}
- blocked reason: ${blockedReason ?? 'none'}
- canonical missing waves: ${canonicalMissingWaves.join(', ') || 'none'}
- mapping comparable all waves: ${payload.mappingComparableAll}
- mapping bridge ready all waves: ${payload.mappingBridgeReadyAll}
- provenance commit: ${commitHash}
- provenance freshness vs HEAD: ${payload.provenance.commitHashMatchesHead ? 'fresh' : 'stale_or_missing'}
- canonical-authoritative statement: canonical campaign decision remains authoritative; operator mapping audit is evidentiary and fail-closed.

## Per-wave operator mapping
| wave | mappingComparable | mappingBridgeReady | mappingMissingFields | blockedReasonTokens |
|---|---|---|---|---|
${waveRows || '| n/a | n/a | n/a | n/a | n/a |'}
`;
  writeMarkdown(outMdPath, `${md}\n`);

  return {
    ok: blockedReason == null,
    blockedReason,
    outJsonPath,
    outMdPath,
    payload,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = generateG4OperatorMappingAudit();
  console.log(JSON.stringify({ ok: result.ok, blockedReason: result.blockedReason, json: result.outJsonPath, markdown: result.outMdPath }));
}
