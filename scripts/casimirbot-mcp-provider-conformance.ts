import { runCasimirbotMcpProviderConformance } from "./lib/casimirbot-mcp-provider-conformance";

const report = await runCasimirbotMcpProviderConformance();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status === "fail") process.exitCode = 1;
