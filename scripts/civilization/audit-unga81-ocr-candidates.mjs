import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const manifest = JSON.parse(await readFile(resolve("server/assets/civilization/unga81-submitted-pdf-manifest.v1.json"), "utf8"));
const entries = [];
for (const source of manifest.entries) {
  const textId = sha256(source.sourceUrl).slice(0, 20);
  let candidate;
  try {
    candidate = JSON.parse(await readFile(resolve(`.cache/civilization/unga81-ocr/${textId}.json`), "utf8"));
  } catch {
    continue;
  }
  const pages = Array.isArray(candidate.pages) ? candidate.pages : [];
  const lines = pages.flatMap((page) => Array.isArray(page.lines) ? page.lines : []);
  const recomputedTextHash = sha256(pages.map((page) =>
    (page.lines ?? []).map((line) => line.text).join("\n")).join("\f"));
  const status = source.status === "available" && candidate.sourceUrl === source.sourceUrl &&
    candidate.sourcePdfSha256 === source.pdfSha256 &&
    candidate.ocrTextSha256 === recomputedTextHash &&
    candidate.pageCount === source.pageCount && pages.length === source.pageCount &&
    pages.every((page, index) => page.page === index + 1) &&
    candidate.status === "unreviewed_ocr_candidate" ? "current_unreviewed_candidate" : "stale_or_invalid";
  entries.push({
    sourceUrl: source.sourceUrl, countryIso3: source.countryIso3,
    sourcePdfSha256: candidate.sourcePdfSha256 ?? null,
    ocrTextSha256: candidate.ocrTextSha256 ?? null,
    createdAt: candidate.createdAt ?? null,
    engine: candidate.engine ?? null,
    pageCount: pages.length,
    lineCount: lines.length,
    meanConfidence: lines.length ? Math.round(lines.reduce((total, line) => total + Number(line.confidence || 0), 0) / lines.length * 10000) / 10000 : null,
    status,
  });
}
const asset = {
  schemaVersion: "civilization_unga81_ocr_candidate_manifest/v1",
  generatedAt: new Date().toISOString(),
  sourceManifestGeneratedAt: manifest.generatedAt,
  method: "Local OCR candidates are hash-checked against acquired PDFs. Confidence is an engine score, not source verification. OCR text stays in ignored local cache and is not bundled.",
  entries,
};
const output = resolve("server/assets/civilization/unga81-ocr-candidate-manifest.v1.json");
await writeFile(output, `${JSON.stringify(asset, null, 2)}\n`, "utf8");
process.stdout.write(`${output}: ${entries.filter((entry) => entry.status === "current_unreviewed_candidate").length} current candidates, ${entries.filter((entry) => entry.status !== "current_unreviewed_candidate").length} stale or invalid\n`);
