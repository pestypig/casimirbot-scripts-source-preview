import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveArtifactsPath } from "./agi-artifacts";

type StepResult = {
  label: string;
  code: number;
};

const repoRoot = process.cwd();
const mathFiles = ["math.config.json", "math.evidence.json", "MATH_STATUS.md"];
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const npmExecPath = process.env.npm_execpath ?? process.env.NPM_EXEC_PATH;

const isTruthy = (value?: string): boolean => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return false;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return true;
};

const hasMathTree = () => {
  const missing = mathFiles.filter(
    (file) => !fs.existsSync(path.resolve(repoRoot, file)),
  );
  return { ok: missing.length === 0, missing };
};

const hasAdapterEnv = () => {
  const env = process.env;
  return Boolean(
    env.CASIMIR_VERIFY_URL ||
      env.AGI_ADAPTER_URL ||
      env.CASIMIR_PUBLIC_BASE_URL ||
      env.SHADOW_OF_INTENT_BASE_URL ||
      env.API_BASE ||
      env.HELIX_API_BASE ||
      env.API_PROXY_TARGET ||
      env.VITE_API_BASE,
  );
};

const runNpm = (args: string[]): Promise<number> =>
  new Promise((resolve) => {
    const useNode = !!npmExecPath && fs.existsSync(npmExecPath);
    const command = useNode ? process.execPath : npmBin;
    const commandArgs = useNode ? [npmExecPath as string, ...args] : args;
    const child = spawn(command, commandArgs, {
      stdio: "inherit",
      shell: !useNode && process.platform === "win32",
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });

const runStep = async (label: string, args: string[]): Promise<StepResult> => {
  console.log(`[audit:init] ${label}`);
  const code = await runNpm(args);
  return { label, code };
};

const main = async () => {
  const results: StepResult[] = [];
  const mathCheck = hasMathTree();

  if (mathCheck.ok) {
    results.push(await runStep("math:report", ["run", "math:report"]));
    results.push(await runStep("math:validate", ["run", "math:validate"]));
  } else {
    console.log(
      `[audit:init] math tree not detected (missing: ${mathCheck.missing.join(
        ", ",
      )}).`,
    );
  }

  results.push(await runStep("reports:ci", ["run", "reports:ci"]));

  if (isTruthy(process.env.CI) && hasAdapterEnv()) {
    const traceOut = resolveArtifactsPath("training-trace.jsonl");
    results.push(
      await runStep("casimir:verify", [
        "run",
        "casimir:verify",
        "--",
        "--ci",
        "--trace-out",
        traceOut,
      ]),
    );
  } else {
    console.log(
      "[audit:init] casimir:verify skipped (CI or adapter endpoint not configured).",
    );
  }

  const failing = results.find((result) => result.code !== 0);
  if (failing) {
    console.error(`[audit:init] failed: ${failing.label}`);
    process.exit(failing.code);
  }
};

main().catch((error) => {
  console.error("[audit:init] error:", error);
  process.exit(1);
});
