import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = '2026-02-24';
const DEFAULT_OUT_DIR = `artifacts/research/full-solve/publication-bundle-${DATE_STAMP}`;
const WAVE_REQUIRED_RUNS: Record<'A' | 'B' | 'C' | 'D', number[]> = {
  A: [1],
  B: [1],
  C: [1, 2],
  D: [1, 2],
};

type ManifestEntry = { path: string; sha256: string; bytes: number };

const sortDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((k) => [k, sortDeep((value as Record<string, unknown>)[k])]));
};

const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(sortDeep(value), null, 2)}\n`);
};

const sha256File = (filePath: string) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const copyIfExists = (source: string, destination: string): boolean => {
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return true;
};

const collectFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (base: string) => {
    for (const name of fs.readdirSync(base).sort()) {
      const full = path.join(base, name);
      const rel = path.relative(dir, full);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else out.push(rel.replace(/\\/g, '/'));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
};

export const buildPublicationBundle = (outDir = DEFAULT_OUT_DIR) => {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const commitSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  const nodeVersion = execSync('node -v', { encoding: 'utf8' }).trim();
  const npmVersion = execSync('npm --version', { encoding: 'utf8' }).trim();
  const lockHash = sha256File('package-lock.json');

  const requiredCopies: Array<[string, string]> = [
    ['docs/audits/research/warp-full-solve-campaign-execution-report-2026-02-24.md', 'reports/campaign-execution-report.md'],
    ['docs/audits/research/warp-gates-executive-translation-2026-02-24.md', 'reports/gates-executive-translation.md'],
    ['artifacts/research/full-solve/campaign-gate-scoreboard-2026-02-24.json', 'reports/campaign-gate-scoreboard.json'],
    ['artifacts/research/full-solve/campaign-first-fail-map-2026-02-24.json', 'reports/campaign-first-fail-map.json'],
    ['artifacts/research/full-solve/campaign-action-plan-30-60-90-2026-02-24.json', 'reports/campaign-action-plan-30-60-90.json'],
  ];

  for (const wave of ['A', 'B', 'C', 'D'] as const) {
    requiredCopies.push([`artifacts/research/full-solve/${wave}/evidence-pack.json`, `waves/${wave}/evidence-pack.json`]);
    requiredCopies.push([`artifacts/research/full-solve/${wave}/first-fail-map.json`, `waves/${wave}/first-fail-map.json`]);
    for (const runIndex of WAVE_REQUIRED_RUNS[wave]) {
      requiredCopies.push([`artifacts/research/full-solve/${wave}/run-${runIndex}-raw-output.json`, `waves/${wave}/run-${runIndex}-raw-output.json`]);
    }
  }

  const copied: string[] = [];
  const missing: string[] = [];
  for (const [src, destRel] of requiredCopies) {
    const dest = path.join(outDir, destRel);
    if (copyIfExists(src, dest)) copied.push(destRel);
    else missing.push(src);
  }

  const proofPackRefs = [
    'artifacts/proof-pack.json',
    'artifacts/proof-pack-export.json',
  ];
  for (const src of proofPackRefs) {
    const rel = `proof-pack/${path.basename(src)}`;
    if (copyIfExists(src, path.join(outDir, rel))) copied.push(rel);
  }

  writeJson(path.join(outDir, 'environment-manifest.json'), {
    commitSha,
    nodeVersion,
    npmVersion,
    lockHash,
    keyFlags: {
      ENABLE_AGI_AUTH: process.env.ENABLE_AGI_AUTH ?? '0',
      AGI_TENANT_REQUIRED: process.env.AGI_TENANT_REQUIRED ?? '0',
      NODE_ENV: process.env.NODE_ENV ?? 'unset',
    },
    boundaryStatement:
      'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.',
  });

  const files = collectFiles(outDir).filter((f) => f !== 'checksum-manifest.json');
  const checksumManifest: ManifestEntry[] = files.map((rel) => {
    const full = path.join(outDir, rel);
    return { path: rel, sha256: sha256File(full), bytes: fs.statSync(full).size };
  });

  writeJson(path.join(outDir, 'checksum-manifest.json'), {
    bundleDate: DATE_STAMP,
    files: checksumManifest,
    missing,
  });

  if (missing.length > 0) {
    const error = new Error(`Publication bundle missing required files (${missing.length}): ${missing.join(', ')}`);
    (error as Error & { missingRequiredFiles?: string[] }).missingRequiredFiles = missing;
    throw error;
  }

  return {
    ok: true,
    outDir,
    checksumManifest: path.join(outDir, 'checksum-manifest.json'),
    copiedCount: copied.length,
    missingCount: missing.length,
  };
};

const isMainModule = () => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
};

if (isMainModule()) {
  console.log(JSON.stringify(buildPublicationBundle(process.argv[2] || DEFAULT_OUT_DIR), null, 2));
}
