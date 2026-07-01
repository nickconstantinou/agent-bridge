import { randomUUID } from "node:crypto";
import { ControlPlaneStore } from "./state.js";
import type { WorkspaceProvider, WorkspaceView } from "./types.js";

export interface WorkspaceServiceConfig {
  maxMonthlyBudgetEur: number;
}

export interface CreateWorkspaceInput {
  customerId: string;
  region: string;
  flavor?: string;
}

export interface CreatedWorkspaceView extends WorkspaceView {
  bootstrapToken: string;
}

export interface ApplianceRegistration {
  workspaceId: string;
  applianceId: string;
  status: string;
}

function toWorkspaceView(workspace: ReturnType<ControlPlaneStore["requireWorkspace"]>): WorkspaceView {
  return {
    workspaceId: workspace.id,
    customerId: workspace.customerId,
    status: workspace.status,
    region: workspace.region,
    flavor: workspace.flavor,
    billingStatus: workspace.billingStatus,
    applianceId: workspace.applianceId,
    lastHeartbeatAt: workspace.lastHeartbeatAt,
    latestHealth: workspace.latestHealth,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

export class WorkspaceService {
  constructor(
    private store: ControlPlaneStore,
    private provider: WorkspaceProvider,
    private config: WorkspaceServiceConfig,
  ) {}

  async createWorkspace(input: CreateWorkspaceInput): Promise<CreatedWorkspaceView> {
    const flavor = input.flavor || "CSO1A2";
    if (flavor !== "CSO1A2") throw new Error("only CSO1A2 workspaces are allowed");
    if (this.provider.estimatedMonthlyCostEur() > this.config.maxMonthlyBudgetEur) {
      throw new Error("estimated monthly infra cost exceeds configured budget");
    }
    if (!this.store.hasActiveSubscription(input.customerId)) {
      throw new Error("active subscription required");
    }
    if (this.store.findCustomerWorkspace(input.customerId)) {
      throw new Error("customer already has a workspace");
    }

    const workspaceId = `ws_${randomUUID()}`;
    let workspace = this.store.createWorkspace({
      id: workspaceId,
      customerId: input.customerId,
      status: "provisioning",
      region: input.region,
      flavor,
    });
    this.store.addWorkspaceEvent(workspaceId, "workspace_created", { customerId: input.customerId });
    this.store.addWorkspaceEvent(workspaceId, "provisioning_started", { provider: this.provider.name });

    try {
      const infra = await this.provider.provisionWorkspace({
        workspaceId,
        customerId: input.customerId,
        region: input.region,
        flavor,
      });
      this.store.createInfrastructure(infra);
      this.store.addWorkspaceEvent(workspaceId, "infrastructure_ready", { provider: this.provider.name });

      workspace = this.store.updateWorkspaceStatus(workspaceId, "installing_appliance");
      this.store.addWorkspaceEvent(workspaceId, "appliance_installing");
      const bootstrapToken = `bt_${randomUUID()}`;
      this.store.createBootstrapToken({
        token: bootstrapToken,
        workspaceId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      return { ...toWorkspaceView(workspace), bootstrapToken };
    } catch (err) {
      this.store.updateWorkspaceStatus(workspaceId, "failed");
      this.store.addWorkspaceEvent(workspaceId, "workspace_failed", { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  getWorkspace(workspaceId: string): WorkspaceView {
    return toWorkspaceView(this.store.requireWorkspace(workspaceId));
  }

  getWorkspaceEvents(workspaceId: string) {
    this.store.requireWorkspace(workspaceId);
    return this.store.listWorkspaceEvents(workspaceId);
  }

  async registerAppliance(input: { bootstrapToken: string }): Promise<ApplianceRegistration> {
    const consumed = this.store.consumeBootstrapToken(input.bootstrapToken);
    if (!consumed) throw new Error("Invalid, expired, or already used bootstrap token");
    const applianceId = `appliance_${randomUUID()}`;
    const workspace = this.store.setApplianceRegistered(consumed.workspaceId, applianceId);
    this.store.addWorkspaceEvent(workspace.id, "appliance_registered", { applianceId });
    return { workspaceId: workspace.id, applianceId, status: workspace.status };
  }

  async recordHeartbeat(input: {
    workspaceId: string;
    applianceId: string;
    health: Record<string, unknown>;
  }): Promise<WorkspaceView> {
    const workspace = this.store.requireWorkspace(input.workspaceId);
    if (workspace.applianceId !== input.applianceId) throw new Error("appliance is not registered for workspace");
    this.store.addWorkspaceEvent(input.workspaceId, "heartbeat_received", { applianceId: input.applianceId });
    const updated = this.store.updateHeartbeat(input.workspaceId, input.health);
    if (workspace.status !== "ready") {
      this.store.addWorkspaceEvent(input.workspaceId, "workspace_ready");
    }
    return toWorkspaceView(updated);
  }

  async destroyWorkspace(workspaceId: string): Promise<WorkspaceView> {
    this.store.requireWorkspace(workspaceId);
    const infra = this.store.getInfrastructure(workspaceId);
    if (!infra || infra.status !== "provisioned" || !(await this.provider.canDestroyWorkspace(infra))) {
      this.store.updateWorkspaceStatus(workspaceId, "failed");
      this.store.addWorkspaceEvent(workspaceId, "workspace_failed", { error: "unknown infrastructure state" });
      throw new Error("unknown infrastructure state");
    }

    this.store.updateWorkspaceStatus(workspaceId, "destroying");
    this.store.addWorkspaceEvent(workspaceId, "destroy_started");
    await this.provider.destroyWorkspace(infra);
    this.store.updateInfrastructureStatus(workspaceId, "destroyed");
    const destroyed = this.store.updateWorkspaceStatus(workspaceId, "destroyed");
    this.store.addWorkspaceEvent(workspaceId, "workspace_destroyed");
    return toWorkspaceView(destroyed);
  }
}
