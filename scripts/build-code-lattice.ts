import fs from "node:fs/promises";
import path from "node:path";
import { buildCodeLatticeSnapshot } from "../server/services/code-lattice/builders";

const ROOT = process.cwd().replace(/\\/g, "/");

async function main() {
  try {
    const { snapshot } = await buildCodeLatticeSnapshot();
    const versioned =
      typeof snapshot.latticeVersion === "number" && snapshot.latticeVersion > 0
        ? snapshot
        : { ...snapshot, latticeVersion: 1 };
    const outDir = path.join(ROOT, "server/_generated");
    await fs.mkdir(outDir, { recursive: true });
    const target = path.join(outDir, "code-lattice.json");
    await fs.writeFile(target, JSON.stringify(versioned, null, 2));
    console.log(
      `[code-lattice] wrote ${versioned.nodes.length} nodes and ${versioned.edges.length} edges to ${path.relative(
        ROOT,
        target,
      )}`,
    );
  } catch (error) {
    console.error("[code-lattice] build failed:", error);
    process.exitCode = 1;
  }
}

void main();
