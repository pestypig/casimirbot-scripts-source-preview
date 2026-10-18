import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export type LucideIconExportMap = ReadonlyMap<string, string>;

const LUCIDE_IMPORT_RE =
  /(^|\n)([\t ]*)import\s*\{([^};]*?)\}\s*from\s*(["'])lucide-react\4\s*;?/g;
const IMPORT_COMMENT_RE = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g;

export const loadLucideIconExportMap = (
  repoRoot: string,
): LucideIconExportMap => {
  const indexPath = path.join(
    repoRoot,
    "node_modules",
    "lucide-react",
    "dist",
    "esm",
    "lucide-react.js",
  );
  const source = fs.readFileSync(indexPath, "utf8");
  const exports = new Map<string, string>();
  const exportPattern =
    /export\s*\{([^}]+)\}\s*from\s*["']\.\/icons\/([^"']+\.js)["'];?/g;
  for (const match of source.matchAll(exportPattern)) {
    for (const specifier of match[1].split(",")) {
      const alias = specifier
        .trim()
        .match(/^default\s+as\s+([A-Za-z_$][\w$]*)$/)?.[1];
      if (alias) exports.set(alias, match[2]);
    }
  }
  if (exports.size < 1_000) {
    throw new Error(
      `Lucide icon export map is unexpectedly small (${exports.size})`,
    );
  }
  return exports;
};

type ParsedSpecifier = {
  imported: string;
  local: string;
  source: string;
  typeOnly: boolean;
};

const parseSpecifier = (value: string): ParsedSpecifier | null => {
  const source = value.trim();
  if (!source) return null;
  const typeOnly = source.startsWith("type ");
  const withoutType = typeOnly ? source.slice(5).trim() : source;
  const match = withoutType.match(
    /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/,
  );
  if (!match) return null;
  return {
    imported: match[1],
    local: match[2] ?? match[1],
    source,
    typeOnly,
  };
};

export const rewriteLucideNamedImports = (
  code: string,
  iconExports: LucideIconExportMap,
): { code: string; rewrittenIcons: number; rewrittenImports: number } => {
  let rewrittenIcons = 0;
  let rewrittenImports = 0;
  const rewritten = code.replace(
    LUCIDE_IMPORT_RE,
    (full, lineStart: string, indentation: string, body: string) => {
      const comments = [...body.matchAll(IMPORT_COMMENT_RE)].map(
        (match) => match[0],
      );
      const parsed = body
        .replace(IMPORT_COMMENT_RE, "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map(parseSpecifier);
      if (
        parsed.length === 0 ||
        parsed.some((entry) => entry === null)
      ) {
        return full;
      }
      const direct: ParsedSpecifier[] = [];
      const retained: ParsedSpecifier[] = [];
      for (const entry of parsed as ParsedSpecifier[]) {
        if (!entry.typeOnly && iconExports.has(entry.imported)) {
          direct.push(entry);
        } else {
          retained.push(entry);
        }
      }
      if (direct.length === 0) return full;

      rewrittenImports += 1;
      rewrittenIcons += direct.length;
      const lines = comments.map((comment) => comment.trim());
      lines.push(...direct.map((entry) => {
        const moduleFile = iconExports.get(entry.imported);
        return `${indentation}import ${entry.local} from "lucide-react/dist/esm/icons/${moduleFile}";`;
      }));
      if (retained.length > 0) {
        lines.push(
          `${indentation}import { ${retained.map((entry) => entry.source).join(", ")} } from "lucide-react";`,
        );
      }
      return `${lineStart}${lines.join("\n")}`;
    },
  );
  return { code: rewritten, rewrittenIcons, rewrittenImports };
};

export const lucideDirectImports = (repoRoot: string): Plugin => {
  const iconExports = loadLucideIconExportMap(repoRoot);
  let productionBuild = false;
  let rewrittenIcons = 0;
  let rewrittenModules = 0;
  return {
    name: "casimir-lucide-direct-imports",
    enforce: "pre",
    configResolved(config) {
      productionBuild = config.command === "build";
    },
    transform(code, id) {
      if (
        !productionBuild ||
        id.includes("/node_modules/") ||
        !/\.[cm]?[jt]sx?(?:\?|$)/.test(id) ||
        !code.includes("lucide-react")
      ) {
        return null;
      }
      const result = rewriteLucideNamedImports(code, iconExports);
      if (result.rewrittenIcons === 0) return null;
      rewrittenIcons += result.rewrittenIcons;
      rewrittenModules += 1;
      return { code: result.code, map: null };
    },
    buildEnd() {
      if (productionBuild) {
        console.log(
          `[vite:lucide-direct] modules=${rewrittenModules} icons=${rewrittenIcons}`,
        );
      }
    },
  };
};
