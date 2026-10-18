#!/usr/bin/env tsx
import fs from "node:fs/promises";
import path from "node:path";

type DraftNode = {
  id: string;
  slug: string;
  title: string;
  level: number;
  body: string[];
  children: string[];
  links: { rel: string; to: string }[];
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

async function main() {
  const sourcePath = path.resolve("docs/ethos/why.md");
  const outputPath = path.resolve("docs/ethos/ideology.json");
  const raw = await fs.readFile(sourcePath, "utf8");

  const nodes = new Map<string, DraftNode>();
  const stack: DraftNode[] = [];
  let rootId: string | null = null;

  const ensureNode = (slug: string, title: string, level: number) => {
    let node = nodes.get(slug);
    if (!node) {
      node = { id: slug, slug, title, level, body: [], children: [], links: [] };
      nodes.set(slug, node);
    } else {
      node.title = title;
      node.level = level;
    }
    return node;
  };

  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      const slug = slugify(title) || `node-${nodes.size + 1}`;
      const node = ensureNode(slug, title, level);
      while (stack.length >= level) {
        stack.pop();
      }
      const parent = stack.at(-1);
      if (parent && !parent.children.includes(node.id)) {
        parent.children.push(node.id);
      }
      stack.push(node);
      if (level === 1 && !rootId) {
        rootId = node.id;
      }
      continue;
    }

    const current = stack.at(-1);
    if (!current) continue;
    const nextLine = line.replace(/\[\[node:([a-z0-9-]+)\]\]/gi, (_match, to) => {
      const slug = slugify(to);
      if (!current.links.some((link) => link.to === slug)) {
        current.links.push({ rel: "see-also", to: slug });
      }
      return `[[node:${slug}]]`;
    });
    current.body.push(nextLine);
  }

  const doc = {
    version: 1,
    rootId: rootId ?? Array.from(nodes.values()).find((node) => node.level === 1)?.id ?? "mission-ethos",
    nodes: Array.from(nodes.values()).map((node) => ({
      id: node.id,
      slug: node.slug,
      title: node.title,
      bodyMD: node.body.join("\n").trim(),
      children: node.children,
      links: node.links
    }))
  };

  await fs.writeFile(outputPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
