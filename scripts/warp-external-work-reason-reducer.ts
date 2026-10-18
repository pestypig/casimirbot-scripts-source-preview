export const REASON_REDUCER_VERSION = '1.0.0';

export type ReducedReasonCategory =
  | 'artifact_missing'
  | 'value_missing'
  | 'non_comparable_or_unknown'
  | 'non_numeric_input'
  | 'delta_exceeds_tolerance'
  | 'equals_mismatch'
  | 'stale_commit_pin'
  | 'no_evaluable_keys'
  | 'other';

export type ReducedReason = {
  raw_code: string;
  category: ReducedReasonCategory;
  key_id: string | null;
};

const splitReasonCode = (rawCode: string): { code: string; keyId: string | null } => {
  const trimmed = String(rawCode ?? '').trim();
  const separator = trimmed.indexOf(':');
  if (separator < 0) {
    return {
      code: trimmed.toLowerCase(),
      keyId: null,
    };
  }

  return {
    code: trimmed.slice(0, separator).toLowerCase(),
    keyId: trimmed.slice(separator + 1).trim() || null,
  };
};

const categorizeReasonCode = (code: string): ReducedReasonCategory => {
  if (code === 'run_artifact_missing' || code === 'compare_artifact_missing') return 'artifact_missing';
  if (code === 'missing_local_value' || code === 'missing_external_value') return 'value_missing';
  if (code === 'non_comparable_or_unknown') return 'non_comparable_or_unknown';
  if (code === 'non_numeric_delta') return 'non_numeric_input';
  if (code === 'delta_exceeds_tolerance') return 'delta_exceeds_tolerance';
  if (code === 'equals_mismatch') return 'equals_mismatch';
  if (code === 'stale_run_commit_pin') return 'stale_commit_pin';
  if (code === 'no_evaluable_keys') return 'no_evaluable_keys';
  return 'other';
};

const reasonSort = (left: ReducedReason, right: ReducedReason): number => {
  if (left.category !== right.category) return left.category.localeCompare(right.category);
  if ((left.key_id ?? '') !== (right.key_id ?? '')) return (left.key_id ?? '').localeCompare(right.key_id ?? '');
  return left.raw_code.localeCompare(right.raw_code);
};

export const reduceReasonCodes = (reasonCodes: string[]) => {
  const uniqueRawCodes = [...new Set(reasonCodes.map((code) => String(code ?? '').trim()).filter(Boolean))];
  const reduced = uniqueRawCodes
    .map((rawCode) => {
      const split = splitReasonCode(rawCode);
      return {
        raw_code: rawCode,
        category: categorizeReasonCode(split.code),
        key_id: split.keyId,
      } satisfies ReducedReason;
    })
    .sort(reasonSort);

  const reducedReasonCounts: Record<string, number> = {};
  for (const entry of reduced) {
    reducedReasonCounts[entry.category] = (reducedReasonCounts[entry.category] ?? 0) + 1;
  }

  const reducedReasonCodes = [...new Set(reduced.map((entry) => entry.category))];
  return {
    reason_reducer_version: REASON_REDUCER_VERSION,
    reduced_reason_codes: reducedReasonCodes,
    reduced_reason_counts: reducedReasonCounts,
    reduced_reasons: reduced,
  };
};
