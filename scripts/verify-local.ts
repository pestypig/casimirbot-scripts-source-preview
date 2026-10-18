import { spawn, type SpawnOptions } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

type SpawnResult = {
  code: number;
};

const baseUrl = process.env.VERIFY_BASE_URL ?? "http://localhost:5050";
const packsUrl = new URL("/api/agi/constraint-packs", baseUrl).toString();
const adapterUrl = new URL("/api/agi/adapter/run", baseUrl).toString();
const traceOut = process.env.VERIFY_TRACE_OUT ?? "tmp/training-trace.jsonl";
const requestPath = process.env.VERIFY_REQUEST_PATH ?? "tmp/verify-local.json";
const traceLimit = process.env.VERIFY_TRACE_LIMIT ?? "200";
const skipMath = process.env.VERIFY_SKIP_MATH === "1";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const npmExecPath = process.env.npm_execpath;
const npmShell = process.platform === "win32";

const runCommand = (
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<SpawnResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1 }));
  });

const runNpm = (args: string[]): Promise<SpawnResult> => {
  if (npmExecPath) {
    return runCommand(process.execPath, [npmExecPath, ...args]);
  }
  return runCommand(npmCmd, args, { shell: npmShell });
};

const spawnNpm = (args: string[]) => {
  if (npmExecPath) {
    return spawn(process.execPath, [npmExecPath, ...args], { stdio: "inherit" });
  }
  return spawn(npmCmd, args, { stdio: "inherit", shell: npmShell });
};

const waitForServer = async (timeoutMs = 60000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(packsUrl);
      if (response.ok) {
        return true;
      }
    } catch {
      // ignore
    }
    await delay(1000);
  }
  return false;
};

const stopServer = async (child: ReturnType<typeof spawn>): Promise<void> =>
  new Promise((resolve) => {
    if (child.killed) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGINT");
  });

const writeVerifyPayload = async (): Promise<void> => {
  await mkdir("tmp", { recursive: true });
  const payload = {
    traceId: `local:pre-commit:${Date.now()}`,
    actions: [
      {
        id: "pre-commit-verify",
        params: {
          dutyEffectiveFR: 0.0025,
        },
      },
    ],
    budget: {
      maxIterations: 1,
      maxTotalMs: 60000,
    },
  };
  await writeFile(requestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const runVerification = async (): Promise<number> => {
  const helixCoreGuard = await runNpm(["run", "guard:helix-core-deprecated"]);
  if (helixCoreGuard.code !== 0) {
    return helixCoreGuard.code;
  }

  if (!skipMath) {
    const math = await runNpm(["run", "math:validate"]);
    if (math.code !== 0) {
      return math.code;
    }
  }

  let serverProcess: ReturnType<typeof spawn> | null = null;
  let startedServer = false;
  const cleanup = async () => {
    if (serverProcess) {
      await stopServer(serverProcess);
      serverProcess = null;
    }
  };

  const signals: Array<NodeJS.Signals> = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.on(signal, () => {
      void cleanup().finally(() => process.exit(1));
    });
  }

  try {
    const alreadyUp = await waitForServer(2000);
    if (!alreadyUp) {
      serverProcess = spawnNpm(["run", "dev:agi:5050"]);
      startedServer = true;
      const ready = await waitForServer();
      if (!ready) {
        return 1;
      }
    }

    await writeVerifyPayload();
    const verify = await runNpm([
      "run",
      "casimir:verify",
      "--",
      "--json",
      requestPath,
      "--trace-out",
      traceOut,
      "--trace-limit",
      traceLimit,
      "--url",
      adapterUrl,
    ]);
    return verify.code;
  } finally {
    if (startedServer && serverProcess) {
      await cleanup();
    }
  }
};

runVerification()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    console.error("[verify-local] failed:", error);
    process.exit(1);
  });
