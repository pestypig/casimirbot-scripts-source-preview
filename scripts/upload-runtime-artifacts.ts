import { Client } from "@replit/object-storage";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";

type ArtifactConfig = {
  label: string;
  keyEnv: string;
  shaEnv: string;
  pathEnv: string;
  defaultPath: string;
  alwaysIncludePath?: boolean;
};

const ARTIFACTS: ArtifactConfig[] = [
  {
    label: "model",
    keyEnv: "LLM_LOCAL_MODEL_OBJECT_KEY",
    shaEnv: "LLM_LOCAL_MODEL_SHA256",
    pathEnv: "LLM_LOCAL_MODEL_PATH",
    defaultPath: "models/qwen2.5-3b-instruct-q4_k_m.gguf",
  },
  {
    label: "lora",
    keyEnv: "LLM_LOCAL_LORA_OBJECT_KEY",
    shaEnv: "LLM_LOCAL_LORA_SHA256",
    pathEnv: "LLM_LOCAL_LORA_PATH",
    defaultPath: "models/agi-answerer-qlora-f16.gguf",
  },
  {
    label: "index",
    keyEnv: "LLM_LOCAL_INDEX_OBJECT_KEY",
    shaEnv: "LLM_LOCAL_INDEX_SHA256",
    pathEnv: "LLM_LOCAL_INDEX_PATH",
    defaultPath: "server/_generated/code-lattice.json",
  },
  {
    label: "llama-cli",
    keyEnv: "LLM_LOCAL_CMD_OBJECT_KEY",
    shaEnv: "LLM_LOCAL_CMD_SHA256",
    pathEnv: "LLM_LOCAL_CMD",
    defaultPath: ".cache/llm/llama-build/bin/llama-cli",
    alwaysIncludePath: true,
  },
];

const normalizeObjectKey = (raw?: string): string | null => {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const withoutPrefix = trimmed.replace(/^=+/, "");
  if (withoutPrefix.startsWith("replit://")) {
    return withoutPrefix.slice("replit://".length);
  }
  if (withoutPrefix.startsWith("storage://")) {
    return withoutPrefix.slice("storage://".length);
  }
  return withoutPrefix;
};

const resolvePath = (filePath: string): string =>
  path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

const hashAndUpload = async (
  client: Client,
  key: string,
  filePath: string,
): Promise<string> => {
  const hash = createHash("sha256");
  const source = createReadStream(filePath);
  const tee = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await client.uploadFromStream(key, source.pipe(tee));
  return hash.digest("hex");
};

async function main() {
  const client = new Client();
  const envLines: string[] = [];

  for (const artifact of ARTIFACTS) {
    const rawPath = process.env[artifact.pathEnv]?.trim() || artifact.defaultPath;
    const resolvedPath = resolvePath(rawPath);
    if (!existsSync(resolvedPath)) {
      console.warn(`[storage] ${artifact.label} missing at ${resolvedPath}, skipping.`);
      continue;
    }

    const key =
      normalizeObjectKey(process.env[artifact.keyEnv]) ??
      path.basename(resolvedPath);

    console.log(`[storage] uploading ${artifact.label} -> ${key}`);
    const sha256 = await hashAndUpload(client, key, resolvedPath);
    console.log(`[storage] uploaded ${artifact.label} (${sha256.slice(0, 12)}...)`);

    envLines.push(`${artifact.keyEnv}=${key}`);
    envLines.push(`${artifact.shaEnv}=${sha256}`);
    if (artifact.alwaysIncludePath || process.env[artifact.pathEnv]?.trim()) {
      envLines.push(`${artifact.pathEnv}=${rawPath}`);
    }
  }

  if (envLines.length) {
    console.log("\nSuggested .env entries:");
    console.log(envLines.join("\n"));
  } else {
    console.log("No artifacts were uploaded.");
  }
}

main().catch((err) => {
  console.error("Upload failed:", err);
  process.exit(1);
});
