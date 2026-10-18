import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDocEquationActionManifestFromMarkdown,
  stableStringifyDocEquationActionManifest,
} from "./doc-equation-action-generator";

const DEFAULT_DOC_PATH = "docs/research/nhm2-current-status-whitepaper.md";

type CliOptions = {
  docPath: string;
  sourcePath: string;
  outPath: string;
  check: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  let docPath = DEFAULT_DOC_PATH;
  let sourcePath = "";
  let outPath = "";
  let check = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--doc") {
      docPath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--source") {
      sourcePath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--out") {
      outPath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!docPath.trim()) throw new Error("--doc must be a non-empty path");
  sourcePath = sourcePath.trim() || docPath.replace(/\.md$/i, ".equation-actions.source.json");
  outPath = outPath.trim() || docPath.replace(/\.md$/i, ".equation-actions.json");
  return { docPath, sourcePath, outPath, check };
}

function readJson(pathname: string): unknown {
  return JSON.parse(readFileSync(pathname, "utf8")) as unknown;
}

function run(): void {
  const options = parseArgs(process.argv.slice(2));
  const docPath = path.resolve(options.docPath);
  const sourcePath = path.resolve(options.sourcePath);
  const outPath = path.resolve(options.outPath);
  const markdown = readFileSync(docPath, "utf8");
  const source = readJson(sourcePath);
  const manifest = buildDocEquationActionManifestFromMarkdown({ markdown, source });
  const generated = stableStringifyDocEquationActionManifest(manifest);

  if (options.check) {
    const current = readFileSync(outPath, "utf8").replace(/\r\n/g, "\n");
    if (current !== generated) {
      throw new Error(`Doc equation action sidecar is stale: ${path.relative(process.cwd(), outPath)}`);
    }
    console.log(`Doc equation action sidecar is current: ${path.relative(process.cwd(), outPath)}`);
    return;
  }

  writeFileSync(outPath, generated, "utf8");
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  run();
}
