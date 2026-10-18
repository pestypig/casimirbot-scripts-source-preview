#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const runGit = (args, cwd) => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();

const readGitStatus = (cwd) => execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).replace(/\r\n/g, "\n").replace(/\n$/u, "");

export function normalizeReplitProvisionedLockfile({
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const isDeployment = env.REPLIT_DEPLOYMENT === "1" || env.REPLIT_DEPLOYMENT === "true";
  if (!isDeployment) return { normalized: false, reason: "not a deployment build" };

  const status = readGitStatus(cwd);
  if (!status) return { normalized: false, reason: "source checkout is already clean" };
  if (status !== " M package-lock.json") {
    return { normalized: false, reason: "dirty paths are outside the narrow lockfile exception", status };
  }

  const authorityRef = env.REPLIT_GIT_AUTHORITY_REF?.trim();
  if (!authorityRef) throw new Error("Cannot normalize package-lock.json without REPLIT_GIT_AUTHORITY_REF.");
  const head = runGit(["rev-parse", "--verify", "HEAD^{commit}"], cwd);
  let authorityHead;
  try {
    authorityHead = runGit(["rev-parse", "--verify", `${authorityRef}^{commit}`], cwd);
  } catch {
    throw new Error(`Cannot resolve authoritative ref ${authorityRef}; refusing to restore package-lock.json.`);
  }
  if (head !== authorityHead) {
    throw new Error(`HEAD ${head} does not match authoritative ref ${authorityRef} ${authorityHead}; refusing to restore package-lock.json.`);
  }

  runGit(["restore", "--source=HEAD", "--worktree", "--", "package-lock.json"], cwd);
  const remainingStatus = readGitStatus(cwd);
  if (remainingStatus) throw new Error(`Lockfile normalization left a dirty checkout: ${remainingStatus}`);
  return { normalized: true, head, authorityRef };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    const result = normalizeReplitProvisionedLockfile();
    if (result.normalized) {
      console.log(`[replit] restored npm-provisioner lockfile drift to authoritative HEAD ${result.head}`);
    } else {
      console.log(`[replit] lockfile preflight: ${result.reason}`);
    }
  } catch (error) {
    console.error(`[replit] lockfile preflight failed: ${error.message}`);
    process.exitCode = 1;
  }
}
