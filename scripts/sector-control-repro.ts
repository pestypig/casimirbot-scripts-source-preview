import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { buildSectorControlPlan } from "../server/control/sectorControlPlanner";
import type { SectorControlMode } from "../shared/schema";

type CliArgs = {
  outJson: string;
  outMd: string;
  writeMd: boolean;
  fixedTime: string | null;
};

type ModePlanCase = {
  mode: SectorControlMode;
  objective: string;
  timing?: {
    strobeHz?: number;
    sectorPeriod_ms?: number;
    TS_ratio?: number;
    tauLC_ms?: number;
    tauPulse_ms?: number;
  };
  allocation?: {
    sectorCount?: number;
    concurrentSectors?: number;
    negativeFraction?: number;
  };
  duty?: {
    dutyCycle?: number;
    dutyBurst?: number;
    dutyShip?: number;
  };
};

const DEFAULT_OUT_JSON =
  "artifacts/experiments/sector-control-repro/latest/summary.json";
const DEFAULT_OUT_MD = "reports/sector-control-prompt-batch.md";

const parseArgs = (): CliArgs => {
  const args = process.argv.slice(2);
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (!key.startsWith("--")) continue;
    const value = args[i + 1];
    if (value && !value.startsWith("--")) {
      map.set(key, value);
      i += 1;
    } else {
      map.set(key, "1");
    }
  }
  return {
    outJson: map.get("--out-json") ?? DEFAULT_OUT_JSON,
    outMd: map.get("--out-md") ?? DEFAULT_OUT_MD,
    writeMd: map.get("--no-md") !== "1",
    fixedTime: map.get("--fixed-time") ?? null,
  };
};

const PLAN_CASES: ModePlanCase[] = [
  {
    mode: "diagnostic",
    objective:
      "Baseline diagnostic planner replay for sector-strobed Natario/Casimir mapping.",
    timing: { strobeHz: 120, TS_ratio: 1.7, tauLC_ms: 10, tauPulse_ms: 2 },
    allocation: { sectorCount: 16, concurrentSectors: 3, negativeFraction: 0.25 },
    duty: { dutyCycle: 0.45, dutyBurst: 0.28, dutyShip: 0.18 },
  },
  {
    mode: "stability_scan",
    objective:
      "Stability sweep envelope with moderate concurrency and conservative duty dynamics.",
    timing: { strobeHz: 140, TS_ratio: 1.9, tauLC_ms: 9, tauPulse_ms: 1.8 },
    allocation: { sectorCount: 24, concurrentSectors: 4, negativeFraction: 0.22 },
    duty: { dutyCycle: 0.42, dutyBurst: 0.24, dutyShip: 0.16 },
  },
  {
    mode: "qi_conservative",
    objective:
      "QI-first conservative profile with tighter negative fraction and shorter pulse windows.",
    timing: { strobeHz: 180, TS_ratio: 2.2, tauLC_ms: 8, tauPulse_ms: 1.2 },
    allocation: { sectorCount: 24, concurrentSectors: 2, negativeFraction: 0.15 },
    duty: { dutyCycle: 0.35, dutyBurst: 0.16, dutyShip: 0.1 },
  },
  {
    mode: "theta_balanced",
    objective:
      "Theta-balanced control profile for stronger tracking under explicit guardrail checks.",
    timing: { strobeHz: 150, TS_ratio: 1.8, tauLC_ms: 9, tauPulse_ms: 1.6 },
    allocation: { sectorCount: 24, concurrentSectors: 5, negativeFraction: 0.3 },
    duty: { dutyCycle: 0.52, dutyBurst: 0.32, dutyShip: 0.22 },
  },
];

const writeFileSafe = (targetPath: string, content: string) => {
  const fullPath = path.resolve(process.cwd(), targetPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
  return fullPath;
};

const buildPromptBatchMarkdown = (input: {
  canonicalHash: string;
  outJson: string;
  modePlans: Array<{
    mode: SectorControlMode;
    firstFail: string | null;
    constraints: Record<string, string>;
    request: ModePlanCase;
  }>;
}) => {
  const lines: string[] = [];
  lines.push("# Sector Control Prompt Batch");
  lines.push("");
  lines.push("## Auto-run");
  lines.push(
    "Use this prompt with Codex Cloud to replay deterministic sector-control planning and wire outputs into proposal structures.",
  );
  lines.push("");
  lines.push("```text");
  lines.push("Execute the sector-control prompt batch in order.");
  lines.push("For each step:");
  lines.push("1) Call `physics.warp.sector_control.plan` with the exact JSON payload.");
  lines.push("2) Record `constraints`, `firstFail`, and observer overflow values.");
  lines.push("3) If `firstFail` is non-null, mark step `degraded` and continue.");
  lines.push("4) Emit an execution ledger row and include canonical hash verification.");
  lines.push(`Canonical replay hash: ${input.canonicalHash}`);
  lines.push(`Reference summary artifact: ${input.outJson}`);
  lines.push("```");
  lines.push("");
  lines.push("## Prompt Steps");
  lines.push("");
  input.modePlans.forEach((entry, index) => {
    lines.push(`### Prompt ${index}`);
    lines.push("");
    lines.push(`- mode: \`${entry.mode}\``);
    lines.push(`- expected firstFail: \`${entry.firstFail ?? "null"}\``);
    lines.push(
      `- expected constraints: \`${JSON.stringify(entry.constraints)}\``,
    );
    lines.push("");
    lines.push("```json");
    lines.push(
      JSON.stringify(
        {
          mode: entry.request.mode,
          overrides: {
            timing: entry.request.timing ?? {},
            allocation: entry.request.allocation ?? {},
            duty: entry.request.duty ?? {},
          },
        },
        null,
        2,
      ),
    );
    lines.push("```");
    lines.push("");
  });
  return lines.join("\n");
};

const main = () => {
  const args = parseArgs();

  const modePlans = PLAN_CASES.map((entry) => {
    const result = buildSectorControlPlan({
      mode: entry.mode,
      objective: entry.objective,
      timing: entry.timing,
      allocation: entry.allocation,
      duty: entry.duty,
    });
    return {
      mode: entry.mode,
      request: entry,
      firstFail: result.firstFail,
      constraints: result.plan.constraints,
      observerGrid: result.plan.observerGrid ?? null,
      plan: result.plan,
      ok: result.ok,
    };
  });

  const canonicalPayload = {
    version: 1,
    plannerTool: "physics.warp.sector_control.plan",
    matrix: [...modePlans]
      .sort((a, b) => a.mode.localeCompare(b.mode))
      .map((entry) => ({
      mode: entry.mode,
      request: {
        timing: entry.request.timing ?? {},
        allocation: entry.request.allocation ?? {},
        duty: entry.request.duty ?? {},
      },
      ok: entry.ok,
      firstFail: entry.firstFail,
      constraints: entry.constraints,
      observerGrid: entry.observerGrid,
      plan: entry.plan,
    })),
  };

  const canonicalText = JSON.stringify(canonicalPayload);
  const canonicalHash = crypto
    .createHash("sha256")
    .update(canonicalText)
    .digest("hex");

  const generatedAt = args.fixedTime ?? new Date().toISOString();

  const summary = {
    generatedAt,
    canonicalHash,
    canonicalPayload,
  };

  const outJsonPath = writeFileSafe(args.outJson, `${JSON.stringify(summary, null, 2)}\n`);

  let outMdPath: string | null = null;
  if (args.writeMd) {
    const md = buildPromptBatchMarkdown({
      canonicalHash,
      outJson: args.outJson,
      modePlans: [...modePlans].sort((a, b) => a.mode.localeCompare(b.mode)).map((entry) => ({
        mode: entry.mode,
        firstFail: entry.firstFail,
        constraints: entry.constraints,
        request: entry.request,
      })),
    });
    outMdPath = writeFileSafe(args.outMd, `${md}\n`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        canonicalHash,
        outJson: outJsonPath,
        outMd: outMdPath,
      },
      null,
      2,
    )}\n`,
  );
};

main();
