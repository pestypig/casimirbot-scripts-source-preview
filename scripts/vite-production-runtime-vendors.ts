import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

const VIRTUAL_PLOTLY_ID = "\0casimir:vendored-plotly";
const PLOTLY_SOURCE = "node_modules/plotly.js/dist/plotly.min.js";
const THREE_STDLIB_ORBIT_CONTROLS =
  "node_modules/three-stdlib/controls/OrbitControls.js";

const DREI_EXPORTS = new Map<string, string>([
  ["OrbitControls", "core/OrbitControls.js"],
  ["Stars", "core/Stars.js"],
]);

const DREI_IMPORT_RE =
  /(^|\n)([\t ]*)import\s*\{([^};]*?)\}\s*from\s*(["'])@react-three\/drei\4\s*;?/g;
const MERMAID_IMPORT_RE =
  /\bimport\s*\(\s*(["'])mermaid\1\s*\)/g;

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

const withTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value : `${value}/`;

export const plotlySubresourceIntegrity = (repoRoot: string): string => {
  const source = fs.readFileSync(path.join(repoRoot, PLOTLY_SOURCE));
  return `sha384-${createHash("sha384").update(source).digest("base64")}`;
};

export const isProductionRuntimeExternal = (id: string): boolean =>
  /(?:^|\/)vendor\/mermaid\/mermaid\.esm\.min\.mjs$/.test(
    id.replaceAll("\\", "/"),
  );

export const resolveDreiDependencyImport = (
  source: string,
  importer: string | undefined,
  repoRoot: string,
): string | null => {
  if (
    source !== "three-stdlib" ||
    !importer?.replaceAll("\\", "/").endsWith(
      "/@react-three/drei/core/OrbitControls.js",
    )
  ) {
    return null;
  }
  return path.resolve(repoRoot, THREE_STDLIB_ORBIT_CONTROLS).replaceAll("\\", "/");
};

export const rewriteProductionRuntimeImports = (
  code: string,
  base = "/",
): {
  code: string;
  rewrittenDreiImports: number;
  rewrittenDreiExports: number;
  rewrittenMermaidImports: number;
} => {
  let rewrittenDreiImports = 0;
  let rewrittenDreiExports = 0;
  const directDrei = code.replace(
    DREI_IMPORT_RE,
    (full, lineStart: string, indentation: string, body: string) => {
      const parsed = body
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
        if (!entry.typeOnly && DREI_EXPORTS.has(entry.imported)) {
          direct.push(entry);
        } else {
          retained.push(entry);
        }
      }
      if (direct.length === 0) return full;

      rewrittenDreiImports += 1;
      rewrittenDreiExports += direct.length;
      const lines = direct.map((entry) => {
        const modulePath = DREI_EXPORTS.get(entry.imported);
        const binding =
          entry.local === entry.imported
            ? entry.imported
            : `${entry.imported} as ${entry.local}`;
        return `${indentation}import { ${binding} } from "@react-three/drei/${modulePath}";`;
      });
      if (retained.length > 0) {
        lines.push(
          `${indentation}import { ${retained.map((entry) => entry.source).join(", ")} } from "@react-three/drei";`,
        );
      }
      return `${lineStart}${lines.join("\n")}`;
    },
  );

  let rewrittenMermaidImports = 0;
  const mermaidUrl = `${withTrailingSlash(base)}vendor/mermaid/mermaid.esm.min.mjs`;
  const rewritten = directDrei.replace(MERMAID_IMPORT_RE, () => {
    rewrittenMermaidImports += 1;
    return `import(/* @vite-ignore */ ${JSON.stringify(mermaidUrl)})`;
  });

  return {
    code: rewritten,
    rewrittenDreiImports,
    rewrittenDreiExports,
    rewrittenMermaidImports,
  };
};

export const renderVendoredPlotlyModule = (
  base: string,
  integrity: string,
): string => {
  const plotlyUrl = `${withTrailingSlash(base)}vendor/plotly/plotly.min.js`;
  return `
import React, { useEffect, useState } from "react";
import createPlotlyComponent from "react-plotly.js/factory";

const SCRIPT_ID = "casimir-vendored-plotly";
const SCRIPT_URL = ${JSON.stringify(plotlyUrl)};
const SCRIPT_INTEGRITY = ${JSON.stringify(integrity)};
let loadPromise;
let PlotComponent = null;

const readPlotly = () => globalThis.Plotly;

const loadPlotly = () => {
  const loaded = readPlotly();
  if (loaded) return Promise.resolve(loaded);
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    let script = document.getElementById(SCRIPT_ID);
    let appendScript = false;
    const onLoad = () => {
      const plotly = readPlotly();
      if (plotly) resolve(plotly);
      else reject(new Error("plotly_global_missing"));
    };
    const onError = () => reject(new Error("plotly_asset_load_failed"));
    if (!script) {
      script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.src = SCRIPT_URL;
      script.async = true;
      script.integrity = SCRIPT_INTEGRITY;
      script.crossOrigin = "anonymous";
      appendScript = true;
    }
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    if (appendScript) document.head.appendChild(script);
  });
  return loadPromise;
};

export default function VendoredPlotly(props) {
  const [Component, setComponent] = useState(() => PlotComponent);
  const [error, setError] = useState(null);
  useEffect(() => {
    let active = true;
    void loadPlotly()
      .then((plotly) => {
        if (!PlotComponent) PlotComponent = createPlotlyComponent(plotly);
        if (active) setComponent(() => PlotComponent);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "plotly_load_failed");
      });
    return () => {
      active = false;
    };
  }, []);
  if (error) {
    return React.createElement("div", { role: "alert", "data-plotly-status": "error" }, "Chart unavailable: " + error);
  }
  if (!Component) {
    return React.createElement("div", { "aria-busy": "true", "data-plotly-status": "loading" }, "Loading chart...");
  }
  return React.createElement(Component, props);
}
`;
};

export const productionRuntimeVendors = (repoRoot: string): Plugin => {
  let productionBuild = false;
  let base = "/";
  let plotlyIntegrity = "";
  let rewrittenDreiExports = 0;
  let rewrittenMermaidImports = 0;
  return {
    name: "casimir-production-runtime-vendors",
    enforce: "pre",
    configResolved(config: ResolvedConfig) {
      productionBuild = config.command === "build";
      base = config.base;
      if (productionBuild) {
        plotlyIntegrity = plotlySubresourceIntegrity(repoRoot);
      }
    },
    resolveId(source, importer) {
      if (productionBuild) {
        const directDependency = resolveDreiDependencyImport(
          source,
          importer,
          repoRoot,
        );
        if (directDependency) return directDependency;
      }
      if (productionBuild && source === "react-plotly.js") {
        return VIRTUAL_PLOTLY_ID;
      }
      return null;
    },
    load(id) {
      if (id === VIRTUAL_PLOTLY_ID) {
        return renderVendoredPlotlyModule(base, plotlyIntegrity);
      }
      return null;
    },
    transform(code, id) {
      if (
        !productionBuild ||
        id.includes("/node_modules/") ||
        !/\.[cm]?[jt]sx?(?:\?|$)/.test(id) ||
        (!code.includes("@react-three/drei") && !code.includes("mermaid"))
      ) {
        return null;
      }
      const result = rewriteProductionRuntimeImports(code, base);
      if (
        result.rewrittenDreiExports === 0 &&
        result.rewrittenMermaidImports === 0
      ) {
        return null;
      }
      rewrittenDreiExports += result.rewrittenDreiExports;
      rewrittenMermaidImports += result.rewrittenMermaidImports;
      return { code: result.code, map: null };
    },
    buildEnd() {
      if (productionBuild) {
        console.log(
          `[vite:runtime-vendors] drei_exports=${rewrittenDreiExports} mermaid_imports=${rewrittenMermaidImports} plotly=vendored`,
        );
      }
    },
  };
};
