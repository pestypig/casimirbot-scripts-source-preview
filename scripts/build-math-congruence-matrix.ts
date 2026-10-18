import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Equation = {
  id?: unknown;
};

type Root = {
  id?: unknown;
  equation_refs?: unknown;
};

type MatrixRow = {
  id: string;
  root_id: string;
  equation_id: string;
  binding: {
    operator: "equals" | "bounded_by";
    lhs: string;
    rhs: string;
  };
  residual: {
    metric: string;
    comparator: "<=";
    threshold: string;
  };
  falsifier: {
    condition: string;
    evidence: string;
    uncertainty_model?: string;
  };
  runtime_safety_eligible?: boolean;
  cross_lane_bridge?: boolean;
  provenance_class?: "measured" | "proxy" | "inferred";
  claim_tier?: "diagnostic" | "reduced-order" | "certified";
  uncertainty_model_id?: string;
};

export type MathCongruenceMatrix = {
  schema_version: "math_congruence_matrix/1";
  manifest_id: string;
  generated_from: {
    root_leaf_manifest: string;
    equation_backbone: string;
  };
  rows: MatrixRow[];
};

const DEFAULT_BY_EQUATION: Record<string, Omit<MatrixRow, "id" | "root_id" | "equation_id">> = {
  efe_baseline: {
    binding: { operator: "equals", lhs: "G_mu_nu + Lambda * g_mu_nu", rhs: "(8 * pi * G / c^4) * T_mu_nu" },
    residual: { metric: "einstein_tensor_residual_rms", comparator: "<=", threshold: "1.0e-3" },
    falsifier: { condition: "einstein_tensor_residual_rms > 1.0e-3", evidence: "gr_constraint_gate_report" },
  },
  semiclassical_coupling: {
    binding: { operator: "equals", lhs: "G_mu_nu + Lambda * g_mu_nu", rhs: "(8 * pi * G / c^4) * <T_mu_nu>" },
    residual: { metric: "semiclassical_backreaction_residual", comparator: "<=", threshold: "5.0e-3" },
    falsifier: { condition: "semiclassical_backreaction_residual > 5.0e-3", evidence: "renormalized_stress_energy_audit" },
  },
  curvature_unit_proxy_contract: {
    binding: {
      operator: "equals",
      lhs: "map_units(curvature_signal, scale_assumptions)",
      rhs: "kappa_ref",
    },
    residual: {
      metric: "curvature_unit_proxy_residual",
      comparator: "<=",
      threshold: "0.05",
    },
    falsifier: {
      condition: "curvature_unit_proxy_residual > 0.05",
      evidence: "curvature_unit_proxy_diagnostic_trace",
      uncertainty_model:
        "declared_mapping_scale_with_traceable_calibration_window",
    },
    provenance_class: "proxy",
    claim_tier: "diagnostic",
    uncertainty_model_id: "curvature_unit_proxy_uq_v1",
  },
  atomic_energy_to_energy_density_proxy: {
    binding: {
      operator: "equals",
      lhs: "rho_atomic_proxy",
      rhs: "E_atomic / V_proxy",
    },
    residual: {
      metric: "atomic_energy_density_proxy_residual",
      comparator: "<=",
      threshold: "0.15",
    },
    falsifier: {
      condition: "atomic_energy_density_proxy_residual > 0.15",
      evidence: "atomic_energy_density_proxy_trace",
      uncertainty_model:
        "traceable_atomic_energy_and_declared_proxy_volume",
    },
    provenance_class: "proxy",
    claim_tier: "diagnostic",
    uncertainty_model_id: "atomic_energy_density_proxy_uq_v1",
  },
  stress_energy_conservation: {
    binding: { operator: "equals", lhs: "nabla_mu T_mu_nu", rhs: "0" },
    residual: { metric: "covariant_divergence_norm", comparator: "<=", threshold: "1.0e-6" },
    falsifier: { condition: "covariant_divergence_norm > 1.0e-6", evidence: "conservation_violation_trace" },
  },
  uncertainty_propagation: {
    binding: { operator: "equals", lhs: "sigma_f^2", rhs: "sum_i ((partial f / partial x_i)^2 * sigma_x_i^2)" },
    residual: { metric: "uncertainty_calibration_ratio_error", comparator: "<=", threshold: "0.10" },
    falsifier: { condition: "uncertainty_calibration_ratio_error > 0.10", evidence: "coverage_calibration_report" },
  },
  runtime_safety_gate: {
    binding: { operator: "bounded_by", lhs: "abs(delta_T00 / max(abs(T00_ref), eps))", rhs: "rho_delta_max" },
    residual: { metric: "runtime_gate_false_negative_rate", comparator: "<=", threshold: "0.01" },
    falsifier: {
      condition: "runtime_gate_false_negative_rate > 0.01 OR qi_bound_ok = false",
      evidence: "runtime_guardrail_regression",
      uncertainty_model:
        "runtime_gate_thresholds(determinism_min=0.98,citation_min=0.96,non_200_max=0.02,latency_p95_max_ms=1200)",
    },
    runtime_safety_eligible: true,
    cross_lane_bridge: true,
    provenance_class: "proxy",
    claim_tier: "diagnostic",
    uncertainty_model_id: "runtime_gate_thresholds_v1",
  },
};

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function buildMathCongruenceMatrix(options?: { repoRoot?: string }): MathCongruenceMatrix {
  const repoRoot = path.resolve(options?.repoRoot ?? process.cwd());
  const rootLeafPath = path.join(repoRoot, "configs", "physics-root-leaf-manifest.v1.json");
  const backbonePath = path.join(repoRoot, "configs", "physics-equation-backbone.v1.json");

  const rootLeaf = readJson<{ roots?: Root[] }>(rootLeafPath);
  const backbone = readJson<{ equations?: Equation[] }>(backbonePath);

  const equationIds = new Set((backbone.equations ?? []).map((eq) => asString(eq.id)).filter(Boolean));

  const normalizedRoots = (rootLeaf.roots ?? [])
    .map((root) => {
      const rootId = asString(root.id);
      const equationRefs = Array.isArray(root.equation_refs)
        ? root.equation_refs.map((value) => asString(value)).filter(Boolean)
        : [];
      return { rootId, equationRefs };
    })
    .filter((root) => root.rootId)
    .sort((a, b) => a.rootId.localeCompare(b.rootId));

  const rows: MatrixRow[] = [];
  for (const root of normalizedRoots) {
    const rootId = root.rootId;
    const equationRefs = [...root.equationRefs].sort((a, b) => a.localeCompare(b));

    for (const equationId of equationRefs) {
      if (!equationIds.has(equationId)) {
        continue;
      }
      const defaults = DEFAULT_BY_EQUATION[equationId] ?? {
        binding: { operator: "equals", lhs: equationId, rhs: equationId },
        residual: { metric: `${equationId}_residual`, comparator: "<=", threshold: "1.0" },
        falsifier: { condition: `${equationId}_residual > 1.0`, evidence: "manual_review" },
      };
      rows.push({
        id: `${rootId}__${equationId}`,
        root_id: rootId,
        equation_id: equationId,
        ...defaults,
      });
    }
  }

  rows.sort((a, b) => a.id.localeCompare(b.id));

  return {
    schema_version: "math_congruence_matrix/1",
    manifest_id: "toe-098-math-congruence-matrix-snapshot",
    generated_from: {
      root_leaf_manifest: "configs/physics-root-leaf-manifest.v1.json",
      equation_backbone: "configs/physics-equation-backbone.v1.json",
    },
    rows,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const repoRoot = path.resolve(process.cwd());
  const outPath = path.join(repoRoot, "configs", "math-congruence-matrix.v1.json");
  const matrix = buildMathCongruenceMatrix({ repoRoot });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
  console.log(`wrote ${path.relative(repoRoot, outPath)} (${matrix.rows.length} rows)`);
}
