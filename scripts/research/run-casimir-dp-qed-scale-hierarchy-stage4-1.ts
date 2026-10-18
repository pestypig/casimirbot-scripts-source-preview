#!/usr/bin/env -S tsx

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  CasimirDpQedScaleHierarchyCalibrationInput,
  evaluateCasimirDpQedScaleHierarchyCalibration,
  type CasimirDpQedScaleHierarchyCalibrationResult,
} from "../../shared/casimir-dp-qed-scale-hierarchy-calibration";
import {
  CASIMIR_DP_QED_SCALE_HIERARCHY_STAGE4_1_RUN_ORDER,
  CasimirDpQedScaleHierarchyStage4_1Config,
  type CasimirDpQedScaleHierarchyStage4_1Config as Stage4_1Config,
} from "../../shared/contracts/casimir-dp-qed-scale-hierarchy-stage4-1.v1";

const execFileAsync = promisify(execFile);
const stableJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export type Stage4_1IntegrityRow = {
  role: string;
  path: string;
  expected_sha256: string;
  actual_sha256: string | null;
  required_at_runtime: boolean;
  tracked_expected: boolean | null;
  tracked_actual: boolean | null;
  gate: "pass" | "not_ready";
};

export const CASIMIR_DP_QED_SCALE_HIERARCHY_OUTCOME_TO_CLAIM_MAP = [
  {
    outcome_id: "algebraic_identity_closure_pass",
    establishes:
      "The implementation reproduces the declared Compton, Bohr, classical-radius, Rydberg, Hartree, and dimensionless scale identities.",
    does_not_establish:
      "An independent test of QED, an electron oscillator, a cavity resonance, or a collapse clock.",
    maximum_claim: "qed_scale_identity_calibration",
  },
  {
    outcome_id: "codata_tabulation_consistency_pass",
    establishes:
      "Recomputed values lie inside a conservative envelope constructed from the declared CODATA rounding and uncertainty metadata.",
    does_not_establish:
      "Statistical agreement between independent measurements; the tabulations share a correlated least-squares adjustment.",
    maximum_claim: "correlated_reference_consistency",
  },
  {
    outcome_id: "leading_reduced_mass_closure_pass",
    establishes:
      "The leading nonrelativistic bare-proton/electron reduced-mass scaling and level-difference bookkeeping close.",
    does_not_establish:
      "Precision hydrogen spectroscopy or any omitted relativistic, radiative, recoil, finite-size, hyperfine, or apparatus correction.",
    maximum_claim: "leading_hydrogenic_scale_only",
  },
  {
    outcome_id: "same_identity_family_not_collapse_bridge",
    establishes:
      "The Compton-to-Rydberg relation is admitted only inside its explicit Coulomb/Dirac-QED scale family.",
    does_not_establish:
      "A Casimir-to-atomic, atomic-to-DP, Compton-to-collapse, or manifold transfer kernel.",
    maximum_claim: "same_identity_family_not_collapse_bridge",
  },
] as const;

function assertRunOrder(config: Stage4_1Config): void {
  if (
    config.run_order.length !==
      CASIMIR_DP_QED_SCALE_HIERARCHY_STAGE4_1_RUN_ORDER.length
  ) {
    throw new Error("stage4_1_run_order_length_mismatch");
  }
  CASIMIR_DP_QED_SCALE_HIERARCHY_STAGE4_1_RUN_ORDER.forEach(
    (stage, index) => {
      if (config.run_order[index] !== stage) {
        throw new Error(
          `stage4_1_run_order[${index}]_must_be_${stage}`,
        );
      }
    },
  );
  const provenance = config.run_order.indexOf(
    "validate_source_provenance_uncertainty_covariance_and_rounding",
  );
  const compton = config.run_order.indexOf(
    "compute_compton_energy_frequency_and_wavelength_closure",
  );
  const atomic = config.run_order.indexOf(
    "compute_bohr_classical_radius_rydberg_and_hartree_closure",
  );
  const reducedMass = config.run_order.indexOf(
    "compute_leading_hydrogenic_reduced_mass_closure",
  );
  const nonbridge = config.run_order.indexOf(
    "freeze_precision_correction_ledger_and_semantic_nonbridge",
  );
  if (
    !(
      provenance < compton &&
      compton < atomic &&
      atomic < reducedMass &&
      reducedMass < nonbridge
    )
  ) {
    throw new Error(
      "stage4_1_provenance_and_identity_closure_must_precede_nonbridge",
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
}): Promise<Stage4_1IntegrityRow> {
  try {
    const bytes = await readFile(path.resolve(args.path));
    const actual = sha256(bytes);
    const trackedActual = args.trackedExpected == null
      ? null
      : await gitPathTracked(args.path);
    const trackingMatches =
      args.trackedExpected == null ||
      trackedActual === args.trackedExpected;
    return {
      role: args.role,
      path: args.path,
      expected_sha256: args.expectedSha256,
      actual_sha256: actual,
      required_at_runtime: args.requiredAtRuntime,
      tracked_expected: args.trackedExpected ?? null,
      tracked_actual: trackedActual,
      gate:
        actual === args.expectedSha256 && trackingMatches
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

function scientificNotation(value: number): string {
  return value === 0 ? "0" : value.toExponential(12);
}

export function buildCasimirDpQedScaleHierarchyStage4_1Report(args: {
  config: Stage4_1Config;
  authorityIntegrity: Stage4_1IntegrityRow[];
  sourceIntegrity: Stage4_1IntegrityRow[];
  fixtureIntegrity: Stage4_1IntegrityRow;
  calibration: CasimirDpQedScaleHierarchyCalibrationResult;
  now: Date;
}) {
  const { config, calibration } = args;
  const allIntegrityRows = [
    ...args.authorityIntegrity,
    ...args.sourceIntegrity,
    args.fixtureIntegrity,
  ];
  const integrityGate = allIntegrityRows.every((row) =>
      row.gate === "pass" &&
      row.actual_sha256 === row.expected_sha256 &&
      (
        row.tracked_expected == null ||
        row.tracked_actual === row.tracked_expected
      )
    )
    ? "pass" as const
    : "not_ready" as const;
  const finalGatesMatchPolicy =
    stableJson(calibration.final_gates) ===
      stableJson(config.final_status_policy);
  const softwareGate =
    integrityGate === "pass" &&
      calibration.status === "pass" &&
      calibration.failures.length === 0 &&
      finalGatesMatchPolicy
      ? "pass" as const
      : "blocked" as const;

  return {
    schema_version:
      "casimir_dp_qed_scale_hierarchy_stage4_1_report/1" as const,
    study_id: config.study_id,
    campaign_id: config.campaign_id,
    generated_at: args.now.toISOString(),
    evidence_cutoff: config.evidence_cutoff,
    evidence_class: config.evidence_class,
    claim_ceiling: config.claim_ceiling,
    promotion_allowed: false as const,
    immutable_stage4_rule:
      "The authoritative Stage-4 config, authority manifest, immutable reports, campaign receipt, and downstream verification receipt are hash-linked and reused without mutation.",
    immutable_stage4_unchanged: true as const,
    authority_integrity: args.authorityIntegrity,
    software_source_integrity: args.sourceIntegrity,
    fixture_integrity: args.fixtureIntegrity,
    integrity_gate: integrityGate,
    software_source_snapshot: config.software.source_snapshot,
    source_registry: config.source_registry,
    run_order: config.run_order.map((stage, index) => ({
      index,
      stage,
      gate: softwareGate,
    })),
    calibration,
    outcome_to_claim_map:
      CASIMIR_DP_QED_SCALE_HIERARCHY_OUTCOME_TO_CLAIM_MAP,
    stage4_nonbridge_preservation: {
      upstream_status: "same_dimension_not_connected" as const,
      downstream_status:
        calibration.semantic_non_bridge.stage4_frequency_status,
      modifies_upstream: false as const,
      observable_bridge_edges_added: 0 as const,
      gate:
        calibration.semantic_non_bridge.stage4_frequency_status ===
            "same_dimension_not_connected" &&
          !calibration.semantic_non_bridge
            .modifies_stage4_frequency_non_bridge
          ? "pass" as const
          : "blocked" as const,
    },
    campaign_gate: softwareGate,
    final_gates: calibration.final_gates,
    claim_boundaries: calibration.claim_boundaries,
  };
}

export function renderCasimirDpQedScaleHierarchyStage4_1Markdown(
  report: ReturnType<
    typeof buildCasimirDpQedScaleHierarchyStage4_1Report
  >,
): string {
  const authorityRows = report.authority_integrity.map((row) =>
    `| ${row.role} | \`${row.path}\` | \`${row.expected_sha256}\` | ${row.actual_sha256 == null ? "missing" : `\`${row.actual_sha256}\``} | ${String(row.tracked_expected)} | ${String(row.tracked_actual)} | ${row.gate} |`,
  );
  const sourceRows = report.software_source_integrity.map((row) =>
    `| ${row.role} | \`${row.path}\` | \`${row.expected_sha256}\` | ${row.actual_sha256 == null ? "missing" : `\`${row.actual_sha256}\``} | ${String(row.tracked_expected)} | ${String(row.tracked_actual)} | ${row.gate} |`,
  );
  const referenceRows =
    report.calibration.codata_reference_agreement.rows.map((row) =>
      `| \`${row.quantity_id}\` | ${scientificNotation(row.computed_value)} | ${scientificNotation(row.reference_value)} | ${scientificNotation(row.absolute_difference)} | ${scientificNotation(row.acceptance_envelope)} | ${row.significance_status} | ${row.gate} |`,
    );
  const outcomeRows = report.outcome_to_claim_map.map((row) =>
    `| \`${row.outcome_id}\` | ${row.establishes} | ${row.does_not_establish} | \`${row.maximum_claim}\` |`,
  );
  const runRows = report.run_order.map((row) =>
    `| ${row.index} | \`${row.stage}\` | ${row.gate} |`,
  );
  const scales = report.calibration.electron_scales;
  const reduced = report.calibration.reduced_mass;

  return `# Casimir-DP QED Scale-Hierarchy Stage-4.1 report

**Campaign:** \`${report.campaign_id}\`  
**Generated:** ${report.generated_at}  
**Evidence class:** \`${report.evidence_class}\`  
**Claim ceiling:** \`${report.claim_ceiling}\`  
**Promotion allowed:** \`${report.promotion_allowed}\`

## Outcome

Stage-4.1 is a source-backed constants and algebra calibration downstream of
the immutable Stage-4 campaign. Its campaign gate is
\`${report.campaign_gate}\`. It distinguishes ordinary and reduced Compton
wavelengths, cyclic and angular Compton frequencies, the low-energy
\`alpha_fs\` coupling, Bohr and classical-electron radii, the Rydberg and
Hartree scales, and the leading bare-proton/electron reduced-mass result.

It is not an independent measurement, precision spectroscopy result,
polarization model, Casimir material-response model, DP calculation, collapse
clock, or manifold solution.

${report.immutable_stage4_rule}

## Immutable Stage-4 and CODATA authorities

| Role | Path | Expected SHA-256 | Actual SHA-256 | Tracked expected | Tracked actual | Gate |
|---|---|---|---|---|---|---|
${authorityRows.join("\n")}

## Software source authorities

**Git HEAD:** \`${report.software_source_snapshot.git_head}\`  
**Worktree state:** \`${report.software_source_snapshot.worktree_state}\`  
**Authority mode:** \`${report.software_source_snapshot.authority_mode}\`

| Role | Path | Expected SHA-256 | Actual SHA-256 | Tracked expected | Tracked actual | Gate |
|---|---|---|---|---|---|---|
${sourceRows.join("\n")}

## Calibration fixture

| Path | Expected SHA-256 | Actual SHA-256 | Gate |
|---|---|---|---|
| \`${report.fixture_integrity.path}\` | \`${report.fixture_integrity.expected_sha256}\` | \`${report.fixture_integrity.actual_sha256}\` | ${report.fixture_integrity.gate} |

## Stage-4.1 order of operations

| # | Stage | Gate |
|---:|---|---|
${runRows.join("\n")}

## QED scale identities

\\[
E_e=m_ec^2=h\\nu_C=\\hbar\\omega_C,\\qquad
\\lambda_C=2\\pi\\bar\\lambda_C
\\]

\\[
a_0=\\frac{\\bar\\lambda_C}{\\alpha_{fs}},\\qquad
r_e=\\alpha_{fs}\\bar\\lambda_C=\\alpha_{fs}^2a_0
\\]

\\[
cR_\\infty=\\frac{\\alpha_{fs}^2}{2}\\nu_C,\\qquad
E_h=2hcR_\\infty
\\]

Selected results:

- Electron rest energy: \`${scientificNotation(scales.rest_energy_J)} J\`
- Cyclic Compton frequency:
  \`${scientificNotation(scales.compton_frequency_Hz)} Hz\`
- Angular Compton frequency:
  \`${scientificNotation(scales.compton_angular_frequency_rad_s)} rad s^-1\`
- Ordinary Compton wavelength:
  \`${scientificNotation(scales.electron_compton_wavelength_m)} m\`
- Reduced Compton wavelength:
  \`${scientificNotation(scales.electron_reduced_compton_wavelength_m)} m\`
- Bohr radius: \`${scientificNotation(scales.bohr_radius_m)} m\`
- Classical electron radius:
  \`${scientificNotation(scales.classical_electron_radius_m)} m\`
- Rydberg frequency:
  \`${scientificNotation(scales.rydberg_frequency_Hz)} Hz\`
- Hartree energy: \`${scientificNotation(scales.hartree_energy_J)} J\`

Maximum algebraic relative residual:
\`${scientificNotation(report.calibration.algebraic_closure.maximum_relative_error)}\`.
Maximum dimensionless-hierarchy relative residual:
\`${scientificNotation(report.calibration.hierarchy.maximum_relative_error)}\`.

## CODATA tabulation and rounding consistency

| Quantity | Computed | Tabulated | Absolute difference | Conservative envelope | Significance | Gate |
|---|---:|---:|---:|---:|---|---|
${referenceRows.join("\n")}

This is
\`${report.calibration.codata_reference_agreement.comparison_kind}\`.
Reference significance is
\`${report.calibration.uncertainty.reference_significance}\` because derived
and tabulated CODATA quantities lack a supplied cross-covariance in this
fixture.

## Leading reduced-mass hydrogenic scale

- \`mu/m_e\`: \`${scientificNotation(reduced.reduced_mass_over_electron_mass)}\`
- Reduced-mass Rydberg:
  \`${scientificNotation(reduced.reduced_mass_rydberg_m_inv)} m^-1\`
- Leading \`${reduced.initial_n}->${reduced.final_n}\` transition:
  \`${scientificNotation(reduced.leading_transition_frequency_Hz)} Hz\`
- Declared transition standard uncertainty:
  \`${scientificNotation(reduced.leading_transition_absolute_standard_uncertainty_Hz)} Hz\`
- Uncertainty propagation:
  \`${reduced.uncertainty_propagation_method}\`
- Maximum closure residual:
  \`${scientificNotation(reduced.maximum_closure_relative_error)}\`

The result is
\`${reduced.interpretation}\`. Precision spectroscopy remains
\`${report.final_gates.precision_spectroscopy}\`; the correction ledger lists
every deliberately omitted contribution.

### Frozen precision-correction ledger

Applied at this maturity:

${report.calibration.precision_scope.applied_terms.map((term) => `- \`${term}\``).join("\n")}

Omitted, and therefore unavailable for a precision-spectroscopy claim:

${report.calibration.precision_scope.omitted_terms.map((term) => `- \`${term}\``).join("\n")}

The ledger is complete for the declared leading nonrelativistic
reduced-mass level, not for a measured transition. Cross-adjustment
significance remains
\`${report.calibration.uncertainty.reference_significance}\`.

## Stage-4 semantic non-bridge

- Upstream: \`${report.stage4_nonbridge_preservation.upstream_status}\`
- Downstream: \`${report.stage4_nonbridge_preservation.downstream_status}\`
- Stage-4 modified: \`${report.stage4_nonbridge_preservation.modifies_upstream}\`
- Observable bridge edges added:
  \`${report.stage4_nonbridge_preservation.observable_bridge_edges_added}\`
- Gate: \`${report.stage4_nonbridge_preservation.gate}\`

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

export async function runCasimirDpQedScaleHierarchyStage4_1(args: {
  configPath: string;
  outRoot?: string | null;
  reportDoc?: string | null;
  now?: Date;
}) {
  const configPath = path.resolve(args.configPath);
  const configText = await readFile(configPath, "utf8");
  const config = CasimirDpQedScaleHierarchyStage4_1Config.parse(
    JSON.parse(configText),
  );
  assertRunOrder(config);
  const gitHead = await currentGitHead();
  if (gitHead !== config.software.source_snapshot.git_head) {
    throw new Error("stage4_1_source_snapshot_git_head_mismatch");
  }

  const authorityRefs = [
    config.stage4_1_authority_manifest,
    ...config.upstream_authorities,
  ];
  const authorityIntegrity = await Promise.all(
    authorityRefs.map((authority) =>
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

  const fixtureText = await readFile(
    path.resolve(config.runtime_fixture.path),
    "utf8",
  );
  const fixtureActualSha256 = sha256(fixtureText);
  const fixtureInput = CasimirDpQedScaleHierarchyCalibrationInput.parse(
    JSON.parse(fixtureText),
  );
  if (
    fixtureInput.schema_version !==
      config.runtime_fixture.schema_version
  ) {
    throw new Error(
      "stage4_1_fixture_contract_failure:qed_scale_hierarchy:schema_version",
    );
  }
  if (
    fixtureInput.evidence_class !==
      config.runtime_fixture.evidence_class
  ) {
    throw new Error(
      "stage4_1_fixture_contract_failure:qed_scale_hierarchy:evidence_class",
    );
  }
  const codataAuthority = config.upstream_authorities.find(
    (authority) => authority.role === "codata_2022_constants_registry",
  );
  if (
    codataAuthority == null ||
    fixtureInput.authority_receipt.expected_sha256 !==
      codataAuthority.sha256 ||
    fixtureInput.authority_receipt.actual_sha256 !==
      codataAuthority.sha256
  ) {
    throw new Error(
      "stage4_1_fixture_contract_failure:qed_scale_hierarchy:codata_authority",
    );
  }
  const fixtureIntegrity: Stage4_1IntegrityRow = {
    role: "qed_scale_hierarchy_fixture",
    path: config.runtime_fixture.path,
    expected_sha256: config.runtime_fixture.sha256,
    actual_sha256: fixtureActualSha256,
    required_at_runtime: true,
    tracked_expected: null,
    tracked_actual: null,
    gate:
      fixtureActualSha256 === config.runtime_fixture.sha256
        ? "pass"
        : "not_ready",
  };
  const firstIntegrityFailure = [
    ...authorityIntegrity,
    ...sourceIntegrity,
    fixtureIntegrity,
  ].find((row) =>
    row.required_at_runtime && row.gate !== "pass"
  );
  if (firstIntegrityFailure != null) {
    throw new Error(
      `stage4_1_integrity_failure:${firstIntegrityFailure.role}`,
    );
  }

  const calibration =
    evaluateCasimirDpQedScaleHierarchyCalibration(fixtureInput);
  if (calibration.status !== "pass") {
    throw new Error(
      `stage4_1_calibration_failure:${calibration.first_failure_code ?? "unknown"}`,
    );
  }
  if (
    stableJson(calibration.final_gates) !==
      stableJson(config.final_status_policy)
  ) {
    throw new Error("stage4_1_final_status_policy_mismatch");
  }

  const now = args.now ?? new Date();
  const report = buildCasimirDpQedScaleHierarchyStage4_1Report({
    config,
    authorityIntegrity,
    sourceIntegrity,
    fixtureIntegrity,
    calibration,
    now,
  });
  if (report.campaign_gate !== "pass") {
    throw new Error("stage4_1_campaign_gate_blocked");
  }

  const timestamp = now.toISOString().replace(/[-:.]/g, "");
  const outDir = path.resolve(
    args.outRoot ??
      path.join(
        "artifacts",
        "research",
        "casimir-dp-qed-scale-hierarchy-stage4-1",
        `${config.campaign_id}-${timestamp}`,
      ),
  );
  await mkdir(path.dirname(outDir), { recursive: true });
  await mkdir(outDir, { recursive: false });

  const reportJson = stableJson(report);
  const reportMarkdown =
    renderCasimirDpQedScaleHierarchyStage4_1Markdown(report);
  await writeFile(
    path.join(outDir, "qed-scale-hierarchy-stage4-1-report.json"),
    reportJson,
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(
    path.join(outDir, "qed-scale-hierarchy-stage4-1-report.md"),
    reportMarkdown,
    { encoding: "utf8", flag: "wx" },
  );

  const receipt = {
    schema_version:
      "casimir_dp_qed_scale_hierarchy_stage4_1_receipt/1",
    campaign_id: config.campaign_id,
    generated_at: now.toISOString(),
    status: "completed",
    evidence_class: config.evidence_class,
    claim_ceiling: config.claim_ceiling,
    promotion_allowed: false,
    input: {
      path: path.relative(process.cwd(), configPath).replace(/\\/g, "/"),
      sha256: sha256(configText),
    },
    immutable_stage4_authorities: authorityIntegrity,
    immutable_stage4_unchanged: true,
    software_source_integrity: sourceIntegrity,
    software_source_snapshot: config.software.source_snapshot,
    runtime_fixture: fixtureIntegrity,
    outputs: [
      {
        path: "qed-scale-hierarchy-stage4-1-report.json",
        sha256: sha256(reportJson),
      },
      {
        path: "qed-scale-hierarchy-stage4-1-report.md",
        sha256: sha256(reportMarkdown),
      },
    ],
    codata_reference_comparison:
      "correlated_tabulation_and_rounding_consistency_not_independent_test",
    stage4_frequency_nonbridge:
      report.stage4_nonbridge_preservation.downstream_status,
    observable_bridge_edges_added: 0,
    final_gates: report.final_gates,
    prior_stage4_certificate_artifact_reused: false,
    fresh_casimir_certificate: {
      status: "pending_external_verification",
      certificate_sha256: null,
      integrity: null,
    },
  };
  const receiptJson = stableJson(receipt);
  await writeFile(
    path.join(outDir, "qed-scale-hierarchy-stage4-1-receipt.json"),
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
    "configs/research/casimir-dp-qed-scale-hierarchy-stage4-1.v1.json";
  let outRoot: string | null = null;
  let reportDoc: string | null =
    "docs/research/casimir-dp-qed-scale-hierarchy-stage4-1-report.md";
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
  runCasimirDpQedScaleHierarchyStage4_1({
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
