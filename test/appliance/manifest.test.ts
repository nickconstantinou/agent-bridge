import { describe, it, expect } from "vitest";
import { parseManifest, validateManifest, serializeManifest, isValidAppName, isValidDomain } from "../../src/appliance/manifest.js";

const VALID_YAML = `name: my-app
runtime: node
repo: git@github.com:owner/repo.git
branch: main
port: 3000
domain: app.example.com
database: sqlite
health: /health
build: npm run build
start: npm run start`;

describe("parseManifest", () => {
  it("parses a valid manifest", () => {
    const m = parseManifest(VALID_YAML);
    expect(m.name).toBe("my-app");
    expect(m.port).toBe(3000);
    expect(m.runtime).toBe("node");
  });

  it("throws on missing required field", () => {
    expect(() => parseManifest("name: x\nruntime: node")).toThrow("missing required field");
  });

  it("coerces port to integer", () => {
    const m = parseManifest(VALID_YAML);
    expect(typeof m.port).toBe("number");
  });
});

describe("validateManifest", () => {
  it("returns empty array for valid manifest", () => {
    expect(validateManifest(parseManifest(VALID_YAML))).toEqual([]);
  });

  it("rejects unsafe app names", () => {
    const m = parseManifest(VALID_YAML);
    expect(validateManifest({ ...m, name: "../evil" })).toEqual(expect.arrayContaining([expect.stringContaining("name")]));
    expect(validateManifest({ ...m, name: "a" })).toEqual(expect.arrayContaining([expect.stringContaining("name")]));
    expect(validateManifest({ ...m, name: "A".repeat(65) })).toEqual(expect.arrayContaining([expect.stringContaining("name")]));
  });

  it("rejects privileged ports", () => {
    const m = parseManifest(VALID_YAML);
    expect(validateManifest({ ...m, port: 80 })).toEqual(expect.arrayContaining([expect.stringContaining("port")]));
    expect(validateManifest({ ...m, port: 443 })).toEqual(expect.arrayContaining([expect.stringContaining("port")]));
    expect(validateManifest({ ...m, port: 1023 })).toEqual(expect.arrayContaining([expect.stringContaining("port")]));
  });

  it("accepts port 1024 and above", () => {
    const m = parseManifest(VALID_YAML);
    expect(validateManifest({ ...m, port: 1024 })).toEqual([]);
    expect(validateManifest({ ...m, port: 65535 })).toEqual([]);
  });

  it("rejects invalid domains", () => {
    const m = parseManifest(VALID_YAML);
    expect(validateManifest({ ...m, domain: "http://bad.com" })).toEqual(expect.arrayContaining([expect.stringContaining("domain")]));
    expect(validateManifest({ ...m, domain: "" })).toEqual(expect.arrayContaining([expect.stringContaining("domain")]));
    expect(validateManifest({ ...m, domain: "../evil" })).toEqual(expect.arrayContaining([expect.stringContaining("domain")]));
  });

  it("rejects health paths without leading slash", () => {
    const m = parseManifest(VALID_YAML);
    expect(validateManifest({ ...m, health: "health" })).toEqual(expect.arrayContaining([expect.stringContaining("health")]));
  });

  it("rejects unknown runtimes", () => {
    const m = parseManifest(VALID_YAML);
    expect(validateManifest({ ...m, runtime: "php" as any })).toEqual(expect.arrayContaining([expect.stringContaining("runtime")]));
  });
});

describe("isValidAppName", () => {
  it("accepts valid names", () => {
    expect(isValidAppName("my-app")).toBe(true);
    expect(isValidAppName("app123")).toBe(true);
    expect(isValidAppName("ab")).toBe(true);
  });

  it("rejects invalid names", () => {
    expect(isValidAppName("a")).toBe(false);
    expect(isValidAppName("-app")).toBe(false);
    expect(isValidAppName("app-")).toBe(false);
    expect(isValidAppName("../evil")).toBe(false);
    expect(isValidAppName("app name")).toBe(false);
    expect(isValidAppName("A".repeat(65))).toBe(false);
  });
});

describe("isValidDomain", () => {
  it("accepts valid domains", () => {
    expect(isValidDomain("app.example.com")).toBe(true);
    expect(isValidDomain("localhost")).toBe(true);
    expect(isValidDomain("my-app.io")).toBe(true);
  });

  it("rejects invalid domains", () => {
    expect(isValidDomain("http://bad.com")).toBe(false);
    expect(isValidDomain("../evil")).toBe(false);
    expect(isValidDomain("")).toBe(false);
    expect(isValidDomain("a b.com")).toBe(false);
  });
});

describe("serializeManifest", () => {
  it("round-trips through parse", () => {
    const m = parseManifest(VALID_YAML);
    const serialized = serializeManifest(m);
    const m2 = parseManifest(serialized);
    expect(m2).toEqual(m);
  });
});
