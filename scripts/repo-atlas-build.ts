import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { getRepoSearchIndex } from "../server/services/search/repo-index";
import { getRepoGraphSnapshot } from "../server/services/repo/repoGraph";
import { buildCodeLatticeSnapshot } from "../server/services/code-lattice/builders";

const execFileAsync = promisify(execFile);

export type AtlasNodeKind = "file" | "symbol" | "concept" | "value" | "gate";
export type AtlasEdgeKind =
  | "imports"
  | "defines"
  | "mentions"
  | "tests"
  | "use"
  | "doc-ref"
  | "command-ref"
  | "causal";

export type AtlasNode = {
  id: string;
  kind: AtlasNodeKind;
  label: string;
  path?: string;
  source?: string;
  stageHints?: string[];
  meta?: Record<string, unknown>;
};

export type AtlasEdge = {
  source: string;
  target: string;
  kind: AtlasEdgeKind;
  sourceSystem: string;
  meta?: Record<string, unknown>;
};

export type RepoAtlas = {
  version: "repo-atlas/1";
  snapshot: {
    generatedAt: string;
    commitHash: string;
    repoGraphBuiltAt?: number;
    treeDagWalkLoaded?: boolean;
  };
  nodes: AtlasNode[];
  edges: AtlasEdge[];
};

export const DEFAULT_ATLAS_PATH = path.join(process.cwd(), "artifacts", "repo-atlas", "repo-atlas.v1.json");
const DEFAULT_TREE_DAG_WALK_REPORT_PATH = path.join(process.cwd(), "docs", "warp-tree-dag-walk-report.json");
const DEFAULT_IDEOLOGY_PATH = path.join(process.cwd(), "docs", "ethos", "ideology.json");
const DEFAULT_SCIENTIFIC_METHOD_POLICY_PATH = path.join(
  process.cwd(),
  "docs",
  "knowledge",
  "scientific-method-policy-tree.json",
);
const SCRIPT_DOC_REF_SOURCE_SYSTEM = "script-doc-ref";
const SOURCE_PATH_PREFIXES = ["scripts/", "docs/"] as const;
const PATH_REF_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".json",
  ".md",
  ".mdx",
] as const;
const SOURCE_SCAN_ALLOWED_EXTENSIONS = new Set<string>([
  ...PATH_REF_EXTENSIONS,
  ".sh",
  ".ps1",
  ".yaml",
  ".yml",
]);
const IMPORT_REF_REGEX =
  /(?:import\s+[^'"\n]*from\s*|import\s*|require\(\s*|from\s+|export\s+[^'"\n]*from\s*)(['"])([^'"\n]+)\1/gm;
const COMMAND_TARGET_REGEX = /(?:^|\s)(?:tsx|node|python|bash)\s+([./A-Za-z0-9_\-\\/]+(?:\.[A-Za-z0-9]+)?)/gim;
const NPM_RUN_REGEX = /npm\s+run\s+([A-Za-z0-9:_-]+)/gim;
const MARKDOWN_LINK_REGEX = /\[[^\]]+\]\(([^)]+)\)/gm;
const GENERIC_PATH_REF_REGEX =
  /(?:^|[\s("'`])((?:\.{1,2}\/|\/)?(?:docs|scripts|server|client|modules|configs|shared)\/[A-Za-z0-9._\/-]+\.[A-Za-z0-9]+)(?:[#?)\s"',:;]|$)/gm;

let packageScriptCommandMapCache: Map<string, string[]> | null = null;

type TreeDagWalkVisitedNode = {
  id?: string;
  depth?: number;
  via?: {
    source?: string;
    target?: string;
    edgeType?: string;
    requiresCL?: string;
    condition?: string | null;
    chartDependency?: string | null;
    note?: string | null;
  };
};

type TreeDagWalkReport = {
  visited?: TreeDagWalkVisitedNode[];
};

type IdeologyLink = {
  rel?: string;
  to?: string;
};

type IdeologyGraphNode = {
  id?: string;
  links?: IdeologyLink[];
};

type IdeologyGraph = {
  nodes?: IdeologyGraphNode[];
};

type AtlasSources = {
  generatedAt: string;
  commitHash: string;
  repoIndex: Awaited<ReturnType<typeof getRepoSearchIndex>>;
  repoGraph: Awaited<ReturnType<typeof getRepoGraphSnapshot>>;
  codeLattice: Awaited<ReturnType<typeof buildCodeLatticeSnapshot>>["snapshot"];
  treeDagWalk?: TreeDagWalkReport | null;
  ideology?: IdeologyGraph | null;
  scientificMethodPolicy?: IdeologyGraph | null;
};

const STAGE_HINT_FIELDS = ["S0_source", "S1_qi_sample", "S2_bound_computed", "S3_bound_policy", "S4_margin", "S5_gate"];
const STAGE_HINT_VOCABULARY: Record<string, string[]> = {
  S0_source: ["rhosource", "metrict00ref", "metrict00si_jm3", "warpfieldtype"],
  S1_qi_sample: ["lhs_jm3"],
  S2_bound_computed: ["boundcomputed_jm3", "tau_s", "tauconfigured_s", "\"k\"", "kprovenance"],
  S3_bound_policy: ["boundused_jm3", "boundfloorapplied", "boundpolicyfloor_jm3", "boundfloor_jm3"],
  S4_margin: ["marginratioraw", "marginratiorawcomputed", "marginratio"],
  S5_gate: ["applicabilitystatus", "reasoncode", "g4reasoncodes", "g4_qi_margin", "warpviable"],
};
const G4_STAGE_CHAIN_NODES: AtlasNode[] = [
  { id: "value:rhoSource", kind: "value", label: "rhoSource", source: "g4-stage-chain", stageHints: ["S0_source"] },
  { id: "value:lhs_Jm3", kind: "value", label: "lhs_Jm3", source: "g4-stage-chain", stageHints: ["S1_qi_sample"] },
  {
    id: "value:boundComputed_Jm3",
    kind: "value",
    label: "boundComputed_Jm3",
    source: "g4-stage-chain",
    stageHints: ["S2_bound_computed"],
  },
  {
    id: "value:boundUsed_Jm3",
    kind: "value",
    label: "boundUsed_Jm3",
    source: "g4-stage-chain",
    stageHints: ["S3_bound_policy"],
  },
  {
    id: "value:marginRatioRaw",
    kind: "value",
    label: "marginRatioRaw",
    source: "g4-stage-chain",
    stageHints: ["S4_margin"],
  },
  {
    id: "gate:G4_QI_margin",
    kind: "gate",
    label: "G4_QI_margin",
    source: "g4-stage-chain",
    stageHints: ["S5_gate"],
    meta: { condition: "marginRatioRaw < 1" },
  },
];
const G4_STAGE_CHAIN_EDGES: AtlasEdge[] = [
  { source: "value:rhoSource", target: "value:lhs_Jm3", kind: "causal", sourceSystem: "g4-stage-chain" },
  { source: "value:lhs_Jm3", target: "value:boundComputed_Jm3", kind: "causal", sourceSystem: "g4-stage-chain" },
  { source: "value:boundComputed_Jm3", target: "value:boundUsed_Jm3", kind: "causal", sourceSystem: "g4-stage-chain" },
  { source: "value:boundUsed_Jm3", target: "value:marginRatioRaw", kind: "causal", sourceSystem: "g4-stage-chain" },
  { source: "value:marginRatioRaw", target: "gate:G4_QI_margin", kind: "causal", sourceSystem: "g4-stage-chain" },
];

const stableSort = <T>(rows: T[], by: (row: T) => string): T[] => [...rows].sort((a, b) => by(a).localeCompare(by(b)));

const addNode = (nodes: Map<string, AtlasNode>, node: AtlasNode) => {
  if (nodes.has(node.id)) return;
  nodes.set(node.id, node);
};

const addEdge = (edges: Map<string, AtlasEdge>, edge: AtlasEdge) => {
  const key = `${edge.source}|${edge.target}|${edge.kind}|${edge.sourceSystem}`;
  if (edges.has(key)) return;
  edges.set(key, edge);
};

const normalizeEdgeKind = (kind: string): AtlasEdgeKind => {
  if (
    kind === "imports" ||
    kind === "defines" ||
    kind === "mentions" ||
    kind === "tests" ||
    kind === "use" ||
    kind === "doc-ref" ||
    kind === "command-ref"
  ) {
    return kind;
  }
  return "causal";
};

const normalizeRepoPath = (value: string): string =>
  value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .trim();

const isScriptOrDocSourcePath = (value: string): boolean => {
  const normalized = normalizeRepoPath(value).toLowerCase();
  return SOURCE_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
};

const classifyAtlasPathKind = (value: string): "scripts" | "docs" | "runtime" | "configs" | "other" => {
  const normalized = normalizeRepoPath(value).toLowerCase();
  if (normalized.startsWith("scripts/")) return "scripts";
  if (normalized.startsWith("docs/")) return "docs";
  if (
    normalized.startsWith("server/") ||
    normalized.startsWith("modules/") ||
    normalized.startsWith("client/") ||
    normalized.startsWith("shared/")
  ) {
    return "runtime";
  }
  if (normalized.startsWith("configs/")) return "configs";
  return "other";
};

const collectWorkspaceSourcePaths = (prefixes: readonly string[]): string[] => {
  const out = new Set<string>();
  const stack: string[] = [];
  for (const prefix of prefixes) {
    const normalizedPrefix = normalizeRepoPath(prefix);
    if (!normalizedPrefix) continue;
    const absolute = path.resolve(process.cwd(), normalizedPrefix);
    if (!fsSync.existsSync(absolute)) continue;
    stack.push(absolute);
  }
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let stat: fsSync.Stats;
    try {
      stat = fsSync.statSync(current);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = fsSync.readdirSync(current);
      } catch {
        continue;
      }
      entries.sort((a, b) => a.localeCompare(b));
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (!entry) continue;
        if (entry.startsWith(".") && entry !== ".github") continue;
        stack.push(path.join(current, entry));
      }
      continue;
    }
    if (!stat.isFile()) continue;
    const relativePath = normalizeRepoPath(path.relative(process.cwd(), current));
    if (!relativePath || !isScriptOrDocSourcePath(relativePath)) continue;
    const extension = path.extname(relativePath).toLowerCase();
    if (extension && !SOURCE_SCAN_ALLOWED_EXTENSIONS.has(extension)) continue;
    out.add(relativePath);
  }
  return stableSort([...out], (entry) => entry);
};

const sanitizeReferenceValue = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return "";
  if (trimmed.startsWith("mailto:")) return "";
  if (trimmed.startsWith("<")) return "";
  const withoutAnchor = trimmed.split("#")[0] ?? "";
  const withoutQuery = withoutAnchor.split("?")[0] ?? "";
  return withoutQuery.trim();
};

const hasKnownExtension = (candidate: string): boolean => path.extname(candidate).length > 0;

const addExpandedPathCandidates = (candidate: string, out: Set<string>) => {
  const normalized = normalizeRepoPath(candidate);
  if (!normalized) return;
  out.add(normalized);
  if (hasKnownExtension(normalized)) return;
  for (const ext of PATH_REF_EXTENSIONS) {
    out.add(`${normalized}${ext}`);
    out.add(`${normalized}/index${ext}`);
  }
};

const buildReferenceCandidates = (reference: string, sourcePath: string): string[] => {
  const cleaned = sanitizeReferenceValue(reference);
  if (!cleaned) return [];
  const normalizedRef = normalizeRepoPath(cleaned);
  const candidates = new Set<string>();
  if (cleaned.startsWith("./") || cleaned.startsWith("../")) {
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), cleaned));
    addExpandedPathCandidates(joined, candidates);
  }
  if (!cleaned.startsWith(".")) {
    addExpandedPathCandidates(normalizedRef, candidates);
  }
  if (cleaned.startsWith("/")) {
    addExpandedPathCandidates(normalizedRef.replace(/^\/+/, ""), candidates);
  }
  return Array.from(candidates);
};

const readPackageScriptCommandMap = (): Map<string, string[]> => {
  if (packageScriptCommandMapCache) return packageScriptCommandMapCache;
  const out = new Map<string, string[]>();
  try {
    const packagePath = path.resolve(process.cwd(), "package.json");
    const raw = fsSync.readFileSync(packagePath, "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
      if (!name || typeof command !== "string") continue;
      const refs = new Set<string>();
      COMMAND_TARGET_REGEX.lastIndex = 0;
      for (const match of command.matchAll(COMMAND_TARGET_REGEX)) {
        const value = sanitizeReferenceValue(match[1] ?? "");
        if (!value) continue;
        if (value.includes("scripts/")) {
          refs.add(normalizeRepoPath(value));
        }
      }
      out.set(name.trim(), Array.from(refs));
    }
  } catch {
    // Keep atlas build deterministic without package script mapping.
  }
  packageScriptCommandMapCache = out;
  return out;
};

const resolveAtlasReferencePath = (
  reference: string,
  sourcePath: string,
  knownByNormalizedPath: Map<string, string>,
  knownByBaseName: Map<string, string[]>,
): string | null => {
  const candidates = buildReferenceCandidates(reference, sourcePath);
  for (const candidate of candidates) {
    const hit = knownByNormalizedPath.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  const cleaned = sanitizeReferenceValue(reference);
  if (!cleaned) return null;
  const baseName = path.posix.basename(cleaned).toLowerCase();
  if (!baseName) return null;
  const baseMatches = knownByBaseName.get(baseName) ?? [];
  if (baseMatches.length === 1) return baseMatches[0];
  return null;
};

const collectScriptDocReferenceEdges = (sources: AtlasSources): AtlasEdge[] => {
  const knownPaths = new Set<string>();
  for (const node of sources.repoGraph.nodes) {
    if (typeof node.path === "string" && node.path.trim()) {
      knownPaths.add(normalizeRepoPath(node.path));
    }
  }
  for (const entry of sources.repoIndex) {
    if (entry.source?.path) {
      knownPaths.add(normalizeRepoPath(entry.source.path));
    }
  }
  for (const node of sources.codeLattice.nodes) {
    if (node.filePath) {
      knownPaths.add(normalizeRepoPath(node.filePath));
    }
  }
  for (const sourcePath of collectWorkspaceSourcePaths(SOURCE_PATH_PREFIXES)) {
    knownPaths.add(sourcePath);
  }

  const knownByNormalizedPath = new Map<string, string>();
  const knownByBaseName = new Map<string, string[]>();
  for (const filePath of knownPaths) {
    const normalized = normalizeRepoPath(filePath);
    if (!normalized) continue;
    knownByNormalizedPath.set(normalized.toLowerCase(), normalized);
    const baseName = path.posix.basename(normalized).toLowerCase();
    if (!baseName) continue;
    const list = knownByBaseName.get(baseName) ?? [];
    list.push(normalized);
    knownByBaseName.set(baseName, list);
  }

  const edges = new Map<string, AtlasEdge>();
  const scriptMap = readPackageScriptCommandMap();
  const sourcePaths = Array.from(knownPaths)
    .filter((entry) => isScriptOrDocSourcePath(entry))
    .sort((a, b) => a.localeCompare(b));

  for (const sourcePath of sourcePaths) {
    const absolutePath = path.resolve(process.cwd(), sourcePath);
    if (!fsSync.existsSync(absolutePath)) continue;
    let contents = "";
    try {
      contents = fsSync.readFileSync(absolutePath, "utf8");
    } catch {
      continue;
    }
    if (!contents.trim()) continue;

    const addDeterministicEdge = (targetPath: string, kind: AtlasEdgeKind, reference: string) => {
      if (!targetPath || targetPath === sourcePath) return;
      addEdge(edges, {
        source: `file:${sourcePath}`,
        target: `file:${targetPath}`,
        kind,
        sourceSystem: SCRIPT_DOC_REF_SOURCE_SYSTEM,
        meta: {
          reference: reference.slice(0, 200),
          sourceKind: classifyAtlasPathKind(sourcePath),
          targetKind: classifyAtlasPathKind(targetPath),
        },
      });
    };

    IMPORT_REF_REGEX.lastIndex = 0;
    for (const match of contents.matchAll(IMPORT_REF_REGEX)) {
      const reference = sanitizeReferenceValue(match[2] ?? "");
      if (!reference) continue;
      const targetPath = resolveAtlasReferencePath(reference, sourcePath, knownByNormalizedPath, knownByBaseName);
      if (!targetPath) continue;
      addDeterministicEdge(targetPath, "imports", reference);
    }

    GENERIC_PATH_REF_REGEX.lastIndex = 0;
    for (const match of contents.matchAll(GENERIC_PATH_REF_REGEX)) {
      const reference = sanitizeReferenceValue(match[1] ?? "");
      if (!reference) continue;
      const targetPath = resolveAtlasReferencePath(reference, sourcePath, knownByNormalizedPath, knownByBaseName);
      if (!targetPath) continue;
      addDeterministicEdge(targetPath, "use", reference);
    }

    if (sourcePath.startsWith("docs/")) {
      MARKDOWN_LINK_REGEX.lastIndex = 0;
      for (const match of contents.matchAll(MARKDOWN_LINK_REGEX)) {
        const reference = sanitizeReferenceValue(match[1] ?? "");
        if (!reference) continue;
        const targetPath = resolveAtlasReferencePath(reference, sourcePath, knownByNormalizedPath, knownByBaseName);
        if (!targetPath) continue;
        const kind: AtlasEdgeKind = /\.(md|mdx)$/i.test(targetPath) ? "doc-ref" : "use";
        addDeterministicEdge(targetPath, kind, reference);
      }
    }

    COMMAND_TARGET_REGEX.lastIndex = 0;
    for (const match of contents.matchAll(COMMAND_TARGET_REGEX)) {
      const reference = sanitizeReferenceValue(match[1] ?? "");
      if (!reference) continue;
      const targetPath = resolveAtlasReferencePath(reference, sourcePath, knownByNormalizedPath, knownByBaseName);
      if (!targetPath) continue;
      addDeterministicEdge(targetPath, "command-ref", reference);
    }

    NPM_RUN_REGEX.lastIndex = 0;
    for (const match of contents.matchAll(NPM_RUN_REGEX)) {
      const scriptName = (match[1] ?? "").trim();
      if (!scriptName) continue;
      for (const reference of scriptMap.get(scriptName) ?? []) {
        const targetPath = resolveAtlasReferencePath(reference, sourcePath, knownByNormalizedPath, knownByBaseName);
        if (!targetPath) continue;
        addDeterministicEdge(targetPath, "command-ref", `npm run ${scriptName}`);
      }
    }
  }

  return stableSort([...edges.values()], (edge) => `${edge.kind}|${edge.source}|${edge.target}|${edge.sourceSystem}`);
};

const readStageHints = (meta: unknown): string[] => {
  const text =
    meta == null
      ? ""
      : typeof meta === "string"
      ? meta
      : JSON.stringify(meta);
  const normalized = text.toLowerCase();
  const hints = new Set<string>();
  for (const field of STAGE_HINT_FIELDS) {
    if (meta && typeof meta === "object" && field in (meta as Record<string, unknown>)) {
      hints.add(field);
      continue;
    }
    for (const token of STAGE_HINT_VOCABULARY[field] ?? []) {
      if (normalized.includes(token)) {
        hints.add(field);
        break;
      }
    }
  }
  return Array.from(hints).sort((a, b) => a.localeCompare(b));
};

const mergeStageHints = (...collections: Array<string[] | undefined>): string[] | undefined => {
  const hints = new Set<string>();
  for (const collection of collections) {
    for (const hint of collection ?? []) {
      if (hint) hints.add(hint);
    }
  }
  if (hints.size === 0) return undefined;
  return Array.from(hints).sort((a, b) => a.localeCompare(b));
};

const addTreeDagWalkGraph = (
  nodes: Map<string, AtlasNode>,
  edges: Map<string, AtlasEdge>,
  report: TreeDagWalkReport | null | undefined,
) => {
  if (!report || !Array.isArray(report.visited)) return;

  for (const visited of report.visited) {
    const visitedId = typeof visited.id === "string" ? visited.id : null;
    if (!visitedId) continue;
    addNode(nodes, {
      id: `tree:${visitedId}`,
      kind: "concept",
      label: visitedId,
      source: "warp-tree-dag-walk",
      meta: { depth: visited.depth ?? null },
      stageHints: readStageHints(visited),
    });

    const via = visited.via;
    if (!via || typeof via !== "object") continue;
    const sourceId = typeof via.source === "string" ? via.source : null;
    const targetId = typeof via.target === "string" ? via.target : null;
    if (!sourceId || !targetId) continue;

    addNode(nodes, {
      id: `tree:${sourceId}`,
      kind: "concept",
      label: sourceId,
      source: "warp-tree-dag-walk",
      stageHints: readStageHints(via),
    });
    addNode(nodes, {
      id: `tree:${targetId}`,
      kind: "concept",
      label: targetId,
      source: "warp-tree-dag-walk",
      stageHints: readStageHints(via),
    });
    addEdge(edges, {
      source: `tree:${sourceId}`,
      target: `tree:${targetId}`,
      kind: "causal",
      sourceSystem: "warp-tree-dag-walk",
      meta: {
        edgeType: typeof via.edgeType === "string" ? via.edgeType : null,
        requiresCL: typeof via.requiresCL === "string" ? via.requiresCL : null,
        condition: typeof via.condition === "string" ? via.condition : via.condition ?? null,
        chartDependency: typeof via.chartDependency === "string" ? via.chartDependency : via.chartDependency ?? null,
        note: typeof via.note === "string" ? via.note : via.note ?? null,
      },
    });
  }
};

const addLinkedGraphEdges = (
  nodes: Map<string, AtlasNode>,
  edges: Map<string, AtlasEdge>,
  graph: IdeologyGraph | null | undefined,
  prefix: string,
  sourceSystem: string,
) => {
  const graphNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  for (const graphNode of graphNodes) {
    const sourceRef = typeof graphNode.id === "string" ? graphNode.id.trim() : "";
    if (!sourceRef) continue;
    const sourceId = `index:${prefix}:${sourceRef}`;
    if (!nodes.has(sourceId)) continue;
    const links = Array.isArray(graphNode.links) ? graphNode.links : [];
    for (const link of links) {
      const targetRef = typeof link?.to === "string" ? link.to.trim() : "";
      if (!targetRef || targetRef === sourceRef) continue;
      const targetId = `index:${prefix}:${targetRef}`;
      if (!nodes.has(targetId)) continue;
      addEdge(edges, {
        source: sourceId,
        target: targetId,
        kind: "causal",
        sourceSystem,
        meta: { rel: typeof link.rel === "string" ? link.rel : "related" },
      });
    }
  }
};

export const buildRepoAtlasFromSources = (sources: AtlasSources): RepoAtlas => {
  const nodes = new Map<string, AtlasNode>();
  const edges = new Map<string, AtlasEdge>();

  for (const node of G4_STAGE_CHAIN_NODES) addNode(nodes, node);
  for (const edge of G4_STAGE_CHAIN_EDGES) addEdge(edges, edge);

  for (const entry of sources.repoIndex) {
    const pathRef = entry.source?.path;
    const nodeId = `index:${entry.id}`;
    const kind: AtlasNodeKind = entry.kind === "artifact" ? "value" : pathRef ? "file" : "concept";
    const stageHints = readStageHints({
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      body: entry.body,
      source: entry.source,
      tags: entry.tags,
    });
    addNode(nodes, {
      id: nodeId,
      kind,
      label: entry.title,
      path: pathRef,
      source: "repo-index",
      stageHints: stageHints.length > 0 ? stageHints : undefined,
      meta: { entryKind: entry.kind, tags: entry.tags ?? [] },
    });
    if (pathRef) {
      const fileId = `file:${pathRef}`;
      addNode(nodes, {
        id: fileId,
        kind: "file",
        label: path.basename(pathRef),
        path: pathRef,
        source: "repo-index",
        stageHints: stageHints.length > 0 ? stageHints : undefined,
      });
      addEdge(edges, { source: nodeId, target: fileId, kind: "mentions", sourceSystem: "repo-index" });
    }
  }

  addLinkedGraphEdges(nodes, edges, sources.ideology, "ideology", "ideology-links");
  addLinkedGraphEdges(
    nodes,
    edges,
    sources.scientificMethodPolicy,
    "scientific-method-policy",
    "scientific-method-policy-links",
  );

  for (const node of sources.repoGraph.nodes) {
    const nodeId = node.kind === "file" && node.path ? `file:${node.path}` : `graph:${node.id}`;
    const stageHints = readStageHints({ ...node, id: node.id });
    const existing = nodes.get(nodeId);
    addNode(nodes, {
      id: nodeId,
      kind: node.kind,
      label: node.name,
      path: node.path,
      source: "repo-graph",
      stageHints: mergeStageHints(existing?.stageHints, stageHints),
      meta: { tags: node.tags ?? [] },
    });
  }

  for (const edge of sources.repoGraph.edges) {
    const sourceId = edge.source.includes("/") ? `file:${edge.source}` : `graph:${edge.source}`;
    const targetId = edge.target.includes("/") ? `file:${edge.target}` : `graph:${edge.target}`;
    addEdge(edges, {
      source: sourceId,
      target: targetId,
      kind: normalizeEdgeKind(edge.kind),
      sourceSystem: "repo-graph",
      meta: edge.citation_context ? { citationContext: edge.citation_context } : undefined,
    });
  }

  for (const node of sources.codeLattice.nodes) {
    const nodeId = `lattice:${node.nodeId}`;
    const stageHints = readStageHints({
      nodeId: node.nodeId,
      symbol: node.symbol,
      doc: node.doc,
      signature: node.signature,
      metrics: node.metrics,
      tags: node.tags,
    });
    addNode(nodes, {
      id: nodeId,
      kind: node.kind === "test" ? "gate" : "symbol",
      label: node.symbol,
      path: node.filePath,
      source: "code-lattice",
      stageHints: stageHints.length > 0 ? stageHints : undefined,
      meta: { resonanceKind: node.resonanceKind, kind: node.kind },
    });

    if (node.filePath) {
      const fileId = `file:${node.filePath}`;
      addNode(nodes, {
        id: fileId,
        kind: "file",
        label: path.basename(node.filePath),
        path: node.filePath,
        source: "code-lattice",
      });
      addEdge(edges, { source: nodeId, target: fileId, kind: "defines", sourceSystem: "code-lattice" });
    }
  }

  for (const edge of sources.codeLattice.edges) {
    addEdge(edges, {
      source: `lattice:${edge.from}`,
      target: `lattice:${edge.to}`,
      kind: normalizeEdgeKind(edge.kind),
      sourceSystem: "code-lattice",
      meta: edge.label ? { label: edge.label } : undefined,
    });
  }

  const scriptDocEdges = collectScriptDocReferenceEdges(sources);
  for (const edge of scriptDocEdges) {
    const sourcePath = edge.source.replace(/^file:/, "");
    const targetPath = edge.target.replace(/^file:/, "");
    if (sourcePath) {
      addNode(nodes, {
        id: edge.source,
        kind: "file",
        label: path.basename(sourcePath),
        path: sourcePath,
        source: SCRIPT_DOC_REF_SOURCE_SYSTEM,
      });
    }
    if (targetPath) {
      addNode(nodes, {
        id: edge.target,
        kind: "file",
        label: path.basename(targetPath),
        path: targetPath,
        source: SCRIPT_DOC_REF_SOURCE_SYSTEM,
      });
    }
    addEdge(edges, edge);
  }

  addTreeDagWalkGraph(nodes, edges, sources.treeDagWalk);

  return {
    version: "repo-atlas/1",
    snapshot: {
      generatedAt: sources.generatedAt,
      commitHash: sources.commitHash,
      repoGraphBuiltAt: sources.repoGraph.builtAt,
      treeDagWalkLoaded: Array.isArray(sources.treeDagWalk?.visited),
    },
    nodes: stableSort([...nodes.values()], (row) => `${row.kind}|${row.id}`),
    edges: stableSort([...edges.values()], (row) => `${row.kind}|${row.source}|${row.target}|${row.sourceSystem}`),
  };
};

const resolveCommitHash = async (): Promise<string> => {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: process.cwd() });
    return stdout.trim();
  } catch {
    return "unknown";
  }
};

const readTreeDagWalkReport = async (reportPath = DEFAULT_TREE_DAG_WALK_REPORT_PATH): Promise<TreeDagWalkReport | null> => {
  try {
    const raw = await fs.readFile(reportPath, "utf8");
    const parsed = JSON.parse(raw) as TreeDagWalkReport;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const readIdeologyGraph = async (ideologyPath = DEFAULT_IDEOLOGY_PATH): Promise<IdeologyGraph | null> => {
  try {
    const raw = await fs.readFile(ideologyPath, "utf8");
    const parsed = JSON.parse(raw) as IdeologyGraph;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const readScientificMethodPolicyGraph = async (
  policyPath = DEFAULT_SCIENTIFIC_METHOD_POLICY_PATH,
): Promise<IdeologyGraph | null> => {
  try {
    const raw = await fs.readFile(policyPath, "utf8");
    const parsed = JSON.parse(raw) as IdeologyGraph;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

async function main() {
  const generatedAt = new Date().toISOString();
  const commitHash = await resolveCommitHash();
  const [repoIndex, repoGraph, codeLattice, treeDagWalk, ideology, scientificMethodPolicy] = await Promise.all([
    getRepoSearchIndex(),
    getRepoGraphSnapshot(),
    buildCodeLatticeSnapshot().then((row) => row.snapshot),
    readTreeDagWalkReport(),
    readIdeologyGraph(),
    readScientificMethodPolicyGraph(),
  ]);

  const atlas = buildRepoAtlasFromSources({
    generatedAt,
    commitHash,
    repoIndex,
    repoGraph,
    codeLattice,
    treeDagWalk,
    ideology,
    scientificMethodPolicy,
  });
  const outPath = DEFAULT_ATLAS_PATH;
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(atlas, null, 2));
  console.log(`[repo-atlas] wrote ${atlas.nodes.length} nodes and ${atlas.edges.length} edges to ${path.relative(process.cwd(), outPath)}`);
}

export const isDirectExecution = (importMetaUrl: string, argvPath = process.argv[1]): boolean => {
  if (!argvPath) return false;
  return importMetaUrl === pathToFileURL(path.resolve(argvPath)).href;
};

if (isDirectExecution(import.meta.url)) {
  void main();
}
