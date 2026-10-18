import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import {
  answerDebugMatchesAskTurn,
  hasRealtimeAuthenticationFailure,
  visibleTerminalMatchesGroundedArtifact,
} from "./lib/helix-ask-gpt-live-proof-evidence";

type JsonRecord = Record<string, unknown>;

type ProofAssertion = {
  id: string;
  status: "pass" | "fail" | "warn";
  detail: string;
};

type ProofScenario = {
  id: string;
  label: string;
  utterance: string;
  expectedOutcome: "worker_grounded" | "conversation_local";
  expectedRoute?: string;
  expectedCapabilities?: string[];
  expectedText: RegExp[];
  forbiddenText?: RegExp[];
  activatePanel?: string;
};

type NetworkReceipt = {
  method: string;
  path: string;
  status: number;
  observed_at_ms: number;
  detail_code?: string | null;
  transport_facts?: {
    execution_attempted: boolean;
    browser_media_api_referenced: boolean;
    media_capture_started: boolean;
    browser_tracks_created: boolean;
    webrtc_started: boolean;
    data_channels_created: boolean;
    openai_network_call_attempted: boolean;
  } | null;
};

type ProofScenarioResult = {
  id: string;
  label: string;
  utterance: string;
  expected_outcome: ProofScenario["expectedOutcome"];
  observed_outcome: string | null;
  selected_route: string | null;
  selected_runtime_agent_provider: string | null;
  handoff_id: string | null;
  worker_admission_id: string | null;
  ask_turn_id: string | null;
  visible_final_answer: string | null;
  provisional_spoken_text: string | null;
  grounded_spoken_text: string | null;
  timings_ms: {
    transcript_to_interim_request: number | null;
    transcript_to_grounded_answer: number | null;
    transcript_to_spoken_result: number | null;
  };
  fixture: {
    path: string;
    sha256: string;
    bytes: number;
  };
  artifacts: {
    server_debug: string;
    answer_debug: string | null;
  };
  assertions: ProofAssertion[];
  ok: boolean;
};

type AudioFixtureBridge = {
  ready: boolean;
  playBase64: (base64: string) => Promise<{ duration_ms: number }>;
};

const BASE_URL = (process.env.HELIX_ASK_BASE_URL ?? "http://127.0.0.1:1522").replace(/\/+$/, "");
const DEFAULT_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.HELIX_GPT_LIVE_PROOF_TIMEOUT_MS ?? 240_000),
);
const RUN_ID = `gpt-live-codex-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const OUTPUT_ROOT = path.resolve(
  process.env.HELIX_GPT_LIVE_PROOF_OUT ??
    path.join("artifacts", "helix-ask", "gpt-live-codex-proof", RUN_ID),
);
const FIXTURE_DIR = path.resolve(
  process.env.HELIX_GPT_LIVE_PROOF_FIXTURE_DIR ?? path.join(OUTPUT_ROOT, "fixtures"),
);
const HEADLESS = !process.argv.includes("--headed");
const LIST_ONLY = process.argv.includes("--list");
const PREPARE_FIXTURES_ONLY = process.argv.includes("--prepare-fixtures");

const SCENARIOS: ProofScenario[] = [
  {
    id: "initial-panel-orientation",
    label: "Initial bounded workstation orientation",
    utterance: "What panel in the workstation is active right now?",
    expectedOutcome: "worker_grounded",
    expectedRoute: "workspace_panel",
    expectedCapabilities: ["workstation.active_context"],
    expectedText: [/account/i, /session/i],
  },
  {
    id: "relay-memory",
    label: "GPT Live memory of the relayed Codex result",
    utterance: "In five words, summarize the workstation result you just received.",
    expectedOutcome: "conversation_local",
    expectedText: [/account/i, /session/i],
    forbiddenText: [/\b(?:i(?:'m| am) )?check(?:ing)?\b/i],
  },
  {
    id: "panel-freshness",
    label: "Fresh panel context after a visible workstation change",
    utterance: "What panel in the workstation is active now?",
    expectedOutcome: "worker_grounded",
    expectedRoute: "workspace_panel",
    expectedCapabilities: ["workstation.active_context"],
    expectedText: [/scientific/i, /calculator/i],
    forbiddenText: [/account\s*(?:&|and)?\s*sessions?/i],
    activatePanel: "Scientific Calculator",
  },
  {
    id: "calculator-tool",
    label: "Governed calculator observation and re-entry",
    utterance: "Use the workstation calculator to compute seventeen times nineteen and tell me the verified result.",
    expectedOutcome: "worker_grounded",
    expectedRoute: "scientific_calculator",
    expectedText: [/\b323\b/],
  },
  {
    id: "repository-retrieval",
    label: "Governed repository retrieval and answer relay",
    utterance: "Check the codebase and name the file that implements server controlled provisional voice responses for GPT Live.",
    expectedOutcome: "worker_grounded",
    expectedRoute: "repo_code",
    expectedText: [/provisional-response\.ts/i],
  },
  {
    id: "negative-evidence-certainty",
    label: "Negative repository evidence without a stronger voice claim",
    utterance: "Search the codebase for the exact file helix-proof-missing-evidence-7f4c8e2a.txt. If the governed observation does not find it, say it was not found and do not guess that it exists.",
    expectedOutcome: "worker_grounded",
    expectedRoute: "repo_code",
    expectedText: [/(?:not|wasn't|was not|couldn't|could not)\s+(?:be\s+)?found|no\s+(?:matching\s+)?file|does\s+not\s+exist/i],
    forbiddenText: [/\b(?:verified|confirmed|definitely)\s+(?:that\s+)?(?:it\s+)?exists\b/i],
  },
];

const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;

const records = (value: unknown): JsonRecord[] =>
  Array.isArray(value) ? value.map(asRecord).filter((entry): entry is JsonRecord => Boolean(entry)) : [];

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const readStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

const getPath = (value: unknown, keys: readonly string[]): unknown => {
  let current: unknown = value;
  for (const key of keys) {
    current = asRecord(current)?.[key];
  }
  return current;
};

const sha256 = (value: Buffer | string): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const relativeArtifactPath = (absolutePath: string): string =>
  path.relative(process.cwd(), absolutePath).replace(/\\/g, "/");

const assertion = (
  id: string,
  condition: boolean,
  passDetail: string,
  failDetail: string,
  statusOnFailure: "fail" | "warn" = "fail",
): ProofAssertion => ({
  id,
  status: condition ? "pass" : statusOnFailure,
  detail: condition ? passDetail : failDetail,
});

const selectedScenarioIds = (): Set<string> | null => {
  const cli = process.argv.find((entry) => entry.startsWith("--scenarios="))?.split("=", 2)[1];
  const raw = cli ?? process.env.HELIX_GPT_LIVE_PROOF_SCENARIOS ?? "";
  const ids = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
};

const scenariosForRun = (): ProofScenario[] => {
  const selected = selectedScenarioIds();
  if (!selected) return SCENARIOS;
  const scenarios = SCENARIOS.filter((scenario) => selected.has(scenario.id));
  const unknown = [...selected].filter((id) => !SCENARIOS.some((scenario) => scenario.id === id));
  if (unknown.length) throw new Error(`unknown_scenarios:${unknown.join(",")}`);
  if (!scenarios.length) throw new Error("no_scenarios_selected");
  return scenarios;
};

const poll = async <T>(input: {
  label: string;
  read: () => Promise<T | null>;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<T> => {
  const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await input.read();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, input.intervalMs ?? 500));
  }
  const suffix = lastError instanceof Error ? `:${lastError.message}` : "";
  throw new Error(`timeout:${input.label}${suffix}`);
};

const readJsonResponse = async (response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<JsonRecord> => {
  const body = asRecord(await response.json().catch(() => null));
  if (!body) throw new Error(`invalid_json_response:${response.url()}`);
  return body;
};

const generateWindowsSpeechFixture = async (utterance: string, outputPath: string): Promise<void> => {
  if (process.platform !== "win32") {
    throw new Error(`speech_fixture_missing:${outputPath}`);
  }
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$voice.Rate = -1",
    "$voice.Volume = 100",
    "$voice.SetOutputToWaveFile($env:HELIX_PROOF_WAV_PATH)",
    "$voice.Speak($env:HELIX_PROOF_SPEECH_TEXT)",
    "$voice.Dispose()",
  ].join("\r\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      {
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          PATH: process.env.PATH,
          HELIX_PROOF_WAV_PATH: outputPath,
          HELIX_PROOF_SPEECH_TEXT: utterance,
        },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2_000);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve();
      } else {
        reject(new Error(`speech_fixture_generation_failed:${code ?? "unknown"}:${stderr.trim()}`));
      }
    });
  });
};

const prepareAudioFixture = async (scenario: ProofScenario): Promise<{
  absolutePath: string;
  base64: string;
  sha256: string;
  bytes: number;
}> => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const fixturePath = path.join(FIXTURE_DIR, `${scenario.id}.wav`);
  if (!fs.existsSync(fixturePath)) {
    await generateWindowsSpeechFixture(scenario.utterance, fixturePath);
  }
  const audio = fs.readFileSync(fixturePath);
  if (audio.length < 44 || audio.subarray(0, 4).toString("ascii") !== "RIFF") {
    throw new Error(`invalid_wav_fixture:${fixturePath}`);
  }
  return {
    absolutePath: fixturePath,
    base64: audio.toString("base64"),
    sha256: sha256(audio),
    bytes: audio.length,
  };
};

const DETERMINISTIC_MICROPHONE_SCRIPT = fs.readFileSync(
  path.resolve("scripts", "fixtures", "helix-gpt-live-proof-browser-init.js"),
  "utf8",
);

const installDeterministicMicrophone = async (context: BrowserContext): Promise<void> => {
  await context.addInitScript({ content: DETERMINISTIC_MICROPHONE_SCRIPT });
};

const activateDeterministicMicrophone = async (page: Page): Promise<void> => {
  await page.evaluate(DETERMINISTIC_MICROPHONE_SCRIPT);
};

const fetchRealtimeDebug = async (
  request: APIRequestContext,
  realtimeSessionId: string,
): Promise<JsonRecord> => {
  const response = await request.get(
    `${BASE_URL}/api/agi/realtime/session/${encodeURIComponent(realtimeSessionId)}/debug`,
  );
  if (!response.ok()) throw new Error(`realtime_debug_http_${response.status()}`);
  return readJsonResponse(response);
};

const inspectProofMicrophone = async (page: Page): Promise<JsonRecord> =>
  page.evaluate(() => {
    const getUserMedia = navigator.mediaDevices?.getUserMedia as
      | (MediaDevices["getUserMedia"] & { __helixProofMicrophone?: boolean })
      | undefined;
    const bridge = (window as Window & {
      __HELIX_GPT_LIVE_PROOF_AUDIO__?: AudioFixtureBridge;
    }).__HELIX_GPT_LIVE_PROOF_AUDIO__;
    return {
      media_devices_available: Boolean(navigator.mediaDevices),
      get_user_media_available: typeof getUserMedia === "function",
      proof_get_user_media_installed: getUserMedia?.__helixProofMicrophone === true,
      audio_fixture_bridge_ready: bridge?.ready === true,
    };
  });

const handoffsFromDebug = (debug: JsonRecord): JsonRecord[] => records(debug.handoffs);

const newestNewHandoff = (debug: JsonRecord, knownIds: ReadonlySet<string>): JsonRecord | null => {
  const candidates = handoffsFromDebug(debug)
    .filter((handoff) => {
      const id = readString(handoff.handoff_id);
      return Boolean(id && !knownIds.has(id));
    })
    .sort((left, right) => (readNumber(right.created_at_ms) ?? 0) - (readNumber(left.created_at_ms) ?? 0));
  return candidates[0] ?? null;
};

const collectAnswerDebug = async (page: Page): Promise<JsonRecord | null> => {
  const button = page.locator('[data-testid="helix-ask-latest-debug-copy"]');
  if ((await button.count()) === 0) return null;
  await page.evaluate(() => {
    delete (window as Window & { __HELIX_LAST_UNIFIED_DEBUG_COPY__?: string })
      .__HELIX_LAST_UNIFIED_DEBUG_COPY__;
  });
  await button.waitFor({ state: "visible", timeout: 15_000 });
  await poll({
    label: "debug_copy_enabled",
    timeoutMs: 15_000,
    read: async () => await button.isEnabled() ? true : null,
  });
  await button.click();
  const raw = await poll({
    label: "debug_export_materialized",
    timeoutMs: 20_000,
    read: async () => page.evaluate(() =>
      (window as Window & { __HELIX_LAST_UNIFIED_DEBUG_COPY__?: string })
        .__HELIX_LAST_UNIFIED_DEBUG_COPY__ ?? null),
  });
  return asRecord(JSON.parse(raw));
};

const completedOutputTranscripts = (answerDebug: JsonRecord | null): JsonRecord[] =>
  records(getPath(answerDebug, ["realtime_live_client_debug", "completed_output_transcripts"]));

const findOutputTranscript = (input: {
  answerDebug: JsonRecord | null;
  providerResponseRef?: string | null;
  handoffId?: string | null;
  purpose?: string | null;
}): JsonRecord | null => {
  const matches = completedOutputTranscripts(input.answerDebug).filter((transcript) => {
    if (input.providerResponseRef && transcript.provider_response_ref !== input.providerResponseRef) return false;
    if (input.handoffId && transcript.helix_handoff_id !== input.handoffId) return false;
    if (input.purpose && transcript.helix_response_purpose !== input.purpose) return false;
    return true;
  });
  return matches.at(-1) ?? null;
};

const visibleFinalAnswer = async (page: Page): Promise<string | null> => {
  const latest = page.locator('[data-testid="helix-ask-latest-final-answer"]');
  if ((await latest.count()) > 0) {
    return readString(await latest.getAttribute("data-final-answer-text"));
  }
  const answers = page.locator('[data-testid="helix-ask-console-final-answer"]');
  return (await answers.count()) > 0 ? readString(await answers.last().innerText()) : null;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const panelTabButton = (page: Page, panelTitle: string) => {
  const exactTitle = new RegExp(`^${escapeRegExp(panelTitle)}$`);
  const exactText = page.locator("span").filter({ hasText: exactTitle });
  return page.locator("button").filter({ has: exactText }).first();
};

const activatePanel = async (page: Page, panelTitle: string): Promise<void> => {
  const button = panelTabButton(page, panelTitle);
  await button.waitFor({ state: "visible", timeout: 20_000 });
  await button.click();
  await page.waitForTimeout(800);
};

const ensurePanelOpen = async (page: Page, panelTitle: string): Promise<void> => {
  const tab = panelTabButton(page, panelTitle);
  if ((await tab.count()) > 0 && await tab.isVisible()) return;

  const picker = page.locator('button[aria-expanded]').filter({ hasText: /^\s*\+\s*$/ }).first();
  await picker.waitFor({ state: "visible", timeout: 30_000 });
  await picker.click();

  const choice = page.getByRole("button", { name: panelTitle, exact: true });
  await choice.waitFor({ state: "visible", timeout: 20_000 });
  await choice.click();
  await tab.waitFor({ state: "visible", timeout: 20_000 });
};

const setCyclingControl = async (input: {
  page: Page;
  accessibleName: string;
  expectedText: RegExp;
  maxClicks?: number;
}): Promise<void> => {
  const button = input.page.getByRole("button", { name: input.accessibleName });
  await button.waitFor({ state: "visible", timeout: 30_000 });
  for (let click = 0; click <= (input.maxClicks ?? 6); click += 1) {
    if (input.expectedText.test((await button.innerText()).trim())) return;
    await button.click();
    await input.page.waitForTimeout(150);
  }
  throw new Error(`control_selection_failed:${input.accessibleName}`);
};

const selectCodexRuntime = async (page: Page): Promise<void> => {
  const button = page.getByRole("button", { name: "Choose Ask agent runtime" });
  await button.waitFor({ state: "visible", timeout: 30_000 });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (/codex/i.test((await button.innerText()).trim())) return;
    await button.click();
    const menuItem = page.getByRole("menuitemradio").filter({ hasText: /Codex/i });
    if ((await menuItem.count()) > 0 && await menuItem.first().isEnabled()) {
      await menuItem.first().click();
    }
    await page.waitForTimeout(200);
  }
  throw new Error("codex_runtime_selection_failed");
};

const ensureMicrophone = async (page: Page, enabled: boolean): Promise<void> => {
  const desiredLabel = enabled ? "Disable Live Voice microphone" : "Enable Live Voice microphone";
  if ((await page.getByRole("button", { name: desiredLabel }).count()) > 0) return;
  const toggleLabel = enabled ? "Enable Live Voice microphone" : "Disable Live Voice microphone";
  const toggle = page.getByRole("button", { name: toggleLabel });
  await toggle.waitFor({ state: "visible", timeout: 20_000 });
  await toggle.click();
  await page.getByRole("button", { name: desiredLabel }).waitFor({ state: "visible", timeout: 10_000 });
};

const waitForLiveRuntimeReady = async (page: Page): Promise<void> => {
  const microphone = page.getByRole("button", { name: "Enable Live Voice microphone" });
  const lifecycle = page.getByRole("button", { name: "Live runtime agent lifecycle" });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if ((await microphone.count()) > 0 && await microphone.isVisible()) return;
    const state = await lifecycle.getAttribute("data-lifecycle-state").catch(() => null);
    if (state === "error") {
      const detail = readString(await lifecycle.getAttribute("title").catch(() => null));
      throw new Error(`realtime_start_failed:${detail ?? "typed_lifecycle_error"}`);
    }
    await page.waitForTimeout(250);
  }
  throw new Error("timeout:live_runtime_microphone_control");
};

const collectFatalDiagnostics = async (page: Page): Promise<JsonRecord> => {
  const lifecycle = page.getByRole("button", { name: "Live runtime agent lifecycle" });
  const controls = await page.locator('button[aria-label^="Live runtime"], button[aria-label*="Live Voice"]')
    .evaluateAll((buttons) => buttons.slice(0, 12).map((button) => ({
      aria_label: button.getAttribute("aria-label"),
      text: (button.textContent ?? "").trim().slice(0, 160),
      title: button.getAttribute("title")?.slice(0, 240) ?? null,
      disabled: (button as HTMLButtonElement).disabled,
      lifecycle_state: button.getAttribute("data-lifecycle-state"),
    })));
  const alerts = await page.locator('[role="alert"]').allInnerTexts().catch(() => []);
  return {
    url: page.url(),
    lifecycle_state: await lifecycle.getAttribute("data-lifecycle-state").catch(() => null),
    lifecycle_title: await lifecycle.getAttribute("title").catch(() => null),
    controls,
    alerts: alerts.slice(0, 8).map((entry) => entry.trim().slice(0, 400)),
  };
};

const playFixture = async (page: Page, base64: string): Promise<number> => {
  const result = await page.evaluate(async (audio) => {
    const bridge = (window as Window & {
      __HELIX_GPT_LIVE_PROOF_AUDIO__?: AudioFixtureBridge;
    }).__HELIX_GPT_LIVE_PROOF_AUDIO__;
    if (!bridge?.ready) throw new Error("proof_audio_bridge_unavailable");
    return bridge.playBase64(audio);
  }, base64);
  return result.duration_ms;
};

const sanitizeArtifact = (value: unknown, depth = 0): unknown => {
  if (depth > 20) return "[depth-limited]";
  if (Array.isArray(value)) return value.map((entry) => sanitizeArtifact(entry, depth + 1));
  const record = asRecord(value);
  if (!record) return value;
  const output: JsonRecord = {};
  for (const [key, entry] of Object.entries(record)) {
    const normalized = key.toLowerCase();
    const explicitNonInclusionFlag = normalized.endsWith("_included") && entry === false;
    const sensitiveField =
      /authorization|cookie|password|secret|token|api_?key|apikey|(?:^|_)sdp(?:_|$)/.test(normalized) ||
      (normalized.includes("provider_payload") && !explicitNonInclusionFlag);
    if (sensitiveField) {
      output[key] = "[redacted]";
    } else {
      output[key] = sanitizeArtifact(entry, depth + 1);
    }
  }
  return output;
};

const writeSanitizedJson = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(sanitizeArtifact(value), null, 2)}\n`, "utf8");
};

const textMatches = (text: string | null, patterns: readonly RegExp[]): boolean =>
  Boolean(text && patterns.every((pattern) => pattern.test(text)));

const textAvoids = (text: string | null, patterns: readonly RegExp[]): boolean =>
  !text || patterns.every((pattern) => !pattern.test(text));

const runScenario = async (input: {
  scenario: ProofScenario;
  page: Page;
  request: APIRequestContext;
  realtimeSessionId: string;
  networkReceipts: NetworkReceipt[];
}): Promise<ProofScenarioResult> => {
  const { scenario, page, request, realtimeSessionId } = input;
  if (scenario.activatePanel) await activatePanel(page, scenario.activatePanel);

  const fixture = await prepareAudioFixture(scenario);
  const beforeDebug = await fetchRealtimeDebug(request, realtimeSessionId);
  const knownHandoffIds = new Set(
    handoffsFromDebug(beforeDebug).map((handoff) => readString(handoff.handoff_id)).filter(Boolean) as string[],
  );
  const finalAnswerCountBefore = await page.locator('[data-testid="helix-ask-console-final-answer"]').count();
  const networkIndex = input.networkReceipts.length;

  await ensureMicrophone(page, true);
  await playFixture(page, fixture.base64);
  const firstDebug = await poll({
    label: `${scenario.id}:transcript_handoff`,
    timeoutMs: 45_000,
    read: async () => {
      const debug = await fetchRealtimeDebug(request, realtimeSessionId);
      return newestNewHandoff(debug, knownHandoffIds) ? debug : null;
    },
  });
  await ensureMicrophone(page, false);

  const initialHandoff = newestNewHandoff(firstDebug, knownHandoffIds);
  if (!initialHandoff) throw new Error(`${scenario.id}:handoff_missing_after_poll`);
  const handoffId = readString(initialHandoff.handoff_id);
  if (!handoffId) throw new Error(`${scenario.id}:handoff_id_missing`);

  const settled = await poll({
    label: `${scenario.id}:turn_settled`,
    read: async () => {
      const debug = await fetchRealtimeDebug(request, realtimeSessionId);
      const handoff = handoffsFromDebug(debug).find((candidate) => candidate.handoff_id === handoffId);
      if (!handoff) return null;
      const admission = asRecord(handoff.worker_admission);
      const provisional = asRecord(handoff.provisional_response);
      const relay = asRecord(handoff.grounded_relay);
      if (admission?.outcome === "conversation_local") {
        return ["delivered", "failed", "interrupted", "suppressed"].includes(readString(provisional?.status) ?? "")
          ? { debug, handoff }
          : null;
      }
      return ["delivered", "failed", "suppressed", "stale", "cancelled"].includes(readString(relay?.status) ?? "")
        ? { debug, handoff }
        : null;
    },
  });

  const handoff = settled.handoff;
  const admission = asRecord(handoff.worker_admission);
  const dispatch = asRecord(admission?.dispatch);
  const provisional = asRecord(handoff.provisional_response);
  const grounded = asRecord(handoff.grounded_answer);
  const relay = asRecord(handoff.grounded_relay);
  const observedOutcome = readString(admission?.outcome);
  const workerTurn = observedOutcome !== "conversation_local";

  if (workerTurn) {
    await poll({
      label: `${scenario.id}:final_answer_rendered`,
      timeoutMs: 30_000,
      read: async () =>
        (await page.locator('[data-testid="helix-ask-console-final-answer"]').count()) > finalAnswerCountBefore
          ? true
          : null,
    });
  }
  await page.waitForTimeout(1_000);
  const expectedProviderResponseRefs = [
    readString(provisional?.provider_response_ref),
    workerTurn ? readString(relay?.provider_response_ref) : null,
  ].filter((entry): entry is string => Boolean(entry));
  const answerDebug = expectedProviderResponseRefs.length
    ? await poll({
        label: `${scenario.id}:completed_output_transcripts`,
        timeoutMs: 30_000,
        intervalMs: 1_000,
        read: async () => {
          const candidate = await collectAnswerDebug(page);
          const observedRefs = new Set(
            completedOutputTranscripts(candidate)
              .map((transcript) => readString(transcript.provider_response_ref))
              .filter((entry): entry is string => Boolean(entry)),
          );
          return expectedProviderResponseRefs.every((ref) => observedRefs.has(ref))
            ? candidate
            : null;
        },
      })
    : await collectAnswerDebug(page);
  const answer = workerTurn ? await visibleFinalAnswer(page) : null;
  const provisionalTranscript = findOutputTranscript({
    answerDebug,
    providerResponseRef: readString(provisional?.provider_response_ref),
    handoffId,
    purpose: readString(provisional?.kind),
  });
  const groundedTranscript = findOutputTranscript({
    answerDebug,
    providerResponseRef: readString(relay?.provider_response_ref),
    handoffId,
    purpose: "grounded_worker_relay",
  });
  const provisionalText = readString(provisionalTranscript?.sanitized_transcript_text);
  const groundedText = readString(groundedTranscript?.sanitized_transcript_text);
  const evaluatedText = workerTurn ? `${answer ?? ""}\n${groundedText ?? ""}`.trim() : provisionalText;
  const askTurnId = readString(grounded?.ask_turn_id);

  const handoffAt = readNumber(handoff.created_at_ms);
  const provisionalAt = readNumber(provisional?.created_at_ms);
  const groundedAt = readNumber(grounded?.recorded_at_ms);
  const relayAt = readNumber(relay?.completed_at_ms);
  const assertions: ProofAssertion[] = [];
  assertions.push(assertion(
    "transcript_handoff_correlated",
    Boolean(
      handoffId &&
      readString(handoff.transcript_observation_ref) &&
      readString(handoff.transcript_text_hash) &&
      (readNumber(handoff.transcript_text_char_count) ?? 0) > 0
    ),
    "A hashed transcript observation produced a correlated Stage Play handoff.",
    "The transcript observation, hash, character count, or handoff identity is missing.",
  ));
  assertions.push(assertion(
    "expected_admission_outcome",
    observedOutcome === scenario.expectedOutcome,
    `Admission outcome was ${observedOutcome}.`,
    `Expected ${scenario.expectedOutcome}, observed ${observedOutcome ?? "missing"}.`,
  ));
  assertions.push(assertion(
    "read_only_authority_boundary",
    handoff.read_only === true &&
      admission?.workstation_action_execution_allowed === false &&
      admission?.realtime_provider_tool_execution_allowed === false &&
      admission?.answer_authority === false,
    "The Realtime handoff remained read-only and non-authoritative.",
    "The read-only or authority boundary was not preserved in debug evidence.",
  ));
  assertions.push(assertion(
    "route_selection",
    !scenario.expectedRoute || admission?.selected_route === scenario.expectedRoute,
    `Selected route ${readString(admission?.selected_route) ?? "not constrained"}.`,
    `Expected route ${scenario.expectedRoute}, observed ${readString(admission?.selected_route) ?? "missing"}.`,
  ));
  const requiredCapabilities = readStrings(handoff.required_grounding_capability_ids);
  assertions.push(assertion(
    "required_grounding_capabilities",
    !scenario.expectedCapabilities || scenario.expectedCapabilities.every((id) => requiredCapabilities.includes(id)),
    `Required grounding capabilities: ${requiredCapabilities.join(", ") || "none"}.`,
    `Missing expected capability: ${scenario.expectedCapabilities?.join(", ") ?? "none"}.`,
  ));
  assertions.push(assertion(
    "provisional_response_after_admission",
    Boolean(
      provisional &&
      provisional.requested_after_admission === true &&
      handoffAt !== null &&
      provisionalAt !== null &&
      provisionalAt >= handoffAt
    ),
    "GPT Live response creation followed Helix admission.",
    "No correlated post-admission provisional response was recorded.",
  ));
  assertions.push(assertion(
    "provisional_audio_playback",
    provisional?.status === "delivered" && Boolean(readString(provisional.playback_receipt_ref)),
    "The browser confirmed provisional audio playback.",
    `Provisional playback ended as ${readString(provisional?.status) ?? "missing"}.`,
  ));
  assertions.push(assertion(
    "provisional_transcript_binding",
    Boolean(
      provisionalTranscript &&
      provisionalTranscript.helix_handoff_id === handoffId &&
      provisionalTranscript.raw_provider_metadata_included === false
    ),
    "The sanitized spoken interim/local transcript is bound to this handoff.",
    "No sanitized completed GPT Live transcript was bound to the provisional response.",
  ));

  if (workerTurn) {
    assertions.push(assertion(
      "codex_worker_selected",
      admission?.selected_runtime_agent_provider === "codex" &&
        dispatch?.target_runtime_agent_provider === "codex",
      "The admitted worker dispatch targeted Codex.",
      `Worker provider was ${readString(admission?.selected_runtime_agent_provider) ?? "missing"}.`,
    ));
    assertions.push(assertion(
      "worker_dispatch_receipt_precedes_interim",
      provisional?.requested_after_worker_dispatch_receipt === true &&
        Boolean(readString(provisional.worker_dispatch_receipt_ref)),
      "Operational interim speech followed the client worker-dispatch receipt.",
      "Interim speech was not proven to follow a worker-dispatch receipt.",
    ));
    assertions.push(assertion(
      "operational_interim_style",
      Boolean(provisionalText && /\bchecking\b/i.test(provisionalText)) &&
        !/\b(?:sorry|apolog|cannot|can't|unable)\b/i.test(provisionalText ?? ""),
      `Interim speech was operational: ${provisionalText}`,
      `Interim speech was missing, apologetic, or did not say it was checking: ${provisionalText ?? "missing"}.`,
    ));
    assertions.push(assertion(
      "completed_solver_terminal_authority",
      grounded?.completed_solver_path === true &&
        grounded?.server_authoritative === true &&
        answerDebugMatchesAskTurn(answerDebug, askTurnId),
      "The relayed answer and debug envelope identify the same completed, server-authoritative Ask turn.",
      "Completed solver authority or exact Ask-turn identity is missing.",
    ));
    assertions.push(assertion(
      "visible_terminal_matches_grounded_artifact",
      visibleTerminalMatchesGroundedArtifact({
        answer,
        answerDebug,
        groundedAnswer: grounded,
      }),
      "The visible final answer matches the selected debug answer and grounded artifact hash.",
      "The visible final answer is stale or does not match the grounded terminal artifact.",
    ));
    assertions.push(assertion(
      "grounding_evidence_present",
      readStrings(grounded?.evidence_refs).length > 0,
      `Grounded answer carried ${readStrings(grounded?.evidence_refs).length} evidence references.`,
      "The grounded answer carried no evidence references.",
    ));
    assertions.push(assertion(
      "grounded_relay_playback",
      relay?.status === "delivered" &&
        relay?.response_created === true &&
        Boolean(readString(relay.playback_receipt_ref)),
      "The correlated grounded relay was created and browser playback completed.",
      `Grounded relay ended as ${readString(relay?.status) ?? "missing"}.`,
    ));
    assertions.push(assertion(
      "grounded_spoken_transcript_binding",
      Boolean(
        groundedTranscript &&
        groundedTranscript.ask_turn_id === askTurnId &&
        groundedTranscript.helix_handoff_id === handoffId &&
        groundedTranscript.helix_worker_admission_id === admission?.admission_id &&
        groundedTranscript.ask_turn_binding_status === "grounded_relay_bound_to_selected_answer" &&
        groundedTranscript.grounded_relay_playback_confirmed === true
      ),
      "The spoken result transcript is bound to the exact handoff, admission, and selected Ask turn.",
      "No completed GPT Live transcript is bound to the exact selected grounded relay.",
    ));
    assertions.push(assertion(
      "grounded_voice_attribution",
      Boolean(groundedText && /\b(?:workstation|calculator|codebase|document|research)\b/i.test(groundedText)) &&
        !/\bI\s+(?:used|ran|checked|opened|searched|calculated|executed)\b/i.test(groundedText ?? ""),
      `Spoken result attributed the check without a personal tool claim: ${groundedText}`,
      `Spoken result lacked workstation attribution or claimed personal tool use: ${groundedText ?? "missing"}.`,
    ));
  } else {
    assertions.push(assertion(
      "conversation_local_did_not_dispatch_worker",
      dispatch?.kind === "none" && dispatch?.requested === false && grounded === null,
      "The follow-up remained in the provisional conversation lane.",
      "The conversation-local follow-up dispatched a worker or acquired terminal authority.",
    ));
    assertions.push(assertion(
      "conversation_local_style",
      textAvoids(provisionalText, [
        /\b(?:sorry|apolog|cannot|can't|unable)\b/i,
        /\b(?:i(?:'m| am) )?check(?:ing)?\b/i,
      ]),
      `Local response was concise and did not claim a check: ${provisionalText ?? "captured without text"}`,
      `Local response was apologetic or falsely claimed a check: ${provisionalText ?? "missing"}.`,
    ));
  }

  if (workerTurn) {
    assertions.push(assertion(
      "terminal_expected_answer_content",
      textMatches(answer, scenario.expectedText),
      "The Codex terminal answer contains the scenario's expected result.",
      `Expected content was absent from the Codex terminal answer: ${answer ?? "missing"}.`,
    ));
    assertions.push(assertion(
      "spoken_expected_answer_content",
      textMatches(groundedText, scenario.expectedText),
      "GPT Live's grounded spoken rendition contains the scenario's expected result.",
      `Expected content was absent from GPT Live's grounded spoken rendition: ${groundedText ?? "missing"}.`,
    ));
  } else {
    assertions.push(assertion(
      "local_expected_answer_content",
      textMatches(provisionalText, scenario.expectedText),
      "The conversation-local spoken response contains the expected result.",
      `Expected content was absent from the conversation-local response: ${provisionalText ?? "missing"}.`,
    ));
  }
  assertions.push(assertion(
    "stale_or_forbidden_content_absent",
    textAvoids(evaluatedText, scenario.forbiddenText ?? []),
    "No stale or forbidden result text was observed.",
    `Forbidden or stale text appeared in: ${evaluatedText ?? "missing"}.`,
  ));
  const scenarioNetwork = input.networkReceipts.slice(networkIndex);
  assertions.push(assertion(
    "no_realtime_authentication_failure",
    !hasRealtimeAuthenticationFailure(scenarioNetwork),
    "No Realtime endpoint or mapped client receipt reported an authentication failure.",
    "A Realtime endpoint or mapped client receipt reported an authentication failure.",
  ));

  const serverDebugPath = path.join(OUTPUT_ROOT, `${scenario.id}.server-debug.json`);
  const answerDebugPath = path.join(OUTPUT_ROOT, `${scenario.id}.answer-debug.json`);
  writeSanitizedJson(serverDebugPath, settled.debug);
  if (answerDebug) writeSanitizedJson(answerDebugPath, answerDebug);

  return {
    id: scenario.id,
    label: scenario.label,
    utterance: scenario.utterance,
    expected_outcome: scenario.expectedOutcome,
    observed_outcome: observedOutcome,
    selected_route: readString(admission?.selected_route),
    selected_runtime_agent_provider: readString(admission?.selected_runtime_agent_provider),
    handoff_id: handoffId,
    worker_admission_id: readString(admission?.admission_id),
    ask_turn_id: readString(grounded?.ask_turn_id),
    visible_final_answer: answer,
    provisional_spoken_text: provisionalText,
    grounded_spoken_text: groundedText,
    timings_ms: {
      transcript_to_interim_request:
        handoffAt !== null && provisionalAt !== null ? Math.max(0, provisionalAt - handoffAt) : null,
      transcript_to_grounded_answer:
        handoffAt !== null && groundedAt !== null ? Math.max(0, groundedAt - handoffAt) : null,
      transcript_to_spoken_result:
        handoffAt !== null && relayAt !== null ? Math.max(0, relayAt - handoffAt) : null,
    },
    fixture: {
      path: relativeArtifactPath(fixture.absolutePath),
      sha256: `sha256:${fixture.sha256}`,
      bytes: fixture.bytes,
    },
    artifacts: {
      server_debug: relativeArtifactPath(serverDebugPath),
      answer_debug: answerDebug ? relativeArtifactPath(answerDebugPath) : null,
    },
    assertions,
    ok: assertions.every((entry) => entry.status !== "fail"),
  };
};

const preflight = async (request: APIRequestContext): Promise<{
  endpoints: Record<string, number>;
  account_type: string | null;
  codex_visible: boolean;
  codex_enabled: boolean;
  codex_launchable: boolean;
  codex_runtime_reason: string | null;
}> => {
  const endpoints: Record<string, number> = {};
  const accountResponse = await request.get(`${BASE_URL}/api/account/session`);
  endpoints["/api/account/session"] = accountResponse.status();
  const account = await readJsonResponse(accountResponse);
  const pipelineResponse = await request.get(`${BASE_URL}/api/helix/pipeline`);
  endpoints["/api/helix/pipeline"] = pipelineResponse.status();
  if (!pipelineResponse.ok()) throw new Error(`pipeline_preflight_http_${pipelineResponse.status()}`);
  const providersResponse = await request.get(`${BASE_URL}/api/agi/agent-providers`);
  endpoints["/api/agi/agent-providers"] = providersResponse.status();
  const providerPayload = await readJsonResponse(providersResponse);
  const codex = records(providerPayload.providers).find((provider) => provider.id === "codex") ?? null;
  const runtimeStatus = asRecord(codex?.runtime_status);
  return {
    endpoints,
    account_type: readString(getPath(account, ["account_policy", "account_type"])),
    codex_visible: Boolean(codex),
    codex_enabled: codex?.enabled === true,
    codex_launchable: runtimeStatus?.launchable === true,
    codex_runtime_reason: readString(runtimeStatus?.reason),
  };
};

const renderMarkdown = (report: JsonRecord & {
  results: ProofScenarioResult[];
  summary: JsonRecord;
}): string => {
  const rows = report.results.map((result) => {
    const failed = result.assertions.filter((entry) => entry.status === "fail").map((entry) => entry.id);
    return `| ${result.ok ? "PASS" : "FAIL"} | ${result.label} | ${result.observed_outcome ?? "missing"} | ${result.selected_route ?? "none"} | ${result.timings_ms.transcript_to_grounded_answer ?? "n/a"} | ${failed.join(", ") || "none"} |`;
  });
  const globalFailures = records(report.global_assertions)
    .filter((entry) => entry.status === "fail")
    .map((entry) =>
      `- **global / ${readString(entry.id) ?? "unknown"}:** ${readString(entry.detail) ?? "No detail."}`,
    );
  const scenarioFailures = report.results.flatMap((result) =>
    result.assertions
      .filter((entry) => entry.status === "fail")
      .map((entry) => `- **${result.id} / ${entry.id}:** ${entry.detail}`),
  );
  const fatalError = readString(report.fatal_error);
  const failures = [
    ...globalFailures,
    ...scenarioFailures,
    ...(fatalError ? [`- **fatal_error:** ${fatalError}`] : []),
  ];
  return [
    "# GPT Live + Codex Workstation Proof",
    "",
    `- Run: \`${readString(report.run_id) ?? "unknown"}\``,
    `- Result: **${report.ok === true ? "PASS" : "FAIL"}**`,
    `- Passed scenarios: ${String(report.summary.pass ?? 0)}/${String(report.summary.total ?? 0)}`,
    `- Base URL: \`${readString(report.base_url) ?? "unknown"}\``,
    "- Audio input: deterministic WAV fixtures through a browser Web Audio `MediaStream`",
    "- Raw provider payloads: not retained",
    "",
    "| Result | Scenario | Admission | Route | Grounded ms | Failed checks |",
    "|---|---|---|---|---:|---|",
    ...rows,
    "",
    "## Failures",
    "",
    ...(failures.length ? failures : ["None."]),
    "",
    "## Interpretation",
    "",
    "A passing worker scenario proves transcript correlation, Codex admission and dispatch, a completed server-authoritative Ask result, and browser-confirmed GPT Live relay playback. A passing conversation-local scenario proves GPT Live can continue from the bounded context without pretending another workstation check ran.",
    "",
  ].join("\n");
};

const main = async (): Promise<number> => {
  const scenarios = scenariosForRun();
  if (LIST_ONLY) {
    process.stdout.write(`${JSON.stringify({
      schema: "helix.ask.gpt_live_codex_proof.scenarios.v1",
      scenarios: scenarios.map(({ id, label, utterance, expectedOutcome, expectedRoute }) => ({
        id,
        label,
        utterance,
        expected_outcome: expectedOutcome,
        expected_route: expectedRoute ?? null,
      })),
    }, null, 2)}\n`);
    return 0;
  }

  if (PREPARE_FIXTURES_ONLY) {
    const fixtures = [];
    for (const scenario of scenarios) {
      const fixture = await prepareAudioFixture(scenario);
      fixtures.push({
        scenario_id: scenario.id,
        path: relativeArtifactPath(fixture.absolutePath),
        sha256: `sha256:${fixture.sha256}`,
        bytes: fixture.bytes,
      });
    }
    process.stdout.write(`${JSON.stringify({
      schema: "helix.ask.gpt_live_codex_proof.fixtures.v1",
      fixtures,
      credential_environment_forwarded: false,
    }, null, 2)}\n`);
    return 0;
  }

  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const startedAtMs = Date.now();
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 1000 },
  });
  await installDeterministicMicrophone(context);
  const page = await context.newPage();
  const networkReceipts: NetworkReceipt[] = [];
  let realtimeSessionId: string | null = null;

  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/agi/realtime")) {
      let detailCode: string | null = null;
      let transportFacts: NetworkReceipt["transport_facts"] = null;
      if (url.pathname.endsWith("/client-receipt") || url.pathname.endsWith("/stop")) {
        const requestBody = asRecord(response.request().postDataJSON?.());
        detailCode = readString(
          requestBody?.failure_code ?? requestBody?.failure_reason ?? requestBody?.receipt_kind,
        );
        if (url.pathname.endsWith("/client-receipt")) {
          transportFacts = {
            execution_attempted: requestBody?.transport_execution_attempted === true,
            browser_media_api_referenced: requestBody?.browser_media_api_referenced === true,
            media_capture_started: requestBody?.media_capture_started === true,
            browser_tracks_created: requestBody?.browser_tracks_created === true,
            webrtc_started: requestBody?.webrtc_started === true,
            data_channels_created: requestBody?.data_channels_created === true,
            openai_network_call_attempted: requestBody?.openai_network_call_attempted === true,
          };
        }
      }
      networkReceipts.push({
        method: response.request().method(),
        path: url.pathname,
        status: response.status(),
        observed_at_ms: Date.now(),
        detail_code: detailCode,
        transport_facts: transportFacts,
      });
    }
    if (url.pathname === "/api/agi/realtime/session" && response.request().method() === "POST") {
      const payload = asRecord(await response.json().catch(() => null));
      realtimeSessionId = readString(payload?.realtime_session_id) ?? realtimeSessionId;
    }
  });

  const results: ProofScenarioResult[] = [];
  let initialContextSync: JsonRecord | null = null;
  let preflightResult: Awaited<ReturnType<typeof preflight>> | null = null;
  let proofMicrophonePreflight: JsonRecord | null = null;
  let fatalError: string | null = null;
  let fatalDiagnostics: JsonRecord | null = null;
  try {
    const profileId = `codex-gpt-live-proof-${RUN_ID}`;
    const signInResponse = await context.request.post(`${BASE_URL}/api/account/session/sign-in`, {
      data: {
        profile_id: profileId,
        display_name: "Codex GPT Live Proof",
        account_type: "developer",
      },
    });
    if (!signInResponse.ok()) throw new Error(`developer_sign_in_http_${signInResponse.status()}`);
    preflightResult = await preflight(context.request);
    if (preflightResult.account_type !== "developer") throw new Error("developer_account_policy_missing");
    if (!preflightResult.codex_visible || !preflightResult.codex_enabled || !preflightResult.codex_launchable) {
      throw new Error(`codex_not_launchable:${preflightResult.codex_runtime_reason ?? "unknown"}`);
    }

    const desktopUrl = new URL("/desktop", BASE_URL);
    desktopUrl.searchParams.set("panels", "account-session,scientific-calculator");
    desktopUrl.searchParams.set("focus", "account-session");
    await page.goto(desktopUrl.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
    await activateDeterministicMicrophone(page);
    proofMicrophonePreflight = await inspectProofMicrophone(page);
    if (proofMicrophonePreflight.proof_get_user_media_installed !== true) {
      throw new Error("proof_microphone_override_missing");
    }
    await ensurePanelOpen(page, "Account & Sessions");
    await ensurePanelOpen(page, "Scientific Calculator");
    await activatePanel(page, "Account & Sessions");
    await selectCodexRuntime(page);
    await setCyclingControl({
      page,
      accessibleName: "Live runtime agent mode",
      expectedText: /^Live Voice$/i,
    });
    await setCyclingControl({
      page,
      accessibleName: "Live runtime agent authority",
      expectedText: /^Observe$/i,
    });

    const lifecycle = page.getByRole("button", { name: "Live runtime agent lifecycle" });
    await lifecycle.waitFor({ state: "visible", timeout: 30_000 });
    if (!["active", "listening", "speaking", "muted"].includes(
      (await lifecycle.getAttribute("data-lifecycle-state")) ?? "",
    )) {
      await lifecycle.click();
    }
    await waitForLiveRuntimeReady(page);
    const sessionId = await poll({
      label: "realtime_session_id",
      timeoutMs: 60_000,
      read: async () => realtimeSessionId,
    });
    const initialDebug = await poll({
      label: "initial_stage_play_context_sync",
      timeoutMs: 60_000,
      read: async () => {
        const debug = await fetchRealtimeDebug(context.request, sessionId);
        const sync = asRecord(debug.latest_context_sync);
        return sync?.status === "sent" ? debug : null;
      },
    });
    initialContextSync = asRecord(initialDebug.latest_context_sync);

    for (const scenario of scenarios) {
      results.push(await runScenario({
        scenario,
        page,
        request: context.request,
        realtimeSessionId: sessionId,
        networkReceipts,
      }));
    }
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error);
    fatalDiagnostics = await collectFatalDiagnostics(page).catch(() => null);
    const screenshotPath = path.join(OUTPUT_ROOT, "fatal-browser-state.png");
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
    if (fatalDiagnostics) {
      fatalDiagnostics.screenshot = relativeArtifactPath(screenshotPath);
    }
  } finally {
    if (realtimeSessionId) {
      const lifecycle = page.getByRole("button", { name: "Live runtime agent lifecycle" });
      if ((await lifecycle.count()) > 0) {
        const state = await lifecycle.getAttribute("data-lifecycle-state").catch(() => null);
        if (state && !["off", "stopped", "error"].includes(state)) {
          await lifecycle.click().catch(() => undefined);
        }
      }
    }
    await browser.close();
  }

  const globalAssertions: ProofAssertion[] = [
    assertion(
      "preflight_endpoints",
      Boolean(preflightResult && Object.values(preflightResult.endpoints).every((status) => status === 200)),
      "Account session, pipeline, and agent-provider preflight endpoints returned HTTP 200.",
      "One or more preflight endpoints did not return HTTP 200.",
    ),
    assertion(
      "codex_launchable",
      preflightResult?.codex_visible === true &&
        preflightResult.codex_enabled === true &&
        preflightResult.codex_launchable === true,
      "Codex was visible, enabled, and launchable without exposing its binary or credentials.",
      `Codex was not launchable: ${preflightResult?.codex_runtime_reason ?? "missing preflight"}.`,
    ),
    assertion(
      "bounded_initial_context_sync",
      initialContextSync?.status === "sent" &&
        readString(initialContextSync.context_pack_id) !== null &&
        readString(initialContextSync.context_hash) !== null &&
        readStrings(initialContextSync.selected_refs).length > 0 &&
        initialContextSync.provider_event_type === "session.update" &&
        initialContextSync.provider_payload_included === false &&
        initialContextSync.response_created === false &&
        initialContextSync.answer_authority === false &&
        initialContextSync.assistant_answer === false &&
        initialContextSync.terminal_eligible === false &&
        initialContextSync.raw_content_included === false,
      `Initial bounded context sync sent ${readStrings(initialContextSync?.selected_refs).length} selected references.`,
      "The initial Stage Play context sync was missing, unbounded, or carried answer authority.",
    ),
    assertion(
      "no_realtime_authentication_failure_global",
      !hasRealtimeAuthenticationFailure(networkReceipts),
      "No observed Realtime request or mapped client receipt reported an authentication failure.",
      "At least one observed Realtime request or mapped client receipt reported an authentication failure.",
    ),
  ];
  if (fatalError) {
    globalAssertions.push({ id: "harness_completion", status: "fail", detail: fatalError });
  }
  const passCount = results.filter((result) => result.ok).length;
  const failedAssertions = [
    ...globalAssertions.filter((entry) => entry.status === "fail"),
    ...results.flatMap((result) => result.assertions.filter((entry) => entry.status === "fail")),
  ];
  const ok = !fatalError && failedAssertions.length === 0 && results.length === scenarios.length;
  const report = {
    schema: "helix.ask.gpt_live_codex_proof.v1",
    run_id: RUN_ID,
    base_url: BASE_URL,
    started_at_ms: startedAtMs,
    completed_at_ms: Date.now(),
    duration_ms: Date.now() - startedAtMs,
    browser: {
      engine: "chromium",
      headless: HEADLESS,
      microphone_fixture_transport: "browser_web_audio_media_stream_destination",
      hardware_microphone_used: false,
    },
    preflight: preflightResult,
    proof_microphone_preflight: proofMicrophonePreflight,
    initial_context_sync: initialContextSync,
    network_receipts: networkReceipts,
    global_assertions: globalAssertions,
    results,
    summary: {
      total: scenarios.length,
      completed: results.length,
      pass: passCount,
      fail: scenarios.length - passCount,
      assertion_failures: failedAssertions.length,
    },
    fatal_error: fatalError,
    fatal_diagnostics: fatalDiagnostics,
    provider_payload_included: false,
    credentials_included: false,
    raw_provider_audio_included: false,
    ok,
  };
  const jsonPath = path.join(OUTPUT_ROOT, "scorecard.json");
  const markdownPath = path.join(OUTPUT_ROOT, "scorecard.md");
  writeSanitizedJson(jsonPath, report);
  fs.writeFileSync(markdownPath, renderMarkdown(report), "utf8");
  process.stdout.write(JSON.stringify({
    ok,
    run_id: RUN_ID,
    scorecard_json: relativeArtifactPath(jsonPath),
    scorecard_markdown: relativeArtifactPath(markdownPath),
    scenarios_passed: passCount,
    scenarios_total: scenarios.length,
    assertion_failures: failedAssertions.length,
    fatal_error: fatalError,
  }, null, 2) + "\n");
  return ok ? 0 : 1;
};

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
