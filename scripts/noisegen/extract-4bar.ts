#!/usr/bin/env ts-node
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeImmersion } from "@/lib/noise/immersion";
import type { ImmersionScores, TempoMeta } from "@/lib/noise/immersion";
import type { BarWindow } from "@/types/noise-gens";

type ImmersionFeatureDump = Omit<ImmersionScores, "idi" | "confidence">;

type CliOptions = {
  inputs: string[];
  bpm?: number;
  timeSig?: string;
  offsetMs: number;
  totalBars: number;
  outputDir?: string;
};

export type SampleRow = {
  version: "1.0";
  song_id: string;
  window_id: string;
  bpm: number;
  time_sig: string;
  offset_ms: number;
  start_bar: number;
  end_bar: number;
  start_ms: number;
  end_ms: number;
  key: string;
  features: {
    bark: number[];
    centroid: number[];
    rolloff: number[];
    loudness: number[];
    onset_flux: number[];
  };
  helix: {
    rc: number;
    T: number;
    peaks: Array<{ f: number; q: number; gain: number }>;
  };
  kb: {
    id: string;
    similarity: number;
  };
  idi: number;
  idi_confidence: number;
  immersion: ImmersionFeatureDump;
  teacher_params: {
    eq: Array<{ f: number; q: number; gain: number }>;
    reverb: { ir: string; mix: number; predelay_ms: number };
    chorus: { rate_hz: number; depth: number; mix: number };
    tape: { wow: number; flutter: number; sat: number };
    comp: { thresh_db: number; ratio: number; attack_ms: number; release_ms: number };
    limiter: { ceiling_db: number };
  };
};

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = resolve(MODULE_DIR, "../../datasets/noisegen/samples");
const SAMPLE_RATE = 44100;
const WINDOW_BARS = 4;
const ANALYSIS_BARS = 8;

export function parseCli(argv: string[]): CliOptions {
  const options: CliOptions = {
    inputs: [],
    offsetMs: 0,
    totalBars: 32,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--bpm" || token === "-b") {
      options.bpm = Number(argv[++index]);
      continue;
    }
    if (token === "--timeSig" || token === "--time-sig") {
      options.timeSig = argv[++index];
      continue;
    }
    if (token === "--offsetMs" || token === "--offset-ms") {
      options.offsetMs = Number(argv[++index] ?? 0);
      continue;
    }
    if (token === "--totalBars" || token === "--total-bars") {
      options.totalBars = Number(argv[++index] ?? 32);
      continue;
    }
    if (token === "--out" || token === "--output") {
      options.outputDir = argv[++index];
      continue;
    }
    if (token.startsWith("-")) {
      console.warn(`Unknown flag ${token} ignored.`);
      continue;
    }
    options.inputs.push(token);
  }

  return options;
}

function ensurePositiveInteger(value: number, fallback: number, minimum = 1) {
  if (!Number.isFinite(value) || value < minimum) return fallback;
  return Math.round(value);
}

function ensureTempo(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value ?? fallback, 40), 240);
}

function sanitizeTimeSig(value: string | undefined) {
  if (!value || !/^\d+\/\d+$/.test(value)) return "4/4";
  return value;
}

function deriveSongId(inputPath: string): string {
  const base = basename(inputPath, extname(inputPath));
  return base.replace(/\s+/g, "_").toLowerCase();
}

export function splitIntoWindows(totalBars: number): BarWindow[] {
  const windows: BarWindow[] = [];
  const sanitizedTotal = ensurePositiveInteger(totalBars, 32);
  for (let start = 1; start <= sanitizedTotal; start += 4) {
    const end = Math.min(start + 4, sanitizedTotal + 1);
    windows.push({ startBar: start, endBar: end });
  }
  return windows;
}

export function pseudoRandomSeries(seed: string, length: number, scale = 1): number[] {
  const series: number[] = [];
  let accumulator = 0;
  for (let index = 0; index < length; index += 1) {
    const char = seed.charCodeAt(index % seed.length);
    accumulator = (accumulator * 31 + char + index * 17) % 9973;
    const value = ((accumulator % 500) / 500) * scale;
    series.push(Number(value.toFixed(4)));
  }
  return series;
}

export function deterministicChoice<T>(items: readonly T[], seed: string): T {
  if (!items.length) {
    throw new Error("deterministicChoice requires a non-empty collection");
  }
  let accumulator = 0;
  for (let index = 0; index < seed.length; index += 1) {
    accumulator = (accumulator * 33 + seed.charCodeAt(index)) % 65521;
  }
  const chosen = accumulator % items.length;
  return items[chosen];
}

function clampUnit(value: number) {
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number) {
  return Number(clampUnit(value).toFixed(6));
}

function synthesizeWindowPcm(seed: string, tempo: number, timeSig: string) {
  const [beatsPerBarStr = "4", denominatorStr = "4"] = timeSig.split("/");
  const beatsPerBar = Number(beatsPerBarStr) || 4;
  const denominator = Number(denominatorStr) || 4;
  const beatSamples = Math.max(1, Math.round((60 / tempo) * SAMPLE_RATE * (4 / denominator)));
  const samplesPerBar = beatSamples * beatsPerBar;
  const windowSamples = samplesPerBar * WINDOW_BARS;
  const totalSamples = samplesPerBar * ANALYSIS_BARS;
  const base = new Float32Array(windowSamples);

  const rand = pseudoRandomSeries(`${seed}:pcm`, 12, 1);
  const bassFreq = 55 + rand[0] * 40;
  const melodyFreq = 330 + rand[1] * 280;
  const bassPhase = rand[2] * 2 * Math.PI;
  const melodyPhase = rand[3] * 2 * Math.PI;
  const accentProfile = pseudoRandomSeries(`${seed}:accent`, beatsPerBar, 1);

  for (let index = 0; index < windowSamples; index += 1) {
    const t = index / SAMPLE_RATE;
    const beatIndex = Math.floor(index / beatSamples);
    const barIndex = Math.floor(beatIndex / beatsPerBar);
    const beatInBar = beatIndex % beatsPerBar;
    const inBeat = (index % beatSamples) / beatSamples;

    const accent = 0.55 + 0.35 * Math.exp(-6 * inBeat) + 0.15 * accentProfile[beatInBar];
    const barShape =
      barIndex < 2
        ? 0.45 + barIndex * 0.25 + 0.15 * inBeat
        : 0.85 - (barIndex - 1) * 0.18 + 0.12 * Math.sin(Math.PI * inBeat);

    const low = Math.sin(2 * Math.PI * bassFreq * t + bassPhase) * (0.7 + 0.2 * Math.sin(2 * Math.PI * (tempo / 240) * t));
    const high =
      Math.sin(2 * Math.PI * melodyFreq * t + melodyPhase) *
      (0.4 + 0.4 * Math.cos(2 * Math.PI * (tempo / 120) * t + rand[4] * 2 * Math.PI));
    const textureNoise = (rand[5 + (beatIndex % 4)] - 0.5) * 0.05;

    base[index] = (0.65 * low + 0.35 * high) * Math.max(0.2, barShape) * accent + textureNoise;
  }

  const pcm = new Float32Array(totalSamples);
  pcm.set(base, 0);
  const resolve = pseudoRandomSeries(`${seed}:resolve`, WINDOW_BARS, 1);
  for (let index = 0; index < windowSamples; index += 1) {
    const barIndex = Math.floor(index / samplesPerBar);
    const modifier = 0.85 + 0.15 * resolve[barIndex];
    pcm[index + windowSamples] = base[index] * modifier;
  }

  return pcm;
}

function serializeImmersion(source: ImmersionScores): ImmersionFeatureDump {
  return {
    timing: roundScore(source.timing),
    am: roundScore(source.am),
    harm: roundScore(source.harm),
    cross: roundScore(source.cross),
    texture: roundScore(source.texture),
    spaceDyn: roundScore(source.spaceDyn),
    resolve4_low: roundScore(source.resolve4_low),
    resolve4_high: roundScore(source.resolve4_high),
    resolve8_low: roundScore(source.resolve8_low),
    resolve8_high: roundScore(source.resolve8_high),
    bassline_diversity: roundScore(source.bassline_diversity),
    melody_division_rate: roundScore(source.melody_division_rate),
    dyadness: roundScore(source.dyadness),
    chordness: roundScore(source.chordness),
  };
}

export function buildSampleRow(
  songId: string,
  window: BarWindow,
  tempo: number,
  timeSig: string,
  offsetMs: number,
): SampleRow {
  const beatsPerBar = Number(timeSig.split("/")[0] ?? "4") || 4;
  const msPerBeat = 60000 / tempo;
  const barDurationMs = msPerBeat * beatsPerBar;
  const startMs = (window.startBar - 1) * barDurationMs + offsetMs;
  const endMs = (window.endBar - 1) * barDurationMs + offsetMs;
  const windowSeed = `${songId}:${window.startBar}-${window.endBar}`;

  const bark = pseudoRandomSeries(`${windowSeed}:bark`, 24, 0.6);
  const centroid = pseudoRandomSeries(`${windowSeed}:centroid`, 4, 0.8);
  const rolloff = pseudoRandomSeries(`${windowSeed}:rolloff`, 4, 0.9);
  const loudness = pseudoRandomSeries(`${windowSeed}:loudness`, 4, 1);
  const onsetFlux = pseudoRandomSeries(`${windowSeed}:flux`, 4, 0.7);

  const candidateTextures = [
    "shoegaze_1994_tapeA",
    "dreampop_2009_plate",
    "lofi_2012_cassette",
    "ambient_2001_space",
  ] as const;

  const textureId = deterministicChoice(candidateTextures, windowSeed);
  const similarity = Number((0.45 + (window.startBar % 10) * 0.05).toFixed(2));

  const teacherEq = Array.from({ length: 3 }, (_, index) => ({
    f: Number((200 + index * 1500 + (window.startBar % 3) * 120).toFixed(2)),
    q: Number((0.6 + index * 0.4).toFixed(2)),
    gain: Number((index === 1 ? 1.2 : 0.8 + index * 0.3).toFixed(2)),
  }));

  const teacherParams: SampleRow["teacher_params"] = {
    eq: teacherEq,
    reverb: {
      ir: deterministicChoice(["plate_small", "hall_medium", "room_short"], windowSeed),
      mix: Number((0.18 + (window.startBar % 4) * 0.03).toFixed(3)),
      predelay_ms: 15 + (window.startBar % 3) * 5,
    },
    chorus: {
      rate_hz: Number((0.6 + (window.startBar % 5) * 0.1).toFixed(3)),
      depth: Number((0.25 + (window.startBar % 4) * 0.05).toFixed(3)),
      mix: Number((0.2 + (window.startBar % 6) * 0.04).toFixed(3)),
    },
    tape: {
      wow: Number((0.25 + (window.startBar % 5) * 0.05).toFixed(3)),
      flutter: Number((0.18 + (window.startBar % 4) * 0.04).toFixed(3)),
      sat: Number((0.2 + (window.startBar % 3) * 0.06).toFixed(3)),
    },
    comp: {
      thresh_db: -18 + (window.startBar % 6) * -1.2,
      ratio: Number((2.5 + (window.startBar % 5) * 0.3).toFixed(2)),
      attack_ms: 6 + (window.startBar % 5) * 3,
      release_ms: 110 + (window.startBar % 5) * 15,
    },
    limiter: {
      ceiling_db: -1,
    },
  };

  const tempoMeta: TempoMeta = {
    bpm: tempo,
    timeSig: timeSig as `${number}/${number}`,
    offsetMs,
  };
  const pcm = synthesizeWindowPcm(windowSeed, tempo, timeSig);
  const immersionRaw = computeImmersion(pcm, SAMPLE_RATE, tempoMeta, undefined, teacherEq);
  const immersion = serializeImmersion(immersionRaw);

  return {
    version: "1.0",
    song_id: songId,
    window_id: `${songId}#${String(window.startBar).padStart(3, "0")}-${String(window.endBar - 1).padStart(3, "0")}`,
    bpm: tempo,
    time_sig: timeSig,
    offset_ms: offsetMs,
    start_bar: window.startBar,
    end_bar: window.endBar,
    start_ms: Number(startMs.toFixed(2)),
    end_ms: Number(endMs.toFixed(2)),
    key: deterministicChoice(["C major", "E minor", "D dorian", "A lydian"], windowSeed),
    features: {
      bark,
      centroid,
      rolloff,
      loudness,
      onset_flux: onsetFlux,
    },
    helix: {
      rc: Number((0.25 + (window.startBar % 4) * 0.05).toFixed(3)),
      T: Number((0.12 + (window.startBar % 5) * 0.02).toFixed(3)),
      peaks: teacherEq,
    },
    kb: {
      id: textureId,
      similarity: Number(Math.min(0.95, similarity).toFixed(3)),
    },
    idi: roundScore(immersionRaw.idi),
    idi_confidence: roundScore(immersionRaw.confidence),
    immersion,
    teacher_params: teacherParams,
  };
}

async function ensureDir(path: string) {
  if (existsSync(path)) return;
  await mkdir(path, { recursive: true });
}

async function writeSamples(outDir: string, songId: string, rows: SampleRow[]) {
  if (!rows.length) return;
  await ensureDir(outDir);
  const filePath = join(outDir, `${songId}.4bar.jsonl`);
  const payload = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(filePath, payload, { encoding: "utf8" });
  console.info(`wrote ${rows.length} windows to ${filePath}`);
}

async function processInput(inputPath: string, options: CliOptions) {
  const songId = deriveSongId(inputPath);
  const tempo = ensureTempo(options.bpm, 120);
  const timeSig = sanitizeTimeSig(options.timeSig);
  const windows = splitIntoWindows(options.totalBars);

  const rows = windows.map((window) =>
    buildSampleRow(songId, window, tempo, timeSig, options.offsetMs),
  );

  const outDir = options.outputDir ? resolve(options.outputDir) : DEFAULT_OUTPUT_DIR;
  await writeSamples(outDir, songId, rows);
}

async function main(argv: string[]) {
  const options = parseCli(argv);
  if (!options.inputs.length) {
    console.error(
      "Usage: tsx scripts/noisegen/extract-4bar.ts <audio files...> [--bpm 120] [--timeSig 4/4] [--offsetMs 0] [--totalBars 32] [--out <dir>]",
    );
    process.exitCode = 1;
    return;
  }

  for (const input of options.inputs) {
    const absolute = resolve(process.cwd(), input);
    try {
      await processInput(absolute, options);
    } catch (error) {
      console.error(`Failed to process ${input}`, error);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main(process.argv);
}
