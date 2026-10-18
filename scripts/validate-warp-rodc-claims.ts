import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type IssueLevel = "error" | "warning";

type Issue = {
  level: IssueLevel;
  code: string;
  message: string;
  file?: string;
};

type WarpRodcClaimRecord = {
  claimId?: string;
  statement?: string;
  maturity?: string;
  clCeiling?: string;
  status?: string;
  contract?: {
    id?: string;
    version?: number;
    laneId?: string;
    classificationScope?: string;
  };
  baselines?: string[];
  evidencePaths?: string[];
  falsifier?: {
    condition?: string;
    evidence?: string;
    note?: string;
  };
  repoBindings?: string[];
  sources?: Array<{ citation?: string }>;
  validityDomain?: {
    system?: string;
    constraints?: string[];
  };
  notes?: string;
};

type WarpRodcRegistry = {
  $schema?: string;
  schemaVersion?: string;
  registryId?: string;
  domain?: string;
  updatedAt?: string;
  claims?: WarpRodcClaimRecord[];
};

type WarpRodcArtifact = {
  contract: {
    id: string;
    version: number;
    lane_id: string;
    classification_scope: string;
  };
  verdict: {
    family_label: string;
    status: string;
    stability: string;
  };
  cross_lane: {
    cross_lane_status: string;
  };
};

type WarpRodcDriftReport = {
  latestArtifactPath: string;
  summary: {
    status: string;
  };
};

type ClaimValidationSurface = {
  claimId: string;
  artifactPath: string | null;
  driftPath: string | null;
  contractId: string | null;
  artifactStatus: string | null;
};

export type WarpRodcClaimValidationResult = {
  ok: boolean;
  registryPath: string;
  artifactPath: string | null;
  driftPath: string | null;
  claimCount: number;
  errorCount: number;
  warningCount: number;
  claimResults: ClaimValidationSurface[];
  issues: Issue[];
};

const DEFAULT_REGISTRY_PATH = path.join(
  "docs",
  "knowledge",
  "math-claims",
  "warp-rodc.claims.v1.json",
);
const DEFAULT_ARTIFACT_PATH = path.join(
  "artifacts",
  "research",
  "full-solve",
  "warp-york-control-family-rodc-latest.json",
);
const DEFAULT_DRIFT_PATH = path.join(
  "artifacts",
  "research",
  "full-solve",
  "warp-rodc-drift-latest.json",
);

const VALID_MATURITY = new Set([
  "exploratory",
  "reduced-order",
  "diagnostic",
  "certified",
]);
const VALID_CL = new Set(["CL0", "CL1", "CL2", "CL3", "CL4"]);
const VALID_STATUS = new Set([
  "active",
  "congruent",
  "distinct",
  "marginal",
  "unstable",
  "inconclusive",
]);
const VALID_DRIFT_STATUS = new Set(["inconclusive", "stable", "drifted", "contract_drift"]);
const OVERCLAIM_PATTERNS = [
  /\bphysically viable\b/i,
  /\bphysical feasibility\b/i,
  /\btheory identity\b/i,
  /\blane[- ]invariant\b/i,
  /\bcross[- ]lane invariant\b/i,
];
const POSITIVE_FAMILY_CLASSIFICATION_PATTERNS = [
  /\bis\s+classified\s+as\s+nhm2_low_expansion_family\b/i,
  /\bis\s+classified\s+as\s+nhm2_alcubierre_like_family\b/i,
  /\bis\s+classified\s+as\s+nhm2_distinct_family\b/i,
];
const CROSS_LANE_STABILITY_ASSERTION_PATTERNS = [
  /\blane_stable_[a-z_]+\b/i,
  /\bcross[- ]lane(?:\s+classification|\s+status|\s+result)?\s+(?:is|remains|shows)?\s*stable\b/i,
];

const hasUnnegatedOverclaim = (text: string): boolean => {
  const normalized = text.toLowerCase();
  return OVERCLAIM_PATTERNS.some((pattern) => {
    const match = normalized.match(pattern);
    if (!match || match.index == null) return false;
    const prefix = normalized.slice(Math.max(0, match.index - 24), match.index);
    return !/(?:not|no|never|does not|do not|did not|must not|cannot|can not)\s+(?:a\s+)?$/.test(prefix);
  });
};

const hasPositiveFamilyClassificationAssertion = (text: string): boolean =>
  POSITIVE_FAMILY_CLASSIFICATION_PATTERNS.some((pattern) => pattern.test(text));

const hasCrossLaneStabilityAssertion = (text: string): boolean =>
  CROSS_LANE_STABILITY_ASSERTION_PATTERNS.some((pattern) => pattern.test(text));

const normalizePath = (filePath: string): string => filePath.replace(/\\/g, "/");

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes("=")) return argv[index].split("=", 2)[1];
  return argv[index + 1];
};

const readJsonFile = <T>(filePath: string): T =>
  JSON.parse(fs.readFileSync(filePath, "utf8")) as T;

const resolveClaimArtifactRef = (
  claim: WarpRodcClaimRecord,
  fallbackArtifactRef: string | null,
): string | null => {
  const evidence = claim.evidencePaths ?? [];
  const candidates = evidence.filter(
    (entry) =>
      /-rodc-latest\.json$/i.test(entry) &&
      !/-rodc-drift-latest\.json$/i.test(entry),
  );
  if (candidates.length >= 1) return candidates[0] ?? null;
  return fallbackArtifactRef;
};

const resolveClaimDriftRef = (
  claim: WarpRodcClaimRecord,
  fallbackDriftRef: string | null,
): string | null => {
  const falsifierRef =
    typeof claim.falsifier?.evidence === "string" &&
    claim.falsifier.evidence.trim().length > 0
      ? claim.falsifier.evidence.trim()
      : null;
  if (falsifierRef) return falsifierRef;
  const evidence = claim.evidencePaths ?? [];
  const fromEvidence = evidence.find((entry) => /-rodc-drift-latest\.json$/i.test(entry));
  return fromEvidence ?? fallbackDriftRef;
};

export const validateWarpRodcClaims = (options?: {
  registryPath?: string;
  artifactPath?: string;
  driftPath?: string;
}): WarpRodcClaimValidationResult => {
  const repoRoot = process.cwd();
  const registryPath = path.resolve(options?.registryPath ?? DEFAULT_REGISTRY_PATH);
  const fallbackArtifactPath = path.resolve(options?.artifactPath ?? DEFAULT_ARTIFACT_PATH);
  const fallbackDriftPath = path.resolve(options?.driftPath ?? DEFAULT_DRIFT_PATH);
  const fallbackArtifactRef = normalizePath(path.relative(repoRoot, fallbackArtifactPath));
  const fallbackDriftRef = normalizePath(path.relative(repoRoot, fallbackDriftPath));
  const issues: Issue[] = [];
  const claimResults: ClaimValidationSurface[] = [];

  const addIssue = (level: IssueLevel, code: string, message: string, file?: string) => {
    issues.push({ level, code, message, file });
  };

  if (!fs.existsSync(registryPath)) {
    addIssue(
      "error",
      "file_missing",
      `Missing required file: ${normalizePath(path.relative(repoRoot, registryPath))}`,
      registryPath,
    );
  }
  if (issues.some((issue) => issue.level === "error")) {
    return {
      ok: false,
      registryPath: normalizePath(path.relative(repoRoot, registryPath)),
      artifactPath: null,
      driftPath: null,
      claimCount: 0,
      errorCount: issues.filter((issue) => issue.level === "error").length,
      warningCount: issues.filter((issue) => issue.level === "warning").length,
      claimResults,
      issues,
    };
  }

  const registry = readJsonFile<WarpRodcRegistry>(registryPath);
  const claims = registry.claims ?? [];

  if (registry.$schema !== "../../qa/schemas/math-claim-registry.schema.json") {
    addIssue(
      "error",
      "schema_path_invalid",
      "RODC registry must point at the shared math-claim schema.",
      registryPath,
    );
  }
  if (registry.schemaVersion !== "1.0.0") {
    addIssue(
      "error",
      "schema_version_invalid",
      "RODC registry must use schemaVersion 1.0.0.",
      registryPath,
    );
  }
  if (registry.registryId !== "warp-rodc") {
    addIssue("error", "registry_id_invalid", "RODC registryId must be warp-rodc.", registryPath);
  }
  if (registry.domain !== "warp-reduced-order-diagnostics") {
    addIssue(
      "error",
      "domain_invalid",
      "RODC domain must be warp-reduced-order-diagnostics.",
      registryPath,
    );
  }
  if (claims.length < 1) {
    addIssue(
      "error",
      "claims_missing",
      "RODC registry must contain at least one claim.",
      registryPath,
    );
  }

  for (const claim of claims) {
    const claimId =
      typeof claim.claimId === "string" && claim.claimId.trim().length > 0
        ? claim.claimId.trim()
        : "unknown";
    const claimPrefix = `${normalizePath(path.relative(repoRoot, registryPath))}#${claimId}`;
    const artifactRef = resolveClaimArtifactRef(claim, fallbackArtifactRef);
    const driftRef = resolveClaimDriftRef(claim, fallbackDriftRef);

    claimResults.push({
      claimId,
      artifactPath: artifactRef,
      driftPath: driftRef,
      contractId:
        typeof claim.contract?.id === "string" && claim.contract.id.trim().length > 0
          ? claim.contract.id.trim()
          : null,
      artifactStatus: null,
    });

    if (typeof claim.claimId !== "string" || claim.claimId.trim().length < 3) {
      addIssue("error", "claim_id_invalid", "claimId is required.", claimPrefix);
    }
    if (typeof claim.statement !== "string" || claim.statement.trim().length < 8) {
      addIssue("error", "statement_invalid", "statement is required.", claimPrefix);
    }
    if (!VALID_MATURITY.has(claim.maturity ?? "")) {
      addIssue("error", "maturity_invalid", "maturity must be a supported math stage.", claimPrefix);
    }
    if (!VALID_CL.has(claim.clCeiling ?? "")) {
      addIssue("error", "cl_ceiling_invalid", "clCeiling must be one of CL0-CL4.", claimPrefix);
    }
    if (!VALID_STATUS.has(claim.status ?? "")) {
      addIssue(
        "error",
        "status_invalid",
        "status must be one of the supported RODC claim statuses.",
        claimPrefix,
      );
    }
    if (!claim.contract) {
      addIssue("error", "contract_missing", "contract binding is required.", claimPrefix);
    }

    if (!artifactRef) {
      addIssue(
        "error",
        "claim_artifact_ref_missing",
        "claim must reference a live -rodc-latest.json artifact.",
        claimPrefix,
      );
    }
    if (!driftRef) {
      addIssue(
        "error",
        "claim_drift_ref_missing",
        "claim must reference a live -rodc-drift-latest.json artifact.",
        claimPrefix,
      );
    }

    if ((claim.evidencePaths?.length ?? 0) < 2) {
      addIssue(
        "error",
        "evidence_paths_missing",
        "claim must include evidencePaths for the live artifacts.",
        claimPrefix,
      );
    } else {
      for (const evidencePath of claim.evidencePaths ?? []) {
        const absoluteEvidencePath = path.resolve(repoRoot, evidencePath);
        if (!fs.existsSync(absoluteEvidencePath)) {
          addIssue("error", "evidence_missing", `Missing evidence path: ${evidencePath}`, claimPrefix);
        }
      }
      if (artifactRef && !claim.evidencePaths?.includes(artifactRef)) {
        addIssue(
          "error",
          "artifact_ref_missing",
          "claim evidencePaths must include the claim live RODC snapshot.",
          claimPrefix,
        );
      }
      if (driftRef && !claim.evidencePaths?.includes(driftRef)) {
        addIssue(
          "error",
          "drift_ref_missing",
          "claim evidencePaths must include the claim RODC drift report.",
          claimPrefix,
        );
      }
    }

    if ((claim.repoBindings?.length ?? 0) < 1) {
      addIssue("error", "repo_bindings_missing", "claim must include repoBindings.", claimPrefix);
    } else {
      for (const binding of claim.repoBindings ?? []) {
        const absoluteBinding = path.resolve(repoRoot, binding);
        if (!fs.existsSync(absoluteBinding)) {
          addIssue("error", "repo_binding_missing", `Missing repo binding: ${binding}`, claimPrefix);
        }
      }
    }
    if ((claim.sources?.length ?? 0) < 1) {
      addIssue("error", "sources_missing", "claim must include sources.", claimPrefix);
    }
    if (!claim.falsifier?.condition || !claim.falsifier.condition.trim()) {
      addIssue(
        "error",
        "falsifier_condition_missing",
        "claim falsifier.condition is required.",
        claimPrefix,
      );
    }
    if (!claim.falsifier?.evidence || !claim.falsifier.evidence.trim()) {
      addIssue(
        "error",
        "falsifier_evidence_missing",
        "claim falsifier.evidence is required.",
        claimPrefix,
      );
    } else if (!fs.existsSync(path.resolve(repoRoot, claim.falsifier.evidence))) {
      addIssue(
        "error",
        "falsifier_evidence_path_missing",
        `Missing falsifier evidence path: ${claim.falsifier.evidence}`,
        claimPrefix,
      );
    }
    if (!claim.validityDomain?.system || (claim.validityDomain.constraints?.length ?? 0) < 1) {
      addIssue(
        "error",
        "validity_domain_missing",
        "claim validityDomain must include system and constraints.",
        claimPrefix,
      );
    }

    const overclaimText = `${claim.statement ?? ""}\n${claim.notes ?? ""}`;
    if (
      claim.contract?.classificationScope === "diagnostic_local_only" &&
      hasUnnegatedOverclaim(overclaimText)
    ) {
      addIssue(
        "error",
        "diagnostic_scope_overclaim",
        "diagnostic_local_only claims must not assert feasibility, theory identity, or lane invariance.",
        claimPrefix,
      );
    }
    if (
      claim.status === "inconclusive" &&
      hasPositiveFamilyClassificationAssertion(overclaimText)
    ) {
      addIssue(
        "error",
        "inconclusive_positive_classification_statement",
        "inconclusive claims must not assert a positive NHM2 family classification in statement/notes.",
        claimPrefix,
      );
    }

    if (!artifactRef || !driftRef) {
      continue;
    }
    const absoluteArtifactPath = path.resolve(repoRoot, artifactRef);
    const absoluteDriftPath = path.resolve(repoRoot, driftRef);
    if (!fs.existsSync(absoluteArtifactPath)) {
      addIssue(
        "error",
        "claim_artifact_missing",
        `Missing claim artifact: ${artifactRef}`,
        claimPrefix,
      );
      continue;
    }
    if (!fs.existsSync(absoluteDriftPath)) {
      addIssue(
        "error",
        "claim_drift_missing",
        `Missing claim drift artifact: ${driftRef}`,
        claimPrefix,
      );
      continue;
    }

    const artifact = readJsonFile<WarpRodcArtifact>(absoluteArtifactPath);
    const driftReport = readJsonFile<WarpRodcDriftReport>(absoluteDriftPath);
    const claimResult = claimResults.find((entry) => entry.claimId === claimId);
    if (claimResult) {
      claimResult.artifactStatus = artifact.verdict?.status ?? null;
    }

    if (claim.contract) {
      if (claim.contract.id !== artifact.contract.id) {
        addIssue(
          "error",
          "contract_id_mismatch",
          "claim contract.id must match the claim live RODC artifact.",
          claimPrefix,
        );
      }
      if (claim.contract.version !== artifact.contract.version) {
        addIssue(
          "error",
          "contract_version_mismatch",
          "claim contract.version must match the claim live RODC artifact.",
          claimPrefix,
        );
      }
      if (claim.contract.laneId !== artifact.contract.lane_id) {
        addIssue(
          "error",
          "lane_id_mismatch",
          "claim contract.laneId must match the claim live RODC artifact.",
          claimPrefix,
        );
      }
      if (claim.contract.classificationScope !== artifact.contract.classification_scope) {
        addIssue(
          "error",
          "classification_scope_mismatch",
          "claim classificationScope must match the claim live RODC artifact.",
          claimPrefix,
        );
      }
    }
    if (claim.status !== artifact.verdict.status) {
      addIssue(
        "error",
        "claim_status_mismatch",
        "claim status must match artifact verdict.status.",
        claimPrefix,
      );
    }
    if (
      artifact.cross_lane?.cross_lane_status === "lane_comparison_inconclusive" &&
      hasCrossLaneStabilityAssertion(overclaimText)
    ) {
      addIssue(
        "error",
        "cross_lane_inconclusive_stability_overclaim",
        "Claims must not assert stable cross-lane conclusions while artifact cross_lane_status is lane_comparison_inconclusive.",
        claimPrefix,
      );
    }
    if (driftReport.latestArtifactPath !== artifactRef) {
      addIssue(
        "error",
        "drift_latest_artifact_mismatch",
        "Drift report latestArtifactPath must match the claim live RODC snapshot path.",
        claimPrefix,
      );
    }
    if (!VALID_DRIFT_STATUS.has(driftReport.summary?.status ?? "")) {
      addIssue(
        "error",
        "drift_status_invalid",
        "Drift report summary.status must use the supported vocabulary.",
        claimPrefix,
      );
    }
  }

  return {
    ok: !issues.some((issue) => issue.level === "error"),
    registryPath: normalizePath(path.relative(repoRoot, registryPath)),
    artifactPath: claimResults[0]?.artifactPath ?? null,
    driftPath: claimResults[0]?.driftPath ?? null,
    claimCount: claims.length,
    errorCount: issues.filter((issue) => issue.level === "error").length,
    warningCount: issues.filter((issue) => issue.level === "warning").length,
    claimResults,
    issues,
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
  const result = validateWarpRodcClaims({
    registryPath: readArgValue("--registry"),
    artifactPath: readArgValue("--artifact"),
    driftPath: readArgValue("--drift"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}
