import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { computeDecisionHash } from "./lib/helix-decision-bundle";

type CliKey = "narrow" | "heavy" | "heavy-recommendation" | "ab-t02" | "ab-t035" | "casimir";

const ROOT = process.cwd();
const PACKAGE_JSON = "reports/helix-decision-package.json";
const BUNDLE_JSON = "reports/helix-decision-bundle.json";
const BUNDLE_MD = "reports/helix-decision-bundle.md";
const DEFAULT_POLICY_FILE = "configs/helix-decision-policy.v1.json";
const requiredKeys: CliKey[] = ["narrow", "heavy", "heavy-recommendation", "ab-t02", "ab-t035", "casimir"];

function parseArgs(): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 1) {
    const token = process.argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "true";
    out.set(key, value);
  }
  return out;
}

function git(cmd: string): string | null {
  try {
    return spawnSync(cmd, { shell: true, cwd: ROOT, encoding: "utf8" }).stdout?.trim() ?? null;
  } catch {
    return null;
  }
}

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.resolve(ROOT, relPath), "utf8"));
}

function sha256AndSize(relPath: string): { sha256: string; size_bytes: number } {
  const abs = path.resolve(ROOT, relPath);
  const buf = fs.readFileSync(abs);
  return { sha256: crypto.createHash("sha256").update(buf).digest("hex"), size_bytes: fs.statSync(abs).size };
}

function fail(reason: string, extra: Record<string, unknown> = {}): never {
  console.error(JSON.stringify({ ok: false, error: reason, ...extra }, null, 2));
  process.exit(1);
}

function mediaTypeFor(relPath: string): string {
  if (relPath.endsWith(".json")) return "application/json";
  if (relPath.endsWith(".md")) return "text/markdown";
  return "application/octet-stream";
}

function readPolicyArtifact(relPath: string): { hash: string; version: string } {
  const abs = path.resolve(ROOT, relPath);
  if (!fs.existsSync(abs)) fail("policy_file_missing", { path: relPath });
  try {
    const bytes = fs.readFileSync(abs);
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const version = typeof parsed.version === "string" ? parsed.version : "decision_grade";
    return {
      hash: crypto.createHash("sha256").update(bytes).digest("hex"),
      version,
    };
  } catch (error) {
    fail("policy_file_unreadable", { path: relPath, reason: String(error) });
  }
}

function main(): void {
  const args = parseArgs();
  const policyFile = args.get("policy-file") ?? DEFAULT_POLICY_FILE;
  const policyArtifact = readPolicyArtifact(policyFile);
  const values = new Map<CliKey, string>();
  for (const key of requiredKeys) {
    const value = args.get(key);
    if (!value) fail(`missing_required_arg:${key}`);
    if (!fs.existsSync(path.resolve(ROOT, value))) fail(`missing_input:${key}`, { path: value });
    values.set(key, value);
  }

  const evaluationTier = args.get("evaluation-tier");
  const packageCmd = [
    "npm run helix:decision:package --",
    `--narrow ${values.get("narrow")}`,
    `--heavy ${values.get("heavy")}`,
    `--heavy-recommendation ${values.get("heavy-recommendation")}`,
    `--ab-t02 ${values.get("ab-t02")}`,
    `--ab-t035 ${values.get("ab-t035")}`,
    `--casimir ${values.get("casimir")}`,
    ...(evaluationTier ? [`--evaluation-tier ${evaluationTier}`] : []),
  ].join(" ");

  const run = spawnSync(packageCmd, { shell: true, cwd: ROOT, stdio: "inherit" });
  if ((run.status ?? 1) !== 0) fail("package_generation_failed", { status: run.status ?? 1 });

  const pkg = readJson(PACKAGE_JSON);

  const evidence = requiredKeys.map((key) => {
    const source_path = values.get(key)!;
    const digest = sha256AndSize(source_path);
    return {
      name: key,
      digest: { sha256: digest.sha256 },
      size_bytes: digest.size_bytes,
      media_type: mediaTypeFor(source_path),
      locator: source_path,
      source_path,
    };
  });

  const decisionPayload = {
    value: (pkg.decision as any)?.value ?? "UNKNOWN",
    hard_blockers: Array.isArray((pkg.decision as any)?.hard_blockers) ? (pkg.decision as any).hard_blockers : [],
    gates: pkg.gates ?? [],
    novelty: pkg.novelty ?? {},
    provenance: pkg.provenance ?? {},
    casimir: pkg.casimir ?? {},
  };
  const decisionHash = computeDecisionHash(decisionPayload);

  const bundle = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    git: pkg.git,
    policy: {
      id: "helix-decision-policy",
      version: policyArtifact.version,
      hash: policyArtifact.hash,
    },
    evidence,
    gates: pkg.gates,
    novelty: pkg.novelty,
    provenance: pkg.provenance,
    casimir: pkg.casimir,
    decision: {
      value: decisionPayload.value,
      hard_blockers: decisionPayload.hard_blockers,
      normalized_payload: decisionPayload,
      decision_hash: decisionHash,
    },
    replay: {
      command: packageCmd,
      expected_decision_hash: decisionHash,
    },
  };

  fs.mkdirSync(path.resolve(ROOT, "reports"), { recursive: true });
  fs.writeFileSync(path.resolve(ROOT, BUNDLE_JSON), `${JSON.stringify(bundle, null, 2)}\n`);
  fs.writeFileSync(
    path.resolve(ROOT, BUNDLE_MD),
    [
      "# Helix decision bundle v2",
      "",
      `- decision: ${bundle.decision.value}`,
      `- decision_hash: ${bundle.decision.decision_hash}`,
      `- evidence_count: ${bundle.evidence.length}`,
      `- replay: \`${bundle.replay.command}\``,
    ].join("\n") + "\n",
  );

  console.log(JSON.stringify({ ok: true, bundle: BUNDLE_JSON, decision_hash: decisionHash }, null, 2));
}

main();
