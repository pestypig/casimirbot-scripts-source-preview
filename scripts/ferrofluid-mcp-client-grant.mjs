#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

// Secrets travel only over child stdin into the owner's clipboard, never stdout or argv.
const argumentsList = process.argv.slice(2);
if (process.platform !== "win32" || argumentsList.length !== 2 ||
  argumentsList[0] !== "--clipboard" || !/^[A-Za-z0-9_.-]{1,80}$/u.test(argumentsList[1])) {
  console.error("Usage on Windows: node scripts/ferrofluid-mcp-client-grant.mjs --clipboard <client-id>");
  process.exit(1);
}
const token = "cb_ferro_mcp_" + crypto.randomBytes(32).toString("base64url");
const copied = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; $ferrofluidToken = [Console]::In.ReadToEnd(); Set-Clipboard -Value $ferrofluidToken"],
  { input: token, encoding: "utf8", windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
if (copied.status !== 0) {
  console.error("Secure clipboard delivery failed. No grant was emitted.");
  process.exit(1);
}
const issued = new Date();
console.log(JSON.stringify({
  client_id: argumentsList[1],
  token_sha256: crypto.createHash("sha256").update(token).digest("hex"),
  issued_at: issued.toISOString(),
  expires_at: new Date(issued.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
}));
console.log("Client token copied privately. Paste only into the external client's secure credential entry. The JSON above contains its hash, not its bearer token.");
