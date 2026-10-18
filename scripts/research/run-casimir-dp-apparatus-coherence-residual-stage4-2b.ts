#!/usr/bin/env -S tsx

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  CasimirDpApparatusScaleTransportStage4_2BInput,
  evaluateCasimirDpApparatusScaleTransportStage4_2B,
} from "../../shared/casimir-dp-apparatus-scale-transport-stage4-2b";
import {
  CasimirDpApparatusSpectralThermometryStage4_2BInput,
  evaluateCasimirDpApparatusSpectralThermometryStage4_2B,
} from "../../shared/casimir-dp-apparatus-spectral-thermometry-stage4-2b";
import {
  CasimirDpApparatusResponseCovarianceStage4_2BInput,
  evaluateCasimirDpApparatusResponseCovarianceStage4_2B,
} from "../../shared/casimir-dp-apparatus-response-covariance-stage4-2b";
import {
  CASIMIR_DP_STAGE3_NAMED_MANIFEST_SHA256,
  CasimirDpDpScalingForecastStage4_2BInput,
  evaluateCasimirDpDpScalingForecastStage4_2B,
} from "../../shared/casimir-dp-dp-scaling-forecast-stage4-2b";
import {
  CasimirDpApparatusCoherenceResidualStage4_2BInput,
  evaluateCasimirDpApparatusCoherenceResidualStage4_2B,
  type CasimirDpApparatusCoherenceResidualStage4_2BInput as RuntimeEInput,
} from "../../shared/casimir-dp-apparatus-coherence-residual-stage4-2b";
import {
  CasimirDpApparatusIdentifiabilityStage4_2BInput,
  evaluateCasimirDpApparatusIdentifiabilityStage4_2B,
  type CasimirDpApparatusIdentifiabilityStage4_2BInput as RuntimeFInput,
} from "../../shared/casimir-dp-apparatus-identifiability-stage4-2b";
import {
  CasimirDpComplexCoherenceInput,
  evaluateCasimirDpComplexCoherence,
} from "../../shared/casimir-dp-complex-coherence";
import {
  convertLossTableToImaginaryAxis,
} from "../../shared/casimir-optical-response";
import {
  computeLifshitzEquilibrium,
} from "../../shared/casimir-lifshitz";
import {
  validateAcquisitionSidecar,
} from "../../shared/casimir-dp-data-readiness";
import {
  evaluateCasimirDpProposalReadiness,
} from "../../shared/casimir-dp-proposal-readiness";
import { HBAR } from "../../shared/physics-const";
import {
  CASIMIR_DP_APPARATUS_COHERENCE_RESIDUAL_STAGE4_2B_RUN_ORDER,
  CASIMIR_DP_STAGE4_2B_REQUIRED_AUTHORITY_ROLES,
  CASIMIR_DP_STAGE4_2B_REQUIRED_FIXTURE_CASE_IDS,
  CasimirDpApparatusCoherenceResidualStage4_2BConfig,
  type CasimirDpApparatusCoherenceResidualStage4_2BConfig as Stage4_2BConfig,
} from "../../shared/contracts/casimir-dp-apparatus-coherence-residual-stage4-2b.v1";

const execFileAsync = promisify(execFile);
const stableJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const hash = (character: string): string => character.repeat(64);
const clone = <T>(value: T): T => structuredClone(value);

type RuntimeAResult = ReturnType<
  typeof evaluateCasimirDpApparatusScaleTransportStage4_2B
>;
type RuntimeBResult = ReturnType<
  typeof evaluateCasimirDpApparatusSpectralThermometryStage4_2B
>;
type RuntimeCResult = ReturnType<
  typeof evaluateCasimirDpApparatusResponseCovarianceStage4_2B
>;
type RuntimeDResult = ReturnType<
  typeof evaluateCasimirDpDpScalingForecastStage4_2B
>;
type RuntimeEResult = ReturnType<
  typeof evaluateCasimirDpApparatusCoherenceResidualStage4_2B
>;

type SharedDesignCell = {
  row_index: number;
  cell_index: number;
  cell_id: string;
  partition_id: string;
  replication_id: string;
  pair_id: string;
  object_configuration_id: string;
  mass_kg: number;
  radius_m: number;
  branch_separation_id: string;
  branch_separation_m: number;
  hold_time_id: string;
  hold_time_s: number;
  sequence_kind: "ramsey" | "path_swap" | "echo";
  boundary_or_control_state_id: string;
  boundary_state: "on" | "off";
  nuisance_control_axis_id: "nominal";
  nuisance_control_level_id: "nominal";
  blind_boundary_label: string;
  boundary_order: "on_first" | "off_first";
  joint_state_receipt_sha256: string;
  delta_rho_receipt_sha256: string;
  analysis_role: "held_out";
};

type SharedControlCell = {
  cell_id: string;
  cell_index: number;
  partition_id: string;
  replication_id: string;
  object_configuration_id: string;
  nominal_mass_kg: number;
  nominal_radius_m: number;
  branch_separation_id: string;
  branch_separation_m: number;
  hold_time_id: string;
  hold_time_s: number;
  sequence_kind: "ramsey";
  boundary_or_control_state_id: string;
  nuisance_control_axis_id: string;
  nuisance_control_level_id: string;
  control_role: "nuisance_oaat" | "sham_switch" | "detuned_boundary";
  measured_evidence: "not_ready";
};

type PartitionCellTemplate = {
  template_index: number;
  template_cell_id: string;
  source_primary_cell_id: string;
  partition_id: "pilot_training" | "confirmatory_replication";
  replication_id: "pilot" | "independent_replication";
  analysis_role: "pilot" | "replication";
  pair_template_id: string;
  object_configuration_id: string;
  mass_kg: number;
  radius_m: number;
  branch_separation_id: string;
  branch_separation_m: number;
  hold_time_id: string;
  hold_time_s: number;
  sequence_kind: "ramsey" | "path_swap" | "echo";
  boundary_state: "on" | "off";
  artifact_namespace: string;
  artifact_identity_sha256: string;
  measured_evidence: "not_ready";
  instantiated: false;
  scored_with_primary_confirmatory: false;
  nuisance_refit_allowed: boolean;
};

type Stage4_2BDesignRegistry = {
  schema_version: "casimir_dp_stage4_2b_design_grid_registry/1";
  evidence_class: "design_assumption";
  measured_evidence: "not_ready";
  promotion_allowed: false;
  source_runtime_a_output_sha256: string;
  named_dp_density_prescription: "single_effective_gaussian_particle";
  apparatus_density_transport_role:
    "composition_and_branch_metadata_not_named_dp_radius_input";
  object_configurations: Array<{
    object_configuration_id: string;
    mass_kg: number;
    radius_m: number;
    scale_from_runtime_a: number;
    independent_metrology_required: true;
    metrology_receipt_status: "not_ready";
  }>;
  branch_separations: Array<{
    branch_separation_id: string;
    separation_m: number;
    scale_from_runtime_a: number;
  }>;
  hold_times: Array<{
    hold_time_id: string;
    hold_time_s: number;
  }>;
  sequence_kinds: ["ramsey", "path_swap", "echo"];
  paired_boundary_states: ["on", "off"];
  nuisance_control_axes: [
    "temperature",
    "pressure",
    "vibration",
    "charge",
    "distance",
    "polarization",
    "readout_power",
  ];
  independent_control_cells: Array<{
    control_id: string;
    role: "sham_switch" | "detuned_boundary";
    measured_evidence: "not_ready";
  }>;
  control_cells: SharedControlCell[];
  partition_cell_templates: {
    pilot: {
      partition_id: "pilot_training";
      replication_id: "pilot";
      artifact_namespace: string;
      cell_count: number;
      cell_order_sha256: string;
      cells: PartitionCellTemplate[];
    };
    independent_replication: {
      partition_id: "confirmatory_replication";
      replication_id: "independent_replication";
      artifact_namespace: string;
      cell_count: number;
      cell_order_sha256: string;
      cells: PartitionCellTemplate[];
    };
    primary_replication_and_pilot_ids_disjoint: true;
    artifact_namespaces_disjoint: true;
    primary_scoring_admission: "forbidden_until_separately_acquired";
  };
  pilot_partition: {
    partition_id: "pilot_training";
    replication_id: "pilot";
    scored_with_confirmatory: false;
    nuisance_fit_allowed: true;
  };
  replication_partition: {
    partition_id: "confirmatory_replication";
    replication_id: "independent_replication";
    independently_operated: true;
    planned: true;
    measured_evidence: "not_ready";
    scored_with_primary_confirmatory: false;
    nuisance_refit_allowed: false;
    receipt_sha256: string;
  };
  cells: SharedDesignCell[];
  cell_order_sha256: string;
  registry_sha256: string;
};

function buildStage4_2BDesignRegistry(
  config: Stage4_2BConfig,
  runtimeA: RuntimeAResult,
): Stage4_2BDesignRegistry {
  if (runtimeA.status !== "pass") {
    throw new Error("stage4_2b_design_registry_requires_runtime_a_pass");
  }
  const runtimeAOutputSha = sha256(stableJson(runtimeA));
  const nominalMass = runtimeA.object_ledger.total_mass_kg;
  const nominalRadius = runtimeA.object_ledger.characteristic_radius_m;
  const nominalSeparation =
    runtimeA.dimensionless_scale_vector.branch_separation_over_radius *
    nominalRadius;
  const nominalR0 =
    runtimeA.dimensionless_scale_vector.smearing_length_over_radius *
    nominalRadius;
  const nominalHold =
    runtimeA.dimensionless_scale_vector.c_hold_time_over_radius *
    nominalRadius / 299_792_458;
  const exact = (left: number, right: number, label: string) => {
    if (Math.abs(left - right) >
      1e-12 * Math.max(Math.abs(left), Math.abs(right), Number.MIN_VALUE)) {
      throw new Error(`stage4_2b_runtime_a_transport_mismatch:${label}`);
    }
  };
  exact(nominalMass, config.apparatus.nominal_mass_kg, "mass");
  exact(nominalRadius, config.apparatus.nominal_radius_m, "radius");
  exact(
    nominalSeparation,
    config.apparatus.nominal_branch_separation_m,
    "separation",
  );
  exact(nominalHold, config.apparatus.nominal_hold_time_s, "hold");
  exact(nominalR0, config.dp_applicability_manifest.r0_m, "r0");

  if (
    config.dp_applicability_manifest.density_prescription !==
      "single_effective_gaussian_particle" ||
    config.apparatus_density_transport.dp_dynamics_implication !==
      "none_stage3_single_effective_gaussian_particle_remains_named_dp_model" ||
    config.confirmatory_design_grid.cell_generation.physics_grid_policy !==
      "full_factorial_object_separation_hold_sequence_paired_boundary"
  ) {
    throw new Error("stage4_2b_exact_model_or_design_contract_mismatch");
  }
  const objectConfigurations =
    config.confirmatory_design_grid.object_configurations.map((object) => ({
      object_configuration_id: object.object_configuration_id,
      mass_kg: object.nominal_mass_kg,
      radius_m: object.nominal_radius_m,
      scale_from_runtime_a: object.nominal_mass_kg / nominalMass,
      independent_metrology_required:
        object.independent_metrology_required as true,
      metrology_receipt_status:
        object.metrology_receipt_status as "not_ready",
    }));
  const branchSeparations =
    config.confirmatory_design_grid.branch_separations.map((separation) => ({
      branch_separation_id: separation.branch_separation_id,
      separation_m: separation.separation_m,
      scale_from_runtime_a: separation.separation_m / nominalSeparation,
    }));
  const holdTimes = config.confirmatory_design_grid.hold_times.map((hold) => ({
    hold_time_id: hold.hold_time_id,
    hold_time_s: hold.hold_time_s,
  }));
  const sequenceKinds =
    config.confirmatory_design_grid.sequence_kinds;
  const primaryPartition =
    config.confirmatory_design_grid.partitions.find(
      (partition) => partition.role === "confirmatory_primary",
    );
  const pilotPartition =
    config.confirmatory_design_grid.partitions.find(
      (partition) => partition.role === "pilot_training",
    );
  const replicationPartition =
    config.confirmatory_design_grid.partitions.find(
      (partition) => partition.role === "confirmatory_replication",
    );
  if (
    primaryPartition == null ||
    pilotPartition == null ||
    replicationPartition == null
  ) {
    throw new Error("stage4_2b_required_partition_missing");
  }
  const pairedBoundaryStates =
    config.confirmatory_design_grid.boundary_pair.states;
  const cells: SharedDesignCell[] = [];
  let rowIndex = 0;
  let pairIndex = 0;
  for (const object of objectConfigurations) {
    for (const separation of branchSeparations) {
      for (const hold of holdTimes) {
        for (const sequenceKind of sequenceKinds) {
          const pairId = [
            primaryPartition.partition_id,
            primaryPartition.replication_id,
            object.object_configuration_id,
            separation.branch_separation_id,
            hold.hold_time_id,
            sequenceKind,
          ].join("__");
          const pairReceipt = sha256(stableJson({
            runtime_a_output_sha256: runtimeAOutputSha,
            pair_id: pairId,
            mass_kg: object.mass_kg,
            radius_m: object.radius_m,
            separation_m: separation.separation_m,
            hold_time_s: hold.hold_time_s,
            sequence_kind: sequenceKind,
          }));
          const boundaryOrder =
            pairIndex % 2 === 0 ? "on_first" as const : "off_first" as const;
          for (const boundaryAxis of pairedBoundaryStates) {
            const boundaryState =
              boundaryAxis.state_role === "active" ? "on" as const : "off" as const;
            const cellId = [
              primaryPartition.partition_id,
              primaryPartition.replication_id,
              object.object_configuration_id,
              separation.branch_separation_id,
              hold.hold_time_id,
              sequenceKind,
              boundaryAxis.boundary_state_id,
              "nominal",
              "nominal",
            ].join("__");
            cells.push({
              row_index: rowIndex,
              cell_index: rowIndex,
              cell_id: cellId,
              partition_id: primaryPartition.partition_id,
              replication_id: primaryPartition.replication_id,
              pair_id: pairId,
              object_configuration_id: object.object_configuration_id,
              mass_kg: object.mass_kg,
              radius_m: object.radius_m,
              branch_separation_id: separation.branch_separation_id,
              branch_separation_m: separation.separation_m,
              hold_time_id: hold.hold_time_id,
              hold_time_s: hold.hold_time_s,
              sequence_kind: sequenceKind,
              boundary_or_control_state_id:
                boundaryAxis.boundary_state_id,
              boundary_state: boundaryState,
              nuisance_control_axis_id: "nominal",
              nuisance_control_level_id: "nominal",
              blind_boundary_label: `blind-${rowIndex.toString().padStart(4, "0")}`,
              boundary_order: boundaryOrder,
              joint_state_receipt_sha256: pairReceipt,
              delta_rho_receipt_sha256: pairReceipt,
              analysis_role: "held_out",
            });
            rowIndex += 1;
          }
          pairIndex += 1;
        }
      }
    }
  }
  const cellOrderSha = sha256(stableJson(cells.map((cell) => cell.cell_id)));
  const nominalObject = objectConfigurations.find(
    (object) => object.mass_kg === nominalMass,
  );
  const nominalSeparationRow = branchSeparations.find(
    (separation) => separation.separation_m === nominalSeparation,
  );
  const nominalHoldRow = holdTimes.find(
    (hold) => hold.hold_time_s === nominalHold,
  );
  if (
    nominalObject == null ||
    nominalSeparationRow == null ||
    nominalHoldRow == null
  ) {
    throw new Error("stage4_2b_config_nominal_axis_sentinel_missing");
  }
  const controlCells: SharedControlCell[] = [];
  const pushControl = (args: {
    stateId: string;
    axisId: string;
    levelId: string;
    role: SharedControlCell["control_role"];
  }) => {
    const cellIndex = cells.length + controlCells.length;
    const cellId = [
      primaryPartition.partition_id,
      primaryPartition.replication_id,
      nominalObject.object_configuration_id,
      nominalSeparationRow.branch_separation_id,
      nominalHoldRow.hold_time_id,
      "ramsey",
      args.stateId,
      args.axisId,
      args.levelId,
    ].join("__");
    controlCells.push({
      cell_id: cellId,
      cell_index: cellIndex,
      partition_id: primaryPartition.partition_id,
      replication_id: primaryPartition.replication_id,
      object_configuration_id: nominalObject.object_configuration_id,
      nominal_mass_kg: nominalObject.mass_kg,
      nominal_radius_m: nominalObject.radius_m,
      branch_separation_id: nominalSeparationRow.branch_separation_id,
      branch_separation_m: nominalSeparationRow.separation_m,
      hold_time_id: nominalHoldRow.hold_time_id,
      hold_time_s: nominalHoldRow.hold_time_s,
      sequence_kind: "ramsey",
      boundary_or_control_state_id: args.stateId,
      nuisance_control_axis_id: args.axisId,
      nuisance_control_level_id: args.levelId,
      control_role: args.role,
      measured_evidence: "not_ready",
    });
  };
  for (const axis of config.confirmatory_design_grid.nuisance_control_axes) {
    for (const levelId of axis.level_ids) {
      for (const boundary of pairedBoundaryStates) {
        pushControl({
          stateId: boundary.boundary_state_id,
          axisId: axis.axis_id,
          levelId,
          role: "nuisance_oaat",
        });
      }
    }
  }
  pushControl({
    stateId:
      config.confirmatory_design_grid.boundary_controls.sham_switch
        .control_state_id,
    axisId: "nominal",
    levelId: "nominal",
    role: "sham_switch",
  });
  pushControl({
    stateId:
      config.confirmatory_design_grid.boundary_controls.detuned_boundary
        .control_state_id,
    axisId: "nominal",
    levelId: "nominal",
    role: "detuned_boundary",
  });
  const buildPartitionTemplate = (args: {
    partitionId: "pilot_training" | "confirmatory_replication";
    replicationId: "pilot" | "independent_replication";
    analysisRole: "pilot" | "replication";
    artifactNamespace: string;
    nuisanceRefitAllowed: boolean;
  }) =>
    cells.map((cell, templateIndex): PartitionCellTemplate => {
      const templateCellId = [
        args.partitionId,
        args.replicationId,
        ...cell.cell_id.split("__").slice(2),
      ].join("__");
      const pairTemplateId = [
        args.partitionId,
        args.replicationId,
        ...cell.pair_id.split("__").slice(2),
      ].join("__");
      const identityCore = {
        template_cell_id: templateCellId,
        source_primary_cell_id: cell.cell_id,
        artifact_namespace: args.artifactNamespace,
        measured_evidence: "not_ready",
        instantiated: false,
      };
      return {
        template_index: templateIndex,
        template_cell_id: templateCellId,
        source_primary_cell_id: cell.cell_id,
        partition_id: args.partitionId,
        replication_id: args.replicationId,
        analysis_role: args.analysisRole,
        pair_template_id: pairTemplateId,
        object_configuration_id: cell.object_configuration_id,
        mass_kg: cell.mass_kg,
        radius_m: cell.radius_m,
        branch_separation_id: cell.branch_separation_id,
        branch_separation_m: cell.branch_separation_m,
        hold_time_id: cell.hold_time_id,
        hold_time_s: cell.hold_time_s,
        sequence_kind: cell.sequence_kind,
        boundary_state: cell.boundary_state,
        artifact_namespace: args.artifactNamespace,
        artifact_identity_sha256: sha256(stableJson(identityCore)),
        measured_evidence: "not_ready",
        instantiated: false,
        scored_with_primary_confirmatory: false,
        nuisance_refit_allowed: args.nuisanceRefitAllowed,
      };
    });
  const pilotArtifactNamespace =
    "unacquired://stage4-2b/pilot-training";
  const replicationArtifactNamespace =
    "unacquired://stage4-2b/confirmatory-independent-replication";
  const pilotCellTemplates = buildPartitionTemplate({
    partitionId: "pilot_training",
    replicationId: "pilot",
    analysisRole: "pilot",
    artifactNamespace: pilotArtifactNamespace,
    nuisanceRefitAllowed: true,
  });
  const replicationCellTemplates = buildPartitionTemplate({
    partitionId: "confirmatory_replication",
    replicationId: "independent_replication",
    analysisRole: "replication",
    artifactNamespace: replicationArtifactNamespace,
    nuisanceRefitAllowed: false,
  });
  const primaryIds = new Set(cells.map((cell) => cell.cell_id));
  const pilotIds = new Set(
    pilotCellTemplates.map((cell) => cell.template_cell_id),
  );
  const replicationIds = new Set(
    replicationCellTemplates.map((cell) => cell.template_cell_id),
  );
  const partitionIdsDisjoint =
    [...pilotIds].every((id) => !primaryIds.has(id)) &&
    [...replicationIds].every(
      (id) => !primaryIds.has(id) && !pilotIds.has(id),
    );
  if (
    pilotCellTemplates.length !== cells.length ||
    replicationCellTemplates.length !== cells.length ||
    !partitionIdsDisjoint ||
    pilotArtifactNamespace === replicationArtifactNamespace
  ) {
    throw new Error("stage4_2b_partition_cell_template_failure");
  }
  const registryCore = {
    schema_version: "casimir_dp_stage4_2b_design_grid_registry/1" as const,
    evidence_class: "design_assumption" as const,
    measured_evidence: "not_ready" as const,
    promotion_allowed: false as const,
    source_runtime_a_output_sha256: runtimeAOutputSha,
    named_dp_density_prescription:
      "single_effective_gaussian_particle" as const,
    apparatus_density_transport_role:
      "composition_and_branch_metadata_not_named_dp_radius_input" as const,
    object_configurations: objectConfigurations,
    branch_separations: branchSeparations,
    hold_times: holdTimes,
    sequence_kinds: sequenceKinds,
    paired_boundary_states: ["on", "off"] as ["on", "off"],
    nuisance_control_axes:
      config.confirmatory_design_grid.nuisance_control_axes.map(
        (axis) => axis.axis_id,
      ) as Stage4_2BDesignRegistry["nuisance_control_axes"],
    independent_control_cells: [
      {
        control_id:
          config.confirmatory_design_grid.boundary_controls.sham_switch
            .control_state_id,
        role: "sham_switch" as const,
        measured_evidence: "not_ready" as const,
      },
      {
        control_id:
          config.confirmatory_design_grid.boundary_controls.detuned_boundary
            .control_state_id,
        role: "detuned_boundary" as const,
        measured_evidence: "not_ready" as const,
      },
    ],
    control_cells: controlCells,
    partition_cell_templates: {
      pilot: {
        partition_id: "pilot_training" as const,
        replication_id: "pilot" as const,
        artifact_namespace: pilotArtifactNamespace,
        cell_count: pilotCellTemplates.length,
        cell_order_sha256: sha256(stableJson(
          pilotCellTemplates.map((cell) => cell.template_cell_id),
        )),
        cells: pilotCellTemplates,
      },
      independent_replication: {
        partition_id: "confirmatory_replication" as const,
        replication_id: "independent_replication" as const,
        artifact_namespace: replicationArtifactNamespace,
        cell_count: replicationCellTemplates.length,
        cell_order_sha256: sha256(stableJson(
          replicationCellTemplates.map((cell) => cell.template_cell_id),
        )),
        cells: replicationCellTemplates,
      },
      primary_replication_and_pilot_ids_disjoint: true as const,
      artifact_namespaces_disjoint: true as const,
      primary_scoring_admission:
        "forbidden_until_separately_acquired" as const,
    },
    pilot_partition: {
      partition_id: pilotPartition.partition_id as "pilot_training",
      replication_id: pilotPartition.replication_id as "pilot",
      scored_with_confirmatory: false as const,
      nuisance_fit_allowed: true as const,
    },
    replication_partition: {
      partition_id:
        replicationPartition.partition_id as "confirmatory_replication",
      replication_id:
        replicationPartition.replication_id as "independent_replication",
      independently_operated: true as const,
      planned: true as const,
      measured_evidence: "not_ready" as const,
      scored_with_primary_confirmatory: false as const,
      nuisance_refit_allowed: false as const,
      receipt_sha256: sha256(stableJson({
        source_runtime_a_output_sha256: runtimeAOutputSha,
        partition_id: replicationPartition.partition_id,
        replication_id: replicationPartition.replication_id,
        measured_evidence: "not_ready",
      })),
    },
    cells,
    cell_order_sha256: cellOrderSha,
  };
  const registry = {
    ...registryCore,
    registry_sha256: sha256(stableJson(registryCore)),
  };
  if (
    new Set(cells.map((cell) => cell.cell_id)).size !== cells.length ||
    new Set(cells.map((cell) => cell.object_configuration_id)).size < 3 ||
    new Set(cells.map((cell) => cell.branch_separation_m)).size < 3 ||
    new Set(cells.map((cell) => cell.hold_time_s)).size < 4 ||
    !cells.some((cell) => cell.hold_time_s === 0) ||
    Math.max(...cells.map((cell) => cell.hold_time_s)) /
        Math.min(...cells.map((cell) => cell.hold_time_s).filter((value) => value > 0)) <
      4 ||
    !sequenceKinds.includes("path_swap") ||
    !sequenceKinds.includes("echo") ||
    controlCells.filter((cell) => cell.control_role === "nuisance_oaat")
        .length !==
      config.confirmatory_design_grid.nuisance_control_axes.reduce(
        (sum, axis) =>
          sum + axis.level_ids.length * pairedBoundaryStates.length,
        0,
      ) ||
    !controlCells.some((cell) => cell.control_role === "sham_switch") ||
    !controlCells.some((cell) => cell.control_role === "detuned_boundary")
  ) {
    throw new Error("stage4_2b_design_grid_not_ready");
  }
  return registry;
}

type AuthorityTuple = {
  role: string;
  path: string;
  sha256: string;
  tracked: boolean;
  required_at_runtime: true;
};

type AuthorityManifest = {
  schema_version: string;
  manifest_id: string;
  study_id: string;
  campaign_id: string;
  evidence_class: string;
  claim_ceiling: string;
  promotion_allowed: boolean;
  observable_bridge_edges_added: number;
  authority_mode: string;
  mutable_aliases_are_authority: boolean;
  upstream_authorities: AuthorityTuple[];
  scientific_boundaries: string[];
};

type SyntheticCase = {
  case_id:
    typeof CASIMIR_DP_STAGE4_2B_REQUIRED_FIXTURE_CASE_IDS[number];
  target_runtime: "A" | "B" | "C" | "D" | "E" | "F";
  mutation: string;
  expected_gate: "pass" | "blocked";
  expected_status:
    | "synthetic_recovery"
    | "false_residual_prevented"
    | "signature_not_identifiable"
    | "boundary_correlated_anomaly_only"
    | "conditional_boundary_identity_not_applicable"
    | "leakage_prevented"
    | "retuning_prevented"
    | "apparatus_not_powered_for_dp"
    | "sensor_noise_confound_prevented"
    | "not_identifiable"
    | "likelihood_not_covered";
  does_not_support: string;
};

type SyntheticMatrix = {
  schema_version: "casimir_dp_stage4_2b_synthetic_campaign/1";
  campaign_id:
    "casimir-dp-apparatus-coherence-residual-stage4-2b-v1";
  evidence_class: "synthetic_fixture";
  generated_at: string;
  measured_evidence: "not_ready";
  collapse_identification: "blocked";
  manifold_dynamics: "blocked";
  physical_viability: "not_evaluated";
  cases: SyntheticCase[];
};

export type Stage4_2BIntegrityRow = {
  role: string;
  path: string;
  expected_sha256: string | null;
  actual_sha256: string | null;
  required_at_runtime: boolean;
  tracked_expected: boolean | null;
  tracked_actual: boolean | null;
  gate: "pass" | "not_ready";
};

export const CASIMIR_DP_STAGE4_2B_OUTCOME_TO_CLAIM_MAP = [
  {
    outcome: "integrity_custody_covariance_or_convergence_failure",
    allowed_claim: "no_physical_conclusion",
    explicit_nonclaim: "no_bound_anomaly_dp_or_manifold_claim",
  },
  {
    outcome: "underpowered_forecast",
    allowed_claim:
      "current_apparatus_cannot_test_the_frozen_named_dp_region",
    explicit_nonclaim: "dp_is_not_thereby_false",
  },
  {
    outcome: "powered_measured_null",
    allowed_claim:
      "apparatus_specific_upper_bound_in_the_powered_preregistered_region",
    explicit_nonclaim:
      "standard_quantum_mechanics_is_not_universally_proved",
  },
  {
    outcome: "registered_ordinary_channel_tracks_residual",
    allowed_claim: "quantified_environmental_or_technical_coupling",
    explicit_nonclaim: "not_objective_collapse",
  },
  {
    outcome: "reproducible_unexplained_residual",
    allowed_claim:
      "anomaly_requiring_independent_replication_and_expanded_controls",
    explicit_nonclaim: "not_dp_quantum_foam_or_manifold_dynamics",
  },
  {
    outcome: "held_out_frozen_nonunitary_signature",
    allowed_claim:
      "objective_collapse_candidate_for_the_registered_discriminating_signature",
    explicit_nonclaim: "not_yet_gravitational_identification",
  },
  {
    outcome: "replicated_frozen_dp_scaling_and_powered_companion",
    allowed_claim: "evidence_favoring_the_named_dp_implementation",
    explicit_nonclaim:
      "not_generic_penrose_or_cosmology_or_orch_or",
  },
  {
    outcome: "complete_equivalence_boundary_residual_without_bridge",
    allowed_claim:
      "boundary_correlated_anomaly_with_registered_dp_contrast_cancelled",
    explicit_nonclaim:
      "not_a_casimir_dp_mechanism_or_other_model_theorem",
  },
  {
    outcome: "fixed_branch_registered_bridge_and_companion",
    allowed_claim: "evidence_for_that_specific_extension_only",
    explicit_nonclaim: "not_generic_manifold_control_or_quantum_gravity",
  },
] as const;

function assertRunOrder(config: Stage4_2BConfig): void {
  if (
    config.run_order.length !==
      CASIMIR_DP_APPARATUS_COHERENCE_RESIDUAL_STAGE4_2B_RUN_ORDER.length
  ) {
    throw new Error("stage4_2b_run_order_length_mismatch");
  }
  CASIMIR_DP_APPARATUS_COHERENCE_RESIDUAL_STAGE4_2B_RUN_ORDER.forEach(
    (stage, index) => {
      if (config.run_order[index] !== stage) {
        throw new Error(
          `stage4_2b_run_order[${index}]_must_be_${stage}`,
        );
      }
    },
  );
}

async function gitPathTracked(relativePath: string): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["ls-files", "--error-unmatch", "--", relativePath],
      { cwd: process.cwd(), windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}

async function currentGitHead(): Promise<string> {
  const result = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    windowsHide: true,
  });
  return result.stdout.trim();
}

async function worktreeState(): Promise<"clean" | "dirty"> {
  const result = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: process.cwd(),
    windowsHide: true,
  });
  return result.stdout.trim() === "" ? "clean" : "dirty";
}

async function integrityRow(args: {
  role: string;
  path: string;
  expectedSha256?: string | null;
  requiredAtRuntime: boolean;
  trackedExpected?: boolean | null;
}): Promise<Stage4_2BIntegrityRow> {
  try {
    const bytes = await readFile(path.resolve(args.path));
    const actual = sha256(bytes);
    const trackedActual = args.trackedExpected == null
      ? null
      : await gitPathTracked(args.path);
    const hashPass =
      args.expectedSha256 == null || args.expectedSha256 === actual;
    const trackingPass =
      args.trackedExpected == null ||
      args.trackedExpected === trackedActual;
    return {
      role: args.role,
      path: args.path.replace(/\\/g, "/"),
      expected_sha256: args.expectedSha256 ?? null,
      actual_sha256: actual,
      required_at_runtime: args.requiredAtRuntime,
      tracked_expected: args.trackedExpected ?? null,
      tracked_actual: trackedActual,
      gate: hashPass && trackingPass ? "pass" : "not_ready",
    };
  } catch {
    return {
      role: args.role,
      path: args.path.replace(/\\/g, "/"),
      expected_sha256: args.expectedSha256 ?? null,
      actual_sha256: null,
      required_at_runtime: args.requiredAtRuntime,
      tracked_expected: args.trackedExpected ?? null,
      tracked_actual: null,
      gate: "not_ready",
    };
  }
}

function comparableAuthorityTuple(tuple: AuthorityTuple) {
  return {
    role: tuple.role,
    path: tuple.path,
    sha256: tuple.sha256,
    tracked: tuple.tracked,
    required_at_runtime: tuple.required_at_runtime,
  };
}

function validateAuthorityManifest(
  config: Stage4_2BConfig,
  manifest: AuthorityManifest,
): void {
  if (
    manifest.schema_version !== "casimir_dp_stage4_2b_authorities/1" ||
    manifest.study_id !== config.study_id ||
    manifest.campaign_id !== config.campaign_id ||
    manifest.evidence_class !== config.evidence_class ||
    manifest.claim_ceiling !== config.claim_ceiling ||
    manifest.promotion_allowed !== false ||
    manifest.observable_bridge_edges_added !== 0 ||
    manifest.authority_mode !==
      "immutable_role_path_and_full_sha256_tuple" ||
    manifest.mutable_aliases_are_authority !== false
  ) {
    throw new Error("stage4_2b_authority_manifest_contract_failure");
  }
  const configured = config.upstream_authorities.map(
    comparableAuthorityTuple,
  );
  const manifested = manifest.upstream_authorities.map(
    comparableAuthorityTuple,
  );
  if (stableJson(configured) !== stableJson(manifested)) {
    throw new Error(
      "stage4_2b_authority_manifest_upstream_tuple_mismatch",
    );
  }
  const roles = manifested.map((row) => row.role);
  if (
    roles.length !== CASIMIR_DP_STAGE4_2B_REQUIRED_AUTHORITY_ROLES.length ||
    CASIMIR_DP_STAGE4_2B_REQUIRED_AUTHORITY_ROLES.some(
      (role, index) => roles[index] !== role,
    )
  ) {
    throw new Error("stage4_2b_authority_role_order_mismatch");
  }
  if (
    manifest.scientific_boundaries.length < 5 ||
    !manifest.scientific_boundaries.some((row) =>
      row.includes("conditional boundary identity")
    ) ||
    !manifest.scientific_boundaries.some((row) =>
      row.includes("Synthetic recovery")
    )
  ) {
    throw new Error(
      "stage4_2b_authority_manifest_scientific_boundaries_missing",
    );
  }
}

function validateSyntheticMatrix(
  config: Stage4_2BConfig,
  matrix: SyntheticMatrix,
): void {
  if (
    matrix.schema_version !== config.runtime_fixture.schema_version ||
    matrix.campaign_id !== config.campaign_id ||
    matrix.evidence_class !== "synthetic_fixture" ||
    matrix.measured_evidence !== "not_ready" ||
    matrix.collapse_identification !== "blocked" ||
    matrix.manifold_dynamics !== "blocked" ||
    matrix.physical_viability !== "not_evaluated"
  ) {
    throw new Error("stage4_2b_fixture_matrix_policy_mismatch");
  }
  if (matrix.cases.length !== 19) {
    throw new Error("stage4_2b_fixture_matrix_length_mismatch");
  }
  const ids = matrix.cases.map((row) => row.case_id);
  if (
    new Set(ids).size !== ids.length ||
    CASIMIR_DP_STAGE4_2B_REQUIRED_FIXTURE_CASE_IDS.some(
      (id, index) => ids[index] !== id,
    ) ||
    config.runtime_fixture.required_case_ids.some(
      (id, index) => ids[index] !== id,
    )
  ) {
    throw new Error("stage4_2b_fixture_matrix_case_mismatch");
  }
  for (const fixture of matrix.cases) {
    if (
      fixture.mutation.length === 0 ||
      fixture.does_not_support.length === 0
    ) {
      throw new Error(
        `stage4_2b_fixture_contract_incomplete:${fixture.case_id}`,
      );
    }
  }
}

function stageAReceipt(
  id: string,
  provenanceClass: "measured" | "design_class" | "simulated" =
    "design_class",
  digest = hash("a"),
) {
  return {
    receipt_id: id,
    artifact_path: `synthetic://${id}.json`,
    provenance_class: provenanceClass,
    expected_sha256: digest,
    actual_sha256: digest,
    integrity_verified: true,
  };
}

function buildRuntimeAInput(config: Stage4_2BConfig) {
  const mass = config.apparatus.nominal_mass_kg;
  const volume = 1e-21;
  const highDensity = 0.75 * mass / volume;
  const lowDensity = 0.25 * mass / volume;
  const authority = (
    id: "stage4_1" | "stage4_2a",
    role:
      | "stage4_1_downstream_verification_receipt"
      | "stage4_2a_downstream_verification_receipt",
  ) => {
    const row = config.upstream_authorities.find(
      (candidate) => candidate.role === role,
    );
    if (row == null) {
      throw new Error(`stage4_2b_missing_runtime_a_authority:${role}`);
    }
    return {
      authority_id: id,
      artifact_path: row.path,
      expected_sha256: row.sha256,
      actual_sha256: row.sha256,
      integrity_verified: true,
    };
  };
  const boundaryState = (
    id: "on" | "off",
    condition: "boundary_on" | "boundary_off",
  ) => {
    const cells = [
      {
        cell_id: "left",
        center_m: [-1e-8, 0, 0] as [number, number, number],
        volume_m3: volume,
        branch_a_density_kg_m3: highDensity,
        branch_b_density_kg_m3: lowDensity,
      },
      {
        cell_id: "right",
        center_m: [1e-8, 0, 0] as [number, number, number],
        volume_m3: volume,
        branch_a_density_kg_m3: lowDensity,
        branch_b_density_kg_m3: highDensity,
      },
    ];
    return {
      boundary_state_id: id,
      boundary_condition: condition,
      surface_distance_m:
        condition === "boundary_on"
          ? config.apparatus.nominal_surface_distance_m
          : 5e-3,
      orientation_unit_vector: [0, 0, 1] as [number, number, number],
      hold_time_s: config.apparatus.nominal_hold_time_s,
      density_provenance: "design_class" as const,
      density_receipt: stageAReceipt(`${id}-density`),
      wavepacket_receipt: stageAReceipt(`${id}-wavepacket`),
      trajectory_receipt: stageAReceipt(`${id}-trajectory`),
      preparation_fidelity: {
        preparation_class: "assumed_design" as const,
        fidelity: 0.99,
        standard_uncertainty: 0.005,
        receipt: stageAReceipt(`${id}-preparation`),
      },
      mobile_object_mass_a_kg: mass,
      mobile_object_mass_b_kg: mass,
      mobile_object_material_id: config.apparatus.object_material,
      expected_joint_branch_mass_kg: mass,
      density_cells: cells,
      branch_swap_probe: {
        branch_a_density_kg_m3: cells.map(
          (cell) => cell.branch_b_density_kg_m3,
        ),
        branch_b_density_kg_m3: cells.map(
          (cell) => cell.branch_a_density_kg_m3,
        ),
      },
      dp_binding: {
        mass_density_convention: "continuum_voxel_density",
        smearing_kernel_id: "gaussian-r0",
        smearing_kernel_sha256: hash("b"),
        trajectory_sha256: hash("c"),
        model_parameters_sha256:
          config.dp_applicability_manifest.stage3_manifest_sha256,
      },
    };
  };
  return CasimirDpApparatusScaleTransportStage4_2BInput.parse({
    schema_version:
      "casimir_dp_apparatus_scale_transport_stage4_2b_input/1",
    campaign_id:
      "casimir-dp-apparatus-scale-transport-stage4-2b-v1",
    evidence_class: "synthetic_fixture",
    claim_ceiling:
      "composition_aware_branch_density_parameter_transport_only",
    promotion_allowed: false,
    authority_bindings: [
      authority("stage4_1", "stage4_1_downstream_verification_receipt"),
      authority(
        "stage4_2a",
        "stage4_2a_downstream_verification_receipt",
      ),
    ],
    object: {
      object_id: "silica-75nm-design-class",
      material_id: config.apparatus.object_material,
      total_mass_kg: mass,
      total_mass_standard_uncertainty_kg: mass * 0.01,
      mass_accounting_basis: "measured_total_mass",
      density_provenance: "design_class",
      mass_receipt: stageAReceipt("mass", "measured"),
      composition_receipt: stageAReceipt("composition"),
      geometry_receipt: stageAReceipt("geometry"),
      characteristic_radius_m: config.apparatus.nominal_radius_m,
      shape: "sphere",
      porosity_fraction: 0,
      coating_thickness_m: 0,
      composition: [
        {
          component_id: "silica-bulk",
          material_id: config.apparatus.object_material,
          mass_fraction: 1,
          mass_fraction_standard_uncertainty: 0.001,
          accounting_role: "measured_bulk_component",
        },
      ],
    },
    scales: {
      branch_separation_m:
        config.apparatus.nominal_branch_separation_m,
      smearing_length_m: config.dp_applicability_manifest.r0_m,
      hold_time_s: config.apparatus.nominal_hold_time_s,
    },
    boundary_states: [
      boundaryState("off", "boundary_off"),
      boundaryState("on", "boundary_on"),
    ],
    registered_boundary_pair: {
      reference_state_id: "off",
      comparison_state_id: "on",
      complete_joint_system_equivalence_required: true,
    },
    sensitivity_budget: {
      dp_chi_per_l1_mismatch_kg: 1e18,
      ordinary_chi_per_l1_mismatch_kg: 1e16,
      convergence_l1_mass_error_kg: 1e-30,
      systematic_fraction:
        config.thresholds.branch_systematic_fraction_max,
      target_standard_uncertainty: 1e-3,
    },
    covariance_ancestry: [
      {
        ancestry_id: "mass-geometry-shared",
        quantity_ids: ["mass", "density", "radius"],
        relationship: "shared_ancestor",
        treatment: "full_cross_covariance",
      },
    ],
    unit_registry: {
      c_m_s: 299_792_458,
      hbar_J_s: HBAR,
      gravitational_constant_m3_kg_s2: 6.674_30e-11,
      kilogram_per_dalton: 1.660_539_066_60e-27,
      meter_per_nanometer: 1e-9,
    },
    tolerances: {
      mass_absolute_kg: 1e-30,
      mass_relative:
        config.thresholds.mass_conservation_relative_error_max,
      composition_absolute: 1e-12,
      branch_swap_absolute_kg: 1e-30,
      density_identity_absolute_kg: 1e-30,
      density_identity_relative:
        config.thresholds.numerical_null_relative_error_max,
      unit_relative: 1e-12,
    },
  });
}

const PLANCK_J_S = 6.626_070_15e-34;
const C_M_S = 299_792_458;
const BOLTZMANN_J_K = 1.380_649e-23;

function planckRadianceLambda(
  wavelengthM: number,
  temperatureK: number,
): number {
  const exponent =
    PLANCK_J_S * C_M_S /
    (wavelengthM * BOLTZMANN_J_K * temperatureK);
  return 2 * PLANCK_J_S * C_M_S ** 2 /
    wavelengthM ** 5 /
    Math.expm1(exponent);
}

function identity(dimension: number): number[][] {
  return Array.from(
    { length: dimension },
    (_, row) =>
      Array.from(
        { length: dimension },
        (_, column) => row === column ? 1 : 0,
      ),
  );
}

function stageBReceipt(id: string, digest = hash("a")) {
  return {
    receipt_id: id,
    artifact_path: `synthetic://${id}.json`,
    evidence_class: "synthetic_fixture" as const,
    expected_sha256: digest,
    actual_sha256: digest,
    integrity_verified: true,
  };
}

function buildThermometryTarget(args: {
  id: string;
  kind: "particle_internal" | "boundary_surface";
  temperatureK: number;
}) {
  const wavelengthM = [3, 5, 8, 12, 20, 40].map(
    (value) => value * 1e-6,
  );
  const binWidthM = wavelengthM.map((value) => value * 0.12);
  const baseArea = args.kind === "particle_internal" ? 1e-15 : 2e-10;
  const factors = [0.55, 0.9, 1.25, 1.5, 1.1, 0.7];
  const emissionArea = factors.map((factor) => baseArea * factor);
  const solidAngle = args.kind === "particle_internal" ? 0.02 : 0.01;
  const thermal = wavelengthM.map(
    (wavelength, index) =>
      solidAngle *
      emissionArea[index] *
      planckRadianceLambda(wavelength, args.temperatureK) *
      binWidthM[index],
  );
  const reflected = thermal.map((value) => value * 0.01);
  const stray = thermal.map((value) => value * 0.01);
  const detectorBackground = thermal.map((value) => value * 0.01);
  const detectorPower = thermal.map(
    (value, index) =>
      value +
      reflected[index] +
      stray[index] +
      detectorBackground[index],
  );
  const standardUncertainty = thermal.map(
    (value) => Math.max(value * 1e-3, 1e-35),
  );
  const covariance = standardUncertainty.map((sigma, row) =>
    standardUncertainty.map(
      (_otherSigma, column) => row === column ? sigma ** 2 : 0,
    )
  );
  return {
    target_id: args.id,
    target_kind: args.kind,
    spectrum_receipt: stageBReceipt(`${args.id}-spectrum`),
    detector_response_receipt: stageBReceipt(`${args.id}-response`),
    spectral_covariance_receipt: stageBReceipt(
      `${args.id}-covariance`,
    ),
    material_response_receipt: stageBReceipt(`${args.id}-material`),
    geometry_receipt: stageBReceipt(`${args.id}-geometry`),
    field_response_receipt: stageBReceipt(`${args.id}-field`),
    wavelength_m: wavelengthM,
    source_bin_width_m: binWidthM,
    source_bin_mask: wavelengthM.map(() => true),
    detector_power_W: detectorPower,
    detector_bin_mask: wavelengthM.map(() => true),
    detector_response_matrix: identity(wavelengthM.length),
    spectral_covariance_W2: covariance,
    source_reflected_power_W: reflected,
    source_stray_power_W: stray,
    detector_background_W: detectorBackground,
    collection_solid_angle_sr: solidAngle,
    emission_area_response_m2: emissionArea,
    absorption_cross_section_m2: factors.map(
      (factor) => 1e-15 * factor,
    ),
    scattering_cross_section_m2: factors.map(
      (factor) => 2e-16 * factor,
    ),
    wavelength_calibration: {
      frozen: true,
      coverage_frozen: true,
      masks_frozen: true,
      response_frozen: true,
      line_spread_function_included: true,
      throughput_included: true,
      polarization_response_included: true,
      gain_drift_model_included: true,
    },
    material_response: {
      model_kind:
        args.kind === "particle_internal"
          ? "complex_permittivity_mie" as const
          : "finite_geometry_emissivity" as const,
      non_blackbody_response_present: true,
      complex_response_or_cross_section_uncertainty_included: true,
    },
    thermal_state_model: {
      model_kind: "local_thermal_equilibrium" as const,
      valid_over_fit_window: true,
      model_receipt: null,
    },
    field_response: {
      regime: "near_boundary" as const,
      model_kind:
        "boundary_inclusive_dyadic_green_fdt" as const,
      boundary_included: true,
      free_space_recovery_demonstrated: false,
      free_space_recovery_relative_error: null,
      free_space_recovery_tolerance: 1e-3,
    },
    fit_contract: {
      minimum_temperature_K: 200,
      maximum_temperature_K: 400,
      temperature_grid_steps: 21,
      required_planck_x_interval: [2, 10] as [number, number],
      minimum_signal_to_background: 2,
      minimum_fisher_information_per_K2: 1e-6,
    },
  };
}

function buildRuntimeBInput(particleTemperatureK = 200) {
  return CasimirDpApparatusSpectralThermometryStage4_2BInput.parse({
    schema_version:
      "casimir_dp_apparatus_spectral_thermometry_stage4_2b_input/1",
    campaign_id:
      "casimir-dp-apparatus-spectral-thermometry-stage4-2b-v1",
    evidence_class: "synthetic_fixture",
    claim_ceiling:
      "response_corrected_apparatus_thermometry_and_thermal_coherence_forecast_only",
    promotion_allowed: false,
    acquisition_partition: "pilot",
    freeze_contract: {
      frozen_before_confirmatory_acquisition: true,
      candidate_exclusions_frozen: true,
      temperature_fit_code_sha256: hash("1"),
      row_order_sha256: hash("2"),
    },
    targets: [
      buildThermometryTarget({
        id: "particle",
        kind: "particle_internal",
        temperatureK: particleTemperatureK,
      }),
      buildThermometryTarget({
        id: "boundary",
        kind: "boundary_surface",
        temperatureK: 280,
      }),
    ],
    ownership_ledger: {
      unified_model_id: "thermal-green-response-v1",
      far_field_registered: true,
      near_field_registered: true,
      terms: [
        {
          term_id: "far-field-radiation",
          owners: ["far_field"],
          allocation_fractions: [1],
          treatment: "exclusive_owner",
        },
        {
          term_id: "near-field-green-correction",
          owners: ["near_field"],
          allocation_fractions: [1],
          treatment: "exclusive_owner",
        },
        {
          term_id: "matched-overlap-sector",
          owners: ["far_field", "near_field"],
          allocation_fractions: [0.35, 0.65],
          treatment: "shared_partitioned",
        },
      ],
    },
    kinetics: {
      particle_target_id: "particle",
      boundary_target_id: "boundary",
      branch_separation_m: 20e-9,
      hold_times_s: [0, 0.025, 0.1],
      boundary_to_particle_solid_angle_sr: 0.01,
      environment_incident_photon_flux_per_m2_s_m:
        new Array(6).fill(0),
      emission_kernel: "jump_localization",
      absorption_kernel: "jump_localization",
      scattering_kernel: "jump_localization",
      gaussian_diffusion_requested: false,
      diffusion_limit_validation: {
        status: "not_requested",
        maximum_relative_error: null,
        tolerance: 0.01,
        pilot_only: true,
      },
    },
    tolerances: {
      covariance_symmetry_relative: 1e-12,
      covariance_psd_relative: 1e-12,
      ownership_fraction_absolute: 1e-12,
      blackbody_recovery_relative: 1e-9,
    },
  });
}

type ComplexValue = { re: number; im: number };
const complex = (re: number, im = 0): ComplexValue => ({ re, im });
const matrix2 = (
  a: number,
  b: number,
  d: number,
): ComplexValue[][] => [
  [complex(a), complex(b)],
  [complex(b), complex(d)],
];
const identity2 = [
  [complex(1), complex(0)],
  [complex(0), complex(1)],
];
const zero2 = matrix2(0, 0, 0);

function stageCReceipt(
  source = "synthetic://receipt",
  digest = hash("a"),
) {
  return {
    source_ref: source,
    expected_sha256: digest,
    actual_sha256: digest,
    integrity_verified: true,
  };
}

function buildRuntimeCInput() {
  const omega = [-2, -1, 0, 1, 2];
  const selfNoise = matrix2(0.2e-68, 0, 0.1e-68);
  const observed = matrix2(2.2e-68, 0.5e-68, 1.1e-68);
  return CasimirDpApparatusResponseCovarianceStage4_2BInput.parse({
    schema_version:
      "casimir_dp_apparatus_response_covariance_stage4_2b/1",
    evidence_class: "synthetic_fixture",
    acquisition_audit: {
      clocks_synchronized: true,
      anti_alias_filter_verified: true,
      bandwidth_coverage_verified: true,
      response_phase_calibrated: true,
      response_phase_max_error_rad: 1e-4,
      response_phase_tolerance_rad: 1e-3,
      calibration_age_s: 10,
      maximum_calibration_age_s: 100,
      audit_receipt: stageCReceipt(
        "synthetic://acquisition-audit",
      ),
    },
    sensor_forward_model: {
      learned_from: "calibration_or_pilot",
      frozen_before_confirmatory: true,
      forward_model_receipt: stageCReceipt(
        "synthetic://sensor-model",
      ),
      channel_ids: ["vibration", "patch"],
      physical_units: ["m s^-2", "V"],
      spectrum_convention: "two_sided_angular_frequency",
      cross_covariances_explicit: true,
      physical_sensor_cross_disposition: "bounded_zero_with_receipt",
      physical_sensor_cross_receipt: stageCReceipt(
        "synthetic://cross-bound",
      ),
      hermiticity_relative_tolerance: 1e-10,
      psd_relative_tolerance: 1e-10,
      two_sided_frequency_absolute_tolerance_rad_s: 1e-12,
      two_sided_relative_tolerance: 1e-10,
      forward_recovery_relative_tolerance: 1e-10,
      samples: omega.map((omega_rad_s) => ({
        omega_rad_s,
        response: identity2,
        observed_cross_spectrum: observed,
        sensor_self_noise_cross_spectrum: selfNoise,
        physical_sensor_noise_cross_spectrum: zero2,
      })),
    },
    predecessor_reconciliation: {
      qed_green_noise: {
        module_id: "shared/casimir-dp-qed-green-noise.ts",
        role:
          "upstream_green_fdt_phase_noise_and_heating_prediction",
        output_receipt: stageCReceipt(
          "synthetic://green-fdt-output",
        ),
      },
      radiative_thermal_closure: {
        module_id:
          "shared/casimir-dp-radiative-thermal-closure.ts",
        role:
          "upstream_non_gaussian_thermal_localization_prediction",
        output_receipt: stageCReceipt("synthetic://thermal-output"),
      },
      scalar_predecessor_psd_used_as_full_covariance: false,
      duplicate_kernel_vote_counting_allowed: false,
    },
    gaussian_cells: [
      {
        cell_id: "cell-1",
        hold_time_s: 1,
        energy_transfer_J_per_physical_unit: omega.map(() => [
          complex(1),
          complex(0.25),
        ]),
        sequence_filter_abs2_s2: omega.map(() => 1),
        coherent_trace: {
          time_s: [0, 1],
          branch_a_energy_J: [HBAR, HBAR],
          branch_b_energy_J: [0, 0],
        },
        non_gaussian_contributions: [
          {
            contribution_id: "gas-1",
            process: "gas_collision",
            chi: 0.1,
            coherent_phase_rad: 0,
            diffusion_limit_used: false,
            diffusion_limit_validated: false,
            receipt: stageCReceipt("synthetic://gas-kernel"),
          },
          {
            contribution_id: "optical-1",
            process: "optical_recoil",
            chi: 0.02,
            coherent_phase_rad: 0,
            diffusion_limit_used: false,
            diffusion_limit_validated: false,
            receipt: stageCReceipt("synthetic://optical-kernel"),
          },
        ],
      },
    ],
    covariance: {
      row_cell_ids: ["cell-1"],
      measured_coherence_covariance: [[4]],
      ordinary_input_covariance: [[1]],
      measured_ordinary_cross_covariance: [[0.5]],
      ordinary_measured_cross_covariance: [[0.5]],
      ordinary_jacobian: [[2]],
      omitted_cross_covariance: false,
      common_calibration_ancestry_receipt: stageCReceipt(
        "synthetic://covariance-ancestry",
      ),
      maximum_condition_number: 1e6,
      symmetry_relative_tolerance: 1e-12,
      positive_definite_relative_tolerance: 1e-14,
      regularization: {
        kind: "none",
      },
    },
    channel_ownership: [
      {
        contribution_id: "thermal-radiation",
        category: "thermal",
        owner_runtime: "stage4_2b_runtime_b",
        process_class: "jump_localization",
        source_kind: "source_backed_model",
        shared_term_rule: null,
      },
      {
        contribution_id: "near-field-em-fdt",
        category: "near_field_em_fdt",
        owner_runtime: "stage4_2b_runtime_c",
        process_class: "gaussian_spectral",
        source_kind: "source_backed_model",
        shared_term_rule: null,
      },
      {
        contribution_id: "patch-spectrum",
        category: "patch_potential",
        owner_runtime: "stage4_2b_runtime_c",
        process_class: "gaussian_spectral",
        source_kind: "measured_transfer",
        shared_term_rule: null,
      },
      {
        contribution_id: "vibration-spectrum",
        category: "vibration_inertial",
        owner_runtime: "stage4_2b_runtime_c",
        process_class: "gaussian_spectral",
        source_kind: "measured_transfer",
        shared_term_rule: null,
      },
      {
        contribution_id: "gas-1",
        category: "residual_gas",
        owner_runtime: "stage4_2b_runtime_c",
        process_class: "jump_localization",
        source_kind: "source_backed_model",
        shared_term_rule: null,
      },
      {
        contribution_id: "optical-1",
        category: "optical",
        owner_runtime: "stage4_2b_runtime_c",
        process_class: "jump_localization",
        source_kind: "source_backed_model",
        shared_term_rule: null,
      },
      {
        contribution_id: "readout-response",
        category: "readout",
        owner_runtime: "stage4_2b_runtime_c",
        process_class: "gaussian_spectral",
        source_kind: "measured_transfer",
        shared_term_rule: null,
      },
    ],
    injection_checks: [
      {
        injection_id: "line-1",
        kind: "spectral_line",
        expected_frequency_rad_s: 1,
        recovered_frequency_rad_s: 1.001,
        maximum_frequency_error_rad_s: 0.01,
        expected_amplitude: 2,
        recovered_amplitude: 2.001,
        maximum_relative_amplitude_error: 0.01,
        expected_correlation: 0,
        recovered_correlation: 0,
        maximum_absolute_correlation_error: 0.01,
      },
      {
        injection_id: "correlated-1",
        kind: "correlated_channels",
        expected_frequency_rad_s: 1,
        recovered_frequency_rad_s: 1,
        maximum_frequency_error_rad_s: 0.01,
        expected_amplitude: 1,
        recovered_amplitude: 1,
        maximum_relative_amplitude_error: 0.01,
        expected_correlation: 0.5,
        recovered_correlation: 0.501,
        maximum_absolute_correlation_error: 0.01,
      },
    ],
  });
}

function identityMatrix(size: number, diagonal = 1): number[][] {
  return Array.from({ length: size }, (_, row) =>
    Array.from(
      { length: size },
      (_, column) => row === column ? diagonal : 0,
    )
  );
}

function buildCoupledRuntimeCInput(
  registry: Stage4_2BDesignRegistry,
  runtimeB: RuntimeBResult,
) {
  if (
    runtimeB.status !== "pass" ||
    runtimeB.thermal_jump_localization.status !== "ready"
  ) {
    throw new Error(
      `stage4_2b_runtime_b_not_ready_for_c_adapter:${stableJson({
        status: runtimeB.status,
        thermal_status: runtimeB.thermal_jump_localization.status,
        failures: runtimeB.failures,
      })}`,
    );
  }
  const rates = runtimeB.thermal_jump_localization.decoherence_rates_s;
  const runtimeBOutputSha = sha256(stableJson(runtimeB));
  const stableSinc = (value: number) => {
    const absolute = Math.abs(value);
    if (absolute < 1e-4) {
      const squared = value * value;
      return 1 - squared / 6 + squared * squared / 120;
    }
    return Math.sin(value) / value;
  };
  const nominalRadius = registry.object_configurations.find(
    (object) => Math.abs(object.scale_from_runtime_a - 1) <= 1e-12,
  )?.radius_m;
  if (nominalRadius == null) {
    throw new Error("stage4_2b_nominal_thermal_radius_missing");
  }
  const cellProcessRate = (
    cell: SharedDesignCell,
    process: "emission" | "absorption" | "scattering",
  ) => {
    const eventField = `${process}_rate_s` as
      | "emission_rate_s"
      | "absorption_rate_s"
      | "scattering_rate_s";
    const areaScale = (cell.radius_m / nominalRadius) ** 2;
    return areaScale *
      runtimeB.thermal_jump_localization.spectral_rows.reduce(
        (sum, row) =>
          sum + row[eventField] *
            (
              1 -
              stableSinc(
                2 * Math.PI * cell.branch_separation_m /
                  row.wavelength_m,
              )
            ),
        0,
      );
  };
  const thermalVectors = {
    emission: registry.cells.map((cell) =>
      cellProcessRate(cell, "emission") * cell.hold_time_s
    ),
    absorption: registry.cells.map((cell) =>
      cellProcessRate(cell, "absorption") * cell.hold_time_s
    ),
    scattering: registry.cells.map((cell) =>
      cellProcessRate(cell, "scattering") * cell.hold_time_s
    ),
  };
  const nominalCell = registry.cells.find((cell) =>
    cell.radius_m === nominalRadius &&
    cell.branch_separation_m ===
      registry.branch_separations.find(
        (separation) => separation.scale_from_runtime_a === 1,
      )?.separation_m
  );
  if (nominalCell == null) {
    throw new Error("stage4_2b_nominal_thermal_cell_missing");
  }
  for (const process of [
    "emission",
    "absorption",
    "scattering",
  ] as const) {
    assertClose(
      cellProcessRate(nominalCell, process),
      rates[process],
      `runtime-b-nominal-${process}-recovery`,
      1e-10,
      1e-15,
    );
  }
  const thermalAdapterCore = {
    schema_version: "casimir_dp_stage4_2b_runtime_b_to_c_adapter/1",
    source_runtime_b_output_sha256: runtimeBOutputSha,
    target_cell_registry_sha256: registry.registry_sha256,
    formula:
      "Gamma_process(cell)=(R_cell/R_nom)^2*sum_i[event_rate_process_i*(1-sinc(2*pi*Delta_x_cell/lambda_i))]; chi=Gamma*hold_time",
    source_rates_s: rates,
    cell_ids: registry.cells.map((cell) => cell.cell_id),
    chi_vectors: thermalVectors,
  };
  const thermalAdapter = {
    ...thermalAdapterCore,
    receipt_sha256: sha256(stableJson(thermalAdapterCore)),
  };
  const omega = [-2, -1, 0, 1, 2];
  const selfNoise = matrix2(0.2e-68, 0, 0.1e-68);
  const observed = matrix2(2.2e-68, 0.5e-68, 1.1e-68);
  const nominalMass = registry.object_configurations[1].mass_kg;
  const nominalSeparation = registry.branch_separations[1].separation_m;
  const sequenceScale = {
    ramsey: 1,
    path_swap: 0.7,
    echo: 0.25,
  } as const;
  const gaussianCells = registry.cells.map((cell, index) => {
    const massScale = cell.mass_kg / nominalMass;
    const separationScale =
      cell.branch_separation_m / nominalSeparation;
    const boundarySign = cell.boundary_state === "on" ? 1 : -1;
    const sequence = sequenceScale[cell.sequence_kind];
    const vibrationAmplitude =
      0.55 + 0.22 * massScale + 0.17 * separationScale +
      0.08 * boundarySign +
      (cell.sequence_kind === "path_swap"
        ? 0.13
        : cell.sequence_kind === "echo"
          ? -0.09
          : 0);
    const patchAmplitude =
      0.28 + 0.11 * massScale ** 2 + 0.31 * separationScale +
      0.12 * boundarySign * separationScale +
      (cell.sequence_kind === "echo" ? 0.07 : 0);
    const filter = cell.hold_time_s ** 2 * sequence;
    const gasChi = 0.003 * cell.hold_time_s *
      (
        1 + 0.31 / massScale + 0.07 * separationScale ** 2 +
        0.05 * boundarySign +
        (cell.sequence_kind === "path_swap" ? 0.09 : 0)
      );
    const readoutChi = 0.002 * cell.hold_time_s *
      (
        1 + 0.19 * massScale ** 2 + 0.27 * separationScale +
        0.13 * boundarySign +
        (cell.sequence_kind === "echo" ? 0.17 : 0)
      );
    const ordinaryPhase =
      0.015 * cell.hold_time_s *
      (
        boundarySign + 0.3 * separationScale +
        (cell.sequence_kind === "path_swap" ? -0.8 : 0) +
        (cell.sequence_kind === "echo" ? -0.2 : 0)
      );
    const receipt = (
      lane: string,
      digest = sha256(stableJson({
        registry_sha256: registry.registry_sha256,
        cell_id: cell.cell_id,
        lane,
      })),
    ) => stageCReceipt(
      `synthetic://stage4-2b/${lane}/${cell.cell_id}`,
      digest,
    );
    return {
      cell_id: cell.cell_id,
      hold_time_s: cell.hold_time_s,
      energy_transfer_J_per_physical_unit: omega.map(() => [
        complex(vibrationAmplitude),
        complex(patchAmplitude),
      ]),
      sequence_filter_abs2_s2: omega.map(() => filter),
      coherent_trace:
        cell.hold_time_s === 0
          ? {
            time_s: [0],
            branch_a_energy_J: [0],
            branch_b_energy_J: [0],
          }
          : {
            time_s: [0, cell.hold_time_s],
            branch_a_energy_J: [
              -HBAR * ordinaryPhase / cell.hold_time_s,
              -HBAR * ordinaryPhase / cell.hold_time_s,
            ],
            branch_b_energy_J: [0, 0],
          },
      non_gaussian_contributions: [
        {
          contribution_id: `thermal-emission:${cell.cell_id}`,
          process: "thermal_photon_emission" as const,
          chi: thermalVectors.emission[index],
          coherent_phase_rad: 0,
          diffusion_limit_used: false,
          diffusion_limit_validated: false,
          receipt: receipt("thermal-emission", thermalAdapter.receipt_sha256),
        },
        {
          contribution_id: `thermal-absorption:${cell.cell_id}`,
          process: "thermal_photon_absorption" as const,
          chi: thermalVectors.absorption[index],
          coherent_phase_rad: 0,
          diffusion_limit_used: false,
          diffusion_limit_validated: false,
          receipt: receipt("thermal-absorption", thermalAdapter.receipt_sha256),
        },
        {
          contribution_id: `thermal-scattering:${cell.cell_id}`,
          process: "thermal_photon_scattering" as const,
          chi: thermalVectors.scattering[index],
          coherent_phase_rad: 0,
          diffusion_limit_used: false,
          diffusion_limit_validated: false,
          receipt: receipt("thermal-scattering", thermalAdapter.receipt_sha256),
        },
        {
          contribution_id: `gas:${cell.cell_id}`,
          process: "gas_collision" as const,
          chi: gasChi,
          coherent_phase_rad: 0,
          diffusion_limit_used: false,
          diffusion_limit_validated: false,
          receipt: receipt("gas"),
        },
        {
          contribution_id: `readout:${cell.cell_id}`,
          process: "optical_recoil" as const,
          chi: readoutChi,
          coherent_phase_rad: 0,
          diffusion_limit_used: false,
          diffusion_limit_validated: false,
          receipt: receipt("readout"),
        },
      ],
    };
  });
  const rowCount = registry.cells.length;
  const measuredCovariance = identityMatrix(rowCount, 0.01);
  for (let index = 0; index < rowCount; index += 2) {
    measuredCovariance[index][index + 1] = 0.001;
    measuredCovariance[index + 1][index] = 0.001;
  }
  const ordinaryInputCovariance = identityMatrix(rowCount, 0.001);
  const measuredOrdinaryCross = identityMatrix(rowCount, 0.0001);
  const ownership = [
    {
      contribution_id: "vibration-spectrum",
      category: "vibration_inertial" as const,
      owner_runtime: "stage4_2b_runtime_c",
      process_class: "gaussian_spectral" as const,
      source_kind: "measured_transfer" as const,
      shared_term_rule: null,
    },
    {
      contribution_id: "patch-spectrum",
      category: "patch_potential" as const,
      owner_runtime: "stage4_2b_runtime_c",
      process_class: "gaussian_spectral" as const,
      source_kind: "measured_transfer" as const,
      shared_term_rule: null,
    },
    ...registry.cells.flatMap((cell) => [
      ...([
        "thermal-emission",
        "thermal-absorption",
        "thermal-scattering",
      ] as const).map((lane) => ({
        contribution_id: `${lane}:${cell.cell_id}`,
        category: "thermal" as const,
        owner_runtime: "stage4_2b_runtime_b",
        process_class: "jump_localization" as const,
        source_kind: "source_backed_model" as const,
        shared_term_rule: null,
      })),
      {
        contribution_id: `gas:${cell.cell_id}`,
        category: "residual_gas" as const,
        owner_runtime: "stage4_2b_runtime_c",
        process_class: "jump_localization" as const,
        source_kind: "source_backed_model" as const,
        shared_term_rule: null,
      },
      {
        contribution_id: `readout:${cell.cell_id}`,
        category: "readout" as const,
        owner_runtime: "stage4_2b_runtime_c",
        process_class: "jump_localization" as const,
        source_kind: "measured_transfer" as const,
        shared_term_rule: null,
      },
    ]),
  ];
  const input =
    CasimirDpApparatusResponseCovarianceStage4_2BInput.parse({
      schema_version:
        "casimir_dp_apparatus_response_covariance_stage4_2b/1",
      evidence_class: "synthetic_fixture",
      acquisition_audit: {
        clocks_synchronized: true,
        anti_alias_filter_verified: true,
        bandwidth_coverage_verified: true,
        response_phase_calibrated: true,
        response_phase_max_error_rad: 1e-4,
        response_phase_tolerance_rad: 1e-3,
        calibration_age_s: 10,
        maximum_calibration_age_s: 100,
        audit_receipt: stageCReceipt(
          "synthetic://acquisition-audit",
          registry.registry_sha256,
        ),
      },
      sensor_forward_model: {
        learned_from: "calibration_or_pilot",
        frozen_before_confirmatory: true,
        forward_model_receipt: stageCReceipt(
          "synthetic://sensor-model",
          registry.registry_sha256,
        ),
        channel_ids: ["vibration-spectrum", "patch-spectrum"],
        physical_units: ["m s^-2", "V"],
        spectrum_convention: "two_sided_angular_frequency",
        cross_covariances_explicit: true,
        physical_sensor_cross_disposition: "bounded_zero_with_receipt",
        physical_sensor_cross_receipt: stageCReceipt(
          "synthetic://cross-bound",
          registry.registry_sha256,
        ),
        hermiticity_relative_tolerance: 1e-10,
        psd_relative_tolerance: 1e-10,
        two_sided_frequency_absolute_tolerance_rad_s: 1e-12,
        two_sided_relative_tolerance: 1e-10,
        forward_recovery_relative_tolerance: 1e-10,
        samples: omega.map((omega_rad_s) => ({
          omega_rad_s,
          response: identity2,
          observed_cross_spectrum: observed,
          sensor_self_noise_cross_spectrum: selfNoise,
          physical_sensor_noise_cross_spectrum: zero2,
        })),
      },
      predecessor_reconciliation: {
        qed_green_noise: {
          module_id: "shared/casimir-dp-qed-green-noise.ts",
          role:
            "upstream_green_fdt_phase_noise_and_heating_prediction",
          output_receipt: stageCReceipt(
            "synthetic://green-fdt-output",
            registry.registry_sha256,
          ),
        },
        radiative_thermal_closure: {
          module_id:
            "shared/casimir-dp-radiative-thermal-closure.ts",
          role:
            "upstream_non_gaussian_thermal_localization_prediction",
          output_receipt: stageCReceipt(
            "synthetic://runtime-b-output",
            runtimeBOutputSha,
          ),
        },
        scalar_predecessor_psd_used_as_full_covariance: false,
        duplicate_kernel_vote_counting_allowed: false,
      },
      gaussian_cells: gaussianCells,
      covariance: {
        row_cell_ids: registry.cells.map((cell) => cell.cell_id),
        measured_coherence_covariance: measuredCovariance,
        ordinary_input_covariance: ordinaryInputCovariance,
        measured_ordinary_cross_covariance: measuredOrdinaryCross,
        ordinary_measured_cross_covariance: measuredOrdinaryCross,
        ordinary_jacobian: identityMatrix(rowCount),
        omitted_cross_covariance: false,
        common_calibration_ancestry_receipt: stageCReceipt(
          "synthetic://covariance-ancestry",
          sha256(stableJson({
            registry_sha256: registry.registry_sha256,
            runtime_b_output_sha256: runtimeBOutputSha,
          })),
        ),
        maximum_condition_number: 1e6,
        symmetry_relative_tolerance: 1e-12,
        positive_definite_relative_tolerance: 1e-14,
        regularization: { kind: "none" },
      },
      channel_ownership: ownership,
      injection_checks: [
        {
          injection_id: "line-1",
          kind: "spectral_line",
          expected_frequency_rad_s: 1,
          recovered_frequency_rad_s: 1.001,
          maximum_frequency_error_rad_s: 0.01,
          expected_amplitude: 2,
          recovered_amplitude: 2.001,
          maximum_relative_amplitude_error: 0.01,
          expected_correlation: 0,
          recovered_correlation: 0,
          maximum_absolute_correlation_error: 0.01,
        },
        {
          injection_id: "correlated-1",
          kind: "correlated_channels",
          expected_frequency_rad_s: 1,
          recovered_frequency_rad_s: 1,
          maximum_frequency_error_rad_s: 0.01,
          expected_amplitude: 1,
          recovered_amplitude: 1,
          maximum_relative_amplitude_error: 0.01,
          expected_correlation: 0.5,
          recovered_correlation: 0.501,
          maximum_absolute_correlation_error: 0.01,
        },
      ],
    });
  return { input, thermalAdapter };
}

function stageDReceipt(
  source = "synthetic://receipt",
  digest = hash("a"),
) {
  return {
    source_ref: source,
    expected_sha256: digest,
    actual_sha256: digest,
    integrity_verified: true,
  };
}

function buildDpCollapseInput(
  dims: number,
  voxelSize: number,
  commonShift = 0,
  identical = false,
  mass = 1e-17,
  separation = 1e-8,
) {
  const left = -separation / 2 + commonShift;
  const right = identical ? left : separation / 2 + commonShift;
  return {
    schema_version: "dp_collapse/1" as const,
    ell_m: 1e-9,
    grid: {
      dims: [dims, dims, dims] as [number, number, number],
      voxel_size_m: [voxelSize, voxelSize, voxelSize] as [
        number,
        number,
        number,
      ],
      origin_m: [0, 0, 0] as [number, number, number],
    },
    method: {
      kernel: "plummer" as const,
      max_voxels: 4096,
    },
    branch_a: {
      kind: "analytic" as const,
      primitives: [
        {
          kind: "gaussian" as const,
          mass_kg: mass,
          sigma_m: 1.5e-9,
          center_m: [left, 0, 0] as [number, number, number],
        },
      ],
    },
    branch_b: {
      kind: "analytic" as const,
      primitives: [
        {
          kind: "gaussian" as const,
          mass_kg: mass,
          sigma_m: 1.5e-9,
          center_m: [right, 0, 0] as [number, number, number],
        },
      ],
    },
  };
}

function buildRuntimeDInput(companionInput: unknown) {
  return CasimirDpDpScalingForecastStage4_2BInput.parse({
    schema_version: "casimir_dp_dp_scaling_forecast_stage4_2b/1",
    evidence_class: "synthetic_fixture",
    applicability_manifest: {
      model_id: "diosi_1989_gaussian_regularized_nondissipative",
      model_version: "1",
      generator: "newtonian_markovian_mass_density_dp",
      temporal_noise: "white_markovian",
      dissipation: "none",
      density_prescription: "single_effective_gaussian_particle",
      parameter_manifest_sha256:
        CASIMIR_DP_STAGE3_NAMED_MANIFEST_SHA256,
      applicability_receipt: stageDReceipt(
        "synthetic://applicability",
      ),
      boundary_extension: {
        kind: "unmodified_newtonian_mass_density_dp",
        boundary_variable_in_generator: false,
      },
    },
    freeze: {
      manifest_frozen_before_confirmatory: true,
      parameters_retuned_after_held_out: false,
      r0_retuned_after_held_out: false,
      amplitude_fitted_to_confirmatory: false,
      freeze_receipt: stageDReceipt("synthetic://freeze"),
    },
    branch_density_ledger: {
      ledger_receipt: stageDReceipt("synthetic://density-ledger"),
      cells: [
        {
          cell_id: "cell-boundary-a",
          blind_boundary_label: "boundary-A",
          boundary_equivalence_group: "fixed-branches",
          object_configuration_id: "object-1",
          mass_kg: 1e-17,
          radius_m: 5e-9,
          branch_separation_m: 1e-8,
          delta_rho_receipt_sha256: hash("a"),
          experimental_equivalence: {
            complete_joint_system_checked: true,
            density_trajectories_and_smearing_equivalent: true,
            branch_preparation_fidelity_class: "assumed",
            sensitivity_weighted_delta_chi: 1e-5,
            standard_uncertainty_chi: 1e-5,
            systematic_allocation_chi: 1e-3,
            receipt: stageDReceipt("synthetic://equivalence-a"),
          },
        },
        {
          cell_id: "cell-boundary-b",
          blind_boundary_label: "boundary-B",
          boundary_equivalence_group: "fixed-branches",
          object_configuration_id: "object-1",
          mass_kg: 1e-17,
          radius_m: 5e-9,
          branch_separation_m: 1e-8,
          delta_rho_receipt_sha256: hash("a"),
          experimental_equivalence: {
            complete_joint_system_checked: true,
            density_trajectories_and_smearing_equivalent: true,
            branch_preparation_fidelity_class: "assumed",
            sensitivity_weighted_delta_chi: -1e-5,
            standard_uncertainty_chi: 1e-5,
            systematic_allocation_chi: 1e-3,
            receipt: stageDReceipt("synthetic://equivalence-b"),
          },
        },
      ],
    },
    numerical_reconciliation: {
      stage2_convention: "plummer_softened_density_diagnostic",
      stage3_convention:
        "gaussian_regularized_nondissipative_named_dp",
      dp_collapse_role:
        "legacy_plummer_density_and_convergence_diagnostic_only",
      named_prediction_role:
        "stage3_gaussian_analytic_with_fourier_crosscheck",
      kernels_vote_counted_as_independent_confirmation: false,
      common_recovery_fixture_passed: true,
      source_backed_selection_reason:
        "The immutable Stage-3 Gaussian manifest supplies the frozen named dynamics; Plummer replay is retained only as a density and convergence diagnostic.",
      reconciliation_receipt: stageDReceipt(
        "synthetic://reconciliation",
      ),
    },
    numerical_contract: {
      minimum_resolutions: 3,
      convergence_relative_tolerance: 0.75,
      convergence_absolute_tolerance_J: 1e-44,
      identical_branch_absolute_tolerance_J: 1e-50,
      branch_symmetry_relative_tolerance: 1e-10,
      branch_symmetry_absolute_tolerance_J: 1e-50,
      maximum_mass_relative_error: 0.75,
      maximum_boundary_shell_mass_fraction: 0.15,
      maximum_subvoxel_relative_sensitivity: 0.75,
      maximum_subvoxel_absolute_sensitivity_J: 1e-44,
      boundary_null_relative_tolerance: 1e-12,
      boundary_null_absolute_tolerance_s: 1e-30,
    },
    identity_recovery_input: buildDpCollapseInput(9, 3e-9, 0, true),
    numerical_cases: [
      {
        case_id: "plummer-density-replay",
        cell_id: "cell-boundary-a",
        resolution_runs: [
          {
            resolution_id: "coarse",
            nominal_resolution_m: 4e-9,
            input_receipt: stageDReceipt("synthetic://coarse"),
            dp_input: buildDpCollapseInput(7, 4e-9),
          },
          {
            resolution_id: "medium",
            nominal_resolution_m: 3e-9,
            input_receipt: stageDReceipt("synthetic://medium"),
            dp_input: buildDpCollapseInput(9, 3e-9),
          },
          {
            resolution_id: "fine",
            nominal_resolution_m: 2e-9,
            input_receipt: stageDReceipt("synthetic://fine"),
            dp_input: buildDpCollapseInput(13, 2e-9),
          },
        ],
        subvoxel_shift_probe: {
          displacement_fraction_of_finest_voxel: 0.05,
          input_receipt: stageDReceipt("synthetic://subvoxel"),
          dp_input: buildDpCollapseInput(13, 2e-9, 0.1e-9),
        },
      },
    ],
    companion_input: companionInput,
    external_bound_ledger: [
      {
        bound_id: "xenonnt_2026_markovian_dp_radiation",
        source_ref: "doi:10.1103/2jm3-4976",
        confidence_level: 0.9,
        local_significance_sigma: 0.2,
        external_R0_lower_bound_m: 4.9e-10,
        parameter_map: {
          relation: "stage_r0_m=factor_times_external_R0_m",
          factor: 1,
          kernel_shape_match: true,
          width_convention_match: true,
          normalization_match: true,
          constituent_prescription_match: true,
          temporal_noise_convention_match: true,
          radiation_kernel_match: false,
          master_equation_version_match: true,
          receipt: stageDReceipt("synthetic://xenon-map"),
        },
      },
    ],
    companion_measurement_forecast: {
      observable: "heating_W",
      one_shot_standard_uncertainty: 1e-43,
      planned_independent_samples: 100,
      applicable_to_named_model: true,
      statistically_independent_of_coherence_channel: true,
      independence_receipt: stageDReceipt(
        "synthetic://companion-independence",
      ),
      minimum_support_snr: 5,
    },
  });
}

function buildCoupledRuntimeDInput(
  config: Stage4_2BConfig,
  registry: Stage4_2BDesignRegistry,
  runtimeA: RuntimeAResult,
  companionInput: unknown,
) {
  const runtimeAOutputSha = sha256(stableJson(runtimeA));
  if (runtimeAOutputSha !== registry.source_runtime_a_output_sha256) {
    throw new Error("stage4_2b_runtime_a_to_d_hash_lineage_failure");
  }
  const companion = clone(companionInput) as {
    parameter_manifest: {
      physical_regularization: { R0_m: number };
    };
    parameter_manifest_sha256: string;
    fixed_branch_boundary_cells: Array<{
      blind_boundary_label: string;
      delta_rho_receipt_sha256: string;
    }>;
  };
  if (
    companion.parameter_manifest_sha256 !==
      CASIMIR_DP_STAGE3_NAMED_MANIFEST_SHA256 ||
    companion.parameter_manifest.physical_regularization.R0_m !==
      config.dp_applicability_manifest.r0_m ||
    registry.named_dp_density_prescription !==
      "single_effective_gaussian_particle"
  ) {
    throw new Error("stage4_2b_exact_named_dp_model_mismatch");
  }
  companion.fixed_branch_boundary_cells = registry.cells.map((cell) => ({
    blind_boundary_label: cell.blind_boundary_label,
    delta_rho_receipt_sha256: cell.delta_rho_receipt_sha256,
  }));
  const nominalMass = runtimeA.object_ledger.total_mass_kg;
  const nominalRadius = runtimeA.object_ledger.characteristic_radius_m;
  const nominalSeparation =
    runtimeA.dimensionless_scale_vector.branch_separation_over_radius *
    nominalRadius;
  const numericalCell = registry.cells.find((cell) =>
    cell.mass_kg === nominalMass &&
    cell.branch_separation_m === nominalSeparation &&
    cell.sequence_kind === "ramsey" &&
    cell.boundary_state === "on"
  );
  if (numericalCell == null) {
    throw new Error("stage4_2b_nominal_numerical_cell_missing");
  }
  const input = CasimirDpDpScalingForecastStage4_2BInput.parse({
    schema_version: "casimir_dp_dp_scaling_forecast_stage4_2b/1",
    evidence_class: "synthetic_fixture",
    applicability_manifest: {
      model_id: "diosi_1989_gaussian_regularized_nondissipative",
      model_version: "1",
      generator: "newtonian_markovian_mass_density_dp",
      temporal_noise: "white_markovian",
      dissipation: "none",
      density_prescription: "single_effective_gaussian_particle",
      parameter_manifest_sha256:
        CASIMIR_DP_STAGE3_NAMED_MANIFEST_SHA256,
      applicability_receipt: stageDReceipt(
        "synthetic://registered-stage3-applicability",
        companion.parameter_manifest_sha256,
      ),
      boundary_extension: {
        kind: "unmodified_newtonian_mass_density_dp",
        boundary_variable_in_generator: false,
      },
    },
    freeze: {
      manifest_frozen_before_confirmatory: true,
      parameters_retuned_after_held_out: false,
      r0_retuned_after_held_out: false,
      amplitude_fitted_to_confirmatory: false,
      freeze_receipt: stageDReceipt(
        "synthetic://stage4-2b-design-registry-freeze",
        registry.registry_sha256,
      ),
    },
    branch_density_ledger: {
      cell_registry_sha256: registry.registry_sha256,
      ledger_receipt: stageDReceipt(
        "synthetic://runtime-a-output-and-design-registry",
        sha256(stableJson({
          runtime_a_output_sha256: runtimeAOutputSha,
          registry_sha256: registry.registry_sha256,
        })),
      ),
      cells: registry.cells.map((cell) => ({
        cell_id: cell.cell_id,
        blind_boundary_label: cell.blind_boundary_label,
        boundary_equivalence_group: cell.pair_id,
        object_configuration_id: cell.object_configuration_id,
        mass_kg: cell.mass_kg,
        radius_m: cell.radius_m,
        branch_separation_m: cell.branch_separation_m,
        hold_time_s: cell.hold_time_s,
        delta_rho_receipt_sha256: cell.delta_rho_receipt_sha256,
        experimental_equivalence: {
          complete_joint_system_checked: true,
          density_trajectories_and_smearing_equivalent: true,
          branch_preparation_fidelity_class: "assumed",
          sensitivity_weighted_delta_chi:
            cell.boundary_state === "on" ? 1e-5 : -1e-5,
          standard_uncertainty_chi: 1e-5,
          systematic_allocation_chi: 1e-3,
          receipt: stageDReceipt(
            `synthetic://equivalence/${cell.cell_id}`,
            cell.joint_state_receipt_sha256,
          ),
        },
      })),
    },
    numerical_reconciliation: {
      stage2_convention: "plummer_softened_density_diagnostic",
      stage3_convention:
        "gaussian_regularized_nondissipative_named_dp",
      dp_collapse_role:
        "legacy_plummer_density_and_convergence_diagnostic_only",
      named_prediction_role:
        "stage3_gaussian_analytic_with_fourier_crosscheck",
      kernels_vote_counted_as_independent_confirmation: false,
      common_recovery_fixture_passed: true,
      source_backed_selection_reason:
        "The immutable Stage-3 single-effective-Gaussian-particle manifest supplies the named dynamics. Runtime A transports mass and branch metadata; radius is reported as a model limitation and does not enter the named DP rate.",
      reconciliation_receipt: stageDReceipt(
        "synthetic://stage3-model-to-runtime-a-transport",
        sha256(stableJson({
          runtime_a_output_sha256: runtimeAOutputSha,
          stage3_parameter_manifest_sha256:
            companion.parameter_manifest_sha256,
          density_prescription: "single_effective_gaussian_particle",
          radius_enters_named_dp: false,
        })),
      ),
    },
    numerical_contract: {
      minimum_resolutions: 3,
      convergence_relative_tolerance: 0.75,
      convergence_absolute_tolerance_J: 1e-44,
      identical_branch_absolute_tolerance_J: 1e-50,
      branch_symmetry_relative_tolerance: 1e-10,
      branch_symmetry_absolute_tolerance_J: 1e-50,
      maximum_mass_relative_error: 0.75,
      maximum_boundary_shell_mass_fraction: 0.15,
      maximum_subvoxel_relative_sensitivity: 0.75,
      maximum_subvoxel_absolute_sensitivity_J: 1e-44,
      boundary_null_relative_tolerance: 1e-12,
      boundary_null_absolute_tolerance_s: 1e-30,
    },
    identity_recovery_input:
      buildDpCollapseInput(
        15,
        3e-9,
        0,
        true,
        nominalMass,
        nominalSeparation,
      ),
    numerical_cases: [{
      case_id: "plummer-density-replay-runtime-a-nominal",
      cell_id: numericalCell.cell_id,
      resolution_runs: [
        {
          resolution_id: "coarse",
          nominal_resolution_m: 4e-9,
          input_receipt: stageDReceipt(
            "synthetic://coarse",
            runtimeAOutputSha,
          ),
          dp_input: buildDpCollapseInput(
            15,
            4e-9,
            0,
            false,
            nominalMass,
            nominalSeparation,
          ),
        },
        {
          resolution_id: "medium",
          nominal_resolution_m: 3e-9,
          input_receipt: stageDReceipt(
            "synthetic://medium",
            runtimeAOutputSha,
          ),
          dp_input: buildDpCollapseInput(
            15,
            3e-9,
            0,
            false,
            nominalMass,
            nominalSeparation,
          ),
        },
        {
          resolution_id: "fine",
          nominal_resolution_m: 2e-9,
          input_receipt: stageDReceipt(
            "synthetic://fine",
            runtimeAOutputSha,
          ),
          dp_input: buildDpCollapseInput(
            15,
            2e-9,
            0,
            false,
            nominalMass,
            nominalSeparation,
          ),
        },
      ],
      subvoxel_shift_probe: {
        displacement_fraction_of_finest_voxel: 0.05,
        input_receipt: stageDReceipt(
          "synthetic://subvoxel",
          runtimeAOutputSha,
        ),
        dp_input: buildDpCollapseInput(
          15,
          2e-9,
          0.1e-9,
          false,
          nominalMass,
          nominalSeparation,
        ),
      },
    }],
    companion_input: companion,
    external_bound_ledger: [{
      bound_id: "xenonnt_2026_markovian_dp_radiation",
      source_ref: "doi:10.1103/2jm3-4976",
      confidence_level: 0.9,
      local_significance_sigma: 0.2,
      external_R0_lower_bound_m: 4.9e-10,
      parameter_map: {
        relation: "stage_r0_m=factor_times_external_R0_m",
        factor: 1,
        kernel_shape_match: true,
        width_convention_match: true,
        normalization_match: true,
        constituent_prescription_match: true,
        temporal_noise_convention_match: true,
        radiation_kernel_match: false,
        master_equation_version_match: true,
        receipt: stageDReceipt("synthetic://xenon-map"),
      },
    }],
    companion_measurement_forecast: {
      observable: "heating_W",
      one_shot_standard_uncertainty: 1e-43,
      planned_independent_samples: 100,
      applicable_to_named_model: true,
      statistically_independent_of_coherence_channel: true,
      independence_receipt: stageDReceipt(
        "synthetic://companion-independence",
      ),
      minimum_support_snr: 5,
    },
  });
  return {
    input,
    adapter: {
      schema_version: "casimir_dp_stage4_2b_runtime_a_to_d_adapter/1",
      source_runtime_a_output_sha256: runtimeAOutputSha,
      cell_registry_sha256: registry.registry_sha256,
      stage3_parameter_manifest_sha256:
        companion.parameter_manifest_sha256,
      nominal_tuple: {
        mass_kg: nominalMass,
        radius_m: nominalRadius,
        branch_separation_m: nominalSeparation,
        R0_m:
          runtimeA.dimensionless_scale_vector.smearing_length_over_radius *
          nominalRadius,
        hold_time_s:
          runtimeA.dimensionless_scale_vector.c_hold_time_over_radius *
          nominalRadius / 299_792_458,
      },
      radius_enters_named_dp_generator: false as const,
    },
  };
}

// Fixture-only Gaussian-likelihood input. Authoritative Runtime E is built
// exclusively by buildCoupledRuntimeEInput.
function buildFixtureOnlyGaussianEInput(): RuntimeEInput {
  const rows = [
    ["pair-a", "on", 0, 0.92, 0, 0],
    ["pair-a", "off", 0, 0.92, 0, 0],
    ["pair-b", "on", 0.05, 0.88, 0.04, 0.002],
    ["pair-b", "off", 0.05, 0.881, 0.04, 0.002],
    ["pair-c", "on", 0.1, 0.79, 0.08, 0.004],
    ["pair-c", "off", 0.1, 0.791, 0.08, 0.004],
    ["pair-d", "on", 0.2, 0.66, 0.16, 0.008],
    ["pair-d", "off", 0.2, 0.661, 0.16, 0.008],
  ] as const;
  return CasimirDpApparatusCoherenceResidualStage4_2BInput.parse({
    schema_version:
      "casimir_dp_apparatus_coherence_residual_stage4_2b/1",
    evidence_class: "synthetic_fixture",
    observations: [
      ...rows.map((
        [pairId, boundary, time, visibility, ordinary, dp],
        index,
      ) => {
        const phase = 0.01 * (index + 1);
        return {
          cell_id: `cell-${index}`,
          pair_id: pairId,
          joint_state_receipt_sha256:
            `${Math.floor(index / 2) + 1}`.repeat(64),
          analysis_role: "held_out",
          boundary_state: boundary,
          hold_time_s: time,
          visibility,
          reference_visibility: 0.92,
          phase_rad: phase,
          real_coherence: visibility * Math.cos(phase),
          imaginary_coherence: visibility * Math.sin(phase),
          ordinary_chi: ordinary,
          ordinary_phase_rad: phase,
          dp_chi: dp,
          bridge_chi: null,
          complete_joint_system_equivalence: true,
        };
      }),
      {
        cell_id: "pilot-cell",
        pair_id: "pilot-pair",
        joint_state_receipt_sha256: hash("9"),
        analysis_role: "pilot",
        boundary_state: "off",
        hold_time_s: 0.1,
        visibility: 0.9,
        reference_visibility: 0.92,
        phase_rad: 0,
        real_coherence: 0.9,
        imaginary_coherence: 0,
        ordinary_chi: 0.02,
        ordinary_phase_rad: 0,
        dp_chi: 0.004,
        bridge_chi: null,
        complete_joint_system_equivalence: false,
      },
    ],
    residual_covariance: [
      [0.01, 0.001, 0, 0, 0, 0, 0, 0],
      [0.001, 0.01, 0, 0, 0, 0, 0, 0],
      [0, 0, 0.01, 0.001, 0, 0, 0, 0],
      [0, 0, 0.001, 0.01, 0, 0, 0, 0],
      [0, 0, 0, 0, 0.015, 0.001, 0, 0],
      [0, 0, 0, 0, 0.001, 0.015, 0, 0],
      [0, 0, 0, 0, 0, 0, 0.02, 0.002],
      [0, 0, 0, 0, 0, 0, 0.002, 0.02],
    ],
    complex_covariance: null,
    covariance_receipt: {
      row_ids: Array.from(
        { length: 8 },
        (_, index) => `cell-${index}`,
      ),
      complex_row_ids: null,
      row_order_sha256: hash("d"),
      constructed_from_full_cross_covariance: true,
      jacobian_receipt_sha256: hash("e"),
      cross_covariance_receipt_sha256: hash("f"),
      condition_number_max: 100,
      shrinkage_or_jitter_frozen_from_pilot: true,
    },
    likelihood: {
      mode: "gaussian_log_visibility",
      gaussian_coverage_validated: true,
      minimum_covered_visibility: 0.5,
      coverage_probability: 0.95,
      coherence_consistency_tolerance: 1e-8,
    },
    design_grid: {
      minimum_distinct_hold_times: 4,
      minimum_positive_hold_time_span_ratio: 4,
      zero_time_intercept_required: true,
    },
    replication_partition: {
      partition_id: "fixture-replication-template",
      replication_id: "fixture-independent-replication",
      independently_operated: true,
      planned: true,
      measured_evidence: "not_ready",
      scored_with_primary_confirmatory: false,
      nuisance_refit_allowed: false,
      receipt_sha256: hash("8"),
    },
    freeze: {
      pilot_fit_completed_at: "2026-07-01T00:00:00.000Z",
      analysis_frozen_at: "2026-07-02T00:00:00.000Z",
      confirmatory_acquired_at: "2026-07-03T00:00:00.000Z",
      nuisance_parameters_frozen: true,
      sensor_model_frozen: true,
      covariance_frozen: true,
      exclusions_frozen: true,
      predictions_frozen: true,
      cell_order_frozen: true,
      scoring_code_sha256: hash("a"),
      prediction_vector_sha256: hash("b"),
      automatic_unblinding_allowed: false,
      synthetic_contract_only: true,
    },
    dp_predictor: {
      manifest_sha256:
        CASIMIR_DP_STAGE3_NAMED_MANIFEST_SHA256,
      generator: "nonrelativistic_markovian_mass_density_dp",
      boundary_variable_in_unmodified_generator: false,
      fitted_amplitude_allowed: false,
      fitted_amplitude: 1,
      r0_retuned_after_freeze: false,
      branch_provenance_complete: false,
      boundary_identity_absolute_tolerance: 1e-15,
    },
    bridge: {
      role: "none",
      admitted: false,
      kernel_sha256: null,
    },
  });
}

function assertClose(
  left: number,
  right: number,
  label: string,
  relativeTolerance = 1e-11,
  absoluteTolerance = 1e-15,
): void {
  if (
    Math.abs(left - right) >
      absoluteTolerance +
        relativeTolerance *
          Math.max(Math.abs(left), Math.abs(right), Number.MIN_VALUE)
  ) {
    throw new Error(`stage4_2b_numeric_lineage_failure:${label}`);
  }
}

function extractRuntimeCOrdinaryLaneVectors(
  registry: Stage4_2BDesignRegistry,
  runtimeC: RuntimeCResult,
) {
  if (
    runtimeC.status !== "pass" ||
    runtimeC.cell_predictions.length !== registry.cells.length
  ) {
    throw new Error("stage4_2b_runtime_c_not_ready_for_lane_adapter");
  }
  const ownership = new Map(
    runtimeC.channel_ownership_ledger.map((row) => [
      row.contribution_id,
      row.category,
    ]),
  );
  const lanes = {
    thermal: [] as number[],
    electromagnetic: [] as number[],
    vibration: [] as number[],
    gas: [] as number[],
    readout: [] as number[],
  };
  runtimeC.cell_predictions.forEach((prediction, index) => {
    const cell = registry.cells[index];
    if (
      prediction.cell_id !== cell.cell_id ||
      prediction.total_ordinary_chi == null ||
      prediction.gaussian_chi == null ||
      prediction.non_gaussian_chi == null ||
      prediction.cross_channel_gaussian_chi == null
    ) {
      throw new Error(
        `stage4_2b_runtime_c_cell_order_or_value_failure:${cell.cell_id}`,
      );
    }
    let thermal = 0;
    let gas = 0;
    let readout = 0;
    for (const contribution of prediction.non_gaussian_contribution_rows) {
      if (contribution.receipt_gate !== "pass") {
        throw new Error(
          `stage4_2b_runtime_c_contribution_receipt_failure:${contribution.contribution_id}`,
        );
      }
      const category = ownership.get(contribution.contribution_id);
      if (category === "thermal") thermal += contribution.chi;
      else if (category === "residual_gas") gas += contribution.chi;
      else if (category === "readout" || category === "optical") {
        readout += contribution.chi;
      } else {
        throw new Error(
          `stage4_2b_runtime_c_unmapped_non_gaussian_lane:${contribution.contribution_id}`,
        );
      }
    }
    let vibration = 0;
    let electromagnetic = prediction.cross_channel_gaussian_chi;
    for (const channel of prediction.per_channel_gaussian_chi) {
      if (channel.chi == null) {
        throw new Error(
          `stage4_2b_runtime_c_null_gaussian_lane:${channel.channel_id}`,
        );
      }
      const category = ownership.get(channel.channel_id);
      if (category === "vibration_inertial") vibration += channel.chi;
      else if (
        category === "patch_potential" ||
        category === "near_field_em_fdt"
      ) {
        electromagnetic += channel.chi;
      } else {
        throw new Error(
          `stage4_2b_runtime_c_unmapped_gaussian_lane:${channel.channel_id}`,
        );
      }
    }
    assertClose(
      thermal + electromagnetic + vibration + gas + readout,
      prediction.total_ordinary_chi,
      `ordinary-lane-sum:${cell.cell_id}`,
      1e-10,
      1e-14,
    );
    lanes.thermal.push(thermal);
    lanes.electromagnetic.push(electromagnetic);
    lanes.vibration.push(vibration);
    lanes.gas.push(gas);
    lanes.readout.push(readout);
  });
  return lanes;
}

function quadratureCounts(
  real: number,
  imaginary: number,
  total = 20_000_000,
) {
  const count = (response: number) => {
    const bounded = Math.max(-1, Math.min(1, response));
    const plus = Math.round(total * (1 + bounded) / 2);
    return {
      plus_count: plus,
      minus_count: total - plus,
    };
  };
  return [
    { analysis_phase_rad: 0, ...count(real) },
    { analysis_phase_rad: Math.PI / 2, ...count(-imaginary) },
    { analysis_phase_rad: Math.PI, ...count(-real) },
    { analysis_phase_rad: 3 * Math.PI / 2, ...count(imaginary) },
  ];
}

function buildCoupledRuntimeEInput(
  config: Stage4_2BConfig,
  registry: Stage4_2BDesignRegistry,
  runtimeC: RuntimeCResult,
  runtimeD: RuntimeDResult,
) {
  const cOutputSha = sha256(stableJson(runtimeC));
  const dOutputSha = sha256(stableJson(runtimeD));
  const cRows = runtimeC.cell_predictions;
  const dRows = runtimeD.named_dp_prediction.rows;
  if (
    runtimeC.status !== "pass" ||
    runtimeD.gate !== "pass" ||
    runtimeD.named_dp_prediction.cell_registry_sha256 !==
      registry.registry_sha256 ||
    cRows.length !== registry.cells.length ||
    dRows.length !== registry.cells.length
  ) {
    throw new Error(
      `stage4_2b_c_or_d_not_ready_for_runtime_e:${stableJson({
        c_status: runtimeC.status,
        c_first_failure: runtimeC.first_failure,
        c_rows: cRows.length,
        d_gate: runtimeD.gate,
        d_first_failure: runtimeD.first_failure,
        d_numerical_cases:
          runtimeD.numerical_density_diagnostic.cases,
        d_rows: dRows.length,
        registry_rows: registry.cells.length,
        d_registry_sha256:
          runtimeD.named_dp_prediction.cell_registry_sha256,
        registry_sha256: registry.registry_sha256,
      })}`,
    );
  }
  const dpChi = registry.cells.map((cell, index) => {
    const cRow = cRows[index];
    const dRow = dRows[index];
    if (
      cRow.cell_id !== cell.cell_id ||
      dRow.cell_id !== cell.cell_id ||
      dRow.cell_registry_sha256 !== registry.registry_sha256 ||
      dRow.parameter_manifest_sha256 !==
        CASIMIR_DP_STAGE3_NAMED_MANIFEST_SHA256
    ) {
      throw new Error(
        `stage4_2b_c_d_registry_order_failure:${cell.cell_id}`,
      );
    }
    assertClose(dRow.hold_time_s, cell.hold_time_s, `d-hold:${cell.cell_id}`);
    assertClose(dRow.mass_kg, cell.mass_kg, `d-mass:${cell.cell_id}`);
    assertClose(
      dRow.branch_separation_m,
      cell.branch_separation_m,
      `d-separation:${cell.cell_id}`,
    );
    assertClose(
      dRow.chi_DP,
      dRow.Gamma_DP_s * cell.hold_time_s,
      `d-chi:${cell.cell_id}`,
    );
    return dRow.chi_DP;
  });
  const referenceVisibility = 0.92;
  const targetComplex = registry.cells.map((cell, index) => {
    const ordinary = cRows[index];
    if (
      ordinary.total_ordinary_chi == null ||
      ordinary.ordinary_coherent_phase_rad == null
    ) {
      throw new Error(
        `stage4_2b_runtime_c_null_prediction:${cell.cell_id}`,
      );
    }
    const visibility = referenceVisibility *
      Math.exp(-ordinary.total_ordinary_chi);
    const phase = ordinary.ordinary_coherent_phase_rad;
    return {
      real: visibility * Math.cos(phase),
      imaginary: visibility * Math.sin(phase),
      visibility,
      phase,
    };
  });
  const quadratureInput = CasimirDpComplexCoherenceInput.parse({
    schema_version: "casimir_dp_complex_coherence/1",
    primary_boundary_state: registry.cells[0].cell_id,
    object_receipt: {
      campaign_id: config.campaign_id,
      object_id:
        "algorithm-only-four-quadrature-recovery-multi-cell-stage4-2b",
      mass_kg: config.apparatus.nominal_mass_kg,
      density_profile_ref:
        "synthetic://algorithm-only/not-per-cell-physics-authority",
      density_profile_sha256: registry.registry_sha256,
      branch_separation_m:
        config.apparatus.nominal_branch_separation_m,
      branch_receipt_ref:
        "synthetic://algorithm-only/stage4-2b-quadrature-recovery",
      branch_receipt_sha256: registry.registry_sha256,
    },
    phase_calibration: {
      source_ref: "synthetic://stage4-2b/phase-calibration",
      standard_uncertainty_rad: 1e-6,
    },
    phase_conditioner: {
      mode: "none",
      source_ref: null,
      artifact_sha256: null,
      trained_block_ids: [],
    },
    decay_shape_gate: {
      minimum_distinct_hold_times: 4,
      minimum_time_span_s: config.apparatus.nominal_hold_time_s,
      minimum_signal_to_noise: 1,
      maximum_basis_correlation: 0.999,
    },
    uncertainty_model: {
      method: "binomial_plus_cluster_sandwich",
      interval_standard_deviations: 1.96,
      minimum_clusters_per_cell: 2,
    },
    nuisance_gate: {
      minimum_blocks: 3,
      minimum_distinct_values: 2,
      required_numeric_channels: [
        "surface_distance_m",
        "temperature_K",
        "pressure_Pa",
        "vibration_rms_m",
      ],
    },
    decision_thresholds: {
      coherent_phase_rad: 0.01,
      phase_conditioning_visibility_gain: 0.01,
      echo_visibility_gain: 0.01,
      visibility_loss_fraction: 0.01,
      path_swap_phase_error_rad: 0.01,
      path_swap_visibility_error: 0.01,
    },
    provenance: {
      evidence_class: "synthetic_fixture",
      raw_expected_sha256: sha256(stableJson(targetComplex)),
      raw_actual_sha256: sha256(stableJson(targetComplex)),
      calibration_expected_sha256: registry.registry_sha256,
      calibration_actual_sha256: registry.registry_sha256,
      covariance_expected_sha256: cOutputSha,
      covariance_actual_sha256: cOutputSha,
      receipt_integrity_verified: true,
    },
    blocks: registry.cells.flatMap((cell, index) =>
      [0, 1].map((clusterIndex) => ({
        block_id: `${cell.cell_id}__quadrature-cluster-${clusterIndex}`,
        blind_boundary_state: cell.cell_id,
        hold_time_s: cell.hold_time_s,
        cluster_id: `${cell.cell_id}__cluster-${clusterIndex}`,
        analysis_role: "held_out" as const,
        path_orientation:
          cell.sequence_kind === "path_swap" ? -1 as const : 1 as const,
        path_swap: cell.sequence_kind === "path_swap",
        echo_pair_id:
          cell.sequence_kind === "echo" ? `echo-pair:${cell.pair_id}` : null,
        echo_sequence_id:
          cell.sequence_kind === "echo" ? `echo:${cell.cell_id}` : null,
        toggling_function_ref:
          cell.sequence_kind === "echo"
            ? `synthetic://echo/${cell.cell_id}`
            : null,
        toggling_function_sha256:
          cell.sequence_kind === "echo"
            ? sha256(stableJson({
              cell_id: cell.cell_id,
              sequence_kind: cell.sequence_kind,
            }))
            : null,
        static_boundary_confirmed: true,
        phase_predictor_rad: null,
        nuisances: {
          surface_distance_m:
            config.apparatus.nominal_surface_distance_m *
            (1 + 0.001 * (index % 3)),
          material_id: config.apparatus.object_material,
          temperature_K:
            config.apparatus.nominal_environment_temperature_K +
            (index % 2),
          net_charge_C: (index % 3 - 1) * 1e-20,
          pressure_Pa: 1e-9 * (1 + index % 2),
          vibration_rms_m: 1e-12 * (1 + index % 3),
          laser_phase_rad: 1e-4 * (index % 4),
        },
        quadratures: quadratureCounts(
          targetComplex[index].real,
          targetComplex[index].imaginary,
        ),
      }))
    ),
  });
  const quadratureResult =
    evaluateCasimirDpComplexCoherence(quadratureInput);
  const summaryByCell = new Map(
    quadratureResult.summaries.map((summary) => [
      summary.blind_boundary_state,
      summary,
    ]),
  );
  const observationRows = registry.cells.map((cell) => {
    const summary = summaryByCell.get(cell.cell_id);
    const value = summary?.raw;
    if (
      summary == null ||
      value == null ||
      value.covariance_components.cluster_gate !== "pass"
    ) {
      throw new Error(
        `stage4_2b_complex_coherence_cell_not_ready:${cell.cell_id}`,
      );
    }
    return {
      cell,
      value,
    };
  });
  const residualCovariance = runtimeC.residual_covariance.matrix;
  if (
    runtimeC.residual_covariance.gate !== "pass" ||
    residualCovariance.length !== registry.cells.length
  ) {
    throw new Error("stage4_2b_runtime_c_residual_covariance_not_ready");
  }
  const complexDimension = registry.cells.length * 2;
  const complexCovariance = Array.from(
    { length: complexDimension },
    () => Array(complexDimension).fill(0),
  );
  const sharedPhaseCalibrationVariance = 1e-12;
  for (let left = 0; left < registry.cells.length; left += 1) {
    const leftValue = observationRows[left].value;
    const leftDerivative = [-leftValue.real, -leftValue.imaginary];
    const leftPhaseDerivative = [
      -leftValue.imaginary,
      leftValue.real,
    ];
    for (let right = 0; right < registry.cells.length; right += 1) {
      const rightValue = observationRows[right].value;
      const rightDerivative = [-rightValue.real, -rightValue.imaginary];
      const rightPhaseDerivative = [
        -rightValue.imaginary,
        rightValue.real,
      ];
      for (let leftComponent = 0; leftComponent < 2; leftComponent += 1) {
        for (
          let rightComponent = 0;
          rightComponent < 2;
          rightComponent += 1
        ) {
          complexCovariance[2 * left + leftComponent][
            2 * right + rightComponent
          ] =
            leftDerivative[leftComponent] *
            residualCovariance[left][right] *
            rightDerivative[rightComponent] +
            leftPhaseDerivative[leftComponent] *
            sharedPhaseCalibrationVariance *
            rightPhaseDerivative[rightComponent];
        }
      }
    }
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < 2; column += 1) {
        complexCovariance[2 * left + row][2 * left + column] +=
          leftValue.covariance_components.binomial_measurement[row][column] +
          leftValue.covariance_components.cluster_sandwich[row][column];
      }
    }
  }
  const complexRowIds = registry.cells.flatMap((cell) => [
    `${cell.cell_id}:re`,
    `${cell.cell_id}:im`,
  ]);
  const quadratureInputSha = sha256(stableJson(quadratureInput));
  const quadratureOutputSha = sha256(stableJson(quadratureResult));
  const complexCovarianceAdapterCore = {
    schema_version:
      "casimir_dp_stage4_2b_c_and_quadrature_to_complex_covariance/1",
    cell_registry_sha256: registry.registry_sha256,
    runtime_c_output_sha256: cOutputSha,
    quadrature_input_sha256: quadratureInputSha,
    quadrature_output_sha256: quadratureOutputSha,
    row_ids: complexRowIds,
    formula:
      "Sigma_complex=Sigma_quadrature_statistical_blockdiag+J_chi Sigma_C J_chi^T+J_phi sigma_phi_shared^2 J_phi^T",
    shared_phase_calibration_variance_rad2:
      sharedPhaseCalibrationVariance,
    quadrature_object_receipt_role:
      "algorithm_only_not_per_cell_physics_authority",
    per_cell_physics_authority:
      "stage4_2b_design_grid_registry",
    matrix_sha256: sha256(stableJson(complexCovariance)),
  };
  const complexCovarianceAdapter = {
    ...complexCovarianceAdapterCore,
    receipt_sha256: sha256(stableJson(complexCovarianceAdapterCore)),
  };
  const predictionVectorSha = sha256(stableJson({
    registry_sha256: registry.registry_sha256,
    c_output_sha256: cOutputSha,
    d_output_sha256: dOutputSha,
    ordinary_chi: cRows.map((row) => row.total_ordinary_chi),
    ordinary_phase: cRows.map((row) => row.ordinary_coherent_phase_rad),
    dp_chi: dpChi,
  }));
  const input = CasimirDpApparatusCoherenceResidualStage4_2BInput.parse({
    schema_version:
      "casimir_dp_apparatus_coherence_residual_stage4_2b/1",
    evidence_class: "synthetic_fixture",
    observations: [
      ...observationRows.map(({ cell, value }, index) => ({
        cell_id: cell.cell_id,
        pair_id: cell.pair_id,
        joint_state_receipt_sha256:
          cell.joint_state_receipt_sha256,
        analysis_role: "held_out" as const,
        boundary_state: cell.boundary_state,
        hold_time_s: cell.hold_time_s,
        visibility: value.visibility,
        reference_visibility: referenceVisibility,
        phase_rad: value.phase_rad,
        real_coherence: value.real,
        imaginary_coherence: value.imaginary,
        ordinary_chi: cRows[index].total_ordinary_chi!,
        ordinary_phase_rad:
          cRows[index].ordinary_coherent_phase_rad!,
        dp_chi: dpChi[index],
        bridge_chi: null,
        complete_joint_system_equivalence: true,
      })),
      {
        cell_id: "pilot-cell",
        pair_id: "pilot-pair",
        joint_state_receipt_sha256: registry.registry_sha256,
        analysis_role: "pilot",
        boundary_state: "off",
        hold_time_s: config.apparatus.nominal_hold_time_s,
        visibility: 0.9,
        reference_visibility: referenceVisibility,
        phase_rad: 0,
        real_coherence: 0.9,
        imaginary_coherence: 0,
        ordinary_chi: 0.02,
        ordinary_phase_rad: 0,
        dp_chi: 0,
        bridge_chi: null,
        complete_joint_system_equivalence: false,
      },
    ],
    residual_covariance: residualCovariance,
    complex_covariance: complexCovariance,
    covariance_receipt: {
      row_ids: registry.cells.map((cell) => cell.cell_id),
      complex_row_ids: complexRowIds,
      row_order_sha256: registry.cell_order_sha256,
      constructed_from_full_cross_covariance: true,
      jacobian_receipt_sha256:
        complexCovarianceAdapter.receipt_sha256,
      cross_covariance_receipt_sha256: sha256(stableJson({
        c_output_sha256: cOutputSha,
        c_covariance_sha256: sha256(stableJson(residualCovariance)),
      })),
      condition_number_max:
        config.thresholds.residual_covariance_condition_max,
      shrinkage_or_jitter_frozen_from_pilot: true,
    },
    likelihood: {
      mode: "raw_complex",
      gaussian_coverage_validated: false,
      minimum_covered_visibility: 0.5,
      coverage_probability: 0.95,
      coherence_consistency_tolerance: 1e-8,
    },
    design_grid: {
      minimum_distinct_hold_times: 4,
      minimum_positive_hold_time_span_ratio: 4,
      zero_time_intercept_required: true,
    },
    replication_partition: registry.replication_partition,
    freeze: {
      pilot_fit_completed_at: "2026-07-01T00:00:00.000Z",
      analysis_frozen_at: "2026-07-02T00:00:00.000Z",
      confirmatory_acquired_at: "2026-07-03T00:00:00.000Z",
      nuisance_parameters_frozen: true,
      sensor_model_frozen: true,
      covariance_frozen: true,
      exclusions_frozen: true,
      predictions_frozen: true,
      cell_order_frozen: true,
      scoring_code_sha256: sha256(stableJson({
        module:
          "shared/casimir-dp-apparatus-coherence-residual-stage4-2b.ts",
        likelihood: "raw_complex",
      })),
      prediction_vector_sha256: predictionVectorSha,
      automatic_unblinding_allowed: false,
      synthetic_contract_only: true,
    },
    dp_predictor: {
      manifest_sha256:
        CASIMIR_DP_STAGE3_NAMED_MANIFEST_SHA256,
      generator: "nonrelativistic_markovian_mass_density_dp",
      boundary_variable_in_unmodified_generator: false,
      fitted_amplitude_allowed: false,
      fitted_amplitude: 1,
      r0_retuned_after_freeze: false,
      branch_provenance_complete: false,
      boundary_identity_absolute_tolerance: 1e-15,
    },
    bridge: {
      role: "none",
      admitted: false,
      kernel_sha256: null,
    },
  });
  return {
    input,
    laneVectors: extractRuntimeCOrdinaryLaneVectors(registry, runtimeC),
    dpChi,
    targetComplex,
    quadratureInput,
    quadratureResult,
    complexCovarianceAdapter,
    predictionVectorSha,
  };
}

// Fixture-only orthogonal basis. It is never reachable from the authoritative
// coupled A→G campaign and exists solely to recover the isolated underpowered
// no-go behavior after identifiability has already been established.
const FIXTURE_ONLY_ORTHOGONAL_SIGNATURE_BASIS = [
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, -1, 1, -1, 1, -1, 1, -1],
  [1, 1, -1, -1, 1, 1, -1, -1],
  [1, -1, -1, 1, 1, -1, -1, 1],
  [1, 1, 1, 1, -1, -1, -1, -1],
  [1, -1, 1, -1, -1, 1, -1, 1],
  [1, 1, -1, -1, -1, -1, 1, 1],
];

function inverseStandardNormal(probability: number): number {
  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.38357751867269e2,
    -3.066479806614716e1,
    2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996,
    3.754408661907416,
  ];
  const low = 0.02425;
  const high = 1 - low;
  if (probability <= 0 || probability >= 1) {
    throw new Error("stage4_2b_normal_quantile_probability_domain");
  }
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) *
      q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probability > high) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) *
      q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = probability - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) *
    r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) *
      r + b[4]) * r + 1);
}

function runDeterministicPowerCoverageDiagnostic(
  twoSidedAlpha: number,
) {
  const input = {
    schema_version:
      "casimir_dp_stage4_2b_power_coverage_input/1" as const,
    method:
      "deterministic_stratified_standard_normal_quantile_grid" as const,
    two_sided_alpha: twoSidedAlpha,
    nominal_coverage_probability: 1 - twoSidedAlpha,
    strata: 200_000,
    quantile_probability:
      "u_i=(i+0.5)/strata" as const,
    acceptance_rule:
      "abs(Phi_inverse(u_i))<=Phi_inverse(1-alpha/2)" as const,
    maximum_absolute_coverage_error: 1e-5,
    learned_from: "synthetic_fixture" as const,
    confirmatory_data_used: false as const,
  };
  const criticalValue = inverseStandardNormal(
    1 - input.two_sided_alpha / 2,
  );
  let coveredStrata = 0;
  for (let index = 0; index < input.strata; index += 1) {
    const probability = (index + 0.5) / input.strata;
    const quantile = inverseStandardNormal(probability);
    if (Math.abs(quantile) <= criticalValue) {
      coveredStrata += 1;
    }
  }
  const empiricalCoverageProbability = coveredStrata / input.strata;
  const absoluteCoverageError = Math.abs(
    empiricalCoverageProbability -
      input.nominal_coverage_probability,
  );
  const result = {
    schema_version:
      "casimir_dp_stage4_2b_power_coverage_result/1" as const,
    critical_value_two_sided: criticalValue,
    covered_strata: coveredStrata,
    total_strata: input.strata,
    empirical_coverage_probability: empiricalCoverageProbability,
    nominal_coverage_probability: input.nominal_coverage_probability,
    absolute_coverage_error: absoluteCoverageError,
    deterministic_discretization_bound: 1 / input.strata,
    gate:
      empiricalCoverageProbability >= 0.95 &&
        absoluteCoverageError <= input.maximum_absolute_coverage_error
        ? "pass" as const
        : "blocked" as const,
    evidence_class: "synthetic_fixture" as const,
    measured_evidence: "not_ready" as const,
  };
  const receiptContent = {
    schema_version:
      "casimir_dp_stage4_2b_power_coverage_receipt/1" as const,
    input_sha256: sha256(stableJson(input)),
    result_sha256: sha256(stableJson(result)),
    confirmatory_data_used: false as const,
    evidence_class: "synthetic_fixture" as const,
  };
  const receipt = {
    ...receiptContent,
    receipt_sha256: sha256(stableJson(receiptContent)),
  };
  if (result.gate !== "pass") {
    throw new Error("stage4_2b_power_coverage_diagnostic_failure");
  }
  return { input, result, receipt };
}

function buildFixtureOnlyUnderpoweredIdentifiableFInput(
  config: Stage4_2BConfig,
  powerCoverage: ReturnType<
    typeof runDeterministicPowerCoverageDiagnostic
  >,
): RuntimeFInput {
  const lanes = [
    "intercept",
    "thermal",
    "electromagnetic",
    "vibration",
    "gas",
    "readout",
    "dp",
  ] as const;
  return CasimirDpApparatusIdentifiabilityStage4_2BInput.parse({
    schema_version:
      "casimir_dp_apparatus_identifiability_stage4_2b/1",
    cell_ids: Array.from(
      { length: 8 },
      (_, index) => `cell-${index}`,
    ),
    whitened_signatures_per_sqrt_window: lanes.map((lane, index) => ({
      signature_id: `signature-${lane}`,
      lane,
      values: FIXTURE_ONLY_ORTHOGONAL_SIGNATURE_BASIS[index].map((value) =>
        lane === "dp" ? value * 3e-8 : value
      ),
      source_ref: `synthetic://${lane}/v1`,
    })),
    forecast_covariance: {
      covariance_receipt_sha256: hash("a"),
      whitening_receipt_sha256: hash("b"),
      learned_from: "calibration_or_pilot",
      frozen_before_confirmatory: true,
      constructed_from_full_cross_covariance: true,
      condition_number: 5,
      maximum_condition_number:
        config.thresholds.residual_covariance_condition_max,
    },
    design_contract: {
      design_matrix_sha256: hash("c"),
      cell_order_sha256: hash("d"),
      frozen_before_confirmatory: true,
      preparation_readout_intercept_included: true,
      nuisance_columns_profiled: true,
    },
    bounded_parameter_regions: [
      {
        region_id: "nominal-r0",
        r0_lower_m: config.dp_applicability_manifest.r0_m,
        r0_upper_m: config.dp_applicability_manifest.r0_m,
        whitened_dp_signature_per_sqrt_window:
          FIXTURE_ONLY_ORTHOGONAL_SIGNATURE_BASIS[6].map(
            (value) => value * 3e-8,
          ),
        preregistered: true,
        external_bound_status: "contextual_not_admitted",
        source_ref: "synthetic://nominal-r0/v1",
      },
    ],
    power_coverage: {
      asymptotic_method_valid: false,
      simulation_coverage_validated: true,
      simulation_coverage_probability:
        powerCoverage.result.empirical_coverage_probability,
      simulation_receipt_sha256:
        powerCoverage.receipt.receipt_sha256,
    },
    planned_paired_windows: config.apparatus.planned_paired_windows,
    thresholds: {
      minimum_signature_rank: config.thresholds.minimum_signature_rank,
      maximum_abs_whitened_cosine:
        config.thresholds.maximum_abs_whitened_signature_cosine,
      minimum_power: config.thresholds.minimum_power,
      maximum_false_positive_rate:
        config.thresholds.maximum_false_positive_rate,
      minimum_companion_snr:
        config.thresholds.minimum_companion_snr,
      augmented_design_condition_number_max:
        config.thresholds.augmented_design_condition_number_max,
    },
    companion: {
      applicable: true,
      independently_powered: false,
      forecast_snr: 0.01,
    },
    ordinary_physics_forecast_complete: true,
    branch_provenance_complete: false,
    independent_replication_planned: true,
    legacy_rate_power_input: {
      schema_version: "casimir_dp_visibility_power/1",
      baseline_rate_s: 2.15,
      target_additional_rate_s: 7e-7,
      observation_time_s: config.apparatus.nominal_hold_time_s,
      type_i_error: config.thresholds.maximum_false_positive_rate,
      target_power: config.thresholds.minimum_power,
      technical_variance_inflation: 1,
    },
  });
}

function solveLowerTriangular(
  lower: number[][],
  vector: number[],
): number[] {
  if (
    lower.length !== vector.length ||
    lower.some((row) => row.length !== vector.length)
  ) {
    throw new Error("stage4_2b_whitening_dimension_mismatch");
  }
  const output = Array(vector.length).fill(0);
  for (let row = 0; row < vector.length; row += 1) {
    let value = vector[row];
    for (let column = 0; column < row; column += 1) {
      value -= lower[row][column] * output[column];
    }
    output[row] = value / lower[row][row];
    if (!Number.isFinite(output[row])) {
      throw new Error("stage4_2b_whitening_nonfinite");
    }
  }
  return output;
}

function buildCoupledRuntimeFInput(
  config: Stage4_2BConfig,
  registry: Stage4_2BDesignRegistry,
  runtimeC: RuntimeCResult,
  runtimeD: RuntimeDResult,
  runtimeE: RuntimeEResult,
  runtimeEBundle: ReturnType<typeof buildCoupledRuntimeEInput>,
  powerCoverage: ReturnType<
    typeof runDeterministicPowerCoverageDiagnostic
  >,
) {
  const lower = runtimeE.cholesky_lower;
  const rowIds =
    runtimeEBundle.input.covariance_receipt.complex_row_ids;
  if (
    runtimeE.gate !== "pass" ||
    runtimeE.covariance_gate !== "positive_definite" ||
    lower == null ||
    rowIds == null ||
    lower.length !== registry.cells.length * 2 ||
    rowIds.length !== lower.length
  ) {
    throw new Error(
      `stage4_2b_runtime_e_not_ready_for_f_whitening:${stableJson({
        gate: runtimeE.gate,
        first_failure: runtimeE.first_failure,
        covariance_gate: runtimeE.covariance_gate,
        covariance_condition_number:
          runtimeE.covariance_condition_number,
        covariance_condition_metric:
          runtimeE.covariance_condition_metric,
        lower_rows: lower?.length ?? null,
        row_ids: rowIds.length,
      })}`,
    );
  }
  const ordinaryRows = runtimeC.cell_predictions;
  const lanes = runtimeEBundle.laneVectors;
  const referenceVisibility = 0.92;
  const complexForChi = (
    chi: number,
    phase: number,
  ): [number, number] => {
    const visibility = referenceVisibility * Math.exp(-chi);
    return [
      visibility * Math.cos(phase),
      visibility * Math.sin(phase),
    ];
  };
  const marginalComplexLane = (
    laneValues: number[],
  ): number[] =>
    registry.cells.flatMap((cell, index) => {
      const total = ordinaryRows[index].total_ordinary_chi;
      const phase = ordinaryRows[index].ordinary_coherent_phase_rad;
      if (total == null || phase == null) {
        throw new Error(
          `stage4_2b_runtime_c_null_lane_projection:${cell.cell_id}`,
        );
      }
      const without = complexForChi(
        Math.max(0, total - laneValues[index]),
        phase,
      );
      const withLane = complexForChi(total, phase);
      return [
        without[0] - withLane[0],
        without[1] - withLane[1],
      ];
    });
  const rawIntercept = registry.cells.flatMap((cell, index) => {
    const phase = ordinaryRows[index].ordinary_coherent_phase_rad;
    if (phase == null) {
      throw new Error(
        `stage4_2b_runtime_c_null_intercept_projection:${cell.cell_id}`,
      );
    }
    return [
      referenceVisibility * Math.cos(phase),
      referenceVisibility * Math.sin(phase),
    ];
  });
  const rawDp = registry.cells.flatMap((cell, index) => {
    const ordinaryChi = ordinaryRows[index].total_ordinary_chi;
    const phase = ordinaryRows[index].ordinary_coherent_phase_rad;
    if (ordinaryChi == null || phase == null) {
      throw new Error(
        `stage4_2b_runtime_c_null_dp_projection:${cell.cell_id}`,
      );
    }
    const withoutDp = complexForChi(ordinaryChi, phase);
    const withDp = complexForChi(
      ordinaryChi + runtimeEBundle.dpChi[index],
      phase,
    );
    return [
      withoutDp[0] - withDp[0],
      withoutDp[1] - withDp[1],
    ];
  });
  const rawVectors = {
    intercept: rawIntercept,
    thermal: marginalComplexLane(lanes.thermal),
    electromagnetic: marginalComplexLane(lanes.electromagnetic),
    vibration: marginalComplexLane(lanes.vibration),
    gas: marginalComplexLane(lanes.gas),
    readout: marginalComplexLane(lanes.readout),
    dp: rawDp,
  };
  const whitened = Object.fromEntries(
    Object.entries(rawVectors).map(([lane, vector]) => [
      lane,
      solveLowerTriangular(lower, vector),
    ]),
  ) as Record<keyof typeof rawVectors, number[]>;
  const covarianceReceiptSha = sha256(stableJson({
    registry_sha256: registry.registry_sha256,
    runtime_e_input_complex_covariance_sha256:
      runtimeEBundle.complexCovarianceAdapter.matrix_sha256,
    runtime_e_output_covariance_condition_number:
      runtimeE.covariance_condition_number,
    row_ids: rowIds,
  }));
  const whiteningReceiptCore = {
    schema_version:
      "casimir_dp_stage4_2b_runtime_e_to_f_whitening/1",
    covariance_receipt_sha256: covarianceReceiptSha,
    runtime_e_output_sha256: sha256(stableJson(runtimeE)),
    selected_likelihood_space: "raw_complex",
    row_ids: rowIds,
    cholesky_lower_sha256: sha256(stableJson(lower)),
    raw_signature_sha256: Object.fromEntries(
      Object.entries(rawVectors).map(([lane, vector]) => [
        lane,
        sha256(stableJson(vector)),
      ]),
    ),
    whitened_signature_sha256: Object.fromEntries(
      Object.entries(whitened).map(([lane, vector]) => [
        lane,
        sha256(stableJson(vector)),
      ]),
    ),
  };
  const whiteningReceiptSha = sha256(stableJson(whiteningReceiptCore));
  const signatureRows = ([
    "intercept",
    "thermal",
    "electromagnetic",
    "vibration",
    "gas",
    "readout",
    "dp",
  ] as const).map((lane) => ({
    signature_id: `signature-${lane}`,
    lane,
    values: whitened[lane],
    source_ref:
      `sha256:${whiteningReceiptSha}#${lane}`,
  }));
  const nominalDpRow = runtimeD.named_dp_prediction.rows.find((row) =>
    row.mass_kg === config.apparatus.nominal_mass_kg &&
    row.branch_separation_m ===
      config.apparatus.nominal_branch_separation_m &&
    row.hold_time_s === config.apparatus.nominal_hold_time_s &&
    row.cell_id.includes("__ramsey__")
  );
  const nominalOrdinaryIndex = registry.cells.findIndex((cell) =>
    cell.mass_kg === config.apparatus.nominal_mass_kg &&
    cell.branch_separation_m ===
      config.apparatus.nominal_branch_separation_m &&
    cell.hold_time_s === config.apparatus.nominal_hold_time_s &&
    cell.sequence_kind === "ramsey" &&
    cell.boundary_state === "off"
  );
  if (nominalDpRow == null || nominalOrdinaryIndex < 0) {
    throw new Error("stage4_2b_nominal_power_point_missing");
  }
  const nominalOrdinaryChi =
    ordinaryRows[nominalOrdinaryIndex].total_ordinary_chi;
  if (nominalOrdinaryChi == null) {
    throw new Error("stage4_2b_nominal_ordinary_rate_missing");
  }
  const designMatrixSha = sha256(stableJson({
    row_ids: rowIds,
    signatures: signatureRows.map((row) => ({
      lane: row.lane,
      values: row.values,
    })),
  }));
  const input = CasimirDpApparatusIdentifiabilityStage4_2BInput.parse({
    schema_version:
      "casimir_dp_apparatus_identifiability_stage4_2b/1",
    cell_ids: rowIds,
    whitened_signatures_per_sqrt_window: signatureRows,
    forecast_covariance: {
      covariance_receipt_sha256: covarianceReceiptSha,
      whitening_receipt_sha256: whiteningReceiptSha,
      learned_from: "calibration_or_pilot",
      frozen_before_confirmatory: true,
      constructed_from_full_cross_covariance: true,
      condition_number: Math.max(
        1,
        runtimeE.covariance_condition_number ?? Number.POSITIVE_INFINITY,
      ),
      maximum_condition_number:
        config.thresholds.residual_covariance_condition_max,
    },
    design_contract: {
      design_matrix_sha256: designMatrixSha,
      cell_order_sha256: sha256(stableJson(rowIds)),
      frozen_before_confirmatory: true,
      preparation_readout_intercept_included: true,
      nuisance_columns_profiled: true,
    },
    bounded_parameter_regions: [{
      region_id: "nominal-r0",
      r0_lower_m: config.dp_applicability_manifest.r0_m,
      r0_upper_m: config.dp_applicability_manifest.r0_m,
      whitened_dp_signature_per_sqrt_window: whitened.dp,
      preregistered: true,
      external_bound_status: "contextual_not_admitted",
      source_ref:
        `sha256:${whiteningReceiptSha}#nominal-r0-dp`,
    }],
    power_coverage: {
      asymptotic_method_valid: false,
      simulation_coverage_validated: true,
      simulation_coverage_probability:
        powerCoverage.result.empirical_coverage_probability,
      simulation_receipt_sha256:
        powerCoverage.receipt.receipt_sha256,
    },
    planned_paired_windows: config.apparatus.planned_paired_windows,
    thresholds: {
      minimum_signature_rank: config.thresholds.minimum_signature_rank,
      maximum_abs_whitened_cosine:
        config.thresholds.maximum_abs_whitened_signature_cosine,
      minimum_power: config.thresholds.minimum_power,
      maximum_false_positive_rate:
        config.thresholds.maximum_false_positive_rate,
      minimum_companion_snr:
        config.thresholds.minimum_companion_snr,
      augmented_design_condition_number_max:
        config.thresholds.augmented_design_condition_number_max,
    },
    companion: {
      applicable: true,
      independently_powered:
        runtimeD.companion_forecast.independently_powered,
      forecast_snr:
        runtimeD.companion_forecast.forecast_snr ?? 0,
    },
    ordinary_physics_forecast_complete: true,
    branch_provenance_complete: false,
    independent_replication_planned:
      registry.replication_partition.planned,
    legacy_rate_power_input: {
      schema_version: "casimir_dp_visibility_power/1",
      baseline_rate_s:
        nominalOrdinaryChi / config.apparatus.nominal_hold_time_s,
      target_additional_rate_s: nominalDpRow.Gamma_DP_s,
      observation_time_s: config.apparatus.nominal_hold_time_s,
      type_i_error: config.thresholds.maximum_false_positive_rate,
      target_power: config.thresholds.minimum_power,
      technical_variance_inflation: 1,
    },
  });
  return {
    input,
    adapter: {
      ...whiteningReceiptCore,
      receipt_sha256: whiteningReceiptSha,
      design_matrix_sha256: designMatrixSha,
      dp_source_runtime_d_output_sha256: sha256(stableJson(runtimeD)),
      ordinary_source_runtime_c_output_sha256: sha256(stableJson(runtimeC)),
      selected_runtime_e_output_sha256: sha256(stableJson(runtimeE)),
    },
    rawVectors,
    whitenedVectors: whitened,
  };
}

function logGrid(
  minimum: number,
  maximum: number,
  count: number,
): number[] {
  const low = Math.log(minimum);
  const step = (Math.log(maximum) - low) / (count - 1);
  return Array.from(
    { length: count },
    (_, index) => Math.exp(low + step * index),
  );
}

function runOpticalAndCasimirDiagnostics() {
  const strength = 4e32;
  const resonance = 1e16;
  const damping = 2e14;
  const omega = logGrid(1e10, 1e22, 12_001);
  const xi = logGrid(1e12, 1e20, 17);
  const optical = convertLossTableToImaginaryAxis({
    receipt: {
      schema_version: "casimir_optical_response_receipt/1",
      material_id: "stage4-2b-lorentz-recovery",
      label: "Stage-4.2B Lorentz recovery",
      evidence_class: "synthetic_fixture",
      source_ref: "synthetic://stage4-2b/lorentz-recovery",
      raw_artifact_path: "memory://stage4-2b-lorentz-recovery",
      expected_sha256: hash("a"),
      actual_sha256: hash("a"),
      calibration_refs: ["analytic-lorentz-model"],
      points: omega.map((frequency) => {
        const loss = strength * damping * frequency /
          (
            (resonance ** 2 - frequency ** 2) ** 2 +
            (damping * frequency) ** 2
          );
        return {
          omega_rad_s: frequency,
          epsilon_imag: loss,
          standard_uncertainty: loss * 0.01,
        };
      }),
      required_coverage: {
        min_omega_rad_s: 1e10,
        max_omega_rad_s: 1e22 * (1 - 1e-12),
      },
      tails: {
        low_frequency_model: "Lorentz",
        high_frequency_model: "Lorentz",
      },
    },
    xi_rad_s: xi,
  });
  const maximumKramersKronigRelativeError = Math.max(
    ...optical.points.map((point) => {
      const analytic = 1 +
        strength /
          (
            resonance ** 2 +
            point.xi_rad_s ** 2 +
            damping * point.xi_rad_s
          );
      return Math.abs(point.epsilon - analytic) / analytic;
    }),
  );
  const casimir = computeLifshitzEquilibrium({
    schema_version: "casimir_lifshitz/1",
    gap_m: 1e-7,
    temperature_K: 300,
    material_1: {
      kind: "ideal_conductor",
      label: "ideal reference",
      evidence_class: "literature_anchored",
      source_ref: "Casimir/Lifshitz reference",
      artifact_sha256: null,
    },
    material_2: {
      kind: "ideal_conductor",
      label: "ideal reference",
      evidence_class: "literature_anchored",
      source_ref: "Casimir/Lifshitz reference",
      artifact_sha256: null,
    },
    geometry: {
      kind: "parallel_plates",
      area_m2: 1e-8,
    },
    numerics: {
      max_matsubara_terms: 1024,
      integration_subdivisions: 240,
      integration_tail_y: 40,
      relative_term_tolerance: 1e-8,
      consecutive_small_terms: 6,
    },
  });
  if (
    optical.gates.artifact_integrity !== "pass" ||
    optical.gates.spectral_coverage !== "pass" ||
    maximumKramersKronigRelativeError >= 0.03 ||
    casimir.convergence.status !== "pass" ||
    casimir.pressure_Pa >= 0
  ) {
    throw new Error("stage4_2b_optical_casimir_recovery_failure");
  }
  return {
    optical_response: {
      gates: optical.gates,
      maximum_kramers_kronig_relative_error:
        maximumKramersKronigRelativeError,
      point_count: optical.points.length,
      evidence_class: optical.material.evidence_class,
      measured_material: optical.gates.measured_material,
    },
    lifshitz: {
      convergence: casimir.convergence,
      pressure_Pa: casimir.pressure_Pa,
      ideal_pressure_ratio:
        casimir.ideal_zero_temperature_reference.pressure_ratio,
      publication_grade_gate: casimir.publication_grade_gate,
    },
  };
}

function runDataReadinessDiagnostic() {
  const digest = hash("8");
  const result = validateAcquisitionSidecar({
    artifact: {
      schema_version: "casimir_dp_acquisition_sidecar/1",
      sidecar_id: "stage4-2b-synthetic-sidecar",
      candidate_id: "stage4-2b-synthetic-candidate",
      evidence_class: "synthetic_fixture",
      acquisition_window_s: 0.1,
      blinded_boundary_label: "blind-synthetic-A",
      calibration_refs: ["synthetic://calibration/v1"],
      observable_order: ["visibility", "phase"],
      observables: {
        visibility: {
          value: 0.9,
          standard_uncertainty: 0.01,
          unit: "1",
        },
        phase: {
          value: 0.01,
          standard_uncertainty: 0.002,
          unit: "rad",
        },
      },
      covariance: [
        [1e-4, 0],
        [0, 4e-6],
      ],
    },
    expected_sha256: digest,
    actual_sha256: digest,
  });
  if (
    !result.structurally_runnable ||
    result.gates.measured_evidence !== "not_ready"
  ) {
    throw new Error("stage4_2b_data_readiness_reconciliation_failure");
  }
  return result;
}

type Baselines = {
  AInput: ReturnType<typeof buildRuntimeAInput>;
  BInput: ReturnType<typeof buildRuntimeBInput>;
  CInput: ReturnType<typeof buildCoupledRuntimeCInput>["input"];
  DInput: ReturnType<typeof buildCoupledRuntimeDInput>["input"];
  EInput: RuntimeEInput;
  FInput: RuntimeFInput;
};

type FixtureExecution = {
  case_id: SyntheticCase["case_id"];
  target_runtime: SyntheticCase["target_runtime"];
  mutation: string;
  mutation_fingerprint_sha256: string;
  observed_gate: "pass" | "blocked";
  expected_gate: "pass" | "blocked";
  observed_status: SyntheticCase["expected_status"];
  expected_status: SyntheticCase["expected_status"];
  first_failure_code: string | null;
  runtime_output_sha256: string;
  evidence: Record<string, unknown>;
  does_not_support: string;
  evidence_class: "synthetic_fixture";
  measured_evidence: "not_ready";
  collapse_identification: "blocked";
  manifold_dynamics: "blocked";
  physical_viability: "not_evaluated";
  gate: "pass";
};

function finalizeFixtureExecution(args: {
  fixture: SyntheticCase;
  mutatedInput: unknown;
  runtimeOutput: unknown;
  observedGate: "pass" | "blocked";
  observedStatus: SyntheticCase["expected_status"];
  firstFailureCode?: string | null;
  evidence: Record<string, unknown>;
}): FixtureExecution {
  if (
    args.observedGate !== args.fixture.expected_gate ||
    args.observedStatus !== args.fixture.expected_status
  ) {
    throw new Error(
      `stage4_2b_fixture_expectation_mismatch:${args.fixture.case_id}:${args.observedGate}:${args.observedStatus}`,
    );
  }
  return {
    case_id: args.fixture.case_id,
    target_runtime: args.fixture.target_runtime,
    mutation: args.fixture.mutation,
    mutation_fingerprint_sha256: sha256(
      stableJson(args.mutatedInput),
    ),
    observed_gate: args.observedGate,
    expected_gate: args.fixture.expected_gate,
    observed_status: args.observedStatus,
    expected_status: args.fixture.expected_status,
    first_failure_code: args.firstFailureCode ?? null,
    runtime_output_sha256: sha256(stableJson(args.runtimeOutput)),
    evidence: args.evidence,
    does_not_support: args.fixture.does_not_support,
    evidence_class: "synthetic_fixture",
    measured_evidence: "not_ready",
    collapse_identification: "blocked",
    manifold_dynamics: "blocked",
    physical_viability: "not_evaluated",
    gate: "pass",
  };
}

function executeSyntheticFixture(
  fixture: SyntheticCase,
  baselines: Baselines,
  fixtureOnlyUnderpoweredFInput: RuntimeFInput,
): FixtureExecution {
  switch (fixture.case_id) {
    case "ordinary_closure_only": {
      const input = clone(baselines.EInput);
      const result =
        evaluateCasimirDpApparatusCoherenceResidualStage4_2B(input);
      if (
        result.gate !== "pass" ||
        !result.model_scores.some((row) => row.model_id === "M0")
      ) {
        throw new Error("stage4_2b_ordinary_fixture_not_recovered");
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput: result,
        observedGate: "pass",
        observedStatus: "synthetic_recovery",
        evidence: {
          ordinary_model_scored: true,
          residual_covariance_gate: result.covariance_gate,
          pilot_partition_gate: result.pilot_partition_gate,
        },
      });
    }
    case "isolated_thermal_injection": {
      const input = buildRuntimeBInput(320);
      const result =
        evaluateCasimirDpApparatusSpectralThermometryStage4_2B(input);
      const particle = result.target_thermometry.find(
        (row) => row.target_id === "particle",
      );
      if (
        result.status !== "pass" ||
        particle?.temperature_estimate_K == null ||
        Math.abs(particle.temperature_estimate_K - 320) > 1e-6
      ) {
        throw new Error("stage4_2b_thermal_fixture_not_recovered");
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput: result,
        observedGate: "pass",
        observedStatus: "synthetic_recovery",
        evidence: {
          injected_temperature_K: 320,
          recovered_temperature_K: particle.temperature_estimate_K,
          thermal_jump_status:
            result.thermal_jump_localization.status,
        },
      });
    }
    case "em_patch_injection": {
      const input: any = clone(baselines.CInput);
      for (const sample of input.sensor_forward_model.samples) {
        sample.observed_cross_spectrum = matrix2(
          2.2e-68,
          0.5e-68,
          2.1e-68,
        );
      }
      const result =
        evaluateCasimirDpApparatusResponseCovarianceStage4_2B(input);
      if (result.status !== "pass") {
        throw new Error("stage4_2b_em_fixture_not_recovered");
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput: result,
        observedGate: "pass",
        observedStatus: "synthetic_recovery",
        evidence: {
          recovered_patch_spectrum:
            result.physical_disturbance_separation
              .spectra[0].cross_spectrum?.[1]?.[1]?.re ?? null,
          sensor_self_noise_subtracted:
            result.physical_disturbance_separation
              .sensor_self_noise_subtracted,
        },
      });
    }
    case "vibration_and_correlated_tilt_injection": {
      const input: any = clone(baselines.CInput);
      for (const sample of input.sensor_forward_model.samples) {
        sample.observed_cross_spectrum = matrix2(
          3.2e-68,
          0.8e-68,
          1.1e-68,
        );
      }
      const result =
        evaluateCasimirDpApparatusResponseCovarianceStage4_2B(input);
      if (result.status !== "pass") {
        throw new Error("stage4_2b_vibration_fixture_not_recovered");
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput: result,
        observedGate: "pass",
        observedStatus: "synthetic_recovery",
        evidence: {
          recovered_cross_spectrum:
            result.physical_disturbance_separation
              .spectra[0].cross_spectrum?.[0]?.[1] ?? null,
          correlated_injection_gate:
            result.nuisance_injection_predictions.find(
              (row) => row.kind === "correlated_channels",
            )?.gate ?? null,
        },
      });
    }
    case "residual_gas_injection": {
      const input: any = clone(baselines.CInput);
      const cell = input.gaussian_cells.find(
        (candidate: any) => candidate.hold_time_s > 0,
      );
      const gas = cell?.non_gaussian_contributions.find(
        (row: any) => row.process === "gas_collision",
      );
      if (cell == null || gas == null) {
        throw new Error("stage4_2b_positive_time_gas_fixture_missing");
      }
      gas.chi = 0.25;
      const result =
        evaluateCasimirDpApparatusResponseCovarianceStage4_2B(input);
      if (result.status !== "pass") {
        throw new Error("stage4_2b_gas_fixture_not_recovered");
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput: result,
        observedGate: "pass",
        observedStatus: "synthetic_recovery",
        evidence: {
          injected_gas_chi: 0.25,
          recovered_non_gaussian_chi:
            result.cell_predictions.find(
              (row) => row.cell_id === cell.cell_id,
            )?.non_gaussian_chi ?? null,
        },
      });
    }
    case "optical_readout_injection": {
      const input: any = clone(baselines.CInput);
      input.gaussian_cells[0].non_gaussian_contributions.push({
        contribution_id: "readout-1",
        process: "optical_recoil",
        chi: 0.05,
        coherent_phase_rad: 0,
        diffusion_limit_used: false,
        diffusion_limit_validated: false,
        receipt: stageCReceipt("synthetic://readout-kernel"),
      });
      input.channel_ownership.push({
        contribution_id: "readout-1",
        category: "readout",
        owner_runtime: "stage4_2b_runtime_c",
        process_class: "jump_localization",
        source_kind: "calibrated_injection",
        shared_term_rule: null,
      });
      const result =
        evaluateCasimirDpApparatusResponseCovarianceStage4_2B(input);
      if (result.status !== "pass") {
        throw new Error("stage4_2b_readout_fixture_not_recovered");
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput: result,
        observedGate: "pass",
        observedStatus: "synthetic_recovery",
        evidence: {
          injected_readout_chi: 0.05,
          recovered_non_gaussian_chi:
            result.cell_predictions[0].non_gaussian_chi,
        },
      });
    }
    case "correlated_covariance_false_residual": {
      const input: any = clone(baselines.EInput);
      input.covariance_receipt
        .constructed_from_full_cross_covariance = false;
      let runtimeOutput: unknown;
      let rejected = false;
      try {
        runtimeOutput =
          evaluateCasimirDpApparatusCoherenceResidualStage4_2B(input);
      } catch (error) {
        rejected = true;
        runtimeOutput = {
          schema_rejected: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (!rejected) {
        throw new Error(
          "stage4_2b_omitted_cross_covariance_was_not_rejected",
        );
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput,
        observedGate: "blocked",
        observedStatus: "false_residual_prevented",
        firstFailureCode:
          "schema_rejected_omitted_full_cross_covariance",
        evidence: {
          strict_schema_rejected_omission: true,
          false_residual_scored: false,
        },
      });
    }
    case "strict_frozen_dp_injection": {
      const input = clone(baselines.EInput);
      for (const row of input.observations) {
        if (row.analysis_role !== "held_out") continue;
        row.visibility = row.reference_visibility *
          Math.exp(-(row.ordinary_chi + row.dp_chi));
        row.real_coherence =
          row.visibility * Math.cos(row.phase_rad);
        row.imaginary_coherence =
          row.visibility * Math.sin(row.phase_rad);
      }
      const result =
        evaluateCasimirDpApparatusCoherenceResidualStage4_2B(input);
      if (
        result.gate !== "pass" ||
        !result.model_scores.some(
          (row) => row.model_id === "M0_plus_DP",
        )
      ) {
        throw new Error("stage4_2b_dp_fixture_not_recovered");
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput: result,
        observedGate: "pass",
        observedStatus: "synthetic_recovery",
        evidence: {
          frozen_manifest_sha256:
            input.dp_predictor.manifest_sha256,
          dp_amplitude_fitted: false,
          dp_model_score: result.model_scores.find(
            (row) => row.model_id === "M0_plus_DP",
          ) ?? null,
        },
      });
    }
    case "generic_irreversible_non_dp_loss": {
      const input = clone(baselines.FInput);
      const intercept = input.whitened_signatures_per_sqrt_window.find(
        (row) => row.lane === "intercept",
      )!;
      const dp = input.whitened_signatures_per_sqrt_window.find(
        (row) => row.lane === "dp",
      )!;
      dp.values = intercept.values.map((value) => value * 1e-8);
      const result =
        evaluateCasimirDpApparatusIdentifiabilityStage4_2B(input);
      if (
        result.gate !== "blocked" ||
        result.feasibility_verdict !== "signature_not_identifiable"
      ) {
        throw new Error(
          "stage4_2b_generic_loss_was_not_distinguished",
        );
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput: result,
        observedGate: "blocked",
        observedStatus: "signature_not_identifiable",
        firstFailureCode: result.blockers[0] ?? null,
        evidence: {
          profiled_dp_fisher_information:
            result.dp_profiled_fisher_information_per_window,
          blockers: result.blockers,
        },
      });
    }
    case "boundary_only_residual": {
      const input = clone(baselines.EInput);
      for (const row of input.observations) {
        if (
          row.analysis_role === "held_out" &&
          row.boundary_state === "on"
        ) {
          row.visibility *= Math.exp(-0.02);
          row.real_coherence =
            row.visibility * Math.cos(row.phase_rad);
          row.imaginary_coherence =
            row.visibility * Math.sin(row.phase_rad);
        }
      }
      const result =
        evaluateCasimirDpApparatusCoherenceResidualStage4_2B(input);
      const dpNull = result.boundary_contrasts.every(
        (row) => row.dp_on_minus_off === 0,
      );
      const residualPresent = result.boundary_contrasts.some(
        (row) =>
          row.on_minus_off_residual != null &&
          Math.abs(row.on_minus_off_residual) > 1e-6,
      );
      if (result.gate !== "pass" || !dpNull || !residualPresent) {
        throw new Error(
          `stage4_2b_boundary_anomaly_fixture_not_recovered:${JSON.stringify({
            gate: result.gate,
            failures: result.failures,
            dpNull,
            residualPresent,
            contrasts: result.boundary_contrasts,
          })}`,
        );
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput: result,
        observedGate: "pass",
        observedStatus: "boundary_correlated_anomaly_only",
        evidence: {
          registered_dp_contrast_zero: dpNull,
          observed_boundary_residual_present: residualPresent,
          bridge_admitted: false,
        },
      });
    }
    case "joint_system_branch_mismatch": {
      const input: any = clone(baselines.AInput);
      const on = input.boundary_states.find(
        (row: any) => row.boundary_state_id === "on",
      );
      on.density_cells[0].branch_a_density_kg_m3 += 1;
      on.density_cells[1].branch_a_density_kg_m3 -= 1;
      on.branch_swap_probe.branch_b_density_kg_m3[0] += 1;
      on.branch_swap_probe.branch_b_density_kg_m3[1] -= 1;
      const result =
        evaluateCasimirDpApparatusScaleTransportStage4_2B(input);
      const conditionalGate =
        result.complete_joint_system_boundary_equivalence
          .symbolic_identity.gate;
      if (result.status === "pass" || conditionalGate === "pass") {
        throw new Error(
          `stage4_2b_joint_branch_mismatch_was_not_blocked:${JSON.stringify({
            status: result.status,
            conditionalGate,
            failures: result.failures,
            equivalence:
              result.complete_joint_system_boundary_equivalence,
          })}`,
        );
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput: result,
        observedGate: "blocked",
        observedStatus:
          "conditional_boundary_identity_not_applicable",
        firstFailureCode: result.first_failure_code,
        evidence: {
          symbolic_identity_gate: conditionalGate,
          numerical_recovery_gate:
            result.complete_joint_system_boundary_equivalence
              .numerical_recovery.gate,
          experimental_mismatch_gate:
            result.complete_joint_system_boundary_equivalence
              .experimental_mismatch.gate,
        },
      });
    }
    case "echo_recoverable_quasistatic_dephasing": {
      const input: any = clone(baselines.CInput);
      const positiveCellIndex = input.gaussian_cells.findIndex(
        (candidate: any) => candidate.hold_time_s > 0,
      );
      if (positiveCellIndex < 0) {
        throw new Error("stage4_2b_positive_time_echo_fixture_missing");
      }
      input.gaussian_cells[positiveCellIndex].sequence_filter_abs2_s2 =
        input.gaussian_cells[positiveCellIndex].sequence_filter_abs2_s2
          .map((value: number) => value * 0.25);
      const result =
        evaluateCasimirDpApparatusResponseCovarianceStage4_2B(input);
      const baseline =
        evaluateCasimirDpApparatusResponseCovarianceStage4_2B(
          baselines.CInput,
        );
      const reduced =
        result.cell_predictions[positiveCellIndex].gaussian_chi != null &&
        baseline.cell_predictions[positiveCellIndex].gaussian_chi != null &&
        result.cell_predictions[positiveCellIndex].gaussian_chi! <
          baseline.cell_predictions[positiveCellIndex].gaussian_chi!;
      if (result.status !== "pass" || !reduced) {
        throw new Error("stage4_2b_echo_fixture_not_recovered");
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput: result,
        observedGate: "pass",
        observedStatus: "synthetic_recovery",
        evidence: {
          baseline_gaussian_chi:
            baseline.cell_predictions[positiveCellIndex].gaussian_chi,
          echo_filtered_gaussian_chi:
            result.cell_predictions[positiveCellIndex].gaussian_chi,
          recovery_is_reversible_control: true,
        },
      });
    }
    case "blind_label_leakage": {
      const input = clone(baselines.EInput);
      input.freeze.confirmatory_acquired_at =
        "2026-07-01T12:00:00.000Z";
      const result =
        evaluateCasimirDpApparatusCoherenceResidualStage4_2B(input);
      if (
        result.gate !== "blocked" ||
        result.first_failure?.code !== "confirmatory_data_leakage"
      ) {
        throw new Error("stage4_2b_leakage_was_not_blocked");
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput: result,
        observedGate: "blocked",
        observedStatus: "leakage_prevented",
        firstFailureCode: result.first_failure.code,
        evidence: {
          analysis_frozen_at: input.freeze.analysis_frozen_at,
          confirmatory_acquired_at:
            input.freeze.confirmatory_acquired_at,
          unblinded: result.unblinded,
        },
      });
    }
    case "post_hoc_parameter_retuning_attempt": {
      const input = clone(baselines.DInput);
      input.freeze.r0_retuned_after_held_out = true;
      const result =
        evaluateCasimirDpDpScalingForecastStage4_2B(input);
      if (
        result.gate !== "blocked" ||
        !result.failures.some(
          (row) => row.code === "post_hoc_dp_parameter_retuning",
        )
      ) {
        throw new Error("stage4_2b_retuning_was_not_blocked");
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput: result,
        observedGate: "blocked",
        observedStatus: "retuning_prevented",
        firstFailureCode:
          result.failures.find(
            (row) => row.code === "post_hoc_dp_parameter_retuning",
          )?.code ?? null,
        evidence: {
          r0_retuned_after_held_out:
            input.freeze.r0_retuned_after_held_out,
          named_prediction_gate: result.named_dp_prediction.gate,
        },
      });
    }
    case "signature_collinearity_failure": {
      const input = clone(baselines.FInput);
      const thermal = input.whitened_signatures_per_sqrt_window.find(
        (row) => row.lane === "thermal",
      )!;
      const readout = input.whitened_signatures_per_sqrt_window.find(
        (row) => row.lane === "readout",
      )!;
      readout.values = [...thermal.values];
      const result =
        evaluateCasimirDpApparatusIdentifiabilityStage4_2B(input);
      if (
        result.gate !== "blocked" ||
        result.feasibility_verdict !== "signature_not_identifiable"
      ) {
        throw new Error(
          "stage4_2b_collinearity_was_not_blocked",
        );
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput: result,
        observedGate: "blocked",
        observedStatus: "signature_not_identifiable",
        firstFailureCode: result.blockers[0] ?? null,
        evidence: {
          maximum_abs_whitened_cosine:
            result.maximum_abs_whitened_cosine,
          signature_rank: result.signature_rank,
          blockers: result.blockers,
        },
      });
    }
    case "underpowered_null": {
      const input = clone(fixtureOnlyUnderpoweredFInput);
      const result =
        evaluateCasimirDpApparatusIdentifiabilityStage4_2B(input);
      if (
        result.gate !== "pass" ||
        result.feasibility_verdict !==
          "apparatus_not_powered_for_dp" ||
        result.powered_preregistered_region_ids.length !== 0
      ) {
        throw new Error(
          "stage4_2b_underpowered_null_not_fail_closed",
        );
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput: result,
        observedGate: "pass",
        observedStatus: "apparatus_not_powered_for_dp",
        evidence: {
          planned_paired_windows: result.planned_paired_windows,
          required_paired_windows: result.required_paired_windows,
          achieved_dp_power: result.achieved_dp_power,
          powered_region_ids:
            result.powered_preregistered_region_ids,
          null_exclusion_region_ids:
            result.null_exclusion_region_ids_if_measured_null,
        },
      });
    }
    case "sensor_self_noise_false_decoherence": {
      const input: any = clone(baselines.CInput);
      input.sensor_forward_model.cross_covariances_explicit = false;
      for (const sample of input.sensor_forward_model.samples) {
        sample.sensor_self_noise_cross_spectrum = zero2;
      }
      const result =
        evaluateCasimirDpApparatusResponseCovarianceStage4_2B(input);
      if (
        result.status === "pass" ||
        !result.failures.some(
          (row) => row.code === "omitted_sensor_cross_covariance",
        )
      ) {
        throw new Error(
          "stage4_2b_sensor_noise_confound_was_not_blocked",
        );
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput: result,
        observedGate: "blocked",
        observedStatus: "sensor_noise_confound_prevented",
        firstFailureCode:
          result.failures.find(
            (row) => row.code === "omitted_sensor_cross_covariance",
          )?.code ?? result.first_failure?.code ?? null,
        evidence: {
          sensor_self_noise_omitted_in_mutation: true,
          physical_sensor_cross_terms_included:
            result.physical_disturbance_separation
              .physical_sensor_cross_terms_included,
          scored_as_physical_evidence: false,
        },
      });
    }
    case "singular_covariance_jitter_rescue_attempt": {
      const input = buildFixtureOnlyGaussianEInput();
      input.residual_covariance = [
        [1, 1, 0, 0, 0, 0, 0, 0],
        [1, 1, 0, 0, 0, 0, 0, 0],
        [0, 0, 1, 0, 0, 0, 0, 0],
        [0, 0, 0, 1, 0, 0, 0, 0],
        [0, 0, 0, 0, 1, 0, 0, 0],
        [0, 0, 0, 0, 0, 1, 0, 0],
        [0, 0, 0, 0, 0, 0, 1, 0],
        [0, 0, 0, 0, 0, 0, 0, 1],
      ];
      const result =
        evaluateCasimirDpApparatusCoherenceResidualStage4_2B(input);
      if (
        result.gate !== "blocked" ||
        result.covariance_gate !== "not_identifiable"
      ) {
        throw new Error(
          "stage4_2b_singular_covariance_was_not_blocked",
        );
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput: result,
        observedGate: "blocked",
        observedStatus: "not_identifiable",
        firstFailureCode: result.first_failure?.code ?? null,
        evidence: {
          covariance_gate: result.covariance_gate,
          confirmatory_jitter_rescue_used: false,
          model_scores_emitted: result.model_scores.length,
        },
      });
    }
    case "low_visibility_gaussian_coverage_failure": {
      const input = buildFixtureOnlyGaussianEInput();
      const row = input.observations.find(
        (candidate) =>
          candidate.analysis_role === "held_out" &&
          candidate.cell_id === "cell-7",
      )!;
      row.visibility = 0.1;
      row.real_coherence = 0.1 * Math.cos(row.phase_rad);
      row.imaginary_coherence = 0.1 * Math.sin(row.phase_rad);
      const result =
        evaluateCasimirDpApparatusCoherenceResidualStage4_2B(input);
      if (
        result.gate !== "blocked" ||
        result.likelihood_gate !== "blocked" ||
        !result.failures.some(
          (failure) =>
            failure.code ===
              "log_visibility_likelihood_coverage_failure",
        )
      ) {
        throw new Error(
          "stage4_2b_low_visibility_coverage_was_not_blocked",
        );
      }
      return finalizeFixtureExecution({
        fixture,
        mutatedInput: input,
        runtimeOutput: result,
        observedGate: "blocked",
        observedStatus: "likelihood_not_covered",
        firstFailureCode:
          "log_visibility_likelihood_coverage_failure",
        evidence: {
          injected_visibility: row.visibility,
          minimum_covered_visibility:
            input.likelihood.minimum_covered_visibility,
          likelihood_gate: result.likelihood_gate,
        },
      });
    }
  }
}

function buildRunOrderLedger(args: {
  fixtureResults: FixtureExecution[];
}) {
  const evidenceByStage: Record<string, string[]> = {
    freeze_claim_policy_conventions_sources_and_upstream_authorities: [
      "config_contract",
      "authority_integrity",
      "source_registry",
    ],
    freeze_dp_manifest_external_bounds_ordinary_registry_and_bridge_policy: [
      "dp_applicability_manifest",
      "runtime_d_external_bound_mapping",
      "runtime_e_bridge_registry",
    ],
    validate_blind_generation_and_synthetic_custody_mode: [
      "synthetic_contract_only",
      "automatic_unblinding_prohibited",
    ],
    ingest_calibration_and_pilot_artifacts_only: [
      "runtime_b_pilot_partition",
      "runtime_c_sensor_model",
      "runtime_e_pilot_partition",
    ],
    validate_object_mass_composition_density_geometry_and_hierarchy: [
      "runtime_a_object_ledger",
    ],
    validate_complete_joint_system_branches_and_equivalence: [
      "runtime_a_boundary_equivalence",
      "runtime_d_branch_density_ledger",
    ],
    validate_material_response_kk_geometry_surfaces_and_solver_receipts: [
      "optical_response_recovery",
      "lifshitz_recovery",
      "runtime_b_field_response",
    ],
    fit_response_corrected_spectral_thermometry_from_pilot: [
      "runtime_b_output",
    ],
    fit_sensor_noise_and_cross_spectral_response_from_pilot: [
      "runtime_c_output",
    ],
    predict_all_registered_ordinary_phase_and_decoherence_lanes: [
      "runtime_b_thermal_jump_vector",
      "runtime_c_ordinary_prediction_vector",
    ],
    compute_frozen_dp_density_functional_scaling_and_companion: [
      "runtime_d_named_dp_prediction",
      "runtime_d_companion_forecast",
    ],
    reconcile_dp_manifests_and_conditional_boundary_identity: [
      "runtime_d_numerical_reconciliation",
      "runtime_a_conditional_boundary_identity",
    ],
    construct_pilot_likelihood_residual_covariance_and_coverage: [
      "runtime_e_likelihood",
      "runtime_e_covariance_factorization",
    ],
    forecast_signature_identifiability_power_and_coverage: [
      "runtime_f_power_forecast",
      "runtime_f_parameter_regions",
      "receipt_bound_deterministic_power_coverage_diagnostic",
    ],
    run_synthetic_recovery_and_fail_closed_fixtures:
      args.fixtureResults.map((row) => `fixture:${row.case_id}`),
    freeze_code_exclusions_covariance_predictions_cells_and_scoring: [
      "software_source_snapshot",
      "runtime_e_freeze_contract",
      "runtime_f_design_contract",
    ],
    ingest_synthetic_held_out_artifacts_after_freeze: [
      "runtime_e_synthetic_held_out_partition",
    ],
    estimate_held_out_complex_coherence_without_refitting: [
      "stage3_complex_coherence_reuse",
      "runtime_e_frozen_model_scores",
    ],
    retain_custodian_authority_and_prohibit_automatic_unblinding: [
      "synthetic_contract_only",
      "unblinded_false",
    ],
    score_blinded_synthetic_held_out_comparison: [
      "runtime_e_blinded_model_comparison",
    ],
    populate_outcome_claim_nonclaim_and_blocker_ledger: [
      "outcome_to_claim_map",
      "scientific_standing",
      "apparatus_no_go",
    ],
    write_content_addressed_report_receipt_and_downstream_evidence_state: [
      "immutable_report_json",
      "immutable_report_markdown",
      "immutable_trace_jsonl",
      "campaign_receipt",
    ],
  };
  return CASIMIR_DP_APPARATUS_COHERENCE_RESIDUAL_STAGE4_2B_RUN_ORDER
    .map((stage, index) => ({
      index,
      stage,
      evidence_refs: evidenceByStage[stage] ?? [],
      gate: "pass" as const,
    }));
}

export function renderCasimirDpApparatusCoherenceResidualStage4_2BMarkdown(
  report: {
    campaign_id: string;
    generated_at: string;
    evidence_class: string;
    claim_ceiling: string;
    campaign_gate: string;
    integrity_gate: string;
    promotion_allowed: boolean;
    observable_bridge_edges_added: number;
    authority_integrity: Stage4_2BIntegrityRow[];
    software_source_integrity: Stage4_2BIntegrityRow[];
    fixture_integrity: Stage4_2BIntegrityRow[];
    run_order: Array<{
      index: number;
      stage: string;
      evidence_refs: string[];
      gate: string;
    }>;
    fixture_results: FixtureExecution[];
    apparatus_go_no_go: {
      verdict: string;
      planned_paired_windows: number;
      required_paired_windows: number | null;
      achieved_dp_power: number | null;
      powered_preregistered_region_ids: string[];
      null_exclusion_region_ids_if_measured_null: string[];
      signature_rank: number;
      maximum_abs_whitened_cosine: number;
      worst_signature_pair: {
        left: string;
        right: string;
        cosine: number;
      };
      normalized_gram_condition_number: number | null;
      missing_numeric_control_forecast: string;
    };
    power_coverage_diagnostic: {
      input: {
        method: string;
        strata: number;
        two_sided_alpha: number;
      };
      result: {
        empirical_coverage_probability: number;
        absolute_coverage_error: number;
        gate: string;
      };
      receipt: {
        receipt_sha256: string;
      };
    };
    registered_dp_region: Record<string, unknown>;
    scientific_standing: {
      establishes: string[];
      remains_unmeasured: string[];
      blockers: string[];
    };
    final_gates: Record<string, string>;
  },
): string {
  const authorityRows = report.authority_integrity.map((row) =>
    `| ${row.role} | \`${row.path}\` | \`${row.expected_sha256 ?? "none"}\` | \`${row.actual_sha256 ?? "missing"}\` | ${row.gate} |`
  ).join("\n");
  const sourceRows = report.software_source_integrity.map((row) =>
    `| ${row.role} | \`${row.path}\` | \`${row.actual_sha256 ?? "missing"}\` | ${row.gate} |`
  ).join("\n");
  const fixtureRows = report.fixture_results.map((row) =>
    `| ${row.case_id} | ${row.target_runtime} | \`${row.mutation}\` | ${row.observed_gate} | ${row.observed_status} |`
  ).join("\n");
  const runRows = report.run_order.map((row) =>
    `| ${row.index + 1} | \`${row.stage}\` | ${row.evidence_refs.map((ref) => `\`${ref}\``).join(", ")} | ${row.gate} |`
  ).join("\n");
  return `# Casimir-DP apparatus-coherence residual Stage-4.2B report

**Campaign:** \`${report.campaign_id}\`  
**Generated:** ${report.generated_at}  
**Evidence class:** \`${report.evidence_class}\`  
**Claim ceiling:** \`${report.claim_ceiling}\`  
**Promotion allowed:** \`${report.promotion_allowed}\`  
**Observable bridge edges added:** \`${report.observable_bridge_edges_added}\`

## Standing

The Stage-4.2B campaign gate is \`${report.campaign_gate}\`, and the
content/integrity gate is \`${report.integrity_gate}\`. This is a synthetic
software, covariance, falsifier, and apparatus-power forecast. It is not a
measurement of ordinary decoherence, objective collapse, DP dynamics,
Casimir-modified collapse, quantum foam, or manifold dynamics.

### What the runtime establishes

${report.scientific_standing.establishes.map((row) => `- ${row}`).join("\n")}

### What remains unmeasured

${report.scientific_standing.remains_unmeasured.map((row) => `- ${row}`).join("\n")}

### Active blockers

${report.scientific_standing.blockers.map((row) => `- ${row}`).join("\n")}

## Frozen apparatus verdict

- Verdict: \`${report.apparatus_go_no_go.verdict}\`
- Planned paired windows: \`${report.apparatus_go_no_go.planned_paired_windows}\`
- Required paired windows: \`${report.apparatus_go_no_go.required_paired_windows ?? "not_estimable_until_identifiable"}\`
- Achieved DP power: \`${report.apparatus_go_no_go.achieved_dp_power ?? "not_estimable_until_identifiable"}\`
- Signature rank: \`${report.apparatus_go_no_go.signature_rank}\`
- Maximum absolute whitened cosine: \`${report.apparatus_go_no_go.maximum_abs_whitened_cosine}\`
- Worst signature pair: \`${report.apparatus_go_no_go.worst_signature_pair.left}\` / \`${report.apparatus_go_no_go.worst_signature_pair.right}\` (\`${report.apparatus_go_no_go.worst_signature_pair.cosine}\`)
- Normalized Gram condition number: \`${report.apparatus_go_no_go.normalized_gram_condition_number ?? "not_identifiable"}\`
- Missing control forecast: ${report.apparatus_go_no_go.missing_numeric_control_forecast}
- Powered preregistered regions: \`${report.apparatus_go_no_go.powered_preregistered_region_ids.join(", ") || "none"}\`
- Regions a future measured null could exclude: \`${report.apparatus_go_no_go.null_exclusion_region_ids_if_measured_null.join(", ") || "none"}\`
- Power-coverage method: \`${report.power_coverage_diagnostic.input.method}\`
- Deterministic strata: \`${report.power_coverage_diagnostic.input.strata}\`
- Empirical two-sided coverage: \`${report.power_coverage_diagnostic.result.empirical_coverage_probability}\`
- Coverage receipt: \`${report.power_coverage_diagnostic.receipt.receipt_sha256}\`

The explicit result is a current-apparatus signature-identifiability no-go.
Power and required-window claims are withheld until the frozen nuisance
signatures are identifiable. This is a design finding, not an exclusion of DP.

## Frozen DP region and boundary rule

\`\`\`json
${JSON.stringify(report.registered_dp_region, null, 2)}
\`\`\`

The conditional boundary null is enforced only for the registered
nonrelativistic Markovian mass-density DP generator when complete joint-system
equivalence is demonstrated. The campaign baseline uses design-assumption
state preparation, so the experimental equivalence gate and boundary-null
claim remain not ready. The XENONnT bound is contextual and does not truncate
the parameter region.

## Authority integrity

| Role | Path | Expected SHA-256 | Actual SHA-256 | Gate |
|---|---|---|---|---|
${authorityRows}

## Runtime and predecessor source snapshot

| Role | Path | SHA-256 | Gate |
|---|---|---|---|
${sourceRows}

## Nineteen executed falsification fixtures

| Case | Runtime | Mutation | Observed gate | Observed status |
|---|---|---|---|---|
${fixtureRows}

Every row above was executed through its target A-F evaluator (including strict
schema rejection where omission itself is prohibited). Expected labels were
checked against observed gates and classifications; they were not copied into
the report as unevaluated expectations.

## Required order of operations

| # | Stage | Evidence receipt(s) | Gate |
|---:|---|---|---|
${runRows}

## Final evidence state

${Object.entries(report.final_gates).map(([gate, status]) => `- \`${gate}\`: \`${status}\``).join("\n")}

The immutable timestamped JSON/Markdown pair, trace, and campaign receipt are
the campaign authority. This maintained report is a readable projection only.
`;
}

export async function runCasimirDpApparatusCoherenceResidualStage4_2B(
  args: {
    configPath: string;
    outRoot?: string | null;
    reportDoc?: string | null;
    now?: Date;
  },
) {
  const configPath = path.resolve(args.configPath);
  const configText = await readFile(configPath, "utf8");
  const config =
    CasimirDpApparatusCoherenceResidualStage4_2BConfig.parse(
      JSON.parse(configText),
    );
  assertRunOrder(config);

  const authorityManifestText = await readFile(
    path.resolve(config.authority_manifest.path),
    "utf8",
  );
  const authorityManifest =
    JSON.parse(authorityManifestText) as AuthorityManifest;
  validateAuthorityManifest(config, authorityManifest);

  const fixtureText = await readFile(
    path.resolve(config.runtime_fixture.path),
    "utf8",
  );
  if (sha256(fixtureText) !== config.runtime_fixture.sha256) {
    throw new Error("stage4_2b_fixture_matrix_hash_mismatch");
  }
  const fixtureMatrix = JSON.parse(fixtureText) as SyntheticMatrix;
  validateSyntheticMatrix(config, fixtureMatrix);

  const authorityIntegrity = await Promise.all(
    [config.authority_manifest, ...config.upstream_authorities].map(
      (authority) =>
        integrityRow({
          role: authority.role,
          path: authority.path,
          expectedSha256: authority.sha256,
          requiredAtRuntime: authority.required_at_runtime,
          trackedExpected: authority.tracked,
        }),
    ),
  );

  const allSourcePaths = [
    config.software.runner,
    ...config.software.module_ids,
    ...config.software.reused_module_ids,
  ];
  const uniqueSourcePaths = [...new Set(allSourcePaths)];
  const softwareSourceIntegrity = await Promise.all(
    uniqueSourcePaths.map((sourcePath) =>
      integrityRow({
        role:
          sourcePath === config.software.runner
            ? "stage4_2b_runner"
            : config.software.module_ids.includes(sourcePath as never)
              ? `stage4_2b_runtime_source:${sourcePath}`
              : `reused_predecessor_source:${sourcePath}`,
        path: sourcePath,
        requiredAtRuntime: true,
      })
    ),
  );
  const companionFixturePath =
    "configs/research/fixtures/casimir-dp-stage3-dp-companion.synthetic.v1.json";
  const complexFixturePath =
    "configs/research/fixtures/casimir-dp-stage3-complex-coherence.synthetic.v1.json";
  const fixtureIntegrity = await Promise.all([
    integrityRow({
      role: "stage4_2b_synthetic_campaign_matrix",
      path: config.runtime_fixture.path,
      expectedSha256: config.runtime_fixture.sha256,
      requiredAtRuntime: true,
    }),
    integrityRow({
      role: "stage3_dp_companion_reuse_fixture",
      path: companionFixturePath,
      requiredAtRuntime: true,
    }),
    integrityRow({
      role: "stage3_complex_coherence_reuse_fixture",
      path: complexFixturePath,
      requiredAtRuntime: true,
    }),
  ]);
  const firstIntegrityFailure = [
    ...authorityIntegrity,
    ...softwareSourceIntegrity,
    ...fixtureIntegrity,
  ].find((row) =>
    row.required_at_runtime && row.gate !== "pass"
  );
  if (firstIntegrityFailure != null) {
    throw new Error(
      `stage4_2b_integrity_failure:${firstIntegrityFailure.role}`,
    );
  }

  const [companionFixtureText, complexFixtureText, proposalConfigText] =
    await Promise.all([
      readFile(path.resolve(companionFixturePath), "utf8"),
      readFile(path.resolve(complexFixturePath), "utf8"),
      readFile(
        path.resolve("configs/research/casimir-dp-proposal-closure.v1.json"),
        "utf8",
      ),
    ]);

  const stage3ComplexInput = CasimirDpComplexCoherenceInput.parse(
    JSON.parse(complexFixtureText),
  );
  const stage3ComplexCoherence =
    evaluateCasimirDpComplexCoherence(stage3ComplexInput);
  if (
    stage3ComplexCoherence.evidence_class !== "synthetic_fixture" ||
    stage3ComplexCoherence.provenance_gate !== "pass" ||
    stage3ComplexCoherence.measured_evidence_gate !== "not_ready" ||
    stage3ComplexCoherence.collapse_identification !== "blocked" ||
    stage3ComplexCoherence.manifold_dynamics !== "blocked"
  ) {
    throw new Error(
      "stage4_2b_stage3_complex_coherence_reconciliation_failure",
    );
  }
  const opticalCasimirDiagnostics =
    runOpticalAndCasimirDiagnostics();
  const dataReadiness = runDataReadinessDiagnostic();
  const proposalReadiness = evaluateCasimirDpProposalReadiness(
    JSON.parse(proposalConfigText) as never,
  );
  if (
    proposalReadiness.gate_ledger.proposal_package !== "pass" ||
    proposalReadiness.gate_ledger
      .measured_switching_and_decoherence_evidence !== "not_ready"
  ) {
    throw new Error(
      "stage4_2b_proposal_readiness_reconciliation_failure",
    );
  }
  const powerCoverageDiagnostic =
    runDeterministicPowerCoverageDiagnostic(
      config.thresholds.maximum_false_positive_rate,
    );

  const AInput = buildRuntimeAInput(config);
  const runtimeA = evaluateCasimirDpApparatusScaleTransportStage4_2B(
    AInput,
  );
  const designRegistry = buildStage4_2BDesignRegistry(config, runtimeA);
  const BInput = buildRuntimeBInput();
  const runtimeB =
    evaluateCasimirDpApparatusSpectralThermometryStage4_2B(BInput);
  const runtimeCBundle =
    buildCoupledRuntimeCInput(designRegistry, runtimeB);
  const runtimeC = evaluateCasimirDpApparatusResponseCovarianceStage4_2B(
    runtimeCBundle.input,
  );
  const runtimeDBundle = buildCoupledRuntimeDInput(
    config,
    designRegistry,
    runtimeA,
    JSON.parse(companionFixtureText),
  );
  const runtimeD = evaluateCasimirDpDpScalingForecastStage4_2B(
    runtimeDBundle.input,
  );
  const runtimeEBundle = buildCoupledRuntimeEInput(
    config,
    designRegistry,
    runtimeC,
    runtimeD,
  );
  const runtimeE =
    evaluateCasimirDpApparatusCoherenceResidualStage4_2B(
      runtimeEBundle.input,
    );
  const runtimeFBundle = buildCoupledRuntimeFInput(
    config,
    designRegistry,
    runtimeC,
    runtimeD,
    runtimeE,
    runtimeEBundle,
    powerCoverageDiagnostic,
  );
  const runtimeF = evaluateCasimirDpApparatusIdentifiabilityStage4_2B(
    runtimeFBundle.input,
  );
  const inputs = {
    AInput,
    BInput,
    CInput: runtimeCBundle.input,
    DInput: runtimeDBundle.input,
    EInput: runtimeEBundle.input,
    FInput: runtimeFBundle.input,
  };
  const runtimeOutputs = {
    A: runtimeA,
    B: runtimeB,
    C: runtimeC,
    D: runtimeD,
    E: runtimeE,
    F: runtimeF,
  };
  const couplingAdapters = {
    design_registry: designRegistry,
    runtime_b_to_c: runtimeCBundle.thermalAdapter,
    runtime_a_to_d: runtimeDBundle.adapter,
    stage3_complex_to_e: {
      object_receipt_role:
        "algorithm_only_not_per_cell_physics_authority" as const,
      per_cell_physics_authority:
        "stage4_2b_design_grid_registry" as const,
      quadrature_input_sha256:
        sha256(stableJson(runtimeEBundle.quadratureInput)),
      quadrature_output_sha256:
        sha256(stableJson(runtimeEBundle.quadratureResult)),
      cell_registry_sha256: designRegistry.registry_sha256,
      cell_order_sha256: designRegistry.cell_order_sha256,
      recovered_complex_rows:
        runtimeEBundle.quadratureResult.summaries.map((summary) => ({
          cell_id: summary.blind_boundary_state,
          real: summary.raw?.real ?? null,
          imaginary: summary.raw?.imaginary ?? null,
          visibility: summary.raw?.visibility ?? null,
          phase_rad: summary.raw?.phase_rad ?? null,
        })),
    },
    c_and_quadrature_to_e_complex_covariance:
      runtimeEBundle.complexCovarianceAdapter,
    c_d_to_e_prediction_vector_sha256:
      runtimeEBundle.predictionVectorSha,
    e_c_d_to_f_whitening: {
      ...runtimeFBundle.adapter,
      raw_signature_vectors: runtimeFBundle.rawVectors,
      whitened_signature_vectors: runtimeFBundle.whitenedVectors,
    },
  };
  const baselineFailures = [
    ["A", runtimeOutputs.A.status],
    ["B", runtimeOutputs.B.status],
    ["C", runtimeOutputs.C.status],
    ["D", runtimeOutputs.D.gate],
    ["E", runtimeOutputs.E.gate],
  ].filter(([, gate]) => gate !== "pass");
  if (baselineFailures.length > 0) {
    throw new Error(
      `stage4_2b_baseline_runtime_failure:${stableJson({
        failures: baselineFailures.map(([id, gate]) => ({ id, gate })),
        runtime_f: {
          blockers: runtimeOutputs.F.blockers,
          signature_rank: runtimeOutputs.F.signature_rank,
          maximum_abs_whitened_cosine:
            runtimeOutputs.F.maximum_abs_whitened_cosine,
          normalized_gram_condition_number:
            runtimeOutputs.F.normalized_gram_condition_number,
          feasibility_verdict: runtimeOutputs.F.feasibility_verdict,
        },
      })}`,
    );
  }
  if (
    runtimeOutputs.D.external_bound_mapping.parameter_region_status !==
      "contextual_only" ||
    runtimeOutputs.D.conditional_boundary_null
      .experimental_branch_equivalence.gate !== "not_ready" ||
    runtimeOutputs.D.conditional_boundary_null
      .boundary_null_claim_allowed !== false
  ) {
    throw new Error(
      "stage4_2b_design_assumption_or_contextual_bound_promoted",
    );
  }
  if (
    runtimeOutputs.F.gate !== "blocked" ||
    runtimeOutputs.F.feasibility_verdict !==
      "signature_not_identifiable" ||
    !runtimeOutputs.F.blockers.includes(
      "signature_collinearity_above_threshold",
    ) ||
    !runtimeOutputs.F.blockers.includes(
      "augmented_design_condition_number_above_threshold",
    ) ||
    runtimeOutputs.F.powered_preregistered_region_ids.length !== 0 ||
    runtimeOutputs.F.null_exclusion_region_ids_if_measured_null.length !==
      0
  ) {
    throw new Error(
      "stage4_2b_frozen_apparatus_must_return_identifiability_no_go",
    );
  }
  const worstSignaturePair = runtimeOutputs.F.pairwise_cosines.reduce(
    (worst, row) =>
      Math.abs(row.cosine) > Math.abs(worst.cosine) ? row : worst,
    runtimeOutputs.F.pairwise_cosines[0],
  );
  if (worstSignaturePair == null) {
    throw new Error("stage4_2b_signature_pair_diagnostic_missing");
  }

  const fixtureOnlyUnderpoweredFInput =
    buildFixtureOnlyUnderpoweredIdentifiableFInput(
      config,
      powerCoverageDiagnostic,
    );
  const fixtureResults = fixtureMatrix.cases.map((fixture) =>
    executeSyntheticFixture(
      fixture,
      inputs,
      fixtureOnlyUnderpoweredFInput,
    )
  );
  if (
    fixtureResults.length !== 19 ||
    fixtureResults.some((result) => result.gate !== "pass")
  ) {
    throw new Error("stage4_2b_fixture_campaign_failure");
  }

  const runOrder = buildRunOrderLedger({ fixtureResults });
  if (
    runOrder.length !== 22 ||
    runOrder.some(
      (row, index) =>
        row.index !== index ||
        row.stage !==
          CASIMIR_DP_APPARATUS_COHERENCE_RESIDUAL_STAGE4_2B_RUN_ORDER[
            index
          ] ||
        row.evidence_refs.length === 0 ||
        row.gate !== "pass",
    )
  ) {
    throw new Error("stage4_2b_run_order_evidence_failure");
  }

  const generatedAt = (args.now ?? new Date()).toISOString();
  const runtimeInputReceipts = Object.entries(inputs).map(
    ([runtime, input]) => ({
      runtime: runtime.slice(0, 1),
      input_sha256: sha256(stableJson(input)),
      frozen_before_synthetic_held_out: true,
    }),
  );
  const runtimeOutputReceipts = Object.entries(runtimeOutputs).map(
    ([runtime, output]) => ({
      runtime,
      output_sha256: sha256(stableJson(output)),
      gate:
        runtime === "A" || runtime === "B" || runtime === "C"
          ? (output as { status: string }).status
          : (output as { gate: string }).gate,
      evidence_class: "synthetic_fixture" as const,
    }),
  );
  const reuseLedger = config.software.reused_module_ids.map(
    (moduleId) => ({
      module_id: moduleId,
      source_sha256:
        softwareSourceIntegrity.find((row) => row.path === moduleId)
          ?.actual_sha256 ?? null,
      reconciliation:
        moduleId === "shared/casimir-dp-complex-coherence.ts"
          ? "executed_by_runtime_g_against_immutable_stage3_fixture"
          : moduleId === "shared/dp-collapse.ts" ||
              moduleId === "shared/casimir-dp-dp-companion.ts"
            ? "executed_transitively_by_runtime_d"
            : moduleId === "shared/casimir-dp-inference.ts"
              ? "executed_transitively_by_runtime_f"
              : moduleId === "shared/casimir-dp-data-readiness.ts"
                ? "executed_by_runtime_g_synthetic_readiness_diagnostic"
                : moduleId ===
                    "shared/casimir-dp-proposal-readiness.ts"
                  ? "executed_by_runtime_g_against_frozen_proposal_config"
                  : moduleId === "shared/casimir-optical-response.ts" ||
                      moduleId === "shared/casimir-lifshitz.ts"
                    ? "executed_by_runtime_g_synthetic_recovery_diagnostic"
                    : "hash_bound_and_reconciled_through_runtime_or_upstream_authority",
      evidence_transport: false,
    }),
  );
  const gitHead = await currentGitHead();
  const gitState = await worktreeState();

  const report = {
    schema_version:
      "casimir_dp_apparatus_coherence_residual_stage4_2b_report/1" as const,
    study_id: config.study_id,
    campaign_id: config.campaign_id,
    implementation_version: config.implementation_version,
    generated_at: generatedAt,
    evidence_cutoff: config.evidence_cutoff,
    evidence_class: config.evidence_class,
    claim_ceiling: config.claim_ceiling,
    promotion_allowed: false as const,
    observable_bridge_edges_added: 0 as const,
    campaign_gate: "pass" as const,
    integrity_gate: "pass" as const,
    authority_integrity: authorityIntegrity,
    immutable_upstream_authorities_unchanged: true as const,
    software_source_integrity: softwareSourceIntegrity,
    fixture_integrity: fixtureIntegrity,
    source_registry: config.source_registry,
    conventions: config.conventions,
    evidence_policy: config.evidence_policy,
    software_snapshot: {
      git_head: gitHead,
      worktree_state: gitState,
      runtime: process.version,
    },
    predecessor_reconciliation: {
      reuse_ledger: reuseLedger,
      stage3_complex_coherence: stage3ComplexCoherence,
      optical_and_casimir_diagnostics: opticalCasimirDiagnostics,
      data_readiness: dataReadiness,
      proposal_readiness: proposalReadiness,
      power_coverage_diagnostic: powerCoverageDiagnostic,
      parameter_transport_is_evidence_transport: false as const,
    },
    blind_custody: {
      mode: "synthetic_contract_only" as const,
      sentinel_custody_hash_used: false as const,
      custodian_authorization_present: false as const,
      automatic_unblinding_allowed: false as const,
      unblinded: false as const,
      measured_confirmatory_scoring_performed: false as const,
    },
    coupling_adapters: couplingAdapters,
    runtime_input_receipts: runtimeInputReceipts,
    runtime_inputs: inputs,
    runtime_output_receipts: runtimeOutputReceipts,
    runtime_outputs: runtimeOutputs,
    fixture_results: fixtureResults,
    fixture_summary: {
      required: 19,
      executed: fixtureResults.length,
      matched_expected_gate_and_status: fixtureResults.filter(
        (row) => row.gate === "pass",
      ).length,
      all_pass: true as const,
    },
    power_coverage_diagnostic: powerCoverageDiagnostic,
    frozen_prediction_space: {
      ordinary_prediction_vector:
        runtimeOutputs.C.cell_predictions,
      named_dp_prediction_vector:
        runtimeOutputs.D.named_dp_prediction.rows,
      residual_covariance:
        runtimeOutputs.C.residual_covariance,
      complex_coherence_model_scores:
        runtimeOutputs.E.model_scores,
      bridge_hypothesis: {
        admitted: false as const,
        observable_bridge_edges_added: 0 as const,
      },
    },
    registered_dp_region: {
      model_id: config.dp_applicability_manifest.model_id,
      generator: config.dp_applicability_manifest.generator,
      mass_kg: config.apparatus.nominal_mass_kg,
      radius_m: config.apparatus.nominal_radius_m,
      branch_separation_m:
        config.apparatus.nominal_branch_separation_m,
      hold_time_s: config.apparatus.nominal_hold_time_s,
      r0_m: config.dp_applicability_manifest.r0_m,
      parameter_manifest_sha256:
        config.dp_applicability_manifest.stage3_manifest_sha256,
      state_preparation_evidence_class:
        config.apparatus.state_preparation_evidence_class,
      xenon_parameter_map_status:
        config.dp_applicability_manifest.xenon_r0_parameter_map_status,
      xenon_bound_truncates_region:
        config.dp_applicability_manifest
          .xenon_bound_used_to_truncate_parameter_space,
      conditional_boundary_identity: {
        analytic_model_scope:
          "registered_nonrelativistic_markovian_mass_density_dp_only",
        complete_joint_system_equivalence_required: true,
        numerical_recovery_gate:
          runtimeOutputs.D.conditional_boundary_null
            .numerical_recovery.gate,
        experimental_equivalence_gate:
          runtimeOutputs.D.conditional_boundary_null
            .experimental_branch_equivalence.gate,
        boundary_null_claim_allowed:
          runtimeOutputs.D.conditional_boundary_null
            .boundary_null_claim_allowed,
      },
    },
    apparatus_go_no_go: {
      verdict: runtimeOutputs.F.feasibility_verdict,
      planned_paired_windows:
        runtimeOutputs.F.planned_paired_windows,
      required_paired_windows: null,
      achieved_dp_power: null,
      required_windows_numerically_inaccessible: null,
      powered_preregistered_region_ids:
        runtimeOutputs.F.powered_preregistered_region_ids,
      null_exclusion_region_ids_if_measured_null:
        runtimeOutputs.F.null_exclusion_region_ids_if_measured_null,
      signature_rank: runtimeOutputs.F.signature_rank,
      maximum_abs_whitened_cosine:
        runtimeOutputs.F.maximum_abs_whitened_cosine,
      worst_signature_pair: worstSignaturePair,
      normalized_gram_condition_number:
        runtimeOutputs.F.normalized_gram_condition_number,
      missing_numeric_control_forecast:
        "The 30 frozen OAT/sham/detuned control rows define axis and level identities but do not yet provide source-backed numeric response vectors plus a block-bound control covariance; they cannot be used to claim nuisance identifiability.",
      interpretation:
        "current_apparatus_signature_identifiability_no_go_is_not_a_dp_exclusion",
    },
    outcome_to_claim_map:
      CASIMIR_DP_STAGE4_2B_OUTCOME_TO_CLAIM_MAP,
    scientific_standing: {
      establishes: [
        "Runtimes A-E execute in one frozen observable/covariance space, and Runtime F fails closed on the physical signature matrix rather than substituting an orthogonal proxy.",
        "Composition-aware object and branch-density transport reaches a named E_G/hbar DP forecast without treating cross-scale identities as mechanism evidence.",
        "Response-corrected thermometry, ordinary decoherence, sensor self-noise separation, full covariance, conditional-DP-boundary logic, and no-retuning rules are fail closed.",
        "All 19 recovery, contamination, leakage, retuning, covariance, coverage, and power fixtures execute with their preregistered outcomes.",
        `The coupled physical signature forecast is not identifiable: rank ${runtimeOutputs.F.signature_rank}, maximum absolute whitened cosine ${runtimeOutputs.F.maximum_abs_whitened_cosine}, worst pair ${worstSignaturePair.left}/${worstSignaturePair.right}, and normalized Gram condition number ${runtimeOutputs.F.normalized_gram_condition_number}.`,
      ],
      remains_unmeasured: [
        "Authentic object, branch, material-response, spectral, sensor, nuisance, and confirmatory coherence artifacts.",
        "Measured ordinary-decoherence closure and a replicated held-out residual.",
        "Measured mass-separation-time DP scaling and an independently powered applicable companion.",
        "Any Casimir-to-collapse transfer kernel, objective-collapse identification, quantum-foam dynamics, or manifold dynamics.",
      ],
      blockers: [
        "measured_evidence_not_ready",
        "ordinary_decoherence_closure_not_ready",
        "branch_provenance_design_assumption_only",
        "frozen_named_dp_region_power_not_estimable_until_identifiable",
        "signature_identifiability_blocked",
        "numeric_control_response_and_covariance_forecasts_not_registered",
        "collapse_identification_blocked",
        "manifold_dynamics_blocked",
        "physical_viability_not_evaluated",
      ],
    },
    run_order: runOrder,
    final_gates: config.final_status_policy,
    fresh_casimir_verification: {
      status: "pending_external_verification" as const,
      trace_sha256: null,
      certificate_sha256: null,
      integrity: null,
    },
  };
  if (
    stableJson(report.final_gates) !==
      stableJson(config.final_status_policy)
  ) {
    throw new Error("stage4_2b_final_status_policy_mismatch");
  }

  const now = new Date(generatedAt);
  const timestamp = now.toISOString().replace(/[-:.]/g, "");
  const outDir = path.resolve(
    args.outRoot ??
      path.join(
        "artifacts",
        "research",
        "casimir-dp-apparatus-coherence-residual-stage4-2b",
        `${config.campaign_id}-${timestamp}`,
      ),
  );
  await mkdir(path.dirname(outDir), { recursive: true });
  await mkdir(outDir, { recursive: false });

  const reportJsonName =
    "apparatus-coherence-residual-stage4-2b-report.json";
  const reportMarkdownName =
    "apparatus-coherence-residual-stage4-2b-report.md";
  const traceName =
    "apparatus-coherence-residual-stage4-2b-trace.jsonl";
  const receiptName =
    "apparatus-coherence-residual-stage4-2b-receipt.json";
  const reportJson = stableJson(report);
  const reportMarkdown =
    renderCasimirDpApparatusCoherenceResidualStage4_2BMarkdown(
      report,
    );
  const traceRows = [
    ...runOrder.map((row) => ({
      schema_version: "casimir_dp_stage4_2b_trace/1",
      campaign_id: config.campaign_id,
      generated_at: generatedAt,
      record_type: "run_order_stage",
      ...row,
    })),
    ...fixtureResults.map((row, index) => ({
      schema_version: "casimir_dp_stage4_2b_trace/1",
      campaign_id: config.campaign_id,
      generated_at: generatedAt,
      record_type: "synthetic_fixture_execution",
      index,
      case_id: row.case_id,
      mutation_fingerprint_sha256:
        row.mutation_fingerprint_sha256,
      runtime_output_sha256: row.runtime_output_sha256,
      observed_gate: row.observed_gate,
      observed_status: row.observed_status,
      evidence_class: row.evidence_class,
    })),
    {
      schema_version: "casimir_dp_stage4_2b_trace/1",
      campaign_id: config.campaign_id,
      generated_at: generatedAt,
      record_type: "power_coverage_diagnostic",
      receipt_sha256:
        powerCoverageDiagnostic.receipt.receipt_sha256,
      empirical_coverage_probability:
        powerCoverageDiagnostic.result
          .empirical_coverage_probability,
      gate: powerCoverageDiagnostic.result.gate,
      evidence_class: "synthetic_fixture",
    },
  ];
  const traceJsonl = `${traceRows.map((row) =>
    JSON.stringify(row)
  ).join("\n")}\n`;
  await writeFile(
    path.join(outDir, reportJsonName),
    reportJson,
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(
    path.join(outDir, reportMarkdownName),
    reportMarkdown,
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(
    path.join(outDir, traceName),
    traceJsonl,
    { encoding: "utf8", flag: "wx" },
  );

  const receipt = {
    schema_version:
      "casimir_dp_apparatus_coherence_residual_stage4_2b_receipt/1" as const,
    campaign_id: config.campaign_id,
    generated_at: generatedAt,
    status:
      "campaign_runtime_completed_pending_external_verification" as const,
    evidence_class: config.evidence_class,
    claim_ceiling: config.claim_ceiling,
    promotion_allowed: false as const,
    observable_bridge_edges_added: 0 as const,
    input: {
      path: path.relative(process.cwd(), configPath).replace(/\\/g, "/"),
      sha256: sha256(configText),
    },
    authority_integrity: authorityIntegrity,
    immutable_upstream_authorities_unchanged: true as const,
    software_source_integrity: softwareSourceIntegrity,
    runtime_fixtures: fixtureIntegrity,
    runtime_input_receipts: runtimeInputReceipts,
    runtime_output_receipts: runtimeOutputReceipts,
    coupling_adapters_sha256: sha256(stableJson(couplingAdapters)),
    design_registry_sha256: designRegistry.registry_sha256,
    primary_cell_order_sha256: designRegistry.cell_order_sha256,
    pilot_template_order_sha256:
      designRegistry.partition_cell_templates.pilot.cell_order_sha256,
    independent_replication_template_order_sha256:
      designRegistry.partition_cell_templates.independent_replication
        .cell_order_sha256,
    synthetic_fixture_receipts: fixtureResults.map((row) => ({
      case_id: row.case_id,
      mutation_fingerprint_sha256:
        row.mutation_fingerprint_sha256,
      runtime_output_sha256: row.runtime_output_sha256,
      observed_gate: row.observed_gate,
      observed_status: row.observed_status,
    })),
    power_coverage_receipt: powerCoverageDiagnostic.receipt,
    blind_custody: report.blind_custody,
    apparatus_go_no_go: report.apparatus_go_no_go,
    outputs: [
      {
        path: reportJsonName,
        sha256: sha256(reportJson),
      },
      {
        path: reportMarkdownName,
        sha256: sha256(reportMarkdown),
      },
      {
        path: traceName,
        sha256: sha256(traceJsonl),
        records: traceRows.length,
      },
    ],
    outcome_to_claim_map_sha256: sha256(
      stableJson(CASIMIR_DP_STAGE4_2B_OUTCOME_TO_CLAIM_MAP),
    ),
    final_gates: report.final_gates,
    prior_stage_certificate_artifact_reused: false as const,
    fresh_casimir_certificate: {
      status: "pending_external_verification" as const,
      certificate_sha256: null,
      integrity: null,
    },
  };
  const receiptJson = stableJson(receipt);
  await writeFile(
    path.join(outDir, receiptName),
    receiptJson,
    { encoding: "utf8", flag: "wx" },
  );

  if (args.reportDoc != null) {
    const reportDoc = path.resolve(args.reportDoc);
    await mkdir(path.dirname(reportDoc), { recursive: true });
    await writeFile(reportDoc, reportMarkdown, "utf8");
  }
  return {
    outDir,
    report,
    receipt,
    receipt_sha256: sha256(receiptJson),
  };
}

type CliArgs = {
  configPath: string;
  outRoot: string | null;
  reportDoc: string | null;
};

function parseArgs(argv: string[]): CliArgs {
  let configPath =
    "configs/research/casimir-dp-apparatus-coherence-residual-stage4-2b.v1.json";
  let outRoot: string | null = null;
  let reportDoc: string | null =
    "docs/research/casimir-dp-apparatus-coherence-residual-stage4-2b-report.md";
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    const value = argv[index + 1] ?? "";
    if (argument === "--config") configPath = value;
    else if (argument === "--out") outRoot = value;
    else if (argument === "--report-doc") reportDoc = value;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return { configPath, outRoot, reportDoc };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  runCasimirDpApparatusCoherenceResidualStage4_2B({
    configPath: args.configPath,
    outRoot: args.outRoot,
    reportDoc: args.reportDoc,
  }).then((result) => {
    process.stdout.write(stableJson({
      status: "completed",
      outDir: result.outDir,
      receipt_sha256: result.receipt_sha256,
      campaign_gate: result.report.campaign_gate,
      apparatus_verdict:
        result.report.apparatus_go_no_go.verdict,
      final_gates: result.report.final_gates,
    }));
  }).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
