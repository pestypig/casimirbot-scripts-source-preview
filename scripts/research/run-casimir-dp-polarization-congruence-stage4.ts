#!/usr/bin/env -S tsx

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  buildCasimirDpPolarizationCongruenceStage4Report,
  type Stage4IntegrityRow,
} from "../../shared/casimir-dp-polarization-congruence-stage4";
import {
  CasimirDpPolarizationQedControlInput,
  evaluateCasimirDpPolarizationQedControl,
} from "../../shared/casimir-dp-polarization-qed-control";
import {
  CasimirDpRadiativeThermalClosureInput,
  evaluateCasimirDpRadiativeThermalClosure,
} from "../../shared/casimir-dp-radiative-thermal-closure";
import {
  CasimirDpTensorDimensionalCongruenceInput,
  evaluateCasimirDpTensorDimensionalCongruence,
} from "../../shared/casimir-dp-tensor-dimensional-congruence";
import {
  CASIMIR_DP_POLARIZATION_CONGRUENCE_STAGE4_RUN_ORDER,
  CasimirDpPolarizationCongruenceStage4Config,
  type CasimirDpPolarizationCongruenceStage4Config as CasimirDpPolarizationCongruenceStage4ConfigType,
} from "../../shared/contracts/casimir-dp-polarization-congruence-stage4.v1";

const stableJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const execFileAsync = promisify(execFile);

function formatScalar(value: unknown): string {
  if (typeof value !== "number") return String(value ?? "not_available");
  if (value === 0) return "0";
  return Math.abs(value) >= 1e4 || Math.abs(value) < 1e-3
    ? value.toExponential(6)
    : value.toFixed(8);
}

function nestedValue(
  value: unknown,
  objectKey: string,
  valueKey: string,
): unknown {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const object = (value as Record<string, unknown>)[objectKey];
  if (object == null || typeof object !== "object" || Array.isArray(object)) {
    return undefined;
  }
  return (object as Record<string, unknown>)[valueKey];
}

function firstRowValue(
  value: unknown,
  objectKey: string,
  valueKey: string,
): unknown {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const object = (value as Record<string, unknown>)[objectKey];
  if (object == null || typeof object !== "object" || Array.isArray(object)) {
    return undefined;
  }
  const rows = (object as Record<string, unknown>).rows;
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const row = rows[0];
  if (row == null || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  return (row as Record<string, unknown>)[valueKey];
}

function assertRunOrder(
  config: CasimirDpPolarizationCongruenceStage4ConfigType,
): void {
  if (
    config.run_order.length !==
      CASIMIR_DP_POLARIZATION_CONGRUENCE_STAGE4_RUN_ORDER.length
  ) {
    throw new Error("stage4_run_order_length_mismatch");
  }
  CASIMIR_DP_POLARIZATION_CONGRUENCE_STAGE4_RUN_ORDER.forEach(
    (stage, index) => {
      if (config.run_order[index] !== stage) {
        throw new Error(`stage4_run_order[${index}]_must_be_${stage}`);
      }
    },
  );
  const congruenceIndex = config.run_order.indexOf(
    "run_tensor_dimensional_and_semantic_congruence",
  );
  const signatureIndex = config.run_order.indexOf(
    "freeze_helicity_mirror_material_temperature_and_companion_signatures",
  );
  const comparatorIndex = config.run_order.indexOf(
    "version_expanded_null_unchanged_dp_and_registered_bridge_comparator",
  );
  const comparisonIndex = config.run_order.indexOf(
    "run_blinded_synthetic_prediction_comparison",
  );
  if (
    !(
      congruenceIndex < signatureIndex &&
      signatureIndex < comparatorIndex &&
      comparatorIndex < comparisonIndex
    )
  ) {
    throw new Error(
      "stage4_congruence_and_freeze_must_precede_comparison",
    );
  }
}

async function integrityRow(args: {
  role: string;
  path: string;
  expectedSha256: string;
  requiredAtRuntime: boolean;
  expectedTracked?: boolean | null;
}): Promise<Stage4IntegrityRow> {
  try {
    const bytes = await readFile(path.resolve(args.path));
    const actual = sha256(bytes);
    const trackedActual = args.expectedTracked == null
      ? null
      : await gitPathTracked(args.path);
    const trackingMatches =
      args.expectedTracked == null ||
      trackedActual === args.expectedTracked;
    return {
      role: args.role,
      path: args.path,
      expected_sha256: args.expectedSha256,
      actual_sha256: actual,
      gate:
        actual === args.expectedSha256 && trackingMatches
          ? "pass"
          : "not_ready",
      required_at_runtime: args.requiredAtRuntime,
      tracked_expected: args.expectedTracked ?? null,
      tracked_actual: trackedActual,
    };
  } catch {
    return {
      role: args.role,
      path: args.path,
      expected_sha256: args.expectedSha256,
      actual_sha256: null,
      gate: "not_ready",
      required_at_runtime: args.requiredAtRuntime,
      tracked_expected: args.expectedTracked ?? null,
      tracked_actual: null,
    };
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

type FixtureParser<T> = {
  parse(value: unknown): T;
};

async function readFixture<
  T extends { schema_version: string; evidence_class: string },
>(fixture: {
  path: string;
  sha256: string;
  schema_version: string;
  evidence_class: "synthetic";
}, parser: FixtureParser<T>, role: string): Promise<{
  value: T;
  integrity: Stage4IntegrityRow;
}> {
  const text = await readFile(path.resolve(fixture.path), "utf8");
  const actual = sha256(text);
  const value = parser.parse(JSON.parse(text));
  if (value.schema_version !== fixture.schema_version) {
    throw new Error(`stage4_fixture_contract_failure:${role}:schema_version`);
  }
  if (
    fixture.evidence_class !== "synthetic" ||
    value.evidence_class !== "synthetic_fixture"
  ) {
    throw new Error(`stage4_fixture_contract_failure:${role}:evidence_class`);
  }
  return {
    value,
    integrity: {
      role: path.basename(fixture.path),
      path: fixture.path,
      expected_sha256: fixture.sha256,
      actual_sha256: actual,
      gate: actual === fixture.sha256 ? "pass" : "not_ready",
      required_at_runtime: true,
      tracked_expected: null,
      tracked_actual: null,
    },
  };
}

export function renderCasimirDpPolarizationCongruenceStage4Markdown(
  report: ReturnType<
    typeof buildCasimirDpPolarizationCongruenceStage4Report
  >,
): string {
  const authorityRows = report.authority_integrity.map((row) =>
    `| ${row.role} | \`${row.path}\` | \`${row.expected_sha256}\` | ${row.actual_sha256 == null ? "missing" : `\`${row.actual_sha256}\``} | ${String(row.tracked_expected)} | ${String(row.tracked_actual)} | ${row.gate} |`,
  );
  const sourceRows = report.software_source_integrity.map((row) =>
    `| ${row.role} | \`${row.path}\` | \`${row.expected_sha256}\` | ${row.actual_sha256 == null ? "missing" : `\`${row.actual_sha256}\``} | ${String(row.tracked_expected)} | ${String(row.tracked_actual)} | ${row.gate} |`,
  );
  const fixtureRows = report.fixture_integrity.map((row) =>
    `| ${row.role} | \`${row.path}\` | \`${row.expected_sha256}\` | ${row.gate} |`,
  );
  const runRows = report.run_order.map((row) =>
    `| ${row.index} | \`${row.stage}\` | ${row.gate} |`,
  );
  const modelRows = report.model_comparator.models.map((model) =>
    `| \`${model.model_id}\` | ${model.role} | \`${model.state}\` | ${model.maximum_claim} |`,
  );
  const signatureRows = report.prediction_signature_matrix.map((row) =>
    `| \`${row.axis_id}\` | ${row.expanded_ordinary_null} | ${row.unchanged_named_dp} | ${row.registered_bridge} |`,
  );
  const outcomeRows = report.outcome_to_claim_map.map((row) =>
    `| \`${row.outcome_id}\` | ${row.establishes} | ${row.disfavors} | ${row.does_not_establish} | \`${row.maximum_claim}\` |`,
  );

  const polarizationPhaseDoubleContrast = firstRowValue(
    report.runtimes.polarization_qed,
    "double_contrasts",
    "phase_rad",
  );
  const polarizationRateDoubleContrast = firstRowValue(
    report.runtimes.polarization_qed,
    "double_contrasts",
    "coherence_decay_rate_s",
  );
  const stefanBoltzmannError =
    nestedValue(
      report.runtimes.thermal_radiative,
      "planck_stefan_boltzmann",
      "sigma_relative_error",
    );
  const netThermalPower =
    nestedValue(
      report.runtimes.thermal_radiative,
      "thermal_transfer",
      "net_power_source_to_environment_W",
    );
  const frequencyNonBridge =
    nestedValue(
      report.runtimes.tensor_congruence,
      "frequency_non_bridge",
      "status",
    );

  return `# Casimir-DP Polarization and Congruence Stage-4 report

**Campaign:** \`${report.campaign_id}\`  
**Generated:** ${report.generated_at}  
**Evidence cutoff:** ${report.evidence_cutoff}  
**Claim ceiling:** \`${report.claim_ceiling}\`  
**Promotion allowed:** \`${report.promotion_allowed}\`

## Outcome

Stage 4 adds polarization-resolved macroscopic-QED and thermal-radiative/FDT
controls to the Stage-3 ordinary-physics null, then validates tensor,
dimensional, and semantic congruence before producing synthetic predictions.
The software prediction gate is
\`${report.final_gates.software_and_synthetic_predictions}\`. Measured evidence
remains \`${report.final_gates.measured_evidence}\`; collapse identification is
\`${report.final_gates.collapse_identification}\`; manifold dynamics are
\`${report.final_gates.manifold_dynamics}\`.

${report.immutable_stage3_rule}

## Immutable authorities

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

## Runtime fixtures

| Fixture | Path | SHA-256 | Gate |
|---|---|---|---|
${fixtureRows.join("\n")}

Every fixture is synthetic. Hash closure validates replayability, not an
apparatus measurement.

## Stage-4 order of operations

| # | Stage | Gate |
|---:|---|---|
${runRows.join("\n")}

## Expanded comparator

\`${report.expanded_null.relation}\`

| Model | Role | State | Maximum claim |
|---|---|---|---|
${modelRows.join("\n")}

The named DP parameter manifest is
\`${report.unchanged_named_dp.parameter_manifest_sha256}\` and is
\`${report.unchanged_named_dp.reuse_policy}\`. A bridge is admitted to numeric
comparison: \`${report.bridge_admission.admitted_to_numeric_comparison}\`.
Registry congruence is not empirical validation.

## Prediction signature matrix

| Axis | Expanded ordinary null | Unchanged named DP | Registered bridge |
|---|---|---|---|
${signatureRows.join("\n")}

## Selected synthetic predictions

- Polarization phase double contrast:
  \`${formatScalar(polarizationPhaseDoubleContrast)} rad\`
- Polarization coherence-rate double contrast:
  \`${formatScalar(polarizationRateDoubleContrast)} s^-1\`
- Planck-to-Stefan-Boltzmann relative error:
  \`${formatScalar(stefanBoltzmannError)}\`
- Net thermal transfer:
  \`${formatScalar(netThermalPower)} W\`
- Frequency relation:
  \`${formatScalar(frequencyNonBridge)}\`

These values are prediction-fixture outputs. They are not measured collapse,
gravity, or manifold signals.

## Prediction playground

Edit a copy of any registered fixture and run the campaign with a copied config
whose fixture hash is updated:

${Object.entries(report.prediction_playground.editable_inputs).map(([key, value]) => `- \`${key}\`: \`${value}\``).join("\n")}

The invariant boundary is: ${report.prediction_playground.invariant_claim_boundary}

## Outcome-to-claim map

| Outcome id | What it establishes | What it disfavors | What it does not establish | Maximum claim |
|---|---|---|---|---|
${outcomeRows.join("\n")}

Use \`${report.model_comparator.compatibility_wording}\`, not "confirmed."

## Final gates

${Object.entries(report.final_gates).map(([gate, status]) => `- \`${gate}\`: \`${status}\``).join("\n")}

## Claim boundaries

${report.claim_boundaries.map((boundary) => `- ${boundary}`).join("\n")}
`;
}

export async function runCasimirDpPolarizationCongruenceStage4(args: {
  configPath: string;
  outRoot?: string | null;
  reportDoc?: string | null;
  now?: Date;
}) {
  const configPath = path.resolve(args.configPath);
  const configText = await readFile(configPath, "utf8");
  const config = CasimirDpPolarizationCongruenceStage4Config.parse(
    JSON.parse(configText),
  );
  assertRunOrder(config);
  const gitHead = await currentGitHead();
  if (gitHead !== config.software.source_snapshot.git_head) {
    throw new Error("stage4_source_snapshot_git_head_mismatch");
  }

  const authorityRefs = [
    config.stage3_authority_manifest,
    ...config.upstream_authorities,
  ];
  const authorityIntegrity = await Promise.all(
    authorityRefs.map((authority) =>
      integrityRow({
        role: authority.role,
        path: authority.path,
        expectedSha256: authority.sha256,
        requiredAtRuntime: authority.required_at_runtime,
        expectedTracked: authority.tracked,
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
        expectedTracked: source.tracked,
      })
    ),
  );
  const [polarizationFixture, thermalFixture, congruenceFixture] =
    await Promise.all([
      readFixture(
        config.runtime_fixtures.polarization_qed,
        CasimirDpPolarizationQedControlInput,
        "polarization_qed",
      ),
      readFixture(
        config.runtime_fixtures.thermal_radiative,
        CasimirDpRadiativeThermalClosureInput,
        "thermal_radiative",
      ),
      readFixture(
        config.runtime_fixtures.tensor_congruence,
        CasimirDpTensorDimensionalCongruenceInput,
        "tensor_congruence",
      ),
    ]);
  const fixtureIntegrity = [
    polarizationFixture.integrity,
    thermalFixture.integrity,
    congruenceFixture.integrity,
  ];
  const requiredRows = [
    ...authorityIntegrity.filter((row) => row.required_at_runtime),
    ...sourceIntegrity.filter((row) => row.required_at_runtime),
    ...fixtureIntegrity,
  ];
  const firstFailure = requiredRows.find((row) => row.gate !== "pass");
  if (firstFailure != null) {
    throw new Error(`stage4_integrity_failure:${firstFailure.role}`);
  }

  const polarizationQed = evaluateCasimirDpPolarizationQedControl(
    polarizationFixture.value,
  );
  const thermalRadiative = evaluateCasimirDpRadiativeThermalClosure(
    thermalFixture.value,
  );
  const tensorCongruence =
    evaluateCasimirDpTensorDimensionalCongruence(
      congruenceFixture.value,
    );

  const tensorBridge = tensorCongruence.tensor_bridge_chain as {
    status?: string;
    numerical_bridge_output?: unknown;
  };
  const bridgeNumericallyAdmitted =
    tensorBridge.status === "registered_numeric_kernel" &&
    tensorBridge.numerical_bridge_output != null;

  const now = args.now ?? new Date();
  const report = buildCasimirDpPolarizationCongruenceStage4Report({
    config,
    authorityIntegrity,
    sourceIntegrity,
    fixtureIntegrity,
    runtimes: {
      polarization_qed: polarizationQed,
      thermal_radiative: thermalRadiative,
      tensor_congruence: tensorCongruence,
    },
    bridgeNumericallyAdmitted,
    now,
  });

  const timestamp = now.toISOString()
    .replace(/[-:.]/g, "");
  const outDir = path.resolve(
    args.outRoot ??
      path.join(
        "artifacts",
        "research",
        "casimir-dp-polarization-congruence-stage4",
        `${config.campaign_id}-${timestamp}`,
      ),
  );
  await mkdir(path.dirname(outDir), { recursive: true });
  await mkdir(outDir, { recursive: false });
  const reportJson = stableJson(report);
  const reportMarkdown =
    renderCasimirDpPolarizationCongruenceStage4Markdown(report);
  await writeFile(
    path.join(outDir, "polarization-congruence-stage4-report.json"),
    reportJson,
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(
    path.join(outDir, "polarization-congruence-stage4-report.md"),
    reportMarkdown,
    { encoding: "utf8", flag: "wx" },
  );

  const receipt = {
    schema_version:
      "casimir_dp_polarization_congruence_stage4_receipt/1",
    campaign_id: config.campaign_id,
    generated_at: now.toISOString(),
    status: "completed",
    evidence_class: "synthetic",
    claim_ceiling: "diagnostic",
    promotion_allowed: false,
    input: {
      path: path.relative(process.cwd(), configPath).replace(/\\/g, "/"),
      sha256: sha256(configText),
    },
    immutable_stage3_authorities: authorityIntegrity,
    software_source_integrity: sourceIntegrity,
    software_source_snapshot: config.software.source_snapshot,
    runtime_fixtures: fixtureIntegrity,
    outputs: [
      {
        path: "polarization-congruence-stage4-report.json",
        sha256: sha256(reportJson),
      },
      {
        path: "polarization-congruence-stage4-report.md",
        sha256: sha256(reportMarkdown),
      },
    ],
    expanded_null_model_id:
      config.preregistration.expanded_null_model_id,
    named_dp_parameter_manifest_sha256:
      config.preregistration.named_dp_parameter_manifest_sha256,
    named_dp_reused_without_mutation: true,
    bridge_admitted_to_numeric_comparison:
      report.bridge_admission.admitted_to_numeric_comparison,
    final_gates: report.final_gates,
    prior_stage3_certificate_artifact_reused: false,
    fresh_casimir_certificate: {
      status: "pending_external_verification",
      certificate_sha256: null,
      integrity: null,
    },
  };
  const receiptJson = stableJson(receipt);
  await writeFile(
    path.join(outDir, "polarization-congruence-stage4-receipt.json"),
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
    "configs/research/casimir-dp-polarization-congruence-stage4.v1.json";
  let outRoot: string | null = null;
  let reportDoc: string | null =
    "docs/research/casimir-dp-polarization-congruence-stage4-report.md";
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
  runCasimirDpPolarizationCongruenceStage4({
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
