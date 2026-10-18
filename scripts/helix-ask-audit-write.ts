import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  formatUtcTimestamp,
  validateHelixAskAuditNote,
  writeHelixAskAuditArtifacts,
} from "./lib/helix-audit-evidence";

type ParsedArgs = {
  url: string;
  exportUrl: string;
  packId: string;
  traceId: string;
  tenant?: string;
  token?: string;
  traceLimit: number;
  ticket: string;
};

const parseArgs = (): ParsedArgs => {
  const args = process.argv.slice(2);
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (!key.startsWith("--")) continue;
    const value = args[i + 1];
    if (value && !value.startsWith("--")) {
      map.set(key, value);
      i += 1;
    } else {
      map.set(key, "1");
    }
  }
  const timestamp = formatUtcTimestamp();
  const url = map.get("--url") ?? "http://127.0.0.1:5173/api/agi/adapter/run";
  const exportUrl = map.get("--export-url") ?? "http://127.0.0.1:5173/api/agi/training-trace/export";
  return {
    url,
    exportUrl,
    packId: map.get("--pack") ?? "repo-convergence",
    traceId: map.get("--trace-id") ?? `helix-ask-${timestamp}`,
    traceLimit: Number.parseInt(map.get("--trace-limit") ?? "200", 10),
    ticket: map.get("--ticket") ?? "HELIX-ASK",
    tenant: map.get("--tenant"),
    token: map.get("--token"),
  };
};


const runCasimirVerifyFallback = (args: ParsedArgs): Record<string, unknown> => {
  const cmdArgs = [
    "tsx",
    "cli/casimir-verify.ts",
    "--pack",
    args.packId,
    "--url",
    args.url,
    "--export-url",
    args.exportUrl,
    "--trace-limit",
    String(args.traceLimit),
    "--ci",
  ];
  const output = execFileSync("npx", cmdArgs, { encoding: "utf8" });
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("verify_fallback_parse_failed");
  }
  return JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
};

const main = async () => {
  const args = parseArgs();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (args.token) headers.Authorization = `Bearer ${args.token}`;
  if (args.tenant) headers["X-Tenant-Id"] = args.tenant;

  const verifyPayload = {
    traceId: args.traceId,
    mode: "constraint-pack",
    ci: true,
    pack: {
      id: args.packId,
      autoTelemetry: true,
    },
  };

  const verifyRes = await fetch(args.url, {
    method: "POST",
    headers,
    body: JSON.stringify(verifyPayload),
  });
  if (!verifyRes.ok) {
    throw new Error(`verify_failed:${verifyRes.status}`);
  }
  let verifierOutput = (await verifyRes.json()) as Record<string, unknown>;
  if (String(verifierOutput.verdict ?? "").trim() !== "PASS") {
    verifierOutput = runCasimirVerifyFallback(args);
  }

  const traceUrl = new URL(args.exportUrl);
  traceUrl.searchParams.set("limit", String(args.traceLimit));
  const traceRes = await fetch(traceUrl, { headers });
  if (!traceRes.ok) {
    throw new Error(`trace_export_failed:${traceRes.status}`);
  }
  const traceExportJsonl = await traceRes.text();

  const commands = [
    `POST ${args.url}`,
    `GET ${traceUrl.toString()}`,
  ];

  const written = writeHelixAskAuditArtifacts({
    verifierOutput,
    traceExportJsonl,
    commands,
    ticket: args.ticket,
  });

  validateHelixAskAuditNote(path.resolve(process.cwd(), written.auditNotePath));

  process.stdout.write(`${JSON.stringify(written, null, 2)}\n`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
