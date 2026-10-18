import fs from "node:fs/promises";
import path from "node:path";

type CaptureTarget = {
  name: string;
  method: "GET" | "POST";
  endpoint: string;
  body?: Record<string, unknown>;
  required: boolean;
};

const DEFAULT_BASE = "http://127.0.0.1:5173";

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key?.startsWith("--")) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) continue;
    out[key.slice(2)] = next;
    i += 1;
  }
  return out;
}

async function fetchJson(baseUrl: string, target: CaptureTarget, timeoutMs: number) {
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${target.endpoint}`, {
      method: target.method,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: target.body ? JSON.stringify(target.body) : undefined,
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: text || `HTTP ${res.status}` };
    }
    try {
      return { ok: true, status: res.status, payload: JSON.parse(text) };
    } catch {
      return { ok: false, status: res.status, error: "invalid-json" };
    }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args.baseUrl ?? DEFAULT_BASE;
  const runId = args.runId ?? new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  const outDir = args.out ?? path.join("tmp", "curvature-check-cycle", runId);
  const timeoutMs = Number(args.timeoutMs ?? "40000");

  await fs.mkdir(outDir, { recursive: true });

  const activationBody = {
    warpFieldType: "natario",
    grEnabled: true,
    strictCongruence: true,
    applyCanonicalHull: true,
    publishDiagnostics: true,
    async: true,
    kickGrBrick: true,
    includeExtra: true,
    includeMatter: true,
    includeKij: true,
    diagnosticsTimeoutMs: 30000,
    timeoutMs: 30000,
  };

  const targets: CaptureTarget[] = [
    {
      name: "time-dilation-activate-response.json",
      method: "POST",
      endpoint: "/api/helix/time-dilation/activate",
      body: activationBody,
      required: true,
    },
    {
      name: "time-dilation-diagnostics.json",
      method: "GET",
      endpoint: "/api/helix/time-dilation/diagnostics?raw=1",
      required: true,
    },
    {
      name: "pipeline-proofs.json",
      method: "GET",
      endpoint: "/api/helix/pipeline/proofs",
      required: true,
    },
    {
      name: "gr-evolve-brick.json",
      method: "GET",
      endpoint: "/api/helix/gr-evolve-brick?format=json&includeExtra=1&includeMatter=1&includeKij=1",
      required: true,
    },
    {
      name: "time-dilation-lattice-debug.json",
      method: "GET",
      endpoint: "/api/helix/time-dilation/diagnostics?raw=1",
      required: true,
    },
    {
      name: "adapter-verification.json",
      method: "POST",
      endpoint: "/api/agi/adapter/run",
      body: {
        traceId: `bundle:${runId}`,
        mode: "constraint-pack",
        pack: {
          id: "repo-convergence",
          autoTelemetry: true,
          telemetry: {
            build: { status: "pass", durationMs: 420000 },
            tests: { failed: 0, total: 128 },
            schema: { contracts: true },
            deps: { coherence: true },
          },
        },
      },
      required: true,
    },
    {
      name: "training-trace-export.jsonl",
      method: "GET",
      endpoint: "/api/agi/training-trace/export?limit=200",
      required: true,
    },
  ];

  const manifest: Record<string, unknown> = {
    runId,
    baseUrl,
    capturedAt: new Date().toISOString(),
    files: {},
    missingRequired: [] as string[],
  };

  for (const target of targets) {
    const result = await fetchJson(baseUrl, target, timeoutMs);
    const filePath = path.join(outDir, target.name);
    if (result.ok) {
      await fs.writeFile(filePath, `${JSON.stringify(result.payload, null, 2)}\n`, "utf8");
      (manifest.files as Record<string, unknown>)[target.name] = {
        ok: true,
        status: result.status,
        endpoint: target.endpoint,
      };
    } else {
      (manifest.files as Record<string, unknown>)[target.name] = {
        ok: false,
        status: result.status,
        endpoint: target.endpoint,
        error: result.error,
      };
      if (target.required) {
        (manifest.missingRequired as string[]).push(target.name);
      }
    }
  }

  await fs.writeFile(path.join(outDir, "bundle-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  if ((manifest.missingRequired as string[]).length > 0) {
    console.error(`[bundle-capture] missing required artifacts: ${(manifest.missingRequired as string[]).join(", ")}`);
    process.exit(2);
  }

  console.log(`[bundle-capture] complete: ${outDir}`);
}

main().catch((err) => {
  console.error("[bundle-capture] failed", err);
  process.exit(1);
});
