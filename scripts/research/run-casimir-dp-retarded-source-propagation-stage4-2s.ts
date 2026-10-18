import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCasimirDpRetardedSourcePropagationStage4_2S } from "../../shared/casimir-dp-retarded-source-propagation-stage4-2s";
import { CasimirDpRetardedSourcePropagationStage4_2SConfig } from "../../shared/contracts/casimir-dp-retarded-source-propagation-stage4-2s.v1";

const CONFIG_PATH = "configs/research/casimir-dp-retarded-source-propagation-stage4-2s.v1.json";
const DEFAULT_RUN_ID = "casimir-dp-retarded-source-propagation-stage4-2s-v1-20260810T180000000Z";
const DEFAULT_GENERATED_AT = "2026-08-10T18:00:00.000Z";
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

function reportMarkdown(report: ReturnType<typeof evaluateCasimirDpRetardedSourcePropagationStage4_2S> & {
  run_id: string; generated_at: string; upstream_integrity: boolean;
}) {
  const recovery = report.retarded_radiation_recovery;
  const scaleRows = report.source_scale_classification.rows.map((row) =>
    `| ${row.source_id} | ${row.evidence_class} | ${row.frequency_Hz} | ${row.kL} | ${row.propagation_regime} |`,
  );
  const authorityRows = report.authority_audit.rows.map((row) =>
    `| ${row.authority_id} | ${row.status} | ${row.content_addressed ? "yes" : "no"} | ${row.ready ? "ready" : "missing"} |`,
  );
  return [
    "# Casimir-DP Stage-4.2S retarded-source propagation report",
    "",
    `**Run:** \`${report.run_id}\`  `,
    "**Evidence:** analytic and synthetic ordinary-electromagnetic recovery only  ",
    "**Claim ceiling:** retarded-source ordinary-null contract and software recovery only",
    "",
    "## Result",
    "",
    `The software contract is \`${report.decision.software_contract}\`; ordinary-null integration is \`${report.decision.ordinary_null_integration}\`. The analytic radiation, causality, transversality, current-conservation, energy-flux, distance-scaling, and polarization recoveries pass. All ${report.authority_audit.required_count} same-apparatus empirical authorities remain absent, so no physical pilot or residual attribution is authorized.`,
    "",
    "## Retarded propagation recovery",
    "",
    "<!-- helix-doc-equation-action/v1 id=cdp-stage4-2s-retarded-radiation-field -->",
    "$$",
    "\\mathbf E_{\\rm rad}(\\mathbf r,t)=\\frac{q}{4\\pi\\epsilon_0c^2R}\\,\\hat{\\mathbf n}\\times[\\hat{\\mathbf n}\\times\\mathbf a(t-R/c)].",
    "$$",
    "",
    `The benchmark field amplitude is ${recovery.field_amplitude_V_m} V/m, its retarded delay is ${recovery.retarded_delay_s} s, and doubling distance halves the amplitude. Numerical angular integration recovers the Larmor power with relative error ${recovery.larmor_relative_error}. The transverse-field error is ${recovery.transversality_error}, current-conservation residual is ${recovery.current_conservation_residual}, and circular-basis projector error is ${recovery.circular_polarization_projector_error}.`,
    "",
    "## Propagation-scale audit",
    "",
    "<!-- helix-doc-equation-action/v1 id=cdp-stage4-2s-propagation-scale -->",
    "$$",
    "kL=\\frac{2\\pi fL}{c}.",
    "$$",
    "",
    "| source | evidence class | frequency (Hz) | kL | regime |",
    "| --- | --- | ---: | ---: | --- |",
    ...scaleRows,
    "",
    `The frozen 0.5-Hz boundary label gives kL=${report.source_scale_classification.boundary_fundamental_kL}; the 1550-nm synthetic optical benchmark gives kL=${report.source_scale_classification.optical_benchmark_kL}. The former is deeply quasistatic by geometric retardation alone, while the latter requires wave propagation. Neither classifies unmeasured switching edges, material relaxation, or transfer functions.`,
    "",
    "## Ordinary response in complex-coherence space",
    "",
    "<!-- helix-doc-equation-action/v1 id=cdp-stage4-2s-green-to-coherence -->",
    "$$",
    "E_i(\\mathbf r,\\omega)=i\\mu_0\\omega\\int d^3r'\\,G^{\\rm ret}_{ij}(\\mathbf r,\\mathbf r',\\omega)J_j(\\mathbf r',\\omega),\\qquad C_0=C(0)e^{i\\Phi_{\\rm EM}-\\chi_{\\rm EM}}.",
    "$$",
    "",
    `The synthetic branch fixture produces ordinary nuisance vector (log magnitude, phase)=(${report.synthetic_branch_green_recovery.complex_coherence_nuisance_vector.log_magnitude}, ${report.synthetic_branch_green_recovery.complex_coherence_nuisance_vector.phase_rad}), absorbed power ${report.synthetic_branch_green_recovery.absorbed_power_W} W, and recoil momentum diffusion ${report.synthetic_branch_green_recovery.recoil_momentum_diffusion_kg2_m2_s3} kg^2 m^2 s^-3. These numbers verify algebra only; they are not apparatus forecasts.`,
    "",
    "## Missing same-apparatus authorities",
    "",
    "| authority | status | content addressed | gate |",
    "| --- | --- | --- | --- |",
    ...authorityRows,
    "",
    "## Claim boundary",
    "",
    "This campaign strengthens the ordinary electromagnetic null by requiring every time-dependent source to propagate causally into phase, contraction, recoil, heating, and covariance. It does not derive radiation from field-line pictures, modify the frozen Diósi generator, register a Casimir-to-collapse kernel, identify collapse, or establish manifold dynamics. Measured evidence and the retarded-source covariance remain `not_ready`; residual attribution and collapse identification remain `blocked`; physical viability remains `not_evaluated`.",
    "",
  ].join("\n");
}

export async function runCasimirDpRetardedSourcePropagationStage4_2S(options: {
  runId?: string; generatedAt?: string; writeArtifacts?: boolean;
} = {}) {
  const configBytes = await readFile(path.resolve(CONFIG_PATH));
  const config = CasimirDpRetardedSourcePropagationStage4_2SConfig.parse(JSON.parse(configBytes.toString("utf8")));
  for (const [receiptPath, expected] of [
    [config.upstream.stage4_2r_campaign_receipt_path, config.upstream.stage4_2r_campaign_receipt_sha256],
    [config.upstream.stage4_2r_verification_receipt_path, config.upstream.stage4_2r_verification_receipt_sha256],
  ] as const) {
    const actual = sha(await readFile(path.resolve(receiptPath)));
    if (actual !== expected) throw new Error(`stage4_2s_upstream_hash_mismatch:${receiptPath}`);
  }
  const result = evaluateCasimirDpRetardedSourcePropagationStage4_2S(config);
  const runId = options.runId ?? DEFAULT_RUN_ID;
  const generatedAt = options.generatedAt ?? DEFAULT_GENERATED_AT;
  const report = { run_id: runId, generated_at: generatedAt, upstream_integrity: true, ...result };
  const json = JSON.stringify(report, null, 2) + "\n";
  const markdown = reportMarkdown(report);
  const trace = JSON.stringify({
    kind: "casimir-dp-stage4-2s-retarded-source-propagation",
    run_id: runId,
    software_contract: report.decision.software_contract,
    ordinary_null_integration: report.decision.ordinary_null_integration,
    analytic_recovery: report.retarded_radiation_recovery.gate,
    ready_authorities: report.authority_audit.ready_count,
    measured_evidence: report.standing.measured_evidence,
    collapse_bridge_edges_added: report.hypothesis_separation.collapse_bridge_edges_added,
  }) + "\n";
  const receipt = {
    schema_version: "casimir_dp_retarded_source_propagation_stage4_2s_campaign_receipt/1",
    run_id: runId,
    generated_at: generatedAt,
    config_path: CONFIG_PATH,
    config_sha256: sha(configBytes),
    upstream_stage4_2r_campaign_receipt_sha256: config.upstream.stage4_2r_campaign_receipt_sha256,
    upstream_stage4_2r_verification_receipt_sha256: config.upstream.stage4_2r_verification_receipt_sha256,
    report_json_sha256: sha(json),
    report_markdown_sha256: sha(markdown),
    trace_sha256: sha(trace),
    software_contract: report.decision.software_contract,
    ordinary_null_integration: report.decision.ordinary_null_integration,
    analytic_recovery: report.retarded_radiation_recovery.gate,
    ready_authorities: report.authority_audit.ready_count,
    missing_authorities: report.authority_audit.missing_authorities,
    measured_evidence: report.standing.measured_evidence,
    collapse_identification: report.standing.collapse_identification,
    promotion_allowed: false,
    frozen_diosi_law_modified: false,
    collapse_bridge_edges_added: 0,
  };
  if (options.writeArtifacts !== false) {
    const directory = path.resolve("artifacts/research/casimir-dp-retarded-source-propagation-stage4-2s", runId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "retarded-source-propagation-stage4-2s-report.json"), json);
    await writeFile(path.join(directory, "retarded-source-propagation-stage4-2s-report.md"), markdown);
    await writeFile(path.join(directory, "retarded-source-propagation-stage4-2s-trace.jsonl"), trace);
    await writeFile(path.join(directory, "retarded-source-propagation-stage4-2s-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    await writeFile(path.resolve("docs/research/casimir-dp-retarded-source-propagation-stage4-2s-report.md"), markdown);
    await writeFile(path.resolve("docs/research/casimir-dp-retarded-source-propagation-stage4-2s-campaign-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  }
  return { report, receipt, markdown, trace };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  runCasimirDpRetardedSourcePropagationStage4_2S().then(({ report }) => {
    process.stdout.write(JSON.stringify({
      run_id: report.run_id,
      software_contract: report.decision.software_contract,
      analytic_recovery: report.retarded_radiation_recovery.gate,
      boundary_fundamental_kL: report.source_scale_classification.boundary_fundamental_kL,
      optical_benchmark_kL: report.source_scale_classification.optical_benchmark_kL,
      ordinary_null_integration: report.decision.ordinary_null_integration,
      ready_authorities: report.authority_audit.ready_count,
    }, null, 2) + "\n");
  }).catch((error) => {
    process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
    process.exitCode = 1;
  });
}
