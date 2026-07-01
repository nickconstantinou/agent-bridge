import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkHealth, recordHealthIncident } from "../../src/appliance/health.js";
import { ApplianceDb } from "../../src/appliance/state.js";
import { createServer, type Server } from "node:http";

let server: Server;
let port: number;
let db: ApplianceDb;

beforeEach(async () => {
  db = new ApplianceDb(":memory:");
  db.upsertApp({
    name: "test-app",
    repo: "r",
    branch: "main",
    port: 3000,
    domain: "localhost",
    runtime: "node",
    current_commit: null,
    previous_commit: null,
    last_deploy_status: null,
    last_health_status: null,
    last_deployed_at: null,
    last_error: null,
  });
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200);
        res.end("ok");
      } else if (req.url === "/slow") {
        setTimeout(() => {
          res.writeHead(200);
          res.end();
        }, 500);
      } else {
        res.writeHead(503);
        res.end("error");
      }
    });
    server.listen(0, () => {
      port = (server.address() as any).port;
      resolve();
    });
  });
});

afterEach(async () => {
  db.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("checkHealth", () => {
  it("returns ok=true for 200 response", async () => {
    const r = await checkHealth(`http://localhost:${port}/health`);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.error).toBeNull();
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns ok=false for non-2xx response", async () => {
    const r = await checkHealth(`http://localhost:${port}/fail`);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
  });

  it("returns ok=false on timeout", async () => {
    const r = await checkHealth(`http://localhost:${port}/slow`, 50);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout/i);
  });

  it("returns ok=false on connection refused", async () => {
    const r = await checkHealth("http://localhost:19999/health");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe("recordHealthIncident", () => {
  it("creates an incident in the DB and returns its id", async () => {
    const result = { ok: false, status: 503, latencyMs: 10, error: null };
    const id = await recordHealthIncident(
      db,
      "test-app",
      `http://localhost:${port}/fail`,
      result,
      "crash log"
    );
    expect(id).toBeGreaterThan(0);
    const incidents = db.getOpenIncidents("test-app");
    expect(incidents).toHaveLength(1);
    expect(incidents[0].http_status).toBe(503);
    expect(incidents[0].logs).toBe("crash log");
  });
});
