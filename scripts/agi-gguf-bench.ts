import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureArtifactsDir, resolveArtifactsPath } from "./agi-artifacts";

type BenchArgs = {
  models: string[];
  ctxSize: number;
  promptTokens: number;
  genTokens: number;
  threads: number;
  benchBin: string;
  outPath?: string;
  extraArgs: string[];
};

type BenchResult = {
  modelPath: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  cmd: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

const DEFAULT_CTX = 3072;
const DEFAULT_PROMPT_TOKENS = 512;
const DEFAULT_GEN_TOKENS = 128;
const DEFAULT_THREADS = Math.max(1, os.cpus().length);

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Math.floor(value), min), max);

const parseNumber = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const splitArgs = (value: string): string[] => {
  if (!value) return [];
  const tokens = value.match(/"([^"]*)"|'([^']*)'|[^\s]+/g);
  if (!tokens) return [];
  return tokens.map((token) => token.replace(/^(['"])(.*)\1$/, "$2"));
};

const parseArgs = (): BenchArgs => {
  const argv = process.argv.slice(2);
  const models: string[] = [];
  let ctxSize = parseNumber(process.env.LLAMA_BENCH_CTX) ?? DEFAULT_CTX;
  let promptTokens =
    parseNumber(process.env.LLAMA_BENCH_PROMPT_TOKENS) ?? DEFAULT_PROMPT_TOKENS;
  let genTokens =
    parseNumber(process.env.LLAMA_BENCH_GEN_TOKENS) ?? DEFAULT_GEN_TOKENS;
  let threads = parseNumber(process.env.LLAMA_BENCH_THREADS) ?? DEFAULT_THREADS;
  let benchBin = process.env.LLAMA_BENCH_BIN ?? "llama-bench";
  let outPath: string | undefined;
  let extraArgs = splitArgs(process.env.LLAMA_BENCH_EXTRA_ARGS ?? "");

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--model") {
      const value = argv[i + 1];
      if (value) models.push(value);
      i += 1;
    } else if (token === "--models") {
      const value = argv[i + 1];
      if (value) {
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .forEach((item) => models.push(item));
      }
      i += 1;
    } else if (token === "--ctx" || token === "--ctx-size") {
      ctxSize = parseNumber(argv[i + 1]) ?? ctxSize;
      i += 1;
    } else if (token === "--prompt-tokens") {
      promptTokens = parseNumber(argv[i + 1]) ?? promptTokens;
      i += 1;
    } else if (token === "--gen-tokens") {
      genTokens = parseNumber(argv[i + 1]) ?? genTokens;
      i += 1;
    } else if (token === "--threads") {
      threads = parseNumber(argv[i + 1]) ?? threads;
      i += 1;
    } else if (token === "--bench-bin") {
      benchBin = argv[i + 1] ?? benchBin;
      i += 1;
    } else if (token === "--out") {
      outPath = argv[i + 1];
      i += 1;
    } else if (token === "--extra-args") {
      extraArgs = splitArgs(argv[i + 1] ?? "");
      i += 1;
    }
  }

  return {
    models,
    ctxSize,
    promptTokens,
    genTokens,
    threads,
    benchBin,
    outPath,
    extraArgs,
  };
};

const runBench = (cmd: string, args: string[]): Promise<BenchResult> =>
  new Promise((resolve) => {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      const ended = Date.now();
      resolve({
        modelPath: "",
        startedAt,
        endedAt: new Date(ended).toISOString(),
        durationMs: ended - started,
        cmd,
        args,
        exitCode: null,
        stdout,
        stderr: `${stderr}${err.message}`,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      const ended = Date.now();
      resolve({
        modelPath: "",
        startedAt,
        endedAt: new Date(ended).toISOString(),
        durationMs: ended - started,
        cmd,
        args,
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });

const resolveOutputPath = (outPath?: string): string => {
  if (outPath) return path.resolve(outPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  return resolveArtifactsPath(`agi-gguf-cpu-bench.${stamp}.json`);
};

async function main() {
  const args = parseArgs();
  if (args.models.length < 2) {
    throw new Error("bench_requires_2_models");
  }

  const ctxSize = clampInt(args.ctxSize, 2048, 4096);
  const promptTokens = Math.max(1, Math.floor(args.promptTokens));
  const genTokens = Math.max(1, Math.floor(args.genTokens));
  const threads = Math.max(1, Math.floor(args.threads));
  const totalTokens = promptTokens + genTokens;
  const depthTokens = Math.max(0, ctxSize - totalTokens);
  const benchArgsBase = [
    "-p",
    String(promptTokens),
    "-n",
    String(genTokens),
    ...(depthTokens > 0 ? ["-d", String(depthTokens)] : []),
    "-t",
    String(threads),
    "--n-gpu-layers",
    "0",
  ];

  const results: BenchResult[] = [];
  for (const modelPath of args.models) {
    const modelArgs = ["-m", modelPath, ...benchArgsBase, ...args.extraArgs];
    const result = await runBench(args.benchBin, modelArgs);
    result.modelPath = modelPath;
    results.push(result);
  }

  const outPath = resolveOutputPath(args.outPath);
  await ensureArtifactsDir(outPath);
  const payload = {
    createdAt: new Date().toISOString(),
    benchBin: args.benchBin,
    ctxSize,
    promptTokens,
    genTokens,
    threads,
    extraArgs: args.extraArgs,
    results,
  };
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outPath, ...payload }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
