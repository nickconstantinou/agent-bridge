import { describe, expect, it } from "vitest";
import { renderWorkerPrompt } from "../src/workerPrompts.js";

describe("worker loader basics", () => {
  it("renders placeholders", () => {
    expect(renderWorkerPrompt("Hello {name}", { name: "Nick" })).toBe("Hello Nick");
  });
});
