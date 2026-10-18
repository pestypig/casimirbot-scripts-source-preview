#!/usr/bin/env -S tsx

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { convertLossTableToImaginaryAxis } from "../../shared/casimir-optical-response";
import {
  AcquisitionSidecarArtifact,
  estimateCorrelationPower,
  validateAcquisitionSidecar,
} from "../../shared/casimir-dp-data-readiness";
import {
  CasimirDpDataReadinessConfig,
  type CasimirDpDataReadinessConfig as CasimirDpDataReadinessConfigType,
} from "../../shared/contracts/casimir-dp-data-readiness.v1";

export const CASIMIR_DP_DATA_READINESS_RUN_ORDER = [
  "freeze_blinded_secondary_observable_protocol",
  "audit_primary_source_data_availability",
  "verify_optical_fixture_artifact_hash",
  "validate_kramers_kronig_against_analytic_lorentz_model",
  "apply_measured_optical_response_gate",
  "verify_switching_sidecar_hash_calibration_and_covariance",
  "verify_decoherence_sidecar_hash_calibration_and_covariance",
  "estimate_secondary_cross_correlation_power",
  "apply_collapse_dynamics_identifiability_gate",
  "write_hashed_data_readiness_receipt",
  "update_study_evidence_ledger",
] as const;

const LorentzFixture = z.object({
  schema_version: z.literal("casimir_optical_lorentz_fixture/1"),
  material_id: z.string().min(1),
  label: z.string().min(1),
  oscillator_strength_rad_s2: z.number().positive(),
  resonance_rad_s: z.number().positive(),
  damping_rad_s: z.number().positive(),
  omega_min_rad_s: z.number().positive(),
  omega_max_rad_s: z.number().positive(),
  point_count: z.number().int().min(1001).max(50_001),
  relative_loss_uncertainty: z.number().positive().lt(1),
});

const stableJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function assertRunOrder(config: CasimirDpDataReadinessConfigType): void {
  if (config.run_order.length !== CASIMIR_DP_DATA_READINESS_RUN_ORDER.length) {
    throw new Error("Data-readiness run order length mismatch.");
  }
  CASIMIR_DP_DATA_READINESS_RUN_ORDER.forEach((stage, index) => {
    if (config.run_order[index] !== stage) {
      throw new Error(`run_order[${index}] must be ${stage}`);
    }
  });
}

function logGrid(minimum: number, maximum: number, count: number): number[] {
  const low = Math.log(minimum);
  const step = (Math.log(maximum) - low) / (count - 1);
  return Array.from({ length: count }, (_, index) => Math.exp(low + step * index));
}

async function loadHashedJson<T>(root: string, pointer: { path: string; sha256: string }, schema: z.ZodType<T>) {
  const absolutePath = path.resolve(root, pointer.path);
  const raw = await readFile(absolutePath);
  const actualSha256 = sha256(raw);
  return {
    absolutePath,
    raw,
    actualSha256,
    expectedSha256: pointer.sha256,
    integrity: actualSha256 === pointer.sha256 ? "pass" as const : "not_ready" as const,
    value: schema.parse(JSON.parse(raw.toString("utf8"))),
  };
}

export async function buildCasimirDpDataReadinessReport(args: {
  root: string;
  config: CasimirDpDataReadinessConfigType;
  now?: Date;
}) {
  assertRunOrder(args.config);
  const opticalArtifact = await loadHashedJson(
    args.root,
    args.config.optical_validation_fixture,
    LorentzFixture,
  );
  const switchingArtifact = await loadHashedJson(
    args.root,
    args.config.switching_sidecar,
    AcquisitionSidecarArtifact,
  );
  const decoherenceArtifact = await loadHashedJson(
    args.root,
    args.config.decoherence_sidecar,
    AcquisitionSidecarArtifact,
  );

  const fixture = opticalArtifact.value;
  const omega = logGrid(fixture.omega_min_rad_s, fixture.omega_max_rad_s, fixture.point_count);
  const lossPoints = omega.map((frequency) => {
    const denominator =
      (fixture.resonance_rad_s ** 2 - frequency ** 2) ** 2 +
      (fixture.damping_rad_s * frequency) ** 2;
    const epsilonImag =
      fixture.oscillator_strength_rad_s2 * fixture.damping_rad_s * frequency / denominator;
    return {
      omega_rad_s: frequency,
      epsilon_imag: epsilonImag,
      standard_uncertainty: epsilonImag * fixture.relative_loss_uncertainty,
    };
  });
  const xi = logGrid(1e12, 1e20, 33);
  const optical = convertLossTableToImaginaryAxis({
    receipt: {
      schema_version: "casimir_optical_response_receipt/1",
      material_id: fixture.material_id,
      label: fixture.label,
      evidence_class: "synthetic_fixture",
      source_ref: args.config.optical_validation_fixture.path,
      raw_artifact_path: args.config.optical_validation_fixture.path,
      expected_sha256: opticalArtifact.expectedSha256,
      actual_sha256: opticalArtifact.actualSha256,
      calibration_refs: ["analytic-single-Lorentz-model"],
      points: lossPoints,
      required_coverage: {
        min_omega_rad_s: fixture.omega_min_rad_s,
        max_omega_rad_s: fixture.omega_max_rad_s * (1 - 1e-12),
      },
      tails: {
        low_frequency_model: "single-Lorentz analytic low-frequency limit",
        high_frequency_model: "single-Lorentz omega^-3 loss tail",
      },
    },
    xi_rad_s: xi,
  });
  const analyticRows = optical.points.map((point) => {
    const analytic = 1 + fixture.oscillator_strength_rad_s2 /
      (fixture.resonance_rad_s ** 2 + point.xi_rad_s ** 2 + fixture.damping_rad_s * point.xi_rad_s);
    return {
      xi_rad_s: point.xi_rad_s,
      numerical_epsilon: point.epsilon,
      analytic_epsilon: analytic,
      relative_error: Math.abs(point.epsilon - analytic) / analytic,
    };
  });
  const maximumRelativeError = Math.max(...analyticRows.map((row) => row.relative_error));

  const switching = validateAcquisitionSidecar({
    artifact: switchingArtifact.value,
    expected_sha256: switchingArtifact.expectedSha256,
    actual_sha256: switchingArtifact.actualSha256,
  });
  const decoherence = validateAcquisitionSidecar({
    artifact: decoherenceArtifact.value,
    expected_sha256: decoherenceArtifact.expectedSha256,
    actual_sha256: decoherenceArtifact.actualSha256,
  });
  const correlationPower = args.config.correlation_power_cases.map((entry) => ({
    case_id: entry.case_id,
    result: estimateCorrelationPower(entry.input),
  }));
  const datasetSummary = args.config.dataset_manifest.reduce<Record<string, number>>((summary, entry) => {
    summary[entry.access_status] = (summary[entry.access_status] ?? 0) + 1;
    return summary;
  }, {});

  const body = {
    schema_version: "casimir_dp_data_readiness_report/1" as const,
    study_id: args.config.study_id,
    campaign_id: args.config.campaign_id,
    generated_at_utc: (args.now ?? new Date()).toISOString(),
    evidence_cutoff: args.config.evidence_cutoff,
    run_order: args.config.run_order,
    optical_response: {
      fixture_evidence_class: args.config.optical_validation_fixture.evidence_class,
      artifact_integrity: opticalArtifact.integrity,
      kramers_kronig_analytic_validation: maximumRelativeError <= 0.02 ? "pass" as const : "not_ready" as const,
      maximum_relative_error: maximumRelativeError,
      transformed_point_count: optical.points.length,
      gates: optical.gates,
      measured_material_gate: "not_ready" as const,
      publication_use: "validation_fixture_only" as const,
    },
    sidecars: {
      switching,
      decoherence,
      authenticated_measured_pair_gate: "not_ready" as const,
    },
    sources: {
      entries: args.config.dataset_manifest,
      summary: datasetSummary,
      imported_as_apparatus_measurements: 0,
    },
    preregistration: {
      ...args.config.secondary_observable_protocol,
      correlation_power: correlationPower,
      unblinding_condition: "Unblind only after artifact hashes, calibrations, covariance, exclusion rules, and frozen analysis code all pass.",
    },
    gates: {
      runnable_pipeline: opticalArtifact.integrity === "pass" && switching.structurally_runnable && decoherence.structurally_runnable
        ? "pass" as const
        : "not_ready" as const,
      measured_evidence: "not_ready" as const,
      collapse_identifiability: "blocked" as const,
      manifold_dynamics: "blocked" as const,
      publication_grade: "not_ready" as const,
    },
    promotion_allowed: false,
    next_inputs: [
      "An apparatus-specific measured loss table epsilon''(omega), its calibration records, full covariance or a justified correlation model, and a SHA-256-authenticated raw artifact.",
      "Hash-authenticated switching and superposition-acquisition sidecars produced in the same blinded campaign, with synchronized clocks and calibration certificates.",
      "A source-backed DP or Penrose secondary-observable dynamics signature distinct from ordinary decoherence; no such signature is registered here.",
      "A registered tensor/noise-kernel/causal-response/coherence map before any manifold-response rate is computed.",
    ],
  };
  return { ...body, receipt_sha256: sha256(stableJson(body)) };
}

export function renderCasimirDpDataReadinessMarkdown(
  report: Awaited<ReturnType<typeof buildCasimirDpDataReadinessReport>>,
): string {
  const sourceRows = report.sources.entries.map((entry) =>
    `| ${entry.dataset_id} | ${entry.access_status} | ${entry.repository_checksum ?? "none registered"} | no |`,
  ).join("\n");
  const powerRows = report.preregistration.correlation_power.map((entry) =>
    `| ${entry.case_id} | ${entry.result.paired_windows.toLocaleString("en-US")} | ${entry.result.adjusted_type_i_error.toPrecision(3)} | diagnostic only |`,
  ).join("\n");
  return `# Casimir–DP data-readiness report\n\n` +
    `- Campaign: \`${report.campaign_id}\`\n` +
    `- Generated: \`${report.generated_at_utc}\`\n` +
    `- Receipt SHA-256: \`${report.receipt_sha256}\`\n` +
    `- Claim tier: **diagnostic; promotion blocked**\n\n` +
    `## Result\n\n` +
    `The data path is runnable with hash-authenticated synthetic fixtures. The analytic Kramers–Kronig check is \`${report.optical_response.kramers_kronig_analytic_validation}\` with maximum relative error \`${report.optical_response.maximum_relative_error.toExponential(4)}\`. This validates the numerical transform, not any material measurement.\n\n` +
    `Measured optical response: \`${report.optical_response.measured_material_gate}\`; authenticated measured switching/decoherence pair: \`${report.sidecars.authenticated_measured_pair_gate}\`; collapse identifiability: \`${report.gates.collapse_identifiability}\`; manifold dynamics: \`${report.gates.manifold_dynamics}\`.\n\n` +
    `## Source-data access ledger\n\n` +
    `| Dataset | Access status | Repository checksum | Admitted as this study's measurement |\n|---|---|---|---|\n${sourceRows}\n\n` +
    `The source packages are external benchmarks or constraint records. None is relabelled as an apparatus-matched measurement for this study.\n\n` +
    `## Sidecar gates\n\n` +
    `Both synthetic fixtures pass artifact-integrity, calibration-reference, observable-identity, covariance-dimension, symmetry, and positive-semidefinite checks. Their \`measured_evidence\` gates remain \`not_ready\` by construction.\n\n` +
    `## Blinded secondary-observable preregistration\n\n` +
    `Primary: \`${report.preregistration.primary_observable}\`. Secondary channels: ${report.preregistration.secondary_observables.map((id) => `\`${id}\``).join(", ")}. Negative controls: ${report.preregistration.negative_controls.map((id) => `\`${id}\``).join(", ")}.\n\n` +
    `Null: ${report.preregistration.registered_null}\n\n` +
    `Alternative: ${report.preregistration.registered_alternative}\n\n` +
    `| Power case | Paired windows | Multiplicity-adjusted alpha | Authority |\n|---|---:|---:|---|\n${powerRows}\n\n` +
    `These correlation calculations size contamination/discriminator channels. They do not size or identify objective collapse.\n\n` +
    `## Required next inputs\n\n${report.next_inputs.map((item) => `- ${item}`).join("\n")}\n\n` +
    `## Claim boundary\n\nNo collapse rate, quantum-foam mechanism, negative-curvature response, or manifold manipulation is inferred from these readiness checks. Publication-grade and promotion gates remain closed.\n`;
}

export async function runCasimirDpDataReadiness(args: {
  root?: string;
  configPath?: string;
  reportPath?: string;
  now?: Date;
} = {}) {
  const root = args.root ?? process.cwd();
  const configPath = path.resolve(root, args.configPath ?? "configs/research/casimir-dp-data-readiness.v1.json");
  const reportPath = path.resolve(root, args.reportPath ?? "docs/research/casimir-dp-data-readiness-report.md");
  const config = CasimirDpDataReadinessConfig.parse(JSON.parse(await readFile(configPath, "utf8")));
  const report = await buildCasimirDpDataReadinessReport({ root, config, now: args.now });
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, renderCasimirDpDataReadinessMarkdown(report), "utf8");
  return { report, reportPath };
}

const isMain = process.argv[1] != null &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runCasimirDpDataReadiness().then(({ report, reportPath }) => {
    process.stdout.write(`${stableJson({ report_path: reportPath, receipt_sha256: report.receipt_sha256, gates: report.gates })}`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

