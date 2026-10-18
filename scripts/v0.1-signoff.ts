type SignoffResult = {
  skipped?: boolean;
  reason?: string;
  spawn?: {
    ok: boolean;
    traceId?: string;
    essenceId?: string;
    taskTraceId?: string;
    error?: string;
  };
  eval?: {
    total?: number;
    ok?: number;
    rate?: number;
    ok_target?: number;
    ran?: boolean;
    skipped?: boolean;
    error?: string;
    meets_target?: boolean;
  };
  metrics?: {
    ok: boolean;
    spawn_calls?: number;
    spawn_latency_samples?: number;
    delta_calls?: number;
    delta_latency_samples?: number;
    error?: string;
  };
  ok: boolean;
};

type MetricSnapshot = {
  ok: boolean;
  spawnCalls?: number;
  spawnLatencySamples?: number;
  error?: string;
};

const REQUIRED_GATES: Array<{ key: string; expected: string; caseInsensitive?: boolean }> = [
  { key: "ENABLE_ESSENCE", expected: "1" },
  { key: "ENABLE_AGI", expected: "1" },
  { key: "HULL_MODE", expected: "1" },
  { key: "LLM_POLICY", expected: "local", caseInsensitive: true },
  { key: "ENABLE_LLM_LOCAL_SPAWN", expected: "1" },
];

const DEFAULT_GOAL = "Summarize the README in one sentence.";

function getEnv(key: string): string {
  return (process.env[key] ?? "").trim();
}

function base(): string {
  return (getEnv("EVAL_BASE_URL") || "http://127.0.0.1:3000").replace(/\/+$/, "");
}

async function jpost(path: string, body: unknown): Promise<any> {
  const url = new URL(path, base());
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${url.pathname}: ${text || "request_failed"}`);
  }
  return res.json();
}

async function jget(path: string): Promise<string> {
  const url = new URL(path, base());
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${url.pathname}: ${text || "request_failed"}`);
  }
  return res.text();
}

function parseMetricValue(text: string, name: string): number | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|\\n)${escaped}(?:{[^}]*})?\\s+([0-9.eE+-]+)`, "m");
  const match = pattern.exec(text);
  if (!match) {
    return undefined;
  }
  const value = Number(match[2]);
  return Number.isFinite(value) ? value : undefined;
}

async function captureMetricsSnapshot(): Promise<MetricSnapshot> {
  try {
    const text = await jget("/metrics");
    const spawnCalls =
      parseMetricValue(text, "llm_local_spawn_calls_total") ??
      parseMetricValue(text, "llm_local_spawn_calls") ??
      0;
    const spawnLatencySamples =
      parseMetricValue(text, "llm_local_spawn_latency_ms_count") ??
      parseMetricValue(text, "llm_local_spawn_latency_ms") ??
      0;
    return { ok: true, spawnCalls, spawnLatencySamples };
  } catch (error) {
    return { ok: false, error: (error as Error)?.message ?? "metrics_error" };
  }
}

function essenceFromPayload(payload: any): string | undefined {
  const attempt = (value: unknown): string | undefined => {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = attempt(entry);
        if (found) {
          return found;
        }
      }
    } else if (value && typeof value === "object") {
      const candidate = (value as { essence_id?: string; essenceId?: string }).essence_id ?? (value as any).essenceId;
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
      const ids = (value as any).essence_ids;
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === "string" && id.trim()) {
            return id.trim();
          }
        }
      }
    }
    return undefined;
  };

  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const direct = attempt(payload);
  if (direct) {
    return direct;
  }
  const steps = Array.isArray((payload as any).steps) ? (payload as any).steps : undefined;
  if (steps) {
    for (const step of steps) {
      const found = attempt(step);
      if (found) {
        return found;
      }
    }
  }
  const taskTrace = (payload as any).task_trace;
  if (taskTrace && typeof taskTrace === "object" && Array.isArray(taskTrace.steps)) {
    for (const step of taskTrace.steps) {
      const found = attempt(step);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

async function runSpawnTurn(goal: string, personaId: string): Promise<SignoffResult["spawn"]> {
  try {
    const plan = await jpost("/api/agi/plan", { goal, personaId });
    const traceId: string | undefined = plan?.traceId ?? plan?.trace_id ?? plan?.trace?.id;
    if (!traceId) {
      return { ok: false, error: "missing_traceId" };
    }
    const exec = await jpost("/api/agi/execute", { traceId });
    const essenceId = essenceFromPayload(exec);
    const taskTraceId: string | undefined = exec?.task_trace?.id ?? exec?.traceId;
    if (!essenceId) {
      return { ok: false, traceId, taskTraceId, error: "essence_not_found" };
    }
    return { ok: true, traceId, essenceId, taskTraceId };
  } catch (error) {
    return { ok: false, error: (error as Error)?.message ?? "spawn_failed" };
  }
}

async function runEval(okTarget: number): Promise<NonNullable<SignoffResult["eval"]>> {
  try {
    const res = await jpost("/api/agi/eval/smoke", {});
    const total = Number(res?.total ?? 0);
    const okCount = Number(res?.ok ?? 0);
    const rate = Number(res?.rate ?? (total > 0 ? okCount / total : 0));
    const skipped = Boolean(res?.skipped);
    if (skipped) {
      return {
        total,
        ok: okCount,
        rate,
        ok_target: okTarget,
        ran: false,
        skipped: true,
        meets_target: true,
      };
    }
    const meetsTarget = total > 0 ? rate >= okTarget : false;
    return {
      total,
      ok: okCount,
      rate,
      ok_target: okTarget,
      ran: true,
      meets_target: meetsTarget,
    };
  } catch (error) {
    return {
      total: 0,
      ok: 0,
      rate: 0,
      ok_target: okTarget,
      ran: false,
      error: (error as Error)?.message ?? "eval_failed",
      meets_target: false,
    };
  }
}

function summarizeMetrics(before: MetricSnapshot, after: MetricSnapshot): NonNullable<SignoffResult["metrics"]> {
  if (!before.ok) {
    return { ok: false, error: before.error ?? "metrics_before_unavailable" };
  }
  if (!after.ok) {
    return { ok: false, error: after.error ?? "metrics_after_unavailable" };
  }
  const beforeCalls = before.spawnCalls ?? 0;
  const afterCalls = after.spawnCalls ?? 0;
  const beforeLatency = before.spawnLatencySamples ?? 0;
  const afterLatency = after.spawnLatencySamples ?? 0;

  const deltaCalls = afterCalls - beforeCalls;
  const deltaLatency = afterLatency - beforeLatency;
  const spawnCalls = after.spawnCalls ?? afterCalls;
  const spawnLatencySamples = after.spawnLatencySamples ?? afterLatency;

  const ok = spawnCalls > 0 && spawnLatencySamples > 0 && deltaCalls > 0 && deltaLatency > 0;
  return {
    ok,
    spawn_calls: spawnCalls,
    spawn_latency_samples: spawnLatencySamples,
    delta_calls: deltaCalls,
    delta_latency_samples: deltaLatency,
    error: ok ? undefined : "metrics_not_incremented",
  };
}

async function run(): Promise<void> {
  const missing = REQUIRED_GATES.filter(({ key, expected, caseInsensitive }) => {
    const value = getEnv(key);
    if (value.length === 0) {
      return true;
    }
    return caseInsensitive ? value.toLowerCase() !== expected.toLowerCase() : value !== expected;
  }).map(({ key }) => key);

  if (missing.length > 0) {
    const payload: SignoffResult = {
      skipped: true,
      reason: `enable gates: ${missing.join(", ")}`,
      ok: false,
    };
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
    return;
  }

  const personaId = getEnv("SIGNOFF_PERSONA_ID") || getEnv("DEFAULT_PERSONA_ID") || "persona:demo";
  const goal = getEnv("SIGNOFF_GOAL") || DEFAULT_GOAL;
  const okTarget = Number(getEnv("EVAL_SUCCESS_TARGET") || "0.70");

  const beforeMetrics = await captureMetricsSnapshot();
  const spawn = await runSpawnTurn(goal, personaId);
  const afterMetrics = await captureMetricsSnapshot();
  const metrics = summarizeMetrics(beforeMetrics, afterMetrics);
  const evalResult = await runEval(okTarget);
  const evalGateOk = Boolean(evalResult?.meets_target ?? false);
  const finalOk = Boolean(spawn.ok && metrics.ok && evalGateOk);
  const payload: SignoffResult = {
    spawn,
    metrics,
    eval: evalResult,
    ok: finalOk,
  };
  console.log(JSON.stringify(payload, null, 2));
  if (!finalOk) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: (error as Error)?.message ?? "signoff_failed",
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
