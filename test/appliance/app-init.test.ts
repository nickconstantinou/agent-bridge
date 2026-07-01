import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplianceDb } from "../../src/appliance/state.js";
import { appInit } from "../../src/appliance/app-init.js";

// Override APPS_BASE_DIR so tests don't write to /apps/
const APPS_BASE = mkdtempSync(join(tmpdir(), "ab-test-apps-"));
process.env.APPS_BASE_DIR = APPS_BASE;

let db: ApplianceDb;
beforeEach(() => { db = new ApplianceDb(":memory:"); });
afterEach(() => { db.close(); });

afterAll(() => { rmSync(APPS_BASE, { recursive: true, force: true }); });

describe("appInit", () => {
  it("creates directory structure", async () => {
    await appInit(db, { name: "my-app", repo: "git@github.com:x/y.git", domain: "app.example.com", runtime: "node", branch: "main", health: "/health", build: "npm run build", start: "npm run start" });
    expect(existsSync(join(APPS_BASE, "my-app"))).toBe(true);
    expect(existsSync(join(APPS_BASE, "my-app", "repo"))).toBe(true);
    expect(existsSync(join(APPS_BASE, "my-app", "logs"))).toBe(true);
    expect(existsSync(join(APPS_BASE, "my-app", "app.yml"))).toBe(true);
  });

  it("writes app.yml with manifest content", async () => {
    await appInit(db, { name: "my-app", repo: "git@github.com:x/y.git", domain: "app.example.com", runtime: "node", branch: "main", health: "/health", build: "npm run build", start: "npm run start" });
    const content = readFileSync(join(APPS_BASE, "my-app", "app.yml"), "utf8");
    expect(content).toContain("name: my-app");
    expect(content).toContain("repo: git@github.com:x/y.git");
  });

  it("registers app in state DB", async () => {
    await appInit(db, { name: "my-app", repo: "git@github.com:x/y.git", domain: "app.example.com", runtime: "node", branch: "main", health: "/health", build: "npm run build", start: "npm run start" });
    expect(db.getApp("my-app")).not.toBeNull();
  });

  it("allocates a port automatically", async () => {
    const m = await appInit(db, { name: "my-app", repo: "git@github.com:x/y.git", domain: "app.example.com", runtime: "node", branch: "main", health: "/health", build: "npm run build", start: "npm run start" });
    expect(m.port).toBeGreaterThanOrEqual(10000);
  });

  it("rejects unsafe app names", async () => {
    await expect(appInit(db, { name: "../evil", repo: "git@github.com:x/y.git", domain: "app.example.com", runtime: "node", branch: "main", health: "/health", build: "b", start: "s" }))
      .rejects.toThrow();
  });

  it("rejects duplicate app names", async () => {
    await appInit(db, { name: "my-app", repo: "git@github.com:x/y.git", domain: "app.example.com", runtime: "node", branch: "main", health: "/health", build: "b", start: "s" });
    await expect(appInit(db, { name: "my-app", repo: "git@github.com:x/y.git", domain: "app.example.com", runtime: "node", branch: "main", health: "/health", build: "b", start: "s" }))
      .rejects.toThrow("already exists");
  });
});
