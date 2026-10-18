import fs from "node:fs";
import path from "node:path";

export type WaiverKind = "stage" | "evidence" | "unit" | "narrative";

export type EdgeWaiver = {
  from: string;
  to: string;
  waive: WaiverKind[];
  note?: string;
};

export type ModuleWaiver = {
  module: string;
  waive: WaiverKind[];
  note?: string;
};

export type MathWaivers = {
  version?: number;
  edges?: EdgeWaiver[];
  modules?: ModuleWaiver[];
};

const DEFAULT_PATH = "math.waivers.json";

export const loadMathWaivers = (repoRoot = process.cwd()): MathWaivers => {
  const waiverPath = path.resolve(
    repoRoot,
    process.env.MATH_WAIVER_PATH ?? DEFAULT_PATH,
  );
  if (!fs.existsSync(waiverPath)) {
    return { edges: [], modules: [] };
  }
  try {
    const raw = fs.readFileSync(waiverPath, "utf8");
    const parsed = JSON.parse(raw) as MathWaivers;
    return {
      edges: parsed.edges ?? [],
      modules: parsed.modules ?? [],
      version: parsed.version,
    };
  } catch {
    return { edges: [], modules: [] };
  }
};

export const buildWaiverIndex = (waivers: MathWaivers) => {
  const edgeIndex = new Map<string, EdgeWaiver>();
  const moduleIndex = new Map<string, ModuleWaiver>();
  (waivers.edges ?? []).forEach((edge) => {
    if (!edge?.from || !edge?.to) return;
    edgeIndex.set(`${edge.from}::${edge.to}`, edge);
  });
  (waivers.modules ?? []).forEach((module) => {
    if (!module?.module) return;
    moduleIndex.set(module.module, module);
  });
  return { edgeIndex, moduleIndex };
};

export const hasWaiver = (
  waive?: WaiverKind[],
  kind?: WaiverKind,
): boolean => {
  if (!kind || !waive) return false;
  return waive.includes(kind);
};
