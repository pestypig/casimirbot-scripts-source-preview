import fs from "node:fs/promises";
import path from "node:path";
import { ensureArtifactsDir, resolveArtifactsPath } from "./agi-artifacts";
import { getTrainingTraceExport, recordTrainingTrace } from "../server/services/observability/training-trace-store";
import {
  DEFAULT_HOLDOUT_PATH,
  computeHoldoutMetrics,
  extractHoldoutPayload,
  filterHoldoutTrajectories,
  loadHoldoutSet,
} from "../server/services/agi/refinery-holdout";

type HoldoutGateArgs = {
  limit?: number;
  holdoutPath?: string;
  outPath?: string;
  tenantId?: string;
  baselinePath?: string;
  baselineManifestPath?: string;
  label?: string;
  minPrecision?: number;
  minRecall?: number;
  minCandidateRecall?: number;
  minCitationRecall?: number;
  maxLatencyAvgMs?: number;
  maxLatencyP95Ms?: number;
  maxLatencyP99Ms?: number;
  minTotal?: number;
  maxSurfaceMixDelta?: number;
  maxCandidateRecallDrop?: number;
  maxCitationRecallDrop?: number;
  requireThresholds?: boolean;
};

type BaselineSnapshot = {
  precision?: number;
  recall?: number;
  candidateRecall?: number;
  citationRecall?: number;
  latencyMsAvg?: number;
  latencyMsP95?: number;
  latencyMsP99?: number;
  surfaceShares?: Record<string, number>;
};

type GateConstraint = {
  id: string;
  severity: "HARD" | "SOFT";
  status: "pass" | "fail";
  value?: number | null;
  limit?: string | null;
  note?: string;
};

const DEFAULT_RC0_MANIFEST = resolveArtifactsPath(
  "rc0",
  "agi-refinery-rc0.manifest.json",
);

const parseNumber = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalize = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const parseArgs = (): HoldoutGateArgs => {
  const args = process.argv.slice(2);
  const out: HoldoutGateArgs = {};
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
    } else if (token === "--label") {
      out.label = args[i + 1];
      i += 1;
    } else if (token === "--min-precision") {
      out.minPrecision = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--min-recall") {
      out.minRecall = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--min-candidate-recall") {
      out.minCandidateRecall = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--min-citation-recall") {
      out.minCitationRecall = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--max-latency-avg-ms") {
      out.maxLatencyAvgMs = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--max-latency-p95-ms") {
      out.maxLatencyP95Ms = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--max-latency-p99-ms") {
      out.maxLatencyP99Ms = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--min-total") {
      out.minTotal = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--max-surface-mix-delta") {
      out.maxSurfaceMixDelta = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--max-candidate-recall-drop") {
      out.maxCandidateRecallDrop = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--max-citation-recall-drop") {
      out.maxCitationRecallDrop = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--require-thresholds") {
      out.requireThresholds = true;
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
  args: HoldoutGateArgs,
): Promise<{ baseline: BaselineSnapshot | null; source?: string }> => {
  const baselinePath = normalize(args.baselinePath ?? process.env.AGI_HOLDOUT_BASELINE_PATH);
  const baselineManifestPath = normalize(
    args.baselineManifestPath ?? process.env.AGI_HOLDOUT_BASELINE_MANIFEST ?? DEFAULT_RC0_MANIFEST,
  );
  const rawBaseline = await loadJsonIfExists(baselinePath);
  if (rawBaseline) {
    const candidate = rawBaseline.metrics ?? rawBaseline;
    const surfaceShares = extractSurfaceShares(candidate) ?? extractSurfaceShares(rawBaseline);
    return {
      source: baselinePath,
      baseline: {
        precision: candidate.precision ?? candidate.citationPrecision,
        recall: candidate.recall ?? candidate.citationRecall,
        candidateRecall: candidate.candidateRecall,
        citationRecall: candidate.citationRecall,
        latencyMsAvg: candidate.latencyMsAvg,
        latencyMsP95: candidate.latencyMsP95,
        latencyMsP99: candidate.latencyMsP99,
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

const addConstraint = (
  constraints: GateConstraint[],
  input: {
    id: string;
    ok: boolean;
    value?: number | null;
    limit?: number | null;
    note?: string;
  },
): void => {
  constraints.push({
    id: input.id,
    severity: "HARD",
    status: input.ok ? "pass" : "fail",
    value: input.value ?? null,
    limit: input.limit !== undefined && input.limit !== null ? String(input.limit) : null,
    note: input.note,
  });
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
  const candidateRecallDrop =
    baseline?.candidateRecall !== undefined
      ? Math.max(0, baseline.candidateRecall - metrics.candidateRecall)
      : undefined;
  const citationRecallDrop =
    baseline?.citationRecall !== undefined
      ? Math.max(0, baseline.citationRecall - metrics.citationRecall)
      : undefined;

  const minPrecision =
    args.minPrecision ?? parseNumber(process.env.AGI_HOLDOUT_MIN_PRECISION);
  const minRecall =
    args.minRecall ?? parseNumber(process.env.AGI_HOLDOUT_MIN_RECALL);
  const minCandidateRecall =
    args.minCandidateRecall ??
    parseNumber(process.env.AGI_HOLDOUT_MIN_CANDIDATE_RECALL);
  const minCitationRecall =
    args.minCitationRecall ??
    parseNumber(process.env.AGI_HOLDOUT_MIN_CITATION_RECALL);
  const maxLatencyAvgMs =
    args.maxLatencyAvgMs ??
    parseNumber(process.env.AGI_HOLDOUT_MAX_LATENCY_AVG_MS);
  const maxLatencyP95Ms =
    args.maxLatencyP95Ms ??
    parseNumber(process.env.AGI_HOLDOUT_MAX_LATENCY_P95_MS);
  const maxLatencyP99Ms =
    args.maxLatencyP99Ms ??
    parseNumber(process.env.AGI_HOLDOUT_MAX_LATENCY_P99_MS);
  const minTotal =
    args.minTotal ?? parseNumber(process.env.AGI_HOLDOUT_MIN_TOTAL);
  const maxSurfaceMixDelta =
    args.maxSurfaceMixDelta ??
    parseNumber(process.env.AGI_HOLDOUT_MAX_SURFACE_MIX_DELTA);
  const maxCandidateRecallDrop =
    args.maxCandidateRecallDrop ??
    parseNumber(process.env.AGI_HOLDOUT_MAX_CANDIDATE_RECALL_DROP);
  const maxCitationRecallDrop =
    args.maxCitationRecallDrop ??
    parseNumber(process.env.AGI_HOLDOUT_MAX_CITATION_RECALL_DROP);
  const requireThresholds =
    args.requireThresholds ?? process.env.AGI_HOLDOUT_REQUIRE_THRESHOLDS === "1";

  const constraints: GateConstraint[] = [];
  if (minTotal !== undefined) {
    addConstraint(constraints, {
      id: "holdout_total_min",
      ok: metrics.total >= minTotal,
      value: metrics.total,
      limit: minTotal,
    });
  }
  if (minPrecision !== undefined) {
    addConstraint(constraints, {
      id: "holdout_precision_min",
      ok: metrics.precision >= minPrecision,
      value: metrics.precision,
      limit: minPrecision,
    });
  }
  if (minRecall !== undefined) {
    addConstraint(constraints, {
      id: "holdout_recall_min",
      ok: metrics.recall >= minRecall,
      value: metrics.recall,
      limit: minRecall,
    });
  }
  if (minCandidateRecall !== undefined) {
    addConstraint(constraints, {
      id: "holdout_candidate_recall_min",
      ok: metrics.candidateRecall >= minCandidateRecall,
      value: metrics.candidateRecall,
      limit: minCandidateRecall,
    });
  }
  if (minCitationRecall !== undefined) {
    addConstraint(constraints, {
      id: "holdout_citation_recall_min",
      ok: metrics.citationRecall >= minCitationRecall,
      value: metrics.citationRecall,
      limit: minCitationRecall,
    });
  }
  if (maxLatencyAvgMs !== undefined) {
    addConstraint(constraints, {
      id: "holdout_latency_avg_max_ms",
      ok: metrics.latencyMsAvg <= maxLatencyAvgMs,
      value: metrics.latencyMsAvg,
      limit: maxLatencyAvgMs,
    });
  }
  if (maxLatencyP95Ms !== undefined) {
    addConstraint(constraints, {
      id: "holdout_latency_p95_max_ms",
      ok: metrics.latencyMsP95 <= maxLatencyP95Ms,
      value: metrics.latencyMsP95,
      limit: maxLatencyP95Ms,
    });
  }
  if (maxLatencyP99Ms !== undefined) {
    addConstraint(constraints, {
      id: "holdout_latency_p99_max_ms",
      ok: metrics.latencyMsP99 <= maxLatencyP99Ms,
      value: metrics.latencyMsP99,
      limit: maxLatencyP99Ms,
    });
  }
  if (maxSurfaceMixDelta !== undefined && surfaceMixDelta !== undefined) {
    addConstraint(constraints, {
      id: "holdout_surface_mix_delta_max",
      ok: surfaceMixDelta <= maxSurfaceMixDelta,
      value: surfaceMixDelta,
      limit: maxSurfaceMixDelta,
    });
  }
  if (maxCandidateRecallDrop !== undefined && candidateRecallDrop !== undefined) {
    addConstraint(constraints, {
      id: "holdout_candidate_recall_drop_max",
      ok: candidateRecallDrop <= maxCandidateRecallDrop,
      value: candidateRecallDrop,
      limit: maxCandidateRecallDrop,
    });
  }
  if (maxCitationRecallDrop !== undefined && citationRecallDrop !== undefined) {
    addConstraint(constraints, {
      id: "holdout_citation_recall_drop_max",
      ok: citationRecallDrop <= maxCitationRecallDrop,
      value: citationRecallDrop,
      limit: maxCitationRecallDrop,
    });
  }

  const hasThresholds = constraints.length > 0;
  if (requireThresholds && !hasThresholds) {
    addConstraint(constraints, {
      id: "holdout_thresholds_missing",
      ok: false,
      note: "No thresholds provided; set env or CLI thresholds.",
    });
  }

  const firstFail = constraints.find((constraint) => constraint.status === "fail");
  const pass = !firstFail;
  const verdict = pass ? "PASS" : "FAIL";

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
  if (candidateRecallDrop !== undefined) {
    metricsPayload.holdout_candidate_recall_drop = candidateRecallDrop;
  }
  if (citationRecallDrop !== undefined) {
    metricsPayload.holdout_citation_recall_drop = citationRecallDrop;
  }
  for (const [key, value] of Object.entries(surfaceShares)) {
    metricsPayload[`holdout_surface_share_${key}`] = value;
  }

  const notes = [
    args.label ? `label=${args.label}` : null,
    baselineSource ? `baseline=${baselineSource}` : null,
  ].filter(Boolean) as string[];

  recordTrainingTrace({
    pass,
    deltas,
    metrics: metricsPayload,
    firstFail: firstFail
      ? {
          id: firstFail.id,
          severity: firstFail.severity,
          status: firstFail.status,
          value: firstFail.value ?? null,
          limit: firstFail.limit ?? null,
          note: firstFail.note,
        }
      : undefined,
    source: { system: "agi-refinery", component: "holdout", tool: "gate" },
    notes: notes.length > 0 ? notes : undefined,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const outPath = args.outPath
    ? path.resolve(args.outPath)
    : resolveArtifactsPath(`agi-refinery-holdout-gate.${stamp}.json`);
  await ensureArtifactsDir(outPath);
  const payload = {
    verdict,
    pass,
    holdoutPath,
    totalHoldout: holdoutTrajectories.length,
    metrics,
    thresholds: {
      minPrecision,
      minRecall,
      minCandidateRecall,
      minCitationRecall,
      maxLatencyAvgMs,
      maxLatencyP95Ms,
      maxLatencyP99Ms,
      minTotal,
      maxSurfaceMixDelta,
      maxCandidateRecallDrop,
      maxCitationRecallDrop,
      requireThresholds,
    },
    drift: {
      surfaceMixDelta: surfaceMixDelta ?? null,
      candidateRecallDrop: candidateRecallDrop ?? null,
      citationRecallDrop: citationRecallDrop ?? null,
      baselineSource: baselineSource ?? null,
    },
    constraints,
    firstFail: firstFail ?? null,
    label: args.label ?? null,
  };
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outPath, ...payload }, null, 2));
  if (!pass) {
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
