import fs from "node:fs/promises";
import path from "node:path";
import { resolveArtifactsPath } from "./agi-artifacts";
import { normalizeEvidenceRef } from "../server/services/agi/refinery-identity";
import { searchRepoGraph } from "../server/services/repo/repoGraph";

type SeedSurface = "client" | "server" | "shared" | "modules" | "docs" | "warp";

type SeedRequest = {
  goal: string;
  surface: SeedSurface;
  path: string;
  resourceHints: string[];
  tags: string[];
  summaryFocus?: string;
};

type SeedTemplate = {
  goal: string;
  surface: SeedSurface;
  path: string;
  resourceHints?: string[];
  tags?: string[];
  summaryFocus?: string;
};

type SeedArgs = {
  baseUrl?: string;
  run?: boolean;
  limit?: number;
  perSurface?: number;
  alignment?: boolean;
  alignmentOnly?: boolean;
  panelAnalysis?: boolean;
  panelAnalysisOnly?: boolean;
  backendAnalysis?: boolean;
  backendAnalysisOnly?: boolean;
  outPath?: string;
  sleepMs?: number;
  timeoutMs?: number;
  includeDocs?: boolean;
  includeWarp?: boolean;
  surfaces?: SeedSurface[];
  maxDocsShare?: number;
  minClientShare?: number;
  minModulesShare?: number;
  minDocsShare?: number;
  maxServerShare?: number;
  precheck?: boolean;
  precheckThreshold?: number;
  precheckLimit?: number;
  essenceConsole?: boolean;
};

type PrecheckSummary = {
  eligible: SeedRequest[];
  anchorsWithCandidates: Record<SeedSurface, number>;
  attemptsBySurface: Record<SeedSurface, number>;
  failuresBySurface: Record<SeedSurface, number>;
  errorCount: number;
};

const EXCLUDE_DIRS = new Set([
  ".git",
  ".cache",
  ".cal",
  "node_modules",
  "dist",
  "build",
  "artifacts",
  "tmp",
  "reports",
  "external",
  "simulations",
  "sunpy_out",
  "test-results",
]);

const WARP_EXCLUDE_PATHS: RegExp[] = [
  /(^|[\\/])warp([\\/]|$)/i,
  /(^|[\\/])gr([\\/]|$)/i,
  /(^|[\\/])casimir([\\/]|$)/i,
];

const FILE_EXTENSIONS = new Set([".ts", ".tsx", ".json"]);
const DOC_EXTENSIONS = new Set([".md"]);
const SURFACE_SET = new Set<SeedSurface>([
  "client",
  "server",
  "shared",
  "modules",
  "docs",
  "warp",
]);

const DEFAULT_TIMEOUT_MS = Number(
  process.env.AGI_SEED_MINE_TIMEOUT_MS ?? 60000,
);
const DEFAULT_MIN_CLIENT_SHARE = 0.25;
const DEFAULT_MIN_MODULES_SHARE = 0.25;
const DEFAULT_MIN_DOCS_SHARE = 0.2;
const DEFAULT_MAX_DOCS_SHARE = 0.5;
const DEFAULT_MAX_SERVER_SHARE = 0.3;
const DEFAULT_PRECHECK_THRESHOLD = 0.2;
const DEFAULT_PRECHECK_LIMIT = 12;
const ALIGNMENT_RESOURCE_HINTS = ["docs/ethos/ideology.json", "task.md"];
const ALIGNMENT_STATEMENTS = [
  "Constraint-driven agents are the layer above LLMs; LLMs are not the source of mathematical truth.",
  "Start with a snapshot, compute derivatives, step it forward, enforce constraints, and verify.",
  "Noise generation, GR evolution, and belief graphs share derivative-driven evolution with constraint checks.",
];
const PANEL_ANALYSIS_CORE_HINTS = [
  "client/src/lib/proof-pack.ts",
  "client/src/hooks/useProofPack.ts",
  "client/src/hooks/useGrAssistantReport.ts",
  "client/src/lib/gr-assistant-report.ts",
  "server/helix-proof-pack.ts",
  "server/helix-core.ts",
  "server/gr/gr-assistant-adapter.ts",
  "server/gr/gr-evaluation.ts",
  "server/gr/gr-constraint-policy.ts",
  "server/gr/gr-constraint-network.ts",
  "server/skills/physics.gr.assistant.ts",
  "shared/curvature-proxy.ts",
  "shared/math-stage.ts",
];
const PANEL_ANALYSIS_SEEDS: SeedTemplate[] = [
  {
    surface: "client",
    path: "client/src/components/TimeDilationLatticePanel.tsx",
    goal:
      "Trace the end-to-end dataflow for the Time Dilation Lattice panel in {path}. Explain how GR assistant reports, proof pack metrics, and gate status are fetched, merged, and rendered. Call out warp-bubble invariants, proxy/stage flags, and the server routes/tools that supply them. Cite code and list 2 follow-up verification probes a coder agent should run.",
    tags: ["warp-bubble", "gr-assistant", "pipeline-proofs"],
    resourceHints: [
      "client/src/components/PipelineProofPanel.tsx",
      "client/src/components/WarpProofPanel.tsx",
      "server/routes.ts",
    ],
  },
  {
    surface: "client",
    path: "client/src/components/WarpProofPanel.tsx",
    goal:
      "Explain how the Warp Proof panel in {path} maps proof-pack fields to UI copy and guardrails. Identify which proof keys are treated as proxy/staged, how gating is surfaced, and how this panel relates to warp bubble viability. Cite code and propose two prompt variants that would stress these guardrails.",
    tags: ["warp-bubble", "pipeline-proofs", "guardrails"],
    resourceHints: ["client/src/components/FrontProofsLedger.tsx"],
  },
  {
    surface: "client",
    path: "client/src/components/DriveGuardsPanel.tsx",
    goal:
      "Walk through the Drive Guards panel in {path}. Which proof-pack values drive each guardrail row, and how are proxy/stage flags rendered? Trace any crossovers to GR/warp constraints and cite the code paths. End with a short checklist a coder agent should verify when guardrails change.",
    tags: ["pipeline-proofs", "guardrails", "ui-surface"],
    resourceHints: [
      "client/src/lib/proof-pack.ts",
      "client/src/lib/proof-pack.ts",
    ],
  },
  {
    surface: "client",
    path: "client/src/components/PipelineProofPanel.tsx",
    goal:
      "Summarize how the Pipeline Proof panel in {path} stitches together proof-pack data, lattice diagnostics, and sub-panels. Identify the proof surfaces it renders and how each surface is fed. Cite code and list two prompts that would exercise its cross-panel dependencies.",
    tags: ["pipeline-proofs", "ui-surface"],
    resourceHints: [
      "client/src/components/FrontProofsLedger.tsx",
      "client/src/components/TimeDilationLatticePanel.tsx",
    ],
  },
  {
    surface: "client",
    path: "client/src/components/FrontProofsLedger.tsx",
    goal:
      "Explain how the Front Proofs Ledger in {path} enumerates proof-pack values, formats units, and marks proxy/stage states. Cite code, then propose a quick validation prompt to confirm ledger values remain grounded.",
    tags: ["pipeline-proofs", "ui-surface"],
  },
  {
    surface: "client",
    path: "client/src/App.tsx",
    goal:
      "Trace how {path} redirects the legacy /helix-core URL to Desktop, then follow the live panel registry to identify proof and GR panel entry points. Cite the route and registry separately; do not treat the retired page shell as an active data source.",
    tags: ["ui-surface", "panel-registry"],
    resourceHints: ["client/src/pages/helix-core.panels.ts", "client/src/lib/desktop/panelRegistry.ts"],
  },
  {
    surface: "client",
    path: "client/src/pages/helix-core.panels.ts",
    goal:
      "Explain how panel definitions in {path} map to proof/GR UI surfaces. Identify panel IDs for warp/GR proofs and cite code. Provide one prompt that would validate panel routing changes.",
    tags: ["ui-surface", "panel-registry"],
  },
  {
    surface: "client",
    path: "client/src/components/results-panel.tsx",
    goal:
      "Summarize how {path} renders simulation outputs, retains downloads and logs, and separates simulation fields from authenticated NHM2 evidence. Cite code and suggest a prompt to validate output provenance.",
    tags: ["ui-surface", "pipeline-proofs"],
    resourceHints: ["client/src/components/Nhm2SolveStatePanel.tsx"],
  },
  {
    surface: "client",
    path: "client/src/pages/start.tsx",
    goal:
      "Describe how the start page in {path} surfaces pipeline proof panels and lattice diagnostics. Cite code and outline two prompts that test proof data rendering in this entrypoint.",
    tags: ["ui-surface", "pipeline-proofs"],
  },
  {
    surface: "client",
    path: "client/src/pages/mobile-start.tsx",
    goal:
      "Explain how mobile start in {path} exposes proof/lattice surfaces and how it differs from desktop routing. Cite code and list one prompt that validates mobile proof data wiring.",
    tags: ["ui-surface", "pipeline-proofs"],
  },
  {
    surface: "client",
    path: "client/src/hooks/useProofPack.ts",
    goal:
      "Trace how {path} fetches proof-pack data, caches it, and exposes proxy flags to UI panels. Cite code and suggest a prompt that validates proof pack refresh logic.",
    tags: ["pipeline-proofs", "dataflow"],
  },
  {
    surface: "client",
    path: "client/src/hooks/useGrAssistantReport.ts",
    goal:
      "Explain how {path} assembles GR assistant report requests from brick/hull data. Cite code and propose a prompt that validates request payloads and gate status propagation.",
    tags: ["gr-assistant", "dataflow"],
  },
  {
    surface: "client",
    path: "client/src/lib/proof-pack.ts",
    goal:
      "Summarize the proof-pack mapping logic in {path}. Identify how units, proxies, and derived values are calculated for UI panels. Cite code and propose a prompt to validate a derived metric.",
    tags: ["pipeline-proofs", "dataflow"],
  },
  {
    surface: "client",
    path: "client/src/lib/gr-assistant-report.ts",
    goal:
      "Trace how {path} fetches GR assistant reports and handles errors. Cite code and provide a prompt to validate error handling and retry behavior.",
    tags: ["gr-assistant", "dataflow"],
  },
  {
    surface: "server",
    path: "server/routes.ts",
    goal:
      "Identify the GR assistant and proof-pack routes in {path}. Trace how requests are routed into handlers and cite code. Suggest a prompt that verifies route contract stability.",
    tags: ["gr-assistant", "pipeline-proofs"],
  },
  {
    surface: "server",
    path: "server/helix-core.ts",
    goal:
      "Explain how {path} builds proof-pack responses and GR assistant reports, including trace emission. Cite code and list two prompts to validate server-side report assembly.",
    tags: ["pipeline-proofs", "gr-assistant"],
  },
  {
    surface: "client",
    path: "client/src/components/agi/essence.tsx",
    goal:
      "Locate where proof panels or GR-related surfaces are referenced in {path} and explain how they relate to the broader AGI console flow. Cite code and suggest a prompt that validates proof-panel navigation.",
    tags: ["ui-surface", "panel-registry"],
  },
  {
    surface: "server",
    path: "server/helix-proof-pack.ts",
    goal:
      "Explain how the proof pack is assembled in {path}. Trace input sources, unit conversions, proxy flags, and any gating decisions. Map the outputs back to the UI panels that render them. Cite code and list the two most critical invariants that should be regression-tested.",
    tags: ["pipeline-proofs", "warp-bubble"],
    resourceHints: [
      "client/src/lib/proof-pack.ts",
      "client/src/components/PipelineProofPanel.tsx",
    ],
  },
  {
    surface: "server",
    path: "server/gr/gr-assistant-adapter.ts",
    goal:
      "Trace the GR assistant report pipeline in {path}: how metric specs are built, how checks/invariants are computed, and how gate status is attached. Connect the report to TimeDilationLatticePanel rendering. Cite code and suggest a prompt that checks GR consistency flags.",
    tags: ["gr-assistant", "warp-bubble", "pipeline-proofs"],
    resourceHints: [
      "client/src/hooks/useGrAssistantReport.ts",
      "client/src/components/TimeDilationLatticePanel.tsx",
    ],
  },
  {
    surface: "server",
    path: "server/gr/gr-constraint-policy.ts",
    goal:
      "Summarize GR constraint gate policy in {path} and how it influences warp/GR proofs. Trace how constraint outputs are surfaced to proof-pack or GR assistant reports and cite code. Provide a prompt that checks gate status propagation into UI.",
    tags: ["gr-assistant", "guardrails", "pipeline-proofs"],
    resourceHints: [
      "server/gr/gr-evaluation.ts",
      "server/skills/physics.gr.grounding.ts",
      "client/src/components/TimeDilationLatticePanel.tsx",
    ],
  },
  {
    surface: "warp",
    path: "modules/warp/warp-module.ts",
    goal:
      "Trace the warp bubble math pipeline starting from {path}. Identify the key equations, inputs, and outputs that feed proof-pack values or UI diagnostics. Cite code and list two prompts that would verify those outputs against the proof panels.",
    tags: ["warp-bubble", "pipeline-proofs", "math"],
    resourceHints: [
      "modules/warp/natario-warp.ts",
      "modules/gr/gr-diagnostics.ts",
      "modules/gr/stress-energy.ts",
      "server/helix-proof-pack.ts",
    ],
  },
  {
    surface: "warp",
    path: "modules/gr/gr-diagnostics.ts",
    goal:
      "Explain the GR diagnostics in {path} and how they connect to warp bubble proofs or lattice panels. Cite the code paths, call out constraints, and propose a prompt that validates diagnostic outputs against proof-pack fields.",
    tags: ["warp-bubble", "pipeline-proofs", "math"],
    resourceHints: [
      "modules/gr/stress-energy-integrals.ts",
      "server/helix-proof-pack.ts",
      "client/src/components/TimeDilationLatticePanel.tsx",
    ],
  },
];
const BACKEND_ANALYSIS_CORE_HINTS = [
  "server/helix-proof-pack.ts",
  "server/helix-core.ts",
  "server/routes.ts",
  "server/routes/agi.plan.ts",
  "server/routes/training-trace.ts",
  "server/services/agi/refinery-gates.ts",
  "server/services/agi/refinery-export.ts",
  "server/services/agi/refinery-policy.ts",
  "server/services/agi/refinery-summary.ts",
  "server/services/agi/refinery-trajectory.ts",
  "server/services/agi/refinery-variants.ts",
  "server/services/agi/refinery-identity.ts",
  "server/services/repo/repoGraph.ts",
  "server/skills/physics.gr.assistant.ts",
  "server/gr/gr-assistant-adapter.ts",
  "server/gr/gr-evaluation.ts",
  "server/gr/gr-constraint-policy.ts",
  "server/gr/gr-constraint-network.ts",
  "server/gr/gr-agent-loop.ts",
  "shared/agi-refinery.ts",
  "shared/schema.ts",
];
const BACKEND_ANALYSIS_SEEDS: SeedTemplate[] = [
  {
    surface: "server",
    path: "server/routes/agi.plan.ts",
    goal:
      "Explain the plan/execute pipeline in {path}, including tool routing, evidence capture, and gate enforcement. Trace how traces are emitted and how failure taxonomy is recorded. Cite code and list two backend prompts that would test this flow.",
    tags: ["plan-execute", "gates", "training-trace"],
  },
  {
    surface: "server",
    path: "server/routes/training-trace.ts",
    goal:
      "Trace how training traces are persisted and exported in {path}. Identify the schema fields required for refinery training data and where evidence hashes are attached. Cite code and propose a prompt that verifies trace integrity.",
    tags: ["training-trace", "exports"],
  },
  {
    surface: "server",
    path: "server/services/agi/refinery-gates.ts",
    goal:
      "Explain the refinery gate suite in {path} and how groundedness, safety, schema, and execution checks are computed. Identify which gates should apply to GR/warp outputs and cite code. End with a checklist for updating gate logic safely.",
    tags: ["gates", "grounding", "safety"],
  },
  {
    surface: "server",
    path: "server/services/agi/refinery-export.ts",
    goal:
      "Describe how training datasets are exported in {path}. Trace alpha targets, variant reservoir usage, and DPO pair generation. Cite code and list one prompt that would validate export metadata.",
    tags: ["export", "mixture-governor"],
  },
  {
    surface: "server",
    path: "server/services/repo/repoGraph.ts",
    goal:
      "Summarize retrieval and ranking in {path}. Explain how evidence candidates are gathered, diversified, and normalized. Cite code and propose a prompt to validate candidateRecall vs selectedRecall.",
    tags: ["retrieval", "evidence"],
  },
  {
    surface: "server",
    path: "server/helix-proof-pack.ts",
    goal:
      "Explain how proof-pack values are derived and tagged in {path}. Trace any unit conversions, proxy flags, and guardrails that affect warp bubble proofs. Cite code and describe how proof-pack outputs surface in UI panels.",
    tags: ["proof-pack", "warp-bubble"],
  },
  {
    surface: "server",
    path: "server/skills/physics.gr.assistant.ts",
    goal:
      "Trace how the GR assistant tool proxy in {path} calls FastAPI, attaches gate status, and records training traces. Cite code and list two prompts that check GR gate propagation to UI.",
    tags: ["gr-assistant", "gates"],
  },
  {
    surface: "server",
    path: "server/gr/gr-constraint-network.ts",
    goal:
      "Explain the GR constraint network in {path}. Identify how constraint residuals are aggregated and reported, and how failures propagate to gate status. Cite code and suggest a prompt to validate constraint reporting.",
    tags: ["gr-constraints", "gates"],
  },
  {
    surface: "shared",
    path: "shared/agi-refinery.ts",
    goal:
      "Describe the shared refinery schema in {path}, including trajectory fields, gate summaries, and axis tags. Cite code and explain how these fields support training and evaluation.",
    tags: ["schema", "training-data"],
  },
  {
    surface: "warp",
    path: "modules/warp/natario-warp.ts",
    goal:
      "Summarize the Natario warp implementation in {path} and how its outputs feed constraint checks or proof-pack values. Cite code and list two prompts that check warp-bubble invariants.",
    tags: ["warp-bubble", "math"],
  },
  {
    surface: "warp",
    path: "modules/gr/stress-energy-integrals.ts",
    goal:
      "Explain stress-energy integral computations in {path}. Trace how results are used in warp/GR diagnostics and proof-pack metrics. Cite code and propose a prompt to validate any unit assumptions.",
    tags: ["warp-bubble", "math", "stress-energy"],
  },
  {
    surface: "server",
    path: "server/services/agi/refinery-policy.ts",
    goal:
      "Describe the refinery policy logic in {path}: sampling weights, quotas, and throttling behavior. Cite code and suggest a prompt that verifies surface quota enforcement.",
    tags: ["policy", "mixture-governor"],
  },
  {
    surface: "server",
    path: "server/services/agi/refinery-summary.ts",
    goal:
      "Explain how refinery summaries are computed in {path}. Identify which metrics are emitted for alpha, acceptance, and coverage slices. Cite code and propose a prompt that checks summary correctness.",
    tags: ["metrics", "coverage"],
  },
  {
    surface: "server",
    path: "server/services/agi/refinery-holdout.ts",
    goal:
      "Summarize holdout construction in {path}. Trace how coverage slices are balanced and how gold evidence is tracked. Cite code and propose a prompt that validates holdout selection logic.",
    tags: ["holdout", "coverage"],
  },
  {
    surface: "server",
    path: "server/services/agi/refinery-identity.ts",
    goal:
      "Explain evidence identity normalization in {path} and how it affects retrieval, gates, and holdout evaluation. Cite code and suggest a prompt that checks normalization edge cases.",
    tags: ["evidence", "normalization"],
  },
  {
    surface: "server",
    path: "server/services/agi/refinery-variants.ts",
    goal:
      "Trace how variants are generated in {path}, including operator selection and reservoir banking. Cite code and propose a prompt that verifies variant tagging.",
    tags: ["variants", "mixture-governor"],
  },
  {
    surface: "server",
    path: "server/gr/gr-evaluation.ts",
    goal:
      "Explain GR evaluation in {path}, including constraint aggregation and certificate handling. Cite code and provide a prompt that checks gate propagation to reports.",
    tags: ["gr-assistant", "gates"],
  },
  {
    surface: "server",
    path: "server/gr/gr-constraint-policy.ts",
    goal:
      "Summarize GR constraint policy in {path}, including thresholds and hard/soft rules. Cite code and propose a prompt that validates policy application.",
    tags: ["gr-constraints", "policy"],
  },
  {
    surface: "server",
    path: "server/gr/gr-worker.ts",
    goal:
      "Trace how the GR worker in {path} executes GR jobs and reports results. Cite code and suggest a prompt that verifies worker outputs connect to proof panels.",
    tags: ["gr-assistant", "worker"],
  },
  {
    surface: "warp",
    path: "modules/gr/bssn-evolve.ts",
    goal:
      "Explain the BSSN evolution steps in {path} and how outputs feed diagnostics or constraint checks. Cite code and list a prompt that validates these outputs in proof-pack metrics.",
    tags: ["warp-bubble", "math", "bssn"],
  },
  {
    surface: "shared",
    path: "shared/schema.ts",
    goal:
      "Describe the shared schema in {path} relevant to proof-pack and GR assistant responses. Cite code and propose a prompt that verifies schema alignment between server and client.",
    tags: ["schema", "contracts"],
  },
];

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const fetchWithTimeout = async (
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const parseSurfaceList = (value?: string): SeedSurface[] | undefined => {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const surfaces = items.filter((item) =>
    SURFACE_SET.has(item as SeedSurface),
  ) as SeedSurface[];
  if (surfaces.length === 0) return undefined;
  return Array.from(new Set(surfaces));
};

const parseArgs = (): SeedArgs => {
  const args = process.argv.slice(2);
  const out: SeedArgs = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--base-url") {
      out.baseUrl = args[i + 1];
      i += 1;
    } else if (token === "--run") {
      out.run = true;
    } else if (token === "--limit") {
      out.limit = Number(args[i + 1]);
      i += 1;
    } else if (token === "--per-surface") {
      out.perSurface = Number(args[i + 1]);
      i += 1;
    } else if (token === "--alignment") {
      out.alignment = true;
    } else if (token === "--alignment-only") {
      out.alignmentOnly = true;
    } else if (token === "--panel-analysis") {
      out.panelAnalysis = true;
    } else if (token === "--panel-analysis-only") {
      out.panelAnalysisOnly = true;
    } else if (token === "--backend-analysis") {
      out.backendAnalysis = true;
    } else if (token === "--backend-analysis-only") {
      out.backendAnalysisOnly = true;
    } else if (token === "--out") {
      out.outPath = args[i + 1];
      i += 1;
    } else if (token === "--sleep-ms") {
      out.sleepMs = Number(args[i + 1]);
      i += 1;
    } else if (token === "--timeout-ms") {
      out.timeoutMs = Number(args[i + 1]);
      i += 1;
    } else if (token === "--include-docs") {
      out.includeDocs = true;
    } else if (token === "--include-warp") {
      out.includeWarp = true;
    } else if (token === "--surface") {
      out.surfaces = parseSurfaceList(args[i + 1]);
      i += 1;
    } else if (token === "--max-docs-share") {
      out.maxDocsShare = Number(args[i + 1]);
      i += 1;
    } else if (token === "--min-client-share") {
      out.minClientShare = Number(args[i + 1]);
      i += 1;
    } else if (token === "--min-modules-share") {
      out.minModulesShare = Number(args[i + 1]);
      i += 1;
    } else if (token === "--min-docs-share") {
      out.minDocsShare = Number(args[i + 1]);
      i += 1;
    } else if (token === "--max-server-share") {
      out.maxServerShare = Number(args[i + 1]);
      i += 1;
    } else if (token === "--precheck-threshold") {
      out.precheckThreshold = Number(args[i + 1]);
      i += 1;
    } else if (token === "--precheck-limit") {
      out.precheckLimit = Number(args[i + 1]);
      i += 1;
    } else if (token === "--no-precheck") {
      out.precheck = false;
    } else if (token === "--essence-console") {
      out.essenceConsole = true;
    }
  }
  return out;
};

const normalizePath = (value: string): string => value.replace(/\\/g, "/");

const toRepoPath = (root: string, filePath: string): string =>
  normalizePath(path.relative(root, filePath));

const fillPromptTemplate = (template: string, filePath: string): string =>
  template.replace(/\{path\}/g, filePath);

const uniqueHints = (hints: string[]): string[] =>
  Array.from(new Set(hints.map(normalizePath)));

const isExcludedPath = (filePath: string, includeWarp: boolean): boolean =>
  !includeWarp && WARP_EXCLUDE_PATHS.some((pattern) => pattern.test(filePath));

const shouldSkipDir = (dirName: string): boolean =>
  EXCLUDE_DIRS.has(dirName);

const collectFiles = async (
  root: string,
  allowDocs: boolean,
  includeWarp: boolean,
): Promise<string[]> => {
  const output: string[] = [];
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const resolved = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) {
          queue.push(resolved);
        }
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!FILE_EXTENSIONS.has(ext) && !(allowDocs && DOC_EXTENSIONS.has(ext))) {
        continue;
      }
      const normalized = normalizePath(resolved);
      if (isExcludedPath(normalized, includeWarp)) continue;
      output.push(normalized);
    }
  }
  return output;
};

const shuffle = <T>(items: T[]): T[] => {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

const initSurfaceCounts = (): Record<SeedSurface, number> => ({
  client: 0,
  server: 0,
  shared: 0,
  modules: 0,
  docs: 0,
  warp: 0,
});

const countBySurface = (seeds: SeedRequest[]): Record<SeedSurface, number> => {
  const counts = initSurfaceCounts();
  for (const seed of seeds) {
    counts[seed.surface] += 1;
  }
  return counts;
};

const clampShare = (value: number | undefined, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value ?? fallback));
};

const buildSeedPools = (
  seeds: SeedRequest[],
): Map<SeedSurface, SeedRequest[]> => {
  const pools = new Map<SeedSurface, SeedRequest[]>();
  for (const seed of seeds) {
    const existing = pools.get(seed.surface) ?? [];
    existing.push(seed);
    pools.set(seed.surface, existing);
  }
  for (const [surface, items] of pools) {
    pools.set(surface, shuffle(items));
  }
  return pools;
};

const trimMinCounts = (
  counts: Record<SeedSurface, number>,
  surfaces: SeedSurface[],
  targetTotal: number,
): Record<SeedSurface, number> => {
  const adjusted = { ...counts };
  let total = surfaces.reduce((sum, surface) => sum + adjusted[surface], 0);
  if (total <= targetTotal) return adjusted;
  let over = total - targetTotal;
  while (over > 0) {
    let bestSurface = surfaces[0];
    for (const surface of surfaces) {
      if (adjusted[surface] > adjusted[bestSurface]) {
        bestSurface = surface;
      }
    }
    if (adjusted[bestSurface] <= 0) break;
    adjusted[bestSurface] -= 1;
    total -= 1;
    over -= 1;
  }
  return adjusted;
};

const matchPath = (seedPath: string, hitPath?: string): boolean => {
  if (!hitPath) return false;
  return (
    hitPath === seedPath ||
    hitPath.endsWith(seedPath) ||
    seedPath.endsWith(hitPath)
  );
};

const buildPathQueries = (value: string): string[] => {
  const normalized = value.trim();
  if (!normalized) return [];
  const parsed = path.posix.parse(normalized);
  const queries = new Set<string>();
  queries.add(normalized);
  if (parsed.base) queries.add(parsed.base);
  if (parsed.name) queries.add(parsed.name);
  return Array.from(queries);
};

const buildPromptForFile = (filePath: string, surface: SeedSurface): string => {
  if (surface === "warp") {
    return `Explain the warp/GR module in ${filePath} and its role in the pipeline. Cite code.`;
  }
  if (surface === "server") {
    if (filePath.includes("/server/routes/")) {
      return `Summarize the endpoints in ${filePath} and how requests are handled. Cite code.`;
    }
    if (filePath.includes("/server/services/")) {
      return `Explain what ${filePath} does and its key exports. Cite code.`;
    }
    if (filePath.includes("/server/db/")) {
      return `Describe the schema or queries in ${filePath} and where they are used. Cite code.`;
    }
  }
  if (surface === "client") {
    if (filePath.includes("/client/src/components/")) {
      return `Explain the component in ${filePath}, its props, and where it is used. Cite code.`;
    }
    if (filePath.includes("/client/src/pages/")) {
      return `Summarize the page in ${filePath} and its role in the UI. Cite code.`;
    }
    if (filePath.includes("/client/src/store/")) {
      return `Explain the store in ${filePath} and how it is consumed. Cite code.`;
    }
    if (filePath.includes("/client/src/lib/")) {
      return `Explain the utilities in ${filePath} and where they are called. Cite code.`;
    }
  }
  if (surface === "shared") {
    return `Describe the schemas/types in ${filePath} and where they are used. Cite code.`;
  }
  if (surface === "modules") {
    return `Explain the module in ${filePath}, its exports, and where it is used. Cite code.`;
  }
  if (surface === "docs") {
    return `Summarize the document ${filePath} and link it to relevant code references.`;
  }
  return `Summarize ${filePath} and where it is used. Cite code.`;
};

const buildCallSpec = (resourceHints: string[], goal: string) => {
  if (!resourceHints || resourceHints.length === 0) return undefined;
  return {
    action: "call_remote",
    intent: ["repo_deep"],
    premise: goal,
    resourceHints: resourceHints.map((pathHint) => ({
      type: "repo_file",
      path: pathHint,
    })),
  };
};

const buildSeeds = (
  surface: SeedSurface,
  files: string[],
  count: number,
  root: string,
): SeedRequest[] => {
  const picks = shuffle(files).slice(0, count);
  return picks.map((filePath) => {
    const repoPath = toRepoPath(root, filePath);
    return {
      goal: buildPromptForFile(repoPath, surface),
      surface,
      path: repoPath,
      resourceHints: [repoPath],
      tags: ["seed", `surface:${surface}`],
      summaryFocus: "repo",
    };
  });
};

const buildAlignmentPromptForFile = (
  filePath: string,
  statement: string,
): string =>
  `Assess whether this statement aligns with codebase values and the math/noise uncertainty philosophy + physics parallels. Statement: "${statement}" Relate it to ${filePath} and cite ideology node paths plus relevant code.`;

const buildAlignmentSeeds = (
  surface: SeedSurface,
  files: string[],
  count: number,
  root: string,
): SeedRequest[] => {
  const picks = shuffle(files).slice(0, count);
  return picks.map((filePath, index) => {
    const repoPath = toRepoPath(root, filePath);
    const statement = ALIGNMENT_STATEMENTS[index % ALIGNMENT_STATEMENTS.length];
    const resourceHints = Array.from(
      new Set([repoPath, ...ALIGNMENT_RESOURCE_HINTS]),
    );
    return {
      goal: buildAlignmentPromptForFile(repoPath, statement),
      surface,
      path: repoPath,
      resourceHints,
      tags: [
        "seed",
        "alignment",
        "values",
        "uncertainty",
        "math",
        "physics",
        `surface:${surface}`,
      ],
      summaryFocus: "alignment",
    };
  });
};

const buildPanelAnalysisSeeds = (
  includeWarp: boolean,
  surfaceFilter?: Set<SeedSurface>,
): SeedRequest[] => {
  return PANEL_ANALYSIS_SEEDS.filter((seed) => {
    if (!includeWarp && seed.surface === "warp") return false;
    if (surfaceFilter && surfaceFilter.size > 0) {
      return surfaceFilter.has(seed.surface);
    }
    return true;
  }).map((seed) => {
    const repoPath = normalizePath(seed.path);
    const resourceHints = uniqueHints([
      repoPath,
      ...PANEL_ANALYSIS_CORE_HINTS,
      ...(seed.resourceHints ?? []),
    ]);
    return {
      goal: fillPromptTemplate(seed.goal, repoPath),
      surface: seed.surface,
      path: repoPath,
      resourceHints,
      tags: [
        "seed",
        "panel-analysis",
        "ui-surface",
        "pipeline-proofs",
        ...(seed.tags ?? []),
        `surface:${seed.surface}`,
      ],
      summaryFocus: seed.summaryFocus ?? "panel-analysis",
    };
  });
};

const buildBackendAnalysisSeeds = (
  includeWarp: boolean,
  surfaceFilter?: Set<SeedSurface>,
): SeedRequest[] => {
  return BACKEND_ANALYSIS_SEEDS.filter((seed) => {
    if (!includeWarp && seed.surface === "warp") return false;
    if (surfaceFilter && surfaceFilter.size > 0) {
      return surfaceFilter.has(seed.surface);
    }
    return true;
  }).map((seed) => {
    const repoPath = normalizePath(seed.path);
    const resourceHints = uniqueHints([
      repoPath,
      ...BACKEND_ANALYSIS_CORE_HINTS,
      ...(seed.resourceHints ?? []),
    ]);
    return {
      goal: fillPromptTemplate(seed.goal, repoPath),
      surface: seed.surface,
      path: repoPath,
      resourceHints,
      tags: [
        "seed",
        "backend-analysis",
        "pipeline-proofs",
        "warp-bubble",
        ...(seed.tags ?? []),
        `surface:${seed.surface}`,
      ],
      summaryFocus: seed.summaryFocus ?? "backend-analysis",
    };
  });
};

const precheckSeeds = async (
  seeds: SeedRequest[],
  root: string,
  threshold: number,
  limit: number,
): Promise<PrecheckSummary> => {
  const attemptsBySurface = initSurfaceCounts();
  const anchorsWithCandidates = initSurfaceCounts();
  const failuresBySurface = initSurfaceCounts();
  const eligible: SeedRequest[] = [];
  let errorCount = 0;
  for (const seed of seeds) {
    attemptsBySurface[seed.surface] += 1;
    try {
      const normalizedSeed =
        normalizeEvidenceRef(seed.path, { repoRoot: root }) ?? seed.path;
      let matchedPath = false;
      let maxScore = 0;
      const queries = buildPathQueries(seed.path);
      for (const query of queries) {
        const results = await searchRepoGraph({ query, limit });
        const hits = results.hits ?? [];
        for (const hit of hits) {
          if (typeof hit.score === "number" && hit.score > maxScore) {
            maxScore = hit.score;
          }
          const hitPath = normalizeEvidenceRef(hit.path ?? hit.file_path, {
            repoRoot: root,
          });
          if (matchPath(normalizedSeed, hitPath)) {
            matchedPath = true;
            break;
          }
        }
        if (matchedPath) break;
      }
      if (matchedPath || maxScore >= threshold) {
        anchorsWithCandidates[seed.surface] += 1;
        eligible.push(seed);
      } else {
        failuresBySurface[seed.surface] += 1;
      }
    } catch (error) {
      failuresBySurface[seed.surface] += 1;
      errorCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[agi-seed-mine] precheck failed", seed.path, message);
    }
  }
  return {
    eligible,
    anchorsWithCandidates,
    attemptsBySurface,
    failuresBySurface,
    errorCount,
  };
};

async function main() {
  const args = parseArgs();
  const surfaceFilter = new Set(args.surfaces ?? []);
  const perSurface = Number.isFinite(args.perSurface)
    ? Math.max(1, Math.floor(args.perSurface ?? 0))
    : 10;
  const includeDocs = args.includeDocs === true || surfaceFilter.has("docs");
  const includeWarp = args.includeWarp === true || surfaceFilter.has("warp");
  const alignmentOnly = args.alignmentOnly === true;
  const panelAnalysisOnly = args.panelAnalysisOnly === true;
  const backendAnalysisOnly = args.backendAnalysisOnly === true;
  const includeAlignment = args.alignment === true || alignmentOnly;
  const includePanelAnalysis = args.panelAnalysis === true || panelAnalysisOnly;
  const includeBackendAnalysis =
    args.backendAnalysis === true || backendAnalysisOnly;
  const includeBaseSeeds =
    !alignmentOnly && !panelAnalysisOnly && !backendAnalysisOnly;
  const precheckEnabled = args.precheck !== false;
  const precheckThreshold = Number.isFinite(args.precheckThreshold)
    ? Math.max(0, args.precheckThreshold ?? 0)
    : DEFAULT_PRECHECK_THRESHOLD;
  const precheckLimit = Number.isFinite(args.precheckLimit)
    ? Math.max(3, Math.floor(args.precheckLimit ?? 0))
    : DEFAULT_PRECHECK_LIMIT;
  const root = process.cwd();
  let surfaces: Array<[SeedSurface, string]> = [
    ["client", path.join(root, "client", "src")],
    ["server", path.join(root, "server")],
    ["shared", path.join(root, "shared")],
    ["modules", path.join(root, "modules")],
  ];
  if (includeWarp) {
    surfaces.push(["warp", path.join(root, "modules", "warp")]);
    surfaces.push(["warp", path.join(root, "modules", "gr")]);
  }
  if (includeDocs) {
    surfaces.push(["docs", path.join(root, "docs")]);
  }
  if (surfaceFilter.size > 0) {
    surfaces = surfaces.filter(([surface]) => surfaceFilter.has(surface));
    if (surfaces.length === 0) {
      console.error("[agi-seed-mine] no matching surfaces for --surface");
      process.exit(1);
    }
  }

  const includedSurfaces = new Set(surfaces.map(([surface]) => surface));
  let minClientShare = includedSurfaces.has("client")
    ? clampShare(args.minClientShare, DEFAULT_MIN_CLIENT_SHARE)
    : 0;
  let minModulesShare = includedSurfaces.has("modules")
    ? clampShare(args.minModulesShare, DEFAULT_MIN_MODULES_SHARE)
    : 0;
  let minDocsShare = includedSurfaces.has("docs")
    ? clampShare(args.minDocsShare, DEFAULT_MIN_DOCS_SHARE)
    : 0;
  let maxDocsShare = includedSurfaces.has("docs")
    ? clampShare(args.maxDocsShare, DEFAULT_MAX_DOCS_SHARE)
    : 0;
  let maxServerShare = includedSurfaces.has("server")
    ? clampShare(args.maxServerShare, DEFAULT_MAX_SERVER_SHARE)
    : 0;
  if (panelAnalysisOnly || backendAnalysisOnly) {
    minClientShare = 0;
    minModulesShare = 0;
    minDocsShare = 0;
    maxDocsShare = 1;
    maxServerShare = 1;
  }
  const minShareTotal = minClientShare + minModulesShare + minDocsShare;
  if (minShareTotal > 1) {
    const scale = 1 / minShareTotal;
    minClientShare *= scale;
    minModulesShare *= scale;
    minDocsShare *= scale;
    console.warn(
      "[agi-seed-mine] min share totals exceed 1.0; scaling down",
    );
  }
  if (maxDocsShare < minDocsShare) {
    console.warn("[agi-seed-mine] maxDocsShare < minDocsShare; bumping maxDocsShare");
    maxDocsShare = minDocsShare;
  }

  const seeds: SeedRequest[] = [];
  for (const [surface, dir] of surfaces) {
    if (!includeBaseSeeds && !includeAlignment) continue;
    const files = await collectFiles(dir, surface === "docs", includeWarp);
    if (includeBaseSeeds) {
      seeds.push(...buildSeeds(surface, files, perSurface, root));
    }
    if (includeAlignment) {
      seeds.push(...buildAlignmentSeeds(surface, files, perSurface, root));
    }
  }
  if (includePanelAnalysis) {
    seeds.push(...buildPanelAnalysisSeeds(includeWarp, surfaceFilter));
  }
  if (includeBackendAnalysis) {
    seeds.push(...buildBackendAnalysisSeeds(includeWarp, surfaceFilter));
  }

  const precheckSummary = precheckEnabled
    ? await precheckSeeds(seeds, root, precheckThreshold, precheckLimit)
    : {
        eligible: seeds,
        anchorsWithCandidates: countBySurface(seeds),
        attemptsBySurface: initSurfaceCounts(),
        failuresBySurface: initSurfaceCounts(),
        errorCount: 0,
      };
  const eligibleSeeds = precheckSummary.eligible;
  const limit =
    Number.isFinite(args.limit) && args.limit ? Math.max(1, args.limit) : undefined;
  const requestedTotal = limit ?? seeds.length;
  const targetTotal = Math.min(requestedTotal, eligibleSeeds.length);
  if (eligibleSeeds.length < requestedTotal) {
    console.warn(
      "[agi-seed-mine] eligible seeds below requested limit",
      eligibleSeeds.length,
      requestedTotal,
    );
  }

  const minCountsRaw = {
    client: Math.ceil(minClientShare * targetTotal),
    server: 0,
    shared: 0,
    modules: Math.ceil(minModulesShare * targetTotal),
    docs: Math.ceil(minDocsShare * targetTotal),
    warp: 0,
  };
  const minCounts = trimMinCounts(
    minCountsRaw,
    ["client", "modules", "docs"],
    targetTotal,
  );
  if (
    minCounts.client !== minCountsRaw.client ||
    minCounts.modules !== minCountsRaw.modules ||
    minCounts.docs !== minCountsRaw.docs
  ) {
    console.warn("[agi-seed-mine] min counts trimmed to fit target total");
  }
  const minClientCount = minCounts.client;
  const minModulesCount = minCounts.modules;
  const minDocsCount = minCounts.docs;
  let maxDocsCount = Math.floor(maxDocsShare * targetTotal);
  if (maxDocsCount < minDocsCount) {
    console.warn("[agi-seed-mine] maxDocsCount below minDocsCount; bumping cap");
    maxDocsCount = minDocsCount;
  }
  const maxServerCount = Math.floor(maxServerShare * targetTotal);

  const pools = buildSeedPools(eligibleSeeds);
  const selected: SeedRequest[] = [];
  const selectedBySurface = initSurfaceCounts();
  const minShortfalls = initSurfaceCounts();
  const takeFromPool = (surface: SeedSurface, count: number) => {
    if (count <= 0) return;
    const pool = pools.get(surface) ?? [];
    const picked = pool.splice(0, count);
    pools.set(surface, pool);
    selected.push(...picked);
    selectedBySurface[surface] += picked.length;
    const shortfall = count - picked.length;
    if (shortfall > 0) {
      minShortfalls[surface] += shortfall;
    }
  };
  takeFromPool("client", minClientCount);
  takeFromPool("modules", minModulesCount);
  takeFromPool("docs", minDocsCount);

  const caps = new Map<SeedSurface, number>();
  if (includedSurfaces.has("server")) {
    caps.set("server", maxServerCount);
  }
  if (includedSurfaces.has("docs")) {
    caps.set("docs", maxDocsCount);
  }

  const remainingSeeds = shuffle(Array.from(pools.values()).flat());
  for (const seed of remainingSeeds) {
    if (selected.length >= targetTotal) break;
    const cap = caps.get(seed.surface);
    if (cap !== undefined && selectedBySurface[seed.surface] >= cap) {
      continue;
    }
    selected.push(seed);
    selectedBySurface[seed.surface] += 1;
  }
  const finalSeeds = shuffle(selected).slice(0, targetTotal);
  const unfilledSlots = Math.max(0, targetTotal - finalSeeds.length);
  if (unfilledSlots > 0) {
    console.warn("[agi-seed-mine] unable to fill all seed slots", unfilledSlots);
  }
  const outPath = args.outPath
    ? path.resolve(args.outPath)
    : resolveArtifactsPath("agi-seed-mine.json");
  const summaryPath = outPath.endsWith(".json")
    ? outPath.replace(/\.json$/i, ".summary.json")
    : `${outPath}.summary.json`;
  const anchorsBySurface = countBySurface(finalSeeds);
  const summaryBase = {
    outPath,
    summaryPath,
    run: Boolean(args.run),
    requestedTotal,
    targetTotal,
    candidates: seeds.length,
    eligible: eligibleSeeds.length,
    surfaces: Array.from(includedSurfaces),
    quotas: {
      minClientShare,
      minModulesShare,
      minDocsShare,
      maxServerShare,
      maxDocsShare,
      minCounts: {
        client: minClientCount,
        modules: minModulesCount,
        docs: minDocsCount,
      },
      maxCounts: {
        server: maxServerCount,
        docs: maxDocsCount,
      },
      minShortfalls: {
        client: minShortfalls.client,
        modules: minShortfalls.modules,
        docs: minShortfalls.docs,
      },
      unfilledSlots,
    },
    anchors_by_surface: anchorsBySurface,
    anchors_with_candidates: precheckSummary.anchorsWithCandidates,
    precheck: precheckEnabled
      ? {
          enabled: true,
          threshold: precheckThreshold,
          limit: precheckLimit,
          attemptsBySurface: precheckSummary.attemptsBySurface,
          failuresBySurface: precheckSummary.failuresBySurface,
          errorCount: precheckSummary.errorCount,
        }
      : { enabled: false },
  };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(finalSeeds, null, 2), "utf8");
  await fs.writeFile(summaryPath, JSON.stringify(summaryBase, null, 2), "utf8");

  if (!args.run) {
    console.log(JSON.stringify(summaryBase, null, 2));
    return;
  }

  const baseUrl = args.baseUrl ?? "http://localhost:5173";
  const timeoutMs = Number.isFinite(args.timeoutMs)
    ? Math.max(1000, Math.floor(args.timeoutMs ?? 0))
    : DEFAULT_TIMEOUT_MS;
  let planned = 0;
  let executed = 0;
  for (const seed of finalSeeds) {
    planned += 1;
    let planRes: Response;
    try {
      planRes = await fetchWithTimeout(
        `${baseUrl}/api/agi/plan`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            goal: seed.goal,
            personaId: "default",
            knowledgeProjects: [],
            summaryFocus: seed.summaryFocus,
            call_spec: buildCallSpec(seed.resourceHints, seed.goal),
            refinery: { origin: "live", tags: seed.tags },
            essenceConsole: Boolean(args.essenceConsole),
          }),
        },
        timeoutMs,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[agi-seed-mine] plan request failed", message);
      continue;
    }
    if (!planRes.ok) {
      const message = await planRes.text();
      console.warn("[agi-seed-mine] plan failed", message);
      continue;
    }
    const planJson = await planRes.json();
    const traceId = planJson.traceId;
    if (!traceId) {
      console.warn("[agi-seed-mine] missing traceId");
      continue;
    }
    let execRes: Response;
    try {
      execRes = await fetchWithTimeout(
        `${baseUrl}/api/agi/execute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ traceId }),
        },
        timeoutMs,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[agi-seed-mine] execute request failed", message);
      continue;
    }
    if (!execRes.ok) {
      const message = await execRes.text();
      console.warn("[agi-seed-mine] execute failed", message);
      continue;
    }
    executed += 1;
    if (args.sleepMs) {
      await sleep(args.sleepMs);
    }
  }
  const summary = { ...summaryBase, run: true, planned, executed };
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
