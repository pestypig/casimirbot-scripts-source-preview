import fs from "node:fs/promises";
import path from "node:path";
import { ensureArtifactsDir, resolveArtifactsPath } from "./agi-artifacts";
import type { AgiEvidence, AgiTrajectory } from "@shared/agi-refinery";
import { getTrainingTraceExport } from "../server/services/observability/training-trace-store";
import {
  DEFAULT_HOLDOUT_PATH,
  extractHoldoutPayload,
  filterHoldoutTrajectories,
  loadHoldoutSet,
} from "../server/services/agi/refinery-holdout";
import {
  normalizeEvidencePath,
  normalizeEvidenceRef,
} from "../server/services/agi/refinery-identity";
import { searchRepoGraph } from "../server/services/repo/repoGraph";
import { searchRepoIndex } from "../server/services/search/repo-index";

type OracleArgs = {
  holdoutPath?: string;
  outPath?: string;
  limit?: number;
  tenantId?: string;
  k?: number;
  maxQueries?: number;
  maxGold?: number;
};

type OracleMetrics = {
  createdAt: string;
  total: number;
  withGold: number;
  n_total: number;
  n_with_gold: number;
  n_gold_in_index: number;
  n_gold_in_candidates: number;
  n_gold_selected: number;
  n_gold_cited: number;
  goldPaths: number;
  indexCoverageHits: number;
  indexCoverageRate: number;
  plannedHitCount: number;
  plannedHitRate: number;
  naiveHitCount: number;
  naiveHitRate: number;
  plannedGoldHitCount: number;
  naiveGoldHitCount: number;
  bothHit: number;
  neitherHit: number;
  plannedBeatsNaive: number;
  naiveBeatsPlanned: number;
  plannedQueriesAvg: number;
  naiveQueriesAvg: number;
  missingIndexPaths?: Array<{ path: string; count: number }>;
};

const parseArgs = (): OracleArgs => {
  const args = process.argv.slice(2);
  const out: OracleArgs = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--holdout") {
      out.holdoutPath = args[i + 1];
      i += 1;
    } else if (token === "--out") {
      out.outPath = args[i + 1];
      i += 1;
    } else if (token === "--limit") {
      out.limit = Number(args[i + 1]);
      i += 1;
    } else if (token === "--tenant") {
      out.tenantId = args[i + 1];
      i += 1;
    } else if (token === "--k") {
      out.k = Number(args[i + 1]);
      i += 1;
    } else if (token === "--max-queries") {
      out.maxQueries = Number(args[i + 1]);
      i += 1;
    } else if (token === "--max-gold") {
      out.maxGold = Number(args[i + 1]);
      i += 1;
    }
  }
  return out;
};

const normalizePath = (value?: string): string =>
  normalizeEvidencePath(value, {
    lowercase: true,
    normalizeExtensions: true,
  }) ?? "";

const normalizeCitation = (value?: string): string =>
  normalizeEvidenceRef(value) ?? "";

const collectEvidencePaths = (items?: AgiEvidence[]): string[] =>
  (items ?? [])
    .map((item) => normalizePath(item.path))
    .filter((value) => value.length > 0);

const collectCitationPaths = (trajectory: AgiTrajectory): string[] =>
  (trajectory.y?.citations ?? [])
    .map((citation) => normalizeCitation(String(citation)))
    .filter((value) => value.length > 0);

const matchPath = (gold: string, candidate: string): boolean =>
  gold === candidate || candidate.endsWith(gold) || gold.endsWith(candidate);

const buildPathQueries = (value: string): string[] => {
  const normalized = value.trim();
  if (!normalized) return [];
  const parsed = path.parse(normalized);
  const base = parsed.base;
  const name = parsed.name;
  const queries = new Set<string>();
  queries.add(normalized);
  if (base) queries.add(base);
  if (name) queries.add(name);
  return Array.from(queries);
};

const collectHitPaths = (hits: Array<{ file_path?: string; path?: string }>): string[] =>
  hits
    .map((hit) => normalizePath(hit.file_path ?? hit.path))
    .filter((value) => value.length > 0);

const searchIndexForPath = async (
  query: string,
  limit: number,
): Promise<string[]> => {
  const response = await searchRepoIndex({ query, limit, kinds: ["doc", "code"] });
  return response.items
    .map((item) => normalizePath(String(item.source?.path ?? "")))
    .filter((value) => value.length > 0);
};

const searchGraphForQuery = async (
  query: string,
  limit: number,
): Promise<string[]> => {
  const response = await searchRepoGraph({ query, limit });
  return collectHitPaths(response.hits);
};

const buildGoldPaths = (trajectory: AgiTrajectory, maxGold: number): string[] => {
  const selected = collectEvidencePaths(trajectory.meta?.retrievalSelected);
  const candidates = collectEvidencePaths(trajectory.meta?.retrievalCandidates);
  const citations = collectCitationPaths(trajectory);
  const merged = [...selected, ...candidates, ...citations];
  const deduped = Array.from(new Set(merged)).filter(Boolean);
  return deduped.slice(0, maxGold);
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
  const { trajectories } = extractHoldoutPayload(traces);
  const { holdout: holdoutTrajectories } = filterHoldoutTrajectories(
    trajectories,
    holdout,
  );

  const limit = Number.isFinite(args.k) ? Math.max(3, Math.floor(args.k ?? 0)) : 12;
  const maxQueries = Number.isFinite(args.maxQueries)
    ? Math.max(1, Math.floor(args.maxQueries ?? 0))
    : 3;
  const maxGold = Number.isFinite(args.maxGold)
    ? Math.max(1, Math.floor(args.maxGold ?? 0))
    : 5;

  let total = 0;
  let withGold = 0;
  let goldPathsTotal = 0;
  let indexCoverageHits = 0;
  let plannedHitCount = 0;
  let naiveHitCount = 0;
  let plannedGoldHitCount = 0;
  let naiveGoldHitCount = 0;
  let bothHit = 0;
  let neitherHit = 0;
  let plannedBeatsNaive = 0;
  let naiveBeatsPlanned = 0;
  let plannedQueriesSum = 0;
  let naiveQueriesSum = 0;
  const missingIndexPathCounts: Record<string, number> = {};

  for (const trajectory of holdoutTrajectories) {
    total += 1;
    const goldPaths = buildGoldPaths(trajectory, maxGold);
    if (goldPaths.length === 0) {
      continue;
    }
    withGold += 1;
    goldPathsTotal += goldPaths.length;

    let pathHits = 0;
    for (const goldPath of goldPaths) {
      const queries = buildPathQueries(goldPath);
      let matched = false;
      for (const query of queries) {
        const hits = await searchIndexForPath(query, limit);
        if (hits.some((hit) => matchPath(goldPath, hit))) {
          matched = true;
          break;
        }
      }
      if (matched) pathHits += 1;
      if (!matched) {
        missingIndexPathCounts[goldPath] =
          (missingIndexPathCounts[goldPath] ?? 0) + 1;
      }
    }
    indexCoverageHits += pathHits;

    let plannedQueries = (trajectory.q ?? [])
      .map((item) => item.text?.trim())
      .filter((value): value is string => Boolean(value))
      .slice(0, maxQueries);
    if (plannedQueries.length === 0 && trajectory.meta?.searchQuery) {
      const fallback = trajectory.meta.searchQuery.trim();
      if (fallback) plannedQueries = [fallback];
    }
    plannedQueriesSum += plannedQueries.length;
    const plannedHitPaths = new Set<string>();
    for (const query of plannedQueries) {
      const hits = await searchGraphForQuery(query, limit);
      hits.forEach((hit) => plannedHitPaths.add(hit));
    }
    const plannedHitList = Array.from(plannedHitPaths);
    const plannedHit = goldPaths.some((gold) =>
      plannedHitList.some((hit) => matchPath(gold, hit)),
    );
    const plannedGoldHits = goldPaths.filter((gold) =>
      plannedHitList.some((hit) => matchPath(gold, hit)),
    );
    plannedGoldHitCount += plannedGoldHits.length;

    const basenames = goldPaths.map((gold) => path.basename(gold));
    const naiveQuery = [trajectory.x, ...basenames].filter(Boolean).join(" ");
    const naiveQueries = naiveQuery ? [naiveQuery] : [];
    naiveQueriesSum += naiveQueries.length;
    let naiveHit = false;
    if (naiveQuery) {
      const naiveHits = await searchGraphForQuery(naiveQuery, limit);
      naiveHit = goldPaths.some((gold) =>
        naiveHits.some((hit) => matchPath(gold, hit)),
      );
      const naiveGoldHits = goldPaths.filter((gold) =>
        naiveHits.some((hit) => matchPath(gold, hit)),
      );
      naiveGoldHitCount += naiveGoldHits.length;
    }

    if (plannedHit) plannedHitCount += 1;
    if (naiveHit) naiveHitCount += 1;
    if (plannedHit && naiveHit) bothHit += 1;
    if (!plannedHit && !naiveHit) neitherHit += 1;
    if (plannedHit && !naiveHit) plannedBeatsNaive += 1;
    if (!plannedHit && naiveHit) naiveBeatsPlanned += 1;
  }

  const indexCoverageRate =
    goldPathsTotal > 0 ? indexCoverageHits / goldPathsTotal : 0;
  const plannedHitRate = withGold > 0 ? plannedHitCount / withGold : 0;
  const naiveHitRate = withGold > 0 ? naiveHitCount / withGold : 0;
  const plannedQueriesAvg = withGold > 0 ? plannedQueriesSum / withGold : 0;
  const naiveQueriesAvg = withGold > 0 ? naiveQueriesSum / withGold : 0;
  const missingIndexPaths = Object.entries(missingIndexPathCounts)
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

  const metrics: OracleMetrics = {
    createdAt: new Date().toISOString(),
    total,
    withGold,
    n_total: total,
    n_with_gold: goldPathsTotal,
    n_gold_in_index: indexCoverageHits,
    n_gold_in_candidates: plannedGoldHitCount,
    n_gold_selected: 0,
    n_gold_cited: 0,
    goldPaths: goldPathsTotal,
    indexCoverageHits,
    indexCoverageRate,
    plannedHitCount,
    plannedHitRate,
    naiveHitCount,
    naiveHitRate,
    plannedGoldHitCount,
    naiveGoldHitCount,
    bothHit,
    neitherHit,
    plannedBeatsNaive,
    naiveBeatsPlanned,
    plannedQueriesAvg,
    naiveQueriesAvg,
    missingIndexPaths: missingIndexPaths.length > 0 ? missingIndexPaths : undefined,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const outPath = args.outPath
    ? path.resolve(args.outPath)
    : resolveArtifactsPath(`agi-refinery-holdout-oracle.${stamp}.json`);
  await ensureArtifactsDir(outPath);
  await fs.writeFile(outPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outPath, metrics }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
