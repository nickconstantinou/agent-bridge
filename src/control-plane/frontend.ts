export type FrontendWorkspaceStatus =
  | "provisioning"
  | "installing_appliance"
  | "appliance_registered"
  | "ready"
  | "suspended"
  | "destroying"
  | "destroyed"
  | "failed";

export interface FrontendWorkspaceState {
  session: {
    signedIn: boolean;
    displayName: string;
  };
  workspace: {
    id: string;
    status: FrontendWorkspaceStatus;
    projectName: string;
  } | null;
  connections: {
    github: boolean;
    chat: boolean;
    chatProvider: "telegram" | "discord";
  };
  events: Array<{
    type: string;
    createdAt: string;
    message?: string;
  }>;
  links: {
    telegramUrl: string;
    discordUrl: string;
    supportUrl: string;
  };
}

const EVENT_LABELS: Record<string, string> = {
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

const FORBIDDEN_TERMS = [
  /aruba/gi,
  /vps/gi,
  /ssh/gi,
  /caddy/gi,
  /systemd/gi,
  /sqlite/gi,
  /elastic\s*ip/gi,
  /security\s*groups?/gi,
  /provider\s*error/gi,
  /server\s*id/gi,
  /key\s*pair/gi,
];

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function productText(value: string): string {
  let clean = value;
  for (const pattern of FORBIDDEN_TERMS) clean = clean.replace(pattern, "workspace");
  return escapeHtml(clean);
}

function chatLabel(provider: "telegram" | "discord"): string {
  return provider === "telegram" ? "Telegram" : "Discord";
}

function chatUrl(state: FrontendWorkspaceState): string {
  return state.connections.chatProvider === "telegram" ? state.links.telegramUrl : state.links.discordUrl;
}

function workspaceTitle(status: FrontendWorkspaceStatus | null): string {
  if (!status) return "Create your workspace";
  if (status === "ready") return "Workspace ready";
  if (status === "failed") return "Workspace setup needs attention";
  if (status === "suspended") return "Workspace paused";
  if (status === "destroyed") return "Workspace closed";
  return "Creating your workspace";
}

function workspaceCopy(status: FrontendWorkspaceStatus | null): string {
  if (!status) return "Agent Bridge runs from chat. Start by creating a workspace for your project.";
  if (status === "ready") return "Your workspace is ready. Continue in chat to run projects, checks, and follow-up work.";
  if (status === "failed") return "We could not finish setup. Try again, or contact support and we will help.";
  if (status === "suspended") return "Your workspace is paused. Contact support to resume.";
  if (status === "destroyed") return "This workspace is closed.";
  return "We are preparing Agent Bridge for your project. You can keep this page open for status.";
}

function statusTone(status: FrontendWorkspaceStatus | null): string {
  if (status === "ready") return "ready";
  if (status === "failed") return "failed";
  if (!status) return "new";
  return "pending";
}

function checklistItem(label: string, done: boolean): string {
  return `
    <li class="check-item ${done ? "done" : "todo"}">
      <span class="check-mark" aria-hidden="true">${done ? "✓" : "•"}</span>
      <span><strong>${label}</strong> ${done ? "Connected" : "Not connected"}</span>
    </li>`;
}

function renderPrimaryAction(state: FrontendWorkspaceState): string {
  const provider = chatLabel(state.connections.chatProvider);
  if (!state.workspace) {
    return `<button class="primary" data-action="create-workspace">Create Workspace</button>`;
  }
  if (state.workspace.status === "failed") {
    return `<button class="primary" data-action="retry-workspace">Try again</button>
      <a class="secondary" href="${escapeHtml(state.links.supportUrl)}">Contact support</a>`;
  }
  const label = state.connections.chat ? "Open Agent Bridge" : `Connect ${provider}`;
  return `<a class="primary" href="${escapeHtml(chatUrl(state))}" rel="noopener">${label}</a>`;
}

function renderEvents(state: FrontendWorkspaceState): string {
  const items = state.events.slice(-6).map((event) => {
    const label = EVENT_LABELS[event.type] || "Workspace updated";
    return `
      <li class="event">
        <span class="event-dot" aria-hidden="true"></span>
        <span>
          <strong>${productText(label)}</strong>
          <time datetime="${escapeHtml(event.createdAt)}">${productText(new Date(event.createdAt).toLocaleString("en-GB", {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          }))}</time>
        </span>
      </li>`;
  }).join("");
  return `
    <section class="panel timeline" aria-labelledby="events-heading">
      <h2 id="events-heading">Recent workspace events</h2>
      <ol>${items || `<li class="empty">No events yet</li>`}</ol>
    </section>`;
}

function renderChecklist(state: FrontendWorkspaceState): string {
  const workspaceReady = state.workspace?.status === "ready";
  return `
    <section class="panel" aria-labelledby="checklist-heading">
      <h2 id="checklist-heading">Launch checklist</h2>
      <ul class="checklist">
        ${checklistItem("GitHub", state.connections.github)}
        ${checklistItem("Chat", state.connections.chat)}
        ${checklistItem("Project", !!state.workspace)}
        ${checklistItem("Workspace", workspaceReady)}
      </ul>
    </section>`;
}

function renderStatusPanel(state: FrontendWorkspaceState): string {
  const status = state.workspace?.status || null;
  const statusLabel = status === "installing_appliance" ? "pending" : status || "not started";
  return `
    <section class="panel status-panel" aria-labelledby="status-heading">
      <h2 id="status-heading">Read-only status</h2>
      <dl>
        <div><dt>Workspace</dt><dd>${productText(statusLabel.replaceAll("_", " "))}</dd></div>
        <div><dt>GitHub</dt><dd>${state.connections.github ? "Connected" : "Not connected"}</dd></div>
        <div><dt>Chat</dt><dd>${state.connections.chat ? "Connected" : "Not connected"}</dd></div>
      </dl>
    </section>`;
}

export function renderControlPlaneFrontend(state: FrontendWorkspaceState): string {
  const status = state.workspace?.status || null;
  const title = workspaceTitle(status);
  const tone = statusTone(status);
  const projectName = state.workspace?.projectName || "New Project";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Bridge Workspace</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --surface: #ffffff;
      --text: #17202a;
      --muted: #5f6b7a;
      --line: #d9dee7;
      --blue: #2563eb;
      --green: #16803c;
      --red: #b42318;
      --amber: #9a6700;
      --teal: #0f766e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
      letter-spacing: 0;
    }
    main {
      width: min(1080px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      margin-bottom: 24px;
    }
    .brand { font-weight: 700; font-size: 18px; }
    .session { color: var(--muted); font-size: 14px; }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.8fr);
      gap: 16px;
      align-items: stretch;
    }
    .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 20px;
    }
    .lead h1 { margin: 0 0 10px; font-size: 32px; line-height: 1.15; }
    .lead p { margin: 0 0 18px; color: var(--muted); max-width: 660px; line-height: 1.55; }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 16px;
    }
    .badge.ready { color: var(--green); background: #eaf7ee; }
    .badge.failed { color: var(--red); background: #fdeceb; }
    .badge.pending { color: var(--amber); background: #fff5d6; }
    .badge.new { color: var(--teal); background: #e7f6f4; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .primary, .secondary {
      min-height: 40px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      padding: 0 14px;
      font-weight: 700;
      text-decoration: none;
      border: 1px solid transparent;
      cursor: pointer;
      font: inherit;
    }
    .primary { background: var(--blue); color: #fff; }
    .secondary { background: #fff; color: var(--text); border-color: var(--line); }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
      margin-top: 16px;
    }
    h2 { margin: 0 0 14px; font-size: 18px; }
    .checklist, .timeline ol { list-style: none; padding: 0; margin: 0; }
    .check-item {
      min-height: 36px;
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--muted);
    }
    .check-item.done { color: var(--text); }
    .check-mark {
      width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: #eef2f7;
      color: var(--muted);
      flex: 0 0 22px;
    }
    .done .check-mark { background: #eaf7ee; color: var(--green); }
    .status-panel dl { margin: 0; display: grid; gap: 12px; }
    .status-panel div { display: flex; justify-content: space-between; gap: 16px; }
    dt { color: var(--muted); }
    dd { margin: 0; font-weight: 700; text-align: right; }
    .event {
      display: grid;
      grid-template-columns: 14px minmax(0, 1fr);
      gap: 10px;
      padding: 8px 0;
    }
    .event-dot {
      width: 8px;
      height: 8px;
      margin-top: 6px;
      border-radius: 50%;
      background: var(--blue);
    }
    time { display: block; color: var(--muted); font-size: 13px; margin-top: 2px; }
    .empty { color: var(--muted); }
    @media (max-width: 760px) {
      main { width: min(100% - 24px, 1080px); padding: 20px 0; }
      header, .hero { grid-template-columns: 1fr; display: grid; }
      .grid { grid-template-columns: 1fr; }
      .lead h1 { font-size: 26px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="brand">Agent Bridge</div>
      <div class="session">${state.session.signedIn ? `Welcome, ${productText(state.session.displayName)}` : "Sign in to continue"}</div>
    </header>
    <section class="hero">
      <div class="panel lead">
        <span class="badge ${tone}">${productText(status || "new workspace")}</span>
        <h1>${productText(title)}</h1>
        <p>${productText(workspaceCopy(status))}</p>
        <p><strong>Project:</strong> ${productText(projectName)}</p>
        <div class="actions">${renderPrimaryAction(state)}</div>
      </div>
      ${renderChecklist(state)}
    </section>
    <section class="grid">
      ${renderStatusPanel(state)}
      ${renderEvents(state)}
      <section class="panel" aria-labelledby="operate-heading">
        <h2 id="operate-heading">Launch</h2>
        <p>${state.connections.chat ? "Use chat as the main operating interface for Agent Bridge." : `Pair ${chatLabel(state.connections.chatProvider)} to unlock Agent Bridge.`}</p>
        <div class="actions">${state.connections.chat ? `<a class="primary" href="${escapeHtml(chatUrl(state))}" rel="noopener">Open Agent Bridge</a>` : `<a class="secondary" href="${escapeHtml(chatUrl(state))}" rel="noopener">Connect ${chatLabel(state.connections.chatProvider)}</a>`}</div>
      </section>
    </section>
  </main>
</body>
</html>`;
}
