import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { VpsProvider, ServerConfig, VpsServer, TaggedResource } from "../../provider.js";

const API_BASE = "https://api.hetzner.cloud/v1";

export class HetznerProvider implements VpsProvider {
  private token: string;

  constructor(token: string) {
    if (!token) {
      throw new Error("HETZNER_API_TOKEN is required for HetznerProvider.");
    }
    this.token = token;
  }

  private async request(method: string, endpoint: string, body?: any): Promise<any> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json"
    };

    const response = await fetch(`${API_BASE}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Hetzner API error (${response.status}): ${JSON.stringify(json)}`);
    }
    return json;
  }

  private runRemote(ip: string, privateKeyPath: string, command: string, user = "agentbridge"): string {
    const sshCmd = `ssh -o StrictHostKeyChecking=no -i "${privateKeyPath}" ${user}@${ip} "${command.replace(/"/g, '\\"')}"`;
    return execSync(sshCmd, { encoding: "utf8" });
  }

  private copyRemote(ip: string, privateKeyPath: string, localPath: string, remotePath: string, user = "agentbridge") {
    const scpCmd = `scp -o StrictHostKeyChecking=no -i "${privateKeyPath}" "${localPath}" ${user}@${ip}:${remotePath}`;
    execSync(scpCmd);
  }

  private async waitForAction(actionId: string | number): Promise<void> {
    while (true) {
      const act = await this.request("GET", `/actions/${actionId}`);
      if (act.action.status === "success") return;
      if (act.action.status === "error") throw new Error(`Hetzner action failed: ${act.action.error.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.request("GET", "/servers");
      return true;
    } catch {
      return false;
    }
  }

  async createServer(config: ServerConfig): Promise<VpsServer> {
    const createServerRes = await this.request("POST", "/servers", {
      name: config.name,
      server_type: config.serverType,
      image: config.image,
      location: config.region,
      ssh_keys: [config.sshKeyId],
      firewalls: config.firewallId ? [{ firewall: config.firewallId }] : undefined,
      user_data: config.userData,
      labels: config.tags
    });

    const actionId = createServerRes.action.id;
    let server = createServerRes.server;

    await this.waitForAction(actionId);

    // Poll IP
    while (true) {
      const s = await this.request("GET", `/servers/${server.id}`);
      if (s.server.public_net?.ipv4?.ip) {
        server = s.server;
        break;
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    return {
      id: server.id,
      name: server.name,
      status: server.status,
      ipAddress: server.public_net.ipv4.ip,
      tags: server.labels
    };
  }

  async getServer(serverId: string | number): Promise<VpsServer | null> {
    try {
      const res = await this.request("GET", `/servers/${serverId}`);
      const server = res.server;
      return {
        id: server.id,
        name: server.name,
        status: server.status,
        ipAddress: server.public_net?.ipv4?.ip || null,
        tags: server.labels
      };
    } catch (err: any) {
      if (err.message.includes("404")) return null;
      throw err;
    }
  }

  async listServersByTags(tags: Record<string, string>): Promise<VpsServer[]> {
    const res = await this.request("GET", "/servers");
    const servers = res.servers.filter((s: any) => {
      return Object.entries(tags).every(([k, v]) => s.labels[k] === v);
    });
    return servers.map((s: any) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      ipAddress: s.public_net?.ipv4?.ip || null,
      tags: s.labels
    }));
  }

  async listFirewallsByTags(tags: Record<string, string>): Promise<TaggedResource[]> {
    const res = await this.request("GET", "/firewalls");
    return res.firewalls
      .filter((fw: any) => Object.entries(tags).every(([k, v]) => fw.labels[k] === v))
      .map((fw: any) => ({ id: fw.id, name: fw.name, tags: fw.labels }));
  }

  async listSSHKeysByTags(tags: Record<string, string>): Promise<TaggedResource[]> {
    const res = await this.request("GET", "/ssh_keys");
    return res.ssh_keys
      .filter((key: any) => Object.entries(tags).every(([k, v]) => key.labels[k] === v))
      .map((key: any) => ({ id: key.id, name: key.name, tags: key.labels }));
  }

  async createFirewall(name: string, allowedPorts: number[], tags: Record<string, string>): Promise<string | number> {
    const existing = await this.listFirewallsByTags(tags);
    const named = existing.find(fw => fw.name === name);
    if (named) return named.id;

    const rules = allowedPorts.map(port => ({
      direction: "in",
      protocol: "tcp",
      port: String(port),
      source_ips: ["0.0.0.0/0", "::/0"],
      description: `Allow TCP port ${port}`
    }));

    const res = await this.request("POST", "/firewalls", {
      name,
      rules,
      labels: tags
    });
    return res.firewall.id;
  }

  async attachFirewall(serverId: string | number, firewallId: string | number): Promise<void> {
    // For Hetzner, this action is typically performed during creation, or via action API.
    // In our provision flow, it's attached during server creation. If need to attach dynamically:
    await this.request("POST", `/firewalls/${firewallId}/actions/apply_to_resources`, {
      apply_to: [
        {
          type: "server",
          server: { id: Number(serverId) }
        }
      ]
    });
  }

  async provisionSSHKey(name: string, publicKeyText: string, tags: Record<string, string>): Promise<string | number> {
    const res = await this.request("GET", "/ssh_keys");
    const existing = res.ssh_keys.find((k: any) => k.public_key.trim() === publicKeyText.trim());
    if (existing) {
      const hasTags = Object.entries(tags).every(([key, value]) => existing.labels[key] === value);
      if (!hasTags) {
        await this.request("PUT", `/ssh_keys/${existing.id}`, {
          name: existing.name || name,
          labels: { ...existing.labels, ...tags }
        });
      }
      return existing.id;
    }

    const createRes = await this.request("POST", "/ssh_keys", {
      name,
      public_key: publicKeyText,
      labels: tags
    });
    return createRes.ssh_key.id;
  }

  async bootstrapServer(ip: string, localEnvPath: string, localProjectPath: string, privateKeyPath: string): Promise<void> {
    // 1. Pack project files
    const archivePath = path.join(localProjectPath, "agent-bridge-deploy.tar.gz");
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);

    execSync(`tar -czf "${archivePath}" --exclude=node_modules --exclude=.git --exclude=.agent-bridge --exclude=.data --exclude=*.sqlite --exclude=*.tar.gz -C "${localProjectPath}" .`);

    // 2. Wait for SSH
    let retries = 15;
    while (retries > 0) {
      try {
        this.runRemote(ip, privateKeyPath, "echo SSH OK");
        break;
      } catch {
        retries--;
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    if (retries === 0) {
      throw new Error("SSH timed out for bootstrap.");
    }

    // 3. Upload archive, compose file, and allowlisted env file.
    this.copyRemote(ip, privateKeyPath, archivePath, "/tmp/agent-bridge-deploy.tar.gz");
    this.copyRemote(ip, privateKeyPath, localEnvPath, "/tmp/agent-bridge.env");
    fs.unlinkSync(archivePath);

    // 4. Setup, permissions, Docker Compose runtime.
    this.runRemote(ip, privateKeyPath, "sudo rm -rf /opt/agent-bridge/* && sudo tar -xzf /tmp/agent-bridge-deploy.tar.gz -C /opt/agent-bridge");
    this.runRemote(ip, privateKeyPath, "sudo mv /tmp/agent-bridge.env /etc/agent-bridge/agent-bridge.env");
    this.runRemote(ip, privateKeyPath, "sudo chown root:root /etc/agent-bridge/agent-bridge.env && sudo chmod 0600 /etc/agent-bridge/agent-bridge.env");
    this.runRemote(ip, privateKeyPath, "sudo chown -R agentbridge:agentbridge /opt/agent-bridge /var/lib/agent-bridge /var/log/agent-bridge");
    this.runRemote(ip, privateKeyPath, "sudo -u agentbridge mkdir -p /var/lib/agent-bridge/data /var/log/agent-bridge");
    this.runRemote(ip, privateKeyPath, "cd /opt/agent-bridge && sudo docker compose -f docker-compose.agent-bridge.yml up -d --build");
  }

  async getManagementIp(ip: string, privateKeyPath: string): Promise<string | null> {
    try {
      const tailscaleIp = this.runRemote(ip, privateKeyPath, "tailscale ip -4 2>/dev/null || true").trim();
      return tailscaleIp || null;
    } catch {
      return null;
    }
  }

  async getStatus(serverId: string | number, ip: string, privateKeyPath: string): Promise<string> {
    try {
      const remoteState = this.runRemote(ip, privateKeyPath, "docker --version && docker compose version && cd /opt/agent-bridge && sudo docker compose -f docker-compose.agent-bridge.yml ps && sudo ufw status");
      return `Hetzner VM Status: Running\nCompose/UFW State:\n${remoteState}`;
    } catch (err: any) {
      return `Hetzner VM Status: Running (Service not running or SSH failed: ${err.message})`;
    }
  }

  async getLogs(serverId: string | number, ip: string, privateKeyPath: string): Promise<string> {
    return this.runRemote(ip, privateKeyPath, "cd /opt/agent-bridge && sudo docker compose -f docker-compose.agent-bridge.yml logs --tail=100 --no-color agent-bridge-worker");
  }

  async destroyServer(serverId: string | number): Promise<void> {
    await this.request("DELETE", `/servers/${serverId}`);
    // Wait for deletion
    while (true) {
      try {
        await this.request("GET", `/servers/${serverId}`);
        await new Promise(r => setTimeout(r, 2000));
      } catch {
        break; // 404
      }
    }
  }

  async destroyFirewall(firewallId: string | number): Promise<void> {
    await this.request("DELETE", `/firewalls/${firewallId}`);
  }

  async destroySSHKey(sshKeyId: string | number): Promise<void> {
    await this.request("DELETE", `/ssh_keys/${sshKeyId}`);
  }
}
