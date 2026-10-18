import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";

type IssueLevel = "error" | "warning" | "info";

type Issue = {
  level: IssueLevel;
  code: string;
  message: string;
  file?: string;
};

type IntRange = {
  min: number;
  max: number;
};

type AtomicTreeContract = {
  ranges: {
    Z: IntRange | null;
    n: IntRange | null;
    l: IntRange | null;
    sampleCount: IntRange | null;
  };
  defaults: {
    quantumSampleCount: number | null;
    classicalSampleCount: number | null;
  };
};

type ClaimSource = {
  kind?: string;
  citation?: string;
  equation?: string;
  url?: string;
  note?: string;
};

type ClaimRecord = {
  claimId?: string;
  statement?: string;
  maturity?: string;
  validityDomain?: {
    system?: string;
    constraints?: string[];
    applicableRange?: Record<string, unknown>;
  };
  sources?: ClaimSource[];
  repoBindings?: string[];
  notes?: string;
};

type ClaimRegistry = {
  $schema?: string;
  schemaVersion?: string;
  registryId?: string;
  domain?: string;
  updatedAt?: string;
  claims?: ClaimRecord[];
};

type PhysicsTreeNode = {
  id?: string;
  nodeType?: string;
  outputs?: Array<{ name?: string; value?: string }>;
  validity?: {
    claim_ids?: string[];
    equation_ref?: string;
    requires?: {
      equation_ref?: string;
    };
    proxy_semantics?: {
      mode?: string;
    };
  };
};

const cwd = process.cwd();
const strictMode = process.argv.includes("--strict");
const jsonOutput = process.argv.includes("--json");

const files = {
  tree: "docs/knowledge/physics/atomic-systems-tree.json",
  server: "server/routes/agi.plan.ts",
  panel: "client/src/components/ElectronOrbitalPanel.tsx",
  hook: "client/src/hooks/useElectronOrbitSim.ts",
  adapter: "client/src/lib/atomic-orbitals.ts",
  claimSchema: "docs/qa/schemas/math-claim-registry.schema.json",
  claimDir: "docs/knowledge/math-claims",
  physicsDir: "docs/knowledge/physics",
} as const;

const issues: Issue[] = [];

const REQUIRED_ATOMIC_CURVATURE_BRIDGE_CLAIMS = new Set([
  "atomic_energy_to_energy_density_proxy.v1",
  "telemetry_drift_injection_for_atomic_instrumentation.v1",
  "curvature_unit_proxy_contract.v1",
]);

const hasBridgeClaimMetadata = (claim: ClaimRecord): boolean => {
  if (!claim || typeof claim !== "object") return false;
  const validity = claim.validityDomain;
  if (!validity || typeof validity !== "object") return false;
  const hasSystem = typeof validity.system === "string" && validity.system.trim().length > 0;
  const constraints = Array.isArray(validity.constraints)
    ? validity.constraints.filter((c) => typeof c === "string" && c.trim())
    : [];
  return hasSystem && constraints.length > 0;
};

const hasBridgeClaimMaturitySafeMetadata = (claim: ClaimRecord): boolean => {
  if (typeof claim.maturity !== "string" || !claim.maturity.trim()) return false;
  if (isPlaceholderText(claim.maturity)) return false;
  if (typeof claim.notes === "string" && isPlaceholderText(claim.notes)) return false;
  return true;
};


function addIssue(level: IssueLevel, code: string, message: string, file?: string): void {
  issues.push({ level, code, message, file });
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(path.resolve(cwd, filePath), "utf8");
  } catch (error) {
    addIssue(
      "error",
      "file_read_failed",
      `${filePath}: ${(error as Error).message}`,
      filePath,
    );
    return null;
  }
}

function parseJsonText<T>(text: string, filePath: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    addIssue(
      "error",
      "json_parse_failed",
      `${filePath}: ${(error as Error).message}`,
      filePath,
    );
    return null;
  }
}

function extractRange(
  source: string,
  pattern: RegExp,
  label: string,
  filePath: string,
): IntRange | null {
  const match = source.match(pattern);
  if (!match) {
    addIssue("error", "range_extract_failed", `Missing ${label} range pattern`, filePath);
    return null;
  }
  const min = Number(match[1]);
  const max = Number(match[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    addIssue("error", "range_parse_failed", `Invalid ${label} range match`, filePath);
    return null;
  }
  return { min: Math.trunc(min), max: Math.trunc(max) };
}

function extractInteger(
  source: string,
  pattern: RegExp,
  label: string,
  filePath: string,
): number | null {
  const match = source.match(pattern);
  if (!match) {
    addIssue("error", "value_extract_failed", `Missing ${label} pattern`, filePath);
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    addIssue("error", "value_parse_failed", `Invalid ${label} value`, filePath);
    return null;
  }
  return Math.trunc(value);
}

function compareRanges(
  label: string,
  left: IntRange | null,
  right: IntRange | null,
  leftName: string,
  rightName: string,
  level: IssueLevel = "error",
): void {
  if (!left || !right) return;
  if (left.min === right.min && left.max === right.max) return;
  addIssue(
    level,
    "range_mismatch",
    `${label} mismatch: ${leftName}=[${left.min},${left.max}] vs ${rightName}=[${right.min},${right.max}]`,
  );
}

function getTreeRange(
  inputs: Array<Record<string, unknown>> | undefined,
  fieldName: string,
): IntRange | null {
  const entry = (inputs ?? []).find((item) => item?.name === fieldName);
  if (!entry) return null;
  const range = entry.range;
  if (!Array.isArray(range) || range.length < 2) return null;
  const min = Number(range[0]);
  const max = Number(range[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min: Math.trunc(min), max: Math.trunc(max) };
}

function getTreeDefaultSampleCount(
  nodes: Array<Record<string, unknown>>,
  nodeId: string,
): number | null {
  const node = nodes.find((item) => item?.id === nodeId);
  if (!node) return null;
  const environment = node.environment;
  if (!environment || typeof environment !== "object") return null;
  const value = (environment as Record<string, unknown>).sampleCount;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.trunc(num);
}

async function readAtomicTreeContract(): Promise<AtomicTreeContract | null> {
  const text = await readTextFile(files.tree);
  if (!text) return null;
  const doc = parseJsonText<{ nodes?: Array<Record<string, unknown>> }>(text, files.tree);
  if (!doc?.nodes || !Array.isArray(doc.nodes)) {
    addIssue("error", "tree_nodes_missing", "Atomic tree missing nodes array", files.tree);
    return null;
  }
  const contractNode = doc.nodes.find((node) => node?.id === "atomic-parameter-contract");
  if (!contractNode) {
    addIssue("error", "tree_contract_missing", "Missing atomic-parameter-contract node", files.tree);
    return null;
  }
  const inputs = Array.isArray(contractNode.inputs)
    ? (contractNode.inputs as Array<Record<string, unknown>>)
    : [];

  return {
    ranges: {
      Z: getTreeRange(inputs, "Z"),
      n: getTreeRange(inputs, "n"),
      l: getTreeRange(inputs, "l"),
      sampleCount: getTreeRange(inputs, "sampleCount"),
    },
    defaults: {
      quantumSampleCount: getTreeDefaultSampleCount(doc.nodes, "atomic-quantum-route"),
      classicalSampleCount: getTreeDefaultSampleCount(doc.nodes, "atomic-classical-route"),
    },
  };
}

async function runAtomicCongruenceChecks(): Promise<void> {
  const [serverSource, panelSource, hookSource, adapterSource] = await Promise.all([
    readTextFile(files.server),
    readTextFile(files.panel),
    readTextFile(files.hook),
    readTextFile(files.adapter),
  ]);
  const treeContract = await readAtomicTreeContract();
  if (!serverSource || !panelSource || !hookSource || !adapterSource || !treeContract) return;

  const serverRanges = {
    Z: extractRange(
      serverSource,
      /Z:\s*clampInteger\(draft\.Z,\s*(-?\d+),\s*(-?\d+)\)\s*\?\?\s*-?\d+/,
      "server Z",
      files.server,
    ),
    n: extractRange(
      serverSource,
      /let n = clampInteger\(draft\.n,\s*(-?\d+),\s*(-?\d+)\)\s*\?\?\s*-?\d+/,
      "server n",
      files.server,
    ),
    l: extractRange(
      serverSource,
      /let l = clampInteger\(draft\.l,\s*(-?\d+),\s*(-?\d+)\)\s*\?\?\s*-?\d+/,
      "server l",
      files.server,
    ),
    sampleCount: extractRange(
      serverSource,
      /const sampleCount = clampInteger\(draft\.sampleCount,\s*(-?\d+),\s*(-?\d+)\)/,
      "server sampleCount",
      files.server,
    ),
  };

  const panelRanges = {
    Z: extractRange(
      panelSource,
      /const Z = clampAtomicInt\(params\.Z,\s*(-?\d+),\s*(-?\d+),\s*-?\d+\)/,
      "panel Z",
      files.panel,
    ),
    n: extractRange(
      panelSource,
      /let n = clampAtomicInt\(params\.n,\s*(-?\d+),\s*(-?\d+),\s*-?\d+\)/,
      "panel n",
      files.panel,
    ),
    l: extractRange(
      panelSource,
      /let l = clampAtomicInt\(params\.l,\s*(-?\d+),\s*(-?\d+),\s*-?\d+\)/,
      "panel l",
      files.panel,
    ),
    sampleCount: extractRange(
      panelSource,
      /clampAtomicInt\(params\.sampleCount,\s*(-?\d+),\s*(-?\d+),\s*model === "quantum" \? \d+ : \d+\)/,
      "panel sampleCount",
      files.panel,
    ),
  };

  const hookSampleRange = extractRange(
    hookSource,
    /Math\.max\(\s*(-?\d+),\s*Math\.min\(\s*(-?\d+),\s*cloudSampleCount \?\? defaultSampleCount\)\s*\)/,
    "hook sampleCount",
    files.hook,
  );

  const hookQuantumDefault = extractInteger(
    hookSource,
    /const defaultSampleCount = atomModel === "quantum" \? (\d+) : \d+;/,
    "hook quantum sample default",
    files.hook,
  );
  const hookClassicalDefault = extractInteger(
    hookSource,
    /const defaultSampleCount = atomModel === "quantum" \? \d+ : (\d+);/,
    "hook classical sample default",
    files.hook,
  );

  const adapterNRange = extractRange(
    adapterSource,
    /const n = clampInt\(quantumNumbers\.n,\s*(-?\d+),\s*(-?\d+)\);/,
    "adapter n",
    files.adapter,
  );
  const adapterSampleRange = extractRange(
    adapterSource,
    /const sampleCount = Math\.max\(\s*(-?\d+),\s*Math\.min\(\s*(-?\d+),\s*options\.sampleCount \?\? \(mode === "quantum" \? \d+ : \d+\)\)\);/,
    "adapter sampleCount",
    files.adapter,
  );
  const adapterQuantumDefault = extractInteger(
    adapterSource,
    /options\.sampleCount \?\? \(mode === "quantum" \? (\d+) : \d+\)/,
    "adapter quantum sample default",
    files.adapter,
  );
  const adapterClassicalDefault = extractInteger(
    adapterSource,
    /options\.sampleCount \?\? \(mode === "quantum" \? \d+ : (\d+)\)/,
    "adapter classical sample default",
    files.adapter,
  );

  compareRanges("Z bounds", treeContract.ranges.Z, serverRanges.Z, "tree", "server");
  compareRanges("n bounds", treeContract.ranges.n, serverRanges.n, "tree", "server");
  compareRanges("l bounds", treeContract.ranges.l, serverRanges.l, "tree", "server");
  compareRanges(
    "sampleCount bounds",
    treeContract.ranges.sampleCount,
    serverRanges.sampleCount,
    "tree",
    "server",
  );

  compareRanges("Z bounds", serverRanges.Z, panelRanges.Z, "server", "panel");
  compareRanges("n bounds", serverRanges.n, panelRanges.n, "server", "panel");
  compareRanges("l bounds", serverRanges.l, panelRanges.l, "server", "panel");
  compareRanges(
    "sampleCount bounds",
    serverRanges.sampleCount,
    panelRanges.sampleCount,
    "server",
    "panel",
  );

  compareRanges(
    "sampleCount bounds",
    serverRanges.sampleCount,
    hookSampleRange,
    "server",
    "hook",
  );
  compareRanges(
    "sampleCount bounds",
    serverRanges.sampleCount,
    adapterSampleRange,
    "server",
    "adapter",
  );

  compareRanges("n bounds", serverRanges.n, adapterNRange, "server", "adapter", "warning");

  if (
    treeContract.defaults.quantumSampleCount != null &&
    hookQuantumDefault != null &&
    treeContract.defaults.quantumSampleCount !== hookQuantumDefault
  ) {
    addIssue(
      "warning",
      "default_mismatch",
      `Quantum sample default mismatch: tree=${treeContract.defaults.quantumSampleCount} vs hook=${hookQuantumDefault}`,
    );
  }

  if (
    treeContract.defaults.classicalSampleCount != null &&
    hookClassicalDefault != null &&
    treeContract.defaults.classicalSampleCount !== hookClassicalDefault
  ) {
    addIssue(
      "warning",
      "default_mismatch",
      `Classical sample default mismatch: tree=${treeContract.defaults.classicalSampleCount} vs hook=${hookClassicalDefault}`,
    );
  }

  if (
    hookQuantumDefault != null &&
    adapterQuantumDefault != null &&
    hookQuantumDefault !== adapterQuantumDefault
  ) {
    addIssue(
      "info",
      "default_mismatch",
      `Quantum sample default mismatch: hook=${hookQuantumDefault} vs adapter=${adapterQuantumDefault}`,
    );
  }

  if (
    hookClassicalDefault != null &&
    adapterClassicalDefault != null &&
    hookClassicalDefault !== adapterClassicalDefault
  ) {
    addIssue(
      "info",
      "default_mismatch",
      `Classical sample default mismatch: hook=${hookClassicalDefault} vs adapter=${adapterClassicalDefault}`,
    );
  }

  addIssue("info", "atomic_contract_checked", "Atomic parameter congruence checks completed.");
}

function isPlaceholderText(value: string): boolean {
  return /\b(todo|tbd|unknown|placeholder)\b/i.test(value);
}

function looksLikeEquationClaim(statement: string): boolean {
  return /[=~^]|psi|orbital|wavefunction|n\^2|z\^2/i.test(statement);
}

function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function runCitationChecks(): Promise<void> {
  const schemaText = await readTextFile(files.claimSchema);
  if (schemaText) {
    const schemaDoc = parseJsonText<Record<string, unknown>>(schemaText, files.claimSchema);
    if (schemaDoc) {
      if (schemaDoc.title !== "Math Claim Registry") {
        addIssue("warning", "schema_title_unexpected", "Schema title differs from expected label.");
      }
      if (!schemaDoc.$schema) {
        addIssue("warning", "schema_meta_missing", "Schema is missing $schema field.", files.claimSchema);
      }
    }
  }

  const claimsRoot = path.resolve(cwd, files.claimDir);
  if (!existsSync(claimsRoot)) {
    addIssue("warning", "claims_dir_missing", `Claim directory not found: ${files.claimDir}`);
    return;
  }

  let entries: string[] = [];
  try {
    entries = (await fs.readdir(claimsRoot))
      .filter((name) => name.toLowerCase().endsWith(".json"))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    addIssue(
      "error",
      "claims_dir_read_failed",
      `${files.claimDir}: ${(error as Error).message}`,
      files.claimDir,
    );
    return;
  }

  if (entries.length === 0) {
    addIssue("warning", "claims_missing", `No claim registry files found in ${files.claimDir}`);
    return;
  }

  const maturitySet = new Set(["exploratory", "reduced-order", "diagnostic", "certified"]);
  const seenClaimIds = new Map<string, string>();
  let checkedClaims = 0;

  for (const entry of entries) {
    const relPath = `${files.claimDir}/${entry}`;
    const text = await readTextFile(relPath);
    if (!text) continue;
    const doc = parseJsonText<ClaimRegistry>(text, relPath);
    if (!doc) continue;

    const requiredTopLevel: Array<keyof ClaimRegistry> = [
      "schemaVersion",
      "registryId",
      "domain",
      "updatedAt",
      "claims",
    ];
    for (const field of requiredTopLevel) {
      if (doc[field] == null) {
        addIssue("error", "claim_registry_field_missing", `Missing top-level field: ${field}`, relPath);
      }
    }

    if (typeof doc.schemaVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(doc.schemaVersion ?? "")) {
      addIssue("error", "schema_version_invalid", "schemaVersion must be semantic version string", relPath);
    }

    if (typeof doc.updatedAt !== "string" || !isValidIsoDate(doc.updatedAt)) {
      addIssue("error", "updated_at_invalid", "updatedAt must be ISO date (YYYY-MM-DD)", relPath);
    }

    if (typeof doc.$schema === "string" && isPlaceholderText(doc.$schema)) {
      addIssue("warning", "schema_placeholder", "Registry uses placeholder schema path text", relPath);
    }

    const claims = Array.isArray(doc.claims) ? doc.claims : [];
    if (claims.length === 0) {
      addIssue("error", "claims_empty", "claims must be a non-empty array", relPath);
      continue;
    }

    for (const [index, claim] of claims.entries()) {
      checkedClaims += 1;
      const claimPrefix = `${relPath}#${index + 1}`;

      if (!claim || typeof claim !== "object") {
        addIssue("error", "claim_invalid_type", "Claim entry must be an object", claimPrefix);
        continue;
      }

      if (typeof claim.claimId !== "string" || claim.claimId.trim().length < 3) {
        addIssue("error", "claim_id_missing", "claimId is required", claimPrefix);
      } else {
        const previous = seenClaimIds.get(claim.claimId);
        if (previous) {
          addIssue(
            "error",
            "claim_id_duplicate",
            `Duplicate claimId '${claim.claimId}' also found in ${previous}`,
            claimPrefix,
          );
        } else {
          seenClaimIds.set(claim.claimId, claimPrefix);
        }
      }


      const claimId = typeof claim.claimId === "string" ? claim.claimId.trim() : "";
      if (claimId && REQUIRED_ATOMIC_CURVATURE_BRIDGE_CLAIMS.has(claimId) && !hasBridgeClaimMetadata(claim)) {
        addIssue(
          "error",
          "bridge_claim_metadata_missing",
          `Bridge claim '${claimId}' must include validityDomain.system and non-empty validityDomain.constraints`,
          claimPrefix,
        );
      }

      if (claimId && REQUIRED_ATOMIC_CURVATURE_BRIDGE_CLAIMS.has(claimId) && !hasBridgeClaimMaturitySafeMetadata(claim)) {
        addIssue(
          "error",
          "bridge_claim_maturity_metadata_missing",
          `Bridge claim '${claimId}' must include non-placeholder maturity-safe metadata`,
          claimPrefix,
        );
      }

      if (typeof claim.statement !== "string" || claim.statement.trim().length < 8) {
        addIssue("error", "claim_statement_missing", "statement is required", claimPrefix);
      }

      if (typeof claim.maturity !== "string" || !maturitySet.has(claim.maturity)) {
        addIssue(
          "error",
          "claim_maturity_invalid",
          "maturity must be one of exploratory/reduced-order/diagnostic/certified",
          claimPrefix,
        );
      }

      const validity = claim.validityDomain;
      if (!validity || typeof validity !== "object") {
        addIssue("error", "validity_domain_missing", "validityDomain is required", claimPrefix);
      } else {
        if (typeof validity.system !== "string" || !validity.system.trim()) {
          addIssue("error", "validity_system_missing", "validityDomain.system is required", claimPrefix);
        }
        if (!Array.isArray(validity.constraints) || validity.constraints.length === 0) {
          addIssue(
            "error",
            "validity_constraints_missing",
            "validityDomain.constraints must be a non-empty array",
            claimPrefix,
          );
        }
      }

      const sources = Array.isArray(claim.sources) ? claim.sources : [];
      if (sources.length === 0) {
        addIssue("error", "claim_sources_missing", "sources must be a non-empty array", claimPrefix);
      } else {
        if (claimId && REQUIRED_ATOMIC_CURVATURE_BRIDGE_CLAIMS.has(claimId)) {
          const hasCitation = sources.some(
            (source) => typeof source?.citation === "string" && source.citation.trim().length >= 3,
          );
          if (!hasCitation) {
            addIssue(
              "error",
              "bridge_claim_citation_missing",
              `Bridge claim '${claimId}' must include at least one concrete citation`,
              claimPrefix,
            );
          }
        }
        const hasEquationSource = sources.some(
          (source) => typeof source.equation === "string" && source.equation.trim().length >= 2,
        );
        if (
          typeof claim.statement === "string" &&
          looksLikeEquationClaim(claim.statement) &&
          !hasEquationSource
        ) {
          addIssue(
            "warning",
            "equation_source_missing",
            "Equation-like statement does not include a source.equation reference",
            claimPrefix,
          );
        }

        for (const [sourceIndex, source] of sources.entries()) {
          const sourcePrefix = `${claimPrefix}.sources[${sourceIndex}]`;
          if (!source || typeof source !== "object") {
            addIssue("error", "source_invalid_type", "Source entry must be an object", sourcePrefix);
            continue;
          }
          if (typeof source.kind !== "string" || !source.kind.trim()) {
            addIssue("error", "source_kind_missing", "source.kind is required", sourcePrefix);
          }
          if (typeof source.citation !== "string" || source.citation.trim().length < 3) {
            addIssue("error", "source_citation_missing", "source.citation is required", sourcePrefix);
          } else if (isPlaceholderText(source.citation)) {
            addIssue("warning", "source_citation_placeholder", "source.citation contains placeholder text", sourcePrefix);
          }
          if (typeof source.note === "string" && isPlaceholderText(source.note)) {
            addIssue("warning", "source_note_placeholder", "source.note contains placeholder text", sourcePrefix);
          }
        }
      }

      if (Array.isArray(claim.repoBindings)) {
        for (const binding of claim.repoBindings) {
          if (typeof binding !== "string" || !binding.trim()) {
            addIssue("warning", "repo_binding_invalid", "repoBinding must be a non-empty path string", claimPrefix);
            continue;
          }
          const fullPath = path.resolve(cwd, binding);
          if (!existsSync(fullPath)) {
            addIssue("warning", "repo_binding_missing", `repoBinding path not found: ${binding}`, claimPrefix);
          }
        }
      }
    }
  }


  for (const requiredClaimId of REQUIRED_ATOMIC_CURVATURE_BRIDGE_CLAIMS) {
    if (!seenClaimIds.has(requiredClaimId)) {
      addIssue(
        "error",
        "bridge_claim_required_missing",
        `Missing required atomic-curvature bridge claim: ${requiredClaimId}`,
        files.claimDir,
      );
    }
  }

  await runPhysicsClaimLinkageChecks(new Set(seenClaimIds.keys()));
  addIssue("info", "claim_registry_checked", `Checked ${checkedClaims} claim(s) across ${entries.length} file(s).`);
}


async function runPhysicsClaimLinkageChecks(knownClaimIds: Set<string>): Promise<void> {
  const physicsRoot = path.resolve(cwd, files.physicsDir);
  if (!existsSync(physicsRoot)) {
    addIssue("warning", "physics_dir_missing", `Physics tree directory not found: ${files.physicsDir}`, files.physicsDir);
    return;
  }
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(physicsRoot))
      .filter((name) => name.toLowerCase().endsWith(".json"))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    addIssue("error", "physics_dir_read_failed", `${files.physicsDir}: ${(error as Error).message}`, files.physicsDir);
    return;
  }

  for (const entry of entries) {
    const relPath = `${files.physicsDir}/${entry}`;
    const text = await readTextFile(relPath);
    if (!text) continue;
    const doc = parseJsonText<{ nodes?: PhysicsTreeNode[] }>(text, relPath);
    if (!doc || !Array.isArray(doc.nodes)) continue;

    for (const [index, node] of doc.nodes.entries()) {
      const nodeType = String(node?.nodeType ?? "").trim().toLowerCase();
      if (!["physics_assertion", "bridge", "derived_metric"].includes(nodeType)) continue;
      const validity = node?.validity as Record<string, unknown> | undefined;
      const claimIds = Array.isArray(validity?.claim_ids)
        ? validity.claim_ids.map((id) => String(id ?? "").trim()).filter(Boolean)
        : [];
      const nodePrefix = `${relPath}#node:${String(node?.id ?? index)}`;
      if (claimIds.length === 0) {
        addIssue("error", "node_claim_ids_missing", "Guarded physics/proxy node must define validity.claim_ids", nodePrefix);
        continue;
      }
      for (const claimId of claimIds) {
        if (!knownClaimIds.has(claimId)) {
          addIssue(
            "error",
            "node_claim_id_unknown",
            `Guarded node references unknown claimId '${claimId}'`,
            nodePrefix,
          );
        }
      }

      const outputs = Array.isArray(node?.outputs) ? node.outputs : [];
      const emitsProxyOutput = outputs.some((output) => {
        const name = String(output?.name ?? "").toLowerCase();
        const value = String(output?.value ?? "").toLowerCase();
        return name.includes("proxy") || value.includes("proxy");
      });
      const hasProxySemantics = Boolean(validity?.proxy_semantics);
      if (!emitsProxyOutput && !hasProxySemantics) continue;

      if (claimIds.length === 0) {
        addIssue(
          "error",
          "proxy_node_claim_ids_missing",
          "Proxy-emitting node must define validity.claim_ids",
          nodePrefix,
        );
      }

      const equationRef =
        typeof validity?.equation_ref === "string" && validity.equation_ref.trim()
          ? validity.equation_ref.trim()
          : typeof validity?.requires?.equation_ref === "string" && validity.requires.equation_ref.trim()
            ? validity.requires.equation_ref.trim()
            : "";
      if (!equationRef) {
        addIssue(
          "error",
          "proxy_node_equation_linkage_missing",
          "Proxy-emitting node must declare validity.equation_ref or validity.requires.equation_ref",
          nodePrefix,
        );
      }
    }
  }
}

function printTextSummary(): void {
  const errors = issues.filter((issue) => issue.level === "error");
  const warnings = issues.filter((issue) => issue.level === "warning");
  const infos = issues.filter((issue) => issue.level === "info");
  console.log(
    `[math-congruence-citation-check] errors=${errors.length} warnings=${warnings.length} info=${infos.length} strict=${strictMode ? "1" : "0"}`,
  );
  const ordered = [
    ...errors,
    ...warnings,
    ...infos,
  ];
  for (const issue of ordered) {
    const prefix = issue.level === "error" ? "ERROR" : issue.level === "warning" ? "WARN " : "INFO ";
    const filePart = issue.file ? ` (${issue.file})` : "";
    console.log(`${prefix} [${issue.code}] ${issue.message}${filePart}`);
  }
}

async function main(): Promise<void> {
  await runAtomicCongruenceChecks();
  await runCitationChecks();

  const errors = issues.filter((issue) => issue.level === "error");
  const warnings = issues.filter((issue) => issue.level === "warning");

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          strict: strictMode,
          errors: errors.length,
          warnings: warnings.length,
          issues,
        },
        null,
        2,
      ),
    );
  } else {
    printTextSummary();
  }

  const shouldFail = errors.length > 0 || (strictMode && warnings.length > 0);
  if (shouldFail) {
    process.exitCode = 1;
  }
}

void main();
