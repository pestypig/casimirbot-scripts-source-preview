import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const ISOLATED_PROFILE_RECEIPT_SCHEMA =
  "helix.minecraft.isolated_client_profile_receipt.v1" as const;

type LauncherProfile = {
  name?: string;
  type?: string;
  created?: string;
  lastUsed?: string;
  lastVersionId?: string;
  gameDir?: string;
  javaArgs?: string;
};

type LauncherProfiles = {
  profiles?: Record<string, LauncherProfile>;
  [key: string]: unknown;
};

export type ProvisionIsolatedProfileInput = {
  minecraftRoot: string;
  instanceRoot: string;
  profileId: string;
  profileName: string;
  sourceProfileId: string;
  serverAddress: string;
  modNames: string[];
  maxMemoryMib?: number;
  now?: string;
};

const SAFE_ID = /^[a-zA-Z0-9._-]{1,80}$/u;
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/iu;
const ACTIVE_JAR = /^[a-zA-Z0-9][a-zA-Z0-9+._-]*\.jar$/u;

const inside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

const atomicWrite = async (target: string, contents: string): Promise<void> => {
  const pending = `${target}.pending.${process.pid}.${crypto.randomUUID()}`;
  try {
    await fs.writeFile(pending, contents, { encoding: "utf8", flag: "wx" });
    await fs.rename(pending, target);
  } finally {
    await fs.rm(pending, { force: true }).catch(() => undefined);
  }
};

const sha256File = async (filePath: string): Promise<string> =>
  `sha256:${crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex")}`;

export const provisionIsolatedMinecraftClientProfile = async (
  input: ProvisionIsolatedProfileInput,
) => {
  if (!SAFE_ID.test(input.profileId) || !SAFE_ID.test(input.sourceProfileId)) {
    throw new Error("minecraft_isolated_profile_id_invalid");
  }
  if (!input.profileName.trim() || input.profileName.length > 80) {
    throw new Error("minecraft_isolated_profile_name_invalid");
  }
  const match = LOOPBACK.exec(input.serverAddress.trim());
  if (!match) throw new Error("minecraft_isolated_profile_loopback_required");
  const port = match[2] === undefined ? 25565 : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("minecraft_isolated_profile_port_invalid");
  }
  const address = `${match[1].toLowerCase()}:${port}`;
  const minecraftRoot = path.resolve(input.minecraftRoot);
  const instanceRoot = path.resolve(input.instanceRoot);
  if (!inside(path.dirname(minecraftRoot), instanceRoot) || instanceRoot === minecraftRoot) {
    throw new Error("minecraft_isolated_profile_instance_root_invalid");
  }
  const maxMemoryMib = input.maxMemoryMib ?? 640;
  if (!Number.isInteger(maxMemoryMib) || maxMemoryMib < 512 || maxMemoryMib > 1536) {
    throw new Error("minecraft_isolated_profile_memory_invalid");
  }
  if (
    input.modNames.length < 2 ||
    input.modNames.length > 8 ||
    new Set(input.modNames).size !== input.modNames.length ||
    input.modNames.some((name) => !ACTIVE_JAR.test(name))
  ) {
    throw new Error("minecraft_isolated_profile_mod_set_invalid");
  }

  const profilesPath = path.join(minecraftRoot, "launcher_profiles.json");
  const parsed = JSON.parse(await fs.readFile(profilesPath, "utf8")) as LauncherProfiles;
  const profiles = parsed.profiles ?? {};
  const source = profiles[input.sourceProfileId];
  if (!source?.lastVersionId?.includes("fabric-loader-") ||
      !source.lastVersionId.endsWith("-1.21.8")) {
    throw new Error("minecraft_isolated_profile_source_fabric_required");
  }

  const sourceMods = path.join(minecraftRoot, "mods");
  const instanceMods = path.join(instanceRoot, "mods");
  const instanceConfig = path.join(instanceRoot, "config");
  await fs.mkdir(instanceMods, { recursive: true });
  await fs.mkdir(instanceConfig, { recursive: true });
  const copiedMods: Array<{ name: string; sha256: string }> = [];
  for (const name of input.modNames) {
    const sourcePath = path.join(sourceMods, name);
    const targetPath = path.join(instanceMods, name);
    const stat = await fs.stat(sourcePath).catch(() => null);
    if (!stat?.isFile()) throw new Error(`minecraft_isolated_profile_mod_missing:${name}`);
    await fs.copyFile(sourcePath, targetPath);
    const sourceHash = await sha256File(sourcePath);
    const targetHash = await sha256File(targetPath);
    if (sourceHash !== targetHash) {
      throw new Error(`minecraft_isolated_profile_mod_copy_mismatch:${name}`);
    }
    copiedMods.push({ name, sha256: targetHash });
  }

  const now = input.now ?? new Date().toISOString();
  profiles[input.profileId] = {
    name: input.profileName.slice(0, 80),
    type: "custom",
    created: profiles[input.profileId]?.created ?? now,
    lastUsed: now,
    lastVersionId: source.lastVersionId,
    gameDir: instanceRoot,
    javaArgs: `-Xms256M -Xmx${maxMemoryMib}M`,
  };
  parsed.profiles = profiles;

  const backup = `${profilesPath}.pre-${input.profileId}.bak`;
  let backupCreated = false;
  try {
    await fs.copyFile(profilesPath, backup, fsConstants.COPYFILE_EXCL);
    backupCreated = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  }
  await atomicWrite(profilesPath, `${JSON.stringify(parsed, null, 2)}\n`);
  await atomicWrite(
    path.join(instanceConfig, "helix-fabric-player-agent.autojoin-inbox"),
    `/helix-player autojoin ${address}\n`,
  );
  await atomicWrite(
    path.join(instanceRoot, "options.txt"),
    [
      "fullscreen:false",
      "renderDistance:4",
      "simulationDistance:4",
      "maxFps:30",
      "enableVsync:false",
      "pauseOnLostFocus:false",
      "showAutosaveIndicator:true",
      "",
    ].join("\n"),
  );

  return {
    schema: ISOLATED_PROFILE_RECEIPT_SCHEMA,
    status: "prepared" as const,
    profile_id: input.profileId,
    profile_version: source.lastVersionId,
    instance_root: instanceRoot,
    server_address: address,
    copied_mod_count: input.modNames.length,
    copied_mods: copiedMods,
    max_memory_mib: maxMemoryMib,
    launcher_profile_backup_created: backupCreated,
    credentials_read: false,
    credentials_exposed: false,
  };
};

const readOptions = (args: string[]): Record<string, string[]> => {
  const values: Record<string, string[]> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("minecraft_isolated_profile_arguments_invalid");
    }
    (values[key.slice(2)] ??= []).push(value);
  }
  return values;
};

const main = async (): Promise<void> => {
  const options = readOptions(process.argv.slice(2));
  const one = (name: string): string => {
    const values = options[name];
    if (values?.length !== 1) throw new Error(`${name}_required`);
    return values[0];
  };
  const receipt = await provisionIsolatedMinecraftClientProfile({
    minecraftRoot: one("minecraft-root"),
    instanceRoot: one("instance-root"),
    profileId: one("profile-id"),
    profileName: one("profile-name"),
    sourceProfileId: one("source-profile-id"),
    serverAddress: one("server-address"),
    modNames: options.mod ?? [],
    maxMemoryMib: options["max-memory-mib"]
      ? Number(one("max-memory-mib"))
      : undefined,
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
