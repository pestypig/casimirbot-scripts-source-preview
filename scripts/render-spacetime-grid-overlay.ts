import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

type Vec3 = [number, number, number];
type LayerId = "inside_only" | "outside_only" | "combined" | "combined_theta_evidence";
type SceneTransform = {
  minM: Vec3;
  maxM: Vec3;
  spanM: Vec3;
  centerM: Vec3;
  uniformScaleM: number;
};
type DecodedBrick = {
  dims: Vec3;
  bounds: { min: Vec3; max: Vec3 } | null;
  voxelSizeM: Vec3;
  channels: Record<string, Float32Array>;
};
type GridLine = { points: Vec3[]; masks: boolean[] };
type ThetaPoint = { p: Vec3; theta: number; inHull: boolean };
type RenderStyle = {
  color: { r: number; g: number; b: number };
  alpha: number;
};

const ROOT = process.cwd();
const DATE_STAMP = new Date().toISOString().slice(0, 10);
const INPUT_PATH = path.join(ROOT, "artifacts", "research", "full-solve", "triage-brick-48.raw");
const OUTPUT_DIR = path.join(
  ROOT,
  "artifacts",
  "research",
  "full-solve",
  "rendered",
  "scientific_3p1_field",
  DATE_STAMP,
);
const TMP_DIR = path.join(OUTPUT_DIR, "tmp");
const ASSET_PREFIX = "nhm2_spacetime_grid_overlay";

const WIDTH = 640;
const HEIGHT = 640;
const FRAME_COUNT = 48;
const TILT_RAD = (24 * Math.PI) / 180;
const CAMERA_DISTANCE = 3.2;
const FOCAL_PX = 470;

const GRID_X_LINES = 13;
const GRID_Y_LINES = 9;
const GRID_Z_LINES = 7;
const GRID_SAMPLES_PER_LINE = 72;
const SHELL_DECAY_M = 38;
const DEFORM_SCENE_SCALE = 0.085;
const RADIAL_SCENE_SCALE = 0.04;
const MIN_MAG = 1e-45;
const THETA_SHELL_MAX_M = 120;

const ensureDir = (p: string): void => fs.mkdirSync(p, { recursive: true });
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const lerp = (a: number, b: number, t: number): number => a * (1 - t) + b * t;
const lerpVec3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l <= 1e-12) return [0, 0, 0];
  return [v[0] / l, v[1] / l, v[2] / l];
};

const idx3 = (x: number, y: number, z: number, dims: Vec3): number => x + dims[0] * (y + dims[1] * z);
const gridFrac = (i: number, n: number): number => (n <= 1 ? 0 : i / (n - 1));

const decodeBrick = (fileBytes: Buffer): DecodedBrick => {
  const headerLength = fileBytes.readUInt32LE(0);
  if (headerLength <= 0 || 4 + headerLength > fileBytes.byteLength) throw new Error("invalid_brick_header");
  const header = JSON.parse(fileBytes.subarray(4, 4 + headerLength).toString("utf8")) as {
    kind: string;
    dims: number[];
    bounds?: { min: number[]; max: number[] };
    voxelSize_m?: number[];
    channels: Record<string, { bytes: number }>;
    channelOrder: string[];
  };
  if (header.kind !== "gr-evolve-brick") throw new Error("unexpected_brick_kind");
  const dims: Vec3 = [header.dims[0] ?? 1, header.dims[1] ?? 1, header.dims[2] ?? 1];
  const voxelSizeM: Vec3 = [
    Math.max(1e-6, header.voxelSize_m?.[0] ?? 1),
    Math.max(1e-6, header.voxelSize_m?.[1] ?? 1),
    Math.max(1e-6, header.voxelSize_m?.[2] ?? 1),
  ];
  const bounds =
    header.bounds?.min?.length === 3 && header.bounds?.max?.length === 3
      ? {
          min: [header.bounds.min[0], header.bounds.min[1], header.bounds.min[2]] as Vec3,
          max: [header.bounds.max[0], header.bounds.max[1], header.bounds.max[2]] as Vec3,
        }
      : null;
  const padding = (4 - (headerLength % 4)) % 4;
  let offset = 4 + headerLength + padding;
  const channels: Record<string, Float32Array> = {};
  for (const name of header.channelOrder) {
    const bytes = Math.max(4, Math.floor(header.channels[name]?.bytes ?? 0));
    const out = new Float32Array(bytes / 4);
    const dv = new DataView(fileBytes.buffer, fileBytes.byteOffset + offset, bytes);
    for (let i = 0; i < out.length; i += 1) out[i] = dv.getFloat32(i * 4, true);
    channels[name] = out;
    offset += bytes;
  }
  return { dims, bounds, voxelSizeM, channels };
};

const buildSceneTransform = (dims: Vec3, bounds: { min: Vec3; max: Vec3 } | null, voxelSizeM: Vec3): SceneTransform => {
  const minM: Vec3 = bounds
    ? [...bounds.min]
    : [-(dims[0] - 1) * voxelSizeM[0] * 0.5, -(dims[1] - 1) * voxelSizeM[1] * 0.5, -(dims[2] - 1) * voxelSizeM[2] * 0.5];
  const maxM: Vec3 = bounds
    ? [...bounds.max]
    : [(dims[0] - 1) * voxelSizeM[0] * 0.5, (dims[1] - 1) * voxelSizeM[1] * 0.5, (dims[2] - 1) * voxelSizeM[2] * 0.5];
  const spanM: Vec3 = [maxM[0] - minM[0], maxM[1] - minM[1], maxM[2] - minM[2]];
  const centerM: Vec3 = [(minM[0] + maxM[0]) * 0.5, (minM[1] + maxM[1]) * 0.5, (minM[2] + maxM[2]) * 0.5];
  const uniformScaleM = Math.max(spanM[0], spanM[1], spanM[2]) * 0.5 || 1;
  return { minM, maxM, spanM, centerM, uniformScaleM };
};

const gridToMeters = (x: number, y: number, z: number, dims: Vec3, xf: SceneTransform): Vec3 => [
  xf.minM[0] + gridFrac(x, dims[0]) * xf.spanM[0],
  xf.minM[1] + gridFrac(y, dims[1]) * xf.spanM[1],
  xf.minM[2] + gridFrac(z, dims[2]) * xf.spanM[2],
];

const metersToScene = (m: Vec3, xf: SceneTransform): Vec3 => [
  (m[0] - xf.centerM[0]) / xf.uniformScaleM,
  (m[1] - xf.centerM[1]) / xf.uniformScaleM,
  (m[2] - xf.centerM[2]) / xf.uniformScaleM,
];

const metersToGrid = (m: Vec3, dims: Vec3, xf: SceneTransform): Vec3 => {
  const fx = clamp01((m[0] - xf.minM[0]) / Math.max(1e-9, xf.spanM[0])) * (dims[0] - 1);
  const fy = clamp01((m[1] - xf.minM[1]) / Math.max(1e-9, xf.spanM[1])) * (dims[1] - 1);
  const fz = clamp01((m[2] - xf.minM[2]) / Math.max(1e-9, xf.spanM[2])) * (dims[2] - 1);
  return [fx, fy, fz];
};

const sampleNearest = (data: Float32Array, dims: Vec3, gx: number, gy: number, gz: number): number => {
  const x = Math.max(0, Math.min(dims[0] - 1, Math.round(gx)));
  const y = Math.max(0, Math.min(dims[1] - 1, Math.round(gy)));
  const z = Math.max(0, Math.min(dims[2] - 1, Math.round(gz)));
  return data[idx3(x, y, z, dims)] ?? 0;
};

const quantileAbs = (values: Float32Array, q: number, mask?: (i: number) => boolean): number => {
  const list: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    if (mask && !mask(i)) continue;
    const v = Math.abs(values[i] ?? 0);
    if (v > 0 && Number.isFinite(v)) list.push(v);
  }
  if (list.length <= 0) return 1;
  list.sort((a, b) => a - b);
  const at = Math.floor((list.length - 1) * clamp01(q));
  return list[Math.max(0, Math.min(list.length - 1, at))] ?? 1;
};

const buildGridLines = (dims: Vec3, xf: SceneTransform): Vec3[][] => {
  const lines: Vec3[][] = [];
  const sampleAxisLine = (axis: 0 | 1 | 2, a: number, b: number): Vec3[] => {
    const out: Vec3[] = [];
    for (let s = 0; s < GRID_SAMPLES_PER_LINE; s += 1) {
      const t = s / Math.max(1, GRID_SAMPLES_PER_LINE - 1);
      let gx = 0;
      let gy = 0;
      let gz = 0;
      if (axis === 0) {
        gx = t * (dims[0] - 1);
        gy = a * (dims[1] - 1);
        gz = b * (dims[2] - 1);
      } else if (axis === 1) {
        gx = a * (dims[0] - 1);
        gy = t * (dims[1] - 1);
        gz = b * (dims[2] - 1);
      } else {
        gx = a * (dims[0] - 1);
        gy = b * (dims[1] - 1);
        gz = t * (dims[2] - 1);
      }
      out.push(gridToMeters(gx, gy, gz, dims, xf));
    }
    return out;
  };

  for (let iy = 0; iy < GRID_Y_LINES; iy += 1) {
    for (let iz = 0; iz < GRID_Z_LINES; iz += 1) {
      lines.push(sampleAxisLine(0, iy / Math.max(1, GRID_Y_LINES - 1), iz / Math.max(1, GRID_Z_LINES - 1)));
    }
  }
  for (let ix = 0; ix < GRID_X_LINES; ix += 1) {
    for (let iz = 0; iz < GRID_Z_LINES; iz += 1) {
      lines.push(sampleAxisLine(1, ix / Math.max(1, GRID_X_LINES - 1), iz / Math.max(1, GRID_Z_LINES - 1)));
    }
  }
  for (let ix = 0; ix < GRID_X_LINES; ix += 1) {
    for (let iy = 0; iy < GRID_Y_LINES; iy += 1) {
      lines.push(sampleAxisLine(2, ix / Math.max(1, GRID_X_LINES - 1), iy / Math.max(1, GRID_Y_LINES - 1)));
    }
  }
  return lines;
};

const deformGridLines = (
  linesM: Vec3[][],
  dims: Vec3,
  xf: SceneTransform,
  betaX: Float32Array,
  betaY: Float32Array,
  betaZ: Float32Array,
  alpha: Float32Array,
  hullSdf: Float32Array,
  betaScale: number,
  alphaScale: number,
): GridLine[] => {
  const out: GridLine[] = [];
  for (const line of linesM) {
    const points: Vec3[] = [];
    const masks: boolean[] = [];
    for (const pM of line) {
      const g = metersToGrid(pM, dims, xf);
      const b: Vec3 = [
        sampleNearest(betaX, dims, g[0], g[1], g[2]),
        sampleNearest(betaY, dims, g[0], g[1], g[2]),
        sampleNearest(betaZ, dims, g[0], g[1], g[2]),
      ];
      const a = sampleNearest(alpha, dims, g[0], g[1], g[2]);
      const sdf = sampleNearest(hullSdf, dims, g[0], g[1], g[2]);
      const wShell = Math.exp(-Math.pow(Math.abs(sdf) / Math.max(1e-6, SHELL_DECAY_M), 2));
      const bDir = norm(b);
      const bMag = Math.hypot(b[0], b[1], b[2]) / Math.max(MIN_MAG, betaScale);
      const aTerm = Math.abs(1 - a) / Math.max(MIN_MAG, alphaScale);
      const pScene = metersToScene(pM, xf);
      const radial = norm(pScene);
      const disp = add(
        mul(bDir, DEFORM_SCENE_SCALE * wShell * Math.min(1.5, bMag)),
        mul(radial, RADIAL_SCENE_SCALE * wShell * Math.min(1.2, aTerm)),
      );
      points.push(add(pScene, disp));
      masks.push(sdf < 0);
    }
    out.push({ points, masks });
  }
  return out;
};

const rotatePoint = (p: Vec3, yawRad: number): Vec3 => {
  const cy = Math.cos(-yawRad);
  const sy = Math.sin(-yawRad);
  const cx = Math.cos(-TILT_RAD);
  const sx = Math.sin(-TILT_RAD);
  const y1 = p[1] * cx - p[2] * sx;
  const z1 = p[1] * sx + p[2] * cx;
  const x2 = p[0] * cy + z1 * sy;
  const z2 = -p[0] * sy + z1 * cy;
  return [x2, y1, z2];
};

const clearPng = (dir: string): void => {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) if (entry.toLowerCase().endsWith(".png")) fs.unlinkSync(path.join(dir, entry));
};

const blendPixel = (rgba: Uint8Array, bi: number, zbuf: Float32Array, zi: number, z: number, style: RenderStyle): void => {
  if (z >= zbuf[zi]) return;
  zbuf[zi] = z;
  const a = style.alpha;
  rgba[bi] = Math.round(rgba[bi] * (1 - a) + style.color.r * a);
  rgba[bi + 1] = Math.round(rgba[bi + 1] * (1 - a) + style.color.g * a);
  rgba[bi + 2] = Math.round(rgba[bi + 2] * (1 - a) + style.color.b * a);
  rgba[bi + 3] = 255;
};

const drawLine = (
  rgba: Uint8Array,
  zbuf: Float32Array,
  p0: Vec3,
  p1: Vec3,
  style: RenderStyle,
): void => {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const x = Math.round(lerp(p0[0], p1[0], t));
    const y = Math.round(lerp(p0[1], p1[1], t));
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) continue;
    const z = lerp(p0[2], p1[2], t);
    const zi = y * WIDTH + x;
    const bi = zi * 4;
    blendPixel(rgba, bi, zbuf, zi, z, style);
  }
};

const drawThetaPoint = (
  rgba: Uint8Array,
  zbuf: Float32Array,
  x: number,
  y: number,
  z: number,
  color: { r: number; g: number; b: number },
  alpha: number,
): void => {
  const put = (px: number, py: number, scale = 1): void => {
    if (px < 0 || px >= WIDTH || py < 0 || py >= HEIGHT) return;
    const zi = py * WIDTH + px;
    const bi = zi * 4;
    blendPixel(rgba, bi, zbuf, zi, z + scale * 1e-5, {
      color,
      alpha: alpha * (scale === 1 ? 1 : 0.65),
    });
  };
  put(x, y, 1);
  put(x - 1, y, 0.8);
  put(x + 1, y, 0.8);
  put(x, y - 1, 0.8);
  put(x, y + 1, 0.8);
};

const project = (p: Vec3): Vec3 | null => {
  const z = p[2] + CAMERA_DISTANCE;
  if (z <= 0.2) return null;
  return [WIDTH * 0.5 + (p[0] / z) * FOCAL_PX, HEIGHT * 0.5 - (p[1] / z) * FOCAL_PX, z];
};

const renderGridFrame = async (
  outPath: string,
  lines: GridLine[],
  thetaPoints: ThetaPoint[],
  thetaScale: number,
  layer: LayerId,
  yaw: number,
): Promise<void> => {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
  const zbuf = new Float32Array(WIDTH * HEIGHT);
  for (let i = 0; i < zbuf.length; i += 1) {
    zbuf[i] = Number.POSITIVE_INFINITY;
    const bi = i * 4;
    rgba[bi] = 10;
    rgba[bi + 1] = 13;
    rgba[bi + 2] = 22;
    rgba[bi + 3] = 255;
  }

  const insideStyle: RenderStyle = {
    color: { r: 252, g: 183, b: 73 },
    alpha: layer === "outside_only" ? 0 : 0.62,
  };
  const outsideStyle: RenderStyle = {
    color: { r: 116, g: 197, b: 255 },
    alpha: layer === "inside_only" ? 0 : 0.56,
  };
  const refStyle: RenderStyle = { color: { r: 190, g: 210, b: 220 }, alpha: 0.17 };

  for (const line of lines) {
    for (let i = 0; i < line.points.length - 1; i += 1) {
      const a = rotatePoint(line.points[i]!, yaw);
      const b = rotatePoint(line.points[i + 1]!, yaw);
      const pa = project(a);
      const pb = project(b);
      if (!pa || !pb) continue;
      const inMask = line.masks[i] && line.masks[i + 1];
      const outMask = !line.masks[i] && !line.masks[i + 1];
      if (inMask) drawLine(rgba, zbuf, pa, pb, insideStyle);
      else if (outMask) drawLine(rgba, zbuf, pa, pb, outsideStyle);
      else drawLine(rgba, zbuf, pa, pb, layer === "inside_only" ? insideStyle : outsideStyle);
    }
  }

  if (layer === "combined") {
    for (const line of lines) {
      for (let i = 0; i < line.points.length - 1; i += 8) {
        const a = rotatePoint(line.points[i]!, yaw);
        const b = rotatePoint(line.points[i + 1]!, yaw);
        const pa = project(a);
        const pb = project(b);
        if (!pa || !pb) continue;
        drawLine(rgba, zbuf, pa, pb, refStyle);
      }
    }
  }

  if (layer === "combined_theta_evidence") {
    for (const tp of thetaPoints) {
      const p = rotatePoint(tp.p, yaw);
      const pp = project(p);
      if (!pp) continue;
      const mag = Math.abs(tp.theta) / Math.max(MIN_MAG, thetaScale);
      if (mag <= 0.025) continue;
      const alpha = Math.max(0.16, Math.min(0.85, 0.2 + 0.55 * Math.pow(Math.min(1, mag), 0.65)));
      const color =
        tp.theta >= 0
          ? tp.inHull
            ? { r: 255, g: 138, b: 122 }
            : { r: 255, g: 171, b: 90 }
          : tp.inHull
            ? { r: 95, g: 189, b: 255 }
            : { r: 71, g: 221, b: 198 };
      drawThetaPoint(rgba, zbuf, Math.round(pp[0]), Math.round(pp[1]), pp[2], color, alpha);
    }
  }

  await sharp(rgba, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toFile(outPath);
};

const encode = (framesDir: string, outBase: string): { gif: string; mp4: string } => {
  const gif = `${outBase}.gif`;
  const mp4 = `${outBase}.mp4`;
  const palette = path.join(framesDir, "palette.png");
  execFileSync(
    "ffmpeg",
    ["-y", "-framerate", "16", "-i", path.join(framesDir, "frame_%03d.png"), "-vf", "palettegen=stats_mode=full", palette],
    { stdio: "ignore" },
  );
  execFileSync(
    "ffmpeg",
    ["-y", "-framerate", "16", "-i", path.join(framesDir, "frame_%03d.png"), "-i", palette, "-lavfi", "paletteuse=dither=bayer:bayer_scale=4", gif],
    { stdio: "ignore" },
  );
  execFileSync(
    "ffmpeg",
    ["-y", "-framerate", "16", "-i", path.join(framesDir, "frame_%03d.png"), "-vf", "format=yuv420p", "-c:v", "libx264", "-movflags", "+faststart", mp4],
    { stdio: "ignore" },
  );
  return { gif, mp4 };
};

const run = async (): Promise<void> => {
  ensureDir(OUTPUT_DIR);
  ensureDir(TMP_DIR);
  const brick = decodeBrick(fs.readFileSync(INPUT_PATH));
  const { dims, bounds, voxelSizeM, channels } = brick;
  const alpha = channels.alpha;
  const betaX = channels.beta_x;
  const betaY = channels.beta_y;
  const betaZ = channels.beta_z;
  const hullSdf = channels.hull_sdf;
  const theta = channels.theta;
  if (!alpha || !betaX || !betaY || !betaZ || !hullSdf || !theta) {
    throw new Error("required_channels_missing:alpha,beta_x,beta_y,beta_z,hull_sdf,theta");
  }

  const sceneTransform = buildSceneTransform(dims, bounds, voxelSizeM);
  const betaMag = new Float32Array(betaX.length);
  for (let i = 0; i < betaMag.length; i += 1) {
    betaMag[i] = Math.hypot(betaX[i] ?? 0, betaY[i] ?? 0, betaZ[i] ?? 0);
  }
  const betaScale = quantileAbs(betaMag, 0.99, (i) => Math.abs(hullSdf[i] ?? 1e9) <= 80);
  const alphaDev = new Float32Array(alpha.length);
  for (let i = 0; i < alphaDev.length; i += 1) alphaDev[i] = Math.abs(1 - (alpha[i] ?? 1));
  const alphaScale = quantileAbs(alphaDev, 0.99, (i) => Math.abs(hullSdf[i] ?? 1e9) <= 80);
  const thetaScale = quantileAbs(theta, 0.995, (i) => Math.abs(hullSdf[i] ?? 1e9) <= THETA_SHELL_MAX_M);
  const thetaThreshold = Math.max(MIN_MAG, quantileAbs(theta, 0.98, (i) => Math.abs(hullSdf[i] ?? 1e9) <= THETA_SHELL_MAX_M));

  const baseGridLines = buildGridLines(dims, sceneTransform);
  const deformed = deformGridLines(baseGridLines, dims, sceneTransform, betaX, betaY, betaZ, alpha, hullSdf, betaScale, alphaScale);
  const thetaPoints: ThetaPoint[] = [];
  for (let z = 0; z < dims[2]; z += 1) {
    for (let y = 0; y < dims[1]; y += 1) {
      for (let x = 0; x < dims[0]; x += 1) {
        const i = idx3(x, y, z, dims);
        const t = theta[i] ?? 0;
        const s = hullSdf[i] ?? 1e9;
        if (Math.abs(s) > THETA_SHELL_MAX_M) continue;
        if (Math.abs(t) < thetaThreshold) continue;
        thetaPoints.push({
          p: metersToScene(gridToMeters(x, y, z, dims, sceneTransform), sceneTransform),
          theta: t,
          inHull: s < 0,
        });
      }
    }
  }

  const outputs: Record<LayerId, { gif: string; mp4: string; framesDir: string }> = {
    inside_only: { gif: "", mp4: "", framesDir: "" },
    outside_only: { gif: "", mp4: "", framesDir: "" },
    combined: { gif: "", mp4: "", framesDir: "" },
    combined_theta_evidence: { gif: "", mp4: "", framesDir: "" },
  };

  for (const layer of ["inside_only", "outside_only", "combined", "combined_theta_evidence"] as const) {
    const tag =
      layer === "inside_only"
        ? "sgi"
        : layer === "outside_only"
          ? "sgo"
          : layer === "combined"
            ? "sgc"
            : "sgt";
    const framesDir = path.join(TMP_DIR, `${ASSET_PREFIX}_${tag}`);
    ensureDir(framesDir);
    clearPng(framesDir);
    for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
      const yaw = (frame / FRAME_COUNT) * Math.PI * 2;
      await renderGridFrame(
        path.join(framesDir, `frame_${String(frame).padStart(3, "0")}.png`),
        deformed,
        thetaPoints,
        thetaScale,
        layer,
        yaw,
      );
    }
    const outBase = path.join(OUTPUT_DIR, `${ASSET_PREFIX}-${layer}`);
    const enc = encode(framesDir, outBase);
    outputs[layer] = { gif: enc.gif, mp4: enc.mp4, framesDir };
  }

  const metadataPath = path.join(OUTPUT_DIR, `${ASSET_PREFIX}-metadata.json`);
  const metadata = {
    artifactType: "nhm2_spacetime_grid_overlay/v1",
    generatedOn: new Date().toISOString(),
    axisConvention: "x_ship_y_port_z_zenith",
    input: INPUT_PATH,
    grid: { dims, bounds, voxelSizeM },
    sceneTransform: {
      centerM: sceneTransform.centerM,
      uniformScaleM: sceneTransform.uniformScaleM,
      note: "Grid points are sampled in physical brick bounds (meters) then mapped with uniform global scale for camera framing.",
    },
    method: {
      baseGrid: {
        xLines: GRID_X_LINES,
        yLines: GRID_Y_LINES,
        zLines: GRID_Z_LINES,
        samplesPerLine: GRID_SAMPLES_PER_LINE,
      },
      deformation: {
        drivers: ["beta_x", "beta_y", "beta_z", "alpha", "hull_sdf"],
        shellDecayM: SHELL_DECAY_M,
        betaScaleQ99: betaScale,
        alphaScaleQ99: alphaScale,
        sceneDisplacementScale: DEFORM_SCENE_SCALE,
        radialSupplementScale: RADIAL_SCENE_SCALE,
        uncertaintyNote:
          "This is a solve-derived visualization map from 3+1 fields to display geometry; it is not a direct detector observable and not a unique physical embedding of full 4D spacetime.",
      },
      thetaEvidenceOverlay: {
        sourceChannel: "theta",
        shellMaxM: THETA_SHELL_MAX_M,
        thresholdAbs: thetaThreshold,
        scaleQ995: thetaScale,
        selectedPointCount: thetaPoints.length,
        signMeaning: "positive=local expansion tendency, negative=local contraction tendency in the chosen 3+1 slicing convention",
      },
      camera: {
        frameCount: FRAME_COUNT,
        tiltRad: TILT_RAD,
        cameraDistance: CAMERA_DISTANCE,
        focalPx: FOCAL_PX,
        width: WIDTH,
        height: HEIGHT,
      },
    },
    outputs,
  };
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, metadataPath, outputs }, null, 2)}\n`);
};

run().catch((err) => {
  process.stderr.write(`${String(err instanceof Error ? err.message : err)}\n`);
  process.exitCode = 1;
});
