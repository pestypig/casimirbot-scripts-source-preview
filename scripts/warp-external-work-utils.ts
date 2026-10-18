import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

export const EXTERNAL_WORK_SCHEMA = 'external_work_profile/v1';

export const DEFAULT_PROFILE_PATH = path.join('configs', 'warp-external-work-profiles.v1.json');
export const DEFAULT_REGISTRY_PATH = path.join(
  'docs',
  'specs',
  'casimir-tile-experimental-parameter-registry-2026-03-04.md',
);
export const DEFAULT_CHAIN_CONTRACT_PATH = path.join(
  'docs',
  'specs',
  'casimir-tile-equation-provenance-contract-v1.md',
);
export const DEFAULT_CITATION_PACK_PATH = path.join(
  'docs',
  'audits',
  'research',
  'warp-primary-standards-citation-pack-2026-03-04.md',
);
export const DEFAULT_REFERENCE_CAPSULE_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  'full-solve-reference-capsule-latest.json',
);
export const DEFAULT_EXTERNAL_WORK_DIR = path.join('artifacts', 'research', 'full-solve', 'external-work');
export const DEFAULT_EXTERNAL_WORK_DOC_DIR = path.join('docs', 'audits', 'research');

export const ALLOWED_MIRROR_LANES = ['casimir_sign_control', 'q_spoiling', 'nanogap', 'timing', 'sem_ellipsometry'];
export const ALLOWED_SOURCE_CLASSES = ['primary', 'standard', 'preprint', 'secondary'];
export const ALLOWED_CONFIDENCE_TIERS = ['high', 'medium', 'low'];

export type ComparisonMode = 'delta' | 'equals';

export type ComparisonKey = {
  id: string;
  local_reference_path: string;
  external_path: string;
  mode: ComparisonMode;
  tolerance?: number;
};

export type MirrorTrackProfile = {
  enabled: boolean;
  lane?: string;
  scenario_pack?: string;
  checker_script?: string;
  required_anchors?: string[];
  reason?: string;
};

export type MethodTrackProfile = {
  enabled: boolean;
  script?: string;
  args?: Record<string, string>;
  input_snapshots?: string[];
  expected_output_keys?: string[];
  reason?: string;
};

export type ExternalWorkProfile = {
  work_id: string;
  title: string;
  source_refs: string[];
  chain_ids: string[];
  commit_pin: string;
  track_mirror: MirrorTrackProfile;
  track_method: MethodTrackProfile;
  comparison_keys: ComparisonKey[];
  posture: {
    reference_only: boolean;
    canonical_blocking: boolean;
  };
};

export type ExternalWorkProfileConfig = {
  schema_version: string;
  boundary_statement: string;
  defaults?: Record<string, unknown>;
  profiles: ExternalWorkProfile[];
};

export type CitationSourceMeta = {
  source_id: string;
  source_class: string | null;
  confidence_tier: string | null;
};

export const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

export const hasFlag = (flag: string, argv = process.argv.slice(2)): boolean => argv.includes(flag);

export const asText = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
};

export const asNumber = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export const normalizePath = (filePath: string) => filePath.replace(/\\/g, '/');

export const resolvePathFromRoot = (filePath: string, cwd = process.cwd()): string =>
  path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);

export const ensureDirForFile = (filePath: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

export const readJson = (filePath: string): any => JSON.parse(fs.readFileSync(filePath, 'utf8'));

export const readJsonSafe = (filePath: string | null): any | null => {
  if (!filePath) return null;
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
};

export const readTextSafe = (filePath: string | null): string | null => {
  if (!filePath) return null;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
};

export const listFiles = (dirPath: string): string[] => {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
};

export const findLatestByRegex = (dirPath: string, regex: RegExp): string | null => {
  const candidates = listFiles(dirPath).filter((entry) => regex.test(entry));
  if (candidates.length === 0) return null;
  const ranked = candidates
    .map((entry) => {
      const fullPath = path.join(dirPath, entry);
      const stat = fs.statSync(fullPath);
      return {
        fullPath,
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return ranked[0]?.fullPath ?? null;
};

export const objectWithSortedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => objectWithSortedKeys(entry));
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = objectWithSortedKeys(source[key]);
    }
    return out;
  }
  return value;
};

export const checksumPayload = (payload: Record<string, unknown>, skipKeys: string[] = []): string => {
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(payload));
  for (const key of ['generated_at', 'generated_on', 'checksum', ...skipKeys]) {
    delete copy[key];
  }
  const canonical = JSON.stringify(objectWithSortedKeys(copy));
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

export const dottedGet = (payload: unknown, dottedPath: string): unknown => {
  const tokens = dottedPath.split('.').map((token) => token.trim()).filter(Boolean);
  let cursor: any = payload;
  for (const token of tokens) {
    if (cursor == null) return undefined;
    if (Array.isArray(cursor) && /^\d+$/.test(token)) {
      cursor = cursor[Number(token)];
      continue;
    }
    cursor = cursor[token];
  }
  return cursor;
};

export const parseRegistryRows = (markdown: string): Array<{ entry_id: string; source_class: string; status: string }> => {
  const rows: Array<{ entry_id: string; source_class: string; status: string }> = [];
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
      status: cells[12] ?? cells[11],
    });
  }
  return rows;
};

export const parseChainIds = (markdown: string): Set<string> => {
  const chainIds = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('| CH-')) continue;
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 2) continue;
    chainIds.add(cells[0].toUpperCase());
  }
  return chainIds;
};

export const parseCitationSourceMeta = (markdown: string): Map<string, CitationSourceMeta> => {
  const sourceMeta = new Map<string, CitationSourceMeta>();
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('| SRC-')) continue;
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 8) continue;
    const source_id = cells[0].toUpperCase();
    sourceMeta.set(source_id, {
      source_id,
      source_class: cells[6] || null,
      confidence_tier: cells[7] || null,
    });
  }
  return sourceMeta;
};

export const rankConfidence = (tier: string | null): number => {
  switch ((tier ?? '').toLowerCase()) {
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
    default:
      return 0;
  }
};

export const conservativeConfidenceTier = (tiers: Array<string | null>): string => {
  if (tiers.length === 0) return 'low';
  const ranked = tiers.map((tier) => ({ tier: (tier ?? 'low').toLowerCase(), rank: rankConfidence(tier) }));
  ranked.sort((a, b) => a.rank - b.rank);
  const selected = ranked[0]?.tier ?? 'low';
  return ALLOWED_CONFIDENCE_TIERS.includes(selected) ? selected : 'low';
};

export const consolidatedSourceClass = (classes: Array<string | null>): string => {
  const filtered = classes
    .map((value) => (value ?? '').toLowerCase())
    .filter((value) => ALLOWED_SOURCE_CLASSES.includes(value));
  if (filtered.length === 0) return 'secondary';
  const unique = [...new Set(filtered)];
  return unique.length === 1 ? unique[0] : 'mixed';
};

export const stableStringify = (value: unknown): string => JSON.stringify(objectWithSortedKeys(value));
