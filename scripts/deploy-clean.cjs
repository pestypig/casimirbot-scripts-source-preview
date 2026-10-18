const fs = require("fs");
const path = require("path");

const ROOTS = [
  "models",
  ".cache",
  "artifacts",
  "datasets",
  "reports",
  "coverage",
  "tmp",
  "test-results",
];


function removePath(target) {
  if (!fs.existsSync(target)) {
    return;
  }
  if (target === ".cache") {
    const entries = fs.readdirSync(target);
    for (const entry of entries) {
      if (entry === "replit" || entry === "llm") {
        continue;
      }
      fs.rmSync(path.join(target, entry), { recursive: true, force: true });
      process.stdout.write(`[deploy-clean] removed ${path.join(target, entry)}\n`);
    }
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
  process.stdout.write(`[deploy-clean] removed ${target}\n`);
}

for (const entry of ROOTS) {
  removePath(entry);
}

// Keep code-lattice.json in deploy images; removing it can break boot if
// object-storage hydration is unavailable during startup.
