import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import ts from "typescript";
import fg from "fast-glob";

type PanelRef = {
  id: string;
  title: string;
  keywords: string[];
  endpoints: string[];
  importPath?: string;
  componentPath?: string | null;
};

type TreeMatch = {
  treeId: string;
  nodeId: string;
  title?: string;
  tags?: string[];
};

type TermHit = {
  term: string;
  files: string[];
  treeMatches: TreeMatch[];
};

const PANEL_FILE = path.join("client", "src", "pages", "helix-core.panels.ts");
const OUTPUT_JSON = path.join("reports", "panel-cross-concepts.json");
const OUTPUT_MD = path.join("reports", "panel-dag-gaps.md");
const IDEOLOGY_SOURCE = path.join("docs", "ethos", "ideology.json");
const IDEOLOGY_TREE_OUTPUT = path.join("docs", "knowledge", "mission-ethos-tree.json");
const MAX_TERM_PER_PANEL = 12;
const MAX_HITS_PER_TERM = 8;
const MAX_FILE_BYTES = 500_000;
const DERIVED_PANEL_INDEX_PATHS = new Set([
  "docs/knowledge/panel-registry-tree.json",
  "docs/knowledge/panel-concepts-tree.json",
  "docs/work-packets/nhm2-theory-graph-science-panel-consolidation-v1.md",
]);

const isDerivedPanelIndex = (filePath: string) => {
  const normalized = filePath.replace(/\\/g, "/");
  return DERIVED_PANEL_INDEX_PATHS.has(normalized) ||
    (normalized.startsWith("docs/knowledge/trees/") && normalized.endsWith(".md"));
};

const SEARCH_GLOBS = [
  "docs/knowledge/**/*.{md,json}",
  "docs/ethos/**/*.{md,json}",
  "docs/**/*.md",
  "client/src/**/*.{ts,tsx,md}",
  "server/**/*.{ts,tsx,md,json}",
  "modules/**/*.{ts,tsx,md,json}",
  "shared/**/*.{ts,tsx,md,json}"
];

const UNIT_REGEX = /\b(GPa|MPa|kPa|Pa|Myr|Gyr|yr|m\/s|mps|kg\/s|Hz|K|AU|W\/m2|W\/m\^2|J|eV|km\/s|ms|s|m)\b/gi;
const TELEMETRY_LINE = /(telemetry|metrics|snapshot|kpi|kpis|series|chart|signal|delta|rate|duty|cadence|guardrail|preset)/i;

const readText = (filePath: string): string => {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
};

const getStringLiteral = (node: ts.Expression): string | null => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
};

const getStringArray = (node: ts.Expression): string[] => {
  if (!ts.isArrayLiteralExpression(node)) return [];
  return node.elements
    .map((element) => (ts.isExpression(element) ? getStringLiteral(element) : null))
    .filter((value): value is string => Boolean(value));
};

const parsePanelKeywords = (sourceFile: ts.SourceFile): Record<string, string[]> => {
  const map: Record<string, string[]> = {};
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "PANEL_KEYWORDS" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const prop of node.initializer.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = ts.isStringLiteral(prop.name)
          ? prop.name.text
          : ts.isIdentifier(prop.name)
          ? prop.name.text
          : null;
        if (!key || !prop.initializer) continue;
        map[key] = getStringArray(prop.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return map;
};

const getImportPathFromLoader = (node: ts.Expression): string | undefined => {
  if (!ts.isCallExpression(node)) return undefined;
  const arg = node.arguments[0];
  if (!arg) return undefined;
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
    const body = arg.body;
    if (ts.isCallExpression(body) && body.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const importArg = body.arguments[0];
      if (importArg) {
        const value = getStringLiteral(importArg);
        if (value) return value;
      }
    }
    if (ts.isBlock(body)) {
      for (const statement of body.statements) {
        if (ts.isReturnStatement(statement) && statement.expression) {
          const expr = statement.expression;
          if (ts.isCallExpression(expr) && expr.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const importArg = expr.arguments[0];
            const value = importArg ? getStringLiteral(importArg) : null;
            if (value) return value;
          }
        }
      }
    }
  }
  return undefined;
};

const parsePanels = (sourceFile: ts.SourceFile, keywordMap: Record<string, string[]>): PanelRef[] => {
  const panels: PanelRef[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "RAW_HELIX_PANELS" &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(element)) continue;
        let id = "";
        let title = "";
        let keywords: string[] = [];
        const endpoints: string[] = [];
        let importPath: string | undefined;
        for (const prop of element.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const key = ts.isIdentifier(prop.name)
            ? prop.name.text
            : ts.isStringLiteral(prop.name)
            ? prop.name.text
            : "";
          if (!key) continue;
          const initializer = prop.initializer;
          if (key === "id") {
            const value = getStringLiteral(initializer);
            if (value) id = value;
          } else if (key === "title") {
            const value = getStringLiteral(initializer);
            if (value) title = value;
          } else if (key === "keywords") {
            if (ts.isArrayLiteralExpression(initializer)) {
              keywords = getStringArray(initializer);
            } else if (ts.isElementAccessExpression(initializer)) {
              const obj = initializer.expression;
              const arg = initializer.argumentExpression;
              if (
                ts.isIdentifier(obj) &&
                obj.text === "PANEL_KEYWORDS" &&
                arg &&
                ts.isExpression(arg)
              ) {
                const keyValue = getStringLiteral(arg);
                if (keyValue && keywordMap[keyValue]) {
                  keywords = keywordMap[keyValue];
                }
              }
            } else if (ts.isPropertyAccessExpression(initializer)) {
              const obj = initializer.expression;
              if (ts.isIdentifier(obj) && obj.text === "PANEL_KEYWORDS") {
                const keyValue = initializer.name.text;
                if (keyValue && keywordMap[keyValue]) {
                  keywords = keywordMap[keyValue];
                }
              }
            }
          } else if (key === "endpoints") {
            if (ts.isArrayLiteralExpression(initializer)) {
              for (const entry of initializer.elements) {
                if (ts.isPropertyAccessExpression(entry)) {
                  endpoints.push(entry.name.text);
                } else if (ts.isIdentifier(entry)) {
                  endpoints.push(entry.text);
                } else if (ts.isStringLiteral(entry)) {
                  endpoints.push(entry.text);
                }
              }
            }
          } else if (key === "loader") {
            importPath = getImportPathFromLoader(initializer);
          }
        }
        if (!id) continue;
        if (!keywords.length && keywordMap[id]) {
          keywords = keywordMap[id];
        }
        panels.push({ id, title, keywords, endpoints, importPath });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return panels;
};

const resolveImportPath = (importPath: string, baseDir: string): string => {
  if (importPath.startsWith("@/")) {
    return path.join("client", "src", importPath.slice(2));
  }
  if (importPath.startsWith("./") || importPath.startsWith("../")) {
    return path.resolve(baseDir, importPath);
  }
  return importPath;
};

const resolveComponentPath = (importPath?: string): string | null => {
  if (!importPath) return null;
  const baseDir = path.dirname(PANEL_FILE);
  const resolved = resolveImportPath(importPath, baseDir);
  const candidates = [
    resolved,
    `${resolved}.tsx`,
    `${resolved}.ts`,
    `${resolved}.jsx`,
    `${resolved}.js`,
    path.join(resolved, "index.tsx"),
    path.join(resolved, "index.ts")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

const extractTermsFromComponent = (content: string) => {
  const units = new Set<string>();
  const literals = new Set<string>();
  const telemetry = new Set<string>();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const unitMatches = line.match(UNIT_REGEX);
    if (unitMatches) {
      unitMatches.forEach((unit) => units.add(unit));
    }
    if (TELEMETRY_LINE.test(line)) {
      const tokens = line.match(/\b[a-zA-Z][a-zA-Z0-9_]{2,}\b/g);
      if (tokens) {
        tokens.forEach((token) => telemetry.add(token));
      }
    }
  }
  const literalMatches = content.match(/["'`]([^"'`]{3,80})["'`]/g) ?? [];
  for (const raw of literalMatches) {
    const trimmed = raw.slice(1, -1).trim();
    if (!/[A-Za-z]/.test(trimmed)) continue;
    if (trimmed.length > 60) continue;
    literals.add(trimmed);
  }
  return {
    units: Array.from(units),
    literals: Array.from(literals),
    telemetry: Array.from(telemetry)
  };
};

const rankTerms = (parts: { keywords: string[]; telemetry: string[]; units: string[]; literals: string[] }) => {
  const weights = new Map<string, number>();
  const add = (term: string, weight: number) => {
    const key = term.trim();
    if (!key) return;
    const current = weights.get(key) ?? 0;
    weights.set(key, Math.max(current, weight));
  };
  parts.keywords.forEach((term) => add(term, 4));
  parts.telemetry.forEach((term) => add(term, 3));
  parts.units.forEach((term) => add(term, 3));
  parts.literals.forEach((term) => add(term, 1));
  return Array.from(weights.entries())
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([term]) => term);
};

const buildFileIndex = () => {
  const files = fg.sync(SEARCH_GLOBS, { onlyFiles: true, unique: true });
  const index = new Map<string, string>();
  files.forEach((file) => {
    if (isDerivedPanelIndex(file)) return;
    const content = readText(file);
    if (!content) return;
    index.set(file, content.toLowerCase());
  });
  return index;
};

const buildTreeIndex = () => {
  const treeFiles = fg.sync(["docs/knowledge/**/*tree.json"], { onlyFiles: true, unique: true });
  const nodes: TreeMatch[] = [];
  for (const file of treeFiles) {
    if (isDerivedPanelIndex(file)) continue;
    const raw = readText(file);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as {
        rootId?: string;
        nodes?: Array<{
          id?: string;
          title?: string;
          tags?: string[];
          aliases?: string[];
          nodeType?: string;
        }>;
      };
      const treeId = parsed.rootId ?? path.basename(file, ".json");
      (parsed.nodes ?? []).forEach((node) => {
        if (!node.id) return;
        if (node.nodeType === "bridge" || node.id.startsWith("bridge-")) return;
        nodes.push({
          treeId,
          nodeId: node.id,
          title: node.title,
          tags: node.tags
        });
      });
    } catch {
      continue;
    }
  }
  return nodes;
};

const matchTreeNodes = (term: string, treeIndex: TreeMatch[]) => {
  const needle = term.toLowerCase();
  const matches = treeIndex.filter((node) => {
    if (node.title && node.title.toLowerCase().includes(needle)) return true;
    if (node.nodeId && node.nodeId.toLowerCase().includes(needle)) return true;
    if (node.tags && node.tags.some((tag) => tag.toLowerCase().includes(needle))) return true;
    return false;
  });
  return matches.slice(0, 6);
};

const findFilesForTerm = (term: string, fileIndex: Map<string, string>) => {
  const needle = term.toLowerCase();
  const hits: string[] = [];
  for (const [file, content] of fileIndex.entries()) {
    if (!content.includes(needle)) continue;
    hits.push(file);
    if (hits.length >= MAX_HITS_PER_TERM) break;
  }
  return hits;
};

const syncMissionEthosTree = () => {
  if (!fs.existsSync(IDEOLOGY_SOURCE)) return;
  fs.mkdirSync(path.dirname(IDEOLOGY_TREE_OUTPUT), { recursive: true });
  fs.copyFileSync(IDEOLOGY_SOURCE, IDEOLOGY_TREE_OUTPUT);
};

const run = () => {
  if (!process.argv.includes("--keep-ethos-tree")) syncMissionEthosTree();
  const sourceText = fs.readFileSync(PANEL_FILE, "utf8");
  const sourceFile = ts.createSourceFile(PANEL_FILE, sourceText, ts.ScriptTarget.Latest, true);
  const keywordMap = parsePanelKeywords(sourceFile);
  const panels = parsePanels(sourceFile, keywordMap);
  const fileIndex = buildFileIndex();
  const treeIndex = buildTreeIndex();
  const panelReports = panels.map((panel) => {
    const componentPath = resolveComponentPath(panel.importPath);
    let terms = [...panel.keywords];
    let units: string[] = [];
    let telemetry: string[] = [];
    let literals: string[] = [];
    if (componentPath) {
      const content = readText(componentPath);
      if (content) {
        const extracted = extractTermsFromComponent(content);
        units = extracted.units;
        telemetry = extracted.telemetry;
        literals = extracted.literals;
        terms = rankTerms({
          keywords: panel.keywords,
          telemetry,
          units,
          literals
        });
      }
    }
    const trimmedTerms = terms.slice(0, MAX_TERM_PER_PANEL);
    const termHits: TermHit[] = trimmedTerms.map((term) => ({
      term,
      files: findFilesForTerm(term, fileIndex),
      treeMatches: matchTreeNodes(term, treeIndex)
    }));
    const missingTerms = termHits
      .filter((hit) => hit.files.length === 0 && hit.treeMatches.length === 0)
      .map((hit) => hit.term);
    const treeIds = new Set<string>();
    termHits.forEach((hit) => hit.treeMatches.forEach((match) => treeIds.add(match.treeId)));
    const crossConceptTrees = Array.from(treeIds);
    return {
      ...panel,
      componentPath,
      units,
      telemetryTokens: telemetry,
      literals,
      terms: trimmedTerms,
      termHits,
      missingTerms,
      treeIds: crossConceptTrees
    };
  });

  let repoRev = "unknown";
  try {
    repoRev = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    repoRev = "unknown";
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    repoRev,
    panelCount: panelReports.length,
    termLimit: MAX_TERM_PER_PANEL,
    fileLimit: MAX_HITS_PER_TERM,
    panels: panelReports
  };
  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(payload, null, 2));

  const lines: string[] = [
    "# Panel Cross-Concept DAG Gaps",
    "",
    `Generated: ${payload.generatedAt}`,
    `Panels: ${payload.panelCount}`,
    ""
  ];
  for (const panel of panelReports) {
    lines.push(`## ${panel.title || panel.id}`);
    lines.push(`id: ${panel.id}`);
    if (panel.componentPath) {
      lines.push(`component: ${panel.componentPath}`);
    } else {
      lines.push("component: (not resolved)");
    }
    if (panel.keywords.length) {
      lines.push(`keywords: ${panel.keywords.join(", ")}`);
    }
    if (panel.treeIds.length) {
      lines.push(`tree_matches: ${panel.treeIds.join(", ")}`);
    }
    if (panel.missingTerms.length) {
      lines.push(`missing_terms: ${panel.missingTerms.join(", ")}`);
    } else {
      lines.push("missing_terms: none");
    }
    lines.push("");
  }
  fs.writeFileSync(OUTPUT_MD, lines.join("\n"));
};

run();
