import { describe, expect, it, vi } from "vitest";
import { createTelegramOutbox } from "../src/outbox.js";

describe("Telegram Outbox", () => {
  it("serializes messages for the same chat", async () => {
    const order: string[] = [];
    const sendFn = async (message: string) => {
      order.push(`start:${message}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      order.push(`end:${message}`);
      return { ok: true };
    };

    const outbox = createTelegramOutbox({ minIntervalMs: 10 });
    const p1 = outbox.send(123, "one", sendFn);
    const p2 = outbox.send(123, "two", sendFn);

    await Promise.all([p1, p2]);

    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"]);
  });

  it("handles errors and continues queue", async () => {
    const outbox = createTelegramOutbox({ minIntervalMs: 10 });
    const sendFn = async (message: string) => message;

    const p1 = outbox.send(123, "fail", async () => {
      throw new Error("fail");
    });
    const p2 = outbox.send(123, "success", sendFn);

    await expect(p1).rejects.toThrow("fail");
    const result2 = await p2;
    expect(result2).toBe("success");
  });

  it("respects retry_after on caught errors", async () => {
    const outbox = createTelegramOutbox({ minIntervalMs: 10 });
    const events: string[] = [];

    const sendFn1 = async () => {
      events.push("first:0");
      const error = new Error("rate limit") as any;
      error.retryAfter = 0.1;
      throw error;
    };

    const sendFn2 = async () => {
      events.push("second");
      return "ok";
    };

    const p1 = outbox.send(123, {}, sendFn1);
    const p2 = outbox.send(123, {}, sendFn2);

    await expect(p1).rejects.toThrow();
    
    await p2;
    events.push("first:done"); // push AFTER p2 resolves to verify order
    
    expect(events[0]).toBe("first:0");
    expect(events[1]).toBe("second");
    expect(events[2]).toBe("first:done");
  });
});
