import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { precheckHelixAskAvailability } from "./helix-ask-availability-precheck";

type PromptFamily = "relation" | "repo_technical" | "ambiguous_general";

type PromptCase = {
  id: string;
  family: PromptFamily;
  question: string;
  expected_intent_id?: string;
  expected_intent_domain?: string;
  expected_report_mode?: boolean;
  min_text_chars?: number;
};

type AskDebug = Record<string, unknown> & {
  intent_id?: string;
  intent_domain?: string;
  intent_strategy?: string;
  report_mode?: boolean;
  report_mode_reason?: string;
  relation_packet_built?: boolean;
  relation_dual_domain_ok?: boolean;
  relation_packet_bridge_count?: number;
  relation_packet_evidence_count?: number;
  live_events?: Array<Record<string, unknown>>;
  deterministic_fallback_used_relation?: boolean;
  contract_parse_fail_rate_relation?: number;
  citation_repair?: boolean;
  fallback_reason?: string;
  stage05_fallback_reason?: string | null;
  answer_fallback_reason?: string;
  answer_runtime_fallback_reason?: string;
  answer_short_fallback_reason?: string;
  agent_stop_reason?: string;
  controller_stop_reason?: string;
  answer_contract_primary_applied?: boolean;
  answer_contract_applied?: boolean;
  answer_token_budget?: number;
  stage_timing_ms?: Record<string, number>;
  timeline?: Array<Record<string, unknown>>;
  answer_path?: string[];
  objective_count?: number;
  objective_loop_state?: Array<Record<string, unknown>>;
  objective_retrieval_queries?: Array<Record<string, unknown>>;
  objective_mini_answers?: Array<Record<string, unknown>>;
  objective_mini_critic_mode?: string;
  objective_assembly_mode?: string;
  objective_finalize_gate_passed?: boolean;
  objective_finalize_gate_mode?: "strict_covered" | "unknown_terminal" | "blocked";
  objective_finalize_gate_unknown_terminal_eligible?: boolean;
  uncertainty_research_contract_required?: boolean;
  uncertainty_research_contract_pass?: boolean;
  uncertainty_research_contract_missing_reasons?: string[];
  uncertainty_research_contract_claim_tier?: string;
  uncertainty_research_contract_tier_coverage_pass?: boolean;
  uncertainty_research_contract_uncertainty_estimation_count?: number;
  uncertainty_research_contract_required_uncertainty_estimation?: boolean;
  uncertainty_research_contract_constraint_reference_count?: number;
  uncertainty_research_contract_proposal_reference_count?: number;
  semantic_repo_tech_contract_required?: boolean;
  semantic_repo_tech_contract_pass?: boolean;
  semantic_repo_tech_missing_reasons?: string[];
  claim_evidence_binding_pass?: boolean;
  claim_evidence_binding_missing?: string[];
  experimental_math_risk?: boolean;
  final_mode_gate_consistency_reasons?: string[];
};

type AskPayload = {
  text?: string;
  report_mode?: boolean;
  answer_surface_mode?: "conversational" | "structured_report" | "fail_closed";
  memory_citation?: {
    entries?: unknown[];
    rollout_ids?: string[];
  };
  debug?: AskDebug;
  error?: string;
  message?: string;
  retryAfterMs?: number;
};

type RawRun = {
  run_id: string;
  prompt_id: string;
  family: PromptFamily;
  question: string;
  seed: number;
  temperature: number;
  status: number;
  latency_ms: number;
  timestamp: string;
  expected_intent_id?: string;
  expected_intent_domain?: string;
  expected_report_mode?: boolean;
  response_text: string;
  debug: AskDebug | null;
  failures: string[];
  attempts?: number;
  stop_reason?: string;
  attempt_trace?: Array<{
    attempt: number;
    status: number;
    latency_ms: number;
    retry_after_ms: number;
    error?: string;
    message?: string;
  }>;
  diagnostics?: {
    report_mode_correct: boolean | null;
    relation_packet_built: boolean | null;
    relation_dual_domain_ok: boolean | null;
  };
  artifact_bundle_paths?: ArtifactBundlePaths;
};

type ArtifactBundlePaths = {
  output_root_dir: string;
  output_run_dir: string;
  summary: string;
  recommendation: string;
  failures: string;
  checkpoint: string;
  prompts: string;
  raw_dir: string;
  raw_record?: string;
  ab_outputs: string[];
  trace_export: string | null;
};

type FailureRecord = {
  key: string;
  count: number;
};

type GitProvenance = {
  branch: string | null;
  head: string | null;
  originMain: string | null;
  aheadBehind: string | null;
  hasOriginRemote: boolean;
  hasMainBranch: boolean;
};

type ProbabilitySnapshot = {
  pass: number;
  total: number;
  p: number;
  ci95: {
    low: number;
    high: number;
  };
};

const BASE_URL = process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:5050";
const OUT_DIR = process.env.HELIX_ASK_VERSATILITY_OUT ?? "artifacts/experiments/helix-ask-versatility";
const REPORT_PATH = process.env.HELIX_ASK_VERSATILITY_REPORT ?? "reports/helix-ask-versatility-report.md";
const PROMPT_ORDER_MODE = process.env.HELIX_ASK_VERSATILITY_PROMPT_ORDER_MODE ?? "sequential";
const PROMPT_SAMPLE_PER_FAMILY = Math.max(0, Number(process.env.HELIX_ASK_VERSATILITY_PROMPT_SAMPLE_PER_FAMILY ?? 0));
const ISOLATE_RUN_DIR = (process.env.HELIX_ASK_VERSATILITY_ISOLATE_RUN_DIR ?? "1") !== "0";
const RESUME_FROM_LATEST = (process.env.HELIX_ASK_VERSATILITY_RESUME_FROM_LATEST ?? "1") !== "0";
const FAIL_ON_INCOMPLETE = (process.env.HELIX_ASK_VERSATILITY_FAIL_ON_INCOMPLETE ?? "1") !== "0";
const SEEDS = (process.env.HELIX_ASK_VERSATILITY_SEEDS ?? "7,11,13")
  .split(",")
  .map((entry) => Number(entry.trim()))
  .filter((entry) => Number.isFinite(entry));
const TEMPS = (process.env.HELIX_ASK_VERSATILITY_TEMPS ?? "0.2")
  .split(",")
  .map((entry) => Number(entry.trim()))
  .filter((entry) => Number.isFinite(entry));
const START_SERVER = (process.env.HELIX_ASK_VERSATILITY_START_SERVER ?? "0") === "1";
const SERVER_COMMAND = process.env.HELIX_ASK_VERSATILITY_SERVER_CMD ?? "npm";
const DEFAULT_SERVER_ARGS = ["run", "dev:agi:5050"];
const SERVER_ARGS =
  process.env.HELIX_ASK_VERSATILITY_SERVER_ARGS?.split(/\s+/).filter(Boolean) ?? DEFAULT_SERVER_ARGS;
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.HELIX_ASK_VERSATILITY_TIMEOUT_MS ?? 45000));
const PRECHECK_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.HELIX_ASK_VERSATILITY_PRECHECK_TIMEOUT_MS ?? Math.min(10000, REQUEST_TIMEOUT_MS)),
);
const MIN_TEXT_CHARS = Number(process.env.HELIX_ASK_VERSATILITY_MIN_TEXT_CHARS ?? 220);
const MAX_RETRIES = Math.max(0, Number(process.env.HELIX_ASK_VERSATILITY_MAX_RETRIES ?? 3));
const RETRY_BASE_MS = Math.max(100, Number(process.env.HELIX_ASK_VERSATILITY_RETRY_BASE_MS ?? 900));
const RETRY_MAX_MS = Math.max(RETRY_BASE_MS, Number(process.env.HELIX_ASK_VERSATILITY_RETRY_MAX_MS ?? 12000));
const RETRY_AFTER_CAP_MS = Math.max(250, Number(process.env.HELIX_ASK_VERSATILITY_RETRY_AFTER_CAP_MS ?? 5000));
const RETRY_STUB = (process.env.HELIX_ASK_VERSATILITY_RETRY_STUB ?? "1") !== "0";
const DEFAULT_MAX_CASE_WALL_MS =
  REQUEST_TIMEOUT_MS * Math.max(1, Math.min(MAX_RETRIES + 1, 3)) + RETRY_MAX_MS;
const MAX_CASE_WALL_MS = Math.max(
  REQUEST_TIMEOUT_MS,
  Number(process.env.HELIX_ASK_VERSATILITY_MAX_CASE_WALL_MS ?? DEFAULT_MAX_CASE_WALL_MS),
);
const MAX_RUN_MS = Math.max(0, Number(process.env.HELIX_ASK_VERSATILITY_MAX_RUN_MS ?? 0));
const CHECKPOINT_EVERY = Math.max(1, Number(process.env.HELIX_ASK_VERSATILITY_CHECKPOINT_EVERY ?? 10));
const CIRCUIT_OPEN_MAX_RETRIES = Math.max(
  0,
  Number(process.env.HELIX_ASK_VERSATILITY_CIRCUIT_OPEN_MAX_RETRIES ?? 1),
);
const CIRCUIT_OPEN_RETRY_AFTER_CUTOFF_MS = Math.max(
  0,
  Number(process.env.HELIX_ASK_VERSATILITY_CIRCUIT_OPEN_RETRY_AFTER_CUTOFF_MS ?? 8000),
);
const GLOBAL_COOLDOWN_ON_CIRCUIT = (process.env.HELIX_ASK_VERSATILITY_GLOBAL_COOLDOWN_ON_CIRCUIT ?? "1") !== "0";
const GLOBAL_COOLDOWN_CAP_MS = Math.max(
  0,
  Number(process.env.HELIX_ASK_VERSATILITY_GLOBAL_COOLDOWN_CAP_MS ?? 30000),
);
const STUB_RE = /llm\.local stub result/i;
const REPORT_SECTION_RE = /(Executive summary:|Coverage map:|Point-by-point:|Report covers)/i;
const DEBUG_SCAFFOLD_LEAK_RE =
  /\b(?:traceid=ask:|timeline:timeline:|what_is_[a-z0-9_]+\b|how_they_connect\b|constraints_and_falsifiability\b|convergence snapshot\b|capsule guards\b|context sources\b|tree walk:\b|retry:\s*not applied\b)\b/i;
const CODE_FRAGMENT_SPILL_RE =
  /(?:export\s+default\s+function\s+[A-Za-z0-9_]+\s*\(|useState<[^>]+>\(|use[A-Z][A-Za-z0-9_]*\(\)\s*;\s*const)/i;
const ADAPTER_CONSTRAINT_POLICY_RE = /\bADAPTER_CONSTRAINT_POLICY\b/i;
const TOOL_USE_BUDGET_POLICY_RE = /\btool[-_\s]?use[-_\s]?budget\b/i;
const DIRECT_ANSWER_SECTION_RE = /(^|\n)\s*(direct answer|definition|answer)\s*:/i;
const WHERE_IN_REPO_SECTION_RE = /(^|\n)\s*(where in repo|how repo solves it|repo-grounded findings)\s*:/i;
const CONFIDENCE_UNCERTAINTY_SECTION_RE =
  /(^|\n)\s*(confidence(?:\s*\/\s*uncertainty)?|uncertainty(?:\s*\/\s*open gaps)?|open gaps|evidence gaps)\s*:/i;
const SOURCES_SECTION_RE = /(^|\n)\s*sources?:\s+\S+/i;
const TRACE_EXPORT_PATH = process.env.HELIX_ASK_TRACE_EXPORT_PATH?.trim() || null;
const AB_OUTPUT_PATHS = (process.env.HELIX_ASK_AB_OUTPUT_PATHS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const runCaseKey = (promptId: string, seed: number, temperature: number): string =>
  `${promptId}::s${seed}::t${temperature}`;

export const createArtifactBundlePaths = (args: {
  outRootDir: string;
  runOutDir: string;
  rawRecordPath?: string;
  traceExportPath?: string | null;
  abOutputPaths?: string[];
}): ArtifactBundlePaths => {
  const summary = path.resolve(args.runOutDir, "summary.json");
  const recommendation = path.resolve(args.runOutDir, "recommendation.json");
  const failures = path.resolve(args.runOutDir, "failures.json");
  const checkpoint = path.resolve(args.runOutDir, "checkpoint.json");
  const prompts = path.resolve(args.runOutDir, "prompts.jsonl");
  const raw_dir = path.resolve(args.runOutDir, "raw");
  return {
    output_root_dir: path.resolve(args.outRootDir),
    output_run_dir: path.resolve(args.runOutDir),
    summary,
    recommendation,
    failures,
    checkpoint,
    prompts,
    raw_dir,
    ...(args.rawRecordPath ? { raw_record: path.resolve(args.rawRecordPath) } : {}),
    ab_outputs: (args.abOutputPaths ?? []).map((entry) => path.resolve(entry)),
    trace_export: args.traceExportPath ? path.resolve(args.traceExportPath) : null,
  };
};

export const buildRunDiagnostics = (row: Pick<RawRun, "expected_report_mode" | "family" | "debug">): NonNullable<RawRun["diagnostics"]> => ({
  report_mode_correct:
    typeof row.expected_report_mode === "boolean" && typeof row.debug?.report_mode === "boolean"
      ? row.debug.report_mode === row.expected_report_mode
      : null,
  relation_packet_built:
    row.family === "relation" ? (row.debug?.relation_packet_built === true) : null,
  relation_dual_domain_ok:
    row.family === "relation" ? (row.debug?.relation_dual_domain_ok === true) : null,
});

const isRouteCorrect = (row: Pick<RawRun, "expected_intent_id" | "expected_intent_domain" | "debug">): boolean | null => {
  if (row.expected_intent_id) {
    return row.debug?.intent_id === row.expected_intent_id;
  }
  if (row.expected_intent_domain) {
    return row.debug?.intent_domain === row.expected_intent_domain;
  }
  return null;
};
const execGit = async (args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    execFile("git", args, { cwd: process.cwd(), timeout: 3000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const text = String(stdout ?? "").trim();
      resolve(text.length ? text : null);
    });
  });

const execGitOk = async (args: string[]): Promise<boolean> =>
  new Promise((resolve) => {
    execFile("git", args, { cwd: process.cwd(), timeout: 3000 }, (error) => {
      resolve(!error);
    });
  });

const collectGitProvenance = async (): Promise<GitProvenance> => {
  const [branch, head, originMain, remoteText] = await Promise.all([
    execGit(["branch", "--show-current"]),
    execGit(["rev-parse", "--short", "HEAD"]),
    execGit(["rev-parse", "--short", "origin/main"]),
    execGit(["remote"]),
  ]);
  const hasOriginRemote = Boolean(remoteText?.split(/\r?\n/).map((v) => v.trim()).filter(Boolean).includes("origin"));
  const hasMainBranch = await execGitOk(["show-ref", "--verify", "--quiet", "refs/heads/main"]);
  const aheadBehind = originMain && head ? await execGit(["rev-list", "--left-right", "--count", "origin/main...HEAD"]) : null;
  return {
    branch,
    head,
    originMain,
    aheadBehind,
    hasOriginRemote,
    hasMainBranch,
  };
};

const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const sleepInterruptible = async (ms: number, shouldStop: () => boolean): Promise<void> => {
  let remaining = Math.max(0, Math.floor(ms));
  while (remaining > 0) {
    if (shouldStop()) return;
    const slice = Math.min(250, remaining);
    await sleep(slice);
    remaining -= slice;
  }
};

const loadExistingRawRunMap = async (runOutDir: string): Promise<Map<string, RawRun>> => {
  const rawDir = path.resolve(runOutDir, "raw");
  const map = new Map<string, RawRun>();
  let files: string[] = [];
  try {
    files = await fs.readdir(rawDir);
  } catch {
    return map;
  }
  for (const name of files) {
    if (!name.toLowerCase().endsWith(".json")) continue;
    const record = await readJsonFile<RawRun>(path.resolve(rawDir, name));
    if (!record || !record.prompt_id || !Number.isFinite(record.seed) || !Number.isFinite(record.temperature)) {
      continue;
    }
    const key = runCaseKey(record.prompt_id, record.seed, record.temperature);
    const previous = map.get(key);
    if (!previous) {
      map.set(key, record);
      continue;
    }
    const prevTs = Date.parse(previous.timestamp || "");
    const nextTs = Date.parse(record.timestamp || "");
    if (Number.isFinite(nextTs) && (!Number.isFinite(prevTs) || nextTs >= prevTs)) {
      map.set(key, record);
    }
  }
  return map;
};

const mulberry32 = (seed: number): (() => number) => {
  let state = (seed >>> 0) + 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const stableSeedFrom = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const shuffleDeterministic = <T>(items: T[], seed: number): T[] => {
  const rng = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

const maybeApplyPromptSamplingAndOrder = (prompts: PromptCase[]): PromptCase[] => {
  if (PROMPT_ORDER_MODE === "sequential" && PROMPT_SAMPLE_PER_FAMILY <= 0) {
    return prompts;
  }
  const families: PromptFamily[] = ["relation", "repo_technical", "ambiguous_general"];
  const byFamily = new Map<PromptFamily, PromptCase[]>(
    families.map((family) => [family, prompts.filter((prompt) => prompt.family === family)]),
  );
  const sampledByFamily = new Map<PromptFamily, PromptCase[]>();
  for (const family of families) {
    const familyPrompts = byFamily.get(family) ?? [];
    if (PROMPT_SAMPLE_PER_FAMILY > 0) {
      const sampleSeed = stableSeedFrom(`${family}:${SEEDS.join(",")}:${TEMPS.join(",")}`);
      sampledByFamily.set(family, shuffleDeterministic(familyPrompts, sampleSeed).slice(0, PROMPT_SAMPLE_PER_FAMILY));
      continue;
    }
    sampledByFamily.set(family, [...familyPrompts]);
  }

  if (PROMPT_ORDER_MODE === "stratified_seeded") {
    const stratSeed = stableSeedFrom(`stratified:${SEEDS.join(",")}:${TEMPS.join(",")}`);
    const familiesOrder = shuffleDeterministic(families, stratSeed);
    for (const family of familiesOrder) {
      const familySeed = stableSeedFrom(`${family}:${stratSeed}`);
      sampledByFamily.set(
        family,
        shuffleDeterministic(sampledByFamily.get(family) ?? [], familySeed),
      );
    }
    const output: PromptCase[] = [];
    let index = 0;
    while (true) {
      let added = false;
      for (const family of familiesOrder) {
        const pool = sampledByFamily.get(family) ?? [];
        const next = pool[index];
        if (next) {
          output.push(next);
          added = true;
        }
      }
      if (!added) break;
      index += 1;
    }
    return output;
  }

  return families.flatMap((family) => sampledByFamily.get(family) ?? []);
};

const ensureServerReady = async (timeoutMs = 120000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(new URL("/api/ready", BASE_URL), { cache: "no-store" });
      if (response.status === 200) {
        const payload = (await response.json().catch(() => null)) as { ready?: boolean } | null;
        if (!payload || payload.ready !== false) return;
      }
    } catch {
      // retry
    }
    await sleep(1000);
  }
  await precheckHelixAskAvailability({
    baseUrl: BASE_URL,
    timeoutMs: Math.min(PRECHECK_TIMEOUT_MS, timeoutMs),
    label: "server readiness precheck",
  });
};

const startServer = async () => {
  const child = spawn(SERVER_COMMAND, SERVER_ARGS, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[versatility:server] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[versatility:server:err] ${chunk}`));
  await ensureServerReady();
  return child;
};

const stopServer = async (child: ReturnType<typeof spawn>) => {
  if (child.killed) return;
  child.kill("SIGINT");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolve();
    }, 10000);
  });
};

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);

const clampSessionId = (value: string): string => value.slice(0, 120);
const RETRYABLE_STATUS = new Set([0, 408, 429, 500, 502, 503, 504]);

const isCircuitOpenPayload = (payload: AskPayload): boolean => {
  const error = String(payload.error ?? "").toLowerCase();
  const message = String(payload.message ?? "").toLowerCase();
  if (error === "helix_ask_temporarily_unavailable") return true;
  return (
    message.includes("circuit") ||
    message.includes("temporarily unavailable") ||
    message.includes("cooldown")
  );
};

const writeCheckpoint = async (outDir: string, runId: string, rows: RawRun[]) => {
  const checkpoint = {
    run_id: runId,
    timestamp: new Date().toISOString(),
    completed_runs: rows.length,
    status_counts: rows.reduce<Record<string, number>>((acc, row) => {
      const key = String(row.status);
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    stop_reasons: rows.reduce<Record<string, number>>((acc, row) => {
      const key = row.stop_reason ?? "done";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  };
  await fs.writeFile(path.resolve(outDir, "checkpoint.json"), `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
};

export const toDiagnosticRollup = (rows: RawRun[]) => {
  const reportModeRows = rows.filter((row) => row.diagnostics?.report_mode_correct !== null);
  const relationPacketRows = rows.filter((row) => row.diagnostics?.relation_packet_built !== null);
  const relationDualRows = rows.filter((row) => row.diagnostics?.relation_dual_domain_ok !== null);
  return {
    report_mode_correct: {
      pass: reportModeRows.filter((row) => row.diagnostics?.report_mode_correct === true).length,
      fail: reportModeRows.filter((row) => row.diagnostics?.report_mode_correct === false).length,
      unknown: rows.length - reportModeRows.length,
    },
    relation_packet_built: {
      pass: relationPacketRows.filter((row) => row.diagnostics?.relation_packet_built === true).length,
      fail: relationPacketRows.filter((row) => row.diagnostics?.relation_packet_built === false).length,
      unknown: rows.length - relationPacketRows.length,
    },
    relation_dual_domain_ok: {
      pass: relationDualRows.filter((row) => row.diagnostics?.relation_dual_domain_ok === true).length,
      fail: relationDualRows.filter((row) => row.diagnostics?.relation_dual_domain_ok === false).length,
      unknown: rows.length - relationDualRows.length,
    },
  };
};

const circuitRetryAfterFromRawRun = (row: RawRun): number => {
  const trace = row.attempt_trace ?? [];
  if (!trace.length) return 0;
  const latest = trace[trace.length - 1];
  if (!latest) return 0;
  const error = String(latest.error ?? "").toLowerCase();
  const message = String(latest.message ?? "").toLowerCase();
  const isCircuit =
    error === "helix_ask_temporarily_unavailable" ||
    message.includes("circuit") ||
    message.includes("temporarily unavailable");
  if (!isCircuit) return 0;
  return Math.max(0, latest.retry_after_ms ?? 0);
};

const makeRelationPrompts = (): PromptCase[] => {
  const base = [
    "How does a warp bubble fit in with the mission ethos?",
    "Explain the relation between warp bubble physics and mission ethos in this repo.",
    "Warp bubble ↔ ideology relation: what is the bridge?",
    "How do we connect Natario warp bubble constraints to mission ethics?",
    "What's the relationship between warp bubble viability and ideology tree commitments?",
    "Relate warp bubble design gates to mission ethos safeguards.",
    "how warp bubble connected to mission ethos?",
    "warp buble relation to ideology mission ethos",
    "Quick: warp bubble vs mission ethos — connected or separate?",
    "Define warp bubble, define mission ethos, then connect them.",
    "In one clear narrative: why does mission ethos matter for warp bubble claims?",
    "How does the ideology tree constrain warp-bubble deployment decisions?",
    "Bridge warp physics evidence to ethos stewardship without report mode.",
    "What ties warp bubble verification to ethos non-harm policy?",
    "Explain warp bubble + mission ethos for a skeptical engineer.",
    "How is the warp bubble a technical layer while mission ethos is policy layer?",
    "relation of warp bubble and mission ethos now",
    "warp/ethos relation prompt test: explain links and guardrails",
    "How do certificate integrity and mission ethos cohere for warp bubble work?",
    "How does Casimir verification connect to ideology accountability in warp work?",
    "Need concise relation: warp bubble, mission ethos, evidence.",
    "Which shared constraints bind warp bubble engineering to ideology values?",
    "Compare and connect warp bubble viability gates with mission ethos gates.",
    "Could warp bubble progress violate mission ethos? How is that prevented?",
    "From docs perspective, how do warp bubble files and ethos files relate?",
    "Give a practical relation map from warp bubble model to mission ethos decisions.",
    "How does relation-mode answer tie warp bubble to ideology without report scaffolding?",
    "mission ethos + warp bubble, what's the dependency chain?",
    "Tell me the warp bubble relation to mission ethos in plain language.",
    "If warp bubble is capability, how does ethos govern its use?",
  ];
  return base.map((question, index) => ({
    id: `relation_${String(index + 1).padStart(2, "0")}_${slug(question)}`,
    family: "relation",
    question,
    expected_intent_id: "hybrid.warp_ethos_relation",
    expected_intent_domain: "hybrid",
    expected_report_mode: false,
    min_text_chars: MIN_TEXT_CHARS,
  }));
};

const makeRepoTechnicalPrompts = (): PromptCase[] => {
  const base = [
    "Walk through /api/agi/ask routing from intent detection to final answer cleanup.",
    "How does Helix Ask choose report mode vs hybrid explain mode?",
    "Where are relation packet fields built and surfaced in debug payload?",
    "Explain evidence gate flow and where citation repair is applied.",
    "How does deterministic fallback guard relation-mode contract parse failures?",
    "Describe how answer contract primary and field repair work in sequence.",
    "How are ambiguity gates triggered and what clarify output is produced?",
    "What does /api/agi/adapter/run return for PASS/FAIL and certificate data?",
    "Explain training-trace export path and expected payload behavior.",
    "How do topic tags influence intent directory routing for helix ask?",
    "Show pipeline stages captured in debug live events for Helix Ask.",
    "Where is relation topology dual-domain detection implemented?",
    "How does goal-zone harness evaluate pass/fail across seeds?",
    "What determines relation_packet_bridge_count and evidence_count?",
    "How does the system prevent report-scaffold responses for relation prompts?",
    "Where are citation allowlists normalized before sanitizeSourcesLine?",
    "Explain retrieval confidence and deterministic contract signal thresholds.",
    "How does fast quality mode alter answer generation deadlines?",
    "What are top fallback reasons emitted in debug for helix ask failures?",
    "How are source paths extracted from evidence text and context?",
    "Explain relation-assembly fallback rendering shape and intended usage.",
    "Where is helix ask intent directory mapping for warp+ethos relation?",
    "How does arbiter_mode get selected for repo vs hybrid asks?",
    "What files are considered high-signal for mission ethos reference intents?",
    "How does report_mode_reason get set and propagated to debug?",
    "Explain how answer_path is populated and useful for diagnostics.",
    "Where are claim coverage metrics computed and used as gates?",
    "How is platonic gate scoring attached to final response debug?",
    "What checks enforce presence of citations in repo/hybrid responses?",
    "Describe the interaction between relation query detection and graph resolver.",
    "Organize future Helix Ask work for profiles, paywall, voice lane, translation, and retrieval planning into a repo-grounded implementation roadmap.",
    "Map a multi-objective Helix Ask roadmap for API access, profiles, billing, voice lane, and translation without falling back to a generic five-section answer.",
  ];
  return base.map((question, index) => ({
    id: `repo_tech_${String(index + 1).padStart(2, "0")}_${slug(question)}`,
    family: "repo_technical",
    question,
    expected_intent_domain: "repo",
    expected_report_mode: false,
    min_text_chars: MIN_TEXT_CHARS,
  }));
};

const makeAmbiguousPrompts = (): PromptCase[] => {
  const base = [
    "Define lattice.",
    "What's a cavity?",
    "Explain resonance in simple terms.",
    "What is stability?",
    "How should I think about uncertainty?",
    "Help me compare precision and recall quickly.",
    "How do constraints help decision making?",
    "What's a good way to summarize evidence?",
    "Can you explain system integrity for non-experts?",
    "What is model drift?",
    "How do I ask better technical questions?",
    "What's a clean way to structure a short answer?",
    "How do I avoid overclaiming from weak data?",
    "What does falsifiable mean in practice?",
    "Difference between hypothesis and verified claim?",
    "How can ambiguity be reduced in prompts?",
    "When should I request citations?",
    "Explain feedback loops without jargon.",
    "What makes a good guardrail?",
    "How do I triage failures quickly?",
    "Give me a concise explanation of verification.",
    "How can teams avoid report-mode spam in assistants?",
    "What is a practical debug payload used for?",
    "How should I read latency percentiles?",
    "When is deterministic fallback preferable?",
    "How do seeds help evaluation reliability?",
    "What's a robust pass criterion for prompts?",
    "How can I identify high-impact failure categories?",
    "Explain why short prompts can confuse routing.",
    "What's the difference between routing and assembly?",
  ];
  return base.map((question, index) => ({
    id: `ambiguous_${String(index + 1).padStart(2, "0")}_${slug(question)}`,
    family: "ambiguous_general",
    question,
    expected_intent_domain: "general",
    expected_report_mode: false,
    min_text_chars: MIN_TEXT_CHARS,
  }));
};

const allPrompts = (): PromptCase[] => [
  ...makeRelationPrompts(),
  ...makeRepoTechnicalPrompts(),
  ...makeAmbiguousPrompts(),
];

const askOnce = async (entry: PromptCase, seed: number, temperature: number, runId: string) => {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(new URL("/api/agi/ask", BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        question: entry.question,
        debug: true,
        seed,
        temperature,
        verbosity: "extended",
        sessionId: clampSessionId(`versatility:${runId}:${entry.id}:s${seed}:t${temperature}`),
      }),
    });
    clearTimeout(timeout);
    const latencyMs = Date.now() - started;
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? ((await response.json()) as AskPayload)
      : ({ text: await response.text() } as AskPayload);
    return { status: response.status, latency_ms: latencyMs, payload };
  } catch (error) {
    clearTimeout(timeout);
    return {
      status: 0,
      latency_ms: Date.now() - started,
      payload: { text: error instanceof Error ? error.message : String(error) } as AskPayload,
    };
  }
};

const shouldRetryResponse = (
  response: Awaited<ReturnType<typeof askOnce>>,
  entry: PromptCase,
): boolean => {
  if (isCircuitOpenPayload(response.payload)) return true;
  if (RETRYABLE_STATUS.has(response.status)) return true;
  const text = String(response.payload.text ?? "");
  if (RETRY_STUB && STUB_RE.test(text) && entry.family !== "ambiguous_general") {
    return true;
  }
  return false;
};

const retryDelayMs = (
  response: Awaited<ReturnType<typeof askOnce>>,
  attempt: number,
): number => {
  const requestedRetry = Math.min(RETRY_AFTER_CAP_MS, Math.max(0, toNum(response.payload.retryAfterMs, 0)));
  const jitter = 0.9 + Math.random() * 0.2;
  const backoff = Math.min(RETRY_MAX_MS, Math.round(RETRY_BASE_MS * Math.max(1, 2 ** attempt) * jitter));
  return Math.max(requestedRetry, backoff);
};

const askWithRetry = async (
  entry: PromptCase,
  seed: number,
  temperature: number,
  runId: string,
  shouldAbort?: () => boolean,
) => {
  const begin = Date.now();
  let attempts = 0;
  let stopReason = "done";
  let circuitOpenRetries = 0;
  const attemptTrace: NonNullable<RawRun["attempt_trace"]> = [];
  let response = await askOnce(entry, seed, temperature, runId);
  attempts += 1;
  attemptTrace.push({
    attempt: attempts,
    status: response.status,
    latency_ms: response.latency_ms,
    retry_after_ms: Math.max(0, toNum(response.payload.retryAfterMs, 0)),
    error: response.payload.error,
    message: response.payload.message,
  });
  if (shouldAbort?.()) {
    stopReason = "campaign_abort_requested";
    return { response, attempts, stopReason, attemptTrace };
  }
  while (attempts <= MAX_RETRIES && shouldRetryResponse(response, entry)) {
    if (shouldAbort?.()) {
      stopReason = "campaign_abort_requested";
      break;
    }
    const elapsedMs = Date.now() - begin;
    if (elapsedMs >= MAX_CASE_WALL_MS) {
      stopReason = "case_wall_exceeded";
      break;
    }
    if (isCircuitOpenPayload(response.payload)) {
      circuitOpenRetries += 1;
      const retryAfter = Math.max(0, toNum(response.payload.retryAfterMs, 0));
      if (
        circuitOpenRetries > CIRCUIT_OPEN_MAX_RETRIES ||
        retryAfter >= CIRCUIT_OPEN_RETRY_AFTER_CUTOFF_MS
      ) {
        stopReason = "circuit_open_short_circuit";
        break;
      }
    }
    const delay = retryDelayMs(response, attempts - 1);
    const remaining = Math.max(0, MAX_CASE_WALL_MS - (Date.now() - begin));
    if (remaining <= 0) {
      stopReason = "case_wall_exceeded";
      break;
    }
    await sleepInterruptible(Math.min(delay, remaining), () => Boolean(shouldAbort?.()));
    if (shouldAbort?.()) {
      stopReason = "campaign_abort_requested";
      break;
    }
    response = await askOnce(entry, seed, temperature, runId);
    attempts += 1;
    attemptTrace.push({
      attempt: attempts,
      status: response.status,
      latency_ms: response.latency_ms,
      retry_after_ms: Math.max(0, toNum(response.payload.retryAfterMs, 0)),
      error: response.payload.error,
      message: response.payload.message,
    });
  }
  if (stopReason === "done" && shouldRetryResponse(response, entry) && attempts > MAX_RETRIES) {
    stopReason = "max_retries_reached";
  }
  return { response, attempts, stopReason, attemptTrace };
};

const toNum = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const hasRepoOrHybridDomain = (value: unknown): boolean => {
  const domain = String(value ?? "").trim().toLowerCase();
  return domain === "repo" || domain === "hybrid";
};

const isRepoOrHybridScope = (args: {
  family: PromptFamily;
  expectedIntentDomain?: unknown;
  observedIntentDomain?: unknown;
}): boolean =>
  args.family === "relation" ||
  args.family === "repo_technical" ||
  hasRepoOrHybridDomain(args.expectedIntentDomain) ||
  hasRepoOrHybridDomain(args.observedIntentDomain);

const collectObjectiveLoopStates = (debug: AskDebug | null): Array<{
  objective_id: string;
  status: string;
  required_slots: string[];
}> => {
  if (!Array.isArray(debug?.objective_loop_state)) return [];
  return debug.objective_loop_state
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const objectiveId = String(record.objective_id ?? "").trim();
      if (!objectiveId) return null;
      const status = String(record.status ?? "").trim().toLowerCase();
      const requiredSlots = Array.isArray(record.required_slots)
        ? record.required_slots
            .map((slot) => String(slot ?? "").trim())
            .filter(Boolean)
        : [];
      return {
        objective_id: objectiveId,
        status,
        required_slots: requiredSlots,
      };
    })
    .filter((entry): entry is { objective_id: string; status: string; required_slots: string[] } => Boolean(entry));
};

const collectObjectiveRetrievalIds = (debug: AskDebug | null): Set<string> => {
  const ids = new Set<string>();
  if (!Array.isArray(debug?.objective_retrieval_queries)) return ids;
  for (const entry of debug.objective_retrieval_queries) {
    if (!entry || typeof entry !== "object") continue;
    const objectiveId = String((entry as Record<string, unknown>).objective_id ?? "").trim();
    if (objectiveId) ids.add(objectiveId);
  }
  return ids;
};

const hasDeterministicStopReason = (debug: AskDebug | null): boolean => {
  if (!debug) return false;
  const fields = [
    debug.agent_stop_reason,
    debug.controller_stop_reason,
    debug.fallback_reason,
    debug.stage05_fallback_reason,
    debug.answer_runtime_fallback_reason,
    debug.answer_fallback_reason,
    debug.answer_short_fallback_reason,
  ];
  return fields.some((value) => typeof value === "string" && value.trim().length > 0);
};

const collectTimings = (debug: AskDebug | null): { retrieval?: number; synthesis?: number } => {
  if (!debug) return {};
  const timeline = Array.isArray(debug.timeline) ? debug.timeline : [];
  const liveEvents = Array.isArray(debug.live_events) ? debug.live_events : [];
  const stageTiming =
    debug.stage_timing_ms && typeof debug.stage_timing_ms === "object"
      ? debug.stage_timing_ms
      : {};
  let retrieval = 0;
  let synthesis = 0;
  for (const step of timeline) {
    const stage = String(step?.stage ?? step?.name ?? "").toLowerCase();
    const ms = toNum(step?.duration_ms ?? step?.ms, 0);
    if (!ms) continue;
    if (/retrieve|search|evidence|context/.test(stage)) retrieval += ms;
    if (/synth|answer|contract|repair|final/.test(stage)) synthesis += ms;
  }
  if (retrieval === 0 || synthesis === 0) {
    for (const evt of liveEvents) {
      const stage = String(evt?.stage ?? evt?.name ?? "").toLowerCase();
      const ms = toNum(evt?.durationMs ?? evt?.duration_ms ?? evt?.ms, 0);
      if (!ms) continue;
      if (retrieval === 0 && /retrieve|evidence|search|context|tree walk|ambiguity/.test(stage)) retrieval += ms;
      if (synthesis === 0 && /synthesis|answer|contract|repair|cleaned|final/.test(stage)) synthesis += ms;
    }
  }
  if (retrieval === 0 || synthesis === 0) {
    for (const [stageKey, value] of Object.entries(stageTiming)) {
      const stage = String(stageKey ?? "").toLowerCase();
      const ms = toNum(value, 0);
      if (!ms) continue;
      if (retrieval === 0 && /retrieve|evidence|search|context|preflight/.test(stage)) retrieval += ms;
      if (synthesis === 0 && /synth|answer|contract|repair|cleaned|final/.test(stage)) synthesis += ms;
    }
  }
  return {
    retrieval: retrieval > 0 ? retrieval : undefined,
    synthesis: synthesis > 0 ? synthesis : undefined,
  };
};

const evaluateFailures = (entry: PromptCase, response: ReturnType<typeof askOnce> extends Promise<infer R> ? R : never): string[] => {
  const failures: string[] = [];
  const text = String(response.payload.text ?? "");
  const debug = response.payload.debug ?? null;
  const reportMode = typeof debug?.report_mode === "boolean" ? debug.report_mode : response.payload.report_mode;
  const objectiveStates = collectObjectiveLoopStates(debug);
  if (response.status !== 200) failures.push(`request_failed:${response.status || "network"}`);
  if (response.status === 200 && isCircuitOpenPayload(response.payload)) {
    failures.push("request_failed:circuit_open_payload");
  }
  if (entry.expected_intent_id && debug?.intent_id !== entry.expected_intent_id) {
    failures.push(`intent_mismatch:${debug?.intent_id ?? "missing"}`);
  }
  if (entry.expected_intent_domain && debug?.intent_domain !== entry.expected_intent_domain) {
    failures.push(`intent_domain_mismatch:${debug?.intent_domain ?? "missing"}`);
  }
  if (typeof entry.expected_report_mode === "boolean" && reportMode !== entry.expected_report_mode) {
    failures.push(`report_mode_mismatch:${String(reportMode)}`);
  }
  const reasoningDebugMissingFields: string[] = [];
  if (!hasDeterministicStopReason(debug)) {
    failures.push("reasoning_debug_incomplete:deterministic_stop_reason");
  }
  if (typeof debug?.intent_id !== "string" || !debug.intent_id.trim()) {
    reasoningDebugMissingFields.push("intent_id");
  }
  if (typeof debug?.intent_domain !== "string" || !debug.intent_domain.trim()) {
    reasoningDebugMissingFields.push("intent_domain");
  }
  if (typeof debug?.intent_strategy !== "string" || !debug.intent_strategy.trim()) {
    reasoningDebugMissingFields.push("intent_strategy");
  }
  if (typeof reportMode !== "boolean") {
    reasoningDebugMissingFields.push("report_mode");
  }
  const answerPath = Array.isArray(debug?.answer_path)
    ? debug.answer_path
      .map((step) => String(step ?? "").trim())
      .filter(Boolean)
    : [];
  if (answerPath.length === 0) {
    reasoningDebugMissingFields.push("answer_path");
  }
  const objectiveLoopExpected =
    objectiveStates.length > 0 || toNum(debug?.objective_count, 0) > 0;
  if (objectiveLoopExpected) {
    if (objectiveStates.length === 0) {
      reasoningDebugMissingFields.push("objective_loop_state");
    }
    if (!Array.isArray(debug?.objective_retrieval_queries)) {
      reasoningDebugMissingFields.push("objective_retrieval_queries");
    }
    if (!Array.isArray(debug?.objective_mini_answers)) {
      reasoningDebugMissingFields.push("objective_mini_answers");
    }
    if (typeof debug?.objective_mini_critic_mode !== "string" || !debug.objective_mini_critic_mode.trim()) {
      reasoningDebugMissingFields.push("objective_mini_critic_mode");
    }
    if (typeof debug?.objective_assembly_mode !== "string" || !debug.objective_assembly_mode.trim()) {
      reasoningDebugMissingFields.push("objective_assembly_mode");
    }
    if (typeof debug?.objective_finalize_gate_passed !== "boolean") {
      reasoningDebugMissingFields.push("objective_finalize_gate_passed");
    }
    if (typeof debug?.objective_finalize_gate_mode !== "string" || !debug.objective_finalize_gate_mode.trim()) {
      reasoningDebugMissingFields.push("objective_finalize_gate_mode");
    }
  }
  if (reasoningDebugMissingFields.length > 0) {
    failures.push(`reasoning_debug_incomplete:${Array.from(new Set(reasoningDebugMissingFields)).join(",")}`);
  }
  if (entry.family === "relation") {
    if (debug?.relation_packet_built !== true) failures.push(`relation_packet_built:${String(debug?.relation_packet_built)}`);
    if (debug?.relation_dual_domain_ok !== true) failures.push(`relation_dual_domain:${String(debug?.relation_dual_domain_ok)}`);
    if (toNum(debug?.relation_packet_bridge_count, 0) < 2) failures.push(`bridge_count_low:${toNum(debug?.relation_packet_bridge_count, 0)}`);
    if (toNum(debug?.relation_packet_evidence_count, 0) < 2) failures.push(`evidence_count_low:${toNum(debug?.relation_packet_evidence_count, 0)}`);
  }
  if (STUB_RE.test(text)) failures.push("stub_text_detected");
  if (/\bruntime fallback\b/i.test(text)) failures.push("runtime_fallback_answer");
  if (/cannot access ['\"]?intentStrategy['\"]? before initialization/i.test(text)) {
    failures.push("runtime_tdz_intentStrategy");
  }
  if (/cannot access ['\"]?intentProfile['\"]? before initialization/i.test(text)) {
    failures.push("runtime_tdz_intentProfile");
  }
  const debugReasonSignals = [
    ...answerPath,
    ...(Array.isArray(debug?.final_mode_gate_consistency_reasons)
      ? debug.final_mode_gate_consistency_reasons.map((entry) => String(entry ?? "").trim())
      : []),
    ...(Array.isArray(debug?.uncertainty_research_contract_missing_reasons)
      ? debug.uncertainty_research_contract_missing_reasons
          .map((entry) => String(entry ?? "").trim())
          .filter(Boolean)
      : []),
  ];
  const adapterConstraintPolicySignal =
    ADAPTER_CONSTRAINT_POLICY_RE.test(text) ||
    debugReasonSignals.some((entry) => ADAPTER_CONSTRAINT_POLICY_RE.test(entry));
  if (adapterConstraintPolicySignal) {
    failures.push("adapter_constraint_policy_fail");
  }
  const toolUseBudgetSignal =
    TOOL_USE_BUDGET_POLICY_RE.test(text) ||
    debugReasonSignals.some((entry) => TOOL_USE_BUDGET_POLICY_RE.test(entry));
  if (toolUseBudgetSignal || adapterConstraintPolicySignal) {
    failures.push("tool_use_budget_pack_fail");
  }
  if (REPORT_SECTION_RE.test(text)) failures.push("report_scaffold_shape");
  if (DEBUG_SCAFFOLD_LEAK_RE.test(text)) failures.push("debug_scaffold_leak");
  if (CODE_FRAGMENT_SPILL_RE.test(text)) failures.push("code_fragment_spill");
  const requiresRepoHybridContract = isRepoOrHybridScope({
    family: entry.family,
    expectedIntentDomain: entry.expected_intent_domain,
    observedIntentDomain: debug?.intent_domain,
  });
  if (requiresRepoHybridContract) {
    const uncertaintyMissingReasons = Array.isArray(debug?.uncertainty_research_contract_missing_reasons)
      ? debug.uncertainty_research_contract_missing_reasons
          .map((entry) => String(entry ?? "").trim())
          .filter(Boolean)
      : [];
    const semanticMissingReasons = Array.isArray(debug?.semantic_repo_tech_missing_reasons)
      ? debug.semantic_repo_tech_missing_reasons
          .map((entry) => String(entry ?? "").trim())
          .filter(Boolean)
      : [];
    const claimEvidenceMissingReasons = Array.isArray(debug?.claim_evidence_binding_missing)
      ? debug.claim_evidence_binding_missing
          .map((entry) => String(entry ?? "").trim())
          .filter(Boolean)
      : [];
    const finalContractMissing: string[] = [];
    if (!DIRECT_ANSWER_SECTION_RE.test(text)) finalContractMissing.push("direct_answer");
    if (!WHERE_IN_REPO_SECTION_RE.test(text)) finalContractMissing.push("where_in_repo");
    if (!CONFIDENCE_UNCERTAINTY_SECTION_RE.test(text)) finalContractMissing.push("confidence_uncertainty");
    if (!SOURCES_SECTION_RE.test(text)) finalContractMissing.push("sources");
    if (finalContractMissing.length > 0) {
      failures.push(`final_answer_contract_incomplete:${finalContractMissing.join(",")}`);
    }
    if (
      debug?.uncertainty_research_contract_required === true &&
      debug?.uncertainty_research_contract_pass !== true
    ) {
      failures.push(
        `uncertainty_research_contract_missing:${uncertaintyMissingReasons.slice(0, 6).join(",") || "unknown"}`,
      );
    }
    if (
      debug?.uncertainty_research_contract_required === true &&
      debug?.uncertainty_research_contract_tier_coverage_pass === false
    ) {
      failures.push("uncertainty_research_tier_coverage_missing");
    }
    if (
      (debug?.uncertainty_research_contract_required_uncertainty_estimation === true &&
        toNum(debug?.uncertainty_research_contract_uncertainty_estimation_count, 0) <= 0) ||
      uncertaintyMissingReasons.some((reason) =>
        reason.includes("uncertainty_research_contract_missing:uncertainty_estimation_reference"),
      )
    ) {
      failures.push("uncertainty_estimation_reference_missing");
    }
    if (
      debug?.experimental_math_risk === true &&
      debug?.uncertainty_research_contract_pass !== true
    ) {
      failures.push("experimental_math_without_research_pair");
    }
    if (
      debug?.semantic_repo_tech_contract_required === true &&
      debug?.semantic_repo_tech_contract_pass !== true
    ) {
      failures.push(
        `semantic_repo_tech_incomplete:${semanticMissingReasons.slice(0, 6).join(",") || "unknown"}`,
      );
    }
    if (
      debug?.claim_evidence_binding_pass === false ||
      claimEvidenceMissingReasons.length > 0
    ) {
      failures.push(
        `claim_evidence_binding_missing:${claimEvidenceMissingReasons.slice(0, 6).join(",") || "unknown"}`,
      );
    }
  }
  if (text.trim().length < (entry.min_text_chars ?? MIN_TEXT_CHARS)) failures.push(`text_too_short:${text.trim().length}`);
  const memoryCitationEntries = Array.isArray(response.payload.memory_citation?.entries)
    ? response.payload.memory_citation?.entries.length
    : 0;
  const memoryCitationRolloutIds = Array.isArray(response.payload.memory_citation?.rollout_ids)
    ? response.payload.memory_citation?.rollout_ids.length
    : 0;
  const hasCitation =
    /\bSources?:\s+/i.test(text) ||
    /docs\//i.test(text) ||
    /server\//i.test(text) ||
    memoryCitationEntries > 0 ||
    memoryCitationRolloutIds > 0;
  if (!hasCitation) failures.push("citation_missing");
  if (objectiveStates.length > 0) {
    const objectiveFinalizeMode = String(debug?.objective_finalize_gate_mode ?? "").trim().toLowerCase();
    const objectiveUnknownTerminalAccepted =
      objectiveFinalizeMode === "unknown_terminal" &&
      debug?.objective_finalize_gate_unknown_terminal_eligible === true;
    const objectiveFinalizeAccepted =
      debug?.objective_finalize_gate_passed === true || objectiveUnknownTerminalAccepted;
    if (!objectiveFinalizeAccepted) {
      failures.push(`objective_finalize_gate:${String(debug?.objective_finalize_gate_passed)}`);
    }
    const requiredObjectiveIds = objectiveStates
      .filter((state) => state.required_slots.length > 0)
      .map((state) => state.objective_id);
    if (requiredObjectiveIds.length > 0) {
      const retrievalIds = collectObjectiveRetrievalIds(debug);
      const missingObjectiveRetrieval = requiredObjectiveIds.filter((id) => !retrievalIds.has(id));
      if (missingObjectiveRetrieval.length > 0) {
        failures.push(`objective_retrieval_missing:${missingObjectiveRetrieval.slice(0, 6).join(",")}`);
      }
    }
    const miniAnswerCount = Array.isArray(debug?.objective_mini_answers)
      ? debug.objective_mini_answers.length
      : 0;
    if (miniAnswerCount < objectiveStates.length) {
      failures.push(`objective_mini_answers_short:${miniAnswerCount}/${objectiveStates.length}`);
    }
    const assemblyMode = String(debug?.objective_assembly_mode ?? "").trim().toLowerCase();
    if (assemblyMode !== "llm" && assemblyMode !== "deterministic_fallback") {
      failures.push(`objective_assembly_missing:${assemblyMode || "none"}`);
    }
  }
  return failures;
};

export const __testOnlyEvaluateFailures = evaluateFailures;

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
};

const avg = (values: number[]): number => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

const toWilson95 = (pass: number, total: number): ProbabilitySnapshot => {
  if (total <= 0) {
    return {
      pass,
      total,
      p: 0,
      ci95: {
        low: 0,
        high: 0,
      },
    };
  }
  const z = 1.959963984540054;
  const phat = pass / total;
  const z2 = z ** 2;
  const denom = 1 + z2 / total;
  const center =
    (phat + z2 / (2 * total)) / denom;
  const margin =
    (z / denom) * Math.sqrt((phat * (1 - phat)) / total + z2 / (4 * total ** 2));
  return {
    pass,
    total,
    p: phat,
    ci95: {
      low: Math.max(0, center - margin),
      high: Math.min(1, center + margin),
    },
  };
};

const hasFailurePrefix = (row: Pick<RawRun, "failures">, prefix: string): boolean =>
  row.failures.some((failure) => failure.startsWith(prefix));

const hasAnyFailurePrefix = (row: Pick<RawRun, "failures">, prefixes: string[]): boolean =>
  prefixes.some((prefix) => hasFailurePrefix(row, prefix));

export const buildProbabilityScorecard = (rows: RawRun[]) => {
  const families: PromptFamily[] = ["relation", "repo_technical", "ambiguous_general"];
  const routeCorrectByFamily = Object.fromEntries(
    families.map((family) => {
      const scoped = rows.filter(
        (row) => row.family === family && (row.expected_intent_id || row.expected_intent_domain),
      );
      const pass = scoped.filter((row) => isRouteCorrect(row) === true).length;
      return [family, toWilson95(pass, scoped.length)];
    }),
  ) as Record<PromptFamily, ProbabilitySnapshot>;

  const frontierScaffoldPass = rows.filter((row) => {
    const relationSatisfied =
      row.family !== "relation" ||
      (
        row.debug?.relation_packet_built === true &&
        row.debug?.relation_dual_domain_ok === true &&
        toNum(row.debug?.relation_packet_bridge_count, 0) >= 2 &&
        toNum(row.debug?.relation_packet_evidence_count, 0) >= 2
      );
    const noReportScaffold = !row.failures.includes("report_scaffold_shape");
    const longEnough = !hasFailurePrefix(row, "text_too_short:");
    return relationSatisfied && noReportScaffold && longEnough;
  }).length;

  const noDebugLeakPass = rows.filter(
    (row) => !row.failures.includes("debug_scaffold_leak") && !row.failures.includes("code_fragment_spill"),
  ).length;
  const noRuntimeFallbackPass = rows.filter(
    (row) =>
      !hasAnyFailurePrefix(row, [
        "runtime_fallback_answer",
        "runtime_tdz_intentStrategy",
        "runtime_tdz_intentProfile",
      ]),
  ).length;
  const reasoningDebugCompletePass = rows.filter((row) => !hasFailurePrefix(row, "reasoning_debug_incomplete")).length;
  const repoHybridRows = rows.filter((row) => isRepoOrHybridScope({
    family: row.family,
    expectedIntentDomain: row.expected_intent_domain,
    observedIntentDomain: row.debug?.intent_domain,
  }));
  const finalAnswerContractPass = repoHybridRows.filter(
    (row) => !hasFailurePrefix(row, "final_answer_contract_incomplete"),
  ).length;
  const uncertaintyResearchRows = repoHybridRows.filter(
    (row) => row.debug?.uncertainty_research_contract_required === true,
  );
  const uncertaintyResearchContractPass = uncertaintyResearchRows.filter(
    (row) => !hasFailurePrefix(row, "uncertainty_research_contract_missing"),
  ).length;
  const semanticRepoTechRows = repoHybridRows.filter(
    (row) => row.debug?.semantic_repo_tech_contract_required === true,
  );
  const semanticRepoTechContractPass = semanticRepoTechRows.filter(
    (row) => !hasFailurePrefix(row, "semantic_repo_tech_incomplete"),
  ).length;
  const claimEvidenceBindingRows = repoHybridRows.filter(
    (row) =>
      row.debug?.semantic_repo_tech_contract_required === true ||
      row.debug?.uncertainty_research_contract_required === true,
  );
  const claimEvidenceBindingPass = claimEvidenceBindingRows.filter(
    (row) => !hasFailurePrefix(row, "claim_evidence_binding_missing"),
  ).length;
  const researchTierCoveragePass = uncertaintyResearchRows.filter(
    (row) => !row.failures.includes("uncertainty_research_tier_coverage_missing"),
  ).length;
  const uncertaintyEstimatorRows = uncertaintyResearchRows.filter(
    (row) => row.debug?.uncertainty_research_contract_required_uncertainty_estimation === true,
  );
  const uncertaintyEstimatorPresentPass = uncertaintyEstimatorRows.filter(
    (row) => !row.failures.includes("uncertainty_estimation_reference_missing"),
  ).length;
  const experimentalMathRows = repoHybridRows.filter(
    (row) => row.debug?.experimental_math_risk === true,
  );
  const experimentalMathGuardPass = experimentalMathRows.filter(
    (row) => !row.failures.includes("experimental_math_without_research_pair"),
  ).length;
  const toolUseBudgetPackPass = rows.filter(
    (row) =>
      !row.failures.includes("tool_use_budget_pack_fail") &&
      !row.failures.includes("adapter_constraint_policy_fail"),
  ).length;
  const objectiveRows = rows.filter((row) => collectObjectiveLoopStates(row.debug).length > 0);
  const objectiveCompleteBeforeFinalizePass = objectiveRows.filter((row) => {
    const states = collectObjectiveLoopStates(row.debug);
    const allTerminal = states.every((state) => state.status === "complete" || state.status === "blocked");
    const mode = String(row.debug?.objective_finalize_gate_mode ?? "").trim().toLowerCase();
    const unknownTerminalAccepted =
      mode === "unknown_terminal" &&
      row.debug?.objective_finalize_gate_unknown_terminal_eligible === true;
    return (row.debug?.objective_finalize_gate_passed === true || unknownTerminalAccepted) && allTerminal;
  }).length;
  const objectiveScopedRetrievalSuccessPass = objectiveRows.filter((row) => {
    const states = collectObjectiveLoopStates(row.debug);
    const requiredObjectiveIds = states
      .filter((state) => state.required_slots.length > 0)
      .map((state) => state.objective_id);
    if (requiredObjectiveIds.length === 0) return true;
    const retrievalIds = collectObjectiveRetrievalIds(row.debug);
    return requiredObjectiveIds.every((id) => retrievalIds.has(id));
  }).length;
  const objectiveAssemblySuccessPass = objectiveRows.filter((row) => {
    const states = collectObjectiveLoopStates(row.debug);
    const miniAnswerCount = Array.isArray(row.debug?.objective_mini_answers)
      ? row.debug.objective_mini_answers.length
      : 0;
    const assemblyMode = String(row.debug?.objective_assembly_mode ?? "").trim().toLowerCase();
    const assemblyOk = assemblyMode === "llm" || assemblyMode === "deterministic_fallback";
    return assemblyOk && miniAnswerCount >= states.length;
  }).length;

  return {
    method: "wilson_95",
    sample_size: rows.length,
    metrics: {
      route_correct_by_family: routeCorrectByFamily,
      frontier_scaffold_complete: toWilson95(frontierScaffoldPass, rows.length),
      no_debug_leak: toWilson95(noDebugLeakPass, rows.length),
      no_runtime_fallback: toWilson95(noRuntimeFallbackPass, rows.length),
      reasoning_debug_complete: toWilson95(reasoningDebugCompletePass, rows.length),
      final_answer_contract_pass: toWilson95(finalAnswerContractPass, repoHybridRows.length),
      uncertainty_research_contract_pass: toWilson95(
        uncertaintyResearchContractPass,
        uncertaintyResearchRows.length,
      ),
      semantic_repo_tech_contract_pass: toWilson95(
        semanticRepoTechContractPass,
        semanticRepoTechRows.length,
      ),
      claim_evidence_binding_pass: toWilson95(
        claimEvidenceBindingPass,
        claimEvidenceBindingRows.length,
      ),
      research_tier_coverage_pass: toWilson95(
        researchTierCoveragePass,
        uncertaintyResearchRows.length,
      ),
      uncertainty_estimator_present: toWilson95(
        uncertaintyEstimatorPresentPass,
        uncertaintyEstimatorRows.length,
      ),
      experimental_math_guard_pass: toWilson95(
        experimentalMathGuardPass,
        experimentalMathRows.length,
      ),
      tool_use_budget_pack_pass: toWilson95(
        toolUseBudgetPackPass,
        rows.length,
      ),
      objective_complete_before_finalize: toWilson95(
        objectiveCompleteBeforeFinalizePass,
        objectiveRows.length,
      ),
      objective_scoped_retrieval_success: toWilson95(
        objectiveScopedRetrievalSuccessPass,
        objectiveRows.length,
      ),
      objective_assembly_success: toWilson95(
        objectiveAssemblySuccessPass,
        objectiveRows.length,
      ),
    },
  };
};

const main = async () => {
  const startedAt = new Date().toISOString();
  const runEpoch = Date.now();
  const gitProvenance = await collectGitProvenance();
  const provenanceWarnings: string[] = [];
  if (!gitProvenance.hasOriginRemote) provenanceWarnings.push("git_origin_remote_missing");
  if (!gitProvenance.originMain) provenanceWarnings.push("git_origin_main_ref_missing");
  if (!gitProvenance.head) provenanceWarnings.push("git_head_missing");
  const provenanceGatePass = provenanceWarnings.length === 0;
  let runId = `versatility-${Date.now()}`;
  const outRootDir = path.resolve(OUT_DIR);
  let runOutDir = ISOLATE_RUN_DIR ? path.join(outRootDir, runId) : outRootDir;
  const prompts = maybeApplyPromptSamplingAndOrder(allPrompts());
  if (PROMPT_SAMPLE_PER_FAMILY <= 0 && prompts.length < 90) {
    throw new Error(`expected >=90 prompts, got ${prompts.length}`);
  }
  const expectedRuns = prompts.length * SEEDS.length * TEMPS.length;

  let resumedFromLatest = false;
  let resumedRuns = 0;
  const runArtifactBundlePaths = createArtifactBundlePaths({
    outRootDir,
    runOutDir,
    traceExportPath: TRACE_EXPORT_PATH,
    abOutputPaths: AB_OUTPUT_PATHS,
  });
  if (ISOLATE_RUN_DIR && RESUME_FROM_LATEST) {
    const latest = await readJsonFile<{ run_id?: string; output_run_dir?: string }>(
      path.resolve(outRootDir, "latest.json"),
    );
    if (latest?.run_id && latest?.output_run_dir) {
      const summary = await readJsonFile<{ expected_runs?: number; run_complete?: boolean }>(
        path.resolve(latest.output_run_dir, "summary.json"),
      );
      const expectedMatch = !Number.isFinite(summary?.expected_runs) || summary?.expected_runs === expectedRuns;
      const incomplete = summary?.run_complete !== true;
      if (expectedMatch && incomplete) {
        runId = latest.run_id;
        runOutDir = path.resolve(latest.output_run_dir);
        resumedFromLatest = true;
      }
    }
  }

  await fs.mkdir(path.resolve(runOutDir, "raw"), { recursive: true });
  await fs.mkdir(path.resolve("reports"), { recursive: true });

  const promptJsonl = prompts
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  await fs.writeFile(path.resolve(runOutDir, "prompts.jsonl"), `${promptJsonl}\n`, "utf8");

  let serverChild: ReturnType<typeof spawn> | null = null;
  if (START_SERVER) {
    serverChild = await startServer();
  } else {
    await ensureServerReady();
  }
  await precheckHelixAskAvailability({
    baseUrl: BASE_URL,
    timeoutMs: PRECHECK_TIMEOUT_MS,
    label: "versatility campaign precheck",
  });

  const rawRunByKey = resumedFromLatest ? await loadExistingRawRunMap(runOutDir) : new Map<string, RawRun>();
  resumedRuns = rawRunByKey.size;
  if (resumedRuns > 0) {
    await writeCheckpoint(runOutDir, runId, Array.from(rawRunByKey.values()));
    console.log(
      `[versatility] resume run=${runId} restored_runs=${resumedRuns}/${expectedRuns} out=${runOutDir}`,
    );
  }

  let terminatedEarlyReason: string | null = null;
  const runStartMs = Date.now();
  let globalCooldownUntil = 0;
  let globalCooldownAppliedMs = 0;
  let abortSignal: NodeJS.Signals | null = null;
  const onAbortSignal = (signal: NodeJS.Signals) => {
    abortSignal = signal;
    if (!terminatedEarlyReason) {
      terminatedEarlyReason = `signal:${signal}`;
    }
  };
  process.once("SIGINT", onAbortSignal);
  process.once("SIGTERM", onAbortSignal);
  try {
    outer: for (const entry of prompts) {
      for (const seed of SEEDS) {
        for (const temperature of TEMPS) {
          const caseKey = runCaseKey(entry.id, seed, temperature);
          if (rawRunByKey.has(caseKey)) continue;
          if (abortSignal) {
            terminatedEarlyReason = terminatedEarlyReason ?? `signal:${abortSignal}`;
            break outer;
          }
          if (globalCooldownUntil > Date.now()) {
            const waitMs = globalCooldownUntil - Date.now();
            const cooldownStart = Date.now();
            await sleepInterruptible(waitMs, () => Boolean(abortSignal));
            const waitedMs = Math.max(0, Date.now() - cooldownStart);
            if (abortSignal) {
              terminatedEarlyReason = terminatedEarlyReason ?? `signal:${abortSignal}`;
              break outer;
            }
            globalCooldownAppliedMs += waitedMs;
          }
          if (MAX_RUN_MS > 0 && Date.now() - runStartMs >= MAX_RUN_MS) {
            terminatedEarlyReason = `max_run_ms_exceeded:${MAX_RUN_MS}`;
            break outer;
          }
          const { response, attempts, stopReason, attemptTrace } = await askWithRetry(
            entry,
            seed,
            temperature,
            runId,
            () => Boolean(abortSignal),
          );
          if (stopReason === "campaign_abort_requested") {
            terminatedEarlyReason = terminatedEarlyReason ?? `signal:${abortSignal ?? "abort_requested"}`;
            break outer;
          }
          const failures = evaluateFailures(entry, response);
          const fileName = `${runId}-${entry.id}-s${seed}-t${String(temperature).replace(".", "p")}.json`;
          const rawRecordPath = path.resolve(runOutDir, "raw", fileName);
          const raw: RawRun = {
            run_id: runId,
            prompt_id: entry.id,
            family: entry.family,
            question: entry.question,
            seed,
            temperature,
            status: response.status,
            latency_ms: response.latency_ms,
            timestamp: new Date().toISOString(),
            expected_intent_id: entry.expected_intent_id,
            expected_intent_domain: entry.expected_intent_domain,
            expected_report_mode: entry.expected_report_mode,
            response_text: String(response.payload.text ?? ""),
            debug: response.payload.debug ?? null,
            failures,
            attempts,
            stop_reason: stopReason,
            attempt_trace: attemptTrace,
            diagnostics: buildRunDiagnostics({
              expected_report_mode: entry.expected_report_mode,
              family: entry.family,
              debug: response.payload.debug ?? null,
            }),
            artifact_bundle_paths: createArtifactBundlePaths({
              outRootDir,
              runOutDir,
              rawRecordPath,
              traceExportPath: TRACE_EXPORT_PATH,
              abOutputPaths: AB_OUTPUT_PATHS,
            }),
          };
          rawRunByKey.set(caseKey, raw);
          if (
            GLOBAL_COOLDOWN_ON_CIRCUIT &&
            (raw.stop_reason === "circuit_open_short_circuit" || raw.status === 503)
          ) {
            const retryAfterMs = circuitRetryAfterFromRawRun(raw);
            if (retryAfterMs > 0) {
              const cooldownMs = Math.min(GLOBAL_COOLDOWN_CAP_MS, retryAfterMs);
              if (cooldownMs > 0) {
                globalCooldownUntil = Math.max(globalCooldownUntil, Date.now() + cooldownMs);
              }
            }
          }
          await fs.writeFile(rawRecordPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
          if (rawRunByKey.size % CHECKPOINT_EVERY === 0) {
            const checkpointRows = Array.from(rawRunByKey.values());
            await writeCheckpoint(runOutDir, runId, checkpointRows);
            console.log(`[versatility] progress ${checkpointRows.length}/${expectedRuns}`);
          }
        }
      }
    }
  } finally {
    process.removeListener("SIGINT", onAbortSignal);
    process.removeListener("SIGTERM", onAbortSignal);
    if (serverChild) await stopServer(serverChild);
  }
  const rawRuns = Array.from(rawRunByKey.values());
  await writeCheckpoint(runOutDir, runId, rawRuns);
  const runComplete = rawRuns.length === expectedRuns && !terminatedEarlyReason;
  if (!runComplete && !terminatedEarlyReason) {
    terminatedEarlyReason = `incomplete_run:${rawRuns.length}/${expectedRuns}`;
  }

  const byFamily = new Map<PromptFamily, RawRun[]>();
  for (const family of ["relation", "repo_technical", "ambiguous_general"] as const) {
    byFamily.set(family, rawRuns.filter((entry) => entry.family === family));
  }

  const failureCounts = new Map<string, number>();
  for (const row of rawRuns) {
    for (const failure of row.failures) {
      const key = failure.split(":")[0] ?? failure;
      failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
    }
  }
  const topFailures: FailureRecord[] = Array.from(failureCounts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const expectedRouteRows = rawRuns.filter(
    (row) => row.expected_intent_id || row.expected_intent_domain,
  );
  const reportExpectedRows = rawRuns.filter((row) => typeof row.expected_report_mode === "boolean");
  const relationRows = rawRuns.filter((row) => row.family === "relation");
  const repoHybridRows = rawRuns.filter((row) => isRepoOrHybridScope({
    family: row.family,
    expectedIntentDomain: row.expected_intent_domain,
    observedIntentDomain: row.debug?.intent_domain,
  }));

  const citationRate = rawRuns.filter((row) => !row.failures.some((f) => f.startsWith("citation_missing"))).length / Math.max(1, rawRuns.length);
  const minTextPassRate = rawRuns.filter((row) => !row.failures.some((f) => f.startsWith("text_too_short"))).length / Math.max(1, rawRuns.length);
  const stubRate = rawRuns.filter((row) => row.failures.includes("stub_text_detected")).length / Math.max(1, rawRuns.length);
  const runtimeFallbackRate = rawRuns.filter((row) => row.failures.includes("runtime_fallback_answer")).length / Math.max(1, rawRuns.length);
  const runtimeTdzIntentStrategyRate = rawRuns.filter((row) => row.failures.includes("runtime_tdz_intentStrategy")).length / Math.max(1, rawRuns.length);
  const runtimeTdzIntentProfileRate = rawRuns.filter((row) => row.failures.includes("runtime_tdz_intentProfile")).length / Math.max(1, rawRuns.length);
  const debugScaffoldLeakRate = rawRuns.filter((row) => row.failures.includes("debug_scaffold_leak")).length / Math.max(1, rawRuns.length);
  const codeFragmentSpillRate = rawRuns.filter((row) => row.failures.includes("code_fragment_spill")).length / Math.max(1, rawRuns.length);
  const reasoningDebugCompleteRate =
    rawRuns.filter((row) => !row.failures.some((f) => f.startsWith("reasoning_debug_incomplete"))).length /
    Math.max(1, rawRuns.length);
  const finalAnswerContractPassRate =
    repoHybridRows.filter((row) => !row.failures.some((f) => f.startsWith("final_answer_contract_incomplete"))).length /
    Math.max(1, repoHybridRows.length);
  const uncertaintyResearchRequiredRows = repoHybridRows.filter(
    (row) => row.debug?.uncertainty_research_contract_required === true,
  );
  const uncertaintyResearchContractPassRate =
    repoHybridRows.filter((row) => !row.failures.some((f) => f.startsWith("uncertainty_research_contract_missing"))).length /
    Math.max(1, repoHybridRows.length);
  const semanticRepoTechRows = repoHybridRows.filter(
    (row) => row.debug?.semantic_repo_tech_contract_required === true,
  );
  const semanticRepoTechContractPassRate =
    semanticRepoTechRows.filter((row) => !row.failures.some((f) => f.startsWith("semantic_repo_tech_incomplete"))).length /
    Math.max(1, semanticRepoTechRows.length);
  const claimEvidenceBindingRows = repoHybridRows.filter(
    (row) =>
      row.debug?.semantic_repo_tech_contract_required === true ||
      row.debug?.uncertainty_research_contract_required === true,
  );
  const claimEvidenceBindingPassRate =
    claimEvidenceBindingRows.filter((row) => !row.failures.some((f) => f.startsWith("claim_evidence_binding_missing"))).length /
    Math.max(1, claimEvidenceBindingRows.length);
  const researchTierCoveragePassRate =
    uncertaintyResearchRequiredRows.filter(
      (row) => !row.failures.includes("uncertainty_research_tier_coverage_missing"),
    ).length /
    Math.max(1, uncertaintyResearchRequiredRows.length);
  const uncertaintyEstimatorRows = uncertaintyResearchRequiredRows.filter(
    (row) => row.debug?.uncertainty_research_contract_required_uncertainty_estimation === true,
  );
  const uncertaintyEstimatorPresentRate =
    uncertaintyEstimatorRows.filter(
      (row) => !row.failures.includes("uncertainty_estimation_reference_missing"),
    ).length /
    Math.max(1, uncertaintyEstimatorRows.length);
  const experimentalMathGuardPassRate =
    repoHybridRows.filter((row) => !row.failures.includes("experimental_math_without_research_pair")).length /
    Math.max(1, repoHybridRows.length);
  const toolUseBudgetPackPassRate =
    rawRuns.filter(
      (row) =>
        !row.failures.includes("tool_use_budget_pack_fail") &&
        !row.failures.includes("adapter_constraint_policy_fail"),
    ).length / Math.max(1, rawRuns.length);

  const relationFallbackRate = relationRows.filter((row) => row.debug?.deterministic_fallback_used_relation === true).length / Math.max(1, relationRows.length);
  const parseFailRelationRate = relationRows.filter((row) => toNum(row.debug?.contract_parse_fail_rate_relation, 0) > 0).length / Math.max(1, relationRows.length);
  const repairRate = rawRuns.filter((row) => row.debug?.citation_repair === true).length / Math.max(1, rawRuns.length);

  const intentCorrectRate = expectedRouteRows.filter((row) => isRouteCorrect(row) === true).length / Math.max(1, expectedRouteRows.length);
  const reportModeCorrectRate = reportExpectedRows.filter((row) => {
    const actual = typeof row.debug?.report_mode === "boolean" ? row.debug?.report_mode : undefined;
    return actual === row.expected_report_mode;
  }).length / Math.max(1, reportExpectedRows.length);

  const relationPacketBuiltRate = relationRows.filter((row) => row.debug?.relation_packet_built === true).length / Math.max(1, relationRows.length);
  const relationDualDomainRate = relationRows.filter((row) => row.debug?.relation_dual_domain_ok === true).length / Math.max(1, relationRows.length);
  const probabilityScorecard = buildProbabilityScorecard(rawRuns);
  const routeSnapshots = Object.values(probabilityScorecard.metrics.route_correct_by_family).filter(
    (entry) => entry.total > 0,
  );
  const minRouteCorrectByFamily =
    routeSnapshots.length > 0 ? Math.min(...routeSnapshots.map((entry) => entry.p)) : 1;
  const reasoningDebugCompleteGatePass =
    probabilityScorecard.metrics.reasoning_debug_complete.total <= 0 ||
    probabilityScorecard.metrics.reasoning_debug_complete.p >= 0.98;
  const finalAnswerContractGatePass =
    probabilityScorecard.metrics.final_answer_contract_pass.total <= 0 ||
    probabilityScorecard.metrics.final_answer_contract_pass.p >= 0.95;
  const uncertaintyResearchContractGatePass =
    probabilityScorecard.metrics.uncertainty_research_contract_pass.total <= 0 ||
    probabilityScorecard.metrics.uncertainty_research_contract_pass.p >= 0.95;
  const semanticRepoTechContractGatePass =
    probabilityScorecard.metrics.semantic_repo_tech_contract_pass.total <= 0 ||
    probabilityScorecard.metrics.semantic_repo_tech_contract_pass.p >= 0.95;
  const claimEvidenceBindingGatePass =
    probabilityScorecard.metrics.claim_evidence_binding_pass.total <= 0 ||
    probabilityScorecard.metrics.claim_evidence_binding_pass.p >= 0.95;
  const researchTierCoverageGatePass =
    probabilityScorecard.metrics.research_tier_coverage_pass.total <= 0 ||
    probabilityScorecard.metrics.research_tier_coverage_pass.p >= 0.95;
  const uncertaintyEstimatorGatePass =
    probabilityScorecard.metrics.uncertainty_estimator_present.total <= 0 ||
    probabilityScorecard.metrics.uncertainty_estimator_present.p >= 0.95;
  const experimentalMathGuardGatePass =
    probabilityScorecard.metrics.experimental_math_guard_pass.total <= 0 ||
    probabilityScorecard.metrics.experimental_math_guard_pass.p >= 0.95;
  const toolUseBudgetPackGatePass =
    probabilityScorecard.metrics.tool_use_budget_pack_pass.total <= 0 ||
    probabilityScorecard.metrics.tool_use_budget_pack_pass.p >= 0.99;
  const readinessVerdict =
    !runComplete || !provenanceGatePass
      ? "NOT_READY"
      : (
          probabilityScorecard.metrics.no_debug_leak.p >= 0.99 &&
          probabilityScorecard.metrics.no_runtime_fallback.p >= 0.99 &&
          probabilityScorecard.metrics.frontier_scaffold_complete.p >= 0.95 &&
          reasoningDebugCompleteGatePass &&
          finalAnswerContractGatePass &&
          uncertaintyResearchContractGatePass &&
          semanticRepoTechContractGatePass &&
          claimEvidenceBindingGatePass &&
          researchTierCoverageGatePass &&
          uncertaintyEstimatorGatePass &&
          experimentalMathGuardGatePass &&
          toolUseBudgetPackGatePass &&
          probabilityScorecard.metrics.objective_complete_before_finalize.p >= 0.99 &&
          probabilityScorecard.metrics.objective_scoped_retrieval_success.p >= 0.95 &&
          probabilityScorecard.metrics.objective_assembly_success.p >= 0.95 &&
          minRouteCorrectByFamily >= 0.9
        )
        ? "READY"
        : "PARTIAL_READY";

  const totalLatencies = rawRuns.map((row) => row.latency_ms);
  const retrievalLatencies = rawRuns.map((row) => collectTimings(row.debug).retrieval).filter((value): value is number => typeof value === "number");
  const synthesisLatencies = rawRuns.map((row) => collectTimings(row.debug).synthesis).filter((value): value is number => typeof value === "number");

  const familySummary = Object.fromEntries(
    Array.from(byFamily.entries()).map(([family, rows]) => {
      const passCount = rows.filter((row) => row.failures.length === 0).length;
      const routeRows = rows.filter((row) => row.expected_intent_id || row.expected_intent_domain);
      const reportRows = rows.filter((row) => typeof row.expected_report_mode === "boolean");
      return [
        family,
        {
          runs: rows.length,
          pass_rate: passCount / Math.max(1, rows.length),
          avg_latency_ms: avg(rows.map((row) => row.latency_ms)),
          p50_latency_ms: percentile(rows.map((row) => row.latency_ms), 50),
          p95_latency_ms: percentile(rows.map((row) => row.latency_ms), 95),
          intent_correct_rate:
            routeRows.length > 0
              ? routeRows.filter((row) => isRouteCorrect(row) === true).length / routeRows.length
              : null,
          report_mode_correct_rate:
            reportRows.length > 0
              ? reportRows.filter((row) => row.debug?.report_mode === row.expected_report_mode).length /
                reportRows.length
              : null,
          stub_rate: rows.filter((row) => row.failures.includes("stub_text_detected")).length / Math.max(1, rows.length),
        },
      ];
    }),
  );

  const worstRows = [...rawRuns]
    .sort((a, b) => b.failures.length - a.failures.length || b.latency_ms - a.latency_ms)
    .reduce<RawRun[]>((acc, row) => {
      if (acc.some((entry) => entry.prompt_id === row.prompt_id)) {
        return acc;
      }
      if (acc.length >= 15) {
        return acc;
      }
      acc.push(row);
      return acc;
    }, []);

  const worst = worstRows.map((row) => ({
      prompt_id: row.prompt_id,
      family: row.family,
      question: row.question,
      answer: row.response_text.slice(0, 1800),
      debug: {
        intent_id: row.debug?.intent_id,
        intent_domain: row.debug?.intent_domain,
        intent_strategy: row.debug?.intent_strategy,
        report_mode: row.debug?.report_mode,
        relation_packet_built: row.debug?.relation_packet_built,
        relation_dual_domain_ok: row.debug?.relation_dual_domain_ok,
        deterministic_fallback_used_relation: row.debug?.deterministic_fallback_used_relation,
        contract_parse_fail_rate_relation: row.debug?.contract_parse_fail_rate_relation,
        citation_repair: row.debug?.citation_repair,
        answer_path: row.debug?.answer_path,
      },
      failures: row.failures,
      likely_root_cause: row.failures.some((entry) => entry.startsWith("stub_text_detected"))
        ? "llm_local_stub_environment"
        : row.failures.some((entry) => entry.startsWith("relation_packet_built"))
          ? "relation_topology_or_context_gap"
          : row.failures.some((entry) => entry.startsWith("citation_missing"))
            ? "citation_cleanup_or_contract_fill_gap"
            : row.failures.some((entry) => entry.startsWith("report_mode_mismatch"))
              ? "routing_or_report_mode_policy"
              : "mixed",
      patch_suggestion: row.failures.some((entry) => entry.startsWith("stub_text_detected"))
        ? "Run campaign with real model and disable stub for decision-grade relation quality judgments."
        : row.failures.some((entry) => entry.startsWith("relation_packet_built"))
          ? "Add relation-specific fallback enforcement when intent_id resolves to hybrid.warp_ethos_relation."
          : row.failures.some((entry) => entry.startsWith("citation_missing"))
            ? "Strengthen citation fallback append after final cleaning for hybrid/repo outputs."
            : "Tighten routing diagnostics and deterministic fallback conditions for this failure signature.",
    }));

  const representativePass = rawRuns.find((row) => row.failures.length === 0);
  const representativeFail = rawRuns.find((row) => row.failures.length > 0);

  const summary = {
    summary_schema_version: 2,
    run_id: runId,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    run_duration_ms: Date.now() - runEpoch,
    terminated_early_reason: terminatedEarlyReason,
    global_cooldown_applied_ms: globalCooldownAppliedMs,
    resumed_from_latest: resumedFromLatest,
    resumed_runs: resumedRuns,
    output_root_dir: outRootDir,
    output_run_dir: runOutDir,
    base_url: BASE_URL,
    prompt_count: prompts.length,
    seed_count: SEEDS.length,
    temperature_values: TEMPS,
    expected_runs: expectedRuns,
    total_runs: rawRuns.length,
    run_complete: runComplete,
    completion_rate: rawRuns.length / Math.max(1, expectedRuns),
    readiness_verdict: readinessVerdict,
    provenance: {
      ...gitProvenance,
      gate_pass: provenanceGatePass,
      warnings: provenanceWarnings,
    },
    artifact_bundle_paths: runArtifactBundlePaths,
    diagnostics: {
      per_run: rawRuns.map((row) => ({
        prompt_id: row.prompt_id,
        family: row.family,
        seed: row.seed,
        temperature: row.temperature,
        report_mode_correct: row.diagnostics?.report_mode_correct ?? null,
        relation_packet_built: row.diagnostics?.relation_packet_built ?? null,
        relation_dual_domain_ok: row.diagnostics?.relation_dual_domain_ok ?? null,
      })),
      rollup: toDiagnosticRollup(rawRuns),
    },
    family_summary: familySummary,
    metrics: {
      attempts: {
        avg_attempts: avg(rawRuns.map((row) => row.attempts ?? 1)),
        p95_attempts: percentile(rawRuns.map((row) => row.attempts ?? 1), 95),
      },
      intent_id_correct_rate: intentCorrectRate,
      report_mode_correct_rate: reportModeCorrectRate,
      relation_packet_built_rate: relationPacketBuiltRate,
      relation_dual_domain_ok_rate: relationDualDomainRate,
      stub_text_detected_rate: stubRate,
      deterministic_fallback_relation_rate: relationFallbackRate,
      contract_parse_fail_relation_rate: parseFailRelationRate,
      citation_repair_rate: repairRate,
      citation_presence_rate: citationRate,
      min_text_length_pass_rate: minTextPassRate,
      runtime_fallback_answer: runtimeFallbackRate,
      runtime_tdz_intentStrategy: runtimeTdzIntentStrategyRate,
      runtime_tdz_intentProfile: runtimeTdzIntentProfileRate,
      debug_scaffold_leak_rate: debugScaffoldLeakRate,
      code_fragment_spill_rate: codeFragmentSpillRate,
      reasoning_debug_complete_rate: reasoningDebugCompleteRate,
      final_answer_contract_pass_rate: finalAnswerContractPassRate,
      uncertainty_research_contract_pass_rate: uncertaintyResearchContractPassRate,
      research_tier_coverage_pass_rate: researchTierCoveragePassRate,
      uncertainty_estimator_present_rate: uncertaintyEstimatorPresentRate,
      experimental_math_guard_pass_rate: experimentalMathGuardPassRate,
      tool_use_budget_pack_pass_rate: toolUseBudgetPackPassRate,
      latency_ms: {
        total: { p50: percentile(totalLatencies, 50), p95: percentile(totalLatencies, 95) },
        retrieval: { p50: percentile(retrievalLatencies, 50), p95: percentile(retrievalLatencies, 95), samples: retrievalLatencies.length },
        synthesis: { p50: percentile(synthesisLatencies, 50), p95: percentile(synthesisLatencies, 95), samples: synthesisLatencies.length },
      },
    },
    probability_scorecard: probabilityScorecard,
    strict_gates: {
      relation_packet_built_rate: relationPacketBuiltRate,
      relation_dual_domain_ok_rate: relationDualDomainRate,
      report_mode_correct_rate: reportModeCorrectRate,
      citation_presence_rate: citationRate,
      stub_text_detected_rate: stubRate,
      runtime_fallback_answer: runtimeFallbackRate,
      runtime_tdz_intentStrategy: runtimeTdzIntentStrategyRate,
      runtime_tdz_intentProfile: runtimeTdzIntentProfileRate,
      no_debug_leak: probabilityScorecard.metrics.no_debug_leak.p,
      no_runtime_fallback: probabilityScorecard.metrics.no_runtime_fallback.p,
      frontier_scaffold_complete: probabilityScorecard.metrics.frontier_scaffold_complete.p,
      reasoning_debug_complete: probabilityScorecard.metrics.reasoning_debug_complete.p,
      final_answer_contract_pass: probabilityScorecard.metrics.final_answer_contract_pass.p,
      uncertainty_research_contract_pass:
        probabilityScorecard.metrics.uncertainty_research_contract_pass.p,
      research_tier_coverage_pass:
        probabilityScorecard.metrics.research_tier_coverage_pass.p,
      uncertainty_estimator_present:
        probabilityScorecard.metrics.uncertainty_estimator_present.p,
      experimental_math_guard_pass:
        probabilityScorecard.metrics.experimental_math_guard_pass.p,
      tool_use_budget_pack_pass:
        probabilityScorecard.metrics.tool_use_budget_pack_pass.p,
      objective_complete_before_finalize:
        probabilityScorecard.metrics.objective_complete_before_finalize.p,
      objective_scoped_retrieval_success:
        probabilityScorecard.metrics.objective_scoped_retrieval_success.p,
      objective_assembly_success:
        probabilityScorecard.metrics.objective_assembly_success.p,
    },
    representative_evidence: {
      pass: representativePass
        ? {
            prompt_id: representativePass.prompt_id,
            family: representativePass.family,
            question: representativePass.question,
            raw_record: representativePass.artifact_bundle_paths?.raw_record ?? null,
          }
        : null,
      fail: representativeFail
        ? {
            prompt_id: representativeFail.prompt_id,
            family: representativeFail.family,
            question: representativeFail.question,
            raw_record: representativeFail.artifact_bundle_paths?.raw_record ?? null,
          }
        : null,
    },
    top_failure_signatures: topFailures,
    worst_examples: worst,
  };

  const failures = {
    run_id: runId,
    expected_runs: expectedRuns,
    total_runs: rawRuns.length,
    run_complete: runComplete,
    readiness_verdict: readinessVerdict,
    artifact_bundle_paths: runArtifactBundlePaths,
    diagnostics: {
      rollup: toDiagnosticRollup(rawRuns),
    },
    probability_scorecard: probabilityScorecard,
    representative_evidence: summary.representative_evidence,
    top_failure_signatures: topFailures,
    failed_runs: rawRuns.filter((row) => row.failures.length > 0).map((row) => ({
      prompt_id: row.prompt_id,
      family: row.family,
      seed: row.seed,
      temperature: row.temperature,
      failures: row.failures,
      intent_id: row.debug?.intent_id,
      intent_domain: row.debug?.intent_domain,
      report_mode: row.debug?.report_mode,
      latency_ms: row.latency_ms,
      diagnostics: {
        report_mode_correct: row.diagnostics?.report_mode_correct ?? null,
        relation_packet_built: row.diagnostics?.relation_packet_built ?? null,
        relation_dual_domain_ok: row.diagnostics?.relation_dual_domain_ok ?? null,
      },
      artifact_bundle_paths: row.artifact_bundle_paths ?? runArtifactBundlePaths,
    })),
  };

  const provenanceBlockerReason = !provenanceGatePass
    ? (!gitProvenance.hasOriginRemote
      ? "BLOCKER_PROVENANCE_ORIGIN_REMOTE_MISSING"
      : !gitProvenance.originMain
        ? "BLOCKER_PROVENANCE_ORIGIN_MAIN_UNAVAILABLE"
        : !gitProvenance.head
          ? "BLOCKER_PROVENANCE_HEAD_UNAVAILABLE"
          : "BLOCKER_PROVENANCE_UNKNOWN")
    : null;
  const recommendationDecision =
    !provenanceGatePass
      ? "blocked_provenance"
      : !runComplete ||
          stubRate > 0.02 ||
          relationPacketBuiltRate < 0.95 ||
          relationDualDomainRate < 0.95 ||
          reportModeCorrectRate < 0.98 ||
          minTextPassRate < 0.9 ||
          probabilityScorecard.metrics.no_debug_leak.p < 0.99 ||
          probabilityScorecard.metrics.no_runtime_fallback.p < 0.99 ||
          probabilityScorecard.metrics.frontier_scaffold_complete.p < 0.95 ||
          !reasoningDebugCompleteGatePass ||
          !finalAnswerContractGatePass ||
          !uncertaintyResearchContractGatePass ||
          !researchTierCoverageGatePass ||
          !uncertaintyEstimatorGatePass ||
          !experimentalMathGuardGatePass ||
          !toolUseBudgetPackGatePass ||
          probabilityScorecard.metrics.objective_complete_before_finalize.p < 0.99 ||
          probabilityScorecard.metrics.objective_scoped_retrieval_success.p < 0.95 ||
          probabilityScorecard.metrics.objective_assembly_success.p < 0.95 ||
          minRouteCorrectByFamily < 0.9
        ? (runComplete ? "needs_patch" : "insufficient_run_quality")
        : "ship";
  const normalizedDecision = recommendationDecision;
  const decisionGradeReady = runComplete && provenanceGatePass;
  const nextPatches = [
    ...(!provenanceGatePass
      ? [
          {
            order: 0,
            title: "Validation provenance gate",
            why: "Require origin/main + HEAD provenance in reports before accepting decision-grade outcomes.",
          },
        ]
      : []),
    {
      order: 1,
      title: "Relation-mode fallback hardening",
      why: "Increase deterministic fallback usage when relation intent is selected but generated answer omits warp/ethos linkage signals.",
    },
    {
      order: 2,
      title: "Citation persistence guard",
      why: "Guarantee hybrid/repo responses keep at least one valid Sources line after final cleanup and repairs.",
    },
    {
      order: 3,
      title: "Stub environment policy split",
      why: "Separate decision-grade campaigns from stub-mode smoke runs to avoid polluted quality metrics.",
    },
    {
      order: 4,
      title: "Leakage and code-spill hardening",
      why: "Prevent debug/scaffold markers and accidental code fragments from surviving final answer cleanup.",
    },
  ];

  const recommendation = {
    summary_schema_version: 2,
    run_id: runId,
    decision: normalizedDecision,
    readiness_verdict: readinessVerdict,
    decision_grade_ready: decisionGradeReady,
    provenance_blocked: !provenanceGatePass,
    provenance_blocker_reason: provenanceBlockerReason,
    artifact_bundle_paths: runArtifactBundlePaths,
    diagnostics: {
      rollup: toDiagnosticRollup(rawRuns),
    },
    probability_scorecard: probabilityScorecard,
    representative_evidence: summary.representative_evidence,
    rationale: [
      `provenance_gate_pass=${String(provenanceGatePass)}`,
      `provenance_blocker_reason=${provenanceBlockerReason ?? "none"}`,
      `readiness_verdict=${readinessVerdict}`,
      `decision_grade_ready=${String(decisionGradeReady)}`,
      `git_branch=${gitProvenance.branch ?? "missing"}`,
      `git_head=${gitProvenance.head ?? "missing"}`,
      `git_origin_main=${gitProvenance.originMain ?? "missing"}`,
      `git_ahead_behind=${gitProvenance.aheadBehind ?? "missing"}`,
      `run_complete=${String(runComplete)}`,
      `expected_runs=${expectedRuns}`,
      `total_runs=${rawRuns.length}`,
      `terminated_early_reason=${terminatedEarlyReason ?? "none"}`,
      `global_cooldown_applied_ms=${globalCooldownAppliedMs}`,
      `resumed_from_latest=${String(resumedFromLatest)}`,
      `resumed_runs=${resumedRuns}`,
      `stub_text_detected_rate=${stubRate.toFixed(3)}`,
      `relation_packet_built_rate=${relationPacketBuiltRate.toFixed(3)}`,
      `relation_dual_domain_ok_rate=${relationDualDomainRate.toFixed(3)}`,
      `report_mode_correct_rate=${reportModeCorrectRate.toFixed(3)}`,
      `min_text_length_pass_rate=${minTextPassRate.toFixed(3)}`,
      `no_debug_leak=${probabilityScorecard.metrics.no_debug_leak.p.toFixed(3)}`,
      `no_runtime_fallback=${probabilityScorecard.metrics.no_runtime_fallback.p.toFixed(3)}`,
      `frontier_scaffold_complete=${probabilityScorecard.metrics.frontier_scaffold_complete.p.toFixed(3)}`,
      `reasoning_debug_complete=${probabilityScorecard.metrics.reasoning_debug_complete.p.toFixed(3)}`,
      `final_answer_contract_pass=${probabilityScorecard.metrics.final_answer_contract_pass.p.toFixed(3)}`,
      `uncertainty_research_contract_pass=${probabilityScorecard.metrics.uncertainty_research_contract_pass.p.toFixed(3)}`,
      `semantic_repo_tech_contract_pass=${probabilityScorecard.metrics.semantic_repo_tech_contract_pass.p.toFixed(3)}`,
      `claim_evidence_binding_pass=${probabilityScorecard.metrics.claim_evidence_binding_pass.p.toFixed(3)}`,
      `research_tier_coverage_pass=${probabilityScorecard.metrics.research_tier_coverage_pass.p.toFixed(3)}`,
      `uncertainty_estimator_present=${probabilityScorecard.metrics.uncertainty_estimator_present.p.toFixed(3)}`,
      `experimental_math_guard_pass=${probabilityScorecard.metrics.experimental_math_guard_pass.p.toFixed(3)}`,
      `tool_use_budget_pack_pass=${probabilityScorecard.metrics.tool_use_budget_pack_pass.p.toFixed(3)}`,
      `objective_complete_before_finalize=${probabilityScorecard.metrics.objective_complete_before_finalize.p.toFixed(3)}`,
      `objective_scoped_retrieval_success=${probabilityScorecard.metrics.objective_scoped_retrieval_success.p.toFixed(3)}`,
      `objective_assembly_success=${probabilityScorecard.metrics.objective_assembly_success.p.toFixed(3)}`,
      `route_correct_min_family=${minRouteCorrectByFamily.toFixed(3)}`,
    ],
    next_patches: nextPatches,
    hard_blockers: provenanceBlockerReason
      ? [{ kind: "provenance", severity: "HARD", reason: provenanceBlockerReason, blocks_ship: true }]
      : [],
  };

  await fs.writeFile(path.resolve(runOutDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(path.resolve(runOutDir, "failures.json"), `${JSON.stringify(failures, null, 2)}\n`, "utf8");
  await fs.writeFile(path.resolve(runOutDir, "recommendation.json"), `${JSON.stringify(recommendation, null, 2)}\n`, "utf8");
  await fs.writeFile(
    path.resolve(outRootDir, "latest.json"),
    `${JSON.stringify({ run_id: runId, output_run_dir: runOutDir, completed_at: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );

  const familyLines = (Object.entries(familySummary) as Array<[string, Record<string, number>]>).map(
    ([family, stats]) =>
      `| ${family} | ${stats.runs} | ${(stats.pass_rate * 100).toFixed(1)}% | ${typeof stats.intent_correct_rate === "number" ? `${(stats.intent_correct_rate * 100).toFixed(1)}%` : "n/a"} | ${typeof stats.report_mode_correct_rate === "number" ? `${(stats.report_mode_correct_rate * 100).toFixed(1)}%` : "n/a"} | ${(stats.stub_rate * 100).toFixed(1)}% | ${stats.p50_latency_ms.toFixed(0)} | ${stats.p95_latency_ms.toFixed(0)} |`,
  );

  const worstSection = worst
    .map((entry, index) => {
      const debug = entry.debug;
      return [
        `### Worst #${index + 1}: ${entry.prompt_id}`,
        `- family: ${entry.family}`,
        `- question: ${entry.question}`,
        `- failures: ${entry.failures.join(", ") || "none"}`,
        `- likely_root_cause: ${entry.likely_root_cause}`,
        `- patch_suggestion: ${entry.patch_suggestion}`,
        `- debug: intent_id=${String(debug.intent_id)} intent_domain=${String(debug.intent_domain)} intent_strategy=${String(debug.intent_strategy)} report_mode=${String(debug.report_mode)} relation_packet_built=${String(debug.relation_packet_built)} relation_dual_domain_ok=${String(debug.relation_dual_domain_ok)} deterministic_fallback_used_relation=${String(debug.deterministic_fallback_used_relation)} contract_parse_fail_rate_relation=${String(debug.contract_parse_fail_rate_relation)} citation_repair=${String(debug.citation_repair)}`,
        "- final_answer:",
        "```text",
        entry.answer,
        "```",
      ].join("\n");
    })
    .join("\n\n");

  const md = [
    "# Helix Ask Versatility Evaluation Report",
    "",
    `- summary_schema_version: 2`,
    `- git_branch: ${gitProvenance.branch ?? "missing"}`,
    `- git_head: ${gitProvenance.head ?? "missing"}`,
    `- git_origin_main: ${gitProvenance.originMain ?? "missing"}`,
    `- git_ahead_behind: ${gitProvenance.aheadBehind ?? "missing"}`,
    `- provenance_gate_pass: ${String(provenanceGatePass)}`,
    `- provenance_warnings: ${provenanceWarnings.length ? provenanceWarnings.join(", ") : "none"}`,
    `- readiness_verdict: ${readinessVerdict}`,
    `- decision_grade_ready: ${String(decisionGradeReady)}`,
    `- provenance_blocked: ${String(!provenanceGatePass)}`,
    `- provenance_hard_blocker_reason: ${provenanceBlockerReason ?? "none"}`,
    `- ship_recommendation_blocked_by_hard_blocker: ${String(Boolean(provenanceBlockerReason))}`,
    `- run_id: ${runId}`,
    `- base_url: ${BASE_URL}`,
    `- prompts: ${prompts.length}`,
    `- seeds: ${SEEDS.join(",")}`,
    `- temperatures: ${TEMPS.join(",")}`,
    `- expected_runs: ${expectedRuns}`,
    `- total_runs: ${rawRuns.length}`,
    `- run_complete: ${String(runComplete)}`,
    `- completion_rate: ${(100 * rawRuns.length / Math.max(1, expectedRuns)).toFixed(2)}%`,
    `- run_duration_ms: ${Date.now() - runEpoch}`,
    `- terminated_early_reason: ${terminatedEarlyReason ?? "none"}`,
    `- global_cooldown_applied_ms: ${globalCooldownAppliedMs}`,
    `- resumed_from_latest: ${String(resumedFromLatest)}`,
    `- resumed_runs: ${resumedRuns}`,
    `- output_run_dir: ${runOutDir}`,
    ...(provenanceBlockerReason
      ? [
          "",
          "## HARD BLOCKER",
          `- status: BLOCKED`,
          `- reason: ${provenanceBlockerReason}`,
          "- effect: ship recommendation is disallowed until provenance gate passes with origin/main + HEAD present.",
        ]
      : []),
    "",
    "## Aggregate by Prompt Family",
    "| family | runs | pass_rate | intent_correct_rate | report_mode_correct_rate | stub_rate | latency_p50_ms | latency_p95_ms |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...familyLines,
    "",
    "## Core Metrics",
    `- intent_id_correct_rate: ${(intentCorrectRate * 100).toFixed(2)}%`,
    `- report_mode_correct_rate: ${(reportModeCorrectRate * 100).toFixed(2)}%`,
    `- relation_packet_built_rate: ${(relationPacketBuiltRate * 100).toFixed(2)}%`,
    `- relation_dual_domain_ok_rate: ${(relationDualDomainRate * 100).toFixed(2)}%`,
    `- avg_attempts_per_run: ${avg(rawRuns.map((row) => row.attempts ?? 1)).toFixed(2)}`,
    `- p95_attempts_per_run: ${percentile(rawRuns.map((row) => row.attempts ?? 1), 95).toFixed(0)}`,
    `- stub_text_detected_rate: ${(stubRate * 100).toFixed(2)}%`,
    `- deterministic_fallback_relation_rate: ${(relationFallbackRate * 100).toFixed(2)}%`,
    `- contract_parse_fail_relation_rate: ${(parseFailRelationRate * 100).toFixed(2)}%`,
    `- citation_repair_rate: ${(repairRate * 100).toFixed(2)}%`,
    `- citation_presence_rate: ${(citationRate * 100).toFixed(2)}%`,
    `- min_text_length_pass_rate: ${(minTextPassRate * 100).toFixed(2)}%`,
    `- reasoning_debug_complete_rate: ${(reasoningDebugCompleteRate * 100).toFixed(2)}%`,
    `- final_answer_contract_pass_rate: ${(finalAnswerContractPassRate * 100).toFixed(2)}%`,
    `- uncertainty_research_contract_pass_rate: ${(uncertaintyResearchContractPassRate * 100).toFixed(2)}%`,
    `- semantic_repo_tech_contract_pass_rate: ${(semanticRepoTechContractPassRate * 100).toFixed(2)}%`,
    `- claim_evidence_binding_pass_rate: ${(claimEvidenceBindingPassRate * 100).toFixed(2)}%`,
    `- research_tier_coverage_pass_rate: ${(researchTierCoveragePassRate * 100).toFixed(2)}%`,
    `- uncertainty_estimator_present_rate: ${(uncertaintyEstimatorPresentRate * 100).toFixed(2)}%`,
    `- experimental_math_guard_pass_rate: ${(experimentalMathGuardPassRate * 100).toFixed(2)}%`,
    `- tool_use_budget_pack_pass_rate: ${(toolUseBudgetPackPassRate * 100).toFixed(2)}%`,
    `- debug_scaffold_leak_rate: ${(debugScaffoldLeakRate * 100).toFixed(2)}%`,
    `- code_fragment_spill_rate: ${(codeFragmentSpillRate * 100).toFixed(2)}%`,
    `- latency_total_p50_ms: ${percentile(totalLatencies, 50).toFixed(0)}`,
    `- latency_total_p95_ms: ${percentile(totalLatencies, 95).toFixed(0)}`,
    `- latency_retrieval_p50_ms: ${percentile(retrievalLatencies, 50).toFixed(0)} (samples=${retrievalLatencies.length})`,
    `- latency_retrieval_p95_ms: ${percentile(retrievalLatencies, 95).toFixed(0)} (samples=${retrievalLatencies.length})`,
    `- latency_synthesis_p50_ms: ${percentile(synthesisLatencies, 50).toFixed(0)} (samples=${synthesisLatencies.length})`,
    `- latency_synthesis_p95_ms: ${percentile(synthesisLatencies, 95).toFixed(0)} (samples=${synthesisLatencies.length})`,
    "",
    "## Probability Scorecard (Wilson 95%)",
    ...(["relation", "repo_technical", "ambiguous_general"] as const).map((family) => {
      const score = probabilityScorecard.metrics.route_correct_by_family[family];
      return `- route_correct|${family}: p=${score.p.toFixed(3)} ci95=[${score.ci95.low.toFixed(3)}, ${score.ci95.high.toFixed(3)}] n=${score.total}`;
    }),
    `- frontier_scaffold_complete: p=${probabilityScorecard.metrics.frontier_scaffold_complete.p.toFixed(3)} ci95=[${probabilityScorecard.metrics.frontier_scaffold_complete.ci95.low.toFixed(3)}, ${probabilityScorecard.metrics.frontier_scaffold_complete.ci95.high.toFixed(3)}] n=${probabilityScorecard.metrics.frontier_scaffold_complete.total}`,
    `- no_debug_leak: p=${probabilityScorecard.metrics.no_debug_leak.p.toFixed(3)} ci95=[${probabilityScorecard.metrics.no_debug_leak.ci95.low.toFixed(3)}, ${probabilityScorecard.metrics.no_debug_leak.ci95.high.toFixed(3)}] n=${probabilityScorecard.metrics.no_debug_leak.total}`,
    `- no_runtime_fallback: p=${probabilityScorecard.metrics.no_runtime_fallback.p.toFixed(3)} ci95=[${probabilityScorecard.metrics.no_runtime_fallback.ci95.low.toFixed(3)}, ${probabilityScorecard.metrics.no_runtime_fallback.ci95.high.toFixed(3)}] n=${probabilityScorecard.metrics.no_runtime_fallback.total}`,
    `- reasoning_debug_complete: p=${probabilityScorecard.metrics.reasoning_debug_complete.p.toFixed(3)} ci95=[${probabilityScorecard.metrics.reasoning_debug_complete.ci95.low.toFixed(3)}, ${probabilityScorecard.metrics.reasoning_debug_complete.ci95.high.toFixed(3)}] n=${probabilityScorecard.metrics.reasoning_debug_complete.total}`,
    `- final_answer_contract_pass: p=${probabilityScorecard.metrics.final_answer_contract_pass.p.toFixed(3)} ci95=[${probabilityScorecard.metrics.final_answer_contract_pass.ci95.low.toFixed(3)}, ${probabilityScorecard.metrics.final_answer_contract_pass.ci95.high.toFixed(3)}] n=${probabilityScorecard.metrics.final_answer_contract_pass.total}`,
    `- uncertainty_research_contract_pass: p=${probabilityScorecard.metrics.uncertainty_research_contract_pass.p.toFixed(3)} ci95=[${probabilityScorecard.metrics.uncertainty_research_contract_pass.ci95.low.toFixed(3)}, ${probabilityScorecard.metrics.uncertainty_research_contract_pass.ci95.high.toFixed(3)}] n=${probabilityScorecard.metrics.uncertainty_research_contract_pass.total}`,
    `- semantic_repo_tech_contract_pass: p=${probabilityScorecard.metrics.semantic_repo_tech_contract_pass.p.toFixed(3)} ci95=[${probabilityScorecard.metrics.semantic_repo_tech_contract_pass.ci95.low.toFixed(3)}, ${probabilityScorecard.metrics.semantic_repo_tech_contract_pass.ci95.high.toFixed(3)}] n=${probabilityScorecard.metrics.semantic_repo_tech_contract_pass.total}`,
    `- claim_evidence_binding_pass: p=${probabilityScorecard.metrics.claim_evidence_binding_pass.p.toFixed(3)} ci95=[${probabilityScorecard.metrics.claim_evidence_binding_pass.ci95.low.toFixed(3)}, ${probabilityScorecard.metrics.claim_evidence_binding_pass.ci95.high.toFixed(3)}] n=${probabilityScorecard.metrics.claim_evidence_binding_pass.total}`,
    `- research_tier_coverage_pass: p=${probabilityScorecard.metrics.research_tier_coverage_pass.p.toFixed(3)} ci95=[${probabilityScorecard.metrics.research_tier_coverage_pass.ci95.low.toFixed(3)}, ${probabilityScorecard.metrics.research_tier_coverage_pass.ci95.high.toFixed(3)}] n=${probabilityScorecard.metrics.research_tier_coverage_pass.total}`,
    `- uncertainty_estimator_present: p=${probabilityScorecard.metrics.uncertainty_estimator_present.p.toFixed(3)} ci95=[${probabilityScorecard.metrics.uncertainty_estimator_present.ci95.low.toFixed(3)}, ${probabilityScorecard.metrics.uncertainty_estimator_present.ci95.high.toFixed(3)}] n=${probabilityScorecard.metrics.uncertainty_estimator_present.total}`,
    `- experimental_math_guard_pass: p=${probabilityScorecard.metrics.experimental_math_guard_pass.p.toFixed(3)} ci95=[${probabilityScorecard.metrics.experimental_math_guard_pass.ci95.low.toFixed(3)}, ${probabilityScorecard.metrics.experimental_math_guard_pass.ci95.high.toFixed(3)}] n=${probabilityScorecard.metrics.experimental_math_guard_pass.total}`,
    `- tool_use_budget_pack_pass: p=${probabilityScorecard.metrics.tool_use_budget_pack_pass.p.toFixed(3)} ci95=[${probabilityScorecard.metrics.tool_use_budget_pack_pass.ci95.low.toFixed(3)}, ${probabilityScorecard.metrics.tool_use_budget_pack_pass.ci95.high.toFixed(3)}] n=${probabilityScorecard.metrics.tool_use_budget_pack_pass.total}`,
    `- objective_complete_before_finalize: p=${probabilityScorecard.metrics.objective_complete_before_finalize.p.toFixed(3)} ci95=[${probabilityScorecard.metrics.objective_complete_before_finalize.ci95.low.toFixed(3)}, ${probabilityScorecard.metrics.objective_complete_before_finalize.ci95.high.toFixed(3)}] n=${probabilityScorecard.metrics.objective_complete_before_finalize.total}`,
    `- objective_scoped_retrieval_success: p=${probabilityScorecard.metrics.objective_scoped_retrieval_success.p.toFixed(3)} ci95=[${probabilityScorecard.metrics.objective_scoped_retrieval_success.ci95.low.toFixed(3)}, ${probabilityScorecard.metrics.objective_scoped_retrieval_success.ci95.high.toFixed(3)}] n=${probabilityScorecard.metrics.objective_scoped_retrieval_success.total}`,
    `- objective_assembly_success: p=${probabilityScorecard.metrics.objective_assembly_success.p.toFixed(3)} ci95=[${probabilityScorecard.metrics.objective_assembly_success.ci95.low.toFixed(3)}, ${probabilityScorecard.metrics.objective_assembly_success.ci95.high.toFixed(3)}] n=${probabilityScorecard.metrics.objective_assembly_success.total}`,
    "",
    "## Representative Evidence Packs",
    `- pass: ${summary.representative_evidence.pass?.raw_record ?? "none"} (${summary.representative_evidence.pass?.prompt_id ?? "n/a"})`,
    `- fail: ${summary.representative_evidence.fail?.raw_record ?? "none"} (${summary.representative_evidence.fail?.prompt_id ?? "n/a"})`,
    "",
    "## Top Failure Signatures",
    ...topFailures.map((entry) => `- ${entry.key}: ${entry.count}`),
    "",
    "## Tie-in vs Prior Reports",
    "- This campaign extends relation-mode coverage beyond goal-zone by adding repo-technical and ambiguous prompt families at production endpoint scale.",
    "- Evidence-card and crossover studies emphasized quality/latency tradeoffs under controlled prompt sets; this report adds durability tracking across 90 prompt formulations with 3 seeded runs each.",
    "- Decision should prefer real-model reruns for release-grade quality gates whenever stub-text rate is non-zero.",
    "",
    "## 15 Worst Examples",
    worstSection,
    "",
    "## Recommendation",
    `- readiness_verdict: ${readinessVerdict}`,
    `- decision: ${normalizedDecision}`,
    ...recommendation.next_patches.map((patch) => `- [${patch.order}] ${patch.title}: ${patch.why}`),
  ].join("\n");

  await fs.writeFile(path.resolve(REPORT_PATH), `${md}\n`, "utf8");
  await fs.writeFile(path.resolve(runOutDir, "report.md"), `${md}\n`, "utf8");

  console.log(
    `[versatility] run=${runId} prompts=${prompts.length} expected_runs=${expectedRuns} runs=${rawRuns.length} run_complete=${String(
      runComplete,
    )} decision=${normalizedDecision} out=${runOutDir}`,
  );
  if (FAIL_ON_INCOMPLETE && !runComplete) {
    throw new Error(
      `versatility_run_incomplete expected=${expectedRuns} actual=${rawRuns.length} reason=${terminatedEarlyReason ?? "none"}`,
    );
  }
};

const isDirectRun =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1] as string) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main().catch((error) => {
    console.error("[versatility] failed", error);
    process.exit(1);
  });
}
