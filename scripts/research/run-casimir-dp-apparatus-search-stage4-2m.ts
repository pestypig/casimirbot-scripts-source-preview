import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCasimirDpApparatusSearchStage4_2M } from "../../shared/casimir-dp-apparatus-search-stage4-2m";
import { CasimirDpApparatusSearchStage4_2MConfig } from "../../shared/contracts/casimir-dp-apparatus-search-stage4-2m.v1";

const CONFIG_PATH = "configs/research/casimir-dp-apparatus-search-stage4-2m.v1.json";
const DEFAULT_RUN_ID = "casimir-dp-apparatus-search-stage4-2m-v1-20260806T070000000Z";
const DEFAULT_GENERATED_AT = "2026-08-06T07:00:00.000Z";
const shaBytes = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

function reportMarkdown(report: ReturnType<typeof evaluateCasimirDpApparatusSearchStage4_2M> & {
  run_id: string;
  generated_at: string;
  upstream_integrity: boolean;
}) {
  const best = report.best_candidate;
  const region = report.eligible_region.map((row) => [
    "| ", row.candidate_id, " | ", row.material_id, " | ", String(row.gap_m),
    " | ", String(row.pressure_Pa), " | ",
    String(row.dp.conservative_density_envelope_exponent), " | ",
    String(row.electromagnetic.echoed_phase_sigma_rad), " | ",
    String(row.gas.gas_to_dp_ratio), " | ",
    String(row.identifiability.required_paired_windows), " |",
  ].join("")).join("\n");
  return [
    "# Casimir-DP Stage-4.2M constrained apparatus-search report",
    "",
    "**Run:** " + report.run_id,
    "**Evidence:** synthetic bounded search only",
    "**Claim ceiling:** configuration region for measured subsystem commissioning or explicit no-go",
    "",
    "## Outcome",
    "",
    "- Candidates evaluated: " + report.candidate_count + ".",
    "- Synthetic candidates passing every registered numerical gate: " + report.eligible_synthetic_candidate_count + ".",
    "- Search result: " + report.outcome.synthetic_search + ".",
    "- Measured commissioning standing: " + report.outcome.measured_commissioning + ".",
    "- Physical pilot authorized: " + report.outcome.physical_pilot_authorized + ".",
    "- Confirmatory campaign authorized: " + report.outcome.confirmatory_campaign_authorized + ".",
    "",
    "## Best synthetic candidate",
    "",
    "- Material: " + best.material_id + ".",
    "- Radius: " + best.radius_m + " m; mass: " + best.mass_kg + " kg.",
    "- Separation: " + best.separation_m + " m; hold: " + best.hold_time_s + " s.",
    "- Gap: " + best.gap_m + " m; plate size: " + best.plate_size_m + " m.",
    "- Temperature: " + best.temperature_K + " K; pressure: " + best.pressure_Pa + " Pa.",
    "- Conservative density-envelope DP exponent: " + best.dp.conservative_density_envelope_exponent + ".",
    "- Gaussian DP exponent: " + best.dp.gaussian_exponent + ".",
    "- Echoed phase sigma: " + best.electromagnetic.echoed_phase_sigma_rad + " rad.",
    "- Gas/DP ratio: " + best.gas.gas_to_dp_ratio + ".",
    "- Required paired windows: " + best.identifiability.required_paired_windows + ".",
    "- Forecast power at 1600 windows: " + best.identifiability.forecast_power_at_maximum_windows + ".",
    "- Synthetic companion SNR: " + best.companion.synthetic_snr + ".",
    "- Mass ratio to 170 kDa benchmark: " + best.state_preparation.mass_ratio_to_170kDa + ".",
    "",
    "## Eligible synthetic neighborhood",
    "",
    "| Candidate | Material | Gap (m) | Pressure (Pa) | Conservative DP exponent | Echoed phase sigma (rad) | Gas/DP | Windows |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
    region || "| none | - | - | - | - | - | - | - |",
    "",
    "## Interpretation",
    "",
    "This result solves only the bounded synthetic search. The electromagnetic Jacobian is a transported Stage-4.2L surrogate, the gas rate is a scaled QLBE proxy, the density envelope uses the registered Stage-4.2L factor, and Stage-4.2C signature geometry is transported rather than remeasured. The selected diamond neighborhood therefore defines targets for subsystem commissioning; it is not an as-built apparatus solution.",
    "",
    "Measured material spectra, as-built geometry, a full Maxwell Green tensor, measured covariance, measured gas scattering, integrated state preparation, a measured companion detector, and independent replication remain absent. Measured evidence is not_ready; residual attribution, collapse identification, and manifold dynamics remain blocked; physical viability remains not_evaluated; and no Casimir-to-collapse transfer kernel is registered.",
    "",
  ].join("\n");
}

export async function runCasimirDpApparatusSearchStage4_2M(options: {
  runId?: string;
  generatedAt?: string;
  writeArtifacts?: boolean;
} = {}) {
  const configBytes = await readFile(path.resolve(CONFIG_PATH));
  const config = CasimirDpApparatusSearchStage4_2MConfig.parse(JSON.parse(configBytes.toString("utf8")));
  const upstreamBytes = await readFile(path.resolve(config.upstream_stage4_2l.verification_receipt_path));
  const upstreamHash = shaBytes(upstreamBytes);
  if (upstreamHash !== config.upstream_stage4_2l.verification_receipt_sha256) {
    throw new Error("stage4_2l_verification_receipt_hash_mismatch");
  }
  const result = evaluateCasimirDpApparatusSearchStage4_2M(config);
  const runId = options.runId ?? DEFAULT_RUN_ID;
  const generatedAt = options.generatedAt ?? DEFAULT_GENERATED_AT;
  const report = {
    campaign_id: config.campaign_id,
    run_id: runId,
    generated_at: generatedAt,
    evidence_class: config.evidence_class,
    claim_ceiling: config.claim_ceiling,
    promotion_allowed: false,
    upstream_integrity: true,
    upstream_stage4_2l: config.upstream_stage4_2l,
    ...result,
  };
  const json = JSON.stringify(report, null, 2) + "\n";
  const markdown = reportMarkdown(report);
  const trace = JSON.stringify({
    kind: "casimir-dp-stage4-2m-search",
    run_id: runId,
    candidate_count: result.candidate_count,
    eligible_count: result.eligible_synthetic_candidate_count,
    outcome: result.outcome.synthetic_search,
    measured_evidence: result.outcome.measured_evidence,
  }) + "\n";
  const receipt = {
    schema_version: "casimir_dp_apparatus_search_stage4_2m_campaign_receipt/1",
    run_id: runId,
    config_path: CONFIG_PATH,
    config_sha256: shaBytes(configBytes),
    upstream_verification_receipt_sha256: upstreamHash,
    report_json_sha256: shaBytes(json),
    report_markdown_sha256: shaBytes(markdown),
    trace_sha256: shaBytes(trace),
    candidate_count: result.candidate_count,
    eligible_synthetic_candidate_count: result.eligible_synthetic_candidate_count,
    promotion_allowed: false,
    measured_evidence: "not_ready",
    observable_bridge_edges_added: 0,
  };
  if (options.writeArtifacts !== false) {
    const directory = path.resolve("artifacts/research/casimir-dp-apparatus-search-stage4-2m", runId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "apparatus-search-stage4-2m-report.json"), json);
    await writeFile(path.join(directory, "apparatus-search-stage4-2m-report.md"), markdown);
    await writeFile(path.join(directory, "apparatus-search-stage4-2m-trace.jsonl"), trace);
    await writeFile(path.join(directory, "apparatus-search-stage4-2m-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    await writeFile(path.resolve("docs/research/casimir-dp-apparatus-search-stage4-2m-report.md"), markdown);
  }
  return { report, receipt, markdown, trace };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  runCasimirDpApparatusSearchStage4_2M().then(({ report }) => {
    process.stdout.write(JSON.stringify({
      run_id: report.run_id,
      candidate_count: report.candidate_count,
      eligible_synthetic_candidate_count: report.eligible_synthetic_candidate_count,
      outcome: report.outcome,
    }, null, 2) + "\n");
  }).catch((error) => {
    process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
    process.exitCode = 1;
  });
}
