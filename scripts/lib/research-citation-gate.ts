import fs from "node:fs";
import path from "node:path";

export type ResearchClaimStatus = "measured" | "derived" | "hypothesis";
export type ResearchCitationSourceType = "paper" | "web" | "github_clone";
export type ResearchChecklistStatus = "pending" | "done";
export type ResearchCitationEvidenceType =
  | "repo_clone"
  | "peer_reviewed"
  | "preprint"
  | "internal_artifact"
  | "reference_web";

export type ResearchCitationChecklistItem = {
  id: string;
  title: string;
  status: ResearchChecklistStatus;
  note?: string;
  evidenceRef?: string;
};

export type ResearchCitationSource = {
  id: string;
  type: ResearchCitationSourceType;
  evidenceType?: ResearchCitationEvidenceType;
  sourceStability?:
    | "primary_peer_reviewed"
    | "preprint"
    | "operational_web"
    | "repo_clone";
  title: string;
  supportsClaimIds?: string[];
  accessedOn?: string;
  confidenceNote?: string;
  url?: string;
  doi?: string;
  repoUrl?: string;
  repoBranch?: string;
  repoTag?: string;
  commitSha?: string;
  clonePath?: string;
  retrievedOn?: string;
  note?: string;
};

export type ResearchCitationClaim = {
  claimId: string;
  claimText: string;
  status: ResearchClaimStatus;
  artifactPaths: string[];
  sourceIds: string[];
  uncertaintyNote?: string;
  uncertaintyRationale?: string;
  scopeBoundary?: string;
};

export type ResearchCitationPatchChecklistManifest = {
  manifestType: "research_citation_patch_checklist/v1";
  generatedOn: string;
  policy?: {
    citationRequiredStatuses?: ResearchClaimStatus[];
    minSourcesPerClaim?: number;
    requireGithubCloneForMeasured?: boolean;
    requireCompletedChecklistItems?: boolean;
  };
  checklist: ResearchCitationChecklistItem[];
  sources: ResearchCitationSource[];
  claims: ResearchCitationClaim[];
};

export type ResearchCitationGateOptions = {
  manifestPath: string;
  citationRequiredStatuses?: ResearchClaimStatus[];
  minSourcesPerClaim?: number;
  requireGithubCloneForMeasured?: boolean;
  requireCompletedChecklistItems?: boolean;
};

export type ResearchCitationGateSummary = {
  manifestPath: string;
  checklistCount: number;
  sourceCount: number;
  claimCount: number;
  requiredClaimCount: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

const DATE_STAMP_RX = /^\d{4}-\d{2}-\d{2}$/;
const GIT_SHA_RX = /^[0-9a-f]{7,40}$/i;
const DOI_RX = /^10\.\d{4,9}\/[-._;()/:A-Z0-9]+$/i;
const ARXIV_URL_RX = /^https?:\/\/arxiv\.org\/abs\/[A-Za-z0-9._\-\/]+$/i;
const NON_MEASURED_FORBIDDEN_CERTAINTY_RX =
  /\b(proven|proof|theorem-level|certified physics|experimentally validated)\b/i;
const isHttpUrl = (value: string | undefined): boolean => {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};
const isLiteratureSource = (source: ResearchCitationSource): boolean =>
  source.type === "paper" ||
  source.evidenceType === "peer_reviewed" ||
  source.evidenceType === "preprint";
const isRepoCloneSource = (source: ResearchCitationSource): boolean =>
  source.type === "github_clone" || source.evidenceType === "repo_clone";
const isStableLiteratureSource = (source: ResearchCitationSource): boolean =>
  source.sourceStability === "primary_peer_reviewed" ||
  source.sourceStability === "preprint";

const normalizeStatuses = (value: unknown): ResearchClaimStatus[] => {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is ResearchClaimStatus =>
      entry === "measured" || entry === "derived" || entry === "hypothesis",
  );
};

export const validateResearchCitationGateManifest = (
  input: unknown,
  options?: Omit<ResearchCitationGateOptions, "manifestPath">,
): {
  ok: boolean;
  issues: string[];
  summary: Omit<ResearchCitationGateSummary, "manifestPath"> | null;
} => {
  const issues: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: ["manifest_not_object"], summary: null };
  }
  if (input.manifestType !== "research_citation_patch_checklist/v1") {
    issues.push("manifest_type_invalid");
  }

  const policy = isRecord(input.policy) ? input.policy : {};
  const citationRequiredStatuses =
    options?.citationRequiredStatuses ??
    normalizeStatuses(policy.citationRequiredStatuses) ??
    ["measured", "derived"];
  const minSourcesPerClaim = Math.max(
    1,
    options?.minSourcesPerClaim ??
      (typeof policy.minSourcesPerClaim === "number" ? Math.floor(policy.minSourcesPerClaim) : 1),
  );
  const requireGithubCloneForMeasured =
    options?.requireGithubCloneForMeasured ??
    (policy.requireGithubCloneForMeasured === true);
  const requireCompletedChecklistItems =
    options?.requireCompletedChecklistItems ??
    (policy.requireCompletedChecklistItems !== false);

  const checklist = Array.isArray(input.checklist) ? input.checklist : [];
  const sources = Array.isArray(input.sources) ? input.sources : [];
  const claims = Array.isArray(input.claims) ? input.claims : [];

  if (checklist.length <= 0) issues.push("checklist_missing");
  if (sources.length <= 0) issues.push("sources_missing");
  if (claims.length <= 0) issues.push("claims_missing");

  const sourceById = new Map<string, ResearchCitationSource>();
  for (const [index, raw] of sources.entries()) {
    if (!isRecord(raw)) {
      issues.push(`source_${index}_not_object`);
      continue;
    }
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) {
      issues.push(`source_${index}_id_missing`);
      continue;
    }
    if (sourceById.has(id)) {
      issues.push(`source_${index}_id_duplicate:${id}`);
      continue;
    }
    const type = raw.type;
    if (type !== "paper" && type !== "web" && type !== "github_clone") {
      issues.push(`source_${index}_type_invalid:${id}`);
      continue;
    }
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title) {
      issues.push(`source_${index}_title_missing:${id}`);
      continue;
    }
    const source: ResearchCitationSource = {
      id,
      type,
      evidenceType:
        raw.evidenceType === "repo_clone" ||
        raw.evidenceType === "peer_reviewed" ||
        raw.evidenceType === "preprint" ||
        raw.evidenceType === "internal_artifact" ||
        raw.evidenceType === "reference_web"
          ? raw.evidenceType
          : undefined,
      sourceStability:
        raw.sourceStability === "primary_peer_reviewed" ||
        raw.sourceStability === "preprint" ||
        raw.sourceStability === "operational_web" ||
        raw.sourceStability === "repo_clone"
          ? raw.sourceStability
          : undefined,
      title,
      supportsClaimIds: Array.isArray(raw.supportsClaimIds)
        ? raw.supportsClaimIds.filter(
            (entry): entry is string =>
              typeof entry === "string" && entry.trim().length > 0,
          )
        : undefined,
      accessedOn:
        typeof raw.accessedOn === "string" ? raw.accessedOn.trim() : undefined,
      confidenceNote:
        typeof raw.confidenceNote === "string"
          ? raw.confidenceNote.trim()
          : undefined,
      url: typeof raw.url === "string" ? raw.url.trim() : undefined,
      doi: typeof raw.doi === "string" ? raw.doi.trim() : undefined,
      repoUrl: typeof raw.repoUrl === "string" ? raw.repoUrl.trim() : undefined,
      repoBranch:
        typeof raw.repoBranch === "string" ? raw.repoBranch.trim() : undefined,
      repoTag: typeof raw.repoTag === "string" ? raw.repoTag.trim() : undefined,
      commitSha: typeof raw.commitSha === "string" ? raw.commitSha.trim() : undefined,
      clonePath: typeof raw.clonePath === "string" ? raw.clonePath.trim() : undefined,
      retrievedOn:
        typeof raw.retrievedOn === "string" ? raw.retrievedOn.trim() : undefined,
      note: typeof raw.note === "string" ? raw.note.trim() : undefined,
    };
    if (source.evidenceType == null) {
      issues.push(`source_${index}_evidence_type_missing:${id}`);
    }
    if (source.sourceStability == null) {
      issues.push(`source_${index}_source_stability_missing:${id}`);
    }
    if (source.supportsClaimIds == null || source.supportsClaimIds.length <= 0) {
      issues.push(`source_${index}_supports_claim_ids_missing:${id}`);
    }
    if (!source.accessedOn || !DATE_STAMP_RX.test(source.accessedOn)) {
      issues.push(`source_${index}_accessed_on_invalid:${id}`);
    }
    if (source.type === "github_clone") {
      if (!source.repoUrl) issues.push(`source_${index}_repo_missing:${id}`);
      if (!source.commitSha) {
        issues.push(`source_${index}_commit_missing:${id}`);
      } else if (!GIT_SHA_RX.test(source.commitSha)) {
        issues.push(`source_${index}_commit_invalid:${id}`);
      }
      if (!source.clonePath) issues.push(`source_${index}_clone_path_missing:${id}`);
      if (!source.retrievedOn || !DATE_STAMP_RX.test(source.retrievedOn)) {
        issues.push(`source_${index}_retrieved_on_invalid:${id}`);
      }
      if (!source.repoBranch && !source.repoTag) {
        issues.push(`source_${index}_repo_ref_missing:${id}`);
      }
      if (source.evidenceType !== "repo_clone") {
        issues.push(`source_${index}_evidence_type_mismatch:${id}`);
      }
      if (source.sourceStability !== "repo_clone") {
        issues.push(`source_${index}_source_stability_mismatch:${id}`);
      }
    } else if (!source.url && !source.doi) {
      issues.push(`source_${index}_reference_missing:${id}`);
    }
    if (source.type === "paper") {
      if (!isHttpUrl(source.url)) {
        issues.push(`source_${index}_paper_url_invalid:${id}`);
      }
      if (source.doi != null && source.doi.trim().length > 0) {
        if (!DOI_RX.test(source.doi)) {
          issues.push(`source_${index}_doi_invalid:${id}`);
        }
      } else if (!ARXIV_URL_RX.test(source.url ?? "")) {
        issues.push(`source_${index}_paper_requires_doi_or_arxiv_url:${id}`);
      }
    }
    sourceById.set(id, source);
  }

  for (const [index, raw] of checklist.entries()) {
    if (!isRecord(raw)) {
      issues.push(`checklist_${index}_not_object`);
      continue;
    }
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const status = raw.status;
    if (!id) issues.push(`checklist_${index}_id_missing`);
    if (!title) issues.push(`checklist_${index}_title_missing`);
    if (status !== "pending" && status !== "done") {
      issues.push(`checklist_${index}_status_invalid`);
      continue;
    }
    if (requireCompletedChecklistItems && status !== "done") {
      issues.push(`checklist_${index}_incomplete:${id || index}`);
    }
  }

  let requiredClaimCount = 0;
  const seenClaimIds = new Set<string>();
  for (const [index, raw] of claims.entries()) {
    if (!isRecord(raw)) {
      issues.push(`claim_${index}_not_object`);
      continue;
    }
    const claimId = typeof raw.claimId === "string" ? raw.claimId.trim() : "";
    const claimText = typeof raw.claimText === "string" ? raw.claimText.trim() : "";
    const status = raw.status;
    if (!claimId) {
      issues.push(`claim_${index}_id_missing`);
      continue;
    }
    if (seenClaimIds.has(claimId)) {
      issues.push(`claim_${index}_id_duplicate:${claimId}`);
      continue;
    }
    seenClaimIds.add(claimId);
    if (!claimText) issues.push(`claim_${index}_text_missing:${claimId}`);
    if (status !== "measured" && status !== "derived" && status !== "hypothesis") {
      issues.push(`claim_${index}_status_invalid:${claimId}`);
      continue;
    }
    const artifactPaths = Array.isArray(raw.artifactPaths)
      ? raw.artifactPaths.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
    if (artifactPaths.length <= 0) {
      issues.push(`claim_${index}_artifact_paths_missing:${claimId}`);
    }
    const sourceIds = Array.isArray(raw.sourceIds)
      ? raw.sourceIds.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
    const citationRequired = citationRequiredStatuses.includes(status);
    if (citationRequired) {
      requiredClaimCount += 1;
      if (sourceIds.length < minSourcesPerClaim) {
        issues.push(`claim_${index}_insufficient_sources:${claimId}`);
      }
    }
    const resolvedSources = sourceIds
      .map((id) => sourceById.get(id))
      .filter((entry): entry is ResearchCitationSource => entry != null);
    if (sourceIds.length !== resolvedSources.length) {
      issues.push(`claim_${index}_unknown_source_ref:${claimId}`);
    }
    if (
      status !== "measured" &&
      !resolvedSources.some((entry) => isLiteratureSource(entry))
    ) {
      issues.push(`claim_${index}_non_measured_paper_required:${claimId}`);
    }
    const nonMeasuredPaperSources = resolvedSources.filter((entry) => isLiteratureSource(entry));
    if (
      status !== "measured" &&
      nonMeasuredPaperSources.length > 0 &&
      !nonMeasuredPaperSources.some((entry) => isStableLiteratureSource(entry))
    ) {
      issues.push(`claim_${index}_non_measured_paper_stability_required:${claimId}`);
    }
    if (status !== "measured" && NON_MEASURED_FORBIDDEN_CERTAINTY_RX.test(claimText)) {
      issues.push(`claim_${index}_non_measured_certainty_language_forbidden:${claimId}`);
    }
    if (
      status === "measured" &&
      requireGithubCloneForMeasured &&
      !resolvedSources.some((entry) => isRepoCloneSource(entry))
    ) {
      issues.push(`claim_${index}_github_clone_required:${claimId}`);
    }
    if (status === "measured" && !resolvedSources.some((entry) => isRepoCloneSource(entry))) {
      issues.push(`claim_${index}_measured_repo_clone_required:${claimId}`);
    }
    if (
      status === "derived" &&
      !resolvedSources.some((entry) => isRepoCloneSource(entry))
    ) {
      issues.push(`claim_${index}_derived_repo_clone_required:${claimId}`);
    }
    if (
      status === "derived" &&
      !resolvedSources.some((entry) => isLiteratureSource(entry))
    ) {
      issues.push(`claim_${index}_derived_literature_required:${claimId}`);
    }
    if (
      status !== "measured" &&
      !resolvedSources.some((entry) => isStableLiteratureSource(entry))
    ) {
      issues.push(`claim_${index}_stable_literature_required:${claimId}`);
    }
    if (
      citationRequired &&
      !resolvedSources.some((entry) =>
        Array.isArray(entry.supportsClaimIds)
          ? entry.supportsClaimIds.includes(claimId)
          : false,
      )
    ) {
      issues.push(`claim_${index}_source_support_mapping_missing:${claimId}`);
    }
    if (status === "hypothesis") {
      const uncertaintyNote =
        typeof raw.uncertaintyNote === "string" ? raw.uncertaintyNote.trim() : "";
      if (!uncertaintyNote) {
        issues.push(`claim_${index}_uncertainty_note_missing:${claimId}`);
      }
      const uncertaintyRationale =
        typeof raw.uncertaintyRationale === "string"
          ? raw.uncertaintyRationale.trim()
          : "";
      if (!uncertaintyRationale) {
        issues.push(`claim_${index}_uncertainty_rationale_missing:${claimId}`);
      }
      const scopeBoundary =
        typeof raw.scopeBoundary === "string" ? raw.scopeBoundary.trim() : "";
      if (!scopeBoundary) {
        issues.push(`claim_${index}_scope_boundary_missing:${claimId}`);
      }
      if (!resolvedSources.some((entry) => isLiteratureSource(entry))) {
        issues.push(`claim_${index}_hypothesis_literature_required:${claimId}`);
      }
    } else if (status === "derived") {
      const uncertaintyRationale =
        typeof raw.uncertaintyRationale === "string"
          ? raw.uncertaintyRationale.trim()
          : "";
      if (!uncertaintyRationale) {
        issues.push(`claim_${index}_uncertainty_rationale_missing:${claimId}`);
      }
      const scopeBoundary =
        typeof raw.scopeBoundary === "string" ? raw.scopeBoundary.trim() : "";
      if (!scopeBoundary) {
        issues.push(`claim_${index}_scope_boundary_missing:${claimId}`);
      }
    }
  }

  if (requiredClaimCount <= 0) {
    issues.push("no_required_claims_for_policy");
  }

  return {
    ok: issues.length === 0,
    issues,
    summary: {
      checklistCount: checklist.length,
      sourceCount: sources.length,
      claimCount: claims.length,
      requiredClaimCount,
    },
  };
};

export const enforceResearchCitationGate = (
  options: ResearchCitationGateOptions,
): ResearchCitationGateSummary => {
  const manifestPath = path.resolve(options.manifestPath);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`citation_gate_manifest_missing:${manifestPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`citation_gate_manifest_parse_failed:${detail}`);
  }
  const validation = validateResearchCitationGateManifest(raw, options);
  if (!validation.ok || validation.summary == null) {
    throw new Error(`citation_gate_failed:${validation.issues.join(",")}`);
  }
  return {
    manifestPath,
    checklistCount: validation.summary.checklistCount,
    sourceCount: validation.summary.sourceCount,
    claimCount: validation.summary.claimCount,
    requiredClaimCount: validation.summary.requiredClaimCount,
  };
};
