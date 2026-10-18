import { llmLocalHandler } from "../server/skills/llm.local";
import { lumaGenerateHandler } from "../server/skills/luma.generate";
import { sttWhisperHandler } from "../server/skills/stt.whisper";

process.env.MEDIA_QUEUE_BYPASS = process.env.MEDIA_QUEUE_BYPASS ?? "1";

const BENCH_PERSONA = { personaId: "bench", goal: "bench" } as const;
const BENCH_SESSION = { ...BENCH_PERSONA, sessionId: "bench-stt" } as const;
const DEFAULT_TOKENS = 64;
const LLM_ITERATIONS = Number(process.env.BENCH_LLM_ITERATIONS ?? "50");

async function benchLlm(iterations = LLM_ITERATIONS): Promise<number> {
  if (Number.isNaN(iterations) || iterations < 1) {
    throw new Error("BENCH_LLM_ITERATIONS must be a positive integer");
  }

  let tokensPerCall = DEFAULT_TOKENS;
  const start = Date.now();

  for (let i = 0; i < iterations; i += 1) {
    const result = (await llmLocalHandler({ prompt: "Benchmark prompt" }, BENCH_PERSONA)) as {
      usage?: { tokens?: number };
    };
    if (typeof result?.usage?.tokens === "number" && result.usage.tokens > 0) {
      tokensPerCall = result.usage.tokens;
    }
  }

  const elapsedSeconds = Math.max(1, Date.now() - start) / 1000;
  return (tokensPerCall * iterations) / elapsedSeconds;
}

async function benchLuma(): Promise<number> {
  const start = Date.now();
  await lumaGenerateHandler(
    { prompt: "Benchmark nebula render", width: 128, height: 128, steps: 2 },
    BENCH_PERSONA,
  );
  return Date.now() - start;
}

async function benchStt(): Promise<number> {
  const audioBase64 = Buffer.from("Alpha bubble benchmark audio payload.", "utf8").toString("base64");
  const durationMs = 1500;
  const start = Date.now();

  await sttWhisperHandler(
    { audio_base64: audioBase64, duration_ms: durationMs, language: "en" },
    BENCH_SESSION,
  );

  const elapsedMs = Math.max(1, Date.now() - start);
  return durationMs / elapsedMs;
}

async function main() {
  const [tok_s, img_ms, stt_rtf] = await Promise.all([benchLlm(), benchLuma(), benchStt()]);
  console.log(
    JSON.stringify({
      tok_s: Number(tok_s.toFixed(2)),
      img_ms: Math.round(img_ms),
      stt_rtf: Number(stt_rtf.toFixed(2)),
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
