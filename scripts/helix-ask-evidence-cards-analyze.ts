import fs from "node:fs/promises";
import path from "node:path";

type Variant = "A" | "B" | "C";

type DebugEvent = { stage?: string; durationMs?: number };
type DebugPayload = Record<string, unknown> & {
  live_events?: DebugEvent[];
  trace_events?: DebugEvent[];
  stage_timing_ms?: Record<string, number>;
};

type RawRun = {
  variant: Variant;
  prompt_id: string;
  bucket: string;
  prompt: string;
  seed: number;
  latency_ms: number;
  status: number;
  response: {
    text?: string;
    debug?: DebugPayload;
  };
};

type Stats = { p50: number; p95: number; mean: number };

const ROOT = process.env.HELIX_ASK_AB_OUT ?? "artifacts/evidence-cards-ab";
const REPORT_PATH =
  process.env.HELIX_ASK_AB_REPORT ?? "reports/helix-ask-evidence-cards-ab.md";
const REPO_ROOT = process.cwd();
const N_BOOT = Number(process.env.HELIX_ASK_AB_BOOTSTRAP ?? 1200);

const MIN_VALID_PER_VARIANT = Number(
  process.env.HELIX_ASK_AB_MIN_VALID_PER_VARIANT ?? 200,
);
const MAX_INVALID_RATE = Number(
  process.env.HELIX_ASK_AB_MAX_INVALID_RATE ?? 0.1,
);
const MIN_PAIR_COUNT = Number(process.env.HELIX_ASK_AB_MIN_PAIR_COUNT ?? 180);

const normalizeFinite = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
};

const quantile = (arr: number[], p: number): number => {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] ?? 0;
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? loVal;
  return loVal + (hiVal - loVal) * (idx - lo);
};

const summarizeStats = (arr: number[]): Stats => ({
  p50: quantile(arr, 0.5),
  p95: quantile(arr, 0.95),
  mean: arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0,
});

const ratio = (values: Array<boolean | null | undefined>): number | null => {
  const valid = values.filter((v): v is boolean => typeof v === "boolean");
  if (!valid.length) return null;
  return valid.filter(Boolean).length / valid.length;
};

const numRatio = (num: number, den: number): number | null =>
  den > 0 ? num / den : null;

const isValidRun = (row: RawRun): boolean => row.status === 200;

const buildStatusCounts = (rows: RawRun[]): Record<string, number> => {
  const counts = new Map<number, number>();
  for (const row of rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  const out: Record<string, number> = {};
  for (const [status, count] of counts.entries()) out[String(status)] = count;
  return out;
};

const extractPaths = (text: string): string[] => {
  const matches =
    text.match(
      /\b[a-zA-Z0-9_./-]+\.(?:ts|tsx|js|mjs|cjs|md|json|yml|yaml)\b/g,
    ) ?? [];
  return [...new Set(matches)];
};

const fileExistsCache = new Map<string, boolean>();

const existsPath = async (p: string): Promise<boolean> => {
  if (fileExistsCache.has(p)) return fileExistsCache.get(p) ?? false;
  const abs = path.resolve(REPO_ROOT, p);
  try {
    await fs.access(abs);
    fileExistsCache.set(p, true);
    return true;
  } catch {
    fileExistsCache.set(p, false);
    return false;
  }
};

const getStageLatency = (
  debug: DebugPayload | undefined,
  stage: "llm_evidence_cards" | "llm_answer",
): number | null => {
  const mapValue = normalizeFinite(debug?.stage_timing_ms?.[stage]);
  if (mapValue !== null) return mapValue;
  const expected =
    stage === "llm_evidence_cards"
      ? "llm evidence cards"
      : "llm answer";
  const events = [...(debug?.live_events ?? []), ...(debug?.trace_events ?? [])];
  for (const event of events) {
    const label = String(event?.stage ?? "").trim().toLowerCase();
    if (label === expected) {
      const ms = normalizeFinite(event?.durationMs);
      if (ms !== null) return ms;
    }
  }
  return null;
};

const loadRuns = async (variant: Variant): Promise<RawRun[]> => {
  const dir = path.join(ROOT, variant, "raw");
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      console.warn(`[helix-ask-ab] missing variant directory: ${dir}`);
      return [];
    }
    throw error;
  }
  const rows: RawRun[] = [];
  for (const file of files) {
    const row = JSON.parse(
      await fs.readFile(path.join(dir, file), "utf8"),
    ) as RawRun;
    rows.push(row);
  }
  return rows;
};

const bootstrapCI = (deltas: number[]): { low: number; high: number } => {
  if (!deltas.length) return { low: 0, high: 0 };
  const samples: number[] = [];
  for (let i = 0; i < N_BOOT; i += 1) {
    let sum = 0;
    for (let j = 0; j < deltas.length; j += 1) {
      const pick = deltas[Math.floor(Math.random() * deltas.length)] ?? 0;
      sum += pick;
    }
    samples.push(sum / deltas.length);
  }
  return { low: quantile(samples, 0.025), high: quantile(samples, 0.975) };
};

const summarizeVariant = async (rows: RawRun[]) => {
  const validRows = rows.filter(isValidRun);
  const invalidRows = rows.filter((row) => !isValidRun(row));

  const latencyValid = validRows.map((row) => row.latency_ms);
  const latencyAll = rows.map((row) => row.latency_ms);
  const stageEvidence = validRows
    .map((row) => getStageLatency(row.response.debug, "llm_evidence_cards"))
    .filter((v): v is number => v !== null);
  const stageAnswer = validRows
    .map((row) => getStageLatency(row.response.debug, "llm_answer"))
    .filter((v): v is number => v !== null);

  const evidenceGate = ratio(
    validRows.map((row) => row.response.debug?.evidence_gate_ok as boolean | undefined),
  );
  const slotCoverage = ratio(
    validRows.map((row) => row.response.debug?.slot_coverage_ok as boolean | undefined),
  );
  const contractPrimary = ratio(
    validRows.map(
      (row) => row.response.debug?.answer_contract_primary_applied as boolean | undefined,
    ),
  );
  const deterministicFallback = ratio(
    validRows.map((row) => {
      const repoPath = String(row.response.debug?.synthesis_repo_path ?? "");
      const answerPath = String(row.response.debug?.answer_path ?? "");
      return (
        repoPath.toLowerCase().includes("deterministic") ||
        answerPath.toLowerCase().includes("deterministic_pre_llm")
      );
    }),
  );

  let claimSupported = 0;
  let claimTotal = 0;
  let groundedSum = 0;
  let groundedCount = 0;
  let contradictionOrUnsupported = 0;
  let citationOk = 0;
  let citationTotal = 0;
  let parseFail = 0;

  for (const row of validRows) {
    const debug = row.response.debug ?? {};
    claimSupported += Number(debug.evidence_claim_supported ?? 0);
    claimTotal += Number(debug.evidence_claim_count ?? 0);
    groundedSum += Number(debug.grounded_sentence_rate ?? 0);
    groundedCount += 1;
    contradictionOrUnsupported +=
      Number(debug.belief_contradictions ?? 0) + Number(debug.belief_unsupported_count ?? 0);

    const text = row.response.text ?? "";
    const paths = extractPaths(text);
    for (const ref of paths) {
      citationTotal += 1;
      if (await existsPath(ref)) citationOk += 1;
    }

    const answerPath = String(debug.answer_path ?? "").toLowerCase();
    if (answerPath.includes("parsefail")) parseFail += 1;
  }

  return {
    n_total: rows.length,
    n_valid: validRows.length,
    n_invalid: invalidRows.length,
    invalid_rate: numRatio(invalidRows.length, rows.length),
    status_counts: buildStatusCounts(rows),
    latency_ms: summarizeStats(latencyValid),
    latency_all_ms: summarizeStats(latencyAll),
    stage_latency_ms: {
      llm_evidence_cards: summarizeStats(stageEvidence),
      llm_answer: summarizeStats(stageAnswer),
    },
    evidence_gate_pass_rate: evidenceGate,
    evidence_gate_ratio: evidenceGate,
    slot_coverage_pass_rate: slotCoverage,
    claim_gate_supported_ratio: numRatio(claimSupported, claimTotal),
    citation_validity_rate: numRatio(citationOk, citationTotal),
    contract_success_rate: {
      answer_contract_primary_applied: contractPrimary,
      parse_fail_frequency: numRatio(parseFail, validRows.length),
      deterministic_fallback_frequency: deterministicFallback,
    },
    quality_proxy: {
      grounded_sentence_rate: numRatio(groundedSum, groundedCount),
      contradiction_or_unsupported_rate: numRatio(
        contradictionOrUnsupported,
        validRows.length,
      ),
    },
  };
};

const pairedDelta = (
  baseline: RawRun[],
  candidate: RawRun[],
  metric: (row: RawRun) => number,
) => {
  const baseMap = new Map<string, number>();
  for (const row of baseline) {
    if (!isValidRun(row)) continue;
    baseMap.set(`${row.prompt_id}::${row.seed}`, metric(row));
  }
  const deltas: number[] = [];
  for (const row of candidate) {
    if (!isValidRun(row)) continue;
    const key = `${row.prompt_id}::${row.seed}`;
    const base = baseMap.get(key);
    if (typeof base === "number") deltas.push(metric(row) - base);
  }
  const mean = deltas.length
    ? deltas.reduce((a, b) => a + b, 0) / deltas.length
    : 0;
  const ci = bootstrapCI(deltas);
  return {
    pair_count: deltas.length,
    mean,
    ci,
    significant: !(ci.low <= 0 && ci.high >= 0),
  };
};

const boolString = (value: boolean): string => (value ? "pass" : "fail");

const toMdJson = (value: unknown): string => {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
};

const buildReport = (summary: any, recommendation: any): string => {
  const lines: string[] = [];
  lines.push("# Helix Ask evidence cards A/B/C report");
  lines.push("");
  lines.push(
    `- Generated: ${new Date(summary.metadata.generated_at).toISOString()}`,
  );
  lines.push("- Primary metric computation: valid runs only (status=200)");
  lines.push(
    `- Decision gates: run_quality=${boolString(
      summary.decision_gates.pass,
    )} (min_valid=${summary.decision_gates.min_valid_per_variant}, max_invalid_rate=${summary.decision_gates.max_invalid_rate}, min_pair_count=${summary.decision_gates.min_pair_count})`,
  );
  lines.push(`- Recommendation: ${recommendation.recommendation}`);
  lines.push("");

  lines.push("## Variant metrics");
  lines.push("");
  for (const variant of ["A", "B", "C"] as const) {
    lines.push(`### ${variant}`);
    lines.push("");
    lines.push(toMdJson(summary.variants[variant]));
    lines.push("");
  }

  lines.push("## Paired deltas (valid pairs only)");
  lines.push("");
  lines.push(toMdJson(summary.paired_deltas));
  lines.push("");

  lines.push("## Recommendation payload");
  lines.push("");
  lines.push(toMdJson(recommendation));
  lines.push("");
  return lines.join("\n");
};

const main = async () => {
  const runsA = await loadRuns("A");
  const runsB = await loadRuns("B");
  const runsC = await loadRuns("C");

  const summary = {
    metadata: {
      generated_at: Date.now(),
      root: ROOT,
      valid_only_metrics: true,
    },
    variants: {
      A: await summarizeVariant(runsA),
      B: await summarizeVariant(runsB),
      C: await summarizeVariant(runsC),
    },
    paired_deltas: {
      A_vs_B: {
        latency_ms: pairedDelta(runsA, runsB, (row) => row.latency_ms),
        grounded_sentence_rate: pairedDelta(
          runsA,
          runsB,
          (row) => Number(row.response.debug?.grounded_sentence_rate ?? 0),
        ),
        has_citation_indicator: pairedDelta(runsA, runsB, (row) => {
          const refs = extractPaths(row.response.text ?? "");
          return refs.length > 0 ? 1 : 0;
        }),
      },
      C_vs_B: {
        latency_ms: pairedDelta(runsB, runsC, (row) => row.latency_ms),
        grounded_sentence_rate: pairedDelta(
          runsB,
          runsC,
          (row) => Number(row.response.debug?.grounded_sentence_rate ?? 0),
        ),
        has_citation_indicator: pairedDelta(runsB, runsC, (row) => {
          const refs = extractPaths(row.response.text ?? "");
          return refs.length > 0 ? 1 : 0;
        }),
      },
    },
  };

  const validCounts = {
    A: summary.variants.A.n_valid,
    B: summary.variants.B.n_valid,
    C: summary.variants.C.n_valid,
  };
  const invalidRates = {
    A: summary.variants.A.invalid_rate ?? 1,
    B: summary.variants.B.invalid_rate ?? 1,
    C: summary.variants.C.invalid_rate ?? 1,
  };
  const pairCounts = {
    A_vs_B: summary.paired_deltas.A_vs_B.latency_ms.pair_count,
    C_vs_B: summary.paired_deltas.C_vs_B.latency_ms.pair_count,
  };

  const runQualityPass =
    Math.min(validCounts.A, validCounts.B, validCounts.C) >= MIN_VALID_PER_VARIANT &&
    Math.max(invalidRates.A, invalidRates.B, invalidRates.C) <= MAX_INVALID_RATE &&
    Math.min(pairCounts.A_vs_B, pairCounts.C_vs_B) >= MIN_PAIR_COUNT;

  const qualityDelta =
    (summary.variants.B.quality_proxy.grounded_sentence_rate ?? 0) -
    (summary.variants.A.quality_proxy.grounded_sentence_rate ?? 0);
  const latencyDeltaRatio =
    (summary.variants.B.latency_ms.p95 - summary.variants.A.latency_ms.p95) /
    Math.max(1, summary.variants.A.latency_ms.p95);

  let recommendation = "disable_by_default";
  if (!runQualityPass) {
    recommendation = "insufficient_run_quality";
  } else if (qualityDelta >= 0.05 && latencyDeltaRatio <= 0.15) {
    recommendation = "keep_adaptive";
  } else if (qualityDelta > 0 && latencyDeltaRatio > 0.15) {
    recommendation = "tighten_threshold";
  }

  const decisionGates = {
    min_valid_per_variant: MIN_VALID_PER_VARIANT,
    max_invalid_rate: MAX_INVALID_RATE,
    min_pair_count: MIN_PAIR_COUNT,
    valid_counts: validCounts,
    invalid_rates: invalidRates,
    pair_counts: pairCounts,
    pass: runQualityPass,
  };

  const recommendationPayload = {
    recommendation,
    quality_delta_grounded_sentence_rate: qualityDelta,
    latency_delta_p95_ratio: latencyDeltaRatio,
    valid_counts: validCounts,
    invalid_counts: {
      A: summary.variants.A.n_invalid,
      B: summary.variants.B.n_invalid,
      C: summary.variants.C.n_invalid,
    },
    decision_gates: decisionGates,
  };

  const enrichedSummary = {
    ...summary,
    decision_gates: decisionGates,
  };

  await fs.mkdir(ROOT, { recursive: true });
  await fs.writeFile(
    path.join(ROOT, "summary.json"),
    JSON.stringify(enrichedSummary, null, 2),
    "utf8",
  );
  await fs.writeFile(
    path.join(ROOT, "recommendation.json"),
    JSON.stringify(recommendationPayload, null, 2),
    "utf8",
  );

  const reportBody = buildReport(enrichedSummary, recommendationPayload);
  await fs.mkdir(path.dirname(path.resolve(REPORT_PATH)), { recursive: true });
  await fs.writeFile(path.resolve(REPORT_PATH), reportBody, "utf8");

  console.log(JSON.stringify(recommendationPayload, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
