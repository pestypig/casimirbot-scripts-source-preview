import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { readFileSync } from "node:fs";

type JsonRecord = Record<string, unknown>;

type RuntimeArtifactResult = {
  artifact_id: "desktop_executable" | "desktop_app_asar" | "fabric_jar" | "runtime_manifest";
  path: string | null;
  expected_sha256: string | null;
  actual_sha256: string | null;
  readable: boolean;
  hash_matches: boolean;
};

export type NavEqRuntimeIntegrity = {
  schema: "helix.nav_eq_runtime_integrity.v1";
  integrity_ok: boolean;
  artifacts: RuntimeArtifactResult[];
  manifest: {
    parsed: boolean;
    schema_matches: boolean;
    source_commit_matches: boolean;
    server_sha256_matches: boolean;
  };
  violations: string[];
};

type RuntimeIntegrityOptions = {
  workspaceRoot?: string;
  readFile?: (path: string) => Buffer;
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const sha256 = (value: Buffer): string =>
  createHash("sha256").update(value).digest("hex").toUpperCase();

const resolveArtifactPath = (workspaceRoot: string, value: string | null): string | null => {
  if (value === null) return null;
  return isAbsolute(value) ? value : resolve(workspaceRoot, value);
};

export const inspectNavEqRuntimeIntegrity = (
  protocol: unknown,
  options: RuntimeIntegrityOptions = {},
): NavEqRuntimeIntegrity => {
  const violations: string[] = [];
  const emptyManifest = {
    parsed: false,
    schema_matches: false,
    source_commit_matches: false,
    server_sha256_matches: false,
  };
  if (!isRecord(protocol) || !isRecord(protocol.runtime)) {
    return {
      schema: "helix.nav_eq_runtime_integrity.v1",
      integrity_ok: false,
      artifacts: [],
      manifest: emptyManifest,
      violations: ["protocol_runtime_must_be_an_object"],
    };
  }

  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const readFile = options.readFile ?? ((path: string) => readFileSync(path));
  const runtime = protocol.runtime;
  const declarations = [
    ["desktop_executable", "desktop_package", "desktop_executable_sha256"],
    ["desktop_app_asar", "desktop_app_asar", "desktop_app_asar_sha256"],
    ["fabric_jar", "fabric_jar", "fabric_jar_sha256"],
    ["runtime_manifest", "runtime_manifest", "runtime_manifest_sha256"],
  ] as const;

  let manifestBytes: Buffer | null = null;
  const artifacts: RuntimeArtifactResult[] = declarations.map(
    ([artifactId, pathKey, hashKey]) => {
      const declaredPath = asString(runtime[pathKey]);
      const expectedSha = asString(runtime[hashKey]);
      const resolvedPath = resolveArtifactPath(workspaceRoot, declaredPath);
      let bytes: Buffer | null = null;
      try {
        if (resolvedPath !== null) bytes = readFile(resolvedPath);
      } catch {
        bytes = null;
      }
      if (artifactId === "runtime_manifest") manifestBytes = bytes;
      const actualSha = bytes === null ? null : sha256(bytes);
      const hashMatches =
        expectedSha !== null && actualSha !== null && expectedSha.toUpperCase() === actualSha;
      if (declaredPath === null) violations.push(`artifact_path_missing:${artifactId}`);
      if (expectedSha === null) violations.push(`artifact_hash_missing:${artifactId}`);
      if (resolvedPath !== null && bytes === null) violations.push(`artifact_unreadable:${artifactId}`);
      if (bytes !== null && !hashMatches) violations.push(`artifact_hash_mismatch:${artifactId}`);
      return {
        artifact_id: artifactId,
        path: declaredPath,
        expected_sha256: expectedSha,
        actual_sha256: actualSha,
        readable: bytes !== null,
        hash_matches: hashMatches,
      };
    },
  );

  const manifest = { ...emptyManifest };
  if (manifestBytes !== null) {
    try {
      const parsed = JSON.parse(manifestBytes.toString("utf8"));
      manifest.parsed = isRecord(parsed);
      if (isRecord(parsed)) {
        manifest.schema_matches =
          parsed.schemaVersion === runtime.runtime_manifest_schema;
        manifest.source_commit_matches =
          parsed.sourceCommit === runtime.runtime_manifest_source_commit;
        manifest.server_sha256_matches =
          typeof parsed.serverSha256 === "string" &&
          typeof runtime.runtime_manifest_server_sha256 === "string" &&
          parsed.serverSha256.toUpperCase() ===
            runtime.runtime_manifest_server_sha256.toUpperCase();
      }
    } catch {
      manifest.parsed = false;
    }
  }
  if (!manifest.parsed) violations.push("runtime_manifest_json_invalid");
  if (manifest.parsed && !manifest.schema_matches) violations.push("runtime_manifest_schema_mismatch");
  if (manifest.parsed && !manifest.source_commit_matches) {
    violations.push("runtime_manifest_source_commit_mismatch");
  }
  if (manifest.parsed && !manifest.server_sha256_matches) {
    violations.push("runtime_manifest_server_sha256_mismatch");
  }

  return {
    schema: "helix.nav_eq_runtime_integrity.v1",
    integrity_ok: violations.length === 0,
    artifacts,
    manifest,
    violations,
  };
};

if (process.argv[1]?.endsWith("nav-eq-runtime-integrity.ts")) {
  const protocolPath = process.argv[2];
  if (!protocolPath) throw new Error("Expected a NAV-EQ protocol JSON path");
  const protocol = JSON.parse(readFileSync(protocolPath, "utf8"));
  process.stdout.write(`${JSON.stringify(inspectNavEqRuntimeIntegrity(protocol), null, 2)}\n`);
}
