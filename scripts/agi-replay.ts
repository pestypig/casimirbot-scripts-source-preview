import type { AgiGateReport, AgiTrajectory } from "@shared/agi-refinery";
import type { MovementEpisodeEvent, TrainingTraceRecord } from "@shared/schema";
import { recordTrainingTrace, getTrainingTraceExport } from "../server/services/observability/training-trace-store";
import { evaluateTrajectoryGates } from "../server/services/agi/refinery-gates";
import { collectRefinerySummary } from "../server/services/agi/refinery-summary";

export type ReplayArgs = {
  limit?: number;
  tenantId?: string;
  force?: boolean;
  emit?: boolean;
  fromSeq?: number;
  fromTraceId?: string;
  step?: boolean;
  stopOnFirstFail?: boolean;
  stopOnVerdict?: "pass" | "fail";
  speed?: number;
};

export const parseArgs = (argv: string[] = process.argv.slice(2)): ReplayArgs => {
  const out: ReplayArgs = { emit: true, speed: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--limit") {
      out.limit = Number(argv[i + 1]);
      i += 1;
    } else if (token === "--tenant") {
      out.tenantId = argv[i + 1];
      i += 1;
    } else if (token === "--force") {
      out.force = true;
    } else if (token === "--no-emit") {
      out.emit = false;
    } else if (token === "--from-seq") {
      out.fromSeq = Number(argv[i + 1]);
      i += 1;
    } else if (token === "--from-trace") {
      out.fromTraceId = argv[i + 1];
      i += 1;
    } else if (token === "--step") {
      out.step = true;
    } else if (token === "--stop-on-first-fail") {
      out.stopOnFirstFail = true;
    } else if (token === "--stop-on-verdict") {
      const raw = (argv[i + 1] ?? "").toLowerCase();
      if (raw === "pass" || raw === "fail") {
        out.stopOnVerdict = raw;
      }
      i += 1;
    } else if (token === "--speed") {
      const value = Number(argv[i + 1]);
      out.speed = Number.isFinite(value) && value > 0 ? value : 1;
      i += 1;
    }
  }
  return out;
};

const normalizeReplaySource = (
  traces: TrainingTraceRecord[],
  args: ReplayArgs,
): TrainingTraceRecord[] => {
  let ordered = traces.slice().sort((a, b) => a.seq - b.seq);
  if (Number.isFinite(args.fromSeq)) {
    const fromSeq = Math.max(0, Math.floor(args.fromSeq ?? 0));
    ordered = ordered.filter((entry) => entry.seq >= fromSeq);
  }
  if (args.fromTraceId) {
    const startAt = ordered.findIndex(
      (entry) => entry.traceId === args.fromTraceId || entry.id === args.fromTraceId,
    );
    if (startAt >= 0) {
      ordered = ordered.slice(startAt);
    }
  }
  return ordered;
};

export const extractPayload = (
  traces: TrainingTraceRecord[],
): {
  trajectories: Map<string, AgiTrajectory>;
  gates: Map<string, AgiGateReport>;
  movementEpisodes: TrainingTraceRecord[];
} => {
  const trajectories = new Map<string, AgiTrajectory>();
  const gates = new Map<string, AgiGateReport>();
  const movementEpisodes: TrainingTraceRecord[] = [];
  for (const trace of traces) {
    if (!trace.payload) continue;
    if (trace.payload.kind === "trajectory") {
      const data = trace.payload.data as AgiTrajectory;
      const key = data.traceId ?? data.id;
      trajectories.set(key, data);
    } else if (trace.payload.kind === "trajectory_gates") {
      const data = trace.payload.data as AgiGateReport;
      const key = data.traceId ?? data.trajectoryId ?? trace.traceId ?? trace.id;
      if (key) {
        gates.set(key, data);
      }
    } else if (trace.payload.kind === "movement_episode") {
      movementEpisodes.push(trace);
    }
  }
  return { trajectories, gates, movementEpisodes };
};

type NavigationDeltaDiff = {
  traceId: string;
  episodeId: string;
  seq: number;
  index: number;
  predictedDelta: number;
  actualDelta: number;
  navDeltaDiff: number;
};

const toCompareDelta = (event: MovementEpisodeEvent): NavigationDeltaDiff | null => {
  if (event.phase !== "compare") return null;
  if (typeof event.predictedDelta !== "number" || typeof event.actualDelta !== "number") {
    return null;
  }
  return {
    traceId: "",
    episodeId: "",
    seq: 0,
    index: 0,
    predictedDelta: event.predictedDelta,
    actualDelta: event.actualDelta,
    navDeltaDiff: event.actualDelta - event.predictedDelta,
  };
};

export const buildNavigationDeltaDiffs = (
  movementEpisodes: TrainingTraceRecord[],
): NavigationDeltaDiff[] => {
  const rows: NavigationDeltaDiff[] = [];
  for (const trace of movementEpisodes) {
    if (!trace.payload || trace.payload.kind !== "movement_episode") continue;
    const { data } = trace.payload;
    data.events.forEach((event, index) => {
      const base = toCompareDelta(event);
      if (!base) return;
      rows.push({
        ...base,
        traceId: trace.traceId ?? trace.id,
        episodeId: data.episodeId,
        seq: trace.seq,
        index,
      });
    });
  }
  return rows.sort((a, b) => (a.seq === b.seq ? a.index - b.index : a.seq - b.seq));
};

type ReplayResult = {
  evaluated: number;
  stopReason: "exhausted" | "firstFail" | "verdict";
};

const replayTrajectories = (
  trajectories: Map<string, AgiTrajectory>,
  gates: Map<string, AgiGateReport>,
  args: ReplayArgs,
): ReplayResult => {
  const batchSize = args.step ? 1 : Math.max(1, Math.floor(args.speed ?? 1));
  const queue = Array.from(trajectories.values());
  let evaluated = 0;
  for (let i = 0; i < queue.length; i += batchSize) {
    const batch = queue.slice(i, i + batchSize);
    for (const trajectory of batch) {
      const key = trajectory.traceId ?? trajectory.id;
      if (!args.force && gates.has(key)) {
        continue;
      }
      const gateReport = evaluateTrajectoryGates(trajectory);
      const verdict = gateReport.accepted ? "pass" : "fail";
      evaluated += 1;
      if (args.emit) {
        recordTrainingTrace({
          traceId: trajectory.traceId,
          pass: gateReport.accepted,
          deltas: [],
          metrics: {
            gate_accept: gateReport.accepted ? 1 : 0,
            evidence_count: trajectory.E?.length ?? 0,
          },
          source: { system: "agi-refinery", component: "replay", tool: "gates" },
          payload: { kind: "trajectory_gates", data: gateReport },
          notes: ["source=replay"],
        });
      }
      if (args.stopOnFirstFail && !gateReport.accepted) {
        return { evaluated, stopReason: "firstFail" };
      }
      if (args.stopOnVerdict && args.stopOnVerdict === verdict) {
        return { evaluated, stopReason: "verdict" };
      }
    }
  }
  return { evaluated, stopReason: "exhausted" };
};

export const runReplay = (args: ReplayArgs): Record<string, unknown> => {
  const traces = getTrainingTraceExport({ limit: args.limit, tenantId: args.tenantId });
  const replaySource = normalizeReplaySource(traces, args);
  const { trajectories, gates, movementEpisodes } = extractPayload(replaySource);
  const navDiff = buildNavigationDeltaDiffs(movementEpisodes);
  const replayResult = replayTrajectories(trajectories, gates, args);

  const summary = collectRefinerySummary({ limit: args.limit, tenantId: args.tenantId });
  if (args.emit) {
    recordTrainingTrace({
      pass: true,
      deltas: [],
      metrics: {
        replay_total: summary.total,
        replay_accepted: summary.accepted,
        replay_speed_multiplier: Math.max(1, Math.floor(args.speed ?? 1)),
      },
      source: { system: "agi-refinery", component: "replay", tool: "summary" },
      payload: { kind: "trajectory_replay_summary", data: summary },
    });
  }

  return {
    evaluated: replayResult.evaluated,
    total: summary.total,
    accepted: summary.accepted,
    acceptanceRate: summary.acceptanceRate,
    avgTokens: summary.avgTokens,
    stopReason: replayResult.stopReason,
    replayWindow: {
      fromSeq: args.fromSeq ?? null,
      fromTraceId: args.fromTraceId ?? null,
      step: Boolean(args.step),
      speed: Math.max(1, Math.floor(args.speed ?? 1)),
    },
    navDeltaDiff: navDiff,
  };
};

const shouldRunCli = (): boolean => {
  const entry = process.argv[1];
  return Boolean(entry && entry.endsWith("scripts/agi-replay.ts"));
};

if (shouldRunCli()) {
  const args = parseArgs();
  console.log(JSON.stringify(runReplay(args), null, 2));
}
