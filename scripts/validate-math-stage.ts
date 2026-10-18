import fs from "node:fs";
import path from "node:path";
import {
  MATH_STAGE_LEVELS,
  mathStageRegistry,
  type MathCheck,
  type MathStage,
  type MathStageEntry,
  type UnitSignature,
} from "../shared/math-stage.js";
import { buildAutoEvidenceChecks } from "./math-discovery.js";
import { loadMathConfig, resolveStrictStages } from "./math-config.js";
import {
  buildWaiverIndex,
  hasWaiver,
  loadMathWaivers,
  type WaiverKind,
} from "./math-waivers.js";

type StageRule = {
  minChecks: number;
  requireTestLike?: boolean;
  requirePolicy?: boolean;
  requireStability?: boolean;
};

type MathGraphEdge = {
  from: string;
  to: string;
  reason?: string;
  waiver?: string;
  unitConversion?: boolean;
  unitKeyWarnings?: boolean;
};

type UnitVector = {
  M: number;
  L: number;
  T: number;
  unknown: string[];
};

const STAGE_RULES: Record<MathStage, StageRule> = {
  exploratory: { minChecks: 0 },
  "reduced-order": { minChecks: 1, requireTestLike: true },
  diagnostic: { minChecks: 1, requireStability: true },
  certified: { minChecks: 2, requireTestLike: true, requirePolicy: true },
};

const repoRoot = process.cwd();
const errors: string[] = [];
const warnings: string[] = [];
const unitWarnings: string[] = [];
const entryErrors = new Map<string, string[]>();
const entryWarnings = new Map<string, string[]>();
const registryByModule = new Map(
  mathStageRegistry.map((entry) => [entry.module, entry]),
);
const autoEvidence = buildAutoEvidenceChecks(mathStageRegistry);
const autoChecksByModule = autoEvidence.autoChecksByModule;
const waivers = loadMathWaivers();
const { edgeIndex, moduleIndex } = buildWaiverIndex(waivers);
const mathConfig = loadMathConfig();
const strictStages = new Set(resolveStrictStages(mathConfig));
const unitStrictRaw = process.env.MATH_UNIT_WARNINGS_STRICT;
const STRICT_UNIT_WARNINGS =
  unitStrictRaw === "1" || unitStrictRaw?.toLowerCase() === "true";

const fileExists = (relativePath: string) =>
  fs.existsSync(path.resolve(repoRoot, relativePath));

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

const hasType = (checks: MathCheck[], type: MathCheck["type"]) =>
  checks.some((check) => check.type === type);

const hasAnyType = (checks: MathCheck[], types: Set<MathCheck["type"]>) =>      
  checks.some((check) => types.has(check.type));

const requiresResidualEvidence = (entry: MathStageEntry) =>
  entry.tag.startsWith("GR_") && entry.residualsRequired !== false;
const requiresNarrative = (entry: MathStageEntry) => entry.stage === "certified";

const normalizeWaypoints = (waypoints?: string[]) =>
  (waypoints ?? []).map((value) => value.trim()).filter(Boolean);

const normalizeUnitKey = (key: string) => UNIT_KEY_ALIASES[key] ?? key;

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

const sameDimensions = (left: UnitVector, right: UnitVector) =>
  left.M === right.M && left.L === right.L && left.T === right.T;

const isDimensionless = (unit: UnitVector) =>
  unit.M === 0 && unit.L === 0 && unit.T === 0;

const isLengthTimeSwap = (left: UnitVector, right: UnitVector) =>
  left.M === right.M && left.L === right.T && left.T === right.L;

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

const unitsByModule = new Map(
  mathStageRegistry.map((entry) => [entry.module, normalizeUnits(entry.units)]),
);

const pushEntryIssue = (
  map: Map<string, string[]>,
  module: string,
  message: string,
) => {
  const existing = map.get(module) ?? [];
  existing.push(message);
  map.set(module, existing);
};

const recordError = (module: string, message: string) => {
  const stage = registryByModule.get(module)?.stage;
  const shouldFail =
    strictStages.size > 0
      ? stage
        ? strictStages.has(stage)
        : true
      : false;
  if (!shouldFail) {
    recordWarning(module, message);
    return;
  }
  errors.push(message);
  pushEntryIssue(entryErrors, module, message);
};

const recordWarning = (module: string, message: string) => {
  warnings.push(message);
  pushEntryIssue(entryWarnings, module, message);
};

const isModuleWaived = (module: string, kind: WaiverKind) =>
  hasWaiver(moduleIndex.get(module)?.waive, kind);

const isEdgeWaived = (edge: MathGraphEdge, kind: WaiverKind) =>
  hasWaiver(edgeIndex.get(`${edge.from}::${edge.to}`)?.waive, kind);

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

const reportUnitIssue = (
  module: string,
  message: string,
  severity: "error" | "warning",
) => {
  if (isModuleWaived(module, "unit")) {
    return;
  }
  if (severity === "error") {
    recordError(module, message);
  } else {
    unitWarnings.push(message);
  }
};

const validateEntry = (entry: MathStageEntry, checks: MathCheck[]) => {
  if (!(entry.stage in MATH_STAGE_LEVELS)) {
    recordError(entry.module, `Unknown stage "${entry.stage}" in ${entry.module}.`);
    return;
  }

  if (!fileExists(entry.module)) {
    recordError(entry.module, `Module not found: ${entry.module}`);
  }

  const rules = STAGE_RULES[entry.stage];
  const unitKeys = entry.units ? Object.keys(entry.units) : [];
  const evidenceWaived = isModuleWaived(entry.module, "evidence");
  const narrativeWaived = isModuleWaived(entry.module, "narrative");

  if (entry.tag === "PIPELINE" && unitKeys.length === 0) {
    recordError(
      entry.module,
      `${entry.module} (PIPELINE) requires unit signatures for outputs.`,
    );
  }

  if (entry.stage === "exploratory" && checks.length === 0 && !evidenceWaived) {
    recordWarning(
      entry.module,
      `${entry.module} (exploratory) has no sanity checks listed.`,
    );
  }

  if (checks.length < rules.minChecks && !evidenceWaived) {
    recordError(
      entry.module,
      `${entry.module} (${entry.stage}) requires at least ${rules.minChecks} checks.`,
    );
  }

  if (rules.requireTestLike && !hasAnyType(checks, TEST_LIKE_TYPES) && !evidenceWaived) {
    recordError(
      entry.module,
      `${entry.module} (${entry.stage}) requires a test or snapshot check.`,
    );
  }

  if (rules.requirePolicy && !hasType(checks, "policy") && !evidenceWaived) {
    recordError(
      entry.module,
      `${entry.module} (${entry.stage}) requires a policy check.`,
    );
  }

  if (rules.requireStability && !hasAnyType(checks, STABILITY_TYPES) && !evidenceWaived) {
    recordError(
      entry.module,
      `${entry.module} (${entry.stage}) requires a stability or snapshot check.`,
    );
  }

  if (entry.stage === "diagnostic" && requiresResidualEvidence(entry)) {        
    if (!hasAnyType(checks, RESIDUAL_TYPES) && !evidenceWaived) {
      recordError(
        entry.module,
        `${entry.module} (${entry.stage}) requires a residual check.`,
      );
    }
  }

  if (requiresNarrative(entry) && !narrativeWaived) {
    const motivation = entry.motivation?.trim();
    const waypoints = normalizeWaypoints(entry.conceptualWaypoints);
    if (!motivation) {
      recordError(
        entry.module,
        `${entry.module} (${entry.stage}) requires a motivation statement.`,
      );
    }
    if (waypoints.length === 0) {
      recordError(
        entry.module,
        `${entry.module} (${entry.stage}) requires conceptual waypoints.`,
      );
    } else {
      if (waypoints.length < NARRATIVE_MIN_WAYPOINTS) {
        recordError(
          entry.module,
          `${entry.module} (${entry.stage}) requires at least ${NARRATIVE_MIN_WAYPOINTS} conceptual waypoints.`,
        );
      }
      if (waypoints.length > NARRATIVE_MAX_WAYPOINTS) {
        recordError(
          entry.module,
          `${entry.module} (${entry.stage}) exceeds ${NARRATIVE_MAX_WAYPOINTS} conceptual waypoints.`,
        );
      }
    }
  }

  for (const check of checks) {
    if (!fileExists(check.path)) {
      if (!evidenceWaived) {
        recordError(
          entry.module,
          `${entry.module} references missing ${check.type} check: ${check.path}`,
        );
      }
    }
  }
};

mathStageRegistry.forEach((entry) => validateEntry(entry, mergeChecks(entry)));

const validateUnitOverlap = (
  edge: MathGraphEdge,
  fromEntry: MathStageEntry,
  toEntry: MathStageEntry,
) => {
  if (isEdgeWaived(edge, "unit")) {
    return;
  }
  const fromUnits = unitsByModule.get(edge.from);
  const toUnits = unitsByModule.get(edge.to);
  if (!fromUnits || !toUnits || fromUnits.size === 0 || toUnits.size === 0) {
    return;
  }
  const formatKeys = (keys: string[]) =>
    keys.length > 6
      ? `${keys.slice(0, 6).join(", ")} (+${keys.length - 6} more)`
      : keys.join(", ");
  if (edge.unitKeyWarnings) {
    const missingOnTo = Array.from(fromUnits.keys()).filter(
      (key) => !toUnits.has(key),
    );
    if (missingOnTo.length > 0) {
      reportUnitIssue(
        toEntry.module,
        `${toEntry.module} missing unit keys from ${fromEntry.module} on edge: ${formatKeys(missingOnTo)}.`,
        "warning",
      );
    }
    const missingOnFrom = Array.from(toUnits.keys()).filter(
      (key) => !fromUnits.has(key),
    );
    if (missingOnFrom.length > 0) {
      reportUnitIssue(
        fromEntry.module,
        `${fromEntry.module} missing unit keys from ${toEntry.module} on edge: ${formatKeys(missingOnFrom)}.`,
        "warning",
      );
    }
  }
  for (const [key, fromUnitRaw] of fromUnits.entries()) {
    if (!toUnits.has(key)) continue;
    const toUnitRaw = toUnits.get(key);
    if (!toUnitRaw) continue;
    const fromVec = parseUnitVector(fromUnitRaw);
    const toVec = parseUnitVector(toUnitRaw);
    if (fromVec.unknown.length > 0) {
      reportUnitIssue(
        fromEntry.module,
        `${fromEntry.module} unit "${fromUnitRaw}" for ${key} has unknown tokens (${fromVec.unknown.join(", ")}).`,
        "warning",
      );
    }
    if (toVec.unknown.length > 0) {
      reportUnitIssue(
        toEntry.module,
        `${toEntry.module} unit "${toUnitRaw}" for ${key} has unknown tokens (${toVec.unknown.join(", ")}).`,
        "warning",
      );
    }

    if (isDimensionless(toVec) && !isDimensionless(fromVec)) {
      reportUnitIssue(
        toEntry.module,
        `${toEntry.module} expects dimensionless ${key} but ${fromEntry.module} provides ${fromUnitRaw}.`,
        "error",
      );
      continue;
    }

    if (sameDimensions(fromVec, toVec)) continue;

    if (edge.unitConversion && isLengthTimeSwap(fromVec, toVec)) {
      continue;
    }

    reportUnitIssue(
      fromEntry.module,
      `Unit mismatch for ${key}: ${fromEntry.module} (${fromUnitRaw}) -> ${toEntry.module} (${toUnitRaw}) without allowed conversion.`,
      "error",
    );
  }
};

const graphPath = path.resolve(repoRoot, "MATH_GRAPH.json");
const autoGraphEdges: MathGraphEdge[] = autoEvidence.graph.edges.map((edge) => ({
  from: edge.from,
  to: edge.to,
}));
if (!fs.existsSync(graphPath)) {
  warnings.push("Missing MATH_GRAPH.json; using import-discovered graph.");
  try {
    const edges = autoGraphEdges;
    const adjacency = new Map<string, MathGraphEdge[]>();
    for (const edge of edges) {
      if (!edge?.from || !edge?.to) continue;
      const list = adjacency.get(edge.from) ?? [];
      list.push(edge);
      adjacency.set(edge.from, list);
    }
    const certifiedMax = MATH_STAGE_LEVELS.diagnostic;
    edges.forEach((edge, index) => {
      if (!edge?.from || !edge?.to) {
        recordError("MATH_GRAPH.json", `Auto graph edge #${index + 1} missing from/to.`);
        return;
      }
      const fromEntry = registryByModule.get(edge.from);
      const toEntry = registryByModule.get(edge.to);
      if (!fromEntry) {
          recordError(edge.from, `MATH_GRAPH.json edge from unknown module: ${edge.from}`);
      }
      if (!toEntry) {
        recordError(edge.to, `MATH_GRAPH.json edge to unknown module: ${edge.to}`);
      }
      if (!fromEntry || !toEntry) return;
      validateUnitOverlap(edge, fromEntry, toEntry);
      const fromLevel = MATH_STAGE_LEVELS[fromEntry.stage];
      const toLevel = MATH_STAGE_LEVELS[toEntry.stage];
      if (fromEntry.stage === "certified" && toLevel > certifiedMax) {
        if (!edge.waiver || edge.waiver.trim().length === 0) {
          if (isEdgeWaived(edge, "stage")) {
            return;
          }
          recordError(
            edge.from,
            `${edge.from} (certified) depends on ${edge.to} (${toEntry.stage}) without waiver.`,
          );
        }
      }
    });

    const minUpstreamStage: Record<MathStage, number> = {
      exploratory: MATH_STAGE_LEVELS.exploratory,
      "reduced-order": MATH_STAGE_LEVELS.exploratory,
      diagnostic: MATH_STAGE_LEVELS["reduced-order"],
      certified: MATH_STAGE_LEVELS["reduced-order"],
    };

    const visitPath = (root: MathStageEntry) => {
      const rootMinStage = minUpstreamStage[root.stage];
      const seen = new Set<string>();
      const stack: Array<{ module: string }> = [{ module: root.module }];
      while (stack.length > 0) {
        const current = stack.pop();
        if (!current) continue;
        const moduleName = current.module;
        if (seen.has(moduleName)) continue;
        seen.add(moduleName);
        const edgesFrom = adjacency.get(moduleName) ?? [];
        for (const edge of edgesFrom) {
          const child = registryByModule.get(edge.to);
          if (!child) continue;
          const childLevel = MATH_STAGE_LEVELS[child.stage];
          if (childLevel < rootMinStage) {
            if (!edge.waiver || edge.waiver.trim().length === 0) {
              if (isEdgeWaived(edge, "stage")) {
                continue;
              }
              recordError(
                root.module,
                `${root.module} (${root.stage}) depends on ${child.module} (${child.stage}) below minimum stage without waiver.`,
              );
            }
          }
          if (root.stage === "certified") {
            const warns = entryWarnings.get(child.module) ?? [];
            if (
              warns.length > 0 &&
              (!edge.waiver || edge.waiver.trim().length === 0) &&
              !isEdgeWaived(edge, "evidence")
            ) {
              recordError(
                root.module,
                `${root.module} depends on ${child.module} with unresolved evidence: ${warns.join("; ")}`,
              );
            }
          }
          stack.push({ module: child.module });
        }
      }
    };

    mathStageRegistry
      .filter((entry) => entry.stage === "certified")
      .forEach(visitPath);
  } catch (error) {
    recordError("MATH_GRAPH.json", `Failed to build auto graph: ${String(error)}`);
  }
} else {
  try {
    const graphRaw = fs.readFileSync(graphPath, "utf8");
    const graph = JSON.parse(graphRaw) as { edges?: MathGraphEdge[] };
    const edges = Array.isArray(graph.edges) ? graph.edges : [];
    const adjacency = new Map<string, MathGraphEdge[]>();
    for (const edge of edges) {
      if (!edge?.from || !edge?.to) continue;
      const list = adjacency.get(edge.from) ?? [];
      list.push(edge);
      adjacency.set(edge.from, list);
    }
    if (!Array.isArray(graph.edges)) {
      recordError("MATH_GRAPH.json", "MATH_GRAPH.json must include an edges array.");
    }
    const certifiedMax = MATH_STAGE_LEVELS.diagnostic;
    edges.forEach((edge, index) => {
      if (!edge?.from || !edge?.to) {
        recordError("MATH_GRAPH.json", `MATH_GRAPH.json edge #${index + 1} missing from/to.`);
        return;
      }
      const fromEntry = registryByModule.get(edge.from);
      const toEntry = registryByModule.get(edge.to);
      if (!fromEntry) {
        recordError(edge.from, `MATH_GRAPH.json edge from unknown module: ${edge.from}`);
      }
      if (!toEntry) {
        recordError(edge.to, `MATH_GRAPH.json edge to unknown module: ${edge.to}`);
      }
      if (!fromEntry || !toEntry) return;
      validateUnitOverlap(edge, fromEntry, toEntry);
      const fromLevel = MATH_STAGE_LEVELS[fromEntry.stage];
      const toLevel = MATH_STAGE_LEVELS[toEntry.stage];
      if (fromEntry.stage === "certified" && toLevel > certifiedMax) {
        if (!edge.waiver || edge.waiver.trim().length === 0) {
          if (isEdgeWaived(edge, "stage")) {
            return;
          }
          recordError(
            edge.from,
            `${edge.from} (certified) depends on ${edge.to} (${toEntry.stage}) without waiver.`,
          );
        }
      }
    });

    const minUpstreamStage: Record<MathStage, number> = {
      exploratory: MATH_STAGE_LEVELS.exploratory,
      "reduced-order": MATH_STAGE_LEVELS.exploratory,
      diagnostic: MATH_STAGE_LEVELS["reduced-order"],
      certified: MATH_STAGE_LEVELS["reduced-order"],
    };

    const visitPath = (root: MathStageEntry) => {
      const rootMinStage = minUpstreamStage[root.stage];
      const seen = new Set<string>();
      const stack: Array<{ module: string }> = [{ module: root.module }];
      while (stack.length > 0) {
        const current = stack.pop();
        if (!current) continue;
        const moduleName = current.module;
        if (seen.has(moduleName)) continue;
        seen.add(moduleName);
        const edgesFrom = adjacency.get(moduleName) ?? [];
        for (const edge of edgesFrom) {
          const child = registryByModule.get(edge.to);
          if (!child) continue;
          const childLevel = MATH_STAGE_LEVELS[child.stage];
          if (childLevel < rootMinStage) {
            if (!edge.waiver || edge.waiver.trim().length === 0) {
              if (isEdgeWaived(edge, "stage")) {
                continue;
              }
              recordError(
                root.module,
                `${root.module} (${root.stage}) depends on ${child.module} (${child.stage}) below minimum stage without waiver.`,
              );
            }
          }
          if (root.stage === "certified") {
            const warns = entryWarnings.get(child.module) ?? [];
            if (
              warns.length > 0 &&
              (!edge.waiver || edge.waiver.trim().length === 0) &&
              !isEdgeWaived(edge, "evidence")
            ) {
              recordError(
                root.module,
                `${root.module} depends on ${child.module} with unresolved evidence: ${warns.join("; ")}`,
              );
            }
          }
          stack.push({ module: child.module });
        }
      }
    };

    mathStageRegistry
      .filter((entry) => entry.stage === "certified")
      .forEach(visitPath);
  } catch (error) {
    recordError("MATH_GRAPH.json", `Failed to parse MATH_GRAPH.json: ${String(error)}`);
  }
}

if (warnings.length > 0) {
  console.warn("Math stage warnings:");
  warnings.forEach((message) => console.warn(`- ${message}`));
}

if (unitWarnings.length > 0) {
  console.warn("Math unit warnings:");
  unitWarnings.forEach((message) => console.warn(`- ${message}`));
}
if (unitWarnings.length > 0 && STRICT_UNIT_WARNINGS) {
  console.error("Math unit warnings treated as errors (strict mode).");
  unitWarnings.forEach((message) => errors.push(`[unit-warning] ${message}`));
}

if (errors.length > 0) {
  console.error("Math stage validation failed:");
  errors.forEach((message) => console.error(`- ${message}`));
  process.exitCode = 1;
} else {
  console.log(
    `Math stage validation OK (${mathStageRegistry.length} entries).`,
  );
}
