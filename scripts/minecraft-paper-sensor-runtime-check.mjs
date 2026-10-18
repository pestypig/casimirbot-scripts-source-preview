import { fileURLToPath } from "node:url";

export function buildLoopbackCertificate(input) {
  const startedAt = input.startedAt ?? Date.now();
  const status = input.status ?? {};
  const pluginLoaded = Boolean(input.pluginLoaded);
  const readOnlyProbeCompleted = status.read_only_probe_result_count > 0 ||
    (status.probe_result_count > 0 &&
      status.latest_probe_result?.status !== "blocked_by_policy" &&
      status.latest_probe_result?.side_effects_performed === false &&
      status.latest_probe_result?.world_mutation_performed === false);
  const forbiddenProbeBlocked = input.forbiddenProbeBlocked === true ||
    status.forbidden_probe_block_count > 0 ||
    status.latest_probe_result?.status === "blocked_by_policy" ||
    status.forbidden_probe_delivered === false;
  const cert = {
    schema: "helix.paper_sensor_loopback_certificate.v1",
    ok: pluginLoaded &&
      status.manifest_count > 0 &&
      status.heartbeat_count > 0 &&
      status.snapshot_event_count > 0 &&
      readOnlyProbeCompleted &&
      forbiddenProbeBlocked &&
      status.raw_nbt_seen === false &&
      status.side_effects_seen === false,
    plugin_loaded: pluginLoaded,
    manifest_received: status.manifest_count > 0,
    heartbeat_received: status.heartbeat_count > 0,
    snapshot_received: status.snapshot_event_count > 0,
    read_only_probe_completed: readOnlyProbeCompleted,
    forbidden_probe_blocked: forbiddenProbeBlocked,
    raw_nbt_seen: Boolean(status.raw_nbt_seen),
    side_effects_seen: Boolean(status.side_effects_seen),
    duration_ms: Math.max(0, Date.now() - startedAt),
    evidence_refs: input.evidenceRefs ?? [],
    created_at: new Date().toISOString(),
  };
  return cert;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = await new Promise((resolve) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => body += chunk);
    process.stdin.on("end", () => resolve(body));
  });
  const input = text.trim() ? JSON.parse(text) : {};
  console.log(JSON.stringify(buildLoopbackCertificate(input), null, 2));
}
