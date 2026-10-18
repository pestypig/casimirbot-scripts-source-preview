import fs from "node:fs/promises";
import path from "node:path";
import Ajv from "ajv";
import {
  PAPER_CANONICAL_RULES,
  PAPER_CANONICAL_TREE_FILES,
} from "./paper-framework-binding.js";

type CliOptions = {
  reportPath: string;
  schemaPath: string;
};

type ValidationIssue = {
  code: string;
  message: string;
  path?: string;
};

type ReportExecutableCandidate = {
  file_path?: unknown;
  symbol?: unknown;
};

type ReportExecutableMapping = {
  canonical_id?: unknown;
  implementation_candidates?: unknown;
};

type ReportCanonicalBinding = {
  local_id?: unknown;
  local_type?: unknown;
  canonical_id?: unknown;
};

type ReportCitationLink = {
  claim_id?: unknown;
  citation_id?: unknown;
};

type ReportPaperCard = {
  concepts?: Array<{ concept_id?: unknown }>;
  quantitative_values?: Array<{ value_id?: unknown }>;
  systems?: Array<{ system_id?: unknown }>;
  math_objects?: {
    equations?: Array<{ equation_id?: unknown; variable_ids?: unknown }>;
    definitions?: Array<{ definition_id?: unknown }>;
    variables?: Array<{ variable_id?: unknown; unit?: unknown }>;
    units?: Array<{ unit_id?: unknown }>;
    assumptions?: Array<{ assumption_id?: unknown }>;
  };
};

type ReportPredictionInputBinding = {
  variable_id?: unknown;
  unit?: unknown;
};

type ReportPredictionObservable = {
  variable_id?: unknown;
  unit?: unknown;
};

type ReportPredictionContractCandidate = {
  contract_id?: unknown;
  model_node_id?: unknown;
  equation_ids?: unknown;
  input_bindings?: unknown;
  predicted_observable?: unknown;
  measured_observable?: unknown;
};

type ReportSymbolAliasEntry = {
  symbol?: unknown;
  unit?: unknown;
};

type ReportSymbolEquivalenceEntry = {
  canonical_symbol?: unknown;
  mapping_type?: unknown;
  aliases?: unknown;
  transform?: unknown;
};

type ReportMaturityGateCandidate = {
  gate_id?: unknown;
  target_id?: unknown;
  required_stage?: unknown;
  current_stage?: unknown;
  status?: unknown;
};

type ReportDerivationLineageStep = {
  step_id?: unknown;
  at?: unknown;
  input_hashes?: unknown;
  output_hashes?: unknown;
};

type ReportDerivationLineage = {
  lineage_hash?: unknown;
  steps?: unknown;
};

type ReportLike = {
  claims?: Array<{ claim_id?: unknown }>;
  citations?: Array<{ citation_id?: unknown }>;
  citation_links?: ReportCitationLink[];
  canonical_bindings?: ReportCanonicalBinding[];
  executable_mappings?: ReportExecutableMapping[];
  paper_card?: ReportPaperCard;
  prediction_contract_candidates?: ReportPredictionContractCandidate[];
  symbol_equivalence_entries?: ReportSymbolEquivalenceEntry[];
  derivation_lineage?: ReportDerivationLineage;
  maturity_gate_candidates?: ReportMaturityGateCandidate[];
};

const DEFAULT_SCHEMA_PATH = "schemas/paper-gpt-pro-report.schema.json";

function parseArgs(argv: string[]): CliOptions {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, "1");
      continue;
    }
    args.set(key, next);
    i += 1;
  }

  const reportPath = args.get("report")?.trim();
  if (!reportPath) {
    throw new Error("Missing --report <path-to-gpt-report.json>");
  }
  const schemaPath = args.get("schema")?.trim() || DEFAULT_SCHEMA_PATH;
  return { reportPath, schemaPath };
}

async function readJson<T>(relativeOrAbsolutePath: string): Promise<T> {
  const absolute = path.resolve(relativeOrAbsolutePath);
  const raw = await fs.readFile(absolute, "utf8");
  return JSON.parse(raw) as T;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function symbolAliasKey(symbol: string, unit: string): string {
  return `${symbol.trim().toLowerCase()}::${unit.trim().toLowerCase()}`;
}

function buildLocalRegistry(report: ReportLike) {
  const conceptIds = new Set(
    Array.isArray(report.paper_card?.concepts)
      ? report.paper_card?.concepts
          .map((entry) => asString(entry.concept_id))
          .filter((entry): entry is string => entry !== null)
      : [],
  );
  const systemIds = new Set(
    Array.isArray(report.paper_card?.systems)
      ? report.paper_card?.systems
          .map((entry) => asString(entry.system_id))
          .filter((entry): entry is string => entry !== null)
      : [],
  );
  const valueIds = new Set(
    Array.isArray(report.paper_card?.quantitative_values)
      ? report.paper_card?.quantitative_values
          .map((entry) => asString(entry.value_id))
          .filter((entry): entry is string => entry !== null)
      : [],
  );
  const equationIds = new Set(
    Array.isArray(report.paper_card?.math_objects?.equations)
      ? report.paper_card?.math_objects?.equations
          .map((entry) => asString(entry.equation_id))
          .filter((entry): entry is string => entry !== null)
      : [],
  );
  const definitionIds = new Set(
    Array.isArray(report.paper_card?.math_objects?.definitions)
      ? report.paper_card?.math_objects?.definitions
          .map((entry) => asString(entry.definition_id))
          .filter((entry): entry is string => entry !== null)
      : [],
  );
  const unitIds = new Set(
    Array.isArray(report.paper_card?.math_objects?.units)
      ? report.paper_card?.math_objects?.units
          .map((entry) => asString(entry.unit_id))
          .filter((entry): entry is string => entry !== null)
      : [],
  );
  const assumptionIds = new Set(
    Array.isArray(report.paper_card?.math_objects?.assumptions)
      ? report.paper_card?.math_objects?.assumptions
          .map((entry) => asString(entry.assumption_id))
          .filter((entry): entry is string => entry !== null)
      : [],
  );
  const variableUnitById = new Map<string, string>();
  if (Array.isArray(report.paper_card?.math_objects?.variables)) {
    for (const entry of report.paper_card.math_objects.variables) {
      const variableId = asString(entry.variable_id);
      const unit = asString(entry.unit);
      if (variableId && unit) variableUnitById.set(variableId, unit);
    }
  }
  const variableIds = new Set(variableUnitById.keys());
  const allLocalIds = new Set<string>([
    ...conceptIds,
    ...systemIds,
    ...valueIds,
    ...equationIds,
    ...definitionIds,
    ...variableIds,
    ...unitIds,
    ...assumptionIds,
  ]);
  return {
    conceptIds,
    systemIds,
    valueIds,
    equationIds,
    definitionIds,
    variableIds,
    unitIds,
    assumptionIds,
    variableUnitById,
    allLocalIds,
  };
}

function stageRank(stage: string | null): number | null {
  if (stage === "exploratory") return 0;
  if (stage === "reduced-order") return 1;
  if (stage === "diagnostic") return 2;
  if (stage === "certified") return 3;
  return null;
}

function asIsoMillis(value: unknown): number | null {
  const text = asString(value);
  if (!text) return null;
  const millis = Date.parse(text);
  return Number.isFinite(millis) ? millis : null;
}

async function knownCanonicalIds(): Promise<Set<string>> {
  const ids = new Set<string>(PAPER_CANONICAL_RULES.map((entry) => entry.canonicalId));
  for (const treePath of PAPER_CANONICAL_TREE_FILES) {
    try {
      const tree = await readJson<{ nodes?: Array<{ id?: unknown }> }>(treePath);
      for (const node of tree.nodes ?? []) {
        const nodeId = asString(node.id);
        if (nodeId) ids.add(nodeId);
      }
    } catch {
      // keep base rule ids
    }
  }
  return ids;
}

async function runSemanticChecks(report: ReportLike): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  const knownCanonical = await knownCanonicalIds();
  const localRegistry = buildLocalRegistry(report);
  const claimIds = new Set(
    Array.isArray(report.claims)
      ? report.claims
          .map((entry) => asString(entry.claim_id))
          .filter((entry): entry is string => entry !== null)
      : [],
  );
  const citationIds = new Set(
    Array.isArray(report.citations)
      ? report.citations
          .map((entry) => asString(entry.citation_id))
          .filter((entry): entry is string => entry !== null)
      : [],
  );

  for (const [idx, binding] of (report.canonical_bindings ?? []).entries()) {
    const canonicalId = asString(binding.canonical_id);
    const localId = asString(binding.local_id);
    const localType = asString(binding.local_type);
    if (!canonicalId) continue;
    if (!knownCanonical.has(canonicalId)) {
      issues.push({
        code: "unknown_canonical_id",
        message: `canonical_bindings[${idx}].canonical_id is not in known canonical rules: ${canonicalId}`,
        path: `/canonical_bindings/${idx}/canonical_id`,
      });
    }
    if (localId) {
      const knownLocal =
        claimIds.has(localId) ||
        localRegistry.allLocalIds.has(localId) ||
        (localType === "model" && /^((model|paper):)/.test(localId));
      if (!knownLocal) {
        issues.push({
          code: "unknown_local_binding_id",
          message: `canonical_bindings[${idx}].local_id does not resolve to a known local claim/card/math id: ${localId}`,
          path: `/canonical_bindings/${idx}/local_id`,
        });
      }
    }
  }

  for (const [idx, link] of (report.citation_links ?? []).entries()) {
    const claimId = asString(link.claim_id);
    const citationId = asString(link.citation_id);
    if (claimId && !claimIds.has(claimId)) {
      issues.push({
        code: "citation_link_missing_claim",
        message: `citation_links[${idx}] references missing claim_id: ${claimId}`,
        path: `/citation_links/${idx}/claim_id`,
      });
    }
    if (citationId && !citationIds.has(citationId)) {
      issues.push({
        code: "citation_link_missing_citation",
        message: `citation_links[${idx}] references missing citation_id: ${citationId}`,
        path: `/citation_links/${idx}/citation_id`,
      });
    }
  }

  for (const [mapIdx, mapping] of (report.executable_mappings ?? []).entries()) {
    const canonicalId = asString(mapping.canonical_id);
    if (canonicalId && !knownCanonical.has(canonicalId)) {
      issues.push({
        code: "unknown_executable_mapping_canonical_id",
        message: `executable_mappings[${mapIdx}].canonical_id not in known canonical rules: ${canonicalId}`,
        path: `/executable_mappings/${mapIdx}/canonical_id`,
      });
    }
    const candidates = Array.isArray(mapping.implementation_candidates)
      ? (mapping.implementation_candidates as ReportExecutableCandidate[])
      : [];
    for (const [candIdx, candidate] of candidates.entries()) {
      const filePath = asString(candidate.file_path);
      const symbol = asString(candidate.symbol);
      if (!filePath) continue;
      try {
        await fs.access(path.resolve(filePath));
      } catch {
        issues.push({
          code: "missing_implementation_file",
          message: `implementation candidate path does not exist: ${filePath}`,
          path: `/executable_mappings/${mapIdx}/implementation_candidates/${candIdx}/file_path`,
        });
      }
      if (!symbol) {
        issues.push({
          code: "missing_implementation_symbol",
          message: "implementation candidate symbol is empty",
          path: `/executable_mappings/${mapIdx}/implementation_candidates/${candIdx}/symbol`,
        });
      }
    }
  }

  const seenPredictionContractIds = new Set<string>();
  for (const [idx, contract] of (report.prediction_contract_candidates ?? []).entries()) {
    const contractId = asString(contract.contract_id);
    const modelNodeId = asString(contract.model_node_id);
    if (contractId) {
      if (seenPredictionContractIds.has(contractId)) {
        issues.push({
          code: "duplicate_prediction_contract_id",
          message: `prediction_contract_candidates[${idx}].contract_id is duplicated: ${contractId}`,
          path: `/prediction_contract_candidates/${idx}/contract_id`,
        });
      }
      seenPredictionContractIds.add(contractId);
    }
    if (modelNodeId && !knownCanonical.has(modelNodeId) && !localRegistry.allLocalIds.has(modelNodeId) && !/^((model|paper):)/.test(modelNodeId)) {
      issues.push({
        code: "unknown_prediction_model_node",
        message: `prediction_contract_candidates[${idx}].model_node_id is not a known canonical or local id: ${modelNodeId}`,
        path: `/prediction_contract_candidates/${idx}/model_node_id`,
      });
    }

    const equationIds = Array.isArray(contract.equation_ids)
      ? contract.equation_ids.map((entry) => asString(entry)).filter((entry): entry is string => entry !== null)
      : [];
    const seenEquationIds = new Set<string>();
    for (const [eqIdx, equationId] of equationIds.entries()) {
      if (!localRegistry.equationIds.has(equationId) && !knownCanonical.has(equationId)) {
        issues.push({
          code: "unknown_prediction_equation_id",
          message: `prediction_contract_candidates[${idx}].equation_ids[${eqIdx}] is not a known equation id: ${equationId}`,
          path: `/prediction_contract_candidates/${idx}/equation_ids/${eqIdx}`,
        });
      }
      if (seenEquationIds.has(equationId)) {
        issues.push({
          code: "duplicate_prediction_equation_id",
          message: `prediction_contract_candidates[${idx}] repeats equation id: ${equationId}`,
          path: `/prediction_contract_candidates/${idx}/equation_ids/${eqIdx}`,
        });
      }
      seenEquationIds.add(equationId);
    }

    const bindings = Array.isArray(contract.input_bindings)
      ? (contract.input_bindings as ReportPredictionInputBinding[])
      : [];
    for (const [bindIdx, binding] of bindings.entries()) {
      const variableId = asString(binding.variable_id);
      const unit = asString(binding.unit);
      if (!variableId || !localRegistry.variableIds.has(variableId)) {
        issues.push({
          code: "unknown_prediction_input_variable",
          message: `prediction_contract_candidates[${idx}].input_bindings[${bindIdx}].variable_id is not in paper_card.math_objects.variables`,
          path: `/prediction_contract_candidates/${idx}/input_bindings/${bindIdx}/variable_id`,
        });
        continue;
      }
      const expectedUnit = localRegistry.variableUnitById.get(variableId);
      if (unit && expectedUnit && unit !== expectedUnit) {
        issues.push({
          code: "prediction_input_unit_mismatch",
          message: `prediction_contract_candidates[${idx}].input_bindings[${bindIdx}] unit ${unit} does not match variable unit ${expectedUnit}`,
          path: `/prediction_contract_candidates/${idx}/input_bindings/${bindIdx}/unit`,
        });
      }
    }

    const observableChecks: Array<{ label: "predicted_observable" | "measured_observable"; value: ReportPredictionObservable | undefined }> = [
      {
        label: "predicted_observable",
        value: contract.predicted_observable && typeof contract.predicted_observable === "object"
          ? (contract.predicted_observable as ReportPredictionObservable)
          : undefined,
      },
      {
        label: "measured_observable",
        value: contract.measured_observable && typeof contract.measured_observable === "object"
          ? (contract.measured_observable as ReportPredictionObservable)
          : undefined,
      },
    ];
    for (const observable of observableChecks) {
      const variableId = asString(observable.value?.variable_id);
      const unit = asString(observable.value?.unit);
      if (!variableId || !localRegistry.variableIds.has(variableId)) {
        issues.push({
          code: "unknown_prediction_observable_variable",
          message: `prediction_contract_candidates[${idx}].${observable.label}.variable_id is not in paper_card.math_objects.variables`,
          path: `/prediction_contract_candidates/${idx}/${observable.label}/variable_id`,
        });
        continue;
      }
      const expectedUnit = localRegistry.variableUnitById.get(variableId);
      if (unit && expectedUnit && unit !== expectedUnit) {
        issues.push({
          code: "prediction_observable_unit_mismatch",
          message: `prediction_contract_candidates[${idx}].${observable.label} unit ${unit} does not match variable unit ${expectedUnit}`,
          path: `/prediction_contract_candidates/${idx}/${observable.label}/unit`,
        });
      }
    }
  }

  const seenCanonicalSymbols = new Set<string>();
  const aliasOwners = new Map<string, string>();
  for (const [idx, entry] of (report.symbol_equivalence_entries ?? []).entries()) {
    const canonicalSymbol = asString(entry.canonical_symbol);
    const mappingType = asString(entry.mapping_type);
    if (canonicalSymbol) {
      if (seenCanonicalSymbols.has(canonicalSymbol)) {
        issues.push({
          code: "duplicate_symbol_equivalence_canonical_symbol",
          message: `symbol_equivalence_entries[${idx}].canonical_symbol is duplicated: ${canonicalSymbol}`,
          path: `/symbol_equivalence_entries/${idx}/canonical_symbol`,
        });
      }
      seenCanonicalSymbols.add(canonicalSymbol);
    }

    const aliases = Array.isArray(entry.aliases) ? (entry.aliases as ReportSymbolAliasEntry[]) : [];
    const seenAliasKeys = new Set<string>();
    for (const [aliasIdx, alias] of aliases.entries()) {
      const symbol = asString(alias.symbol);
      const unit = asString(alias.unit);
      if (!symbol || !unit) continue;
      const aliasKey = symbolAliasKey(symbol, unit);
      if (seenAliasKeys.has(aliasKey)) {
        issues.push({
          code: "duplicate_symbol_alias_within_entry",
          message: `symbol_equivalence_entries[${idx}] repeats alias ${symbol} [${unit}]`,
          path: `/symbol_equivalence_entries/${idx}/aliases/${aliasIdx}`,
        });
      }
      seenAliasKeys.add(aliasKey);
      const owner = aliasOwners.get(aliasKey);
      if (owner && owner !== canonicalSymbol) {
        issues.push({
          code: "ambiguous_symbol_alias",
          message: `symbol_equivalence_entries[${idx}] alias ${symbol} [${unit}] is already mapped to canonical symbol ${owner}`,
          path: `/symbol_equivalence_entries/${idx}/aliases/${aliasIdx}`,
        });
      } else if (canonicalSymbol) {
        aliasOwners.set(aliasKey, canonicalSymbol);
      }
    }

    const transform =
      entry.transform && typeof entry.transform === "object"
        ? (entry.transform as { scale?: unknown; offset?: unknown })
        : null;
    const scale = asNumber(transform?.scale);
    const offset = asNumber(transform?.offset);

    if (mappingType === "exact") {
      if ((scale !== null && scale !== 1) || (offset !== null && offset !== 0)) {
        issues.push({
          code: "invalid_exact_symbol_transform",
          message: `symbol_equivalence_entries[${idx}] declares an exact mapping with a non-identity transform`,
          path: `/symbol_equivalence_entries/${idx}/transform`,
        });
      }
    } else if (mappingType === "scaled") {
      if (scale === null) {
        issues.push({
          code: "missing_scaled_symbol_transform",
          message: `symbol_equivalence_entries[${idx}] requires transform.scale for mapping_type=scaled`,
          path: `/symbol_equivalence_entries/${idx}/transform/scale`,
        });
      }
      if (offset !== null && offset !== 0) {
        issues.push({
          code: "invalid_scaled_symbol_offset",
          message: `symbol_equivalence_entries[${idx}] must not apply a non-zero offset when mapping_type=scaled`,
          path: `/symbol_equivalence_entries/${idx}/transform/offset`,
        });
      }
    } else if (mappingType === "offset") {
      if (offset === null) {
        issues.push({
          code: "missing_offset_symbol_transform",
          message: `symbol_equivalence_entries[${idx}] requires transform.offset for mapping_type=offset`,
          path: `/symbol_equivalence_entries/${idx}/transform/offset`,
        });
      }
      if (scale !== null && scale !== 1) {
        issues.push({
          code: "invalid_offset_symbol_scale",
          message: `symbol_equivalence_entries[${idx}] must not apply a non-identity scale when mapping_type=offset`,
          path: `/symbol_equivalence_entries/${idx}/transform/scale`,
        });
      }
    } else if (mappingType === "affine") {
      const hasNonIdentityScale = scale !== null && scale !== 1;
      const hasNonIdentityOffset = offset !== null && offset !== 0;
      if (!hasNonIdentityScale && !hasNonIdentityOffset) {
        issues.push({
          code: "missing_affine_symbol_transform",
          message: `symbol_equivalence_entries[${idx}] requires a non-identity transform for mapping_type=affine`,
          path: `/symbol_equivalence_entries/${idx}/transform`,
        });
      }
    }
  }

  const seenGateIds = new Set<string>();
  for (const [idx, gate] of (report.maturity_gate_candidates ?? []).entries()) {
    const gateId = asString(gate.gate_id);
    const targetId = asString(gate.target_id);
    const requiredStage = asString(gate.required_stage);
    const currentStage = asString(gate.current_stage);
    const status = asString(gate.status);
    if (gateId) {
      if (seenGateIds.has(gateId)) {
        issues.push({
          code: "duplicate_maturity_gate_id",
          message: `maturity_gate_candidates[${idx}].gate_id is duplicated: ${gateId}`,
          path: `/maturity_gate_candidates/${idx}/gate_id`,
        });
      }
      seenGateIds.add(gateId);
    }
    if (targetId && !knownCanonical.has(targetId) && !localRegistry.allLocalIds.has(targetId) && !claimIds.has(targetId)) {
      issues.push({
        code: "unknown_maturity_gate_target",
        message: `maturity_gate_candidates[${idx}].target_id is not a known canonical or local id: ${targetId}`,
        path: `/maturity_gate_candidates/${idx}/target_id`,
      });
    }
    const requiredRank = stageRank(requiredStage);
    const currentRank = stageRank(currentStage);
    if (status === "pass" && requiredRank !== null && currentRank !== null && currentRank < requiredRank) {
      issues.push({
        code: "invalid_maturity_gate_stage_order",
        message: `maturity_gate_candidates[${idx}] cannot pass when current_stage (${currentStage}) is below required_stage (${requiredStage})`,
        path: `/maturity_gate_candidates/${idx}/status`,
      });
    }
  }

  const lineage = report.derivation_lineage;
  if (lineage && typeof lineage === "object") {
    const lineageHash = asString(lineage.lineage_hash);
    const steps = Array.isArray(lineage.steps) ? (lineage.steps as ReportDerivationLineageStep[]) : [];
    const seenStepIds = new Set<string>();
    let lastAt: number | null = null;
    let lastOutputHashes: string[] = [];
    for (const [idx, step] of steps.entries()) {
      const stepId = asString(step.step_id);
      const atMillis = asIsoMillis(step.at);
      const inputHashes = Array.isArray(step.input_hashes)
        ? step.input_hashes.map((entry) => asString(entry)).filter((entry): entry is string => entry !== null)
        : [];
      const outputHashes = Array.isArray(step.output_hashes)
        ? step.output_hashes.map((entry) => asString(entry)).filter((entry): entry is string => entry !== null)
        : [];
      if (stepId) {
        if (seenStepIds.has(stepId)) {
          issues.push({
            code: "duplicate_derivation_step_id",
            message: `derivation_lineage.steps[${idx}].step_id is duplicated: ${stepId}`,
            path: `/derivation_lineage/steps/${idx}/step_id`,
          });
        }
        seenStepIds.add(stepId);
      }
      if (lastAt !== null && atMillis !== null && atMillis < lastAt) {
        issues.push({
          code: "derivation_lineage_out_of_order",
          message: `derivation_lineage.steps[${idx}] has timestamp earlier than the previous step`,
          path: `/derivation_lineage/steps/${idx}/at`,
        });
      }
      if (idx > 0 && inputHashes.length > 0 && lastOutputHashes.length > 0) {
        const chained = inputHashes.some((entry) => lastOutputHashes.includes(entry));
        if (!chained) {
          issues.push({
            code: "derivation_lineage_unlinked_step",
            message: `derivation_lineage.steps[${idx}] does not consume any output hash from the previous step`,
            path: `/derivation_lineage/steps/${idx}/input_hashes`,
          });
        }
      }
      if (atMillis !== null) lastAt = atMillis;
      lastOutputHashes = outputHashes;
    }
    if (lineageHash && lastOutputHashes.length > 0 && !lastOutputHashes.includes(lineageHash)) {
      issues.push({
        code: "derivation_lineage_hash_mismatch",
        message: "derivation_lineage.lineage_hash must appear in the final step output_hashes",
        path: "/derivation_lineage/lineage_hash",
      });
    }
  }

  return issues;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const schema = await readJson<Record<string, unknown>>(opts.schemaPath);
  const report = await readJson<ReportLike>(opts.reportPath);

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const validSchema = validate(report);
  const schemaIssues: ValidationIssue[] = (validate.errors ?? []).map((entry) => ({
    code: "schema_validation_failed",
    message: `${entry.instancePath || "/"} ${entry.message ?? "invalid"}`.trim(),
    path: entry.instancePath || "/",
  }));

  const semanticIssues = await runSemanticChecks(report);
  const allIssues = [...schemaIssues, ...semanticIssues];
  const isPass = Boolean(validSchema) && allIssues.length === 0;

  const summary = {
    ok: isPass,
    reportPath: path.resolve(opts.reportPath),
    schemaPath: path.resolve(opts.schemaPath),
    counts: {
      claims: Array.isArray(report.claims) ? report.claims.length : 0,
      citations: Array.isArray(report.citations) ? report.citations.length : 0,
      citationLinks: Array.isArray(report.citation_links) ? report.citation_links.length : 0,
      canonicalBindings: Array.isArray(report.canonical_bindings) ? report.canonical_bindings.length : 0,
      executableMappings: Array.isArray(report.executable_mappings) ? report.executable_mappings.length : 0,
      predictionContracts: Array.isArray(report.prediction_contract_candidates)
        ? report.prediction_contract_candidates.length
        : 0,
      symbolEquivalenceEntries: Array.isArray(report.symbol_equivalence_entries)
        ? report.symbol_equivalence_entries.length
        : 0,
      derivationLineageSteps: Array.isArray(report.derivation_lineage?.steps)
        ? report.derivation_lineage.steps.length
        : 0,
      maturityGateCandidates: Array.isArray(report.maturity_gate_candidates)
        ? report.maturity_gate_candidates.length
        : 0,
    },
    issues: allIssues,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!isPass) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[paper-gpt-pro-validate] ${message}`);
  process.exitCode = 1;
});
