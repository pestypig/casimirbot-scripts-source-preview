import fs from "node:fs";
import path from "node:path";

type Checklist = {
  schema_version?: string;
  kind?: string;
  tree_dag_guardrails?: {
    required_defaults?: Record<string, unknown>;
  };
  major_context_areas?: Array<{ id?: string }>;
  required_tests?: string[];
  execution_steps?: Array<{ id?: string }>;
  claim_tiers?: Array<{ tier?: string }>;
  verification_contract?: {
    casimir_verify_required?: boolean;
    certificate_required_for_certified?: boolean;
  };
};

type PrimitiveManifest = {
  schema_version?: string;
  primitives?: PrimitiveEntry[];
};

type PrimitiveEntry = {
  primitive_id?: string;
  tree_owner?: string;
  policy_source?: { path?: string; selector?: string };
  evaluator?: { path?: string; symbol?: string };
  tests?: string[];
};

type ToeBacklog = {
  tickets?: Array<{
    id?: string;
    tree_owner?: string;
    required_tests?: string[];
  }>;
};

const repoRoot = process.cwd();

const CHECKLIST_PATH = path.resolve(
  process.env.AGENT_CONTEXT_CHECKLIST_PATH ??
    path.join("docs", "audits", "helix-agent-context-checklist-2026-02-17.json"),
);
const WARP_AGENTS_PATH = path.resolve(
  process.env.WARP_AGENTS_PATH ?? path.join(repoRoot, "WARP_AGENTS.md"),
);
const PRIMITIVE_MANIFEST_PATH = path.resolve(
  process.env.WARP_PRIMITIVE_MANIFEST_PATH ??
    path.join(repoRoot, "configs", "warp-primitive-manifest.v1.json"),
);
const TOE_BACKLOG_PATH = path.resolve(
  process.env.TOE_BACKLOG_PATH ??
    path.join(repoRoot, "docs", "audits", "toe-cloud-agent-ticket-backlog-2026-02-17.json"),
);

const REQUIRED_DEFAULTS = {
  allowedCL: "CL4",
  allowConceptual: false,
  allowProxies: false,
  chart: "comoving_cartesian",
  seedOrder: "lex",
  walkMode: "bfs",
};

const REQUIRED_CONTEXT_IDS = [
  "gr_policy_fallback",
  "proof_pack_contract",
  "curvature_unit_contract",
  "gr_os_actions",
  "certificate_drift_recheck",
  "constraint_pack_policy_profiles",
  "ts_autoscale_semantics",
];

const REQUIRED_STEP_IDS = [
  "select_scope",
  "validate_policy_source",
  "update_contract_then_runtime",
  "maintain_proof_pack_parity",
  "enforce_curvature_contract",
  "run_required_tests",
  "run_casimir_verify",
  "record_policy_profile_context",
  "emit_artifact_bundle",
  "assign_claim_tier",
];

const REQUIRED_TIERS = ["diagnostic", "reduced-order", "certified"];

function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function parseWarpAgentsRequiredTests(markdown: string): string[] {
  const match = markdown.match(/```json\s+warp-agents\s*([\s\S]*?)```/i);
  if (!match) {
    throw new Error("No `json warp-agents` block found in WARP_AGENTS.md.");
  }
  const parsed = JSON.parse(match[1]) as { requiredTests?: unknown };
  if (!Array.isArray(parsed.requiredTests)) {
    throw new Error("WARP_AGENTS requiredTests is missing or invalid.");
  }
  return parsed.requiredTests
    .map((value) => String(value))
    .filter((value) => value.length > 0);
}

function validateChecklist(checklist: Checklist): string[] {
  const errors: string[] = [];
  if (checklist.schema_version !== "helix_agent_context_checklist/1") {
    errors.push(
      `schema_version must be helix_agent_context_checklist/1 (received ${String(checklist.schema_version)}).`,
    );
  }
  if (checklist.kind !== "agent_execution_checklist") {
    errors.push(`kind must be agent_execution_checklist (received ${String(checklist.kind)}).`);
  }

  const defaults = checklist.tree_dag_guardrails?.required_defaults ?? {};
  for (const [key, expected] of Object.entries(REQUIRED_DEFAULTS)) {
    if ((defaults as Record<string, unknown>)[key] !== expected) {
      errors.push(
        `tree_dag_guardrails.required_defaults.${key} must be ${JSON.stringify(expected)}.`,
      );
    }
  }

  const contextIds = new Set(
    (checklist.major_context_areas ?? [])
      .map((entry) => entry.id)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  for (const id of REQUIRED_CONTEXT_IDS) {
    if (!contextIds.has(id)) {
      errors.push(`major_context_areas missing required id: ${id}`);
    }
  }

  const stepIds = new Set(
    (checklist.execution_steps ?? [])
      .map((entry) => entry.id)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  for (const id of REQUIRED_STEP_IDS) {
    if (!stepIds.has(id)) {
      errors.push(`execution_steps missing required id: ${id}`);
    }
  }

  const tiers = new Set(
    (checklist.claim_tiers ?? [])
      .map((entry) => entry.tier)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  for (const tier of REQUIRED_TIERS) {
    if (!tiers.has(tier)) {
      errors.push(`claim_tiers missing required tier: ${tier}`);
    }
  }

  const requiredTests = checklist.required_tests ?? [];
  if (!Array.isArray(requiredTests) || requiredTests.length === 0) {
    errors.push("required_tests must be a non-empty array.");
  }

  if (checklist.verification_contract?.casimir_verify_required !== true) {
    errors.push("verification_contract.casimir_verify_required must be true.");
  }
  if (checklist.verification_contract?.certificate_required_for_certified !== true) {
    errors.push("verification_contract.certificate_required_for_certified must be true.");
  }

  return errors;
}

function validateRequiredTestsParity(checklistTests: string[], warpTests: string[]): string[] {
  const errors: string[] = [];
  const checklistSet = new Set(checklistTests);
  const warpSet = new Set(warpTests);

  const missingFromChecklist = [...warpSet].filter((entry) => !checklistSet.has(entry));
  const extraInChecklist = [...checklistSet].filter((entry) => !warpSet.has(entry));

  if (missingFromChecklist.length > 0) {
    errors.push(
      `required_tests missing entries from WARP_AGENTS: ${missingFromChecklist.join(", ")}`,
    );
  }
  if (extraInChecklist.length > 0) {
    errors.push(
      `required_tests has entries not present in WARP_AGENTS: ${extraInChecklist.join(", ")}`,
    );
  }

  return errors;
}

export function validateManifest(
  manifest: PrimitiveManifest,
  backlog: ToeBacklog,
  expectedChecklistTests: string[],
  baseDir: string = repoRoot,
): string[] {
  const errors: string[] = [];

  if (manifest.schema_version !== "warp_primitive_manifest/1") {
    errors.push(
      `primitive manifest schema_version must be warp_primitive_manifest/1 (received ${String(
        manifest.schema_version,
      )}).`,
    );
  }

  const primitives = manifest.primitives ?? [];
  if (!Array.isArray(primitives) || primitives.length === 0) {
    errors.push("primitive manifest must define a non-empty primitives array.");
    return errors;
  }

  const backlogMap = new Map(
    (backlog.tickets ?? [])
      .filter((entry) => typeof entry.id === "string" && entry.id.length > 0)
      .map((entry) => [entry.id as string, entry]),
  );

  const primitiveIds = new Set<string>();
  for (const primitive of primitives) {
    const primitiveId = primitive.primitive_id?.trim() ?? "";
    if (!primitiveId) {
      errors.push("primitive entry missing primitive_id.");
      continue;
    }
    if (primitiveIds.has(primitiveId)) {
      errors.push(`primitive manifest has duplicate primitive_id: ${primitiveId}`);
    }
    primitiveIds.add(primitiveId);

    if (!primitive.policy_source?.path?.trim()) {
      errors.push(`manifest ${primitiveId} missing policy_source.path.`);
    } else if (!fileExists(path.resolve(baseDir, primitive.policy_source.path))) {
      errors.push(`manifest ${primitiveId} policy_source.path does not exist: ${primitive.policy_source.path}`);
    }

    if (!primitive.evaluator?.path?.trim()) {
      errors.push(`manifest ${primitiveId} missing evaluator.path.`);
    } else if (!fileExists(path.resolve(baseDir, primitive.evaluator.path))) {
      errors.push(`manifest ${primitiveId} evaluator.path does not exist: ${primitive.evaluator.path}`);
    }

    const tests = (primitive.tests ?? []).map((entry) => entry.trim()).filter(Boolean);
    if (tests.length === 0) {
      errors.push(`manifest ${primitiveId} must include at least one test.`);
    }
    for (const testPath of tests) {
      if (!fileExists(path.resolve(baseDir, testPath))) {
        errors.push(`manifest ${primitiveId} test path does not exist: ${testPath}`);
      }
    }

    const backlogEntry = backlogMap.get(primitiveId);
    if (!backlogEntry) {
      errors.push(`manifest ${primitiveId} has no matching ticket in TOE backlog.`);
      continue;
    }

    if ((backlogEntry.tree_owner ?? "") !== (primitive.tree_owner ?? "")) {
      errors.push(
        `manifest ${primitiveId} tree_owner mismatch (manifest=${String(
          primitive.tree_owner,
        )}, backlog=${String(backlogEntry.tree_owner)}).`,
      );
    }

    const backlogTests = new Set((backlogEntry.required_tests ?? []).map((entry) => String(entry)));
    const missingBacklogTests = tests.filter((entry) => !backlogTests.has(entry));
    if (missingBacklogTests.length > 0) {
      errors.push(
        `manifest ${primitiveId} tests missing from backlog required_tests: ${missingBacklogTests.join(", ")}`,
      );
    }

    const checklistSet = new Set(expectedChecklistTests);
    const overlapChecklistTests = tests.filter((entry) => checklistSet.has(entry));
    if (overlapChecklistTests.length === 0) {
      errors.push(
        `manifest ${primitiveId} must include at least one test from checklist required_tests.`,
      );
    }
  }

  return errors;
}

function main() {
  const errors: string[] = [];
  if (!fileExists(CHECKLIST_PATH)) {
    errors.push(`Checklist file not found: ${CHECKLIST_PATH}`);
  }
  if (!fileExists(WARP_AGENTS_PATH)) {
    errors.push(`WARP agents file not found: ${WARP_AGENTS_PATH}`);
  }
  if (!fileExists(PRIMITIVE_MANIFEST_PATH)) {
    errors.push(`Primitive manifest file not found: ${PRIMITIVE_MANIFEST_PATH}`);
  }
  if (!fileExists(TOE_BACKLOG_PATH)) {
    errors.push(`TOE backlog file not found: ${TOE_BACKLOG_PATH}`);
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  const checklistRaw = fs.readFileSync(CHECKLIST_PATH, "utf8");
  const checklist = JSON.parse(checklistRaw) as Checklist;
  errors.push(...validateChecklist(checklist));

  const checklistTests = (checklist.required_tests ?? [])
    .map((entry) => String(entry))
    .filter((entry) => entry.length > 0);

  const warpRaw = fs.readFileSync(WARP_AGENTS_PATH, "utf8");
  const warpTests = parseWarpAgentsRequiredTests(warpRaw);
  errors.push(...validateRequiredTestsParity(checklistTests, warpTests));

  const manifestRaw = fs.readFileSync(PRIMITIVE_MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(manifestRaw) as PrimitiveManifest;

  const backlogRaw = fs.readFileSync(TOE_BACKLOG_PATH, "utf8");
  const backlog = JSON.parse(backlogRaw) as ToeBacklog;
  errors.push(...validateManifest(manifest, backlog, checklistTests));

  if (errors.length > 0) {
    console.error("agent-context-checklist validation failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(
    `agent-context-checklist validation OK. checklist_tests=${checklistTests.length} warp_tests=${warpTests.length} primitives=${manifest.primitives?.length ?? 0}`,
  );
}

if (!process.env.VITEST) {
  main();
}
