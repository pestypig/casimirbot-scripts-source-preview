#!/usr/bin/env -S tsx

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeLifshitzEquilibrium } from "../../shared/casimir-lifshitz";
import {
  estimateVisibilityRatePower,
  evaluateDynamicsSignature,
} from "../../shared/casimir-dp-inference";
import { computeDpCollapse, type TDpCollapseInput } from "../../shared/dp-collapse";
import {
  CasimirDpNextComputationsConfig,
  type CasimirDpNextComputationsConfig as CasimirDpNextComputationsConfigType,
} from "../../shared/contracts/casimir-dp-next-computations.v1";

export const CASIMIR_DP_NEXT_RUN_ORDER = [
  "freeze_gated_computation_protocol",
  "validate_equilibrium_lifshitz_solver",
  "apply_finite_geometry_and_material_authority_gates",
  "ingest_switching_and_decoherence_sidecars",
  "compute_rigid_sphere_dp_convergence",
  "apply_dp_bounds_and_provenance_gate",
  "estimate_rate_only_statistical_power",
  "apply_dynamics_signature_identifiability_gate",
  "audit_manifold_response_registration",
  "write_hashed_stage1_receipt",
  "update_study_evidence_ledger",
] as const;

const stableJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function assertRunOrder(config: CasimirDpNextComputationsConfigType): void {
  if (config.run_order.length !== CASIMIR_DP_NEXT_RUN_ORDER.length) {
    throw new Error("run_order length does not match the gated computation protocol");
  }
  CASIMIR_DP_NEXT_RUN_ORDER.forEach((stage, index) => {
    if (config.run_order[index] !== stage) {
      throw new Error(`run_order[${index}] must be ${stage}`);
    }
  });
}

function sumDecoherence(config: CasimirDpNextComputationsConfigType) {
  const terms = Object.entries(config.decoherence_sidecar.terms).map(([id, datum]) => ({ id, ...datum }));
  const rate = terms.reduce((sum, term) => sum + term.value, 0);
  const diagonalVariance = terms.reduce(
    (sum, term) => sum + term.standard_uncertainty ** 2,
    0,
  );
  let totalVariance = diagonalVariance;
  const covariance = config.decoherence_sidecar.covariance_s2;
  if (covariance != null) {
    if (covariance.length !== terms.length || covariance.some((row) => row.length !== terms.length)) {
      throw new Error("decoherence covariance matrix dimensions do not match the rate terms");
    }
    totalVariance = 0;
    for (let row = 0; row < covariance.length; row += 1) {
      for (let column = 0; column < covariance.length; column += 1) {
        const tolerance = 1e-12 * Math.max(1, Math.abs(covariance[row][column]));
        if (Math.abs(covariance[row][column] - covariance[column][row]) > tolerance) {
          throw new Error("decoherence covariance matrix must be symmetric");
        }
        totalVariance += covariance[row][column];
      }
    }
  }
  const allMeasured = terms.every(
    (term) => term.evidence_class === "measured" && term.raw_artifact_sha256 != null,
  );
  return {
    rate_s: rate,
    standard_uncertainty_s: Math.sqrt(Math.max(0, totalVariance)),
    visibility: Math.exp(-rate * config.decoherence_sidecar.acquisition_window_s),
    terms,
    covariance_status: covariance == null ? "diagonal_assumption" as const : "provided" as const,
    evidence_gate: allMeasured ? "pass" as const : "not_ready" as const,
  };
}

function switchingGate(config: CasimirDpNextComputationsConfigType) {
  const sidecar = config.switching_sidecar;
  const data = [
    sidecar.modulation_frequency,
    sidecar.dissipated_power,
    sidecar.coupled_heat,
    sidecar.force_mismatch,
  ];
  const allMeasured = data.every(
    (datum) => datum.evidence_class === "measured" && datum.raw_artifact_sha256 != null,
  );
  return {
    evidence_gate: allMeasured ? "pass" as const : "not_ready" as const,
    calibration_gate: sidecar.calibration_refs.length > 0 ? "review" as const : "not_ready" as const,
    values: {
      modulation_frequency_Hz: sidecar.modulation_frequency.value,
      dissipated_power_W: sidecar.dissipated_power.value,
      coupled_heat_W: sidecar.coupled_heat.value,
      force_mismatch_N: sidecar.force_mismatch.value,
    },
  };
}

function buildRigidSphereInput(
  campaign: CasimirDpNextComputationsConfigType["dp_campaign"],
  dimension: number,
): TDpCollapseInput {
  const halfSpan =
    campaign.radius_m +
    campaign.branch_separation_m / 2 +
    campaign.padding_radii * campaign.radius_m;
  const voxel = (2 * halfSpan) / dimension;
  return {
    schema_version: "dp_collapse/1",
    ell_m: campaign.ell_m,
    grid: {
      dims: [dimension, dimension, dimension],
      voxel_size_m: [voxel, voxel, voxel],
      origin_m: [0, 0, 0],
    },
    branch_a: {
      kind: "analytic",
      label: `${campaign.candidate_id}-rigid-sphere-a`,
      primitives: [{
        kind: "sphere",
        mass_kg: campaign.mass_kg,
        radius_m: campaign.radius_m,
        center_m: [-campaign.branch_separation_m / 2, 0, 0],
      }],
    },
    branch_b: {
      kind: "analytic",
      label: `${campaign.candidate_id}-rigid-sphere-b`,
      primitives: [{
        kind: "sphere",
        mass_kg: campaign.mass_kg,
        radius_m: campaign.radius_m,
        center_m: [campaign.branch_separation_m / 2, 0, 0],
      }],
    },
    method: { kernel: "plummer", max_voxels: campaign.max_voxels },
    notes: [
      "Rigid homogeneous sphere design model; not a measured internal mass-density map.",
      `Density evidence: ${campaign.density_evidence_class} (${campaign.density_source_ref}).`,
    ],
  };
}

function runDpConvergence(config: CasimirDpNextComputationsConfigType) {
  let previousDeltaE: number | null = null;
  const rows = config.dp_campaign.grid_dimensions.map((dimension) => {
    const result = computeDpCollapse(buildRigidSphereInput(config.dp_campaign, dimension));
    const relativeToPrior = previousDeltaE == null
      ? null
      : Math.abs(result.deltaE_J - previousDeltaE) / Math.max(result.deltaE_J, Number.MIN_VALUE);
    previousDeltaE = result.deltaE_J;
    const massErrorA =
      Math.abs(result.mass_a_kg - config.dp_campaign.mass_kg) /
      config.dp_campaign.mass_kg;
    const massErrorB =
      Math.abs(result.mass_b_kg - config.dp_campaign.mass_kg) /
      config.dp_campaign.mass_kg;
    const branchSymmetryError =
      Math.abs(result.mass_a_kg - result.mass_b_kg) /
      Math.max(result.mass_a_kg, result.mass_b_kg, Number.MIN_VALUE);
    return {
      requested_grid_dimension: dimension,
      used_grid_dimensions: result.grid.dims,
      method: result.method,
      deltaE_J: result.deltaE_J,
      rate_s: result.tau_infinite ? 0 : 1 / result.tau_s,
      tau_s: result.tau_s,
      relative_change_from_prior: relativeToPrior,
      provenance_class: result.provenance_class,
      claim_tier: result.claim_tier,
      certifying: result.certifying,
      fail_reason: result.fail_reason ?? null,
      sampled_mass_a_kg: result.mass_a_kg,
      sampled_mass_b_kg: result.mass_b_kg,
      mass_relative_error_a: massErrorA,
      mass_relative_error_b: massErrorB,
      branch_mass_symmetry_relative_error: branchSymmetryError,
      boundary_shell_mass_fraction_a: result.boundary_shell_mass_fraction_a,
      boundary_shell_mass_fraction_b: result.boundary_shell_mass_fraction_b,
    };
  });
  const final = rows[rows.length - 1];
  const exactDistinctResolutions = rows.every(
    (row) =>
      row.method === "exact" &&
      row.used_grid_dimensions.every((dimension) => dimension === row.requested_grid_dimension),
  );
  const massConservation = rows.every(
    (row) =>
      row.mass_relative_error_a <= config.dp_campaign.mass_conservation_relative_tolerance &&
      row.mass_relative_error_b <= config.dp_campaign.mass_conservation_relative_tolerance,
  );
  const branchSymmetry = rows.every(
    (row) =>
      row.branch_mass_symmetry_relative_error <=
      config.dp_campaign.branch_symmetry_relative_tolerance,
  );
  const boundaryContainment = rows.every(
    (row) =>
      row.boundary_shell_mass_fraction_a <=
        config.dp_campaign.maximum_boundary_shell_mass_fraction &&
      row.boundary_shell_mass_fraction_b <=
        config.dp_campaign.maximum_boundary_shell_mass_fraction,
  );
  const branchSamplingReady = massConservation && branchSymmetry && boundaryContainment;
  const numericalConvergence =
    exactDistinctResolutions &&
    branchSamplingReady &&
    final.relative_change_from_prior != null &&
    final.relative_change_from_prior <= config.dp_campaign.convergence_relative_tolerance;
  return {
    rows,
    selected_rate_s: final.rate_s,
    selected_tau_s: final.tau_s,
    exact_distinct_resolutions: exactDistinctResolutions,
    mass_conservation_gate: massConservation ? "pass" as const : "not_ready" as const,
    branch_symmetry_gate: branchSymmetry ? "pass" as const : "not_ready" as const,
    boundary_containment_gate: boundaryContainment ? "pass" as const : "not_ready" as const,
    branch_sampling_gate: branchSamplingReady ? "pass" as const : "not_ready" as const,
    numerical_convergence_gate: numericalConvergence ? "pass" as const : "not_ready" as const,
    provenance_gate: config.dp_campaign.density_evidence_class === "measured"
      ? "review" as const
      : "not_ready" as const,
    experimental_bounds_gate: "review" as const,
  };
}

export function buildCasimirDpNextComputationsReport(args: {
  config: CasimirDpNextComputationsConfigType;
  now?: Date;
}) {
  assertRunOrder(args.config);
  const lifshitz = args.config.lifshitz_cases.map((entry) => ({
    case_id: entry.case_id,
    result: computeLifshitzEquilibrium(entry.input),
  }));
  const idealValidation = lifshitz.find((entry) => entry.case_id.includes("ideal-parallel"));
  const lifshitzValidationPass =
    idealValidation?.result.convergence.status === "pass" &&
    Math.abs((idealValidation?.result.ideal_zero_temperature_reference.pressure_ratio ?? 0) - 1) <= 5e-3;
  const decoherence = sumDecoherence(args.config);
  const switching = switchingGate(args.config);
  const dp = runDpConvergence(args.config);
  const power = estimateVisibilityRatePower({
    schema_version: "casimir_dp_visibility_power/1",
    baseline_rate_s: args.config.power_plan.baseline_rate_s,
    target_additional_rate_s: Math.max(dp.selected_rate_s, Number.MIN_VALUE),
    observation_time_s: args.config.power_plan.observation_time_s,
    type_i_error: args.config.power_plan.type_i_error,
    target_power: args.config.power_plan.target_power,
    technical_variance_inflation: args.config.power_plan.technical_variance_inflation,
  });
  const dynamics = evaluateDynamicsSignature(args.config.dynamics_signature);
  const manifold = {
    status: args.config.manifold_response_registration.status,
    registration_complete: false,
    blockers: [
      "missing_renormalized_stress_tensor_prescription",
      "missing_stress_noise_kernel",
      "missing_causal_metric_response_kernel",
      "missing_metric_to_coherence_dynamics",
      "missing_consistency_and_recovery_proofs",
      "missing_frozen_parameter_manifest",
    ],
    required_falsifiers: args.config.manifold_response_registration.required_falsifiers,
  };
  return {
    schema_version: "casimir_dp_next_computations_report/1" as const,
    campaign_id: args.config.campaign_id,
    generated_at: (args.now ?? new Date()).toISOString(),
    evidence_cutoff: args.config.evidence_cutoff,
    claim_tier: "diagnostic" as const,
    promotion_allowed: false as const,
    run_order: [...args.config.run_order],
    lifshitz: {
      cases: lifshitz,
      ideal_validation_gate: lifshitzValidationPass ? "pass" as const : "not_ready" as const,
      measured_material_gate: lifshitz.every((entry) => entry.result.material_gate === "measured_receipts_present")
        ? "pass" as const
        : "not_ready" as const,
      finite_geometry_gate: "not_ready" as const,
      publication_grade_gate: "not_ready" as const,
      unsupported_boundary_models: args.config.unsupported_boundary_models,
    },
    switching,
    decoherence,
    dp,
    inference: {
      power,
      rate_only_accessibility_gate: power.total_shots <= 1e9 ? "review" as const : "not_ready" as const,
      dynamics_signature: dynamics,
      collapse_identifiability_gate: dynamics.status === "diagnostic_ready" ? "review" as const : "blocked" as const,
    },
    manifold,
    campaign_gates: {
      equilibrium_lifshitz_validation: lifshitzValidationPass ? "pass" as const : "not_ready" as const,
      publication_grade_casimir_solver: "not_ready" as const,
      measured_switching_sidecar: switching.evidence_gate,
      measured_decoherence_budget: decoherence.evidence_gate,
      realistic_dp_numerical_convergence: dp.numerical_convergence_gate,
      realistic_dp_branch_receipts: dp.provenance_gate,
      statistical_accessibility: power.total_shots <= 1e9 ? "review" as const : "not_ready" as const,
      collapse_identifiability: dynamics.status === "diagnostic_ready" ? "review" as const : "blocked" as const,
      manifold_response_dynamics: "blocked" as const,
    },
    claim_boundaries: [
      "The new Lifshitz solver is a reduced-order equilibrium planar implementation, not a publication-grade finite-geometry solver.",
      "The current switching and decoherence sidecars contain design assumptions rather than measured raw artifacts.",
      "The rigid-sphere DP campaign improves branch geometry but remains an inferred diagnostic model.",
      "Rate-only power cannot identify objective collapse.",
      "No tensor-to-metric-to-coherence response is registered or computed.",
    ],
  };
}

function format(value: number): string {
  return Math.abs(value) >= 1e4 || (Math.abs(value) > 0 && Math.abs(value) < 1e-3)
    ? value.toExponential(4)
    : value.toFixed(6);
}

export function renderCasimirDpNextComputationsMarkdown(
  report: ReturnType<typeof buildCasimirDpNextComputationsReport>,
): string {
  const lifshitzRows = report.lifshitz.cases.map((entry) =>
    `| ${entry.case_id} | ${format(entry.result.pressure_Pa)} | ${format(entry.result.ideal_zero_temperature_reference.pressure_ratio)} | ${entry.result.matsubara_terms_used} | ${entry.result.convergence.status} | ${entry.result.geometry.authority} |`,
  );
  const dpRows = report.dp.rows.map((row) =>
    `| ${row.requested_grid_dimension} | ${row.used_grid_dimensions.join("x")} | ${format(row.deltaE_J)} | ${format(row.rate_s)} | ${row.relative_change_from_prior == null ? "n/a" : format(row.relative_change_from_prior)} | ${format(Math.max(row.mass_relative_error_a, row.mass_relative_error_b))} | ${format(Math.max(row.boundary_shell_mass_fraction_a, row.boundary_shell_mass_fraction_b))} | ${row.provenance_class} |`,
  );
  return `# Casimir-DP Gated Computations Stage-1 Report\n\n**Campaign:** \`${report.campaign_id}\`  \n**Generated:** ${report.generated_at}  \n**Claim tier:** diagnostic  \n**Promotion allowed:** false\n\n## Lifshitz calculation\n\n| Case | Pressure (Pa) | Pressure / ideal T=0 | Matsubara terms | Convergence | Geometry authority |\n|---|---:|---:|---:|---|---|\n${lifshitzRows.join("\n")}\n\n- Ideal validation gate: \`${report.lifshitz.ideal_validation_gate}\`\n- Measured material gate: \`${report.lifshitz.measured_material_gate}\`\n- Finite-geometry gate: \`${report.lifshitz.finite_geometry_gate}\`\n- Publication-grade gate: \`${report.lifshitz.publication_grade_gate}\`\n\n## Switching and decoherence sidecars\n\n- Switching evidence gate: \`${report.switching.evidence_gate}\`\n- Decoherence evidence gate: \`${report.decoherence.evidence_gate}\`\n- Total assumed decoherence rate: \`${format(report.decoherence.rate_s)} s^-1\`\n- Combined standard uncertainty: \`${format(report.decoherence.standard_uncertainty_s)} s^-1\`\n- Visibility over the acquisition window: \`${format(report.decoherence.visibility)}\`\n\n## Rigid-sphere DP convergence\n\n| Requested grid | Used grid | Delta E (J) | Rate (s^-1) | Change from prior | Max mass error | Max boundary-shell fraction | Provenance |\n|---:|---|---:|---:|---:|---:|---:|---|\n${dpRows.join("\n")}\n\n- Mass-conservation gate: \`${report.dp.mass_conservation_gate}\`\n- Branch-symmetry gate: \`${report.dp.branch_symmetry_gate}\`\n- Boundary-containment gate: \`${report.dp.boundary_containment_gate}\`\n- Branch-sampling gate: \`${report.dp.branch_sampling_gate}\`\n- Numerical convergence gate: \`${report.dp.numerical_convergence_gate}\`\n- Branch provenance gate: \`${report.dp.provenance_gate}\`\n- Selected tau: \`${format(report.dp.selected_tau_s)} s\`\n\n## Statistical power and dynamics discrimination\n\n- Rate-only shots per setting: \`${format(report.inference.power.shots_per_setting)}\`\n- Total shots: \`${format(report.inference.power.total_shots)}\`\n- Rate-only accessibility: \`${report.inference.rate_only_accessibility_gate}\`\n- Dynamics signature: \`${report.inference.dynamics_signature.status}\`\n- Collapse-identifiability gate: \`${report.inference.collapse_identifiability_gate}\`\n\n## Manifold-response registration\n\nStatus: \`${report.manifold.status}\`. No manifold-response rate is computed.\n\n${report.manifold.blockers.map((blocker) => `- ${blocker}`).join("\n")}\n\n## Campaign gates\n\n${Object.entries(report.campaign_gates).map(([gate, status]) => `- \`${gate}\`: \`${status}\``).join("\n")}\n\n## Claim boundaries\n\n${report.claim_boundaries.map((boundary) => `- ${boundary}`).join("\n")}\n`;
}

type CliArgs = { configPath: string; outRoot: string | null; reportDoc: string | null };

function parseArgs(argv: string[]): CliArgs {
  let configPath = "configs/research/casimir-dp-next-computations.v1.json";
  let outRoot: string | null = null;
  let reportDoc: string | null = null;
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    const value = argv[index + 1] ?? "";
    if (argument === "--config") configPath = value;
    else if (argument === "--out") outRoot = value;
    else if (argument === "--report-doc") reportDoc = value;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return { configPath, outRoot, reportDoc };
}

export async function runCasimirDpNextComputations(args: {
  configPath: string;
  outRoot?: string | null;
  reportDoc?: string | null;
  now?: Date;
}) {
  const configPath = path.resolve(args.configPath);
  const configText = await readFile(configPath, "utf8");
  const config = CasimirDpNextComputationsConfig.parse(JSON.parse(configText));
  const now = args.now ?? new Date();
  const report = buildCasimirDpNextComputationsReport({ config, now });
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const outDir = path.resolve(
    args.outRoot ?? path.join("artifacts", "research", "casimir-dp-next-computations", `${config.campaign_id}-${timestamp}`),
  );
  await mkdir(outDir, { recursive: true });
  const json = stableJson(report);
  const markdown = renderCasimirDpNextComputationsMarkdown(report).replace(
    / {2}\n/g,
    "<br>\n",
  );
  await writeFile(path.join(outDir, "gated-computations-report.json"), json, "utf8");
  await writeFile(path.join(outDir, "gated-computations-report.md"), markdown, "utf8");
  const receipt = {
    schema_version: "casimir_dp_next_computations_receipt/1",
    campaign_id: config.campaign_id,
    generated_at: now.toISOString(),
    status: "completed",
    promotion_allowed: false,
    input: { path: path.relative(process.cwd(), configPath).replace(/\\/g, "/"), sha256: sha256(configText) },
    outputs: [
      { path: "gated-computations-report.json", sha256: sha256(json) },
      { path: "gated-computations-report.md", sha256: sha256(markdown) },
    ],
    campaign_gates: report.campaign_gates,
  };
  await writeFile(path.join(outDir, "gated-computations-receipt.json"), stableJson(receipt), "utf8");
  if (args.reportDoc) {
    const reportDoc = path.resolve(args.reportDoc);
    await mkdir(path.dirname(reportDoc), { recursive: true });
    await writeFile(reportDoc, markdown, "utf8");
  }
  return { outDir, report, receipt };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  runCasimirDpNextComputations({
    configPath: args.configPath,
    outRoot: args.outRoot,
    reportDoc: args.reportDoc,
  }).then((result) => {
    process.stdout.write(stableJson({
      status: "completed",
      outDir: result.outDir,
      campaign_gates: result.report.campaign_gates,
    }));
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
