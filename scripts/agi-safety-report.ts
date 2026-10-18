import fs from "node:fs/promises";
import path from "node:path";
import { ensureArtifactsDir, resolveArtifactsPath } from "./agi-artifacts";
import type { AgiTrajectory, AgiGateReport } from "@shared/agi-refinery";
import type { TrainingTraceRecord } from "@shared/schema";
import { getTrainingTraceExport } from "../server/services/observability/training-trace-store";
import { evaluateTrajectoryGates } from "../server/services/agi/refinery-gates";

type SafetyReportArgs = {
  limit?: number;
  tenantId?: string;
  outPath?: string;
  topN?: number;
};

const parseArgs = (): SafetyReportArgs => {
  const args = process.argv.slice(2);
  const out: SafetyReportArgs = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--limit") {
      out.limit = Number(args[i + 1]);
      i += 1;
    } else if (token === "--tenant") {
      out.tenantId = args[i + 1];
      i += 1;
    } else if (token === "--out") {
      out.outPath = args[i + 1];
      i += 1;
    } else if (token === "--top") {
      out.topN = Number(args[i + 1]);
      i += 1;
    }
  }
  return out;
};

const trajectoryKey = (trajectory: AgiTrajectory): string =>
  trajectory.traceId ?? trajectory.id;

const recordCount = (counter: Record<string, number>, key: string): void => {
  counter[key] = (counter[key] ?? 0) + 1;
};

const extractPayload = (
  traces: TrainingTraceRecord[],
): {
  trajectories: Map<string, AgiTrajectory>;
  gates: Map<string, AgiGateReport>;
} => {
  const trajectories = new Map<string, AgiTrajectory>();
  const gates = new Map<string, AgiGateReport>();
  for (const trace of traces) {
    if (!trace.payload) continue;
    if (trace.payload.kind === "trajectory") {
      const data = trace.payload.data as AgiTrajectory;
      trajectories.set(trajectoryKey(data), data);
    } else if (trace.payload.kind === "trajectory_gates") {
      const data = trace.payload.data as AgiGateReport;
      const key = data.traceId ?? data.trajectoryId ?? trace.traceId ?? trace.id;
      if (key) {
        gates.set(key, data);
      }
    }
  }
  return { trajectories, gates };
};

const sortCounts = (
  counter: Record<string, number>,
  topN: number,
): Array<{ key: string; count: number }> =>
  Object.entries(counter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([key, count]) => ({ key, count }));

const getFamilies = (tags: string[]): string[] =>
  tags.map((tag) => (tag.includes(":") ? tag.split(":")[0] : tag));

async function main() {
  const args = parseArgs();
  const traces = getTrainingTraceExport({
    limit: args.limit,
    tenantId: args.tenantId,
  });
  const { trajectories, gates } = extractPayload(traces);
  const byOrigin: Record<string, number> = {};
  const byOriginFail: Record<string, number> = {};
  const byTagFail: Record<string, number> = {};
  const byFamilyFail: Record<string, number> = {};
  const byReasonFail: Record<string, number> = {};
  const byKindFail: Record<string, number> = {};
  const byStageFail: Record<string, number> = {};
  const byActionFail: Record<string, number> = {};
  const byFlagFail: Record<string, number> = {};
  let total = 0;
  let safetyFails = 0;
  let safetyHandled = 0;

  for (const trajectory of trajectories.values()) {
    total += 1;
    const origin = trajectory.meta?.origin ?? "unknown";
    recordCount(byOrigin, origin);
    const key = trajectoryKey(trajectory);
    const storedGate = gates.get(key);
    const hasExecutionGate = Boolean(
      storedGate?.gates?.some((gate) => gate.name === "execution"),
    );
    const gateReport =
      storedGate && storedGate.safety && hasExecutionGate
        ? storedGate
        : evaluateTrajectoryGates(trajectory);
    const safetyGate = gateReport.gates.find((gate) => gate.name === "safety");
    const safety = gateReport.safety ?? trajectory.meta?.safety;
    if (safetyGate && !safetyGate.pass) {
      safetyFails += 1;
      recordCount(byOriginFail, origin);
      const tags = trajectory.meta?.tags?.length
        ? trajectory.meta.tags
        : ["none"];
      for (const tag of tags) {
        recordCount(byTagFail, tag);
      }
      for (const family of getFamilies(tags)) {
        recordCount(byFamilyFail, family);
      }
      recordCount(byReasonFail, safetyGate.reason ?? "unknown");
      if (safety?.kind) recordCount(byKindFail, safety.kind);
      if (safety?.stage) recordCount(byStageFail, safety.stage);
      if (safety?.action) recordCount(byActionFail, safety.action);
      if (Array.isArray(safety?.flags)) {
        safety.flags.forEach((flag) => recordCount(byFlagFail, flag));
      }
    } else if (safety?.handled) {
      safetyHandled += 1;
    }
  }

  const topN = args.topN ?? 5;
  const report = {
    createdAt: new Date().toISOString(),
    totalTrajectories: total,
    safetyFails,
    safetyHandledPasses: safetyHandled,
    byOrigin,
    byOriginFail,
    byTagFail,
    byFamilyFail,
    byReasonFail,
    byKindFail,
    byStageFail,
    byActionFail,
    byFlagFail,
    topTags: sortCounts(byTagFail, topN),
    topFamilies: sortCounts(byFamilyFail, topN),
    blockSuggestions: {
      tags: sortCounts(byTagFail, 2),
      families: sortCounts(byFamilyFail, 2),
    },
  };

  const outPath = args.outPath
    ? path.resolve(args.outPath)
    : resolveArtifactsPath("agi-refinery-safety-report.json");
  await ensureArtifactsDir(outPath);
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ outPath, ...report }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
