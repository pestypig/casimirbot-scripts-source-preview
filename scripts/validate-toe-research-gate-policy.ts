import fs from "node:fs";
import path from "node:path";

type RiskClass = "contract_only" | "runtime_contract" | "physics_unknown" | "tier_promotion";

type ResearchGate = {
  risk_class?: RiskClass;
  requires_audit?: boolean;
  requires_research?: boolean;
  required_artifacts?: string[];
};

type PolicyManifest = {
  schema_version?: string;
  kind?: string;
  deterministic_gate_fields?: string[];
  risk_policies?: Partial<Record<RiskClass, ResearchGate>>;
};

type Ticket = {
  id?: string;
  research_gate?: ResearchGate;
};

type Backlog = {
  tickets?: Ticket[];
};

const POLICY_PATH = path.resolve(
  process.env.TOE_RESEARCH_GATE_POLICY_PATH ?? path.join("configs", "toe-research-gate-policy.v1.json"),
);

const PRIMARY_BACKLOG_PATH = path.resolve(
  process.env.TOE_TICKET_BACKLOG_PATH ??
    path.join("docs", "audits", "toe-cloud-agent-ticket-backlog-2026-02-17.json"),
);

const EXTENSION_BACKLOG_PATH = path.resolve(
  process.env.TOE_TICKET_EXTENSION_BACKLOG_PATH ??
    path.join("docs", "audits", "toe-coverage-extension-backlog-2026-02-18.json"),
);

const REQUIRED_FIELDS = [
  "risk_class",
  "requires_audit",
  "requires_research",
  "required_artifacts",
] as const;

const RISK_CLASSES: RiskClass[] = ["contract_only", "runtime_contract", "physics_unknown", "tier_promotion"];

const RESEARCH_REQUIRED = new Set<RiskClass>(["physics_unknown", "tier_promotion"]);

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function parseBacklogTickets(backlogPath: string): Ticket[] {
  if (!fs.existsSync(backlogPath)) {
    return [];
  }
  const parsed = readJson<Backlog>(backlogPath);
  return Array.isArray(parsed.tickets) ? parsed.tickets : [];
}

function validateResearchGate(
  value: ResearchGate | undefined,
  location: string,
  errors: string[],
  policy: Partial<Record<RiskClass, ResearchGate>>,
) {
  if (!value) {
    return;
  }

  const riskClass = value.risk_class;
  if (!riskClass || !RISK_CLASSES.includes(riskClass)) {
    errors.push(`${location}.risk_class must be one of ${RISK_CLASSES.join("|")}`);
    return;
  }

  const requiresAudit = value.requires_audit;
  const requiresResearch = value.requires_research;
  const requiredArtifacts = Array.isArray(value.required_artifacts)
    ? value.required_artifacts.map((entry) => String(entry).trim()).filter(Boolean)
    : [];

  if (typeof requiresAudit !== "boolean") {
    errors.push(`${location}.requires_audit must be boolean`);
  }

  if (typeof requiresResearch !== "boolean") {
    errors.push(`${location}.requires_research must be boolean`);
  }

  if (!Array.isArray(value.required_artifacts)) {
    errors.push(`${location}.required_artifacts must be an array`);
  }

  if (Array.isArray(value.required_artifacts) && requiredArtifacts.length !== value.required_artifacts.length) {
    errors.push(`${location}.required_artifacts must not contain empty entries`);
  }

  if (requiredArtifacts.length !== new Set(requiredArtifacts).size) {
    errors.push(`${location}.required_artifacts must not contain duplicates`);
  }

  const policyForRisk = policy[riskClass];
  const effectiveRequiresResearch =
    typeof requiresResearch === "boolean"
      ? requiresResearch
      : policyForRisk?.requires_research === true;

  const requireArtifacts = RESEARCH_REQUIRED.has(riskClass) || effectiveRequiresResearch;
  if (requireArtifacts && requiredArtifacts.length === 0) {
    errors.push(
      `${location}.required_artifacts must be non-empty for risk_class=${riskClass} (research-gated risk)`,
    );
  }
}

function main() {
  const errors: string[] = [];

  if (!fs.existsSync(POLICY_PATH)) {
    errors.push(`policy not found: ${normalizePath(path.relative(process.cwd(), POLICY_PATH))}`);
  }

  let policy: PolicyManifest | null = null;
  if (errors.length === 0) {
    try {
      policy = readJson<PolicyManifest>(POLICY_PATH);
    } catch (error) {
      errors.push(`invalid policy JSON: ${String(error)}`);
    }
  }

  const policyMap: Partial<Record<RiskClass, ResearchGate>> = {};

  if (policy) {
    if (policy.schema_version !== "toe_research_gate_policy/1") {
      errors.push("schema_version must be toe_research_gate_policy/1");
    }

    if (policy.kind !== "toe_research_gate_policy") {
      errors.push("kind must be toe_research_gate_policy");
    }

    const deterministicFields = Array.isArray(policy.deterministic_gate_fields)
      ? policy.deterministic_gate_fields
      : [];

    for (const field of REQUIRED_FIELDS) {
      if (!deterministicFields.includes(field)) {
        errors.push(`deterministic_gate_fields missing required field: ${field}`);
      }
    }

    const riskPolicies = policy.risk_policies ?? {};
    for (const riskClass of RISK_CLASSES) {
      const entry = riskPolicies[riskClass];
      if (!entry) {
        errors.push(`risk_policies.${riskClass} is required`);
        continue;
      }
      policyMap[riskClass] = entry;
      validateResearchGate(entry, `risk_policies.${riskClass}`, errors, {});
    }
  }

  const tickets = [
    ...parseBacklogTickets(PRIMARY_BACKLOG_PATH),
    ...parseBacklogTickets(EXTENSION_BACKLOG_PATH),
  ];

  tickets.forEach((ticket, index) => {
    if (!ticket.research_gate) {
      return;
    }

    const ticketId = typeof ticket.id === "string" && ticket.id.trim().length > 0 ? ticket.id.trim() : `#${index}`;
    validateResearchGate(ticket.research_gate, `ticket(${ticketId}).research_gate`, errors, policyMap);
  });

  if (errors.length > 0) {
    console.error("toe-research-gate-policy validation failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(
    `toe-research-gate-policy validation OK. policy=${normalizePath(path.relative(process.cwd(), POLICY_PATH))} tickets_with_metadata=${tickets.filter((ticket) => ticket.research_gate).length}`,
  );
}

main();
