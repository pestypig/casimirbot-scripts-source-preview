import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import {
  MATH_STAGE_LEVELS,
  mathStageRegistry,
  type MathCheck,
  type MathStage,
  type MathStageEntry,
  type UnitSignature,
} from "../shared/math-stage.js";
import { loadMathConfig, resolveStageFromConfig } from "./math-config.js";
import { buildAutoEvidenceChecks } from "./math-discovery.js";
import {
  loadEvidenceProfiles,
  mapEvidenceTokenToProfile,
  type EvidenceProfileName,
} from "./math-evidence.js";
import {
  buildWaiverIndex,
  hasWaiver,
  loadMathWaivers,
  type WaiverKind,
} from "./math-waivers.js";

type MathGraphEdge = {
  from: string;
  to: string;
  reason?: string;
  waiver?: string;
  unitKeyWarnings?: boolean;
};

type EvidenceIssue = {
  module: string;
  stage: MathStage;
  missing: string[];
};

type NarrativeIssue = {
  module: string;
  stage: MathStage;
  missing: string[];
};

type UnitVector = {
  M: number;
  L: number;
  T: number;
  unknown: string[];
};

type UnitCoverage = {
  entriesWithUnits: number;
  entriesMissingUnits: string[];
  byStage: Record<
    MathStage,
    { total: number; withUnits: number; missing: string[] }
  >;
};

type UnitViolation = {
  from: string;
  to: string;
  key: string;
  fromUnit: string;
  toUnit: string;
  reason: string;
  severity: "error" | "warning";
};

type AutoEvidenceSummary = {
  moduleCount: number;
  testCount: number;
  modules: string[];
};

type EvidenceProfileSummary = {
  name: EvidenceProfileName;
  label: string;
  commands: string[];
  tests: number;
};

type AutoGraphSummary = {
  nodeCount: number;
  edgeCount: number;
};

type StageViolation = {
  from: string;
  to: string;
  fromStage: MathStage;
  toStage: MathStage;
  reason: string;
};

type UnstagedSuggestions = Partial<Record<MathStage, string[]>>;

type WaivedIssue = {
  kind: WaiverKind;
  module?: string;
  from?: string;
  to?: string;
  reason?: string;
};

const REPORT_DIR = process.env.MATH_REPORT_DIR ?? "reports";
const REPORT_JSON = process.env.MATH_REPORT_JSON ?? "math-report.json";
const REPORT_MD = process.env.MATH_REPORT_MD ?? "math-report.md";
const MAX_LIST = Number(process.env.MATH_REPORT_MAX_LIST ?? 50);

const TEST_LIKE_TYPES = new Set<MathCheck["type"]>([
  "test",
  "certificate",
  "snapshot",
  "stability",
  "residual",
]);
const STABILITY_TYPES = new Set<MathCheck["type"]>(["stability", "snapshot"]);
const RESIDUAL_TYPES = new Set<MathCheck["type"]>(["residual"]);
const NARRATIVE_MIN_WAYPOINTS = 3;
const NARRATIVE_MAX_WAYPOINTS = 7;
const UNIT_KEY_ALIASES: Record<string, string> = {
  T00_avg: "T00",
  T11_avg: "T11",
  T22_avg: "T22",
  T33_avg: "T33",
  t00: "T00",
  avgT00: "T00",
  stressEnergyT00: "T00",
  stressEnergyT11: "T11",
  stressEnergyT22: "T22",
  stressEnergyT33: "T33",
  beta_avg: "beta",
  betaAvg: "beta",
  natarioShiftAmplitude: "beta",
  shiftAmplitude: "beta",
  gap: "gap_nm",
  gap_nm: "gap_nm",
  gammaVanDenBroeck: "gammaVdB",
  gammaVdB: "gammaVdB",
  modulationFreqGHz: "modulationFreq_GHz",
  modulationFreq_GHz: "modulationFreq_GHz",
  burstLengthUs: "burst_us",
  burstDuration: "burst_us",
  cycleLengthUs: "cycle_us",
  cycleDuration: "cycle_us",
};

const WATCH_GLOBS = [
  "modules/gr/**/*.ts",
  "modules/warp/**/*.ts",
  "modules/analysis/**/*.ts",
  "modules/dynamic/**/*.ts",
  "modules/physics/**/*.ts",
  "server/gr/**/*.ts",
  "server/gr-*.ts",
  "server/energy-pipeline.ts",
  "server/stress-energy-brick.ts",
  "server/services/observability/**/*.ts",
  "server/services/constraint-packs/**/*.ts",
  "server/routes/agi*.ts",
  "server/routes/analysis-loops.ts",
  "server/routes/training-trace.ts",
  "server/routes/warp-viability.ts",
  "tools/warp*.ts",
  "tools/verifyCertificate.ts",
];

const IGNORE_GLOBS = [
  "**/__tests__/**",
  "**/*.spec.ts",
  "**/*.test.ts",
  "**/*.d.ts",
  "**/index.ts",
];

const repoRoot = process.cwd();
const registryByModule = new Map(
  mathStageRegistry.map((entry) => [entry.module, entry]),
);
const waivers = loadMathWaivers();
const { edgeIndex, moduleIndex } = buildWaiverIndex(waivers);

const fileExists = (relativePath: string) =>
  fs.existsSync(path.resolve(repoRoot, relativePath));

const isModuleWaived = (module: string, kind: WaiverKind) =>
  hasWaiver(moduleIndex.get(module)?.waive, kind);

const isEdgeWaived = (from: string, to: string, kind: WaiverKind) =>
  hasWaiver(edgeIndex.get(`${from}::${to}`)?.waive, kind);

const hasAnyType = (checks: MathCheck[], types: Set<MathCheck["type"]>) =>
  checks.some((check) => types.has(check.type));

const requiresResidualEvidence = (entry: MathStageEntry) =>
  entry.tag.startsWith("GR_");
const requiresNarrative = (entry: MathStageEntry) => entry.stage === "certified";

const normalizeWaypoints = (waypoints?: string[]) =>
  (waypoints ?? []).map((value) => value.trim()).filter(Boolean);

const resolveEvidenceIssues = (
  entry: MathStageEntry,
  checks: MathCheck[],
): EvidenceIssue | null => {
  const missing: string[] = [];

  switch (entry.stage) {
    case "exploratory":
      if (checks.length === 0) {
        missing.push("sanity_checks");
      }
      break;
    case "reduced-order":
      if (!hasAnyType(checks, TEST_LIKE_TYPES)) {
        missing.push("test_or_snapshot");
      }
      break;
    case "diagnostic":
      if (!hasAnyType(checks, STABILITY_TYPES)) {
        missing.push("stability_or_snapshot");
      }
      if (requiresResidualEvidence(entry) && !hasAnyType(checks, RESIDUAL_TYPES)) {
        missing.push("residual_check");
      }
      break;
    case "certified":
      if (!hasAnyType(checks, TEST_LIKE_TYPES)) {
        missing.push("test_or_snapshot");
      }
      if (!checks.some((check) => check.type === "policy")) {
        missing.push("policy_check");
      }
      break;
  }

  for (const check of checks) {
    if (!fileExists(check.path)) {
      missing.push(`missing_${check.type}_file:${check.path}`);
    }
  }

  return missing.length > 0
    ? { module: entry.module, stage: entry.stage, missing }
    : null;
};

const resolveNarrativeIssues = (entry: MathStageEntry): NarrativeIssue | null => {
  if (!requiresNarrative(entry)) return null;
  const missing: string[] = [];
  const motivation = entry.motivation?.trim();
  const waypoints = normalizeWaypoints(entry.conceptualWaypoints);

  if (!motivation) {
    missing.push("motivation");
  }
  if (waypoints.length === 0) {
    missing.push("conceptual_waypoints");
  } else {
    if (waypoints.length < NARRATIVE_MIN_WAYPOINTS) {
      missing.push(`conceptual_waypoints_min:${NARRATIVE_MIN_WAYPOINTS}`);
    }
    if (waypoints.length > NARRATIVE_MAX_WAYPOINTS) {
      missing.push(`conceptual_waypoints_max:${NARRATIVE_MAX_WAYPOINTS}`);
    }
  }

  return missing.length > 0
    ? { module: entry.module, stage: entry.stage, missing }
    : null;
};

const normalizeUnitKey = (key: string) => UNIT_KEY_ALIASES[key] ?? key;

const normalizeUnits = (units?: UnitSignature) => {
  const normalized = new Map<string, string>();
  if (!units) return normalized;
  for (const [key, value] of Object.entries(units)) {
    const canonical = normalizeUnitKey(key);
    if (!normalized.has(canonical)) {
      normalized.set(canonical, value);
    }
  }
  return normalized;
};

const parseUnitVector = (unit: string): UnitVector => {
  const trimmed = unit.trim();
  const vec: UnitVector = { M: 0, L: 0, T: 0, unknown: [] };
  if (!trimmed || trimmed === "1") {
    return vec;
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (token === "1") continue;
    const match = /^([MLT])(?:\^(-?\d+))?$/.exec(token);
    if (!match) {
      vec.unknown.push(token);
      continue;
    }
    const dim = match[1] as "M" | "L" | "T";
    const exp = match[2] ? Number(match[2]) : 1;
    vec[dim] += Number.isFinite(exp) ? exp : 0;
  }
  return vec;
};

const isDimensionless = (unit: UnitVector) =>
  unit.M === 0 && unit.L === 0 && unit.T === 0;

const sameDimensions = (left: UnitVector, right: UnitVector) =>
  left.M === right.M && left.L === right.L && left.T === right.T;

const isLengthTimeSwap = (left: UnitVector, right: UnitVector) =>
  left.M === right.M && left.L === right.T && left.T === right.L;

const loadGraph = (fallbackEdges: MathGraphEdge[] = []): { edges: MathGraphEdge[] } => {
  const graphPath = path.resolve(repoRoot, "MATH_GRAPH.json");
  if (!fs.existsSync(graphPath)) {
    return { edges: fallbackEdges };
  }
  const raw = fs.readFileSync(graphPath, "utf8");
  const parsed = JSON.parse(raw) as { edges?: MathGraphEdge[] };
  return { edges: Array.isArray(parsed.edges) ? parsed.edges : [] };
};

const buildAdjacency = (edges: MathGraphEdge[]) => {
  const adjacency = new Map<string, MathGraphEdge[]>();
  for (const edge of edges) {
    if (!edge?.from || !edge?.to) continue;
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge);
    adjacency.set(edge.from, list);
  }
  return adjacency;
};

const resolveUnitCoverage = (): UnitCoverage => {
  const byStage: UnitCoverage["byStage"] = {
    exploratory: { total: 0, withUnits: 0, missing: [] },
    "reduced-order": { total: 0, withUnits: 0, missing: [] },
    diagnostic: { total: 0, withUnits: 0, missing: [] },
    certified: { total: 0, withUnits: 0, missing: [] },
  };
  let entriesWithUnits = 0;
  const entriesMissingUnits: string[] = [];
  for (const entry of mathStageRegistry) {
    const stage = entry.stage;
    const unitCount = entry.units ? Object.keys(entry.units).length : 0;
    byStage[stage].total += 1;
    if (unitCount > 0) {
      byStage[stage].withUnits += 1;
      entriesWithUnits += 1;
    } else if (stage !== "exploratory") {
      byStage[stage].missing.push(entry.module);
      entriesMissingUnits.push(entry.module);
    }
  }
  return { entriesWithUnits, entriesMissingUnits, byStage };
};

const resolveUnitViolations = (edges: MathGraphEdge[]): UnitViolation[] => {
  const violations: UnitViolation[] = [];
  for (const edge of edges) {
    const fromEntry = registryByModule.get(edge.from);
    const toEntry = registryByModule.get(edge.to);
    if (!fromEntry || !toEntry) continue;
    const fromUnits = normalizeUnits(fromEntry.units);
    const toUnits = normalizeUnits(toEntry.units);
    if (fromUnits.size === 0 || toUnits.size === 0) continue;

    for (const [key, fromUnitRaw] of fromUnits.entries()) {
      if (!toUnits.has(key)) continue;
      const toUnitRaw = toUnits.get(key);
      if (!toUnitRaw) continue;
      const fromVec = parseUnitVector(fromUnitRaw);
      const toVec = parseUnitVector(toUnitRaw);

      if (fromVec.unknown.length > 0) {
        violations.push({
          from: fromEntry.module,
          to: toEntry.module,
          key,
          fromUnit: fromUnitRaw,
          toUnit: toUnitRaw,
          reason: `unknown tokens: ${fromVec.unknown.join(", ")}`,
          severity: "warning",
        });
      }
      if (toVec.unknown.length > 0) {
        violations.push({
          from: fromEntry.module,
          to: toEntry.module,
          key,
          fromUnit: fromUnitRaw,
          toUnit: toUnitRaw,
          reason: `unknown tokens: ${toVec.unknown.join(", ")}`,
          severity: "warning",
        });
      }

      if (isDimensionless(toVec) && !isDimensionless(fromVec)) {
        violations.push({
          from: fromEntry.module,
          to: toEntry.module,
          key,
          fromUnit: fromUnitRaw,
          toUnit: toUnitRaw,
          reason: "dimensionless_target",
          severity: "error",
        });
        continue;
      }

      if (sameDimensions(fromVec, toVec)) continue;

      if (edge.unitConversion && isLengthTimeSwap(fromVec, toVec)) {
        continue;
      }

      violations.push({
        from: fromEntry.module,
        to: toEntry.module,
        key,
        fromUnit: fromUnitRaw,
        toUnit: toUnitRaw,
        reason: edge.unitConversion
          ? "conversion_not_applicable"
          : "unit_mismatch",
        severity: "error",
      });
    }
  }
  return violations;
};

const resolveStageViolations = (
  edges: MathGraphEdge[],
  evidenceIssues: Map<string, EvidenceIssue>,
): {
  edgeViolations: StageViolation[];
  pipelineViolations: StageViolation[];
} => {
  const edgeViolations: StageViolation[] = [];
  const pipelineViolations: StageViolation[] = [];
  const adjacency = buildAdjacency(edges);

  const certifiedMax = MATH_STAGE_LEVELS.diagnostic;
  for (const edge of edges) {
    const fromEntry = registryByModule.get(edge.from);
    const toEntry = registryByModule.get(edge.to);
    if (!fromEntry || !toEntry) continue;
    const toLevel = MATH_STAGE_LEVELS[toEntry.stage];
    if (fromEntry.stage === "certified" && toLevel > certifiedMax) {
      if (!edge.waiver || edge.waiver.trim().length === 0) {
        edgeViolations.push({
          from: edge.from,
          to: edge.to,
          fromStage: fromEntry.stage,
          toStage: toEntry.stage,
          reason: "certified_dependency_requires_waiver",
        });
      }
    }
  }

  const minUpstreamStage: Record<MathStage, number> = {
    exploratory: MATH_STAGE_LEVELS.exploratory,
    "reduced-order": MATH_STAGE_LEVELS.exploratory,
    diagnostic: MATH_STAGE_LEVELS["reduced-order"],
    certified: MATH_STAGE_LEVELS["reduced-order"],
  };

  const visitFromRoot = (root: MathStageEntry) => {
    const rootMinStage = minUpstreamStage[root.stage];
    const seen = new Set<string>();
    const stack: string[] = [root.module];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      if (seen.has(current)) continue;
      seen.add(current);
      const edgesFrom = adjacency.get(current) ?? [];
      for (const edge of edgesFrom) {
        const child = registryByModule.get(edge.to);
        if (!child) continue;
        const childLevel = MATH_STAGE_LEVELS[child.stage];
        if (childLevel < rootMinStage) {
          if (!edge.waiver || edge.waiver.trim().length === 0) {
            pipelineViolations.push({
              from: edge.from,
              to: edge.to,
              fromStage: root.stage,
              toStage: child.stage,
              reason: "upstream_stage_below_minimum",
            });
          }
        }
        if (root.stage === "certified" && evidenceIssues.has(child.module)) {
          if (!edge.waiver || edge.waiver.trim().length === 0) {
            pipelineViolations.push({
              from: edge.from,
              to: edge.to,
              fromStage: root.stage,
              toStage: child.stage,
              reason: "upstream_missing_evidence",
            });
          }
        }
        stack.push(child.module);
      }
    }
  };

  mathStageRegistry
    .filter((entry) => entry.stage === "certified")
    .forEach(visitFromRoot);

  return { edgeViolations, pipelineViolations };
};

const buildCoverage = () => {
  const coverage: Record<
    MathStage,
    { count: number; modules: string[] }
  > = {
    exploratory: { count: 0, modules: [] },
    "reduced-order": { count: 0, modules: [] },
    diagnostic: { count: 0, modules: [] },
    certified: { count: 0, modules: [] },
  };
  for (const entry of mathStageRegistry) {
    coverage[entry.stage].count += 1;
    coverage[entry.stage].modules.push(entry.module);
  }
  return coverage;
};

const resolveUnstagedModules = async (): Promise<string[]> => {
  const staged = new Set(mathStageRegistry.map((entry) => entry.module));
  const files = await fg(WATCH_GLOBS, {
    ignore: IGNORE_GLOBS,
    dot: false,
  });
  return files.filter((file) => !staged.has(file)).sort();
};

const buildUnstagedSuggestions = (
  modules: string[],
  config: ReturnType<typeof loadMathConfig>,
): UnstagedSuggestions => {
  if (!config) return {};
  const suggestions: UnstagedSuggestions = {};
  for (const modulePath of modules) {
    const stage = resolveStageFromConfig(modulePath, config);
    if (!stage) continue;
    const list = suggestions[stage] ?? [];
    list.push(modulePath);
    suggestions[stage] = list;
  }
  return suggestions;
};

const renderList = (items: string[], max = MAX_LIST) => {
  if (items.length === 0) return "none";
  const shown = items.slice(0, max);
  const tail = items.length > max ? `\n- ... (${items.length - max} more)` : "";
  return `- ${shown.join("\n- ")}${tail}`;
};

const renderViolations = (items: StageViolation[], max = MAX_LIST) => {
  if (items.length === 0) return "none";
  const shown = items.slice(0, max).map((item) => {
    return `${item.from} -> ${item.to} (${item.reason})`;
  });
  const tail = items.length > max ? `\n- ... (${items.length - max} more)` : "";
  return `- ${shown.join("\n- ")}${tail}`;
};

const renderEvidenceIssues = (items: EvidenceIssue[], max = MAX_LIST) => {
  if (items.length === 0) return "none";
  const shown = items.slice(0, max).map((item) => {
    return `${item.module} (${item.stage}): ${item.missing.join(", ")}`;
  });
  const tail = items.length > max ? `\n- ... (${items.length - max} more)` : "";
  return `- ${shown.join("\n- ")}${tail}`;
};

const renderNarrativeIssues = (items: NarrativeIssue[], max = MAX_LIST) => {
  if (items.length === 0) return "none";
  const shown = items.slice(0, max).map((item) => {
    return `${item.module} (${item.stage}): ${item.missing.join(", ")}`;
  });
  const tail = items.length > max ? `\n- ... (${items.length - max} more)` : "";
  return `- ${shown.join("\n- ")}${tail}`;
};

const ensureReportDir = () => {
  const dir = path.resolve(repoRoot, REPORT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const main = async () => {
  const autoEvidence = buildAutoEvidenceChecks(mathStageRegistry);
  const autoChecksByModule = autoEvidence.autoChecksByModule;
  const autoModules = Array.from(autoChecksByModule.keys()).sort();
  const autoTestFiles = new Set<string>();
  autoChecksByModule.forEach((checks) => {
    checks.forEach((check) => autoTestFiles.add(check.path));
  });
  const autoEvidenceSummary: AutoEvidenceSummary = {
    moduleCount: autoModules.length,
    testCount: autoTestFiles.size,
    modules: autoModules,
  };
  const autoGraphEdges: MathGraphEdge[] = autoEvidence.graph.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
  }));
  const autoGraphSummary: AutoGraphSummary = {
    nodeCount: autoEvidence.graph.nodes.size,
    edgeCount: autoEvidence.graph.edges.length,
  };

  const mergeChecks = (entry: MathStageEntry) => {
    const manualChecks = entry.checks ?? [];
    const autoChecks = autoChecksByModule.get(entry.module) ?? [];
    if (autoChecks.length === 0) return manualChecks;
    const merged = new Map<string, MathCheck>();
    for (const check of manualChecks) {
      merged.set(`${check.type}:${check.path}`, check);
    }
    for (const check of autoChecks) {
      merged.set(`${check.type}:${check.path}`, check);
    }
    return Array.from(merged.values());
  };

  const coverage = buildCoverage();
  const unstaged = await resolveUnstagedModules();
  const mathConfig = loadMathConfig();
  const unstagedSuggestions = buildUnstagedSuggestions(unstaged, mathConfig);
  const evidenceProfiles = loadEvidenceProfiles();
  const rawEvidenceIssues = mathStageRegistry
    .map((entry) => resolveEvidenceIssues(entry, mergeChecks(entry)))
    .filter((item): item is EvidenceIssue => item !== null);
  const rawNarrativeIssues = mathStageRegistry
    .map((entry) => resolveNarrativeIssues(entry))
    .filter((item): item is NarrativeIssue => item !== null);
  const waivedIssues: WaivedIssue[] = [];
  const evidenceIssues = rawEvidenceIssues.filter((issue) => {
    if (isModuleWaived(issue.module, "evidence")) {
      waivedIssues.push({
        kind: "evidence",
        module: issue.module,
        reason: issue.missing.join(", "),
      });
      return false;
    }
    return true;
  });
  const narrativeIssues = rawNarrativeIssues.filter((issue) => {
    if (isModuleWaived(issue.module, "narrative")) {
      waivedIssues.push({
        kind: "narrative",
        module: issue.module,
        reason: issue.missing.join(", "),
      });
      return false;
    }
    return true;
  });
  const evidenceByProfile = new Map<EvidenceProfileName, number>();
  autoChecksByModule.forEach((checks) => {
    checks.forEach((check) => {
      if (!check.note?.startsWith("auto:")) return;
      const name = check.note.replace("auto:", "") as EvidenceProfileName;
      evidenceByProfile.set(name, (evidenceByProfile.get(name) ?? 0) + 1);
    });
  });
  const missingByProfile = new Map<EvidenceProfileName, number>();
  evidenceIssues.forEach((issue) => {
    issue.missing.forEach((token) => {
      const profile = mapEvidenceTokenToProfile(token);
      if (!profile) return;
      missingByProfile.set(profile, (missingByProfile.get(profile) ?? 0) + 1);
    });
  });
  const evidenceProfileSummaries: EvidenceProfileSummary[] = evidenceProfiles.map(
    (profile) => ({
      name: profile.name,
      label: profile.label ?? profile.name,
      commands: profile.commands ?? [],
      tests: evidenceByProfile.get(profile.name) ?? 0,
    }),
  );
  const evidenceMap = new Map(
    evidenceIssues.map((item) => [item.module, item]),
  );
  const graph = loadGraph(autoGraphEdges);
  const { edgeViolations, pipelineViolations } = resolveStageViolations(
    graph.edges,
    evidenceMap,
  );
  const filteredEdgeViolations = edgeViolations.filter((violation) => {
    if (isEdgeWaived(violation.from, violation.to, "stage")) {
      waivedIssues.push({
        kind: "stage",
        from: violation.from,
        to: violation.to,
        reason: violation.reason,
      });
      return false;
    }
    return true;
  });
  const filteredPipelineViolations = pipelineViolations.filter((violation) => {
    if (violation.reason === "upstream_missing_evidence") {
      if (
        isEdgeWaived(violation.from, violation.to, "evidence") ||
        isModuleWaived(violation.from, "evidence") ||
        isModuleWaived(violation.to, "evidence")
      ) {
        waivedIssues.push({
          kind: "evidence",
          from: violation.from,
          to: violation.to,
          reason: violation.reason,
        });
        return false;
      }
    }
    if (violation.reason === "upstream_stage_below_minimum") {
      if (isEdgeWaived(violation.from, violation.to, "stage")) {
        waivedIssues.push({
          kind: "stage",
          from: violation.from,
          to: violation.to,
          reason: violation.reason,
        });
        return false;
      }
    }
    return true;
  });

  const unitCoverage = resolveUnitCoverage();
  const unitViolations = resolveUnitViolations(graph.edges);
  const filteredUnitViolations = unitViolations.filter((violation) => {
    if (
      isEdgeWaived(violation.from, violation.to, "unit") ||
      isModuleWaived(violation.from, "unit") ||
      isModuleWaived(violation.to, "unit")
    ) {
      waivedIssues.push({
        kind: "unit",
        from: violation.from,
        to: violation.to,
        reason: `${violation.key}:${violation.reason}`,
      });
      return false;
    }
    return true;
  });

  const report = {
    generatedAt: new Date().toISOString(),
    registryCount: mathStageRegistry.length,
    coverage,
    unstaged: {
      count: unstaged.length,
      modules: unstaged,
      suggested: unstagedSuggestions,
      defaultStage: mathConfig?.defaultStage ?? null,
    },
    evidenceIssues: { count: evidenceIssues.length, items: evidenceIssues },    
    narrativeIssues: {
      count: narrativeIssues.length,
      items: narrativeIssues,
    },
    stageViolations: {
      edge: { count: filteredEdgeViolations.length, items: filteredEdgeViolations },
      pipeline: {
        count: filteredPipelineViolations.length,
        items: filteredPipelineViolations,
      },
    },
    unitCoverage,
    unitViolations: {
      count: filteredUnitViolations.length,
      errors: filteredUnitViolations.filter((item) => item.severity === "error"),
      warnings: filteredUnitViolations.filter((item) => item.severity === "warning"),
    },
    autoEvidence: autoEvidenceSummary,
    autoGraph: autoGraphSummary,
    evidenceProfiles: evidenceProfileSummaries,
    missingEvidenceProfiles: Array.from(missingByProfile.entries()).map(
      ([profile, count]) => ({ profile, count }),
    ),
    waivers: {
      edgeCount: waivers.edges?.length ?? 0,
      moduleCount: waivers.modules?.length ?? 0,
    },
    waivedIssues,
  };

  const dir = ensureReportDir();
  const jsonPath = path.join(dir, REPORT_JSON);
  const mdPath = path.join(dir, REPORT_MD);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const lines: string[] = [];
  lines.push("# Math Report");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Registry entries: ${report.registryCount}`);
  lines.push("");
  lines.push("## Coverage by Stage");
  (Object.keys(coverage) as MathStage[]).forEach((stage) => {
    lines.push(`- ${stage}: ${coverage[stage].count}`);
  });
  lines.push("");
  lines.push("## Unstaged Modules");
  lines.push(renderList(unstaged));
  lines.push("");
  lines.push("## Unstaged Stage Suggestions");
  if (!mathConfig) {
    lines.push("math.config.json not found.");
  } else {
    const stages = Object.entries(unstagedSuggestions)
      .filter(([, items]) => items.length > 0)
      .map(([stage, items]) => `${stage}: ${items.length}`);
    lines.push(stages.length > 0 ? `- ${stages.join("\n- ")}` : "none");
    if (mathConfig.defaultStage) {
      lines.push(`- default: ${mathConfig.defaultStage}`);
    }
  }
  lines.push("");
  lines.push("## Missing Evidence");
  lines.push(renderEvidenceIssues(evidenceIssues));
  lines.push("");
  lines.push("## Missing Narrative");
  lines.push(renderNarrativeIssues(narrativeIssues));
  lines.push("");
  lines.push("## Evidence Profiles");
  evidenceProfileSummaries.forEach((profile) => {
    lines.push(`- ${profile.name} (${profile.label})`);
    lines.push(`  - auto tests: ${profile.tests}`);
    if (profile.commands.length) {
      lines.push(`  - commands: ${profile.commands.join(", ")}`);
    }
  });
  lines.push("");
  lines.push("## Missing Evidence Profiles");
  if (missingByProfile.size === 0) {
    lines.push("none");
  } else {
    const items = Array.from(missingByProfile.entries()).map(
      ([profile, count]) => `${profile}: ${count}`,
    );
    lines.push(renderList(items));
  }
  lines.push("");
  lines.push("## Auto-discovered Evidence");
  lines.push(`- modules with test coverage: ${autoEvidenceSummary.moduleCount}`);
  lines.push(`- tests considered: ${autoEvidenceSummary.testCount}`);
  lines.push("");
  lines.push("## Auto-discovered Dependencies");
  lines.push(`- nodes: ${autoGraphSummary.nodeCount}`);
  lines.push(`- edges: ${autoGraphSummary.edgeCount}`);
  lines.push("");
  lines.push("## Stage Violations (Edges)");
  lines.push(renderViolations(filteredEdgeViolations));
  lines.push("");
  lines.push("## Stage Violations (Pipelines)");
  lines.push(renderViolations(filteredPipelineViolations));
  lines.push("");
  lines.push("## Waivers");
  lines.push(`- edge waivers: ${waivers.edges?.length ?? 0}`);
  lines.push(`- module waivers: ${waivers.modules?.length ?? 0}`);
  lines.push("");
  lines.push("## Waived Issues");
  if (waivedIssues.length === 0) {
    lines.push("none");
  } else {
    const formatted = waivedIssues.map((issue) => {
      if (issue.module) {
        return `${issue.kind}: ${issue.module}${issue.reason ? ` (${issue.reason})` : ""}`;
      }
      return `${issue.kind}: ${issue.from} -> ${issue.to}${issue.reason ? ` (${issue.reason})` : ""}`;
    });
    lines.push(renderList(formatted));
  }
  lines.push("");
  lines.push("## Unit Coverage");
  lines.push(
    `- entries with units: ${unitCoverage.entriesWithUnits}/${mathStageRegistry.length}`,
  );
  if (unitCoverage.entriesMissingUnits.length) {
    lines.push("- missing units:");
    lines.push(renderList(unitCoverage.entriesMissingUnits));
  } else {
    lines.push("- missing units: none");
  }
  lines.push("");
  lines.push("## Unit Violations");
  if (unitViolations.length === 0) {
    lines.push("none");
  } else {
    const formatted = unitViolations.map(
      (item) =>
        `${item.from} -> ${item.to} ${item.key} (${item.fromUnit} -> ${item.toUnit}): ${item.reason} [${item.severity}]`,
    );
    lines.push(renderList(formatted));
  }
  lines.push("");
  fs.writeFileSync(mdPath, `${lines.join("\n")}\n`, "utf8");

  console.log(`Math report written to ${path.relative(repoRoot, jsonPath)}`);
  console.log(`Math report written to ${path.relative(repoRoot, mdPath)}`);
};

main();
