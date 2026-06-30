export interface ServerConfig {
  name: string;
  serverType: string;
  image: string;
  region: string;
  sshKeyId: string | number;
  firewallId?: string | number;
  userData?: string;
  tags: Record<string, string>;
}

export interface VpsServer {
  id: string | number;
  name: string;
  status: string;
  ipAddress: string | null;
  tags: Record<string, string>;
}

export interface TaggedResource {
  id: string | number;
  name: string;
  tags: Record<string, string>;
}

export interface VpsProvider {
  validateCredentials(): Promise<boolean>;
  createServer(config: ServerConfig): Promise<VpsServer>;
  getServer(serverId: string | number): Promise<VpsServer | null>;
  listServersByTags(tags: Record<string, string>): Promise<VpsServer[]>;
  listFirewallsByTags(tags: Record<string, string>): Promise<TaggedResource[]>;
  listSSHKeysByTags(tags: Record<string, string>): Promise<TaggedResource[]>;
  createFirewall(name: string, allowedPorts: number[], tags: Record<string, string>): Promise<string | number>;
  attachFirewall(serverId: string | number, firewallId: string | number): Promise<void>;
  provisionSSHKey(name: string, publicKeyText: string, tags: Record<string, string>): Promise<string | number>;
  bootstrapServer(ip: string, localEnvPath: string, localProjectPath: string, privateKeyPath: string): Promise<void>;
  getManagementIp?(ip: string, privateKeyPath: string): Promise<string | null>;
  getStatus(serverId: string | number, ip: string, privateKeyPath: string): Promise<string>;
  getLogs(serverId: string | number, ip: string, privateKeyPath: string): Promise<string>;
  destroyServer(serverId: string | number): Promise<void>;
  destroyFirewall(firewallId: string | number): Promise<void>;
  destroySSHKey(sshKeyId: string | number): Promise<void>;
}
