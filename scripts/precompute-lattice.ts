#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BufferGeometry, Group, Matrix4 } from "three";
import { applyHullBasisToDims, resolveHullBasis } from "@shared/hull-basis";
import type { BasisTransform, HullPreviewIndexedGeometry, HullPreviewLOD, HullPreviewPayload } from "@shared/schema";
import { VIEWER_WIREFRAME_BUDGETS } from "@/lib/resolve-wireframe-overlay";
import { HULL_DIM_MAX_M } from "@/lib/hull-guardrails";
import { buildLatticeFrame, type LatticeProfileTag, type LatticeQualityPreset } from "@/lib/lattice-frame";
import { buildHullDistanceGrid } from "@/lib/lattice-sdf";
import { resolveHullSurfaceMesh } from "@/lib/resolve-wireframe-overlay";
import { voxelizeHullSurfaceStrobe } from "@/lib/lattice-surface";
import { hashLatticeSdfDeterminism, hashLatticeVolumeDeterminism } from "@/lib/lattice-health";
import { buildLatticeTextureExports } from "@/lib/lattice-export";
import { sha256Hex } from "@/utils/sha";
import { hashSignature, normalizeBasisForSignature } from "@/lib/card-signatures";
import type { HullLatticeState } from "@/store/useHull3DSharedStore";
import { PROMOTED_WARP_PROFILE } from "@shared/warp-promoted-profile";

type CliOptions = {
  input: string | null;
  outDir: string;
  profile: LatticeProfileTag;
  preset: LatticeQualityPreset;
  boundsProfile: "tight" | "wide";
  sectorCount: number;
  maxTriangles: number;
  maxExtent: number;
  band?: number;
  decimateTarget?: number;
  basis?: BasisTransform | null;
  scale?: [number, number, number] | null;
};

type Bounds = { min: [number, number, number]; max: [number, number, number]; size: [number, number, number]; center: [number, number, number] };

type IndexedGeometryBuild = {
  positions: Float32Array;
  indices: Uint32Array;
  normals?: Float32Array;
  bounds: Bounds | null;
  triangleCount: number;
  vertexCount: number;
  byteLength: number;
};

// Minimal DOM stubs so GLTFLoader can run under Node without a real browser.
const ensureDomStubs = () => {
  const g = globalThis as any;
  if (typeof g.document === "undefined") {
    g.document = {
      createElementNS: () => ({ getContext: () => null }),
      createElement: () => ({ getContext: () => null }),
    };
  }
  if (typeof g.createImageBitmap !== "function") {
    g.createImageBitmap = async () => {
      // Avoid throwing so parser can continue when textures are present.
      return { width: 1, height: 1 };
    };
  }
  if (typeof g.Image === "undefined") {
    g.Image = class {};
  }
};

const usage = () => {
  console.log(`
Usage: tsx scripts/precompute-lattice.ts <glb> [options]

Options:
  --out <dir>           Output directory (default: data/precomputed-lattice)
  --profile <tag>       Lattice profile tag: preview | card (default: preview)
  --preset <name>       Quality preset: auto | low | medium | high | card (default: medium)
  --bounds <name>       Bounds profile: tight | wide (default: tight)
  --sectors <n>         Sector count for surface bucketing (default: 400)
  --max-tris <n>        Hard triangle limit before rejection (default: 250000)
  --max-extent <m>      Hard extent limit in meters (default: ${HULL_DIM_MAX_M})
  --band <m>            Optional explicit SDF band (meters)
  --decimate <n>        Target triangle count after decimation (default: viewer budget)
  --basis <json>        Basis transform JSON string
  --scale <x,y,z>       Optional extra uniform scale vector applied to the basis
  --help                Show this help text
`);
};

const parseNumberVec3 = (raw?: string | null): [number, number, number] | null => {
  if (!raw) return null;
  const parts = raw.split(",").map((v) => Number(v.trim()));
  if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) return null;
  return [parts[0], parts[1], parts[2]];
};

const parseBasis = (raw?: string | null): BasisTransform | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed as BasisTransform;
  } catch {
    return null;
  }
};

function parseArgs(argv: string[]): CliOptions {
  const opts: Partial<CliOptions> = {
    input: null,
    outDir: path.join(process.cwd(), "data", "precomputed-lattice"),
    profile: "preview",
    preset: "medium",
    boundsProfile: "tight",
    sectorCount: PROMOTED_WARP_PROFILE.sectorCount,
    maxTriangles: 250_000,
    maxExtent: HULL_DIM_MAX_M,
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [rawKey, rawVal] = token.slice(2).split("=", 2);
    const key = rawKey.toLowerCase();
    const val = rawVal ?? argv[i + 1];
    const consume = rawVal === undefined;
    switch (key) {
      case "out":
        opts.outDir = val ? path.resolve(val) : opts.outDir;
        if (consume && rawVal === undefined) i++;
        break;
      case "profile":
        opts.profile = (val as LatticeProfileTag) ?? opts.profile;
        if (consume) i++;
        break;
      case "preset":
        opts.preset = (val as LatticeQualityPreset) ?? opts.preset;
        if (consume) i++;
        break;
      case "bounds":
        opts.boundsProfile = (val as CliOptions["boundsProfile"]) ?? opts.boundsProfile;
        if (consume) i++;
        break;
      case "sectors":
        opts.sectorCount = val ? Math.max(1, Math.floor(Number(val))) : opts.sectorCount;
        if (consume) i++;
        break;
      case "max-tris":
        opts.maxTriangles = val ? Math.max(1, Math.floor(Number(val))) : opts.maxTriangles;
        if (consume) i++;
        break;
      case "max-extent":
        opts.maxExtent = val ? Math.max(1, Number(val)) : opts.maxExtent;
        if (consume) i++;
        break;
      case "band":
        opts.band = val && Number.isFinite(Number(val)) ? Number(val) : undefined;
        if (consume) i++;
        break;
      case "decimate":
        opts.decimateTarget = val ? Math.max(1, Math.floor(Number(val))) : undefined;
        if (consume) i++;
        break;
      case "basis":
        opts.basis = parseBasis(val);
        if (consume) i++;
        break;
      case "scale":
        opts.scale = parseNumberVec3(val);
        if (consume) i++;
        break;
      case "help":
        usage();
        process.exit(0);
        break;
      default:
        console.warn(`[precompute-lattice] Unknown option --${rawKey}, ignoring`);
    }
  }

  const VALID_PROFILES: LatticeProfileTag[] = ["preview", "card"];
  const VALID_PRESETS: LatticeQualityPreset[] = ["auto", "low", "medium", "high", "card"];
  const VALID_BOUNDS: Array<CliOptions["boundsProfile"]> = ["tight", "wide"];
  if (!VALID_PROFILES.includes(opts.profile as LatticeProfileTag)) opts.profile = "preview";
  if (!VALID_PRESETS.includes(opts.preset as LatticeQualityPreset)) opts.preset = "medium";
  if (!VALID_BOUNDS.includes(opts.boundsProfile as CliOptions["boundsProfile"])) opts.boundsProfile = "tight";

  opts.input = positional[0] ?? null;
  return opts as CliOptions;
}

const computeBoundsFromPositions = (positions: Float32Array): Bounds | null => {
  if (!positions || positions.length < 3) return null;
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  if (!Number.isFinite(min[0]) || !Number.isFinite(max[0])) return null;
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const center: [number, number, number] = [
    (max[0] + min[0]) * 0.5,
    (max[1] + min[1]) * 0.5,
    (max[2] + min[2]) * 0.5,
  ];
  return { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]], size, center };
};

const mergeSceneGeometry = (root: Group | null): IndexedGeometryBuild | null => {
  if (!root) return null;
  const geometries: BufferGeometry[] = [];
  const world = new Matrix4();
  root.updateMatrixWorld(true);
  root.traverse((node: any) => {
    if (!node?.isMesh || !node.geometry) return;
    const geom = (node.geometry as BufferGeometry).clone();
    node.updateWorldMatrix?.(true, true);
    world.copy(node.matrixWorld);
    geom.applyMatrix4(world);
    geometries.push(geom);
  });
  if (!geometries.length) return null;
  const merged = BufferGeometryUtils.mergeGeometries(geometries, true);
  geometries.forEach((g) => g.dispose?.());
  if (!merged) return null;
  const withIndex = merged.index ? merged : merged.toNonIndexed();
  if (!withIndex.getIndex()) {
    const posAttr = withIndex.getAttribute("position");
    if (posAttr) {
      const idx = Array.from({ length: posAttr.count }, (_, i) => i);
      withIndex.setIndex(idx);
    }
  }
  const deduped = BufferGeometryUtils.mergeVertices(withIndex, 1e-4) ?? withIndex;
  const positionAttr = deduped.getAttribute("position");
  if (!positionAttr) return null;
  const positions = new Float32Array(positionAttr.array as ArrayLike<number>);
  const indexAttr = deduped.getIndex();
  let indices: Uint32Array;
  if (indexAttr?.array) {
    const arr = indexAttr.array as ArrayLike<number>;
    indices = arr instanceof Uint32Array ? new Uint32Array(arr) : new Uint32Array(Array.from(arr, (v) => Number(v) ?? 0));
  } else {
    const vertCount = positionAttr.count;
    indices = new Uint32Array(vertCount);
    for (let i = 0; i < vertCount; i++) indices[i] = i;
  }
  const normalAttr = deduped.getAttribute("normal");
  const normals = normalAttr ? new Float32Array(normalAttr.array as ArrayLike<number>) : undefined;
  const bounds = computeBoundsFromPositions(positions);
  const triangleCount = Math.floor(indices.length / 3);
  const vertexCount = positionAttr.count;
  const byteLength = positions.byteLength + indices.byteLength + (normals?.byteLength ?? 0);
  deduped.dispose();
  if (withIndex !== deduped) withIndex.dispose?.();
  if (merged !== deduped && merged !== withIndex) merged.dispose?.();
  return { positions, indices, normals, bounds, triangleCount, vertexCount, byteLength };
};

const decimateIndexedGeometry = (
  geometry: IndexedGeometryBuild,
  targetTris: number,
): { geometry: IndexedGeometryBuild; decimation: NonNullable<HullPreviewLOD["decimation"]> } => {
  const triCount = Math.floor(geometry.indices.length / 3);
  const safeTarget = Math.max(1, Math.min(targetTris, triCount || targetTris));
  if (triCount <= safeTarget) {
    return {
      geometry,
      decimation: {
        targetTris: safeTarget,
        achievedTris: triCount,
        targetRatio: triCount > 0 ? safeTarget / triCount : undefined,
        method: "passthrough",
      },
    };
  }

  const stride = Math.max(1, Math.floor(triCount / safeTarget));
  const remap = new Map<number, number>();
  const outPositions: number[] = [];
  const outNormals: number[] | undefined = geometry.normals ? [] : undefined;
  const outIndices: number[] = [];
  const addVertex = (idx: number) => {
    let next = remap.get(idx);
    if (next === undefined) {
      next = remap.size;
      remap.set(idx, next);
      const base = idx * 3;
      outPositions.push(
        geometry.positions[base] ?? 0,
        geometry.positions[base + 1] ?? 0,
        geometry.positions[base + 2] ?? 0,
      );
      if (outNormals) {
        outNormals.push(
          geometry.normals?.[base] ?? 0,
          geometry.normals?.[base + 1] ?? 0,
          geometry.normals?.[base + 2] ?? 0,
        );
      }
    }
    outIndices.push(next);
  };

  for (let tri = 0; tri < triCount; tri += stride) {
    const base = tri * 3;
    addVertex(geometry.indices[base] ?? 0);
    addVertex(geometry.indices[base + 1] ?? 0);
    addVertex(geometry.indices[base + 2] ?? 0);
    if (outIndices.length / 3 >= safeTarget * 1.05) break;
  }

  if (outIndices.length < 3) {
    return {
      geometry,
      decimation: {
        targetTris: safeTarget,
        achievedTris: triCount,
        targetRatio: triCount > 0 ? safeTarget / triCount : undefined,
        method: "passthrough",
      },
    };
  }

  const positions = new Float32Array(outPositions);
  const indices = new Uint32Array(outIndices);
  const normals = outNormals ? new Float32Array(outNormals) : undefined;
  const bounds = computeBoundsFromPositions(positions);
  const achievedTris = Math.floor(indices.length / 3);
  const vertexCount = Math.floor(positions.length / 3);
  const byteLength = positions.byteLength + indices.byteLength + (normals?.byteLength ?? 0);
  return {
    geometry: { positions, indices, normals, bounds, triangleCount: achievedTris, vertexCount, byteLength },
    decimation: {
      targetTris: safeTarget,
      achievedTris,
      targetRatio: triCount > 0 ? safeTarget / triCount : undefined,
      method: "stride-sample",
    },
  };
};

const serializeIndexedGeometry = (geometry: IndexedGeometryBuild): HullPreviewIndexedGeometry => ({
  positions: Array.from(geometry.positions),
  indices: Array.from(geometry.indices),
  normals: geometry.normals ? Array.from(geometry.normals) : undefined,
  bounds: geometry.bounds
    ? { min: geometry.bounds.min, max: geometry.bounds.max }
    : undefined,
  boundingBox: geometry.bounds
    ? { min: geometry.bounds.min, max: geometry.bounds.max }
    : undefined,
  vertexCount: geometry.vertexCount,
  triangleCount: geometry.triangleCount,
  byteLength: geometry.byteLength,
});

const buildMeshHash = async (geometry: IndexedGeometryBuild, extras: number[] = []) => {
  const parts: Uint8Array[] = [
    new Uint8Array(geometry.positions.buffer),
    new Uint8Array(geometry.indices.buffer),
  ];
  if (geometry.normals) parts.push(new Uint8Array(geometry.normals.buffer));
  if (extras.length) {
    const extraBuf = new Float64Array(extras);
    parts.push(new Uint8Array(extraBuf.buffer));
  }
  const total = parts.reduce((sum, arr) => sum + arr.byteLength, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const arr of parts) {
    combined.set(arr, offset);
    offset += arr.byteLength;
  }
  return sha256Hex(combined);
};

const buildValidationReasons = (geometry: IndexedGeometryBuild, opts: CliOptions): string[] => {
  const reasons: string[] = [];
  if (!geometry.bounds) {
    reasons.push("glb:missingBounds");
    return reasons;
  }
  if (geometry.triangleCount <= 0) {
    reasons.push("glb:noTriangles");
  }
  if (geometry.triangleCount > opts.maxTriangles) {
    reasons.push(`glb:triangles>${opts.maxTriangles}`);
  }
  const size = geometry.bounds.size;
  const maxExtent = Math.max(Math.abs(size[0]), Math.abs(size[1]), Math.abs(size[2]));
  if (!Number.isFinite(maxExtent) || maxExtent <= 0) {
    reasons.push("glb:zeroExtent");
  } else if (maxExtent > opts.maxExtent) {
    reasons.push(`glb:extent>${opts.maxExtent}`);
  }
  let nonFinite = 0;
  for (let i = 0; i + 2 < geometry.positions.length; i += 3) {
    if (!Number.isFinite(geometry.positions[i]) || !Number.isFinite(geometry.positions[i + 1]) || !Number.isFinite(geometry.positions[i + 2])) {
      nonFinite += 1;
      if (nonFinite > 32) break;
    }
  }
  if (nonFinite > 0) reasons.push("glb:nonFiniteVertices");
  return reasons;
};

async function loadMergedGeometry(glbPath: string): Promise<IndexedGeometryBuild | null> {
  ensureDomStubs();
  const loader = new GLTFLoader();
  const arrayBuf = await fs.readFile(glbPath);
  const glb = await loader.parseAsync(arrayBuf.buffer.slice(arrayBuf.byteOffset, arrayBuf.byteOffset + arrayBuf.byteLength), path.dirname(glbPath) + "/");
  const merged = mergeSceneGeometry(glb.scene as Group);
  return merged;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.input) {
    usage();
    process.exitCode = 1;
    return;
  }

  const glbPath = path.resolve(opts.input);
  const exists = await fs.access(glbPath).then(() => true).catch(() => false);
  if (!exists) {
    console.error(`[precompute-lattice] GLB not found at ${glbPath}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[precompute-lattice] Loading ${glbPath}`);
  const merged = await loadMergedGeometry(glbPath);
  if (!merged) {
    console.error("[precompute-lattice] Failed to merge GLB geometry");
    process.exitCode = 1;
    return;
  }

  const validation = buildValidationReasons(merged, opts);
  if (validation.length) {
    console.error("[precompute-lattice] Validation failed:", validation.join(", "));
    process.exitCode = 1;
    return;
  }

  const targetTris =
    opts.decimateTarget ??
    Math.min(
      VIEWER_WIREFRAME_BUDGETS.maxPreviewTriangles,
      Math.max(4000, Math.floor(merged.triangleCount * 0.25)),
    );

  const { geometry: decimated, decimation } = decimateIndexedGeometry(merged, targetTris);
  const basisResolved = resolveHullBasis(opts.basis ?? undefined, opts.scale ?? undefined);
  const basisSignature = await hashSignature(normalizeBasisForSignature(basisResolved));
  const meshHash = await buildMeshHash(decimated, [
    ...(opts.scale ?? []),
    decimation.targetTris,
    decimation.achievedTris,
  ]);

  const dims = decimated.bounds?.size ?? [1, 1, 1];
  const obbCenter = decimated.bounds?.center ?? [0, 0, 0];
  const hullDims = applyHullBasisToDims(
    { Lx_m: Math.abs(dims[0]), Ly_m: Math.abs(dims[1]), Lz_m: Math.abs(dims[2]) },
    basisResolved,
  );

  const lodCoarse: HullPreviewLOD = {
    tag: "coarse",
    meshHash,
    triangleCount: decimated.triangleCount,
    vertexCount: decimated.vertexCount,
    byteLength: decimated.byteLength,
    indexedGeometry: serializeIndexedGeometry(decimated),
    decimation,
    fitBounds: decimated.bounds ? { min: decimated.bounds.min, max: decimated.bounds.max } : undefined,
  };
  const lodFull: HullPreviewLOD = {
    tag: "full",
    glbUrl: glbPath,
    meshHash,
    triangleCount: merged.triangleCount,
    vertexCount: merged.vertexCount,
    byteLength: merged.byteLength,
    fitBounds: merged.bounds ? { min: merged.bounds.min, max: merged.bounds.max } : undefined,
  };

  const payload: HullPreviewPayload = {
    version: "v1",
    glbUrl: glbPath,
    meshHash,
    basis: opts.basis ?? undefined,
    scale: opts.scale ?? undefined,
    targetDims: hullDims,
    hullMetrics: {
      dims_m: hullDims,
      area_m2: Math.abs(hullDims.Lx_m * hullDims.Ly_m * hullDims.Lz_m) ** (2 / 3),
      triangleCount: decimated.triangleCount,
      vertexCount: decimated.vertexCount,
      method: "OBB_PCA",
    },
    obb: {
      center: obbCenter,
      halfSize: [hullDims.Lx_m / 2, hullDims.Ly_m / 2, hullDims.Lz_m / 2],
      axes: [basisResolved.right, basisResolved.up, basisResolved.forward],
    },
    provenance: "preview",
    clampReasons: [],
    mesh: {
      glbUrl: glbPath,
      meshHash,
      basis: opts.basis ?? undefined,
      obb: {
        center: obbCenter,
        halfSize: [hullDims.Lx_m / 2, hullDims.Ly_m / 2, hullDims.Lz_m / 2],
        axes: [basisResolved.right, basisResolved.up, basisResolved.forward],
      },
      lods: [lodCoarse, lodFull],
      coarseLod: lodCoarse,
      fullLod: lodFull,
      provenance: "preview",
      clampReasons: [],
    },
    lods: [lodCoarse, lodFull],
    lodCoarse,
    lodFull,
    updatedAt: Date.now(),
  };

  const frame = buildLatticeFrame({
    hullDims,
    basis: basisResolved,
    boundsProfile: opts.boundsProfile,
    preset: opts.preset,
    profileTag: opts.profile,
    centerWorld: obbCenter,
  });

  const surface = resolveHullSurfaceMesh(payload, { lod: "preview", totalSectors: opts.sectorCount });
  const surfaceClampReasons = surface.clampReasons ?? [];
  if (!surface.surface) {
    console.error("[precompute-lattice] Surface resolution failed:", surfaceClampReasons.join(", "));
    process.exitCode = 1;
    return;
  }

  const sdfResult = await buildHullDistanceGrid({
    payload,
    frame,
    band: opts.band,
    surface: { lod: "preview", totalSectors: opts.sectorCount },
    surfaceResolved: surface,
    maxSamples: Math.max(250_000, frame.voxelCount),
  });

  const volumeResult = voxelizeHullSurfaceStrobe({
    frame,
    surface: surface.surface,
    sectorWeights: new Float32Array(Math.max(1, surface.surface.sectorCount)).fill(1),
    gateScale: 1,
    driveScale: 1,
    driveLadder: { R: 1, sigma: 6, beta: 0.2, gate: 1, ampChain: 1 },
    shellThickness: frame.voxelSize_m * 0.75,
    sampleBudget: Math.min(frame.voxelCount * 6, 9_000_000),
    surfaceHash: surface.surface.key,
    weightsHash: "uniform",
    dfdrSignature: "dfdr:uniform",
  });

  const rejection: string[] = [];
  rejection.push(...surfaceClampReasons);
  rejection.push(...sdfResult.clampReasons);
  rejection.push(...(volumeResult.clampReasons ?? []));

  if (!sdfResult.grid) rejection.push("sdf:missing");
  if (!volumeResult.volume) rejection.push("volume:missing");

  const latticeState: HullLatticeState = {
    frame,
    preset: frame.preset,
    profileTag: frame.profileTag,
    updatedAt: Date.now(),
    strobe: null,
    sdf: sdfResult.grid ?? null,
    volume: volumeResult.volume ?? null,
  };

  const sdfDeterminism = sdfResult.grid
    ? await hashLatticeSdfDeterminism(sdfResult.grid, { sampleCount: 256, quantScale: 1e5 })
    : null;
  const volumeDeterminism = volumeResult.volume
    ? await hashLatticeVolumeDeterminism(volumeResult.volume, { sampleCount: 256, quantScale: 1e5 })
    : null;

  const fileStem = `${meshHash.slice(0, 8)}-${basisSignature.slice(0, 8)}-${frame.profileTag}-${frame.preset}`;
  const outDir = path.join(opts.outDir, `${meshHash}_${basisSignature}`);
  await fs.mkdir(outDir, { recursive: true });

  const latticeExports = await buildLatticeTextureExports({ fileStem, lattice: latticeState });
  const assets: Array<{ filename: string; data: Uint8Array }> = [];
  if (latticeExports?.blobs) {
    for (const blob of latticeExports.blobs) {
      const arrayBuffer = await blob.blob.arrayBuffer();
      assets.push({ filename: blob.filename, data: new Uint8Array(arrayBuffer) });
    }
  }
  for (const asset of assets) {
    const target = path.join(outDir, asset.filename);
    await fs.writeFile(target, asset.data);
  }

  const meta = {
    glbPath,
    meshHash,
    basisSignature,
    decimation,
    validation,
    rejectionReasons: Array.from(new Set(rejection)),
    frame,
    surface: {
      hash: surface.surface.key,
      clampReasons: surfaceClampReasons,
      triangleCount: surface.surface.triangleCount,
      vertexCount: surface.surface.vertexCount,
      sectorCount: surface.surface.sectorCount,
      handedness: surface.surface.handedness,
    },
    sdf: sdfResult.grid
      ? {
          key: sdfResult.grid.key,
          band_m: sdfResult.grid.band,
          stats: sdfResult.grid.stats,
          determinismHash: sdfDeterminism,
          clampReasons: sdfResult.grid.clampReasons,
        }
      : null,
    volume: volumeResult.volume
      ? {
          hash: volumeResult.volume.hash,
          stats: volumeResult.volume.stats,
          determinismHash: volumeDeterminism,
          clampReasons: volumeResult.volume.clampReasons,
        }
      : null,
    latticeMeta: latticeExports?.meta ?? null,
    assets: latticeExports?.assets ?? null,
    updatedAt: new Date().toISOString(),
  };

  const metaPath = path.join(outDir, `${fileStem}.metadata.json`);
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  if (rejection.length) {
    console.warn("[precompute-lattice] Completed with rejection reasons:", meta.rejectionReasons.join(", "));
  } else {
    console.log("[precompute-lattice] Success");
  }
  console.log(`[precompute-lattice] Wrote metadata to ${metaPath}`);
  if (assets.length) {
    console.log(`[precompute-lattice] Wrote ${assets.length} binary asset(s) to ${outDir}`);
  }
}

void main();
