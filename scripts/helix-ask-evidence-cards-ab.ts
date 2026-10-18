import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

type PromptRow = { id: string; bucket: string; prompt: string };
type Variant = {
  id: 'A' | 'B' | 'C';
  env: Record<string, string>;
};

type AskResponse = {
  text?: string;
  debug?: Record<string, unknown> & {
    live_events?: Array<{ stage?: string; durationMs?: number }>;
    trace_events?: Array<{ stage?: string; durationMs?: number }>;
  };
  envelope?: unknown;
};

const BASE_URL = process.env.HELIX_ASK_BASE_URL ?? 'http://127.0.0.1:5173';
const PROMPTS_PATH = process.env.HELIX_ASK_AB_PROMPTS ?? 'bench/helix_ask_evidence_cards_prompts.jsonl';
const OUT_ROOT = process.env.HELIX_ASK_AB_OUT ?? 'artifacts/evidence-cards-ab';
const TEMP = Number(process.env.HELIX_ASK_AB_TEMPERATURE ?? 0.2);
const SEEDS = (process.env.HELIX_ASK_AB_SEEDS ?? '7,11,13').split(',').map((s) => Number(s.trim()));
const MAX_INVALID_RATE = Number(process.env.HELIX_ASK_AB_MAX_INVALID_RATE ?? 0.1);
const MIN_VALID = Number(process.env.HELIX_ASK_AB_MIN_VALID ?? 200);
const MIN_COMPLETION_RATE = Number(process.env.HELIX_ASK_AB_MIN_COMPLETION_RATE ?? 1);
const FAIL_ON_QUALITY = (process.env.HELIX_ASK_AB_FAIL_ON_QUALITY ?? '1') === '1';
const RUN_ANALYZE = (process.env.HELIX_ASK_AB_RUN_ANALYZE ?? '1') === '1';

const variants: Variant[] = [
  {
    id: 'A',
    env: {
      HELIX_ASK_EVIDENCE_CARDS_LLM: '0',
      HELIX_ASK_SINGLE_LLM: '0',
    },
  },
  {
    id: 'B',
    env: {
      HELIX_ASK_EVIDENCE_CARDS_LLM: '1',
      HELIX_ASK_SINGLE_LLM: '0',
      HELIX_ASK_EVIDENCE_CARDS_DETERMINISTIC_CONFIDENCE: '0.72',
      HELIX_ASK_EVIDENCE_CARDS_DETERMINISTIC_DOC_SHARE: '0.32',
    },
  },
  {
    id: 'C',
    env: {
      HELIX_ASK_EVIDENCE_CARDS_LLM: '1',
      HELIX_ASK_SINGLE_LLM: '0',
      HELIX_ASK_EVIDENCE_CARDS_DETERMINISTIC_CONFIDENCE: '0.55',
      HELIX_ASK_EVIDENCE_CARDS_DETERMINISTIC_DOC_SHARE: '0.20',
    },
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const readPrompts = async (): Promise<PromptRow[]> => {
  const text = await fs.readFile(path.resolve(PROMPTS_PATH), 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PromptRow);
};

const ensureServerUp = async (timeoutMs = 120000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(new URL('/api/healthz', BASE_URL));
      if (res.status < 500) {
        await sleep(12000);
        return;
      }
    } catch {}
    await sleep(1000);
  }
  throw new Error('server did not become ready in time');
};

const startServer = async (variant: Variant) => {
  const child = spawn(
    'npm',
    ['run', 'dev:agi:5173'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...variant.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (d) => process.stdout.write(`[server:${variant.id}] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[server:${variant.id}:err] ${d}`));
  await ensureServerUp();
  return child;
};

const stopServer = async (child: ReturnType<typeof spawn>) => {
  if (child.killed) return;
  child.kill('SIGINT');
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      resolve();
    }, 10000);
  });
};

const summarizeVariantRun = async (variantId: Variant['id'], expectedTotal: number) => {
  const rawDir = path.join(OUT_ROOT, variantId, 'raw');
  const files = (await fs.readdir(rawDir)).filter((name) => name.endsWith('.json'));
  const status_counts: Record<string, number> = {};
  let valid = 0;
  for (const file of files) {
    const row = JSON.parse(
      await fs.readFile(path.join(rawDir, file), 'utf8'),
    ) as { status: number };
    const key = String(row.status);
    status_counts[key] = (status_counts[key] ?? 0) + 1;
    if (row.status === 200) valid += 1;
  }
  const total = files.length;
  const invalid = Math.max(0, total - valid);
  const invalid_rate = total > 0 ? invalid / total : 1;
  const completion_rate = expectedTotal > 0 ? total / expectedTotal : 1;
  const pass =
    valid >= MIN_VALID &&
    invalid_rate <= MAX_INVALID_RATE &&
    completion_rate >= MIN_COMPLETION_RATE;
  const summary = {
    variant: variantId,
    expected_total: expectedTotal,
    n_total: total,
    n_valid: valid,
    n_invalid: invalid,
    invalid_rate,
    completion_rate,
    status_counts,
    gates: {
      min_valid: MIN_VALID,
      max_invalid_rate: MAX_INVALID_RATE,
      min_completion_rate: MIN_COMPLETION_RATE,
    },
    pass,
  };
  const summaryPath = path.join(OUT_ROOT, variantId, 'summary.json');
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  return summary;
};

const runNodeCommand = async (command: string, args: string[]) => {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
    });
  });
};

const ask = async (prompt: PromptRow, seed: number): Promise<{ payload: AskResponse; latency_ms: number; status: number }> => {
  const started = Date.now();
  const res = await fetch(new URL('/api/agi/ask', BASE_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      question: prompt.prompt,
      debug: true,
      seed,
      temperature: TEMP,
      tuning: { fast_quality_mode: false },
    }),
  });
  const latency_ms = Date.now() - started;
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const text = await res.text();
    return { payload: { text }, latency_ms, status: res.status };
  }
  const payload = (await res.json()) as AskResponse;
  return { payload, latency_ms, status: res.status };
};


const askWithRetry = async (prompt: PromptRow, seed: number): Promise<{ payload: AskResponse; latency_ms: number; status: number }> => {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = await ask(prompt, seed);
    if (result.status !== 503 && result.status !== 500) return result;
    await sleep(1500 * attempt);
  }
  return ask(prompt, seed);
};

const main = async () => {
  const prompts = await readPrompts();
  const expectedTotal = prompts.length * SEEDS.length;
  const failedVariants: string[] = [];
  for (const variant of variants) {
    const outDir = path.join(OUT_ROOT, variant.id, 'raw');
    await fs.mkdir(outDir, { recursive: true });
    console.log(`\n=== Running variant ${variant.id} ===`);
    const server = await startServer(variant);
    try {
      let idx = 0;
      for (const prompt of prompts) {
        for (const seed of SEEDS) {
          idx += 1;
          const res = await askWithRetry(prompt, seed);
          const out = {
            variant: variant.id,
            prompt_id: prompt.id,
            bucket: prompt.bucket,
            prompt: prompt.prompt,
            seed,
            latency_ms: res.latency_ms,
            status: res.status,
            response: res.payload,
          };
          const fileName = `${prompt.id}__seed${seed}.json`;
          await fs.writeFile(path.join(outDir, fileName), JSON.stringify(out, null, 2), 'utf8');
          if (idx % 25 === 0) console.log(`variant ${variant.id}: ${idx}/${prompts.length * SEEDS.length}`);
        }
      }
    } finally {
      await stopServer(server);
    }
    const summary = await summarizeVariantRun(variant.id, expectedTotal);
    console.log(
      `[${variant.id}] valid=${summary.n_valid}/${summary.n_total} invalidRate=${summary.invalid_rate.toFixed(3)} completionRate=${summary.completion_rate.toFixed(3)}`,
    );
    if (!summary.pass) {
      const reason = `[${variant.id}] run-quality gate failed: status=${JSON.stringify(summary.status_counts)} valid=${summary.n_valid} invalidRate=${summary.invalid_rate.toFixed(3)} completionRate=${summary.completion_rate.toFixed(3)}`;
      console.error(reason);
      failedVariants.push(reason);
    }
  }
  if (RUN_ANALYZE) {
    await runNodeCommand('npx', ['tsx', 'scripts/helix-ask-evidence-cards-analyze.ts']);
  }
  if (FAIL_ON_QUALITY && failedVariants.length > 0) {
    throw new Error(`AB run failed quality gates:\n${failedVariants.join('\n')}`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
