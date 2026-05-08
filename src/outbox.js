export function createMemoryOutbox() {
  const queues = new Map();
  return {
    async send(chatId, message, sendFn) {
      const previous = queues.get(chatId) || Promise.resolve();
      const current = previous.then(() => sendFn(message));
      queues.set(chatId, current.finally(() => {
        if (queues.get(chatId) === current) queues.delete(chatId);
      }));
      return current;
    },
  };
}

export function createTelegramOutbox({ minIntervalMs = 1100 } = {}) {
  const queues = new Map();
  const lastSentAt = new Map();

  return {
    async send(chatId, message, sendFn) {
      const previous = queues.get(chatId) || Promise.resolve();
      const current = previous.then(async () => {
        const elapsed = Date.now() - (lastSentAt.get(chatId) || 0);
        if (elapsed < minIntervalMs) {
          await new Promise((resolve) => setTimeout(resolve, minIntervalMs - elapsed));
        }

        for (;;) {
          try {
            const result = await sendFn(message);
            lastSentAt.set(chatId, Date.now());
            return result;
          } catch (error) {
            const retryAfter = Number(error?.retryAfter ?? error?.data?.parameters?.retry_after ?? error?.data?.retry_after);
            const text = String(error?.message || error);
            const retryMatch = text.match(/retry_after[:= ]+(\d+)/i);
            const waitSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : retryMatch ? Number(retryMatch[1]) : null;
            if (!waitSeconds) throw error;
            await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
          }
        }
      }).finally(() => {
        if (queues.get(chatId) === current) queues.delete(chatId);
      });
      queues.set(chatId, current);
      return current;
    },
  };
}
