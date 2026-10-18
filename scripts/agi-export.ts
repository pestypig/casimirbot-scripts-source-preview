import { exportRefineryDataset } from "../server/services/agi/refinery-export";

type ExportArgs = {
  limit?: number;
  outDir?: string;
  realRatio?: number;
  syntheticRatio?: number;
  tenantId?: string;
  negativesPerSample?: number;
  alphaTarget?: number;
  minAlpha?: number;
  enforceGates?: boolean;
  requireNoUnknownExecution?: boolean;
  minClientShare?: number;
  minServerShare?: number;
  minClientServerShare?: number;
  maxDocsSharedShare?: number;
  variantReservoirPath?: string;
};

const parseArgs = (): ExportArgs => {
  const args = process.argv.slice(2);
  const out: ExportArgs = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--limit") {
      out.limit = Number(args[i + 1]);
      i += 1;
    } else if (token === "--out-dir") {
      out.outDir = args[i + 1];
      i += 1;
    } else if (token === "--real-ratio") {
      out.realRatio = Number(args[i + 1]);
      i += 1;
    } else if (token === "--synthetic-ratio") {
      out.syntheticRatio = Number(args[i + 1]);
      i += 1;
    } else if (token === "--alpha-target") {
      out.alphaTarget = Number(args[i + 1]);
      i += 1;
    } else if (token === "--min-alpha") {
      out.minAlpha = Number(args[i + 1]);
      i += 1;
    } else if (token === "--tenant") {
      out.tenantId = args[i + 1];
      i += 1;
    } else if (token === "--negatives-per-sample") {
      out.negativesPerSample = Number(args[i + 1]);
      i += 1;
    } else if (token === "--no-enforce") {
      out.enforceGates = false;
    } else if (token === "--allow-unknown") {
      out.requireNoUnknownExecution = false;
    } else if (token === "--min-client-share") {
      out.minClientShare = Number(args[i + 1]);
      i += 1;
    } else if (token === "--min-server-share") {
      out.minServerShare = Number(args[i + 1]);
      i += 1;
    } else if (token === "--min-client-server-share") {
      out.minClientServerShare = Number(args[i + 1]);
      i += 1;
    } else if (token === "--max-docs-shared-share") {
      out.maxDocsSharedShare = Number(args[i + 1]);
      i += 1;
    } else if (token === "--variant-reservoir") {
      out.variantReservoirPath = args[i + 1];
      i += 1;
    }
  }
  return out;
};

async function main() {
  const args = parseArgs();
  const summary = await exportRefineryDataset({
    limit: args.limit,
    outDir: args.outDir,
    realRatio: args.realRatio ?? args.alphaTarget,
    syntheticRatio: args.syntheticRatio,
    tenantId: args.tenantId,
    negativesPerSample: args.negativesPerSample,
    minAlpha: args.minAlpha,
    enforceGates: args.enforceGates,
    requireNoUnknownExecution: args.requireNoUnknownExecution,
    minClientShare: args.minClientShare,
    minServerShare: args.minServerShare,
    minClientServerShare: args.minClientServerShare,
    maxDocsSharedShare: args.maxDocsSharedShare,
    variantReservoirPath: args.variantReservoirPath,
    emitTrace: true,
  });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.blocked) {
    console.error("[agi-export] blocked:", summary.blockedReasons ?? []);
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
