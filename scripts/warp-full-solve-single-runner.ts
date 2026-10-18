import fs from 'node:fs';
import path from 'node:path';
import { runGrAgentLoop, type GrAgentLoopOptions } from '../server/gr/gr-agent-loop.js';

type RunnerInput = {
  wave?: string;
  runIndex?: number;
  ciFastPath?: boolean;
  options: GrAgentLoopOptions;
};

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const i = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (i < 0) return undefined;
  if (argv[i].includes('=')) return argv[i].split('=', 2)[1];
  return argv[i + 1];
};

const inputPath = readArgValue('--input');
const outputPath = readArgValue('--output');

if (!inputPath || !outputPath) {
  console.error('Usage: tsx scripts/warp-full-solve-single-runner.ts --input <path> --output <path>');
  process.exit(1);
}

const writeOutput = (payload: unknown) => {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
};

const run = async () => {
  try {
    const raw = fs.readFileSync(inputPath, 'utf8');
    const parsed = JSON.parse(raw) as RunnerInput;
    const result = await runGrAgentLoop({ ...(parsed.options ?? {}), ciFastPath: Boolean(parsed.ciFastPath) });
    writeOutput({
      ok: true,
      wave: parsed.wave,
      runIndex: parsed.runIndex,
      result,
    });
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    writeOutput({
      ok: false,
      error: {
        message,
        ...(stack ? { stack } : {}),
      },
    });
    process.exit(1);
  }
};

run();
