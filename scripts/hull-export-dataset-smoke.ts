import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { HullScientificExportRequestV1 } from "../shared/hull-export-contract";

const parseArgs = (argv: string[]) => {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key || !key.startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) continue;
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
};

const asJson = async <T = unknown>(value: string): Promise<T> =>
  JSON.parse(await fs.readFile(path.resolve(process.cwd(), value), "utf8")) as T;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = (args["base-url"] ?? "http://127.0.0.1:5050").replace(/\/+$/, "");
  const datasetEndpoint = `${baseUrl}/api/helix/hull-export/dataset`;
  const metricRefUrl =
    args["metric-ref-url"] ??
    `${baseUrl}/api/helix/gr-evolve-brick?quality=low&requireCongruentSolve=1`;
  const metricRefHash =
    args["metric-ref-hash"] ??
    createHash("sha256").update(metricRefUrl).digest("hex");
  const chart = args.chart ?? "comoving_cartesian";
  const certificatePath = args["certificate-path"];
  if (!certificatePath) {
    throw new Error("missing required --certificate-path <path-to-render-certificate.json>");
  }
  const certificate = await asJson<Record<string, unknown>>(certificatePath);
  const atlasPath = args["atlas-path"];
  const scientificAtlas = atlasPath
    ? await asJson<Record<string, unknown>>(atlasPath)
    : undefined;
  const now = Date.now();
  const payload: HullScientificExportRequestV1 = {
    version: 1,
    requestId: `hull-export-smoke-${now}`,
    strictScientific: true,
    metricVolumeRef: {
      kind: "gr-evolve-brick",
      url: metricRefUrl,
      chart,
      updatedAt: now,
      hash: metricRefHash,
    },
    renderCertificate: certificate as any,
    ...(scientificAtlas ? { scientificAtlas: scientificAtlas as any } : {}),
  };
  const response = await fetch(datasetEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || body.ok !== true) {
    throw new Error(
      `hull_export_dataset_failed status=${response.status} body=${JSON.stringify(body)}`,
    );
  }
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[hull-export-smoke] ${message}\n`);
  process.exitCode = 1;
});

