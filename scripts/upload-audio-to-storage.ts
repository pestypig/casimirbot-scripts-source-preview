import { Client } from "@replit/object-storage";
import { promises as fs } from "node:fs";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";

const NOISEGEN_STORAGE_PREFIX = "noisegen/originals";

async function uploadFile(client: Client, key: string, filePath: string): Promise<void> {
  console.log(`Uploading ${filePath} to ${key}...`);
  const stream = createReadStream(filePath);
  await client.uploadFromStream(key, stream);
  console.log(`  Uploaded: ${key}`);
}

async function main() {
  const originalsDir = path.resolve(process.cwd(), "client", "public", "originals");
  
  if (!existsSync(originalsDir)) {
    console.error(`Originals directory not found: ${originalsDir}`);
    process.exit(1);
  }

  const client = new Client();
  const entries = await fs.readdir(originalsDir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "default") continue;
    
    const originalId = entry.name;
    const originalDir = path.join(originalsDir, originalId);
    
    console.log(`\nProcessing original: ${originalId}`);
    
    const files = await fs.readdir(originalDir, { withFileTypes: true });
    for (const file of files) {
      if (file.isFile() && file.name.endsWith(".wav")) {
        const key = path.posix.join(NOISEGEN_STORAGE_PREFIX, originalId, file.name);
        const filePath = path.join(originalDir, file.name);
        await uploadFile(client, key, filePath);
      }
    }
    
    const stemsDir = path.join(originalDir, "stems");
    if (existsSync(stemsDir)) {
      const stemFiles = await fs.readdir(stemsDir, { withFileTypes: true });
      for (const stem of stemFiles) {
        if (stem.isFile() && stem.name.endsWith(".wav")) {
          const key = path.posix.join(NOISEGEN_STORAGE_PREFIX, originalId, "stems", stem.name);
          const filePath = path.join(stemsDir, stem.name);
          await uploadFile(client, key, filePath);
        }
      }
    }
  }
  
  console.log("\nUpload complete!");
}

main().catch((err) => {
  console.error("Upload failed:", err);
  process.exit(1);
});
