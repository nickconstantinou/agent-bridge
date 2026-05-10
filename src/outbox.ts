/**
 * A simple outbox queue to serialize outgoing Telegram messages per chat.
 */
export function createTelegramOutbox({ minIntervalMs = 1100 }: { minIntervalMs?: number } = {}) {
  const queues = new Map<number, Promise<any>>();

  return {
    async send(chatId: number, body: any, sendFn: (message: any) => Promise<any>): Promise<any> {
      const current = queues.get(chatId) || Promise.resolve();

      const next = current
        .catch(() => {
          /* absorb previous failure to allow next message */
        })
        .then(async () => {
          const start = Date.now();
          try {
            return await sendFn(body);
          } finally {
            const elapsed = Date.now() - start;
            const remaining = minIntervalMs - elapsed;
            if (remaining > 0) {
              await new Promise((resolve) => setTimeout(resolve, remaining));
            }
          }
        })
        .catch(async (error: any) => {
          // If we hit a rate limit, the sendFn should have handled it or thrown.
          // If it reached here, it's a real failure.
          // BUT if it has a retryAfter, we should wait.
          if (error.retryAfter) {
            await new Promise((resolve) => setTimeout(resolve, error.retryAfter * 1000));
          }
          throw error;
        });

      queues.set(chatId, next);
      return next;
    },
  };
}
