import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";

type CorpusTask = { id: string; prompt: string; expected_files: string[] };
type Corpus = { version: string; tasks: CorpusTask[] };
type VariantSpec = { name: string; atlasLane: "0" | "1"; gitTrackedLane: "0" | "1" };
type MatchMode = "exact" | "normalized" | "alias" | "none";

type ScenarioMetrics = {
  gold_file_recall_at_5: number;
  gold_file_recall_at_10: number;
  consequential_file_retention_rate: number;
  rerank_mrr10: number;
  graph_edge_hit_rate: number;
  retrieval_confidence_mean: number;
  retrieval_doc_share_mean: number;
  unmatched_expected_file_rate: number;
};

type TaskResult = {
  taskId: string;
  expected_files: string[];
  top5: string[];
  top10: string[];
  rawHits5: number;
  rawHits10: number;
  canonHits5: number;
  canonHits10: number;
  rawRR: number;
  canonRR: number;
  mode: MatchMode;
  mismatchReasons: string[];
  mismatchTaxonomy: Array<"path_form_mismatch" | "alias_unmapped" | "retrieval_miss" | "context_shape_mismatch">;
  expectedNormalized: string[];
  retrievedNormalizedTop10: string[];
  contextSource: "retrieval_context_files" | "context_files" | "none";
  top10Fingerprint: string;
  graphEdgeHit: boolean;
  confidence: number | null;
  docShare: number | null;
  atlasGraphSelectedCount: number;
  atlasGraphRuntimeLinkCount: number;
  atlasGraphEdgeTypeCounts: Record<string, number>;
  atlasGraphQueryOverlapCount: number;
  atlasGraphCorpusMemberCount: number;
  atlasGraphScriptDocBoostCount: number;
};

const CORPUS_PATH = process.env.HELIX_ASK_RETRIEVAL_CORPUS ?? "configs/repo-atlas-bench-corpus.v2.json";
const OUTPUT_ROOT = process.env.HELIX_ASK_RETRIEVAL_ABLATION_OUT_ROOT ?? "artifacts/experiments/helix-ask-retrieval-ablation";
const TOP_K = Number(process.env.HELIX_ASK_RETRIEVAL_TOPK ?? 18);
const MAX_TASKS = Number(process.env.HELIX_ASK_RETRIEVAL_MAX_TASKS ?? 0);
const SEEDS = String(process.env.HELIX_ASK_RETRIEVAL_SEEDS ?? "7,11,13").split(",").map((v) => Number(v.trim())).filter(Number.isFinite);
const TEMPS = String(process.env.HELIX_ASK_RETRIEVAL_TEMPERATURES ?? "0.2").split(",").map((v) => Number(v.trim())).filter(Number.isFinite);
const READY_TIMEOUT_MS = Number(process.env.HELIX_ASK_RETRIEVAL_READY_TIMEOUT_MS ?? 240_000);
const ASK_TIMEOUT_MS = Number(process.env.HELIX_ASK_RETRIEVAL_ASK_TIMEOUT_MS ?? 15_000);
const ASK_RETRY_ATTEMPTS = Number(process.env.HELIX_ASK_RETRIEVAL_ASK_RETRY_ATTEMPTS ?? 1);
const VARIANT_WATCHDOG_TIMEOUT_MS = Number(process.env.HELIX_ASK_RETRIEVAL_VARIANT_TIMEOUT_MS ?? 600_000);
const QUALITY_FLOOR_MAX_UNMATCHED = Number(process.env.HELIX_ASK_RETRIEVAL_QUALITY_FLOOR_MAX_UNMATCHED ?? 0.6);
const QUALITY_FLOOR_MIN_RECALL10 = Number(process.env.HELIX_ASK_RETRIEVAL_QUALITY_FLOOR_MIN_RECALL10 ?? 0.1);
const QUALITY_FLOOR_MIN_RETENTION = Number(process.env.HELIX_ASK_RETRIEVAL_QUALITY_FLOOR_MIN_RETENTION ?? 0.2);
const CORPUS_MAX_TEMPLATE_COLLISION = Number(process.env.HELIX_ASK_RETRIEVAL_CORPUS_MAX_TEMPLATE_COLLISION ?? 0.6);
const CORPUS_MIN_EXPECTED_TOKEN_HIT = Number(process.env.HELIX_ASK_RETRIEVAL_CORPUS_MIN_EXPECTED_TOKEN_HIT ?? 0.15);

const VARIANTS: VariantSpec[] = [
  { name: "baseline_atlas_git_on", atlasLane: "1", gitTrackedLane: "1" },
  { name: "atlas_off_git_on", atlasLane: "0", gitTrackedLane: "1" },
  { name: "atlas_on_git_off", atlasLane: "1", gitTrackedLane: "0" },
  { name: "atlas_off_git_off", atlasLane: "0", gitTrackedLane: "0" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const normalizePath = (s: string) => s.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase();
const EPS = 1e-9;
const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve("tsx/cli");

const findOpenPort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (!addr || typeof addr === "string") {
        probe.close(() => reject(new Error("failed to determine an open port")));
        return;
      }
      const { port } = addr;
      probe.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const numberRecordOrEmpty = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key) continue;
    const numeric = Number(entry);
    if (!Number.isFinite(numeric)) continue;
    out[key] = numeric;
  }
  return out;
};
const EVIDENCE_PREFIX = /^(file:|evidence:|repo:|path:)/i;
const REPO_PREFIX = /^\/?workspace\/casimirbot-\//i;
const TRAILING_LINE_SUFFIX = /:(\d+)(:\d+)?$/;
const normalizeEvidenceId = (raw: string) =>
  normalizePath(raw.trim().replace(/^`|`$/g, "").replace(EVIDENCE_PREFIX, "").replace(REPO_PREFIX, ""));
const normalizePathLoose = (raw: string) =>
  normalizePath(
    normalizeEvidenceId(raw)
      .replace(/[#?].*$/, "")
      .replace(TRAILING_LINE_SUFFIX, "")
      .replace(/\(\s*line\s+\d+\s*\)$/i, ""),
  );
const pathSegments = (raw: string) => normalizePathLoose(raw).split("/").filter(Boolean);
const pathTail = (raw: string, depth = 2) => {
  const parts = pathSegments(raw);
  return parts.slice(-depth).join("/");
};
const pathBase = (raw: string) => {
  const parts = pathSegments(raw);
  return parts.length ? parts[parts.length - 1] : normalizePathLoose(raw);
};
const pathRoot = (raw: string) => {
  const parts = pathSegments(raw);
  return parts.length ? parts[0] : "unknown";
};
const canonicalPathSet = (s: string) => {
  const n = normalizeEvidenceId(s);
  const set = new Set([n]);
  set.add(n.replace(/^\.\//, ""));
  if (n.startsWith("./")) set.add(n.slice(2));
  if (n.startsWith("server/src/")) set.add(n.replace("server/src/", "server/"));
  if (n.startsWith("src/server/")) set.add(n.replace("src/server/", "server/"));
  if (n.startsWith("client/src/")) set.add(n.replace("client/src/", "client/"));
  if (n.startsWith("client/")) set.add(`client/src/${n.slice("client/".length)}`);
  return set;
};
const aliasSet = (s: string) => {
  const set = canonicalPathSet(s);
  for (const n of [...set]) {
    if (n.startsWith("server/utils/")) set.add(n.replace("server/utils/", "server/"));
    if (n.startsWith("server/")) set.add(n.replace("server/", "server/utils/"));
    if (n.startsWith("docs/audits/")) set.add(n.replace("docs/audits/", "docs/reports/"));
    if (n.startsWith("docs/reports/")) set.add(n.replace("docs/reports/", "docs/audits/"));
  }
  return set;
};
const bestMode = (expected: string, candidates: string[]): MatchMode => {
  if (candidates.includes(expected)) return "exact";
  const cn = candidates.map(normalizeEvidenceId);
  const expectedForms = canonicalPathSet(expected);
  if (cn.some((candidate) => expectedForms.has(candidate))) return "normalized";
  const aliases = aliasSet(expected);
  return cn.some((c) => aliases.has(c)) ? "alias" : "none";
};
const normalizePromptTemplate = (prompt: string) =>
  prompt
    .toLowerCase()
    .replace(/\btask\s*\d+\b\.?/gi, "task")
    .replace(/\s+/g, " ")
    .trim();
const splitStemTokens = (value: string) =>
  value
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
const splitPromptTokens = (value: string) =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
const buildCorpusFidelity = (tasks: CorpusTask[]) => {
  const templates = tasks.map((task) => normalizePromptTemplate(task.prompt));
  const uniqueTemplateCount = new Set(templates).size;
  const templateCollisionRate = tasks.length ? 1 - uniqueTemplateCount / tasks.length : 0;
  const expectedTokenHitCount = tasks.filter((task) => {
    const promptTokens = new Set(splitPromptTokens(task.prompt));
    const expectedTokens = task.expected_files.flatMap((pathValue) => splitStemTokens(pathBase(pathValue)));
    return expectedTokens.some((token) => promptTokens.has(token));
  }).length;
  const expectedTokenHitRate = tasks.length ? expectedTokenHitCount / tasks.length : 0;
  const pass =
    templateCollisionRate <= CORPUS_MAX_TEMPLATE_COLLISION &&
    expectedTokenHitRate >= CORPUS_MIN_EXPECTED_TOKEN_HIT;
  return {
    thresholds: {
      max_template_collision_rate: CORPUS_MAX_TEMPLATE_COLLISION,
      min_expected_token_hit_rate: CORPUS_MIN_EXPECTED_TOKEN_HIT,
    },
    observed: {
      task_count: tasks.length,
      prompt_template_unique_count: uniqueTemplateCount,
      prompt_template_collision_rate: Number(templateCollisionRate.toFixed(6)),
      expected_token_hit_count: expectedTokenHitCount,
      expected_token_hit_rate: Number(expectedTokenHitRate.toFixed(6)),
    },
    checks: {
      template_collision_ok: templateCollisionRate <= CORPUS_MAX_TEMPLATE_COLLISION,
      expected_token_hit_ok: expectedTokenHitRate >= CORPUS_MIN_EXPECTED_TOKEN_HIT,
    },
    pass,
  };
};
const coerceDebugPathList = (value: unknown) => {
  if (!Array.isArray(value)) return { paths: [] as string[], shapeMismatch: false };
  const paths: string[] = [];
  let shapeMismatch = false;
  for (const entry of value) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed) paths.push(trimmed);
      continue;
    }
    if (entry && typeof entry === "object") {
      const candidate =
        typeof (entry as any).filePath === "string"
          ? (entry as any).filePath
          : typeof (entry as any).path === "string"
            ? (entry as any).path
            : typeof (entry as any).file === "string"
              ? (entry as any).file
              : null;
      if (candidate && candidate.trim()) {
        paths.push(candidate.trim());
        continue;
      }
    }
    shapeMismatch = true;
  }
  return { paths: Array.from(new Set(paths)), shapeMismatch };
};
const selectDebugContextFiles = (debug: Record<string, unknown> | null | undefined) => {
  const retrieval = coerceDebugPathList(debug?.retrieval_context_files);
  if (retrieval.paths.length > 0) {
    return {
      source: "retrieval_context_files" as const,
      paths: retrieval.paths,
      shapeMismatch: retrieval.shapeMismatch,
    };
  }
  const context = coerceDebugPathList(debug?.context_files);
  if (context.paths.length > 0) {
    return {
      source: "context_files" as const,
      paths: context.paths,
      shapeMismatch: retrieval.shapeMismatch || context.shapeMismatch,
    };
  }
  return {
    source: "none" as const,
    paths: [] as string[],
    shapeMismatch: retrieval.shapeMismatch || context.shapeMismatch,
  };
};
const fingerprintTop10 = (paths: string[]) =>
  paths.length ? paths.map(normalizeEvidenceId).slice(0, 10).join("|") : "<empty>";

const quantile = (vals: number[], q: number) => {
  if (!vals.length) return 0; const s=[...vals].sort((a,b)=>a-b); const i=(s.length-1)*q; const lo=Math.floor(i), hi=Math.ceil(i); if(lo===hi) return s[lo]; return s[lo]+(s[hi]-s[lo])*(i-lo);
};
let rngState = 123456789;
const rng = () => { rngState = (1664525 * rngState + 1013904223) >>> 0; return rngState / 0xffffffff; };
const ci95 = (vals: number[]) => {
  if (vals.length < 2) return { low: vals[0] ?? 0, high: vals[0] ?? 0 };
  const boots:number[]=[];
  for(let i=0;i<400;i++){ const sample:number[]=[]; for(let j=0;j<vals.length;j++) sample.push(vals[Math.floor(rng()*vals.length)]); boots.push(avg(sample)); }
  return { low: quantile(boots,0.025), high: quantile(boots,0.975) };
};

type ServerHandle = {
  child: ChildProcess;
  port: number;
  askUrl: string;
  readyUrl: string;
  stderrTail: string[];
};

const appendTail = (buffer: string[], chunk: string) => {
  const trimmed = chunk.trim();
  if (!trimmed) return;
  buffer.push(trimmed);
  if (buffer.length > 12) buffer.shift();
};

const startServer = async (variant: VariantSpec): Promise<ServerHandle> => {
  const port = await findOpenPort();
  const env = {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(port),
    SKIP_VITE_MIDDLEWARE: process.env.SKIP_VITE_MIDDLEWARE ?? "0",
    DISABLE_VITE_HMR: "1",
    HELIX_ASK_ATLAS_LANE: variant.atlasLane,
    HELIX_ASK_GIT_TRACKED_LANE: variant.gitTrackedLane,
    SKIP_MODULE_INIT: process.env.SKIP_MODULE_INIT ?? "1",
  };
  const child = spawn(process.execPath, [TSX_CLI, "server/index.ts"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderrTail: string[] = [];
  child.stderr?.on("data", (chunk) => appendTail(stderrTail, String(chunk)));
  child.on("error", (err) => appendTail(stderrTail, `spawn error: ${err.message}`));
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    child,
    port,
    askUrl: new URL("/api/agi/ask", baseUrl).toString(),
    readyUrl: new URL("/api/ready", baseUrl).toString(),
    stderrTail,
  };
};

const stopServer = async (handle: ServerHandle) => {
  const { child } = handle;
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 30; i += 1) {
    if (child.exitCode !== null) return;
    await sleep(100);
  }
  if (child.exitCode === null) child.kill("SIGKILL");
};

const waitReady = async (handle: ServerHandle) => {
  const attempts = Math.max(1, Math.ceil(READY_TIMEOUT_MS / 1000));
  for (let i = 0; i < attempts; i += 1) {
    if (handle.child.exitCode !== null) {
      throw new Error(
        `variant server exited before ready (port=${handle.port}, code=${handle.child.exitCode}) stderr=${handle.stderrTail.join(
          " | ",
        )}`,
      );
    }
    try {
      const r = await fetch(handle.readyUrl);
      const j = (await r.json()) as { ready?: boolean };
      if (j.ready) return;
    } catch {
      // keep polling until timeout
    }
    await sleep(1000);
  }
  throw new Error(`ready timeout (port=${handle.port}) stderr=${handle.stderrTail.join(" | ")}`);
};

const runTask = async (askUrl: string, task: CorpusTask, seed: number, temperature: number): Promise<TaskResult> => {
  let payload: {
    debug?: {
      context_files?: unknown;
      retrieval_context_files?: unknown;
      belief_graph_edge_count?: unknown;
      graph_evidence_count?: unknown;
      retrieval_confidence?: unknown;
      retrieval_doc_share?: unknown;
      retrieval_atlas_graph_selected_count?: unknown;
      retrieval_atlas_graph_runtime_link_count?: unknown;
      retrieval_atlas_graph_edge_type_counts?: unknown;
      retrieval_atlas_graph_query_overlap_count?: unknown;
      retrieval_atlas_graph_corpus_member_count?: unknown;
      retrieval_atlas_graph_script_doc_boost_count?: unknown;
    };
  } | null = null;
  for (let attempt=0; attempt<ASK_RETRY_ATTEMPTS; attempt+=1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
      const res = await fetch(askUrl, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ question: task.prompt, dryRun:true, debug:true, topK:TOP_K, seed, temperature, sessionId:`retrieval-ablation:${task.id}:${seed}:${temperature}` }), signal: controller.signal });
      payload = (await res.json()) as {
        debug?: {
          context_files?: unknown;
          retrieval_context_files?: unknown;
          belief_graph_edge_count?: unknown;
          graph_evidence_count?: unknown;
          retrieval_confidence?: unknown;
          retrieval_doc_share?: unknown;
          retrieval_atlas_graph_selected_count?: unknown;
          retrieval_atlas_graph_runtime_link_count?: unknown;
          retrieval_atlas_graph_edge_type_counts?: unknown;
          retrieval_atlas_graph_query_overlap_count?: unknown;
          retrieval_atlas_graph_corpus_member_count?: unknown;
          retrieval_atlas_graph_script_doc_boost_count?: unknown;
        };
      };
      break;
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  if (!payload) {
    return {
      taskId: task.id,
      expected_files: task.expected_files,
      top5: [],
      top10: [],
      rawHits5: 0,
      rawHits10: 0,
      canonHits5: 0,
      canonHits10: 0,
      rawRR: 0,
      canonRR: 0,
      mode: "none",
      mismatchReasons: task.expected_files.map((expected) => `${expected}:retrieval_miss`),
      mismatchTaxonomy: ["retrieval_miss"],
      expectedNormalized: task.expected_files.map(normalizeEvidenceId),
      retrievedNormalizedTop10: [],
      contextSource: "none",
      top10Fingerprint: "<empty>",
      graphEdgeHit: false,
      confidence: null,
      docShare: null,
      atlasGraphSelectedCount: 0,
      atlasGraphRuntimeLinkCount: 0,
      atlasGraphEdgeTypeCounts: {},
      atlasGraphQueryOverlapCount: 0,
      atlasGraphCorpusMemberCount: 0,
      atlasGraphScriptDocBoostCount: 0,
    };
  }
  const selectedContext = selectDebugContextFiles((payload.debug ?? null) as Record<string, unknown> | null);
  const contextShapeMismatch = selectedContext.shapeMismatch;
  const top10 = selectedContext.paths.slice(0, 10);
  const top5 = top10.slice(0,5);
  const modes = task.expected_files.map((e)=>bestMode(e, top10));
  const mismatchTaxonomy = new Set<"path_form_mismatch" | "alias_unmapped" | "retrieval_miss" | "context_shape_mismatch">();
  if (contextShapeMismatch) mismatchTaxonomy.add("context_shape_mismatch");
  const mismatchReasons = task.expected_files.flatMap((expected) => {
    const mode = bestMode(expected, top10);
    if (mode !== "none") return [];
    if (!top10.length) {
      mismatchTaxonomy.add("retrieval_miss");
      return [`${expected}:retrieval_miss`];
    }
    const looseExpected = normalizePathLoose(expected);
    const looseCandidates = top10.map(normalizePathLoose);
    if (looseCandidates.includes(looseExpected)) {
      mismatchTaxonomy.add("path_form_mismatch");
      return [`${expected}:path_form_mismatch`];
    }
    const expectedBase = pathBase(expected);
    const expectedTail = pathTail(expected, 2);
    const aliasCandidatePresent = looseCandidates.some(
      (candidate) => pathBase(candidate) === expectedBase || pathTail(candidate, 2) === expectedTail,
    );
    if (aliasCandidatePresent) {
      mismatchTaxonomy.add("alias_unmapped");
      return [`${expected}:alias_unmapped`];
    }
    mismatchTaxonomy.add("retrieval_miss");
    return [`${expected}:retrieval_miss`];
  });
  const rawHits10 = task.expected_files.filter((e)=>top10.includes(e)).length;
  const rawHits5 = task.expected_files.filter((e)=>top5.includes(e)).length;
  const canonHits10 = modes.filter((m)=>m!=="none").length;
  const canonHits5 = task.expected_files.filter((e)=>bestMode(e, top5)!=="none").length;
  const rank = (cand:string[]) => { for(let i=0;i<cand.length;i++) if(task.expected_files.includes(cand[i])) return 1/(i+1); return 0; };
  const canonRank = () => { for(let i=0;i<top10.length;i++) if(task.expected_files.some((e)=>bestMode(e,[top10[i]])!=="none")) return 1/(i+1); return 0; };
  const mode:MatchMode = modes.includes("exact")?"exact":modes.includes("normalized")?"normalized":modes.includes("alias")?"alias":"none";
  const edgeCount =
    numberOrNull(payload.debug?.belief_graph_edge_count) ??
    numberOrNull(payload.debug?.graph_evidence_count) ??
    0;
  const atlasGraphSelectedCount = Math.max(
    0,
    numberOrNull(payload.debug?.retrieval_atlas_graph_selected_count) ?? 0,
  );
  const atlasGraphRuntimeLinkCount = Math.max(
    0,
    numberOrNull(payload.debug?.retrieval_atlas_graph_runtime_link_count) ?? 0,
  );
  const atlasGraphEdgeTypeCounts = numberRecordOrEmpty(payload.debug?.retrieval_atlas_graph_edge_type_counts);
  const atlasGraphQueryOverlapCount = Math.max(
    0,
    numberOrNull(payload.debug?.retrieval_atlas_graph_query_overlap_count) ?? 0,
  );
  const atlasGraphCorpusMemberCount = Math.max(
    0,
    numberOrNull(payload.debug?.retrieval_atlas_graph_corpus_member_count) ?? 0,
  );
  const atlasGraphScriptDocBoostCount = Math.max(
    0,
    numberOrNull(payload.debug?.retrieval_atlas_graph_script_doc_boost_count) ?? 0,
  );
  return {
    taskId: task.id,
    expected_files: task.expected_files,
    top5,
    top10,
    rawHits5,
    rawHits10,
    canonHits5,
    canonHits10,
    rawRR: rank(top10),
    canonRR: canonRank(),
    mode,
    mismatchReasons,
    mismatchTaxonomy: [...mismatchTaxonomy],
    expectedNormalized: task.expected_files.map(normalizeEvidenceId),
    retrievedNormalizedTop10: top10.map(normalizeEvidenceId),
    contextSource: selectedContext.source,
    top10Fingerprint: fingerprintTop10(top10),
    graphEdgeHit: edgeCount > 0,
    confidence: numberOrNull(payload.debug?.retrieval_confidence),
    docShare: numberOrNull(payload.debug?.retrieval_doc_share),
    atlasGraphSelectedCount,
    atlasGraphRuntimeLinkCount,
    atlasGraphEdgeTypeCounts,
    atlasGraphQueryOverlapCount,
    atlasGraphCorpusMemberCount,
    atlasGraphScriptDocBoostCount,
  };
};


const withWatchdog = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`watchdog_timeout:${label}:${VARIANT_WATCHDOG_TIMEOUT_MS}ms`)), VARIANT_WATCHDOG_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const summarize = (results: TaskResult[], canonical: boolean): ScenarioMetrics => {
  const expected = results.reduce((n,r)=>n+r.expected_files.length,0);
  const hit5 = results.reduce((n,r)=>n+(canonical?r.canonHits5:r.rawHits5),0);
  const hit10 = results.reduce((n,r)=>n+(canonical?r.canonHits10:r.rawHits10),0);
  return {
    gold_file_recall_at_5: expected?hit5/expected:0,
    gold_file_recall_at_10: expected?hit10/expected:0,
    consequential_file_retention_rate: results.length?results.filter((r)=>(canonical?r.canonHits10:r.rawHits10)>0).length/results.length:0,
    rerank_mrr10: avg(results.map((r)=>canonical?r.canonRR:r.rawRR)),
    graph_edge_hit_rate: avg(results.map((r)=>r.graphEdgeHit?1:0)),
    retrieval_confidence_mean: avg(results.flatMap((r)=>r.confidence==null?[]:[r.confidence])),
    retrieval_doc_share_mean: avg(results.flatMap((r)=>r.docShare==null?[]:[r.docShare])),
    unmatched_expected_file_rate: results.length?results.filter((r)=>r.mode==="none").length/results.length:0,
  };
};

const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`${label}:watchdog_timeout_ms=${ms}`)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
};


const MISMATCH_REASON_NAMES = new Set([
  "path_form_mismatch",
  "alias_unmapped",
  "retrieval_miss",
  "context_shape_mismatch",
]);

const parseMismatchReason = (reason: unknown): string | null => {
  const raw =
    typeof reason === "string"
      ? reason
      : reason && typeof reason === "object"
        ? typeof (reason as any).reason === "string"
          ? (reason as any).reason
          : typeof (reason as any).code === "string"
            ? (reason as any).code
            : typeof (reason as any).type === "string"
              ? (reason as any).type
              : null
        : null;
  if (!raw) return null;
  const segments = raw
    .split(":")
    .map((segment) => segment.trim())
    .filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (segment && MISMATCH_REASON_NAMES.has(segment)) return segment;
  }
  return null;
};

const inferStageFaultMatrix = (variant: any) => {
  const tasks = Array.isArray(variant?.diagnostics?.mismatch_reasons) ? variant.diagnostics.mismatch_reasons : [];
  if (!tasks.length) {
    return {
      retrieval: 0,
      candidate_filtering: 0,
      rerank: 0,
      synthesis_packing: 0,
      final_cleanup: 0,
    };
  }
  let retrievalCount = 0;
  let candidateFilteringCount = 0;
  let rerankCount = 0;
  let synthesisPackingCount = 0;
  let finalCleanupCount = 0;
  for (const task of tasks) {
    const reasonSet = new Set(
      Array.isArray(task?.mismatchReasons)
        ? task.mismatchReasons.map((reason: unknown) => parseMismatchReason(reason)).filter(Boolean)
        : [],
    );
    const hasRetrieval = reasonSet.has("retrieval_miss");
    const hasCandidateFiltering = reasonSet.has("alias_unmapped");
    const hasRerank = reasonSet.has("path_form_mismatch");
    const hasSynthesisPacking = reasonSet.has("context_shape_mismatch");
    if (hasRetrieval) retrievalCount += 1;
    if (hasCandidateFiltering) candidateFilteringCount += 1;
    if (hasRerank) rerankCount += 1;
    if (hasSynthesisPacking) synthesisPackingCount += 1;
    if (!hasRetrieval && !hasCandidateFiltering && !hasRerank && !hasSynthesisPacking) {
      finalCleanupCount += 1;
    }
  }
  const total = tasks.length;
  const retrieval = retrievalCount / total;
  const candidateFiltering = candidateFilteringCount / total;
  const rerank = rerankCount / total;
  const synthesisPacking = synthesisPackingCount / total;
  const finalCleanup = finalCleanupCount / total;
  return {
    retrieval,
    candidate_filtering: candidateFiltering,
    rerank,
    synthesis_packing: synthesisPacking,
    final_cleanup: finalCleanup,
  };
};

const classifyFaultOwner = (matrix: { retrieval: number; candidate_filtering: number; rerank: number; synthesis_packing: number; final_cleanup: number }) => {
  const retrievalMass = matrix.retrieval;
  const routingMass = matrix.candidate_filtering;
  const postProcessingMass = matrix.rerank + matrix.synthesis_packing + matrix.final_cleanup;
  if (retrievalMass >= routingMass && retrievalMass >= postProcessingMass) return "retrieval";
  if (routingMass >= postProcessingMass) return "routing";
  return "post_processing";
};

const main = async () => {
  const corpus = JSON.parse(await fs.readFile(CORPUS_PATH, "utf8")) as Corpus;
  const tasks = [...corpus.tasks].sort((a,b)=>a.id.localeCompare(b.id));
  const scoped = MAX_TASKS>0?tasks.slice(0,MAX_TASKS):tasks;
  const corpusFidelity = buildCorpusFidelity(scoped);
  const runId=`retrieval-ablation-${Date.now()}`; const outDir=path.join(OUTPUT_ROOT,runId); await fs.mkdir(outDir,{recursive:true});
  const score: any = {
    runId,
    generatedAt:new Date().toISOString(),
    seeds:SEEDS,
    temperatures:TEMPS,
    maxTasks: MAX_TASKS,
    expectedTaskCount: scoped.length,
    expectedScenarioCount: VARIANTS.length * SEEDS.length * TEMPS.length,
    corpus_fidelity: corpusFidelity,
    run_complete: false,
    blocked_reason: null,
    variants:{},
  };
  let completedScenarioCount = 0;

  for (const variant of VARIANTS) {
    const server = await startServer(variant);
    try {
      await withWatchdog(`variant:${variant.name}:ready`, async () => {
        await waitReady(server);
      });
      const scenarios:any[]=[];
      for (const seed of SEEDS) for (const temperature of TEMPS) {
        console.log(`[ablation] variant=${variant.name} seed=${seed} temperature=${temperature} tasks=${scoped.length}`);
        const results:TaskResult[]=[];
        await withWatchdog(`variant:${variant.name}:seed:${seed}:temp:${temperature}`, async () => {
          for (const task of scoped) {
            results.push(await runTask(server.askUrl, task,seed,temperature));
          }
        });
        const raw = summarize(results,false); const canon = summarize(results,true);
        scenarios.push({ seed, temperature, raw_metrics: raw, canonicalized_metrics: canon, task_results: results });
        completedScenarioCount += 1;
      }
      const metrics = [
        "gold_file_recall_at_5",
        "gold_file_recall_at_10",
        "consequential_file_retention_rate",
        "rerank_mrr10",
        "graph_edge_hit_rate",
        "retrieval_confidence_mean",
        "retrieval_doc_share_mean",
        "unmatched_expected_file_rate",
      ] as const;
      const aggregate:any={};
      for(const m of metrics){ const vals=scenarios.map((s)=>s.canonicalized_metrics[m] ?? s.raw_metrics[m]); aggregate[m]={ point_estimate:avg(vals), ci95:ci95(vals) }; }
      const flattenedTaskResults = scenarios.flatMap((scenario) =>
        scenario.task_results.map((taskResult: TaskResult) => ({
          seed: scenario.seed,
          temperature: scenario.temperature,
          taskId: taskResult.taskId,
          expectedRoot: pathRoot(taskResult.expected_files[0] ?? ""),
          mode: taskResult.mode,
          mismatchReasons: taskResult.mismatchReasons,
          mismatchTaxonomy: taskResult.mismatchTaxonomy,
          expectedNormalized: taskResult.expectedNormalized,
          retrievedNormalizedTop10: taskResult.retrievedNormalizedTop10,
          contextSource: taskResult.contextSource,
          top10Fingerprint: taskResult.top10Fingerprint,
          atlasGraphSelectedCount: taskResult.atlasGraphSelectedCount,
          atlasGraphRuntimeLinkCount: taskResult.atlasGraphRuntimeLinkCount,
          atlasGraphEdgeTypeCounts: taskResult.atlasGraphEdgeTypeCounts,
          atlasGraphQueryOverlapCount: taskResult.atlasGraphQueryOverlapCount,
          atlasGraphCorpusMemberCount: taskResult.atlasGraphCorpusMemberCount,
          atlasGraphScriptDocBoostCount: taskResult.atlasGraphScriptDocBoostCount,
        })),
      );
      const mismatchCounts = flattenedTaskResults.reduce(
        (
          counts: Record<
            "path_form_mismatch" | "alias_unmapped" | "retrieval_miss" | "context_shape_mismatch",
            number
          >,
          task,
        ) => {
          for (const reason of task.mismatchTaxonomy as Array<
            "path_form_mismatch" | "alias_unmapped" | "retrieval_miss" | "context_shape_mismatch"
          >) {
            counts[reason] += 1;
          }
          return counts;
        },
        {
          path_form_mismatch: 0,
          alias_unmapped: 0,
          retrieval_miss: 0,
          context_shape_mismatch: 0,
        },
      );
      const contextSourceCounts = flattenedTaskResults.reduce(
        (
          counts: Record<"retrieval_context_files" | "context_files" | "none", number>,
          task,
        ) => {
          const key =
            task.contextSource === "retrieval_context_files" ||
            task.contextSource === "context_files" ||
            task.contextSource === "none"
              ? task.contextSource
              : "none";
          counts[key] += 1;
          return counts;
        },
        {
          retrieval_context_files: 0,
          context_files: 0,
          none: 0,
        },
      );
      const fingerprintCounts = flattenedTaskResults.reduce((counts: Map<string, number>, task) => {
        const key = typeof task.top10Fingerprint === "string" && task.top10Fingerprint.length > 0 ? task.top10Fingerprint : "<empty>";
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return counts;
      }, new Map<string, number>());
      const fingerprintEntries = [...fingerprintCounts.entries()].sort((a, b) => b[1] - a[1]);
      const [dominantFingerprint, dominantFingerprintCount] = fingerprintEntries[0] ?? ["<empty>", 0];
      const fingerprintTotal = flattenedTaskResults.length;
      const fingerprintUniqueCount = fingerprintEntries.length;
      const fingerprintUniqueRate = fingerprintTotal > 0 ? fingerprintUniqueCount / fingerprintTotal : 0;
      const fingerprintDominantShare = fingerprintTotal > 0 ? dominantFingerprintCount / fingerprintTotal : 0;
      const dominantFingerprintSample =
        dominantFingerprint === "<empty>"
          ? "<empty>"
          : dominantFingerprint.split("|").slice(0, 3).join("|");
      const missBucketCounts = flattenedTaskResults.reduce(
        (
          counts: Record<"scripts" | "docs" | "server" | "client" | "other", number>,
          task,
        ) => {
          if (task.mode !== "none") return counts;
          const root = String(task.expectedRoot ?? "other");
          if (root === "scripts" || root === "docs" || root === "server" || root === "client") {
            counts[root] += 1;
          } else {
            counts.other += 1;
          }
          return counts;
        },
        { scripts: 0, docs: 0, server: 0, client: 0, other: 0 },
      );
      const missTotal =
        missBucketCounts.scripts +
        missBucketCounts.docs +
        missBucketCounts.server +
        missBucketCounts.client +
        missBucketCounts.other;
      const missBucketRates = {
        scripts: missTotal > 0 ? missBucketCounts.scripts / missTotal : 0,
        docs: missTotal > 0 ? missBucketCounts.docs / missTotal : 0,
        server: missTotal > 0 ? missBucketCounts.server / missTotal : 0,
        client: missTotal > 0 ? missBucketCounts.client / missTotal : 0,
        other: missTotal > 0 ? missBucketCounts.other / missTotal : 0,
      };
      const graphSelectedTaskCount = flattenedTaskResults.filter((task) => task.atlasGraphSelectedCount > 0).length;
      const graphRuntimeLinkTaskCount = flattenedTaskResults.filter(
        (task) => task.atlasGraphRuntimeLinkCount > 0,
      ).length;
      const graphQueryOverlapTaskCount = flattenedTaskResults.filter(
        (task) => task.atlasGraphQueryOverlapCount > 0,
      ).length;
      const graphCorpusMemberTaskCount = flattenedTaskResults.filter(
        (task) => task.atlasGraphCorpusMemberCount > 0,
      ).length;
      const graphScriptDocBoostTaskCount = flattenedTaskResults.filter(
        (task) => task.atlasGraphScriptDocBoostCount > 0,
      ).length;
      const graphEdgeTypeCounts = flattenedTaskResults.reduce((counts: Record<string, number>, task) => {
        for (const [edgeType, count] of Object.entries(task.atlasGraphEdgeTypeCounts ?? {})) {
          const numeric = Number(count);
          if (!Number.isFinite(numeric)) continue;
          counts[edgeType] = (counts[edgeType] ?? 0) + numeric;
        }
        return counts;
      }, {});
      const graphExpansionContributionRate =
        flattenedTaskResults.length > 0 ? graphSelectedTaskCount / flattenedTaskResults.length : 0;
      const graphRuntimeLinkRate =
        flattenedTaskResults.length > 0 ? graphRuntimeLinkTaskCount / flattenedTaskResults.length : 0;
      const graphQueryOverlapRate =
        flattenedTaskResults.length > 0 ? graphQueryOverlapTaskCount / flattenedTaskResults.length : 0;
      const graphCorpusMemberRate =
        flattenedTaskResults.length > 0 ? graphCorpusMemberTaskCount / flattenedTaskResults.length : 0;
      const graphScriptDocBoostRate =
        flattenedTaskResults.length > 0 ? graphScriptDocBoostTaskCount / flattenedTaskResults.length : 0;
      const diagnostics = {
        unmatched_expected_file_rate: avg(scenarios.map((s)=>s.raw_metrics.unmatched_expected_file_rate)),
        expected_file_match_mode: {
          exact: flattenedTaskResults.filter((task) => task.mode === "exact").length,
          normalized: flattenedTaskResults.filter((task) => task.mode === "normalized").length,
          alias: flattenedTaskResults.filter((task) => task.mode === "alias").length,
          none: flattenedTaskResults.filter((task) => task.mode === "none").length,
        },
        mismatch_taxonomy_counts: mismatchCounts,
        context_file_source_counts: contextSourceCounts,
        top10_fingerprint_unique_count: fingerprintUniqueCount,
        top10_fingerprint_total_count: fingerprintTotal,
        top10_fingerprint_unique_rate: Number(fingerprintUniqueRate.toFixed(6)),
        top10_fingerprint_dominant_count: dominantFingerprintCount,
        top10_fingerprint_dominant_share: Number(fingerprintDominantShare.toFixed(6)),
        top10_fingerprint_dominant_sample: dominantFingerprintSample,
        top10_fingerprint_collapse_flag: fingerprintDominantShare >= 0.8,
        miss_bucket_counts: missBucketCounts,
        miss_bucket_rates: {
          scripts: Number(missBucketRates.scripts.toFixed(6)),
          docs: Number(missBucketRates.docs.toFixed(6)),
          server: Number(missBucketRates.server.toFixed(6)),
          client: Number(missBucketRates.client.toFixed(6)),
          other: Number(missBucketRates.other.toFixed(6)),
        },
        graph_expansion_contribution_rate: Number(graphExpansionContributionRate.toFixed(6)),
        graph_runtime_link_rate: Number(graphRuntimeLinkRate.toFixed(6)),
        graph_query_overlap_rate: Number(graphQueryOverlapRate.toFixed(6)),
        graph_corpus_member_rate: Number(graphCorpusMemberRate.toFixed(6)),
        graph_script_doc_boost_rate: Number(graphScriptDocBoostRate.toFixed(6)),
        graph_selected_task_count: graphSelectedTaskCount,
        graph_runtime_link_task_count: graphRuntimeLinkTaskCount,
        graph_query_overlap_task_count: graphQueryOverlapTaskCount,
        graph_corpus_member_task_count: graphCorpusMemberTaskCount,
        graph_script_doc_boost_task_count: graphScriptDocBoostTaskCount,
        graph_edge_type_counts: graphEdgeTypeCounts,
        mismatch_reasons: flattenedTaskResults.filter((task) => task.mismatchReasons.length > 0),
      };
      const stage_fault_matrix = inferStageFaultMatrix({ diagnostics });
      const fault_owner = classifyFaultOwner(stage_fault_matrix);
      score.variants[variant.name]={
        scenarios,
        aggregate,
        diagnostics,
        stage_fault_matrix,
        fault_owner,
      };
      await fs.writeFile(path.join(outDir,`${variant.name}.json`),JSON.stringify(score.variants[variant.name],null,2)+"\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      score.blocked_reason = `variant_failed:${variant.name}:${message}`;
      score.variants[variant.name] = {
        ...(score.variants[variant.name] ?? {}),
        status: "blocked",
        fail_reason: message,
      };
      await fs.writeFile(path.join(outDir,"summary.partial.json"),JSON.stringify({ ...score, completedScenarioCount },null,2)+"\n");
      console.error(`[ablation] blocked ${score.blocked_reason}`);
      break;
    } finally { await stopServer(server); }
  }

  score.completedScenarioCount = completedScenarioCount;
  score.run_complete = score.blocked_reason === null && completedScenarioCount === score.expectedScenarioCount;

  if (!score.run_complete) {
    score.driver_verdict = {
      retrieval_lift_proven: "no",
      dominant_channel: "none",
      contributions: { atlas: 0, git_tracked: 0 },
      contribution_ci95: {
        atlas: { low: 0, high: 0 },
        git_tracked: { low: 0, high: 0 },
      },
      bounded_confidence: false,
      strict_gate: {
        positive_lane_ablation_delta: false,
        bounded_confidence: false,
        fault_owner_points_to_retrieval: false,
        quality_floor_passed: false,
        eval_fidelity_passed: score.corpus_fidelity?.pass === true,
      },
      quality_floor: {
        thresholds: {
          max_unmatched_expected_file_rate: QUALITY_FLOOR_MAX_UNMATCHED,
          min_gold_file_recall_at_10: QUALITY_FLOOR_MIN_RECALL10,
          min_consequential_file_retention_rate: QUALITY_FLOOR_MIN_RETENTION,
        },
        observed: null,
        checks: {
          unmatched_expected_file_rate_ok: false,
          gold_file_recall_at_10_ok: false,
          consequential_file_retention_rate_ok: false,
        },
        pass: false,
      },
      corpus_fidelity: score.corpus_fidelity,
      stage_fault_matrix: null,
      fault_owner: "unknown",
      status: "blocked",
      blocked_reason: score.blocked_reason ?? "unknown",
      confidence_statement: "run blocked before complete scenario set",
    };
    const jsonPath = "reports/helix-ask-retrieval-ablation-scorecard-2026-03-03.json";
    const mdPath = "reports/helix-ask-retrieval-ablation-scorecard-2026-03-03.md";
    await fs.writeFile(path.join(outDir,"summary.comparison.json"),JSON.stringify(score,null,2)+"\n");
    await fs.writeFile(
      path.join(outDir,"summary.comparison.md"),
      [
        `# Helix Ask Retrieval Ablation Summary (BLOCKED)`,
        "",
        `Run: ${runId}`,
        `run_complete=false`,
        `blocked_reason=${score.blocked_reason ?? "unknown"}`,
        `completedScenarioCount=${completedScenarioCount}/${score.expectedScenarioCount}`,
        "",
      ].join("\n"),
    );
    await fs.writeFile(jsonPath,JSON.stringify(score,null,2)+"\n");
    await fs.writeFile(
      mdPath,
      [
        "# Helix Ask Retrieval Ablation Scorecard (2026-03-03)",
        "",
        `Run: ${runId}`,
        "run_complete=false",
        `blocked_reason=${score.blocked_reason ?? "unknown"}`,
        `completedScenarioCount=${completedScenarioCount}/${score.expectedScenarioCount}`,
        "",
        "Driver verdict: retrieval_lift_proven=no, dominant_channel=none (blocked run).",
        `Quality floor pass: false (run blocked).`,
        `Corpus fidelity pass: ${Boolean(score.corpus_fidelity?.pass)}.`,
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      "reports/helix-ask-retrieval-stage-fault-matrix-2026-03-04.md",
      [
        "# Helix Ask Retrieval Stage-Fault Matrix (2026-03-04)",
        "",
        `Run: ${runId}`,
        "Fault owner: unknown (blocked run)",
        "",
        "No stage matrix emitted because run was blocked before full scenario completion.",
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      "reports/helix-ask-retrieval-attribution-go-no-go-2026-03-03.md",
      [
        "# Helix Ask Retrieval Attribution Go/No-Go (2026-03-03)",
        "",
        `Run: ${runId}`,
        "run_complete=false",
        `blocked_reason=${score.blocked_reason ?? "unknown"}`,
        "",
        "retrieval_lift_proven=no",
        "dominant_channel=none",
        "fault_owner=unknown",
        "quality_floor_pass=false",
        `eval_fidelity_pass=${Boolean(score.corpus_fidelity?.pass)}`,
        "",
        "Decision: NO-GO for retrieval-lift claim (run blocked before complete scenario set).",
        "",
      ].join("\n"),
    );
    console.error(`Ablation blocked artifacts written to ${outDir}`);
    process.exitCode = 1;
    return;
  }

  const base = score.variants.baseline_atlas_git_on.aggregate.gold_file_recall_at_10.point_estimate;
  const atlasOff = score.variants.atlas_off_git_on.aggregate.gold_file_recall_at_10.point_estimate;
  const gitOff = score.variants.atlas_on_git_off.aggregate.gold_file_recall_at_10.point_estimate;
  const atlasContribution = base - atlasOff;
  const gitContribution = base - gitOff;
  const maxContribution = Math.max(atlasContribution, gitContribution);
  let dominantChannel = "none";
  if (maxContribution > EPS) {
    if (Math.abs(atlasContribution - gitContribution) <= EPS) dominantChannel = "mixed";
    else dominantChannel = atlasContribution > gitContribution ? "atlas" : "git";
  }
  const baseCI = score.variants.baseline_atlas_git_on.aggregate.gold_file_recall_at_10.ci95;
  const atlasOffCI = score.variants.atlas_off_git_on.aggregate.gold_file_recall_at_10.ci95;
  const gitOffCI = score.variants.atlas_on_git_off.aggregate.gold_file_recall_at_10.ci95;
  const atlasDeltaCI = { low: baseCI.low - atlasOffCI.high, high: baseCI.high - atlasOffCI.low };
  const gitDeltaCI = { low: baseCI.low - gitOffCI.high, high: baseCI.high - gitOffCI.low };
  const boundedConfidence = atlasDeltaCI.low > 0 || gitDeltaCI.low > 0;
  const baselineVariant = score.variants.baseline_atlas_git_on;
  const unmatchedRate = baselineVariant.diagnostics.unmatched_expected_file_rate;
  const recall10 = score.variants.baseline_atlas_git_on.aggregate.gold_file_recall_at_10.point_estimate;
  const retention = score.variants.baseline_atlas_git_on.aggregate.consequential_file_retention_rate.point_estimate;
  const qualityFloorChecks = {
    unmatched_expected_file_rate_ok: unmatchedRate <= QUALITY_FLOOR_MAX_UNMATCHED,
    gold_file_recall_at_10_ok: recall10 >= QUALITY_FLOOR_MIN_RECALL10,
    consequential_file_retention_rate_ok: retention >= QUALITY_FLOOR_MIN_RETENTION,
  };
  const qualityFloorPassed =
    qualityFloorChecks.unmatched_expected_file_rate_ok &&
    qualityFloorChecks.gold_file_recall_at_10_ok &&
    qualityFloorChecks.consequential_file_retention_rate_ok;
  const evalFidelityPassed = score.corpus_fidelity?.pass === true;
  const retrievalStageFault = 1 - Math.max(0, 1 - unmatchedRate) * Math.max(0, recall10);
  const heuristicStageFaultMatrix = {
    retrieval: retrievalStageFault,
    candidate_filtering: 1 - recall10,
    rerank: 1 - score.variants.baseline_atlas_git_on.aggregate.rerank_mrr10.point_estimate,
    synthesis_packing: 1 - retention,
    final_cleanup: 1 - score.variants.baseline_atlas_git_on.aggregate.retrieval_doc_share_mean.point_estimate,
  };
  const stage_fault_matrix = baselineVariant.stage_fault_matrix ?? heuristicStageFaultMatrix;
  const fault_owner = baselineVariant.fault_owner ?? classifyFaultOwner(stage_fault_matrix);
  const retrievalLiftProven =
    maxContribution > EPS &&
    base > EPS &&
    boundedConfidence &&
    fault_owner === "retrieval" &&
    qualityFloorPassed &&
    evalFidelityPassed;
  score.driver_verdict = {
    retrieval_lift_proven: retrievalLiftProven ? "yes" : "no",
    dominant_channel: dominantChannel,
    contributions: {
      atlas: atlasContribution,
      git_tracked: gitContribution,
    },
    contribution_ci95: {
      atlas: atlasDeltaCI,
      git_tracked: gitDeltaCI,
    },
    bounded_confidence: boundedConfidence,
    strict_gate: {
      positive_lane_ablation_delta: maxContribution > EPS,
      bounded_confidence: boundedConfidence,
      fault_owner_points_to_retrieval: fault_owner === "retrieval",
      quality_floor_passed: qualityFloorPassed,
      eval_fidelity_passed: evalFidelityPassed,
    },
    quality_floor: {
      thresholds: {
        max_unmatched_expected_file_rate: QUALITY_FLOOR_MAX_UNMATCHED,
        min_gold_file_recall_at_10: QUALITY_FLOOR_MIN_RECALL10,
        min_consequential_file_retention_rate: QUALITY_FLOOR_MIN_RETENTION,
      },
      observed: {
        unmatched_expected_file_rate: unmatchedRate,
        gold_file_recall_at_10: recall10,
        consequential_file_retention_rate: retention,
      },
      checks: qualityFloorChecks,
      pass: qualityFloorPassed,
    },
    corpus_fidelity: score.corpus_fidelity,
    stage_fault_matrix,
    fault_owner,
    confidence_statement: "95% bootstrap intervals computed over seed/temperature scenarios.",
  };

  const jsonPath="reports/helix-ask-retrieval-ablation-scorecard-2026-03-03.json";
  const mdPath="reports/helix-ask-retrieval-ablation-scorecard-2026-03-03.md";
  await fs.writeFile(path.join(outDir,"summary.comparison.json"),JSON.stringify(score,null,2)+"\n");
  if (score.run_complete) {
    await fs.writeFile(jsonPath,JSON.stringify(score,null,2)+"\n");
  } else {
    await fs.writeFile(path.join(outDir,"scorecard.partial.json"),JSON.stringify(score,null,2)+"\n");
  }
  const rows=Object.entries(score.variants).map(([name,v]:any)=>`| ${name} | ${v.aggregate.gold_file_recall_at_10.point_estimate.toFixed(6)} | ${v.aggregate.gold_file_recall_at_10.ci95.low.toFixed(6)} | ${v.aggregate.gold_file_recall_at_10.ci95.high.toFixed(6)} | ${v.diagnostics.unmatched_expected_file_rate.toFixed(6)} |`);
  const mdContent = [
      `# Helix Ask Retrieval Ablation Scorecard (2026-03-03)`,
      "",
      `Run: ${runId}`,
      `run_complete=${score.run_complete}`,
      "",
      ...(score.blocked_reason ? [`blocked_reason=${score.blocked_reason}`, ""] : []),
      "| Variant | recall@10 point | ci95 low | ci95 high | unmatched_expected_file_rate |",
      "| --- | ---: | ---: | ---: | ---: |",
      ...rows,
      "",
      `Driver verdict: retrieval_lift_proven=${score.driver_verdict.retrieval_lift_proven}, dominant_channel=${score.driver_verdict.dominant_channel}.`,
      `Contributions: atlas=${score.driver_verdict.contributions.atlas.toFixed(6)}, git_tracked=${score.driver_verdict.contributions.git_tracked.toFixed(6)}.`,
      `Strict gate: positive_lane_ablation_delta=${score.driver_verdict.strict_gate.positive_lane_ablation_delta}, bounded_confidence=${score.driver_verdict.strict_gate.bounded_confidence}, fault_owner_points_to_retrieval=${score.driver_verdict.strict_gate.fault_owner_points_to_retrieval}, quality_floor_passed=${score.driver_verdict.strict_gate.quality_floor_passed}.`,
      `Quality floor thresholds: unmatched<=${score.driver_verdict.quality_floor.thresholds.max_unmatched_expected_file_rate.toFixed(6)}, recall@10>=${score.driver_verdict.quality_floor.thresholds.min_gold_file_recall_at_10.toFixed(6)}, retention>=${score.driver_verdict.quality_floor.thresholds.min_consequential_file_retention_rate.toFixed(6)}.`,
      `Quality floor observed: unmatched=${score.driver_verdict.quality_floor.observed.unmatched_expected_file_rate.toFixed(6)}, recall@10=${score.driver_verdict.quality_floor.observed.gold_file_recall_at_10.toFixed(6)}, retention=${score.driver_verdict.quality_floor.observed.consequential_file_retention_rate.toFixed(6)}.`,
      `Corpus fidelity: pass=${Boolean(score.driver_verdict.corpus_fidelity?.pass)}, template_collision=${Number(score.driver_verdict.corpus_fidelity?.observed?.prompt_template_collision_rate ?? 0).toFixed(6)}, expected_token_hit=${Number(score.driver_verdict.corpus_fidelity?.observed?.expected_token_hit_rate ?? 0).toFixed(6)}.`,
      `Top10 collapse (baseline): dominant_share=${(score.variants.baseline_atlas_git_on?.diagnostics?.top10_fingerprint_dominant_share ?? 0).toFixed(6)}, unique_rate=${(score.variants.baseline_atlas_git_on?.diagnostics?.top10_fingerprint_unique_rate ?? 0).toFixed(6)}, collapse_flag=${Boolean(score.variants.baseline_atlas_git_on?.diagnostics?.top10_fingerprint_collapse_flag)}.`,
      `Context source counts (baseline): retrieval_context_files=${score.variants.baseline_atlas_git_on?.diagnostics?.context_file_source_counts?.retrieval_context_files ?? 0}, context_files=${score.variants.baseline_atlas_git_on?.diagnostics?.context_file_source_counts?.context_files ?? 0}, none=${score.variants.baseline_atlas_git_on?.diagnostics?.context_file_source_counts?.none ?? 0}.`,
      `Graph expansion contribution (baseline): selected_rate=${Number(score.variants.baseline_atlas_git_on?.diagnostics?.graph_expansion_contribution_rate ?? 0).toFixed(6)}, runtime_link_rate=${Number(score.variants.baseline_atlas_git_on?.diagnostics?.graph_runtime_link_rate ?? 0).toFixed(6)}, selected_tasks=${score.variants.baseline_atlas_git_on?.diagnostics?.graph_selected_task_count ?? 0}.`,
      `Graph expansion attribution (baseline): query_overlap_rate=${Number(score.variants.baseline_atlas_git_on?.diagnostics?.graph_query_overlap_rate ?? 0).toFixed(6)}, corpus_member_rate=${Number(score.variants.baseline_atlas_git_on?.diagnostics?.graph_corpus_member_rate ?? 0).toFixed(6)}, script_doc_boost_rate=${Number(score.variants.baseline_atlas_git_on?.diagnostics?.graph_script_doc_boost_rate ?? 0).toFixed(6)}.`,
      `Miss buckets (baseline): scripts=${score.variants.baseline_atlas_git_on?.diagnostics?.miss_bucket_counts?.scripts ?? 0}, docs=${score.variants.baseline_atlas_git_on?.diagnostics?.miss_bucket_counts?.docs ?? 0}, server=${score.variants.baseline_atlas_git_on?.diagnostics?.miss_bucket_counts?.server ?? 0}, client=${score.variants.baseline_atlas_git_on?.diagnostics?.miss_bucket_counts?.client ?? 0}, other=${score.variants.baseline_atlas_git_on?.diagnostics?.miss_bucket_counts?.other ?? 0}.`,
      "",
    ].join("\n");
  await fs.writeFile(path.join(outDir,"summary.comparison.md"),`${mdContent}\n`);
  if (score.run_complete) {
    await fs.writeFile(mdPath,`${mdContent}\n`);
  }
  await fs.writeFile(
    "reports/helix-ask-retrieval-stage-fault-matrix-2026-03-04.md",
    [
      "# Helix Ask Retrieval Stage-Fault Matrix (2026-03-04)",
      "",
      `Run: ${runId}`,
      `Fault owner: ${score.driver_verdict.fault_owner}`,
      "",
      "| Stage | Fault score |",
      "| --- | ---: |",
      `| retrieval | ${score.driver_verdict.stage_fault_matrix.retrieval.toFixed(6)} |`,
      `| candidate_filtering | ${score.driver_verdict.stage_fault_matrix.candidate_filtering.toFixed(6)} |`,
      `| rerank | ${score.driver_verdict.stage_fault_matrix.rerank.toFixed(6)} |`,
      `| synthesis_packing | ${score.driver_verdict.stage_fault_matrix.synthesis_packing.toFixed(6)} |`,
      `| final_cleanup | ${score.driver_verdict.stage_fault_matrix.final_cleanup.toFixed(6)} |`,
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    "reports/helix-ask-retrieval-attribution-go-no-go-2026-03-03.md",
    [
      "# Helix Ask Retrieval Attribution Go/No-Go (2026-03-03)",
      "",
      `Run: ${runId}`,
      "",
      `retrieval_lift_proven=${score.driver_verdict.retrieval_lift_proven}`,
      `dominant_channel=${score.driver_verdict.dominant_channel}`,
      `fault_owner=${score.driver_verdict.fault_owner}`,
      "",
      "Strict retrieval-lift claim gate:",
      `- positive lane-ablation delta: ${score.driver_verdict.strict_gate.positive_lane_ablation_delta}`,
      `- bounded confidence: ${score.driver_verdict.strict_gate.bounded_confidence}`,
      `- stage-fault owner points to retrieval: ${score.driver_verdict.strict_gate.fault_owner_points_to_retrieval}`,
      `- absolute quality floor passed: ${score.driver_verdict.strict_gate.quality_floor_passed}`,
      `- eval fidelity passed: ${score.driver_verdict.strict_gate.eval_fidelity_passed}`,
      "",
      "Absolute quality floor:",
      `- unmatched_expected_file_rate <= ${score.driver_verdict.quality_floor.thresholds.max_unmatched_expected_file_rate}`,
      `- gold_file_recall_at_10 >= ${score.driver_verdict.quality_floor.thresholds.min_gold_file_recall_at_10}`,
      `- consequential_file_retention_rate >= ${score.driver_verdict.quality_floor.thresholds.min_consequential_file_retention_rate}`,
      "",
      "Observed baseline quality:",
      `- unmatched_expected_file_rate = ${score.driver_verdict.quality_floor.observed.unmatched_expected_file_rate.toFixed(6)}`,
      `- gold_file_recall_at_10 = ${score.driver_verdict.quality_floor.observed.gold_file_recall_at_10.toFixed(6)}`,
      `- consequential_file_retention_rate = ${score.driver_verdict.quality_floor.observed.consequential_file_retention_rate.toFixed(6)}`,
      "",
      "Corpus fidelity gate:",
      `- prompt_template_collision_rate <= ${score.driver_verdict.corpus_fidelity.thresholds.max_template_collision_rate}`,
      `- expected_token_hit_rate >= ${score.driver_verdict.corpus_fidelity.thresholds.min_expected_token_hit_rate}`,
      "",
      "Observed corpus fidelity:",
      `- prompt_template_collision_rate = ${score.driver_verdict.corpus_fidelity.observed.prompt_template_collision_rate.toFixed(6)}`,
      `- expected_token_hit_rate = ${score.driver_verdict.corpus_fidelity.observed.expected_token_hit_rate.toFixed(6)}`,
      "",
      score.driver_verdict.retrieval_lift_proven === "yes"
        ? "Decision: GO for retrieval-lift claim (strict gate passed)."
        : "Decision: NO-GO for retrieval-lift claim (strict gate not satisfied).",
      "",
    ].join("\n"),
  );
  console.log(`Ablation artifacts written to ${outDir}`);
};

await main();
