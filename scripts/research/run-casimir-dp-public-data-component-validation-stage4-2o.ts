import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCasimirDpPublicDataComponentValidationStage4_2O } from "../../shared/casimir-dp-public-data-component-validation-stage4-2o";
import {
  CasimirDpPublicDataComponentFixtureStage4_2O,
  CasimirDpPublicDataComponentValidationStage4_2OConfig,
} from "../../shared/contracts/casimir-dp-public-data-component-validation-stage4-2o.v1";

const CONFIG_PATH = "configs/research/casimir-dp-public-data-component-validation-stage4-2o.v1.json";
const DEFAULT_RUN_ID = "casimir-dp-public-data-component-validation-stage4-2o-v1-20260807T120000000Z";
const DEFAULT_GENERATED_AT = "2026-08-07T12:00:00.000Z";
const shaBytes = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function reportMarkdown(report: ReturnType<typeof evaluateCasimirDpPublicDataComponentValidationStage4_2O> & {
  run_id: string;
  generated_at: string;
  upstream_integrity: boolean;
  fixture_integrity: boolean;
}) {
  const sodium = report.component_replays.sodium_complex_fringe;
  const casimir = report.component_replays.measured_boundary_response;
  const lisa = report.component_replays.multichannel_covariance;
  const gran = report.component_replays.external_dp_bound;
  return [
    "# Casimir-DP Stage-4.2O public-data component-validation report",
    "",
    `**Run:** \`${report.run_id}\`  `,
    "**Evidence:** external public component measurements only  ",
    "**Claim ceiling:** separate public-dataset recovery only",
    "",
    "## Result",
    "",
    `The component replay is \`${report.readiness.component_replay}\`. This means the repository recovered four bounded analysis capabilities from four independent public records. It does **not** mean that a public dataset instantiates the proposed Casimir-Diósi experiment.`,
    "",
    "## Separate component replays",
    "",
    `- **Matter-wave complex fringe:** ${sodium.scan_count} sodium-cluster scans; alternating train/holdout mean Mahalanobis squared ${sodium.split_mean_mahalanobis2}; gate \`${sodium.gate}\`.`,
    `- **Measured boundary response:** ${casimir.trace_count} paired superconducting-drum traces; RMS up/down spectral-centroid shift ${casimir.rms_up_down_centroid_shift_Hz} Hz; gate \`${casimir.gate}\`.`,
    `- **Multichannel covariance:** ${lisa.active_row_count} active LISA Pathfinder rows across ${lisa.channel_count} channels; train/holdout shrunk condition numbers ${lisa.train_shrunk_condition_number} and ${lisa.holdout_shrunk_condition_number}; relative covariance drift ${lisa.relative_covariance_drift}; held-out/train residual-RMSE ratio ${lisa.holdout_to_train_rmse_ratio}; gate \`${lisa.gate}\`.`,
    `- **External Diósi bound:** Gran Sasso figure-source workbooks authenticated (${gran.fig3_bin_count} and ${gran.fig4_bin_count} bins); data/simulation Pearson coefficient ${gran.fig4_data_simulation_pearson}; gate \`${gran.gate}\`. The registered 100 nm comparator remains \`${gran.registered_model_adjudication}\`.`,
    "",
    "## Why these results cannot be fused",
    "",
    "Each dataset comes from a different apparatus, source population, transfer function, noise process, and scientific observable. Stage-4.2O therefore creates no shared likelihood, no cross-apparatus covariance, and no transported residual. The sodium coefficient demonstrates complex fringe reconstruction; it is not the proposed sphere coherence. The drum traces demonstrate a measured nonlinear boundary response; they are not the proposed cavity's ordinary-null calibration. LISA Pathfinder demonstrates held-out classical covariance handling; it is not a quantum measurement. Gran Sasso constrains a model variant; it is not a positive collapse observation.",
    "",
    "## Leading design and empirical standing",
    "",
    `The Stage-4.2N leading design is unchanged: diamond sphere, radius ${report.upstream_binding.leading_design.radius_m} m, mass ${report.upstream_binding.leading_design.mass_kg} kg, separation ${report.upstream_binding.leading_design.branch_separation_m} m, hold ${report.upstream_binding.leading_design.hold_time_s} s, gap ${report.upstream_binding.leading_design.gap_m} m, temperature ${report.upstream_binding.leading_design.temperature_K} K, and pressure ${report.upstream_binding.leading_design.pressure_Pa} Pa.`,
    "",
    "Measured evidence and joint-protocol validation remain `not_ready`; collapse identification and manifold dynamics remain `blocked`; physical viability remains `not_evaluated`. No physical pilot or confirmatory campaign is authorized by these replays.",
    "",
    "## Provenance and graph policy",
    "",
    `- Upstream receipt integrity: ${report.upstream_integrity}.`,
    `- Compact fixture integrity: ${report.fixture_integrity}.`,
    `- Public-source provenance gate: \`${report.provenance.gate}\`.`,
    `- Cross-apparatus isolation gate: \`${report.isolation.gate}\`.`,
    `- Observable bridge edges added: ${report.graph_policy.observable_bridge_edges_added}.`,
    `- Theory Badge promotable: ${report.graph_policy.theory_badge_promotable}.`,
    "",
  ].join("\n");
}

export async function runCasimirDpPublicDataComponentValidationStage4_2O(options: {
  runId?: string;
  generatedAt?: string;
  writeArtifacts?: boolean;
} = {}) {
  const configBytes = await readFile(path.resolve(CONFIG_PATH));
  const config = CasimirDpPublicDataComponentValidationStage4_2OConfig.parse(JSON.parse(configBytes.toString("utf8")));
  const upstreamBytes = await readFile(path.resolve(config.upstream_stage4_2n.campaign_receipt_path));
  const upstreamHash = shaBytes(upstreamBytes);
  if (upstreamHash !== config.upstream_stage4_2n.campaign_receipt_sha256) {
    throw new Error("stage4_2n_campaign_receipt_hash_mismatch");
  }
  const fixtureBytes = await readFile(path.resolve(config.fixture_path));
  const fixtureHash = shaBytes(fixtureBytes);
  if (fixtureHash !== config.fixture_sha256) throw new Error("stage4_2o_fixture_hash_mismatch");
  const fixture = CasimirDpPublicDataComponentFixtureStage4_2O.parse(JSON.parse(fixtureBytes.toString("utf8")));
  const result = evaluateCasimirDpPublicDataComponentValidationStage4_2O(config, fixture);
  const runId = options.runId ?? DEFAULT_RUN_ID;
  const generatedAt = options.generatedAt ?? DEFAULT_GENERATED_AT;
  const report = {
    run_id: runId,
    generated_at: generatedAt,
    upstream_integrity: true,
    fixture_integrity: true,
    ...result,
  };
  const json = JSON.stringify(report, null, 2) + "\n";
  const markdown = reportMarkdown(report);
  const trace = JSON.stringify({
    kind: "casimir-dp-stage4-2o-public-data-component-validation",
    run_id: runId,
    component_replay: report.readiness.component_replay,
    measured_evidence: report.readiness.measured_evidence,
    joint_protocol_validation: report.readiness.joint_protocol_validation,
    collapse_identification: report.readiness.collapse_identification,
    cross_apparatus_covariance_fusion: report.isolation.cross_apparatus_covariance_fusion,
    observable_bridge_edges_added: report.graph_policy.observable_bridge_edges_added,
  }) + "\n";
  const receipt = {
    schema_version: "casimir_dp_public_data_component_validation_stage4_2o_campaign_receipt/1",
    run_id: runId,
    generated_at: generatedAt,
    config_path: CONFIG_PATH,
    config_sha256: shaBytes(configBytes),
    upstream_stage4_2n_campaign_receipt_sha256: upstreamHash,
    fixture_sha256: fixtureHash,
    source_sha256: Object.fromEntries(report.provenance.sources.map((source) => [source.source_id, source.actual_sha256])),
    report_json_sha256: shaBytes(json),
    report_markdown_sha256: shaBytes(markdown),
    trace_sha256: shaBytes(trace),
    component_replay: report.readiness.component_replay,
    measured_evidence: report.readiness.measured_evidence,
    joint_protocol_validation: report.readiness.joint_protocol_validation,
    collapse_identification: report.readiness.collapse_identification,
    promotion_allowed: false,
    cross_apparatus_covariance_fusion: false,
    observable_bridge_edges_added: 0,
  };
  if (options.writeArtifacts !== false) {
    const directory = path.resolve("artifacts/research/casimir-dp-public-data-component-validation-stage4-2o", runId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "public-data-component-validation-stage4-2o-report.json"), json);
    await writeFile(path.join(directory, "public-data-component-validation-stage4-2o-report.md"), markdown);
    await writeFile(path.join(directory, "public-data-component-validation-stage4-2o-trace.jsonl"), trace);
    await writeFile(path.join(directory, "public-data-component-validation-stage4-2o-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    await writeFile(path.resolve("docs/research/casimir-dp-public-data-component-validation-stage4-2o-report.md"), markdown);
    await writeFile(path.resolve("docs/research/casimir-dp-public-data-component-validation-stage4-2o-campaign-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  }
  return { report, receipt, markdown, trace };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  runCasimirDpPublicDataComponentValidationStage4_2O().then(({ report }) => {
    process.stdout.write(JSON.stringify({
      run_id: report.run_id,
      component_replay: report.readiness.component_replay,
      measured_evidence: report.readiness.measured_evidence,
      joint_protocol_validation: report.readiness.joint_protocol_validation,
      collapse_identification: report.readiness.collapse_identification,
      source_provenance: report.provenance.gate,
      cross_apparatus_isolation: report.isolation.gate,
    }, null, 2) + "\n");
  }).catch((error) => {
    process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
    process.exitCode = 1;
  });
}
