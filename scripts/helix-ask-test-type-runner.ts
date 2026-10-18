import { execSync } from "node:child_process";

type Step = {
  script: string;
  args?: string[];
};

type TestTypeProfile = {
  description: string;
  steps: Step[];
};

type CliArgs = {
  type: string | null;
  list: boolean;
  dryRun: boolean;
  continueOnFail: boolean;
  baseUrl: string | null;
  passThrough: string[];
};

const TEST_TYPES: Record<string, TestTypeProfile> = {
  objective_loop: {
    description: "Strict objective-loop probe (best first check for fallback/divergence).",
    steps: [{ script: "helix:ask:patch-probe:strict" }],
  },
  debug_loop: {
    description: "Live routing + lane debug loop for /api/agi/ask.",
    steps: [{ script: "helix:ask:dot:debug-loop" }],
  },
  prompt_quality: {
    description: "Prompt-quality probe focused on template strength/chokepoints.",
    steps: [{ script: "helix:ask:prompt-quality:probe" }],
  },
  differential: {
    description:
      "Codex-style differential scorer on a fixed corpus with per-prompt divergence report.",
    steps: [{ script: "helix:ask:differential" }],
  },
  retrieval: {
    description: "Retrieval ablation battery (atlas/git-tracked lane comparisons).",
    steps: [{ script: "helix:ask:retrieval:ablation" }],
  },
  regression_light: {
    description: "Light Helix Ask regression pack.",
    steps: [{ script: "helix:ask:regression:light" }],
  },
  codex_baseline: {
    description:
      "Codex-aligned baseline chain: strict objective loop probe, prompt-quality probe, and live debug loop.",
    steps: [
      { script: "helix:ask:patch-probe:strict" },
      { script: "helix:ask:prompt-quality:probe" },
      { script: "helix:ask:dot:debug-loop" },
    ],
  },
};

const ALIASES: Record<string, string> = {
  objective: "objective_loop",
  fallback: "objective_loop",
  divergence: "objective_loop",
  debug: "debug_loop",
  live: "debug_loop",
  prompt: "prompt_quality",
  diff: "differential",
  differential_mode: "differential",
  codex_diff: "differential",
  retrieval_ablation: "retrieval",
  regression: "regression_light",
  codex: "codex_baseline",
};

const resolveType = (value: string): string => {
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  return ALIASES[normalized] ?? normalized;
};

const printUsage = (): void => {
  const entries = Object.entries(TEST_TYPES)
    .map(([name, profile]) => `  - ${name}: ${profile.description}`)
    .join("\n");
  console.log(
    [
      "Usage:",
      "  npm run helix:ask:test-type -- --type <name> [--base-url <url>] [--dry-run] [--continue-on-fail] [-- ...args]",
      "",
      "Available test types:",
      entries,
      "",
      "Aliases: objective, fallback, divergence, debug, live, prompt, diff, differential_mode, codex_diff, retrieval_ablation, regression, codex",
    ].join("\n"),
  );
};

const parseArgs = (): CliArgs => {
  const argv = process.argv.slice(2);
  const dividerIndex = argv.indexOf("--");
  const head = dividerIndex >= 0 ? argv.slice(0, dividerIndex) : argv;
  const tail = dividerIndex >= 0 ? argv.slice(dividerIndex + 1) : [];

  let type: string | null = null;
  let list = false;
  let dryRun = false;
  let continueOnFail = false;
  let baseUrl: string | null = null;
  const implicitPassThrough: string[] = [];

  const readRequiredValue = (index: number, flag: string): string => {
    const next = head[index + 1];
    if (!next || next.startsWith("-")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return next;
  };

  for (let i = 0; i < head.length; i += 1) {
    const token = head[i];
    if (token === "--type" || token === "-t") {
      type = readRequiredValue(i, token);
      i += 1;
      continue;
    }
    if (token === "--base-url") {
      baseUrl = readRequiredValue(i, token);
      i += 1;
      continue;
    }
    if (token === "--list" || token === "-l") {
      list = true;
      continue;
    }
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token === "--continue-on-fail") {
      continueOnFail = true;
      continue;
    }
    implicitPassThrough.push(token);
  }

  return {
    type,
    list,
    dryRun,
    continueOnFail,
    baseUrl,
    passThrough: [...implicitPassThrough, ...tail],
  };
};

const runStep = async (
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> => {
  const shellQuote = (value: string): string => {
    if (/^[A-Za-z0-9_./:=,-]+$/.test(value)) return value;
    return `"${value.replace(/"/g, '\\"')}"`;
  };
  const commandParts = ["npm", "run", "-s", script];
  if (args.length > 0) {
    commandParts.push("--", ...args);
  }
  const command = commandParts.map(shellQuote).join(" ");
  try {
    execSync(command, {
      stdio: "inherit",
      env,
    });
    return 0;
  } catch (error) {
    const failed = error as { status?: number };
    return typeof failed.status === "number" ? failed.status : 1;
  }
};

const sanitizeEnv = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key || key.startsWith("=") || typeof value === "undefined") continue;
    out[key] = value;
  }
  return out;
};

const main = async (): Promise<void> => {
  const parsed = parseArgs();

  if (parsed.list) {
    printUsage();
    return;
  }

  if (!parsed.type) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const typeKey = resolveType(parsed.type);
  const profile = TEST_TYPES[typeKey];
  if (!profile) {
    console.error(`Unknown test type: ${parsed.type}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  const baseEnv = sanitizeEnv(process.env);
  if (parsed.baseUrl) {
    baseEnv.HELIX_ASK_BASE_URL = parsed.baseUrl;
    baseEnv.EVAL_BASE_URL = parsed.baseUrl;
  }

  console.log(`helix-ask:test-type selected=${typeKey}`);
  console.log(`description=${profile.description}`);
  if (parsed.baseUrl) {
    console.log(`base_url=${parsed.baseUrl}`);
  }
  if (parsed.passThrough.length > 0 && profile.steps.length > 1) {
    console.log("note=passthrough args are applied to the final step only for multi-step profiles");
  }

  let failures = 0;
  for (let index = 0; index < profile.steps.length; index += 1) {
    const step = profile.steps[index];
    const isFinalStep = index === profile.steps.length - 1;
    const stepArgs = [...(step.args ?? []), ...(isFinalStep ? parsed.passThrough : [])];
    const label = `${index + 1}/${profile.steps.length}`;
    console.log(`\n[${label}] npm run -s ${step.script}${stepArgs.length ? ` -- ${stepArgs.join(" ")}` : ""}`);
    if (parsed.dryRun) {
      continue;
    }
    const start = Date.now();
    const exitCode = await runStep(step.script, stepArgs, baseEnv);
    const elapsedMs = Date.now() - start;
    if (exitCode === 0) {
      console.log(`[${label}] result=pass duration_ms=${elapsedMs}`);
      continue;
    }
    failures += 1;
    console.error(`[${label}] result=fail exit_code=${exitCode} duration_ms=${elapsedMs}`);
    if (!parsed.continueOnFail) {
      process.exitCode = exitCode;
      return;
    }
  }

  if (parsed.dryRun) {
    console.log("\nresult=dry_run_only");
    return;
  }

  if (failures > 0) {
    console.error(`\nresult=fail failed_steps=${failures} total_steps=${profile.steps.length}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nresult=pass total_steps=${profile.steps.length}`);
};

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`helix-ask:test-type error: ${message}`);
  process.exitCode = 1;
});
