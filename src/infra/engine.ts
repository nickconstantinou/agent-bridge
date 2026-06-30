import {
  type WorkspaceState,
  readWorkspaceState,
  writeWorkspaceState,
  deleteWorkspaceState,
} from "./state.js";
import { ArubaProvider } from "./providers/aruba/provider.js";

export interface InfraProject {
  id: string;
  name: string;
  resourcesNumber: number;
}

export interface InfraResource {
  id: string | number;
  name: string;
  tags: Record<string, string>;
}

export interface ReadOnlyPlanProvider {
  validateCredentials(): Promise<boolean>;
  listProjects(): Promise<InfraProject[]>;
  listServers(projectId: string): Promise<InfraResource[]>;
  listKeyPairs(projectId: string): Promise<InfraResource[]>;
  listBlockStorages(projectId: string): Promise<InfraResource[]>;
  listVpcs(projectId: string): Promise<InfraResource[]>;
  listElasticIps(projectId: string): Promise<InfraResource[]>;
}

export interface InfrastructurePlanConfig {
  provider: "aruba";
  projectId: string;
  projectName: string;
  allowedProjectIds: string[];
  location: string;
  dataCenter: string;
  image: string;
  flavor: string;
  maxFlavor: string;
  maxVps: number;
  maxMonthlyBudgetEur: number;
  estimatedMonthlyCostEur: number;
  tags: Record<string, string>;
  overrideGuardrails?: boolean;
}

export interface InfrastructurePlan {
  valid: true;
  target: {
    provider: string;
    projectId: string;
    projectName: string;
    location: string;
    dataCenter: string;
    image: string;
    flavor: string;
    tags: Record<string, string>;
    estimatedMonthlyCostEur: number;
    maxMonthlyBudgetEur: number;
  };
  resources: {
    cloudServers: number;
    keyPairs: number;
    blockStorages: number;
    vpcs: number;
    elasticIps: number;
  };
  wouldCreate: string[];
}

export interface DestructiveOptions {
  dryRun: boolean;
  yes: boolean;
}

const REQUIRED_TAGS = {
  project: "agent-bridge",
  environment: "spike",
  "managed-by": "agent-bridge",
};

const FLAVOR_ORDER = ["CSO1A2"];
const VALID_IMAGES = new Set(["LU24-001", "LU22-001", "DE12-001"]);
const VALID_LOCATIONS = new Set(["ITBG-Bergamo"]);
const VALID_DATACENTERS = new Set(["ITBG-1", "ITBG-2", "ITBG-3"]);

function csv(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric value: ${value}`);
  return parsed;
}

export function buildArubaPlanConfig(env: Record<string, string | undefined> = process.env): InfrastructurePlanConfig {
  const tags = {
    project: env.ARUBA_TAG_PROJECT || REQUIRED_TAGS.project,
    environment: env.ARUBA_TAG_ENVIRONMENT || REQUIRED_TAGS.environment,
    "managed-by": env.ARUBA_TAG_MANAGED_BY || REQUIRED_TAGS["managed-by"],
  };

  return {
    provider: "aruba",
    projectId: env.ARUBA_PROJECT_ID || "",
    projectName: env.ARUBA_PROJECT_NAME || "cloud-v1",
    allowedProjectIds: csv(env.ARUBA_ALLOWED_PROJECT_IDS),
    location: env.ARUBA_LOCATION || "ITBG-Bergamo",
    dataCenter: env.ARUBA_DATACENTER || "ITBG-1",
    image: env.ARUBA_IMAGE || "LU24-001",
    flavor: env.ARUBA_FLAVOR || "CSO1A2",
    maxFlavor: env.ARUBA_MAX_FLAVOR || "CSO1A2",
    maxVps: numberFromEnv(env.ARUBA_MAX_VPS, 1),
    maxMonthlyBudgetEur: numberFromEnv(env.ARUBA_MAX_MONTHLY_BUDGET_EUR, 5),
    estimatedMonthlyCostEur: numberFromEnv(env.ARUBA_ESTIMATED_MONTHLY_COST_EUR, 5),
    tags,
  };
}

function assertRequiredTags(tags: Record<string, string>, overrideGuardrails: boolean): void {
  const missing = Object.entries(REQUIRED_TAGS)
    .filter(([key, value]) => tags[key] !== value)
    .map(([key]) => key);
  if (missing.length > 0 && !overrideGuardrails) {
    throw new Error(`required tags missing or changed: ${missing.join(", ")}`);
  }
}

function assertFlavor(config: InfrastructurePlanConfig): void {
  if (config.overrideGuardrails) return;
  if (config.maxFlavor !== "CSO1A2") throw new Error(`max flavor must remain CSO1A2 unless guardrails are overridden`);
  if (!FLAVOR_ORDER.includes(config.flavor)) throw new Error(`flavor ${config.flavor} exceeds maximum ${config.maxFlavor}`);
}

function assertStaticInputs(config: InfrastructurePlanConfig): void {
  if (!VALID_LOCATIONS.has(config.location)) throw new Error(`unsupported Aruba location: ${config.location}`);
  if (!VALID_DATACENTERS.has(config.dataCenter)) throw new Error(`unsupported Aruba datacenter: ${config.dataCenter}`);
  if (!VALID_IMAGES.has(config.image)) throw new Error(`unsupported Aruba image: ${config.image}`);
}

export async function runInfrastructurePlan(input: {
  config: InfrastructurePlanConfig;
  provider: ReadOnlyPlanProvider;
}): Promise<InfrastructurePlan> {
  const { config, provider } = input;
  const credentialsValid = await provider.validateCredentials();
  if (!credentialsValid) throw new Error("invalid Aruba credentials");

  assertStaticInputs(config);
  assertFlavor(config);
  assertRequiredTags(config.tags, Boolean(config.overrideGuardrails));

  if (config.estimatedMonthlyCostEur > config.maxMonthlyBudgetEur && !config.overrideGuardrails) {
    throw new Error(`estimated monthly cost ${config.estimatedMonthlyCostEur} exceeds budget ${config.maxMonthlyBudgetEur}`);
  }

  const projects = await provider.listProjects();
  const project = config.projectId
    ? projects.find(item => item.id === config.projectId)
    : projects.find(item => item.name === config.projectName);
  if (!project) throw new Error(`Aruba project not found: ${config.projectId || config.projectName}`);
  if (!config.allowedProjectIds.includes(project.id) && !config.overrideGuardrails) {
    throw new Error(`project ${project.id} is not in ARUBA_ALLOWED_PROJECT_IDS`);
  }

  const [servers, keyPairs, blockStorages, vpcs, elasticIps] = await Promise.all([
    provider.listServers(project.id),
    provider.listKeyPairs(project.id),
    provider.listBlockStorages(project.id),
    provider.listVpcs(project.id),
    provider.listElasticIps(project.id),
  ]);

  if (servers.length >= config.maxVps && !config.overrideGuardrails) {
    throw new Error(`another VPS already exists in project ${project.id}; maxVps=${config.maxVps}`);
  }

  return {
    valid: true,
    target: {
      provider: config.provider,
      projectId: project.id,
      projectName: project.name,
      location: config.location,
      dataCenter: config.dataCenter,
      image: config.image,
      flavor: config.flavor,
      tags: config.tags,
      estimatedMonthlyCostEur: config.estimatedMonthlyCostEur,
      maxMonthlyBudgetEur: config.maxMonthlyBudgetEur,
    },
    resources: {
      cloudServers: servers.length,
      keyPairs: keyPairs.length,
      blockStorages: blockStorages.length,
      vpcs: vpcs.length,
      elasticIps: elasticIps.length,
    },
    wouldCreate: [
      "keyPair",
      "bootVolume",
      "cloudServer",
      "dockerComposeRuntime",
    ],
  };
}

export function formatInfrastructurePlan(plan: InfrastructurePlan): string {
  return [
    "[infra] Aruba plan valid. No billable resources created.",
    `Provider: ${plan.target.provider}`,
    `Project: ${plan.target.projectName} (${plan.target.projectId})`,
    `Location: ${plan.target.location}`,
    `Datacenter: ${plan.target.dataCenter}`,
    `Image: ${plan.target.image}`,
    `Flavor: ${plan.target.flavor}`,
    `Estimated monthly cost: EUR ${plan.target.estimatedMonthlyCostEur.toFixed(2)} / budget EUR ${plan.target.maxMonthlyBudgetEur.toFixed(2)}`,
    `Existing resources: cloudServers=${plan.resources.cloudServers} keyPairs=${plan.resources.keyPairs} blockStorages=${plan.resources.blockStorages} vpcs=${plan.resources.vpcs} elasticIps=${plan.resources.elasticIps}`,
    `Required tags: ${Object.entries(plan.target.tags).map(([key, value]) => `${key}=${value}`).join(", ")}`,
    `Would create: ${plan.wouldCreate.join(" -> ")}`,
  ].join("\n");
}

export function formatProvisionDryRun(plan: InfrastructurePlan): string {
  return [
    "[infra] Aruba provision dry-run. No billable resources created.",
    formatInfrastructurePlan(plan),
  ].join("\n");
}

export function resolveDestructiveOptions(flags: DestructiveOptions): DestructiveOptions {
  return {
    dryRun: flags.dryRun || !flags.yes,
    yes: flags.yes,
  };
}

export interface WorkspaceConfig {
  workspaceId: string;
  customerId: string;
  repo: string;
  branch: string;
  domain: string;
  location: string;
  dataCenter: string;
  image: string;
  flavor: string;
  tags: Record<string, string>;
}

export async function reconcileWorkspace(
  config: WorkspaceConfig,
  provider: ArubaProvider,
  statePath: string,
  sshKeyPath: string,
  privateKeyPath: string,
  deployEnvFile: string,
  projectDir: string,
  pubKeyText: string
): Promise<WorkspaceState> {
  let state = readWorkspaceState(statePath);

  if (state && state.status === "ready" && state.workspaceId === config.workspaceId) {
    return state;
  }

  if (!state) {
    state = {
      workspaceId: config.workspaceId,
      customerId: config.customerId,
      repo: config.repo,
      branch: config.branch,
      domain: config.domain,
      status: "creating",
      provider: "aruba",
      serverId: "",
      serverName: `ab-ws-${config.workspaceId}`,
      firewallId: "",
      sshKeyId: "",
      ip: null,
      region: config.dataCenter,
      serverType: config.flavor,
      image: config.image,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: config.tags,
    };
    writeWorkspaceState(statePath, state);
  }

  if (!state.serverId) {
    const plan = await runInfrastructurePlan({
      config: {
        provider: "aruba",
        projectId: process.env.ARUBA_PROJECT_ID || "",
        projectName: process.env.ARUBA_PROJECT_NAME || "cloud-v1",
        allowedProjectIds: [process.env.ARUBA_PROJECT_ID || ""],
        location: config.location,
        dataCenter: config.dataCenter,
        image: config.image,
        flavor: config.flavor,
        maxFlavor: "CSO1A2",
        maxVps: 1,
        maxMonthlyBudgetEur: 5,
        estimatedMonthlyCostEur: 5,
        tags: config.tags,
        overrideGuardrails: true,
      },
      provider,
    });

    const created = await provider.createMvpServer({
      projectId: plan.target.projectId,
      name: state.serverName,
      bootVolumeName: `${state.serverName}-boot`,
      keyPairName: `${state.serverName}-key`,
      publicKeyText: pubKeyText,
      location: config.location,
      dataCenter: config.dataCenter,
      image: config.image,
      flavor: config.flavor,
      bootVolumeSizeGb: 20,
      userData: "#cloud-config\n",
      tags: config.tags,
    });

    state.projectId = plan.target.projectId;
    state.serverId = created.server.id;
    state.firewallId = created.securityGroupId || "aruba-vpc-preset";
    state.sshKeyId = created.keyPairId;
    state.bootVolumeId = created.bootVolumeId;
    state.elasticIpId = created.elasticIpId;
    state.sshRuleId = created.sshRuleId;
    state.ip = created.server.ipAddress;
    state.updatedAt = new Date().toISOString();
    writeWorkspaceState(statePath, state);
  }

  if (!state.ip) {
    let retries = 30;
    while (retries > 0) {
      const server = await provider.getMvpServer(state.projectId!, state.serverId);
      if (server && server.ipAddress) {
        state.ip = server.ipAddress;
        state.updatedAt = new Date().toISOString();
        writeWorkspaceState(statePath, state);
        break;
      }
      retries--;
      await new Promise(r => setTimeout(r, 5000));
    }
    if (!state.ip) {
      state.status = "failed";
      state.updatedAt = new Date().toISOString();
      writeWorkspaceState(statePath, state);
      throw new Error("Timeout waiting for Aruba VM IP address assignment.");
    }
  }

  if (state.status === "creating") {
    state.status = "bootstrap";
    state.updatedAt = new Date().toISOString();
    writeWorkspaceState(statePath, state);
  }

  if (state.status === "bootstrap") {
    try {
      await provider.bootstrapServer(state.ip, deployEnvFile, projectDir, privateKeyPath);
      
      if (state.sshRuleId && state.firewallId !== "aruba-vpc-preset" && state.projectId) {
        const vpc = await provider.listVpcs(state.projectId);
        if (vpc[0]) {
          await provider.deleteSecurityRule(state.projectId, vpc[0].id, state.firewallId, state.sshRuleId);
          state.sshRuleId = undefined;
        }
      }

      state.status = "ready";
      state.updatedAt = new Date().toISOString();
      writeWorkspaceState(statePath, state);
    } catch (err: any) {
      state.status = "failed";
      state.updatedAt = new Date().toISOString();
      writeWorkspaceState(statePath, state);
      throw err;
    }
  }

  return state;
}

export async function destroyWorkspace(
  provider: ArubaProvider,
  statePath: string
): Promise<void> {
  const state = readWorkspaceState(statePath);
  if (!state) return;

  if (state.projectId && state.serverId && state.bootVolumeId && state.sshKeyId) {
    await provider.destroyMvpServer({
      projectId: state.projectId,
      serverId: state.serverId,
      bootVolumeId: state.bootVolumeId,
      keyPairId: state.sshKeyId,
      elasticIpId: state.elasticIpId,
      securityGroupId: state.firewallId !== "aruba-vpc-preset" ? state.firewallId : undefined,
    });
  }

  deleteWorkspaceState(statePath);
}
