import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

type ReportStep = "vitest" | "eslint" | "tsc" | "repo-telemetry";

type RepoTelemetry = {
  build?: {
    status?: string | boolean | number;
    ok?: boolean;
    exitCode?: number;
    durationMs?: number;
  };
  tests?: {
    status?: string | boolean | number;
    ok?: boolean;
    failed?: number;
    passed?: number;
    total?: number;
  };
  schema?: {
    contracts?: string | boolean | number;
    ok?: boolean;
  };
  deps?: {
    coherence?: string | boolean | number;
  };
  timeToGreenMs?: number;
  lint?: {
    status?: string | boolean | number;
  };
  typecheck?: {
    status?: string | boolean | number;
  };
  metrics?: Record<string, unknown>;
};

type TestCounts = {
  total?: number;
  failed?: number;
  passed?: number;
  skipped?: number;
  status?: "pass" | "fail";
};

type StepResult = {
  label: string;
  code: number;
};

const DEFAULT_REPORTS_DIR =
  process.env.CASIMIR_REPORTS_DIR ?? process.env.CI_REPORTS_DIR ?? "reports";

const resolveReportPath = (envKey: string, fallbackName: string): string => {
  const envValue = process.env[envKey]?.trim();
  const value = envValue && envValue.length > 0 ? envValue : fallbackName;
  const resolved = path.resolve(process.cwd(), value);
  return resolved;
};

const reportPaths = {
  vitest: resolveReportPath("CASIMIR_TEST_VITEST_PATH", path.join(DEFAULT_REPORTS_DIR, "vitest.json")),
  eslint: resolveReportPath("CASIMIR_LINT_ESLINT_PATH", path.join(DEFAULT_REPORTS_DIR, "eslint.json")),
  tsc: resolveReportPath("CASIMIR_TYPECHECK_TSC_PATH", path.join(DEFAULT_REPORTS_DIR, "tsc.txt")),
  repoTelemetry: resolveReportPath("CASIMIR_REPO_TELEMETRY_PATH", path.join(DEFAULT_REPORTS_DIR, "repo-telemetry.json")),
};

const TARGETS = [
  "client/src/**/*.{js,jsx,ts,tsx}",
  "server/**/*.{js,jsx,ts,tsx}",
  "shared/**/*.{js,jsx,ts,tsx}",
  "scripts/**/*.{js,jsx,ts,tsx}",
  "tests/**/*.{js,jsx,ts,tsx}",
  "tools/**/*.{js,jsx,ts,tsx}",
  "cli/**/*.{js,jsx,ts,tsx}",
  "sdk/**/*.{js,jsx,ts,tsx}",
  "modules/**/*.{js,jsx,ts,tsx}",
];

const ORDERED_STEPS: ReportStep[] = ["vitest", "eslint", "tsc", "repo-telemetry"];

const usage = () => {
  console.log("Usage: tsx scripts/ci-reports.ts [--vitest] [--eslint] [--tsc] [--repo-telemetry]");
  console.log("If no flags are provided, all reports are generated.");
};

const parseArgs = (): Set<ReportStep> => {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    usage();
    process.exit(0);
  }
  const requested = new Set<ReportStep>();
  for (const step of ORDERED_STEPS) {
    if (args.has(`--${step}`)) {
      requested.add(step);
    }
  }
  return requested;
};

const require = createRequire(import.meta.url);

const ensureDir = (filePath: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const resolvePackageBin = (name: string): string | null => {
  try {
    const pkgPath = require.resolve(`${name}/package.json`);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const bin = pkg.bin;
    const binRel =
      typeof bin === "string"
        ? bin
        : bin && typeof bin === "object"
          ? bin[name] ?? Object.values(bin)[0]
          : undefined;
    if (!binRel) return null;
    return path.resolve(path.dirname(pkgPath), binRel);
  } catch {
    return null;
  }
};

const runNodeBin = (
  binPath: string,
  args: string[],
  options?: { stdio?: "inherit" | "pipe" },
): ReturnType<typeof spawn> =>
  spawn(process.execPath, [binPath, ...args], { stdio: options?.stdio ?? "pipe" });

const runCommand = (command: string, args: string[]): Promise<number> =>
  new Promise((resolve) => {
    const child = runNodeBin(command, args, { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });

const runCommandCapture = (command: string, args: string[], outputPath: string): Promise<number> =>
  new Promise((resolve) => {
    let buffer = "";
    const child = runNodeBin(command, args);
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      buffer += text;
      process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      buffer += text;
      process.stderr.write(text);
    });
    child.on("close", (code) => {
      let output = buffer;
      if ((code ?? 1) === 0 && output.trim().length === 0) {
        output = "Found 0 errors.\n";
      }
      ensureDir(outputPath);
      fs.writeFileSync(outputPath, output, "utf8");
      resolve(code ?? 1);
    });
    child.on("error", () => {
      const output = "Typecheck failed to execute.\n";
      ensureDir(outputPath);
      fs.writeFileSync(outputPath, output, "utf8");
      resolve(1);
    });
  });

const writeEslintStub = (reason: string): void => {
  const payload = {
    results: [],
    meta: {
      skipped: true,
      reason,
      generatedAt: new Date().toISOString(),
    },
  };
  ensureDir(reportPaths.eslint);
  fs.writeFileSync(reportPaths.eslint, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const runVitestReport = async (): Promise<number> => {
  ensureDir(reportPaths.vitest);
  const vitestBin = resolvePackageBin("vitest");
  if (!vitestBin) {
    console.error("[ci-reports] vitest binary not found.");
    return 1;
  }
  return runCommand(vitestBin, [
    "run",
    "--reporter",
    "json",
    "--outputFile",
    reportPaths.vitest,
  ]);
};

const runEslintReport = async (): Promise<number> => {
  ensureDir(reportPaths.eslint);
  const eslintBin = resolvePackageBin("eslint");
  if (!eslintBin) {
    writeEslintStub("eslint_not_installed");
    return 1;
  }
  const code = await runCommand(eslintBin, [
    "--format",
    "json",
    "--output-file",
    reportPaths.eslint,
    "--no-error-on-unmatched-pattern",
    "--no-inline-config",
    "--quiet",
    ...TARGETS,
  ]);
  if (!fs.existsSync(reportPaths.eslint)) {
    writeEslintStub("eslint_failed");
  }
  return code;
};

const runTscReport = async (): Promise<number> => {
  const tscBin = resolvePackageBin("typescript");
  if (!tscBin) {
    const output = "Typecheck failed to locate the TypeScript compiler.\n";
    ensureDir(reportPaths.tsc);
    fs.writeFileSync(reportPaths.tsc, output, "utf8");
    return 1;
  }
  return runCommandCapture(tscBin, ["--noEmit", "--pretty", "false", "--project", "tsconfig.json"], reportPaths.tsc);
};

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const toBooleanMetric = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["1", "true", "yes", "pass", "ok", "success"].includes(lowered)) {
      return true;
    }
    if (["0", "false", "no", "fail", "failed", "error"].includes(lowered)) {
      return false;
    }
  }
  return undefined;
};

const countAssertionResults = (value: unknown): TestCounts | null => {
  if (!Array.isArray(value)) return null;
  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const assertions = obj.assertionResults;
    if (!Array.isArray(assertions)) continue;
    for (const assertion of assertions) {
      if (!assertion || typeof assertion !== "object") continue;
      const status = (assertion as Record<string, unknown>).status;
      if (typeof status !== "string") continue;
      const lowered = status.toLowerCase();
      if (["passed", "pass", "success"].includes(lowered)) {
        passed += 1;
        total += 1;
      } else if (["failed", "fail", "error"].includes(lowered)) {
        failed += 1;
        total += 1;
      } else if (["skipped", "pending", "todo", "disabled"].includes(lowered)) {
        skipped += 1;
        total += 1;
      }
    }
  }
  if (total === 0) return null;
  return { total, passed, failed, skipped };
};

const parseTestJsonSummary = (value: unknown): TestCounts | null => {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  let total =
    toNumber(obj.numTotalTests) ??
    toNumber(obj.totalTests) ??
    toNumber(obj.total) ??
    toNumber(obj.tests);
  let failed =
    toNumber(obj.numFailedTests) ??
    toNumber(obj.failedTests) ??
    toNumber(obj.failures) ??
    toNumber(obj.failed);
  let passed =
    toNumber(obj.numPassedTests) ??
    toNumber(obj.passedTests) ??
    toNumber(obj.passed);
  let skipped =
    toNumber(obj.numPendingTests) ??
    toNumber(obj.numSkippedTests) ??
    toNumber(obj.skippedTests) ??
    toNumber(obj.pending) ??
    toNumber(obj.skipped);
  const statusMetric = toBooleanMetric(obj.success ?? obj.ok ?? obj.status ?? obj.passed);

  if (total === undefined) {
    const assertionCounts = countAssertionResults(obj.testResults);
    if (assertionCounts) {
      total = assertionCounts.total;
      passed = passed ?? assertionCounts.passed;
      failed = failed ?? assertionCounts.failed;
      skipped = skipped ?? assertionCounts.skipped;
    }
  }

  if (total === undefined) {
    if (passed !== undefined || failed !== undefined || skipped !== undefined) {
      total = (passed ?? 0) + (failed ?? 0) + (skipped ?? 0);
    }
  }

  if (passed === undefined && total !== undefined && failed !== undefined) {
    passed = Math.max(0, total - failed - (skipped ?? 0));
  }

  const status =
    failed !== undefined && total !== undefined
      ? failed > 0
        ? "fail"
        : "pass"
      : statusMetric !== undefined
        ? statusMetric
          ? "pass"
          : "fail"
        : undefined;

  if (
    total === undefined &&
    failed === undefined &&
    passed === undefined &&
    skipped === undefined &&
    status === undefined
  ) {
    return null;
  }
  return { total, failed, passed, skipped, status };
};

const parseEslintSummary = (value: unknown): { errors: number; fatalErrors: number; warnings: number } | null => {
  const results = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray((value as { results?: unknown[] }).results)
      ? (value as { results: unknown[] }).results
      : null;
  if (!results) return null;
  let errors = 0;
  let fatalErrors = 0;
  let warnings = 0;
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    errors += toNumber(obj.errorCount) ?? 0;
    fatalErrors += toNumber(obj.fatalErrorCount) ?? 0;
    warnings += toNumber(obj.warningCount) ?? 0;
  }
  return { errors, fatalErrors, warnings };
};

const parseTscStatus = (raw: string): "pass" | "fail" | undefined => {
  const foundMatch = raw.match(/Found\s+(\d+)\s+errors?/i);
  if (foundMatch) {
    const count = Number(foundMatch[1]);
    if (Number.isFinite(count)) {
      return count > 0 ? "fail" : "pass";
    }
  }
  if (/Found\s+0\s+errors?/i.test(raw)) return "pass";
  if (/error\s+TS\d+/i.test(raw) || /\bTS\d+:/i.test(raw)) return "fail";
  return undefined;
};

const readJson = (filePath: string): unknown => {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const readText = (filePath: string): string | null => {
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
};

const mergeRepoTelemetry = (base?: RepoTelemetry, override?: RepoTelemetry): RepoTelemetry | undefined => {
  if (!base && !override) return undefined;
  const merged: RepoTelemetry = {
    ...(base ?? {}),
    ...(override ?? {}),
  };
  if (base?.build || override?.build) {
    merged.build = { ...(base?.build ?? {}), ...(override?.build ?? {}) };
  }
  if (base?.tests || override?.tests) {
    merged.tests = { ...(base?.tests ?? {}), ...(override?.tests ?? {}) };
  }
  if (base?.schema || override?.schema) {
    merged.schema = { ...(base?.schema ?? {}), ...(override?.schema ?? {}) };
  }
  if (base?.deps || override?.deps) {
    merged.deps = { ...(base?.deps ?? {}), ...(override?.deps ?? {}) };
  }
  if (base?.lint || override?.lint) {
    merged.lint = { ...(base?.lint ?? {}), ...(override?.lint ?? {}) };
  }
  if (base?.typecheck || override?.typecheck) {
    merged.typecheck = { ...(base?.typecheck ?? {}), ...(override?.typecheck ?? {}) };
  }
  if (base?.metrics || override?.metrics) {
    merged.metrics = { ...(base?.metrics ?? {}), ...(override?.metrics ?? {}) };
  }
  return merged;
};

const buildRepoTelemetryFromEnv = (): RepoTelemetry => {
  const env = process.env;
  const buildStatus = env.CASIMIR_BUILD_STATUS ?? env.CASIMIR_BUILD_OK;
  const buildExitCode = toNumber(env.CASIMIR_BUILD_EXIT_CODE);
  const buildDuration = toNumber(env.CASIMIR_BUILD_DURATION_MS);

  const testStatus = env.CASIMIR_TEST_STATUS ?? env.CASIMIR_TEST_OK;
  const testsFailed = toNumber(env.CASIMIR_TEST_FAILED);
  const testsPassed = toNumber(env.CASIMIR_TEST_PASSED);
  const testsTotal = toNumber(env.CASIMIR_TEST_TOTAL);

  const schemaContracts = env.CASIMIR_SCHEMA_CONTRACTS ?? env.CASIMIR_SCHEMA_OK;
  const depsCoherence = env.CASIMIR_DEPS_COHERENCE;

  const lintStatus = env.CASIMIR_LINT_STATUS;
  const typecheckStatus = env.CASIMIR_TYPECHECK_STATUS;
  const timeToGreenMs = toNumber(env.CASIMIR_TIME_TO_GREEN_MS);

  const metrics = (() => {
    const raw = env.CASIMIR_REPO_METRICS_JSON;
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  })();

  const telemetry: RepoTelemetry = {};
  if (buildStatus !== undefined || buildExitCode !== undefined || buildDuration !== undefined) {
    telemetry.build = {
      status: buildStatus,
      ok: toBooleanMetric(buildStatus),
      exitCode: buildExitCode,
      durationMs: buildDuration,
    };
  }
  if (testStatus !== undefined || testsFailed !== undefined || testsPassed !== undefined || testsTotal !== undefined) {
    telemetry.tests = {
      status: testStatus,
      ok: toBooleanMetric(testStatus),
      failed: testsFailed,
      passed: testsPassed,
      total: testsTotal,
    };
  }
  if (schemaContracts !== undefined) {
    telemetry.schema = {
      contracts: schemaContracts,
      ok: toBooleanMetric(schemaContracts),
    };
  }
  if (depsCoherence !== undefined) {
    telemetry.deps = {
      coherence: depsCoherence,
    };
  }
  if (lintStatus !== undefined) {
    telemetry.lint = { status: lintStatus };
  }
  if (typecheckStatus !== undefined) {
    telemetry.typecheck = { status: typecheckStatus };
  }
  if (timeToGreenMs !== undefined) {
    telemetry.timeToGreenMs = timeToGreenMs;
  }
  if (metrics) {
    telemetry.metrics = metrics;
  }
  return telemetry;
};

const buildRepoTelemetryFromReports = (): RepoTelemetry => {
  const telemetry: RepoTelemetry = {};
  const testJson = readJson(reportPaths.vitest);
  const testCounts = parseTestJsonSummary(testJson);
  if (testCounts) {
    telemetry.tests = {
      total: testCounts.total,
      failed: testCounts.failed,
      passed: testCounts.passed,
      status: testCounts.status,
    };
  }

  const eslintJson = readJson(reportPaths.eslint);
  const eslintTotals = parseEslintSummary(eslintJson);
  if (eslintTotals) {
    telemetry.lint = {
      status: eslintTotals.errors + eslintTotals.fatalErrors > 0 ? "fail" : "pass",
    };
  }

  const tscRaw = readText(reportPaths.tsc);
  if (tscRaw) {
    const status = parseTscStatus(tscRaw);
    if (status) {
      telemetry.typecheck = {
        status,
      };
    }
  }

  return telemetry;
};

const writeRepoTelemetry = (): void => {
  const fromReports = buildRepoTelemetryFromReports();
  const fromEnv = buildRepoTelemetryFromEnv();
  const existing = readJson(reportPaths.repoTelemetry);
  const existingRepo =
    existing && typeof existing === "object"
      ? ((existing as { repo?: RepoTelemetry }).repo ?? undefined)
      : undefined;
  const merged = mergeRepoTelemetry(
    mergeRepoTelemetry(existingRepo, fromReports),
    fromEnv,
  );
  const payload = {
    generatedAt: new Date().toISOString(),
    repo: merged ?? {},
  };
  ensureDir(reportPaths.repoTelemetry);
  fs.writeFileSync(
    reportPaths.repoTelemetry,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
};

const runStep = async (step: ReportStep): Promise<StepResult> => {
  if (step === "vitest") {
    const code = await runVitestReport();
    return { label: "vitest", code };
  }
  if (step === "eslint") {
    const code = await runEslintReport();
    return { label: "eslint", code };
  }
  if (step === "tsc") {
    const code = await runTscReport();
    return { label: "tsc", code };
  }
  writeRepoTelemetry();
  return { label: "repo-telemetry", code: 0 };
};

const main = async () => {
  const requested = parseArgs();
  const steps = requested.size > 0 ? ORDERED_STEPS.filter((step) => requested.has(step)) : ORDERED_STEPS;
  const results: StepResult[] = [];
  for (const step of steps) {
    results.push(await runStep(step));
  }
  const failing = results.find((result) => result.code !== 0);
  if (!failing) return;

  const allowFail =
    process.env.CI_REPORTS_ALLOW_FAIL === "1" ||
    process.env.CI_REPORTS_ALLOW_FAIL === "true" ||
    process.env.CASIMIR_REPORTS_ALLOW_FAIL === "1" ||
    process.env.CASIMIR_REPORTS_ALLOW_FAIL === "true";
  if (!allowFail) {
    process.exit(failing.code);
  }
};

main().catch((error) => {
  console.error("[ci-reports] failed:", error);
  process.exit(1);
});
