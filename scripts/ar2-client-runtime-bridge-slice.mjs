/** Select only the native live-connection type from a mixed client bridge. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relative = "client/src/lib/runtime/RuntimeSurfaceProvider.tsx";
const base = execFileSync("git", ["show", `HEAD:${relative}`],
  { cwd: root, encoding: "utf8" }).replace(/\r\n/g, "\n");
const current = readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");
const line = '  liveConnection?: (request: import("@shared/desktop-live-connection").LiveConnectionRequest) =>\n' +
  '    Promise<import("@shared/desktop-live-connection").LiveConnectionResult>;\n';
const anchor = "  saveSolarObservation?:";
if (!current.includes(line) || base.includes(line) ||
    base.indexOf(anchor) < 0 || base.indexOf(anchor, base.indexOf(anchor) + anchor.length) >= 0)
  throw Error("ar2_client_bridge_anchor_missing_or_ambiguous");
const selected = base.replace(anchor, line + anchor);
if (selected.includes("preparePrivateClock"))
  throw Error("ar2_client_bridge_contains_private_clock");
const output = path.join(root, "artifacts/ar2-source-selection/RuntimeSurfaceProvider.tsx");
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, selected);
process.stdout.write(`ar2_client_bridge_slice=${path.relative(root, output)}\n`);
