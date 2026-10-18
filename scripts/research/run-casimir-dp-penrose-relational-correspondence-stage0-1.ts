import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  evaluateCasimirDpPenroseRelationalCorrespondenceStage01,
  type PenroseRelationalCorrespondenceAuthorityIntegrity,
  type PenroseRelationalCorrespondenceStage01Result,
} from "../../shared/casimir-dp-penrose-relational-correspondence-stage0-1";
import {
  CasimirDpPenroseRelationalCorrespondenceStage01Config,
  type CasimirDpPenroseRelationalCorrespondenceStage01Config as Stage01Config,
} from "../../shared/contracts/casimir-dp-penrose-relational-correspondence-stage0-1.v1";

const DEFAULT_CONFIG_PATH =
  "configs/research/casimir-dp-penrose-relational-correspondence-stage0-1.v1.json";
const DEFAULT_REPORT_PATH =
  "docs/research/casimir-dp-penrose-relational-correspondence-stage0-1-report.md";
const DEFAULT_RECEIPT_PATH =
  "docs/research/casimir-dp-penrose-relational-correspondence-stage0-1-receipt.json";

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const escapeCell = (value: unknown): string =>
  String(value ?? "null").replaceAll("|", "\\|").replaceAll("\n", " ");

const formatNumber = (value: number | null): string => {
  if (value == null) return "null";
  if (value === 0) return "0";
  return value.toExponential(8);
};

function buildReport(
  config: Stage01Config,
  result: PenroseRelationalCorrespondenceStage01Result,
): string {
  const lines: string[] = [
    "# Penrose relational branch correspondence: Stage-0.1 benchmark",
    "",
    `**Generated:** ${config.canonical_generated_at}  `,
    `**Benchmark:** \`${config.benchmark_id}@${config.benchmark_version}\`  `,
    `**Maturity:** \`${result.maturity}\`  `,
    `**Synthetic benchmark:** \`${result.synthetic_benchmark_status}\`  `,
    `**Scientific correspondence:** \`${result.scientific_correspondence_status}\`  `,
    `**First blocker:** \`${result.first_failure_code ?? "none"}\`  `,
    `**Claim ceiling:** \`${result.claim_ceiling}\``,
    "",
    "## Result in one sentence",
    "",
    "One branch-blind apparatus-landmark prescription passes the frozen local affine, identity, inverse, branch-swap, independent-rigid-coordinate-relabeling, common-input-equality, alternate-reference, and Gaussian weak-field recovery fixtures, while the scientific correspondence remains blocked because all same-apparatus reference packets are absent.",
    "",
    "This is a synthetic theory benchmark, not a physical correspondence measurement. It does not choose a unique map between arbitrary spacetimes, define a covariant incompatibility functional, generate objective reduction, or admit a likelihood vector.",
    "",
    "## What is genuinely new",
    "",
    "The benchmark makes event identification an explicit gate before any branch energy is interpreted. Its local map is `varphi_corr_A_to_B = X_B after X_A^-1`, with domain `X_A(B_lab)` and codomain `X_B(B_lab)`, where each `X_r` embeds the same apparatus clock-and-fiducial labels into branch `r`. Existing Newtonian `E_G` calculations begin after a density comparison has already been chosen; this campaign tests that hidden choice on frozen weak-field fixtures.",
    "",
    "The formal pullback targets are `Delta_B_T = X_A^*T_A - X_B^*T_B` and `Delta_B_g = X_A^*g_A - X_B^*g_B`. No measured stress tensor or metric pullback is claimed here.",
    "",
    "## Gate ledger",
    "",
    "| Gate | Status | Value | Tolerance | Meaning |",
    "|---|---|---:|---:|---|",
    ...result.gates.map((entry) =>
      `| \`${escapeCell(entry.gate_id)}\` | ${entry.status} | ${escapeCell(entry.value)} | ${escapeCell(entry.tolerance)} | ${escapeCell(entry.interpretation)} |`,
    ),
    "",
    "## Weak-field recovery",
    "",
    "| Quantity | Value |",
    "|---|---:|",
    `| Pulled-back relational separation | ${formatNumber(result.correspondence.primary_separation_m)} m |`,
    `| Registered Gaussian analytic target | ${formatNumber(result.weak_field_recovery.analytic_target_E_G_J)} J |`,
    `| Relational Fourier recovery | ${formatNumber(result.weak_field_recovery.relational_fourier_E_G_J)} J |`,
    `| Relative recovery error | ${formatNumber(result.weak_field_recovery.relative_error)} |`,
    `| Identity-branch target | ${formatNumber(result.weak_field_recovery.identity_E_G_J)} J |`,
    `| Branch-swap relative error | ${formatNumber(result.weak_field_recovery.branch_swap_relative_error)} |`,
    "",
    "The recovered energy is a diagnostic Newtonian target. It is not promoted to an objective-reduction rate, lifetime distribution, or complex-coherence prediction.",
    "",
    "## Physical authority still missing",
    "",
    `Ready packets: **${result.physical_reference_authority.ready_packets}/${result.physical_reference_authority.required_packets}**.`,
    "",
    "| Packet | Standing | Missing fields |",
    "|---|---|---|",
    ...config.reference_contract.physical_authority_packets.map((packet) =>
      `| \`${escapeCell(packet.packet_id)}\` | ${packet.status} | ${escapeCell(packet.missing_fields.join("; "))} |`,
    ),
    "",
    "Until those packets exist, the parent candidate correctly remains at `PCT_BRANCH_CORRESPONDENCE_MISSING`. A synthetic pass means only that this one prescription survives its frozen fixtures.",
    "The v1 schema intentionally admits only `not_ready` packet records. Measured packet admission requires a versioned successor with artifact paths, hash verification, calibration/custody fields, and uncertainty validation; v1 must not be edited in place to claim readiness.",
    "",
    "## Deterministic failure ledger",
    "",
    "| Code | Class | Path | Reason |",
    "|---|---|---|---|",
    ...result.failures.map((failure) =>
      `| \`${escapeCell(failure.code)}\` | ${failure.class} | \`${escapeCell(failure.path)}\` | ${escapeCell(failure.reason)} |`,
    ),
    "",
    "## Source scope",
    "",
    "| Source | Supports | Does not support |",
    "|---|---|---|",
    ...config.sources.map((source) =>
      `| [${escapeCell(source.citation)}](${source.url}) | ${escapeCell(source.supports)} | ${escapeCell(source.does_not_support)} |`,
    ),
    "",
    "## Claim boundary",
    "",
    "Passing Stage-0.1 shows that one proposed local correspondence survives frozen local affine and independent-rigid-coordinate-relabeling tests and preserves the known synthetic branch displacement. It does not establish arbitrary diffeomorphism covariance or equivalence-principle recovery, select a unique physical correspondence, establish a covariant incompatibility energy, define collapse dynamics, or validate Penrose objective reduction.",
    "",
    `- Stage-0 parent first failure: \`${result.stage0_candidate_first_failure_remains}\``,
    `- Invariant functional: \`${result.invariant_functional_status}\``,
    `- Collapse rate: \`${result.proposed_collapse_rate_s}\``,
    `- Lifetime distribution: \`${result.proposed_lifetime_distribution}\``,
    `- Coherence prediction: \`${result.proposed_coherence_prediction}\``,
    `- Casimir modifier: \`${result.proposed_casimir_modifier}\``,
    `- Model-comparison admission: \`${result.model_comparison_admission}\``,
    `- Empirical validation: \`${result.empirically_validated}\``,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export async function runCasimirDpPenroseRelationalCorrespondenceStage01(
  options: {
    configPath?: string;
    reportPath?: string;
    receiptPath?: string;
  } = {},
) {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const reportPath = options.reportPath ?? DEFAULT_REPORT_PATH;
  const receiptPath = options.receiptPath ?? DEFAULT_RECEIPT_PATH;
  const configBytes = readFileSync(configPath);
  const config = CasimirDpPenroseRelationalCorrespondenceStage01Config.parse(
    JSON.parse(configBytes.toString("utf8")),
  );
  const authorityIntegrity: PenroseRelationalCorrespondenceAuthorityIntegrity[] =
    config.upstream_authorities.map((authority) => {
      let actual: string | null = null;
      let semanticCandidateStatus:
        | "blocked"
        | "definition_complete_not_validated"
        | undefined;
      let semanticFirstFailureCode: string | null | undefined;
      let semanticNonpromotionGate: "pass" | "not_ready" | undefined;
      try {
        const bytes = readFileSync(authority.path);
        actual = sha256(bytes);
        if (authority.role === "stage0_candidate_receipt_authority") {
          const receipt = JSON.parse(bytes.toString("utf8")) as {
            candidate_status?: unknown;
            first_failure_code?: unknown;
            numerical_output?: unknown;
            model_comparison_admission?: unknown;
            empirically_validated?: unknown;
          };
          semanticCandidateStatus = receipt.candidate_status === "blocked"
            ? "blocked"
            : receipt.candidate_status === "definition_complete_not_validated"
            ? "definition_complete_not_validated"
            : undefined;
          semanticFirstFailureCode = typeof receipt.first_failure_code === "string"
            ? receipt.first_failure_code
            : receipt.first_failure_code === null ? null : undefined;
          semanticNonpromotionGate =
            receipt.numerical_output === null &&
            receipt.model_comparison_admission === false &&
            receipt.empirically_validated === false
              ? "pass"
              : "not_ready";
        }
      } catch {
        actual = null;
      }
      return {
        role: authority.role,
        path: authority.path,
        expected_sha256: authority.sha256,
        actual_sha256: actual,
        gate: actual === authority.sha256 ? "pass" : "not_ready",
        semantic_candidate_status: semanticCandidateStatus,
        semantic_first_failure_code: semanticFirstFailureCode,
        semantic_nonpromotion_gate: semanticNonpromotionGate,
      };
    });
  const result = evaluateCasimirDpPenroseRelationalCorrespondenceStage01({
    config,
    authorityIntegrity,
  });
  const report = buildReport(config, result);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report, "utf8");
  const receipt = {
    schema_version:
      "casimir_dp_penrose_relational_correspondence_stage0_1_receipt/1",
    generated_at: config.canonical_generated_at,
    campaign_id: config.campaign_id,
    benchmark_id: config.benchmark_id,
    benchmark_version: config.benchmark_version,
    input: {
      path: configPath,
      sha256: sha256(configBytes),
    },
    output: {
      path: reportPath,
      sha256: sha256(report),
    },
    overall_status: result.overall_status,
    synthetic_benchmark_status: result.synthetic_benchmark_status,
    scientific_correspondence_status: result.scientific_correspondence_status,
    first_failure_code: result.first_failure_code,
    synthetic_first_failure_code: result.synthetic_first_failure_code,
    physical_reference_authority: result.physical_reference_authority,
    weak_field_recovery: result.weak_field_recovery,
    stage0_candidate_first_failure_remains:
      result.stage0_candidate_first_failure_remains,
    invariant_functional_status: result.invariant_functional_status,
    proposed_collapse_rate_s: result.proposed_collapse_rate_s,
    proposed_lifetime_distribution: result.proposed_lifetime_distribution,
    proposed_coherence_prediction: result.proposed_coherence_prediction,
    proposed_casimir_modifier: result.proposed_casimir_modifier,
    model_comparison_admission: result.model_comparison_admission,
    empirically_validated: result.empirically_validated,
    claim_ceiling: result.claim_ceiling,
    authority_integrity: result.authority_integrity,
  } as const;
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return { config, result, report, receipt };
}

const entryPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (entryPath != null && import.meta.url === entryPath) {
  runCasimirDpPenroseRelationalCorrespondenceStage01()
    .then(({ result, receipt }) => {
      process.stdout.write(`${JSON.stringify({
        overall_status: result.overall_status,
        synthetic_benchmark_status: result.synthetic_benchmark_status,
        first_failure_code: result.first_failure_code,
        synthetic_first_failure_code: result.synthetic_first_failure_code,
        weak_field_recovery: result.weak_field_recovery,
        output_sha256: receipt.output.sha256,
      }, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
