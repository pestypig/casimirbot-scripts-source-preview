import fs from "node:fs";
import path from "node:path";

const manifestPath = path.resolve(
  process.cwd(),
  "docs/audits/research/agibot-x1-asset-manifest-2026-02-20.md",
);

const REQUIRED_PHASES = new Set(["P0", "P1", "P2"]);
const REQUIRED_COLUMNS = [
  "asset_id",
  "source_url",
  "expected_sha256",
  "license",
  "required_for_phase",
  "availability_status",
] as const;

type ManifestRow = Record<(typeof REQUIRED_COLUMNS)[number], string>;

const parseMarkdownTable = (raw: string): ManifestRow[] => {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  if (lines.length < 3) {
    throw new Error("manifest_table_missing_or_too_short");
  }
  const header = lines[0].split("|").map((s) => s.trim()).filter(Boolean);
  for (const required of REQUIRED_COLUMNS) {
    if (!header.includes(required)) {
      throw new Error(`manifest_header_missing:${required}`);
    }
  }
  const idx = Object.fromEntries(REQUIRED_COLUMNS.map((key) => [key, header.indexOf(key)])) as Record<
    (typeof REQUIRED_COLUMNS)[number],
    number
  >;
  const rows: ManifestRow[] = [];
  for (const line of lines.slice(2)) {
    const cols = line.split("|").map((s) => s.trim()).filter(Boolean);
    if (cols.length < header.length) continue;
    const row = {
      asset_id: cols[idx.asset_id] ?? "",
      source_url: cols[idx.source_url] ?? "",
      expected_sha256: cols[idx.expected_sha256] ?? "",
      license: cols[idx.license] ?? "",
      required_for_phase: cols[idx.required_for_phase] ?? "",
      availability_status: cols[idx.availability_status] ?? "",
    };
    rows.push(row);
  }
  return rows;
};

const sha256Re = /^[a-f0-9]{64}$/;

const main = (): void => {
  if (!fs.existsSync(manifestPath)) {
    console.error(`FAIL manifest_missing path=${manifestPath}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(manifestPath, "utf8");
  const rows = parseMarkdownTable(raw);
  if (rows.length === 0) {
    console.error("FAIL no_assets_listed");
    process.exit(1);
  }

  for (const row of rows) {
    if (!row.asset_id) {
      console.error("FAIL missing_asset_id");
      process.exit(1);
    }
    if (!row.source_url) {
      console.error(`FAIL missing_source_url asset_id=${row.asset_id}`);
      process.exit(1);
    }
    if (!sha256Re.test(row.expected_sha256)) {
      console.error(`FAIL missing_or_invalid_checksum asset_id=${row.asset_id}`);
      process.exit(1);
    }
    if (!row.license) {
      console.error(`FAIL missing_license asset_id=${row.asset_id}`);
      process.exit(1);
    }
    if (!REQUIRED_PHASES.has(row.required_for_phase)) {
      console.error(`FAIL invalid_phase asset_id=${row.asset_id} phase=${row.required_for_phase}`);
      process.exit(1);
    }
  }

  const requiredP0 = rows.filter((row) => row.required_for_phase === "P0");
  if (requiredP0.length === 0) {
    console.error("FAIL missing_required_p0_assets");
    process.exit(1);
  }
  const missingP0 = requiredP0.find((row) => row.availability_status !== "available" && row.availability_status !== "declared");
  if (missingP0) {
    console.error(`FAIL missing_required_asset asset_id=${missingP0.asset_id} phase=P0`);
    process.exit(1);
  }

  console.log(`PASS agibot_asset_manifest rows=${rows.length}`);
};

main();
