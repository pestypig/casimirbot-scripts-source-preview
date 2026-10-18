import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const ClaimTier = z.enum(["diagnostic", "reduced-order", "certified"]);

const CanonicalEquationSchema = z.object({
  id: z.string().trim().min(1),
  expression: z.string().trim().min(1),
  units: z.string().trim().min(1),
  source_path: z.string().trim().min(1),
});

const CouplingInputSchema = z.object({
  id: z.string().trim().min(1),
  units: z.string().trim().min(1),
  role: z.string().trim().min(1),
});

const NullModelSchema = z.object({
  id: z.string().trim().min(1),
  description: z.string().trim().min(1),
});

const EvidenceTierSchema = z.object({
  tier: ClaimTier,
  required: z.array(z.string().trim().min(1)).min(1),
  prohibited_language: z.array(z.string().trim().min(1)),
});

const StrictBlockerSchema = z.object({
  id: z.string().trim().min(1),
  reason_code: z.string().trim().min(1),
});

const CurvatureCollapseContractSchema = z.object({
  schema_version: z.literal("curvature_collapse_repro_contract/1"),
  contract_id: z.string().trim().min(1),
  status: z.enum(["draft", "active", "deprecated"]),
  claim_tier_ceiling: ClaimTier,
  scope: z.object({
    domain: z.literal("collapse_benchmark"),
    summary: z.string().trim().min(1),
    gr_regime: z.object({
      chart: z.string().trim().min(1),
      weak_field_assumption: z.boolean(),
      allow_ftl_claims: z.boolean(),
      allow_objective_collapse_claims: z.boolean(),
    }),
  }),
  canonical_equations: z.array(CanonicalEquationSchema).min(3),
  coupling_inputs: z.array(CouplingInputSchema).min(1),
  determinism_contract: z.object({
    seed_required: z.boolean(),
    step_index_required: z.boolean(),
    hash_bound_fields: z.array(z.string().trim().min(1)).min(1),
  }),
  prediction_preregistration: z.object({
    minimum_prediction_count: z.number().int().min(1),
    required_fields: z.array(z.string().trim().min(1)).min(1),
    default_null_models: z.array(NullModelSchema).min(1),
  }),
  evidence_tiers: z.array(EvidenceTierSchema).min(1),
  required_artifacts: z.array(z.string().trim().min(1)).min(1),
  required_tests: z.array(z.string().trim().min(1)).min(1),
  strict_blockers: z.array(StrictBlockerSchema).min(1),
});

type CurvatureCollapseContract = z.infer<typeof CurvatureCollapseContractSchema>;

export type CurvatureCollapseContractValidationResult = {
  ok: boolean;
  errors: string[];
};

const REQUIRED_EQUATION_IDS = ["hazard_probability", "present_length", "kappa_present"] as const;
const REQUIRED_HASH_FIELDS = ["inputs_hash", "features_hash"] as const;
const REQUIRED_DIAGNOSTIC_PROHIBITED = ["physically viable", "proven", "admissible"] as const;
const REQUIRED_PREDICTION_FIELDS = [
  "prediction_id",
  "hypothesis",
  "null_model_id",
  "sign_expectation",
  "magnitude_band",
  "falsifier_rule",
  "dataset_refs",
  "metric",
] as const;

const parseFlag = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
};

const normalize = (value: string): string => value.trim().toLowerCase();

export function validateCurvatureCollapseContract(options?: {
  contractPath?: string;
  repoRoot?: string;
}): CurvatureCollapseContractValidationResult {
  const repoRoot = path.resolve(options?.repoRoot ?? process.cwd());
  const contractPath = path.resolve(
    repoRoot,
    options?.contractPath ?? path.join("configs", "curvature-collapse-repro-contract.v1.json"),
  );

  if (!fs.existsSync(contractPath)) {
    return {
      ok: false,
      errors: [`contract not found: ${path.relative(repoRoot, contractPath)}`],
    };
  }

  let parsed: CurvatureCollapseContract;
  try {
    const raw = JSON.parse(fs.readFileSync(contractPath, "utf8"));
    parsed = CurvatureCollapseContractSchema.parse(raw);
  } catch (error) {
    return {
      ok: false,
      errors: [`invalid contract JSON/schema: ${String(error)}`],
    };
  }

  const errors: string[] = [];

  if (parsed.scope.gr_regime.allow_ftl_claims) {
    errors.push("scope.gr_regime.allow_ftl_claims must be false");
  }
  if (parsed.scope.gr_regime.allow_objective_collapse_claims) {
    errors.push("scope.gr_regime.allow_objective_collapse_claims must be false");
  }

  const equationIds = new Set(parsed.canonical_equations.map((entry) => entry.id));
  for (const required of REQUIRED_EQUATION_IDS) {
    if (!equationIds.has(required)) {
      errors.push(`canonical_equations missing required id: ${required}`);
    }
  }

  const hashFields = new Set(parsed.determinism_contract.hash_bound_fields);
  for (const required of REQUIRED_HASH_FIELDS) {
    if (!hashFields.has(required)) {
      errors.push(`determinism_contract.hash_bound_fields missing required field: ${required}`);
    }
  }

  const preregFieldSet = new Set(parsed.prediction_preregistration.required_fields);
  for (const required of REQUIRED_PREDICTION_FIELDS) {
    if (!preregFieldSet.has(required)) {
      errors.push(`prediction_preregistration.required_fields missing: ${required}`);
    }
  }

  const nullModelIds = new Set(parsed.prediction_preregistration.default_null_models.map((entry) => entry.id));
  if (!nullModelIds.has("null_fixed_tau_rc")) {
    errors.push("prediction_preregistration.default_null_models missing null_fixed_tau_rc");
  }
  if (!nullModelIds.has("null_dp_only")) {
    errors.push("prediction_preregistration.default_null_models missing null_dp_only");
  }

  const evidenceTierByName = new Map(parsed.evidence_tiers.map((entry) => [entry.tier, entry]));
  const diagnosticTier = evidenceTierByName.get("diagnostic");
  if (!diagnosticTier) {
    errors.push("evidence_tiers missing diagnostic tier");
  } else {
    const prohibited = new Set(diagnosticTier.prohibited_language.map(normalize));
    for (const phrase of REQUIRED_DIAGNOSTIC_PROHIBITED) {
      if (!prohibited.has(normalize(phrase))) {
        errors.push(`diagnostic prohibited_language missing phrase: ${phrase}`);
      }
    }
  }

  for (const artifactPath of parsed.required_artifacts) {
    const absPath = path.resolve(repoRoot, artifactPath);
    if (!fs.existsSync(absPath)) {
      errors.push(`required artifact path does not exist: ${artifactPath}`);
    }
  }

  for (const testPath of parsed.required_tests) {
    const absPath = path.resolve(repoRoot, testPath);
    if (!fs.existsSync(absPath)) {
      errors.push(`required test path does not exist: ${testPath}`);
    }
  }

  const blockerIds = new Set<string>();
  for (const blocker of parsed.strict_blockers) {
    if (blockerIds.has(blocker.id)) {
      errors.push(`strict_blockers contains duplicate id: ${blocker.id}`);
    }
    blockerIds.add(blocker.id);
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

function main() {
  const contractPath = parseFlag("--contract");
  const result = validateCurvatureCollapseContract({ contractPath });
  if (!result.ok) {
    console.error("curvature-collapse reproducibility contract validation failed:");
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("curvature-collapse reproducibility contract validation OK");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
