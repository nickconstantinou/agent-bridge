import { describe, expect, it } from "vitest";
import {
  createPollErrorState,
  planPollError,
  notePollSuccess,
} from "../src/polling.js";

function http409(): Error {
  const err = new Error("Telegram HTTP 409: Conflict") as any;
  err.status = 409;
  err.data = { ok: false, error_code: 409, description: "Conflict" };
  return err;
}

function networkErr(): Error {
  return new Error("fetch failed: ECONNRESET");
}

describe("planPollError — 409 polling conflicts", () => {
  it("logs a single warn on the first 409 with no stack and a 5s backoff", () => {
    const state = createPollErrorState();
    const plan = planPollError(http409(), state, 1000);
    expect(plan.logKind).toBe("warn-once");
    expect(plan.message).toMatch(/polling conflict/i);
    expect(plan.sleepMs).toBe(5_000);
    expect(state.in409Mode).toBe(true);
    expect(state.consecutive409).toBe(1);
  });

  it("suppresses subsequent 409 logs and applies exponential backoff up to 60s", () => {
    const state = createPollErrorState();
    const sleeps = [];
    for (let i = 0; i < 6; i += 1) {
      const plan = planPollError(http409(), state, 1000);
      sleeps.push(plan.sleepMs);
      if (i === 0) expect(plan.logKind).toBe("warn-once");
      else expect(plan.logKind).toBe("warn-suppress");
    }
    expect(sleeps).toEqual([5_000, 10_000, 30_000, 60_000, 60_000, 60_000]);
  });
});

describe("planPollError — non-409 errors", () => {
  it("logs full stack and uses the supplied default sleep", () => {
    const state = createPollErrorState();
    const plan = planPollError(networkErr(), state, 5_000);
    expect(plan.logKind).toBe("error-stack");
    expect(plan.sleepMs).toBe(5_000);
    expect(state.in409Mode).toBe(false);
    expect(state.consecutive409).toBe(0);
  });

  it("a non-409 after 409s resets the consecutive counter", () => {
    const state = createPollErrorState();
    planPollError(http409(), state, 1000);
    planPollError(http409(), state, 1000);
    expect(state.consecutive409).toBe(2);
    planPollError(networkErr(), state, 5_000);
    expect(state.consecutive409).toBe(0);
    expect(state.in409Mode).toBe(false);
  });
});

describe("notePollSuccess", () => {
  it("returns true and resets state after recovering from 409 mode", () => {
    const state = createPollErrorState();
    planPollError(http409(), state, 1000);
    planPollError(http409(), state, 1000);
    expect(notePollSuccess(state)).toBe(true);
    expect(state.in409Mode).toBe(false);
    expect(state.consecutive409).toBe(0);
  });

  it("returns false when there was no prior 409 state", () => {
    const state = createPollErrorState();
    expect(notePollSuccess(state)).toBe(false);
  });
});
