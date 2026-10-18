#!/usr/bin/env -S tsx

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CASIMIR_DP_EXPERIMENT_REPORT_VERSION,
  CasimirDpExperimentDesignConfig,
  type CasimirDpExperimentCandidate,
  type CasimirDpExperimentCandidateReport,
  type CasimirDpExperimentDesignReport,
  type CasimirDpExperimentGateStatus,
} from "../../shared/contracts/casimir-dp-experiment-design.v1";
import { computeDpCollapse, type TDpCollapseInput } from "../../shared/dp-collapse";

const HBAR_J_S = 1.054571817e-34;
const C_M_S = 299_792_458;

export const CASIMIR_DP_DESIGN_RUN_ORDER = [
  "freeze_design_protocol",
  "load_platform_candidates",
  "compute_ideal_casimir_references",
  "evaluate_material_and_geometry_authority",
  "compute_switching_disturbance_budget",
  "compute_standard_decoherence_budget",
  "compute_dp_branch_diagnostic",
  "apply_dp_experimental_bounds_gate",
  "apply_manifold_response_model_gate",
  "apply_collapse_identifiability_gate",
  "rank_engineering_readiness_only",
  "write_hashed_design_receipt",
] as const;

const stableJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const finiteOrNull = (value: number): number | null => (Number.isFinite(value) ? value : null);

function assertRunOrder(config: CasimirDpExperimentDesignConfig): void {
  if (config.run_order.length !== CASIMIR_DP_DESIGN_RUN_ORDER.length) {
    throw new Error("run_order does not match the experiment-design protocol");
  }
  CASIMIR_DP_DESIGN_RUN_ORDER.forEach((stage, index) => {
    if (config.run_order[index] !== stage) throw new Error(`run_order[${index}] must be ${stage}`);
  });
}

function idealCasimir(candidate: CasimirDpExperimentCandidate) {
  const { gap_m: gap, active_area_m2: area } = candidate.casimir;
  const hbarC = HBAR_J_S * C_M_S;
  const energyPerArea = -(Math.PI ** 2 * hbarC) / (720 * gap ** 3);
  const pressure = -(Math.PI ** 2 * hbarC) / (240 * gap ** 4);
  const force = pressure * area;
  const energy = energyPerArea * area;
  const forceMismatch = Math.abs(force) * candidate.casimir.branch_force_mismatch_fraction;
  const unmodeledPhase =
    (forceMismatch * candidate.superposition.branch_separation_m * candidate.superposition.observation_time_s) /
    HBAR_J_S;
  return {
    pressure_Pa: pressure,
    force_N: force,
    energy_J: energy,
    mass_equivalent_kg: energy / C_M_S ** 2,
    force_snr: Math.abs(force) / candidate.casimir.force_noise_N_rms,
    force_mismatch_N: forceMismatch,
    unmodeled_phase_rad: unmodeledPhase,
    trap_displacement_m:
      candidate.superposition.trap_stiffness_N_m == null
        ? null
        : forceMismatch / candidate.superposition.trap_stiffness_N_m,
    model_authority: "ideal_parallel_plate_reference_only" as const,
  };
}

function buildGaussianDpInput(candidate: CasimirDpExperimentCandidate): TDpCollapseInput | null {
  if (candidate.dp.mode !== "gaussian_proxy") return null;
  const separation = candidate.superposition.branch_separation_m;
  const halfSpan = separation / 2 + 4 * candidate.dp.sigma_m;
  const voxel = (2 * halfSpan) / candidate.dp.grid_dim;
  const dims: [number, number, number] = [candidate.dp.grid_dim, candidate.dp.grid_dim, candidate.dp.grid_dim];
  return {
    schema_version: "dp_collapse/1",
    ell_m: candidate.dp.ell_m,
    grid: {
      dims,
      voxel_size_m: [voxel, voxel, voxel],
      origin_m: [0, 0, 0],
    },
    branch_a: {
      kind: "analytic",
      label: `${candidate.id}-branch-a-gaussian-proxy`,
      primitives: [
        {
          kind: "gaussian",
          mass_kg: candidate.superposition.mass_kg,
          sigma_m: candidate.dp.sigma_m,
          center_m: [-separation / 2, 0, 0],
        },
      ],
    },
    branch_b: {
      kind: "analytic",
      label: `${candidate.id}-branch-b-gaussian-proxy`,
      primitives: [
        {
          kind: "gaussian",
          mass_kg: candidate.superposition.mass_kg,
          sigma_m: candidate.dp.sigma_m,
          center_m: [separation / 2, 0, 0],
        },
      ],
    },
    method: { kernel: "plummer", max_voxels: candidate.dp.max_voxels },
    notes: [
      "Experiment-design Gaussian proxy only; not a material-density branch receipt.",
      `Candidate: ${candidate.id}`,
    ],
  };
}

function evidenceBacked(value: string): boolean {
  return value === "measured" || value === "literature_anchored";
}

function candidateReport(
  candidate: CasimirDpExperimentCandidate,
  thresholds: CasimirDpExperimentDesignConfig["thresholds"],
): CasimirDpExperimentCandidateReport {
  const reference = idealCasimir(candidate);
  const contributions = Object.fromEntries(
    Object.entries(candidate.decoherence_rates).map(([key, value]) => [key, value.rate_s]),
  );
  const environmentRate = Object.values(candidate.decoherence_rates).reduce(
    (sum, term) => sum + term.rate_s,
    0,
  );
  const environmentVisibility = Math.exp(-environmentRate * candidate.superposition.observation_time_s);
  const allTermsReceiptBacked = Object.values(candidate.decoherence_rates).every((term) =>
    evidenceBacked(term.evidence_class),
  );

  const dpInput = buildGaussianDpInput(candidate);
  const dpResult = dpInput ? computeDpCollapse(dpInput) : null;
  const dpRate = dpResult && Number.isFinite(dpResult.tau_s) && dpResult.tau_s > 0 ? 1 / dpResult.tau_s : null;
  const dpRatio = dpRate == null || environmentRate <= 0 ? null : dpRate / environmentRate;

  const gates: Record<string, CasimirDpExperimentGateStatus> = {
    casimir_reference_detectable:
      reference.force_snr >= thresholds.minimum_casimir_force_snr ? "pass" : "not_ready",
    material_geometry_authority:
      candidate.casimir.material_model_status === "measured_dielectric" &&
      candidate.casimir.geometry_model_status === "converged_finite_geometry"
        ? "pass"
        : "not_ready",
    branch_force_symmetry:
      reference.unmodeled_phase_rad <= thresholds.maximum_unmodeled_phase_rad ? "pass" : "review",
    standard_decoherence_budget:
      environmentVisibility >= thresholds.minimum_environmental_visibility
        ? allTermsReceiptBacked
          ? "pass"
          : "review"
        : "not_ready",
    switching_disturbance:
      evidenceBacked(candidate.switching.evidence_class) ? "review" : "not_ready",
    dp_branch_resolution:
      dpResult == null
        ? "not_ready"
        : candidate.superposition.branch_provenance === "measured" && evidenceBacked(candidate.dp.evidence_class)
          ? "pass"
          : "review",
    dp_experimental_bounds: "review",
    manifold_response_model: "blocked",
    collapse_identifiability: "blocked",
  };

  const blockers = Object.entries(gates)
    .filter(([, status]) => status !== "pass")
    .map(([gate, status]) => `${gate}:${status}`);
  const evidenceTerms = [
    candidate.superposition.branch_provenance,
    candidate.switching.evidence_class,
    candidate.dp.evidence_class,
    ...Object.values(candidate.decoherence_rates).map((term) => term.evidence_class),
  ];
  const evidenceScore =
    evidenceTerms.filter((value) => evidenceBacked(value)).length / Math.max(evidenceTerms.length, 1);
  const forceScore = clamp01(reference.force_snr / thresholds.minimum_casimir_force_snr);
  const phaseScore = Math.exp(
    -reference.unmodeled_phase_rad / Math.max(thresholds.maximum_unmodeled_phase_rad, Number.EPSILON),
  );
  const visibilityScore = environmentVisibility;
  const dpScore = dpRatio == null ? 0 : clamp01(dpRatio / thresholds.minimum_dp_to_environment_rate_ratio);
  const engineeringIndex = Number(
    (0.2 * (forceScore + phaseScore + visibilityScore + dpScore + evidenceScore)).toFixed(6),
  );

  return {
    candidate_id: candidate.id,
    label: candidate.label,
    study_role: candidate.study_role,
    platform_class: candidate.platform_class,
    boundary_actuator: candidate.boundary_actuator,
    evidence_refs: [...candidate.evidence_refs],
    reference_casimir: reference,
    coherence: {
      environment_rate_s: environmentRate,
      environment_visibility: environmentVisibility,
      environment_coherence_window_s: environmentRate > 0 ? 1 / environmentRate : null,
      contributions_s: contributions,
      all_terms_receipt_backed: allTermsReceiptBacked,
    },
    dp: {
      status: dpResult ? "computed_gaussian_proxy" : "unresolved",
      rate_s: finiteOrNull(dpRate ?? Number.NaN),
      tau_s: finiteOrNull(dpResult?.tau_s ?? Number.NaN),
      dp_to_environment_rate_ratio: finiteOrNull(dpRatio ?? Number.NaN),
      evidence_class: candidate.dp.evidence_class,
      fail_reason: dpResult?.fail_reason ?? (candidate.dp.mode === "unresolved" ? candidate.dp.reason : null),
    },
    switching: {
      modulation_hz: candidate.switching.modulation_hz,
      dissipated_power_W: candidate.switching.dissipated_power_W,
      coupled_heat_W: candidate.switching.dissipated_power_W * candidate.switching.thermal_transfer_fraction,
      evidence_class: candidate.switching.evidence_class,
    },
    gates,
    blockers,
    engineering_screening_index: engineeringIndex,
    promotion_allowed: false,
  };
}

export function buildCasimirDpExperimentDesignReport(args: {
  config: CasimirDpExperimentDesignConfig;
  now?: Date;
}): CasimirDpExperimentDesignReport {
  assertRunOrder(args.config);
  const candidates = args.config.candidates.map((candidate) =>
    candidateReport(candidate, args.config.thresholds),
  );
  const ranking = [...candidates]
    .sort((left, right) => right.engineering_screening_index - left.engineering_screening_index)
    .map((candidate) => ({
      candidate_id: candidate.candidate_id,
      engineering_screening_index: candidate.engineering_screening_index,
      disposition: "design_candidate_only" as const,
    }));
  return {
    schema_version: CASIMIR_DP_EXPERIMENT_REPORT_VERSION,
    study_id: args.config.study_id,
    campaign_id: args.config.campaign_id,
    generated_at: (args.now ?? new Date()).toISOString(),
    evidence_cutoff: args.config.evidence_cutoff,
    claim_tier: "diagnostic",
    promotion_allowed: false,
    run_order: [...args.config.run_order],
    candidates,
    ranking,
    campaign_gates: {
      publication_grade_casimir_solver: "not_ready",
      measured_decoherence_budget: "not_ready",
      realistic_dp_branch_receipts: "not_ready",
      manifold_response_dynamics: "blocked",
      collapse_identifiability: "blocked",
    },
    claim_boundaries: [
      "The engineering screening index is not a physics-evidence score or platform selection.",
      "Ideal parallel-plate Casimir rows are reference values, not finite-geometry apparatus predictions.",
      "Gaussian DP rows are diagnostic proxies and do not replace measured material-density branches.",
      "No manifold-response or boundary-conditioned objective-collapse rate is computed.",
      "Visibility loss cannot be identified with collapse without a dynamics-level secondary observable.",
      "No candidate is promoted above diagnostic design status.",
    ],
  };
}

function formatNumber(value: number | null): string {
  if (value == null) return "unresolved";
  if (value === 0) return "0";
  return Math.abs(value) >= 1e3 || Math.abs(value) < 1e-3 ? value.toExponential(3) : value.toFixed(4);
}

export function renderCasimirDpExperimentDesignMarkdown(report: CasimirDpExperimentDesignReport): string {
  const rows = report.ranking.map((rank) => {
    const candidate = report.candidates.find((entry) => entry.candidate_id === rank.candidate_id)!;
    return `| ${candidate.label} | ${rank.engineering_screening_index.toFixed(3)} | ${formatNumber(candidate.reference_casimir.force_snr)} | ${formatNumber(candidate.reference_casimir.unmodeled_phase_rad)} | ${candidate.coherence.environment_visibility.toFixed(3)} | ${formatNumber(candidate.dp.tau_s)} | ${candidate.blockers.length} |`;
  });
  const candidateSections = report.candidates.map((candidate) => {
    const gates = Object.entries(candidate.gates)
      .map(([gate, status]) => `- \`${gate}\`: \`${status}\``)
      .join("\n");
    const refs = candidate.evidence_refs.map((ref) => `- ${ref}`).join("\n");
    return `## ${candidate.label}\n\n- Study role: \`${candidate.study_role}\`\n- Platform: \`${candidate.platform_class}\`\n- Boundary actuator: \`${candidate.boundary_actuator}\`\n- Engineering screening index: \`${candidate.engineering_screening_index}\`\n- Ideal-reference force: \`${formatNumber(candidate.reference_casimir.force_N)} N\`\n- Residual force phase: \`${formatNumber(candidate.reference_casimir.unmodeled_phase_rad)} rad\`\n- Environmental visibility: \`${candidate.coherence.environment_visibility.toFixed(6)}\`\n- DP status / tau: \`${candidate.dp.status}\` / \`${formatNumber(candidate.dp.tau_s)} s\`\n- Promotion allowed: \`false\`\n\n### Gates\n\n${gates}\n\n### Evidence anchors\n\n${refs}`;
  });
  return `# Casimir–DP Manifold-Response Experiment Design Report\n\n**Campaign:** \`${report.campaign_id}\`  \n**Generated:** ${report.generated_at}  \n**Evidence cutoff:** ${report.evidence_cutoff}  \n**Claim tier:** diagnostic  \n**Promotion allowed:** false\n\nThis report compares engineering readiness only. It does not select a physically viable experiment or compute a manifold-induced collapse rate.\n\n## Comparison\n\n| Candidate | Engineering index | Ideal force SNR | Unmodeled phase (rad) | Environmental visibility | DP tau (s) | Open blockers |\n|---|---:|---:|---:|---:|---:|---:|\n${rows.join("\n")}\n\n## Campaign gates\n\n${Object.entries(report.campaign_gates).map(([gate, status]) => `- \`${gate}\`: \`${status}\``).join("\n")}\n\n${candidateSections.join("\n\n")}\n\n## Claim boundaries\n\n${report.claim_boundaries.map((note) => `- ${note}`).join("\n")}\n`;
}

type CliArgs = { configPath: string; outRoot: string | null; reportDoc: string | null };

function parseArgs(argv: string[]): CliArgs {
  let configPath = "configs/research/casimir-dp-experiment-design.v1.json";
  let outRoot: string | null = null;
  let reportDoc: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1] ?? "";
    if (arg === "--config") configPath = value;
    else if (arg === "--out") outRoot = value;
    else if (arg === "--report-doc") reportDoc = value;
    else throw new Error(`Unknown argument: ${arg}`);
    index += 1;
  }
  if (!configPath.trim()) throw new Error("--config requires a path");
  if (outRoot !== null && !outRoot.trim()) throw new Error("--out requires a path");
  if (reportDoc !== null && !reportDoc.trim()) throw new Error("--report-doc requires a path");
  return { configPath, outRoot, reportDoc };
}

export async function runCasimirDpExperimentDesign(args: {
  configPath: string;
  outRoot?: string | null;
  reportDoc?: string | null;
  now?: Date;
}) {
  const configPath = path.resolve(args.configPath);
  const configText = await readFile(configPath, "utf8");
  const config = CasimirDpExperimentDesignConfig.parse(JSON.parse(configText));
  const now = args.now ?? new Date();
  const report = buildCasimirDpExperimentDesignReport({ config, now });
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const outDir = path.resolve(
    args.outRoot ?? path.join("artifacts", "research", "casimir-dp-experiment-design", `${config.campaign_id}-${timestamp}`),
  );
  await mkdir(outDir, { recursive: true });
  const reportJson = stableJson(report);
  const reportMarkdown = renderCasimirDpExperimentDesignMarkdown(report).replace(
    / {2}\n/g,
    "<br>\n",
  );
  const reportJsonPath = path.join(outDir, "experiment-design-report.json");
  const reportMarkdownPath = path.join(outDir, "experiment-design-report.md");
  await writeFile(reportJsonPath, reportJson, "utf8");
  await writeFile(reportMarkdownPath, reportMarkdown, "utf8");
  const receipt = {
    schema_version: "casimir_dp_experiment_design_receipt/1",
    campaign_id: config.campaign_id,
    generated_at: now.toISOString(),
    status: "completed",
    disposition: "diagnostic_design_only",
    promotion_allowed: false,
    input: { path: path.relative(process.cwd(), configPath).replace(/\\/g, "/"), sha256: sha256(configText) },
    outputs: [
      { path: "experiment-design-report.json", sha256: sha256(reportJson) },
      { path: "experiment-design-report.md", sha256: sha256(reportMarkdown) },
    ],
    campaign_gates: report.campaign_gates,
  };
  const receiptPath = path.join(outDir, "experiment-design-receipt.json");
  await writeFile(receiptPath, stableJson(receipt), "utf8");
  if (args.reportDoc) {
    const reportDoc = path.resolve(args.reportDoc);
    await mkdir(path.dirname(reportDoc), { recursive: true });
    await writeFile(reportDoc, reportMarkdown, "utf8");
  }
  return { outDir, reportJsonPath, reportMarkdownPath, receiptPath, report };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  runCasimirDpExperimentDesign({
    configPath: args.configPath,
    outRoot: args.outRoot,
    reportDoc: args.reportDoc,
  })
    .then((result) => {
      process.stdout.write(
        stableJson({
          status: "completed",
          outDir: result.outDir,
          receiptPath: result.receiptPath,
          ranking: result.report.ranking,
        }),
      );
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
