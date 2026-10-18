import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Ajv from "ajv";
import { computeDecisionHash, stableStringify } from "./lib/helix-decision-bundle";

const ROOT = process.cwd();
const DEFAULT_BUNDLE = "reports/helix-decision-bundle.json";
const OUT_PATH = "reports/helix-decision-bundle-verify.json";
const SCHEMA_PATH = "schemas/helix-decision-bundle.schema.json";

function parseArgs(): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 1) {
    const token = process.argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "true";
    args.set(key, value);
  }
  return args;
}

function readJson(relPath: string): any {
  return JSON.parse(fs.readFileSync(path.resolve(ROOT, relPath), "utf8"));
}

function resolveLocator(locator: string): string {
  if (locator.startsWith("file://")) return new URL(locator).pathname;
  return path.resolve(ROOT, locator);
}

function sha256(absPath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
}


function collectPayloadParityMismatches(bundle: any): string[] {
  const keys = ["gates", "novelty", "provenance", "casimir"] as const;
  const mismatches: string[] = [];
  const payload = bundle?.decision?.normalized_payload ?? {};
  for (const key of keys) {
    const top = stableStringify(bundle?.[key] ?? null);
    const nested = stableStringify(payload?.[key] ?? null);
    if (top !== nested) mismatches.push(`payload_section_mismatch:${key}`);
  }
  return mismatches;
}

function writeOut(out: Record<string, unknown>): void {
  fs.mkdirSync(path.resolve(ROOT, "reports"), { recursive: true });
  fs.writeFileSync(path.resolve(ROOT, OUT_PATH), `${JSON.stringify(out, null, 2)}\n`);
}

function main(): void {
  const args = parseArgs();
  const bundlePath = args.get("bundle") ?? DEFAULT_BUNDLE;
  const failures: string[] = [];

  let schema: any = null;
  let bundle: any = null;
  try {
    schema = readJson(SCHEMA_PATH);
  } catch (error) {
    failures.push(`schema_unreadable:${String(error)}`);
  }
  try {
    bundle = readJson(bundlePath);
  } catch (error) {
    failures.push(`bundle_unreadable:${String(error)}`);
  }

  if (schema && bundle) {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    if (!validate(bundle)) {
      failures.push("schema_validation_failed");
      for (const err of validate.errors ?? []) {
        failures.push(`schema_error:${err.instancePath || "/"}:${err.message ?? "unknown"}`);
      }
    }

    const requiredObjects = ["gates", "novelty", "provenance", "casimir"];
    for (const key of requiredObjects) {
      if (!(key in bundle) || bundle[key] == null) failures.push(`required_missing:${key}`);
    }

    for (const entry of Array.isArray(bundle.evidence) ? bundle.evidence : []) {
      const locator = String(entry.locator ?? "");
      const sourcePath = typeof entry.source_path === "string" ? entry.source_path : null;
      const abs = resolveLocator(locator);
      if (!fs.existsSync(abs)) {
        failures.push(`evidence_missing:${entry.name}:${locator}`);
        continue;
      }
      if (sourcePath && !fs.existsSync(path.resolve(ROOT, sourcePath))) {
        failures.push(`evidence_source_path_missing:${entry.name}:${sourcePath}`);
      }
      const digest = sha256(abs);
      if (digest !== entry.digest?.sha256) failures.push(`evidence_digest_mismatch:${entry.name}`);
      const size = fs.statSync(abs).size;
      if (size !== entry.size_bytes) failures.push(`evidence_size_mismatch:${entry.name}`);
    }

    const payload = bundle.decision?.normalized_payload;
    const recomputed = computeDecisionHash(payload);
    if (bundle.decision?.decision_hash !== recomputed) failures.push("decision_hash_mismatch");
    if (bundle.replay?.expected_decision_hash !== recomputed) failures.push("replay_expected_decision_hash_mismatch");
    failures.push(...collectPayloadParityMismatches(bundle));
  }

  const out = {
    ok: failures.length === 0,
    bundle_path: bundlePath,
    failure_count: failures.length,
    first_blocker: failures[0] ?? null,
    failures,
  };

  writeOut(out);
  console.log(JSON.stringify(out, null, 2));
  if (!out.ok) process.exit(1);
}

main();
