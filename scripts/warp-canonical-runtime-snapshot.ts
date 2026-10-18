import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_URL = "http://127.0.0.1:5173/api/helix/pipeline/proofs";

const parseArgs = () => {
  const args = process.argv.slice(2);
  const out: { url?: string; outPath?: string } = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--url") {
      out.url = args[i + 1];
      i += 1;
    } else if (token === "--out") {
      out.outPath = args[i + 1];
      i += 1;
    }
  }
  return out;
};

const getVal = (pack: any, key: string) => {
  const entry = pack?.values?.[key];
  if (entry && typeof entry === "object" && "value" in entry) return entry;
  return { value: undefined, proxy: true, source: "missing" };
};

const renderRow = (label: string, entry: any) =>
  `| ${label} | ${entry?.value ?? "n/a"} | ${entry?.source ?? "n/a"} | ${entry?.proxy ? "proxy" : "metric"} |`;

const renderSection = (title: string, rows: Array<[string, any]>) => {
  const lines = [
    `## ${title}`,
    "| Signal | Value | Source | Proxy |",
    "| --- | --- | --- | --- |",
    ...rows.map(([label, entry]) => renderRow(label, entry)),
    "",
  ];
  return lines.join("\n");
};

async function main() {
  const { url, outPath } = parseArgs();
  const proofUrl = url ?? process.env.WARP_PROOF_PACK_URL ?? DEFAULT_URL;
  const response = await fetch(proofUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch proof pack (${response.status})`);
  }
  const pack = await response.json();

  const keys = {
    canonical: [
      "warp_canonical_family",
      "warp_canonical_chart",
      "warp_canonical_observer",
      "warp_canonical_normalization",
      "warp_canonical_unit_system",
      "warp_canonical_match",
    ],
    metricContract: [
      "metric_t00_family",
      "metric_t00_chart",
      "metric_t00_observer",
      "metric_t00_normalization",
      "metric_t00_unit_system",
      "metric_t00_contract_status",
      "metric_t00_contract_reason",
      "metric_t00_contract_ok",
      "metric_chart_contract_status",
      "metric_chart_contract_reason",
      "metric_chart_notes",
      "metric_coordinate_map",
    ],
    metricSolves: [
      "metric_t00_rho_geom_mean",
      "metric_t00_rho_si_mean",
      "metric_t00_sample_count",
      "metric_t00_step_m",
      "metric_t00_scale_m",
      "metric_k_trace_mean",
      "metric_k_sq_mean",
      "gr_rho_constraint_mean",
      "gr_rho_constraint_rms",
      "gr_rho_constraint_max_abs",
      "gr_cl3_rho_delta_mean",
      "gr_cl3_rho_delta_metric_mean",
      "gr_cl3_rho_delta_pipeline_mean",
      "gr_cl3_rho_delta_pipeline_mean_telemetry",
      "gr_cl3_rho_gate",
      "gr_cl3_rho_gate_source",
      "gr_cl3_rho_gate_reason",
    ],
    theta: [
      "theta_geom",
      "theta_metric_derived",
      "theta_metric_source",
      "theta_metric_reason",
      "theta_strict_mode",
      "theta_strict_ok",
      "theta_strict_reason",
      "theta_raw",
      "theta_cal",
      "theta_proxy",
      "theta_pipeline_raw",
      "theta_pipeline_cal",
      "theta_pipeline_proxy",
    ],
    qi: [
      "qi_rho_source",
      "qi_metric_derived",
      "qi_metric_source",
      "qi_metric_reason",
      "qi_strict_mode",
      "qi_strict_ok",
      "qi_strict_reason",
    ],
    ts: [
      "ts_ratio",
      "ts_metric_derived",
      "ts_metric_source",
      "ts_metric_reason",
    ],
    vdb: [
      "vdb_region_ii_derivative_support",
      "vdb_region_iv_derivative_support",
      "vdb_two_wall_derivative_support",
      "vdb_region_ii_t00_mean",
      "vdb_region_ii_t00_min",
      "vdb_region_ii_t00_max",
      "vdb_region_iv_t00_mean",
      "vdb_region_iv_t00_min",
      "vdb_region_iv_t00_max",
      "vdb_region_ii_bprime_max_abs",
      "vdb_region_ii_bdouble_max_abs",
      "vdb_region_iv_dfdr_max_abs",
      "vdb_region_iv_dfdr_rms",
      "vdb_region_iv_k_trace_mean",
      "vdb_region_iv_k_squared_mean",
    ],
    materials: [
      "mechanical_safety_min",
      "mechanical_note",
      "vdb_admissible",
      "vdb_planck_margin",
      "vdb_pocket_radius_m",
      "vdb_pocket_thickness_m",
    ],
  };

  const sections = [
    { title: "Canonical Contract", keys: keys.canonical },
    { title: "Metric Contract", keys: keys.metricContract },
    { title: "Metric and Constraint Solves", keys: keys.metricSolves },
    { title: "Theta (Expansion) Guardrails", keys: keys.theta },
    { title: "QI Guardrails", keys: keys.qi },
    { title: "Time-Scale (TS) Guardrails", keys: keys.ts },
    { title: "VdB Derivative Diagnostics", keys: keys.vdb },
    { title: "Material and Mechanical Constraints", keys: keys.materials },
  ];

  const proxyKeys: string[] = [];
  for (const group of Object.values(keys)) {
    for (const key of group) {
      const entry = getVal(pack, key);
      if (entry?.proxy) proxyKeys.push(key);
    }
  }

  const displayUrl = proofUrl.replace(/http:\/\/127\.0\.0\.1:\d+/g, "http://localhost:PORT");
  const header = `# Warp Canonical Runtime Overview\n\n` +
    `Generated: ${new Date().toISOString()}\n\n` +
    `Source: ${displayUrl}\n\n` +
    `This report is a live snapshot of canonical runtime values and guardrails.\n` +
    `Values marked as \"proxy\" are not geometry-derived.\n\n`;

  const body = sections
    .map((section) => renderSection(section.title, section.keys.map((k) => [k, getVal(pack, k)])))
    .join("\n");

  const proxySection = `## Proxy Summary\n` +
    `The following canonical keys are still proxy in this snapshot:\n\n` +
    (proxyKeys.length ? proxyKeys.sort().map((k) => `- ${k}`).join("\n") : "- none") +
    "\n";

  const refresh = `## Refresh\n` +
    `Regenerate this snapshot from the running server:\n\n` +
    "```bash\n" +
    "npx tsx scripts/warp-canonical-runtime-snapshot.ts --url http://localhost:PORT/api/helix/pipeline/proofs --out docs/warp-canonical-runtime-overview.md\n" +
    "```\n";

  const out = header + body + proxySection + "\n" + refresh;

  const outputPath = outPath ?? path.join("docs", "warp-canonical-runtime-overview.md");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, out, "utf-8");
  console.log(`Wrote ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
