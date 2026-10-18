import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const DEFAULT_PROJECT = "external/RayTracingMIS";
const BRIDGE_SOURCE = "integrations/raytracingmis/HullRenderBridge.cs";
const BRIDGE_DEST_RELATIVE = "Assets/Scripts/CasimirBot/HullRenderBridge.cs";

const projectDir = path.resolve(
  process.cwd(),
  process.env.RAYTRACINGMIS_PROJECT_DIR?.trim() || DEFAULT_PROJECT,
);
const source = path.resolve(process.cwd(), BRIDGE_SOURCE);
const destination = path.resolve(projectDir, BRIDGE_DEST_RELATIVE);

if (!existsSync(source)) {
  throw new Error(`Bridge source not found: ${source}`);
}

if (!existsSync(projectDir)) {
  throw new Error(
    `RayTracingMIS project not found at ${projectDir}. Run "npm run hull:mis:clone" first.`,
  );
}

mkdirSync(path.dirname(destination), { recursive: true });
copyFileSync(source, destination);

console.log(
  JSON.stringify(
    {
      ok: true,
      source,
      destination,
    },
    null,
    2,
  ),
);

