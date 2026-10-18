import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type HelixAuditNote = {
  ticket: string;
  created_at: string;
  trace_id: string;
  run_id: string;
  verdict: string;
  certificate_hash: string;
  integrity_ok: boolean;
  verify_artifact_path: string;
  trace_export_path: string;
  artifact_hashes: {
    verify_artifact_sha256: string;
    trace_export_sha256: string;
  };
  commands: string[];
};

const sha256Hex = (content: Buffer | string): string =>
  crypto.createHash("sha256").update(content).digest("hex");

const normalizeToPosixPath = (relativePath: string): string => relativePath.split(path.sep).join("/");

const isCanonicalTextArtifact = (filePath: string): boolean => {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".json" || ext === ".jsonl";
};

const canonicalizeTextEol = (content: string): string => content.replace(/\r\n/g, "\n");

export const computeFileSha256 = (filePath: string): string => {
  const content = fs.readFileSync(filePath);
  return sha256Hex(content);
};

export const computeAuditArtifactSha256 = (filePath: string): string => {
  const content = fs.readFileSync(filePath);
  if (!isCanonicalTextArtifact(filePath)) {
    return sha256Hex(content);
  }
  return sha256Hex(canonicalizeTextEol(content.toString("utf8")));
};

export const formatUtcTimestamp = (date = new Date()): string =>
  date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

export const validateHelixAskAuditNote = (
  notePath: string,
  rootDir = process.cwd(),
): { ok: true } => {
  const note = JSON.parse(fs.readFileSync(notePath, "utf8")) as Partial<HelixAuditNote>;
  const requiredString: Array<keyof HelixAuditNote> = [
    "trace_id",
    "run_id",
    "verdict",
    "certificate_hash",
    "verify_artifact_path",
    "trace_export_path",
  ];
  for (const field of requiredString) {
    const value = note[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`missing_or_invalid_field:${String(field)}`);
    }
  }
  if (typeof note.integrity_ok !== "boolean") {
    throw new Error("missing_or_invalid_field:integrity_ok");
  }
  if (note.verdict !== "PASS") {
    throw new Error("invalid_verdict:not_pass");
  }
  if (note.integrity_ok !== true) {
    throw new Error("invalid_integrity:not_true");
  }
  if (typeof note.trace_id !== "string" || note.trace_id.trim().length === 0) {
    throw new Error("missing_or_invalid_field:trace_id");
  }
  if (typeof note.run_id !== "string" || note.run_id.trim().length === 0) {
    throw new Error("missing_or_invalid_field:run_id");
  }
  if (typeof note.certificate_hash !== "string" || !/^[a-f0-9]{64}$/i.test(note.certificate_hash)) {
    throw new Error("missing_or_invalid_field:certificate_hash");
  }
  if (!note.artifact_hashes || typeof note.artifact_hashes !== "object") {
    throw new Error("missing_or_invalid_field:artifact_hashes");
  }
  const verifyAbs = path.resolve(rootDir, note.verify_artifact_path as string);
  const traceAbs = path.resolve(rootDir, note.trace_export_path as string);
  if (!fs.existsSync(verifyAbs)) {
    throw new Error("missing_artifact:verify_artifact_path");
  }
  if (!fs.existsSync(traceAbs)) {
    throw new Error("missing_artifact:trace_export_path");
  }
  const verifyHash = computeAuditArtifactSha256(verifyAbs);
  const traceHash = computeAuditArtifactSha256(traceAbs);
  if (note.artifact_hashes.verify_artifact_sha256 !== verifyHash) {
    throw new Error("artifact_hash_mismatch:verify_artifact_sha256");
  }
  if (note.artifact_hashes.trace_export_sha256 !== traceHash) {
    throw new Error("artifact_hash_mismatch:trace_export_sha256");
  }
  return { ok: true };
};

export const writeHelixAskAuditArtifacts = ({
  verifierOutput,
  traceExportJsonl,
  commands,
  ticket = "HELIX-ASK",
  rootDir = process.cwd(),
  timestamp = formatUtcTimestamp(),
}: {
  verifierOutput: Record<string, unknown>;
  traceExportJsonl: string;
  commands: string[];
  ticket?: string;
  rootDir?: string;
  timestamp?: string;
}): { verifyArtifactPath: string; traceExportPath: string; auditNotePath: string } => {
  const verifyRel = path.join("artifacts", "verification", `helix-casimir-${timestamp}.json`);
  const traceRel = path.join("artifacts", "verification", `helix-training-trace-${timestamp}.jsonl`);
  const auditRel = path.join("docs", "audits", "helix-results", `HELIX-ASK-${timestamp}.json`);
  const verifyRelNote = normalizeToPosixPath(verifyRel);
  const traceRelNote = normalizeToPosixPath(traceRel);

  const verifyAbs = path.resolve(rootDir, verifyRel);
  const traceAbs = path.resolve(rootDir, traceRel);
  const auditAbs = path.resolve(rootDir, auditRel);

  fs.mkdirSync(path.dirname(verifyAbs), { recursive: true });
  fs.mkdirSync(path.dirname(traceAbs), { recursive: true });
  fs.mkdirSync(path.dirname(auditAbs), { recursive: true });

  fs.writeFileSync(verifyAbs, `${JSON.stringify(verifierOutput, null, 2)}\n`, "utf8");
  fs.writeFileSync(traceAbs, traceExportJsonl.endsWith("\n") ? traceExportJsonl : `${traceExportJsonl}\n`, "utf8");

  const traceId = String(verifierOutput.traceId ?? "").trim();
  const runId = String(verifierOutput.runId ?? "").trim();
  const verdict = String(verifierOutput.verdict ?? "").trim();
  const certificate = (verifierOutput.certificate ?? {}) as {
    certificateHash?: string;
    integrityOk?: boolean;
  };
  const certificateHash = String(certificate.certificateHash ?? "").trim();
  const integrityOk = certificate.integrityOk === true;

  const note: HelixAuditNote = {
    ticket,
    created_at: new Date().toISOString(),
    trace_id: traceId,
    run_id: runId,
    verdict,
    certificate_hash: certificateHash,
    integrity_ok: integrityOk,
    verify_artifact_path: verifyRelNote,
    trace_export_path: traceRelNote,
    artifact_hashes: {
      verify_artifact_sha256: computeAuditArtifactSha256(verifyAbs),
      trace_export_sha256: computeAuditArtifactSha256(traceAbs),
    },
    commands,
  };

  fs.writeFileSync(auditAbs, `${JSON.stringify(note, null, 2)}\n`, "utf8");
  return {
    verifyArtifactPath: verifyRel,
    traceExportPath: traceRel,
    auditNotePath: auditRel,
  };
};
