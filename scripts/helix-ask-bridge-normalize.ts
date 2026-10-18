import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type TreeNode = {
  id: string;
  slug?: string;
  title?: string;
  summary?: string;
  excerpt?: string;
  nodeType?: string;
  bridge?: { left: string; right: string };
};

type TreeFile = { nodes: TreeNode[] };

const ROOT = process.cwd();
const TREE_DIR = join(ROOT, "docs", "knowledge");

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

const main = () => {
  const files = walkTrees(TREE_DIR);
  let updated = 0;
  for (const file of files) {
    const tree = JSON.parse(readFileSync(file, "utf8")) as TreeFile;
    let changed = false;
    for (const node of tree.nodes ?? []) {
      if (node.nodeType !== "bridge" && !node.bridge) continue;
      if (!node.slug) {
        node.slug = node.id;
        changed = true;
      }
      if (!node.summary) {
        node.summary = node.excerpt ?? (node.title ? `Bridge between ${node.title}.` : "Bridge node.");
        changed = true;
      }
      if (!node.excerpt && node.summary) {
        node.excerpt = node.summary;
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(file, JSON.stringify(tree, null, 2) + "\n", "utf8");
      updated += 1;
    }
  }
  console.log(JSON.stringify({ updated }, null, 2));
};

main();
