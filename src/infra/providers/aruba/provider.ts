import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import type { InfraProject, InfraResource, ReadOnlyPlanProvider } from "../../engine.js";
import type { VpsProvider, ServerConfig, VpsServer, TaggedResource } from "../../provider.js";

const API_BASE = "https://api.arubacloud.com";
const TOKEN_URL = "https://mylogin.aruba.it/auth/realms/cmp-new-apikey/protocol/openid-connect/token";

interface ArubaProviderOptions {
  apiKey?: string;
  apiSecret?: string;
  fetchImpl?: typeof fetch;
}

export interface ArubaMvpServerConfig {
  projectId: string;
  name: string;
  bootVolumeName: string;
  keyPairName: string;
  publicKeyText: string;
  location: string;
  dataCenter: string;
  image: string;
  flavor: string;
  bootVolumeSizeGb: number;
  userData?: string;
  tags: Record<string, string>;
}

export interface ArubaMvpServer {
  server: VpsServer;
  bootVolumeId: string | number;
  keyPairId: string | number;
  elasticIpId: string | number;
  securityGroupId?: string | number;
  sshRuleId?: string | number;
}

export interface ArubaMvpDestroyConfig {
  projectId: string;
  serverId: string | number;
  bootVolumeId: string | number;
  keyPairId: string | number;
  elasticIpId?: string | number;
  securityGroupId?: string | number;
}

function readSecretFile(filename: string): string {
  const secretPath = path.join(os.homedir(), ".secrets", filename);
  if (!fs.existsSync(secretPath)) return "";
  return fs.readFileSync(secretPath, "utf8").trim();
}

function metadataTagsToRecord(tags: unknown): Record<string, string> {
  if (!Array.isArray(tags)) return {};
  const record: Record<string, string> = {};
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const [key, ...rest] = tag.split("=");
    if (!key || rest.length === 0) record[tag] = "true";
    else record[key] = rest.join("=");
  }
  return record;
}

function mapResource(item: any): InfraResource {
  return {
    id: item?.metadata?.id || item?.id || "",
    name: item?.metadata?.name || item?.name || "",
    tags: metadataTagsToRecord(item?.metadata?.tags),
  };
}

function tagsToMetadata(tags: Record<string, string>): string[] {
  const compact = [
    tags.project,
    tags.environment,
    tags["managed-by"] === "agent-bridge" ? "managed-by-ab" : tags["managed-by"],
  ];
  return [...new Set(compact.filter(Boolean))];
}

function metadata(name: string, location: string, tags: Record<string, string>) {
  return {
    name,
    location: { value: location },
    tags: tagsToMetadata(tags),
  };
}

function idFromResponse(res: any): string | number {
  const id = res?.metadata?.id || res?.id;
  if (!id) throw new Error("Aruba API response did not include a resource id.");
  return id;
}

function isPrivateIp(ip: string): boolean {
  return /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^192\.168\./.test(ip);
}

function ipFromServer(server: any): string | null {
  const interfaces = server?.properties?.networkInterfaces || [];
  let fallback: string | null = null;
  for (const networkInterface of interfaces) {
    const ips: unknown[] = networkInterface?.ips || [];
    for (const candidate of ips) {
      if (typeof candidate !== "string") continue;
      if (!isPrivateIp(candidate)) return candidate;
      fallback ??= candidate;
    }
  }
  return fallback;
}

function uri(projectId: string, providerPath: string, id: string | number): string {
  return `/projects/${projectId}/${providerPath}/${id}`;
}

export class ArubaProvider implements VpsProvider {
  private apiKey: string;
  private apiSecret: string;
  private fetchImpl: typeof fetch;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(options: ArubaProviderOptions = {}) {
    this.apiKey = options.apiKey || process.env.ARUBA_API_KEY || readSecretFile("ARUBA_API_KEY.TXT");
    this.apiSecret = options.apiSecret || process.env.ARUBA_API_SECRET || readSecretFile("ARUBA_API_SECRET.TXT");
    this.fetchImpl = options.fetchImpl || fetch;
    if (!this.apiKey) throw new Error("ARUBA_API_KEY is required.");
    if (!this.apiSecret) throw new Error("ARUBA_API_SECRET is required.");
  }

  private async authenticate(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.apiKey,
      client_secret: this.apiSecret,
    });

    const response = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = await response.json().catch(() => ({})) as any;
    if (!response.ok || !json.access_token) {
      throw new Error(`Aruba auth failed (${response.status})`);
    }

    this.token = String(json.access_token);
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    this.tokenExpiresAt = Date.now() + Math.max(60, expiresIn - 60) * 1000;
    return this.token;
  }

  private async request(pathname: string, apiVersion = "1.0"): Promise<any> {
    const token = await this.authenticate();
    const url = new URL(pathname, API_BASE);
    url.searchParams.set("api-version", apiVersion);
    const response = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    const json = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      const detail = json.detail || json.title || json.error_description || JSON.stringify(json);
      throw new Error(`Aruba API error (${response.status}): ${detail}`);
    }
    return json;
  }

  private async mutation(method: string, pathname: string, apiVersion: string, body?: any): Promise<any> {
    const token = await this.authenticate();
    const url = new URL(pathname, API_BASE);
    url.searchParams.set("api-version", apiVersion);
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      const detail = json.errors
        ? `${json.detail || json.title || "validation failed"} ${JSON.stringify(json.errors)}`
        : json.detail || json.title || json.error_description || JSON.stringify(json);
      throw new Error(`Aruba API error (${response.status}): ${detail}`);
    }
    return json;
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.authenticate();
      return true;
    } catch {
      return false;
    }
  }

  async listProjects(): Promise<InfraProject[]> {
    const res = await this.request("/projects", "1.0");
    return (res.values || []).map((item: any) => ({
      id: String(item?.metadata?.id || ""),
      name: String(item?.metadata?.name || ""),
      resourcesNumber: Number(item?.properties?.resourcesNumber || 0),
    }));
  }

  async listServers(projectId: string): Promise<InfraResource[]> {
    const res = await this.request(`/projects/${projectId}/providers/Aruba.Compute/cloudServers`, "1.0");
    return (res.values || []).map(mapResource);
  }

  async listKeyPairs(projectId: string): Promise<InfraResource[]> {
    const res = await this.request(`/projects/${projectId}/providers/Aruba.Compute/keyPairs`, "1.0");
    return (res.values || []).map(mapResource);
  }

  async listBlockStorages(projectId: string): Promise<InfraResource[]> {
    const res = await this.request(`/projects/${projectId}/providers/Aruba.Storage/blockStorages`, "1.0");
    return (res.values || []).map(mapResource);
  }

  async listVpcs(projectId: string): Promise<InfraResource[]> {
    const res = await this.request(`/projects/${projectId}/providers/Aruba.Network/vpcs`, "1.0");
    return (res.values || []).map(mapResource);
  }

  async listElasticIps(projectId: string): Promise<InfraResource[]> {
    const res = await this.request(`/projects/${projectId}/providers/Aruba.Network/elasticIps`, "1.0");
    return (res.values || []).map(mapResource);
  }

  private async findDefaultNetwork(projectId: string): Promise<{
    vpcUri: string;
    subnetUris: string[];
    securityGroupUris: string[];
  } | null> {
    const vpcs = await this.listVpcs(projectId);
    const vpc = vpcs[0];
    if (!vpc) return null;
    const [subnetRes, securityGroupRes] = await Promise.all([
      this.request(`/projects/${projectId}/providers/Aruba.Network/vpcs/${vpc.id}/subnets`, "1.0"),
      this.request(`/projects/${projectId}/providers/Aruba.Network/vpcs/${vpc.id}/securityGroups`, "1.0"),
    ]);
    const subnets = (subnetRes.values || []).map(mapResource);
    const securityGroups = (securityGroupRes.values || []).map(mapResource);
    return {
      vpcUri: uri(projectId, "providers/Aruba.Network/vpcs", vpc.id),
      subnetUris: subnets.map((item: InfraResource) => uri(projectId, `providers/Aruba.Network/vpcs/${vpc.id}/subnets`, item.id)),
      securityGroupUris: securityGroups.map((item: InfraResource) => uri(projectId, `providers/Aruba.Network/vpcs/${vpc.id}/securityGroups`, item.id)),
    };
  }

  async createSecurityGroup(
    projectId: string,
    vpcId: string | number,
    name: string,
    location: string,
    tags: Record<string, string>
  ): Promise<string | number> {
    const res = await this.mutation(
      "POST",
      `/projects/${projectId}/providers/Aruba.Network/vpcs/${vpcId}/securityGroups`,
      "1.0",
      {
        metadata: metadata(name, location, tags),
        properties: {},
      }
    );
    return idFromResponse(res);
  }

  async createSecurityRule(
    projectId: string,
    vpcId: string | number,
    sgId: string | number,
    name: string,
    properties: {
      direction: "Ingress" | "Egress";
      protocol: "TCP" | "UDP" | "ICMP" | "Any";
      port: string;
      target: {
        kind: "Ip" | "SecurityGroup";
        value: string;
      };
    },
    location: string,
    tags: Record<string, string>
  ): Promise<string | number> {
    const res = await this.mutation(
      "POST",
      `/projects/${projectId}/providers/Aruba.Network/vpcs/${vpcId}/securityGroups/${sgId}/securityRules`,
      "1.0",
      {
        metadata: metadata(name, location, tags),
        properties,
      }
    );
    return idFromResponse(res);
  }

  async deleteSecurityRule(
    projectId: string,
    vpcId: string | number,
    sgId: string | number,
    ruleId: string | number
  ): Promise<void> {
    try {
      await this.mutation(
        "DELETE",
        `/projects/${projectId}/providers/Aruba.Network/vpcs/${vpcId}/securityGroups/${sgId}/securityRules/${ruleId}`,
        "1.0"
      );
    } catch (err: any) {
      if (!err.message.includes("(404)")) throw err;
    }
  }

  async deleteSecurityGroup(
    projectId: string,
    vpcId: string | number,
    sgId: string | number
  ): Promise<void> {
    try {
      await this.mutation(
        "DELETE",
        `/projects/${projectId}/providers/Aruba.Network/vpcs/${vpcId}/securityGroups/${sgId}`,
        "1.0"
      );
    } catch (err: any) {
      if (!err.message.includes("(404)")) throw err;
    }
  }

  async createMvpServer(config: ArubaMvpServerConfig): Promise<ArubaMvpServer> {
    const keyPair = await this.mutation("POST", `/projects/${config.projectId}/providers/Aruba.Compute/keyPairs`, "1.0", {
      metadata: metadata(config.keyPairName, config.location, config.tags),
      properties: { value: config.publicKeyText },
    });
    const keyPairId = idFromResponse(keyPair);

    const bootVolume = await this.mutation("POST", `/projects/${config.projectId}/providers/Aruba.Storage/blockStorages`, "1.0", {
      metadata: metadata(config.bootVolumeName, config.location, config.tags),
      properties: {
        sizeGb: config.bootVolumeSizeGb,
        billingPeriod: "Hour",
        dataCenter: config.dataCenter,
        type: "Standard",
        bootable: true,
        image: config.image,
      },
    });
    const bootVolumeId = idFromResponse(bootVolume);

    // Pre-create EIP so we can pass its URI explicitly at server creation time.
    const eip = await this.mutation("POST", `/projects/${config.projectId}/providers/Aruba.Network/elasticIps`, "1.0", {
      metadata: metadata(config.name + "-eip", config.location, config.tags),
      properties: { dataCenter: config.dataCenter },
    });
    const elasticIpId = idFromResponse(eip);
    const eipUri = `/projects/${config.projectId}/providers/Aruba.Network/elasticIps/${elasticIpId}`;
    const elasticIpAddress: string | null = eip?.properties?.address || eip?.properties?.ipAddress || null;

    const network = await this.findDefaultNetwork(config.projectId);
    let securityGroupId: string | number | undefined;
    let sshRuleId: string | number | undefined;
    let networkProperties: any;

    if (network) {
      const vpcId = network.vpcUri.split("/").pop()!;
      securityGroupId = await this.createSecurityGroup(
        config.projectId,
        vpcId,
        config.name + "-sg",
        config.location,
        config.tags
      );

      sshRuleId = await this.createSecurityRule(
        config.projectId,
        vpcId,
        securityGroupId,
        config.name + "-allow-ssh",
        {
          direction: "Ingress",
          protocol: "TCP",
          port: "22",
          target: {
            kind: "Ip",
            value: "0.0.0.0/0",
          },
        },
        config.location,
        config.tags
      );

      const sgUri = `/projects/${config.projectId}/providers/Aruba.Network/vpcs/${vpcId}/securityGroups/${securityGroupId}`;

      networkProperties = {
        vpcPreset: false,
        vpc: { uri: network.vpcUri },
        subnets: network.subnetUris.map(item => ({ uri: item })),
        securityGroups: [{ uri: sgUri }],
        elasticIp: { uri: eipUri },
      };
    } else {
      networkProperties = { vpcPreset: true, addElasticIp: true };
    }

    const server = await this.mutation("POST", `/projects/${config.projectId}/providers/Aruba.Compute/cloudServers`, "1.1", {
      metadata: metadata(config.name, config.location, config.tags),
      properties: {
        dataCenter: config.dataCenter,
        ...networkProperties,
        flavorName: config.flavor,
        bootVolume: {
          uri: `/projects/${config.projectId}/providers/Aruba.Storage/blockStorages/${bootVolumeId}`,
        },
        keyPair: {
          uri: `/projects/${config.projectId}/providers/Aruba.Compute/keyPairs/${keyPairId}`,
        },
        userData: config.userData,
      },
    });
    const serverId = idFromResponse(server);

    return {
      server: {
        id: serverId,
        name: server?.metadata?.name || config.name,
        status: server?.status?.state || "creating",
        ipAddress: ipFromServer(server) || elasticIpAddress,
        tags: config.tags,
      },
      bootVolumeId,
      keyPairId,
      elasticIpId,
      securityGroupId,
      sshRuleId,
    };
  }

  async getMvpServer(projectId: string, serverId: string | number): Promise<VpsServer | null> {
    try {
      const server = await this.request(`/projects/${projectId}/providers/Aruba.Compute/cloudServers/${serverId}`, "1.0");
      let ipAddress = ipFromServer(server);
      if (!ipAddress) {
        // Look for an EIP in linkedResources
        const linkedResources: Array<{ uri: string }> = server?.properties?.linkedResources || [];
        const eipUri = linkedResources.find(r => r.uri?.includes("/elasticIps/"))?.uri;
        if (eipUri) {
          try {
            const eip = await this.request(eipUri.replace(/^\//, ""), "1.0");
            ipAddress = eip?.properties?.address || null;
          } catch { /* ignore EIP lookup failure */ }
        }
      }
      return {
        id: idFromResponse(server),
        name: server?.metadata?.name || String(serverId),
        status: server?.status?.state || "unknown",
        ipAddress,
        tags: metadataTagsToRecord(server?.metadata?.tags),
      };
    } catch (err: any) {
      if (err.message.includes("(404)")) return null;
      throw err;
    }
  }

  async destroyMvpServer(config: ArubaMvpDestroyConfig): Promise<void> {
    try {
      await this.mutation("DELETE", `/projects/${config.projectId}/providers/Aruba.Compute/cloudServers/${config.serverId}`, "1.0");
    } catch (err: any) {
      if (!err.message.includes("(404)")) throw err;
    }
    if (config.elasticIpId != null) {
      try {
        await this.mutation("DELETE", `/projects/${config.projectId}/providers/Aruba.Network/elasticIps/${config.elasticIpId}`, "1.0");
      } catch (err: any) {
        if (!err.message.includes("(404)")) throw err;
      }
    }
    await this.mutation("DELETE", `/projects/${config.projectId}/providers/Aruba.Storage/blockStorages/${config.bootVolumeId}`, "1.0");
    await this.mutation("DELETE", `/projects/${config.projectId}/providers/Aruba.Compute/keyPairs/${config.keyPairId}`, "1.0");

    if (config.securityGroupId != null) {
      const network = await this.findDefaultNetwork(config.projectId);
      if (network) {
        const vpcId = network.vpcUri.split("/").pop()!;
        await this.deleteSecurityGroup(config.projectId, vpcId, config.securityGroupId);
      }
    }
  }

  async createServer(config: ServerConfig): Promise<VpsServer> {
    throw new Error("ArubaProvider: createServer is not implemented. See API Gap Analysis in source file.");
  }

  async getServer(serverId: string | number): Promise<VpsServer | null> {
    throw new Error("ArubaProvider: getServer is not implemented.");
  }

  async listServersByTags(tags: Record<string, string>): Promise<VpsServer[]> {
    throw new Error("ArubaProvider: listServersByTags is not implemented.");
  }

  async listFirewallsByTags(tags: Record<string, string>): Promise<TaggedResource[]> {
    throw new Error("ArubaProvider: listFirewallsByTags is not implemented.");
  }

  async listSSHKeysByTags(tags: Record<string, string>): Promise<TaggedResource[]> {
    throw new Error("ArubaProvider: listSSHKeysByTags is not implemented.");
  }

  async createFirewall(name: string, allowedPorts: number[], tags: Record<string, string>): Promise<string | number> {
    throw new Error("ArubaProvider: createFirewall is not implemented.");
  }

  async attachFirewall(serverId: string | number, firewallId: string | number): Promise<void> {
    throw new Error("ArubaProvider: attachFirewall is not implemented.");
  }

  async provisionSSHKey(name: string, publicKeyText: string, tags: Record<string, string>): Promise<string | number> {
    throw new Error("ArubaProvider: provisionSSHKey is not implemented.");
  }

  private runRemote(ip: string, privateKeyPath: string, command: string, user = "root"): string {
    const sshCmd = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i "${privateKeyPath}" ${user}@${ip} "${command.replace(/"/g, '\\"')}"`;
    return execSync(sshCmd, { encoding: "utf8" });
  }

  private copyRemote(ip: string, privateKeyPath: string, localPath: string, remotePath: string, user = "root") {
    const scpCmd = `scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i "${privateKeyPath}" "${localPath}" ${user}@${ip}:${remotePath}`;
    execSync(scpCmd);
  }

  async bootstrapServer(ip: string, localEnvPath: string, localProjectPath: string, privateKeyPath: string): Promise<void> {
    // 1. Pack project files
    const archivePath = path.join(localProjectPath, "agent-bridge-deploy.tar.gz");
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);

    execSync(`tar -czf "${archivePath}" --exclude=node_modules --exclude=.git --exclude=.agent-bridge --exclude=.data --exclude=*.sqlite --exclude=*.tar.gz -C "${localProjectPath}" .`);

    // 2. Wait for SSH as root
    let retries = 15;
    while (retries > 0) {
      try {
        this.runRemote(ip, privateKeyPath, "echo SSH OK", "root");
        break;
      } catch {
        retries--;
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    if (retries === 0) {
      throw new Error("SSH timed out for bootstrap.");
    }

    // 3. Upload archive, and compose/env files.
    try {
      this.copyRemote(ip, privateKeyPath, archivePath, "/tmp/agent-bridge-deploy.tar.gz", "root");
      this.copyRemote(ip, privateKeyPath, localEnvPath, "/tmp/agent-bridge.env", "root");
    } finally {
      if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    }

    // 4. Setup directories, extract project, and run install
    this.runRemote(ip, privateKeyPath, "mkdir -p /opt/agent-bridge && tar -xzf /tmp/agent-bridge-deploy.tar.gz -C /opt/agent-bridge", "root");
    this.runRemote(ip, privateKeyPath, "mkdir -p /etc/agent-bridge && mv /tmp/agent-bridge.env /etc/agent-bridge/agent-bridge.env", "root");
    this.runRemote(ip, privateKeyPath, "chmod 0600 /etc/agent-bridge/agent-bridge.env", "root");

    // Run the appliance installation script
    this.runRemote(ip, privateKeyPath, "cd /opt/agent-bridge && npm ci --prefer-offline && npx tsx scripts/appliance.ts appliance install", "root");
  }

  async getStatus(serverId: string | number, ip: string, privateKeyPath: string): Promise<string> {
    try {
      const remoteState = this.runRemote(ip, privateKeyPath, "systemctl status agent-bridge --no-pager && ufw status", "root");
      return `Aruba VM Status: Running\nAppliance/UFW State:\n${remoteState}`;
    } catch (err: any) {
      return `Aruba VM Status: Running (Service not running or SSH failed: ${err.message})`;
    }
  }

  async getLogs(serverId: string | number, ip: string, privateKeyPath: string): Promise<string> {
    return this.runRemote(ip, privateKeyPath, "journalctl -u agent-bridge -n 100 --no-pager", "root");
  }

  async destroyServer(serverId: string | number): Promise<void> {
    throw new Error("ArubaProvider: destroyServer is not implemented.");
  }

  async destroyFirewall(firewallId: string | number): Promise<void> {
    throw new Error("ArubaProvider: destroyFirewall is not implemented.");
  }

  async destroySSHKey(sshKeyId: string | number): Promise<void> {
    throw new Error("ArubaProvider: destroySSHKey is not implemented.");
  }
}
