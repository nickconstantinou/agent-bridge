import { describe, expect, it } from "vitest";
import { ControlPlaneArubaProvider, type ArubaControlPlaneClient } from "../../src/control-plane/arubaProvider.js";
import type { WorkspaceInfrastructure } from "../../src/control-plane/types.js";

function fakeClient(): ArubaControlPlaneClient & {
  planCalls: number;
  createCalls: number;
  destroyCalls: number;
  bootstrapCalls: number;
} {
  return {
    planCalls: 0,
    createCalls: 0,
    destroyCalls: 0,
    bootstrapCalls: 0,
    async plan() {
      this.planCalls++;
      return {
        projectId: "project-123",
        projectName: "cloud-v1",
        estimatedMonthlyCostEur: 5,
        maxMonthlyBudgetEur: 5,
      };
    },
    async create(input) {
      this.createCalls++;
      return {
        serverId: "server-1",
        serverName: input.serverName,
        bootVolumeId: "boot-1",
        keyPairId: "key-1",
        elasticIpId: "eip-1",
        securityGroupId: "sg-1",
        ipAddress: "198.51.100.10",
      };
    },
    async bootstrap() {
      this.bootstrapCalls++;
    },
    async destroy() {
      this.destroyCalls++;
    },
  };
}

describe("control-plane Aruba provider adapter", () => {
  it("dry-run uses read-only plan and records intended infrastructure without creating resources", async () => {
    const client = fakeClient();
    const provider = new ControlPlaneArubaProvider({
      client,
      dryRun: true,
      projectId: "project-123",
    });

    const infra = await provider.provisionWorkspace({
      workspaceId: "ws-1",
      customerId: "cust-1",
      region: "ITBG-1",
      flavor: "CSO1A2",
      bootstrapToken: "bt-token",
    });

    expect(client.planCalls).toBe(1);
    expect(client.createCalls).toBe(0);
    expect(client.bootstrapCalls).toBe(0);
    expect(infra.provider).toBe("aruba");
    expect(infra.status).toBe("planned");
    expect(infra.serverId).toBe("dry-run-server-ws-1");
    expect(infra.tags).toMatchObject({
      project: "agent-bridge",
      customerId: "cust-1",
      workspaceId: "ws-1",
    });
  });

  it("live mode plans, provisions, bootstraps, and maps Aruba IDs into internal state", async () => {
    const client = fakeClient();
    const provider = new ControlPlaneArubaProvider({
      client,
      dryRun: false,
      projectId: "project-123",
      deployEnvFile: "/tmp/env",
      projectDir: "/repo",
      privateKeyPath: "/tmp/key",
      publicKeyText: "ssh-ed25519 AAA",
    });

    const infra = await provider.provisionWorkspace({
      workspaceId: "ws-live",
      customerId: "cust-live",
      region: "ITBG-1",
      flavor: "CSO1A2",
      bootstrapToken: "bt-live",
    });

    expect(client.planCalls).toBe(1);
    expect(client.createCalls).toBe(1);
    expect(client.bootstrapCalls).toBe(1);
    expect(infra).toMatchObject({
      provider: "aruba",
      status: "provisioned",
      serverId: "server-1",
      bootVolumeId: "boot-1",
      keyPairId: "key-1",
      elasticIpId: "eip-1",
      securityGroupId: "sg-1",
      ipAddress: "198.51.100.10",
    });
  });

  it("destroy refuses unknown or mismatched infrastructure", async () => {
    const client = fakeClient();
    const provider = new ControlPlaneArubaProvider({ client, dryRun: false, projectId: "project-123" });
    const baseInfra: WorkspaceInfrastructure = {
      workspaceId: "ws-1",
      provider: "aruba",
      status: "provisioned",
      region: "ITBG-1",
      flavor: "CSO1A2",
      serverId: "server-1",
      elasticIpId: "eip-1",
      securityGroupId: "sg-1",
      bootVolumeId: "boot-1",
      keyPairId: "key-1",
      ipAddress: "198.51.100.10",
      tags: { project: "agent-bridge", "managed-by": "agent-bridge", workspaceId: "ws-1" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await expect(provider.destroyWorkspace({ ...baseInfra, status: "unknown" }))
      .rejects.toThrow("unknown infrastructure state");
    await expect(provider.destroyWorkspace({ ...baseInfra, tags: { project: "other" } }))
      .rejects.toThrow("refusing to destroy untagged or mismatched Aruba resources");

    await provider.destroyWorkspace(baseInfra);
    expect(client.destroyCalls).toBe(1);
  });
});
