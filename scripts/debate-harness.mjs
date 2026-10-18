// Run with: BASE_URL=http://localhost:5000 node --experimental-fetch scripts/debate-harness.mjs
// Requires ENABLE_DEBATE=1 on the server.

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";
const PERSONA_ID = process.env.PERSONA_ID ?? "default";
const GOAL =
  process.env.GOAL ??
  "Interpret Casimir badge status and advise next steps for yellow guard tiles. Also relate the fractional coherence grid to the Casimir Tile Grid.";

const ATTACHMENTS = [
  {
    title: "Stellar Consciousness (Orch OR Review)",
    // Keep the local path; the server will turn it into a fetchable URL.
    url: "/mnt/data/Reformatted; Stellar Consciousness by Orchestrated Objective Reduction Review.pdf",
  },
  {
    title: "Quantum Computation in Brain Microtubules (1998)",
    url: "/mnt/data/Quantum Computation in Brain Microtubules The Penrose-Hameroff hameroff-1998.pdf",
  },
];

const startBody = {
  goal: GOAL,
  persona_id: PERSONA_ID,
  max_rounds: 4,
  max_wall_ms: 15000,
  context: { attachments: ATTACHMENTS },
};

const startRes = await fetch(`${BASE_URL}/api/agi/debate/start`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(startBody),
});
if (!startRes.ok) {
  console.error("start error", startRes.status, await startRes.text());
  process.exit(1);
}
const { debateId } = await startRes.json();
console.log("Debate started:", debateId);

const streamUrl = `${BASE_URL}/api/agi/debate/stream?debateId=${encodeURIComponent(debateId)}`;
console.log("Connecting to stream:", streamUrl);

const decoder = new TextDecoder();
let outcome = null;
const controller = new AbortController();

function parseSSELine(block) {
  const dataLine = block
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data:"));
  if (!dataLine) return null;
  const payload = dataLine.slice(5).trim();
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function handleEvent(event) {
  if (!event || typeof event !== "object") return;
  if (event.type === "turn") {
    const { role, round, text } = event.turn ?? {};
    const preview = text ? text.slice(0, 140) + (text.length > 140 ? "…" : "") : "";
    console.log(`[turn] ${role ?? "?"} #${round ?? "?"}: ${preview}`);
  } else if (event.type === "status") {
    console.log(`[status] ${event.status} seq=${event.seq}`);
  } else if (event.type === "outcome") {
    outcome = event.outcome ?? null;
    console.log(
      `[outcome] verdict=${outcome?.verdict ?? "unknown"} conf=${outcome?.confidence ?? "?"} (seq=${event.seq})`,
    );
    controller.abort();
  }
}

const streamPromise = (async () => {
  const res = await fetch(streamUrl, { signal: controller.signal });
  if (!res.ok || !res.body) {
    throw new Error(`SSE error: ${res.status} ${await res.text()}`);
  }
  const reader = res.body.getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = parseSSELine(block);
      if (event) {
        handleEvent(event);
        if (outcome) return;
      }
    }
  }
})().catch((err) => {
  if (err.name !== "AbortError") {
    console.error("SSE error:", err.message ?? err);
  }
});

const pollPromise = (async () => {
  const snapshotUrl = `${BASE_URL}/api/agi/debate/${debateId}`;
  const deadline = Date.now() + 20000;
  while (!outcome && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      const res = await fetch(snapshotUrl);
      if (!res.ok) continue;
      const snap = await res.json();
      if (snap?.outcome) {
        outcome = snap.outcome;
        console.log(`[snapshot] verdict=${outcome.verdict} conf=${outcome.confidence}`);
        controller.abort();
        break;
      }
    } catch {
      // ignore transient snapshot errors
    }
  }
})();

await Promise.race([streamPromise, pollPromise]);
controller.abort();

console.log("\n=== Debate Outcome ===");
if (!outcome) {
  console.error("Debate outcome was not produced within 20s.");
  process.exit(1);
}
console.log(JSON.stringify(outcome, null, 2));
