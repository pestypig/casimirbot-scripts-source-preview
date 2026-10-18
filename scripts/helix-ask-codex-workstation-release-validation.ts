import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Verdict = "PASS" | "WARN" | "FAIL" | "BLOCKED";

type Scenario = {
  id: string;
  category: "single" | "compound" | "negative" | "provider_optional";
  prompt: string;
  expectedCapabilities: string[];
  forbiddenCapabilities?: string[];
  optionalCapabilities?: string[];
  allowProviderMissing?: boolean;
};

type ScenarioResult = {
  schema: "helix.codex_workstation_release_validation_scenario.v1";
  id: string;
  category: Scenario["category"];
  verdict: Verdict;
  failures: string[];
  warnings: string[];
  turn_id: string | null;
  final_status: string | null;
  final_answer_source: string | null;
  terminal_artifact_kind: string | null;
  gateway_capabilities: string[];
  successful_capabilities: string[];
  missing_expected_capabilities: string[];
  unexpected_capabilities: string[];
  provider_missing_capabilities: string[];
  response_file: string;
  debug_file: string | null;
};

const BASE_URL = (process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:1498").replace(/\/+$/, "");
const OUT_DIR =
  process.env.HELIX_ASK_CODEX_WORKSTATION_RELEASE_OUT ??
  "artifacts/helix-ask-codex-workstation-release-validation";
const TIMEOUT_MS = Math.max(1000, Number(process.env.HELIX_ASK_CODEX_WORKSTATION_RELEASE_TIMEOUT_MS ?? 300_000));
const DRY_RUN =
  process.argv.includes("--dry-run") ||
  process.env.HELIX_ASK_CODEX_WORKSTATION_RELEASE_DRY_RUN === "1";
const SCENARIO_FILTER = (process.env.HELIX_ASK_CODEX_WORKSTATION_RELEASE_SCENARIOS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

const workspaceSnapshot = {
  activePanel: "scientific-calculator",
  focusedPanel: "scientific-calculator",
  openPanels: ["docs-viewer", "scientific-calculator"],
  activeDocPath: "docs/research/nhm2-current-status-whitepaper.md",
  hasDocContext: true,
};

export const CODEX_WORKSTATION_RELEASE_SCENARIOS: Scenario[] = [
  {
    id: "single_workspace_status",
    category: "single",
    prompt: "Use workspace_os.status to inspect workstation status. Answer only from that observation.",
    expectedCapabilities: ["workspace_os.status"],
  },
  {
    id: "single_calculator",
    category: "single",
    prompt: "Use scientific-calculator.solve_expression with expression 8*9. Answer with the observed expression and result.",
    expectedCapabilities: ["scientific-calculator.solve_expression"],
  },
  {
    id: "single_docs",
    category: "single",
    prompt:
      "Use docs.search for docs/research/nhm2-current-status-whitepaper.md with query claim boundary. Answer from the bounded document observation.",
    expectedCapabilities: ["docs.search"],
  },
  {
    id: "single_repo",
    category: "single",
    prompt: "Use repo.search for workstation_gateway. Answer from bounded repo evidence only.",
    expectedCapabilities: ["repo.search"],
  },
  {
    id: "single_theory",
    category: "single",
    prompt:
      "Use theory-badge-graph.reflect_discussion_context for NHM2 claim boundary. Answer with diagnostic claim boundaries only.",
    expectedCapabilities: ["theory-badge-graph.reflect_discussion_context"],
  },
  {
    id: "single_civilization",
    category: "single",
    prompt:
      "Use civilization-bounds.reflect_system_bounds for NHM2 Casimir tile generation constraints. Answer with diagnostic social, energy, and material bounds.",
    expectedCapabilities: ["civilization-bounds.reflect_system_bounds"],
  },
  {
    id: "single_scholarly",
    category: "provider_optional",
    prompt:
      "Use scholarly-research.lookup_papers for quantum inequality sampling and warp constraints. Answer only from the scholarly observation or say what is missing.",
    expectedCapabilities: ["scholarly-research.lookup_papers"],
    allowProviderMissing: true,
  },
  {
    id: "single_internet",
    category: "provider_optional",
    prompt:
      "Use internet-search.search_web for current public evidence about OpenAI Codex workstation-style tool use. Answer only from the internet observation or say what is missing.",
    expectedCapabilities: ["internet-search.search_web"],
    allowProviderMissing: true,
  },
  {
    id: "compound_docs_calculator_theory",
    category: "compound",
    prompt:
      "Codex workstation release validation: use docs.search for docs/research/nhm2-current-status-whitepaper.md with query claim boundary; scientific-calculator.solve_expression with expression 8*9; theory-badge-graph.reflect_discussion_context for NHM2 claim boundary. Answer what those observations support and what remains unproven.",
    expectedCapabilities: [
      "docs.search",
      "scientific-calculator.solve_expression",
      "theory-badge-graph.reflect_discussion_context",
    ],
    forbiddenCapabilities: ["internet-search.search_web"],
  },
  {
    id: "compound_docs_repo",
    category: "compound",
    prompt:
      "Use docs.search for docs/research/nhm2-current-status-whitepaper.md with query claim boundary, then use repo.search for workstation_gateway. Distinguish document evidence from implementation evidence.",
    expectedCapabilities: ["docs.search", "repo.search"],
  },
  {
    id: "compound_docs_scholarly",
    category: "provider_optional",
    prompt:
      "Use docs.search for docs/research/nhm2-current-status-whitepaper.md with query quantum inequality, then use scholarly-research.lookup_papers for quantum inequality warp constraints. Distinguish local document claims from paper corroboration.",
    expectedCapabilities: ["docs.search", "scholarly-research.lookup_papers"],
    allowProviderMissing: true,
  },
  {
    id: "compound_theory_civilization",
    category: "compound",
    prompt:
      "Use theory-badge-graph.reflect_discussion_context for NHM2 claim boundary, then use civilization-bounds.reflect_system_bounds for social energy material constraints. Explain the combined boundary without overclaiming.",
    expectedCapabilities: [
      "theory-badge-graph.reflect_discussion_context",
      "civilization-bounds.reflect_system_bounds",
    ],
  },
  {
    id: "compound_calculator_scholarly_internet",
    category: "provider_optional",
    prompt:
      "Use scholarly-research.lookup_papers for quantum noise equations, internet-search.search_web for current public corroboration, and scientific-calculator.solve_expression with expression 8*9. Explain that arithmetic does not prove source claims.",
    expectedCapabilities: [
      "scholarly-research.lookup_papers",
      "internet-search.search_web",
      "scientific-calculator.solve_expression",
    ],
    allowProviderMissing: true,
  },
  {
    id: "compound_broad_no_internet",
    category: "compound",
    prompt:
      "Use docs.search for docs/research/nhm2-current-status-whitepaper.md with query claim boundary; scientific-calculator.solve_expression with expression 8*9; theory-badge-graph.reflect_discussion_context for NHM2 claim boundary; civilization-bounds.reflect_system_bounds for NHM2 engineering constraints; scholarly-research.lookup_papers for quantum inequality warp constraints; and repo.search for workstation_gateway. Do not use internet-search.search_web. Give a grounded release-confidence answer.",
    expectedCapabilities: [
      "docs.search",
      "scientific-calculator.solve_expression",
      "theory-badge-graph.reflect_discussion_context",
      "civilization-bounds.reflect_system_bounds",
      "scholarly-research.lookup_papers",
      "repo.search",
    ],
    optionalCapabilities: ["scholarly-research.lookup_papers"],
    forbiddenCapabilities: ["internet-search.search_web"],
    allowProviderMissing: true,
  },
  {
    id: "negative_no_internet_current_doc",
    category: "negative",
    prompt:
      "Do not search the internet; use the current document evidence and explain what remains unproven about the claim boundary.",
    expectedCapabilities: ["docs.search"],
    forbiddenCapabilities: ["internet-search.search_web"],
  },
  {
    id: "negative_quoted_internet",
    category: "negative",
    prompt:
      "The text says `internet-search.search_web`; explain that phrase as text only. Do not run internet search.",
    expectedCapabilities: [],
    forbiddenCapabilities: ["internet-search.search_web"],
  },
  {
    id: "negative_future_docs",
    category: "negative",
    prompt: "Before we use docs.search later, explain what a docs observation would prove. Do not run docs.search now.",
    expectedCapabilities: [],
    forbiddenCapabilities: ["docs.search"],
  },
  {
    id: "negative_calculator_concept",
    category: "negative",
    prompt: "What would a calculator observation prove in a future Codex workstation turn? Do not run the calculator.",
    expectedCapabilities: [],
    forbiddenCapabilities: ["scientific-calculator.solve_expression"],
  },
];

const readRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const readArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const writeJson = async (filePath: string, value: unknown) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const selectScenarios = (): { scenarios: Scenario[]; unknownIds: string[] } => {
  if (SCENARIO_FILTER.length === 0) return { scenarios: CODEX_WORKSTATION_RELEASE_SCENARIOS, unknownIds: [] };
  const available = new Set(CODEX_WORKSTATION_RELEASE_SCENARIOS.map((scenario) => scenario.id));
  return {
    scenarios: CODEX_WORKSTATION_RELEASE_SCENARIOS.filter((scenario) => SCENARIO_FILTER.includes(scenario.id)),
    unknownIds: SCENARIO_FILTER.filter((id) => !available.has(id)),
  };
};

const fetchJson = async (url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: unknown; text: string }> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text.trim() ? JSON.parse(text) : null;
    } catch {
      json = { raw_text: text.slice(0, 4000) };
    }
    return { ok: response.ok, status: response.status, json, text };
  } finally {
    clearTimeout(timeout);
  }
};

const payloadFromDebugExport = (debugExport: unknown): Record<string, unknown> | null => {
  const record = readRecord(debugExport);
  return readRecord(record?.payload) ?? record;
};

const extractGatewayCalls = (payload: Record<string, unknown> | null): Record<string, unknown>[] =>
  readArray(payload?.workstation_gateway_call_results)
    .map(readRecord)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));

const isProviderMissing = (call: Record<string, unknown>): boolean => {
  const text = JSON.stringify(call).toLowerCase();
  return /provider|config|api[_ -]?key|tavily|missing|unavailable|not_configured|not configured/.test(text) && call.ok !== true;
};

const evaluateScenario = (input: {
  scenario: Scenario;
  responseFile: string;
  debugFile: string | null;
  response: Record<string, unknown> | null;
  debugPayload: Record<string, unknown> | null;
}): ScenarioResult => {
  const calls = extractGatewayCalls(input.debugPayload);
  const gatewayCapabilities = calls.map((call) => readString(call.capability_id) ?? readString(call.capabilityId) ?? "unknown");
  const successfulCapabilities = calls
    .filter((call) => call.ok === true && readString(readRecord(call.observation_packet)?.status) !== "blocked")
    .map((call) => readString(call.capability_id) ?? readString(call.capabilityId) ?? "unknown");
  const optional = new Set(input.scenario.optionalCapabilities ?? []);
  const missingExpectedCapabilities = input.scenario.expectedCapabilities.filter(
    (capability) => !successfulCapabilities.includes(capability) && !optional.has(capability),
  );
  const providerMissingCapabilities = calls
    .filter(isProviderMissing)
    .map((call) => readString(call.capability_id) ?? readString(call.capabilityId) ?? "unknown");
  const allowedProviderMissing = new Set(
    input.scenario.allowProviderMissing
      ? providerMissingCapabilities
      : providerMissingCapabilities.filter((capability) => optional.has(capability)),
  );
  const missingExpectedFailures = missingExpectedCapabilities.filter(
    (capability) => !allowedProviderMissing.has(capability),
  );
  const unexpectedCapabilities = gatewayCapabilities.filter((capability) =>
    (input.scenario.forbiddenCapabilities ?? []).includes(capability),
  );
  const failures: string[] = [];
  const warnings: string[] = [];
  if (!input.response) failures.push("response_missing");
  if (!input.debugPayload) failures.push("debug_export_missing");
  if (missingExpectedFailures.length > 0) {
    failures.push(`missing_expected_capabilities:${missingExpectedFailures.join(",")}`);
  }
  if (unexpectedCapabilities.length > 0) {
    failures.push(`unexpected_capabilities:${unexpectedCapabilities.join(",")}`);
  }
  if (providerMissingCapabilities.length > 0) {
    const allowedMissing = input.scenario.allowProviderMissing || providerMissingCapabilities.every((capability) => optional.has(capability));
    if (allowedMissing) warnings.push(`provider_missing:${providerMissingCapabilities.join(",")}`);
    else failures.push(`provider_missing:${providerMissingCapabilities.join(",")}`);
  }
  const terminalArtifactKind =
    readString(input.debugPayload?.terminal_artifact_kind) ??
    readString(readRecord(input.debugPayload?.debug)?.terminal_artifact_kind);
  const finalAnswerSource =
    readString(input.debugPayload?.final_answer_source) ??
    readString(readRecord(input.debugPayload?.debug)?.final_answer_source);
  const finalStatus =
    readString(input.debugPayload?.final_status) ??
    readString(input.response?.status) ??
    readString(input.response?.response_type);
  if (
    input.scenario.expectedCapabilities.length > 0 &&
    !readString(input.debugPayload?.selected_final_answer) &&
    !readString(input.response?.final_answer) &&
    !readString(input.response?.answer)
  ) {
    failures.push("final_answer_missing");
  }
  const verdict: Verdict = failures.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS";
  return {
    schema: "helix.codex_workstation_release_validation_scenario.v1",
    id: input.scenario.id,
    category: input.scenario.category,
    verdict,
    failures,
    warnings,
    turn_id:
      readString(input.debugPayload?.active_turn_id) ??
      readString(input.response?.turn_id) ??
      readString(input.response?.id),
    final_status: finalStatus,
    final_answer_source: finalAnswerSource,
    terminal_artifact_kind: terminalArtifactKind,
    gateway_capabilities: gatewayCapabilities,
    successful_capabilities: successfulCapabilities,
    missing_expected_capabilities: missingExpectedCapabilities,
    unexpected_capabilities: unexpectedCapabilities,
    provider_missing_capabilities: providerMissingCapabilities,
    response_file: input.responseFile,
    debug_file: input.debugFile,
  };
};

const preflight = async (): Promise<{ ok: boolean; reason: string | null }> => {
  try {
    const response = await fetch(`${BASE_URL}/desktop`, { method: "GET" });
    return { ok: response.ok, reason: response.ok ? null : `desktop_status_${response.status}` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
};

const runScenario = async (scenario: Scenario): Promise<ScenarioResult> => {
  const scenarioDir = path.join(OUT_DIR, scenario.id);
  await fs.mkdir(scenarioDir, { recursive: true });
  const seedFile = path.join(scenarioDir, "seed.json");
  const responseFile = path.join(scenarioDir, "ask-response.json");
  const debugFile = path.join(scenarioDir, "debug-export.json");
  await writeJson(seedFile, { scenario, base_url: BASE_URL, workspace_context_snapshot: workspaceSnapshot });
  const responseResult = await fetchJson(`${BASE_URL}/api/agi/ask/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      question: scenario.prompt,
      prompt: scenario.prompt,
      agent_runtime: "codex",
      agentRuntime: "codex",
      workspace_context_snapshot: workspaceSnapshot,
      debug: true,
    }),
  });
  await writeJson(responseFile, responseResult.json);
  const responseRecord = readRecord(responseResult.json);
  const turnId = readString(responseRecord?.turn_id) ?? readString(responseRecord?.id);
  let debugPayload: Record<string, unknown> | null = null;
  let debugPath: string | null = null;
  if (turnId) {
    const debugResult = await fetchJson(`${BASE_URL}/api/agi/ask/turn/${encodeURIComponent(turnId)}/debug-export`);
    await writeJson(debugFile, debugResult.json);
    debugPayload = payloadFromDebugExport(debugResult.json);
    debugPath = debugFile;
  }
  const result = evaluateScenario({
    scenario,
    responseFile,
    debugFile: debugPath,
    response: responseRecord,
    debugPayload,
  });
  await writeJson(path.join(scenarioDir, "probe-result.json"), result);
  return result;
};

const writeSummary = async (summary: unknown) => {
  await writeJson(path.join(OUT_DIR, "summary.json"), summary);
  const record = readRecord(summary);
  const scenarios = readArray(record?.scenarios).map(readRecord).filter(Boolean);
  const lines = [
    "# Codex Workstation Release Validation",
    "",
    `Status: ${readString(record?.status) ?? "unknown"}`,
    `Base URL: ${BASE_URL}`,
    `Scenario count: ${scenarios.length}`,
    "",
    "| Scenario | Verdict | Gateway capabilities | Failures | Warnings |",
    "| --- | --- | --- | --- | --- |",
    ...scenarios.map((scenario) => {
      const caps = readArray(scenario?.gateway_capabilities).join(", ");
      const failures = readArray(scenario?.failures).join("; ");
      const warnings = readArray(scenario?.warnings).join("; ");
      return `| ${readString(scenario?.id) ?? "unknown"} | ${readString(scenario?.verdict) ?? "unknown"} | ${caps || "-"} | ${failures || "-"} | ${warnings || "-"} |`;
    }),
    "",
  ];
  await fs.writeFile(path.join(OUT_DIR, "summary.md"), `${lines.join("\n")}\n`, "utf8");
};

export const main = async () => {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const selection = selectScenarios();
  if (DRY_RUN) {
    await writeSummary({
      schema: "helix.codex_workstation_release_validation_summary.v1",
      status: "dry_run",
      base_url: BASE_URL,
      output_dir: OUT_DIR,
      unknown_scenario_ids: selection.unknownIds,
      scenarios: selection.scenarios.map((scenario) => ({
        id: scenario.id,
        category: scenario.category,
        prompt: scenario.prompt,
        expected_capabilities: scenario.expectedCapabilities,
        forbidden_capabilities: scenario.forbiddenCapabilities ?? [],
      })),
    });
    return;
  }
  const preflightResult = await preflight();
  if (!preflightResult.ok) {
    await writeSummary({
      schema: "helix.codex_workstation_release_validation_summary.v1",
      status: "blocked",
      blocked_reason: "keyed_server_unreachable",
      blocked_detail: preflightResult.reason,
      base_url: BASE_URL,
      output_dir: OUT_DIR,
      unknown_scenario_ids: selection.unknownIds,
      scenarios: selection.scenarios.map((scenario) => ({
        schema: "helix.codex_workstation_release_validation_scenario.v1",
        id: scenario.id,
        category: scenario.category,
        verdict: "BLOCKED",
        failures: ["keyed_server_unreachable"],
        warnings: [],
        gateway_capabilities: [],
      })),
    });
    return;
  }
  const results: ScenarioResult[] = [];
  for (const scenario of selection.scenarios) {
    results.push(await runScenario(scenario));
  }
  const failCount = results.filter((result) => result.verdict === "FAIL").length;
  const warnCount = results.filter((result) => result.verdict === "WARN").length;
  await writeSummary({
    schema: "helix.codex_workstation_release_validation_summary.v1",
    status: failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "pass",
    base_url: BASE_URL,
    output_dir: OUT_DIR,
    unknown_scenario_ids: selection.unknownIds,
    scenario_count: results.length,
    pass_count: results.filter((result) => result.verdict === "PASS").length,
    warn_count: warnCount,
    fail_count: failCount,
    scenarios: results,
  });
  if (failCount > 0 || selection.unknownIds.length > 0) {
    process.exitCode = 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
