import fs from "node:fs";
import path from "node:path";

type CoverageStatus = "covered_core" | "covered_extension" | "unmapped";

type ResolverOwnerCoverageManifest = {
  schema_version?: string;
  high_priority_owners?: string[];
  owners?: Record<string, { status?: CoverageStatus }>;
};

const MANIFEST_PATH = path.resolve(
  process.env.RESOLVER_OWNER_COVERAGE_MANIFEST_PATH ??
    path.join("configs", "resolver-owner-coverage-manifest.v1.json"),
);

const GRAPH_RESOLVERS_PATH = path.resolve(
  process.env.GRAPH_RESOLVERS_PATH ?? path.join("configs", "graph-resolvers.json"),
);

const VALID_STATUS = new Set<CoverageStatus>([
  "covered_core",
  "covered_extension",
  "unmapped",
]);

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function fail(errors: string[]): never {
  throw new Error(errors.join("\n"));
}

function main() {
  const errors: string[] = [];

  if (!fs.existsSync(MANIFEST_PATH)) {
    fail([`resolver owner coverage manifest missing: ${MANIFEST_PATH}`]);
  }
  if (!fs.existsSync(GRAPH_RESOLVERS_PATH)) {
    fail([`graph resolver file missing: ${GRAPH_RESOLVERS_PATH}`]);
  }

  const manifest = readJson<ResolverOwnerCoverageManifest>(MANIFEST_PATH);
  if (manifest.schema_version !== "resolver_owner_coverage_manifest/1") {
    errors.push(
      `manifest schema_version must be resolver_owner_coverage_manifest/1, got ${String(manifest.schema_version)}`,
    );
  }

  const owners = manifest.owners ?? {};
  const ownerNames = Object.keys(owners);
  if (ownerNames.length === 0) {
    errors.push("manifest owners map cannot be empty");
  }

  const graphResolvers = readJson<{ trees?: Array<{ id?: string }> }>(GRAPH_RESOLVERS_PATH);
  const graphOwnerNames = new Set(
    (graphResolvers.trees ?? [])
      .map((tree) => tree.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );

  for (const owner of ownerNames) {
    const status = owners[owner]?.status;
    if (!status || !VALID_STATUS.has(status)) {
      errors.push(`owner ${owner} has invalid status ${String(status)}`);
    }
  }

  const missingFromManifest = [...graphOwnerNames].filter((owner) => !(owner in owners));
  if (missingFromManifest.length > 0) {
    errors.push(`manifest missing resolver owners: ${missingFromManifest.join(", ")}`);
  }

  const unknownOwners = ownerNames.filter((owner) => !graphOwnerNames.has(owner));
  if (unknownOwners.length > 0) {
    errors.push(`manifest has owners not present in graph-resolvers: ${unknownOwners.join(", ")}`);
  }

  const highPriorityOwners = manifest.high_priority_owners ?? [];
  if (!Array.isArray(highPriorityOwners) || highPriorityOwners.length === 0) {
    errors.push("high_priority_owners must be a non-empty array");
  } else {
    const unmappedHighPriority = highPriorityOwners.filter(
      (owner) => owners[owner]?.status === "unmapped",
    );
    if (unmappedHighPriority.length > 0) {
      errors.push(
        `high-priority owners cannot be unmapped: ${unmappedHighPriority.join(", ")}`,
      );
    }
  }

  if (errors.length > 0) {
    fail(errors);
  }

  const coveredCount = ownerNames.filter((owner) => owners[owner]?.status !== "unmapped").length;
  const coveragePct = Math.round((coveredCount / ownerNames.length) * 1000) / 10;

  console.log(
    `resolver-owner-coverage validation OK manifest=${normalizePath(path.relative(process.cwd(), MANIFEST_PATH))} graph_owners=${graphOwnerNames.size} covered=${coveredCount} coverage_pct=${coveragePct}`,
  );
}

main();
