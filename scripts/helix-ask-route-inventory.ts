import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

type RouteDeclaration = {
  method: string;
  path: string;
  line: number;
};

type RuntimeImport = {
  module: string;
  symbols: string[];
};

type HelperBlock = {
  name: string;
  line: number;
};

type TrackedStatus = {
  path: string;
  status: string;
};

type Inventory = {
  generatedAt: string;
  cwd: string;
  gitBranch: string | null;
  gitHead: string | null;
  routeFile: string;
  fileSizeBytes: number;
  fileSizeMiB: number;
  lineCount: number | null;
  textReadable: boolean;
  nullByteCount: number;
  routeDeclarations: RouteDeclaration[];
  runtimeImports: RuntimeImport[];
  helperBlocks: HelperBlock[];
  trackedStatus: TrackedStatus[];
  diffStat: string[];
};

const ROUTE_FILE = path.join("server", "routes", "agi.plan.ts");
const DEFAULT_OUT = path.join("artifacts", "helix-ask-route-inventory.json");
const TRACKED_PATHS = [
  path.join("server", "routes", "agi.plan.ts"),
  path.join("server", "services", "helix-ask", "runtime", "request-context.ts"),
  path.join("server", "services", "helix-ask", "runtime", "conversation-turn-handler.ts"),
  path.join("server", "services", "helix-ask", "runtime", "ask-handler.ts"),
  path.join("docs", "helix-ask-route-extraction-ledger.md"),
];

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const outArgIndex = process.argv.indexOf("--out");
const outPath =
  outArgIndex >= 0 && process.argv[outArgIndex + 1]
    ? process.argv[outArgIndex + 1]
    : DEFAULT_OUT;

const runGit = (gitArgs: string[], preserveLeadingWhitespace = false): string => {
  const result = spawnSync("git", gitArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return "";
  }
  return preserveLeadingWhitespace ? result.stdout.trimEnd() : result.stdout.trim();
};

const countLineNumber = (text: string, offset: number): number =>
  text.slice(0, offset).split(/\r?\n/).length;

const parseRouteDeclarations = (text: string): RouteDeclaration[] => {
  const declarations: RouteDeclaration[] = [];
  const regex = /planRouter\.(get|post|put|patch|delete)\("([^"]+)"/g;
  for (const match of text.matchAll(regex)) {
    const offset = match.index ?? 0;
    declarations.push({
      method: match[1],
      path: match[2],
      line: countLineNumber(text, offset),
    });
  }
  return declarations;
};

const parseRuntimeImports = (text: string): RuntimeImport[] => {
  const imports: RuntimeImport[] = [];
  const lines = text.split(/\r?\n/);
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const block = current.join("\n");
    const moduleMatch = block.match(/from\s+"([^"]*services\/helix-ask\/runtime\/[^"]+)";/);
    if (moduleMatch) {
      const symbolsMatch = block.match(/import\s*{([\s\S]*?)}\s*from/);
      const symbols = (symbolsMatch?.[1] ?? "")
        .split(",")
        .map((entry) => entry.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      imports.push({
        module: moduleMatch[1],
        symbols,
      });
    }
    current = [];
  };
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("import ")) {
      flush();
      current.push(line);
      if (trimmed.endsWith(";")) {
        flush();
      }
      continue;
    }
    if (current.length > 0) {
      current.push(line);
      if (line.trimEnd().endsWith(";")) {
        flush();
      }
    }
  }
  flush();
  return imports;
};

const parseTrackedStatus = (statusOutput: string): TrackedStatus[] =>
  statusOutput
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(.{2})\s+(.*)$/);
      const status = match?.[1]?.trim() || "??";
      const filePath = match?.[2]?.trim() || line.trim();
      return {
        path: filePath,
        status,
      };
    });

const parseHelperBlocks = (text: string): HelperBlock[] => {
  const helpers: HelperBlock[] = [];
  const lines = text.split(/\r?\n/);
  const pattern =
    /^(const|let)\s+([A-Za-z0-9_]+)\s*=|^async function\s+([A-Za-z0-9_]+)|^function\s+([A-Za-z0-9_]+)/;
  const includeName = (name: string): boolean =>
    /HelixAsk|HelixConversation|executeHelixAsk|buildHelixAsk|resolveHelixAsk|appendHelixAsk|normalizeHelixAsk|renderHelixAsk|runHelixAsk/.test(
      name,
    );
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(pattern);
    if (!match) continue;
    const name = match[2] ?? match[3] ?? match[4] ?? "";
    if (!includeName(name)) continue;
    helpers.push({
      name,
      line: index + 1,
    });
  }
  return helpers;
};

const routePath = path.resolve(process.cwd(), ROUTE_FILE);
const bytes = fs.readFileSync(routePath);
const nullByteCount = bytes.reduce((count, value) => count + (value === 0 ? 1 : 0), 0);
const textReadable = nullByteCount === 0;
const text = textReadable ? bytes.toString("utf8") : "";
const gitBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]) || null;
const gitHead = runGit(["rev-parse", "--short", "HEAD"]) || null;
const statusOutput = runGit(["status", "--short", "--", ...TRACKED_PATHS], true);
const diffStatOutput = runGit(["diff", "--stat", "--", ...TRACKED_PATHS]);

const inventory: Inventory = {
  generatedAt: new Date().toISOString(),
  cwd: process.cwd(),
  gitBranch,
  gitHead,
  routeFile: ROUTE_FILE,
  fileSizeBytes: bytes.length,
  fileSizeMiB: Number((bytes.length / (1024 * 1024)).toFixed(3)),
  lineCount: textReadable ? text.split(/\r?\n/).length : null,
  textReadable,
  nullByteCount,
  routeDeclarations: textReadable ? parseRouteDeclarations(text) : [],
  runtimeImports: textReadable ? parseRuntimeImports(text) : [],
  helperBlocks: textReadable ? parseHelperBlocks(text) : [],
  trackedStatus: parseTrackedStatus(statusOutput),
  diffStat: diffStatOutput ? diffStatOutput.split(/\r?\n/).filter(Boolean) : [],
};

if (shouldWrite || outArgIndex >= 0) {
  const resolvedOut = path.resolve(process.cwd(), outPath);
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.writeFileSync(resolvedOut, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
}

const summary = {
  routeFile: inventory.routeFile,
  textReadable: inventory.textReadable,
  nullByteCount: inventory.nullByteCount,
  fileSizeMiB: inventory.fileSizeMiB,
  lineCount: inventory.lineCount,
  routeCount: inventory.routeDeclarations.length,
  runtimeImportCount: inventory.runtimeImports.length,
  helperBlockCount: inventory.helperBlocks.length,
  runtimeImports: inventory.runtimeImports,
  helperBlockSample: inventory.helperBlocks.slice(0, 12),
  trackedStatus: inventory.trackedStatus,
  outPath: shouldWrite || outArgIndex >= 0 ? outPath : null,
};

if (shouldWrite || outArgIndex >= 0) {
  console.log(JSON.stringify({ summary }, null, 2));
} else {
  console.log(JSON.stringify({ summary, inventory }, null, 2));
}
