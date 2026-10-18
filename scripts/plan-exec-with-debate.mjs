// Run with: BASE_URL=http://localhost:5000 node --experimental-fetch scripts/plan-exec-with-debate.mjs
// Assumes ENABLE_DEBATE=1 and planner wiring that inserts debate steps.

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";
const DESKTOP_ID = process.env.DESKTOP_ID ?? "helix.desktop.main";
const PERSONA_ID = process.env.PERSONA_ID ?? "default";
const GOAL =
  process.env.GOAL ??
  "Are there any drive guard badges in the yellow? Relate the fractional coherence grid to the Casimir Tile Grid.";

const planRes = await fetch(`${BASE_URL}/api/agi/plan`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ goal: GOAL, personaId: PERSONA_ID, desktopId: DESKTOP_ID }),
});
if (!planRes.ok) {
  console.error("plan error", planRes.status, await planRes.text());
  process.exit(1);
}
const plan = await planRes.json();
console.log("Plan kinds:", (plan.plan_steps ?? []).map((s) => s.kind ?? s.action ?? s.tool ?? s.id));
console.log("TraceId:", plan.traceId);
if (!Array.isArray(plan.plan_steps) || plan.plan_steps.length === 0) {
  throw new Error("Planner returned no steps.");
}

const execRes = await fetch(`${BASE_URL}/api/agi/execute`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ traceId: plan.traceId }),
});
if (!execRes.ok) {
  console.error("execute error", execRes.status, await execRes.text());
  process.exit(1);
}
const exec = await execRes.json();
console.log("Execute steps:", (exec.steps ?? []).map((s) => s.kind ?? s.tool ?? s.id));

const debateStep =
  (exec.steps ?? []).find(
    (s) =>
      s.kind === "debate.run" ||
      s.kind === "debate.start" ||
      s.kind === "debate.consume" ||
      s.tool === "debate.run" ||
      (s.output && (s.output.debateId || s.output.debate_id)),
  ) ?? null;
const debateId =
  debateStep?.output?.debateId ??
  debateStep?.output?.debate_id ??
  exec.debate_id ??
  exec.debateId ??
  exec.task_trace?.debate_id ??
  null;
console.log("DebateId (if any):", debateId);
if (debateStep?.output?.verdict) {
  console.log("Debate verdict:", debateStep.output.verdict, debateStep.output.confidence);
}
