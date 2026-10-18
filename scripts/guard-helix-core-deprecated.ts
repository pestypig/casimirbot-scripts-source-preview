import { readFile } from "node:fs/promises";
import path from "node:path";

const TARGET_PATH = path.resolve("client", "src", "pages", "helix-core.tsx");

const ALLOWED_UI_MODULES = new Set([
  "@/components/ui/badge",
  "@/components/ui/button",
  "@/components/ui/card",
  "@/components/ui/dialog",
  "@/components/ui/input",
  "@/components/ui/label",
  "@/components/ui/scroll-area",
  "@/components/ui/select",
  "@/components/ui/separator",
  "@/components/ui/slider",
  "@/components/ui/switch",
  "@/components/ui/tabs",
  "@/components/ui/textarea",
  "@/components/ui/tooltip",
]);

const readImports = (source: string) => {
  const matches = source.matchAll(/from\s+["']([^"']+)["']/g);
  const imports = new Set<string>();
  for (const match of matches) {
    const mod = match[1];
    if (mod) imports.add(mod);
  }
  return imports;
};

async function main() {
  const source = await readFile(TARGET_PATH, "utf8");
  const imports = readImports(source);

  const uiModules = [...imports]
    .filter((mod) => mod.startsWith("@/components/ui/"))
    .sort((a, b) => a.localeCompare(b));
  const unexpectedUi = uiModules.filter((mod) => !ALLOWED_UI_MODULES.has(mod));

  if (unexpectedUi.length > 0) {
    console.error(
      [
        "[guard:helix-core-deprecated] blocked unexpected UI imports in deprecated page:",
        ...unexpectedUi.map((mod) => `  - ${mod}`),
        "Move new UI work into panel components and register via client/src/pages/helix-core.panels.ts.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const panelImports = [...imports]
    .filter((mod) => mod.startsWith("@/components/panels/"))
    .sort((a, b) => a.localeCompare(b));
  if (panelImports.length > 0) {
    console.error(
      [
        "[guard:helix-core-deprecated] blocked panel imports in deprecated page:",
        ...panelImports.map((mod) => `  - ${mod}`),
        "Use desktop/mobile panel registry surfaces instead of mounting panel components in helix-core.tsx.",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(
    `[guard:helix-core-deprecated] OK (${uiModules.length} allowed ui modules in ${path.relative(process.cwd(), TARGET_PATH)}).`,
  );
}

main().catch((error) => {
  console.error("[guard:helix-core-deprecated] failed:", error);
  process.exit(1);
});
