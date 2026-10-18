import fs from "node:fs";
import path from "node:path";
import micromatch from "micromatch";
import type { MathCheckType } from "../shared/math-stage.js";
import { resolveArtifactsPath } from "./agi-artifacts";

export type EvidenceProfileName =
  | "sanity_checks"
  | "regression"
  | "residual_check"
  | "certificate";

export type EvidenceProfile = {
  name: EvidenceProfileName;
  label?: string;
  checkType?: MathCheckType;
  testGlobs?: string[];
  commands?: string[];
};

export type EvidenceConfig = {
  profiles: EvidenceProfile[];
};

const DEFAULT_PATH = "math.evidence.json";

const normalizePath = (filePath: string, repoRoot: string) =>
  path.relative(repoRoot, filePath).replace(/\\/g, "/");

const DEFAULT_TRACE_OUT = resolveArtifactsPath("training-trace.jsonl");

const DEFAULT_PROFILES: EvidenceProfile[] = [
  {
    name: "sanity_checks",
    label: "Sanity checks",
    checkType: "test",
    testGlobs: [
      "**/*sanity*.spec.ts",
      "**/*sanity*.test.ts",
      "**/*smoke*.spec.ts",
      "**/*smoke*.test.ts",
      "**/*canary*.spec.ts",
      "**/*canary*.test.ts",
      "**/*health*.spec.ts",
      "**/*health*.test.ts",
    ],
    commands: ["npm run lint", "npm test -- --run '*sanity*'"],
  },
  {
    name: "residual_check",
    label: "Residual checks",
    checkType: "residual",
    testGlobs: [
      "**/*residual*.spec.ts",
      "**/*residual*.test.ts",
      "**/*constraint*.spec.ts",
      "**/*constraint*.test.ts",
      "**/*gate*.spec.ts",
      "**/*gate*.test.ts",
    ],
    commands: ["npm run math:validate", "npm test -- --run '*constraint*'"],
  },
  {
    name: "certificate",
    label: "Certificate / policy checks",
    checkType: "certificate",
    testGlobs: [
      "**/*certificate*.spec.ts",
      "**/*certificate*.test.ts",
      "**/*viability*.spec.ts",
      "**/*viability*.test.ts",
    ],
    commands: [
      `npm run casimir:verify -- --ci --trace-out ${DEFAULT_TRACE_OUT}`,
    ],
  },
  {
    name: "regression",
    label: "Regression tests",
    checkType: "snapshot",
    testGlobs: ["**/*.spec.ts", "**/*.test.ts"],
    commands: ["npm test"],
  },
];

export const loadEvidenceProfiles = (repoRoot = process.cwd()) => {
  const configPath = path.resolve(
    repoRoot,
    process.env.MATH_EVIDENCE_PATH ?? DEFAULT_PATH,
  );
  if (!fs.existsSync(configPath)) {
    return DEFAULT_PROFILES;
  }
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as EvidenceConfig;
    if (!Array.isArray(parsed.profiles) || parsed.profiles.length === 0) {
      return DEFAULT_PROFILES;
    }
    return parsed.profiles;
  } catch {
    return DEFAULT_PROFILES;
  }
};

export const matchEvidenceProfileForTest = (
  testPath: string,
  profiles: EvidenceProfile[],
  repoRoot = process.cwd(),
): EvidenceProfile | null => {
  const normalized = normalizePath(path.resolve(repoRoot, testPath), repoRoot);
  for (const profile of profiles) {
    if (!profile.testGlobs || profile.testGlobs.length === 0) continue;
    if (micromatch.isMatch(normalized, profile.testGlobs, { dot: true })) {
      return profile;
    }
  }
  return null;
};

export const mapEvidenceTokenToProfile = (
  token: string,
): EvidenceProfileName | null => {
  switch (token) {
    case "sanity_checks":
      return "sanity_checks";
    case "test_or_snapshot":
    case "stability_or_snapshot":
      return "regression";
    case "residual_check":
      return "residual_check";
    case "policy_check":
    case "certificate_check":
      return "certificate";
    default:
      return null;
  }
};
