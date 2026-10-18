#!/usr/bin/env -S tsx

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateCasimirDpComplexCoherence,
  type CasimirDpComplexCoherenceInput,
} from "../../shared/casimir-dp-complex-coherence";
import {
  evaluateCasimirDpDpCompanion,
  type CasimirDpDpCompanionInput,
} from "../../shared/casimir-dp-dp-companion";
import {
  buildCasimirDpEvidenceMapStage3Report,
  type Stage3IntegrityRow,
} from "../../shared/casimir-dp-evidence-map-stage3";
import {
  evaluateCasimirDpGravityUpperBound,
  type CasimirDpGravityUpperBoundInput,
} from "../../shared/casimir-dp-gravity-upper-bound";
import {
  evaluateCasimirDpManifoldKernelRegistry,
  type CasimirDpManifoldKernelRegistryInput,
} from "../../shared/casimir-dp-manifold-kernel-registry";
import {
  runCasimirDpBlindedModelComparison,
  type CasimirDpBlindedModelComparisonInput,
} from "../../shared/casimir-dp-model-comparison";
import {
  evaluateCasimirDpQedGreenNoise,
  type CasimirDpQedGreenNoiseInput,
} from "../../shared/casimir-dp-qed-green-noise";
import {
  CASIMIR_DP_EVIDENCE_MAP_STAGE3_RUN_ORDER,
  CasimirDpEvidenceMapStage3Config,
  type CasimirDpEvidenceMapStage3Config as CasimirDpEvidenceMapStage3ConfigType,
} from "../../shared/contracts/casimir-dp-evidence-map-stage3.v1";

const stableJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function format(value: unknown): string {
  if (typeof value !== "number") return String(value);
  if (value === 0) return "0";
  return Math.abs(value) >= 1e4 || Math.abs(value) < 1e-3
    ? value.toExponential(5)
    : value.toFixed(8);
}

function assertRunOrder(config: CasimirDpEvidenceMapStage3ConfigType): void {
  if (
    config.run_order.length !==
      CASIMIR_DP_EVIDENCE_MAP_STAGE3_RUN_ORDER.length
  ) {
    throw new Error("stage3_run_order_length_mismatch");
  }
  CASIMIR_DP_EVIDENCE_MAP_STAGE3_RUN_ORDER.forEach((stage, index) => {
    if (config.run_order[index] !== stage) {
      throw new Error(`stage3_run_order[${index}]_must_be_${stage}`);
    }
  });
  const registryIndex = config.run_order.indexOf(
    "preflight_manifold_kernel_registry",
  );
  const freezeIndex = config.run_order.indexOf(
    "freeze_signatures_likelihoods_priors_criteria_and_falsifiers",
  );
  const comparisonIndex = config.run_order.indexOf(
    "run_blinded_held_out_joint_model_comparison",
  );
  if (!(registryIndex < freezeIndex && freezeIndex < comparisonIndex)) {
    throw new Error("stage3_registry_must_precede_freeze_and_comparison");
  }
}

async function integrityRow(args: {
  role: string;
  path: string;
  expectedSha256: string;
  requiredAtRuntime: boolean;
}): Promise<Stage3IntegrityRow> {
  try {
    const bytes = await readFile(path.resolve(args.path));
    const actual = sha256(bytes);
    return {
      role: args.role,
      path: args.path,
      expected_sha256: args.expectedSha256,
      actual_sha256: actual,
      gate: actual === args.expectedSha256 ? "pass" : "not_ready",
      required_at_runtime: args.requiredAtRuntime,
    };
  } catch {
    return {
      role: args.role,
      path: args.path,
      expected_sha256: args.expectedSha256,
      actual_sha256: null,
      gate: "not_ready",
      required_at_runtime: args.requiredAtRuntime,
    };
  }
}

async function readFixture<T>(fixture: {
  path: string;
  sha256: string;
}): Promise<{ value: T; integrity: Stage3IntegrityRow }> {
  const absolutePath = path.resolve(fixture.path);
  const text = await readFile(absolutePath, "utf8");
  const actual = sha256(text);
  return {
    value: JSON.parse(text) as T,
    integrity: {
      role: path.basename(fixture.path),
      path: fixture.path,
      expected_sha256: fixture.sha256,
      actual_sha256: actual,
      gate: actual === fixture.sha256 ? "pass" : "not_ready",
      required_at_runtime: true,
    },
  };
}

export function renderCasimirDpEvidenceMapStage3Markdown(
  report: ReturnType<typeof buildCasimirDpEvidenceMapStage3Report>,
): string {
  const authorityRows = report.authority_integrity.map((row) =>
    `| ${row.role} | \`${row.path}\` | \`${row.expected_sha256}\` | ${row.actual_sha256 == null ? "missing" : `\`${row.actual_sha256}\``} | ${row.gate} |`,
  );
  const fixtureRows = report.fixture_integrity.map((row) =>
    `| ${row.role} | \`${row.path}\` | \`${row.expected_sha256}\` | ${row.gate} |`,
  );
  const runRows = report.run_order.map((row) =>
    `| ${row.index} | \`${row.stage}\` | ${row.gate} |`,
  );
  const outcomeRows = report.outcome_to_claim_map.map((row) =>
    `| \`${row.outcome_id}\` | ${row.establishes} | ${row.disfavors} | ${row.does_not_establish} | \`${row.maximum_claim}\` |`,
  );
  const modelRows =
    Array.isArray(
        (report.runtimes.model_comparison as Record<string, unknown>)
          .model_results,
      )
      ? (
        (report.runtimes.model_comparison as Record<string, unknown>)
          .model_results as Array<Record<string, unknown>>
      ).map((row) =>
        `| \`${String(row.model_id)}\` | \`${String(row.status)}\` | ${String(row.maximum_claim)} |`,
      )
      : [];

  return `# Casimir-DP Stage-3 evidence-map report

**Campaign:** \`${report.campaign_id}\`  
**Generated:** ${report.generated_at}  
**Evidence cutoff:** ${report.evidence_cutoff}  
**Claim ceiling:** \`${report.claim_ceiling}\`  
**Promotion allowed:** \`${report.promotion_allowed}\`

## Outcome

The six Stage-3 scientific runtimes and fail-closed orchestrator are runnable
against hash-registered synthetic fixtures. This validates software recovery,
ordering, provenance checks, and maximum-claim logic only. Measured evidence
remains \`${report.final_gates.measured_evidence}\`; collapse identification is
\`${report.final_gates.collapse_identification}\`; manifold dynamics are
\`${report.final_gates.manifold_dynamics}\`.

The ordinary-physics baseline is the additive composite
\`${report.preregistration.composite_null_model_id}\` with components
${report.preregistration.composite_null_components.map((value) => `\`${value}\``).join(", ")}.
Penrose OR remains a lifetime envelope unless a generative dynamics is
registered. A bridge is admitted only when the manifold-kernel registry passes
before signatures and held-out comparison are frozen.

## Immutable authorities

| Role | Path | Expected SHA-256 | Actual SHA-256 | Gate |
|---|---|---|---|---|
${authorityRows.join("\n")}

## Runtime fixtures

| Fixture | Path | SHA-256 | Gate |
|---|---|---|---|
${fixtureRows.join("\n")}

Every fixture in this maintained run is synthetic. A passing fixture hash does
not satisfy a measured-data requirement.

## Revised Stage-3 run order

| # | Stage | Gate |
|---:|---|---|
${runRows.join("\n")}

Registry preflight occurs before model freeze and comparison. A bridge schema is
registered: \`${report.registry_preflight.bridge_schema_registered}\`. A frozen
bridge predictor is included in this comparison:
\`${report.registry_preflight.bridge_admitted_to_comparison}\`. Registry status:
\`${report.registry_preflight.status}\`. Registration is empirical validation:
\`${report.registry_preflight.registration_is_empirical_validation}\`.

## Runtime summary

- Complex coherence evidence class:
  \`${String(report.runtimes.complex_coherence.evidence_class ?? "diagnostic")}\`
- QED Green/noise claim:
  \`${String((report.runtimes.qed_green_noise.readiness as Record<string, unknown> | undefined)?.maximum_claim ?? "diagnostic")}\`
- Named-DP status:
  \`${String(report.runtimes.dp_companion.status ?? "diagnostic")}\`
- Complete-apparatus gravity claim:
  \`${String(report.runtimes.gravity_upper_bound.maximum_claim ?? "scalar_upper_bound")}\`
- Model comparison status:
  \`${String(report.runtimes.model_comparison.status ?? "not_ready")}\`
- Manifold-kernel registry:
  \`${String(report.runtimes.manifold_kernel_registry.status ?? "blocked")}\`

${modelRows.length > 0
    ? `| Model | State | Maximum claim |\n|---|---|---|\n${modelRows.join("\n")}`
    : "No confirmatory model row is promoted."}

## Outcome-to-claim map

| Outcome id | What it establishes | What it disfavors | What it does not establish | Maximum claim |
|---|---|---|---|---|
${outcomeRows.join("\n")}

The compatibility state is written
\`${report.preregistration.compatibility_wording}\`, not "confirmed."

## Final gates

${Object.entries(report.final_gates).map(([gate, status]) => `- \`${gate}\`: \`${status}\``).join("\n")}

## Claim boundaries

${report.claim_boundaries.map((boundary) => `- ${boundary}`).join("\n")}

## Selected synthetic diagnostics

- QED Ramsey coherence exponent:
  \`${format((report.runtimes.qed_green_noise.decoherence as Record<string, unknown> | undefined)?.ramsey_chi)}\`
- DP parameter manifest:
  \`${String(report.runtimes.dp_companion.parameter_manifest_sha256 ?? "not_available")}\`
- Complete-apparatus ledger:
  \`${String(report.runtimes.gravity_upper_bound.ledger_sha256 ?? "not_available")}\`

These values are fixture results, not apparatus measurements.
`;
}

export async function runCasimirDpEvidenceMapStage3(args: {
  configPath: string;
  outRoot?: string | null;
  reportDoc?: string | null;
  now?: Date;
}) {
  const configPath = path.resolve(args.configPath);
  const configText = await readFile(configPath, "utf8");
  const config = CasimirDpEvidenceMapStage3Config.parse(JSON.parse(configText));
  assertRunOrder(config);

  const authorityRefs = [
    config.authority_manifest,
    ...config.upstream_authorities,
  ];
  const authorityIntegrity = await Promise.all(
    authorityRefs.map((authority) =>
      integrityRow({
        role: authority.role,
        path: authority.path,
        expectedSha256: authority.sha256,
        requiredAtRuntime: authority.required_at_runtime,
      })
    ),
  );

  const [
    complexFixture,
    qedFixture,
    dpFixture,
    gravityFixture,
    modelFixture,
    registryFixture,
  ] = await Promise.all([
    readFixture<CasimirDpComplexCoherenceInput>(
      config.runtime_fixtures.complex_coherence,
    ),
    readFixture<CasimirDpQedGreenNoiseInput>(
      config.runtime_fixtures.qed_green_noise,
    ),
    readFixture<CasimirDpDpCompanionInput>(
      config.runtime_fixtures.dp_companion,
    ),
    readFixture<CasimirDpGravityUpperBoundInput>(
      config.runtime_fixtures.gravity_upper_bound,
    ),
    readFixture<CasimirDpBlindedModelComparisonInput>(
      config.runtime_fixtures.model_comparison,
    ),
    readFixture<CasimirDpManifoldKernelRegistryInput>(
      config.runtime_fixtures.manifold_kernel_registry,
    ),
  ]);
  const fixtureIntegrity = [
    complexFixture.integrity,
    qedFixture.integrity,
    dpFixture.integrity,
    gravityFixture.integrity,
    modelFixture.integrity,
    registryFixture.integrity,
  ];
  const requiredIntegrityPass = [
    ...authorityIntegrity.filter((row) => row.required_at_runtime),
    ...fixtureIntegrity,
  ].every((row) => row.gate === "pass");
  if (!requiredIntegrityPass) {
    const firstFailure = [
      ...authorityIntegrity.filter((row) => row.required_at_runtime),
      ...fixtureIntegrity,
    ].find((row) => row.gate !== "pass");
    throw new Error(
      `stage3_integrity_failure:${firstFailure?.role ?? "unknown"}`,
    );
  }

  const complexCoherence = evaluateCasimirDpComplexCoherence(
    complexFixture.value,
  );
  const qedGreenNoise = evaluateCasimirDpQedGreenNoise(qedFixture.value);
  const dpCompanion = evaluateCasimirDpDpCompanion(dpFixture.value);
  const gravityUpperBound = evaluateCasimirDpGravityUpperBound(
    gravityFixture.value,
  );

  // The registry is deliberately evaluated before any bridge could enter the
  // frozen model-comparison job.
  const manifoldKernelRegistry = evaluateCasimirDpManifoldKernelRegistry(
    registryFixture.value,
  );
  const modelComparison = runCasimirDpBlindedModelComparison(
    modelFixture.value,
  );
  const registryPreflightIncludedBridge =
    modelComparison.model_results.some(
      (model) =>
        model.model_kind === "registered_bridge" &&
        model.status !== "blocked" &&
        manifoldKernelRegistry.registered_model_ids.includes(model.model_id),
    );

  const now = args.now ?? new Date();
  const report = buildCasimirDpEvidenceMapStage3Report({
    config,
    authorityIntegrity,
    fixtureIntegrity,
    registryPreflightIncludedBridge,
    runtimes: {
      complex_coherence: complexCoherence,
      qed_green_noise: qedGreenNoise,
      dp_companion: dpCompanion,
      gravity_upper_bound: gravityUpperBound,
      model_comparison: modelComparison,
      manifold_kernel_registry: manifoldKernelRegistry,
    },
    now,
  });

  const timestamp = now.toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const outDir = path.resolve(
    args.outRoot ??
      path.join(
        "artifacts",
        "research",
        "casimir-dp-evidence-map-stage3",
        `${config.campaign_id}-${timestamp}`,
      ),
  );
  await mkdir(outDir, { recursive: true });
  const reportJson = stableJson(report);
  const reportMarkdown = renderCasimirDpEvidenceMapStage3Markdown(report);
  await writeFile(
    path.join(outDir, "evidence-map-stage3-report.json"),
    reportJson,
    "utf8",
  );
  await writeFile(
    path.join(outDir, "evidence-map-stage3-report.md"),
    reportMarkdown,
    "utf8",
  );

  const receipt = {
    schema_version: "casimir_dp_evidence_map_stage3_receipt/1",
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
    immutable_upstream_authorities: authorityIntegrity,
    runtime_fixtures: fixtureIntegrity,
    outputs: [
      {
        path: "evidence-map-stage3-report.json",
        sha256: sha256(reportJson),
      },
      {
        path: "evidence-map-stage3-report.md",
        sha256: sha256(reportMarkdown),
      },
    ],
    registry_preflight: report.registry_preflight,
    final_gates: report.final_gates,
    prior_stage2_certificate_reused: false,
    fresh_casimir_certificate: {
      status: "pending_external_verification",
      certificate_sha256: null,
      integrity: null,
    },
  };
  const receiptJson = stableJson(receipt);
  await writeFile(
    path.join(outDir, "evidence-map-stage3-receipt.json"),
    receiptJson,
    "utf8",
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
    "configs/research/casimir-dp-evidence-map-stage3.v1.json";
  let outRoot: string | null = null;
  let reportDoc: string | null =
    "docs/research/casimir-dp-evidence-map-stage3-report.md";
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
  runCasimirDpEvidenceMapStage3({
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
