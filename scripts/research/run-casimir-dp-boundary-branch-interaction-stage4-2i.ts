import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateCasimirDpBoundaryBranchInteractionStage4_2I,
} from "../../shared/casimir-dp-boundary-branch-interaction-stage4-2i";
import {
  CasimirDpBoundaryBranchFixtureStage4_2I,
  CasimirDpBoundaryBranchInteractionStage4_2IConfig,
  type CasimirDpBoundaryBranchFixtureStage4_2I as Stage4IFixture,
} from "../../shared/contracts/casimir-dp-boundary-branch-interaction-stage4-2i.v1";

const DEFAULT_CONFIG =
  "configs/research/casimir-dp-boundary-branch-interaction-stage4-2i.v1.json";
const DEFAULT_OUTPUT_ROOT =
  "artifacts/research/casimir-dp-boundary-branch-interaction-stage4-2i";

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
  return JSON.parse(
    readFileSync(path.resolve(rootDir, relativePath), "utf8"),
  ) as JsonObject;
}

function timestampId(iso: string): string {
  return iso.replace(/[-:.]/g, "").replace("Z", "Z");
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function applyComplexFactor(
  value: { re: number; im: number },
  lossExponent: number,
  phaseRad: number,
) {
  const amplitude = Math.exp(-lossExponent);
  const factor = {
    re: amplitude * Math.cos(phaseRad),
    im: amplitude * Math.sin(phaseRad),
  };
  return {
    re: value.re * factor.re - value.im * factor.im,
    im: value.re * factor.im + value.im * factor.re,
  };
}

function buildAdversarialCases(
  fixture: Stage4IFixture,
  config: ReturnType<
    typeof CasimirDpBoundaryBranchInteractionStage4_2IConfig.parse
  >,
) {
  const injected = deepClone(fixture);
  injected.fixture_id = "stage4_2i_injected_interaction_recovery";
  injected.expected_case = "injected_boundary_branch_interaction";
  injected.observed_cells[3].coherence_t = applyComplexFactor(
    injected.observed_cells[3].coherence_t,
    0.002,
    0.004,
  );
  const injectedResult =
    evaluateCasimirDpBoundaryBranchInteractionStage4_2I({
      config,
      fixture: injected,
    });

  const coverage = deepClone(fixture);
  coverage.fixture_id = "stage4_2i_low_coherence_raw_complex_fallback";
  coverage.expected_case = "coverage_failure_raw_complex_only";
  coverage.observed_cells[3].coherence_t = { re: 1e-4, im: 0 };
  const coverageResult =
    evaluateCasimirDpBoundaryBranchInteractionStage4_2I({
      config,
      fixture: coverage,
    });

  const wavepacketMismatch = deepClone(fixture);
  wavepacketMismatch.fixture_id = "stage4_2i_wavepacket_equivalence_failure";
  wavepacketMismatch.wavepacket_states[3].center_b_m[0] += 1e-8;
  const wavepacketMismatchResult =
    evaluateCasimirDpBoundaryBranchInteractionStage4_2I({
      config,
      fixture: wavepacketMismatch,
    });

  const covarianceFailure = deepClone(fixture);
  covarianceFailure.fixture_id = "stage4_2i_nonpositive_covariance_failure";
  covarianceFailure.joint_observed_ordinary_covariance[0][0] = -1e-8;
  const covarianceFailureResult =
    evaluateCasimirDpBoundaryBranchInteractionStage4_2I({
      config,
      fixture: covarianceFailure,
    });

  const dpBoundaryMismatch = deepClone(fixture);
  dpBoundaryMismatch.fixture_id = "stage4_2i_boundary_dependent_dp_rejected";
  dpBoundaryMismatch.dp_loss_exponent_by_boundary.active += 1e-4;
  const dpBoundaryMismatchResult =
    evaluateCasimirDpBoundaryBranchInteractionStage4_2I({
      config,
      fixture: dpBoundaryMismatch,
    });

  return [
    {
      case_id: "injected_interaction_recovery",
      gate:
        injectedResult.outcome.interaction_resolved_in_synthetic_case &&
          Math.abs(
              (injectedResult.cross_ratio_interaction
                .corrected_log_visibility_interaction ?? 0) - 0.002,
            ) <= 1e-12 &&
          Math.abs(
              (injectedResult.cross_ratio_interaction
                .corrected_phase_interaction_rad ?? 0) - 0.004,
            ) <= 1e-12
          ? "pass"
          : "fail",
      expected: { amplitude: 0.002, phase_rad: 0.004 },
      recovered: {
        amplitude:
          injectedResult.cross_ratio_interaction
            .corrected_log_visibility_interaction,
        phase_rad:
          injectedResult.cross_ratio_interaction
            .corrected_phase_interaction_rad,
      },
      empirical_authority: false,
    },
    {
      case_id: "low_coherence_raw_complex_fallback",
      gate:
        coverageResult.cross_ratio_interaction.coverage_gate ===
            "raw_complex_only" &&
          coverageResult.cross_ratio_interaction.corrected_ratio === null
          ? "pass"
          : "fail",
      recovered:
        coverageResult.cross_ratio_interaction.coverage_gate,
      empirical_authority: false,
    },
    {
      case_id: "wavepacket_equivalence_failure",
      gate:
        wavepacketMismatchResult.wavepacket_custody.gate === "blocked" &&
          wavepacketMismatchResult.outcome.diagnostic_gate === "blocked"
          ? "pass"
          : "fail",
      recovered: wavepacketMismatchResult.wavepacket_custody.gate,
      empirical_authority: false,
    },
    {
      case_id: "nonpositive_covariance_failure",
      gate:
        covarianceFailureResult.covariance_gate.gate === "blocked" &&
          covarianceFailureResult.outcome.diagnostic_gate === "blocked"
          ? "pass"
          : "fail",
      recovered: covarianceFailureResult.covariance_gate.gate,
      empirical_authority: false,
    },
    {
      case_id: "boundary_dependent_dp_rejected",
      gate:
        dpBoundaryMismatchResult.standard_dp_boundary_null.gate ===
            "blocked" &&
          dpBoundaryMismatchResult.outcome.diagnostic_gate === "blocked"
          ? "pass"
          : "fail",
      recovered: dpBoundaryMismatchResult.standard_dp_boundary_null.gate,
      empirical_authority: false,
    },
  ] as const;
}

function renderMarkdown(report: JsonObject): string {
  const nominal = report.nominal_synthetic_result;
  const cross = nominal.cross_ratio_interaction;
  const lines = [
    "# Casimir-DP Stage-4.2I boundary-branch interaction and wave-packet-custody report",
    "",
    `**Run:** \`${report.campaign_run_id}\`  `,
    `**Evidence class:** \`${report.evidence_class}\`  `,
    `**Claim ceiling:** \`${report.claim_ceiling}\`  `,
    `**Campaign gate:** \`${report.campaign_gate}\`  `,
    "**Observable bridge edges added:** `0`",
    "",
    "## Result at a glance",
    "",
    "Stage 4.2I makes the boundary-superposition interaction explicit without changing the frozen Diósi law. It freezes a true identical-branch control and a separated-branch cell under reference and active boundary states, computes their normalized complex cross-ratio, subtracts the registered ordinary-physics interaction, and propagates the full observed/predicted complex covariance. The maintained fixture is synthetic and contains boundary-independent DP only, so its corrected interaction is null within numerical precision.",
    "",
    "## Four-cell observable",
    "",
    "The frozen order is `reference/control`, `reference/separated`, `active/control`, `active/separated`. With normalized complex coherence `Cbar_beta,q=C_beta,q(t)/C_beta,q(0)`,",
    "",
    "```text",
    "R_x = (Cbar_11 Cbar_00)/(Cbar_01 Cbar_10)",
    "I_x = -ln|R_x|",
    "Phi_x = arg(R_x)",
    "R_x,corr = R_x,observed / R_x,H0",
    "```",
    "",
    "A nonzero corrected result is a boundary-branch nonfactorization diagnostic. Its first consequence is to challenge the ordinary-physics null or complete-joint-system equivalence; it is not a collapse or Casimir-to-collapse identification.",
    "",
    "## Nominal synthetic boundary-independent DP recovery",
    "",
    `- DP boundary-exponent difference: \`${nominal.standard_dp_boundary_null.absolute_difference}\`; gate \`${nominal.standard_dp_boundary_null.gate}\`.`,
    `- Corrected log-visibility interaction: \`${cross.corrected_log_visibility_interaction}\`.`,
    `- Corrected phase interaction: \`${cross.corrected_phase_interaction_rad} rad\`.`,
    `- Maximum absolute interaction z: \`${nominal.outcome.maximum_absolute_z}\`.`,
    `- Interaction resolved: \`${nominal.outcome.interaction_resolved_in_synthetic_case}\`.`,
    `- Factorial/GLS special-case recovery: \`${nominal.factorial_projection_recovery?.gate}\`, absolute difference \`${nominal.factorial_projection_recovery?.absolute_difference}\`.`,
    "",
    "The raw linear complex contrast is retained as a coverage-safe diagnostic, but multiplicative main effects need not cancel from that additive contrast. The complex cross-ratio is the primary four-cell nonfactorization statistic.",
    "",
    "## Wave-packet custody",
    "",
    `- Structured packet gate: \`${nominal.wavepacket_custody.gate}\`.`,
    `- Branch-control separation: \`${nominal.wavepacket_custody.control_separation_max_m} m\`.`,
    `- Separated-branch distances: \`${nominal.wavepacket_custody.separated_distances_m.join(", ")} m\`.`,
    `- Synthetic center-of-mass packet width: \`${nominal.wavepacket_custody.sigma_cm_m[0].sigma_a_m} m\`.`,
    `- Empirical wave-packet authority: \`${nominal.wavepacket_custody.empirical_authority}\`.`,
    "",
    "The physical sphere radius, DP regularization length, and center-of-mass wave-packet width are separate model objects. A future measured packet must provide centers, covariance matrices, overlap, separation uncertainty, hold jitter, momentum difference, preparation fidelity, trajectory provenance, and tomography hashes in both boundary states.",
    "",
    "## Adversarial recovery",
    "",
    ...report.adversarial_cases.map(
      (row: JsonObject) =>
        `- \`${row.case_id}\`: \`${row.gate}\`; empirical authority \`false\`.`,
    ),
    "",
    "## Current scientific standing",
    "",
    ...Object.entries(report.final_gates).map(
      ([key, value]) => `- \`${key}\`: \`${value}\`.`,
    ),
    "",
    "The software result does not supply a measured branch-control cell, measured wave-packet equivalence, measured ordinary interaction model, measured complex coherence, or a boundary-to-collapse transfer kernel. Standard boundary-independent DP cancels from this interaction statistic and remains a separate mass-separation-hold-time hypothesis.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export async function runCasimirDpBoundaryBranchInteractionStage4_2I(
  options: RunOptions = {},
) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const configPath = options.configPath ?? DEFAULT_CONFIG;
  const outputRoot = options.outputRoot ?? DEFAULT_OUTPUT_ROOT;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const runId = options.runId ??
    `casimir-dp-boundary-branch-interaction-stage4-2i-v1-${timestampId(generatedAt)}`;
  const writeArtifacts = options.writeArtifacts ?? true;
  const config = CasimirDpBoundaryBranchInteractionStage4_2IConfig.parse(
    readJson(rootDir, configPath),
  );
  const manifest = readJson(rootDir, config.authority_manifest.path);
  const manifestHash = fileSha256(rootDir, config.authority_manifest.path);
  if (manifestHash !== config.authority_manifest.sha256) {
    throw new Error(`stage4_2i_authority_manifest_hash_mismatch:${manifestHash}`);
  }
  if (
    JSON.stringify(manifest.immutable_upstream) !==
      JSON.stringify(config.upstream_authorities) ||
    JSON.stringify(manifest.method_authorities) !==
      JSON.stringify(config.method_authorities)
  ) {
    throw new Error("stage4_2i_authority_manifest_tuple_mismatch");
  }
  const authorityRows = [
    ...config.upstream_authorities,
    ...config.method_authorities,
  ].map((row) => {
    const actualSha256 = fileSha256(rootDir, row.path);
    if (actualSha256 !== row.sha256) {
      throw new Error(
        `stage4_2i_authority_hash_mismatch:${row.role}:${actualSha256}`,
      );
    }
    return { ...row, actual_sha256: actualSha256, gate: "pass" as const };
  });
  const stage4hReportAuthority = config.upstream_authorities.find(
    (row) => row.role === "stage4_2h_report",
  );
  if (stage4hReportAuthority == null) {
    throw new Error("stage4_2i_stage4_2h_report_authority_missing");
  }
  const stage4hReport = readJson(rootDir, stage4hReportAuthority.path);
  if (
    stage4hReport.campaign_run_id !==
      config.immutable_stage4_2h.campaign_run_id ||
    stage4hReport.final_gates?.measured_evidence !==
      config.immutable_stage4_2h.measured_evidence ||
    stage4hReport.final_gates?.collapse_identification !==
      config.immutable_stage4_2h.collapse_identification ||
    stage4hReport.final_gates?.manifold_dynamics !==
      config.immutable_stage4_2h.manifold_dynamics ||
    stage4hReport.final_gates?.physical_viability !==
      config.immutable_stage4_2h.physical_viability
  ) {
    throw new Error("stage4_2i_stage4_2h_standing_not_recovered");
  }
  const fixtureHash = fileSha256(rootDir, config.fixture.path);
  if (fixtureHash !== config.fixture.sha256) {
    throw new Error(`stage4_2i_fixture_hash_mismatch:${fixtureHash}`);
  }
  const fixture = CasimirDpBoundaryBranchFixtureStage4_2I.parse(
    readJson(rootDir, config.fixture.path),
  );
  const nominalResult =
    evaluateCasimirDpBoundaryBranchInteractionStage4_2I({ config, fixture });
  if (
    nominalResult.outcome.diagnostic_gate !== "pass" ||
    nominalResult.outcome.interaction_resolved_in_synthetic_case ||
    nominalResult.standard_dp_boundary_null.gate !== "pass" ||
    nominalResult.hypothesis_separation.observable_bridge_edges_added !== 0
  ) {
    throw new Error("stage4_2i_nominal_nonpromotion_recovery_failed");
  }
  const adversarialCases = buildAdversarialCases(fixture, config);
  if (adversarialCases.some((row) => row.gate !== "pass")) {
    throw new Error("stage4_2i_adversarial_recovery_failed");
  }
  const configHash = fileSha256(rootDir, configPath);
  const report = {
    schema_version:
      "casimir_dp_boundary_branch_interaction_stage4_2i_report/1",
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
    immutable_stage4_2h: {
      ...config.immutable_stage4_2h,
      recovered: true,
    },
    authority_integrity: {
      gate: "pass" as const,
      manifest_sha256: manifestHash,
      rows: authorityRows,
    },
    nominal_synthetic_result: nominalResult,
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
        "shared/contracts/casimir-dp-boundary-branch-interaction-stage4-2i.v1.ts",
      ),
      runtime_sha256: fileSha256(
        rootDir,
        "shared/casimir-dp-boundary-branch-interaction-stage4-2i.ts",
      ),
      runner_sha256: fileSha256(
        rootDir,
        "scripts/research/run-casimir-dp-boundary-branch-interaction-stage4-2i.ts",
      ),
    },
    fresh_casimir_verification: {
      status: "pending_external_verification" as const,
      prior_stage4_2h_certificate_reused: false,
      scientific_scope: "none" as const,
    },
  };
  const markdown = renderMarkdown(report);
  const traceRows = [
    {
      schema_version: "casimir_dp_stage4_2i_trace/1",
      record_type: "authority_integrity",
      campaign_run_id: runId,
      gate: "pass",
      authorities: authorityRows.length,
    },
    {
      schema_version: "casimir_dp_stage4_2i_trace/1",
      record_type: "nominal_factorial_recovery",
      campaign_run_id: runId,
      diagnostic_gate: nominalResult.outcome.diagnostic_gate,
      interaction_resolved:
        nominalResult.outcome.interaction_resolved_in_synthetic_case,
      standard_dp_boundary_null:
        nominalResult.standard_dp_boundary_null.gate,
      measured_evidence: "not_ready",
    },
    ...adversarialCases.map((row) => ({
      schema_version: "casimir_dp_stage4_2i_trace/1",
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
    schema_version:
      "casimir_dp_boundary_branch_interaction_stage4_2i_receipt/1",
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
    immutable_stage4_2h: config.immutable_stage4_2h,
    result: config.final_status_policy,
    downstream_verification: {
      status: "pending_external_verification",
      prior_stage4_2h_certificate_reused: false,
    },
  };
  const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;
  const outputDir = path.resolve(rootDir, outputRoot, runId);
  const paths = {
    output_dir: outputDir,
    report_json: path.join(
      outputDir,
      "boundary-branch-interaction-stage4-2i-report.json",
    ),
    report_markdown: path.join(
      outputDir,
      "boundary-branch-interaction-stage4-2i-report.md",
    ),
    trace: path.join(
      outputDir,
      "boundary-branch-interaction-stage4-2i-trace.jsonl",
    ),
    receipt: path.join(
      outputDir,
      "boundary-branch-interaction-stage4-2i-receipt.json",
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
      report_json_sha256: textSha256(reportJson),
      report_markdown_sha256: textSha256(markdown),
      trace_sha256: textSha256(trace),
      receipt_sha256: textSha256(receiptJson),
    },
  };
}

type CliArgs = {
  config?: string;
  outputRoot?: string;
  reportDoc?: string;
  runId?: string;
  generatedAt?: string;
  noWrite: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { noWrite: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--config") args.config = argv[++index];
    else if (token === "--output-root") args.outputRoot = argv[++index];
    else if (token === "--report-doc") args.reportDoc = argv[++index];
    else if (token === "--run-id") args.runId = argv[++index];
    else if (token === "--generated-at") args.generatedAt = argv[++index];
    else if (token === "--no-write") args.noWrite = true;
    else throw new Error(`stage4_2i_unknown_argument:${token}`);
  }
  return args;
}

if (
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = parseArgs(process.argv.slice(2));
  runCasimirDpBoundaryBranchInteractionStage4_2I({
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
