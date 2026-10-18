import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const DEFAULT_REPO_URL =
  "https://github.com/ComputationallyBased/RayTracingMIS";
const DEFAULT_TARGET = "external/RayTracingMIS";
const DEFAULT_BRANCH = "main";

function runGit(args: string[]) {
  const result = spawnSync("git", args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function readEnv(name: string, fallback: string) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

const repoUrl = readEnv("RAYTRACINGMIS_REPO_URL", DEFAULT_REPO_URL);
const targetDir = path.resolve(
  process.cwd(),
  readEnv("RAYTRACINGMIS_PROJECT_DIR", DEFAULT_TARGET),
);
const branch = readEnv("RAYTRACINGMIS_BRANCH", DEFAULT_BRANCH);

if (existsSync(path.join(targetDir, ".git"))) {
  console.log(`[hull-mis-clone] Updating existing repo at ${targetDir}`);
  runGit(["-C", targetDir, "remote", "set-url", "origin", repoUrl]);
  runGit(["-C", targetDir, "fetch", "--depth=1", "origin", branch]);
  runGit(["-C", targetDir, "checkout", branch]);
  runGit(["-C", targetDir, "pull", "--ff-only", "origin", branch]);
} else {
  console.log(`[hull-mis-clone] Cloning ${repoUrl} -> ${targetDir}`);
  runGit(["clone", "--depth=1", "--branch", branch, repoUrl, targetDir]);
}

const head = spawnSync("git", ["-C", targetDir, "rev-parse", "HEAD"], {
  encoding: "utf8",
});
const commit = head.status === 0 ? head.stdout.trim() : "unknown";
console.log(
  JSON.stringify(
    {
      ok: true,
      projectDir: targetDir,
      branch,
      commit,
    },
    null,
    2,
  ),
);

