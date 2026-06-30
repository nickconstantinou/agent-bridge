import fs from "node:fs";
import path from "node:path";

export interface WorkspaceState {
  workspaceId: string;
  customerId: string;
  repo: string;
  branch: string;
  domain: string;
  status: "creating" | "bootstrap" | "ready" | "failed" | "destroying";
  provider: string;
  projectId?: string;
  serverId: string | number;
  serverName: string;
  firewallId: string | number;
  sshKeyId: string | number;
  bootVolumeId?: string | number;
  elasticIpId?: string | number;
  ip: string | null;
  managementIp?: string | null;
  region: string;
  serverType: string;
  image?: string;
  createdAt: string;
  updatedAt: string;
  tags: Record<string, string>;
  lastHeartbeatAt?: string;
  sshRuleId?: string | number;

  setupToken?: {
    token: string;
    expiresAt: string;
    used: boolean;
  };
  sessionToken?: {
    token: string;
    expiresAt: string;
    used: boolean;
  };
  githubConnected?: boolean;
  chatConnected?: boolean;
  chatChannel?: "telegram" | "discord";
  chatId?: string;
  cliAuthenticated?: boolean;
}

export type InfraState = WorkspaceState;

export function defaultStatePath(projectDir: string): string {
  return path.join(projectDir, ".agent-bridge", "workspace-state.json");
}

export function readWorkspaceState(statePath: string): WorkspaceState | null {
  if (!fs.existsSync(statePath)) return null;
  const raw = fs.readFileSync(statePath, "utf8");
  return JSON.parse(raw) as WorkspaceState;
}

export function writeWorkspaceState(statePath: string, state: WorkspaceState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function deleteWorkspaceState(statePath: string): void {
  if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
}

// Retain old functions for compatibility
export const readInfraState = readWorkspaceState as (statePath: string) => InfraState | null;
export const writeInfraState = writeWorkspaceState as (statePath: string, state: InfraState) => void;
export const deleteInfraState = deleteWorkspaceState as (statePath: string) => void;

export function tagsMatch(actual: Record<string, string>, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

