import fs from "node:fs";
import path from "node:path";

const REQUIRED =
  "This material reports diagnostic/reduced-order readiness signals and governance guardrails. It does not claim warp propulsion feasibility or near-term deployment.";

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (["node_modules", ".git", "dist", "coverage"].includes(ent.name)) continue;
      walk(p, out);
    } else if (/deck|brief/i.test(ent.name) && /\.(md|txt)$/i.test(ent.name)) {
      out.push(p);
    }
  }
  return out;
}

const roots = [path.resolve(process.cwd(), "docs/moral-ladder-pack")];
const files = roots.flatMap((root) => (fs.existsSync(root) ? walk(root) : []));
files.push(path.resolve(process.cwd(), "docs/pre-brief-academic-rubric-template.md"));
const unique = Array.from(new Set(files));
const missing = unique.filter((f) => !fs.readFileSync(f, "utf8").includes(REQUIRED));
if (missing.length) {
  console.error(JSON.stringify({ ok: false, missing }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, checked: unique.length }, null, 2));
