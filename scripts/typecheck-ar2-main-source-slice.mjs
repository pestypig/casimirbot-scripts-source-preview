/** Read-only typecheck of the selected AR-2 main entry point at its canonical
 * path. The compiler host substitutes the reviewed bytes in memory. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, "apps/desktop/tsconfig.json");
const mainPath = path.join(root, "apps/desktop/src/main.ts");
const selectedPath = path.join(root, "artifacts/ar2-source-selection/main.ts");
const selected = readFileSync(selectedPath, "utf8");
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) throw Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys,
  path.dirname(configPath), undefined, configPath);
if (parsed.errors.length) throw Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
  getCanonicalFileName: name => name, getCurrentDirectory: () => root,
  getNewLine: () => "\n",
}));
const host = ts.createCompilerHost(parsed.options);
const readFile = host.readFile.bind(host);
host.readFile = fileName => path.resolve(fileName).toLowerCase() === mainPath.toLowerCase()
  ? selected : readFile(fileName);
const program = ts.createProgram({ rootNames: parsed.fileNames,
  options: parsed.options, host });
const errors = ts.getPreEmitDiagnostics(program);
if (errors.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  }));
  process.exitCode = 1;
} else {
  process.stdout.write("AR2 selected main typecheck PASS (in-memory compiler overlay)\n");
}
