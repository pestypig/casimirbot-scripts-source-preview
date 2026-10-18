const DEFAULT_INTERVAL_MS = 15_000;

export const startSharedRoomPresenceHeartbeat = ({
  sendPresent,
  intervalMs = DEFAULT_INTERVAL_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  if (typeof sendPresent !== "function") {
    throw new Error("shared_room_presence_sender_required");
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 1) {
    throw new Error("shared_room_presence_interval_invalid");
  }

  let stopped = false;
  let timer = null;
  let inFlight = Promise.resolve();

  const schedule = () => {
    if (stopped) return;
    timer = setTimeoutFn(() => {
      timer = null;
      if (stopped) return;
      inFlight = Promise.resolve()
        .then(sendPresent)
        .catch(() => undefined)
        .finally(schedule);
    }, intervalMs);
  };

  schedule();
  return async () => {
    stopped = true;
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    await inFlight;
  };
};
