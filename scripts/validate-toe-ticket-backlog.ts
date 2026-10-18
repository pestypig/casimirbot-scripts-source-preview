import fs from "node:fs";
import path from "node:path";

type Ticket = {
  id?: string;
  tree_owner?: string;
  gap_refs?: string[];
  primitive?: string;
  primary_path_prefix?: string;
  allowed_paths?: string[];
  required_tests?: string[];
  done_criteria?: string[];
  research_gate?: {
    risk_class?: "contract_only" | "runtime_contract" | "physics_unknown" | "tier_promotion";
    requires_audit?: boolean;
    requires_research?: boolean;
    required_artifacts?: string[];
  };
};

type Backlog = {
  schema_version?: string;
  kind?: string;
  tickets?: Ticket[];
};

const BACKLOG_PATH = path.resolve(
  process.env.TOE_TICKET_BACKLOG_PATH ??
    path.join("docs", "audits", "toe-cloud-agent-ticket-backlog-2026-02-17.json"),
);

const VALID_TREE_OWNERS = new Set<string>([
  "physics-foundations",
  "gr-solver",
  "uncertainty-mechanics",
  "trace-system",
  "agi-runtime",
  "ideology",
  "security-hull-guard",
  "ops-deployment",
  "math",
]);

const errors: string[] = [];
const RISK_CLASSES = new Set(["contract_only", "runtime_contract", "physics_unknown", "tier_promotion"]);
const RESEARCH_GATED_RISK_CLASSES = new Set(["physics_unknown", "tier_promotion"]);

function fail(message: string) {
  errors.push(message);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function includesScope(pathValue: string, scopeValue: string): boolean {
  return pathValue === scopeValue || pathValue.startsWith(`${scopeValue}/`);
}

function main() {
  if (!fs.existsSync(BACKLOG_PATH)) {
    fail(`Backlog file not found: ${BACKLOG_PATH}`);
    flushAndExit();
    return;
  }

  const raw = fs.readFileSync(BACKLOG_PATH, "utf8");
  const parsed = JSON.parse(raw) as Backlog;

  if (parsed.schema_version !== "toe_cloud_ticket_backlog/1") {
    fail(
      `schema_version must be toe_cloud_ticket_backlog/1 (received ${String(parsed.schema_version)}).`,
    );
  }

  if (parsed.kind !== "toe_ticket_backlog") {
    fail(`kind must be toe_ticket_backlog (received ${String(parsed.kind)}).`);
  }

  const tickets = parsed.tickets ?? [];
  if (!Array.isArray(tickets) || tickets.length === 0) {
    fail("tickets must be a non-empty array.");
    flushAndExit();
    return;
  }

  const ids = new Set<string>();
  const primaryPrefixes = new Set<string>();
  const nonTestAllowedPaths: Array<{ ticketId: string; pathValue: string }> = [];

  for (const [index, ticket] of tickets.entries()) {
    const loc = `tickets[${index}]`;

    const id = typeof ticket.id === "string" ? ticket.id.trim() : "";
    if (!id) {
      fail(`${loc}.id is required.`);
      continue;
    }
    if (!/^TOE-\d{3}-[a-z0-9-]+$/.test(id)) {
      fail(`${loc}.id has invalid format: ${id}`);
    }
    if (ids.has(id)) {
      fail(`${loc}.id is duplicated: ${id}`);
    }
    ids.add(id);

    const treeOwner = typeof ticket.tree_owner === "string" ? ticket.tree_owner.trim() : "";
    if (!VALID_TREE_OWNERS.has(treeOwner)) {
      fail(`${loc}.tree_owner is invalid: ${treeOwner || "<missing>"}`);
    }

    const primitive = typeof ticket.primitive === "string" ? ticket.primitive.trim() : "";
    if (!primitive) {
      fail(`${loc}.primitive is required.`);
    }

    const primary =
      typeof ticket.primary_path_prefix === "string"
        ? normalizePath(ticket.primary_path_prefix)
        : "";
    if (!primary) {
      fail(`${loc}.primary_path_prefix is required.`);
    } else if (primaryPrefixes.has(primary)) {
      fail(`${loc}.primary_path_prefix duplicated: ${primary}`);
    } else {
      primaryPrefixes.add(primary);
    }

    const allowed = Array.isArray(ticket.allowed_paths)
      ? ticket.allowed_paths.map((value) => normalizePath(String(value))).filter(Boolean)
      : [];
    if (allowed.length === 0) {
      fail(`${loc}.allowed_paths must be non-empty.`);
    }

    if (primary && !allowed.some((value) => includesScope(primary, value) || includesScope(value, primary))) {
      fail(`${loc}.primary_path_prefix must be present within allowed_paths scope.`);
    }

    const requiredTests = Array.isArray(ticket.required_tests)
      ? ticket.required_tests.map((value) => normalizePath(String(value))).filter(Boolean)
      : [];
    if (requiredTests.length === 0) {
      fail(`${loc}.required_tests must be non-empty.`);
    }

    const allowedSet = new Set(allowed);
    for (const requiredTest of requiredTests) {
      if (!allowedSet.has(requiredTest)) {
        fail(`${loc}.required_tests contains path not in allowed_paths: ${requiredTest}`);
      }
    }

    const doneCriteria = Array.isArray(ticket.done_criteria)
      ? ticket.done_criteria.map((value) => String(value).trim()).filter(Boolean)
      : [];
    if (doneCriteria.length < 3) {
      fail(`${loc}.done_criteria must contain at least 3 entries.`);
    }

    const researchGate = ticket.research_gate;
    if (researchGate !== undefined) {
      const riskClass =
        typeof researchGate.risk_class === "string" ? researchGate.risk_class.trim() : "";
      if (!RISK_CLASSES.has(riskClass)) {
        fail(`${loc}.research_gate.risk_class must be one of contract_only|runtime_contract|physics_unknown|tier_promotion.`);
      }

      if (typeof researchGate.requires_audit !== "boolean") {
        fail(`${loc}.research_gate.requires_audit must be boolean.`);
      }

      if (typeof researchGate.requires_research !== "boolean") {
        fail(`${loc}.research_gate.requires_research must be boolean.`);
      }

      const requiredArtifacts = Array.isArray(researchGate.required_artifacts)
        ? researchGate.required_artifacts.map((value) => String(value).trim()).filter(Boolean)
        : [];
      if (!Array.isArray(researchGate.required_artifacts)) {
        fail(`${loc}.research_gate.required_artifacts must be an array.`);
      } else if (requiredArtifacts.length !== researchGate.required_artifacts.length) {
        fail(`${loc}.research_gate.required_artifacts must not contain empty entries.`);
      }

      if (requiredArtifacts.length !== new Set(requiredArtifacts).size) {
        fail(`${loc}.research_gate.required_artifacts must not contain duplicates.`);
      }

      if (
        (RESEARCH_GATED_RISK_CLASSES.has(riskClass) || researchGate.requires_research === true) &&
        requiredArtifacts.length === 0
      ) {
        fail(
          `${loc}.research_gate.required_artifacts must be non-empty when risk_class is physics_unknown|tier_promotion or requires_research=true.`,
        );
      }
    }

    for (const pathValue of allowed) {
      if (!pathValue.startsWith("tests/")) {
        nonTestAllowedPaths.push({ ticketId: id, pathValue });
      }
    }
  }

  const primaryList = [...primaryPrefixes];
  for (let i = 0; i < primaryList.length; i += 1) {
    for (let j = i + 1; j < primaryList.length; j += 1) {
      if (pathsOverlap(primaryList[i], primaryList[j])) {
        fail(`primary_path_prefix overlap detected: ${primaryList[i]} <-> ${primaryList[j]}`);
      }
    }
  }

  for (let i = 0; i < nonTestAllowedPaths.length; i += 1) {
    for (let j = i + 1; j < nonTestAllowedPaths.length; j += 1) {
      const a = nonTestAllowedPaths[i];
      const b = nonTestAllowedPaths[j];
      if (a.ticketId === b.ticketId) {
        continue;
      }
      if (pathsOverlap(a.pathValue, b.pathValue)) {
        fail(
          `allowed_paths overlap across tickets: ${a.ticketId}:${a.pathValue} <-> ${b.ticketId}:${b.pathValue}`,
        );
      }
    }
  }

  flushAndExit();
}

function flushAndExit() {
  if (errors.length > 0) {
    console.error("toe-ticket-backlog validation failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(
    `toe-ticket-backlog validation OK. tickets=${countTickets()} path=${normalizePath(path.relative(process.cwd(), BACKLOG_PATH))}`,
  );
}

function countTickets(): number {
  if (!fs.existsSync(BACKLOG_PATH)) {
    return 0;
  }
  const parsed = JSON.parse(fs.readFileSync(BACKLOG_PATH, "utf8")) as Backlog;
  return Array.isArray(parsed.tickets) ? parsed.tickets.length : 0;
}

main();
