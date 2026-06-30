import { describe, expect, it, vi } from "vitest";
import { ArubaProvider } from "../src/infra/providers/aruba/provider.js";
import {
  buildArubaPlanConfig,
  formatProvisionDryRun,
  resolveDestructiveOptions,
  runInfrastructurePlan,
} from "../src/infra/engine.js";

describe("Aruba infrastructure plan", () => {
  const baseConfig = {
    provider: "aruba",
    projectId: "project-123",
    projectName: "cloud-v1",
    allowedProjectIds: ["project-123"],
    location: "ITBG-Bergamo",
    dataCenter: "ITBG-1",
    image: "LU24-001",
    flavor: "CSO1A2",
    maxFlavor: "CSO1A2",
    maxVps: 1,
    maxMonthlyBudgetEur: 5,
    estimatedMonthlyCostEur: 5,
    tags: {
      project: "agent-bridge",
      environment: "spike",
      "managed-by": "agent-bridge",
    },
  };

  it("refuses a flavor above the MVP maximum", async () => {
    await expect(runInfrastructurePlan({
      config: { ...baseConfig, flavor: "CSO2A4" },
      provider: {
        validateCredentials: async () => true,
        listProjects: async () => [{ id: "project-123", name: "cloud-v1", resourcesNumber: 0 }],
        listServers: async () => [],
        listKeyPairs: async () => [],
        listBlockStorages: async () => [],
        listVpcs: async () => [],
        listElasticIps: async () => [],
      },
    })).rejects.toThrow("flavor CSO2A4 exceeds maximum CSO1A2");
  });

  it("refuses a project outside the allowlist", async () => {
    await expect(runInfrastructurePlan({
      config: { ...baseConfig, allowedProjectIds: ["other-project"] },
      provider: {
        validateCredentials: async () => true,
        listProjects: async () => [{ id: "project-123", name: "cloud-v1", resourcesNumber: 0 }],
        listServers: async () => [],
        listKeyPairs: async () => [],
        listBlockStorages: async () => [],
        listVpcs: async () => [],
        listElasticIps: async () => [],
      },
    })).rejects.toThrow("project project-123 is not in ARUBA_ALLOWED_PROJECT_IDS");
  });

  it("returns a read-only creation plan when guardrails pass", async () => {
    const plan = await runInfrastructurePlan({
      config: baseConfig,
      provider: {
        validateCredentials: async () => true,
        listProjects: async () => [{ id: "project-123", name: "cloud-v1", resourcesNumber: 0 }],
        listServers: async () => [],
        listKeyPairs: async () => [],
        listBlockStorages: async () => [],
        listVpcs: async () => [],
        listElasticIps: async () => [],
      },
    });

    expect(plan.valid).toBe(true);
    expect(plan.wouldCreate).toEqual([
      "keyPair",
      "bootVolume",
      "cloudServer",
      "dockerComposeRuntime",
    ]);
    expect(plan.target.flavor).toBe("CSO1A2");
    expect(plan.resources.cloudServers).toBe(0);
  });
});

describe("ArubaProvider read-only API", () => {
  it("authenticates with OAuth client credentials and pins project API version", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("openid-connect/token")) {
        return new Response(JSON.stringify({ access_token: "jwt", token_type: "Bearer", expires_in: 3600 }), { status: 200 });
      }
      if (href === "https://api.arubacloud.com/projects?api-version=1.0") {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer jwt" });
        return new Response(JSON.stringify({
          total: 1,
          values: [
            {
              metadata: { id: "project-123", name: "cloud-v1" },
              properties: { resourcesNumber: 0 },
            },
          ],
        }), { status: 200 });
      }
      throw new Error(`unexpected request: ${href}`);
    });

    const provider = new ArubaProvider({
      apiKey: "key",
      apiSecret: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(provider.validateCredentials()).resolves.toBe(true);
    await expect(provider.listProjects()).resolves.toEqual([
      { id: "project-123", name: "cloud-v1", resourcesNumber: 0 },
    ]);
  });

  it("pre-creates EIP and passes its URI to server creation on existing VPC", async () => {
    const requests: Array<{ url: string; method: string; body: any }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method || "GET";
      if (href.includes("openid-connect/token")) {
        return new Response(JSON.stringify({ access_token: "jwt", token_type: "Bearer", expires_in: 3600 }), { status: 200 });
      }
      if (method === "POST") {
        requests.push({ url: href, method, body: JSON.parse(String(init?.body || "{}")) });
      }
      if (href === "https://api.arubacloud.com/projects/project-123/providers/Aruba.Compute/keyPairs?api-version=1.0") {
        return new Response(JSON.stringify({ metadata: { id: "key-1", name: "agent-bridge-spike-key" } }), { status: 201 });
      }
      if (href === "https://api.arubacloud.com/projects/project-123/providers/Aruba.Storage/blockStorages?api-version=1.0") {
        return new Response(JSON.stringify({ metadata: { id: "vol-1", name: "agent-bridge-spike-boot" } }), { status: 201 });
      }
      if (href === "https://api.arubacloud.com/projects/project-123/providers/Aruba.Network/elasticIps?api-version=1.0") {
        return new Response(JSON.stringify({ metadata: { id: "eip-1", name: "agent-bridge-spike-server-eip" }, properties: { ipAddress: "198.51.100.20" } }), { status: 201 });
      }
      if (href === "https://api.arubacloud.com/projects/project-123/providers/Aruba.Network/vpcs?api-version=1.0") {
        return new Response(JSON.stringify({ total: 1, values: [{ metadata: { id: "vpc-1", name: "itbg-automatic-vpc-01" } }] }), { status: 200 });
      }
      if (href === "https://api.arubacloud.com/projects/project-123/providers/Aruba.Network/vpcs/vpc-1/subnets?api-version=1.0") {
        return new Response(JSON.stringify({ total: 1, values: [{ metadata: { id: "subnet-1", name: "automatic-subnet-01" } }] }), { status: 200 });
      }
      if (href === "https://api.arubacloud.com/projects/project-123/providers/Aruba.Network/vpcs/vpc-1/securityGroups?api-version=1.0") {
        if (method === "POST") {
          return new Response(JSON.stringify({ metadata: { id: "sg-1", name: "agent-bridge-spike-server-sg" } }), { status: 201 });
        }
        return new Response(JSON.stringify({ total: 1, values: [{ metadata: { id: "sg-1", name: "default-sg" } }] }), { status: 200 });
      }
      if (href === "https://api.arubacloud.com/projects/project-123/providers/Aruba.Network/vpcs/vpc-1/securityGroups/sg-1/securityRules?api-version=1.0" && method === "POST") {
        return new Response(JSON.stringify({ metadata: { id: "rule-1", name: "agent-bridge-spike-server-allow-ssh" } }), { status: 201 });
      }
      if (href === "https://api.arubacloud.com/projects/project-123/providers/Aruba.Compute/cloudServers?api-version=1.1") {
        return new Response(JSON.stringify({
          metadata: { id: "server-1", name: "agent-bridge-spike-server" },
          status: { state: "InCreation" },
          properties: { networkInterfaces: [] },
        }), { status: 201 });
      }
      throw new Error(`unexpected request: ${method} ${href}`);
    });

    const provider = new ArubaProvider({
      apiKey: "key",
      apiSecret: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const created = await provider.createMvpServer({
      projectId: "project-123",
      name: "agent-bridge-spike-server",
      bootVolumeName: "agent-bridge-spike-boot",
      keyPairName: "agent-bridge-spike-key",
      publicKeyText: "ssh-ed25519 AAAA test",
      location: "ITBG-Bergamo",
      dataCenter: "ITBG-1",
      image: "LU24-001",
      flavor: "CSO1A2",
      bootVolumeSizeGb: 20,
      userData: "#cloud-config\n",
      tags: {
        project: "agent-bridge",
        environment: "spike",
        "managed-by": "agent-bridge",
      },
    });

    expect(created.server.id).toBe("server-1");
    expect(created.server.ipAddress).toBe("198.51.100.20");
    expect(created.bootVolumeId).toBe("vol-1");
    expect(created.keyPairId).toBe("key-1");
    expect(created.elasticIpId).toBe("eip-1");
    expect(requests.map(request => request.url)).toEqual([
      "https://api.arubacloud.com/projects/project-123/providers/Aruba.Compute/keyPairs?api-version=1.0",
      "https://api.arubacloud.com/projects/project-123/providers/Aruba.Storage/blockStorages?api-version=1.0",
      "https://api.arubacloud.com/projects/project-123/providers/Aruba.Network/elasticIps?api-version=1.0",
      "https://api.arubacloud.com/projects/project-123/providers/Aruba.Network/vpcs/vpc-1/securityGroups?api-version=1.0",
      "https://api.arubacloud.com/projects/project-123/providers/Aruba.Network/vpcs/vpc-1/securityGroups/sg-1/securityRules?api-version=1.0",
      "https://api.arubacloud.com/projects/project-123/providers/Aruba.Compute/cloudServers?api-version=1.1",
    ]);
    expect(requests[5].body.properties).toMatchObject({
      dataCenter: "ITBG-1",
      vpcPreset: false,
      elasticIp: { uri: "/projects/project-123/providers/Aruba.Network/elasticIps/eip-1" },
      flavorName: "CSO1A2",
      bootVolume: { uri: "/projects/project-123/providers/Aruba.Storage/blockStorages/vol-1" },
      keyPair: { uri: "/projects/project-123/providers/Aruba.Compute/keyPairs/key-1" },
    });
    expect(requests[5].body.properties).not.toHaveProperty("addElasticIp");
    expect(requests[5].body.metadata.tags).toEqual(["agent-bridge", "spike", "managed-by-ab"]);
  });

  it("gets and deletes only state-addressed Aruba MVP resources", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method || "GET";
      if (href.includes("openid-connect/token")) {
        return new Response(JSON.stringify({ access_token: "jwt", token_type: "Bearer", expires_in: 3600 }), { status: 200 });
      }
      requests.push({ url: href, method });
      if (method === "GET" && href === "https://api.arubacloud.com/projects/project-123/providers/Aruba.Compute/cloudServers/server-1?api-version=1.0") {
        return new Response(JSON.stringify({
          metadata: { id: "server-1", name: "agent-bridge-spike-server", tags: ["agent-bridge", "spike", "managed-by-ab"] },
          status: { state: "Running" },
          properties: { networkInterfaces: [{ ips: ["198.51.100.10"] }] },
        }), { status: 200 });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`unexpected request: ${method} ${href}`);
    });

    const provider = new ArubaProvider({
      apiKey: "key",
      apiSecret: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(provider.getMvpServer("project-123", "server-1")).resolves.toMatchObject({
      id: "server-1",
      ipAddress: "198.51.100.10",
      status: "Running",
    });
    await provider.destroyMvpServer({
      projectId: "project-123",
      serverId: "server-1",
      bootVolumeId: "vol-1",
      keyPairId: "key-1",
      elasticIpId: "eip-1",
    });

    expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([
      "GET https://api.arubacloud.com/projects/project-123/providers/Aruba.Compute/cloudServers/server-1?api-version=1.0",
      "DELETE https://api.arubacloud.com/projects/project-123/providers/Aruba.Compute/cloudServers/server-1?api-version=1.0",
      "DELETE https://api.arubacloud.com/projects/project-123/providers/Aruba.Network/elasticIps/eip-1?api-version=1.0",
      "DELETE https://api.arubacloud.com/projects/project-123/providers/Aruba.Storage/blockStorages/vol-1?api-version=1.0",
      "DELETE https://api.arubacloud.com/projects/project-123/providers/Aruba.Compute/keyPairs/key-1?api-version=1.0",
    ]);
  });

  it("builds config from environment with allowlisted project IDs", () => {
    const config = buildArubaPlanConfig({
      ARUBA_PROJECT_ID: "project-123",
      ARUBA_ALLOWED_PROJECT_IDS: "project-123,project-456",
    });

    expect(config.projectId).toBe("project-123");
    expect(config.allowedProjectIds).toEqual(["project-123", "project-456"]);
    expect(config.maxMonthlyBudgetEur).toBe(5);
    expect(config.tags.environment).toBe("spike");
  });
});

describe("MVP destructive safety", () => {
  it("defaults destructive actions to dry-run unless --yes is supplied", () => {
    expect(resolveDestructiveOptions({ dryRun: false, yes: false })).toEqual({ dryRun: true, yes: false });
    expect(resolveDestructiveOptions({ dryRun: false, yes: true })).toEqual({ dryRun: false, yes: true });
    expect(resolveDestructiveOptions({ dryRun: true, yes: true })).toEqual({ dryRun: true, yes: true });
  });

  it("formats Aruba provision dry-run without implying resource creation", async () => {
    const plan = await runInfrastructurePlan({
      config: {
        provider: "aruba",
        projectId: "project-123",
        projectName: "cloud-v1",
        allowedProjectIds: ["project-123"],
        location: "ITBG-Bergamo",
        dataCenter: "ITBG-1",
        image: "LU24-001",
        flavor: "CSO1A2",
        maxFlavor: "CSO1A2",
        maxVps: 1,
        maxMonthlyBudgetEur: 5,
        estimatedMonthlyCostEur: 5,
        tags: {
          project: "agent-bridge",
          environment: "spike",
          "managed-by": "agent-bridge",
        },
      },
      provider: {
        validateCredentials: async () => true,
        listProjects: async () => [{ id: "project-123", name: "cloud-v1", resourcesNumber: 0 }],
        listServers: async () => [],
        listKeyPairs: async () => [],
        listBlockStorages: async () => [],
        listVpcs: async () => [],
        listElasticIps: async () => [],
      },
    });

    expect(formatProvisionDryRun(plan)).toContain("Aruba provision dry-run. No billable resources created.");
    expect(formatProvisionDryRun(plan)).toContain("Would create: keyPair -> bootVolume -> cloudServer -> dockerComposeRuntime");
  });
});
