import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_CANONICAL_ROOT = path.join('artifacts', 'research', 'full-solve');
const DEFAULT_WAVE = 'A';
const DEFAULT_REL_TOL = 1e-9;
const DEFAULT_ABS_TOL = 1e-12;
const DEFAULT_SELECTOR = 'same-rho-source';
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

type DivergenceField = {
  name: string;
  aliases?: string[];
};

type StageDefinition = {
  id: string;
  label: string;
  fields: DivergenceField[];
};

type StageFieldComparison = {
  name: string;
  canonicalValue: unknown;
  recoveryValue: unknown;
  equal: boolean;
  comparator: 'numeric_tolerance' | 'exact';
  deltaAbs: number | null;
  deltaRel: number | null;
  reason: string | null;
};

type StageComparison = {
  id: string;
  label: string;
  diverged: boolean;
  comparedFields: number;
  differingFields: string[];
  fields: StageFieldComparison[];
};

type FirstDivergence = {
  stageId: string;
  stageLabel: string;
  differingFields: string[];
  summary: string;
};

type RecoveryCase = Record<string, unknown> & {
  id?: string;
};

type GenerateG4FirstDivergenceOptions = {
  canonicalRoot?: string;
  canonicalWave?: string;
  canonicalPath?: string;
  recoveryPath?: string;
  recoveryCaseId?: string;
  selector?: 'same-rho-source' | 'best-candidate' | 'lowest-margin';
  relTol?: number;
  absTol?: number;
  outJsonPath?: string;
  outMdPath?: string;
  getCommitHash?: () => string;
};

const STAGES: StageDefinition[] = [
  {
    id: 'S0_source',
    label: 'Source',
    fields: [
      { name: 'rhoSource' },
      { name: 'metricT00Ref' },
      { name: 'metricT00Si_Jm3', aliases: ['metricT00SiFromGeom_Jm3'] },
    ],
  },
  {
    id: 'S1_qi_sample',
    label: 'QI Sample',
    fields: [{ name: 'lhs_Jm3' }],
  },
  {
    id: 'S2_bound_computed',
    label: 'Bound Computed',
    fields: [{ name: 'boundComputed_Jm3' }, { name: 'K' }, { name: 'tau_s' }],
  },
  {
    id: 'S3_bound_policy',
    label: 'Bound Policy',
    fields: [
      { name: 'boundUsed_Jm3' },
      { name: 'boundFloorApplied' },
      { name: 'boundPolicyFloor_Jm3' },
      { name: 'boundFloor_Jm3' },
    ],
  },
  {
    id: 'S4_margin',
    label: 'Margin',
    fields: [{ name: 'marginRatioRawComputed', aliases: ['marginRatioRaw'] }, { name: 'marginRatioRaw' }],
  },
  {
    id: 'S5_gate',
    label: 'Gate',
    fields: [
      { name: 'applicabilityStatus' },
      { name: 'reasonCode', aliases: ['g4ReasonCodes'] },
    ],
  },
];

const normalizeArray = (value: unknown[]): unknown[] => {
  const allScalars = value.every((entry) => ['string', 'number', 'boolean'].includes(typeof entry) || entry == null);
  if (!allScalars) return value;
  return value.slice().sort((a, b) => String(a).localeCompare(String(b)));
};

const normalizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return normalizeArray(value);
  return value;
};

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const pickFieldValue = (record: Record<string, unknown>, field: DivergenceField): unknown => {
  const keys = [field.name, ...(field.aliases ?? [])];
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
};

const compareField = (
  field: DivergenceField,
  canonicalRecord: Record<string, unknown>,
  recoveryRecord: Record<string, unknown>,
  relTol: number,
  absTol: number,
): StageFieldComparison => {
  const canonicalValue = pickFieldValue(canonicalRecord, field);
  const recoveryValue = pickFieldValue(recoveryRecord, field);
  const canonicalNum = finiteOrNull(canonicalValue);
  const recoveryNum = finiteOrNull(recoveryValue);

  if (canonicalNum != null && recoveryNum != null) {
    const deltaAbs = Math.abs(canonicalNum - recoveryNum);
    const deltaRel = deltaAbs / Math.max(Math.abs(canonicalNum), Math.abs(recoveryNum), 1);
    const threshold = Math.max(absTol, relTol * Math.max(Math.abs(canonicalNum), Math.abs(recoveryNum), 1));
    const equal = deltaAbs <= threshold;
    return {
      name: field.name,
      canonicalValue,
      recoveryValue,
      equal,
      comparator: 'numeric_tolerance',
      deltaAbs,
      deltaRel,
      reason: equal ? null : `|Δ|=${deltaAbs} > tol=${threshold}`,
    };
  }

  const canonicalNormalized = normalizeValue(canonicalValue);
  const recoveryNormalized = normalizeValue(recoveryValue);
  const equal = JSON.stringify(canonicalNormalized) === JSON.stringify(recoveryNormalized);
  return {
    name: field.name,
    canonicalValue,
    recoveryValue,
    equal,
    comparator: 'exact',
    deltaAbs: null,
    deltaRel: null,
    reason: equal ? null : 'exact_mismatch',
  };
};

const compareStage = (
  stage: StageDefinition,
  canonicalRecord: Record<string, unknown>,
  recoveryRecord: Record<string, unknown>,
  relTol: number,
  absTol: number,
): StageComparison => {
  const fields = stage.fields.map((field) => compareField(field, canonicalRecord, recoveryRecord, relTol, absTol));
  const differingFields = fields.filter((field) => !field.equal).map((field) => field.name);
  return {
    id: stage.id,
    label: stage.label,
    diverged: differingFields.length > 0,
    comparedFields: fields.length,
    differingFields,
    fields,
  };
};

const findLatestRecoveryPath = (canonicalRoot: string): string | null => {
  if (!fs.existsSync(canonicalRoot)) return null;
  const entries = fs
    .readdirSync(canonicalRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /^g4-recovery-search-.*\.json$/i.test(entry.name) &&
        !entry.name.toLowerCase().includes('.log'),
    )
    .map((entry) => {
      const full = path.join(canonicalRoot, entry.name);
      const stat = fs.statSync(full);
      return { full, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.full.localeCompare(b.full));
  return entries[0]?.full ?? null;
};

const compareByMarginThenId = (a: RecoveryCase, b: RecoveryCase): number =>
  (finiteOrNull(a.marginRatioRawComputed) ?? Number.POSITIVE_INFINITY) -
    (finiteOrNull(b.marginRatioRawComputed) ?? Number.POSITIVE_INFINITY) ||
  (finiteOrNull(a.marginRatioRaw) ?? Number.POSITIVE_INFINITY) -
    (finiteOrNull(b.marginRatioRaw) ?? Number.POSITIVE_INFINITY) ||
  String(a.id ?? '').localeCompare(String(b.id ?? ''));

const selectRecoveryCase = (
  payload: Record<string, unknown>,
  canonical: Record<string, unknown>,
  selector: 'same-rho-source' | 'best-candidate' | 'lowest-margin',
  explicitCaseId?: string,
): { selected: RecoveryCase | null; selectionReason: string } => {
  const cases = Array.isArray(payload.cases) ? (payload.cases as RecoveryCase[]) : [];
  if (cases.length === 0) return { selected: null, selectionReason: 'recovery_cases_missing' };

  if (explicitCaseId) {
    const selected = cases.find((entry) => String(entry.id ?? '') === explicitCaseId) ?? null;
    return {
      selected,
      selectionReason: selected ? 'explicit_case_id' : 'explicit_case_id_not_found',
    };
  }

  if (selector === 'best-candidate') {
    const bestId = asString(asRecord(payload.bestCandidate).id);
    if (bestId) {
      const selected = cases.find((entry) => String(entry.id ?? '') === bestId) ?? null;
      if (selected) return { selected, selectionReason: 'best_candidate' };
    }
  }

  if (selector === 'same-rho-source') {
    const canonicalRho = asString(canonical.rhoSource);
    if (canonicalRho) {
      const matches = cases
        .filter((entry) => asString(entry.rhoSource) === canonicalRho)
        .sort(compareByMarginThenId);
      if (matches.length > 0) return { selected: matches[0], selectionReason: 'same_rho_source' };
    }
  }

  const lowestMargin = cases.slice().sort(compareByMarginThenId)[0] ?? null;
  return {
    selected: lowestMargin,
    selectionReason: selector === 'lowest-margin' ? 'lowest_margin' : 'fallback_lowest_margin',
  };
};

const parseArg = (name: string): string | null => {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  const value = args[idx + 1];
  return value.startsWith('--') ? null : value;
};

const parseNumberArg = (name: string): number | null => {
  const raw = parseArg(name);
  if (raw == null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

export const generateG4FirstDivergence = (options: GenerateG4FirstDivergenceOptions = {}) => {
  const canonicalRoot = options.canonicalRoot ?? DEFAULT_CANONICAL_ROOT;
  const canonicalWave = (options.canonicalWave ?? DEFAULT_WAVE).toUpperCase();
  const canonicalPath =
    options.canonicalPath ?? path.join(canonicalRoot, canonicalWave, 'qi-forensics.json');
  const recoveryPath =
    options.recoveryPath ??
    findLatestRecoveryPath(canonicalRoot) ??
    path.join(canonicalRoot, 'g4-recovery-search-2026-02-27.json');
  const selector = options.selector ?? DEFAULT_SELECTOR;
  const relTol = Math.max(0, options.relTol ?? DEFAULT_REL_TOL);
  const absTol = Math.max(0, options.absTol ?? DEFAULT_ABS_TOL);
  const outJsonPath =
    options.outJsonPath ??
    path.join(canonicalRoot, `g4-first-divergence-${DATE_STAMP}.json`);
  const outMdPath =
    options.outMdPath ??
    path.join('docs', 'audits', 'research', `warp-g4-first-divergence-${DATE_STAMP}.md`);

  const commitHash = options.getCommitHash
    ? options.getCommitHash()
    : execSync('git rev-parse HEAD', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

  const blocked = (reason: string, details: Record<string, unknown> = {}) => {
    const payload = {
      date: DATE_STAMP,
      generatedAt: new Date().toISOString(),
      boundaryStatement: BOUNDARY_STATEMENT,
      blockedReason: reason,
      canonicalWave,
      canonicalPath: canonicalPath.replace(/\\/g, '/'),
      recoveryPath: recoveryPath.replace(/\\/g, '/'),
      selector,
      relTol,
      absTol,
      provenance: {
        commitHash,
      },
      ...details,
    };

    fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
    fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
    fs.writeFileSync(
      outMdPath,
      `# G4 First Divergence (${DATE_STAMP})\n\n${BOUNDARY_STATEMENT}\n\n- blockedReason: ${reason}\n`,
      'utf8',
    );
    return { ok: false, blockedReason: reason, outJsonPath, outMdPath };
  };

  if (!fs.existsSync(canonicalPath)) {
    return blocked('canonical_qi_forensics_missing');
  }
  if (!fs.existsSync(recoveryPath)) {
    return blocked('recovery_search_missing');
  }

  const canonicalRaw = JSON.parse(fs.readFileSync(canonicalPath, 'utf8')) as Record<string, unknown>;
  const recoveryRaw = JSON.parse(fs.readFileSync(recoveryPath, 'utf8')) as Record<string, unknown>;

  const selection = selectRecoveryCase(
    recoveryRaw,
    canonicalRaw,
    selector,
    options.recoveryCaseId,
  );
  if (selection.selected == null) {
    return blocked(selection.selectionReason, {
      recoveryCaseIdRequested: options.recoveryCaseId ?? null,
    });
  }

  const stageComparisons = STAGES.map((stage) =>
    compareStage(stage, canonicalRaw, selection.selected as Record<string, unknown>, relTol, absTol),
  );
  const firstDivergedStage = stageComparisons.find((stage) => stage.diverged);
  const firstDivergence: FirstDivergence | null = firstDivergedStage
    ? {
        stageId: firstDivergedStage.id,
        stageLabel: firstDivergedStage.label,
        differingFields: firstDivergedStage.differingFields,
        summary: `${firstDivergedStage.id} diverged on: ${firstDivergedStage.differingFields.join(', ')}`,
      }
    : null;

  const payload = {
    date: DATE_STAMP,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    blockedReason: null,
    canonical: {
      wave: canonicalWave,
      path: canonicalPath.replace(/\\/g, '/'),
      id: asString(canonicalRaw.wave) ?? `canonical_${canonicalWave.toLowerCase()}`,
      rhoSource: asString(canonicalRaw.rhoSource),
    },
    recovery: {
      path: recoveryPath.replace(/\\/g, '/'),
      caseId: asString(selection.selected.id) ?? null,
      selectionReason: selection.selectionReason,
      requestedCaseId: options.recoveryCaseId ?? null,
      rhoSource: asString(selection.selected.rhoSource),
      comparabilityClass: asString(selection.selected.comparabilityClass),
    },
    tolerances: {
      absTol,
      relTol,
    },
    firstDivergence,
    stageComparisons,
    provenance: {
      commitHash,
      recoveryCommitHash: asString(asRecord(recoveryRaw.provenance).commitHash),
      kProvenanceCommit: asString(canonicalRaw.KProvenanceCommit),
    },
  };

  fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
  fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const mdLines = [
    `# G4 First Divergence (${DATE_STAMP})`,
    '',
    BOUNDARY_STATEMENT,
    '',
    `- canonical: ${payload.canonical.id} (${payload.canonical.path})`,
    `- recovery: ${payload.recovery.caseId ?? 'unknown'} (${payload.recovery.path})`,
    `- recovery selection: ${payload.recovery.selectionReason}`,
    `- first divergence: ${firstDivergence ? firstDivergence.summary : 'none_detected'}`,
    '',
    '## Stage Comparison',
    '',
    '| stage | diverged | differing fields |',
    '| --- | --- | --- |',
    ...stageComparisons.map(
      (stage) =>
        `| ${stage.id} (${stage.label}) | ${String(stage.diverged)} | ${
          stage.differingFields.join(', ') || 'none'
        } |`,
    ),
    '',
  ];
  fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
  fs.writeFileSync(outMdPath, `${mdLines.join('\n')}\n`, 'utf8');

  return {
    ok: true,
    outJsonPath,
    outMdPath,
    firstDivergence,
    recoveryCaseId: payload.recovery.caseId,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const selectorArg = parseArg('--selector');
  const selector =
    selectorArg === 'best-candidate' || selectorArg === 'lowest-margin' || selectorArg === 'same-rho-source'
      ? selectorArg
      : undefined;

  const result = generateG4FirstDivergence({
    canonicalRoot: parseArg('--canonical-root') ?? undefined,
    canonicalWave: parseArg('--canonical-wave') ?? undefined,
    canonicalPath: parseArg('--canonical-path') ?? undefined,
    recoveryPath: parseArg('--recovery-path') ?? undefined,
    recoveryCaseId: parseArg('--recovery-case-id') ?? undefined,
    selector,
    relTol: parseNumberArg('--rel-tol') ?? undefined,
    absTol: parseNumberArg('--abs-tol') ?? undefined,
    outJsonPath: parseArg('--out-json') ?? undefined,
    outMdPath: parseArg('--out-md') ?? undefined,
  });
  console.log(JSON.stringify(result, null, 2));
}
