#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isExpectedBuildCleanupStatus } from "./replit-build-reuse.mjs";

export const REPLIT_BUILD_META_SCHEMA = "casimir.replit_build_meta.v1";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(repoRoot, "dist");
const metaPath = path.join(distRoot, "build-meta.json");
const envPath = path.join(distRoot, "build-meta.env");

const SOURCE_TREE_EXCLUSIONS = [
  /^(?:dist|node_modules|artifacts|reports)\//,
  /^(?:\.local|\.tmp|\.codex-tmp|external|checkpoints|output)\//,
  /^simulations\/(?!tsn-sim\.ts$)/,
  /^server\/_generated\//,
  /^(?:tmp|temp|\.tmp|_tmp|resp\.json$|adapter-(?:run|payload)\.json$|FETCH_HEAD$|nohup\.out$|server-pid\.txt$|tmp_dev_run\.pid$|test-results\.txt$|playwright-debug\.png$|%TEMP%\/)/i,
  /^\.codex-.*(?:cache|tmp)/i,
  /^client\/src\/lib\/docs\/docMetadata\.generated\.ts$/,
];

const TEXT_SOURCE_PATTERN = /(?:^\.replit$|\.(?:c|cc|cjs|cpp|css|csv|cts|d\.ts|graphql|h|hpp|html|ini|js|json|jsx|mjs|md|mts|py|rs|scss|sh|sql|svg|toml|ts|tsx|txt|xml|ya?ml))$/i;

const normalizePath = (value) => value.split(path.sep).join("/");
const sha256 = (value) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, stableValue(value[key])]),
  );
};

const stableJson = (value) => JSON.stringify(stableValue(value));

const SENSITIVE_ENVIRONMENT_NAME = /(?:^|_)(?:API_KEY|SECRET|PASSWORD|PASSCODE|CREDENTIAL|TOKEN|AUTH|PRIVATE_KEY|SIGNING_KEY|COOKIE|SESSION_ID|DSN)(?:_|$)/i;

const collectClientExperienceConfiguration = () => {
  const values = Object.fromEntries(
    Object.entries(process.env)
      .filter(
        ([key, value]) =>
          key.startsWith("VITE_HELIX_ASK_") &&
          typeof value === "string" &&
          !SENSITIVE_ENVIRONMENT_NAME.test(key),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value.trim()]),
  );
  return {
    values,
    sha256: sha256(stableJson(values)),
  };
};

const listFiles = (directory, predicate = () => true) => {
  if (!fs.existsSync(directory)) return [];
  const pending = [directory];
  const files = [];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && predicate(absolute)) files.push(absolute);
    }
  }
  return files.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
};

const describeFile = (absolutePath, required = true) => {
  if (!fs.existsSync(absolutePath)) {
    if (required) throw new Error(`Required build artifact is missing: ${normalizePath(path.relative(repoRoot, absolutePath))}`);
    return null;
  }
  const bytes = fs.readFileSync(absolutePath);
  return {
    path: normalizePath(path.relative(repoRoot, absolutePath)),
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
};

const describeTree = (directory, predicate = () => true) => {
  const files = listFiles(directory, predicate);
  const hash = crypto.createHash("sha256");
  let totalBytes = 0;
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    const relativePath = normalizePath(path.relative(directory, file));
    const fileHash = crypto.createHash("sha256").update(bytes).digest("hex");
    totalBytes += bytes.byteLength;
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(bytes.byteLength));
    hash.update("\0");
    hash.update(fileHash);
    hash.update("\n");
  }
  return {
    path: normalizePath(path.relative(repoRoot, directory)),
    file_count: files.length,
    total_bytes: totalBytes,
    sha256: `sha256:${hash.digest("hex")}`,
  };
};

const canonicalSourceBytes = (relativePath, bytes) =>
  TEXT_SOURCE_PATTERN.test(relativePath)
    ? Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8")
    : bytes;

const describeGitSourceTree = ({ required }) => {
  let output;
  try {
    output = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (error) {
    if (required) throw new Error("Unable to enumerate the Git-authoritative source tree.", { cause: error });
    return null;
  }
  const relativePaths = output
    .split("\0")
    .map((entry) => normalizePath(entry).replace(/^\.\//, ""))
    .filter(Boolean)
    .filter((entry) => !SOURCE_TREE_EXCLUSIONS.some((pattern) => pattern.test(entry)))
    .filter((entry) => {
      try {
        return fs.statSync(path.join(repoRoot, entry)).isFile();
      } catch {
        return false;
      }
    })
    .sort((left, right) => left.localeCompare(right));
  const hash = crypto.createHash("sha256");
  let totalBytes = 0;
  for (const relativePath of relativePaths) {
    const bytes = canonicalSourceBytes(relativePath, fs.readFileSync(path.join(repoRoot, relativePath)));
    const fileHash = crypto.createHash("sha256").update(bytes).digest("hex");
    totalBytes += bytes.byteLength;
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(bytes.byteLength));
    hash.update("\0");
    hash.update(fileHash);
    hash.update("\n");
  }
  return {
    path: ".",
    file_count: relativePaths.length,
    total_bytes: totalBytes,
    sha256: `sha256:${hash.digest("hex")}`,
    line_endings: "lf_normalized_text_v1",
  };
};

const clientBuildDirectory = () =>
  process.env.CASIMIR_PUBLIC_SITE_DEPLOY_COMPACT === "1" ||
  process.env.CASIMIR_PUBLIC_SITE_ONLY === "1"
    ? "site"
    : "public";

const describeClientBuildIdentity = (buildId, directory) => {
  const indexPath = path.join(distRoot, directory, "index.html");
  const html = fs.readFileSync(indexPath, "utf8");
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+\.js(?:\?[^"']*)?)["']/gi)]
    .map((match) => match[1].split("?", 1)[0])
    .filter((source) => source.startsWith("/"))
    .map((source) => path.join(distRoot, directory, source.replace(/^\/+/, "")));
  if (scripts.length === 0) throw new Error("Compiled client index has no JavaScript entry script.");
  const matchingScripts = scripts.filter((script) =>
    fs.existsSync(script) && fs.readFileSync(script, "utf8").includes(buildId),
  );
  if (matchingScripts.length === 0) {
    throw new Error(`Compiled ${directory} entry does not contain build id ${buildId}.`);
  }
  return {
    build_id: buildId,
    entry_scripts: scripts.map((script) => normalizePath(path.relative(distRoot, script))),
    matching_scripts: matchingScripts.map((script) => normalizePath(path.relative(distRoot, script))),
    verified: true,
  };
};

const describeServerBuildIdentity = (commit) => {
  const serverPath = path.join(distRoot, "index.js");
  const source = fs.readFileSync(serverPath, "utf8");
  if (!source.includes(`__CASIMIR_SERVER_BUILD_COMMIT__=${JSON.stringify(commit)}`)) {
    throw new Error(`Compiled server bundle does not contain commit marker ${commit}.`);
  }
  return {
    commit,
    verified: true,
  };
};

const resolveGitCommit = ({ required }) => {
  const fromEnv = [
    process.env.REPLIT_GIT_COMMIT,
    process.env.GIT_COMMIT,
    process.env.SOURCE_VERSION,
    process.env.GIT_SHA,
  ].find((value) => typeof value === "string" && value.trim());
  if (fromEnv) return fromEnv.trim();
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    if (required) throw new Error("Unable to resolve the source commit for the Replit build.", { cause: error });
    return null;
  }
};

const readGitHead = ({ required }) => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    if (required) throw new Error("Unable to resolve git HEAD for an authoritative build.", { cause: error });
    return null;
  }
};

const readGitStatus = ({ required }) => {
  try {
    const output = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    )
      .replace(/\r\n/g, "\n")
      .replace(/\n$/u, "");
    return output ? output.split("\n") : [];
  } catch (error) {
    if (required) throw new Error("Unable to inspect git status for an authoritative build.", { cause: error });
    return null;
  }
};

const strictGitBuildRequested = () =>
  process.env.REPLIT_STRICT_GIT_BUILD === "1" ||
  process.env.REPLIT_DEPLOYMENT === "1" ||
  process.env.REPLIT_DEPLOYMENT === "true";

const readGitTree = (ref) => execFileSync("git", ["rev-parse", `${ref}^{tree}`], {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
}).trim();

export const assertAuthoritativeGitSource = () => {
  const strict = strictGitBuildRequested();
  const head = readGitHead({ required: strict });
  const expected = process.env.REPLIT_GIT_COMMIT?.trim() || null;
  const authorityRef = process.env.REPLIT_GIT_AUTHORITY_REF?.trim() || null;
  let authorityCommit = null;
  if (authorityRef) {
    try {
      authorityCommit = execFileSync("git", ["rev-parse", authorityRef], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch (error) {
      if (strict) {
        throw new Error(`Unable to resolve authoritative git ref ${authorityRef}.`, { cause: error });
      }
    }
  }
  const status = readGitStatus({ required: strict });
  const errors = [];
  // Replit may create an empty publish checkpoint after settings change. Its
  // commit ID differs from main even though the deployed source tree is exact.
  // Accept only that content-equivalent, clean checkout; changed source still
  // fails against the authoritative ref.
  let authorityTreeEquivalent = false;
  if (authorityCommit && head && authorityCommit !== head && status?.length === 0) {
    try {
      authorityTreeEquivalent = readGitTree("HEAD") === readGitTree(authorityRef);
    } catch {
      authorityTreeEquivalent = false;
    }
  }
  if (expected && head && expected !== head &&
      !(authorityTreeEquivalent && expected === authorityCommit)) {
    errors.push(`REPLIT_GIT_COMMIT ${expected} does not match git HEAD ${head}`);
  }
  if (authorityCommit && head && authorityCommit !== head && !authorityTreeEquivalent) {
    errors.push(`authoritative ref ${authorityRef} is ${authorityCommit}, but git HEAD is ${head}`);
  }
  if (strict && status && status.length > 0) {
    const visibleStatus = status.slice(0, 20).map((entry) => JSON.stringify(entry)).join(", ");
    const omittedCount = status.length - Math.min(status.length, 20);
    const omitted = omittedCount > 0 ? `, … ${omittedCount} more` : "";
    errors.push(
      `authoritative deployment checkout is dirty (${status.length} path(s)): ${visibleStatus}${omitted}`,
    );
  }
  return {
    ok: errors.length === 0,
    strict,
    head,
    expected_commit: expected,
    authority_ref: authorityRef,
    authority_commit: authorityCommit,
    authority_tree_equivalent: authorityTreeEquivalent,
    worktree_clean: status ? status.length === 0 : null,
    dirty_path_count: status?.length ?? null,
    errors,
  };
};

const collectState = ({ commit, buildId, sourceTree }) => {
  const clientDirectory = clientBuildDirectory();
  const source = {
    commit,
    build_id: buildId,
    source_tree: sourceTree,
    package_lock: describeFile(path.join(repoRoot, "package-lock.json")),
    theory_sources: describeTree(
      path.join(repoRoot, "shared", "theory"),
      (file) => /\.(?:ts|json)$/i.test(file),
    ),
    parity_fixture: describeFile(
      path.join(repoRoot, "scripts", "fixtures", "helix-replit-parity.v1.json"),
    ),
  };
  const reasoning_materials = {
    docs_metadata: describeFile(
      path.join(repoRoot, "client", "src", "lib", "docs", "docMetadata.generated.ts"),
      false,
    ),
    code_lattice: describeFile(
      path.join(repoRoot, "server", "_generated", "code-lattice.json"),
      false,
    ),
  };
  const artifacts = {
    server_bundle: describeFile(path.join(distRoot, "index.js")),
    server_build_identity: describeServerBuildIdentity(commit),
    client_index: describeFile(path.join(distRoot, clientDirectory, "index.html")),
    client_tree: describeTree(path.join(distRoot, clientDirectory)),
    client_build_identity: describeClientBuildIdentity(buildId, clientDirectory),
    site_index: describeFile(path.join(distRoot, "site", "index.html")),
    site_tree: describeTree(path.join(distRoot, "site")),
    runtime_data: {
      solar_reference_pack: describeFile(
        path.join(distRoot, "data", "starsim", "solar-reference-pack.v1.json"),
      ),
      solar_product_registry: describeFile(
        path.join(distRoot, "data", "starsim", "solar-product-registry.v1.json"),
      ),
    },
    parity_static_result: describeFile(
      path.join(distRoot, "parity", "static-result.json"),
    ),
  };
  return { source, reasoning_materials, artifacts };
};

export const buildReplitBuildMeta = () => {
  const commit = resolveGitCommit({ required: true });
  const buildId = process.env.VITE_BUILD_ID?.trim() || commit.slice(0, 12);
  const state = collectState({
    commit,
    buildId,
    sourceTree: describeGitSourceTree({ required: true }),
  });
  const contract = {
    schema: REPLIT_BUILD_META_SCHEMA,
    node_version: process.version,
    git_authority: {
      strict: strictGitBuildRequested(),
      verified: process.env.REPLIT_GIT_AUTHORITY_VERIFIED === "1",
      worktree_clean_at_authority_check:
        process.env.REPLIT_GIT_WORKTREE_CLEAN_AT_AUTHORITY_CHECK === "1",
    },
    client_experience_configuration: collectClientExperienceConfiguration(),
    ...state,
  };
  return {
    ...contract,
    built_at: new Date().toISOString(),
    artifact_contract_sha256: sha256(stableJson(contract)),
  };
};

const writeShellEnvironment = (meta) => {
  const safe = (value) => {
    if (!/^[A-Za-z0-9._:/-]+$/.test(value)) {
      throw new Error(`Unsafe build metadata value cannot be written to shell environment: ${value}`);
    }
    return value;
  };
  const lines = [
    `export GIT_COMMIT=${safe(meta.source.commit)}`,
    `export SOURCE_VERSION=${safe(meta.source.commit)}`,
    `export VITE_BUILD_ID=${safe(meta.source.build_id)}`,
    "export HELIX_BUILD_META_PATH=dist/build-meta.json",
    `export HELIX_BUILD_ARTIFACT_CONTRACT_SHA256=${safe(meta.artifact_contract_sha256)}`,
    "",
  ];
  fs.writeFileSync(envPath, lines.join("\n"), "utf8");
};

export const writeReplitBuildMeta = () => {
  fs.mkdirSync(distRoot, { recursive: true });
  const meta = buildReplitBuildMeta();
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  writeShellEnvironment(meta);
  return meta;
};

const descriptorEqual = (left, right) => stableJson(left) === stableJson(right);

export const verifyReplitBuildMeta = () => {
  if (!fs.existsSync(metaPath)) {
    return { ok: false, errors: ["dist/build-meta.json is missing"], meta: null };
  }
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch (error) {
    return { ok: false, errors: [`dist/build-meta.json is invalid JSON: ${String(error)}`], meta: null };
  }
  const errors = [];
  if (meta.schema !== REPLIT_BUILD_META_SCHEMA) {
    errors.push(`build metadata schema mismatch: ${String(meta.schema)}`);
  }
  if (
    meta.git_authority?.strict === true &&
    (meta.git_authority?.verified !== true ||
      meta.git_authority?.worktree_clean_at_authority_check !== true)
  ) {
    errors.push("strict build metadata does not contain a verified clean Git authority attestation");
  }
  if (
    strictGitBuildRequested() &&
    (meta.git_authority?.strict !== true ||
      meta.git_authority?.verified !== true ||
      meta.git_authority?.worktree_clean_at_authority_check !== true)
  ) {
    errors.push("deployment runtime rejected non-authoritative build metadata");
  }
  const currentCommit = resolveGitCommit({ required: false });
  if (currentCommit && meta.source?.commit !== currentCommit) {
    errors.push(`build commit ${String(meta.source?.commit)} does not match checkout ${currentCommit}`);
  }
  let currentState;
  try {
    const currentSourceTree = describeGitSourceTree({ required: false });
    currentState = collectState({
      commit: meta.source?.commit,
      buildId: meta.source?.build_id,
      sourceTree: currentSourceTree ?? meta.source?.source_tree ?? null,
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (currentState) {
    if (!descriptorEqual(meta.source, currentState.source)) errors.push("source fingerprint mismatch");
    if (!descriptorEqual(meta.artifacts, currentState.artifacts)) errors.push("build artifact fingerprint mismatch");
    const contract = {
      schema: REPLIT_BUILD_META_SCHEMA,
      node_version: meta.node_version,
      git_authority: meta.git_authority,
      client_experience_configuration: meta.client_experience_configuration,
      source: meta.source,
      reasoning_materials: meta.reasoning_materials,
      artifacts: meta.artifacts,
    };
    const expectedContractHash = sha256(stableJson(contract));
    if (meta.artifact_contract_sha256 !== expectedContractHash) {
      errors.push("artifact contract hash mismatch");
    }
  }
  if (!fs.existsSync(envPath)) errors.push("dist/build-meta.env is missing");
  return { ok: errors.length === 0, errors, meta };
};

export const verifyReusableDeploymentBuild = () => {
  if (!strictGitBuildRequested() || !fs.existsSync(metaPath)) return false;
  const status = readGitStatus({ required: true });
  if (!status || !isExpectedBuildCleanupStatus(status)) return false;
  const authority = assertAuthoritativeGitSource();
  if (authority.errors.some((error) => !error.startsWith("authoritative deployment checkout is dirty")))
    return false;
  const verified = verifyReplitBuildMeta();
  return verified.ok && verified.meta.source?.commit === authority.head &&
    descriptorEqual(verified.meta.client_experience_configuration,
      collectClientExperienceConfiguration());
};

const main = () => {
  const command = process.argv[2] || "verify";
  const quiet = process.argv.includes("--quiet");
  if (command === "verify-reusable") {
    if (!verifyReusableDeploymentBuild()) process.exitCode = 1;
    else if (!quiet) console.log("[replit] verified reusable artifact from clean authoritative source");
    return;
  }
  if (command === "assert-source") {
    const result = assertAuthoritativeGitSource();
    if (!result.ok) {
      for (const error of result.errors) console.error(`[replit] git authority failed: ${error}`);
      process.exitCode = 1;
      return;
    }
    if (!quiet) {
      console.log(
        `[replit] git authority: strict=${result.strict ? "yes" : "no"} head=${result.head ?? "unavailable"} clean=${String(result.worktree_clean)}`,
      );
    }
    return;
  }
  if (command === "write") {
    const meta = writeReplitBuildMeta();
    if (!quiet) {
      console.log(`[replit] build metadata: commit=${meta.source.commit} contract=${meta.artifact_contract_sha256}`);
    }
    return;
  }
  if (command === "verify") {
    const result = verifyReplitBuildMeta();
    if (!result.ok) {
      for (const error of result.errors) console.error(`[replit] build metadata invalid: ${error}`);
      process.exitCode = 1;
      return;
    }
    if (!quiet) {
      console.log(`[replit] build metadata verified: commit=${result.meta.source.commit} contract=${result.meta.artifact_contract_sha256}`);
    }
    return;
  }
  throw new Error(`Unknown command: ${command}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
