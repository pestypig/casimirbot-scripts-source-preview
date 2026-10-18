import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_URL = "http://127.0.0.1:5173/api/helix/time-dilation/diagnostics";

const parseArgs = () => {
  const args = process.argv.slice(2);
  const out: { url?: string; outPath?: string } = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--url") {
      out.url = args[i + 1];
      i += 1;
    } else if (token === "--out") {
      out.outPath = args[i + 1];
      i += 1;
    }
  }
  return out;
};

async function main() {
  const { url, outPath } = parseArgs();
  const diagnosticsUrl = url ?? process.env.TIME_DILATION_DIAGNOSTICS_URL ?? DEFAULT_URL;
  const response = await fetch(diagnosticsUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch diagnostics (${response.status})`);
  }
  const payload = await response.json();
  const outputPath = outPath ?? path.join("docs", "time-dilation-lattice-debug.json");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`Wrote ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
