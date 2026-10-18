import fs from "node:fs";
import path from "node:path";
import { ContributionReceiptSchema } from "@shared/contributions/contributions.schema";
import { trainingTraceSchema, type TrainingTraceRecord } from "@shared/schema";
import { WalletAgent } from "../tools/wallet-agent";

const USAGE = `
wallet-agent <command> [options]

Commands:
  init                         Initialize local wallet keys
  import --receipt <path>      Import a receipt JSON (optionally --trace)
  list                         List stored receipts
  verify --receipt <id>        Verify a stored receipt or record id
  disclose --receipt <id>      Build a disclosure for a receipt
  pubkey                       Print the wallet public key

Options:
  --dir <path>                 Wallet storage directory
  --trace <path>               Training trace JSON or JSONL
  --level <local|partial|public>
  --include-trace              Include trace summary for public disclosures
  --include-public-key         Include public key in disclosure payload
  --allow-override             Allow disclosure to exceed receipt share level
  --out <path>                 Write output JSON to a file
`;

type ArgMap = Map<string, string | boolean>;

const parseArgs = (argv: string[]) => {
  const args = argv.slice();
  const flags: ArgMap = new Map();
  let command: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const entry = args[i];
    if (!entry) continue;
    if (entry.startsWith("--")) {
      const key = entry.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
    } else if (!command) {
      command = entry;
    }
  }
  return { command, flags };
};

const readJsonFile = (filePath: string): unknown => {
  const resolved = path.resolve(filePath);
  const raw = fs.readFileSync(resolved, "utf8");
  return JSON.parse(raw);
};

const readTraceFile = (
  filePath: string,
  traceId?: string,
): TrainingTraceRecord | undefined => {
  const resolved = path.resolve(filePath);
  const raw = fs.readFileSync(resolved, "utf8").trim();
  if (!raw) return undefined;
  if (raw.startsWith("{")) {
    return trainingTraceSchema.parse(JSON.parse(raw));
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let fallback: TrainingTraceRecord | undefined;
  for (const line of lines) {
    try {
      const parsed = trainingTraceSchema.parse(JSON.parse(line));
      if (!fallback) fallback = parsed;
      if (traceId && (parsed.traceId === traceId || parsed.id === traceId)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return fallback;
};

const writeOutput = (payload: unknown, outPath?: string) => {
  const serialized = JSON.stringify(payload, null, 2);
  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), `${serialized}\n`, "utf8");
    return;
  }
  process.stdout.write(`${serialized}\n`);
};

const main = () => {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command || flags.has("help")) {
    process.stdout.write(USAGE);
    process.exit(command ? 0 : 1);
  }

  const dir = typeof flags.get("dir") === "string" ? String(flags.get("dir")) : undefined;
  const agent = new WalletAgent({ dir });

  if (command === "init") {
    writeOutput({ ok: true, keyId: agent.keyId, dir: agent.dir });
    return;
  }

  if (command === "pubkey") {
    writeOutput({ keyId: agent.keyId, publicKeyPem: agent.publicKeyPem }, flags.get("out") as string | undefined);
    return;
  }

  if (command === "list") {
    const receipts = agent.listReceipts().map((entry) => ({
      id: entry.id,
      receiptId: entry.receiptId,
      storedAt: entry.storedAt,
      hasTrace: Boolean(entry.trace),
    }));
    writeOutput({ receipts, total: receipts.length }, flags.get("out") as string | undefined);
    return;
  }

  if (command === "import") {
    const receiptPath = flags.get("receipt");
    if (typeof receiptPath !== "string") {
      throw new Error("--receipt path is required");
    }
    const rawReceipt = readJsonFile(receiptPath);
    const receipt = ContributionReceiptSchema.parse(rawReceipt);
    const tracePath = flags.get("trace");
    const trace =
      typeof tracePath === "string"
        ? readTraceFile(tracePath, receipt.verification.traceId ?? undefined)
        : undefined;
    const record = agent.importReceipt({
      receipt,
      trace,
      receiptSource: receiptPath,
      traceSource: typeof tracePath === "string" ? tracePath : undefined,
    });
    writeOutput({ ok: true, record }, flags.get("out") as string | undefined);
    return;
  }

  if (command === "verify") {
    const receiptId = flags.get("receipt");
    if (typeof receiptId !== "string") {
      throw new Error("--receipt id is required");
    }
    const result = agent.verifyReceipt(receiptId);
    writeOutput({ ok: result.ok, result }, flags.get("out") as string | undefined);
    return;
  }

  if (command === "disclose") {
    const receiptId = flags.get("receipt");
    const level = flags.get("level");
    if (typeof receiptId !== "string") {
      throw new Error("--receipt id is required");
    }
    if (level !== "local" && level !== "partial" && level !== "public") {
      throw new Error("--level must be local, partial, or public");
    }
    const result = agent.buildDisclosure({
      receiptId,
      shareLevel: level,
      includeTraceSummary: Boolean(flags.get("include-trace")),
      includePublicKey: Boolean(flags.get("include-public-key")),
      allowOverride: Boolean(flags.get("allow-override")),
    });
    if (!result.ok) {
      writeOutput(result, flags.get("out") as string | undefined);
      process.exit(2);
    }
    writeOutput(result.disclosure, flags.get("out") as string | undefined);
    return;
  }

  process.stdout.write(USAGE);
  process.exit(1);
};

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
