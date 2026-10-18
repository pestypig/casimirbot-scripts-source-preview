import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

type RecordLike = Record<string, unknown>;

const DEFAULT_BASE_URL = "http://127.0.0.1:5050";
const DEFAULT_BASE_URL_FALLBACKS = ["http://127.0.0.1:5050", "http://localhost:5050"];
const DEFAULT_OUT_DIR = "artifacts/helix-ask/scholarly-pdf-workbench-probe";
const DRY_RUN = process.argv.includes("--dry-run") || process.env.HELIX_ASK_SCHOLARLY_PDF_WORKBENCH_DRY_RUN === "1";

const readArg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  if (index >= 0 && typeof process.argv[index + 1] === "string") return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
};

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

const uniqueStrings = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)));

const readRecord = (value: unknown): RecordLike | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordLike : null;

const readArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const hashShort = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const payloadFromDebugExport = (value: unknown): RecordLike | null => {
  const record = readRecord(value);
  if (!record) return null;
  return readRecord(record.payload) ?? record;
};

async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json, text };
}

async function preflightDesktop(baseUrl: string): Promise<{ base_url: string; ok: boolean; status: number; error: string | null }> {
  return fetch(`${baseUrl}/desktop`).then(
    (response) => ({ base_url: baseUrl, ok: response.ok, status: response.status, error: null as string | null }),
    (error) => ({
      base_url: baseUrl,
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

async function resolveReachableBaseUrl(requestedBaseUrl: string): Promise<{
  baseUrl: string;
  attempts: Array<{ base_url: string; ok: boolean; status: number; error: string | null }>;
}> {
  const explicitBaseUrl = process.argv.includes("--base-url") || process.argv.some((arg) => arg.startsWith("--base-url="));
  const envBaseUrl = Boolean(process.env.HELIX_ASK_BASE_URL);
  const candidates = uniqueStrings(
    explicitBaseUrl || envBaseUrl
      ? [requestedBaseUrl]
      : [requestedBaseUrl, ...DEFAULT_BASE_URL_FALLBACKS],
  ).map(trimTrailingSlash);
  const attempts = [];
  for (const candidate of candidates) {
    const attempt = await preflightDesktop(candidate);
    attempts.push(attempt);
    if (attempt.ok) return { baseUrl: candidate, attempts };
  }
  return { baseUrl: requestedBaseUrl, attempts };
}

const workbenchFrom = (payload: RecordLike | null): RecordLike | null => {
  const debug = readRecord(payload?.debug);
  return readRecord(payload?.scholarly_pdf_workbench_state) ?? readRecord(debug?.scholarly_pdf_workbench_state);
};

const workbenchAffordanceActions = (workbench: RecordLike | null): string[] =>
  readArray(workbench?.affordances)
    .map(readRecord)
    .map((entry) => readString(entry?.action))
    .filter((entry): entry is string => Boolean(entry));

const REQUIRED_EVIDENCE_CHAIN_KEYS = [
  "paper_memory_ref",
  "pdf_ref",
  "rendered_page_refs",
  "ocr_math_packet_refs",
  "promoted_equation_refs",
  "scientific_packet_refs",
  "graph_reflection_refs",
];

const failedChecksForStep = (input: {
  askOk: boolean;
  selectedAffordanceOk: boolean;
  advertisedExpectedAffordance: boolean;
  hasWorkbenchState: boolean;
  hasDebugWorkbenchState: boolean;
  hasPageInventory: boolean;
  hasPageScout: boolean;
  pageScoutNonTerminal: boolean;
  hasEvidenceChain: boolean;
  evidenceChainShapeOk: boolean;
  hasTerminalAuthority: boolean;
  hasClaimBoundaries: boolean;
  imageLensSourceOk: boolean;
  terminalAuthorityReasonOk: boolean;
}): string[] => {
  const checks: Array<[string, boolean]> = [
    ["ask_turn_ok", input.askOk],
    ["selected_affordance_expected", input.selectedAffordanceOk],
    ["expected_affordance_advertised", input.advertisedExpectedAffordance],
    ["workbench_state_present", input.hasWorkbenchState],
    ["debug_export_workbench_state_present", input.hasDebugWorkbenchState],
    ["page_inventory_present", input.hasPageInventory],
    ["page_scout_present", input.hasPageScout],
    ["page_scout_non_terminal", input.pageScoutNonTerminal],
    ["evidence_chain_present", input.hasEvidenceChain],
    ["evidence_chain_shape_complete", input.evidenceChainShapeOk],
    ["terminal_authority_present", input.hasTerminalAuthority],
    ["claim_boundaries_present", input.hasClaimBoundaries],
    ["image_lens_source_continuity", input.imageLensSourceOk],
    ["terminal_authority_not_missing", input.terminalAuthorityReasonOk],
  ];
  return checks.filter(([, ok]) => !ok).map(([name]) => name);
};

const debugExportUrlFor = (baseUrl: string, turnId: string): string =>
  `${baseUrl}/api/agi/ask/turn/${encodeURIComponent(turnId)}/debug-export`;

const promptSequence = [
  {
    id: "render_page_1",
    prompt:
      "Use arXiv paper 1106.5543. Render page 1 into Image Lens and report only whether page evidence was created.",
    expectedAffordances: ["inspect_page", "find_first_displayed_equation"],
    requireImageLensSource: true,
  },
  {
    id: "find_first_equation",
    prompt:
      "Now inspect the next pages of that same paper and find the first displayed equation candidate. Report the page number and candidate only; do not promote it yet.",
    expectedAffordances: ["find_first_displayed_equation", "scan_next_pages"],
    requireImageLensSource: true,
  },
  {
    id: "crop_exact_row",
    prompt:
      "Use the page equation candidate you just found and crop only the exact equation row. Promote it only if the row crop supports exact equation admissibility.",
    expectedAffordances: ["crop_exact_equation_row", "promote_exact_row"],
    requireImageLensSource: true,
  },
  {
    id: "reflect_graph",
    prompt:
      "Reflect the promoted equation evidence to the Theory Badge Graph with diagnostic-only boundaries and report calculator payload admissibility.",
    expectedAffordances: ["reflect_to_theory_badge_graph", "build_scientific_evidence_packet"],
    requireImageLensSource: true,
  },
  {
    id: "audit_provenance",
    prompt:
      "Tell me which paper, page, equation, crop ref, and evidence depth you are using from the prior steps.",
    expectedAffordances: ["audit_provenance"],
    requireImageLensSource: true,
  },
];

async function main() {
  const requestedBaseUrl = trimTrailingSlash(readArg("--base-url", process.env.HELIX_ASK_BASE_URL ?? DEFAULT_BASE_URL));
  const outDir = readArg("--out", process.env.HELIX_ASK_SCHOLARLY_PDF_WORKBENCH_OUT ?? DEFAULT_OUT_DIR);
  const runId = `${Date.now()}-${hashShort(requestedBaseUrl)}`;
  const runDir = path.join(outDir, runId);
  await fs.mkdir(runDir, { recursive: true });

  if (DRY_RUN) {
    const result = {
      schema: "helix.ask.scholarly_pdf_workbench_probe.v1",
      status: "dry_run",
      base_url: requestedBaseUrl,
      fallback_base_urls: DEFAULT_BASE_URL_FALLBACKS,
      prompt_sequence: promptSequence,
      note: "Dry run only. Start the keyed/operator Helix Ask server separately, then run without --dry-run.",
    };
    await fs.writeFile(path.join(runDir, "probe-result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { baseUrl, attempts: desktopPreflightAttempts } = await resolveReachableBaseUrl(requestedBaseUrl);
  if (!desktopPreflightAttempts.some((attempt) => attempt.ok)) {
    const result = {
      schema: "helix.ask.scholarly_pdf_workbench_probe.v1",
      status: "not_run",
      reason: "local_server_unreachable",
      requested_base_url: requestedBaseUrl,
      base_url: baseUrl,
      desktop_preflight_attempts: desktopPreflightAttempts,
      hint: "Start the operator-owned keyed Helix Ask server before running this probe.",
    };
    await fs.writeFile(path.join(runDir, "probe-result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 2;
    return;
  }

  const sessionId = `helix-ask:scholarly-pdf-workbench:${runId}`;
  const steps = [];
  for (const [index, scenario] of promptSequence.entries()) {
    const ask = await fetchJson(`${baseUrl}/api/agi/ask/turn`, {
      method: "POST",
      body: JSON.stringify({
        turn_id: `${sessionId}:${scenario.id}`,
        sessionId,
        session_id: sessionId,
        thread_id: sessionId,
        agent_runtime: "codex",
        agentRuntime: "codex",
        debug: true,
        question: scenario.prompt,
        prompt: scenario.prompt,
      }),
    });
    await fs.writeFile(path.join(runDir, `${index + 1}-${scenario.id}-ask.json`), `${JSON.stringify(ask.json, null, 2)}\n`);
    const askPayload = readRecord(ask.json);
    const turnId = readString(askPayload?.turn_id) ?? readString(askPayload?.id);
    let debugPayload: RecordLike | null = null;
    let debugStatus: number | null = null;
    let debugOk = false;
    if (turnId) {
      const debug = await fetchJson(debugExportUrlFor(baseUrl, turnId));
      await fs.writeFile(path.join(runDir, `${index + 1}-${scenario.id}-debug.json`), `${JSON.stringify(debug.json, null, 2)}\n`);
      debugPayload = payloadFromDebugExport(debug.json);
      debugStatus = debug.status;
      debugOk = debug.ok;
    }
    const source = debugPayload ?? askPayload;
    const debugWorkbench = workbenchFrom(debugPayload);
    const fallbackWorkbench = workbenchFrom(askPayload);
    const workbench = debugWorkbench ?? fallbackWorkbench;
    const selectedAffordance = readString(workbench?.selected_affordance);
    const evidenceChain = readRecord(workbench?.evidence_chain);
    const terminalAuthority = readRecord(workbench?.terminal_authority);
    const pageInventory = readRecord(workbench?.page_inventory);
    const pageScout = readRecord(workbench?.page_scout);
    const imageLensSource = readRecord(readRecord(workbench?.pdf)?.image_lens_source);
    const imageLensSourceOk = Boolean(imageLensSource) || !scenario.requireImageLensSource;
    const affordanceActions = workbenchAffordanceActions(workbench);
    const advertisedExpectedAffordance = scenario.expectedAffordances.some((action) => affordanceActions.includes(action));
    const evidenceChainKeys = evidenceChain ? Object.keys(evidenceChain) : [];
    const evidenceChainShapeOk = REQUIRED_EVIDENCE_CHAIN_KEYS.every((key) => evidenceChainKeys.includes(key));
    const claimBoundaries = readRecord(workbench?.claim_boundaries);
    const terminalAuthorityReason = readString(terminalAuthority?.terminal_authority_reason);
    const selectedAffordanceOk = selectedAffordance ? scenario.expectedAffordances.includes(selectedAffordance) : false;
    const hasWorkbenchState = Boolean(workbench);
    const hasDebugWorkbenchState = Boolean(debugWorkbench);
    const hasPageInventory = Boolean(pageInventory);
    const hasPageScout = Boolean(pageScout);
    const pageScoutNonTerminal = !hasPageScout || pageScout?.terminal_eligible === false;
    const hasEvidenceChain = Boolean(evidenceChain);
    const hasTerminalAuthority = Boolean(terminalAuthority);
    const hasClaimBoundaries = Boolean(claimBoundaries);
    const terminalAuthorityReasonOk = terminalAuthorityReason !== "terminal_authority_missing";
    const failed_checks = failedChecksForStep({
      askOk: ask.ok,
      selectedAffordanceOk,
      advertisedExpectedAffordance,
      hasWorkbenchState,
      hasDebugWorkbenchState,
      hasPageInventory,
      hasPageScout,
      pageScoutNonTerminal,
      hasEvidenceChain,
      evidenceChainShapeOk,
      hasTerminalAuthority,
      hasClaimBoundaries,
      imageLensSourceOk,
      terminalAuthorityReasonOk,
    });
    steps.push({
      id: scenario.id,
      pass: failed_checks.length === 0,
      failed_checks,
      ok: ask.ok,
      status: ask.status,
      turn_id: turnId,
      debug_export_ok: debugOk,
      debug_export_status: debugStatus,
      selected_affordance: selectedAffordance,
      selected_affordance_ok: selectedAffordanceOk,
      affordance_actions: affordanceActions,
      advertised_expected_affordance: advertisedExpectedAffordance,
      has_workbench_state: hasWorkbenchState,
      has_debug_workbench_state: hasDebugWorkbenchState,
      has_page_inventory: hasPageInventory,
      has_page_scout: hasPageScout,
      page_scout_status: readString(pageScout?.scout_status),
      page_scout_terminal_eligible: pageScout?.terminal_eligible,
      page_scout_non_terminal: pageScoutNonTerminal,
      has_evidence_chain: hasEvidenceChain,
      evidence_chain_shape_ok: evidenceChainShapeOk,
      has_terminal_authority: hasTerminalAuthority,
      has_image_lens_source: Boolean(imageLensSource),
      image_lens_source_ok: imageLensSourceOk,
      has_claim_boundaries: hasClaimBoundaries,
      evidence_chain_keys: evidenceChainKeys,
      terminal_authority_reason: terminalAuthorityReason,
      terminal_authority_reason_ok: terminalAuthorityReasonOk,
      final_answer_source: readString(source?.final_answer_source),
      terminal_artifact_kind: readString(source?.terminal_artifact_kind),
      answer_preview: (readString(source?.selected_final_answer) ?? readString(source?.text) ?? "").slice(0, 800),
    });
  }

  const result = {
    schema: "helix.ask.scholarly_pdf_workbench_probe.v1",
    status: steps.every((step) => step.pass) ? "pass" : "fail",
    failed_steps: steps
      .filter((step) => !step.pass)
      .map((step) => ({ id: step.id, failed_checks: step.failed_checks })),
    base_url: baseUrl,
    requested_base_url: requestedBaseUrl,
    desktop_preflight_attempts: desktopPreflightAttempts,
    session_id: sessionId,
    steps,
    run_dir: runDir,
  };
  await fs.writeFile(path.join(runDir, "probe-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "pass" ? 0 : 1;
}

main().catch(async (error) => {
  const result = {
    schema: "helix.ask.scholarly_pdf_workbench_probe.v1",
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  };
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
});
