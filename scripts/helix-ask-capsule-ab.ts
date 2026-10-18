import fs from "node:fs/promises";
import path from "node:path";

type AskResponse = {
  text?: string;
  context_capsule?: { capsuleId?: string | null; fingerprint?: string | null } | null;
  debug?: Record<string, unknown> | null;
};

type CapsuleMemoryDebug = {
  requested?: string[];
  applied?: string[];
  inactive?: string[];
  missing?: string[];
};

const BASE_URL = process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:5050";
const TIMEOUT_MS = Math.max(5000, Number(process.env.HELIX_ASK_CAPSULE_AB_TIMEOUT_MS ?? 45000));
const MAX_TOKENS = Math.max(120, Number(process.env.HELIX_ASK_CAPSULE_AB_MAX_TOKENS ?? 320));
const OUT_ROOT =
  process.env.HELIX_ASK_CAPSULE_AB_OUT ??
  "artifacts/experiments/helix-ask-capsule-ab";

const DEFAULT_SEED_QUESTION =
  "In this repository, where is GET /api/helix/capsule/:capsuleId implemented? Return path and purpose.";
const SEED_QUESTION = (process.env.HELIX_ASK_CAPSULE_AB_SEED_QUESTION ?? DEFAULT_SEED_QUESTION).trim();

const DEFAULT_PROMPTS = [
  "Summarize the return payload fields of that endpoint.",
  "What are the replay safety rules for using this artifact?",
  "How does this connect to the ask input flow?",
];
const PROMPTS = (
  process.env.HELIX_ASK_CAPSULE_AB_PROMPTS?.split("||").map((entry) => entry.trim()).filter(Boolean) ??
  DEFAULT_PROMPTS
).slice(0, 8);

const KEYWORDS = (
  process.env.HELIX_ASK_CAPSULE_AB_KEYWORDS ??
  "capsule,context,replay,provenance,proof,session,memory"
)
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
};

const clip = (value: string, max = 220): string => {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
};

const focusScore = (text: string): number => {
  if (KEYWORDS.length === 0) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const keyword of KEYWORDS) {
    if (lower.includes(keyword)) hits += 1;
  }
  return hits / KEYWORDS.length;
};

const ask = async (args: {
  question: string;
  sessionId: string;
  capsuleIds?: string[];
}): Promise<AskResponse> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(new URL("/api/agi/ask", BASE_URL), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        question: args.question,
        sessionId: args.sessionId,
        debug: true,
        max_tokens: MAX_TOKENS,
        capsuleIds: args.capsuleIds,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = await response.text().catch(() => "");
      throw new Error(`ask_failed status=${response.status} body=${payload.slice(0, 240)}`);
    }
    return (await response.json()) as AskResponse;
  } finally {
    clearTimeout(timeout);
  }
};

const extractCapsuleId = (response: AskResponse): string | null => {
  const fingerprint = response.context_capsule?.fingerprint;
  if (typeof fingerprint === "string" && fingerprint.trim()) return fingerprint.trim().toUpperCase();
  const top = response.context_capsule?.capsuleId;
  if (typeof top === "string" && top.trim()) return top.trim().toUpperCase();
  const debug = asRecord(response.debug);
  const debugId = asString(debug?.context_capsule_id);
  return debugId.trim() ? debugId.trim().toUpperCase() : null;
};

const extractCapsuleMemory = (response: AskResponse): CapsuleMemoryDebug => {
  const debug = asRecord(response.debug);
  const memory = asRecord(debug?.context_capsule_memory);
  return {
    requested: asStringArray(memory?.requested),
    applied: asStringArray(memory?.applied),
    inactive: asStringArray(memory?.inactive),
    missing: asStringArray(memory?.missing),
  };
};

const extractSessionMemoryUsed = (response: AskResponse): boolean => {
  const debug = asRecord(response.debug);
  return debug?.session_memory_used === true;
};

const extractTopSources = (response: AskResponse): string[] => {
  const debug = asRecord(response.debug);
  return asStringArray(debug?.context_files).slice(0, 6);
};

async function main(): Promise<void> {
  if (!SEED_QUESTION) {
    throw new Error("seed question required");
  }
  if (PROMPTS.length === 0) {
    throw new Error("at least one prompt required");
  }

  const runId = `capsule-ab-${Date.now()}`;
  const runDir = path.join(OUT_ROOT, runId);
  await fs.mkdir(runDir, { recursive: true });

  const seed = await ask({
    question: SEED_QUESTION,
    sessionId: `${runId}:seed`,
  });
  const capsuleId = extractCapsuleId(seed);
  if (!capsuleId) {
    throw new Error("seed response missing context capsule id");
  }

  const cases: Array<Record<string, unknown>> = [];
  for (let i = 0; i < PROMPTS.length; i += 1) {
    const prompt = PROMPTS[i] ?? "";
    const baseline = await ask({
      question: prompt,
      sessionId: `${runId}:base:${i}`,
    });
    const withCapsule = await ask({
      question: prompt,
      sessionId: `${runId}:capsule:${i}`,
      capsuleIds: [capsuleId],
    });

    const baselineText = asString(baseline.text);
    const capsuleText = asString(withCapsule.text);
    const baselineScore = focusScore(baselineText);
    const capsuleScore = focusScore(capsuleText);
    const memory = extractCapsuleMemory(withCapsule);
    const applied = (memory.applied ?? []).includes(capsuleId);

    cases.push({
      index: i + 1,
      prompt,
      baseline: {
        focus_score: Number(baselineScore.toFixed(4)),
        session_memory_used: extractSessionMemoryUsed(baseline),
        top_sources: extractTopSources(baseline),
        text_preview: clip(baselineText),
      },
      with_capsule: {
        focus_score: Number(capsuleScore.toFixed(4)),
        session_memory_used: extractSessionMemoryUsed(withCapsule),
        capsule_memory: memory,
        capsule_applied: applied,
        top_sources: extractTopSources(withCapsule),
        text_preview: clip(capsuleText),
      },
      delta_focus: Number((capsuleScore - baselineScore).toFixed(4)),
    });
  }

  const avg = (values: number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

  const baselineScores = cases.map((entry) => Number(entry.baseline?.focus_score ?? 0));
  const capsuleScores = cases.map((entry) => Number(entry.with_capsule?.focus_score ?? 0));
  const appliedCount = cases.filter((entry) => entry.with_capsule?.capsule_applied === true).length;
  const summary = {
    run_id: runId,
    base_url: BASE_URL,
    seed_question: SEED_QUESTION,
    capsule_id: capsuleId,
    prompt_count: cases.length,
    keyword_set: KEYWORDS,
    avg_focus_baseline: Number(avg(baselineScores).toFixed(4)),
    avg_focus_with_capsule: Number(avg(capsuleScores).toFixed(4)),
    avg_focus_delta: Number((avg(capsuleScores) - avg(baselineScores)).toFixed(4)),
    capsule_applied_rate: Number((appliedCount / Math.max(1, cases.length)).toFixed(4)),
  };

  const payload = {
    summary,
    cases,
  };
  const reportPath = path.join(runDir, "report.json");
  await fs.writeFile(reportPath, JSON.stringify(payload, null, 2), "utf8");

  const markdown = [
    `# Helix Ask Capsule A/B (${runId})`,
    "",
    `- base_url: ${BASE_URL}`,
    `- capsule_id: ${capsuleId}`,
    `- prompt_count: ${cases.length}`,
    `- avg_focus_baseline: ${summary.avg_focus_baseline}`,
    `- avg_focus_with_capsule: ${summary.avg_focus_with_capsule}`,
    `- avg_focus_delta: ${summary.avg_focus_delta}`,
    `- capsule_applied_rate: ${summary.capsule_applied_rate}`,
    "",
    "## Cases",
    ...cases.map((entry) =>
      `- [${entry.index}] ${entry.prompt}\n  - baseline_focus=${entry.baseline?.focus_score} with_capsule_focus=${entry.with_capsule?.focus_score} delta=${entry.delta_focus}\n  - applied=${entry.with_capsule?.capsule_applied} session_memory_used=${entry.with_capsule?.session_memory_used}`,
    ),
    "",
  ].join("\n");
  const markdownPath = path.join(runDir, "report.md");
  await fs.writeFile(markdownPath, markdown, "utf8");

  process.stdout.write(
    `[capsule-ab] run=${runId} prompts=${cases.length} capsule=${capsuleId} avg_delta=${summary.avg_focus_delta} applied_rate=${summary.capsule_applied_rate}\n`,
  );
  process.stdout.write(`[capsule-ab] artifacts: ${runDir}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[capsule-ab] failed: ${message}\n`);
  process.exitCode = 1;
});
