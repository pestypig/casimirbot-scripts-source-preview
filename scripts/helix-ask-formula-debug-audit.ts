import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type AuditCheck = {
  id: string;
  ok: boolean;
  detail: string;
};

export type FormulaDebugAuditResult = {
  schema: "helix.formula_bound_scholarly_debug_audit.v1";
  ok: boolean;
  file: string | null;
  turn_id: string | null;
  source: "file" | "turn_debug_export" | "self_test";
  checks: AuditCheck[];
  summary: {
    tool_requests: string[];
    recovery_kind: string | null;
    calculator_solve_requested: boolean;
    bound_calculator_expression_present: boolean;
  };
};

const FORMULA = "rate_proxy_m3_s = n1_m3 * n2_m3 * sigma_m2 * v_m_s";
const VARIABLES = ["n1_m3", "n2_m3", "sigma_m2", "v_m_s"];

const readArgValue = (name: string, argv = process.argv.slice(2)): string | null => {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
};

const hasFlag = (name: string, argv = process.argv.slice(2)): boolean => argv.includes(name);

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/g, "");

const normalize = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

const walk = (
  value: unknown,
  visitor: (value: unknown, path: string[]) => void,
  path: string[] = [],
): void => {
  visitor(value, path);
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, visitor, [...path, String(index)]));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    walk(entry, visitor, [...path, key]);
  }
};

const collectStrings = (payload: unknown): string[] => {
  const strings: string[] = [];
  walk(payload, (value) => {
    if (typeof value === "string") strings.push(value);
  });
  return strings;
};

const collectKeyValues = (payload: unknown, keyName: string): unknown[] => {
  const values: unknown[] = [];
  walk(payload, (value, path) => {
    if (path[path.length - 1] === keyName) values.push(value);
  });
  return values;
};

const hasKey = (payload: unknown, keyName: string): boolean =>
  collectKeyValues(payload, keyName).some((value) => value != null);

const hasText = (strings: string[], pattern: RegExp): boolean =>
  strings.some((entry) => pattern.test(entry));

const collectToolRequests = (payload: unknown): string[] => {
  const requests = new Set<string>();
  walk(payload, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    const text = normalize(record.text);
    if (/^Tool request:\s*/i.test(text)) requests.add(text);
    const eventType = normalize(record.source_event_type);
    const capability = normalize(record.capability_id ?? record.capability_key);
    if (eventType === "tool_request" && capability) requests.add(`Tool request: ${capability}.`);
  });
  return Array.from(requests);
};

const variableSourcePlanHasVariables = (payload: unknown): boolean => {
  const plans = collectKeyValues(payload, "variable_source_plan");
  return plans.some((plan) => {
    const serialized = JSON.stringify(plan);
    return VARIABLES.every((variable) => serialized.includes(variable));
  });
};

const hasFormulaAwareQuery = (payload: unknown, strings: string[]): boolean => {
  const queries = [
    ...collectKeyValues(payload, "query").map(normalize),
    ...collectKeyValues(payload, "query_terms").map((value) => JSON.stringify(value)),
    ...strings,
  ];
  return queries.some((entry) =>
    /thermonuclear reaction rate|fusion cross section|sigma v|Maxwellian/i.test(entry) &&
    /fusion|thermonuclear|reaction/i.test(entry)
  );
};

const expressionIsNumericallyBound = (value: unknown): boolean => {
  const expression = normalize(value);
  if (!expression) return false;
  if (VARIABLES.some((variable) => new RegExp(`\\b${variable}\\b`, "i").test(expression))) return false;
  return /^[0-9eE.+\-*/^%()[\]\s]+$/.test(expression);
};

const boundCalculatorExpressionValueIsUsable = (value: unknown): boolean => {
  if (expressionIsNumericallyBound(value)) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    expressionIsNumericallyBound(record.bound_expression) ||
    expressionIsNumericallyBound(record.normalized_expression) ||
    expressionIsNumericallyBound(record.expression)
  );
};

const hasBoundCalculatorExpression = (payload: unknown): boolean =>
  [
    ...collectKeyValues(payload, "bound_calculator_expression"),
    ...collectKeyValues(payload, "bound_expression"),
  ].some(boundCalculatorExpressionValueIsUsable);

export const buildFormulaDebugAuditSelfTestPayload = (): Record<string, unknown> => ({
  schema: "helix.ask.debug_export.v1",
  prior_theory_formula_context: {
    formulas: [FORMULA],
    variables: VARIABLES,
  },
  variable_source_plan: {
    formula_variables: VARIABLES,
    query_terms: ["fusion", "thermonuclear reaction rate", "fusion cross section", "sigma v"],
  },
  scholarly_numeric_recovery_affordance: {
    schema: "helix.scholarly_numeric_recovery_affordance.v1",
    recovery_queries: ["D-T fusion plasma density cross section relative velocity"],
  },
  provider_reasoning_reentry: {
    status: "completed",
  },
  turn_transcript_events: [
    {
      source_event_type: "tool_request",
      capability_id: "scholarly-research.lookup_papers",
      text: "Tool request: scholarly-research.lookup_papers.",
    },
    {
      source_event_type: "model_reentry",
      text: "Codex received the workstation observation packet(s) before final answer.",
    },
  ],
});

const auditDebugExport = (
  payload: unknown,
  input: {
    file: string | null;
    turnId: string | null;
    source: FormulaDebugAuditResult["source"];
  },
): FormulaDebugAuditResult => {
  const strings = collectStrings(payload);
  const toolRequests = collectToolRequests(payload);
  const lookupRecovery = hasKey(payload, "scholarly_lookup_recovery_affordance");
  const fullTextRecovery = hasKey(payload, "scholarly_full_text_recovery_affordance");
  const numericRecovery = hasKey(payload, "scholarly_numeric_recovery_affordance");
  const calculatorSolveRequested = toolRequests.some((entry) =>
    /scientific-calculator\.solve_expression/i.test(entry)
  );
  const boundCalculatorExpressionPresent = hasBoundCalculatorExpression(payload);
  const rejectedResultsPresent = hasKey(payload, "rejected_results") || hasKey(payload, "rejected_result_ids");
  const checks: AuditCheck[] = [
    {
      id: "prior_theory_formula_context",
      ok: hasKey(payload, "prior_theory_formula_context") && hasText(strings, /rate_proxy_m3_s\s*=\s*n1_m3\s*\*\s*n2_m3\s*\*\s*sigma_m2\s*\*\s*v_m_s/),
      detail: "Debug includes the prior theory formula context and exact fusion formula.",
    },
    {
      id: "variable_source_plan",
      ok: variableSourcePlanHasVariables(payload),
      detail: `Debug includes variable_source_plan for ${VARIABLES.join(", ")}.`,
    },
    {
      id: "formula_aware_query",
      ok: hasFormulaAwareQuery(payload, strings),
      detail: "Debug includes a formula-aware scholarly query or query plan.",
    },
    {
      id: "recovery_affordance",
      ok: lookupRecovery || fullTextRecovery || numericRecovery,
      detail: "Debug includes lookup, full-text, or numeric recovery affordance evidence.",
    },
    {
      id: "lookup_rejection_reasons_or_numeric_recovery",
      ok: rejectedResultsPresent || fullTextRecovery || numericRecovery,
      detail: "Irrelevant lookup results include rejection reasons, or full-text/numeric recovery evidence is present.",
    },
    {
      id: "model_reentry",
      ok: hasKey(payload, "provider_reasoning_reentry") ||
        hasText(strings, /Codex received the workstation observation packet|model re-entry|model_reentry/i),
      detail: "Codex/provider re-entry is visible before final answer authority.",
    },
    {
      id: "calculator_safety",
      ok: !calculatorSolveRequested || boundCalculatorExpressionPresent,
      detail: "Calculator solve is absent unless a bound calculator expression exists.",
    },
  ];
  return {
    schema: "helix.formula_bound_scholarly_debug_audit.v1",
    ok: checks.every((check) => check.ok),
    file: input.file,
    turn_id: input.turnId,
    source: input.source,
    checks,
    summary: {
      tool_requests: toolRequests,
      recovery_kind: numericRecovery
        ? "scholarly_numeric_recovery_affordance"
        : fullTextRecovery
          ? "scholarly_full_text_recovery_affordance"
          : lookupRecovery
          ? "scholarly_lookup_recovery_affordance"
          : null,
      calculator_solve_requested: calculatorSolveRequested,
      bound_calculator_expression_present: boundCalculatorExpressionPresent,
    },
  };
};

const fetchDebugExport = async (baseUrl: string, turnId: string): Promise<unknown> => {
  const url = `${trimTrailingSlash(baseUrl)}/api/agi/ask/turn/${encodeURIComponent(turnId)}/debug-export`;
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`debug_export_fetch_failed status=${response.status} url=${url} body=${text.slice(0, 240)}`);
  }
  return response.json();
};

export const auditFormulaBoundScholarlyDebugExport = auditDebugExport;

const main = async (): Promise<void> => {
  const json = hasFlag("--json");
  const strict = hasFlag("--strict");
  const selfTest = hasFlag("--self-test");
  const file = readArgValue("--file");
  const turnId = readArgValue("--turn-id");
  const baseUrl = readArgValue("--base-url") ?? "http://127.0.0.1:1498";
  if (!selfTest && !file && !turnId) {
    console.error("Usage: tsx scripts/helix-ask-formula-debug-audit.ts --file debug-export.json [--strict] [--json]");
    console.error("       tsx scripts/helix-ask-formula-debug-audit.ts --turn-id <turn-id> [--base-url http://127.0.0.1:1498] [--strict] [--json]");
    console.error("       tsx scripts/helix-ask-formula-debug-audit.ts --self-test [--strict] [--json]");
    process.exitCode = 2;
    return;
  }
  let payload: unknown;
  let source: FormulaDebugAuditResult["source"];
  try {
    if (selfTest) {
      payload = buildFormulaDebugAuditSelfTestPayload();
      source = "self_test";
    } else if (turnId) {
      payload = await fetchDebugExport(baseUrl, turnId);
      source = "turn_debug_export";
    } else {
      payload = JSON.parse(readFileSync(file as string, "utf8"));
      source = "file";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      console.log(JSON.stringify({
        schema: "helix.formula_bound_scholarly_debug_audit.v1",
        ok: false,
        source: turnId ? "turn_debug_export" : file ? "file" : "self_test",
        file: file ?? null,
        turn_id: turnId ?? null,
        error: message,
      }, null, 2));
    } else {
      console.error(`Formula-bound scholarly debug audit: ERROR`);
      console.error(message);
    }
    process.exitCode = strict ? 1 : 2;
    return;
  }
  const result = auditDebugExport(payload, {
    file: selfTest || turnId ? null : file,
    turnId: turnId ?? null,
    source,
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Formula-bound scholarly debug audit: ${result.ok ? "PASS" : "FAIL"}`);
    for (const check of result.checks) {
      console.log(`${check.ok ? "PASS" : "FAIL"} ${check.id}: ${check.detail}`);
    }
    console.log(`recovery_kind: ${result.summary.recovery_kind ?? "none"}`);
    console.log(`calculator_solve_requested: ${result.summary.calculator_solve_requested}`);
    console.log(`bound_calculator_expression_present: ${result.summary.bound_calculator_expression_present}`);
    if (result.summary.tool_requests.length) {
      console.log("tool_requests:");
      for (const request of result.summary.tool_requests) console.log(`- ${request}`);
    }
  }
  if (strict && !result.ok) process.exitCode = 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
