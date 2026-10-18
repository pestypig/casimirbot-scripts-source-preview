import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readSpaceEngineScenePreview } from "../../server/services/spaceengine/scene-preview";
import { compileSpaceEngineSceneBundle } from "../../server/services/spaceengine/scene-bundle";

const outputRoot = path.resolve("dist/spaceengine-preview/addons");
const scene = await readSpaceEngineScenePreview({ sceneId: "darkmatter.yukawa_proxy.v1" });
const bundle = compileSpaceEngineSceneBundle(scene);
if (bundle.sceneKind !== "darkmatter_yukawa_proxy") throw new Error("SPACEENGINE_WRONG_SCENE_KIND");

for (const item of bundle.files) {
  const destination = path.resolve(outputRoot, ...item.addonRelativePath.split("/"));
  if (!destination.startsWith(outputRoot + path.sep)) throw new Error("SPACEENGINE_OUTPUT_OUTSIDE_ROOT");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, item.content, { encoding: "utf8", flag: "w" });
}
const indexPath = path.resolve(outputRoot, "CasimirBot", "bundle-index.json");
await writeFile(indexPath, JSON.stringify({
  ...bundle,
  files: bundle.files.map(({ content: _content, ...metadata }) => metadata),
}, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify({
  status: "built_outside_game",
  sceneKind: bundle.sceneKind,
  bundleSha256: bundle.bundleSha256,
  outputRoot,
  fileCount: bundle.files.length + 1,
}) + "\n");
