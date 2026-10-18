import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

type VariantId =
  | "A_deterministic_core"
  | "B_det_cards_llm_contract"
  | "C_llm_cards_det_contract"
  | "D_current_adaptive"
  | "E_det_e2e_with_optional_narration";

type PromptEntry = {
  prompt_id: string;
  category: "crossover" | "definition" | "noisy";
  text: string;
  requires_constraint_frame: boolean;
};

type RunRecord = {
  variant: VariantId;
  prompt_id: string;
  category: PromptEntry["category"];
  seed: number;
  request: Record<string, unknown>;
  responseStatus: number;
  duration_ms: number;
  ok: boolean;
  response: any;
  error?: string;
};

type Aggregate = {
  variant: VariantId;
  sample_count: number;
  ok_rate: number;
  p95_latency_ms: number;
  avg_latency_ms: number;
  infra_fail_rate: number;
  parse_fail_rate: number;
  deterministic_fallback_rate: number;
  evidence_gate_pass_rate: number;
  slot_coverage_pass_rate: number;
  claim_support_ratio_mean: number;
  citation_validity_rate: number;
  crossover_completeness_mean: number;
  successful_samples_only: {
    count: number;
    citation_validity_rate: number;
    crossover_completeness_mean: number;
    claim_support_ratio_mean: number;
  };
};

const BASE = process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:5173";
const ASK_URL = `${BASE}/api/agi/ask`;
const ROOT = process.cwd();
const ART_BASE = path.join(ROOT, "artifacts/experiments/helix-ask-crossover");
const PROMPTS_PATH = path.join(ART_BASE, "prompts.jsonl");
const SUMMARY_PATH = path.join(ART_BASE, "summary.json");
const RECO_PATH = path.join(ART_BASE, "recommendation.json");
const REPORT_PATH = path.join(ROOT, "reports/helix-ask-crossover-ablation-report.md");
const DOC_PATH = path.join(ROOT, "docs/experiments/helix-ask-crossover-ablation.md");

const SEEDS = [7, 11, 13];
const TEMP = 0.2;

const VARIANTS: Array<{ id: VariantId; env: Record<string, string> }> = [
  {
    id: "A_deterministic_core",
    env: {
      HELIX_ASK_EVIDENCE_CARDS_LLM: "0",
      HELIX_ASK_ANSWER_CONTRACT_PRIMARY: "0",
    },
  },
  {
    id: "B_det_cards_llm_contract",
    env: {
      HELIX_ASK_EVIDENCE_CARDS_LLM: "0",
      HELIX_ASK_ANSWER_CONTRACT_PRIMARY: "1",
    },
  },
  {
    id: "C_llm_cards_det_contract",
    env: {
      HELIX_ASK_EVIDENCE_CARDS_LLM: "1",
      HELIX_ASK_ANSWER_CONTRACT_PRIMARY: "0",
    },
  },
  {
    id: "D_current_adaptive",
    env: {},
  },
  {
    id: "E_det_e2e_with_optional_narration",
    env: {
      HELIX_ASK_EVIDENCE_CARDS_LLM: "0",
      HELIX_ASK_ANSWER_CONTRACT_PRIMARY: "0",
      HELIX_ASK_OPTIONAL_NARRATION_PASS: "1",
    },
  },
];

const q = (arr: number[], p: number): number => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = p * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo] ?? 0;
  const w = idx - lo;
  return (s[lo] ?? 0) * (1 - w) + (s[hi] ?? 0) * w;
};

const mean = (arr: number[]): number => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

const classifyFailureSignature = (row: RunRecord): string => {
  const payload = JSON.stringify(row.response ?? {}).toLowerCase();
  if (!row.ok || row.responseStatus >= 500 || payload.includes("temporarily_unavailable") || payload.includes("circuit")) return "infra_unavailable";
  if (payload.includes("timeout")) return "infra_timeout";
  if (payload.includes("schema")) return "schema_error";
  if (payload.includes("parse_fail")) return "parse_fail";
  if (payload.includes("validation") || payload.includes("gate")) return "validation_fail";
  if (payload.includes("low_evidence")) return "low_evidence_utilization";
  return "unknown_failure";
};

const bootstrapCI = (values: number[], iters = 1000): { mean: number; lo: number; hi: number } => {
  if (!values.length) return { mean: 0, lo: 0, hi: 0 };
  const boots: number[] = [];
  for (let i = 0; i < iters; i++) {
    const sample: number[] = [];
    for (let j = 0; j < values.length; j++) {
      sample.push(values[Math.floor(Math.random() * values.length)] ?? 0);
    }
    boots.push(mean(sample));
  }
  boots.sort((a, b) => a - b);
  return { mean: mean(values), lo: boots[Math.floor(0.025 * (boots.length - 1))] ?? 0, hi: boots[Math.floor(0.975 * (boots.length - 1))] ?? 0 };
};

const ensureDir = async (p: string) => fs.mkdir(p, { recursive: true });

const fileExists = async (p: string) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

function buildPrompts(): PromptEntry[] {
  const out: PromptEntry[] = [];
  const conn = ["connected", "linked", "tied", "associated"];
  for (let i = 1; i <= 40; i++) {
    const v = conn[(i - 1) % conn.length];
    const requires = i <= 20;
    out.push({
      prompt_id: `cross_${String(i).padStart(3, "0")}`,
      category: "crossover",
      requires_constraint_frame: requires,
      text: `In this repo, how is warp bubble mechanics ${v} to mission ethos, and what falsifiable constraint checks should be used before claiming viability? Give repo-grounded explanation.`,
    });
  }
  for (let i = 1; i <= 40; i++) {
    const requires = i <= 10;
    out.push({
      prompt_id: `def_${String(i).padStart(3, "0")}`,
      category: "definition",
      requires_constraint_frame: requires,
      text: requires
        ? `Define the repo's handling of warp viability, certificate integrity, and first-fail constraint framing. Keep it file-grounded.`
        : `Define how Helix Ask routes repo-grounded prompts and returns debug/gate signals, with file-level grounding.`,
    });
  }
  const noisy = [
    "hw is warp tied 2 ethos + constraints??",
    "show me linked thing warp mission falsify pls",
    "repo where cert hash integrity first fail comes from??",
    "why ask says confidence if not certified?",
  ];
  for (let i = 1; i <= 40; i++) {
    const requires = i <= 15;
    const base = noisy[(i - 1) % noisy.length];
    out.push({
      prompt_id: `noisy_${String(i).padStart(3, "0")}`,
      category: "noisy",
      requires_constraint_frame: requires,
      text: requires
        ? `${base} include falsifiable constraints + gate/cert status plz`
        : `${base} repo grounded short answer`,
    });
  }
  return out;
}

async function writePromptPack(prompts: PromptEntry[]) {
  await ensureDir(path.dirname(PROMPTS_PATH));
  const body = prompts.map((p) => JSON.stringify(p)).join("\n") + "\n";
  await fs.writeFile(PROMPTS_PATH, body, "utf8");
}

async function readPromptPack(): Promise<PromptEntry[]> {
  const txt = await fs.readFile(PROMPTS_PATH, "utf8");
  return txt
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as PromptEntry);
}

async function waitUntilUp(timeoutMs = 240000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(ASK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "health check", debug: true, temperature: 0.1, topK: 2 }),
      });
      if (res.status >= 100) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("server startup timeout");
}

async function runVariant(variant: { id: VariantId; env: Record<string, string> }, prompts: PromptEntry[]): Promise<RunRecord[]> {
  const rawDir = path.join(ART_BASE, variant.id, "raw");
  await ensureDir(rawDir);

  const child = spawn("npm", ["run", "dev:agi:5173"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...variant.env,
      ENABLE_ESSENCE: "1",
      ENABLE_AGI: "1",
      PORT: "5173",
      DISABLE_VITE_HMR: "1",
      SKIP_VITE_MIDDLEWARE: "0",
      HELIX_ASK_FAILURE_MAX: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (d) => { if (process.env.ABLATION_VERBOSE === "1") process.stdout.write(String(d)); });
  child.stderr.on("data", (d) => { if (process.env.ABLATION_VERBOSE === "1") process.stderr.write(String(d)); });

  try {
    await waitUntilUp();
    const runs: RunRecord[] = [];
    for (const prompt of prompts) {
      for (const seed of SEEDS) {
        const reqBody: Record<string, unknown> = {
          question: prompt.text,
          debug: true,
          seed,
          temperature: TEMP,
          topK: 8,
          tuning: variant.id === "E_det_e2e_with_optional_narration" ? { narration_only: true } : undefined,
          sessionId: `ablation:${variant.id}:${seed}`,
        };
        const started = Date.now();
        let status = 0;
        let payload: any = null;
        let ok = false;
        let error: string | undefined;
        try {
          const res = await fetch(ASK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(reqBody),
          });
          status = res.status;
          payload = await res.json().catch(async () => ({ text: await res.text().catch(() => "") }));
          ok = res.ok;
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        const rec: RunRecord = {
          variant: variant.id,
          prompt_id: prompt.prompt_id,
          category: prompt.category,
          seed,
          request: reqBody,
          responseStatus: status,
          duration_ms: Date.now() - started,
          ok,
          response: payload,
          ...(error ? { error } : {}),
        };
        runs.push(rec);
        const fp = path.join(rawDir, `${prompt.prompt_id}__seed${seed}.json`);
        await fs.writeFile(fp, JSON.stringify(rec, null, 2), "utf8");
      }
    }
    return runs;
  } finally {
    child.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function extractStageLatency(debug: any, label: string): number {
  const timeline = Array.isArray(debug?.timeline) ? debug.timeline : [];
  const hit = timeline.find((e: any) => {
    const s = String(e?.stage ?? e?.name ?? "").toLowerCase();
    return s.includes(label);
  });
  const n = Number(hit?.duration_ms ?? hit?.ms ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function hasWarpMechanism(text: string): boolean {
  return /warp|natario|alcubierre|metric|bubble/i.test(text);
}
function hasMissionEthos(text: string): boolean {
  return /mission ethos|ethos|ideology|vow|stewardship/i.test(text);
}
function hasConnection(text: string): boolean {
  return /connected|linked|tied|associated|relation|bridge|maps to|because/i.test(text);
}
function hasConstraintFrame(text: string): boolean {
  return /constraint|falsif|firstfail|gate|certificate|integrity|admissible|not certified/i.test(text);
}

async function citationValidity(text: string): Promise<number> {
  const re = /\b(?:docs|server|client|shared|configs)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|md|json)\b/g;
  const matches = Array.from(new Set(text.match(re) ?? []));
  if (!matches.length) return 0;
  let ok = 0;
  for (const m of matches) {
    if (await fileExists(path.join(ROOT, m))) ok += 1;
  }
  return ok / matches.length;
}

async function aggregate(all: RunRecord[], prompts: PromptEntry[]) {
  const byVariant = new Map<VariantId, RunRecord[]>();
  for (const r of all) {
    const list = byVariant.get(r.variant) ?? [];
    list.push(r);
    byVariant.set(r.variant, list);
  }

  const aggregates: Aggregate[] = [];
  const stageLatency: Record<string, Record<string, number>> = {};
  const detailed: Record<string, any> = {};

  for (const [variant, rows] of byVariant.entries()) {
    const lat = rows.map((r) => Number(r.response?.duration_ms ?? r.duration_ms ?? 0)).filter((n) => Number.isFinite(n));
    const infraFails = rows.filter((r) => !r.ok || r.responseStatus >= 500).length;
    const parseFails = rows.filter((r) => r.ok && /parse_fail|schema_error|validation_fail/i.test(JSON.stringify(r.response ?? {}))).length;
    const fallback = rows.filter((r) => /deterministic.*fallback|fallback.*deterministic/i.test(JSON.stringify(r.response?.debug ?? {}))).length;

    const failureSignatureCounts = new Map<string, number>();
    for (const row of rows.filter((r) => !r.ok || r.responseStatus >= 400 || /parse_fail|schema|validation|timeout/i.test(JSON.stringify(r.response ?? {})))) {
      const key = classifyFailureSignature(row);
      failureSignatureCounts.set(key, (failureSignatureCounts.get(key) ?? 0) + 1);
    }

    const successfulRows = rows.filter((r) => r.ok && r.responseStatus < 400 && !/parse_fail/i.test(JSON.stringify(r.response ?? {})));

    const evidencePass = rows.filter((r) => r.response?.debug?.evidence_gate_ok === true).length;
    const slotPass = rows.filter((r) => {
      const d = r.response?.debug;
      return d?.coverage_gate_applied === false || (typeof d?.coverage_ratio === "number" && d.coverage_ratio >= 0.7);
    }).length;

    const claimRatios = rows
      .map((r) => Number(r.response?.debug?.evidence_claim_ratio ?? 0))
      .filter((n) => Number.isFinite(n));

    const citeVals: number[] = [];
    const completeScores: number[] = [];
    const successCiteVals: number[] = [];
    const successCompleteScores: number[] = [];
    const successClaimRatios: number[] = [];

    const stageCards: number[] = [];
    const stagePrimary: number[] = [];
    const stageRepair: number[] = [];
    const stagePlan: number[] = [];

    for (const r of rows) {
      const text = String(r.response?.text ?? "");
      citeVals.push(await citationValidity(text));
      const score = [hasWarpMechanism(text), hasMissionEthos(text), hasConnection(text), hasConstraintFrame(text)].filter(Boolean).length / 4;
      completeScores.push(score);
      if (r.ok && r.responseStatus < 400 && !/parse_fail/i.test(JSON.stringify(r.response ?? {}))) {
        successCiteVals.push(citeVals[citeVals.length - 1] ?? 0);
        successCompleteScores.push(score);
        const claimRatio = Number(r.response?.debug?.evidence_claim_ratio ?? 0);
        if (Number.isFinite(claimRatio)) successClaimRatios.push(claimRatio);
      }

      const dbg = r.response?.debug ?? {};
      stageCards.push(extractStageLatency(dbg, "evidence_cards"));
      stagePrimary.push(extractStageLatency(dbg, "answer_contract_primary"));
      stageRepair.push(extractStageLatency(dbg, "answer_contract_repair"));
      stagePlan.push(extractStageLatency(dbg, "plan"));
    }

    aggregates.push({
      variant,
      sample_count: rows.length,
      ok_rate: rows.length ? (rows.length - infraFails) / rows.length : 0,
      p95_latency_ms: q(lat, 0.95),
      avg_latency_ms: mean(lat),
      infra_fail_rate: rows.length ? infraFails / rows.length : 0,
      parse_fail_rate: rows.length ? parseFails / Math.max(1, rows.length - infraFails) : 0,
      deterministic_fallback_rate: rows.length ? fallback / rows.length : 0,
      evidence_gate_pass_rate: rows.length ? evidencePass / rows.length : 0,
      slot_coverage_pass_rate: rows.length ? slotPass / rows.length : 0,
      claim_support_ratio_mean: mean(claimRatios),
      citation_validity_rate: mean(citeVals),
      crossover_completeness_mean: mean(completeScores),
      successful_samples_only: {
        count: successfulRows.length,
        citation_validity_rate: mean(successCiteVals),
        crossover_completeness_mean: mean(successCompleteScores),
        claim_support_ratio_mean: mean(successClaimRatios),
      },
    });

    stageLatency[variant] = {
      llm_evidence_cards_ms_mean: mean(stageCards),
      llm_answer_contract_primary_ms_mean: mean(stagePrimary),
      llm_answer_contract_repair_ms_mean: mean(stageRepair),
      plan_pass_ms_mean: mean(stagePlan),
    };

    detailed[variant] = {
      stage_latency: stageLatency[variant],
      top_failure_signatures: Array.from(failureSignatureCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([signature, count]) => ({ signature, count, rate: rows.length ? count / rows.length : 0 })),
    };
  }

  const baseline = byVariant.get("D_current_adaptive") ?? [];
  const baselineMap = new Map(baseline.map((r) => [`${r.prompt_id}::${r.seed}`, r]));
  const deltas: Record<string, any> = {};

  for (const v of VARIANTS.map((x) => x.id)) {
    if (v === "D_current_adaptive") continue;
    const rows = byVariant.get(v) ?? [];
    const dQual: number[] = [];
    const dLat: number[] = [];
    for (const r of rows) {
      const key = `${r.prompt_id}::${r.seed}`;
      const b = baselineMap.get(key);
      if (!b) continue;
      const tR = String(r.response?.text ?? "");
      const tB = String(b.response?.text ?? "");
      const sR = [hasWarpMechanism(tR), hasMissionEthos(tR), hasConnection(tR), hasConstraintFrame(tR)].filter(Boolean).length / 4;
      const sB = [hasWarpMechanism(tB), hasMissionEthos(tB), hasConnection(tB), hasConstraintFrame(tB)].filter(Boolean).length / 4;
      dQual.push(sR - sB);
      const lr = Number(r.response?.duration_ms ?? r.duration_ms ?? 0);
      const lb = Number(b.response?.duration_ms ?? b.duration_ms ?? 0);
      if (Number.isFinite(lr) && Number.isFinite(lb)) dLat.push(lr - lb);
    }
    deltas[v] = {
      quality_delta: bootstrapCI(dQual),
      latency_delta_ms: bootstrapCI(dLat),
    };
  }

  const byId = Object.fromEntries(aggregates.map((a) => [a.variant, a]));
  const a = byId["A_deterministic_core"] as Aggregate | undefined;
  const d = byId["D_current_adaptive"] as Aggregate | undefined;
  const qualityGain = a && d ? (a.crossover_completeness_mean - d.crossover_completeness_mean) / Math.max(1e-9, d.crossover_completeness_mean) : 0;
  const latencyIncrease = a && d ? (a.p95_latency_ms - d.p95_latency_ms) / Math.max(1e-9, d.p95_latency_ms) : 0;

  const gate1 = qualityGain >= 0.05;
  const gate2 = latencyIncrease <= 0.15 && (a?.parse_fail_rate ?? 1) < 0.02;

  const recommendation = {
    commit: (await fs.readFile(path.join(ROOT, ".git/HEAD"), "utf8")).trim(),
    decision: gate1 && gate2 ? "promote_llm_heavy" : "default_deterministic",
    rationale: {
      quality_gain_vs_current_adaptive: qualityGain,
      p95_latency_increase_vs_current_adaptive: latencyIncrease,
      parse_fail_rate_A: a?.parse_fail_rate ?? null,
      gate_quality: gate1,
      gate_latency_cost: gate2,
    },
    preferred_default_variant: gate1 && gate2 ? "D_current_adaptive" : "A_deterministic_core",
  };

  const summary = {
    metadata: {
      endpoint: ASK_URL,
      generated_at: new Date().toISOString(),
      seeds: SEEDS,
      temperature: TEMP,
      prompt_count: prompts.length,
      run_count: all.length,
      variants: VARIANTS.map((v) => v.id),
      runtime: {
        node: process.version,
        platform: process.platform,
      },
    },
    aggregate: aggregates,
    stage_latency: stageLatency,
    paired_deltas_vs_D_current_adaptive: deltas,
    decision_gates: recommendation.rationale,
    detailed,
  };

  await fs.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2), "utf8");
  await fs.writeFile(RECO_PATH, JSON.stringify(recommendation, null, 2), "utf8");

  const report = `# Helix Ask Crossover Ablation Report

- Endpoint: POST /api/agi/ask
- Debug mode: true
- Prompt pack: artifacts/experiments/helix-ask-crossover/prompts.jsonl
- Prompts: ${prompts.length}
- Seeds: ${SEEDS.join(", ")}
- Variants: ${VARIANTS.map((v) => v.id).join(", ")}

## Aggregate Metrics

${aggregates
    .map(
      (a) =>
        `### ${a.variant}
- sample_count: ${a.sample_count}
- p95_latency_ms: ${a.p95_latency_ms.toFixed(2)}
- infra_fail_rate: ${(a.infra_fail_rate * 100).toFixed(2)}%
- parse_fail_rate: ${(a.parse_fail_rate * 100).toFixed(2)}%
- evidence_gate_pass_rate: ${(a.evidence_gate_pass_rate * 100).toFixed(2)}%
- slot_coverage_pass_rate: ${(a.slot_coverage_pass_rate * 100).toFixed(2)}%
- crossover_completeness_mean: ${a.crossover_completeness_mean.toFixed(4)}
- citation_validity_rate: ${a.citation_validity_rate.toFixed(4)}
- successful_samples_only.count: ${a.successful_samples_only.count}
- successful_samples_only.crossover_completeness_mean: ${a.successful_samples_only.crossover_completeness_mean.toFixed(4)}`,
    )
    .join("\n\n")}

## Top Failure Signatures

${VARIANTS.map((variant) => {
    const sigs = detailed[variant.id]?.top_failure_signatures ?? [];
    const lines = sigs.length
      ? sigs.map((sig: any) => `- ${sig.signature}: ${sig.count} (${(sig.rate * 100).toFixed(2)}%)`).join("\n")
      : "- none";
    return `### ${variant.id}\n${lines}`;
  }).join("\n\n")}

## Paired Deltas vs D_current_adaptive

${Object.entries(deltas)
    .map(([k, v]: any) =>
      `- ${k}: quality_delta mean=${v.quality_delta.mean.toFixed(4)} [${v.quality_delta.lo.toFixed(4)}, ${v.quality_delta.hi.toFixed(4)}], latency_delta_ms mean=${v.latency_delta_ms.mean.toFixed(2)} [${v.latency_delta_ms.lo.toFixed(2)}, ${v.latency_delta_ms.hi.toFixed(2)}]`,
    )
    .join("\n")}

## Decision

- decision: **${recommendation.decision}**
- preferred_default_variant: **${recommendation.preferred_default_variant}**
- quality gate met: **${recommendation.rationale.gate_quality}**
- latency/cost gate met: **${recommendation.rationale.gate_latency_cost}**

## Reproducibility

See summary.json and per-run raw payloads under each variant raw directory.
`;
  await fs.writeFile(REPORT_PATH, report, "utf8");
}

async function writeDoc() {
  await ensureDir(path.dirname(DOC_PATH));
  const md = `# Helix Ask Crossover Ablation (Cloud Codex)\n\nThis experiment measures quality-vs-latency tradeoffs between deterministic and LLM-assisted crossover answer assembly on \`POST /api/agi/ask\` with \`debug=true\`.\n\n## Variants\n- A_deterministic_core\n- B_det_cards_llm_contract\n- C_llm_cards_det_contract\n- D_current_adaptive\n- E_det_e2e_with_optional_narration\n\n## Fixed Controls\n- seeds: 7, 11, 13\n- temperature: 0.2\n- concurrency: 1\n\n## Outputs\n- artifacts/experiments/helix-ask-crossover/prompts.jsonl\n- artifacts/experiments/helix-ask-crossover/<variant>/raw/*.json\n- artifacts/experiments/helix-ask-crossover/summary.json\n- artifacts/experiments/helix-ask-crossover/recommendation.json\n- reports/helix-ask-crossover-ablation-report.md\n\n## Cloud Codex Runnable Task\n\n\`\`\`md\nRun an ablation study for Helix Ask crossover quality vs latency.\n\nBranch: main\nDocs: docs/experiments/helix-ask-crossover-ablation.md\n\nSteps:\n1) Build prompt pack at artifacts/experiments/helix-ask-crossover/prompts.jsonl (120 prompts as specified).\n2) Execute variants A-E from the doc against POST /api/agi/ask with debug=true.\n3) Save raw outputs under artifacts/experiments/helix-ask-crossover/<variant>/raw/.\n4) Produce aggregate metrics and paired deltas with bootstrap CIs.\n5) Write:\n   - artifacts/experiments/helix-ask-crossover/summary.json\n   - artifacts/experiments/helix-ask-crossover/recommendation.json\n   - reports/helix-ask-crossover-ablation-report.md\n6) If decision gates suggest a default change, open one patch to adjust env defaults or routing thresholds.\n\nConstraints:\n- Keep reasoning deterministic where possible.\n- Do not change product behavior before reporting metrics unless needed to run the experiment harness.\n- Preserve reproducibility (record commit hash, env flags, and runtime metadata).\n\`\`\`\n`;
  await fs.writeFile(DOC_PATH, md, "utf8");
}

async function main() {
  await ensureDir(ART_BASE);
  await writeDoc();
  const prompts = buildPrompts();
  await writePromptPack(prompts);
  const loaded = await readPromptPack();
  if (loaded.length !== 120) throw new Error(`prompt pack must be 120, got ${loaded.length}`);
  const constraintCount = loaded.filter((p) => p.requires_constraint_frame).length;
  if (constraintCount < 15) throw new Error(`requires >=15 constraint prompts, got ${constraintCount}`);

  const all: RunRecord[] = [];
  for (const variant of VARIANTS) {
    const rows = await runVariant(variant, loaded);
    all.push(...rows);
  }
  await aggregate(all, loaded);
  console.log(`done: prompts=${loaded.length} runs=${all.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
