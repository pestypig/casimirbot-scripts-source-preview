import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RepoAtlas } from "./repo-atlas-build";

const DEFAULT_ATLAS_PATH = path.join(process.cwd(), "artifacts", "repo-atlas", "repo-atlas.v1.json");
const DEFAULT_REL_TOL = 1e-9;
const DEFAULT_ABS_TOL = 1e-12;

type Direction = "upstream" | "downstream";
type G4Selector = "same-rho-source" | "best-candidate" | "lowest-margin";

type DivergenceField = {
  name: string;
  aliases?: string[];
};

type StageDefinition = {
  id: string;
  label: string;
  fields: DivergenceField[];
};

type StageFieldComparison = {
  name: string;
  canonicalValue: unknown;
  recoveryValue: unknown;
  equal: boolean;
  comparator: "numeric_tolerance" | "exact";
  deltaAbs: number | null;
  deltaRel: number | null;
  reason: string | null;
};

type StageComparison = {
  id: string;
  label: string;
  diverged: boolean;
  comparedFields: number;
  differingFields: string[];
  fields: StageFieldComparison[];
};

type FirstDivergence = {
  stageId: string;
  stageLabel: string;
  differingFields: string[];
  summary: string;
};

type RecoveryCase = Record<string, unknown> & {
  id?: string;
};

const G4_STAGES: StageDefinition[] = [
  {
    id: "S0_source",
    label: "Source",
    fields: [
      { name: "rhoSource" },
      { name: "metricT00Ref" },
      { name: "metricT00Si_Jm3", aliases: ["metricT00SiFromGeom_Jm3"] },
    ],
  },
  {
    id: "S1_qi_sample",
    label: "QI Sample",
    fields: [{ name: "lhs_Jm3" }],
  },
  {
    id: "S2_bound_computed",
    label: "Bound Computed",
    fields: [{ name: "boundComputed_Jm3" }, { name: "K" }, { name: "tau_s" }],
  },
  {
    id: "S3_bound_policy",
    label: "Bound Policy",
    fields: [
      { name: "boundUsed_Jm3" },
      { name: "boundFloorApplied" },
      { name: "boundPolicyFloor_Jm3" },
      { name: "boundFloor_Jm3" },
    ],
  },
  {
    id: "S4_margin",
    label: "Margin",
    fields: [{ name: "marginRatioRawComputed", aliases: ["marginRatioRaw"] }, { name: "marginRatioRaw" }],
  },
  {
    id: "S5_gate",
    label: "Gate",
    fields: [
      { name: "applicabilityStatus" },
      { name: "reasonCode", aliases: ["g4ReasonCodes"] },
    ],
  },
];

const normalize = (value: string): string => value.trim().toLowerCase();
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
const finiteOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const normalizeArray = (value: unknown[]): unknown[] => {
  const allScalars = value.every((entry) => ["string", "number", "boolean"].includes(typeof entry) || entry == null);
  if (!allScalars) return value;
  return value.slice().sort((a, b) => String(a).localeCompare(String(b)));
};
const normalizeValue = (value: unknown): unknown => (Array.isArray(value) ? normalizeArray(value) : value);

export const loadAtlas = async (atlasPath = DEFAULT_ATLAS_PATH): Promise<RepoAtlas> => {
  const raw = await fs.readFile(atlasPath, "utf8");
  return JSON.parse(raw) as RepoAtlas;
};

const rankFieldMatch = (value: string, needle: string, fieldWeight: number): number => {
  const normalized = normalize(value);
  if (!normalized) return -1;
  if (normalized === needle) return 1000 + fieldWeight;
  if (normalized.startsWith(needle)) return 500 + fieldWeight - Math.max(0, normalized.length - needle.length);
  if (normalized.includes(needle)) return Math.max(1, 100 + fieldWeight - Math.max(0, normalized.length - needle.length));
  return -1;
};

export const resolveIdentifier = (atlas: RepoAtlas, identifier: string) => {
  const needle = normalize(identifier);
  if (!needle) return undefined;

  const ranked = atlas.nodes
    .map((node) => {
      const score = Math.max(
        rankFieldMatch(node.id, needle, 30),
        rankFieldMatch(node.label, needle, 20),
        rankFieldMatch(node.path ?? "", needle, 10),
      );
      return { node, score };
    })
    .filter((row) => row.score >= 0)
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));

  return ranked[0]?.node;
};

const buildAdjacency = (
  atlas: RepoAtlas,
  direction: Direction,
): Map<string, Array<{ to: string; kind: string; sourceSystem: string }>> => {
  const map = new Map<string, Array<{ to: string; kind: string; sourceSystem: string }>>();
  for (const edge of atlas.edges) {
    const from = direction === "downstream" ? edge.source : edge.target;
    const to = direction === "downstream" ? edge.target : edge.source;
    const list = map.get(from) ?? [];
    list.push({ to, kind: edge.kind, sourceSystem: edge.sourceSystem });
    map.set(from, list);
  }
  return map;
};

const bfsPaths = (atlas: RepoAtlas, startId: string, direction: Direction, maxDepth = 4): string[][] => {
  const adjacency = buildAdjacency(atlas, direction);
  const queue: Array<{ id: string; path: string[]; depth: number }> = [{ id: startId, path: [startId], depth: 0 }];
  const visited = new Set<string>([startId]);
  const paths: string[][] = [];

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    if (item.depth >= maxDepth) continue;
    for (const step of adjacency.get(item.id) ?? []) {
      const nextId = step.to;
      const nextPath = [...item.path, nextId];
      paths.push(nextPath);
      if (!visited.has(nextId)) {
        visited.add(nextId);
        queue.push({ id: nextId, path: nextPath, depth: item.depth + 1 });
      }
    }
  }

  return paths.sort((a, b) => a.join("|").localeCompare(b.join("|")));
};

const buildDirectedEdgeLookup = (
  atlas: RepoAtlas,
  direction: Direction,
): Map<string, Array<{ kind: string; sourceSystem: string }>> => {
  const lookup = new Map<string, Array<{ kind: string; sourceSystem: string }>>();
  for (const edge of atlas.edges) {
    const from = direction === "downstream" ? edge.source : edge.target;
    const to = direction === "downstream" ? edge.target : edge.source;
    const key = `${from}|${to}`;
    const list = lookup.get(key) ?? [];
    list.push({ kind: edge.kind, sourceSystem: edge.sourceSystem });
    lookup.set(key, list);
  }
  return lookup;
};

const summarizePathDiagnostics = (atlas: RepoAtlas, paths: string[][], direction: Direction) => {
  const edgeLookup = buildDirectedEdgeLookup(atlas, direction);
  const edgeTypeCounts: Record<string, number> = {};
  const sourceSystemCounts: Record<string, number> = {};
  const pathHopDepthCounts: Record<string, number> = {};
  const pathHopDiagnostics = paths.slice(0, 16).map((pathIds) => {
    const hops: Array<{ from: string; to: string; kind: string; sourceSystem: string }> = [];
    for (let i = 0; i + 1 < pathIds.length; i += 1) {
      const from = pathIds[i];
      const to = pathIds[i + 1];
      const key = `${from}|${to}`;
      const metadata = edgeLookup.get(key)?.[0] ?? { kind: "unknown", sourceSystem: "unknown" };
      edgeTypeCounts[metadata.kind] = (edgeTypeCounts[metadata.kind] ?? 0) + 1;
      sourceSystemCounts[metadata.sourceSystem] = (sourceSystemCounts[metadata.sourceSystem] ?? 0) + 1;
      hops.push({
        from,
        to,
        kind: metadata.kind,
        sourceSystem: metadata.sourceSystem,
      });
    }
    const hopCount = Math.max(0, pathIds.length - 1);
    pathHopDepthCounts[String(hopCount)] = (pathHopDepthCounts[String(hopCount)] ?? 0) + 1;
    return {
      nodes: pathIds,
      hop_count: hopCount,
      hops: hops.slice(0, 12),
    };
  });
  return {
    path_count: paths.length,
    edge_type_counts: edgeTypeCounts,
    source_system_counts: sourceSystemCounts,
    path_hop_depth_counts: pathHopDepthCounts,
    path_hop_diagnostics: pathHopDiagnostics,
  };
};

export const whyIdentifier = (atlas: RepoAtlas, identifier: string) => {
  const node = resolveIdentifier(atlas, identifier);
  if (!node) return null;
  const producers = bfsPaths(atlas, node.id, "upstream", 3);
  const consumers = bfsPaths(atlas, node.id, "downstream", 3);
  const producerDiagnostics = summarizePathDiagnostics(atlas, producers, "upstream");
  const consumerDiagnostics = summarizePathDiagnostics(atlas, consumers, "downstream");
  return {
    node,
    producers,
    consumers,
    producer_path_count: producerDiagnostics.path_count,
    producer_edge_type_counts: producerDiagnostics.edge_type_counts,
    producer_source_system_counts: producerDiagnostics.source_system_counts,
    producer_path_hop_depth_counts: producerDiagnostics.path_hop_depth_counts,
    producer_path_hop_diagnostics: producerDiagnostics.path_hop_diagnostics,
    consumer_path_count: consumerDiagnostics.path_count,
    consumer_edge_type_counts: consumerDiagnostics.edge_type_counts,
    consumer_source_system_counts: consumerDiagnostics.source_system_counts,
    consumer_path_hop_depth_counts: consumerDiagnostics.path_hop_depth_counts,
    consumer_path_hop_diagnostics: consumerDiagnostics.path_hop_diagnostics,
  };
};

export const traceIdentifier = (atlas: RepoAtlas, identifier: string, direction: Direction) => {
  const node = resolveIdentifier(atlas, identifier);
  if (!node) return null;
  const paths = bfsPaths(atlas, node.id, direction, 6);
  const diagnostics = summarizePathDiagnostics(atlas, paths, direction);
  return {
    node,
    direction,
    paths,
    path_count: diagnostics.path_count,
    edge_type_counts: diagnostics.edge_type_counts,
    source_system_counts: diagnostics.source_system_counts,
    path_hop_depth_counts: diagnostics.path_hop_depth_counts,
    path_hop_diagnostics: diagnostics.path_hop_diagnostics,
  };
};

const pickFieldValue = (record: Record<string, unknown>, field: DivergenceField): unknown => {
  const keys = [field.name, ...(field.aliases ?? [])];
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
};

const compareDivergenceField = (
  field: DivergenceField,
  canonicalRecord: Record<string, unknown>,
  recoveryRecord: Record<string, unknown>,
  relTol: number,
  absTol: number,
): StageFieldComparison => {
  const canonicalValue = pickFieldValue(canonicalRecord, field);
  const recoveryValue = pickFieldValue(recoveryRecord, field);
  const canonicalNum = finiteOrNull(canonicalValue);
  const recoveryNum = finiteOrNull(recoveryValue);

  if (canonicalNum != null && recoveryNum != null) {
    const deltaAbs = Math.abs(canonicalNum - recoveryNum);
    const deltaRel = deltaAbs / Math.max(Math.abs(canonicalNum), Math.abs(recoveryNum), 1);
    const threshold = Math.max(absTol, relTol * Math.max(Math.abs(canonicalNum), Math.abs(recoveryNum), 1));
    const equal = deltaAbs <= threshold;
    return {
      name: field.name,
      canonicalValue,
      recoveryValue,
      equal,
      comparator: "numeric_tolerance",
      deltaAbs,
      deltaRel,
      reason: equal ? null : `|delta|=${deltaAbs} > tol=${threshold}`,
    };
  }

  const canonicalNormalized = normalizeValue(canonicalValue);
  const recoveryNormalized = normalizeValue(recoveryValue);
  const equal = JSON.stringify(canonicalNormalized) === JSON.stringify(recoveryNormalized);
  return {
    name: field.name,
    canonicalValue,
    recoveryValue,
    equal,
    comparator: "exact",
    deltaAbs: null,
    deltaRel: null,
    reason: equal ? null : "exact_mismatch",
  };
};

const compareDivergenceStage = (
  stage: StageDefinition,
  canonicalRecord: Record<string, unknown>,
  recoveryRecord: Record<string, unknown>,
  relTol: number,
  absTol: number,
): StageComparison => {
  const fields = stage.fields.map((field) => compareDivergenceField(field, canonicalRecord, recoveryRecord, relTol, absTol));
  const differingFields = fields.filter((field) => !field.equal).map((field) => field.name);
  return {
    id: stage.id,
    label: stage.label,
    diverged: differingFields.length > 0,
    comparedFields: fields.length,
    differingFields,
    fields,
  };
};

const compareByMarginThenId = (a: RecoveryCase, b: RecoveryCase): number =>
  (finiteOrNull(a.marginRatioRawComputed) ?? Number.POSITIVE_INFINITY) -
    (finiteOrNull(b.marginRatioRawComputed) ?? Number.POSITIVE_INFINITY) ||
  (finiteOrNull(a.marginRatioRaw) ?? Number.POSITIVE_INFINITY) - (finiteOrNull(b.marginRatioRaw) ?? Number.POSITIVE_INFINITY) ||
  String(a.id ?? "").localeCompare(String(b.id ?? ""));

const selectRecoveryCase = (
  recoveryPayload: Record<string, unknown>,
  canonicalRecord: Record<string, unknown>,
  selector: G4Selector,
  explicitCaseId?: string,
): { selected: RecoveryCase | null; selectionReason: string } => {
  const cases = Array.isArray(recoveryPayload.cases) ? (recoveryPayload.cases as RecoveryCase[]) : [];
  if (cases.length === 0) {
    return {
      selected: Object.keys(recoveryPayload).length > 0 ? (recoveryPayload as RecoveryCase) : null,
      selectionReason: "single_recovery_payload",
    };
  }

  if (explicitCaseId) {
    const selected = cases.find((entry) => String(entry.id ?? "") === explicitCaseId) ?? null;
    return {
      selected,
      selectionReason: selected ? "explicit_case_id" : "explicit_case_id_not_found",
    };
  }

  if (selector === "best-candidate") {
    const bestId = asString(asRecord(recoveryPayload.bestCandidate).id);
    if (bestId) {
      const selected = cases.find((entry) => String(entry.id ?? "") === bestId) ?? null;
      if (selected) return { selected, selectionReason: "best_candidate" };
    }
  }

  if (selector === "same-rho-source") {
    const canonicalRho = asString(canonicalRecord.rhoSource);
    if (canonicalRho) {
      const matches = cases.filter((entry) => asString(entry.rhoSource) === canonicalRho).sort(compareByMarginThenId);
      if (matches.length > 0) return { selected: matches[0], selectionReason: "same_rho_source" };
    }
  }

  const lowestMargin = cases.slice().sort(compareByMarginThenId)[0] ?? null;
  return {
    selected: lowestMargin,
    selectionReason: selector === "lowest-margin" ? "lowest_margin" : "fallback_lowest_margin",
  };
};

export const firstDivergenceG4 = (
  canonicalInput: Record<string, unknown>,
  recoveryInput: Record<string, unknown>,
  options: {
    selector?: G4Selector;
    recoveryCaseId?: string;
    relTol?: number;
    absTol?: number;
  } = {},
) => {
  const canonicalRecord = asRecord(canonicalInput);
  const recoveryPayload = asRecord(recoveryInput);
  const selector = options.selector ?? "same-rho-source";
  const relTol = Math.max(0, options.relTol ?? DEFAULT_REL_TOL);
  const absTol = Math.max(0, options.absTol ?? DEFAULT_ABS_TOL);
  const selection = selectRecoveryCase(recoveryPayload, canonicalRecord, selector, options.recoveryCaseId);

  if (!selection.selected) {
    return {
      route: "qi_margin" as const,
      selector,
      tolerances: { relTol, absTol },
      recoveryCaseIdRequested: options.recoveryCaseId ?? null,
      recoveryCaseIdSelected: null,
      selectionReason: selection.selectionReason,
      firstDivergence: null,
      stageComparisons: [] as StageComparison[],
      error: "recovery_case_missing",
    };
  }

  const selectedRecovery = asRecord(selection.selected);
  const stageComparisons = G4_STAGES.map((stage) => compareDivergenceStage(stage, canonicalRecord, selectedRecovery, relTol, absTol));
  const firstDivergedStage = stageComparisons.find((stage) => stage.diverged);
  const firstDivergence: FirstDivergence | null = firstDivergedStage
    ? {
        stageId: firstDivergedStage.id,
        stageLabel: firstDivergedStage.label,
        differingFields: firstDivergedStage.differingFields,
        summary: `${firstDivergedStage.id} diverged on: ${firstDivergedStage.differingFields.join(", ")}`,
      }
    : null;

  return {
    route: "qi_margin" as const,
    selector,
    tolerances: { relTol, absTol },
    recoveryCaseIdRequested: options.recoveryCaseId ?? null,
    recoveryCaseIdSelected: asString(selectedRecovery.id),
    selectionReason: selection.selectionReason,
    firstDivergence,
    stageComparisons,
    canonical: {
      rhoSource: asString(canonicalRecord.rhoSource),
    },
    recovery: {
      rhoSource: asString(selectedRecovery.rhoSource),
      comparabilityClass: asString(selectedRecovery.comparabilityClass),
    },
  };
};

const parseOption = (args: string[], name: string): string | null => {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  const value = args[idx + 1];
  return value.startsWith("--") ? null : value;
};

const parseNumberOption = (args: string[], name: string): number | null => {
  const value = parseOption(args, name);
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function printResult(title: string, payload: unknown) {
  console.log(`# ${title}`);
  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  const [command, arg1, arg2, ...rest] = process.argv.slice(2);
  if (!command) {
    console.error(
      "Usage: tsx scripts/repo-atlas-query.ts <why|trace> <identifier> [--upstream|--downstream]\n" +
        "   or: tsx scripts/repo-atlas-query.ts first-divergence <canonical.json> <recovery.json> [--selector same-rho-source|best-candidate|lowest-margin] [--recovery-case-id id] [--rel-tol n] [--abs-tol n]",
    );
    process.exitCode = 1;
    return;
  }

  if (command === "why") {
    if (!arg1) {
      console.error("Usage: tsx scripts/repo-atlas-query.ts why <identifier>");
      process.exitCode = 1;
      return;
    }
    const atlas = await loadAtlas();
    const result = whyIdentifier(atlas, arg1);
    if (!result) {
      console.error(`Identifier not found: ${arg1}`);
      process.exitCode = 1;
      return;
    }
    printResult(`why ${arg1}`, result);
    return;
  }

  if (command === "trace") {
    if (!arg1) {
      console.error("Usage: tsx scripts/repo-atlas-query.ts trace <identifier> [--upstream|--downstream]");
      process.exitCode = 1;
      return;
    }
    const atlas = await loadAtlas();
    const traceFlags = [arg2, ...rest].filter((entry): entry is string => Boolean(entry));
    const direction: Direction = traceFlags.includes("--upstream") ? "upstream" : "downstream";
    const result = traceIdentifier(atlas, arg1, direction);
    if (!result) {
      console.error(`Identifier not found: ${arg1}`);
      process.exitCode = 1;
      return;
    }
    printResult(`trace ${arg1} (${direction})`, result);
    return;
  }

  if (command === "first-divergence") {
    if (!arg1 || !arg2) {
      console.error("Usage: tsx scripts/repo-atlas-query.ts first-divergence <canonical.json> <recovery.json> [options]");
      process.exitCode = 1;
      return;
    }

    const route = parseOption(rest, "--route") ?? "qi_margin";
    if (route !== "qi_margin") {
      console.error(`Unsupported route: ${route}. Supported routes: qi_margin`);
      process.exitCode = 1;
      return;
    }

    const selectorRaw = parseOption(rest, "--selector");
    const selector =
      selectorRaw === "same-rho-source" || selectorRaw === "best-candidate" || selectorRaw === "lowest-margin"
        ? selectorRaw
        : selectorRaw == null
        ? "same-rho-source"
        : null;
    if (!selector) {
      console.error(`Invalid selector: ${selectorRaw}`);
      process.exitCode = 1;
      return;
    }

    const canonicalRaw = JSON.parse(await fs.readFile(path.resolve(arg1), "utf8")) as Record<string, unknown>;
    const recoveryRaw = JSON.parse(await fs.readFile(path.resolve(arg2), "utf8")) as Record<string, unknown>;
    const result = firstDivergenceG4(canonicalRaw, recoveryRaw, {
      selector,
      recoveryCaseId: parseOption(rest, "--recovery-case-id") ?? undefined,
      relTol: parseNumberOption(rest, "--rel-tol") ?? undefined,
      absTol: parseNumberOption(rest, "--abs-tol") ?? undefined,
    });

    if ("error" in result) {
      console.error(`First divergence failed: ${result.error} (${result.selectionReason})`);
      process.exitCode = 1;
      return;
    }

    printResult(`first-divergence ${arg1} vs ${arg2}`, result);
    return;
  }

  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}

export const isDirectExecution = (importMetaUrl: string, argvPath = process.argv[1]): boolean => {
  if (!argvPath) return false;
  return importMetaUrl === pathToFileURL(path.resolve(argvPath)).href;
};

if (isDirectExecution(import.meta.url)) {
  void main();
}
