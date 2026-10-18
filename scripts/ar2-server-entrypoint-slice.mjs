/** Select only room-interpreter MCP mounts from a mixed server entry point. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relative = "server/index.ts";
const base = execFileSync("git", ["show", `HEAD:${relative}`],
  { cwd: root, encoding: "utf8" }).replace(/\r\n/g, "\n");
const current = readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");
const once = (source, from, to, label) => {
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + from.length) >= 0)
    throw Error(`ar2_server_entrypoint_anchor_missing_or_ambiguous:${label}`);
  return source.slice(0, first) + to + source.slice(first + from.length);
};
const importBlock = 'import { createRoomInterpreterMcpRouter, createRoomInterpreterMcpLeaseRouter,\n' +
  '  ROOM_INTERPRETER_MCP_PATH } from "./routes/room-interpreter-mcp";\n';
const mcpMount = 'app.use(ROOM_INTERPRETER_MCP_PATH, createRoomInterpreterMcpRouter());\n';
const leaseMount = 'app.use("/api/agi", createRoomInterpreterMcpLeaseRouter());\n';
for (const [name, value] of [["import", importBlock], ["mcp", mcpMount], ["lease", leaseMount]])
  if (!current.includes(value)) throw Error(`ar2_server_entrypoint_missing:${name}`);
let selected = once(base, 'import { createHelixMcpRouter } from "./routes/helix-mcp";\n',
  'import { createHelixMcpRouter } from "./routes/helix-mcp";\n' + importBlock,
  "room_mcp_import");
selected = once(selected, 'app.use("/mcp", createHelixMcpRouter({',
  mcpMount + 'app.use("/mcp", createHelixMcpRouter({', "room_mcp_mount");
selected = once(selected, 'app.use(publicRoomSourceIngressParserErrorHandler);\n',
  'app.use(publicRoomSourceIngressParserErrorHandler);\n' + leaseMount,
  "lease_mount");
for (const forbidden of ["createPrivateClockBrokerClient", "SOLAR_RESEARCH_READ_SCOPE",
  "createLocalHostedAccountRouter", "createHostedReferenceCanvasRouter"])
  if (selected.includes(forbidden)) throw Error(`ar2_server_entrypoint_contains_unrelated:${forbidden}`);
const output = path.join(root, "artifacts/ar2-source-selection/server-index.ts");
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, selected);
process.stdout.write(`ar2_server_entrypoint_slice=${path.relative(root, output)}\n`);
