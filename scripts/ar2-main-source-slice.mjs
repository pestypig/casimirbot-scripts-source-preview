/** Produce a reviewable AR-2-only desktop main entry point from HEAD and the
 * canonical working tree. Never edits main.ts or the real Git index. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relative = "apps/desktop/src/main.ts";
const base = execFileSync("git", ["show", `HEAD:${relative}`], { cwd: root,
  encoding: "utf8" }).replace(/\r\n/g, "\n");
const current = readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");
const output = path.resolve(root, "artifacts/ar2-source-selection/main.ts");

const once = (source, from, to, label) => {
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + from.length) >= 0)
    throw Error(`ar2_slice_anchor_missing_or_ambiguous:${label}`);
  return source.slice(0, first) + to + source.slice(first + from.length);
};
const between = (source, start, end, label) => {
  const first = source.indexOf(start);
  if (first < 0 || source.indexOf(start, first + start.length) >= 0)
    throw Error(`ar2_slice_start_missing_or_ambiguous:${label}`);
  const last = source.indexOf(end, first + start.length);
  if (last < 0) throw Error(`ar2_slice_end_missing:${label}`);
  return source.slice(first, last);
};

let selected = base;
selected = once(selected, 'import { appendOAuthDiagnostic } from "./oauth-diagnostic-journal";\n',
  'import { appendOAuthDiagnostic } from "./oauth-diagnostic-journal";\n' +
  'import { LiveConnectionStore } from "./live-connection-store";\n' +
  'import { DesktopQuitCoordinator } from "./desktop-quit-coordinator";\n' +
  'import { createDesktopHostedRoomConnection } from "./desktop-hosted-room-registration";\n' +
  'import { HostedRoomInterpreterEvaluationRunner } from "./hosted-room-interpreter-evaluation-runner";\n' +
  'import { DESKTOP_LIVE_CONNECTION_CHANNEL } from "./channels";\n', "imports");
selected = once(selected, 'import { randomBytes } from "node:crypto";',
  'import { createHash, randomBytes } from "node:crypto";', "crypto_import");
selected = once(selected, '  buildDesktopServiceEnvironment,\n',
  '  buildDesktopServiceEnvironment,\n  resolveDesktopRoomAuthority,\n', "authority_import");
selected = once(selected, '  providerCredentialBroker: DesktopProviderCredentialBroker;\n',
  '  providerCredentialBroker: DesktopProviderCredentialBroker;\n  liveConnectionStore: LiveConnectionStore;\n',
  "runtime_type");
selected = once(selected, 'let quitting = false;\n',
  'let quitting = false;\n' +
  'const hostedRoomEvaluationRunner = new HostedRoomInterpreterEvaluationRunner();\n' +
  'const desktopQuitCoordinator = new DesktopQuitCoordinator({\n' +
  '  beginQuit: () => { quitting = true; },\n' +
  '  resumeQuit: () => app.quit(),\n' +
  '  cleanups: [\n' +
  '    { run: async () => !desktopRuntime || desktopRuntime.liveConnectionStore.closeAllConversations(),\n' +
  '      failureCode: "managed_conversation_quit_cleanup_unconfirmed" },\n' +
  '    { run: async () => hostedRoomEvaluationRunner.closeRetainedConversations(profileId =>\n' +
  '      desktopRuntime?.liveConnectionStore.keyForProfile(profileId) ?? null),\n' +
  '      failureCode: "hosted_room_interpreter_quit_cleanup_unconfirmed" },\n' +
  '  ],\n' +
  '  recordFailure: (code) => {\n' +
  '    if (desktopRuntime) appendStartupJournal(desktopRuntime.startupJournal, "host", code, desktopRuntime.secret);\n' +
  '  },\n' +
  '});\n', "quit_setup");

const storeInit = between(current, '  const liveConnectionStore = new LiveConnectionStore({',
  '  const providerCredentialBroker =', "store_initialization");
selected = once(selected, '  const providerCredentialBroker =', storeInit +
  '  const providerCredentialBroker =', "store_insertion");
const brokerKeyResolver = between(current, '      resolveOpenAiApiKey: async (requesterRef) => {',
  '    });\n  const coordinationOrigin', "broker_key_resolver");
selected = once(selected, '      openAiApiKey: process.env.OPENAI_API_KEY,\n    });',
  '      openAiApiKey: process.env.OPENAI_API_KEY,\n' + brokerKeyResolver +
  '    });', "broker_key_insertion");
selected = once(selected, '    providerCredentialBroker,\n    friendsPartiesCoordinationBroker,',
  '    providerCredentialBroker,\n    liveConnectionStore,\n    friendsPartiesCoordinationBroker,',
  "runtime_value");

const roomRegistration = between(current,
  '  const liveConnectionIpc = createDesktopHostedRoomConnection({',
  '  const assertDeveloperAccount = async (', "room_registration");
selected = once(selected, '  const assertDeveloperAccount = async (', roomRegistration +
  '  const assertDeveloperAccount = async (', "room_registration_insertion");
selected = once(selected,
  '    const url = roomServiceNavigationUrl(input, process.env.HELIX_SHARED_LIVE_ROOM_AUTHORITY_ORIGIN);',
  '    const authority = resolveDesktopRoomAuthority(\n' +
  '      process.env.HELIX_SHARED_LIVE_ROOM_AUTHORITY_ORIGIN,\n' +
  '      process.env.HELIX_AGENT_OAUTH_AUDIENCE,\n' +
  '    );\n' +
  '    const url = roomServiceNavigationUrl(input, authority);', "room_authority");
selected = once(selected, '  app.on("before-quit", () => {\n    quitting = true;',
  '  app.on("before-quit", (event) => {\n' +
  '    if (!desktopQuitCoordinator.beforeQuit(event)) return;\n' +
  '    quitting = true;', "quit_hook");

for (const forbidden of ["PrivateEnvironmentLifecycle", "__CASIMIR_PRIVATE_LOCAL_MVP__",
  "solarObservationDialogDestination", "rendererLoadDiagnosticLabel",
  "privateClockMcpPermission", "createLocalGuestTestWindow"]) {
  if (selected.includes(forbidden)) throw Error(`ar2_slice_contains_unrelated:${forbidden}`);
}
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(path.join(path.dirname(output), "main.base.ts"), base);
writeFileSync(output, selected);
process.stdout.write(`ar2_main_slice=${path.relative(root, output)} bytes=${Buffer.byteLength(selected)}\n`);
