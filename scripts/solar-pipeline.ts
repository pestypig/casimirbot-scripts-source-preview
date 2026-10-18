import fs from "node:fs";
import path from "node:path";
import {
  ingestSolarSpectrumDefaults,
  type SolarSpectrumIngestResult,
} from "../server/services/essence/solar-spectrum-ingest";
import { runSolarModelComparison } from "../server/services/essence/solar-spectrum-models";
import { runSolarSurfaceCoherence } from "../server/services/essence/solar-surface-coherence";
import { stableJsonStringify } from "../server/utils/stable-json";
import type { SolarGuardrailInputs } from "../shared/solar-guardrails";

const USAGE = `
Usage: npm run solar:pipeline -- [options]

Options:
  --persist                 Persist envelopes (requires configured DB/storage)
  --skip-spectrum            Skip spectrum ingest
  --skip-model               Skip Phase 2 model comparison
  --skip-surface             Skip surface coherence pipeline
  --surface <path>           JSON input or dataset manifest for surface coherence
  --guardrails <path>        JSON file with guardrail inputs
  --guardrail-version <ver>  Guardrail config version (default: env)
  --persona <id>             Persona id for envelopes
  --out <path>               Write summary JSON to file
  --expect <path>            Compare summary against expected fixture
  --write-expect             Write expected fixture (use with --expect)
  --help                     Show this message
`;

type ArgMap = Map<string, string | boolean>;

type SolarPipelineSpectrumSummary = {
  dataset?: string;
  view?: string;
  file?: string;
  inputs_hash?: string;
  features_hash?: string;
  envelope_id?: string;
};

type SolarPipelineModelSummary = {
  inputs_hash?: string;
  features_hash?: string;
  best_model?: string;
  viability?: unknown;
  envelope_id?: string;
  report_url?: string;
};

type SolarPipelineSurfaceSummary = {
  inputs_hash?: string;
  features_hash?: string;
  u_field_inputs_hash?: string;
  envelope_id?: string;
  report_url?: string;
};

type SolarPipelineSummary = {
  started_at?: string;
  finished_at?: string;
  persist?: boolean;
  spectrum?: SolarPipelineSpectrumSummary[];
  model?: SolarPipelineModelSummary;
  surface?: SolarPipelineSurfaceSummary;
};

type SolarPipelineFixture = {
  schema_version: "solar_pipeline_fixture/1";
  kind: "solar_pipeline_fixture";
  created_at: string;
  expected: SolarPipelineSummary;
};

const parseArgs = (argv: string[]) => {
  const args = argv.slice();
  const flags: ArgMap = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const entry = args[i];
    if (!entry) continue;
    if (entry.startsWith("--")) {
      const key = entry.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
    }
  }
  return { flags };
};

const flagString = (flags: ArgMap, key: string): string | undefined => {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
};

const flagEnabled = (flags: ArgMap, key: string): boolean =>
  flags.get(key) === true;

const readJson = (filePath: string): unknown => {
  const resolved = path.resolve(filePath);
  const raw = fs.readFileSync(resolved, "utf8");
  return JSON.parse(raw);
};

const defaultFixturePath = () =>
  path.resolve(process.cwd(), "datasets", "solar", "solar-pipeline.fixture.json");

const defaultSurfacePath = () =>
  path.resolve(process.cwd(), "datasets", "solar", "solar-surface.fixture.json");

const loadSurfaceInput = (filePath: string) => {
  const raw = readJson(filePath) as any;
  if (raw?.schema_version === "dataset_manifest/1" && Array.isArray(raw.entries)) {
    const entry = raw.entries[0];
    if (!entry?.input) {
      throw new Error("surface_fixture_missing_input");
    }
    return { input: entry.input, expected: entry.expected?.hashes };
  }
  return { input: raw, expected: undefined };
};

const pickModelInput = (results: SolarSpectrumIngestResult[]) => {
  if (!results.length) return undefined;
  const muGrid = results.find((result) =>
    result.spectrum.series.some((series) => series.view === "intermediate"),
  );
  return muGrid ?? results[0];
};

const summarizeSpectrum = (results: SolarSpectrumIngestResult[]) =>
  results.map((result) => ({
    dataset: result.spectrum.source.dataset,
    view: result.spectrum.source.view,
    file: result.spectrum.source.file,
    inputs_hash: result.spectrum.inputs_hash,
    features_hash: result.spectrum.features_hash,
    envelope_id: result.envelopeId,
  }));

const normalizePath = (value?: string) =>
  value ? value.replace(/\\/g, "/") : value;

const normalizeSummary = (summary: SolarPipelineSummary): SolarPipelineSummary => {
  const normalized: SolarPipelineSummary = { ...summary };
  delete normalized.started_at;
  delete normalized.finished_at;
  if (normalized.model) {
    const { envelope_id, report_url, ...rest } = normalized.model;
    normalized.model = rest;
  }
  if (normalized.surface) {
    const { envelope_id, report_url, ...rest } = normalized.surface;
    normalized.surface = rest;
  }
  if (Array.isArray(normalized.spectrum)) {
    normalized.spectrum = normalized.spectrum.map((entry) => {
      const { envelope_id, ...rest } = entry;
      if (rest.file) {
        rest.file = normalizePath(rest.file);
      }
      return rest;
    });
  }
  return normalized;
};

const buildFixture = (summary: SolarPipelineSummary): SolarPipelineFixture => ({
  schema_version: "solar_pipeline_fixture/1",
  kind: "solar_pipeline_fixture",
  created_at: new Date().toISOString(),
  expected: summary,
});

const loadExpectedSummary = (fixturePath: string): SolarPipelineSummary => {
  const raw = readJson(fixturePath) as any;
  if (raw?.expected && typeof raw.expected === "object") {
    return raw.expected as SolarPipelineSummary;
  }
  return raw as SolarPipelineSummary;
};

const compareField = (
  label: string,
  expected: unknown,
  actual: unknown,
  mismatches: string[],
) => {
  if (expected === undefined) return;
  const expectedJson =
    expected && typeof expected === "object" ? stableJsonStringify(expected) : String(expected);
  const actualJson =
    actual && typeof actual === "object" ? stableJsonStringify(actual) : String(actual);
  if (expectedJson !== actualJson) {
    mismatches.push(`${label} expected ${expectedJson} got ${actualJson}`);
  }
};

const compareSummaries = (
  expected: SolarPipelineSummary,
  actual: SolarPipelineSummary,
): string[] => {
  const mismatches: string[] = [];
  if (Array.isArray(expected.spectrum)) {
    const actualSpectrum = Array.isArray(actual.spectrum) ? actual.spectrum : [];
    const actualIndex = new Map(
      actualSpectrum.map((entry) => [
        `${entry.dataset ?? "?"}|${entry.view ?? "?"}|${entry.file ?? "?"}`,
        entry,
      ]),
    );
    for (const entry of expected.spectrum) {
      const key = `${entry.dataset ?? "?"}|${entry.view ?? "?"}|${entry.file ?? "?"}`;
      const current = actualIndex.get(key);
      if (!current) {
        mismatches.push(`spectrum missing ${key}`);
        continue;
      }
      compareField(`spectrum ${key} inputs_hash`, entry.inputs_hash, current.inputs_hash, mismatches);
      compareField(`spectrum ${key} features_hash`, entry.features_hash, current.features_hash, mismatches);
    }
  }
  if (expected.model) {
    const current = actual.model ?? {};
    compareField("model inputs_hash", expected.model.inputs_hash, current.inputs_hash, mismatches);
    compareField("model features_hash", expected.model.features_hash, current.features_hash, mismatches);
    compareField("model best_model", expected.model.best_model, current.best_model, mismatches);
    compareField("model viability", expected.model.viability, current.viability, mismatches);
  }
  if (expected.surface) {
    const current = actual.surface ?? {};
    compareField("surface inputs_hash", expected.surface.inputs_hash, current.inputs_hash, mismatches);
    compareField("surface features_hash", expected.surface.features_hash, current.features_hash, mismatches);
    compareField(
      "surface u_field_inputs_hash",
      expected.surface.u_field_inputs_hash,
      current.u_field_inputs_hash,
      mismatches,
    );
  }
  return mismatches;
};

const defaultGuardrails: SolarGuardrailInputs = {
  density_kg_m3: 5e-6,
  pressure_Pa: 5e4,
  scale_height_km: 150,
  opacity_regime: "H-",
};

const main = async () => {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flagEnabled(flags, "help")) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const persist = flagEnabled(flags, "persist");
  const skipSpectrum = flagEnabled(flags, "skip-spectrum");
  const skipModel = flagEnabled(flags, "skip-model");
  const skipSurface = flagEnabled(flags, "skip-surface");
  const personaId = flagString(flags, "persona");
  const guardrailVersion = flagString(flags, "guardrail-version");
  const guardrailPath = flagString(flags, "guardrails");
  const outPath = flagString(flags, "out");
  const expectPathFlag = flagString(flags, "expect");
  const writeExpect = flagEnabled(flags, "write-expect");
  const expectPath = expectPathFlag ?? (writeExpect ? defaultFixturePath() : undefined);

  const summary: SolarPipelineSummary = {
    started_at: new Date().toISOString(),
    persist,
  };

  let spectrumResults: SolarSpectrumIngestResult[] = [];
  if (!skipSpectrum) {
    spectrumResults = await ingestSolarSpectrumDefaults(undefined, {
      persistEnvelope: persist,
      personaId,
    });
    summary.spectrum = summarizeSpectrum(spectrumResults);
  }

  if (!skipModel) {
    const modelInput = pickModelInput(spectrumResults);
    if (!modelInput) {
      throw new Error("solar_pipeline_missing_spectrum");
    }
    const guardrailInputs = guardrailPath
      ? (readJson(guardrailPath) as SolarGuardrailInputs)
      : defaultGuardrails;
    const model = await runSolarModelComparison({
      spectrum: modelInput.spectrum,
      analysis: modelInput.analysis,
      guardrailInputs,
      guardrailConfigVersion: guardrailVersion,
      persistEnvelope: persist,
      personaId,
    });
    summary.model = {
      inputs_hash: model.report.inputs_hash,
      features_hash: model.report.features_hash,
      best_model: model.report.best_model,
      viability: model.report.viability,
      envelope_id: model.envelopeId,
      report_url: model.reportUrl,
    };
  }

  if (!skipSurface) {
    const surfacePath = flagString(flags, "surface");
    const resolved =
      surfacePath && surfacePath.trim()
        ? path.resolve(surfacePath)
        : fs.existsSync(defaultSurfacePath())
          ? defaultSurfacePath()
          : undefined;
    if (!resolved) {
      summary.surface = { skipped: true, reason: "surface_input_missing" };
    } else {
      const surface = loadSurfaceInput(resolved);
      const result = await runSolarSurfaceCoherence({
        ...surface.input,
        persistEnvelope: persist,
        personaId,
      });
      summary.surface = {
        inputs_hash: result.report.inputs_hash,
        features_hash: result.report.features_hash,
        u_field_inputs_hash: result.report.u_field_inputs_hash,
        envelope_id: result.reportEnvelopeId,
        report_url: result.reportUrl,
      };
    }
  }

  summary.finished_at = new Date().toISOString();

  const normalized = normalizeSummary(summary);
  if (expectPath) {
    if (writeExpect) {
      const fixture = buildFixture(normalized);
      fs.writeFileSync(expectPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    } else {
      const expected = normalizeSummary(loadExpectedSummary(expectPath));
      const mismatches = compareSummaries(expected, normalized);
      if (mismatches.length) {
        console.error("[solar-pipeline] hash drift detected:");
        for (const mismatch of mismatches) {
          console.error(` - ${mismatch}`);
        }
        process.exit(1);
      }
    }
  }

  const serialized = JSON.stringify(summary, null, 2);
  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), `${serialized}\n`, "utf8");
  } else {
    process.stdout.write(`${serialized}\n`);
  }
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[solar-pipeline] failed", message);
  process.exit(1);
});
