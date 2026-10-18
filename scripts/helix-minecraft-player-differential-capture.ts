import fs from "node:fs";
import path from "node:path";
import {
  captureEnvironmentActionDifferentialTrace,
  environmentActionDifferentialCaptureInputSchema,
} from "../server/services/environment-connectors/actions/workflow-differential-trace-capture";

const argument = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
};

const inputPath = argument("--input");
const outputPath = argument("--out");
if (!inputPath || !outputPath) {
  throw new Error("Usage: --input <public-capture.json> --out <trace.json>");
}

const capture = environmentActionDifferentialCaptureInputSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8")),
);
const trace = captureEnvironmentActionDifferentialTrace(capture);
const resolvedOutput = path.resolve(outputPath);
fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
fs.writeFileSync(resolvedOutput, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
process.stdout.write(
  `CAPTURED ${trace.lane} ${trace.action_kind} ${trace.trace_id}\n`,
);
