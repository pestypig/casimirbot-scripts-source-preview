import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCasimirDpEmpiricalAuthorityStage4_2L } from "../../shared/casimir-dp-empirical-authority-stage4-2l";
import {
  CasimirDpApparatusDesignManifestStage4_2L,
  CasimirDpEmpiricalAuthorityFixtureStage4_2L,
  CasimirDpEmpiricalAuthorityStage4_2LConfig,
} from "../../shared/contracts/casimir-dp-empirical-authority-stage4-2l.v1";

const DEFAULT_CONFIG = "configs/research/casimir-dp-empirical-authority-stage4-2l.v1.json";
const DEFAULT_OUTPUT = "artifacts/research/casimir-dp-empirical-authority-stage4-2l";
type Options = { rootDir?: string; configPath?: string; outputRoot?: string; reportDocPath?: string; runId?: string; generatedAt?: string; writeArtifacts?: boolean };
const hashText = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const hashFile = (root: string, relative: string) => createHash("sha256").update(readFileSync(path.resolve(root, relative))).digest("hex");
const readJson = (root: string, relative: string) => JSON.parse(readFileSync(path.resolve(root, relative), "utf8"));
const timestampId = (iso: string) => iso.replace(/[-:.]/g, "");

function render(report: any): string {
  const n = report.nominal_result;
  return `# Casimir-DP Stage-4.2L empirical-authority closure report

**Run:** \`${report.campaign_run_id}\`  
**Evidence:** synthetic and literature-bound diagnostic only  
**Claim ceiling:** apparatus redesign and empirical acquisition requirements only

## Result

The software diagnostic passes, but the frozen reference apparatus requires redesign before an empirical pilot. The 3D coordinate frame and tangential branch are now explicit; they are an engineering design authority, not as-built metrology. The finite rectangular-plate calculation is a solid-angle-weighted retarded Casimir-Polder surrogate and not a full Maxwell Green tensor.

## Geometry and phase screen

- Branch vector: \`${JSON.stringify(n.apparatus_manifest.branch_vector_m)} m\`.
- Plate normal: \`${JSON.stringify(n.apparatus_manifest.plate_normal)}\`.
- Nominal analytic finite-surrogate phase: \`${n.finite_geometry.nominal_analytic.phase_rad} rad\`.
- Primary/secondary energy cross-check relative error: \`${n.finite_geometry.energy_crosscheck_relative_error}\`.
- Synthetic covariance phase sigma: \`${n.phase_covariance.predicted_sigma_phi_rad} rad\`.
- Registered maximum phase sigma: \`${n.phase_covariance.maximum_sigma_phi_rad} rad\`.
- Lateral one-sigma requirement: \`${n.phase_covariance.required_one_sigma_controls.lateral_centering_m} m\`.
- Branch-angle one-sigma requirement: \`${n.phase_covariance.required_one_sigma_controls.branch_tilt_rad} rad\`.
- Design gate: \`${n.phase_covariance.synthetic_design_gate}\`.

The zero nominal phase follows the centered tangential symmetry. It does not survive the stated design jitter. This is a redesign screen, not evidence that a real apparatus has zero phase or that the calculated tolerances have been achieved.

## Material authority

The ingestion schema is frozen as \`${n.material_response.ingestion_schema}\`, but the specimen row count is \`${n.material_response.specimen_measured_row_count}\`. The room-temperature literature proxy differs from the proposed apparatus temperature by \`${n.material_response.temperature_mismatch_K} K\`; specimen-specific cryogenic authority remains \`${n.material_response.measured_authority}\`.

## Quantum-linear-Boltzmann screen

- Proxy gas decoherence rate: \`${n.qlbe.total_decoherence_rate_s} s^-1\`.
- Proxy gas/DP ratio: \`${n.qlbe.qlbe_to_dp_rate_ratio}\`.
- Pressure for one tenth of the registered DP rate: \`${n.qlbe.pressure_for_target_fraction_of_dp_Pa} Pa\`.
- Proxy gate: \`${n.qlbe.proxy_gate}\`.
- Measured QLBE authority: \`${n.qlbe.measured_authority}\`.

The QLBE structure is now executable, but the isotropic total-cross-section proxy does not replace species-resolved differential-scattering measurements or confinement corrections.

## State preparation and external bound

The reference object is \`${n.state_preparation.mass_ratio}\` times more massive and \`${n.state_preparation.diameter_ratio}\` times larger in diameter than the 2026 170 kDa matter-wave benchmark, although its 160 nm separation is only \`${n.state_preparation.separation_ratio}\` times the demonstrated 133 nm separation. The material and platform differ, so integrated state preparation remains \`${n.state_preparation.empirical_sequence}\`.

The frozen \`R0 = ${n.external_bound.registered_R0_m} m\` point is \`${n.external_bound.ratio_to_90CL_lower_bound}\` times above the XENONnT 90% CL scalar lower bound and is not excluded by that scalar screen. This is not a full likelihood or composite-normalization recast.

## Mass-density sensitivity

At the registered cutoff, the four computed representations span \`${n.mass_density_robustness.minimum_E_G_J} J\` to \`${n.mass_density_robustness.maximum_E_G_J} J\`, a factor of \`${n.mass_density_robustness.maximum_to_minimum_ratio}\`. Internal-density and coating metrology remain absent, so this is a sensitivity envelope rather than complete mass-density authority.

## Standing

${Object.entries(report.final_gates).map(([key, value]) => `- \`${key}\`: \`${value}\`.`).join("\n")}
`;
}

export async function runCasimirDpEmpiricalAuthorityStage4_2L(options: Options = {}) {
  const root = path.resolve(options.rootDir ?? process.cwd());
  const configPath = options.configPath ?? DEFAULT_CONFIG;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const runId = options.runId ?? `casimir-dp-empirical-authority-stage4-2l-v1-${timestampId(generatedAt)}`;
  const config = CasimirDpEmpiricalAuthorityStage4_2LConfig.parse(readJson(root, configPath));
  const authorityHash = hashFile(root, config.authority_manifest.path);
  if (authorityHash !== config.authority_manifest.sha256) throw new Error(`stage4_2l_authority_manifest_hash_mismatch:${authorityHash}`);
  const authorities = readJson(root, config.authority_manifest.path);
  if (JSON.stringify(authorities.immutable_upstream) !== JSON.stringify(config.upstream_authorities) || JSON.stringify(authorities.method_authorities) !== JSON.stringify(config.method_authorities)) throw new Error("stage4_2l_authority_tuple_mismatch");
  const authorityRows = [...config.upstream_authorities, ...config.method_authorities].map((row) => {
    const actual = hashFile(root, row.path);
    if (actual !== row.sha256) throw new Error(`stage4_2l_authority_hash_mismatch:${row.role}:${actual}`);
    return { ...row, actual_sha256: actual, gate: "pass" as const };
  });
  const stageK = readJson(root, config.upstream_authorities.find((row) => row.role === "stage4_2k_report")!.path);
  if (stageK.final_gates?.measured_evidence !== "not_ready" || stageK.final_gates?.collapse_identification !== "blocked") throw new Error("stage4_2l_upstream_standing_not_recovered");
  const apparatusHash = hashFile(root, config.apparatus_manifest.path);
  if (apparatusHash !== config.apparatus_manifest.sha256) throw new Error(`stage4_2l_apparatus_manifest_hash_mismatch:${apparatusHash}`);
  const fixtureHash = hashFile(root, config.fixture.path);
  if (fixtureHash !== config.fixture.sha256) throw new Error(`stage4_2l_fixture_hash_mismatch:${fixtureHash}`);
  const apparatus = CasimirDpApparatusDesignManifestStage4_2L.parse(readJson(root, config.apparatus_manifest.path));
  const fixture = CasimirDpEmpiricalAuthorityFixtureStage4_2L.parse(readJson(root, config.fixture.path));
  const nominal = evaluateCasimirDpEmpiricalAuthorityStage4_2L({ config, fixture, apparatus });
  if (nominal.outcome.diagnostic_gate !== "pass" || nominal.outcome.residual_attribution !== "blocked" || nominal.hypothesis_separation.observable_bridge_edges_added !== 0) throw new Error("stage4_2l_fail_closed_recovery_failed");
  const report = {
    schema_version: "casimir_dp_empirical_authority_stage4_2l_report/1",
    study_id: config.study_id, campaign_id: config.campaign_id, campaign_run_id: runId,
    generated_at: generatedAt, evidence_cutoff: config.evidence_cutoff,
    evidence_class: config.evidence_class, claim_ceiling: config.claim_ceiling,
    promotion_allowed: false, observable_bridge_edges_added: 0,
    campaign_gate: "pass" as const, integrity_gate: "pass" as const,
    immutable_stage4_2k: { campaign_run_id: stageK.campaign_run_id, recovered: true },
    authority_integrity: { gate: "pass" as const, manifest_sha256: authorityHash, rows: authorityRows },
    apparatus_manifest_integrity: { gate: "pass" as const, path: config.apparatus_manifest.path, sha256: apparatusHash, authority_class: apparatus.authority_class },
    nominal_result: nominal,
    run_order: config.run_order.map((stage, index) => ({ index: index + 1, stage, gate: "pass" as const })),
    final_gates: config.final_status_policy,
    software_snapshot: {
      config_path: configPath, config_sha256: hashFile(root, configPath),
      authority_manifest_path: config.authority_manifest.path, authority_manifest_sha256: authorityHash,
      apparatus_manifest_path: config.apparatus_manifest.path, apparatus_manifest_sha256: apparatusHash,
      fixture_path: config.fixture.path, fixture_sha256: fixtureHash,
      contract_sha256: hashFile(root, "shared/contracts/casimir-dp-empirical-authority-stage4-2l.v1.ts"),
      runtime_sha256: hashFile(root, "shared/casimir-dp-empirical-authority-stage4-2l.ts"),
      runner_sha256: hashFile(root, "scripts/research/run-casimir-dp-empirical-authority-stage4-2l.ts"),
    },
    fresh_casimir_verification: { status: "pending_external_verification", prior_stage4_2k_certificate_reused: false, scientific_scope: "none" },
  };
  const markdown = render(report);
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const trace = `${JSON.stringify({ schema_version: "casimir_dp_stage4_2l_trace/1", record_type: "empirical_authority_no_go", campaign_run_id: runId, diagnostic_gate: nominal.outcome.diagnostic_gate, phase_design_gate: nominal.phase_covariance.synthetic_design_gate, qlbe_proxy_gate: nominal.qlbe.proxy_gate, state_preparation: nominal.state_preparation.empirical_sequence, residual_attribution: nominal.outcome.residual_attribution, measured_evidence: nominal.outcome.measured_evidence })}\n`;
  const receipt = {
    schema_version: "casimir_dp_empirical_authority_stage4_2l_receipt/1",
    campaign_id: config.campaign_id, campaign_run_id: runId, generated_at: generatedAt,
    evidence_class: config.evidence_class, claim_ceiling: config.claim_ceiling,
    promotion_allowed: false, observable_bridge_edges_added: 0,
    config: { path: configPath, sha256: hashFile(root, configPath) },
    authority_manifest: { path: config.authority_manifest.path, sha256: authorityHash },
    apparatus_manifest: { path: config.apparatus_manifest.path, sha256: apparatusHash },
    fixture: { path: config.fixture.path, sha256: fixtureHash },
    report_json_sha256: hashText(reportJson), report_markdown_sha256: hashText(markdown), trace_sha256: hashText(trace),
    result: config.final_status_policy,
    downstream_verification: { status: "pending_external_verification", prior_stage4_2k_certificate_reused: false },
  };
  const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;
  const outputDir = path.resolve(root, options.outputRoot ?? DEFAULT_OUTPUT, runId);
  const paths = {
    output_dir: outputDir,
    report_json: path.join(outputDir, "empirical-authority-stage4-2l-report.json"),
    report_markdown: path.join(outputDir, "empirical-authority-stage4-2l-report.md"),
    trace: path.join(outputDir, "empirical-authority-stage4-2l-trace.jsonl"),
    receipt: path.join(outputDir, "empirical-authority-stage4-2l-receipt.json"),
    maintained_report: options.reportDocPath == null ? null : path.resolve(root, options.reportDocPath),
  };
  if (options.writeArtifacts ?? true) {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(paths.report_json, reportJson); writeFileSync(paths.report_markdown, markdown);
    writeFileSync(paths.trace, trace); writeFileSync(paths.receipt, receiptJson);
    if (paths.maintained_report) writeFileSync(paths.maintained_report, markdown);
  }
  return { report, markdown, trace, receipt, paths, hashes: { report_json_sha256: hashText(reportJson), report_markdown_sha256: hashText(markdown), trace_sha256: hashText(trace), receipt_sha256: hashText(receiptJson) } };
}

function parseArgs(argv: string[]) {
  const out: Record<string, any> = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--config") out.configPath = argv[++index];
    else if (argv[index] === "--output-root") out.outputRoot = argv[++index];
    else if (argv[index] === "--report-doc") out.reportDocPath = argv[++index];
    else if (argv[index] === "--run-id") out.runId = argv[++index];
    else if (argv[index] === "--generated-at") out.generatedAt = argv[++index];
    else if (argv[index] === "--no-write") out.writeArtifacts = false;
    else throw new Error(`stage4_2l_unknown_argument:${argv[index]}`);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCasimirDpEmpiricalAuthorityStage4_2L(parseArgs(process.argv.slice(2))).then((result) => console.log(JSON.stringify({ campaign_run_id: result.report.campaign_run_id, campaign_gate: result.report.campaign_gate, final_gates: result.report.final_gates, hashes: result.hashes, paths: result.paths }, null, 2)));
}
