import { afterEach, describe, expect, it } from "vitest";
import { buildCliInvocation } from "../src/cli.js";

const timeoutKeys = ["ANTIGRAVITY_CLI_TIMEOUT_MS", "CLI_TIMEOUT_MS"] as const;
const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of timeoutKeys) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("Antigravity disabled timeout contract", () => {
  it("does not pass a zero print timeout when hard timeout is disabled", () => {
    for (const key of timeoutKeys) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }

    const invocation = buildCliInvocation({
      bot: "antigravity",
      command: "agy",
      prompt: "answer briefly",
      sessionId: null,
    });

    expect(invocation.args).not.toContain("--print-timeout");
    expect(invocation.args).not.toContain("0s");
  });
});
