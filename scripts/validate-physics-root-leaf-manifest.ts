import fs from "node:fs";
import path from "node:path";

type RootEntry = {
  id?: string;
  name?: string;
  equation_refs?: string[];
  tree_lane?: string;
  tree_path?: string;
};

type LeafEntry = {
  id?: string;
  prompt_family?: string;
  statement?: string;
};

type PathFalsifier = {
  observable?: string;
  readiness_block_rule?: string;
  reject_rule?: string;
  uncertainty_model?: string;
  test_refs?: string[];
};

type PathMaturityGate = {
  max_claim_tier?: string;
  required_evidence_types?: string[];
  strict_fail_reason?: string;
};

type PathEntry = {
  id?: string;
  bundle_id?: string;
  root_id?: string;
  leaf_id?: string;
  nodes?: string[];
  dag_bridges?: string[];
  falsifier?: PathFalsifier;
  maturity_gate?: PathMaturityGate;
};

type BridgeBundleEntry = {
  id?: string;
  summary?: string;
  claim_scope?: string;
  max_claim_tier?: string;
  path_ids?: string[];
};

type PhysicsRootLeafManifest = {
  schema_version?: string;
  manifest_id?: string;
  claim_tier_ceiling?: string;
  roots?: RootEntry[];
  leaves?: LeafEntry[];
  paths?: PathEntry[];
  bridge_bundles?: BridgeBundleEntry[];
};

type UncertaintyModel = {
  id?: string;
  required_parameters?: string[];
  optional_parameters?: string[];
};

type UncertaintyModelRegistry = {
  models?: UncertaintyModel[];
};

export type ValidationResult = {
  ok: boolean;
  errors: string[];
};

const REQUIRED_SCHEMA = "physics_root_leaf_manifest/1";
const ALLOWED_CLAIM_TIERS = ["diagnostic", "reduced-order", "certified"] as const;
const REQUIRED_ROOT_IDS = [
  "physics_spacetime_gr",
  "physics_quantum_semiclassical",
  "physics_thermodynamics_entropy",
  "physics_information_dynamics",
  "physics_prebiotic_chemistry",
  "physics_biology_life",
  "physics_runtime_safety_control",
];

const FLAGSHIP_CURVATURE_COLLAPSE_BUNDLE_ID = "nhm2.curvature-collapse";
const REQUIRED_FLAGSHIP_PATH_IDS = [
  "path_casimir_force_to_stress_energy",
  "path_stress_energy_to_gr_diagnostics",
  "path_gr_diagnostics_to_curvature_proxy",
  "path_curvature_proxy_to_collapse_benchmark",
  "path_solar_coherence_to_collapse_hypothesis",
] as const;

const REQUIRED_FLAGSHIP_PATH_SHAPES: Record<
  (typeof REQUIRED_FLAGSHIP_PATH_IDS)[number],
  { root_id: string; leaf_id: string }
> = {
  path_casimir_force_to_stress_energy: {
    root_id: "physics_casimir_force_measurement",
    leaf_id: "leaf_stress_energy_brick",
  },
  path_stress_energy_to_gr_diagnostics: {
    root_id: "physics_stress_energy_brick",
    leaf_id: "leaf_gr_diagnostics",
  },
  path_gr_diagnostics_to_curvature_proxy: {
    root_id: "physics_gr_diagnostics",
    leaf_id: "leaf_curvature_proxy",
  },
  path_curvature_proxy_to_collapse_benchmark: {
    root_id: "physics_curvature_proxy",
    leaf_id: "leaf_collapse_benchmark",
  },
  path_solar_coherence_to_collapse_hypothesis: {
    root_id: "physics_solar_coherence_hypothesis",
    leaf_id: "leaf_solar_collapse_hypothesis",
  },
};


const REQUIRED_TREE_LANE_BY_ROOT: Record<string, { tree_lane: string; tree_path: string }> = {
  physics_spacetime_gr: {
    tree_lane: "physics_spacetime_gr",
    tree_path: "docs/knowledge/physics/physics-spacetime-gr-tree.json",
  },
  physics_quantum_semiclassical: {
    tree_lane: "physics_quantum_semiclassical",
    tree_path: "docs/knowledge/physics/physics-quantum-semiclassical-tree.json",
  },
  physics_thermodynamics_entropy: {
    tree_lane: "physics_thermodynamics_entropy",
    tree_path: "docs/knowledge/physics/physics-thermodynamics-entropy-tree.json",
  },
  physics_information_dynamics: {
    tree_lane: "physics_information_dynamics",
    tree_path: "docs/knowledge/physics/physics-information-dynamics-tree.json",
  },
  physics_stellar_structure_nucleosynthesis: {
    tree_lane: "physics_stellar_structure_nucleosynthesis",
    tree_path: "docs/knowledge/physics/physics-stellar-structure-nucleosynthesis-tree.json",
  },
};


function parseFlag(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[index + 1];
}

function tierRank(value: string): number {
  switch (value) {
    case "diagnostic":
      return 0;
    case "reduced-order":
      return 1;
    case "certified":
      return 2;
    default:
      return -1;
  }
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function hasResidualSignal(value: string): boolean {
  return /\b(residual(s)?|constraint(s)?)\b/i.test(value);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function parseModelReference(value: string): { modelId: string; parameters: Map<string, string> } | null {
  const ref = value.trim();
  const match = /^([a-zA-Z0-9_\-]+)\((.*)\)$/.exec(ref);
  if (!match) {
    return null;
  }
  const modelId = match[1].trim();
  const inner = match[2].trim();
  if (!modelId || !inner) {
    return null;
  }

  const pairs = inner.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (pairs.length === 0) {
    return null;
  }

  const parameters = new Map<string, string>();
  for (const pair of pairs) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex <= 0 || eqIndex === pair.length - 1) {
      return null;
    }
    const key = pair.slice(0, eqIndex).trim();
    const raw = pair.slice(eqIndex + 1).trim();
    if (!key || !raw || parameters.has(key)) {
      return null;
    }
    parameters.set(key, raw);
  }

  return { modelId, parameters };
}

function loadUncertaintyRegistry(repoRoot: string): Map<string, { required: Set<string>; allowed: Set<string> }> {
  const registryPath = path.resolve(repoRoot, "configs", "uncertainty-model-registry.v1.json");
  if (!fs.existsSync(registryPath)) {
    return new Map();
  }

  const parsed = readJson<UncertaintyModelRegistry>(registryPath);
  const models = Array.isArray(parsed.models) ? parsed.models : [];
  const out = new Map<string, { required: Set<string>; allowed: Set<string> }>();
  for (const model of models) {
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id) {
      continue;
    }
    const required = new Set(normalizeList(model.required_parameters));
    const allowed = new Set([...required, ...normalizeList(model.optional_parameters)]);
    out.set(id, { required, allowed });
  }
  return out;
}

export function validatePhysicsRootLeafManifest(options?: {
  manifestPath?: string;
  repoRoot?: string;
}): ValidationResult {
  const repoRoot = path.resolve(options?.repoRoot ?? process.cwd());
  const manifestPath = path.resolve(
    repoRoot,
    options?.manifestPath ?? path.join("configs", "physics-root-leaf-manifest.v1.json"),
  );

  if (!fs.existsSync(manifestPath)) {
    return { ok: false, errors: [`manifest not found: ${path.relative(repoRoot, manifestPath)}`] };
  }

  let manifest: PhysicsRootLeafManifest;
  try {
    manifest = readJson<PhysicsRootLeafManifest>(manifestPath);
  } catch (error) {
    return { ok: false, errors: [`invalid manifest JSON: ${String(error)}`] };
  }

  const errors: string[] = [];
  const uncertaintyModels = loadUncertaintyRegistry(repoRoot);

  if (manifest.schema_version !== REQUIRED_SCHEMA) {
    errors.push(`schema_version must be ${REQUIRED_SCHEMA}`);
  }

  const ceiling =
    typeof manifest.claim_tier_ceiling === "string" ? manifest.claim_tier_ceiling.trim() : "";
  if (!ALLOWED_CLAIM_TIERS.includes(ceiling as (typeof ALLOWED_CLAIM_TIERS)[number])) {
    errors.push(`claim_tier_ceiling must be one of ${ALLOWED_CLAIM_TIERS.join("|")}`);
  }

  const roots = Array.isArray(manifest.roots) ? manifest.roots : [];
  const leaves = Array.isArray(manifest.leaves) ? manifest.leaves : [];
  const paths = Array.isArray(manifest.paths) ? manifest.paths : [];
  const bridgeBundles = Array.isArray(manifest.bridge_bundles) ? manifest.bridge_bundles : [];

  if (roots.length === 0) {
    errors.push("roots must contain at least one entry");
  }
  if (leaves.length === 0) {
    errors.push("leaves must contain at least one entry");
  }
  if (paths.length === 0) {
    errors.push("paths must contain at least one entry");
  }
  if (bridgeBundles.length === 0) {
    errors.push("bridge_bundles must contain at least one entry");
  }

  const rootIds = new Set<string>();
  roots.forEach((entry, index) => {
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const loc = `roots[${index}]`;
    if (!id) {
      errors.push(`${loc}.id is required`);
      return;
    }
    if (rootIds.has(id)) {
      errors.push(`${loc}.id duplicated: ${id}`);
    }
    rootIds.add(id);
    if (typeof entry.name !== "string" || entry.name.trim().length === 0) {
      errors.push(`${loc}.name is required`);
    }

    const laneSpec = REQUIRED_TREE_LANE_BY_ROOT[id];
    if (laneSpec) {
      if (entry.tree_lane !== laneSpec.tree_lane) {
        errors.push(`${loc}.tree_lane must be ${laneSpec.tree_lane}`);
      }
      if (entry.tree_path !== laneSpec.tree_path) {
        errors.push(`${loc}.tree_path must be ${laneSpec.tree_path}`);
      }
    }
  });

  for (const requiredRoot of REQUIRED_ROOT_IDS) {
    if (!rootIds.has(requiredRoot)) {
      errors.push(`missing required root id: ${requiredRoot}`);
    }
  }

  const leafIds = new Set<string>();
  leaves.forEach((entry, index) => {
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const loc = `leaves[${index}]`;
    if (!id) {
      errors.push(`${loc}.id is required`);
      return;
    }
    if (leafIds.has(id)) {
      errors.push(`${loc}.id duplicated: ${id}`);
    }
    leafIds.add(id);
    if (typeof entry.prompt_family !== "string" || entry.prompt_family.trim().length === 0) {
      errors.push(`${loc}.prompt_family is required`);
    }
    if (typeof entry.statement !== "string" || entry.statement.trim().length === 0) {
      errors.push(`${loc}.statement is required`);
    }
  });

  const coveredLeaves = new Set<string>();
  const coveredRootIds = new Set<string>();
  const pathIds = new Set<string>();
  const pathEntryById = new Map<string, PathEntry>();

  paths.forEach((entry, index) => {
    const loc = `paths[${index}]`;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) {
      errors.push(`${loc}.id is required`);
    } else if (pathIds.has(id)) {
      errors.push(`${loc}.id duplicated: ${id}`);
    } else {
      pathIds.add(id);
      pathEntryById.set(id, entry);
    }

    const bundleId = typeof entry.bundle_id === "string" ? entry.bundle_id.trim() : "";
    if (!bundleId) {
      errors.push(`${loc}.bundle_id is required`);
    }

    const rootId = typeof entry.root_id === "string" ? entry.root_id.trim() : "";
    const leafId = typeof entry.leaf_id === "string" ? entry.leaf_id.trim() : "";
    if (!rootId || !rootIds.has(rootId)) {
      errors.push(`${loc}.root_id must reference a declared root`);
    } else {
      coveredRootIds.add(rootId);
    }
    if (!leafId || !leafIds.has(leafId)) {
      errors.push(`${loc}.leaf_id must reference a declared leaf`);
    } else {
      coveredLeaves.add(leafId);
    }

    const nodes = normalizeList(entry.nodes);
    if (nodes.length < 2) {
      errors.push(`${loc}.nodes must include at least [root,...,leaf]`);
    } else {
      if (rootId && nodes[0] !== rootId) {
        errors.push(`${loc}.nodes must start with root_id`);
      }
      if (leafId && nodes[nodes.length - 1] !== leafId) {
        errors.push(`${loc}.nodes must end with leaf_id`);
      }
    }

    const bridges = normalizeList(entry.dag_bridges);
    if (bridges.length === 0) {
      errors.push(`${loc}.dag_bridges must be non-empty`);
    }

    const falsifier = entry.falsifier ?? {};
    if (typeof falsifier.observable !== "string" || falsifier.observable.trim().length === 0) {
      errors.push(`${loc}.falsifier.observable is required`);
    }
    if (typeof falsifier.reject_rule !== "string" || falsifier.reject_rule.trim().length === 0) {
      errors.push(`${loc}.falsifier.reject_rule is required`);
    }
    const uncertaintyModel =
      typeof falsifier.uncertainty_model === "string" ? falsifier.uncertainty_model.trim() : "";
    if (uncertaintyModel.length === 0) {
      errors.push(`${loc}.falsifier.uncertainty_model is required`);
    } else {
      const parsedRef = parseModelReference(uncertaintyModel);
      if (!parsedRef) {
        errors.push(`${loc}.falsifier.uncertainty_model must be parameterized as model_id(param=value,...)`);
      } else {
        const spec = uncertaintyModels.get(parsedRef.modelId);
        if (!spec) {
          errors.push(`${loc}.falsifier.uncertainty_model references undefined model: ${parsedRef.modelId}`);
        } else {
          for (const requiredParameter of spec.required) {
            if (!parsedRef.parameters.has(requiredParameter)) {
              errors.push(`${loc}.falsifier.uncertainty_model missing required parameter: ${requiredParameter}`);
            }
          }
          for (const key of parsedRef.parameters.keys()) {
            if (!spec.allowed.has(key)) {
              errors.push(`${loc}.falsifier.uncertainty_model parameter not permitted for ${parsedRef.modelId}: ${key}`);
            }
          }
        }
      }
    }
    const testRefs = normalizeList(falsifier.test_refs);
    if (testRefs.length === 0) {
      errors.push(`${loc}.falsifier.test_refs must be non-empty`);
    }

    const maturityGate = entry.maturity_gate ?? {};
    const maxClaimTier =
      typeof maturityGate.max_claim_tier === "string" ? maturityGate.max_claim_tier.trim() : "";
    if (!ALLOWED_CLAIM_TIERS.includes(maxClaimTier as (typeof ALLOWED_CLAIM_TIERS)[number])) {
      errors.push(`${loc}.maturity_gate.max_claim_tier must be one of ${ALLOWED_CLAIM_TIERS.join("|")}`);
    } else if (tierRank(maxClaimTier) > tierRank(ceiling)) {
      errors.push(`${loc}.maturity_gate.max_claim_tier cannot exceed claim_tier_ceiling`);
    }

    const evidenceTypes = normalizeList(maturityGate.required_evidence_types);
    if (evidenceTypes.length === 0) {
      errors.push(`${loc}.maturity_gate.required_evidence_types must be non-empty`);
    }

    if (
      typeof maturityGate.strict_fail_reason !== "string" ||
      maturityGate.strict_fail_reason.trim().length === 0
    ) {
      errors.push(`${loc}.maturity_gate.strict_fail_reason is required`);
    }

    const claimsEquationGrounding =
      (typeof falsifier.observable === "string" && /\bequation\b/i.test(falsifier.observable)) ||
      (typeof falsifier.reject_rule === "string" && /\bequation\b/i.test(falsifier.reject_rule));
    if (claimsEquationGrounding) {
      const hasResidualInObservable =
        typeof falsifier.observable === "string" && hasResidualSignal(falsifier.observable);
      const hasResidualInRejectRule =
        typeof falsifier.reject_rule === "string" && hasResidualSignal(falsifier.reject_rule);
      const hasResidualTestRef = testRefs.some((ref) => hasResidualSignal(ref));
      if (!hasResidualInObservable && !hasResidualInRejectRule && !hasResidualTestRef) {
        errors.push(`${loc} references equation-grounded claims but does not provide residual evidence`);
      }
    }

    const maxTier = maxClaimTier;
    const overclaimText = [
      typeof falsifier.observable === "string" ? falsifier.observable : "",
      typeof falsifier.reject_rule === "string" ? falsifier.reject_rule : "",
      typeof maturityGate.strict_fail_reason === "string" ? maturityGate.strict_fail_reason : "",
    ].join(" ");
    const hasOverclaimPattern = /\b(certified|proven|physically viable|admissible)\b/i.test(overclaimText);
    if (maxTier !== "certified" && hasOverclaimPattern) {
      errors.push(`${loc} contains tier over-claim language inconsistent with max_claim_tier=${maxTier}`);
    }
  });

  for (const leafId of leafIds) {
    if (!coveredLeaves.has(leafId)) {
      errors.push(`leaf not covered by any root-to-leaf path: ${leafId}`);
    }
  }

  for (const rootId of REQUIRED_ROOT_IDS) {
    if (!coveredRootIds.has(rootId)) {
      errors.push(`missing required root-lane entrypoint path for root_id: ${rootId}`);
    }
  }

  const hasEntropyFirstLifePath = paths.some((entry) => {
    const rootId = typeof entry.root_id === "string" ? entry.root_id.trim() : "";
    const leafId = typeof entry.leaf_id === "string" ? entry.leaf_id.trim() : "";
    const nodes = normalizeList(entry.nodes);
    if (rootId !== "physics_thermodynamics_entropy") return false;
    if (leafId !== "leaf_universe_produces_life") return false;
    const lifeNodeIndex = nodes.indexOf("physics_biology_life");
    return lifeNodeIndex > 0 && nodes[0] === "physics_thermodynamics_entropy";
  });
  if (!hasEntropyFirstLifePath) {
    errors.push(
      "paths must include at least one canonical entropy-first path ending at leaf_universe_produces_life",
    );
  }

  const bundleIds = new Set<string>();
  bridgeBundles.forEach((entry, index) => {
    const loc = `bridge_bundles[${index}]`;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) {
      errors.push(`${loc}.id is required`);
      return;
    }
    if (bundleIds.has(id)) {
      errors.push(`${loc}.id duplicated: ${id}`);
    }
    bundleIds.add(id);

    if (typeof entry.summary !== "string" || entry.summary.trim().length === 0) {
      errors.push(`${loc}.summary is required`);
    }
    if (typeof entry.claim_scope !== "string" || entry.claim_scope.trim().length === 0) {
      errors.push(`${loc}.claim_scope is required`);
    }

    const maxClaimTier = typeof entry.max_claim_tier === "string" ? entry.max_claim_tier.trim() : "";
    if (!ALLOWED_CLAIM_TIERS.includes(maxClaimTier as (typeof ALLOWED_CLAIM_TIERS)[number])) {
      errors.push(`${loc}.max_claim_tier must be one of ${ALLOWED_CLAIM_TIERS.join("|")}`);
    } else if (tierRank(maxClaimTier) > tierRank(ceiling)) {
      errors.push(`${loc}.max_claim_tier cannot exceed claim_tier_ceiling`);
    }

    const bundlePathIds = normalizeList(entry.path_ids);
    if (bundlePathIds.length === 0) {
      errors.push(`${loc}.path_ids must be non-empty`);
    }

    for (const bundlePathId of bundlePathIds) {
      if (!pathIds.has(bundlePathId)) {
        errors.push(`${loc}.path_ids references undefined path: ${bundlePathId}`);
        continue;
      }
      const referencedPath = pathEntryById.get(bundlePathId);
      const referencedBundleId =
        typeof referencedPath?.bundle_id === "string" ? referencedPath.bundle_id.trim() : "";
      if (referencedBundleId !== id) {
        errors.push(`${loc}.path_ids entry ${bundlePathId} must declare bundle_id=${id}`);
      }
    }
  });

  const flagshipBundle = bridgeBundles.find((entry) => entry.id === FLAGSHIP_CURVATURE_COLLAPSE_BUNDLE_ID);
  if (!flagshipBundle) {
    errors.push(`missing required bridge bundle: ${FLAGSHIP_CURVATURE_COLLAPSE_BUNDLE_ID}`);
  } else {
    if (flagshipBundle.claim_scope !== "cross_domain") {
      errors.push(
        `bridge bundle ${FLAGSHIP_CURVATURE_COLLAPSE_BUNDLE_ID} must declare claim_scope=cross_domain`,
      );
    }
    if (flagshipBundle.max_claim_tier !== "diagnostic") {
      errors.push(
        `bridge bundle ${FLAGSHIP_CURVATURE_COLLAPSE_BUNDLE_ID} must declare max_claim_tier=diagnostic`,
      );
    }
    const flagshipPathIds = new Set(normalizeList(flagshipBundle.path_ids));
    for (const requiredPathId of REQUIRED_FLAGSHIP_PATH_IDS) {
      if (!flagshipPathIds.has(requiredPathId)) {
        errors.push(
          `bridge bundle ${FLAGSHIP_CURVATURE_COLLAPSE_BUNDLE_ID} missing required path_id: ${requiredPathId}`,
        );
      }
    }
  }

  for (const requiredPathId of REQUIRED_FLAGSHIP_PATH_IDS) {
    const pathEntry = pathEntryById.get(requiredPathId);
    if (!pathEntry) {
      errors.push(`missing required flagship path: ${requiredPathId}`);
      continue;
    }

    const loc = `path ${requiredPathId}`;
    if (pathEntry.bundle_id !== FLAGSHIP_CURVATURE_COLLAPSE_BUNDLE_ID) {
      errors.push(`${loc} must declare bundle_id=${FLAGSHIP_CURVATURE_COLLAPSE_BUNDLE_ID}`);
    }

    const requiredShape = REQUIRED_FLAGSHIP_PATH_SHAPES[requiredPathId];
    if (pathEntry.root_id !== requiredShape.root_id) {
      errors.push(`${loc} must declare root_id=${requiredShape.root_id}`);
    }
    if (pathEntry.leaf_id !== requiredShape.leaf_id) {
      errors.push(`${loc} must declare leaf_id=${requiredShape.leaf_id}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

function main() {
  const manifestPath = parseFlag("--manifest");
  const result = validatePhysicsRootLeafManifest({ manifestPath });

  if (!result.ok) {
    console.error("physics-root-leaf-manifest validation failed:");
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("physics-root-leaf-manifest validation OK");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
