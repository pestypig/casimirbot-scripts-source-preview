import fs from "node:fs";
import path from "node:path";

import { validateMathCongruenceMatrix } from "./validate-math-congruence-matrix";

type BacklogTicket = {
  id?: string;
  tree_owner?: string;
  research_gate?: {
    required_artifacts?: string[];
  };
};

type Backlog = {
  schema_version?: string;
  tickets?: BacklogTicket[];
};

type BacklogSegment = "core" | "extension";

type TicketResult = {
  schema_version?: string;
  ticket_id?: string;
  claim_tier?: string;
  casimir?: {
    verdict?: string;
    integrity_ok?: boolean;
  };
  research_artifacts?: string[];
};

type TierKey = "diagnostic" | "reduced-order" | "certified";
type CoverageStatus = "covered_core" | "covered_extension" | "unmapped";

type ResolverOwnerCoverageManifest = {
  schema_version?: string;
  owners?: Record<string, { status?: CoverageStatus }>;
};

const BACKLOG_PATH = path.resolve(
  process.env.TOE_BACKLOG_PATH ??
    path.join("docs", "audits", "toe-cloud-agent-ticket-backlog-2026-02-17.json"),
);
const EXTENSION_BACKLOG_PATH = path.resolve(
  process.env.TOE_EXTENSION_BACKLOG_PATH ??
    path.join("docs", "audits", "toe-coverage-extension-backlog-2026-02-18.json"),
);
const RESULTS_DIR = path.resolve(
  process.env.TOE_RESULTS_DIR ?? path.join("docs", "audits", "ticket-results"),
);
const SNAPSHOT_PATH = path.resolve(
  process.env.TOE_PROGRESS_SNAPSHOT_PATH ?? path.join("docs", "audits", "toe-progress-snapshot.json"),
);
const RESOLVER_OWNER_COVERAGE_MANIFEST_PATH = path.resolve(
  process.env.RESOLVER_OWNER_COVERAGE_MANIFEST_PATH ??
    path.join("configs", "resolver-owner-coverage-manifest.v1.json"),
);

const TIER_WEIGHTS: Record<TierKey, number> = {
  diagnostic: 0.25,
  "reduced-order": 0.6,
  certified: 1.0,
};

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function listTicketResultJsonFiles(): string[] {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  return fs
    .readdirSync(RESULTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => path.join(RESULTS_DIR, entry.name))
    .sort();
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function toTier(value?: string): TierKey | null {
  if (value === "diagnostic" || value === "reduced-order" || value === "certified") {
    return value;
  }
  return null;
}

function toProgressPercent(value: number): number {
  return Math.round(value * 1000) / 10;
}

function computeForestOwnerCoveragePct(): number {
  if (!fs.existsSync(RESOLVER_OWNER_COVERAGE_MANIFEST_PATH)) {
    throw new Error(
      `Resolver owner coverage manifest missing: ${RESOLVER_OWNER_COVERAGE_MANIFEST_PATH}`,
    );
  }

  const manifest = readJson<ResolverOwnerCoverageManifest>(
    RESOLVER_OWNER_COVERAGE_MANIFEST_PATH,
  );
  if (manifest.schema_version !== "resolver_owner_coverage_manifest/1") {
    throw new Error(
      `Unexpected resolver owner coverage manifest schema_version: ${String(manifest.schema_version)}`,
    );
  }

  const owners = manifest.owners ?? {};
  const ownerNames = Object.keys(owners);
  if (ownerNames.length === 0) {
    throw new Error("Resolver owner coverage manifest has no owners.");
  }

  const coveredCount = ownerNames.filter((owner) => {
    const status = owners[owner]?.status;
    return status === "covered_core" || status === "covered_extension";
  }).length;

  return coveredCount / ownerNames.length;
}

function readBacklogTicketIds(filePath: string, segment: BacklogSegment): string[] {
  const backlog = readJson<Backlog>(filePath);
  const expectedSchemaVersion =
    segment === "core" ? "toe_cloud_ticket_backlog/1" : "toe_coverage_extension_backlog/1";

  if (backlog.schema_version !== expectedSchemaVersion) {
    throw new Error(
      `Unexpected ${segment} backlog schema_version: ${String(backlog.schema_version)}`,
    );
  }

  return (backlog.tickets ?? [])
    .map((ticket) => ticket.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

function readBacklogTicketResearchRequirements(filePath: string): Map<string, Set<string>> {
  const backlog = readJson<Backlog>(filePath);
  const requirements = new Map<string, Set<string>>();

  for (const ticket of backlog.tickets ?? []) {
    const ticketId = typeof ticket.id === "string" ? ticket.id.trim() : "";
    if (!ticketId) continue;

    const requiredArtifacts = Array.isArray(ticket.research_gate?.required_artifacts)
      ? ticket.research_gate?.required_artifacts
          .map((value) => String(value).trim())
          .filter((value): value is string => value.length > 0)
      : [];
    requirements.set(ticketId, new Set(requiredArtifacts));
  }

  return requirements;
}

function mergeArtifactRequirementMaps(
  existing: Map<string, Set<string>>,
  incoming: Map<string, Set<string>>,
) {
  for (const [ticketId, requiredArtifacts] of incoming.entries()) {
    const current = existing.get(ticketId) ?? new Set<string>();
    for (const artifact of requiredArtifacts) {
      current.add(artifact);
    }
    existing.set(ticketId, current);
  }
}

type SegmentSummary = {
  tickets_total: number;
  tickets_with_evidence: number;
  verified_pass_tickets: number;
  verified_pass_progress_pct: number;
  claim_tier_counts: Record<TierKey, number>;
  weighted_score_sum: number;
  toe_progress_pct: number;
  strict_ready_progress_pct: number;
};

type StrictReadyDeltaTarget = {
  ticket_id: string;
  next_strict_ready_claim_tier: Extract<TierKey, "reduced-order" | "certified">;
  requires_verified_pass: true;
  requires_research_artifact_completion: boolean;
  requires_math_congruence: boolean;
};

type StrictReadyReleaseGate = {
  status: "ready" | "blocked";
  blocked_reasons: Array<"missing_verified_pass" | "missing_research_artifacts" | "missing_math_congruence">;
  blocked_ticket_count: number;
  ready_ticket_count: number;
  blocker_counts: {
    missing_verified_pass: number;
    missing_research_artifacts: number;
    missing_math_congruence: number;
  };
};

function emptySegmentSummary(): SegmentSummary {
  return {
    tickets_total: 0,
    tickets_with_evidence: 0,
    verified_pass_tickets: 0,
    verified_pass_progress_pct: 0,
    claim_tier_counts: {
      diagnostic: 0,
      "reduced-order": 0,
      certified: 0,
    },
    weighted_score_sum: 0,
    toe_progress_pct: 0,
    strict_ready_progress_pct: 0,
  };
}

function main() {
  if (!fs.existsSync(BACKLOG_PATH)) {
    throw new Error(`Backlog file missing: ${BACKLOG_PATH}`);
  }

  const coreTicketIds = readBacklogTicketIds(BACKLOG_PATH, "core");
  const artifactRequirementsByTicket = readBacklogTicketResearchRequirements(BACKLOG_PATH);
  const extensionBacklogPresent = fs.existsSync(EXTENSION_BACKLOG_PATH);
  const extensionTicketIds = extensionBacklogPresent
    ? readBacklogTicketIds(EXTENSION_BACKLOG_PATH, "extension")
    : [];
  if (extensionBacklogPresent) {
    mergeArtifactRequirementMaps(
      artifactRequirementsByTicket,
      readBacklogTicketResearchRequirements(EXTENSION_BACKLOG_PATH),
    );
  }

  const ticketIds = [...new Set([...coreTicketIds, ...extensionTicketIds])];

  if (ticketIds.length === 0) {
    throw new Error("No tickets found in backlog.");
  }

  const coreTicketIdSet = new Set(coreTicketIds);
  const extensionTicketIdSet = new Set(extensionTicketIds);

  const latestByTicket = new Map<
    string,
    {
      filePath: string;
      mtimeMs: number;
      result: TicketResult;
    }
  >();

  for (const filePath of listTicketResultJsonFiles()) {
    let parsed: TicketResult;
    try {
      parsed = readJson<TicketResult>(filePath);
    } catch {
      continue;
    }
    if (parsed.schema_version !== "toe_agent_ticket_result/1") continue;
    if (typeof parsed.ticket_id !== "string" || parsed.ticket_id.length === 0) continue;
    const stat = fs.statSync(filePath);
    const current = latestByTicket.get(parsed.ticket_id);
    if (!current || stat.mtimeMs > current.mtimeMs) {
      latestByTicket.set(parsed.ticket_id, {
        filePath,
        mtimeMs: stat.mtimeMs,
        result: parsed,
      });
    }
  }

  const claimTierCounts: Record<TierKey, number> = {
    diagnostic: 0,
    "reduced-order": 0,
    certified: 0,
  };
  const coreSummary = emptySegmentSummary();
  const extensionSummary = emptySegmentSummary();

  let weightedScoreSum = 0;
  let ticketsWithEvidence = 0;
  let verifiedPassCount = 0;
  let strictReadyCount = 0;
  let researchGatedTickets = 0;
  let researchArtifactCompleteTickets = 0;
  let coreResearchGatedTickets = 0;
  let coreResearchArtifactCompleteTickets = 0;
  let extensionResearchGatedTickets = 0;
  let extensionResearchArtifactCompleteTickets = 0;
  const missingVerifiedPassTicketIds = new Set<string>();
  const missingResearchArtifactTicketIds = new Set<string>();
  const strictReadyDeltaTargets: StrictReadyDeltaTarget[] = [];
  const mathCongruenceValidation = validateMathCongruenceMatrix({ repoRoot: process.cwd() });
  const mathCongruenceGatePass = mathCongruenceValidation.ok;

  const tickets = ticketIds.map((ticketId) => {
    const latest = latestByTicket.get(ticketId);
    if (!latest) {
      return {
        ticket_id: ticketId,
        claim_tier: null,
        verification_ok: false,
        score: 0,
        result_file: null,
      };
    }

    const claimTier = toTier(latest.result.claim_tier);
    const verificationOk =
      latest.result.casimir?.verdict === "PASS" &&
      latest.result.casimir?.integrity_ok === true;
    const score = claimTier && verificationOk ? TIER_WEIGHTS[claimTier] : 0;
    const requiredArtifacts = artifactRequirementsByTicket.get(ticketId) ?? new Set<string>();
    const isResearchGated = requiredArtifacts.size > 0;
    const reportedResearchArtifacts = new Set(
      Array.isArray(latest.result.research_artifacts)
        ? latest.result.research_artifacts
            .map((value) => String(value).trim())
            .filter((value) => value.length > 0)
        : [],
    );
    const researchArtifactComplete =
      requiredArtifacts.size === 0 ||
      [...requiredArtifacts].every((requiredArtifact) => reportedResearchArtifacts.has(requiredArtifact));
    const strictReadyEligibleTier = claimTier === "reduced-order" || claimTier === "certified";
    const isStrictReady = verificationOk && strictReadyEligibleTier && mathCongruenceGatePass;

    if (isResearchGated) {
      researchGatedTickets += 1;
      if (researchArtifactComplete) {
        researchArtifactCompleteTickets += 1;
      }
      if (coreTicketIdSet.has(ticketId)) {
        coreResearchGatedTickets += 1;
        if (researchArtifactComplete) {
          coreResearchArtifactCompleteTickets += 1;
        }
      }
      if (extensionTicketIdSet.has(ticketId)) {
        extensionResearchGatedTickets += 1;
        if (researchArtifactComplete) {
          extensionResearchArtifactCompleteTickets += 1;
        }
      }
    }

    if (claimTier) {
      claimTierCounts[claimTier] += 1;
      if (coreTicketIdSet.has(ticketId)) {
        coreSummary.claim_tier_counts[claimTier] += 1;
      }
      if (extensionTicketIdSet.has(ticketId)) {
        extensionSummary.claim_tier_counts[claimTier] += 1;
      }
    }
    if (score > 0) {
      ticketsWithEvidence += 1;
      if (coreTicketIdSet.has(ticketId)) {
        coreSummary.tickets_with_evidence += 1;
      }
      if (extensionTicketIdSet.has(ticketId)) {
        extensionSummary.tickets_with_evidence += 1;
      }
    }
    if (verificationOk) {
      verifiedPassCount += 1;
      if (coreTicketIdSet.has(ticketId)) {
        coreSummary.verified_pass_tickets += 1;
      }
      if (extensionTicketIdSet.has(ticketId)) {
        extensionSummary.verified_pass_tickets += 1;
      }
    } else {
      missingVerifiedPassTicketIds.add(ticketId);
    }
    if (isResearchGated && !researchArtifactComplete) {
      missingResearchArtifactTicketIds.add(ticketId);
    }
    if (isStrictReady) {
      strictReadyCount += 1;
      if (coreTicketIdSet.has(ticketId)) {
        coreSummary.strict_ready_progress_pct += 1;
      }
      if (extensionTicketIdSet.has(ticketId)) {
        extensionSummary.strict_ready_progress_pct += 1;
      }
    }

    if (!isStrictReady) {
      strictReadyDeltaTargets.push({
        ticket_id: ticketId,
        next_strict_ready_claim_tier: claimTier === "certified" ? "certified" : "reduced-order",
        requires_verified_pass: true,
        requires_research_artifact_completion: isResearchGated && !researchArtifactComplete,
        requires_math_congruence: !mathCongruenceGatePass,
      });
    }

    weightedScoreSum += score;
    if (coreTicketIdSet.has(ticketId)) {
      coreSummary.weighted_score_sum += score;
    }
    if (extensionTicketIdSet.has(ticketId)) {
      extensionSummary.weighted_score_sum += score;
    }
    return {
      ticket_id: ticketId,
      claim_tier: claimTier,
      verification_ok: verificationOk,
      score,
      research_gated: isResearchGated,
      research_artifact_complete: researchArtifactComplete,
      result_file: normalizePath(path.relative(process.cwd(), latest.filePath)),
    };
  });

  const totalTickets = ticketIds.length;
  const normalizedProgress = totalTickets > 0 ? weightedScoreSum / totalTickets : 0;
  const strictReadyProgress = totalTickets > 0 ? strictReadyCount / totalTickets : 0;
  const verifiedPassProgress = totalTickets > 0 ? verifiedPassCount / totalTickets : 0;
  const forestOwnerCoverage = computeForestOwnerCoveragePct();
  const strictReadyDeltaTicketCount = Math.max(totalTickets - strictReadyCount, 0);
  const missingMathCongruenceTicketIds = mathCongruenceGatePass
    ? new Set<string>()
    : new Set(ticketIds);
  const blockedTicketIds = new Set<string>([
    ...missingVerifiedPassTicketIds,
    ...missingResearchArtifactTicketIds,
    ...missingMathCongruenceTicketIds,
  ]);
  const blockerCounts = {
    missing_verified_pass: missingVerifiedPassTicketIds.size,
    missing_research_artifacts: missingResearchArtifactTicketIds.size,
    missing_math_congruence: missingMathCongruenceTicketIds.size,
  };
  const blockedTicketCount = blockedTicketIds.size;
  const readyTicketCount = Math.max(totalTickets - blockedTicketCount, 0);
  const strictReadyReleaseGate: StrictReadyReleaseGate = {
    status:
      blockedTicketCount === 0
        ? "ready"
        : "blocked",
    blocked_reasons: [
      ...(blockerCounts.missing_verified_pass > 0 ? (["missing_verified_pass"] as const) : []),
      ...(blockerCounts.missing_research_artifacts > 0
        ? (["missing_research_artifacts"] as const)
        : []),
      ...(blockerCounts.missing_math_congruence > 0
        ? (["missing_math_congruence"] as const)
        : []),
    ],
    blocked_ticket_count: blockedTicketCount,
    ready_ticket_count: readyTicketCount,
    blocker_counts: blockerCounts,
  };

  coreSummary.tickets_total = coreTicketIdSet.size;
  extensionSummary.tickets_total = extensionTicketIdSet.size;
  coreSummary.toe_progress_pct =
    coreSummary.tickets_total > 0
      ? toProgressPercent(coreSummary.weighted_score_sum / coreSummary.tickets_total)
      : 0;
  extensionSummary.toe_progress_pct =
    extensionSummary.tickets_total > 0
      ? toProgressPercent(extensionSummary.weighted_score_sum / extensionSummary.tickets_total)
      : 0;
  coreSummary.strict_ready_progress_pct =
    coreSummary.tickets_total > 0
      ? toProgressPercent(coreSummary.strict_ready_progress_pct / coreSummary.tickets_total)
      : 0;
  extensionSummary.strict_ready_progress_pct =
    extensionSummary.tickets_total > 0
      ? toProgressPercent(extensionSummary.strict_ready_progress_pct / extensionSummary.tickets_total)
      : 0;
  coreSummary.verified_pass_progress_pct =
    coreSummary.tickets_total > 0
      ? toProgressPercent(coreSummary.verified_pass_tickets / coreSummary.tickets_total)
      : 0;
  extensionSummary.verified_pass_progress_pct =
    extensionSummary.tickets_total > 0
      ? toProgressPercent(extensionSummary.verified_pass_tickets / extensionSummary.tickets_total)
      : 0;

  coreSummary.weighted_score_sum = Math.round(coreSummary.weighted_score_sum * 1000) / 1000;
  extensionSummary.weighted_score_sum =
    Math.round(extensionSummary.weighted_score_sum * 1000) / 1000;

  const snapshot = {
    schema_version: "toe_progress_snapshot/1",
    generated_at: new Date().toISOString(),
    source: {
      backlog: normalizePath(path.relative(process.cwd(), BACKLOG_PATH)),
      extension_backlog: extensionBacklogPresent
        ? normalizePath(path.relative(process.cwd(), EXTENSION_BACKLOG_PATH))
        : null,
      results_dir: normalizePath(path.relative(process.cwd(), RESULTS_DIR)),
      resolver_owner_coverage_manifest: normalizePath(
        path.relative(process.cwd(), RESOLVER_OWNER_COVERAGE_MANIFEST_PATH),
      ),
    },
    weights: TIER_WEIGHTS,
    totals: {
      tickets_total: totalTickets,
      tickets_with_evidence: ticketsWithEvidence,
      claim_tier_counts: claimTierCounts,
      weighted_score_sum: Math.round(weightedScoreSum * 1000) / 1000,
      toe_progress_pct: toProgressPercent(normalizedProgress),
      verified_pass_tickets: verifiedPassCount,
      verified_pass_progress_pct: toProgressPercent(verifiedPassProgress),
      forest_owner_coverage_pct: toProgressPercent(forestOwnerCoverage),
      strict_ready_progress_pct: toProgressPercent(strictReadyProgress),
      strict_ready_delta_ticket_count: strictReadyDeltaTicketCount,
      strict_ready_release_gate: strictReadyReleaseGate,
      math_congruence_gate: {
        status: mathCongruenceGatePass ? "pass" : "fail",
        errors: mathCongruenceValidation.errors,
      },
      research_gated_tickets_total: researchGatedTickets,
      research_artifact_complete_tickets_total: researchArtifactCompleteTickets,
    },
    segments: {
      core: {
        ...coreSummary,
        research_gated_tickets_total: coreResearchGatedTickets,
        research_artifact_complete_tickets_total: coreResearchArtifactCompleteTickets,
      },
      extension: {
        ...extensionSummary,
        research_gated_tickets_total: extensionResearchGatedTickets,
        research_artifact_complete_tickets_total: extensionResearchArtifactCompleteTickets,
      },
      combined: {
        tickets_total: totalTickets,
        tickets_with_evidence: ticketsWithEvidence,
        claim_tier_counts: claimTierCounts,
        weighted_score_sum: Math.round(weightedScoreSum * 1000) / 1000,
        toe_progress_pct: toProgressPercent(normalizedProgress),
        verified_pass_tickets: verifiedPassCount,
        verified_pass_progress_pct: toProgressPercent(verifiedPassProgress),
        strict_ready_progress_pct: toProgressPercent(strictReadyProgress),
        strict_ready_delta_ticket_count: strictReadyDeltaTicketCount,
        strict_ready_release_gate: strictReadyReleaseGate,
        research_gated_tickets_total: researchGatedTickets,
        research_artifact_complete_tickets_total: researchArtifactCompleteTickets,
      },
    },
    strict_ready_delta_targets: strictReadyDeltaTargets,
    tickets,
  };

  fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  console.log(
    `toe-progress snapshot written: ${normalizePath(path.relative(process.cwd(), SNAPSHOT_PATH))} toe_progress_pct=${snapshot.totals.toe_progress_pct} forest_owner_coverage_pct=${snapshot.totals.forest_owner_coverage_pct}`,
  );
}

main();
