import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assessUnga81ExtractedText } from "./unga81-text-quality.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const manifest = JSON.parse(await readFile(resolve("server/assets/civilization/unga81-submitted-pdf-manifest.v1.json"), "utf8"));
const entries = [];
for (const entry of manifest.entries) {
  let text = null;
  let localHashStatus = "not_available";
  if (entry.status === "available" && entry.extractedTextSha256) {
    const textId = sha256(entry.sourceUrl).slice(0, 20);
    try {
      const bytes = await readFile(resolve(`.cache/civilization/unga81-submitted-pdfs/${textId}.txt`));
      localHashStatus = sha256(bytes) === entry.extractedTextSha256 ? "matched" : "changed";
      if (localHashStatus === "matched") text = bytes.toString("utf8");
    } catch {
      localHashStatus = "missing";
    }
  }
  entries.push({ sourceUrl: entry.sourceUrl, countryIso3: entry.countryIso3,
    extractedTextSha256: entry.extractedTextSha256, localHashStatus,
    ...assessUnga81ExtractedText(text) });
}
const asset = {
  schemaVersion: "civilization_unga81_text_quality_manifest/v1",
  generatedAt: new Date().toISOString(),
  sourceManifestGeneratedAt: manifest.generatedAt,
  method: "Deterministic local extracted-text screen; thresholds catch very short text, embedded controls, replacement glyphs, and low letter ratio. Screenable means mechanically legible, not linguistically or factually reviewed.",
  entries,
};
const output = resolve("server/assets/civilization/unga81-text-quality-manifest.v1.json");
await writeFile(output, `${JSON.stringify(asset, null, 2)}\n`, "utf8");
const counts = entries.reduce((totals, entry) => {
  totals[entry.status] = (totals[entry.status] ?? 0) + 1;
  return totals;
}, {});
process.stdout.write(`${output}: ${JSON.stringify(counts)}\n`);
