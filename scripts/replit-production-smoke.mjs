#!/usr/bin/env node

import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { verifyReplitBuildMeta } from "./replit-build-meta.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = Math.max(10_000, Number(process.env.REPLIT_PRODUCTION_SMOKE_TIMEOUT_MS ?? 240_000));
const maxLogCharacters = 80_000;

const getFreePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

const sanitizeEnvironment = (port) => {
  const env = { ...process.env };
  for (const key of [
    "OPENAI_API_KEY",
    "LLM_HTTP_API_KEY",
    "ELEVENLABS_API_KEY",
    "DATABASE_URL",
    "PGDATABASE",
    "PGHOST",
    "PGPASSWORD",
    "PGPORT",
    "PGUSER",
    "DEFAULT_OBJECT_STORAGE_BUCKET_ID",
    "PUBLIC_OBJECT_SEARCH_PATHS",
    "PRIVATE_OBJECT_DIR",
    "LLM_LOCAL_INDEX_OBJECT_KEY",
    "LLM_LOCAL_MODEL_OBJECT_KEY",
    "LLM_LOCAL_LORA_OBJECT_KEY",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    PORT: String(port),
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    SKIP_VITE_MIDDLEWARE: "1",
    FAST_BOOT: "0",
    HEALTH_READY_ON_LISTEN: "1",
    // Keep bootstrap closed briefly so the smoke test can verify `/` answers
    // liveness as soon as the listener binds, before the full API is ready.
    BOOTSTRAP_DELAY_MS: "3000",
    REPLIT_DEPLOYMENT: "1",
    DEPLOYMENT: "1",
    CASIMIR_PUBLIC_SITE_ONLY: "1",
    CASIMIR_MANAGED_AI_DEVICE_LINKS: "1",
    CASIMIR_RESEARCH_MCP: "1",
    ENABLE_AGI: "1",
    ENABLE_ESSENCE: "1",
    HELIX_ASK_GOLDEN_PATH_RUNTIME: "0",
    LLM_POLICY: "http",
    LLM_RUNTIME: "http",
    DATABASE_URL: "pg-mem://replit-production-smoke",
    LLM_LOCAL_STOP_FLAG: "1",
    NOISEGEN_STORAGE_BACKEND: "memory",
    HELIX_BUILD_META_PATH: "dist/build-meta.json",
    CASIMIR_PUBLIC_BASE_URL: "https://casimirbot.com",
    HELIX_AGENT_OAUTH_ISSUER: "https://auth.example.invalid",
    HELIX_AGENT_OAUTH_AUDIENCE: "https://casimirbot.com/mcp",
    HELIX_AGENT_OAUTH_PROVIDER: "production-smoke",
    HELIX_AGENT_OAUTH_JWKS_URL:
      "https://auth.example.invalid/.well-known/jwks.json",
    HELIX_AGENT_ALLOWED_HOSTS: `127.0.0.1:${port}`,
    TRUST_PROXY: "loopback",
  };
};

const fetchWithTimeout = async (url, init = {}, requestTimeoutMs = 15_000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const readJson = async (baseUrl, pathname, init = {}) => {
  const response = await fetchWithTimeout(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}: ${text.slice(0, 800)}`);
  return JSON.parse(text);
};

const readJsonWithExactHost = async (baseUrl, pathname, headers = {}) => {
  const target = new URL(pathname, baseUrl);
  return await new Promise((resolve, reject) => {
    const request = http.request(target, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new Error(`${pathname} returned HTTP ${status}: ${text.slice(0, 800)}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(15_000, () => {
      request.destroy(new Error(`${pathname} timed out`));
    });
    request.once("error", reject);
    request.end();
  });
};

const waitForFingerprint = async ({ baseUrl, child, logs }) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`compiled server stopped with code ${child.exitCode}, signal ${child.signalCode}\n${logs.value.slice(-12_000)}`);
    }
    try {
      return await readJson(baseUrl, "/api/agi/runtime-parity/fingerprint");
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`compiled server did not become ready: ${String(lastError)}\n${logs.value.slice(-12_000)}`);
};

const waitForRootLiveness = async ({ baseUrl, child, logs }) => {
  // The publish builder can be much slower than the editor workspace while
  // loading the compiled server. Use the smoke test's bounded startup budget.
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`compiled server stopped before root liveness with code ${child.exitCode}, signal ${child.signalCode}\n${logs.value.slice(-12_000)}`);
    }
    try {
      const response = await fetchWithTimeout(`${baseUrl}/`, {
        headers: {
          Accept: "*/*",
          "User-Agent": "Go-http-client/1.1",
        },
      }, 2_000);
      const body = await response.text();
      assert(
        response.status === 200,
        `root liveness before bootstrap returned HTTP ${response.status}: ${body.slice(0, 240)}`,
      );
      assert(
        body.includes("Starting up...") && body.includes("/api/ready"),
        "root liveness did not return the startup shell while API readiness is pending",
      );
      return response.status;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("root liveness before bootstrap")) {
        throw error;
      }
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`root liveness did not become available within ${timeoutMs}ms before bootstrap: ${String(lastError)}\n${logs.value.slice(-12_000)}`);
};

const stopChild = async (child) => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const main = async () => {
  const metadataVerification = verifyReplitBuildMeta();
  if (!metadataVerification.ok) {
    throw new Error(`build metadata verification failed: ${metadataVerification.errors.join("; ")}`);
  }
  const meta = metadataVerification.meta;
  if (meta.git_authority?.strict === true) {
    assert(meta.git_authority?.verified === true, "strict build metadata is not Git-authority verified");
    assert(
      meta.git_authority?.worktree_clean_at_authority_check === true,
      "strict build metadata was not produced from a clean authoritative checkout",
    );
  }
  const port = await getFreePort();
  assert(typeof port === "number", "Failed to allocate a production smoke port.");
  const childEnvironment = sanitizeEnvironment(port);
  const logs = { value: "" };
  const child = spawn(process.execPath, ["--max-old-space-size=4096", "dist/index.js"], {
    cwd: repoRoot,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const appendLog = (chunk) => {
    logs.value = `${logs.value}${chunk.toString("utf8")}`.slice(-maxLogCharacters);
  };
  child.stdout.on("data", appendLog);
  child.stderr.on("data", appendLog);
  const baseUrl = `http://127.0.0.1:${port}`;
  const forwardedHttpsHeaders = {
    // Connect to the local compiled process while exercising the same
    // canonical Host/protocol identity that the public Replit edge forwards.
    // Leaving Host as 127.0.0.1 would intentionally select the separate
    // loopback-resource contract and make this public-route smoke ambiguous.
    "Host": "casimirbot.com",
    "X-Forwarded-Proto": "https",
  };

  try {
    const rootLiveness = await waitForRootLiveness({ baseUrl, child, logs });
    const fingerprint = await waitForFingerprint({ baseUrl, child, logs });
    const desktopResponse = await fetchWithTimeout(`${baseUrl}/desktop`);
    const desktopHtml = await desktopResponse.text();
    assert(desktopResponse.ok, `/desktop returned HTTP ${desktopResponse.status}`);
    assert(/<!doctype html/i.test(desktopHtml), "/desktop did not return the compiled client shell");
    assert(!/API routes are still mounting/i.test(desktopHtml), "/desktop returned the bootstrap fallback");

    let documentationMarkdown = "omitted_public_site_only";
    if (childEnvironment.CASIMIR_PUBLIC_SITE_ONLY !== "1") {
      const documentResponse = await fetchWithTimeout(`${baseUrl}/docs/helix-ask-flow.md`, {
        headers: { Accept: "text/markdown, text/plain" },
      });
      const documentText = await documentResponse.text();
      assert(documentResponse.ok, `/docs/helix-ask-flow.md returned HTTP ${documentResponse.status}`);
      assert(documentText.includes("# Helix Ask Flow"), "production Markdown route returned unexpected content");
      documentationMarkdown = documentResponse.status;
    }

    const researchConnectionResponse = await fetchWithTimeout(`${baseUrl}/connect/research`);
    const researchConnectionHtml = await researchConnectionResponse.text();
    assert(researchConnectionResponse.ok,
      `/connect/research returned HTTP ${researchConnectionResponse.status}`);
    assert(researchConnectionHtml.includes("/mcp/research"),
      "/connect/research did not advertise the research MCP endpoint");

    const researchUnauthenticated = await fetchWithTimeout(`${baseUrl}/mcp/research`, {
      method: "POST",
      headers: {
        ...forwardedHttpsHeaders,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "production-smoke-research-unauthenticated",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "casimir-replit-production-smoke", version: "1.0.0" },
        },
      }),
    });
    const researchUnauthenticatedBody = await researchUnauthenticated.text();
    assert(researchUnauthenticated.status === 401,
      `/mcp/research unauthenticated initialize returned HTTP ${researchUnauthenticated.status}`);
    assert(researchUnauthenticatedBody.includes("research_client_grant_required"),
      "/mcp/research did not fail closed on a missing client grant");

    const agentAccessResponse = await fetchWithTimeout(`${baseUrl}/agent-access`);
    const agentAccessHtml = await agentAccessResponse.text();
    assert(agentAccessResponse.ok, `/agent-access returned HTTP ${agentAccessResponse.status}`);
    assert(
      agentAccessResponse.headers.get("content-type")?.includes("text/html"),
      "/agent-access did not return HTML",
    );
    assert(
      agentAccessHtml.includes("https://casimirbot.com/mcp"),
      "/agent-access did not advertise the canonical MCP endpoint",
    );
    assert(
      agentAccessHtml.includes("retrieval") && agentAccessHtml.includes("connection"),
      "/agent-access did not distinguish retrieval from an MCP connection",
    );

    const agentAccessManifest = await readJson(baseUrl, "/agent-access.json");
    assert(
      agentAccessManifest.metadata_kind === "casimirbot.agent_access" &&
        agentAccessManifest.metadata_version === "1",
      "/agent-access.json returned an unexpected metadata contract",
    );
    assert(
      agentAccessManifest.mcp?.url === "https://casimirbot.com/mcp",
      "/agent-access.json returned an unexpected MCP URL",
    );
    assert(
      agentAccessManifest.connection?.explicit_configuration_required === true,
      "/agent-access.json did not declare the explicit connection requirement",
    );

    const robotsResponse = await fetchWithTimeout(`${baseUrl}/robots.txt`);
    const robotsText = await robotsResponse.text();
    assert(robotsResponse.ok, `/robots.txt returned HTTP ${robotsResponse.status}`);
    assert(
      robotsResponse.headers.get("content-type")?.includes("text/plain"),
      "/robots.txt did not return text/plain",
    );
    assert(robotsText.includes("Sitemap: https://casimirbot.com/sitemap.xml"), "/robots.txt omitted the sitemap");

    const sitemapResponse = await fetchWithTimeout(`${baseUrl}/sitemap.xml`);
    const sitemapText = await sitemapResponse.text();
    assert(sitemapResponse.ok, `/sitemap.xml returned HTTP ${sitemapResponse.status}`);
    assert(
      sitemapResponse.headers.get("content-type")?.includes("xml"),
      "/sitemap.xml did not return XML",
    );
    assert(
      sitemapText.includes("<loc>https://casimirbot.com/agent-access</loc>"),
      "/sitemap.xml omitted /agent-access",
    );

    const protectedResource = await readJsonWithExactHost(
      baseUrl,
      "/.well-known/oauth-protected-resource/mcp",
      forwardedHttpsHeaders,
    );
    assert(
      protectedResource.resource === "https://casimirbot.com/mcp",
      `OAuth protected-resource metadata returned an unexpected resource: ${JSON.stringify(protectedResource.resource)}`,
    );
    assert(
      protectedResource.authorization_servers?.[0] === "https://auth.example.invalid",
      "OAuth protected-resource metadata returned an unexpected authorization server",
    );

    const deviceCheckProtectedResource = await readJsonWithExactHost(
      baseUrl,
      "/.well-known/oauth-protected-resource/mcp/device-check",
      forwardedHttpsHeaders,
    );
    assert(
      deviceCheckProtectedResource.resource === "https://casimirbot.com/mcp",
      "Device Check protected-resource metadata returned an unexpected resource",
    );
    assert(
      deviceCheckProtectedResource.authorization_servers?.[0] ===
        "https://auth.example.invalid",
      "Device Check protected-resource metadata returned an unexpected authorization server",
    );
    assert(
      deviceCheckProtectedResource.scopes_supported?.includes("helix.rooms.read"),
      "Device Check protected-resource metadata omitted its least read scope",
    );

    const coordinationProtectedResource = await readJsonWithExactHost(
      baseUrl,
      "/.well-known/oauth-protected-resource/mcp/local-supervisor-coordination",
      forwardedHttpsHeaders,
    );
    assert(
      coordinationProtectedResource.resource === "https://casimirbot.com/mcp",
      "Coordination protected-resource metadata returned an unexpected resource",
    );
    assert(
      coordinationProtectedResource.authorization_servers?.[0] ===
        "https://auth.example.invalid",
      "Coordination protected-resource metadata returned an unexpected authorization server",
    );
    for (const scope of [
      "helix.rooms.read",
      "helix.rooms.manage",
      "helix.desktop.tunnel.transition.request",
      "helix.desktop.tunnel.transition.execute",
    ]) {
      assert(
        coordinationProtectedResource.scopes_supported?.includes(scope),
        `Coordination protected-resource metadata omitted ${scope}`,
      );
    }

    const initializeResponse = await fetchWithTimeout(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...forwardedHttpsHeaders,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "production-smoke-initialize",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {
            name: "casimir-replit-production-smoke",
            version: "1.0.0",
          },
        },
      }),
    });
    const initializeText = await initializeResponse.text();
    assert(
      initializeResponse.status === 401,
      `/mcp unauthenticated initialize returned HTTP ${initializeResponse.status}: ${initializeText.slice(0, 800)}`,
    );
    assert(
      initializeResponse.headers.get("www-authenticate")?.includes("resource_metadata="),
      "/mcp unauthenticated initialize omitted the OAuth resource-metadata challenge",
    );
    assert(
      !initializeResponse.headers.get("content-type")?.includes("text/html"),
      "/mcp unauthenticated initialize fell through to the compiled client shell",
    );

    const restResponse = await fetchWithTimeout(`${baseUrl}/api/v1/agent-runs`, {
      headers: forwardedHttpsHeaders,
    });
    const restText = await restResponse.text();
    assert(
      restResponse.status === 401,
      `/api/v1/agent-runs unauthenticated request returned HTTP ${restResponse.status}: ${restText.slice(0, 800)}`,
    );
    assert(
      restResponse.headers.get("www-authenticate")?.includes("resource_metadata="),
      "/api/v1/agent-runs omitted the OAuth resource-metadata challenge",
    );

    const session = await readJson(baseUrl, "/api/account/session");
    const pipeline = await readJson(baseUrl, "/api/helix/pipeline");
    assert(fingerprint.build?.execution_mode === "compiled_production", "fingerprint is not compiled_production");
    assert(
      fingerprint.build?.source_commit === meta.source.commit,
      `runtime commit ${String(fingerprint.build?.source_commit)} does not match build ${meta.source.commit}`,
    );
    assert(
      fingerprint.build?.server_bundle_commit === meta.source.commit,
      "running server bundle commit marker does not match build metadata",
    );
    assert(
      fingerprint.build?.client_bundle_build_id === meta.source.build_id,
      "compiled client build id does not match build metadata",
    );
    assert(
      fingerprint.build?.artifact_contract_sha256 === meta.artifact_contract_sha256,
      "runtime artifact contract does not match dist/build-meta.json",
    );
    assert(
      fingerprint.build?.client_tree_sha256 === meta.artifacts.client_tree.sha256,
      "runtime client tree fingerprint does not match dist/build-meta.json",
    );

    const result = {
      schema: "casimir.replit_production_smoke.v1",
      ok: true,
      source_commit: meta.source.commit,
      artifact_contract_sha256: meta.artifact_contract_sha256,
      experience_contract_sha256: fingerprint.experience_contract_sha256,
      deployment_contract_sha256: fingerprint.deployment_contract_sha256,
      git_authority: meta.git_authority,
      endpoints: {
        root_liveness_before_bootstrap: rootLiveness,
        desktop: desktopResponse.status,
        documentation_markdown: documentationMarkdown,
        research_connection: researchConnectionResponse.status,
        research_mcp_unauthenticated: researchUnauthenticated.status,
        agent_access: agentAccessResponse.status,
        agent_access_manifest: 200,
        robots: robotsResponse.status,
        sitemap: sitemapResponse.status,
        oauth_protected_resource: 200,
        oauth_device_check_protected_resource: 200,
        oauth_coordination_protected_resource: 200,
        mcp_unauthenticated: initializeResponse.status,
        agent_runs_unauthenticated: restResponse.status,
        account_session: session.ok === false ? "response_error" : 200,
        helix_pipeline: pipeline.ok === false ? "response_error" : 200,
        runtime_parity_fingerprint: 200,
      },
      secrets_injected: false,
    };
    const outputDirectory = path.resolve(
      repoRoot,
      process.env.REPLIT_PRODUCTION_SMOKE_OUT ?? "artifacts/replit-production-smoke",
    );
    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.writeFile(path.join(outputDirectory, "latest.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`[replit] production smoke passed: commit=${result.source_commit} contract=${result.artifact_contract_sha256}`);
  } finally {
    await stopChild(child);
  }
};

main().catch((error) => {
  console.error(`[replit] production smoke failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
