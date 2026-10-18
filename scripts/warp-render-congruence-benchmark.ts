import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  computeWarpRodcChecksum,
  WARP_RODC_SNAPSHOT_SCHEMA_VERSION,
  type WarpRodcSnapshotV1,
  type WarpRodcStability,
  type WarpRodcVerdictStatus,
} from "../shared/warp-rodc-contract";

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const FULL_SOLVE_DIR = path.join("artifacts", "research", "full-solve");
const DOC_AUDIT_DIR = path.join("docs", "audits", "research");
const DEFAULT_OUT_JSON = path.join(FULL_SOLVE_DIR, `render-congruence-benchmark-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join(DOC_AUDIT_DIR, `warp-render-congruence-benchmark-${DATE_STAMP}.md`);
const DEFAULT_LATEST_JSON = path.join(FULL_SOLVE_DIR, "render-congruence-benchmark-latest.json");
const DEFAULT_LATEST_MD = path.join(DOC_AUDIT_DIR, "warp-render-congruence-benchmark-latest.md");
const DEFAULT_RODC_OUT_JSON = path.join(
  FULL_SOLVE_DIR,
  `warp-render-congruence-rodc-${DATE_STAMP}.json`,
);
const DEFAULT_RODC_LATEST_JSON = path.join(
  FULL_SOLVE_DIR,
  "warp-render-congruence-rodc-latest.json",
);
const DEFAULT_INTEGRITY_PATH = path.join(FULL_SOLVE_DIR, "integrity-parity-suite-latest.json");
const DEFAULT_DEBUG_LOG_PATH = path.join("artifacts", "research", "full-solve", "alcubierre-debug-log-latest.jsonl");
const BOUNDARY_STATEMENT =
  "This benchmark checks renderer/metric congruence and GR observable parity anchors; it is not a physical warp feasibility claim.";
const RODC_BOUNDARY_STATEMENT =
  "This reduced-order snapshot summarizes render/metric congruence benchmark outputs under a declared benchmark contract; it is not a physical warp feasibility claim.";

type BenchmarkVerdict = "PASS" | "PARTIAL" | "FAIL" | "INCONCLUSIVE";
type SolveOrderStatus = "pass" | "warn" | "fail" | "unknown";

type DisplacementEventSummary = {
  id: string;
  atMs: number | null;
  isoTime: string | null;
  integralStatus: SolveOrderStatus;
  recomputedStatus: SolveOrderStatus;
  metricRadiusZ_m: number | null;
  rmsZResidual_m: number | null;
  maxAbsZResidual_m: number | null;
  hausdorff_m: number | null;
  passRms_m: number | null;
  warnRms_m: number | null;
  passHausdorff_m: number | null;
  warnHausdorff_m: number | null;
  statusMismatch: boolean;
};

type RenderSummary = {
  sourcePath: string;
  parseErrors: number;
  totalEvents: number;
  displacementEvents: number;
  requiredEventCount: number;
  integralStatusCounts: Record<SolveOrderStatus, number>;
  recomputedStatusCounts: Record<SolveOrderStatus, number>;
  statusMismatchCount: number;
  maxRmsZResidual_m: number | null;
  maxAbsZResidual_m: number | null;
  maxHausdorff_m: number | null;
  newestEventIso: string | null;
  oldestEventIso: string | null;
  verdict: BenchmarkVerdict;
  note: string;
  sample: DisplacementEventSummary[];
};

type ObservableSummary = {
  sourcePath: string | null;
  integritySuitePresent: boolean;
  finalParityVerdict: string | null;
  mercury: boolean | null;
  lensing: boolean | null;
  frameDragging: boolean | null;
  shapiro: boolean | null;
  verdict: BenchmarkVerdict;
  note: string;
};

type RenderBenchmarkPayload = {
  artifactType: string;
  generatedOn: string;
  generatedAt: string;
  boundaryStatement: string;
  overallVerdict: BenchmarkVerdict;
  overallNote: string;
  render: RenderSummary;
  observables: ObservableSummary;
  paths: {
    dated_json: string;
    latest_json: string;
    dated_md: string;
    latest_md: string;
  };
  checksum?: string;
};

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes("=")) return argv[index].split("=", 2)[1];
  return argv[index + 1];
};

const hasFlag = (flag: string, argv = process.argv.slice(2)): boolean =>
  argv.some((value) => value === flag);

const asNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const asText = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
};

const asBoolean = (value: unknown): boolean | null => {
  if (typeof value === "boolean") return value;
  return null;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const toSolveOrderStatus = (value: unknown): SolveOrderStatus => {
  const text = asText(value)?.toLowerCase() ?? "unknown";
  if (text === "pass" || text === "warn" || text === "fail" || text === "unknown") return text;
  return "unknown";
};

const normalizePath = (filePath: string): string => filePath.replace(/\\/g, "/");

const resolvePathFromRoot = (filePath: string, cwd = process.cwd()): string =>
  path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);

const ensureDirForFile = (filePath: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const computeChecksum = (payload: Record<string, unknown>): string => {
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(payload));
  delete copy.generatedAt;
  delete copy.checksum;
  const canonical = JSON.stringify(copy, Object.keys(copy).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex");
};

const computeFileHash = (filePath: string): string =>
  crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

const toRodcVerdictStatus = (verdict: BenchmarkVerdict): WarpRodcVerdictStatus => {
  if (verdict === "PASS") return "congruent";
  if (verdict === "FAIL") return "distinct";
  return "inconclusive";
};

const toRodcStability = (_verdict: BenchmarkVerdict): WarpRodcStability => "not_evaluated";

export const buildWarpRenderCongruenceRodcSnapshot = (args: {
  payload: RenderBenchmarkPayload;
  debugLogPath: string;
  integrityPath: string;
  minEvents: number;
}): WarpRodcSnapshotV1 => {
  const { payload, debugLogPath, integrityPath, minEvents } = args;
  const renderPenalty =
    payload.render.verdict === "PASS"
      ? 0
      : payload.render.verdict === "PARTIAL"
        ? 0.5
        : payload.render.verdict === "FAIL"
          ? 1
          : 0.75;
  const observablesPenalty =
    payload.observables.verdict === "PASS"
      ? 0
      : payload.observables.verdict === "PARTIAL"
        ? 0.5
        : payload.observables.verdict === "FAIL"
          ? 1
          : 0.75;
  const featureVector = {
    debug_log_parse_errors: payload.render.parseErrors,
    total_events: payload.render.totalEvents,
    displacement_events: payload.render.displacementEvents,
    required_event_count: payload.render.requiredEventCount,
    status_mismatch_count: payload.render.statusMismatchCount,
    max_rms_z_residual_m: payload.render.maxRmsZResidual_m,
    max_abs_z_residual_m: payload.render.maxAbsZResidual_m,
    max_hausdorff_m: payload.render.maxHausdorff_m,
    observable_integrity_suite_present: payload.observables.integritySuitePresent,
    observable_final_parity_verdict: payload.observables.finalParityVerdict,
    overall_verdict: payload.overallVerdict,
  } satisfies Record<string, number | string | boolean | null>;
  const payloadBase: WarpRodcSnapshotV1 = {
    artifactType: WARP_RODC_SNAPSHOT_SCHEMA_VERSION,
    artifactFamily: "warp-render-congruence-benchmark",
    generatedOn: payload.generatedOn,
    generatedAt: payload.generatedAt,
    boundaryStatement: RODC_BOUNDARY_STATEMENT,
    contract: {
      id: "warp_render_congruence_benchmark_contract",
      version: 1,
      lane_id: "render_metric_parity_lane_a",
      classification_scope: "diagnostic_local_only",
    },
    inputs: {
      metricT00Ref: null,
      metricT00Source: null,
      shape_function_id: null,
      warpFieldType: null,
      dims: null,
      source_case_id: "render_congruence_benchmark",
    },
    provenance: {
      repo_commit_sha: null,
      serviceVersion: null,
      buildHash: null,
      runtimeInstanceId: null,
      timestamp_ms: null,
      sourceAuditArtifact: payload.paths.latest_json,
    },
    evidence_hashes: {
      metric_ref_hash: null,
      theta_channel_hash: null,
      k_trace_hash: null,
      slice_hashes_by_view: {},
      other_hashes: {
        debug_log_sha256: computeFileHash(debugLogPath),
        integrity_suite_sha256: fs.existsSync(integrityPath)
          ? computeFileHash(integrityPath)
          : null,
        benchmark_payload_checksum: payload.checksum ?? null,
      },
    },
    feature_vector: featureVector,
    distance: {
      to_alcubierre: null,
      to_natario: null,
      to_other_baselines: {
        render_displacement_alignment: renderPenalty,
        observable_parity_alignment: observablesPenalty,
      },
      winning_reference:
        payload.overallVerdict === "PASS"
          ? "render_metric_parity_reference"
          : null,
      reference_margin: null,
    },
    policy: {
      distance_metric: "benchmark_penalty_l1",
      normalization_method: "status_penalty",
      reference_margin_min: 0,
      reference_match_threshold: 0.25,
      distinctness_threshold: 0.75,
      feature_weights: {
        debug_log_parse_errors: 0.6,
        displacement_events: 1,
        status_mismatch_count: 1.2,
        max_rms_z_residual_m: 1,
        max_abs_z_residual_m: 1,
        max_hausdorff_m: 1,
        observable_integrity_suite_present: 0.8,
      },
    },
    robustness: {
      enabled: false,
      totalVariants: 0,
      evaluatedVariants: 0,
      dominantFraction: 0,
      dominantVerdict: null,
      stableVerdict: null,
      stabilityStatus: "not_evaluated",
      stable_fraction_min: 0,
      marginal_fraction_min: 0,
      verdictCounts: {},
    },
    preconditions: {
      controlsIndependent: payload.observables.integritySuitePresent,
      allRequiredViewsRendered: payload.render.displacementEvents >= minEvents,
      provenanceHashesPresent: true,
      runtimeStatusProvenancePresent: false,
      readyForFamilyVerdict:
        payload.render.displacementEvents >= minEvents &&
        payload.observables.integritySuitePresent,
    },
    cross_lane: {
      baseline_lane_id: "render_metric_parity_lane_a",
      alternate_lane_id: null,
      cross_lane_status: "single_lane_benchmark",
    },
    verdict: {
      family_label:
        payload.overallVerdict === "PASS"
          ? "render_metric_parity_aligned"
          : payload.overallVerdict === "FAIL"
            ? "render_metric_parity_diverged"
            : "render_metric_parity_inconclusive",
      status: toRodcVerdictStatus(payload.overallVerdict),
      stability: toRodcStability(payload.overallVerdict),
    },
    notes: [
      "This non-York consumer reuses the shared RODC contract for renderer/metric parity benchmarking rather than York-family morphology.",
      `render verdict=${payload.render.verdict} observables verdict=${payload.observables.verdict} overall=${payload.overallVerdict}`,
      `minimum displacement events required=${minEvents}; observed=${payload.render.displacementEvents}.`,
      "No alternate benchmark lane is defined here; cross-lane status remains single_lane_benchmark.",
    ],
  };
  return {
    ...payloadBase,
    checksum: computeWarpRodcChecksum(payloadBase as unknown as Record<string, unknown>),
  };
};

const deriveRecomputedStatus = (
  metricRadiusZ: number | null,
  rms: number | null,
  maxAbs: number | null,
  hausdorff: number | null,
): {
  status: SolveOrderStatus;
  passRms_m: number | null;
  warnRms_m: number | null;
  passHausdorff_m: number | null;
  warnHausdorff_m: number | null;
} => {
  if (
    metricRadiusZ == null ||
    metricRadiusZ <= 1e-9 ||
    rms == null ||
    maxAbs == null
  ) {
    return {
      status: "unknown",
      passRms_m: null,
      warnRms_m: null,
      passHausdorff_m: null,
      warnHausdorff_m: null,
    };
  }
  const passRms = Math.max(0.08 * metricRadiusZ, 0.12);
  const warnRms = Math.max(0.24 * metricRadiusZ, 0.45);
  const passHausdorff = Math.max(0.3 * metricRadiusZ, 0.5);
  const warnHausdorff = Math.max(0.8 * metricRadiusZ, 1.25);
  const passHaus = hausdorff == null || hausdorff <= passHausdorff;
  const warnHaus = hausdorff == null || hausdorff <= warnHausdorff;
  const status: SolveOrderStatus =
    rms <= passRms && maxAbs <= passRms * 2.2 && passHaus
      ? "pass"
      : rms <= warnRms && maxAbs <= warnRms * 2.1 && warnHaus
        ? "warn"
        : "fail";
  return {
    status,
    passRms_m: passRms,
    warnRms_m: warnRms,
    passHausdorff_m: passHausdorff,
    warnHausdorff_m: warnHausdorff,
  };
};

const parseDebugJsonl = (absolutePath: string): { events: Record<string, unknown>[]; parseErrors: number } => {
  const lines = fs
    .readFileSync(absolutePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const events: Record<string, unknown>[] = [];
  let parseErrors = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        events.push(parsed as Record<string, unknown>);
      } else {
        parseErrors += 1;
      }
    } catch {
      parseErrors += 1;
    }
  }
  return { events, parseErrors };
};

const evaluateRenderCongruence = (events: Record<string, unknown>[], sourcePath: string, minEvents: number): RenderSummary => {
  const filtered = events.filter((entry) => {
    const category = asText(entry.category);
    return category === "render_vs_metric_displacement";
  });

  const integralStatusCounts: Record<SolveOrderStatus, number> = {
    pass: 0,
    warn: 0,
    fail: 0,
    unknown: 0,
  };
  const recomputedStatusCounts: Record<SolveOrderStatus, number> = {
    pass: 0,
    warn: 0,
    fail: 0,
    unknown: 0,
  };
  const summaries: DisplacementEventSummary[] = [];
  let statusMismatchCount = 0;
  let maxRms: number | null = null;
  let maxAbs: number | null = null;
  let maxHaus: number | null = null;

  for (const event of filtered) {
    const expected = asRecord(event.expected);
    const delta = asRecord(event.delta);
    const measurements = asRecord(event.measurements);
    const metricRadiusCandidates = [
      asNumber(expected.metric_radius_z_m),
      asNumber(expected.metric_radius_x_m),
      asNumber(expected.metric_radius_y_m),
    ].filter((value): value is number => value != null && value > 0);
    const metricRadiusZ =
      metricRadiusCandidates.length > 0
        ? metricRadiusCandidates.reduce((sum, value) => sum + value, 0) / metricRadiusCandidates.length
        : null;
    const rms = asNumber(delta.rms_z_residual_m);
    const maxAbsResidual = asNumber(delta.max_abs_z_residual_m);
    const haus = asNumber(delta.hausdorff_m);
    if (rms != null) maxRms = maxRms == null ? rms : Math.max(maxRms, rms);
    if (maxAbsResidual != null) maxAbs = maxAbs == null ? maxAbsResidual : Math.max(maxAbs, maxAbsResidual);
    if (haus != null) maxHaus = maxHaus == null ? haus : Math.max(maxHaus, haus);

    const integralStatus = toSolveOrderStatus(measurements.integralStatus);
    const recomputed = deriveRecomputedStatus(metricRadiusZ, rms, maxAbsResidual, haus);
    const recomputedStatus = recomputed.status;
    integralStatusCounts[integralStatus] += 1;
    recomputedStatusCounts[recomputedStatus] += 1;
    const statusMismatch =
      integralStatus !== "unknown" &&
      recomputedStatus !== "unknown" &&
      integralStatus !== recomputedStatus;
    if (statusMismatch) statusMismatchCount += 1;

    summaries.push({
      id: asText(event.id) ?? `evt-${summaries.length + 1}`,
      atMs: asNumber(event.atMs),
      isoTime: asText(event.isoTime),
      integralStatus,
      recomputedStatus,
      metricRadiusZ_m: metricRadiusZ,
      rmsZResidual_m: rms,
      maxAbsZResidual_m: maxAbsResidual,
      hausdorff_m: haus,
      passRms_m: recomputed.passRms_m,
      warnRms_m: recomputed.warnRms_m,
      passHausdorff_m: recomputed.passHausdorff_m,
      warnHausdorff_m: recomputed.warnHausdorff_m,
      statusMismatch,
    });
  }

  const sortedByTime = [...summaries].sort((left, right) => (left.atMs ?? 0) - (right.atMs ?? 0));
  const oldestEventIso = sortedByTime[0]?.isoTime ?? null;
  const newestEventIso = sortedByTime[sortedByTime.length - 1]?.isoTime ?? null;

  let verdict: BenchmarkVerdict = "INCONCLUSIVE";
  let note = "No render-vs-metric displacement events found.";
  if (filtered.length < minEvents) {
    verdict = "INCONCLUSIVE";
    note = `Need >= ${minEvents} displacement events; found ${filtered.length}.`;
  } else if (statusMismatchCount > 0 || integralStatusCounts.fail > 0) {
    verdict = "FAIL";
    note =
      statusMismatchCount > 0
        ? `Integral status mismatches recomputed thresholds in ${statusMismatchCount} event(s).`
        : "Integral displacement status contains fail events.";
  } else if (integralStatusCounts.unknown > 0) {
    verdict = "PARTIAL";
    note = "Integral displacement status includes unknown events.";
  } else if (integralStatusCounts.warn > 0) {
    verdict = "PARTIAL";
    note = "Integral displacement status is stable but includes warning events.";
  } else {
    verdict = "PASS";
    note = "Integral displacement status and recomputed thresholds are fully aligned (pass).";
  }

  return {
    sourcePath: normalizePath(path.relative(process.cwd(), sourcePath)),
    parseErrors: 0,
    totalEvents: events.length,
    displacementEvents: filtered.length,
    requiredEventCount: minEvents,
    integralStatusCounts,
    recomputedStatusCounts,
    statusMismatchCount,
    maxRmsZResidual_m: maxRms,
    maxAbsZResidual_m: maxAbs,
    maxHausdorff_m: maxHaus,
    newestEventIso,
    oldestEventIso,
    verdict,
    note,
    sample: sortedByTime.slice(-12),
  };
};

const evaluateObservableParity = (integrityPath: string): ObservableSummary => {
  if (!fs.existsSync(integrityPath)) {
    return {
      sourcePath: null,
      integritySuitePresent: false,
      finalParityVerdict: null,
      mercury: null,
      lensing: null,
      frameDragging: null,
      shapiro: null,
      verdict: "INCONCLUSIVE",
      note: "integrity-parity-suite-latest.json missing; cannot score GR observable parity.",
    };
  }
  const payload = JSON.parse(fs.readFileSync(integrityPath, "utf8")) as Record<string, unknown>;
  const rubric = asRecord(payload.rubric);
  const mercury = asBoolean(asRecord(rubric.mercury_observable).pass);
  const lensing = asBoolean(asRecord(rubric.lensing_observable).pass);
  const frameDragging = asBoolean(asRecord(rubric.frame_dragging_observable).pass);
  const shapiro = asBoolean(asRecord(rubric.shapiro_observable).pass);
  const finalParityVerdict = asText(payload.final_parity_verdict);

  const values = [mercury, lensing, frameDragging, shapiro];
  const hasFalse = values.some((value) => value === false);
  const hasUnknown = values.some((value) => value == null);
  const verdict: BenchmarkVerdict = hasFalse ? "FAIL" : hasUnknown ? "INCONCLUSIVE" : "PASS";
  const note =
    verdict === "PASS"
      ? "GR observable parity anchors are all pass in the latest integrity suite."
      : verdict === "FAIL"
        ? "At least one GR observable parity anchor is failing."
        : "GR observable parity anchors are incomplete/unknown.";

  return {
    sourcePath: normalizePath(path.relative(process.cwd(), integrityPath)),
    integritySuitePresent: true,
    finalParityVerdict,
    mercury,
    lensing,
    frameDragging,
    shapiro,
    verdict,
    note,
  };
};

const renderMarkdown = (payload: Record<string, unknown>): string => {
  const render = asRecord(payload.render) as unknown as RenderSummary;
  const observables = asRecord(payload.observables) as unknown as ObservableSummary;
  return `# Warp Render Congruence Benchmark (${payload["generatedOn"]})

"${BOUNDARY_STATEMENT}"

## Overall
- verdict: \`${payload["overallVerdict"]}\`
- note: ${asText(payload["overallNote"]) ?? "n/a"}
- checksum: \`${payload["checksum"]}\`

## Render Lane (Integral Signal)
- source: \`${render.sourcePath}\`
- total_events: \`${render.totalEvents}\`
- displacement_events: \`${render.displacementEvents}\` (required >= \`${render.requiredEventCount}\`)
- verdict: \`${render.verdict}\`
- note: ${render.note}
- status_mismatch_count: \`${render.statusMismatchCount}\`
- max_rms_z_residual_m: \`${render.maxRmsZResidual_m}\`
- max_abs_z_residual_m: \`${render.maxAbsZResidual_m}\`
- max_hausdorff_m: \`${render.maxHausdorff_m}\`
- window: \`${render.oldestEventIso ?? "n/a"}\` -> \`${render.newestEventIso ?? "n/a"}\`

Integral status counts:
- pass: \`${render.integralStatusCounts.pass}\`
- warn: \`${render.integralStatusCounts.warn}\`
- fail: \`${render.integralStatusCounts.fail}\`
- unknown: \`${render.integralStatusCounts.unknown}\`

## Observable Parity Anchors
- source: \`${observables.sourcePath ?? "missing"}\`
- integrity_suite_present: \`${observables.integritySuitePresent}\`
- final_parity_verdict: \`${observables.finalParityVerdict ?? "unknown"}\`
- verdict: \`${observables.verdict}\`
- note: ${observables.note}
- mercury: \`${observables.mercury}\`
- lensing: \`${observables.lensing}\`
- frame_dragging: \`${observables.frameDragging}\`
- shapiro: \`${observables.shapiro}\`
`;
};

export const runWarpRenderCongruenceBenchmark = (options: {
  debugLogPath?: string;
  integrityPath?: string;
  outJsonPath?: string;
  outMdPath?: string;
  latestJsonPath?: string;
  latestMdPath?: string;
  rodcOutJsonPath?: string;
  rodcLatestJsonPath?: string;
  minEvents?: number;
}) => {
  const debugLogPath = resolvePathFromRoot(options.debugLogPath ?? DEFAULT_DEBUG_LOG_PATH);
  const integrityPath = resolvePathFromRoot(options.integrityPath ?? DEFAULT_INTEGRITY_PATH);
  const outJsonPath = options.outJsonPath ?? DEFAULT_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_OUT_MD;
  const latestJsonPath = options.latestJsonPath ?? DEFAULT_LATEST_JSON;
  const latestMdPath = options.latestMdPath ?? DEFAULT_LATEST_MD;
  const rodcOutJsonPath = options.rodcOutJsonPath ?? DEFAULT_RODC_OUT_JSON;
  const rodcLatestJsonPath = options.rodcLatestJsonPath ?? DEFAULT_RODC_LATEST_JSON;
  const minEvents = Number.isFinite(options.minEvents as number)
    ? Math.max(1, Math.floor(options.minEvents as number))
    : 6;

  if (!fs.existsSync(debugLogPath)) {
    throw new Error(
      `Missing debug log: ${normalizePath(path.relative(process.cwd(), debugLogPath))}. ` +
        `Export from Helix Start Settings -> Alcubierre render + calculation log and save to a .jsonl file.`,
    );
  }

  const parsed = parseDebugJsonl(debugLogPath);
  const render = evaluateRenderCongruence(parsed.events, debugLogPath, minEvents);
  render.parseErrors = parsed.parseErrors;
  const observables = evaluateObservableParity(integrityPath);

  const overallVerdict: BenchmarkVerdict =
    render.verdict === "FAIL" || observables.verdict === "FAIL"
      ? "FAIL"
      : render.verdict === "PASS" && observables.verdict === "PASS"
        ? "PASS"
        : render.verdict === "INCONCLUSIVE" && observables.verdict === "INCONCLUSIVE"
          ? "INCONCLUSIVE"
          : "PARTIAL";

  const overallNote =
    overallVerdict === "PASS"
      ? "Render integral congruence and GR observable parity anchors are aligned."
      : overallVerdict === "FAIL"
        ? "At least one lane (render congruence or observable parity) failed."
        : overallVerdict === "PARTIAL"
          ? "Some lanes pass while others are warn/unknown."
          : "Insufficient data to score either lane.";

  const payloadBase: RenderBenchmarkPayload = {
    artifactType: "warp_render_congruence_benchmark/v1",
    generatedOn: DATE_STAMP,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    overallVerdict,
    overallNote,
    render,
    observables,
    paths: {
      dated_json: normalizePath(outJsonPath),
      latest_json: normalizePath(latestJsonPath),
      dated_md: normalizePath(outMdPath),
      latest_md: normalizePath(latestMdPath),
    },
  };
  const payload = {
    ...payloadBase,
    checksum: computeChecksum(payloadBase),
  };
  const rodcArtifact = buildWarpRenderCongruenceRodcSnapshot({
    payload,
    debugLogPath,
    integrityPath,
    minEvents,
  });

  const markdown = renderMarkdown(payload);
  ensureDirForFile(outJsonPath);
  ensureDirForFile(outMdPath);
  ensureDirForFile(latestJsonPath);
  ensureDirForFile(latestMdPath);
  ensureDirForFile(rodcOutJsonPath);
  ensureDirForFile(rodcLatestJsonPath);
  fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(outMdPath, `${markdown}\n`);
  fs.writeFileSync(latestJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(latestMdPath, `${markdown}\n`);
  fs.writeFileSync(rodcOutJsonPath, `${JSON.stringify(rodcArtifact, null, 2)}\n`);
  fs.writeFileSync(rodcLatestJsonPath, `${JSON.stringify(rodcArtifact, null, 2)}\n`);

  return {
    ok: overallVerdict === "PASS",
    overallVerdict,
    outJsonPath,
    outMdPath,
    latestJsonPath,
    latestMdPath,
    rodcOutJsonPath,
    rodcLatestJsonPath,
    renderVerdict: render.verdict,
    observablesVerdict: observables.verdict,
    checksum: payload.checksum,
    rodcChecksum: rodcArtifact.checksum,
  };
};

const isEntryPoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  const strict = hasFlag("--strict");
  const result = runWarpRenderCongruenceBenchmark({
    debugLogPath: readArgValue("--debug-log"),
    integrityPath: readArgValue("--integrity"),
    outJsonPath: readArgValue("--out-json"),
    outMdPath: readArgValue("--out-md"),
    latestJsonPath: readArgValue("--latest-json"),
    latestMdPath: readArgValue("--latest-md"),
    rodcOutJsonPath: readArgValue("--rodc-out-json"),
    rodcLatestJsonPath: readArgValue("--rodc-latest-json"),
    minEvents: asNumber(readArgValue("--min-events")),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (strict && !result.ok) process.exit(1);
}
