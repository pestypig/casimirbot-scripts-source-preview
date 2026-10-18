import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createMockHelixServer } from "./minecraft-paper-sensor-mock-helix.mjs";
import { buildLoopbackCertificate } from "./minecraft-paper-sensor-runtime-check.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "minecraft", "helix-paper-sensor");
const sourceId = "source:minecraft-paper-plugin";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const useCmd = process.platform === "win32" && /\.bat$/i.test(command);
  const actualCommand = useCmd ? "cmd.exe" : command;
  const actualArgs = useCmd ? ["/d", "/s", "/c", command, ...args] : args;
  const child = spawn(actualCommand, actualArgs, { cwd: root, stdio: ["ignore", "pipe", "pipe"], ...options });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => stdout += chunk);
  child.stderr?.on("data", (chunk) => stderr += chunk);
  child.on("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} ${args.join(" ")} failed (${code})\n${stdout}\n${stderr}`)));
});

const fetchJson = async (url, init) => {
  const response = await fetch(url, init);
  const text = await response.text();
  return text ? JSON.parse(text) : {};
};

const enqueueProbe = (mockUrl, probe) => fetchJson(`${mockUrl}/__helix_mock/probes`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(probe),
});

const probeRequest = (probeType) => ({
  schema: "helix.environment_probe_request.v1",
  probe_request_id: `loopback:${probeType}:${Date.now()}`,
  source_id: sourceId,
  room_id: "room:minecraft",
  domain: "minecraft",
  domain_adapter: "minecraft.paper_plugin.v1",
  probe_type: probeType,
  reason: "contract_test",
  constraints: {
    read_only: true,
    side_effects_allowed: false,
    ttl_ms: 10000,
  },
  evidence_refs: ["loopback:probe"],
  assistant_answer: false,
  raw_content_included: false,
  context_policy: "compact_context_pack_only",
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 10000).toISOString(),
});

const waitFor = async (label, timeoutMs, fn) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await wait(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

async function main() {
  const startedAt = Date.now();
  const mock = createMockHelixServer({ token: "loopback-token" });
  const { url: mockUrl } = await mock.listen(0);
  let paper = null;
  let pluginLoaded = false;
  let paperOutput = "";
  let paperExitCode = null;
  try {
    const gradleWrapperJar = path.join(
      pluginDir,
      "gradle",
      "wrapper",
      "gradle-wrapper.jar",
    );
    await run(process.env.JAVA ?? "java", [
      "-classpath",
      gradleWrapperJar,
      "org.gradle.wrapper.GradleWrapperMain",
      "-p",
      pluginDir,
      "--no-daemon",
      "build",
    ]);
    const jar = path.join(pluginDir, "build", "libs", "HelixPaperSensor-0.2.0.jar");
    const paperJar = process.env.PAPER_SERVER_JAR;
    if (!paperJar) {
      const status = await fetchJson(`${mockUrl}/__helix_mock/status`);
      const cert = buildLoopbackCertificate({
        startedAt,
        status,
        pluginLoaded: false,
        evidenceRefs: ["loopback:paper_server_jar_missing"],
      });
      cert.ok = false;
      cert.message = "Set PAPER_SERVER_JAR to run the live Paper loopback.";
      console.log(JSON.stringify(cert, null, 2));
      return;
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "helix-paper-loopback-"));
    await fs.mkdir(path.join(tempDir, "plugins", "HelixPaperSensor"), { recursive: true });
    await fs.copyFile(jar, path.join(tempDir, "plugins", "HelixPaperSensor-0.2.0.jar"));
    await fs.writeFile(path.join(tempDir, "eula.txt"), "eula=true\n");
    await fs.writeFile(path.join(tempDir, "server.properties"), "online-mode=false\nlevel-name=loopback-world\nspawn-protection=0\n");
    await fs.writeFile(path.join(tempDir, "plugins", "HelixPaperSensor", "config.yml"), `helix:
  enabled: true
  endpoint: "${mockUrl}"
  bearer_token: "loopback-token"
  source_id: "${sourceId}"
  room_id: "room:minecraft"
  world_id: "minecraft:paper-loopback"
  domain_adapter: "minecraft.paper_plugin.v1"
  source_label: "Minecraft Paper Loopback"
  snapshot_interval_ticks: 40
  heartbeat_interval_ticks: 40
  probe_poll_interval_ticks: 20
  burst_interval_ticks: 20
  burst_duration_ticks: 80
  send_only_changed_sections: true
  include_section_hashes: true
  max_payload_bytes: 48000
  max_pending_uploads: 1
  sensor_scope_default: "player_observable"
  allow_privileged_container_scan: false
  allow_privileged_entity_scan: false
  privileged_state_requires_caveat: true
  read_only_probes_enabled: true
  max_pending_probes_per_poll: 8
  execution_enabled: false
snapshot:
  include_actor_state: true
  include_inventory_state: true
  include_focus: true
  include_nearby_entities: true
  include_open_container: true
  include_nearby_container_refs: true
  include_crops: true
  include_local_map: true
  nearby_entity_radius: 8
  crop_radius: 8
  local_map_radius: 4
  max_entities: 8
  max_crops: 8
  max_local_blocks: 32
  max_inventory_stacks: 64
probe:
  max_route_radius: 64
  max_probe_duration_ms: 250
  ttl_ms: 10000
`);
    paper = spawn(process.env.JAVA ?? "java", ["-jar", paperJar, "nogui"], { cwd: tempDir, stdio: ["pipe", "pipe", "pipe"] });
    paper.stdout.on("data", (chunk) => {
      const text = String(chunk);
      paperOutput += text;
      if (/HelixPaperSensor enabled in read-only mode/i.test(text)) pluginLoaded = true;
    });
    paper.stderr.on("data", (chunk) => {
      paperOutput += String(chunk);
    });
    paper.on("exit", (code) => {
      paperExitCode = code;
    });
    await waitFor("plugin load", 90000, () => {
      if (paperExitCode !== null) throw new Error(`Paper exited before plugin load: ${paperExitCode}`);
      return pluginLoaded;
    });
    await waitFor("manifest", 30000, () => mock.state.manifest_count > 0);
    await waitFor("heartbeat", 30000, () => mock.state.heartbeat_count > 0);
    await waitFor("snapshot", 45000, () => mock.state.snapshot_event_count > 0);
    await enqueueProbe(mockUrl, probeRequest("inventory_check"));
    await waitFor("read-only probe result", 30000, () => mock.state.probe_result_count > 0);
    await enqueueProbe(mockUrl, probeRequest("place_block"));
    await waitFor("forbidden probe block", 30000, () => mock.state.latest_probe_result?.status === "blocked_by_policy");
    const status = await fetchJson(`${mockUrl}/__helix_mock/status`);
    console.log(JSON.stringify(buildLoopbackCertificate({
      startedAt,
      status,
      pluginLoaded,
      forbiddenProbeBlocked: true,
      evidenceRefs: [`mock:${mockUrl}`, `jar:${jar}`],
    }), null, 2));
  } catch (error) {
    const status = await fetchJson(`${mockUrl}/__helix_mock/status`).catch(() => ({}));
    const cert = buildLoopbackCertificate({
      startedAt,
      status,
      pluginLoaded,
      evidenceRefs: ["loopback:runtime_error"],
    });
    cert.ok = false;
    cert.message = error instanceof Error ? error.message : String(error);
    cert.paper_exit_code = paperExitCode;
    cert.paper_output_tail = paperOutput.slice(-4000);
    console.log(JSON.stringify(cert, null, 2));
  } finally {
    if (paper) {
      paper.stdin.write("stop\n");
      await Promise.race([
        new Promise((resolve) => paper.on("exit", resolve)),
        wait(10000).then(() => paper.kill("SIGKILL")),
      ]);
    }
    await mock.close();
  }
}

await main();
