import type { ProvisionWorkspaceInput, WorkspaceInfrastructure, WorkspaceProvider } from "./types.js";

export class MockWorkspaceProvider implements WorkspaceProvider {
  readonly name = "mock" as const;
  readonly destroyedWorkspaceIds: string[] = [];
  failProvision = false;
  private provisioned = new Set<string>();

  estimatedMonthlyCostEur(): number {
    return 5;
  }

  async provisionWorkspace(input: ProvisionWorkspaceInput): Promise<Omit<WorkspaceInfrastructure, "createdAt" | "updatedAt">> {
    if (this.failProvision) throw new Error("mock provisioning failed");
    this.provisioned.add(input.workspaceId);
    return {
      workspaceId: input.workspaceId,
      provider: "mock",
      status: "provisioned",
      region: input.region,
      flavor: input.flavor,
      serverId: `mock-server-${input.workspaceId}`,
      elasticIpId: `mock-eip-${input.workspaceId}`,
      securityGroupId: `mock-sg-${input.workspaceId}`,
      bootVolumeId: `mock-boot-${input.workspaceId}`,
      keyPairId: `mock-key-${input.workspaceId}`,
      tags: {
        project: "agent-bridge",
        customerId: input.customerId,
        workspaceId: input.workspaceId,
      },
    };
  }

  async canDestroyWorkspace(infra: WorkspaceInfrastructure): Promise<boolean> {
    return infra.provider === "mock" && infra.status === "provisioned" && this.provisioned.has(infra.workspaceId);
  }

  async destroyWorkspace(infra: WorkspaceInfrastructure): Promise<void> {
    if (!(await this.canDestroyWorkspace(infra))) {
      throw new Error("unknown infrastructure state");
    }
    this.provisioned.delete(infra.workspaceId);
    this.destroyedWorkspaceIds.push(infra.workspaceId);
  }
}
