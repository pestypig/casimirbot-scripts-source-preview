const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dryRun = process.argv.includes("--dry-run");

if (process.env.CASIMIR_PUBLIC_SITE_DEPLOY_COMPACT !== "1") {
  process.stdout.write("[replit] deployment compaction disabled\n");
  process.exit(0);
}
if (process.env.REPLIT_DEPLOYMENT !== "1") {
  throw new Error("Deployment compaction requires REPLIT_DEPLOYMENT=1");
}
if (!fs.existsSync(path.join(root, "dist", "index.js")) ||
    !fs.existsSync(path.join(root, "dist", "build-meta.json"))) {
  throw new Error("Deployment compaction requires a completed production build");
}

// These are development-only files. Replit builds deployments in an isolated
// copy of the workspace; the live server uses compiled dist/ and runtime data.
const developmentOnly = [".tmp", ".cache", ".pythonlibs", ".git"];
for (const entry of developmentOnly) {
  const target = path.resolve(root, entry);
  if (path.dirname(target) !== root) {
    throw new Error(`Deployment compaction target escaped workspace: ${entry}`);
  }
  if (!fs.existsSync(target)) continue;
  if (dryRun) {
    process.stdout.write(`[replit] would exclude ${entry}\n`);
    continue;
  }
  fs.rmSync(target, { recursive: true, force: true });
  process.stdout.write(`[replit] excluded ${entry} from deployment image\n`);
}
