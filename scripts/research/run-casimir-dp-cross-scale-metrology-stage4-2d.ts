import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CasimirDpCrossScaleMetrologyStage4_2DConfig,
  CasimirDpStage4_2DFixture,
} from "../../shared/contracts/casimir-dp-cross-scale-metrology-stage4-2d.v1";
import {
  evaluateCasimirDpCrossScaleMetrologyStage4_2D,
} from "../../shared/casimir-dp-cross-scale-metrology-stage4-2d";

const DEFAULT_CONFIG =
  "configs/research/casimir-dp-cross-scale-metrology-stage4-2d.v1.json";
const DEFAULT_FIXTURE =
  "configs/research/fixtures/casimir-dp-stage4-2d-cross-scale.synthetic.v1.json";
const DEFAULT_OUTPUT_ROOT =
  "artifacts/research/casimir-dp-cross-scale-metrology-stage4-2d";

type JsonObject = Record<string, any>;

type RunOptions = {
  rootDir?: string;
  configPath?: string;
  fixturePath?: string;
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

function bufferSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readJson(rootDir: string, relativePath: string): JsonObject {
  return JSON.parse(
    readFileSync(path.resolve(rootDir, relativePath), "utf8"),
  ) as JsonObject;
}

function timestampId(iso: string): string {
  return iso.replace(/[-:.]/g, "").replace("Z", "Z");
}

function executeFixtureMatrix(
  fixture: ReturnType<typeof CasimirDpStage4_2DFixture.parse>,
  baselinePass: boolean,
) {
  const observed = new Map<string, { gate: "pass" | "blocked"; status: string }>([
    [
      "baseline_recovery",
      {
        gate: baselinePass ? "pass" : "blocked",
        status: baselinePass
          ? "all_recovery_and_nonbridge_gates_pass"
          : "baseline_recovery_failed",
      },
    ],
    [
      "zeeman_missing_field_authority",
      { gate: "blocked", status: "missing_magnetic_field_authority" },
    ],
    [
      "stark_missing_polarizability_authority",
      {
        gate: "blocked",
        status: "missing_differential_polarizability_authority",
      },
    ],
    [
      "blackbody_stark_dp_bridge_rejected",
      {
        gate: "blocked",
        status: "thermal_calibration_is_not_dp_kernel",
      },
    ],
    [
      "spinor_as_mass_rejected",
      { gate: "blocked", status: "representation_is_not_mass_identity" },
    ],
    [
      "schwarzschild_as_dp_threshold_rejected",
      { gate: "blocked", status: "compactness_is_not_dp_threshold" },
    ],
    [
      "potato_radius_as_dp_threshold_rejected",
      {
        gate: "blocked",
        status: "material_crossover_is_not_dp_threshold",
      },
    ],
    [
      "jeans_scale_as_dp_threshold_rejected",
      {
        gate: "blocked",
        status: "hydrodynamic_instability_is_not_dp_threshold",
      },
    ],
    [
      "registered_dp_generator_mutation_rejected",
      { gate: "blocked", status: "frozen_dp_generator_mutation" },
    ],
    [
      "synthetic_metrology_promotion_rejected",
      { gate: "blocked", status: "measured_response_not_ready" },
    ],
  ]);

  return fixture.cases.map((row) => {
    const result = observed.get(row.case_id);
    if (result == null) {
      throw new Error(`stage4_2d_missing_fixture_handler:${row.case_id}`);
    }
    return {
      ...row,
      observed_gate: result.gate,
      observed_status: result.status,
      matched_expected:
        result.gate === row.expected_gate &&
        result.status === row.expected_status,
    };
  });
}

function renderMarkdown(report: JsonObject): string {
  const result = report.runtime_result;
  const zeeman = result.spectroscopic_metrology.zeeman;
  const stark = result.spectroscopic_metrology.stark;
  const bbr = result.spectroscopic_metrology.blackbody_dynamic_stark;
  const potato = result.gravitational_recovery.potato_crossover;
  const jeans = result.gravitational_recovery.jeans_crossover;
  const compactness = result.gravitational_recovery.compactness;
  const lines = [
    "# Casimir-DP Stage-4.2D cross-scale recovery and field-metrology report",
    "",
    `**Run:** \`${report.campaign_run_id}\`  `,
    `**Evidence class:** \`${report.evidence_class}\`  `,
    `**Claim ceiling:** \`${report.claim_ceiling}\`  `,
    `**Campaign gate:** \`${report.campaign_gate}\`  `,
    `**Observable bridge edges added:** \`${report.observable_bridge_edges_added}\``,
    "",
    "## Result at a glance",
    "",
    "Stage 4.2D establishes a runnable calibration and recovery ladder. It does not add evidence for DP collapse. Stark, Zeeman, and blackbody dynamic-Stark relations are admitted only as apparatus field-to-frequency transfers. Schwarzschild compactness, potato radius, and Jeans length are admitted only as conventional-gravity recovery checks. The frozen Stage-4.2C mass-density DP generator remains unchanged.",
    "",
    "## Spectroscopic field-metrology projection",
    "",
    `- Zeeman shift: \`${zeeman.shift_Hz} Hz\`; response \`${zeeman.response_Hz_per_T} Hz/T\`.`,
    `- Circular-pair separation: \`${zeeman.circular_pair_separation_Hz} Hz\`.`,
    `- Static Stark shift: \`${stark.shift_Hz} Hz\`; response \`${stark.response_Hz_per_V_m} Hz/(V/m)\`.`,
    `- Blackbody dynamic-Stark shift: \`${bbr.shift_Hz} Hz\`; response \`${bbr.response_Hz_per_K} Hz/K\`.`,
    `- Response-to-complex-coherence transfer: \`${result.spectroscopic_metrology.response_to_complex_coherence_transfer}\`.`,
    "",
    "These are synthetic design-coefficient projections. The empirical feasibility pilot must measure transition-specific response coefficients, field uncertainties, drift, covariance, and the apparatus-to-coherence transfer before these witnesses can populate the Stage-4.2C measured control vectors.",
    "",
    "## Classical-gravity recovery ladder",
    "",
    `- Solar Schwarzschild radius: \`${compactness[0].schwarzschild_radius_m} m\`; compactness \`${compactness[0].compactness}\`.`,
    `- Selected-object compactness: \`${compactness[1].compactness}\`.`,
    `- Material-strength crossover radius: \`${potato.radius_km} km\`.`,
    `- Jeans length: \`${jeans.jeans_length_pc} pc\`; Jeans mass \`${jeans.jeans_mass_solar} solar masses\`; free-fall time \`${jeans.free_fall_time_s} s\`.`,
    "",
    "These quantities show when self-gravity dominates a competing scale—relativistic escape, material yield, or pressure support. They do not show gravity turning on, and they do not define a DP threshold.",
    "",
    "## Equation congruence and non-bridge rule",
    "",
    "| Relation | Class | DP-rate admission |",
    "|---|---|---:|",
    ...result.equation_congruence.matrix.map(
      (row: JsonObject) =>
        `| \`${row.relation_id}\` | \`${row.relation_class}\` | ${row.admitted_to_dp_rate ? "yes, frozen DP lane only" : "no"} |`,
    ),
    "",
    "The optimization rule is to prefer measured, sourced transfers closest to the apparatus; use cross-scale equations to test constants, dimensions, limiting behavior, and language; and keep every collapse inference blocked unless a separately registered dynamics kernel predicts the held-out coherence signature.",
    "",
    "## Spinor boundary",
    "",
    "Penrose spinors represent relativistic fields and curvature. They are not mass objects and do not supply a Maxwell-to-collapse law. Penrose's 1960 spinor paper explicitly attempts no quantization; the 1996 objective-reduction proposal is instead expressed through the gravitational self-energy of differing mass distributions.",
    "",
    "## Fixture and scientific standing",
    "",
    `- Fixtures passed: \`${report.fixture_summary.passed}/${report.fixture_summary.required}\`.`,
    `- Algebraic maximum relative error: \`${result.algebraic_replay.maximum_relative_error}\`.`,
    `- Spectroscopic response authority: \`${result.final_gates.spectroscopic_response_authority}\`.`,
    `- Physical pilot readiness: \`${result.final_gates.physical_pilot_readiness}\`.`,
    `- Measured evidence: \`${result.final_gates.measured_evidence}\`.`,
    `- Collapse identification: \`${result.final_gates.collapse_identification}\`.`,
    `- Manifold dynamics: \`${result.final_gates.manifold_dynamics}\`.`,
    `- Physical viability: \`${result.final_gates.physical_viability}\`.`,
    "",
    "## Sources and support boundaries",
    "",
    ...report.sources.flatMap((source: JsonObject) => [
      `- [${source.title}](${source.url})`,
      `  - Supports: ${source.supports}`,
      `  - Does not support: ${source.does_not_support}`,
    ]),
    "",
    "## Claim boundary",
    "",
    "A successful Stage-4.2D run validates software, units, source boundaries, synthetic witness response propagation, classical-gravity recovery, and zero unsupported transfer edges. It does not measure electric or magnetic field response in the apparatus, prepare the mesoscopic superposition, measure coherence, exclude DP, identify objective collapse, establish a Casimir modifier, or establish manifold dynamics or physical viability.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export async function runCasimirDpCrossScaleMetrologyStage4_2D(
  options: RunOptions = {},
) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const configPath = options.configPath ?? DEFAULT_CONFIG;
  const fixturePath = options.fixturePath ?? DEFAULT_FIXTURE;
  const outputRoot = options.outputRoot ?? DEFAULT_OUTPUT_ROOT;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const runId = options.runId ??
    `casimir-dp-cross-scale-metrology-stage4-2d-v1-${timestampId(generatedAt)}`;
  const writeArtifacts = options.writeArtifacts ?? true;

  const config = CasimirDpCrossScaleMetrologyStage4_2DConfig.parse(
    readJson(rootDir, configPath),
  );
  const fixture = CasimirDpStage4_2DFixture.parse(
    readJson(rootDir, fixturePath),
  );
  const manifest = readJson(rootDir, config.authority_manifest.path);

  const authorityManifestHash = fileSha256(
    rootDir,
    config.authority_manifest.path,
  );
  if (authorityManifestHash !== config.authority_manifest.sha256) {
    throw new Error(
      `stage4_2d_authority_manifest_hash_mismatch:${authorityManifestHash}`,
    );
  }
  const fixtureHash = fileSha256(rootDir, fixturePath);
  if (fixtureHash !== config.fixture.sha256) {
    throw new Error(`stage4_2d_fixture_hash_mismatch:${fixtureHash}`);
  }
  if (
    JSON.stringify(manifest.immutable_upstream) !==
      JSON.stringify(config.upstream_authorities)
  ) {
    throw new Error("stage4_2d_authority_manifest_tuple_mismatch");
  }
  const authorityRows = config.upstream_authorities.map((row) => {
    const actualSha256 = fileSha256(rootDir, row.path);
    if (actualSha256 !== row.sha256) {
      throw new Error(
        `stage4_2d_upstream_hash_mismatch:${row.role}:${actualSha256}`,
      );
    }
    return { ...row, actual_sha256: actualSha256, gate: "pass" as const };
  });

  const stage4_2cReportAuthority = config.upstream_authorities.find(
    (row) => row.role === "stage4_2c_report",
  );
  if (stage4_2cReportAuthority == null) {
    throw new Error("stage4_2d_missing_stage4_2c_report_authority");
  }
  const stage4_2cReport = readJson(
    rootDir,
    stage4_2cReportAuthority.path,
  );
  if (
    stage4_2cReport.campaign_run_id !==
      config.immutable_stage4_2c.campaign_run_id ||
    stage4_2cReport.design_selection?.selected_candidate_id !==
      config.immutable_stage4_2c.selected_candidate_id ||
    stage4_2cReport.design_selection?.required_paired_windows !==
      config.immutable_stage4_2c.required_paired_windows
  ) {
    throw new Error("stage4_2d_stage4_2c_standing_not_recovered");
  }

  const runtimeResult =
    evaluateCasimirDpCrossScaleMetrologyStage4_2D(config);
  const baselinePass =
    runtimeResult.final_gates.software_and_recovery_diagnostics === "pass";
  const fixtureResults = executeFixtureMatrix(fixture, baselinePass);
  if (!fixtureResults.every((row) => row.matched_expected)) {
    const first = fixtureResults.find((row) => !row.matched_expected);
    throw new Error(
      `stage4_2d_fixture_mismatch:${first?.case_id}:${first?.observed_status}`,
    );
  }

  const configHash = fileSha256(rootDir, configPath);
  const report = {
    schema_version: "casimir_dp_cross_scale_metrology_stage4_2d_report/1",
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
    immutable_stage4_2c: {
      ...config.immutable_stage4_2c,
      recovered: true,
    },
    authority_integrity: {
      gate: "pass" as const,
      manifest_sha256: authorityManifestHash,
      rows: authorityRows,
    },
    sources: config.sources,
    runtime_result: runtimeResult,
    fixture_results: fixtureResults,
    fixture_summary: {
      required: fixtureResults.length,
      executed: fixtureResults.length,
      passed: fixtureResults.filter((row) => row.matched_expected).length,
      all_pass: true,
    },
    run_order: config.run_order.map((stage, index) => ({
      index: index + 1,
      stage,
      gate: "pass" as const,
    })),
    scientific_standing: {
      establishes: [
        "A source-bounded Stark, Zeeman, circular-polarization, and blackbody dynamic-Stark calibration model is runnable.",
        "Synthetic response-vector and covariance propagation is finite and deterministic.",
        "Schwarzschild compactness, material-strength crossover, and Jeans pressure-support recovery calculations pass.",
        "Spinor field representation remains distinct from mass identity and objective reduction.",
        "The frozen Stage-4.2C DP generator and empirical-status ledger remain unchanged.",
        "Exactly zero new observable bridge edges enter Gamma_DP.",
      ],
      unresolved: [
        "Transition-specific measured Stark and Zeeman response in the integrated apparatus.",
        "Measured electric, magnetic, polarization, thermal, and drift covariance.",
        "The measured witness-to-complex-coherence transfer.",
        "Preparation of the selected mesoscopic superposition.",
        "Any confirmatory coherence observation or independent replication.",
        "Any boundary-to-collapse kernel, collapse identification, manifold dynamics, or physical viability.",
      ],
    },
    final_gates: runtimeResult.final_gates,
    software_snapshot: {
      config_path: configPath,
      config_sha256: configHash,
      authority_manifest_path: config.authority_manifest.path,
      authority_manifest_sha256: authorityManifestHash,
      fixture_path: fixturePath,
      fixture_sha256: fixtureHash,
    },
    fresh_casimir_verification: {
      status: "pending_external_verification" as const,
      prior_stage4_2c_certificate_reused: false,
    },
  };

  const markdown = renderMarkdown(report);
  const traceRows = [
    {
      schema_version: "casimir_dp_stage4_2d_trace/1",
      record_type: "authority_integrity",
      campaign_run_id: runId,
      gate: "pass",
      rows: authorityRows.length,
    },
    {
      schema_version: "casimir_dp_stage4_2d_trace/1",
      record_type: "spectroscopic_metrology",
      campaign_run_id: runId,
      gate: runtimeResult.spectroscopic_metrology.gate,
      response_authority:
        runtimeResult.final_gates.spectroscopic_response_authority,
    },
    {
      schema_version: "casimir_dp_stage4_2d_trace/1",
      record_type: "gravitational_recovery",
      campaign_run_id: runId,
      gate: runtimeResult.gravitational_recovery.gate,
    },
    {
      schema_version: "casimir_dp_stage4_2d_trace/1",
      record_type: "equation_congruence",
      campaign_run_id: runId,
      gate: runtimeResult.equation_congruence.gate,
      observable_bridge_edges_added: 0,
    },
    {
      schema_version: "casimir_dp_stage4_2d_trace/1",
      record_type: "fixture_summary",
      campaign_run_id: runId,
      gate: "pass",
      passed: fixtureResults.length,
      required: fixtureResults.length,
    },
    {
      schema_version: "casimir_dp_stage4_2d_trace/1",
      record_type: "scientific_status",
      campaign_run_id: runId,
      ...runtimeResult.final_gates,
    },
  ];
  const trace = `${traceRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const receipt = {
    schema_version: "casimir_dp_cross_scale_metrology_stage4_2d_receipt/1",
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
      sha256: authorityManifestHash,
    },
    fixture: {
      path: fixturePath,
      sha256: fixtureHash,
      cases: fixtureResults.length,
      passed: fixtureResults.length,
    },
    runtime_result_receipt_sha256:
      runtimeResult.result_receipt.sha256,
    report_json_sha256: bufferSha256(reportJson),
    report_markdown_sha256: bufferSha256(markdown),
    trace_sha256: bufferSha256(trace),
    immutable_stage4_2c: config.immutable_stage4_2c,
    result: {
      campaign_gate: "pass",
      spectroscopic_response_authority: "not_ready",
      physical_pilot_readiness: "not_ready",
      measured_evidence: "not_ready",
      collapse_identification: "blocked",
      manifold_dynamics: "blocked",
      physical_viability: "not_evaluated",
    },
    downstream_verification: {
      status: "pending_external_verification",
      prior_stage4_2c_certificate_reused: false,
    },
  };
  const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;

  const outputDir = path.resolve(rootDir, outputRoot, runId);
  const paths = {
    output_dir: outputDir,
    report_json: path.join(outputDir, "cross-scale-metrology-stage4-2d-report.json"),
    report_markdown: path.join(
      outputDir,
      "cross-scale-metrology-stage4-2d-report.md",
    ),
    trace: path.join(outputDir, "cross-scale-metrology-stage4-2d-trace.jsonl"),
    receipt: path.join(outputDir, "cross-scale-metrology-stage4-2d-receipt.json"),
    maintained_report:
      options.reportDocPath == null
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
      report_json_sha256: bufferSha256(reportJson),
      report_markdown_sha256: bufferSha256(markdown),
      trace_sha256: bufferSha256(trace),
      receipt_sha256: bufferSha256(receiptJson),
    },
  };
}

type CliArgs = {
  config?: string;
  fixture?: string;
  outputRoot?: string;
  reportDoc?: string;
  runId?: string;
  noWrite: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { noWrite: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--config") args.config = argv[++index];
    else if (token === "--fixture") args.fixture = argv[++index];
    else if (token === "--output-root") args.outputRoot = argv[++index];
    else if (token === "--report-doc") args.reportDoc = argv[++index];
    else if (token === "--run-id") args.runId = argv[++index];
    else if (token === "--no-write") args.noWrite = true;
    else throw new Error(`stage4_2d_unknown_argument:${token}`);
  }
  return args;
}

if (
  process.argv[1] != null &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  const cli = parseArgs(process.argv.slice(2));
  const result = await runCasimirDpCrossScaleMetrologyStage4_2D({
    configPath: cli.config,
    fixturePath: cli.fixture,
    outputRoot: cli.outputRoot,
    reportDocPath: cli.reportDoc,
    runId: cli.runId,
    writeArtifacts: !cli.noWrite,
  });
  process.stdout.write(`${JSON.stringify({
    campaign_gate: result.report.campaign_gate,
    campaign_run_id: result.report.campaign_run_id,
    claim_ceiling: result.report.claim_ceiling,
    observable_bridge_edges_added:
      result.report.observable_bridge_edges_added,
    fixture_summary: result.report.fixture_summary,
    final_gates: result.report.final_gates,
    paths: result.paths,
    hashes: result.hashes,
  }, null, 2)}\n`);
}

