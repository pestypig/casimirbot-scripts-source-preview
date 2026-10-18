import fs from "node:fs";
import path from "node:path";
import { helixEnvironmentActionDifferentialTraceSchema } from "../shared/helix-environment-action";
import { auditEnvironmentActionG2Parity } from "../server/services/environment-connectors/actions/workflow-g2-parity-audit";

const argument = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
};

const a0Path = argument("--a0");
const a1Path = argument("--a1");
const bPath = argument("--b");
const outputPath = argument("--out");
if (!a0Path || !a1Path || !bPath || !outputPath) {
  throw new Error("Usage: --a0 <direct-trace.json> --a1 <mcp-trace.json> --b <ask-trace.json> --out <audit.json>");
}

const readTrace = (filePath: string) =>
  helixEnvironmentActionDifferentialTraceSchema.parse(
    JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")),
  );
const audit = auditEnvironmentActionG2Parity({
  a0: readTrace(a0Path),
  a1: readTrace(a1Path),
  b: readTrace(bPath),
});
const resolvedOutput = path.resolve(outputPath);
fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
fs.writeFileSync(resolvedOutput, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
process.stdout.write(`${audit.ok ? "PASS" : "DIVERGED"} ${audit.action_kind} first_divergence=${audit.first_divergence_stage ?? "none"}\n`);
process.exitCode = audit.ok ? 0 : 1;
