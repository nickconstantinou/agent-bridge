import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ApplianceDb } from "../../src/appliance/state.js";

let db: ApplianceDb;

beforeEach(() => { db = new ApplianceDb(":memory:"); });
afterEach(() => { db.close(); });

const BASE: Parameters<ApplianceDb["upsertApp"]>[0] = {
  name: "my-app", repo: "git@github.com:x/y.git", branch: "main",
  port: 3000, domain: "app.example.com", runtime: "node",
  current_commit: null, previous_commit: null,
  last_deploy_status: null, last_health_status: null,
  last_deployed_at: null, last_error: null,
};

describe("ApplianceDb - apps", () => {
  it("returns null for unknown app", () => {
    expect(db.getApp("missing")).toBeNull();
  });

  it("upserts and retrieves an app", () => {
    db.upsertApp(BASE);
    const got = db.getApp("my-app");
    expect(got?.name).toBe("my-app");
    expect(got?.port).toBe(3000);
    expect(got?.service_name).toBe("ab-my-app");
  });

  it("updates existing app on re-upsert", () => {
    db.upsertApp(BASE);
    db.upsertApp({ ...BASE, current_commit: "abc123", last_deploy_status: "success" });
    expect(db.getApp("my-app")?.current_commit).toBe("abc123");
    expect(db.getApp("my-app")?.last_deploy_status).toBe("success");
  });

  it("lists all apps", () => {
    db.upsertApp(BASE);
    db.upsertApp({ ...BASE, name: "other-app", port: 3001, domain: "other.example.com" });
    expect(db.listApps().map(a => a.name).sort()).toEqual(["my-app", "other-app"]);
  });

  it("deletes an app", () => {
    db.upsertApp(BASE);
    db.deleteApp("my-app");
    expect(db.getApp("my-app")).toBeNull();
  });
});

describe("ApplianceDb - port allocator", () => {
  it("allocates ports starting at 10000", () => {
    expect(db.allocatePort()).toBe(10000);
  });

  it("allocates unique ports on each call", () => {
    const p1 = db.allocatePort();
    const p2 = db.allocatePort();
    expect(p1).not.toBe(p2);
    expect(p2).toBe(p1 + 1);
  });

  it("skips ports already in use by apps", () => {
    db.upsertApp({ ...BASE, port: 10000 });
    db.upsertApp({ ...BASE, name: "app2", port: 10001, domain: "b.example.com" });
    expect(db.allocatePort()).toBe(10002);
  });
});

describe("ApplianceDb - incidents", () => {
  it("inserts and retrieves open incidents", () => {
    db.upsertApp(BASE);
    const id = db.insertIncident({
      app_name: "my-app", detected_at: "2026-01-01T00:00:00Z",
      health_url: "http://localhost:3000/health", http_status: 503,
      error: "Service Unavailable", logs: "error: crash", resolved_at: null,
    });
    const incidents = db.getOpenIncidents("my-app");
    expect(incidents).toHaveLength(1);
    expect(incidents[0].id).toBe(id);
    expect(incidents[0].http_status).toBe(503);
  });

  it("resolves an incident", () => {
    db.upsertApp(BASE);
    const id = db.insertIncident({
      app_name: "my-app", detected_at: "2026-01-01T00:00:00Z",
      health_url: "http://localhost:3000/health", http_status: null,
      error: "timeout", logs: null, resolved_at: null,
    });
    db.resolveIncident(id, "2026-01-01T01:00:00Z");
    expect(db.getOpenIncidents("my-app")).toHaveLength(0);
  });
});
