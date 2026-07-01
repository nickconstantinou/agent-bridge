export type SubscriptionStatus = "active" | "inactive" | "past_due" | "cancelled";

export type WorkspaceStatus =
  | "provisioning"
  | "installing_appliance"
  | "appliance_registered"
  | "ready"
  | "suspended"
  | "destroying"
  | "destroyed"
  | "failed";

export type InfrastructureStatus = "provisioned" | "destroyed" | "unknown";

export type WorkspaceEventType =
  | "workspace_created"
  | "provisioning_started"
  | "infrastructure_ready"
  | "appliance_installing"
  | "appliance_registered"
  | "heartbeat_received"
  | "workspace_ready"
  | "workspace_failed"
  | "destroy_started"
  | "workspace_destroyed";

export interface Customer {
  id: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

export interface Subscription {
  id: string;
  customerId: string;
  status: SubscriptionStatus;
  billingStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRecord {
  id: string;
  customerId: string;
  status: WorkspaceStatus;
  region: string;
  flavor: string;
  billingStatus: string;
  applianceId: string | null;
  lastHeartbeatAt: string | null;
  latestHealth: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceView {
  workspaceId: string;
  customerId: string;
  status: WorkspaceStatus;
  region: string;
  flavor: string;
  billingStatus: string;
  applianceId: string | null;
  lastHeartbeatAt: string | null;
  latestHealth: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceEvent {
  id: number;
  workspaceId: string;
  seq: number;
  type: WorkspaceEventType;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface WorkspaceInfrastructure {
  workspaceId: string;
  provider: "mock";
  status: InfrastructureStatus;
  region: string;
  flavor: string;
  serverId: string;
  elasticIpId: string;
  securityGroupId: string;
  bootVolumeId: string;
  keyPairId: string;
  tags: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface ProvisionWorkspaceInput {
  workspaceId: string;
  customerId: string;
  region: string;
  flavor: string;
}

export interface WorkspaceProvider {
  readonly name: "mock";
  estimatedMonthlyCostEur(): number;
  provisionWorkspace(input: ProvisionWorkspaceInput): Promise<Omit<WorkspaceInfrastructure, "createdAt" | "updatedAt">>;
  canDestroyWorkspace(infra: WorkspaceInfrastructure): Promise<boolean>;
  destroyWorkspace(infra: WorkspaceInfrastructure): Promise<void>;
}
