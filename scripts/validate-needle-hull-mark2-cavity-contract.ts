import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  needleHullMark2CavityContractSchema,
  resolveNeedleHullMark2CavityViewGeometry,
} from "../shared/needle-hull-mark2-cavity-contract";

function parseFlag(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[index + 1];
}

function normalizePath(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

const main = (): void => {
  const repoRoot = process.cwd();
  const contractPath = path.resolve(
    repoRoot,
    parseFlag("--contract") ?? "configs/needle-hull-mark2-cavity-contract.v1.json",
  );

  if (!fs.existsSync(contractPath)) {
    console.error(
      `FAIL nhm2_cavity_contract_missing path=${normalizePath(repoRoot, contractPath)}`,
    );
    process.exit(1);
  }

  let fileBuffer: Buffer;
  let raw: unknown;
  try {
    fileBuffer = fs.readFileSync(contractPath);
    raw = JSON.parse(fileBuffer.toString("utf8")) as unknown;
  } catch (error) {
    console.error(
      `FAIL nhm2_cavity_contract_invalid_json path=${normalizePath(repoRoot, contractPath)} error=${String(error)}`,
    );
    process.exit(1);
  }

  try {
    const contract = needleHullMark2CavityContractSchema.parse(raw);
    const view = resolveNeedleHullMark2CavityViewGeometry(contract);
    const sha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");
    console.log(
      [
        "PASS needle_hull_mark2_cavity_contract",
        `path=${normalizePath(repoRoot, contractPath)}`,
        `sha256=${sha256}`,
        `status=${contract.status}`,
        `sectorCount=${contract.geometry.sectorCount}`,
        `gap_nm=${contract.geometry.gap_nm}`,
        `tileArea_mm2=${contract.layout.tileArea_mm2}`,
        `tileWidth_mm=${view.tileWidth_mm}`,
      ].join(" "),
    );
  } catch (error) {
    console.error(
      `FAIL nhm2_cavity_contract_schema path=${normalizePath(repoRoot, contractPath)} error=${String(error)}`,
    );
    process.exit(1);
  }
};

main();
