#!/usr/bin/env -S tsx

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCasimirDpOrPhaseStage2Report,
} from "../../shared/casimir-dp-or-phase-stage2";
import { evaluateCasimirDpProposalReadiness } from "../../shared/casimir-dp-proposal-readiness";
import {
  CasimirDpNextComputationsConfig,
} from "../../shared/contracts/casimir-dp-next-computations.v1";
import {
  CasimirDpOrPhaseStage2Config,
  type CasimirDpOrPhaseStage2Config as CasimirDpOrPhaseStage2ConfigType,
} from "../../shared/contracts/casimir-dp-or-phase-stage2.v1";
import {
  CasimirDpProposalClosureConfig,
} from "../../shared/contracts/casimir-dp-proposal-closure.v1";
import {
  buildCasimirDpNextComputationsReport,
} from "./run-casimir-dp-next-computations";

export const CASIMIR_DP_OR_PHASE_STAGE2_RUN_ORDER = [
  "freeze_stage2_claims_upstream_hashes_and_sign_conventions",
  "validate_dp_grid_origin_branch_mass_and_containment",
  "compute_pairwise_dp_self_energy",
  "compute_softened_branch_difference_potential",
  "apply_potential_self_energy_equivalence_gate",
  "apply_dp_resolution_provenance_and_bounds_gates",
  "compute_registered_qed_boundary_phase",
  "compute_ambient_gravity_phase_and_tilt_control",
  "compute_interference_quadratures_and_visibility",
  "replay_fixed_branch_dp_boundary_null",
  "run_branch_perturbation_sensitivity",
  "evaluate_three_lane_plausibility_ledger",
  "apply_bridge_and_claim_ceiling_gates",
  "write_hashed_stage2_receipt_and_update_paper",
] as const;

const stableJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function assertRunOrder(config: CasimirDpOrPhaseStage2ConfigType): void {
  if (config.run_order.length !== CASIMIR_DP_OR_PHASE_STAGE2_RUN_ORDER.length) {
    throw new Error("stage2 run_order length does not match the registered protocol");
  }
  CASIMIR_DP_OR_PHASE_STAGE2_RUN_ORDER.forEach((stage, index) => {
    if (config.run_order[index] !== stage) {
      throw new Error(`stage2 run_order[${index}] must be ${stage}`);
    }
  });
}

function format(value: number): string {
  if (value === 0) return "0";
  return Math.abs(value) >= 1e4 || Math.abs(value) < 1e-3
    ? value.toExponential(5)
    : value.toFixed(8);
}

export function renderCasimirDpOrPhaseStage2Markdown(
  report: ReturnType<typeof buildCasimirDpOrPhaseStage2Report>,
): string {
  const laneRows = report.plausibility_lanes.map((lane) =>
    `| ${lane.lane_id} | ${lane.theory_authority} | ${lane.computability} | ${lane.evidence_gate} | ${lane.permitted_claim} |`,
  );
  const perturbationRows = report.dp_audit.branch_perturbation_sensitivity.rows.map(
    (row) =>
      `| ${format(row.branch_separation_offset_m)} | ${format(row.branch_separation_m)} | ${format(Math.min(...row.voxel_size_m))} | ${format(row.sampled_mass_a_kg)} | ${format(row.sampled_mass_b_kg)} | ${format(row.deltaE_J)} | ${format(row.rate_s)} | ${format(row.relative_rate_change_from_nominal)} |`,
  );
  const resolutionRows = report.dp_audit.proposal_resolution_sweep.rows.map(
    (row) =>
      `| ${row.grid_dimension} | ${format(Math.min(...row.voxel_size_m))} | ${format(row.deltaE_J)} | ${format(row.rate_s)} | ${row.relative_change_from_prior == null ? "n/a" : format(row.relative_change_from_prior)} | ${format(Math.max(row.mass_relative_error_a, row.mass_relative_error_b))} |`,
  );
  const identityRows =
    report.dp_audit.stage1_input_compatibility.comparisons.map(
      (comparison) =>
        `| ${comparison.field} | ${format(comparison.stage1_value)} | ${format(comparison.proposal_value)} | ${comparison.matches} |`,
    );
  const fringeRows =
    report.ordinary_phase_and_coherence.interference.probabilities.map((row) =>
      `| ${format(row.analysis_phase_rad)} | ${format(row.p_plus)} | ${format(row.p_minus)} |`,
    );
  return `# Casimir-DP OR/phase Stage-2 report

**Campaign:** \`${report.campaign_id}\`<br>
**Generated:** ${report.generated_at}<br>
**Claim tier:** \`${report.claim_tier}\`<br>
**Promotion allowed:** \`${report.promotion_allowed}\`

## Outcome

The operational QED phase/interference lane and the weak-field DP numerical-audit lane are runnable. Measured phase/coherence evidence remains \`${report.final_gates.measured_qed_phase_and_coherence}\`; collapse identification is \`${report.final_gates.collapse_identification}\`; manifold dynamics are \`${report.final_gates.manifold_dynamics}\`. No manifold-response rate is computed.

## Penrose notation crosswalk

- Penrose 1996: \`${report.notation.penrose_1996_symbol}\`
- Penrose 2014: \`${report.notation.penrose_2014_symbol}\`
- Repository: \`${report.notation.repository_symbol}\` / field \`${report.notation.repository_field}\`
- Proposal particle mass: \`${format(report.notation.particle_mass_kg)} kg\`
- Compton frequency: \`${format(report.notation.compton_frequency_Hz)} Hz\`
- DP characteristic frequency: \`${format(report.notation.dp_characteristic_frequency_Hz)} Hz\`
- Crosswalk: \`${report.notation.crosswalk_status}\`
- Compton/cavity bridge: \`${report.notation.compton_bridge_status}\`

## DP algebra, branch, and invariance audit

- Pairwise energy: \`${format(report.dp_audit.pairwise.deltaE_J)} J\`
- Potential-form energy: \`${format(report.dp_audit.potential.source_potential_deltaE_J)} J\`
- Potential equivalence relative error: \`${format(report.dp_audit.potential.relative_error)}\`
- Potential equivalence gate: \`${report.dp_audit.potential.gate}\`
- Component-identity relative error: \`${format(report.dp_audit.component_identity.relative_error)}\`
- Component-identity gate: \`${report.dp_audit.component_identity.gate}\`
- Mass-conservation gate: \`${report.dp_audit.branch_sampling.mass_conservation_gate}\`
- Branch-symmetry gate: \`${report.dp_audit.branch_sampling.branch_symmetry_gate}\`
- Boundary-containment gate: \`${report.dp_audit.branch_sampling.containment_gate}\`
- Stage-1/proposal input compatibility: \`${report.dp_audit.stage1_input_compatibility.gate}\`
- Stage-1 authority transfer: \`${report.dp_audit.stage1_authority_transfer_gate}\`
- Upstream Stage-1 spatial convergence: \`${report.dp_audit.upstream_stage1_gates.numerical_convergence_gate}\`
- Branch provenance: \`${report.dp_audit.upstream_stage1_gates.provenance_gate}\`
- Proposal-branch provenance: \`${report.dp_audit.proposal_branch_provenance_gate}\`
- Proposal-specific experimental bounds: \`${report.dp_audit.proposal_experimental_bounds_gate}\`
- Fixed-branch boundary null: \`${report.dp_audit.fixed_branch_boundary_null.gate}\`
- Fixed-branch boundary-rate difference: \`${format(report.dp_audit.fixed_branch_boundary_null.delta_boundary_rate_s)} s^-1\`
- Generic signed-stress adapter bridge: \`${report.dp_audit.generic_signed_stress_adapter_bridge_status}\`

### Cross-campaign input identity

| Field | Stage-1 value | Proposal value | Exact match |
|---|---:|---:|---|
${identityRows.join("\n")}

${report.dp_audit.stage1_input_compatibility.authority_effect}

### Proposal-specific resolution sweep

| Grid dimension | Min voxel (m) | Delta E (J) | Rate (s^-1) | Change from prior | Max mass error |
|---:|---:|---:|---:|---:|---:|
${resolutionRows.join("\n")}

- Sampling gate: \`${report.dp_audit.proposal_resolution_sweep.sampling_gate}\`
- Convergence gate: \`${report.dp_audit.proposal_resolution_sweep.convergence_gate}\`
- Relative tolerance: \`${format(report.dp_audit.proposal_resolution_sweep.relative_tolerance)}\`

### Branch-perturbation sensitivity

| Separation offset (m) | Separation (m) | Min voxel (m) | Sampled mass A (kg) | Sampled mass B (kg) | Delta E (J) | Rate (s^-1) | Relative rate change |
|---:|---:|---:|---:|---:|---:|---:|---:|
${perturbationRows.join("\n")}

- Frozen-grid identity gate: \`${report.dp_audit.branch_perturbation_sensitivity.frozen_grid_identity_gate}\`
- Sampled-mass stability gate: \`${report.dp_audit.branch_perturbation_sensitivity.sampled_mass_stability_gate}\`
- Spatial-resolution gate: \`${report.dp_audit.branch_perturbation_sensitivity.spatial_resolution_gate}\`
- Physical-sensitivity gate: \`${report.dp_audit.branch_perturbation_sensitivity.sensitivity_gate}\`
- Interpretation: ${report.dp_audit.branch_perturbation_sensitivity.interpretation}

## Ordinary phase, visibility, and interference

- Boundary phase contrast: \`${format(report.ordinary_phase_and_coherence.boundary_phase.boundary_phase_contrast_rad)} rad\`
- Visibility at the registered observation time: \`${format(report.ordinary_phase_and_coherence.visibility)}\`
- Maximum differential-force noise: \`${format(report.ordinary_phase_and_coherence.maximum_differential_force_noise_N)} N\`
- Measured evidence gate: \`${report.ordinary_phase_and_coherence.measured_evidence_gate}\`
- Uncertainty model: \`${report.ordinary_phase_and_coherence.boundary_phase.uncertainty_model}\`

| Analysis phase (rad) | P(+) | P(-) |
|---:|---:|---:|
${fringeRows.join("\n")}

The boundary has a controlled state, not a phase with which the particle becomes "in phase." These ports measure the material-branch action phase and visibility.

## Ambient-gravity phase control

- Fully vertical phase: \`${format(report.ambient_gravity_control.fully_vertical_phase_rad)} rad\`
- Maximum boundary-correlated vertical projection: \`${format(report.ambient_gravity_control.maximum_boundary_correlated_vertical_projection_m)} m\`
- Maximum small-angle tilt: \`${format(report.ambient_gravity_control.maximum_small_angle_tilt_rad)} rad\`
- Measured control gate: \`${report.ambient_gravity_control.measured_gate}\`

This is an ordinary unitary gravitational phase control, not an OR rate.

## Three-lane plausibility ledger

No numerical plausibility score is produced.

| Lane | Theory authority | Computability | Evidence gate | Permitted claim |
|---|---|---|---|---|
${laneRows.join("\n")}

## Bridge gate

Status: \`${report.bridge_gate.status}\`

${report.bridge_gate.missing_fields.map((field) => `- missing: \`${field}\``).join("\n")}

Required preregistered falsifiers:

${report.bridge_gate.required_falsifiers.map((falsifier) => `- ${falsifier}`).join("\n")}

## Final gates

${Object.entries(report.final_gates).map(([gate, status]) => `- \`${gate}\`: \`${status}\``).join("\n")}

## Claim boundaries

${report.claim_boundaries.map((boundary) => `- ${boundary}`).join("\n")}
`;
}

async function loadUpstreamAuthorities(config: CasimirDpOrPhaseStage2ConfigType) {
  const loaded = await Promise.all(config.upstream_authorities.map(async (authority) => {
    const absolutePath = path.resolve(authority.path);
    const text = await readFile(absolutePath, "utf8");
    const actual = sha256(text);
    return {
      authority,
      absolutePath,
      text,
      integrity: {
        role: authority.role,
        path: authority.path,
        expected_sha256: authority.sha256,
        actual_sha256: actual,
        gate: actual === authority.sha256 ? "pass" as const : "not_ready" as const,
      },
    };
  }));
  const stage1 = loaded.find(
    (entry) => entry.authority.role === "stage1_gated_computations",
  );
  const proposal = loaded.find(
    (entry) => entry.authority.role === "proposal_closure",
  );
  if (stage1 == null || proposal == null) {
    throw new Error("stage2 upstream authority role missing");
  }
  return { loaded, stage1, proposal };
}

export async function runCasimirDpOrPhaseStage2(args: {
  configPath: string;
  outRoot?: string | null;
  reportDoc?: string | null;
  now?: Date;
}) {
  const configPath = path.resolve(args.configPath);
  const configText = await readFile(configPath, "utf8");
  const config = CasimirDpOrPhaseStage2Config.parse(JSON.parse(configText));
  assertRunOrder(config);
  const upstream = await loadUpstreamAuthorities(config);
  const stage1Config = CasimirDpNextComputationsConfig.parse(
    JSON.parse(upstream.stage1.text),
  );
  const proposalConfig = CasimirDpProposalClosureConfig.parse(
    JSON.parse(upstream.proposal.text),
  );
  const now = args.now ?? new Date();
  const stage1Report = buildCasimirDpNextComputationsReport({
    config: stage1Config,
    now,
  });
  const proposalReport = evaluateCasimirDpProposalReadiness(proposalConfig);
  const report = buildCasimirDpOrPhaseStage2Report({
    config,
    proposal: proposalConfig,
    stage1Gates: {
      numerical_convergence_gate: stage1Report.dp.numerical_convergence_gate,
      branch_sampling_gate: stage1Report.dp.branch_sampling_gate,
      provenance_gate: stage1Report.dp.provenance_gate,
      experimental_bounds_gate: stage1Report.dp.experimental_bounds_gate,
    },
    stage1DpIdentity: {
      mass_kg: stage1Config.dp_campaign.mass_kg,
      radius_m: stage1Config.dp_campaign.radius_m,
      branch_separation_m:
        stage1Config.dp_campaign.branch_separation_m,
      ell_m: stage1Config.dp_campaign.ell_m,
    },
    proposalGates: {
      proposal_package: proposalReport.gate_ledger.proposal_package,
      measured_switching_and_decoherence_evidence:
        proposalReport.gate_ledger.measured_switching_and_decoherence_evidence,
      collapse_identification:
        proposalReport.gate_ledger.collapse_identification,
      manifold_dynamics: proposalReport.gate_ledger.manifold_dynamics,
    },
    upstreamIntegrity: upstream.loaded.map((entry) => entry.integrity),
    now,
  });

  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const outDir = path.resolve(
    args.outRoot ??
      path.join(
        "artifacts",
        "research",
        "casimir-dp-or-phase-stage2",
        `${config.campaign_id}-${timestamp}`,
      ),
  );
  await mkdir(outDir, { recursive: true });
  const json = stableJson(report);
  const markdown = renderCasimirDpOrPhaseStage2Markdown(report);
  await writeFile(path.join(outDir, "or-phase-stage2-report.json"), json, "utf8");
  await writeFile(path.join(outDir, "or-phase-stage2-report.md"), markdown, "utf8");
  const receipt = {
    schema_version: "casimir_dp_or_phase_stage2_receipt/1",
    campaign_id: config.campaign_id,
    generated_at: now.toISOString(),
    status: "completed",
    promotion_allowed: false,
    input: {
      path: path.relative(process.cwd(), configPath).replace(/\\/g, "/"),
      sha256: sha256(configText),
    },
    upstream_integrity: report.upstream_integrity,
    outputs: [
      { path: "or-phase-stage2-report.json", sha256: sha256(json) },
      { path: "or-phase-stage2-report.md", sha256: sha256(markdown) },
    ],
    final_gates: report.final_gates,
  };
  const receiptJson = stableJson(receipt);
  await writeFile(
    path.join(outDir, "or-phase-stage2-receipt.json"),
    receiptJson,
    "utf8",
  );
  if (args.reportDoc) {
    const reportDoc = path.resolve(args.reportDoc);
    await mkdir(path.dirname(reportDoc), { recursive: true });
    await writeFile(reportDoc, markdown, "utf8");
  }
  return {
    outDir,
    report,
    receipt,
    receipt_sha256: sha256(receiptJson),
  };
}

type CliArgs = {
  configPath: string;
  outRoot: string | null;
  reportDoc: string | null;
};

function parseArgs(argv: string[]): CliArgs {
  let configPath = "configs/research/casimir-dp-or-phase-stage2.v1.json";
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

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  runCasimirDpOrPhaseStage2({
    configPath: args.configPath,
    outRoot: args.outRoot,
    reportDoc: args.reportDoc,
  }).then((result) => {
    process.stdout.write(stableJson({
      status: "completed",
      outDir: result.outDir,
      receipt_sha256: result.receipt_sha256,
      final_gates: result.report.final_gates,
    }));
  }).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
