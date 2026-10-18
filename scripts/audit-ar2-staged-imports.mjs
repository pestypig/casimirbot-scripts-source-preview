/** Report unresolved local imports in the disposable AR-2 Git index. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env,
  GIT_INDEX_FILE: path.join(root, "artifacts/ar2-source-selection/index") };
const git = (args, encoding = "utf8") => execFileSync("git", args,
  { cwd: root, env, encoding, maxBuffer: 32 * 1024 * 1024 });
const staged = git(["diff", "--cached", "--name-only"]).trim().split(/\r?\n/)
  .filter(file => /\.[cm]?[jt]sx?$/.test(file));
const indexed = new Map();
for (const entry of git(["ls-files", "--stage", "-z"]).split("\0")) {
  if (!entry) continue;
  const match = /^\d+ ([a-f0-9]{40}) 0\t(.+)$/.exec(entry);
  if (!match) throw Error(`Unexpected index entry: ${entry}`);
  indexed.set(match[2].toLowerCase(), match[1]);
}
const relative = file => path.relative(root, path.resolve(file)).replaceAll("\\", "/").toLowerCase();
const fileExists = file => {
  const rel = relative(file);
  return rel.split("/").includes("node_modules") ? ts.sys.fileExists(file) : indexed.has(rel);
};
const readFile = file => {
  const rel = relative(file);
  return rel.split("/").includes("node_modules") ? ts.sys.readFile(file) :
    indexed.has(rel) ? git(["cat-file", "blob", indexed.get(rel)]) : undefined;
};
const moduleHost = { fileExists, readFile, directoryExists: ts.sys.directoryExists,
  getCurrentDirectory: () => root, getDirectories: ts.sys.getDirectories,
  realpath: ts.sys.realpath };
const rootConfigPath = path.join(root, "tsconfig.json");
const rootConfig = ts.readConfigFile(rootConfigPath, readFile);
if (rootConfig.error) throw Error(ts.flattenDiagnosticMessageText(rootConfig.error.messageText, "\n"));
const rootOptions = ts.parseJsonConfigFileContent(rootConfig.config, ts.sys, root,
  undefined, rootConfigPath).options;
const desktopOptions = { ...rootOptions, types: ["node", "electron"] };
const missing = [];
for (const file of staged) {
  const source = readFile(path.join(root, file));
  if (source === undefined) throw Error(`Missing staged source: ${file}`);
  for (const item of ts.preProcessFile(source, true, true).importedFiles) {
    const specifier = item.fileName;
    if (!specifier.startsWith(".") && !specifier.startsWith("@/") &&
      !specifier.startsWith("@shared/")) continue;
    if (specifier.endsWith(".css")) {
      const cssPath = path.resolve(path.dirname(path.join(root, file)), specifier);
      if (!indexed.has(relative(cssPath))) missing.push({ file, specifier });
      continue;
    }
    const options = file.startsWith("apps/desktop/") ? desktopOptions : rootOptions;
    const result = ts.resolveModuleName(specifier, path.join(root, file),
      options, moduleHost);
    if (!result.resolvedModule) missing.push({ file, specifier });
  }
}
process.stdout.write(JSON.stringify({ staged_source_files: staged.length,
  unresolved_local_imports: missing.length, missing }, null, 2) + "\n");
if (missing.length) process.exitCode = 1;
