import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import dotenv from "dotenv";
import { HetznerProvider } from "../src/infra/providers/hetzner/provider.js";
import { ArubaProvider } from "../src/infra/providers/aruba/provider.js";
import {
  buildArubaPlanConfig,
  formatInfrastructurePlan,
  formatProvisionDryRun,
  resolveDestructiveOptions,
  runInfrastructurePlan,
} from "../src/infra/engine.js";
import type { VpsProvider, VpsServer, TaggedResource } from "../src/infra/provider.js";
import {
  defaultStatePath,
  deleteInfraState,
  readInfraState,
  tagsMatch,
  writeInfraState,
  type InfraState,
} from "../src/infra/state.js";

dotenv.config();

const TAGS = {
  project: "agent-bridge",
  environment: "spike",
  "managed-by": "agent-bridge",
};

const SERVER_NAME = "agent-bridge-spike-server";
const BOOT_VOLUME_NAME = "agent-bridge-spike-boot";
const FIREWALL_NAME = "agent-bridge-spike-firewall";
const SSH_KEY_NAME = "agent-bridge-spike-key";
const REQUIRED_RUNTIME_ENV = ["TELEGRAM_BOT_TOKEN_WORKER", "TELEGRAM_ALLOWED_USER_IDS"];
const ALLOWED_RUNTIME_ENV = [
  /^TELEGRAM_/,
  /^WORKER_/,
  /^BRIDGE_/,
  /^CODEX_/,
  /^ANTIGRAVITY_/,
  /^GEMINI_/,
  /^CLAUDE_/,
  /^GITHUB_/,
  /^GH_/,
  /^HEALTH_/,
  /^PR_/,
  /^DB_PATH$/,
  /^POLL_INTERVAL_MS$/,
  /^CLI_/,
  /^DEFECT_SCAN_/,
  /^AGENT_BRIDGE_/,
];

function resolveHome(filepath: string): string {
  if (filepath.startsWith("~/")) return path.join(process.env.HOME || process.env.USERPROFILE || "", filepath.slice(2));
  return path.resolve(filepath);
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function option(args: string[], name: string): string | null {
  const idx = args.indexOf(name);
  if (idx === -1 || idx === args.length - 1) return null;
  return args[idx + 1];
}

function printUsage() {
  console.log("Usage: npx tsx scripts/infra.ts <plan|provision|deploy|status|logs|smoke|teardown> --provider <hetzner|aruba>");
  console.log("Options:");
  console.log("  --provider <name>   hetzner or aruba");
  console.log("  --override-guardrails  bypass explicit MVP guardrail failures");
  console.log("  --replace           replace resources recorded in state during provision");
  console.log("  --dry-run           preview teardown without deleting resources");
  console.log("  --yes               skip destructive confirmation");
}

function providerFor(providerName: string): VpsProvider {
  if (providerName === "hetzner") {
    const token = process.env.HETZNER_API_TOKEN;
    if (!token) throw new Error("HETZNER_API_TOKEN is required.");
    return new HetznerProvider(token);
  }
  if (providerName === "aruba") return new ArubaProvider();
  throw new Error(`Unknown provider '${providerName}'. Supported: hetzner, aruba`);
}

async function runArubaPlan(provider: ArubaProvider, overrideGuardrails: boolean) {
  return runInfrastructurePlan({
    config: {
      ...buildArubaPlanConfig(),
      overrideGuardrails,
    },
    provider,
  });
}

function assertSameProvider(state: InfraState | null, providerName: string): void {
  if (state && state.provider !== providerName) {
    throw new Error(`State provider mismatch: state=${state.provider}, requested=${providerName}`);
  }
}

function createRuntimeEnvFile(sourcePath: string): string {
  if (!fs.existsSync(sourcePath)) throw new Error(`DEPLOY_ENV_FILE is missing: ${sourcePath}`);
  const parsed = dotenv.parse(fs.readFileSync(sourcePath, "utf8"));
  const missing = REQUIRED_RUNTIME_ENV.filter(key => !parsed[key]);
  if (missing.length > 0) throw new Error(`DEPLOY_ENV_FILE is missing required runtime variables: ${missing.join(", ")}`);

  const lines = Object.entries(parsed)
    .filter(([key]) => ALLOWED_RUNTIME_ENV.some(pattern => pattern.test(key)))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);

  const tmpPath = path.join(os.tmpdir(), `agent-bridge-env-${process.pid}.env`);
  fs.writeFileSync(tmpPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  return tmpPath;
}

function buildCloudInit(cloudInitPath: string, publicKeyText: string): string {
  const tailscaleAuthKey = process.env.TAILSCALE_AUTH_KEY || "";
  return fs.readFileSync(cloudInitPath, "utf8")
    .replace("${SSH_PUBLIC_KEY}", publicKeyText)
    .replaceAll("${TAILSCALE_AUTH_KEY}", tailscaleAuthKey);
}

async function resolveServer(provider: VpsProvider, state: InfraState | null): Promise<VpsServer | null> {
  if (state) {
    const server = await provider.getServer(state.serverId);
    if (!server) return null;
    if (!tagsMatch(server.tags, state.tags)) {
      throw new Error(`Server ${state.serverId} tags do not match state; refusing to manage it.`);
    }
    return server;
  }
  const discovered = await provider.listServersByTags(TAGS);
  return discovered.find(server => server.name.startsWith("agent-bridge")) || discovered[0] || null;
}

async function confirmDestructive(message: string, yes: boolean): Promise<void> {
  if (yes) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${message} Type 'destroy agent-bridge' to continue: `);
  rl.close();
  if (answer !== "destroy agent-bridge") throw new Error("Confirmation failed; no resources deleted.");
}

async function assertTaggedResource(resources: TaggedResource[], id: string | number, label: string): Promise<void> {
  const resource = resources.find(item => String(item.id) === String(id));
  if (!resource) throw new Error(`${label} ${id} not found by expected tags; refusing to delete.`);
  if (!tagsMatch(resource.tags, TAGS)) throw new Error(`${label} ${id} tag mismatch; refusing to delete.`);
}

async function teardownFromState(
  provider: VpsProvider,
  state: InfraState,
  statePath: string,
  options: { dryRun: boolean; yes: boolean },
): Promise<void> {
  if (!tagsMatch(state.tags, TAGS)) throw new Error("Local state tags do not match expected Agent Bridge tags.");
  const server = await provider.getServer(state.serverId);
  if (server && !tagsMatch(server.tags, TAGS)) throw new Error(`Server ${state.serverId} tag mismatch; refusing teardown.`);

  await assertTaggedResource(await provider.listFirewallsByTags(TAGS), state.firewallId, "Firewall");
  await assertTaggedResource(await provider.listSSHKeysByTags(TAGS), state.sshKeyId, "SSH key");

  console.log(`[infra] Teardown target: provider=${state.provider} server=${state.serverId} firewall=${state.firewallId} sshKey=${state.sshKeyId}`);
  if (options.dryRun) {
    console.log("[infra] Dry run only; no resources deleted.");
    return;
  }

  await confirmDestructive("This will destroy the recorded Agent Bridge VPS resources.", options.yes);
  if (server) await provider.destroyServer(state.serverId);
  await provider.destroyFirewall(state.firewallId);
  await provider.destroySSHKey(state.sshKeyId);
  deleteInfraState(statePath);
  console.log("[infra] Teardown completed and local state removed.");
}

async function recoverState(providerName: string, provider: VpsProvider, statePath: string, region: string, serverType: string): Promise<InfraState | null> {
  const servers = await provider.listServersByTags(TAGS);
  const firewalls = await provider.listFirewallsByTags(TAGS);
  const sshKeys = await provider.listSSHKeysByTags(TAGS);
  if (servers.length !== 1 || firewalls.length !== 1 || sshKeys.length !== 1) return null;

  const server = servers[0];
  const state: InfraState = {
    provider: providerName,
    serverId: server.id,
    serverName: server.name,
    firewallId: firewalls[0].id,
    sshKeyId: sshKeys[0].id,
    ip: server.ipAddress,
    managementIp: server.ipAddress,
    region,
    serverType,
    createdAt: new Date().toISOString(),
    tags: TAGS,
  };
  writeInfraState(statePath, state);
  console.log(`[infra] Recovered local state from uniquely tagged resources: ${statePath}`);
  return state;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const providerName = (option(args, "--provider") || "").toLowerCase();
  if (!cmd || !providerName) {
    printUsage();
    process.exit(1);
  }

  const projectDir = path.resolve(import.meta.dirname, "..");
  const statePath = defaultStatePath(projectDir);
  const provider = providerFor(providerName);
  const rawSshKeyPath = process.env.HETZNER_SSH_KEY_PATH || "~/.ssh/id_rsa.pub";
  const sshKeyPath = resolveHome(rawSshKeyPath);
  const rawPrivateKeyPath = process.env.HETZNER_SSH_PRIVATE_KEY_PATH || sshKeyPath.replace(".pub", "");
  const privateKeyPath = resolveHome(rawPrivateKeyPath);
  const deployEnvFile = path.resolve(process.env.DEPLOY_ENV_FILE || ".env.worker");
  const region = process.env.HETZNER_REGION || "nbg1";
  const serverType = process.env.HETZNER_SERVER_TYPE || "cx22";
  const arubaBootVolumeSizeGb = Number(process.env.ARUBA_BOOT_VOLUME_SIZE_GB || "20");

  let state = readInfraState(statePath);
  assertSameProvider(state, providerName);

  try {
    switch (cmd) {
      case "plan": {
        if (providerName !== "aruba") {
          throw new Error("plan is currently implemented for --provider aruba only.");
        }
        const plan = await runArubaPlan(provider as ArubaProvider, flag(args, "--override-guardrails"));
        console.log(formatInfrastructurePlan(plan));
        break;
      }

      case "provision": {
        if (providerName === "aruba" && flag(args, "--dry-run")) {
          const plan = await runArubaPlan(provider as ArubaProvider, flag(args, "--override-guardrails"));
          console.log(formatProvisionDryRun(plan));
          return;
        }
        if (providerName === "aruba") {
          if (!flag(args, "--yes")) {
            throw new Error("Aruba live provision creates billable resources; rerun with --yes after provision --dry-run passes.");
          }
          if (state) throw new Error("Local infra state already exists; refusing to create another Aruba VPS.");
          if (!fs.existsSync(sshKeyPath)) throw new Error(`SSH public key file missing: ${sshKeyPath}`);
          const pubKeyText = fs.readFileSync(sshKeyPath, "utf8").trim();
          const plan = await runArubaPlan(provider as ArubaProvider, flag(args, "--override-guardrails"));
          const created = await (provider as ArubaProvider).createMvpServer({
            projectId: plan.target.projectId,
            name: SERVER_NAME,
            bootVolumeName: BOOT_VOLUME_NAME,
            keyPairName: SSH_KEY_NAME,
            publicKeyText: pubKeyText,
            location: plan.target.location,
            dataCenter: plan.target.dataCenter,
            image: plan.target.image,
            flavor: plan.target.flavor,
            bootVolumeSizeGb: arubaBootVolumeSizeGb,
            userData: "#cloud-config\n",
            tags: TAGS,
          });

          state = {
            provider: providerName,
            projectId: plan.target.projectId,
            serverId: created.server.id,
            serverName: created.server.name,
            firewallId: "aruba-vpc-preset",
            sshKeyId: created.keyPairId,
            bootVolumeId: created.bootVolumeId,
            elasticIpId: created.elasticIpId,
            ip: created.server.ipAddress,
            managementIp: created.server.ipAddress,
            region: plan.target.dataCenter,
            serverType: plan.target.flavor,
            image: plan.target.image,
            createdAt: new Date().toISOString(),
            tags: TAGS,
          };
          writeInfraState(statePath, state);
          console.log(`[infra] Provisioned Aruba server ${created.server.name} (${created.server.id}); state saved to ${statePath}`);
          if (!created.server.ipAddress) {
            console.log("[infra] Server IP not assigned yet; run status after Aruba finishes provisioning.");
          }
          return;
        }
        const replace = flag(args, "--replace");
        if (state && !replace) {
          const existing = await resolveServer(provider, state);
          if (existing) {
            console.log(`[infra] Reusing recorded server ${existing.name} (${existing.ipAddress}). Use --replace to recreate.`);
            return;
          }
        }
        if (state && replace) {
          const destructiveOptions = resolveDestructiveOptions({ dryRun: flag(args, "--dry-run"), yes: flag(args, "--yes") });
          await teardownFromState(provider, state, statePath, destructiveOptions);
          if (destructiveOptions.dryRun) return;
          state = null;
        }

        console.log(`[infra] Validating credentials for provider '${providerName}'...`);
        if (!(await provider.validateCredentials())) throw new Error("Invalid cloud provider credentials.");
        if (!fs.existsSync(sshKeyPath)) throw new Error(`SSH public key file missing: ${sshKeyPath}`);
        const pubKeyText = fs.readFileSync(sshKeyPath, "utf8").trim();

        const recovered = await recoverState(providerName, provider, statePath, region, serverType);
        if (recovered && !replace) {
          console.log(`[infra] Reusing recovered server ${recovered.serverId} (${recovered.ip}).`);
          return;
        }

        const sshKeyId = await provider.provisionSSHKey(SSH_KEY_NAME, pubKeyText, TAGS);
        const firewallId = await provider.createFirewall(FIREWALL_NAME, [22], TAGS);
        const cloudInit = buildCloudInit(path.join(import.meta.dirname, "hetzner/cloud-init.yaml"), pubKeyText);
        const server = await provider.createServer({
          name: SERVER_NAME,
          serverType,
          image: "ubuntu-24.04",
          region,
          sshKeyId,
          firewallId,
          userData: cloudInit,
          tags: TAGS,
        });

        state = {
          provider: providerName,
          serverId: server.id,
          serverName: server.name,
          firewallId,
          sshKeyId,
          ip: server.ipAddress,
          managementIp: server.ipAddress,
          region,
          serverType,
          createdAt: new Date().toISOString(),
          tags: TAGS,
        };
        writeInfraState(statePath, state);
        console.log(`[infra] Provisioned ${server.name} at ${server.ipAddress}; state saved to ${statePath}`);
        break;
      }

      case "deploy": {
        state ||= await recoverState(providerName, provider, statePath, region, serverType);
        const server = await resolveServer(provider, state);
        if (!server || !server.ipAddress) throw new Error("No active server found. Run provision first.");

        const runtimeEnvPath = createRuntimeEnvFile(deployEnvFile);
        try {
          await provider.bootstrapServer(state?.ip || server.ipAddress, runtimeEnvPath, projectDir, privateKeyPath);
        } finally {
          if (fs.existsSync(runtimeEnvPath)) fs.unlinkSync(runtimeEnvPath);
        }

        if (state) {
          state.ip = server.ipAddress;
          state.managementIp = await provider.getManagementIp?.(server.ipAddress, privateKeyPath) || server.ipAddress;
          writeInfraState(statePath, state);
        }
        console.log("[infra] Deployment completed successfully.");
        break;
      }

      case "status": {
        if (providerName === "aruba") {
          if (!state?.projectId) throw new Error("No Aruba local state found. Run provision first.");
          const server = await (provider as ArubaProvider).getMvpServer(state.projectId, state.serverId);
          if (!server) {
            console.log(`[infra] Aruba server ${state.serverId} not found.`);
            return;
          }
          state.ip = server.ipAddress;
          state.managementIp = server.ipAddress;
          writeInfraState(statePath, state);
          console.log(`Server Name: ${server.name}`);
          console.log(`Status: ${server.status}`);
          console.log(`IP: ${server.ipAddress || "pending"}`);
          return;
        }
        state ||= await recoverState(providerName, provider, statePath, region, serverType);
        const server = await resolveServer(provider, state);
        if (!server) {
          console.log(`[infra] No active server found for provider '${providerName}'.`);
          return;
        }
        console.log(`Server Name: ${server.name}`);
        console.log(`IP: ${server.ipAddress}`);
        if (server.ipAddress) console.log(await provider.getStatus(server.id, state?.managementIp || server.ipAddress, privateKeyPath));
        break;
      }

      case "logs": {
        state ||= await recoverState(providerName, provider, statePath, region, serverType);
        const server = await resolveServer(provider, state);
        if (!server?.ipAddress) throw new Error("No active server found for logs.");
        console.log(await provider.getLogs(server.id, state?.managementIp || server.ipAddress, privateKeyPath));
        break;
      }

      case "smoke": {
        state ||= await recoverState(providerName, provider, statePath, region, serverType);
        const server = await resolveServer(provider, state);
        if (!server?.ipAddress) throw new Error("No active server found for smoke checks.");
        console.log(await provider.getStatus(server.id, state?.managementIp || server.ipAddress, privateKeyPath));
        const logs = await provider.getLogs(server.id, state?.managementIp || server.ipAddress, privateKeyPath);
        if (/TOKEN=|_KEY=|SECRET=|PASSWORD=/i.test(logs)) throw new Error("Potential secret leakage marker found in logs.");
        console.log("[infra] Smoke checks passed: SSH, Compose status, UFW status, and log leak scan.");
        break;
      }

      case "teardown": {
        if (providerName === "aruba") {
          if (!state?.projectId || !state.bootVolumeId || !state.sshKeyId) {
            throw new Error("No complete Aruba local state found; refusing blind teardown.");
          }
          const options = resolveDestructiveOptions({ dryRun: flag(args, "--dry-run"), yes: flag(args, "--yes") });
          console.log(`[infra] Aruba teardown target: server=${state.serverId} bootVolume=${state.bootVolumeId} elasticIp=${state.elasticIpId ?? "none"} sshKey=${state.sshKeyId}`);
          if (options.dryRun) {
            console.log("[infra] Dry run only; no resources deleted.");
            return;
          }
          await (provider as ArubaProvider).destroyMvpServer({
            projectId: state.projectId,
            serverId: state.serverId,
            bootVolumeId: state.bootVolumeId,
            keyPairId: state.sshKeyId,
            elasticIpId: state.elasticIpId,
          });
          deleteInfraState(statePath);
          console.log("[infra] Aruba teardown completed and local state removed.");
          return;
        }
        state ||= await recoverState(providerName, provider, statePath, region, serverType);
        if (!state) throw new Error("No local state and no unique tagged resources found; refusing blind teardown.");
        await teardownFromState(provider, state, statePath, resolveDestructiveOptions({ dryRun: flag(args, "--dry-run"), yes: flag(args, "--yes") }));
        break;
      }

      default:
        printUsage();
        process.exit(1);
    }
  } catch (err: any) {
    console.error(`[infra] Action failed: ${err.message}`);
    process.exit(1);
  }
}

main();
