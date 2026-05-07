export function createMemoryOutbox() {
  const queues = new Map();
  return {
    async send(chatId, message, sendFn) {
      const previous = queues.get(chatId) || Promise.resolve();
      let resolveNext;
      const next = new Promise((resolve) => {
        resolveNext = resolve;
      });
      queues.set(chatId, previous.then(() => next));
      await previous;
      try {
        return await sendFn(message);
      } finally {
        resolveNext();
        if (queues.get(chatId) === next) queues.delete(chatId);
      }
    },
  };
}

export function createTelegramOutbox({ minIntervalMs = 1100 } = {}) {
  const queues = new Map();
  const lastSentAt = new Map();

  async function waitForTurn(chatId) {
    const previous = queues.get(chatId) || Promise.resolve();
    let resolveNext;
    const next = new Promise((resolve) => {
      resolveNext = resolve;
    });
    queues.set(chatId, previous.then(() => next));
    await previous;

    const elapsed = Date.now() - (lastSentAt.get(chatId) || 0);
    if (elapsed < minIntervalMs) {
      await new Promise((resolve) => setTimeout(resolve, minIntervalMs - elapsed));
    }

    try {
      return;
    } finally {
      lastSentAt.set(chatId, Date.now());
      resolveNext();
      if (queues.get(chatId) === next) queues.delete(chatId);
    }
  }

  return {
    async send(chatId, message, sendFn) {
      await waitForTurn(chatId);
      try {
        return await sendFn(message);
      } catch (error) {
        const text = String(error?.message || error);
        const retryMatch = text.match(/retry_after[:= ]+(\d+)/i);
        if (retryMatch) {
          await new Promise((resolve) => setTimeout(resolve, Number(retryMatch[1]) * 1000));
          return sendFn(message);
        }
        throw error;
      }
    },
  };
}
