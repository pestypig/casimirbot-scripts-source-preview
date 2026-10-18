import { enMessages } from "../client/src/lib/i18n/messages/en";
import { INTERFACE_TARGET_CATALOGS } from "../client/src/lib/i18n/messages/targetCatalogs";
import { INTERFACE_MESSAGE_IDS, type InterfaceMessageId } from "../client/src/lib/i18n/messages/types";
import {
  isPublicInterfaceLanguageCode,
  type SharedInterfaceLanguageCode,
} from "../shared/interface-language-codes";

type BucketReport = {
  missingStrings: number;
  missingWords: number;
  exactEnglishStrings: number;
  exactEnglishWords: number;
  missingSampleIds: InterfaceMessageId[];
  exactEnglishSampleIds: InterfaceMessageId[];
};

type LocaleReport = {
  code: string;
  releaseStatus: "public" | "developer_preview";
  targetMessages: number;
  sourceMessages: number;
  missingStrings: number;
  missingWords: number;
  exactEnglishStrings: number;
  exactEnglishWords: number;
  approvedExactEnglishStrings: number;
  approvedExactEnglishIds: InterfaceMessageId[];
  buckets: Record<string, BucketReport>;
};

const approvedExactEnglishIds = new Set<InterfaceMessageId>([
  "account.language.optionReadiness",
  "account.display.provider.google",
  "account.display.provider.discord",
  "account.display.provider.minehut",
  "account.display.sourceFamily.helixAskDesktop",
  "situationRoom.advancedSetup.compactContextPackOnly",
  "taskManager.summary.uiFps",
  "taskManager.signal.p95Value",
]);

function bucketForId(id: InterfaceMessageId): string {
  if (id.startsWith("panel.title.")) return "panel.title";
  return id.split(".")[0] ?? "unknown";
}

function sourceWordCount(text: string): number {
  return text.match(/[A-Za-z0-9]+(?:[-/][A-Za-z0-9]+)*/g)?.length ?? 0;
}

function emptyBucket(): BucketReport {
  return {
    missingStrings: 0,
    missingWords: 0,
    exactEnglishStrings: 0,
    exactEnglishWords: 0,
    missingSampleIds: [],
    exactEnglishSampleIds: [],
  };
}

function addMissing(buckets: Record<string, BucketReport>, id: InterfaceMessageId): number {
  const bucketName = bucketForId(id);
  const bucket = buckets[bucketName] ?? emptyBucket();
  const words = sourceWordCount(enMessages[id]);
  bucket.missingStrings += 1;
  bucket.missingWords += words;
  if (bucket.missingSampleIds.length < 10) bucket.missingSampleIds.push(id);
  buckets[bucketName] = bucket;
  return words;
}

function addExactEnglish(buckets: Record<string, BucketReport>, id: InterfaceMessageId): number {
  const bucketName = bucketForId(id);
  const bucket = buckets[bucketName] ?? emptyBucket();
  const words = sourceWordCount(enMessages[id]);
  bucket.exactEnglishStrings += 1;
  bucket.exactEnglishWords += words;
  if (bucket.exactEnglishSampleIds.length < 10) bucket.exactEnglishSampleIds.push(id);
  buckets[bucketName] = bucket;
  return words;
}

const locales: LocaleReport[] = INTERFACE_TARGET_CATALOGS.map(({ code, catalog }) => {
  const buckets: Record<string, BucketReport> = {};
  let missingStrings = 0;
  let missingWords = 0;
  let exactEnglishStrings = 0;
  let exactEnglishWords = 0;
  let approvedExactEnglishStrings = 0;
  const approvedExactEnglishSampleIds: InterfaceMessageId[] = [];

  for (const id of INTERFACE_MESSAGE_IDS) {
    if (!(id in catalog)) {
      missingStrings += 1;
      missingWords += addMissing(buckets, id);
      continue;
    }
    if (catalog[id] !== enMessages[id]) continue;
    if (approvedExactEnglishIds.has(id)) {
      approvedExactEnglishStrings += 1;
      if (approvedExactEnglishSampleIds.length < 20) approvedExactEnglishSampleIds.push(id);
      continue;
    }
    exactEnglishStrings += 1;
    exactEnglishWords += addExactEnglish(buckets, id);
  }

  return {
    code,
    releaseStatus: isPublicInterfaceLanguageCode(code as SharedInterfaceLanguageCode)
      ? "public"
      : "developer_preview",
    targetMessages: Object.keys(catalog).length,
    sourceMessages: INTERFACE_MESSAGE_IDS.length,
    missingStrings,
    missingWords,
    exactEnglishStrings,
    exactEnglishWords,
    approvedExactEnglishStrings,
    approvedExactEnglishIds: approvedExactEnglishSampleIds,
    buckets: Object.fromEntries(
      Object.entries(buckets).sort(([, left], [, right]) =>
        (right.missingStrings + right.exactEnglishStrings) - (left.missingStrings + left.exactEnglishStrings),
      ),
    ),
  };
});

const hasBlockingGaps = locales.some(
  (locale) => locale.releaseStatus === "public" &&
    (locale.missingStrings > 0 || locale.exactEnglishStrings > 0),
);

const summary = {
  ok: !hasBlockingGaps,
  sourceMessages: INTERFACE_MESSAGE_IDS.length,
  metric: "Missing target rows plus non-approved exact-English target strings. Approved exact strings are stable placeholders, metric tokens, product names, or developer identifiers.",
  approvedExactEnglishIds: [...approvedExactEnglishIds].sort(),
  locales,
};

console.log(JSON.stringify(summary, null, 2));

if (hasBlockingGaps) {
  process.exit(1);
}
