import fs from "node:fs/promises";
import path from "node:path";

const REQUIRED_FILES = [
  "time-dilation-diagnostics.json",
  "curvature-congruence-report.json",
  "pipeline-proofs.json",
  "gr-evolve-brick.json",
  "time-dilation-lattice-debug.json",
  "time-dilation-activate-response.json",
  "adapter-verification.json",
  "training-trace-export.jsonl",
] as const;

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

async function readJson(filePath: string) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function pick(obj: any, pathExpr: string): unknown {
  return pathExpr.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

async function main() {
  const bundle = arg("bundle");
  if (!bundle) {
    console.error("usage: tsx scripts/curvature-bundle-validate.ts --bundle <dir>");
    process.exit(2);
  }

  const missing: string[] = [];
  for (const file of REQUIRED_FILES) {
    try {
      await fs.access(path.join(bundle, file));
    } catch {
      missing.push(file);
    }
  }

  if (missing.length) {
    console.error(`[bundle-validate] missing files: ${missing.join(", ")}`);
    process.exit(2);
  }

  const report = await readJson(path.join(bundle, "curvature-congruence-report.json"));
  const diagnostics = await readJson(path.join(bundle, "time-dilation-diagnostics.json"));
  const verification = await readJson(path.join(bundle, "adapter-verification.json"));

  const checks = {
    reportStatus: pick(report, "primary.status"),
    gttResidual: pick(report, "primary.checks"),
    strictCongruence: pick(diagnostics, "strict.strictCongruence"),
    latticeMetricOnly: pick(diagnostics, "strict.latticeMetricOnly"),
    anyProxy: pick(diagnostics, "strict.anyProxy"),
    grCertified: pick(diagnostics, "strict.grCertified"),
    verifierVerdict: pick(verification, "verdict"),
  };

  await fs.writeFile(
    path.join(bundle, "bundle-preflight.json"),
    `${JSON.stringify({ ok: true, checks }, null, 2)}\n`,
    "utf8",
  );

  console.log("[bundle-validate] OK");
}

main().catch((err) => {
  console.error("[bundle-validate] failed", err);
  process.exit(1);
});
