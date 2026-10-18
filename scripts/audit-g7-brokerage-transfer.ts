import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  auditG7BrokerageTransfer,
  type G7BrokerageTransferAuditInput,
} from "../server/services/environment-connectors/brokerage/g7-transfer-audit";

const [inputPathArg, outputPathArg] = process.argv.slice(2);
if (!inputPathArg) {
  throw new Error(
    "Usage: tsx scripts/audit-g7-brokerage-transfer.ts <tripath-input.json> [audit-output.json]",
  );
}

const inputPath = path.resolve(inputPathArg);
const parsed = JSON.parse(await readFile(inputPath, "utf8")) as
  Omit<G7BrokerageTransferAuditInput, "now"> & { now?: string | Date };
const audit = auditG7BrokerageTransfer({
  ...parsed,
  ...(parsed.now ? { now: new Date(parsed.now) } : {}),
});
const serialized = `${JSON.stringify(audit, null, 2)}\n`;
if (outputPathArg) {
  await writeFile(path.resolve(outputPathArg), serialized, "utf8");
} else {
  process.stdout.write(serialized);
}
if (!audit.ok) process.exitCode = 1;
