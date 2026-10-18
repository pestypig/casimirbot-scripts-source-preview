import { performance } from "node:perf_hooks";
import {
  STAGE_PLAY_LIVE_SOURCE_IMMERSION_STATE_SCHEMA,
  STAGE_PLAY_LIVE_SOURCE_MAIL_ITEM_SCHEMA,
  STAGE_PLAY_LIVE_SOURCE_PREDICTION_VALIDATION_SCHEMA,
  type StagePlayLiveSourceImmersionActivityV1,
  type StagePlayLiveSourceImmersionSalienceLevelV1,
  type StagePlayLiveSourceImmersionStateV1,
  type StagePlayLiveSourceMailItemV1,
  type StagePlayLiveSourcePredictionValidationRecommendedNextV1,
  type StagePlayLiveSourcePredictionValidationV1,
  type StagePlayProcessedMailPacketV1,
  type StagePlayMicroReasonerRunV1,
} from "../shared/contracts/stage-play-live-source-mail.v1";
import {
  buildStagePlayProcessedMailPacket,
  type StagePlayProcessedMailPacketTimingEntry,
} from "../server/services/stage-play/stage-play-processed-mail-packet";
import { resetStagePlayProcessedMailPacketStoreForTest } from "../server/services/stage-play/stage-play-processed-mail-packet-store";

type ScenarioName = "routine_inventory" | "cave_shift" | "urgent_damage" | "large_prompt_pressure";

type ScenarioConfig = {
  name: ScenarioName;
  scene: string;
  hud: string;
  hotbar: string;
  selectedItem: string;
  crosshairTarget: string;
  currentAction: string;
  visibleEntities: string[];
  changedSinceLastFrame: string[];
  riskCues: string[];
  opportunityCues: string[];
  next10sPrediction: string;
  activity: StagePlayLiveSourceImmersionActivityV1;
  salienceLevel: StagePlayLiveSourceImmersionSalienceLevelV1;
  salienceReasons: string[];
  voiceCandidate: boolean;
  validationResult: StagePlayLiveSourcePredictionValidationV1["result"];
  recommendedNext: StagePlayLiveSourcePredictionValidationRecommendedNextV1;
  extraChars?: number;
};

type IterationResult = {
  totalMs: number;
  timing: StagePlayProcessedMailPacketTimingEntry[];
  packet: StagePlayProcessedMailPacketV1;
  runs: StagePlayMicroReasonerRunV1[];
  sizes: Record<string, number>;
};

const parseArgs = (): { iterations: number; scenario: ScenarioName | "all" } => {
  const getArg = (name: string): string | null => {
    const direct = process.argv.find((arg) => arg.startsWith(`${name}=`));
    if (direct) return direct.slice(name.length + 1);
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] ?? null : null;
  };
  const iterations = Math.max(1, Math.floor(Number(getArg("--iterations") ?? getArg("-n") ?? "200")));
  const rawScenario = String(getArg("--scenario") ?? "all") as ScenarioName | "all";
  const scenario = ["routine_inventory", "cave_shift", "urgent_damage", "large_prompt_pressure", "all"].includes(rawScenario)
    ? rawScenario
    : "all";
  return { iterations, scenario };
};

const scenarios: ScenarioConfig[] = [
  {
    name: "routine_inventory",
    scene: "Interior wooden base with a chest interface open.",
    hud: "health and hunger appear stable; exact counts are uncertain",
    hotbar: "pickaxe, sword, torches, food, blocks",
    selectedItem: "chest slot uncertain",
    crosshairTarget: "open chest UI",
    currentAction: "sorting inventory inside base",
    visibleEntities: [],
    changedSinceLastFrame: ["chest inventory remains open", "no visible threat"],
    riskCues: [],
    opportunityCues: ["organized supplies visible"],
    next10sPrediction: "Player likely continues inventory management or exits the chest.",
    activity: "inventory_management",
    salienceLevel: "low",
    salienceReasons: ["stable inventory scene"],
    voiceCandidate: false,
    validationResult: "supported",
    recommendedNext: "wait_for_next_summary",
  },
  {
    name: "cave_shift",
    scene: "Low-light cave tunnel with stone walls and a branching path.",
    hud: "health visible but exact count uncertain",
    hotbar: "stone pickaxe, torches, food, sword",
    selectedItem: "torch",
    crosshairTarget: "dark cave branch",
    currentAction: "moving deeper into cave",
    visibleEntities: [],
    changedSinceLastFrame: ["scene shifted from surface to cave", "light level decreased"],
    riskCues: ["low light"],
    opportunityCues: ["ore-like blocks visible"],
    next10sPrediction: "Player likely places torches or continues cave exploration.",
    activity: "mining_or_cave",
    salienceLevel: "medium",
    salienceReasons: ["scene changed into cave exploration"],
    voiceCandidate: false,
    validationResult: "partially_supported",
    recommendedNext: "record_interpretation",
  },
  {
    name: "urgent_damage",
    scene: "Outdoor night scene near fire and hostile mobs.",
    hud: "health appears low; hunger uncertain",
    hotbar: "sword, food, blocks, torch",
    selectedItem: "sword",
    crosshairTarget: "hostile zombie near player",
    currentAction: "taking damage while backing up",
    visibleEntities: ["zombie", "skeleton"],
    changedSinceLastFrame: ["player is on fire", "hostile mob entered view", "damage cue visible"],
    riskCues: ["fire", "damage", "hostile mob", "low health"],
    opportunityCues: ["food item in hotbar"],
    next10sPrediction: "Player likely needs to recover, retreat, eat, or create distance.",
    activity: "combat_or_damage",
    salienceLevel: "urgent",
    salienceReasons: ["fire and damage cue detected", "hostile mob nearby"],
    voiceCandidate: true,
    validationResult: "contradicted",
    recommendedNext: "request_voice_callout",
  },
  {
    name: "large_prompt_pressure",
    scene: "Interior base, inventory UI, storage wall, crafting table, furnace, map wall, repeated visual details.",
    hud: "health stable; hunger stable; armor uncertain; coordinates hidden",
    hotbar: "pickaxe, sword, shovel, axe, torches, food, blocks, map, bucket",
    selectedItem: "pickaxe",
    crosshairTarget: "large chest wall",
    currentAction: "auditing supplies before next trip",
    visibleEntities: [],
    changedSinceLastFrame: ["inventory contents changed", "selected slot changed", "storage view changed"],
    riskCues: [],
    opportunityCues: ["many resources visible", "crafting station nearby", "food stocked"],
    next10sPrediction: "Player may finish organizing, craft supplies, then leave base for exploration.",
    activity: "inventory_management",
    salienceLevel: "medium",
    salienceReasons: ["preparation scene may precede travel or cave exploration"],
    voiceCandidate: false,
    validationResult: "partially_supported",
    recommendedNext: "record_interpretation",
    extraChars: 12_000,
  },
];

const jsonSize = (value: unknown): number => JSON.stringify(value).length;

const compactPacketForAsk = (packet: StagePlayProcessedMailPacketV1): Record<string, unknown> => ({
  packetId: packet.packetId,
  mailIds: packet.mailIds,
  observedFacts: packet.observedFacts.slice(0, 4),
  changedFacts: packet.changedFacts.slice(0, 4),
  risks: packet.riskMatches.slice(0, 4),
  effort: packet.effortEstimate,
  axioms: packet.axioms,
  hypotheses: packet.hypotheses?.slice(0, 4) ?? [],
  arbiter: packet.arbiter,
  recommendedNext: packet.recommendedNext,
  watchNext: packet.watchNext.slice(0, 4),
});

const arbiterOnlyForWake = (packet: StagePlayProcessedMailPacketV1): Record<string, unknown> => ({
  packetId: packet.packetId,
  mailIds: packet.mailIds,
  effort: packet.effortEstimate?.currentEffort ?? "unknown",
  arbiter: packet.arbiter,
  recommendedNext: packet.recommendedNext,
  evidenceRefs: packet.evidenceRefs.slice(0, 10),
});

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
};

const sumByStage = (results: IterationResult[]): Array<{ stage: string; p50: number; p95: number; max: number }> => {
  const stages = new Map<string, number[]>();
  for (const result of results) {
    for (const entry of result.timing) {
      const list = stages.get(entry.stage) ?? [];
      list.push(entry.durationMs);
      stages.set(entry.stage, list);
    }
  }
  return Array.from(stages.entries())
    .map(([stage, values]) => ({
      stage,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      max: Math.max(...values),
    }))
    .sort((a, b) => b.p95 - a.p95);
};

const makeMail = (scenario: ScenarioConfig, index: number): StagePlayLiveSourceMailItemV1 => {
  const now = new Date(1_780_000_000_000 + index).toISOString();
  const extra = scenario.extraChars ? `\nnotes: ${"resource route preparation ".repeat(Math.ceil(scenario.extraChars / 27))}` : "";
  const structured = {
    scene: scenario.scene,
    hud: scenario.hud,
    hotbar: scenario.hotbar,
    selected_item: scenario.selectedItem,
    crosshair_target: scenario.crosshairTarget,
    current_action: scenario.currentAction,
    visible_entities: scenario.visibleEntities,
    changed_since_last_frame: scenario.changedSinceLastFrame,
    risk_cues: scenario.riskCues,
    opportunity_cues: scenario.opportunityCues,
    next_10s_prediction: scenario.next10sPrediction,
  };
  const text = `${JSON.stringify(structured)}${extra}`;
  return {
    artifactId: "stage_play_live_source_mail_item",
    schemaVersion: STAGE_PLAY_LIVE_SOURCE_MAIL_ITEM_SCHEMA,
    mailId: `mail:${scenario.name}:${index}`,
    threadId: "thread:stage-play-loop-timing",
    roomId: "room:timing",
    environmentId: "env:timing",
    sourceId: "visual_source:minecraft",
    sourceKind: "visual_frame",
    sourceRefs: {
      sourceId: "visual_source:minecraft",
      frameRef: `visual_frame:${scenario.name}:${index}`,
      evidenceRef: `visual_evidence:${scenario.name}:${index}`,
      observationRef: `visual_observation:${scenario.name}:${index}`,
    },
    summary: {
      text,
      preview: text.slice(0, 420),
      confidence: 0.86,
      analysisState: "analysis_ready",
    },
    priorContext: {
      previousMailId: index > 0 ? `mail:${scenario.name}:${index - 1}` : null,
      previousEvidenceRef: index > 0 ? `visual_evidence:${scenario.name}:${index - 1}` : null,
      previousSummaryPreview: null,
    },
    objective: {
      objectiveId: "minecraft_observer_dot_style_loop",
      text: "Watch current Minecraft scene and decide whether a compact Ask wake is warranted.",
    },
    hints: {
      deterministicChangeHint: scenario.changedSinceLastFrame.length > 0 ? "summary_changed" : "summary_similar",
      elapsedMsSincePrevious: 10_000,
      sourceFreshness: "fresh",
    },
    status: "unread",
    evidenceRefs: [`visual_evidence:${scenario.name}:${index}`],
    createdAt: now,
    updatedAt: now,
    assistant_answer: false,
    terminal_eligible: false,
    context_role: "tool_evidence",
    raw_content_included: false,
  };
};

const makeImmersion = (scenario: ScenarioConfig, index: number): StagePlayLiveSourceImmersionStateV1 => {
  const now = new Date(1_780_000_000_000 + index).toISOString();
  return {
    artifactId: "stage_play_live_source_immersion_state",
    schemaVersion: STAGE_PLAY_LIVE_SOURCE_IMMERSION_STATE_SCHEMA,
    immersionStateId: `immersion:${scenario.name}:${index}`,
    jobId: "job:stage-play-loop-timing",
    policyId: "policy:micro_reasoner_watch",
    profileId: "profile:minecraft_observer",
    threadId: "thread:stage-play-loop-timing",
    roomId: "room:timing",
    environmentId: "env:timing",
    sourceIds: ["visual_source:minecraft"],
    latestMailIds: [`mail:${scenario.name}:${index}`],
    latestEvidenceRefs: [`visual_evidence:${scenario.name}:${index}`],
    sourceIdentity: {
      label: "Minecraft observer",
      confidence: 0.9,
      stable: true,
    },
    stableFacts: ["Minecraft visual source active", "player-controlled scene"],
    currentSceneFacts: [scenario.scene, scenario.hud, scenario.hotbar],
    changedFacts: scenario.changedSinceLastFrame,
    uncertainties: scenario.hud.includes("uncertain") ? ["exact HUD values uncertain"] : [],
    currentActivity: scenario.activity,
    salience: {
      level: scenario.salienceLevel,
      reasons: scenario.salienceReasons,
      voiceCandidate: scenario.voiceCandidate,
    },
    prediction: {
      predictionId: `prediction:${scenario.name}:${index}`,
      text: scenario.next10sPrediction,
      horizonMs: 10_000,
      watchTargets: ["activity shift", "risk cue", "route change"],
      validationSignals: scenario.changedSinceLastFrame,
      confidence: 0.62,
    },
    staleness: {
      state: "current",
    },
    evidenceRefs: [`immersion:${scenario.name}:${index}`, `visual_evidence:${scenario.name}:${index}`],
    createdAt: now,
    assistant_answer: false,
    terminal_eligible: false,
    context_role: "tool_evidence",
    raw_content_included: false,
  };
};

const makeValidation = (scenario: ScenarioConfig, index: number): StagePlayLiveSourcePredictionValidationV1 => ({
  artifactId: "stage_play_live_source_prediction_validation",
  schemaVersion: STAGE_PLAY_LIVE_SOURCE_PREDICTION_VALIDATION_SCHEMA,
  validationId: `prediction_validation:${scenario.name}:${index}`,
  jobId: "job:stage-play-loop-timing",
  priorPredictionId: index > 0 ? `prediction:${scenario.name}:${index - 1}` : null,
  newMailIds: [`mail:${scenario.name}:${index}`],
  result: scenario.validationResult,
  supportedSignals: scenario.validationResult === "supported" ? scenario.changedSinceLastFrame : [],
  contradictedSignals: scenario.validationResult === "contradicted" ? scenario.riskCues : [],
  newSignals: scenario.changedSinceLastFrame,
  salienceHint: scenario.salienceLevel,
  recommendedNext: scenario.recommendedNext,
  evidenceRefs: [`prediction_validation:${scenario.name}:${index}`, `mail:${scenario.name}:${index}`],
  createdAt: new Date(1_780_000_000_000 + index).toISOString(),
  assistant_answer: false,
  terminal_eligible: false,
  context_role: "tool_evidence",
});

const runScenario = (scenario: ScenarioConfig, iterations: number): IterationResult[] => {
  const results: IterationResult[] = [];
  let prior: StagePlayLiveSourceImmersionStateV1 | null = null;
  for (let index = 0; index < iterations; index += 1) {
    if (index % 100 === 0) resetStagePlayProcessedMailPacketStoreForTest();
    const mail = makeMail(scenario, index);
    const immersion = makeImmersion(scenario, index);
    const validation = makeValidation(scenario, index);
    const start = performance.now();
    const result = buildStagePlayProcessedMailPacket({
      jobId: "job:stage-play-loop-timing",
      sourceId: "visual_source:minecraft",
      mailItems: [mail],
      priorImmersionState: prior,
      immersionState: immersion,
      predictionValidation: validation,
      now: new Date(1_780_000_000_000 + index).toISOString(),
    });
    const totalMs = performance.now() - start;
    const packet = result.packet;
    const runs = result.microReasonerRuns;
    results.push({
      totalMs,
      timing: result.timing,
      packet,
      runs,
      sizes: {
        rawMailChars: mail.summary.text.length,
        packetJsonChars: jsonSize(packet),
        microReasonerRunsJsonChars: jsonSize(runs),
        microReasonerPreviewChars: runs.map((run) => `${run.inputPreview}\n${run.outputPreview}`).join("\n").length,
        compactAskPacketChars: jsonSize(compactPacketForAsk(packet)),
        arbiterOnlyWakeChars: jsonSize(arbiterOnlyForWake(packet)),
      },
    });
    prior = immersion;
  }
  return results;
};

const printScenario = (scenario: ScenarioConfig, results: IterationResult[]) => {
  const totals = results.map((result) => result.totalMs);
  const latest = results.at(-1);
  if (!latest) return;
  const under1s = results.filter((result) => result.totalMs <= 1000).length;
  const under10s = results.filter((result) => result.totalMs <= 10_000).length;
  console.log(`\nScenario: ${scenario.name}`);
  console.log(`iterations: ${results.length}`);
  console.log(`decision: ${latest.packet.recommendedNext} | wakeAsk=${latest.packet.arbiter?.wakeAsk ?? false} | effort=${latest.packet.effortEstimate?.currentEffort ?? "unknown"}`);
  console.log(`total_ms p50=${percentile(totals, 50).toFixed(3)} p95=${percentile(totals, 95).toFixed(3)} max=${Math.max(...totals).toFixed(3)}`);
  console.log(`budget_hit: <=1s ${under1s}/${results.length}; <=10s ${under10s}/${results.length}`);
  console.log("sizes_chars:", JSON.stringify(latest.sizes));
  console.log("stage_ms_p95_desc:");
  for (const entry of sumByStage(results).slice(0, 12)) {
    console.log(`  ${entry.stage}: p50=${entry.p50.toFixed(3)} p95=${entry.p95.toFixed(3)} max=${entry.max.toFixed(3)}`);
  }
};

const main = () => {
  const { iterations, scenario } = parseArgs();
  const selected = scenario === "all" ? scenarios : scenarios.filter((entry) => entry.name === scenario);
  console.log("Stage Play mail-loop timing benchmark");
  console.log(`iterations_per_scenario=${iterations}`);
  console.log("mode=deterministic_micro_reasoner_fast_layer");
  console.log("note=LLM/API latency is intentionally excluded; use this to size the sub-1s local wake-decision budget.");
  for (const entry of selected) {
    const results = runScenario(entry, iterations);
    printScenario(entry, results);
  }
};

main();
