// Read-only deployment gate for the download-first domain. It never signs in,
// starts a trial, creates a device link, or invokes a provider.
const target = new URL(process.argv[2] ?? "https://casimirbot.com");
if ((target.protocol !== "https:" &&
    !(target.protocol === "http:" && ["localhost", "127.0.0.1"].includes(target.hostname))) ||
    target.pathname !== "/" || target.search || target.hash ||
    target.username || target.password) throw Error("expected_https_origin_or_local_loopback");
const origin = target.origin;

type Check = { name: string; ok: boolean; status?: number; detail?: string };
const checks: Check[] = [];
const get = async (name: string, route: string,
  inspect: (response: Response, body: string) => boolean,
  timeoutMs = 12_000): Promise<void> => {
  try {
    const response = await fetch(`${origin}${route}`, {
      redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: route.startsWith("/api/") ? "application/json" : "text/html" },
    });
    const body = (await response.text()).slice(0, 64_000);
    checks.push({ name, ok: inspect(response, body), status: response.status });
  } catch (error) {
    checks.push({ name, ok: false, detail: error instanceof Error ? error.name : "request_failed" });
  }
};
const html = (response: Response) => response.status === 200 &&
  (response.headers.get("content-type") ?? "").includes("text/html");
const json = (body: string): Record<string, unknown> => {
  try { return JSON.parse(body) as Record<string, unknown>; }
  catch { return {}; }
};

// A cold deployed service can take longer to answer its first request. Warm it
// once before checking seven independent routes so a cold start does not look
// like eight separate endpoint regressions.
await get("public landing", "/", (res, body) => html(res) &&
  body.includes("<title>CasimirBot</title>") && !body.includes("Opening workspace") &&
  !body.includes("Redirecting to"), 30_000);
await Promise.all([
  get("account page", "/account", res => html(res)),
  get("download page", "/download", res => html(res)),
  get("installation approval page", "/account/connect", res => html(res)),
  get("browser workspace closed", "/desktop", res => res.status === 302 &&
    res.headers.get("location") === "/"),
  get("release metadata", "/api/desktop-release/latest", (res, body) =>
    res.status === 200 && json(body).schemaVersion === "casimir_desktop_release_status/1"),
  get("managed status", "/api/managed-ai/status", (res, body) =>
    res.status === 200 && json(body).schema === "casimirbot.managed_ai_status.v1" &&
    json(body).available === false),
  get("device-link service", "/api/managed-ai/device-grants", (res, body) =>
    res.status === 401 && json(body).error === "verified_account_required"),
  ...(origin === "https://casimirbot.com" ? [
    get("Auth0 sign-in handoff", "/api/auth/auth0/start?return_to=%2Faccount", res => {
      const location = res.headers.get("location");
      if (res.status !== 302 || !location) return false;
      try {
        const next = new URL(location);
        return next.protocol === "https:" && next.pathname === "/authorize" &&
          !!next.searchParams.get("client_id") &&
          !!next.searchParams.get("state") &&
          !!next.searchParams.get("code_challenge") &&
          next.searchParams.get("code_challenge_method") === "S256" &&
          next.searchParams.get("redirect_uri") ===
            "https://casimirbot.com/api/auth/auth0/callback";
      } catch { return false; }
    }),
  ] : []),
]);
console.log(JSON.stringify({ schema: "casimirbot.domain_launch_readonly.v1", origin, checks,
  ok: checks.every(check => check.ok) }, null, 2));
if (checks.some(check => !check.ok)) process.exitCode = 1;
