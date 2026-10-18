import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const candidates =
  process.platform === "win32"
    ? ["lake", "lake.exe", join(homedir(), ".elan", "bin", "lake.exe")]
    : ["lake", join(homedir(), ".elan", "bin", "lake")];

let lastResult = null;

for (const candidate of candidates) {
  if (candidate.includes(".elan") && !existsSync(candidate)) continue;
  const result = spawnSync(candidate, ["build"], {
    cwd: join(process.cwd(), "formal", "lean"),
    stdio: "inherit",
    shell: false,
  });
  if (result.error && result.error.code === "ENOENT") {
    lastResult = result;
    continue;
  }
  process.exit(result.status ?? 1);
}

console.error(
  "Unable to find Lean Lake. Install Lean via elan or ensure lake is available on PATH.",
);
if (lastResult?.error) console.error(lastResult.error.message);
process.exit(1);
