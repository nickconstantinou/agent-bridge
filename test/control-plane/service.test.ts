import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneStore } from "../../src/control-plane/state.js";
import { MockWorkspaceProvider } from "../../src/control-plane/mockProvider.js";
import { WorkspaceService } from "../../src/control-plane/service.js";

describe("SaaS control plane workspace service", () => {
  let tmpDir: string;
  let store: ControlPlaneStore;
  let provider: MockWorkspaceProvider;
  let service: WorkspaceService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ab-control-plane-"));
    store = new ControlPlaneStore(join(tmpDir, "control-plane.sqlite"));
    provider = new MockWorkspaceProvider();
    service = new WorkspaceService(store, provider, { maxMonthlyBudgetEur: 5 });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function activeCustomer(customerId = "cust-1") {
    store.createCustomer({ id: customerId, email: `${customerId}@example.com` });
    store.createSubscription({ id: `sub-${customerId}`, customerId, status: "active" });
    return customerId;
  }

  it("creates a workspace with mocked provisioning, token, registration, heartbeat, and ready status", async () => {
    const customerId = activeCustomer();

    const created = await service.createWorkspace({ customerId, region: "ITBG-1" });
    expect(created.status).toBe("installing_appliance");
    expect(created.region).toBe("ITBG-1");
    expect(created.bootstrapToken).toMatch(/^bt_/);
    expect(JSON.stringify(created)).not.toContain("mock-server");

    const eventsAfterCreate = store.listWorkspaceEvents(created.workspaceId).map((event) => event.type);
    expect(eventsAfterCreate).toEqual([
      "workspace_created",
      "provisioning_started",
      "infrastructure_ready",
      "appliance_installing",
    ]);

    const registered = await service.registerAppliance({ bootstrapToken: created.bootstrapToken });
    expect(registered.workspaceId).toBe(created.workspaceId);
    expect(registered.status).toBe("appliance_registered");

    const heartbeat = await service.recordHeartbeat({
      workspaceId: created.workspaceId,
      applianceId: registered.applianceId,
      health: { ok: true, version: "0.1.0" },
    });
    expect(heartbeat.status).toBe("ready");
    expect(heartbeat.latestHealth).toEqual({ ok: true, version: "0.1.0" });
    expect(heartbeat.lastHeartbeatAt).toBeTruthy();

    expect(store.listWorkspaceEvents(created.workspaceId).map((event) => event.type)).toEqual([
      "workspace_created",
      "provisioning_started",
      "infrastructure_ready",
      "appliance_installing",
      "appliance_registered",
      "heartbeat_received",
      "workspace_ready",
    ]);
  });

  it("rejects duplicate workspaces and inactive subscriptions", async () => {
    const customerId = activeCustomer();
    await service.createWorkspace({ customerId, region: "ITBG-1" });

    await expect(service.createWorkspace({ customerId, region: "ITBG-1" }))
      .rejects.toThrow("customer already has a workspace");

    store.createCustomer({ id: "cust-inactive", email: "inactive@example.com" });
    store.createSubscription({ id: "sub-inactive", customerId: "cust-inactive", status: "inactive" });
    await expect(service.createWorkspace({ customerId: "cust-inactive", region: "ITBG-1" }))
      .rejects.toThrow("active subscription required");
  });

  it("enforces CSO1A2 and budget guardrails", async () => {
    const customerId = activeCustomer();

    await expect(service.createWorkspace({ customerId, region: "ITBG-1", flavor: "CSO2A4" }))
      .rejects.toThrow("CSO1A2");

    const expensive = new WorkspaceService(store, provider, { maxMonthlyBudgetEur: 4 });
    await expect(expensive.createWorkspace({ customerId, region: "ITBG-1" }))
      .rejects.toThrow("budget");
  });

  it("rejects reused bootstrap tokens", async () => {
    const customerId = activeCustomer();
    const created = await service.createWorkspace({ customerId, region: "ITBG-1" });

    await service.registerAppliance({ bootstrapToken: created.bootstrapToken });
    await expect(service.registerAppliance({ bootstrapToken: created.bootstrapToken }))
      .rejects.toThrow("Invalid, expired, or already used bootstrap token");
  });

  it("destroys safely and fails closed on unknown infrastructure", async () => {
    const customerId = activeCustomer();
    const created = await service.createWorkspace({ customerId, region: "ITBG-1" });
    await service.registerAppliance({ bootstrapToken: created.bootstrapToken });

    store.markInfrastructureUnknown(created.workspaceId);
    await expect(service.destroyWorkspace(created.workspaceId)).rejects.toThrow("unknown infrastructure state");
    expect(store.getWorkspace(created.workspaceId)?.status).toBe("failed");

    const safeCustomer = activeCustomer("cust-safe");
    const safe = await service.createWorkspace({ customerId: safeCustomer, region: "ITBG-1" });
    const destroyed = await service.destroyWorkspace(safe.workspaceId);
    expect(destroyed.status).toBe("destroyed");
    expect(provider.destroyedWorkspaceIds).toEqual([safe.workspaceId]);
    expect(store.listWorkspaceEvents(safe.workspaceId).map((event) => event.type)).toContain("workspace_destroyed");
  });
});
