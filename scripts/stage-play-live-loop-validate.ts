import { performance } from "node:perf_hooks";

type Args = {
  baseUrl: string;
  threadId: string;
  mailboxThreadId: string;
  sourceId: string | null;
  samples: number;
  intervalMs: number;
  timeoutMs: number;
  queueWake: boolean;
  runWakeCycle: boolean;
};

type MailState = {
  ok?: boolean;
  mailItems?: Array<Record<string, unknown>>;
  processedMailPackets?: Array<Record<string, unknown>>;
  microReasonerRuns?: Array<Record<string, unknown>>;
  wakeRequests?: Array<Record<string, unknown>>;
  wakeResults?: Array<Record<string, unknown>>;
  decisions?: Array<Record<string, unknown>>;
  transcriptRows?: Array<Record<string, unknown>>;
  mailboxThreadId?: string;
  requestedThreadId?: string;
};

type Sample = {
  sampledAt: string;
  requestMs: number;
  mailCount: number;
  processedCount: number;
  microRunCount: number;
  wakeRequestCount: number;
  wakeResultCount: number;
  decisionCount: number;
  latestMailId: string | null;
  latestPacketId: string | null;
  latestDecision: string | null;
  latestEffort: string | null;
  latestWakeAsk: boolean | null;
  latestRecommendedNext: string | null;
  latestPacketAgeMs: number | null;
  packetJsonChars: number;
  compactAskPacketChars: number;
  arbiterOnlyChars: number;
  fullMicroRunsChars: number;
};

const getArg = (name: string): string | null => {
  const direct = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
};

const parseBool = (value: string | null, fallback: boolean): boolean => {
  if (value === null) return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return fallback;
};

const args = (): Args => {
  const baseUrl = (getArg("--baseUrl") ?? "http://127.0.0.1:1498").replace(/\/+$/, "");
  const threadId = getArg("--threadId") ?? "helix-ask:desktop";
  const mailboxThreadId = getArg("--mailboxThreadId") ?? threadId;
  const sourceId = getArg("--sourceId");
  return {
    baseUrl,
    threadId,
    mailboxThreadId,
    sourceId,
    samples: Math.max(1, Math.floor(Number(getArg("--samples") ?? "20"))),
    intervalMs: Math.max(100, Math.floor(Number(getArg("--intervalMs") ?? "1000"))),
    timeoutMs: Math.max(1000, Math.floor(Number(getArg("--timeoutMs") ?? "30000"))),
    queueWake: parseBool(getArg("--queueWake"), false),
    runWakeCycle: parseBool(getArg("--runWakeCycle"), true),
  };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const readBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const readArray = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)) : [];

const parseTime = (value: unknown): number | null => {
  const text = readString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
};

const jsonChars = (value: unknown): number => JSON.stringify(value ?? null).length;

const compactPacketForAsk = (packet: Record<string, unknown>): Record<string, unknown> => ({
  packetId: packet.packetId,
  mailIds: packet.mailIds,
  observedFacts: readArrayish(packet.observedFacts).slice(0, 4),
  changedFacts: readArrayish(packet.changedFacts).slice(0, 4),
  risks: readArrayish(packet.riskMatches).slice(0, 4),
  effort: packet.effortEstimate,
  axioms: packet.axioms,
  hypotheses: readArrayish(packet.hypotheses).slice(0, 4),
  arbiter: packet.arbiter,
  recommendedNext: packet.recommendedNext,
  watchNext: readArrayish(packet.watchNext).slice(0, 4),
});

const arbiterOnlyForWake = (packet: Record<string, unknown>): Record<string, unknown> => ({
  packetId: packet.packetId,
  mailIds: packet.mailIds,
  effort: typeof packet.effortEstimate === "object" && packet.effortEstimate
    ? (packet.effortEstimate as Record<string, unknown>).currentEffort
    : "unknown",
  arbiter: packet.arbiter,
  recommendedNext: packet.recommendedNext,
  evidenceRefs: readArrayish(packet.evidenceRefs).slice(0, 10),
});

const readArrayish = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const getJson = async <T>(url: string): Promise<{ body: T; ms: number }> => {
  const started = performance.now();
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const ms = performance.now() - started;
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${await response.text()}`);
  return { body: await response.json() as T, ms };
};

const postJson = async <T>(url: string, body: Record<string, unknown>): Promise<{ body: T; ms: number }> => {
  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const ms = performance.now() - started;
  if (!response.ok) throw new Error(`POST ${url} failed: ${response.status} ${await response.text()}`);
  return { body: await response.json() as T, ms };
};

const stateUrl = (input: Args): string => {
  const params = new URLSearchParams({
    threadId: input.threadId,
    mailboxThreadId: input.mailboxThreadId,
    limit: "100",
  });
  if (input.sourceId) params.set("sourceId", input.sourceId);
  return `${input.baseUrl}/api/helix/stage-play/live-source-mail?${params}`;
};

const latestByCreatedAt = (values: Array<Record<string, unknown>>): Record<string, unknown> | null =>
  [...values].sort((a, b) => (parseTime(b.createdAt) ?? 0) - (parseTime(a.createdAt) ?? 0)).at(0) ?? null;

const sampleState = async (input: Args): Promise<Sample> => {
  const { body, ms } = await getJson<MailState>(stateUrl(input));
  const mailItems = readArray(body.mailItems);
  const packets = readArray(body.processedMailPackets);
  const runs = readArray(body.microReasonerRuns);
  const wakeRequests = readArray(body.wakeRequests);
  const wakeResults = readArray(body.wakeResults);
  const decisions = readArray(body.decisions);
  const latestMail = latestByCreatedAt(mailItems);
  const latestPacket = latestByCreatedAt(packets);
  const latestDecision = latestByCreatedAt(decisions);
  const nowMs = Date.now();
  const packetCreatedAt = parseTime(latestPacket?.createdAt);
  const arbiter = latestPacket?.arbiter && typeof latestPacket.arbiter === "object"
    ? latestPacket.arbiter as Record<string, unknown>
    : null;
  const effort = latestPacket?.effortEstimate && typeof latestPacket.effortEstimate === "object"
    ? latestPacket.effortEstimate as Record<string, unknown>
    : null;
  return {
    sampledAt: new Date().toISOString(),
    requestMs: ms,
    mailCount: mailItems.length,
    processedCount: packets.length,
    microRunCount: runs.length,
    wakeRequestCount: wakeRequests.length,
    wakeResultCount: wakeResults.length,
    decisionCount: decisions.length,
    latestMailId: readString(latestMail?.mailId),
    latestPacketId: readString(latestPacket?.packetId),
    latestDecision: readString(latestDecision?.decision),
    latestEffort: readString(effort?.currentEffort),
    latestWakeAsk: readBoolean(arbiter?.wakeAsk),
    latestRecommendedNext: readString(latestPacket?.recommendedNext),
    latestPacketAgeMs: packetCreatedAt === null ? null : Math.max(0, nowMs - packetCreatedAt),
    packetJsonChars: latestPacket ? jsonChars(latestPacket) : 0,
    compactAskPacketChars: latestPacket ? jsonChars(compactPacketForAsk(latestPacket)) : 0,
    arbiterOnlyChars: latestPacket ? jsonChars(arbiterOnlyForWake(latestPacket)) : 0,
    fullMicroRunsChars: jsonChars(runs),
  };
};

const runWakeCycle = async (input: Args): Promise<{ ms: number; summary: Record<string, unknown> }> => {
  const { body, ms } = await postJson<Record<string, unknown>>(
    `${input.baseUrl}/api/helix/stage-play/live-source-mail/wake/cycle`,
    {
      threadId: input.threadId,
      mailboxThreadId: input.mailboxThreadId,
      sourceId: input.sourceId ?? undefined,
      manualRun: false,
      baseUrl: input.baseUrl,
    },
  );
  return {
    ms,
    summary: {
      ok: body.ok,
      reason: (body.cycle as Record<string, unknown> | undefined)?.reason,
      status: (body.cycle as Record<string, unknown> | undefined)?.status,
      wakeResult: (body.cycle as Record<string, unknown> | undefined)?.result,
    },
  };
};

const queueWake = async (input: Args): Promise<{ ms: number; summary: Record<string, unknown> }> => {
  const { body, ms } = await postJson<Record<string, unknown>>(
    `${input.baseUrl}/api/helix/stage-play/live-source-mail/wake`,
    {
      threadId: input.threadId,
      mailboxThreadId: input.mailboxThreadId,
      sourceId: input.sourceId ?? undefined,
      limit: 3,
    },
  );
  return {
    ms,
    summary: {
      ok: body.ok,
      queued: body.queued,
      wakeRequestId: (body.wakeRequest as Record<string, unknown> | undefined)?.wakeRequestId,
      mailIds: (body.wakeRequest as Record<string, unknown> | undefined)?.mailIds,
      status: (body.wakeRequest as Record<string, unknown> | undefined)?.status,
    },
  };
};

const waitForFirstPacket = async (input: Args): Promise<Sample | null> => {
  const deadline = Date.now() + input.timeoutMs;
  let latest: Sample | null = null;
  while (Date.now() <= deadline) {
    latest = await sampleState(input);
    if (latest.processedCount > 0 && latest.latestPacketId) return latest;
    await sleep(Math.min(input.intervalMs, 1000));
  }
  return latest;
};

const verdict = (label: string, ok: boolean, detail: string): string =>
  `${ok ? "PASS" : "FAIL"} ${label}: ${detail}`;

const main = async () => {
  const input = args();
  console.log("Stage Play live mail-loop validation");
  console.log(JSON.stringify({
    baseUrl: input.baseUrl,
    threadId: input.threadId,
    mailboxThreadId: input.mailboxThreadId,
    sourceId: input.sourceId,
    samples: input.samples,
    intervalMs: input.intervalMs,
    timeoutMs: input.timeoutMs,
    queueWake: input.queueWake,
    runWakeCycle: input.runWakeCycle,
  }));

  const first = await waitForFirstPacket(input);
  if (!first?.latestPacketId) {
    console.log(verdict("live_packet_present", false, `no processed packet before timeout; last=${JSON.stringify(first)}`));
    process.exitCode = 1;
    return;
  }
  console.log(verdict("live_packet_present", true, `${first.latestPacketId}; mail=${first.latestMailId}`));

  const samples: Sample[] = [];
  for (let index = 0; index < input.samples; index += 1) {
    samples.push(await sampleState(input));
    if (input.queueWake) {
      const queued = await queueWake(input);
      console.log(`wake_queue sample=${index + 1} ms=${queued.ms.toFixed(1)} ${JSON.stringify(queued.summary)}`);
    }
    if (input.runWakeCycle) {
      const cycle = await runWakeCycle(input);
      console.log(`wake_cycle sample=${index + 1} ms=${cycle.ms.toFixed(1)} ${JSON.stringify(cycle.summary)}`);
    }
    await sleep(input.intervalMs);
  }

  const latest = samples.at(-1) ?? first;
  const requestTimes = samples.map((sample) => sample.requestMs);
  const maxRequestMs = Math.max(...requestTimes);
  const hasNewPackets = new Set(samples.map((sample) => sample.latestPacketId).filter(Boolean)).size > 1;
  const compactVsFullRatio = latest.fullMicroRunsChars > 0
    ? latest.compactAskPacketChars / latest.fullMicroRunsChars
    : 1;
  const arbiterVsFullRatio = latest.fullMicroRunsChars > 0
    ? latest.arbiterOnlyChars / latest.fullMicroRunsChars
    : 1;

  console.log("\nLatest sample:");
  console.log(JSON.stringify(latest, null, 2));
  console.log("\nClaims:");
  console.log(verdict(
    "micro_reasoner_packet_has_dot_fields",
    Boolean(latest.latestEffort && latest.latestRecommendedNext && latest.latestWakeAsk !== null),
    `effort=${latest.latestEffort}; recommendedNext=${latest.latestRecommendedNext}; wakeAsk=${latest.latestWakeAsk}`,
  ));
  console.log(verdict(
    "state_api_read_under_1s",
    maxRequestMs < 1000,
    `max=${maxRequestMs.toFixed(1)}ms`,
  ));
  console.log(verdict(
    "compact_prompt_smaller_than_full_runs",
    compactVsFullRatio < 0.35,
    `compact=${latest.compactAskPacketChars}; fullRuns=${latest.fullMicroRunsChars}; ratio=${compactVsFullRatio.toFixed(3)}`,
  ));
  console.log(verdict(
    "arbiter_only_around_1k_chars",
    latest.arbiterOnlyChars > 0 && latest.arbiterOnlyChars <= 1500,
    `arbiterOnly=${latest.arbiterOnlyChars}`,
  ));
  console.log(verdict(
    "live_source_is_cycling",
    hasNewPackets || samples.length === 1,
    `distinctLatestPacketIds=${new Set(samples.map((sample) => sample.latestPacketId).filter(Boolean)).size}`,
  ));
  console.log(verdict(
    "wake_path_observable",
    latest.wakeRequestCount > 0 || latest.wakeResultCount > 0 || latest.decisionCount > 0 || latest.latestWakeAsk === false,
    `wakeRequests=${latest.wakeRequestCount}; wakeResults=${latest.wakeResultCount}; decisions=${latest.decisionCount}; wakeAsk=${latest.latestWakeAsk}`,
  ));
};

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
