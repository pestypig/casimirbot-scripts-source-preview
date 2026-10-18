#!/usr/bin/env -S tsx

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateCasimirDpPenroseCandidatePreflight,
  type PenroseCandidateAuthorityIntegrity,
} from "../../shared/casimir-dp-penrose-candidate-preflight";
import type { CasimirDpManifoldKernelRegistryInput } from
  "../../shared/casimir-dp-manifold-kernel-registry";
import {
  CasimirDpPenroseCandidateTheoryStage0Config,
  type CasimirDpPenroseCandidateTheoryStage0Config as PenroseConfig,
} from "../../shared/contracts/casimir-dp-penrose-candidate-theory-stage0.v1";

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const stableJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

async function auditAuthority(
  row: PenroseConfig["upstream_authorities"][number],
): Promise<PenroseCandidateAuthorityIntegrity> {
  try {
    const bytes = await readFile(path.resolve(row.path));
    const actual = sha256(bytes);
    return {
      role: row.role,
      path: row.path,
      expected_sha256: row.sha256,
      actual_sha256: actual,
      gate: actual === row.sha256 ? "pass" : "not_ready",
    };
  } catch {
    return {
      role: row.role,
      path: row.path,
      expected_sha256: row.sha256,
      actual_sha256: null,
      gate: "not_ready",
    };
  }
}

function renderMarkdown(
  result: ReturnType<typeof evaluateCasimirDpPenroseCandidatePreflight>,
  generatedAt: string,
  config: PenroseConfig,
): string {
  const authorityRows = result.authority_integrity.map(
    (row) =>
      `| ${row.role} | \`${row.path}\` | \`${row.expected_sha256}\` | ${row.actual_sha256 == null ? "missing" : `\`${row.actual_sha256}\``} | ${row.gate} |`,
  );
  const obligationRows = result.failures.map(
    (failure, index) =>
      `| ${index + 1} | \`${failure.code}\` | \`${failure.path}\` | ${failure.reason} |`,
  );
  const predictionRows = result.symbolic_prediction_ledger.map(
    (row) =>
      `| \`${row.prediction_id}\` | \`${row.status}\` | ${row.maximum_claim} |`,
  );
  const outcomeRows = result.outcome_map.map(
    (row) =>
      `| \`${row.outcome_id}\` | ${row.establishes} | ${row.disfavors} | ${row.does_not_establish} | \`${row.maximum_claim}\` |`,
  );
  const sourceRows = config.sources.map(
    (row) =>
      `| \`${row.source_id}\` | [${row.citation}](${row.url}) | ${row.supports} | ${row.does_not_support} |`,
  );

  return String.raw`# Penrose relational branch-incompatibility candidate: Stage-0 preflight

**Generated:** ${generatedAt}  
**Candidate:** \`${result.candidate_id}@${result.candidate_version}\`  
**Candidate maturity:** \`${result.maturity}\`  
**Definition status:** \`${result.candidate_status}\`  
**First scientific blocker:** \`${result.first_failure_code ?? "none"}\`  
**Claim ceiling:** \`${result.claim_ceiling}\`

## Result in one sentence

The Penrose lifetime relation is registered as a heuristic motivation, but the
candidate remains \`${result.candidate_status}\` because the repository does not
yet have a relational branch-correspondence rule, a covariant incompatibility
functional, or a generative causal reduction dynamics. The runtime emits no
collapse rate, no Casimir modifier, and no empirical claim.

This is the intended fail-closed result. It turns Penrose's stated missing
theory into a versioned research program without pretending that the missing
steps have already been derived.

## What is registered and what is not

| Candidate component | Standing |
|---|---|
| Penrose lifetime notation \(\tau_{\rm OR}\sim\hbar/E_{\rm I}\) | heuristic relation only |
| Two branch matter-geometry source objects | formal source contract supplied; apparatus receipts remain future work |
| Relational identification of points and clocks between branches | blocked |
| Covariant branch-incompatibility functional | blocked; only its Newtonian target limit is named |
| Objective-reduction dynamics and survival distribution | blocked |
| Born rule, normalization, no-signalling, and energy balance | blocked |
| Complex-coherence and companion prediction | blocked |
| Intrinsic Casimir modifier | absent; fixed-branch boundary null retained |
| Numerical model-comparison admission | forbidden |
| Empirical validation | false |

The registered Gaussian-regularized Diósi model and the composite ordinary-QED,
environmental, and gravitational null remain unchanged. This candidate neither
inherits their numerical outputs nor replaces them.

## Why the first blocker matters

Penrose's argument compares two mass-sourced spacetime descriptions. In general
relativity, subtracting their metric components point by point is not a physical
operation until the theory specifies how events, clocks, frames, and gauge are
identified across the two branches. The current candidate therefore fails first
at \`${result.first_failure_code}\`; inserting \(E_G/\hbar\) at this point would
repeat a lifetime slogan, not supply the missing dynamics.

Ordinary proper-time response remains a signed unitary phase control. It is
valuable because path swap and echo can expose false visibility loss, but it is
not promoted into objective reduction.

## Immutable upstream authorities

| Role | Path | Expected SHA-256 | Actual SHA-256 | Gate |
|---|---|---|---|---|
${authorityRows.join("\n")}

## Source scope and nonclaims

| Source id | Primary source | Supports | Does not support |
|---|---|---|---|
${sourceRows.join("\n")}

The reference register intentionally includes both Penrose's proposal and a
quantum-reference-frame alternative. Equivalence plus superposition is treated
as a contested motivation, not a derivation theorem. Relativistic-collapse and
stochastic-gravity references motivate consistency obligations; they are not
claimed as the missing kernel.

## Deterministic blockers

| Order | Code | Contract path | Meaning |
|---:|---|---|---|
${obligationRows.join("\n")}

Later blockers are retained rather than hidden behind the first failure. They
show the remaining derivation program: define the relational comparison,
construct the invariant energy functional, recover the equivalence-principle
limits, specify a physical reduction law, and then prove probability, causal,
energy, recovery, observable, and companion consistency.

## Symbolic prediction ledger

| Prediction | Status | Maximum claim |
|---|---|---|
${predictionRows.join("\n")}

All numerical values are deliberately \`null\`. A future numerical prediction
requires a separate source-backed calculator and preregistration; definition
preflight alone cannot enter the held-out model comparator.

## Experimental outcome map

| Outcome | Establishes | Disfavors | Does not establish | Maximum claim |
|---|---|---|---|---|
${outcomeRows.join("\n")}

The key experimental role is therefore to supply empirical constraints for the
missing theory. A powered mass-density/separation/time null can exclude only a
frozen operational candidate. A Diósi-shaped contraction without its companion
remains unexplained model-consistent phenomenology. A four-cell boundary excess
without a registered extension remains a boundary-superposition anomaly.

## Casimir-extension rule

The present mode is \`${result.registered_content.boundary_policy}\`, so the
fixed-branch boundary null is
\`${result.registered_content.fixed_branch_boundary_null}\`. A future claim
that the boundary changes objective reduction is a distinct model. It must pass
the existing tensor/noise/retarded-response manifold registry, supply a
separate numerical calculator, and survive the same ordinary-physics and
companion falsifiers.

## Final scientific standing

${Object.entries(result.final_gates).map(([key, value]) => `- \`${key}\`: \`${value}\``).join("\n")}

Registration is not empirical validation. The result is a formal Stage-0
candidate definition plus a diagnostic fail-closed preflight.
`;
}

export async function runCasimirDpPenroseCandidateTheoryStage0(args: {
  configPath: string;
  reportPath: string;
  receiptPath: string;
  now?: Date;
}) {
  const configPath = path.resolve(args.configPath);
  const configText = await readFile(configPath, "utf8");
  const config = CasimirDpPenroseCandidateTheoryStage0Config.parse(
    JSON.parse(configText),
  );
  const authorityIntegrity = await Promise.all(
    config.upstream_authorities.map(auditAuthority),
  );

  let boundaryRegistry: CasimirDpManifoldKernelRegistryInput | null = null;
  if (
    config.boundary_policy.mode === "registered_extension" &&
    config.boundary_policy.manifold_registry_fixture_path != null
  ) {
    const registryText = await readFile(
      path.resolve(config.boundary_policy.manifold_registry_fixture_path),
      "utf8",
    );
    if (
      sha256(registryText) !==
      config.boundary_policy.manifold_registry_fixture_sha256
    ) {
      throw new Error("penrose_candidate_boundary_registry_hash_mismatch");
    }
    boundaryRegistry = JSON.parse(
      registryText,
    ) as CasimirDpManifoldKernelRegistryInput;
  }

  const result = evaluateCasimirDpPenroseCandidatePreflight({
    config,
    authorityIntegrity,
    boundaryRegistry,
  });
  const generatedAt = (
    args.now ?? new Date(config.canonical_generated_at)
  ).toISOString();
  const report = renderMarkdown(result, generatedAt, config);
  await writeFile(path.resolve(args.reportPath), report, "utf8");

  const receipt = {
    schema_version: "casimir_dp_penrose_candidate_theory_stage0_receipt/1",
    generated_at: generatedAt,
    input: {
      path: path.relative(process.cwd(), configPath).replace(/\\/g, "/"),
      sha256: sha256(configText),
    },
    output: {
      path: args.reportPath.replace(/\\/g, "/"),
      sha256: sha256(report),
    },
    authority_integrity: authorityIntegrity,
    candidate_status: result.candidate_status,
    first_failure_code: result.first_failure_code,
    maturity: result.maturity,
    numerical_output: null,
    model_comparison_admission: false,
    empirically_validated: false,
    final_gates: result.final_gates,
    claim_ceiling: result.claim_ceiling,
  };
  await writeFile(path.resolve(args.receiptPath), stableJson(receipt), "utf8");
  return { config, result, report, receipt };
}

function parseArgs(argv: string[]) {
  const read = (name: string, fallback: string): string => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] != null ? argv[index + 1] : fallback;
  };
  const nowText = read("--now", "");
  return {
    configPath: read(
      "--config",
      "configs/research/casimir-dp-penrose-candidate-theory-stage0.v1.json",
    ),
    reportPath: read(
      "--report",
      "docs/research/casimir-dp-penrose-candidate-theory-stage0-report.md",
    ),
    receiptPath: read(
      "--receipt",
      "docs/research/casimir-dp-penrose-candidate-theory-stage0-receipt.json",
    ),
    now: nowText.length > 0 ? new Date(nowText) : undefined,
  };
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  runCasimirDpPenroseCandidateTheoryStage0(parseArgs(process.argv.slice(2)))
    .then(({ result, receipt }) => {
      process.stdout.write(`${stableJson({
        candidate_status: result.candidate_status,
        first_failure_code: result.first_failure_code,
        numerical_output: result.numerical_output,
        measured_evidence: result.final_gates.measured_evidence,
        collapse_identification: result.final_gates.collapse_identification,
        manifold_dynamics: result.final_gates.manifold_dynamics,
        receipt,
      })}`);
    })
    .catch((error) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
}
