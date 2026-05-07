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

  it("retries after a rate limit hint", async () => {
    const outbox = createTelegramOutbox({ minIntervalMs: 0 });
    let attempts = 0;
    const result = await outbox.send(1, { text: "hello" }, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Telegram HTTP 429: retry_after=1");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });
});
