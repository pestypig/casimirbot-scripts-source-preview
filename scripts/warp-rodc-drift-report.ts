import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  computeWarpRodcChecksum,
  WARP_RODC_DRIFT_REPORT_SCHEMA_VERSION,
  type WarpRodcDistanceDriftV1,
  type WarpRodcDriftReportV1,
  type WarpRodcFeatureDriftV1,
  type WarpRodcFeatureValue,
  type WarpRodcSnapshotV1,
} from "../shared/warp-rodc-contract";

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const FULL_SOLVE_DIR = path.join("artifacts", "research", "full-solve");
const DOC_AUDIT_DIR = path.join("docs", "audits", "research");
const DEFAULT_LATEST_ARTIFACT = path.join(
  FULL_SOLVE_DIR,
  "warp-york-control-family-rodc-latest.json",
);
const DEFAULT_OUT_JSON = path.join(FULL_SOLVE_DIR, `warp-rodc-drift-${DATE_STAMP}.json`);
const DEFAULT_LATEST_JSON = path.join(FULL_SOLVE_DIR, "warp-rodc-drift-latest.json");
const DEFAULT_OUT_MD = path.join(DOC_AUDIT_DIR, `warp-rodc-drift-${DATE_STAMP}.md`);
const DEFAULT_LATEST_MD = path.join(DOC_AUDIT_DIR, "warp-rodc-drift-latest.md");
const BOUNDARY_STATEMENT =
  "This drift report checks reduced-order congruence artifacts for contract, feature, distance, and provenance drift; it is not a physical warp feasibility claim.";
const NUMERIC_EPS = 1e-12;

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes("=")) return argv[index].split("=", 2)[1];
  return argv[index + 1];
};

const normalizePath = (filePath: string): string => filePath.replace(/\\/g, "/");

const ensureDirForFile = (filePath: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const toArtifactRefPath = (filePath: string): string => {
  const absolutePath = path.resolve(filePath);
  const relativePath = path.relative(process.cwd(), absolutePath);
  if (
    relativePath.length > 0 &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  ) {
    return normalizePath(relativePath);
  }
  return normalizePath(absolutePath);
};

const asNumber = (value: WarpRodcFeatureValue | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const sameFeatureValue = (left: WarpRodcFeatureValue | undefined, right: WarpRodcFeatureValue | undefined): boolean => {
  const leftNumber = asNumber(left);
  const rightNumber = asNumber(right);
  if (leftNumber != null || rightNumber != null) {
    if (leftNumber == null || rightNumber == null) return false;
    return Math.abs(leftNumber - rightNumber) <= NUMERIC_EPS;
  }
  return left === right;
};

const buildFeatureDriftRows = (
  latest: Record<string, WarpRodcFeatureValue>,
  previous: Record<string, WarpRodcFeatureValue>,
): WarpRodcFeatureDriftV1[] => {
  const keys = Array.from(new Set([...Object.keys(latest), ...Object.keys(previous)])).sort((a, b) =>
    a.localeCompare(b),
  );
  return keys.map((key) => {
    const latestValue = latest[key] ?? null;
    const previousValue = previous[key] ?? null;
    const latestNumber = asNumber(latestValue);
    const previousNumber = asNumber(previousValue);
    return {
      key,
      latest: latestValue,
      previous: previousValue,
      changed: !sameFeatureValue(latestValue, previousValue),
      delta:
        latestNumber != null && previousNumber != null
          ? latestNumber - previousNumber
          : null,
    };
  });
};

const buildDistanceDriftRows = (
  latest: WarpRodcSnapshotV1["distance"],
  previous: WarpRodcSnapshotV1["distance"],
): WarpRodcDistanceDriftV1[] => {
  const latestValues: Record<string, number | null> = {
    to_alcubierre: latest.to_alcubierre,
    to_natario: latest.to_natario,
    ...(latest.to_other_baselines ?? {}),
  };
  const previousValues: Record<string, number | null> = {
    to_alcubierre: previous.to_alcubierre,
    to_natario: previous.to_natario,
    ...(previous.to_other_baselines ?? {}),
  };
  const keys = Array.from(new Set([...Object.keys(latestValues), ...Object.keys(previousValues)])).sort((a, b) =>
    a.localeCompare(b),
  );
  return keys.map((key) => {
    const latestValue = latestValues[key] ?? null;
    const previousValue = previousValues[key] ?? null;
    const changed =
      latestValue == null || previousValue == null
        ? latestValue !== previousValue
        : Math.abs(latestValue - previousValue) > NUMERIC_EPS;
    return {
      key,
      latest: latestValue,
      previous: previousValue,
      delta:
        latestValue != null && previousValue != null
          ? latestValue - previousValue
          : null,
      changed,
    };
  });
};

const buildEvidenceHashChanges = (
  latest: WarpRodcSnapshotV1["evidence_hashes"],
  previous: WarpRodcSnapshotV1["evidence_hashes"],
): Record<string, { latest: string | null; previous: string | null; changed: boolean }> => {
  const result: Record<string, { latest: string | null; previous: string | null; changed: boolean }> = {
    metric_ref_hash: {
      latest: latest.metric_ref_hash,
      previous: previous.metric_ref_hash,
      changed: latest.metric_ref_hash !== previous.metric_ref_hash,
    },
    theta_channel_hash: {
      latest: latest.theta_channel_hash,
      previous: previous.theta_channel_hash,
      changed: latest.theta_channel_hash !== previous.theta_channel_hash,
    },
    k_trace_hash: {
      latest: latest.k_trace_hash,
      previous: previous.k_trace_hash,
      changed: latest.k_trace_hash !== previous.k_trace_hash,
    },
  };
  const sliceKeys = Array.from(
    new Set([
      ...Object.keys(latest.slice_hashes_by_view ?? {}),
      ...Object.keys(previous.slice_hashes_by_view ?? {}),
    ]),
  ).sort((a, b) => a.localeCompare(b));
  for (const key of sliceKeys) {
    const latestValue = latest.slice_hashes_by_view[key] ?? null;
    const previousValue = previous.slice_hashes_by_view[key] ?? null;
    result[`slice:${key}`] = {
      latest: latestValue,
      previous: previousValue,
      changed: latestValue !== previousValue,
    };
  }
  const otherKeys = Array.from(
    new Set([
      ...Object.keys(latest.other_hashes ?? {}),
      ...Object.keys(previous.other_hashes ?? {}),
    ]),
  ).sort((a, b) => a.localeCompare(b));
  for (const key of otherKeys) {
    const latestValue = latest.other_hashes?.[key] ?? null;
    const previousValue = previous.other_hashes?.[key] ?? null;
    result[`other:${key}`] = {
      latest: latestValue,
      previous: previousValue,
      changed: latestValue !== previousValue,
    };
  }
  return result;
};

export const buildWarpRodcDriftReport = (args: {
  latestArtifact: WarpRodcSnapshotV1;
  previousArtifact: WarpRodcSnapshotV1 | null;
  latestArtifactPath: string;
  previousArtifactPath: string | null;
}): WarpRodcDriftReportV1 => {
  const latest = args.latestArtifact;
  const previous = args.previousArtifact;
  const featureRows = buildFeatureDriftRows(
    latest.feature_vector,
    previous?.feature_vector ?? {},
  );
  const distanceRows = buildDistanceDriftRows(
    latest.distance,
    previous?.distance ?? {
      to_alcubierre: null,
      to_natario: null,
    },
  );
  const evidenceHashChanges = buildEvidenceHashChanges(
    latest.evidence_hashes,
    previous?.evidence_hashes ?? {
      metric_ref_hash: null,
      theta_channel_hash: null,
      k_trace_hash: null,
      slice_hashes_by_view: {},
      other_hashes: {},
    },
  );
  const contractChanged = previous
    ? JSON.stringify(latest.contract) !== JSON.stringify(previous.contract)
    : false;
  const verdictChanged = previous
    ? JSON.stringify(latest.verdict) !== JSON.stringify(previous.verdict)
    : false;
  const featureChanges = featureRows.filter((row) => row.changed).length;
  const distanceChanges = distanceRows.filter((row) => row.changed).length;
  const hashChanges = Object.values(evidenceHashChanges).filter((row) => row.changed).length;

  const summary =
    previous == null
      ? {
          status: "inconclusive" as const,
          note: "previous reduced-order artifact not available; drift cannot be evaluated",
        }
      : contractChanged
        ? {
            status: "contract_drift" as const,
            note: "contract identity changed between artifacts; verdict drift is not directly comparable",
          }
        : verdictChanged || featureChanges > 0 || distanceChanges > 0 || hashChanges > 0
          ? {
              status: "drifted" as const,
              note: "feature, distance, verdict, or evidence-hash drift detected",
            }
          : {
              status: "stable" as const,
              note: "no reduced-order drift detected beyond numeric tolerance",
            };

  const payloadBase: WarpRodcDriftReportV1 = {
    artifactType: WARP_RODC_DRIFT_REPORT_SCHEMA_VERSION,
    generatedOn: DATE_STAMP,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    family: latest.artifactFamily,
    latestArtifactPath: normalizePath(args.latestArtifactPath),
    previousArtifactPath: args.previousArtifactPath
      ? normalizePath(args.previousArtifactPath)
      : null,
    latestChecksum: latest.checksum ?? null,
    previousChecksum: previous?.checksum ?? null,
    contract: {
      latest: latest.contract,
      previous: previous?.contract ?? null,
      changed: contractChanged,
    },
    verdict: {
      latest: latest.verdict,
      previous: previous?.verdict ?? null,
      changed: verdictChanged,
    },
    featureDrift: {
      totalChanged: featureChanges,
      rows: featureRows,
    },
    distanceDrift: {
      totalChanged: distanceChanges,
      rows: distanceRows,
    },
    evidenceHashChanges,
    summary,
  };
  return {
    ...payloadBase,
    checksum: computeWarpRodcChecksum(payloadBase as unknown as Record<string, unknown>),
  };
};

const renderMarkdown = (report: WarpRodcDriftReportV1): string => {
  const featureRows = report.featureDrift.rows
    .map(
      (row) =>
        `| ${row.key} | ${String(row.previous)} | ${String(row.latest)} | ${row.delta ?? "null"} | ${row.changed} |`,
    )
    .join("\n");
  const distanceRows = report.distanceDrift.rows
    .map(
      (row) =>
        `| ${row.key} | ${row.previous ?? "null"} | ${row.latest ?? "null"} | ${row.delta ?? "null"} | ${row.changed} |`,
    )
    .join("\n");
  const hashRows = Object.entries(report.evidenceHashChanges)
    .map(
      ([key, value]) =>
        `| ${key} | ${value.previous ?? "null"} | ${value.latest ?? "null"} | ${value.changed} |`,
    )
    .join("\n");
  return `# Warp RODC Drift Report

## Boundary
${report.boundaryStatement}

## Summary
- family: \`${report.family}\`
- status: \`${report.summary.status}\`
- note: ${report.summary.note}
- latest artifact: \`${report.latestArtifactPath}\`
- previous artifact: \`${report.previousArtifactPath ?? "null"}\`

## Contract
| field | previous | latest | changed |
|---|---|---|---|
| id | ${report.contract.previous?.id ?? "null"} | ${report.contract.latest?.id ?? "null"} | ${report.contract.changed} |
| version | ${report.contract.previous?.version ?? "null"} | ${report.contract.latest?.version ?? "null"} | ${report.contract.changed} |
| lane_id | ${report.contract.previous?.lane_id ?? "null"} | ${report.contract.latest?.lane_id ?? "null"} | ${report.contract.changed} |

## Verdict
| field | previous | latest | changed |
|---|---|---|---|
| family_label | ${report.verdict.previous?.family_label ?? "null"} | ${report.verdict.latest?.family_label ?? "null"} | ${report.verdict.changed} |
| status | ${report.verdict.previous?.status ?? "null"} | ${report.verdict.latest?.status ?? "null"} | ${report.verdict.changed} |
| stability | ${report.verdict.previous?.stability ?? "null"} | ${report.verdict.latest?.stability ?? "null"} | ${report.verdict.changed} |

## Feature Drift
| feature | previous | latest | delta | changed |
|---|---|---|---|---|
${featureRows || "| none | null | null | null | false |"}

## Distance Drift
| distance | previous | latest | delta | changed |
|---|---|---|---|---|
${distanceRows || "| none | null | null | null | false |"}

## Evidence Hash Changes
| key | previous | latest | changed |
|---|---|---|---|
${hashRows || "| none | null | null | false |"}
`;
};

const readArtifact = (artifactPath: string): WarpRodcSnapshotV1 =>
  JSON.parse(fs.readFileSync(artifactPath, "utf8")) as WarpRodcSnapshotV1;

const findPreviousArtifact = (latestPath: string): string | null => {
  const latestDir = path.dirname(latestPath);
  const latestBase = path.basename(latestPath);
  const latestRaw = fs.readFileSync(latestPath, "utf8").trim();
  const familyPrefix = latestBase.endsWith("-latest.json")
    ? latestBase.slice(0, -"latest.json".length)
    : null;
  const candidates = fs
    .readdirSync(latestDir)
    .filter((entry) => entry.endsWith(".json"))
    .filter((entry) => entry !== latestBase)
    .filter((entry) => (familyPrefix ? entry.startsWith(familyPrefix) : entry.includes("-rodc-")))
    .sort((a, b) => b.localeCompare(a));
  for (const candidate of candidates) {
    const candidatePath = path.join(latestDir, candidate);
    const candidateRaw = fs.readFileSync(candidatePath, "utf8").trim();
    if (candidateRaw !== latestRaw) {
      return candidatePath;
    }
  }
  return null;
};

export const runWarpRodcDriftReport = (options?: {
  latestArtifactPath?: string;
  previousArtifactPath?: string | null;
  outJsonPath?: string;
  latestJsonPath?: string;
  outMdPath?: string;
  latestMdPath?: string;
}) => {
  const latestArtifactPath = path.resolve(
    options?.latestArtifactPath ?? DEFAULT_LATEST_ARTIFACT,
  );
  const previousArtifactPath =
    options?.previousArtifactPath === undefined
      ? findPreviousArtifact(latestArtifactPath)
      : options.previousArtifactPath
        ? path.resolve(options.previousArtifactPath)
        : null;
  const outJsonPath = options?.outJsonPath ?? DEFAULT_OUT_JSON;
  const latestJsonPath = options?.latestJsonPath ?? DEFAULT_LATEST_JSON;
  const outMdPath = options?.outMdPath ?? DEFAULT_OUT_MD;
  const latestMdPath = options?.latestMdPath ?? DEFAULT_LATEST_MD;

  const latestArtifact = readArtifact(latestArtifactPath);
  const previousArtifact =
    previousArtifactPath && fs.existsSync(previousArtifactPath)
      ? readArtifact(previousArtifactPath)
      : null;
  const report = buildWarpRodcDriftReport({
    latestArtifact,
    previousArtifact,
    latestArtifactPath: toArtifactRefPath(latestArtifactPath),
    previousArtifactPath: previousArtifactPath
      ? toArtifactRefPath(previousArtifactPath)
      : null,
  });
  const markdown = renderMarkdown(report);

  ensureDirForFile(outJsonPath);
  ensureDirForFile(latestJsonPath);
  ensureDirForFile(outMdPath);
  ensureDirForFile(latestMdPath);
  fs.writeFileSync(outJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(outMdPath, `${markdown}\n`);
  fs.writeFileSync(latestMdPath, `${markdown}\n`);

  return {
    outJsonPath,
    latestJsonPath,
    outMdPath,
    latestMdPath,
    report,
  };
};

const isEntryPoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  try {
    const result = runWarpRodcDriftReport({
      latestArtifactPath: readArgValue("--latest-artifact"),
      previousArtifactPath: readArgValue("--previous-artifact") ?? undefined,
      outJsonPath: readArgValue("--out-json"),
      latestJsonPath: readArgValue("--latest-json"),
      outMdPath: readArgValue("--out-md"),
      latestMdPath: readArgValue("--latest-md"),
    });
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `[warp-rodc-drift-report] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
