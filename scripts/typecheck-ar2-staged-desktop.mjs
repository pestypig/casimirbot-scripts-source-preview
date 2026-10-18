/** Typecheck the disposable AR-2 Git index, never the mixed working tree.
 * Files inside the repository come from Git blobs; node_modules remain local. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = path.join(root, "artifacts/ar2-source-selection/index");
const gitEnv = { ...process.env, GIT_INDEX_FILE: indexPath };
const entries = execFileSync("git", ["ls-files", "--stage", "-z"], {
  cwd: root, env: gitEnv, encoding: "buffer", maxBuffer: 32 * 1024 * 1024,
});
const blobs = new Map();
for (const entry of entries.toString("utf8").split("\0")) {
  if (!entry) continue;
  const match = /^\d+ ([a-f0-9]{40}) 0\t(.+)$/.exec(entry);
  if (!match) throw Error(`Unexpected Git index entry: ${entry}`);
  blobs.set(match[2].toLowerCase(), match[1]);
}
const contents = new Map();
const normalize = fileName => {
  const relative = path.relative(root, path.resolve(fileName)).replaceAll("\\", "/");
  return relative.startsWith("../") || relative === ".." ? null : relative.toLowerCase();
};
const blobText = relative => {
  const object = blobs.get(relative);
  if (!object) return undefined;
  if (!contents.has(object)) contents.set(object, execFileSync("git", ["cat-file", "blob", object], {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }));
  return contents.get(object);
};
const isDependency = relative => relative === null ||
  relative.split("/").includes("node_modules");
const configPath = path.join(root, "apps/desktop/tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys,
  path.dirname(configPath), undefined, configPath);
if (parsed.errors.length) throw Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
  getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => "\n",
}));
const host = ts.createCompilerHost(parsed.options);
const systemRead = host.readFile.bind(host);
const systemExists = host.fileExists.bind(host);
host.readFile = fileName => {
  const relative = normalize(fileName);
  return isDependency(relative)
    ? systemRead(fileName) : blobText(relative);
};
host.fileExists = fileName => {
  const relative = normalize(fileName);
  return isDependency(relative)
    ? systemExists(fileName) : blobs.has(relative);
};
const roots = [...blobs.keys()].filter(file => /^apps\/desktop\/src\/.*\.ts$/.test(file))
  .map(file => path.join(root, ...file.split("/")));
const program = ts.createProgram({ rootNames: roots, options: parsed.options, host });
const errors = ts.getPreEmitDiagnostics(program);
if (errors.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => "\n",
  }));
  process.exitCode = 1;
} else {
  process.stdout.write(`AR2 staged desktop typecheck PASS (${roots.length} indexed roots)\n`);
}
