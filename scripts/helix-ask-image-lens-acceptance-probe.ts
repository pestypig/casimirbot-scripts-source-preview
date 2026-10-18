import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

type RecordLike = Record<string, unknown>;

const DEFAULT_BASE_URL = "http://127.0.0.1:5050";
const DEFAULT_PROMPT =
  "Here is a scientific document image. Extract the equations and compare them to the theory badge graph.";

const readArg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  if (index >= 0 && typeof process.argv[index + 1] === "string") return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
};

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

const readRecord = (value: unknown): RecordLike | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordLike : null;

const readArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const compactHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
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

function collectRecords(root: RecordLike | null, key: string): unknown[] {
  const debug = readRecord(root?.debug);
  return [
    ...readArray(root?.[key]),
    ...readArray(debug?.[key]),
  ];
}

function payloadFromDebugExport(value: unknown): RecordLike | null {
  const record = readRecord(value);
  if (!record) return null;
  const payload = readRecord(record.payload);
  return payload ?? record;
}

function terminalTextFrom(record: RecordLike | null): string {
  const terminalPresentation = readRecord(record?.terminal_presentation);
  const terminalAuthority = readRecord(record?.terminal_answer_authority);
  return (
    readString(record?.selected_final_answer) ??
    readString(record?.answer) ??
    readString(record?.content) ??
    readString(record?.final_answer) ??
    readString(terminalPresentation?.concise_text) ??
    readString(terminalAuthority?.terminal_text_preview) ??
    ""
  );
}

function evaluate(input: {
  askPayload: RecordLike | null;
  debugPayload: RecordLike | null;
  prompt: string;
  imageSha256: string;
}) {
  const source = input.debugPayload ?? input.askPayload;
  const sourceKeys = source ? new Set(Object.keys(source)) : new Set<string>();
  const answer = terminalTextFrom(input.askPayload);
  const debugAnswer = terminalTextFrom(input.debugPayload);
  const terminalPresentation = readRecord(source?.terminal_presentation);
  const terminalAuthority = readRecord(source?.terminal_answer_authority);
  const terminalPresentationText = readString(terminalPresentation?.concise_text) ?? "";
  const terminalAuthorityText = readString(terminalAuthority?.terminal_text_preview) ?? "";
  const capabilityLaneCallResults = collectRecords(source, "capability_lane_call_results");
  const capabilityLaneObservationPackets = collectRecords(source, "capability_lane_observation_packets");
  const runtimeLaneRequestLoop = readRecord(source?.runtime_lane_request_loop) ?? readRecord(readRecord(source?.debug)?.runtime_lane_request_loop);
  const providerPromptLeakGuard = readRecord(source?.provider_prompt_leak_guard) ?? readRecord(readRecord(source?.debug)?.provider_prompt_leak_guard);
  const presentationBlob = JSON.stringify({
    answer,
    debugAnswer,
    terminalPresentation,
    terminalAuthority,
  });
  const receiptBlob = JSON.stringify({
    capabilityLaneCallResults,
    capabilityLaneObservationPackets,
    runtimeLaneRequestLoop,
  });
  const sourceBlob = JSON.stringify(source ?? {});
  const finalAnswerSource = readString(source?.final_answer_source);
  const terminalArtifactKind = readString(source?.terminal_artifact_kind);
  const terminalErrorCode = readString(source?.terminal_error_code);
  const debugExportSource = readString(source?.debug_export_source);
  const backendDebugResponseStatus = readString(source?.backend_debug_response_status);
  const checks = {
    answer_mentions_bbox: /\bbox\b|Bbox:|bbox px/i.test(answer),
    answer_mentions_extraction_or_uncertainty:
      /text_candidate|latex_candidate|Extracted information|Extraction status|Uncertainty/i.test(answer),
    no_raw_base64_in_presentation: !/data:image\/[a-z0-9.+-]+;base64,|[A-Za-z0-9+/]{160,}={0,2}/i.test(presentationBlob),
    no_false_missing_observation_message: !/No visual observation receipt was produced/i.test(presentationBlob),
    debug_has_lane_call_results: capabilityLaneCallResults.length > 0,
    debug_has_observation_packets: capabilityLaneObservationPackets.length > 0,
    debug_has_runtime_lane_request_loop: Boolean(runtimeLaneRequestLoop),
    debug_has_scientific_evidence_packet: /"schema"\s*:\s*"helix\.scientific_evidence_packet\.v1"/.test(sourceBlob),
    debug_has_scientific_image_sidecar: /"schema"\s*:\s*"helix\.scientific_image_evidence_sidecar\.v1"/.test(sourceBlob),
    debug_has_sidecar_gateway_bridge: /"scientific_image_sidecar_gateway_bridge"\s*:/.test(sourceBlob),
    debug_has_compound_scientific_stages:
      /"stage"\s*:\s*"image_extraction"/.test(sourceBlob) &&
      /"stage"\s*:\s*"scientific_evidence_sidecar"/.test(sourceBlob) &&
      /"stage"\s*:\s*"theory_reflection"/.test(sourceBlob) &&
      /"stage"\s*:\s*"calculator_payload_filter"/.test(sourceBlob) &&
      /"stage"\s*:\s*"final_answer_guard"/.test(sourceBlob),
    theory_graph_does_not_use_prompt_context_source:
      !/"scientific_evidence_source"\s*:\s*"prompt_context"/.test(sourceBlob),
    sidecar_bridge_is_guarded:
      /"scientific_image_sidecar_gateway_bridge"\s*:/.test(sourceBlob) &&
      (
        /"scientific_image_sidecar_gateway_bridge"\s*:[\s\S]{0,1200}"status"\s*:\s*"completed"/.test(sourceBlob) ||
        /"scientific_image_sidecar_gateway_bridge"\s*:[\s\S]{0,1200}"blocked_reason"\s*:\s*"scientific_image_evidence_sidecar_(?:missing|not_admissible)"/.test(sourceBlob)
      ),
    debug_has_provider_prompt_leak_guard_field: sourceKeys.has("provider_prompt_leak_guard"),
    debug_has_terminal_authority: Boolean(terminalAuthority),
    debug_has_terminal_presentation: Boolean(terminalPresentation),
    debug_export_is_backend_backed:
      debugExportSource === "embedded_backend_payload" ||
      debugExportSource === "backend_ref_advertised" ||
      debugExportSource === null,
    backend_debug_response_is_materialized:
      backendDebugResponseStatus === "embedded_payload" ||
      backendDebugResponseStatus === "ref_advertised" ||
      backendDebugResponseStatus === null,
    terminal_not_typed_failure:
      finalAnswerSource !== "typed_failure" &&
      terminalArtifactKind !== "typed_failure" &&
      terminalErrorCode === null,
    terminal_presentation_matches_selected:
      !terminalPresentationText || !debugAnswer || terminalPresentationText === debugAnswer,
    terminal_authority_matches_selected:
      !terminalAuthorityText || !debugAnswer || debugAnswer.startsWith(terminalAuthorityText),
    receipts_remain_observation_only:
      Boolean(receiptBlob) &&
        !/"assistant_answer"\s*:\s*true/i.test(receiptBlob) &&
        !/"terminal_eligible"\s*:\s*true/i.test(receiptBlob),
    recovered_prompt_leak_not_typed_failure:
      readString(providerPromptLeakGuard?.status) === "recovered_with_image_lens_observation_report"
        ? finalAnswerSource !== "typed_failure" &&
          terminalArtifactKind !== "typed_failure"
        : true,
  };
  return {
    schema: "helix.ask.image_lens_acceptance_probe.v1",
    prompt: input.prompt,
    image_sha256: input.imageSha256,
    turn_id: readString(input.askPayload?.turn_id) ?? readString(input.askPayload?.id),
    status: Object.values(checks).every(Boolean) ? "pass" : "fail",
    checks,
    answer_preview: answer.slice(0, 1600),
    debug_answer_preview: debugAnswer.slice(0, 1600),
    debug_export_source: debugExportSource,
    backend_debug_response_status: backendDebugResponseStatus,
    final_answer_source: finalAnswerSource,
    terminal_artifact_kind: terminalArtifactKind,
    terminal_error_code: terminalErrorCode,
    provider_prompt_leak_guard: providerPromptLeakGuard,
    lane_call_result_count: capabilityLaneCallResults.length,
    observation_packet_count: capabilityLaneObservationPackets.length,
  };
}

async function main() {
  const baseUrl = trimTrailingSlash(readArg("--base-url", process.env.HELIX_ASK_BASE_URL ?? DEFAULT_BASE_URL));
  const imagePath = readArg("--image", process.env.HELIX_ASK_IMAGE_PATH ?? "").trim();
  if (!imagePath) {
    console.error("Provide --image <path> or HELIX_ASK_IMAGE_PATH.");
    process.exitCode = 2;
    return;
  }
  const prompt = readArg("--prompt", DEFAULT_PROMPT);
  const outputDir = readArg("--out", "artifacts/helix-ask/image-lens-acceptance-probe");
  const imageBytes = await fs.readFile(imagePath);
  const imageBase64 = imageBytes.toString("base64");
  const imageSha256 = createHash("sha256").update(imageBytes).digest("hex");
  const runId = `${Date.now()}-${compactHash(`${imageSha256}:${prompt}`)}`;
  const runDir = path.join(outputDir, runId);
  await fs.mkdir(runDir, { recursive: true });

  const desktopPreflight = await fetch(`${baseUrl}/desktop`).then(
    (response) => ({ ok: response.ok, status: response.status, error: null as string | null }),
    (error) => ({ ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }),
  );
  if (!desktopPreflight.ok) {
    const result = {
      schema: "helix.ask.image_lens_acceptance_probe.v1",
      status: "not_run",
      reason: "local_server_unreachable",
      base_url: baseUrl,
      desktop_preflight: desktopPreflight,
    };
    await fs.writeFile(path.join(runDir, "probe-result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 2;
    return;
  }

  const ask = await fetchJson(`${baseUrl}/api/agi/ask/turn`, {
    method: "POST",
    body: JSON.stringify({
      sessionId: `helix-ask:image-lens-acceptance:${runId}`,
      question: prompt,
      prompt,
      agent_runtime: "codex",
      agentRuntime: "codex",
      mode: "read",
      debug: true,
      turn_input_items: [
        { type: "text", text: prompt, source: "user" },
        {
          type: "image",
          image_base64: imageBase64,
          mime_type: "image/png",
          file_name: path.basename(imagePath),
          raw_image_included: true,
          raw_image_scope: "turn_input_only",
        },
      ],
    }),
  });
  await fs.writeFile(path.join(runDir, "ask-response.json"), `${JSON.stringify(ask.json, null, 2)}\n`);
  const askPayload = readRecord(ask.json);
  const turnId = readString(askPayload?.turn_id) ?? readString(askPayload?.id);
  let debugPayload: RecordLike | null = null;
  if (turnId) {
    const debug = await fetchJson(`${baseUrl}/api/agi/ask/turn/${encodeURIComponent(turnId)}/debug-export`);
    await fs.writeFile(path.join(runDir, "debug-export.json"), `${JSON.stringify(debug.json, null, 2)}\n`);
    debugPayload = payloadFromDebugExport(debug.json);
  }
  const result = evaluate({
    askPayload,
    debugPayload,
    prompt,
    imageSha256,
  });
  await fs.writeFile(path.join(runDir, "probe-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "pass" ? 0 : 1;
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
