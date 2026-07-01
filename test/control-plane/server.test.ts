import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneStore } from "../../src/control-plane/state.js";
import { MockWorkspaceProvider } from "../../src/control-plane/mockProvider.js";
import { WorkspaceService } from "../../src/control-plane/service.js";
import { createControlPlaneServer } from "../../src/control-plane/server.js";

describe("SaaS control plane HTTP API", () => {
  let tmpDir: string;
  let store: ControlPlaneStore;
  let service: WorkspaceService;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ab-control-plane-web-"));
    store = new ControlPlaneStore(join(tmpDir, "control-plane.sqlite"));
    service = new WorkspaceService(store, new MockWorkspaceProvider(), { maxMonthlyBudgetEur: 5 });
    store.createCustomer({ id: "cust-api", email: "api@example.com" });
    store.createSubscription({ id: "sub-api", customerId: "cust-api", status: "active" });

    server = createControlPlaneServer(service);
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const address = server.address();
        if (typeof address !== "object" || !address) throw new Error("server did not bind");
        baseUrl = `http://localhost:${address.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function json(path: string, init?: RequestInit) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
    const body = await res.json().catch(() => null);
    return { res, body };
  }

  it("exposes workspace lifecycle endpoints without leaking infrastructure IDs", async () => {
    const created = await json("/workspaces", {
      method: "POST",
      body: JSON.stringify({ customerId: "cust-api", region: "ITBG-1" }),
    });
    expect(created.res.status).toBe(201);
    expect(created.body.workspace.status).toBe("installing_appliance");
    expect(created.body.bootstrapToken).toMatch(/^bt_/);
    expect(JSON.stringify(created.body.workspace)).not.toContain("serverId");

    const workspaceId = created.body.workspace.workspaceId;
    const fetched = await json(`/workspaces/${workspaceId}`);
    expect(fetched.res.status).toBe(200);
    expect(fetched.body.workspace.customerId).toBe("cust-api");
    expect(JSON.stringify(fetched.body.workspace)).not.toContain("mock-server");

    const registered = await json("/appliance/register", {
      method: "POST",
      body: JSON.stringify({ bootstrapToken: created.body.bootstrapToken }),
    });
    expect(registered.res.status).toBe(200);
    expect(registered.body.applianceId).toMatch(/^appliance_/);

    const heartbeat = await json("/appliance/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        workspaceId,
        applianceId: registered.body.applianceId,
        health: { ok: true, load: 0.1 },
      }),
    });
    expect(heartbeat.res.status).toBe(200);
    expect(heartbeat.body.workspace.status).toBe("ready");

    const events = await json(`/workspaces/${workspaceId}/events`);
    expect(events.res.status).toBe(200);
    expect(events.body.events.map((event: { type: string }) => event.type)).toEqual([
      "workspace_created",
      "provisioning_started",
      "infrastructure_ready",
      "appliance_installing",
      "appliance_registered",
      "heartbeat_received",
      "workspace_ready",
    ]);

    const destroyed = await json(`/workspaces/${workspaceId}/destroy`, { method: "POST" });
    expect(destroyed.res.status).toBe(200);
    expect(destroyed.body.workspace.status).toBe("destroyed");
  });

  it("maps validation failures to client errors", async () => {
    const inactive = await json("/workspaces", {
      method: "POST",
      body: JSON.stringify({ customerId: "missing", region: "ITBG-1" }),
    });
    expect(inactive.res.status).toBe(400);
    expect(inactive.body.error).toContain("active subscription required");

    const reused = await json("/appliance/register", {
      method: "POST",
      body: JSON.stringify({ bootstrapToken: "missing-token" }),
    });
    expect(reused.res.status).toBe(400);
  });
});
