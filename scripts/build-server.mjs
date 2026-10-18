#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const resolveCommit = () => {
  const configured = [
    process.env.REPLIT_GIT_COMMIT,
    process.env.GIT_COMMIT,
    process.env.SOURCE_VERSION,
    process.env.GIT_SHA,
  ].find((value) => typeof value === "string" && value.trim());
  if (configured) return configured.trim();
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
};

const commit = resolveCommit();

await build({
  entryPoints: [path.join(repoRoot, "server", "index.ts")],
  platform: "node",
  packages: "external",
  bundle: true,
  format: "esm",
  outdir: path.join(repoRoot, "dist"),
  banner: {
    js: `globalThis.__CASIMIR_SERVER_BUILD_COMMIT__=${JSON.stringify(commit)};`,
  },
  logLevel: "info",
});

console.log(`[build:server] embedded commit ${commit}`);
