import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assessUnga81ExtractedText } from "./unga81-text-quality.mjs";

const readJson = async (path) => JSON.parse(await readFile(resolve(path), "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const official = await readJson("server/assets/civilization/unga81-official-pages.json");
const manifest = await readJson("server/assets/civilization/unga81-submitted-pdf-manifest.v1.json");
const reviewedBriefs = await readJson("server/assets/civilization/unga81-reviewed-briefs.v2.json");
const ocrManifest = await readJson("server/assets/civilization/unga81-ocr-candidate-manifest.v1.json");
const ocrByUrl = new Map(ocrManifest.entries.map((entry) => [entry.sourceUrl, entry]));
const transcript = await readJson(".cache/civilization/unga81-provisional-transcripts.json");
const acquired = new Map(manifest.entries.map((entry) => [entry.sourceUrl, entry]));
const filenameLanguageHint = (sourceUrl) => /_([a-z]{2})(?:_\d+)?\.pdf(?:\?.*)?$/i.exec(sourceUrl)?.[1]?.toLowerCase() ?? null;
const provisionalAffiliationCode = (officialIso3) => officialIso3 === "EUR" ? "EU" : officialIso3;
const englishPassageCues = [
  ["stated_priority", /\b(?:our (?:priority|priorities|goal|goals|objective|objectives)|we (?:prioriti[sz]e|seek|aim|aspire|intend))\b/i],
  ["proposal_or_request", /\bwe (?:propose|call (?:on|upon|for)|urge|request|invite|appeal to)\b/i],
  ["reported_commitment", /\bwe (?:will|commit|are committed|pledge|are determined)\b/i],
  ["stated_concern", /\bwe (?:are concerned|remain concerned|warn|condemn)\b/i],
  ["cooperation_interest", /\bwe (?:support|welcome|stand ready|look forward|are ready)\b/i],
  ["third_person_policy_verb", /\b(?:supports|is committed to|remains committed to|calls (?:on|upon|for)|urges|proposes|seeks to|is determined to|is ready to)\b/i],
  ["priority_language", /\b(?:national|regional|government|foreign policy) priorit(?:y|ies)\b/i],
];
const frenchPassageCues = [
  ["proposal_or_request", /\bnous (?:appelons|invitons|demandons|proposons|exhortons|sollicitons)\b/iu],
  ["reported_commitment", /\bnous (?:sommes déterminés|nous engageons|entendons|poursuivrons)\b/iu],
  ["stated_priority", /\b(?:notre|nos) (?:ambition|objectif|priorité|priorités)|\bnous devons\b/iu],
  ["stated_concern", /\bnous (?:déplorons|condamnons|sommes préoccupés|nous inquiétons)\b/iu],
  ["cooperation_interest", /\bnous (?:soutenons|saluons|sommes prêts|restons disposés)\b/iu],
  ["priority_language", /\b(?:priorité stratégique|développement durable|financement climatique)\b/iu],
];
const spanishPassageCues = [
  ["proposal_or_request", /\b(?:instamos|exhortamos|proponemos|solicitamos|invitamos|pedimos|hacemos un llamamiento)\b/iu],
  ["reported_commitment", /\b(?:nos comprometemos|estamos comprometidos|seguiremos trabajando)\b/iu],
  ["stated_priority", /\b(?:nuestro objetivo|nuestra prioridad|nuestra ambición|debemos)\b/iu],
  ["stated_concern", /\b(?:nos preocupa|condenamos|lamentamos|advertimos)\b/iu],
  ["cooperation_interest", /\b(?:apoyamos|celebramos|estamos dispuestos)\b/iu],
  ["priority_language", /\b(?:prioridad estratégica|desarrollo sostenible|financiación climática)\b/iu],
];
const passageCuesByFilenameHint = {
  en: englishPassageCues, fr: frenchPassageCues, es: spanishPassageCues,
};
function screenCandidatePassages(text, sourceUrl, quality) {
  if (!text) return { status: "text_unavailable", candidates: [], totalMatched: 0, truncated: false };
  if (quality.status !== "screenable") {
    return { status: "extracted_text_not_screenable", candidates: [], totalMatched: 0, truncated: false };
  }
  const languageHint = filenameLanguageHint(sourceUrl);
  const passageCues = passageCuesByFilenameHint[languageHint];
  if (!passageCues) {
    return { status: "language_not_screened", candidates: [], totalMatched: 0, truncated: false };
  }
  const matches = [];
  for (const [pageIndex, pageText] of text.split("\f").entries()) {
    const normalized = pageText.replace(/-\s*\r?\n\s*(?=\p{Ll})/gu, "")
      .replace(/\s+/g, " ").trim();
    for (const sentence of normalized.split(/(?<=[.!?])\s+(?=["“«(]?\p{Lu})/u)) {
      if (sentence.length < 40 || sentence.length > 900) continue;
      const cues = passageCues.filter(([, pattern]) => pattern.test(sentence)).map(([name]) => name);
      if (!cues.length) continue;
      matches.push({
        sourcePage: pageIndex + 1,
        sourceUrl: `${sourceUrl}#page=${pageIndex + 1}`,
        textSha256: sha256(sentence),
        text: sentence,
        cues,
        reviewStatus: "unreviewed_literal_passage",
      });
    }
  }
  const limit = 60;
  return { status: `${languageHint}_filename_hint_screened`, candidates: matches.slice(0, limit),
    totalMatched: matches.length, truncated: matches.length > limit };
}
const segments = transcript.meetings.flatMap((meeting) => meeting.statements.map((statement) => ({ meeting, statement })));
const codes = new Set([
  ...official.pages.map((page) => page.countryIso3),
  ...segments.map(({ statement }) => statement.speaker.affiliationIso3),
].filter((code) => typeof code === "string" && /^[A-Z]{3}$/.test(code) && code !== "UN"));
const requested = process.argv.find((argument) => argument.startsWith("--country="))?.slice("--country=".length);
if (requested && (!/^[A-Z]{3}$/.test(requested) || !codes.has(requested))) {
  throw new Error("Unknown or invalid country code for this corpus.");
}
const outDir = resolve(".cache/civilization/unga81-review-packets");
await mkdir(outDir, { recursive: true });
let ready = 0;
let sourceGaps = 0;
for (const countryIso3 of [...codes].filter((code) => !requested || code === requested).sort()) {
  const pages = official.pages.filter((page) => page.countryIso3 === countryIso3);
  const countrySegments = segments.filter(({ statement }) =>
    statement.speaker.affiliationIso3 === provisionalAffiliationCode(countryIso3));
  const officialDates = [...new Set(pages.map((page) => page.date).filter(Boolean))].sort();
  const provisionalDates = [...new Set(countrySegments.map(({ meeting }) => meeting.date))].sort();
  const dateAlignment = !pages.length ? "official_page_missing"
    : !officialDates.length ? "official_page_date_missing"
      : !provisionalDates.length ? "provisional_segment_missing"
        : officialDates.some((date) => provisionalDates.includes(date))
          ? "same_day_affiliation_only" : "date_mismatch";
  const submittedTexts = [];
  for (const page of pages) {
    for (const sourceUrl of page.pdfUrls) {
      const acquisition = acquired.get(sourceUrl);
      const textId = sha256(sourceUrl).slice(0, 20);
      let text = null;
      let status = acquisition?.status ?? "not_in_manifest";
      if (status === "available") {
        try {
          const textBytes = await readFile(resolve(`.cache/civilization/unga81-submitted-pdfs/${textId}.txt`));
          if (sha256(textBytes) !== acquisition.extractedTextSha256) throw new Error("text_hash_mismatch");
          text = textBytes.toString("utf8");
        } catch {
          status = "local_text_missing_or_changed";
        }
      }
      const extractionQuality = assessUnga81ExtractedText(text);
      const ocrMetadata = ocrManifest.sourceManifestGeneratedAt === manifest.generatedAt ? ocrByUrl.get(sourceUrl) : null;
      const ocrCandidate = ocrMetadata?.status === "current_unreviewed_candidate" &&
        ocrMetadata.sourcePdfSha256 === acquisition?.pdfSha256 ? {
          status: "unreviewed_local_review_aid",
          localPath: `.cache/civilization/unga81-ocr/${textId}.json`,
          ocrTextSha256: ocrMetadata.ocrTextSha256,
          pageCount: ocrMetadata.pageCount,
          lineCount: ocrMetadata.lineCount,
          meanConfidence: ocrMetadata.meanConfidence,
        } : null;
      submittedTexts.push({
        sourceUrl, pageUrl: page.pageUrl, pageDate: page.date,
        filenameLanguageHint: filenameLanguageHint(sourceUrl), translationRelation: "unverified",
        status, retrievedAt: acquisition?.retrievedAt ?? null,
        pdfSha256: acquisition?.pdfSha256 ?? null,
        pageCount: acquisition?.pageCount ?? null,
        extractedTextSha256: acquisition?.extractedTextSha256 ?? null,
        extractionQuality,
        ocrCandidate,
        candidatePassageScreen: screenCandidatePassages(text, sourceUrl, extractionQuality),
        text,
      });
    }
  }
  const provisionalSegments = countrySegments.map(({ meeting, statement }) => {
    if (sha256(statement.text) !== statement.textSha256) throw new Error(`ASR text hash mismatch for ${countryIso3}`);
    return {
      meetingDate: meeting.date, sourceUrl: statement.sourceUrl,
      speaker: statement.speaker, startSeconds: statement.startSeconds,
      textSha256: statement.textSha256, text: statement.text,
      sourceKind: "provisional automated transcript; not an official UN record",
    };
  });
  const brief = reviewedBriefs.briefs.find((item) => item.countryIso3 === countryIso3);
  const reviewedSource = brief ? submittedTexts.find((item) => item.sourceUrl === brief.sourceUrl) : null;
  const briefSourceStatus = !brief ? "not_reviewed"
    : reviewedSource?.status !== "available" ? "source_unavailable_or_unlinked"
      : reviewedSource.pdfSha256 === brief.sourceSha256 ? "hash_matched_selected_assertions" : "source_hash_changed";
  const gaps = [
    ...(pages.length ? [] : ["official_delegation_page_missing"]),
    ...(submittedTexts.length ? [] : ["submitted_pdf_not_linked"]),
    ...(submittedTexts.every((item) => item.status === "available") ? [] : ["submitted_pdf_text_unavailable_or_changed"]),
    ...(submittedTexts.some((item) => item.extractionQuality.status !== "screenable") ? ["submitted_pdf_extraction_needs_recovery_or_review"] : []),
    ...(submittedTexts.some((item) => item.ocrCandidate) ? ["unreviewed_local_ocr_candidate_needs_pdf_page_review"] : []),
    ...(provisionalSegments.length ? [] : ["provisional_segment_missing"]),
    "official_meeting_record_not_reconciled",
    "speaker_and_delivery_wording_not_verified",
  ];
  const packet = {
    schemaVersion: "civilization_unga81_local_review_packet/v3",
    countryIso3,
    sourceBoundaries: {
      submittedText: "Linked delegation PDFs; submission may differ from delivery",
      provisionalTranscript: "UN automated speech recognition; not an official record",
      localOnly: true,
      generatedClaims: false,
    },
    officialPages: pages.map((page) => ({
      pageUrl: page.pageUrl, date: page.date, label: page.label,
      speakerDescription: page.description,
      speakerMatchToProvisional: "not_verified",
    })),
    crosswalk: { officialDates, provisionalDates, dateAlignment,
      officialAffiliationCode: countryIso3, provisionalAffiliationCode: provisionalAffiliationCode(countryIso3),
      speakerAttributionStatus: "not_verified_to_recording" },
    submittedTexts,
    existingBrief: brief ? {
      status: briefSourceStatus,
      sourceUrl: brief.sourceUrl, sourceSha256: brief.sourceSha256,
      reviewedAt: brief.reviewedAt, revision: brief.revision,
      reviewedAssertions: briefSourceStatus === "hash_matched_selected_assertions"
        ? brief.assertions.map((assertion) => ({ id: assertion.id, claimType: assertion.claimType,
          text: assertion.text, sourcePage: assertion.sourcePage,
          sourcePageUrl: `${brief.sourceUrl}#page=${assertion.sourcePage}` })) : [],
      coverage: briefSourceStatus === "hash_matched_selected_assertions" ? "selected_assertions_only" : "no_current_reviewed_assertions",
      fullSpeechReviewStatus: "not_issued_in_current_manifest",
    } : null,
    provisionalSegments,
    gaps,
    reviewChecklist: [
      "Confirm speaker, office, delegation, date, language, and submitted source version.",
      "PDF filename language codes are hints only; verify language and translation relationships from source pages before reviewing claims.",
      "Inspect existing hash-matched selected assertions before extending a brief; changed or unavailable sources cannot carry forward their reviewed status.",
      "For each proposed assertion, record a concise paraphrase, claim type, PDF page, and source hash.",
      "Literal candidate passages are unreviewed English, French, or Spanish filename-cue matches; inspect the full source page, speaker role, language, and translation status before retaining, correcting, or rejecting any proposed assertion.",
      "OCR candidates are local review aids and may misread words or omit passages; compare every cited page with the source PDF.",
      "Compare each assertion with the provisional recording; flag conflicting names, numbers, and places.",
      "Check the official meeting record or recording before marking delivered wording as verified.",
      "Keep reported policy, independent fact, legal permission, and infrastructure operation separate.",
    ],
  };
  await writeFile(resolve(outDir, `${countryIso3}.json`), `${JSON.stringify(packet)}\n`, "utf8");
  if (submittedTexts.some((item) => item.extractionQuality.status === "screenable") && provisionalSegments.length) ready++;
  if (gaps.length > 2) sourceGaps++;
}
process.stdout.write(`${outDir}: ${requested ? 1 : codes.size} local packets, ${ready} with submitted text and provisional segments, ${sourceGaps} with additional source gaps\n`);
