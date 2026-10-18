import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

type Wave = 'A' | 'B' | 'C' | 'D';
type DualFailMode = 'policy_only' | 'computed_only' | 'both' | 'neither';
type AuthoritativeClass = 'policy-floor dominated' | 'computed-bound dominated' | 'both' | 'neither' | 'evidence_path_blocked';

const DATE = '2026-02-27';
const ROOT = path.join('artifacts', 'research', 'full-solve');
const OUT_JSON = path.join(ROOT, `g4-governance-matrix-${DATE}.json`);
const OUT_MD = path.join('docs', 'audits', 'research', `warp-g4-governance-matrix-${DATE}.md`);
const WAVES: Wave[] = ['A', 'B', 'C', 'D'];
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

const finiteOrNull = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);

const dual = (policy: boolean, computed: boolean): DualFailMode =>
  policy && computed ? 'both' : policy ? 'policy_only' : computed ? 'computed_only' : 'neither';

const fmt = (n: number | null): string => (n == null ? 'n/a' : Number(n).toString());

type Row = {
  wave: Wave;
  evidencePresent: boolean;
  lhs_Jm3: number | null;
  boundComputed_Jm3: number | null;
  boundUsed_Jm3: number | null;
  boundFloorApplied: boolean | null;
  marginRatioRaw: number | null;
  marginRatioRawComputed: number | null;
  applicabilityStatus: string;
  g4FloorDominated: boolean;
  g4PolicyExceeded: boolean;
  g4ComputedExceeded: boolean;
  g4DualFailMode: DualFailMode;
  canonicalAuthoritativeClass: Exclude<AuthoritativeClass, 'evidence_path_blocked'>;
  computedOnlyCounterfactualClass: 'computed-bound dominated' | 'neither';
  mismatch: boolean;
  mismatchReason: string;
};

type GenerateG4GovernanceMatrixOptions = {
  rootDir?: string;
  outJsonPath?: string;
  outMdPath?: string;
  waves?: Wave[];
  getCommitHash?: () => string;
};

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const tryReadJson = (filePath: string): any | null => {
  if (!fs.existsSync(filePath)) return null;
  return readJson(filePath);
};

const isResolvableCommitHash = (hash: string, cwd: string): boolean => {
  try {
    execFileSync('git', ['cat-file', '-e', `${hash}^{commit}`], { encoding: 'utf8', stdio: 'ignore', cwd });
    return true;
  } catch {
    return false;
  }
};

const resolveHeadCommitHash = (cwdCandidates: string[]): string | null => {
  for (const cwd of cwdCandidates) {
    try {
      return execSync('git rev-parse HEAD', { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      continue;
    }
  }
  return null;
};

function classifyAuthoritative(d: Row['g4DualFailMode']): Row['canonicalAuthoritativeClass'] {
  if (d === 'both') return 'both';
  if (d === 'policy_only') return 'policy-floor dominated';
  if (d === 'computed_only') return 'computed-bound dominated';
  return 'neither';
}

const classifyAggregate = (classes: Row['canonicalAuthoritativeClass'][]): {
  canonicalAuthoritativeClass: AuthoritativeClass;
  mismatch: boolean;
  mismatchReason: string;
} => {
  if (classes.length === 0) {
    return {
      canonicalAuthoritativeClass: 'evidence_path_blocked',
      mismatch: true,
      mismatchReason: 'canonical_authoritative_aggregate_missing_required_waves',
    };
  }
  const uniqueClasses = Array.from(new Set(classes));
  if (uniqueClasses.length === 1) {
    return {
      canonicalAuthoritativeClass: uniqueClasses[0],
      mismatch: false,
      mismatchReason: 'none',
    };
  }
  return {
    canonicalAuthoritativeClass: 'evidence_path_blocked',
    mismatch: true,
    mismatchReason: `canonical_authoritative_aggregate_wave_disagreement:${uniqueClasses.join('|')}`,
  };
};

const aggregateCounterfactualClass = (classes: Row['computedOnlyCounterfactualClass'][]): AuthoritativeClass => {
  if (classes.length === 0) return 'evidence_path_blocked';
  const unique = Array.from(new Set(classes));
  return unique.length === 1 ? unique[0] : 'evidence_path_blocked';
};

export function generateG4GovernanceMatrix(options: GenerateG4GovernanceMatrixOptions = {}) {
  const rootDir = options.rootDir ?? '.';
  const outJsonPath = options.outJsonPath ?? path.join(rootDir, OUT_JSON);
  const outMdPath = options.outMdPath ?? path.join(rootDir, OUT_MD);
  const waves = options.waves ?? WAVES;
  const getCommitHash =
    options.getCommitHash ??
    (() => execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());

  const commitHash = getCommitHash();
  const headCommitHash = resolveHeadCommitHash([rootDir, process.cwd()]);
  const commitHashShapeValid = COMMIT_HASH_RE.test(commitHash);
  const commitHashResolvable = commitHashShapeValid && isResolvableCommitHash(commitHash, rootDir);
  const commitHashMatchesHead = headCommitHash != null && commitHashResolvable && commitHash === headCommitHash;
  const missingWaves: Wave[] = [];
  const rows: Row[] = waves.map((wave) => {
    const canonicalEvidencePath = path.join(rootDir, ROOT, wave, 'evidence-pack.json');
    const fallbackEvidencePath = path.join(rootDir, wave, 'evidence-pack.json');
    const evidence = tryReadJson(canonicalEvidencePath) ?? tryReadJson(fallbackEvidencePath);
    if (!evidence) {
      missingWaves.push(wave);
      return {
        wave,
        evidencePresent: false,
        lhs_Jm3: null,
        boundComputed_Jm3: null,
        boundUsed_Jm3: null,
        boundFloorApplied: null,
        marginRatioRaw: null,
        marginRatioRawComputed: null,
        applicabilityStatus: 'UNKNOWN',
        g4FloorDominated: false,
        g4PolicyExceeded: false,
        g4ComputedExceeded: false,
        g4DualFailMode: 'neither',
        canonicalAuthoritativeClass: 'neither',
        computedOnlyCounterfactualClass: 'neither',
        mismatch: false,
        mismatchReason: 'missing_evidence_pack',
      };
    }
    const d = evidence?.g4Diagnostics ?? {};
    const lhs = finiteOrNull(d.lhs_Jm3);
    const boundComputed = finiteOrNull(d.boundComputed_Jm3);
    const boundUsed = finiteOrNull(d.boundUsed_Jm3);
    const boundFloorApplied = typeof d.boundFloorApplied === 'boolean' ? d.boundFloorApplied : null;
    const raw = finiteOrNull(d.marginRatioRaw);
    const rawComputed = finiteOrNull(d.marginRatioRawComputed);
    const g4FloorDominated = Boolean(boundFloorApplied === true && boundUsed != null && boundComputed != null && boundUsed !== boundComputed);
    const g4PolicyExceeded = Boolean((raw ?? Number.POSITIVE_INFINITY) >= 1);
    const g4ComputedExceeded = Boolean((rawComputed ?? Number.POSITIVE_INFINITY) >= 1);
    const g4DualFailMode = dual(g4PolicyExceeded, g4ComputedExceeded);
    const canonicalAuthoritativeClass = classifyAuthoritative(g4DualFailMode);
    const computedOnlyCounterfactualClass = g4ComputedExceeded ? 'computed-bound dominated' : 'neither';
    const mismatch = canonicalAuthoritativeClass !== computedOnlyCounterfactualClass;
    const mismatchReason = mismatch
      ? `canonical=${canonicalAuthoritativeClass};counterfactual=${computedOnlyCounterfactualClass};floorApplied=${boundFloorApplied ?? 'n/a'};boundUsed=${fmt(boundUsed)};boundComputed=${fmt(boundComputed)};marginRaw=${fmt(raw)};marginRawComputed=${fmt(rawComputed)}`
      : `canonical_matches_counterfactual;class=${canonicalAuthoritativeClass}`;

    return {
      wave,
      evidencePresent: true,
      lhs_Jm3: lhs,
      boundComputed_Jm3: boundComputed,
      boundUsed_Jm3: boundUsed,
      boundFloorApplied,
      marginRatioRaw: raw,
      marginRatioRawComputed: rawComputed,
      applicabilityStatus: String(d.applicabilityStatus ?? 'UNKNOWN'),
      g4FloorDominated,
      g4PolicyExceeded,
      g4ComputedExceeded,
      g4DualFailMode,
      canonicalAuthoritativeClass,
      computedOnlyCounterfactualClass,
      mismatch,
      mismatchReason,
    };
  });

  const aggregateCanonical = missingWaves.length > 0
    ? {
        canonicalAuthoritativeClass: 'evidence_path_blocked' as AuthoritativeClass,
        mismatch: true,
        mismatchReason: `canonical_authoritative_aggregate_missing_required_waves:${missingWaves.join(',')}`,
      }
    : classifyAggregate(rows.map((r) => r.canonicalAuthoritativeClass));
  const aggregateCounterfactual = aggregateCounterfactualClass(rows.map((r) => r.computedOnlyCounterfactualClass));

  const payload = {
    date: DATE,
    commitHash,
    headCommitHash,
    commitHashShapeValid,
    commitHashResolvable,
    commitHashMatchesHead,
    boundaryStatement: BOUNDARY_STATEMENT,
    canonicalMissingWaves: missingWaves,
    canonicalAuthoritativeClass: aggregateCanonical.canonicalAuthoritativeClass,
    computedOnlyCounterfactualClass: aggregateCounterfactual,
    mismatch: aggregateCanonical.mismatch || aggregateCanonical.canonicalAuthoritativeClass !== aggregateCounterfactual,
    mismatchReason: aggregateCanonical.mismatch
      ? aggregateCanonical.mismatchReason
      : aggregateCanonical.canonicalAuthoritativeClass === aggregateCounterfactual
        ? 'none'
        : 'canonical_authoritative_uses_policy_bound;counterfactual_uses_computed_bound_only',
    rows,
  };

  fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
  fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);

  const table = rows
    .map(
      (r) =>
        `| ${r.wave} | ${fmt(r.lhs_Jm3)} | ${fmt(r.boundComputed_Jm3)} | ${fmt(r.boundUsed_Jm3)} | ${r.boundFloorApplied ?? 'n/a'} | ${fmt(r.marginRatioRaw)} | ${fmt(r.marginRatioRawComputed)} | ${r.applicabilityStatus} | ${r.canonicalAuthoritativeClass} | ${r.computedOnlyCounterfactualClass} | ${r.mismatch} | ${r.mismatchReason} |`,
    )
    .join('\n');

  const md = `# G4 Governance Matrix (${DATE})\n\n## Boundary statement\n${BOUNDARY_STATEMENT}\n\n## Summary\n- canonical authoritative class: ${payload.canonicalAuthoritativeClass}\n- computed-only counterfactual class: ${payload.computedOnlyCounterfactualClass}\n- mismatch: ${payload.mismatch}\n- mismatch reason: ${payload.mismatchReason}\n\n## Per-wave matrix\n| Wave | lhs_Jm3 | boundComputed_Jm3 | boundUsed_Jm3 | floorApplied | marginRaw | marginRawComputed | applicability | canonical authoritative class | computed-only counterfactual class (non-authoritative) | mismatch | mismatch explanation |\n| --- | ---: | ---: | ---: | --- | ---: | ---: | --- | --- | --- | --- | --- |\n${table}\n`;

  fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
  fs.writeFileSync(outMdPath, md);

  const result = { ok: true, json: outJsonPath, markdown: outMdPath, payload };
  console.log(JSON.stringify({ ok: true, json: outJsonPath, markdown: outMdPath }));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateG4GovernanceMatrix();
}
