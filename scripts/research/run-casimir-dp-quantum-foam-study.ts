#!/usr/bin/env -S tsx

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DpCollapseInput, computeDpCollapse } from "../../shared/dp-collapse";

const EXPECTED_RUN_ORDER = [
  "freeze_protocol",
  "casimir_reference_baseline",
  "casimir_material_and_metrology_gate",
  "boundary_condition_coherence_protocol",
  "standard_decoherence_budget_gate",
  "dp_branch_provenance_gate",
  "dp_self_energy_diagnostic",
  "dp_experimental_bounds_gate",
  "manifold_response_model_gate",
  "observable_bridge_gate",
  "sensitivity_and_negative_controls",
  "cold_start_reproduction",
  "paper_evidence_ledger_update",
] as const;

const StudyConfig = z.object({
  schema_version: z.literal("casimir_dp_quantum_foam_study/1"),
  study_id: z.string().min(1),
  run_label: z.string().min(1),
  evidence_cutoff: z.string().min(1),
  claim_tier: z.literal("diagnostic"),
  casimir: z.object({
    gap_m: z.number().positive(),
    plate_radius_m: z.number().positive(),
    temperature_K: z.number().nonnegative(),
    model: z.literal("ideal_parallel_plate_zero_temperature"),
    notes: z.array(z.string()).default([]),
  }),
  dp: DpCollapseInput,
  hypothesis_bridge: z.object({
    status: z.literal("blocked"),
    reason: z.literal("missing_registered_observable_bridge"),
    from_observable: z.string().min(1),
    to_observable: z.string().min(1),
    notes: z.array(z.string()).default([]),
  }),
  manifold_response: z.object({
    status: z.literal("blocked"),
    math_maturity: z.literal("stage_0_exploratory"),
    measured_observable: z.literal("boundary_conditioned_coherence_decay_rate_residual_s^-1"),
    reason: z.literal("missing_registered_tensor_metric_coherence_response"),
    ordinary_decoherence_budget_required: z.literal(true),
    notes: z.array(z.string()).default([]),
  }),
  run_order: z.array(z.string()),
});

type StudyConfig = z.infer<typeof StudyConfig>;

const HBAR_J_S = 1.054571817e-34;
const C_M_S = 299792458;

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function timestampId(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseArgs(argv: string[]): { configPath: string; outRoot: string | null } {
  let configPath = "configs/research/casimir-dp-quantum-foam-study.v1.json";
  let outRoot: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      configPath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--out") {
      outRoot = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!configPath.trim()) throw new Error("--config requires a path");
  if (outRoot !== null && !outRoot.trim()) throw new Error("--out requires a path");
  return { configPath, outRoot };
}

function assertRunOrder(config: StudyConfig): void {
  if (config.run_order.length !== EXPECTED_RUN_ORDER.length) {
    throw new Error("run_order does not match the canonical study protocol");
  }
  EXPECTED_RUN_ORDER.forEach((stage, index) => {
    if (config.run_order[index] !== stage) {
      throw new Error(`run_order[${index}] must be ${stage}`);
    }
  });
}

function computeCasimirReference(config: StudyConfig["casimir"]) {
  const area_m2 = Math.PI * config.plate_radius_m ** 2;
  const hbarC_J_m = HBAR_J_S * C_M_S;
  const energy_per_area_J_m2 = -(Math.PI ** 2 * hbarC_J_m) / (720 * config.gap_m ** 3);
  const pressure_Pa = -(Math.PI ** 2 * hbarC_J_m) / (240 * config.gap_m ** 4);
  return {
    schema_version: "casimir_reference_baseline/1",
    model: config.model,
    gap_m: config.gap_m,
    plate_radius_m: config.plate_radius_m,
    area_m2,
    temperature_K: config.temperature_K,
    energy_per_area_J_m2,
    total_energy_J: energy_per_area_J_m2 * area_m2,
    pressure_Pa,
    force_N: pressure_Pa * area_m2,
    provenance_class: "canonical_reference",
    claim_tier: "diagnostic",
    certifying: false,
    notes: config.notes,
  } as const;
}

export async function runCasimirDpStudy(args: {
  configPath: string;
  outRoot?: string | null;
  now?: Date;
}): Promise<{ outDir: string; receiptPath: string }> {
  const now = args.now ?? new Date();
  const configPath = path.resolve(args.configPath);
  const configText = await readFile(configPath, "utf8");
  const config = StudyConfig.parse(JSON.parse(configText));
  assertRunOrder(config);

  const runId = `${config.run_label}-${timestampId(now)}`;
  const outDir = path.resolve(
    args.outRoot ?? path.join("artifacts", "research", config.study_id, runId),
  );
  await mkdir(outDir, { recursive: true });

  const casimir = computeCasimirReference(config.casimir);
  const dp = computeDpCollapse(config.dp);
  const inputHash = sha256(configText.replace(/\r\n/g, "\n"));
  const casimirText = stableJson(casimir);
  const dpText = stableJson(dp);
  const casimirPath = path.join(outDir, "casimir-reference-baseline.json");
  const dpPath = path.join(outDir, "dp-collapse-diagnostic.json");
  await writeFile(casimirPath, casimirText, "utf8");
  await writeFile(dpPath, dpText, "utf8");

  const gates = {
    protocol_order: "pass",
    casimir_reference_baseline: "pass",
    casimir_material_and_metrology: "not_ready",
    boundary_condition_coherence_protocol: "not_ready",
    standard_decoherence_budget: "not_ready",
    dp_solver: Number.isFinite(dp.deltaE_J) && Number.isFinite(dp.tau_s) ? "pass" : "fail",
    dp_branch_provenance: dp.certifying ? "pass" : "not_ready",
    dp_experimental_bounds: "review",
    manifold_response_model: "blocked",
    observable_bridge: "blocked",
    sensitivity_and_negative_controls: "not_ready",
    cold_start_reproduction: "not_ready",
  } as const;

  const receipt = {
    schema_version: "casimir_dp_quantum_foam_study_receipt/1",
    study_id: config.study_id,
    run_id: runId,
    generated_at: now.toISOString(),
    evidence_cutoff: config.evidence_cutoff,
    status: "completed",
    disposition: "diagnostic_only_blocked_bridge",
    claim_tier: config.claim_tier,
    promotion_allowed: false,
    input: {
      config_path: path.relative(process.cwd(), configPath).replace(/\\/g, "/"),
      sha256: inputHash,
    },
    run_order: config.run_order,
    outputs: [
      {
        path: "casimir-reference-baseline.json",
        sha256: sha256(casimirText),
        evidence_status: "reference_only",
      },
      {
        path: "dp-collapse-diagnostic.json",
        sha256: sha256(dpText),
        evidence_status: dp.certifying ? "provenance_admitted" : "diagnostic_only",
      },
    ],
    gates,
    bridge: config.hypothesis_bridge,
    manifold_response: config.manifold_response,
    claim_boundaries: [
      "The Casimir baseline is an ideal reference, not a material or metrology receipt.",
      "The DP result is derived from mass-density branches and not from measured Casimir force.",
      "No quantitative observable bridge from Casimir residual to DP self-energy is registered.",
      "No tensor-to-metric-to-coherence response functional is registered.",
      "Boundary-conditioned decoherence is not identified with objective collapse.",
      "Negative renormalized energy density does not uniquely determine a negative-curvature manifold.",
      "Quantum foam remains a candidate model family and is not established by either calculation.",
      "A completed receipt is not a pass of the blocked scientific gates.",
    ],
  };
  const receiptPath = path.join(outDir, "study-run-receipt.json");
  await writeFile(receiptPath, stableJson(receipt), "utf8");
  return { outDir, receiptPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runCasimirDpStudy({
    configPath: args.configPath,
    outRoot: args.outRoot,
  });
  console.log(stableJson({ status: "completed", ...result }).trim());
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
