import { describe, expect, it } from "vitest";
import { collectCompatibilityDiagnostics, formatCompatibilityDiagnostics } from "../src/compatibilityDiagnostics.js";

describe("compatibility diagnostics", () => {
  it("reports only alias names and source state, never configured values", () => {
    const env = {
      TELEGRAM_ALLOWED_USER_ID: "123456789",
      HEALTH_CLI_COMMAND: "/usr/bin/claude",
      GEMINI_PROJECT_DIR: "/srv/private-project",
      WORKER_CLI_CHAIN: "codex,claude",
    };

    const diagnostics = collectCompatibilityDiagnostics(env);

    expect(diagnostics).toEqual([
      { alias: "TELEGRAM_ALLOWED_USER_ID", canonical: "TELEGRAM_ALLOWED_USER_IDS", state: "selected" },
      { alias: "WORKER_CLI_CHAIN", canonical: "INTERACTIVE_CLI_CHAIN", state: "selected" },
      { alias: "HEALTH_CLI_COMMAND", canonical: "HEALTH_SUGGEST_COMMAND", state: "selected" },
      { alias: "GEMINI_PROJECT_DIR", canonical: "ANTIGRAVITY_PROJECT_DIR", state: "selected" },
    ]);

    const formatted = formatCompatibilityDiagnostics("test-surface", diagnostics);
    expect(formatted).toBe(
      '[compatibility] {"surface":"test-surface","aliases":[{"alias":"TELEGRAM_ALLOWED_USER_ID","canonical":"TELEGRAM_ALLOWED_USER_IDS","state":"selected"},{"alias":"WORKER_CLI_CHAIN","canonical":"INTERACTIVE_CLI_CHAIN","state":"selected"},{"alias":"HEALTH_CLI_COMMAND","canonical":"HEALTH_SUGGEST_COMMAND","state":"selected"},{"alias":"GEMINI_PROJECT_DIR","canonical":"ANTIGRAVITY_PROJECT_DIR","state":"selected"}]}',
    );
    expect(formatted).not.toContain("123456789");
    expect(formatted).not.toContain("private-project");
    expect(formatted).not.toContain("/usr/bin/claude");
    expect(formatted).not.toContain("codex,claude");
  });

  it("marks aliases shadowed when the canonical key is also present", () => {
    expect(collectCompatibilityDiagnostics({
      TELEGRAM_ALLOWED_USER_ID: "legacy",
      TELEGRAM_ALLOWED_USER_IDS: "canonical",
      HEALTH_CLI_BOT: "claude",
      HEALTH_SUGGEST_BOT: "claude",
      GEMINI_COMMAND: "agy",
      ANTIGRAVITY_COMMAND: "agy",
    })).toEqual([
      { alias: "TELEGRAM_ALLOWED_USER_ID", canonical: "TELEGRAM_ALLOWED_USER_IDS", state: "shadowed" },
      { alias: "HEALTH_CLI_BOT", canonical: "HEALTH_SUGGEST_BOT", state: "shadowed" },
      { alias: "GEMINI_COMMAND", canonical: "ANTIGRAVITY_COMMAND", state: "shadowed" },
    ]);
  });

  it("does not emit a diagnostic when no compatibility alias is present", () => {
    expect(collectCompatibilityDiagnostics({
      TELEGRAM_ALLOWED_USER_IDS: "canonical",
      INTERACTIVE_CLI_CHAIN: "codex,claude",
      HEALTH_SUGGEST_COMMAND: "claude",
      ANTIGRAVITY_COMMAND: "agy",
    })).toEqual([]);
  });
});
