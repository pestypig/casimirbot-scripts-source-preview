import fs from "node:fs";
import path from "node:path";
import {
  helixEnvironmentActionDifferentialTraceSchema,
} from "../shared/helix-environment-action";
import {
  auditEnvironmentActionDifferentialTraces,
} from "../server/services/environment-connectors/actions/workflow-differential-audit";

const argument = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
};

const referencePath = argument("--reference");
const helixPath = argument("--helix");
const outputPath = argument("--out");
if (!referencePath || !helixPath || !outputPath) {
  throw new Error(
    "Usage: --reference <direct-codex-trace.json> --helix <helix-trace.json> --out <audit.json>",
  );
}

const readTrace = (filePath: string) =>
  helixEnvironmentActionDifferentialTraceSchema.parse(
    JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")),
  );

const audit = auditEnvironmentActionDifferentialTraces({
  reference: readTrace(referencePath),
  helix: readTrace(helixPath),
});
const resolvedOutput = path.resolve(outputPath);
fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
fs.writeFileSync(resolvedOutput, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
process.stdout.write(
  `${audit.ok ? "PASS" : "DIVERGED"} ${audit.action_kind} first_divergence=${audit.first_divergence_stage ?? "none"}\n`,
);
process.exitCode = audit.ok ? 0 : 1;
