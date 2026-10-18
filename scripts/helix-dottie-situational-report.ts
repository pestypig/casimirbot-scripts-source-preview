import { execSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import request from "supertest";
import { missionBoardRouter } from "../server/routes/mission-board";
import { resetVoiceRouteState, voiceRouter } from "../server/routes/voice";

type Scenario = {
  id: string;
  intent: string;
  voice?: Record<string, unknown>;
  contextEvent?: { missionId: string; eventId: string; ts: string };
  ack?: { missionId: string; eventId: string; ackRefId: string; ts: string };
  expected: Record<string, unknown>;
};

type Fixture = {
  meta?: { name?: string; version?: number; generatedAt?: string };
  scenarios: Scenario[];
};

type ScenarioStep = {
  name: string;
  method: "POST" | "GET";
  path: string;
  request?: Record<string, unknown>;
  status: number;
  response: unknown;
};

type ScenarioResult = {
  id: string;
  intent: string;
  situationNarration: string;
  llmCandidateText: string;
  dotTranscript: string;
  expectedSummary: string;
  actualSummary: string;
  pass: boolean;
  failures: string[];
  steps: ScenarioStep[];
  reasoning: {
    suppressionReason?: string;
    replayMeta?: unknown;
    ackRefId?: string;
    triggerToDebriefClosedMs?: number;
  };
};

type CorrelationRow = {
  missionId: string | null;
  objectiveId: string | null;
  gapId: string | null;
  eventId: string | null;
  traceId: string | null;
  suppressionReason: string | null;
  policyClock: number | null;
  replayMeta: unknown;
  ackRefId: string | null;
  trigger_to_debrief_closed_ms: number | null;
};

type RunOutput = {
  generatedAt: string;
  fixturePath: string;
  headCommit: string;
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  replayConsistency: {
    scenarioA: string;
    scenarioB: string;
    pass: boolean;
    details: string;
  };
  results: ScenarioResult[];
  correlation: CorrelationRow[];
  overallPass: boolean;
};

type CliArgs = {
  fixture?: string;
  reportsDir: string;
  artifactsDir: string;
  softFail: boolean;
};

const parseArgs = (): CliArgs => {
  const args = process.argv.slice(2);
  const out: CliArgs = {
    reportsDir: "reports",
    artifactsDir: "artifacts/test-results",
    softFail: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--fixture") {
      out.fixture = args[i + 1];
      i += 1;
    } else if (token === "--reports-dir") {
      out.reportsDir = args[i + 1];
      i += 1;
    } else if (token === "--artifacts-dir") {
      out.artifactsDir = args[i + 1];
      i += 1;
    } else if (token === "--soft-fail") {
      out.softFail = true;
    }
  }
  return out;
};

const markdownEscape = (value: unknown): string =>
  String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, "<br/>");

const jsonFence = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;

const safeHeadCommit = (): string => {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim();
  } catch {
    return "unknown";
  }
};

const toFileTimestamp = (iso: string): string => iso.replace(/[:.]/g, "-");

const resolveFixturePath = async (override?: string): Promise<string> => {
  if (override && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  const fixtureDir = path.resolve("artifacts/test-inputs");
  const files = (await readdir(fixtureDir))
    .filter((name) => /^helix-dottie-situational-.*\.json$/.test(name))
    .sort();
  if (files.length === 0) {
    throw new Error(`No situational fixtures found under ${fixtureDir}`);
  }
  return path.join(fixtureDir, files[files.length - 1]);
};

const summarizeExpected = (expected: Record<string, unknown>): string => {
  if (expected.suppressed === true) {
    return `suppressed:${String(expected.reason ?? "unknown")}`;
  }
  if (expected.allowed === true) {
    return "allowed";
  }
  if (typeof expected.ackRefId === "string") {
    return `ackRefId=${expected.ackRefId}; trigger_to_debrief_closed_ms=${String(expected.trigger_to_debrief_closed_ms ?? "n/a")}`;
  }
  return JSON.stringify(expected);
};

const summarizeActual = (input: {
  voiceResponse?: Record<string, unknown>;
  ackResponse?: Record<string, unknown>;
}): string => {
  const voice = input.voiceResponse;
  if (voice) {
    if (voice.suppressed === true) {
      return `suppressed:${String(voice.reason ?? "unknown")}`;
    }
    if (voice.ok === true) {
      return "allowed";
    }
  }
  const ack = input.ackResponse;
  if (ack) {
    const ackRefId = (ack.receipt as { ackRefId?: string } | undefined)?.ackRefId;
    const metric = (ack.metrics as { trigger_to_debrief_closed_ms?: number } | undefined)?.trigger_to_debrief_closed_ms;
    return `ackRefId=${String(ackRefId ?? "n/a")}; trigger_to_debrief_closed_ms=${String(metric ?? "n/a")}`;
  }
  return "no-op";
};

const buildTranscriptMarkdown = (run: RunOutput): string => {
  const lines: string[] = [];
  lines.push("# Helix Dottie Situational Transcript Report");
  lines.push("");
  lines.push("## Run Metadata");
  lines.push(`- Timestamp (UTC): ${run.generatedAt}`);
  lines.push(`- Fixture: \`${run.fixturePath}\``);
  lines.push(`- Head commit: \`${run.headCommit}\``);
  lines.push(`- Scenario count: ${run.totalScenarios}`);
  lines.push(`- Passed: ${run.passedScenarios}`);
  lines.push(`- Failed: ${run.failedScenarios}`);
  lines.push("");
  lines.push("## Situation -> Dot Transcript Table");
  lines.push("");
  lines.push("| Scenario | Situation narration (event) | LLM candidate response | Dot transcript output | Expected | Actual | PASS/FAIL |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const row of run.results) {
    lines.push(
      `| ${markdownEscape(row.id)} | ${markdownEscape(row.situationNarration)} | ${markdownEscape(row.llmCandidateText)} | ${markdownEscape(row.dotTranscript)} | ${markdownEscape(row.expectedSummary)} | ${markdownEscape(row.actualSummary)} | ${row.pass ? "PASS" : "FAIL"} |`,
    );
  }
  lines.push("");
  lines.push("## Policy-Trace Correlation");
  lines.push("");
  lines.push("| missionId | objectiveId | gapId | eventId | traceId | suppressionReason | policyClock | replayMeta | ackRefId | trigger_to_debrief_closed_ms |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const row of run.correlation) {
    lines.push(`| ${markdownEscape(row.missionId ?? "")} | ${markdownEscape(row.objectiveId ?? "")} | ${markdownEscape(row.gapId ?? "")} | ${markdownEscape(row.eventId ?? "")} | ${markdownEscape(row.traceId ?? "")} | ${markdownEscape(row.suppressionReason ?? "")} | ${markdownEscape(row.policyClock ?? "")} | ${markdownEscape(JSON.stringify(row.replayMeta ?? null))} | ${markdownEscape(row.ackRefId ?? "")} | ${markdownEscape(row.trigger_to_debrief_closed_ms ?? "")} |`);
  }
  lines.push("");
  lines.push("## Replay Determinism Check");
  lines.push(
    `- ${run.replayConsistency.scenarioA} vs ${run.replayConsistency.scenarioB}: ${run.replayConsistency.pass ? "PASS" : "FAIL"} (${run.replayConsistency.details})`,
  );
  lines.push("");
  lines.push(`## Verdict`);
  lines.push(`- ${run.overallPass ? "GO" : "NO-GO"} (scenario contract ${run.overallPass ? "satisfied" : "failed"})`);
  lines.push("");
  return lines.join("\n");
};

const buildDebugMarkdown = (run: RunOutput, jsonPath: string): string => {
  const lines: string[] = [];
  lines.push("# Helix Dottie Situational Runtime Debug Report");
  lines.push("");
  lines.push("## Run Metadata");
  lines.push(`- Timestamp (UTC): ${run.generatedAt}`);
  lines.push(`- Fixture: \`${run.fixturePath}\``);
  lines.push(`- Head commit: \`${run.headCommit}\``);
  lines.push(`- Raw machine artifact: \`${jsonPath}\``);
  lines.push("");
  for (const row of run.results) {
    lines.push(`## ${row.id} - ${row.pass ? "PASS" : "FAIL"}`);
    lines.push(`- Intent: ${row.intent}`);
    lines.push(`- Situation narration: ${row.situationNarration}`);
    lines.push(`- LLM candidate response: ${row.llmCandidateText}`);
    lines.push(`- Dot transcript output: ${row.dotTranscript}`);
    lines.push(`- Expected: ${row.expectedSummary}`);
    lines.push(`- Actual: ${row.actualSummary}`);
    if (row.failures.length > 0) {
      lines.push(`- Failures: ${row.failures.join("; ")}`);
    }
    lines.push("");
    lines.push("### Reasoning Markers");
    lines.push(jsonFence(row.reasoning));
    lines.push("### Runtime Steps");
    row.steps.forEach((step, index) => {
      lines.push(`${index + 1}. \`${step.method} ${step.path}\` -> status ${step.status}`);
      if (step.request) {
        lines.push("Request:");
        lines.push(jsonFence(step.request));
      }
      lines.push("Response:");
      lines.push(jsonFence(step.response));
    });
    lines.push("");
  }
  lines.push("## Policy-Trace Correlation");
  lines.push(jsonFence(run.correlation));
  lines.push("## Replay Determinism");
  lines.push(jsonFence(run.replayConsistency));
  return lines.join("\n");
};

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use("/api/mission-board", missionBoardRouter);
  app.use("/api/voice", voiceRouter);
  return app;
};

const runScenarios = async (fixture: Fixture, fixturePath: string): Promise<RunOutput> => {
  const app = buildApp();
  process.env.TTS_BASE_URL = "";
  process.env.VOICE_PROXY_DRY_RUN = "1";
  resetVoiceRouteState();

  const generatedAt = new Date().toISOString();
  const results: ScenarioResult[] = [];
  const observed = new Map<string, string>();
  const correlation: CorrelationRow[] = [];

  for (const scenario of fixture.scenarios) {
    const steps: ScenarioStep[] = [];
    const failures: string[] = [];
    let dotTranscript = "No voice output requested for this scenario.";
    let voiceResponse: Record<string, unknown> | undefined;
    let ackResponse: Record<string, unknown> | undefined;

    const situationNarration = scenario.contextEvent
      ? `Mission ${scenario.contextEvent.missionId} event ${scenario.contextEvent.eventId}: ${scenario.intent}`
      : scenario.intent;
    const llmCandidateText =
      typeof scenario.voice?.text === "string"
        ? scenario.voice.text
        : "No candidate voice text in this scenario.";

    if (scenario.contextEvent) {
      const contextPayload = {
        eventId: scenario.contextEvent.eventId,
        eventType: "action_required",
        classification: "action",
        text: situationNarration,
        ts: scenario.contextEvent.ts,
        tier: "tier1",
        sessionState: "active",
        evidenceRefs: ["docs/helix-ask-flow.md#L1"],
      };
      const contextRes = await request(app)
        .post(`/api/mission-board/${scenario.contextEvent.missionId}/context-events`)
        .send(contextPayload);
      steps.push({
        name: "context_event",
        method: "POST",
        path: `/api/mission-board/${scenario.contextEvent.missionId}/context-events`,
        request: contextPayload,
        status: contextRes.status,
        response: contextRes.body,
      });
      if (contextRes.status !== 200) {
        failures.push(`context_event_status=${contextRes.status}`);
      }
    }

    if (scenario.voice) {
      const voicePayload = { ...scenario.voice } as Record<string, unknown>;
      const voiceRes = await request(app).post("/api/voice/speak").send(voicePayload);
      voiceResponse = voiceRes.body as Record<string, unknown>;
      steps.push({
        name: "voice_speak",
        method: "POST",
        path: "/api/voice/speak",
        request: voicePayload,
        status: voiceRes.status,
        response: voiceRes.body,
      });
      if (voiceRes.status !== 200) {
        failures.push(`voice_status=${voiceRes.status}`);
      }
      if (voiceRes.body?.suppressed === true) {
        dotTranscript = `[suppressed:${String(voiceRes.body.reason ?? "unknown")}]`;
      } else if (voiceRes.body?.ok === true) {
        dotTranscript = llmCandidateText;
      } else {
        dotTranscript = "Voice response envelope did not include ok/suppressed.";
      }
    }

    if (scenario.ack) {
      const ackPayload = {
        eventId: scenario.ack.eventId,
        ackRefId: scenario.ack.ackRefId,
        actorId: "operator-generated",
        ts: scenario.ack.ts,
      };
      const ackRes = await request(app)
        .post(`/api/mission-board/${scenario.ack.missionId}/ack`)
        .send(ackPayload);
      ackResponse = ackRes.body as Record<string, unknown>;
      steps.push({
        name: "ack_event",
        method: "POST",
        path: `/api/mission-board/${scenario.ack.missionId}/ack`,
        request: ackPayload,
        status: ackRes.status,
        response: ackRes.body,
      });
      if (ackRes.status !== 200) {
        failures.push(`ack_status=${ackRes.status}`);
      }

      const eventsRes = await request(app)
        .get(`/api/mission-board/${scenario.ack.missionId}/events`)
        .query({ limit: 50 });
      steps.push({
        name: "mission_events",
        method: "GET",
        path: `/api/mission-board/${scenario.ack.missionId}/events?limit=50`,
        status: eventsRes.status,
        response: eventsRes.body,
      });
      if (eventsRes.status !== 200) {
        failures.push(`events_status=${eventsRes.status}`);
      }
    }

    const expected = scenario.expected;
    const expectedSuppressed = expected.suppressed === true;
    if (scenario.voice) {
      if (expectedSuppressed) {
        if (voiceResponse?.suppressed !== true) {
          failures.push("expected_suppressed_but_not_suppressed");
        }
        const expectedReason = String(expected.reason ?? "");
        const actualReason = String(voiceResponse?.reason ?? "");
        if (expectedReason !== actualReason) {
          failures.push(`suppression_reason_mismatch:${actualReason}!=${expectedReason}`);
        }
      } else if (expected.allowed === true) {
        if (voiceResponse?.ok !== true || voiceResponse?.suppressed === true) {
          failures.push("expected_allowed_but_not_allowed");
        }
      }
    }

    if (scenario.ack) {
      const expectedAckRefId = String(expected.ackRefId ?? "");
      const actualAckRefId = String(
        (ackResponse?.receipt as { ackRefId?: string } | undefined)?.ackRefId ?? "",
      );
      if (expectedAckRefId !== actualAckRefId) {
        failures.push(`ack_ref_mismatch:${actualAckRefId}!=${expectedAckRefId}`);
      }
      const expectedMetric = Number(expected.trigger_to_debrief_closed_ms);
      const actualMetric = Number(
        (ackResponse?.metrics as { trigger_to_debrief_closed_ms?: number } | undefined)
          ?.trigger_to_debrief_closed_ms,
      );
      if (!Number.isFinite(expectedMetric) || expectedMetric !== actualMetric) {
        failures.push(`closure_metric_mismatch:${String(actualMetric)}!=${String(expectedMetric)}`);
      }
    }

    const expectedSummary = summarizeExpected(expected);
    const actualSummary = summarizeActual({ voiceResponse, ackResponse });
    observed.set(scenario.id, actualSummary);

    correlation.push({
      missionId: scenario.contextEvent?.missionId ?? scenario.ack?.missionId ?? (typeof scenario.voice?.missionId === "string" ? scenario.voice.missionId : null),
      objectiveId: typeof scenario.voice?.objectiveId === "string" ? scenario.voice.objectiveId : null,
      gapId: typeof scenario.voice?.gapId === "string" ? scenario.voice.gapId : null,
      eventId: scenario.contextEvent?.eventId ?? scenario.ack?.eventId ?? (typeof scenario.voice?.eventId === "string" ? scenario.voice.eventId : null),
      traceId: typeof scenario.voice?.traceId === "string" ? scenario.voice.traceId : null,
      suppressionReason: typeof voiceResponse?.reason === "string" ? String(voiceResponse.reason) : null,
      policyClock: typeof scenario.voice?.policyTsMs === "number" ? scenario.voice.policyTsMs : null,
      replayMeta: voiceResponse?.replayMeta ?? null,
      ackRefId: typeof (ackResponse?.receipt as { ackRefId?: string } | undefined)?.ackRefId === "string" ? (ackResponse?.receipt as { ackRefId?: string }).ackRefId ?? null : null,
      trigger_to_debrief_closed_ms:
        typeof (ackResponse?.metrics as { trigger_to_debrief_closed_ms?: number } | undefined)?.trigger_to_debrief_closed_ms === "number"
          ? (ackResponse?.metrics as { trigger_to_debrief_closed_ms?: number }).trigger_to_debrief_closed_ms ?? null
          : null,
    });

    results.push({
      id: scenario.id,
      intent: scenario.intent,
      situationNarration,
      llmCandidateText,
      dotTranscript,
      expectedSummary,
      actualSummary,
      pass: failures.length === 0,
      failures,
      steps,
      reasoning: {
        suppressionReason:
          typeof voiceResponse?.reason === "string" ? voiceResponse.reason : undefined,
        replayMeta: voiceResponse?.replayMeta,
        ackRefId:
          typeof (ackResponse?.receipt as { ackRefId?: string } | undefined)?.ackRefId === "string"
            ? (ackResponse?.receipt as { ackRefId?: string }).ackRefId
            : undefined,
        triggerToDebriefClosedMs:
          typeof (ackResponse?.metrics as { trigger_to_debrief_closed_ms?: number } | undefined)
            ?.trigger_to_debrief_closed_ms === "number"
            ? (ackResponse?.metrics as { trigger_to_debrief_closed_ms?: number }).trigger_to_debrief_closed_ms
            : undefined,
      },
    });
  }

  const replayA = observed.get("S13-replay-consistency-1");
  const replayB = observed.get("S14-replay-consistency-2");
  const replayPass = replayA !== undefined && replayA === replayB;
  if (!replayPass) {
    const rowA = results.find((row) => row.id === "S13-replay-consistency-1");
    const rowB = results.find((row) => row.id === "S14-replay-consistency-2");
    if (rowA) rowA.failures.push("replay_consistency_mismatch");
    if (rowB) rowB.failures.push("replay_consistency_mismatch");
    if (rowA) rowA.pass = false;
    if (rowB) rowB.pass = false;
  }

  const failedScenarios = results.filter((row) => !row.pass).length;
  const passedScenarios = results.length - failedScenarios;
  return {
    generatedAt,
    fixturePath,
    headCommit: safeHeadCommit(),
    totalScenarios: results.length,
    passedScenarios,
    failedScenarios,
    replayConsistency: {
      scenarioA: "S13-replay-consistency-1",
      scenarioB: "S14-replay-consistency-2",
      pass: replayPass,
      details: replayPass
        ? `matched:${String(replayA)}`
        : `mismatch:${String(replayA)} vs ${String(replayB)}`,
    },
    results,
    correlation,
    overallPass: failedScenarios === 0 && replayPass,
  };
};

const run = async () => {
  const args = parseArgs();
  const fixturePath = await resolveFixturePath(args.fixture);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
  if (!Array.isArray(fixture.scenarios) || fixture.scenarios.length === 0) {
    throw new Error(`Fixture has no scenarios: ${fixturePath}`);
  }
  const runOutput = await runScenarios(fixture, fixturePath);
  const stamp = toFileTimestamp(runOutput.generatedAt);
  const reportsDir = path.resolve(args.reportsDir);
  const artifactsDir = path.resolve(args.artifactsDir);
  await mkdir(reportsDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });

  const transcriptPath = path.join(reportsDir, `helix-dottie-situational-transcript-${stamp}.md`);
  const debugPath = path.join(reportsDir, `helix-dottie-situational-debug-${stamp}.md`);
  const jsonPath = path.join(artifactsDir, `helix-dottie-situational-run-${stamp}.json`);

  await writeFile(transcriptPath, buildTranscriptMarkdown(runOutput), "utf8");
  await writeFile(debugPath, buildDebugMarkdown(runOutput, jsonPath), "utf8");
  await writeFile(jsonPath, JSON.stringify(runOutput, null, 2), "utf8");

  console.log(
    JSON.stringify(
      {
        ok: runOutput.overallPass,
        generatedAt: runOutput.generatedAt,
        fixturePath,
        transcriptReport: transcriptPath,
        debugReport: debugPath,
        machineArtifact: jsonPath,
        totalScenarios: runOutput.totalScenarios,
        passedScenarios: runOutput.passedScenarios,
        failedScenarios: runOutput.failedScenarios,
        replayConsistency: runOutput.replayConsistency,
      },
      null,
      2,
    ),
  );

  if (!runOutput.overallPass && !args.softFail) {
    process.exitCode = 1;
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

