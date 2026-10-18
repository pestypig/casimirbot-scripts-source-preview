import { INTERFACE_LANGUAGE_OPTIONS } from "../client/src/lib/i18n/interfaceLanguage";
import { enMessages } from "../client/src/lib/i18n/messages/en";
import { INTERFACE_TARGET_CATALOGS } from "../client/src/lib/i18n/messages/targetCatalogs";
import {
  INTERFACE_MESSAGE_IDS,
  interfaceSourceMessages,
  type InterfaceMessageId,
  type InterfaceTargetCatalog,
} from "../client/src/lib/i18n/messages/types";

type Issue = {
  level: "error" | "warning";
  message: string;
};

const placeholderPattern = /\{([a-zA-Z0-9_]+)\}/g;
const placeholderTranslationPattern =
  /^(?:Arabi|Deutsch|Espanol|Francais|Hawaiian|Nihongo|Hangugeo|Wolof|Zhongwen):\s|^(?:AR|ES|FR|JA|KO|PT|WO|ZH)\s/;

function placeholders(text: string): string[] {
  return [...text.matchAll(placeholderPattern)].map((match) => match[1]).sort();
}

function hasBalancedBraces(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function compareArrays(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function auditTargetCatalog(args: {
  locale: string;
  catalog: InterfaceTargetCatalog<InterfaceMessageId>;
  source: Record<InterfaceMessageId, string>;
}): Issue[] {
  const issues: Issue[] = [];
  const sourceIds = new Set(INTERFACE_MESSAGE_IDS);
  for (const id of Object.keys(args.catalog)) {
    if (!sourceIds.has(id as InterfaceMessageId)) {
      issues.push({ level: "error", message: `${args.locale}: orphan target message id ${id}` });
    }
  }

  for (const id of INTERFACE_MESSAGE_IDS) {
    const target = args.catalog[id];
    if (target === undefined) continue;
    if (!target.trim()) {
      issues.push({ level: "error", message: `${args.locale}: empty translation for ${id}` });
    }
    if (/\?{3,}|(?:\?\s*){2,}/.test(target)) {
      issues.push({ level: "error", message: `${args.locale}: likely mojibake replacement question marks in ${id}` });
    }
    if (placeholderTranslationPattern.test(target)) {
      issues.push({ level: "error", message: `${args.locale}: placeholder-style translation for ${id}` });
    }
    if (!hasBalancedBraces(target)) {
      issues.push({ level: "error", message: `${args.locale}: invalid brace pattern for ${id}` });
    }
    const sourcePlaceholders = placeholders(args.source[id]);
    const targetPlaceholders = placeholders(target);
    if (!compareArrays(sourcePlaceholders, targetPlaceholders)) {
      issues.push({
        level: "error",
        message: `${args.locale}: placeholder mismatch for ${id}; source=${sourcePlaceholders.join(",")} target=${targetPlaceholders.join(",")}`,
      });
    }
    if (args.locale === "haw" && /[A-Za-z]'[A-Za-z]/.test(target)) {
      issues.push({
        level: "error",
        message: `${args.locale}: ASCII apostrophe found inside Hawaiian word for ${id}; use okina U+02BB when intended`,
      });
    }
    if (id.startsWith("panel.title.") && target === args.source[id]) {
      issues.push({
        level: "error",
        message: `${args.locale}: panel title ${id} is still identical to English source`,
      });
    }
  }
  return issues;
}

const sourceIds = new Set(INTERFACE_MESSAGE_IDS);
const metaIds = new Set(Object.keys(interfaceSourceMessages));
const issues: Issue[] = [];

for (const id of sourceIds) {
  const meta = interfaceSourceMessages[id];
  if (!metaIds.has(id)) {
    issues.push({ level: "error", message: `missing source metadata for ${id}` });
  }
  if (meta.id !== id) {
    issues.push({ level: "error", message: `source metadata id mismatch for ${id}` });
  }
  if (!meta.defaultMessage.trim()) {
    issues.push({ level: "error", message: `empty default English source message for ${id}` });
  }
  if (!hasBalancedBraces(meta.defaultMessage)) {
    issues.push({ level: "error", message: `invalid brace pattern in source message ${id}` });
  }
  const declaredPlaceholders = Object.keys(meta.placeholders ?? {}).sort();
  const actualPlaceholders = placeholders(meta.defaultMessage);
  if (!compareArrays(declaredPlaceholders, actualPlaceholders)) {
    issues.push({
      level: "error",
      message: `source placeholder metadata mismatch for ${id}; declared=${declaredPlaceholders.join(",")} actual=${actualPlaceholders.join(",")}`,
    });
  }
  if (enMessages[id] !== meta.defaultMessage) {
    issues.push({ level: "error", message: `English catalog drift for ${id}` });
  }
}

for (const id of Object.keys(enMessages)) {
  if (!sourceIds.has(id as InterfaceMessageId)) {
    issues.push({ level: "error", message: `English catalog orphan message id ${id}` });
  }
}

for (const { code, catalog } of INTERFACE_TARGET_CATALOGS) {
  issues.push(
    ...auditTargetCatalog({
      locale: code,
      catalog,
      source: enMessages,
    }),
  );
}

const total = INTERFACE_MESSAGE_IDS.length;
const reviewedByLocale: Record<string, number> = {};
for (const { code, catalog } of INTERFACE_TARGET_CATALOGS) {
  const reviewed = Object.keys(catalog).length;
  reviewedByLocale[code] = reviewed;
  const option = INTERFACE_LANGUAGE_OPTIONS.find((entry) => entry.code === code);
  if (!option) {
    issues.push({ level: "error", message: `${code}: missing language option` });
    continue;
  }
  if (option.translationMode !== "procedural_catalog") {
    issues.push({ level: "error", message: `${code}: target option must use procedural_catalog` });
  }
  if (reviewed < total) {
    issues.push({
      level: option.releaseStatus === "public" ? "error" : "warning",
      message: `${code}: missing ${total - reviewed} target messages`,
    });
  }
  if (reviewed < total && option.readiness.toLowerCase().includes("complete")) {
    issues.push({ level: "error", message: `${code}: readiness cannot claim complete coverage while catalog is partial` });
  }
}

const errors = issues.filter((issue) => issue.level === "error");
const summary = {
  ok: errors.length === 0,
  source_messages: total,
  target_catalog_messages: reviewedByLocale,
  issues,
};

if (errors.length > 0) {
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(summary, null, 2));
