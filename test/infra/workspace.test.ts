import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileWorkspace, destroyWorkspace, type WorkspaceConfig } from "../../src/infra/engine.js";
import { readWorkspaceState, writeWorkspaceState } from "../../src/infra/state.js";
import { ArubaProvider } from "../../src/infra/providers/aruba/provider.js";
import { createServer, type Server } from "node:http";
import { sendHeartbeat } from "../../src/appliance/heartbeat.js";

describe("Workspace Reconciler & Heartbeat", () => {
  let tmpDir: string;
  let statePath: string;
  let mockProvider: any;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ab-ws-test-"));
    statePath = join(tmpDir, "workspace-state.json");

    mockProvider = {
      validateCredentials: vi.fn().mockResolvedValue(true),
      listProjects: vi.fn().mockResolvedValue([{ id: "project-123", name: "cloud-v1", resourcesNumber: 0 }]),
      listServers: vi.fn().mockResolvedValue([]),
      listKeyPairs: vi.fn().mockResolvedValue([]),
      listBlockStorages: vi.fn().mockResolvedValue([]),
      listVpcs: vi.fn().mockResolvedValue([{ id: "vpc-1", name: "itbg-automatic-vpc-01" }]),
      listElasticIps: vi.fn().mockResolvedValue([]),
      createMvpServer: vi.fn().mockResolvedValue({
        server: { id: "server-1", name: "ab-ws-ws-1", status: "creating", ipAddress: "198.51.100.10", tags: {} },
        bootVolumeId: "vol-1",
        keyPairId: "key-1",
        elasticIpId: "eip-1",
        securityGroupId: "sg-1",
        sshRuleId: "rule-1",
      }),
      getMvpServer: vi.fn().mockResolvedValue({
        id: "server-1",
        name: "ab-ws-ws-1",
        status: "Running",
        ipAddress: "198.51.100.10",
        tags: {},
      }),
      bootstrapServer: vi.fn().mockResolvedValue(undefined),
      deleteSecurityRule: vi.fn().mockResolvedValue(undefined),
      destroyMvpServer: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const config: WorkspaceConfig = {
    workspaceId: "ws-1",
    customerId: "cust-1",
    repo: "git@github.com:owner/repo.git",
    branch: "main",
    domain: "app.example.com",
    location: "ITBG-Bergamo",
    dataCenter: "ITBG-1",
    image: "LU24-001",
    flavor: "CSO1A2",
    tags: {
      project: "agent-bridge",
      environment: "spike",
      "managed-by": "agent-bridge",
    },
  };

  it("provisions, bootstraps, and minimizes SSH rule on workspace creation", async () => {
    const finalState = await reconcileWorkspace(
      config,
      mockProvider as unknown as ArubaProvider,
      statePath,
      "/dummy/ssh/id_rsa.pub",
      "/dummy/ssh/id_rsa",
      "/dummy/env",
      tmpDir,
      "ssh-ed25519 AAAATest"
    );

    expect(finalState.status).toBe("ready");
    expect(finalState.ip).toBe("198.51.100.10");
    expect(finalState.firewallId).toBe("sg-1");
    expect(finalState.sshRuleId).toBeUndefined(); // Deleted/minimized after bootstrap
    expect(mockProvider.createMvpServer).toHaveBeenCalled();
    expect(mockProvider.bootstrapServer).toHaveBeenCalled();
    expect(mockProvider.deleteSecurityRule).toHaveBeenCalledWith("project-123", "vpc-1", "sg-1", "rule-1");
  });

  it("cleans up resources and deletes state on workspace destruction", async () => {
    writeWorkspaceState(statePath, {
      workspaceId: "ws-1",
      customerId: "cust-1",
      repo: "r",
      branch: "b",
      domain: "d",
      status: "ready",
      provider: "aruba",
      projectId: "project-123",
      serverId: "server-1",
      serverName: "ab-ws-ws-1",
      firewallId: "sg-1",
      sshKeyId: "key-1",
      bootVolumeId: "vol-1",
      elasticIpId: "eip-1",
      ip: "198.51.100.10",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: {},
    });

    await destroyWorkspace(mockProvider as unknown as ArubaProvider, statePath);

    expect(mockProvider.destroyMvpServer).toHaveBeenCalledWith({
      projectId: "project-123",
      serverId: "server-1",
      bootVolumeId: "vol-1",
      keyPairId: "key-1",
      elasticIpId: "eip-1",
      securityGroupId: "sg-1",
    });
    expect(existsSync(statePath)).toBe(false);
  });

  it("outbound heartbeat client successfully requests control plane registration", async () => {
    let receivedPayload: any = null;
    const server: Server = await new Promise((resolve) => {
      const s = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          receivedPayload = JSON.parse(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      s.listen(0, () => resolve(s));
    });

    const port = (server.address() as any).port;
    const controlPlaneUrl = `http://localhost:${port}`;

    try {
      await sendHeartbeat(controlPlaneUrl, "ws-1", "ready", [
        { name: "my-app", port: 3000, domain: "app.example.com", healthStatus: "ok" }
      ]);

      expect(receivedPayload).not.toBeNull();
      expect(receivedPayload.workspaceId).toBe("ws-1");
      expect(receivedPayload.status).toBe("ready");
      expect(receivedPayload.apps).toHaveLength(1);
      expect(receivedPayload.apps[0].name).toBe("my-app");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
