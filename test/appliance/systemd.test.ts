import { describe, it, expect } from "vitest";
import { sanitizeUnitName, generateUnit } from "../../src/appliance/systemd.js";

describe("sanitizeUnitName", () => {
  it("prefixes with ab-", () => {
    expect(sanitizeUnitName("my-app")).toBe("ab-my-app");
  });

  it("strips characters invalid in unit names", () => {
    // Unit names allow [a-zA-Z0-9_.-]; spaces and slashes should be removed
    expect(sanitizeUnitName("my app")).toBe("ab-myapp");
    expect(sanitizeUnitName("my/app")).toBe("ab-myapp");
  });
});

describe("generateUnit", () => {
  const unit = generateUnit({
    appName: "my-app",
    runtime: "node",
    startCmd: "npm run start",
    port: 3000,
  });

  it("contains required unit sections", () => {
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
  });

  it("uses correct working directory", () => {
    expect(unit).toContain("WorkingDirectory=/apps/my-app/repo");
  });

  it("sources the app env file", () => {
    expect(unit).toContain("EnvironmentFile=/apps/my-app/.env");
  });

  it("sets ExecStart with the start command", () => {
    expect(unit).toContain("ExecStart=");
    expect(unit).toContain("npm run start");
  });

  it("runs as agentbridge user", () => {
    expect(unit).toContain("User=agentbridge");
  });

  it("sets SyslogIdentifier to ab-<name>", () => {
    expect(unit).toContain("SyslogIdentifier=ab-my-app");
  });

  it("restarts on failure", () => {
    expect(unit).toContain("Restart=on-failure");
  });

  it("sets PORT env var", () => {
    expect(unit).toContain("Environment=PORT=3000");
  });

  it("rejects app names with characters invalid for unit file paths", () => {
    expect(() => generateUnit({ appName: "../evil", runtime: "node", startCmd: "start", port: 3000 }))
      .toThrow("unsafe");
  });
});
