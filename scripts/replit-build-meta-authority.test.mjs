import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

const run = (cwd, executable, args, env = process.env) => {
  const result = spawnSync(executable, args, { cwd, env, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
};

test("clean Replit publish checkpoints require the authoritative source tree", (t) => {
  const tempRoot = path.resolve(os.tmpdir());
  const repo = mkdtempSync(path.join(tempRoot, "casimir-replit-authority-"));
  t.after(() => {
    assert.equal(path.dirname(repo), tempRoot);
    assert.match(path.basename(repo), /^casimir-replit-authority-/);
    rmSync(repo, { recursive: true, force: true });
  });
  mkdirSync(path.join(repo, "scripts"));
  writeFileSync(path.join(repo, "package.json"), '{"type":"module"}\n');
  copyFileSync(path.join(scriptDirectory, "replit-build-meta.mjs"), path.join(repo, "scripts", "replit-build-meta.mjs"));
  copyFileSync(path.join(scriptDirectory, "replit-build-reuse.mjs"), path.join(repo, "scripts", "replit-build-reuse.mjs"));
  writeFileSync(path.join(repo, "source.txt"), "canonical\n");
  const git = (...args) => {
    const result = run(repo, "git", args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  git("config", "user.email", "replit-authority-test@example.invalid");
  git("config", "user.name", "Replit Authority Test");
  git("add", ".");
  git("commit", "-m", "canonical");
  const canonical = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", canonical);
  git("commit", "--allow-empty", "-m", "Replit publish checkpoint");
  const env = {
    ...process.env,
    REPLIT_DEPLOYMENT: "1",
    REPLIT_GIT_AUTHORITY_REF: "origin/main",
    REPLIT_GIT_COMMIT: canonical,
  };
  const check = () => run(repo, process.execPath, ["scripts/replit-build-meta.mjs", "assert-source"], env);
  assert.equal(check().status, 0, "clean, tree-identical checkpoint should pass");

  writeFileSync(path.join(repo, "source.txt"), "changed\n");
  assert.equal(check().status, 1, "dirty checkpoint must fail");
  git("add", "source.txt");
  git("commit", "-m", "changed source");
  assert.equal(check().status, 1, "committed source changes must fail");
});
