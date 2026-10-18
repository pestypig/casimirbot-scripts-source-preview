import fs from "node:fs/promises";
import path from "node:path";
import { ensureArtifactsDir, resolveArtifactsPath } from "./agi-artifacts";
import {
  getTrainingTraceExport,
  recordTrainingTrace,
} from "../server/services/observability/training-trace-store";
import {
  DEFAULT_HOLDOUT_PATH,
  computeHoldoutMetrics,
  extractHoldoutPayload,
  filterHoldoutTrajectories,
  loadHoldoutSet,
} from "../server/services/agi/refinery-holdout";

type HoldoutEvalArgs = {
  limit?: number;
  holdoutPath?: string;
  outPath?: string;
  tenantId?: string;
  baselinePath?: string;
  baselineManifestPath?: string;
  emitTrace?: boolean;
  label?: string;
};

type BaselineSnapshot = {
  candidateRecall?: number;
  citationRecall?: number;
  surfaceShares?: Record<string, number>;
};

const parseArgs = (): HoldoutEvalArgs => {
  const args = process.argv.slice(2);
  const out: HoldoutEvalArgs = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--limit") {
      out.limit = Number(args[i + 1]);
      i += 1;
    } else if (token === "--holdout") {
      out.holdoutPath = args[i + 1];
      i += 1;
    } else if (token === "--out") {
      out.outPath = args[i + 1];
      i += 1;
    } else if (token === "--tenant") {
      out.tenantId = args[i + 1];
      i += 1;
    } else if (token === "--baseline") {
      out.baselinePath = args[i + 1];
      i += 1;
    } else if (token === "--baseline-manifest") {
      out.baselineManifestPath = args[i + 1];
      i += 1;
    } else if (token === "--emit-trace") {
      out.emitTrace = true;
    } else if (token === "--label") {
      out.label = args[i + 1];
      i += 1;
    }
  }
  return out;
};

const extractSurfaceShares = (metrics: {
  total?: number;
  bySurface?: Record<string, number>;
  surfaceShares?: Record<string, number>;
}): Record<string, number> | undefined => {
  if (metrics.surfaceShares) return metrics.surfaceShares;
  if (!metrics.bySurface || !metrics.total) return undefined;
  if (metrics.total <= 0) return undefined;
  const shares: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics.bySurface)) {
    shares[key] = value / metrics.total;
  }
  return shares;
};

const computeSurfaceMixDelta = (
  current: Record<string, number>,
  baseline: Record<string, number>,
): number => {
  const keys = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  let delta = 0;
  for (const key of keys) {
    delta += Math.abs((current[key] ?? 0) - (baseline[key] ?? 0));
  }
  return delta;
};

const loadJsonIfExists = async (filePath: string | undefined): Promise<any | null> => {
  if (!filePath) return null;
  try {
    const payload = await fs.readFile(filePath, "utf8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
};

const resolveBaseline = async (
  args: HoldoutEvalArgs,
): Promise<{ baseline: BaselineSnapshot | null; source?: string }> => {
  const baselinePath = args.baselinePath?.trim() || process.env.AGI_HOLDOUT_BASELINE_PATH;
  const baselineManifestPath =
    args.baselineManifestPath?.trim() || process.env.AGI_HOLDOUT_BASELINE_MANIFEST;
  const rawBaseline = await loadJsonIfExists(baselinePath);
  if (rawBaseline) {
    const candidate = rawBaseline.metrics ?? rawBaseline;
    const surfaceShares = extractSurfaceShares(candidate) ?? extractSurfaceShares(rawBaseline);
    return {
      source: baselinePath,
      baseline: {
        candidateRecall: candidate.candidateRecall,
        citationRecall: candidate.citationRecall,
        surfaceShares,
      },
    };
  }
  const rawManifest = await loadJsonIfExists(baselineManifestPath);
  if (rawManifest?.export?.summary?.surfaceShares) {
    return {
      source: baselineManifestPath,
      baseline: { surfaceShares: rawManifest.export.summary.surfaceShares },
    };
  }
  return { baseline: null };
};

async function main() {
  const args = parseArgs();
  const holdoutPath = args.holdoutPath
    ? path.resolve(args.holdoutPath)
    : DEFAULT_HOLDOUT_PATH;
  const holdout = await loadHoldoutSet(holdoutPath);
  if (!holdout) {
    throw new Error(`holdout_missing:${holdoutPath}`);
  }
  const traces = getTrainingTraceExport({
    limit: args.limit,
    tenantId: args.tenantId,
  });
  const { trajectories, gates } = extractHoldoutPayload(traces);
  const { holdout: holdoutTrajectories } = filterHoldoutTrajectories(
    trajectories,
    holdout,
  );
  const metrics = computeHoldoutMetrics(holdoutTrajectories, gates);
  const surfaceShares = extractSurfaceShares(metrics) ?? {};
  const { baseline, source: baselineSource } = await resolveBaseline(args);
  const baselineShares = baseline?.surfaceShares ?? null;
  const surfaceMixDelta =
    baselineShares && Object.keys(surfaceShares).length > 0
      ? computeSurfaceMixDelta(surfaceShares, baselineShares)
      : undefined;
  const candidateRecallDelta =
    baseline?.candidateRecall !== undefined
      ? metrics.candidateRecall - baseline.candidateRecall
      : undefined;
  const citationRecallDelta =
    baseline?.citationRecall !== undefined
      ? metrics.citationRecall - baseline.citationRecall
      : undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const outPath = args.outPath
    ? path.resolve(args.outPath)
    : resolveArtifactsPath(`agi-refinery-holdout-metrics.${stamp}.json`);
  await ensureArtifactsDir(outPath);
  const payload = {
    metrics,
    drift: {
      surfaceMixDelta: surfaceMixDelta ?? null,
      candidateRecallDelta: candidateRecallDelta ?? null,
      citationRecallDelta: citationRecallDelta ?? null,
      baselineSource: baselineSource ?? null,
    },
  };
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  if (args.emitTrace || process.env.AGI_HOLDOUT_EVAL_EMIT_TRACE === "1") {
    const deltas: Array<{ key: string; from?: number | null; to?: number | null; delta?: number; unit?: string; change?: "changed" }> = [];
    const pushDelta = (key: string, from?: number, to?: number, unit?: string) => {
      if (from === undefined || to === undefined) return;
      deltas.push({
        key,
        from,
        to,
        delta: to - from,
        unit,
        change: "changed",
      });
    };
    pushDelta("holdout_candidate_recall", baseline?.candidateRecall, metrics.candidateRecall);
    pushDelta("holdout_citation_recall", baseline?.citationRecall, metrics.citationRecall);
    if (baselineShares) {
      for (const [key, value] of Object.entries(surfaceShares)) {
        pushDelta(`holdout_surface_share.${key}`, baselineShares[key] ?? 0, value);
      }
    }

    const metricsPayload: Record<string, number | string | boolean | null> = {
      holdout_total: metrics.total,
      holdout_precision: metrics.precision,
      holdout_recall: metrics.recall,
      holdout_attribution_precision: metrics.attributionPrecision,
      holdout_attribution_recall: metrics.attributionRecall,
      holdout_candidate_recall: metrics.candidateRecall,
      holdout_evidence_candidate_recall: metrics.evidenceRecallCandidate,
      holdout_evidence_selected_recall: metrics.evidenceRecallSelected,
      holdout_citation_recall: metrics.citationRecall,
      holdout_latency_avg_ms: metrics.latencyMsAvg,
      holdout_latency_p95_ms: metrics.latencyMsP95,
      holdout_latency_p99_ms: metrics.latencyMsP99,
      holdout_latency_count: metrics.latencyMsCount,
    };
    if (surfaceMixDelta !== undefined) {
      metricsPayload.holdout_surface_mix_delta = surfaceMixDelta;
    }
    if (candidateRecallDelta !== undefined) {
      metricsPayload.holdout_candidate_recall_delta = candidateRecallDelta;
    }
    if (citationRecallDelta !== undefined) {
      metricsPayload.holdout_citation_recall_delta = citationRecallDelta;
    }
    for (const [key, value] of Object.entries(surfaceShares)) {
      metricsPayload[`holdout_surface_share_${key}`] = value;
    }

    const notes = [
      args.label ? `label=${args.label}` : null,
      baselineSource ? `baseline=${baselineSource}` : null,
    ].filter(Boolean) as string[];

    recordTrainingTrace({
      pass: true,
      deltas,
      metrics: metricsPayload,
      source: { system: "agi-refinery", component: "holdout", tool: "eval" },
      notes: notes.length > 0 ? notes : undefined,
    });
  }

  console.log(JSON.stringify({ outPath, ...payload }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
