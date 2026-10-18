import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTimeDilationDiagnostics,
  type TimeDilationDiagnosticsOptions,
} from "../shared/time-dilation-diagnostics.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:5173";
const DEFAULT_GRID_SCALE = 1;
const DEFAULT_GR_TARGET_DX_M = 5;

const parseArgs = (argv: string[]) => {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = typeof args.url === "string" ? args.url : DEFAULT_BASE_URL;
  const outPath = typeof args.out === "string" ? args.out : undefined;
  const quality = typeof args.quality === "string" ? args.quality : undefined;
  const gridScale =
    typeof args.gridScale === "string" ? Number(args.gridScale) : DEFAULT_GRID_SCALE;
  const grTargetDx =
    typeof args.grTargetDx === "string" ? Number(args.grTargetDx) : DEFAULT_GR_TARGET_DX_M;
  const timeoutMs =
    typeof args.timeoutMs === "string" ? Number(args.timeoutMs) : undefined;
  const includeExtra = args.includeExtra !== false;
  const includeMatter = args.includeMatter !== false;
  const includeKij = args.includeKij !== false;
  const wallInvariant =
    args.wallInvariant === "ricci4" ? "ricci4" : undefined;
  const publish = args.publish === true;

  const diagnostics = await buildTimeDilationDiagnostics({
    baseUrl,
    quality,
    gridScale: Number.isFinite(gridScale) ? gridScale : DEFAULT_GRID_SCALE,
    grTargetDx: Number.isFinite(grTargetDx) ? grTargetDx : DEFAULT_GR_TARGET_DX_M,
    includeExtra,
    includeMatter,
    includeKij,
    wallInvariant,
    publish,
    timeoutMs: Number.isFinite(timeoutMs as number) ? (timeoutMs as number) : undefined,
  } satisfies TimeDilationDiagnosticsOptions);

  if (outPath) {
    const resolvedOut = path.resolve(process.cwd(), outPath);
    fs.writeFileSync(resolvedOut, JSON.stringify(diagnostics, null, 2));
  } else {
    process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
