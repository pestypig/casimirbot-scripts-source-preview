import fs from "node:fs/promises";
import path from "node:path";
import { ensureArtifactsDir, resolveArtifactsPath } from "./agi-artifacts";
import type { AgiGateReport, AgiTrajectory } from "@shared/agi-refinery";
import type { TrainingTraceRecord } from "@shared/schema";
import { getTrainingTraceExport } from "../server/services/observability/training-trace-store";
import { evaluateTrajectoryGates } from "../server/services/agi/refinery-gates";

type ExecutionReportArgs = {
  limit?: number;
  tenantId?: string;
  outPath?: string;
  topN?: number;
};

const parseArgs = (): ExecutionReportArgs => {
  const args = process.argv.slice(2);
  const out: ExecutionReportArgs = {};
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
  const byErrorTypeFail: Record<string, number> = {};
  const byErrorClassFail: Record<string, number> = {};
  const byFingerprintFail: Record<string, number> = {};
  let total = 0;
  let executionFails = 0;

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
      storedGate && hasExecutionGate
        ? storedGate
        : evaluateTrajectoryGates(trajectory);
    const executionGate = gateReport.gates.find(
      (gate) => gate.name === "execution",
    );
    if (executionGate && !executionGate.pass) {
      executionFails += 1;
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
      recordCount(byReasonFail, executionGate.reason ?? "unknown");
      const types = trajectory.meta?.executionErrorTypes;
      if (types && types.length > 0) {
        types.forEach((type) => recordCount(byErrorTypeFail, type));
      } else {
        recordCount(byErrorTypeFail, "unknown_error");
      }
      const envelopes = trajectory.meta?.executionEnvelopes ?? [];
      if (envelopes.length > 0) {
        for (const envelope of envelopes) {
          const errorClass =
            envelope.errorClass ?? (envelope.ok === false ? "execution_tool_error" : undefined);
          if (errorClass) {
            recordCount(byErrorClassFail, errorClass);
          }
          if (envelope.fingerprint) {
            recordCount(byFingerprintFail, envelope.fingerprint);
          }
        }
      }
    }
  }

  const topN = args.topN ?? 5;
  const report = {
    createdAt: new Date().toISOString(),
    totalTrajectories: total,
    executionFails,
    byOrigin,
    byOriginFail,
    byTagFail,
    byFamilyFail,
    byReasonFail,
    byErrorTypeFail,
    byErrorClassFail,
    byFingerprintFail,
    topTags: sortCounts(byTagFail, topN),
    topFamilies: sortCounts(byFamilyFail, topN),
    topErrorTypes: sortCounts(byErrorTypeFail, topN),
    topErrorClasses: sortCounts(byErrorClassFail, topN),
    topFingerprints: sortCounts(byFingerprintFail, topN),
  };

  const outPath = args.outPath
    ? path.resolve(args.outPath)
    : resolveArtifactsPath("agi-refinery-execution-report.json");
  await ensureArtifactsDir(outPath);
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ outPath, ...report }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
