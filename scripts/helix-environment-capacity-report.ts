import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  buildHelixEnvironmentCapacityReport,
  helixEnvironmentCapacityReportSchema,
  helixEnvironmentCapacitySampleSchema,
  type HelixEnvironmentCapacityReport,
} from "../shared/helix-environment-time";

const inputSchema = z
  .object({
    schema: z.literal("environment.capacity_capture.v1"),
    report_id: z.string().trim().min(1).max(320),
    samples: z.array(helixEnvironmentCapacitySampleSchema).min(1).max(2_048),
    evidence_refs: z.array(z.string().trim().min(1).max(320)).min(1).max(512),
  })
  .strict();

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name.slice(2)}_missing`);
  }
  return value;
};

export const buildCapacityReportFromCapture = (
  input: unknown,
): HelixEnvironmentCapacityReport => {
  const capture = inputSchema.parse(input);
  return helixEnvironmentCapacityReportSchema.parse(
    buildHelixEnvironmentCapacityReport({
      report_id: capture.report_id,
      samples: capture.samples,
      evidence_refs: capture.evidence_refs,
    }),
  );
};

const run = async (): Promise<void> => {
  const inputPath = option("--input");
  if (!inputPath) throw new Error("input_required");
  const capture = JSON.parse(
    await fs.readFile(path.resolve(inputPath), "utf8"),
  ) as unknown;
  const report = buildCapacityReportFromCapture(capture);
  const rendered = `${JSON.stringify(report, null, 2)}${os.EOL}`;
  const outputPath = option("--out");
  if (outputPath) {
    const resolved = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, rendered, "utf8");
    process.stdout.write(
      `${JSON.stringify({
        output: resolved,
        sample_count: report.sample_count,
        rolling_cycle_count: report.rolling_cycle_count,
        missing_measurements: report.missing_measurements,
        exit_satisfied: report.exit_satisfied,
      })}${os.EOL}`,
    );
  } else {
    process.stdout.write(rendered);
  }
  if (!report.exit_satisfied) process.exitCode = 2;
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  run().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}${os.EOL}`,
    );
    process.exitCode = 1;
  });
}
