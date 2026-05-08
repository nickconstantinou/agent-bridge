export function createTelegramMessageProgress({ minEditIntervalMs = 1000 } = {}) {
  let queued = null;
  let timer = null;
  let inFlight = Promise.resolve();

  const scheduleFlush = () => {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      inFlight = inFlight.then(async () => {
        if (!queued) return;
        const payload = queued;
        queued = null;
        await payload.send(payload.body);
      });
      await inFlight;
      if (queued) scheduleFlush();
    }, minEditIntervalMs);
    timer.unref?.();
  };

  return {
    update(body, send) {
      queued = { body, send };
      scheduleFlush();
      return inFlight;
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      inFlight = inFlight.then(async () => {
        if (!queued) return;
        const payload = queued;
        queued = null;
        await payload.send(payload.body);
      });
      await inFlight;
    },
  };
}
