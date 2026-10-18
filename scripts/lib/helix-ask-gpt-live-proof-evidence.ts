import crypto from "node:crypto";

type RecordLike = Record<string, unknown>;

export type HelixGptLiveProofNetworkReceipt = {
  status: number;
  detail_code?: string | null;
};

const asRecord = (value: unknown): RecordLike | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordLike
    : null;

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const solverTraceFromAnswerDebug = (answerDebug: unknown): RecordLike | null => {
  const debug = asRecord(answerDebug);
  const direct = asRecord(debug?.ask_turn_solver_trace);
  const nested = asRecord(asRecord(debug?.debug)?.ask_turn_solver_trace);
  return direct ?? nested;
};

export const answerDebugMatchesAskTurn = (
  answerDebug: unknown,
  askTurnId: string | null,
): boolean => {
  const debug = asRecord(answerDebug);
  if (!debug || !askTurnId) return false;
  const solverTrace = solverTraceFromAnswerDebug(debug);
  return (
    readString(debug.active_turn_id) === askTurnId &&
    readString(debug.backend_turn_id) === askTurnId &&
    readString(solverTrace?.turn_id) === askTurnId &&
    solverTrace?.completed_solver_path === true
  );
};

export const visibleTerminalMatchesGroundedArtifact = (input: {
  answer: string | null;
  answerDebug: unknown;
  groundedAnswer: unknown;
}): boolean => {
  const debug = asRecord(input.answerDebug);
  const grounded = asRecord(input.groundedAnswer);
  const answer = readString(input.answer);
  if (!debug || !grounded || !answer) return false;
  const answerHash = `sha256:${crypto.createHash("sha256").update(answer).digest("hex")}`;
  return (
    readString(debug.selected_final_answer) === answer &&
    readString(grounded.answer_text_hash) === answerHash &&
    grounded.answer_text_char_count === answer.length
  );
};

export const hasRealtimeAuthenticationFailure = (
  receipts: readonly HelixGptLiveProofNetworkReceipt[],
): boolean =>
  receipts.some((receipt) =>
    receipt.status === 401 ||
    receipt.detail_code === "openai_realtime_authentication_failed");
