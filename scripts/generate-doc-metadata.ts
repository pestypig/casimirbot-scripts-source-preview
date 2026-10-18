import { promises as fs } from "node:fs";
import path from "node:path";

type DocFileMetadata = {
  mtimeMs: number;
  mtimeIso: string;
  sizeBytes: number;
};

const repoRoot = process.cwd();
const docsRoot = path.join(repoRoot, "docs");
const outPath = path.join(repoRoot, "client", "src", "lib", "docs", "docMetadata.generated.ts");

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

function toDocManifestPath(filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

function renderMetadata(entries: Record<string, DocFileMetadata>): string {
  return [
    "export type DocFileMetadata = {",
    "  mtimeMs: number;",
    "  mtimeIso: string;",
    "  sizeBytes: number;",
    "};",
    "",
    "export const DOC_FILE_METADATA: Record<string, DocFileMetadata> = {",
    ...Object.entries(entries).map(([key, value]) =>
      `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`
    ),
    "};",
    "",
  ].join("\n");
}

async function main() {
  const files = await collectMarkdownFiles(docsRoot);
  const metadata: Record<string, DocFileMetadata> = {};
  for (const file of files.sort((a, b) => a.localeCompare(b))) {
    const stat = await fs.stat(file);
    metadata[toDocManifestPath(file)] = {
      mtimeMs: Math.round(stat.mtimeMs),
      mtimeIso: stat.mtime.toISOString(),
      sizeBytes: stat.size,
    };
  }
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, renderMetadata(metadata), "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
