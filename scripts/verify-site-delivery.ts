import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { once } from "node:events";
import express from "express";
import { serveStatic, serveStaticAssets } from "../server/static";

const repoRoot = path.resolve(import.meta.dirname, "..");
assert.ok(existsSync(path.join(repoRoot, "dist/site/index.html")),
  "Build the separate public site before verifying its delivery");

const previous = {
  NODE_ENV: process.env.NODE_ENV,
  CASIMIR_PUBLIC_SITE_ONLY: process.env.CASIMIR_PUBLIC_SITE_ONLY,
  CASIMIR_DESKTOP_HOST: process.env.CASIMIR_DESKTOP_HOST,
};
process.env.NODE_ENV = "production";
process.env.CASIMIR_PUBLIC_SITE_ONLY = "1";
delete process.env.CASIMIR_DESKTOP_HOST;

const app = express();
serveStaticAssets(app);
serveStatic(app);
const server = app.listen(0, "127.0.0.1");

try {
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const root = await fetch(base);
  assert.equal(root.status, 200);
  const html = await root.text();
  assert.match(html, /<title>CasimirBot<\/title>/u);
  assert.doesNotMatch(html, /\/src\/main\.tsx|warp-engine\.js|Starting Helix/u);

  const asset = html.match(/src="(\/assets\/[^"\s]+\.js)"/u)?.[1];
  assert.ok(asset, "The site entry must point to its own compiled asset");
  const script = await fetch(`${base}${asset}`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") ?? "", /javascript/u);

  for (const route of ["/desktop", "/agent-access", "/docs/private.md"]) {
    const response = await fetch(`${base}${route}`, { redirect: "manual" });
    assert.equal(response.status, 302, `${route} must not serve a workstation page`);
    assert.equal(response.headers.get("location"), "/");
  }
  console.log("Public site delivery: standalone entry and asset served; workstation routes redirected.");
} finally {
  if (server.listening)
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
