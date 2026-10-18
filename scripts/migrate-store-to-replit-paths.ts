import { promises as fs } from "node:fs";
import path from "node:path";

const NOISEGEN_STORAGE_PREFIX = "noisegen/originals";

interface StoreAsset {
  kind?: string;
  fileName: string;
  path: string;
  mime: string;
  bytes: number;
  uploadedAt: number;
}

interface StoreStem {
  id: string;
  name: string;
  category?: string;
  fileName: string;
  path: string;
  mime: string;
  bytes: number;
  uploadedAt: number;
}

interface StoreOriginal {
  id: string;
  title: string;
  artist: string;
  listens: number;
  duration: number;
  tempo?: unknown;
  notes?: string;
  uploadedAt: number;
  assets: {
    instrumental?: StoreAsset;
    vocal?: StoreAsset;
    stems?: StoreStem[];
  };
}

interface Store {
  version: number;
  originals: StoreOriginal[];
}

function buildReplitPath(originalId: string, relativePath: string): string {
  const key = path.posix.join(NOISEGEN_STORAGE_PREFIX, originalId, relativePath);
  return `replit://${key}`;
}

async function main() {
  const storePath = path.resolve(process.cwd(), "data", "noisegen", "store.json");
  
  const raw = await fs.readFile(storePath, "utf-8");
  const store: Store = JSON.parse(raw);
  
  let updated = 0;
  
  for (const original of store.originals) {
    if (original.id === "default") continue;
    
    if (original.assets.instrumental && !original.assets.instrumental.path.startsWith("replit://")) {
      original.assets.instrumental.path = buildReplitPath(original.id, original.assets.instrumental.fileName);
      updated++;
    }
    
    if (original.assets.vocal && !original.assets.vocal.path.startsWith("replit://")) {
      original.assets.vocal.path = buildReplitPath(original.id, original.assets.vocal.fileName);
      updated++;
    }
    
    if (original.assets.stems) {
      for (const stem of original.assets.stems) {
        if (!stem.path.startsWith("replit://")) {
          stem.path = buildReplitPath(original.id, `stems/${stem.fileName}`);
          updated++;
        }
      }
    }
  }
  
  await fs.writeFile(storePath, JSON.stringify(store, null, 2));
  console.log(`Updated ${updated} asset paths to use replit:// storage`);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
