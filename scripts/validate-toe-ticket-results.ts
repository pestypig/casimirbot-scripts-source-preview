import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type BacklogTicket = {
  id?: string;
  allowed_paths?: string[];
  required_tests?: string[];
  research_gate?: {
    required_artifacts?: string[];
  };
};

type Backlog = {
  tickets?: BacklogTicket[];
};

type TicketResult = {
  schema_version?: string;
  ticket_id?: string;
  files_changed?: string[];
  tests_run?: string[];
  claim_tier?: string;
  casimir?: {
    verdict?: string;
    trace_id?: string;
    run_id?: string | number;
    certificate_hash?: string;
    integrity_ok?: boolean;
  };
  research_artifacts?: string[];
};

type TicketScope = {
  id: string;
  allowedPaths: string[];
  requiredTests: string[];
  requiredArtifacts: string[];
};

const PRIMARY_BACKLOG_PATH = path.resolve(
  process.env.TOE_TICKET_BACKLOG_PATH ??
    path.join("docs", "audits", "toe-cloud-agent-ticket-backlog-2026-02-17.json"),
);

const EXTENSION_BACKLOG_PATH = path.resolve(
  process.env.TOE_TICKET_EXTENSION_BACKLOG_PATH ??
    path.join("docs", "audits", "toe-coverage-extension-backlog-2026-02-18.json"),
);

const RESULTS_DIR = path.resolve(
  process.env.TOE_TICKET_RESULTS_DIR ?? path.join("docs", "audits", "ticket-results"),
);

const CLAIM_TIERS = new Set(["diagnostic", "reduced-order", "certified"]);
const CASIMIR_VERDICTS = new Set(["PASS", "FAIL"]);
const REQUIRED_SCHEMA = "toe_agent_ticket_result/1";
const errors: string[] = [];

function fail(message: string) {
  errors.push(message);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function normalizePathFromAbsolute(value: string): string {
  return normalizePath(path.relative(process.cwd(), value));
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function readFlag(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[index + 1];
}

function isLikelySha(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value.trim());
}

function listJsonFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files: string[] = [];

  const walk = (root: string) => {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        files.push(fullPath);
      }
    }
  };

  walk(dir);
  return files.sort();
}

function includesScope(pathValue: string, scopeValue: string): boolean {
  return pathValue === scopeValue || pathValue.startsWith(`${scopeValue}/`);
}

function loadTicketScopes(): Map<string, TicketScope> {
  if (!fs.existsSync(PRIMARY_BACKLOG_PATH)) {
    throw new Error(`Backlog file not found: ${PRIMARY_BACKLOG_PATH}`);
  }

  const backlogPaths = [PRIMARY_BACKLOG_PATH];
  if (fs.existsSync(EXTENSION_BACKLOG_PATH)) {
    backlogPaths.push(EXTENSION_BACKLOG_PATH);
  }
  const scopes = new Map<string, TicketScope>();

  for (const backlogPath of backlogPaths) {
    const parsed = JSON.parse(fs.readFileSync(backlogPath, "utf8")) as Backlog;

    for (const ticket of parsed.tickets ?? []) {
      const id = typeof ticket.id === "string" ? ticket.id.trim() : "";
      if (!id) {
        continue;
      }

      const allowedPaths = Array.isArray(ticket.allowed_paths)
        ? ticket.allowed_paths.map((value) => normalizePath(String(value))).filter(Boolean)
        : [];
      const requiredTests = Array.isArray(ticket.required_tests)
        ? ticket.required_tests.map((value) => normalizePath(String(value))).filter(Boolean)
        : [];

      const existing = scopes.get(id);
      if (existing) {
        const mergedAllowed = Array.from(new Set([...existing.allowedPaths, ...allowedPaths]));
        const requiredArtifacts = Array.isArray(ticket.research_gate?.required_artifacts)
          ? ticket.research_gate.required_artifacts
              .map((value) => normalizePath(String(value)))
              .filter(Boolean)
          : [];
        const mergedRequired = Array.from(new Set([...existing.requiredTests, ...requiredTests]));
        const mergedArtifacts = Array.from(new Set([...existing.requiredArtifacts, ...requiredArtifacts]));
        scopes.set(id, {
          id,
          allowedPaths: mergedAllowed,
          requiredTests: mergedRequired,
          requiredArtifacts: mergedArtifacts,
        });
      } else {
        const requiredArtifacts = Array.isArray(ticket.research_gate?.required_artifacts)
          ? ticket.research_gate.required_artifacts
              .map((value) => normalizePath(String(value)))
              .filter(Boolean)
          : [];
        scopes.set(id, { id, allowedPaths, requiredTests, requiredArtifacts });
      }
    }
  }

  return scopes;
}

function getChangedFiles(baseSha: string, headSha: string): string[] {
  const command = `git diff --name-only --diff-filter=ACMR ${baseSha}...${headSha}`;
  const output = execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return output
    .split(/\r?\n/)
    .map((value) => normalizePath(value))
    .filter((value) => value.length > 0);
}

function isTicketResultPath(repoRelativePath: string): boolean {
  const normalized = normalizePath(repoRelativePath);
  const resultsPrefix = normalizePath(path.relative(process.cwd(), RESULTS_DIR));
  return normalized.startsWith(`${resultsPrefix}/`) && normalized.endsWith(".json");
}

function validateTicketResultFile(
  filePath: string,
  scopes: Map<string, TicketScope>,
  enforceResearchArtifacts: boolean,
): {
  ticketId: string | null;
  filesChanged: string[];
} {
  const repoPath = normalizePathFromAbsolute(filePath);

  let parsed: TicketResult;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as TicketResult;
  } catch (error) {
    fail(`${repoPath}: invalid JSON (${String(error)})`);
    return { ticketId: null, filesChanged: [] };
  }

  if (parsed.schema_version !== REQUIRED_SCHEMA) {
    fail(`${repoPath}: schema_version must be ${REQUIRED_SCHEMA}.`);
  }

  const ticketId = typeof parsed.ticket_id === "string" ? parsed.ticket_id.trim() : "";
  if (!ticketId) {
    fail(`${repoPath}: ticket_id is required.`);
    return { ticketId: null, filesChanged: [] };
  }

  const scope = scopes.get(ticketId);
  if (!scope) {
    fail(`${repoPath}: ticket_id is not present in backlog: ${ticketId}`);
  }

  const filesChanged = Array.isArray(parsed.files_changed)
    ? parsed.files_changed.map((value) => normalizePath(String(value))).filter(Boolean)
    : [];
  if (filesChanged.length === 0) {
    fail(`${repoPath}: files_changed must be a non-empty array.`);
  }

  const testsRun = Array.isArray(parsed.tests_run)
    ? parsed.tests_run.map((value) => normalizePath(String(value))).filter(Boolean)
    : [];
  if (testsRun.length === 0) {
    fail(`${repoPath}: tests_run must be a non-empty array.`);
  }

  const claimTier = typeof parsed.claim_tier === "string" ? parsed.claim_tier.trim() : "";
  if (!CLAIM_TIERS.has(claimTier)) {
    fail(`${repoPath}: claim_tier must be one of diagnostic|reduced-order|certified.`);
  }

  const casimir = parsed.casimir;
  if (!casimir || typeof casimir !== "object") {
    fail(`${repoPath}: casimir object is required.`);
  } else {
    const verdict = typeof casimir.verdict === "string" ? casimir.verdict.trim() : "";
    if (!CASIMIR_VERDICTS.has(verdict)) {
      fail(`${repoPath}: casimir.verdict must be PASS or FAIL.`);
    }

    const traceId = typeof casimir.trace_id === "string" ? casimir.trace_id.trim() : "";
    if (!traceId) {
      fail(`${repoPath}: casimir.trace_id is required.`);
    }

    const runId = casimir.run_id;
    if (runId === undefined || runId === null || String(runId).trim().length === 0) {
      fail(`${repoPath}: casimir.run_id is required.`);
    }

    const certificateHash =
      typeof casimir.certificate_hash === "string" ? casimir.certificate_hash.trim() : "";
    if (!certificateHash || certificateHash.length < 8) {
      fail(`${repoPath}: casimir.certificate_hash is required.`);
    }

    if (typeof casimir.integrity_ok !== "boolean") {
      fail(`${repoPath}: casimir.integrity_ok must be boolean.`);
    }

    if (claimTier === "certified" && (verdict !== "PASS" || casimir.integrity_ok !== true)) {
      fail(
        `${repoPath}: certified tier requires casimir.verdict=PASS and casimir.integrity_ok=true.`,
      );
    }
  }

  if (scope) {
    for (const changedPath of filesChanged) {
      const inScope = scope.allowedPaths.some((allowedPath) => includesScope(changedPath, allowedPath));
      if (!inScope) {
        fail(`${repoPath}: files_changed path outside ticket scope: ${changedPath}`);
      }
    }

    const researchArtifacts = Array.isArray(parsed.research_artifacts)
      ? parsed.research_artifacts.map((value) => normalizePath(String(value))).filter(Boolean)
      : [];
    const shouldCheckResearchArtifacts =
      enforceResearchArtifacts || (Array.isArray(parsed.research_artifacts) && scope.requiredArtifacts.length > 0);
    if (shouldCheckResearchArtifacts) {
      const researchArtifactSet = new Set(researchArtifacts);
      for (const requiredArtifact of scope.requiredArtifacts) {
        if (!researchArtifactSet.has(requiredArtifact)) {
          fail(`${repoPath}: required research artifact missing from research_artifacts: ${requiredArtifact}`);
        }
      }
    }

    const testsRunSet = new Set(testsRun);
    for (const requiredTest of scope.requiredTests) {
      if (!testsRunSet.has(requiredTest)) {
        fail(`${repoPath}: required test missing from tests_run: ${requiredTest}`);
      }
    }
  }

  return { ticketId, filesChanged };
}

function main() {
  const requireForTicketPathChanges = hasFlag("--require-for-ticket-path-changes");
  const enforceResearchArtifacts = hasFlag("--enforce-research-artifacts");
  const baseSha = readFlag("--base-sha");
  const headSha = readFlag("--head-sha") ?? "HEAD";

  const scopes = loadTicketScopes();

  if (requireForTicketPathChanges && (!baseSha || !isLikelySha(baseSha))) {
    fail("--require-for-ticket-path-changes requires --base-sha <git sha>.");
    flushAndExit(0, 0);
    return;
  }

  if (headSha !== "HEAD" && !isLikelySha(headSha)) {
    fail("--head-sha must be HEAD or a git sha.");
    flushAndExit(0, 0);
    return;
  }

  const allResultFiles = listJsonFilesRecursive(RESULTS_DIR);

  let filesToValidate = allResultFiles;
  let touchedTicketPaths: string[] = [];

  if (requireForTicketPathChanges && baseSha) {
    const changedFiles = getChangedFiles(baseSha, headSha);
    const changedResultFiles = changedFiles
      .filter((filePath) => isTicketResultPath(filePath))
      .map((repoPath) => path.resolve(process.cwd(), repoPath));

    touchedTicketPaths = changedFiles.filter((repoPath) => {
      for (const scope of scopes.values()) {
        if (scope.allowedPaths.some((allowedPath) => includesScope(repoPath, allowedPath))) {
          return true;
        }
      }
      return false;
    });

    if (touchedTicketPaths.length > 0 && changedResultFiles.length === 0) {
      fail(
        "PR changes ticket-scoped paths but does not include docs/audits/ticket-results/*.json output.",
      );
    }

    filesToValidate = changedResultFiles;
  }

  if (filesToValidate.length === 0) {
    flushAndExit(0, touchedTicketPaths.length);
    return;
  }

  const coveredPaths = new Set<string>();
  const seenTicketIds = new Set<string>();

  for (const filePath of filesToValidate) {
    const result = validateTicketResultFile(filePath, scopes, enforceResearchArtifacts);
    if (result.ticketId) {
      seenTicketIds.add(result.ticketId);
    }
    for (const changedPath of result.filesChanged) {
      coveredPaths.add(changedPath);
    }
  }

  if (requireForTicketPathChanges && touchedTicketPaths.length > 0) {
    const uncovered = touchedTicketPaths.filter((pathValue) => !coveredPaths.has(pathValue));
    if (uncovered.length > 0) {
      fail(
        `Changed ticket-scoped files missing from files_changed in result JSON: ${uncovered.join(", ")}`,
      );
    }
  }

  flushAndExit(seenTicketIds.size, touchedTicketPaths.length);
}

function flushAndExit(validatedTickets: number, touchedTicketPaths: number) {
  if (errors.length > 0) {
    console.error("toe-ticket-results validation failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(
    `toe-ticket-results validation OK. validated_tickets=${validatedTickets} touched_ticket_paths=${touchedTicketPaths}`,
  );
}

main();
