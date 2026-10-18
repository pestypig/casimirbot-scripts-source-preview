import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:5173";
const BASELINE_RUN_ID = process.env.HELIX_ASK_BASELINE_RUN_ID ?? "versatility-1771461446899";
const BASELINE_SUMMARY_PATH = process.env.HELIX_ASK_BASELINE_SUMMARY_PATH ?? "";
const BASELINE_DEFAULT = {
  relation_packet_built_rate: 0.8667,
  relation_dual_domain_ok_rate: 0.8667,
  report_mode_correct_rate: 0.9222,
};

const GATES = {
  relation_packet_built_rate: 0.95,
  relation_dual_domain_ok_rate: 0.95,
  report_mode_correct_rate: 0.98,
};

type Candidate = {
  id: string;
  weights: {
    balanced: { goal: number; evidenceGain: number; latencyCost: number; risk: number; budgetPressure: number };
    evidence_first: { goal: number; evidenceGain: number; latencyCost: number; risk: number; budgetPressure: number };
    latency_first: { goal: number; evidenceGain: number; latencyCost: number; risk: number; budgetPressure: number };
  };
};

type EvalResult = {
  id: string;
  metrics: {
    relation_packet_built_rate: number;
    relation_dual_domain_ok_rate: number;
    report_mode_correct_rate: number;
  };
  passes: boolean;
  decision_grade_ready: boolean;
  provenance_gate_pass: boolean;
  run_complete: boolean;
  provenance_warnings: string[];
  score: number;
  summaryPath: string;
};

type GateAssessment = {
  metric: keyof typeof GATES;
  actual: number;
  threshold: number;
  comparator: ">=";
  pass: boolean;
};

type BaselineMetrics = {
  relation_packet_built_rate: number;
  relation_dual_domain_ok_rate: number;
  report_mode_correct_rate: number;
};

type BaselineResolution = {
  metrics: BaselineMetrics;
  source: string;
  warnings: string[];
};

const nowStamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

const postAskProbe = async (): Promise<{ status: number; ok: boolean; body: Record<string, unknown> }> => {
  const response = await fetch(new URL("/api/agi/ask", BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      question: "health check",
      temperature: 0,
      seed: 7,
      debug: true,
      sessionId: `helix-ps3-availability-${Date.now()}`,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, ok: response.status === 200, body };
};

const getReadyProbe = async (): Promise<{ status: number; ok: boolean; body: Record<string, unknown> }> => {
  const response = await fetch(new URL("/api/ready", BASE_URL));
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, ok: response.status === 200, body };
};

const postAdapterProbe = async (): Promise<{ status: number; ok: boolean; body: Record<string, unknown> }> => {
  const response = await fetch(new URL("/api/agi/adapter/run", BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pack: "repo-convergence",
      dryRun: true,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, ok: response.status >= 200 && response.status < 500, body };
};

type SpawnExecution = {
  command: string;
  args: string[];
  shell: boolean;
};

export const buildSpawnExecution = (command: string, args: string[], platform = process.platform): SpawnExecution => {
  if (platform === "win32") {
    return {
      command: [command, ...args].join(" "),
      args: [],
      shell: true,
    };
  }

  return {
    command,
    args,
    shell: false,
  };
};

const runCommand = async (command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> => {
  const { spawn } = await import("node:child_process");
  const execution = buildSpawnExecution(command, args);
  return await new Promise((resolve) => {
    const child = spawn(execution.command, execution.args, {
      env: { ...process.env, ...env },
      cwd: process.cwd(),
      shell: execution.shell,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(text);
    });
    child.on("exit", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
};


export const extractStopReason = (row: Record<string, unknown>): string => {
  const debug = row.debug;
  const debugRecord = debug && typeof debug === "object" ? (debug as Record<string, unknown>) : undefined;
  return String(
    debugRecord?.agent_stop_reason ??
      debugRecord?.controller_stop_reason ??
      row.stop_reason ??
      "",
  );
};

const gatePassForRate = (actual: number, threshold: number): boolean => actual >= threshold;

const buildGateAssessment = (metrics: EvalResult["metrics"]): GateAssessment[] => {
  return (Object.entries(GATES) as Array<[keyof typeof GATES, number]>).map(([metric, threshold]) => {
    const actual = Number(metrics[metric] ?? 0);
    const pass = gatePassForRate(actual, threshold);
    return { metric, actual, threshold, comparator: ">=", pass };
  });
};

const parseBaselineFromSummary = async (summaryPath: string): Promise<BaselineMetrics | null> => {
  try {
    const summaryRaw = await fs.readFile(summaryPath, "utf8");
    const summary = JSON.parse(summaryRaw) as {
      metrics?: {
        report_mode_correct_rate?: number;
        relation_packet_built_rate?: number;
        relation_dual_domain_ok_rate?: number;
      };
    };
    const relationPacket = Number(summary.metrics?.relation_packet_built_rate ?? Number.NaN);
    const relationDual = Number(summary.metrics?.relation_dual_domain_ok_rate ?? Number.NaN);
    const reportMode = Number(summary.metrics?.report_mode_correct_rate ?? Number.NaN);
    if (!Number.isFinite(relationPacket) || !Number.isFinite(relationDual) || !Number.isFinite(reportMode)) {
      return null;
    }
    return {
      relation_packet_built_rate: relationPacket,
      relation_dual_domain_ok_rate: relationDual,
      report_mode_correct_rate: reportMode,
    };
  } catch {
    return null;
  }
};

const resolveBaselineMetrics = async (): Promise<BaselineResolution> => {
  if (!BASELINE_SUMMARY_PATH.trim()) {
    return {
      metrics: BASELINE_DEFAULT,
      source: "default",
      warnings: ["baseline_summary_path_missing_using_default_metrics"],
    };
  }

  const resolved = path.resolve(BASELINE_SUMMARY_PATH);
  const parsed = await parseBaselineFromSummary(resolved);
  if (!parsed) {
    return {
      metrics: BASELINE_DEFAULT,
      source: "default",
      warnings: [`baseline_summary_invalid_or_unreadable:${resolved}`],
    };
  }

  return {
    metrics: parsed,
    source: resolved,
    warnings: [],
  };
};

const evaluateCandidate = async (candidate: Candidate, rootOutDir: string, baseline: BaselineMetrics): Promise<EvalResult> => {
  const runLabel = `${candidate.id}-${Date.now()}`;
  const runOutDir = path.join(rootOutDir, runLabel);
  await fs.mkdir(runOutDir, { recursive: true });

  const env = {
    HELIX_ASK_MOVE_PROFILE_WEIGHTS: JSON.stringify(candidate.weights),
    HELIX_ASK_VERSATILITY_OUT: runOutDir,
    HELIX_ASK_VERSATILITY_REPORT: path.join(runOutDir, "report.md"),
    HELIX_ASK_VERSATILITY_ISOLATE_RUN_DIR: "1",
    HELIX_ASK_VERSATILITY_RESUME_FROM_LATEST: "0",
    HELIX_ASK_VERSATILITY_START_SERVER: "0",
    HELIX_ASK_VERSATILITY_SEEDS: "7,11,13",
    HELIX_ASK_VERSATILITY_TEMPS: "0.2",
    HELIX_ASK_VERSATILITY_MAX_RETRIES: "3",
    HELIX_ASK_VERSATILITY_TIMEOUT_MS: "15000",
    HELIX_ASK_VERSATILITY_MAX_CASE_WALL_MS: "25000",
    HELIX_ASK_VERSATILITY_CHECKPOINT_EVERY: "10",
    HELIX_ASK_VERSATILITY_FAIL_ON_INCOMPLETE: "1",
  };

  const result = await runCommand("npx", ["tsx", "scripts/helix-ask-versatility-record.ts"], env);
  if (result.code !== 0) {
    return {
      id: candidate.id,
      metrics: {
        relation_packet_built_rate: 0,
        relation_dual_domain_ok_rate: 0,
        report_mode_correct_rate: 0,
      },
      passes: false,
      decision_grade_ready: false,
      provenance_gate_pass: false,
      run_complete: false,
      provenance_warnings: [],
      score: Number.NEGATIVE_INFINITY,
      summaryPath: path.join(runOutDir, "(failed run)"),
    };
  }

  const latestRaw = await fs.readFile(path.join(runOutDir, "latest.json"), "utf8");
  const latest = JSON.parse(latestRaw) as { output_run_dir: string };
  const summaryPath = path.resolve(latest.output_run_dir, "summary.json");
  const [summaryRaw] = await Promise.all([
    fs.readFile(summaryPath, "utf8"),
  ]);

  const summary = JSON.parse(summaryRaw) as {
    run_complete?: boolean;
    provenance?: {
      gate_pass?: boolean;
      warnings?: string[];
    };
    metrics?: {
      report_mode_correct_rate?: number;
      relation_packet_built_rate?: number;
      relation_dual_domain_ok_rate?: number;
    };
  };

  const metrics = {
    relation_packet_built_rate: Number(summary.metrics?.relation_packet_built_rate ?? 0),
    relation_dual_domain_ok_rate: Number(summary.metrics?.relation_dual_domain_ok_rate ?? 0),
    report_mode_correct_rate: Number(summary.metrics?.report_mode_correct_rate ?? 0),
  };

  const runComplete = summary.run_complete !== false;
  const provenanceGatePass = summary.provenance?.gate_pass === true;
  const provenanceWarnings = Array.isArray(summary.provenance?.warnings)
    ? summary.provenance?.warnings.filter((entry): entry is string => typeof entry === "string")
    : [];
  const decisionGradeReady = runComplete && provenanceGatePass;

  const passes =
    decisionGradeReady &&
    gatePassForRate(metrics.relation_packet_built_rate, GATES.relation_packet_built_rate) &&
    gatePassForRate(metrics.relation_dual_domain_ok_rate, GATES.relation_dual_domain_ok_rate) &&
    gatePassForRate(metrics.report_mode_correct_rate, GATES.report_mode_correct_rate);

  const score =
    (metrics.relation_packet_built_rate - baseline.relation_packet_built_rate) * 100 +
    (metrics.relation_dual_domain_ok_rate - baseline.relation_dual_domain_ok_rate) * 100 +
    (metrics.report_mode_correct_rate - baseline.report_mode_correct_rate) * 100 +
    (decisionGradeReady ? 0 : -1000);

  return {
    id: candidate.id,
    metrics,
    passes,
    decision_grade_ready: decisionGradeReady,
    provenance_gate_pass: provenanceGatePass,
    run_complete: runComplete,
    provenance_warnings: provenanceWarnings,
    score,
    summaryPath,
  };
};

async function main() {
  const timestamp = nowStamp();
  const outDir = path.join("artifacts", "experiments", "helix-ask-quake-weight-tuning", timestamp);
  await fs.mkdir(outDir, { recursive: true });

  const probes = {
    ready: [] as Array<{ idx: number; status: number; ok: boolean; reason?: string }>,
    adapter: [] as Array<{ idx: number; status: number; ok: boolean; reason?: string }>,
    ask: [] as Array<{ idx: number; status: number; ok: boolean; reason?: string }>,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    probes.ready = [];
    probes.adapter = [];
    probes.ask = [];

    const ready = await getReadyProbe();
    probes.ready.push({
      idx: attempt + 1,
      status: ready.status,
      ok: ready.ok,
      reason: String(ready.body.error ?? ready.body.message ?? ""),
    });

    const adapter = await postAdapterProbe();
    probes.adapter.push({
      idx: attempt + 1,
      status: adapter.status,
      ok: adapter.ok,
      reason: String(adapter.body.error ?? adapter.body.message ?? ""),
    });

    for (let i = 0; i < 3; i += 1) {
      const probe = await postAskProbe();
      probes.ask.push({
        idx: i + 1,
        status: probe.status,
        ok: probe.ok,
        reason: String(probe.body.fail_reason ?? probe.body.error ?? probe.body.message ?? ""),
      });
    }

    const availabilityOk = probes.ready.every((p) => p.ok) && probes.adapter.every((p) => p.ok) && probes.ask.every((p) => p.ok);
    if (availabilityOk) {
      break;
    }
  }

  const availabilityOk = probes.ready.every((p) => p.ok) && probes.adapter.every((p) => p.ok) && probes.ask.every((p) => p.ok);
  if (!availabilityOk) {
    const blocked = {
      status: "BLOCKED",
      baseline_run_id: BASELINE_RUN_ID,
      probes,
      message: "Availability gate failed: expected GET /api/ready=200, POST /api/agi/adapter/run JSON, and 3/3 POST /api/agi/ask=200 after retry window.",
    };
    await fs.writeFile(path.join(outDir, "summary.json"), `${JSON.stringify(blocked, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(blocked, null, 2));
    process.exit(2);
  }

  const baselineResolution = await resolveBaselineMetrics();
  const baseline = baselineResolution.metrics;

  const candidates: Candidate[] = [
    { id: "quake-core-00", weights: { balanced: { goal: 1.03, evidenceGain: 1.15, latencyCost: 0.92, risk: 1, budgetPressure: 0.92 }, evidence_first: { goal: 1.02, evidenceGain: 1.6, latencyCost: 0.66, risk: 0.98, budgetPressure: 0.8 }, latency_first: { goal: 0.95, evidenceGain: 1.02, latencyCost: 1.25, risk: 1, budgetPressure: 1.08 } } },
    { id: "quake-core-01", weights: { balanced: { goal: 1.02, evidenceGain: 1.12, latencyCost: 0.91, risk: 1, budgetPressure: 0.9 }, evidence_first: { goal: 1.01, evidenceGain: 1.56, latencyCost: 0.65, risk: 0.98, budgetPressure: 0.78 }, latency_first: { goal: 0.95, evidenceGain: 1.0, latencyCost: 1.27, risk: 1, budgetPressure: 1.08 } } },
    { id: "quake-core-02", weights: { balanced: { goal: 1.04, evidenceGain: 1.17, latencyCost: 0.93, risk: 1, budgetPressure: 0.92 }, evidence_first: { goal: 1.03, evidenceGain: 1.62, latencyCost: 0.67, risk: 0.98, budgetPressure: 0.8 }, latency_first: { goal: 0.96, evidenceGain: 1.03, latencyCost: 1.23, risk: 1, budgetPressure: 1.07 } } },
    { id: "quake-core-03", weights: { balanced: { goal: 1.01, evidenceGain: 1.1, latencyCost: 0.9, risk: 1, budgetPressure: 0.88 }, evidence_first: { goal: 1, evidenceGain: 1.52, latencyCost: 0.64, risk: 0.99, budgetPressure: 0.78 }, latency_first: { goal: 0.94, evidenceGain: 0.98, latencyCost: 1.3, risk: 1, budgetPressure: 1.1 } } },
    { id: "quake-core-04", weights: { balanced: { goal: 1, evidenceGain: 1.08, latencyCost: 0.9, risk: 1, budgetPressure: 0.9 }, evidence_first: { goal: 1, evidenceGain: 1.48, latencyCost: 0.7, risk: 1, budgetPressure: 0.82 }, latency_first: { goal: 0.95, evidenceGain: 0.98, latencyCost: 1.22, risk: 1, budgetPressure: 1.06 } } },
    { id: "quake-core-05", weights: { balanced: { goal: 0.99, evidenceGain: 1.06, latencyCost: 0.89, risk: 1, budgetPressure: 0.88 }, evidence_first: { goal: 0.99, evidenceGain: 1.45, latencyCost: 0.7, risk: 1, budgetPressure: 0.84 }, latency_first: { goal: 0.93, evidenceGain: 0.96, latencyCost: 1.28, risk: 1, budgetPressure: 1.1 } } },
    { id: "quake-core-06", weights: { balanced: { goal: 0.98, evidenceGain: 1.04, latencyCost: 0.9, risk: 1, budgetPressure: 0.9 }, evidence_first: { goal: 0.98, evidenceGain: 1.42, latencyCost: 0.72, risk: 1, budgetPressure: 0.86 }, latency_first: { goal: 0.92, evidenceGain: 0.94, latencyCost: 1.35, risk: 1, budgetPressure: 1.15 } } },
    { id: "quake-core-07", weights: { balanced: { goal: 1.02, evidenceGain: 1.14, latencyCost: 0.94, risk: 1, budgetPressure: 0.94 }, evidence_first: { goal: 1.02, evidenceGain: 1.58, latencyCost: 0.68, risk: 0.99, budgetPressure: 0.82 }, latency_first: { goal: 0.96, evidenceGain: 1.01, latencyCost: 1.2, risk: 1, budgetPressure: 1.02 } } },
    { id: "quake-core-08", weights: { balanced: { goal: 1.01, evidenceGain: 1.09, latencyCost: 0.93, risk: 1, budgetPressure: 0.92 }, evidence_first: { goal: 1, evidenceGain: 1.5, latencyCost: 0.69, risk: 1, budgetPressure: 0.84 }, latency_first: { goal: 0.95, evidenceGain: 0.99, latencyCost: 1.21, risk: 1, budgetPressure: 1.04 } } },
    { id: "quake-core-09", weights: { balanced: { goal: 1.03, evidenceGain: 1.16, latencyCost: 0.95, risk: 1, budgetPressure: 0.95 }, evidence_first: { goal: 1.03, evidenceGain: 1.61, latencyCost: 0.7, risk: 0.99, budgetPressure: 0.83 }, latency_first: { goal: 0.97, evidenceGain: 1.02, latencyCost: 1.18, risk: 1, budgetPressure: 1 } } },
    { id: "quake-core-10", weights: { balanced: { goal: 1.04, evidenceGain: 1.18, latencyCost: 0.96, risk: 1, budgetPressure: 0.96 }, evidence_first: { goal: 1.03, evidenceGain: 1.64, latencyCost: 0.71, risk: 0.99, budgetPressure: 0.84 }, latency_first: { goal: 0.97, evidenceGain: 1.03, latencyCost: 1.16, risk: 1, budgetPressure: 0.98 } } },
    { id: "quake-core-11", weights: { balanced: { goal: 0.97, evidenceGain: 1.02, latencyCost: 0.88, risk: 1, budgetPressure: 0.86 }, evidence_first: { goal: 0.97, evidenceGain: 1.38, latencyCost: 0.74, risk: 1, budgetPressure: 0.88 }, latency_first: { goal: 0.91, evidenceGain: 0.9, latencyCost: 1.4, risk: 1, budgetPressure: 1.2 } } },
  ];

  const results: EvalResult[] = [];
  for (const candidate of candidates) {
    const result = await evaluateCandidate(candidate, outDir, baseline);
    results.push(result);
  }

  const gateFailCount = (entry: EvalResult): number => {
    let fails = 0;
    if (!entry.decision_grade_ready) fails += 1;
    if (!gatePassForRate(entry.metrics.relation_packet_built_rate, GATES.relation_packet_built_rate)) fails += 1;
    if (!gatePassForRate(entry.metrics.relation_dual_domain_ok_rate, GATES.relation_dual_domain_ok_rate)) fails += 1;
    if (!gatePassForRate(entry.metrics.report_mode_correct_rate, GATES.report_mode_correct_rate)) fails += 1;
    return fails;
  };
  const ranked = [...results].sort((a, b) => {
    if (a.decision_grade_ready !== b.decision_grade_ready) {
      return a.decision_grade_ready ? -1 : 1;
    }
    const gateDelta = gateFailCount(a) - gateFailCount(b);
    if (gateDelta !== 0) return gateDelta;
    return b.score - a.score;
  });
  const winner = ranked[0];
  const promoted = winner?.passes === true;
  const topNearest = ranked.slice(0, 3);

  const deltaVsBaseline = winner
    ? {
        baseline_run_id: BASELINE_RUN_ID,
        winner_id: winner.id,
        promoted,
        gate_fail_count: gateFailCount(winner),
        top_nearest: promoted ? [] : topNearest.map((r) => ({ id: r.id, score: r.score, metrics: r.metrics })),
        delta: {
          relation_packet_built_rate: Number((winner.metrics.relation_packet_built_rate - baseline.relation_packet_built_rate).toFixed(4)),
          relation_dual_domain_ok_rate: Number((winner.metrics.relation_dual_domain_ok_rate - baseline.relation_dual_domain_ok_rate).toFixed(4)),
          report_mode_correct_rate: Number((winner.metrics.report_mode_correct_rate - baseline.report_mode_correct_rate).toFixed(4)),
        },
      }
    : { baseline_run_id: BASELINE_RUN_ID, promoted: false, reason: "no_candidates" };

  const summary = {
    status: "OK",
    baseline_run_id: BASELINE_RUN_ID,
    baseline: {
      source: baselineResolution.source,
      metrics: baseline,
      warnings: baselineResolution.warnings,
    },
    probes,
    gates: GATES,
    promoted,
    winner_id: winner?.id ?? null,
    candidate_count: results.length,
    decision_grade_ready_candidates: results.filter((entry) => entry.decision_grade_ready).length,
    provenance_blocked_candidates: results.filter((entry) => !entry.decision_grade_ready).length,
    ranking: ranked.map((r) => ({
      id: r.id,
      passes: r.passes,
      decision_grade_ready: r.decision_grade_ready,
      score: r.score,
      gate_fail_count: gateFailCount(r),
    })),
  };

  const winnerAssessments = winner ? buildGateAssessment(winner.metrics) : [];

  const winnerPayload = winner
    ? {
        promoted,
        recommendation: promoted
          ? "PROMOTE: winner meets all strict Step 4 thresholds."
          : winner.decision_grade_ready
            ? "HOLD: winner fails one or more strict Step 4 thresholds."
            : "HOLD: winner is not decision-grade ready due to provenance/run completeness gating.",
        winner_id: winner.id,
        score: winner.score,
        decision_grade_ready: winner.decision_grade_ready,
        provenance_gate_pass: winner.provenance_gate_pass,
        run_complete: winner.run_complete,
        provenance_warnings: winner.provenance_warnings,
        metrics: winner.metrics,
        gates: {
          passed: [
            ...(winner.decision_grade_ready ? ["decision_grade_ready"] : []),
            ...winnerAssessments.filter((item) => item.pass).map((item) => item.metric),
          ],
          failed: [
            ...(!winner.decision_grade_ready ? ["decision_grade_ready"] : []),
            ...winnerAssessments.filter((item) => !item.pass).map((item) => item.metric),
          ],
        },
        gate_assessment: winnerAssessments,
        gate_details: Object.fromEntries(
          [
            [
              "decision_grade_ready",
              {
                actual: winner.decision_grade_ready ? 1 : 0,
                threshold: 1,
                comparator: ">=",
                passed: winner.decision_grade_ready,
              },
            ],
            ...winnerAssessments.map((item) => {
              return [item.metric, { actual: item.actual, threshold: item.threshold, comparator: item.comparator, passed: item.pass }];
            }),
          ],
        ),
        summaryPath: winner.summaryPath,
      }
    : { promoted: false, reason: "no_candidates" };

  await fs.writeFile(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outDir, "candidates.json"), `${JSON.stringify({ candidates, results }, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outDir, "winner.json"), `${JSON.stringify(winnerPayload, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outDir, "delta-vs-baseline.json"), `${JSON.stringify(deltaVsBaseline, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ outDir, summary, winner }, null, 2));
}

const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMainModule) {
  main().catch((error) => {
    console.error("[helix-ask-quake-weight-tuning] failed", error);
    process.exit(1);
  });
}
