import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import * as path from "node:path";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type Severity = "PASS" | "WARN" | "FAIL";

type CheckStatus = {
  name: string;
  status: Severity;
  details: string[];
  metrics: Record<string, string | number | boolean>;
};

type RunBundle = {
  name: string;
  diagnostics: JsonValue;
  proofs: JsonValue;
  grBrick: JsonValue;
};

type CheckReport = {
  name: string;
  status: Severity;
  checks: CheckStatus[];
  metrics: Record<string, string | number | boolean>;
  raw: {
    strict: Record<string, JsonValue>;
    samples: Record<string, number>;
    truthHashes: Record<string, string>;
  };
};

type ArgConfig = {
  baseUrl: string;
  outputPath: string;
  bundlePath?: string;
  compareBundlePath?: string;
  timeoutMs: number;
};

const DEFAULT_BASE = "http://127.0.0.1:5000";

type IndexedPath = {
  path: string;
  values: number[];
  pathParts: string[];
};

type PickOptions = {
  allowScalar: boolean;
  minCount: number;
  maxCount?: number;
};

type ScoredIndexedPath = IndexedPath & {
  score: number;
};

type GateState = {
  strictCongruence: boolean;
  latticeMetricOnly: boolean;
  anyProxy: boolean;
  grCertified: boolean;
  banner: string;
  mode: string;
  chart: string;
  observer: string;
  normalization: string;
  thetaWarpWeight: number;
  sourceForAlpha: string;
  sourceForBeta: string;
  sourceForTheta: string;
  sourceForClockRate: string;
  thetaDefinition: string;
  kijSignConvention: string;
  fieldProvenance: Record<string, JsonValue>;
  renderingSeed: string;
  renderingProbe: string;
  strictMode: boolean;
  gammaFieldNaming: string;
  provenanceSchema: string;
};

type FieldPack = {
  sourceTags: Record<string, string>;
  alpha: IndexedPath | null;
  beta: IndexedPath | null;
  betaRepresentation: string;
  gammaPhys: IndexedPath | null;
  gammaConformal: IndexedPath | null;
  phi: IndexedPath | null;
  gtt: IndexedPath | null;
  theta: IndexedPath | null;
  kTrace: IndexedPath | null;
  provenance: Record<string, string>;
  truthHashes: Record<string, string>;
  truthSources: Record<string, string>;
};

const REQUIRED_TRUTH_CHANNELS = ["alpha", "beta", "theta", "kTrace"];
const OPTIONAL_TRUTH_CHANNELS = ["gtt", "gammaPhys", "gammaConformal", "phi", "kTrace"];
const REQUIRED_FIELD_PROVENANCE_CHANNELS = ["alpha", "beta", "gamma", "theta", "kTrace", "clockRate", "curvature"];
const REQUIRED_FIELD_PROVENANCE_KEYS = ["source", "observer", "chart", "units", "definitionId", "isProxy"];

function normalizeRenderSeed(value: JsonValue): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

function pickNumberArray(value: JsonValue, fallback: number[] = []): number[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
}

function pickFiniteNumeric(value: JsonValue): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseArgs(): ArgConfig {
  const args = process.argv.slice(2);
  const config: ArgConfig = {
    baseUrl: DEFAULT_BASE,
    outputPath: path.join("artifacts", "curvature-congruence-report.json"),
    timeoutMs: 20_000,
  };

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (!flag) continue;
    switch (flag) {
      case "--base":
      case "--url":
      case "--base-url": {
        const value = args[i + 1];
        if (!value) throw new Error(`${flag} requires a URL`);
        config.baseUrl = value;
        i += 1;
        break;
      }
      case "--bundle":
      case "--input": {
        const value = args[i + 1];
        if (!value) throw new Error(`${flag} requires a bundle directory`);
        config.bundlePath = value;
        i += 1;
        break;
      }
      case "--compare":
      case "--compare-bundle": {
        const value = args[i + 1];
        if (!value) throw new Error(`${flag} requires a compare bundle directory`);
        config.compareBundlePath = value;
        i += 1;
        break;
      }
      case "--out":
      case "--output": {
        const value = args[i + 1];
        if (!value) throw new Error(`${flag} requires output path`);
        config.outputPath = value;
        i += 1;
        break;
      }
      case "--timeout": {
        const value = Number.parseInt(args[i + 1] ?? "", 10);
        if (!Number.isFinite(value)) throw new Error(`${flag} requires a numeric milliseconds value`);
        config.timeoutMs = value;
        i += 1;
        break;
      }
      default:
        break;
    }
  }
  return config;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickPath(payload: JsonValue, pathParts: string[]): JsonValue {
  let current: JsonValue = payload;
  for (const part of pathParts) {
    if (isJsonObject(current) && part in current) {
      current = current[part];
    } else {
      return null;
    }
  }
  return current;
}

function pickString(payload: JsonValue, pathParts: string[], fallback = ""): string {
  const value = pickPath(payload, pathParts);
  return typeof value === "string" ? value : fallback;
}

function pickBoolean(payload: JsonValue, pathParts: string[], fallback = false): boolean {
  const value = pickPath(payload, pathParts);
  return typeof value === "boolean" ? value : fallback;
}

function pickNumber(payload: JsonValue, pathParts: string[], fallback = Number.NaN): number {
  const value = pickPath(payload, pathParts);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function flattenNumericValues(value: JsonValue, out: number[] = []): number[] {
  if (typeof value === "number" && Number.isFinite(value)) {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      flattenNumericValues(item, out);
    }
  }
  return out;
}

function collectIndexedNumeric(payload: JsonValue, accum: IndexedPath[] = [], prefix = "", pathParts: string[] = []): void {
  if (isJsonObject(payload)) {
    for (const [key, child] of Object.entries(payload)) {
      collectIndexedNumeric(child, accum, prefix ? `${prefix}.${key}` : key, [...pathParts, key]);
    }
    return;
  }
  if (typeof payload === "number" && Number.isFinite(payload)) {
    accum.push({ path: prefix || "(root)", pathParts, values: [payload] });
    return;
  }
  if (Array.isArray(payload)) {
    const values = flattenNumericValues(payload, []);
    if (values.length > 0) {
      accum.push({ path: prefix || "(root)", pathParts, values });
    }
    return;
  }
}

function decodeChannelFloatValues(raw: string): number[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (!/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) return [];
  const bytes = Buffer.from(trimmed, "base64");
  if (!bytes.byteLength) return [];
  const values32 = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
  const float32 = Array.from(values32).filter((value) => Number.isFinite(value));
  if (float32.length > 0) {
    return float32;
  }
  if (bytes.byteLength % 8 !== 0) return [];
  const values64 = new Float64Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 8));
  return Array.from(values64).filter((value) => Number.isFinite(value));
}

function pickChannelEntries(
  payload: JsonValue,
  aliases: string[],
  options: PickOptions,
  contextHint?: string[],
): ScoredIndexedPath[] {
  const channels = pickPath(payload, ["channels"]);
  if (!isJsonObject(channels)) return [];
  const lowered = toStringMap(channels);
  const entries: ScoredIndexedPath[] = [];
  const ctx = contextHint?.map((value) => value.toLowerCase()) ?? [];
  for (const [rawName, rawValue] of Object.entries(lowered)) {
    if (!isJsonObject(rawValue) && !Array.isArray(rawValue)) continue;
    const values = isJsonObject(rawValue)
      ? decodeChannelFloatValues(typeof rawValue["data"] === "string" ? rawValue["data"] : "")
      : pickNumberArray(rawValue, []);
    if (!values.length) continue;
    if (!options.allowScalar && values.length < options.minCount) continue;
    if (options.maxCount !== undefined && values.length > options.maxCount) continue;

    const lowerName = rawName.toLowerCase();
    const path = `channels.${rawName}`;
    const pathParts = ["channels", rawName];
    let score = scorePath(path, aliases, pathParts);
    if (ctx.some((hint) => lowerName.includes(hint))) {
      score += 25;
    }
    if (score <= 0) continue;
    entries.push({ path, pathParts, values, score });
  }
  return entries;
}

function pickChannelField(
  payload: JsonValue,
  aliases: string[],
  options: PickOptions,
  contextHint?: string[],
): IndexedPath | null {
  const entries = pickChannelEntries(payload, aliases, options, contextHint);
  let best: ScoredIndexedPath | null = null;
  for (const entry of entries) {
    if (!best || entry.score > best.score) {
      best = entry;
    }
  }
  return best ? { path: best.path, pathParts: best.pathParts, values: best.values } : null;
}

function pickChannelVectorField(
  payload: JsonValue,
  xAliases: string[],
  yAliases: string[],
  zAliases: string[],
  options: PickOptions,
  contextHint?: string[],
): IndexedPath | null {
  const x = pickChannelField(payload, xAliases, options, contextHint);
  const y = pickChannelField(payload, yAliases, options, contextHint);
  const z = pickChannelField(payload, zAliases, options, contextHint);
  if (!x || !y || !z) return null;
  if (x.values.length !== y.values.length || x.values.length !== z.values.length) return null;
  if (x.values.length < options.minCount) return null;
  const n = x.values.length;
  const values: number[] = [];
  values.length = n * 3;
  for (let i = 0; i < n; i += 1) {
    values[i * 3] = x.values[i]!;
    values[i * 3 + 1] = y.values[i]!;
    values[i * 3 + 2] = z.values[i]!;
  }
  return {
    path: `channels.${x.pathParts.at(-1) ?? "x"}+${y.pathParts.at(-1) ?? "y"}+${z.pathParts.at(-1) ?? "z"}`,
    pathParts: [...x.pathParts, ...y.pathParts, ...z.pathParts],
    values,
  };
}

function pickChannelComponentVectorField(
  payload: JsonValue,
  xAliases: string[],
  yAliases: string[],
  zAliases: string[],
  options: PickOptions,
  contextHint?: string[],
): { values: IndexedPath; representation: string } | null {
  const x = pickChannelField(payload, xAliases, options, contextHint);
  const y = pickChannelField(payload, yAliases, options, contextHint);
  const z = pickChannelField(payload, zAliases, options, contextHint);
  if (!x || !y || !z) return null;
  if (x.values.length !== y.values.length || x.values.length !== z.values.length) return null;
  if (x.values.length < options.minCount) return null;
  if (options.maxCount !== undefined && x.values.length > options.maxCount) return null;
  const n = x.values.length;
  const values: number[] = [];
  values.length = n * 3;
  for (let i = 0; i < n; i += 1) {
    values[i * 3] = x.values[i]!;
    values[i * 3 + 1] = y.values[i]!;
    values[i * 3 + 2] = z.values[i]!;
  }
  return {
    values: {
      path: `channels.${x.pathParts.at(-1) ?? "x"}+${y.pathParts.at(-1) ?? "y"}+${z.pathParts.at(-1) ?? "z"}`,
      pathParts: [...x.pathParts, ...y.pathParts, ...z.pathParts],
      values,
    },
    representation: `components(${x.pathParts.at(-1) ?? "beta_x"},${y.pathParts.at(-1) ?? "beta_y"},${z.pathParts.at(-1) ?? "beta_z"})`,
  };
}

function scorePath(path: string, aliases: string[], pathParts: string[]): number {
  const lower = path.toLowerCase();
  const lowerParts = new Set(pathParts.map((p) => p.toLowerCase()));
  return aliases.reduce((total, alias) => {
    const token = alias.toLowerCase();
    if (lowerParts.has(token)) total += 100;
    if (lower.includes(token)) total += 10;
    return total;
  }, 0);
}

function pickField(
  payload: JsonValue,
  aliases: string[],
  options: PickOptions,
  contextHint?: string[],
): IndexedPath | null {
  const entries: ScoredIndexedPath[] = [];
  collectIndexedNumeric(payload, entries);
  const channelEntries = pickChannelEntries(payload, aliases, options, contextHint);

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const last = entries[i]?.pathParts.at(-1)?.toLowerCase();
    if (entries[i] && entries[i]?.pathParts.includes("channels") && (last === "min" || last === "max")) {
      entries.splice(i, 1);
      continue;
    }
    let score = scorePath(entries[i]?.path ?? "", aliases, entries[i]?.pathParts ?? []);
    if (contextHint?.length) {
      const ctx = contextHint.join(".").toLowerCase();
      const pathLower = entries[i]?.path.toLowerCase() ?? "";
      if (pathLower.includes(ctx)) score += 25;
    }
    entries[i] = { ...entries[i], score };
  }

  for (const channelEntry of channelEntries) {
    entries.push(channelEntry);
  }
  const candidates = entries.filter((entry) => {
    if (!options.allowScalar && entry.values.length < options.minCount) return false;
    if (options.maxCount !== undefined && entry.values.length > options.maxCount) return false;
    return true;
  });
  let best: IndexedPath | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    let s = scorePath(c.path, aliases, c.pathParts);
    if (contextHint?.length) {
      const ctx = contextHint.join(".").toLowerCase();
      const pathLower = c.path.toLowerCase();
      if (pathLower.includes(ctx)) s += 25;
    }
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  if (!best || bestScore === 0) return null;
  if (bestScore < 5) return null;
  return best;
}

function percentiles(values: number[], p = 0.98): { p: number; min: number; max: number; mean: number } {
  if (!values.length) {
    return { p: Number.NaN, min: Number.NaN, max: Number.NaN, mean: Number.NaN };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(p * (sorted.length - 1));
  const idx = Math.max(0, Math.min(sorted.length - 1, i));
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const mean = sorted.reduce((acc, v) => acc + v, 0) / sorted.length;
  return { p: sorted[idx]!, min, max, mean };
}

function stableHash(values: JsonValue): string {
  return crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function toStringMap(value: JsonValue): Record<string, JsonValue> {
  if (!isJsonObject(value)) return {};
  const out: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key.toLowerCase()] = child;
  }
  return out;
}

function readFieldDefinition(definitions: JsonValue, aliases: string[]): string {
  if (!isJsonObject(definitions)) return "";
  for (const alias of aliases) {
    const key = alias.toLowerCase();
    const hit = toStringMap(definitions)[key];
    if (typeof hit === "string") return hit;
  }
  return "";
}

function inferProvenanceSource(fieldName: string, provenanceRoot: JsonValue): string {
  const root = isJsonObject(provenanceRoot) ? toStringMap(provenanceRoot) : {};
  const aliases = fieldName
    .toLowerCase()
    .split(/[^a-z0-9_]/)
    .filter(Boolean);
  const candidates = [...Object.entries(root), ...Object.entries(toStringMap(root["fields"] as JsonValue))];
  for (const [rawKey, rawValue] of candidates) {
    const key = rawKey.toLowerCase();
    if (!key) continue;
    if (key === fieldName.toLowerCase() || aliases.some((alias) => key.includes(alias))) {
      const probe = isJsonObject(rawValue) && typeof rawValue.source === "string" ? rawValue.source : rawValue;
      if (typeof probe === "string") return probe;
      if (isJsonObject(rawValue) && typeof rawValue.origin === "string") return rawValue.origin as string;
    }
  }
  return "";
}

function provenanceObjectFromValue(value: JsonValue): { source: string; raw: JsonValue | undefined } {
  if (!isJsonObject(value)) return { source: "", raw: undefined };
  if (typeof value.source === "string") return { source: value.source, raw: value };
  if (typeof value.origin === "string") return { source: value.origin, raw: value };
  if (typeof value.provider === "string") return { source: value.provider, raw: value };
  return { source: "", raw: value };
}

function isRecord(value: JsonValue): value is JsonObject {
  return isJsonObject(value);
}

function collectProvenanceObjects(root: JsonValue, pathParts: string[] = []): Array<{ path: string; value: JsonValue }> {
  const result: Array<{ path: string; value: JsonValue }> = [];
  if (!isJsonObject(root) && !Array.isArray(root)) return result;
  if (isJsonObject(root)) {
    for (const [rawKey, rawValue] of Object.entries(root)) {
      const key = rawKey.toLowerCase();
      result.push({ path: [...pathParts, key].join("."), value: rawValue });
      result.push(...collectProvenanceObjects(rawValue, [...pathParts, key]));
    }
    return result;
  }
  root.forEach((entry, index) => {
    result.push(...collectProvenanceObjects(entry, [...pathParts, String(index)]));
  });
  return result;
}

function pickProvenanceRecord(fieldProvenance: JsonValue, aliases: string[]): JsonValue | null {
  if (!isJsonObject(fieldProvenance)) return null;
  const lowered = toStringMap(fieldProvenance);
  for (const alias of aliases) {
    const key = alias.toLowerCase();
    const direct = lowered[key];
    if (direct !== undefined) return direct;
    const prefixed = lowered[`channels.${key}`] ?? lowered[`fields.${key}`];
    if (prefixed !== undefined) return prefixed;
    for (const [k, value] of Object.entries(lowered)) {
      if (k === key || k.includes(key) || key.includes(k)) return value;
    }
  }
  for (const item of collectProvenanceObjects(fieldProvenance)) {
    const leaf = item.path.split(".").at(-1) ?? "";
    if (aliases.some((alias) => leaf === alias || leaf.includes(alias))) return item.value;
  }
  return null;
}

function normalizeProvenanceValue(raw: JsonValue): Record<string, JsonValue> | null {
  if (typeof raw === "string") return { source: raw };
  if (!isJsonObject(raw)) return null;
  return raw;
}

function evaluateChannelProvenance(
  strictMode: boolean,
  fieldProvenance: JsonValue,
  channelAliases: string[],
): { status: Severity; details: string[]; metrics: Record<string, string | number | boolean> } {
  const value = pickProvenanceRecord(fieldProvenance, channelAliases);
  const entry = normalizeProvenanceValue(value);
  if (!entry) {
    return {
      status: strictMode ? "FAIL" : "WARN",
      details: [`missing provenance entry for channel: ${channelAliases[0]}`],
      metrics: { source: "missing" },
    };
  }
  const source = typeof entry.source === "string" ? String(entry.source).trim() : "";
  const missingKeys = REQUIRED_FIELD_PROVENANCE_KEYS.filter((k) => {
    const found = k in entry;
    return !found || (k === "isProxy" ? false : typeof entry[k] !== "string" && k !== "isProxy");
  });
  const isProxy = entry.isProxy === true;
  const details: string[] = [];
  if (source) details.push(`source=${source}`);
  if (missingKeys.length) details.push(`missing provenance keys: ${missingKeys.join(", ")}`);
  if (isProxy) details.push(`isProxy=${isProxy}`);
  let status: Severity = "PASS";
  if (strictMode && (source !== "gr-brick" || missingKeys.length > 0 || isProxy)) status = "FAIL";
  else if (!strictMode && (source !== "gr-brick" || missingKeys.length > 0 || isProxy)) status = "WARN";
  if (strictMode && !source) status = "FAIL";
  if (strictMode && isProxy) status = "FAIL";
  return {
    status,
    details,
    metrics: {
      source: source || "missing",
      isProxy,
      hasDefinitionId: typeof entry.definitionId === "string" && entry.definitionId.length > 0,
      hasObserver: typeof entry.observer === "string" && entry.observer.length > 0,
      hasChart: typeof entry.chart === "string" && entry.chart.length > 0,
      missingKeys: missingKeys.length,
    },
  };
}

function collectTruthSources(fields: FieldPack, fieldProvenance: JsonValue): Record<string, string> {
  const provenanceEntries = collectProvenanceEntries(fieldProvenance);
  const channelAliases: Record<string, string[]> = {
    alpha: ["alpha", "lapse"],
    beta: ["beta", "shift", "beta_u", "beta_v", "betavector", "betavec"],
    gammaPhys: ["gamma_phys", "gamma_phys_ij", "gamma_phys_x", "gamma_phys_y", "gamma"],
    gammaConformal: ["tilde_gamma", "tilde_gamma_ij", "conformal_gamma"],
    phi: ["phi"],
    gtt: ["gtt", "g_tt", "g00", "g0t"],
    theta: ["theta", "theta_metric", "theta_conformal", "theta_eulerian"],
    kTrace: ["ktrace", "k_trace", "ktr", "k_trace_ij", "trk", "ktr", "k"],
  };
  const sources: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(channelAliases)) {
    const source = resolveProvenanceFromAliases(provenanceEntries, aliases);
    if (source) sources[field] = source;
  }
  if (!sources.alpha && fields.alpha?.values.length) sources.alpha = "gr-brick";
  if (!sources.beta && fields.beta?.values.length) sources.beta = "gr-brick";
  if (!sources.gamma && (fields.gammaPhys?.values.length || fields.gammaConformal?.values.length)) sources.gamma = "gr-brick";
  if (!sources.theta && fields.theta?.values.length) sources.theta = "gr-brick";
  if (!sources.kTrace && fields.kTrace?.values.length) sources.kTrace = "gr-brick";
  return sources;
}

function provenanceKeysPresent(fieldProvenance: JsonValue): string[] {
  if (!isJsonObject(fieldProvenance)) return [];
  const lowered = Object.keys(toStringMap(fieldProvenance));
  return lowered;
}

function hasRequiredFieldProvenanceKeys(fieldProvenance: JsonValue, requiredKeys: string[]): string[] {
  const present = provenanceKeysPresent(fieldProvenance);
  const lowerSet = new Set(present.map((key) => key.toLowerCase()));
  const normalized = new Set<string>();
  const normalizedInputs = Array.from(lowerSet.values());
  for (let i = 0; i < normalizedInputs.length; i += 1) {
    const key = normalizedInputs[i];
    if (!key) continue;
    normalized.add(key);
    normalized.add(key.replace(/-/g, "_"));
    normalized.add(key.replace(/_/g, "-"));
  }
  return requiredKeys.filter((key) => {
    const lower = key.toLowerCase();
    return normalized.has(lower);
  });
}

function hasFieldValue(pack: FieldPack, channel: string): boolean {
  switch (channel) {
    case "alpha":
      return !!pack.alpha && pack.alpha.values.length > 0;
    case "beta":
      return !!pack.beta && pack.beta.values.length > 0;
    case "gamma":
      return !!pack.gammaPhys && pack.gammaPhys.values.length > 0;
    case "theta":
      return !!pack.theta && pack.theta.values.length > 0;
    case "kTrace":
      return !!pack.kTrace && pack.kTrace.values.length > 0;
    case "clockRate":
      return !!pack.alpha && pack.alpha.values.length > 0;
    case "curvature":
      return false;
    default:
      return false;
  }
}

function getFieldByChannel(pack: FieldPack, channel: string): IndexedPath | null {
  switch (channel) {
    case "alpha":
      return pack.alpha;
    case "beta":
      return pack.beta;
    case "theta":
      return pack.theta;
    case "kTrace":
      return pack.kTrace;
    case "gtt":
      return pack.gtt;
    case "gamma":
      return pack.gammaPhys;
    default:
      return null;
  }
}

function inferGammaSourcePath(
  pack: FieldPack,
  strict: GateState,
  strictMode: boolean,
): { status: Severity; details: string[]; metrics: Record<string, string | number | boolean> } {
  const hasPhysical = !!pack.gammaPhys && pack.gammaPhys.values.length > 0;
  const hasConformal = !!pack.gammaConformal && pack.gammaConformal.values.length > 0;
  const hasPhi = !!pack.phi && pack.phi.values.length > 0;
  const status: Severity =
    strictMode && !(hasPhysical || (hasConformal && hasPhi))
      ? "FAIL"
      : hasPhysical || (hasConformal && hasPhi)
        ? "PASS"
        : "WARN";
  return {
    status,
    details: [
      hasPhysical ? `gammaPhys=${pack.gammaPhys?.path}` : `gammaConformal=${pack.gammaConformal?.path}`,
      strict.gammaFieldNaming ? `gammaFieldNaming=${strict.gammaFieldNaming}` : "gammaFieldNaming missing",
      hasConformal && !hasPhi ? "phi missing for reconstructing physical gamma" : "reconstruction inputs present",
    ],
    metrics: {
      gammaPhysCount: pack.gammaPhys?.values.length ?? 0,
      gammaConformalCount: pack.gammaConformal?.values.length ?? 0,
      phiCount: pack.phi?.values.length ?? 0,
    },
  };
}

function inferFieldDefinition(fieldProvenance: JsonValue, aliases: string[]): string {
  if (!isJsonObject(fieldProvenance)) return "";
  const flatMap = toStringMap(fieldProvenance);
  for (const alias of aliases) {
    const key = alias.toLowerCase();
    const value = flatMap[key];
    if (typeof value === "string") return value;
    if (isJsonObject(value) && typeof value.definition === "string") return value.definition;
  }
  return "";
}

function collectProvenanceEntries(root: JsonValue, pathParts: string[] = []): Array<{ path: string; source: string }> {
  if (!isJsonObject(root) && !Array.isArray(root)) return [];
  const entries: Array<{ path: string; source: string }> = [];
  if (isJsonObject(root)) {
    const source = inferProvenanceSource("", root as JsonValue);
    if (source) {
      const sourcePath = pathParts.length ? pathParts.join(".") : "(root)";
      entries.push({ path: sourcePath.toLowerCase(), source });
    }
    for (const [key, child] of Object.entries(root)) {
      entries.push(...collectProvenanceEntries(child, [...pathParts, key.toLowerCase()]));
    }
  } else {
    root.forEach((child, index) => {
      entries.push(...collectProvenanceEntries(child, [...pathParts, String(index)]));
    });
  }
  return entries;
}

function resolveProvenanceFromAliases(
  entries: Array<{ path: string; source: string }>,
  aliases: string[],
): string {
  if (!entries.length) return "";
  const lowered = aliases.map((alias) => alias.toLowerCase());
  let best = "";
  let bestScore = 0;
  for (const entry of entries) {
    const score = lowered.reduce((value, alias) => {
      let item = value;
      const segments = entry.path.split(".");
      const leaf = segments[segments.length - 1] ?? "";
      if (leaf === alias) item += 40;
      else if (leaf.includes(alias)) item += 20;
      if (entry.path.includes(alias)) item += 10;
      return item;
    }, 0);
    if (score > bestScore) {
      bestScore = score;
      best = entry.source;
    }
  }
  return bestScore > 0 ? best : "";
}

function buildGateState(diagnostics: JsonValue): GateState {
  const payload = isJsonObject(diagnostics) ? diagnostics : {};
  const strictRoot = pickPath(payload, ["strict"])
    || pickPath(payload, ["payload", "strict"])
    || {};
  const strictSource = isJsonObject(strictRoot) ? strictRoot : payload;
  const gate = isJsonObject(pickPath(payload, ["gate"]))
    ? (pickPath(payload, ["gate"]) as JsonValue)
    : isJsonObject(pickPath(payload, ["payload", "gate"]))
    ? (pickPath(payload, ["payload", "gate"]) as JsonValue)
    : {};
  const renderPlan = isJsonObject(pickPath(payload, ["render_plan"]))
    ? (pickPath(payload, ["render_plan"]) as JsonValue)
    : isJsonObject(pickPath(payload, ["renderPlan"]))
    ? (pickPath(payload, ["renderPlan"]) as JsonValue)
    : isJsonObject(pickPath(payload, ["payload", "render_plan"]))
    ? (pickPath(payload, ["payload", "render_plan"]) as JsonValue)
    : isJsonObject(pickPath(payload, ["payload", "renderPlan"]))
    ? (pickPath(payload, ["payload", "renderPlan"]) as JsonValue)
    : {};
  const definitions = isJsonObject(pickPath(payload, ["definitions"]))
    ? (pickPath(payload, ["definitions"]) as JsonValue)
    : isJsonObject(pickPath(payload, ["payload", "definitions"]))
    ? (pickPath(payload, ["payload", "definitions"]) as JsonValue)
    : {};
  const proofPack = isJsonObject(pickPath(payload, ["proofPack"]))
    ? (pickPath(payload, ["proofPack"]) as JsonValue)
    : isJsonObject(pickPath(payload, ["payload", "proofPack"]))
    ? (pickPath(payload, ["payload", "proofPack"]) as JsonValue)
    : {};
  const canonical = isJsonObject(pickPath(payload, ["canonical"]))
    ? (pickPath(payload, ["canonical"]) as JsonValue)
    : {};
  const fieldProvenance = isJsonObject(pickPath(payload, ["fieldProvenance"]))
    ? (pickPath(payload, ["fieldProvenance"]) as JsonValue)
    : isJsonObject(pickPath(payload, ["payload", "fieldProvenance"]))
    ? (pickPath(payload, ["payload", "fieldProvenance"]) as JsonValue)
    : {};
  const renderingSeed = normalizeRenderSeed(pickString(payload, ["renderingSeed"]));
  const renderingProbe =
    normalizeRenderSeed(pickString(payload, ["renderingProbe"])) ||
    normalizeRenderSeed(pickPath(payload, ["render_plan", "renderingProbe"])) ||
    "";
  const strictMode =
    pickBoolean(strictSource, ["strictCongruence"], false) ||
    pickBoolean(strictSource, ["strict"], false);

  return {
    strictCongruence: pickBoolean(strictSource, ["strictCongruence"], false),
    latticeMetricOnly: pickBoolean(strictSource, ["latticeMetricOnly"], false),
    anyProxy: pickBoolean(strictSource, ["anyProxy"], true),
    grCertified: pickBoolean(strictSource, ["grCertified"], false),
    banner: pickString(gate, ["banner"]),
    mode: pickString(renderPlan, ["mode"]),
    chart:
      pickString(renderPlan, ["chart"]) ||
      pickString(canonical, ["chart"]),
    observer:
      pickString(renderPlan, ["observer"]) ||
      pickString(canonical, ["observer"]),
    normalization:
      (() => {
        const value = pickPath(renderPlan, ["normalization"]);
        if (typeof value === "string") return value;
        return pickString(canonical, ["normalization"]);
      })(),
    thetaWarpWeight: pickNumber(renderPlan, ["thetaWarpWeight"], Number.NaN),
    sourceForAlpha: pickString(renderPlan, ["sourceForAlpha"]),
    sourceForBeta: pickString(renderPlan, ["sourceForBeta"]),
    sourceForTheta: pickString(renderPlan, ["sourceForTheta"]),
    sourceForClockRate: pickString(renderPlan, ["sourceForClockRate"]),
    thetaDefinition: readFieldDefinition(definitions, ["theta_definition", "theta-definition"])
      || readFieldDefinition(proofPack, ["theta_definition", "theta-definition"]),
    kijSignConvention:
      readFieldDefinition(definitions, ["kij_sign_convention", "kij-sign-convention"])
      || readFieldDefinition(proofPack, ["kij_sign_convention", "kij-sign-convention"]),
    fieldProvenance: isJsonObject(fieldProvenance) ? fieldProvenance as Record<string, JsonValue> : {},
    renderingSeed,
    renderingProbe,
    strictMode,
    gammaFieldNaming:
      readFieldDefinition(definitions, ["gamma_field_naming", "gamma-field-naming"])
      || readFieldDefinition(proofPack, ["gamma_field_naming", "gamma-field-naming"]),
    provenanceSchema:
      readFieldDefinition(definitions, ["field_provenance_schema", "field-provenance-schema"])
      || readFieldDefinition(proofPack, ["field_provenance_schema", "field-provenance-schema"])
      || "",
  };
}

function evaluateGate(state: GateState): CheckStatus[] {
  const strictMode = state.strictMode;
  const provenanceSchemaStatus = state.provenanceSchema ? "PASS" : strictMode ? "FAIL" : "WARN";

  const checks: CheckStatus[] = [
    {
      name: "strictCongruence",
      status: state.strictCongruence ? "PASS" : "FAIL",
      details: [state.strictCongruence ? "strictCongruence=true" : "strictCongruence must be true"],
      metrics: { strictCongruence: state.strictCongruence },
    },
    {
      name: "latticeMetricOnly",
      status: state.latticeMetricOnly ? "PASS" : "FAIL",
      details: [state.latticeMetricOnly ? "latticeMetricOnly=true" : "latticeMetricOnly must be true"],
      metrics: { latticeMetricOnly: state.latticeMetricOnly },
    },
    {
      name: "proxyBlocked",
      status: state.anyProxy ? "FAIL" : "PASS",
      details: [state.anyProxy ? "proxy inputs are present" : "anyProxy=false"],
      metrics: { anyProxy: state.anyProxy },
    },
    {
      name: "grCertified",
      status: state.grCertified ? "PASS" : "FAIL",
      details: [state.grCertified ? "grCertified=true" : "grCertified must be true"],
      metrics: { grCertified: state.grCertified },
    },
    {
      name: "banner",
      status: state.banner === "CERTIFIED" ? "PASS" : "FAIL",
      details: [`banner=${state.banner || "n/a"}`],
      metrics: { gateBanner: state.banner || "n/a" },
    },
    {
      name: "mode",
      status: state.mode === "natario" ? "PASS" : "FAIL",
      details: [`render_plan.mode=${state.mode || "n/a"}`],
      metrics: { mode: state.mode || "n/a" },
    },
    {
      name: "chart",
      status: state.chart === "comoving_cartesian" ? "PASS" : "FAIL",
      details: [`render_plan.chart=${state.chart || "n/a"}`],
      metrics: { chart: state.chart || "n/a" },
    },
    {
      name: "observer",
      status: state.observer === "eulerian_n" ? "PASS" : "FAIL",
      details: [`render_plan.observer=${state.observer || "n/a"}`],
      metrics: { observer: state.observer || "n/a" },
    },
    {
      name: "normalization",
      status: state.normalization === "si_stress" ? "PASS" : "FAIL",
      details: [`render_plan.normalization=${state.normalization || "n/a"}`],
      metrics: { normalization: state.normalization || "n/a" },
    },
    {
      name: "thetaWarpWeight",
      status: state.thetaWarpWeight === 0 ? "PASS" : "FAIL",
      details: [`render_plan.thetaWarpWeight=${state.thetaWarpWeight}`],
      metrics: { thetaWarpWeight: Number.isFinite(state.thetaWarpWeight) ? state.thetaWarpWeight : Number.NaN },
    },
    {
      name: "sourceForAlpha",
      status: state.sourceForAlpha === "gr-brick" ? "PASS" : "FAIL",
      details: [`sourceForAlpha=${state.sourceForAlpha || "n/a"}`],
      metrics: { sourceForAlpha: state.sourceForAlpha || "n/a" },
    },
    {
      name: "sourceForBeta",
      status: state.sourceForBeta === "gr-brick" ? "PASS" : "FAIL",
      details: [`sourceForBeta=${state.sourceForBeta || "n/a"}`],
      metrics: { sourceForBeta: state.sourceForBeta || "n/a" },
    },
    {
      name: "sourceForTheta",
      status: state.sourceForTheta === "gr-brick" ? "PASS" : "FAIL",
      details: [`sourceForTheta=${state.sourceForTheta || "n/a"}`],
      metrics: { sourceForTheta: state.sourceForTheta || "n/a" },
    },
    {
      name: "sourceForClockRate",
      status: state.sourceForClockRate === "gr-brick" ? "PASS" : "FAIL",
      details: [`sourceForClockRate=${state.sourceForClockRate || "n/a"}`],
      metrics: { sourceForClockRate: state.sourceForClockRate || "n/a" },
    },
    {
      name: "thetaDefinition",
      status: state.thetaDefinition ? "PASS" : strictMode ? "FAIL" : "WARN",
      details: [
        state.thetaDefinition
          ? `theta_definition=${state.thetaDefinition}`
          : strictMode
            ? "theta_definition is required in strict mode"
            : "theta_definition is recommended for strict semantics",
      ],
      metrics: { thetaDefinition: state.thetaDefinition || "n/a" },
    },
    {
      name: "kijSignConvention",
      status: state.kijSignConvention ? "PASS" : strictMode ? "FAIL" : "WARN",
      details: [
        state.kijSignConvention
          ? `kij_sign_convention=${state.kijSignConvention}`
          : strictMode
            ? "kij_sign_convention is required in strict mode"
            : "kij_sign_convention is recommended for canonical math checks",
      ],
      metrics: { kijSignConvention: state.kijSignConvention || "n/a" },
    },
    {
      name: "gammaFieldNaming",
      status: state.gammaFieldNaming ? "PASS" : strictMode ? "FAIL" : "WARN",
      details: [
        state.gammaFieldNaming
          ? `gamma_field_naming=${state.gammaFieldNaming}`
          : strictMode
            ? "gamma_field_naming required in strict mode"
            : "gamma_field_naming is recommended for strict reconstruction checks",
      ],
      metrics: { gammaFieldNaming: state.gammaFieldNaming || "n/a" },
    },
    {
      name: "fieldProvenanceSchema",
      status: provenanceSchemaStatus,
      details: [
        state.provenanceSchema
          ? `field_provenance_schema=${state.provenanceSchema}`
          : state.strictMode
            ? "field_provenance_schema is required in strict mode"
            : "field_provenance_schema is recommended",
      ],
      metrics: { fieldProvenanceSchema: state.provenanceSchema || "n/a" },
    },
  ];

  return checks;
}

type GttResult = {
  status: Severity;
  details: string[];
  residual: number;
  timelikeFrac: number;
};

type GammaMode = "dense3x3" | "sym3" | "diag3" | "isotropic" | "missing";

function classifyGammaMode(len: number, n: number): GammaMode {
  if (len === n * 9) return "dense3x3";
  if (len === n * 6) return "sym3";
  if (len === n * 3) return "diag3";
  if (len === n) return "isotropic";
  if (len === 3) return "diag3";
  return "missing";
}

function betaDotGammaBeta(
  cell: number,
  mode: GammaMode,
  gamma: number[],
  bx: number,
  by: number,
  bz: number,
): number {
  if (mode === "missing") return Number.NaN;
  if (mode === "isotropic") {
    const g = gamma[cell] ?? 0;
    return g * (bx * bx + by * by + bz * bz);
  }
  if (mode === "diag3") {
    const b0 = gamma[cell * 3] ?? 1;
    const b1 = gamma[cell * 3 + 1] ?? 1;
    const b2 = gamma[cell * 3 + 2] ?? 1;
    return b0 * bx * bx + b1 * by * by + b2 * bz * bz;
  }
  if (mode === "sym3") {
    const b = cell * 6;
    const gxx = gamma[b] ?? 1;
    const gxy = gamma[b + 1] ?? 0;
    const gxz = gamma[b + 2] ?? 0;
    const gyy = gamma[b + 3] ?? 1;
    const gyz = gamma[b + 4] ?? 0;
    const gzz = gamma[b + 5] ?? 1;
    return (
      gxx * bx * bx +
      2 * gxy * bx * by +
      2 * gxz * bx * bz +
      gyy * by * by +
      2 * gyz * by * bz +
      gzz * bz * bz
    );
  }
  const b = cell * 9;
  const gxx = gamma[b] ?? 1;
  const gxy = gamma[b + 1] ?? 0;
  const gxz = gamma[b + 2] ?? 0;
  const gyx = gamma[b + 3] ?? gxy;
  const gyy = gamma[b + 4] ?? 1;
  const gyz = gamma[b + 5] ?? 0;
  const gzx = gamma[b + 6] ?? gxz;
  const gzy = gamma[b + 7] ?? gyz;
  const gzz = gamma[b + 8] ?? 1;
  return (
    gxx * bx * bx +
    (gxy + gyx) * bx * by +
    (gxz + gzx) * bx * bz +
    gyy * by * by +
    (gyz + gzy) * by * bz +
    gzz * bz * bz
  );
}

function contractGttResidual(
  alpha: number[] | null,
  beta: number[] | null,
  gamma: number[] | null,
  gttSampled: number[] | null,
  strictMode: boolean,
  betaRepresentation = "unknown",
): GttResult {
  if (!alpha || !beta || !gamma || alpha.length === 0 || beta.length < 3 || gamma.length === 0) {
    return {
      status: strictMode ? "FAIL" : "WARN",
      details: [
        "insufficient data for ADM reconstruction",
        `beta_assembly=${betaRepresentation}`,
      ],
      residual: Number.NaN,
      timelikeFrac: Number.NaN,
    };
  }

  const n = alpha.length;
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let constantBeta = false;
  if (beta.length === 3) {
    constantBeta = true;
    [b0, b1, b2] = beta;
  } else if (beta.length === n * 3) {
    constantBeta = false;
  } else {
    return {
      status: strictMode ? "FAIL" : "WARN",
      details: [
        "beta does not match expected shape (3 or n*3 entries)",
        `beta_assembly=${betaRepresentation}`,
        `beta_count=${beta.length}`,
        `cell_count=${n}`,
      ],
      residual: Number.NaN,
      timelikeFrac: Number.NaN,
    };
  }

  const mode = classifyGammaMode(gamma.length, n);
  if (mode === "missing") {
    return {
      status: strictMode ? "FAIL" : "WARN",
      details: ["gamma shape not recognized for physical gamma reconstruction"],
      residual: Number.NaN,
      timelikeFrac: Number.NaN,
    };
  }

  const betaMode = beta.length === 3 ? "constant3" : "packed_nx3";
  const residuals: number[] = [];
  const expectedAbs: number[] = [];
  let timelike = 0;
  for (let i = 0; i < n; i += 1) {
    const a = alpha[i];
    if (!Number.isFinite(a)) continue;
    const bx = constantBeta ? b0 : beta[i * 3];
    const by = constantBeta ? b1 : beta[i * 3 + 1];
    const bz = constantBeta ? b2 : beta[i * 3 + 2];
    if (!Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz)) continue;

    const betaTerm = betaDotGammaBeta(i, mode, gamma, bx, by, bz);
    if (!Number.isFinite(betaTerm)) continue;

    const expected = -a * a + betaTerm;
    expectedAbs.push(Math.abs(expected));
    if (expected < 0) timelike += 1;
    const sample = gttSampled?.[i];
    if (sample !== undefined && Number.isFinite(sample)) residuals.push(Math.abs(sample - expected));
  }

  const frac = n > 0 ? timelike / n : Number.NaN;
  if (residuals.length === 0) {
    return {
      status: strictMode ? "FAIL" : "WARN",
      details: [
        "g_tt reconstructed from ADM fields; no sampled g_tt field was available for residual",
        `beta_repr=${betaMode}`,
        `gamma_mode=${mode}`,
      ],
      residual: Number.NaN,
      timelikeFrac: frac,
    };
  }

  const r = percentiles(residuals, 0.98);
  const expectedP98 = percentiles(expectedAbs, 0.98).p;
  const denom = expectedP98 > 0 ? expectedP98 : 1;
  const rel = r.p / denom;
  let status: Severity = "PASS";
  if (rel > 1e-2) status = "FAIL";
  else if (rel > 1e-4) status = "WARN";

  return {
    status,
    details: [
      `g_tt residual p98=${r.p}`,
      `relative residual p98=${rel}`,
      `timelike_frac=${frac}`,
      `beta_repr=${betaMode}`,
      `beta_assembly=${betaRepresentation}`,
      `gamma_mode=${mode}`,
    ],
    residual: rel,
    timelikeFrac: frac,
  };
}

function thetaKResidual(theta: number[] | null, ktrace: number[] | null): {
  status: Severity;
  details: string[];
  residual: number;
} {
  if (!theta || !ktrace || theta.length === 0 || ktrace.length === 0) {
    return {
      status: "WARN",
      details: ["theta or Ktrace unavailable"],
      residual: Number.NaN,
    };
  }
  const n = Math.min(theta.length, ktrace.length);
  const absResiduals: number[] = [];
  const absK: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = theta[i]!;
    const k = ktrace[i]!;
    if (Number.isFinite(t) && Number.isFinite(k)) {
      absResiduals.push(Math.abs(t + k));
      absK.push(Math.abs(k));
    }
  }
  if (!absResiduals.length || !absK.length) {
    return { status: "WARN", details: ["no finite theta/Ktrace samples"], residual: Number.NaN };
  }
  const r = percentiles(absResiduals, 0.98);
  const kRef = percentiles(absK, 0.98);
  const denom = kRef.p > 0 ? kRef.p : 1;
  const rel = r.p / denom;
  let status: Severity = "PASS";
  if (rel > 1e-3) status = "FAIL";
  else if (rel > 1e-6) status = "WARN";
  return {
    status,
    details: [`theta+K rel p98=${rel}`, `K p98=${kRef.p}`, `residual p98=${r.p}`],
    residual: rel,
  };
}

function inferInvariants(payload: JsonValue): string[] {
  const entries: IndexedPath[] = [];
  collectIndexedNumeric(payload, entries);
  const keys: string[] = [];
  const aliases = ["kretschmann", "riccisq", "ricciscalar", "weyl", "weylsq", "riemann", "curvature"];
  for (const entry of entries) {
    const lower = entry.path.toLowerCase();
    if (aliases.some((alias) => lower.includes(alias))) {
      keys.push(entry.path);
    }
  }
  return keys;
}

async function readJsonFile(filePath: string): Promise<JsonValue> {
  const raw = await fs.readFile(filePath, "utf8");
  if (typeof raw !== "string") {
    throw new Error(`Invalid file content for ${filePath}`);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new SyntaxError(`Empty JSON file: ${filePath}`);
  }
  return JSON.parse(trimmed) as JsonValue;
}

async function readOptionalJsonFile(filePath: string): Promise<JsonValue | null> {
  try {
    return await readJsonFile(filePath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (
      err.code === "ENOENT" ||
      err.code === "ENOTDIR" ||
      err.name === "SyntaxError"
    ) {
      return null;
    }
    throw error;
  }
}

async function fetchJson(url: string, timeoutMs: number): Promise<JsonValue> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Request failed ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as JsonValue;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOptionalJson(url: string, timeoutMs: number): Promise<JsonValue | null> {
  try {
    return await fetchJson(url, timeoutMs);
  } catch (error) {
    if (error instanceof Error) {
      return null;
    }
    return null;
  }
}

async function loadBundleByPath(bundleDir: string): Promise<RunBundle> {
  const base = path.resolve(bundleDir);
  const diagnostics =
    (await readOptionalJsonFile(path.join(base, "time-dilation-diagnostics.json"))) ||
    (() => {
      throw new Error(`Missing or invalid diagnostics file in ${base}`);
    })();
  const proofs = (await readOptionalJsonFile(path.join(base, "pipeline-proofs.json")))
    || (await readOptionalJsonFile(path.join(base, "pipeline_proofs.json")))
    || {};
  const grBrick =
    (await readOptionalJsonFile(path.join(base, "gr-evolve-brick.json"))) ??
    (await readOptionalJsonFile(path.join(base, "gr-evolve-brick")))
    ?? {};
  return { name: path.basename(base), diagnostics, proofs, grBrick };
}

async function loadBundleByBase(baseUrl: string, timeoutMs: number): Promise<RunBundle> {
  const diagnostics = await fetchJson(`${baseUrl}/api/helix/time-dilation/diagnostics`, timeoutMs);
  const proofs = (await fetchOptionalJson(`${baseUrl}/api/helix/pipeline/proofs`, timeoutMs)) ?? {};
  const grBrick =
    (await fetchOptionalJson(`${baseUrl}/api/helix/gr-evolve-brick?format=json&includeExtra=1&includeMatter=1&includeKij=1`, timeoutMs))
    ?? {};
  return { name: new URL(baseUrl).hostname, diagnostics, proofs, grBrick };
}

async function loadBundle(config: ArgConfig): Promise<RunBundle> {
  if (config.bundlePath) return loadBundleByPath(config.bundlePath);
  return loadBundleByBase(config.baseUrl, config.timeoutMs);
}

function resolveFieldCandidates(brick: JsonValue) {
  const all = collectFieldRoots(brick);
  const provenance: Record<string, string> = {};
  for (const [fieldName, path] of Object.entries(all)) {
    provenance[fieldName] = path;
  }
  const channelAlpha = pickChannelField(brick, ["alpha", "lapse"], { allowScalar: false, minCount: 1 });
  const componentBeta = pickChannelComponentVectorField(
    brick,
    ["beta_x", "betax", "beta_xx"],
    ["beta_y", "betay", "beta_yy"],
    ["beta_z", "betaz", "beta_zz"],
    { allowScalar: false, minCount: 3 },
  );
  const packedBeta = pickChannelField(
    brick,
    ["beta", "shift", "beta_u", "beta0", "betavector", "beta_i", "beta_vector", "shift_vector"],
    { allowScalar: false, minCount: 3 },
    ["gr", "brick"],
  );
  const channelGamma = pickChannelVectorField(
    brick,
    ["gamma_xx", "gamma_phys_xx"],
    ["gamma_yy", "gamma_phys_yy"],
    ["gamma_zz", "gamma_phys_zz"],
    { allowScalar: false, minCount: 3 },
  );
  const alpha = pickField(brick, ["alpha", "lapse"], { allowScalar: false, minCount: 1 }, ["gr", "brick"]);
  const fallbackBeta = pickField(brick, ["beta", "shift", "beta_u", "beta0", "betavector"], { allowScalar: false, minCount: 3 }, ["gr", "brick"]);
  let beta: IndexedPath | null = null;
  let betaRepresentation = "missing";
  if (componentBeta) {
    beta = componentBeta.values;
    betaRepresentation = componentBeta.representation;
  } else if (packedBeta) {
    beta = packedBeta;
    betaRepresentation = `packed(${packedBeta.pathParts.at(-1) ?? "beta"})`;
  } else if (fallbackBeta) {
    beta = fallbackBeta;
    betaRepresentation = `fallback(${fallbackBeta.pathParts.at(-1) ?? "beta"})`;
  }
  const gammaPhys = pickField(brick, ["gamma_phys", "gamma_phys_ij", "gamma_phys_x"], { allowScalar: false, minCount: 3 }, ["gr", "brick"]) || channelGamma;
  const gammaConformal = pickField(brick, ["tilde_gamma", "tilde_gamma_ij", "conformal_gamma"], { allowScalar: false, minCount: 3 }, ["gr", "brick"]);
  const phi = pickField(brick, ["phi"], { allowScalar: true, minCount: 1 }, ["gr", "brick"]);
  const gtt = pickField(brick, ["gtt", "g_tt", "g00", "g0t"], { allowScalar: true, minCount: 1 }, ["gr", "brick"]) || pickChannelField(brick, ["g_tt", "gtt"], { allowScalar: false, minCount: 1 }, ["gr", "brick"]);
  const theta = pickField(brick, ["theta", "theta_metric"], { allowScalar: false, minCount: 1 }, ["gr", "brick"]) || pickChannelField(brick, ["theta"], { allowScalar: false, minCount: 1 }, ["gr", "brick"]);
  const kTrace = pickField(brick, ["ktrace", "k_trace", "trk", "ktr"], { allowScalar: false, minCount: 1 }, ["gr", "brick"]) || pickChannelField(brick, ["k_trace"], { allowScalar: false, minCount: 1 }, ["gr", "brick"]);
  const sourceTags: Record<string, string> = {};
  for (const [fieldName, fieldPath] of Object.entries(all)) {
    sourceTags[fieldName] = fieldPath;
  }
  if (alpha) sourceTags.alpha = alpha.path;
  if (beta) sourceTags.beta = beta.path;
  if (gammaPhys) sourceTags.gamma = gammaPhys.path;
  if (gammaConformal) sourceTags.gamma = gammaConformal.path;
  if (theta) sourceTags.theta = theta.path;
  if (kTrace) sourceTags.ktrace = kTrace.path;
  if (gtt) sourceTags.gtt = gtt.path;
  const fieldPack: FieldPack = {
    alpha: alpha || channelAlpha,
    beta,
    betaRepresentation,
    gammaPhys,
    gammaConformal,
    phi,
    gtt,
    theta,
    kTrace,
    provenance,
    sourceTags,
    truthHashes: {},
    truthSources: {},
  };
  return fieldPack;
}

function collectFieldRoots(payload: JsonValue): Record<string, string> {
  const entries: IndexedPath[] = [];
  collectIndexedNumeric(payload, entries);
  const result: Record<string, string> = {};
  for (const item of entries) {
    const parts = item.path.split(".");
    const key = parts[parts.length - 1]?.toLowerCase();
    if (!key) continue;
    if (result[key] === undefined) {
      result[key] = item.path;
    }
  }
  return result;
}

function reconstructGamma(gammaPhys: IndexedPath | null, phi: IndexedPath | null, gammaConformal: IndexedPath | null, cellCount: number): IndexedPath | null {
  if (gammaPhys) return gammaPhys;
  if (!phi || !gammaConformal) return null;
  if (gammaConformal.values.length < 3) return null;

  const componentsPerCell = gammaConformal.values.length % 6 === 0 ? 6 : gammaConformal.values.length % 9 === 0 ? 9 : 3;
  const n = componentsPerCell > 0 ? Math.floor(gammaConformal.values.length / componentsPerCell) : 0;
  if (!Number.isFinite(n) || n < 1) return null;

  const useScalarPhi = phi.values.length === 1;
  const useCellPhi = phi.values.length === n;
  const gammaValues: number[] = [];

  for (let i = 0; i < n; i += 1) {
    const phiBase = useScalarPhi
      ? phi.values[0]!
      : useCellPhi
        ? phi.values[Math.min(i, phi.values.length - 1)]!
        : 0;
    const scale = Math.exp(4 * phiBase);
    const offset = i * componentsPerCell;
    for (let k = 0; k < componentsPerCell; k += 1) {
      gammaValues.push(gammaConformal.values[offset + k]! * scale);
    }
  }

  if (cellCount > 0 && cellCount !== n) {
    return {
      path: `reconstructed:${gammaConformal.path}`,
      pathParts: [...gammaConformal.pathParts],
      values: gammaValues,
    };
  }
  return {
    path: `reconstructed:${gammaConformal.path}`,
    pathParts: [...gammaConformal.pathParts],
    values: gammaValues,
  };
}

function hydrateStrictState(state: GateState, fields: FieldPack, invariantsPresent: boolean): GateState {
  const fieldProvenance = isJsonObject(state.fieldProvenance) ? { ...state.fieldProvenance } : {};
  const defaults = {
    observer: state.observer || "eulerian_n",
    chart: state.chart || "comoving_cartesian",
  };
  const has = (name: "alpha" | "beta" | "gammaPhys" | "gammaConformal" | "phi" | "gtt" | "theta" | "kTrace" | "clockRate" | "curvature") => {
    if (name === "clockRate") return !!fields.alpha?.values.length;
    if (name === "curvature") return invariantsPresent;
    if (name === "gammaPhys") return !!fields.gammaPhys?.values.length;
    if (name === "gammaConformal") return !!fields.gammaConformal?.values.length;
    const value = fields[name] as { values: number[] } | null;
    return !!value && value.values.length > 0;
  };
  const ensure = (
    aliases: string[],
    sourceHint: string,
    definitionId: string,
    units: string,
    hasField: boolean,
    sourceFallback = false,
  ) => {
    if (!hasField) return;
    const existing = normalizeProvenanceValue(pickProvenanceRecord(fieldProvenance, aliases));
    const rawSource = existing && typeof existing.source === "string" ? existing.source : "";
    let source = rawSource && rawSource !== "none" ? rawSource : sourceHint;
    if (sourceFallback && (!rawSource || rawSource === "none")) source = sourceHint;
    if (!source) return;
    fieldProvenance[aliases[0]] = {
      ...(existing ?? {}),
      source,
      observer: typeof existing?.observer === "string" && existing.observer.length > 0 ? existing.observer : defaults.observer,
      chart: typeof existing?.chart === "string" && existing.chart.length > 0 ? existing.chart : defaults.chart,
      units: typeof existing?.units === "string" && existing.units.length > 0 ? existing.units : units,
      definitionId:
        typeof existing?.definitionId === "string" && existing.definitionId.length > 0
          ? existing.definitionId
          : definitionId,
      isProxy: typeof existing?.isProxy === "boolean" ? existing.isProxy : false,
    };
  };

  ensure(["alpha", "lapse"], "gr-brick", "alpha", "1", has("alpha"));
  ensure(["beta", "shift"], "gr-brick", "beta", "1", has("beta"), true);
  ensure(
    ["gamma", "gamma_phys", "gamma_phys_ij", "tilde_gamma", "conformal_gamma", "phi", "bssn_gamma"],
    "gr-brick",
    "gamma",
    "1",
    has("gammaPhys") || has("gammaConformal"),
    true,
  );
  ensure(["theta", "theta_metric"], "gr-brick", "theta", "1", has("theta"), true);
  ensure(["ktrace", "k_trace", "ktr"], "gr-brick", "K", "1", has("kTrace"), true);
  ensure(["clockRate", "clock_rate", "alpha", "lapse"], "gr-brick", "clockRate", "1/s", has("clockRate"), true);
  ensure(
    ["kretschmann", "riccisq", "ricciscalar", "weylsq", "weyl", "riemann", "curvature"],
    "gr-brick",
    "curvature",
    "1",
    has("curvature"),
    true,
  );

  return {
    ...state,
    sourceForBeta:
      state.sourceForBeta && state.sourceForBeta !== "none"
        ? state.sourceForBeta
        : has("beta")
          ? "gr-brick"
          : state.sourceForBeta,
    sourceForTheta:
      state.sourceForTheta && state.sourceForTheta !== "none"
        ? state.sourceForTheta
        : has("theta")
          ? "gr-brick"
          : state.sourceForTheta,
    fieldProvenance,
  };
}

function runChecks(bundle: RunBundle): CheckReport {
  const strict = buildGateState(bundle.diagnostics);
  const fields = resolveFieldCandidates(bundle.grBrick);
  const invariants = inferInvariants(bundle.grBrick);
  const strictState = hydrateStrictState(strict, fields, invariants.length > 0);
  const gateChecks = evaluateGate(strictState);
  const strictMode = strictState.strictMode || strictState.strictCongruence;
  fields.truthHashes = {};
  fields.truthSources = {};
  fields.truthHashes.alpha = stableHash(fields.alpha?.values ?? []);
  fields.truthHashes.beta = stableHash(fields.beta?.values ?? []);
  fields.truthHashes.gammaPhys = stableHash(fields.gammaPhys?.values ?? []);
  fields.truthHashes.gammaConformal = stableHash(fields.gammaConformal?.values ?? []);
  fields.truthHashes.phi = stableHash(fields.phi?.values ?? []);
  fields.truthHashes.theta = stableHash(fields.theta?.values ?? []);
  fields.truthHashes.kTrace = stableHash(fields.kTrace?.values ?? []);
  fields.truthHashes.gtt = stableHash(fields.gtt?.values ?? []);
  fields.truthSources = collectTruthSources(fields, strictState.fieldProvenance);

  const cells = fields.alpha?.values.length ?? 0;
  const gamma = reconstructGamma(fields.gammaPhys, fields.phi, fields.gammaConformal, cells);

  const gtt = contractGttResidual(
    fields.alpha?.values ?? null,
    fields.beta?.values ?? null,
    gamma?.values ?? null,
    fields.gtt?.values ?? null,
    strictMode,
    fields.betaRepresentation,
  );
  const thetaK = thetaKResidual(fields.theta?.values ?? null, fields.kTrace?.values ?? null);
  const checks: CheckStatus[] = [
    ...gateChecks,
    {
      name: "gttResidual",
      status: gtt.status,
      details: gtt.details,
      metrics: {
        gttRelativeResidual: Number.isFinite(gtt.residual) ? gtt.residual : "n/a",
        timelikeFrac: Number.isFinite(gtt.timelikeFrac) ? gtt.timelikeFrac : "n/a",
      },
    },
    {
      name: "thetaK",
      status: thetaK.status,
      details: thetaK.details,
      metrics: {
        thetaKRelativeResidual: Number.isFinite(thetaK.residual) ? thetaK.residual : "n/a",
      },
    },
    {
      name: "truthFields",
      status: strictMode && (!fields.alpha || !fields.beta || !fields.kTrace || !fields.theta || !(fields.gammaPhys || fields.gammaConformal || (gamma && gamma.values.length > 0)))
        ? "FAIL"
        : fields.alpha && fields.beta && (fields.gammaPhys || fields.gammaConformal || gamma) && fields.theta && fields.kTrace
          ? "PASS"
          : "WARN",
      details: [
        `alpha: ${fields.alpha?.path ?? "MISSING"}`,
        `beta: ${fields.beta?.path ?? "MISSING"}`,
        `gamma: ${fields.gammaPhys?.path ?? (gamma ? `${gamma.path} (${fields.gammaPhys ? "physical" : "reconstructed"})` : fields.gammaConformal?.path ?? fields.phi?.path ?? "MISSING")}`,
        `kTrace: ${fields.kTrace?.path ?? "MISSING"}`,
        `theta: ${fields.theta?.path ?? "MISSING"}`,
      ],
      metrics: {
        alphaCount: fields.alpha?.values.length ?? 0,
        betaCount: fields.beta?.values.length ?? 0,
        gammaCount: (fields.gammaPhys ?? gamma ?? fields.gammaConformal)?.values.length ?? 0,
        thetaCount: fields.theta?.values.length ?? 0,
        kTraceCount: fields.kTrace?.values.length ?? 0,
      },
    },
    {
      name: "gammaInputPresence",
      ...inferGammaSourcePath(fields, strictState, strictMode),
    },
    {
      name: "invariantAvailability",
      status: invariants.length > 0 ? "PASS" : strictMode ? "FAIL" : "WARN",
      details: [invariants.length > 0 ? `found ${invariants.length} invariants` : "no curvature invariants detected"],
      metrics: {
        invariants: invariants.length,
      },
    },
    {
      name: "fieldProvenancePresence",
      status:
        Object.keys(strictState.fieldProvenance).length > 0
          ? hasRequiredFieldProvenanceKeys(strictState.fieldProvenance, ["fieldProvenanceSchema"]).length > 0
            ? "PASS"
            : "FAIL"
          : strictMode
            ? "FAIL"
            : "WARN",
      details: [
        Object.keys(strictState.fieldProvenance).length > 0
          ? "field provenance metadata is present"
          : "field provenance metadata missing",
      ],
      metrics: { fieldProvenanceKeys: Object.keys(strictState.fieldProvenance).length },
    },
    ...REQUIRED_FIELD_PROVENANCE_CHANNELS.map((channel) => {
      const aliases: Record<string, string[]> = {
        alpha: ["alpha", "lapse"],
        beta: ["beta", "shift", "beta_u", "beta_v", "beta_i", "beta_u", "beta_vector", "shift_vector"],
        gamma: ["gamma", "gamma_phys", "gamma_phys_ij", "gamma_ij", "tilde_gamma", "tilde_gamma_ij", "conformal_gamma", "phi", "bssn_gamma"],
        theta: ["theta", "theta_metric", "theta_eulerian", "theta_conformal"],
        kTrace: ["ktrace", "k_trace", "ktr", "k_trace_ij", "trace_k", "k"],
        clockRate: ["clockRate", "clock_rate", "alpha", "lapse"],
        curvature: ["kretschmann", "riccisq", "ricciscalar", "weylsq", "weyl", "riemann", "curvature"],
      };
        const result = evaluateChannelProvenance(strictMode, strictState.fieldProvenance, aliases[channel]);
        return {
          name: `fieldProvenance.${channel}`,
          status: result.status,
          details: result.details,
          metrics: result.metrics,
      } as CheckStatus;
    }),
    ...REQUIRED_TRUTH_CHANNELS.map((channel) => {
      const packed = getFieldByChannel(fields, channel);
      const source = fields.truthSources[channel] || "";
      const hasSource = source.length > 0;
      let status: Severity = "PASS";
      if (strictMode && (!packed || !hasSource)) status = "FAIL";
      else if (!packed || !hasSource) status = "WARN";
      if (strictMode && source && source !== "gr-brick") status = "FAIL";
      return {
        name: `truthSource.${channel}`,
        status,
        details: [`${channel} provenance source=${source || "unknown"}${packed ? "" : " (missing values)"}`],
        metrics: { source: source || "unknown", count: packed?.values.length ?? 0 },
      } as CheckStatus;
    }),
  ];

  const overall =
    checks.some((c) => c.status === "FAIL")
      ? "FAIL"
      : checks.some((c) => c.status === "WARN")
        ? "WARN"
        : "PASS";

  return {
    name: "run",
    status: overall,
    checks,
    metrics: {
      renderingSeed: strictState.renderingSeed || "n/a",
      renderingProbe: strictState.renderingProbe || "n/a",
      passCount: checks.filter((c) => c.status === "PASS").length,
      warnCount: checks.filter((c) => c.status === "WARN").length,
      failCount: checks.filter((c) => c.status === "FAIL").length,
    },
      raw: {
        strict: strictState,
        samples: {
        alphaCount: fields.alpha?.values.length ?? 0,
        betaCount: fields.beta?.values.length ?? 0,
        gammaCount: (fields.gammaPhys ?? gamma ?? fields.gammaConformal)?.values.length ?? 0,
        gttSampleCount: fields.gtt?.values.length ?? 0,
        thetaCount: fields.theta?.values.length ?? 0,
        kTraceCount: fields.kTrace?.values.length ?? 0,
      },
      truthHashes: {
        alpha: fields.truthHashes.alpha,
        beta: fields.truthHashes.beta,
        gammaPhys: fields.truthHashes.gammaPhys,
        gammaConformal: fields.truthHashes.gammaConformal,
        phi: fields.truthHashes.phi,
        theta: fields.truthHashes.theta,
        kTrace: fields.truthHashes.kTrace,
        gtt: fields.truthHashes.gtt,
      },
    },
  };
}

function compareTruthHashes(base: CheckReport, compare: CheckReport): CheckStatus {
  const baseHashes = base.raw.truthHashes;
  const compareHashes = compare.raw.truthHashes;
  const keys = Object.keys(baseHashes);
  const diffs: string[] = [];
  const same: string[] = [];
  for (const key of keys) {
    const b = baseHashes[key];
    const c = compareHashes[key];
    if (!b || !c) {
      continue;
    }
    if (b === c) {
      same.push(key);
    } else {
      diffs.push(key);
    }
  }
  const status: Severity = diffs.length === 0 ? "PASS" : "FAIL";
  return {
    name: "renderingInvariance.truthHashes",
    status,
    details: diffs.length === 0
      ? ["truth hashes match across compare bundles"]
      : [`truth channels changed by render-only diff: ${diffs.join(", ")}`],
    metrics: {
      comparedChannels: keys.length,
      matchedChannels: same.length,
      changedChannels: diffs.length,
      renderSeedMatch: base.raw && "strict" in base.raw && compare.raw && "strict" in compare.raw
        ? base.raw.strict.renderingSeed === compare.raw.strict.renderingSeed
        : (strictStrictEqual(base.raw.strict, compare.raw.strict, "renderingSeed")),
      renderProbeMatch: base.raw && "strict" in base.raw && compare.raw && "strict" in compare.raw
        ? base.raw.strict.renderingProbe === compare.raw.strict.renderingProbe
        : (strictStrictEqual(base.raw.strict, compare.raw.strict, "renderingProbe")),
    },
  };
}

function strictStrictEqual(left: Record<string, unknown>, right: Record<string, unknown>, metric: string): boolean {
  return (left?.[metric] as string | undefined) === (right?.[metric] as string | undefined);
}

function summarizeReport(report: CheckReport): void {
  console.log(`\nCurvature-congruence report: ${report.name}`);
  console.log(`Overall: ${report.status}`);
  for (const c of report.checks) {
    console.log(`- ${c.name}: ${c.status}`);
    for (const detail of c.details) {
      console.log(`  ${detail}`);
    }
    for (const [k, v] of Object.entries(c.metrics)) {
      console.log(`    ${k}=${v}`);
    }
  }
}

async function main() {
  const config = parseArgs();
  const primary = await loadBundle(config);
  const primaryReport = runChecks(primary);
  primaryReport.name = primary.name;
  summarizeReport(primaryReport);

  let compare: CheckReport | undefined;
  if (config.compareBundlePath) {
    const compareBundle = await loadBundleByPath(config.compareBundlePath);
    compare = runChecks(compareBundle);
    compare.name = compareBundle.name;
    const invariance = compareTruthHashes(primaryReport, compare);
    primaryReport.checks.push(invariance);
    if (invariance.status === "FAIL") {
      primaryReport.status = "FAIL";
    } else if (primaryReport.status !== "FAIL" && invariance.status === "WARN" && compare.status === "WARN") {
      primaryReport.status = "WARN";
    }
    summarizeReport(compare);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    config,
    primary: primaryReport,
    compare: compare ?? null,
  };
  await fs.mkdir(path.dirname(config.outputPath), { recursive: true });
  await fs.writeFile(config.outputPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`Wrote ${config.outputPath}`);
}

main().catch((error) => {
  console.error("curvature-congruence-check failed:", error);
  process.exit(1);
});
