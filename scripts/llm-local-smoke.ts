import { llmLocalHandler } from "../server/skills/llm.local";

const DEFAULT_PROMPT = "Local LLM smoke test.";

const ensureEnv = (key: string, fallback: string): string => {
  const value = process.env[key]?.trim();
  if (value) return value;
  process.env[key] = fallback;
  return fallback;
};

const modelPath =
  process.env.LLM_LOCAL_MODEL_PATH?.trim() ||
  process.env.LLM_LOCAL_MODEL?.trim();

if (!modelPath) {
  throw new Error("LLM_LOCAL_MODEL or LLM_LOCAL_MODEL_PATH is required.");
}

process.env.ENABLE_LLM_LOCAL_SPAWN = process.env.ENABLE_LLM_LOCAL_SPAWN ?? "1";
ensureEnv("LLM_LOCAL_CONTEXT_TOKENS", "512");
ensureEnv("LLM_LOCAL_MAX_TOKENS", "8");
ensureEnv("LLM_LOCAL_TEMP", "0.2");
ensureEnv("LLM_LOCAL_SPAWN_TIMEOUT_MS", "15000");
const smokeMode = (process.env.LLM_LOCAL_SMOKE_MODE ?? "run").trim().toLowerCase();

async function run(): Promise<void> {
  if (smokeMode === "preflight") {
    console.log(
      JSON.stringify(
        {
          mode: smokeMode,
          cmd: process.env.LLM_LOCAL_CMD?.trim() ?? "(missing)",
          model: modelPath ?? "(missing)",
          contextTokens: process.env.LLM_LOCAL_CONTEXT_TOKENS,
          maxTokens: process.env.LLM_LOCAL_MAX_TOKENS,
          temperature: process.env.LLM_LOCAL_TEMP,
          timeoutMs: process.env.LLM_LOCAL_SPAWN_TIMEOUT_MS,
        },
        null,
        2,
      ),
    );
    return;
  }
  const result = await llmLocalHandler(
    { prompt: DEFAULT_PROMPT, max_tokens: Number(process.env.LLM_LOCAL_MAX_TOKENS ?? 8) },
    { personaId: "smoke", sessionId: "smoke" },
  );
  console.log(JSON.stringify(result, null, 2));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
