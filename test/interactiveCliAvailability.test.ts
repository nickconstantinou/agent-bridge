import { describe, expect, it } from "vitest";
import {
  buildCliKeyboard,
  buildCliStatusText,
  getSelectableCliKinds,
  resolveAvailableCliPreference,
  type CliKind,
} from "../src/interactiveBot.js";
import { getAuthenticatedCliKinds, resolveInteractiveCliAuthPaths } from "../src/interactiveCliAuth.js";

describe("interactive CLI availability filtering", () => {
  it("filters the switch keyboard to authenticated CLIs plus kimchi", () => {
    const authenticated = new Set<CliKind>(["claude", "kimchi"]);
    const keyboard = buildCliKeyboard("codex", authenticated);
    const buttons = keyboard.inline_keyboard.flat();

    expect(buttons.map((button) => button.callback_data)).toEqual(["cli:claude", "cli:kimchi"]);
    expect(buttons.find((button) => button.text.includes("✓"))?.text).toContain("claude");
  });

  it("filters status text to authenticated CLIs", () => {
    const authenticated = new Set<CliKind>(["claude", "kimchi"]);
    const text = buildCliStatusText("codex", authenticated);

    expect(text).toContain("Active CLI: **claude**");
    expect(text).toContain("Available: claude, kimchi");
    expect(text).not.toContain("Available: codex");
    expect(text).not.toContain("antigravity");
  });

  it("keeps kimchi available when no external CLI credentials exist", () => {
    const authenticated = getAuthenticatedCliKinds({ homeDir: "/tmp/no-creds", exists: () => false });

    expect(authenticated).toEqual(new Set<CliKind>(["kimchi"]));
    expect(getSelectableCliKinds(authenticated)).toEqual(["kimchi"]);
    expect(resolveAvailableCliPreference("codex", authenticated)).toBe("kimchi");
  });

  it("detects provider credential files from the expected home-directory paths", () => {
    const homeDir = "/home/tester";
    const paths = resolveInteractiveCliAuthPaths(homeDir);
    const existing = new Set([paths.codex, paths.claude]);
    const authenticated = getAuthenticatedCliKinds({ homeDir, exists: (path) => existing.has(path) });

    expect(authenticated).toEqual(new Set<CliKind>(["kimchi", "codex", "claude"]));
    expect(paths.codex).toBe("/home/tester/.codex/auth.json");
    expect(paths.claude).toBe("/home/tester/.claude/.credentials.json");
    expect(paths.antigravity).toBe("/home/tester/.gemini/oauth_creds.json");
  });
});
