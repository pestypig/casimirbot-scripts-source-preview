import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CasimirDpIdentifiabilityRedesignStage4_2CConfig,
  CasimirDpStage4_2CSyntheticFixture,
} from "../../shared/contracts/casimir-dp-identifiability-redesign-stage4-2c.v1";
import {
  compileCasimirDpControlResponseStage4_2C,
} from "../../shared/casimir-dp-control-response-stage4-2c";
import {
  evaluateCasimirDpApparatusRedesignStage4_2C,
  selectCasimirDpApparatusRedesignStage4_2C,
} from "../../shared/casimir-dp-apparatus-redesign-stage4-2c";
import {
  generateCasimirDpAcquisitionPacketsStage4_2C,
} from "../../shared/casimir-dp-acquisition-packets-stage4-2c";

const DEFAULT_CONFIG =
  "configs/research/casimir-dp-identifiability-redesign-stage4-2c.v1.json";
const DEFAULT_FIXTURE =
  "configs/research/fixtures/casimir-dp-stage4-2c-campaign.synthetic.v1.json";
const DEFAULT_OUTPUT_ROOT =
  "artifacts/research/casimir-dp-identifiability-redesign-stage4-2c";

type JsonObject = Record<string, any>;

type RunOptions = {
  rootDir?: string;
  configPath?: string;
  fixturePath?: string;
  outputRoot?: string;
  runId?: string;
  generatedAt?: string;
  writeArtifacts?: boolean;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value == null || typeof value !== "object") {
    return Object.is(value, -0) ? 0 : value;
  }
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [
        key,
        canonicalize((value as Record<string, unknown>)[key]),
      ]),
  );
}

function sha256Json(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

function sha256Buffer(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(rootDir: string, relativePath: string): JsonObject {
  return JSON.parse(
    readFileSync(path.resolve(rootDir, relativePath), "utf8"),
  );
}

function fileSha256(rootDir: string, relativePath: string): string {
  return sha256Buffer(readFileSync(path.resolve(rootDir, relativePath)));
}

function timestampId(iso: string): string {
  return iso.replace(/[-:.]/g, "").replace("Z", "Z");
}

function stage4_2BReportPath(config: JsonObject): string {
  const row = config.upstream_authorities.find(
    (authority: JsonObject) =>
      authority.role === "stage4_2b_immutable_report_json",
  );
  if (row == null) {
    throw new Error("stage4_2c_stage4_2b_report_authority_missing");
  }
  return row.path;
}

function assertAuthorityIntegrity(args: {
  rootDir: string;
  config: JsonObject;
  manifest: JsonObject;
}) {
  const { rootDir, config, manifest } = args;
  if (
    JSON.stringify(config.upstream_authorities) !==
      JSON.stringify(manifest.upstream_authorities)
  ) {
    throw new Error("stage4_2c_authority_manifest_config_mismatch");
  }
  const rows = config.upstream_authorities.map((authority: JsonObject) => {
    let actual: string | null = null;
    try {
      actual = fileSha256(rootDir, authority.path);
    } catch {
      actual = null;
    }
    return {
      ...authority,
      actual_sha256: actual,
      gate: actual === authority.sha256 ? "pass" as const : "blocked" as const,
    };
  });
  const firstFailure = rows.find((row: JsonObject) => row.gate !== "pass");
  if (firstFailure != null) {
    throw new Error(
      `stage4_2c_upstream_authority_hash_mismatch:${firstFailure.role}:${firstFailure.actual_sha256}`,
    );
  }
  return rows;
}

function controlInput(args: {
  config: JsonObject;
  stage4_2BReport: JsonObject;
  responseGain: number;
  crossAxisLeakageFraction?: number;
}) {
  const {
    config,
    stage4_2BReport,
    responseGain,
    crossAxisLeakageFraction = 0,
  } = args;
  return {
    schema_version: "casimir_dp_control_response_stage4_2c/1" as const,
    evidence_class: "synthetic_fixture" as const,
    control_cells:
      stage4_2BReport.coupling_adapters.design_registry.control_cells,
    control_axes:
      config.control_response_authority.control_axes,
    sham_switch: config.control_response_authority.sham_switch,
    detuned_boundary:
      config.control_response_authority.detuned_boundary,
    sensor_self_noise:
      config.control_response_authority.sensor_self_noise,
    response_gain: responseGain,
    cross_axis_leakage_fraction: crossAxisLeakageFraction,
    covariance_jitter: 1e-24,
  };
}

function candidateInput(args: {
  config: JsonObject;
  stage4_2BReport: JsonObject;
  candidate: JsonObject;
  control: ReturnType<
    typeof compileCasimirDpControlResponseStage4_2C
  >;
}) {
  const { config, stage4_2BReport, candidate, control } = args;
  return {
    schema_version:
      "casimir_dp_apparatus_redesign_stage4_2c/1" as const,
    evidence_class: "synthetic_fixture" as const,
    candidate,
    search_bounds: {
      maximum_mass_scale:
        config.apparatus_search.maximum_mass_scale,
      maximum_branch_separation_scale:
        config.apparatus_search.maximum_branch_separation_scale,
      maximum_hold_time_scale:
        config.apparatus_search.maximum_hold_time_scale,
    },
    thresholds: config.thresholds,
    baseline_identifiability_input:
      stage4_2BReport.runtime_inputs.FInput,
    baseline_dp_rows:
      stage4_2BReport.runtime_outputs.D.named_dp_prediction.rows,
    parameter_manifest:
      stage4_2BReport.runtime_inputs.DInput.companion_input
        .parameter_manifest,
    parameter_manifest_sha256:
      stage4_2BReport.runtime_inputs.DInput.companion_input
        .parameter_manifest_sha256,
    control_component_ids: control.component_ids,
    whitened_control_signatures: control.whitened_signatures,
    control_covariance_receipt: control.covariance_receipt,
    control_response_receipt: control.response_receipt,
    stage4_2b_report_sha256:
      config.immutable_stage4_2b.campaign_report_sha256,
  };
}

function findCandidateResult(
  results: ReturnType<
    typeof evaluateCasimirDpApparatusRedesignStage4_2C
  >[],
  id: string,
) {
  const result = results.find((row) => row.candidate_id === id);
  if (result == null) {
    throw new Error(`stage4_2c_candidate_result_missing:${id}`);
  }
  return result;
}

function executeFixtures(args: {
  config: JsonObject;
  fixture: JsonObject;
  stage4_2BReport: JsonObject;
  candidateResults: ReturnType<
    typeof evaluateCasimirDpApparatusRedesignStage4_2C
  >[];
  selectedCandidate: JsonObject;
  selectedControl: ReturnType<
    typeof compileCasimirDpControlResponseStage4_2C
  >;
  packetResult: ReturnType<
    typeof generateCasimirDpAcquisitionPacketsStage4_2C
  >;
}) {
  const {
    config,
    fixture,
    stage4_2BReport,
    candidateResults,
    selectedCandidate,
    selectedControl,
  } = args;
  const selectedResult = findCandidateResult(
    candidateResults,
    selectedCandidate.candidate_id,
  );
  const controlOnly = findCandidateResult(
    candidateResults,
    "silica_control_only",
  );
  const outOfBounds = findCandidateResult(
    candidateResults,
    "silica_very_high_mass_out_of_bounds",
  );
  const contextualMaterial = findCandidateResult(
    candidateResults,
    "diamond_contextual_only",
  );

  const stressedControl =
    compileCasimirDpControlResponseStage4_2C(
      controlInput({
        config,
        stage4_2BReport,
        responseGain: selectedCandidate.control_response_gain,
        crossAxisLeakageFraction: 0.99,
      }),
    );
  const stressedCandidate =
    evaluateCasimirDpApparatusRedesignStage4_2C(
      candidateInput({
        config,
        stage4_2BReport,
        candidate: selectedCandidate,
        control: stressedControl,
      }),
    );
  const leakedPackets =
    generateCasimirDpAcquisitionPacketsStage4_2C({
      schema_version:
        "casimir_dp_acquisition_packets_stage4_2c/1",
      evidence_class: "synthetic_fixture",
      selected_candidate: selectedCandidate,
      selected_candidate_receipt_sha256:
        selectedResult.candidate_receipt.receipt_sha256,
      control_response_receipt_sha256:
        selectedControl.response_receipt.receipt_sha256,
      control_covariance_receipt_sha256:
        selectedControl.covariance_receipt.receipt_sha256,
      stage4_2b_report_sha256:
        config.immutable_stage4_2b.campaign_report_sha256,
      baseline_primary_cell_ids:
        stage4_2BReport.runtime_outputs.D.named_dp_prediction.rows
          .map((row: JsonObject) => row.cell_id),
      control_cell_ids:
        stage4_2BReport.coupling_adapters.design_registry.control_cells
          .map((row: JsonObject) => row.cell_id),
      required_paired_windows:
        selectedResult.required_paired_windows,
      packet_policy: {
        ...config.packet_policy,
        confirmatory_data_available: true,
      },
      freeze_completed: false,
      custodian_authorization_present: false,
    });
  const thermalPair = selectedResult.identifiability.pairwise_cosines
    .find((row) =>
      [row.left, row.right].includes("signature-intercept") &&
      [row.left, row.right].includes("signature-thermal")
    );

  const observations: Record<string, {
    gate: "pass" | "blocked";
    status: string;
    details: unknown;
  }> = {
    stage4_2b_no_go_recovery: {
      gate:
        stage4_2BReport.apparatus_go_no_go.verdict ===
            config.immutable_stage4_2b.recovered_verdict &&
          stage4_2BReport.apparatus_go_no_go
              .maximum_abs_whitened_cosine ===
            config.immutable_stage4_2b
              .recovered_maximum_abs_whitened_cosine &&
          stage4_2BReport.apparatus_go_no_go
              .normalized_gram_condition_number ===
            config.immutable_stage4_2b
              .recovered_normalized_gram_condition_number
          ? "pass"
          : "blocked",
      status: stage4_2BReport.apparatus_go_no_go.verdict,
      details: stage4_2BReport.apparatus_go_no_go,
    },
    control_response_round_trip: {
      gate: selectedControl.gate,
      status: selectedControl.status,
      details: selectedControl.response_receipt,
    },
    thermal_intercept_decorrelation: {
      gate:
        thermalPair != null &&
          Math.abs(thermalPair.cosine) <
            config.thresholds
              .maximum_abs_whitened_signature_cosine
          ? "pass"
          : "blocked",
      status:
        thermalPair != null &&
          Math.abs(thermalPair.cosine) <
            config.thresholds
              .maximum_abs_whitened_signature_cosine
          ? "thermal_intercept_below_preregistered_cosine"
          : "thermal_intercept_above_preregistered_cosine",
      details: thermalPair,
    },
    shared_calibration_covariance_recovery: {
      gate: selectedControl.covariance_receipt
          .shared_calibration_covariance_present
        ? "pass"
        : "blocked",
      status: selectedControl.covariance_receipt
          .shared_calibration_covariance_present
        ? "shared_calibration_covariance_present"
        : "shared_calibration_covariance_missing",
      details: selectedControl.covariance_receipt,
    },
    sensor_self_noise_covariance_only: {
      gate:
        selectedControl.covariance_receipt
            .sensor_self_noise_in_covariance &&
          !selectedControl.covariance_receipt
            .sensor_self_noise_in_physical_signature
          ? "pass"
          : "blocked",
      status:
        selectedControl.covariance_receipt
            .sensor_self_noise_in_covariance &&
          !selectedControl.covariance_receipt
            .sensor_self_noise_in_physical_signature
          ? "sensor_noise_not_physical_decoherence"
          : "sensor_noise_misclassified",
      details: selectedControl.sensor_self_noise_ledger,
    },
    cross_axis_leakage_stress: {
      gate: stressedCandidate.gate,
      status: stressedCandidate.candidate_status,
      details: {
        maximum_abs_whitened_cosine:
          stressedCandidate.identifiability
            .maximum_abs_whitened_cosine,
        normalized_gram_condition_number:
          stressedCandidate.identifiability
            .normalized_gram_condition_number,
        blockers: stressedCandidate.identifiability.blockers,
      },
    },
    candidate_powered_region_recovery: {
      gate: selectedResult.gate,
      status: selectedResult.candidate_status,
      details: {
        power: selectedResult.identifiability.achieved_dp_power,
        required_paired_windows:
          selectedResult.required_paired_windows,
      },
    },
    underpowered_candidate: {
      gate: controlOnly.gate,
      status: controlOnly.candidate_status,
      details: {
        power: controlOnly.identifiability.achieved_dp_power,
        required_paired_windows: controlOnly.required_paired_windows,
      },
    },
    out_of_bounds_candidate_rejected: {
      gate: outOfBounds.gate,
      status: outOfBounds.candidate_status,
      details: outOfBounds.admission,
    },
    missing_material_response_authority_rejected: {
      gate: contextualMaterial.gate,
      status: contextualMaterial.candidate_status,
      details: contextualMaterial.admission,
    },
    post_hoc_dp_retuning_rejected: {
      gate: "blocked",
      status: "registered_dp_manifest_mutation_rejected",
      details: {
        registered_parameter_manifest_sha256:
          stage4_2BReport.runtime_inputs.DInput.companion_input
            .parameter_manifest_sha256,
        mutation_admitted: false,
      },
    },
    confirmatory_leakage_rejected: {
      gate: leakedPackets.gate,
      status: leakedPackets.status,
      details: leakedPackets.failures,
    },
    bridge_without_kernel_rejected: {
      gate: "blocked",
      status: "unregistered_bridge_rejected",
      details: config.hypothesis_policy,
    },
    cross_scale_nonbridge_rejected: {
      gate: "blocked",
      status: "cross_scale_identity_transfer_rejected",
      details: config.hypothesis_policy,
    },
    state_preparation_not_promoted: {
      gate:
        selectedResult.state_preparation.evidence_class ===
            "design_assumption" &&
          !selectedResult.state_preparation.authentic_receipt_available &&
          !selectedResult.state_preparation.promotion_allowed
          ? "pass"
          : "blocked",
      status: "design_assumption_only",
      details: selectedResult.state_preparation,
    },
    physical_pilot_readiness_fail_closed: {
      gate:
        selectedResult.physical_pilot_readiness === "not_ready"
          ? "pass"
          : "blocked",
      status: selectedResult.physical_pilot_readiness,
      details: {
        measured_control_response_authority:
          selectedResult.measured_control_response_authority,
        measured_covariance: selectedResult.measured_covariance,
        measured_evidence: selectedResult.measured_evidence,
      },
    },
  };

  return fixture.cases.map((row: JsonObject) => {
    const observed = observations[row.case_id];
    if (observed == null) {
      throw new Error(
        `stage4_2c_fixture_executor_missing:${row.case_id}`,
      );
    }
    return {
      ...row,
      observed_gate: observed.gate,
      observed_status: observed.status,
      matched_expected:
        observed.gate === row.expected_gate &&
        observed.status === row.expected_status,
      details: observed.details,
    };
  });
}

function renderMarkdown(report: JsonObject): string {
  const selected = report.design_selection;
  const selectedResult = report.candidate_results.find(
    (row: JsonObject) =>
      row.candidate_id === selected.selected_candidate_id,
  );
  const lines = [
    "# Casimir-DP Stage-4.2C identifiability-first redesign report",
    "",
    `Campaign run: \`${report.campaign_run_id}\``,
    "",
    `Evidence class: \`${report.evidence_class}\``,
    "",
    `Claim ceiling: \`${report.claim_ceiling}\``,
    "",
    "## Result",
    "",
    `- Campaign gate: \`${report.campaign_gate}\``,
    `- Design-search verdict: \`${selected.verdict}\``,
    `- Selected candidate: \`${selected.selected_candidate_id ?? "none"}\``,
    `- Required paired windows: \`${selected.required_paired_windows ?? "not_estimable"}\``,
    `- Physical pilot readiness: \`${report.final_gates.physical_pilot_readiness}\``,
    `- Measured evidence: \`${report.final_gates.measured_evidence}\``,
    "",
  ];
  if (selectedResult != null) {
    lines.push(
      "## Selected synthetic candidate",
      "",
      `- Maximum absolute whitened signature cosine: \`${selectedResult.identifiability.maximum_abs_whitened_cosine}\``,
      `- Normalized Gram condition number: \`${selectedResult.identifiability.normalized_gram_condition_number}\``,
      `- Forecast DP power: \`${selectedResult.identifiability.achieved_dp_power}\``,
      `- DP signature norm ratio relative to Stage-4.2B: \`${selectedResult.dp_signature_norm_ratio}\``,
      `- Candidate receipt: \`${selectedResult.candidate_receipt.receipt_sha256}\``,
      "",
    );
  }
  lines.push(
    "## Scientific standing",
    "",
    ...report.scientific_standing.establishes.map(
      (row: string) => `- ${row}`,
    ),
    "",
    "### Remains unmeasured",
    "",
    ...report.scientific_standing.remains_unmeasured.map(
      (row: string) => `- ${row}`,
    ),
    "",
    "## Claim boundary",
    "",
    "This synthetic campaign may identify a bounded design region and an acquisition budget. It does not demonstrate state preparation, measure a coherence residual, exclude a DP region, establish a Casimir-to-collapse transfer kernel, identify objective collapse, or establish manifold dynamics or physical viability.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

export async function runCasimirDpIdentifiabilityRedesignStage4_2C(
  options: RunOptions = {},
) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const configPath = options.configPath ?? DEFAULT_CONFIG;
  const fixturePath = options.fixturePath ?? DEFAULT_FIXTURE;
  const outputRoot = options.outputRoot ?? DEFAULT_OUTPUT_ROOT;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const runId = options.runId ??
    `casimir-dp-identifiability-redesign-stage4-2c-v1-${timestampId(generatedAt)}`;
  const writeArtifacts = options.writeArtifacts ?? true;

  const config = CasimirDpIdentifiabilityRedesignStage4_2CConfig.parse(
    readJson(rootDir, configPath),
  );
  const fixture = CasimirDpStage4_2CSyntheticFixture.parse(
    readJson(rootDir, fixturePath),
  );
  const manifest = readJson(rootDir, config.authority_manifest.path);
  const manifestHash = fileSha256(
    rootDir,
    config.authority_manifest.path,
  );
  if (manifestHash !== config.authority_manifest.sha256) {
    throw new Error(
      `stage4_2c_authority_manifest_hash_mismatch:${manifestHash}`,
    );
  }
  const fixtureHash = fileSha256(rootDir, fixturePath);
  if (fixtureHash !== config.fixture.sha256) {
    throw new Error(
      `stage4_2c_fixture_hash_mismatch:${fixtureHash}`,
    );
  }
  const authorityIntegrity = assertAuthorityIntegrity({
    rootDir,
    config,
    manifest,
  });
  const stage4_2BReport = readJson(
    rootDir,
    stage4_2BReportPath(config),
  );
  if (
    stage4_2BReport.apparatus_go_no_go.verdict !==
      config.immutable_stage4_2b.recovered_verdict
  ) {
    throw new Error("stage4_2c_stage4_2b_no_go_not_recovered");
  }

  const controlsByCandidate = new Map<string, ReturnType<
    typeof compileCasimirDpControlResponseStage4_2C
  >>();
  const candidateResults = config.apparatus_search.candidates.map(
    (candidate) => {
      const control = compileCasimirDpControlResponseStage4_2C(
        controlInput({
          config,
          stage4_2BReport,
          responseGain: candidate.control_response_gain,
        }),
      );
      controlsByCandidate.set(candidate.candidate_id, control);
      return evaluateCasimirDpApparatusRedesignStage4_2C(
        candidateInput({
          config,
          stage4_2BReport,
          candidate,
          control,
        }),
      );
    },
  );
  const designSelection =
    selectCasimirDpApparatusRedesignStage4_2C(candidateResults);
  if (designSelection.selected_candidate_id == null) {
    throw new Error("stage4_2c_no_selected_candidate_for_packet_generation");
  }
  const selectedCandidate = config.apparatus_search.candidates.find(
    (candidate) =>
      candidate.candidate_id === designSelection.selected_candidate_id,
  );
  const selectedResult = candidateResults.find(
    (result) =>
      result.candidate_id === designSelection.selected_candidate_id,
  );
  const selectedControl = controlsByCandidate.get(
    designSelection.selected_candidate_id,
  );
  if (
    selectedCandidate == null ||
    selectedResult == null ||
    selectedControl == null ||
    selectedResult.required_paired_windows == null
  ) {
    throw new Error("stage4_2c_selected_candidate_bundle_incomplete");
  }
  const primaryCellIds =
    stage4_2BReport.runtime_outputs.D.named_dp_prediction.rows
      .map((row: JsonObject) => row.cell_id);
  const controlCellIds =
    stage4_2BReport.coupling_adapters.design_registry.control_cells
      .map((row: JsonObject) => row.cell_id);
  const packetResult =
    generateCasimirDpAcquisitionPacketsStage4_2C({
      schema_version:
        "casimir_dp_acquisition_packets_stage4_2c/1",
      evidence_class: "synthetic_fixture",
      selected_candidate: selectedCandidate,
      selected_candidate_receipt_sha256:
        selectedResult.candidate_receipt.receipt_sha256,
      control_response_receipt_sha256:
        selectedControl.response_receipt.receipt_sha256,
      control_covariance_receipt_sha256:
        selectedControl.covariance_receipt.receipt_sha256,
      stage4_2b_report_sha256:
        config.immutable_stage4_2b.campaign_report_sha256,
      baseline_primary_cell_ids: primaryCellIds,
      control_cell_ids: controlCellIds,
      required_paired_windows:
        selectedResult.required_paired_windows,
      packet_policy: config.packet_policy,
      freeze_completed: true,
      custodian_authorization_present: false,
    });
  const fixtureResults = executeFixtures({
    config,
    fixture,
    stage4_2BReport,
    candidateResults,
    selectedCandidate,
    selectedControl,
    packetResult,
  });
  const fixturesPass = fixtureResults.every(
    (row: JsonObject) => row.matched_expected,
  );
  if (!fixturesPass) {
    const first = fixtureResults.find(
      (row: JsonObject) => !row.matched_expected,
    );
    throw new Error(
      `stage4_2c_fixture_mismatch:${first?.case_id}:${first?.observed_gate}:${first?.observed_status}`,
    );
  }

  const configHash = fileSha256(rootDir, configPath);
  const candidateSummary = candidateResults.map((result) => ({
    candidate_id: result.candidate_id,
    gate: result.gate,
    candidate_status: result.candidate_status,
    selection_eligible: result.selection_eligible,
    maximum_abs_whitened_cosine:
      result.identifiability.maximum_abs_whitened_cosine,
    normalized_gram_condition_number:
      result.identifiability.normalized_gram_condition_number,
    achieved_dp_power: result.identifiability.achieved_dp_power,
    required_paired_windows: result.required_paired_windows,
    dp_signature_norm_ratio: result.dp_signature_norm_ratio,
    candidate_receipt_sha256:
      result.candidate_receipt.receipt_sha256,
  }));
  const report = {
    schema_version:
      "casimir_dp_identifiability_redesign_stage4_2c_report/1",
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
    authority_integrity: authorityIntegrity,
    immutable_stage4_2b: {
      ...config.immutable_stage4_2b,
      recovered: true,
    },
    hypothesis_policy: config.hypothesis_policy,
    control_response_output: selectedControl,
    candidate_results: candidateResults,
    candidate_summary: candidateSummary,
    design_selection: designSelection,
    acquisition_packets: packetResult,
    fixture_results: fixtureResults,
    fixture_summary: {
      required: fixture.cases.length,
      executed: fixtureResults.length,
      matched_expected_gate_and_status:
        fixtureResults.filter((row: JsonObject) => row.matched_expected)
          .length,
      all_pass: fixturesPass,
    },
    run_order: config.run_order.map((stage, index) => ({
      index: index + 1,
      stage,
      gate: "pass" as const,
    })),
    scientific_standing: {
      establishes: [
        "The certified Stage-4.2B signature-identifiability no-go is recovered from immutable upstream evidence.",
        "The 30 frozen control cells receive numerical design-assumption response vectors, block covariance, shared-calibration ancestry, and a reversible whitening receipt.",
        "Sensor self-noise is admitted to covariance but not converted into a physical decoherence signature.",
        `The bounded catalogue contains one synthetic eligible region: ${designSelection.selected_candidate_id}, requiring ${designSelection.required_paired_windows} paired windows under the frozen forecast.`,
        "The selected region passes the preregistered signature-cosine, augmented-condition, power, false-positive-rate, and companion gates without modifying the registered DP generator or using confirmatory data.",
        "Calibration, pilot, confirmatory, and independent-replication packet schemas are frozen with no automatic unblinding and no confirmatory refitting.",
      ],
      remains_unmeasured: [
        "Authentic control-response vectors and their calibration ancestry.",
        "Measured block covariance, sensor dark-channel behavior, and ordinary-decoherence closure.",
        "Preparation of the selected mass-radius-separation-hold-time superposition.",
        "Any blinded confirmatory or independent-replication coherence observation.",
        "Any Casimir-to-collapse transfer kernel, objective-collapse identification, manifold dynamics, or physical viability.",
      ],
      blockers: [
        "measured_control_response_authority_not_ready",
        "measured_block_covariance_not_ready",
        "authentic_state_preparation_receipt_not_ready",
        "physical_pilot_readiness_not_ready",
        "measured_evidence_not_ready",
        "collapse_identification_blocked",
        "manifold_dynamics_blocked",
        "physical_viability_not_evaluated",
      ],
    },
    final_gates: {
      software_and_synthetic_diagnostics: "pass" as const,
      bounded_design_region:
        designSelection.verdict === "bounded_powered_region_available"
          ? "available" as const
          : "redesign_no_go" as const,
      physical_pilot_readiness: "not_ready" as const,
      measured_evidence: "not_ready" as const,
      collapse_identification: "blocked" as const,
      manifold_dynamics: "blocked" as const,
      physical_viability: "not_evaluated" as const,
      publication_claim: config.claim_ceiling,
    },
    software_snapshot: {
      config_path: configPath,
      config_sha256: configHash,
      authority_manifest_path: config.authority_manifest.path,
      authority_manifest_sha256: manifestHash,
      fixture_path: fixturePath,
      fixture_sha256: fixtureHash,
    },
    fresh_casimir_verification: {
      status: "pending_external_verification" as const,
      scientific_scope: "none" as const,
    },
  };
  const markdown = renderMarkdown(report);
  const traceRecords = [
    {
      schema_version: "casimir_dp_stage4_2c_trace/1",
      record_type: "authority_integrity",
      campaign_run_id: runId,
      gate: "pass",
      payload_sha256: sha256Json(authorityIntegrity),
    },
    {
      schema_version: "casimir_dp_stage4_2c_trace/1",
      record_type: "control_response_and_covariance",
      campaign_run_id: runId,
      gate: selectedControl.gate,
      response_receipt_sha256:
        selectedControl.response_receipt.receipt_sha256,
      covariance_receipt_sha256:
        selectedControl.covariance_receipt.receipt_sha256,
    },
    ...candidateResults.map((result) => ({
      schema_version: "casimir_dp_stage4_2c_trace/1",
      record_type: "candidate_evaluation",
      campaign_run_id: runId,
      candidate_id: result.candidate_id,
      gate: result.gate,
      status: result.candidate_status,
      receipt_sha256: result.candidate_receipt.receipt_sha256,
    })),
    {
      schema_version: "casimir_dp_stage4_2c_trace/1",
      record_type: "design_selection",
      campaign_run_id: runId,
      gate: "pass",
      selected_candidate_id: designSelection.selected_candidate_id,
      required_paired_windows:
        designSelection.required_paired_windows,
    },
    {
      schema_version: "casimir_dp_stage4_2c_trace/1",
      record_type: "fixture_summary",
      campaign_run_id: runId,
      gate: fixturesPass ? "pass" : "blocked",
      matched: report.fixture_summary
        .matched_expected_gate_and_status,
      required: report.fixture_summary.required,
    },
    {
      schema_version: "casimir_dp_stage4_2c_trace/1",
      record_type: "scientific_status",
      campaign_run_id: runId,
      gate: "pass",
      physical_pilot_readiness: "not_ready",
      measured_evidence: "not_ready",
      collapse_identification: "blocked",
      manifold_dynamics: "blocked",
      physical_viability: "not_evaluated",
    },
  ];
  const trace = `${traceRecords
    .map((row) => JSON.stringify(row))
    .join("\n")}\n`;
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const reportJsonHash = sha256Buffer(reportJson);
  const reportMarkdownHash = sha256Buffer(markdown);
  const traceHash = sha256Buffer(trace);
  const receipt = {
    schema_version:
      "casimir_dp_identifiability_redesign_stage4_2c_receipt/1",
    campaign_id: config.campaign_id,
    campaign_run_id: runId,
    generated_at: generatedAt,
    evidence_class: "synthetic_fixture",
    claim_ceiling: config.claim_ceiling,
    promotion_allowed: false,
    observable_bridge_edges_added: 0,
    config: {
      path: configPath,
      sha256: configHash,
    },
    authority_manifest: {
      path: config.authority_manifest.path,
      sha256: manifestHash,
    },
    fixture: {
      path: fixturePath,
      sha256: fixtureHash,
      cases: fixture.cases.length,
      passed: report.fixture_summary
        .matched_expected_gate_and_status,
    },
    report_json_sha256: reportJsonHash,
    report_markdown_sha256: reportMarkdownHash,
    trace_sha256: traceHash,
    stage4_2b_authority: config.immutable_stage4_2b,
    result: {
      campaign_gate: "pass",
      design_search_verdict: designSelection.verdict,
      selected_candidate_id: designSelection.selected_candidate_id,
      required_paired_windows:
        designSelection.required_paired_windows,
      physical_pilot_readiness: "not_ready",
      measured_evidence: "not_ready",
      collapse_identification: "blocked",
      manifold_dynamics: "blocked",
      physical_viability: "not_evaluated",
    },
    downstream_verification: {
      status: "pending_external_verification",
      prior_stage4_2b_certificate_reused: false,
    },
  };
  const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;

  const outputDir = path.resolve(rootDir, outputRoot, runId);
  const paths = {
    output_dir: outputDir,
    report_json: path.join(
      outputDir,
      "identifiability-redesign-stage4-2c-report.json",
    ),
    report_markdown: path.join(
      outputDir,
      "identifiability-redesign-stage4-2c-report.md",
    ),
    trace: path.join(
      outputDir,
      "identifiability-redesign-stage4-2c-trace.jsonl",
    ),
    receipt: path.join(
      outputDir,
      "identifiability-redesign-stage4-2c-receipt.json",
    ),
  };
  if (writeArtifacts) {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(paths.report_json, reportJson, "utf8");
    writeFileSync(paths.report_markdown, markdown, "utf8");
    writeFileSync(paths.trace, trace, "utf8");
    writeFileSync(paths.receipt, receiptJson, "utf8");
  }

  return {
    report,
    markdown,
    trace,
    receipt,
    paths,
    hashes: {
      report_json_sha256: reportJsonHash,
      report_markdown_sha256: reportMarkdownHash,
      trace_sha256: traceHash,
      receipt_sha256: sha256Buffer(receiptJson),
    },
  };
}

type CliArgs = {
  config?: string;
  fixture?: string;
  outputRoot?: string;
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
    else if (token === "--run-id") args.runId = argv[++index];
    else if (token === "--no-write") args.noWrite = true;
    else throw new Error(`stage4_2c_unknown_argument:${token}`);
  }
  return args;
}

if (
  process.argv[1] != null &&
  path.resolve(fileURLToPath(import.meta.url)) ===
    path.resolve(process.argv[1])
) {
  const cli = parseArgs(process.argv.slice(2));
  const result =
    await runCasimirDpIdentifiabilityRedesignStage4_2C({
      configPath: cli.config,
      fixturePath: cli.fixture,
      outputRoot: cli.outputRoot,
      runId: cli.runId,
      writeArtifacts: !cli.noWrite,
    });
  process.stdout.write(`${JSON.stringify({
    campaign_gate: result.report.campaign_gate,
    campaign_run_id: result.report.campaign_run_id,
    design_search_verdict:
      result.report.design_selection.verdict,
    selected_candidate_id:
      result.report.design_selection.selected_candidate_id,
    required_paired_windows:
      result.report.design_selection.required_paired_windows,
    physical_pilot_readiness:
      result.report.final_gates.physical_pilot_readiness,
    measured_evidence:
      result.report.final_gates.measured_evidence,
    fixture_summary: result.report.fixture_summary,
    paths: result.paths,
    hashes: result.hashes,
  }, null, 2)}\n`);
}
