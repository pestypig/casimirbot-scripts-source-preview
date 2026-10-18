import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "artifacts/warp-evidence-pack.json";
const firstFail = process.argv.includes("--first-fail") ? process.argv[process.argv.indexOf("--first-fail") + 1] : "none";
const firstFailSeverityArg = process.argv.includes("--first-fail-severity")
  ? process.argv[process.argv.indexOf("--first-fail-severity") + 1]
  : undefined;
const claimTier = process.argv.includes("--claim-tier") ? process.argv[process.argv.indexOf("--claim-tier") + 1] : "diagnostic";
const proofPackRef = process.argv.includes("--proof-pack-ref")
  ? process.argv[process.argv.indexOf("--proof-pack-ref") + 1]
  : "api:/api/helix/pipeline/proofs";
const proofPackExport = process.argv.includes("--proof-pack-export")
  ? process.argv[process.argv.indexOf("--proof-pack-export") + 1]
  : "artifacts/proof-pack.json";
const viabilityStatus = process.argv.includes("--viability-status")
  ? process.argv[process.argv.indexOf("--viability-status") + 1]
  : "UNKNOWN";

const REQUIRED_DISCLAIMER =
  "This material reports diagnostic/reduced-order readiness signals and governance guardrails. It does not claim warp propulsion feasibility or near-term deployment.";

const firstFailNormalized = String(firstFail ?? "none").trim() || "none";
const firstFailSeverity = (() => {
  if (firstFailNormalized === "none") {
    return "none";
  }
  const candidate = String(firstFailSeverityArg ?? "").trim().toUpperCase();
  if (candidate === "HARD" || candidate === "SOFT" || candidate === "UNKNOWN") {
    return candidate;
  }
  return "unknown";
})();

const commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
const payload = {
  version: "warp-evidence-pack/v1",
  commit,
  generatedAt: new Date(0).toISOString(),
  proofPack: {
    ref: proofPackRef,
    export: proofPackExport,
  },
  viabilitySnapshot: {
    status: viabilityStatus,
    maturityPosture: "diagnostic -> reduced-order -> certified-as-governance-only",
  },
  firstFailReport: { firstFail: firstFailNormalized, severity: firstFailSeverity },
  claimTierSnapshot: { claimTier, posture: "governance-only" },
  requiredDisclaimer: REQUIRED_DISCLAIMER,
};
const canonical = JSON.stringify(payload);
const checksum = crypto.createHash("sha256").update(canonical).digest("hex");
const finalPayload = { ...payload, checksum };
const outPath = path.resolve(process.cwd(), out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(finalPayload, null, 2));
console.log(JSON.stringify({ ok: true, out: outPath, checksum }, null, 2));
