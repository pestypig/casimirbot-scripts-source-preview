import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCasimirDpMaterialThermalOrdinaryNullStage4_2N } from "../../shared/casimir-dp-material-thermal-ordinary-null-stage4-2n";
import {
  CasimirDpMaterialThermalOrdinaryNullFixtureStage4_2N,
  CasimirDpMaterialThermalOrdinaryNullStage4_2NConfig,
} from "../../shared/contracts/casimir-dp-material-thermal-ordinary-null-stage4-2n.v1";

const CONFIG_PATH = "configs/research/casimir-dp-material-thermal-ordinary-null-stage4-2n.v1.json";
const DEFAULT_RUN_ID = "casimir-dp-material-thermal-ordinary-null-stage4-2n-v1-20260806T120000000Z";
const DEFAULT_GENERATED_AT = "2026-08-06T12:00:00.000Z";
const shaBytes = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function reportMarkdown(report: ReturnType<typeof evaluateCasimirDpMaterialThermalOrdinaryNullStage4_2N> & {
  run_id: string;
  generated_at: string;
  upstream_integrity: boolean;
  fixture_integrity: boolean;
  optical_table_integrity: boolean;
}) {
  const qed = report.ordinary_qed;
  const ratio = report.ordinary_complex_coherence_null.cross_ratio;
  return [
    "# Casimir-DP Stage-4.2N material-resolved ordinary-null report",
    "",
    "**Run:** `" + report.run_id + "`  ",
    "**Evidence:** synthetic material/Green/FDT pipeline validation only  ",
    "**Claim ceiling:** material-resolved ordinary-null commissioning requirements only",
    "",
    "## Leading-design binding",
    "",
    "This runtime is bound to Stage-4.2M candidate `" + report.upstream_binding.candidate_id + "`: diamond sphere, radius " + report.upstream_binding.leading_design.radius_m + " m, mass " + report.upstream_binding.leading_design.mass_kg + " kg, branch separation " + report.upstream_binding.leading_design.branch_separation_m + " m, hold " + report.upstream_binding.leading_design.hold_time_s + " s, and gap " + report.upstream_binding.leading_design.gap_m + " m.",
    "",
    "## Synthetic ordinary prediction",
    "",
    "- Mean electromagnetic phase: " + qed.mean_interaction.phase_rad + " rad.",
    "- Phase standard uncertainty: " + qed.mean_interaction.phase_standard_uncertainty_rad + " rad.",
    "- Ramsey loss exponent: " + qed.decoherence.ramsey_chi + ".",
    "- Echo loss exponent: " + qed.decoherence.echo_chi + ".",
    "- Four-cell ordinary-null ratio: `(" + ratio[0] + ", " + ratio[1] + ")`.",
    "- Four-cell ratio phase: " + report.ordinary_complex_coherence_null.phase_rad + " rad; contraction exponent: " + report.ordinary_complex_coherence_null.chi + ".",
    "",
    "The four-cell statistic is `(C_active,separated C_reference,compact)/(C_active,compact C_reference,separated)`. It exposes a boundary-by-superposition interaction after compact-branch and reference-boundary controls. This fixture recovers the statistic; it does not yet supply measured cell means or measured covariance.",
    "",
    "## Recovery and integrity gates",
    "",
    "- Upstream Stage-4.2M receipt integrity: " + report.upstream_integrity + ".",
    "- Fixture integrity: " + report.fixture_integrity + ".",
    "- Optical CSV integrity: " + report.optical_table_integrity + ".",
    "- Maximum propagated imaginary-axis relative uncertainty: " + report.material_response.maximum_propagated_relative_uncertainty + ".",
    "- Green reciprocity gate: " + qed.green_tensor_diagnostics.reciprocity_gate + ".",
    "- Two-sided FDT symmetry gate: " + qed.noise.two_sided_spectrum_symmetry.gate + ".",
    "- Zero-coupling recovery: " + report.standard_limits.zero_coupling.gate + ".",
    "- Infinite-distance recovery: " + report.standard_limits.infinite_distance.gate + ".",
    "- Planck-Stefan-Boltzmann relative error: " + report.thermal_recovery.planck_stefan_boltzmann.sigma_relative_error + ".",
    "- Calibration-intervention recovery: " + report.calibration_recovery.gate + ".",
    "- Software pipeline: " + report.readiness.software_pipeline + ".",
    "",
    "## Separate Diósi comparator",
    "",
    "The frozen conservative and effective-Gaussian Diósi exponents are " + report.frozen_dp_comparator.conservative_density_envelope_exponent + " and " + report.frozen_dp_comparator.gaussian_exponent + ", respectively. They are reported beside the ordinary-null result and are not added to or multiplied by it. No Casimir-to-collapse transfer kernel is registered.",
    "",
    "## Fail-closed empirical standing",
    "",
    "Measured specimen spectra, as-built geometry, a full-Maxwell Green tensor, an independent solver check, measured calibration responses, and measured block covariance remain absent. Consequently measured evidence and ordinary-null authority are `not_ready`; residual attribution, collapse identification, and manifold dynamics are `blocked`; physical viability is `not_evaluated`; and neither a physical pilot nor confirmatory campaign is authorized by this synthetic run.",
    "",
  ].join("\n");
}

export async function runCasimirDpMaterialThermalOrdinaryNullStage4_2N(options: {
  runId?: string;
  generatedAt?: string;
  writeArtifacts?: boolean;
} = {}) {
  const configBytes = await readFile(path.resolve(CONFIG_PATH));
  const config = CasimirDpMaterialThermalOrdinaryNullStage4_2NConfig.parse(JSON.parse(configBytes.toString("utf8")));
  const upstreamBytes = await readFile(path.resolve(config.upstream_stage4_2m.verification_receipt_path));
  const upstreamHash = shaBytes(upstreamBytes);
  if (upstreamHash !== config.upstream_stage4_2m.verification_receipt_sha256) {
    throw new Error("stage4_2m_verification_receipt_hash_mismatch");
  }
  const fixtureBytes = await readFile(path.resolve(config.fixture_path));
  const fixtureHash = shaBytes(fixtureBytes);
  if (fixtureHash !== config.fixture_sha256) throw new Error("stage4_2n_fixture_hash_mismatch");
  const fixture = CasimirDpMaterialThermalOrdinaryNullFixtureStage4_2N.parse(JSON.parse(fixtureBytes.toString("utf8")));
  const opticalBytes = await readFile(path.resolve(fixture.optical_response.raw_artifact_path));
  const opticalHash = shaBytes(opticalBytes);
  if (opticalHash !== fixture.optical_response.expected_sha256 || opticalHash !== fixture.optical_response.actual_sha256) {
    throw new Error("stage4_2n_optical_table_hash_mismatch");
  }

  const result = evaluateCasimirDpMaterialThermalOrdinaryNullStage4_2N(config, fixture);
  const runId = options.runId ?? DEFAULT_RUN_ID;
  const generatedAt = options.generatedAt ?? DEFAULT_GENERATED_AT;
  const report = {
    run_id: runId,
    generated_at: generatedAt,
    upstream_integrity: true,
    fixture_integrity: true,
    optical_table_integrity: true,
    ...result,
  };
  const json = JSON.stringify(report, null, 2) + "\n";
  const markdown = reportMarkdown(report);
  const trace = JSON.stringify({
    kind: "casimir-dp-stage4-2n-material-thermal-ordinary-null",
    run_id: runId,
    software_pipeline: report.readiness.software_pipeline,
    measured_evidence: report.readiness.measured_evidence,
    ordinary_null_authority: report.readiness.ordinary_null_authority,
    observable_bridge_edges_added: report.graph_policy.observable_bridge_edges_added,
  }) + "\n";
  const receipt = {
    schema_version: "casimir_dp_material_thermal_ordinary_null_stage4_2n_campaign_receipt/1",
    run_id: runId,
    generated_at: generatedAt,
    config_path: CONFIG_PATH,
    config_sha256: shaBytes(configBytes),
    upstream_verification_receipt_sha256: upstreamHash,
    fixture_sha256: fixtureHash,
    optical_table_sha256: opticalHash,
    report_json_sha256: shaBytes(json),
    report_markdown_sha256: shaBytes(markdown),
    trace_sha256: shaBytes(trace),
    software_pipeline: report.readiness.software_pipeline,
    measured_evidence: report.readiness.measured_evidence,
    ordinary_null_authority: report.readiness.ordinary_null_authority,
    promotion_allowed: false,
    observable_bridge_edges_added: 0,
  };
  if (options.writeArtifacts !== false) {
    const directory = path.resolve("artifacts/research/casimir-dp-material-thermal-ordinary-null-stage4-2n", runId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "material-thermal-ordinary-null-stage4-2n-report.json"), json);
    await writeFile(path.join(directory, "material-thermal-ordinary-null-stage4-2n-report.md"), markdown);
    await writeFile(path.join(directory, "material-thermal-ordinary-null-stage4-2n-trace.jsonl"), trace);
    await writeFile(path.join(directory, "material-thermal-ordinary-null-stage4-2n-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    await writeFile(path.resolve("docs/research/casimir-dp-material-thermal-ordinary-null-stage4-2n-report.md"), markdown);
    await writeFile(path.resolve("docs/research/casimir-dp-material-thermal-ordinary-null-stage4-2n-campaign-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  }
  return { report, receipt, markdown, trace };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  runCasimirDpMaterialThermalOrdinaryNullStage4_2N().then(({ report }) => {
    process.stdout.write(JSON.stringify({
      run_id: report.run_id,
      software_pipeline: report.readiness.software_pipeline,
      measured_evidence: report.readiness.measured_evidence,
      ordinary_null_authority: report.readiness.ordinary_null_authority,
      phase_rad: report.ordinary_qed.mean_interaction.phase_rad,
      echo_chi: report.ordinary_qed.decoherence.echo_chi,
    }, null, 2) + "\n");
  }).catch((error) => {
    process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
    process.exitCode = 1;
  });
}
