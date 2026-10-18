import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const readJson = async (path) => JSON.parse(await readFile(resolve(path), "utf8"));
const manifest = await readJson("server/assets/civilization/unga81-submitted-pdf-manifest.v1.json");
const official = await readJson("server/assets/civilization/unga81-official-pages.json");
const manifestByUrl = new Map(manifest.entries.map((entry) => [entry.sourceUrl, entry]));
const packetDir = resolve(".cache/civilization/unga81-review-packets");
const packetNames = (await readdir(packetDir)).filter((name) => /^[A-Z]{3}\.json$/.test(name)).sort();
const entries = [];

for (const packetName of packetNames) {
  const packet = await readJson(`${packetDir}/${packetName}`);
  const countryIso3 = packetName.slice(0, 3);
  if (packet.countryIso3 !== countryIso3 || packet.schemaVersion !== "civilization_unga81_local_review_packet/v3") {
    throw new Error(`Review packet identity or schema changed: ${packetName}`);
  }
  const linkedUrls = new Set(official.pages.filter((page) => page.countryIso3 === countryIso3)
    .flatMap((page) => page.pdfUrls));
  const sources = packet.submittedTexts.map((source) => {
    const acquisition = manifestByUrl.get(source.sourceUrl);
    const sourceCurrent = linkedUrls.has(source.sourceUrl) && acquisition?.status === "available" &&
      source.status === "available" && source.pdfSha256 === acquisition.pdfSha256 &&
      source.extractedTextSha256 === acquisition.extractedTextSha256;
    const screen = source.candidatePassageScreen;
    const pageCounts = new Map();
    if (sourceCurrent && screen.status.endsWith("_filename_hint_screened")) {
      for (const candidate of screen.candidates) {
        const page = candidate.sourcePage;
        if (!Number.isInteger(page) || page < 1 || page > acquisition.pageCount) continue;
        const current = pageCounts.get(page) ?? { page, candidateCount: 0, cues: new Set() };
        current.candidateCount++;
        candidate.cues.forEach((cue) => current.cues.add(cue));
        pageCounts.set(page, current);
      }
    }
    const rankedPages = [...pageCounts.values()].sort((left, right) =>
      right.candidateCount - left.candidateCount || left.page - right.page);
    return {
      sourceUrl: source.sourceUrl, officialPageUrl: source.pageUrl,
      sourcePdfSha256: sourceCurrent ? acquisition.pdfSha256 : null,
      pageCount: sourceCurrent ? acquisition.pageCount : null,
      extractedTextQuality: source.extractionQuality.status,
      status: !sourceCurrent ? "source_or_packet_not_current" :
        screen.status.endsWith("_filename_hint_screened") ? "unreviewed_literal_cue_pages" :
          "source_available_not_screened",
      filenameLanguageHint: source.filenameLanguageHint,
      totalMatchedPassages: sourceCurrent ? screen.totalMatched : 0,
      candidateListTruncated: sourceCurrent ? screen.truncated : false,
      rankedPages: rankedPages.slice(0, 8).map((item) => ({
        page: item.page, candidateCount: item.candidateCount, cues: [...item.cues].sort(),
      })),
      additionalCandidatePagesNotShown: Math.max(0, rankedPages.length - 8),
    };
  });
  entries.push({ countryIso3, sources });
}

const output = {
  schemaVersion: "civilization_unga81_submitted_page_leads/v1",
  generatedAt: new Date().toISOString(),
  submittedPdfManifestGeneratedAt: manifest.generatedAt,
  officialPagesCollectedAt: official.collectedAt,
  method: "local_hash_matched_submitted_text_literal_cue_page_navigation",
  interpretation: "Cue counts and filename language hints locate pages for review; they are not reviewed positions, priorities, delivered speech, translation verification, or a claim that other pages are irrelevant.",
  entries,
};
await writeFile(resolve("server/assets/civilization/unga81-submitted-page-leads.v1.json"),
  `${JSON.stringify(output)}\n`, "utf8");
process.stdout.write(`${entries.length} affiliation packets, ${entries.reduce((sum, entry) => sum + entry.sources.length, 0)} linked submitted sources indexed\n`);
