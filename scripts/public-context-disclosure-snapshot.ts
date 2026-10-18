import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadPublicBadgeCatalog, type PublicBadge, type PublicLens } from "../server/services/public-context/catalog";

// The snapshot is a review packet, not a declaration of owner approval.
const target = resolve("docs/evidence/public-context-badge-disclosure-snapshot.json");
const csvTarget = resolve("docs/evidence/public-context-badge-disclosure-snapshot.csv");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Owner approved this exact projection in the task conversation on 2026-10-14.
// A changed public field yields a different digest and returns review to pending.
const ownerApprovedProjectionSha256 = "a60541aa44a8c50adb126562d566116367a1b7dc567613bc1ae603319418c165";
const csvCell = (value: string): string => {
  const safe = /^[=+@-]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
};
const lenses: PublicLens[] = ["civilization", "theory", "moral"];
const privatePattern = /(?:(?:^|[\s('"])[A-Z]:[\\/]|file:\/\/|localhost|127\.0\.0\.1|(?:^|[\s('"])(?:artifacts|server|client)\/|\bBearer\s+\S+|(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|[?&](?:token|key|secret|auth)=)/i;

async function main() {
  const catalog = await loadPublicBadgeCatalog();
  const seen = new Set<string>();
  const entries = lenses.flatMap((lens) => catalog[lens].map((badge: PublicBadge) => {
    const key = `${lens}/${badge.id}`;
    if (seen.has(key)) throw new Error(`duplicate_public_badge:${key}`);
    seen.add(key);
    for (const field of [badge.id, badge.title, badge.summary, badge.status,
      ...badge.uncertainty, ...badge.source_refs, ...badge.claim_boundaries]) {
      if (privatePattern.test(field)) throw new Error(`private_field_candidate:${key}`);
    }
    if (!badge.id || !badge.title || !badge.summary || !badge.status ||
        !badge.uncertainty.length || !badge.claim_boundaries.length) {
      throw new Error(`missing_public_field:${key}`);
    }
    if (badge.source_refs.some((ref) => /^(?:https?:\/\/)/.test(ref) && !/^https:\/\//.test(ref))) {
      throw new Error(`insecure_source_reference:${key}`);
    }
    const review_flags = [
      ...(!badge.source_refs.length ? ["no_public_source_reference"] : []),
      ...(/\b(?:certified|proof|pilot|physical|propulsion|transport)\b/i.test(badge.summary)
        ? ["authority_sensitive_summary"] : []),
    ];
    return { lens, ...badge, projection_sha256: digest(badge), review_flags,
      automated_disclosure: "screened: public fields, source protocol, and local-path/credential pattern",
      owner_disclosure_review: "pending" as "pending" | "approved" };
  }));
  const projectionSha256 = digest(entries.map(({ lens, projection_sha256 }) => [lens, projection_sha256]));
  const ownerReview: "pending" | "approved" = projectionSha256 === ownerApprovedProjectionSha256 ? "approved" : "pending";
  for (const entry of entries) entry.owner_disclosure_review = ownerReview;
  const snapshot = {
    schema: "casimirbot.public_badge_disclosure_snapshot.v1",
    counts: Object.fromEntries(lenses.map((lens) => [lens, catalog[lens].length])),
    projection_sha256: projectionSha256,
    owner_disclosure_review: ownerReview,
    entries,
  };
  const columns = ["lens", "id", "title", "summary", "status", "uncertainty", "source_refs",
    "claim_boundaries", "review_flags", "projection_sha256", "owner_disclosure_review"] as const;
  const csv = `${columns.join(",")}\n${entries.map((entry) => columns.map((column) => {
    const value = entry[column];
    return csvCell(Array.isArray(value) ? value.join(" | ") : String(value));
  }).join(",")).join("\n")}\n`;
  if (process.argv.includes("--write")) {
    await writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await writeFile(csvTarget, csv, "utf8");
  } else {
    const saved = JSON.parse(await readFile(target, "utf8"));
    if (JSON.stringify(saved) !== JSON.stringify(snapshot)) throw new Error("public_badge_snapshot_drift");
    if (await readFile(csvTarget, "utf8") !== csv) throw new Error("public_badge_csv_drift");
  }
  console.log(JSON.stringify({ counts: snapshot.counts, projection_sha256: snapshot.projection_sha256,
    owner_disclosure_review: snapshot.owner_disclosure_review, snapshot: target }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
