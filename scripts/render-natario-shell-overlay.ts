import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

type Vec3 = [number, number, number];
type VertexSample = { p: Vec3; f: number; sdf: number };
type Triangle = {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  color: { r: number; g: number; b: number };
  alpha: number;
};
type SceneTransform = {
  minM: Vec3;
  spanM: Vec3;
  centerM: Vec3;
  uniformScaleM: number;
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
const TMP_DIR = path.join(OUTPUT_DIR, "tmp", "natario_shell_overlay");
const ASSET_PREFIX = "nhm2_signed_shell_overlay_natario_style";

const WIDTH = 640;
const HEIGHT = 640;
const FRAME_COUNT = 48;
const TILT_RAD = (24 * Math.PI) / 180;
const CAMERA_DISTANCE = 3.2;
const FOCAL_PX = 470;
const SHELL_MIN_M = 0;
const SHELL_MAX_M = 80;
const EPS = 1e-45;

const TETS: number[][] = [
  [0, 5, 1, 6],
  [0, 5, 6, 4],
  [0, 2, 6, 1],
  [0, 2, 3, 6],
  [0, 7, 4, 6],
  [0, 3, 7, 6],
];
const CORNERS: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

const ensureDir = (p: string): void => fs.mkdirSync(p, { recursive: true });
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const lerpVec3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] * (1 - t) + b[0] * t,
  a[1] * (1 - t) + b[1] * t,
  a[2] * (1 - t) + b[2] * t,
];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  if (l <= 1e-12) return [0, 0, 0];
  return [a[0] / l, a[1] / l, a[2] / l];
};

const idx3 = (x: number, y: number, z: number, dims: Vec3): number => x + dims[0] * (y + dims[1] * z);

type DecodedBrick = {
  dims: Vec3;
  bounds: { min: Vec3; max: Vec3 } | null;
  voxelSizeM: Vec3;
  channels: Record<string, Float32Array>;
};

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
    const floats = new Float32Array(bytes / 4);
    const dv = new DataView(fileBytes.buffer, fileBytes.byteOffset + offset, bytes);
    for (let i = 0; i < floats.length; i += 1) floats[i] = dv.getFloat32(i * 4, true);
    channels[name] = floats;
    offset += bytes;
  }
  return { dims, bounds, voxelSizeM, channels };
};
const gridFrac = (i: number, n: number): number => (n <= 1 ? 0 : i / (n - 1));
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
  return { minM, spanM, centerM, uniformScaleM };
};
const gridToScene = (x: number, y: number, z: number, dims: Vec3, xf: SceneTransform): Vec3 => {
  const mx = xf.minM[0] + gridFrac(x, dims[0]) * xf.spanM[0];
  const my = xf.minM[1] + gridFrac(y, dims[1]) * xf.spanM[1];
  const mz = xf.minM[2] + gridFrac(z, dims[2]) * xf.spanM[2];
  return [
    (mx - xf.centerM[0]) / xf.uniformScaleM,
    (my - xf.centerM[1]) / xf.uniformScaleM,
    (mz - xf.centerM[2]) / xf.uniformScaleM,
  ];
};

const quantileAbs = (values: Float32Array, q: number, mask?: (idx: number) => boolean): number => {
  const sample: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    if (mask && !mask(i)) continue;
    const v = Math.abs(values[i] ?? 0);
    if (v > 0 && Number.isFinite(v)) sample.push(v);
  }
  if (sample.length === 0) return 1;
  sample.sort((a, b) => a - b);
  const idx = Math.floor((sample.length - 1) * clamp01(q));
  return sample[Math.max(0, Math.min(sample.length - 1, idx))] ?? 1;
};

const buildTetTriangles = (
  v: [VertexSample, VertexSample, VertexSample, VertexSample],
  iso: number,
): Array<{ p: Vec3[]; sdfAvg: number }> => {
  const inside = [v[0].f >= iso, v[1].f >= iso, v[2].f >= iso, v[3].f >= iso];
  const insideIds = [0, 1, 2, 3].filter((i) => inside[i]);
  const outsideIds = [0, 1, 2, 3].filter((i) => !inside[i]);
  const count = insideIds.length;
  if (count === 0 || count === 4) return [];
  const edgePoint = (i: number, j: number): { p: Vec3; sdf: number } => {
    const vi = v[i];
    const vj = v[j];
    const denom = vj.f - vi.f;
    const t = Math.abs(denom) < 1e-16 ? 0.5 : (iso - vi.f) / denom;
    const tc = clamp01(t);
    return { p: lerpVec3(vi.p, vj.p, tc), sdf: vi.sdf * (1 - tc) + vj.sdf * tc };
  };
  if (count === 1 || count === 3) {
    const pivot = count === 1 ? insideIds[0] : outsideIds[0];
    const others = count === 1 ? outsideIds : insideIds;
    const p0 = edgePoint(pivot, others[0]);
    const p1 = edgePoint(pivot, others[1]);
    const p2 = edgePoint(pivot, others[2]);
    const tri = count === 1 ? [p0.p, p1.p, p2.p] : [p0.p, p2.p, p1.p];
    return [{ p: tri, sdfAvg: (p0.sdf + p1.sdf + p2.sdf) / 3 }];
  }
  const [i0, i1] = insideIds;
  const [o0, o1] = outsideIds;
  const p0 = edgePoint(i0, o0);
  const p1 = edgePoint(i0, o1);
  const p2 = edgePoint(i1, o0);
  const p3 = edgePoint(i1, o1);
  return [
    { p: [p0.p, p1.p, p2.p], sdfAvg: (p0.sdf + p1.sdf + p2.sdf) / 3 },
    { p: [p1.p, p3.p, p2.p], sdfAvg: (p1.sdf + p3.sdf + p2.sdf) / 3 },
  ];
};

const signedColor = (positive: boolean, t: number): { r: number; g: number; b: number } => {
  const u = clamp01(t);
  if (positive) {
    return {
      r: Math.round(235 * (0.6 + 0.4 * u)),
      g: Math.round(170 * (0.5 + 0.5 * u)),
      b: Math.round(70 * (0.4 + 0.2 * u)),
    };
  }
  return {
    r: Math.round(60 * (0.4 + 0.2 * u)),
    g: Math.round(140 * (0.5 + 0.4 * u)),
    b: Math.round(240 * (0.6 + 0.4 * u)),
  };
};

const buildSignedShellMesh = (
  dims: Vec3,
  sceneTransform: SceneTransform,
  signedField: Float32Array,
  hullSdf: Float32Array,
  ampRef: number,
  levelScale = 1,
): { triangles: Triangle[]; levels: number[] } => {
  const levels = [0.14, 0.24, 0.36, 0.5, 0.66].map((u) => ampRef * levelScale * u);
  const triangles: Triangle[] = [];
  const [nx, ny, nz] = dims;

  const levelDefs = [
    ...levels.map((v, i) => ({ iso: v, positive: true, t: i / Math.max(1, levels.length - 1) })),
    ...levels.map((v, i) => ({ iso: -v, positive: false, t: i / Math.max(1, levels.length - 1) })),
  ];

  for (const ld of levelDefs) {
    const color = signedColor(ld.positive, ld.t);
    for (let z = 0; z < nz - 1; z += 1) {
      for (let y = 0; y < ny - 1; y += 1) {
        for (let x = 0; x < nx - 1; x += 1) {
          const cube: VertexSample[] = new Array(8);
          for (let c = 0; c < 8; c += 1) {
            const cx = x + CORNERS[c][0];
            const cy = y + CORNERS[c][1];
            const cz = z + CORNERS[c][2];
            const id = idx3(cx, cy, cz, dims);
            cube[c] = {
              p: gridToScene(cx, cy, cz, dims, sceneTransform),
              f: signedField[id] ?? 0,
              sdf: Math.abs(hullSdf[id] ?? Number.POSITIVE_INFINITY),
            };
          }
          for (const tet of TETS) {
            const tt = buildTetTriangles(
              [cube[tet[0]], cube[tet[1]], cube[tet[2]], cube[tet[3]]],
              ld.iso,
            );
            for (const tri of tt) {
              if (tri.sdfAvg < SHELL_MIN_M || tri.sdfAvg > SHELL_MAX_M) continue;
              triangles.push({
                a: tri.p[0],
                b: tri.p[1],
                c: tri.p[2],
                color,
                alpha: 0.74,
              });
            }
          }
        }
      }
    }
  }
  return { triangles, levels };
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

const renderFrameTransparent = async (outPath: string, triangles: Triangle[], yawRad: number): Promise<void> => {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
  const zbuf = new Float32Array(WIDTH * HEIGHT);
  for (let i = 0; i < zbuf.length; i += 1) zbuf[i] = Number.POSITIVE_INFINITY;
  const light = norm([0.3, 0.5, 1]);
  const edge = (ax: number, ay: number, bx: number, by: number, px: number, py: number): number =>
    (px - ax) * (by - ay) - (py - ay) * (bx - ax);

  for (const tri of triangles) {
    const pa = rotatePoint(tri.a, yawRad);
    const pb = rotatePoint(tri.b, yawRad);
    const pc = rotatePoint(tri.c, yawRad);
    const za = pa[2] + CAMERA_DISTANCE;
    const zb = pb[2] + CAMERA_DISTANCE;
    const zc = pc[2] + CAMERA_DISTANCE;
    if (za <= 0.2 || zb <= 0.2 || zc <= 0.2) continue;
    const sa: Vec3 = [WIDTH * 0.5 + (pa[0] / za) * FOCAL_PX, HEIGHT * 0.5 - (pa[1] / za) * FOCAL_PX, za];
    const sb: Vec3 = [WIDTH * 0.5 + (pb[0] / zb) * FOCAL_PX, HEIGHT * 0.5 - (pb[1] / zb) * FOCAL_PX, zb];
    const sc: Vec3 = [WIDTH * 0.5 + (pc[0] / zc) * FOCAL_PX, HEIGHT * 0.5 - (pc[1] / zc) * FOCAL_PX, zc];
    const area = edge(sa[0], sa[1], sb[0], sb[1], sc[0], sc[1]);
    if (Math.abs(area) < 1e-6) continue;
    const camN = norm(cross(sub(pb, pa), sub(pc, pa)));
    if (dot(camN, [0, 0, 1]) <= 0) continue;
    const shade = 0.28 + 0.72 * Math.max(0, dot(camN, light));
    const cr = Math.round(tri.color.r * shade);
    const cg = Math.round(tri.color.g * shade);
    const cb = Math.round(tri.color.b * shade);
    const minX = Math.max(0, Math.floor(Math.min(sa[0], sb[0], sc[0])));
    const maxX = Math.min(WIDTH - 1, Math.ceil(Math.max(sa[0], sb[0], sc[0])));
    const minY = Math.max(0, Math.floor(Math.min(sa[1], sb[1], sc[1])));
    const maxY = Math.min(HEIGHT - 1, Math.ceil(Math.max(sa[1], sb[1], sc[1])));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = edge(sb[0], sb[1], sc[0], sc[1], px, py) / area;
        const w1 = edge(sc[0], sc[1], sa[0], sa[1], px, py) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * sa[2] + w1 * sb[2] + w2 * sc[2];
        const idx = y * WIDTH + x;
        if (z >= zbuf[idx]) continue;
        zbuf[idx] = z;
        const bi = idx * 4;
        rgba[bi] = cr;
        rgba[bi + 1] = cg;
        rgba[bi + 2] = cb;
        rgba[bi + 3] = Math.round(255 * tri.alpha);
      }
    }
  }
  await sharp(rgba, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toFile(outPath);
};

const clearPng = (dir: string): void => {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) if (entry.toLowerCase().endsWith(".png")) fs.unlinkSync(path.join(dir, entry));
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
    [
      "-y",
      "-framerate",
      "16",
      "-i",
      path.join(framesDir, "frame_%03d.png"),
      "-i",
      palette,
      "-lavfi",
      "paletteuse=dither=bayer:bayer_scale=4",
      gif,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-framerate",
      "16",
      "-i",
      path.join(framesDir, "frame_%03d.png"),
      "-vf",
      "format=yuv420p",
      "-c:v",
      "libx264",
      "-movflags",
      "+faststart",
      mp4,
    ],
    { stdio: "ignore" },
  );
  return { gif, mp4 };
};

const run = async (): Promise<void> => {
  ensureDir(OUTPUT_DIR);
  ensureDir(TMP_DIR);
  clearPng(TMP_DIR);

  const brick = decodeBrick(fs.readFileSync(INPUT_PATH));
  const hullSdf = brick.channels.hull_sdf;
  if (!hullSdf) throw new Error("missing_channel:hull_sdf");
  const sceneTransform = buildSceneTransform(brick.dims, brick.bounds, brick.voxelSizeM);

  const candidateChannels = ["ricci4", "M_constraint_x", "beta_x"];
  let fieldId = "";
  let signedField: Float32Array | null = null;
  let amplitude = 0;
  for (const id of candidateChannels) {
    const ch = brick.channels[id];
    if (!ch) continue;
    const amp = quantileAbs(ch, 0.95, (i) => {
      const s = Math.abs(hullSdf[i] ?? Number.POSITIVE_INFINITY);
      return s >= SHELL_MIN_M && s <= SHELL_MAX_M;
    });
    if (amp > amplitude) {
      amplitude = amp;
      fieldId = id;
      signedField = ch;
    }
  }
  if (!signedField || amplitude <= EPS) throw new Error("no_viable_signed_shell_channel");

  let mesh = buildSignedShellMesh(brick.dims, sceneTransform, signedField, hullSdf, amplitude, 1);
  if (mesh.triangles.length === 0) mesh = buildSignedShellMesh(brick.dims, sceneTransform, signedField, hullSdf, amplitude, 0.6);
  if (mesh.triangles.length === 0) mesh = buildSignedShellMesh(brick.dims, sceneTransform, signedField, hullSdf, amplitude, 0.35);
  if (mesh.triangles.length === 0) throw new Error("overlay_mesh_empty");

  for (let f = 0; f < FRAME_COUNT; f += 1) {
    const yaw = (f / FRAME_COUNT) * Math.PI * 2;
    await renderFrameTransparent(path.join(TMP_DIR, `frame_${String(f).padStart(3, "0")}.png`), mesh.triangles, yaw);
  }
  const outBase = path.join(OUTPUT_DIR, ASSET_PREFIX);
  const video = encode(TMP_DIR, outBase);

  const metaPath = path.join(OUTPUT_DIR, `${ASSET_PREFIX}-metadata.json`);
  const meta = {
    artifactType: "nhm2_signed_shell_overlay/v1",
    generatedOn: new Date().toISOString(),
    axisConvention: "x_ship_y_port_z_zenith",
    input: INPUT_PATH,
    shellBandM: [SHELL_MIN_M, SHELL_MAX_M],
    grid: {
      dims: brick.dims,
      bounds: brick.bounds,
      voxelSizeM: brick.voxelSizeM,
    },
    sceneTransform: {
      centerM: sceneTransform.centerM,
      uniformScaleM: sceneTransform.uniformScaleM,
      note: "Vertices are mapped from physical brick bounds (meters) then uniformly scaled for camera framing.",
    },
    signedFieldChannel: fieldId,
    signedFieldAbsQ95: amplitude,
    isoLevelsPositive: mesh.levels,
    isoLevelsNegative: mesh.levels.map((v) => -v),
    triangleCount: mesh.triangles.length,
    outputs: {
      gif: video.gif,
      mp4: video.mp4,
      framesDir: TMP_DIR,
    },
  };
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, ...meta }, null, 2)}\n`);
};

run().catch((err) => {
  process.stderr.write(`${String(err instanceof Error ? err.message : err)}\n`);
  process.exitCode = 1;
});
