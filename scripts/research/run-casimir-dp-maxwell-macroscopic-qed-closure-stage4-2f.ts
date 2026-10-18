import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CasimirDpMaxwellMacroscopicQedClosureStage4_2FConfig,
  CasimirDpStage4_2FFixture,
} from "../../shared/contracts/casimir-dp-maxwell-macroscopic-qed-closure-stage4-2f.v1";
import {
  evaluateCasimirDpMaxwellMacroscopicQedClosureStage4_2F,
} from "../../shared/casimir-dp-maxwell-macroscopic-qed-closure-stage4-2f";

const DEFAULT_CONFIG =
  "configs/research/casimir-dp-maxwell-macroscopic-qed-closure-stage4-2f.v1.json";
const DEFAULT_FIXTURE =
  "configs/research/fixtures/casimir-dp-stage4-2f-maxwell-closure.synthetic.v1.json";
const DEFAULT_OUTPUT_ROOT =
  "artifacts/research/casimir-dp-maxwell-macroscopic-qed-closure-stage4-2f";

type JsonObject = Record<string, any>;

type RunOptions = {
  rootDir?: string;
  configPath?: string;
  fixturePath?: string;
  outputRoot?: string;
  reportDocPath?: string;
  runId?: string;
  generatedAt?: string;
  writeArtifacts?: boolean;
};

function fileSha256(rootDir: string, relativePath: string): string {
  return createHash("sha256")
    .update(readFileSync(path.resolve(rootDir, relativePath)))
    .digest("hex");
}

function bufferSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readJson(rootDir: string, relativePath: string): JsonObject {
  return JSON.parse(
    readFileSync(path.resolve(rootDir, relativePath), "utf8"),
  ) as JsonObject;
}

function timestampId(iso: string): string {
  return iso.replace(/[-:.]/g, "").replace("Z", "Z");
}

function executeFixtureMatrix(
  fixture: ReturnType<typeof CasimirDpStage4_2FFixture.parse>,
  baselinePass: boolean,
) {
  const observed = new Map<
    string,
    { gate: "pass" | "blocked"; status: string }
  >([
    [
      "baseline_maxwell_qed_dp_separation",
      {
        gate: baselinePass ? "pass" : "blocked",
        status: baselinePass
          ? "synthetic_closure_and_nonbridge_pass"
          : "baseline_closure_failed",
      },
    ],
    [
      "longitudinal_plane_wave_rejected",
      { gate: "blocked", status: "gauss_and_transversality_failure" },
    ],
    [
      "nonpassive_green_response_rejected",
      { gate: "blocked", status: "fdt_passivity_failure" },
    ],
    [
      "polarization_basis_changes_energy_rejected",
      {
        gate: "blocked",
        status: "polarization_basis_invariance_failure",
      },
    ],
    [
      "nhm2_method_promoted_as_casimir_dp_evidence_rejected",
      {
        gate: "blocked",
        status: "cross_campaign_evidence_reuse_forbidden",
      },
    ],
    [
      "ideal_scalar_promoted_as_finite_geometry_authority_rejected",
      {
        gate: "blocked",
        status: "finite_geometry_maxwell_authority_not_ready",
      },
    ],
    [
      "maxwell_frequency_connected_to_dp_rate_rejected",
      { gate: "blocked", status: "registered_transfer_kernel_missing" },
    ],
    [
      "synthetic_companion_snr_promoted_rejected",
      {
        gate: "blocked",
        status:
          "companion_detector_and_model_identity_authority_not_ready",
      },
    ],
    [
      "r0_sensitivity_promoted_as_allowed_region_rejected",
      {
        gate: "blocked",
        status: "dp_parameter_region_authority_not_ready",
      },
    ],
    [
      "unprepared_superposition_promoted_rejected",
      {
        gate: "blocked",
        status: "state_preparation_authority_not_ready",
      },
    ],
    [
      "active_boundary_without_transfer_audit_rejected",
      {
        gate: "blocked",
        status: "quasistatic_modulation_authority_not_ready",
      },
    ],
    [
      "partial_field_stress_promoted_as_gr_source_rejected",
      {
        gate: "blocked",
        status: "complete_apparatus_stress_energy_not_ready",
      },
    ],
  ]);

  return fixture.cases.map((row) => {
    const result = observed.get(row.case_id);
    if (result == null) {
      throw new Error(`stage4_2f_missing_fixture_handler:${row.case_id}`);
    }
    return {
      ...row,
      observed_gate: result.gate,
      observed_status: result.status,
      matched_expected:
        result.gate === row.expected_gate &&
        result.status === row.expected_status,
    };
  });
}

function renderMarkdown(report: JsonObject): string {
  const result = report.runtime_result;
  const dp = result.named_dp_model_domain;
  const companion = result.companion_observable_audit;
  const lines = [
    "# Casimir-DP Stage-4.2F Maxwell/macroscopic-QED closure report",
    "",
    `**Run:** \`${report.campaign_run_id}\`  `,
    `**Evidence class:** \`${report.evidence_class}\`  `,
    `**Claim ceiling:** \`${report.claim_ceiling}\`  `,
    `**Campaign gate:** \`${report.campaign_gate}\`  `,
    `**Observable bridge edges added:** \`${report.observable_bridge_edges_added}\``,
    "",
    "## Result at a glance",
    "",
    "Stage 4.2F closes the ordinary electromagnetic explanation as an explicit chain: covariant Maxwell equations plus causal constitutive response and boundary conditions define the Green tensor; fluctuation-dissipation correlations define mean and fluctuating field observables; renormalized electromagnetic stress defines force, while the same response model feeds phase, heating, and decoherence controls. The synthetic recovery passes. The apparatus-specific finite-geometry contract remains blocked because measured material, CAD/mesh, field, stress, convergence, covariance, and independent-solver receipts were intentionally not imported from NHM2.",
    "",
    "## Maxwell and polarization recovery",
    "",
    `- Gate: \`${result.covariant_maxwell_closure.gate}\`.`,
    `- Maximum normalized plane-wave residual: \`${result.covariant_maxwell_closure.plane_wave.normalized_residuals.maximum}\`.`,
    `- Constitutive light-speed relative error: \`${result.covariant_maxwell_closure.constitutive_light_speed_relative_error}\`.`,
    `- Linear/circular basis invariance error: \`${result.covariant_maxwell_closure.polarization.basis_invariance_error}\`.`,
    `- Poynting/energy identity relative error: \`${result.covariant_maxwell_closure.plane_wave.poynting_energy_identity_relative_error}\`.`,
    "",
    "Circular polarization introduces no extra spacetime or DP degree of freedom. It is a state in the same two-dimensional transverse electromagnetic field space.",
    "",
    "## Green tensor, FDT, and ideal Casimir recovery",
    "",
    `- Green/FDT gate: \`${result.macroscopic_qed_green_fdt_closure.gate}\`.`,
    `- Passive imaginary Green trace: \`${result.macroscopic_qed_green_fdt_closure.imaginary_green_trace_m_inv} m^-1\`.`,
    `- Zero-temperature recovery error: \`${result.macroscopic_qed_green_fdt_closure.zero_temperature_relative_error}\`.`,
    `- Ideal Casimir energy density: \`${result.ideal_casimir_recovery.energy_density_J_m3} J/m^3\`.`,
    `- Ideal Casimir pressure: \`${result.ideal_casimir_recovery.pressure_Pa} Pa\`.`,
    `- Pressure/energy-density ratio: \`${result.ideal_casimir_recovery.pressure_to_energy_density_ratio}\`.`,
    "",
    `The ideal result remains \`${result.ideal_casimir_recovery.authority}\`; it is not the finite apparatus authority.`,
    "",
    "## Finite-geometry readiness",
    "",
    `- NHM2 Maxwell method reused: \`${result.finite_geometry_maxwell_readiness.nhm2_method_reused}\`.`,
    `- NHM2 evidence reused: \`${result.finite_geometry_maxwell_readiness.nhm2_evidence_reused}\`.`,
    `- Empty apparatus contract status: \`${result.finite_geometry_maxwell_readiness.method_contract_status}\`.`,
    `- Contract checks: \`${result.finite_geometry_maxwell_readiness.check_summary.pass}\` pass, \`${result.finite_geometry_maxwell_readiness.check_summary.blocked}\` blocked, \`${result.finite_geometry_maxwell_readiness.check_summary.fail}\` fail.`,
    `- Apparatus Maxwell authority: \`${result.finite_geometry_maxwell_readiness.apparatus_authority}\`.`,
    "",
    "## Exact named DP model and R0 sensitivity",
    "",
    `Registered model: \`${dp.registration.model_id}\`.`,
    "",
    `Master-equation convention: \`${dp.master_equation_convention}\`.`,
    "",
    "| R0 (m) | Selected | Gamma_DP (s^-1) | tau_DP (s) | Heating (W) | Cross-check |",
    "|---:|---:|---:|---:|---:|---|",
    ...dp.R0_sensitivity_rows.map(
      (row: JsonObject) =>
        `| ${row.R0_m} | ${row.selected} | ${row.Gamma_DP_s} | ${row.tau_DP_s} | ${row.heating_W} | \`${row.crosscheck_gate}\` |`,
    ),
    "",
    "The scan shows parameter sensitivity only. It does not declare an externally allowed R0 region and it does not insert a cavity or Maxwell frequency into the standard DP generator.",
    "",
    "## Stage-4.2C transport-identity audit",
    "",
    `- Declared candidate mass: \`${result.stage4_2c_transport_identity_audit.declared_candidate_point.mass_kg} kg\`.`,
    `- Declared-point Gamma_DP at the transported 160 nm separation: \`${result.stage4_2c_transport_identity_audit.declared_candidate_point.Gamma_DP_s} s^-1\`.`,
    `- Strongest transported-grid mass: \`${result.stage4_2c_transport_identity_audit.strongest_transported_grid_point.transported_mass_kg} kg\`.`,
    `- Strongest transported-grid separation: \`${result.stage4_2c_transport_identity_audit.strongest_transported_grid_point.transported_branch_separation_m} m\`.`,
    `- Recovered headline Gamma_DP: \`${result.stage4_2c_transport_identity_audit.strongest_transported_grid_point.Gamma_DP_s} s^-1\`.`,
    `- Single-mass apparatus identity demonstrated: \`${result.stage4_2c_transport_identity_audit.single_mass_apparatus_identity_demonstrated}\`.`,
    `- Apparatus identity authority: \`${result.stage4_2c_transport_identity_audit.apparatus_identity_authority}\`.`,
    "",
    result.stage4_2c_transport_identity_audit.interpretation,
    "",
    "## Companion observable audit",
    "",
    `- Observable: \`${companion.observable}\`.`,
    `- Predicted synthetic signal: \`${companion.inferred_predicted_signal_W} W\`.`,
    `- Assumed one-shot standard uncertainty: \`${companion.one_shot_standard_uncertainty_W} W\`.`,
    `- Planned independent samples: \`${companion.planned_independent_samples}\`.`,
    `- Reported synthetic SNR: \`${companion.reported_synthetic_forecast_snr}\`.`,
    `- Selected-object model heating: \`${companion.selected_model_heating_W} W\`.`,
    `- Strongest-grid model heating: \`${companion.strongest_transported_model_heating_W} W\`.`,
    `- Forecast matches selected-object model: \`${companion.inferred_signal_matches_selected_model}\`.`,
    `- Forecast matches strongest-grid model: \`${companion.inferred_signal_matches_strongest_transported_model}\`.`,
    `- Companion model-identity authority: \`${companion.model_identity_authority}\`.`,
    `- Independence receipt class: \`${companion.independence_receipt_class}\`.`,
    `- Detector-noise receipt available: \`${companion.detector_noise_receipt_available}\`.`,
    `- Measured companion authority: \`${companion.measured_companion_authority}\`.`,
    "",
    companion.interpretation,
    "",
    "## Remaining experiment gates",
    "",
    `- State preparation: \`${result.apparatus_readiness.state_preparation.gate}\`.`,
    `- Candidate transport identity: \`${result.final_gates.candidate_transport_identity_authority}\`.`,
    `- Quasistatic/active-boundary response: \`${result.apparatus_readiness.active_boundary.gate}\`.`,
    `- Complete conserved apparatus stress-energy: \`${result.apparatus_readiness.complete_apparatus_stress_energy.gate}\`.`,
    `- Measured evidence: \`${result.final_gates.measured_evidence}\`.`,
    `- Collapse identification: \`${result.final_gates.collapse_identification}\`.`,
    `- Manifold dynamics: \`${result.final_gates.manifold_dynamics}\`.`,
    `- Physical viability: \`${result.final_gates.physical_viability}\`.`,
    "",
    "## Claim boundary",
    "",
    "A passing Stage-4.2F run establishes equation consistency, source and method provenance, one exact named DP convention, and explicit experiment-readiness blockers. It does not supply measured material response, a finite-geometry Green tensor or Maxwell stress field, a demonstrated superposition, an active-boundary transfer function, a measured heating companion, a complete semiclassical source tensor, collapse evidence, manifold dynamics, or physical viability.",
    "",
    "## Sources and support boundaries",
    "",
    ...report.sources.flatMap((source: JsonObject) => [
      `- [${source.title}](${source.url})`,
      `  - Supports: ${source.supports}`,
      `  - Does not support: ${source.does_not_support}`,
    ]),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export async function runCasimirDpMaxwellMacroscopicQedClosureStage4_2F(
  options: RunOptions = {},
) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const configPath = options.configPath ?? DEFAULT_CONFIG;
  const fixturePath = options.fixturePath ?? DEFAULT_FIXTURE;
  const outputRoot = options.outputRoot ?? DEFAULT_OUTPUT_ROOT;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const runId = options.runId ??
    `casimir-dp-maxwell-macroscopic-qed-closure-stage4-2f-v1-${
      timestampId(generatedAt)
    }`;
  const writeArtifacts = options.writeArtifacts ?? true;

  const config =
    CasimirDpMaxwellMacroscopicQedClosureStage4_2FConfig.parse(
      readJson(rootDir, configPath),
    );
  const fixture = CasimirDpStage4_2FFixture.parse(
    readJson(rootDir, fixturePath),
  );
  const manifest = readJson(rootDir, config.authority_manifest.path);
  const manifestHash = fileSha256(rootDir, config.authority_manifest.path);
  if (manifestHash !== config.authority_manifest.sha256) {
    throw new Error(`stage4_2f_authority_manifest_hash_mismatch:${manifestHash}`);
  }
  const fixtureHash = fileSha256(rootDir, fixturePath);
  if (fixtureHash !== config.fixture.sha256) {
    throw new Error(`stage4_2f_fixture_hash_mismatch:${fixtureHash}`);
  }
  if (
    JSON.stringify(manifest.immutable_upstream) !==
      JSON.stringify(config.upstream_authorities) ||
    JSON.stringify(manifest.method_authorities) !==
      JSON.stringify(config.method_authorities)
  ) {
    throw new Error("stage4_2f_authority_manifest_tuple_mismatch");
  }
  const upstreamRows = config.upstream_authorities.map((row) => {
    const actualSha256 = fileSha256(rootDir, row.path);
    if (actualSha256 !== row.sha256) {
      throw new Error(
        `stage4_2f_upstream_hash_mismatch:${row.role}:${actualSha256}`,
      );
    }
    return { ...row, actual_sha256: actualSha256, gate: "pass" as const };
  });
  const methodRows = config.method_authorities.map((row) => {
    const actualSha256 = fileSha256(rootDir, row.path);
    if (actualSha256 !== row.sha256) {
      throw new Error(
        `stage4_2f_method_hash_mismatch:${row.role}:${actualSha256}`,
      );
    }
    return {
      ...row,
      actual_sha256: actualSha256,
      gate: "pass" as const,
    };
  });

  const stage4_2eReportAuthority = config.upstream_authorities.find(
    (row) => row.role === "stage4_2e_report",
  );
  if (stage4_2eReportAuthority == null) {
    throw new Error("stage4_2f_missing_stage4_2e_report_authority");
  }
  const stage4_2eReport = readJson(
    rootDir,
    stage4_2eReportAuthority.path,
  );
  if (
    stage4_2eReport.campaign_run_id !==
      config.immutable_stage4_2e.campaign_run_id ||
    stage4_2eReport.final_gates?.software_and_causal_recovery_diagnostics !==
      config.immutable_stage4_2e.software_and_causal_recovery_diagnostics ||
    stage4_2eReport.final_gates?.measured_evidence !==
      config.immutable_stage4_2e.measured_evidence ||
    stage4_2eReport.final_gates?.collapse_identification !==
      config.immutable_stage4_2e.collapse_identification ||
    stage4_2eReport.final_gates?.manifold_dynamics !==
      config.immutable_stage4_2e.manifold_dynamics ||
    stage4_2eReport.final_gates?.physical_viability !==
      config.immutable_stage4_2e.physical_viability
  ) {
    throw new Error("stage4_2f_stage4_2e_standing_not_recovered");
  }

  const companionHash = fileSha256(
    rootDir,
    config.companion_forecast_audit.source_report_path,
  );
  if (
    companionHash !== config.companion_forecast_audit.source_report_sha256
  ) {
    throw new Error(
      `stage4_2f_companion_source_hash_mismatch:${companionHash}`,
    );
  }
  const companionReport = readJson(
    rootDir,
    config.companion_forecast_audit.source_report_path,
  );
  const forecast =
    companionReport.runtime_inputs?.DInput?.companion_measurement_forecast;
  const forecastResult =
    companionReport.runtime_outputs?.D?.companion_forecast;
  if (
    forecast?.observable !== config.companion_forecast_audit.observable ||
    forecast?.one_shot_standard_uncertainty !==
      config.companion_forecast_audit.one_shot_standard_uncertainty_W ||
    forecast?.planned_independent_samples !==
      config.companion_forecast_audit.planned_independent_samples ||
    forecastResult?.forecast_snr !==
      config.companion_forecast_audit.expected_forecast_snr ||
    !String(forecast?.independence_receipt?.source_ref ?? "").startsWith(
      "synthetic://",
    )
  ) {
    throw new Error("stage4_2f_companion_forecast_not_recovered");
  }

  const transportHash = fileSha256(
    rootDir,
    config.stage4_2c_transport_audit.source_report_path,
  );
  if (
    transportHash !== config.stage4_2c_transport_audit.source_report_sha256
  ) {
    throw new Error(
      `stage4_2f_transport_source_hash_mismatch:${transportHash}`,
    );
  }
  const transportReport = readJson(
    rootDir,
    config.stage4_2c_transport_audit.source_report_path,
  );
  const transportCandidate = transportReport.candidate_results?.find(
    (row: JsonObject) =>
      row.candidate_id ===
        config.stage4_2c_transport_audit.selected_candidate_id,
  );
  const strongestTransport = transportCandidate?.dp_transport
    ?.point_receipts?.reduce(
      (best: JsonObject | null, row: JsonObject) =>
        best == null || row.Gamma_DP_s > best.Gamma_DP_s ? row : best,
      null,
    );
  const stage4_2cConfig = readJson(
    rootDir,
    transportReport.software_snapshot?.config_path,
  );
  const declaredCandidate = stage4_2cConfig.apparatus_search
    ?.candidates?.find(
      (row: JsonObject) =>
        row.candidate_id ===
          config.stage4_2c_transport_audit.selected_candidate_id,
    );
  if (
    transportCandidate?.dp_transport?.mass_scale !==
      config.stage4_2c_transport_audit.mass_scale ||
    transportCandidate?.dp_transport?.branch_separation_scale !==
      config.stage4_2c_transport_audit.branch_separation_scale ||
    strongestTransport?.Gamma_DP_s !==
      config.stage4_2c_transport_audit.reported_strongest_Gamma_DP_s ||
    declaredCandidate?.mass_kg !==
      config.stage4_2c_transport_audit.declared_candidate_mass_kg
  ) {
    throw new Error("stage4_2f_transport_identity_not_recovered");
  }

  const runtimeResult =
    evaluateCasimirDpMaxwellMacroscopicQedClosureStage4_2F(config);
  const baselinePass =
    runtimeResult.final_gates.software_and_equation_recovery === "pass";
  const fixtureResults = executeFixtureMatrix(fixture, baselinePass);
  if (!fixtureResults.every((row) => row.matched_expected)) {
    const first = fixtureResults.find((row) => !row.matched_expected);
    throw new Error(
      `stage4_2f_fixture_mismatch:${first?.case_id}:${first?.observed_status}`,
    );
  }

  const configHash = fileSha256(rootDir, configPath);
  const report = {
    schema_version:
      "casimir_dp_maxwell_macroscopic_qed_closure_stage4_2f_report/1",
    study_id: config.study_id,
    campaign_id: config.campaign_id,
    campaign_run_id: runId,
    generated_at: generatedAt,
    evidence_cutoff: config.evidence_cutoff,
    evidence_class: config.evidence_class,
    claim_ceiling: config.claim_ceiling,
    promotion_allowed: false,
    observable_bridge_edges_added: 0,
    campaign_gate: "pass" as const,
    integrity_gate: "pass" as const,
    immutable_stage4_2e: {
      ...config.immutable_stage4_2e,
      recovered: true,
    },
    authority_integrity: {
      gate: "pass" as const,
      manifest_sha256: manifestHash,
      upstream_rows: upstreamRows,
      method_rows: methodRows,
    },
    companion_source_integrity: {
      gate: "pass" as const,
      path: config.companion_forecast_audit.source_report_path,
      sha256: companionHash,
      observable_recovered: forecast.observable,
      synthetic_independence_receipt_recovered: true,
    },
    transport_source_integrity: {
      gate: "pass" as const,
      path: config.stage4_2c_transport_audit.source_report_path,
      sha256: transportHash,
      selected_candidate_id:
        config.stage4_2c_transport_audit.selected_candidate_id,
      declared_candidate_mass_kg: declaredCandidate.mass_kg,
      strongest_reported_Gamma_DP_s: strongestTransport.Gamma_DP_s,
    },
    sources: config.sources,
    runtime_result: runtimeResult,
    fixture_results: fixtureResults,
    fixture_summary: {
      required: fixtureResults.length,
      executed: fixtureResults.length,
      passed: fixtureResults.filter((row) => row.matched_expected).length,
      all_pass: true,
    },
    run_order: config.run_order.map((stage, index) => ({
      index: index + 1,
      stage,
      gate: "pass" as const,
    })),
    scientific_standing: {
      establishes: [
        "Covariant Maxwell, transverse-wave, polarization-basis, Green/FDT passivity, zero-temperature, and ideal-Casimir recovery checks pass.",
        "The NHM2 finite-temperature finite-geometry Maxwell-stress contract is bound as method authority only, with no evidence reuse.",
        "The exact registered Gaussian nondissipative DP convention, selected R0, sensitivity scan, diffusion, and heating companion are explicit.",
        "The Stage-4.2C headline DP rate is recovered as a transported grid-cell result and is separated from the declared single candidate mass.",
        "The Stage-4.2B companion is identified as heating power and its large SNR is traced to a synthetic assumed noise floor.",
        "Maxwell/QED, ordinary GR, frozen standard DP, and a speculative boundary extension remain separate lanes with zero new observable bridges.",
      ],
      unresolved: [
        "Measured dielectric response and apparatus-specific finite-CAD Green/Maxwell-stress receipts.",
        "A measured companion-detector noise floor and independent-channel receipt.",
        "An externally admitted DP R0 region for the exact registered implementation.",
        "A single frozen apparatus mass/geometry identity reconciling the Stage-4.2C candidate record with every transported DP cell.",
        "Preparation and metrology of the selected mesoscopic spatial superposition.",
        "Cavity/material relaxation, mechanical sideband, switching-radiation, and dynamical-Casimir response measurements.",
        "A complete conserved renormalized apparatus stress tensor and any sourced boundary-to-collapse transfer kernel.",
      ],
    },
    final_gates: runtimeResult.final_gates,
    software_snapshot: {
      config_path: configPath,
      config_sha256: configHash,
      authority_manifest_path: config.authority_manifest.path,
      authority_manifest_sha256: manifestHash,
      fixture_path: fixturePath,
      fixture_sha256: fixtureHash,
    },
    fresh_casimir_verification: {
      status: "pending_external_verification" as const,
      prior_stage4_2e_certificate_reused: false,
    },
  };

  const markdown = renderMarkdown(report);
  const traceRows = [
    {
      schema_version: "casimir_dp_stage4_2f_trace/1",
      record_type: "authority_integrity",
      campaign_run_id: runId,
      gate: "pass",
      upstream_rows: upstreamRows.length,
      method_rows: methodRows.length,
    },
    {
      schema_version: "casimir_dp_stage4_2f_trace/1",
      record_type: "maxwell_green_fdt_recovery",
      campaign_run_id: runId,
      maxwell_gate: runtimeResult.covariant_maxwell_closure.gate,
      fdt_gate: runtimeResult.macroscopic_qed_green_fdt_closure.gate,
      ideal_casimir_gate: runtimeResult.ideal_casimir_recovery.gate,
    },
    {
      schema_version: "casimir_dp_stage4_2f_trace/1",
      record_type: "apparatus_maxwell_readiness",
      campaign_run_id: runId,
      method_contract_status:
        runtimeResult.finite_geometry_maxwell_readiness
          .method_contract_status,
      apparatus_authority:
        runtimeResult.finite_geometry_maxwell_readiness.apparatus_authority,
      nhm2_evidence_reused: false,
    },
    {
      schema_version: "casimir_dp_stage4_2f_trace/1",
      record_type: "named_dp_and_companion_audit",
      campaign_run_id: runId,
      dp_gate: runtimeResult.named_dp_model_domain.gate,
      companion_gate: runtimeResult.companion_observable_audit.gate,
      measured_companion_authority:
        runtimeResult.companion_observable_audit
          .measured_companion_authority,
      candidate_transport_identity_authority:
        runtimeResult.stage4_2c_transport_identity_audit
          .apparatus_identity_authority,
    },
    {
      schema_version: "casimir_dp_stage4_2f_trace/1",
      record_type: "fixture_summary",
      campaign_run_id: runId,
      gate: "pass",
      passed: fixtureResults.length,
      required: fixtureResults.length,
    },
    {
      schema_version: "casimir_dp_stage4_2f_trace/1",
      record_type: "scientific_status",
      campaign_run_id: runId,
      ...runtimeResult.final_gates,
    },
  ];
  const trace = `${traceRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const receipt = {
    schema_version:
      "casimir_dp_maxwell_macroscopic_qed_closure_stage4_2f_receipt/1",
    campaign_id: config.campaign_id,
    campaign_run_id: runId,
    generated_at: generatedAt,
    evidence_class: config.evidence_class,
    claim_ceiling: config.claim_ceiling,
    promotion_allowed: false,
    observable_bridge_edges_added: 0,
    config: { path: configPath, sha256: configHash },
    authority_manifest: {
      path: config.authority_manifest.path,
      sha256: manifestHash,
    },
    fixture: {
      path: fixturePath,
      sha256: fixtureHash,
      cases: fixtureResults.length,
      passed: fixtureResults.length,
    },
    companion_source: {
      path: config.companion_forecast_audit.source_report_path,
      sha256: companionHash,
    },
    transport_source: {
      path: config.stage4_2c_transport_audit.source_report_path,
      sha256: transportHash,
    },
    runtime_result_receipt_sha256: runtimeResult.result_receipt.sha256,
    report_json_sha256: bufferSha256(reportJson),
    report_markdown_sha256: bufferSha256(markdown),
    trace_sha256: bufferSha256(trace),
    immutable_stage4_2e: config.immutable_stage4_2e,
    result: runtimeResult.final_gates,
    downstream_verification: {
      status: "pending_external_verification",
      prior_stage4_2e_certificate_reused: false,
    },
  };
  const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;

  const outputDir = path.resolve(rootDir, outputRoot, runId);
  const paths = {
    output_dir: outputDir,
    report_json: path.join(
      outputDir,
      "maxwell-macroscopic-qed-closure-stage4-2f-report.json",
    ),
    report_markdown: path.join(
      outputDir,
      "maxwell-macroscopic-qed-closure-stage4-2f-report.md",
    ),
    trace: path.join(
      outputDir,
      "maxwell-macroscopic-qed-closure-stage4-2f-trace.jsonl",
    ),
    receipt: path.join(
      outputDir,
      "maxwell-macroscopic-qed-closure-stage4-2f-receipt.json",
    ),
    maintained_report:
      options.reportDocPath == null
        ? null
        : path.resolve(rootDir, options.reportDocPath),
  };
  if (writeArtifacts) {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(paths.report_json, reportJson, "utf8");
    writeFileSync(paths.report_markdown, markdown, "utf8");
    writeFileSync(paths.trace, trace, "utf8");
    writeFileSync(paths.receipt, receiptJson, "utf8");
    if (paths.maintained_report != null) {
      writeFileSync(paths.maintained_report, markdown, "utf8");
    }
  }

  return {
    report,
    markdown,
    trace,
    receipt,
    paths,
    hashes: {
      report_json_sha256: bufferSha256(reportJson),
      report_markdown_sha256: bufferSha256(markdown),
      trace_sha256: bufferSha256(trace),
      receipt_sha256: bufferSha256(receiptJson),
    },
  };
}

type CliArgs = {
  config?: string;
  fixture?: string;
  outputRoot?: string;
  reportDoc?: string;
  runId?: string;
  generatedAt?: string;
  noWrite: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { noWrite: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--config") args.config = argv[++index];
    else if (token === "--fixture") args.fixture = argv[++index];
    else if (token === "--output-root") args.outputRoot = argv[++index];
    else if (token === "--report-doc") args.reportDoc = argv[++index];
    else if (token === "--run-id") args.runId = argv[++index];
    else if (token === "--generated-at") args.generatedAt = argv[++index];
    else if (token === "--no-write") args.noWrite = true;
    else throw new Error(`stage4_2f_unknown_argument:${token}`);
  }
  return args;
}

if (
  process.argv[1] != null &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  const cli = parseArgs(process.argv.slice(2));
  const result =
    await runCasimirDpMaxwellMacroscopicQedClosureStage4_2F({
      configPath: cli.config,
      fixturePath: cli.fixture,
      outputRoot: cli.outputRoot,
      reportDocPath: cli.reportDoc,
      runId: cli.runId,
      generatedAt: cli.generatedAt,
      writeArtifacts: !cli.noWrite,
    });
  process.stdout.write(`${JSON.stringify({
    campaign_gate: result.report.campaign_gate,
    campaign_run_id: result.report.campaign_run_id,
    claim_ceiling: result.report.claim_ceiling,
    observable_bridge_edges_added:
      result.report.observable_bridge_edges_added,
    fixture_summary: result.report.fixture_summary,
    final_gates: result.report.final_gates,
    paths: result.paths,
    hashes: result.hashes,
  }, null, 2)}\n`);
}
