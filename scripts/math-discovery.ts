import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { MathCheck, MathStageEntry } from "../shared/math-stage.js";
import {
  loadEvidenceProfiles,
  matchEvidenceProfileForTest,
} from "./math-evidence.js";

type ImportEdge = {
  from: string;
  to: string;
  specifier: string;
};

type ImportGraph = {
  edges: ImportEdge[];
  adjacency: Map<string, Set<string>>;
  nodes: Set<string>;
};

type TestEvidence = {
  byModule: Map<string, Set<string>>;
  testFiles: string[];
};

type AutoEvidence = {
  autoChecksByModule: Map<string, MathCheck[]>;
  graph: ImportGraph;
  testFiles: string[];
};

type DiscoveryOptions = {
  repoRoot?: string;
  sourceGlobs?: string[];
  testGlobs?: string[];
  ignoreGlobs?: string[];
  testManifestPath?: string;
};

const DEFAULT_SOURCE_GLOBS = [
  "modules/**/*.ts",
  "server/**/*.ts",
  "tools/**/*.ts",
  "shared/**/*.ts",
  "cli/**/*.ts",
  "sdk/src/**/*.ts",
];

const DEFAULT_TEST_GLOBS = [
  "tests/**/*.spec.ts",
  "tests/**/*.test.ts",
  "server/**/__tests__/**/*.ts",
  "tools/**/__tests__/**/*.ts",
  "**/__tests__/**/*.ts",
];

const DEFAULT_IGNORE_GLOBS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/external/**",
  "**/reports/**",
  "**/*.d.ts",
  "**/*.spec.ts",
  "**/*.test.ts",
];

const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];
const INDEX_FILES = EXTENSIONS.map((ext) => `index${ext}`);

const IMPORT_RE =
  /(?:import|export)\s+(?:[^'"]*from\s+)?["']([^"']+)["']/g;
const REQUIRE_RE = /require\(\s*["']([^"']+)["']\s*\)/g;
const DYNAMIC_RE = /import\(\s*["']([^"']+)["']\s*\)/g;

const PATH_ALIASES: Array<{ prefix: string; base: string }> = [
  { prefix: "@/", base: "client/src/" },
  { prefix: "@shared/", base: "shared/" },
  { prefix: "@shared", base: "shared" },
];

const ROOT_PREFIXES = [
  "modules/",
  "server/",
  "tools/",
  "shared/",
  "client/",
  "cli/",
  "sdk/",
];

const normalizePath = (filePath: string, repoRoot: string) =>
  path.relative(repoRoot, filePath).replace(/\\/g, "/");

const readFileSafe = (filePath: string) => {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
};

const extractSpecifiers = (source: string) => {
  const results: string[] = [];
  const collect = (regex: RegExp) => {
    regex.lastIndex = 0;
    let match = regex.exec(source);
    while (match) {
      if (match[1]) results.push(match[1]);
      match = regex.exec(source);
    }
  };
  collect(IMPORT_RE);
  collect(REQUIRE_RE);
  collect(DYNAMIC_RE);
  return results;
};

const resolveImport = (
  specifier: string,
  fromFile: string,
  repoRoot: string,
) => {
  let basePath: string | null = null;
  if (specifier.startsWith(".")) {
    basePath = path.resolve(path.dirname(fromFile), specifier);
  } else {
    const alias = PATH_ALIASES.find((entry) => specifier.startsWith(entry.prefix));
    if (alias) {
      const rest = specifier.slice(alias.prefix.length);
      basePath = path.resolve(repoRoot, alias.base, rest);
    } else if (ROOT_PREFIXES.some((prefix) => specifier.startsWith(prefix))) {
      basePath = path.resolve(repoRoot, specifier);
    }
  }

  if (!basePath) return null;

  const ext = path.extname(basePath);
  const candidates: string[] = [];
  if (ext) {
    candidates.push(basePath);
  } else {
    candidates.push(...EXTENSIONS.map((suffix) => `${basePath}${suffix}`));
    candidates.push(
      ...INDEX_FILES.map((indexFile) => path.join(basePath, indexFile)),
    );
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return normalizePath(candidate, repoRoot);
    }
  }

  return null;
};

const loadTestManifest = (manifestPath: string, repoRoot: string) => {
  if (!fs.existsSync(manifestPath)) return [];
  const raw = fs.readFileSync(manifestPath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(repoRoot, entry));
};

export const discoverImportGraph = (
  options: DiscoveryOptions = {},
): ImportGraph => {
  const repoRoot = options.repoRoot ?? process.cwd();
  const sourceGlobs = options.sourceGlobs ?? DEFAULT_SOURCE_GLOBS;
  const ignoreGlobs = options.ignoreGlobs ?? DEFAULT_IGNORE_GLOBS;
  const files = fg.sync(sourceGlobs, { ignore: ignoreGlobs, dot: false });
  const nodes = new Set<string>();
  const edges: ImportEdge[] = [];
  const adjacency = new Map<string, Set<string>>();

  for (const file of files) {
    const absolute = path.resolve(repoRoot, file);
    const from = normalizePath(absolute, repoRoot);
    nodes.add(from);
    const source = readFileSafe(absolute);
    if (!source) continue;
    const specifiers = extractSpecifiers(source);
    for (const specifier of specifiers) {
      const resolved = resolveImport(specifier, absolute, repoRoot);
      if (!resolved) continue;
      nodes.add(resolved);
      edges.push({ from, to: resolved, specifier });
      const list = adjacency.get(from) ?? new Set<string>();
      list.add(resolved);
      adjacency.set(from, list);
    }
  }

  return { edges, adjacency, nodes };
};

export const discoverTestEvidence = (
  graph: ImportGraph,
  options: DiscoveryOptions = {},
): TestEvidence => {
  const repoRoot = options.repoRoot ?? process.cwd();
  const testGlobs = options.testGlobs ?? DEFAULT_TEST_GLOBS;
  const ignoreGlobs = options.ignoreGlobs ?? DEFAULT_IGNORE_GLOBS;
  const manifestPath =
    options.testManifestPath ?? process.env.MATH_TEST_MANIFEST;
  const testFiles = manifestPath
    ? loadTestManifest(path.resolve(repoRoot, manifestPath), repoRoot)
    : fg.sync(testGlobs, { ignore: ignoreGlobs, dot: false }).map((file) =>
        path.resolve(repoRoot, file),
      );

  const byModule = new Map<string, Set<string>>();

  for (const testFile of testFiles) {
    const source = readFileSafe(testFile);
    if (!source) continue;
    const specifiers = extractSpecifiers(source);
    const roots = specifiers
      .map((specifier) => resolveImport(specifier, testFile, repoRoot))
      .filter((value): value is string => Boolean(value));
    if (roots.length === 0) continue;

    const visited = new Set<string>();
    const stack = [...roots];
    const testLabel = normalizePath(testFile, repoRoot);

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      const tests = byModule.get(current) ?? new Set<string>();
      tests.add(testLabel);
      byModule.set(current, tests);
      const deps = graph.adjacency.get(current);
      if (!deps) continue;
      deps.forEach((dep) => {
        if (!visited.has(dep)) stack.push(dep);
      });
    }
  }

  return {
    byModule,
    testFiles: testFiles.map((file) => normalizePath(file, repoRoot)),
  };
};

export const buildAutoEvidenceChecks = (
  registry: MathStageEntry[],
  options: DiscoveryOptions = {},
): AutoEvidence => {
  const graph = discoverImportGraph(options);
  const testEvidence = discoverTestEvidence(graph, options);
  const profiles = loadEvidenceProfiles(options.repoRoot ?? process.cwd());
  const autoChecksByModule = new Map<string, MathCheck[]>();

  for (const entry of registry) {
    const tests = testEvidence.byModule.get(entry.module);
    if (!tests || tests.size === 0) continue;
    const checks = Array.from(tests)
      .sort()
      .map((testPath) => {
        const profile = matchEvidenceProfileForTest(
          testPath,
          profiles,
          options.repoRoot ?? process.cwd(),
        );
        const note = profile ? `auto:${profile.name}` : "auto";
        const type = profile?.checkType ?? ("test" as const);
        return {
          type,
          path: testPath,
          note,
        };
      });
    autoChecksByModule.set(entry.module, checks);
  }

  return {
    autoChecksByModule,
    graph,
    testFiles: testEvidence.testFiles,
  };
};
