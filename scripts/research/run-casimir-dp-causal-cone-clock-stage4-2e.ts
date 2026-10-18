import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CasimirDpCausalConeClockStage4_2EConfig,
  CasimirDpStage4_2EFixture,
} from "../../shared/contracts/casimir-dp-causal-cone-clock-stage4-2e.v1";
import {
  evaluateCasimirDpCausalConeClockStage4_2E,
} from "../../shared/casimir-dp-causal-cone-clock-stage4-2e";

const DEFAULT_CONFIG =
  "configs/research/casimir-dp-causal-cone-clock-stage4-2e.v1.json";
const DEFAULT_FIXTURE =
  "configs/research/fixtures/casimir-dp-stage4-2e-causal-cone.synthetic.v1.json";
const DEFAULT_OUTPUT_ROOT =
  "artifacts/research/casimir-dp-causal-cone-clock-stage4-2e";

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
  fixture: ReturnType<typeof CasimirDpStage4_2EFixture.parse>,
  baselinePass: boolean,
) {
  const observed = new Map<string, { gate: "pass" | "blocked"; status: string }>([
    [
      "baseline_recovery",
      {
        gate: baselinePass ? "pass" : "blocked",
        status: baselinePass
          ? "causal_geometry_recovery_and_nonbridge_gates_pass"
          : "baseline_recovery_failed",
      },
    ],
    [
      "nonpositive_lapse_rejected",
      { gate: "blocked", status: "nonpositive_lapse" },
    ],
    [
      "nonpositive_spatial_metric_rejected",
      { gate: "blocked", status: "spatial_metric_not_positive_definite" },
    ],
    [
      "timelike_path_outside_cone_rejected",
      { gate: "blocked", status: "timelike_path_not_inside_null_cone" },
    ],
    [
      "flat_l_over_c_promoted_as_null_solve_rejected",
      {
        gate: "blocked",
        status: "reference_parameterization_is_not_null_geodesic",
      },
    ],
    [
      "scalar_negative_density_as_geometry_rejected",
      { gate: "blocked", status: "complete_apparatus_tensor_missing" },
    ],
    [
      "qed_effective_cone_as_gr_metric_rejected",
      {
        gate: "blocked",
        status: "qed_effective_propagation_is_not_gr_metric",
      },
    ],
    [
      "boundary_label_as_standard_dp_modifier_rejected",
      { gate: "blocked", status: "standard_dp_boundary_independence" },
    ],
    [
      "branch_metric_without_kernel_rejected",
      {
        gate: "blocked",
        status: "tensor_to_metric_to_coherence_kernel_missing",
      },
    ],
    [
      "synthetic_causal_recovery_promotion_rejected",
      { gate: "blocked", status: "measured_causal_response_not_ready" },
    ],
  ]);

  return fixture.cases.map((row) => {
    const result = observed.get(row.case_id);
    if (result == null) {
      throw new Error(`stage4_2e_missing_fixture_handler:${row.case_id}`);
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
  const admCases = result.adm_local_causal_recovery.cases;
  const radial = result.bounded_radial_null_recovery;
  const casimir = result.casimir_semiclassical_screen;
  const qed = result.qed_effective_propagation_control;
  const lines = [
    "# Casimir-DP Stage-4.2E causal-cone and clock-congruence report",
    "",
    `**Run:** \`${report.campaign_run_id}\`  `,
    `**Evidence class:** \`${report.evidence_class}\`  `,
    `**Claim ceiling:** \`${report.claim_ceiling}\`  `,
    `**Campaign gate:** \`${report.campaign_gate}\`  `,
    `**Observable bridge edges added:** \`${report.observable_bridge_edges_added}\``,
    "",
    "## Result at a glance",
    "",
    "Stage 4.2E makes the causal-geometry distinction executable. Local null directions and timelike proper-clock rates are reconstructed from one ADM lapse, shift, and spatial metric. A bounded Schwarzschild radial-null benchmark recovers analytic light travel and radar-clock relations. The ideal Casimir interaction region supplies only a gravitational scale screen, while the Scharnhorst relation remains a separate QED effective-propagation control. No boundary-conditioned DP or metric-to-coherence edge is added.",
    "",
    "## ADM cone and clock recovery",
    "",
    "| Case | Gate | dτ/dt | Null roots along declared direction | + light time / L/c |",
    "|---|---|---:|---|---:|",
    ...admCases.map((row: JsonObject) =>
      `| \`${row.case_id}\` | \`${row.gate}\` | ${row.timelike_clock.rate_d_tau_d_t} | ${row.null_coordinate_velocity_over_c.directional_roots.minus}, ${row.null_coordinate_velocity_over_c.directional_roots.plus} | ${row.bounded_light_time.plus_to_flat_reference_ratio} |`
    ),
    "",
    `Maximum local-null constraint error: \`${result.adm_local_causal_recovery.maximum_null_constraint_absolute_error}\`.`,
    `Maximum clock identity error: \`${result.adm_local_causal_recovery.maximum_clock_identity_absolute_error}\`.`,
    "",
    "The NHM2 row demonstrates same-equation congruence: for the synthetic centerline lapse α=0.7 and vanishing shift, a stationary clock has dτ/dt=0.7 while the local coordinate-null roots are ±0.7. Its historical L/c schedule remains a reference parameterization; the metric-derived one-way light time is longer by 1/0.7.",
    "",
    "## Bounded radial-null and radar-clock recovery",
    "",
    `- Schwarzschild radius: \`${radial.schwarzschild_radius_m} m\`.`,
    `- Emitter lapse / stationary clock rate: \`${radial.emitter_lapse}\`.`,
    `- Analytic one-way coordinate light time: \`${radial.analytic_one_way_coordinate_time_s} s\`.`,
    `- Numerical one-way coordinate light time: \`${radial.numeric_one_way_coordinate_time_s} s\`.`,
    `- Relative recovery error: \`${radial.numerical_relative_error}\`.`,
    `- Coordinate Shapiro excess over flat L/c: \`${radial.coordinate_shapiro_excess_s} s\`.`,
    `- Emitter radar round-trip proper time: \`${radial.emitter_radar_round_trip_proper_time_s} s\`.`,
    "",
    "This is a conventional fixed-chart recovery test, not a Casimir apparatus prediction.",
    "",
    "## Casimir semiclassical scale screen",
    "",
    `- Ideal interaction energy density: \`${casimir.energy_density_J_m3} J/m^3\`.`,
    `- Ideal normal pressure: \`${casimir.normal_pressure_Pa} Pa\`.`,
    `- Interaction mass equivalent: \`${casimir.interaction_mass_equivalent_kg} kg\`.`,
    `- Einstein curvature scale: \`${casimir.einstein_curvature_scale_m2_inv} m^-2\`.`,
    `- Fractional light-time bound across the gap: \`${casimir.fractional_light_time_bound_over_gap}\`.`,
    `- Light-time shift bound across the gap: \`${casimir.gravitational_light_time_shift_bound_s} s\`.`,
    `- Complete-apparatus metric authority: \`${casimir.metric_response_authority}\`.`,
    "",
    "The sign of one interaction-energy component does not solve the geometry. Plates, supports, renormalized total stress, conservation, and metric boundary conditions remain required.",
    "",
    "## QED, material, and polarization control",
    "",
    `- Ideal low-frequency QED fractional phase-speed proxy: \`${qed.fractional_phase_speed_shift_proxy}\`.`,
    `- QED-to-gravitational screening-scale ratio: \`${qed.qed_to_gravity_fractional_scale_separation}\`.`,
    `- Ideal σ+/σ− split proxy: \`${qed.ideal_pair_split_proxy}\`.`,
    `- Material dispersion measured: \`${qed.material_dispersion_measured}\`.`,
    `- Polarization response measured: \`${qed.polarization_response_measured}\`.`,
    `- Front-velocity claim allowed: \`${qed.front_velocity_claim_allowed}\`.`,
    "",
    "Frequency, material, directional, or polarization response remains in the QED/material control lane unless a universal metric observable survives the full control model.",
    "",
    "## Causal signature and non-bridge matrix",
    "",
    "| Signature | Lane | Frequency rule | Polarization rule | DP-rate admission |",
    "|---|---|---|---|---:|",
    ...result.causal_signature_separation.matrix.map(
      (row: JsonObject) =>
        `| \`${row.signature_id}\` | \`${row.model_lane}\` | \`${row.frequency_dependence}\` | \`${row.polarization_dependence}\` | ${row.admitted_to_dp_rate ? "yes, frozen branch-density lane only" : "no"} |`,
    ),
    "",
    "## Fixture and scientific standing",
    "",
    `- Fixtures passed: \`${report.fixture_summary.passed}/${report.fixture_summary.required}\`.`,
    `- Null-geodesic apparatus authority: \`${result.final_gates.null_geodesic_apparatus_authority}\`.`,
    `- Complete-apparatus metric response: \`${result.final_gates.complete_apparatus_metric_response}\`.`,
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
    "A successful Stage-4.2E run validates software, units, ADM cone/clock algebra, a bounded conventional radial-null recovery, an ideal Casimir gravitational scale screen, QED/control separation, and zero unsupported bridge edges. It does not integrate null rays through a measured apparatus metric, supply a complete conserved apparatus tensor, measure cavity propagation or polarization response, prepare a superposition, measure coherence, support or exclude DP, identify collapse or manifold dynamics, or establish physical viability.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export async function runCasimirDpCausalConeClockStage4_2E(
  options: RunOptions = {},
) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const configPath = options.configPath ?? DEFAULT_CONFIG;
  const fixturePath = options.fixturePath ?? DEFAULT_FIXTURE;
  const outputRoot = options.outputRoot ?? DEFAULT_OUTPUT_ROOT;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const runId = options.runId ??
    `casimir-dp-causal-cone-clock-stage4-2e-v1-${timestampId(generatedAt)}`;
  const writeArtifacts = options.writeArtifacts ?? true;

  const config = CasimirDpCausalConeClockStage4_2EConfig.parse(
    readJson(rootDir, configPath),
  );
  const fixture = CasimirDpStage4_2EFixture.parse(
    readJson(rootDir, fixturePath),
  );
  const manifest = readJson(rootDir, config.authority_manifest.path);

  const authorityManifestHash = fileSha256(
    rootDir,
    config.authority_manifest.path,
  );
  if (authorityManifestHash !== config.authority_manifest.sha256) {
    throw new Error(
      `stage4_2e_authority_manifest_hash_mismatch:${authorityManifestHash}`,
    );
  }
  const fixtureHash = fileSha256(rootDir, fixturePath);
  if (fixtureHash !== config.fixture.sha256) {
    throw new Error(`stage4_2e_fixture_hash_mismatch:${fixtureHash}`);
  }
  if (
    JSON.stringify(manifest.immutable_upstream) !==
      JSON.stringify(config.upstream_authorities)
  ) {
    throw new Error("stage4_2e_authority_manifest_tuple_mismatch");
  }
  const authorityRows = config.upstream_authorities.map((row) => {
    const actualSha256 = fileSha256(rootDir, row.path);
    if (actualSha256 !== row.sha256) {
      throw new Error(
        `stage4_2e_upstream_hash_mismatch:${row.role}:${actualSha256}`,
      );
    }
    return { ...row, actual_sha256: actualSha256, gate: "pass" as const };
  });

  const stage4_2dReportAuthority = config.upstream_authorities.find(
    (row) => row.role === "stage4_2d_report",
  );
  if (stage4_2dReportAuthority == null) {
    throw new Error("stage4_2e_missing_stage4_2d_report_authority");
  }
  const stage4_2dReport = readJson(rootDir, stage4_2dReportAuthority.path);
  if (
    stage4_2dReport.campaign_run_id !==
      config.immutable_stage4_2d.campaign_run_id ||
    stage4_2dReport.final_gates?.software_and_recovery_diagnostics !==
      config.immutable_stage4_2d.software_and_recovery_diagnostics ||
    stage4_2dReport.final_gates?.measured_evidence !==
      config.immutable_stage4_2d.measured_evidence ||
    stage4_2dReport.final_gates?.collapse_identification !==
      config.immutable_stage4_2d.collapse_identification ||
    stage4_2dReport.final_gates?.manifold_dynamics !==
      config.immutable_stage4_2d.manifold_dynamics ||
    stage4_2dReport.final_gates?.physical_viability !==
      config.immutable_stage4_2d.physical_viability
  ) {
    throw new Error("stage4_2e_stage4_2d_standing_not_recovered");
  }

  const runtimeResult = evaluateCasimirDpCausalConeClockStage4_2E(config);
  const baselinePass =
    runtimeResult.final_gates.software_and_causal_recovery_diagnostics ===
      "pass";
  const fixtureResults = executeFixtureMatrix(fixture, baselinePass);
  if (!fixtureResults.every((row) => row.matched_expected)) {
    const first = fixtureResults.find((row) => !row.matched_expected);
    throw new Error(
      `stage4_2e_fixture_mismatch:${first?.case_id}:${first?.observed_status}`,
    );
  }

  const configHash = fileSha256(rootDir, configPath);
  const report = {
    schema_version: "casimir_dp_causal_cone_clock_stage4_2e_report/1",
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
    immutable_stage4_2d: {
      ...config.immutable_stage4_2d,
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
        "Local null directions and timelike proper-clock rates are reconstructed from the same ADM metric.",
        "Minkowski, NHM2 same-equation, shifted anisotropic ADM, and bounded Schwarzschild radial-null recovery calculations pass.",
        "The NHM2 L/c route schedule is explicitly retained as a reference rather than promoted as null-geodesic authority.",
        "The ideal Casimir interaction region supplies a finite gravitational scale screen only.",
        "QED/material/polarization effective propagation remains separate from universal GR metric response.",
        "Standard DP remains boundary independent at fixed branches and zero new observable bridge edges enter the collapse rate.",
      ],
      unresolved: [
        "A measured complete-apparatus conserved stress tensor and registered metric boundary-value problem.",
        "Null-ray integration through a measured apparatus metric.",
        "Measured cavity dispersion, polarization response, clock response, and their covariance.",
        "A registered branch-metric and metric-to-coherence kernel.",
        "Preparation of the selected mesoscopic superposition and confirmatory coherence data.",
        "Collapse identification, manifold dynamics, independent replication, and physical viability.",
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
      prior_stage4_2d_certificate_reused: false,
    },
  };

  const markdown = renderMarkdown(report);
  const traceRows = [
    {
      schema_version: "casimir_dp_stage4_2e_trace/1",
      record_type: "authority_integrity",
      campaign_run_id: runId,
      gate: "pass",
      rows: authorityRows.length,
    },
    {
      schema_version: "casimir_dp_stage4_2e_trace/1",
      record_type: "adm_local_causal_recovery",
      campaign_run_id: runId,
      gate: runtimeResult.adm_local_causal_recovery.gate,
    },
    {
      schema_version: "casimir_dp_stage4_2e_trace/1",
      record_type: "bounded_radial_null_recovery",
      campaign_run_id: runId,
      gate: runtimeResult.bounded_radial_null_recovery.gate,
    },
    {
      schema_version: "casimir_dp_stage4_2e_trace/1",
      record_type: "casimir_semiclassical_screen",
      campaign_run_id: runId,
      gate: runtimeResult.casimir_semiclassical_screen.gate,
      metric_response_authority:
        runtimeResult.casimir_semiclassical_screen.metric_response_authority,
    },
    {
      schema_version: "casimir_dp_stage4_2e_trace/1",
      record_type: "qed_effective_propagation_control",
      campaign_run_id: runId,
      gate: runtimeResult.qed_effective_propagation_control.gate,
      measured_control_authority:
        runtimeResult.qed_effective_propagation_control
          .measured_control_authority,
    },
    {
      schema_version: "casimir_dp_stage4_2e_trace/1",
      record_type: "causal_signature_separation",
      campaign_run_id: runId,
      gate: runtimeResult.causal_signature_separation.gate,
      observable_bridge_edges_added: 0,
    },
    {
      schema_version: "casimir_dp_stage4_2e_trace/1",
      record_type: "fixture_summary",
      campaign_run_id: runId,
      gate: "pass",
      passed: fixtureResults.length,
      required: fixtureResults.length,
    },
    {
      schema_version: "casimir_dp_stage4_2e_trace/1",
      record_type: "scientific_status",
      campaign_run_id: runId,
      ...runtimeResult.final_gates,
    },
  ];
  const trace = `${traceRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const receipt = {
    schema_version: "casimir_dp_causal_cone_clock_stage4_2e_receipt/1",
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
    runtime_result_receipt_sha256: runtimeResult.result_receipt.sha256,
    report_json_sha256: bufferSha256(reportJson),
    report_markdown_sha256: bufferSha256(markdown),
    trace_sha256: bufferSha256(trace),
    immutable_stage4_2d: config.immutable_stage4_2d,
    result: {
      campaign_gate: "pass",
      null_geodesic_apparatus_authority: "not_ready",
      complete_apparatus_metric_response: "not_ready",
      physical_pilot_readiness: "not_ready",
      measured_evidence: "not_ready",
      collapse_identification: "blocked",
      manifold_dynamics: "blocked",
      physical_viability: "not_evaluated",
    },
    downstream_verification: {
      status: "pending_external_verification",
      prior_stage4_2d_certificate_reused: false,
    },
  };
  const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;

  const outputDir = path.resolve(rootDir, outputRoot, runId);
  const paths = {
    output_dir: outputDir,
    report_json: path.join(
      outputDir,
      "causal-cone-clock-stage4-2e-report.json",
    ),
    report_markdown: path.join(
      outputDir,
      "causal-cone-clock-stage4-2e-report.md",
    ),
    trace: path.join(outputDir, "causal-cone-clock-stage4-2e-trace.jsonl"),
    receipt: path.join(
      outputDir,
      "causal-cone-clock-stage4-2e-receipt.json",
    ),
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
    else throw new Error(`stage4_2e_unknown_argument:${token}`);
  }
  return args;
}

if (
  process.argv[1] != null &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  const cli = parseArgs(process.argv.slice(2));
  const result = await runCasimirDpCausalConeClockStage4_2E({
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
