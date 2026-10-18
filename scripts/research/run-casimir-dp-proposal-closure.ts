#!/usr/bin/env -S tsx

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCasimirDpProposalReadiness } from "../../shared/casimir-dp-proposal-readiness";
import {
  CasimirDpProposalClosureConfig,
  type CasimirDpProposalClosureConfig as CasimirDpProposalClosureConfigType,
} from "../../shared/contracts/casimir-dp-proposal-closure.v1";

export const CASIMIR_DP_PROPOSAL_CLOSURE_RUN_ORDER = [
  "freeze_claims_and_architecture",
  "validate_subsystem_evidence_and_distance_envelope",
  "freeze_material_surface_and_finite_geometry_measurement_plan",
  "freeze_systematics_transfer_matrix",
  "freeze_clock_calibration_blinding_and_covariance_contracts",
  "freeze_commissioning_dependency_ladder",
  "freeze_power_analysis_and_decision_table",
  "audit_collapse_and_manifold_model_authority",
  "write_hashed_proposal_closure_receipt",
  "update_paper_badges_and_evidence_ledger",
] as const;

const stableJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function assertRunOrder(config: CasimirDpProposalClosureConfigType): void {
  if (config.run_order.length !== CASIMIR_DP_PROPOSAL_CLOSURE_RUN_ORDER.length) {
    throw new Error("Proposal-closure run order length mismatch.");
  }
  CASIMIR_DP_PROPOSAL_CLOSURE_RUN_ORDER.forEach((stage, index) => {
    if (config.run_order[index] !== stage) {
      throw new Error(`run_order[${index}] must be ${stage}`);
    }
  });
}

export function buildCasimirDpProposalClosureReport(args: {
  config: CasimirDpProposalClosureConfigType;
  configSha256: string;
  now?: Date;
}) {
  assertRunOrder(args.config);
  const readiness = evaluateCasimirDpProposalReadiness(args.config);
  const body = {
    schema_version: "casimir_dp_proposal_closure_report/1" as const,
    proposal_id: args.config.proposal_id,
    study_id: args.config.study_id,
    generated_at_utc: (args.now ?? new Date()).toISOString(),
    evidence_cutoff: args.config.evidence_cutoff,
    config_sha256: args.configSha256,
    run_order: args.config.run_order,
    readiness,
    frozen_architecture: args.config.architecture,
    protocol_contracts: {
      signal: args.config.signal_contract,
      finite_geometry_and_material: args.config.finite_geometry_material_contract,
      calibration: args.config.calibration_contract,
      synchronization: args.config.synchronization_contract,
      blinding: args.config.blinding_contract,
      covariance: args.config.covariance_contract,
      statistical_decision: args.config.statistical_decision_contract,
    },
    systematics_matrix: args.config.systematics,
    commissioning_ladder: args.config.commissioning,
    model_lanes: args.config.model_lanes,
    decision_table: args.config.decision_table,
    proposal_nonclaims: args.config.proposal_nonclaims,
  };
  return { ...body, receipt_sha256: sha256(stableJson(body)) };
}

export function renderCasimirDpProposalClosureMarkdown(
  report: ReturnType<typeof buildCasimirDpProposalClosureReport>,
): string {
  const r = report.readiness;
  const systematicsRows = report.systematics_matrix.map((entry) =>
    `| ${entry.family} | ${entry.sensor_or_channel} | ${entry.negative_control} | ${entry.threshold} ${entry.unit} | ${entry.evidence_status} |`,
  ).join("\n");
  const commissioningRows = report.commissioning_ladder
    .sort((left, right) => left.order - right.order)
    .map((stage) =>
      `| ${stage.stage_id} | ${stage.objective} | ${stage.depends_on.join(", ") || "none"} | ${stage.claim_ceiling} |`,
    ).join("\n");
  const modelRows = report.model_lanes.map((lane) =>
    `| ${lane.role} | ${lane.model_id} | ${lane.status} | ${lane.predicted_observables.join(", ") || "none"} | ${lane.claim_ceiling} |`,
  ).join("\n");
  const outcomeRows = report.decision_table.map((outcome) =>
    `| ${outcome.outcome_id} | ${outcome.permitted_statement} | ${outcome.forbidden_statement} |`,
  ).join("\n");
  const contractRows = Object.entries(r.contracts)
    .map(([contract, status]) => `| ${contract} | ${status} |`)
    .join("\n");

  return `# Casimir-DP proposal-closure report\n\n` +
    `- Proposal: \`${report.proposal_id}\`\n` +
    `- Generated: \`${report.generated_at_utc}\`\n` +
    `- Config SHA-256: \`${report.config_sha256}\`\n` +
    `- Receipt SHA-256: \`${report.receipt_sha256}\`\n` +
    `- Proposal package: \`${r.gate_ledger.proposal_package}\`\n` +
    `- Commissioning entry: \`${r.gate_ledger.commissioning_entry}\`\n\n` +
    `## Frozen architecture\n\n` +
    `The proposal uses a silica nanoparticle of nominal mass \`${r.architecture.particle_mass_kg.toExponential(4)} kg\` at \`${r.architecture.nominal_surface_distance_m.toExponential(2)} m\` from one electrically tunable 2D boundary. The \`${report.frozen_architecture.branch_separation_m.toExponential(2)} m\` superposition is transverse to the surface normal. Boundary states are randomized and held static during each coherent evolution, with at least \`${report.frozen_architecture.minimum_settle_time_s} s\` settling between state changes and acquisition.\n\n` +
    `This corrects the earlier symmetric-normal-force concept: the normal Casimir-Polder force is monitored as a common-mode nuisance, while lateral inhomogeneity and phase are measured explicitly. A cofabricated reference resonator must establish the gate-state force contrast before a coherence campaign starts.\n\n` +
    `## Reference scale and feasibility warning\n\n` +
    `The literature-anchored retarded silica/silicon reference gives $C_4=${r.reference_physics.c4_J_m4.toExponential(4)}\\,\\mathrm{J\\,m^4}$, $U_{CP}=${r.reference_physics.casimir_polder_potential_J.toExponential(4)}\\,\\mathrm{J}$, and normal force $F_{CP}=${r.reference_physics.casimir_polder_force_N.toExponential(4)}\\,\\mathrm{N}$ at the nominal distance. These are reference values, not the tunable 2D boundary contrast.\n\n` +
    `Holding shot-to-shot phase noise below \`${r.phase_stability.maximum_phase_noise_rad} rad\` corresponds to differential-force noise below \`${r.phase_stability.maximum_differential_force_noise_N.toExponential(4)} N\` over the frozen branch separation and observation time. For one elementary charge this is equivalent to only \`${r.phase_stability.single_charge_electric_field_equivalent_V_m.toExponential(4)} V/m\`; charge neutrality, shielding, field reversal, and direct phase-nuisance measurement are therefore hard commissioning requirements.\n\n` +
    `## Gate ledger\n\n` +
    `| Gate | Status |\n|---|---|\n` +
    Object.entries(r.gate_ledger).map(([gate, status]) => `| ${gate} | ${status} |`).join("\n") +
    `\n\nThe package can enter commissioning, but it is not a validated experiment or a physical-mechanism result.\n\n` +
    `## Machine-validated preregistration contracts\n\n` +
    `| Contract | Status |\n|---|---|\n${contractRows}\n\n` +
    `The signal definition, finite-geometry/material receipt set, calibration chain, synchronized acquisition, blinding custody, covariance estimator, and statistical decision rules are first-class configuration objects. Their cross-field invariants must pass before \`proposal_package\` can pass.\n\n` +
    `## Systematics transfer matrix\n\n` +
    `| Family | Sensor/channel | Negative control | Threshold | Current evidence |\n|---|---|---|---:|---|\n${systematicsRows}\n\n` +
    `Coverage: \`${r.systematics.coverage_gate}\`; measured transfer functions: \`${r.systematics.measured_transfer_functions_gate}\`.\n\n` +
    `## Commissioning dependency ladder\n\n` +
    `| Stage | Objective | Depends on | Claim ceiling |\n|---|---|---|---|\n${commissioningRows}\n\n` +
    `Dependency order: \`${r.commissioning.dependency_order_gate}\`; hardware completion: \`${r.commissioning.hardware_completion_gate}\`.\n\n` +
    `## Model separation\n\n` +
    `| Role | Model | Status | Predicted observables | Claim ceiling |\n|---|---|---|---|---|\n${modelRows}\n\n` +
    `## Registered outcome language\n\n` +
    `| Outcome | Permitted statement | Forbidden statement |\n|---|---|---|\n${outcomeRows}\n\n` +
    `## Remaining blockers\n\n${r.blockers.map((blocker) => `- \`${blocker}\``).join("\n")}\n\n` +
    `## Non-claims\n\n${report.proposal_nonclaims.map((item) => `- ${item}`).join("\n")}\n`;
}

function parseArgs(argv: string[]) {
  let configPath = "configs/research/casimir-dp-proposal-closure.v1.json";
  let reportPath = "docs/research/casimir-dp-proposal-closure-report.md";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--config") configPath = argv[++index] ?? "";
    else if (argv[index] === "--report-doc") reportPath = argv[++index] ?? "";
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!configPath || !reportPath) throw new Error("Config and report paths must be non-empty.");
  return { configPath, reportPath };
}

export async function runCasimirDpProposalClosure(args: {
  root?: string;
  configPath?: string;
  reportPath?: string;
  now?: Date;
} = {}) {
  const root = args.root ?? process.cwd();
  const configPath = path.resolve(root, args.configPath ?? "configs/research/casimir-dp-proposal-closure.v1.json");
  const reportPath = path.resolve(root, args.reportPath ?? "docs/research/casimir-dp-proposal-closure-report.md");
  const rawConfig = await readFile(configPath);
  const config = CasimirDpProposalClosureConfig.parse(JSON.parse(rawConfig.toString("utf8")));
  const report = buildCasimirDpProposalClosureReport({
    config,
    configSha256: sha256(rawConfig),
    now: args.now,
  });
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, renderCasimirDpProposalClosureMarkdown(report), "utf8");
  return { report, reportPath };
}

const isMain = process.argv[1] != null &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const cli = parseArgs(process.argv.slice(2));
  runCasimirDpProposalClosure({ configPath: cli.configPath, reportPath: cli.reportPath })
    .then(({ report, reportPath }) => process.stdout.write(stableJson({
      report_path: reportPath,
      receipt_sha256: report.receipt_sha256,
      gate_ledger: report.readiness.gate_ledger,
    })))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
