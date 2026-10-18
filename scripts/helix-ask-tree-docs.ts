import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, sep, basename } from "path";

const ROOT = process.cwd();
const TREES_ROOT = join(ROOT, "docs", "knowledge");
const OUTPUT_DIR = join(ROOT, "docs", "knowledge", "trees");
const MAX_BODY = 240;

const sanitize = (value) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const quoteList = (values: string[]) =>
  values.map((value) => `"${value.replace(/"/g, '\\"')}"`).join(", ");

const getText = (node) => {
  const raw = node.bodyMD || node.summary || node.excerpt || "";
  const trimmed = String(raw).replace(/\s+/g, " ").trim();
  return trimmed.length > MAX_BODY ? `${trimmed.slice(0, MAX_BODY)}…` : trimmed;
};

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith("-tree.json")) out.push(full);
  }
  return out;
};

mkdirSync(OUTPUT_DIR, { recursive: true });

const treeFiles = walk(TREES_ROOT);
const requestedSlugs = new Set(process.argv.slice(2).map(sanitize).filter(Boolean));
let generatedCount = 0;

for (const file of treeFiles) {
  const raw = readFileSync(file, "utf8");
  let tree;
  try {
    tree = JSON.parse(raw);
  } catch {
    continue;
  }
  const nodes = Array.isArray(tree.nodes) ? tree.nodes : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const root = byId.get(tree.rootId) || nodes[0];
  const title = root?.title || root?.label || tree.rootId || basename(file, ".json");
  const treeSlug = sanitize(tree.rootId || basename(file, ".json"));
  if (requestedSlugs.size > 0 && !requestedSlugs.has(treeSlug)) continue;
  const conceptId = tree.rootId || basename(file, ".json");
  const outPath = join(OUTPUT_DIR, `${treeSlug}.md`);

  const lines = [];
  const aliasSet = new Set<string>();
  if (root?.title) aliasSet.add(String(root.title));
  if (root?.label) aliasSet.add(String(root.label));
  if (root?.slug) aliasSet.add(String(root.slug));
  if (root?.id) aliasSet.add(String(root.id).replace(/[-_]+/g, " "));
  if (tree.rootId) aliasSet.add(String(tree.rootId).replace(/[-_]+/g, " "));
  const aliases = Array.from(aliasSet).filter(Boolean);
  const tags = Array.isArray(root?.tags) ? root.tags.filter(Boolean) : [];

  lines.push("---");
  lines.push(`id: ${conceptId}`);
  lines.push(`label: ${title}`);
  if (aliases.length > 0) {
    lines.push(`aliases: [${quoteList(aliases)}]`);
  }
  if (tags.length > 0) {
    lines.push(`topicTags: [${quoteList(tags)}]`);
  }
  lines.push(`mustIncludeFiles: ["${file.replace(ROOT + sep, "").replace(/\\/g, "/")}"]`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`Source tree: ${file.replace(ROOT + sep, "").replace(/\\/g, "/")}`);
  lines.push("");
  if (root) {
    lines.push(`## Definition: ${root.title || root.id}`);
    const text = getText(root);
    if (text) lines.push(text);
    lines.push("");
  }

  lines.push("## Nodes");
  lines.push("");
  for (const node of nodes) {
    const nodeTitle = node.title || node.label || node.id;
    lines.push(`### Node: ${nodeTitle}`);
    lines.push(`- id: ${node.id}`);
    if (node.nodeType) lines.push(`- type: ${node.nodeType}`);
    const text = getText(node);
    if (text) lines.push(`- summary: ${text}`);
    lines.push("");
  }

  const bridges = nodes.filter((n) => n.nodeType === "bridge" && n.bridge);
  if (bridges.length) {
    lines.push("## Bridges");
    lines.push("");
    for (const bridge of bridges) {
      const left = byId.get(bridge.bridge.left)?.title || bridge.bridge.left;
      const right = byId.get(bridge.bridge.right)?.title || bridge.bridge.right;
      lines.push(`### Bridge: ${left} <-> ${right}`);
      if (bridge.bridge.relation) lines.push(`- relation: ${bridge.bridge.relation}`);
      const text = getText(bridge);
      if (text) lines.push(`- summary: ${text}`);
      lines.push("");
    }
  }

  writeFileSync(outPath, lines.join("\n"), "utf8");
  generatedCount += 1;
}

console.log(`Generated ${generatedCount} tree docs into ${OUTPUT_DIR}`);
