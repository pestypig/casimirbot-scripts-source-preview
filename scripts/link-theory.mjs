// scripts/link-theory.mjs
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const CODE_DIRS = ["client", "server", "modules"];
const DOCS_DIR = path.join(ROOT, "docs", "papers");

const theoryRefs = {}; // id -> [{ file, line, context }]
const REF_BLOCK_RE = /\/\*\*[\s\S]*?TheoryRefs:([\s\S]*?)\*\//g;

function* walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (/(^|\/)(node_modules|dist|build|coverage)(\/|$)/.test(p)) continue;
      yield* walk(p);
    } else {
      yield p;
    }
  }
}

function scanCode() {
  for (const base of CODE_DIRS) {
    const dir = path.join(ROOT, base);
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
      if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      let match;
      while ((match = REF_BLOCK_RE.exec(text))) {
        const block = match[1];
        const blockStart = text.lastIndexOf("/**", match.index);
        const line = text.slice(0, blockStart).split("\n").length;
        const ids = [];
        for (const lineText of block.split("\n")) {
          const trimmed = lineText.trim();
          const normalized = trimmed.replace(/^\*+\s*/, "");
          const m = /^-\s*([a-z0-9\-]+)/i.exec(normalized);
          if (m) ids.push(m[1].toLowerCase());
        }
        const context = text
          .slice(match.index, Math.min(match.index + 200, text.length))
          .replace(/\s+/g, " ")
          .trim();
        ids.forEach((id) => {
          if (!theoryRefs[id]) theoryRefs[id] = [];
          theoryRefs[id].push({
            file: path.relative(ROOT, file),
            line,
            context,
          });
        });
      }
    }
  }
}

function parseFrontMatter(source) {
  const fm = /^---\n([\s\S]+?)\n---/m.exec(source);
  if (!fm) return null;
  const lines = fm[1].split("\n");
  const out = {};
  for (const line of lines) {
    const m = /^([a-zA-Z0-9_\-]+):\s*(.+)$/.exec(line.trim());
    if (m) {
      const key = m[1];
      let value = m[2].trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      out[key] = value;
    }
  }
  return out;
}

function buildDigestIndex() {
  const index = {};
  if (!fs.existsSync(DOCS_DIR)) return index;
  for (const file of fs.readdirSync(DOCS_DIR)) {
    if (!file.endsWith(".md")) continue;
    const full = path.join(DOCS_DIR, file);
    const text = fs.readFileSync(full, "utf8");
    const fm = parseFrontMatter(text);
    if (fm?.id) {
      index[fm.id.toLowerCase()] = { title: fm.title ?? fm.id, file: `papers/${file}` };
    }
  }
  return index;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function main() {
  scanCode();
  ensureDir(DOCS_DIR);
  fs.writeFileSync(
    path.join(DOCS_DIR, "_theory-refs.json"),
    JSON.stringify(theoryRefs, null, 2)
  );
  const digests = buildDigestIndex();
  fs.writeFileSync(
    path.join(DOCS_DIR, "_digests.json"),
    JSON.stringify(digests, null, 2)
  );
  console.log(
    `Wrote ${Object.keys(theoryRefs).length} theory keys and ${Object.keys(digests).length} digests.`
  );
}

main();
