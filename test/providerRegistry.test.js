import { describe, expect, it } from "vitest";
import { createProviderRegistry } from "../src/providerRegistry.js";

describe("provider registry", () => {
  it("returns provider adapters by kind", () => {
    const registry = createProviderRegistry({
      codex: { name: "codex" },
      gemini: { name: "gemini", supportsStreaming: true },
    });

    expect(registry.get("codex")).toEqual({ name: "codex" });
    expect(registry.hasStreaming("gemini")).toBe(true);
  });

  it("rejects unknown providers", () => {
    const registry = createProviderRegistry({});
    expect(() => registry.get("claude")).toThrow(/Unsupported provider/);
  });
});
