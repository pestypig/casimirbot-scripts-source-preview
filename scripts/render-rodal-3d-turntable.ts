import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  decodeBinaryBrick,
  hashFloat32,
  loadBrickBytes,
  sha256Hex,
  validateChannelConsistency,
  type DecodedChannel,
  type Vec3,
} from "./rendering/scientific-3p1/brick-io.js";
import {
  buildHullIsoMesh,
  buildRicciIsoMesh,
  buildSceneTransform,
  selectIsoBand,
  type Triangle,
} from "./rendering/scientific-3p1/mesh.js";
import { DEFAULT_CAMERA, renderLayerFrame } from "./rendering/scientific-3p1/rasterizer.js";

type LayerId = "ricci_only" | "shell_only" | "combined";

const ROOT = process.cwd();
const DATE_STAMP = new Date().toISOString().slice(0, 10);
const RAW_INPUT_PATH = path.join(ROOT, "artifacts", "research", "full-solve", "triage-brick-48.raw");
const WRAPPED_INPUT_PATH = path.join(ROOT, "artifacts", "research", "full-solve", "user-york-brick-latest.json");
const OUTPUT_DIR = path.join(ROOT, "artifacts", "research", "full-solve", "rendered", "scientific_3p1_field", DATE_STAMP);
const TMP_DIR = path.join(OUTPUT_DIR, "tmp");
const ASSET_PREFIX = "nhm2_ricci4_nat3d_iso";
const AXIS_CONVENTION = "x_ship_y_port_z_zenith";
const FRAME_COUNT = 48;
const WIDTH = 640;
const HEIGHT = 640;
const SHELL_BAND_MIN_M = 0;
const SHELL_BAND_MAX_M = 80;
const SHELL_CONTOUR_M = 5;
const EPS = 1e-45;

async function run(): Promise<void> {
  ensureDir(OUTPUT_DIR);
  ensureDir(TMP_DIR);

  const inputPath = fs.existsSync(RAW_INPUT_PATH) ? RAW_INPUT_PATH : WRAPPED_INPUT_PATH;
  const bytes = loadBrickBytes(RAW_INPUT_PATH, WRAPPED_INPUT_PATH);
  const brick = decodeBinaryBrick(bytes);
  const { dims, origin, spacing } = validateChannelConsistency(brick);
  const ricci4 = requiredChannel(brick.channels.get("ricci4"), "ricci4");
  const hullSdf = requiredChannel(brick.channels.get("hull_sdf"), "hull_sdf");

  const ricciAbs = new Float32Array(ricci4.values.length);
  for (let i = 0; i < ricciAbs.length; i += 1) ricciAbs[i] = Math.abs(ricci4.values[i] ?? 0);
  const isoLevels = selectIsoBand(ricciAbs, 7);
  const isoLow = isoLevels[0] ?? 0;
  const isoHigh = isoLevels[isoLevels.length - 1] ?? 1;
  const sceneTransform = buildSceneTransform(dims, origin, spacing, { preservePhysicalAxes: true });

  const ricciMesh = buildRicciIsoMesh(dims, sceneTransform, ricciAbs, hullSdf.values, {
    levels: isoLevels,
    shellBandMinM: SHELL_BAND_MIN_M,
    shellBandMaxM: SHELL_BAND_MAX_M,
  });
  const hullMesh = buildHullIsoMesh(dims, sceneTransform, hullSdf.values);
  const meshLayers: Record<LayerId, Triangle[]> = {
    ricci_only: ricciMesh,
    shell_only: hullMesh,
    combined: [...hullMesh, ...ricciMesh],
  };
  const camera = { ...DEFAULT_CAMERA, width: WIDTH, height: HEIGHT };

  const outputs: Record<
    LayerId,
    { gif: string; mp4: string; framesDir: string; xzSlice: string; yzSlice: string; triangleCount: number }
  > = {
    ricci_only: { gif: "", mp4: "", framesDir: "", xzSlice: "", yzSlice: "", triangleCount: meshLayers.ricci_only.length },
    shell_only: { gif: "", mp4: "", framesDir: "", xzSlice: "", yzSlice: "", triangleCount: meshLayers.shell_only.length },
    combined: { gif: "", mp4: "", framesDir: "", xzSlice: "", yzSlice: "", triangleCount: meshLayers.combined.length },
  };

  for (const layer of ["ricci_only", "shell_only", "combined"] as const) {
    const layerTag = layer === "ricci_only" ? "r" : layer === "shell_only" ? "s" : "c";
    const framesDir = path.join(TMP_DIR, `n4iso_${layerTag}`);
    ensureDir(framesDir);
    clearDirPng(framesDir);

    for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
      const yaw = (frame / FRAME_COUNT) * Math.PI * 2;
      await renderLayerFrame(path.join(framesDir, `frame_${String(frame).padStart(3, "0")}.png`), meshLayers[layer], yaw, camera);
    }

    const outBase = path.join(OUTPUT_DIR, `${ASSET_PREFIX}-${layer}`);
    const turntable = encodeTurntable(framesDir, outBase);
    const xzSlice = path.join(OUTPUT_DIR, `${ASSET_PREFIX}-${layer}-xz_slice.png`);
    const yzSlice = path.join(OUTPUT_DIR, `${ASSET_PREFIX}-${layer}-yz_slice.png`);
    await writeSliceImage(xzSlice, layer, "xz", dims, ricciAbs, hullSdf.values, isoLow, isoHigh);
    await writeSliceImage(yzSlice, layer, "yz", dims, ricciAbs, hullSdf.values, isoLow, isoHigh);
    outputs[layer] = {
      gif: turntable.gif,
      mp4: turntable.mp4,
      framesDir,
      xzSlice,
      yzSlice,
      triangleCount: meshLayers[layer].length,
    };
  }

  const metadataPath = path.join(OUTPUT_DIR, `${ASSET_PREFIX}-metadata.json`);
  const metadata = {
    artifactType: "nhm2_ricci4_natario_turntable_iso_surface/v3",
    generatedOn: new Date().toISOString(),
    axisConvention: AXIS_CONVENTION,
    method: {
      isoExtractor: "marching_tetrahedra",
      isoLevels,
      interpolation: "linear_edge_interpolation",
      renderer: "software_triangle_rasterizer",
    },
    camera: {
      frameCount: FRAME_COUNT,
      tiltRad: camera.tiltRad,
      cameraDistance: camera.cameraDistance,
      focalPx: camera.focalPx,
      width: WIDTH,
      height: HEIGHT,
    },
    input: {
      path: inputPath,
      sha256: sha256Hex(bytes),
    },
    grid: { dims, origin, spacing },
    sceneTransform: {
      centerM: sceneTransform.center,
      uniformScaleM: 1 / sceneTransform.scale,
      note: "Vertices are mapped from physical brick bounds (meters) then uniformly scaled for camera framing.",
    },
    channels: {
      ricci4: {
        hash: hashFloat32(ricci4.values),
        headerMin: ricci4.headerMin,
        headerMax: ricci4.headerMax,
        decodedMin: ricci4.decodedMin,
        decodedMax: ricci4.decodedMax,
      },
      hull_sdf: {
        hash: hashFloat32(hullSdf.values),
        headerMin: hullSdf.headerMin,
        headerMax: hullSdf.headerMax,
        decodedMin: hullSdf.decodedMin,
        decodedMax: hullSdf.decodedMax,
      },
    },
    isoBand: {
      lowQuantile: 0.72,
      highQuantile: 0.975,
      low: isoLow,
      high: isoHigh,
      levels: isoLevels.length,
      shellBandMinM: SHELL_BAND_MIN_M,
      shellBandMaxM: SHELL_BAND_MAX_M,
      shellContourM: SHELL_CONTOUR_M,
    },
    outputs,
  };
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, inputPath, metadataPath, isoBand: metadata.isoBand, method: metadata.method, outputs }, null, 2)}\n`);
}

function requiredChannel(channel: DecodedChannel | undefined, name: string): DecodedChannel {
  if (!channel) throw new Error(`required_channel_missing:${name}`);
  return channel;
}

function encodeTurntable(framesDir: string, outBase: string): { gif: string; mp4: string } {
  const gifPath = `${outBase}.gif`;
  const mp4Path = `${outBase}.mp4`;
  const palettePath = path.join(framesDir, "palette.png");
  execFileSync("ffmpeg", ["-y", "-framerate", "16", "-i", path.join(framesDir, "frame_%03d.png"), "-vf", "palettegen=stats_mode=full", palettePath], { stdio: "ignore" });
  execFileSync("ffmpeg", ["-y", "-framerate", "16", "-i", path.join(framesDir, "frame_%03d.png"), "-i", palettePath, "-lavfi", "paletteuse=dither=bayer:bayer_scale=5", gifPath], { stdio: "ignore" });
  execFileSync("ffmpeg", ["-y", "-framerate", "16", "-i", path.join(framesDir, "frame_%03d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4Path], { stdio: "ignore" });
  return { gif: gifPath, mp4: mp4Path };
}

async function writeSliceImage(
  outPath: string,
  layer: LayerId,
  axis: "xz" | "yz",
  dims: Vec3,
  ricciAbs: Float32Array,
  hullSdf: Float32Array,
  isoLow: number,
  isoHigh: number,
): Promise<void> {
  const [nx, ny, nz] = dims;
  const width = axis === "xz" ? nx : ny;
  const height = nz;
  const yMid = Math.floor(ny * 0.5);
  const xMid = Math.floor(nx * 0.5);
  const rgba = new Uint8Array(width * height * 4);

  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 8;
    rgba[i + 1] = 12;
    rgba[i + 2] = 22;
    rgba[i + 3] = 255;
  }

  for (let iz = 0; iz < nz; iz += 1) {
    for (let iu = 0; iu < width; iu += 1) {
      const x = axis === "xz" ? iu : xMid;
      const y = axis === "xz" ? yMid : iu;
      const index = x + nx * (y + ny * iz);
      const absRicci = ricciAbs[index] ?? 0;
      const absSdf = Math.abs(hullSdf[index] ?? Number.POSITIVE_INFINITY);
      const inShellBand = absSdf >= SHELL_BAND_MIN_M && absSdf <= SHELL_BAND_MAX_M;
      const inIsoBand = absRicci >= isoLow && absRicci <= isoHigh;
      const dst = ((height - 1 - iz) * width + iu) * 4;
      if ((layer === "ricci_only" || layer === "combined") && inShellBand && inIsoBand) {
        const logNum = Math.log(Math.max(absRicci, EPS) / Math.max(isoLow, EPS));
        const logDen = Math.max(1e-9, Math.log(Math.max(isoHigh, EPS) / Math.max(isoLow, EPS)));
        const color = sliceColormap(clamp01(logNum / logDen));
        rgba[dst] = color[0];
        rgba[dst + 1] = color[1];
        rgba[dst + 2] = color[2];
      }
      if ((layer === "shell_only" || layer === "combined") && absSdf <= SHELL_CONTOUR_M) {
        const alpha = layer === "combined" ? 0.35 : 1;
        rgba[dst] = Math.round(rgba[dst] * (1 - alpha) + 188 * alpha);
        rgba[dst + 1] = Math.round(rgba[dst + 1] * (1 - alpha) + 228 * alpha);
        rgba[dst + 2] = Math.round(rgba[dst + 2] * (1 - alpha) + 252 * alpha);
      }
    }
  }

  await sharp(rgba, { raw: { width, height, channels: 4 } })
    .resize({ width: 720, height: 360, kernel: sharp.kernel.nearest })
    .png()
    .toFile(outPath);
}

function sliceColormap(t: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0, [33, 58, 186]],
    [0.23, [19, 149, 202]],
    [0.45, [133, 209, 106]],
    [0.62, [250, 224, 92]],
    [0.78, [246, 143, 45]],
    [1, [216, 39, 39]],
  ];
  for (let i = 0; i < stops.length - 1; i += 1) {
    const [aT, aC] = stops[i];
    const [bT, bC] = stops[i + 1];
    if (t >= aT && t <= bT) {
      const u = (t - aT) / (bT - aT);
      return [
        Math.round(aC[0] + u * (bC[0] - aC[0])),
        Math.round(aC[1] + u * (bC[1] - aC[1])),
        Math.round(aC[2] + u * (bC[2] - aC[2])),
      ];
    }
  }
  return [216, 39, 39];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function clearDirPng(dirPath: string): void {
  for (const file of fs.readdirSync(dirPath)) {
    if (file.endsWith(".png")) fs.unlinkSync(path.join(dirPath, file));
  }
}

run().catch((error) => {
  process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 1;
});
