import fs from "node:fs";
import path from "node:path";
import {
  mathStageRegistry,
  type MathCheck,
  type MathStageEntry,
} from "../shared/math-stage.js";

type MathGraphEdge = {
  from: string;
  to: string;
  reason?: string;
  waiver?: string;
};

type TraceRoot = {
  key: string;
  module: string;
  label: string;
};

const TRACE_ROOTS: TraceRoot[] = [
  { key: "gr", module: "server/gr/gr-agent-loop.ts", label: "GR loop" },
];

const registryByModule = new Map(
  mathStageRegistry.map((entry) => [entry.module, entry]),
);

const formatChecks = (checks?: MathCheck[]) => {
  if (!checks || checks.length === 0) return "none";
  return checks.map((check) => `${check.type}:${check.path}`).join(", ");
};

const loadGraph = (): { edges: MathGraphEdge[] } => {
  const graphPath = path.resolve(process.cwd(), "MATH_GRAPH.json");
  if (!fs.existsSync(graphPath)) {
    throw new Error("Missing MATH_GRAPH.json; cannot build trace.");
  }
  const raw = fs.readFileSync(graphPath, "utf8");
  const parsed = JSON.parse(raw) as { edges?: MathGraphEdge[] };
  return { edges: Array.isArray(parsed.edges) ? parsed.edges : [] };
};

const buildAdjacency = (edges: MathGraphEdge[]) => {
  const adjacency = new Map<string, MathGraphEdge[]>();
  for (const edge of edges) {
    if (!edge?.from || !edge?.to) continue;
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge);
    adjacency.set(edge.from, list);
  }
  return adjacency;
};

const renderEntry = (
  entry: MathStageEntry | undefined,
  module: string,
  depth: number,
  edge?: MathGraphEdge,
) => {
  const indent = "  ".repeat(depth);
  const stage = entry?.stage ?? "unregistered";
  const tag = entry?.tag ? ` | ${entry.tag}` : "";
  console.log(`${indent}- ${module} [${stage}${tag}]`);
  const detailIndent = `${indent}  `;
  console.log(`${detailIndent}checks: ${formatChecks(entry?.checks)}`);
  if (edge?.reason) console.log(`${detailIndent}reason: ${edge.reason}`);
  if (edge?.waiver) console.log(`${detailIndent}waiver: ${edge.waiver}`);
};

const traceFromRoot = (
  rootModule: string,
  adjacency: Map<string, MathGraphEdge[]>,
) => {
  const walk = (
    module: string,
    depth: number,
    edge: MathGraphEdge | undefined,
    path: Set<string>,
  ) => {
    if (path.has(module)) {
      const indent = "  ".repeat(depth);
      console.log(`${indent}- ${module} [cycle detected]`);
      return;
    }
    renderEntry(registryByModule.get(module), module, depth, edge);
    const nextPath = new Set(path);
    nextPath.add(module);
    const edges = adjacency.get(module) ?? [];
    for (const nextEdge of edges) {
      walk(nextEdge.to, depth + 1, nextEdge, nextPath);
    }
  };

  walk(rootModule, 0, undefined, new Set());
};

const renderUsage = () => {
  const roots = TRACE_ROOTS.map((root) => `- ${root.key}: ${root.label}`).join(
    "\n",
  );
  console.log("Usage: npm run math:trace -- <root>");
  console.log("");
  console.log("Roots:");
  console.log(roots);
  console.log("");
  console.log("Or pass a module path directly (e.g., server/gr/gr-agent-loop.ts).");
};

const main = () => {
  const args = process.argv.slice(2);
  const target = args.find((arg) => !arg.startsWith("-"));
  if (!target) {
    renderUsage();
    process.exitCode = 1;
    return;
  }

  const preset = TRACE_ROOTS.find((root) => root.key === target);
  const rootModule =
    preset?.module ?? (target.endsWith(".ts") ? target : undefined);
  if (!rootModule) {
    console.error(`Unknown trace root: ${target}`);
    renderUsage();
    process.exitCode = 1;
    return;
  }

  const graph = loadGraph();
  const adjacency = buildAdjacency(graph.edges);
  console.log(`Math trace: ${preset?.label ?? target}`);
  console.log(`Root: ${rootModule}`);
  console.log("");
  traceFromRoot(rootModule, adjacency);
};

main();
