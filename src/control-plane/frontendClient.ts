import { type FrontendWorkspaceState } from "./frontend.js";

export type FrontendSafeStatus = "not_started" | "pending" | "ready" | "failed" | "suspended" | "closed";
export type IntegrationState = "connected" | "not_connected";

export interface FrontendControlPlaneDto {
  session: { signedIn: boolean; displayName: string };
  workspace: { id: string; status: FrontendSafeStatus; projectName: string } | null;
  integrations: { github: IntegrationState; chat: IntegrationState; chatProvider: "telegram" | "discord" };
  recentEvents: Array<{ type: string; createdAt: string; label: string }>;
  readyUrl: string;
  supportUrl: string;
  failure: { title: string; message: string } | null;
}

export interface FrontendClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

interface ApiWorkspace {
  workspaceId?: string;
  id?: string;
  status?: string;
  projectName?: string;
}

interface ApiEvent {
  type?: string;
  createdAt?: string;
  message?: string;
}

const DEFAULT_READY_URL = "https://t.me/agent_bridge_bot?start=workspace";
const DEFAULT_SUPPORT_URL = "mailto:support@example.com";

const FORBIDDEN_PATTERNS = [
  /aruba/gi,
  /vps/gi,
  /ssh/gi,
  /caddy/gi,
  /systemd/gi,
  /sqlite/gi,
  /elastic\s*ip/gi,
  /security\s*groups?/gi,
  /provider\s*error/gi,
  /digitalocean/gi,
  /droplet/gi,
];

function clean(value: string): string {
  let result = value;
  for (const pattern of FORBIDDEN_PATTERNS) result = result.replace(pattern, "workspace");
  return result;
}

function safeStatus(status: string | undefined): FrontendSafeStatus {
  if (status === "ready") return "ready";
  if (status === "failed") return "failed";
  if (status === "suspended") return "suspended";
  if (status === "destroyed" || status === "destroying") return "closed";
  if (!status) return "not_started";
  return "pending";
}

function safeEventLabel(type: string, fallback = ""): string {
  const labels: Record<string, string> = {
    workspace_created: "Workspace requested",
    provisioning_started: "Workspace started",
    infrastructure_ready: "Workspace prepared",
    appliance_installing: "Agent Bridge is joining",
    appliance_registered: "Agent Bridge connected",
    heartbeat_received: "Latest status received",
    workspace_ready: "Workspace ready",
    workspace_failed: "Setup paused",
    destroy_started: "Workspace closing",
    workspace_destroyed: "Workspace closed",
  };
  return clean(labels[type] || fallback || "Workspace updated");
}

export function sanitizeFrontendDto(input: FrontendControlPlaneDto): FrontendControlPlaneDto {
  return {
    session: { signedIn: input.session.signedIn, displayName: clean(input.session.displayName) },
    workspace: input.workspace
      ? { id: clean(input.workspace.id), status: input.workspace.status, projectName: clean(input.workspace.projectName) }
      : null,
    integrations: input.integrations,
    recentEvents: input.recentEvents.map((event) => ({
      type: clean(event.type),
      createdAt: event.createdAt,
      label: safeEventLabel(event.type, event.label),
    })),
    readyUrl: input.readyUrl,
    supportUrl: input.supportUrl,
    failure: input.failure
      ? { title: "Workspace setup needs attention", message: "Try again, or contact support and we will help." }
      : null,
  };
}

export function frontendStateFromDto(input: FrontendControlPlaneDto): FrontendWorkspaceState {
  const dto = sanitizeFrontendDto(input);
  const status = dto.workspace?.status === "pending"
    ? "installing_appliance"
    : dto.workspace?.status === "closed"
    ? "destroyed"
    : dto.workspace?.status === "not_started"
    ? null
    : dto.workspace?.status || null;

  return {
    session: dto.session,
    workspace: dto.workspace && status
      ? { id: dto.workspace.id, status, projectName: dto.workspace.projectName }
      : null,
    connections: {
      github: dto.integrations.github === "connected",
      chat: dto.integrations.chat === "connected",
      chatProvider: dto.integrations.chatProvider,
    },
    events: dto.recentEvents.map((event) => ({ type: event.type, createdAt: event.createdAt, message: event.label })),
    links: { telegramUrl: dto.readyUrl, discordUrl: dto.readyUrl, supportUrl: dto.supportUrl },
  };
}

export function frontendDtoFromApi(input: {
  workspace?: ApiWorkspace | null;
  events?: ApiEvent[];
  displayName?: string;
  githubConnected?: boolean;
  chatConnected?: boolean;
  chatProvider?: "telegram" | "discord";
  readyUrl?: string;
  supportUrl?: string;
  failure?: string | null;
}): FrontendControlPlaneDto {
  const workspaceId = input.workspace?.workspaceId || input.workspace?.id || "";
  return sanitizeFrontendDto({
    session: { signedIn: true, displayName: input.displayName || "Customer" },
    workspace: input.workspace
      ? {
          id: workspaceId,
          status: safeStatus(input.workspace.status),
          projectName: clean(input.workspace.projectName || "Project"),
        }
      : null,
    integrations: {
      github: input.githubConnected ? "connected" : "not_connected",
      chat: input.chatConnected ? "connected" : "not_connected",
      chatProvider: input.chatProvider || "telegram",
    },
    recentEvents: (input.events || []).map((event) => ({
      type: event.type || "workspace_updated",
      createdAt: event.createdAt || new Date().toISOString(),
      label: safeEventLabel(event.type || "", event.message || ""),
    })),
    readyUrl: input.readyUrl || DEFAULT_READY_URL,
    supportUrl: input.supportUrl || DEFAULT_SUPPORT_URL,
    failure: input.failure ? { title: "Workspace setup needs attention", message: input.failure } : null,
  });
}

async function readJson(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === "string" ? clean(body.error) : "Request failed");
  return body;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ControlPlaneFrontendClient {
  private fetchImpl: typeof fetch;
  private baseUrl: string;

  constructor(options: FrontendClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async createWorkspace(input: { customerId: string; projectName?: string }): Promise<FrontendControlPlaneDto> {
    const response = await this.fetchImpl(`${this.baseUrl}/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId: input.customerId }),
    });
    const body = await readJson(response);
    return frontendDtoFromApi({ workspace: { ...body.workspace, projectName: input.projectName || "Project" } });
  }

  async retryWorkspace(input: { customerId: string; projectName?: string }): Promise<FrontendControlPlaneDto> {
    return this.createWorkspace(input);
  }

  async getWorkspace(workspaceId: string): Promise<FrontendControlPlaneDto> {
    const workspaceResponse = await this.fetchImpl(`${this.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}`);
    const workspaceBody = await readJson(workspaceResponse);
    const eventsResponse = await this.fetchImpl(`${this.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}/events`);
    const eventsBody = await readJson(eventsResponse);
    return frontendDtoFromApi({ workspace: workspaceBody.workspace, events: eventsBody.events || [] });
  }

  async pollWorkspace(
    workspaceId: string,
    options: { intervalMs: number; maxAttempts: number; onUpdate?: (state: FrontendControlPlaneDto) => void },
  ): Promise<FrontendControlPlaneDto> {
    let last: FrontendControlPlaneDto | null = null;
    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
      last = await this.getWorkspace(workspaceId);
      options.onUpdate?.(last);
      if (last.workspace?.status === "ready" || last.workspace?.status === "failed") return last;
      if (attempt < options.maxAttempts) await wait(options.intervalMs);
    }
    return last || frontendDtoFromApi({});
  }
}
