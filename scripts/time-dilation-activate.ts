import fs from "node:fs";
import path from "node:path";
const DEFAULT_BASE_URL = "http://127.0.0.1:5173";
const DEFAULT_GRID_SCALE = 1;
const DEFAULT_GR_TARGET_DX_M = 5;

const parseArgs = (argv: string[]) => {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
};

const parseBool = (value: unknown, fallback: boolean) => {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "false" || value === "0") return false;
    if (value === "true" || value === "1") return true;
  }
  return fallback;
};

const postJson = async <T>(url: string, body: unknown, timeoutMs?: number): Promise<T> => {
  const controller = timeoutMs ? new AbortController() : null;
  const timeout = timeoutMs
    ? setTimeout(() => controller?.abort(), timeoutMs)
    : null;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: controller?.signal,
  });
  if (timeout) clearTimeout(timeout);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${url} failed (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = typeof args.url === "string" ? args.url : DEFAULT_BASE_URL;
  const outPath = typeof args.out === "string" ? args.out : undefined;
  const warpFieldType =
    typeof args.warpFieldType === "string" ? args.warpFieldType : "natario";
  const grEnabled = parseBool(args.grEnabled, true);
  const publish = parseBool(args.publish, true);
  const asyncMode = parseBool(args.async, false);
  const kickGrBrick = parseBool(args.kickGrBrick, true);
  const strictCongruence = parseBool(args.strictCongruence, true);
  const applyCanonicalHull = parseBool(args.applyCanonicalHull, true);
  const quality = typeof args.quality === "string" ? args.quality : undefined;
  const kickQuality = typeof args.kickQuality === "string" ? args.kickQuality : undefined;
  const gridScale =
    typeof args.gridScale === "string" ? Number(args.gridScale) : DEFAULT_GRID_SCALE;
  const grTargetDx =
    typeof args.grTargetDx === "string" ? Number(args.grTargetDx) : DEFAULT_GR_TARGET_DX_M;
  const timeoutMs =
    typeof args.timeoutMs === "string" ? Number(args.timeoutMs) : 15000;
  const diagnosticsTimeoutMs =
    typeof args.diagnosticsTimeoutMs === "string" ? Number(args.diagnosticsTimeoutMs) : undefined;
  const baseUrlOverride =
    typeof args.baseUrl === "string" ? args.baseUrl : undefined;
  const includeExtra = parseBool(args.includeExtra, true);
  const includeMatter = parseBool(args.includeMatter, true);
  const includeKij = parseBool(args.includeKij, true);
  const wallInvariant =
    args.wallInvariant === "ricci4" ? "ricci4" :
    args.wallInvariant === "kretschmann" ? "kretschmann" : undefined;

  const activation = await postJson<any>(
    `${baseUrl}/api/helix/time-dilation/activate`,
    {
      baseUrl: baseUrlOverride,
      warpFieldType,
      grEnabled,
      strictCongruence,
      applyCanonicalHull,
      publishDiagnostics: publish,
      async: asyncMode,
      kickGrBrick,
      quality,
      kickQuality,
      gridScale: Number.isFinite(gridScale) ? gridScale : DEFAULT_GRID_SCALE,
      grTargetDx: Number.isFinite(grTargetDx) ? grTargetDx : DEFAULT_GR_TARGET_DX_M,
      includeExtra,
      includeMatter,
      includeKij,
      wallInvariant,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
      diagnosticsTimeoutMs:
        typeof diagnosticsTimeoutMs === "number" && Number.isFinite(diagnosticsTimeoutMs)
          ? diagnosticsTimeoutMs
          : undefined,
    },
    Number.isFinite(timeoutMs) ? timeoutMs : undefined,
  );

  const payload = {
    ok: true,
    baseUrl,
    warpFieldType,
    grEnabled,
    activation,
  };

  if (outPath) {
    const resolvedOut = path.resolve(process.cwd(), outPath);
    fs.writeFileSync(resolvedOut, JSON.stringify(payload, null, 2));
  } else {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
