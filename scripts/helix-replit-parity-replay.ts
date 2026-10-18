import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

type Target = {
  name: string;
  baseUrl: string;
  headers: Record<string, string>;
};

type FixtureScenario = {
  id: string;
  question: string;
  prior_assistant_answer: string;
  source_ref: string;
  expected: {
    capability_id: string;
    referent_source_kind: string;
    referent_confidence: string;
    semantic_prompt_source: string;
    semantic_prompt_argument_source: string;
    required_exact_badge_ids?: string[];
    required_likely_badge_ids?: string[];
    forbidden_exact_badge_ids?: string[];
    minimum_represented_probability_mass?: number;
    allowed_terminal_artifact_kinds: string[];
  };
};

type Fixture = {
  schema: "helix.replit_parity_fixture.v1";
  scenarios: FixtureScenario[];
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(repoRoot, "scripts", "fixtures", "helix-replit-parity.v1.json");
const timeoutMs = Math.max(5_000, Number(process.env.HELIX_REPLIT_PARITY_TIMEOUT_MS ?? 300_000));
const dryRun = process.argv.includes("--dry-run");
const allowSingle = process.argv.includes("--allow-single");
const captureRaw = process.env.HELIX_REPLIT_PARITY_CAPTURE_RAW === "1";

const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => entry.trim()))].sort()
    : [];

const sha256 = (value: string): string =>
  `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;

const parseHeaders = (): Record<string, Record<string, string>> => {
  const raw = process.env.HELIX_REPLIT_PARITY_HEADERS_JSON?.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(parsed).map(([target, value]) => [
      target,
      Object.fromEntries(
        Object.entries(asRecord(value) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
    ]),
  );
};

const parseTargets = (): Target[] => {
  const cliTargets = process.argv
    .filter((argument) => argument.startsWith("--target="))
    .map((argument) => argument.slice("--target=".length));
  const envTargets = (process.env.HELIX_REPLIT_PARITY_TARGETS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const rawTargets = cliTargets.length > 0 ? cliTargets : envTargets;
  const headers = parseHeaders();
  return rawTargets.map((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error(`Invalid parity target '${entry}'; expected name=https://host`);
    const name = entry.slice(0, separator).trim();
    const baseUrl = entry.slice(separator + 1).trim().replace(/\/+$/, "");
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Unsupported parity target protocol for ${name}: ${url.protocol}`);
    }
    return { name, baseUrl, headers: headers[name] ?? {} };
  });
};

const fetchJson = async (target: Target, pathname: string, init?: RequestInit): Promise<JsonRecord> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${target.baseUrl}${pathname}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...target.headers,
        ...(init?.headers ?? {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${target.name} ${pathname}: HTTP ${response.status}: ${text.slice(0, 1_200)}`);
    }
    const parsed = JSON.parse(text);
    const record = asRecord(parsed);
    if (!record) throw new Error(`${target.name} ${pathname}: response is not a JSON object`);
    return record;
  } finally {
    clearTimeout(timeout);
  }
};

const collectRecords = (value: unknown): JsonRecord[] => {
  const records: JsonRecord[] = [];
  const seen = new Set<unknown>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    const record = candidate as JsonRecord;
    records.push(record);
    Object.values(record).forEach(visit);
  };
  visit(value);
  return records;
};

const firstString = (records: JsonRecord[], keys: string[]): string | null => {
  for (const key of keys) {
    for (const record of records) {
      const value = asString(record[key]);
      if (value) return value;
    }
  }
  return null;
};

const getPath = (value: unknown, pathParts: string[]): unknown => {
  let current: unknown = value;
  for (const part of pathParts) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[part];
  }
  return current;
};

const comparablePaths = [
  "fingerprint.source_identity_sha256",
  "fingerprint.source_commit",
  "fingerprint.source_tree_sha256",
  "fingerprint.theory_graph_sha256",
  "fingerprint.tool_surface_sha256",
  "fingerprint.reasoning_configuration_sha256",
  "fingerprint.reasoning_materials_sha256",
  "fingerprint.account_policy_sha256",
  "fingerprint.experience_contract_sha256",
  "turn.provider_id",
  "turn.model_policy_debug_summary",
  "turn.referent_source_kind",
  "turn.referent_confidence",
  "turn.referent_text_hash",
  "turn.semantic_prompt_source",
  "turn.semantic_prompt_argument_source",
  "turn.semantic_prompt_text_hash",
  "turn.exact_badge_ids",
  "turn.likely_badge_ids",
  "turn.represented_probability_mass",
  "turn.out_of_graph_probability",
  "turn.final_status",
  "turn.final_answer_source",
  "turn.terminal_artifact_kind",
] as const;

const runScenario = async (target: Target, scenario: FixtureScenario, runId: string) => {
  const fingerprint = await fetchJson(target, "/api/agi/runtime-parity/fingerprint");
  const sessionId = `helix-replit-parity:${runId}:${scenario.id}:${target.name}`;
  const ask = await fetchJson(target, "/api/agi/ask/turn", {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      question: scenario.question,
      mode: "read",
      debug: true,
      agent_runtime: "codex",
      workspace_context_snapshot: {
        chat_referent_context: {
          schema: "helix.ask.chat_referent_context.v1",
          previous_assistant_final_answer: {
            role: "assistant",
            source_ref: scenario.source_ref,
            reply_id: `reply:${scenario.id}`,
            text: scenario.prior_assistant_answer,
          },
        },
      },
    }),
  });
  const turnId = asString(ask.turn_id) ?? asString(ask.active_turn_id);
  if (!turnId) throw new Error(`${target.name}/${scenario.id}: Ask response has no turn_id`);
  const debugEnvelope = await fetchJson(
    target,
    `/api/agi/ask/turn/${encodeURIComponent(turnId)}/debug-export?sessionId=${encodeURIComponent(sessionId)}`,
  );
  const debug = asRecord(debugEnvelope.payload) ?? debugEnvelope;
  const records = collectRecords({ ask, debug });
  const referent = records.find((record) => record.schema === "helix.ask.conversational_referent_resolution.v1") ?? null;
  const capabilityResult = records.find((record) =>
    (record.capability === scenario.expected.capability_id || record.capability_id === scenario.expected.capability_id) &&
    asRecord(record.observation)?.schema === "helix.theory_context_reflection_observation.v1",
  ) ?? null;
  const observation = asRecord(capabilityResult?.observation) ??
    records.find((record) => record.schema === "helix.theory_context_reflection_observation.v1") ??
    null;
  if (!referent) throw new Error(`${target.name}/${scenario.id}: conversational referent trace is missing`);
  if (!capabilityResult || !observation) {
    throw new Error(`${target.name}/${scenario.id}: Theory Badge Graph capability observation is missing`);
  }

  const referentSourceKind = asString(referent.source_kind);
  const referentConfidence = asString(referent.resolution_confidence);
  const semanticPromptSource = asString(capabilityResult.semantic_prompt_source);
  const semanticPromptArgumentSource = asString(capabilityResult.semantic_prompt_argument_source);
  if (referentSourceKind !== scenario.expected.referent_source_kind) {
    throw new Error(
      `${target.name}/${scenario.id}: referent source '${referentSourceKind ?? "missing"}' does not match '${scenario.expected.referent_source_kind}'`,
    );
  }
  if (referentConfidence !== scenario.expected.referent_confidence) {
    throw new Error(
      `${target.name}/${scenario.id}: referent confidence '${referentConfidence ?? "missing"}' does not match '${scenario.expected.referent_confidence}'`,
    );
  }
  if (semanticPromptSource !== scenario.expected.semantic_prompt_source) {
    throw new Error(
      `${target.name}/${scenario.id}: semantic prompt source '${semanticPromptSource ?? "missing"}' does not match '${scenario.expected.semantic_prompt_source}'`,
    );
  }
  if (semanticPromptArgumentSource !== scenario.expected.semantic_prompt_argument_source) {
    throw new Error(
      `${target.name}/${scenario.id}: semantic argument source '${semanticPromptArgumentSource ?? "missing"}' does not match '${scenario.expected.semantic_prompt_argument_source}'`,
    );
  }

  const exactBadgeIds = stringArray(observation.exact_badge_ids);
  const likelyBadgeIds = stringArray(observation.likely_badge_ids);
  const uncertainty = asRecord(observation.open_world_uncertainty);
  const representedProbabilityMass =
    typeof uncertainty?.representedProbabilityMass === "number"
      ? uncertainty.representedProbabilityMass
      : null;
  for (const badgeId of scenario.expected.required_exact_badge_ids ?? []) {
    if (!exactBadgeIds.includes(badgeId)) {
      throw new Error(`${target.name}/${scenario.id}: required exact badge is missing: ${badgeId}`);
    }
  }
  for (const badgeId of scenario.expected.required_likely_badge_ids ?? []) {
    if (!likelyBadgeIds.includes(badgeId)) {
      throw new Error(`${target.name}/${scenario.id}: required likely badge is missing: ${badgeId}`);
    }
  }
  for (const badgeId of scenario.expected.forbidden_exact_badge_ids ?? []) {
    if (exactBadgeIds.includes(badgeId)) {
      throw new Error(`${target.name}/${scenario.id}: contextual badge was incorrectly promoted to exact: ${badgeId}`);
    }
  }
  if (
    scenario.expected.minimum_represented_probability_mass !== undefined &&
    (representedProbabilityMass === null ||
      representedProbabilityMass < scenario.expected.minimum_represented_probability_mass)
  ) {
    throw new Error(`${target.name}/${scenario.id}: represented probability mass is below the fixture minimum`);
  }
  const terminalArtifactKind = firstString(records, ["terminal_artifact_kind", "selected_terminal_artifact_kind"]);
  if (!terminalArtifactKind || !scenario.expected.allowed_terminal_artifact_kinds.includes(terminalArtifactKind)) {
    throw new Error(
      `${target.name}/${scenario.id}: terminal artifact '${terminalArtifactKind ?? "missing"}' is outside the fixture contract`,
    );
  }
  const runtimeWorktree = asRecord(getPath(fingerprint, ["build", "runtime_worktree"]));
  if (runtimeWorktree?.dirty === true) {
    throw new Error(`${target.name}: runtime source checkout is dirty; parity cannot be certified`);
  }
  const finalAnswer = firstString(records, ["selected_final_answer", "final_answer", "answer", "text"]);
  const providerId = firstString(records, [
    "selected_agent_provider",
    "selected_runtime_agent_provider",
    "agent_provider_id",
    "provider_id",
    "agent_runtime",
  ]);
  if (providerId !== "codex") {
    throw new Error(`${target.name}/${scenario.id}: expected Codex provider, received '${providerId ?? "missing"}'`);
  }
  const modelPolicyDebugSummary = firstString(records, ["model_policy_debug_summary"]);
  if (!modelPolicyDebugSummary) {
    throw new Error(`${target.name}/${scenario.id}: resolved model/reasoning policy is missing`);
  }
  return {
    target: target.name,
    base_url: target.baseUrl,
    scenario_id: scenario.id,
    fingerprint: {
      execution_mode: getPath(fingerprint, ["build", "execution_mode"]) ?? null,
      source_commit: getPath(fingerprint, ["build", "source_commit"]) ?? null,
      source_tree_sha256: getPath(fingerprint, ["build", "source_tree_sha256"]) ?? null,
      artifact_contract_sha256: getPath(fingerprint, ["build", "artifact_contract_sha256"]) ?? null,
      client_tree_sha256: getPath(fingerprint, ["build", "client_tree_sha256"]) ?? null,
      source_identity_sha256: getPath(fingerprint, ["source_identity", "source_identity_sha256"]) ?? null,
      theory_graph_sha256: getPath(fingerprint, ["theory_graph", "graph_sha256"]) ?? null,
      tool_surface_sha256: getPath(fingerprint, ["tool_surface", "tool_surface_sha256"]) ?? null,
      reasoning_configuration_sha256:
        getPath(fingerprint, ["runtime_configuration", "reasoning_configuration_sha256"]) ?? null,
      hosting_configuration_sha256:
        getPath(fingerprint, ["runtime_configuration", "hosting_configuration_sha256"]) ?? null,
      reasoning_materials_sha256:
        getPath(fingerprint, ["reasoning_materials", "reasoning_materials_sha256"]) ?? null,
      account_policy_sha256: getPath(fingerprint, ["account_policy", "policy_sha256"]) ?? null,
      account_type: getPath(fingerprint, ["account_policy", "account_type"]) ?? null,
      experience_contract_sha256: fingerprint.experience_contract_sha256 ?? null,
      deployment_contract_sha256: fingerprint.deployment_contract_sha256 ?? null,
    },
    turn: {
      turn_id: turnId,
      provider_id: providerId,
      model_policy_debug_summary: modelPolicyDebugSummary,
      referent_source_kind: referentSourceKind,
      referent_confidence: referentConfidence,
      referent_text_hash: referent.resolved_text_hash ?? null,
      semantic_prompt_source: semanticPromptSource,
      semantic_prompt_argument_source: semanticPromptArgumentSource,
      semantic_prompt_text_hash: capabilityResult.semantic_prompt_text_hash ?? null,
      exact_badge_ids: exactBadgeIds,
      likely_badge_ids: likelyBadgeIds,
      represented_probability_mass: representedProbabilityMass,
      out_of_graph_probability: uncertainty?.outOfGraphProbability ?? null,
      final_status: firstString(records, ["final_status", "status"]),
      final_answer_source: firstString(records, ["final_answer_source"]),
      terminal_artifact_kind: terminalArtifactKind,
      final_answer_sha256: finalAnswer ? sha256(finalAnswer) : null,
      final_answer_compared: false,
    },
    ...(captureRaw ? { raw: { ask, debug: debugEnvelope } } : {}),
  };
};

const compareResults = (results: Awaited<ReturnType<typeof runScenario>>[]) => {
  const mismatches: Array<{ scenario_id: string; field: string; values: Record<string, unknown> }> = [];
  const byScenario = new Map<string, typeof results>();
  for (const result of results) {
    const group = byScenario.get(result.scenario_id) ?? [];
    group.push(result);
    byScenario.set(result.scenario_id, group);
  }
  for (const [scenarioId, group] of byScenario) {
    for (const field of comparablePaths) {
      const values = Object.fromEntries(group.map((result) => [result.target, getPath(result, field.split(".")) ?? null]));
      const distinct = new Set(Object.values(values).map((value) => JSON.stringify(value)));
      if (distinct.size > 1) mismatches.push({ scenario_id: scenarioId, field, values });
    }
  }
  return mismatches;
};

const main = async () => {
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as Fixture;
  const targets = parseTargets();
  if (targets.length === 0) {
    throw new Error(
      "No targets supplied. Set HELIX_REPLIT_PARITY_TARGETS='local=http://127.0.0.1:5050,replit=https://example.replit.app'.",
    );
  }
  if (!dryRun && targets.length < 2 && !allowSingle) {
    throw new Error("Cross-environment parity requires at least two targets (or --allow-single for diagnostics). ");
  }
  if (dryRun) {
    console.log(JSON.stringify({
      schema: fixture.schema,
      dry_run: true,
      targets: targets.map(({ name, baseUrl, headers }) => ({
        name,
        base_url: baseUrl,
        headers_configured: Object.keys(headers).length > 0,
      })),
      scenarios: fixture.scenarios.map((scenario) => scenario.id),
    }, null, 2));
    return;
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const results = [];
  for (const target of targets) {
    for (const scenario of fixture.scenarios) {
      results.push(await runScenario(target, scenario, runId));
    }
  }
  const mismatches = compareResults(results);
  const summary = {
    schema: "helix.replit_parity_replay.v1",
    run_id: runId,
    ok: mismatches.length === 0,
    comparison_policy: {
      compared_fields: comparablePaths,
      final_answer_prose_compared: false,
      hosting_configuration_compared: false,
    },
    targets: targets.map(({ name, baseUrl }) => ({ name, base_url: baseUrl })),
    results,
    mismatches,
  };
  const outputDirectory = path.resolve(
    repoRoot,
    process.env.HELIX_REPLIT_PARITY_OUT ?? "artifacts/helix-replit-parity",
    runId,
  );
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(path.join(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...summary, results: results.map((result) => ({ target: result.target, scenario_id: result.scenario_id, fingerprint: result.fingerprint, turn: result.turn })) }, null, 2));
  if (!summary.ok) process.exitCode = 1;
};

main().catch((error) => {
  console.error(`[replit] parity replay failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
