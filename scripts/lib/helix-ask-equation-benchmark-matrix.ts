export type EquationBenchmarkMatrixSummary = {
  name: string;
  total: number;
  pass: number;
  fail: number;
  passRate: number;
  avgScore: number;
  p95LatencyMs: number;
  failureCount: number;
};

export type EquationBenchmarkMatrixRecommendation = {
  best: EquationBenchmarkMatrixSummary;
  baseline: EquationBenchmarkMatrixSummary | null;
  deltasFromBaseline: {
    passRateDelta: number;
    avgScoreDelta: number;
    p95LatencyDeltaMs: number;
    failureCountDelta: number;
  } | null;
  ranked: EquationBenchmarkMatrixSummary[];
};

const rankValue = (entry: EquationBenchmarkMatrixSummary): number => {
  const passRateTerm = entry.passRate * 1000;
  const avgScoreTerm = entry.avgScore * 10;
  const latencyPenalty = Math.max(0, entry.p95LatencyMs) * 0.02;
  const failurePenalty = entry.failureCount * 2;
  return Number((passRateTerm + avgScoreTerm - latencyPenalty - failurePenalty).toFixed(4));
};

export const rankEquationBenchmarkSummaries = (
  entries: EquationBenchmarkMatrixSummary[],
): EquationBenchmarkMatrixSummary[] =>
  [...entries].sort((a, b) => {
    const rankDelta = rankValue(b) - rankValue(a);
    if (Math.abs(rankDelta) > 1e-9) return rankDelta > 0 ? 1 : -1;
    if (b.passRate !== a.passRate) return b.passRate - a.passRate;
    if (b.avgScore !== a.avgScore) return b.avgScore - a.avgScore;
    if (a.p95LatencyMs !== b.p95LatencyMs) return a.p95LatencyMs - b.p95LatencyMs;
    if (a.failureCount !== b.failureCount) return a.failureCount - b.failureCount;
    return a.name.localeCompare(b.name);
  });

export const recommendEquationBenchmarkProfile = (args: {
  summaries: EquationBenchmarkMatrixSummary[];
  baselineName?: string | null;
}): EquationBenchmarkMatrixRecommendation | null => {
  const summaries = args.summaries ?? [];
  if (summaries.length === 0) return null;
  const ranked = rankEquationBenchmarkSummaries(summaries);
  const best = ranked[0]!;
  const baseline =
    (args.baselineName
      ? summaries.find((entry) => entry.name === args.baselineName)
      : null) ?? summaries.find((entry) => entry.name === "baseline") ?? null;
  const deltasFromBaseline = baseline
    ? {
        passRateDelta: Number((best.passRate - baseline.passRate).toFixed(4)),
        avgScoreDelta: Number((best.avgScore - baseline.avgScore).toFixed(2)),
        p95LatencyDeltaMs: Number((best.p95LatencyMs - baseline.p95LatencyMs).toFixed(2)),
        failureCountDelta: best.failureCount - baseline.failureCount,
      }
    : null;

  return {
    best,
    baseline,
    deltasFromBaseline,
    ranked,
  };
};
