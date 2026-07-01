# Implementation Plan: Provider-Agnostic VPS Orchestration Spike

We have successfully prototyped a provider-agnostic infrastructure orchestration layer for secure Agent Bridge control/worker node deployment.

## Achieved Spike Milestones

1. **Provider Abstraction**: Established the unified `VpsProvider` interface (`src/infra/provider.ts`) defining crucial lifecycle operations.
2. **Hetzner Provider MVP**: Completed `HetznerProvider` (`src/infra/providers/hetzner/provider.ts`) implementing server, SSH key, and firewall provisioning via standard REST API + cloud-init.
3. **Aruba Cloud Gap Analysis**: Added the `ArubaProvider` stub (`src/infra/providers/aruba/provider.ts`) along with a full analysis of the API gaps to address next.
4. **CLI Integration**: Built a unified `scripts/infra.ts` tool to provision/deploy/status/logs/teardown resources using `--provider <hetzner|aruba>`.

---

## Technical Architecture

### 1. Unified Interface (`src/infra/provider.ts`)
```typescript
export interface VpsProvider {
  validateCredentials(): Promise<boolean>;
  createServer(config: ServerConfig): Promise<VpsServer>;
  getServer(serverId: string | number): Promise<VpsServer | null>;
  listServersByTags(tags: Record<string, string>): Promise<VpsServer[]>;
  createFirewall(name: string, allowedPorts: number[], tags: Record<string, string>): Promise<string | number>;
  attachFirewall(serverId: string | number, firewallId: string | number): Promise<void>;
  provisionSSHKey(name: string, publicKeyText: string, tags: Record<string, string>): Promise<string | number>;
  bootstrapServer(ip: string, localEnvPath: string, localProjectPath: string, privateKeyPath: string): Promise<void>;
  getStatus(serverId: string | number, ip: string, privateKeyPath: string): Promise<string>;
  getLogs(serverId: string | number, ip: string, privateKeyPath: string): Promise<string>;
  destroyServer(serverId: string | number): Promise<void>;
  destroyFirewall(firewallId: string | number): Promise<void>;
  destroySSHKey(sshKeyId: string | number): Promise<void>;
}
```

### 2. Aruba Cloud VPS API Analysis (`src/infra/providers/aruba/provider.ts`)
- **Authentication**: REST uses SOAP WS-Security or OAuth2 tokens; Pro/OpenStack hypervisors support standard Keystone API credentials.
- **Server Creation**: REST `POST /api/v1/servers` or OpenStack `/v2.1/servers`.
- **SSH Keys**: Pushed via template metadata on basic Smart VPS; Pro hypervisors support Neutron Nova keypairs.
- **Firewalls**: SMART tier lacks edge firewalls; Pro tier uses Neutron Security Groups. Requires OS-level firewall fallback (UFW).
- **Tagging**: SMART tier has no custom tag support (requires name-prefix conventions); Pro tier supports metadata tagging.
- **Teardown**: Pro VMs must be stopped before deletion; Smart VMs delete instantly.

---

## Production Rollout Plan

- **Phase 1: CLI Configuration**: Bind provider settings directly to local Typed configurations in `agent-bridge`.
- **Phase 2: Private Networking (Tailscale)**: Automate Tailscale installation via cloud-init and restrict SSH firewalling to private meshes.
- **Phase 3: Secrets Encryption**: Secure env transfers by utilizing encrypted secret payloads rather than unencrypted scp transfers.
- **Phase 4: Docker Compose Stack**: Migrate runtime services into Docker Compose on the host.
- **Phase 5: Aruba Implementation**: Implement `ArubaProvider` utilizing OpenStack Keystone and Nova client APIs.
