#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const permittedBundles = new Set(["ferrofluid", "theory-reference", "solar-analysis"]);
const bundles = (args[2] ?? "").split(",");
if (process.platform !== "win32" || args.length !== 3 || args[0] !== "--clipboard" ||
  !/^[A-Za-z0-9_.-]{1,80}$/u.test(args[1]) || !bundles.every(bundle => permittedBundles.has(bundle)) ||
  new Set(bundles).size !== bundles.length) {
  console.error("Usage on Windows: node scripts/research-mcp-client-grant.mjs --clipboard <client-id> <comma-separated-bundles>");
  process.exit(1);
}
const token = "cb_research_mcp_" + crypto.randomBytes(32).toString("base64url");
const copied = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; $researchClientToken = [Console]::In.ReadToEnd(); Set-Clipboard -Value $researchClientToken"],
  { input: token, encoding: "utf8", windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
if (copied.status !== 0) { console.error("Secure clipboard delivery failed. No grant was emitted."); process.exit(1); }
const issued = new Date();
console.log(JSON.stringify({
  client_id: args[1], token_sha256: crypto.createHash("sha256").update(token).digest("hex"),
  issued_at: issued.toISOString(), expires_at: new Date(issued.getTime() + 7 * 86400000).toISOString(), bundles,
}));
console.log("Client credential copied privately. Add the hash-only JSON object to the server grant array. Paste the credential only into the client's secure entry, then overwrite the clipboard.");
