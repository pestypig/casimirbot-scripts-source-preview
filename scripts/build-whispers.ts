import fs from "node:fs/promises";
import path from "node:path";
import glob from "fast-glob";
import matter from "gray-matter";
import { LumaWhisperList } from "../shared/whispers";

const ROOT = process.cwd();
const SOURCES = [
  "docs/**/*.md",
  "client/**/*.ts{,x}",
  "server/**/*.ts",
  "shared/**/*.ts",
];

type PartialWhisper = {
  id: string;
  moral: string;
  body: string;
  action?: string;
  tags?: string[];
  hashes?: string[];
  severity?: "hint" | "info" | "warn";
  mode?: "bubble" | "speak" | "both";
  rule?: Record<string, unknown>;
  refs?: string[];
  score?: number;
};

const DELIVERY_MODES = new Set(["bubble", "speak", "both"]);
const SEVERITIES = new Set(["hint", "info", "warn"]);

function toStringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const collected = value
    .map((entry) => toStringValue(entry))
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return collected.length ? collected : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toPartial(payload: Record<string, unknown>): PartialWhisper | null {
  const id = toStringValue(payload.id);
  if (!id) return null;

  const text = isRecord(payload.text) ? payload.text : undefined;
  const moral =
    toStringValue(payload.moral) ??
    (text ? toStringValue(text.moral) ?? toStringValue(text.title) : undefined);
  const body =
    toStringValue(payload.body) ??
    toStringValue(payload.physics) ??
    (text ? toStringValue(text.physics) ?? toStringValue(text.body) : undefined);

  if (!moral || !body) return null;

  const rule = isRecord(payload.rule) ? (payload.rule as Record<string, unknown>) : undefined;
  const hashes =
    toStringArray(payload.hashes) ??
    toStringArray((payload as Record<string, unknown>).panelHint) ??
    (rule ? toStringArray((rule as Record<string, unknown>).anyHash) : undefined);

  const action =
    toStringValue(payload.action) ??
    (text ? toStringValue(text.action) ?? toStringValue((text as any).cta) : undefined);

  const tags = toStringArray(payload.tags);
  const refs = toStringArray(payload.refs);
  const severityRaw = toStringValue(payload.severity)?.toLowerCase();
  const severity = severityRaw && SEVERITIES.has(severityRaw) ? (severityRaw as any) : undefined;
  const modeRaw = toStringValue(payload.mode)?.toLowerCase();
  const mode = modeRaw && DELIVERY_MODES.has(modeRaw) ? (modeRaw as any) : undefined;
  const score = typeof payload.score === "number" ? payload.score : undefined;

  return {
    id,
    moral,
    body,
    action: action && action.length ? action : undefined,
    tags,
    hashes,
    severity,
    mode,
    rule,
    refs,
    score,
  };
}

function sniffCodeWhispers(code: string): PartialWhisper[] {
  const out: PartialWhisper[] = [];
  const re = /^\/{3}\s*luma:\s*(\{[\s\S]*?\})\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    try {
      const payload = JSON.parse(m[1]) as Record<string, unknown>;
      const partial = toPartial(payload);
      if (partial) {
        out.push(partial);
      }
    } catch {
      // ignore malformed inline payloads so the script keeps going
    }
  }
  return out;
}

async function run() {
  const entries = await glob(SOURCES, { cwd: ROOT, absolute: true, dot: false });
  const bag: PartialWhisper[] = [];

  for (const file of entries) {
    const raw = await fs.readFile(file, "utf8");
    if (file.endsWith(".md")) {
      let content = raw;
      try {
        const mm = matter(raw);
        content = mm.content;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `warn: could not parse front matter for ${path.relative(ROOT, file)} (${message})`,
        );
      }
      const blockRe = /```whisper\s+([\s\S]*?)```/g;
      const directiveRe = /::: whisper[^\n]*\n([\s\S]*?)\n:::\s*/g;
      const pushData = (data: Record<string, unknown>) => {
        const partial = toPartial(data);
        if (partial) {
          bag.push(partial);
        }
      };
      let block: RegExpExecArray | null;
      while ((block = blockRe.exec(content))) {
        const yamlSource = `---\n${block[1]}\n---`;
        try {
          const data = matter(yamlSource).data as Record<string, unknown>;
          pushData(data);
        } catch {
          // swallow malformed whisper blocks; they can be fixed later
        }
      }
      let directive: RegExpExecArray | null;
      while ((directive = directiveRe.exec(content))) {
        const yamlSource = `---\n${directive[1]}\n---`;
        try {
          const data = matter(yamlSource).data as Record<string, unknown>;
          pushData(data);
        } catch {
          // ignore malformed directive blocks
        }
      }
    } else {
      bag.push(...sniffCodeWhispers(raw));
    }
  }

  const seen = new Set<string>();
  const list = bag
    .filter((entry) => {
      if (!entry.id || seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .map((entry) => ({
      id: entry.id,
      tags: entry.tags ?? [],
      hashes: entry.hashes ?? [],
      severity: entry.severity ?? "hint",
      mode: entry.mode ?? "bubble",
      moral: entry.moral,
      body: entry.body,
      action: entry.action,
      score:
        typeof entry.score === "number"
          ? Math.max(0, Math.min(1, entry.score))
          : 0.5,
      rule: entry.rule ?? {},
      refs: entry.refs ?? [],
      source: "local" as const,
    }));

  const parsed = LumaWhisperList.parse(list);
  const outDir = path.join(ROOT, "server/_generated");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, "luma-whispers.json"),
    JSON.stringify(parsed, null, 2),
    "utf8",
  );
  const publicDir = path.join(ROOT, "client/public");
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(
    path.join(publicDir, "luma-whispers.local.json"),
    JSON.stringify(parsed, null, 2),
    "utf8",
  );
  console.log(`🌓 built ${parsed.length} whispers`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
