import path from "node:path";
import { createReadStream, promises as fs } from "node:fs";
import {
  getNoisegenPaths,
  getNoisegenStore,
  isReplitStoragePath,
  isStorageLocator,
  resolveOriginalAssetPath,
  resolvePlaybackAssetPath,
  resolveStemAssetPath,
  resolveStemGroupAssetPath,
  updateNoisegenStore,
  type NoisegenOriginal,
  type NoisegenOriginalAsset,
  type NoisegenPlaybackAsset,
  type NoisegenStemAsset,
  type NoisegenStemGroupAsset,
} from "../server/services/noisegen-store";
import { putBlob } from "../server/storage";

type MigrationStats = {
  originals: number;
  assets: number;
  analysis: number;
  skipped: number;
  missing: number;
};

const isPersistentPath = (value?: string): boolean =>
  Boolean(value && (isReplitStoragePath(value) || isStorageLocator(value)));

const shouldMigratePath = (value?: string): boolean => {
  if (!value) return false;
  if (isPersistentPath(value)) return false;
  return !path.isAbsolute(value);
};

const resolveAnalysisPath = (analysisPath: string): string => {
  if (path.isAbsolute(analysisPath)) return analysisPath;
  const { baseDir } = getNoisegenPaths();
  return path.join(baseDir, analysisPath);
};

const uploadFile = async (
  filePath: string,
  contentType: string,
): Promise<{ uri: string; bytes: number }> => {
  const record = await putBlob(createReadStream(filePath), { contentType });
  return { uri: record.uri, bytes: record.bytes };
};

const migrateAsset = async <
  T extends
    | NoisegenOriginalAsset
    | NoisegenStemAsset
    | NoisegenPlaybackAsset
    | NoisegenStemGroupAsset,
>(
  asset: T | undefined,
  resolvePath: (value: T) => string,
  stats: MigrationStats,
): Promise<T | undefined> => {
  if (!asset || !shouldMigratePath(asset.path)) {
    if (asset) stats.skipped += 1;
    return asset;
  }
  const filePath = resolvePath(asset);
  try {
    await fs.access(filePath);
  } catch {
    stats.missing += 1;
    return asset;
  }
  const record = await uploadFile(filePath, asset.mime);
  stats.assets += 1;
  return {
    ...asset,
    path: record.uri,
    bytes: record.bytes,
  };
};

const migrateAnalysisPath = async (
  analysisPath: string | undefined,
  stats: MigrationStats,
): Promise<string | undefined> => {
  if (!analysisPath || !shouldMigratePath(analysisPath)) {
    if (analysisPath) stats.skipped += 1;
    return analysisPath;
  }
  const filePath = resolveAnalysisPath(analysisPath);
  try {
    await fs.access(filePath);
  } catch {
    stats.missing += 1;
    return analysisPath;
  }
  const record = await uploadFile(filePath, "application/json");
  stats.analysis += 1;
  return record.uri;
};

const migrateOriginal = async (
  original: NoisegenOriginal,
  stats: MigrationStats,
): Promise<NoisegenOriginal> => {
  const next: NoisegenOriginal = { ...original, assets: { ...original.assets } };
  stats.originals += 1;

  next.assets.instrumental = await migrateAsset(
    next.assets.instrumental,
    resolveOriginalAssetPath,
    stats,
  );
  if (next.assets.instrumental?.analysisPath) {
    next.assets.instrumental.analysisPath = await migrateAnalysisPath(
      next.assets.instrumental.analysisPath,
      stats,
    );
  }

  next.assets.vocal = await migrateAsset(
    next.assets.vocal,
    resolveOriginalAssetPath,
    stats,
  );
  if (next.assets.vocal?.analysisPath) {
    next.assets.vocal.analysisPath = await migrateAnalysisPath(
      next.assets.vocal.analysisPath,
      stats,
    );
  }

  if (next.assets.stems && next.assets.stems.length > 0) {
    const migratedStems: NoisegenStemAsset[] = [];
    for (const stem of next.assets.stems) {
      const migrated = await migrateAsset(stem, resolveStemAssetPath, stats);
      if (migrated?.analysisPath) {
        migrated.analysisPath = await migrateAnalysisPath(
          migrated.analysisPath,
          stats,
        );
      }
      if (migrated) migratedStems.push(migrated);
    }
    next.assets.stems = migratedStems;
  }

  if (next.assets.playback && next.assets.playback.length > 0) {
    const migratedPlayback: NoisegenPlaybackAsset[] = [];
    for (const playback of next.assets.playback) {
      const migrated = await migrateAsset(
        playback,
        resolvePlaybackAssetPath,
        stats,
      );
      if (migrated) migratedPlayback.push(migrated);
    }
    next.assets.playback = migratedPlayback;
  }

  if (next.assets.stemGroups && next.assets.stemGroups.length > 0) {
    const migratedGroups: NoisegenStemGroupAsset[] = [];
    for (const group of next.assets.stemGroups) {
      const migrated = await migrateAsset(
        group,
        resolveStemGroupAssetPath,
        stats,
      );
      if (migrated) migratedGroups.push(migrated);
    }
    next.assets.stemGroups = migratedGroups;
  }

  return next;
};

const cloneStore = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function main() {
  const store = await getNoisegenStore();
  const next = cloneStore(store);
  const stats: MigrationStats = {
    originals: 0,
    assets: 0,
    analysis: 0,
    skipped: 0,
    missing: 0,
  };

  next.originals = await Promise.all(
    next.originals.map((original) => migrateOriginal(original, stats)),
  );
  next.pendingOriginals = await Promise.all(
    next.pendingOriginals.map((original) => migrateOriginal(original, stats)),
  );

  await updateNoisegenStore(() => next);

  console.log("Noisegen storage migration complete.");
  console.log(
    JSON.stringify(
      {
        originals: stats.originals,
        assetsMigrated: stats.assets,
        analysisMigrated: stats.analysis,
        skipped: stats.skipped,
        missing: stats.missing,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
