import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const npmExecPath = process.env.npm_execpath;
const npmShell = process.platform === "win32";

type SpawnResult = {
  code: number;
};

type RolloutStatus = {
  ok: boolean;
  service: {
    reachable: boolean;
    readyForUnity: boolean;
    allowSynthetic: boolean;
    details?: unknown;
  };
  app: {
    reachable: boolean;
    scientificLaneReady: boolean;
    fallbackLaneActive: boolean;
    remoteConfigured: boolean;
    remoteEndpoint?: string | null;
    details?: unknown;
  };
  reasons: string[];
};

const withTimeout = async (
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const runCommand = (
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  useShell = npmShell,
): Promise<SpawnResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: useShell,
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1 }));
  });

const runNpm = (args: string[], env?: NodeJS.ProcessEnv) => {
  if (npmExecPath) {
    return runCommand(process.execPath, [npmExecPath, ...args], env, false);
  }
  return runCommand(npmCmd, args, env, npmShell);
};

const spawnNpm = (args: string[], env?: NodeJS.ProcessEnv) => {
  if (npmExecPath) {
    return spawn(process.execPath, [npmExecPath, ...args], {
      stdio: "inherit",
      shell: false,
      env: env ? { ...process.env, ...env } : process.env,
    });
  }
  return spawn(npmCmd, args, {
    stdio: "inherit",
    shell: npmShell,
    env: env ? { ...process.env, ...env } : process.env,
  });
};

const readEnv = (name: string, fallback: string) => {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const has = (flag: string) => args.includes(flag);
  const read = (flag: string): string | null => {
    const index = args.indexOf(flag);
    if (index < 0 || index + 1 >= args.length) return null;
    return args[index + 1];
  };
  return {
    skipPrepare: has("--skip-prepare"),
    doctorOnly: has("--doctor-only"),
    requireUnityReady: !has("--allow-unity-not-ready"),
    appScript: read("--app-script") ?? "dev:agi:5050",
    appBaseUrl:
      read("--app-base-url") ?? readEnv("HULL_MIS_APP_BASE_URL", "http://127.0.0.1:5050"),
    timeoutMs: Math.max(10_000, Number(read("--timeout-ms") ?? "120000") || 120_000),
  };
};

const stopChild = async (child: ChildProcess | null): Promise<void> =>
  new Promise((resolve) => {
    if (!child || child.killed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGINT");
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const checkRollout = async (
  appBaseUrl: string,
  serviceBaseUrl: string,
  requireUnityReady: boolean,
  expectedServiceBaseUrl: string,
): Promise<RolloutStatus> => {
  const reasons: string[] = [];
  const serviceStatusUrl = `${serviceBaseUrl.replace(/\/+$/, "")}/api/helix/hull-render/status`;
  const appStatusUrl = `${appBaseUrl.replace(/\/+$/, "")}/api/helix/hull-render/status`;

  let servicePayload: Record<string, unknown> | null = null;
  let appPayload: Record<string, unknown> | null = null;

  let serviceReachable = false;
  try {
    const res = await withTimeout(serviceStatusUrl, 10_000);
    if (!res.ok) {
      reasons.push(`service_status_http_${res.status}`);
    } else {
      const json = (await res.json()) as unknown;
      if (isRecord(json)) {
        servicePayload = json;
        serviceReachable = true;
      } else {
        reasons.push("service_status_invalid_json");
      }
    }
  } catch {
    reasons.push("service_unreachable");
  }

  let appReachable = false;
  try {
    const res = await withTimeout(appStatusUrl, 10_000);
    if (!res.ok) {
      reasons.push(`app_status_http_${res.status}`);
    } else {
      const json = (await res.json()) as unknown;
      if (isRecord(json)) {
        appPayload = json;
        appReachable = true;
      } else {
        reasons.push("app_status_invalid_json");
      }
    }
  } catch {
    reasons.push("app_unreachable");
  }

  const runtime = isRecord(servicePayload?.runtime)
    ? (servicePayload.runtime as Record<string, unknown>)
    : null;
  const readyForUnity = runtime?.readyForUnity === true;
  const allowSynthetic = runtime?.allowSynthetic === true;

  if (serviceReachable && requireUnityReady && !readyForUnity) {
    reasons.push("unity_not_ready_for_scientific_lane");
  }
  if (serviceReachable && allowSynthetic) {
    reasons.push("synthetic_fallback_enabled_not_scientific");
  }

  const scientificLaneReady = appPayload?.scientificLaneReady === true;
  const fallbackLaneActive = appPayload?.fallbackLaneActive === true;
  const remoteConfigured = appPayload?.remoteConfigured === true;
  const remoteEndpoint =
    typeof appPayload?.remoteEndpoint === "string"
      ? appPayload.remoteEndpoint
      : null;
  const expectedFrameEndpoint = `${expectedServiceBaseUrl.replace(
    /\/+$/,
    "",
  )}/api/helix/hull-render/frame`;

  if (appReachable && !scientificLaneReady) reasons.push("app_scientific_lane_not_ready");
  if (appReachable && fallbackLaneActive) reasons.push("app_fallback_lane_active");
  if (appReachable && !remoteConfigured) reasons.push("app_remote_not_configured");
  if (
    appReachable &&
    remoteConfigured &&
    remoteEndpoint &&
    remoteEndpoint !== expectedFrameEndpoint
  ) {
    reasons.push("app_remote_endpoint_mismatch");
  }

  return {
    ok: reasons.length === 0,
    service: {
      reachable: serviceReachable,
      readyForUnity,
      allowSynthetic,
      details: servicePayload,
    },
    app: {
      reachable: appReachable,
      scientificLaneReady,
      fallbackLaneActive,
      remoteConfigured,
      remoteEndpoint,
      details: appPayload,
    },
    reasons,
  };
};

const waitForUrl = async (url: string, timeoutMs: number): Promise<boolean> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await withTimeout(url, 3_500);
      if (res.ok) return true;
    } catch {
      // ignore
    }
    await delay(1_000);
  }
  return false;
};

const run = async (): Promise<number> => {
  const args = parseArgs();
  const serviceHost = readEnv("MIS_RENDER_SERVICE_HOST", "127.0.0.1");
  const servicePort = readEnv("MIS_RENDER_SERVICE_PORT", "6061");
  const serviceBaseUrl = `http://${serviceHost}:${servicePort}`;
  const appBaseUrl = args.appBaseUrl;

  const strictEnv: NodeJS.ProcessEnv = {
    MIS_RENDER_SERVICE_HOST: serviceHost,
    MIS_RENDER_SERVICE_PORT: servicePort,
    MIS_RENDER_SERVICE_URL: readEnv("MIS_RENDER_SERVICE_URL", serviceBaseUrl),
    MIS_RENDER_PROXY_STRICT: readEnv("MIS_RENDER_PROXY_STRICT", "1"),
    RAYTRACINGMIS_ALLOW_SYNTHETIC: readEnv("RAYTRACINGMIS_ALLOW_SYNTHETIC", "0"),
  };

  const serviceStatusUrl = `${serviceBaseUrl}/api/helix/hull-render/status`;
  const appHealthUrl = `${appBaseUrl.replace(/\/+$/, "")}/healthz`;
  const expectedServiceBaseUrl = strictEnv.MIS_RENDER_SERVICE_URL as string;

  if (args.doctorOnly) {
    const status = await checkRollout(
      appBaseUrl,
      serviceBaseUrl,
      args.requireUnityReady,
      expectedServiceBaseUrl,
    );
    console.log("[hull-mis-rollout] doctor");
    console.log(JSON.stringify(status, null, 2));
    return status.ok ? 0 : 1;
  }

  if (!args.skipPrepare) {
    console.log("[hull-mis-rollout] running prepare");
    const prepare = await runNpm(["run", "hull:mis:prepare"], strictEnv);
    if (prepare.code !== 0) return prepare.code;
  }

  let serviceProcess: ChildProcess | null = null;
  let appProcess: ChildProcess | null = null;

  const cleanup = async () => {
    await stopChild(appProcess);
    await stopChild(serviceProcess);
    appProcess = null;
    serviceProcess = null;
  };

  const signalHandler = async () => {
    await cleanup();
    process.exit(130);
  };
  process.on("SIGINT", () => {
    void signalHandler();
  });
  process.on("SIGTERM", () => {
    void signalHandler();
  });

  try {
    console.log("[hull-mis-rollout] starting MIS service");
    serviceProcess = spawnNpm(["run", "-s", "hull:mis:service"], strictEnv);

    const serviceReady = await waitForUrl(serviceStatusUrl, args.timeoutMs);
    if (!serviceReady) {
      console.error(`[hull-mis-rollout] service did not become ready: ${serviceStatusUrl}`);
      return 1;
    }

    const appAlreadyRunning = await waitForUrl(appHealthUrl, 2_500);
    if (appAlreadyRunning) {
      console.log(
        `[hull-mis-rollout] app already reachable at ${appBaseUrl}; validating existing process`,
      );
    } else {
      console.log(`[hull-mis-rollout] starting app (${args.appScript})`);
      appProcess = spawnNpm(["run", args.appScript], strictEnv);

      const appReady = await waitForUrl(appHealthUrl, args.timeoutMs);
      if (!appReady) {
        console.error(`[hull-mis-rollout] app did not become ready: ${appHealthUrl}`);
        return 1;
      }
    }

    const status = await checkRollout(
      appBaseUrl,
      serviceBaseUrl,
      args.requireUnityReady,
      expectedServiceBaseUrl,
    );
    console.log("[hull-mis-rollout] status");
    console.log(JSON.stringify(status, null, 2));
    if (!status.ok) {
      return 1;
    }

    console.log(
      `[hull-mis-rollout] strict lane live. app=${appBaseUrl} service=${serviceBaseUrl}`,
    );
    console.log("[hull-mis-rollout] press Ctrl+C to stop");

    await new Promise<void>((resolve) => {
      const onExit = () => resolve();
      appProcess?.once("exit", onExit);
      serviceProcess?.once("exit", onExit);
    });

    return 1;
  } finally {
    await cleanup();
  }
};

run()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("[hull-mis-rollout] failed:", error);
    process.exit(1);
  });
