import fs from "node:fs";
import path from "node:path";
import micromatch from "micromatch";
import { MATH_STAGE_LEVELS, type MathStage } from "../shared/math-stage.js";

export type MathConfigRule = {
  pattern: string;
  stage: MathStage;
};

export type MathConfig = {
  defaultStage?: MathStage;
  pathStages?: MathConfigRule[];
  strictStages?: MathStage[];
};

const DEFAULT_CONFIG_PATH = "math.config.json";
const HEADER_SCAN_LINES = 6;
const HEADER_PATTERN = /^\s*\/\/\s*math-stage:\s*([a-z-]+)\s*$/i;
const BLOCK_HEADER_PATTERN = /^\s*\/\*\s*math-stage:\s*([a-z-]+)\s*\*\/\s*$/i;

const normalizePath = (filePath: string, repoRoot: string) =>
  path.relative(repoRoot, filePath).replace(/\\/g, "/");

const normalizeStage = (value: string): MathStage | null => {
  const stage = value.trim().toLowerCase() as MathStage;
  return stage in MATH_STAGE_LEVELS ? stage : null;
};

const readInlineStage = (
  modulePath: string,
  repoRoot: string,
): MathStage | null => {
  const absolute = path.resolve(repoRoot, modulePath);
  if (!fs.existsSync(absolute)) return null;
  const source = fs.readFileSync(absolute, "utf8");
  const lines = source.split(/\r?\n/, HEADER_SCAN_LINES);
  for (const line of lines) {
    const inlineMatch = HEADER_PATTERN.exec(line);
    if (inlineMatch?.[1]) {
      return normalizeStage(inlineMatch[1]);
    }
    const blockMatch = BLOCK_HEADER_PATTERN.exec(line);
    if (blockMatch?.[1]) {
      return normalizeStage(blockMatch[1]);
    }
  }
  return null;
};

export const loadMathConfig = (repoRoot = process.cwd()): MathConfig | null => {
  const configPath = path.resolve(
    repoRoot,
    process.env.MATH_CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
  );
  if (!fs.existsSync(configPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return JSON.parse(raw) as MathConfig;
  } catch {
    return null;
  }
};

export const resolveStageFromConfig = (
  modulePath: string,
  config: MathConfig | null,
  repoRoot = process.cwd(),
): MathStage | null => {
  const inlineStage = readInlineStage(modulePath, repoRoot);
  if (inlineStage) return inlineStage;
  if (!config) return null;
  const normalized = normalizePath(
    path.resolve(repoRoot, modulePath),
    repoRoot,
  );
  const rules = config.pathStages ?? [];
  for (const rule of rules) {
    if (!rule?.pattern || !rule?.stage) continue;
    if (micromatch.isMatch(normalized, rule.pattern, { dot: true })) {
      return rule.stage;
    }
  }
  return config.defaultStage ?? null;
};

const parseStrictStages = (value: string): MathStage[] => {
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is MathStage => entry in MATH_STAGE_LEVELS);
};

export const resolveStrictStages = (config: MathConfig | null): MathStage[] => {
  const envStages = process.env.MATH_STRICT_STAGES;
  if (envStages) {
    return parseStrictStages(envStages);
  }
  const envStrict = process.env.MATH_STRICT;
  if (envStrict && envStrict !== "0" && envStrict.toLowerCase() !== "false") {
    return ["diagnostic", "certified"];
  }
  return config?.strictStages ?? [];
};
