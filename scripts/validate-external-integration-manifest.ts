import fs from "node:fs";
import path from "node:path";

type ManifestUsageSurface = {
  path?: string;
  kind?: string;
};

type ManifestEvidence = {
  provenance_class?: string;
  maturity_class?: string;
  source_refs?: string[];
};

type ManifestEntry = {
  external_node_id?: string;
  usage_surface?: ManifestUsageSurface[];
  evidence?: ManifestEvidence;
};

type ExternalIntegrationManifest = {
  schema_version?: string;
  tree_path?: string;
  entries?: ManifestEntry[];
};

type ExternalIntegrationsTree = {
  nodes?: Array<{ id?: string }>;
};

export type ValidationResult = {
  ok: boolean;
  errors: string[];
};

const REQUIRED_SCHEMA = "external_integration_evidence_manifest/1";
const ALLOWED_MATURITY_CLASSES = new Set([
  "exploratory",
  "reduced-order",
  "diagnostic",
  "certified",
]);
const ALLOWED_PROVENANCE_CLASSES = new Set([
  "simulation",
  "proxy",
  "inferred",
  "measured",
  "third-party",
]);

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function parseArgs(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function validateExternalIntegrationManifest(options?: {
  manifestPath?: string;
  treePath?: string;
  repoRoot?: string;
}): ValidationResult {
  const repoRoot = path.resolve(options?.repoRoot ?? process.cwd());
  const manifestPath = path.resolve(
    repoRoot,
    options?.manifestPath ?? path.join("configs", "external-integration-evidence-manifest.v1.json"),
  );

  const errors: string[] = [];

  if (!fs.existsSync(manifestPath)) {
    return {
      ok: false,
      errors: [`manifest not found: ${normalizePath(path.relative(repoRoot, manifestPath))}`],
    };
  }

  let manifest: ExternalIntegrationManifest;
  try {
    manifest = readJson<ExternalIntegrationManifest>(manifestPath);
  } catch (error) {
    return { ok: false, errors: [`invalid manifest JSON: ${String(error)}`] };
  }

  if (manifest.schema_version !== REQUIRED_SCHEMA) {
    errors.push(`schema_version must be ${REQUIRED_SCHEMA}`);
  }

  const treePath = path.resolve(
    repoRoot,
    options?.treePath ?? manifest.tree_path ?? path.join("docs", "knowledge", "external-integrations-tree.json"),
  );

  if (!fs.existsSync(treePath)) {
    errors.push(`tree file not found: ${normalizePath(path.relative(repoRoot, treePath))}`);
    return { ok: false, errors };
  }

  let tree: ExternalIntegrationsTree;
  try {
    tree = readJson<ExternalIntegrationsTree>(treePath);
  } catch (error) {
    errors.push(`invalid tree JSON: ${String(error)}`);
    return { ok: false, errors };
  }

  const validNodeIds = new Set(
    (tree.nodes ?? [])
      .map((node) => (typeof node.id === "string" ? node.id.trim() : ""))
      .filter((id) => id.length > 0),
  );

  if (validNodeIds.size === 0) {
    errors.push("tree must include at least one node id");
    return { ok: false, errors };
  }

  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    errors.push("entries must contain at least one mapping");
    return { ok: false, errors };
  }

  const seenNodeIds = new Set<string>();
  manifest.entries.forEach((entry, index) => {
    const location = `entries[${index}]`;
    const nodeId = typeof entry.external_node_id === "string" ? entry.external_node_id.trim() : "";

    if (!nodeId) {
      errors.push(`${location}.external_node_id is required`);
    } else {
      if (seenNodeIds.has(nodeId)) {
        errors.push(`${location}.external_node_id duplicated: ${nodeId}`);
      }
      seenNodeIds.add(nodeId);
      if (!validNodeIds.has(nodeId)) {
        errors.push(`${location}.external_node_id does not exist in tree: ${nodeId}`);
      }
    }

    const usageSurface = Array.isArray(entry.usage_surface) ? entry.usage_surface : [];
    if (usageSurface.length === 0) {
      errors.push(`${location}.usage_surface must include at least one path`);
    }

    usageSurface.forEach((surface, surfaceIndex) => {
      const surfacePath =
        typeof surface.path === "string" && surface.path.trim().length > 0 ? normalizePath(surface.path) : "";
      if (!surfacePath) {
        errors.push(`${location}.usage_surface[${surfaceIndex}].path is required`);
        return;
      }
      const absoluteSurfacePath = path.resolve(repoRoot, surfacePath);
      if (!fs.existsSync(absoluteSurfacePath)) {
        errors.push(`${location}.usage_surface[${surfaceIndex}].path does not exist: ${surfacePath}`);
      }
    });

    const evidence = entry.evidence;
    if (!evidence || typeof evidence !== "object") {
      errors.push(`${location}.evidence is required`);
      return;
    }

    const provenanceClass =
      typeof evidence.provenance_class === "string" ? evidence.provenance_class.trim() : "";
    if (!provenanceClass) {
      errors.push(`${location}.evidence.provenance_class is required`);
    } else if (!ALLOWED_PROVENANCE_CLASSES.has(provenanceClass)) {
      errors.push(
        `${location}.evidence.provenance_class must be one of ${Array.from(ALLOWED_PROVENANCE_CLASSES).join("|")}`,
      );
    }

    const maturityClass =
      typeof evidence.maturity_class === "string" ? evidence.maturity_class.trim() : "";
    if (!maturityClass) {
      errors.push(`${location}.evidence.maturity_class is required`);
    } else if (!ALLOWED_MATURITY_CLASSES.has(maturityClass)) {
      errors.push(
        `${location}.evidence.maturity_class must be one of ${Array.from(ALLOWED_MATURITY_CLASSES).join("|")}`,
      );
    }

    const sourceRefs = Array.isArray(evidence.source_refs) ? evidence.source_refs : [];
    if (sourceRefs.length === 0) {
      errors.push(`${location}.evidence.source_refs must include at least one reference`);
    }

    sourceRefs.forEach((sourceRef, sourceIndex) => {
      const normalized =
        typeof sourceRef === "string" && sourceRef.trim().length > 0 ? normalizePath(sourceRef) : "";
      if (!normalized) {
        errors.push(`${location}.evidence.source_refs[${sourceIndex}] must be a non-empty string`);
        return;
      }
      const absoluteRefPath = path.resolve(repoRoot, normalized);
      if (!fs.existsSync(absoluteRefPath)) {
        errors.push(`${location}.evidence.source_refs[${sourceIndex}] does not exist: ${normalized}`);
      }
    });
  });

  return { ok: errors.length === 0, errors };
}

function main() {
  const manifestPath = parseArgs("--manifest");
  const treePath = parseArgs("--tree");
  const result = validateExternalIntegrationManifest({ manifestPath, treePath });

  if (!result.ok) {
    console.error("external-integration-manifest validation failed:");
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("external-integration-manifest validation OK");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
