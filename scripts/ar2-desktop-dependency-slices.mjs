/** Select only room-authority and live-connection additions from mixed files. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(root, "artifacts/ar2-source-selection");
const once = (source, from, to, label) => {
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + from.length) >= 0)
    throw Error(`ar2_dependency_anchor_missing_or_ambiguous:${label}`);
  return source.slice(0, first) + to + source.slice(first + from.length);
};
const read = relative => ({
  base: execFileSync("git", ["show", `HEAD:${relative}`], { cwd: root, encoding: "utf8" })
    .replace(/\r\n/g, "\n"),
  current: readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n"),
});
const save = (name, content) => {
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(path.join(outputRoot, name), content);
  process.stdout.write(`ar2_dependency_slice=${name} bytes=${Buffer.byteLength(content)}\n`);
};

{
  const { base, current } = read("apps/desktop/src/channels.ts");
  const line = 'export const DESKTOP_LIVE_CONNECTION_CHANNEL = "casimir-desktop:live-connection";\n';
  if (!current.includes(line)) throw Error("ar2_dependency_missing:live_connection_channel");
  save("channels.ts", once(base,
    'export const DESKTOP_ROOM_SERVICE_OPEN_CHANNEL =',
    line + 'export const DESKTOP_ROOM_SERVICE_OPEN_CHANNEL =', "channel"));
}
{
  const { base, current } = read("apps/desktop/src/preload.ts");
  const importLine = "  DESKTOP_LIVE_CONNECTION_CHANNEL,\n";
  const bridgeLine = "  liveConnection: (request: unknown) => ipcRenderer.invoke(DESKTOP_LIVE_CONNECTION_CHANNEL, request),\n";
  if (!current.includes(importLine) || !current.includes(bridgeLine))
    throw Error("ar2_dependency_missing:preload_bridge");
  let selected = once(base, "  DESKTOP_SOLAR_OBSERVATION_SAVE_CHANNEL,\n",
    importLine + "  DESKTOP_SOLAR_OBSERVATION_SAVE_CHANNEL,\n", "preload_import");
  selected = once(selected,
    "  saveSolarObservation: (text: unknown) => ipcRenderer.invoke(DESKTOP_SOLAR_OBSERVATION_SAVE_CHANNEL, text),\n",
    bridgeLine +
    "  saveSolarObservation: (text: unknown) => ipcRenderer.invoke(DESKTOP_SOLAR_OBSERVATION_SAVE_CHANNEL, text),\n",
    "preload_bridge");
  if (selected.includes("installPrivateEnvironmentRevocation"))
    throw Error("ar2_dependency_contains_unrelated:private_revocation");
  save("preload.ts", selected);
}
{
  const { base, current } = read("apps/desktop/src/service-environment.ts");
  const begin = "/** The room service may receive a room OAuth bearer";
  const end = "export const DESKTOP_LOCAL_DATABASE_RELATIVE_PATH";
  const start = current.indexOf(begin);
  const stop = current.indexOf(end, start);
  if (start < 0 || stop < 0) throw Error("ar2_dependency_missing:room_authority");
  const block = current.slice(start, stop);
  let selected = once(base, end, block + end, "authority_function");
  selected = once(selected,
    '  for (const key of INHERITED_DESKTOP_OAUTH_PUBLIC_KEYS) {\n',
    '  for (const key of INHERITED_DESKTOP_OAUTH_PUBLIC_KEYS) {\n' +
    '    if (key === "HELIX_SHARED_LIVE_ROOM_AUTHORITY_ORIGIN") continue;\n',
    "exclude_raw_authority");
  const validated = '  const roomAuthority = resolveDesktopRoomAuthority(\n' +
    '    input.processEnv.HELIX_SHARED_LIVE_ROOM_AUTHORITY_ORIGIN,\n' +
    '    input.processEnv.HELIX_AGENT_OAUTH_AUDIENCE,\n' +
    '  );\n' +
    '  if (roomAuthority) environment.HELIX_SHARED_LIVE_ROOM_AUTHORITY_ORIGIN = roomAuthority;\n';
  if (!current.includes(validated)) throw Error("ar2_dependency_missing:validated_authority");
  selected = once(selected,
    '  for (const key of INHERITED_DESKTOP_ACCOUNT_POLICY_KEYS) {\n',
    validated + '  for (const key of INHERITED_DESKTOP_ACCOUNT_POLICY_KEYS) {\n',
    "validated_authority");
  for (const forbidden of ["HELIX_PRIVATE_CLOCK_RUNTIME =", "VOICE_LANE_CRASH_BREADCRUMB_DIR ="])
    if (selected.includes(forbidden)) throw Error(`ar2_dependency_contains_unrelated:${forbidden}`);
  save("service-environment.ts", selected);
}
