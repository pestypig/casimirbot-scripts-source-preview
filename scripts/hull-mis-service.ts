import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import sharp from "sharp";
import type {
  HullMisRenderRequestV1,
  HullMisRenderResponseV1,
} from "../shared/hull-render-contract";

type RuntimeStatus = {
  unityEditorPath: string | null;
  projectPath: string;
  scenePath: string;
  executeMethod: string;
  timeoutMs: number;
  allowSynthetic: boolean;
  unityConfigured: boolean;
  unityExecutableExists: boolean;
  projectExists: boolean;
  bridgeInstalled: boolean;
  sceneExists: boolean;
  readyForUnity: boolean;
};

const DEFAULT_SERVICE_HOST = "127.0.0.1";
const DEFAULT_SERVICE_PORT = 6061;
const DEFAULT_UNITY_METHOD = "CasimirBot.HullRenderBridge.RenderFromCli";
const DEFAULT_SCENE = "Assets/Scenes/CornellBox2.unity";
const DEFAULT_TIMEOUT_MS = 90_000;

const clamp = (value: number, min: number, max: number) =>
  value < min ? min : value > max ? max : value;

const toFiniteNumber = (value: unknown, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toInt = (value: unknown, fallback: number, min: number, max: number) =>
  clamp(Math.round(toFiniteNumber(value, fallback)), min, max);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const toByte = (value: number) => clamp(Math.round(value), 0, 255);

const readTuple3 = (
  value: unknown,
  fallback: [number, number, number],
): [number, number, number] => {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  return [
    toFiniteNumber(value[0], fallback[0]),
    toFiniteNumber(value[1], fallback[1]),
    toFiniteNumber(value[2], fallback[2]),
  ];
};

const encodePngDataUrl = (png: Buffer) =>
  `data:image/png;base64,${png.toString("base64")}`;

const readEnv = (name: string) => {
  const raw = process.env[name];
  if (!raw) return null;
  const value = raw.trim();
  return value.length ? value : null;
};

const readEnvFlag = (name: string, fallback = false) => {
  const value = readEnv(name);
  if (!value) return fallback;
  return value === "1" || value.toLowerCase() === "true";
};

const hashSeed = (payload: HullMisRenderRequestV1): number => {
  const text = JSON.stringify({
    requestId: payload.requestId ?? "",
    width: payload.width,
    height: payload.height,
    skyboxMode: payload.skyboxMode ?? "off",
    beta: payload.solve?.beta ?? 0,
    alpha: payload.solve?.alpha ?? 1,
    sigma: payload.solve?.sigma ?? 6,
    R: payload.solve?.R ?? 1,
    chart: payload.solve?.chart ?? "",
    consistency: payload.geodesicDiagnostics?.consistency ?? "unknown",
    nullResidual: payload.geodesicDiagnostics?.maxNullResidual ?? 0,
    stepConv: payload.geodesicDiagnostics?.stepConvergence ?? 0,
    spread: payload.geodesicDiagnostics?.bundleSpread ?? 0,
    ts: payload.timestampMs ?? 0,
  });
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

const parseRequest = (body: unknown): HullMisRenderRequestV1 => {
  const src = isRecord(body) ? body : {};
  const solve = isRecord(src.solve) ? src.solve : {};
  const diag = isRecord(src.geodesicDiagnostics) ? src.geodesicDiagnostics : {};
  const metric = isRecord(src.metricSummary) ? src.metricSummary : {};

  return {
    version: 1,
    requestId: typeof src.requestId === "string" ? src.requestId : undefined,
    width: toInt(src.width, 1280, 320, 2048),
    height: toInt(src.height, 720, 180, 2048),
    dpr: clamp(toFiniteNumber(src.dpr, 1), 0.5, 3),
    backendHint:
      src.backendHint === "mis-path-tracing" ? "mis-path-tracing" : undefined,
    timestampMs: toFiniteNumber(src.timestampMs, Date.now()),
    skyboxMode:
      src.skyboxMode === "flat" || src.skyboxMode === "geodesic"
        ? src.skyboxMode
        : "off",
    solve: {
      beta: toFiniteNumber(solve.beta, 0),
      alpha: Math.max(1e-6, toFiniteNumber(solve.alpha, 1)),
      sigma: Math.max(1e-3, toFiniteNumber(solve.sigma, 6)),
      R: Math.max(1e-3, toFiniteNumber(solve.R, 1)),
      chart: typeof solve.chart === "string" ? solve.chart : null,
    },
    geodesicDiagnostics: {
      mode: typeof diag.mode === "string" ? diag.mode : null,
      consistency:
        diag.consistency === "ok" ||
        diag.consistency === "warn" ||
        diag.consistency === "fail"
          ? diag.consistency
          : "unknown",
      maxNullResidual:
        diag.maxNullResidual == null
          ? null
          : toFiniteNumber(diag.maxNullResidual, 0),
      stepConvergence:
        diag.stepConvergence == null
          ? null
          : toFiniteNumber(diag.stepConvergence, 0),
      bundleSpread:
        diag.bundleSpread == null ? null : toFiniteNumber(diag.bundleSpread, 0),
    },
    metricSummary: {
      source: typeof metric.source === "string" ? metric.source : null,
      chart: typeof metric.chart === "string" ? metric.chart : null,
      dims: readTuple3(metric.dims, [1, 1, 1]),
      alphaRange: readTuple3(metric.alphaRange, [1, 1, 1]).slice(
        0,
        2,
      ) as [number, number],
      consistency:
        metric.consistency === "ok" ||
        metric.consistency === "warn" ||
        metric.consistency === "fail"
          ? metric.consistency
          : "unknown",
      updatedAt:
        metric.updatedAt == null ? null : toFiniteNumber(metric.updatedAt, Date.now()),
    },
  };
};

const getRuntimeStatus = (): RuntimeStatus => {
  const unityEditorPath =
    readEnv("RAYTRACINGMIS_UNITY_EDITOR") || readEnv("UNITY_EDITOR_PATH");
  const projectPath = path.resolve(
    process.cwd(),
    readEnv("RAYTRACINGMIS_PROJECT_DIR") || "external/RayTracingMIS",
  );
  const scenePath = readEnv("RAYTRACINGMIS_SCENE") || DEFAULT_SCENE;
  const executeMethod = readEnv("RAYTRACINGMIS_EXECUTE_METHOD") || DEFAULT_UNITY_METHOD;
  const timeoutMs = Math.max(
    5_000,
    toInt(readEnv("RAYTRACINGMIS_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS, 5_000, 300_000),
  );
  const allowSynthetic = readEnvFlag("RAYTRACINGMIS_ALLOW_SYNTHETIC", false);

  const bridgePath = path.resolve(
    projectPath,
    "Assets/Scripts/CasimirBot/HullRenderBridge.cs",
  );
  const sceneAbsolutePath = path.resolve(projectPath, scenePath);
  const unityExecutableExists = !!unityEditorPath && existsSync(unityEditorPath);
  const projectExists = existsSync(projectPath);
  const bridgeInstalled = existsSync(bridgePath);
  const sceneExists = existsSync(sceneAbsolutePath);

  return {
    unityEditorPath,
    projectPath,
    scenePath,
    executeMethod,
    timeoutMs,
    allowSynthetic,
    unityConfigured: !!unityEditorPath,
    unityExecutableExists,
    projectExists,
    bridgeInstalled,
    sceneExists,
    readyForUnity:
      unityExecutableExists && projectExists && bridgeInstalled && sceneExists,
  };
};

async function renderSyntheticFrame(
  payload: HullMisRenderRequestV1,
  deterministicSeed: number,
): Promise<Buffer> {
  const width = payload.width;
  const height = payload.height;
  const image = Buffer.alloc(width * height * 4, 0);

  const beta = toFiniteNumber(payload.solve?.beta, 0);
  const alpha = Math.max(1e-6, toFiniteNumber(payload.solve?.alpha, 1));
  const sigma = Math.max(1e-3, toFiniteNumber(payload.solve?.sigma, 6));
  const radius = Math.max(1e-3, toFiniteNumber(payload.solve?.R, 1));
  const seededPhase = (deterministicSeed % 4096) * (Math.PI / 2048);

  for (let y = 0; y < height; y += 1) {
    const v = height > 1 ? y / (height - 1) : 0;
    const ny = v * 2 - 1;
    for (let x = 0; x < width; x += 1) {
      const u = width > 1 ? x / (width - 1) : 0;
      const nx = u * 2 - 1;
      const r = Math.sqrt(nx * nx + ny * ny);
      const theta = Math.atan2(ny, nx);
      const shell = Math.exp(-Math.pow(r - (0.32 + 0.05 * Math.tanh(beta)), 2) * (8 + sigma));
      const tube = Math.exp(
        -Math.pow(nx * nx / Math.max(radius * radius, 0.2) + ny * ny / 0.6, 1.15),
      );
      const swirl = 0.5 + 0.5 * Math.sin(10 * theta + 9 * r + seededPhase + beta - 0.3 * alpha);
      const brightness = clamp(0.16 + 0.76 * shell + 0.38 * tube, 0, 1);

      const red = toByte(255 * clamp(brightness * (0.38 + 0.72 * swirl), 0, 1));
      const green = toByte(255 * clamp(brightness * (0.22 + 0.66 * (1 - swirl)), 0, 1));
      const blue = toByte(255 * clamp(brightness * (0.42 + 0.5 * Math.cos(2.5 * theta)), 0, 1));

      const idx = (y * width + x) * 4;
      image[idx] = red;
      image[idx + 1] = green;
      image[idx + 2] = blue;
      image[idx + 3] = 255;
    }
  }

  return sharp(image, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
}

async function runUnityBatchRender(
  payload: HullMisRenderRequestV1,
  runtime: RuntimeStatus,
  deterministicSeed: number,
) {
  if (!runtime.unityEditorPath) {
    throw new Error("unity_editor_not_configured");
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "casimirbot-mis-"));
  const requestPath = path.join(tempDir, "request.json");
  const outputPath = path.join(tempDir, "frame.png");
  const logLines: string[] = [];

  try {
    await writeFile(requestPath, JSON.stringify(payload), "utf8");

    const args = [
      "-batchmode",
      "-nographics",
      "-quit",
      "-projectPath",
      runtime.projectPath,
      "-executeMethod",
      runtime.executeMethod,
      "-cbRequest",
      requestPath,
      "-cbOutput",
      outputPath,
      "-cbScene",
      runtime.scenePath,
      "-cbSeed",
      String(deterministicSeed),
      "-logFile",
      "-",
    ];

    const result = await new Promise<{ code: number }>((resolve, reject) => {
      const child = spawn(runtime.unityEditorPath as string, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const appendLog = (chunk: Buffer | string) => {
        const text = String(chunk).trim();
        if (!text.length) return;
        const lines = text.split(/\r?\n/).filter((line) => line.length);
        for (const line of lines) {
          logLines.push(line);
          if (logLines.length > 200) logLines.shift();
        }
      };

      child.stdout?.on("data", appendLog);
      child.stderr?.on("data", appendLog);

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`unity_batch_timeout_ms_${runtime.timeoutMs}`));
      }, runtime.timeoutMs);

      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve({ code: code ?? -1 });
      });
    });

    if (result.code !== 0) {
      throw new Error(
        `unity_batch_exit_${result.code}: ${logLines.slice(-8).join(" | ")}`,
      );
    }

    const png = await readFile(outputPath);
    if (!png.length) throw new Error("unity_batch_empty_output");
    return { png, logs: logLines.slice(-40) };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/api/helix/hull-render/status", (_req, res) => {
  const runtime = getRuntimeStatus();
  res.json({
    kind: "raytracingmis-service-status",
    backendHint: "mis-path-tracing",
    service: "RayTracingMIS-UnityBatch",
    runtime,
    timestampMs: Date.now(),
  });
});

app.post("/api/helix/hull-render/frame", async (req, res) => {
  const startedAt = Date.now();
  const payload = parseRequest(req.body);
  const deterministicSeed = hashSeed(payload);
  const runtime = getRuntimeStatus();

  if (runtime.readyForUnity) {
    try {
      const { png, logs } = await runUnityBatchRender(payload, runtime, deterministicSeed);
      const response: HullMisRenderResponseV1 = {
        version: 1,
        ok: true,
        backend: "proxy",
        imageMime: "image/png",
        imageDataUrl: encodePngDataUrl(png),
        width: payload.width,
        height: payload.height,
        deterministicSeed,
        renderMs: Date.now() - startedAt,
        diagnostics: {
          note: "raytracingmis_unity_batch",
          geodesicMode: payload.geodesicDiagnostics?.mode ?? null,
          consistency: payload.geodesicDiagnostics?.consistency ?? "unknown",
          maxNullResidual: payload.geodesicDiagnostics?.maxNullResidual ?? null,
          stepConvergence: payload.geodesicDiagnostics?.stepConvergence ?? null,
          bundleSpread: payload.geodesicDiagnostics?.bundleSpread ?? null,
        },
        provenance: {
          source: "raytracingmis.unity.batch",
          serviceUrl: null,
          timestampMs: Date.now(),
        },
      };
      return res.json({
        ...response,
        logsTail: logs,
      });
    } catch (error) {
      if (!runtime.allowSynthetic) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(502).json({
          error: "unity_render_failed",
          message,
          runtime,
        });
      }
    }
  } else if (!runtime.allowSynthetic) {
    return res.status(503).json({
      error: "unity_not_ready",
      message:
        "RayTracingMIS service is not fully configured. Install bridge and configure Unity editor path.",
      runtime,
    });
  }

  const png = await renderSyntheticFrame(payload, deterministicSeed);
  const response: HullMisRenderResponseV1 = {
    version: 1,
    ok: true,
    backend: "local-deterministic",
    imageMime: "image/png",
    imageDataUrl: encodePngDataUrl(png),
    width: payload.width,
    height: payload.height,
    deterministicSeed,
    renderMs: Date.now() - startedAt,
    diagnostics: {
      note: "synthetic_fallback_for_service_debug",
      geodesicMode: payload.geodesicDiagnostics?.mode ?? null,
      consistency: payload.geodesicDiagnostics?.consistency ?? "unknown",
      maxNullResidual: payload.geodesicDiagnostics?.maxNullResidual ?? null,
      stepConvergence: payload.geodesicDiagnostics?.stepConvergence ?? null,
      bundleSpread: payload.geodesicDiagnostics?.bundleSpread ?? null,
    },
    provenance: {
      source: "raytracingmis.synthetic.fallback",
      serviceUrl: null,
      timestampMs: Date.now(),
    },
  };
  return res.json(response);
});

const host = readEnv("MIS_RENDER_SERVICE_HOST") || DEFAULT_SERVICE_HOST;
const configuredPort = toInt(
  readEnv("MIS_RENDER_SERVICE_PORT"),
  DEFAULT_SERVICE_PORT,
  1,
  65535,
);
const port = configuredPort < 1024 ? DEFAULT_SERVICE_PORT : configuredPort;

app.listen(port, host, () => {
  console.log(
    JSON.stringify(
      {
        kind: "hull-mis-service-started",
        host,
        port,
        statusEndpoint: `http://${host}:${port}/api/helix/hull-render/status`,
        frameEndpoint: `http://${host}:${port}/api/helix/hull-render/frame`,
      },
      null,
      2,
    ),
  );
});
