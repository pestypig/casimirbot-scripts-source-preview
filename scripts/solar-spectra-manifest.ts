import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const USAGE = `
Usage: npm run solar:manifest -- [options]

Options:
  --manifest <path>   Manifest JSON path (default: datasets/solar/spectra/solar-spectra.manifest.json)
  --write             Update manifest entries with computed hashes
  --no-backup         Skip backup when writing
  --help              Show this message
`;

type ArgMap = Map<string, string | boolean>;

type ManifestEntry = {
  id?: string;
  input?: { path?: string; bytes?: number; sha256?: string };
  expected?: { hashes?: { inputs_hash?: string } };
};

type Manifest = {
  schema_version?: string;
  kind?: string;
  created_at?: string;
  name?: string;
  description?: string;
  entries?: ManifestEntry[];
};

const parseArgs = (argv: string[]) => {
  const args = argv.slice();
  const flags: ArgMap = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const entry = args[i];
    if (!entry) continue;
    if (entry.startsWith("--")) {
      const key = entry.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
    }
  }
  return { flags };
};

const flagEnabled = (flags: ArgMap, key: string): boolean =>
  flags.get(key) === true;

const flagString = (flags: ArgMap, key: string): string | undefined => {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
};

const defaultManifestPath = () =>
  path.resolve(process.cwd(), "datasets", "solar", "spectra", "solar-spectra.manifest.json");

const sha256Hex = (buffer: Buffer): string =>
  crypto.createHash("sha256").update(buffer).digest("hex");

const main = () => {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flagEnabled(flags, "help")) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const manifestPath = path.resolve(flagString(flags, "manifest") ?? defaultManifestPath());
  const write = flagEnabled(flags, "write");
  const backup = !flagEnabled(flags, "no-backup");

  if (!fs.existsSync(manifestPath)) {
    console.error(`[solar-manifest] missing manifest: ${manifestPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  if (!entries.length) {
    console.error("[solar-manifest] manifest has no entries to validate");
    process.exit(1);
  }

  const mismatches: string[] = [];
  let updated = 0;

  for (const entry of entries) {
    const input = entry.input ?? {};
    const relPath = input.path;
    if (!relPath) {
      mismatches.push(`entry ${entry.id ?? "(missing id)"}: missing input.path`);
      continue;
    }
    const filePath = path.resolve(process.cwd(), relPath);
    if (!fs.existsSync(filePath)) {
      mismatches.push(`entry ${entry.id ?? relPath}: missing file ${relPath}`);
      continue;
    }
    const buffer = fs.readFileSync(filePath);
    const bytes = buffer.byteLength;
    const hash = sha256Hex(buffer);
    if (input.bytes !== bytes) {
      mismatches.push(`entry ${entry.id ?? relPath}: bytes ${input.bytes ?? "n/a"} -> ${bytes}`);
    }
    if (input.sha256 !== hash) {
      mismatches.push(`entry ${entry.id ?? relPath}: sha256 ${input.sha256 ?? "n/a"} -> ${hash}`);
    }

    if (write) {
      input.bytes = bytes;
      input.sha256 = hash;
      entry.input = input;
      entry.expected = entry.expected ?? {};
      entry.expected.hashes = entry.expected.hashes ?? {};
      entry.expected.hashes.inputs_hash = `sha256:${hash}`;
      updated += 1;
    } else if (entry.expected?.hashes?.inputs_hash) {
      const expectedHash = entry.expected.hashes.inputs_hash;
      const computed = `sha256:${hash}`;
      if (expectedHash !== computed) {
        mismatches.push(
          `entry ${entry.id ?? relPath}: inputs_hash ${expectedHash} -> ${computed}`,
        );
      }
    }
  }

  if (mismatches.length) {
    console.error("[solar-manifest] mismatches detected:");
    for (const mismatch of mismatches) {
      console.error(` - ${mismatch}`);
    }
  }

  if (write) {
    if (backup) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${manifestPath}.bak-${stamp}`;
      fs.copyFileSync(manifestPath, backupPath);
      console.log(`[solar-manifest] backup saved: ${backupPath}`);
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`[solar-manifest] updated ${updated} entries`);
  }

  if (mismatches.length && !write) {
    process.exit(1);
  }
};

main();
