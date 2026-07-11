import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("advisor installer defaults", () => {
  it("aligns repository examples and generated systemd shared defaults", () => {
    const example = readFileSync(".env.shared.example", "utf8");
    const installer = readFileSync("scripts/install.sh", "utf8");

    for (const line of [
      "BRIDGE_ADVISOR_ENABLED=true",
      "BRIDGE_ADVISOR_MODE=manual",
      "BRIDGE_ADVISOR_CHAIN=claude:claude-fable-5,codex:gpt-5.6-sol",
      "BRIDGE_ADVISOR_MAX_CALLS_PER_TURN=1",
      "BRIDGE_ADVISOR_MAX_CALLS_PER_TASK=2",
    ]) {
      expect(example).toContain(line);
    }
    for (const key of [
      "BRIDGE_ADVISOR_ENABLED",
      "BRIDGE_ADVISOR_MODE",
      "BRIDGE_ADVISOR_CHAIN",
      "BRIDGE_ADVISOR_MAX_CALLS_PER_TURN",
      "BRIDGE_ADVISOR_MAX_CALLS_PER_TASK",
      "BRIDGE_ADVISOR_TIMEOUT_MS",
      "BRIDGE_ADVISOR_CONTEXT_MAX_CHARS",
    ]) {
      expect(installer).toContain(`echo "${key}=\${${key}`);
    }
  });
});
