import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MARKER = "HELIX_MINECRAFT_RESIDENT_DECISION ";

type ResidentDecision = Record<string, unknown> & {
  created_at?: string;
  observation_revision?: number;
  reason_code?: string;
};

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name.slice(2)}_missing`);
  return value;
};

const defaultLog = (): string => {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("appdata_missing");
  return path.join(appData, ".minecraft", "logs", "latest.log");
};

export const parseResidentDecisionLog = (text: string): ResidentDecision[] =>
  text
    .split(/\r?\n/u)
    .flatMap((line) => {
      const markerIndex = line.indexOf(MARKER);
      if (markerIndex < 0) return [];
      const raw = line.slice(markerIndex + MARKER.length).trim();
      try {
        const value = JSON.parse(raw) as unknown;
        return value && typeof value === "object" && !Array.isArray(value)
          ? [value as ResidentDecision]
          : [];
      } catch {
        return [];
      }
    });

export const hasCompleteResidentCausality = (decision: ResidentDecision): boolean => {
  const hasSharedFields =
    typeof decision.bounded_effect === "string" &&
    typeof decision.postcondition_status === "string";
  if (!hasSharedFields) return false;
  if (decision.arbiter_outcome === "admitted") {
    return decision.effect_applied === true;
  }
  return decision.arbiter_outcome === "delegated_to_admitted_recovery" &&
    decision.bounded_effect === "continue_admitted_recovery" &&
    decision.effect_applied === false;
};

const capture = async (): Promise<void> => {
  const logPath = path.resolve(option("--log") ?? defaultLog());
  const sinceRaw = option("--since");
  const sinceMs = sinceRaw === undefined ? Number.NEGATIVE_INFINITY : Date.parse(sinceRaw);
  if (Number.isNaN(sinceMs)) throw new Error("since_invalid");
  const requiredReasons = (option("--require-reasons") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const decisions = parseResidentDecisionLog(await fs.readFile(logPath, "utf8"))
    .filter((decision) => {
      if (sinceRaw === undefined) return true;
      const createdMs = Date.parse(String(decision.created_at ?? ""));
      return Number.isFinite(createdMs) && createdMs >= sinceMs;
    });
  const revisions = decisions
    .map((decision) => decision.observation_revision)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const reasons = decisions.map((decision) => String(decision.reason_code ?? "unknown"));
  const missingReasons = requiredReasons.filter((reason) => !reasons.includes(reason));
  const significant = decisions.filter((decision) => decision.proposal !== "none");
  const payload = {
    schema: "helix.minecraft.resident_decision_capture.v1",
    captured_at: new Date().toISOString(),
    source_log: logPath,
    since: sinceRaw ?? null,
    decision_count: decisions.length,
    significant_decision_count: significant.length,
    observation_revisions_monotonic: revisions.every(
      (revision, index) => index === 0 || revision > revisions[index - 1]!,
    ),
    causal_fields_complete: significant.every(hasCompleteResidentCausality),
    required_reasons: requiredReasons,
    missing_reasons: missingReasons,
    artifact_versions: [...new Set(decisions.map((decision) => decision.artifact_version))],
    decisions,
  };
  const rendered = `${JSON.stringify(payload, null, 2)}${os.EOL}`;
  const output = option("--out");
  if (output) {
    const outputPath = path.resolve(output);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, rendered, "utf8");
    process.stdout.write(`${JSON.stringify({
      output: outputPath,
      decision_count: payload.decision_count,
      significant_decision_count: payload.significant_decision_count,
      observation_revisions_monotonic: payload.observation_revisions_monotonic,
      causal_fields_complete: payload.causal_fields_complete,
      missing_reasons: payload.missing_reasons,
    })}${os.EOL}`);
  } else {
    process.stdout.write(rendered);
  }
  if (decisions.length === 0) process.exitCode = 2;
  else if (!payload.observation_revisions_monotonic || missingReasons.length > 0) process.exitCode = 3;
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  capture().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
