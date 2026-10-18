/** Typecheck AR-2 server or client roots from a disposable Git index. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scope = process.argv[2];
if (scope !== "server" && scope !== "client") throw Error("Expected server or client scope");
const selectedRoot = process.argv[3] ?? null;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env,
  GIT_INDEX_FILE: path.join(root, "artifacts/ar2-source-selection/index") };
const git = (args, encoding = "utf8") => execFileSync("git", args,
  { cwd: root, env, encoding, maxBuffer: 32 * 1024 * 1024 });
const indexed = new Map();
for (const entry of git(["ls-files", "--stage", "-z"]).split("\0")) {
  if (!entry) continue;
  const match = /^\d+ ([a-f0-9]{40}) 0\t(.+)$/.exec(entry);
  if (!match) throw Error("Unexpected index entry: " + entry);
  indexed.set(match[2].toLowerCase(), match[1]);
}
const cache = new Map();
const relative = file => path.relative(root, path.resolve(file))
  .replaceAll("\\", "/").toLowerCase();
const external = name => name.startsWith("../") ||
  name.split("/").includes("node_modules");
const fileExists = file => {
  const name = relative(file);
  return external(name) ? ts.sys.fileExists(file) : indexed.has(name);
};
const readFile = file => {
  const name = relative(file);
  if (external(name)) return ts.sys.readFile(file);
  const blob = indexed.get(name);
  if (!blob) return undefined;
  if (!cache.has(blob)) cache.set(blob, git(["cat-file", "blob", blob]));
  return cache.get(blob);
};
const configPath = path.join(root, "tsconfig.json");
const config = ts.readConfigFile(configPath, readFile);
if (config.error) throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root,
  undefined, configPath);
if (parsed.errors.length) throw Error("Invalid root tsconfig");
const roots = git(["diff", "--cached", "--name-only"]).trim().split(/\r?\n/)
  .filter(file => file.startsWith(scope + "/") && /\.[jt]sx?$/.test(file) &&
    (!selectedRoot || file === selectedRoot))
  .map(file => path.join(root, ...file.split("/")));
if (!roots.length) throw Error("No indexed roots selected");
const options = { ...parsed.options, incremental: false };
const host = ts.createCompilerHost(options);
host.fileExists = fileExists;
host.readFile = readFile;
const program = ts.createProgram({ rootNames: roots, options, host });
const diagnostics = ts.getPreEmitDiagnostics(program);
const changed = new Set(git(["diff", "--cached", "--name-only"])
  .trim().split(/\r?\n/).map(file => file.toLowerCase()));
const selected = diagnostics.filter(item => item.file &&
  changed.has(relative(item.file.fileName)));
const format = item => ({
  file: item.file ? relative(item.file.fileName) : null,
  line: item.file && item.start !== undefined ?
    item.file.getLineAndCharacterOfPosition(item.start).line + 1 : null,
  code: item.code,
  message: ts.flattenDiagnosticMessageText(item.messageText, " "),
});
const summary = { scope, roots: roots.length, diagnostics: diagnostics.length,
  selected_diagnostics: selected.length,
  selected_first: selected.slice(0, 80).map(format),
  other_first: diagnostics.filter(item => !item.file ||
    !changed.has(relative(item.file.fileName))).slice(0, 8).map(format) };
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
if (diagnostics.length) process.exitCode = 1;
