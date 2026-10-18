const CAPABILITY_PREFIXES = [
  "com.casimirbot.minecraft.",
  "com.casimirbot.environment.durable_goal.",
];

const isHarnessCapability = (capabilityId) =>
  CAPABILITY_PREFIXES.some((prefix) => capabilityId?.startsWith(prefix));

const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;
const array = (value) => (Array.isArray(value) ? value : []);
const string = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const capabilityForObservation = (candidate) => {
  const declared =
    string(candidate.capability_id) ||
    string(candidate.executed_capability) ||
    string(candidate.capability_key);
  if (isHarnessCapability(declared)) return declared;
  if (candidate.schema === "helix.environment_command.observation.v1") {
    return "com.casimirbot.minecraft.command";
  }
  return null;
};

const isMinecraftObservation = (candidate) =>
  candidate.schema === "helix.environment_connector.probe_observation.v1" ||
  candidate.schema === "helix.environment_command.observation.v1" ||
  candidate.schema === "helix.environment_action.observation.v1" ||
  candidate.schema === "helix.environment_durable_goal_observation.v1";

export const collectMinecraftCapabilityObservations = (ledger) => {
  const observations = [];
  const seen = new Set();
  const queue = array(ledger).map((value) => ({ value, depth: 0 }));
  let visited = 0;
  while (queue.length && visited < 10_000) {
    const { value, depth } = queue.shift();
    visited += 1;
    if (Array.isArray(value)) {
      if (depth < 10) {
        for (const child of value) queue.push({ value: child, depth: depth + 1 });
      }
      continue;
    }
    const candidate = record(value);
    if (!candidate) continue;
    const capabilityId = capabilityForObservation(candidate);
    if (isMinecraftObservation(candidate) && capabilityId) {
      const evidenceRef = string(candidate.evidence_ref);
      const key = `${capabilityId}:${
        evidenceRef ||
        string(candidate.probe_request_ref) ||
        string(candidate.command_request_ref) ||
        string(candidate.action_request_ref) ||
        observations.length
      }`;
      if (!seen.has(key)) {
        seen.add(key);
        observations.push({
          capability_id: capabilityId,
          outcome: string(candidate.outcome),
          summary: string(candidate.summary),
          evidence_ref: evidenceRef,
          eligible_for_current_turn_reentry:
            candidate.eligible_for_current_turn_reentry === true,
        });
      }
    }
    if (
      candidate.schema === "helix.capability_result.v1" &&
      isHarnessCapability(capabilityId)
    ) {
      const evidenceRef = array(candidate.evidence_refs)
        .map(string)
        .find(Boolean);
      const key = `${capabilityId}:${
        evidenceRef || string(candidate.capability_plan_id) || observations.length
      }`;
      if (!seen.has(key)) {
        seen.add(key);
        observations.push({
          capability_id: capabilityId,
          outcome: string(candidate.status),
          summary: string(candidate.summary),
          evidence_ref: evidenceRef,
          eligible_for_current_turn_reentry: candidate.reentered_solver === true,
        });
      }
    }
    if (depth < 10) {
      for (const child of Object.values(candidate)) {
        queue.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return observations;
};
