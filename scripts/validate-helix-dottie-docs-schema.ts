import { readFile } from "node:fs/promises";
import { suppressionReasonSchema } from "../shared/helix-dottie-callout-contract";

const promptContractPath = "docs/architecture/helix-ask-dottie-prompt-style-contract.v1.md";
const templatePath = "docs/architecture/helix-ask-dottie-callout-templates.v1.md";

const extractList = (markdown: string, heading: string): string[] => {
  const idx = markdown.indexOf(heading);
  if (idx < 0) return [];
  const tail = markdown.slice(idx + heading.length);
  const lines = tail.split("\n");
  const values: string[] = [];
  for (const line of lines) {
    if (/^##\s+/.test(line)) break;
    const match = line.match(/^[-*]\s+`?([a-z0-9_]+)`?\s*$/i);
    if (match) values.push(match[1]);
  }
  return values;
};

const hasTemplateConstraint = (markdown: string, text: string): boolean => markdown.includes(text);

const fail = (reason: string, details: Record<string, unknown>) => {
  console.error(JSON.stringify({ ok: false, reason, details }, null, 2));
  process.exit(1);
};

const run = async () => {
  const [promptDoc, templateDoc] = await Promise.all([
    readFile(promptContractPath, "utf8"),
    readFile(templatePath, "utf8"),
  ]);

  const promptSuppression = extractList(promptDoc, "### `suppression_reason`");
  const templateSuppression = extractList(templateDoc, "## Stable suppression labels");
  const schemaSuppression = [...suppressionReasonSchema.options].sort((a, b) => a.localeCompare(b));

  const promptMinusSchema = promptSuppression.filter((v) => !schemaSuppression.includes(v));
  const schemaMinusPrompt = schemaSuppression.filter((v) => !promptSuppression.includes(v));
  const templateMinusSchema = templateSuppression.filter((v) => !schemaSuppression.includes(v));
  const schemaMinusTemplate = schemaSuppression.filter((v) => !templateSuppression.includes(v));

  if (promptMinusSchema.length || schemaMinusPrompt.length || templateMinusSchema.length || schemaMinusTemplate.length) {
    fail("helix_dottie_docs_schema_drift", {
      promptMinusSchema,
      schemaMinusPrompt,
      templateMinusSchema,
      schemaMinusTemplate,
    });
  }

  const requiredConstraints = [
    "what_changed`: one-sentence delta, max 160 chars.",
    "why_it_matters`: mission impact + constraint/risk, max 220 chars.",
    "next_action`: imperative verb + target + timeframe, max 160 chars.",
    "callout`: 220 chars",
    "briefing`: 420 chars",
    "debrief`: 420 chars",
  ];

  for (const snippet of requiredConstraints) {
    if (!hasTemplateConstraint(promptDoc, snippet)) {
      fail("helix_dottie_template_constraint_missing", { snippet, source: promptContractPath });
    }
  }

  console.log(JSON.stringify({ ok: true, reason: "aligned", suppressionReasons: schemaSuppression }, null, 2));
};

run().catch((error: unknown) => {
  fail("helix_dottie_docs_schema_validation_error", {
    message: error instanceof Error ? error.message : String(error),
  });
});
