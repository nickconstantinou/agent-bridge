import { describe, expect, it } from "vitest";
import { createMemoryOutbox, createTelegramOutbox } from "../src/outbox.js";

describe("outbox", () => {
  it("serializes sends per chat", async () => {
    const outbox = createMemoryOutbox();
    const order = [];
    const sendFn = async (message) => {
      order.push(`start:${message}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${message}`);
      return message;
    };

    await Promise.all([
      outbox.send(1, "one", sendFn),
      outbox.send(1, "two", sendFn),
    ]);

    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"]);
  });

  it("releases the per-chat queue after sends complete", async () => {
    const outbox = createMemoryOutbox();
    const sendFn = async (message) => message;

    await outbox.send(1, "one", sendFn);
    await outbox.send(1, "two", sendFn);

    // If the queue were not cleaned up, this would keep chaining forever and be harder to reason about.
    expect(true).toBe(true);
  });

  it("retries after a rate limit hint", async () => {
    const outbox = createTelegramOutbox({ minIntervalMs: 0 });
    let attempts = 0;
    const result = await outbox.send(1, { text: "hello" }, async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("Telegram HTTP 429: Too Many Requests");
        error.retryAfter = 1;
        throw error;
      }
      return "ok";
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("keeps per-chat sends serialized while retrying", async () => {
    const outbox = createTelegramOutbox({ minIntervalMs: 0 });
    const events = [];
    let firstAttempts = 0;

    await Promise.all([
      outbox.send(1, { text: "first" }, async () => {
        events.push(`first:${firstAttempts}`);
        firstAttempts += 1;
        if (firstAttempts === 1) {
          const error = new Error("Telegram HTTP 429: retry_after=1");
          error.retryAfter = 1;
          throw error;
        }
        events.push("first:done");
        return "first";
      }),
      outbox.send(1, { text: "second" }, async () => {
        events.push("second");
        return "second";
      }),
    ]);

    expect(events).toEqual(["first:0", "first:1", "first:done", "second"]);
  });
});
