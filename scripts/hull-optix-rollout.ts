import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const npmExecPath = process.env.npm_execpath;
const npmShell = process.platform === "win32";

type RolloutStatus = {
  ok: boolean;
  reasons: string[];
  service: {
    reachable: boolean;
    details?: unknown;
  };
  app: {
    reachable: boolean;
    strictProxy: boolean;
    scientificLaneReady: boolean;
    fallbackLaneActive: boolean;
    remoteConfigured: boolean;
    remoteEndpoint?: string | null;
    details?: unknown;
  };
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

const readEnv = (name: string, fallback: string): string => {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const has = (flag: string) => args.includes(flag);
  const read = (flag: string): string | null => {
    const idx = args.indexOf(flag);
    if (idx < 0 || idx + 1 >= args.length) return null;
    return args[idx + 1];
  };
  return {
    doctorOnly: has("--doctor-only"),
    skipLaunch: has("--skip-launch"),
    appScript: read("--app-script") ?? "dev:agi:5050",
    serviceScript: read("--service-script") ?? "hull:optix:service",
    appBaseUrl:
      read("--app-base-url") ?? readEnv("OPTIX_ROLLOUT_APP_BASE_URL", "http://127.0.0.1:5050"),
    serviceBaseUrl:
      read("--service-base-url") ??
      readEnv(
        "OPTIX_ROLLOUT_SERVICE_BASE_URL",
        readEnv("OPTIX_RENDER_SERVICE_URL", "http://127.0.0.1:6062"),
      ),
    timeoutMs: Math.max(10_000, Number(read("--timeout-ms") ?? "120000") || 120_000),
    provenancePrefix:
      read("--provenance-prefix") ??
      readEnv(
        "MIS_RENDER_REQUIRED_PROVENANCE_SOURCE_PREFIX",
        "optix/cuda",
      ),
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

const waitForUrl = async (url: string, timeoutMs: number): Promise<boolean> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await withTimeout(url, 3500);
      if (res.ok) return true;
    } catch {
      // ignore
    }
    await delay(1000);
  }
  return false;
};

const checkRollout = async (args: {
  appBaseUrl: string;
  serviceBaseUrl: string;
  expectedProvenancePrefix: string;
}): Promise<RolloutStatus> => {
  const reasons: string[] = [];
  const appStatusUrl = `${args.appBaseUrl.replace(/\/+$/, "")}/api/helix/hull-render/status`;
  const serviceStatusUrl = `${args.serviceBaseUrl.replace(/\/+$/, "")}/api/helix/hull-render/status`;
  const expectedFrameEndpoint = `${args.serviceBaseUrl.replace(/\/+$/, "")}/api/helix/hull-render/frame`;

  let servicePayload: Record<string, unknown> | null = null;
  let appPayload: Record<string, unknown> | null = null;
  let serviceReachable = false;
  let appReachable = false;

  try {
    const res = await withTimeout(serviceStatusUrl, 10_000);
    if (!res.ok) {
      reasons.push(`service_status_http_${res.status}`);
    } else {
      const json = (await res.json()) as unknown;
      if (isRecord(json)) {
        serviceReachable = true;
        servicePayload = json;
      } else {
        reasons.push("service_status_invalid_json");
      }
    }
  } catch {
    reasons.push("service_unreachable");
  }

  try {
    const res = await withTimeout(appStatusUrl, 10_000);
    if (!res.ok) {
      reasons.push(`app_status_http_${res.status}`);
    } else {
      const json = (await res.json()) as unknown;
      if (isRecord(json)) {
        appReachable = true;
        appPayload = json;
      } else {
        reasons.push("app_status_invalid_json");
      }
    }
  } catch {
    reasons.push("app_unreachable");
  }

  const strictProxy = appPayload?.strictProxy === true;
  const scientificLaneReady = appPayload?.scientificLaneReady === true;
  const fallbackLaneActive = appPayload?.fallbackLaneActive === true;
  const remoteConfigured = appPayload?.remoteConfigured === true;
  const remoteEndpoint =
    typeof appPayload?.remoteEndpoint === "string" ? appPayload.remoteEndpoint : null;
  const requiredProvenanceSourcePrefix =
    typeof appPayload?.requiredProvenanceSourcePrefix === "string"
      ? appPayload.requiredProvenanceSourcePrefix
      : typeof appPayload?.provenanceRequiredPrefix === "string"
        ? appPayload.provenanceRequiredPrefix
      : null;

  if (appReachable && !strictProxy) reasons.push("app_not_in_strict_proxy_mode");
  if (appReachable && !scientificLaneReady) reasons.push("app_scientific_lane_not_ready");
  if (appReachable && fallbackLaneActive) reasons.push("app_fallback_lane_active");
  if (appReachable && !remoteConfigured) reasons.push("app_remote_not_configured");
  if (appReachable && remoteEndpoint && remoteEndpoint !== expectedFrameEndpoint) {
    reasons.push("app_remote_endpoint_mismatch");
  }
  if (
    appReachable &&
    requiredProvenanceSourcePrefix &&
    args.expectedProvenancePrefix &&
    requiredProvenanceSourcePrefix !== args.expectedProvenancePrefix
  ) {
    reasons.push("app_provenance_prefix_mismatch");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    service: {
      reachable: serviceReachable,
      details: servicePayload,
    },
    app: {
      reachable: appReachable,
      strictProxy,
      scientificLaneReady,
      fallbackLaneActive,
      remoteConfigured,
      remoteEndpoint,
      details: appPayload,
    },
  };
};

const run = async (): Promise<number> => {
  const args = parseArgs();
  const strictEnv: NodeJS.ProcessEnv = {
    MIS_RENDER_SERVICE_URL: args.serviceBaseUrl,
    MIS_RENDER_BACKEND: "optix",
    MIS_RENDER_PROXY_STRICT: "1",
    MIS_RENDER_REQUIRE_SCIENTIFIC_FRAME: "1",
    MIS_RENDER_REQUIRE_INTEGRAL_SIGNAL: "1",
    MIS_RENDER_REQUIRED_PROVENANCE_SOURCE_PREFIX: args.provenancePrefix,
    OPTIX_RENDER_ALLOW_SYNTHETIC: "0",
    RAYTRACINGMIS_ALLOW_SYNTHETIC: "0",
  };

  if (args.doctorOnly) {
    const status = await checkRollout({
      appBaseUrl: args.appBaseUrl,
      serviceBaseUrl: args.serviceBaseUrl,
      expectedProvenancePrefix: args.provenancePrefix,
    });
    console.log("[hull-optix-rollout] doctor");
    console.log(JSON.stringify(status, null, 2));
    return status.ok ? 0 : 1;
  }

  if (args.skipLaunch) {
    const status = await checkRollout({
      appBaseUrl: args.appBaseUrl,
      serviceBaseUrl: args.serviceBaseUrl,
      expectedProvenancePrefix: args.provenancePrefix,
    });
    console.log("[hull-optix-rollout] status");
    console.log(JSON.stringify(status, null, 2));
    return status.ok ? 0 : 1;
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
    console.log("[hull-optix-rollout] starting OptiX service");
    serviceProcess = spawnNpm(["run", "-s", args.serviceScript], strictEnv);
    const serviceReady = await waitForUrl(
      `${args.serviceBaseUrl.replace(/\/+$/, "")}/api/helix/hull-render/status`,
      args.timeoutMs,
    );
    if (!serviceReady) {
      console.error("[hull-optix-rollout] service did not become ready");
      return 1;
    }

    const appHealthUrl = `${args.appBaseUrl.replace(/\/+$/, "")}/healthz`;
    const appAlreadyRunning = await waitForUrl(appHealthUrl, 2500);
    if (!appAlreadyRunning) {
      console.log(`[hull-optix-rollout] starting app (${args.appScript})`);
      appProcess = spawnNpm(["run", args.appScript], strictEnv);
      const appReady = await waitForUrl(appHealthUrl, args.timeoutMs);
      if (!appReady) {
        console.error("[hull-optix-rollout] app did not become ready");
        return 1;
      }
    } else {
      console.log(`[hull-optix-rollout] app already reachable at ${args.appBaseUrl}`);
    }

    const status = await checkRollout({
      appBaseUrl: args.appBaseUrl,
      serviceBaseUrl: args.serviceBaseUrl,
      expectedProvenancePrefix: args.provenancePrefix,
    });
    console.log("[hull-optix-rollout] status");
    console.log(JSON.stringify(status, null, 2));
    if (!status.ok) return 1;

    console.log(
      `[hull-optix-rollout] strict lane live. app=${args.appBaseUrl} service=${args.serviceBaseUrl}`,
    );
    console.log("[hull-optix-rollout] press Ctrl+C to stop");

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
    console.error("[hull-optix-rollout] failed:", error);
    process.exit(1);
  });
