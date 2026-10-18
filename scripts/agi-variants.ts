import { getTrainingTraceExport } from "../server/services/observability/training-trace-store";
import { buildVariantsFromTrajectory } from "../server/services/agi/refinery-variants";
import { collectRefinerySummary } from "../server/services/agi/refinery-summary";
import { evaluateTrajectoryGates } from "../server/services/agi/refinery-gates";
import {
  buildSamplingPolicy,
  scoreTrajectoryForSampling,
} from "../server/services/agi/refinery-policy";
import { intentKey, surfaceKey } from "../server/services/agi/refinery-axes";
import type { AgiGateReport, AgiTrajectory } from "@shared/agi-refinery";

type VariantArgs = {
  limit?: number;
  maxVariants?: number;
  baseUrl?: string;
  run?: boolean;
  sleepMs?: number;
  usePolicy?: boolean;
  tenantId?: string;
  surfaces?: string[];
  blockedTags?: string[];
  blockedPrefixes?: string[];
  essenceConsole?: boolean;
  alphaTarget?: number;
  enforceAlpha?: boolean;
};

const parseArgs = (): VariantArgs => {
  const args = process.argv.slice(2);
  const out: VariantArgs = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--limit") {
      out.limit = Number(args[i + 1]);
      i += 1;
    } else if (token === "--max-variants") {
      out.maxVariants = Number(args[i + 1]);
      i += 1;
    } else if (token === "--base-url") {
      out.baseUrl = args[i + 1];
      i += 1;
    } else if (token === "--run") {
      out.run = true;
    } else if (token === "--sleep-ms") {
      out.sleepMs = Number(args[i + 1]);
      i += 1;
    } else if (token === "--use-policy") {
      out.usePolicy = true;
    } else if (token === "--tenant") {
      out.tenantId = args[i + 1];
      i += 1;
    } else if (token === "--surface") {
      const raw = args[i + 1];
      if (raw) {
        out.surfaces = raw
          .split(",")
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean);
      }
      i += 1;
    } else if (token === "--block-tags") {
      out.blockedTags = args[i + 1]
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      i += 1;
    } else if (token === "--block-prefixes") {
      out.blockedPrefixes = args[i + 1]
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      i += 1;
    } else if (token === "--alpha-target") {
      out.alphaTarget = Number(args[i + 1]);
      out.enforceAlpha = true;
      i += 1;
    } else if (token === "--alpha-governor") {
      out.enforceAlpha = true;
    } else if (token === "--no-alpha-governor") {
      out.enforceAlpha = false;
    } else if (token === "--essence-console") {
      out.essenceConsole = true;
    }
  }
  return out;
};

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const parseRatio = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(Math.max(parsed, 0), 1);
};

const trajectoryKey = (trajectory: AgiTrajectory): string =>
  trajectory.traceId ?? trajectory.id;

const extractPayload = (
  records: ReturnType<typeof getTrainingTraceExport>,
): {
  trajectories: Map<string, AgiTrajectory>;
  gates: Map<string, AgiGateReport>;
} => {
  const trajectories = new Map<string, AgiTrajectory>();
  const gates = new Map<string, AgiGateReport>();
  for (const record of records) {
    if (!record.payload) continue;
    if (record.payload.kind === "trajectory") {
      const data = record.payload.data as AgiTrajectory;
      trajectories.set(trajectoryKey(data), data);
    } else if (record.payload.kind === "trajectory_gates") {
      const data = record.payload.data as AgiGateReport;
      const key = data.traceId ?? data.trajectoryId ?? record.traceId ?? record.id;
      if (key) {
        gates.set(key, data);
      }
    }
  }
  return { trajectories, gates };
};

const extractTrajectories = (
  records: ReturnType<typeof getTrainingTraceExport>,
): AgiTrajectory[] => Array.from(extractPayload(records).trajectories.values());

const collectAcceptedOrigins = (
  records: ReturnType<typeof getTrainingTraceExport>,
): Record<string, number> => {
  const { trajectories, gates } = extractPayload(records);
  const counts: Record<string, number> = {};
  for (const trajectory of trajectories.values()) {
    const gateReport =
      gates.get(trajectoryKey(trajectory)) ?? evaluateTrajectoryGates(trajectory);
    if (!gateReport.accepted) continue;
    const origin = trajectory.meta?.origin ?? "unknown";
    counts[origin] = (counts[origin] ?? 0) + 1;
  }
  return counts;
};

type ScoredTrajectory = {
  item: AgiTrajectory;
  score: number;
  surface: string;
  intent: string;
  key: string;
};

const buildScoredTrajectories = (
  trajectories: AgiTrajectory[],
  policy: ReturnType<typeof buildSamplingPolicy>,
): ScoredTrajectory[] =>
  trajectories
    .map((item) => ({
      item,
      score: scoreTrajectoryForSampling(item, policy),
      surface: surfaceKey(item),
      intent: intentKey(item.z),
      key: item.traceId ?? item.id,
    }))
    .sort((a, b) => b.score - a.score);

const selectWithMinimums = (
  scored: ScoredTrajectory[],
  policy: ReturnType<typeof buildSamplingPolicy>,
  limit?: number,
): ScoredTrajectory[] => {
  const targetCount = Math.min(limit ?? scored.length, scored.length);
  if (targetCount <= 0) return [];
  const selected: ScoredTrajectory[] = [];
  const selectedKeys = new Set<string>();
  const countsBySurface: Record<string, number> = {};
  const countsByIntent: Record<string, number> = {};
  let docsSharedCount = 0;
  let clientServerCount = 0;

  const addEntry = (entry: ScoredTrajectory): boolean => {
    if (selectedKeys.has(entry.key)) return false;
    selectedKeys.add(entry.key);
    selected.push(entry);
    countsBySurface[entry.surface] = (countsBySurface[entry.surface] ?? 0) + 1;
    countsByIntent[entry.intent] = (countsByIntent[entry.intent] ?? 0) + 1;
    if (entry.surface === "docs" || entry.surface === "shared") {
      docsSharedCount += 1;
    }
    if (entry.surface === "client" || entry.surface === "server") {
      clientServerCount += 1;
    }
    return true;
  };

  const minSurface = policy.surfaceMinimums ?? {};
  for (const [surface, share] of Object.entries(minSurface)) {
    const required = Math.max(0, Math.ceil(share * targetCount));
    if (required === 0) continue;
    const candidates = scored.filter((entry) => entry.surface === surface);
    for (const entry of candidates) {
      if (selected.length >= targetCount) break;
      if (countsBySurface[surface] >= required) break;
      addEntry(entry);
    }
  }

  const minClientServerShare = policy.minClientServerShare ?? 0;
  const requiredClientServer = Math.max(
    0,
    Math.ceil(minClientServerShare * targetCount),
  );
  if (clientServerCount < requiredClientServer) {
    const candidates = scored.filter(
      (entry) => entry.surface === "client" || entry.surface === "server",
    );
    for (const entry of candidates) {
      if (selected.length >= targetCount) break;
      if (clientServerCount >= requiredClientServer) break;
      addEntry(entry);
    }
  }

  const maxDocsSharedShare = policy.maxDocsSharedShare ?? 0;
  const maxDocsSharedCount =
    maxDocsSharedShare > 0
      ? Math.floor(maxDocsSharedShare * targetCount)
      : undefined;
  const intentMaximums = policy.intentMaximums ?? {};
  const canSelect = (entry: ScoredTrajectory): boolean => {
    const maxIntentShare = intentMaximums[entry.intent];
    if (maxIntentShare !== undefined) {
      const maxIntentCount = Math.floor(maxIntentShare * targetCount);
      if ((countsByIntent[entry.intent] ?? 0) >= maxIntentCount) {
        return false;
      }
    }
    if (
      maxDocsSharedCount !== undefined &&
      (entry.surface === "docs" || entry.surface === "shared") &&
      docsSharedCount >= maxDocsSharedCount
    ) {
      return false;
    }
    return true;
  };

  for (const entry of scored) {
    if (selected.length >= targetCount) break;
    if (selectedKeys.has(entry.key)) continue;
    if (!canSelect(entry)) continue;
    addEntry(entry);
  }

  if (selected.length < targetCount) {
    for (const entry of scored) {
      if (selected.length >= targetCount) break;
      if (selectedKeys.has(entry.key)) continue;
      addEntry(entry);
    }
  }

  return selected;
};

const buildCallSpec = (resourceHints?: string[], goal?: string) => {
  if (!resourceHints || resourceHints.length === 0) return undefined;
  return {
    action: "call_remote",
    intent: ["repo_deep"],
    premise: goal,
    resourceHints: resourceHints.map((path) => ({ type: "repo_file", path })),
  };
};

async function main() {
  const args = parseArgs();
  const baseUrl = args.baseUrl ?? "http://localhost:3000";
  const records = getTrainingTraceExport({ limit: args.limit, tenantId: args.tenantId });
  const acceptedOrigins = collectAcceptedOrigins(records);
  const alphaTarget = args.alphaTarget ?? parseRatio(process.env.AGI_REFINERY_ALPHA_TARGET);
  const enforceAlpha = args.enforceAlpha ?? alphaTarget !== undefined;
  const acceptedVariant = acceptedOrigins.variant ?? 0;
  const acceptedLive = Object.entries(acceptedOrigins).reduce((sum, [key, value]) => {
    if (key === "variant") return sum;
    return sum + value;
  }, 0);
  const alphaCap =
    !enforceAlpha || alphaTarget === undefined
      ? Number.POSITIVE_INFINITY
      : alphaTarget >= 1
        ? 0
        : alphaTarget <= 0
          ? Number.POSITIVE_INFINITY
          : Math.floor(((1 - alphaTarget) / alphaTarget) * acceptedLive);
  let trajectories = extractTrajectories(records);
  if (args.surfaces && args.surfaces.length > 0) {
    const allowed = new Set(args.surfaces);
    trajectories = trajectories.filter((item) => allowed.has(surfaceKey(item)));
    if (trajectories.length === 0) {
      console.warn("[agi-variants] no trajectories match --surface filter");
      return;
    }
  }

  if (args.usePolicy) {
    const summary = collectRefinerySummary({ limit: args.limit, tenantId: args.tenantId });
    const policy = buildSamplingPolicy(summary);
    const scored = buildScoredTrajectories(trajectories, policy);
    trajectories = selectWithMinimums(scored, policy, args.limit).map(
      (entry) => entry.item,
    );
  }

  const seeds = args.limit ? trajectories.slice(0, args.limit) : trajectories;  
  let planned = 0;
  let executed = 0;
  let stoppedForAlpha = false;
  for (const seed of seeds) {
    if (stoppedForAlpha) break;
    const variants = buildVariantsFromTrajectory(seed, {
      maxVariants: args.maxVariants,
      blockedTags: args.blockedTags,
      blockedPrefixes: args.blockedPrefixes,
    });
    for (const variant of variants) {
      if (alphaCap !== Number.POSITIVE_INFINITY) {
        const projectedVariants = acceptedVariant + planned + 1;
        if (projectedVariants > alphaCap) {
          stoppedForAlpha = true;
          break;
        }
      }
      planned += 1;
      if (!args.run) continue;
      const planRes = await fetch(`${baseUrl}/api/agi/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: variant.goal,
          personaId: variant.personaId ?? "default",
          knowledgeProjects: variant.knowledgeProjects ?? [],
          summaryFocus: variant.summaryFocus,
          call_spec: buildCallSpec(variant.resourceHints, variant.goal),
          refinery: variant.refinery,
          essenceConsole: Boolean(args.essenceConsole),
        }),
      });
      if (!planRes.ok) {
        let message = await planRes.text();
        try {
          const parsed = JSON.parse(message) as { error?: string };
          if (parsed.error === "alpha_governor_engaged") {
            stoppedForAlpha = true;
            break;
          }
        } catch {
          // ignore JSON parse errors
        }
        console.warn("[agi-variants] plan failed", message);
        continue;
      }
      const planJson = await planRes.json();
      const traceId = planJson.traceId;
      if (!traceId) {
        console.warn("[agi-variants] missing traceId");
        continue;
      }
      const execRes = await fetch(`${baseUrl}/api/agi/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ traceId }),
      });
      if (!execRes.ok) {
        let message = await execRes.text();
        try {
          const parsed = JSON.parse(message) as { error?: string };
          if (parsed.error === "alpha_governor_engaged") {
            stoppedForAlpha = true;
            break;
          }
        } catch {
          // ignore JSON parse errors
        }
        console.warn("[agi-variants] execute failed", message);
        continue;
      }
      executed += 1;
      if (args.sleepMs) {
        await sleep(args.sleepMs);
      }
    }
  }

  if (stoppedForAlpha) {
    console.warn(
      "[agi-variants] alpha governor reached",
      JSON.stringify({
        alphaTarget,
        alphaCap: Number.isFinite(alphaCap) ? alphaCap : null,
        acceptedLive,
        acceptedVariant,
        planned,
      }),
    );
  }
  console.log(
    JSON.stringify(
      {
        seeds: seeds.length,
        planned,
        executed,
        run: Boolean(args.run),
        alphaTarget,
        alphaCap: Number.isFinite(alphaCap) ? alphaCap : null,
        acceptedLive,
        acceptedVariant,
        stoppedForAlpha,
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
