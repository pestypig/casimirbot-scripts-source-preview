import fs from "node:fs/promises";
import path from "node:path";
import { ensureArtifactsDir, resolveArtifactsPath } from "./agi-artifacts";
import { collectRefinerySummary } from "../server/services/agi/refinery-summary";
import { buildSamplingPolicy } from "../server/services/agi/refinery-policy";

type PolicyArgs = {
  limit?: number;
  outPath?: string;
  tenantId?: string;
  acceptanceFloor?: number;
};

const parseArgs = (): PolicyArgs => {
  const args = process.argv.slice(2);
  const out: PolicyArgs = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--limit") {
      out.limit = Number(args[i + 1]);
      i += 1;
    } else if (token === "--out") {
      out.outPath = args[i + 1];
      i += 1;
    } else if (token === "--tenant") {
      out.tenantId = args[i + 1];
      i += 1;
    } else if (token === "--floor") {
      out.acceptanceFloor = Number(args[i + 1]);
      i += 1;
    }
  }
  return out;
};

async function main() {
  const args = parseArgs();
  const summary = collectRefinerySummary({ limit: args.limit, tenantId: args.tenantId });
  const policy = buildSamplingPolicy(summary, { acceptanceFloor: args.acceptanceFloor });
  const outPath =
    args.outPath ?? resolveArtifactsPath("agi-refinery-policy.json");
  await ensureArtifactsDir(outPath);
  await fs.writeFile(outPath, JSON.stringify(policy, null, 2), "utf8");
  console.log(JSON.stringify({ outPath, policy }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
