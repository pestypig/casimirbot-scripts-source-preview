import * as fs from "node:fs";
import * as path from "node:path";

type JsonObject = Record<string, unknown>;

type LaneDebug = {
  llm_route_expected_backend: unknown;
  llm_invoke_attempted: unknown;
  llm_skip_reason: unknown;
  llm_skip_reason_detail: unknown;
  llm_backend_used: unknown;
  llm_provider_called: unknown;
  llm_http_status: unknown;
  llm_model: unknown;
  llm_routed_via: unknown;
  llm_calls: unknown;
  llm_error_code: unknown;
  llm_error_message: unknown;
};

type LaneResult = {
  request: JsonObject;
  status: number;
  payload: unknown;
  debug: LaneDebug;
  classification: "A_short_circuit" | "B_invoked_or_config_fail" | "C_http_success" | "unknown";
};

type ProbeVerdict =
  | "not_attempted"
  | "success"
  | "auth_failure"
  | "transport_failure"
  | "http_failure";

type DirectOpenAiProbe = {
  attempted: boolean;
  keySource: "OPENAI_API_KEY" | "LLM_HTTP_API_KEY" | "none";
  status: number | null;
  verdict: ProbeVerdict;
  error: string | null;
};

type Hypothesis = {
  id: string;
  statement: string;
  expected: string;
  observed: string;
  pass: boolean | null;
  falsified: boolean;
};

const argValue = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
};

const asObject = (value: unknown): JsonObject | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;

const readDebug = (payload: unknown): LaneDebug => {
  const root = asObject(payload);
  const debug = asObject(root?.debug) ?? asObject(asObject(root?.result)?.debug) ?? {};
  return {
    llm_route_expected_backend: debug.llm_route_expected_backend ?? null,
    llm_invoke_attempted: debug.llm_invoke_attempted ?? null,
    llm_skip_reason: debug.llm_skip_reason ?? null,
    llm_skip_reason_detail: debug.llm_skip_reason_detail ?? null,
    llm_backend_used: debug.llm_backend_used ?? null,
    llm_provider_called: debug.llm_provider_called ?? null,
    llm_http_status: debug.llm_http_status ?? null,
    llm_model: debug.llm_model ?? null,
    llm_routed_via: debug.llm_routed_via ?? null,
    llm_calls: debug.llm_calls ?? null,
    llm_error_code: debug.llm_error_code ?? null,
    llm_error_message: debug.llm_error_message ?? null,
  };
};

const classifyLane = (debug: LaneDebug): LaneResult["classification"] => {
  const invoke = debug.llm_invoke_attempted === true;
  const shortCircuit = debug.llm_invoke_attempted === false && typeof debug.llm_skip_reason === "string";
  const callsNonEmpty = Array.isArray(debug.llm_calls) && debug.llm_calls.length > 0;
  const httpSuccess =
    invoke &&
    debug.llm_backend_used === "http" &&
    debug.llm_provider_called === true &&
    debug.llm_http_status === 200 &&
    callsNonEmpty &&
    !debug.llm_error_code;
  if (shortCircuit) return "A_short_circuit";
  if (httpSuccess) return "C_http_success";
  if (invoke) return "B_invoked_or_config_fail";
  return "unknown";
};

const parseAllowHosts = (raw: string | null): string[] =>
  (raw ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const isAuthFailure = (debug: LaneDebug): boolean =>
  debug.llm_error_code === "llm_http_401" ||
  debug.llm_error_code === "llm_http_403" ||
  debug.llm_http_status === 401 ||
  debug.llm_http_status === 403;

const isTransportFailure = (debug: LaneDebug): boolean =>
  typeof debug.llm_error_code === "string" &&
  (debug.llm_error_code.startsWith("llm_http_transport:") || debug.llm_error_code === "llm_http_circuit_open");

const runDirectOpenAiProbe = async (): Promise<DirectOpenAiProbe> => {
  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  const httpKey = process.env.LLM_HTTP_API_KEY?.trim();
  const token = openAiKey || httpKey;
  const keySource: DirectOpenAiProbe["keySource"] = openAiKey
    ? "OPENAI_API_KEY"
    : httpKey
      ? "LLM_HTTP_API_KEY"
      : "none";

  if (!token) {
    return {
      attempted: false,
      keySource,
      status: null,
      verdict: "not_attempted",
      error: "missing_api_key",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    const status = response.status;
    const verdict: ProbeVerdict =
      status === 200 ? "success" : status === 401 || status === 403 ? "auth_failure" : "http_failure";
    return {
      attempted: true,
      keySource,
      status,
      verdict,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      attempted: true,
      keySource,
      status: null,
      verdict: "transport_failure",
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
};

const fetchJson = async (
  url: string,
  init?: RequestInit,
): Promise<{ status: number; payload: unknown; text: string }> => {
  const res = await fetch(url, init);
  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { status: res.status, payload, text };
};

const main = async (): Promise<void> => {
  const baseUrl = (argValue("--base-url") ?? process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:5050").replace(
    /\/$/,
    "",
  );
  const outPath =
    argValue("--out") ??
    process.env.HELIX_ASK_DEBUG_LOOP_OUT ??
    path.join("artifacts", "helix-ask-dot-lane-summary.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const envPreflight = {
    marker: process.env.ENV_MARKER ?? null,
    base: process.env.LLM_HTTP_BASE ?? null,
    baseHttps: (process.env.LLM_HTTP_BASE ?? "").startsWith("https://"),
    hasOpenAI: Boolean(process.env.OPENAI_API_KEY),
    hasHttp: Boolean(process.env.LLM_HTTP_API_KEY),
    keySource: process.env.OPENAI_API_KEY ? "OPENAI_API_KEY" : process.env.LLM_HTTP_API_KEY ? "LLM_HTTP_API_KEY" : "none",
    policy: process.env.LLM_POLICY ?? null,
    runtime: process.env.LLM_RUNTIME ?? null,
    hullMode: process.env.HULL_MODE ?? null,
    allowHostsRaw: process.env.HULL_ALLOW_HOSTS ?? null,
  };
  const allowHostsList = parseAllowHosts(envPreflight.allowHostsRaw);
  const preflightChecks = [
    {
      id: "base_https",
      expected: "LLM_HTTP_BASE=https://api.openai.com",
      observed: String(envPreflight.base),
      pass: envPreflight.base === "https://api.openai.com",
    },
    {
      id: "policy_http",
      expected: "LLM_POLICY=http",
      observed: String(envPreflight.policy),
      pass: envPreflight.policy === "http",
    },
    {
      id: "runtime_http",
      expected: "LLM_RUNTIME=http",
      observed: String(envPreflight.runtime),
      pass: envPreflight.runtime === "http",
    },
    {
      id: "hull_mode_on",
      expected: "HULL_MODE=1",
      observed: String(envPreflight.hullMode),
      pass: envPreflight.hullMode === "1",
    },
    {
      id: "allow_hosts_host_only",
      expected: "HULL_ALLOW_HOSTS contains api.openai.com (no scheme)",
      observed: allowHostsList.join(", "),
      pass: allowHostsList.includes("api.openai.com"),
    },
    {
      id: "key_present",
      expected: "OPENAI_API_KEY or LLM_HTTP_API_KEY set",
      observed: envPreflight.keySource,
      pass: envPreflight.hasOpenAI || envPreflight.hasHttp,
    },
  ];
  const preflightReady = preflightChecks.every((check) => check.pass);

  const hull = await fetchJson(`${baseUrl}/api/hull/status`);
  const hullPayload = asObject(hull.payload);
  const hullHttp = asObject(hullPayload?.llm_http);
  const hullChecks = [
    {
      id: "hull_status_ok",
      expected: "HTTP 200",
      observed: String(hull.status),
      pass: hull.status === 200,
    },
    {
      id: "hull_http_allowed",
      expected: "llm_http.allowed=true",
      observed: JSON.stringify(hullHttp?.allowed ?? null),
      pass: hullHttp?.allowed === true,
    },
  ];
  const hullReady = hullChecks.every((check) => check.pass);
  const envScopeMismatch = !preflightReady && hullReady;

  const directOpenAiProbe = await runDirectOpenAiProbe();

  const laneARequest = {
    question: "What is 2 + 2?",
    debug: true,
    sessionId: "dot-loop-lane-a",
  };
  const laneAResponse = await fetchJson(`${baseUrl}/api/agi/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(laneARequest),
  });
  const laneADebug = readDebug(laneAResponse.payload);
  const laneA: LaneResult = {
    request: laneARequest,
    status: laneAResponse.status,
    payload: laneAResponse.payload,
    debug: laneADebug,
    classification: classifyLane(laneADebug),
  };

  const laneBRequest = {
    question: "How does Feedback Loop Hygiene affect society?",
    debug: true,
    verbosity: "brief",
    sessionId: "dot-loop-lane-b",
  };
  const laneBResponse = await fetchJson(`${baseUrl}/api/agi/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(laneBRequest),
  });
  const laneBDebug = readDebug(laneBResponse.payload);
  const laneB: LaneResult = {
    request: laneBRequest,
    status: laneBResponse.status,
    payload: laneBResponse.payload,
    debug: laneBDebug,
    classification: classifyLane(laneBDebug),
  };

  const laneCRequest = {
    question: "How does Feedback Loop Hygiene affect society?",
    debug: true,
    sessionId: "dot-loop-lane-c",
  };
  const laneCCreate = await fetchJson(`${baseUrl}/api/agi/ask/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(laneCRequest),
  });
  const created = asObject(laneCCreate.payload);
  const jobId = typeof created?.jobId === "string" ? created.jobId : null;
  let laneCFinalStatus = laneCCreate.status;
  let laneCFinalPayload: unknown = laneCCreate.payload;
  if (jobId) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const polled = await fetchJson(`${baseUrl}/api/agi/ask/jobs/${jobId}`);
      laneCFinalStatus = polled.status;
      laneCFinalPayload = polled.payload;
      const status = asObject(polled.payload)?.status;
      if (status === "completed" || status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const laneCDebug = readDebug(laneCFinalPayload);
  const laneC: LaneResult = {
    request: laneCRequest,
    status: laneCFinalStatus,
    payload: laneCFinalPayload,
    debug: laneCDebug,
    classification: classifyLane(laneCDebug),
  };

  const hypotheses: Hypothesis[] = [];
  const addHypothesis = (entry: Hypothesis): void => {
    hypotheses.push({ ...entry, falsified: entry.pass === false });
  };

  addHypothesis({
    id: "H0_preflight_ready",
    statement: "Runtime preflight must satisfy HTTP lane prerequisites.",
    expected: "all preflight checks pass",
    observed: envScopeMismatch ? "scope_mismatch_with_server_runtime" : preflightReady ? "all_pass" : "one_or_more_failed",
    pass: envScopeMismatch ? null : preflightReady,
    falsified: false,
  });
  addHypothesis({
    id: "H0b_hull_ready",
    statement: "Hull status must expose allowed OpenAI HTTP backend.",
    expected: "hull status 200 and llm_http.allowed=true",
    observed: hullReady ? "hull_ready" : "hull_not_ready",
    pass: hullReady,
    falsified: false,
  });
  addHypothesis({
    id: "H1_laneA_short_circuit_control",
    statement: "Lane A control prompt should short-circuit deterministically.",
    expected: "A_short_circuit",
    observed: laneA.classification,
    pass: laneA.classification === "A_short_circuit",
    falsified: false,
  });
  addHypothesis({
    id: "H2_laneB_invoke",
    statement: "Lane B should attempt LLM invocation (not short-circuit).",
    expected: "llm_invoke_attempted=true and no skip_reason",
    observed: `invoke=${String(laneBDebug.llm_invoke_attempted)} skip=${String(laneBDebug.llm_skip_reason)}`,
    pass: laneBDebug.llm_invoke_attempted === true && !laneBDebug.llm_skip_reason,
    falsified: false,
  });
  addHypothesis({
    id: "H3_laneB_http_success",
    statement: "Lane B should complete with HTTP provider success.",
    expected: "C_http_success",
    observed: laneB.classification,
    pass: laneB.classification === "C_http_success",
    falsified: false,
  });
  addHypothesis({
    id: "H4_laneC_invoke",
    statement: "Lane C jobs flow should attempt LLM invocation.",
    expected: "llm_invoke_attempted=true and no skip_reason",
    observed: `invoke=${String(laneCDebug.llm_invoke_attempted)} skip=${String(laneCDebug.llm_skip_reason)}`,
    pass: laneCDebug.llm_invoke_attempted === true && !laneCDebug.llm_skip_reason,
    falsified: false,
  });
  addHypothesis({
    id: "H5_laneC_http_success",
    statement: "Lane C jobs flow should complete with HTTP provider success.",
    expected: "C_http_success",
    observed: laneC.classification,
    pass: laneC.classification === "C_http_success",
    falsified: false,
  });

  let h6Pass: boolean | null = null;
  let h6Observed = `probe=${directOpenAiProbe.verdict}; laneB=${laneB.classification}; laneC=${laneC.classification}`;
  if (envScopeMismatch) {
    h6Observed = `${h6Observed}; not_evaluable:env_scope_mismatch`;
  } else if (directOpenAiProbe.verdict === "success") {
    h6Pass = !isAuthFailure(laneBDebug) && !isAuthFailure(laneCDebug);
  } else if (directOpenAiProbe.verdict === "auth_failure") {
    h6Pass = isAuthFailure(laneBDebug) || isAuthFailure(laneCDebug);
  } else if (directOpenAiProbe.verdict === "transport_failure") {
    h6Pass = isTransportFailure(laneBDebug) || isTransportFailure(laneCDebug);
  } else {
    h6Observed = `${h6Observed}; not_evaluable`;
  }
  addHypothesis({
    id: "H6_probe_vs_lane_consistency",
    statement: "Direct OpenAI probe outcome should be consistent with lane failure class.",
    expected: "probe and lane diagnostics agree (auth/transport/success)",
    observed: h6Observed,
    pass: h6Pass,
    falsified: false,
  });

  const falsifiedHypotheses = hypotheses.filter((entry) => entry.falsified).map((entry) => entry.id);
  const overallGo =
    laneA.classification === "A_short_circuit" &&
    laneB.classification === "C_http_success" &&
    laneC.classification === "C_http_success";

  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    envPreflight,
    preflightChecks,
    preflightReady,
    hullStatusHttp: hull.status,
    hullStatus: hull.payload,
    hullChecks,
    hullReady,
    directOpenAiProbe,
    lanes: {
      A: laneA,
      B: laneB,
      C: laneC,
    },
    hypotheses,
    falsifiedHypotheses,
    goNoGo: overallGo ? "GO" : "NO-GO",
    goNoGoTarget: "OpenAI-backed Helix Ask lane proven (A short-circuit + B/C HTTP success)",
  };

  fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`helix-ask-dot-debug-loop failed: ${message}\n`);
  process.exitCode = 1;
});
