import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

type Wave = 'A' | 'B' | 'C' | 'D';
type Priority = 'high' | 'medium' | 'low';

type GenerateSemanticBridgeMatrixOptions = {
  rootDir?: string;
  outJsonPath?: string;
  outMdPath?: string;
  stepASummaryPath?: string;
  stepCSummaryPath?: string;
  recoveryPath?: string;
  waves?: Wave[];
  getCommitHash?: () => string;
};

const DATE = '2026-02-27';
const ROOT = path.join('artifacts', 'research', 'full-solve');
const DEFAULT_OUT_JSON = path.join(ROOT, `g4-semantic-bridge-matrix-${DATE}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-g4-semantic-bridge-matrix-${DATE}.md`);
const DEFAULT_STEP_A = path.join(ROOT, 'g4-stepA-summary.json');
const DEFAULT_STEP_C = path.join(ROOT, 'g4-stepC-summary.json');
const DEFAULT_RECOVERY = path.join(ROOT, `g4-recovery-search-${DATE}.json`);
const WAVES: Wave[] = ['A', 'B', 'C', 'D'];
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
const asFinite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const parseTokens = (value: unknown): string[] => {
  const raw = asString(value);
  if (!raw) return [];
  return raw
    .split('|')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
};

const tokenPriority = (canonicalWaveCount: number, recoveryCaseCount: number): Priority => {
  if (canonicalWaveCount >= 4 && recoveryCaseCount >= 32) return 'high';
  if (canonicalWaveCount >= 2 || recoveryCaseCount >= 8) return 'medium';
  return 'low';
};

const tokenProbe = (token: string): string => {
  const mapping: Record<string, string> = {
    applicability_not_pass: 'determinize curvature/applicability signals before semantic closure reruns',
    coupling_semantics_diagnostic_only: 'promote coupling semantics from diagnostic-only to bridge-ready evidence channel',
    qei_state_class_not_hadamard: 'declare and emit Hadamard-compatible QEI state class metadata',
    qei_renormalization_not_point_splitting: 'emit point-splitting renormalization provenance for QEI channel',
    qei_sampling_normalization_not_unit_integral: 'emit and validate unit-integral sampling normalization diagnostics',
    qei_operator_mapping_not_t_munu_uu_ren: 'bind operator mapping explicitly to T_munu u^mu u^nu renormalized expectation',
    worldline_not_timelike: 'enforce timelike worldline class for timelike QEI comparability',
    source_not_metric: 'restore metric rho source contract for comparable cohort generation',
    metric_contract_not_ok: 'restore metric contract status=ok before semantic bridge attempts',
  };
  return mapping[token] ?? 'emit deterministic provenance for this blocker and rerun comparable cohort';
};

const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const writeMarkdown = (filePath: string, text: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
};

const readJson = (filePath: string): any | null => {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
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

export function generateG4SemanticBridgeMatrix(options: GenerateSemanticBridgeMatrixOptions = {}) {
  const rootDir = options.rootDir ?? '.';
  const outJsonPath = options.outJsonPath ?? path.join(rootDir, DEFAULT_OUT_JSON);
  const outMdPath = options.outMdPath ?? path.join(rootDir, DEFAULT_OUT_MD);
  const stepASummaryPath = options.stepASummaryPath ?? path.join(rootDir, DEFAULT_STEP_A);
  const stepCSummaryPath = options.stepCSummaryPath ?? path.join(rootDir, DEFAULT_STEP_C);
  const recoveryPath = options.recoveryPath ?? path.join(rootDir, DEFAULT_RECOVERY);
  const waves = options.waves ?? WAVES;
  const getCommitHash =
    options.getCommitHash ??
    (() => execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());

  const stepA = readJson(stepASummaryPath);
  const stepC = readJson(stepCSummaryPath);
  const recovery = readJson(recoveryPath);
  const commitHash = getCommitHash();
  const headCommitHash = resolveHeadCommitHash(rootDir);

  const blockedReason =
    !stepA
      ? 'missing_stepA_summary'
      : !recovery
        ? 'missing_recovery_search_artifact'
        : !Array.isArray(recovery?.cases)
          ? 'invalid_recovery_cases'
          : null;

  if (blockedReason) {
    const blockedPayload = {
      date: DATE,
      generatedAt: new Date().toISOString(),
      boundaryStatement: BOUNDARY_STATEMENT,
      blockedReason,
      stepASummaryPath: stepASummaryPath.replace(/\\/g, '/'),
      stepCSummaryPath: stepCSummaryPath.replace(/\\/g, '/'),
      recoveryPath: recoveryPath.replace(/\\/g, '/'),
      canonicalComparableCaseCount: null,
      canonicalStructuralComparableCaseCount: null,
      recoveryComparableCaseCount: null,
      recoveryStructuralComparableCaseCount: null,
      dominantBlockerToken: null,
      dominantBlockerScore: null,
      tokens: [],
      provenance: {
        commitHash,
        headCommitHash,
        commitHashMatchesHead: headCommitHash != null && commitHash === headCommitHash,
      },
    };
    writeJson(outJsonPath, blockedPayload);
    writeMarkdown(
      outMdPath,
      `# G4 Semantic Bridge Matrix (${DATE})\n\n${BOUNDARY_STATEMENT}\n\n- blockedReason: ${blockedReason}\n`,
    );
    return { ok: false as const, blockedReason, outJsonPath, outMdPath, payload: blockedPayload };
  }

  const canonicalByToken = new Map<string, Set<Wave>>();
  for (const wave of waves) {
    const qiPath = path.join(rootDir, ROOT, wave, 'qi-forensics.json');
    const qi = readJson(qiPath);
    if (!qi) continue;
    for (const token of parseTokens(qi?.quantitySemanticBridgeMissing)) {
      const bucket = canonicalByToken.get(token) ?? new Set<Wave>();
      bucket.add(wave);
      canonicalByToken.set(token, bucket);
    }
  }

  const recoveryCases: Array<Record<string, unknown>> = Array.isArray(recovery?.cases) ? recovery.cases : [];
  const recoveryComparableCases = recoveryCases.filter((row) => {
    const klass = asString((row as any).comparabilityClass);
    return klass === 'comparable_canonical' || klass === 'comparable_structural_semantic_gap';
  });
  const recoveryStructuralCases = recoveryCases.filter(
    (row) => asString((row as any).comparabilityClass) === 'comparable_structural_semantic_gap',
  );
  const recoveryByToken = new Map<
    string,
    { caseCount: number; applicabilityPassCount: number; minMarginRatioRawComputed: number | null; minMarginRatioRaw: number | null }
  >();
  for (const row of recoveryComparableCases) {
    const tokens = parseTokens((row as any).quantitySemanticBridgeMissing);
    if (tokens.length === 0) continue;
    const applicabilityPass = asString((row as any).applicabilityStatus) === 'PASS';
    const rawComputed = asFinite((row as any).marginRatioRawComputed);
    const raw = asFinite((row as any).marginRatioRaw);
    for (const token of tokens) {
      const prev = recoveryByToken.get(token) ?? {
        caseCount: 0,
        applicabilityPassCount: 0,
        minMarginRatioRawComputed: null,
        minMarginRatioRaw: null,
      };
      prev.caseCount += 1;
      if (applicabilityPass) prev.applicabilityPassCount += 1;
      if (rawComputed != null) {
        prev.minMarginRatioRawComputed =
          prev.minMarginRatioRawComputed == null ? rawComputed : Math.min(prev.minMarginRatioRawComputed, rawComputed);
      }
      if (raw != null) {
        prev.minMarginRatioRaw = prev.minMarginRatioRaw == null ? raw : Math.min(prev.minMarginRatioRaw, raw);
      }
      recoveryByToken.set(token, prev);
    }
  }

  const tokenSet = new Set<string>([...canonicalByToken.keys(), ...recoveryByToken.keys()]);
  const tokenRows = [...tokenSet]
    .map((token) => {
      const canonicalWaves = [...(canonicalByToken.get(token) ?? new Set<Wave>())].sort() as Wave[];
      const recoveryStats = recoveryByToken.get(token) ?? {
        caseCount: 0,
        applicabilityPassCount: 0,
        minMarginRatioRawComputed: null,
        minMarginRatioRaw: null,
      };
      const score = canonicalWaves.length * 1000 + recoveryStats.caseCount * 10 + (recoveryStats.applicabilityPassCount === 0 ? 5 : 0);
      return {
        token,
        score,
        closurePriority: tokenPriority(canonicalWaves.length, recoveryStats.caseCount),
        canonicalWaveCount: canonicalWaves.length,
        canonicalWaves,
        recoveryCaseCount: recoveryStats.caseCount,
        recoveryApplicabilityPassCount: recoveryStats.applicabilityPassCount,
        minMarginRatioRawComputed: recoveryStats.minMarginRatioRawComputed,
        minMarginRatioRaw: recoveryStats.minMarginRatioRaw,
        recommendedProbe: tokenProbe(token),
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.canonicalWaveCount - a.canonicalWaveCount ||
        b.recoveryCaseCount - a.recoveryCaseCount ||
        a.token.localeCompare(b.token),
    );

  const dominant = tokenRows[0] ?? null;
  const payload = {
    date: DATE,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    blockedReason: null,
    stepASummaryPath: stepASummaryPath.replace(/\\/g, '/'),
    stepCSummaryPath: stepCSummaryPath.replace(/\\/g, '/'),
    recoveryPath: recoveryPath.replace(/\\/g, '/'),
    canonicalComparableCaseCount: asFinite(stepA?.canonicalComparableCaseCount),
    canonicalStructuralComparableCaseCount: asFinite(
      stepA?.canonicalStructuralComparableCaseCount ?? stepA?.canonicalComparableCaseCount,
    ),
    canonicalSemanticGapCaseCount: asFinite(stepA?.canonicalSemanticGapCaseCount),
    recoveryComparableCaseCount: recoveryComparableCases.length,
    recoveryStructuralComparableCaseCount: recoveryStructuralCases.length,
    candidatePassFoundCanonicalComparable: Boolean(recovery?.candidatePassFoundCanonical ?? recovery?.candidatePassFound),
    candidatePassFoundStructuralComparable: Boolean(recovery?.candidatePassFoundStructuralComparable),
    stepCBootstrapSucceeded: typeof stepC?.bootstrapSucceeded === 'boolean' ? stepC.bootstrapSucceeded : null,
    stepCBlockedReason: asString(stepC?.blockedReason),
    dominantBlockerToken: dominant?.token ?? null,
    dominantBlockerScore: dominant?.score ?? null,
    tokens: tokenRows,
    provenance: {
      commitHash,
      headCommitHash,
      commitHashMatchesHead: headCommitHash != null && commitHash === headCommitHash,
      stepACommitHash: asString(stepA?.provenance?.commitHash),
      stepCCommitHash: asString(stepC?.provenance?.commitHash),
      recoveryCommitHash: asString(recovery?.provenance?.commitHash),
    },
  };

  writeJson(outJsonPath, payload);

  const tableRows = tokenRows
    .slice(0, 12)
    .map(
      (row) =>
        `| ${row.token} | ${row.closurePriority} | ${row.canonicalWaveCount} | ${row.canonicalWaves.join(',') || 'n/a'} | ${row.recoveryCaseCount} | ${row.recoveryApplicabilityPassCount} | ${row.minMarginRatioRawComputed ?? 'n/a'} | ${row.recommendedProbe} |`,
    )
    .join('\n');
  const md = `# G4 Semantic Bridge Matrix (${DATE})

${BOUNDARY_STATEMENT}

## Summary
- dominant blocker token: ${payload.dominantBlockerToken ?? 'n/a'}
- dominant blocker score: ${payload.dominantBlockerScore ?? 'n/a'}
- canonical comparable count: ${payload.canonicalComparableCaseCount ?? 'n/a'}
- canonical structural comparable count: ${payload.canonicalStructuralComparableCaseCount ?? 'n/a'}
- recovery structural comparable count: ${payload.recoveryStructuralComparableCaseCount}
- candidatePassFoundCanonicalComparable: ${payload.candidatePassFoundCanonicalComparable}
- candidatePassFoundStructuralComparable: ${payload.candidatePassFoundStructuralComparable}

## Top blockers
| token | priority | canonical waves | wave list | recovery cases | recovery applicability PASS | min marginRawComputed | recommended probe |
|---|---|---:|---|---:|---:|---:|---|
${tableRows || '| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |'}
`;
  writeMarkdown(outMdPath, `${md}\n`);

  return {
    ok: true as const,
    outJsonPath,
    outMdPath,
    payload,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = generateG4SemanticBridgeMatrix();
  console.log(JSON.stringify({ ok: result.ok, json: result.outJsonPath, markdown: result.outMdPath }));
}
