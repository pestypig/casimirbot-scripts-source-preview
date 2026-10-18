import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCasimirDpProperTimeWorldlineClosureStage4_2P } from "../../shared/casimir-dp-proper-time-worldline-closure-stage4-2p";
import { CasimirDpProperTimeWorldlineClosureStage4_2PConfig } from "../../shared/contracts/casimir-dp-proper-time-worldline-closure-stage4-2p.v1";

const CONFIG_PATH = "configs/research/casimir-dp-proper-time-worldline-closure-stage4-2p.v1.json";
const DEFAULT_RUN_ID = "casimir-dp-proper-time-worldline-closure-stage4-2p-v1-20260808T120000000Z";
const DEFAULT_GENERATED_AT = "2026-08-08T12:00:00.000Z";
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

function reportMarkdown(report: ReturnType<typeof evaluateCasimirDpProperTimeWorldlineClosureStage4_2P> & {
  run_id: string; generated_at: string; upstream_integrity: boolean;
}) {
  const phase = report.echo_and_covariance;
  return [
    "# Casimir-DP Stage-4.2P proper-time/worldline closure report",
    "",
    `**Run:** \`${report.run_id}\`  `,
    "**Evidence:** synthetic ordinary relativistic phase closure only  ",
    "**Claim ceiling:** ordinary unitary proper-time and phase budget only",
    "",
    "## Result",
    "",
    `The software closure is \`${report.recoveries.software_closure}\`; the transported total phase screen is \`${phase.gate}\`. This is not measured apparatus authority.`,
    "",
    "## Leading horizontal-branch result",
    "",
    `- Nominal Earth potential difference: ${report.weak_field_references.horizontal_nominal_earth_delta_potential_m2_s2} m^2 s^-2.`,
    `- Fully vertical reference fractional rate: ${report.weak_field_references.full_vertical_fractional_rate}.`,
    `- Fully vertical reference proper-time difference: ${report.weak_field_references.full_vertical_delta_proper_time_s} s.`,
    `- Fully vertical reference matter-wave phase: ${report.weak_field_references.full_vertical_phase_rad} rad.`,
    `- Echo-filtered tilt sigma: ${phase.filtered_tilt_sigma_rad} rad.`,
    `- Total ordinary phase sigma: ${phase.total_phase_sigma_rad} rad.`,
    `- Registered limit: ${phase.maximum_phase_sigma_rad} rad; remaining synthetic margin: ${phase.margin_rad} rad.`,
    "",
    "## Phase covariance components",
    "",
    ...Object.entries(phase.component_phase_sigmas_rad).map(([key, value]) => `- ${key}: ${value} rad.`),
    "",
    "## Internal-energy clock bound",
    "",
    `For the declared synthetic internal-energy standard deviation, the small-time bound gives chi=${report.internal_energy_time_dilation.chi} and visibility=${report.internal_energy_time_dilation.visibility}. Measured heat capacity and internal spectrum remain absent, so this is a recovery bound rather than specimen evidence.`,
    "",
    "## Interpretation boundary",
    "",
    "The branch action converts differential proper time into an ordinary signed unitary phase. Echo and path swap may cancel that signed phase; they are not applied to the positive frozen Diósi exponent. Separation by itself is insufficient: equal potentials and equal speeds recover zero differential proper time. No Compton-clock, Casimir-to-collapse, or proper-time-to-collapse transfer law is registered.",
    "",
    "Measured worldlines, gravity-gradient mapping, the as-built local-mass CAD, tilt spectra, echo transfer, clock/control covariance, and internal-energy variance remain `not_ready`. Measured evidence remains `not_ready`; collapse identification and manifold dynamics remain `blocked`; physical viability remains `not_evaluated`; no pilot is authorized.",
    "",
  ].join("\n");
}

export async function runCasimirDpProperTimeWorldlineClosureStage4_2P(options: {
  runId?: string; generatedAt?: string; writeArtifacts?: boolean;
} = {}) {
  const configBytes = await readFile(path.resolve(CONFIG_PATH));
  const config = CasimirDpProperTimeWorldlineClosureStage4_2PConfig.parse(JSON.parse(configBytes.toString("utf8")));
  const upstreamBytes = await readFile(path.resolve(config.upstream_stage4_2o.campaign_receipt_path));
  const upstreamHash = sha(upstreamBytes);
  if (upstreamHash !== config.upstream_stage4_2o.campaign_receipt_sha256) throw new Error("stage4_2p_upstream_stage4_2o_hash_mismatch");
  const result = evaluateCasimirDpProperTimeWorldlineClosureStage4_2P(config);
  const runId = options.runId ?? DEFAULT_RUN_ID;
  const generatedAt = options.generatedAt ?? DEFAULT_GENERATED_AT;
  const report = { run_id: runId, generated_at: generatedAt, upstream_integrity: true, ...result };
  const json = JSON.stringify(report, null, 2) + "\n";
  const markdown = reportMarkdown(report);
  const trace = JSON.stringify({
    kind: "casimir-dp-stage4-2p-proper-time-worldline-closure",
    run_id: runId,
    software_closure: report.recoveries.software_closure,
    phase_gate: report.echo_and_covariance.gate,
    total_phase_sigma_rad: report.echo_and_covariance.total_phase_sigma_rad,
    measured_evidence: report.standing.measured_evidence,
    collapse_identification: report.standing.collapse_identification,
    observable_bridge_edges_added: report.graph_policy.observable_bridge_edges_added,
  }) + "\n";
  const receipt = {
    schema_version: "casimir_dp_proper_time_worldline_closure_stage4_2p_campaign_receipt/1",
    run_id: runId,
    generated_at: generatedAt,
    config_path: CONFIG_PATH,
    config_sha256: sha(configBytes),
    upstream_stage4_2o_campaign_receipt_sha256: upstreamHash,
    report_json_sha256: sha(json),
    report_markdown_sha256: sha(markdown),
    trace_sha256: sha(trace),
    software_closure: report.recoveries.software_closure,
    phase_gate: report.echo_and_covariance.gate,
    measured_evidence: report.standing.measured_evidence,
    collapse_identification: report.standing.collapse_identification,
    promotion_allowed: false,
    frozen_diosi_law_modified: false,
    observable_bridge_edges_added: 0,
  };
  if (options.writeArtifacts !== false) {
    const directory = path.resolve("artifacts/research/casimir-dp-proper-time-worldline-closure-stage4-2p", runId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "proper-time-worldline-closure-stage4-2p-report.json"), json);
    await writeFile(path.join(directory, "proper-time-worldline-closure-stage4-2p-report.md"), markdown);
    await writeFile(path.join(directory, "proper-time-worldline-closure-stage4-2p-trace.jsonl"), trace);
    await writeFile(path.join(directory, "proper-time-worldline-closure-stage4-2p-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    await writeFile(path.resolve("docs/research/casimir-dp-proper-time-worldline-closure-stage4-2p-report.md"), markdown);
    await writeFile(path.resolve("docs/research/casimir-dp-proper-time-worldline-closure-stage4-2p-campaign-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  }
  return { report, receipt, markdown, trace };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  runCasimirDpProperTimeWorldlineClosureStage4_2P().then(({ report }) => {
    process.stdout.write(JSON.stringify({
      run_id: report.run_id,
      software_closure: report.recoveries.software_closure,
      phase_gate: report.echo_and_covariance.gate,
      total_phase_sigma_rad: report.echo_and_covariance.total_phase_sigma_rad,
      phase_margin_rad: report.echo_and_covariance.margin_rad,
      measured_evidence: report.standing.measured_evidence,
      collapse_identification: report.standing.collapse_identification,
    }, null, 2) + "\n");
  }).catch((error) => {
    process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
    process.exitCode = 1;
  });
}
