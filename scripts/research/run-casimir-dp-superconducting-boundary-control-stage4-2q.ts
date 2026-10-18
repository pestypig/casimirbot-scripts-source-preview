import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCasimirDpSuperconductingBoundaryControlStage4_2Q } from "../../shared/casimir-dp-superconducting-boundary-control-stage4-2q";
import {
  CasimirDpSuperconductingBoundaryControlStage4_2QConfig,
  CasimirDpSuperconductingBoundaryFixtureStage4_2Q,
} from "../../shared/contracts/casimir-dp-superconducting-boundary-control-stage4-2q.v1";

const CONFIG_PATH = "configs/research/casimir-dp-superconducting-boundary-control-stage4-2q.v1.json";
const DEFAULT_RUN_ID = "casimir-dp-superconducting-boundary-control-stage4-2q-v1-20260808T180000000Z";
const DEFAULT_GENERATED_AT = "2026-08-08T18:00:00.000Z";
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

function reportMarkdown(report: ReturnType<typeof evaluateCasimirDpSuperconductingBoundaryControlStage4_2Q> & {
  run_id: string; generated_at: string; upstream_integrity: boolean; fixture_integrity: boolean;
}) {
  const gauge = report.gauge_condensate_recovery;
  const screen = report.condensation_energy_screen;
  const rows = report.strategy_assessment.strategies.map((row) =>
    "| " + row.strategy_id + " | " + row.boundary_contrast_snr + " | " + row.maximum_signature_cosine + " | " + row.augmented_condition_number + " | " + row.gate + " |"
  );
  return [
    "# Casimir-DP Stage-4.2Q superconducting-boundary control report",
    "",
    "**Run:** `" + report.run_id + "`  ",
    "**Evidence:** synthetic superconducting control-identifiability only  ",
    "**Claim ceiling:** ordinary superconducting-boundary control design only",
    "",
    "## Result",
    "",
    "Software recovery is `" + report.recoveries.software_pipeline + "`. The bounded synthetic strategy result is `" + report.strategy_assessment.synthetic_control_value + "`; selected synthetic strategy: `" + (report.strategy_assessment.selected_synthetic_strategy ?? "none") + "`. Physical control authority remains `" + report.strategy_assessment.physical_control_authority + "`.",
    "",
    "## Gauge/condensate recovery",
    "",
    "- London depth recovered: " + gauge.london_penetration_depth_calculated_m + " m (relative error " + gauge.london_relative_error + ").",
    "- In-medium photon mass scale: " + gauge.effective_in_medium_photon_mass_scale_kg + " kg.",
    "- DC resistance: " + gauge.zero_dc_resistance_ohm + " ohm; finite-frequency impedance remains nonzero: " + gauge.finite_frequency_impedance_nonzero + ".",
    "- Frozen synthetic impedance-to-Green transfer recovery: " + report.synthetic_green_transfer.gate + " (maximum absolute phase/chi error " + report.synthetic_green_transfer.maximum_absolute_error + ").",
    "",
    "This is the Anderson-Higgs/Meissner in-medium electromagnetic response. The registered linearized Green transfer is synthetic and not an as-built Maxwell solution. It is not the Standard-Model Higgs field and does not alter the registered Diosi generator.",
    "",
    "## Boundary ratio and frozen Diosi cancellation",
    "",
    "Maximum numerical Diosi cancellation error in C_SC/C_N: " + report.frozen_diosi_cancellation.maximum_error + "; gate `" + report.frozen_diosi_cancellation.gate + "`. The ratio diagnoses boundary state rather than the primary boundary-independent Diosi signal.",
    "",
    "## Toggle-strategy assessment",
    "",
    "| strategy | contrast SNR | max nuisance cosine | condition | synthetic gate |",
    "| --- | ---: | ---: | ---: | --- |",
    ...rows,
    "",
    "Temperature crossing is rejected when thermal response is collinear with the desired contrast. The matched pair is too weak and fabrication-sensitive in this fixture. The magnetic toggle is only a synthetic candidate: field pickup, trap transfer, vortices, and sham covariance require measurement.",
    "",
    "## Condensation-energy stress-energy screen",
    "",
    "For the hypothetical coating, B_c^2 V/(2 mu_0) gives " + screen.energy_J + " J and mass equivalent " + screen.mass_equivalent_kg + " kg, or " + screen.mass_equivalent_to_probe_mass_ratio + " of the sphere mass. This is an ordinary upper bound, not a collapse source.",
    "",
    "## Bridge and non-bridge result",
    "",
    "The runnable ordinary bridge is superconducting state -> measured finite-frequency impedance -> electromagnetic Green tensor -> phase/loss covariance -> complex coherence. Standard-Model Higgs -> Diosi, superconducting condensate -> Diosi, and BEC order parameter -> Diosi remain non-bridges. A BEC is a conditional replication platform only after a many-body mass-density contract is registered.",
    "",
    "Measured specimen impedance, normal/superconducting Casimir contrast, as-built Green response, transition covariance, magnetic transfer, vortex state, and joint coherence cells remain absent. Measured evidence and ordinary-null authority remain `not_ready`; residual attribution, collapse identification, and manifold dynamics remain `blocked`; physical viability remains `not_evaluated`; no pilot or confirmatory campaign is authorized.",
    "",
  ].join("\n");
}

export async function runCasimirDpSuperconductingBoundaryControlStage4_2Q(options: {
  runId?: string; generatedAt?: string; writeArtifacts?: boolean;
} = {}) {
  const configBytes = await readFile(path.resolve(CONFIG_PATH));
  const config = CasimirDpSuperconductingBoundaryControlStage4_2QConfig.parse(JSON.parse(configBytes.toString("utf8")));
  const fixtureBytes = await readFile(path.resolve(config.fixture_path));
  const fixtureHash = sha(fixtureBytes);
  if (fixtureHash !== config.fixture_sha256) throw new Error("stage4_2q_fixture_hash_mismatch");
  const fixture = CasimirDpSuperconductingBoundaryFixtureStage4_2Q.parse(JSON.parse(fixtureBytes.toString("utf8")));
  const upstreamEntries = [
    [config.upstream.stage4_2p_campaign_receipt_path, config.upstream.stage4_2p_campaign_receipt_sha256],
    [config.upstream.stage4_2o_verification_receipt_path, config.upstream.stage4_2o_verification_receipt_sha256],
    [config.upstream.stage4_2n_verification_receipt_path, config.upstream.stage4_2n_verification_receipt_sha256],
  ] as const;
  for (const [receiptPath, expected] of upstreamEntries) {
    const actual = sha(await readFile(path.resolve(receiptPath)));
    if (actual !== expected) throw new Error(`stage4_2q_upstream_hash_mismatch:${receiptPath}`);
  }
  const result = evaluateCasimirDpSuperconductingBoundaryControlStage4_2Q(config, fixture);
  const runId = options.runId ?? DEFAULT_RUN_ID;
  const generatedAt = options.generatedAt ?? DEFAULT_GENERATED_AT;
  const report = { run_id: runId, generated_at: generatedAt, upstream_integrity: true, fixture_integrity: true, ...result };
  const json = JSON.stringify(report, null, 2) + "\n";
  const markdown = reportMarkdown(report);
  const trace = JSON.stringify({
    kind: "casimir-dp-stage4-2q-superconducting-boundary-control",
    run_id: runId,
    software_pipeline: report.recoveries.software_pipeline,
    selected_synthetic_strategy: report.strategy_assessment.selected_synthetic_strategy,
    dp_cancellation_gate: report.frozen_diosi_cancellation.gate,
    measured_evidence: report.standing.measured_evidence,
    collapse_identification: report.standing.collapse_identification,
    collapse_bridge_edges_added: report.graph_policy.collapse_bridge_edges_added,
  }) + "\n";
  const receipt = {
    schema_version: "casimir_dp_superconducting_boundary_control_stage4_2q_campaign_receipt/1",
    run_id: runId,
    generated_at: generatedAt,
    config_path: CONFIG_PATH,
    config_sha256: sha(configBytes),
    fixture_sha256: fixtureHash,
    upstream_stage4_2p_campaign_receipt_sha256: config.upstream.stage4_2p_campaign_receipt_sha256,
    upstream_stage4_2o_verification_receipt_sha256: config.upstream.stage4_2o_verification_receipt_sha256,
    upstream_stage4_2n_verification_receipt_sha256: config.upstream.stage4_2n_verification_receipt_sha256,
    report_json_sha256: sha(json),
    report_markdown_sha256: sha(markdown),
    trace_sha256: sha(trace),
    software_pipeline: report.recoveries.software_pipeline,
    synthetic_control_value: report.strategy_assessment.synthetic_control_value,
    selected_synthetic_strategy: report.strategy_assessment.selected_synthetic_strategy,
    dp_cancellation_gate: report.frozen_diosi_cancellation.gate,
    measured_evidence: report.standing.measured_evidence,
    ordinary_null_authority: report.standing.ordinary_null_authority,
    collapse_identification: report.standing.collapse_identification,
    promotion_allowed: false,
    frozen_diosi_law_modified: false,
    collapse_bridge_edges_added: 0,
  };
  if (options.writeArtifacts !== false) {
    const directory = path.resolve("artifacts/research/casimir-dp-superconducting-boundary-control-stage4-2q", runId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "superconducting-boundary-control-stage4-2q-report.json"), json);
    await writeFile(path.join(directory, "superconducting-boundary-control-stage4-2q-report.md"), markdown);
    await writeFile(path.join(directory, "superconducting-boundary-control-stage4-2q-trace.jsonl"), trace);
    await writeFile(path.join(directory, "superconducting-boundary-control-stage4-2q-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    await writeFile(path.resolve("docs/research/casimir-dp-superconducting-boundary-control-stage4-2q-report.md"), markdown);
    await writeFile(path.resolve("docs/research/casimir-dp-superconducting-boundary-control-stage4-2q-campaign-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  }
  return { report, receipt, markdown, trace };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  runCasimirDpSuperconductingBoundaryControlStage4_2Q().then(({ report }) => {
    process.stdout.write(JSON.stringify({
      run_id: report.run_id,
      software_pipeline: report.recoveries.software_pipeline,
      synthetic_control_value: report.strategy_assessment.synthetic_control_value,
      selected_synthetic_strategy: report.strategy_assessment.selected_synthetic_strategy,
      dp_cancellation_gate: report.frozen_diosi_cancellation.gate,
      measured_evidence: report.standing.measured_evidence,
      collapse_identification: report.standing.collapse_identification,
    }, null, 2) + "\n");
  }).catch((error) => {
    process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
    process.exitCode = 1;
  });
}
