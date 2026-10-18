import path from "node:path";
import { getTrainingTraceExport } from "../server/services/observability/training-trace-store";
import {
  buildHoldoutSet,
  buildCoverageHoldoutSet,
  DEFAULT_COVERAGE_HOLDOUT_PATH,
  DEFAULT_HOLDOUT_PATH,
  extractHoldoutPayload,
  saveHoldoutSet,
} from "../server/services/agi/refinery-holdout";

type HoldoutArgs = {
  limit?: number;
  ratio?: number;
  minPerIntent?: number;
  minPerSurface?: number;
  minPerDifficulty?: number;
  maxTotal?: number;
  recentFraction?: number;
  outPath?: string;
  coverage?: boolean;
  coverageOutPath?: string;
  tenantId?: string;
};

const parseArgs = (): HoldoutArgs => {
  const args = process.argv.slice(2);
  const out: HoldoutArgs = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--limit") {
      out.limit = Number(args[i + 1]);
      i += 1;
    } else if (token === "--ratio") {
      out.ratio = Number(args[i + 1]);
      i += 1;
    } else if (token === "--min-per-intent") {
      out.minPerIntent = Number(args[i + 1]);
      i += 1;
    } else if (token === "--max-total") {
      out.maxTotal = Number(args[i + 1]);
      i += 1;
    } else if (token === "--recent-fraction") {
      out.recentFraction = Number(args[i + 1]);
      i += 1;
    } else if (token === "--out") {
      out.outPath = args[i + 1];
      i += 1;
    } else if (token === "--coverage") {
      out.coverage = true;
    } else if (token === "--coverage-out") {
      out.coverageOutPath = args[i + 1];
      i += 1;
    } else if (token === "--min-per-surface") {
      out.minPerSurface = Number(args[i + 1]);
      i += 1;
    } else if (token === "--min-per-difficulty") {
      out.minPerDifficulty = Number(args[i + 1]);
      i += 1;
    } else if (token === "--tenant") {
      out.tenantId = args[i + 1];
      i += 1;
    }
  }
  return out;
};

async function main() {
  const args = parseArgs();
  const traces = getTrainingTraceExport({
    limit: args.limit,
    tenantId: args.tenantId,
  });
  const { trajectories } = extractHoldoutPayload(traces);
  const holdout = buildHoldoutSet(Array.from(trajectories.values()), {
    ratio: args.ratio,
    minPerIntent: args.minPerIntent,
    maxTotal: args.maxTotal,
    recentFraction: args.recentFraction,
  });
  const outPath = args.outPath
    ? path.resolve(args.outPath)
    : DEFAULT_HOLDOUT_PATH;
  await saveHoldoutSet(holdout, outPath);
  const coverageOutPath = args.coverageOutPath
    ? path.resolve(args.coverageOutPath)
    : args.coverage
      ? DEFAULT_COVERAGE_HOLDOUT_PATH
      : undefined;
  let coverageCount: number | undefined;
  if (coverageOutPath) {
    const coverage = buildCoverageHoldoutSet(
      Array.from(trajectories.values()),
      {
        ratio: args.ratio,
        minPerIntent: args.minPerIntent,
        minPerSurface: args.minPerSurface,
        minPerDifficulty: args.minPerDifficulty,
        maxTotal: args.maxTotal,
        recentFraction: args.recentFraction,
      },
    );
    coverageCount = coverage.entries.length;
    await saveHoldoutSet(coverage, coverageOutPath);
  }
  console.log(
    JSON.stringify(
      {
        outPath,
        total: trajectories.size,
        holdout: holdout.entries.length,
        coverageOutPath,
        coverage: coverageCount,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
