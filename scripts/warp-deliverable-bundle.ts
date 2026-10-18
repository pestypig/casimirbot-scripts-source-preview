import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const GENERATOR_VERSION = '1.0.0';
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const FULL_SOLVE_DIR = path.join('artifacts', 'research', 'full-solve');
const DOC_AUDIT_DIR = path.join('docs', 'audits', 'research');

const DEFAULT_DOSSIER_JSON = path.join(FULL_SOLVE_DIR, 'warp-deliverable-dossier-latest.json');
const DEFAULT_DOSSIER_MD = path.join(DOC_AUDIT_DIR, 'warp-deliverable-dossier-latest.md');
const DEFAULT_OUT_DIR = path.join(FULL_SOLVE_DIR, `warp-deliverable-bundle-${DATE_STAMP}`);
const DEFAULT_OUT_JSON = path.join(FULL_SOLVE_DIR, `warp-deliverable-bundle-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join(DOC_AUDIT_DIR, `warp-deliverable-bundle-${DATE_STAMP}.md`);
const DEFAULT_LATEST_JSON = path.join(FULL_SOLVE_DIR, 'warp-deliverable-bundle-latest.json');
const DEFAULT_LATEST_MD = path.join(DOC_AUDIT_DIR, 'warp-deliverable-bundle-latest.md');

const DOSSIER_CONTRACT_PATH = path.join('docs', 'specs', 'warp-deliverable-dossier-contract-v1.md');
const BUNDLE_CONTRACT_PATH = path.join('docs', 'specs', 'warp-deliverable-bundle-contract-v1.md');

type BundleFileEntry = {
  source_path: string;
  bundle_path: string;
  bytes: number;
  sha256: string;
  discovered_from: string[];
};

type MissingFileEntry = {
  source_path: string;
  reason: 'missing_on_disk' | 'not_a_file' | 'json_parse_error';
  detail: string;
  discovered_from: string[];
};

const hasFlag = (name: string, argv = process.argv.slice(2)): boolean => argv.includes(name);

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const normalizePath = (value: string): string => value.replace(/\\/g, '/');

const resolvePathFromRoot = (filePath: string, cwd = process.cwd()): string =>
  path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);

const ensureDirForFile = (filePath: string) => fs.mkdirSync(path.dirname(filePath), { recursive: true });

const asText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const readJson = (filePath: string): any => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const sortDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => sortDeep(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, sortDeep((value as Record<string, unknown>)[key])]),
  );
};

const checksumPayload = (payload: Record<string, unknown>): string => {
  const stripVolatile = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((entry) => stripVolatile(entry));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'generated_at' || key === 'checksum' || key === 'normalized_checksum') continue;
        out[key] = stripVolatile(inner);
      }
      return out;
    }
    return value;
  };
  const canonical = JSON.stringify(sortDeep(stripVolatile(JSON.parse(JSON.stringify(payload)))));
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

const sha256File = (filePath: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const isLikelyLocalRepoPath = (candidate: string): boolean => {
  const normalized = normalizePath(candidate.trim());
  if (!normalized) return false;
  if (/^[a-zA-Z]+:\/\//.test(normalized) || /^doi:/i.test(normalized)) return false;
  if (/^[A-Za-z]:\//.test(normalized)) return false;
  if (normalized.startsWith('/') || normalized.startsWith('../')) return false;
  const unprefixed = normalized.startsWith('./') ? normalized.slice(2) : normalized;
  if (!/^(artifacts|docs|configs|scripts|tests|client|server|reports)\//.test(unprefixed)) return false;
  return path.extname(unprefixed).length > 0;
};

const maybeLatestDatedVariant = (latestPath: string): string | null => {
  const normalized = normalizePath(latestPath);
  if (!normalized.includes('-latest.')) return null;

  const ext = path.extname(normalized);
  const suffix = `-latest${ext}`;
  if (!normalized.endsWith(suffix)) return null;

  const dir = path.dirname(normalized);
  const base = path.basename(normalized, suffix);
  const absDir = resolvePathFromRoot(dir);
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) return null;

  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escapedBase}-\\d{4}-\\d{2}-\\d{2}\\${ext.replace('.', '\\.')}$`);
  const candidates = fs
    .readdirSync(absDir)
    .filter((name) => regex.test(name))
    .sort();

  if (candidates.length === 0) return null;
  return normalizePath(path.join(dir, candidates[candidates.length - 1]));
};

const inferAuditMarkdownPath = (jsonPath: string): string => {
  const base = path.basename(jsonPath, '.json');
  const prefixed = base.startsWith('warp-') ? base : `warp-${base}`;
  return normalizePath(path.join(DOC_AUDIT_DIR, `${prefixed}.md`));
};

const collectLocalPaths = (value: unknown, addPath: (candidate: string) => void) => {
  if (Array.isArray(value)) {
    for (const entry of value) collectLocalPaths(entry, addPath);
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [_, inner] of Object.entries(value as Record<string, unknown>)) {
    if (typeof inner === 'string') {
      if (isLikelyLocalRepoPath(inner)) addPath(inner);
      continue;
    }
    collectLocalPaths(inner, addPath);
  }
};

const renderManifestMarkdown = (manifest: Record<string, unknown>): string => {
  const copiedFiles = Array.isArray(manifest.copied_files) ? manifest.copied_files : [];
  const missingFiles = Array.isArray(manifest.missing_files) ? manifest.missing_files : [];
  const copiedRows =
    copiedFiles.length > 0
      ? copiedFiles
          .map((entry: any) => `| ${entry.source_path} | ${entry.bundle_path} | ${entry.bytes} | ${entry.sha256} |`)
          .join('\n')
      : '| none | n/a | 0 | n/a |';
  const missingRows =
    missingFiles.length > 0
      ? missingFiles
          .map((entry: any) => `| ${entry.source_path} | ${entry.reason} | ${entry.detail} |`)
          .join('\n')
      : '| none | n/a | none |';

  return `# Warp Deliverable Bundle Manifest (${manifest.generated_on})

"${manifest.boundary_statement}"

## Result
- artifact_type: \`${manifest.artifact_type}\`
- commit_pin: \`${manifest.commit_pin}\`
- source_dossier_path: \`${manifest.source_dossier_path}\`
- copied_count: \`${manifest.copied_count}\`
- missing_count: \`${manifest.missing_count}\`
- normalized_checksum: \`${manifest.normalized_checksum}\`
- checksum: \`${manifest.checksum}\`

## Copied Files
| source_path | bundle_path | bytes | sha256 |
|---|---|---:|---|
${copiedRows}

## Missing Files
| source_path | reason | detail |
|---|---|---|
${missingRows}
`;
};

const renderSummaryMarkdown = (summary: Record<string, unknown>): string => {
  const missingSample = Array.isArray(summary.missing_sample) ? summary.missing_sample : [];
  const missingRows =
    missingSample.length > 0
      ? missingSample.map((entry: any) => `| ${entry.source_path} | ${entry.reason} | ${entry.detail} |`).join('\n')
      : '| none | n/a | none |';

  return `# Warp Deliverable Bundle Summary (${summary.generated_on})

"${summary.boundary_statement}"

## Result
- artifact_type: \`${summary.artifact_type}\`
- status: \`${summary.status}\`
- commit_pin: \`${summary.commit_pin}\`
- bundle_dir: \`${summary.bundle_dir}\`
- manifest_path: \`${summary.manifest_path}\`
- copied_count: \`${summary.copied_count}\`
- missing_count: \`${summary.missing_count}\`
- normalized_checksum: \`${summary.normalized_checksum}\`
- checksum: \`${summary.checksum}\`

## Missing Sample
| source_path | reason | detail |
|---|---|---|
${missingRows}
`;
};

const getCommitPin = (): string => execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();

export const buildWarpDeliverableBundle = (options?: {
  dossierPath?: string;
  dossierMdPath?: string;
  outDir?: string;
  outJsonPath?: string;
  outMdPath?: string;
  latestJsonPath?: string;
  latestMdPath?: string;
  maxDepth?: number;
  strictMissing?: boolean;
}) => {
  const dossierPath = normalizePath(options?.dossierPath ?? DEFAULT_DOSSIER_JSON);
  const dossierMdPath = normalizePath(options?.dossierMdPath ?? DEFAULT_DOSSIER_MD);
  const outDir = normalizePath(options?.outDir ?? DEFAULT_OUT_DIR);
  const outJsonPath = normalizePath(options?.outJsonPath ?? DEFAULT_OUT_JSON);
  const outMdPath = normalizePath(options?.outMdPath ?? DEFAULT_OUT_MD);
  const latestJsonPath = normalizePath(options?.latestJsonPath ?? DEFAULT_LATEST_JSON);
  const latestMdPath = normalizePath(options?.latestMdPath ?? DEFAULT_LATEST_MD);
  const maxDepth = Number.isFinite(options?.maxDepth) ? Number(options?.maxDepth) : 3;
  const strictMissing = options?.strictMissing === true;

  const dossierAbsPath = resolvePathFromRoot(dossierPath);
  if (!fs.existsSync(dossierAbsPath)) {
    throw new Error(`Dossier file not found: ${dossierPath}`);
  }

  const dossier = readJson(dossierAbsPath);
  const discovered = new Map<string, Set<string>>();
  const enqueue: Array<{ path: string; depth: number }> = [];
  const queuedJson = new Set<string>();

  const addPath = (candidate: string, discoveredFrom: string, depthForQueue?: number) => {
    const normalized = normalizePath(candidate.startsWith('./') ? candidate.slice(2) : candidate);
    if (!isLikelyLocalRepoPath(normalized)) return;
    if (!discovered.has(normalized)) discovered.set(normalized, new Set<string>());
    discovered.get(normalized)!.add(discoveredFrom);

    if (normalized.endsWith('.json') && Number.isInteger(depthForQueue) && !queuedJson.has(normalized)) {
      queuedJson.add(normalized);
      enqueue.push({ path: normalized, depth: depthForQueue as number });
    }
  };

  const addCompanions = (jsonPath: string, origin: string) => {
    if (!jsonPath.endsWith('.json')) return;
    const mdCandidate = inferAuditMarkdownPath(jsonPath);
    if (fs.existsSync(resolvePathFromRoot(mdCandidate))) addPath(mdCandidate, origin);

    const datedJson = maybeLatestDatedVariant(jsonPath);
    if (datedJson) addPath(datedJson, origin);

    if (mdCandidate.includes('-latest.')) {
      const datedMd = maybeLatestDatedVariant(mdCandidate);
      if (datedMd && fs.existsSync(resolvePathFromRoot(datedMd))) addPath(datedMd, origin);
    }
  };

  addPath(dossierPath, 'seed:dossier_json', 0);
  addPath(dossierMdPath, 'seed:dossier_md');
  addPath(DOSSIER_CONTRACT_PATH, 'seed:dossier_contract');
  addPath(BUNDLE_CONTRACT_PATH, 'seed:bundle_contract');
  const datedDossierJson = maybeLatestDatedVariant(dossierPath);
  if (datedDossierJson) addPath(datedDossierJson, 'seed:dossier_json');
  const datedDossierMd = maybeLatestDatedVariant(dossierMdPath);
  if (datedDossierMd) addPath(datedDossierMd, 'seed:dossier_md');

  collectLocalPaths(dossier, (candidate) => addPath(candidate, 'seed:dossier_payload', 1));

  const jsonParseErrors: MissingFileEntry[] = [];
  const visitedJson = new Set<string>();
  while (enqueue.length > 0) {
    const current = enqueue.shift()!;
    if (visitedJson.has(current.path)) continue;
    visitedJson.add(current.path);

    const absolute = resolvePathFromRoot(current.path);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    if (current.depth > maxDepth) continue;

    addCompanions(current.path, `json:${current.path}`);
    if (current.depth === maxDepth) continue;

    let parsed: unknown;
    try {
      parsed = readJson(absolute);
    } catch (error) {
      jsonParseErrors.push({
        source_path: current.path,
        reason: 'json_parse_error',
        detail: error instanceof Error ? error.message : String(error),
        discovered_from: [`json:${current.path}`],
      });
      continue;
    }

    collectLocalPaths(parsed, (candidate) => addPath(candidate, `json:${current.path}`, current.depth + 1));
  }

  fs.rmSync(resolvePathFromRoot(outDir), { recursive: true, force: true });
  fs.mkdirSync(resolvePathFromRoot(outDir), { recursive: true });

  const copiedFiles: BundleFileEntry[] = [];
  const missingFiles: MissingFileEntry[] = [];
  for (const sourcePath of [...discovered.keys()].sort()) {
    const absolute = resolvePathFromRoot(sourcePath);
    const discoveredFrom = [...(discovered.get(sourcePath) ?? new Set<string>())].sort();
    if (!fs.existsSync(absolute)) {
      missingFiles.push({
        source_path: sourcePath,
        reason: 'missing_on_disk',
        detail: 'file not found at source path',
        discovered_from: discoveredFrom,
      });
      continue;
    }
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) {
      missingFiles.push({
        source_path: sourcePath,
        reason: 'not_a_file',
        detail: 'source path exists but is not a regular file',
        discovered_from: discoveredFrom,
      });
      continue;
    }

    const bundlePath = normalizePath(path.join('payload', sourcePath));
    const destination = resolvePathFromRoot(path.join(outDir, bundlePath));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(absolute, destination);

    copiedFiles.push({
      source_path: sourcePath,
      bundle_path: bundlePath,
      bytes: stat.size,
      sha256: sha256File(destination),
      discovered_from: discoveredFrom,
    });
  }

  missingFiles.push(...jsonParseErrors);
  copiedFiles.sort((a, b) => a.source_path.localeCompare(b.source_path));
  missingFiles.sort((a, b) => a.source_path.localeCompare(b.source_path));

  const commitPin = getCommitPin();
  const manifestBase: Record<string, unknown> = {
    artifact_type: 'warp_deliverable_bundle/v1',
    generator_version: GENERATOR_VERSION,
    generated_on: DATE_STAMP,
    generated_at: new Date().toISOString(),
    commit_pin: commitPin,
    boundary_statement: BOUNDARY_STATEMENT,
    source_dossier_path: dossierPath,
    max_depth: maxDepth,
    copied_count: copiedFiles.length,
    missing_count: missingFiles.length,
    copied_files: copiedFiles,
    missing_files: missingFiles,
  };
  const manifestNormalizedChecksum = checksumPayload(manifestBase);
  const manifestPayload = {
    ...manifestBase,
    normalized_checksum: manifestNormalizedChecksum,
  } as Record<string, unknown>;
  manifestPayload.checksum = checksumPayload(manifestPayload);

  const manifestJsonPath = normalizePath(path.join(outDir, 'manifest.json'));
  const manifestMdPath = normalizePath(path.join(outDir, 'manifest.md'));
  ensureDirForFile(manifestJsonPath);
  ensureDirForFile(manifestMdPath);
  fs.writeFileSync(manifestJsonPath, `${JSON.stringify(sortDeep(manifestPayload), null, 2)}\n`);
  fs.writeFileSync(manifestMdPath, `${renderManifestMarkdown(manifestPayload)}\n`);

  const status = missingFiles.length === 0 ? 'PASS' : 'PARTIAL';
  const summaryBase: Record<string, unknown> = {
    artifact_type: 'warp_deliverable_bundle_summary/v1',
    generator_version: GENERATOR_VERSION,
    generated_on: DATE_STAMP,
    generated_at: new Date().toISOString(),
    commit_pin: commitPin,
    boundary_statement: BOUNDARY_STATEMENT,
    source_dossier_path: dossierPath,
    status,
    bundle_dir: outDir,
    manifest_path: manifestJsonPath,
    copied_count: copiedFiles.length,
    missing_count: missingFiles.length,
    missing_sample: missingFiles.slice(0, 20),
    manifest_checksum: manifestPayload.checksum,
  };
  const summaryNormalizedChecksum = checksumPayload(summaryBase);
  const summaryPayload = {
    ...summaryBase,
    normalized_checksum: summaryNormalizedChecksum,
  } as Record<string, unknown>;
  summaryPayload.checksum = checksumPayload(summaryPayload);

  const summaryMarkdown = renderSummaryMarkdown(summaryPayload);
  ensureDirForFile(outJsonPath);
  ensureDirForFile(outMdPath);
  ensureDirForFile(latestJsonPath);
  ensureDirForFile(latestMdPath);

  fs.writeFileSync(outJsonPath, `${JSON.stringify(sortDeep(summaryPayload), null, 2)}\n`);
  fs.writeFileSync(outMdPath, `${summaryMarkdown}\n`);
  fs.writeFileSync(latestJsonPath, `${JSON.stringify(sortDeep(summaryPayload), null, 2)}\n`);
  fs.writeFileSync(latestMdPath, `${summaryMarkdown}\n`);

  const ok = !(strictMissing && missingFiles.length > 0);
  return {
    ok,
    status,
    outDir,
    manifestJsonPath,
    manifestMdPath,
    outJsonPath,
    outMdPath,
    latestJsonPath,
    latestMdPath,
    copiedCount: copiedFiles.length,
    missingCount: missingFiles.length,
    checksum: summaryPayload.checksum,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = buildWarpDeliverableBundle({
      dossierPath: readArgValue('--dossier'),
      dossierMdPath: readArgValue('--dossier-md'),
      outDir: readArgValue('--out-dir'),
      outJsonPath: readArgValue('--out-json'),
      outMdPath: readArgValue('--out-md'),
      latestJsonPath: readArgValue('--latest-json'),
      latestMdPath: readArgValue('--latest-md'),
      maxDepth: Number(readArgValue('--max-depth') ?? 3),
      strictMissing: hasFlag('--strict-missing'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exit(1);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
