import fs from "node:fs";
import path from "node:path";
import {
  loadIdeologyVerifierPack,
  validateIdeologyVerifierPackAgainstNodeIds,
} from "../shared/ideology/ideology-verifiers";
import { collectIdeologyNodeIdsFromTree } from "./collect-ideology-node-ids";

const resolvePath = (primary: string, fallback?: string) => {
  if (fs.existsSync(primary)) return primary;
  if (fallback && fs.existsSync(fallback)) return fallback;
  return primary;
};

function main() {
  const ideologyPath = resolvePath(
    path.join(process.cwd(), "docs", "ethos", "ideology.json"),
    path.join(process.cwd(), "ideology.json"),
  );
  const verifiersPath = resolvePath(
    path.join(process.cwd(), "configs", "ideology-verifiers.json"),
    path.join(process.cwd(), "ideology-verifiers.json"),
  );

  const ideologyTree = JSON.parse(fs.readFileSync(ideologyPath, "utf8"));
  const nodeIds = collectIdeologyNodeIdsFromTree(ideologyTree);

  const pack = loadIdeologyVerifierPack(verifiersPath);
  const result = validateIdeologyVerifierPackAgainstNodeIds(pack, nodeIds);

  if (!result.ok) {
    console.error(
      `ideology-verifiers validation failed with ${result.errors.length} error(s):`,
    );
    for (const error of result.errors) {
      console.error(`- [${error.kind}] ${error.message}`);
    }
    process.exit(1);
  }

  console.log(
    `ideology-verifiers validation OK. mappings=${pack.mappings.length} nodes=${nodeIds.size}`,
  );
}

main();
