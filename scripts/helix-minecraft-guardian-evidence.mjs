const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;

const array = (value) => (Array.isArray(value) ? value : []);

const GUARDIAN_CAPABILITY =
  "com.casimirbot.minecraft.player.guardian.execute";

const exactBlockPosition = (value) => {
  const position = record(value);
  return Boolean(
    position &&
      Number.isInteger(position.x) &&
      Number.isInteger(position.y) &&
      Number.isInteger(position.z),
  );
};

/**
 * Accept either an explicit collision-condition observation or the stronger
 * action-time trajectory proof emitted by a verified predicted-collision
 * placement. The latter is not an inferred strategy: it is connector evidence
 * that the live binding was applicable, reachable, below the actor, and used
 * by the successful placement action.
 */
export const classifyGuardianCollisionPredictionEvidence = (measurements) => {
  const source = record(measurements);
  const conditionObserved = array(source?.condition_observations)
    .map(record)
    .filter(Boolean)
    .some(
      (observation) =>
        observation.condition_kind === "predicted_collision_within" &&
        observation.satisfied === true,
    );
  const verifiedPrediction =
    array(source?.placement_predictions)
      .map(record)
      .filter(Boolean)
      .find(
        (prediction) =>
          prediction.position_binding_kind === "predicted_collision_cell" &&
          prediction.applicable === true &&
          prediction.predicted_reachable === true &&
          Number(prediction.first_collision_tick) >= 1 &&
          Number(prediction.support_candidate_count) >= 1 &&
          exactBlockPosition(prediction.target_position),
      ) ?? null;
  const bindingVerified = Boolean(
    verifiedPrediction &&
      Number(source?.placement_prediction_count) >= 1 &&
      Number(source?.placement_action_success_count) >= 1 &&
      Number(source?.placement_mutation_success_count) >= 1,
  );

  return {
    observed: conditionObserved || bindingVerified,
    condition_observed: conditionObserved,
    binding_verified: bindingVerified,
    verified_prediction: verifiedPrediction,
  };
};

/**
 * Count read-only Minecraft observations taken while the only fresh failure is
 * a pre-execution guardian contract rejection. Such observations cannot repair
 * graph topology or resource declarations, so this is a latency diagnostic,
 * not an answer or execution verdict.
 */
export const countGuardianValidatorOnlyDiagnosticDetours = (observations) => {
  let validatorRepairPending = false;
  let count = 0;
  for (const value of array(observations)) {
    const observation = record(value);
    if (!observation) continue;
    if (observation.capability_id === GUARDIAN_CAPABILITY) {
      validatorRepairPending =
        observation.outcome === "precondition_failed" &&
        String(observation.summary || "").includes(
          "failed its trusted contract:",
        );
      continue;
    }
    if (
      validatorRepairPending &&
      String(observation.capability_id || "").startsWith(
        "com.casimirbot.minecraft.",
      ) &&
      observation.outcome === "succeeded"
    ) {
      count += 1;
    }
  }
  return count;
};
