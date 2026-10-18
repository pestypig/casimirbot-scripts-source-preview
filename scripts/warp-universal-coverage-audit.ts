import fs from "node:fs/promises";
import path from "node:path";

type AuditArgs = {
  proofPackPath?: string;
  url?: string;
  outPath?: string;
};

const DEFAULT_URL = "http://localhost:3000/api/helix/pipeline/proofs";

const parseArgs = (): AuditArgs => {
  const args = process.argv.slice(2);
  const out: AuditArgs = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--proof-pack") {
      out.proofPackPath = args[i + 1];
      i += 1;
    } else if (token === "--url") {
      out.url = args[i + 1];
      i += 1;
    } else if (token === "--out") {
      out.outPath = args[i + 1];
      i += 1;
    }
  }
  return out;
};

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null;

const readPackValue = (pack: any, key: string): any => {
  if (isRecord(pack?.values) && isRecord(pack.values[key])) {
    return pack.values[key].value;
  }
  if (isRecord(pack?.pipeline) && key in pack.pipeline) {
    return pack.pipeline[key];
  }
  return pack?.[key];
};

const readString = (pack: any, key: string): string | undefined => {
  const raw = readPackValue(pack, key);
  if (typeof raw === "string") return raw;
  if (raw == null) return undefined;
  return String(raw);
};

const readNumber = (pack: any, key: string): number | undefined => {
  const raw = readPackValue(pack, key);
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const readBool = (pack: any, key: string): boolean | undefined => {
  const raw = readPackValue(pack, key);
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    if (raw === "true") return true;
    if (raw === "false") return false;
  }
  return undefined;
};

const parseMissingParts = (pack: any): string[] => {
  const raw = readPackValue(pack, "congruence_missing_parts");
  if (Array.isArray(raw)) {
    return raw.map((part) => String(part).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [];
};

const remediationMap: Record<string, string> = {
  missing_metric_t00: "Ensure metric-derived T00 is emitted for the active chart/family.",
  missing_metric_contract: "Populate metric T00 contract fields (observer/normalization/unit system).",
  missing_chart_contract: "Fix metric adapter chart contract status to ok.",
  missing_theta_geom: "Provide metric-adapter divergence diagnostics (theta_geom).",
  missing_rho_constraint: "Compute GR constraint rho from metric diagnostics.",
  missing_vdb_region_ii_derivatives:
    "Compute VdB region II derivatives (B', B'') on all active surfaces.",
  missing_vdb_region_iv_derivatives:
    "Compute VdB region IV derivatives (df/dr) on all active surfaces.",
  missing_vdb_two_wall_derivatives:
    "Ensure both region II and IV derivatives are available when gammaVdB > 1.",
};

const buildReport = (pack: any, source: string) => {
  const missingParts = parseMissingParts(pack);
  const missingCount =
    readNumber(pack, "congruence_missing_count") ?? missingParts.length;
  const missingReason =
    readString(pack, "congruence_missing_reason") ??
    (missingParts.length ? missingParts[0] : undefined);

  const report = {
    createdAt: new Date().toISOString(),
    source,
    summary: {
      missingCount,
      missingReason: missingReason ?? null,
      missingParts,
    },
    metric: {
      chart: readString(pack, "metric_t00_chart") ?? readString(pack, "metric_chart_label"),
      family: readString(pack, "metric_t00_family"),
      observer: readString(pack, "metric_t00_observer"),
      normalization: readString(pack, "metric_t00_normalization"),
      unitSystem: readString(pack, "metric_t00_unit_system"),
      contractStatus: readString(pack, "metric_t00_contract_status"),
      contractReason: readString(pack, "metric_t00_contract_reason"),
      chartContractStatus: readString(pack, "metric_chart_contract_status"),
      chartContractReason: readString(pack, "metric_chart_contract_reason"),
    },
    cl3: {
      rhoConstraintMean: readNumber(pack, "gr_rho_constraint_mean"),
      rhoConstraintSource: readString(pack, "gr_rho_constraint_source"),
      deltaMean: readNumber(pack, "gr_cl3_rho_delta_mean"),
      deltaMetricMean: readNumber(pack, "gr_cl3_rho_delta_metric_mean"),
      deltaPipelineMean: readNumber(pack, "gr_cl3_rho_delta_pipeline_mean"),
      gate: readBool(pack, "gr_cl3_rho_gate"),
      gateSource: readString(pack, "gr_cl3_rho_gate_source"),
      gateReason: readString(pack, "gr_cl3_rho_gate_reason"),
      missingParts: readString(pack, "gr_cl3_rho_missing_parts"),
    },
    vdb: {
      regionIISupport: readBool(pack, "vdb_region_ii_derivative_support"),
      regionIVSupport: readBool(pack, "vdb_region_iv_derivative_support"),
      twoWallSupport: readBool(pack, "vdb_two_wall_derivative_support"),
    },
    remediation: missingParts.map((part) => ({
      part,
      action: remediationMap[part] ?? "Investigate adapter or chart coverage for this surface.",
    })),
  };
  return report;
};

const renderMarkdown = (report: ReturnType<typeof buildReport>): string => {
  const { summary, metric, cl3, vdb, remediation } = report;
  const missingList = summary.missingParts.length
    ? summary.missingParts.map((part) => `- ${part}`).join("\n")
    : "- none";
  const remediationList = remediation.length
    ? remediation.map((item) => `- ${item.part}: ${item.action}`).join("\n")
    : "- none";
  return `# Warp Universal Coverage Audit

Generated: ${report.createdAt}

## Summary
- missing_count: ${summary.missingCount}
- missing_reason: ${summary.missingReason ?? "none"}

## Missing Parts
${missingList}

## Metric Contract
- chart: ${metric.chart ?? "n/a"}
- family: ${metric.family ?? "n/a"}
- observer: ${metric.observer ?? "n/a"}
- normalization: ${metric.normalization ?? "n/a"}
- unit_system: ${metric.unitSystem ?? "n/a"}
- contract_status: ${metric.contractStatus ?? "n/a"}
- contract_reason: ${metric.contractReason ?? "n/a"}
- chart_contract_status: ${metric.chartContractStatus ?? "n/a"}
- chart_contract_reason: ${metric.chartContractReason ?? "n/a"}

## CL3 Delta
- rho_constraint_mean: ${cl3.rhoConstraintMean ?? "n/a"}
- rho_constraint_source: ${cl3.rhoConstraintSource ?? "n/a"}
- delta_mean: ${cl3.deltaMean ?? "n/a"}
- delta_metric_mean: ${cl3.deltaMetricMean ?? "n/a"}
- delta_pipeline_mean: ${cl3.deltaPipelineMean ?? "n/a"}
- gate: ${cl3.gate == null ? "n/a" : String(cl3.gate)}
- gate_source: ${cl3.gateSource ?? "n/a"}
- gate_reason: ${cl3.gateReason ?? "n/a"}
- missing_parts: ${cl3.missingParts ?? "none"}

## VdB Derivative Support
- region_ii: ${vdb.regionIISupport == null ? "n/a" : String(vdb.regionIISupport)}
- region_iv: ${vdb.regionIVSupport == null ? "n/a" : String(vdb.regionIVSupport)}
- two_wall: ${vdb.twoWallSupport == null ? "n/a" : String(vdb.twoWallSupport)}

## Remediation Suggestions
${remediationList}
`;
};

const writeReport = async (report: ReturnType<typeof buildReport>, outPath?: string) => {
  const outputPath =
    outPath ?? path.join("reports", "warp-universal-coverage-audit.json");
  const mdPath =
    outputPath.endsWith(".json") ? outputPath.replace(/\.json$/, ".md") : `${outputPath}.md`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf-8");
  await fs.writeFile(mdPath, renderMarkdown(report), "utf-8");
  return { outputPath, mdPath };
};

const loadProofPack = async (args: AuditArgs): Promise<{ pack: any; source: string }> => {
  if (args.proofPackPath) {
    const raw = await fs.readFile(args.proofPackPath, "utf-8");
    return { pack: JSON.parse(raw), source: `file:${args.proofPackPath}` };
  }
  const url = args.url ?? process.env.WARP_PROOF_PACK_URL ?? DEFAULT_URL;
  if (globalThis.fetch) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch proof pack (${response.status})`);
    }
    const pack = await response.json();
    return { pack, source: `url:${url}` };
  }
  throw new Error("No proof pack source available. Use --proof-pack <path>.");
};

async function main() {
  const args = parseArgs();
  const { pack, source } = await loadProofPack(args);
  const report = buildReport(pack, source);
  const { outputPath, mdPath } = await writeReport(report, args.outPath);
  // eslint-disable-next-line no-console
  console.log(`Warp universal coverage audit written to ${outputPath}`);
  // eslint-disable-next-line no-console
  console.log(`Warp universal coverage audit written to ${mdPath}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
