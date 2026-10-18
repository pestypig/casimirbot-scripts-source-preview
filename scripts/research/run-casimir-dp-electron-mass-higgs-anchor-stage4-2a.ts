#!/usr/bin/env -S tsx

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  CasimirDpElectronMassHiggsAnchorStage4_2AInput,
  evaluateCasimirDpElectronMassHiggsAnchorStage4_2A,
  type CasimirDpElectronMassHiggsAnchorStage4_2AResult,
} from "../../shared/casimir-dp-electron-mass-higgs-anchor-stage4-2a";
import {
  CasimirDpPlanckSolarCalibrationStage4_2AInput,
  evaluateCasimirDpPlanckSolarCalibrationStage4_2A,
  type CasimirDpPlanckSolarCalibrationStage4_2AResult,
} from "../../shared/casimir-dp-planck-solar-calibration-stage4-2a";
import {
  CASIMIR_DP_ELECTRON_MASS_HIGGS_ANCHOR_STAGE4_2A_RUN_ORDER,
  CasimirDpElectronMassHiggsAnchorStage4_2AConfig,
  type CasimirDpElectronMassHiggsAnchorStage4_2AConfig as Stage4_2AConfig,
} from "../../shared/contracts/casimir-dp-electron-mass-higgs-anchor-stage4-2a.v1";
import {
  buildCasimirDpStudyTheoryBadgesV1,
} from "../../shared/theory/casimir-dp-study-theory-badges";

const execFileAsync = promisify(execFile);
const stableJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export type Stage4_2AIntegrityRow = {
  role: string;
  path: string;
  expected_sha256: string;
  actual_sha256: string | null;
  required_at_runtime: boolean;
  tracked_expected: boolean | null;
  tracked_actual: boolean | null;
  gate: "pass" | "not_ready";
};

export const CASIMIR_DP_STAGE4_2A_CROSS_SCALE_CALIBRATION_LADDER = [
  {
    rung: 1,
    calibration:
      "Penning frequency ratios plus bound-state QED infer a source-specific electron relative atomic mass.",
    boundary:
      "This is theory-assisted frequency-ratio metrology, not literal static weighing.",
  },
  {
    rung: 2,
    calibration:
      "E=m_e c^2, E=h nu, and the immutable Stage-4.1 identities transform the same mass anchor into correlated energy, frequency, and atomic-scale views.",
    boundary:
      "Correlated transforms are one identity family and cannot be vote-counted as independent confirmations.",
  },
  {
    rung: 3,
    calibration:
      "The Standard Model tree convention maps the rest-energy anchor to v_F, y_e, and g_h_e_e.",
    boundary:
      "The tree mapping neither predicts why y_e has its value nor directly observes the electron Yukawa coupling.",
  },
  {
    rung: 4,
    calibration:
      "Planck radiance and its Stefan-Boltzmann integral close the h, c, and k_B radiometric bookkeeping.",
    boundary:
      "Planck integration and the Stefan-Boltzmann constant are one identity family, not independent theories.",
  },
  {
    rung: 5,
    calibration:
      "A frozen TSIS spectral peak yields a band/model-dependent color temperature, while IAU luminosity and radius yield a distinct bolometric effective temperature.",
    boundary:
      "Neither solar temperature is derived from the electron mass, and neither temperature is evidence for DP collapse.",
  },
] as const;

export const CASIMIR_DP_STAGE4_2A_EVIDENCE_LEVELS = [
  {
    level: 1,
    name: "objective_nonunitary_collapse",
    required_observation:
      "A replicated held-out residual that survives preregistered ordinary-decoherence closure, discriminates the registered remaining unitary/environmental alternatives, and matches a frozen nonunitary dynamical signature.",
    status: "not_ready",
    established_by_stage4_2a: false,
  },
  {
    level: 2,
    name: "dp_rate_law",
    required_observation:
      "The residual follows a frozen named-model rate law Gamma_DP=E_G/hbar across preregistered mass and geometry changes without retuning.",
    status: "blocked",
    established_by_stage4_2a: false,
  },
  {
    level: 3,
    name: "casimir_boundary_modifies_dp_rate",
    required_observation:
      "A separately registered material-response and boundary-to-collapse transfer kernel predicts a fixed-material-branch change that survives controls.",
    status: "blocked",
    established_by_stage4_2a: false,
  },
] as const;

export const CASIMIR_DP_STAGE4_2A_OUTCOME_TO_CLAIM_MAP = [
  {
    outcome_id: "penning_mass_replay_pass",
    establishes:
      "The corrected bound-electron frequency-ratio equation, correction ledger, ion binding ledger, and source result reproduce at diagnostic precision.",
    does_not_establish:
      "Static weighing, an adjustment-independent electron-mass validation, or Higgs-origin identification.",
    maximum_claim:
      "theory_assisted_electron_mass_metrology_replay",
  },
  {
    outcome_id: "conditional_sm_tree_mapping_pass",
    establishes:
      "The declared tree convention consistently maps m_e c^2 and the Fermi scale to inferred y_e and g_h_e_e values.",
    does_not_establish:
      "A running matched Yukawa parameter, a direct H-to-electron observation, or an explanation of the Yukawa value.",
    maximum_claim: "conditional_standard_model_tree_mapping",
  },
  {
    outcome_id: "planck_stefan_boltzmann_closure_pass",
    establishes:
      "Planck spectral-density Jacobians and the Stefan-Boltzmann integral close under the frozen SI and frequency conventions.",
    does_not_establish:
      "Two independent theories, an apparatus thermal transfer, or a collapse clock.",
    maximum_claim: "radiometric_identity_calibration",
  },
  {
    outcome_id: "solar_temperature_recovery_pass",
    establishes:
      "The frozen TSIS peak and IAU luminosity-radius conversion recover operationally distinct color and bolometric temperatures.",
    does_not_establish:
      "A perfect-blackbody Sun, stellar structure, independent significance without covariance, or DP evidence.",
    maximum_claim: "source_backed_solar_temperature_calibration",
  },
  {
    outcome_id: "cross_scale_dp_nonbridge_pass",
    establishes:
      "The cross-scale dependency ladder preserves zero observable bridge edges and explicit Level-1/2/3 evidence gates.",
    does_not_establish:
      "Casimir-to-DP transfer, objective collapse, manifold dynamics, cosmological lift, or physical viability.",
    maximum_claim: "calibration_dependency_not_mechanism_evidence",
  },
] as const;

type AuthorityManifest = {
  schema_version?: unknown;
  study_id?: unknown;
  campaign_id?: unknown;
  claim_ceiling?: unknown;
  promotion_allowed?: unknown;
  observable_bridge_edges_added?: unknown;
  upstream_stage4_1_authorities?: Array<{
    role?: unknown;
    path?: unknown;
    sha256?: unknown;
    tracked?: unknown;
  }>;
  source_authorities?: unknown[];
  cross_scale_calibration_ladder?: unknown[];
  scientific_boundaries?: unknown[];
};

function assertRunOrder(config: Stage4_2AConfig): void {
  if (
    config.run_order.length !==
      CASIMIR_DP_ELECTRON_MASS_HIGGS_ANCHOR_STAGE4_2A_RUN_ORDER.length
  ) {
    throw new Error("stage4_2a_run_order_length_mismatch");
  }
  CASIMIR_DP_ELECTRON_MASS_HIGGS_ANCHOR_STAGE4_2A_RUN_ORDER.forEach(
    (stage, index) => {
      if (config.run_order[index] !== stage) {
        throw new Error(
          `stage4_2a_run_order[${index}]_must_be_${stage}`,
        );
      }
    },
  );
  const upstream = config.run_order.indexOf(
    "hash_link_immutable_stage4_1_authorities",
  );
  const sources = config.run_order.indexOf(
    "freeze_source_snapshots_roles_paths_and_hashes",
  );
  const mass = config.run_order.indexOf(
    "run_penning_bound_electron_mass_replay",
  );
  const thermal = config.run_order.indexOf(
    "close_planck_spectral_jacobians_and_stefan_boltzmann_integral",
  );
  const nonbridge = config.run_order.indexOf(
    "enforce_cross_scale_dependency_and_dp_nonbridge_semantics",
  );
  const write = config.run_order.indexOf(
    "write_content_addressed_stage4_2a_report_and_receipt",
  );
  if (
    !(
      upstream < sources &&
      sources < mass &&
      mass < thermal &&
      thermal < nonbridge &&
      nonbridge < write
    )
  ) {
    throw new Error(
      "stage4_2a_authorities_and_calibrations_must_precede_nonbridge_and_write",
    );
  }
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

async function integrityRow(args: {
  role: string;
  path: string;
  expectedSha256: string;
  requiredAtRuntime: boolean;
  trackedExpected?: boolean | null;
}): Promise<Stage4_2AIntegrityRow> {
  try {
    const bytes = await readFile(path.resolve(args.path));
    const actual = sha256(bytes);
    const trackedActual = args.trackedExpected == null
      ? null
      : await gitPathTracked(args.path);
    return {
      role: args.role,
      path: args.path,
      expected_sha256: args.expectedSha256,
      actual_sha256: actual,
      required_at_runtime: args.requiredAtRuntime,
      tracked_expected: args.trackedExpected ?? null,
      tracked_actual: trackedActual,
      gate:
        actual === args.expectedSha256
          ? "pass"
          : "not_ready",
    };
  } catch {
    return {
      role: args.role,
      path: args.path,
      expected_sha256: args.expectedSha256,
      actual_sha256: null,
      required_at_runtime: args.requiredAtRuntime,
      tracked_expected: args.trackedExpected ?? null,
      tracked_actual: null,
      gate: "not_ready",
    };
  }
}

function canonicalSourceUrl(value: string): string {
  const url = new URL(value);
  let pathname = url.pathname.replace(/\/index\.html$/iu, "");
  pathname = pathname.replace(/\/+$/u, "");
  return `${url.protocol}//${url.host.toLowerCase()}${pathname}${url.search}`;
}

const FIXTURE_SOURCE_ALIASES = new Map([
  ["koehler_2015_penning_detailed", "koehler-2016-corrected-penning-analysis"],
  ["sturm_2014_nature", "sturm-2014-electron-mass"],
  ["codata_2022", "codata-2022-adjustment"],
  ["pdg_2025_higgs", "pdg-higgs-review-2025"],
  ["cms_hig_21_015", "cms-hig-21-015"],
  ["bipm_si_defining_constants", "bipm-si-defining-constants"],
  ["iau_2015_resolution_b3", "iau-2015-resolution-b3"],
  ["tsis1_hsrs", "tsis1-hsrs"],
]);

function validateAuthorityManifest(
  config: Stage4_2AConfig,
  manifest: AuthorityManifest,
): void {
  if (
    manifest.schema_version !==
      "casimir_dp_stage4_2a_authorities/1" ||
    manifest.study_id !== config.study_id ||
    manifest.campaign_id !== config.campaign_id ||
    manifest.claim_ceiling !== config.claim_ceiling ||
    manifest.promotion_allowed !== false ||
    manifest.observable_bridge_edges_added !== 0
  ) {
    throw new Error("stage4_2a_authority_manifest_contract_failure");
  }
  const manifestUpstream =
    manifest.upstream_stage4_1_authorities ?? [];
  const configUpstream = config.upstream_authorities.map((row) => ({
    role: row.role,
    path: row.path,
    sha256: row.sha256,
    tracked: row.tracked,
  }));
  if (stableJson(manifestUpstream) !== stableJson(configUpstream)) {
    throw new Error(
      "stage4_2a_authority_manifest_upstream_tuple_mismatch",
    );
  }
  const manifestSources = (manifest.source_authorities ?? []).map(
    (source) => {
      const row = source as Record<string, unknown>;
      return {
        source_id: row.source_id,
        url: row.url,
        citation: row.citation,
        supports: row.supports,
        does_not_support: row.does_not_support,
      };
    },
  );
  if (stableJson(manifestSources) !== stableJson(config.source_registry)) {
    throw new Error(
      "stage4_2a_authority_manifest_source_registry_mismatch",
    );
  }
  if (
    !Array.isArray(manifest.cross_scale_calibration_ladder) ||
    manifest.cross_scale_calibration_ladder.length !== 5 ||
    !Array.isArray(manifest.scientific_boundaries) ||
    manifest.scientific_boundaries.length < 5
  ) {
    throw new Error(
      "stage4_2a_authority_manifest_boundary_ledger_missing",
    );
  }
}

function validateSoftwareAuthorityContract(
  config: Stage4_2AConfig,
): void {
  const expectedPaths = new Set([
    config.software.runner,
    ...config.software.module_ids,
  ]);
  const actualPaths = config.software.source_authorities.map(
    (source) => source.path,
  );
  if (
    new Set(actualPaths).size !== actualPaths.length ||
    actualPaths.length !== expectedPaths.size ||
    actualPaths.some((sourcePath) => !expectedPaths.has(sourcePath))
  ) {
    throw new Error(
      "stage4_2a_software_source_authority_tuple_mismatch",
    );
  }
}

function validateFixtureSources(args: {
  config: Stage4_2AConfig;
  massInput: CasimirDpElectronMassHiggsAnchorStage4_2AInput;
  solarInput: CasimirDpPlanckSolarCalibrationStage4_2AInput;
}): void {
  const registry = new Map(
    args.config.source_registry.map((source) => [
      source.source_id,
      source,
    ]),
  );
  const fixtureSources = [
    ...args.massInput.source_registry,
    ...args.solarInput.source_registry,
  ];
  if (fixtureSources.length !== 8) {
    throw new Error(
      "stage4_2a_fixture_source_registry_cardinality_mismatch",
    );
  }
  for (const source of fixtureSources) {
    const canonicalId = FIXTURE_SOURCE_ALIASES.get(source.source_id);
    const authority = canonicalId == null
      ? undefined
      : registry.get(canonicalId);
    if (
      authority == null ||
      canonicalSourceUrl(authority.url) !==
        canonicalSourceUrl(source.url)
    ) {
      throw new Error(
        `stage4_2a_fixture_source_contract_failure:${source.source_id}`,
      );
    }
  }
  if (
    new Set(
      fixtureSources.map((source) =>
        FIXTURE_SOURCE_ALIASES.get(source.source_id)
      ),
    ).size !== args.config.source_registry.length
  ) {
    throw new Error(
      "stage4_2a_fixture_source_registry_coverage_mismatch",
    );
  }
}

function validateFrozenTsisSnapshot(
  input: CasimirDpPlanckSolarCalibrationStage4_2AInput,
  snapshotText: string,
): void {
  const lines = snapshotText.trim().split(/\r?\n/u);
  if (
    lines.shift() !==
      input.tsis_hsrs_snapshot.source_snapshot_format
  ) {
    throw new Error("stage4_2a_tsis_snapshot_header_mismatch");
  }
  const parsedRows = lines.map((line, index) => {
    const fields = line.split(",");
    if (fields.length !== 3) {
      throw new Error(
        `stage4_2a_tsis_snapshot_row_${index}_field_count_mismatch`,
      );
    }
    const values = fields.map(Number);
    if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error(
        `stage4_2a_tsis_snapshot_row_${index}_numeric_contract_failure`,
      );
    }
    return {
      wavelength_nm: values[0],
      irradiance_W_m2_nm: values[1],
      standard_uncertainty_W_m2_nm: values[2],
    };
  });
  const fixtureRows = input.tsis_hsrs_snapshot.points.map((point) => ({
    wavelength_nm: point.wavelength_nm,
    irradiance_W_m2_nm: point.irradiance_W_m2_nm,
    standard_uncertainty_W_m2_nm:
      point.standard_uncertainty_W_m2_nm,
  }));
  if (stableJson(parsedRows) !== stableJson(fixtureRows)) {
    throw new Error("stage4_2a_tsis_snapshot_rows_mismatch");
  }
}

function inspectStage4_2ATheoryBadgeProjection() {
  const graph = buildCasimirDpStudyTheoryBadgesV1();
  const expectedBadgeIds = [
    "study.casimir_dp.electron_mass_higgs_anchor_stage4_2a",
    "study.casimir_dp.planck_solar_calibration_stage4_2a",
  ] as const;
  const badges = expectedBadgeIds.map((id) =>
    graph.badges.find((badge) => badge.id === id)
  );
  const observableBridgeEdgeCount = graph.edges.filter(
    (edge) => edge.observableBridge != null,
  ).length;
  const calculatorPayloadCount = badges.reduce(
    (count, badge) => count + (badge?.calculatorPayloads.length ?? 0),
    0,
  );
  const gate =
    badges.every(
      (badge) =>
        badge != null &&
        badge.status === "diagnostic" &&
        badge.tags.includes("promotion_blocked"),
    ) &&
      calculatorPayloadCount === 0 &&
      observableBridgeEdgeCount === 0
      ? "pass" as const
      : "blocked" as const;
  return {
    expected_badge_ids: expectedBadgeIds,
    graph_badge_count: graph.badges.length,
    graph_edge_count: graph.edges.length,
    projected_badge_count: badges.filter(Boolean).length,
    calculator_payload_count: calculatorPayloadCount,
    observable_bridge_edge_count: observableBridgeEdgeCount,
    gate,
  };
}

function scientificNotation(value: number): string {
  return value === 0 ? "0" : value.toExponential(12);
}

function allIntegrityPass(rows: Stage4_2AIntegrityRow[]): boolean {
  return rows.every((row) =>
    row.gate === "pass" &&
    row.actual_sha256 === row.expected_sha256
  );
}

function combinedFinalGates(args: {
  integrityGate: "pass" | "not_ready";
  mass: CasimirDpElectronMassHiggsAnchorStage4_2AResult;
  solar: CasimirDpPlanckSolarCalibrationStage4_2AResult;
}) {
  return {
    source_authority_integrity: args.integrityGate,
    penning_observational_replay:
      args.mass.final_gates.penning_observational_replay,
    codata_correlated_reproduction:
      args.mass.final_gates.codata_correlated_reproduction,
    unit_dimension_closure:
      args.mass.final_gates.unit_dimension_closure,
    conditional_sm_tree_mapping:
      args.mass.final_gates.conditional_sm_tree_mapping,
    planck_spectral_density_closure:
      args.solar.final_gates.planck_spectral_density_closure,
    stefan_boltzmann_closure:
      args.solar.final_gates.stefan_boltzmann_closure,
    solar_color_temperature_recovery:
      args.solar.final_gates.solar_color_temperature_recovery,
    solar_bolometric_temperature_recovery:
      args.solar.final_gates.solar_bolometric_temperature_recovery,
    temperature_semantics:
      args.solar.final_gates.temperature_semantics,
    cross_scale_dependency_semantics:
      args.solar.final_gates.cross_scale_dependency_semantics,
    independent_electron_mass_validation:
      args.mass.final_gates.independent_electron_mass_validation,
    running_yukawa_at_higgs_scale:
      args.mass.final_gates.running_yukawa_at_higgs_scale,
    direct_electron_yukawa_observation:
      args.mass.final_gates.direct_electron_yukawa_observation,
    electron_mass_from_higgs_identification:
      args.mass.final_gates.electron_mass_from_higgs_identification,
    higgs_origin_identification:
      args.mass.final_gates.higgs_origin_identification,
    independent_solar_validation:
      args.solar.final_gates.independent_solar_validation,
    measured_spectral_fit_significance:
      args.solar.final_gates.measured_spectral_fit_significance,
    stellar_structure_inference:
      args.solar.final_gates.stellar_structure_inference,
    measured_casimir_coherence_evidence:
      args.mass.final_gates.measured_casimir_coherence_evidence,
    casimir_higgs_dp_transfer:
      args.mass.final_gates.casimir_higgs_dp_transfer,
    compton_to_collapse_clock:
      args.mass.final_gates.compton_to_collapse_clock,
    thermal_to_dp_transfer:
      args.solar.final_gates.thermal_to_dp_transfer,
    collapse_identification:
      args.mass.final_gates.collapse_identification,
    manifold_dynamics:
      args.mass.final_gates.manifold_dynamics,
    cosmological_lift:
      args.solar.final_gates.cosmological_lift,
    physical_viability:
      args.mass.final_gates.physical_viability,
    publication_claim:
      "diagnostic_cross_scale_calibration_only" as const,
  };
}

export function buildCasimirDpElectronMassHiggsAnchorStage4_2AReport(
  args: {
    config: Stage4_2AConfig;
    authorityIntegrity: Stage4_2AIntegrityRow[];
    sourceIntegrity: Stage4_2AIntegrityRow[];
    fixtureIntegrity: Stage4_2AIntegrityRow[];
    massCalibration:
      CasimirDpElectronMassHiggsAnchorStage4_2AResult;
    solarCalibration:
      CasimirDpPlanckSolarCalibrationStage4_2AResult;
    theoryBadgeProjection:
      ReturnType<typeof inspectStage4_2ATheoryBadgeProjection>;
    now: Date;
  },
) {
  const integrityRows = [
    ...args.authorityIntegrity,
    ...args.sourceIntegrity,
    ...args.fixtureIntegrity,
  ];
  const integrityGate = allIntegrityPass(integrityRows)
    ? "pass" as const
    : "not_ready" as const;
  const finalGates = combinedFinalGates({
    integrityGate,
    mass: args.massCalibration,
    solar: args.solarCalibration,
  });
  const finalGatesMatchPolicy =
    stableJson(finalGates) ===
      stableJson(args.config.final_status_policy);
  const nonbridgePass =
    !args.config.observable_bridge_edges_allowed &&
    !args.config.evidence_policy.observable_bridge_edges_allowed &&
    args.massCalibration.observable_bridge_edges_added === 0 &&
    args.solarCalibration.semantic_nonbridge
        .observable_bridge_edges_added === 0 &&
    args.massCalibration.final_gates.semantic_nonbridge === "pass" &&
    args.solarCalibration.semantic_nonbridge.gate === "pass" &&
    args.theoryBadgeProjection.gate === "pass";
  const immutableStage4_1Rows = args.authorityIntegrity.filter(
    (row) => row.role.startsWith("stage4_1_"),
  );
  const immutableStage4_1Unchanged =
    immutableStage4_1Rows.length >= 6 &&
    allIntegrityPass(immutableStage4_1Rows);
  const stepGate = (
    pass: boolean,
  ): "pass" | "blocked" => pass ? "pass" : "blocked";
  const stepEvidence = new Map<string, {
    gate: "pass" | "blocked";
    evidence_refs: string[];
  }>([
    [
      "hash_link_immutable_stage4_1_authorities",
      {
        gate: stepGate(immutableStage4_1Unchanged),
        evidence_refs: [
          "authority_integrity:stage4_1_role_path_hash_tuple",
        ],
      },
    ],
    [
      "freeze_source_snapshots_roles_paths_and_hashes",
      {
        gate: stepGate(integrityGate === "pass"),
        evidence_refs: [
          "authority_integrity",
          "software_source_integrity",
          "fixture_integrity",
          "fixture_integrity:tsis_hsrs_frozen_snapshot",
        ],
      },
    ],
    [
      "freeze_si_natural_mass_frequency_higgs_and_temperature_conventions",
      {
        gate: stepGate(
          args.massCalibration.final_gates.unit_dimension_closure ===
            "pass" &&
          args.solarCalibration.constants.gate === "pass",
        ),
        evidence_refs: [
          "mass_calibration:unit_dimension_closure",
          "solar_calibration:constants",
        ],
      },
    ],
    [
      "validate_dependency_dag_source_overlap_and_covariance_semantics",
      {
        gate: stepGate(
          args.massCalibration.final_gates
              .codata_correlated_reproduction === "pass" &&
          args.solarCalibration.final_gates
              .cross_scale_dependency_semantics === "pass",
        ),
        evidence_refs: [
          "mass_calibration:correlated_codata_conversions",
          "solar_calibration:temperature_semantics",
        ],
      },
    ],
    [
      "run_penning_bound_electron_mass_replay",
      {
        gate: stepGate(
          args.massCalibration.final_gates
              .penning_observational_replay === "pass",
        ),
        evidence_refs: [
          "mass_calibration:frequency_ratio_replay",
          "mass_calibration:electron_mass_metrology_replay",
        ],
      },
    ],
    [
      "reproduce_correlated_codata_mass_energy_conversions",
      {
        gate: stepGate(
          args.massCalibration.final_gates
              .codata_correlated_reproduction === "pass",
        ),
        evidence_refs: [
          "mass_calibration:correlated_codata_conversions",
        ],
      },
    ],
    [
      "derive_fermi_scale_and_conditional_tree_yukawa_anchor",
      {
        gate: stepGate(
          args.massCalibration.final_gates
              .conditional_sm_tree_mapping === "pass",
        ),
        evidence_refs: [
          "mass_calibration:standard_model_tree_mapping",
        ],
      },
    ],
    [
      "replay_stage4_1_compton_and_rydberg_identities",
      {
        gate: stepGate(
          args.massCalibration.final_gates.unit_dimension_closure ===
            "pass",
        ),
        evidence_refs: [
          "mass_calibration:standard_model_tree_mapping.identity_replay",
          "authority_integrity:stage4_1_immutable_report_json",
        ],
      },
    ],
    [
      "close_planck_spectral_jacobians_and_stefan_boltzmann_integral",
      {
        gate: stepGate(
          args.solarCalibration.final_gates
              .planck_spectral_density_closure === "pass" &&
          args.solarCalibration.final_gates
              .stefan_boltzmann_closure === "pass",
        ),
        evidence_refs: [
          "solar_calibration:spectral_density_closure",
          "solar_calibration:planck_stefan_boltzmann",
        ],
      },
    ],
    [
      "recover_tsis_color_and_iau_bolometric_temperatures_separately",
      {
        gate: stepGate(
          args.solarCalibration.final_gates
              .solar_color_temperature_recovery === "pass" &&
          args.solarCalibration.final_gates
              .solar_bolometric_temperature_recovery === "pass" &&
          args.solarCalibration.final_gates.temperature_semantics ===
              "pass",
        ),
        evidence_refs: [
          "solar_calibration:solar_spectral_color_temperature",
          "solar_calibration:solar_bolometric_effective_temperature",
          "solar_calibration:temperature_semantics",
        ],
      },
    ],
    [
      "enforce_precision_matching_and_collider_upper_bound_nonclaims",
      {
        gate: stepGate(
          args.massCalibration.final_gates
              .collider_upper_bound_semantics === "pass" &&
          args.massCalibration.final_gates
              .running_yukawa_at_higgs_scale === "blocked" &&
          args.massCalibration.final_gates
              .direct_electron_yukawa_observation === "not_ready",
        ),
        evidence_refs: [
          "mass_calibration:standard_model_tree_mapping.precision_matching",
          "mass_calibration:collider_upper_bound_lane",
        ],
      },
    ],
    [
      "run_formal_zero_vf_domain_exit_recovery",
      {
        gate: stepGate(
          args.massCalibration.final_gates
              .formal_zero_v_domain_exit === "pass",
        ),
        evidence_refs: [
          "mass_calibration:formal_zero_v_domain_exit",
        ],
      },
    ],
    [
      "enforce_cross_scale_dependency_and_dp_nonbridge_semantics",
      {
        gate: stepGate(nonbridgePass),
        evidence_refs: [
          "mass_calibration:semantic_non_bridge",
          "solar_calibration:semantic_nonbridge",
        ],
      },
    ],
    [
      "populate_outcome_nonclaim_falsifier_and_final_gate_ledgers",
      {
        gate: stepGate(finalGatesMatchPolicy),
        evidence_refs: [
          "final_gates",
          "outcome_to_claim_map",
          "dp_evidence_levels",
        ],
      },
    ],
    [
      "project_nonpromotable_theory_badges_with_zero_observable_bridges",
      {
        gate: stepGate(
          args.theoryBadgeProjection.gate === "pass",
        ),
        evidence_refs: ["theory_badge_projection"],
      },
    ],
  ]);
  const prewriteRunOrder = args.config.run_order.slice(0, -1).map(
    (stage, index) => ({
      index,
      stage,
      ...(stepEvidence.get(stage) ?? {
        gate: "blocked" as const,
        evidence_refs: ["missing_step_receipt"],
      }),
    }),
  );
  const writeReady = prewriteRunOrder.every(
    (row) => row.gate === "pass",
  );
  const runOrder = [
    ...prewriteRunOrder,
    {
      index: args.config.run_order.length - 1,
      stage:
        "write_content_addressed_stage4_2a_report_and_receipt" as const,
      gate: stepGate(writeReady),
      evidence_refs: [
        "exclusive_output_directory",
        "content_addressed_report_and_receipt",
      ],
    },
  ];
  const campaignGate =
    integrityGate === "pass" &&
      immutableStage4_1Unchanged &&
      args.massCalibration.status === "pass" &&
      args.massCalibration.failures.length === 0 &&
      args.solarCalibration.status === "pass" &&
      args.solarCalibration.failures.length === 0 &&
      finalGatesMatchPolicy &&
      nonbridgePass &&
      runOrder.every((row) => row.gate === "pass")
      ? "pass" as const
      : "blocked" as const;

  return {
    schema_version:
      "casimir_dp_electron_mass_higgs_anchor_stage4_2a_report/1" as const,
    study_id: args.config.study_id,
    campaign_id: args.config.campaign_id,
    generated_at: args.now.toISOString(),
    evidence_cutoff: args.config.evidence_cutoff,
    evidence_class: args.config.evidence_class,
    claim_ceiling: args.config.claim_ceiling,
    promotion_allowed: false as const,
    immutable_stage4_1_rule:
      "Stage-4.2A is append-only downstream evidence. Its complete Stage-4.1 config, authority, report, receipt, and verification tuple is hash-linked and cannot be rewritten.",
    immutable_stage4_1_unchanged: immutableStage4_1Unchanged,
    authority_integrity: args.authorityIntegrity,
    software_source_integrity: args.sourceIntegrity,
    fixture_integrity: args.fixtureIntegrity,
    integrity_gate: integrityGate,
    software_source_snapshot: args.config.software.source_snapshot,
    source_registry: args.config.source_registry,
    run_order: runOrder,
    theory_badge_projection: args.theoryBadgeProjection,
    calibrations: {
      electron_mass_higgs_anchor: args.massCalibration,
      planck_solar_radiometry: args.solarCalibration,
    },
    cross_scale_calibration_ladder:
      CASIMIR_DP_STAGE4_2A_CROSS_SCALE_CALIBRATION_LADDER,
    dp_evidence_levels: CASIMIR_DP_STAGE4_2A_EVIDENCE_LEVELS,
    outcome_to_claim_map:
      CASIMIR_DP_STAGE4_2A_OUTCOME_TO_CLAIM_MAP,
    cross_scale_nonbridge: {
      statement:
        "Shared constants, units, dimensions, or scale identities are calibration dependencies, not evidence for a causal DP mechanism.",
      observable_bridge_edges_added: 0 as const,
      mass_frequency_identity_is_new_dynamics: false as const,
      solar_temperature_supports_dp: false as const,
      apparatus_thermal_transfer_modeled: false as const,
      cosmological_kernel_registered: false as const,
      gate: nonbridgePass ? "pass" as const : "blocked" as const,
    },
    campaign_gate: campaignGate,
    final_gates: finalGates,
    claim_boundaries: [
      "The electron mass lane is a theory-assisted metrology replay and correlated CODATA conversion, not static weighing or independent evidence.",
      "The inferred tree Yukawa is notation-level Standard Model mapping, not a running matched value or direct electron-Yukawa observation.",
      "The Planck integral and Stefan-Boltzmann constant are one identity family.",
      "Solar color temperature and bolometric effective temperature are distinct operational quantities.",
      "The calibration ladder does not compute E_G, Gamma_DP, a Casimir-to-collapse transfer kernel, manifold dynamics, or a cosmological lift.",
      "Only preregistered measured coherence residuals can advance the three DP evidence levels.",
    ] as const,
  };
}

export function renderCasimirDpElectronMassHiggsAnchorStage4_2AMarkdown(
  report: ReturnType<
    typeof buildCasimirDpElectronMassHiggsAnchorStage4_2AReport
  >,
): string {
  const integrityRows = [
    ...report.authority_integrity,
    ...report.software_source_integrity,
    ...report.fixture_integrity,
  ].map((row) =>
    `| ${row.role} | \`${row.path}\` | \`${row.expected_sha256}\` | ${row.actual_sha256 == null ? "missing" : `\`${row.actual_sha256}\``} | ${String(row.tracked_expected)} | ${String(row.tracked_actual)} | ${row.gate} |`
  );
  const runRows = report.run_order.map((row) =>
    `| ${row.index} | \`${row.stage}\` | ${row.evidence_refs.map((ref) => `\`${ref}\``).join("<br>")} | ${row.gate} |`
  );
  const ladderRows = report.cross_scale_calibration_ladder.map((row) =>
    `| ${row.rung} | ${row.calibration} | ${row.boundary} |`
  );
  const outcomeRows = report.outcome_to_claim_map.map((row) =>
    `| \`${row.outcome_id}\` | ${row.establishes} | ${row.does_not_establish} | \`${row.maximum_claim}\` |`
  );
  const evidenceRows = report.dp_evidence_levels.map((row) =>
    `| ${row.level} | \`${row.name}\` | ${row.required_observation} | ${row.status} | ${row.established_by_stage4_2a} |`
  );
  const mass =
    report.calibrations.electron_mass_higgs_anchor;
  const solar = report.calibrations.planck_solar_radiometry;

  return `# Casimir-DP electron-mass, Higgs-anchor, and solar-calibration Stage-4.2A report

**Campaign:** \`${report.campaign_id}\`  
**Generated:** ${report.generated_at}  
**Evidence class:** \`${report.evidence_class}\`  
**Claim ceiling:** \`${report.claim_ceiling}\`  
**Promotion allowed:** \`${report.promotion_allowed}\`

## Outcome

The Stage-4.2A campaign gate is \`${report.campaign_gate}\`. The runtime
replays the electron mass from a corrected bound-electron frequency ratio,
maps that rest-energy anchor into a conditional Standard Model tree
convention, closes Planck/Stefan-Boltzmann radiometric identities, and
recovers two deliberately distinct solar temperature definitions.

This is a cross-scale calibration and dependency ladder. It is not cumulative
evidence for DP collapse, a Casimir-to-collapse transfer, manifold dynamics,
or a cosmological mechanism.

${report.immutable_stage4_1_rule}

## Content integrity

**Git HEAD:** \`${report.software_source_snapshot.git_head}\`  
**Worktree state:** \`${report.software_source_snapshot.worktree_state}\`  
**Integrity gate:** \`${report.integrity_gate}\`  
**Immutable Stage-4.1 unchanged:** \`${report.immutable_stage4_1_unchanged}\`

Tracking state is receipt metadata only; content hashes are the durable
authority and remain valid if these files are later staged or committed.

| Role | Path | Expected SHA-256 | Actual SHA-256 | Tracked expected | Tracked actual | Gate |
|---|---|---|---|---|---|---|
${integrityRows.join("\n")}

## Order of operations

| # | Stage | Evidence receipt(s) | Gate |
|---:|---|---|---|
${runRows.join("\n")}

## Cross-scale calibration ladder

| Rung | Calibration | Falsifiable claim boundary |
|---:|---|---|
${ladderRows.join("\n")}

## Electron mass and conditional Higgs anchor

The metrology lane uses

\\[
m_e=\\frac{|g_b|}{2}\\frac{|e|}{|q|}
\\frac{\\omega_c}{\\omega_L}m_{ion},
\\qquad
m_ec^2=\\frac{y_e^{tree}v_F}{\\sqrt{2}}.
\\]

- Replayed relative electron mass:
  \`${scientificNotation(mass.electron_mass_metrology_replay.A_r_e.self_consistent_solution)}\`
- Converted electron mass:
  \`${scientificNotation(mass.correlated_codata_conversions.m_e_OS_kg)} kg\`
- Electron rest energy:
  \`${scientificNotation(mass.correlated_codata_conversions.E_e_OS_J)} J\`
- Electron cyclic Compton frequency:
  \`${scientificNotation(mass.standard_model_tree_mapping.identity_replay.compton_frequency_Hz)} Hz\`
- Tree Fermi scale:
  \`${scientificNotation(mass.standard_model_tree_mapping.v_F_tree_GeV)} GeV\`
- Inferred tree Yukawa:
  \`${mass.standard_model_tree_mapping.y_e_lagrangian_tree.toExponential(5)}\`
- Conservative tree-anchor standard uncertainty:
  \`${mass.standard_model_tree_mapping.y_e_lagrangian_tree_standard_uncertainty.toExponential(2)}\`
- Direct electron-Yukawa observation:
  \`${mass.final_gates.direct_electron_yukawa_observation}\`

The mass is inferred with a bound-state-QED input and source correction
ledger; it is not literal static weighing. The tree Yukawa value is inferred
from the mass and convention, not observed directly.

## Planck radiometry and solar temperatures

\\[
B_\\lambda(T)=\\frac{2hc^2}{\\lambda^5}
\\frac{1}{e^{hc/(\\lambda k_BT)}-1},
\\qquad
\\sigma=\\frac{2\\pi^5k_B^4}{15h^3c^2},
\\qquad
T_{eff}=\\left(\\frac{L}{4\\pi R^2\\sigma}\\right)^{1/4}.
\\]

- Numerical Stefan-Boltzmann constant:
  \`${scientificNotation(solar.planck_stefan_boltzmann.sigma_numerical_W_m2_K4)} W m^-2 K^-4\`
- Frozen TSIS grid peak:
  \`${solar.solar_spectral_color_temperature.peak_wavelength_nm.toFixed(0)} nm\`
- Coarse spectrum/peak-dependent Wien color temperature:
  \`${solar.solar_spectral_color_temperature.color_temperature_planck_wien_K.toFixed(0)} K\`
- Grid-bracket interval (not a statistical uncertainty):
  \`${solar.solar_spectral_color_temperature.color_temperature_grid_bracket_K == null ? "not_ready" : `${solar.solar_spectral_color_temperature.color_temperature_grid_bracket_K.lower.toFixed(0)}--${solar.solar_spectral_color_temperature.color_temperature_grid_bracket_K.upper.toFixed(0)} K`}\`
- IAU luminosity-radius bolometric effective temperature:
  \`${solar.solar_bolometric_effective_temperature.effective_temperature_bolometric_K.toFixed(1)} K\`
- Color minus bolometric:
  \`${solar.temperature_semantics.color_minus_bolometric_K.toFixed(0)} K\`

The coarse frozen-grid Wien diagnostic is not a response/covariance-aware
spectral fit; its statistical uncertainty and measured-fit significance remain
\`not_ready\`. The color diagnostic and bolometric effective temperature are
operationally distinct. Their difference is not a contradiction, and neither
quantity is derived from the electron mass or evidence for DP.

## Theory Badge projection

- Projected badges: \`${report.theory_badge_projection.projected_badge_count}\`
- Graph badges/edges:
  \`${report.theory_badge_projection.graph_badge_count}/${report.theory_badge_projection.graph_edge_count}\`
- Calculator payloads:
  \`${report.theory_badge_projection.calculator_payload_count}\`
- Observable bridge edges:
  \`${report.theory_badge_projection.observable_bridge_edge_count}\`
- Gate: \`${report.theory_badge_projection.gate}\`

## Falsifiable DP evidence levels

| Level | Target | Required observation | Status | Established here |
|---:|---|---|---|---|
${evidenceRows.join("\n")}

The rate law at Level 2 is \`Gamma_DP=E_G/hbar\`. Stage-4.2A does not compute
\`E_G\` and does not fit a measured residual. No retuning, Casimir material
kernel, manifold solution, or covariant cosmological lift is introduced.

## Cross-scale semantic non-bridge

- ${report.cross_scale_nonbridge.statement}
- Observable bridge edges added:
  \`${report.cross_scale_nonbridge.observable_bridge_edges_added}\`
- Apparatus thermal transfer modeled:
  \`${report.cross_scale_nonbridge.apparatus_thermal_transfer_modeled}\`
- Cosmological kernel registered:
  \`${report.cross_scale_nonbridge.cosmological_kernel_registered}\`
- Gate: \`${report.cross_scale_nonbridge.gate}\`

## Outcome-to-claim map

| Outcome | Establishes | Does not establish | Maximum claim |
|---|---|---|---|
${outcomeRows.join("\n")}

## Final gates

${Object.entries(report.final_gates).map(([gate, status]) => `- \`${gate}\`: \`${status}\``).join("\n")}

## Claim boundaries

${report.claim_boundaries.map((boundary) => `- ${boundary}`).join("\n")}
`;
}

export async function runCasimirDpElectronMassHiggsAnchorStage4_2A(
  args: {
    configPath: string;
    outRoot?: string | null;
    reportDoc?: string | null;
    now?: Date;
  },
) {
  const configPath = path.resolve(args.configPath);
  const configText = await readFile(configPath, "utf8");
  const config = CasimirDpElectronMassHiggsAnchorStage4_2AConfig.parse(
    JSON.parse(configText),
  );
  assertRunOrder(config);
  validateSoftwareAuthorityContract(config);
  const gitHead = await currentGitHead();
  if (gitHead !== config.software.source_snapshot.git_head) {
    throw new Error("stage4_2a_source_snapshot_git_head_mismatch");
  }

  const authorityIntegrity = await Promise.all(
    [
      config.authority_manifest,
      ...config.upstream_authorities,
    ].map((authority) =>
      integrityRow({
        role: authority.role,
        path: authority.path,
        expectedSha256: authority.sha256,
        requiredAtRuntime: authority.required_at_runtime,
        trackedExpected: authority.tracked,
      })
    ),
  );
  const sourceIntegrity = await Promise.all(
    config.software.source_authorities.map((source) =>
      integrityRow({
        role: source.role,
        path: source.path,
        expectedSha256: source.sha256,
        requiredAtRuntime: source.required_at_runtime,
        trackedExpected: source.tracked,
      })
    ),
  );

  const authorityManifestText = await readFile(
    path.resolve(config.authority_manifest.path),
    "utf8",
  );
  validateAuthorityManifest(
    config,
    JSON.parse(authorityManifestText) as AuthorityManifest,
  );

  const massFixture = config.runtime_fixtures[0];
  const solarFixture = config.runtime_fixtures[1];
  const [massFixtureText, solarFixtureText] = await Promise.all([
    readFile(path.resolve(massFixture.path), "utf8"),
    readFile(path.resolve(solarFixture.path), "utf8"),
  ]);
  const massInput =
    CasimirDpElectronMassHiggsAnchorStage4_2AInput.parse(
      JSON.parse(massFixtureText),
    );
  const solarInput =
    CasimirDpPlanckSolarCalibrationStage4_2AInput.parse(
      JSON.parse(solarFixtureText),
    );
  for (
    const [fixture, input] of [
      [massFixture, massInput],
      [solarFixture, solarInput],
    ] as const
  ) {
    if (input.schema_version !== fixture.schema_version) {
      throw new Error(
        `stage4_2a_fixture_contract_failure:${fixture.role}:schema_version`,
      );
    }
    if (input.evidence_class !== fixture.evidence_class) {
      throw new Error(
        `stage4_2a_fixture_contract_failure:${fixture.role}:evidence_class`,
      );
    }
  }
  validateFixtureSources({ config, massInput, solarInput });
  const tsisSnapshotIntegrity = await integrityRow({
    role: "tsis_hsrs_frozen_snapshot",
    path: solarInput.tsis_hsrs_snapshot.source_snapshot_path,
    expectedSha256:
      solarInput.tsis_hsrs_snapshot.expected_snapshot_sha256,
    requiredAtRuntime: true,
    trackedExpected: false,
  });
  if (
    tsisSnapshotIntegrity.gate === "pass" &&
    tsisSnapshotIntegrity.actual_sha256 !==
      solarInput.tsis_hsrs_snapshot.actual_snapshot_sha256
  ) {
    tsisSnapshotIntegrity.gate = "not_ready";
  }
  if (tsisSnapshotIntegrity.gate === "pass") {
    const snapshotText = await readFile(
      path.resolve(
        solarInput.tsis_hsrs_snapshot.source_snapshot_path,
      ),
      "utf8",
    );
    validateFrozenTsisSnapshot(solarInput, snapshotText);
  }

  const fixtureIntegrity: Stage4_2AIntegrityRow[] = [
    {
      role: massFixture.role,
      path: massFixture.path,
      expected_sha256: massFixture.sha256,
      actual_sha256: sha256(massFixtureText),
      required_at_runtime: true,
      tracked_expected: null,
      tracked_actual: null,
      gate:
        sha256(massFixtureText) === massFixture.sha256
          ? "pass"
          : "not_ready",
    },
    {
      role: solarFixture.role,
      path: solarFixture.path,
      expected_sha256: solarFixture.sha256,
      actual_sha256: sha256(solarFixtureText),
      required_at_runtime: true,
      tracked_expected: null,
      tracked_actual: null,
      gate:
        sha256(solarFixtureText) === solarFixture.sha256
          ? "pass"
          : "not_ready",
    },
    tsisSnapshotIntegrity,
  ];
  const firstIntegrityFailure = [
    ...authorityIntegrity,
    ...sourceIntegrity,
    ...fixtureIntegrity,
  ].find((row) =>
    row.required_at_runtime && row.gate !== "pass"
  );
  if (firstIntegrityFailure != null) {
    throw new Error(
      `stage4_2a_integrity_failure:${firstIntegrityFailure.role}`,
    );
  }

  const massCalibration =
    evaluateCasimirDpElectronMassHiggsAnchorStage4_2A(massInput);
  if (massCalibration.status !== "pass") {
    throw new Error(
      `stage4_2a_mass_calibration_failure:${massCalibration.first_failure_code ?? "unknown"}`,
    );
  }
  const solarCalibration =
    evaluateCasimirDpPlanckSolarCalibrationStage4_2A(solarInput);
  if (solarCalibration.status !== "pass") {
    throw new Error(
      `stage4_2a_solar_calibration_failure:${solarCalibration.first_failure_code ?? "unknown"}`,
    );
  }
  const theoryBadgeProjection =
    inspectStage4_2ATheoryBadgeProjection();
  if (theoryBadgeProjection.gate !== "pass") {
    throw new Error("stage4_2a_theory_badge_projection_failure");
  }

  const now = args.now ?? new Date();
  const report =
    buildCasimirDpElectronMassHiggsAnchorStage4_2AReport({
      config,
      authorityIntegrity,
      sourceIntegrity,
      fixtureIntegrity,
      massCalibration,
      solarCalibration,
      theoryBadgeProjection,
      now,
    });
  if (
    stableJson(report.final_gates) !==
      stableJson(config.final_status_policy)
  ) {
    throw new Error("stage4_2a_final_status_policy_mismatch");
  }
  if (report.campaign_gate !== "pass") {
    throw new Error("stage4_2a_campaign_gate_blocked");
  }

  const timestamp = now.toISOString().replace(/[-:.]/g, "");
  const outDir = path.resolve(
    args.outRoot ??
      path.join(
        "artifacts",
        "research",
        "casimir-dp-electron-mass-higgs-anchor-stage4-2a",
        `${config.campaign_id}-${timestamp}`,
      ),
  );
  await mkdir(path.dirname(outDir), { recursive: true });
  await mkdir(outDir, { recursive: false });

  const reportJson = stableJson(report);
  const reportMarkdown =
    renderCasimirDpElectronMassHiggsAnchorStage4_2AMarkdown(
      report,
    );
  const reportJsonName =
    "electron-mass-higgs-anchor-stage4-2a-report.json";
  const reportMarkdownName =
    "electron-mass-higgs-anchor-stage4-2a-report.md";
  const receiptName =
    "electron-mass-higgs-anchor-stage4-2a-receipt.json";
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

  const receipt = {
    schema_version:
      "casimir_dp_electron_mass_higgs_anchor_stage4_2a_receipt/1" as const,
    campaign_id: config.campaign_id,
    generated_at: now.toISOString(),
    status:
      "campaign_runtime_completed_pending_external_verification" as const,
    evidence_class: config.evidence_class,
    claim_ceiling: config.claim_ceiling,
    promotion_allowed: false as const,
    input: {
      path: path.relative(process.cwd(), configPath).replace(/\\/g, "/"),
      sha256: sha256(configText),
    },
    authority_integrity: authorityIntegrity,
    immutable_stage4_1_unchanged: true as const,
    software_source_integrity: sourceIntegrity,
    software_source_snapshot: config.software.source_snapshot,
    runtime_fixtures: fixtureIntegrity,
    lane_receipts: {
      electron_mass_higgs_anchor: {
        status: massCalibration.status,
        evidence_class: massCalibration.evidence_class,
        claim_ceiling: massCalibration.claim_ceiling,
      },
      planck_solar_radiometry: {
        status: solarCalibration.status,
        evidence_class: solarCalibration.evidence_class,
        claim_ceiling: solarCalibration.claim_ceiling,
      },
    },
    outputs: [
      {
        path: reportJsonName,
        sha256: sha256(reportJson),
      },
      {
        path: reportMarkdownName,
        sha256: sha256(reportMarkdown),
      },
    ],
    dp_evidence_levels: report.dp_evidence_levels,
    cross_scale_dp_nonbridge_preserved: true as const,
    observable_bridge_edges_added: 0 as const,
    theory_badge_projection: report.theory_badge_projection,
    final_gates: report.final_gates,
    prior_stage4_1_certificate_artifact_reused: false as const,
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
    "configs/research/casimir-dp-electron-mass-higgs-anchor-stage4-2a.v1.json";
  let outRoot: string | null = null;
  let reportDoc: string | null =
    "docs/research/casimir-dp-electron-mass-higgs-anchor-stage4-2a-report.md";
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
  runCasimirDpElectronMassHiggsAnchorStage4_2A({
    configPath: args.configPath,
    outRoot: args.outRoot,
    reportDoc: args.reportDoc,
  }).then((result) => {
    process.stdout.write(stableJson({
      status: "completed",
      outDir: result.outDir,
      receipt_sha256: result.receipt_sha256,
      final_gates: result.report.final_gates,
    }));
  }).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
