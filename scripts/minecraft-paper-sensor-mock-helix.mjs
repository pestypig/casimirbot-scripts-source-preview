import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const json = (res, status, body) => {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});

const safeParse = (text) => {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
};

const containsRawNbt = (value) => JSON.stringify(value).toLowerCase().includes("raw_nbt") &&
  !JSON.stringify(value).includes('"raw_nbt_included":false');

const containsSideEffect = (value) => JSON.stringify(value).includes('"side_effects_performed":true') ||
  JSON.stringify(value).includes('"world_mutation_performed":true');

export function createMockHelixServer(options = {}) {
  const token = options.token ?? process.env.HELIX_MOCK_TOKEN ?? "replace-me";
  const pendingProbes = [];
  const state = {
    manifest_count: 0,
    heartbeat_count: 0,
    snapshot_batch_count: 0,
    snapshot_event_count: 0,
    probe_poll_count: 0,
    probe_result_count: 0,
    read_only_probe_result_count: 0,
    forbidden_probe_block_count: 0,
    latest_manifest: null,
    latest_heartbeat: null,
    latest_snapshot: null,
    latest_probe_result: null,
    rejected_payloads: [],
    auth_failures: 0,
    raw_nbt_seen: false,
    side_effects_seen: false,
    forbidden_probe_delivered: false,
  };

  const authorize = (req) => {
    if (!token || token === "replace-me") return true;
    const header = req.headers.authorization ?? "";
    return header === `Bearer ${token}`;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/__helix_mock/status") {
      const latestSnapshot = state.latest_snapshot ?? {};
      return json(res, 200, {
        ...state,
        latest_snapshot_changed_sections: latestSnapshot.changed_sections ?? [],
        pending_probe_count: pendingProbes.length,
      });
    }
    if (req.method === "POST" && url.pathname === "/__helix_mock/probes") {
      const body = safeParse(await readBody(req));
      pendingProbes.push(body);
      return json(res, 200, { ok: true, pending_probe_count: pendingProbes.length });
    }
    if (!authorize(req)) {
      state.auth_failures++;
      return json(res, 403, { error: "forbidden" });
    }
    if (req.method === "POST" && url.pathname === "/api/agi/environment/sources/manifest") {
      const body = safeParse(await readBody(req));
      state.manifest_count++;
      state.latest_manifest = body;
      state.raw_nbt_seen ||= containsRawNbt(body);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/agi/environment/sources/heartbeat") {
      const body = safeParse(await readBody(req));
      state.heartbeat_count++;
      state.latest_heartbeat = body;
      state.raw_nbt_seen ||= containsRawNbt(body);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/agi/situation/world-event/batch") {
      const body = safeParse(await readBody(req));
      const events = Array.isArray(body.events) ? body.events : [];
      state.snapshot_batch_count++;
      state.snapshot_event_count += events.length;
      const snapshotEvent = events.find((event) => event?.event_type === "environment_state_snapshot") ?? events[0] ?? null;
      state.latest_snapshot = snapshotEvent?.meta?.snapshot ?? snapshotEvent;
      state.raw_nbt_seen ||= containsRawNbt(body);
      return json(res, 200, { ok: true });
    }
    const pendingMatch = url.pathname.match(/^\/api\/agi\/environment\/sources\/([^/]+)\/probes\/pending$/);
    if (req.method === "GET" && pendingMatch) {
      state.probe_poll_count++;
      const limit = Number(url.searchParams.get("limit") ?? "8");
      const probeRequests = pendingProbes.splice(0, Number.isFinite(limit) ? limit : 8);
      if (probeRequests.some((probe) => /place_block|break_block|move_actor|open_container|attack_entity|use_item|take_item/.test(String(probe.probe_type)))) {
        state.forbidden_probe_delivered = true;
      }
      return json(res, 200, { probe_requests: probeRequests });
    }
    const resultMatch = url.pathname.match(/^\/api\/agi\/environment\/sources\/([^/]+)\/probes\/result$/);
    if (req.method === "POST" && resultMatch) {
      const body = safeParse(await readBody(req));
      state.probe_result_count++;
      state.latest_probe_result = body;
      if (body.status === "blocked_by_policy") state.forbidden_probe_block_count++;
      else state.read_only_probe_result_count++;
      state.raw_nbt_seen ||= containsRawNbt(body);
      state.side_effects_seen ||= containsSideEffect(body);
      return json(res, 200, { ok: true });
    }
    const statusMatch = url.pathname.match(/^\/api\/agi\/environment\/sources\/([^/]+)\/status$/);
    if (req.method === "GET" && statusMatch) {
      return json(res, 200, {
        status: {
          source_id: decodeURIComponent(statusMatch[1]),
          availability: state.heartbeat_count > 0 ? "available" : "unavailable",
          manifest_count: state.manifest_count,
          heartbeat_count: state.heartbeat_count,
          snapshot_event_count: state.snapshot_event_count,
        },
      });
    }
    json(res, 404, { error: "not_found", request_id: randomUUID() });
  });

  return {
    state,
    pendingProbes,
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => {
          const address = server.address();
          resolve({ server, port: address.port, url: `http://127.0.0.1:${address.port}` });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mock = createMockHelixServer();
  const port = Number(process.env.PORT ?? process.argv[2] ?? "5055");
  const { url } = await mock.listen(port);
  console.log(JSON.stringify({ ok: true, url, status_url: `${url}/__helix_mock/status` }));
}
