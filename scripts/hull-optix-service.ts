import express from "express";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type {
  HullScientificAtlasPaneId,
  HullScientificAtlasSidecarV1,
  HullRenderCertificateV1,
  HullMetricVolumeRefV1,
  HullMisRenderAttachmentV1,
  HullMisRenderRequestV1,
  HullMisRenderResponseV1,
  HullScientificRenderView,
  HullScientificSamplingMode,
  HullSupportMaskKind,
} from "../shared/hull-render-contract";
import {
  HULL_CANONICAL_GAMMA_OFFDIAGONAL_CHANNELS,
  HULL_CANONICAL_REQUIRED_CHANNELS_BASE,
  HULL_RENDER_CERTIFICATE_SCHEMA_VERSION,
  HULL_SCIENTIFIC_ATLAS_PANES,
} from "../shared/hull-render-contract";
import {
  YORK_DIAGNOSTIC_ALTERNATE_LANE_ID,
  YORK_DIAGNOSTIC_LANE_CONVENTIONS,
  computeYorkDiagnosticLaneField,
  isYorkDiagnosticLaneId,
  normalizeYorkDiagnosticLaneId,
  type YorkDiagnosticLaneId,
  type YorkDiagnosticObserverConstructionInfo,
} from "../shared/york-diagnostic-lanes";

type HullSupportChannelName = "hull_sdf" | "tile_support_mask" | "region_class";

const HULL_SUPPORT_CHANNELS: HullSupportChannelName[] = [
  "hull_sdf",
  "tile_support_mask",
  "region_class",
];

type HullSupportProjection = {
  kind: HullSupportMaskKind;
  channels: HullSupportChannelName[];
  width: number;
  height: number;
  data: Float32Array;
  signedHullSdf: Float32Array | null;
  coveragePct: number;
  maskedOutPct: number;
};

type RuntimeStatus = {
  host: string;
  port: number;
  serviceMode: "optix-tensor-pass1";
  allowSynthetic: boolean;
  readyForUnity: boolean;
  readyForOptix: boolean;
  readyForScientificLane: boolean;
  optixConfigured: boolean;
  cudaConfigured: boolean;
  optixSdkPath: string | null;
  cudaPath: string | null;
  metricRefBaseUrl: string | null;
  serviceVersion: string | null;
  buildHash: string | null;
  commitSha: string | null;
  processStartedAtMs: number;
  runtimeInstanceId: string;
};

type GrBrickChannel = {
  data: Float32Array;
  min: number;
  max: number;
};

type GrBrickDecoded = {
  dims: [number, number, number];
  voxelSize_m: [number, number, number];
  channels: Record<string, GrBrickChannel>;
  source: string | null;
  chart: string | null;
};

type MetricBrickCacheEntry = {
  brick: GrBrickDecoded;
  expiresAtMs: number;
};

type TensorGeodesicDiagnostics = {
  maxNullResidual: number;
  stepConvergence: number;
  bundleSpread: number;
  consistency: "ok" | "warn" | "fail" | "unknown";
};

type TensorRenderContext = {
  metricSource: string | null;
  chart: string | null;
  metricChannel: string;
  metricRadiiM: [number, number, number];
  anisotropy: [number, number, number];
  supportProjection: HullSupportProjection | null;
  supportCoveragePct: number;
  maskedOutPct: number;
  supportMaskKind: HullSupportMaskKind;
  diagnostics: TensorGeodesicDiagnostics;
};

type MetricRefSourceParams = {
  dutyFR?: number | null;
  q?: number | null;
  gammaGeo?: number | null;
  gammaVdB?: number | null;
  zeta?: number | null;
  phase01?: number | null;
  metricT00?: number | null;
  metricT00Source?: string | null;
  metricT00Ref?: string | null;
};

const DEFAULT_SERVICE_HOST = "127.0.0.1";
const DEFAULT_SERVICE_PORT = 6062;
const DEFAULT_MIN_SCIENTIFIC_DIMS: [number, number, number] = [32, 32, 32];
const YORK_NEAR_ZERO_THETA_ABS_THRESHOLD = 1e-20;
const CANONICAL_REQUIRED_CHANNELS = [...HULL_CANONICAL_REQUIRED_CHANNELS_BASE] as const;
const CANONICAL_OFF_DIAGONAL_GAMMA_CHANNELS = [
  ...HULL_CANONICAL_GAMMA_OFFDIAGONAL_CHANNELS,
] as const;
const MAX_TEMPORAL_HISTORY_SAMPLES = 240;
const SCIENTIFIC_ATLAS_REQUIRED_PANES = [
  ...HULL_SCIENTIFIC_ATLAS_PANES,
] as const satisfies readonly HullScientificAtlasPaneId[];
const SCIENTIFIC_ATLAS_PANE_CHANNEL_SETS: Record<HullScientificAtlasPaneId, string[]> = {
  hull: ["hull_sdf", "tile_support_mask", "region_class"],
  adm: [
    "alpha",
    "beta_x",
    "beta_y",
    "beta_z",
    "gamma_xx",
    "gamma_xy",
    "gamma_xz",
    "gamma_yy",
    "gamma_yz",
    "gamma_zz",
    "K_xx",
    "K_xy",
    "K_xz",
    "K_yy",
    "K_yz",
    "K_zz",
    "K_trace",
  ],
  derived: [
    "theta",
    "rho",
    "H_constraint",
    "M_constraint_x",
    "M_constraint_y",
    "M_constraint_z",
  ],
  causal: [
    "alpha",
    "beta_z",
    "hull_sdf",
    "tile_support_mask",
    "region_class",
  ],
  optical: [
    "alpha",
    "beta_x",
    "beta_y",
    "beta_z",
    "gamma_xx",
    "gamma_xy",
    "gamma_xz",
    "gamma_yy",
    "gamma_yz",
    "gamma_zz",
    "theta",
    "rho",
  ],
};

type TemporalSignalSample = {
  timeS: number;
  dtS: number;
  thetaRms: number;
  hRms: number;
  rhoRms: number;
  betaRms: number;
  updatedAtMs: number;
};

type TemporalHistorySnapshot = {
  key: string;
  series: TemporalSignalSample[];
  latest: TemporalSignalSample | null;
};

const temporalSignalHistoryByKey = new Map<string, TemporalSignalSample[]>();
const metricBrickCacheByRef = new Map<string, MetricBrickCacheEntry>();

const clamp = (value: number, min: number, max: number) =>
  value < min ? min : value > max ? max : value;

const clampi = (value: number, min: number, max: number) =>
  value < min ? min : value > max ? max : value;

const toFiniteNumber = (value: unknown, fallback: number) => {
  if (value == null) return fallback;
  if (typeof value === "string" && value.trim().length === 0) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toInt = (value: unknown, fallback: number, min: number, max: number) => {
  const n = Math.round(toFiniteNumber(value, fallback));
  return clamp(n, min, max);
};

const readEnv = (name: string): string | null => {
  const raw = process.env[name];
  if (!raw) return null;
  const value = raw.trim();
  return value.length ? value : null;
};

const readFirstEnv = (...values: Array<string | null>): string | null => {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text.length > 0) return text;
  }
  return null;
};

const readGitCommitShaBestEffort = (): string | null => {
  try {
    const raw = execSync("git rev-parse HEAD", {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{7,64}$/i.test(raw) ? raw.toLowerCase() : null;
  } catch {
    return null;
  }
};

const readPackageFingerprintBestEffort = (): string | null => {
  try {
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const raw = readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
    const name =
      typeof parsed.name === "string" && parsed.name.trim().length > 0
        ? parsed.name.trim()
        : "casimirbot";
    const version =
      typeof parsed.version === "string" && parsed.version.trim().length > 0
        ? parsed.version.trim()
        : "dev";
    return createHash("sha256")
      .update(`${name}@${version}:${raw}`)
      .digest("hex");
  } catch {
    return null;
  }
};

const resolveRuntimeFingerprint = (): string =>
  readPackageFingerprintBestEffort() ??
  createHash("sha256")
    .update(`${process.cwd()}:${process.platform}:${process.arch}`)
    .digest("hex");

const readEnvFlag = (name: string, fallback = false): boolean => {
  const value = readEnv(name);
  if (!value) return fallback;
  return value === "1" || value.toLowerCase() === "true";
};

const HULL_OPTIX_SERVICE_PROCESS_STARTED_AT_MS = Date.now();
const HULL_OPTIX_SERVICE_RUNTIME_INSTANCE_ID = createHash("sha256")
  .update(
    `${process.pid}:${HULL_OPTIX_SERVICE_PROCESS_STARTED_AT_MS}:${process.cwd()}`,
  )
  .digest("hex")
  .slice(0, 16);
const HULL_OPTIX_SERVICE_VERSION = readFirstEnv(
  readEnv("CASIMIRBOT_OPTIX_SERVICE_VERSION"),
  readEnv("HULL_OPTIX_SERVICE_VERSION"),
  process.env.npm_package_version
    ? `casimirbot.hull-optix-service@${process.env.npm_package_version}`
    : null,
  "casimirbot.hull-optix-service@dev",
);
const HULL_OPTIX_RUNTIME_FINGERPRINT = resolveRuntimeFingerprint();
const HULL_OPTIX_GIT_COMMIT_SHA_FALLBACK = readGitCommitShaBestEffort();
const HULL_OPTIX_COMMIT_SHA = readFirstEnv(
  readEnv("GIT_COMMIT"),
  readEnv("COMMIT_SHA"),
  readEnv("SOURCE_VERSION"),
  HULL_OPTIX_GIT_COMMIT_SHA_FALLBACK,
  HULL_OPTIX_RUNTIME_FINGERPRINT.slice(0, 40),
);
const HULL_OPTIX_BUILD_HASH = readFirstEnv(
  readEnv("CASIMIRBOT_BUILD_HASH"),
  readEnv("BUILD_HASH"),
  readEnv("SOURCE_VERSION"),
  readEnv("GIT_COMMIT"),
  readEnv("COMMIT_SHA"),
  HULL_OPTIX_GIT_COMMIT_SHA_FALLBACK
    ? `git-${HULL_OPTIX_GIT_COMMIT_SHA_FALLBACK.slice(0, 12)}`
    : null,
  HULL_OPTIX_RUNTIME_FINGERPRINT.slice(0, 16),
);

const resolveRequestedYorkLaneId = (
  payload: HullMisRenderRequestV1,
): YorkDiagnosticLaneId =>
  normalizeYorkDiagnosticLaneId(
    typeof payload.scienceLane?.diagnosticLaneId === "string" &&
      payload.scienceLane.diagnosticLaneId.trim().length > 0
      ? payload.scienceLane.diagnosticLaneId.trim()
      : null,
  );

const resolveYorkLaneConvention = (laneId: YorkDiagnosticLaneId) =>
  YORK_DIAGNOSTIC_LANE_CONVENTIONS[laneId];

const computeChannelExtrema = (data: Float32Array): { min: number; max: number } => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.length; i += 1) {
    const value = data[i];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 0 };
  }
  return { min, max };
};

const withYorkThetaChannel = (
  brick: GrBrickDecoded,
  thetaData: Float32Array,
): GrBrickDecoded => {
  const existing = brick.channels.theta?.data;
  if (existing === thetaData) return brick;
  const extrema = computeChannelExtrema(thetaData);
  return {
    ...brick,
    channels: {
      ...brick.channels,
      theta: {
        data: thetaData,
        min: extrema.min,
        max: extrema.max,
      },
    },
  };
};

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
    metricRef: payload.metricVolumeRef?.hash ?? payload.metricVolumeRef?.url ?? "",
    ts: payload.timestampMs ?? 0,
  });
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

const parseMetricVolumeRef = (
  value: unknown,
): HullMisRenderRequestV1["metricVolumeRef"] => {
  if (!isRecord(value)) return null;
  if (value.kind !== "gr-evolve-brick") return null;
  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (!url) return null;
  return {
    kind: "gr-evolve-brick",
    url,
    source: typeof value.source === "string" ? value.source : null,
    chart: typeof value.chart === "string" ? value.chart : null,
    dims: Array.isArray(value.dims) ? readTuple3(value.dims, [1, 1, 1]) : null,
    updatedAt:
      value.updatedAt == null ? null : toFiniteNumber(value.updatedAt, Date.now()),
    hash: typeof value.hash === "string" ? value.hash : null,
  };
};

const parseScientificSamplingMode = (
  value: unknown,
): HullScientificSamplingMode => (value === "nearest" ? "nearest" : "trilinear");

const parseScientificRenderView = (
  value: unknown,
): HullScientificRenderView =>
  value === "paper-rho"
    ? "paper-rho"
    : value === "transport-3p1"
      ? "transport-3p1"
      : value === "york-time-3p1"
        ? "york-time-3p1"
      : value === "york-surface-3p1"
        ? "york-surface-3p1"
      : value === "york-surface-rho-3p1"
        ? "york-surface-rho-3p1"
      : value === "york-topology-normalized-3p1"
        ? "york-topology-normalized-3p1"
      : value === "york-shell-map-3p1"
        ? "york-shell-map-3p1"
      : value === "shift-shell-3p1"
        ? "shift-shell-3p1"
      : value === "full-atlas"
        ? "full-atlas"
      : "diagnostic-quad";

const parseMinVolumeDims = (value: unknown): [number, number, number] | null => {
  if (!Array.isArray(value) || value.length < 3) return null;
  const dims = readTuple3(value, [0, 0, 0]).map((entry) =>
    clamp(Math.floor(Math.max(0, toFiniteNumber(entry, 0))), 0, 512),
  ) as [number, number, number];
  if (dims[0] <= 0 && dims[1] <= 0 && dims[2] <= 0) return null;
  return dims;
};

const parseRequest = (body: unknown): HullMisRenderRequestV1 => {
  const src = isRecord(body) ? body : {};
  const solve = isRecord(src.solve) ? src.solve : {};
  const diag = isRecord(src.geodesicDiagnostics) ? src.geodesicDiagnostics : {};
  const metric = isRecord(src.metricSummary) ? src.metricSummary : {};
  const scienceLane = isRecord(src.scienceLane) ? src.scienceLane : {};

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
    scienceLane: {
      requireIntegralSignal: scienceLane.requireIntegralSignal === true,
      requireScientificFrame: scienceLane.requireScientificFrame === true,
      requireCanonicalTensorVolume:
        scienceLane.requireCanonicalTensorVolume === true ||
        scienceLane.requireScientificFrame === true,
      requireCongruentNhm2FullSolve:
        scienceLane.requireCongruentNhm2FullSolve === true,
      diagnosticLaneId:
        typeof scienceLane.diagnosticLaneId === "string" &&
        scienceLane.diagnosticLaneId.trim().length > 0
          ? scienceLane.diagnosticLaneId.trim()
          : null,
      requireHullSupportChannels:
        scienceLane.requireHullSupportChannels === true,
      requireOffDiagonalGamma:
        scienceLane.requireOffDiagonalGamma === true ||
        scienceLane.requireScientificFrame === true,
      minVolumeDims: parseMinVolumeDims(scienceLane.minVolumeDims),
      samplingMode: parseScientificSamplingMode(scienceLane.samplingMode),
      renderView: parseScientificRenderView(scienceLane.renderView),
      attachmentDownsample: toInt(scienceLane.attachmentDownsample, 1, 1, 8),
    },
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
        metric.updatedAt == null
          ? null
          : toFiniteNumber(metric.updatedAt, Date.now()),
    },
    metricVolumeRef: parseMetricVolumeRef(src.metricVolumeRef),
  };
};

const decodeFloat32FromBase64 = (payload: unknown): Float32Array | null => {
  if (typeof payload !== "string" || payload.length === 0) return null;
  try {
    const bytes = Buffer.from(payload, "base64");
    if (bytes.length % 4 !== 0) return null;
    const out = new Float32Array(bytes.length / 4);
    for (let i = 0; i < out.length; i += 1) out[i] = bytes.readFloatLE(i * 4);
    return out;
  } catch {
    return null;
  }
};

const decodeGrEvolveBrickJson = (value: unknown): GrBrickDecoded | null => {
  const root = isRecord(value) ? value : null;
  if (!root || root.kind !== "gr-evolve-brick") return null;
  const dimsRaw = Array.isArray(root.dims) ? root.dims : null;
  if (!dimsRaw || dimsRaw.length < 3) return null;
  const dims: [number, number, number] = [
    Math.max(1, Math.floor(toFiniteNumber(dimsRaw[0], 1))),
    Math.max(1, Math.floor(toFiniteNumber(dimsRaw[1], 1))),
    Math.max(1, Math.floor(toFiniteNumber(dimsRaw[2], 1))),
  ];
  const voxelSizeRaw = Array.isArray(root.voxelSize_m) ? root.voxelSize_m : null;
  const voxelSize_m: [number, number, number] = voxelSizeRaw
    ? [
        Math.max(1e-6, toFiniteNumber(voxelSizeRaw[0], 1)),
        Math.max(1e-6, toFiniteNumber(voxelSizeRaw[1], 1)),
        Math.max(1e-6, toFiniteNumber(voxelSizeRaw[2], 1)),
      ]
    : [1, 1, 1];
  const channelsRaw = isRecord(root.channels) ? root.channels : {};
  const channels: Record<string, GrBrickChannel> = {};
  for (const [name, raw] of Object.entries(channelsRaw)) {
    if (!isRecord(raw)) continue;
    const data = decodeFloat32FromBase64(raw.data);
    if (!data) continue;
    channels[name] = {
      data,
      min: toFiniteNumber(raw.min, 0),
      max: toFiniteNumber(raw.max, 0),
    };
  }
  if (!channels.alpha || !channels.beta_x || !channels.beta_y || !channels.beta_z) {
    return null;
  }
  if (!channels.gamma_xx || !channels.gamma_yy || !channels.gamma_zz) {
    return null;
  }
  return {
    dims,
    voxelSize_m,
    channels,
    source: typeof root.source === "string" ? root.source : null,
    chart: typeof root.chart === "string" ? root.chart : null,
  };
};

const decodeGrEvolveBrickBinary = (buffer: ArrayBuffer): GrBrickDecoded | null => {
  if (buffer.byteLength < 8) return null;
  const view = new DataView(buffer);
  const headerLength = view.getUint32(0, true);
  if (!Number.isFinite(headerLength) || headerLength <= 0) return null;
  if (headerLength + 4 > buffer.byteLength) return null;
  const headerBytes = new Uint8Array(buffer, 4, headerLength);
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerBytes).toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
  if (header.kind !== "gr-evolve-brick") return null;
  const dimsRaw = Array.isArray(header.dims) ? header.dims : null;
  if (!dimsRaw || dimsRaw.length < 3) return null;
  const dims: [number, number, number] = [
    Math.max(1, Math.floor(toFiniteNumber(dimsRaw[0], 1))),
    Math.max(1, Math.floor(toFiniteNumber(dimsRaw[1], 1))),
    Math.max(1, Math.floor(toFiniteNumber(dimsRaw[2], 1))),
  ];
  const voxelSizeRaw = Array.isArray(header.voxelSize_m) ? header.voxelSize_m : null;
  const voxelSize_m: [number, number, number] = voxelSizeRaw
    ? [
        Math.max(1e-6, toFiniteNumber(voxelSizeRaw[0], 1)),
        Math.max(1e-6, toFiniteNumber(voxelSizeRaw[1], 1)),
        Math.max(1e-6, toFiniteNumber(voxelSizeRaw[2], 1)),
      ]
    : [1, 1, 1];
  const channelsHeader = isRecord(header.channels) ? header.channels : {};
  const orderRaw = Array.isArray(header.channelOrder)
    ? header.channelOrder
    : Object.keys(channelsHeader);
  const channelOrder = orderRaw
    .map((entry) => String(entry))
    .filter((entry) => entry.length > 0);
  const total = dims[0] * dims[1] * dims[2];
  const defaultBytes = total * 4;
  const padding = (4 - (headerLength % 4)) % 4;
  let offset = 4 + headerLength + padding;
  const channels: Record<string, GrBrickChannel> = {};
  for (const name of channelOrder) {
    const specRaw = channelsHeader[name];
    if (!isRecord(specRaw)) continue;
    const bytes = Math.max(4, Math.floor(toFiniteNumber(specRaw.bytes, defaultBytes)));
    if (bytes % 4 !== 0) return null;
    if (offset + bytes > buffer.byteLength) return null;
    const count = bytes / 4;
    const data = new Float32Array(count);
    const chunk = new DataView(buffer, offset, bytes);
    for (let i = 0; i < count; i += 1) data[i] = chunk.getFloat32(i * 4, true);
    offset += bytes;
    channels[name] = {
      data,
      min: toFiniteNumber(specRaw.min, 0),
      max: toFiniteNumber(specRaw.max, 0),
    };
  }
  if (!channels.alpha || !channels.beta_x || !channels.beta_y || !channels.beta_z) {
    return null;
  }
  if (!channels.gamma_xx || !channels.gamma_yy || !channels.gamma_zz) {
    return null;
  }
  return {
    dims,
    voxelSize_m,
    channels,
    source: typeof header.source === "string" ? header.source : null,
    chart: typeof header.chart === "string" ? header.chart : null,
  };
};

const withTimeoutFetch = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const resolveMetricRefUrl = (ref: HullMetricVolumeRefV1): string | null => {
  const raw = ref.url.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) {
    const base =
      readEnv("OPTIX_RENDER_METRIC_REF_BASE_URL") || readEnv("OPTIX_RENDER_APP_BASE_URL");
    if (!base) return null;
    return `${base.replace(/\/+$/, "")}${raw}`;
  }
  return null;
};

const metricRefEnforcesCongruentSolve = (
  ref: HullMetricVolumeRefV1 | null | undefined,
): boolean => {
  if (!ref?.url || ref.url.trim().length === 0) return false;
  try {
    const parsed = new URL(ref.url, "http://127.0.0.1");
    const raw =
      parsed.searchParams.get("requireCongruentSolve") ??
      parsed.searchParams.get("requireNhm2CongruentFullSolve");
    if (raw == null) return false;
    const normalized = raw.trim().toLowerCase();
    return normalized === "1" || normalized === "true";
  } catch {
    return false;
  }
};

const parseDimsTuple = (value: unknown): [number, number, number] | null => {
  if (!Array.isArray(value) || value.length < 3) return null;
  const x = Math.max(1, Math.floor(Number(value[0]) || 0));
  const y = Math.max(1, Math.floor(Number(value[1]) || 0));
  const z = Math.max(1, Math.floor(Number(value[2]) || 0));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
};

const parseDimsQuery = (urlRaw: string): [number, number, number] | null => {
  try {
    const parsed = new URL(urlRaw, "http://127.0.0.1");
    const dimsRaw = parsed.searchParams.get("dims");
    if (!dimsRaw || dimsRaw.trim().length === 0) return null;
    const match = dimsRaw.trim().match(/^(\d+)x(\d+)x(\d+)$/i);
    if (!match) return null;
    const x = Math.max(1, Math.floor(Number(match[1]) || 0));
    const y = Math.max(1, Math.floor(Number(match[2]) || 0));
    const z = Math.max(1, Math.floor(Number(match[3]) || 0));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return [x, y, z];
  } catch {
    return null;
  }
};

const resolveMetricRefDims = (
  payload: HullMisRenderRequestV1,
  ref: HullMetricVolumeRefV1,
): [number, number, number] | null =>
  parseDimsTuple(ref.dims) ?? parseDimsQuery(ref.url) ?? parseDimsTuple(payload.metricSummary?.dims);

const resolveMetricBrickCacheKey = (ref: HullMetricVolumeRefV1, resolvedUrl: string): string => {
  const metricRefHash = typeof ref.hash === "string" ? ref.hash.trim() : "";
  if (metricRefHash.length > 0) return `hash:${metricRefHash}`;
  return `url:${resolvedUrl}`;
};

const readMetricBrickCache = (key: string): GrBrickDecoded | null => {
  const now = Date.now();
  const entry = metricBrickCacheByRef.get(key);
  if (!entry) return null;
  if (!Number.isFinite(entry.expiresAtMs) || entry.expiresAtMs <= now) {
    metricBrickCacheByRef.delete(key);
    return null;
  }
  return entry.brick;
};

const writeMetricBrickCache = (key: string, brick: GrBrickDecoded): void => {
  const cacheTtlMs = toInt(
    readEnv("OPTIX_RENDER_METRIC_CACHE_TTL_MS"),
    90_000,
    5_000,
    600_000,
  );
  const maxEntries = toInt(readEnv("OPTIX_RENDER_METRIC_CACHE_MAX_ENTRIES"), 6, 1, 64);
  const now = Date.now();
  const expiresAtMs = now + cacheTtlMs;
  metricBrickCacheByRef.set(key, { brick, expiresAtMs });
  while (metricBrickCacheByRef.size > maxEntries) {
    const oldest = metricBrickCacheByRef.keys().next();
    if (oldest.done) break;
    metricBrickCacheByRef.delete(oldest.value);
  }
};

const resolveMetricFetchTimeoutMs = (
  payload: HullMisRenderRequestV1,
  ref: HullMetricVolumeRefV1,
): number => {
  const configuredTimeoutMs = toInt(
    readEnv("OPTIX_RENDER_METRIC_FETCH_TIMEOUT_MS"),
    45_000,
    5_000,
    300_000,
  );
  const renderView = payload.scienceLane?.renderView ?? "diagnostic-quad";
  const yorkOrAtlasView = renderView === "full-atlas" || renderView.startsWith("york-");
  const requiresScientificLatency =
    payload.scienceLane?.requireScientificFrame === true ||
    payload.scienceLane?.requireCanonicalTensorVolume === true ||
    payload.scienceLane?.requireHullSupportChannels === true ||
    yorkOrAtlasView;
  if (!requiresScientificLatency) return configuredTimeoutMs;

  const dims = resolveMetricRefDims(payload, ref);
  const cellCount =
    dims && dims.length >= 3
      ? Math.max(1, Math.floor(Number(dims[0]) || 1)) *
        Math.max(1, Math.floor(Number(dims[1]) || 1)) *
        Math.max(1, Math.floor(Number(dims[2]) || 1))
      : 0;
  const adaptiveFloorMs =
    cellCount >= 64 * 64 * 64
      ? 180_000
      : yorkOrAtlasView && cellCount >= 48 * 48 * 48
        ? 120_000
        : cellCount >= 48 * 48 * 48
          ? 60_000
          : 30_000;
  return Math.max(configuredTimeoutMs, adaptiveFloorMs);
};

const fetchMetricBrick = async (
  ref: HullMetricVolumeRefV1,
  options?: { timeoutMs?: number },
): Promise<GrBrickDecoded | null> => {
  const url = resolveMetricRefUrl(ref);
  if (!url) return null;
  const cacheKey = resolveMetricBrickCacheKey(ref, url);
  const cached = readMetricBrickCache(cacheKey);
  if (cached) return cached;
  const configuredTimeoutMs = toInt(
    readEnv("OPTIX_RENDER_METRIC_FETCH_TIMEOUT_MS"),
    45_000,
    5_000,
    300_000,
  );
  const metricFetchTimeoutMs = clampi(
    Math.round(toFiniteNumber(options?.timeoutMs, configuredTimeoutMs)),
    5_000,
    300_000,
  );
  let response: Response | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      response = await withTimeoutFetch(
        url,
        {
          method: "GET",
          headers: {
            Accept: "application/octet-stream, application/x-helix-brick, application/json",
          },
        },
        metricFetchTimeoutMs,
      );
      if (response.ok) break;
      const retryableHttp = response.status >= 500 && response.status <= 599;
      if (retryableHttp && attempt < 2) continue;
      break;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (attempt < 2) continue;
        throw new Error(`metric_ref_fetch_timeout_${metricFetchTimeoutMs}`);
      }
      if (error instanceof Error && error.message.toLowerCase().includes("fetch failed")) {
        if (attempt < 2) continue;
      }
      throw error;
    }
  }
  if (!response || !response.ok) {
    let detail: string | null = null;
    try {
      const body = response ? await response.text() : "";
      if (body && body.trim().length > 0) {
        const contentType = (response?.headers.get("content-type") ?? "").toLowerCase();
        if (contentType.includes("application/json")) {
          try {
            const parsed = JSON.parse(body) as unknown;
            if (isRecord(parsed)) {
              const detailParts: string[] = [];
              if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
                detailParts.push(parsed.error.trim());
              }
              if (typeof parsed.message === "string" && parsed.message.trim().length > 0) {
                detailParts.push(parsed.message.trim());
              }
              const congruentSolve = isRecord(parsed.congruentSolve) ? parsed.congruentSolve : null;
              const failReasons = Array.isArray(congruentSolve?.failReasons)
                ? congruentSolve.failReasons
                    .map((reason: unknown) => String(reason).trim())
                    .filter((reason: string) => reason.length > 0)
                : [];
              if (failReasons.length > 0) {
                detailParts.push(`failReasons=${failReasons.join(",")}`);
              }
              if (detailParts.length > 0) {
                detail = detailParts.join(" | ");
              }
            }
          } catch {
            // fall through to text compaction below
          }
        }
        if (!detail) {
          const compact = body.replace(/\s+/g, " ").trim();
          if (compact.length > 0) {
            detail = compact.length > 240 ? `${compact.slice(0, 240)}...` : compact;
          }
        }
      }
    } catch {
      // ignore body parse/read failures and preserve HTTP status
    }
    throw new Error(
      detail
        ? `metric_ref_http_${response?.status ?? 0}:${detail}`
        : `metric_ref_http_${response?.status ?? 0}`,
    );
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (
    contentType.includes("application/octet-stream") ||
    contentType.includes("application/x-helix-brick")
  ) {
    const buffer = await response.arrayBuffer();
    const decoded = decodeGrEvolveBrickBinary(buffer);
    if (decoded) writeMetricBrickCache(cacheKey, decoded);
    return decoded;
  }
  const json = (await response.json()) as unknown;
  const decoded = decodeGrEvolveBrickJson(json);
  if (decoded) writeMetricBrickCache(cacheKey, decoded);
  return decoded;
};

type ScientificContractViolation = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

const validateScientificMetricVolume = (
  payload: HullMisRenderRequestV1,
  brick: GrBrickDecoded,
): { ok: boolean; violations: ScientificContractViolation[] } => {
  const violations: ScientificContractViolation[] = [];
  const yorkRequested =
    payload.scienceLane?.renderView === "york-time-3p1" ||
    payload.scienceLane?.renderView === "york-surface-3p1" ||
    payload.scienceLane?.renderView === "york-surface-rho-3p1" ||
    payload.scienceLane?.renderView === "york-topology-normalized-3p1";
  const yorkShellMapRequested = payload.scienceLane?.renderView === "york-shell-map-3p1";
  const fullAtlasRequested = payload.scienceLane?.renderView === "full-atlas";
  const requireCanonical =
    payload.scienceLane?.requireCanonicalTensorVolume === true ||
    fullAtlasRequested ||
    yorkRequested ||
    yorkShellMapRequested;
  const requireHullSupportChannels =
    payload.scienceLane?.requireHullSupportChannels === true ||
    fullAtlasRequested ||
    yorkShellMapRequested;
  const requireOffDiagonalGamma =
    payload.scienceLane?.requireOffDiagonalGamma === true ||
    payload.scienceLane?.requireScientificFrame === true;
  const minDims =
    payload.scienceLane?.minVolumeDims ??
    (payload.scienceLane?.requireScientificFrame === true ? DEFAULT_MIN_SCIENTIFIC_DIMS : null);
  if (minDims) {
    const tooSmallAxes: Array<{ axis: "x" | "y" | "z"; actual: number; required: number }> = [];
    if (brick.dims[0] < minDims[0]) tooSmallAxes.push({ axis: "x", actual: brick.dims[0], required: minDims[0] });
    if (brick.dims[1] < minDims[1]) tooSmallAxes.push({ axis: "y", actual: brick.dims[1], required: minDims[1] });
    if (brick.dims[2] < minDims[2]) tooSmallAxes.push({ axis: "z", actual: brick.dims[2], required: minDims[2] });
    if (tooSmallAxes.length > 0) {
      violations.push({
        code: "scientific_min_volume_dims_unmet",
        message: `metric volume dims ${brick.dims.join("x")} below required ${minDims.join("x")}`,
        details: {
          dims: brick.dims,
          requiredMinDims: minDims,
          tooSmallAxes,
        },
      });
    }
  }
  if (requireHullSupportChannels) {
    const missing = validateHullSupportChannels(brick);
    if (missing.length > 0) {
      violations.push({
        code: "scientific_hull_support_channels_missing",
        message: `missing hull support channels (${missing.length})`,
        details: {
          missing,
          required: [...HULL_SUPPORT_CHANNELS],
          presentCount: HULL_SUPPORT_CHANNELS.length - missing.length,
        },
      });
    }
  }
  if (requireCanonical) {
    const missing = CANONICAL_REQUIRED_CHANNELS.filter((name) => {
      const channel = brick.channels[name];
      return !channel || !(channel.data instanceof Float32Array);
    });
    if (missing.length > 0) {
      violations.push({
        code: "scientific_canonical_channels_missing",
        message: `missing canonical channels (${missing.length})`,
        details: {
          missing,
          required: [...CANONICAL_REQUIRED_CHANNELS],
          presentCount: Object.keys(brick.channels).length,
        },
      });
    }
    if (
      (yorkRequested || yorkShellMapRequested) &&
      (!brick.channels.theta || !(brick.channels.theta.data instanceof Float32Array))
    ) {
      const requestedYorkView = payload.scienceLane?.renderView ?? "york-time-3p1";
      violations.push({
        code: "scientific_york_theta_missing",
        message: `missing canonical theta channel for ${requestedYorkView}`,
        details: {
          required: ["theta"],
          view: requestedYorkView,
        },
      });
    }
    if (requireOffDiagonalGamma) {
      const missingOffDiagonalGamma = CANONICAL_OFF_DIAGONAL_GAMMA_CHANNELS.filter(
        (name) => {
          const channel = brick.channels[name];
          return !channel || !(channel.data instanceof Float32Array);
        },
      );
      if (missingOffDiagonalGamma.length > 0) {
        violations.push({
          code: "scientific_canonical_gamma_off_diagonal_missing",
          message: `missing off-diagonal gamma channels (${missingOffDiagonalGamma.length})`,
          details: {
            missing: missingOffDiagonalGamma,
            required: [...CANONICAL_OFF_DIAGONAL_GAMMA_CHANNELS],
            policy: "phase1_off_diagonal_gamma_required",
          },
        });
      }
    }
  }
  return { ok: violations.length === 0, violations };
};

const hasHullSupportChannel = (
  brick: GrBrickDecoded,
  name: HullSupportChannelName,
): boolean => {
  const channel = brick.channels[name];
  return !!channel && channel.data instanceof Float32Array && channel.data.length >= brick.dims[0] * brick.dims[1] * brick.dims[2];
};

const validateHullSupportChannels = (brick: GrBrickDecoded): HullSupportChannelName[] => {
  const missing: HullSupportChannelName[] = [];
  for (const name of HULL_SUPPORT_CHANNELS) {
    if (!hasHullSupportChannel(brick, name)) missing.push(name);
  }
  return missing;
};

const sampleGridNearest = (
  data: Float32Array,
  width: number,
  height: number,
  fx: number,
  fy: number,
): number => {
  if (width <= 0 || height <= 0 || data.length === 0) return 0;
  const x = clampi(Math.round(fx), 0, width - 1);
  const y = clampi(Math.round(fy), 0, height - 1);
  return data[y * width + x] ?? 0;
};

const sampleGridBilinear = (
  data: Float32Array,
  width: number,
  height: number,
  fx: number,
  fy: number,
): number => {
  if (width <= 0 || height <= 0 || data.length === 0) return 0;
  const x0 = clampi(Math.floor(fx), 0, width - 1);
  const y0 = clampi(Math.floor(fy), 0, height - 1);
  const x1 = clampi(x0 + 1, 0, width - 1);
  const y1 = clampi(y0 + 1, 0, height - 1);
  const tx = clamp(fx - x0, 0, 1);
  const ty = clamp(fy - y0, 0, 1);
  const v00 = data[y0 * width + x0] ?? 0;
  const v10 = data[y0 * width + x1] ?? 0;
  const v01 = data[y1 * width + x0] ?? 0;
  const v11 = data[y1 * width + x1] ?? 0;
  const vx0 = lerp(v00, v10, tx);
  const vx1 = lerp(v01, v11, tx);
  return lerp(vx0, vx1, ty);
};

const buildHullSupportProjection = (
  brick: GrBrickDecoded,
): HullSupportProjection | null => {
  const nx = brick.dims[0];
  const ny = brick.dims[1];
  const nz = brick.dims[2];
  const total = nx * nz;
  const support = new Float32Array(total);
  const signedHullSdf = hasHullSupportChannel(brick, "hull_sdf")
    ? new Float32Array(total)
    : null;
  const presentChannels: HullSupportChannelName[] = [];
  const channelData = HULL_SUPPORT_CHANNELS.map((name) => {
    const channel = brick.channels[name];
    if (!hasHullSupportChannel(brick, name)) return null;
    presentChannels.push(name);
    return { name, data: channel!.data };
  }).filter((entry): entry is { name: HullSupportChannelName; data: Float32Array } => !!entry);

  if (channelData.length === 0) return null;

  for (let z = 0; z < nz; z += 1) {
    for (let x = 0; x < nx; x += 1) {
      let supported = false;
      let bestHullSdf = Number.POSITIVE_INFINITY;
      for (let y = 0; y < ny; y += 1) {
        const idx = idx3(x, y, z, brick.dims);
        for (const channel of channelData) {
          const value = channel.data[idx] ?? 0;
          if (channel.name === "hull_sdf") {
            if (Number.isFinite(value) && value < bestHullSdf) bestHullSdf = value;
            if (Number.isFinite(value) && value <= 0) supported = true;
          } else if (channel.name === "tile_support_mask") {
            if (Number.isFinite(value) && value > 0.5) supported = true;
          } else if (channel.name === "region_class") {
            if (Number.isFinite(value) && value !== 0) supported = true;
          }
        }
      }
      const outIdx = z * nx + x;
      support[outIdx] = supported ? 1 : 0;
      if (signedHullSdf) {
        signedHullSdf[outIdx] = Number.isFinite(bestHullSdf) ? bestHullSdf : 0;
      }
    }
  }

  const coveragePct = computeSliceSupportPct(support);
  const kind: HullSupportMaskKind =
    presentChannels.length === 1 ? presentChannels[0]! : "combined";
  return {
    kind,
    channels: presentChannels,
    width: nx,
    height: nz,
    data: support,
    signedHullSdf,
    coveragePct,
    maskedOutPct: Math.max(0, 100 - coveragePct),
  };
};

const buildAnalyticHullSupportProjection = (
  brick: GrBrickDecoded,
  metricRadiiM: [number, number, number],
  anisotropy: [number, number, number],
): HullSupportProjection => {
  const nx = brick.dims[0];
  const nz = brick.dims[2];
  const total = nx * nz;
  const support = new Float32Array(total);
  const signedHullSdf = new Float32Array(total);

  const halfNx = Math.max(1, (nx - 1) * 0.5);
  const halfNz = Math.max(1, (nz - 1) * 0.5);
  const extentX_m = Math.max(1e-6, brick.voxelSize_m[0] * halfNx);
  const extentZ_m = Math.max(1e-6, brick.voxelSize_m[2] * halfNz);

  const rxNormFromMetric = Number.isFinite(metricRadiiM[0])
    ? metricRadiiM[0] / extentX_m
    : Number.NaN;
  const rzNormFromMetric = Number.isFinite(metricRadiiM[2])
    ? metricRadiiM[2] / extentZ_m
    : Number.NaN;
  const rxNorm = clamp(
    Number.isFinite(rxNormFromMetric) && rxNormFromMetric > 0
      ? rxNormFromMetric
      : anisotropy[0],
    0.45,
    0.98,
  );
  const rzNorm = clamp(
    Number.isFinite(rzNormFromMetric) && rzNormFromMetric > 0
      ? rzNormFromMetric
      : anisotropy[2],
    0.45,
    0.98,
  );

  const rx = Math.max(1, halfNx * rxNorm);
  const rz = Math.max(1, halfNz * rzNorm);

  for (let z = 0; z < nz; z += 1) {
    const dz = (z - halfNz) / rz;
    for (let x = 0; x < nx; x += 1) {
      const dx = (x - halfNx) / rx;
      const signed = Math.sqrt(dx * dx + dz * dz) - 1;
      const idx = z * nx + x;
      signedHullSdf[idx] = signed;
      support[idx] = signed <= 0 ? 1 : 0;
    }
  }

  const coveragePct = computeSliceSupportPct(support);
  return {
    kind: "analytic",
    channels: [],
    width: nx,
    height: nz,
    data: support,
    signedHullSdf,
    coveragePct,
    maskedOutPct: Math.max(0, 100 - coveragePct),
  };
};

const sampleHullSupport3D = (
  brick: GrBrickDecoded,
  x01: number,
  y01: number,
  z01: number,
): number => {
  let support = 0;
  const hullSdf = brick.channels.hull_sdf?.data;
  if (hullSdf instanceof Float32Array && hullSdf.length >= brick.dims[0] * brick.dims[1] * brick.dims[2]) {
    const value = sampleVolumeTrilinear(hullSdf, brick.dims, x01, y01, z01);
    if (Number.isFinite(value) && value <= 0) support = 1;
  }
  const tileSupportMask = brick.channels.tile_support_mask?.data;
  if (
    tileSupportMask instanceof Float32Array &&
    tileSupportMask.length >= brick.dims[0] * brick.dims[1] * brick.dims[2]
  ) {
    const value = sampleVolumeTrilinear(tileSupportMask, brick.dims, x01, y01, z01);
    if (Number.isFinite(value) && value > 0.5) support = 1;
  }
  const regionClass = brick.channels.region_class?.data;
  if (
    regionClass instanceof Float32Array &&
    regionClass.length >= brick.dims[0] * brick.dims[1] * brick.dims[2]
  ) {
    const value = sampleVolumeTrilinear(regionClass, brick.dims, x01, y01, z01);
    if (Number.isFinite(value) && value !== 0) support = 1;
  }
  return support;
};

const idx3 = (
  x: number,
  y: number,
  z: number,
  dims: [number, number, number],
): number => x + dims[0] * (y + dims[1] * z);

const sampleMetricAxisRadius = (args: {
  data: Float32Array;
  dims: [number, number, number];
  spacingM: [number, number, number];
  axis: 0 | 1 | 2;
}) => {
  const { data, dims, spacingM, axis } = args;
  const cx = clampi(Math.floor(dims[0] * 0.5), 0, dims[0] - 1);
  const cy = clampi(Math.floor(dims[1] * 0.5), 0, dims[1] - 1);
  const cz = clampi(Math.floor(dims[2] * 0.5), 0, dims[2] - 1);
  const length = dims[axis];
  const center = axis === 0 ? cx : axis === 1 ? cy : cz;
  let peakAbs = 0;
  const line = new Array<number>(length).fill(0);
  for (let i = 0; i < length; i += 1) {
    const x = axis === 0 ? i : cx;
    const y = axis === 1 ? i : cy;
    const z = axis === 2 ? i : cz;
    const index = idx3(x, y, z, dims);
    const value = Number.isFinite(data[index]) ? Math.abs(data[index]!) : 0;
    line[i] = value;
    if (value > peakAbs) peakAbs = value;
  }
  if (!(peakAbs > 1e-12)) {
    return {
      radiusM: null as number | null,
      symmetryErrorM: null as number | null,
      peakAbs,
      sampleCount: 0,
    };
  }
  const threshold = Math.max(peakAbs * 0.35, 1e-12);
  let pos = center;
  for (let i = center; i < length; i += 1) {
    if (line[i] >= threshold) pos = i;
  }
  let neg = center;
  for (let i = center; i >= 0; i -= 1) {
    if (line[i] >= threshold) neg = i;
  }
  const spacing = spacingM[axis];
  const left = Math.max(0, center - neg);
  const right = Math.max(0, pos - center);
  const radiusM = ((left + right) * 0.5) * spacing;
  const symmetryErrorM = Math.abs(left - right) * spacing;
  return {
    radiusM: radiusM > 0 ? radiusM : null,
    symmetryErrorM,
    peakAbs,
    sampleCount: left + right + 1,
  };
};

const metricFromComponents = (
  alpha: number,
  bx: number,
  by: number,
  bz: number,
  gxx: number,
  gyy: number,
  gzz: number,
) => {
  const a = Math.max(1e-6, alpha);
  const gxxSafe = Math.max(1e-6, gxx);
  const gyySafe = Math.max(1e-6, gyy);
  const gzzSafe = Math.max(1e-6, gzz);
  const a2 = a * a;
  const invA2 = 1 / a2;
  const invGxx = 1 / gxxSafe;
  const invGyy = 1 / gyySafe;
  const invGzz = 1 / gzzSafe;

  const g = [
    [-a2 + gxxSafe * bx * bx + gyySafe * by * by + gzzSafe * bz * bz, gxxSafe * bx, gyySafe * by, gzzSafe * bz],
    [gxxSafe * bx, gxxSafe, 0, 0],
    [gyySafe * by, 0, gyySafe, 0],
    [gzzSafe * bz, 0, 0, gzzSafe],
  ];

  const gInv = [
    [-invA2, bx * invA2, by * invA2, bz * invA2],
    [bx * invA2, invGxx - bx * bx * invA2, -(bx * by) * invA2, -(bx * bz) * invA2],
    [by * invA2, -(by * bx) * invA2, invGyy - by * by * invA2, -(by * bz) * invA2],
    [bz * invA2, -(bz * bx) * invA2, -(bz * by) * invA2, invGzz - bz * bz * invA2],
  ];
  return { g, gInv };
};

const computeTensorGeodesicDiagnostics = (brick: GrBrickDecoded): TensorGeodesicDiagnostics => {
  const dims = brick.dims;
  const [nx, ny, nz] = dims;
  const total = nx * ny * nz;
  if (total <= 8) {
    return {
      maxNullResidual: Number.POSITIVE_INFINITY,
      stepConvergence: 0,
      bundleSpread: 0,
      consistency: "unknown",
    };
  }
  const alpha = brick.channels.alpha?.data;
  const betaX = brick.channels.beta_x?.data;
  const betaY = brick.channels.beta_y?.data;
  const betaZ = brick.channels.beta_z?.data;
  const gammaXX = brick.channels.gamma_xx?.data;
  const gammaYY = brick.channels.gamma_yy?.data;
  const gammaZZ = brick.channels.gamma_zz?.data;
  if (!alpha || !betaX || !betaY || !betaZ || !gammaXX || !gammaYY || !gammaZZ) {
    return {
      maxNullResidual: Number.POSITIVE_INFINITY,
      stepConvergence: 0,
      bundleSpread: 0,
      consistency: "unknown",
    };
  }
  const dx = Math.max(1e-6, toFiniteNumber(brick.voxelSize_m[0], 1));
  const dy = Math.max(1e-6, toFiniteNumber(brick.voxelSize_m[1], 1));
  const dz = Math.max(1e-6, toFiniteNumber(brick.voxelSize_m[2], 1));
  const derivScale = [0, 1 / (2 * dx), 1 / (2 * dy), 1 / (2 * dz)];
  const comp = (arr: Float32Array, i: number) =>
    Number.isFinite(arr[i]) ? Number(arr[i]) : 0;

  const sampleMetricAt = (ixIn: number, iyIn: number, izIn: number) => {
    const ix = clampi(ixIn, 0, nx - 1);
    const iy = clampi(iyIn, 0, ny - 1);
    const iz = clampi(izIn, 0, nz - 1);
    const i = idx3(ix, iy, iz, dims);
    return metricFromComponents(
      Math.max(1e-6, comp(alpha, i) || 1),
      comp(betaX, i),
      comp(betaY, i),
      comp(betaZ, i),
      Math.max(1e-6, comp(gammaXX, i) || 1),
      Math.max(1e-6, comp(gammaYY, i) || 1),
      Math.max(1e-6, comp(gammaZZ, i) || 1),
    );
  };

  const ic = clampi(Math.floor(nx * 0.5), 0, nx - 1);
  const jc = clampi(Math.floor(ny * 0.5), 0, ny - 1);
  const kc = clampi(Math.floor(nz * 0.5), 0, nz - 1);
  const center = sampleMetricAt(ic, jc, kc);
  const g = center.g;
  const gInv = center.gInv;
  const dG = Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, () => new Array<number>(4).fill(0)),
  );
  for (let deriv = 1; deriv <= 3; deriv += 1) {
    const plus =
      deriv === 1
        ? sampleMetricAt(ic + 1, jc, kc)
        : deriv === 2
          ? sampleMetricAt(ic, jc + 1, kc)
          : sampleMetricAt(ic, jc, kc + 1);
    const minus =
      deriv === 1
        ? sampleMetricAt(ic - 1, jc, kc)
        : deriv === 2
          ? sampleMetricAt(ic, jc - 1, kc)
          : sampleMetricAt(ic, jc, kc - 1);
    for (let a = 0; a < 4; a += 1) {
      for (let b = 0; b < 4; b += 1) {
        dG[deriv][a][b] = (plus.g[a][b] - minus.g[a][b]) * derivScale[deriv]!;
      }
    }
  }

  const christoffel = Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, () => new Array<number>(4).fill(0)),
  );
  for (let mu = 0; mu < 4; mu += 1) {
    for (let a = 0; a < 4; a += 1) {
      for (let b = 0; b < 4; b += 1) {
        let acc = 0;
        for (let nu = 0; nu < 4; nu += 1) {
          acc +=
            0.5 *
            gInv[mu]![nu]! *
            (dG[a]![b]![nu]! + dG[b]![a]![nu]! - dG[nu]![a]![b]!);
        }
        christoffel[mu]![a]![b] = acc;
      }
    }
  }

  const nullResidual = (k: number[]) => {
    let acc = 0;
    for (let a = 0; a < 4; a += 1) {
      for (let b = 0; b < 4; b += 1) {
        acc += g[a]![b]! * k[a]! * k[b]!;
      }
    }
    return Math.abs(acc);
  };

  const solveNullK0 = (spatial: [number, number, number]) => {
    const [sx, sy, sz] = spatial;
    const A = g[0]![0]!;
    const B = 2 * (g[0]![1]! * sx + g[0]![2]! * sy + g[0]![3]! * sz);
    const C =
      g[1]![1]! * sx * sx +
      g[2]![2]! * sy * sy +
      g[3]![3]! * sz * sz +
      2 * (g[1]![2]! * sx * sy + g[1]![3]! * sx * sz + g[2]![3]! * sy * sz);
    const disc = Math.max(0, B * B - 4 * A * C);
    const root = Math.sqrt(disc);
    const denom = Math.abs(2 * A) > 1e-12 ? 2 * A : A < 0 ? -2e-12 : 2e-12;
    const r1 = (-B - root) / denom;
    const r2 = (-B + root) / denom;
    if (Number.isFinite(r1) && r1 > 0) return r1;
    if (Number.isFinite(r2) && r2 > 0) return r2;
    if (Number.isFinite(r1)) return r1;
    if (Number.isFinite(r2)) return r2;
    return 1;
  };

  const rhs = (state: { x: number[]; k: number[] }) => {
    const dxdt = [...state.k];
    const dkdt = [0, 0, 0, 0];
    for (let mu = 0; mu < 4; mu += 1) {
      let acc = 0;
      for (let a = 0; a < 4; a += 1) {
        for (let b = 0; b < 4; b += 1) {
          acc += christoffel[mu]![a]![b]! * state.k[a]! * state.k[b]!;
        }
      }
      dkdt[mu] = -acc;
    }
    return { dxdt, dkdt };
  };

  const rk4Step = (state: { x: number[]; k: number[] }, h: number) => {
    const k1 = rhs(state);
    const s2 = {
      x: state.x.map((v, i) => v + 0.5 * h * k1.dxdt[i]!),
      k: state.k.map((v, i) => v + 0.5 * h * k1.dkdt[i]!),
    };
    const k2 = rhs(s2);
    const s3 = {
      x: state.x.map((v, i) => v + 0.5 * h * k2.dxdt[i]!),
      k: state.k.map((v, i) => v + 0.5 * h * k2.dkdt[i]!),
    };
    const k3 = rhs(s3);
    const s4 = {
      x: state.x.map((v, i) => v + h * k3.dxdt[i]!),
      k: state.k.map((v, i) => v + h * k3.dkdt[i]!),
    };
    const k4 = rhs(s4);
    return {
      x: state.x.map(
        (v, i) =>
          v +
          (h / 6) *
            (k1.dxdt[i]! + 2 * k2.dxdt[i]! + 2 * k3.dxdt[i]! + k4.dxdt[i]!),
      ),
      k: state.k.map(
        (v, i) =>
          v +
          (h / 6) *
            (k1.dkdt[i]! + 2 * k2.dkdt[i]! + 2 * k3.dkdt[i]! + k4.dkdt[i]!),
      ),
    };
  };

  const integrate = (
    spatial: [number, number, number],
    h: number,
    steps: number,
  ): { x: [number, number, number]; residual: number } => {
    const k0 = solveNullK0(spatial);
    let state = {
      x: [0, 0, 0, 0] as number[],
      k: [k0, spatial[0], spatial[1], spatial[2]] as number[],
    };
    let maxResidual = nullResidual(state.k);
    for (let step = 0; step < steps; step += 1) {
      state = rk4Step(state, h);
      maxResidual = Math.max(maxResidual, nullResidual(state.k));
    }
    return {
      x: [state.x[1]!, state.x[2]!, state.x[3]!],
      residual: maxResidual,
    };
  };

  const dirs: Array<[number, number, number]> = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 1, 0],
    [1, -1, 0],
    [1, 0, 1],
    [1, 0, -1],
    [0, 1, 1],
    [0, 1, -1],
    [1, 1, 1],
    [1, -1, 1],
    [1, 1, -1],
  ].map((v) => {
    const mag = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / mag, v[1] / mag, v[2] / mag] as [number, number, number];
  });

  const h = Math.max(1e-5, Math.min(dx, dy, dz) * 0.45);
  const coarseSteps = 10;
  const fineSteps = coarseSteps * 2;
  let maxNullResidual = 0;
  let convNumer = 0;
  let convDenom = 0;
  const endpoints: Array<[number, number, number]> = [];
  for (const dir of dirs) {
    const coarse = integrate(dir, h, coarseSteps);
    const fine = integrate(dir, h * 0.5, fineSteps);
    maxNullResidual = Math.max(maxNullResidual, coarse.residual, fine.residual);
    endpoints.push(fine.x);
    const d = Math.hypot(
      coarse.x[0] - fine.x[0],
      coarse.x[1] - fine.x[1],
      coarse.x[2] - fine.x[2],
    );
    const scale = Math.max(Math.hypot(fine.x[0], fine.x[1], fine.x[2]), h);
    convNumer += d;
    convDenom += scale;
  }
  const stepError = convDenom > 0 ? convNumer / convDenom : 1;
  const stepConvergence = clamp(1 / (1 + 6 * stepError), 0, 1);
  const mean = endpoints.reduce(
    (acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]] as [number, number, number],
    [0, 0, 0] as [number, number, number],
  );
  const invN = endpoints.length > 0 ? 1 / endpoints.length : 0;
  const centerPoint: [number, number, number] = [
    mean[0] * invN,
    mean[1] * invN,
    mean[2] * invN,
  ];
  const spreadSq =
    endpoints.length > 0
      ? endpoints.reduce((acc, p) => {
          const dxp = p[0] - centerPoint[0];
          const dyp = p[1] - centerPoint[1];
          const dzp = p[2] - centerPoint[2];
          return acc + dxp * dxp + dyp * dyp + dzp * dzp;
        }, 0) / endpoints.length
      : 0;
  const bundleSpread = Math.sqrt(Math.max(0, spreadSq));

  const consistency: TensorGeodesicDiagnostics["consistency"] =
    maxNullResidual <= 2.5e-3 && stepConvergence >= 0.9
      ? "ok"
      : maxNullResidual <= 1.0e-2 && stepConvergence >= 0.75
        ? "warn"
        : "fail";

  return { maxNullResidual, stepConvergence, bundleSpread, consistency };
};

const buildTensorRenderContext = (
  payload: HullMisRenderRequestV1,
  brick: GrBrickDecoded,
): TensorRenderContext | null => {
  const spacing = brick.voxelSize_m;
  const radiusFallback = Math.max(1e-3, toFiniteNumber(payload.solve?.R, 1));
  let supportProjection = buildHullSupportProjection(brick);
  const candidates: Array<{ key: string; bias: number }> = [
    { key: "theta", bias: 1.6 },
    { key: "K_trace", bias: 1.4 },
    { key: "rho", bias: 1.0 },
  ];
  let metricChannel: string | null = null;
  let data: Float32Array | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const channel = brick.channels[candidate.key];
    if (!channel || !(channel.data instanceof Float32Array)) continue;
    if (channel.data.length < brick.dims[0] * brick.dims[1] * brick.dims[2]) continue;
    const selected = selectAdaptiveSliceXZ(brick, candidate.key);
    const supportPct = selected?.supportPct ?? 0;
    const score =
      computeSliceSignalScore(selected?.data ?? channel.data, supportPct, "diverging") +
      candidate.bias;
    if (score > bestScore) {
      bestScore = score;
      metricChannel = candidate.key;
      data = channel.data;
    }
  }
  if (!metricChannel || !data) return null;
  const sampleX = sampleMetricAxisRadius({
    data,
    dims: brick.dims,
    spacingM: spacing,
    axis: 0,
  });
  const sampleY = sampleMetricAxisRadius({
    data,
    dims: brick.dims,
    spacingM: spacing,
    axis: 1,
  });
  const sampleZ = sampleMetricAxisRadius({
    data,
    dims: brick.dims,
    spacingM: spacing,
    axis: 2,
  });
  const metricRadiiM: [number, number, number] = [
    sampleX.radiusM ?? radiusFallback,
    sampleY.radiusM ?? radiusFallback,
    sampleZ.radiusM ?? radiusFallback,
  ];
  const meanRadius =
    (metricRadiiM[0] + metricRadiiM[1] + metricRadiiM[2]) / 3 || radiusFallback;
  const anisotropy: [number, number, number] = [
    clamp(metricRadiiM[0] / Math.max(meanRadius, 1e-6), 0.45, 2.2),
    clamp(metricRadiiM[1] / Math.max(meanRadius, 1e-6), 0.45, 2.2),
    clamp(metricRadiiM[2] / Math.max(meanRadius, 1e-6), 0.45, 2.2),
  ];
  if (!supportProjection) {
    supportProjection = buildAnalyticHullSupportProjection(
      brick,
      metricRadiiM,
      anisotropy,
    );
  }
  const diagnostics = computeTensorGeodesicDiagnostics(brick);
  return {
    metricSource: brick.source ?? payload.metricSummary?.source ?? null,
    chart: brick.chart ?? payload.metricSummary?.chart ?? null,
    metricChannel,
    metricRadiiM,
    anisotropy,
    supportProjection,
    supportCoveragePct: supportProjection?.coveragePct ?? 0,
    maskedOutPct: supportProjection?.maskedOutPct ?? 100,
    supportMaskKind: supportProjection?.kind ?? "missing",
    diagnostics,
  };
};

const buildTensorAttachments = (
  payload: HullMisRenderRequestV1,
  ctx: TensorRenderContext,
): HullMisRenderAttachmentV1[] => {
  const width = Math.max(1, payload.width | 0);
  const height = Math.max(1, payload.height | 0);
  const total = width * height;
  const depth = new Float32Array(total);
  const mask = new Uint8Array(total);
  const depthBase = 8;
  const supportProjection = ctx.supportProjection;
  if (supportProjection) {
    const signed = supportProjection.signedHullSdf;
    const beta = toFiniteNumber(payload.solve?.beta, 0);
    const perturbAmp = clamp(
      0.002 +
        2.0 * Math.abs(ctx.diagnostics.maxNullResidual) +
        0.015 * Math.abs(ctx.diagnostics.bundleSpread),
      0,
      0.03,
    );
    for (let y = 0; y < height; y += 1) {
      const sy = height > 1 ? (y / (height - 1)) * (supportProjection.height - 1) : 0;
      for (let x = 0; x < width; x += 1) {
        const sx = width > 1 ? (x / (width - 1)) * (supportProjection.width - 1) : 0;
        const idx = y * width + x;
        const supportValue = sampleGridNearest(
          supportProjection.data,
          supportProjection.width,
          supportProjection.height,
          sx,
          sy,
        );
        if (!(supportValue > 0.5)) {
          depth[idx] = depthBase;
          mask[idx] = 0;
          continue;
        }
        const depthSource = signed
          ? sampleGridBilinear(signed, supportProjection.width, supportProjection.height, sx, sy)
          : supportValue;
        const depthValue =
          depthBase +
          Math.max(0, -depthSource) * 0.85 +
          perturbAmp * Math.sin(6.2 * sx + 5.1 * sy + 0.9 * beta);
        depth[idx] = Number.isFinite(depthValue) ? depthValue : depthBase;
        mask[idx] = 255;
      }
    }
  } else {
    const sx = ctx.anisotropy[0];
    const sy = ctx.anisotropy[1];
    const rz = Math.max(1e-3, ctx.metricRadiiM[2]);
    const beta = toFiniteNumber(payload.solve?.beta, 0);
    const perturbAmp = clamp(
      0.003 +
        3.0 * Math.abs(ctx.diagnostics.maxNullResidual) +
        0.02 * Math.abs(ctx.diagnostics.bundleSpread),
      0,
      0.035,
    );
    for (let y = 0; y < height; y += 1) {
      const ny = height > 1 ? (y / (height - 1)) * 2 - 1 : 0;
      for (let x = 0; x < width; x += 1) {
        const nx = width > 1 ? (x / (width - 1)) * 2 - 1 : 0;
        const idx = y * width + x;
        const q = 1 - (nx * nx) / (sx * sx) - (ny * ny) / (sy * sy);
        if (!(q > 0)) {
          depth[idx] = depthBase;
          mask[idx] = 0;
          continue;
        }
        const perturb = perturbAmp * Math.sin(6.2 * nx + 5.1 * ny + 0.9 * beta);
        const depthValue = depthBase + rz * Math.sqrt(q) + perturb;
        depth[idx] = Number.isFinite(depthValue) ? depthValue : depthBase;
        mask[idx] = 255;
      }
    }
  }
  const depthBytes = Buffer.from(depth.buffer.slice(0));
  const maskBytes = Buffer.from(mask.buffer.slice(0));
  return [
    {
      kind: "depth-linear-m-f32le",
      width,
      height,
      encoding: "base64",
      dataBase64: depthBytes.toString("base64"),
    },
    {
      kind: "shell-mask-u8",
      width,
      height,
      encoding: "base64",
      dataBase64: maskBytes.toString("base64"),
    },
  ];
};

type ScientificSliceMode = "diverging" | "sequential";
type ScientificRenderSamplingMode = HullScientificSamplingMode;
type ScientificSlice = {
  key: string;
  label: string;
  unit: string;
  mode: ScientificSliceMode;
  width: number;
  height: number;
  data: Float32Array;
  min: number;
  max: number;
  sampling:
    | "x-z midplane"
    | "x-z max-|value| projection"
    | "x-z y-integral projection"
    | "x-rho cylindrical remap";
  supportPct: number;
  annotation?: string | null;
};

type ScientificPanelPlacement = {
  x: number;
  y: number;
  width: number;
  height: number;
  slice: ScientificSlice;
};

type ScientificRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type VolumeFieldSelection = {
  key: string;
  label: string;
  mode: ScientificSliceMode;
  data: Float32Array;
  min: number;
  max: number;
};

type ScientificTransportRenderStats = {
  method: "christoffel-null-bundle" | "proxy-raymarch" | "unavailable";
  rays: number;
  samples: number;
  maxNullResidual: number;
  meanNullResidual: number;
  escapedPct: number;
  displayGain: number;
  shellAssist: number;
  lowSignal: boolean;
};

type YorkSurfaceRenderStats = {
  minTheta: number;
  maxTheta: number;
  maxAbsTheta: number;
  nearZeroTheta: boolean;
  zeroContourSegments: number;
  displayGain: number;
  heightScale: number;
  samplingChoice: ScientificSlice["sampling"];
  coordinateMode: "x-z-midplane" | "x-rho";
  nx: number;
  nz: number;
};

type YorkFrameDiagnosticStats = {
  thetaMinRaw: number;
  thetaMaxRaw: number;
  thetaAbsMaxRaw: number;
  thetaMinDisplay: number;
  thetaMaxDisplay: number;
  thetaAbsMaxDisplay: number;
  displayRangeMethod: string;
  nearZeroTheta: boolean;
  zeroContourSegments: number;
  displayGain: number;
  heightScale: number;
  samplingChoice: ScientificSlice["sampling"];
  coordinateMode: "x-z-midplane" | "x-rho";
  supportedThetaFraction: number;
  shellThetaOverlapPct: number;
  peakThetaCell: [number, number, number] | null;
  peakThetaInSupportedRegion: boolean;
  nx: number;
  nz: number;
};

type YorkShellLocalizedSliceStats = {
  shellThetaDisplaySlice: Float32Array;
  shellThetaMaskedSlice: Float32Array;
  shellMaskSlice: Float32Array;
  thetaShellMinRaw: number;
  thetaShellMaxRaw: number;
  thetaShellAbsMaxRaw: number;
  thetaShellMinDisplay: number;
  thetaShellMaxDisplay: number;
  thetaShellAbsMaxDisplay: number;
  shellSupportCount: number;
  shellActiveCount: number;
  shellSupportPct: number;
};

type ShiftShellRenderStats = {
  betaMin: number;
  betaMax: number;
  betaAbsMax: number;
  sliceSupportPct: number;
  supportOverlapPct: number;
  hullContourSegments: number;
  supportContourSegments: number;
  shellContourSegments: number;
  peakBetaCell: [number, number, number] | null;
  peakBetaInSupportedRegion: boolean | null;
  nx: number;
  nz: number;
};

type SignedSliceStats = {
  negativePct: number;
  positivePct: number;
  nearZeroPct: number;
  mean: number;
  min: number;
  max: number;
};

const fmtScientific = (value: number | null | undefined, digits = 3): string => {
  if (!Number.isFinite(value ?? NaN)) return "--";
  const n = Number(value);
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e4 || abs < 1e-3)) return n.toExponential(2);
  return n.toFixed(digits);
};

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const writePixel = (
  image: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a = 255,
) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const idx = (y * width + x) * 4;
  image[idx] = toByte(r);
  image[idx + 1] = toByte(g);
  image[idx + 2] = toByte(b);
  image[idx + 3] = toByte(a);
};

const fillRect = (
  image: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: [number, number, number],
) => {
  const x0 = clampi(x, 0, width - 1);
  const y0 = clampi(y, 0, height - 1);
  const x1 = clampi(x + w - 1, 0, width - 1);
  const y1 = clampi(y + h - 1, 0, height - 1);
  for (let py = y0; py <= y1; py += 1) {
    for (let px = x0; px <= x1; px += 1) {
      writePixel(image, width, height, px, py, color[0], color[1], color[2], 255);
    }
  }
};

const drawRectStroke = (
  image: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: [number, number, number],
) => {
  const x0 = clampi(x, 0, width - 1);
  const y0 = clampi(y, 0, height - 1);
  const x1 = clampi(x + w - 1, 0, width - 1);
  const y1 = clampi(y + h - 1, 0, height - 1);
  for (let px = x0; px <= x1; px += 1) {
    writePixel(image, width, height, px, y0, color[0], color[1], color[2], 255);
    writePixel(image, width, height, px, y1, color[0], color[1], color[2], 255);
  }
  for (let py = y0; py <= y1; py += 1) {
    writePixel(image, width, height, x0, py, color[0], color[1], color[2], 255);
    writePixel(image, width, height, x1, py, color[0], color[1], color[2], 255);
  }
};

const sampleFinite = (data: Float32Array, maxSamples = 4096): number[] => {
  if (data.length === 0) return [];
  const stride = Math.max(1, Math.floor(data.length / maxSamples));
  const out: number[] = [];
  for (let i = 0; i < data.length; i += stride) {
    const v = data[i];
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
};

const computeSliceRawFiniteRange = (data: Float32Array): [number, number] => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 0];
  return [min, max];
};

const detectMeaningfulSignedThetaStructure = (
  data: Float32Array,
  absMax: number,
): boolean => {
  if (!(data instanceof Float32Array) || data.length === 0) return false;
  const structuralFloor = Math.max(Math.abs(absMax) * 1e-3, 1e-45);
  let positive = 0;
  let negative = 0;
  for (let i = 0; i < data.length; i += 1) {
    const value = data[i];
    if (!Number.isFinite(value) || Math.abs(value) < structuralFloor) continue;
    if (value > 0) positive += 1;
    else if (value < 0) negative += 1;
    if (positive >= 2 && negative >= 2) return true;
  }
  return false;
};

const percentile = (values: number[], q: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const t = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(t);
  const hi = Math.min(sorted.length - 1, lo + 1);
  const w = t - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
};

const computeSliceRange = (
  data: Float32Array,
  mode: ScientificSliceMode,
): [number, number] => {
  const values = sampleFinite(data, 8192);
  if (!values.length) return [-1, 1];
  if (mode === "diverging") {
    const absValues = values.map((v) => Math.abs(v));
    const absP = percentile(absValues, 0.98);
    if (absP > 0) return [-absP, absP];
    const absMax = Math.max(...absValues);
    const pad = absMax > 0 ? absMax : 1e-45;
    return [-pad, pad];
  }
  const lo = percentile(values, 0.02);
  const hi = percentile(values, 0.98);
  const magnitude = Math.max(Math.abs(lo), Math.abs(hi), 1e-45);
  if (Math.abs(hi - lo) < magnitude * 1e-6) {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const fullMagnitude = Math.max(Math.abs(min), Math.abs(max), 1e-45);
    if (Math.abs(max - min) < fullMagnitude * 1e-6) {
      const pad = Math.max(fullMagnitude * 0.05, 1e-45);
      return [min - pad, max + pad];
    }
    return [min, max];
  }
  return [lo, hi];
};

const computeSliceSignalScore = (
  data: Float32Array,
  supportPct: number,
  mode: ScientificSliceMode,
): number => {
  const values = sampleFinite(data, 4096);
  if (!values.length) return Number.NEGATIVE_INFINITY;
  const absValues = values.map((v) => Math.abs(v));
  const p95 = Math.max(percentile(absValues, 0.95), 0);
  const p50 = Math.max(percentile(absValues, 0.5), 1e-30);
  const contrast = clamp(p95 / p50, 1, 1e12);
  const contrastScore = Math.log10(contrast);
  const supportScore = clamp(supportPct / 12, 0, 8);
  if (mode !== "diverging") return supportScore + contrastScore;
  const lo = percentile(values, 0.02);
  const hi = percentile(values, 0.98);
  const signedScore = lo < 0 && hi > 0 ? 0.8 : 0.15;
  return supportScore + contrastScore + signedScore;
};

const computeSignedSliceStats = (data: Float32Array): SignedSliceStats => {
  if (data.length === 0) {
    return {
      negativePct: 0,
      positivePct: 0,
      nearZeroPct: 100,
      mean: 0,
      min: 0,
      max: 0,
    };
  }
  let absMax = 0;
  let sum = 0;
  let n = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    const absV = Math.abs(v);
    if (absV > absMax) absMax = absV;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    n += 1;
  }
  if (n === 0) {
    return {
      negativePct: 0,
      positivePct: 0,
      nearZeroPct: 100,
      mean: 0,
      min: 0,
      max: 0,
    };
  }
  const zeroBand = Math.max(absMax * 1e-3, 1e-45);
  let neg = 0;
  let pos = 0;
  let nearZero = 0;
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    if (Math.abs(v) <= zeroBand) {
      nearZero += 1;
    } else if (v < 0) {
      neg += 1;
    } else {
      pos += 1;
    }
  }
  return {
    negativePct: (100 * neg) / n,
    positivePct: (100 * pos) / n,
    nearZeroPct: (100 * nearZero) / n,
    mean: sum / n,
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 0,
  };
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const interpolateColorStops = (
  tIn: number,
  stops: Array<{ t: number; color: [number, number, number] }>,
): [number, number, number] => {
  const t = clamp(tIn, 0, 1);
  if (stops.length === 0) return [255, 255, 255];
  if (t <= stops[0]!.t) return stops[0]!.color;
  if (t >= stops[stops.length - 1]!.t) return stops[stops.length - 1]!.color;
  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (t < a.t || t > b.t) continue;
    const local = (t - a.t) / Math.max(1e-9, b.t - a.t);
    return [
      Math.round(lerp(a.color[0], b.color[0], local)),
      Math.round(lerp(a.color[1], b.color[1], local)),
      Math.round(lerp(a.color[2], b.color[2], local)),
    ];
  }
  return stops[stops.length - 1]!.color;
};

const mapDivergingColor = (t: number): [number, number, number] =>
  interpolateColorStops(t, [
    { t: 0, color: [49, 54, 149] },
    { t: 0.25, color: [69, 117, 180] },
    { t: 0.5, color: [247, 247, 247] },
    { t: 0.75, color: [244, 109, 67] },
    { t: 1, color: [165, 0, 38] },
  ]);

const mapSequentialColor = (t: number): [number, number, number] =>
  interpolateColorStops(t, [
    { t: 0, color: [68, 1, 84] },
    { t: 0.25, color: [58, 82, 139] },
    { t: 0.5, color: [32, 144, 140] },
    { t: 0.75, color: [94, 201, 98] },
    { t: 1, color: [253, 231, 37] },
  ]);

const normalizeSliceValue = (slice: ScientificSlice, value: number): number => {
  if (!Number.isFinite(value)) return 0.5;
  if (slice.mode === "diverging") {
    const maxAbs = Math.max(Math.abs(slice.min), Math.abs(slice.max), 1e-45);
    return clamp(0.5 + 0.5 * (value / maxAbs), 0, 1);
  }
  return clamp((value - slice.min) / Math.max(1e-45, slice.max - slice.min), 0, 1);
};

const dot3 = (a: [number, number, number], b: [number, number, number]) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const cross3 = (
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const normalize3 = (v: [number, number, number]): [number, number, number] => {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
};

const sampleVolumeTrilinear = (
  data: Float32Array,
  dims: [number, number, number],
  x01: number,
  y01: number,
  z01: number,
): number => {
  const nx = dims[0];
  const ny = dims[1];
  const nz = dims[2];
  const fx = clamp(x01, 0, 1) * Math.max(0, nx - 1);
  const fy = clamp(y01, 0, 1) * Math.max(0, ny - 1);
  const fz = clamp(z01, 0, 1) * Math.max(0, nz - 1);
  const x0 = clampi(Math.floor(fx), 0, nx - 1);
  const y0 = clampi(Math.floor(fy), 0, ny - 1);
  const z0 = clampi(Math.floor(fz), 0, nz - 1);
  const x1 = clampi(x0 + 1, 0, nx - 1);
  const y1 = clampi(y0 + 1, 0, ny - 1);
  const z1 = clampi(z0 + 1, 0, nz - 1);
  const tx = clamp(fx - x0, 0, 1);
  const ty = clamp(fy - y0, 0, 1);
  const tz = clamp(fz - z0, 0, 1);
  const c000 = data[idx3(x0, y0, z0, dims)] ?? 0;
  const c100 = data[idx3(x1, y0, z0, dims)] ?? 0;
  const c010 = data[idx3(x0, y1, z0, dims)] ?? 0;
  const c110 = data[idx3(x1, y1, z0, dims)] ?? 0;
  const c001 = data[idx3(x0, y0, z1, dims)] ?? 0;
  const c101 = data[idx3(x1, y0, z1, dims)] ?? 0;
  const c011 = data[idx3(x0, y1, z1, dims)] ?? 0;
  const c111 = data[idx3(x1, y1, z1, dims)] ?? 0;
  const c00 = lerp(c000, c100, tx);
  const c10 = lerp(c010, c110, tx);
  const c01 = lerp(c001, c101, tx);
  const c11 = lerp(c011, c111, tx);
  const c0 = lerp(c00, c10, ty);
  const c1 = lerp(c01, c11, ty);
  return lerp(c0, c1, tz);
};

const intersectRayUnitBox = (
  origin: [number, number, number],
  dir: [number, number, number],
): { hit: boolean; t0: number; t1: number } => {
  let tMin = -Infinity;
  let tMax = Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    const o = origin[axis]!;
    const d = dir[axis]!;
    if (Math.abs(d) < 1e-9) {
      if (o < 0 || o > 1) return { hit: false, t0: 0, t1: 0 };
      continue;
    }
    const inv = 1 / d;
    let t0 = (0 - o) * inv;
    let t1 = (1 - o) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tMin = Math.max(tMin, t0);
    tMax = Math.min(tMax, t1);
    if (tMax < tMin) return { hit: false, t0: 0, t1: 0 };
  }
  if (!Number.isFinite(tMin) || !Number.isFinite(tMax) || tMax <= 0) {
    return { hit: false, t0: 0, t1: 0 };
  }
  return { hit: true, t0: Math.max(tMin, 0), t1: tMax };
};

const selectVolumeField = (
  brick: GrBrickDecoded,
  ctx: TensorRenderContext,
): VolumeFieldSelection | null => {
  const candidates: Array<{
    key: string;
    label: string;
    mode: ScientificSliceMode;
    bias: number;
  }> = [
    { key: ctx.metricChannel, label: `Transport ${ctx.metricChannel}`, mode: "diverging", bias: 1.1 },
    { key: "theta", label: "Transport theta", mode: "diverging", bias: 0.9 },
    { key: "K_trace", label: "Transport K", mode: "diverging", bias: 0.82 },
    { key: "rho", label: "Transport rho", mode: "sequential", bias: 0.45 },
    { key: "H_constraint", label: "Transport H", mode: "diverging", bias: -1.2 },
  ];
  const seen = new Set<string>();
  let best: VolumeFieldSelection | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (!candidate.key || seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    const channel = brick.channels[candidate.key];
    if (!channel || !(channel.data instanceof Float32Array)) continue;
    const selected = selectAdaptiveSliceXZ(brick, candidate.key);
    const rangeData = selected?.data ?? channel.data;
    const [min, max] = computeSliceRange(rangeData, candidate.mode);
    const supportPct = selected?.supportPct ?? computeSliceSupportPct(rangeData);
    const score =
      computeSliceSignalScore(rangeData, supportPct, candidate.mode) + candidate.bias;
    if (score <= bestScore) continue;
    bestScore = score;
    best = {
      key: candidate.key,
      label: candidate.label,
      mode: candidate.mode,
      data: channel.data,
      min,
      max,
    };
  }
  return best;
};

const selectTransportFieldForFrame = (
  brick: GrBrickDecoded,
  ctx: TensorRenderContext,
): VolumeFieldSelection | null => {
  const candidates: Array<{
    key: string;
    label: string;
    mode: ScientificSliceMode;
    bias: number;
  }> = [
    { key: "theta", label: "Transport theta", mode: "diverging", bias: 1.05 },
    { key: "K_trace", label: "Transport K", mode: "diverging", bias: 0.92 },
    { key: "rho", label: "Transport rho_E", mode: "diverging", bias: 0.88 },
    { key: ctx.metricChannel, label: `Transport ${ctx.metricChannel}`, mode: "diverging", bias: 1.1 },
    { key: "H_constraint", label: "Transport H", mode: "diverging", bias: -1.4 },
  ];
  const seen = new Set<string>();
  let best: VolumeFieldSelection | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (!candidate.key || seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    const channel = brick.channels[candidate.key];
    if (!channel || !(channel.data instanceof Float32Array)) continue;
    const selected = selectAdaptiveSliceXZ(brick, candidate.key);
    const rangeData = selected?.data ?? channel.data;
    const [min, max] = computeSliceRange(rangeData, candidate.mode);
    const supportPct = selected?.supportPct ?? computeSliceSupportPct(rangeData);
    const score =
      computeSliceSignalScore(rangeData, supportPct, candidate.mode) + candidate.bias;
    if (score <= bestScore) continue;
    bestScore = score;
    best = {
      key: candidate.key,
      label: candidate.label,
      mode: candidate.mode,
      data: channel.data,
      min,
      max,
    };
  }
  return best;
};

const drawLine = (
  image: Buffer,
  width: number,
  height: number,
  x0In: number,
  y0In: number,
  x1In: number,
  y1In: number,
  color: [number, number, number],
) => {
  let x0 = Math.round(x0In);
  let y0 = Math.round(y0In);
  const x1 = Math.round(x1In);
  const y1 = Math.round(y1In);
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    writePixel(image, width, height, x0, y0, color[0], color[1], color[2], 255);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      if (x0 === x1) break;
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      if (y0 === y1) break;
      err += dx;
      y0 += sy;
    }
  }
};

const renderYorkSurfacePanel = (
  image: Buffer,
  canvasWidth: number,
  canvasHeight: number,
  rect: ScientificRect,
  slice: ScientificSlice,
): YorkSurfaceRenderStats => {
  const panelBg: [number, number, number] = [8, 14, 22];
  const panelBorder: [number, number, number] = [70, 86, 107];
  fillRect(image, canvasWidth, canvasHeight, rect.x, rect.y, rect.width, rect.height, panelBg);
  drawRectStroke(image, canvasWidth, canvasHeight, rect.x, rect.y, rect.width, rect.height, panelBorder);

  const pad = 8;
  const titlePad = 20;
  const colorbarWidth = Math.max(10, Math.floor(rect.width * 0.035));
  const viewX = rect.x + pad;
  const viewY = rect.y + pad + titlePad;
  const viewW = Math.max(32, rect.width - pad * 3 - colorbarWidth);
  const viewH = Math.max(32, rect.height - (pad * 2 + titlePad));
  const barX = viewX + viewW + pad;
  const barY = viewY;
  const barH = viewH;

  fillRect(image, canvasWidth, canvasHeight, viewX, viewY, viewW, viewH, [9, 17, 29]);
  drawRectStroke(image, canvasWidth, canvasHeight, viewX, viewY, viewW, viewH, [80, 96, 118]);

  const minTheta = Number.isFinite(slice.min) ? slice.min : 0;
  const maxTheta = Number.isFinite(slice.max) ? slice.max : 0;
  const maxAbsTheta = Math.max(Math.abs(minTheta), Math.abs(maxTheta), 1e-45);
  const legacyNearZeroTheta =
    maxAbsTheta <= YORK_NEAR_ZERO_THETA_ABS_THRESHOLD ||
    Math.abs(maxTheta - minTheta) <= YORK_NEAR_ZERO_THETA_ABS_THRESHOLD;
  const hasMeaningfulSignedStructure = detectMeaningfulSignedThetaStructure(
    slice.data,
    maxAbsTheta,
  );
  const nearZeroTheta = legacyNearZeroTheta && !hasMeaningfulSignedStructure;
  const displayGain = 1;

  const yawRad = (38 * Math.PI) / 180;
  const pitchRad = (28 * Math.PI) / 180;
  const cosYaw = Math.cos(yawRad);
  const sinYaw = Math.sin(yawRad);
  const cosPitch = Math.cos(pitchRad);
  const sinPitch = Math.sin(pitchRad);
  const xScalePx = viewW * 0.34;
  const zScalePx = viewW * 0.34;
  const yScalePx = viewH * 0.46;
  const centerX = viewX + viewW * 0.5;
  const centerY = viewY + viewH * 0.66;
  const heightScale = nearZeroTheta ? 0 : 0.9 * displayGain;

  const projectPoint = (
    xN: number,
    zN: number,
    thetaValue: number,
  ): [number, number] => {
    const yN =
      heightScale > 0
        ? clamp(thetaValue / Math.max(maxAbsTheta, 1e-45), -1, 1) * heightScale
        : 0;
    const xw = xN;
    const zw = zN;
    const rx = xw * cosYaw - zw * sinYaw;
    const rz = xw * sinYaw + zw * cosYaw;
    const py = yN * cosPitch - rz * sinPitch;
    return [centerX + rx * xScalePx, centerY - py * yScalePx];
  };

  for (let tick = 0; tick <= 8; tick += 1) {
    const t = tick / 8;
    const xN = -1 + 2 * t;
    const pA = projectPoint(xN, -1, 0);
    const pB = projectPoint(xN, 1, 0);
    drawLine(image, canvasWidth, canvasHeight, pA[0], pA[1], pB[0], pB[1], [34, 48, 66]);
    const zN = -1 + 2 * t;
    const pC = projectPoint(-1, zN, 0);
    const pD = projectPoint(1, zN, 0);
    drawLine(image, canvasWidth, canvasHeight, pC[0], pC[1], pD[0], pD[1], [34, 48, 66]);
  }

  const nx = Math.max(2, slice.width);
  const nz = Math.max(2, slice.height);
  const gridStepX = Math.max(1, Math.floor(nx / 52));
  const gridStepZ = Math.max(1, Math.floor(nz / 52));

  const valueAt = (x: number, z: number): number => {
    const ix = clampi(x, 0, nx - 1);
    const iz = clampi(z, 0, nz - 1);
    return slice.data[iz * nx + ix] ?? 0;
  };

  const colorFor = (value: number): [number, number, number] => {
    const t = clamp(0.5 + 0.5 * (value / Math.max(maxAbsTheta, 1e-45)), 0, 1);
    return mapDivergingColor(t);
  };

  for (let z = 0; z < nz; z += gridStepZ) {
    const zN = -1 + (2 * z) / Math.max(1, nz - 1);
    let prevX = 0;
    let prevY = 0;
    let hasPrev = false;
    let prevValue = 0;
    for (let x = 0; x < nx; x += gridStepX) {
      const xN = -1 + (2 * x) / Math.max(1, nx - 1);
      const value = valueAt(x, z);
      const point = projectPoint(xN, zN, value);
      if (hasPrev) {
        const color = colorFor((prevValue + value) * 0.5);
        drawLine(image, canvasWidth, canvasHeight, prevX, prevY, point[0], point[1], color);
      }
      prevX = point[0];
      prevY = point[1];
      prevValue = value;
      hasPrev = true;
    }
  }

  for (let x = 0; x < nx; x += gridStepX) {
    const xN = -1 + (2 * x) / Math.max(1, nx - 1);
    let prevX = 0;
    let prevY = 0;
    let hasPrev = false;
    let prevValue = 0;
    for (let z = 0; z < nz; z += gridStepZ) {
      const zN = -1 + (2 * z) / Math.max(1, nz - 1);
      const value = valueAt(x, z);
      const point = projectPoint(xN, zN, value);
      if (hasPrev) {
        const color = colorFor((prevValue + value) * 0.5);
        drawLine(image, canvasWidth, canvasHeight, prevX, prevY, point[0], point[1], color);
      }
      prevX = point[0];
      prevY = point[1];
      prevValue = value;
      hasPrev = true;
    }
  }

  let zeroContourSegments = 0;
  const contourStepX = Math.max(1, Math.floor(nx / 90));
  const contourStepZ = Math.max(1, Math.floor(nz / 90));
  for (let z = 0; z < nz - 1; z += contourStepZ) {
    for (let x = 0; x < nx - 1; x += contourStepX) {
      const v00 = valueAt(x, z);
      const v10 = valueAt(x + contourStepX, z);
      const v01 = valueAt(x, z + contourStepZ);
      const v11 = valueAt(x + contourStepX, z + contourStepZ);
      const points: Array<[number, number]> = [];
      const addEdge = (
        ax: number,
        az: number,
        av: number,
        bx: number,
        bz: number,
        bv: number,
      ) => {
        const aNeg = av < 0;
        const bNeg = bv < 0;
        if (aNeg === bNeg) return;
        const denom = bv - av;
        const t = Math.abs(denom) <= 1e-45 ? 0.5 : clamp((-av) / denom, 0, 1);
        points.push([lerp(ax, bx, t), lerp(az, bz, t)]);
      };
      const x0N = -1 + (2 * x) / Math.max(1, nx - 1);
      const x1N = -1 + (2 * (x + contourStepX)) / Math.max(1, nx - 1);
      const z0N = -1 + (2 * z) / Math.max(1, nz - 1);
      const z1N = -1 + (2 * (z + contourStepZ)) / Math.max(1, nz - 1);
      addEdge(x0N, z0N, v00, x1N, z0N, v10);
      addEdge(x1N, z0N, v10, x1N, z1N, v11);
      addEdge(x1N, z1N, v11, x0N, z1N, v01);
      addEdge(x0N, z1N, v01, x0N, z0N, v00);
      if (points.length >= 2) {
        const a = projectPoint(points[0][0], points[0][1], 0);
        const b = projectPoint(points[1][0], points[1][1], 0);
        drawLine(image, canvasWidth, canvasHeight, a[0], a[1], b[0], b[1], [240, 240, 240]);
        zeroContourSegments += 1;
      }
    }
  }

  const axisOrigin = projectPoint(-1.08, -1.08, 0);
  const axisFore = projectPoint(1.08, -1.08, 0);
  const axisAft = projectPoint(-1.08, 1.08, 0);
  const axisTheta = projectPoint(-1.08, -1.08, maxAbsTheta * (nearZeroTheta ? 0 : 1));
  drawLine(
    image,
    canvasWidth,
    canvasHeight,
    axisOrigin[0],
    axisOrigin[1],
    axisFore[0],
    axisFore[1],
    [235, 94, 94],
  );
  drawLine(
    image,
    canvasWidth,
    canvasHeight,
    axisOrigin[0],
    axisOrigin[1],
    axisAft[0],
    axisAft[1],
    [90, 156, 245],
  );
  drawLine(
    image,
    canvasWidth,
    canvasHeight,
    axisOrigin[0],
    axisOrigin[1],
    axisTheta[0],
    axisTheta[1],
    [96, 208, 123],
  );

  for (let py = 0; py < barH; py += 1) {
    const t = 1 - py / Math.max(1, barH - 1);
    const color = mapDivergingColor(t);
    for (let px = 0; px < colorbarWidth; px += 1) {
      writePixel(
        image,
        canvasWidth,
        canvasHeight,
        barX + px,
        barY + py,
        color[0],
        color[1],
        color[2],
        255,
      );
    }
  }
  drawRectStroke(image, canvasWidth, canvasHeight, barX, barY, colorbarWidth, barH, [84, 96, 118]);

  return {
    minTheta,
    maxTheta,
    maxAbsTheta,
    nearZeroTheta,
    zeroContourSegments,
    displayGain,
    heightScale,
    samplingChoice: slice.sampling,
    coordinateMode: scientificSamplingChoiceToCoordinateMode(slice.sampling),
    nx,
    nz,
  };
};

const sampleSliceNearest = (
  slice: ScientificSlice,
  fx: number,
  fy: number,
): number => {
  const x = clampi(Math.round(fx), 0, slice.width - 1);
  const y = clampi(Math.round(fy), 0, slice.height - 1);
  return slice.data[y * slice.width + x] ?? 0;
};

const sampleSliceBilinear = (
  slice: ScientificSlice,
  fx: number,
  fy: number,
): number => {
  const x0 = clampi(Math.floor(fx), 0, slice.width - 1);
  const y0 = clampi(Math.floor(fy), 0, slice.height - 1);
  const x1 = clampi(x0 + 1, 0, slice.width - 1);
  const y1 = clampi(y0 + 1, 0, slice.height - 1);
  const tx = clamp(fx - x0, 0, 1);
  const ty = clamp(fy - y0, 0, 1);
  const v00 = slice.data[y0 * slice.width + x0] ?? 0;
  const v10 = slice.data[y0 * slice.width + x1] ?? 0;
  const v01 = slice.data[y1 * slice.width + x0] ?? 0;
  const v11 = slice.data[y1 * slice.width + x1] ?? 0;
  const vx0 = lerp(v00, v10, tx);
  const vx1 = lerp(v01, v11, tx);
  return lerp(vx0, vx1, ty);
};

const sampleSliceValue = (
  slice: ScientificSlice,
  fx: number,
  fy: number,
  samplingMode: ScientificRenderSamplingMode,
): number =>
  samplingMode === "nearest"
    ? sampleSliceNearest(slice, fx, fy)
    : sampleSliceBilinear(slice, fx, fy);

const extractChannelSliceXZMidplane = (
  brick: GrBrickDecoded,
  channelName: string,
): Float32Array | null => {
  const channel = brick.channels[channelName];
  if (!channel) return null;
  const src = channel.data;
  const dims = brick.dims;
  const nx = dims[0];
  const ny = dims[1];
  const nz = dims[2];
  if (src.length < nx * ny * nz) return null;
  const yMid = clampi(Math.floor(ny * 0.5), 0, ny - 1);
  const out = new Float32Array(nx * nz);
  for (let z = 0; z < nz; z += 1) {
    for (let x = 0; x < nx; x += 1) {
      out[z * nx + x] = src[idx3(x, yMid, z, dims)] ?? 0;
    }
  }
  return out;
};

const extractChannelSliceXZProjection = (
  brick: GrBrickDecoded,
  channelName: string,
): Float32Array | null => {
  const channel = brick.channels[channelName];
  if (!channel) return null;
  const src = channel.data;
  const dims = brick.dims;
  const nx = dims[0];
  const ny = dims[1];
  const nz = dims[2];
  if (src.length < nx * ny * nz) return null;
  const out = new Float32Array(nx * nz);
  for (let z = 0; z < nz; z += 1) {
    for (let x = 0; x < nx; x += 1) {
      let chosen = 0;
      let chosenAbs = -1;
      for (let y = 0; y < ny; y += 1) {
        const v = src[idx3(x, y, z, dims)] ?? 0;
        const absV = Math.abs(v);
        if (absV > chosenAbs) {
          chosen = v;
          chosenAbs = absV;
        }
      }
      out[z * nx + x] = chosen;
    }
  }
  return out;
};

const extractChannelSliceXRho = (
  brick: GrBrickDecoded,
  channelName: string,
): Float32Array | null => {
  const channel = brick.channels[channelName];
  if (!channel) return null;
  const src = channel.data;
  const dims = brick.dims;
  const nx = dims[0];
  const ny = dims[1];
  const nz = dims[2];
  if (nx <= 0 || ny <= 0 || nz <= 0) return null;
  if (src.length < nx * ny * nz) return null;

  // Coordinate policy follows Alcubierre + White plotting conventions.
  // Warp-bubble York plots are shown on a fixed-time slice with motion along x;
  // the transverse plotting coordinate is either cylindrical rho or a fixed
  // Cartesian midplane surrogate.
  const rhoBins = Math.max(2, nz);
  const yCenter = (ny - 1) * 0.5;
  const zCenter = (nz - 1) * 0.5;
  const maxRho = Math.max(1e-9, Math.hypot(Math.max(yCenter, 1), Math.max(zCenter, 1)));

  const out = new Float32Array(nx * rhoBins);
  const sum = new Float64Array(rhoBins);
  const count = new Uint32Array(rhoBins);
  for (let x = 0; x < nx; x += 1) {
    sum.fill(0);
    count.fill(0);
    for (let y = 0; y < ny; y += 1) {
      const dy = y - yCenter;
      for (let z = 0; z < nz; z += 1) {
        const dz = z - zCenter;
        const rhoNorm = Math.hypot(dy, dz) / maxRho;
        const rhoBin = clampi(Math.round(rhoNorm * (rhoBins - 1)), 0, rhoBins - 1);
        const value = src[idx3(x, y, z, dims)] ?? 0;
        sum[rhoBin] += value;
        count[rhoBin] += 1;
      }
    }
    for (let rho = 0; rho < rhoBins; rho += 1) {
      const n = count[rho];
      out[rho * nx + x] = n > 0 ? Number(sum[rho] / n) : 0;
    }
  }
  return out;
};

const computeSliceSupportPct = (data: Float32Array): number => {
  if (data.length === 0) return 0;
  let absMax = 0;
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    const absV = Math.abs(v);
    if (absV > absMax) absMax = absV;
  }
  if (!(absMax > 0)) return 0;
  const eps = Math.max(absMax * 1e-6, 1e-45);
  let count = 0;
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    if (Number.isFinite(v) && Math.abs(v) >= eps) count += 1;
  }
  return (100 * count) / data.length;
};

const selectAdaptiveSliceXZ = (
  brick: GrBrickDecoded,
  channelName: string,
): { data: Float32Array; sampling: ScientificSlice["sampling"]; supportPct: number } | null => {
  const mid = extractChannelSliceXZMidplane(brick, channelName);
  const proj = extractChannelSliceXZProjection(brick, channelName);
  if (!mid && !proj) return null;
  if (mid && !proj) {
    return {
      data: mid,
      sampling: "x-z midplane",
      supportPct: computeSliceSupportPct(mid),
    };
  }
  if (!mid && proj) {
    return {
      data: proj,
      sampling: "x-z max-|value| projection",
      supportPct: computeSliceSupportPct(proj),
    };
  }
  const midSupport = computeSliceSupportPct(mid!);
  const projSupport = computeSliceSupportPct(proj!);
  // Prefer projection whenever it materially increases support. This keeps
  // sparse NHM2 structure visible at coarse lattice sizes.
  if (
    projSupport > midSupport * 1.25 + 0.5 ||
    (midSupport < 8 && projSupport > midSupport + 1)
  ) {
    return {
      data: proj!,
      sampling: "x-z max-|value| projection",
      supportPct: projSupport,
    };
  }
  return {
    data: mid!,
    sampling: "x-z midplane",
    supportPct: midSupport,
  };
};

const selectFixedSliceXZMidplane = (
  brick: GrBrickDecoded,
  channelName: string,
): { data: Float32Array; sampling: ScientificSlice["sampling"]; supportPct: number } | null => {
  const mid = extractChannelSliceXZMidplane(brick, channelName);
  if (!(mid instanceof Float32Array)) return null;
  return {
    data: mid,
    sampling: "x-z midplane",
    supportPct: computeSliceSupportPct(mid),
  };
};

const selectFixedSliceXRho = (
  brick: GrBrickDecoded,
  channelName: string,
): { data: Float32Array; sampling: ScientificSlice["sampling"]; supportPct: number } | null => {
  const rho = extractChannelSliceXRho(brick, channelName);
  if (!(rho instanceof Float32Array)) return null;
  return {
    data: rho,
    sampling: "x-rho cylindrical remap",
    supportPct: computeSliceSupportPct(rho),
  };
};

const scientificSamplingChoiceToCoordinateMode = (
  sampling: ScientificSlice["sampling"],
): "x-z-midplane" | "x-rho" =>
  sampling === "x-rho cylindrical remap" ? "x-rho" : "x-z-midplane";

const computeYorkFrameDiagnostics = (
  brick: GrBrickDecoded,
  samplingPolicy: "midplane" | "x-rho" = "midplane",
): YorkFrameDiagnosticStats => {
  const nx = Math.max(1, brick.dims[0]);
  const selectedSlice =
    samplingPolicy === "x-rho"
      ? selectFixedSliceXRho(brick, "theta")
      : selectFixedSliceXZMidplane(brick, "theta");
  const thetaSlice = selectedSlice?.data ?? null;
  const sliceHeight =
    selectedSlice?.sampling === "x-rho cylindrical remap"
      ? Math.max(1, thetaSlice?.length ? Math.floor(thetaSlice.length / nx) : 1)
      : Math.max(1, brick.dims[2]);
  if (!(thetaSlice instanceof Float32Array)) {
    return {
      thetaMinRaw: 0,
      thetaMaxRaw: 0,
      thetaAbsMaxRaw: 0,
      thetaMinDisplay: 0,
      thetaMaxDisplay: 0,
      thetaAbsMaxDisplay: 0,
      displayRangeMethod: "computeSliceRange:diverging:p98-abs-symmetric",
      nearZeroTheta: true,
      zeroContourSegments: 0,
      displayGain: 1,
      heightScale: 0,
      samplingChoice:
        samplingPolicy === "x-rho" ? "x-rho cylindrical remap" : "x-z midplane",
      coordinateMode: samplingPolicy === "x-rho" ? "x-rho" : "x-z-midplane",
      supportedThetaFraction: 0,
      shellThetaOverlapPct: 0,
      peakThetaCell: null,
      peakThetaInSupportedRegion: false,
      nx,
      nz: sliceHeight,
    };
  }
  const [thetaMinRaw, thetaMaxRaw] = computeSliceRawFiniteRange(thetaSlice);
  const thetaAbsMaxRaw = Math.max(Math.abs(thetaMinRaw), Math.abs(thetaMaxRaw), 1e-45);
  const [thetaMinDisplay, thetaMaxDisplay] = computeSliceRange(thetaSlice, "diverging");
  const thetaAbsMaxDisplay = Math.max(
    Math.abs(thetaMinDisplay),
    Math.abs(thetaMaxDisplay),
    1e-45,
  );
  const displayRangeMethod = "computeSliceRange:diverging:p98-abs-symmetric";
  const legacyNearZeroTheta =
    thetaAbsMaxRaw <= YORK_NEAR_ZERO_THETA_ABS_THRESHOLD ||
    Math.abs(thetaMaxRaw - thetaMinRaw) <= YORK_NEAR_ZERO_THETA_ABS_THRESHOLD;
  const hasMeaningfulSignedStructure = detectMeaningfulSignedThetaStructure(
    thetaSlice,
    thetaAbsMaxRaw,
  );
  const nearZeroTheta = legacyNearZeroTheta && !hasMeaningfulSignedStructure;
  const displayGain = 1;
  const heightScale = nearZeroTheta ? 0 : 0.9 * displayGain;

  const contourStepX = Math.max(1, Math.floor(nx / 90));
  const contourStepZ = Math.max(1, Math.floor(sliceHeight / 90));
  const zeroContourSegments = extractThresholdContourSegments(
    thetaSlice,
    nx,
    sliceHeight,
    0,
    contourStepX,
    contourStepZ,
  ).length;

  const theta3 = brick.channels.theta?.data;
  const hull3 = brick.channels.hull_sdf?.data;
  const support3 = brick.channels.tile_support_mask?.data;
  const region3 = brick.channels.region_class?.data;
  const total = brick.dims[0] * brick.dims[1] * brick.dims[2];
  const supportChannelsAvailable =
    (hull3 instanceof Float32Array && hull3.length >= total) ||
    (support3 instanceof Float32Array && support3.length >= total) ||
    (region3 instanceof Float32Array && region3.length >= total);
  const inSupportAt = (idx: number): boolean => {
    if (!supportChannelsAvailable) return false;
    const hullOn =
      hull3 instanceof Float32Array && hull3.length >= total
        ? (hull3[idx] ?? Number.POSITIVE_INFINITY) <= 0
        : false;
    const supportOn =
      support3 instanceof Float32Array && support3.length >= total
        ? (support3[idx] ?? 0) > 0.5
        : false;
    const regionOn =
      region3 instanceof Float32Array && region3.length >= total
        ? (region3[idx] ?? 0) !== 0
        : false;
    return hullOn || supportOn || regionOn;
  };
  const thetaSupportThreshold = Math.max(thetaAbsMaxRaw * 1e-6, 1e-45);
  let peakThetaCell: [number, number, number] | null = null;
  let peakThetaInSupportedRegion = false;
  let supportCellCount = 0;
  let significantThetaCount = 0;
  let significantThetaSupportedCount = 0;
  let supportWithThetaCount = 0;
  if (theta3 instanceof Float32Array && theta3.length >= total) {
    let bestAbs = -1;
    let bestIdx = -1;
    for (let i = 0; i < total; i += 1) {
      const value = theta3[i];
      if (!Number.isFinite(value)) continue;
      const inSupport = inSupportAt(i);
      if (inSupport) supportCellCount += 1;
      if (Math.abs(value) >= thetaSupportThreshold) {
        significantThetaCount += 1;
        if (inSupport) {
          significantThetaSupportedCount += 1;
          supportWithThetaCount += 1;
        }
      }
      const absValue = Math.abs(value);
      if (absValue > bestAbs) {
        bestAbs = absValue;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const [nx3, ny3] = [brick.dims[0], brick.dims[1]];
      const z = Math.floor(bestIdx / (nx3 * ny3));
      const rem = bestIdx - z * nx3 * ny3;
      const y = Math.floor(rem / nx3);
      const x = rem - y * nx3;
      peakThetaCell = [x, y, z];
      if (supportChannelsAvailable) {
        peakThetaInSupportedRegion = inSupportAt(bestIdx);
      }
    }
  }
  const supportedThetaFraction =
    significantThetaCount > 0
      ? significantThetaSupportedCount / significantThetaCount
      : 0;
  const shellThetaOverlapPct =
    supportCellCount > 0 ? (100 * supportWithThetaCount) / supportCellCount : 0;

  return {
    thetaMinRaw,
    thetaMaxRaw,
    thetaAbsMaxRaw,
    thetaMinDisplay,
    thetaMaxDisplay,
    thetaAbsMaxDisplay,
    displayRangeMethod,
    nearZeroTheta,
    zeroContourSegments,
    displayGain,
    heightScale,
    samplingChoice: selectedSlice.sampling,
    coordinateMode: scientificSamplingChoiceToCoordinateMode(selectedSlice.sampling),
    supportedThetaFraction,
    shellThetaOverlapPct,
    peakThetaCell,
    peakThetaInSupportedRegion,
    nx,
    nz: sliceHeight,
  };
};

const computeYorkShellLocalizedSliceStats = (args: {
  thetaSlice: Float32Array;
  supportSlice: Float32Array;
  regionSlice: Float32Array | null;
}): YorkShellLocalizedSliceStats => {
  const { thetaSlice, supportSlice, regionSlice } = args;
  const n = Math.min(thetaSlice.length, supportSlice.length);
  const shellThetaDisplaySlice = new Float32Array(n);
  const shellThetaMaskedSlice = new Float32Array(n);
  const shellMaskSlice = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    shellThetaMaskedSlice[i] = Number.NaN;
  }

  let useRegionQualifier = false;
  if (regionSlice instanceof Float32Array) {
    const regionN = Math.min(n, regionSlice.length);
    for (let i = 0; i < regionN; i += 1) {
      if (Math.abs(regionSlice[i] ?? 0) > 0.5) {
        useRegionQualifier = true;
        break;
      }
    }
  }

  let shellSupportCount = 0;
  for (let i = 0; i < n; i += 1) {
    const supportActive = (supportSlice[i] ?? 0) > 0.5;
    const regionActive =
      !useRegionQualifier || Math.abs(regionSlice?.[i] ?? 0) > 0.5;
    const inShell = supportActive && regionActive;
    shellMaskSlice[i] = inShell ? 1 : 0;
    if (!inShell) {
      shellThetaDisplaySlice[i] = 0;
      continue;
    }
    shellSupportCount += 1;
    const thetaValue = thetaSlice[i];
    if (Number.isFinite(thetaValue)) {
      shellThetaDisplaySlice[i] = Number(thetaValue);
      shellThetaMaskedSlice[i] = Number(thetaValue);
    } else {
      shellThetaDisplaySlice[i] = 0;
      shellThetaMaskedSlice[i] = Number.NaN;
    }
  }

  const [thetaShellMinRaw, thetaShellMaxRaw] =
    shellSupportCount > 0 ? computeSliceRawFiniteRange(shellThetaMaskedSlice) : [0, 0];
  const thetaShellAbsMaxRaw = Math.max(
    Math.abs(thetaShellMinRaw),
    Math.abs(thetaShellMaxRaw),
    1e-45,
  );
  const [thetaShellMinDisplay, thetaShellMaxDisplay] =
    shellSupportCount > 0 ? computeSliceRange(shellThetaMaskedSlice, "diverging") : [0, 0];
  const thetaShellAbsMaxDisplay = Math.max(
    Math.abs(thetaShellMinDisplay),
    Math.abs(thetaShellMaxDisplay),
    1e-45,
  );

  const shellActivityThreshold = Math.max(thetaShellAbsMaxRaw * 1e-6, 1e-45);
  let shellActiveCount = 0;
  for (let i = 0; i < n; i += 1) {
    const value = shellThetaMaskedSlice[i];
    if (!Number.isFinite(value)) continue;
    if (Math.abs(value) >= shellActivityThreshold) {
      shellActiveCount += 1;
    }
  }

  return {
    shellThetaDisplaySlice,
    shellThetaMaskedSlice,
    shellMaskSlice,
    thetaShellMinRaw,
    thetaShellMaxRaw,
    thetaShellAbsMaxRaw,
    thetaShellMinDisplay,
    thetaShellMaxDisplay,
    thetaShellAbsMaxDisplay,
    shellSupportCount,
    shellActiveCount,
    shellSupportPct: n > 0 ? (100 * shellSupportCount) / n : 0,
  };
};

const extractBetaMagnitudeSliceXZ = (brick: GrBrickDecoded): Float32Array | null => {
  const betaX = brick.channels.beta_x?.data;
  const betaY = brick.channels.beta_y?.data;
  const betaZ = brick.channels.beta_z?.data;
  if (!betaX || !betaY || !betaZ) return null;
  const dims = brick.dims;
  const nx = dims[0];
  const ny = dims[1];
  const nz = dims[2];
  const total = nx * ny * nz;
  if (betaX.length < total || betaY.length < total || betaZ.length < total) return null;
  const yMid = clampi(Math.floor(ny * 0.5), 0, ny - 1);
  const out = new Float32Array(nx * nz);
  for (let z = 0; z < nz; z += 1) {
    for (let x = 0; x < nx; x += 1) {
      const idx = idx3(x, yMid, z, dims);
      const bx = Number.isFinite(betaX[idx]) ? Number(betaX[idx]) : 0;
      const by = Number.isFinite(betaY[idx]) ? Number(betaY[idx]) : 0;
      const bz = Number.isFinite(betaZ[idx]) ? Number(betaZ[idx]) : 0;
      out[z * nx + x] = Math.sqrt(bx * bx + by * by + bz * bz);
    }
  }
  return out;
};

const extractBetaMagnitudeSliceXZProjection = (brick: GrBrickDecoded): Float32Array | null => {
  const betaX = brick.channels.beta_x?.data;
  const betaY = brick.channels.beta_y?.data;
  const betaZ = brick.channels.beta_z?.data;
  if (!betaX || !betaY || !betaZ) return null;
  const dims = brick.dims;
  const nx = dims[0];
  const ny = dims[1];
  const nz = dims[2];
  const total = nx * ny * nz;
  if (betaX.length < total || betaY.length < total || betaZ.length < total) return null;
  const out = new Float32Array(nx * nz);
  for (let z = 0; z < nz; z += 1) {
    for (let x = 0; x < nx; x += 1) {
      let best = 0;
      for (let y = 0; y < ny; y += 1) {
        const idx = idx3(x, y, z, dims);
        const bx = Number.isFinite(betaX[idx]) ? Number(betaX[idx]) : 0;
        const by = Number.isFinite(betaY[idx]) ? Number(betaY[idx]) : 0;
        const bz = Number.isFinite(betaZ[idx]) ? Number(betaZ[idx]) : 0;
        const mag = Math.sqrt(bx * bx + by * by + bz * bz);
        if (mag > best) best = mag;
      }
      out[z * nx + x] = best;
    }
  }
  return out;
};

const extractRhoIntegralSliceXZ = (
  brick: GrBrickDecoded,
): { data: Float32Array; supportPct: number } | null => {
  const rho = brick.channels.rho?.data;
  if (!(rho instanceof Float32Array)) return null;
  const dims = brick.dims;
  const [nx, ny, nz] = dims;
  const total = nx * ny * nz;
  if (rho.length < total) return null;

  const hullSdf = brick.channels.hull_sdf?.data;
  const tileSupportMask = brick.channels.tile_support_mask?.data;
  const regionClass = brick.channels.region_class?.data;
  const hasHullSdf = hullSdf instanceof Float32Array && hullSdf.length >= total;
  const hasTileSupport = tileSupportMask instanceof Float32Array && tileSupportMask.length >= total;
  const hasRegionClass = regionClass instanceof Float32Array && regionClass.length >= total;
  const hasSupportChannels = hasHullSdf || hasTileSupport || hasRegionClass;

  const dyM = Math.max(1e-12, toFiniteNumber(brick.voxelSize_m[1], 1));
  const out = new Float32Array(nx * nz);
  let supportedColumns = 0;
  for (let z = 0; z < nz; z += 1) {
    for (let x = 0; x < nx; x += 1) {
      let accum = 0;
      let columnSupported = false;
      for (let y = 0; y < ny; y += 1) {
        const idx = idx3(x, y, z, dims);
        let supported = true;
        if (hasSupportChannels) {
          supported = false;
          if (hasHullSdf && Number.isFinite(hullSdf![idx]) && (hullSdf![idx] as number) <= 0) {
            supported = true;
          }
          if (!supported && hasTileSupport && Number.isFinite(tileSupportMask![idx]) && (tileSupportMask![idx] as number) > 0.5) {
            supported = true;
          }
          if (!supported && hasRegionClass && Number.isFinite(regionClass![idx]) && (regionClass![idx] as number) !== 0) {
            supported = true;
          }
        }
        if (!supported) continue;
        const value = rho[idx];
        if (!Number.isFinite(value)) continue;
        accum += Number(value) * dyM;
        columnSupported = true;
      }
      out[z * nx + x] = accum;
      if (columnSupported) supportedColumns += 1;
    }
  }
  const supportPct =
    nx > 0 && nz > 0 ? (100 * supportedColumns) / (nx * nz) : 0;
  return { data: out, supportPct };
};

const selectAdaptiveBetaMagnitudeSliceXZ = (
  brick: GrBrickDecoded,
): { data: Float32Array; sampling: ScientificSlice["sampling"]; supportPct: number } | null => {
  const mid = extractBetaMagnitudeSliceXZ(brick);
  const proj = extractBetaMagnitudeSliceXZProjection(brick);
  if (!mid && !proj) return null;
  if (mid && !proj) {
    return {
      data: mid,
      sampling: "x-z midplane",
      supportPct: computeSliceSupportPct(mid),
    };
  }
  if (!mid && proj) {
    return {
      data: proj,
      sampling: "x-z max-|value| projection",
      supportPct: computeSliceSupportPct(proj),
    };
  }
  const midSupport = computeSliceSupportPct(mid!);
  const projSupport = computeSliceSupportPct(proj!);
  if (
    projSupport > midSupport * 1.25 + 0.5 ||
    (midSupport < 8 && projSupport > midSupport + 1)
  ) {
    return {
      data: proj!,
      sampling: "x-z max-|value| projection",
      supportPct: projSupport,
    };
  }
  return {
    data: mid!,
    sampling: "x-z midplane",
    supportPct: midSupport,
  };
};

type SliceContourSegment = {
  axN: number;
  azN: number;
  bxN: number;
  bzN: number;
};

const extractThresholdContourSegments = (
  data: Float32Array,
  width: number,
  height: number,
  threshold: number,
  stepX: number,
  stepY: number,
): SliceContourSegment[] => {
  if (width < 2 || height < 2 || data.length < width * height) return [];
  const sx = Math.max(1, Math.floor(stepX));
  const sy = Math.max(1, Math.floor(stepY));
  const segments: SliceContourSegment[] = [];
  const valueAt = (x: number, y: number): number => {
    const ix = clampi(x, 0, width - 1);
    const iy = clampi(y, 0, height - 1);
    const v = data[iy * width + ix];
    return Number.isFinite(v) ? Number(v) : 0;
  };
  for (let y = 0; y < height - 1; y += sy) {
    for (let x = 0; x < width - 1; x += sx) {
      const x1 = clampi(x + sx, 0, width - 1);
      const y1 = clampi(y + sy, 0, height - 1);
      const v00 = valueAt(x, y) - threshold;
      const v10 = valueAt(x1, y) - threshold;
      const v01 = valueAt(x, y1) - threshold;
      const v11 = valueAt(x1, y1) - threshold;
      const points: Array<[number, number]> = [];
      const addEdge = (
        ax: number,
        ay: number,
        av: number,
        bx: number,
        by: number,
        bv: number,
      ) => {
        const aNeg = av < 0;
        const bNeg = bv < 0;
        if (aNeg === bNeg) return;
        const denom = bv - av;
        const t = Math.abs(denom) <= 1e-45 ? 0.5 : clamp((-av) / denom, 0, 1);
        points.push([lerp(ax, bx, t), lerp(ay, by, t)]);
      };
      const x0N = -1 + (2 * x) / Math.max(1, width - 1);
      const x1N = -1 + (2 * x1) / Math.max(1, width - 1);
      const y0N = -1 + (2 * y) / Math.max(1, height - 1);
      const y1N = -1 + (2 * y1) / Math.max(1, height - 1);
      addEdge(x0N, y0N, v00, x1N, y0N, v10);
      addEdge(x1N, y0N, v10, x1N, y1N, v11);
      addEdge(x1N, y1N, v11, x0N, y1N, v01);
      addEdge(x0N, y1N, v01, x0N, y0N, v00);
      if (points.length >= 2) {
        segments.push({
          axN: points[0]![0],
          azN: points[0]![1],
          bxN: points[1]![0],
          bzN: points[1]![1],
        });
      }
    }
  }
  return segments;
};

const getSlicePanelHeatRect = (panel: ScientificPanelPlacement) => {
  const pad = 8;
  const colorbarWidth = Math.max(10, Math.floor(panel.width * 0.045));
  const heatX = panel.x + pad;
  const heatY = panel.y + pad + 18;
  const heatW = Math.max(24, panel.width - pad * 3 - colorbarWidth);
  const heatH = Math.max(24, panel.height - pad * 2 - 24);
  return { heatX, heatY, heatW, heatH };
};

const drawContourSegmentsOnSlicePanel = (
  image: Buffer,
  canvasWidth: number,
  canvasHeight: number,
  panel: ScientificPanelPlacement,
  segments: readonly SliceContourSegment[],
  color: [number, number, number],
) => {
  if (!segments.length) return;
  const { heatX, heatY, heatW, heatH } = getSlicePanelHeatRect(panel);
  for (const segment of segments) {
    const x0 = heatX + ((segment.axN + 1) * 0.5) * Math.max(1, heatW - 1);
    const y0 = heatY + ((segment.azN + 1) * 0.5) * Math.max(1, heatH - 1);
    const x1 = heatX + ((segment.bxN + 1) * 0.5) * Math.max(1, heatW - 1);
    const y1 = heatY + ((segment.bzN + 1) * 0.5) * Math.max(1, heatH - 1);
    drawLine(image, canvasWidth, canvasHeight, x0, y0, x1, y1, color);
  }
};

const computeShiftShellStats = (
  brick: GrBrickDecoded,
): ShiftShellRenderStats => {
  const betaMid = extractChannelSliceXZMidplane(brick, "beta_x");
  const hullMid = extractChannelSliceXZMidplane(brick, "hull_sdf");
  const supportMid = extractChannelSliceXZMidplane(brick, "tile_support_mask");
  const nx = Math.max(1, brick.dims[0]);
  const nz = Math.max(1, brick.dims[2]);
  if (!(betaMid instanceof Float32Array)) {
    return {
      betaMin: 0,
      betaMax: 0,
      betaAbsMax: 0,
      sliceSupportPct: 0,
      supportOverlapPct: 0,
      hullContourSegments: 0,
      supportContourSegments: 0,
      shellContourSegments: 0,
      peakBetaCell: null,
      peakBetaInSupportedRegion: null,
      nx,
      nz,
    };
  }
  const [betaMin, betaMax] = computeSliceRange(betaMid, "diverging");
  const betaAbsMax = Math.max(Math.abs(betaMin), Math.abs(betaMax), 0);
  const sliceSupportPct = computeSliceSupportPct(betaMid);
  const eps = Math.max(betaAbsMax * 1e-6, 1e-45);
  let supportedAndActive = 0;
  let active = 0;
  for (let i = 0; i < betaMid.length; i += 1) {
    const value = betaMid[i] ?? 0;
    const isActive = Number.isFinite(value) && Math.abs(value) >= eps;
    if (!isActive) continue;
    active += 1;
    const supportOn = (supportMid?.[i] ?? 0) > 0.5;
    const hullOn = (hullMid?.[i] ?? Number.POSITIVE_INFINITY) <= 0;
    if (supportOn || hullOn) supportedAndActive += 1;
  }
  const supportOverlapPct = active > 0 ? (100 * supportedAndActive) / active : 0;

  const contourStepX = Math.max(1, Math.floor(nx / 90));
  const contourStepZ = Math.max(1, Math.floor(nz / 90));
  const hullContourSegments = hullMid
    ? extractThresholdContourSegments(hullMid, nx, nz, 0, contourStepX, contourStepZ).length
    : 0;
  const supportContourSegments = supportMid
    ? extractThresholdContourSegments(
        supportMid,
        nx,
        nz,
        0.5,
        contourStepX,
        contourStepZ,
      ).length
    : 0;

  const beta3 = brick.channels.beta_x?.data;
  const hull3 = brick.channels.hull_sdf?.data;
  const support3 = brick.channels.tile_support_mask?.data;
  const region3 = brick.channels.region_class?.data;
  const total = brick.dims[0] * brick.dims[1] * brick.dims[2];
  const hasBeta3 = beta3 instanceof Float32Array && beta3.length >= total;
  let peakBetaCell: [number, number, number] | null = null;
  let peakBetaInSupportedRegion: boolean | null = null;
  if (hasBeta3) {
    let bestAbs = -1;
    let bestIdx = -1;
    for (let i = 0; i < total; i += 1) {
      const value = beta3[i];
      if (!Number.isFinite(value)) continue;
      const absValue = Math.abs(value);
      if (absValue > bestAbs) {
        bestAbs = absValue;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const [nx3, ny3] = [brick.dims[0], brick.dims[1]];
      const z = Math.floor(bestIdx / (nx3 * ny3));
      const rem = bestIdx - z * nx3 * ny3;
      const y = Math.floor(rem / nx3);
      const x = rem - y * nx3;
      peakBetaCell = [x, y, z];
      const hasAnySupport =
        (hull3 instanceof Float32Array && hull3.length >= total) ||
        (support3 instanceof Float32Array && support3.length >= total) ||
        (region3 instanceof Float32Array && region3.length >= total);
      if (hasAnySupport) {
        const hullOn =
          hull3 instanceof Float32Array && hull3.length >= total
            ? (hull3[bestIdx] ?? Number.POSITIVE_INFINITY) <= 0
            : false;
        const supportOn =
          support3 instanceof Float32Array && support3.length >= total
            ? (support3[bestIdx] ?? 0) > 0.5
            : false;
        const regionOn =
          region3 instanceof Float32Array && region3.length >= total
            ? (region3[bestIdx] ?? 0) !== 0
            : false;
        peakBetaInSupportedRegion = hullOn || supportOn || regionOn;
      }
    }
  }

  return {
    betaMin,
    betaMax,
    betaAbsMax,
    sliceSupportPct,
    supportOverlapPct,
    hullContourSegments,
    supportContourSegments,
    shellContourSegments: hullContourSegments + supportContourSegments,
    peakBetaCell,
    peakBetaInSupportedRegion,
    nx,
    nz,
  };
};

const buildScientificSlices = (brick: GrBrickDecoded): ScientificSlice[] => {
  const nx = brick.dims[0];
  const nz = brick.dims[2];
  const channelCandidates: Array<{
    key: string;
    label: string;
    unit: string;
    mode: ScientificSliceMode;
    bias: number;
  }> = [
    {
      key: "theta",
      label: "Expansion theta = -K",
      unit: "1/m",
      mode: "diverging",
      bias: 1.2,
    },
    {
      key: "K_trace",
      label: "Extrinsic Curvature K",
      unit: "1/m",
      mode: "diverging",
      bias: 1.0,
    },
  ];
  let expansionSlice: ScientificSlice | null = null;
  let expansionScore = Number.NEGATIVE_INFINITY;
  for (const candidate of channelCandidates) {
    const selected = selectAdaptiveSliceXZ(brick, candidate.key);
    if (!selected) continue;
    const [min, max] = computeSliceRange(selected.data, candidate.mode);
    const score =
      computeSliceSignalScore(selected.data, selected.supportPct, candidate.mode) + candidate.bias;
    if (score <= expansionScore) continue;
    expansionScore = score;
    expansionSlice = {
      key: candidate.key,
      label: candidate.label,
      unit: candidate.unit,
      mode: candidate.mode,
      width: nx,
      height: nz,
      data: selected.data,
      min,
      max,
      sampling: selected.sampling,
      supportPct: selected.supportPct,
    };
  }
  const hSelected = selectAdaptiveSliceXZ(brick, "H_constraint");
  const rhoIntegral = extractRhoIntegralSliceXZ(brick);
  const rhoSelected = selectAdaptiveSliceXZ(brick, "rho");
  const betaMagSelected = selectAdaptiveBetaMagnitudeSliceXZ(brick);
  const fallback = (label: string, mode: ScientificSliceMode): ScientificSlice => ({
    key: `missing-${label.toLowerCase().replace(/\s+/g, "-")}`,
    label,
    unit: "n/a",
    mode,
    width: nx,
    height: nz,
    data: new Float32Array(nx * nz),
    min: mode === "diverging" ? -1 : 0,
    max: 1,
    sampling: "x-z midplane",
    supportPct: 0,
    annotation: null,
  });
  const hSlice =
    hSelected != null
      ? (() => {
          const [min, max] = computeSliceRange(hSelected.data, "diverging");
          return {
            key: "H_constraint",
            label: "Hamiltonian Constraint H",
            unit: "arb",
            mode: "diverging" as const,
            width: nx,
            height: nz,
            data: hSelected.data,
            min,
            max,
            sampling: hSelected.sampling,
            supportPct: hSelected.supportPct,
            annotation: null,
          };
        })()
      : fallback("Hamiltonian Constraint H (missing)", "diverging");
  const rhoSlice =
    rhoIntegral != null
      ? (() => {
          const [min, max] = computeSliceRange(rhoIntegral.data, "diverging");
          const signedStats = computeSignedSliceStats(rhoIntegral.data);
          return {
            key: "rho_eulerian_line_integral",
            label: "Eulerian Line Integral I_rho = ∫ rho_E dy",
            unit: "J/m^2 (line integral along y)",
            mode: "diverging" as const,
            width: nx,
            height: nz,
            data: rhoIntegral.data,
            min,
            max,
            sampling: "x-z y-integral projection" as const,
            supportPct: rhoIntegral.supportPct,
            annotation:
              `neg=${fmtScientific(signedStats.negativePct, 1)}%` +
              ` pos=${fmtScientific(signedStats.positivePct, 1)}%` +
              ` near0=${fmtScientific(signedStats.nearZeroPct, 1)}%`,
          };
        })()
      : rhoSelected != null
      ? (() => {
          const [min, max] = computeSliceRange(rhoSelected.data, "diverging");
          const signedStats = computeSignedSliceStats(rhoSelected.data);
          return {
            key: "rho_eulerian",
            label: "Eulerian Energy Density rho_E = T_{mu nu} n^mu n^nu",
            unit: "J/m^3 (pipeline contract)",
            mode: "diverging" as const,
            width: nx,
            height: nz,
            data: rhoSelected.data,
            min,
            max,
            sampling: rhoSelected.sampling,
            supportPct: rhoSelected.supportPct,
            annotation:
              `neg=${fmtScientific(signedStats.negativePct, 1)}%` +
              ` pos=${fmtScientific(signedStats.positivePct, 1)}%` +
              ` near0=${fmtScientific(signedStats.nearZeroPct, 1)}%`,
          };
        })()
      : fallback("Eulerian Energy Density rho_E (missing)", "diverging");
  const betaSlice =
    betaMagSelected != null
      ? (() => {
          const [min, max] = computeSliceRange(betaMagSelected.data, "sequential");
          return {
            key: "beta_mag",
            label: "Shift Magnitude |beta|",
            unit: "unitless",
            mode: "sequential" as const,
            width: nx,
            height: nz,
            data: betaMagSelected.data,
            min,
            max,
            sampling: betaMagSelected.sampling,
            supportPct: betaMagSelected.supportPct,
            annotation: null,
          };
        })()
      : fallback("Shift Magnitude |beta| (missing)", "sequential");
  if (expansionSlice && expansionSlice.supportPct < 5) {
    expansionSlice = {
      ...expansionSlice,
      label: `${expansionSlice.label} (low-support regime)`,
    };
  }
  return [
    rhoSlice,
    expansionSlice ?? fallback("Expansion theta/K (missing)", "diverging"),
    hSlice,
    betaSlice,
  ];
};

const readMetricRefSourceNumber = (
  params: URLSearchParams,
  key: string,
): number | null => {
  const raw = params.get(key);
  if (raw == null || raw.trim().length === 0) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const parseMetricRefSourceParams = (
  payload: HullMisRenderRequestV1,
): MetricRefSourceParams | null => {
  const rawUrl = payload.metricVolumeRef?.url;
  if (!rawUrl || rawUrl.trim().length === 0) return null;
  try {
    const parsed = new URL(rawUrl, "http://127.0.0.1");
    const query = parsed.searchParams;
    const out: MetricRefSourceParams = {
      dutyFR: readMetricRefSourceNumber(query, "dutyFR"),
      q: readMetricRefSourceNumber(query, "q"),
      gammaGeo: readMetricRefSourceNumber(query, "gammaGeo"),
      gammaVdB: readMetricRefSourceNumber(query, "gammaVdB"),
      zeta: readMetricRefSourceNumber(query, "zeta"),
      phase01: readMetricRefSourceNumber(query, "phase01"),
      metricT00: readMetricRefSourceNumber(query, "metricT00"),
      metricT00Source: query.get("metricT00Source"),
      metricT00Ref: query.get("metricT00Ref"),
    };
    const hasAny = Object.values(out).some(
      (value) => value != null && !(typeof value === "string" && value.length === 0),
    );
    return hasAny ? out : null;
  } catch {
    return null;
  }
};

const summarizeMetricRefSourceParams = (
  sourceParams: MetricRefSourceParams | null,
): string | null => {
  if (!sourceParams) return null;
  const entries: string[] = [];
  if (sourceParams.dutyFR != null) entries.push(`dutyFR=${fmtScientific(sourceParams.dutyFR, 3)}`);
  if (sourceParams.q != null) entries.push(`q=${fmtScientific(sourceParams.q, 3)}`);
  if (sourceParams.gammaGeo != null) {
    entries.push(`gammaGeo=${fmtScientific(sourceParams.gammaGeo, 3)}`);
  }
  if (sourceParams.gammaVdB != null) {
    entries.push(`gammaVdB=${fmtScientific(sourceParams.gammaVdB, 3)}`);
  }
  if (sourceParams.zeta != null) entries.push(`zeta=${fmtScientific(sourceParams.zeta, 3)}`);
  if (sourceParams.phase01 != null) {
    entries.push(`phase01=${fmtScientific(sourceParams.phase01, 3)}`);
  }
  if (sourceParams.metricT00 != null) {
    entries.push(`T00=${fmtScientific(sourceParams.metricT00, 3)}`);
  }
  if (sourceParams.metricT00Source) {
    entries.push(`T00src=${sourceParams.metricT00Source}`);
  }
  if (sourceParams.metricT00Ref) {
    entries.push(`T00ref=${sourceParams.metricT00Ref}`);
  }
  return entries.length > 0 ? entries.join(", ") : null;
};

const channelRms = (channel: Float32Array | undefined | null): number => {
  if (!(channel instanceof Float32Array) || channel.length === 0) return 0;
  let acc = 0;
  let n = 0;
  for (let i = 0; i < channel.length; i += 1) {
    const v = channel[i];
    if (!Number.isFinite(v)) continue;
    acc += v * v;
    n += 1;
  }
  return n > 0 ? Math.sqrt(acc / n) : 0;
};

const parseMetricRefTime = (
  payload: HullMisRenderRequestV1,
): { timeS: number; dtS: number } => {
  const fallbackTime = toFiniteNumber(payload.timestampMs, Date.now()) / 1000;
  const rawUrl = payload.metricVolumeRef?.url;
  if (!rawUrl || rawUrl.trim().length === 0) return { timeS: fallbackTime, dtS: 0 };
  try {
    const parsed = new URL(rawUrl, "http://127.0.0.1");
    const timeS = toFiniteNumber(parsed.searchParams.get("time_s"), fallbackTime);
    const dtS = Math.max(0, toFiniteNumber(parsed.searchParams.get("dt_s"), 0));
    return { timeS, dtS };
  } catch {
    return { timeS: fallbackTime, dtS: 0 };
  }
};

const buildTemporalHistoryKey = (
  payload: HullMisRenderRequestV1,
  ctx: TensorRenderContext,
): string => {
  const src = ctx.metricSource ?? payload.metricSummary?.source ?? "unknown-source";
  const chart = ctx.chart ?? payload.solve?.chart ?? payload.metricSummary?.chart ?? "unknown-chart";
  return `${src}|${chart}`;
};

const appendTemporalHistory = (
  payload: HullMisRenderRequestV1,
  brick: GrBrickDecoded,
  ctx: TensorRenderContext,
): TemporalHistorySnapshot => {
  const key = buildTemporalHistoryKey(payload, ctx);
  const { timeS, dtS } = parseMetricRefTime(payload);
  const thetaRms = channelRms(brick.channels.theta?.data ?? brick.channels.K_trace?.data ?? null);
  const hRms = channelRms(brick.channels.H_constraint?.data ?? null);
  const rhoRms = channelRms(brick.channels.rho?.data ?? null);
  const betaX = brick.channels.beta_x?.data;
  const betaY = brick.channels.beta_y?.data;
  const betaZ = brick.channels.beta_z?.data;
  let betaRms = 0;
  if (
    betaX instanceof Float32Array &&
    betaY instanceof Float32Array &&
    betaZ instanceof Float32Array &&
    betaX.length === betaY.length &&
    betaX.length === betaZ.length &&
    betaX.length > 0
  ) {
    let acc = 0;
    let n = 0;
    for (let i = 0; i < betaX.length; i += 1) {
      const bx = Number.isFinite(betaX[i]) ? Number(betaX[i]) : 0;
      const by = Number.isFinite(betaY[i]) ? Number(betaY[i]) : 0;
      const bz = Number.isFinite(betaZ[i]) ? Number(betaZ[i]) : 0;
      const mag2 = bx * bx + by * by + bz * bz;
      acc += mag2;
      n += 1;
    }
    betaRms = n > 0 ? Math.sqrt(acc / n) : 0;
  }
  const sample: TemporalSignalSample = {
    timeS,
    dtS,
    thetaRms,
    hRms,
    rhoRms,
    betaRms,
    updatedAtMs: Date.now(),
  };
  const existing = temporalSignalHistoryByKey.get(key) ?? [];
  const last = existing[existing.length - 1] ?? null;
  const isDuplicate =
    !!last &&
    Math.abs(last.timeS - sample.timeS) < 1e-9 &&
    Math.abs(last.thetaRms - sample.thetaRms) < 1e-12 &&
    Math.abs(last.hRms - sample.hRms) < 1e-12 &&
    Math.abs(last.rhoRms - sample.rhoRms) < 1e-12 &&
    Math.abs(last.betaRms - sample.betaRms) < 1e-12;
  if (!isDuplicate) {
    existing.push(sample);
    if (existing.length > MAX_TEMPORAL_HISTORY_SAMPLES) {
      existing.splice(0, existing.length - MAX_TEMPORAL_HISTORY_SAMPLES);
    }
    temporalSignalHistoryByKey.set(key, existing);
  }
  const series = temporalSignalHistoryByKey.get(key) ?? [];
  return {
    key,
    series,
    latest: series[series.length - 1] ?? sample,
  };
};

const renderSlicePanel = (
  image: Buffer,
  canvasWidth: number,
  canvasHeight: number,
  panel: ScientificPanelPlacement,
  samplingMode: ScientificRenderSamplingMode,
) => {
  const panelBg: [number, number, number] = [11, 16, 26];
  const panelBorder: [number, number, number] = [67, 78, 96];
  const gridColor: [number, number, number] = [26, 37, 54];
  const contourColor: [number, number, number] = [240, 240, 240];
  fillRect(image, canvasWidth, canvasHeight, panel.x, panel.y, panel.width, panel.height, panelBg);
  drawRectStroke(image, canvasWidth, canvasHeight, panel.x, panel.y, panel.width, panel.height, panelBorder);
  const pad = 8;
  const colorbarWidth = Math.max(10, Math.floor(panel.width * 0.045));
  const heatX = panel.x + pad;
  const heatY = panel.y + pad + 18;
  const heatW = Math.max(24, panel.width - pad * 3 - colorbarWidth);
  const heatH = Math.max(24, panel.height - pad * 2 - 24);
  const barX = heatX + heatW + pad;
  const barY = heatY;
  const barH = heatH;

  for (let py = 0; py < heatH; py += 1) {
    const sy = (py / Math.max(1, heatH - 1)) * (panel.slice.height - 1);
    for (let px = 0; px < heatW; px += 1) {
      const sx = (px / Math.max(1, heatW - 1)) * (panel.slice.width - 1);
      const value = sampleSliceValue(panel.slice, sx, sy, samplingMode);
      const t = normalizeSliceValue(panel.slice, value);
      const color =
        panel.slice.mode === "diverging" ? mapDivergingColor(t) : mapSequentialColor(t);
      writePixel(image, canvasWidth, canvasHeight, heatX + px, heatY + py, color[0], color[1], color[2], 255);
    }
  }

  for (let g = 1; g < 4; g += 1) {
    const gx = heatX + Math.round((g / 4) * (heatW - 1));
    const gy = heatY + Math.round((g / 4) * (heatH - 1));
    for (let py = heatY; py < heatY + heatH; py += 1) {
      writePixel(image, canvasWidth, canvasHeight, gx, py, gridColor[0], gridColor[1], gridColor[2], 255);
    }
    for (let px = heatX; px < heatX + heatW; px += 1) {
      writePixel(image, canvasWidth, canvasHeight, px, gy, gridColor[0], gridColor[1], gridColor[2], 255);
    }
  }

  if (panel.slice.mode === "diverging") {
    const stepX = (panel.slice.width - 1) / Math.max(1, heatW - 1);
    const stepY = (panel.slice.height - 1) / Math.max(1, heatH - 1);
    for (let py = 0; py < heatH - 1; py += 1) {
      const sy = (py / Math.max(1, heatH - 1)) * (panel.slice.height - 1);
      for (let px = 0; px < heatW - 1; px += 1) {
        const sx = (px / Math.max(1, heatW - 1)) * (panel.slice.width - 1);
        const v = sampleSliceValue(panel.slice, sx, sy, samplingMode);
        const vx = sampleSliceValue(panel.slice, sx + stepX, sy, samplingMode);
        const vy = sampleSliceValue(panel.slice, sx, sy + stepY, samplingMode);
        const zeroCrossX = (v < 0 && vx > 0) || (v > 0 && vx < 0);
        const zeroCrossY = (v < 0 && vy > 0) || (v > 0 && vy < 0);
        if (zeroCrossX || zeroCrossY) {
          writePixel(
            image,
            canvasWidth,
            canvasHeight,
            heatX + px,
            heatY + py,
            contourColor[0],
            contourColor[1],
            contourColor[2],
            255,
          );
        }
      }
    }
  }

  drawRectStroke(image, canvasWidth, canvasHeight, heatX, heatY, heatW, heatH, [84, 96, 118]);
  for (let py = 0; py < barH; py += 1) {
    const t = 1 - py / Math.max(1, barH - 1);
    const color =
      panel.slice.mode === "diverging" ? mapDivergingColor(t) : mapSequentialColor(t);
    for (let px = 0; px < colorbarWidth; px += 1) {
      writePixel(image, canvasWidth, canvasHeight, barX + px, barY + py, color[0], color[1], color[2], 255);
    }
  }
  drawRectStroke(image, canvasWidth, canvasHeight, barX, barY, colorbarWidth, barH, [84, 96, 118]);
};

const renderVolumeTransportPanel = (
  image: Buffer,
  canvasWidth: number,
  canvasHeight: number,
  rect: ScientificRect,
  brick: GrBrickDecoded,
  field: VolumeFieldSelection,
  supportProjection: HullSupportProjection | null,
): ScientificTransportRenderStats => {
  const panelBg: [number, number, number] = [8, 14, 22];
  const panelBorder: [number, number, number] = [70, 86, 107];
  fillRect(image, canvasWidth, canvasHeight, rect.x, rect.y, rect.width, rect.height, panelBg);
  drawRectStroke(image, canvasWidth, canvasHeight, rect.x, rect.y, rect.width, rect.height, panelBorder);
  const stats: ScientificTransportRenderStats = {
    method: "christoffel-null-bundle",
    rays: 0,
    samples: 0,
    maxNullResidual: 0,
    meanNullResidual: 0,
    escapedPct: 0,
    displayGain: 1,
    shellAssist: 0,
    lowSignal: false,
  };

  const innerPad = 10;
  const viewX = rect.x + innerPad;
  const viewY = rect.y + innerPad + 16;
  const viewW = Math.max(48, rect.width - innerPad * 2);
  const viewH = Math.max(48, rect.height - innerPad * 2 - 20);
  const internalW = Math.max(96, Math.floor(viewW * 0.38));
  const internalH = Math.max(72, Math.floor(viewH * 0.38));
  const offscreen = new Uint8Array(internalW * internalH * 3);

  const alpha = brick.channels.alpha?.data;
  const betaX = brick.channels.beta_x?.data;
  const betaY = brick.channels.beta_y?.data;
  const betaZ = brick.channels.beta_z?.data;
  const gammaXX = brick.channels.gamma_xx?.data;
  const gammaYY = brick.channels.gamma_yy?.data;
  const gammaZZ = brick.channels.gamma_zz?.data;
  const requiredLen = brick.dims[0] * brick.dims[1] * brick.dims[2];
  const hasMetricChannels =
    alpha instanceof Float32Array &&
    betaX instanceof Float32Array &&
    betaY instanceof Float32Array &&
    betaZ instanceof Float32Array &&
    gammaXX instanceof Float32Array &&
    gammaYY instanceof Float32Array &&
    gammaZZ instanceof Float32Array &&
    alpha.length >= requiredLen &&
    betaX.length >= requiredLen &&
    betaY.length >= requiredLen &&
    betaZ.length >= requiredLen &&
    gammaXX.length >= requiredLen &&
    gammaYY.length >= requiredLen &&
    gammaZZ.length >= requiredLen;
  if (!hasMetricChannels) {
    stats.method = "unavailable";
    for (let i = 0; i < offscreen.length; i += 3) {
      offscreen[i] = 8;
      offscreen[i + 1] = 12;
      offscreen[i + 2] = 20;
    }
  }

  const maxAbs = Math.max(Math.abs(field.min), Math.abs(field.max), 1e-45);
  const sequentialSpan = Math.max(1e-45, field.max - field.min);
  const absSampleValues = sampleFinite(field.data, 12_288)
    .map((value) => Math.abs(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  const absP50 = absSampleValues.length ? Math.max(percentile(absSampleValues, 0.5), 1e-45) : 1e-45;
  const absP90 = absSampleValues.length ? Math.max(percentile(absSampleValues, 0.9), absP50) : absP50;
  const absP99 = absSampleValues.length ? Math.max(percentile(absSampleValues, 0.99), absP90) : absP90;
  const robustScale = Math.max(absP90 * 0.5, absP50, maxAbs * 1e-4, 1e-45);
  const logDen = Math.log1p(maxAbs / robustScale);
  const sequentialLogDen = Math.max(1e-12, Math.log1p(maxAbs / robustScale));
  const contrastRatio = absP99 / Math.max(absP50, 1e-45);
  const displayGain = maxAbs / Math.max(robustScale, 1e-45);
  const sparseSupport = (supportProjection?.maskedOutPct ?? 0) > 70;
  const lowSignal =
    contrastRatio < 8 || absP99 < 1e-34 || displayGain < 0.7 || sparseSupport;
  const divergingAlphaGain = lowSignal ? 0.55 : 0.2;
  const sequentialAlphaGain = lowSignal ? 0.44 : 0.17;
  const shellAssistBase = sparseSupport ? 0.65 : lowSignal ? 0.42 : 0.12;
  const supportAlphaFloor = sparseSupport ? 0.18 : lowSignal ? 0.05 : 0;
  stats.displayGain = displayGain;
  stats.shellAssist = shellAssistBase;
  stats.lowSignal = lowSignal;
  const supportCoverage01 = clamp(
    toFiniteNumber(supportProjection?.coveragePct, 100) / 100,
    0,
    1,
  );
  const sparseZoom = clamp((0.42 - supportCoverage01) / 0.42, 0, 1);
  const forward = normalize3([0.78, -0.35, -0.92]);
  const right = normalize3(cross3(forward, [0, 1, 0]));
  const up = normalize3(cross3(right, forward));
  const cameraDistance = lerp(1.9, 1.18, sparseZoom);
  const cameraPos: [number, number, number] = [
    0.5 - forward[0] * cameraDistance,
    0.5 - forward[1] * cameraDistance,
    0.5 - forward[2] * cameraDistance,
  ];
  const aspect = internalW / Math.max(1, internalH);
  const fovScale = lerp(0.85, 0.6, sparseZoom);
  const hasBeta =
    betaX instanceof Float32Array &&
    betaY instanceof Float32Array &&
    betaZ instanceof Float32Array &&
    betaX.length === betaY.length &&
    betaX.length === betaZ.length;
  const nx = brick.dims[0];
  const ny = brick.dims[1];
  const nz = brick.dims[2];
  const dxM = Math.max(1e-6, toFiniteNumber(brick.voxelSize_m[0], 1));
  const dyM = Math.max(1e-6, toFiniteNumber(brick.voxelSize_m[1], 1));
  const dzM = Math.max(1e-6, toFiniteNumber(brick.voxelSize_m[2], 1));
  const shellWidthM = Math.max(Math.min(dxM, dyM, dzM) * 1.6, 1e-6);
  const dX01 = 1 / Math.max(1, nx - 1);
  const dY01 = 1 / Math.max(1, ny - 1);
  const dZ01 = 1 / Math.max(1, nz - 1);
  const hullSdfData = brick.channels.hull_sdf?.data;
  const hasHullSdf =
    hullSdfData instanceof Float32Array && hullSdfData.length >= requiredLen;

  type MetricSample = {
    g: number[][];
    gInv: number[][];
  };

  const sampleMetric = (
    x01: number,
    y01: number,
    z01: number,
  ): MetricSample | null => {
    if (!hasMetricChannels) return null;
    const a = sampleVolumeTrilinear(alpha!, brick.dims, x01, y01, z01);
    const bx = sampleVolumeTrilinear(betaX!, brick.dims, x01, y01, z01);
    const by = sampleVolumeTrilinear(betaY!, brick.dims, x01, y01, z01);
    const bz = sampleVolumeTrilinear(betaZ!, brick.dims, x01, y01, z01);
    const gxx = sampleVolumeTrilinear(gammaXX!, brick.dims, x01, y01, z01);
    const gyy = sampleVolumeTrilinear(gammaYY!, brick.dims, x01, y01, z01);
    const gzz = sampleVolumeTrilinear(gammaZZ!, brick.dims, x01, y01, z01);
    if (
      !Number.isFinite(a) ||
      !Number.isFinite(bx) ||
      !Number.isFinite(by) ||
      !Number.isFinite(bz) ||
      !Number.isFinite(gxx) ||
      !Number.isFinite(gyy) ||
      !Number.isFinite(gzz)
    ) {
      return null;
    }
    return metricFromComponents(
      Math.max(1e-6, a),
      bx,
      by,
      bz,
      Math.max(1e-6, gxx),
      Math.max(1e-6, gyy),
      Math.max(1e-6, gzz),
    );
  };

  const solveNullK0 = (g: number[][], spatial: [number, number, number]): number => {
    const [sx, sy, sz] = spatial;
    const A = g[0]![0]!;
    const B = 2 * (g[0]![1]! * sx + g[0]![2]! * sy + g[0]![3]! * sz);
    const C =
      g[1]![1]! * sx * sx +
      g[2]![2]! * sy * sy +
      g[3]![3]! * sz * sz +
      2 * (g[1]![2]! * sx * sy + g[1]![3]! * sx * sz + g[2]![3]! * sy * sz);
    const disc = Math.max(0, B * B - 4 * A * C);
    const root = Math.sqrt(disc);
    const denom = Math.abs(2 * A) > 1e-12 ? 2 * A : A < 0 ? -2e-12 : 2e-12;
    const r1 = (-B - root) / denom;
    const r2 = (-B + root) / denom;
    if (Number.isFinite(r1) && r1 > 0) return r1;
    if (Number.isFinite(r2) && r2 > 0) return r2;
    if (Number.isFinite(r1)) return r1;
    if (Number.isFinite(r2)) return r2;
    return 1;
  };

  const evalNullResidual = (g: number[][], k: number[]): number => {
    let acc = 0;
    for (let a = 0; a < 4; a += 1) {
      for (let b = 0; b < 4; b += 1) {
        acc += g[a]![b]! * k[a]! * k[b]!;
      }
    }
    return Math.abs(acc);
  };

  const computeChristoffel = (
    x01: number,
    y01: number,
    z01: number,
  ): { g: number[][]; gamma: number[][][] } | null => {
    const center = sampleMetric(x01, y01, z01);
    if (!center) return null;
    const dG = Array.from({ length: 4 }, () =>
      Array.from({ length: 4 }, () => new Array<number>(4).fill(0)),
    );
    const plusX = sampleMetric(x01 + dX01, y01, z01);
    const minusX = sampleMetric(x01 - dX01, y01, z01);
    const plusY = sampleMetric(x01, y01 + dY01, z01);
    const minusY = sampleMetric(x01, y01 - dY01, z01);
    const plusZ = sampleMetric(x01, y01, z01 + dZ01);
    const minusZ = sampleMetric(x01, y01, z01 - dZ01);
    if (!plusX || !minusX || !plusY || !minusY || !plusZ || !minusZ) return null;
    for (let a = 0; a < 4; a += 1) {
      for (let b = 0; b < 4; b += 1) {
        dG[1]![a]![b] = (plusX.g[a]![b]! - minusX.g[a]![b]!) / (2 * dxM);
        dG[2]![a]![b] = (plusY.g[a]![b]! - minusY.g[a]![b]!) / (2 * dyM);
        dG[3]![a]![b] = (plusZ.g[a]![b]! - minusZ.g[a]![b]!) / (2 * dzM);
      }
    }
    const gamma = Array.from({ length: 4 }, () =>
      Array.from({ length: 4 }, () => new Array<number>(4).fill(0)),
    );
    for (let mu = 0; mu < 4; mu += 1) {
      for (let a = 0; a < 4; a += 1) {
        for (let b = 0; b < 4; b += 1) {
          let acc = 0;
          for (let nu = 0; nu < 4; nu += 1) {
            acc +=
              0.5 *
              center.gInv[mu]![nu]! *
              (dG[a]![b]![nu]! + dG[b]![a]![nu]! - dG[nu]![a]![b]!);
          }
          gamma[mu]![a]![b] = acc;
        }
      }
    }
    return { g: center.g, gamma };
  };

  type GeodesicState = {
    x: number[];
    k: number[];
  };

  const geodesicRhs = (state: GeodesicState, gamma: number[][][]): GeodesicState => {
    const dxdt = [...state.k];
    const dkdt = [0, 0, 0, 0];
    for (let mu = 0; mu < 4; mu += 1) {
      let acc = 0;
      for (let a = 0; a < 4; a += 1) {
        for (let b = 0; b < 4; b += 1) {
          acc += gamma[mu]![a]![b]! * state.k[a]! * state.k[b]!;
        }
      }
      dkdt[mu] = -acc;
    }
    return { x: dxdt, k: dkdt };
  };

  let residualSum = 0;
  let residualCount = 0;
  let escapedRays = 0;

  if (hasMetricChannels) {
    for (let py = 0; py < internalH; py += 1) {
      const ndcY = 1 - (2 * py) / Math.max(1, internalH - 1);
      for (let px = 0; px < internalW; px += 1) {
        const ndcX = ((2 * px) / Math.max(1, internalW - 1) - 1) * aspect;
        const rayDir = normalize3([
          forward[0] + right[0] * ndcX * fovScale + up[0] * ndcY * fovScale,
          forward[1] + right[1] * ndcX * fovScale + up[1] * ndcY * fovScale,
          forward[2] + right[2] * ndcX * fovScale + up[2] * ndcY * fovScale,
        ]);
        const hit = intersectRayUnitBox(cameraPos, rayDir);
        const outIdx = (py * internalW + px) * 3;
        if (!hit.hit) {
          offscreen[outIdx] = 8;
          offscreen[outIdx + 1] = 12;
          offscreen[outIdx + 2] = 20;
          continue;
        }
        stats.rays += 1;
        const span = Math.max(1e-6, hit.t1 - hit.t0);
        const startT = hit.t0 + span * 0.01;
        const startPos: [number, number, number] = [
          cameraPos[0] + rayDir[0] * startT,
          cameraPos[1] + rayDir[1] * startT,
          cameraPos[2] + rayDir[2] * startT,
        ];
        const metric0 = sampleMetric(startPos[0], startPos[1], startPos[2]);
        if (!metric0) {
          offscreen[outIdx] = 8;
          offscreen[outIdx + 1] = 12;
          offscreen[outIdx + 2] = 20;
          continue;
        }
        const spatial: [number, number, number] = [rayDir[0], rayDir[1], rayDir[2]];
        const k0 = solveNullK0(metric0.g, spatial);
        let state: GeodesicState = {
          x: [0, startPos[0], startPos[1], startPos[2]],
          k: [k0, spatial[0], spatial[1], spatial[2]],
        };
        let accumA = 0;
        let outR = 0;
        let outG = 0;
        let outB = 0;
        const maxSteps = 28;
        const h = span / maxSteps;
        let exited = false;
        let sampledSupported = false;
        for (let step = 0; step < maxSteps; step += 1) {
          const x = state.x[1]!;
          const y = state.x[2]!;
          const z = state.x[3]!;
          if (x < 0 || x > 1 || y < 0 || y > 1 || z < 0 || z > 1) {
            exited = true;
            break;
          }
        const bundle = computeChristoffel(x, y, z);
        if (!bundle) break;
        const supported = !supportProjection || sampleHullSupport3D(brick, x, y, z) > 0.5;
        if (supported) {
          sampledSupported = true;
          const residual = evalNullResidual(bundle.g, state.k);
          if (Number.isFinite(residual)) {
            stats.maxNullResidual = Math.max(stats.maxNullResidual, residual);
            residualSum += residual;
            residualCount += 1;
          }
          const value = sampleVolumeTrilinear(field.data, brick.dims, x, y, z);
          let alphaWeight = 0;
          let color: [number, number, number] = [0, 0, 0];
          if (field.mode === "diverging") {
            const absValue = Math.abs(value);
            const magLinear = clamp(absValue / maxAbs, 0, 1);
            const magLog =
              logDen > 1e-12
                ? clamp(Math.log1p(absValue / robustScale) / logDen, 0, 1)
                : magLinear;
            const mag = Math.max(magLinear * 0.35, magLog);
            alphaWeight = clamp(Math.pow(mag, 0.72) * divergingAlphaGain, 0, lowSignal ? 0.6 : 0.48);
            const tColor = lowSignal
              ? clamp(0.5 + 0.5 * Math.tanh(value / Math.max(1e-45, robustScale) * 2.2), 0, 1)
              : clamp(0.5 + 0.5 * (value / maxAbs), 0, 1);
            color = mapDivergingColor(tColor);
          } else {
            const tLinear = clamp((value - field.min) / sequentialSpan, 0, 1);
            const tLog =
              logDen > 1e-12
                ? clamp(
                    Math.log1p(Math.abs(value) / robustScale) /
                      sequentialLogDen,
                    0,
                    1,
                  )
                : tLinear;
            const tColor = Math.max(tLinear * 0.35, tLog);
            alphaWeight = clamp(Math.pow(tColor, 0.78) * sequentialAlphaGain, 0, lowSignal ? 0.48 : 0.4);
            color = mapSequentialColor(tColor);
          }
          if (hasHullSdf) {
            const sdfValue = sampleVolumeTrilinear(hullSdfData!, brick.dims, x, y, z);
            if (Number.isFinite(sdfValue)) {
              const shellWeight = Math.exp(-Math.pow(Math.abs(sdfValue) / shellWidthM, 2));
              if (shellWeight > 1e-3) {
                const blend = clamp(shellWeight * (lowSignal ? 0.78 : 0.45), 0, 1);
                color = [
                  Math.round(lerp(color[0], 122, blend)),
                  Math.round(lerp(color[1], 184, blend)),
                  Math.round(lerp(color[2], 247, blend)),
                ];
                alphaWeight = Math.max(
                  alphaWeight,
                  clamp(shellAssistBase * shellWeight, 0, lowSignal ? 0.22 : 0.12),
                );
              }
            }
          }
          if (hasBeta) {
            const bx = sampleVolumeTrilinear(betaX!, brick.dims, x, y, z);
            const by = sampleVolumeTrilinear(betaY!, brick.dims, x, y, z);
            const bz = sampleVolumeTrilinear(betaZ!, brick.dims, x, y, z);
            const betaMag = Math.sqrt(bx * bx + by * by + bz * bz);
            const betaBoost = clamp(betaMag * 1e28, 0, 1);
            if (betaBoost > 0.1) {
              color = [
                Math.round(lerp(color[0], 220, betaBoost * 0.32)),
                Math.round(lerp(color[1], 246, betaBoost * 0.44)),
                Math.round(lerp(color[2], 160, betaBoost * 0.3)),
              ];
              alphaWeight = clamp(alphaWeight + betaBoost * 0.03, 0, 0.48);
            }
          }
          if (supportAlphaFloor > 0) {
            // Ensure supported samples remain visible when the transported field is sparse.
            alphaWeight = Math.max(alphaWeight, supportAlphaFloor);
          }
          if (alphaWeight > 0) {
            const w = (1 - accumA) * alphaWeight;
            outR += w * color[0];
            outG += w * color[1];
            outB += w * color[2];
            accumA += w;
          }
          stats.samples += 1;
          if (accumA >= 0.985) break;
        }

          const rhs1 = geodesicRhs(state, bundle.gamma);
          const mid: GeodesicState = {
            x: state.x.map((v, i) => v + 0.5 * h * rhs1.x[i]!) as number[],
            k: state.k.map((v, i) => v + 0.5 * h * rhs1.k[i]!) as number[],
          };
          const midBundle = computeChristoffel(mid.x[1]!, mid.x[2]!, mid.x[3]!);
          if (!midBundle) break;
          const rhs2 = geodesicRhs(mid, midBundle.gamma);
          state = {
            x: state.x.map((v, i) => v + h * rhs2.x[i]!) as number[],
            k: state.k.map((v, i) => v + h * rhs2.k[i]!) as number[],
          };
          if ((step & 0x3) === 0x3) {
            const renormMetric = sampleMetric(state.x[1]!, state.x[2]!, state.x[3]!);
            if (renormMetric) {
              state.k[0] = solveNullK0(renormMetric.g, [
                state.k[1]!,
                state.k[2]!,
                state.k[3]!,
              ]);
            }
          }
        }
        if (exited) escapedRays += 1;
        if (sampledSupported && accumA < 0.02) {
          accumA = lowSignal ? 0.14 : 0.06;
          outR = lerp(outR, 74, 0.4);
          outG = lerp(outG, 116, 0.4);
          outB = lerp(outB, 172, 0.4);
        }
        const bg: [number, number, number] = [10, 15, 24];
        const finalR = Math.round(lerp(bg[0], outR / Math.max(1e-6, accumA), accumA));
        const finalG = Math.round(lerp(bg[1], outG / Math.max(1e-6, accumA), accumA));
        const finalB = Math.round(lerp(bg[2], outB / Math.max(1e-6, accumA), accumA));
        offscreen[outIdx] = toByte(finalR);
        offscreen[outIdx + 1] = toByte(finalG);
        offscreen[outIdx + 2] = toByte(finalB);
      }
    }
  }

  for (let py = 0; py < viewH; py += 1) {
    const sy = (py / Math.max(1, viewH - 1)) * (internalH - 1);
    const y0 = clampi(Math.floor(sy), 0, internalH - 1);
    const y1 = clampi(y0 + 1, 0, internalH - 1);
    const ty = clamp(sy - y0, 0, 1);
    for (let px = 0; px < viewW; px += 1) {
      const sx = (px / Math.max(1, viewW - 1)) * (internalW - 1);
      const x0 = clampi(Math.floor(sx), 0, internalW - 1);
      const x1 = clampi(x0 + 1, 0, internalW - 1);
      const tx = clamp(sx - x0, 0, 1);
      const idx00 = (y0 * internalW + x0) * 3;
      const idx10 = (y0 * internalW + x1) * 3;
      const idx01 = (y1 * internalW + x0) * 3;
      const idx11 = (y1 * internalW + x1) * 3;
      const r = lerp(
        lerp(offscreen[idx00]!, offscreen[idx10]!, tx),
        lerp(offscreen[idx01]!, offscreen[idx11]!, tx),
        ty,
      );
      const g = lerp(
        lerp(offscreen[idx00 + 1]!, offscreen[idx10 + 1]!, tx),
        lerp(offscreen[idx01 + 1]!, offscreen[idx11 + 1]!, tx),
        ty,
      );
      const b = lerp(
        lerp(offscreen[idx00 + 2]!, offscreen[idx10 + 2]!, tx),
        lerp(offscreen[idx01 + 2]!, offscreen[idx11 + 2]!, tx),
        ty,
      );
      writePixel(
        image,
        canvasWidth,
        canvasHeight,
        viewX + px,
        viewY + py,
        Math.round(r),
        Math.round(g),
        Math.round(b),
        255,
      );
    }
  }

  drawRectStroke(image, canvasWidth, canvasHeight, viewX, viewY, viewW, viewH, [92, 108, 130]);
  const axisBaseX = viewX + 18;
  const axisBaseY = viewY + viewH - 18;
  drawLine(image, canvasWidth, canvasHeight, axisBaseX, axisBaseY, axisBaseX + 22, axisBaseY - 8, [235, 94, 94]);
  drawLine(image, canvasWidth, canvasHeight, axisBaseX, axisBaseY, axisBaseX + 4, axisBaseY - 24, [85, 206, 116]);
  drawLine(image, canvasWidth, canvasHeight, axisBaseX, axisBaseY, axisBaseX - 14, axisBaseY - 10, [90, 156, 245]);
  stats.meanNullResidual = residualCount > 0 ? residualSum / residualCount : 0;
  stats.escapedPct = stats.rays > 0 ? (100 * escapedRays) / stats.rays : 0;
  return stats;
};

const renderTemporalHistoryStrip = (
  image: Buffer,
  canvasWidth: number,
  canvasHeight: number,
  rect: ScientificRect,
  history: TemporalHistorySnapshot,
): void => {
  fillRect(image, canvasWidth, canvasHeight, rect.x, rect.y, rect.width, rect.height, [7, 12, 20]);
  drawRectStroke(image, canvasWidth, canvasHeight, rect.x, rect.y, rect.width, rect.height, [62, 74, 92]);
  if (history.series.length < 2) return;
  const valuesTheta = history.series.map((sample) => Math.abs(sample.thetaRms));
  const valuesH = history.series.map((sample) => Math.abs(sample.hRms));
  const valuesRho = history.series.map((sample) => Math.abs(sample.rhoRms));
  const maxTheta = Math.max(...valuesTheta, 1e-18);
  const maxH = Math.max(...valuesH, 1e-18);
  const maxRho = Math.max(...valuesRho, 1e-18);
  const pad = 6;
  const x0 = rect.x + pad;
  const y0 = rect.y + pad;
  const w = Math.max(24, rect.width - pad * 2);
  const h = Math.max(14, rect.height - pad * 2);
  for (let i = 1; i < history.series.length; i += 1) {
    const a = history.series[i - 1]!;
    const b = history.series[i]!;
    const xa = x0 + ((i - 1) / Math.max(1, history.series.length - 1)) * (w - 1);
    const xb = x0 + (i / Math.max(1, history.series.length - 1)) * (w - 1);
    const normThetaA = Math.log1p(Math.abs(a.thetaRms) / maxTheta) / Math.log1p(1);
    const normThetaB = Math.log1p(Math.abs(b.thetaRms) / maxTheta) / Math.log1p(1);
    const normHA = Math.log1p(Math.abs(a.hRms) / maxH) / Math.log1p(1);
    const normHB = Math.log1p(Math.abs(b.hRms) / maxH) / Math.log1p(1);
    const normRhoA = Math.log1p(Math.abs(a.rhoRms) / maxRho) / Math.log1p(1);
    const normRhoB = Math.log1p(Math.abs(b.rhoRms) / maxRho) / Math.log1p(1);
    const yaTheta = y0 + h - 1 - normThetaA * (h - 1);
    const ybTheta = y0 + h - 1 - normThetaB * (h - 1);
    const yaH = y0 + h - 1 - normHA * (h - 1);
    const ybH = y0 + h - 1 - normHB * (h - 1);
    const yaRho = y0 + h - 1 - normRhoA * (h - 1);
    const ybRho = y0 + h - 1 - normRhoB * (h - 1);
    drawLine(image, canvasWidth, canvasHeight, xa, yaTheta, xb, ybTheta, [80, 126, 228]);
    drawLine(image, canvasWidth, canvasHeight, xa, yaH, xb, ybH, [225, 86, 86]);
    drawLine(image, canvasWidth, canvasHeight, xa, yaRho, xb, ybRho, [238, 210, 66]);
  }
};

const formatSupportSummary = (ctx: TensorRenderContext): string =>
  `support coverage=${fmtScientific(ctx.supportCoveragePct, 1)}% | masked-out=${fmtScientific(
    ctx.maskedOutPct,
    1,
  )}% | mask=${ctx.supportMaskKind}`;

const buildScientificOverlaySvg = (
  width: number,
  height: number,
  panels: ScientificPanelPlacement[],
  payload: HullMisRenderRequestV1,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
  samplingMode: ScientificRenderSamplingMode,
  transportRect: ScientificRect,
  transportField: VolumeFieldSelection | null,
  transportStats: ScientificTransportRenderStats,
  temporalRect: ScientificRect,
  temporalHistory: TemporalHistorySnapshot,
) => {
  const timestamp = new Date().toISOString();
  const title = "NHM2 Canonical 3+1 Scientific Frame (Tensor-fed, 3D+time)";
  const sourceParams = parseMetricRefSourceParams(payload);
  const sourceSummary = summarizeMetricRefSourceParams(sourceParams);
  const subtitleParts = [
    `chart=${ctx.chart ?? payload.solve?.chart ?? "unknown"}`,
    `source=${ctx.metricSource ?? "unknown"}`,
    `field=${ctx.metricChannel}`,
    "paperLane=rho_E(eulerian)",
    `renderSampling=${samplingMode}`,
    formatSupportSummary(ctx),
    `dims=${brick.dims.join("x")}`,
    `vox=${brick.voxelSize_m.map((v) => fmtScientific(v, 3)).join(",")} m`,
  ];
  if (sourceSummary) subtitleParts.push(`solve(${sourceSummary})`);
  const subtitle = subtitleParts.join(" | ");
  const diag = `null residual=${fmtScientific(ctx.diagnostics.maxNullResidual, 4)} | convergence=${fmtScientific(ctx.diagnostics.stepConvergence, 4)} | bundle spread=${fmtScientific(ctx.diagnostics.bundleSpread, 4)} | consistency=${ctx.diagnostics.consistency} | ${formatSupportSummary(ctx)}`;
  const temporalLatest = temporalHistory.latest;
  const temporalSummary = temporalLatest
    ? `series=${temporalHistory.series.length} | t=${fmtScientific(temporalLatest.timeS, 3)} s | dt=${fmtScientific(
        temporalLatest.dtS,
        3,
      )} s | theta_rms=${fmtScientific(temporalLatest.thetaRms, 3)} | H_rms=${fmtScientific(
        temporalLatest.hRms,
        3,
      )} | rho_rms=${fmtScientific(temporalLatest.rhoRms, 3)}`
    : "series=0";

  const panelText = panels
    .map((panel) => {
      const top = panel.y + 16;
      const info = `${panel.slice.label} [${panel.slice.unit}]`;
      const range = `range ${fmtScientific(panel.slice.min, 3)} .. ${fmtScientific(panel.slice.max, 3)} | support ${fmtScientific(panel.slice.supportPct, 1)}%`;
      const annotation = panel.slice.annotation ? String(panel.slice.annotation) : null;
      return [
        `<text x="${panel.x + 8}" y="${top}" fill="#cfe5ff" font-size="11" font-weight="600">${escapeXml(info)}</text>`,
        `<text x="${panel.x + 8}" y="${top + 14}" fill="#9fb3ca" font-size="10">${escapeXml(range)}</text>`,
        annotation
          ? `<text x="${panel.x + 8}" y="${top + 28}" fill="#8ec6ff" font-size="10">${escapeXml(annotation)}</text>`
          : "",
        `<text x="${panel.x + 8}" y="${panel.y + panel.height - 8}" fill="#7f93ac" font-size="10">${escapeXml(`${panel.slice.sampling} | render=${samplingMode}`)}</text>`,
      ].join("");
    })
    .join("");

  const transportTitle = transportField
    ? `${transportField.label} [${transportField.key}]`
    : "Transport field unavailable";
  const transportRange = transportField
    ? `range ${fmtScientific(transportField.min, 3)} .. ${fmtScientific(
        transportField.max,
      3,
      )} | volume=${brick.dims.join("x")}`
    : "no decodable canonical field";
  const transportDiag = `method=${transportStats.method} | rays=${transportStats.rays} | samples=${transportStats.samples} | null(max=${fmtScientific(
    transportStats.maxNullResidual,
    3,
  )}, mean=${fmtScientific(transportStats.meanNullResidual, 3)}) | escaped=${fmtScientific(
    transportStats.escapedPct,
    1,
  )}% | gain=${fmtScientific(transportStats.displayGain, 2)} | shell=${fmtScientific(
    transportStats.shellAssist,
    2,
  )}${transportStats.lowSignal ? " | low-signal-enhanced" : ""}`;

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="36" fill="#050a14"/>
  <text x="16" y="20" fill="#e8f3ff" font-size="15" font-weight="700">${escapeXml(title)}</text>
  <text x="16" y="33" fill="#9fb3ca" font-size="10">${escapeXml(subtitle)}</text>
  <text x="${transportRect.x + 8}" y="${transportRect.y + 16}" fill="#cfe5ff" font-size="11" font-weight="600">3D Volume Transport (Christoffel null-geodesic bundle)</text>
  <text x="${transportRect.x + 8}" y="${transportRect.y + 30}" fill="#9fb3ca" font-size="10">${escapeXml(transportTitle)}</text>
  <text x="${transportRect.x + 8}" y="${transportRect.y + 44}" fill="#7f93ac" font-size="10">${escapeXml(transportDiag)}</text>
  <text x="${transportRect.x + 8}" y="${transportRect.y + transportRect.height - 8}" fill="#7f93ac" font-size="10">${escapeXml(transportRange)}</text>
  <text x="${temporalRect.x + 8}" y="${temporalRect.y + 14}" fill="#cfe5ff" font-size="11" font-weight="600">Temporal RMS History (|theta|, |H|, |rho|)</text>
  <text x="${temporalRect.x + 8}" y="${temporalRect.y + temporalRect.height - 8}" fill="#7f93ac" font-size="10">${escapeXml(temporalSummary)}</text>
  ${panelText}
  <rect x="0" y="${height - 24}" width="${width}" height="24" fill="#050a14"/>
  <text x="16" y="${height - 9}" fill="#9fb3ca" font-size="10">${escapeXml(diag)} | generated=${escapeXml(timestamp)}</text>
</svg>`;
};

const buildPaperRhoOverlaySvg = (
  width: number,
  height: number,
  panel: ScientificPanelPlacement,
  payload: HullMisRenderRequestV1,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
  samplingMode: ScientificRenderSamplingMode,
) => {
  const timestamp = new Date().toISOString();
  const sourceParams = parseMetricRefSourceParams(payload);
  const sourceSummary = summarizeMetricRefSourceParams(sourceParams);
  const subtitleParts = [
    "single-derived-field view",
    "rho_E = T_{mu nu} n^mu n^nu",
    `unit=${panel.slice.unit}`,
    `chart=${ctx.chart ?? payload.solve?.chart ?? "unknown"}`,
    `source=${ctx.metricSource ?? "unknown"}`,
    formatSupportSummary(ctx),
    `dims=${brick.dims.join("x")}`,
    `sampling=${samplingMode}`,
  ];
  if (sourceSummary) subtitleParts.push(`solve(${sourceSummary})`);
  const subtitle = subtitleParts.join(" | ");
  const diag = `null residual=${fmtScientific(
    ctx.diagnostics.maxNullResidual,
    4,
  )} | convergence=${fmtScientific(
    ctx.diagnostics.stepConvergence,
    4,
  )} | bundle spread=${fmtScientific(
    ctx.diagnostics.bundleSpread,
    4,
  )} | consistency=${ctx.diagnostics.consistency} | ${formatSupportSummary(ctx)}`;
  const range = `range ${fmtScientific(panel.slice.min, 3)} .. ${fmtScientific(
    panel.slice.max,
    3,
  )} | slice support ${fmtScientific(panel.slice.supportPct, 1)}%`;
  const annotation = panel.slice.annotation ? String(panel.slice.annotation) : "n/a";

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="40" fill="#050a14"/>
  <text x="16" y="22" fill="#e8f3ff" font-size="16" font-weight="700">NHM2 Canonical rho_E Paper View</text>
  <text x="16" y="36" fill="#9fb3ca" font-size="10">${escapeXml(subtitle)}</text>
  <text x="${panel.x + 8}" y="${panel.y + 16}" fill="#cfe5ff" font-size="12" font-weight="600">${escapeXml(panel.slice.label)}</text>
  <text x="${panel.x + 8}" y="${panel.y + 30}" fill="#9fb3ca" font-size="10">${escapeXml(range)}</text>
  <text x="${panel.x + 8}" y="${panel.y + panel.height - 10}" fill="#8ec6ff" font-size="10">${escapeXml(`${annotation} | ${panel.slice.sampling}`)}</text>
  <rect x="0" y="${height - 24}" width="${width}" height="24" fill="#050a14"/>
  <text x="16" y="${height - 8}" fill="#9fb3ca" font-size="10">${escapeXml(diag)} | generated=${escapeXml(timestamp)}</text>
</svg>`;
};

const buildYorkTimeOverlaySvg = (
  width: number,
  height: number,
  panel: ScientificPanelPlacement,
  payload: HullMisRenderRequestV1,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
  samplingMode: ScientificRenderSamplingMode,
) => {
  const yorkLane = resolveYorkLaneConvention(resolveRequestedYorkLaneId(payload));
  const timestamp = new Date().toISOString();
  const sourceParams = parseMetricRefSourceParams(payload);
  const sourceSummary = summarizeMetricRefSourceParams(sourceParams);
  const subtitleParts = [
    "single-snapshot York-time frame",
    `${yorkLane.theta_definition} (${yorkLane.observer})`,
    `unit=${panel.slice.unit}`,
    `chart=${ctx.chart ?? payload.solve?.chart ?? "unknown"}`,
    `source=${ctx.metricSource ?? "unknown"}`,
    formatSupportSummary(ctx),
    `dims=${brick.dims.join("x")}`,
    `sampling=${samplingMode}`,
  ];
  if (sourceSummary) subtitleParts.push(`solve(${sourceSummary})`);
  const subtitle = subtitleParts.join(" | ");
  const diag = `null residual=${fmtScientific(
    ctx.diagnostics.maxNullResidual,
    4,
  )} | convergence=${fmtScientific(
    ctx.diagnostics.stepConvergence,
    4,
  )} | bundle spread=${fmtScientific(
    ctx.diagnostics.bundleSpread,
    4,
  )} | consistency=${ctx.diagnostics.consistency} | ${formatSupportSummary(ctx)}`;
  const range = `range ${fmtScientific(panel.slice.min, 3)} .. ${fmtScientific(
    panel.slice.max,
    3,
  )} | normalization=symmetric-about-zero | slice support ${fmtScientific(panel.slice.supportPct, 1)}%`;
  const annotation = panel.slice.annotation
    ? String(panel.slice.annotation)
    : "fore(+x) contraction(theta<0) / aft(-x) expansion(theta>0) sign map";
  const certSummary = [
    `metric_ref_hash=${payload.metricVolumeRef?.hash ?? "none"}`,
    `theta_definition=${yorkLane.theta_definition}`,
    `slice_plane=x-z-midplane`,
  ].join(" | ");

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="40" fill="#050a14"/>
  <text x="16" y="22" fill="#e8f3ff" font-size="16" font-weight="700">NHM2 York-Time 3+1 (single certified snapshot)</text>
  <text x="16" y="36" fill="#9fb3ca" font-size="10">${escapeXml(subtitle)}</text>
  <text x="${panel.x + 8}" y="${panel.y + 16}" fill="#cfe5ff" font-size="12" font-weight="600">${escapeXml(panel.slice.label)}</text>
  <text x="${panel.x + 8}" y="${panel.y + 30}" fill="#9fb3ca" font-size="10">${escapeXml(range)}</text>
  <text x="${panel.x + 8}" y="${panel.y + panel.height - 22}" fill="#8ec6ff" font-size="10">${escapeXml(`${annotation} | ${panel.slice.sampling}`)}</text>
  <text x="${panel.x + 8}" y="${panel.y + panel.height - 10}" fill="#7f93ac" font-size="10">${escapeXml(certSummary)}</text>
  <rect x="0" y="${height - 24}" width="${width}" height="24" fill="#050a14"/>
  <text x="16" y="${height - 8}" fill="#9fb3ca" font-size="10">${escapeXml(diag)} | generated=${escapeXml(timestamp)}</text>
</svg>`;
};

const buildYorkTimeTransportOverlaySvg = (
  width: number,
  height: number,
  payload: HullMisRenderRequestV1,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
  transportRect: ScientificRect,
  transportField: VolumeFieldSelection,
  transportStats: ScientificTransportRenderStats,
  yorkPanel: ScientificPanelPlacement,
  temporalRect: ScientificRect,
  temporalHistory: TemporalHistorySnapshot,
  thetaFlat: boolean,
) => {
  const yorkLane = resolveYorkLaneConvention(resolveRequestedYorkLaneId(payload));
  const timestamp = new Date().toISOString();
  const sourceParams = parseMetricRefSourceParams(payload);
  const sourceSummary = summarizeMetricRefSourceParams(sourceParams);
  const subtitleParts = [
    "york-time theta transport + canonical slice",
    `chart=${ctx.chart ?? payload.solve?.chart ?? "unknown"}`,
    `source=${ctx.metricSource ?? "unknown"}`,
    `field=${transportField.key}`,
    formatSupportSummary(ctx),
    `dims=${brick.dims.join("x")}`,
  ];
  if (sourceSummary) subtitleParts.push(`solve(${sourceSummary})`);
  if (thetaFlat) subtitleParts.push("theta regime=near-zero");
  const subtitle = subtitleParts.join(" | ");
  const diag = `null residual=${fmtScientific(
    ctx.diagnostics.maxNullResidual,
    4,
  )} | convergence=${fmtScientific(
    ctx.diagnostics.stepConvergence,
    4,
  )} | bundle spread=${fmtScientific(
    ctx.diagnostics.bundleSpread,
    4,
  )} | consistency=${ctx.diagnostics.consistency} | ${formatSupportSummary(ctx)}`;
  const temporalLatest = temporalHistory.latest;
  const temporalSummary = temporalLatest
    ? `series=${temporalHistory.series.length} | t=${fmtScientific(
        temporalLatest.timeS,
        3,
      )} s | theta_rms=${fmtScientific(
        temporalLatest.thetaRms,
        3,
      )} | H_rms=${fmtScientific(temporalLatest.hRms, 3)} | rho_rms=${fmtScientific(
        temporalLatest.rhoRms,
        3,
      )}`
    : "series=0";
  const transportDiag = `method=${transportStats.method} | rays=${transportStats.rays} | samples=${transportStats.samples} | null(max=${fmtScientific(
    transportStats.maxNullResidual,
    3,
  )}, mean=${fmtScientific(transportStats.meanNullResidual, 3)}) | escaped=${fmtScientific(
    transportStats.escapedPct,
    1,
  )}% | gain=${fmtScientific(transportStats.displayGain, 2)} | shell=${fmtScientific(
    transportStats.shellAssist,
    2,
  )}${transportStats.lowSignal ? " | low-signal-enhanced" : ""}`;
  const yorkRange = `range ${fmtScientific(yorkPanel.slice.min, 3)} .. ${fmtScientific(
    yorkPanel.slice.max,
    3,
  )} | normalization=symmetric-about-zero | slice support ${fmtScientific(yorkPanel.slice.supportPct, 1)}%`;
  const yorkAnnotation = yorkPanel.slice.annotation
    ? String(yorkPanel.slice.annotation)
    : "fore(+x) contraction(theta<0) / aft(-x) expansion(theta>0) sign map";

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="40" fill="#050a14"/>
  <text x="16" y="22" fill="#e8f3ff" font-size="16" font-weight="700">NHM2 York-Time 3+1 (transport + canonical slice)</text>
  <text x="16" y="36" fill="#9fb3ca" font-size="10">${escapeXml(subtitle)}</text>
  <text x="${transportRect.x + 8}" y="${transportRect.y + 16}" fill="#cfe5ff" font-size="11" font-weight="600">3D Theta Transport (Christoffel null-geodesic bundle)</text>
  <text x="${transportRect.x + 8}" y="${transportRect.y + 30}" fill="#9fb3ca" font-size="10">${escapeXml(`${transportField.label} [${transportField.key}]`)}</text>
  <text x="${transportRect.x + 8}" y="${transportRect.y + 44}" fill="#7f93ac" font-size="10">${escapeXml(transportDiag)}</text>
  <text x="${yorkPanel.x + 8}" y="${yorkPanel.y + 16}" fill="#cfe5ff" font-size="11" font-weight="600">${escapeXml(yorkPanel.slice.label)}</text>
  <text x="${yorkPanel.x + 8}" y="${yorkPanel.y + 30}" fill="#9fb3ca" font-size="10">${escapeXml(yorkRange)}</text>
  <text x="${yorkPanel.x + 8}" y="${yorkPanel.y + yorkPanel.height - 22}" fill="#8ec6ff" font-size="10">${escapeXml(`${yorkAnnotation} | ${yorkPanel.slice.sampling}`)}</text>
  <text x="${yorkPanel.x + 8}" y="${yorkPanel.y + yorkPanel.height - 10}" fill="#7f93ac" font-size="10">${escapeXml(`metric_ref_hash=${payload.metricVolumeRef?.hash ?? "none"} | theta_definition=${yorkLane.theta_definition} | slice_plane=x-z-midplane`)}</text>
  <text x="${temporalRect.x + 8}" y="${temporalRect.y + 14}" fill="#cfe5ff" font-size="11" font-weight="600">Temporal RMS History (|theta|, |H|, |rho|)</text>
  <text x="${temporalRect.x + 8}" y="${temporalRect.y + temporalRect.height - 8}" fill="#7f93ac" font-size="10">${escapeXml(temporalSummary)}</text>
  <rect x="0" y="${height - 24}" width="${width}" height="24" fill="#050a14"/>
  <text x="16" y="${height - 8}" fill="#9fb3ca" font-size="10">${escapeXml(diag)} | generated=${escapeXml(timestamp)}</text>
</svg>`;
};

// This view follows the York-time surface plotting convention used in White's NASA
// warp-field figures: fixed-time slice, motion axis on x, transverse axis on rho
// or a Cartesian midplane, scalar theta as height/color.
// White uses York-time surface plots as the scalar visualization. This repo
// preserves the same scalar/axis convention while binding the frame to a
// certified NHM2 snapshot identity.
const buildYorkSurfaceOverlaySvg = (
  width: number,
  height: number,
  payload: HullMisRenderRequestV1,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
  panel: ScientificRect,
  stats: YorkSurfaceRenderStats,
): string => {
  const yorkLane = resolveYorkLaneConvention(resolveRequestedYorkLaneId(payload));
  const timestamp = new Date().toISOString();
  const transverseAxisLabel = stats.coordinateMode === "x-rho" ? "rho" : "z";
  const slicePlane = stats.coordinateMode === "x-rho" ? "x-rho" : "x-z-midplane";
  const sourceParams = parseMetricRefSourceParams(payload);
  const sourceSummary = summarizeMetricRefSourceParams(sourceParams);
  const subtitleParts = [
    "single-snapshot York surface",
    `motion axis x, transverse ${transverseAxisLabel}, height=${yorkLane.theta_definition}`,
    "White/NASA scalar York-time surface convention",
    "certified NHM2 snapshot lock",
    `chart=${ctx.chart ?? payload.solve?.chart ?? "unknown"}`,
    `source=${ctx.metricSource ?? "unknown"}`,
    `dims=${brick.dims.join("x")}`,
    formatSupportSummary(ctx),
  ];
  if (sourceSummary) subtitleParts.push(`solve(${sourceSummary})`);
  if (stats.nearZeroTheta) subtitleParts.push("theta regime=near-zero");
  const subtitle = subtitleParts.join(" | ");
  const coordinateSummary = `coordinate_mode=${stats.coordinateMode}`;
  const rangeSummary = `theta range ${fmtScientific(stats.minTheta, 3)} .. ${fmtScientific(
    stats.maxTheta,
    3,
  )} | normalization=symmetric-about-zero | display_gain=${fmtScientific(
    stats.displayGain,
    2,
  )} (none; raw theta) | height_scale=${fmtScientific(stats.heightScale, 3)}`;
  const contourSummary = `zero-contour segments=${stats.zeroContourSegments} | grid=${stats.nx}x${stats.nz} | surface_height=theta`;
  const certSummary = `metric_ref_hash=${payload.metricVolumeRef?.hash ?? "none"} | theta_definition=${yorkLane.theta_definition} | slice_plane=${slicePlane} | ${coordinateSummary} | sampling=${stats.samplingChoice}`;
  const diag = `null residual=${fmtScientific(
    ctx.diagnostics.maxNullResidual,
    4,
  )} | convergence=${fmtScientific(ctx.diagnostics.stepConvergence, 4)} | bundle spread=${fmtScientific(
    ctx.diagnostics.bundleSpread,
    4,
  )} | consistency=${ctx.diagnostics.consistency} | ${formatSupportSummary(ctx)}`;
  const nearZeroBadge = stats.nearZeroTheta
    ? `<rect x="${panel.x + 8}" y="${panel.y + 34}" width="166" height="18" rx="3" fill="#7a4f0f" stroke="#f0b95f" stroke-width="1"/>
  <text x="${panel.x + 16}" y="${panel.y + 47}" fill="#ffe2aa" font-size="10" font-weight="700">near-zero theta (no fake gain)</text>`
    : "";

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="40" fill="#050a14"/>
  <text x="16" y="22" fill="#e8f3ff" font-size="16" font-weight="700">NHM2 York Surface 3+1 (paper-style scalar surface)</text>
  <text x="16" y="36" fill="#9fb3ca" font-size="10">${escapeXml(subtitle)}</text>
  <text x="${panel.x + 8}" y="${panel.y + 16}" fill="#cfe5ff" font-size="11" font-weight="600">${escapeXml(`York Surface: motion axis x, transverse ${transverseAxisLabel}, height(theta), signed diverging color`)}</text>
  ${nearZeroBadge}
  <text x="${panel.x + 8}" y="${panel.y + panel.height - 34}" fill="#9fb3ca" font-size="10">${escapeXml(rangeSummary)}</text>
  <text x="${panel.x + 8}" y="${panel.y + panel.height - 22}" fill="#8ec6ff" font-size="10">fore(+x) contraction(theta&lt;0) | aft(-x) expansion(theta&gt;0) | zero contour overlay</text>
  <text x="${panel.x + 8}" y="${panel.y + panel.height - 10}" fill="#7f93ac" font-size="10">${escapeXml(`${contourSummary} | ${certSummary}`)}</text>
  <rect x="0" y="${height - 24}" width="${width}" height="24" fill="#050a14"/>
  <text x="16" y="${height - 8}" fill="#9fb3ca" font-size="10">${escapeXml(diag)} | generated=${escapeXml(timestamp)}</text>
</svg>`;
};

// "This normalized York view is topology-only and is not the raw-magnitude
// figure used in the primary scientific paper convention."
// NHM2 inspection aid: this companion panel is used when certified raw York
// magnitude is near-zero and topology visibility would otherwise be poor.
const buildYorkTopologyNormalizedOverlaySvg = (
  width: number,
  height: number,
  payload: HullMisRenderRequestV1,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
  panel: ScientificRect,
  stats: YorkSurfaceRenderStats,
  rawYorkStats: YorkFrameDiagnosticStats,
): string => {
  const timestamp = new Date().toISOString();
  const sourceParams = parseMetricRefSourceParams(payload);
  const sourceSummary = summarizeMetricRefSourceParams(sourceParams);
  const subtitleParts = [
    "single-snapshot NHM2 York topology companion",
    "x-z midplane, height=theta_norm, signed diverging color",
    "normalized topology only (not raw magnitude)",
    `chart=${ctx.chart ?? payload.solve?.chart ?? "unknown"}`,
    `source=${ctx.metricSource ?? "unknown"}`,
    `dims=${brick.dims.join("x")}`,
    formatSupportSummary(ctx),
  ];
  if (sourceSummary) subtitleParts.push(`solve(${sourceSummary})`);
  if (rawYorkStats.nearZeroTheta) subtitleParts.push("raw theta regime=near-zero");
  const subtitle = subtitleParts.join(" | ");
  const normSummary = `theta_norm range ${fmtScientific(
    stats.minTheta,
    3,
  )} .. ${fmtScientific(stats.maxTheta, 3)} | normalization=topology-only-unit-max | magnitude_mode=normalized-topology-only | surface_height=theta_norm`;
  const rawSummary = `raw theta range ${fmtScientific(
    rawYorkStats.thetaMinRaw,
    3,
  )} .. ${fmtScientific(rawYorkStats.thetaMaxRaw, 3)} | theta_abs_max_raw=${fmtScientific(
    rawYorkStats.thetaAbsMaxRaw,
    3,
  )} | near_zero_theta=${String(rawYorkStats.nearZeroTheta)}`;
  const displaySummary = `display theta range ${fmtScientific(
    rawYorkStats.thetaMinDisplay,
    3,
  )} .. ${fmtScientific(rawYorkStats.thetaMaxDisplay, 3)} | theta_abs_max_display=${fmtScientific(
    rawYorkStats.thetaAbsMaxDisplay,
    3,
  )} | display_range_method=${rawYorkStats.displayRangeMethod}`;
  const contourSummary = `zero contour segments=${stats.zeroContourSegments} | sampling=${stats.samplingChoice} | display_gain=${fmtScientific(
    rawYorkStats.displayGain,
    2,
  )} | height_scale=${fmtScientific(rawYorkStats.heightScale, 3)}`;
  const certSummary = `metric_ref_hash=${payload.metricVolumeRef?.hash ?? "none"} | field_key=theta | slice_plane=x-z-midplane`;
  const diag = `null residual=${fmtScientific(
    ctx.diagnostics.maxNullResidual,
    4,
  )} | convergence=${fmtScientific(ctx.diagnostics.stepConvergence, 4)} | bundle spread=${fmtScientific(
    ctx.diagnostics.bundleSpread,
    4,
  )} | consistency=${ctx.diagnostics.consistency} | ${formatSupportSummary(ctx)}`;
  const disclosureBadge = `<rect x="${panel.x + 8}" y="${panel.y + 34}" width="282" height="18" rx="3" fill="#1f3650" stroke="#7dc4ff" stroke-width="1"/>
  <text x="${panel.x + 16}" y="${panel.y + 47}" fill="#d9f0ff" font-size="10" font-weight="700">normalized topology only (not raw-magnitude paper figure)</text>`;

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="40" fill="#050a14"/>
  <text x="16" y="22" fill="#e8f3ff" font-size="16" font-weight="700">NHM2 York Topology Normalized 3+1 (companion panel)</text>
  <text x="16" y="36" fill="#9fb3ca" font-size="10">${escapeXml(subtitle)}</text>
  <text x="${panel.x + 8}" y="${panel.y + 16}" fill="#cfe5ff" font-size="11" font-weight="600">York topology surface: x-z midplane, height(theta_norm), signed diverging color</text>
  ${disclosureBadge}
  <text x="${panel.x + 8}" y="${panel.y + panel.height - 58}" fill="#9fb3ca" font-size="10">${escapeXml(normSummary)}</text>
  <text x="${panel.x + 8}" y="${panel.y + panel.height - 46}" fill="#8ec6ff" font-size="10">${escapeXml(rawSummary)}</text>
  <text x="${panel.x + 8}" y="${panel.y + panel.height - 34}" fill="#8ec6ff" font-size="10">${escapeXml(displaySummary)}</text>
  <text x="${panel.x + 8}" y="${panel.y + panel.height - 22}" fill="#8ec6ff" font-size="10">${escapeXml(contourSummary)}</text>
  <text x="${panel.x + 8}" y="${panel.y + panel.height - 10}" fill="#7f93ac" font-size="10">${escapeXml(certSummary)}</text>
  <rect x="0" y="${height - 24}" width="${width}" height="24" fill="#050a14"/>
  <text x="16" y="${height - 8}" fill="#9fb3ca" font-size="10">${escapeXml(diag)} | generated=${escapeXml(timestamp)}</text>
</svg>`;
};

const buildYorkShellMapOverlaySvg = (
  width: number,
  height: number,
  payload: HullMisRenderRequestV1,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
  panel: ScientificRect,
  stats: YorkSurfaceRenderStats,
  shellSupportPct: number,
  yorkDiag: YorkFrameDiagnosticStats,
): string => {
  const timestamp = new Date().toISOString();
  const sourceParams = parseMetricRefSourceParams(payload);
  const sourceSummary = summarizeMetricRefSourceParams(sourceParams);
  const subtitleParts = [
    "single-snapshot NHM2 York shell map",
    "shell-localized theta on tile_support_mask shell band (hull_sdf contour overlay)",
    "Natario low-expansion + Alcubierre/White fore-aft geometry interpretation",
    `chart=${ctx.chart ?? payload.solve?.chart ?? "unknown"}`,
    `source=${ctx.metricSource ?? "unknown"}`,
    `dims=${brick.dims.join("x")}`,
    formatSupportSummary(ctx),
  ];
  if (sourceSummary) subtitleParts.push(`solve(${sourceSummary})`);
  if (stats.nearZeroTheta) subtitleParts.push("theta regime=near-zero");
  const subtitle = subtitleParts.join(" | ");
  const rangeSummary = `theta(shell) range ${fmtScientific(
    stats.minTheta,
    3,
  )} .. ${fmtScientific(stats.maxTheta, 3)} | normalization=symmetric-about-zero | display_gain=${fmtScientific(
    stats.displayGain,
    2,
  )} (none; raw theta) | height_scale=${fmtScientific(stats.heightScale, 3)}`;
  const shellSummary = `shell support=${fmtScientific(
    shellSupportPct,
    1,
  )}% | supported_theta_fraction=${fmtScientific(
    yorkDiag.supportedThetaFraction,
    4,
  )} | shell_theta_overlap_pct=${fmtScientific(yorkDiag.shellThetaOverlapPct, 2)}%`;
  const certSummary = `metric_ref_hash=${payload.metricVolumeRef?.hash ?? "none"} | field_key=theta | slice_plane=x-z-midplane | support_overlay=hull_sdf+tile_support_mask | sampling=${stats.samplingChoice}`;
  const diag = `null residual=${fmtScientific(
    ctx.diagnostics.maxNullResidual,
    4,
  )} | convergence=${fmtScientific(ctx.diagnostics.stepConvergence, 4)} | bundle spread=${fmtScientific(
    ctx.diagnostics.bundleSpread,
    4,
  )} | consistency=${ctx.diagnostics.consistency} | ${formatSupportSummary(ctx)}`;
  const nearZeroBadge = stats.nearZeroTheta
    ? `<rect x="${panel.x + 8}" y="${panel.y + 34}" width="206" height="18" rx="3" fill="#7a4f0f" stroke="#f0b95f" stroke-width="1"/>
  <text x="${panel.x + 16}" y="${panel.y + 47}" fill="#ffe2aa" font-size="10" font-weight="700">near-zero theta (geometry remains nontrivial)</text>`
    : "";
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="40" fill="#050a14"/>
  <text x="16" y="22" fill="#e8f3ff" font-size="16" font-weight="700">NHM2 York Shell Map 3+1 (Natario-localized interpretation)</text>
  <text x="16" y="36" fill="#9fb3ca" font-size="10">${escapeXml(subtitle)}</text>
  <text x="${panel.x + 8}" y="${panel.y + 16}" fill="#cfe5ff" font-size="11" font-weight="600">Shell-localized York map: signed theta color over hull/support geometry</text>
  ${nearZeroBadge}
  <text x="${panel.x + 8}" y="${panel.y + panel.height - 34}" fill="#9fb3ca" font-size="10">${escapeXml(rangeSummary)}</text>
  <text x="${panel.x + 8}" y="${panel.y + panel.height - 22}" fill="#8ec6ff" font-size="10">${escapeXml(shellSummary)}</text>
  <text x="${panel.x + 8}" y="${panel.y + panel.height - 10}" fill="#7f93ac" font-size="10">${escapeXml(certSummary)}</text>
  <rect x="0" y="${height - 24}" width="${width}" height="24" fill="#050a14"/>
  <text x="16" y="${height - 8}" fill="#9fb3ca" font-size="10">${escapeXml(diag)} | generated=${escapeXml(timestamp)}</text>
</svg>`;
};

const buildShiftShellOverlaySvg = (
  width: number,
  height: number,
  payload: HullMisRenderRequestV1,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
  panel: ScientificPanelPlacement,
  stats: ShiftShellRenderStats,
): string => {
  const timestamp = new Date().toISOString();
  const sourceParams = parseMetricRefSourceParams(payload);
  const sourceSummary = summarizeMetricRefSourceParams(sourceParams);
  const subtitleParts = [
    "single-snapshot NHM2 shift shell frame",
    "x-z midplane, field=beta_x, diverging signed map",
    `chart=${ctx.chart ?? payload.solve?.chart ?? "unknown"}`,
    `source=${ctx.metricSource ?? "unknown"}`,
    `dims=${brick.dims.join("x")}`,
    formatSupportSummary(ctx),
  ];
  if (sourceSummary) subtitleParts.push(`solve(${sourceSummary})`);
  const subtitle = subtitleParts.join(" | ");
  const rangeSummary = `beta_x range ${fmtScientific(stats.betaMin, 4)} .. ${fmtScientific(
    stats.betaMax,
    4,
  )} | |beta|_max=${fmtScientific(stats.betaAbsMax, 4)} | normalization=symmetric-about-zero`;
  const shellSummary = `slice_support=${fmtScientific(
    stats.sliceSupportPct,
    1,
  )}% | support_overlap=${fmtScientific(stats.supportOverlapPct, 1)}% | hull_contours=${stats.hullContourSegments} | support_contours=${stats.supportContourSegments}`;
  const peakSummary = `peak_beta_cell=${
    stats.peakBetaCell ? `[${stats.peakBetaCell.join(",")}]` : "none"
  } | peak_beta_in_supported_region=${stats.peakBetaInSupportedRegion == null ? "unknown" : String(stats.peakBetaInSupportedRegion)}`;
  const certSummary = `metric_ref_hash=${payload.metricVolumeRef?.hash ?? "none"} | field_key=beta_x | slice_plane=x-z-midplane | support_overlay=hull_sdf+tile_support_mask`;
  const diag = `null residual=${fmtScientific(
    ctx.diagnostics.maxNullResidual,
    4,
  )} | convergence=${fmtScientific(ctx.diagnostics.stepConvergence, 4)} | bundle spread=${fmtScientific(
    ctx.diagnostics.bundleSpread,
    4,
  )} | consistency=${ctx.diagnostics.consistency} | ${formatSupportSummary(ctx)}`;
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="40" fill="#050a14"/>
  <text x="16" y="22" fill="#e8f3ff" font-size="16" font-weight="700">NHM2 Shift Shell 3+1 (single certified snapshot)</text>
  <text x="16" y="36" fill="#9fb3ca" font-size="10">${escapeXml(subtitle)}</text>
  <text x="${panel.x + 8}" y="${panel.y + 16}" fill="#cfe5ff" font-size="11" font-weight="600">${escapeXml(panel.slice.label)}</text>
  <text x="${panel.x + 8}" y="${panel.y + panel.height - 46}" fill="#9fb3ca" font-size="10">${escapeXml(rangeSummary)}</text>
  <text x="${panel.x + 8}" y="${panel.y + panel.height - 34}" fill="#8ec6ff" font-size="10">${escapeXml(shellSummary)}</text>
  <text x="${panel.x + 8}" y="${panel.y + panel.height - 22}" fill="#8ec6ff" font-size="10">${escapeXml(peakSummary)}</text>
  <text x="${panel.x + 8}" y="${panel.y + panel.height - 10}" fill="#7f93ac" font-size="10">${escapeXml(`${panel.slice.sampling} | ${certSummary}`)}</text>
  <rect x="0" y="${height - 24}" width="${width}" height="24" fill="#050a14"/>
  <text x="16" y="${height - 8}" fill="#9fb3ca" font-size="10">${escapeXml(diag)} | generated=${escapeXml(timestamp)}</text>
</svg>`;
};

const buildTransport3p1OverlaySvg = (
  width: number,
  height: number,
  payload: HullMisRenderRequestV1,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
  transportRect: ScientificRect,
  transportField: VolumeFieldSelection | null,
  transportStats: ScientificTransportRenderStats,
  temporalRect: ScientificRect,
  temporalHistory: TemporalHistorySnapshot,
) => {
  const timestamp = new Date().toISOString();
  const sourceParams = parseMetricRefSourceParams(payload);
  const sourceSummary = summarizeMetricRefSourceParams(sourceParams);
  const subtitleParts = [
    "frame=view:3+1 transport",
    `chart=${ctx.chart ?? payload.solve?.chart ?? "unknown"}`,
    `source=${ctx.metricSource ?? "unknown"}`,
    `field=${transportField?.key ?? "unavailable"}`,
    formatSupportSummary(ctx),
    `dims=${brick.dims.join("x")}`,
  ];
  if (sourceSummary) subtitleParts.push(`solve(${sourceSummary})`);
  const subtitle = subtitleParts.join(" | ");
  const diag = `null residual=${fmtScientific(
    ctx.diagnostics.maxNullResidual,
    4,
  )} | convergence=${fmtScientific(
    ctx.diagnostics.stepConvergence,
    4,
  )} | bundle spread=${fmtScientific(
    ctx.diagnostics.bundleSpread,
    4,
  )} | consistency=${ctx.diagnostics.consistency} | ${formatSupportSummary(ctx)}`;
  const temporalLatest = temporalHistory.latest;
  const temporalSummary = temporalLatest
    ? `series=${temporalHistory.series.length} | t=${fmtScientific(
        temporalLatest.timeS,
        3,
      )} s | theta_rms=${fmtScientific(
        temporalLatest.thetaRms,
        3,
      )} | H_rms=${fmtScientific(temporalLatest.hRms, 3)} | rho_rms=${fmtScientific(
        temporalLatest.rhoRms,
        3,
      )}`
    : "series=0";
  const transportTitle = transportField
    ? `${transportField.label} [${transportField.key}]`
    : "Transport field unavailable";
  const transportRange = transportField
    ? `range ${fmtScientific(transportField.min, 3)} .. ${fmtScientific(
        transportField.max,
        3,
      )} | volume=${brick.dims.join("x")}`
    : "no decodable canonical field";
  const transportDiag = `method=${transportStats.method} | rays=${transportStats.rays} | samples=${transportStats.samples} | null(max=${fmtScientific(
    transportStats.maxNullResidual,
    3,
  )}, mean=${fmtScientific(transportStats.meanNullResidual, 3)}) | escaped=${fmtScientific(
    transportStats.escapedPct,
    1,
  )}% | gain=${fmtScientific(transportStats.displayGain, 2)} | shell=${fmtScientific(
    transportStats.shellAssist,
    2,
  )}${transportStats.lowSignal ? " | low-signal-enhanced" : ""}`;

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="40" fill="#050a14"/>
  <text x="16" y="22" fill="#e8f3ff" font-size="16" font-weight="700">NHM2 Canonical 3+1 Frame Transport View</text>
  <text x="16" y="36" fill="#9fb3ca" font-size="10">${escapeXml(subtitle)}</text>
  <text x="${transportRect.x + 8}" y="${transportRect.y + 16}" fill="#cfe5ff" font-size="11" font-weight="600">3D Volume Transport (Christoffel null-geodesic bundle)</text>
  <text x="${transportRect.x + 8}" y="${transportRect.y + 30}" fill="#9fb3ca" font-size="10">${escapeXml(transportTitle)}</text>
  <text x="${transportRect.x + 8}" y="${transportRect.y + 44}" fill="#7f93ac" font-size="10">${escapeXml(transportDiag)}</text>
  <text x="${transportRect.x + 8}" y="${transportRect.y + transportRect.height - 8}" fill="#7f93ac" font-size="10">${escapeXml(transportRange)}</text>
  <text x="${temporalRect.x + 8}" y="${temporalRect.y + 14}" fill="#cfe5ff" font-size="11" font-weight="600">Temporal RMS History (|theta|, |H|, |rho|)</text>
  <text x="${temporalRect.x + 8}" y="${temporalRect.y + temporalRect.height - 8}" fill="#7f93ac" font-size="10">${escapeXml(temporalSummary)}</text>
  <rect x="0" y="${height - 24}" width="${width}" height="24" fill="#050a14"/>
  <text x="16" y="${height - 8}" fill="#9fb3ca" font-size="10">${escapeXml(diag)} | generated=${escapeXml(timestamp)}</text>
</svg>`;
};

const renderTensorFrameDiagnostic = async (
  payload: HullMisRenderRequestV1,
  _deterministicSeed: number,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
): Promise<Buffer> => {
  const width = payload.width;
  const height = payload.height;
  const image = Buffer.alloc(width * height * 4, 0);
  fillRect(image, width, height, 0, 0, width, height, [6, 10, 18]);

  const outerPadX = Math.max(12, Math.floor(width * 0.02));
  const topPad = 44;
  const bottomPad = 30;
  const columnGap = 14;
  const rowGap = 12;
  const samplingMode: ScientificRenderSamplingMode =
    payload.scienceLane?.samplingMode === "nearest" ? "nearest" : "trilinear";
  const availableW = Math.max(200, width - outerPadX * 2);
  const availableH = Math.max(160, height - topPad - bottomPad);
  const mainHeight = clampi(
    Math.floor(availableH * 0.74),
    64,
    Math.max(64, availableH - rowGap - 24),
  );
  const temporalHeight = Math.max(24, availableH - mainHeight - rowGap);
  const minRightWidth = 120;
  const transportWidth = clampi(
    Math.floor(availableW * 0.58),
    100,
    Math.max(100, availableW - minRightWidth - columnGap),
  );
  const rightWidth = Math.max(80, availableW - transportWidth - columnGap);
  const sliceGap = 10;
  const panelWidth = Math.max(32, Math.floor((rightWidth - sliceGap) * 0.5));
  const panelHeight = Math.max(32, Math.floor((mainHeight - sliceGap) * 0.5));
  const transportRect: ScientificRect = {
    x: outerPadX,
    y: topPad,
    width: transportWidth,
    height: mainHeight,
  };
  const rightX = outerPadX + transportWidth + columnGap;
  const slices = buildScientificSlices(brick);
  const panels: ScientificPanelPlacement[] = [
    {
      x: rightX,
      y: topPad,
      width: panelWidth,
      height: panelHeight,
      slice: slices[0]!,
    },
    {
      x: rightX + panelWidth + sliceGap,
      y: topPad,
      width: panelWidth,
      height: panelHeight,
      slice: slices[1]!,
    },
    {
      x: rightX,
      y: topPad + panelHeight + sliceGap,
      width: panelWidth,
      height: panelHeight,
      slice: slices[2]!,
    },
    {
      x: rightX + panelWidth + sliceGap,
      y: topPad + panelHeight + sliceGap,
      width: panelWidth,
      height: panelHeight,
      slice: slices[3]!,
    },
  ];
  const temporalRect: ScientificRect = {
    x: outerPadX,
    y: topPad + mainHeight + rowGap,
    width: availableW,
    height: temporalHeight,
  };
  const transportField = selectVolumeField(brick, ctx);
  const temporalHistory = appendTemporalHistory(payload, brick, ctx);
  let transportStats: ScientificTransportRenderStats = {
    method: "unavailable",
    rays: 0,
    samples: 0,
    maxNullResidual: 0,
    meanNullResidual: 0,
    escapedPct: 0,
    displayGain: 1,
    shellAssist: 0,
    lowSignal: false,
  };
  if (transportField) {
    transportStats = renderVolumeTransportPanel(
      image,
      width,
      height,
      transportRect,
      brick,
      transportField,
      null,
    );
  } else {
    fillRect(
      image,
      width,
      height,
      transportRect.x,
      transportRect.y,
      transportRect.width,
      transportRect.height,
      [8, 14, 22],
    );
    drawRectStroke(
      image,
      width,
      height,
      transportRect.x,
      transportRect.y,
      transportRect.width,
      transportRect.height,
      [70, 86, 107],
    );
  }
  for (const panel of panels) renderSlicePanel(image, width, height, panel, samplingMode);
  renderTemporalHistoryStrip(image, width, height, temporalRect, temporalHistory);

  const base = await sharp(image, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
  const overlaySvg = buildScientificOverlaySvg(
    width,
    height,
    panels,
    payload,
    ctx,
    brick,
    samplingMode,
    transportRect,
    transportField,
    transportStats,
    temporalRect,
    temporalHistory,
  );
  return sharp(base)
    .composite([{ input: Buffer.from(overlaySvg), blend: "over" }])
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
};

const renderTensorFrameTransport3p1 = async (
  payload: HullMisRenderRequestV1,
  _deterministicSeed: number,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
): Promise<Buffer> => {
  const width = payload.width;
  const height = payload.height;
  const image = Buffer.alloc(width * height * 4, 0);
  fillRect(image, width, height, 0, 0, width, height, [6, 10, 18]);

  const outerPadX = Math.max(12, Math.floor(width * 0.02));
  const topPad = 44;
  const bottomPad = 30;
  const rowGap = 12;
  const availableW = Math.max(200, width - outerPadX * 2);
  const availableH = Math.max(160, height - topPad - bottomPad);
  const mainHeight = clampi(
    Math.floor(availableH * 0.8),
    80,
    Math.max(80, availableH - rowGap - 28),
  );
  const temporalHeight = Math.max(24, availableH - mainHeight - rowGap);
  const transportRect: ScientificRect = {
    x: outerPadX,
    y: topPad,
    width: availableW,
    height: mainHeight,
  };
  const temporalRect: ScientificRect = {
    x: outerPadX,
    y: topPad + mainHeight + rowGap,
    width: availableW,
    height: temporalHeight,
  };
  const transportField =
    selectTransportFieldForFrame(brick, ctx) ?? selectVolumeField(brick, ctx);
  let transportStats: ScientificTransportRenderStats = {
    method: "unavailable",
    rays: 0,
    samples: 0,
    maxNullResidual: 0,
    meanNullResidual: 0,
    escapedPct: 0,
    displayGain: 1,
    shellAssist: 0,
    lowSignal: false,
  };
  if (transportField) {
    transportStats = renderVolumeTransportPanel(
      image,
      width,
      height,
      transportRect,
      brick,
      transportField,
      ctx.supportProjection,
    );
  } else {
    fillRect(
      image,
      width,
      height,
      transportRect.x,
      transportRect.y,
      transportRect.width,
      transportRect.height,
      [8, 14, 22],
    );
    drawRectStroke(
      image,
      width,
      height,
      transportRect.x,
      transportRect.y,
      transportRect.width,
      transportRect.height,
      [70, 86, 107],
    );
  }
  const temporalHistory = appendTemporalHistory(payload, brick, ctx);
  renderTemporalHistoryStrip(image, width, height, temporalRect, temporalHistory);
  const base = await sharp(image, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
  const overlaySvg = buildTransport3p1OverlaySvg(
    width,
    height,
    payload,
    ctx,
    brick,
    transportRect,
    transportField,
    transportStats,
    temporalRect,
    temporalHistory,
  );
  return sharp(base)
    .composite([{ input: Buffer.from(overlaySvg), blend: "over" }])
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
};

const renderTensorFramePaperRho = async (
  payload: HullMisRenderRequestV1,
  _deterministicSeed: number,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
): Promise<Buffer> => {
  const width = payload.width;
  const height = payload.height;
  const image = Buffer.alloc(width * height * 4, 0);
  fillRect(image, width, height, 0, 0, width, height, [6, 10, 18]);

  const outerPadX = Math.max(14, Math.floor(width * 0.025));
  const topPad = 50;
  const bottomPad = 30;
  const panel: ScientificPanelPlacement = {
    x: outerPadX,
    y: topPad,
    width: Math.max(120, width - outerPadX * 2),
    height: Math.max(90, height - topPad - bottomPad),
    slice:
      buildScientificSlices(brick)[0] ?? {
        key: "rho_eulerian_missing",
        label: "Eulerian Energy Density rho_E (missing)",
        unit: "n/a",
        mode: "diverging",
        width: 1,
        height: 1,
        data: new Float32Array([0]),
        min: -1,
        max: 1,
        sampling: "x-z midplane",
        supportPct: 0,
        annotation: null,
      },
  };
  const samplingMode: ScientificRenderSamplingMode =
    payload.scienceLane?.samplingMode === "nearest" ? "nearest" : "trilinear";
  renderSlicePanel(image, width, height, panel, samplingMode);

  const base = await sharp(image, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
  const overlaySvg = buildPaperRhoOverlaySvg(
    width,
    height,
    panel,
    payload,
    ctx,
    brick,
    samplingMode,
  );
  return sharp(base)
    .composite([{ input: Buffer.from(overlaySvg), blend: "over" }])
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
};

const renderTensorFrameYorkTime3p1 = async (
  payload: HullMisRenderRequestV1,
  _deterministicSeed: number,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
): Promise<Buffer> => {
  const yorkLane = resolveYorkLaneConvention(resolveRequestedYorkLaneId(payload));
  const thetaChannel = brick.channels.theta?.data;
  if (!(thetaChannel instanceof Float32Array)) {
    throw new Error("scientific_york_theta_missing");
  }
  const width = payload.width;
  const height = payload.height;
  const image = Buffer.alloc(width * height * 4, 0);
  fillRect(image, width, height, 0, 0, width, height, [6, 10, 18]);

  const outerPadX = Math.max(12, Math.floor(width * 0.02));
  const topPad = 44;
  const bottomPad = 30;
  const columnGap = 12;
  const rowGap = 12;
  const availableW = Math.max(200, width - outerPadX * 2);
  const availableH = Math.max(160, height - topPad - bottomPad);
  const mainHeight = clampi(
    Math.floor(availableH * 0.8),
    80,
    Math.max(80, availableH - rowGap - 28),
  );
  const temporalHeight = Math.max(24, availableH - mainHeight - rowGap);
  const transportWidth = clampi(
    Math.floor(availableW * 0.62),
    140,
    Math.max(140, availableW - 180),
  );
  const sliceWidth = Math.max(120, availableW - transportWidth - columnGap);
  const transportRect: ScientificRect = {
    x: outerPadX,
    y: topPad,
    width: transportWidth,
    height: mainHeight,
  };
  const yorkPanel: ScientificPanelPlacement = {
    x: outerPadX + transportWidth + columnGap,
    y: topPad,
    width: sliceWidth,
    height: mainHeight,
    // Raw York audit lane is fixed-slice only; adaptive projection is forbidden.
    slice: buildScientificSliceFromChannel(
      brick,
      "theta",
      `York-Time ${yorkLane.theta_definition}`,
      "1/m",
      "diverging",
      "midplane",
    ),
  };
  yorkPanel.slice.annotation =
    "fore(+x) contraction(theta<0) / aft(-x) expansion(theta>0) sign map";
  const temporalRect: ScientificRect = {
    x: outerPadX,
    y: topPad + mainHeight + rowGap,
    width: availableW,
    height: temporalHeight,
  };
  const samplingMode: ScientificRenderSamplingMode =
    payload.scienceLane?.samplingMode === "nearest" ? "nearest" : "trilinear";
  const transportField: VolumeFieldSelection = {
    key: "theta",
    label: "Transport theta",
    mode: "diverging",
    data: thetaChannel,
    min: yorkPanel.slice.min,
    max: yorkPanel.slice.max,
  };
  const transportStats = renderVolumeTransportPanel(
    image,
    width,
    height,
    transportRect,
    brick,
    transportField,
    ctx.supportProjection,
  );
  renderSlicePanel(image, width, height, yorkPanel, samplingMode);
  const temporalHistory = appendTemporalHistory(payload, brick, ctx);
  renderTemporalHistoryStrip(image, width, height, temporalRect, temporalHistory);
  const thetaFlat = Math.abs(yorkPanel.slice.max - yorkPanel.slice.min) <= 1e-42;

  const base = await sharp(image, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
  const overlaySvg = buildYorkTimeTransportOverlaySvg(
    width,
    height,
    payload,
    ctx,
    brick,
    transportRect,
    transportField,
    transportStats,
    yorkPanel,
    temporalRect,
    temporalHistory,
    thetaFlat,
  );
  return sharp(base)
    .composite([{ input: Buffer.from(overlaySvg), blend: "over" }])
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
};

const renderTensorFrameYorkSurface3p1 = async (
  payload: HullMisRenderRequestV1,
  _deterministicSeed: number,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
): Promise<Buffer> => {
  const yorkLane = resolveYorkLaneConvention(resolveRequestedYorkLaneId(payload));
  const thetaChannel = brick.channels.theta?.data;
  if (!(thetaChannel instanceof Float32Array)) {
    throw new Error("scientific_york_theta_missing");
  }
  const width = payload.width;
  const height = payload.height;
  const image = Buffer.alloc(width * height * 4, 0);
  fillRect(image, width, height, 0, 0, width, height, [6, 10, 18]);

  const outerPadX = Math.max(12, Math.floor(width * 0.02));
  const topPad = 44;
  const bottomPad = 30;
  const panelRect: ScientificRect = {
    x: outerPadX,
    y: topPad,
    width: Math.max(120, width - outerPadX * 2),
    height: Math.max(96, height - topPad - bottomPad),
  };
  // Warp-bubble York plots are shown on a fixed-time slice with motion along x;
  // the transverse plotting coordinate is either cylindrical rho or a fixed
  // Cartesian midplane surrogate.
  // Raw York views do not permit adaptive projection. Coordinate mode is explicit
  // (`x-z-midplane` or `x-rho`) and serialized in certificate metadata.
  const yorkSurfaceRhoView = payload.scienceLane?.renderView === "york-surface-rho-3p1";
  const samplingPolicy: "midplane" | "x-rho" = yorkSurfaceRhoView
    ? "x-rho"
    : "midplane";
  const yorkSlice = buildScientificSliceFromChannel(
    brick,
    "theta",
    `York-Time ${yorkLane.theta_definition}`,
    "1/m",
    "diverging",
    samplingPolicy,
  );
  const surfaceStats = renderYorkSurfacePanel(
    image,
    width,
    height,
    panelRect,
    yorkSlice,
  );
  const base = await sharp(image, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
  const overlaySvg = buildYorkSurfaceOverlaySvg(
    width,
    height,
    payload,
    ctx,
    brick,
    panelRect,
    surfaceStats,
  );
  return sharp(base)
    .composite([{ input: Buffer.from(overlaySvg), blend: "over" }])
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
};

// "Natário's zero-expansion warp framing means York may be small while the
// geometry remains nontrivial; this view localizes York on the NHM2 shell/support
// geometry instead of treating York alone as the entire warp picture."
// NHM2-specific extension: this is not a historical paper plotting convention.
// It is justified by Natário-type low-expansion solutions, where geometry-
// localized interpretation (hull/support) is required even when York is small.
// This normalized York view is topology-only and is not the raw-magnitude
// figure used in the primary scientific paper convention.
const renderTensorFrameYorkTopologyNormalized3p1 = async (
  payload: HullMisRenderRequestV1,
  _deterministicSeed: number,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
): Promise<Buffer> => {
  const yorkLane = resolveYorkLaneConvention(resolveRequestedYorkLaneId(payload));
  const thetaChannel = brick.channels.theta?.data;
  if (!(thetaChannel instanceof Float32Array)) {
    throw new Error("scientific_york_theta_missing");
  }

  const width = payload.width;
  const height = payload.height;
  const image = Buffer.alloc(width * height * 4, 0);
  fillRect(image, width, height, 0, 0, width, height, [6, 10, 18]);

  const outerPadX = Math.max(12, Math.floor(width * 0.02));
  const topPad = 44;
  const bottomPad = 30;
  const panelRect: ScientificRect = {
    x: outerPadX,
    y: topPad,
    width: Math.max(120, width - outerPadX * 2),
    height: Math.max(96, height - topPad - bottomPad),
  };

  const yorkSlice = buildScientificSliceFromChannel(
    brick,
    "theta",
    `York-Time ${yorkLane.theta_definition}`,
    "1/m",
    "diverging",
    "midplane",
  );
  const thetaAbsMax = Math.max(Math.abs(yorkSlice.min), Math.abs(yorkSlice.max), 0);
  const normalizedTheta = new Float32Array(yorkSlice.data.length);
  if (thetaAbsMax > 0) {
    const invAbsMax = 1 / thetaAbsMax;
    for (let i = 0; i < yorkSlice.data.length; i += 1) {
      normalizedTheta[i] = (yorkSlice.data[i] ?? 0) * invAbsMax;
    }
  }
  const [normMin, normMax] = computeSliceRange(normalizedTheta, "diverging");
  const topologySlice: ScientificSlice = {
    key: "theta_norm",
    label: "York topology normalized (theta / max|theta|)",
    unit: "unitless",
    mode: "diverging",
    width: yorkSlice.width,
    height: yorkSlice.height,
    data: normalizedTheta,
    min: normMin,
    max: normMax,
    sampling: yorkSlice.sampling,
    supportPct: yorkSlice.supportPct,
    annotation:
      "normalized topology only; not raw magnitude | zero contour overlay",
  };
  const topologyStats = renderYorkSurfacePanel(
    image,
    width,
    height,
    panelRect,
    topologySlice,
  );
  const rawYorkStats = computeYorkFrameDiagnostics(brick);
  const base = await sharp(image, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
  const overlaySvg = buildYorkTopologyNormalizedOverlaySvg(
    width,
    height,
    payload,
    ctx,
    brick,
    panelRect,
    topologyStats,
    rawYorkStats,
  );
  return sharp(base)
    .composite([{ input: Buffer.from(overlaySvg), blend: "over" }])
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
};

// "Natario's zero-expansion warp framing means York may be small while the
// geometry remains nontrivial; this view localizes York on the NHM2 shell/support
// geometry instead of treating York alone as the entire warp picture."
// NHM2-specific extension: this is not a historical paper plotting convention.
// It is justified by Natario-type low-expansion solutions, where geometry-
// localized interpretation (hull/support) is required even when York is small.
const renderTensorFrameYorkShellMap3p1 = async (
  payload: HullMisRenderRequestV1,
  _deterministicSeed: number,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
): Promise<Buffer> => {
  const thetaMid = extractChannelSliceXZMidplane(brick, "theta");
  if (!(thetaMid instanceof Float32Array)) {
    throw new Error("scientific_york_theta_missing");
  }
  const hullMid = extractChannelSliceXZMidplane(brick, "hull_sdf");
  const supportMid = extractChannelSliceXZMidplane(brick, "tile_support_mask");
  if (!(hullMid instanceof Float32Array) || !(supportMid instanceof Float32Array)) {
    throw new Error("scientific_york_shell_support_missing");
  }
  const regionMidRaw = extractChannelSliceXZMidplane(brick, "region_class");
  const regionMid = regionMidRaw instanceof Float32Array ? regionMidRaw : null;
  const shellLocalized = computeYorkShellLocalizedSliceStats({
    thetaSlice: thetaMid,
    supportSlice: supportMid,
    regionSlice: regionMid,
  });
  const width = payload.width;
  const height = payload.height;
  const image = Buffer.alloc(width * height * 4, 0);
  fillRect(image, width, height, 0, 0, width, height, [6, 10, 18]);

  const outerPadX = Math.max(12, Math.floor(width * 0.02));
  const topPad = 44;
  const bottomPad = 30;
  const panelRect: ScientificRect = {
    x: outerPadX,
    y: topPad,
    width: Math.max(120, width - outerPadX * 2),
    height: Math.max(96, height - topPad - bottomPad),
  };
  const yorkShellSlice: ScientificSlice = {
    key: "theta_shell_localized",
    label: "York theta localized to hull/support shell",
    unit: "1/m",
    mode: "diverging",
    width: brick.dims[0],
    height: brick.dims[2],
    data: shellLocalized.shellThetaDisplaySlice,
    min: shellLocalized.thetaShellMinDisplay,
    max: shellLocalized.thetaShellMaxDisplay,
    sampling: "x-z midplane",
    supportPct: shellLocalized.shellSupportPct,
    annotation:
      "shell-localized theta from tile_support_mask shell band | hull_sdf contour overlay",
  };
  const shellPanelStats = renderYorkSurfacePanel(
    image,
    width,
    height,
    panelRect,
    yorkShellSlice,
  );
  const yorkDiag = computeYorkFrameDiagnostics(brick);
  const base = await sharp(image, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
  const overlaySvg = buildYorkShellMapOverlaySvg(
    width,
    height,
    payload,
    ctx,
    brick,
    panelRect,
    shellPanelStats,
    shellLocalized.shellSupportPct,
    yorkDiag,
  );
  return sharp(base)
    .composite([{ input: Buffer.from(overlaySvg), blend: "over" }])
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
};

const renderTensorFrameShiftShell3p1 = async (
  payload: HullMisRenderRequestV1,
  _deterministicSeed: number,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
): Promise<Buffer> => {
  const betaMid = extractChannelSliceXZMidplane(brick, "beta_x");
  if (!(betaMid instanceof Float32Array)) {
    throw new Error("scientific_shift_shell_beta_missing");
  }
  const hullMid = extractChannelSliceXZMidplane(brick, "hull_sdf");
  const supportMid = extractChannelSliceXZMidplane(brick, "tile_support_mask");
  if (!(hullMid instanceof Float32Array) || !(supportMid instanceof Float32Array)) {
    throw new Error("scientific_shift_shell_support_missing");
  }
  const width = payload.width;
  const height = payload.height;
  const image = Buffer.alloc(width * height * 4, 0);
  fillRect(image, width, height, 0, 0, width, height, [6, 10, 18]);

  const outerPadX = Math.max(12, Math.floor(width * 0.02));
  const topPad = 44;
  const bottomPad = 30;
  const panel: ScientificPanelPlacement = {
    x: outerPadX,
    y: topPad,
    width: Math.max(120, width - outerPadX * 2),
    height: Math.max(96, height - topPad - bottomPad),
    slice: (() => {
      const [min, max] = computeSliceRange(betaMid, "diverging");
      return {
        key: "beta_x",
        label: "Shift Shell beta_x (Natario shift)",
        unit: "unitless",
        mode: "diverging" as const,
        width: brick.dims[0],
        height: brick.dims[2],
        data: betaMid,
        min,
        max,
        sampling: "x-z midplane" as const,
        supportPct: computeSliceSupportPct(betaMid),
        annotation:
          "signed beta_x shell map | hull_sdf zero contour + tile support contour overlay",
      };
    })(),
  };
  const samplingMode: ScientificRenderSamplingMode =
    payload.scienceLane?.samplingMode === "nearest" ? "nearest" : "trilinear";
  renderSlicePanel(image, width, height, panel, samplingMode);

  const contourStepX = Math.max(1, Math.floor(brick.dims[0] / 90));
  const contourStepZ = Math.max(1, Math.floor(brick.dims[2] / 90));
  const hullSegments = extractThresholdContourSegments(
    hullMid,
    brick.dims[0],
    brick.dims[2],
    0,
    contourStepX,
    contourStepZ,
  );
  const supportSegments = extractThresholdContourSegments(
    supportMid,
    brick.dims[0],
    brick.dims[2],
    0.5,
    contourStepX,
    contourStepZ,
  );
  drawContourSegmentsOnSlicePanel(image, width, height, panel, hullSegments, [240, 240, 240]);
  drawContourSegmentsOnSlicePanel(image, width, height, panel, supportSegments, [104, 228, 170]);

  const stats = computeShiftShellStats(brick);
  const base = await sharp(image, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
  const overlaySvg = buildShiftShellOverlaySvg(
    width,
    height,
    payload,
    ctx,
    brick,
    panel,
    stats,
  );
  return sharp(base)
    .composite([{ input: Buffer.from(overlaySvg), blend: "over" }])
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
};

const buildMissingScientificSlice = (
  brick: GrBrickDecoded,
  key: string,
  label: string,
  unit: string,
  mode: ScientificSliceMode,
): ScientificSlice => {
  const nx = Math.max(1, brick.dims[0]);
  const nz = Math.max(1, brick.dims[2]);
  return {
    key,
    label,
    unit,
    mode,
    width: nx,
    height: nz,
    data: new Float32Array(nx * nz),
    min: mode === "diverging" ? -1 : 0,
    max: 1,
    sampling: "x-z midplane",
    supportPct: 0,
    annotation: "channel missing",
  };
};

const buildScientificSliceFromChannel = (
  brick: GrBrickDecoded,
  key: string,
  label: string,
  unit: string,
  mode: ScientificSliceMode,
  samplingPolicy: "adaptive" | "midplane" | "x-rho" = "adaptive",
): ScientificSlice => {
  const selected =
    samplingPolicy === "midplane"
      ? selectFixedSliceXZMidplane(brick, key)
      : samplingPolicy === "x-rho"
        ? selectFixedSliceXRho(brick, key)
        : selectAdaptiveSliceXZ(brick, key);
  if (!selected) {
    return buildMissingScientificSlice(
      brick,
      `${key}_missing`,
      `${label} (missing)`,
      unit,
      mode,
    );
  }
  const [min, max] = computeSliceRange(selected.data, mode);
  const sliceHeight =
    selected.sampling === "x-rho cylindrical remap"
      ? Math.max(1, Math.floor(selected.data.length / Math.max(1, brick.dims[0])))
      : brick.dims[2];
  return {
    key,
    label,
    unit,
    mode,
    width: brick.dims[0],
    height: sliceHeight,
    data: selected.data,
    min,
    max,
    sampling: selected.sampling,
    supportPct: selected.supportPct,
    annotation: null,
  };
};

const buildAtlasHullSlice = (
  brick: GrBrickDecoded,
  ctx: TensorRenderContext,
): ScientificSlice => {
  const projection = ctx.supportProjection;
  if (!projection) {
    return buildMissingScientificSlice(
      brick,
      "hull_support_missing",
      "Hull Support (missing)",
      "mask",
      "sequential",
    );
  }
  if (projection.signedHullSdf instanceof Float32Array) {
    const [min, max] = computeSliceRange(projection.signedHullSdf, "diverging");
    return {
      key: "hull_sdf_projection",
      label: "Hull SDF (x-z projection)",
      unit: "normalized signed distance",
      mode: "diverging",
      width: projection.width,
      height: projection.height,
      data: projection.signedHullSdf,
      min,
      max,
      sampling: "x-z max-|value| projection",
      supportPct: projection.coveragePct,
      annotation: `mask=${projection.kind} | support=${fmtScientific(projection.coveragePct, 1)}%`,
    };
  }
  const [min, max] = computeSliceRange(projection.data, "sequential");
  return {
    key: "hull_support_mask",
    label: "Hull Support Mask (x-z projection)",
    unit: "mask",
    mode: "sequential",
    width: projection.width,
    height: projection.height,
    data: projection.data,
    min,
    max,
    sampling: "x-z max-|value| projection",
    supportPct: projection.coveragePct,
    annotation: `mask=${projection.kind} | support=${fmtScientific(projection.coveragePct, 1)}%`,
  };
};

const buildAtlasAdmSlice = (brick: GrBrickDecoded): ScientificSlice => {
  const alphaSlice = buildScientificSliceFromChannel(
    brick,
    "alpha",
    "ADM Lapse alpha",
    "unitless",
    "sequential",
  );
  const beta = selectAdaptiveBetaMagnitudeSliceXZ(brick);
  if (beta) {
    alphaSlice.annotation = `|beta| support=${fmtScientific(beta.supportPct, 1)}%`;
  }
  return alphaSlice;
};

const buildAtlasDerivedSlice = (brick: GrBrickDecoded): ScientificSlice => {
  const rhoIntegral = extractRhoIntegralSliceXZ(brick);
  if (rhoIntegral) {
    const [min, max] = computeSliceRange(rhoIntegral.data, "diverging");
    const signedStats = computeSignedSliceStats(rhoIntegral.data);
    return {
      key: "rho_integral",
      label: "Derived rho line integral I_rho",
      unit: "J/m^2",
      mode: "diverging",
      width: brick.dims[0],
      height: brick.dims[2],
      data: rhoIntegral.data,
      min,
      max,
      sampling: "x-z y-integral projection",
      supportPct: rhoIntegral.supportPct,
      annotation:
        `neg=${fmtScientific(signedStats.negativePct, 1)}%` +
        ` pos=${fmtScientific(signedStats.positivePct, 1)}%`,
    };
  }
  return buildScientificSliceFromChannel(
    brick,
    "theta",
    "Derived expansion theta",
    "1/m",
    "diverging",
  );
};

const buildAtlasCausalSlice = (
  brick: GrBrickDecoded,
  ctx: TensorRenderContext,
): ScientificSlice => {
  const alpha = brick.channels.alpha?.data;
  const betaZ = brick.channels.beta_z?.data;
  const [nx, ny, nz] = brick.dims;
  const total = nx * ny * nz;
  if (
    !(alpha instanceof Float32Array) ||
    !(betaZ instanceof Float32Array) ||
    alpha.length < total ||
    betaZ.length < total
  ) {
    return buildMissingScientificSlice(
      brick,
      "causal_missing",
      "Causal Light-Cone Tilt (missing)",
      "beta_z/alpha",
      "diverging",
    );
  }
  const yMid = clampi(Math.floor(ny * 0.5), 0, ny - 1);
  const out = new Float32Array(nx * nz);
  for (let z = 0; z < nz; z += 1) {
    for (let x = 0; x < nx; x += 1) {
      const idx = idx3(x, yMid, z, brick.dims);
      const alphaLocal = Math.max(1e-6, Math.abs(alpha[idx] ?? 1));
      const betaLocal = Number.isFinite(betaZ[idx]) ? Number(betaZ[idx]) : 0;
      const skew = clamp(betaLocal / alphaLocal, -2, 2);
      const support = ctx.supportProjection
        ? sampleGridNearest(ctx.supportProjection.data, ctx.supportProjection.width, ctx.supportProjection.height, x, z)
        : 1;
      out[z * nx + x] = support > 0.5 ? skew : 0;
    }
  }
  const [min, max] = computeSliceRange(out, "diverging");
  return {
    key: "causal_tilt_beta_z_over_alpha",
    label: "Causal cone tilt beta_z / alpha",
    unit: "dimensionless",
    mode: "diverging",
    width: nx,
    height: nz,
    data: out,
    min,
    max,
    sampling: "x-z midplane",
    supportPct: ctx.supportProjection?.coveragePct ?? computeSliceSupportPct(out),
    annotation: "worldtube-gated local light-cone skew proxy",
  };
};

const buildFullAtlasOverlaySvg = (args: {
  width: number;
  height: number;
  payload: HullMisRenderRequestV1;
  ctx: TensorRenderContext;
  brick: GrBrickDecoded;
  panes: Record<HullScientificAtlasPaneId, ScientificPanelPlacement>;
  opticalRect: ScientificRect;
  opticalField: VolumeFieldSelection | null;
  opticalStats: ScientificTransportRenderStats;
}): string => {
  const { width, height, payload, ctx, brick, panes, opticalRect, opticalField, opticalStats } = args;
  const timestamp = new Date().toISOString();
  const sourceParams = parseMetricRefSourceParams(payload);
  const sourceSummary = summarizeMetricRefSourceParams(sourceParams);
  const subtitleParts = [
    "NHM2 synchronized full-atlas",
    `chart=${ctx.chart ?? payload.solve?.chart ?? "unknown"}`,
    `source=${ctx.metricSource ?? "unknown"}`,
    `dims=${brick.dims.join("x")}`,
    formatSupportSummary(ctx),
  ];
  if (sourceSummary) subtitleParts.push(`solve(${sourceSummary})`);
  const subtitle = subtitleParts.join(" | ");
  const diag = `null residual=${fmtScientific(
    ctx.diagnostics.maxNullResidual,
    4,
  )} | convergence=${fmtScientific(
    ctx.diagnostics.stepConvergence,
    4,
  )} | bundle spread=${fmtScientific(
    ctx.diagnostics.bundleSpread,
    4,
  )} | consistency=${ctx.diagnostics.consistency}`;

  const paneText = SCIENTIFIC_ATLAS_REQUIRED_PANES.map((paneId) => {
    const pane = panes[paneId];
    const info = `${pane.slice.label} [${pane.slice.unit}]`;
    const range = `range ${fmtScientific(pane.slice.min, 3)} .. ${fmtScientific(
      pane.slice.max,
      3,
    )} | support ${fmtScientific(pane.slice.supportPct, 1)}%`;
    const annotation = pane.slice.annotation ? String(pane.slice.annotation) : null;
    return [
      `<text x="${pane.x + 8}" y="${pane.y + 16}" fill="#cfe5ff" font-size="11" font-weight="600">${escapeXml(info)}</text>`,
      `<text x="${pane.x + 8}" y="${pane.y + 30}" fill="#9fb3ca" font-size="10">${escapeXml(range)}</text>`,
      annotation
        ? `<text x="${pane.x + 8}" y="${pane.y + pane.height - 10}" fill="#8ec6ff" font-size="10">${escapeXml(annotation)}</text>`
        : "",
    ].join("");
  }).join("");

  const opticalTitle = opticalField
    ? `${opticalField.label} [${opticalField.key}]`
    : "optical transport unavailable";
  const opticalDiag = `method=${opticalStats.method} | rays=${opticalStats.rays} | samples=${opticalStats.samples} | null(max=${fmtScientific(
    opticalStats.maxNullResidual,
    3,
  )}, mean=${fmtScientific(
    opticalStats.meanNullResidual,
    3,
  )}) | escaped=${fmtScientific(opticalStats.escapedPct, 1)}%`;

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="40" fill="#050a14"/>
  <text x="16" y="22" fill="#e8f3ff" font-size="16" font-weight="700">NHM2 Canonical Full Atlas (single certified snapshot)</text>
  <text x="16" y="36" fill="#9fb3ca" font-size="10">${escapeXml(subtitle)}</text>
  ${paneText}
  <text x="${opticalRect.x + 8}" y="${opticalRect.y + 16}" fill="#cfe5ff" font-size="11" font-weight="600">Optical null-geodesic transport pane</text>
  <text x="${opticalRect.x + 8}" y="${opticalRect.y + 30}" fill="#9fb3ca" font-size="10">${escapeXml(opticalTitle)}</text>
  <text x="${opticalRect.x + 8}" y="${opticalRect.y + 44}" fill="#7f93ac" font-size="10">${escapeXml(opticalDiag)}</text>
  <rect x="0" y="${height - 24}" width="${width}" height="24" fill="#050a14"/>
  <text x="16" y="${height - 8}" fill="#9fb3ca" font-size="10">${escapeXml(diag)} | generated=${escapeXml(timestamp)}</text>
</svg>`;
};

const renderTensorFrameFullAtlas = async (
  payload: HullMisRenderRequestV1,
  _deterministicSeed: number,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
): Promise<Buffer> => {
  const width = payload.width;
  const height = payload.height;
  const image = Buffer.alloc(width * height * 4, 0);
  fillRect(image, width, height, 0, 0, width, height, [6, 10, 18]);

  const samplingMode: ScientificRenderSamplingMode =
    payload.scienceLane?.samplingMode === "nearest" ? "nearest" : "trilinear";
  const outerPad = Math.max(12, Math.floor(width * 0.02));
  const topPad = 48;
  const bottomPad = 30;
  const gap = 10;
  const availableW = Math.max(220, width - outerPad * 2);
  const availableH = Math.max(200, height - topPad - bottomPad);
  const rowH = Math.max(62, Math.floor((availableH - gap * 2) / 3));
  const colW = Math.max(80, Math.floor((availableW - gap) / 2));
  const leftX = outerPad;
  const rightX = outerPad + colW + gap;
  const row1Y = topPad;
  const row2Y = row1Y + rowH + gap;
  const row3Y = row2Y + rowH + gap;

  const paneSlices: Record<HullScientificAtlasPaneId, ScientificSlice> = {
    hull: buildAtlasHullSlice(brick, ctx),
    adm: buildAtlasAdmSlice(brick),
    derived: buildAtlasDerivedSlice(brick),
    causal: buildAtlasCausalSlice(brick, ctx),
    optical: buildMissingScientificSlice(
      brick,
      "optical_placeholder",
      "Optical transport",
      "n/a",
      "diverging",
    ),
  };

  const panePlacements: Record<HullScientificAtlasPaneId, ScientificPanelPlacement> = {
    hull: { x: leftX, y: row1Y, width: colW, height: rowH, slice: paneSlices.hull },
    adm: { x: rightX, y: row1Y, width: colW, height: rowH, slice: paneSlices.adm },
    derived: { x: leftX, y: row2Y, width: colW, height: rowH, slice: paneSlices.derived },
    causal: { x: rightX, y: row2Y, width: colW, height: rowH, slice: paneSlices.causal },
    optical: {
      x: leftX,
      y: row3Y,
      width: availableW,
      height: Math.max(56, height - bottomPad - row3Y),
      slice: paneSlices.optical,
    },
  };

  renderSlicePanel(image, width, height, panePlacements.hull, samplingMode);
  renderSlicePanel(image, width, height, panePlacements.adm, samplingMode);
  renderSlicePanel(image, width, height, panePlacements.derived, samplingMode);
  renderSlicePanel(image, width, height, panePlacements.causal, samplingMode);

  const opticalField =
    selectTransportFieldForFrame(brick, ctx) ?? selectVolumeField(brick, ctx);
  let opticalStats: ScientificTransportRenderStats = {
    method: "unavailable",
    rays: 0,
    samples: 0,
    maxNullResidual: 0,
    meanNullResidual: 0,
    escapedPct: 0,
    displayGain: 1,
    shellAssist: 0,
    lowSignal: false,
  };
  if (opticalField) {
    opticalStats = renderVolumeTransportPanel(
      image,
      width,
      height,
      panePlacements.optical,
      brick,
      opticalField,
      ctx.supportProjection,
    );
  }

  const base = await sharp(image, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
  const overlaySvg = buildFullAtlasOverlaySvg({
    width,
    height,
    payload,
    ctx,
    brick,
    panes: panePlacements,
    opticalRect: panePlacements.optical,
    opticalField,
    opticalStats,
  });
  return sharp(base)
    .composite([{ input: Buffer.from(overlaySvg), blend: "over" }])
    .png({ compressionLevel: 7, adaptiveFiltering: true })
    .toBuffer();
};

const renderTensorFrame = async (
  payload: HullMisRenderRequestV1,
  deterministicSeed: number,
  ctx: TensorRenderContext,
  brick: GrBrickDecoded,
): Promise<Buffer> => {
  const renderView = payload.scienceLane?.renderView ?? "diagnostic-quad";
  if (renderView === "paper-rho") {
    return renderTensorFramePaperRho(payload, deterministicSeed, ctx, brick);
  }
  if (renderView === "york-time-3p1") {
    return renderTensorFrameYorkTime3p1(payload, deterministicSeed, ctx, brick);
  }
  if (renderView === "york-surface-3p1" || renderView === "york-surface-rho-3p1") {
    return renderTensorFrameYorkSurface3p1(payload, deterministicSeed, ctx, brick);
  }
  if (renderView === "york-topology-normalized-3p1") {
    return renderTensorFrameYorkTopologyNormalized3p1(
      payload,
      deterministicSeed,
      ctx,
      brick,
    );
  }
  if (renderView === "york-shell-map-3p1") {
    return renderTensorFrameYorkShellMap3p1(payload, deterministicSeed, ctx, brick);
  }
  if (renderView === "shift-shell-3p1") {
    return renderTensorFrameShiftShell3p1(payload, deterministicSeed, ctx, brick);
  }
  if (renderView === "transport-3p1") {
    return renderTensorFrameTransport3p1(payload, deterministicSeed, ctx, brick);
  }
  if (renderView === "full-atlas") {
    return renderTensorFrameFullAtlas(payload, deterministicSeed, ctx, brick);
  }
  return renderTensorFrameDiagnostic(payload, deterministicSeed, ctx, brick);
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const sha256Hex = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const hashFloat32 = (value: Float32Array): string => {
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return sha256Hex(bytes);
};

const computeConstraintRms = (brick: GrBrickDecoded): number | null => {
  const h = brick.channels.H_constraint?.data;
  const mx = brick.channels.M_constraint_x?.data;
  const my = brick.channels.M_constraint_y?.data;
  const mz = brick.channels.M_constraint_z?.data;
  if (!h || !mx || !my || !mz) return null;
  const n = Math.min(h.length, mx.length, my.length, mz.length);
  if (n <= 0) return null;
  let sumSq = 0;
  let samples = 0;
  for (let i = 0; i < n; i += 1) {
    const hv = h[i] ?? 0;
    const mxv = mx[i] ?? 0;
    const myv = my[i] ?? 0;
    const mzv = mz[i] ?? 0;
    sumSq += hv * hv + mxv * mxv + myv * myv + mzv * mzv;
    samples += 4;
  }
  if (samples <= 0) return null;
  return Math.sqrt(sumSq / samples);
};

const buildChannelHashes = (brick: GrBrickDecoded): Record<string, string> => {
  const channelHashes: Record<string, string> = {};
  const channelNames = Object.keys(brick.channels).sort((a, b) => a.localeCompare(b));
  for (const name of channelNames) {
    const data = brick.channels[name]?.data;
    if (data instanceof Float32Array && data.length > 0) {
      channelHashes[name] = hashFloat32(data);
    }
  }
  return channelHashes;
};

const buildRenderCertificate = (args: {
  payload: HullMisRenderRequestV1;
  ctx: TensorRenderContext;
  brick: GrBrickDecoded;
  png: Buffer;
  yorkObserverConstruction: YorkDiagnosticObserverConstructionInfo | null;
}): HullRenderCertificateV1 => {
  const { payload, ctx, brick, png } = args;
  const renderView = payload.scienceLane?.renderView ?? "diagnostic-quad";
  const yorkTimeView = renderView === "york-time-3p1";
  const yorkSurfaceView =
    renderView === "york-surface-3p1" || renderView === "york-surface-rho-3p1";
  const yorkSurfaceRhoView = renderView === "york-surface-rho-3p1";
  const yorkTopologyNormalizedView =
    renderView === "york-topology-normalized-3p1";
  const yorkShellMapView = renderView === "york-shell-map-3p1";
  const shiftShellView = renderView === "shift-shell-3p1";
  const yorkView =
    yorkTimeView ||
    yorkSurfaceView ||
    yorkTopologyNormalizedView ||
    yorkShellMapView;
  const requestedLaneId =
    typeof payload.scienceLane?.diagnosticLaneId === "string" &&
    payload.scienceLane.diagnosticLaneId.trim().length > 0
      ? payload.scienceLane.diagnosticLaneId.trim()
      : null;
  const laneId = normalizeYorkDiagnosticLaneId(requestedLaneId);
  const laneConvention =
    laneId != null ? resolveYorkLaneConvention(laneId) : null;
  const yorkSamplingPolicy: "midplane" | "x-rho" = yorkSurfaceRhoView
    ? "x-rho"
    : "midplane";
  const yorkSelectedSlice = yorkView
    ? yorkSamplingPolicy === "x-rho"
      ? selectFixedSliceXRho(brick, "theta")
      : selectFixedSliceXZMidplane(brick, "theta")
    : null;
  const yorkSliceArrayHash =
    yorkSelectedSlice?.data instanceof Float32Array
      ? hashFloat32(yorkSelectedSlice.data)
      : null;
  const yorkFrameStats = yorkView
    ? computeYorkFrameDiagnostics(brick, yorkSamplingPolicy)
    : null;
  const yorkShellThetaMid = yorkShellMapView
    ? extractChannelSliceXZMidplane(brick, "theta")
    : null;
  const yorkShellSupportMid = yorkShellMapView
    ? extractChannelSliceXZMidplane(brick, "tile_support_mask")
    : null;
  const yorkShellRegionMidRaw = yorkShellMapView
    ? extractChannelSliceXZMidplane(brick, "region_class")
    : null;
  const yorkShellLocalizedStats =
    yorkShellMapView &&
    yorkShellThetaMid instanceof Float32Array &&
    yorkShellSupportMid instanceof Float32Array
      ? computeYorkShellLocalizedSliceStats({
          thetaSlice: yorkShellThetaMid,
          supportSlice: yorkShellSupportMid,
          regionSlice:
            yorkShellRegionMidRaw instanceof Float32Array ? yorkShellRegionMidRaw : null,
        })
      : null;
  let yorkNormalizedSliceHash: string | null = null;
  if (
    yorkTopologyNormalizedView &&
    yorkSelectedSlice?.data instanceof Float32Array
  ) {
    const sourceSlice = yorkSelectedSlice.data;
    const [thetaDisplayMin, thetaDisplayMax] = computeSliceRange(
      sourceSlice,
      "diverging",
    );
    const thetaAbsMax = Math.max(
      Math.abs(thetaDisplayMin),
      Math.abs(thetaDisplayMax),
      0,
    );
    const normalizedTheta = new Float32Array(sourceSlice.length);
    if (thetaAbsMax > 0) {
      const invThetaAbsMax = 1 / thetaAbsMax;
      for (let i = 0; i < sourceSlice.length; i += 1) {
        normalizedTheta[i] = (sourceSlice[i] ?? 0) * invThetaAbsMax;
      }
    }
    yorkNormalizedSliceHash = hashFloat32(normalizedTheta);
  }
  const yorkSupportMaskSliceHash =
    yorkShellMapView && yorkShellSupportMid instanceof Float32Array
      ? hashFloat32(yorkShellSupportMid)
      : null;
  const yorkShellMaskedSliceHash =
    yorkShellMapView &&
    yorkShellLocalizedStats?.shellThetaMaskedSlice instanceof Float32Array
      ? hashFloat32(yorkShellLocalizedStats.shellThetaMaskedSlice)
      : null;
  const yorkSlicePlane = yorkSurfaceRhoView ? "x-rho" : "x-z-midplane";
  const yorkCoordinateMode = yorkSurfaceRhoView ? "x-rho" : "x-z-midplane";
  const shiftShellStats = shiftShellView ? computeShiftShellStats(brick) : null;
  const metricRefHashRaw = payload.metricVolumeRef?.hash?.trim();
  const metricRefHash =
    metricRefHashRaw && metricRefHashRaw.length > 0
      ? metricRefHashRaw
      : payload.metricVolumeRef?.url
        ? sha256Hex(payload.metricVolumeRef.url)
        : null;
  const channelHashes = buildChannelHashes(brick);
  const supportMaskHash =
    ctx.supportProjection?.data instanceof Float32Array
      ? hashFloat32(ctx.supportProjection.data)
      : null;
  const frameHash = sha256Hex(png);
  const snapshotTimestampMs = toFiniteNumber(payload.metricVolumeRef?.updatedAt, Number.NaN);
  const certificateTimestampMs = Number.isFinite(snapshotTimestampMs)
    ? snapshotTimestampMs
    : Date.now();
  const observerConstruction = yorkView ? args.yorkObserverConstruction : null;
  const observerInputsRequired =
    yorkView && laneConvention
      ? observerConstruction?.observer_inputs_required ??
        laneConvention.observer_inputs_required ??
        laneConvention.observer_construction_inputs
      : null;
  const observerInputsPresentByHash =
    observerInputsRequired == null
      ? null
      : observerInputsRequired.every((channelId) => {
          const hash = channelHashes[channelId];
          return typeof hash === "string" && hash.trim().length > 0;
        });
  const laneTensorInputsHash =
    yorkView && observerInputsRequired && observerInputsPresentByHash
      ? sha256Hex(
          observerInputsRequired
            .map((channelId) => `${channelId}:${channelHashes[channelId]}`)
            .join("|"),
        )
      : null;
  const certificateBase: Omit<HullRenderCertificateV1, "certificate_hash"> = {
    certificate_schema_version: HULL_RENDER_CERTIFICATE_SCHEMA_VERSION,
    metric_ref_hash: metricRefHash,
    channel_hashes: channelHashes,
    support_mask_hash: supportMaskHash,
    chart: brick.chart ?? payload.solve?.chart ?? null,
    observer: laneConvention?.observer ?? "eulerian_n",
    theta_definition: laneConvention?.theta_definition ?? "theta=-trK",
    kij_sign_convention:
      laneConvention?.kij_sign_convention ?? "K_ij=-1/2*L_n(gamma_ij)",
    unit_system: "SI",
    camera: {
      pose: "ui_default_orbit",
      proj: "perspective_fov60",
    },
    render: {
      view: renderView,
      integrator: "christoffel-rk4",
      steps: 0,
      field_key: yorkView ? "theta" : shiftShellView ? "beta_x" : null,
      lane_id: laneId,
      slice_plane: yorkView ? yorkSlicePlane : shiftShellView ? "x-z-midplane" : null,
      coordinate_mode: yorkView
        ? yorkCoordinateMode
        : shiftShellView
          ? "x-z-midplane"
          : null,
      normalization:
        yorkTopologyNormalizedView
          ? "topology-only-unit-max"
          : yorkView || shiftShellView
            ? "symmetric-about-zero"
            : null,
      magnitude_mode: yorkTopologyNormalizedView
        ? "normalized-topology-only"
        : null,
      surface_height: yorkTopologyNormalizedView
        ? "theta_norm"
        : yorkSurfaceView || yorkShellMapView
          ? "theta"
          : null,
      support_overlay:
        shiftShellView || yorkShellMapView ? "hull_sdf+tile_support_mask" : null,
      vector_context: shiftShellView ? "|beta|" : null,
    },
    diagnostics: {
      null_residual_max: ctx.diagnostics.maxNullResidual,
      step_convergence: ctx.diagnostics.stepConvergence,
      bundle_spread: ctx.diagnostics.bundleSpread,
      constraint_rms: computeConstraintRms(brick),
      support_coverage_pct: ctx.supportCoveragePct,
      lane_id: laneId,
      observer_definition_id: yorkView
        ? observerConstruction?.observer_definition_id ??
          laneConvention?.observer_definition_id ??
          null
        : null,
      observer_inputs_required: yorkView
        ? observerInputsRequired ?? null
        : null,
      observer_construction_inputs: yorkView
        ? observerConstruction?.observer_construction_inputs ??
          laneConvention?.observer_construction_inputs ??
          null
        : null,
      observer_construction_formula: yorkView
        ? observerConstruction?.observer_construction_formula ??
          laneConvention?.observer_construction_formula ??
          null
        : null,
      observer_normalized: yorkView
        ? observerConstruction?.observer_normalized ??
          laneConvention?.observer_normalized ??
          null
        : null,
      observer_approximation: yorkView
        ? observerConstruction?.observer_approximation ??
          laneConvention?.observer_approximation ??
          null
        : null,
      observer_inputs_present: yorkView
        ? observerConstruction?.observer_inputs_present ??
          observerInputsPresentByHash
        : null,
      lane_b_semantic_mode: yorkView
        ? observerConstruction?.lane_b_semantic_mode ??
          laneConvention?.lane_semantic_mode ??
          null
        : null,
      lane_b_tensor_inputs_hash: yorkView ? laneTensorInputsHash : null,
      lane_b_geometry_ready: yorkView
        ? observerConstruction?.lane_b_geometry_ready ??
          observerInputsPresentByHash
        : null,
      lane_b_semantics_closed: yorkView
        ? observerConstruction?.semantics_closed ??
          laneConvention?.semantics_closed ??
          null
        : null,
      requires_gamma_metric: yorkView
        ? observerConstruction?.requires_gamma_metric ??
          laneConvention?.requires_gamma_metric ??
          null
        : null,
      semantics_closed: yorkView
        ? observerConstruction?.semantics_closed ??
          laneConvention?.semantics_closed ??
          null
        : null,
      cross_lane_claim_ready: yorkView
        ? observerConstruction?.cross_lane_claim_ready ??
          laneConvention?.cross_lane_claim_ready ??
          null
        : null,
      cross_lane_claim_block_reason: yorkView
        ? observerConstruction?.cross_lane_claim_block_reason ??
          laneConvention?.cross_lane_claim_block_reason ??
          null
        : null,
      metric_ref_hash: yorkView ? metricRefHash : null,
      timestamp_ms: yorkView ? certificateTimestampMs : null,
      theta_definition: yorkView ? laneConvention?.theta_definition ?? null : null,
      theta_channel_hash: yorkView ? channelHashes.theta ?? null : null,
      slice_array_hash: yorkView ? yorkSliceArrayHash : null,
      normalized_slice_hash: yorkTopologyNormalizedView
        ? yorkNormalizedSliceHash
        : null,
      support_mask_slice_hash: yorkShellMapView ? yorkSupportMaskSliceHash : null,
      shell_masked_slice_hash: yorkShellMapView ? yorkShellMaskedSliceHash : null,
      theta_min_raw: yorkFrameStats?.thetaMinRaw ?? null,
      theta_max_raw: yorkFrameStats?.thetaMaxRaw ?? null,
      theta_abs_max_raw: yorkFrameStats?.thetaAbsMaxRaw ?? null,
      theta_min_display: yorkFrameStats?.thetaMinDisplay ?? null,
      theta_max_display: yorkFrameStats?.thetaMaxDisplay ?? null,
      theta_abs_max_display: yorkFrameStats?.thetaAbsMaxDisplay ?? null,
      display_range_method: yorkFrameStats?.displayRangeMethod ?? null,
      // Legacy aliases preserved for compatibility; these map to display range.
      theta_min: yorkFrameStats?.thetaMinDisplay ?? null,
      theta_max: yorkFrameStats?.thetaMaxDisplay ?? null,
      theta_abs_max: yorkFrameStats?.thetaAbsMaxDisplay ?? null,
      near_zero_theta: yorkFrameStats?.nearZeroTheta ?? null,
      zero_contour_segments: yorkFrameStats?.zeroContourSegments ?? null,
      display_gain: yorkFrameStats?.displayGain ?? null,
      height_scale: yorkFrameStats?.heightScale ?? null,
      sampling_choice: yorkFrameStats?.samplingChoice ?? null,
      coordinate_mode: yorkFrameStats?.coordinateMode ?? null,
      theta_shell_min_raw: yorkShellLocalizedStats?.thetaShellMinRaw ?? null,
      theta_shell_max_raw: yorkShellLocalizedStats?.thetaShellMaxRaw ?? null,
      theta_shell_abs_max_raw: yorkShellLocalizedStats?.thetaShellAbsMaxRaw ?? null,
      theta_shell_min_display:
        yorkShellLocalizedStats?.thetaShellMinDisplay ?? null,
      theta_shell_max_display:
        yorkShellLocalizedStats?.thetaShellMaxDisplay ?? null,
      theta_shell_abs_max_display:
        yorkShellLocalizedStats?.thetaShellAbsMaxDisplay ?? null,
      shell_support_count: yorkShellLocalizedStats?.shellSupportCount ?? null,
      shell_active_count: yorkShellLocalizedStats?.shellActiveCount ?? null,
      shell_mask_slice_hash:
        yorkShellLocalizedStats?.shellMaskSlice != null
          ? hashFloat32(yorkShellLocalizedStats.shellMaskSlice)
          : null,
      supported_theta_fraction: yorkFrameStats?.supportedThetaFraction ?? null,
      shell_theta_overlap_pct: yorkFrameStats?.shellThetaOverlapPct ?? null,
      peak_theta_cell: yorkFrameStats?.peakThetaCell ?? null,
      peak_theta_in_supported_region:
        yorkFrameStats?.peakThetaInSupportedRegion ?? null,
      beta_min: shiftShellStats?.betaMin ?? null,
      beta_max: shiftShellStats?.betaMax ?? null,
      beta_abs_max: shiftShellStats?.betaAbsMax ?? null,
      slice_support_pct: shiftShellStats?.sliceSupportPct ?? null,
      support_overlap_pct: shiftShellStats?.supportOverlapPct ?? null,
      shell_contour_segments: shiftShellStats?.shellContourSegments ?? null,
      peak_beta_cell: shiftShellStats?.peakBetaCell ?? null,
      peak_beta_in_supported_region:
        shiftShellStats?.peakBetaInSupportedRegion ?? null,
    },
    frame_hash: frameHash,
    timestamp_ms: certificateTimestampMs,
  };
  const certificateHash = sha256Hex(stableStringify(certificateBase));
  return {
    ...certificateBase,
    certificate_hash: certificateHash,
  };
};

const buildScientificAtlasSidecar = (args: {
  certificate: HullRenderCertificateV1;
  channelHashes: Record<string, string>;
  geodesicMode: string | null;
}): HullScientificAtlasSidecarV1 => {
  const { certificate, channelHashes, geodesicMode } = args;
  const pane_status = {} as Record<HullScientificAtlasPaneId, "ok" | "missing" | "error">;
  const pane_meta = {} as HullScientificAtlasSidecarV1["pane_meta"];
  for (const paneId of SCIENTIFIC_ATLAS_REQUIRED_PANES) {
    const channels = SCIENTIFIC_ATLAS_PANE_CHANNEL_SETS[paneId] ?? [];
    const paneChannelHashes: Record<string, string> = {};
    let missing = 0;
    for (const channelId of channels) {
      const hash = channelHashes[channelId];
      if (typeof hash === "string" && hash.length > 0) {
        paneChannelHashes[channelId] = hash;
      } else {
        missing += 1;
      }
    }
    const status: "ok" | "missing" | "error" = missing > 0 ? "missing" : "ok";
    pane_status[paneId] = status;
    pane_meta[paneId] = {
      status,
      metric_ref_hash: certificate.metric_ref_hash,
      chart: certificate.chart,
      observer: certificate.observer,
      theta_definition: certificate.theta_definition,
      kij_sign_convention: certificate.kij_sign_convention,
      unit_system: certificate.unit_system,
      timestamp_ms: certificate.timestamp_ms,
      channels,
      channel_hashes: paneChannelHashes,
      integrator:
        paneId === "optical"
          ? certificate.render.integrator
          : paneId === "causal"
            ? "metric-3+1-causal-proxy"
            : null,
      geodesic_mode:
        paneId === "optical" || paneId === "causal"
          ? geodesicMode ?? "full-3+1-christoffel"
          : null,
    };
  }
  return {
    atlas_view: "full-atlas",
    certificate_schema_version: certificate.certificate_schema_version,
    certificate_hash: certificate.certificate_hash,
    metric_ref_hash: certificate.metric_ref_hash,
    pane_ids: [...SCIENTIFIC_ATLAS_REQUIRED_PANES],
    pane_status,
    pane_channel_sets: { ...SCIENTIFIC_ATLAS_PANE_CHANNEL_SETS },
    pane_meta,
    chart: certificate.chart,
    observer: certificate.observer,
    theta_definition: certificate.theta_definition,
    kij_sign_convention: certificate.kij_sign_convention,
    unit_system: certificate.unit_system,
    timestamp_ms: certificate.timestamp_ms,
  };
};

const buildScaffoldAttachments = (
  payload: HullMisRenderRequestV1,
): HullMisRenderAttachmentV1[] => {
  const width = Math.max(1, payload.width | 0);
  const height = Math.max(1, payload.height | 0);
  const total = width * height;
  const depth = new Float32Array(total);
  const mask = new Uint8Array(total);
  const radius = Math.max(1e-3, toFiniteNumber(payload.solve?.R, 1));
  const beta = toFiniteNumber(payload.solve?.beta, 0);
  const nullResidual = Math.abs(
    toFiniteNumber(payload.geodesicDiagnostics?.maxNullResidual, 0),
  );
  const bundleSpread = Math.abs(
    toFiniteNumber(payload.geodesicDiagnostics?.bundleSpread, 0),
  );
  const depthBase = 8;
  const perturbAmp = clamp(0.004 + 2.5 * nullResidual + 0.01 * bundleSpread, 0, 0.03);
  for (let y = 0; y < height; y += 1) {
    const ny = height > 1 ? (y / (height - 1)) * 2 - 1 : 0;
    for (let x = 0; x < width; x += 1) {
      const nx = width > 1 ? (x / (width - 1)) * 2 - 1 : 0;
      const idx = y * width + x;
      const q = 1 - nx * nx - ny * ny;
      if (q < 0) {
        depth[idx] = depthBase;
        mask[idx] = 0;
        continue;
      }
      const perturb = perturbAmp * Math.sin(6.2 * nx + 5.1 * ny + 0.85 * beta);
      const depthValue = depthBase + radius * Math.sqrt(Math.max(0, q)) + perturb;
      depth[idx] = Number.isFinite(depthValue) ? depthValue : depthBase;
      mask[idx] = 255;
    }
  }
  const depthBytes = Buffer.from(depth.buffer.slice(0));
  const maskBytes = Buffer.from(mask.buffer.slice(0));
  return [
    {
      kind: "depth-linear-m-f32le",
      width,
      height,
      encoding: "base64",
      dataBase64: depthBytes.toString("base64"),
    },
    {
      kind: "shell-mask-u8",
      width,
      height,
      encoding: "base64",
      dataBase64: maskBytes.toString("base64"),
    },
  ];
};

const renderOptixScaffoldFrame = async (
  payload: HullMisRenderRequestV1,
  deterministicSeed: number,
): Promise<Buffer> => {
  const width = payload.width;
  const height = payload.height;
  const image = Buffer.alloc(width * height * 4, 0);
  const beta = toFiniteNumber(payload.solve?.beta, 0);
  const alpha = Math.max(1e-6, toFiniteNumber(payload.solve?.alpha, 1));
  const sigma = Math.max(1e-3, toFiniteNumber(payload.solve?.sigma, 6));
  const radius = Math.max(1e-3, toFiniteNumber(payload.solve?.R, 1));
  const nullResidual = Math.abs(
    toFiniteNumber(payload.geodesicDiagnostics?.maxNullResidual, 0),
  );
  const spread = Math.abs(
    toFiniteNumber(payload.geodesicDiagnostics?.bundleSpread, 0),
  );
  const consistency = payload.geodesicDiagnostics?.consistency ?? "unknown";
  const seededPhase = (deterministicSeed % 4096) * (Math.PI / 2048);
  const consistencyFactor =
    consistency === "ok" ? 1 : consistency === "warn" ? 0.82 : 0.62;
  const nullPenalty = clamp(1 / (1 + 28 * nullResidual), 0.18, 1);
  const spreadBoost = clamp(0.72 + spread * 0.64, 0.52, 1.8);
  for (let y = 0; y < height; y += 1) {
    const v = height > 1 ? y / (height - 1) : 0;
    const ny = v * 2 - 1;
    for (let x = 0; x < width; x += 1) {
      const u = width > 1 ? x / (width - 1) : 0;
      const nx = u * 2 - 1;
      const r = Math.sqrt(nx * nx + ny * ny);
      const theta = Math.atan2(ny, nx);
      const shell = Math.exp(
        -Math.pow(r - (0.33 + 0.06 * Math.tanh(beta)), 2) * (7.5 + sigma * 1.4),
      );
      const tube = Math.exp(
        -Math.pow(nx * nx / Math.max(radius * radius, 0.2) + ny * ny / 0.55, 1.12),
      );
      const fringe =
        0.5 +
        0.5 * Math.sin(11 * theta + 8.5 * r + seededPhase + 0.7 * beta - 0.2 * alpha);
      const band =
        0.5 +
        0.5 * Math.cos(18 * nx - 7 * ny + seededPhase * 0.8 + spreadBoost);
      const brightness =
        clamp((0.16 + 0.72 * shell + 0.4 * tube) * consistencyFactor, 0, 1) *
        nullPenalty;
      const red = toByte(255 * clamp(brightness * (0.46 + 0.58 * fringe), 0, 1));
      const green = toByte(255 * clamp(brightness * (0.28 + 0.64 * band), 0, 1));
      const blue = toByte(255 * clamp(brightness * (0.52 + 0.42 * (1 - fringe)), 0, 1));
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
};

const getRuntimeStatus = (): RuntimeStatus => {
  const optixSdkPath = readEnv("OPTIX_SDK_PATH") || readEnv("OPTIX_RENDER_SDK_PATH");
  const cudaPath = readEnv("CUDA_PATH") || readEnv("CUDA_HOME");
  const allowSynthetic = readEnvFlag("OPTIX_RENDER_ALLOW_SYNTHETIC", false);
  const metricRefBaseUrl =
    readEnv("OPTIX_RENDER_METRIC_REF_BASE_URL") || readEnv("OPTIX_RENDER_APP_BASE_URL");
  return {
    host: readEnv("OPTIX_RENDER_SERVICE_HOST") || DEFAULT_SERVICE_HOST,
    port: toInt(readEnv("OPTIX_RENDER_SERVICE_PORT"), DEFAULT_SERVICE_PORT, 1, 65535),
    serviceMode: "optix-tensor-pass1",
    allowSynthetic,
    readyForUnity: false,
    readyForOptix: true,
    readyForScientificLane: true,
    optixConfigured: !!optixSdkPath,
    cudaConfigured: !!cudaPath,
    optixSdkPath,
    cudaPath,
    metricRefBaseUrl,
    serviceVersion: HULL_OPTIX_SERVICE_VERSION,
    buildHash: HULL_OPTIX_BUILD_HASH,
    commitSha: HULL_OPTIX_COMMIT_SHA,
    processStartedAtMs: HULL_OPTIX_SERVICE_PROCESS_STARTED_AT_MS,
    runtimeInstanceId: HULL_OPTIX_SERVICE_RUNTIME_INSTANCE_ID,
  };
};

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/api/helix/hull-render/status", (_req, res) => {
  const runtime = getRuntimeStatus();
  res.json({
    kind: "hull-optix-service-status",
    backendHint: "mis-path-tracing",
    service: "OptiX-CUDA-TensorPass1",
    runtime,
    provenance: {
      source: "optix/cuda.research.pass2",
      serviceVersion: HULL_OPTIX_SERVICE_VERSION,
      buildHash: HULL_OPTIX_BUILD_HASH,
      commitSha: HULL_OPTIX_COMMIT_SHA,
      processStartedAtMs: HULL_OPTIX_SERVICE_PROCESS_STARTED_AT_MS,
      runtimeInstanceId: HULL_OPTIX_SERVICE_RUNTIME_INSTANCE_ID,
    },
    timestampMs: Date.now(),
  });
});

app.post("/api/helix/hull-render/frame", async (req, res) => {
  const startedAt = Date.now();
  const payload = parseRequest(req.body);
  const deterministicSeed = hashSeed(payload);
  const renderView = payload.scienceLane?.renderView ?? "diagnostic-quad";
  const yorkTimeRequested = renderView === "york-time-3p1";
  const yorkSurfaceRhoRequested = renderView === "york-surface-rho-3p1";
  const yorkSurfaceRequested =
    renderView === "york-surface-3p1" || yorkSurfaceRhoRequested;
  const yorkTopologyNormalizedRequested =
    renderView === "york-topology-normalized-3p1";
  const yorkShellMapRequested = renderView === "york-shell-map-3p1";
  const shiftShellRequested = renderView === "shift-shell-3p1";
  const yorkRequested =
    yorkTimeRequested ||
    yorkSurfaceRequested ||
    yorkTopologyNormalizedRequested ||
    yorkShellMapRequested;
  const requestedDiagnosticLaneId =
    typeof payload.scienceLane?.diagnosticLaneId === "string" &&
    payload.scienceLane.diagnosticLaneId.trim().length > 0
      ? payload.scienceLane.diagnosticLaneId.trim()
      : null;
  let resolvedYorkLaneId: YorkDiagnosticLaneId | null = null;
  let yorkMetricBrick: GrBrickDecoded | null = null;
  let yorkObserverConstructionInfo: YorkDiagnosticObserverConstructionInfo | null =
    null;
  const certificateIdentityRequested = yorkRequested || shiftShellRequested;
  const requireCongruentNhm2FullSolve =
    payload.scienceLane?.requireCongruentNhm2FullSolve === true ||
    readEnvFlag("OPTIX_RENDER_REQUIRE_CONGRUENT_NHM2_FULL_SOLVE", true);

  const requireScientificFrame = payload.scienceLane?.requireScientificFrame === true;
  const requireCanonicalTensorVolume =
    payload.scienceLane?.requireCanonicalTensorVolume === true;
  const requireHullSupportChannels =
    payload.scienceLane?.requireHullSupportChannels === true;
  if (
    certificateIdentityRequested &&
    (typeof payload.metricVolumeRef?.hash !== "string" ||
      payload.metricVolumeRef.hash.trim().length === 0)
  ) {
    return res.status(422).json({
      error: shiftShellRequested
        ? "scientific_shift_shell_certificate_mismatch"
        : "scientific_york_certificate_mismatch",
      message: `${renderView} requires metricVolumeRef.hash for certified snapshot identity`,
    });
  }
  if (
    requireCongruentNhm2FullSolve &&
    !metricRefEnforcesCongruentSolve(payload.metricVolumeRef)
  ) {
    return res.status(422).json({
      error: "scientific_metric_ref_missing_congruent_gate",
      message:
        "scientific frame requires metricVolumeRef URL with requireCongruentSolve=1 (or requireNhm2CongruentFullSolve=1)",
    });
  }
  let metricBrick: GrBrickDecoded | null = null;
  let tensorContext: TensorRenderContext | null = null;
  let tensorFetchError: string | null = null;
  let scientificContractViolations: ScientificContractViolation[] = [];
  if (payload.metricVolumeRef?.kind === "gr-evolve-brick") {
    const metricFetchTimeoutMs = resolveMetricFetchTimeoutMs(payload, payload.metricVolumeRef);
    try {
      metricBrick = await fetchMetricBrick(payload.metricVolumeRef, {
        timeoutMs: metricFetchTimeoutMs,
      });
      if (metricBrick) {
        const contract = validateScientificMetricVolume(payload, metricBrick);
        scientificContractViolations = contract.violations;
        if (contract.ok) {
          tensorContext = buildTensorRenderContext(payload, metricBrick);
        } else {
          tensorFetchError = contract.violations[0]?.message ?? "scientific_metric_contract_violation";
          if (
            requireScientificFrame ||
            requireCanonicalTensorVolume ||
            requireHullSupportChannels
          ) {
            return res.status(422).json({
              error: "scientific_metric_contract_violation",
              message: tensorFetchError,
              violations: scientificContractViolations,
            });
          }
        }
      }
      if (!metricBrick) tensorFetchError = "metric_ref_decode_failed";
    } catch (error) {
      tensorFetchError = error instanceof Error ? error.message : String(error);
    }
  }

  const useTensorPath = !!tensorContext && !!metricBrick;
  const fullAtlasRequested = renderView === "full-atlas";
  const strictTensorPathRequired =
    requireScientificFrame ||
    requireCanonicalTensorVolume ||
    requireHullSupportChannels ||
    requireCongruentNhm2FullSolve ||
    fullAtlasRequested;
  if (!useTensorPath && strictTensorPathRequired) {
    return res.status(422).json({
      error: "scientific_metric_volume_unavailable",
      message:
        tensorFetchError ??
        "scientific frame requires metricVolumeRef with decodable gr-evolve-brick volume",
    });
  }
  if (useTensorPath && yorkRequested) {
    if (requestedDiagnosticLaneId && !isYorkDiagnosticLaneId(requestedDiagnosticLaneId)) {
      return res.status(422).json({
        error: "scientific_york_lane_unsupported",
        message:
          `${renderView} supports only ${Object.keys(YORK_DIAGNOSTIC_LANE_CONVENTIONS).join(", ")} in this service`,
      });
    }
    resolvedYorkLaneId = resolveRequestedYorkLaneId(payload);
    const laneField = computeYorkDiagnosticLaneField({
      laneId: resolvedYorkLaneId,
      dims: metricBrick!.dims,
      voxelSizeM: metricBrick!.voxelSize_m,
      theta: metricBrick!.channels.theta?.data ?? null,
      kTrace: metricBrick!.channels.K_trace?.data ?? null,
      betaX: metricBrick!.channels.beta_x?.data ?? null,
      betaY: metricBrick!.channels.beta_y?.data ?? null,
      betaZ: metricBrick!.channels.beta_z?.data ?? null,
      alpha: metricBrick!.channels.alpha?.data ?? null,
      gammaXX: metricBrick!.channels.gamma_xx?.data ?? null,
      gammaXY: metricBrick!.channels.gamma_xy?.data ?? null,
      gammaXZ: metricBrick!.channels.gamma_xz?.data ?? null,
      gammaYY: metricBrick!.channels.gamma_yy?.data ?? null,
      gammaYZ: metricBrick!.channels.gamma_yz?.data ?? null,
      gammaZZ: metricBrick!.channels.gamma_zz?.data ?? null,
    });
    if (!laneField.ok && laneField.error === "scientific_york_theta_missing") {
      return res.status(422).json({
        error: "scientific_york_theta_missing",
        message: `${renderView} requires canonical theta channel in metric volume`,
      });
    }
    if (!laneField.ok) {
      return res.status(422).json({
        error: "scientific_york_lane_tensor_missing",
        message: `${renderView} requires lane tensors for ${resolvedYorkLaneId}: missing ${laneField.missingChannels.join(", ")}`,
      });
    }
    yorkObserverConstructionInfo = laneField.observerConstruction;
    yorkMetricBrick = withYorkThetaChannel(metricBrick!, laneField.theta);
    const chartNow = (metricBrick!.chart ?? payload.solve?.chart ?? "").trim().toLowerCase();
    if (chartNow.length > 0 && chartNow !== "comoving_cartesian") {
      return res.status(422).json({
        error: "scientific_york_chart_unsupported",
        message: `${renderView} supports comoving_cartesian chart only (received ${chartNow})`,
      });
    }
  }
  if (useTensorPath && yorkShellMapRequested) {
    const hullSdfData = metricBrick!.channels.hull_sdf?.data;
    const supportMaskData = metricBrick!.channels.tile_support_mask?.data;
    if (
      !(hullSdfData instanceof Float32Array) ||
      !(supportMaskData instanceof Float32Array)
    ) {
      return res.status(422).json({
        error: "scientific_york_shell_support_missing",
        message: `${renderView} requires hull_sdf and tile_support_mask channels in metric volume`,
      });
    }
  }
  if (useTensorPath && shiftShellRequested) {
    const betaXData = metricBrick!.channels.beta_x?.data;
    if (!(betaXData instanceof Float32Array)) {
      return res.status(422).json({
        error: "scientific_shift_shell_beta_missing",
        message: `${renderView} requires canonical beta_x channel in metric volume`,
      });
    }
    const hullSdfData = metricBrick!.channels.hull_sdf?.data;
    const supportMaskData = metricBrick!.channels.tile_support_mask?.data;
    if (
      !(hullSdfData instanceof Float32Array) ||
      !(supportMaskData instanceof Float32Array)
    ) {
      return res.status(422).json({
        error: "scientific_shift_shell_support_missing",
        message: `${renderView} requires hull_sdf and tile_support_mask channels in metric volume`,
      });
    }
    const chartNow = (metricBrick!.chart ?? payload.solve?.chart ?? "").trim().toLowerCase();
    if (chartNow.length > 0 && chartNow !== "comoving_cartesian") {
      return res.status(422).json({
        error: "scientific_shift_shell_chart_unsupported",
        message: `${renderView} supports comoving_cartesian chart only (received ${chartNow})`,
      });
    }
  }
  const activeMetricBrick =
    useTensorPath && yorkRequested && yorkMetricBrick ? yorkMetricBrick : metricBrick;
  const png = useTensorPath
    ? await renderTensorFrame(payload, deterministicSeed, tensorContext!, activeMetricBrick!)
    : await renderOptixScaffoldFrame(payload, deterministicSeed);
  const transportFieldForNote =
    useTensorPath && renderView === "transport-3p1"
      ? selectTransportFieldForFrame(metricBrick!, tensorContext!) ??
        selectVolumeField(metricBrick!, tensorContext!)
      : null;
  const transportFieldNote =
    transportFieldForNote != null
      ? ` | field=${transportFieldForNote.key} range=${fmtScientific(transportFieldForNote.min, 3)}..${fmtScientific(
          transportFieldForNote.max,
          3,
        )}`
      : "";
  const renderCertificate =
    useTensorPath && activeMetricBrick && tensorContext
      ? buildRenderCertificate({
          payload,
          ctx: tensorContext,
          brick: activeMetricBrick,
          png,
          yorkObserverConstruction: yorkObserverConstructionInfo,
        })
      : undefined;
  if (useTensorPath && yorkRequested) {
    if (
      !renderCertificate ||
      typeof renderCertificate.theta_definition !== "string" ||
      renderCertificate.theta_definition.trim().length === 0
    ) {
      return res.status(422).json({
        error: "scientific_york_convention_mismatch",
        message: `${renderView} requires theta_definition in render certificate`,
      });
    }
    if (renderCertificate.render.field_key !== "theta") {
      return res.status(422).json({
        error: "scientific_york_convention_mismatch",
        message: `${renderView} requires render.field_key=theta in render certificate`,
      });
    }
    const expectedYorkSlicePlane = yorkSurfaceRhoRequested
      ? "x-rho"
      : "x-z-midplane";
    const expectedYorkCoordinateMode = yorkSurfaceRhoRequested
      ? "x-rho"
      : "x-z-midplane";
    const expectedYorkSamplingChoice = yorkSurfaceRhoRequested
      ? "x-rho cylindrical remap"
      : "x-z midplane";
    if (renderCertificate.render.slice_plane !== expectedYorkSlicePlane) {
      return res.status(422).json({
        error: "scientific_york_convention_mismatch",
        message: `${renderView} requires render.slice_plane=${expectedYorkSlicePlane} in render certificate`,
      });
    }
    if (renderCertificate.render.coordinate_mode !== expectedYorkCoordinateMode) {
      return res.status(422).json({
        error: "scientific_york_convention_mismatch",
        message: `${renderView} requires render.coordinate_mode=${expectedYorkCoordinateMode} in render certificate`,
      });
    }
    const expectedYorkNormalization = yorkTopologyNormalizedRequested
      ? "topology-only-unit-max"
      : "symmetric-about-zero";
    if (renderCertificate.render.normalization !== expectedYorkNormalization) {
      return res.status(422).json({
        error: "scientific_york_convention_mismatch",
        message: `${renderView} requires render.normalization=${expectedYorkNormalization} in render certificate`,
      });
    }
    if (
      yorkTopologyNormalizedRequested &&
      renderCertificate.render.magnitude_mode !== "normalized-topology-only"
    ) {
      return res.status(422).json({
        error: "scientific_york_convention_mismatch",
        message:
          "york-topology-normalized-3p1 requires render.magnitude_mode=normalized-topology-only in render certificate",
      });
    }
    const yorkAuditIdentityValid =
      renderCertificate.diagnostics.metric_ref_hash ===
        renderCertificate.metric_ref_hash &&
      Number.isFinite(renderCertificate.diagnostics.timestamp_ms ?? Number.NaN) &&
      Number(renderCertificate.diagnostics.timestamp_ms) ===
        renderCertificate.timestamp_ms &&
      typeof renderCertificate.diagnostics.theta_definition === "string" &&
      renderCertificate.diagnostics.theta_definition.trim().length > 0 &&
      renderCertificate.diagnostics.theta_definition ===
        renderCertificate.theta_definition;
    const yorkAuditCoreValid =
      typeof renderCertificate.diagnostics.theta_channel_hash === "string" &&
      renderCertificate.diagnostics.theta_channel_hash.trim().length > 0 &&
      typeof renderCertificate.diagnostics.slice_array_hash === "string" &&
      renderCertificate.diagnostics.slice_array_hash.trim().length > 0 &&
      Number.isFinite(renderCertificate.diagnostics.theta_min_raw ?? Number.NaN) &&
      Number.isFinite(renderCertificate.diagnostics.theta_max_raw ?? Number.NaN) &&
      Number.isFinite(
        renderCertificate.diagnostics.theta_abs_max_raw ?? Number.NaN,
      ) &&
      Number.isFinite(
        renderCertificate.diagnostics.theta_min_display ?? Number.NaN,
      ) &&
      Number.isFinite(
        renderCertificate.diagnostics.theta_max_display ?? Number.NaN,
      ) &&
      Number.isFinite(
        renderCertificate.diagnostics.theta_abs_max_display ?? Number.NaN,
      ) &&
      typeof renderCertificate.diagnostics.display_range_method === "string" &&
      renderCertificate.diagnostics.display_range_method.trim().length > 0 &&
      typeof renderCertificate.diagnostics.near_zero_theta === "boolean" &&
      Number.isFinite(
        renderCertificate.diagnostics.zero_contour_segments ?? Number.NaN,
      ) &&
      renderCertificate.diagnostics.sampling_choice === expectedYorkSamplingChoice &&
      Number.isFinite(renderCertificate.diagnostics.display_gain ?? Number.NaN) &&
      Number.isFinite(renderCertificate.diagnostics.height_scale ?? Number.NaN) &&
      renderCertificate.diagnostics.coordinate_mode === expectedYorkCoordinateMode &&
      typeof renderCertificate.diagnostics.peak_theta_in_supported_region ===
        "boolean";
    if (!yorkAuditIdentityValid || !yorkAuditCoreValid) {
      return res.status(422).json({
        error: "scientific_york_diagnostics_missing",
        message:
          `${renderView} requires metric_ref_hash/timestamp_ms/theta_definition/theta_channel_hash/slice_array_hash and both raw/display York extrema diagnostics in render certificate`,
      });
    }
    const rawYorkView =
      yorkTimeRequested || yorkSurfaceRequested || yorkShellMapRequested;
    if (rawYorkView && renderCertificate.render.magnitude_mode != null) {
      return res.status(422).json({
        error: "scientific_york_convention_mismatch",
        message:
          `${renderView} is a same-snapshot raw York view and requires render.magnitude_mode=null`,
      });
    }
    // A near-flat York plot is a legitimate result for low-expansion warp configurations; the renderer must not inject hidden gain or alternate sampling in a way that impersonates a stronger expansion field.
    const yorkDisplayGain = Number(renderCertificate.diagnostics.display_gain ?? Number.NaN);
    if (
      rawYorkView &&
      (!Number.isFinite(yorkDisplayGain) || Math.abs(yorkDisplayGain - 1) > 1e-12)
    ) {
      return res.status(422).json({
        error: "scientific_york_convention_mismatch",
        message: `${renderView} raw York views require diagnostics.display_gain=1`,
      });
    }
    if (
      (yorkSurfaceRequested || yorkShellMapRequested) &&
      renderCertificate.render.surface_height !== "theta"
    ) {
      return res.status(422).json({
        error: yorkShellMapRequested
          ? "scientific_york_shell_map_convention_mismatch"
          : "scientific_york_surface_convention_mismatch",
        message: `${renderView} requires render.surface_height=theta in render certificate`,
      });
    }
    if (
      yorkTopologyNormalizedRequested &&
      renderCertificate.render.surface_height !== "theta_norm"
    ) {
      return res.status(422).json({
        error: "scientific_york_topology_convention_mismatch",
        message:
          "york-topology-normalized-3p1 requires render.surface_height=theta_norm in render certificate",
      });
    }
    if (
      yorkTopologyNormalizedRequested &&
      (typeof renderCertificate.diagnostics.normalized_slice_hash !== "string" ||
        renderCertificate.diagnostics.normalized_slice_hash.trim().length === 0)
    ) {
      return res.status(422).json({
        error: "scientific_york_topology_diagnostics_missing",
        message:
          "york-topology-normalized-3p1 requires diagnostics.normalized_slice_hash in render certificate",
      });
    }
    if (
      yorkShellMapRequested &&
      renderCertificate.render.support_overlay !== "hull_sdf+tile_support_mask"
    ) {
      return res.status(422).json({
        error: "scientific_york_shell_map_convention_mismatch",
        message:
          "york-shell-map-3p1 requires render.support_overlay=hull_sdf+tile_support_mask in render certificate",
      });
    }
    if (yorkShellMapRequested) {
      const shellMapDiagnosticsValid =
        Number.isFinite(renderCertificate.diagnostics.theta_min_raw ?? Number.NaN) &&
        Number.isFinite(renderCertificate.diagnostics.theta_max_raw ?? Number.NaN) &&
        Number.isFinite(
          renderCertificate.diagnostics.theta_abs_max_raw ?? Number.NaN,
        ) &&
        Number.isFinite(
          renderCertificate.diagnostics.theta_min_display ?? Number.NaN,
        ) &&
        Number.isFinite(
          renderCertificate.diagnostics.theta_max_display ?? Number.NaN,
        ) &&
        Number.isFinite(
          renderCertificate.diagnostics.theta_abs_max_display ?? Number.NaN,
        ) &&
        typeof renderCertificate.diagnostics.display_range_method === "string" &&
        renderCertificate.diagnostics.display_range_method.trim().length > 0 &&
        typeof renderCertificate.diagnostics.near_zero_theta === "boolean" &&
        Number.isFinite(
          renderCertificate.diagnostics.supported_theta_fraction ?? Number.NaN,
        ) &&
        Number.isFinite(
          renderCertificate.diagnostics.shell_theta_overlap_pct ?? Number.NaN,
        ) &&
        typeof renderCertificate.diagnostics.support_mask_slice_hash === "string" &&
        renderCertificate.diagnostics.support_mask_slice_hash.trim().length > 0 &&
        Number.isFinite(
          renderCertificate.diagnostics.theta_shell_min_raw ?? Number.NaN,
        ) &&
        Number.isFinite(
          renderCertificate.diagnostics.theta_shell_max_raw ?? Number.NaN,
        ) &&
        Number.isFinite(
          renderCertificate.diagnostics.theta_shell_abs_max_raw ?? Number.NaN,
        ) &&
        Number.isFinite(
          renderCertificate.diagnostics.theta_shell_min_display ?? Number.NaN,
        ) &&
        Number.isFinite(
          renderCertificate.diagnostics.theta_shell_max_display ?? Number.NaN,
        ) &&
        Number.isFinite(
          renderCertificate.diagnostics.theta_shell_abs_max_display ?? Number.NaN,
        ) &&
        Number.isFinite(
          renderCertificate.diagnostics.shell_support_count ?? Number.NaN,
        ) &&
        Number.isFinite(
          renderCertificate.diagnostics.shell_active_count ?? Number.NaN,
        ) &&
        typeof renderCertificate.diagnostics.shell_masked_slice_hash === "string" &&
        renderCertificate.diagnostics.shell_masked_slice_hash.trim().length > 0 &&
        typeof renderCertificate.diagnostics.shell_mask_slice_hash === "string" &&
        renderCertificate.diagnostics.shell_mask_slice_hash.trim().length > 0 &&
        Number(renderCertificate.diagnostics.shell_active_count ?? Number.NaN) <=
          Number(renderCertificate.diagnostics.shell_support_count ?? Number.NaN) &&
        typeof renderCertificate.diagnostics.peak_theta_in_supported_region ===
          "boolean";
      if (!shellMapDiagnosticsValid) {
        return res.status(422).json({
          error: "scientific_york_shell_map_diagnostics_missing",
          message:
            "york-shell-map-3p1 requires theta_channel_hash/slice_array_hash/support_mask_slice_hash/shell_masked_slice_hash/theta_min_raw/theta_max_raw/theta_abs_max_raw/theta_min_display/theta_max_display/theta_abs_max_display/display_range_method/near_zero_theta/supported_theta_fraction/shell_theta_overlap_pct/theta_shell_min_raw/theta_shell_max_raw/theta_shell_abs_max_raw/theta_shell_min_display/theta_shell_max_display/theta_shell_abs_max_display/shell_support_count/shell_active_count/shell_mask_slice_hash/peak_theta_in_supported_region diagnostics",
        });
      }
    }
    const requestedHash = payload.metricVolumeRef?.hash?.trim();
    if (requestedHash && renderCertificate.metric_ref_hash !== requestedHash) {
      return res.status(422).json({
        error: "scientific_york_certificate_mismatch",
        message: `${renderView} render certificate metric_ref_hash does not match requested snapshot`,
      });
    }
    // "These York views are same-snapshot congruent renderings of one NHM2 solution.
    // Parameter-family comparisons are separate products and must not be represented
    // as a single simultaneous system."
    const yorkIdentityFieldsPresent =
      typeof renderCertificate.metric_ref_hash === "string" &&
      renderCertificate.metric_ref_hash.trim().length > 0 &&
      typeof renderCertificate.chart === "string" &&
      renderCertificate.chart.trim().length > 0 &&
      typeof renderCertificate.observer === "string" &&
      renderCertificate.observer.trim().length > 0 &&
      typeof renderCertificate.theta_definition === "string" &&
      renderCertificate.theta_definition.trim().length > 0 &&
      typeof renderCertificate.kij_sign_convention === "string" &&
      renderCertificate.kij_sign_convention.trim().length > 0 &&
      typeof renderCertificate.unit_system === "string" &&
      renderCertificate.unit_system.trim().length > 0 &&
      Number.isFinite(renderCertificate.timestamp_ms);
    if (!yorkIdentityFieldsPresent) {
      return res.status(422).json({
        error: "scientific_york_certificate_mismatch",
        message:
          `${renderView} requires metric_ref_hash/timestamp_ms/chart/observer/theta_definition/kij_sign_convention/unit_system in render certificate`,
      });
    }
    const requestedMetricChart = payload.metricVolumeRef?.chart?.trim();
    if (
      requestedMetricChart &&
      renderCertificate.chart !== requestedMetricChart
    ) {
      return res.status(422).json({
        error: "scientific_york_certificate_mismatch",
        message: `${renderView} render certificate chart does not match requested snapshot chart`,
      });
    }
    const requestedTimestampMs = toFiniteNumber(
      payload.metricVolumeRef?.updatedAt,
      Number.NaN,
    );
    if (
      Number.isFinite(requestedTimestampMs) &&
      renderCertificate.timestamp_ms !== requestedTimestampMs
    ) {
      return res.status(422).json({
        error: "scientific_york_certificate_mismatch",
        message: `${renderView} render certificate timestamp_ms does not match requested snapshot timestamp`,
      });
    }
    if (requestedDiagnosticLaneId) {
      if (renderCertificate.render.lane_id !== requestedDiagnosticLaneId) {
        return res.status(422).json({
          error: "scientific_york_lane_mismatch",
          message:
            `${renderView} requires render.lane_id=${requestedDiagnosticLaneId} in render certificate`,
        });
      }
      if (renderCertificate.diagnostics.lane_id !== requestedDiagnosticLaneId) {
        return res.status(422).json({
          error: "scientific_york_lane_mismatch",
          message:
            `${renderView} requires diagnostics.lane_id=${requestedDiagnosticLaneId} in render certificate`,
        });
      }
      const laneConvention = isYorkDiagnosticLaneId(requestedDiagnosticLaneId)
        ? resolveYorkLaneConvention(requestedDiagnosticLaneId)
        : null;
      if (
        !laneConvention ||
        renderCertificate.observer !== laneConvention.observer ||
        renderCertificate.theta_definition !== laneConvention.theta_definition ||
        renderCertificate.kij_sign_convention !== laneConvention.kij_sign_convention
      ) {
        return res.status(422).json({
          error: "scientific_york_lane_mismatch",
          message:
            `${renderView} requires observer/theta_definition/kij_sign_convention to match lane ${requestedDiagnosticLaneId}`,
        });
      }
      if (requestedDiagnosticLaneId === YORK_DIAGNOSTIC_ALTERNATE_LANE_ID) {
        const observerInputsRequired = Array.isArray(
          renderCertificate.diagnostics.observer_inputs_required,
        )
          ? renderCertificate.diagnostics.observer_inputs_required
              .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
              .filter((entry) => entry.length > 0)
              .sort()
          : [];
        const expectedObserverInputsRequired = [
          ...laneConvention.observer_inputs_required,
        ]
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .sort();
        const observerInputsRequiredMatch =
          observerInputsRequired.length === expectedObserverInputsRequired.length &&
          observerInputsRequired.every(
            (entry, index) => entry === expectedObserverInputsRequired[index],
          );
        if (
          renderCertificate.diagnostics.observer_definition_id !==
            laneConvention.observer_definition_id ||
          renderCertificate.diagnostics.observer_construction_formula !==
            laneConvention.observer_construction_formula ||
          renderCertificate.diagnostics.observer_normalized !==
            laneConvention.observer_normalized ||
          (renderCertificate.diagnostics.observer_approximation ?? null) !==
            (laneConvention.observer_approximation ?? null) ||
          renderCertificate.diagnostics.cross_lane_claim_ready !==
            laneConvention.cross_lane_claim_ready ||
          renderCertificate.diagnostics.observer_inputs_present !== true ||
          renderCertificate.diagnostics.lane_b_geometry_ready !== true ||
          typeof renderCertificate.diagnostics.lane_b_semantic_mode !== "string" ||
          renderCertificate.diagnostics.lane_b_semantic_mode.trim().length === 0 ||
          renderCertificate.diagnostics.lane_b_semantic_mode !==
            laneConvention.lane_semantic_mode ||
          typeof renderCertificate.diagnostics.lane_b_tensor_inputs_hash !==
            "string" ||
          renderCertificate.diagnostics.lane_b_tensor_inputs_hash.trim().length ===
            0 ||
          renderCertificate.diagnostics.lane_b_semantics_closed !==
            laneConvention.semantics_closed ||
          !observerInputsRequiredMatch
        ) {
          return res.status(422).json({
            error: "scientific_york_lane_mismatch",
            message:
              `${renderView} requires Lane B semantic evidence (observer_definition_id/observer_construction_formula/observer_normalized/observer_approximation/cross_lane_claim_ready/observer_inputs_required/observer_inputs_present/lane_b_semantic_mode/lane_b_tensor_inputs_hash/lane_b_geometry_ready/lane_b_semantics_closed) to match lane ${requestedDiagnosticLaneId}`,
          });
        }
      }
    }
  }
  if (useTensorPath && shiftShellRequested) {
    if (
      !renderCertificate ||
      renderCertificate.render.field_key !== "beta_x" ||
      renderCertificate.render.slice_plane !== "x-z-midplane" ||
      renderCertificate.render.normalization !== "symmetric-about-zero"
    ) {
      return res.status(422).json({
        error: "scientific_shift_shell_convention_mismatch",
        message: `${renderView} requires render field metadata (beta_x / x-z-midplane / symmetric-about-zero)`,
      });
    }
    if (
      renderCertificate.render.support_overlay !==
      "hull_sdf+tile_support_mask"
    ) {
      return res.status(422).json({
        error: "scientific_shift_shell_convention_mismatch",
        message: `${renderView} requires render.support_overlay=hull_sdf+tile_support_mask`,
      });
    }
    const requestedHash = payload.metricVolumeRef?.hash?.trim();
    if (requestedHash && renderCertificate.metric_ref_hash !== requestedHash) {
      return res.status(422).json({
        error: "scientific_shift_shell_certificate_mismatch",
        message: `${renderView} render certificate metric_ref_hash does not match requested snapshot`,
      });
    }
  }
  const scientificAtlas =
    useTensorPath &&
    metricBrick &&
    tensorContext &&
    renderCertificate &&
    renderView === "full-atlas"
      ? buildScientificAtlasSidecar({
          certificate: renderCertificate,
          channelHashes: renderCertificate.channel_hashes,
          geodesicMode: "full-3+1-christoffel",
        })
      : undefined;
  if (
    useTensorPath &&
    renderView === "full-atlas" &&
    payload.scienceLane?.requireScientificFrame === true
  ) {
    if (!scientificAtlas) {
      return res.status(422).json({
        error: "scientific_atlas_pane_missing",
        message: "full-atlas sidecar missing for strict scientific request",
      });
    }
    const failingPanes = SCIENTIFIC_ATLAS_REQUIRED_PANES.filter(
      (paneId) => scientificAtlas.pane_status[paneId] !== "ok",
    );
    if (failingPanes.length > 0) {
      return res.status(422).json({
        error: "scientific_atlas_channel_contract_missing",
        message: `full-atlas sidecar missing required pane channels: ${failingPanes.join(",")}`,
        failingPanes,
      });
    }
  }
  const response: HullMisRenderResponseV1 = useTensorPath
    ? {
        version: 1,
        ok: true,
        backend: "proxy",
        imageMime: "image/png",
        imageDataUrl: encodePngDataUrl(png),
        width: payload.width,
        height: payload.height,
        deterministicSeed,
        renderMs: Date.now() - startedAt,
        renderCertificate,
        scientificAtlas,
        diagnostics: {
          note: `optix_cuda_tensorfed_research_pass2_christoffel_bundle | view=${renderView} | gamma_offdiag=required | ${formatSupportSummary(
            tensorContext!,
          )}${transportFieldNote}`,
          geodesicMode: "full-3+1-christoffel",
          consistency: tensorContext!.diagnostics.consistency,
          maxNullResidual: tensorContext!.diagnostics.maxNullResidual,
          stepConvergence: tensorContext!.diagnostics.stepConvergence,
          bundleSpread: tensorContext!.diagnostics.bundleSpread,
          scientificTier: "research-grade",
          samplingMode:
            payload.scienceLane?.samplingMode === "nearest" ? "nearest" : "trilinear",
          supportCoveragePct: tensorContext!.supportCoveragePct,
          maskedOutPct: tensorContext!.maskedOutPct,
          supportMaskKind: tensorContext!.supportMaskKind,
          lane_id: renderCertificate?.diagnostics.lane_id ?? null,
          laneId: renderCertificate?.diagnostics.lane_id ?? null,
          ...((renderView === "york-time-3p1" ||
            renderView === "york-surface-3p1" ||
            renderView === "york-surface-rho-3p1" ||
            renderView === "york-topology-normalized-3p1" ||
            renderView === "york-shell-map-3p1") &&
          renderCertificate
            ? {
                // Following invariant-first visualization discipline, the York
                // figure must expose raw numeric extrema and snapshot identity so
                // a near-flat field is read as a physical result, not as an
                // ambiguous render artifact. Mattingly-style fixed-coordinate,
                // auditable scientific visualization.
                lane_id: renderCertificate.diagnostics.lane_id ?? null,
                laneId: renderCertificate.diagnostics.lane_id ?? null,
                observer_definition_id:
                  renderCertificate.diagnostics.observer_definition_id ?? null,
                observer_inputs_required:
                  renderCertificate.diagnostics.observer_inputs_required ?? null,
                observer_construction_inputs:
                  renderCertificate.diagnostics.observer_construction_inputs ?? null,
                observer_construction_formula:
                  renderCertificate.diagnostics.observer_construction_formula ?? null,
                observer_normalized:
                  renderCertificate.diagnostics.observer_normalized ?? null,
                observer_approximation:
                  renderCertificate.diagnostics.observer_approximation ?? null,
                observer_inputs_present:
                  renderCertificate.diagnostics.observer_inputs_present ?? null,
                lane_b_semantic_mode:
                  renderCertificate.diagnostics.lane_b_semantic_mode ?? null,
                lane_b_tensor_inputs_hash:
                  renderCertificate.diagnostics.lane_b_tensor_inputs_hash ?? null,
                lane_b_geometry_ready:
                  renderCertificate.diagnostics.lane_b_geometry_ready ?? null,
                lane_b_semantics_closed:
                  renderCertificate.diagnostics.lane_b_semantics_closed ?? null,
                requires_gamma_metric:
                  renderCertificate.diagnostics.requires_gamma_metric ?? null,
                semantics_closed:
                  renderCertificate.diagnostics.semantics_closed ?? null,
                cross_lane_claim_ready:
                  renderCertificate.diagnostics.cross_lane_claim_ready ?? null,
                cross_lane_claim_block_reason:
                  renderCertificate.diagnostics.cross_lane_claim_block_reason ?? null,
                metric_ref_hash: renderCertificate.diagnostics.metric_ref_hash ?? null,
                timestamp_ms: renderCertificate.diagnostics.timestamp_ms ?? null,
                theta_definition:
                  renderCertificate.diagnostics.theta_definition ?? null,
                theta_channel_hash:
                  renderCertificate.diagnostics.theta_channel_hash ?? null,
                slice_array_hash:
                  renderCertificate.diagnostics.slice_array_hash ?? null,
                normalized_slice_hash:
                  renderCertificate.diagnostics.normalized_slice_hash ?? null,
                support_mask_slice_hash:
                  renderCertificate.diagnostics.support_mask_slice_hash ?? null,
                shell_masked_slice_hash:
                  renderCertificate.diagnostics.shell_masked_slice_hash ?? null,
                theta_min_raw:
                  renderCertificate.diagnostics.theta_min_raw ?? null,
                theta_max_raw:
                  renderCertificate.diagnostics.theta_max_raw ?? null,
                theta_abs_max_raw:
                  renderCertificate.diagnostics.theta_abs_max_raw ?? null,
                theta_min_display:
                  renderCertificate.diagnostics.theta_min_display ?? null,
                theta_max_display:
                  renderCertificate.diagnostics.theta_max_display ?? null,
                theta_abs_max_display:
                  renderCertificate.diagnostics.theta_abs_max_display ?? null,
                display_range_method:
                  renderCertificate.diagnostics.display_range_method ?? null,
                theta_shell_min_raw:
                  renderCertificate.diagnostics.theta_shell_min_raw ?? null,
                theta_shell_max_raw:
                  renderCertificate.diagnostics.theta_shell_max_raw ?? null,
                theta_shell_abs_max_raw:
                  renderCertificate.diagnostics.theta_shell_abs_max_raw ?? null,
                theta_shell_min_display:
                  renderCertificate.diagnostics.theta_shell_min_display ?? null,
                theta_shell_max_display:
                  renderCertificate.diagnostics.theta_shell_max_display ?? null,
                theta_shell_abs_max_display:
                  renderCertificate.diagnostics.theta_shell_abs_max_display ?? null,
                shell_support_count:
                  renderCertificate.diagnostics.shell_support_count ?? null,
                shell_active_count:
                  renderCertificate.diagnostics.shell_active_count ?? null,
                shell_mask_slice_hash:
                  renderCertificate.diagnostics.shell_mask_slice_hash ?? null,
                theta_min: renderCertificate.diagnostics.theta_min ?? null,
                theta_max: renderCertificate.diagnostics.theta_max ?? null,
                theta_abs_max: renderCertificate.diagnostics.theta_abs_max ?? null,
                near_zero_theta:
                  renderCertificate.diagnostics.near_zero_theta ?? null,
                zero_contour_segments:
                  renderCertificate.diagnostics.zero_contour_segments ?? null,
                sampling_choice:
                  renderCertificate.diagnostics.sampling_choice ?? null,
                coordinate_mode:
                  renderCertificate.diagnostics.coordinate_mode ?? null,
                display_gain: renderCertificate.diagnostics.display_gain ?? null,
                height_scale: renderCertificate.diagnostics.height_scale ?? null,
                peak_theta_in_supported_region:
                  renderCertificate.diagnostics.peak_theta_in_supported_region ??
                  null,
                thetaMin: renderCertificate.diagnostics.theta_min ?? null,
                thetaMax: renderCertificate.diagnostics.theta_max ?? null,
                thetaAbsMax: renderCertificate.diagnostics.theta_abs_max ?? null,
                thetaMinRaw:
                  renderCertificate.diagnostics.theta_min_raw ?? null,
                thetaMaxRaw:
                  renderCertificate.diagnostics.theta_max_raw ?? null,
                thetaAbsMaxRaw:
                  renderCertificate.diagnostics.theta_abs_max_raw ?? null,
                thetaMinDisplay:
                  renderCertificate.diagnostics.theta_min_display ?? null,
                thetaMaxDisplay:
                  renderCertificate.diagnostics.theta_max_display ?? null,
                thetaAbsMaxDisplay:
                  renderCertificate.diagnostics.theta_abs_max_display ?? null,
                displayRangeMethod:
                  renderCertificate.diagnostics.display_range_method ?? null,
                thetaShellMinRaw:
                  renderCertificate.diagnostics.theta_shell_min_raw ?? null,
                thetaShellMaxRaw:
                  renderCertificate.diagnostics.theta_shell_max_raw ?? null,
                thetaShellAbsMaxRaw:
                  renderCertificate.diagnostics.theta_shell_abs_max_raw ?? null,
                thetaShellMinDisplay:
                  renderCertificate.diagnostics.theta_shell_min_display ?? null,
                thetaShellMaxDisplay:
                  renderCertificate.diagnostics.theta_shell_max_display ?? null,
                thetaShellAbsMaxDisplay:
                  renderCertificate.diagnostics.theta_shell_abs_max_display ?? null,
                shellSupportCount:
                  renderCertificate.diagnostics.shell_support_count ?? null,
                shellActiveCount:
                  renderCertificate.diagnostics.shell_active_count ?? null,
                shellMaskSliceHash:
                  renderCertificate.diagnostics.shell_mask_slice_hash ?? null,
                thetaChannelHash:
                  renderCertificate.diagnostics.theta_channel_hash ?? null,
                sliceArrayHash:
                  renderCertificate.diagnostics.slice_array_hash ?? null,
                normalizedSliceHash:
                  renderCertificate.diagnostics.normalized_slice_hash ?? null,
                supportMaskSliceHash:
                  renderCertificate.diagnostics.support_mask_slice_hash ?? null,
                shellMaskedSliceHash:
                  renderCertificate.diagnostics.shell_masked_slice_hash ?? null,
                nearZeroTheta:
                  renderCertificate.diagnostics.near_zero_theta ?? null,
                zeroContourSegments:
                  renderCertificate.diagnostics.zero_contour_segments ?? null,
                displayGain: renderCertificate.diagnostics.display_gain ?? null,
                heightScale: renderCertificate.diagnostics.height_scale ?? null,
                samplingChoice:
                  renderCertificate.diagnostics.sampling_choice ?? null,
                coordinateMode:
                  renderCertificate.diagnostics.coordinate_mode ?? null,
                supportedThetaFraction:
                  renderCertificate.diagnostics.supported_theta_fraction ?? null,
                shellThetaOverlapPct:
                  renderCertificate.diagnostics.shell_theta_overlap_pct ?? null,
                peakThetaCell:
                  renderCertificate.diagnostics.peak_theta_cell ?? null,
                peakThetaInSupportedRegion:
                  renderCertificate.diagnostics.peak_theta_in_supported_region ??
                  null,
              }
            : {}),
          ...(renderView === "shift-shell-3p1" && renderCertificate
            ? {
                betaMin: renderCertificate.diagnostics.beta_min ?? null,
                betaMax: renderCertificate.diagnostics.beta_max ?? null,
                betaAbsMax: renderCertificate.diagnostics.beta_abs_max ?? null,
                sliceSupportPct:
                  renderCertificate.diagnostics.slice_support_pct ?? null,
                supportOverlapPct:
                  renderCertificate.diagnostics.support_overlap_pct ?? null,
                shellContourSegments:
                  renderCertificate.diagnostics.shell_contour_segments ?? null,
                peakBetaCell:
                  renderCertificate.diagnostics.peak_beta_cell ?? null,
                peakBetaInSupportedRegion:
                  renderCertificate.diagnostics
                    .peak_beta_in_supported_region ?? null,
              }
            : {}),
        },
        attachments: buildTensorAttachments(payload, tensorContext!),
        provenance: {
          source: "optix/cuda.research.pass2",
          serviceUrl: payload.metricVolumeRef?.url ?? null,
          timestampMs: Date.now(),
          researchGrade: true,
          scientificTier: "research-grade",
          serviceVersion: HULL_OPTIX_SERVICE_VERSION,
          buildHash: HULL_OPTIX_BUILD_HASH,
          commitSha: HULL_OPTIX_COMMIT_SHA,
          processStartedAtMs: HULL_OPTIX_SERVICE_PROCESS_STARTED_AT_MS,
          runtimeInstanceId: HULL_OPTIX_SERVICE_RUNTIME_INSTANCE_ID,
        },
      }
    : {
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
          note:
            tensorFetchError != null
              ? `optix_cuda_scaffold_render (${tensorFetchError}) | view=${renderView}`
              : `optix_cuda_scaffold_render | view=${renderView}`,
          geodesicMode: payload.geodesicDiagnostics?.mode ?? null,
          consistency: payload.geodesicDiagnostics?.consistency ?? "unknown",
          maxNullResidual: payload.geodesicDiagnostics?.maxNullResidual ?? null,
          stepConvergence: payload.geodesicDiagnostics?.stepConvergence ?? null,
          bundleSpread: payload.geodesicDiagnostics?.bundleSpread ?? null,
          scientificTier: "scaffold",
          samplingMode:
            payload.scienceLane?.samplingMode === "nearest" ? "nearest" : "trilinear",
        },
        attachments: buildScaffoldAttachments(payload),
        provenance: {
          source: "optix/cuda.scaffold",
          serviceUrl: payload.metricVolumeRef?.url ?? null,
          timestampMs: Date.now(),
          researchGrade: false,
          scientificTier: "scaffold",
          serviceVersion: HULL_OPTIX_SERVICE_VERSION,
          buildHash: HULL_OPTIX_BUILD_HASH,
          commitSha: HULL_OPTIX_COMMIT_SHA,
          processStartedAtMs: HULL_OPTIX_SERVICE_PROCESS_STARTED_AT_MS,
          runtimeInstanceId: HULL_OPTIX_SERVICE_RUNTIME_INSTANCE_ID,
        },
      };
  return res.json(response);
});

const host = readEnv("OPTIX_RENDER_SERVICE_HOST") || DEFAULT_SERVICE_HOST;
const port = toInt(readEnv("OPTIX_RENDER_SERVICE_PORT"), DEFAULT_SERVICE_PORT, 1, 65535);

app.listen(port, host, () => {
  console.log(
    JSON.stringify(
      {
        kind: "hull-optix-service-started",
        host,
        port,
        statusEndpoint: `http://${host}:${port}/api/helix/hull-render/status`,
        frameEndpoint: `http://${host}:${port}/api/helix/hull-render/frame`,
        serviceVersion: HULL_OPTIX_SERVICE_VERSION,
        buildHash: HULL_OPTIX_BUILD_HASH,
        commitSha: HULL_OPTIX_COMMIT_SHA,
        processStartedAtMs: HULL_OPTIX_SERVICE_PROCESS_STARTED_AT_MS,
        runtimeInstanceId: HULL_OPTIX_SERVICE_RUNTIME_INSTANCE_ID,
      },
      null,
      2,
    ),
  );
});
