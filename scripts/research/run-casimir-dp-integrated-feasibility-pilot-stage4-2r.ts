import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCasimirDpIntegratedFeasibilityPilotStage4_2R } from "../../shared/casimir-dp-integrated-feasibility-pilot-stage4-2r";
import { CasimirDpIntegratedFeasibilityPilotStage4_2RConfig } from "../../shared/contracts/casimir-dp-integrated-feasibility-pilot-stage4-2r.v1";

const CONFIG_PATH = "configs/research/casimir-dp-integrated-feasibility-pilot-stage4-2r.v1.json";
const DEFAULT_RUN_ID = "casimir-dp-integrated-feasibility-pilot-stage4-2r-v1-20260808T210000000Z";
const DEFAULT_GENERATED_AT = "2026-08-08T21:00:00.000Z";
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

function reportMarkdown(report: ReturnType<typeof evaluateCasimirDpIntegratedFeasibilityPilotStage4_2R> & {
  run_id: string; generated_at: string; upstream_integrity: boolean;
}) {
  const primary = report.primary_diosi_estimand;
  const audit = report.authority_audit;
  const rows = audit.rows.map((row) =>
    `| ${row.authority_id} | ${row.status} | ${row.content_addressed ? "yes" : "no"} | ${row.ready ? "ready" : "missing"} |`
  );
  return [
    "# Casimir-DP Stage-4.2R integrated feasibility-pilot readiness report",
    "",
    `**Run:** \`${report.run_id}\`  `,
    "**Evidence:** empirical-input readiness contract only  ",
    "**Claim ceiling:** integrated pilot packet and acceptance contract only",
    "",
    "## Decision",
    "",
    `The executable packet contract is \`${report.decision.packet_contract}\`; the empirical feasibility pilot is \`${report.decision.empirical_feasibility_pilot}\`. ${audit.ready_count}/${audit.required_count} same-apparatus authority packets are ready. No absent packet is replaced by a synthetic or cross-apparatus surrogate.`,
    "",
    "## Two estimands that must not be conflated",
    "",
    "The primary collapse comparator is the held-out contraction across mass, separation, and hold time after the frozen ordinary model is applied. For the leading apparatus, the registered Gaussian exponent is " + primary.gaussian_exponent_at_hold + ", giving conditional visibility " + primary.predicted_visibility + " and loss " + primary.predicted_visibility_loss + ". At the registered SNR floor of " + primary.minimum_signal_snr + ", the one-sigma magnitude uncertainty must be no larger than " + primary.maximum_one_sigma_magnitude_uncertainty + ". This remains a model forecast, not measured evidence.",
    "",
    "The boundary interaction estimator is",
    "",
    "<!-- helix-doc-equation-action/v1 id=cdp-stage4-2r-four-cell-cross-ratio -->",
    "$$",
    "R_4=\\frac{C_{\\mathrm{active,sep}}C_{\\mathrm{reference,compact}}}{C_{\\mathrm{active,compact}}C_{\\mathrm{reference,sep}}}.",
    "$$",
    "",
    "A boundary-independent Diósi factor multiplies both separated cells and cancels: its ratio factor is " + report.boundary_interaction_estimand.standard_diosi_ratio_factor + " with numerical cancellation error " + report.boundary_interaction_estimand.standard_diosi_cancellation_error + ". Thus non-unit $R_4$ tests boundary-by-superposition nonfactorization after ordinary calibration; it is not the primary standard-Diósi signal.",
    "",
    "## Quantitative acceptance contract",
    "",
    "<!-- helix-doc-equation-action/v1 id=cdp-stage4-2r-diosi-precision-target -->",
    "$$",
    "V_{\\rm D}=e^{-\\Gamma_{\\rm D}t},\\qquad",
    "\\sigma_{|C|}\\leq\\frac{1-e^{-\\Gamma_{\\rm D}t}}{\\mathrm{SNR}_{\\min}}.",
    "$$",
    "",
    `The registered phase-noise ceiling is ${report.acceptance_contract.maximum_phase_sigma_rad} rad. Relative covariance drift must not exceed ${report.acceptance_contract.maximum_covariance_relative_drift} without an explicitly preregistered uncertainty propagation or redesign. Train/holdout separation, custody, and confirmatory blinding are mandatory. Cross-apparatus covariance fusion remains forbidden.`,
    "",
    "## Required empirical packets",
    "",
    "| authority | status | content addressed | gate |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "The missing packets are: " + audit.missing_authorities.map((id) => `\`${id}\``).join(", ") + ".",
    "",
    "## Scientific standing",
    "",
    "Stage 4.2R closes the specification of what must be measured together, on the leading apparatus, before the pilot may begin. It does not close those measurements. Measured evidence, joint-protocol validation, and ordinary-null authority remain `not_ready`; residual attribution, collapse identification, and manifold dynamics remain `blocked`; physical viability remains `not_evaluated`. The frozen Diósi law is unchanged, no Casimir-to-collapse kernel is registered, and no observable bridge edge is added.",
    "",
  ].join("\n");
}

export async function runCasimirDpIntegratedFeasibilityPilotStage4_2R(options: {
  runId?: string; generatedAt?: string; writeArtifacts?: boolean;
} = {}) {
  const configBytes = await readFile(path.resolve(CONFIG_PATH));
  const config = CasimirDpIntegratedFeasibilityPilotStage4_2RConfig.parse(JSON.parse(configBytes.toString("utf8")));
  const upstreamEntries = [
    [config.upstream.stage4_2o_campaign_receipt_path, config.upstream.stage4_2o_campaign_receipt_sha256],
    [config.upstream.stage4_2p_campaign_receipt_path, config.upstream.stage4_2p_campaign_receipt_sha256],
    [config.upstream.stage4_2q_campaign_receipt_path, config.upstream.stage4_2q_campaign_receipt_sha256],
    [config.upstream.stage4_2q_verification_receipt_path, config.upstream.stage4_2q_verification_receipt_sha256],
  ] as const;
  for (const [receiptPath, expected] of upstreamEntries) {
    const actual = sha(await readFile(path.resolve(receiptPath)));
    if (actual !== expected) throw new Error(`stage4_2r_upstream_hash_mismatch:${receiptPath}`);
  }
  const result = evaluateCasimirDpIntegratedFeasibilityPilotStage4_2R(config);
  const runId = options.runId ?? DEFAULT_RUN_ID;
  const generatedAt = options.generatedAt ?? DEFAULT_GENERATED_AT;
  const report = { run_id: runId, generated_at: generatedAt, upstream_integrity: true, ...result };
  const json = JSON.stringify(report, null, 2) + "\n";
  const markdown = reportMarkdown(report);
  const trace = JSON.stringify({
    kind: "casimir-dp-stage4-2r-integrated-feasibility-pilot-readiness",
    run_id: runId,
    packet_contract: report.decision.packet_contract,
    empirical_feasibility_pilot: report.decision.empirical_feasibility_pilot,
    ready_authorities: report.authority_audit.ready_count,
    missing_authorities: report.authority_audit.missing_authorities,
    measured_evidence: report.standing.measured_evidence,
    collapse_identification: report.standing.collapse_identification,
    collapse_bridge_edges_added: report.graph_policy.collapse_bridge_edges_added,
  }) + "\n";
  const receipt = {
    schema_version: "casimir_dp_integrated_feasibility_pilot_stage4_2r_campaign_receipt/1",
    run_id: runId,
    generated_at: generatedAt,
    config_path: CONFIG_PATH,
    config_sha256: sha(configBytes),
    upstream_stage4_2o_campaign_receipt_sha256: config.upstream.stage4_2o_campaign_receipt_sha256,
    upstream_stage4_2p_campaign_receipt_sha256: config.upstream.stage4_2p_campaign_receipt_sha256,
    upstream_stage4_2q_campaign_receipt_sha256: config.upstream.stage4_2q_campaign_receipt_sha256,
    upstream_stage4_2q_verification_receipt_sha256: config.upstream.stage4_2q_verification_receipt_sha256,
    report_json_sha256: sha(json),
    report_markdown_sha256: sha(markdown),
    trace_sha256: sha(trace),
    packet_contract: report.decision.packet_contract,
    empirical_feasibility_pilot: report.decision.empirical_feasibility_pilot,
    ready_authorities: report.authority_audit.ready_count,
    missing_authorities: report.authority_audit.missing_authorities,
    measured_evidence: report.standing.measured_evidence,
    joint_protocol_validation: report.standing.joint_protocol_validation,
    collapse_identification: report.standing.collapse_identification,
    promotion_allowed: false,
    frozen_diosi_law_modified: false,
    collapse_bridge_edges_added: 0,
  };
  if (options.writeArtifacts !== false) {
    const directory = path.resolve("artifacts/research/casimir-dp-integrated-feasibility-pilot-stage4-2r", runId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "integrated-feasibility-pilot-stage4-2r-report.json"), json);
    await writeFile(path.join(directory, "integrated-feasibility-pilot-stage4-2r-report.md"), markdown);
    await writeFile(path.join(directory, "integrated-feasibility-pilot-stage4-2r-trace.jsonl"), trace);
    await writeFile(path.join(directory, "integrated-feasibility-pilot-stage4-2r-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    await writeFile(path.resolve("docs/research/casimir-dp-integrated-feasibility-pilot-stage4-2r-report.md"), markdown);
    await writeFile(path.resolve("docs/research/casimir-dp-integrated-feasibility-pilot-stage4-2r-campaign-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  }
  return { report, receipt, markdown, trace };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  runCasimirDpIntegratedFeasibilityPilotStage4_2R().then(({ report }) => {
    process.stdout.write(JSON.stringify({
      run_id: report.run_id,
      packet_contract: report.decision.packet_contract,
      empirical_feasibility_pilot: report.decision.empirical_feasibility_pilot,
      ready_authorities: report.authority_audit.ready_count,
      missing_authorities: report.authority_audit.missing_authorities,
      measured_evidence: report.standing.measured_evidence,
    }, null, 2) + "\n");
  }).catch((error) => {
    process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
    process.exitCode = 1;
  });
}

