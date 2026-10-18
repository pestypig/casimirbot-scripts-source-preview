import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

// Exact scoped source/evidence handoff; never discovers account or secret files.
const files = [
  "shared/helix-hosted-budget.ts",
  "server/services/helix-account/hosted-budget-store.ts",
  "server/services/helix-account/billing-entitlement-store.ts",
  "server/services/helix-account/__tests__/hosted-budget-store.test.ts",
  "server/db/migrations/101_local_hosted_budgets.ts",
  "server/db/client.ts", "server/db/migrator.ts",
  "server/db/__tests__/local-hosted-budget-restart.test.ts",
  "server/routes/local-hosted-account.ts",
  "server/routes/__tests__/local-hosted-account.test.ts",
  "client/src/components/agent-access/LocalHostedSubscription.tsx",
  "client/src/components/agent-access/__tests__/LocalHostedSubscription.spec.tsx",
  "docs/work-packets/eh-g8-local-mvp-eligibility-budgets-v1.md",
  "scripts/local-hosted-budget-handoff.mjs",
  "artifacts/local-mvp-eligibility-budgets/canvas-http-qualification.json",
  "artifacts/local-mvp-eligibility-budgets/canvas-meter-summary.json",
  "artifacts/local-mvp-eligibility-budgets/focused-tests.json",
  "artifacts/local-mvp-eligibility-budgets/verification.json",
];
const frozen = {
  "server/services/helix-account/billing-entitlement-store.ts": "billing-entitlement-store.ts",
  "server/db/client.ts": "client.ts",
  "server/db/migrator.ts": "migrator.ts",
};
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const staging = path.resolve(".tmp/local-hosted-handoff");
const output = path.resolve("artifacts/local-mvp-eligibility-budgets");
fs.mkdirSync(output, { recursive: true });
const manifest = [];
for (const file of files) {
  const candidate = fs.readFileSync(file);
  const destination = path.join(staging, "candidate", file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, candidate);
  let baseline = null;
  if (frozen[file]) {
    baseline = fs.readFileSync(path.join(".tmp/local-hosted-baseline", frozen[file]));
    const original = path.join(staging, "baseline", file);
    fs.mkdirSync(path.dirname(original), { recursive: true });
    fs.writeFileSync(original, baseline);
  }
  manifest.push({ path: file, baseline_sha256: baseline ? digest(baseline) : null,
    candidate_sha256: digest(candidate), bytes: candidate.length });
}
const result = spawnSync("git", ["diff", "--no-index", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "--", "baseline", "candidate"],
  { cwd: staging, encoding: "utf8", maxBuffer: 16 * 1024 ** 2 });
if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr);
const patch = result.stdout.replaceAll("a/", "a/").replaceAll("b/", "b/")
  .replaceAll("a/", "a/").replaceAll("b/", "b/");
fs.writeFileSync(path.join(output, "integration.patch"), patch);
fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify({
  schema: "casimirbot.local_hosted_budget_handoff.v1",
  baseline_head: "7e443b08360dbd19d2cbb016baf897c8a3fd5124",
  baseline_authority: "Frozen current Desktop non-secret source bytes, not Git HEAD alone",
  production_eligible: false, paid_amount_status: "$60 validation candidate only",
  patch_sha256: digest(patch), files: manifest,
}, null, 2) + "\n");
process.stdout.write(JSON.stringify({ patch: path.join(output, "integration.patch"), sha256: digest(patch), files: files.length }) + "\n");
