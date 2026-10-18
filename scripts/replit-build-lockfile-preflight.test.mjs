import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeReplitProvisionedLockfile } from "./replit-build-lockfile-preflight.mjs";

const withRepo = (callback) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "casimirbot-lockfile-preflight-"));
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    git(["init", "--quiet", "--initial-branch=main"]);
    git(["config", "core.autocrlf", "false"]);
    git(["config", "user.name", "CasimirBot Test"]);
    git(["config", "user.email", "casimirbot-test@example.invalid"]);
    writeFileSync(path.join(cwd, "package-lock.json"), '{"name":"test","lockfileVersion":3}\n');
    git(["add", "package-lock.json"]);
    git(["commit", "--quiet", "-m", "baseline"]);
    const head = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/remotes/origin/main", head]);
    return callback({ cwd, git, head });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

test("restores only the provisioner lockfile rewrite when HEAD is origin/main", () => withRepo(({ cwd, git, head }) => {
  const committed = readFileSync(path.join(cwd, "package-lock.json"), "utf8");
  writeFileSync(path.join(cwd, "package-lock.json"), '{"name":"test","lockfileVersion":3,"npmRewrite":true}\n');
  const result = normalizeReplitProvisionedLockfile({
    cwd,
    env: { REPLIT_DEPLOYMENT: "1", REPLIT_GIT_AUTHORITY_REF: "origin/main" },
  });
  assert.deepEqual(result, { normalized: true, head, authorityRef: "origin/main" });
  assert.equal(readFileSync(path.join(cwd, "package-lock.json"), "utf8"), committed);
  assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"]), "");
}));

test("does not restore the lockfile when any other path is dirty", () => withRepo(({ cwd, git }) => {
  writeFileSync(path.join(cwd, "package-lock.json"), '{"changed":true}\n');
  writeFileSync(path.join(cwd, "other.txt"), "keep me");
  const result = normalizeReplitProvisionedLockfile({
    cwd,
    env: { REPLIT_DEPLOYMENT: "1", REPLIT_GIT_AUTHORITY_REF: "origin/main" },
  });
  assert.equal(result.normalized, false);
  assert.match(result.reason, /outside the narrow lockfile exception/);
  assert.notEqual(git(["status", "--porcelain=v1", "--untracked-files=all"]), "");
  assert.equal(readFileSync(path.join(cwd, "other.txt"), "utf8"), "keep me");
}));

test("does not restore the lockfile when HEAD is not the authoritative ref", () => withRepo(({ cwd, git }) => {
  writeFileSync(path.join(cwd, "other.txt"), "later commit");
  git(["add", "other.txt"]);
  git(["commit", "--quiet", "-m", "advance head"]);
  writeFileSync(path.join(cwd, "package-lock.json"), '{"changed":true}\n');
  assert.throws(
    () => normalizeReplitProvisionedLockfile({
      cwd,
      env: { REPLIT_DEPLOYMENT: "1", REPLIT_GIT_AUTHORITY_REF: "origin/main" },
    }),
    /does not match authoritative ref/,
  );
  assert.equal(readFileSync(path.join(cwd, "package-lock.json"), "utf8"), '{"changed":true}\n');
}));
