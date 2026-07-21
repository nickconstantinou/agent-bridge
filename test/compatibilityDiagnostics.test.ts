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

    const diagnostics = collectCompatibilityDiagnostics("telegram-interactive", env);

    expect(diagnostics).toEqual([
      { alias: "TELEGRAM_ALLOWED_USER_ID", canonical: "TELEGRAM_ALLOWED_USER_IDS", state: "selected" },
      { alias: "WORKER_CLI_CHAIN", canonical: "INTERACTIVE_CLI_CHAIN", state: "selected" },
      { alias: "GEMINI_PROJECT_DIR", canonical: "ANTIGRAVITY_PROJECT_DIR", state: "selected" },
    ]);

    const formatted = formatCompatibilityDiagnostics("test-surface", diagnostics);
    expect(formatted).toBe(
      '[compatibility] {"surface":"test-surface","aliases":[{"alias":"TELEGRAM_ALLOWED_USER_ID","canonical":"TELEGRAM_ALLOWED_USER_IDS","state":"selected"},{"alias":"WORKER_CLI_CHAIN","canonical":"INTERACTIVE_CLI_CHAIN","state":"selected"},{"alias":"GEMINI_PROJECT_DIR","canonical":"ANTIGRAVITY_PROJECT_DIR","state":"selected"}]}',
    );
    expect(formatted).not.toContain("123456789");
    expect(formatted).not.toContain("private-project");
    expect(formatted).not.toContain("/usr/bin/claude");
    expect(formatted).not.toContain("codex,claude");
  });

  it("marks aliases shadowed when the canonical key is also present", () => {
    expect(collectCompatibilityDiagnostics("telegram-interactive", {
      TELEGRAM_ALLOWED_USER_ID: "legacy",
      TELEGRAM_ALLOWED_USER_IDS: "canonical",
      HEALTH_CLI_BOT: "claude",
      HEALTH_SUGGEST_BOT: "claude",
      GEMINI_COMMAND: "agy",
      ANTIGRAVITY_COMMAND: "agy",
    })).toEqual([
      { alias: "TELEGRAM_ALLOWED_USER_ID", canonical: "TELEGRAM_ALLOWED_USER_IDS", state: "shadowed" },
      { alias: "GEMINI_COMMAND", canonical: "ANTIGRAVITY_COMMAND", state: "shadowed" },
    ]);
  });

  it("does not emit a diagnostic when no compatibility alias is present", () => {
    expect(collectCompatibilityDiagnostics("telegram-interactive", {
      TELEGRAM_ALLOWED_USER_IDS: "canonical",
      INTERACTIVE_CLI_CHAIN: "codex,claude",
      HEALTH_SUGGEST_COMMAND: "claude",
      ANTIGRAVITY_COMMAND: "agy",
    })).toEqual([]);
  });

  it("reports only aliases consumed by each service surface", () => {
    const env = {
      TELEGRAM_ALLOWED_USER_ID: "telegram-secret",
      WORKER_CLI_CHAIN: "worker-chain",
      HEALTH_CLI_COMMAND: "health-command",
      GEMINI_PROJECT_DIR: "/private/project",
    };

    expect(collectCompatibilityDiagnostics("telegram-worker", env)).toEqual([
      { alias: "TELEGRAM_ALLOWED_USER_ID", canonical: "TELEGRAM_ALLOWED_USER_IDS", state: "selected" },
      { alias: "GEMINI_PROJECT_DIR", canonical: "ANTIGRAVITY_PROJECT_DIR", state: "selected" },
    ]);
    expect(collectCompatibilityDiagnostics("telegram-interactive", env)).toContainEqual({
      alias: "WORKER_CLI_CHAIN", canonical: "INTERACTIVE_CLI_CHAIN", state: "selected",
    });
    expect(collectCompatibilityDiagnostics("telegram-health", env)).toEqual([
      { alias: "HEALTH_CLI_COMMAND", canonical: "HEALTH_SUGGEST_COMMAND", state: "selected" },
    ]);
    expect(collectCompatibilityDiagnostics("discord-interactive", env)).toEqual([
      { alias: "GEMINI_PROJECT_DIR", canonical: "ANTIGRAVITY_PROJECT_DIR", state: "selected" },
    ]);
  });

  it("does not misclassify worker ownership or Discord non-consumption as alias use", () => {
    const workerEnv = {
      WORKER_CLI_CHAIN: "worker-owned-chain",
    };
    const discordEnv = {
      TELEGRAM_ALLOWED_USER_ID: "telegram-secret",
      HEALTH_CLI_BOT: "health-bot",
    };

    expect(collectCompatibilityDiagnostics("telegram-worker", workerEnv)).toEqual([]);
    expect(collectCompatibilityDiagnostics("discord-interactive", discordEnv)).toEqual([]);
  });
});
