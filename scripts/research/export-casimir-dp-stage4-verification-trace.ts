import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;

export type Stage4TraceFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type Stage4VerificationTraceExportOptions = {
  url?: string;
  runId: string;
  expectedTraceId: string;
  outputPath: string;
  inputResponsePath?: string;
  fetchImpl?: Stage4TraceFetch;
};

export type Stage4VerificationTraceExportResult = {
  endpoint: string | null;
  runId: string;
  traceId: string;
  outputPath: string;
  bytes: number;
  sha256: string;
  lineCount: 1;
};

export type Stage4VerificationTraceCliArgs = {
  url?: string;
  runId: string;
  expectedTraceId: string;
  outputPath: string;
  inputResponsePath?: string;
};

const USAGE = [
  "Usage:",
  "  tsx scripts/research/export-casimir-dp-stage4-verification-trace.ts",
  "    --url <base-or-training-trace-url>",
  "    --run-id <adapter-run-id>",
  "    --expected-trace-id <trace-id>",
  "    --output <new-jsonl-path>",
  "    [--input-response <saved-endpoint-response.json>]",
  "",
  "When --input-response is present, the saved response is validated instead of",
  "performing a network request. The URL remains optional in that test/replay mode.",
].join("\n");

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireNonEmpty = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
};

const assertNoNulByte = (bytes: Uint8Array, label: string): void => {
  if (bytes.includes(0)) {
    throw new Error(`${label} contains a NUL byte`);
  }
};

const assertNoNulCharacter = (
  value: unknown,
  label: string,
  seen = new Set<object>(),
): void => {
  if (typeof value === "string") {
    if (value.includes("\0")) {
      throw new Error(`${label} contains a NUL character`);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (seen.has(value)) {
    throw new Error(`${label} contains a cyclic value`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoNulCharacter(entry, `${label}[${index}]`, seen),
    );
  } else {
    for (const [key, entry] of Object.entries(value)) {
      assertNoNulCharacter(key, `${label} key`, seen);
      assertNoNulCharacter(entry, `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
};

const parseJsonObject = (bytes: Uint8Array, label: string): JsonObject => {
  assertNoNulByte(bytes, label);
  const raw = Buffer.from(bytes).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${reason}`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`${label} must contain one JSON object`);
  }
  assertNoNulCharacter(parsed, label);
  return parsed;
};

export const resolveStage4TrainingTraceUrl = (
  rawUrl: string,
  runId: string,
): string => {
  const normalizedRunId = requireNonEmpty(runId, "runId");
  let parsed: URL;
  try {
    parsed = new URL(requireNonEmpty(rawUrl, "url"));
  } catch {
    throw new Error("url must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must use HTTP or HTTPS");
  }

  const trimmedPath = parsed.pathname.replace(/\/+$/, "");
  const collectionSuffix = "/api/agi/training-trace";
  if (trimmedPath.endsWith(collectionSuffix)) {
    parsed.pathname = `${trimmedPath}/${encodeURIComponent(normalizedRunId)}`;
  } else {
    parsed.pathname = `${trimmedPath}${collectionSuffix}/${encodeURIComponent(normalizedRunId)}`;
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
};

const requireTraceIdentity = (
  responsePayload: JsonObject,
  runId: string,
  expectedTraceId: string,
): JsonObject => {
  if (!isJsonObject(responsePayload.trace)) {
    throw new Error("training-trace response must contain one trace object");
  }
  const trace = responsePayload.trace;
  if (trace.kind !== "training-trace") {
    throw new Error("training-trace response has an invalid trace.kind");
  }
  if (trace.id !== runId) {
    throw new Error(
      `training-trace runId mismatch: expected ${JSON.stringify(runId)}, received ${JSON.stringify(trace.id)}`,
    );
  }
  if (trace.traceId !== expectedTraceId) {
    throw new Error(
      `training-trace traceId mismatch: expected ${JSON.stringify(expectedTraceId)}, received ${JSON.stringify(trace.traceId)}`,
    );
  }
  requireRepoConvergencePass(trace);
  assertNoNulCharacter(trace, "training trace");
  return trace;
};

const requireRepoConvergencePass = (trace: JsonObject): void => {
  if (trace.pass !== true) {
    throw new Error("training trace must record pass=true");
  }
  if (trace.firstFail !== undefined && trace.firstFail !== null) {
    throw new Error("passing training trace must not contain a firstFail");
  }
  if (!Array.isArray(trace.deltas)) {
    throw new Error("training trace must contain a deltas array");
  }
  if (
    !isJsonObject(trace.source) ||
    trace.source.system !== "constraint-pack" ||
    trace.source.component !== "adapter" ||
    trace.source.tool !== "repo-convergence"
  ) {
    throw new Error(
      "training trace must be the repo-convergence constraint-pack adapter record",
    );
  }
  if (!isJsonObject(trace.signal) || trace.signal.kind !== "repo-certified") {
    throw new Error("training trace must contain signal.kind=repo-certified");
  }
  if (!isJsonObject(trace.certificate)) {
    throw new Error("passing training trace must contain a certificate");
  }
  const certificateHash = trace.certificate.certificateHash;
  if (
    typeof certificateHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(certificateHash)
  ) {
    throw new Error(
      "training trace certificate.certificateHash must be a lowercase SHA-256",
    );
  }
  if (trace.certificate.integrityOk !== true) {
    throw new Error(
      "training trace certificate.integrityOk must be true",
    );
  }
  if (trace.certificate.status !== "GREEN") {
    throw new Error("training trace certificate.status must be GREEN");
  }
};

const readResponseBytes = async (
  options: Stage4VerificationTraceExportOptions,
  endpoint: string | null,
): Promise<Uint8Array> => {
  if (options.inputResponsePath) {
    return readFile(path.resolve(options.inputResponsePath));
  }
  if (!endpoint) {
    throw new Error("url is required unless --input-response is provided");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(endpoint, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  assertNoNulByte(bytes, "training-trace HTTP response");
  if (!response.ok) {
    const detail = Buffer.from(bytes).toString("utf8").slice(0, 512);
    throw new Error(
      `training-trace request failed with HTTP ${response.status}: ${detail}`,
    );
  }
  return bytes;
};

export const validateStage4VerificationJsonl = (
  bytes: Uint8Array,
  expected: { runId: string; traceId: string },
): JsonObject => {
  assertNoNulByte(bytes, "verification JSONL");
  const raw = Buffer.from(bytes).toString("utf8");
  if (!raw.endsWith("\n")) {
    throw new Error("verification JSONL must end with exactly one newline");
  }
  if (raw.endsWith("\n\n")) {
    throw new Error("verification JSONL must not contain a blank trailing line");
  }
  const lines = raw.slice(0, -1).split("\n");
  if (lines.length !== 1 || !lines[0]) {
    throw new Error("verification JSONL must contain exactly one non-empty line");
  }
  const lineBytes = Buffer.from(lines[0], "utf8");
  const trace = parseJsonObject(lineBytes, "verification JSONL line 1");
  if (trace.id !== expected.runId) {
    throw new Error("verification JSONL line 1 has the wrong runId");
  }
  if (trace.traceId !== expected.traceId) {
    throw new Error("verification JSONL line 1 has the wrong traceId");
  }
  requireRepoConvergencePass(trace);
  if (JSON.stringify(trace) !== lines[0]) {
    throw new Error("verification JSONL line 1 is not compact JSON");
  }
  return trace;
};

export const exportStage4VerificationTrace = async (
  options: Stage4VerificationTraceExportOptions,
): Promise<Stage4VerificationTraceExportResult> => {
  const runId = requireNonEmpty(options.runId, "runId");
  const expectedTraceId = requireNonEmpty(
    options.expectedTraceId,
    "expectedTraceId",
  );
  const outputPath = path.resolve(
    requireNonEmpty(options.outputPath, "outputPath"),
  );
  const endpoint = options.inputResponsePath
    ? options.url
      ? resolveStage4TrainingTraceUrl(options.url, runId)
      : null
    : resolveStage4TrainingTraceUrl(
        requireNonEmpty(options.url ?? "", "url"),
        runId,
      );

  const responseBytes = await readResponseBytes(options, endpoint);
  const responsePayload = parseJsonObject(
    responseBytes,
    options.inputResponsePath
      ? "training-trace input response"
      : "training-trace HTTP response",
  );
  const trace = requireTraceIdentity(responsePayload, runId, expectedTraceId);
  const outputBytes = Buffer.from(`${JSON.stringify(trace)}\n`, "utf8");
  assertNoNulByte(outputBytes, "serialized verification JSONL");

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, outputBytes, { flag: "wx" });

  try {
    const persisted = await readFile(outputPath);
    validateStage4VerificationJsonl(persisted, {
      runId,
      traceId: expectedTraceId,
    });
    if (!persisted.equals(outputBytes)) {
      throw new Error("verification JSONL changed during persistence");
    }
  } catch (error) {
    await unlink(outputPath).catch(() => undefined);
    throw error;
  }

  return {
    endpoint,
    runId,
    traceId: expectedTraceId,
    outputPath,
    bytes: outputBytes.byteLength,
    sha256: createHash("sha256").update(outputBytes).digest("hex"),
    lineCount: 1,
  };
};

const takeArgValue = (
  args: string[],
  index: number,
  option: string,
): string => {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
};

export const parseStage4VerificationTraceArgs = (
  args: string[],
): Stage4VerificationTraceCliArgs => {
  let url: string | undefined;
  let runId: string | undefined;
  let expectedTraceId: string | undefined;
  let outputPath: string | undefined;
  let inputResponsePath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--help" || option === "-h") {
      throw new Error(USAGE);
    }
    if (option === "--url") {
      url = takeArgValue(args, index, option);
      index += 1;
    } else if (option === "--run-id") {
      runId = takeArgValue(args, index, option);
      index += 1;
    } else if (option === "--expected-trace-id") {
      expectedTraceId = takeArgValue(args, index, option);
      index += 1;
    } else if (option === "--output") {
      outputPath = takeArgValue(args, index, option);
      index += 1;
    } else if (option === "--input-response") {
      inputResponsePath = takeArgValue(args, index, option);
      index += 1;
    } else {
      throw new Error(`unknown option: ${option}\n${USAGE}`);
    }
  }

  if (!runId || !expectedTraceId || !outputPath) {
    throw new Error(USAGE);
  }
  if (!url && !inputResponsePath) {
    throw new Error(`--url is required for live export\n${USAGE}`);
  }
  return {
    url,
    runId,
    expectedTraceId,
    outputPath,
    inputResponsePath,
  };
};

const main = async (): Promise<void> => {
  const args = parseStage4VerificationTraceArgs(process.argv.slice(2));
  const result = await exportStage4VerificationTrace(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

export const stage4VerificationTraceUsage = USAGE;
