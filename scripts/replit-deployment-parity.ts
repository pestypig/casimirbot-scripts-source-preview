import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

type Target = {
  name: string;
  baseUrl: string;
  headers: Record<string, string>;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = Math.max(
  5_000,
  Number(process.env.HELIX_REPLIT_PARITY_TIMEOUT_MS ?? 60_000),
);
const dryRun = process.argv.includes("--dry-run");

const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;

const parseHeaders = (): Record<string, Record<string, string>> => {
  const raw = process.env.HELIX_REPLIT_PARITY_HEADERS_JSON?.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(parsed).map(([target, value]) => [
      target,
      Object.fromEntries(
        Object.entries(asRecord(value) ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    ]),
  );
};

const parseTargets = (): Target[] => {
  const cliTargets = process.argv
    .filter((argument) => argument.startsWith("--target="))
    .map((argument) => argument.slice("--target=".length));
  const envTargets = (
    process.env.HELIX_REPLIT_DEPLOYMENT_TARGETS ??
    process.env.HELIX_REPLIT_PARITY_TARGETS ??
    ""
  )
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const headers = parseHeaders();
  const targets = (cliTargets.length > 0 ? cliTargets : envTargets).map((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error(`Invalid deployment target '${entry}'; expected name=https://host`);
    const name = entry.slice(0, separator).trim();
    const baseUrl = entry.slice(separator + 1).trim().replace(/\/+$/, "");
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Unsupported deployment target protocol for ${name}: ${url.protocol}`);
    }
    return { name, baseUrl, headers: headers[name] ?? {} };
  });
  const names = new Set(targets.map((target) => target.name));
  if (names.size !== targets.length) throw new Error("Deployment target names must be unique.");
  return targets;
};

const getPath = (value: unknown, pathParts: readonly string[]): unknown => {
  let current: unknown = value;
  for (const part of pathParts) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[part];
  }
  return current;
};

const resolveGitRevision = (revision: string): string => {
  try {
    return execFileSync("git", ["rev-parse", revision], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().toLowerCase();
  } catch (error) {
    throw new Error(`Unable to resolve expected Git revision '${revision}'.`, { cause: error });
  }
};

const resolveExpectedCommit = () => {
  const cliRevision = process.argv
    .find((argument) => argument.startsWith("--expected-commit="))
    ?.slice("--expected-commit=".length)
    .trim();
  const revision =
    cliRevision ||
    process.env.HELIX_REPLIT_EXPECTED_COMMIT?.trim() ||
    process.env.REPLIT_GIT_AUTHORITY_REF?.trim() ||
    "origin/main";
  return { revision, commit: resolveGitRevision(revision) };
};

const comparedPaths = [
  "build.execution_mode",
  "build.metadata_available",
  "build.schema",
  "build.source_commit",
  "build.source_commit_matches_artifact",
  "build.build_id",
  "build.source_tree_sha256",
  "build.artifact_contract_sha256",
  "build.git_authority_strict",
  "build.git_authority_verified",
  "build.git_worktree_clean_at_authority_check",
  "build.package_lock_sha256",
  "build.theory_sources_sha256",
  "build.parity_fixture_sha256",
  "build.client_experience_configuration_sha256",
  "build.server_bundle_sha256",
  "build.server_bundle_commit",
  "build.server_build_identity_verified",
  "build.client_tree_sha256",
  "build.client_bundle_build_id",
  "build.client_build_identity_verified",
  "build.runtime_data_sha256",
  "build.parity_static_result_sha256",
  "source_identity.source_identity_sha256",
  "theory_graph.graph_sha256",
  "tool_surface.tool_surface_sha256",
  "runtime_configuration.reasoning_configuration_sha256",
  "reasoning_materials.reasoning_materials_sha256",
  "account_policy.policy_sha256",
  "experience_contract_sha256",
  "deployment_contract_sha256",
] as const;

const requiredStringPaths = [
  "build.schema",
  "build.source_commit",
  "build.build_id",
  "build.source_tree_sha256",
  "build.artifact_contract_sha256",
  "build.package_lock_sha256",
  "build.theory_sources_sha256",
  "build.parity_fixture_sha256",
  "build.client_experience_configuration_sha256",
  "build.server_bundle_sha256",
  "build.server_bundle_commit",
  "build.client_tree_sha256",
  "build.client_bundle_build_id",
  "build.parity_static_result_sha256",
  "source_identity.source_identity_sha256",
  "theory_graph.graph_sha256",
  "tool_surface.tool_surface_sha256",
  "runtime_configuration.reasoning_configuration_sha256",
  "reasoning_materials.reasoning_materials_sha256",
  "account_policy.policy_sha256",
  "experience_contract_sha256",
  "deployment_contract_sha256",
] as const;

const requiredTruePaths = [
  "build.metadata_available",
  "build.source_commit_matches_artifact",
  "build.git_authority_strict",
  "build.git_authority_verified",
  "build.git_worktree_clean_at_authority_check",
  "build.server_build_identity_verified",
  "build.client_build_identity_verified",
] as const;

export const validateDeploymentFingerprint = (input: {
  targetName: string;
  fingerprint: JsonRecord;
  expectedCommit: string;
}) => {
  const { targetName, fingerprint, expectedCommit } = input;
  if (fingerprint.schema !== "helix.runtime_parity_fingerprint.v1") {
    throw new Error(`${targetName}: unsupported fingerprint schema ${String(fingerprint.schema)}`);
  }
  if (fingerprint.secret_values_included !== false) {
    throw new Error(`${targetName}: fingerprint does not attest secret exclusion`);
  }
  if (
    fingerprint.assistant_answer !== false ||
    fingerprint.terminal_eligible !== false ||
    fingerprint.raw_content_included !== false
  ) {
    throw new Error(`${targetName}: fingerprint endpoint returned an unsafe response contract`);
  }
  if (getPath(fingerprint, ["build", "execution_mode"]) !== "compiled_production") {
    throw new Error(`${targetName}: target is not serving a compiled production artifact`);
  }
  if (getPath(fingerprint, ["build", "schema"]) !== "casimir.replit_build_meta.v1") {
    throw new Error(`${targetName}: target has unsupported or missing build metadata`);
  }
  for (const field of requiredStringPaths) {
    const value = getPath(fingerprint, field.split("."));
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${targetName}: required fingerprint field '${field}' is missing`);
    }
  }
  for (const field of requiredTruePaths) {
    if (getPath(fingerprint, field.split(".")) !== true) {
      throw new Error(`${targetName}: required authority field '${field}' is not true`);
    }
  }
  const runtimeData = asRecord(getPath(fingerprint, ["build", "runtime_data_sha256"]));
  for (const key of ["solar_reference_pack", "solar_product_registry"]) {
    if (typeof runtimeData?.[key] !== "string" || runtimeData[key].length === 0) {
      throw new Error(`${targetName}: required runtime data identity '${key}' is missing`);
    }
  }
  const sourceCommit = String(getPath(fingerprint, ["build", "source_commit"])).toLowerCase();
  if (sourceCommit !== expectedCommit.toLowerCase()) {
    throw new Error(
      `${targetName}: deployed commit ${sourceCommit} does not match expected ${expectedCommit}`,
    );
  }
};

export const compareDeploymentFingerprints = (
  fingerprints: Array<{ name: string; fingerprint: JsonRecord }>,
) => comparedPaths.flatMap((field) => {
  const values = Object.fromEntries(
    fingerprints.map(({ name, fingerprint }) => [
      name,
      getPath(fingerprint, field.split(".")) ?? null,
    ]),
  );
  const distinct = new Set(Object.values(values).map((value) => JSON.stringify(value)));
  return distinct.size > 1 ? [{ field, values }] : [];
});

const fetchFingerprint = async (
  target: Target,
  expectedCommit: string,
): Promise<JsonRecord> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL("/api/agi/runtime-parity/fingerprint", target.baseUrl);
    url.searchParams.set("parity_check", Date.now().toString(36));
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        ...target.headers,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${target.name}: HTTP ${response.status}: ${text.slice(0, 1_200)}`);
    }
    const fingerprint = asRecord(JSON.parse(text));
    if (!fingerprint) throw new Error(`${target.name}: fingerprint response is not a JSON object`);
    validateDeploymentFingerprint({
      targetName: target.name,
      fingerprint,
      expectedCommit,
    });
    return fingerprint;
  } finally {
    clearTimeout(timeout);
  }
};

const main = async () => {
  const targets = parseTargets();
  const expected = resolveExpectedCommit();
  if (targets.length < 2) {
    throw new Error("Deployment parity requires at least two targets.");
  }
  if (dryRun) {
    console.log(JSON.stringify({
      schema: "helix.replit_deployment_parity.v1",
      dry_run: true,
      expected_revision: expected.revision,
      expected_commit: expected.commit,
      targets: targets.map(({ name, baseUrl }) => ({ name, base_url: baseUrl })),
      compared_paths: comparedPaths,
    }, null, 2));
    return;
  }

  const fingerprints = await Promise.all(
    targets.map(async (target) => ({
      target,
      fingerprint: await fetchFingerprint(target, expected.commit),
    })),
  );
  const mismatches = compareDeploymentFingerprints(
    fingerprints.map(({ target, fingerprint }) => ({
      name: target.name,
      fingerprint,
    })),
  );
  const summary = {
    schema: "helix.replit_deployment_parity.v1",
    checked_at: new Date().toISOString(),
    ok: mismatches.length === 0,
    expected_revision: expected.revision,
    expected_commit: expected.commit,
    targets: fingerprints.map(({ target, fingerprint }) => ({
      name: target.name,
      base_url: target.baseUrl,
      source_commit: getPath(fingerprint, ["build", "source_commit"]) ?? null,
      artifact_contract_sha256:
        getPath(fingerprint, ["build", "artifact_contract_sha256"]) ?? null,
      experience_contract_sha256: fingerprint.experience_contract_sha256 ?? null,
      deployment_contract_sha256: fingerprint.deployment_contract_sha256 ?? null,
    })),
    compared_paths: comparedPaths,
    mismatches,
    model_invoked: false,
    secret_values_captured: false,
  };
  const outputPath = path.resolve(
    repoRoot,
    process.env.HELIX_REPLIT_DEPLOYMENT_PARITY_OUT ??
      "artifacts/replit-deployment-parity/latest.json",
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `[replit] deployment parity failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
