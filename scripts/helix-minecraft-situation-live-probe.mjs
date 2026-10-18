#!/usr/bin/env node

import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { startSharedRoomPresenceHeartbeat } from
  "./helix-shared-room-presence-heartbeat.mjs";
import { collectMinecraftCapabilityObservations } from
  "./helix-minecraft-live-probe-observations.mjs";
import {
  classifyGuardianCollisionPredictionEvidence,
  countGuardianValidatorOnlyDiagnosticDetours,
} from
  "./helix-minecraft-guardian-evidence.mjs";

const CAPABILITY_PREFIXES = [
  "com.casimirbot.minecraft.",
  "com.casimirbot.environment.durable_goal.",
];
const DEFAULT_TIMEOUT_MS = 300_000;

const scenarios = {
  command_time_query: {
    prompt:
      "What is the current daytime value in our Minecraft world? Please read it directly from the live Fabric server before you answer.",
    expected: ["com.casimirbot.minecraft.command"],
  },
  command_time_set_day: {
    prompt:
      "Set the connected Minecraft world to daytime now, then verify the new daytime value from fresh server evidence.",
    expected: ["com.casimirbot.minecraft.command"],
    mode: "write",
  },
  command_admin_whitelist_query: {
    prompt:
      "Using the live Fabric server command dispatcher, list the players currently on the server whitelist and tell me the result.",
    expected: ["com.casimirbot.minecraft.command"],
    mode: "write",
  },
  command_quoted_no_execute: {
    prompt:
      "Explain what the Minecraft command `time set night` would do, but do not execute it or change the world.",
    expected: [],
    forbiddenCapabilities: ["com.casimirbot.minecraft.command"],
  },
  actor_status_short: {
    prompt: "What is my Minecraft status right now?",
    expected: ["com.casimirbot.minecraft.actor.status.read"],
  },
  nether_preflight_goal_create: {
    prompt:
      "Create a durable Minecraft custom-survival goal for preparing the exact bound player and world for a later full Nether journey. Its only milestone for now is a preflight binding check requiring fresh actor status evidence. Do not begin gameplay progression, move, interact, change inventory, mutate blocks, craft, mine, use a Minecraft command, complete the milestone, or mark the goal complete. Leave the new goal active and report its exact goal identity from current-turn evidence.",
    expected: ["com.casimirbot.environment.durable_goal.create"],
    forbiddenCapabilities: [
      "com.casimirbot.minecraft.command",
      "com.casimirbot.minecraft.player.navigate",
      "com.casimirbot.minecraft.player.walk",
      "com.casimirbot.minecraft.player.interact",
      "com.casimirbot.minecraft.player.mine",
      "com.casimirbot.minecraft.player.place",
      "com.casimirbot.minecraft.player.craft",
    ],
  },
  nether_preflight_goal_checkpoint: {
    prompt:
      "Inspect environment_durable_goal:4ecee784-d431-4b76-853f-af5bbf046940 in the current Minecraft room, read fresh current actor status, and append one verified preflight checkpoint satisfying fresh_actor_status_bound. Leave the goal active and report the goal and checkpoint identities from current-turn evidence.",
    expected: [
      "com.casimirbot.environment.durable_goal.inspect",
      "com.casimirbot.minecraft.actor.status.read",
      "com.casimirbot.environment.durable_goal.append",
    ],
    forbiddenCapabilities: [
      "com.casimirbot.minecraft.command",
      "com.casimirbot.minecraft.player.navigate",
      "com.casimirbot.minecraft.player.walk",
      "com.casimirbot.minecraft.player.interact",
      "com.casimirbot.minecraft.player.mine",
      "com.casimirbot.minecraft.player.place",
      "com.casimirbot.minecraft.player.craft",
    ],
  },
  nether_preflight_goal_verify: {
    prompt:
      "Inspect environment_durable_goal:4ecee784-d431-4b76-853f-af5bbf046940 and report its current revision, status, latest checkpoint identity, and exact checkpoint evidence refs from the canonical ledger.",
    expected: ["com.casimirbot.environment.durable_goal.inspect"],
    forbiddenCapabilities: [
      "com.casimirbot.minecraft.command",
      "com.casimirbot.minecraft.player.navigate",
      "com.casimirbot.minecraft.player.walk",
      "com.casimirbot.minecraft.player.interact",
      "com.casimirbot.minecraft.player.mine",
      "com.casimirbot.minecraft.player.place",
      "com.casimirbot.minecraft.player.craft",
      "com.casimirbot.environment.durable_goal.append",
    ],
  },
  nether_preflight_checkpoint: {
    prompt:
      "Prepare the exact Minecraft room for a later full Nether journey, but do not begin that journey or perform any gameplay action. Read my current actor status, create a custom-survival durable goal whose only milestone is a preflight binding check, and append one verified checkpoint from the fresh status evidence. The checkpoint must state that no movement, interaction, inventory change, block mutation, crafting, mining, or Nether progress occurred. Leave the goal active and report its goal and checkpoint identities from current-turn evidence.",
    expected: [
      "com.casimirbot.minecraft.actor.status.read",
      "com.casimirbot.environment.durable_goal.create",
      "com.casimirbot.environment.durable_goal.append",
    ],
    forbiddenCapabilities: [
      "com.casimirbot.minecraft.player.navigate",
      "com.casimirbot.minecraft.player.walk",
      "com.casimirbot.minecraft.player.interact",
      "com.casimirbot.minecraft.player.mine",
      "com.casimirbot.minecraft.player.place",
      "com.casimirbot.minecraft.player.craft",
      "com.casimirbot.minecraft.command",
    ],
  },
  inventory_status: {
    prompt:
      "In this Minecraft room, check my current health, hunger or effects, armor, and inventory now. Am I equipped to explore for a few minutes?",
    expected: [
      "com.casimirbot.minecraft.actor.status.read",
      "com.casimirbot.minecraft.inventory.check",
    ],
  },
  registry_fact: {
    prompt:
      "On the live Fabric server in this room, check the running Minecraft registry and tell me whether the exact block ID minecraft:netherrack exists. Use current environment evidence rather than general knowledge.",
    expected: ["com.casimirbot.minecraft.registry.fact.read"],
  },
  recipe_fact: {
    prompt:
      "On the live Fabric server in this room, query the current recipe manager for recipes that produce minecraft:stone_bricks. Tell me what the bounded live result establishes and whether its result resolution is complete.",
    expected: ["com.casimirbot.minecraft.recipe.fact.read"],
  },
  guardian_parallel_step: {
    prompt:
      "In the paired Minecraft Player Embodiment client, take one very short step forward while turning my camera fifteen degrees to the right at the same time. Use the bounded concurrent reactive capability so both lanes run together, stop immediately if my health drops below six, perform no world mutation, release all controls when done, and report the measured execution evidence.",
    expected: ["com.casimirbot.minecraft.player.guardian.execute"],
    mode: "write",
  },
  guardian_bat_fixture_spawn: {
    prompt:
      "For a temporary Helix guardian tracking test in the connected Minecraft sandbox, use the governed live Fabric command capability to summon exactly one stationary bat tagged helix_guardian_v04_fixture about four blocks in front of and one block above my selected player. Do not affect any existing entity or block, and report the fresh command evidence.",
    expected: ["com.casimirbot.minecraft.command"],
    mode: "write",
  },
  guardian_bat_track_30s: {
    prompt:
      "Using the paired Minecraft Player Embodiment client, predictively track the nearest minecraft:bat continuously for thirty seconds. Keep its rendered center smoothly centered with bounded camera speed and acceleration, stop if my health drops below six or I take manual control, perform no world or inventory mutation, release controls afterward, and report duration, sample count, retained and lost ticks, mean and p95 angular error, reacquisitions, and control release from fresh execution evidence.",
    expected: ["com.casimirbot.minecraft.player.camera.track"],
    mode: "write",
  },
  guardian_bat_fixture_cleanup: {
    prompt:
      "Clean up only the temporary Minecraft test bat tagged helix_guardian_v04_fixture using the governed live Fabric command capability. Do not affect any other entity or block, verify the command result, and report the fresh evidence.",
    expected: ["com.casimirbot.minecraft.command"],
    mode: "write",
  },
  guardian_enchant_particle_track_10s: {
    prompt:
      "Using the paired Minecraft Player Embodiment client, keep the nearest live minecraft:enchant particle stream centered for ten seconds. Track only that exact particle type, use bounded same-type handoffs when one glyph expires, tolerate a short reacquisition gap, stop if my health drops below six or I take manual control, make no world or inventory mutation, release controls afterward, and report samples, retained and lost ticks, handoffs, reacquisitions, angular error, and control release from fresh execution evidence.",
    expected: ["com.casimirbot.minecraft.player.camera.track"],
    mode: "write",
  },
  guardian_particle_fixture_cleanup: {
    prompt:
      "Clean up only the temporary Minecraft particle fixture tagged helix_guardian_v04_particle_fixture using the governed live Fabric command capability. Do not affect any other entity or block, verify the command result, and report the fresh evidence.",
    expected: ["com.casimirbot.minecraft.command"],
    mode: "write",
  },
  guardian_track_move_feed: {
    prompt:
      "Using the paired Minecraft Player Embodiment client, keep the nearest minecraft:cow centered for five seconds while taking one very short careful step toward it and feeding it exactly three times with the wheat already in my offhand. Run camera, locomotion, and hand work concurrently under one bounded reactive guardian program; stop immediately if my health drops below six or I take manual control, perform no block or command mutation, release every control afterward, and report concurrent lanes, parallel ticks, successful action count, interaction and motion evidence, resource conflicts, mutations, interrupts, and control release from fresh execution evidence.",
    expected: ["com.casimirbot.minecraft.player.guardian.execute"],
    mode: "write",
    verifyGuardianTrackMoveFeed: true,
  },
  guardian_water_bucket_rescue: {
    prompt:
      "Step off this Minecraft test platform and save me from fall damage by reacting to my measured trajectory and placing exactly one water source with the water bucket I am carrying. Use one bounded survival_tas guardian program, do not use commands or teleportation, stop immediately if my health drops below eight or I take manual control, release every control afterward, and report the condition, placement, mutation, inventory, and health evidence from this execution.",
    expected: ["com.casimirbot.minecraft.player.guardian.execute"],
    mode: "write",
    verifyGuardianWaterBucketRescue: true,
  },
  guardian_unavailable_inventory_replan: {
    prompt:
      "Using the paired Minecraft Player Embodiment client, prepare a bounded water-bucket fall-rescue drill from my current safe position. First require the water bucket I am carrying to be successfully selected; do not move unless that succeeds. If execution reveals that the assumed rescue item is unavailable, use the fresh typed observation to revise or cancel safely rather than inventing success. Do not use commands or teleportation, make no world mutation, release every control, and report the failure, repair decision, and final state from current-turn evidence.",
    // Reasoning freedom is part of this acceptance case. Codex may preflight
    // inventory and cancel before acquiring controls, or it may receive a
    // typed guardian precondition failure. The verifier accepts either exact
    // current-turn observation and does not mandate a narrower procedure.
    expected: [],
    mode: "write",
    verifyGuardianUnavailableInventoryReplan: true,
  },
  guardian_mid_execution_health_interrupt: {
    prompt:
      "Using the paired Minecraft Player Embodiment client, smoothly track the nearest minecraft:bat with my camera for ten seconds under one bounded reactive guardian program. Continuously require my health to remain at least 19 and immediately cancel the active camera lane if it falls below that threshold. Do not move the player, use commands or teleportation, make any world or inventory mutation, or interact with the bat. Release every control afterward and report the health-condition timeline, interrupt, canceled camera work, and final control state from fresh execution evidence.",
    // The externally introduced damage is a fixture perturbation, not a
    // prescribed solution. Codex owns the exact bounded program; acceptance
    // checks only that a previously-satisfied guard changes during execution,
    // cancels active work, and re-enters final synthesis as fresh evidence.
    expected: [],
    mode: "write",
    verifyGuardianMidExecutionHealthInterrupt: true,
  },
  guardian_feed_fixture_cleanup: {
    prompt:
      "Clean up only the temporary Minecraft feeding fixture tagged helix_guardian_v04_feed_fixture using the governed live Fabric command capability, and clear only the temporary wheat remaining in my offhand without touching matching wheat elsewhere in my inventory. Do not affect any other entity, item stack, or block; verify both command results and report fresh evidence.",
    expected: ["com.casimirbot.minecraft.command"],
    mode: "write",
  },
  threats: {
    prompt:
      "In this Minecraft room, check the nearby entities and immediate hazards now. What is dangerous near me, and what should I do first?",
    expected: [
      "com.casimirbot.minecraft.nearby_entities.list",
      "com.casimirbot.minecraft.hazards.scan",
    ],
  },
  crops_and_map: {
    prompt:
      "In this Minecraft room, inspect the wheat at x=100 y=80 z=103 and inspect the local floor around me now. Is that crop mature, and what does the bounded local terrain sample establish?",
    expected: [
      "com.casimirbot.minecraft.crop_state.read",
      "com.casimirbot.minecraft.local_map.inspect",
    ],
  },
  geometry: {
    prompt:
      "In this Minecraft room, check both line of sight and straight-line geometric reachability to x=100 y=80 z=105 now. Do not claim that this proves a navigable path.",
    expected: [
      "com.casimirbot.minecraft.line_of_sight.check",
      "com.casimirbot.minecraft.reachability.check",
    ],
  },
  followup: {
    prompt:
      "Given the current Minecraft observations you just gathered, what should I fix first before moving? Be explicit about what the evidence does and does not prove.",
    expected: [],
  },
  corrective: {
    prompt:
      "Actually, recheck just the nearby hostile mobs and immediate hazards now; do not rely on the earlier observation.",
    expected: [
      "com.casimirbot.minecraft.nearby_entities.list",
      "com.casimirbot.minecraft.hazards.scan",
    ],
  },
  ambiguous_actor: {
    prompt:
      "In this Minecraft room, check my current actor status now.",
    expected: ["com.casimirbot.minecraft.actor.status.read"],
    expectedOutcome: "target_ambiguous",
  },
  stale_source: {
    prompt: "In this Minecraft room, check my current actor status now.",
    expected: ["com.casimirbot.minecraft.actor.status.read"],
    expectedOutcome: "result_stale",
  },
  permission_failure: {
    prompt: "In this Minecraft room, check my current actor status now.",
    expected: [],
    expectedHttpError: "shared_realtime_room_not_found",
    profileId: "profile:minecraft-situation-unbound-local",
    skipPresence: true,
  },
  closed_container: {
    prompt:
      "In this Minecraft room, inspect the contents of the nearest closed chest without opening it and tell me exactly what is inside.",
    expected: [],
    forbiddenCapabilities: [
      "com.casimirbot.minecraft.inventory.check",
      "com.casimirbot.minecraft.local_map.inspect",
    ],
    expectedLimitation: true,
  },
};

const [statePathValue, scenarioId, artifactRootValue] = process.argv.slice(2);
if (!statePathValue || !scenarioId || !scenarios[scenarioId]) {
  throw new Error("usage_state_path_and_known_scenario_required");
}

const requestedModelProfile = String(
  process.env.HELIX_MINECRAFT_SITUATION_MODEL_PROFILE || "",
).trim().toLowerCase();
if (
  requestedModelProfile &&
  !["auto", "fast", "balanced", "deep"].includes(requestedModelProfile)
) {
  throw new Error("invalid_minecraft_situation_model_profile");
}

const statePath = path.resolve(statePathValue);
const artifactRoot = path.resolve(
  artifactRootValue || path.join("artifacts", "minecraft-situation-live"),
);
const scenario = scenarios[scenarioId];
const state = JSON.parse(await fs.readFile(statePath, "utf8"));
const baseUrl = String(state.base_url || "").replace(/\/+$/u, "");
const roomId = String(state.room_id || "").trim();
const profileId = String(scenario.profileId || state.profile_id || "").trim();
if (!baseUrl || !roomId || !profileId) {
  throw new Error("local_room_state_invalid");
}

const threadId = `helix-ask:room:${roomId}`;
const timeoutMs = Math.max(
  1_000,
  Number(process.env.HELIX_MINECRAFT_SITUATION_TIMEOUT_MS) ||
    DEFAULT_TIMEOUT_MS,
);

// Node's built-in fetch applies an independent Undici headers timeout (five
// minutes at the time this probe was written). A balanced Ask turn can
// legitimately exceed that while the route is still reasoning and executing,
// even when the scenario explicitly configured a longer deadline. Use the
// native HTTP client so the single declared scenario deadline is authoritative.
const fetchWithTimeout = (urlValue, init = {}) =>
  new Promise((resolve, reject) => {
    const url = new URL(urlValue);
    const transport = url.protocol === "https:" ? https : http;
    let settled = false;
    const request = transport.request(
      url,
      {
        method: init.method || "GET",
        headers: init.headers || {},
      },
      (response) => {
        const chunks = [];
        let byteCount = 0;
        response.on("data", (chunk) => {
          byteCount += chunk.length;
          if (byteCount > 64 * 1024 * 1024) {
            request.destroy(new Error("response_body_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok:
              Number(response.statusCode) >= 200 &&
              Number(response.statusCode) < 300,
            status: Number(response.statusCode) || 0,
            headers: {
              get(name) {
                const value = response.headers[String(name).toLowerCase()];
                return Array.isArray(value) ? value.join(", ") : value ?? null;
              },
            },
            text: async () => body,
          });
        });
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new Error("scenario_http_timeout"));
    }, timeoutMs);
    request.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });

const readJson = async (response) => {
  const text = await response.text();
  if (!response.ok) {
    let code = `http_${response.status}`;
    try {
      const parsed = JSON.parse(text);
      const typedCode = [
        parsed?.error,
        parsed?.error_code,
        parsed?.reason_code,
        parsed?.failure_code,
        parsed?.code,
        parsed?.ask_turn_admission?.reason,
      ].find((value) => typeof value === "string" && value.trim());
      if (typedCode) code = typedCode.trim();
    } catch {
      // Do not echo an arbitrary response body into test logs.
    }
    throw new Error(code);
  }
  return text ? JSON.parse(text) : {};
};

const signIn = async () => {
  const response = await fetchWithTimeout(
    `${baseUrl}/api/account/session/sign-in`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: baseUrl,
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({
        profile_id: profileId,
        display_name: "Minecraft situation-awareness local test",
        account_type: "developer",
      }),
    },
  );
  await readJson(response);
  const cookie = response.headers
    .get("set-cookie")
    ?.split(";", 1)[0]
    ?.trim();
  if (!cookie || !/^helix_session=[^;\s]+$/u.test(cookie)) {
    throw new Error("session_cookie_missing");
  }
  return cookie;
};

const postJson = async (url, cookie, body) =>
  readJson(
    await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: cookie,
        Origin: baseUrl,
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify(body),
    }),
  );

const getJson = async (url, cookie) =>
  readJson(
    await fetchWithTimeout(url, {
      headers: {
        Cookie: cookie,
        Origin: baseUrl,
        "Sec-Fetch-Site": "same-origin",
      },
    }),
  );

const putJson = async (url, cookie, body) =>
  readJson(
    await fetchWithTimeout(url, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        Cookie: cookie,
        Origin: baseUrl,
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify(body),
    }),
  );

const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;
const array = (value) => (Array.isArray(value) ? value : []);
const string = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const unwrapDebug = (value) => record(value?.payload) || record(value) || {};

const ledgerEntries = (ask, debug) => [
  ...array(ask.current_turn_artifact_ledger),
  ...array(debug.current_turn_artifact_ledger),
].map(record).filter(Boolean);

const listCapabilities = (observations, ask, debug) => {
  const capabilities = observations.map((entry) => entry.capability_id);
  const loop =
    record(debug.agent_runtime_loop) || record(ask.agent_runtime_loop) || {};
  for (const iteration of array(loop.iterations).map(record).filter(Boolean)) {
    const decision = record(iteration.decision);
    const selected =
      string(decision?.chosen_capability) ||
      string(decision?.capability_id);
    if (CAPABILITY_PREFIXES.some((prefix) => selected?.startsWith(prefix))) {
      capabilities.push(selected);
    }
  }
  return [...new Set(capabilities)];
};

const selectedAnswer = (ask, debug) =>
  string(ask.answer) ||
  string(ask.selected_final_answer) ||
  string(debug.selected_final_answer) ||
  string(record(debug.resolved_turn_summary)?.answer);

const terminalKind = (ask, debug) =>
  string(record(debug.resolved_turn_summary)?.terminal_artifact_kind) ||
  string(record(ask.resolved_turn_summary)?.terminal_artifact_kind) ||
  string(debug.terminal_artifact_kind);

const findReactiveProgramMeasurements = (roots) => {
  const queue = [...roots];
  const seen = new Set();
  let best = null;
  while (queue.length && seen.size < 20_000) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (
      value.reactive_program_completed === true &&
      Number.isFinite(value.action_receipt_count)
    ) {
      const score =
        Number(value.action_receipt_count || 0) * 10_000 +
        Number(value.consumed_item_count || 0) * 100 +
        Number(value.executed_action_count || 0);
      if (!best || score > best.score) best = { score, measurements: value };
    }
    queue.push(...Object.values(value));
  }
  return best?.measurements || null;
};

const findCameraSafetyInterrupt = (roots) => {
  const queue = [...roots];
  const seen = new Set();
  let best = null;
  while (queue.length && seen.size < 30_000) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    const capabilityId =
      string(value.capability_id) || string(value.capability_key);
    const observation = record(value.observation);
    const result = record(observation?.result) || record(value.result);
    const measurements =
      record(result?.verified_terminal_measurements) ||
      record(value.verified_terminal_measurements);
    const measuredHealth = Number(measurements?.measured_health);
    const stopBelowHealth = Number(measurements?.stop_below_health);
    const safetyInterrupted =
      measurements?.safety_interrupted === true ||
      (
        Number.isFinite(measuredHealth) &&
        Number.isFinite(stopBelowHealth) &&
        measuredHealth < stopBelowHealth
      );
    if (
      capabilityId === "com.casimirbot.minecraft.player.camera.track" &&
      measurements &&
      safetyInterrupted
    ) {
      const candidate = {
        outcome: string(observation?.outcome) || string(value.outcome),
        summary: string(observation?.summary) || string(value.summary),
        evidence_ref:
          string(observation?.evidence_ref) || string(value.evidence_ref),
        eligible_for_current_turn_reentry:
          observation?.eligible_for_current_turn_reentry === true ||
          value.eligible_for_current_turn_reentry === true,
        measured_health: measuredHealth,
        stop_below_health: stopBelowHealth,
        tracking_completed: measurements.tracking_completed,
        safety_interrupted: safetyInterrupted,
        interrupt_reason: string(measurements.interrupt_reason),
        controls_released: result?.controls_released === true,
        world_mutation_performed: result?.world_mutation_performed === true,
        inventory_mutation_performed:
          result?.inventory_mutation_performed === true,
      };
      const score =
        (candidate.outcome === "succeeded" ? 100 : 0) +
        (candidate.eligible_for_current_turn_reentry ? 20 : 0) +
        (candidate.controls_released ? 10 : 0);
      if (!best || score > best.score) best = { score, candidate };
    }
    queue.push(...Object.values(value));
  }
  return best?.candidate || null;
};

const findActorStatusHealth = (roots) => {
  const queue = [...roots];
  const seen = new Set();
  let best = null;
  while (queue.length && seen.size < 30_000) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    const capabilityId =
      string(value.capability_id) || string(value.capability_key);
    const observation = record(value.observation);
    const result = record(observation?.result) || record(value.result);
    const health = Number(result?.health);
    if (
      capabilityId === "com.casimirbot.minecraft.actor.status.read" &&
      Number.isFinite(health)
    ) {
      const candidate = {
        health,
        max_health: Number(result?.max_health),
        outcome: string(observation?.outcome) || string(value.outcome),
        eligible_for_current_turn_reentry:
          observation?.eligible_for_current_turn_reentry === true ||
          value.eligible_for_current_turn_reentry === true,
      };
      const score =
        (candidate.outcome === "succeeded" ? 10 : 0) +
        (candidate.eligible_for_current_turn_reentry ? 5 : 0);
      if (!best || score > best.score) best = { score, candidate };
    }
    queue.push(...Object.values(value));
  }
  return best?.candidate || null;
};

const refreshExactStaleLocalSubjectBinding = async (cookie) => {
  const origin = new URL(baseUrl);
  if (
    origin.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(origin.hostname)
  ) {
    return null;
  }
  const sourceId = string(state.source_id);
  if (!sourceId) return null;
  const receipt = await getJson(
    `${baseUrl}/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/environments`,
    cookie,
  );
  const matching = array(receipt.environments)
    .map(record)
    .filter(
      (environment) =>
        environment?.source_id === sourceId &&
        environment?.domain_adapter === "minecraft.fabric_mod.v1" &&
        environment?.connection_status === "active",
    );
  if (matching.length !== 1) return null;
  const environment = matching[0];
  const binding = record(environment.self_subject_binding);
  if (!binding || binding.status !== "stale") return null;
  const directory = record(environment.subject_directory);
  const sameSubjects = array(directory?.subjects)
    .map(record)
    .filter(
      (subject) =>
        subject?.presence === "online" &&
        subject?.subject_ref === binding.subject_ref &&
        subject?.claimed_by_participant_id === binding.participant_id,
    );
  if (directory?.freshness !== "fresh" || sameSubjects.length !== 1) {
    throw new Error("safe_same_subject_refresh_precondition_failed");
  }
  const refreshed = await putJson(
    `${baseUrl}/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/environments/${encodeURIComponent(environment.environment_binding_id)}/me`,
    cookie,
    { subject_ref: binding.subject_ref },
  );
  if (refreshed?.binding?.status !== "active") {
    throw new Error("same_subject_refresh_not_active");
  }
  return {
    refreshed: true,
    subject_label: string(refreshed.binding.subject_label),
    verification_method: string(refreshed.binding.verification_method),
  };
};

const cookie = await signIn();
let stopPresenceHeartbeat = async () => undefined;
let subjectBindingRefresh = null;
if (!scenario.skipPresence) {
  await postJson(
    `${baseUrl}/api/account/session/experimental-rooms`,
    cookie,
    { enabled: true },
  );
  await postJson(
    `${baseUrl}/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/presence`,
    cookie,
    { presence: "present" },
  );
  stopPresenceHeartbeat = startSharedRoomPresenceHeartbeat({
    sendPresent: () => postJson(
      `${baseUrl}/api/agi/realtime/rooms/${encodeURIComponent(roomId)}/presence`,
      cookie,
      { presence: "present" },
    ),
  });
  subjectBindingRefresh = await refreshExactStaleLocalSubjectBinding(cookie);
}
const startedAt = Date.now();
const configuredTurnRef = String(
  process.env.HELIX_MINECRAFT_SITUATION_TURN_ID || "",
).trim();
const turnRef =
  configuredTurnRef || `minecraft-situation:${scenarioId}:${Date.now()}`;
let ask;
let expectedHttpBoundaryHandled = false;
try {
  ask = await postJson(`${baseUrl}/api/agi/ask/turn`, cookie, {
    sessionId: threadId,
    threadId,
    conversation_thread_id: threadId,
    question: scenario.prompt,
    prompt: scenario.prompt,
    mode: scenario.mode || "read",
    ...(requestedModelProfile
      ? { language_model_profile: requestedModelProfile }
      : {}),
    account_type: "developer",
    debug: true,
    turnId: turnRef,
    turn_id: turnRef,
    traceId: turnRef,
    agentRuntime: "codex",
    agent_runtime: "codex",
  });
} catch (error) {
  const errorCode =
    error instanceof Error && error.message ? error.message : "ask_http_error";
  if (scenario.expectedHttpError !== errorCode) {
    await stopPresenceHeartbeat();
    throw error;
  }
  const result = {
    schema: "helix.minecraft_situation_live_probe.v1",
    scenario_id: scenarioId,
    prompt: scenario.prompt,
    verdict: "PASS",
    failures: [],
    turn_id: null,
    thread_id: threadId,
    elapsed_ms: Date.now() - startedAt,
    capabilities: [],
    observations: [],
    terminal_kind: "http_typed_failure",
    answer: errorCode,
    permission_boundary: "room_membership_non_disclosure",
    ask_turn_solver_trace_present: false,
    credential_value_reported: false,
    credential_leak_detected: false,
  };
  const scenarioDirectory = path.join(artifactRoot, scenarioId);
  await fs.mkdir(scenarioDirectory, { recursive: true });
  await fs.writeFile(
    path.join(scenarioDirectory, "ask-response.json"),
    `${JSON.stringify({ error: errorCode }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(scenarioDirectory, "probe-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  await stopPresenceHeartbeat();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  expectedHttpBoundaryHandled = true;
}
if (!expectedHttpBoundaryHandled) {
const turnId = string(ask.turn_id) || string(ask.trace_id);
let debugResponse;
try {
  debugResponse = turnId
    ? await getJson(
        `${baseUrl}/api/agi/ask/turn/${encodeURIComponent(
          turnId,
        )}/debug-export`,
        cookie,
      )
    : {};
} finally {
  await stopPresenceHeartbeat();
}
const debug = unwrapDebug(debugResponse);
const ledger = ledgerEntries(ask, debug);
const observations = collectMinecraftCapabilityObservations([ledger, ask, debug]);
const capabilities = listCapabilities(observations, ask, debug);
const answer = selectedAnswer(ask, debug);
const resolvedTerminalKind = terminalKind(ask, debug);
const serialized = JSON.stringify({ ask, debugResponse });
const secretLeakDetected =
  /helix_room_src_[A-Za-z0-9_-]+/u.test(serialized) ||
  /"bearer_token"\s*:\s*"(?!\[?REDACTED)/iu.test(serialized) ||
  /"claim_handle"\s*:/iu.test(serialized);
const failures = [];

if (!turnId) failures.push("turn_id_missing");
if (!answer) failures.push("final_answer_missing");
if (secretLeakDetected) failures.push("credential_material_leaked");
if (!debug.ask_turn_solver_trace) failures.push("ask_turn_solver_trace_missing");
if (
  !scenario.expectedOutcome &&
  !scenario.expectedLimitation &&
  resolvedTerminalKind === "typed_failure"
) {
  failures.push("unexpected_typed_failure");
}
for (const expected of scenario.expected) {
  if (!capabilities.includes(expected)) {
    failures.push(`expected_capability_missing:${expected}`);
    continue;
  }
  if (!scenario.expectedOutcome) {
    const succeeded = observations.some(
      (entry) =>
        entry.capability_id === expected &&
        entry.outcome === "succeeded" &&
        entry.eligible_for_current_turn_reentry,
    );
    if (!succeeded) {
      failures.push(`expected_current_turn_observation_missing:${expected}`);
    }
  }
}
for (const forbidden of scenario.forbiddenCapabilities || []) {
  if (capabilities.includes(forbidden)) {
    failures.push(`forbidden_capability_used:${forbidden}`);
  }
}
if (scenario.expectedOutcome) {
  const matching = observations.some(
    (entry) => entry.outcome === scenario.expectedOutcome,
  );
  if (!matching) failures.push(`expected_outcome_missing:${scenario.expectedOutcome}`);
}
if (
  scenario.expectedLimitation &&
  answer &&
  !/(cannot|can't|unsupported|not available|unable|does not|don't have|no capability|not inspect)/iu.test(
    answer,
  )
) {
  failures.push("unsupported_limitation_not_explained");
}
if (
  answer &&
  /"(?:tool_name|capability_id|arguments)"\s*:/u.test(answer)
) {
  failures.push("tool_request_exposed_as_answer");
}

let acceptanceMeasurements = null;
if (scenario.verifyGuardianTrackMoveFeed) {
  const measurements = findReactiveProgramMeasurements([ask, debug]);
  const receipts = array(measurements?.action_receipts).map(record).filter(Boolean);
  const interactions = receipts.filter(
    (receipt) => receipt.action_kind === "interact",
  );
  acceptanceMeasurements = measurements
    ? {
        action_receipt_count: measurements.action_receipt_count,
        executed_action_count: measurements.executed_action_count,
        consumed_item_count: measurements.consumed_item_count,
        inventory_mutations_performed:
          measurements.inventory_mutations_performed,
        interaction_receipt_count: interactions.length,
        interaction_consumed_item_counts: interactions.map(
          (receipt) => receipt.consumed_item_count,
        ),
        resource_conflict_count: measurements.resource_conflict_count,
        world_mutations_performed: measurements.world_mutations_performed,
        parallel_tick_count: measurements.parallel_tick_count,
        controls_released: measurements.controls_released,
      }
    : null;
  if (!measurements) {
    failures.push("guardian_terminal_measurements_missing");
  } else {
    if (measurements.consumed_item_count !== 3) {
      failures.push("guardian_exact_feed_consumption_missing");
    }
    if (measurements.inventory_mutations_performed !== 3) {
      failures.push("guardian_exact_feed_inventory_mutations_missing");
    }
    if (
      interactions.length !== 3 ||
      interactions.some((receipt) => receipt.consumed_item_count !== 1)
    ) {
      failures.push("guardian_three_distinct_feed_receipts_missing");
    }
    if (Number(measurements.executed_action_count || 0) < 5) {
      failures.push("guardian_five_action_receipts_missing");
    }
    if (Number(measurements.parallel_tick_count || 0) < 1) {
      failures.push("guardian_concurrent_execution_missing");
    }
    if (measurements.resource_conflict_count !== 0) {
      failures.push("guardian_resource_conflict_detected");
    }
    if (measurements.world_mutations_performed !== 0) {
      failures.push("guardian_unexpected_world_mutation");
    }
    if (measurements.controls_released !== true) {
      failures.push("guardian_controls_not_released");
    }
  }
}

if (scenario.verifyGuardianWaterBucketRescue) {
  const measurements = findReactiveProgramMeasurements([ask, debug]);
  const validatorOnlyDiagnosticDetourCount =
    countGuardianValidatorOnlyDiagnosticDetours(observations);
  const receipts = array(measurements?.action_receipts).map(record).filter(Boolean);
  const walkReceipts = receipts.filter(
    (receipt) => receipt.action_kind === "walk",
  );
  const placementReceipts = receipts.filter(
    (receipt) => receipt.action_kind === "place",
  );
  const placement = placementReceipts[0] || null;
  const conditionObservations = array(measurements?.condition_observations)
    .map(record)
    .filter(Boolean);
  const verticalVelocityObserved = conditionObservations.some(
    (observation) =>
      observation.condition_kind === "vertical_velocity_at_most" &&
      observation.satisfied === true,
  );
  const collisionPredictionEvidence =
    classifyGuardianCollisionPredictionEvidence(measurements);
  const landingObserved = collisionPredictionEvidence.condition_observed;
  const collisionPredictionProved = collisionPredictionEvidence.observed;
  // A trajectory-driven clutch may use a negative vertical-velocity event or
  // the stronger short-horizon collision prediction. Do not reject a valid
  // Codex-authored strategy merely because it selected the latter condition.
  const measuredTrajectoryObserved =
    verticalVelocityObserved || landingObserved;
  const laneResourcesReleased = array(measurements?.lanes)
    .map(record)
    .filter(Boolean)
    .every(
      (lane) =>
        lane.controls_released === true &&
        array(lane.held_resources).length === 0,
    );
  acceptanceMeasurements = measurements
    ? {
        action_receipt_count: measurements.action_receipt_count,
        executed_action_count: measurements.executed_action_count,
        walk_receipt_count: walkReceipts.length,
        placement_receipt_count: placementReceipts.length,
        placement_method: placement?.placement_method,
        placement_source_item_id: placement?.source_item_id,
        placement_hand: placement?.hand,
        placement_block_id: placement?.block_id,
        placement_verified_positions: placement?.verified_positions,
        placement_held_item_before: placement?.held_item_id_before,
        placement_held_item_after: placement?.held_item_id_after,
        inventory_mutations_performed:
          measurements.inventory_mutations_performed,
        world_mutations_performed: measurements.world_mutations_performed,
        falling_condition_observed: verticalVelocityObserved,
        measured_trajectory_condition_observed: measuredTrajectoryObserved,
        predicted_collision_condition_observed: landingObserved,
        predicted_collision_binding_verified:
          collisionPredictionEvidence.binding_verified,
        scheduler_duration_ticks: Number(measurements.tick_index ?? 0),
        scheduler_duration_ms_at_20_tps:
          Number(measurements.tick_index ?? 0) * 50,
        validator_only_diagnostic_detour_count:
          validatorOnlyDiagnosticDetourCount,
        // The scheduler increments this counter whenever a lower-priority
        // lane waits for a resource. Bounded arbitration is expected and is
        // not an unresolved collision when every lane releases its resources.
        resolved_resource_wait_count: measurements.resource_conflict_count,
        lane_resources_released: laneResourcesReleased,
        interrupt_count: measurements.interrupt_count,
        controls_released: measurements.controls_released,
      }
    : null;
  if (!measurements) {
    failures.push("guardian_terminal_measurements_missing");
  } else {
    if (walkReceipts.length !== 1 || walkReceipts[0]?.outcome !== "succeeded") {
      failures.push("guardian_controlled_fall_start_missing");
    }
    if (
      placementReceipts.length !== 1 ||
      placement?.outcome !== "succeeded" ||
      placement?.placement_method !== "item_use" ||
      placement?.source_item_id !== "minecraft:water_bucket" ||
      placement?.hand !== "main_hand" ||
      placement?.block_id !== "minecraft:water" ||
      placement?.verified_positions !== 1 ||
      placement?.held_item_id_before !== "minecraft:water_bucket" ||
      placement?.held_item_id_after !== "minecraft:bucket" ||
      placement?.inventory_mutations_performed !== 1
    ) {
      failures.push("guardian_exact_water_bucket_placement_missing");
    }
    if (!measuredTrajectoryObserved) {
      failures.push("guardian_measured_trajectory_observation_missing");
    }
    if (!collisionPredictionProved) {
      failures.push("guardian_collision_prediction_observation_missing");
    }
    // The program-wide counter also records hotbar/equipment selection. The
    // placement receipt is the causal evidence for the one bucket-content
    // transition required by this scenario.
    if (measurements.world_mutations_performed !== 1) {
      failures.push("guardian_exact_water_world_mutation_missing");
    }
    if (!laneResourcesReleased) {
      failures.push("guardian_lane_resources_not_released");
    }
    if (measurements.interrupt_count !== 0) {
      failures.push("guardian_unexpected_interrupt_detected");
    }
    if (measurements.controls_released !== true) {
      failures.push("guardian_controls_not_released");
    }
  }
}

if (scenario.verifyGuardianUnavailableInventoryReplan) {
  const inventoryPerturbationObservations = observations.filter(
    (entry) =>
      entry.capability_id === "com.casimirbot.minecraft.inventory.check" &&
      entry.outcome === "succeeded" &&
      entry.eligible_for_current_turn_reentry,
  );
  const failedGuardianObservations = observations.filter(
    (entry) =>
      entry.capability_id ===
        "com.casimirbot.minecraft.player.guardian.execute" &&
      entry.outcome === "failed" &&
      entry.eligible_for_current_turn_reentry,
  );
  const measurements = findReactiveProgramMeasurements([ask, debug]);
  const receipts = array(measurements?.action_receipts).map(record).filter(Boolean);
  const worldMutations = Number(measurements?.world_mutations_performed ?? 0);
  const inventoryUnavailable =
    /(?:water[_ -]?bucket|minecraft:water_bucket)[\s\S]{0,180}(?:unavailable|not available|missing|not found|could not|failed|\bno\b)/iu.test(
      answer || "",
    ) ||
    /(?:unavailable|not available|missing|not found|could not|failed|\bno\b)[\s\S]{0,180}(?:water[_ -]?bucket|minecraft:water_bucket)/iu.test(
      answer || "",
    );
  const safeDecisionReported =
    /\b(?:cancel(?:led|ed)?|stop(?:ped)?|did not move|no movement|remained|safe(?:ly)?|aborted|not proceed)\b/iu.test(
      answer || "",
    );
  acceptanceMeasurements = {
    inventory_perturbation_observation_count:
      inventoryPerturbationObservations.length,
    failed_current_turn_guardian_observation_count:
      failedGuardianObservations.length,
    action_receipt_count: measurements?.action_receipt_count ?? receipts.length,
    executed_action_count: measurements?.executed_action_count ?? null,
    world_mutations_performed: worldMutations,
    controls_released: measurements?.controls_released ?? null,
    inventory_unavailable_reported: inventoryUnavailable,
    safe_revision_or_cancellation_reported: safeDecisionReported,
  };
  if (
    inventoryPerturbationObservations.length < 1 &&
    failedGuardianObservations.length < 1
  ) {
    failures.push("guardian_inventory_perturbation_observation_not_reentered");
  }
  if (worldMutations !== 0) {
    failures.push("guardian_unavailable_inventory_world_mutation_detected");
  }
  if (measurements && measurements.controls_released !== true) {
    failures.push("guardian_unavailable_inventory_controls_not_released");
  }
  if (!inventoryUnavailable) {
    failures.push("guardian_inventory_failure_not_reported");
  }
  if (!safeDecisionReported) {
    failures.push("guardian_safe_revision_or_cancellation_not_reported");
  }
}

if (scenario.verifyGuardianMidExecutionHealthInterrupt) {
  const guardianObservations = observations.filter(
    (entry) =>
      entry.capability_id ===
        "com.casimirbot.minecraft.player.guardian.execute" &&
      entry.eligible_for_current_turn_reentry,
  );
  const measurements = findReactiveProgramMeasurements([ask, debug]);
  const cameraSafetyInterrupt = findCameraSafetyInterrupt([ask, debug]);
  const actorStatusHealth = findActorStatusHealth([ask, debug]);
  const actionReceipts = array(measurements?.action_receipts)
    .map(record)
    .filter(Boolean);
  const guardedCameraReceipt = actionReceipts.find((receipt) =>
    receipt.action_kind === "track_target" &&
    receipt.outcome === "succeeded" &&
    receipt.safety_interrupted === true &&
    receipt.tracking_completed === false &&
    string(receipt.interrupt_reason) === "health_floor_crossed" &&
    Number.isFinite(Number(receipt.measured_health)) &&
    Number.isFinite(Number(receipt.stop_below_health)) &&
    Number(receipt.measured_health) < Number(receipt.stop_below_health)
  ) || null;
  const conditionObservations = array(measurements?.condition_observations)
    .map(record)
    .filter(Boolean)
    .filter((entry) => entry.condition_kind === "health_at_least");
  const observedHealthy = conditionObservations.some(
    (entry) => entry.satisfied === true,
  ) || Boolean(
    guardedCameraReceipt &&
    actorStatusHealth?.eligible_for_current_turn_reentry === true &&
    actorStatusHealth.health >= Number(guardedCameraReceipt.stop_below_health),
  );
  const observedThresholdBreach = conditionObservations.some(
    (entry) => entry.satisfied === false && Number(entry.tick_index ?? 0) >= 2,
  ) || Boolean(guardedCameraReceipt);
  const lanes = array(measurements?.lanes).map(record).filter(Boolean);
  const canceledActiveLane = lanes.some(
    (lane) =>
      lane.lane_kind === "camera" &&
      lane.state === "canceled" &&
      Number(lane.tick_index ?? measurements?.tick_index ?? 0) >= 2,
  ) || Boolean(guardedCameraReceipt);
  const directCameraSafetySatisfied = Boolean(
    cameraSafetyInterrupt &&
    cameraSafetyInterrupt.outcome === "succeeded" &&
    cameraSafetyInterrupt.eligible_for_current_turn_reentry === true &&
    cameraSafetyInterrupt.safety_interrupted === true &&
    cameraSafetyInterrupt.tracking_completed === false &&
    cameraSafetyInterrupt.controls_released === true &&
    cameraSafetyInterrupt.measured_health <
      cameraSafetyInterrupt.stop_below_health,
  );
  const answerReportsInterrupt =
    /\b(?:health|threshold)\b/iu.test(answer || "") &&
    /\b(?:interrupt(?:ed|ion)?|cancel(?:led|ed)?|stop(?:ped)?)\b/iu.test(
      answer || "",
    );
  acceptanceMeasurements = measurements
    ? {
        execution_mode: "reactive_guardian_program",
        guardian_observation_count: guardianObservations.length,
        tick_index: measurements.tick_index,
        interrupt_count: measurements.interrupt_count,
        condition_observation_count:
          measurements.condition_observation_count,
        observed_initially_healthy: observedHealthy,
        observed_later_threshold_breach: observedThresholdBreach,
        initial_health: actorStatusHealth?.health ?? null,
        measured_interrupt_health:
          guardedCameraReceipt?.measured_health ?? null,
        stop_below_health:
          guardedCameraReceipt?.stop_below_health ?? null,
        safety_interrupted:
          guardedCameraReceipt?.safety_interrupted ?? false,
        tracking_completed:
          guardedCameraReceipt?.tracking_completed ?? null,
        interrupt_reason:
          guardedCameraReceipt?.interrupt_reason ?? null,
        canceled_active_lane: canceledActiveLane,
        controls_released: measurements.controls_released,
        world_mutations_performed: measurements.world_mutations_performed,
        inventory_mutations_performed:
          measurements.inventory_mutations_performed,
        answer_reports_interrupt: answerReportsInterrupt,
      }
    : cameraSafetyInterrupt
      ? {
          execution_mode: "direct_camera_health_guard",
          guardian_observation_count: guardianObservations.length,
          measured_health: cameraSafetyInterrupt.measured_health,
          stop_below_health: cameraSafetyInterrupt.stop_below_health,
          observed_later_threshold_breach:
            cameraSafetyInterrupt.measured_health <
            cameraSafetyInterrupt.stop_below_health,
          safety_interrupted: cameraSafetyInterrupt.safety_interrupted,
          interrupt_reason: cameraSafetyInterrupt.interrupt_reason,
          canceled_active_lane:
            cameraSafetyInterrupt.tracking_completed === false,
          controls_released: cameraSafetyInterrupt.controls_released,
          world_mutations_performed:
            cameraSafetyInterrupt.world_mutation_performed ? 1 : 0,
          inventory_mutations_performed:
            cameraSafetyInterrupt.inventory_mutation_performed ? 1 : 0,
          answer_reports_interrupt: answerReportsInterrupt,
        }
      : null;
  if (guardianObservations.length < 1 && !directCameraSafetySatisfied) {
    failures.push("guardian_interrupt_observation_not_reentered");
  }
  if (!measurements && !directCameraSafetySatisfied) {
    failures.push("guardian_interrupt_terminal_measurements_missing");
  } else if (measurements) {
    if (!observedHealthy || !observedThresholdBreach) {
      failures.push("guardian_mid_execution_health_transition_missing");
    }
    if (Number(measurements.interrupt_count ?? 0) < 1) {
      failures.push("guardian_health_interrupt_missing");
    }
    if (!canceledActiveLane) {
      failures.push("guardian_active_lane_not_canceled_by_interrupt");
    }
    if (measurements.controls_released !== true) {
      failures.push("guardian_interrupt_controls_not_released");
    }
    if (
      Number(measurements.world_mutations_performed ?? 0) !== 0 ||
      Number(measurements.inventory_mutations_performed ?? 0) !== 0
    ) {
      failures.push("guardian_interrupt_unexpected_mutation_detected");
    }
  } else if (
    cameraSafetyInterrupt.world_mutation_performed ||
    cameraSafetyInterrupt.inventory_mutation_performed
  ) {
    failures.push("guardian_interrupt_unexpected_mutation_detected");
  }
  if (!answerReportsInterrupt) {
    failures.push("guardian_interrupt_not_reported_by_runtime");
  }
}

const result = {
  schema: "helix.minecraft_situation_live_probe.v1",
  scenario_id: scenarioId,
  prompt: scenario.prompt,
  verdict: failures.length ? "FAIL" : "PASS",
  failures,
  turn_id: turnId,
  thread_id: threadId,
  elapsed_ms: Date.now() - startedAt,
  capabilities,
  observations,
  terminal_kind: resolvedTerminalKind,
  answer: answer?.slice(0, 2_000) || null,
  acceptance_measurements: acceptanceMeasurements,
  ask_turn_solver_trace_present: Boolean(debug.ask_turn_solver_trace),
  subject_binding_refresh: subjectBindingRefresh,
  credential_value_reported: false,
  credential_leak_detected: secretLeakDetected,
};

const scenarioDirectory = path.join(artifactRoot, scenarioId);
await fs.mkdir(scenarioDirectory, { recursive: true });
await fs.writeFile(
  path.join(scenarioDirectory, "ask-response.json"),
  `${JSON.stringify(ask, null, 2)}\n`,
);
await fs.writeFile(
  path.join(scenarioDirectory, "debug-export.json"),
  `${JSON.stringify(debugResponse, null, 2)}\n`,
);
await fs.writeFile(
  path.join(scenarioDirectory, "probe-result.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(result)}\n`);
if (failures.length) process.exitCode = 1;
}
