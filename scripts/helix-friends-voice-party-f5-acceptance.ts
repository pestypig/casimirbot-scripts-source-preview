import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  buildF5DeviceAcceptanceReceipt,
  verifyF5DualExeAcceptance,
  type F5CandidateType,
  type F5DeviceRole,
} from "./lib/helix-friends-voice-party-f5-acceptance";

const args = new Map<string, string>();
for (let index = 3; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || value === undefined) throw new Error("f5_arguments_invalid");
  args.set(key.slice(2), value);
}

const required = (name: string): string => {
  const value = args.get(name)?.trim() ?? "";
  if (!value) throw new Error(`f5_argument_${name}_required`);
  return value;
};

const readJson = (filePath: string): unknown =>
  JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));

const writeJson = (filePath: string, value: unknown): void => {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
};

const sha256File = (filePath: string): string => {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(path.resolve(filePath)));
  return hash.digest("hex");
};

const assertReadyReceipt = (filePath: string): void => {
  const receipt = readJson(filePath) as Record<string, unknown>;
  const pid = Number(receipt?.serviceProcessId);
  if (
    receipt?.schema !== "casimir_desktop_service_ready_receipt/1" ||
    receipt.ready !== true || !Number.isInteger(pid) || pid <= 0
  ) throw new Error("f5_native_ready_receipt_invalid");
  try {
    process.kill(pid, 0);
  } catch {
    throw new Error("f5_native_service_not_running");
  }
};

const command = process.argv[2];
if (command === "help" || command === "--help" || command === undefined) {
  process.stdout.write(
    "F5 physical harness: capture one sanitized running-EXE receipt per device, then verify --owner <file> --friend <file> [--output <file>]. See the F5 acceptance packet for capture arguments.\n",
  );
} else if (command === "capture") {
  const partyId = process.env.HELIX_F5_PARTY_ID?.trim() ?? "";
  delete process.env.HELIX_F5_PARTY_ID;
  if (!partyId) throw new Error("HELIX_F5_PARTY_ID_required");
  const readyReceiptPath = required("ready-receipt");
  assertReadyReceipt(readyReceiptPath);
  const transitions = required("transitions").split(",").map((value) => value.trim());
  const receipt = buildF5DeviceAcceptanceReceipt({
    runId: required("run-id"),
    role: required("role") as F5DeviceRole,
    deviceLabel: required("device-label"),
    packageVersion: required("package-version"),
    executableSha256: sha256File(required("executable")),
    partyId,
    startedAt: required("started-at"),
    endedAt: required("ended-at"),
    nativeReadyReceiptObserved: true,
    authenticatedCoordinationObserved: required("authenticated") === "true",
    direct: {
      connected: required("direct-connected") === "true",
      localCandidateType: required("direct-local") as F5CandidateType,
      remoteCandidateType: required("direct-remote") as F5CandidateType,
    },
    relay: {
      connected: required("relay-connected") === "true",
      localCandidateType: required("relay-local") as F5CandidateType,
      remoteCandidateType: required("relay-remote") as F5CandidateType,
    },
    recoveryTransitions: transitions,
    recoveredWithinWindow: required("recovered-within-window") === "true",
    cleanup: {
      microphoneTracksEnded: required("microphone-stopped") === "true",
      peerConnectionClosed: required("peer-closed") === "true",
      signalingPollingStopped: required("polling-stopped") === "true",
      ephemeralCredentialsDisposed: required("credentials-disposed") === "true",
    },
  });
  writeJson(required("output"), receipt);
  process.stdout.write(`${JSON.stringify({ ok: true, output: path.resolve(required("output")) })}\n`);
} else if (command === "verify") {
  const result = verifyF5DualExeAcceptance(
    readJson(required("owner")),
    readJson(required("friend")),
  );
  const output = args.get("output");
  if (output) writeJson(output, result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  throw new Error("Usage: help|capture|verify with explicit --name value arguments");
}
