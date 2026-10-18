import fs from "node:fs";
import path from "node:path";
import { runScientificSolve, type ScientificSolveResult } from "../../client/src/lib/scientific-calculator/solver";
import { runWarpFullSolveCalculator } from "../warp-full-solve-calculator";

type AuditClassification =
  | "match"
  | "numeric_tolerance_match"
  | "symbolic_equivalent"
  | "expected_scientific_calculator_only"
  | "expected_backend_only"
  | "delegated_successfully"
  | "missing_capability"
  | "answer_divergence"
  | "trace_missing"
  | "route_mismatch"
  | "unsupported_input";

type AuditCase = {
  id: string;
  label: string;
  group: "symbolic_algebra" | "numeric_math" | "latex_parsing" | "gr_warp_route" | "audit_trace";
  input: {
    expression?: string;
    route?: "warp-full-solve";
    profile?: "default";
  };
  expectedOwner: "scientific_calculator" | "einstein_backend";
  expectedCapabilities: string[];
  expectedCanonical?: string[];
  expectedBackendFields?: string[];
  tolerance?: {
    numeric?: number;
    symbolic?: boolean;
  };
};

type AdapterEnvelope = {
  caseId: string;
  adapter: "scientific_calculator" | "warp_full_solve";
  status: "ok" | "unsupported" | "error";
  answer?: string | string[];
  canonicalAnswer?: string | string[];
  steps?: unknown[];
  decisionClass?: string;
  reasonCode?: string[];
  rhoSource?: string | null;
  metricContractOk?: boolean | null;
  congruentSolvePass?: boolean | null;
  marginRatioRaw?: number | null;
  marginRatioRawComputed?: number | null;
  trace: {
    traceId: string | null;
    runId: string | null;
    artifactPath: string | null;
    route: string;
    engine: string;
    sourceOfTruth: string;
    capabilityClass?: string;
  };
  warnings: string[];
};

type AuditResult = {
  case: AuditCase;
  classification: AuditClassification;
  adapters: AdapterEnvelope[];
  notes: string[];
};

const OUT_ROOT = path.join("artifacts", "research", "full-solve");
const JSON_OUT = path.join(OUT_ROOT, "scientific-vs-einstein-capability.json");
const MD_OUT = path.join(OUT_ROOT, "scientific-vs-einstein-capability.md");

const CASES: AuditCase[] = [
  {
    id: "symbolic_solve_quadratic_001",
    label: "Solve quadratic",
    group: "symbolic_algebra",
    input: { expression: "x^2 - 4 = 0" },
    expectedOwner: "scientific_calculator",
    expectedCapabilities: ["symbolic_solve", "steps", "trace"],
    expectedCanonical: ["-2", "2"],
    tolerance: { symbolic: true },
  },
  {
    id: "numeric_sin_pi_001",
    label: "Evaluate sin(pi/2)",
    group: "numeric_math",
    input: { expression: "sin(pi/2)" },
    expectedOwner: "scientific_calculator",
    expectedCapabilities: ["numeric_eval", "trace"],
    expectedCanonical: ["1"],
    tolerance: { numeric: 1e-9 },
  },
  {
    id: "latex_expand_binomial_001",
    label: "Parse and simplify LaTeX binomial",
    group: "latex_parsing",
    input: { expression: "x^2 + 2x + 1" },
    expectedOwner: "scientific_calculator",
    expectedCapabilities: ["latex_parse", "symbolic_simplify", "trace"],
    expectedCanonical: ["1+2*x+x^2"],
    tolerance: { symbolic: true },
  },
  {
    id: "calculus_derivative_001",
    label: "Differentiate x squared",
    group: "symbolic_algebra",
    input: { expression: "diff(x^2,x)" },
    expectedOwner: "scientific_calculator",
    expectedCapabilities: ["calculus", "trace"],
    expectedCanonical: ["2*x"],
    tolerance: { symbolic: true },
  },
  {
    id: "gr_natario_qi_margin_001",
    label: "Natario SDF QI margin route",
    group: "gr_warp_route",
    input: { profile: "default", route: "warp-full-solve" },
    expectedOwner: "einstein_backend",
    expectedCapabilities: ["metric_contract_check", "rho_source", "qi_margin", "decision_class", "trace_artifact"],
    expectedBackendFields: ["decisionClass", "reasonCode", "rhoSource", "metricContractOk", "congruentSolvePass", "marginRatioRaw", "marginRatioRawComputed"],
    tolerance: { numeric: 1e-9, symbolic: false },
  },
  {
    id: "gr_scientific_router_001",
    label: "Scientific calculator rejects backend-only Einstein tensor request",
    group: "audit_trace",
    input: { expression: "Compute the Einstein tensor and QI guardrail for the Natario warp.metric T00 route." },
    expectedOwner: "einstein_backend",
    expectedCapabilities: ["capability_route", "delegation_hint", "trace"],
    tolerance: { symbolic: false },
  },
];

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, "").replace(/\*/g, "").toLowerCase();
}

function scientificEnvelope(testCase: AuditCase, result: ScientificSolveResult): AdapterEnvelope {
  return {
    caseId: testCase.id,
    adapter: "scientific_calculator",
    status: result.ok ? "ok" : result.error === "backend_required" ? "unsupported" : "error",
    answer: result.result_text,
    canonicalAnswer: result.result_text,
    steps: result.steps,
    trace: {
      traceId: result.trace.traceId,
      runId: result.trace.runId,
      artifactPath: result.trace.artifactPath,
      route: result.trace.route,
      engine: result.trace.engine,
      sourceOfTruth: result.trace.sourceOfTruth,
      capabilityClass: result.trace.capabilityClass,
    },
    warnings: result.trace.warnings,
  };
}

async function runBackendEnvelope(testCase: AuditCase): Promise<AdapterEnvelope> {
  const artifactPath = path.join(OUT_ROOT, `${testCase.id}.backend.json`);
  const result = await runWarpFullSolveCalculator({
    outPath: artifactPath,
    writeOutput: true,
  });
  const payload = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as Record<string, any>;
  const reasonCode = Array.isArray(payload.result?.reasonCode)
    ? payload.result.reasonCode.map((item: unknown) => String(item))
    : [];
  return {
    caseId: testCase.id,
    adapter: "warp_full_solve",
    status: result.ok ? "ok" : "error",
    decisionClass: String(payload.result?.decisionClass ?? result.decisionClass ?? ""),
    reasonCode,
    rhoSource: typeof payload.result?.rhoSource === "string" ? payload.result.rhoSource : null,
    metricContractOk: typeof payload.result?.metricContractOk === "boolean" ? payload.result.metricContractOk : null,
    congruentSolvePass: typeof payload.result?.congruentSolvePass === "boolean" ? payload.result.congruentSolvePass : null,
    marginRatioRaw: asFiniteNumber(payload.result?.marginRatioRaw),
    marginRatioRawComputed: asFiniteNumber(payload.result?.marginRatioRawComputed),
    trace: {
      traceId: `warp-full-solve:${testCase.id}`,
      runId: `warp-full-solve:${testCase.id}`,
      artifactPath,
      route: "warp-full-solve-calculator",
      engine: "warp_full_solve",
      sourceOfTruth: "einstein_backend",
      capabilityClass: "gr_warp_physics",
    },
    warnings: payload.result?.congruentSolvePass === true ? [] : reasonCode,
  };
}

function classifyScientificCase(testCase: AuditCase, envelope: AdapterEnvelope): AuditClassification {
  if (!envelope.trace.traceId || !envelope.trace.runId) return "trace_missing";
  if (testCase.expectedOwner === "einstein_backend") {
    if (envelope.status === "unsupported" && envelope.trace.sourceOfTruth === "einstein_backend") {
      return "expected_backend_only";
    }
    return "answer_divergence";
  }
  if (envelope.status !== "ok") return "missing_capability";
  const answer = normalizeText(String(envelope.answer ?? ""));
  const expected = testCase.expectedCanonical ?? [];
  if (testCase.tolerance?.numeric && expected.length === 1) {
    const actualNumber = Number(envelope.answer);
    const expectedNumber = Number(expected[0]);
    if (Number.isFinite(actualNumber) && Math.abs(actualNumber - expectedNumber) <= testCase.tolerance.numeric) {
      return "numeric_tolerance_match";
    }
  }
  if (expected.length > 0 && expected.every((item) => answer.includes(normalizeText(item)))) {
    return testCase.tolerance?.symbolic ? "symbolic_equivalent" : "match";
  }
  return "answer_divergence";
}

function classifyBackendCase(testCase: AuditCase, envelope: AdapterEnvelope): AuditClassification {
  if (!envelope.trace.artifactPath) return "trace_missing";
  if (envelope.status !== "ok") return "missing_capability";
  const missingFields = (testCase.expectedBackendFields ?? []).filter((field) => {
    const value = (envelope as Record<string, unknown>)[field];
    return value == null || (Array.isArray(value) && value.length === 0);
  });
  if (missingFields.length > 0) return "trace_missing";
  if (envelope.trace.sourceOfTruth !== "einstein_backend") return "route_mismatch";
  return "delegated_successfully";
}

async function runCase(testCase: AuditCase): Promise<AuditResult> {
  if (testCase.input.route === "warp-full-solve") {
    const backend = await runBackendEnvelope(testCase);
    return {
      case: testCase,
      classification: classifyBackendCase(testCase, backend),
      adapters: [backend],
      notes: backend.warnings,
    };
  }
  const expression = testCase.input.expression ?? "";
  const scientific = scientificEnvelope(testCase, runScientificSolve(expression, true));
  return {
    case: testCase,
    classification: classifyScientificCase(testCase, scientific),
    adapters: [scientific],
    notes: scientific.warnings,
  };
}

function summarize(results: AuditResult[]) {
  const counts = new Map<AuditClassification, number>();
  for (const result of results) {
    counts.set(result.classification, (counts.get(result.classification) ?? 0) + 1);
  }
  return Object.fromEntries(Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b)));
}

function writeMarkdown(results: AuditResult[], summary: Record<string, number>) {
  const lines = [
    "# Scientific Calculator vs Einstein Backend Capability Audit",
    "",
    "## Summary",
    "",
    `Total cases: ${results.length}`,
    ...Object.entries(summary).map(([key, value]) => `${key}: ${value}`),
    "",
    "## Capability Verdict",
    "",
    "The Scientific Calculator supports symbolic, algebraic, LaTeX-preview, and basic equation workflows.",
    "",
    "The Einstein/warp backend remains required for full Einstein tensor routes, finite-difference geometry routes, metric contraction checks, Natario/SDF rho source calculations, QI margin decisions, and backend route comparability.",
    "",
    "## Cases",
    "",
    "| Case | Owner | Classification | Route | Trace | Notes |",
    "| --- | --- | --- | --- | --- | --- |",
    ...results.map((result) => {
      const adapter = result.adapters[0];
      const trace = adapter?.trace.artifactPath ?? adapter?.trace.traceId ?? "missing";
      const notes = result.notes.length ? result.notes.join("; ") : "";
      return `| ${result.case.id} | ${result.case.expectedOwner} | ${result.classification} | ${adapter?.trace.route ?? "n/a"} | ${trace} | ${notes} |`;
    }),
    "",
    "## Action Items",
    "",
    "1. Keep full calculator steps in panel action artifacts.",
    "2. Attach traceId/runId to each calculator answer.",
    "3. Use backend delegation for GR-class requests.",
    "4. Re-run this audit on calculator/backend changes.",
    "",
  ];
  fs.writeFileSync(MD_OUT, `${lines.join("\n")}`);
}

async function main() {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const results: AuditResult[] = [];
  for (const testCase of CASES) {
    results.push(await runCase(testCase));
  }
  const summary = summarize(results);
  fs.writeFileSync(
    JSON_OUT,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2)}\n`,
  );
  writeMarkdown(results, summary);
  console.log(JSON.stringify({ ok: true, json: JSON_OUT, markdown: MD_OUT, summary }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
