import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_ARTIFACTS_DIR = "artifacts";

export const resolveArtifactsDir = (): string => {
  const override = process.env.AGI_ARTIFACTS_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.resolve(process.cwd(), DEFAULT_ARTIFACTS_DIR);
};

export const resolveArtifactsPath = (...parts: string[]): string =>
  path.join(resolveArtifactsDir(), ...parts);

export const ensureArtifactsDir = async (filePath: string): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
};
