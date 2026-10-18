import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const INBOX_FILE = "helix-fabric-player-agent.autojoin-inbox";
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i;

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name.slice(2)}_missing`);
  return value;
};

const stage = async (): Promise<void> => {
  const rawAddress = option("--address") ?? "localhost:25565";
  const match = LOOPBACK.exec(rawAddress.trim());
  if (!match) throw new Error("minecraft_autojoin_loopback_address_required");
  const port = match[2] === undefined ? 25565 : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("minecraft_autojoin_port_invalid");
  }
  const host = match[1].toLowerCase();
  const address = `${host}:${port}`;
  const configuredRoot = option("--minecraft-root") ??
    (process.env.APPDATA ? path.join(process.env.APPDATA, ".minecraft") : "");
  if (!configuredRoot) throw new Error("minecraft_root_required");
  const minecraftRoot = path.resolve(configuredRoot);
  const configDirectory = path.resolve(minecraftRoot, "config");
  const relativeConfig = path.relative(minecraftRoot, configDirectory);
  if (relativeConfig.startsWith("..") || path.isAbsolute(relativeConfig)) {
    throw new Error("minecraft_autojoin_inbox_path_invalid");
  }
  await fs.mkdir(configDirectory, { recursive: true });
  const inbox = path.join(configDirectory, INBOX_FILE);
  const pending = `${inbox}.pending.${process.pid}.${crypto.randomUUID()}`;
  try {
    await fs.writeFile(
      pending,
      `/helix-player autojoin ${address}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await fs.rename(pending, inbox);
  } finally {
    await fs.rm(pending, { force: true }).catch(() => undefined);
  }
  process.stdout.write(`STAGED AUTOJOIN ${address} ${inbox}\n`);
};

stage().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
