import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { ArubaProvider as LowLevelArubaProvider } from "../infra/providers/aruba/provider.js";
import { buildArubaPlanConfig, runInfrastructurePlan } from "../infra/engine.js";
import type { ProvisionWorkspaceInput, WorkspaceInfrastructure, WorkspaceProvider } from "./types.js";

export interface ArubaPlanSummary {
  projectId: string;
  projectName: string;
  estimatedMonthlyCostEur: number;
  maxMonthlyBudgetEur: number;
}

export interface ArubaCreateInput {
  workspaceId: string;
  customerId: string;
  projectId: string;
  serverName: string;
  region: string;
  flavor: string;
  tags: Record<string, string>;
  publicKeyText: string;
}

export interface ArubaCreateResult {
  serverId: string | number;
  serverName: string;
  bootVolumeId: string | number;
  keyPairId: string | number;
  elasticIpId: string | number;
  securityGroupId?: string | number;
  ipAddress: string | null;
}

export interface ArubaDestroyInput {
  projectId: string;
  serverId: string | number;
  bootVolumeId: string | number;
  keyPairId: string | number;
  elasticIpId?: string | number;
  securityGroupId?: string | number;
}

export interface ArubaBootstrapInput {
  ipAddress: string;
  deployEnvFile: string;
  projectDir: string;
  privateKeyPath: string;
  bootstrapToken: string;
}

export interface ArubaControlPlaneClient {
  plan(tags: Record<string, string>): Promise<ArubaPlanSummary>;
  create(input: ArubaCreateInput): Promise<ArubaCreateResult>;
  bootstrap(input: ArubaBootstrapInput): Promise<void>;
  destroy(input: ArubaDestroyInput): Promise<void>;
}

export interface ControlPlaneArubaProviderOptions {
  client?: ArubaControlPlaneClient;
  env?: Record<string, string | undefined>;
  dryRun: boolean;
  projectId?: string;
  deployEnvFile?: string;
  projectDir?: string;
  privateKeyPath?: string;
  publicKeyText?: string;
}

function resolveHome(filepath: string): string {
  if (filepath.startsWith("~/")) return path.join(os.homedir(), filepath.slice(2));
  return path.resolve(filepath);
}

function readPublicKey(env: Record<string, string | undefined>): string {
  const publicKeyPath = resolveHome(env.ARUBA_SSH_KEY_PATH || env.HETZNER_SSH_KEY_PATH || "~/.ssh/id_rsa.pub");
  return readFileSync(publicKeyPath, "utf8").trim();
}

class DefaultArubaControlPlaneClient implements ArubaControlPlaneClient {
  private provider: LowLevelArubaProvider;

  constructor(private env: Record<string, string | undefined>) {
    this.provider = new LowLevelArubaProvider();
  }

  async plan(tags: Record<string, string>): Promise<ArubaPlanSummary> {
    const plan = await runInfrastructurePlan({
      config: {
        ...buildArubaPlanConfig(this.env),
        tags,
      },
      provider: this.provider,
    });
    return {
      projectId: plan.target.projectId,
      projectName: plan.target.projectName,
      estimatedMonthlyCostEur: plan.target.estimatedMonthlyCostEur,
      maxMonthlyBudgetEur: plan.target.maxMonthlyBudgetEur,
    };
  }

  async create(input: ArubaCreateInput): Promise<ArubaCreateResult> {
    const envConfig = buildArubaPlanConfig(this.env);
    const created = await this.provider.createMvpServer({
      projectId: input.projectId,
      name: input.serverName,
      bootVolumeName: `${input.serverName}-boot`,
      keyPairName: `${input.serverName}-key`,
      publicKeyText: input.publicKeyText,
      location: envConfig.location,
      dataCenter: input.region,
      image: envConfig.image,
      flavor: input.flavor,
      bootVolumeSizeGb: Number(this.env.ARUBA_BOOT_VOLUME_SIZE_GB || "20"),
      userData: "#cloud-config\n",
      tags: input.tags,
    });
    return {
      serverId: created.server.id,
      serverName: created.server.name,
      bootVolumeId: created.bootVolumeId,
      keyPairId: created.keyPairId,
      elasticIpId: created.elasticIpId,
      securityGroupId: created.securityGroupId,
      ipAddress: created.server.ipAddress,
    };
  }

  async bootstrap(input: ArubaBootstrapInput): Promise<void> {
    await this.provider.bootstrapServer(input.ipAddress, input.deployEnvFile, input.projectDir, input.privateKeyPath);
  }

  async destroy(input: ArubaDestroyInput): Promise<void> {
    await this.provider.destroyMvpServer(input);
  }
}

export class ControlPlaneArubaProvider implements WorkspaceProvider {
  readonly name = "aruba" as const;
  readonly dryRun: boolean;
  private client?: ArubaControlPlaneClient;
  private env: Record<string, string | undefined>;
  private projectId: string;

  constructor(private options: ControlPlaneArubaProviderOptions) {
    this.client = options.client;
    this.env = options.env || process.env;
    this.dryRun = options.dryRun;
    this.projectId = options.projectId || this.env.ARUBA_PROJECT_ID || "";
  }

  estimatedMonthlyCostEur(): number {
    const raw = this.env.ARUBA_ESTIMATED_MONTHLY_COST_EUR || "5";
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 5;
  }

  private getClient(): ArubaControlPlaneClient {
    this.client ||= new DefaultArubaControlPlaneClient(this.env);
    return this.client;
  }

  private tags(input: ProvisionWorkspaceInput): Record<string, string> {
    return {
      project: "agent-bridge",
      environment: "workspace",
      "managed-by": "agent-bridge",
      customerId: input.customerId,
      workspaceId: input.workspaceId,
    };
  }

  async provisionWorkspace(input: ProvisionWorkspaceInput): Promise<Omit<WorkspaceInfrastructure, "createdAt" | "updatedAt">> {
    if (input.flavor !== "CSO1A2") throw new Error("only CSO1A2 Aruba workspaces are allowed");
    const tags = this.tags(input);
    const plan = await this.getClient().plan(tags);
    const projectId = this.projectId || plan.projectId;
    const serverName = `ab-ws-${input.workspaceId}`;

    if (this.dryRun) {
      return {
        workspaceId: input.workspaceId,
        provider: "aruba",
        status: "planned",
        region: input.region,
        flavor: input.flavor,
        serverId: `dry-run-server-${input.workspaceId}`,
        elasticIpId: `dry-run-eip-${input.workspaceId}`,
        securityGroupId: `dry-run-sg-${input.workspaceId}`,
        bootVolumeId: `dry-run-boot-${input.workspaceId}`,
        keyPairId: `dry-run-key-${input.workspaceId}`,
        ipAddress: null,
        tags,
      };
    }

    const publicKeyText = this.options.publicKeyText || readPublicKey(this.env);
    const created = await this.getClient().create({
      workspaceId: input.workspaceId,
      customerId: input.customerId,
      projectId,
      serverName,
      region: input.region,
      flavor: input.flavor,
      tags,
      publicKeyText,
    });

    if (!created.ipAddress) throw new Error("Aruba server IP address is required before bootstrap");
    if (!input.bootstrapToken) throw new Error("bootstrap token is required for Aruba bootstrap");
    const deployEnvFile = this.options.deployEnvFile || this.env.DEPLOY_ENV_FILE;
    const projectDir = this.options.projectDir || this.env.AGENT_BRIDGE_PROJECT_DIR || process.cwd();
    const privateKeyPath = this.options.privateKeyPath || this.env.ARUBA_SSH_PRIVATE_KEY_PATH || this.env.HETZNER_SSH_PRIVATE_KEY_PATH;
    if (!deployEnvFile || !privateKeyPath) throw new Error("Aruba bootstrap requires DEPLOY_ENV_FILE and private key path");

    await this.getClient().bootstrap({
      ipAddress: created.ipAddress,
      deployEnvFile,
      projectDir,
      privateKeyPath: resolveHome(privateKeyPath),
      bootstrapToken: input.bootstrapToken,
    });

    return {
      workspaceId: input.workspaceId,
      provider: "aruba",
      status: "provisioned",
      region: input.region,
      flavor: input.flavor,
      serverId: String(created.serverId),
      elasticIpId: String(created.elasticIpId),
      securityGroupId: created.securityGroupId == null ? "" : String(created.securityGroupId),
      bootVolumeId: String(created.bootVolumeId),
      keyPairId: String(created.keyPairId),
      ipAddress: created.ipAddress,
      tags,
    };
  }

  async canDestroyWorkspace(infra: WorkspaceInfrastructure): Promise<boolean> {
    if (infra.provider !== "aruba") return false;
    if (infra.status === "unknown") return false;
    if (infra.tags.project !== "agent-bridge") return false;
    if (infra.tags["managed-by"] !== "agent-bridge") return false;
    if (infra.tags.workspaceId !== infra.workspaceId) return false;
    if (this.dryRun && infra.status === "planned") return true;
    return infra.status === "provisioned";
  }

  async destroyWorkspace(infra: WorkspaceInfrastructure): Promise<void> {
    if (infra.status === "unknown") throw new Error("unknown infrastructure state");
    if (!(await this.canDestroyWorkspace(infra))) {
      throw new Error("refusing to destroy untagged or mismatched Aruba resources");
    }
    if (this.dryRun && infra.status === "planned") return;
    await this.getClient().destroy({
      projectId: this.projectId,
      serverId: infra.serverId,
      bootVolumeId: infra.bootVolumeId,
      keyPairId: infra.keyPairId,
      elasticIpId: infra.elasticIpId,
      securityGroupId: infra.securityGroupId || undefined,
    });
  }
}
