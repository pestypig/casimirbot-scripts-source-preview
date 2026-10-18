import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const base = "https://transcripts.un.org";
const listingUrl = `${base}/en/meetings.json?from=2026-09-22&to=2026-09-28&q=General%20Debate`;
const output = resolve("server/assets/civilization/unga81-provisional-transcripts.json");
const localTextCache = resolve(".cache/civilization/unga81-provisional-transcripts.json");
const topicPatterns = [
  ["peace and security", /\b(peace|ceasefire|conflict|security|war)\b/i],
  ["trade and economic exchange", /\b(trade|exports?|commerce|supply chain|customs)\b/i],
  ["infrastructure and connectivity", /\b(infrastructure|connectivity|railway|pipeline|ports?|transport)\b/i],
  ["climate and environment", /\b(climate|environment|biodiversity|emissions?|drought|floods?)\b/i],
  ["energy and minerals", /\b(energy|electricity|renewable|mineral|oil|gas)\b/i],
  ["development finance", /\b(finance|debt|investment|funding|financing)\b/i],
  ["food and water", /\b(food|agriculture|farming|water|hunger)\b/i],
  ["health and education", /\b(health|pandemic|hospital|education|school)\b/i],
  ["technology and AI", /\b(technology|digital|artificial intelligence|AI)\b/i],
];

async function readJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

const listing = await readJson(listingUrl);
const meetings = listing.meetings.filter((meeting) =>
  /^\(Day [1-6]\) General Debate - General Assembly: Plenary meeting, 81st session$/.test(meeting.title));
if (meetings.length !== 6 || meetings.some((meeting) => !meeting.hasTranscript || !meeting.jsonUrl)) {
  throw new Error("UNGA81 six-day transcript coverage is incomplete; inspect the official listing before updating the asset.");
}

const records = [];
for (const meeting of meetings.sort((a, b) => a.date.localeCompare(b.date))) {
  const document = await readJson(new URL(meeting.jsonUrl, base));
  if (!document.disclaimer?.includes("not official records") || !Array.isArray(document.transcript?.data)) {
    throw new Error(`Unexpected transcript shape or source warning: ${meeting.jsonUrl}`);
  }
  records.push({
    title: meeting.title,
    date: meeting.date.slice(0, 10),
    sourceUrl: new URL(meeting.pageUrl, base).href,
    videoUrl: document.video?.url ?? null,
    language: document.transcript.language,
    statements: document.transcript.data.map((statement) => {
      const text = statement.paragraphs
        .flatMap((paragraph) => paragraph.sentences.map((sentence) => sentence.text.trim()))
        .filter(Boolean).join(" ");
      const sentences = statement.paragraphs.flatMap((paragraph) => paragraph.sentences.map((sentence) => sentence.text.trim()));
      return {
        statementNumber: statement.statement_number,
        startSeconds: statement.start,
        sourceUrl: new URL(statement.pageUrl, base).href,
        speaker: {
          affiliationIso3: statement.speaker?.affiliation ?? null,
          affiliationName: statement.speaker?.affiliation_full ?? null,
          function: statement.speaker?.function ?? null,
          group: statement.speaker?.group ?? null,
        },
        text,
        characterCount: text.length,
        topicCounts: Object.fromEntries(topicPatterns.map(([topic, pattern]) =>
          [topic, sentences.filter((sentence) => pattern.test(sentence)).length])),
        textSha256: createHash("sha256").update(text).digest("hex"),
      };
    }),
  });
}

const asset = {
  schemaVersion: "civilization_unga81_provisional_transcripts/v1",
  sourceKind: "UN automated speech recognition, public preview; not an official UN record",
  sourceListingUrl: listingUrl,
  collectedAt: new Date().toISOString(),
  debateDates: ["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-28"],
  interpretationLimits: [
    "Automated speech recognition can mishear or mistranslate words and misidentify speakers.",
    "A speaker's dated statement does not establish a permanent national preference or a population-wide view.",
    "Submitted national statements and official meeting records may differ from the automated transcript.",
    "The transcript corpus alone does not establish current trade volumes, treaties, permissions, or feasible infrastructure.",
  ],
  meetings: records,
};
await mkdir(dirname(localTextCache), { recursive: true });
await writeFile(localTextCache, `${JSON.stringify(asset)}\n`, "utf8");
const distributable = {
  ...asset,
  schemaVersion: "civilization_unga81_provisional_index/v1",
  storageBoundary: "full ASR text retained only in local ignored cache; bundled asset contains metadata and derived mention counts",
  meetings: asset.meetings.map((meeting) => ({
    ...meeting,
    statements: meeting.statements.map(({ text: _text, ...statement }) => statement),
  })),
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(distributable)}\n`, "utf8");
const statementCount = records.reduce((sum, meeting) => sum + meeting.statements.length, 0);
const affiliationCount = new Set(records.flatMap((meeting) => meeting.statements.map((statement) => statement.speaker.affiliationIso3).filter(Boolean))).size;
process.stdout.write(`${localTextCache}\n${output}\n${records.length} meetings, ${statementCount} speaker segments, ${affiliationCount} affiliation codes\n`);
