import fs from "node:fs/promises";
import path from "node:path";
import { ensureArtifactsDir, resolveArtifactsPath } from "./agi-artifacts";
import type { AgiTrajectory } from "@shared/agi-refinery";
import { getTrainingTraceExport } from "../server/services/observability/training-trace-store";
import {
  DEFAULT_HOLDOUT_PATH,
  computeHoldoutMetrics,
  extractHoldoutPayload,
  filterHoldoutTrajectories,
  loadHoldoutSet,
} from "../server/services/agi/refinery-holdout";

type CompareArgs = {
  limit?: number;
  holdoutPath?: string;
  rc0ManifestPath?: string;
  outPath?: string;
  tenantId?: string;
  routerTag?: string;
  answererTag?: string;
  jointTag?: string;
  routerAdapter?: string;
  answererAdapter?: string;
  jointAdapter?: string;
  routerPlanner?: string;
  answererExecutor?: string;
  jointPlanner?: string;
  jointExecutor?: string;
};

type VariantFilter = {
  name: string;
  tag?: string;
  adapter?: string;
  planner?: string;
  executor?: string;
};

const DEFAULT_RC0_MANIFEST = resolveArtifactsPath(
  "rc0",
  "agi-refinery-rc0.manifest.json",
);

const normalize = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const parseArgs = (): CompareArgs => {
  const args = process.argv.slice(2);
  const out: CompareArgs = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--limit") {
      out.limit = Number(args[i + 1]);
      i += 1;
    } else if (token === "--holdout") {
      out.holdoutPath = args[i + 1];
      i += 1;
    } else if (token === "--rc0-manifest") {
      out.rc0ManifestPath = args[i + 1];
      i += 1;
    } else if (token === "--out") {
      out.outPath = args[i + 1];
      i += 1;
    } else if (token === "--tenant") {
      out.tenantId = args[i + 1];
      i += 1;
    } else if (token === "--router-tag") {
      out.routerTag = args[i + 1];
      i += 1;
    } else if (token === "--answerer-tag") {
      out.answererTag = args[i + 1];
      i += 1;
    } else if (token === "--joint-tag") {
      out.jointTag = args[i + 1];
      i += 1;
    } else if (token === "--router-adapter") {
      out.routerAdapter = args[i + 1];
      i += 1;
    } else if (token === "--answerer-adapter") {
      out.answererAdapter = args[i + 1];
      i += 1;
    } else if (token === "--joint-adapter") {
      out.jointAdapter = args[i + 1];
      i += 1;
    } else if (token === "--router-planner") {
      out.routerPlanner = args[i + 1];
      i += 1;
    } else if (token === "--answerer-executor") {
      out.answererExecutor = args[i + 1];
      i += 1;
    } else if (token === "--joint-planner") {
      out.jointPlanner = args[i + 1];
      i += 1;
    } else if (token === "--joint-executor") {
      out.jointExecutor = args[i + 1];
      i += 1;
    }
  }
  return out;
};

const resolveHoldoutPath = async (args: CompareArgs): Promise<string> => {
  if (args.holdoutPath) {
    return path.resolve(args.holdoutPath);
  }
  const manifestPath = normalize(args.rc0ManifestPath) ?? DEFAULT_RC0_MANIFEST;
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as {
      holdouts?: { indist?: { path?: string }; coverage?: { path?: string } };
    };
    const holdoutPath =
      parsed?.holdouts?.indist?.path ?? parsed?.holdouts?.coverage?.path;
    if (holdoutPath) {
      return path.resolve(process.cwd(), holdoutPath);
    }
  } catch {
    // ignore manifest read errors and fall back to default path
  }
  return DEFAULT_HOLDOUT_PATH;
};

const buildVariant = (
  name: string,
  overrides: Partial<VariantFilter>,
): VariantFilter => ({
  name,
  tag: normalize(overrides.tag),
  adapter: normalize(overrides.adapter),
  planner: normalize(overrides.planner),
  executor: normalize(overrides.executor),
});

const hasCriteria = (filter: VariantFilter): boolean =>
  Boolean(filter.tag || filter.adapter || filter.planner || filter.executor);

const getModelFields = (trajectory: AgiTrajectory): string[] =>
  [
    trajectory.meta?.model,
    trajectory.meta?.plannerVersion,
    trajectory.meta?.executorVersion,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());

const matchesFilter = (trajectory: AgiTrajectory, filter: VariantFilter): boolean => {
  if (!hasCriteria(filter)) return true;
  const tags = (trajectory.meta?.tags ?? []).map((tag) => tag.toLowerCase());
  const tagNeedle = filter.tag?.toLowerCase();
  const adapterNeedle = filter.adapter?.toLowerCase();
  const plannerNeedle = filter.planner?.toLowerCase();
  const executorNeedle = filter.executor?.toLowerCase();
  const modelFields = getModelFields(trajectory);
  const plannerField = (trajectory.meta?.plannerVersion ?? trajectory.meta?.model ?? "").toLowerCase();
  const executorField = (trajectory.meta?.executorVersion ?? trajectory.meta?.model ?? "").toLowerCase();
  const tagMatch = tagNeedle ? tags.some((tag) => tag === tagNeedle || tag.includes(tagNeedle)) : true;
  const adapterMatch = adapterNeedle
    ? modelFields.some((value) => value.includes(adapterNeedle))
    : true;
  const plannerMatch = plannerNeedle ? plannerField.includes(plannerNeedle) : true;
  const executorMatch = executorNeedle ? executorField.includes(executorNeedle) : true;
  return tagMatch && adapterMatch && plannerMatch && executorMatch;
};

async function main() {
  const args = parseArgs();
  const holdoutPath = await resolveHoldoutPath(args);
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

  const routerFilter = buildVariant("router", {
    tag: args.routerTag ?? process.env.AGI_RC0_ROUTER_TAG,
    adapter: args.routerAdapter ?? process.env.AGI_RC0_ROUTER_ADAPTER,
    planner: args.routerPlanner ?? process.env.AGI_RC0_ROUTER_PLANNER,
  });
  const answererFilter = buildVariant("answerer", {
    tag: args.answererTag ?? process.env.AGI_RC0_ANSWERER_TAG,
    adapter: args.answererAdapter ?? process.env.AGI_RC0_ANSWERER_ADAPTER,
    executor: args.answererExecutor ?? process.env.AGI_RC0_ANSWERER_EXECUTOR,
  });
  const explicitJoint = buildVariant("joint", {
    tag: args.jointTag ?? process.env.AGI_RC0_JOINT_TAG,
    adapter: args.jointAdapter ?? process.env.AGI_RC0_JOINT_ADAPTER,
    planner: args.jointPlanner ?? process.env.AGI_RC0_JOINT_PLANNER,
    executor: args.jointExecutor ?? process.env.AGI_RC0_JOINT_EXECUTOR,
  });
  const useExplicitJoint = hasCriteria(explicitJoint);

  const routerMatcher = (trajectory: AgiTrajectory): boolean => {
    if (!matchesFilter(trajectory, routerFilter)) return false;
    if (!hasCriteria(answererFilter)) return true;
    return !matchesFilter(trajectory, answererFilter);
  };
  const answererMatcher = (trajectory: AgiTrajectory): boolean => {
    if (!matchesFilter(trajectory, answererFilter)) return false;
    if (!hasCriteria(routerFilter)) return true;
    return !matchesFilter(trajectory, routerFilter);
  };
  const jointMatcher = (trajectory: AgiTrajectory): boolean => {
    if (useExplicitJoint) {
      return matchesFilter(trajectory, explicitJoint);
    }
    if (hasCriteria(routerFilter) || hasCriteria(answererFilter)) {
      return matchesFilter(trajectory, routerFilter) && matchesFilter(trajectory, answererFilter);
    }
    return true;
  };

  const variants = [
    { filter: routerFilter, matcher: routerMatcher },
    { filter: answererFilter, matcher: answererMatcher },
    { filter: useExplicitJoint ? explicitJoint : buildVariant("joint", {}), matcher: jointMatcher },
  ];

  const results = variants.map(({ filter, matcher }) => {
    const matched = holdoutTrajectories.filter(matcher);
    const metrics = computeHoldoutMetrics(matched, gates);
    return {
      name: filter.name,
      criteria: {
        tag: filter.tag ?? null,
        adapter: filter.adapter ?? null,
        planner: filter.planner ?? null,
        executor: filter.executor ?? null,
      },
      matched: matched.length,
      totalHoldout: holdoutTrajectories.length,
      metrics,
    };
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const outPath = args.outPath
    ? path.resolve(args.outPath)
    : resolveArtifactsPath(`agi-refinery-holdout-compare.${stamp}.json`);
  await ensureArtifactsDir(outPath);
  const payload = {
    holdoutPath,
    totalHoldout: holdoutTrajectories.length,
    variants: results,
  };
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outPath, ...payload }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
