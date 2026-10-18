import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HELIX_ASK_MORAL_GRAPH_REFLECTION_TOOL_NAME } from "../server/skills/helix-ask.moral-graph-reflection";
import { createMoralGraphReflectionMcpHarnessServer } from "../server/mcp/testing/moral-graph-reflection-mcp-harness";

const defaultScenario = [
  "An outsider rises because inherited rank is poorly aligned with demonstrated competence.",
  "His earned expertise deserves authority within its domain but not exclusive sovereignty.",
  "A princess inherits legitimacy and dynastic knowledge while being politically valued and personally restricted.",
  "The protected person needs agency over the future allegedly protected for her.",
  "Shared leadership distributes knowledge, supports contestation and succession, and refuses to make people material for one objective.",
  "Love permits independent purpose and does not automatically convert dissent, departure, or separation into betrayal.",
].join(" ");

const server = createMoralGraphReflectionMcpHarnessServer();
const client = new Client({ name: "casimirbot-moral-graph-harness-cli", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({
    name: HELIX_ASK_MORAL_GRAPH_REFLECTION_TOOL_NAME,
    arguments: {
      inputKind: "user_prompt",
      text: process.env.MORAL_GRAPH_MCP_HARNESS_TEXT?.trim() || defaultScenario,
      options: {
        includeLocator: false,
        includeSharedAuthoritySocialRenewal: true,
        includeMediationPacket: true,
        includeProceduralClassification: true,
      },
    },
  });
  if (result.isError) throw new Error("Moral Graph MCP harness returned an error result");
  const structuredContent = result.structuredContent as Record<string, unknown> | undefined;
  process.stdout.write(`${JSON.stringify({
    proceduralClassification: structuredContent?.proceduralClassification,
    sharedAuthoritySocialRenewal: structuredContent?.sharedAuthoritySocialRenewal,
    moralReflectionMediation: structuredContent?.moralReflectionMediation,
  }, null, 2)}\n`);
} finally {
  await client.close();
  await server.close();
}
