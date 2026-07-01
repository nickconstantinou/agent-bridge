import { describe, expect, it } from "vitest";
import {
  ControlPlaneFrontendClient,
  frontendStateFromDto,
  sanitizeFrontendDto,
  type FrontendControlPlaneDto,
} from "../../src/control-plane/frontendClient.js";
import { renderControlPlaneFrontend } from "../../src/control-plane/frontend.js";

const forbidden = ["Aruba", "VPS", "SSH", "Caddy", "systemd", "SQLite", "Elastic IP", "security group", "provider error"];

const dto: FrontendControlPlaneDto = {
  session: { signedIn: true, displayName: "Alex" },
  workspace: { id: "ws-1", status: "failed", projectName: "Launch Project" },
  integrations: { github: "connected", chat: "not_connected", chatProvider: "telegram" },
  recentEvents: [
    { type: "workspace_failed", createdAt: "2026-07-01T10:00:00.000Z", label: "Aruba VPS provider error" },
  ],
  readyUrl: "https://t.me/agent_bridge_bot?start=workspace",
  supportUrl: "mailto:support@example.com",
  failure: { title: "Provider error", message: "SSH Caddy systemd SQLite Elastic IP security group failed" },
};

describe("frontend-safe control-plane contract", () => {
  it("sanitizes DTO fields before rendering", () => {
    const safe = sanitizeFrontendDto(dto);
    const serialized = JSON.stringify(safe);
    for (const term of forbidden) expect(serialized).not.toContain(term);

    const html = renderControlPlaneFrontend(frontendStateFromDto(safe));
    for (const term of forbidden) expect(html).not.toContain(term);
    expect(html).toContain("Workspace setup needs attention");
  });

  it("client creates workspace through existing API and returns frontend DTO", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const client = new ControlPlaneFrontendClient({
      baseUrl: "https://control.example",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), method: init?.method || "GET" });
        return new Response(JSON.stringify({
          workspace: {
            workspaceId: "ws-1",
            customerId: "cust-1",
            status: "installing_appliance",
            region: "ITBG-1",
            flavor: "CSO1A2",
            billingStatus: "placeholder_active",
            applianceId: null,
            lastHeartbeatAt: null,
            latestHealth: null,
            createdAt: "2026-07-01T10:00:00.000Z",
            updatedAt: "2026-07-01T10:00:00.000Z",
          },
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      },
    });

    const result = await client.createWorkspace({ customerId: "cust-1" });
    expect(calls).toEqual([{ url: "https://control.example/workspaces", method: "POST" }]);
    expect(result.workspace?.status).toBe("pending");
    expect(JSON.stringify(result)).not.toContain("ITBG-1");
    expect(JSON.stringify(result)).not.toContain("CSO1A2");
  });

  it("polls workspace status until ready", async () => {
    const statuses = ["installing_appliance", "ready"];
    const client = new ControlPlaneFrontendClient({
      baseUrl: "https://control.example",
      fetchImpl: async () => {
        const status = statuses.shift() || "ready";
        return new Response(JSON.stringify({
          workspace: {
            workspaceId: "ws-1",
            customerId: "cust-1",
            status,
            createdAt: "2026-07-01T10:00:00.000Z",
            updatedAt: "2026-07-01T10:00:00.000Z",
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    const seen: string[] = [];
    const result = await client.pollWorkspace("ws-1", {
      intervalMs: 0,
      maxAttempts: 3,
      onUpdate: (state) => { if (state.workspace) seen.push(state.workspace.status); },
    });

    expect(seen).toEqual(["pending", "ready"]);
    expect(result.workspace?.status).toBe("ready");
  });

  it("retry action is a frontend/API contract only", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const client = new ControlPlaneFrontendClient({
      baseUrl: "https://control.example",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), method: init?.method || "GET" });
        return new Response(JSON.stringify({ workspace: { workspaceId: "ws-retry", status: "provisioning" } }), { status: 201 });
      },
    });

    await client.retryWorkspace({ customerId: "cust-1" });
    expect(calls).toEqual([{ url: "https://control.example/workspaces", method: "POST" }]);
  });
});
