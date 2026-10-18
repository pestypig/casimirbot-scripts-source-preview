import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_SCENARIO_PATH = path.join('configs', 'warp-shadow-injection-scenarios.qei-recovery.v1.json');
const DEFAULT_REGISTRY_PATH = path.join(
  'docs',
  'specs',
  'casimir-tile-experimental-parameter-registry-2026-03-04.md',
);
const DEFAULT_ENVELOPE_PATH = path.join('configs', 'warp-shadow-qei-operating-envelope.v1.json');
const DEFAULT_OUT_PATH = path.join('artifacts', 'research', 'full-solve', `qei-recovery-check-${DATE_STAMP}.json`);

type ScenarioOverrides = {
  qi?: {
    sampler?: string;
    fieldType?: string;
    tau_s_ms?: number;
  };
};

type ShadowScenario = {
  id: string;
  lane: string;
  registryRefs?: string[];
  overrides?: ScenarioOverrides;
};

type ShadowScenarioPack = {
  version: number;
  scenarios: ShadowScenario[];
};

type RegistryRow = {
  entry_id: string;
  source_class: string;
  status: string;
};

type QeiEnvelope = {
  version: number;
  lane: string;
  fieldType: string;
  sourceClassAllowlist: string[];
  requiredAnchorRefs: {
    normalization: string[];
    applicability: string[];
    tau: string[];
  };
  executionDomain: {
    samplers: string[];
    tau_s_ms_values: number[];
  };
  provisionalOperatingEnvelope: {
    recommendedBands: Array<{
      sampler: string;
      tau_s_ms_min: number;
      tau_s_ms_max: number;
      inclusiveMax?: boolean;
    }>;
    blockedSamplerClasses?: Array<{
      sampler: string;
      reason: string;
    }>;
  };
};

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const asLower = (value: unknown): string => String(value ?? '').trim().toLowerCase();
const asUpper = (value: unknown): string => String(value ?? '').trim().toUpperCase();

const parseRegistryRows = (markdown: string): RegistryRow[] => {
  const rows: RegistryRow[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('| EXP-')) continue;
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 12) continue;
    rows.push({
      entry_id: cells[0],
      source_class: cells[9],
      status: cells[11],
    });
  }
  return rows;
};

const approxInSet = (value: number, set: number[], tol = 1e-9): boolean =>
  set.some((candidate) => Math.abs(candidate - value) <= tol);

const inRecommendedBand = (sampler: string, tauMs: number, envelope: QeiEnvelope): boolean => {
  return envelope.provisionalOperatingEnvelope.recommendedBands.some((band) => {
    if (asLower(band.sampler) !== asLower(sampler)) return false;
    const hiCheck = band.inclusiveMax === false ? tauMs < band.tau_s_ms_max : tauMs <= band.tau_s_ms_max;
    return tauMs >= band.tau_s_ms_min && hiCheck;
  });
};

const hasAnyRef = (refs: string[], required: string[]): boolean => required.some((id) => refs.includes(id));

export const checkQeiRecoveryPack = (options: {
  scenarioPath?: string;
  registryPath?: string;
  envelopePath?: string;
  outPath?: string;
}) => {
  const scenarioPath = options.scenarioPath ?? DEFAULT_SCENARIO_PATH;
  const registryPath = options.registryPath ?? DEFAULT_REGISTRY_PATH;
  const envelopePath = options.envelopePath ?? DEFAULT_ENVELOPE_PATH;
  const outPath = options.outPath ?? DEFAULT_OUT_PATH;

  const scenarioPack = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as ShadowScenarioPack;
  const registryRows = parseRegistryRows(fs.readFileSync(registryPath, 'utf8'));
  const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8')) as QeiEnvelope;
  const registryMap = new Map(registryRows.map((row) => [asUpper(row.entry_id), row]));

  const issues: string[] = [];
  const scenarioChecks = scenarioPack.scenarios.map((scenario) => {
    const refs = Array.isArray(scenario.registryRefs) ? scenario.registryRefs.map((ref) => asUpper(ref)) : [];
    const laneOk = asLower(scenario.lane) === asLower(envelope.lane);
    const sampler = asLower(scenario.overrides?.qi?.sampler);
    const fieldType = asLower(scenario.overrides?.qi?.fieldType);
    const tauMs = Number(scenario.overrides?.qi?.tau_s_ms);
    const fieldTypeOk = fieldType === asLower(envelope.fieldType);
    const samplerOk = envelope.executionDomain.samplers.map(asLower).includes(sampler);
    const tauOk = Number.isFinite(tauMs) && approxInSet(tauMs, envelope.executionDomain.tau_s_ms_values);

    const anchorNormalizationOk = hasAnyRef(refs, envelope.requiredAnchorRefs.normalization.map(asUpper));
    const anchorApplicabilityOk = hasAnyRef(refs, envelope.requiredAnchorRefs.applicability.map(asUpper));
    const anchorTauOk = hasAnyRef(refs, envelope.requiredAnchorRefs.tau.map(asUpper));
    const anchorOk = anchorNormalizationOk && anchorApplicabilityOk && anchorTauOk;

    let refsOk = true;
    for (const ref of refs) {
      if (!ref.startsWith('EXP-QEI-')) {
        issues.push(`scenario:${scenario.id}:ref_not_qei:${ref}`);
        refsOk = false;
        continue;
      }
      const row = registryMap.get(ref);
      if (!row) {
        issues.push(`scenario:${scenario.id}:ref_missing_registry:${ref}`);
        refsOk = false;
        continue;
      }
      if (asLower(row.status) !== 'extracted') {
        issues.push(`scenario:${scenario.id}:ref_not_extracted:${ref}:${row.status}`);
        refsOk = false;
      }
      if (!envelope.sourceClassAllowlist.map(asLower).includes(asLower(row.source_class))) {
        issues.push(`scenario:${scenario.id}:ref_source_not_allowed:${ref}:${row.source_class}`);
        refsOk = false;
      }
    }

    if (!laneOk) issues.push(`scenario:${scenario.id}:lane_not_${envelope.lane}`);
    if (!fieldTypeOk) issues.push(`scenario:${scenario.id}:fieldType_not_${envelope.fieldType}`);
    if (!samplerOk) issues.push(`scenario:${scenario.id}:sampler_not_in_execution_domain:${sampler}`);
    if (!tauOk) issues.push(`scenario:${scenario.id}:tau_not_in_execution_domain:${tauMs}`);
    if (!anchorNormalizationOk) issues.push(`scenario:${scenario.id}:missing_normalization_anchor`);
    if (!anchorApplicabilityOk) issues.push(`scenario:${scenario.id}:missing_applicability_anchor`);
    if (!anchorTauOk) issues.push(`scenario:${scenario.id}:missing_tau_anchor`);

    return {
      id: scenario.id,
      lane: scenario.lane,
      sampler,
      tau_s_ms: Number.isFinite(tauMs) ? tauMs : null,
      fieldType,
      laneOk,
      fieldTypeOk,
      samplerOk,
      tauOk,
      anchorOk,
      refsOk,
      withinProvisionalOperatingBand:
        Number.isFinite(tauMs) && sampler.length > 0 ? inRecommendedBand(sampler, tauMs, envelope) : false,
    };
  });

  const payload = {
    generatedOn: DATE_STAMP,
    scenarioPath,
    registryPath,
    envelopePath,
    summary: {
      scenarioCount: scenarioPack.scenarios.length,
      issues: issues.length,
      pass: issues.length === 0,
      withinProvisionalOperatingBandCount: scenarioChecks.filter((row) => row.withinProvisionalOperatingBand).length,
    },
    scenarioChecks,
    issues,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

  return {
    ok: issues.length === 0,
    outPath,
    summary: payload.summary,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkQeiRecoveryPack({
    scenarioPath: readArgValue('--scenarios') ?? DEFAULT_SCENARIO_PATH,
    registryPath: readArgValue('--registry') ?? DEFAULT_REGISTRY_PATH,
    envelopePath: readArgValue('--envelope') ?? DEFAULT_ENVELOPE_PATH,
    outPath: readArgValue('--out') ?? DEFAULT_OUT_PATH,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}
