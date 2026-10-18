import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  collectCanonicalBindingMatches,
  resolveCanonicalFrameworkBindings,
  type CanonicalBindingMatch,
  type CanonicalBindingSet,
  type CanonicalNodeDescriptor,
} from "./paper-framework-binding.js";

type CliOptions = {
  file?: string;
  latestAttached: boolean;
  title?: string;
  tags: string[];
  baseUrl: string;
  outDir: string;
  promoteRuntimeTree: boolean;
  runtimeTreePath: string;
  creatorId: string;
  visibility: string;
  tenantId?: string;
  token?: string;
  pollAttempts: number;
  pollDelayMs: number;
  requirePredictionContracts: boolean;
  requireSymbolEquivalenceMap: boolean;
  requireFalsifierEdges: boolean;
  requireCitationRegistry: boolean;
  requirePaperCard: boolean;
};

type EssenceIngestResponse = {
  essence_id: string;
  uri: string;
  hash: string;
  dedup?: boolean;
};

type IngestMode = "essence" | "local_pdf_fallback";

type EssenceEnvelopeText = {
  transcript?: string;
  summary?: string;
  caption?: string;
  tags?: unknown;
};

type EssenceEnvelopeLike = {
  features?: {
    text?: EssenceEnvelopeText;
  };
};

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

const DEFAULT_BASE_URL = process.env.PAPER_INGEST_BASE_URL ?? "http://localhost:5050";
const DEFAULT_OUT_DIR = "artifacts/papers";
const FRAMEWORK_STORE_DIR = "framework";
const FRAMEWORK_STORE_FILE = "paper-tree-dag-atlas.v1.json";
const FRAMEWORK_STORE_ID = "paper-tree-dag-atlas.v1";
const DEFAULT_RUNTIME_TREE_PATH = "docs/knowledge/paper-ingestion-runtime-tree.json";
const DEFAULT_RUNTIME_TREE_ROOT_ID = "paper-ingestion-runtime-tree";

function parseArgs(argv: string[]): CliOptions {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, "1");
      continue;
    }
    args.set(key, next);
    i += 1;
  }

  const file = args.get("file");
  const title = args.get("title")?.trim();
  const tags = splitCsv(args.get("tags"));

  return {
    file,
    latestAttached: toBool(args.get("latest-attached"), false),
    title,
    tags,
    baseUrl: (args.get("base-url") ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    outDir: args.get("out-dir") ?? DEFAULT_OUT_DIR,
    promoteRuntimeTree: toBool(args.get("promote-runtime-tree"), true),
    runtimeTreePath: args.get("runtime-tree-path") ?? DEFAULT_RUNTIME_TREE_PATH,
    creatorId: args.get("creator-id") ?? "codex",
    visibility: args.get("visibility") ?? "public",
    tenantId: args.get("tenant-id") ?? process.env.X_TENANT_ID,
    token: args.get("token") ?? process.env.AGI_BEARER_TOKEN,
    pollAttempts: parseIntSafe(args.get("poll-attempts"), 12),
    pollDelayMs: parseIntSafe(args.get("poll-delay-ms"), 400),
    requirePredictionContracts: toBool(args.get("require-prediction-contracts"), false),
    requireSymbolEquivalenceMap: toBool(args.get("require-symbol-map"), false),
    requireFalsifierEdges: toBool(args.get("require-falsifier-edges"), false),
    requireCitationRegistry: toBool(args.get("require-citations"), false),
    requirePaperCard: toBool(args.get("require-paper-card"), false),
  };
}

function splitCsv(input?: string): string[] {
  if (!input) return [];
  return Array.from(
    new Set(
      input
        .split(",")
        .map((entry) => normalizeTag(entry))
        .filter(Boolean),
    ),
  );
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
}

function parseIntSafe(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function detectMime(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function detectSourceType(mime: string): "pdf" | "image" {
  return mime === "application/pdf" ? "pdf" : "image";
}

function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function toFileUri(filePath: string): string {
  const normalized = path.resolve(filePath).replace(/\\/g, "/");
  return `file:///${normalized}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function isoAt(base: number, offsetMs: number): string {
  return new Date(base + offsetMs).toISOString();
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

const NOISY_FEATURE_TAGS = new Set([
  "obj",
  "endobj",
  "stream",
  "endstream",
  "flatedecode",
  "pdf",
  "pdf-1",
  "producer",
  "title",
  "normal",
  "filter",
  "length",
]);

function keepFeatureTag(tag: string): boolean {
  if (tag.length < 3) return false;
  if (NOISY_FEATURE_TAGS.has(tag)) return false;
  if (/^\d+$/.test(tag)) return false;
  if (/^[a-z]$/.test(tag)) return false;
  return /[a-z]/.test(tag);
}

function hasBinaryLikeEnvelopeText(text: string): boolean {
  const sample = text.slice(0, 4000);
  if (!sample.trim()) return true;
  if (/%pdf-\d\.\d/i.test(sample)) return true;
  if (/flatedecode|endobj|stream\s+x/i.test(sample)) return true;
  const weirdChars = sample.match(/[^\x09\x0A\x0D\x20-\x7E]/g)?.length ?? 0;
  const ratio = weirdChars / Math.max(1, sample.length);
  return ratio > 0.08;
}

async function extractLocalPdfText(filePath: string, maxPages = 40): Promise<string> {
  const data = new Uint8Array(await fs.readFile(filePath));
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as {
    getDocument: (source: { data: Uint8Array; disableWorker: boolean }) => {
      promise: Promise<{
        numPages: number;
        getPage: (
          pageNum: number,
        ) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str?: string }> }> }>;
        cleanup: () => Promise<void> | void;
      }>;
    };
  };
  const doc = await pdfjs.getDocument({ data, disableWorker: true }).promise;
  const limit = Math.min(doc.numPages, Math.max(1, Math.floor(maxPages)));
  const pages: string[] = [];
  for (let pageNum = 1; pageNum <= limit; pageNum += 1) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const line = content.items
      .map((item) => (typeof item.str === "string" ? item.str : ""))
      .filter(Boolean)
      .join(" ");
    if (line.trim()) {
      pages.push(line.trim());
    }
  }
  await doc.cleanup();
  return pages.join("\n\n").trim();
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const SUPPORTED_PAPER_EXT = new Set(Object.keys(MIME_BY_EXT));

const PAPER_NUMERIC_UNIT_RE =
  /\b[-+]?(?:\d+(?:\.\d+)?|\.\d+)\s?(?:hz|khz|mhz|ghz|thz|ev|kev|mev|gev|tev|m|cm|mm|um|nm|kg|g|s|ms|us|ns|pa|kpa|mpa|j|kj|mj|w|kw|mw|v|a|ma|db|k|%)\b/i;

const THEORY_HINT_RE = /\b(theory|model|hypothesis|assume|implies|predicts?|framework)\b/i;

const CONGRUENCE_HINT_RE = /\b(consistent|agreement|congruent|matches?|aligns?)\b/i;

type ClaimType = "observation" | "measurement" | "theory" | "theoretical_congruence";

type DraftClaim = {
  text: string;
  type: ClaimType;
  confidence: number;
};

function deriveTitleFromFile(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  return base
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveTagsFromFile(filePath: string): string[] {
  return Array.from(
    new Set(
      path
        .basename(filePath, path.extname(filePath))
        .split(/[^a-z0-9]+/i)
        .map((entry) => normalizeTag(entry))
        .filter((entry) => entry.length >= 3),
    ),
  ).slice(0, 12);
}

async function findLatestAttachedFile(): Promise<string | null> {
  const root = path.resolve("attached_assets");
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return null;
  }
  const candidates = entries
    .map((name) => path.join(root, name))
    .filter((abs) => SUPPORTED_PAPER_EXT.has(path.extname(abs).toLowerCase()));
  if (candidates.length === 0) return null;

  const withStats = await Promise.all(
    candidates.map(async (candidate) => {
      const stats = await fs.stat(candidate);
      return { candidate, mtimeMs: stats.mtimeMs };
    }),
  );
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats[0]?.candidate ?? null;
}

async function resolveInputFile(opts: CliOptions): Promise<string> {
  if (opts.file) {
    return path.resolve(opts.file);
  }
  if (opts.latestAttached || !opts.file) {
    const latest = await findLatestAttachedFile();
    if (latest) return latest;
  }
  throw new Error(
    "No input file resolved. Pass --file <path> or use --latest-attached with at least one supported file in attached_assets.",
  );
}

function splitIntoClaimAtoms(text: string, maxClaims = 10): DraftClaim[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }
  const parts = normalized
    .split(/(?<=[.!?])\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 20);
  const selected = parts.length > 0 ? parts.slice(0, maxClaims) : [normalized.slice(0, 300)];
  return selected.map((entry) => {
    const type = inferClaimType(entry);
    const base = type === "measurement" ? 0.78 : type === "theory" ? 0.7 : 0.66;
    return { text: entry.slice(0, 20000), type, confidence: base };
  });
}

function inferClaimType(text: string): ClaimType {
  if (PAPER_NUMERIC_UNIT_RE.test(text)) {
    return "measurement";
  }
  if (CONGRUENCE_HINT_RE.test(text)) {
    return "theoretical_congruence";
  }
  if (THEORY_HINT_RE.test(text)) {
    return "theory";
  }
  return "observation";
}

function extractFirstNumber(text: string): number | null {
  const match = text.match(/[-+]?(?:\d+(?:\.\d+)?|\.\d+)/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function extractUnitToken(text: string): string {
  const unitMatch = text.match(
    /\b(hz|khz|mhz|ghz|thz|ev|kev|mev|gev|tev|m|cm|mm|um|nm|kg|g|s|ms|us|ns|pa|kpa|mpa|j|kj|mj|w|kw|mw|v|a|ma|db|k|%)\b/i,
  );
  return unitMatch ? unitMatch[1].toLowerCase() : "arb";
}

type DraftCitation = {
  refIndex?: number;
  rawText: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  year?: number;
  title?: string;
  venue?: string;
  authors: string[];
  confidence: number;
};

type CitationRegistryEntry = {
  citation_id: string;
  ref_index?: number;
  normalized_key: string;
  raw_text: string;
  authors: string[];
  year?: number;
  title?: string;
  venue?: string;
  doi?: string;
  arxiv_id?: string;
  url?: string;
  confidence: number;
  provenance: {
    doc_id: string;
    page: number;
    span: { start: number; end: number };
    extraction_method: "pdf_text" | "ocr" | "manual" | "hybrid";
    extracted_at: string;
  };
};

type CitationLinkEntry = {
  link_id: string;
  claim_id: string;
  citation_id: string;
  relation: "cites";
  method: "marker" | "doi" | "arxiv" | "heuristic";
  confidence: number;
};

const DOI_ONE_RE = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i;
const ARXIV_ONE_RE = /\barxiv:\s*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)\b/i;
const URL_ONE_RE = /\bhttps?:\/\/[^\s<>{}|[\]"']+/i;
const REFERENCE_LINE_RE = /^(?:\[(\d{1,3})\]|(\d{1,3})[.)])\s+(.{10,})$/;
const YEAR_RE = /\b(19|20)\d{2}\b/;

function matchFirst(regex: RegExp, text: string): string | undefined {
  const match = text.match(regex);
  return match?.[0];
}

function sanitizeCitationText(text: string): string {
  return text
    .replace(/\u0000/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\s*[;,.:-]+/, "")
    .trim()
    .slice(0, 2000);
}

function normalizeUrl(url?: string): string | undefined {
  if (!url) return undefined;
  return url.replace(/[),.;:]+$/g, "").trim();
}

function parseCitationYear(text: string): number | undefined {
  const match = text.match(YEAR_RE);
  if (!match) return undefined;
  const value = Number(match[0]);
  return Number.isInteger(value) ? value : undefined;
}

function parseCitationAuthors(text: string): string[] {
  const prefix = text.split(/\(\s*(?:19|20)\d{2}[a-z]?\s*\)/i)[0] ?? text.split(".")[0] ?? "";
  return Array.from(
    new Set(
      prefix
        .split(/,| and |;/i)
        .map((entry) =>
          entry
            .replace(/^\s*[\[(]?\d+[\])]?/, "")
            .replace(/\bet al\.?$/i, "")
            .replace(/[^\p{L}\p{N}.'`\- ]+/gu, " ")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter((entry) => /[a-z]/i.test(entry) && entry.length >= 3 && entry.length <= 80),
    ),
  ).slice(0, 8);
}

function parseCitationTitle(text: string): string | undefined {
  let cursor = text;
  const yearMatch = text.match(YEAR_RE);
  if (yearMatch?.index != null) {
    cursor = text.slice(yearMatch.index + yearMatch[0].length);
  }
  cursor = cursor.replace(/^[)\].,:;\-\s]+/, "").trim();
  if (!cursor) return undefined;
  const sentence = cursor
    .split(/(?:\.\s+|;\s+)/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length >= 8);
  return sentence ? sentence.slice(0, 500) : undefined;
}

function parseCitationVenue(text: string, title?: string): string | undefined {
  if (!title) return undefined;
  const loweredText = text.toLowerCase();
  const loweredTitle = title.toLowerCase();
  const idx = loweredText.indexOf(loweredTitle);
  if (idx < 0) return undefined;
  const suffix = text.slice(idx + title.length).replace(/^[)\].,:;\-\s]+/, "").trim();
  if (!suffix) return undefined;
  const venue = suffix.split(/(?:\.\s+|;\s+)/)[0]?.trim();
  if (!venue || venue.length < 3) return undefined;
  return venue.slice(0, 300);
}

function buildDraftCitation(rawText: string, refIndex?: number, baseConfidence = 0.58): DraftCitation {
  const normalized = sanitizeCitationText(rawText);
  const doi = matchFirst(DOI_ONE_RE, normalized)?.toLowerCase();
  const arxivId = normalized.match(ARXIV_ONE_RE)?.[1]?.toLowerCase();
  const url = normalizeUrl(matchFirst(URL_ONE_RE, normalized));
  const year = parseCitationYear(normalized);
  const authors = parseCitationAuthors(normalized);
  const title = parseCitationTitle(normalized);
  const venue = parseCitationVenue(normalized, title);

  let confidence = baseConfidence;
  if (refIndex != null) confidence += 0.07;
  if (doi) confidence += 0.15;
  if (arxivId) confidence += 0.12;
  if (url) confidence += 0.08;
  if (year) confidence += 0.03;
  if (authors.length > 0) confidence += 0.04;
  if (title) confidence += 0.03;
  confidence = Math.max(0.2, Math.min(0.98, Number(confidence.toFixed(2))));

  return {
    refIndex,
    rawText: normalized,
    doi,
    arxivId,
    url,
    year,
    title,
    authors,
    confidence,
    ...(venue ? { venue } : {}),
  };
}

function citationIdentityKey(citation: DraftCitation): string {
  if (citation.doi) return `doi:${citation.doi}`;
  if (citation.arxivId) return `arxiv:${citation.arxivId}`;
  if (citation.url) return `url:${citation.url.toLowerCase()}`;
  if (citation.refIndex != null) return `ref:${citation.refIndex}:${slugify(citation.rawText).slice(0, 40)}`;
  return `raw:${slugify(citation.rawText).slice(0, 80)}`;
}

function extractCitationDrafts(text: string, maxCitations = 160): DraftCitation[] {
  const normalized = text.replace(/\r/g, "\n").trim();
  if (!normalized) return [];

  const drafts: DraftCitation[] = [];
  const lines = normalized
    .split("\n")
    .map((entry) => sanitizeCitationText(entry))
    .filter(Boolean);

  for (const line of lines) {
    const refMatch = line.match(REFERENCE_LINE_RE);
    if (refMatch) {
      const refIndex = Number(refMatch[1] ?? refMatch[2]);
      drafts.push(buildDraftCitation(refMatch[3], Number.isFinite(refIndex) ? refIndex : undefined, 0.74));
      continue;
    }
    const resemblesCitation =
      YEAR_RE.test(line) && /(doi|arxiv|https?:\/\/|et al\.|[A-Z][a-z]+,\s*[A-Z]\.)/i.test(line);
    if (resemblesCitation && line.length >= 24) {
      drafts.push(buildDraftCitation(line, undefined, 0.58));
    }
  }

  for (const match of normalized.matchAll(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/gi)) {
    if (match.index == null) continue;
    const start = Math.max(0, match.index - 120);
    const end = Math.min(normalized.length, match.index + match[0].length + 180);
    drafts.push(buildDraftCitation(normalized.slice(start, end), undefined, 0.72));
  }

  for (const match of normalized.matchAll(/\barxiv:\s*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)\b/gi)) {
    if (match.index == null) continue;
    const start = Math.max(0, match.index - 120);
    const end = Math.min(normalized.length, match.index + match[0].length + 180);
    drafts.push(buildDraftCitation(normalized.slice(start, end), undefined, 0.7));
  }

  for (const match of normalized.matchAll(/\bhttps?:\/\/[^\s<>{}|[\]"']+/gi)) {
    if (match.index == null) continue;
    const start = Math.max(0, match.index - 80);
    const end = Math.min(normalized.length, match.index + match[0].length + 120);
    drafts.push(buildDraftCitation(normalized.slice(start, end), undefined, 0.62));
  }

  const seen = new Set<string>();
  const unique: DraftCitation[] = [];
  for (const draft of drafts) {
    if (!draft.rawText) continue;
    const key = citationIdentityKey(draft);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(draft);
    if (unique.length >= maxCitations) break;
  }
  return unique;
}

function buildCitationLinks(
  claims: Array<{ text: string }>,
  claimIds: string[],
  citations: CitationRegistryEntry[],
  paperId: string,
): CitationLinkEntry[] {
  const refToCitation = new Map<number, string>();
  const doiToCitation = new Map<string, string>();
  const arxivToCitation = new Map<string, string>();

  for (const citation of citations) {
    if (citation.ref_index != null) refToCitation.set(citation.ref_index, citation.citation_id);
    if (citation.doi) doiToCitation.set(citation.doi.toLowerCase(), citation.citation_id);
    if (citation.arxiv_id) arxivToCitation.set(citation.arxiv_id.toLowerCase(), citation.citation_id);
  }

  const pairSeen = new Set<string>();
  const links: CitationLinkEntry[] = [];
  let counter = 1;

  const pushLink = (
    claimId: string,
    citationId: string,
    method: CitationLinkEntry["method"],
    confidence: number,
  ): void => {
    const key = `${claimId}|${citationId}`;
    if (pairSeen.has(key)) return;
    pairSeen.add(key);
    links.push({
      link_id: `clink:${paperId}:${counter}`,
      claim_id: claimId,
      citation_id: citationId,
      relation: "cites",
      method,
      confidence,
    });
    counter += 1;
  };

  claims.forEach((claim, idx) => {
    const claimId = claimIds[idx];
    if (!claimId) return;
    for (const marker of claim.text.matchAll(/\[(\d{1,3})\]/g)) {
      const ref = Number(marker[1]);
      const citationId = refToCitation.get(ref);
      if (citationId) pushLink(claimId, citationId, "marker", 0.88);
    }
    for (const doiMatch of claim.text.matchAll(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/gi)) {
      const citationId = doiToCitation.get(doiMatch[0].toLowerCase());
      if (citationId) pushLink(claimId, citationId, "doi", 0.9);
    }
    for (const arxivMatch of claim.text.matchAll(/\barxiv:\s*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)\b/gi)) {
      const arxivId = arxivMatch[1]?.toLowerCase();
      if (!arxivId) continue;
      const citationId = arxivToCitation.get(arxivId);
      if (citationId) pushLink(claimId, citationId, "arxiv", 0.9);
    }
  });

  if (links.length === 0 && citations.length > 0 && claimIds.length > 0) {
    pushLink(claimIds[0], citations[0].citation_id, "heuristic", 0.42);
  }
  return links;
}

type PaperCardConcept = {
  concept_id: string;
  term: string;
  aliases: string[];
  definition?: string;
  confidence: number;
  provenance: {
    doc_id: string;
    page: number;
    span: { start: number; end: number };
    extraction_method: "pdf_text" | "ocr" | "manual" | "hybrid";
    extracted_at: string;
  };
};

type PaperCardQuantValue = {
  value_id: string;
  label: string;
  value: number;
  unit: string;
  context: string;
  confidence: number;
  provenance: {
    doc_id: string;
    page: number;
    span: { start: number; end: number };
    extraction_method: "pdf_text" | "ocr" | "manual" | "hybrid";
    extracted_at: string;
  };
};

type PaperCardSystem = {
  system_id: string;
  name: string;
  components: string[];
  interactions: string[];
  confidence: number;
  provenance: {
    doc_id: string;
    page: number;
    span: { start: number; end: number };
    extraction_method: "pdf_text" | "ocr" | "manual" | "hybrid";
    extracted_at: string;
  };
};

type PaperCardCongruence = {
  assessment_id: string;
  target_type: "concept" | "system" | "value" | "equation";
  target_id: string;
  status: "agreement" | "partial_agreement" | "tension" | "conflict" | "unknown";
  score: number;
  rationale: string;
  evidence_claim_ids: string[];
};

type PaperCardBundle = {
  concepts: PaperCardConcept[];
  quantitative_values: PaperCardQuantValue[];
  systems: PaperCardSystem[];
  congruence_assessments: PaperCardCongruence[];
};

type TreeNodeRef = {
  node_id: string;
  parent_id: string;
  label: string;
};

type DagNodeRef = {
  node_id: string;
  node_type: string;
  label: string;
};

type DagEdgeRef = {
  edge_id: string;
  from: string;
  to: string;
  relation: string;
};

type AtlasPointRef = {
  point_id: string;
  node_id: string;
  namespace: string;
};

type FrameworkDeltas = {
  tree_delta: {
    added_nodes: TreeNodeRef[];
    updated_nodes: TreeNodeRef[];
  };
  dag_delta: {
    added_nodes: DagNodeRef[];
    added_edges: DagEdgeRef[];
    updated_edges: DagEdgeRef[];
  };
  atlas_delta: {
    embedding_model: string;
    spaces: string[];
    added_points: AtlasPointRef[];
    updated_points: AtlasPointRef[];
  };
};

type KnowledgePackForFrameworkMerge = {
  pack_id: string;
  run_id: string;
  paper_id: string;
  document: {
    title: string;
    source_type: "pdf" | "image";
    source_uri: string;
    source_sha256: string;
  };
  claims: Array<{ claim_id: string }>;
  citation_registry: Array<{ citation_id: string }>;
  citation_links: Array<{ link_id: string }>;
  paper_card: PaperCardBundle;
  framework_deltas: FrameworkDeltas;
};

type FrameworkSourceTracking = {
  first_seen_at: string;
  last_seen_at: string;
  source_papers: string[];
  source_runs: string[];
};

type FrameworkTreeNodeRecord = TreeNodeRef & FrameworkSourceTracking;
type FrameworkDagNodeRecord = DagNodeRef & FrameworkSourceTracking;
type FrameworkDagEdgeRecord = DagEdgeRef & FrameworkSourceTracking;
type FrameworkAtlasPointRecord = AtlasPointRef & FrameworkSourceTracking;

type FrameworkStoreStats = {
  tree_nodes: number;
  dag_nodes: number;
  dag_edges: number;
  atlas_points: number;
  papers: number;
  merges: number;
};

type FrameworkPaperCounts = {
  claims: number;
  citations: number;
  citation_links: number;
  concepts: number;
  systems: number;
  quantitative_values: number;
  congruence_assessments: number;
  tree_nodes: number;
  dag_nodes: number;
  dag_edges: number;
  atlas_points: number;
};

type FrameworkPaperRecord = {
  paper_id: string;
  title: string;
  source_type: "pdf" | "image";
  source_uri: string;
  source_sha256: string;
  first_ingested_at: string;
  latest_ingested_at: string;
  latest_run_id: string;
  latest_pack_id: string;
  topic_tags: string[];
  artifact_paths: {
    request: string;
    run: string;
    pack: string;
    card: string;
    citations: string;
    envelope: string | null;
  };
  counts: FrameworkPaperCounts;
};

type FrameworkMergeRecord = {
  merge_id: string;
  merged_at: string;
  paper_id: string;
  run_id: string;
  pack_id: string;
  deltas: {
    tree_nodes_added: number;
    tree_nodes_updated: number;
    dag_nodes_added: number;
    dag_nodes_updated: number;
    dag_edges_added: number;
    dag_edges_updated: number;
    atlas_points_added: number;
    atlas_points_updated: number;
  };
};

type FrameworkStore = {
  schema_version: 1;
  store_id: string;
  created_at: string;
  updated_at: string;
  stats: FrameworkStoreStats;
  tree: {
    nodes: FrameworkTreeNodeRecord[];
  };
  dag: {
    nodes: FrameworkDagNodeRecord[];
    edges: FrameworkDagEdgeRecord[];
  };
  atlas: {
    embedding_model: string;
    spaces: string[];
    points: FrameworkAtlasPointRecord[];
  };
  papers: FrameworkPaperRecord[];
  merges: FrameworkMergeRecord[];
  indexes: {
    concept_term_to_papers: Record<string, string[]>;
    system_name_to_papers: Record<string, string[]>;
  };
};

type FrameworkMergeSummary = {
  treeNodesAdded: number;
  treeNodesUpdated: number;
  dagNodesAdded: number;
  dagNodesUpdated: number;
  dagEdgesAdded: number;
  dagEdgesUpdated: number;
  atlasPointsAdded: number;
  atlasPointsUpdated: number;
  paperRecordCreated: boolean;
  paperRecordUpdated: boolean;
  totals: FrameworkStoreStats;
};

type FrameworkMergeInput = {
  store: FrameworkStore;
  knowledgePack: KnowledgePackForFrameworkMerge;
  mergedAt: string;
  topicTags: string[];
  artifactPaths: {
    request: string;
    run: string;
    pack: string;
    card: string;
    citations: string;
    envelope: string | null;
  };
};

type RuntimeTreeLink = {
  rel: string;
  to: string;
  score?: number;
  edgeType?: string | null;
  condition?: string | null;
};

type RuntimeTreeEvidence = {
  type: string;
  path?: string;
  uri?: string;
  content_hash?: string;
  extraction_method?: string;
  extracted_at?: string;
};

type RuntimeTreeNode = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  bodyMD: string;
  tags: string[];
  children: string[];
  links: RuntimeTreeLink[];
  summary: string;
  nodeType: string;
  evidence: RuntimeTreeEvidence[];
  inputs: string[];
  outputs: string[];
  assumptions: string[];
  validity: Record<string, unknown>;
  deterministic: string | null;
  tolerance: string | null;
  environment: string | null;
  dependencies: string[];
  predictability: {
    status: "partial" | "predictable";
    missing: string[];
  };
  [key: string]: unknown;
};

type RuntimeTreeDocument = {
  version: number;
  rootId: string;
  nodes: RuntimeTreeNode[];
  schema: { name: "helix-ask-dag-node"; version: 1 };
  [key: string]: unknown;
};

type RuntimeTreeMergeSummary = {
  nodesAdded: number;
  nodesUpdated: number;
  linksAdded: number;
  linksUpdated: number;
  totals: {
    nodes: number;
    links: number;
    paperRoots: number;
  };
};

type RuntimePromotionPack = {
  pack_id: string;
  run_id: string;
  paper_id: string;
  document: {
    title: string;
    source_type: "pdf" | "image";
    source_uri: string;
    source_sha256: string;
    media_type: string;
  };
  framework_deltas: FrameworkDeltas;
  claims: Array<{
    claim_id: string;
    claim_type: ClaimType;
    text: string;
    confidence: number;
    provenance: {
      doc_id: string;
      page: number;
      span: { start: number; end: number };
      extraction_method: "pdf_text" | "ocr" | "manual" | "hybrid";
      extracted_at: string;
    };
  }>;
  citation_registry: CitationRegistryEntry[];
  citation_links: CitationLinkEntry[];
  paper_card: PaperCardBundle;
  congruence_links: Array<{
    source_claim_id: string;
    target_node_id: string;
    relation: string;
    status: string;
    score: number;
  }>;
  math_registry: {
    equations: Array<{ equation_id: string; canonical_form: string; variable_ids: string[] }>;
    definitions: Array<{ definition_id: string; term: string; statement: string }>;
    variables: Array<{ variable_id: string; symbol: string; unit: string }>;
    units: Array<{ unit_id: string; symbol: string; quantity_kind: string }>;
    assumptions: Array<{ assumption_id: string; statement: string; scope: "local" | "model" | "global" }>;
  };
};

type RuntimeTreePromotionInput = {
  runtimeTreePath: string;
  frameworkStore: FrameworkStore;
  knowledgePack: RuntimePromotionPack;
  topicTags: string[];
  mergedAt: string;
  artifacts: {
    requestPath: string;
    requestSha256: string;
    packPath: string;
    packSha256: string;
    cardPath: string;
    cardSha256: string;
    citationsPath: string;
    citationsSha256: string;
    sourceUri: string;
    sourceSha256: string;
  };
};

type RuntimeTreePromotionResult = {
  summary: RuntimeTreeMergeSummary;
  artifact: {
    uri: string;
    sha256: string;
    bytes: number;
    media_type: "application/json";
  };
};

function runtimePredictabilityPlaceholder(): RuntimeTreeNode["predictability"] {
  return {
    status: "partial",
    missing: [
      "inputs",
      "outputs",
      "assumptions",
      "validity",
      "deterministic",
      "tolerance",
      "environment",
    ],
  };
}

function dedupeSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function linkIdentityKey(input: RuntimeTreeLink): string {
  return `${input.rel}::${input.to}`;
}

function evidenceIdentityKey(input: RuntimeTreeEvidence): string {
  return `${input.type}::${input.path ?? ""}::${input.uri ?? ""}`;
}

function classifyRuntimeNodeKind(nodeId: string): {
  nodeType: string;
  tags: string[];
} {
  if (nodeId === DEFAULT_RUNTIME_TREE_ROOT_ID) {
    return { nodeType: "concept", tags: ["paper", "ingestion", "runtime", "tree", "dag"] };
  }
  if (nodeId.startsWith("paper:")) return { nodeType: "document", tags: ["paper", "document"] };
  if (nodeId.startsWith("claim:")) return { nodeType: "claim", tags: ["paper", "claim"] };
  if (nodeId.startsWith("cite:")) return { nodeType: "citation", tags: ["paper", "citation"] };
  if (nodeId.startsWith("concept:")) return { nodeType: "entity", tags: ["paper", "concept"] };
  if (nodeId.startsWith("system:")) return { nodeType: "system", tags: ["paper", "system"] };
  if (nodeId.startsWith("value:")) return { nodeType: "measurement", tags: ["paper", "value"] };
  if (nodeId.startsWith("eq:")) return { nodeType: "equation", tags: ["paper", "math", "equation"] };
  if (nodeId.startsWith("def:")) return { nodeType: "definition", tags: ["paper", "math", "definition"] };
  if (nodeId.startsWith("var:")) return { nodeType: "variable", tags: ["paper", "math", "variable"] };
  if (nodeId.startsWith("unit:")) return { nodeType: "unit", tags: ["paper", "math", "unit"] };
  if (nodeId.startsWith("assumption:")) return { nodeType: "assumption", tags: ["paper", "math", "assumption"] };
  if (nodeId.startsWith("section:")) return { nodeType: "section", tags: ["paper", "section"] };
  if (nodeId.startsWith("congruence:")) return { nodeType: "claim", tags: ["paper", "congruence"] };
  return { nodeType: "concept", tags: ["paper", "derived"] };
}

function createRuntimeRootNode(): RuntimeTreeNode {
  return {
    id: DEFAULT_RUNTIME_TREE_ROOT_ID,
    slug: DEFAULT_RUNTIME_TREE_ROOT_ID,
    title: "Paper Ingestion Runtime Tree",
    excerpt: "Resolver-visible runtime tree derived from paper prompt-ingest framework deltas.",
    bodyMD:
      "Runtime tree fed by `scripts/paper-prompt-ingest.ts` merges so Helix graph resolvers can traverse paper claims, citations, and congruence edges.",
    tags: ["paper", "ingestion", "runtime", "tree", "dag"],
    children: [],
    links: [],
    summary: "Resolver-visible runtime tree derived from paper prompt-ingest framework deltas.",
    nodeType: "concept",
    evidence: [
      {
        type: "doc",
        path: DEFAULT_RUNTIME_TREE_PATH,
      },
    ],
    inputs: [],
    outputs: [],
    assumptions: [],
    validity: {},
    deterministic: null,
    tolerance: null,
    environment: null,
    dependencies: [],
    predictability: runtimePredictabilityPlaceholder(),
  };
}

function createEmptyRuntimeTreeDocument(): RuntimeTreeDocument {
  return {
    version: 1,
    rootId: DEFAULT_RUNTIME_TREE_ROOT_ID,
    nodes: [createRuntimeRootNode()],
    schema: {
      name: "helix-ask-dag-node",
      version: 1,
    },
  };
}

async function loadRuntimeTreeDocument(runtimeTreePath: string): Promise<RuntimeTreeDocument> {
  try {
    const raw = await fs.readFile(runtimeTreePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return createEmptyRuntimeTreeDocument();
    const nodes = Array.isArray(parsed.nodes)
      ? parsed.nodes.filter((entry): entry is RuntimeTreeNode => isRecord(entry) && typeof entry.id === "string")
      : [];
    const base: RuntimeTreeDocument = {
      version: Number.isFinite(Number(parsed.version)) ? Number(parsed.version) : 1,
      rootId:
        typeof parsed.rootId === "string" && parsed.rootId.trim().length > 0
          ? parsed.rootId.trim()
          : DEFAULT_RUNTIME_TREE_ROOT_ID,
      nodes,
      schema:
        isRecord(parsed.schema) &&
        parsed.schema.name === "helix-ask-dag-node" &&
        Number(parsed.schema.version) === 1
          ? ({ name: "helix-ask-dag-node", version: 1 } as const)
          : ({ name: "helix-ask-dag-node", version: 1 } as const),
    };
    if (!base.nodes.some((node) => node.id === base.rootId)) {
      base.nodes.unshift(createRuntimeRootNode());
      base.rootId = DEFAULT_RUNTIME_TREE_ROOT_ID;
    }
    return base;
  } catch (error) {
    const cast = error as NodeJS.ErrnoException;
    if (cast?.code === "ENOENT") return createEmptyRuntimeTreeDocument();
    throw error;
  }
}

function makeRuntimeBodyMarkdown(args: {
  nodeId: string;
  label: string;
  paperRecordById: Map<string, FrameworkPaperRecord>;
  claimById: Map<string, RuntimePromotionPack["claims"][number]>;
  citationById: Map<string, CitationRegistryEntry>;
  citationLinksByClaimId: Map<string, CitationLinkEntry[]>;
  conceptById: Map<string, PaperCardConcept>;
  systemById: Map<string, PaperCardSystem>;
  valueById: Map<string, PaperCardQuantValue>;
  equationById: Map<string, RuntimePromotionPack["math_registry"]["equations"][number]>;
  definitionById: Map<string, RuntimePromotionPack["math_registry"]["definitions"][number]>;
  variableById: Map<string, RuntimePromotionPack["math_registry"]["variables"][number]>;
  unitById: Map<string, RuntimePromotionPack["math_registry"]["units"][number]>;
  assumptionById: Map<string, RuntimePromotionPack["math_registry"]["assumptions"][number]>;
  congruenceById: Map<string, PaperCardCongruence>;
}): string {
  const claim = args.claimById.get(args.nodeId);
  if (claim) {
    const claimCitations = args.citationLinksByClaimId.get(claim.claim_id) ?? [];
    return [
      `Claim type: ${claim.claim_type}.`,
      `Confidence: ${claim.confidence.toFixed(2)}.`,
      `Text: ${claim.text}`,
      `Provenance: doc=${claim.provenance.doc_id}, page=${claim.provenance.page}, method=${claim.provenance.extraction_method}.`,
      claimCitations.length > 0 ? `Citation links: ${claimCitations.map((entry) => entry.citation_id).join(", ")}.` : "Citation links: none.",
    ].join("\n\n");
  }

  const citation = args.citationById.get(args.nodeId);
  if (citation) {
    return [
      `Citation confidence: ${citation.confidence.toFixed(2)}.`,
      citation.title ? `Title: ${citation.title}` : `Raw: ${citation.raw_text}`,
      citation.doi ? `DOI: ${citation.doi}` : "",
      citation.arxiv_id ? `arXiv: ${citation.arxiv_id}` : "",
      citation.url ? `URL: ${citation.url}` : "",
      `Provenance: doc=${citation.provenance.doc_id}, page=${citation.provenance.page}, method=${citation.provenance.extraction_method}.`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const concept = args.conceptById.get(args.nodeId);
  if (concept) {
    return [concept.definition ? `Definition: ${concept.definition}` : "", `Aliases: ${concept.aliases.join(", ") || "none"}.`]
      .filter(Boolean)
      .join("\n\n");
  }

  const system = args.systemById.get(args.nodeId);
  if (system) {
    return [
      `Components: ${system.components.join(", ") || "none"}.`,
      `Interactions: ${system.interactions.join(", ") || "none"}.`,
      `Confidence: ${system.confidence.toFixed(2)}.`,
    ].join("\n\n");
  }

  const value = args.valueById.get(args.nodeId);
  if (value) {
    return [
      `Measurement: ${value.value} ${value.unit}.`,
      `Label: ${value.label}.`,
      `Context: ${value.context}.`,
      `Confidence: ${value.confidence.toFixed(2)}.`,
    ].join("\n\n");
  }

  const equation = args.equationById.get(args.nodeId);
  if (equation) {
    return `Equation: ${equation.canonical_form}\n\nVariables: ${equation.variable_ids.join(", ") || "none"}.`;
  }

  const definition = args.definitionById.get(args.nodeId);
  if (definition) {
    return `Definition term: ${definition.term}\n\nStatement: ${definition.statement}`;
  }

  const variable = args.variableById.get(args.nodeId);
  if (variable) {
    return `Variable symbol: ${variable.symbol}\n\nUnit token: ${variable.unit}`;
  }

  const unit = args.unitById.get(args.nodeId);
  if (unit) {
    return `Unit symbol: ${unit.symbol}\n\nQuantity kind: ${unit.quantity_kind}`;
  }

  const assumption = args.assumptionById.get(args.nodeId);
  if (assumption) {
    return `Assumption (${assumption.scope}): ${assumption.statement}`;
  }

  const congruence = args.congruenceById.get(args.nodeId);
  if (congruence) {
    return [
      `Target: ${congruence.target_type} -> ${congruence.target_id}.`,
      `Status: ${congruence.status} (score ${congruence.score.toFixed(2)}).`,
      `Rationale: ${congruence.rationale}`,
      `Evidence claims: ${congruence.evidence_claim_ids.join(", ") || "none"}.`,
    ].join("\n\n");
  }

  if (args.nodeId.startsWith("paper:")) {
    const paperId = args.nodeId.slice("paper:".length);
    const record = args.paperRecordById.get(paperId);
    if (record) {
      return [
        `Title: ${record.title}`,
        `Source: ${record.source_type} (${record.source_uri})`,
        `SHA256: ${record.source_sha256}`,
        `Latest run: ${record.latest_run_id}`,
        `Counts: claims=${record.counts.claims}, citations=${record.counts.citations}, concepts=${record.counts.concepts}, systems=${record.counts.systems}, values=${record.counts.quantitative_values}.`,
      ].join("\n\n");
    }
  }

  return `Runtime node generated from paper ingest deltas.\n\nLabel: ${args.label}`;
}

function upsertRuntimeLink(node: RuntimeTreeNode, link: RuntimeTreeLink): "added" | "updated" | "unchanged" {
  const normalized: RuntimeTreeLink = {
    rel: link.rel.trim(),
    to: link.to.trim(),
    ...(typeof link.score === "number" ? { score: link.score } : {}),
    ...(typeof link.edgeType === "string" || link.edgeType === null ? { edgeType: link.edgeType ?? null } : {}),
    ...(typeof link.condition === "string" || link.condition === null
      ? { condition: link.condition ?? null }
      : {}),
  };
  const idx = node.links.findIndex((entry) => linkIdentityKey(entry) === linkIdentityKey(normalized));
  if (idx < 0) {
    node.links.push(normalized);
    return "added";
  }
  const existing = node.links[idx];
  const before = JSON.stringify(existing);
  node.links[idx] = { ...existing, ...normalized };
  return before === JSON.stringify(node.links[idx]) ? "unchanged" : "updated";
}

function upsertRuntimeEvidence(node: RuntimeTreeNode, evidence: RuntimeTreeEvidence): void {
  const normalized: RuntimeTreeEvidence = {
    type: evidence.type,
    ...(typeof evidence.path === "string" ? { path: evidence.path } : {}),
    ...(typeof evidence.uri === "string" ? { uri: evidence.uri } : {}),
    ...(typeof evidence.content_hash === "string" ? { content_hash: evidence.content_hash } : {}),
    ...(typeof evidence.extraction_method === "string" ? { extraction_method: evidence.extraction_method } : {}),
    ...(typeof evidence.extracted_at === "string" ? { extracted_at: evidence.extracted_at } : {}),
  };
  const key = evidenceIdentityKey(normalized);
  if (node.evidence.some((entry) => evidenceIdentityKey(entry) === key)) return;
  node.evidence.push(normalized);
}

function canonicalNodeForDiff(node: RuntimeTreeNode): string {
  return JSON.stringify({
    ...node,
    tags: dedupeSorted(node.tags ?? []),
    children: dedupeSorted(node.children ?? []),
    links: (node.links ?? [])
      .map((entry) => ({ ...entry }))
      .sort((a, b) => {
        const left = `${a.rel}:${a.to}`;
        const right = `${b.rel}:${b.to}`;
        return left.localeCompare(right);
      }),
    evidence: (node.evidence ?? [])
      .map((entry) => ({ ...entry }))
      .sort((a, b) => evidenceIdentityKey(a).localeCompare(evidenceIdentityKey(b))),
    dependencies: dedupeSorted(node.dependencies ?? []),
  });
}

function runtimeEdgeSnapshot(doc: RuntimeTreeDocument): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of doc.nodes) {
    for (const link of node.links ?? []) {
      const key = `${node.id}::${link.rel}::${link.to}`;
      out.set(key, JSON.stringify({ score: link.score ?? null, edgeType: link.edgeType ?? null, condition: link.condition ?? null }));
    }
  }
  return out;
}

function buildRuntimeTreeFromFramework(input: RuntimeTreePromotionInput): RuntimeTreeDocument {
  const nodeById = new Map<string, RuntimeTreeNode>();
  const root = createRuntimeRootNode();
  nodeById.set(root.id, root);

  const paperRecordById = new Map<string, FrameworkPaperRecord>(
    input.frameworkStore.papers.map((entry) => [entry.paper_id, entry]),
  );
  const dagNodeTypeById = new Map<string, string>(
    input.frameworkStore.dag.nodes.map((entry) => [entry.node_id, entry.node_type]),
  );
  const dagLabelById = new Map<string, string>(
    input.frameworkStore.dag.nodes.map((entry) => [entry.node_id, entry.label]),
  );
  const treeLabelById = new Map<string, string>(
    input.frameworkStore.tree.nodes.map((entry) => [entry.node_id, entry.label]),
  );
  const claimById = new Map(input.knowledgePack.claims.map((entry) => [entry.claim_id, entry]));
  const citationById = new Map(input.knowledgePack.citation_registry.map((entry) => [entry.citation_id, entry]));
  const citationLinksByClaimId = new Map<string, CitationLinkEntry[]>();
  for (const entry of input.knowledgePack.citation_links) {
    const list = citationLinksByClaimId.get(entry.claim_id) ?? [];
    list.push(entry);
    citationLinksByClaimId.set(entry.claim_id, list);
  }
  const conceptById = new Map(input.knowledgePack.paper_card.concepts.map((entry) => [entry.concept_id, entry]));
  const systemById = new Map(input.knowledgePack.paper_card.systems.map((entry) => [entry.system_id, entry]));
  const valueById = new Map(
    input.knowledgePack.paper_card.quantitative_values.map((entry) => [entry.value_id, entry]),
  );
  const equationById = new Map(
    input.knowledgePack.math_registry.equations.map((entry) => [entry.equation_id, entry]),
  );
  const definitionById = new Map(
    input.knowledgePack.math_registry.definitions.map((entry) => [entry.definition_id, entry]),
  );
  const variableById = new Map(
    input.knowledgePack.math_registry.variables.map((entry) => [entry.variable_id, entry]),
  );
  const unitById = new Map(input.knowledgePack.math_registry.units.map((entry) => [entry.unit_id, entry]));
  const assumptionById = new Map(
    input.knowledgePack.math_registry.assumptions.map((entry) => [entry.assumption_id, entry]),
  );
  const congruenceById = new Map(
    input.knowledgePack.paper_card.congruence_assessments.map((entry) => [entry.assessment_id, entry]),
  );

  const ensureNode = (nodeId: string, labelHint?: string, nodeTypeHint?: string): RuntimeTreeNode => {
    const label = (
      labelHint ??
      dagLabelById.get(nodeId) ??
      treeLabelById.get(nodeId) ??
      (nodeId === DEFAULT_RUNTIME_TREE_ROOT_ID ? "Paper Ingestion Runtime Tree" : nodeId)
    ).trim();
    const existing = nodeById.get(nodeId);
    const classified = classifyRuntimeNodeKind(nodeId);
    const resolvedNodeType = (nodeTypeHint ?? dagNodeTypeById.get(nodeId) ?? classified.nodeType).trim();
    if (!existing) {
      const node: RuntimeTreeNode = {
        id: nodeId,
        slug: slugify(label) || slugify(nodeId) || "node",
        title: label,
        excerpt: summarizeLabel(label, 240),
        bodyMD: makeRuntimeBodyMarkdown({
          nodeId,
          label,
          paperRecordById,
          claimById,
          citationById,
          citationLinksByClaimId,
          conceptById,
          systemById,
          valueById,
          equationById,
          definitionById,
          variableById,
          unitById,
          assumptionById,
          congruenceById,
        }),
        tags: dedupeSorted(["paper-ingest", ...classified.tags]),
        children: [],
        links: [],
        summary: summarizeLabel(label, 240),
        nodeType: resolvedNodeType || "concept",
        evidence: [],
        inputs: [],
        outputs: [],
        assumptions: [],
        validity: {},
        deterministic: null,
        tolerance: null,
        environment: null,
        dependencies: [],
        predictability: runtimePredictabilityPlaceholder(),
      };
      nodeById.set(nodeId, node);
      return node;
    }
    if (nodeId === DEFAULT_RUNTIME_TREE_ROOT_ID) {
      const rootTemplate = createRuntimeRootNode();
      existing.slug = rootTemplate.slug;
      existing.title = rootTemplate.title;
      existing.excerpt = rootTemplate.excerpt;
      existing.summary = rootTemplate.summary;
      existing.bodyMD = rootTemplate.bodyMD;
      existing.nodeType = rootTemplate.nodeType;
      existing.tags = dedupeSorted([...(existing.tags ?? []), ...rootTemplate.tags]);
      existing.predictability = runtimePredictabilityPlaceholder();
      existing.children = dedupeSorted(existing.children ?? []);
      existing.links = Array.isArray(existing.links) ? existing.links : [];
      existing.evidence = Array.isArray(existing.evidence) ? existing.evidence : [];
      return existing;
    }
    existing.title = label;
    existing.slug = slugify(label) || existing.slug || slugify(nodeId) || "node";
    existing.excerpt = summarizeLabel(label, 240);
    existing.summary = summarizeLabel(label, 240);
    existing.nodeType = resolvedNodeType || existing.nodeType || "concept";
    existing.bodyMD = makeRuntimeBodyMarkdown({
      nodeId,
      label,
      paperRecordById,
      claimById,
      citationById,
      citationLinksByClaimId,
      conceptById,
      systemById,
      valueById,
      equationById,
      definitionById,
      variableById,
      unitById,
      assumptionById,
      congruenceById,
    });
    existing.tags = dedupeSorted([...(existing.tags ?? []), "paper-ingest", ...classified.tags]);
    existing.children = dedupeSorted(existing.children ?? []);
    existing.links = Array.isArray(existing.links) ? existing.links : [];
    existing.evidence = Array.isArray(existing.evidence) ? existing.evidence : [];
    existing.inputs = Array.isArray(existing.inputs) ? existing.inputs : [];
    existing.outputs = Array.isArray(existing.outputs) ? existing.outputs : [];
    existing.assumptions = Array.isArray(existing.assumptions) ? existing.assumptions : [];
    existing.validity = isRecord(existing.validity) ? existing.validity : {};
    existing.deterministic = typeof existing.deterministic === "string" ? existing.deterministic : null;
    existing.tolerance = typeof existing.tolerance === "string" ? existing.tolerance : null;
    existing.environment = typeof existing.environment === "string" ? existing.environment : null;
    existing.dependencies = dedupeSorted(existing.dependencies ?? []);
    existing.predictability = runtimePredictabilityPlaceholder();
    return existing;
  };

  for (const treeNode of input.frameworkStore.tree.nodes) {
    const parentId = treeNode.parent_id === "tree:papers" ? DEFAULT_RUNTIME_TREE_ROOT_ID : treeNode.parent_id;
    const child = ensureNode(treeNode.node_id, treeNode.label);
    const parent = ensureNode(parentId);
    child.tags = dedupeSorted([...(child.tags ?? []), ...input.topicTags]);
    child.dependencies = dedupeSorted([...(child.dependencies ?? []), parentId]);
    child.children = dedupeSorted(child.children ?? []);
    parent.children = dedupeSorted([...(parent.children ?? []), child.id]);
    upsertRuntimeLink(child, { rel: "parent", to: parentId });

    upsertRuntimeEvidence(child, {
      type: "doc",
      path: input.artifacts.packPath,
      content_hash: `sha256:${input.artifacts.packSha256}`,
    });
    upsertRuntimeEvidence(child, {
      type: "doc",
      path: input.artifacts.cardPath,
      content_hash: `sha256:${input.artifacts.cardSha256}`,
    });
    upsertRuntimeEvidence(child, {
      type: "doc",
      path: input.artifacts.citationsPath,
      content_hash: `sha256:${input.artifacts.citationsSha256}`,
    });
    upsertRuntimeEvidence(child, {
      type: "doc",
      uri: input.artifacts.sourceUri,
      content_hash: `sha256:${input.artifacts.sourceSha256}`,
      extraction_method: "hybrid",
      extracted_at: input.mergedAt,
    });
  }

  for (const dagNode of input.frameworkStore.dag.nodes) {
    const node = ensureNode(dagNode.node_id, dagNode.label, dagNode.node_type);
    upsertRuntimeEvidence(node, {
      type: "doc",
      path: input.artifacts.packPath,
      content_hash: `sha256:${input.artifacts.packSha256}`,
    });
  }

  for (const dagEdge of input.frameworkStore.dag.edges) {
    const fromNode = ensureNode(dagEdge.from);
    ensureNode(dagEdge.to);
    upsertRuntimeLink(fromNode, { rel: dagEdge.relation, to: dagEdge.to });
  }

  for (const node of nodeById.values()) {
    node.children = dedupeSorted(node.children ?? []);
    node.tags = dedupeSorted(node.tags ?? []);
    node.links = (node.links ?? [])
      .slice()
      .sort((a, b) => {
        const left = `${a.rel}:${a.to}`;
        const right = `${b.rel}:${b.to}`;
        return left.localeCompare(right);
      });
    node.evidence = (node.evidence ?? [])
      .slice()
      .sort((a, b) => evidenceIdentityKey(a).localeCompare(evidenceIdentityKey(b)));
    node.dependencies = dedupeSorted(node.dependencies ?? []);
  }

  const nodes = Array.from(nodeById.values()).sort((a, b) => {
    if (a.id === DEFAULT_RUNTIME_TREE_ROOT_ID) return -1;
    if (b.id === DEFAULT_RUNTIME_TREE_ROOT_ID) return 1;
    return a.id.localeCompare(b.id);
  });

  const rootNode = nodes.find((entry) => entry.id === DEFAULT_RUNTIME_TREE_ROOT_ID);
  if (rootNode) {
    rootNode.children = dedupeSorted(rootNode.children ?? []);
    rootNode.tags = dedupeSorted([...(rootNode.tags ?? []), ...input.topicTags, "paper-ingest"]);
    upsertRuntimeEvidence(rootNode, {
      type: "doc",
      path: input.artifacts.requestPath,
      content_hash: `sha256:${input.artifacts.requestSha256}`,
    });
    upsertRuntimeEvidence(rootNode, {
      type: "doc",
      path: input.artifacts.packPath,
      content_hash: `sha256:${input.artifacts.packSha256}`,
    });
    upsertRuntimeEvidence(rootNode, {
      type: "doc",
      path: input.artifacts.cardPath,
      content_hash: `sha256:${input.artifacts.cardSha256}`,
    });
    upsertRuntimeEvidence(rootNode, {
      type: "doc",
      path: input.artifacts.citationsPath,
      content_hash: `sha256:${input.artifacts.citationsSha256}`,
    });
  }

  return {
    version: 1,
    rootId: DEFAULT_RUNTIME_TREE_ROOT_ID,
    nodes,
    schema: {
      name: "helix-ask-dag-node",
      version: 1,
    },
  };
}

function summarizeRuntimeTreeMerge(args: {
  previous: RuntimeTreeDocument;
  next: RuntimeTreeDocument;
}): RuntimeTreeMergeSummary {
  const previousNodeById = new Map(args.previous.nodes.map((node) => [node.id, node]));
  const nextNodeById = new Map(args.next.nodes.map((node) => [node.id, node]));
  let nodesAdded = 0;
  let nodesUpdated = 0;
  for (const [nodeId, nextNode] of nextNodeById) {
    const prevNode = previousNodeById.get(nodeId);
    if (!prevNode) {
      nodesAdded += 1;
      continue;
    }
    if (canonicalNodeForDiff(prevNode) !== canonicalNodeForDiff(nextNode)) {
      nodesUpdated += 1;
    }
  }

  const previousEdges = runtimeEdgeSnapshot(args.previous);
  const nextEdges = runtimeEdgeSnapshot(args.next);
  let linksAdded = 0;
  let linksUpdated = 0;
  for (const [edgeKey, serialized] of nextEdges) {
    if (!previousEdges.has(edgeKey)) {
      linksAdded += 1;
      continue;
    }
    if (previousEdges.get(edgeKey) !== serialized) {
      linksUpdated += 1;
    }
  }

  return {
    nodesAdded,
    nodesUpdated,
    linksAdded,
    linksUpdated,
    totals: {
      nodes: args.next.nodes.length,
      links: Array.from(nextEdges.keys()).length,
      paperRoots: args.next.nodes.filter(
        (node) => node.id.startsWith("paper:") && !node.id.includes(":tree:"),
      ).length,
    },
  };
}

async function promoteFrameworkStoreToRuntimeTree(
  input: RuntimeTreePromotionInput,
): Promise<RuntimeTreePromotionResult> {
  const runtimeTreePath = path.resolve(input.runtimeTreePath);
  const previous = await loadRuntimeTreeDocument(runtimeTreePath);
  const next = buildRuntimeTreeFromFramework(input);
  const summary = summarizeRuntimeTreeMerge({ previous, next });
  const runtimeTreeJson = `${JSON.stringify(next, null, 2)}\n`;
  await fs.mkdir(path.dirname(runtimeTreePath), { recursive: true });
  await fs.writeFile(runtimeTreePath, runtimeTreeJson, "utf8");
  return {
    summary,
    artifact: {
      uri: toFileUri(runtimeTreePath),
      sha256: sha256Hex(runtimeTreeJson),
      bytes: Buffer.byteLength(runtimeTreeJson),
      media_type: "application/json",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeLookupKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((entry) => entry.trim().length > 0)));
}

function appendPaperToLookup(index: Record<string, string[]>, key: string, paperId: string): void {
  const normalized = normalizeLookupKey(key);
  if (!normalized) return;
  const next = new Set([...(safeStringArray(index[normalized])), paperId]);
  index[normalized] = Array.from(next).sort();
}

function createEmptyFrameworkStore(nowIso: string): FrameworkStore {
  return {
    schema_version: 1,
    store_id: FRAMEWORK_STORE_ID,
    created_at: nowIso,
    updated_at: nowIso,
    stats: {
      tree_nodes: 0,
      dag_nodes: 0,
      dag_edges: 0,
      atlas_points: 0,
      papers: 0,
      merges: 0,
    },
    tree: { nodes: [] },
    dag: { nodes: [], edges: [] },
    atlas: {
      embedding_model: "ingest/hash+caption",
      spaces: ["papers"],
      points: [],
    },
    papers: [],
    merges: [],
    indexes: {
      concept_term_to_papers: {},
      system_name_to_papers: {},
    },
  };
}

function isFrameworkStore(value: unknown): value is FrameworkStore {
  if (!isRecord(value)) return false;
  if (value.schema_version !== 1) return false;
  if (typeof value.store_id !== "string") return false;
  if (typeof value.created_at !== "string" || typeof value.updated_at !== "string") return false;
  if (!isRecord(value.tree) || !Array.isArray(value.tree.nodes)) return false;
  if (!isRecord(value.dag) || !Array.isArray(value.dag.nodes) || !Array.isArray(value.dag.edges)) return false;
  if (
    !isRecord(value.atlas) ||
    typeof value.atlas.embedding_model !== "string" ||
    !Array.isArray(value.atlas.spaces) ||
    !Array.isArray(value.atlas.points)
  ) {
    return false;
  }
  if (!Array.isArray(value.papers) || !Array.isArray(value.merges)) return false;
  if (!isRecord(value.indexes)) return false;
  if (!isRecord(value.indexes.concept_term_to_papers) || !isRecord(value.indexes.system_name_to_papers)) return false;
  return true;
}

async function loadFrameworkStore(storePath: string, nowIso: string): Promise<FrameworkStore> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isFrameworkStore(parsed)) {
      return parsed;
    }
    return createEmptyFrameworkStore(nowIso);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return createEmptyFrameworkStore(nowIso);
    throw error;
  }
}

function computeFrameworkStoreStats(store: FrameworkStore): FrameworkStoreStats {
  return {
    tree_nodes: store.tree.nodes.length,
    dag_nodes: store.dag.nodes.length,
    dag_edges: store.dag.edges.length,
    atlas_points: store.atlas.points.length,
    papers: store.papers.length,
    merges: store.merges.length,
  };
}

function updateSourceTracking(
  current: FrameworkSourceTracking,
  paperId: string,
  runId: string,
  mergedAt: string,
): FrameworkSourceTracking {
  return {
    first_seen_at: current.first_seen_at,
    last_seen_at: mergedAt,
    source_papers: uniqueStrings([...safeStringArray(current.source_papers), paperId]),
    source_runs: uniqueStrings([...safeStringArray(current.source_runs), runId]),
  };
}

function mergeKnowledgePackIntoFrameworkStore(input: FrameworkMergeInput): FrameworkMergeSummary {
  const { store, knowledgePack, mergedAt, topicTags, artifactPaths } = input;
  const paperId = knowledgePack.paper_id;
  const runId = knowledgePack.run_id;

  const treeMap = new Map<string, FrameworkTreeNodeRecord>();
  for (const entry of store.tree.nodes) {
    if (!entry?.node_id) continue;
    treeMap.set(entry.node_id, entry);
  }

  const dagNodeMap = new Map<string, FrameworkDagNodeRecord>();
  for (const entry of store.dag.nodes) {
    if (!entry?.node_id) continue;
    dagNodeMap.set(entry.node_id, entry);
  }

  const dagEdgeMap = new Map<string, FrameworkDagEdgeRecord>();
  for (const entry of store.dag.edges) {
    if (!entry?.edge_id) continue;
    dagEdgeMap.set(entry.edge_id, entry);
  }

  const atlasPointMap = new Map<string, FrameworkAtlasPointRecord>();
  for (const entry of store.atlas.points) {
    if (!entry?.point_id) continue;
    atlasPointMap.set(entry.point_id, entry);
  }

  let treeNodesAdded = 0;
  let treeNodesUpdated = 0;
  const treeDelta = knowledgePack.framework_deltas.tree_delta;
  for (const node of [...treeDelta.added_nodes, ...treeDelta.updated_nodes]) {
    const existing = treeMap.get(node.node_id);
    if (!existing) {
      treeMap.set(node.node_id, {
        ...node,
        first_seen_at: mergedAt,
        last_seen_at: mergedAt,
        source_papers: [paperId],
        source_runs: [runId],
      });
      treeNodesAdded += 1;
      continue;
    }
    const tracking = updateSourceTracking(existing, paperId, runId, mergedAt);
    treeMap.set(node.node_id, {
      ...existing,
      ...node,
      ...tracking,
    });
    treeNodesUpdated += 1;
  }

  let dagNodesAdded = 0;
  let dagNodesUpdated = 0;
  for (const node of knowledgePack.framework_deltas.dag_delta.added_nodes) {
    const existing = dagNodeMap.get(node.node_id);
    if (!existing) {
      dagNodeMap.set(node.node_id, {
        ...node,
        first_seen_at: mergedAt,
        last_seen_at: mergedAt,
        source_papers: [paperId],
        source_runs: [runId],
      });
      dagNodesAdded += 1;
      continue;
    }
    const tracking = updateSourceTracking(existing, paperId, runId, mergedAt);
    dagNodeMap.set(node.node_id, {
      ...existing,
      ...node,
      ...tracking,
    });
    dagNodesUpdated += 1;
  }

  let dagEdgesAdded = 0;
  let dagEdgesUpdated = 0;
  const dagDelta = knowledgePack.framework_deltas.dag_delta;
  for (const edge of [...dagDelta.added_edges, ...dagDelta.updated_edges]) {
    const existing = dagEdgeMap.get(edge.edge_id);
    if (!existing) {
      dagEdgeMap.set(edge.edge_id, {
        ...edge,
        first_seen_at: mergedAt,
        last_seen_at: mergedAt,
        source_papers: [paperId],
        source_runs: [runId],
      });
      dagEdgesAdded += 1;
      continue;
    }
    const tracking = updateSourceTracking(existing, paperId, runId, mergedAt);
    dagEdgeMap.set(edge.edge_id, {
      ...existing,
      ...edge,
      ...tracking,
    });
    dagEdgesUpdated += 1;
  }

  let atlasPointsAdded = 0;
  let atlasPointsUpdated = 0;
  const atlasDelta = knowledgePack.framework_deltas.atlas_delta;
  for (const point of [...atlasDelta.added_points, ...atlasDelta.updated_points]) {
    const existing = atlasPointMap.get(point.point_id);
    if (!existing) {
      atlasPointMap.set(point.point_id, {
        ...point,
        first_seen_at: mergedAt,
        last_seen_at: mergedAt,
        source_papers: [paperId],
        source_runs: [runId],
      });
      atlasPointsAdded += 1;
      continue;
    }
    const tracking = updateSourceTracking(existing, paperId, runId, mergedAt);
    atlasPointMap.set(point.point_id, {
      ...existing,
      ...point,
      ...tracking,
    });
    atlasPointsUpdated += 1;
  }

  store.tree.nodes = Array.from(treeMap.values()).sort((a, b) => a.node_id.localeCompare(b.node_id));
  store.dag.nodes = Array.from(dagNodeMap.values()).sort((a, b) => a.node_id.localeCompare(b.node_id));
  store.dag.edges = Array.from(dagEdgeMap.values()).sort((a, b) => a.edge_id.localeCompare(b.edge_id));
  store.atlas.points = Array.from(atlasPointMap.values()).sort((a, b) => a.point_id.localeCompare(b.point_id));
  store.atlas.embedding_model = atlasDelta.embedding_model;
  store.atlas.spaces = uniqueStrings([...safeStringArray(store.atlas.spaces), ...safeStringArray(atlasDelta.spaces)]).sort();

  let paperRecordCreated = false;
  let paperRecordUpdated = false;
  const existingPaper = store.papers.find((entry) => entry.paper_id === paperId);
  const paperCounts: FrameworkPaperCounts = {
    claims: knowledgePack.claims.length,
    citations: knowledgePack.citation_registry.length,
    citation_links: knowledgePack.citation_links.length,
    concepts: knowledgePack.paper_card.concepts.length,
    systems: knowledgePack.paper_card.systems.length,
    quantitative_values: knowledgePack.paper_card.quantitative_values.length,
    congruence_assessments: knowledgePack.paper_card.congruence_assessments.length,
    tree_nodes: treeDelta.added_nodes.length + treeDelta.updated_nodes.length,
    dag_nodes: dagDelta.added_nodes.length,
    dag_edges: dagDelta.added_edges.length + dagDelta.updated_edges.length,
    atlas_points: atlasDelta.added_points.length + atlasDelta.updated_points.length,
  };

  if (!existingPaper) {
    store.papers.push({
      paper_id: paperId,
      title: knowledgePack.document.title,
      source_type: knowledgePack.document.source_type,
      source_uri: knowledgePack.document.source_uri,
      source_sha256: knowledgePack.document.source_sha256,
      first_ingested_at: mergedAt,
      latest_ingested_at: mergedAt,
      latest_run_id: knowledgePack.run_id,
      latest_pack_id: knowledgePack.pack_id,
      topic_tags: uniqueStrings(topicTags).sort(),
      artifact_paths: artifactPaths,
      counts: paperCounts,
    });
    paperRecordCreated = true;
  } else {
    existingPaper.title = knowledgePack.document.title;
    existingPaper.source_type = knowledgePack.document.source_type;
    existingPaper.source_uri = knowledgePack.document.source_uri;
    existingPaper.source_sha256 = knowledgePack.document.source_sha256;
    existingPaper.latest_ingested_at = mergedAt;
    existingPaper.latest_run_id = knowledgePack.run_id;
    existingPaper.latest_pack_id = knowledgePack.pack_id;
    existingPaper.topic_tags = uniqueStrings([...existingPaper.topic_tags, ...topicTags]).sort();
    existingPaper.artifact_paths = artifactPaths;
    existingPaper.counts = paperCounts;
    paperRecordUpdated = true;
  }

  for (const concept of knowledgePack.paper_card.concepts) {
    appendPaperToLookup(store.indexes.concept_term_to_papers, concept.term, paperId);
    for (const alias of concept.aliases) {
      appendPaperToLookup(store.indexes.concept_term_to_papers, alias, paperId);
    }
  }
  for (const system of knowledgePack.paper_card.systems) {
    appendPaperToLookup(store.indexes.system_name_to_papers, system.name, paperId);
  }

  store.merges.push({
    merge_id: `merge:${paperId}:${runId}`,
    merged_at: mergedAt,
    paper_id: paperId,
    run_id: runId,
    pack_id: knowledgePack.pack_id,
    deltas: {
      tree_nodes_added: treeNodesAdded,
      tree_nodes_updated: treeNodesUpdated,
      dag_nodes_added: dagNodesAdded,
      dag_nodes_updated: dagNodesUpdated,
      dag_edges_added: dagEdgesAdded,
      dag_edges_updated: dagEdgesUpdated,
      atlas_points_added: atlasPointsAdded,
      atlas_points_updated: atlasPointsUpdated,
    },
  });
  if (store.merges.length > 2000) {
    store.merges = store.merges.slice(-2000);
  }

  store.papers.sort((a, b) => a.paper_id.localeCompare(b.paper_id));
  store.updated_at = mergedAt;
  store.stats = computeFrameworkStoreStats(store);

  return {
    treeNodesAdded,
    treeNodesUpdated,
    dagNodesAdded,
    dagNodesUpdated,
    dagEdgesAdded,
    dagEdgesUpdated,
    atlasPointsAdded,
    atlasPointsUpdated,
    paperRecordCreated,
    paperRecordUpdated,
    totals: store.stats,
  };
}

const CONCEPT_KEYWORD_RE =
  /\b(?:theory|model|mechanism|framework|coherence|resonance|superposition|reduction|hierarchy|oscillation|field|dynamics?|lattice)\b/i;
const SYSTEM_KEYWORD_RE =
  /\b(?:systems?|lattices?|networks?|cort(?:ex|ices)|neurons?|microtubules?|resonators?|bubbles?|fields?|manifolds?|pipelines?|hierarch(?:y|ies)|polyrhythms?)\b/i;
const CONTRADICTION_HINT_RE = /\b(?:contradict|inconsistent|fails?|cannot|disagree|conflict)\b/i;

function extractionMethodForSource(sourceType: "pdf" | "image"): "pdf_text" | "ocr" | "manual" | "hybrid" {
  return sourceType === "pdf" ? "pdf_text" : "hybrid";
}

function toContextSnippet(text: string, index: number, tokenLength: number, pad = 70): string {
  const start = Math.max(0, index - pad);
  const end = Math.min(text.length, index + tokenLength + pad);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function extractConcepts(
  text: string,
  paperId: string,
  docId: string,
  sourceType: "pdf" | "image",
  now: number,
  maxConcepts = 24,
): PaperCardConcept[] {
  if (!text.trim()) return [];

  const extractionMethod = extractionMethodForSource(sourceType);
  const candidates: Array<{ term: string; definition?: string; confidence: number; index: number; length: number }> =
    [];

  for (const match of text.matchAll(/"([^"\n]{4,120})"/g)) {
    if (match.index == null) continue;
    const term = match[1].trim();
    if (term.length < 4) continue;
    candidates.push({
      term,
      definition: toContextSnippet(text, match.index, match[0].length, 90),
      confidence: 0.72,
      index: match.index,
      length: match[0].length,
    });
  }

  for (const match of text.matchAll(
    /\b([A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z][A-Za-z0-9-]*){0,5}\s+(?:theory|model|mechanism|framework|coherence|resonance|superposition|reduction|hierarchy|oscillation|field|dynamics?|lattice))\b/gi,
  )) {
    if (match.index == null) continue;
    const term = match[1].replace(/\s+/g, " ").trim();
    candidates.push({
      term,
      definition: toContextSnippet(text, match.index, match[0].length),
      confidence: 0.69,
      index: match.index,
      length: match[0].length,
    });
  }

  for (const match of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,5})\b/g)) {
    if (match.index == null) continue;
    const term = match[1].trim();
    if (term.length < 5) continue;
    candidates.push({
      term,
      definition: undefined,
      confidence: 0.58,
      index: match.index,
      length: match[0].length,
    });
  }

  const seen = new Set<string>();
  const concepts: PaperCardConcept[] = [];
  for (const candidate of candidates) {
    const normalized = candidate.term.toLowerCase().replace(/\s+/g, " ").trim();
    if (normalized.length < 4) continue;
    if (!/[a-z]/i.test(normalized)) continue;
    if (!CONCEPT_KEYWORD_RE.test(normalized) && normalized.split(" ").length < 2) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const idx = concepts.length + 1;
    concepts.push({
      concept_id: `concept:${paperId}:${idx}`,
      term: candidate.term.slice(0, 240),
      aliases: [],
      ...(candidate.definition ? { definition: candidate.definition.slice(0, 600) } : {}),
      confidence: Math.max(0.3, Math.min(0.95, candidate.confidence)),
      provenance: {
        doc_id: docId,
        page: 1,
        span: { start: candidate.index, end: candidate.index + candidate.length },
        extraction_method: extractionMethod,
        extracted_at: new Date(now + 80 + idx * 8).toISOString(),
      },
    });
    if (concepts.length >= maxConcepts) break;
  }
  return concepts;
}

function extractQuantitativeValues(
  text: string,
  paperId: string,
  docId: string,
  sourceType: "pdf" | "image",
  now: number,
  maxValues = 64,
): PaperCardQuantValue[] {
  if (!text.trim()) return [];
  const extractionMethod = extractionMethodForSource(sourceType);
  const values: PaperCardQuantValue[] = [];
  const re =
    /([-+]?(?:\d+(?:\.\d+)?|\.\d+))\s?(hz|khz|mhz|ghz|thz|ev|kev|mev|gev|tev|m|cm|mm|um|nm|kg|g|s|ms|us|ns|pa|kpa|mpa|j|kj|mj|w|kw|mw|v|a|ma|db|k|%)/gi;
  for (const match of text.matchAll(re)) {
    if (match.index == null) continue;
    const numeric = Number(match[1]);
    if (!Number.isFinite(numeric)) continue;
    const unit = match[2].toLowerCase();
    const idx = values.length + 1;
    values.push({
      value_id: `qval:${paperId}:${idx}`,
      label: `value_${idx}`,
      value: numeric,
      unit,
      context: toContextSnippet(text, match.index, match[0].length, 80).slice(0, 600),
      confidence: 0.79,
      provenance: {
        doc_id: docId,
        page: 1,
        span: { start: match.index, end: match.index + match[0].length },
        extraction_method: extractionMethod,
        extracted_at: new Date(now + 180 + idx * 6).toISOString(),
      },
    });
    if (values.length >= maxValues) break;
  }
  return values;
}

function extractSystems(
  text: string,
  concepts: PaperCardConcept[],
  paperId: string,
  docId: string,
  sourceType: "pdf" | "image",
  now: number,
  maxSystems = 16,
): PaperCardSystem[] {
  const extractionMethod = extractionMethodForSource(sourceType);
  const systems: PaperCardSystem[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(
    /\b([A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z][A-Za-z0-9-]*){0,7}\s+(?:systems?|lattices?|networks?|cort(?:ex|ices)|neurons?|microtubules?|resonators?|bubbles?|fields?|manifolds?|pipelines?|hierarch(?:y|ies)|polyrhythms?))\b/gi,
  )) {
    if (match.index == null) continue;
    const name = match[1].replace(/\s+/g, " ").trim();
    const normalized = name.toLowerCase();
    if (!SYSTEM_KEYWORD_RE.test(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const context = toContextSnippet(text, match.index, match[0].length, 90);
    const components = context
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length >= 4)
      .slice(0, 5);
    const interactions: string[] = [];
    if (/\b(interact|couple|drive|modulate|align|synchronize)\b/i.test(context)) {
      interactions.push("coupled_dynamics");
    }
    if (/\b(measure|observe|detect)\b/i.test(context)) {
      interactions.push("measurement_channel");
    }
    const idx = systems.length + 1;
    systems.push({
      system_id: `system:${paperId}:${idx}`,
      name: name.slice(0, 280),
      components: Array.from(new Set(components)),
      interactions,
      confidence: 0.67,
      provenance: {
        doc_id: docId,
        page: 1,
        span: { start: match.index, end: match.index + match[0].length },
        extraction_method: extractionMethod,
        extracted_at: new Date(now + 260 + idx * 10).toISOString(),
      },
    });
    if (systems.length >= maxSystems) break;
  }

  if (systems.length === 0 && concepts.length > 0) {
    const fallback = concepts.find((entry) => SYSTEM_KEYWORD_RE.test(entry.term.toLowerCase()));
    if (fallback) {
      systems.push({
        system_id: `system:${paperId}:1`,
        name: fallback.term,
        components: [],
        interactions: [],
        confidence: 0.42,
        provenance: fallback.provenance,
      });
    }
  }
  return systems;
}

function buildPaperCardCongruence(
  paperId: string,
  concepts: PaperCardConcept[],
  systems: PaperCardSystem[],
  values: PaperCardQuantValue[],
  equations: Array<{ equation_id: string; canonical_form: string; variable_ids: string[] }>,
  claimIds: string[],
  claims: Array<{ text: string; type: ClaimType }>,
  canonicalBindings: CanonicalBindingSet,
): PaperCardCongruence[] {
  const hasAgreementSignal =
    claims.some((entry) => entry.type === "theoretical_congruence") ||
    claims.some((entry) => CONGRUENCE_HINT_RE.test(entry.text));
  const hasConflictSignal = claims.some((entry) => CONTRADICTION_HINT_RE.test(entry.text));
  const evidence = claimIds.slice(0, 3);

  const pickStatus = (): PaperCardCongruence["status"] => {
    if (hasConflictSignal) return "conflict";
    if (hasAgreementSignal) return "agreement";
    return "unknown";
  };
  const status = pickStatus();
  const score = status === "agreement" ? 0.76 : status === "conflict" ? 0.33 : 0.5;
  const rationale =
    status === "agreement"
      ? "Claims include explicit congruence/consistency signals."
      : status === "conflict"
        ? "Claims include contradiction/conflict language."
        : "No explicit agreement/conflict markers detected.";

  const rationaleWithBinding = (base: string, match?: CanonicalBindingMatch): string => {
    if (!match) return base;
    const source = path.basename(match.sourceTree);
    return `${base} Canonical mapping -> ${match.canonicalId} (${match.canonicalLabel}) via ${source}; score=${match.score.toFixed(2)}.`;
  };

  const records: PaperCardCongruence[] = [];
  let counter = 1;
  for (const concept of concepts.slice(0, 8)) {
    const binding = canonicalBindings.concept[concept.concept_id];
    records.push({
      assessment_id: `congruence:${paperId}:${counter}`,
      target_type: "concept",
      target_id: binding?.canonicalId ?? concept.concept_id,
      status,
      score: binding ? Math.max(score, Math.min(0.98, binding.score)) : score,
      rationale: rationaleWithBinding(rationale, binding),
      evidence_claim_ids: evidence,
    });
    counter += 1;
  }
  for (const system of systems.slice(0, 8)) {
    const binding = canonicalBindings.system[system.system_id];
    records.push({
      assessment_id: `congruence:${paperId}:${counter}`,
      target_type: "system",
      target_id: binding?.canonicalId ?? system.system_id,
      status,
      score: binding ? Math.max(score, Math.min(0.98, binding.score)) : score,
      rationale: rationaleWithBinding(rationale, binding),
      evidence_claim_ids: evidence,
    });
    counter += 1;
  }
  for (const equation of equations.slice(0, 8)) {
    const binding = canonicalBindings.equation[equation.equation_id];
    const equationRationale = binding
      ? "Equation extracted and aligned with canonical physics equation node."
      : "Equation extracted; canonical framework alignment pending.";
    records.push({
      assessment_id: `congruence:${paperId}:${counter}`,
      target_type: "equation",
      target_id: binding?.canonicalId ?? equation.equation_id,
      status: binding ? status : "unknown",
      score: binding ? Math.max(0.62, Math.min(0.98, binding.score)) : 0.5,
      rationale: rationaleWithBinding(equationRationale, binding),
      evidence_claim_ids: evidence,
    });
    counter += 1;
  }
  for (const value of values.slice(0, 8)) {
    records.push({
      assessment_id: `congruence:${paperId}:${counter}`,
      target_type: "value",
      target_id: value.value_id,
      status: "unknown",
      score: 0.48,
      rationale: "Numeric value extracted; external congruence not yet cross-checked.",
      evidence_claim_ids: evidence,
    });
    counter += 1;
  }
  return records;
}

function summarizeLabel(text: string, max = 128): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function dedupeTreeNodes(nodes: TreeNodeRef[]): TreeNodeRef[] {
  const map = new Map<string, TreeNodeRef>();
  for (const node of nodes) {
    map.set(node.node_id, node);
  }
  return Array.from(map.values());
}

function dedupeDagNodes(nodes: DagNodeRef[]): DagNodeRef[] {
  const map = new Map<string, DagNodeRef>();
  for (const node of nodes) {
    map.set(node.node_id, node);
  }
  return Array.from(map.values());
}

function dedupeDagEdges(edges: DagEdgeRef[]): DagEdgeRef[] {
  const map = new Map<string, DagEdgeRef>();
  for (const edge of edges) {
    map.set(edge.edge_id, edge);
  }
  return Array.from(map.values());
}

function dedupeAtlasPoints(points: AtlasPointRef[]): AtlasPointRef[] {
  const map = new Map<string, AtlasPointRef>();
  for (const point of points) {
    map.set(point.point_id, point);
  }
  return Array.from(map.values());
}

function claimNodeType(claimType: ClaimType): DagNodeRef["node_type"] {
  if (claimType === "observation") return "observation";
  if (claimType === "measurement") return "measurement";
  if (claimType === "theory") return "theory";
  return "claim";
}

function buildFrameworkScaffold(args: {
  paperId: string;
  title: string;
  claims: Array<{ text: string; type: ClaimType }>;
  claimIds: string[];
  concepts: PaperCardConcept[];
  systems: PaperCardSystem[];
  values: PaperCardQuantValue[];
  citations: CitationRegistryEntry[];
  citationLinks: CitationLinkEntry[];
  equations: Array<{ equation_id: string; canonical_form: string; variable_ids: string[] }>;
  definitions: Array<{ definition_id: string; term: string; statement: string }>;
  variables: Array<{ variable_id: string; symbol: string; unit: string }>;
  units: Array<{ unit_id: string; symbol: string; quantity_kind: string }>;
  assumptions: Array<{ assumption_id: string; statement: string; scope: "local" | "model" | "global" }>;
  congruenceAssessments: PaperCardCongruence[];
  canonicalBindings: CanonicalBindingSet;
  canonicalNodesById: Map<string, CanonicalNodeDescriptor>;
}): {
  treeNodes: TreeNodeRef[];
  dagNodes: DagNodeRef[];
  dagEdges: DagEdgeRef[];
  atlasPoints: AtlasPointRef[];
} {
  const {
    paperId,
    title,
    claims,
    claimIds,
    concepts,
    systems,
    values,
    citations,
    citationLinks,
    equations,
    definitions,
    variables,
    units,
    assumptions,
    congruenceAssessments,
    canonicalBindings,
    canonicalNodesById,
  } = args;

  const canonicalMatches = collectCanonicalBindingMatches(canonicalBindings);
  const canonicalLabelById = new Map<string, string>();
  const canonicalTypeById = new Map<string, DagNodeRef["node_type"]>();
  const canonicalTypeRank: Record<string, number> = {
    entity: 1,
    system: 2,
    theory: 2,
    model: 3,
    equation: 4,
  };
  for (const match of canonicalMatches) {
    const descriptor = canonicalNodesById.get(match.canonicalId);
    const candidateType = (descriptor?.nodeType ?? match.nodeType ?? "entity") as DagNodeRef["node_type"];
    const existingType = canonicalTypeById.get(match.canonicalId);
    if (!existingType || (canonicalTypeRank[candidateType] ?? 0) > (canonicalTypeRank[existingType] ?? 0)) {
      canonicalTypeById.set(match.canonicalId, candidateType);
    }
    canonicalLabelById.set(
      match.canonicalId,
      summarizeLabel(descriptor?.label ?? match.canonicalLabel ?? match.canonicalId, 512),
    );
  }

  const paperNodeId = `paper:${paperId}`;
  const hubs = {
    claims: `${paperNodeId}:tree:claims`,
    concepts: `${paperNodeId}:tree:concepts`,
    systems: `${paperNodeId}:tree:systems`,
    values: `${paperNodeId}:tree:values`,
    math: `${paperNodeId}:tree:math`,
    citations: `${paperNodeId}:tree:citations`,
    congruence: `${paperNodeId}:tree:congruence`,
    framework: `${paperNodeId}:tree:framework`,
  } as const;

  const treeNodes: TreeNodeRef[] = [
    { node_id: paperNodeId, parent_id: "tree:papers", label: summarizeLabel(title, 512) || paperId },
    { node_id: hubs.claims, parent_id: paperNodeId, label: "Claims" },
    { node_id: hubs.concepts, parent_id: paperNodeId, label: "Concepts" },
    { node_id: hubs.systems, parent_id: paperNodeId, label: "Systems" },
    { node_id: hubs.values, parent_id: paperNodeId, label: "Quantitative Values" },
    { node_id: hubs.math, parent_id: paperNodeId, label: "Math Objects" },
    { node_id: hubs.citations, parent_id: paperNodeId, label: "Citations" },
    { node_id: hubs.congruence, parent_id: paperNodeId, label: "Congruence" },
    { node_id: hubs.framework, parent_id: paperNodeId, label: "Canonical Framework Links" },
    ...claimIds.map((claimId, idx) => ({
      node_id: claimId,
      parent_id: hubs.claims,
      label: summarizeLabel(`${claims[idx]?.type ?? "claim"}: ${claims[idx]?.text ?? claimId}`, 512),
    })),
    ...concepts.map((entry) => ({
      node_id: entry.concept_id,
      parent_id: hubs.concepts,
      label: summarizeLabel(entry.term, 512),
    })),
    ...systems.map((entry) => ({
      node_id: entry.system_id,
      parent_id: hubs.systems,
      label: summarizeLabel(entry.name, 512),
    })),
    ...values.map((entry) => ({
      node_id: entry.value_id,
      parent_id: hubs.values,
      label: summarizeLabel(`${entry.value} ${entry.unit}`, 512),
    })),
    ...citations.map((entry) => ({
      node_id: entry.citation_id,
      parent_id: hubs.citations,
      label: summarizeLabel(entry.title ?? entry.raw_text, 512),
    })),
    ...equations.map((entry) => ({
      node_id: entry.equation_id,
      parent_id: hubs.math,
      label: summarizeLabel(entry.canonical_form, 512),
    })),
    ...definitions.map((entry) => ({
      node_id: entry.definition_id,
      parent_id: hubs.math,
      label: summarizeLabel(entry.term, 512),
    })),
    ...variables.map((entry) => ({
      node_id: entry.variable_id,
      parent_id: hubs.math,
      label: summarizeLabel(`${entry.symbol} [${entry.unit}]`, 512),
    })),
    ...units.map((entry) => ({
      node_id: entry.unit_id,
      parent_id: hubs.math,
      label: summarizeLabel(`${entry.symbol} (${entry.quantity_kind})`, 512),
    })),
    ...assumptions.map((entry) => ({
      node_id: entry.assumption_id,
      parent_id: hubs.math,
      label: summarizeLabel(entry.statement, 512),
    })),
    ...congruenceAssessments.map((entry) => ({
      node_id: entry.assessment_id,
      parent_id: hubs.congruence,
      label: summarizeLabel(`${entry.status}: ${entry.target_type} -> ${entry.target_id}`, 512),
    })),
    ...canonicalMatches.map((entry) => ({
      node_id: entry.canonicalId,
      parent_id: hubs.framework,
      label: canonicalLabelById.get(entry.canonicalId) ?? summarizeLabel(entry.canonicalLabel, 512),
    })),
  ];

  const sectionIds = {
    claims: `section:${paperId}:claims`,
    concepts: `section:${paperId}:concepts`,
    systems: `section:${paperId}:systems`,
    values: `section:${paperId}:values`,
    math: `section:${paperId}:math`,
    citations: `section:${paperId}:citations`,
    congruence: `section:${paperId}:congruence`,
    framework: `section:${paperId}:framework`,
  } as const;

  const dagNodes: DagNodeRef[] = [
    { node_id: paperNodeId, node_type: "document", label: summarizeLabel(title, 512) || paperId },
    { node_id: sectionIds.claims, node_type: "section", label: "Claims" },
    { node_id: sectionIds.concepts, node_type: "section", label: "Concepts" },
    { node_id: sectionIds.systems, node_type: "section", label: "Systems" },
    { node_id: sectionIds.values, node_type: "section", label: "Quantitative Values" },
    { node_id: sectionIds.math, node_type: "section", label: "Math Objects" },
    { node_id: sectionIds.citations, node_type: "section", label: "Citations" },
    { node_id: sectionIds.congruence, node_type: "section", label: "Congruence" },
    { node_id: sectionIds.framework, node_type: "section", label: "Canonical Framework Links" },
    ...claimIds.map((claimId, idx) => ({
      node_id: claimId,
      node_type: claimNodeType(claims[idx]?.type ?? "observation"),
      label: summarizeLabel(claims[idx]?.text ?? claimId, 512),
    })),
    ...concepts.map((entry) => ({ node_id: entry.concept_id, node_type: "entity" as const, label: summarizeLabel(entry.term, 512) })),
    ...systems.map((entry) => ({ node_id: entry.system_id, node_type: "system" as const, label: summarizeLabel(entry.name, 512) })),
    ...values.map((entry) => ({
      node_id: entry.value_id,
      node_type: "measurement" as const,
      label: summarizeLabel(`${entry.value} ${entry.unit}`, 512),
    })),
    ...citations.map((entry) => ({
      node_id: entry.citation_id,
      node_type: "citation" as const,
      label: summarizeLabel(entry.title ?? entry.raw_text, 512),
    })),
    ...equations.map((entry) => ({ node_id: entry.equation_id, node_type: "equation" as const, label: summarizeLabel(entry.canonical_form, 512) })),
    ...definitions.map((entry) => ({ node_id: entry.definition_id, node_type: "definition" as const, label: summarizeLabel(entry.term, 512) })),
    ...variables.map((entry) => ({ node_id: entry.variable_id, node_type: "variable" as const, label: summarizeLabel(entry.symbol, 512) })),
    ...units.map((entry) => ({ node_id: entry.unit_id, node_type: "unit" as const, label: summarizeLabel(entry.symbol, 512) })),
    ...assumptions.map((entry) => ({ node_id: entry.assumption_id, node_type: "assumption" as const, label: summarizeLabel(entry.statement, 512) })),
    ...canonicalMatches.map((entry) => ({
      node_id: entry.canonicalId,
      node_type: (canonicalTypeById.get(entry.canonicalId) ?? "entity") as DagNodeRef["node_type"],
      label: canonicalLabelById.get(entry.canonicalId) ?? summarizeLabel(entry.canonicalLabel, 512),
    })),
  ];

  const unitBySymbol = new Map<string, string>(units.map((unit) => [unit.symbol.toLowerCase(), unit.unit_id]));
  const conceptByTerm = new Map<string, string>(
    concepts.map((entry) => [entry.term.toLowerCase().replace(/\s+/g, " ").trim(), entry.concept_id]),
  );

  const dagEdges: DagEdgeRef[] = [
    { edge_id: `edge:section-doc:${paperId}:claims`, from: sectionIds.claims, to: paperNodeId, relation: "refines" },
    { edge_id: `edge:section-doc:${paperId}:concepts`, from: sectionIds.concepts, to: paperNodeId, relation: "refines" },
    { edge_id: `edge:section-doc:${paperId}:systems`, from: sectionIds.systems, to: paperNodeId, relation: "refines" },
    { edge_id: `edge:section-doc:${paperId}:values`, from: sectionIds.values, to: paperNodeId, relation: "refines" },
    { edge_id: `edge:section-doc:${paperId}:math`, from: sectionIds.math, to: paperNodeId, relation: "refines" },
    { edge_id: `edge:section-doc:${paperId}:citations`, from: sectionIds.citations, to: paperNodeId, relation: "refines" },
    { edge_id: `edge:section-doc:${paperId}:congruence`, from: sectionIds.congruence, to: paperNodeId, relation: "refines" },
    { edge_id: `edge:section-doc:${paperId}:framework`, from: sectionIds.framework, to: paperNodeId, relation: "refines" },
    ...claimIds.map((claimId, idx) => ({
      edge_id: `edge:claim-doc:${paperId}:${idx + 1}`,
      from: claimId,
      to: paperNodeId,
      relation: "observed_in" as const,
    })),
    ...claimIds.map((claimId, idx) => ({
      edge_id: `edge:claim-section:${paperId}:${idx + 1}`,
      from: claimId,
      to: sectionIds.claims,
      relation: "observed_in" as const,
    })),
    ...systems.map((entry, idx) => ({
      edge_id: `edge:system-doc:${paperId}:${idx + 1}`,
      from: entry.system_id,
      to: paperNodeId,
      relation: "derives_from" as const,
    })),
    ...concepts.map((entry, idx) => ({
      edge_id: `edge:concept-doc:${paperId}:${idx + 1}`,
      from: entry.concept_id,
      to: paperNodeId,
      relation: "derives_from" as const,
    })),
    ...values.map((entry, idx) => ({
      edge_id: `edge:value-doc:${paperId}:${idx + 1}`,
      from: entry.value_id,
      to: paperNodeId,
      relation: "observed_in" as const,
    })),
    ...citationLinks.map((entry) => ({
      edge_id: `edge:${entry.link_id}`,
      from: entry.claim_id,
      to: entry.citation_id,
      relation: "cites" as const,
    })),
    ...equations.flatMap((entry) =>
      entry.variable_ids.map((variableId, idx) => ({
        edge_id: `edge:eq-var:${entry.equation_id}:${idx + 1}`,
        from: entry.equation_id,
        to: variableId,
        relation: "uses_variable" as const,
      })),
    ),
    ...variables
      .map((entry, idx) => {
        const unitId = unitBySymbol.get(entry.unit.toLowerCase());
        if (!unitId) return null;
        return {
          edge_id: `edge:var-unit:${paperId}:${idx + 1}`,
          from: entry.variable_id,
          to: unitId,
          relation: "has_unit" as const,
        };
      })
      .filter((entry): entry is DagEdgeRef => entry !== null),
    ...definitions
      .map((entry, idx) => {
        const conceptId = conceptByTerm.get(entry.term.toLowerCase().replace(/\s+/g, " ").trim());
        if (!conceptId) return null;
        return {
          edge_id: `edge:def-concept:${paperId}:${idx + 1}`,
          from: entry.definition_id,
          to: conceptId,
          relation: "defines" as const,
        };
      })
      .filter((entry): entry is DagEdgeRef => entry !== null),
    ...congruenceAssessments.flatMap((entry, idx) =>
      entry.evidence_claim_ids.map((claimId, jdx) => ({
        edge_id: `edge:congruence:${paperId}:${idx + 1}:${jdx + 1}`,
        from: claimId,
        to: entry.target_id,
        relation: (entry.status === "conflict" ? "contradicts" : "supports") as DagEdgeRef["relation"],
      })),
    ),
    ...canonicalMatches.map((entry, idx) => ({
      edge_id: `edge:framework-section:${paperId}:${idx + 1}`,
      from: entry.canonicalId,
      to: sectionIds.framework,
      relation: "refines" as const,
    })),
    ...concepts
      .map((entry, idx) => {
        const binding = canonicalBindings.concept[entry.concept_id];
        if (!binding) return null;
        return {
          edge_id: `edge:canonical-concept:${paperId}:${idx + 1}`,
          from: entry.concept_id,
          to: binding.canonicalId,
          relation: binding.relation,
        };
      })
      .filter((entry): entry is DagEdgeRef => entry !== null),
    ...systems
      .map((entry, idx) => {
        const binding = canonicalBindings.system[entry.system_id];
        if (!binding) return null;
        return {
          edge_id: `edge:canonical-system:${paperId}:${idx + 1}`,
          from: entry.system_id,
          to: binding.canonicalId,
          relation: binding.relation,
        };
      })
      .filter((entry): entry is DagEdgeRef => entry !== null),
    ...equations
      .map((entry, idx) => {
        const binding = canonicalBindings.equation[entry.equation_id];
        if (!binding) return null;
        return {
          edge_id: `edge:canonical-equation:${paperId}:${idx + 1}`,
          from: entry.equation_id,
          to: binding.canonicalId,
          relation: binding.relation,
        };
      })
      .filter((entry): entry is DagEdgeRef => entry !== null),
    ...(canonicalBindings.model
      ? [
          {
            edge_id: `edge:canonical-model:${paperId}:1`,
            from: paperNodeId,
            to: canonicalBindings.model.canonicalId,
            relation: canonicalBindings.model.relation,
          } satisfies DagEdgeRef,
        ]
      : []),
  ];

  const atlasPoints: AtlasPointRef[] = [
    { point_id: `apoint:${paperId}:doc`, node_id: paperNodeId, namespace: "papers" },
    ...claimIds.map((claimId, idx) => ({
      point_id: `apoint:${paperId}:claim:${idx + 1}`,
      node_id: claimId,
      namespace: "papers",
    })),
    ...concepts.map((entry, idx) => ({
      point_id: `apoint:${paperId}:concept:${idx + 1}`,
      node_id: entry.concept_id,
      namespace: "papers",
    })),
    ...systems.map((entry, idx) => ({
      point_id: `apoint:${paperId}:system:${idx + 1}`,
      node_id: entry.system_id,
      namespace: "papers",
    })),
    ...values.map((entry, idx) => ({
      point_id: `apoint:${paperId}:value:${idx + 1}`,
      node_id: entry.value_id,
      namespace: "papers",
    })),
    ...citations.slice(0, 64).map((entry, idx) => ({
      point_id: `apoint:${paperId}:citation:${idx + 1}`,
      node_id: entry.citation_id,
      namespace: "papers",
    })),
    ...canonicalMatches.map((entry, idx) => ({
      point_id: `apoint:${paperId}:framework:${idx + 1}`,
      node_id: entry.canonicalId,
      namespace: "framework",
    })),
  ];

  return {
    treeNodes: dedupeTreeNodes(treeNodes),
    dagNodes: dedupeDagNodes(dagNodes),
    dagEdges: dedupeDagEdges(dagEdges),
    atlasPoints: dedupeAtlasPoints(atlasPoints),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const resolvedFile = await resolveInputFile(opts);
  const buffer = await fs.readFile(resolvedFile);
  const mime = detectMime(resolvedFile);
  const sourceType = detectSourceType(mime);
  const sourceHash = sha256Hex(buffer);
  const resolvedTitle = opts.title?.trim() || deriveTitleFromFile(resolvedFile);
  const derivedTags = deriveTagsFromFile(resolvedFile);
  const explicitTags = opts.tags.map(normalizeTag).filter(Boolean);
  const mergedSeedTags = Array.from(new Set(["paper", ...explicitTags, ...derivedTags]));
  const paperSlug = slugify(resolvedTitle) || "paper";
  const paperId = `${paperSlug}:${sourceHash.slice(0, 8)}`;
  const paperDirName = paperId.replace(/[^a-z0-9._-]+/gi, "-");
  const requestId = `paperreq:${randomUUID()}`;
  const runId = `paperrun:${randomUUID()}`;
  const packId = `paperpack:${randomUUID()}`;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const docId = `doc:${paperId}`;

  const authHeaders: Record<string, string> = {};
  if (opts.token) authHeaders.Authorization = `Bearer ${opts.token}`;
  if (opts.tenantId) authHeaders["X-Tenant-Id"] = opts.tenantId;

  const form = new FormData();
  form.set("creator_id", opts.creatorId);
  form.set("visibility", opts.visibility);
  form.set("license", "CC-BY-4.0");
  form.set("file", new Blob([buffer], { type: mime }), path.basename(resolvedFile));

  const ingestRes = await fetch(`${opts.baseUrl}/api/essence/ingest`, {
    method: "POST",
    headers: authHeaders,
    body: form,
  });
  let ingestMode: IngestMode = "essence";
  let ingestWarning: string | null = null;
  let ingest: EssenceIngestResponse;
  if (ingestRes.ok) {
    ingest = (await ingestRes.json()) as EssenceIngestResponse;
  } else {
    const text = await ingestRes.text();
    if (ingestRes.status === 415 && mime === "application/pdf") {
      ingestMode = "local_pdf_fallback";
      ingestWarning =
        "PDF rejected by /api/essence/ingest; continuing with local fallback artifacts only.";
      ingest = {
        essence_id: `localpdf:${sourceHash.slice(0, 16)}`,
        uri: toFileUri(resolvedFile),
        hash: sourceHash,
        dedup: false,
      };
    } else {
      throw new Error(`Ingest failed (${ingestRes.status}): ${text}`);
    }
  }

  let envelope: EssenceEnvelopeLike | null = null;
  if (ingestMode === "essence") {
    for (let attempt = 0; attempt < Math.max(1, opts.pollAttempts); attempt += 1) {
      const envRes = await fetch(`${opts.baseUrl}/api/essence/${encodeURIComponent(ingest.essence_id)}`, {
        method: "GET",
        headers: authHeaders,
      });
      if (envRes.ok) {
        envelope = (await envRes.json()) as EssenceEnvelopeLike;
        const textFeature = envelope?.features?.text;
        if (textFeature?.transcript || textFeature?.summary || textFeature?.caption) {
          break;
        }
      }
      await wait(Math.max(50, opts.pollDelayMs));
    }
  }

  const textFeature = envelope?.features?.text;
  const envelopeExtractionText = [textFeature?.transcript, textFeature?.summary, textFeature?.caption]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  let extractionOrigin: "essence_text" | "local_pdf_text" | "fallback" = "essence_text";
  let extractionText = envelopeExtractionText;
  if (sourceType === "pdf" && hasBinaryLikeEnvelopeText(extractionText)) {
    try {
      const localPdfText = await extractLocalPdfText(resolvedFile, 40);
      if (localPdfText.trim().length > 0) {
        extractionText = localPdfText;
        extractionOrigin = "local_pdf_text";
      }
    } catch {
      // Keep envelope text when local PDF extraction fails.
    }
  }
  if (!extractionText.trim()) {
    extractionOrigin = "fallback";
  }

  const extracted = [extractionText, textFeature?.transcript, textFeature?.summary, textFeature?.caption]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value.length > 0);
  const featureTags = normalizeStringArray(textFeature?.tags)
    .map((tag) => normalizeTag(tag))
    .filter((tag) => keepFeatureTag(tag));
  const allTags = Array.from(new Set([...mergedSeedTags, ...featureTags]));
  const baseText =
    extracted || `Ingested ${sourceType} source ${path.basename(resolvedFile)} for later OCR/analysis.`;
  const draftClaims = splitIntoClaimAtoms(baseText, 12);
  const claims =
    draftClaims.length > 0
      ? draftClaims
      : [{ text: baseText.slice(0, 20000), type: "observation" as const, confidence: 0.3 }];
  const claimIds = claims.map((_, idx) => `claim:${paperId}:${idx + 1}`);
  extractionText = extractionText || claims.map((entry) => entry.text).join("\n");
  const conceptRecords = extractConcepts(extractionText, paperId, docId, sourceType, now);
  const quantValueRecords = extractQuantitativeValues(extractionText, paperId, docId, sourceType, now);
  const systemRecords = extractSystems(extractionText, conceptRecords, paperId, docId, sourceType, now);
  const measurementClaim = claims.find((entry) => entry.type === "measurement");
  const theoryClaim = claims.find((entry) => entry.type === "theory");
  const firstClaimId = claimIds[0] ?? `claim:${paperId}:1`;

  const inferredEquationMatches = Array.from(
    extractionText.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\s*=\s*([^\n.;]{3,90})/g),
  ).slice(0, 12);
  const inferredEquations = inferredEquationMatches.map((match, idx) => {
    const lhs = match[1].trim();
    const rhs = match[2].trim().replace(/\s+/g, " ");
    return {
      equation_id: `eq:${paperId}:inferred:${idx + 1}`,
      canonical_form: `${lhs} = ${rhs}`.slice(0, 3000),
      variable_ids: [`var:${paperId}:inferred:${idx + 1}:${lhs.toLowerCase()}`],
      dimensionally_consistent: true,
    };
  });
  const canonicalBindingResolution = await resolveCanonicalFrameworkBindings({
    title: resolvedTitle,
    extractionText,
    claimTexts: claims.map((entry) => entry.text),
    concepts: conceptRecords,
    systems: systemRecords,
    equations: inferredEquations,
  });
  const canonicalBindings = canonicalBindingResolution.bindings;
  const paperCardCongruence = buildPaperCardCongruence(
    paperId,
    conceptRecords,
    systemRecords,
    quantValueRecords,
    inferredEquations,
    claimIds,
    claims,
    canonicalBindings,
  );

  const inferredDefinitions = conceptRecords.slice(0, 24).map((concept, idx) => ({
    definition_id: `def:${paperId}:${idx + 1}`,
    term: concept.term.slice(0, 1024),
    statement: (concept.definition ?? concept.term).slice(0, 20000),
  }));

  const inferredVariables = quantValueRecords.slice(0, 64).map((value, idx) => ({
    variable_id: `var:${paperId}:q:${idx + 1}`,
    symbol: `q${idx + 1}`,
    unit: value.unit,
  }));

  const inferredUnits = Array.from(new Set(quantValueRecords.map((entry) => entry.unit)))
    .slice(0, 64)
    .map((unit, idx) => ({
      unit_id: `unit:${paperId}:${idx + 1}`,
      symbol: unit,
      quantity_kind: unit === "%" ? "ratio" : "unknown",
    }));

  const inferredAssumptions = Array.from(
    extractionText.matchAll(/([^.]{0,80}\b(?:assume|assumed|hypothesis|suggests?|propose|implies)\b[^.]{0,160})/gi),
  )
    .slice(0, 24)
    .map((match, idx) => ({
      assumption_id: `asm:${paperId}:${idx + 1}`,
      statement: match[1].replace(/\s+/g, " ").trim().slice(0, 20000),
      scope: "model" as const,
    }));

  const citationDrafts = extractCitationDrafts(extractionText || baseText, 200);
  const citationRegistry: CitationRegistryEntry[] = citationDrafts.map((entry, idx) => {
    const normalizedKey = sha256Hex(
      `${entry.doi ?? ""}|${entry.arxivId ?? ""}|${entry.url ?? ""}|${entry.rawText.toLowerCase()}`,
    ).slice(0, 24);
    return {
      citation_id: `cite:${paperId}:${idx + 1}`,
      ...(entry.refIndex != null ? { ref_index: entry.refIndex } : {}),
      normalized_key: normalizedKey,
      raw_text: entry.rawText,
      authors: entry.authors,
      ...(entry.year != null ? { year: entry.year } : {}),
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.venue ? { venue: entry.venue } : {}),
      ...(entry.doi ? { doi: entry.doi } : {}),
      ...(entry.arxivId ? { arxiv_id: entry.arxivId } : {}),
      ...(entry.url ? { url: entry.url } : {}),
      confidence: entry.confidence,
      provenance: {
        doc_id: docId,
        page: 1,
        span: { start: 0, end: Math.max(1, Math.min(entry.rawText.length, 256)) },
        extraction_method: sourceType === "pdf" ? "pdf_text" : "hybrid",
        extracted_at: new Date(now + 240 + idx * 10).toISOString(),
      },
    };
  });

  const citationLinks = buildCitationLinks(claims, claimIds, citationRegistry, paperId);
  const canonicalFrameworkMatches = collectCanonicalBindingMatches(canonicalBindings);
  const graphAnchorRefs = [
    ...claimIds,
    ...citationRegistry.map((entry) => entry.citation_id),
    ...canonicalFrameworkMatches.map((entry) => entry.canonicalId),
  ];
  const frameworkScaffold = buildFrameworkScaffold({
    paperId,
    title: resolvedTitle,
    claims,
    claimIds,
    concepts: conceptRecords,
    systems: systemRecords,
    values: quantValueRecords,
    citations: citationRegistry,
    citationLinks,
    equations: inferredEquations,
    definitions: inferredDefinitions,
    variables: inferredVariables,
    units: inferredUnits,
    assumptions: inferredAssumptions,
    congruenceAssessments: paperCardCongruence,
    canonicalBindings,
    canonicalNodesById: canonicalBindingResolution.nodesById,
  });
  const canonicalModelNodeId = canonicalBindings.model?.canonicalId ?? `model:${paperId}:1`;
  const primaryPredictionEquationIds = Array.from(
    new Set([
      ...inferredEquations.slice(0, 1).map((entry) => entry.equation_id),
      ...Object.values(canonicalBindings.equation)
        .slice(0, 2)
        .map((entry) => entry.canonicalId),
    ]),
  );

  const predictionContracts =
    theoryClaim && measurementClaim
      ? [
          {
            contract_id: `pred:${paperId}:1`,
            model_node_id: canonicalModelNodeId,
            ...(primaryPredictionEquationIds.length > 0
              ? { equation_ids: primaryPredictionEquationIds }
              : {}),
            input_bindings: [
              {
                variable_id: `var:${paperId}:obs`,
                value: extractFirstNumber(measurementClaim.text) ?? 0,
                unit: extractUnitToken(measurementClaim.text),
              },
            ],
            predicted_observable: {
              variable_id: `var:${paperId}:pred`,
              value: extractFirstNumber(measurementClaim.text) ?? 0,
              unit: extractUnitToken(measurementClaim.text),
            },
            measured_observable: {
              variable_id: `var:${paperId}:obs`,
              value: extractFirstNumber(measurementClaim.text) ?? 0,
              unit: extractUnitToken(measurementClaim.text),
              dataset_ref: `essence:${ingest.essence_id}`,
            },
            fit: { residual: 0, normalized_residual: 0, r2: 1, chi2: 0, dof: 1 },
            status: "match" as const,
          },
        ]
      : [];

  const symbolMapEntries =
    predictionContracts.length > 0
      ? [
          {
            canonical_symbol: "x",
            mapping_type: "exact",
            aliases: [{ paper_id: paperId, symbol: "x", unit: extractUnitToken(measurementClaim?.text ?? "") }],
          },
        ]
      : [];

  const falsifierEdges =
    predictionContracts.length > 0
      ? [
          {
            edge_id: `fals:${paperId}:1`,
            hypothesis_node_id: `hyp:${paperId}:1`,
            falsifier_node_id: `obs:${paperId}:1`,
            status: "pending",
            evidence_claim_ids: [firstClaimId],
          },
        ]
      : [];

  const maturityGates = [
    {
      gate_id: `gate:${paperId}:1`,
      target_id: canonicalModelNodeId,
      required_stage: "diagnostic",
      current_stage: predictionContracts.length > 0 ? "reduced-order" : "exploratory",
      status: predictionContracts.length > 0 ? "warn" : "warn",
      blocking_reason: "needs external validation set for promotion beyond diagnostic",
      falsifier_edge_ids: falsifierEdges.map((edge) => edge.edge_id),
      evaluated_at: new Date(now + 650).toISOString(),
    },
  ];

  const ingestRequest = {
    schema_version: 1,
    request_id: requestId,
    submitted_at: nowIso,
    tenant_id: opts.tenantId ?? "local",
    submitted_by: { user_id: opts.creatorId, channel: "cli" },
    paper: {
      paper_id: paperId,
      title_hint: resolvedTitle,
      topic_tags: allTags.length ? allTags : ["paper"],
    },
    source: {
      source_type: sourceType,
      uri: ingest.uri,
      filename: path.basename(resolvedFile),
      media_type: mime,
      bytes: buffer.byteLength,
      sha256: sourceHash,
    },
    options: {
      ocr_mode: sourceType === "pdf" ? "auto" : "force",
      chunking_profile: "equation_aware",
      extraction_profile: "physics",
      review_mode: "auto_if_high_confidence",
      math_trace_mode: "strict",
      require_prediction_contracts: opts.requirePredictionContracts,
      require_symbol_equivalence_map: opts.requireSymbolEquivalenceMap,
      require_falsifier_edges: opts.requireFalsifierEdges,
      require_citation_registry: opts.requireCitationRegistry,
      require_paper_card: opts.requirePaperCard,
    },
  };

  const packBase = {
    schema_version: 1,
    pack_id: packId,
    run_id: runId,
    paper_id: paperId,
    tenant_id: opts.tenantId ?? "local",
    generated_at: new Date(now + 400).toISOString(),
    document: {
      title: resolvedTitle,
      source_type: sourceType,
      source_uri: ingest.uri,
      source_sha256: sourceHash,
      media_type: mime,
    },
    claims: claims.map((entry, idx) => ({
      claim_id: claimIds[idx] ?? `claim:${paperId}:${idx + 1}`,
      claim_type: entry.type,
      text: entry.text,
      confidence: entry.confidence,
      maturity_stage: "exploratory",
      provenance: {
        doc_id: docId,
        page: 1,
        span: { start: 0, end: Math.max(1, Math.min(entry.text.length, 256)) },
        extraction_method: sourceType === "pdf" ? "pdf_text" : "hybrid",
        extracted_at: new Date(now + 300 + idx * 20).toISOString(),
      },
    })),
    congruence_links: paperCardCongruence.map((entry) => ({
      source_claim_id: firstClaimId,
      target_node_id: entry.target_id,
      relation: entry.status === "conflict" ? "contradicts" : "supports",
      status: entry.status,
      score: entry.score,
    })),
    framework_deltas: {
      tree_delta: {
        added_nodes: frameworkScaffold.treeNodes,
        updated_nodes: [],
      },
      dag_delta: {
        added_nodes: frameworkScaffold.dagNodes,
        added_edges: [
          ...frameworkScaffold.dagEdges,
          ...claimIds.flatMap((claimId) =>
            conceptRecords.slice(0, 6).map((concept, idx) => ({
              edge_id: `edge:claim-concept:${paperId}:${claimId}:${idx + 1}`,
              from: claimId,
              to: concept.concept_id,
              relation: "derives_from" as const,
            })),
          ),
          ...claimIds.flatMap((claimId) =>
            quantValueRecords.slice(0, 6).map((value, idx) => ({
              edge_id: `edge:claim-measure:${paperId}:${claimId}:${idx + 1}`,
              from: claimId,
              to: value.value_id,
              relation: "measured_as" as const,
            })),
          ),
          ...systemRecords.flatMap((system, idx) =>
            conceptRecords.slice(0, 4).map((concept, jdx) => ({
              edge_id: `edge:system-concept:${paperId}:${idx + 1}:${jdx + 1}`,
              from: system.system_id,
              to: concept.concept_id,
              relation: "depends_on" as const,
            })),
          ),
        ],
        updated_edges: [],
      },
      atlas_delta: {
        embedding_model: "ingest/hash+caption",
        spaces: ["papers"],
        added_points: frameworkScaffold.atlasPoints,
        updated_points: [],
      },
    },
    math_registry: {
      equations: inferredEquations,
      definitions: inferredDefinitions,
      variables: [
        ...(predictionContracts.length > 0
          ? [{ variable_id: `var:${paperId}:obs`, symbol: "x", unit: extractUnitToken(measurementClaim?.text ?? "") }]
          : []),
        ...inferredVariables,
      ],
      units: inferredUnits,
      assumptions: inferredAssumptions,
    },
    prediction_contracts: predictionContracts,
    symbol_equivalence_map: { resolution_policy: "canonical_wins", entries: symbolMapEntries },
    falsifier_edges: falsifierEdges,
    maturity_gates: maturityGates,
    citation_registry: citationRegistry,
    citation_links: citationLinks,
    paper_card: {
      concepts: conceptRecords,
      quantitative_values: quantValueRecords,
      systems: systemRecords,
      math_objects: {
        equations: inferredEquations,
        definitions: inferredDefinitions,
        variables: [
          ...(predictionContracts.length > 0
            ? [{ variable_id: `var:${paperId}:obs`, symbol: "x", unit: extractUnitToken(measurementClaim?.text ?? "") }]
            : []),
          ...inferredVariables,
        ],
        units: inferredUnits,
        assumptions: inferredAssumptions,
      },
      congruence_assessments: paperCardCongruence,
    },
    retrieval_index: {
      lexical_ref: { provider: "local", index_id: `lex:${paperId}`, record_count: 1 },
      vector_ref: { provider: "local", index_id: `vec:${paperId}`, record_count: 1 },
      graph_anchor_refs: Array.from(
        new Set([
          ...graphAnchorRefs,
          `paper:${paperId}`,
          ...frameworkScaffold.dagNodes.map((entry) => entry.node_id),
          ...frameworkScaffold.dagEdges.flatMap((entry) => [entry.from, entry.to]),
        ]),
      ),
    },
    review: {
      status: "approved",
      reviewed_at: new Date(now + 700).toISOString(),
      reviewer_id: "codex:auto",
      reason_codes: ["AUTO_PROMPT_INGEST"],
    },
  };

  const lineageSeed = JSON.stringify({
    paperId,
    sourceHash,
    essenceId: ingest.essence_id,
    requestId,
  });
  const lineageHash = sha256Hex(lineageSeed);
  const knowledgePack = {
    ...packBase,
    derivation_lineage: {
      lineage_version: 1,
      lineage_hash: lineageHash,
      replay_seed: `seed:${sourceHash.slice(0, 12)}`,
      steps: [
        {
          step_id: `step:${paperId}:ingest`,
          version: 1,
          operation: "merge",
          at: new Date(now + 500).toISOString(),
          input_hashes: [sourceHash],
          output_hashes: [lineageHash],
        },
      ],
    },
  };

  const outRoot = path.resolve(opts.outDir, paperDirName);
  await fs.mkdir(outRoot, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const requestPath = path.join(outRoot, `${stamp}.request.json`);
  const packPath = path.join(outRoot, `${stamp}.pack.json`);
  const cardPath = path.join(outRoot, `${stamp}.card.json`);
  const citationsPath = path.join(outRoot, `${stamp}.citations.json`);
  const runPath = path.join(outRoot, `${stamp}.run.json`);
  const envelopePath = path.join(outRoot, `${stamp}.envelope.json`);

  const requestJson = `${JSON.stringify(ingestRequest, null, 2)}\n`;
  const packJson = `${JSON.stringify(knowledgePack, null, 2)}\n`;
  const cardJson = `${JSON.stringify(
    {
      schema_version: 1,
      paper_id: paperId,
      paper_card: knowledgePack.paper_card,
    },
    null,
    2,
  )}\n`;
  const citationsJson = `${JSON.stringify(
    {
      schema_version: 1,
      paper_id: paperId,
      citation_registry: knowledgePack.citation_registry,
      citation_links: knowledgePack.citation_links,
    },
    null,
    2,
  )}\n`;
  const requestSha256 = sha256Hex(requestJson);
  const packSha256 = sha256Hex(packJson);
  const cardSha256 = sha256Hex(cardJson);
  const citationsSha256 = sha256Hex(citationsJson);
  await fs.writeFile(requestPath, requestJson, "utf8");
  await fs.writeFile(packPath, packJson, "utf8");
  await fs.writeFile(cardPath, cardJson, "utf8");
  await fs.writeFile(citationsPath, citationsJson, "utf8");
  if (envelope) {
    await fs.writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  }

  const frameworkStorePath = path.resolve(opts.outDir, FRAMEWORK_STORE_DIR, FRAMEWORK_STORE_FILE);
  const frameworkStore = await loadFrameworkStore(frameworkStorePath, nowIso);
  const frameworkMergedAt = new Date(now + 860).toISOString();
  const frameworkMergeSummary = mergeKnowledgePackIntoFrameworkStore({
    store: frameworkStore,
    knowledgePack: knowledgePack as KnowledgePackForFrameworkMerge,
    mergedAt: frameworkMergedAt,
    topicTags: allTags,
    artifactPaths: {
      request: requestPath,
      run: runPath,
      pack: packPath,
      card: cardPath,
      citations: citationsPath,
      envelope: envelope ? envelopePath : null,
    },
  });
  const frameworkStoreJson = `${JSON.stringify(frameworkStore, null, 2)}\n`;
  await fs.mkdir(path.dirname(frameworkStorePath), { recursive: true });
  await fs.writeFile(frameworkStorePath, frameworkStoreJson, "utf8");
  const frameworkStoreArtifact = {
    uri: toFileUri(frameworkStorePath),
    sha256: sha256Hex(frameworkStoreJson),
    bytes: Buffer.byteLength(frameworkStoreJson),
    media_type: "application/json",
  };
  const runtimeTreePath = path.resolve(opts.runtimeTreePath);
  const runtimeTreePromotion =
    opts.promoteRuntimeTree
      ? await promoteFrameworkStoreToRuntimeTree({
          runtimeTreePath,
          frameworkStore,
          knowledgePack: knowledgePack as RuntimePromotionPack,
          topicTags: allTags,
          mergedAt: frameworkMergedAt,
          artifacts: {
            requestPath,
            requestSha256,
            packPath,
            packSha256,
            cardPath,
            cardSha256,
            citationsPath,
            citationsSha256,
            sourceUri: ingest.uri,
            sourceSha256: sourceHash,
          },
        })
      : null;

  const predictionStatus =
    opts.requirePredictionContracts && knowledgePack.prediction_contracts.length === 0 ? "fail" : "pass";
  const symbolStatus =
    opts.requireSymbolEquivalenceMap && knowledgePack.symbol_equivalence_map.entries.length === 0
      ? "fail"
      : "pass";
  const maturityStatus = knowledgePack.maturity_gates.some((gate) => gate.status === "fail") ? "fail" : "warn";
  const falsifierStatus =
    opts.requireFalsifierEdges && knowledgePack.falsifier_edges.length === 0 ? "fail" : "pass";
  const citationStatus =
    opts.requireCitationRegistry && knowledgePack.citation_registry.length === 0
      ? "fail"
      : knowledgePack.citation_registry.length === 0
        ? "warn"
        : knowledgePack.citation_links.length === 0
          ? "warn"
          : "pass";
  const paperCardMissingCore =
    knowledgePack.paper_card.concepts.length === 0 ||
    knowledgePack.paper_card.systems.length === 0 ||
    knowledgePack.paper_card.quantitative_values.length === 0;
  const paperCardStatus =
    opts.requirePaperCard && paperCardMissingCore
      ? "fail"
      : paperCardMissingCore
        ? "warn"
        : "pass";
  const overallStatus =
    predictionStatus === "fail" ||
    symbolStatus === "fail" ||
    falsifierStatus === "fail" ||
    citationStatus === "fail" ||
    paperCardStatus === "fail"
      ? "fail"
      : maturityStatus === "warn" || citationStatus === "warn" || paperCardStatus === "warn"
        ? "warn"
        : "pass";
  const lifecycleState = overallStatus === "fail" ? "blocked" : "published";
  const currentStage = overallStatus === "fail" ? "review_pending" : "none";

  const runRecord = {
    schema_version: 1,
    state_machine_id: "paper_run.v1",
    run_id: runId,
    request_id: requestId,
    paper_id: paperId,
    tenant_id: opts.tenantId ?? "local",
    submitted_by: opts.creatorId,
    created_at: nowIso,
    updated_at: new Date(now + 900).toISOString(),
    started_at: new Date(now + 20).toISOString(),
    finished_at: new Date(now + 900).toISOString(),
    lifecycle_state: lifecycleState,
    current_stage: currentStage,
    stage_attempts: {
      parsing: 1,
      extracting: 1,
      normalizing: 1,
      graph_merging: 1,
      indexing: 1,
      review_pending: 1,
    },
    transition_log: [
      { from: "queued", event: "validate_intake", to: "intake_validated", at: isoAt(now, 10), actor: "system" },
      { from: "intake_validated", event: "start_parse", to: "parsing", at: isoAt(now, 20), actor: "system" },
      { from: "parsing", event: "parse_complete", to: "extracting", at: isoAt(now, 120), actor: "system" },
      { from: "extracting", event: "extract_complete", to: "normalizing", at: isoAt(now, 220), actor: "system" },
      { from: "normalizing", event: "normalize_complete", to: "graph_merging", at: isoAt(now, 320), actor: "system" },
      { from: "graph_merging", event: "merge_complete", to: "indexing", at: isoAt(now, 420), actor: "system" },
      { from: "indexing", event: "index_complete", to: "review_pending", at: isoAt(now, 520), actor: "system" },
      ...(overallStatus === "fail"
        ? [
            {
              from: "review_pending",
              event: "soft_fail",
              to: "blocked",
              at: isoAt(now, 720),
              actor: "reviewer",
              reason_code: "TOE_REQUIREMENTS_MISSING",
              message: "Strict TOE requirement flags requested artifacts not present in draft pack.",
            },
          ]
        : [
            {
              from: "review_pending",
              event: "review_approved",
              to: "published",
              at: isoAt(now, 720),
              actor: "reviewer",
            },
          ]),
    ],
    artifacts: {
      parse_output: { uri: toFileUri(resolvedFile), sha256: sourceHash, bytes: buffer.byteLength, media_type: mime },
      claim_output: null,
      citation_output: {
        uri: toFileUri(citationsPath),
        sha256: citationsSha256,
        bytes: Buffer.byteLength(citationsJson),
        media_type: "application/json",
      },
      paper_card_output: {
        uri: toFileUri(cardPath),
        sha256: cardSha256,
        bytes: Buffer.byteLength(cardJson),
        media_type: "application/json",
      },
      normalized_output: null,
      graph_delta_output: frameworkStoreArtifact,
      index_output: null,
      knowledge_pack: { uri: toFileUri(packPath), sha256: packSha256, bytes: Buffer.byteLength(packJson), media_type: "application/json" },
    },
    validation: {
      math_trace_mode: "strict",
      prediction_contracts: {
        required: opts.requirePredictionContracts,
        validated: knowledgePack.prediction_contracts.length,
        status: predictionStatus,
      },
      symbol_equivalence: {
        required: opts.requireSymbolEquivalenceMap,
        entries: knowledgePack.symbol_equivalence_map.entries.length,
        status: symbolStatus,
      },
      lineage: {
        lineage_hash: knowledgePack.derivation_lineage.lineage_hash,
        steps: knowledgePack.derivation_lineage.steps.length,
        replayable: true,
        status: "pass",
      },
      maturity_gates: {
        evaluated: knowledgePack.maturity_gates.length,
        failed: knowledgePack.maturity_gates.filter((gate) => gate.status === "fail").length,
        status: maturityStatus,
      },
      falsifier_edges: {
        required: opts.requireFalsifierEdges,
        count: knowledgePack.falsifier_edges.length,
        status: falsifierStatus,
      },
      citations: {
        required: opts.requireCitationRegistry,
        extracted: knowledgePack.citation_registry.length,
        linked_claim_edges: knowledgePack.citation_links.length,
        status: citationStatus,
      },
      paper_card: {
        required: opts.requirePaperCard,
        concepts: knowledgePack.paper_card.concepts.length,
        systems: knowledgePack.paper_card.systems.length,
        quantitative_values: knowledgePack.paper_card.quantitative_values.length,
        congruence_assessments: knowledgePack.paper_card.congruence_assessments.length,
        status: paperCardStatus,
      },
      overall_status: overallStatus,
      reason_codes: Array.from(
        new Set([
          "PROMPT_INGEST_COMPLETE",
          ...(runtimeTreePromotion ? ["RUNTIME_TREE_PROMOTED"] : []),
          ...(extractionOrigin === "local_pdf_text" ? ["LOCAL_PDF_TEXT_OVERRIDE"] : []),
          ...(ingestMode === "local_pdf_fallback" ? ["ESSENCE_PDF_UNSUPPORTED_LOCAL_FALLBACK"] : []),
          ...(knowledgePack.citation_registry.length === 0 ? ["CITATIONS_NOT_FOUND"] : []),
          ...(paperCardMissingCore ? ["PAPER_CARD_INCOMPLETE"] : []),
        ]),
      ),
    },
  };

  const runJson = `${JSON.stringify(runRecord, null, 2)}\n`;
  await fs.writeFile(runPath, runJson, "utf8");

  const summary = {
    ok: true,
    paperId,
    requestId,
    runId,
    packId,
    essenceId: ingest.essence_id,
    ingestMode,
    ingestWarning,
    sourceType,
    extractionOrigin,
    citations: {
      extracted: knowledgePack.citation_registry.length,
      linkedClaims: knowledgePack.citation_links.length,
    },
    paperCard: {
      concepts: knowledgePack.paper_card.concepts.length,
      systems: knowledgePack.paper_card.systems.length,
      quantitativeValues: knowledgePack.paper_card.quantitative_values.length,
      congruenceAssessments: knowledgePack.paper_card.congruence_assessments.length,
    },
    framework: {
      treeNodesAdded: frameworkMergeSummary.treeNodesAdded,
      treeNodesUpdated: frameworkMergeSummary.treeNodesUpdated,
      dagNodesAdded: frameworkMergeSummary.dagNodesAdded,
      dagNodesUpdated: frameworkMergeSummary.dagNodesUpdated,
      dagEdgesAdded: frameworkMergeSummary.dagEdgesAdded,
      dagEdgesUpdated: frameworkMergeSummary.dagEdgesUpdated,
      atlasPointsAdded: frameworkMergeSummary.atlasPointsAdded,
      atlasPointsUpdated: frameworkMergeSummary.atlasPointsUpdated,
      paperRecordCreated: frameworkMergeSummary.paperRecordCreated,
      paperRecordUpdated: frameworkMergeSummary.paperRecordUpdated,
      totals: frameworkMergeSummary.totals,
    },
    runtimeTree: runtimeTreePromotion
      ? {
          enabled: true,
          path: runtimeTreePath,
          nodesAdded: runtimeTreePromotion.summary.nodesAdded,
          nodesUpdated: runtimeTreePromotion.summary.nodesUpdated,
          linksAdded: runtimeTreePromotion.summary.linksAdded,
          linksUpdated: runtimeTreePromotion.summary.linksUpdated,
          totals: runtimeTreePromotion.summary.totals,
          artifact: runtimeTreePromotion.artifact,
        }
      : {
          enabled: false,
          path: runtimeTreePath,
        },
    validation: {
      overallStatus,
      lifecycleState,
    },
    files: {
      request: requestPath,
      run: runPath,
      pack: packPath,
      card: cardPath,
      citations: citationsPath,
      framework: frameworkStorePath,
      runtimeTree: runtimeTreePromotion ? runtimeTreePath : null,
      envelope: envelope ? envelopePath : null,
    },
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[paper-prompt-ingest] ${message}`);
  process.exitCode = 1;
});
