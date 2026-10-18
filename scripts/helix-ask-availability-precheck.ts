type HelixAskAvailabilityProbe = {
  ok: boolean;
  status: number;
  message: string;
  failReason?: string;
  lastError?: string;
};

type HelixAskAvailabilityOptions = {
  baseUrl: string;
  timeoutMs?: number;
  label?: string;
  fetchImpl?: typeof fetch;
};

const toCleanText = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export const probeHelixAskAvailability = async (
  options: HelixAskAvailabilityOptions,
): Promise<HelixAskAvailabilityProbe> => {
  const {
    baseUrl,
    timeoutMs = 10000,
    fetchImpl = fetch,
  } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Use a lightweight service-health probe first to avoid false negatives from
    // full /api/agi/ask generation under transient load.
    try {
      const healthResponse = await fetchImpl(new URL("/api/helix/pipeline", baseUrl), {
        method: "GET",
        signal: controller.signal,
      });
      if (healthResponse.ok) {
        return {
          ok: true,
          status: healthResponse.status,
          message: "pipeline_health_ok",
        };
      }
    } catch {
      // fall through to ask-endpoint probe
    }

    const response = await fetchImpl(new URL("/api/agi/ask", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "health check",
        debug: true,
        temperature: 0,
        sessionId: "helix-ask-availability-precheck",
      }),
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? (await response.json().catch(() => ({}))) as Record<string, unknown>
      : {};
    const failReason = toCleanText(payload.fail_reason) || toCleanText(payload.error);
    const debug = payload.debug as Record<string, unknown> | undefined;
    const lastError = toCleanText(debug?.last_error);
    const message =
      failReason ||
      lastError ||
      toCleanText(payload.message) ||
      `status_${response.status}`;
    return {
      ok: response.status === 200,
      status: response.status,
      message,
      failReason: failReason || undefined,
      lastError: lastError || undefined,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "request_failed";
    return {
      ok: false,
      status: 0,
      message,
    };
  } finally {
    clearTimeout(timeout);
  }
};

export const precheckHelixAskAvailability = async (
  options: HelixAskAvailabilityOptions,
): Promise<void> => {
  const probe = await probeHelixAskAvailability(options);
  if (probe.ok) {
    return;
  }
  const label = options.label ? `${options.label}: ` : "";
  const failReason = probe.failReason ? ` fail_reason=${probe.failReason}` : "";
  const lastError = probe.lastError ? ` last_error=${probe.lastError}` : "";
  throw new Error(
    `${label}Helix Ask unavailable (status=${probe.status}, reason=${probe.message})${failReason}${lastError}`,
  );
};

