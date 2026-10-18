import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type TreeLink = { rel: string; to: string };

type TreeNode = {
  id: string;
  title?: string;
  nodeType?: string;
  tags?: string[];
  links?: TreeLink[];
  children?: string[];
  evidence?: Array<Record<string, unknown>>;
};

type TreeFile = {
  rootId: string;
  nodes: TreeNode[];
  schema?: { name: string; version: number };
};

type Candidate = { left: string; right: string; reason: string };

type BridgePlan = {
  file: string;
  rootId: string;
  left: string;
  right: string;
  reason: string;
};

const ROOT = process.cwd();
const TREE_DIR = join(ROOT, "docs", "knowledge");
const DEFAULT_PREDICTABILITY = {
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

const walkTrees = (dir: string, acc: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkTrees(full, acc);
      continue;
    }
    if (entry.endsWith("-tree.json")) {
      acc.push(full);
    }
  }
  return acc;
};

const loadTree = (filePath: string): TreeFile =>
  JSON.parse(readFileSync(filePath, "utf8")) as TreeFile;

const hasBridge = (nodes: TreeNode[]): boolean =>
  nodes.some((node) => node.nodeType === "bridge" || (node as any).bridge);

const findCandidate = (tree: TreeFile): Candidate | null => {
  const nodeMap = new Map(tree.nodes.map((node) => [node.id, node]));
  for (const node of tree.nodes) {
    for (const link of node.links ?? []) {
      if (link.rel !== "see-also" && link.rel !== "depends-on") continue;
      if (!nodeMap.has(link.to)) continue;
      if (node.id === link.to) continue;
      return { left: node.id, right: link.to, reason: `link:${link.rel}` };
    }
  }
  const root = nodeMap.get(tree.rootId);
  const children = root?.children ?? [];
  if (children.length >= 2) {
    const left = children[0];
    const right = children.find((child) => child !== left) ?? children[1];
    if (left && right && nodeMap.has(left) && nodeMap.has(right)) {
      return { left, right, reason: "root-children" };
    }
  }
  return null;
};

const cloneWithScope = (entry: Record<string, unknown> | undefined, scope: string) => {
  if (!entry) return null;
  return { ...entry, scope };
};

const makeBridgeNode = (tree: TreeFile, plan: BridgePlan): TreeNode => {
  const nodeMap = new Map(tree.nodes.map((node) => [node.id, node]));
  const leftNode = nodeMap.get(plan.left);
  const rightNode = nodeMap.get(plan.right);
  const leftTitle = leftNode?.title ?? plan.left;
  const rightTitle = rightNode?.title ?? plan.right;
  const idBase = `bridge-${plan.left}-${plan.right}`.replace(/[^a-z0-9\-]/gi, "-");
  let id = idBase;
  const ids = new Set(nodeMap.keys());
  let suffix = 2;
  while (ids.has(id)) {
    id = `${idBase}-${suffix}`;
    suffix += 1;
  }

  const leftEvidence = cloneWithScope(leftNode?.evidence?.[0] as Record<string, unknown>, "left");
  const rightEvidence = cloneWithScope(rightNode?.evidence?.[0] as Record<string, unknown>, "right");
  const evidence = [leftEvidence, rightEvidence].filter(Boolean) as Record<string, unknown>[];

  return {
    id,
    title: `${leftTitle} <-> ${rightTitle} Bridge`,
    excerpt: `Bridge between ${leftTitle} and ${rightTitle}.`,
    bodyMD: `Cross-reference between ${leftTitle} and ${rightTitle} within this tree.\n\nMinimal artifact: left/right evidence anchors.`,
    tags: Array.from(new Set(["bridge", ...(leftNode?.tags ?? []), ...(rightNode?.tags ?? [])])).slice(0, 8),
    nodeType: "bridge",
    links: [
      { rel: "parent", to: plan.rootId },
      { rel: "see-also", to: plan.left },
      { rel: "see-also", to: plan.right },
    ],
    bridge: {
      left: plan.left,
      right: plan.right,
      relation: `Cross-reference between ${leftTitle} and ${rightTitle}.`,
    },
    inputs: [],
    outputs: [],
    assumptions: [],
    validity: {},
    deterministic: null,
    tolerance: null,
    environment: null,
    dependencies: [plan.left, plan.right],
    predictability: DEFAULT_PREDICTABILITY,
    evidence,
  } as TreeNode;
};

const applyBridge = (filePath: string, tree: TreeFile, plan: BridgePlan) => {
  const nodeMap = new Map(tree.nodes.map((node) => [node.id, node]));
  const root = nodeMap.get(plan.rootId);
  if (!root) return false;
  const bridgeNode = makeBridgeNode(tree, plan);
  tree.nodes.push(bridgeNode);
  if (Array.isArray(root.children) && !root.children.includes(bridgeNode.id)) {
    root.children.push(bridgeNode.id);
  }
  writeFileSync(filePath, JSON.stringify(tree, null, 2) + "\n", "utf8");
  return true;
};

const main = () => {
  const files = walkTrees(TREE_DIR);
  const updated: BridgePlan[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const tree = loadTree(file);
    if (!tree?.nodes?.length || !tree.rootId) {
      skipped.push(file);
      continue;
    }
    if (hasBridge(tree.nodes)) {
      continue;
    }
    const candidate = findCandidate(tree);
    if (!candidate) {
      skipped.push(file);
      continue;
    }
    const plan: BridgePlan = {
      file,
      rootId: tree.rootId,
      left: candidate.left,
      right: candidate.right,
      reason: candidate.reason,
    };
    if (applyBridge(file, tree, plan)) {
      updated.push(plan);
    }
  }

  const summary = {
    updated: updated.length,
    skipped: skipped.length,
    plans: updated.map((plan) => ({
      file: plan.file.replace(ROOT + "\\", ""),
      left: plan.left,
      right: plan.right,
      reason: plan.reason,
    })),
  };
  writeFileSync(join(ROOT, "tmp", "bridge-mine-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(summary, null, 2));
};

main();
