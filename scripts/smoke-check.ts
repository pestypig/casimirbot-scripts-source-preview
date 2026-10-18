const baseUrl = (process.env.SMOKE_BASE_URL ?? "http://localhost:5000").replace(/\/+$/, "");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? "10000");
const enableAskCheck = process.env.SMOKE_HELIX_ASK === "1";

const withTimeout = async (input: RequestInfo, init?: RequestInit) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const expectOk = async (path: string) => {
  const url = `${baseUrl}${path}`;
  const res = await withTimeout(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res;
};

const checkHelixAsk = async () => {
  const url = `${baseUrl}/api/agi/ask`;
  const payload = {
    question: "Smoke test: respond with ok.",
    sessionId: "smoke:session",
  };
  const res = await withTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`/api/agi/ask failed (${res.status}): ${text.slice(0, 200)}`);
  }
};

const run = async () => {
  await expectOk("/healthz");
  await expectOk("/version");
  if (enableAskCheck) {
    await checkHelixAsk();
  }
  // eslint-disable-next-line no-console
  console.log("smoke-check: ok");
};

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("smoke-check: failed", error);
  process.exit(1);
});
