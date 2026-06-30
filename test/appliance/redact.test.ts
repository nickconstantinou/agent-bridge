import { describe, it, expect } from "vitest";
import { redact } from "../../src/appliance/redact.js";

describe("redact", () => {
  it("masks SECRET= values", () => {
    expect(redact("SECRET=abc123")).toBe("SECRET=***");
  });
  it("masks TOKEN= values", () => {
    expect(redact("AUTH_TOKEN=xyz")).toBe("AUTH_TOKEN=***");
  });
  it("masks PASSWORD= values", () => {
    expect(redact("DB_PASSWORD=hunter2")).toBe("DB_PASSWORD=***");
  });
  it("masks KEY= values", () => {
    expect(redact("API_KEY=sk-1234")).toBe("API_KEY=***");
  });
  it("preserves unrelated content", () => {
    expect(redact("PORT=3000")).toBe("PORT=3000");
    expect(redact("Server started on port 3000")).toBe("Server started on port 3000");
  });
  it("handles multiple secrets on same line", () => {
    const result = redact("SECRET=abc TOKEN=def PORT=3000");
    expect(result).toBe("SECRET=*** TOKEN=*** PORT=3000");
  });
});
