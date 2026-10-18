import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { resolveArtifactsPath } from "./agi-artifacts";
import type { AgiDatasetExport, AgiTrajectory } from "../shared/agi-refinery";
import { hashStableJson, sha256Prefixed } from "../server/utils/information-boundary";

type Rc0Args = {
  outDir?: string;
  manifestPath?: string;
  holdoutPath?: string;
  coverageHoldoutPath?: string;
  tenantId?: string;
  limit?: number;
  alphaTarget?: number;
  realRatio?: number;
  syntheticRatio?: number;
  minAlpha?: number;
  negativesPerSample?: number;
  enforceGates?: boolean;
  requireNoUnknownExecution?: boolean;
  minClientShare?: number;
  minServerShare?: number;
  minClientServerShare?: number;
  maxDocsSharedShare?: number;
  variantReservoirPath?: string;
  holdoutRatio?: number;
  holdoutMinPerIntent?: number;
  holdoutMinPerSurface?: number;
  holdoutMinPerDifficulty?: number;
  holdoutMaxTotal?: number;
  holdoutRecentFraction?: number;
  skipHoldout?: boolean;
  skipExport?: boolean;
  indexRoots?: string[];
  indexCodeRoots?: string[];
  indexMaxFiles?: number;
  indexMaxCodeFiles?: number;
};

type HoldoutMeta = {
  path: string;
  version: number;
  entries: number;
  sha256: string;
};

type IndexManifest = {
  kinds: string[];
  roots: string[];
  codeRoots: string[];
  maxFiles: number;
  maxCodeFiles: number;
  entryCount: number;
  hash: string;
};

type IdentityManifest = {
  version: string;
  path: string;
  sha256: string;
};

type ExportManifest = {
  sft: { path: string; sha256: string; records: number };
  dpo: { path: string; sha256: string; pairs: number };
  summary: AgiDatasetExport;
};

type Rc0Manifest = {
  schema_version: "agi_refinery_rc0_manifest/1";
  createdAt: string;
  commit: string;
  gatePolicyVersion: string;
  identityNormalization: IdentityManifest;
  index: IndexManifest;
  holdouts: {
    indist: HoldoutMeta;
    coverage: HoldoutMeta;
  };
  export: ExportManifest;
};

const DEFAULT_INDEX_ROOTS = [
  "docs",
  "docs/moral-ladder-pack",
  "shared",
  "client",
  "server",
  "src",
  "modules",
  "packages",
  "sdk",
  "tools",
  "scripts",
  "skills",
  "tests",
  "datasets",
  "configs",
  "public",
  "reports",
];

const DEFAULT_INDEX_CODE_ROOTS = [
  "server",
  "client",
  "shared",
  "src",
  "modules",
  "packages",
  "sdk",
  "cli",
  "tools",
  "scripts",
  "tests",
];

const DEFAULT_INDEX_MAX_FILES = 2400;
const DEFAULT_INDEX_MAX_CODE_FILES = 4000;

const parseCsv = (value?: string): string[] | undefined => {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
};

const parseNumber = (value?: string): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseArgs = (): Rc0Args => {
  const args = process.argv.slice(2);
  const out: Rc0Args = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--out-dir") {
      out.outDir = args[i + 1];
      i += 1;
    } else if (token === "--manifest") {
      out.manifestPath = args[i + 1];
      i += 1;
    } else if (token === "--holdout") {
      out.holdoutPath = args[i + 1];
      i += 1;
    } else if (token === "--coverage-holdout") {
      out.coverageHoldoutPath = args[i + 1];
      i += 1;
    } else if (token === "--tenant") {
      out.tenantId = args[i + 1];
      i += 1;
    } else if (token === "--limit") {
      out.limit = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--alpha-target") {
      out.alphaTarget = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--real-ratio") {
      out.realRatio = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--synthetic-ratio") {
      out.syntheticRatio = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--min-alpha") {
      out.minAlpha = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--negatives-per-sample") {
      out.negativesPerSample = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--no-enforce") {
      out.enforceGates = false;
    } else if (token === "--allow-unknown") {
      out.requireNoUnknownExecution = false;
    } else if (token === "--min-client-share") {
      out.minClientShare = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--min-server-share") {
      out.minServerShare = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--min-client-server-share") {
      out.minClientServerShare = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--max-docs-shared-share") {
      out.maxDocsSharedShare = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--variant-reservoir") {
      out.variantReservoirPath = args[i + 1];
      i += 1;
    } else if (token === "--holdout-ratio") {
      out.holdoutRatio = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--holdout-min-intent") {
      out.holdoutMinPerIntent = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--holdout-min-surface") {
      out.holdoutMinPerSurface = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--holdout-min-difficulty") {
      out.holdoutMinPerDifficulty = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--holdout-max-total") {
      out.holdoutMaxTotal = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--holdout-recent-fraction") {
      out.holdoutRecentFraction = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--skip-holdout") {
      out.skipHoldout = true;
    } else if (token === "--skip-export") {
      out.skipExport = true;
    } else if (token === "--index-roots") {
      out.indexRoots = parseCsv(args[i + 1]);
      i += 1;
    } else if (token === "--index-code-roots") {
      out.indexCodeRoots = parseCsv(args[i + 1]);
      i += 1;
    } else if (token === "--index-max-files") {
      out.indexMaxFiles = parseNumber(args[i + 1]);
      i += 1;
    } else if (token === "--index-max-code-files") {
      out.indexMaxCodeFiles = parseNumber(args[i + 1]);
      i += 1;
    }
  }
  return out;
};

const detectCommit = (): string => {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
  } catch {
    return "workspace";
  }
};

const toRepoRelative = (filePath: string): string =>
  path.relative(process.cwd(), filePath).replace(/\\/g, "/");

const readSha256 = async (filePath: string): Promise<string> => {
  const payload = await fs.readFile(filePath, "utf8");
  return sha256Prefixed(payload);
};

const ensureHoldout = async (
  trajectories: AgiTrajectory[],
  options: Rc0Args,
  holdoutPath: string,
  coverageHoldoutPath: string,
) => {
  const {
    buildHoldoutSet,
    buildCoverageHoldoutSet,
    saveHoldoutSet,
  } = await import("../server/services/agi/refinery-holdout");
  const holdout = buildHoldoutSet(trajectories, {
    ratio: options.holdoutRatio,
    minPerIntent: options.holdoutMinPerIntent,
    maxTotal: options.holdoutMaxTotal,
    recentFraction: options.holdoutRecentFraction,
  });
  await saveHoldoutSet(holdout, holdoutPath);
  const coverage = buildCoverageHoldoutSet(trajectories, {
    ratio: options.holdoutRatio,
    minPerIntent: options.holdoutMinPerIntent,
    minPerSurface: options.holdoutMinPerSurface,
    minPerDifficulty: options.holdoutMinPerDifficulty,
    maxTotal: options.holdoutMaxTotal,
    recentFraction: options.holdoutRecentFraction,
  });
  await saveHoldoutSet(coverage, coverageHoldoutPath);
};

const loadHoldoutMeta = async (
  filePath: string,
): Promise<{ meta: HoldoutMeta; version: number }> => {
  const { loadHoldoutSet } = await import("../server/services/agi/refinery-holdout");
  const holdout = await loadHoldoutSet(filePath);
  if (!holdout) {
    throw new Error(`holdout_missing:${filePath}`);
  }
  const sha256 = await readSha256(filePath);
  const relativePath = toRepoRelative(filePath);
  return {
    meta: {
      path: relativePath,
      version: holdout.version,
      entries: holdout.entries.length,
      sha256,
    },
    version: holdout.version,
  };
};

const buildIndexManifest = async (
  kinds: string[],
  roots: string[],
  codeRoots: string[],
  maxFiles: number,
  maxCodeFiles: number,
): Promise<IndexManifest> => {
  const { getRepoSearchIndex } = await import("../server/services/search/repo-index");
  const entries = await getRepoSearchIndex();
  const filtered = entries.filter((entry) => kinds.includes(entry.kind));
  const normalized = filtered
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      summary: entry.summary ?? null,
      bodyHash: entry.body ? sha256Prefixed(entry.body) : null,
      tags: (entry.tags ?? []).slice().sort(),
      source: Object.fromEntries(
        Object.entries(entry.source ?? {}).filter(
          ([, value]) => typeof value === "string" && value.length > 0,
        ),
      ),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    kinds,
    roots,
    codeRoots,
    maxFiles,
    maxCodeFiles,
    entryCount: normalized.length,
    hash: hashStableJson(normalized),
  };
};

async function main() {
  const args = parseArgs();
  const outDir = path.resolve(
    args.outDir ?? resolveArtifactsPath("rc0"),
  );
  const holdoutPath = path.resolve(
    args.holdoutPath ?? path.join(outDir, "holdout_indist_rc0.jsonl"),
  );
  const coverageHoldoutPath = path.resolve(
    args.coverageHoldoutPath ?? path.join(outDir, "holdout_cov_rc0.jsonl"),
  );
  const manifestPath = path.resolve(
    args.manifestPath ?? path.join(outDir, "agi-refinery-rc0.manifest.json"),
  );

  const indexRoots = args.indexRoots ?? DEFAULT_INDEX_ROOTS;
  const indexCodeRoots = args.indexCodeRoots ?? DEFAULT_INDEX_CODE_ROOTS;
  const indexMaxFiles = args.indexMaxFiles ?? DEFAULT_INDEX_MAX_FILES;
  const indexMaxCodeFiles = args.indexMaxCodeFiles ?? DEFAULT_INDEX_MAX_CODE_FILES;

  process.env.AGI_REFINERY_HOLDOUT_PATH = holdoutPath;
  process.env.AGI_REFINERY_COVERAGE_HOLDOUT_PATH = coverageHoldoutPath;
  process.env.REPO_SEARCH_ROOTS = indexRoots.join(",");
  process.env.REPO_SEARCH_CODE_ROOTS = indexCodeRoots.join(",");
  process.env.REPO_SEARCH_MAX_FILES = String(indexMaxFiles);
  process.env.REPO_SEARCH_MAX_CODE_FILES = String(indexMaxCodeFiles);
  process.env.REPO_SEARCH_FORCE_REFRESH = "1";

  const { getTrainingTraceExport } = await import(
    "../server/services/observability/training-trace-store"
  );
  const { extractHoldoutPayload } = await import(
    "../server/services/agi/refinery-holdout"
  );

  if (!args.skipHoldout) {
    const traces = getTrainingTraceExport({
      limit: args.limit,
      tenantId: args.tenantId,
    });
    const { trajectories } = extractHoldoutPayload(traces);
    await ensureHoldout(
      Array.from(trajectories.values()),
      args,
      holdoutPath,
      coverageHoldoutPath,
    );
  }

  const [indistHoldout, coverageHoldout] = await Promise.all([
    loadHoldoutMeta(holdoutPath),
    loadHoldoutMeta(coverageHoldoutPath),
  ]);

  const commit = detectCommit();
  const identityRelativePath = "server/services/agi/refinery-identity.ts";
  const identityPath = path.resolve(process.cwd(), identityRelativePath);
  const identitySha256 = await readSha256(identityPath);
  const identityNormalization: IdentityManifest = {
    version: identitySha256,
    path: identityRelativePath,
    sha256: identitySha256,
  };

  const { evaluateTrajectoryGates } = await import(
    "../server/services/agi/refinery-gates"
  );
  const gatePolicyVersion =
    evaluateTrajectoryGates({
      id: "rc0-policy-check",
      createdAt: new Date().toISOString(),
      x: "policy-check",
      q: [],
      E: [],
      y: { summary: "policy-check", citations: [] },
      meta: {},
    }).policyVersion ?? "unknown";

  const indexManifest = await buildIndexManifest(
    ["doc", "code"],
    indexRoots,
    indexCodeRoots,
    indexMaxFiles,
    indexMaxCodeFiles,
  );

  let exportSummary: AgiDatasetExport | null = null;
  if (!args.skipExport) {
    const { exportRefineryDataset } = await import(
      "../server/services/agi/refinery-export"
    );
    exportSummary = await exportRefineryDataset({
      limit: args.limit,
      outDir,
      realRatio: args.realRatio ?? args.alphaTarget,
      syntheticRatio: args.syntheticRatio,
      tenantId: args.tenantId,
      negativesPerSample: args.negativesPerSample,
      minAlpha: args.minAlpha,
      enforceGates: args.enforceGates,
      requireNoUnknownExecution: args.requireNoUnknownExecution,
      minClientShare: args.minClientShare,
      minServerShare: args.minServerShare,
      minClientServerShare: args.minClientServerShare,
      maxDocsSharedShare: args.maxDocsSharedShare,
      variantReservoirPath: args.variantReservoirPath,
      emitTrace: true,
    });
    if (exportSummary.blocked) {
      console.error(
        "[agi-rc0-freeze] export blocked:",
        exportSummary.blockedReasons ?? [],
      );
      process.exit(2);
    }
  } else {
    throw new Error("export_skipped");
  }

  if (!exportSummary?.sftPath || !exportSummary?.dpoPath) {
    throw new Error("export_missing_paths");
  }

  const [sftHash, dpoHash] = await Promise.all([
    readSha256(exportSummary.sftPath),
    readSha256(exportSummary.dpoPath),
  ]);
  const summaryForManifest: AgiDatasetExport = {
    ...exportSummary,
    sftPath: toRepoRelative(exportSummary.sftPath),
    dpoPath: toRepoRelative(exportSummary.dpoPath),
  };

  const manifest: Rc0Manifest = {
    schema_version: "agi_refinery_rc0_manifest/1",
    createdAt: new Date().toISOString(),
    commit,
    gatePolicyVersion,
    identityNormalization,
    index: indexManifest,
    holdouts: {
      indist: indistHoldout.meta,
      coverage: coverageHoldout.meta,
    },
    export: {
      sft: {
        path: toRepoRelative(exportSummary.sftPath),
        sha256: sftHash,
        records: exportSummary.accepted,
      },
      dpo: {
        path: toRepoRelative(exportSummary.dpoPath),
        sha256: dpoHash,
        pairs: exportSummary.dpoPairs ?? 0,
      },
      summary: summaryForManifest,
    },
  };

  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        manifestPath,
        sftPath: toRepoRelative(exportSummary.sftPath),
        dpoPath: toRepoRelative(exportSummary.dpoPath),
        holdoutPath: toRepoRelative(holdoutPath),
        coverageHoldoutPath: toRepoRelative(coverageHoldoutPath),
        gatePolicyVersion,
        identityNormalization: identityNormalization.version,
        indexHash: indexManifest.hash,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
