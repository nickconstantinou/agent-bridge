import { describe, expect, it } from "vitest";
import { standaloneServiceId } from "../src/executionIdentity.js";

describe("standalone service identity", () => {
  it("does not change when the enabled provider set changes", () => {
    expect(standaloneServiceId(["codex"])).toBe("telegram:standalone");
    expect(standaloneServiceId(["codex", "claude", "antigravity"])).toBe("telegram:standalone");
  });
});
