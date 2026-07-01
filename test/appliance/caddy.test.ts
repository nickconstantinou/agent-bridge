import { describe, it, expect } from "vitest";
import { generateCaddyBlock, validateDomain } from "../../src/appliance/caddy.js";

describe("generateCaddyBlock", () => {
  it("generates a valid Caddy reverse proxy block", () => {
    const block = generateCaddyBlock("app.example.com", 3000);
    expect(block).toContain("app.example.com");
    expect(block).toContain("reverse_proxy");
    expect(block).toContain("localhost:3000");
  });

  it("wraps block in braces", () => {
    const block = generateCaddyBlock("app.example.com", 3000);
    expect(block).toMatch(/app\.example\.com\s*\{/);
    expect(block).toContain("}");
  });

  it("does not include http:// in domain", () => {
    const block = generateCaddyBlock("app.example.com", 3000);
    expect(block).not.toContain("http://");
  });

  it("uses the correct port", () => {
    const block = generateCaddyBlock("other.io", 8080);
    expect(block).toContain("localhost:8080");
  });
});

describe("validateDomain", () => {
  it("passes for valid domain", () => {
    expect(() => validateDomain("app.example.com")).not.toThrow();
    expect(() => validateDomain("localhost")).not.toThrow();
  });

  it("throws for invalid domain", () => {
    expect(() => validateDomain("http://bad.com")).toThrow("invalid domain");
    expect(() => validateDomain("../evil")).toThrow("invalid domain");
    expect(() => validateDomain("")).toThrow("invalid domain");
  });
});
