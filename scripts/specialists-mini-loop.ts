/**
 * Run AGI specialists against the seed pack and emit NDJSON metrics.
 * Hull-mode friendly: only talks to the local API route.
 */
import { performance } from "node:perf_hooks";

type RunReq = {
  goal: string;
  personaId: string;
  solver: string;
  verifier: string;
  params: Record<string, unknown>;
};

type RunRes = {
  ok: boolean;
  tries?: number;
  result?: { answer?: unknown; essence?: { steps?: string[] } };
  verify?: { ok: boolean; signals?: Record<string, number | boolean>; notes?: string[] };
  essence_id?: string;
};

type SeedDomain = "math" | "code" | "philo";

type Seed = {
  domain: SeedDomain;
  task_id?: string;
  prompt?: string;
  text?: string;
  question?: string;
  criteria?: string[];
  [key: string]: unknown;
};

const BASE = (process.env.EVAL_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const PERSONA = process.env.DEFAULT_PERSONA_ID || "persona:demo";
const SEED_PATH = process.env.SPECIALISTS_TASKS || "server/specialists/tasks.seed.json";
const OUT = process.stdout;

const MAP: Record<SeedDomain, (s: Seed) => RunReq> = {
  math: (s) => ({
    goal: "Solve math word problem",
    personaId: PERSONA,
    solver: "math.word",
    verifier: "math.word.verify",
    params: { prompt: (s.text || s.prompt || "").toString() }
  }),
  code: (s) => ({
    goal: "Code: isBalanced",
    personaId: PERSONA,
    solver: "code.isBalanced",
    verifier: "code.isBalanced.verify",
    params: { prompt: (s.prompt || "Implement isBalanced(s) for (), {}, []").toString() }
  }),
  philo: (s) => ({
    goal: "Philosophy synthesis",
    personaId: PERSONA,
    solver: "philo.synthesis",
    verifier: "philo.synthesis.verify",
    params: {
      question: (s.prompt || s.question || "").toString(),
      criteria: Array.isArray(s.criteria) ? s.criteria : []
    }
  })
};

function positiveSignals(sig: Record<string, number | boolean> = {}) {
  const entries = Object.entries(sig);
  if (!entries.length) {
    return { pos: 0, total: 0 };
  }
  let pos = 0;
  for (const [, value] of entries) {
    if (typeof value === "number" && value > 0) pos += 1;
    if (typeof value === "boolean" && value) pos += 1;
  }
  return { pos, total: entries.length };
}

async function readSeeds(path: string): Promise<Seed[]> {
  const globalAny = globalThis as Record<string, unknown>;
  if (typeof globalAny.Bun !== "undefined" && typeof (globalAny.Bun as any).file === "function") {
    const text = await (globalAny.Bun as any).file(path).text();
    return JSON.parse(text);
  }
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}

async function runOne(req: RunReq): Promise<RunRes> {
  const url = `${BASE}/api/agi/specialists/run`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req)
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${url}`);
  }
  return res.json();
}

function gatesSatisfied() {
  const gates: Array<[string, string]> = [
    ["ENABLE_ESSENCE", "1"],
    ["ENABLE_AGI", "1"],
    ["ENABLE_SPECIALISTS", "1"]
  ];
  const missing = gates
    .filter(([key, val]) => (process.env[key] || "").trim() !== val)
    .map(([key]) => key);
  if (missing.length) {
    OUT.write(
      JSON.stringify({
        ok: false,
        skipped: true,
        reason: `enable gates: ${missing.join(", ")}`
      }) + "\n"
    );
    return false;
  }
  return true;
}

async function main() {
  if (!gatesSatisfied()) {
    return;
  }

  const seeds = await readSeeds(SEED_PATH);
  const start = Date.now();

  for (const seed of seeds) {
    const mk = MAP[seed.domain as SeedDomain];
    if (!mk) {
      OUT.write(
        JSON.stringify({ ok: false, domain: seed.domain, task_id: seed.task_id || null, error: "unknown_domain" }) +
          "\n"
      );
      continue;
    }

    const req = mk(seed);
    const t0 = performance.now();

    try {
      const out = await runOne(req);
      const steps = out?.result?.essence?.steps || [];
      const { pos, total } = positiveSignals(out?.verify?.signals || {});
      const proof_density = total > 0 ? pos / total : 0;
      const latency_ms = Math.round(performance.now() - t0);

      OUT.write(
        JSON.stringify({
          domain: seed.domain,
          task_id: seed.task_id || null,
          ok: !!out?.ok,
          tries: out?.tries ?? null,
          signals: out?.verify?.signals || {},
          essence_len: steps.length,
          proof_density,
          latency_ms
        }) + "\n"
      );
    } catch (error) {
      OUT.write(
        JSON.stringify({
          domain: seed.domain,
          task_id: seed.task_id || null,
          ok: false,
          error: String(error)
        }) + "\n"
      );
    }
  }

  const elapsed_ms = Date.now() - start;
  OUT.write(JSON.stringify({ summary: true, elapsed_ms }) + "\n");
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error) }));
  process.exit(1);
});
