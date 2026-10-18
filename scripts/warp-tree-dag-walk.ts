import fs from "node:fs";
import path from "node:path";

type WalkConfig = {
  allowedCL: "CL0" | "CL1" | "CL2" | "CL3" | "CL4";
  allowConceptual?: boolean;
  allowProxies?: boolean;
  chart?: string | null;
  region?: Record<string, boolean>;
  seedOrder?: "lex";
  walkMode?: "bfs" | "dfs";
};

type TreeNode = {
  id: string;
  children?: string[];
  links?: Array<string | Link>;
  childMeta?: Record<string, EdgeMeta>;
  blockedLinks?: Array<BlockedEdge>;
};

type Link = {
  rel?: string;
  to: string;
  edgeType?: string;
  requiresCL?: string;
  condition?: string | null;
  chartDependency?: string | null;
  note?: string;
};

type EdgeMeta = {
  edgeType?: string;
  requiresCL?: string;
  condition?: string | null;
  chartDependency?: string | null;
  proxy?: boolean | null;
};

type BlockedEdge = {
  source: string;
  target: string;
  edgeType?: string;
  requiresCL?: string;
  reason?: string;
};

type Edge = {
  source: string;
  target: string;
  edgeType: string;
  requiresCL: string;
  condition?: string | null;
  chartDependency?: string | null;
  note?: string;
};

type FilterReason =
  | "blocked_link"
  | "conceptual_disallowed"
  | "proxy_disallowed"
  | "cl_exceeds_allowed"
  | "chart_mismatch"
  | "condition_unsatisfied";

type EdgeDecision = {
  allowed: boolean;
  reason?: FilterReason;
  condition?: string | null;
  conditionKey?: string | null;
};

const DEFAULT_TREES = [
  "docs/knowledge/warp/warp-mechanics-tree.json",
  "docs/knowledge/warp/needle-hull-mark2-theory-tree.json",
  "docs/knowledge/physics/physics-foundations-tree.json",
  "docs/knowledge/physics/brick-lattice-dataflow-tree.json",
  "docs/knowledge/physics/math-tree.json",
  "docs/knowledge/physics/gr-solver-tree.json",
  "docs/knowledge/physics/simulation-systems-tree.json",
  "docs/knowledge/physics/uncertainty-mechanics-tree.json",
  "docs/knowledge/panel-concepts-tree.json",
  "docs/knowledge/panel-registry-tree.json",
  "docs/knowledge/resonance-tree.json",
];

const CL_ORDER = ["CL0", "CL1", "CL2", "CL3", "CL4"];

const toCLIndex = (value: string | undefined): number => {
  if (!value || value === "none") return -1;
  const idx = CL_ORDER.indexOf(value);
  return idx >= 0 ? idx : -1;
};

const readJson = <T>(filePath: string): T => {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
};

const parseArg = (name: string): string | undefined => {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
};

const normalizeConditionKey = (condition: string): string => condition
    .replace(/\s+/g, "")
    .replace(/=+/g, "_equals_")
    .replace(/[()]/g, "");

const conditionSatisfied = (
  condition: string | null | undefined,
  region?: Record<string, boolean>,
): { ok: boolean; key?: string | null } => {
  if (!condition) return { ok: true };
  if (!region) return { ok: false, key: null };
  if (condition.includes("B(r)=1") || condition.includes("B=1")) {
    return { ok: Boolean(region.B_equals_1 === true), key: "B_equals_1" };
  }
  const key = normalizeConditionKey(condition);
  return { ok: Boolean(region[key] === true), key };
};

const evaluateEdge = (
  edge: Edge,
  config: WalkConfig,
  blockedSet: Set<string>,
): EdgeDecision => {
  const key = `${edge.source}::${edge.target}`;
  if (blockedSet.has(key)) {
    return { allowed: false, reason: "blocked_link" };
  }

  const edgeType = edge.edgeType || "association";
  if (edgeType === "hierarchy" || edgeType === "association") {
    return config.allowConceptual
      ? { allowed: true }
      : { allowed: false, reason: "conceptual_disallowed" };
  }

  if (edgeType === "proxy_only") {
    return config.allowProxies
      ? { allowed: true }
      : { allowed: false, reason: "proxy_disallowed" };
  }

  const requiredIdx = toCLIndex(edge.requiresCL);
  const allowedIdx = toCLIndex(config.allowedCL);
  if (requiredIdx > allowedIdx) {
    return { allowed: false, reason: "cl_exceeds_allowed" };
  }

  if (edge.chartDependency && config.chart && edge.chartDependency !== config.chart) {
    return { allowed: false, reason: "chart_mismatch" };
  }

  const conditionCheck = conditionSatisfied(edge.condition, config.region);
  if (!conditionCheck.ok) {
    return {
      allowed: false,
      reason: "condition_unsatisfied",
      condition: edge.condition ?? null,
      conditionKey: conditionCheck.key ?? null,
    };
  }

  return { allowed: true };
};

const buildEdges = (nodes: TreeNode[]): Edge[] => {
  const edges: Edge[] = [];
  for (const node of nodes) {
    const source = node.id;

    for (const child of node.children ?? []) {
      const meta = node.childMeta?.[child];
      edges.push({
        source,
        target: child,
        edgeType: meta?.edgeType ?? "hierarchy",
        requiresCL: meta?.requiresCL ?? "none",
        condition: meta?.condition ?? null,
        chartDependency: meta?.chartDependency ?? null,
      });
    }

    for (const link of node.links ?? []) {
      const obj = typeof link === "string" ? ({ to: link } as Link) : link;
      if (!obj.to) continue;
      const rel = obj.rel ?? "link";
      edges.push({
        source,
        target: obj.to,
        edgeType: obj.edgeType ?? (rel === "parent" ? "hierarchy" : "association"),
        requiresCL: obj.requiresCL ?? "none",
        condition: obj.condition ?? null,
        chartDependency: obj.chartDependency ?? null,
        note: obj.note,
      });
    }
  }
  return edges;
};

const main = () => {
  const configPath = parseArg("--config") ?? "docs/warp-tree-dag-walk-config.json";
  const config = readJson<WalkConfig>(configPath);
  const treesArg = parseArg("--trees");
  const startArg = parseArg("--start");
  const outPath = parseArg("--out");

  const treeFiles = treesArg ? treesArg.split(",").map((p) => p.trim()) : DEFAULT_TREES;
  const nodes: TreeNode[] = [];
  const rootIds: string[] = [];

  for (const treeFile of treeFiles) {
    const fullPath = path.resolve(treeFile);
    const data = readJson<{ nodes?: TreeNode[]; rootId?: string }>(fullPath);
    if (data.rootId) rootIds.push(data.rootId);
    if (Array.isArray(data.nodes)) nodes.push(...data.nodes);
  }

  const edges = buildEdges(nodes);
  const blockedSet = new Set<string>();
  for (const node of nodes) {
    for (const blocked of node.blockedLinks ?? []) {
      blockedSet.add(`${blocked.source}::${blocked.target}`);
    }
  }

  const adjacency = new Map<string, Edge[]>();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source)!.push(edge);
  }

  const startNodes = startArg ? startArg.split(",").map((s) => s.trim()) : rootIds;
  const walkMode = config.walkMode ?? "bfs";
  const seedOrder = config.seedOrder ?? "lex";
  const blockedByReasonGlobal: Record<FilterReason, number> = {
    blocked_link: 0,
    conceptual_disallowed: 0,
    proxy_disallowed: 0,
    cl_exceeds_allowed: 0,
    chart_mismatch: 0,
    condition_unsatisfied: 0,
  };
  const blockedByConditionGlobal: Record<string, number> = {};
  const blockedSamplesGlobal: Array<{
    source: string;
    target: string;
    edgeType: string;
    requiresCL: string;
    reason: FilterReason;
    condition?: string | null;
    conditionKey?: string | null;
    chartDependency?: string | null;
  }> = [];
  let globallyAllowedEdges = 0;
  let globallyBlockedEdges = 0;

  for (const edge of edges) {
    const decision = evaluateEdge(edge, config, blockedSet);
    if (decision.allowed) {
      globallyAllowedEdges += 1;
      continue;
    }
    globallyBlockedEdges += 1;
    if (decision.reason) {
      blockedByReasonGlobal[decision.reason] += 1;
    }
    if (decision.reason === "condition_unsatisfied") {
      const key = decision.conditionKey ?? decision.condition ?? "unknown_condition";
      blockedByConditionGlobal[key] = (blockedByConditionGlobal[key] ?? 0) + 1;
    }
    if (blockedSamplesGlobal.length < 60 && decision.reason) {
      blockedSamplesGlobal.push({
        source: edge.source,
        target: edge.target,
        edgeType: edge.edgeType,
        requiresCL: edge.requiresCL,
        reason: decision.reason,
        condition: decision.condition ?? edge.condition ?? null,
        conditionKey: decision.conditionKey ?? null,
        chartDependency: edge.chartDependency ?? null,
      });
    }
  }

  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number; via?: Edge }> = startNodes.map((id) => ({ id, depth: 0 }));
  const results: Array<{ id: string; depth: number; via?: Edge }> = [];
  const blockedByReasonTraversal: Record<FilterReason, number> = {
    blocked_link: 0,
    conceptual_disallowed: 0,
    proxy_disallowed: 0,
    cl_exceeds_allowed: 0,
    chart_mismatch: 0,
    condition_unsatisfied: 0,
  };
  const blockedByConditionTraversal: Record<string, number> = {};
  const blockedSamplesTraversal: Array<{
    source: string;
    target: string;
    edgeType: string;
    requiresCL: string;
    reason: FilterReason;
    condition?: string | null;
    conditionKey?: string | null;
    chartDependency?: string | null;
  }> = [];
  let traversalEvaluatedEdges = 0;
  let traversalAllowedEdges = 0;
  let traversalBlockedEdges = 0;
  let enqueuedEdges = 0;

  while (queue.length) {
    const current = walkMode === "dfs" ? queue.pop()! : queue.shift()!;
    if (!current) break;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    results.push(current);

    const nextEdges: Edge[] = [];
    for (const edge of adjacency.get(current.id) ?? []) {
      traversalEvaluatedEdges += 1;
      const decision = evaluateEdge(edge, config, blockedSet);
      if (decision.allowed) {
        traversalAllowedEdges += 1;
        nextEdges.push(edge);
        continue;
      }
      traversalBlockedEdges += 1;
      if (decision.reason) {
        blockedByReasonTraversal[decision.reason] += 1;
      }
      if (decision.reason === "condition_unsatisfied") {
        const key = decision.conditionKey ?? decision.condition ?? "unknown_condition";
        blockedByConditionTraversal[key] = (blockedByConditionTraversal[key] ?? 0) + 1;
      }
      if (blockedSamplesTraversal.length < 60 && decision.reason) {
        blockedSamplesTraversal.push({
          source: edge.source,
          target: edge.target,
          edgeType: edge.edgeType,
          requiresCL: edge.requiresCL,
          reason: decision.reason,
          condition: decision.condition ?? edge.condition ?? null,
          conditionKey: decision.conditionKey ?? null,
          chartDependency: edge.chartDependency ?? null,
        });
      }
    }
    if (seedOrder === "lex") {
      nextEdges.sort((a, b) => {
        const keyA = `${a.edgeType}:${a.target}`;
        const keyB = `${b.edgeType}:${b.target}`;
        return keyA.localeCompare(keyB);
      });
    }
    for (const edge of nextEdges) {
      if (!visited.has(edge.target)) {
        queue.push({ id: edge.target, depth: current.depth + 1, via: edge });
        enqueuedEdges += 1;
      }
    }
  }

  const output = {
    config,
    startNodes,
    walkMode,
    seedOrder,
    visitedCount: results.length,
    visited: results,
    diagnostics: {
      inventory: {
        nodesCount: nodes.length,
        edgesCount: edges.length,
        blockedLinkCount: blockedSet.size,
      },
      globalFilter: {
        allowedEdges: globallyAllowedEdges,
        blockedEdges: globallyBlockedEdges,
        blockedByReason: blockedByReasonGlobal,
        blockedByCondition: blockedByConditionGlobal,
        blockedSamples: blockedSamplesGlobal,
      },
      traversalFilter: {
        evaluatedEdges: traversalEvaluatedEdges,
        allowedEdges: traversalAllowedEdges,
        blockedEdges: traversalBlockedEdges,
        enqueuedEdges,
        blockedByReason: blockedByReasonTraversal,
        blockedByCondition: blockedByConditionTraversal,
        blockedSamples: blockedSamplesTraversal,
      },
      strictSignals: {
        B_equals_1: config.region?.B_equals_1 === true,
        qi_metric_derived_equals_true: config.region?.qi_metric_derived_equals_true === true,
        qi_strict_ok_equals_true: config.region?.qi_strict_ok_equals_true === true,
        theta_geom_equals_true: config.region?.theta_geom_equals_true === true,
        vdb_two_wall_derivative_support_equals_true:
          config.region?.vdb_two_wall_derivative_support_equals_true === true,
        ts_metric_derived_equals_true: config.region?.ts_metric_derived_equals_true === true,
        cl3_metric_t00_available_equals_true:
          config.region?.cl3_metric_t00_available_equals_true === true,
        cl3_rho_gate_equals_true: config.region?.cl3_rho_gate_equals_true === true,
      },
    },
  };

  const payload = JSON.stringify(output, null, 2);
  if (outPath) {
    fs.writeFileSync(outPath, payload);
  } else {
    process.stdout.write(payload + "\n");
  }
};

main();
