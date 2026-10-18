import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCasimirDpMicroscopicEmClosureStage4_2K } from "../../shared/casimir-dp-microscopic-em-closure-stage4-2k";
import {
  CasimirDpMicroscopicEmClosureFixtureStage4_2K,
  CasimirDpMicroscopicEmClosureStage4_2KConfig,
} from "../../shared/contracts/casimir-dp-microscopic-em-closure-stage4-2k.v1";

const DEFAULT_CONFIG = "configs/research/casimir-dp-microscopic-em-closure-stage4-2k.v1.json";
const DEFAULT_OUTPUT = "artifacts/research/casimir-dp-microscopic-em-closure-stage4-2k";
type Options = { rootDir?: string; configPath?: string; outputRoot?: string; reportDocPath?: string; runId?: string; generatedAt?: string; writeArtifacts?: boolean };
const hashText = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const hashFile = (root: string, relative: string) => createHash("sha256").update(readFileSync(path.resolve(root, relative))).digest("hex");
const readJson = (root: string, relative: string) => JSON.parse(readFileSync(path.resolve(root, relative), "utf8"));
const timestampId = (iso: string) => iso.replace(/[-:.]/g, "");

function render(report: any): string {
  const n = report.nominal_synthetic_result;
  return `# Casimir-DP Stage-4.2K microscopic electromagnetic closure report

**Run:** \`${report.campaign_run_id}\`  
**Evidence:** synthetic diagnostic only  
**Claim ceiling:** ordinary electromagnetic phase/loss and readiness diagnostic only

## Result

The analytic oscillator, ground-state polarizability, and ideal planar Casimir-Polder screen pass as software diagnostics. The apparatus electromagnetic closure does not pass: measured temperature-matched material spectra, a registered branch orientation, finite CAD/mesh and Green/scattering receipts, ordinary-response covariance, and every quantum-linear-Boltzmann input remain absent. Residual attribution is therefore blocked and no confirmatory campaign is authorized.

## Ground-state and material-response chain

\`ground-state transition sums -> alpha(i xi) -> epsilon(i xi) -> Green/scattering response -> ordinary branch phase and loss\`

- Synthetic static silica permittivity: \`${n.material_ground_state_chain.epsilon_static}\`.
- Static sphere polarizability: \`${n.material_ground_state_chain.sphere_polarizability_static_SI} SI\`.
- Atomic benchmark polarizability: \`${n.material_ground_state_chain.atomic_ground_state_polarizability_static_SI} SI\`.
- Measured material authority: \`${n.material_ground_state_chain.measured_material_authority}\`.

## Orientation screen

The ideal-conductor retarded-dipole approximation is a screening bound, not the finite apparatus forecast. With the branch normal to the plane it gives \`Delta U = ${n.ideal_planar_orientation_screen.normal.delta_energy_J} J\` and \`${n.ideal_planar_orientation_screen.normal.phase_rad} rad\` over 250 ms. For a tangential branch in the translationally invariant ideal-plane limit, the differential phase is zero. The orientation is unregistered, so this order-of-magnitude ambiguity blocks attribution.

Gaussian phase jitter contributes \`sigma_phi^2/2\` to log-visibility loss. Keeping that below one tenth of the registered DP exponent in the normal screen requires \`sigma_phi <= ${n.phase_to_coherence_budget.maximum_phase_jitter_rad_for_registered_fraction_of_dp_loss} rad\`, or fractional stability \`${n.phase_to_coherence_budget.required_normal_fractional_stability}\` relative to the screened phase.

## Four-cell interpretation

The synthetic ordinary subtraction recovers zero injected bridge amplitude and phase. Standard boundary-independent DP contributes zero to this factorial interaction. The recovery validates estimator semantics only; empirical authority is \`${n.four_cell_residual_attribution.empirical_authority}\`.

## Gas model

The QLBE readiness gate is \`${n.qlbe_readiness.gate}\`. Species-resolved pressure, temperature, differential scattering amplitudes, confinement geometry, momentum-transfer quadrature, and independent calibration must be measured before the Stage-4.2J geometric screen can be replaced.

## Standing

${Object.entries(report.final_gates).map(([key, value]) => `- \`${key}\`: \`${value}\`.`).join("\n")}
`;
}

export async function runCasimirDpMicroscopicEmClosureStage4_2K(options: Options = {}) {
  const root = path.resolve(options.rootDir ?? process.cwd());
  const configPath = options.configPath ?? DEFAULT_CONFIG;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const runId = options.runId ?? `casimir-dp-microscopic-em-closure-stage4-2k-v1-${timestampId(generatedAt)}`;
  const config = CasimirDpMicroscopicEmClosureStage4_2KConfig.parse(readJson(root, configPath));
  const manifestHash = hashFile(root, config.authority_manifest.path);
  if (manifestHash !== config.authority_manifest.sha256) throw new Error(`stage4_2k_authority_manifest_hash_mismatch:${manifestHash}`);
  const manifest = readJson(root, config.authority_manifest.path);
  if (JSON.stringify(manifest.immutable_upstream) !== JSON.stringify(config.upstream_authorities) || JSON.stringify(manifest.method_authorities) !== JSON.stringify(config.method_authorities)) throw new Error("stage4_2k_authority_tuple_mismatch");
  const authorityRows = [...config.upstream_authorities, ...config.method_authorities].map((row) => {
    const actual = hashFile(root, row.path);
    if (actual !== row.sha256) throw new Error(`stage4_2k_authority_hash_mismatch:${row.role}:${actual}`);
    return { ...row, actual_sha256: actual, gate: "pass" as const };
  });
  const stageJ = readJson(root, config.upstream_authorities.find((row) => row.role === "stage4_2j_report")!.path);
  if (stageJ.final_gates?.measured_evidence !== "not_ready" || stageJ.final_gates?.collapse_identification !== "blocked") throw new Error("stage4_2k_upstream_standing_not_recovered");
  const fixtureHash = hashFile(root, config.fixture.path);
  if (fixtureHash !== config.fixture.sha256) throw new Error(`stage4_2k_fixture_hash_mismatch:${fixtureHash}`);
  const fixture = CasimirDpMicroscopicEmClosureFixtureStage4_2K.parse(readJson(root, config.fixture.path));
  const nominal = evaluateCasimirDpMicroscopicEmClosureStage4_2K({ config, fixture });
  if (nominal.outcome.diagnostic_gate !== "pass" || nominal.outcome.residual_attribution !== "blocked" || nominal.hypothesis_separation.observable_bridge_edges_added !== 0) throw new Error("stage4_2k_fail_closed_recovery_failed");
  const report = {
    schema_version: "casimir_dp_microscopic_em_closure_stage4_2k_report/1",
    study_id: config.study_id, campaign_id: config.campaign_id, campaign_run_id: runId,
    generated_at: generatedAt, evidence_cutoff: config.evidence_cutoff,
    evidence_class: config.evidence_class, claim_ceiling: config.claim_ceiling,
    promotion_allowed: false, observable_bridge_edges_added: 0,
    campaign_gate: "pass" as const, integrity_gate: "pass" as const,
    immutable_stage4_2j: { campaign_run_id: stageJ.campaign_run_id, recovered: true },
    authority_integrity: { gate: "pass" as const, manifest_sha256: manifestHash, rows: authorityRows },
    nominal_synthetic_result: nominal,
    run_order: config.run_order.map((stage, index) => ({ index: index + 1, stage, gate: "pass" as const })),
    final_gates: config.final_status_policy,
    software_snapshot: {
      config_path: configPath, config_sha256: hashFile(root, configPath),
      authority_manifest_path: config.authority_manifest.path, authority_manifest_sha256: manifestHash,
      fixture_path: config.fixture.path, fixture_sha256: fixtureHash,
      contract_sha256: hashFile(root, "shared/contracts/casimir-dp-microscopic-em-closure-stage4-2k.v1.ts"),
      runtime_sha256: hashFile(root, "shared/casimir-dp-microscopic-em-closure-stage4-2k.ts"),
      runner_sha256: hashFile(root, "scripts/research/run-casimir-dp-microscopic-em-closure-stage4-2k.ts"),
    },
    fresh_casimir_verification: { status: "pending_external_verification", prior_stage4_2j_certificate_reused: false, scientific_scope: "none" },
  };
  const markdown = render(report);
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const trace = `${JSON.stringify({ schema_version: "casimir_dp_stage4_2k_trace/1", record_type: "fail_closed_result", campaign_run_id: runId, diagnostic_gate: nominal.outcome.diagnostic_gate, residual_attribution: nominal.outcome.residual_attribution, qlbe: nominal.qlbe_readiness.gate, measured_evidence: "not_ready" })}\n`;
  const receipt = { schema_version: "casimir_dp_microscopic_em_closure_stage4_2k_receipt/1", campaign_id: config.campaign_id, campaign_run_id: runId, generated_at: generatedAt, evidence_class: config.evidence_class, claim_ceiling: config.claim_ceiling, promotion_allowed: false, observable_bridge_edges_added: 0, config: { path: configPath, sha256: hashFile(root, configPath) }, authority_manifest: { path: config.authority_manifest.path, sha256: manifestHash }, fixture: { path: config.fixture.path, sha256: fixtureHash }, report_json_sha256: hashText(reportJson), report_markdown_sha256: hashText(markdown), trace_sha256: hashText(trace), result: config.final_status_policy, downstream_verification: { status: "pending_external_verification", prior_stage4_2j_certificate_reused: false } };
  const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;
  const outputDir = path.resolve(root, options.outputRoot ?? DEFAULT_OUTPUT, runId);
  const paths = { output_dir: outputDir, report_json: path.join(outputDir, "microscopic-em-closure-stage4-2k-report.json"), report_markdown: path.join(outputDir, "microscopic-em-closure-stage4-2k-report.md"), trace: path.join(outputDir, "microscopic-em-closure-stage4-2k-trace.jsonl"), receipt: path.join(outputDir, "microscopic-em-closure-stage4-2k-receipt.json"), maintained_report: options.reportDocPath == null ? null : path.resolve(root, options.reportDocPath) };
  if (options.writeArtifacts ?? true) {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(paths.report_json, reportJson); writeFileSync(paths.report_markdown, markdown);
    writeFileSync(paths.trace, trace); writeFileSync(paths.receipt, receiptJson);
    if (paths.maintained_report) writeFileSync(paths.maintained_report, markdown);
  }
  return { report, markdown, trace, receipt, paths, hashes: { report_json_sha256: hashText(reportJson), report_markdown_sha256: hashText(markdown), trace_sha256: hashText(trace), receipt_sha256: hashText(receiptJson) } };
}

function parseArgs(argv: string[]) { const out: Record<string, any> = {}; for (let i = 0; i < argv.length; i++) { if (argv[i] === "--config") out.configPath = argv[++i]; else if (argv[i] === "--output-root") out.outputRoot = argv[++i]; else if (argv[i] === "--report-doc") out.reportDocPath = argv[++i]; else if (argv[i] === "--run-id") out.runId = argv[++i]; else if (argv[i] === "--generated-at") out.generatedAt = argv[++i]; else if (argv[i] === "--no-write") out.writeArtifacts = false; else throw new Error(`stage4_2k_unknown_argument:${argv[i]}`); } return out; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCasimirDpMicroscopicEmClosureStage4_2K(parseArgs(process.argv.slice(2))).then((result) => console.log(JSON.stringify({ campaign_run_id: result.report.campaign_run_id, campaign_gate: result.report.campaign_gate, final_gates: result.report.final_gates, hashes: result.hashes, paths: result.paths }, null, 2)));
