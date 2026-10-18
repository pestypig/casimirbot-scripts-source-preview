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
  buildSyntheticCommissioningDryRunStage4_2H,
  evaluateCasimirDpCommissioningIntakeStage4_2H,
} from "../../shared/casimir-dp-commissioning-intake-stage4-2h";
import {
  CasimirDpCommissioningDossierStage4_2H,
  CasimirDpCommissioningIntakeStage4_2HConfig,
} from "../../shared/contracts/casimir-dp-commissioning-intake-stage4-2h.v1";
import {
  CasimirDpEmpiricalFeasibilityPilotStage4_2GConfig,
  CasimirDpEmpiricalPilotPacketStage4_2G,
} from "../../shared/contracts/casimir-dp-empirical-feasibility-pilot-stage4-2g.v1";

const DEFAULT_CONFIG =
  "configs/research/casimir-dp-commissioning-intake-stage4-2h.v1.json";
const DEFAULT_OUTPUT_ROOT =
  "artifacts/research/casimir-dp-commissioning-intake-stage4-2h";

type JsonObject = Record<string, any>;
type RunOptions = {
  rootDir?: string;
  configPath?: string;
  dossierPath?: string;
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

function verifyRepoArtifact(
  rootDir: string,
  artifactRef: string | null,
  expectedSha256: string | null,
  role: string,
) {
  if (
    artifactRef == null ||
    expectedSha256 == null ||
    artifactRef.startsWith("synthetic://") ||
    artifactRef.startsWith("unacquired://") ||
    path.isAbsolute(artifactRef)
  ) {
    return {
      role,
      gate: "blocked" as const,
      reason: "artifact_must_be_repo_relative_non_synthetic_and_hashed",
    };
  }
  const resolved = path.resolve(rootDir, artifactRef);
  const insideRoot =
    resolved === rootDir || resolved.startsWith(`${rootDir}${path.sep}`);
  if (!insideRoot || !existsSync(resolved)) {
    return {
      role,
      artifact_ref: artifactRef,
      gate: "blocked" as const,
      reason: insideRoot ? "artifact_missing" : "artifact_outside_repository",
    };
  }
  const actualSha256 = fileSha256(rootDir, artifactRef);
  return {
    role,
    artifact_ref: artifactRef,
    expected_sha256: expectedSha256,
    actual_sha256: actualSha256,
    gate:
      actualSha256 === expectedSha256
        ? "pass" as const
        : "blocked" as const,
    reason:
      actualSha256 === expectedSha256 ? null : "artifact_hash_mismatch",
  };
}

function verifyMeasuredDossierArtifacts(
  rootDir: string,
  dossier: ReturnType<typeof CasimirDpCommissioningDossierStage4_2H.parse>,
) {
  if (dossier.evidence_class !== "measured_commissioning_dossier") {
    return {
      gate: "not_applicable" as const,
      checked: 0,
      rows: [],
    };
  }
  const rows = [
    ...dossier.instrument_registry.map((row) =>
      verifyRepoArtifact(
        rootDir,
        row.calibration_artifact_ref,
        row.calibration_artifact_sha256,
        `instrument:${row.role}`,
      )
    ),
    ...dossier.product_slots.map((row) =>
      verifyRepoArtifact(
        rootDir,
        row.artifact_ref,
        row.artifact_sha256,
        `product:${row.product_id}`,
      )
    ),
    verifyRepoArtifact(
      rootDir,
      dossier.cell_order_ref,
      dossier.cell_order_sha256,
      "cell_order",
    ),
    verifyRepoArtifact(
      rootDir,
      dossier.custody.freeze_receipt_ref,
      dossier.custody.freeze_receipt_sha256,
      "freeze_receipt",
    ),
  ];
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
  const dry = report.synthetic_dry_run_result;
  const lines = [
    "# Casimir-DP Stage-4.2H commissioning-intake report",
    "",
    `**Run:** \`${report.campaign_run_id}\`  `,
    `**Evidence class:** \`${report.evidence_class}\`  `,
    `**Claim ceiling:** \`${report.claim_ceiling}\`  `,
    `**Campaign gate:** \`${report.campaign_gate}\`  `,
    `**Current dossier:** \`${report.current_dossier.dossier_id}\` (\`${report.current_dossier.evidence_class}\`)  `,
    `**Observable bridge edges added:** \`0\``,
    "",
    "## Decision",
    "",
    report.pilot_decision ===
        "measured_commissioning_inputs_ready_for_stage4_2g_pilot"
      ? "The provenance-bound commissioning dossier passes the frozen Stage-4.2G pilot-readiness gates. This authorizes the preregistered empirical pilot; it is not confirmatory evidence of collapse."
      : "No-go for empirical acquisition claims until a provenance-bound measured commissioning dossier passes. The blank template and synthetic dry run prove the intake, covariance-space recomputation, custody, and packet-compilation path only.",
    "",
    "## What Stage 4.2H closes",
    "",
    "- It assigns one instrument or computational authority to every required role.",
    "- It binds every Stage-4.2G acquisition product to calibration ancestry, custody, uncertainty, and a content hash.",
    "- It freezes calibration, pilot, blinded confirmatory, and independent-replication partitions.",
    "- It defines the raw complex-coherence, environment, metrology, polarization, companion, and provenance columns.",
    "- It recompiles the Stage-4.2G packet without changing the apparatus identity, DP law, thresholds, or confirmatory fit policy.",
    "",
    "## Synthetic dry-run result",
    "",
    `- Contract gate: \`${dry.bounded_status.commissioning_contract}\`.`,
    `- Dry-run gate: \`${dry.bounded_status.synthetic_dry_run}\`.`,
    `- Stage-4.2G identifiability: \`${dry.compiled_stage4_2g_result?.packet_audit.identifiability_gate}\`.`,
    `- Empirical pilot readiness: \`${dry.bounded_status.empirical_pilot_readiness}\`.`,
    `- Measured evidence: \`${dry.bounded_status.measured_evidence}\`.`,
    "",
    "Synthetic identifiers, hashes, covariance vectors, and custody events have zero empirical authority. They exist only to exercise the full software path and failure boundaries.",
    "",
    "## Frozen partitions",
    "",
    ...report.partition_plan.map(
      (row: JsonObject) =>
        `- \`${row.partition_id}\`: ${row.planned_paired_windows} paired windows; response fit \`${row.response_fitting_allowed}\`; covariance fit \`${row.covariance_fitting_allowed}\`; confirmatory score \`${row.confirmatory_scoring_allowed}\`.`,
    ),
    "",
    "Confirmatory and independent-replication partitions cannot refit response vectors or covariance. The blind mapping is unavailable to analysis in every partition contract.",
    "",
    "## Current scientific standing",
    "",
    ...Object.entries(report.final_gates).map(
      ([key, value]) => `- \`${key}\`: \`${value}\`.`,
    ),
    "",
    "Even a passing measured commissioning dossier would establish pilot input readiness, not collapse. Collapse identification requires the later blinded confirmatory residual, its frozen DP mass-and-separation scaling, ordinary-background rejection, and independent replication. Manifold dynamics additionally requires a separately justified relativistic stress-energy model; no Casimir-to-collapse transfer kernel is registered here.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export async function runCasimirDpCommissioningIntakeStage4_2H(
  options: RunOptions = {},
) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const configPath = options.configPath ?? DEFAULT_CONFIG;
  const outputRoot = options.outputRoot ?? DEFAULT_OUTPUT_ROOT;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const runId = options.runId ??
    `casimir-dp-commissioning-intake-stage4-2h-v1-${
      timestampId(generatedAt)
    }`;
  const writeArtifacts = options.writeArtifacts ?? true;
  const config = CasimirDpCommissioningIntakeStage4_2HConfig.parse(
    readJson(rootDir, configPath),
  );

  const manifest = readJson(rootDir, config.authority_manifest.path);
  const manifestHash = fileSha256(rootDir, config.authority_manifest.path);
  if (manifestHash !== config.authority_manifest.sha256) {
    throw new Error(
      `stage4_2h_authority_manifest_hash_mismatch:${manifestHash}`,
    );
  }
  if (
    JSON.stringify(manifest.immutable_upstream) !==
      JSON.stringify(config.upstream_authorities) ||
    JSON.stringify(manifest.method_authorities) !==
      JSON.stringify(config.method_authorities)
  ) {
    throw new Error("stage4_2h_authority_manifest_tuple_mismatch");
  }
  const authorityRows = [
    ...config.upstream_authorities,
    ...config.method_authorities,
  ].map((row) => {
    const actualSha256 = fileSha256(rootDir, row.path);
    if (actualSha256 !== row.sha256) {
      throw new Error(
        `stage4_2h_authority_hash_mismatch:${row.role}:${actualSha256}`,
      );
    }
    return { ...row, actual_sha256: actualSha256, gate: "pass" as const };
  });

  const blankHash = fileSha256(rootDir, config.blank_dossier.path);
  if (blankHash !== config.blank_dossier.sha256) {
    throw new Error(`stage4_2h_blank_dossier_hash_mismatch:${blankHash}`);
  }
  const blankDossier = CasimirDpCommissioningDossierStage4_2H.parse(
    readJson(rootDir, config.blank_dossier.path),
  );
  const stage4gConfigAuthority = config.upstream_authorities.find(
    (row) => row.role === "stage4_2g_config",
  );
  const unacquiredAuthority = config.upstream_authorities.find(
    (row) => row.role === "stage4_2g_unacquired_packet",
  );
  const syntheticAuthority = config.upstream_authorities.find(
    (row) => row.role === "stage4_2g_synthetic_packet",
  );
  const stage4gReportAuthority = config.upstream_authorities.find(
    (row) => row.role === "stage4_2g_report",
  );
  if (
    stage4gConfigAuthority == null ||
    unacquiredAuthority == null ||
    syntheticAuthority == null ||
    stage4gReportAuthority == null
  ) {
    throw new Error("stage4_2h_required_stage4_2g_authority_missing");
  }
  const stage4gConfig =
    CasimirDpEmpiricalFeasibilityPilotStage4_2GConfig.parse(
      readJson(rootDir, stage4gConfigAuthority.path),
    );
  const stage4gUnacquiredPacket =
    CasimirDpEmpiricalPilotPacketStage4_2G.parse(
      readJson(rootDir, unacquiredAuthority.path),
    );
  const stage4gSyntheticPacket =
    CasimirDpEmpiricalPilotPacketStage4_2G.parse(
      readJson(rootDir, syntheticAuthority.path),
    );
  const stage4gReport = readJson(rootDir, stage4gReportAuthority.path);
  if (
    stage4gReport.campaign_run_id !==
      config.immutable_stage4_2g.campaign_run_id ||
    stage4gReport.final_gates?.measured_evidence !==
      config.immutable_stage4_2g.measured_evidence ||
    stage4gReport.final_gates?.collapse_identification !==
      config.immutable_stage4_2g.collapse_identification ||
    stage4gReport.final_gates?.manifold_dynamics !==
      config.immutable_stage4_2g.manifold_dynamics ||
    stage4gReport.final_gates?.physical_viability !==
      config.immutable_stage4_2g.physical_viability
  ) {
    throw new Error("stage4_2h_stage4_2g_standing_not_recovered");
  }

  const syntheticDossier =
    buildSyntheticCommissioningDryRunStage4_2H({
      blankDossier,
      stage4gSyntheticPacket,
      generatedAt: config.evidence_cutoff,
    });
  const syntheticDossierJson =
    `${JSON.stringify(syntheticDossier, null, 2)}\n`;
  const syntheticDossierHash = textSha256(syntheticDossierJson);
  const syntheticResult =
    evaluateCasimirDpCommissioningIntakeStage4_2H({
      config,
      dossier: syntheticDossier,
      stage4gConfig,
      stage4gUnacquiredPacket,
      artifactIntegrityPass: false,
    });
  if (
    syntheticResult.bounded_status.synthetic_dry_run !== "pass" ||
    syntheticResult.bounded_status.measured_evidence !== "not_ready" ||
    syntheticResult.bounded_status.collapse_identification !== "blocked" ||
    syntheticResult.hypothesis_separation.gate !== "pass" ||
    syntheticResult.compiled_stage4_2g_result?.packet_audit
        .identifiability_gate !== "pass"
  ) {
    throw new Error("stage4_2h_synthetic_nonpromotion_gate_failed");
  }

  const dossierPath = options.dossierPath ?? config.blank_dossier.path;
  const currentDossier = dossierPath === config.blank_dossier.path
    ? blankDossier
    : CasimirDpCommissioningDossierStage4_2H.parse(
      readJson(rootDir, dossierPath),
    );
  const dossierHash = fileSha256(rootDir, dossierPath);
  const artifactIntegrity = verifyMeasuredDossierArtifacts(
    rootDir,
    currentDossier,
  );
  const currentResult =
    evaluateCasimirDpCommissioningIntakeStage4_2H({
      config,
      dossier: currentDossier,
      stage4gConfig,
      stage4gUnacquiredPacket,
      artifactIntegrityPass: artifactIntegrity.gate === "pass",
    });
  const canonicalBlank =
    currentDossier.evidence_class === "blank_commissioning_template";
  const finalGates = canonicalBlank
    ? config.final_status_policy
    : {
      commissioning_contract:
        currentResult.bounded_status.commissioning_contract,
      synthetic_dry_run: "pass",
      instrument_registry:
        currentResult.intake_readiness.instrument_registry,
      calibration_ancestry:
        currentResult.intake_readiness.calibration_ancestry,
      custody_and_blind_freeze:
        currentResult.intake_readiness.custody_and_blind_freeze,
      raw_data_availability:
        currentResult.intake_readiness.raw_data_availability,
      stage4_2g_packet_compilation:
        currentResult.intake_readiness.stage4_2g_packet_compilation,
      empirical_pilot_readiness:
        currentResult.intake_readiness.empirical_pilot_readiness,
      measured_evidence:
        currentResult.bounded_status.measured_evidence,
      collapse_identification: "blocked",
      manifold_dynamics: "blocked",
      physical_viability: "not_evaluated",
    };
  const configHash = fileSha256(rootDir, configPath);
  const report = {
    schema_version:
      "casimir_dp_commissioning_intake_stage4_2h_report/1",
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
    immutable_stage4_2g: {
      ...config.immutable_stage4_2g,
      recovered: true,
    },
    authority_integrity: {
      gate: "pass" as const,
      manifest_sha256: manifestHash,
      rows: authorityRows,
    },
    current_dossier: {
      path: dossierPath,
      sha256: dossierHash,
      dossier_id: currentDossier.dossier_id,
      evidence_class: currentDossier.evidence_class,
      artifact_integrity: artifactIntegrity,
    },
    current_dossier_result: currentResult,
    synthetic_dry_run: {
      sha256: syntheticDossierHash,
      empirical_authority: false,
    },
    synthetic_dry_run_result: syntheticResult,
    partition_plan: currentDossier.partition_plan,
    raw_columns: currentDossier.raw_columns,
    pilot_decision:
      currentResult.intake_readiness.empirical_pilot_readiness === "ready"
        ? "measured_commissioning_inputs_ready_for_stage4_2g_pilot"
        : "no_go_until_provenance_bound_measured_dossier_passes",
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
      blank_dossier_path: config.blank_dossier.path,
      blank_dossier_sha256: blankHash,
      synthetic_dry_run_sha256: syntheticDossierHash,
    },
    fresh_casimir_verification: {
      status: "pending_external_verification" as const,
      prior_stage4_2g_certificate_reused: false,
      scientific_scope: "none" as const,
    },
  };
  const markdown = renderMarkdown(report);
  const traceRows = [
    {
      schema_version: "casimir_dp_stage4_2h_trace/1",
      record_type: "authority_integrity",
      campaign_run_id: runId,
      gate: "pass",
      authorities: authorityRows.length,
    },
    {
      schema_version: "casimir_dp_stage4_2h_trace/1",
      record_type: "synthetic_dry_run",
      campaign_run_id: runId,
      gate: syntheticResult.bounded_status.synthetic_dry_run,
      identifiability_gate:
        syntheticResult.compiled_stage4_2g_result?.packet_audit
          .identifiability_gate,
      empirical_authority: false,
      measured_evidence: "not_ready",
    },
    {
      schema_version: "casimir_dp_stage4_2h_trace/1",
      record_type: "current_dossier_readiness",
      campaign_run_id: runId,
      dossier_evidence_class: currentDossier.evidence_class,
      pilot_decision: report.pilot_decision,
      ...finalGates,
    },
  ];
  const trace =
    `${traceRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const receipt = {
    schema_version:
      "casimir_dp_commissioning_intake_stage4_2h_receipt/1",
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
    current_dossier: { path: dossierPath, sha256: dossierHash },
    blank_dossier: {
      path: config.blank_dossier.path,
      sha256: blankHash,
    },
    synthetic_dry_run: {
      sha256: syntheticDossierHash,
      empirical_authority: false,
    },
    report_json_sha256: textSha256(reportJson),
    report_markdown_sha256: textSha256(markdown),
    trace_sha256: textSha256(trace),
    immutable_stage4_2g: config.immutable_stage4_2g,
    result: finalGates,
    downstream_verification: {
      status: "pending_external_verification",
      prior_stage4_2g_certificate_reused: false,
    },
  };
  const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;
  const outputDir = path.resolve(rootDir, outputRoot, runId);
  const paths = {
    output_dir: outputDir,
    report_json: path.join(
      outputDir,
      "commissioning-intake-stage4-2h-report.json",
    ),
    report_markdown: path.join(
      outputDir,
      "commissioning-intake-stage4-2h-report.md",
    ),
    trace: path.join(
      outputDir,
      "commissioning-intake-stage4-2h-trace.jsonl",
    ),
    receipt: path.join(
      outputDir,
      "commissioning-intake-stage4-2h-receipt.json",
    ),
    synthetic_dry_run: path.join(
      outputDir,
      "commissioning-intake-stage4-2h-synthetic-dry-run.json",
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
    writeFileSync(
      paths.synthetic_dry_run,
      syntheticDossierJson,
      "utf8",
    );
    if (paths.maintained_report != null) {
      writeFileSync(paths.maintained_report, markdown, "utf8");
    }
  }
  return {
    report,
    markdown,
    trace,
    receipt,
    syntheticDossier,
    paths,
    hashes: {
      report_json_sha256: textSha256(reportJson),
      report_markdown_sha256: textSha256(markdown),
      trace_sha256: textSha256(trace),
      receipt_sha256: textSha256(receiptJson),
      synthetic_dry_run_sha256: syntheticDossierHash,
    },
  };
}

type CliArgs = {
  config?: string;
  dossier?: string;
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
    else if (token === "--dossier") args.dossier = argv[++index];
    else if (token === "--output-root") args.outputRoot = argv[++index];
    else if (token === "--report-doc") args.reportDoc = argv[++index];
    else if (token === "--run-id") args.runId = argv[++index];
    else if (token === "--generated-at") args.generatedAt = argv[++index];
    else if (token === "--no-write") args.noWrite = true;
    else throw new Error(`stage4_2h_unknown_argument:${token}`);
  }
  return args;
}

if (
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = parseArgs(process.argv.slice(2));
  runCasimirDpCommissioningIntakeStage4_2H({
    configPath: args.config,
    dossierPath: args.dossier,
    outputRoot: args.outputRoot,
    reportDocPath: args.reportDoc,
    runId: args.runId,
    generatedAt: args.generatedAt,
    writeArtifacts: !args.noWrite,
  }).then((result) => {
    console.log(JSON.stringify({
      campaign_run_id: result.report.campaign_run_id,
      campaign_gate: result.report.campaign_gate,
      pilot_decision: result.report.pilot_decision,
      final_gates: result.report.final_gates,
      hashes: result.hashes,
      paths: result.paths,
    }, null, 2));
  });
}
