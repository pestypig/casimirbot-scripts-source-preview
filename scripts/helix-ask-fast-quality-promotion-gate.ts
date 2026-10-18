import fs from "node:fs/promises";
import path from "node:path";

type SweepSummary = {
  config: string;
  total: number;
  ok: number;
  hard_fail: number;
  avg_duration_ms?: number;
  p50_duration_ms?: number;
  p95_duration_ms?: number;
  avg_quality_score: number;
  quality_rate: number;
};

type SweepEntry = {
  summary: SweepSummary;
};

type QualityRun = {
  config: string;
  avg_duration_ms: number;
  p95_duration_ms: number;
  quality_score: number;
  evidence_gate_ok_rate: number;
  coverage_ratio_avg: number;
  belief_unsupported_rate_avg: number;
};

type QualityArtifact = {
  runs: QualityRun[];
};

const ARTIFACT_DIR = path.resolve(process.env.HELIX_ASK_SWEEP_OUT_DIR ?? "artifacts/helix-ask-latency");
const SWEEP_PATH = process.env.HELIX_ASK_SWEEP_ARTIFACT;
const QUALITY_PATH = process.env.HELIX_ASK_QUALITY_ARTIFACT ?? path.join(ARTIFACT_DIR, "quality-vs-latency-fast-quality-mode.json");
const BASELINE = process.env.HELIX_ASK_GATE_BASELINE ?? "quality_extended";
const CANDIDATE = process.env.HELIX_ASK_GATE_CANDIDATE ?? "fast_quality_mode";

const QUALITY_DROP_EPS = Number(process.env.HELIX_ASK_GATE_QUALITY_DROP_EPS ?? "0.02");
const EVIDENCE_DROP_EPS = Number(process.env.HELIX_ASK_GATE_EVIDENCE_DROP_EPS ?? "0.01");
const COVERAGE_DROP_EPS = Number(process.env.HELIX_ASK_GATE_COVERAGE_DROP_EPS ?? "0.02");
const REQUIRE_P95_IMPROVEMENT = process.env.HELIX_ASK_GATE_REQUIRE_P95_IMPROVEMENT !== "0";
const DEFAULT_ROLLOUT_MIN_QUALITY_DELTA = Number(process.env.HELIX_ASK_GATE_DEFAULT_MIN_QUALITY_DELTA ?? "0.01");
const DEFAULT_ROLLOUT_MIN_P95_GAIN_MS = Number(process.env.HELIX_ASK_GATE_DEFAULT_MIN_P95_GAIN_MS ?? "50");

const latestSweepPath = async (): Promise<string> => {
  if (SWEEP_PATH) return path.resolve(SWEEP_PATH);
  const entries = await fs.readdir(ARTIFACT_DIR);
  const matches = entries
    .filter((entry) => /^helix-ask-sweep\..+\.json$/.test(entry))
    .sort();
  if (!matches.length) {
    throw new Error(`No sweep artifact found in ${ARTIFACT_DIR}`);
  }
  return path.join(ARTIFACT_DIR, matches[matches.length - 1]!);
};

const readJson = async <T>(filePath: string): Promise<T> => {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
};

const findSummary = (entries: SweepEntry[], config: string): SweepSummary => {
  const entry = entries.find((item) => item.summary?.config === config);
  if (!entry?.summary) {
    throw new Error(`Missing sweep summary for config=${config}`);
  }
  return entry.summary;
};

const findQuality = (artifact: QualityArtifact, config: string): QualityRun => {
  const run = artifact.runs.find((item) => item.config === config);
  if (!run) {
    throw new Error(`Missing quality artifact run for config=${config}`);
  }
  return run;
};

async function main() {
  const sweepFile = await latestSweepPath();
  const sweep = await readJson<SweepEntry[]>(sweepFile);
  const quality = await readJson<QualityArtifact>(path.resolve(QUALITY_PATH));

  const baselineSweep = findSummary(sweep, BASELINE);
  const candidateSweep = findSummary(sweep, CANDIDATE);
  const baselineQuality = findQuality(quality, "baseline");
  const candidateQuality = findQuality(quality, CANDIDATE);

  const failures: string[] = [];

  if (candidateSweep.avg_quality_score + QUALITY_DROP_EPS < baselineSweep.avg_quality_score) {
    failures.push(
      `avg_quality_score dropped baseline=${baselineSweep.avg_quality_score} candidate=${candidateSweep.avg_quality_score}`,
    );
  }
  if (candidateQuality.evidence_gate_ok_rate + EVIDENCE_DROP_EPS < baselineQuality.evidence_gate_ok_rate) {
    failures.push(
      `evidence_gate_ok_rate dropped baseline=${baselineQuality.evidence_gate_ok_rate} candidate=${candidateQuality.evidence_gate_ok_rate}`,
    );
  }
  if (candidateQuality.coverage_ratio_avg + COVERAGE_DROP_EPS < baselineQuality.coverage_ratio_avg) {
    failures.push(
      `coverage_ratio_avg dropped baseline=${baselineQuality.coverage_ratio_avg} candidate=${candidateQuality.coverage_ratio_avg}`,
    );
  }
  if (candidateQuality.belief_unsupported_rate_avg > 0) {
    failures.push(
      `belief_unsupported_rate_avg must remain 0, got ${candidateQuality.belief_unsupported_rate_avg}`,
    );
  }
  if (
    typeof baselineSweep.avg_duration_ms === "number" &&
    typeof candidateSweep.avg_duration_ms === "number" &&
    candidateSweep.avg_duration_ms > baselineSweep.avg_duration_ms
  ) {
    failures.push(
      `avg_duration_ms must improve baseline=${baselineSweep.avg_duration_ms} candidate=${candidateSweep.avg_duration_ms}`,
    );
  }
  if (
    REQUIRE_P95_IMPROVEMENT &&
    typeof baselineSweep.p95_duration_ms === "number" &&
    typeof candidateSweep.p95_duration_ms === "number" &&
    candidateSweep.p95_duration_ms > baselineSweep.p95_duration_ms
  ) {
    failures.push(
      `p95_duration_ms must improve baseline=${baselineSweep.p95_duration_ms} candidate=${candidateSweep.p95_duration_ms}`,
    );
  }

  const summary = {
    rollout: {
      canaryRecommended: failures.length === 0,
      defaultRecommended:
        failures.length === 0 &&
        candidateSweep.avg_quality_score >= baselineSweep.avg_quality_score + DEFAULT_ROLLOUT_MIN_QUALITY_DELTA &&
        typeof baselineSweep.p95_duration_ms === "number" &&
        typeof candidateSweep.p95_duration_ms === "number" &&
        baselineSweep.p95_duration_ms - candidateSweep.p95_duration_ms >= DEFAULT_ROLLOUT_MIN_P95_GAIN_MS,
      defaultRolloutThresholds: {
        minQualityDelta: DEFAULT_ROLLOUT_MIN_QUALITY_DELTA,
        minP95GainMs: DEFAULT_ROLLOUT_MIN_P95_GAIN_MS,
      },
    },
    sweepFile,
    qualityFile: path.resolve(QUALITY_PATH),
    baseline: {
      sweep: baselineSweep,
      quality: baselineQuality,
    },
    candidate: {
      sweep: candidateSweep,
      quality: candidateQuality,
    },
    verdict: failures.length ? "FAIL" : "PASS",
    failures,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (failures.length) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("[helix-ask-fast-quality-promotion-gate] failed", error);
  process.exit(1);
});
