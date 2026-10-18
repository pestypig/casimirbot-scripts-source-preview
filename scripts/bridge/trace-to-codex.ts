import fs from "node:fs";
import path from "node:path";

type ExportPayload = {
  version: string;
  trace: { id: string; goal: string; persona_id?: string; result_summary?: string };
  plan: any[];
  executor_steps: any[];
  tool_manifest: Array<{ name: string; desc?: string; description?: string }>;
  knowledge_context: Array<{
    project: { name: string };
    files: Array<{ name: string; kind: string }>;
  }>;
  env: { hull_mode: boolean; llm_policy: string };
};

const file = process.argv[2];
if (!file) {
  console.error("usage: tsx scripts/bridge/trace-to-codex.ts <trace-export.json>");
  process.exit(2);
}

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
const exp: ExportPayload = readJson(path.resolve(file));

const toolLine = (t: { name: string; desc?: string; description?: string }) =>
  `- ${t.name}: ${t.desc ?? t.description ?? ""}`.trimEnd();

const manifestMd = [
  `# Essence Trace Context`,
  `- Trace: ${exp.trace.id}`,
  `- Goal: ${exp.trace.goal}`,
  `- Persona: ${exp.trace.persona_id ?? "n/a"}`,
  `- Hull: ${exp.env.hull_mode} | LLM: ${exp.env.llm_policy}`,
  ``,
  `## Tools`,
  ...exp.tool_manifest.map(toolLine),
  ``,
  `## Knowledge Attachments`,
  ...exp.knowledge_context.map(
    (p) => `- ${p.project.name}: ${p.files.map((f) => f.name).join(", ")}`,
  ),
  ``,
  `## Plan (abbrev)`,
  "```json",
  JSON.stringify(exp.plan, null, 2).slice(0, 4000),
  "```",
].join("\n");

const outDir = path.join(process.cwd(), "codex-context", exp.trace.id);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "context.md"), manifestMd, "utf8");
fs.writeFileSync(path.join(outDir, "export.json"), JSON.stringify(exp, null, 2), "utf8");

console.log(JSON.stringify({ ok: true, dir: outDir }, null, 2));

