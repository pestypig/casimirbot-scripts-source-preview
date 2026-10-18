import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

type BaselineSummary = {
  canonicalHash?: string;
};

const BASELINE_PATH = "artifacts/experiments/sector-control-repro/baseline-summary.json";
const FIXED_TIME = "2025-01-01T00:00:00.000Z";

const run = () => {
  const tempOut = "artifacts/experiments/sector-control-repro/latest/check-summary.json";
  const cmd = spawnSync(
    process.execPath,
    [
      "./node_modules/tsx/dist/cli.mjs",
      "scripts/sector-control-repro.ts",
      "--out-json",
      tempOut,
      "--no-md",
      "1",
      "--fixed-time",
      FIXED_TIME,
    ],
    { stdio: "inherit" },
  );
  if (cmd.status !== 0) {
    process.exit(cmd.status ?? 1);
  }

  const baselinePath = path.resolve(process.cwd(), BASELINE_PATH);
  if (!fs.existsSync(baselinePath)) {
    console.error(`baseline missing: ${BASELINE_PATH}`);
    process.exit(2);
  }

  const current = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), tempOut), "utf8"),
  ) as BaselineSummary;
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as BaselineSummary;

  if (!current.canonicalHash || !baseline.canonicalHash) {
    console.error("canonicalHash missing in summary payload");
    process.exit(3);
  }

  if (current.canonicalHash !== baseline.canonicalHash) {
    console.error(
      `sector-control repro mismatch: current=${current.canonicalHash} baseline=${baseline.canonicalHash}`,
    );
    process.exit(4);
  }

  console.log(`sector-control repro check PASS ${current.canonicalHash}`);
};

run();
