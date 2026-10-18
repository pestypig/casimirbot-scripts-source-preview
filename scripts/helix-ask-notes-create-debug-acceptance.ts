import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type AcceptanceResult = {
  ok: boolean;
  diagnosis: string;
  found: string[];
  missing: string[];
  mismatched: string[];
};

const readRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const readRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(readRecord(entry)))
    : [];

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const findJsonObjectEnd = (text: string, startIndex: number): number => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") continue;
    depth -= 1;
    if (depth === 0) return index + 1;
  }
  return -1;
};

export const parseHelixAskDebugExportText = (rawText: string): unknown => {
  const text = rawText.replace(/^\uFEFF/, "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidateText = fenced?.[1]?.trim() ?? text;
  try {
    return JSON.parse(candidateText);
  } catch {
    const start = candidateText.indexOf("{");
    if (start < 0) throw new Error("debug export JSON object not found");
    const end = findJsonObjectEnd(candidateText, start);
    if (end < 0) throw new Error("debug export JSON object is incomplete");
    return JSON.parse(candidateText.slice(start, end));
  }
};

const hasWorkstationNoteCreateAction = (payload: Record<string, unknown>): boolean => {
  const envelope = readRecord(payload.action_envelope);
  if (readString(envelope?.schema) !== "helix.ask.action_envelope.v1") return false;
  return readRecords(envelope?.workstation_actions).some((action) =>
    readString(action.panel_id) === "workstation-notes" &&
    readString(action.action_id) === "create_note"
  );
};

const hasGatewayCall = (payload: Record<string, unknown>): boolean =>
  readRecords(payload.workstation_gateway_call_results).some((entry) =>
    readString(entry.capability_id) === "workstation-notes.create_note"
  );

const hasAgentStepChoice = (payload: Record<string, unknown>): boolean =>
  readRecords(readRecord(payload.agent_step_loop)?.iterations).some((iteration) =>
    readString(readRecord(iteration.decision)?.chosen_capability) === "workstation-notes.create_note" ||
    readString(iteration.chosen_capability) === "workstation-notes.create_note"
  );

const hasSolverTrace = (payload: Record<string, unknown>): boolean => {
  const trace = readRecord(payload.ask_turn_solver_trace);
  return readString(trace?.schema) === "helix.ask_turn_solver_trace.v1";
};

const hasSameTurnSolverTrace = (payload: Record<string, unknown>): boolean => {
  const turnId = readActiveTurnId(payload);
  const trace = readRecord(payload.ask_turn_solver_trace);
  if (!turnId || !trace) return false;
  return readString(trace.turn_id) === turnId;
};

const hasCompletedSolverPath = (payload: Record<string, unknown>): boolean =>
  readRecord(payload.ask_turn_solver_trace)?.completed_solver_path === true;

const hasSolverReceiptTerminal = (payload: Record<string, unknown>): boolean => {
  const arbitration = readRecord(readRecord(payload.ask_turn_solver_trace)?.final_arbitration);
  return readString(arbitration?.terminal_artifact_kind) === "note_update_receipt";
};

const hasClientPersistAck = (payload: Record<string, unknown>): boolean =>
  readRecords(payload.workspace_action_client_ack).some((ack) =>
    readString(ack.action_key) === "workstation-notes.create_note" &&
    readString(ack.receipt_kind) === "note_update_receipt" &&
    ack.persisted === true &&
    ack.state_observed === true
  );

const readActiveTurnId = (payload: Record<string, unknown>): string | null =>
  readString(payload.active_turn_id) ??
  readString(payload.backend_turn_id) ??
  readString(readRecord(payload.debug)?.turn_id);

const hasSameTurnClientPersistAck = (payload: Record<string, unknown>): boolean => {
  const turnId = readActiveTurnId(payload);
  if (!turnId) return false;
  return readRecords(payload.workspace_action_client_ack).some((ack) =>
    readString(ack.turn_id) === turnId &&
    readString(ack.action_key) === "workstation-notes.create_note" &&
    readString(ack.receipt_kind) === "note_update_receipt" &&
    ack.persisted === true &&
    ack.state_observed === true
  );
};

const hasClientReceiptTerminal = (payload: Record<string, unknown>): boolean => {
  const terminal = readRecord(payload.client_receipt_terminal);
  return readString(terminal?.receipt_kind) === "note_update_receipt";
};

const hasSameTurnClientReceiptTerminal = (payload: Record<string, unknown>): boolean => {
  const turnId = readActiveTurnId(payload);
  const terminal = readRecord(payload.client_receipt_terminal);
  if (!turnId || !terminal) return false;
  return (
    readString(terminal.turn_id) === turnId &&
    readString(terminal.receipt_kind) === "note_update_receipt"
  );
};

const hasReceiptBackedFinalAnswer = (payload: Record<string, unknown>): boolean => {
  const terminal = readRecord(payload.client_receipt_terminal);
  const terminalText = readString(terminal?.text);
  return Boolean(terminalText && readString(payload.selected_final_answer) === terminalText);
};

const parseCliArgs = (argv: string[]): { inputPath: string | null; json: boolean } => {
  let inputPath: string | null = null;
  let json = false;
  argv.forEach((arg) => {
    if (arg === "--json") {
      json = true;
      return;
    }
    if (!inputPath) inputPath = arg;
  });
  return { inputPath: inputPath ?? process.env.HELIX_ASK_NOTES_CREATE_DEBUG_EXPORT ?? null, json };
};

const looksLikeDebugExportFile = (filePath: string): boolean => {
  const name = path.basename(filePath).toLowerCase();
  return (
    name === "pasted-text.txt" ||
    name.includes("debug-export") ||
    name.includes("helix-ask") ||
    name.endsWith(".json")
  );
};

const findCandidateDebugExportFiles = (dirPath: string): string[] => {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries
    .flatMap((entry) => {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) return findCandidateDebugExportFiles(entryPath);
      if (!entry.isFile() || !looksLikeDebugExportFile(entryPath)) return [];
      return [entryPath];
    })
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
};

const resolveDebugExportInputPath = (inputPath: string): string => {
  const absolutePath = path.resolve(inputPath);
  const stat = fs.statSync(absolutePath);
  if (!stat.isDirectory()) return absolutePath;
  const candidates = findCandidateDebugExportFiles(absolutePath);
  if (candidates.length === 0) {
    throw new Error(`No debug export candidate files found under ${absolutePath}`);
  }
  return candidates[0];
};

export const validateHelixAskNotesCreateDebugAcceptance = (value: unknown): AcceptanceResult => {
  const payload = readRecord(value);
  if (!payload) {
    return {
      ok: false,
      diagnosis: "debug_export_not_parseable",
      found: [],
      missing: ["debug_export_json_object"],
      mismatched: [],
    };
  }

  const checks: Array<[string, boolean]> = [
    ["active_turn_id", Boolean(readActiveTurnId(payload))],
    ["ask_turn_solver_trace.schema=helix.ask_turn_solver_trace.v1", hasSolverTrace(payload)],
    ["ask_turn_solver_trace.turn_id matches active_turn_id", hasSameTurnSolverTrace(payload)],
    ["ask_turn_solver_trace.completed_solver_path=true", hasCompletedSolverPath(payload)],
    ["ask_turn_solver_trace.final_arbitration.terminal_artifact_kind=note_update_receipt", hasSolverReceiptTerminal(payload)],
    ["action_envelope.schema=helix.ask.action_envelope.v1", readString(readRecord(payload.action_envelope)?.schema) === "helix.ask.action_envelope.v1"],
    ["action_envelope.workstation_actions[].panel_id=workstation-notes/action_id=create_note", hasWorkstationNoteCreateAction(payload)],
    ["workstation_gateway_call_results[].capability_id=workstation-notes.create_note", hasGatewayCall(payload)],
    ["agent_step_loop.iterations[].chosen_capability=workstation-notes.create_note", hasAgentStepChoice(payload)],
    ["workspace_action_client_ack[].action_key=workstation-notes.create_note/receipt_kind=note_update_receipt/persisted=true/state_observed=true", hasClientPersistAck(payload)],
    ["workspace_action_client_ack[].turn_id matches active_turn_id", hasSameTurnClientPersistAck(payload)],
    ["client_receipt_terminal.receipt_kind=note_update_receipt", hasClientReceiptTerminal(payload)],
    ["client_receipt_terminal.turn_id matches active_turn_id", hasSameTurnClientReceiptTerminal(payload)],
    ["selected_final_answer equals client_receipt_terminal.text", hasReceiptBackedFinalAnswer(payload)],
    ["final_answer_source=client_workstation_receipt", readString(payload.final_answer_source) === "client_workstation_receipt"],
    ["terminal_artifact_kind=note_update_receipt", readString(payload.terminal_artifact_kind) === "note_update_receipt"],
  ];
  const found = checks.filter(([, ok]) => ok).map(([label]) => label);
  const missing = checks.filter(([, ok]) => !ok).map(([label]) => label);
  const diagnosis = missing.length === 0
    ? "accepted"
    : !hasWorkstationNoteCreateAction(payload) && !hasGatewayCall(payload)
      ? "missing_server_action_admission"
      : !hasSolverTrace(payload) || !hasSameTurnSolverTrace(payload) || !hasCompletedSolverPath(payload)
        ? "missing_solver_trace"
      : !hasClientPersistAck(payload) || !hasSameTurnClientPersistAck(payload)
        ? "missing_client_persistence_receipt"
        : !hasClientReceiptTerminal(payload) ||
            !hasSameTurnClientReceiptTerminal(payload) ||
            !hasReceiptBackedFinalAnswer(payload) ||
            readString(payload.final_answer_source) !== "client_workstation_receipt" ||
            readString(payload.terminal_artifact_kind) !== "note_update_receipt"
          ? "missing_receipt_backed_terminal_authority"
          : "incomplete_notes_create_lifecycle";
  return { ok: missing.length === 0, diagnosis, found, missing, mismatched: [] };
};

const runCli = (): void => {
  const { inputPath, json } = parseCliArgs(process.argv.slice(2));
  if (!inputPath) {
    console.error("Usage: tsx scripts/helix-ask-notes-create-debug-acceptance.ts [--json] <debug-export.json>");
    process.exit(2);
  }
  const absolutePath = resolveDebugExportInputPath(inputPath);
  const parsed = parseHelixAskDebugExportText(fs.readFileSync(absolutePath, "utf8"));
  const result = validateHelixAskNotesCreateDebugAcceptance(parsed);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }
  if (result.ok) {
    console.log("PASS helix_ask_notes_create_debug_acceptance");
    console.log(`diagnosis: ${result.diagnosis}`);
    return;
  }
  console.error("FAIL helix_ask_notes_create_debug_acceptance");
  console.error(`diagnosis: ${result.diagnosis}`);
  result.found.forEach((entry) => console.error(`found: ${entry}`));
  result.missing.forEach((entry) => console.error(`missing: ${entry}`));
  process.exit(1);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli();
}
