import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  HullMisRenderRequestV1,
  HullMisRenderResponseV1,
} from "../shared/hull-render-contract";
import { runWarpRenderCongruenceBenchmark } from "./warp-render-congruence-benchmark";

type ScenarioId = "nhm2" | "mercury";
type SolveOrderStatus = "pass" | "warn" | "fail" | "unknown";

type CaptureEvent = {
  id: string;
  atMs: number;
  isoTime: string;
  level: "info" | "warn" | "error";
  category: "render_vs_metric_displacement";
  source: string;
  mode: number | null;
  rendererBackend: string | null;
  skyboxMode: string | null;
  expected: Record<string, number | null> | null;
  rendered: Record<string, number | null> | null;
  delta: Record<string, number | null> | null;
  measurements: Record<string, number | string | boolean | null> | null;
  note: string | null;
};

type IntegralSignalAttachmentSnapshot = {
  source: "mis-service-remote" | "mis-service-local-fallback";
  updatedAtMs: number;
  width: number;
  height: number;
  depthM: Float32Array;
  maskU8: Uint8Array;
  coveragePct: number | null;
  depthMinM: number | null;
  depthMaxM: number | null;
  depthMeanM: number | null;
  sampleCount: number;
  note: string | null;
};

type IntegralSignalComparison = {
  status: SolveOrderStatus;
  source: string | null;
  updatedAtMs: number | null;
  ageMs: number | null;
  coveragePct: number | null;
  depthMinM: number | null;
  depthMaxM: number | null;
  depthMeanM: number | null;
  fitScalePxPerM: number | null;
  fitZOffsetM: number | null;
  fitSign: number | null;
  rmsZResidualM: number | null;
  maxAbsZResidualM: number | null;
  hausdorffM: number | null;
  sampleCount: number | null;
  note: string | null;
};

type CaptureOptions = {
  baseUrl: string;
  scenarioIds: ScenarioId[];
  frames: number;
  width: number;
  height: number;
  timeoutMs: number;
  outJsonlPath: string;
  latestJsonlPath: string;
  summaryJsonPath: string;
  latestSummaryPath: string;
  framesDir: string;
  writeFrames: boolean;
  attachmentDownsample: number;
  requireProxy: boolean;
  strict: boolean;
  runBenchmark: boolean;
};

type ScenarioContext = {
  frameIndex: number;
  frameCount: number;
  width: number;
  height: number;
  attachmentDownsample: number;
  baseUrl: string;
};

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const FULL_SOLVE_DIR = path.join("artifacts", "research", "full-solve");
const DEFAULT_BASE_URL = "http://127.0.0.1:5050";
const DEFAULT_OUT_JSONL = path.join(
  FULL_SOLVE_DIR,
  `alcubierre-debug-log-command-${RUN_STAMP}.jsonl`,
);
const DEFAULT_LATEST_JSONL = path.join(
  FULL_SOLVE_DIR,
  "alcubierre-debug-log-latest.jsonl",
);
const DEFAULT_SUMMARY_JSON = path.join(
  FULL_SOLVE_DIR,
  `render-command-capture-${DATE_STAMP}.json`,
);
const DEFAULT_LATEST_SUMMARY_JSON = path.join(
  FULL_SOLVE_DIR,
  "render-command-capture-latest.json",
);
const DEFAULT_FRAMES_DIR = path.join(
  FULL_SOLVE_DIR,
  `render-command-frames-${RUN_STAMP}`,
);

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes("=")) return argv[index].split("=", 2)[1];
  return argv[index + 1];
};

const hasFlag = (flag: string, argv = process.argv.slice(2)): boolean =>
  argv.some((value) => value === flag);

const toFiniteNumber = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const toInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const numeric = Math.round(toFiniteNumber(value, fallback));
  return numeric < min ? min : numeric > max ? max : numeric;
};

const ensureDirForFile = (filePath: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");

const joinUrl = (baseUrl: string, endpoint: string): string =>
  `${normalizeBaseUrl(baseUrl)}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const safeJsonParse = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text.trim().length) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

const withTimeoutFetch = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const isValidAttachment = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.kind !== "depth-linear-m-f32le" && value.kind !== "shell-mask-u8") return false;
  if (value.encoding !== "base64") return false;
  if (typeof value.dataBase64 !== "string" || value.dataBase64.length === 0) return false;
  if (typeof value.width !== "number" || typeof value.height !== "number") return false;
  return true;
};

const isValidFrameResponse = (value: unknown): value is HullMisRenderResponseV1 => {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (value.ok !== true && value.ok !== false) return false;
  if (typeof value.imageDataUrl !== "string" || value.imageDataUrl.length === 0) return false;
  if (value.imageMime !== "image/png") return false;
  if (typeof value.width !== "number" || typeof value.height !== "number") return false;
  if (value.attachments != null) {
    if (!Array.isArray(value.attachments)) return false;
    if (!(value.attachments as unknown[]).every((attachment) => isValidAttachment(attachment))) return false;
  }
  return true;
};

const parseScenarioIds = (raw: string | undefined): ScenarioId[] => {
  const input = (raw ?? "nhm2")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  if (input.length === 0 || input.includes("all")) {
    return ["nhm2", "mercury"];
  }
  const out: ScenarioId[] = [];
  for (const value of input) {
    if (value === "nhm2" || value === "mercury") {
      out.push(value);
      continue;
    }
    throw new Error(`Unknown scenario: ${value}. Allowed: nhm2, mercury, all`);
  }
  return [...new Set(out)];
};

const parseOptions = (): CaptureOptions => {
  const argv = process.argv.slice(2);
  const scenarioIds = parseScenarioIds(readArgValue("--scenario", argv));
  return {
    baseUrl: readArgValue("--base-url", argv) ?? DEFAULT_BASE_URL,
    scenarioIds,
    frames: toInt(readArgValue("--frames", argv), 12, 1, 180),
    width: toInt(readArgValue("--width", argv), 1280, 320, 4096),
    height: toInt(readArgValue("--height", argv), 720, 180, 4096),
    timeoutMs: toInt(readArgValue("--timeout-ms", argv), 45_000, 2_000, 300_000),
    outJsonlPath: readArgValue("--out-jsonl", argv) ?? DEFAULT_OUT_JSONL,
    latestJsonlPath: readArgValue("--latest-jsonl", argv) ?? DEFAULT_LATEST_JSONL,
    summaryJsonPath: readArgValue("--summary-json", argv) ?? DEFAULT_SUMMARY_JSON,
    latestSummaryPath: readArgValue("--latest-summary-json", argv) ?? DEFAULT_LATEST_SUMMARY_JSON,
    framesDir: readArgValue("--frames-dir", argv) ?? DEFAULT_FRAMES_DIR,
    writeFrames: !hasFlag("--no-frames", argv),
    attachmentDownsample: toInt(readArgValue("--attachment-downsample", argv), 2, 1, 8),
    requireProxy: hasFlag("--require-proxy", argv),
    strict: hasFlag("--strict", argv),
    runBenchmark: !hasFlag("--no-benchmark", argv),
  };
};

const buildScenarioPayload = (
  scenarioId: ScenarioId,
  context: ScenarioContext,
): HullMisRenderRequestV1 => {
  type MetricRefSourceParams = {
    dutyFR?: number;
    q?: number;
    gammaGeo?: number;
    gammaVdB?: number;
    zeta?: number;
    phase01?: number;
    metricT00?: number;
    metricT00Source?: string;
    metricT00Ref?: string;
  };
  const metricRefFor = (
    dims: [number, number, number],
    time_s: number,
    dt_s: number,
    source: string,
    chart: string,
    requireCongruentSolve: boolean,
    sourceParams?: MetricRefSourceParams,
  ): NonNullable<HullMisRenderRequestV1["metricVolumeRef"]> => {
    const params = new URLSearchParams();
    params.set("dims", `${dims[0]}x${dims[1]}x${dims[2]}`);
    params.set("time_s", String(time_s));
    params.set("dt_s", String(dt_s));
    params.set("steps", "1");
    params.set("includeExtra", "1");
    params.set("includeKij", "1");
    params.set("includeMatter", "1");
    if (requireCongruentSolve) {
      params.set("requireCongruentSolve", "1");
      params.set("requireNhm2CongruentFullSolve", "1");
    }
    if (sourceParams) {
      if (Number.isFinite(sourceParams.dutyFR)) params.set("dutyFR", String(sourceParams.dutyFR));
      if (Number.isFinite(sourceParams.q)) params.set("q", String(sourceParams.q));
      if (Number.isFinite(sourceParams.gammaGeo)) params.set("gammaGeo", String(sourceParams.gammaGeo));
      if (Number.isFinite(sourceParams.gammaVdB)) params.set("gammaVdB", String(sourceParams.gammaVdB));
      if (Number.isFinite(sourceParams.zeta)) params.set("zeta", String(sourceParams.zeta));
      if (Number.isFinite(sourceParams.phase01)) params.set("phase01", String(sourceParams.phase01));
      if (Number.isFinite(sourceParams.metricT00)) params.set("metricT00", String(sourceParams.metricT00));
      if (typeof sourceParams.metricT00Source === "string" && sourceParams.metricT00Source.length > 0) {
        params.set("metricT00Source", sourceParams.metricT00Source);
      }
      if (typeof sourceParams.metricT00Ref === "string" && sourceParams.metricT00Ref.length > 0) {
        params.set("metricT00Ref", sourceParams.metricT00Ref);
      }
    }
    params.set("format", "raw");
    const url = `${normalizeBaseUrl(context.baseUrl)}/api/helix/gr-evolve-brick?${params.toString()}`;
    const sourceSig =
      sourceParams != null
        ? [
            Number.isFinite(sourceParams.dutyFR) ? `duty=${sourceParams.dutyFR}` : "duty=none",
            Number.isFinite(sourceParams.q) ? `q=${sourceParams.q}` : "q=none",
            Number.isFinite(sourceParams.gammaGeo) ? `gammaGeo=${sourceParams.gammaGeo}` : "gammaGeo=none",
            Number.isFinite(sourceParams.gammaVdB) ? `gammaVdB=${sourceParams.gammaVdB}` : "gammaVdB=none",
            Number.isFinite(sourceParams.zeta) ? `zeta=${sourceParams.zeta}` : "zeta=none",
            Number.isFinite(sourceParams.phase01) ? `phase01=${sourceParams.phase01}` : "phase01=none",
            Number.isFinite(sourceParams.metricT00) ? `metricT00=${sourceParams.metricT00}` : "metricT00=none",
            sourceParams.metricT00Source ? `metricT00Source=${sourceParams.metricT00Source}` : "metricT00Source=none",
            sourceParams.metricT00Ref ? `metricT00Ref=${sourceParams.metricT00Ref}` : "metricT00Ref=none",
          ].join(",")
        : "source=none";
    return {
      kind: "gr-evolve-brick",
      url,
      source,
      chart,
      dims,
      updatedAt: Date.now(),
      hash: `${source}|${chart}|${dims.join("x")}|${time_s}|${dt_s}|${sourceSig}`,
    };
  };
  const progress = context.frameCount <= 1 ? 0 : context.frameIndex / (context.frameCount - 1);
  if (scenarioId === "nhm2") {
    const beta = 0.05 + 0.32 * progress;
    const sigma = 5.8 + 0.8 * Math.sin(Math.PI * progress);
    const radius = 1.0 + 0.09 * Math.cos(Math.PI * progress * 2);
    const dims: [number, number, number] = [48, 48, 48];
    const time_s = progress;
    const dt_s = 0.01;
    const sourceParams: MetricRefSourceParams = {
      dutyFR: 0.0015 + 0.0002 * Math.sin(Math.PI * 2 * progress),
      q: 3,
      gammaGeo: 26,
      gammaVdB: 500,
      zeta: 0.84,
      phase01: progress,
      metricT00Source: "metric",
      metricT00Ref: "warp.metric.T00.natario_sdf.shift",
    };
    return {
      version: 1,
      requestId: `capture-${scenarioId}-${context.frameIndex + 1}`,
      width: context.width,
      height: context.height,
      dpr: 1,
      backendHint: "mis-path-tracing",
      timestampMs: Date.now(),
      skyboxMode: "geodesic",
      scienceLane: {
        requireIntegralSignal: true,
        requireScientificFrame: true,
        requireCanonicalTensorVolume: true,
        minVolumeDims: [32, 32, 32],
        samplingMode: "trilinear",
        renderView: "transport-3p1",
        attachmentDownsample: context.attachmentDownsample,
      },
      solve: {
        beta,
        alpha: 1,
        sigma,
        R: radius,
        chart: "comoving_cartesian",
      },
      geodesicDiagnostics: {
        mode: "full-3+1-christoffel",
        consistency: "ok",
        maxNullResidual: 2.2e-3 + 2.5e-4 * Math.sin(Math.PI * 2 * progress),
        stepConvergence: 0.94 - 0.01 * Math.cos(Math.PI * progress),
        bundleSpread: 0.12 + 0.02 * Math.sin(Math.PI * progress),
      },
      metricSummary: {
        source: "warp.nhm2.command.capture",
        chart: "comoving_cartesian",
        dims,
        alphaRange: [1, 1],
        consistency: "ok",
        updatedAt: Date.now(),
      },
      metricVolumeRef: metricRefFor(
        dims,
        time_s,
        dt_s,
        "warp.nhm2.command.capture",
        "comoving_cartesian",
        true,
        sourceParams,
      ),
    };
  }

  const beta = 0.0014 + 0.0009 * Math.sin(Math.PI * 2 * progress);
  const radius = 0.42 + 0.03 * Math.cos(Math.PI * 2 * progress);
  const dims: [number, number, number] = [36, 36, 36];
  const time_s = progress;
  const dt_s = 0.01;
  const sourceParams: MetricRefSourceParams = {
    dutyFR: 0.0012,
    q: 1.2,
    gammaGeo: 8,
    gammaVdB: 12,
    zeta: 0.82,
    phase01: progress,
    metricT00Source: "teaching_proxy",
    metricT00Ref: "mercury.precession.teaching.proxy",
  };
  return {
    version: 1,
    requestId: `capture-${scenarioId}-${context.frameIndex + 1}`,
    width: context.width,
    height: context.height,
    dpr: 1,
    backendHint: "mis-path-tracing",
    timestampMs: Date.now(),
    skyboxMode: "flat",
    scienceLane: {
      requireIntegralSignal: true,
      requireCanonicalTensorVolume: false,
      minVolumeDims: [24, 24, 24],
      samplingMode: "trilinear",
      renderView: "diagnostic-quad",
      attachmentDownsample: context.attachmentDownsample,
    },
    solve: {
      beta,
      alpha: 1,
      sigma: 8.5,
      R: radius,
      chart: "schwarzschild_teaching",
    },
    geodesicDiagnostics: {
      mode: "flat-background",
      consistency: "ok",
      maxNullResidual: 7.5e-4 + 1.5e-4 * Math.sin(Math.PI * 2 * progress),
      stepConvergence: 0.97,
      bundleSpread: 0.08 + 0.01 * Math.cos(Math.PI * 2 * progress),
    },
    metricSummary: {
      source: "gr.mercury.teaching.capture",
      chart: "schwarzschild_teaching",
      dims,
      alphaRange: [1, 1],
      consistency: "ok",
      updatedAt: Date.now(),
    },
    metricVolumeRef: metricRefFor(
      dims,
      time_s,
      dt_s,
      "gr.mercury.teaching.capture",
      "schwarzschild_teaching",
      false,
      sourceParams,
    ),
  };
};

const deriveMetricRadii = (payload: HullMisRenderRequestV1): [number, number, number] => {
  const radius = Math.max(1e-3, toFiniteNumber(payload.solve?.R, 1));
  return [radius, radius, radius];
};

const decodePngDataUrl = (dataUrl: string): Buffer | null => {
  const match = /^data:image\/png;base64,(.+)$/i.exec(dataUrl);
  if (!match) return null;
  try {
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
};

const decodeF32FromBase64 = (raw: string, expectedSamples: number): Float32Array | null => {
  try {
    const buffer = Buffer.from(raw, "base64");
    if (buffer.length < expectedSamples * 4) return null;
    const out = new Float32Array(expectedSamples);
    for (let i = 0; i < expectedSamples; i += 1) out[i] = buffer.readFloatLE(i * 4);
    return out;
  } catch {
    return null;
  }
};

const decodeU8FromBase64 = (raw: string, expectedSamples: number): Uint8Array | null => {
  try {
    const buffer = Buffer.from(raw, "base64");
    if (buffer.length < expectedSamples) return null;
    return new Uint8Array(buffer.subarray(0, expectedSamples));
  } catch {
    return null;
  }
};

const extractIntegralSignalAttachmentSnapshot = (
  frame: HullMisRenderResponseV1,
): IntegralSignalAttachmentSnapshot | null => {
  const attachments = Array.isArray(frame.attachments) ? frame.attachments : [];
  const depthAttachment = attachments.find(
    (entry) => entry.kind === "depth-linear-m-f32le" && entry.encoding === "base64",
  );
  const maskAttachment = attachments.find(
    (entry) => entry.kind === "shell-mask-u8" && entry.encoding === "base64",
  );
  if (!depthAttachment || !maskAttachment) return null;
  const width = Math.max(1, Math.floor(toFiniteNumber(depthAttachment.width, 0)));
  const height = Math.max(1, Math.floor(toFiniteNumber(depthAttachment.height, 0)));
  if (
    width !== Math.max(1, Math.floor(toFiniteNumber(maskAttachment.width, 0))) ||
    height !== Math.max(1, Math.floor(toFiniteNumber(maskAttachment.height, 0)))
  ) {
    return null;
  }

  const total = width * height;
  const depthM = decodeF32FromBase64(depthAttachment.dataBase64, total);
  const maskU8 = decodeU8FromBase64(maskAttachment.dataBase64, total);
  if (!depthM || !maskU8) return null;

  let maskCount = 0;
  let finiteDepthCount = 0;
  let depthMin = Number.POSITIVE_INFINITY;
  let depthMax = Number.NEGATIVE_INFINITY;
  let depthSum = 0;
  for (let i = 0; i < total; i += 1) {
    if (maskU8[i] > 0) maskCount += 1;
    const value = Number(depthM[i]);
    if (!Number.isFinite(value)) continue;
    finiteDepthCount += 1;
    depthMin = Math.min(depthMin, value);
    depthMax = Math.max(depthMax, value);
    depthSum += value;
  }

  return {
    source: frame.backend === "proxy" ? "mis-service-remote" : "mis-service-local-fallback",
    updatedAtMs: Date.now(),
    width,
    height,
    depthM,
    maskU8,
    coveragePct: total > 0 ? (maskCount / total) * 100 : null,
    depthMinM: finiteDepthCount > 0 ? depthMin : null,
    depthMaxM: finiteDepthCount > 0 ? depthMax : null,
    depthMeanM: finiteDepthCount > 0 ? depthSum / finiteDepthCount : null,
    sampleCount: maskCount,
    note: "integral signal from depth-linear-m + shell-mask attachments",
  };
};

const approximateHausdorff = (
  a: Array<[number, number, number]>,
  b: Array<[number, number, number]>,
): number | null => {
  if (a.length === 0 || b.length === 0) return null;
  const sample = (points: Array<[number, number, number]>, maxN: number) => {
    if (points.length <= maxN) return points;
    const stride = points.length / maxN;
    const out: Array<[number, number, number]> = [];
    for (let i = 0; i < maxN; i += 1) out.push(points[Math.floor(i * stride)]);
    return out;
  };
  const aS = sample(a, 220);
  const bS = sample(b, 220);
  const directed = (src: Array<[number, number, number]>, dst: Array<[number, number, number]>) => {
    let maxMin = 0;
    for (const p of src) {
      let minDist = Number.POSITIVE_INFINITY;
      for (const q of dst) {
        const dx = p[0] - q[0];
        const dy = p[1] - q[1];
        const dz = p[2] - q[2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < minDist) minDist = dist;
      }
      if (minDist > maxMin) maxMin = minDist;
    }
    return maxMin;
  };
  return Math.max(directed(aS, bS), directed(bS, aS));
};

const compareIntegralSignalToMetric = (opts: {
  signal: IntegralSignalAttachmentSnapshot | null;
  metricRadiusM: [number, number, number];
}): IntegralSignalComparison => {
  const signal = opts.signal;
  const rx = Number(opts.metricRadiusM[0]);
  const ry = Number(opts.metricRadiusM[1]);
  const rz = Number(opts.metricRadiusM[2]);
  if (!signal) {
    return {
      status: "unknown",
      source: null,
      updatedAtMs: null,
      ageMs: null,
      coveragePct: null,
      depthMinM: null,
      depthMaxM: null,
      depthMeanM: null,
      fitScalePxPerM: null,
      fitZOffsetM: null,
      fitSign: null,
      rmsZResidualM: null,
      maxAbsZResidualM: null,
      hausdorffM: null,
      sampleCount: null,
      note: "integral signal unavailable",
    };
  }
  if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rz) || rx <= 1e-9 || ry <= 1e-9 || rz <= 1e-9) {
    return {
      status: "unknown",
      source: signal.source,
      updatedAtMs: signal.updatedAtMs,
      ageMs: Math.max(0, Date.now() - signal.updatedAtMs),
      coveragePct: signal.coveragePct,
      depthMinM: signal.depthMinM,
      depthMaxM: signal.depthMaxM,
      depthMeanM: signal.depthMeanM,
      fitScalePxPerM: null,
      fitZOffsetM: null,
      fitSign: null,
      rmsZResidualM: null,
      maxAbsZResidualM: null,
      hausdorffM: null,
      sampleCount: signal.sampleCount,
      note: "metric radii unavailable for integral comparison",
    };
  }
  const width = signal.width;
  const height = signal.height;
  const cx = Math.max(1, (width - 1) * 0.5);
  const cy = Math.max(1, (height - 1) * 0.5);
  const total = width * height;
  const initialStride = Math.max(1, Math.floor(Math.sqrt(total / 2200)));
  const sampleObserved = (stride: number) => {
    const points: Array<{ xn: number; yn: number; depth: number }> = [];
    let maxX = 0;
    let maxY = 0;
    for (let y = 0; y < height; y += stride) {
      for (let x = 0; x < width; x += stride) {
        const idx = y * width + x;
        if ((signal.maskU8[idx] ?? 0) <= 0) continue;
        const depth = Number(signal.depthM[idx]);
        if (!Number.isFinite(depth)) continue;
        const xn = (x - cx) / cx;
        const yn = (y - cy) / cy;
        points.push({ xn, yn, depth });
        maxX = Math.max(maxX, Math.abs(xn));
        maxY = Math.max(maxY, Math.abs(yn));
      }
    }
    return { points, maxX, maxY };
  };

  let stride = initialStride;
  let sampled = sampleObserved(stride);
  if (sampled.points.length < 80 || sampled.maxX < 1e-4 || sampled.maxY < 1e-4) {
    stride = Math.max(1, Math.floor(initialStride * 0.5));
    sampled = sampleObserved(stride);
  }
  if (sampled.points.length < 80 || sampled.maxX < 1e-4 || sampled.maxY < 1e-4) {
    stride = 1;
    sampled = sampleObserved(stride);
  }
  const observed = sampled.points;
  const maxAbsX = sampled.maxX;
  const maxAbsY = sampled.maxY;
  if (observed.length < 80 || maxAbsX < 1e-4 || maxAbsY < 1e-4) {
    return {
      status: "unknown",
      source: signal.source,
      updatedAtMs: signal.updatedAtMs,
      ageMs: Math.max(0, Date.now() - signal.updatedAtMs),
      coveragePct: signal.coveragePct,
      depthMinM: signal.depthMinM,
      depthMaxM: signal.depthMaxM,
      depthMeanM: signal.depthMeanM,
      fitScalePxPerM: null,
      fitZOffsetM: null,
      fitSign: null,
      rmsZResidualM: null,
      maxAbsZResidualM: null,
      hausdorffM: null,
      sampleCount: observed.length,
      note: "integral signal has insufficient mask samples",
    };
  }

  const k0 = Math.min(rx / maxAbsX, ry / maxAbsY);
  const kMin = Math.max(1e-4, 0.45 * k0);
  const kMax = Math.max(kMin * 1.05, 1.55 * k0);
  let best:
    | { rms: number; maxAbs: number; k: number; z0: number; sign: number; valid: number }
    | null = null;
  for (let i = 0; i <= 44; i += 1) {
    const t = i / 44;
    const k = kMin + (kMax - kMin) * t;
    for (const sign of [-1, 1] as const) {
      let sumZ0 = 0;
      let valid = 0;
      const wCache: number[] = [];
      const dCache: number[] = [];
      for (const point of observed) {
        const q = 1 - Math.pow((k * point.xn) / rx, 2) - Math.pow((k * point.yn) / ry, 2);
        if (q < 0) continue;
        const w = Math.sqrt(Math.max(0, q));
        wCache.push(w);
        dCache.push(point.depth);
        sumZ0 += point.depth - sign * rz * w;
        valid += 1;
      }
      if (valid < 60) continue;
      const z0 = sumZ0 / valid;
      let sq = 0;
      let maxAbs = 0;
      for (let j = 0; j < valid; j += 1) {
        const residual = dCache[j] - (z0 + sign * rz * wCache[j]);
        sq += residual * residual;
        maxAbs = Math.max(maxAbs, Math.abs(residual));
      }
      const rms = Math.sqrt(sq / valid);
      if (!best || rms < best.rms) best = { rms, maxAbs, k, z0, sign, valid };
    }
  }
  if (!best) {
    return {
      status: "fail",
      source: signal.source,
      updatedAtMs: signal.updatedAtMs,
      ageMs: Math.max(0, Date.now() - signal.updatedAtMs),
      coveragePct: signal.coveragePct,
      depthMinM: signal.depthMinM,
      depthMaxM: signal.depthMaxM,
      depthMeanM: signal.depthMeanM,
      fitScalePxPerM: null,
      fitZOffsetM: null,
      fitSign: null,
      rmsZResidualM: null,
      maxAbsZResidualM: null,
      hausdorffM: null,
      sampleCount: observed.length,
      note: "integral fit failed (no valid shell overlap)",
    };
  }

  const obsPoints: Array<[number, number, number]> = [];
  for (const point of observed) {
    const q = 1 - Math.pow((best.k * point.xn) / rx, 2) - Math.pow((best.k * point.yn) / ry, 2);
    if (q < 0) continue;
    obsPoints.push([best.k * point.xn, best.k * point.yn, point.depth - best.z0]);
  }
  const expectedPoints: Array<[number, number, number]> = [];
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const xn = (x - cx) / cx;
      const yn = (y - cy) / cy;
      const q = 1 - Math.pow((best.k * xn) / rx, 2) - Math.pow((best.k * yn) / ry, 2);
      if (q < 0) continue;
      expectedPoints.push([best.k * xn, best.k * yn, best.sign * rz * Math.sqrt(Math.max(0, q))]);
    }
  }

  const hausdorff = approximateHausdorff(obsPoints, expectedPoints);
  const pxPerM = ((cx + cy) * 0.5) / Math.max(best.k, 1e-9);
  const passRms = Math.max(0.08 * rz, 0.12);
  const warnRms = Math.max(0.24 * rz, 0.45);
  const passHausdorff = Math.max(0.3 * rz, 0.5);
  const warnHausdorff = Math.max(0.8 * rz, 1.25);

  const status: SolveOrderStatus =
    best.rms <= passRms &&
    best.maxAbs <= passRms * 2.2 &&
    (hausdorff == null || hausdorff <= passHausdorff)
      ? "pass"
      : best.rms <= warnRms &&
          best.maxAbs <= warnRms * 2.1 &&
          (hausdorff == null || hausdorff <= warnHausdorff)
        ? "warn"
        : "fail";

  return {
    status,
    source: signal.source,
    updatedAtMs: signal.updatedAtMs,
    ageMs: Math.max(0, Date.now() - signal.updatedAtMs),
    coveragePct: signal.coveragePct,
    depthMinM: signal.depthMinM,
    depthMaxM: signal.depthMaxM,
    depthMeanM: signal.depthMeanM,
    fitScalePxPerM: Number.isFinite(pxPerM) ? pxPerM : null,
    fitZOffsetM: best.z0,
    fitSign: best.sign,
    rmsZResidualM: best.rms,
    maxAbsZResidualM: best.maxAbs,
    hausdorffM: hausdorff,
    sampleCount: best.valid,
    note: `${signal.note ?? "integral signal"} | fit over depth+mask only`,
  };
};

const estimateRenderedRadiusFromMask = (
  signal: IntegralSignalAttachmentSnapshot | null,
  fitScalePxPerM: number | null,
): [number | null, number | null] => {
  if (!signal || !Number.isFinite(fitScalePxPerM as number) || (fitScalePxPerM as number) <= 1e-9) {
    return [null, null];
  }
  const width = signal.width;
  const height = signal.height;
  const cx = Math.max(1, (width - 1) * 0.5);
  const cy = Math.max(1, (height - 1) * 0.5);
  let maxAbsPxX = 0;
  let maxAbsPxY = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      if ((signal.maskU8[idx] ?? 0) <= 0) continue;
      maxAbsPxX = Math.max(maxAbsPxX, Math.abs(x - cx));
      maxAbsPxY = Math.max(maxAbsPxY, Math.abs(y - cy));
    }
  }
  if (maxAbsPxX <= 0 || maxAbsPxY <= 0) return [null, null];
  const scale = Number(fitScalePxPerM);
  return [maxAbsPxX / scale, maxAbsPxY / scale];
};

const formatNumber = (value: number | null): number | null =>
  Number.isFinite(value as number) ? Number(value) : null;

const requestFrame = async (
  baseUrl: string,
  payload: HullMisRenderRequestV1,
  timeoutMs: number,
): Promise<HullMisRenderResponseV1> => {
  const url = joinUrl(baseUrl, "/api/helix/hull-render/frame");
  const response = await withTimeoutFetch(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );
  const json = await safeJsonParse(response);
  if (!response.ok) throw new Error(`frame_request_http_${response.status}: ${JSON.stringify(json)}`);
  if (!isValidFrameResponse(json)) throw new Error("frame_request_invalid_shape");
  return json;
};

const fetchStatus = async (baseUrl: string, timeoutMs: number): Promise<Record<string, unknown>> => {
  const url = joinUrl(baseUrl, "/api/helix/hull-render/status");
  const response = await withTimeoutFetch(
    url,
    { method: "GET", headers: { Accept: "application/json" } },
    timeoutMs,
  );
  const json = await safeJsonParse(response);
  if (!response.ok) throw new Error(`status_http_${response.status}: ${JSON.stringify(json)}`);
  if (!isRecord(json)) throw new Error("status_invalid_shape");
  return json;
};

const writeFramePng = (
  framesDir: string,
  scenarioId: ScenarioId,
  frameIndex: number,
  dataUrl: string,
): string => {
  const png = decodePngDataUrl(dataUrl);
  if (!png) throw new Error("invalid_png_data_url");
  const scenarioDir = path.join(framesDir, scenarioId);
  ensureDir(scenarioDir);
  const filePath = path.join(scenarioDir, `frame-${String(frameIndex + 1).padStart(4, "0")}.png`);
  fs.writeFileSync(filePath, png);
  return filePath;
};

const makeCaptureEvent = (args: {
  scenarioId: ScenarioId;
  frameIndex: number;
  frameCount: number;
  payload: HullMisRenderRequestV1;
  frame: HullMisRenderResponseV1;
  signal: IntegralSignalAttachmentSnapshot | null;
  comparison: IntegralSignalComparison;
  metricRadiusM: [number, number, number];
}): CaptureEvent => {
  const atMs = Date.now();
  const [metricRx, metricRy, metricRz] = args.metricRadiusM;
  const [renderedRx, renderedRy] = estimateRenderedRadiusFromMask(
    args.signal,
    args.comparison.fitScalePxPerM,
  );
  const deltaX = renderedRx != null ? renderedRx - metricRx : null;
  const deltaY = renderedRy != null ? renderedRy - metricRy : null;
  const noteParts = [
    args.comparison.note,
    typeof args.frame.diagnostics?.note === "string" ? args.frame.diagnostics.note : null,
    args.scenarioId === "mercury"
      ? "teaching-lane visualization only; physical Mercury parity is validated in integrity suite"
      : null,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  return {
    id: `capture-${args.scenarioId}-${args.frameIndex + 1}-${atMs.toString(36)}`,
    atMs,
    isoTime: new Date(atMs).toISOString(),
    level: args.comparison.status === "fail" ? "warn" : "info",
    category: "render_vs_metric_displacement",
    source: "alcubierre.command-capture",
    mode: 3,
    rendererBackend: "mis-service",
    skyboxMode: args.payload.skyboxMode ?? null,
    expected: {
      metric_radius_x_m: formatNumber(metricRx),
      metric_radius_y_m: formatNumber(metricRy),
      metric_radius_z_m: formatNumber(metricRz),
    },
    rendered: {
      rendered_radius_x_m: formatNumber(renderedRx),
      rendered_radius_y_m: formatNumber(renderedRy),
      rendered_radius_z_m: null,
      worldtube_radius_m: formatNumber(toFiniteNumber(args.payload.solve?.R, NaN)),
      depth_min_m: formatNumber(args.signal?.depthMinM ?? null),
      depth_max_m: formatNumber(args.signal?.depthMaxM ?? null),
      depth_mean_m: formatNumber(args.signal?.depthMeanM ?? null),
    },
    delta: {
      delta_x_m: formatNumber(deltaX),
      delta_y_m: formatNumber(deltaY),
      delta_z_m: null,
      delta_x_pct:
        renderedRx != null && Math.abs(metricRx) > 1e-9 ? ((renderedRx - metricRx) / metricRx) * 100 : null,
      delta_y_pct:
        renderedRy != null && Math.abs(metricRy) > 1e-9 ? ((renderedRy - metricRy) / metricRy) * 100 : null,
      delta_z_pct: null,
      rms_delta_m: null,
      rms_delta_pct: null,
      max_abs_delta_m: null,
      worldtube_delta_m: null,
      rms_z_residual_m: formatNumber(args.comparison.rmsZResidualM),
      max_abs_z_residual_m: formatNumber(args.comparison.maxAbsZResidualM),
      hausdorff_m: formatNumber(args.comparison.hausdorffM),
      fit_z_offset_m: formatNumber(args.comparison.fitZOffsetM),
    },
    measurements: {
      displacementStatus: args.comparison.status,
      analyticStatus: "unknown",
      integralStatus: args.comparison.status,
      metricChannel: "command_capture_radius",
      chart: args.payload.solve?.chart ?? args.payload.metricSummary?.chart ?? "unknown",
      coordinateMap: "comoving_cartesian",
      samplingPoints: args.comparison.sampleCount,
      integralSource: args.comparison.source ?? "none",
      integralCoveragePct: args.comparison.coveragePct,
      integralAgeMs: args.comparison.ageMs,
      fitScalePxPerM: args.comparison.fitScalePxPerM,
      fitSign: args.comparison.fitSign,
      integralSampleCount: args.comparison.sampleCount,
      scenario: args.scenarioId,
      frameIndex: args.frameIndex + 1,
      frameCount: args.frameCount,
      backend: args.frame.backend,
      renderMs: args.frame.renderMs,
      consistency:
        args.frame.diagnostics?.consistency ??
        args.payload.geodesicDiagnostics?.consistency ??
        "unknown",
    },
    note: noteParts.length ? noteParts.join(" | ") : null,
  };
};

const runCapture = async (options: CaptureOptions) => {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const status = await fetchStatus(baseUrl, options.timeoutMs);
  const events: CaptureEvent[] = [];
  const frameArtifacts: Array<{
    scenario: ScenarioId;
    frameIndex: number;
    backend: string;
    renderMs: number;
    framePath: string | null;
    status: SolveOrderStatus;
  }> = [];
  const statusCounts: Record<SolveOrderStatus, number> = {
    pass: 0,
    warn: 0,
    fail: 0,
    unknown: 0,
  };
  const backendCounts: Record<string, number> = {};

  if (options.writeFrames) ensureDir(options.framesDir);

  for (const scenarioId of options.scenarioIds) {
    for (let frameIndex = 0; frameIndex < options.frames; frameIndex += 1) {
      const payload = buildScenarioPayload(scenarioId, {
        frameIndex,
        frameCount: options.frames,
        width: options.width,
        height: options.height,
        attachmentDownsample: options.attachmentDownsample,
        baseUrl,
      });
      const frame = await requestFrame(baseUrl, payload, options.timeoutMs);
      if (options.requireProxy && frame.backend !== "proxy") {
        throw new Error(
          `require-proxy violated for ${scenarioId} frame ${frameIndex + 1}: backend=${frame.backend}`,
        );
      }
      const signal = extractIntegralSignalAttachmentSnapshot(frame);
      const metricRadiusM = deriveMetricRadii(payload);
      const comparison = compareIntegralSignalToMetric({ signal, metricRadiusM });
      statusCounts[comparison.status] += 1;
      backendCounts[frame.backend] = (backendCounts[frame.backend] ?? 0) + 1;

      const event = makeCaptureEvent({
        scenarioId,
        frameIndex,
        frameCount: options.frames,
        payload,
        frame,
        signal,
        comparison,
        metricRadiusM,
      });
      events.push(event);

      const framePath = options.writeFrames
        ? writeFramePng(options.framesDir, scenarioId, frameIndex, frame.imageDataUrl)
        : null;
      frameArtifacts.push({
        scenario: scenarioId,
        frameIndex: frameIndex + 1,
        backend: frame.backend,
        renderMs: frame.renderMs,
        framePath,
        status: comparison.status,
      });

      process.stdout.write(
        `[warp-render:capture] ${scenarioId} frame ${String(frameIndex + 1).padStart(3, "0")}/${String(options.frames).padStart(3, "0")} backend=${frame.backend} status=${comparison.status} renderMs=${frame.renderMs}\n`,
      );
    }
  }

  const outJsonlPath = path.resolve(options.outJsonlPath);
  const latestJsonlPath = path.resolve(options.latestJsonlPath);
  ensureDirForFile(outJsonlPath);
  ensureDirForFile(latestJsonlPath);
  const jsonlPayload = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  fs.writeFileSync(outJsonlPath, jsonlPayload);
  if (outJsonlPath !== latestJsonlPath) fs.writeFileSync(latestJsonlPath, jsonlPayload);

  let benchmark: ReturnType<typeof runWarpRenderCongruenceBenchmark> | null = null;
  if (options.runBenchmark) {
    benchmark = runWarpRenderCongruenceBenchmark({
      debugLogPath: outJsonlPath,
      minEvents: Math.max(1, Math.min(6, events.length)),
    });
  }

  const summary = {
    artifactType: "warp_render_command_capture/v1",
    generatedOn: DATE_STAMP,
    generatedAt: new Date().toISOString(),
    baseUrl,
    scenarioIds: options.scenarioIds,
    frameCountPerScenario: options.frames,
    totalFramesRequested: events.length,
    renderStatus: { statusCounts, backendCounts },
    outputs: {
      outJsonlPath: path.relative(process.cwd(), outJsonlPath).replace(/\\/g, "/"),
      latestJsonlPath: path.relative(process.cwd(), latestJsonlPath).replace(/\\/g, "/"),
      framesDir: options.writeFrames
        ? path.relative(process.cwd(), options.framesDir).replace(/\\/g, "/")
        : null,
      summaryJsonPath: path.relative(process.cwd(), options.summaryJsonPath).replace(/\\/g, "/"),
      latestSummaryPath: path.relative(process.cwd(), options.latestSummaryPath).replace(/\\/g, "/"),
    },
    statusSnapshot: status,
    benchmark,
    frameArtifacts: frameArtifacts.slice(-120),
    note:
      "Command capture writes benchmark-compatible render_vs_metric_displacement events. Mercury scenario is a teaching-lane visual proxy; physical parity is still checked in integrity suite.",
  };

  const summaryJsonPath = path.resolve(options.summaryJsonPath);
  const latestSummaryPath = path.resolve(options.latestSummaryPath);
  ensureDirForFile(summaryJsonPath);
  ensureDirForFile(latestSummaryPath);
  fs.writeFileSync(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  if (summaryJsonPath !== latestSummaryPath) {
    fs.writeFileSync(latestSummaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  }

  const ok =
    events.length > 0 &&
    (options.strict
      ? benchmark
        ? benchmark.overallVerdict === "PASS" &&
          statusCounts.fail === 0 &&
          statusCounts.unknown === 0
        : statusCounts.fail === 0 && statusCounts.unknown === 0
      : true);

  return {
    ok,
    totalEvents: events.length,
    statusCounts,
    backendCounts,
    outJsonlPath,
    latestJsonlPath,
    summaryJsonPath,
    latestSummaryPath,
    benchmark,
  };
};

const isEntryPoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  const options = parseOptions();
  runCapture(options)
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) process.exit(1);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[warp-render:capture] failed: ${message}\n`);
      process.exit(1);
    });
}
