import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CasimirDpEmpiricalFeasibilityPilotStage4_2GConfig,
  CasimirDpEmpiricalPilotPacketStage4_2G,
} from "../../shared/contracts/casimir-dp-empirical-feasibility-pilot-stage4-2g.v1";
import {
  evaluateCasimirDpEmpiricalFeasibilityPilotStage4_2G,
} from "../../shared/casimir-dp-empirical-feasibility-pilot-stage4-2g";

const DEFAULT_CONFIG =
  "configs/research/casimir-dp-empirical-feasibility-pilot-stage4-2g.v1.json";
const DEFAULT_OUTPUT_ROOT =
  "artifacts/research/casimir-dp-empirical-feasibility-pilot-stage4-2g";

type JsonObject = Record<string, any>;

type RunOptions = {
  rootDir?: string;
  configPath?: string;
  packetPath?: string;
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

function verifyMeasuredPacketArtifacts(
  rootDir: string,
  packet: ReturnType<typeof CasimirDpEmpiricalPilotPacketStage4_2G.parse>,
) {
  if (packet.evidence_class !== "measured_empirical_packet") {
    return {
      gate: "not_applicable" as const,
      checked: 0,
      rows: [],
    };
  }
  const rows = packet.products.map((product) => {
    if (
      product.authority_class !== "measured_empirical" &&
      product.authority_class !== "registered_protocol"
    ) {
      return {
        product_id: product.product_id,
        gate: "blocked" as const,
        reason: "measured_packet_contains_unbound_product",
      };
    }
    const artifactRef = product.artifact_ref;
    if (
      artifactRef == null ||
      artifactRef.startsWith("synthetic://") ||
      artifactRef.startsWith("unacquired://") ||
      path.isAbsolute(artifactRef)
    ) {
      return {
        product_id: product.product_id,
        gate: "blocked" as const,
        reason: "artifact_ref_must_be_repo_relative_and_non_synthetic",
      };
    }
    const resolved = path.resolve(rootDir, artifactRef);
    const insideRoot =
      resolved === rootDir ||
      resolved.startsWith(`${rootDir}${path.sep}`);
    if (!insideRoot || !existsSync(resolved)) {
      return {
        product_id: product.product_id,
        gate: "blocked" as const,
        reason: insideRoot
          ? "artifact_missing"
          : "artifact_outside_repository",
      };
    }
    const actualSha256 = fileSha256(rootDir, artifactRef);
    return {
      product_id: product.product_id,
      artifact_ref: artifactRef,
      expected_sha256: product.artifact_sha256,
      actual_sha256: actualSha256,
      gate:
        actualSha256 === product.artifact_sha256
          ? "pass" as const
          : "blocked" as const,
      reason:
        actualSha256 === product.artifact_sha256
          ? null
          : "artifact_hash_mismatch",
    };
  });
  return {
    gate:
      rows.every((row) => row.gate === "pass")
        ? "pass" as const
        : "blocked" as const,
    checked: rows.length,
    rows,
  };
}

function renderMarkdown(report: JsonObject): string {
  const current = report.current_packet_result;
  const dp = current.named_dp_prediction;
  const companion = current.companion_detection_requirement;
  const synthetic = report.synthetic_ingestion_validation;
  const identity = current.apparatus_design_identity.identity;
  const lines = [
    "# Casimir-DP Stage-4.2G empirical-feasibility pilot report",
    "",
    `**Run:** \`${report.campaign_run_id}\`  `,
    `**Evidence class:** \`${report.evidence_class}\`  `,
    `**Claim ceiling:** \`${report.claim_ceiling}\`  `,
    `**Campaign gate:** \`${report.campaign_gate}\`  `,
    `**Current packet:** \`${report.current_packet.packet_id}\` (\`${report.current_packet.evidence_class}\`)  `,
    `**Observable bridge edges added:** \`0\``,
    "",
    "## Decision",
    "",
    "The software and acquisition contract is ready; the empirical pilot is not. Stage 4.2G freezes one apparatus design, regenerates the registered DP coherence and heating predictions from exactly that mass-density identity, validates a fail-closed packet ingestion path, and states the laboratory receipts required for a pilot go/no-go. No measured packet was supplied to this authoritative run.",
    "",
    "## Frozen single-apparatus identity",
    "",
    `- Identity: \`${identity.identity_id}\`.`,
    `- Material/geometry: \`${identity.material_id}\` \`${identity.geometry}\`.`,
    `- Radius: \`${identity.radius_m} m\`.`,
    `- Mass: \`${identity.mass_kg} kg\`.`,
    `- Branch separation: \`${identity.branch_separation_m} m\`.`,
    `- Hold time: \`${identity.hold_time_s} s\`.`,
    `- Cavity gap and modulation: \`${identity.cavity_gap_m} m\`, \`${identity.boundary_modulation_Hz} Hz\`.`,
    "",
    "This is a design freeze, not evidence that the object, cavity, or superposition has been built.",
    "",
    "## Internally consistent named-DP prediction",
    "",
    `- Model: \`${dp.model_id}\`.`,
    `- Registered sensitivity point: \(r_0=${dp.R0_m} m\), authority \`${dp.R0_authority}\`.`,
    `- \(E_G=${dp.E_G_J} J\).`,
    `- \u0393_DP = \`${dp.Gamma_DP_s} s^-1\`.`,
    `- \u03C4_DP = \`${dp.tau_DP_s} s\`.`,
    `- Visibility at 0.25 s: \`${dp.visibility_ratio}\`.`,
    `- Visibility loss: \`${dp.visibility_loss_fraction}\`.`,
    `- Heating companion: \`${dp.heating_W} W\`.`,
    `- Numerical/analytic cross-check: \`${dp.crosscheck_gate}\` (\`${dp.crosscheck_relative_error}\`).`,
    "",
    "The mass, separation, hold time, coherence prediction, momentum diffusion, and heating companion now share one parameter manifest. No Maxwell, polarization, cavity, Compton, Higgs, blackbody, or light-cone frequency enters the registered DP generator.",
    "",
    "## Companion detector requirement",
    "",
    `For \`${companion.independent_samples}\` independent samples and target SNR \`${companion.minimum_snr}\`, the one-shot standard uncertainty must be no larger than \`${companion.maximum_one_shot_standard_uncertainty_for_target_snr_W} W\`. This is an instrument requirement, not demonstrated detector performance.`,
    "",
    "## Packet and recomputation result",
    "",
    `- Unacquired packet identifiability: \`${current.packet_audit.identifiability_gate}\`.`,
    `- Synthetic ingestion identifiability: \`${synthetic.packet_audit.identifiability_gate}\`.`,
    `- Synthetic maximum whitened cosine: \`${synthetic.packet_audit.identifiability?.maximum_abs_whitened_cosine}\`.`,
    `- Synthetic normalized Gram condition: \`${synthetic.packet_audit.identifiability?.normalized_gram_condition_number}\`.`,
    `- Synthetic forecast power: \`${synthetic.packet_audit.identifiability?.achieved_dp_power}\`.`,
    "",
    "The synthetic packet tests the parser, whitening-space gate recomputation, power calculation, and failure boundaries only. It is not apparatus response, covariance, detector sensitivity, or measured evidence.",
    "",
    "## Acquisition products required before pilot go/no-go",
    "",
    ...report.required_products.map(
      (row: JsonObject) =>
        `- \`${row.product_id}\`: \`${row.current_authority}\`.`,
    ),
    "",
    "The complete conserved apparatus stress-energy product is separately required for a manifold/metric-response interpretation. It is not required to ask the narrower, nonrelativistic registered-DP coherence question.",
    "",
    "## Current scientific standing",
    "",
    ...Object.entries(report.final_gates).map(
      ([key, value]) => `- \`${key}\`: \`${value}\`.`,
    ),
    "",
    "A measured pilot packet can make the apparatus inputs and pilot identifiability ready. It cannot by itself identify objective collapse: the blinded confirmatory campaign and independent replication remain subsequent evidence stages.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export async function runCasimirDpEmpiricalFeasibilityPilotStage4_2G(
  options: RunOptions = {},
) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const configPath = options.configPath ?? DEFAULT_CONFIG;
  const outputRoot = options.outputRoot ?? DEFAULT_OUTPUT_ROOT;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const runId = options.runId ??
    `casimir-dp-empirical-feasibility-pilot-stage4-2g-v1-${
      timestampId(generatedAt)
    }`;
  const writeArtifacts = options.writeArtifacts ?? true;
  const config =
    CasimirDpEmpiricalFeasibilityPilotStage4_2GConfig.parse(
      readJson(rootDir, configPath),
    );
  const packetPath =
    options.packetPath ?? config.packets.unacquired_template_path;
  const currentPacket = CasimirDpEmpiricalPilotPacketStage4_2G.parse(
    readJson(rootDir, packetPath),
  );
  const syntheticPacket = CasimirDpEmpiricalPilotPacketStage4_2G.parse(
    readJson(rootDir, config.packets.synthetic_validation_path),
  );

  const manifest = readJson(rootDir, config.authority_manifest.path);
  const manifestHash = fileSha256(
    rootDir,
    config.authority_manifest.path,
  );
  if (manifestHash !== config.authority_manifest.sha256) {
    throw new Error(
      `stage4_2g_authority_manifest_hash_mismatch:${manifestHash}`,
    );
  }
  if (
    JSON.stringify(manifest.immutable_upstream) !==
      JSON.stringify(config.upstream_authorities) ||
    JSON.stringify(manifest.method_authorities) !==
      JSON.stringify(config.method_authorities)
  ) {
    throw new Error("stage4_2g_authority_manifest_tuple_mismatch");
  }
  const authorityRows = [
    ...config.upstream_authorities,
    ...config.method_authorities,
  ].map((row) => {
    const actualSha256 = fileSha256(rootDir, row.path);
    if (actualSha256 !== row.sha256) {
      throw new Error(
        `stage4_2g_authority_hash_mismatch:${row.role}:${actualSha256}`,
      );
    }
    return { ...row, actual_sha256: actualSha256, gate: "pass" as const };
  });

  const templateHash = fileSha256(
    rootDir,
    config.packets.unacquired_template_path,
  );
  const syntheticHash = fileSha256(
    rootDir,
    config.packets.synthetic_validation_path,
  );
  if (
    templateHash !== config.packets.unacquired_template_sha256 ||
    syntheticHash !== config.packets.synthetic_validation_sha256
  ) {
    throw new Error(
      "stage4_2g_packet_fixture_hash_mismatch",
    );
  }
  const currentPacketHash = fileSha256(rootDir, packetPath);
  const artifactIntegrity = verifyMeasuredPacketArtifacts(
    rootDir,
    currentPacket,
  );
  const currentResult =
    evaluateCasimirDpEmpiricalFeasibilityPilotStage4_2G({
      config,
      packet: currentPacket,
      artifactIntegrityPass: artifactIntegrity.gate === "pass",
    });
  const syntheticResult =
    evaluateCasimirDpEmpiricalFeasibilityPilotStage4_2G({
      config,
      packet: syntheticPacket,
      artifactIntegrityPass: false,
    });

  const stage4FReportAuthority = config.upstream_authorities.find(
    (row) => row.role === "stage4_2f_report",
  );
  if (stage4FReportAuthority == null) {
    throw new Error("stage4_2g_stage4_2f_report_authority_missing");
  }
  const stage4FReport = readJson(rootDir, stage4FReportAuthority.path);
  if (
    stage4FReport.campaign_run_id !==
      config.immutable_stage4_2f.campaign_run_id ||
    stage4FReport.final_gates?.software_and_equation_recovery !==
      config.immutable_stage4_2f.software_and_equation_recovery ||
    stage4FReport.final_gates?.measured_evidence !==
      config.immutable_stage4_2f.measured_evidence ||
    stage4FReport.final_gates?.collapse_identification !==
      config.immutable_stage4_2f.collapse_identification ||
    stage4FReport.final_gates?.manifold_dynamics !==
      config.immutable_stage4_2f.manifold_dynamics ||
    stage4FReport.final_gates?.physical_viability !==
      config.immutable_stage4_2f.physical_viability
  ) {
    throw new Error("stage4_2g_stage4_2f_standing_not_recovered");
  }

  if (
    currentResult.named_dp_prediction.gate !== "pass" ||
    currentResult.hypothesis_separation.gate !== "pass" ||
    syntheticResult.packet_audit.identifiability_gate !== "pass" ||
    syntheticResult.bounded_status.measured_evidence !== "not_ready" ||
    syntheticResult.readiness.empirical_pilot_readiness !== "not_ready"
  ) {
    throw new Error("stage4_2g_software_or_nonpromotion_gate_failed");
  }

  const isCanonicalUnacquiredRun =
    packetPath === config.packets.unacquired_template_path;
  const finalGates = isCanonicalUnacquiredRun
    ? config.final_status_policy
    : {
      software_and_packet_contract: "pass",
      design_identity_freeze:
        currentResult.bounded_status.design_identity_freeze,
      dp_companion_internal_consistency:
        currentResult.bounded_status.dp_companion_internal_consistency,
      physical_apparatus_identity:
        currentResult.readiness.physical_apparatus_identity,
      finite_geometry_maxwell_authority:
        currentResult.readiness.finite_geometry_maxwell_and_material,
      measured_material_green_authority:
        currentResult.readiness.finite_geometry_maxwell_and_material,
      state_preparation_authority:
        currentResult.readiness.state_preparation,
      branch_hold_metrology_authority:
        currentResult.readiness.branch_hold_metrology,
      quasistatic_modulation_authority:
        currentResult.readiness.quasistatic_modulation,
      measured_background_covariance:
        currentResult.readiness.measured_background_covariance,
      companion_detector_authority:
        currentResult.readiness.companion_detector,
      empirical_pilot_readiness:
        currentResult.readiness.empirical_pilot_readiness,
      complete_apparatus_stress_energy:
        currentResult.readiness.complete_apparatus_stress_energy,
      measured_evidence:
        currentResult.bounded_status.measured_evidence,
      collapse_identification: "blocked",
      manifold_dynamics: "blocked",
      physical_viability: "not_evaluated",
    };
  const configHash = fileSha256(rootDir, configPath);
  const report = {
    schema_version:
      "casimir_dp_empirical_feasibility_pilot_stage4_2g_report/1",
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
    immutable_stage4_2f: {
      ...config.immutable_stage4_2f,
      recovered: true,
    },
    authority_integrity: {
      gate: "pass" as const,
      manifest_sha256: manifestHash,
      rows: authorityRows,
    },
    current_packet: {
      path: packetPath,
      sha256: currentPacketHash,
      packet_id: currentPacket.packet_id,
      evidence_class: currentPacket.evidence_class,
      artifact_integrity: artifactIntegrity,
    },
    current_packet_result: currentResult,
    synthetic_ingestion_validation: syntheticResult,
    synthetic_validation_boundary: {
      parser_whitening_identifiability_and_power_recovered: true,
      empirical_authority: false,
      promotion_allowed: false,
      measured_evidence: "not_ready",
    },
    required_products: currentPacket.products.map((row) => ({
      product_id: row.product_id,
      current_authority: row.authority_class,
      required_for_core_pilot:
        row.product_id !== "complete_apparatus_stress_energy",
      required_for_manifold_interpretation:
        row.product_id === "complete_apparatus_stress_energy",
    })),
    pilot_decision:
      currentResult.readiness.empirical_pilot_readiness === "ready"
        ? "measured_inputs_ready_for_preregistered_pilot_interpretation"
        : "no_go_until_provenance_bound_measured_packet_passes",
    run_order: config.run_order.map((stage, index) => ({
      index: index + 1,
      stage,
      gate: "pass" as const,
    })),
    final_gates: finalGates,
    software_snapshot: {
      config_path: configPath,
      config_sha256: configHash,
      authority_manifest_path: config.authority_manifest.path,
      authority_manifest_sha256: manifestHash,
      unacquired_template_path:
        config.packets.unacquired_template_path,
      unacquired_template_sha256: templateHash,
      synthetic_validation_path:
        config.packets.synthetic_validation_path,
      synthetic_validation_sha256: syntheticHash,
    },
    fresh_casimir_verification: {
      status: "pending_external_verification" as const,
      prior_stage4_2f_certificate_reused: false,
      scientific_scope: "none" as const,
    },
  };
  const markdown = renderMarkdown(report);
  const traceRows = [
    {
      schema_version: "casimir_dp_stage4_2g_trace/1",
      record_type: "authority_integrity",
      campaign_run_id: runId,
      gate: "pass",
      authorities: authorityRows.length,
    },
    {
      schema_version: "casimir_dp_stage4_2g_trace/1",
      record_type: "single_apparatus_dp_prediction",
      campaign_run_id: runId,
      identity_sha256:
        currentResult.apparatus_design_identity.identity_sha256,
      Gamma_DP_s: currentResult.named_dp_prediction.Gamma_DP_s,
      heating_W: currentResult.named_dp_prediction.heating_W,
      gate: currentResult.named_dp_prediction.gate,
    },
    {
      schema_version: "casimir_dp_stage4_2g_trace/1",
      record_type: "synthetic_ingestion_validation",
      campaign_run_id: runId,
      identifiability_gate:
        syntheticResult.packet_audit.identifiability_gate,
      empirical_authority: false,
      measured_evidence: "not_ready",
    },
    {
      schema_version: "casimir_dp_stage4_2g_trace/1",
      record_type: "current_packet_readiness",
      campaign_run_id: runId,
      packet_evidence_class: currentPacket.evidence_class,
      pilot_decision: report.pilot_decision,
      ...finalGates,
    },
  ];
  const trace = `${traceRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const receipt = {
    schema_version:
      "casimir_dp_empirical_feasibility_pilot_stage4_2g_receipt/1",
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
    current_packet: { path: packetPath, sha256: currentPacketHash },
    unacquired_template: {
      path: config.packets.unacquired_template_path,
      sha256: templateHash,
    },
    synthetic_validation: {
      path: config.packets.synthetic_validation_path,
      sha256: syntheticHash,
      identifiability_gate:
        syntheticResult.packet_audit.identifiability_gate,
      empirical_authority: false,
    },
    report_json_sha256: textSha256(reportJson),
    report_markdown_sha256: textSha256(markdown),
    trace_sha256: textSha256(trace),
    immutable_stage4_2f: config.immutable_stage4_2f,
    result: finalGates,
    downstream_verification: {
      status: "pending_external_verification",
      prior_stage4_2f_certificate_reused: false,
    },
  };
  const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;

  const outputDir = path.resolve(rootDir, outputRoot, runId);
  const paths = {
    output_dir: outputDir,
    report_json: path.join(
      outputDir,
      "empirical-feasibility-pilot-stage4-2g-report.json",
    ),
    report_markdown: path.join(
      outputDir,
      "empirical-feasibility-pilot-stage4-2g-report.md",
    ),
    trace: path.join(
      outputDir,
      "empirical-feasibility-pilot-stage4-2g-trace.jsonl",
    ),
    receipt: path.join(
      outputDir,
      "empirical-feasibility-pilot-stage4-2g-receipt.json",
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
  packet?: string;
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
    else if (token === "--packet") args.packet = argv[++index];
    else if (token === "--output-root") args.outputRoot = argv[++index];
    else if (token === "--report-doc") args.reportDoc = argv[++index];
    else if (token === "--run-id") args.runId = argv[++index];
    else if (token === "--generated-at") args.generatedAt = argv[++index];
    else if (token === "--no-write") args.noWrite = true;
    else throw new Error(`stage4_2g_unknown_argument:${token}`);
  }
  return args;
}

if (
  process.argv[1] != null &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  const cli = parseArgs(process.argv.slice(2));
  const result =
    await runCasimirDpEmpiricalFeasibilityPilotStage4_2G({
      configPath: cli.config,
      packetPath: cli.packet,
      outputRoot: cli.outputRoot,
      reportDocPath: cli.reportDoc,
      runId: cli.runId,
      generatedAt: cli.generatedAt,
      writeArtifacts: !cli.noWrite,
    });
  process.stdout.write(`${JSON.stringify({
    campaign_gate: result.report.campaign_gate,
    campaign_run_id: result.report.campaign_run_id,
    claim_ceiling: result.report.claim_ceiling,
    pilot_decision: result.report.pilot_decision,
    observable_bridge_edges_added: 0,
    final_gates: result.report.final_gates,
    paths: result.paths,
    hashes: result.hashes,
  }, null, 2)}\n`);
}
