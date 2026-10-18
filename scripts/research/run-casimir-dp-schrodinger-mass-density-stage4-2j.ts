import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateCasimirDpSchrodingerMassDensityStage4_2J,
} from "../../shared/casimir-dp-schrodinger-mass-density-stage4-2j";
import {
  CasimirDpSchrodingerMassDensityFixtureStage4_2J,
  CasimirDpSchrodingerMassDensityStage4_2JConfig,
  type CasimirDpSchrodingerMassDensityFixtureStage4_2J as Stage4JFixture,
} from "../../shared/contracts/casimir-dp-schrodinger-mass-density-stage4-2j.v1";

const DEFAULT_CONFIG =
  "configs/research/casimir-dp-schrodinger-mass-density-stage4-2j.v1.json";
const DEFAULT_OUTPUT_ROOT =
  "artifacts/research/casimir-dp-schrodinger-mass-density-stage4-2j";

type JsonObject = Record<string, any>;
type RunOptions = {
  rootDir?: string;
  configPath?: string;
  outputRoot?: string;
  reportDocPath?: string;
  runId?: string;
  generatedAt?: string;
  writeArtifacts?: boolean;
};

function fileSha256(rootDir: string, relativePath: string): string {
  return createHash("sha256")
    .update(readFileSync(path.resolve(rootDir, relativePath)))
    .digest("hex");
}

function textSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readJson(rootDir: string, relativePath: string): JsonObject {
  return JSON.parse(readFileSync(path.resolve(rootDir, relativePath), "utf8"));
}

function timestampId(iso: string): string {
  return iso.replace(/[-:.]/g, "").replace("Z", "Z");
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildAdversarialCases(
  fixture: Stage4JFixture,
  config: ReturnType<
    typeof CasimirDpSchrodingerMassDensityStage4_2JConfig.parse
  >,
) {
  const alteredReference = deepClone(fixture);
  alteredReference.fixture_id = "stage4_2j_altered_dp_reference";
  alteredReference.registered_dp_reference.E_G_J *= 2;
  const alteredResult = evaluateCasimirDpSchrodingerMassDensityStage4_2J({
    config,
    fixture: alteredReference,
  });

  const branchEnergy = deepClone(fixture);
  branchEnergy.fixture_id = "stage4_2j_hamiltonian_phase_only";
  branchEnergy.schrodinger_baseline.branch_energy_difference_J = 1e-34;
  const branchEnergyResult =
    evaluateCasimirDpSchrodingerMassDensityStage4_2J({
      config,
      fixture: branchEnergy,
    });

  const permissiveGasConfig = deepClone(config);
  permissiveGasConfig.environmental_screen
    .maximum_gas_to_dp_rate_ratio_for_candidate = 1e6;
  const permissiveGasResult =
    evaluateCasimirDpSchrodingerMassDensityStage4_2J({
      config: permissiveGasConfig,
      fixture,
    });

  const reordered = deepClone(fixture) as JsonObject;
  [reordered.mass_representations[0], reordered.mass_representations[1]] =
    [reordered.mass_representations[1], reordered.mass_representations[0]];
  const reorderedRejected =
    !CasimirDpSchrodingerMassDensityFixtureStage4_2J.safeParse(reordered)
      .success;

  return [
    {
      case_id: "altered_registered_dp_reference_fails_closed",
      gate:
        alteredResult.registered_gaussian_recovery.gate === "blocked" &&
          alteredResult.outcome.diagnostic_gate === "blocked"
          ? "pass"
          : "fail",
      empirical_authority: false,
    },
    {
      case_id: "hamiltonian_energy_rotates_phase_not_dp_loss",
      gate:
        branchEnergyResult.schrodinger_open_system_separation.gate === "pass" &&
          branchEnergyResult.schrodinger_open_system_separation
            .hamiltonian_phase_rad !== 0 &&
          Math.abs(
            branchEnergyResult.registered_gaussian_recovery.loss_fraction -
              (1 - Math.exp(
                -branchEnergyResult.registered_gaussian_recovery.dp_exponent,
              )),
          ) <= 1e-15
          ? "pass"
          : "fail",
      empirical_authority: false,
    },
    {
      case_id: "gas_threshold_controls_candidate_gate",
      gate:
        permissiveGasResult.residual_gas_screen.candidate_gate === "pass" &&
          permissiveGasResult.outcome.physical_candidate_selected === false
          ? "pass"
          : "fail",
      empirical_authority: false,
    },
    {
      case_id: "mass_representation_order_is_preregistered",
      gate: reorderedRejected ? "pass" : "fail",
      empirical_authority: false,
    },
    {
      case_id: "no_boundary_to_collapse_edge_created",
      gate:
        alteredResult.hypothesis_separation.observable_bridge_edges_added ===
            0 &&
          alteredResult.hypothesis_separation.transfer_kernel_registered ===
            false
          ? "pass"
          : "fail",
      empirical_authority: false,
    },
  ] as const;
}

function renderMarkdown(report: JsonObject): string {
  const nominal = report.nominal_synthetic_result;
  const registered = nominal.registered_gaussian_recovery;
  const robustness = nominal.mass_density_robustness;
  const hydrogen = nominal.hydrogen_qed_nonbridge;
  const gas = nominal.residual_gas_screen;
  return `${[
    "# Casimir-DP Stage-4.2J Schrödinger, mass-density, and environment report",
    "",
    `**Run:** \`${report.campaign_run_id}\`  `,
    `**Evidence class:** \`${report.evidence_class}\`  `,
    `**Claim ceiling:** \`${report.claim_ceiling}\`  `,
    `**Software campaign gate:** \`${report.campaign_gate}\`  `,
    "**Observable bridge edges added:** `0`",
    "",
    "## Result at a glance",
    "",
    "This synthetic diagnostic makes the Schrödinger-to-observable chain explicit. The Hamiltonian rotates complex coherence, ordinary open-system channels may rotate and contract it, and the registered nondissipative Diósi term adds a boundary-independent contraction. A measured contraction can be reported as a DP-equivalent energy only conditionally on that frozen model; it is not a calorimetric collection of gravitational energy.",
    "",
    "The software calculation passes, but the declared ideal-gas screen is a no-go, three constituent-density representations remain unavailable, the apparatus mass is far above the cited cross-platform matter-wave benchmark, and the applicable external-bound mapping is not yet registered. Consequently no physical candidate, measured evidence, collapse identification, manifold dynamics, or Casimir-to-collapse bridge is claimed.",
    "",
    "## Frozen effective-Gaussian point",
    "",
    `- E_G: \`${registered.E_G_J} J\`.` ,
    `- Gamma_DP: \`${registered.Gamma_DP_s} s^-1\`.` ,
    `- Hold-time exponent: \`${registered.dp_exponent}\`.` ,
    `- Conditional visibility loss at 250 ms: \`${registered.loss_fraction}\`.` ,
    `- Recovery gate: \`${registered.gate}\`.` ,
    "",
    "The tiny difference between the immutable report visibility and exp(-Gamma_DP t) is retained as a display-precision diagnostic rather than hidden. The recovery tolerance is 1e-8 relative; the observed mismatch is far below it.",
    "",
    "## Schrödinger and open-system separation",
    "",
    "```text",
    "C(t) = C(0) exp[-i Delta_E_H t/hbar] exp[-chi_env(t)] exp[-E_G t/hbar]",
    "E_DP,eq = -hbar ln(|Cobs|/|C0|)/t",
    "```",
    "",
    `The maintained zero-Hamiltonian-phase fixture recovers E_DP,eq with relative error \`${nominal.residual_inverse_mapping.relative_error}\`. This inversion is model-conditional and the full whitened complex-coherence analysis remains authoritative.`,
    "",
    "## Mass-density robustness",
    "",
    `The homogeneous-sphere density convolved with the same Gaussian regularization gives E_G = \`${robustness.representations[1].E_G_J} J\`, or \`${robustness.envelope.homogeneous_to_effective_gaussian_ratio}\` of the single-effective-Gaussian value. Numerical convergence is \`${robustness.homogeneous_convergence_gate}\`. The complete envelope is \`${robustness.envelope.complete_gate}\` because layered, coarse-grained, and atomistic provenance-bound density maps are absent.`,
    "",
    "## Hydrogen and frequency non-bridge",
    "",
    `The DP-to-Rydberg energy ratio is \`${hydrogen.dp_to_rydberg_energy_ratio}\`. It is a scale comparison only. Schrödinger, Compton, QED, Higgs, and blackbody relations do not provide a transfer kernel into Gamma_DP or a cavity mode.`,
    "",
    "## Environmental and preparation screens",
    "",
    ...gas.rows.map((row: JsonObject) =>
      `- \`${row.species_id}\`: ideal-equilibrium geometric collision rate \`${row.collision_rate_s} s^-1\`, gas/DP ratio \`${row.gas_to_dp_rate_ratio}\`, screen \`${row.screen_gate}\`.`),
    `- Declared gas candidate gate: \`${gas.candidate_gate}\`.` ,
    `- Apparatus-to-demonstrated-mass ratio: \`${nominal.state_preparation_scale_screen.apparatus_to_demonstrated_mass_ratio}\`; preparation receipt \`not_ready\`.` ,
    "",
    "These gas values are conservative screening calculations, not a complete scattering kernel or a measured vacuum characterization. They show why acquisition power must not be quoted as physical feasibility yet.",
    "",
    "## Adversarial cases",
    "",
    ...report.adversarial_cases.map((row: JsonObject) =>
      `- \`${row.case_id}\`: \`${row.gate}\`; empirical authority \`false\`.`),
    "",
    "## Bounded scientific standing",
    "",
    ...Object.entries(report.final_gates).map(
      ([key, value]) => `- \`${key}\`: \`${value}\`.`,
    ),
    "",
  ].join("\n")}\n`;
}

export async function runCasimirDpSchrodingerMassDensityStage4_2J(
  options: RunOptions = {},
) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const configPath = options.configPath ?? DEFAULT_CONFIG;
  const outputRoot = options.outputRoot ?? DEFAULT_OUTPUT_ROOT;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const runId = options.runId ??
    `casimir-dp-schrodinger-mass-density-stage4-2j-v1-${timestampId(generatedAt)}`;
  const writeArtifacts = options.writeArtifacts ?? true;
  const config = CasimirDpSchrodingerMassDensityStage4_2JConfig.parse(
    readJson(rootDir, configPath),
  );
  const manifest = readJson(rootDir, config.authority_manifest.path);
  const manifestHash = fileSha256(rootDir, config.authority_manifest.path);
  if (manifestHash !== config.authority_manifest.sha256) {
    throw new Error(`stage4_2j_authority_manifest_hash_mismatch:${manifestHash}`);
  }
  if (
    JSON.stringify(manifest.immutable_upstream) !==
        JSON.stringify(config.upstream_authorities) ||
    JSON.stringify(manifest.method_authorities) !==
        JSON.stringify(config.method_authorities)
  ) {
    throw new Error("stage4_2j_authority_manifest_tuple_mismatch");
  }
  const authorityRows = [
    ...config.upstream_authorities,
    ...config.method_authorities,
  ].map((row) => {
    const actualSha256 = fileSha256(rootDir, row.path);
    if (actualSha256 !== row.sha256) {
      throw new Error(
        `stage4_2j_authority_hash_mismatch:${row.role}:${actualSha256}`,
      );
    }
    return { ...row, actual_sha256: actualSha256, gate: "pass" as const };
  });
  const stage4IReportAuthority = config.upstream_authorities.find(
    (row) => row.role === "stage4_2i_report",
  );
  if (stage4IReportAuthority == null) {
    throw new Error("stage4_2j_stage4_2i_report_authority_missing");
  }
  const stage4IReport = readJson(rootDir, stage4IReportAuthority.path);
  if (
    stage4IReport.campaign_run_id !==
        config.immutable_stage4_2i.campaign_run_id ||
    stage4IReport.final_gates?.measured_evidence !==
        config.immutable_stage4_2i.measured_evidence ||
    stage4IReport.final_gates?.collapse_identification !==
        config.immutable_stage4_2i.collapse_identification ||
    stage4IReport.final_gates?.manifold_dynamics !==
        config.immutable_stage4_2i.manifold_dynamics ||
    stage4IReport.final_gates?.physical_viability !==
        config.immutable_stage4_2i.physical_viability
  ) {
    throw new Error("stage4_2j_stage4_2i_standing_not_recovered");
  }
  const fixtureHash = fileSha256(rootDir, config.fixture.path);
  if (fixtureHash !== config.fixture.sha256) {
    throw new Error(`stage4_2j_fixture_hash_mismatch:${fixtureHash}`);
  }
  const fixture = CasimirDpSchrodingerMassDensityFixtureStage4_2J.parse(
    readJson(rootDir, config.fixture.path),
  );
  const nominal = evaluateCasimirDpSchrodingerMassDensityStage4_2J({
    config,
    fixture,
  });
  if (
    nominal.outcome.diagnostic_gate !== "pass" ||
    nominal.outcome.complete_representation_robustness !== "blocked" ||
    nominal.outcome.declared_equilibrium_gas_screen !== "no_go" ||
    nominal.outcome.physical_candidate_selected ||
    nominal.hypothesis_separation.observable_bridge_edges_added !== 0
  ) {
    throw new Error("stage4_2j_nominal_fail_closed_recovery_failed");
  }
  const adversarialCases = buildAdversarialCases(fixture, config);
  if (adversarialCases.some((row) => row.gate !== "pass")) {
    throw new Error("stage4_2j_adversarial_recovery_failed");
  }
  const configHash = fileSha256(rootDir, configPath);
  const report = {
    schema_version: "casimir_dp_schrodinger_mass_density_stage4_2j_report/1",
    study_id: config.study_id,
    campaign_id: config.campaign_id,
    campaign_run_id: runId,
    generated_at: generatedAt,
    evidence_cutoff: config.evidence_cutoff,
    evidence_class: config.evidence_class,
    claim_ceiling: config.claim_ceiling,
    promotion_allowed: false,
    observable_bridge_edges_added: 0,
    campaign_gate: "pass" as const,
    integrity_gate: "pass" as const,
    immutable_stage4_2i: { ...config.immutable_stage4_2i, recovered: true },
    authority_integrity: {
      gate: "pass" as const,
      manifest_sha256: manifestHash,
      rows: authorityRows,
    },
    nominal_synthetic_result: nominal,
    adversarial_cases: adversarialCases,
    run_order: config.run_order.map((stage, index) => ({
      index: index + 1,
      stage,
      gate: "pass" as const,
    })),
    final_gates: config.final_status_policy,
    software_snapshot: {
      config_path: configPath,
      config_sha256: configHash,
      authority_manifest_path: config.authority_manifest.path,
      authority_manifest_sha256: manifestHash,
      fixture_path: config.fixture.path,
      fixture_sha256: fixtureHash,
      contract_sha256: fileSha256(
        rootDir,
        "shared/contracts/casimir-dp-schrodinger-mass-density-stage4-2j.v1.ts",
      ),
      runtime_sha256: fileSha256(
        rootDir,
        "shared/casimir-dp-schrodinger-mass-density-stage4-2j.ts",
      ),
      runner_sha256: fileSha256(
        rootDir,
        "scripts/research/run-casimir-dp-schrodinger-mass-density-stage4-2j.ts",
      ),
    },
    fresh_casimir_verification: {
      status: "pending_external_verification" as const,
      prior_stage4_2i_certificate_reused: false,
      scientific_scope: "none" as const,
    },
  };
  const markdown = renderMarkdown(report);
  const traceRows = [
    {
      schema_version: "casimir_dp_stage4_2j_trace/1",
      record_type: "authority_integrity",
      campaign_run_id: runId,
      gate: "pass",
      authorities: authorityRows.length,
    },
    {
      schema_version: "casimir_dp_stage4_2j_trace/1",
      record_type: "nominal_fail_closed_result",
      campaign_run_id: runId,
      diagnostic_gate: nominal.outcome.diagnostic_gate,
      complete_representation_robustness:
        nominal.outcome.complete_representation_robustness,
      declared_equilibrium_gas_screen:
        nominal.outcome.declared_equilibrium_gas_screen,
      measured_evidence: "not_ready",
    },
    ...adversarialCases.map((row) => ({
      schema_version: "casimir_dp_stage4_2j_trace/1",
      record_type: "adversarial_case",
      campaign_run_id: runId,
      case_id: row.case_id,
      gate: row.gate,
      empirical_authority: false,
    })),
  ];
  const trace = `${traceRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const receipt = {
    schema_version: "casimir_dp_schrodinger_mass_density_stage4_2j_receipt/1",
    campaign_id: config.campaign_id,
    campaign_run_id: runId,
    generated_at: generatedAt,
    evidence_class: config.evidence_class,
    claim_ceiling: config.claim_ceiling,
    promotion_allowed: false,
    observable_bridge_edges_added: 0,
    config: { path: configPath, sha256: configHash },
    authority_manifest: {
      path: config.authority_manifest.path,
      sha256: manifestHash,
    },
    fixture: { path: config.fixture.path, sha256: fixtureHash },
    report_json_sha256: textSha256(reportJson),
    report_markdown_sha256: textSha256(markdown),
    trace_sha256: textSha256(trace),
    immutable_stage4_2i: config.immutable_stage4_2i,
    result: config.final_status_policy,
    downstream_verification: {
      status: "pending_external_verification",
      prior_stage4_2i_certificate_reused: false,
    },
  };
  const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;
  const outputDir = path.resolve(rootDir, outputRoot, runId);
  const paths = {
    output_dir: outputDir,
    report_json: path.join(outputDir, "schrodinger-mass-density-stage4-2j-report.json"),
    report_markdown: path.join(outputDir, "schrodinger-mass-density-stage4-2j-report.md"),
    trace: path.join(outputDir, "schrodinger-mass-density-stage4-2j-trace.jsonl"),
    receipt: path.join(outputDir, "schrodinger-mass-density-stage4-2j-receipt.json"),
    maintained_report: options.reportDocPath == null
      ? null
      : path.resolve(rootDir, options.reportDocPath),
  };
  if (writeArtifacts) {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(paths.report_json, reportJson, "utf8");
    writeFileSync(paths.report_markdown, markdown, "utf8");
    writeFileSync(paths.trace, trace, "utf8");
    writeFileSync(paths.receipt, receiptJson, "utf8");
    if (paths.maintained_report != null) {
      writeFileSync(paths.maintained_report, markdown, "utf8");
    }
  }
  return {
    report,
    markdown,
    trace,
    receipt,
    paths,
    hashes: {
      report_json_sha256: textSha256(reportJson),
      report_markdown_sha256: textSha256(markdown),
      trace_sha256: textSha256(trace),
      receipt_sha256: textSha256(receiptJson),
    },
  };
}

function parseArgs(argv: string[]) {
  const args: Record<string, any> = { noWrite: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--config") args.config = argv[++index];
    else if (token === "--output-root") args.outputRoot = argv[++index];
    else if (token === "--report-doc") args.reportDoc = argv[++index];
    else if (token === "--run-id") args.runId = argv[++index];
    else if (token === "--generated-at") args.generatedAt = argv[++index];
    else if (token === "--no-write") args.noWrite = true;
    else throw new Error(`stage4_2j_unknown_argument:${token}`);
  }
  return args;
}

if (
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = parseArgs(process.argv.slice(2));
  runCasimirDpSchrodingerMassDensityStage4_2J({
    configPath: args.config,
    outputRoot: args.outputRoot,
    reportDocPath: args.reportDoc,
    runId: args.runId,
    generatedAt: args.generatedAt,
    writeArtifacts: !args.noWrite,
  }).then((result) => {
    console.log(JSON.stringify({
      campaign_run_id: result.report.campaign_run_id,
      campaign_gate: result.report.campaign_gate,
      final_gates: result.report.final_gates,
      hashes: result.hashes,
      paths: result.paths,
    }, null, 2));
  });
}
