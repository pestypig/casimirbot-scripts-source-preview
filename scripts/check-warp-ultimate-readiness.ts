import fs from "node:fs";
import path from "node:path";

const DOC_PATH = path.resolve(process.cwd(), "docs/warp-ultimate-stakeholder-readiness.md");
const REQUIRED_DISCLAIMER =
  "This material reports diagnostic/reduced-order readiness signals and governance guardrails. It does not claim warp propulsion feasibility or near-term deployment.";

const REQUIRED_SECTIONS = [
  "## Executive Decision",
  "## Claims Boundary",
  "## What Is Implemented",
  "## Proof Visibility",
  "## Claims Matrix",
  "## Gap Register",
  "## Lab Test Envelope + Falsifier Matrix",
  "## 90-Day Upgrade Plan",
  "## Release Checklist",
  "## Appendix",
];

const REQUIRED_EVIDENCE_FIELDS = [
  "certificateHash:",
  "integrityOk:",
  "traceId:",
  "runId:",
  "commit:",
];

if (!fs.existsSync(DOC_PATH)) {
  console.error(JSON.stringify({ ok: false, reason: "missing_doc", path: DOC_PATH }, null, 2));
  process.exit(1);
}

const text = fs.readFileSync(DOC_PATH, "utf8");

const missingSections = REQUIRED_SECTIONS.filter((section) => !text.includes(section));
const missingEvidence = REQUIRED_EVIDENCE_FIELDS.filter((field) => !text.includes(field));
const hasDisclaimer = text.includes(REQUIRED_DISCLAIMER);

if (missingSections.length || missingEvidence.length || !hasDisclaimer) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        path: DOC_PATH,
        missingDisclaimer: !hasDisclaimer,
        missingSections,
        missingEvidence,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      path: DOC_PATH,
      sectionsChecked: REQUIRED_SECTIONS.length,
      evidenceFieldsChecked: REQUIRED_EVIDENCE_FIELDS.length,
    },
    null,
    2,
  ),
);
