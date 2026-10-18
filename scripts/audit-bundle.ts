import { spawn } from "node:child_process";
import path from "node:path";

type Step = {
  label: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

const DEFAULT_TRACE_OUT = "reports/training-trace.jsonl";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const USAGE =
  "Usage: npm run audit:bundle -- --json request.json [--params '{...}'] " +
  "[--url https://host/api/agi/adapter/run] [--export-url https://host/api/agi/training-trace/export] " +
  `[--trace-out ${DEFAULT_TRACE_OUT}|-] [--trace-limit 50] ` +
  "[--token <jwt>] [--tenant <id>] [--traceparent <id>] [--tracestate <id>]";

const hasFlag = (args: string[], flag: string) =>
  args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));

const readFlagValue = (args: string[], flags: string[]) => {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    for (const flag of flags) {
      if (arg === flag && i + 1 < args.length) return args[i + 1];
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    }
  }
  return undefined;
};

const hasInputPayload = (args: string[]) =>
  hasFlag(args, "--json") ||
  hasFlag(args, "-j") ||
  hasFlag(args, "--params") ||
  hasFlag(args, "-p");

const runStep = (step: Step): Promise<number> =>
  new Promise((resolve) => {
    const env = Object.fromEntries(
      Object.entries({ ...process.env, ...(step.env ?? {}) }).filter(
        ([, value]) => typeof value === "string",
      ),
    ) as NodeJS.ProcessEnv;
    const child = spawn(step.command, step.args, {
      stdio: "inherit",
      env,
      shell: process.platform === "win32",
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });

const main = async () => {
  const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
  if (hasFlag(rawArgs, "--help") || hasFlag(rawArgs, "-h")) {
    console.error(USAGE);
    process.exit(0);
  }
  if (!hasInputPayload(rawArgs)) {
    console.error("Adapter request payload is required for casimir:verify.");
    console.error(USAGE);
    process.exit(1);
  }

  const casimirArgs = [...rawArgs];
  if (!hasFlag(casimirArgs, "--trace-out") && !hasFlag(casimirArgs, "-o")) {
    casimirArgs.push("--trace-out", DEFAULT_TRACE_OUT);
  }
  const traceOut =
    readFlagValue(casimirArgs, ["--trace-out", "-o"]) ?? DEFAULT_TRACE_OUT;
  const reportDir = traceOut === "-" ? "reports" : path.dirname(traceOut);
  const resolvedReportDir = reportDir && reportDir !== "." ? reportDir : "reports";

  const steps: Step[] = [
    { label: "math:validate", command: npmCommand, args: ["run", "math:validate"] },
    {
      label: "math:report",
      command: npmCommand,
      args: ["run", "math:report"],
      env: { MATH_REPORT_DIR: resolvedReportDir },
    },
    {
      label: "casimir:verify",
      command: npmCommand,
      args: ["run", "casimir:verify", "--", ...casimirArgs],
    },
  ];

  let exitCode = 0;
  for (const step of steps) {
    console.log(`[audit-bundle] running ${step.label}`);
    const code = await runStep(step);
    if (code !== 0 && exitCode === 0) {
      exitCode = code;
    }
  }

  process.exit(exitCode);
};

main().catch((error) => {
  console.error("[audit-bundle] failed:", error);
  process.exit(1);
});
