import { describe, expect, it } from "vitest";
import { renderControlPlaneFrontend, type FrontendWorkspaceState } from "../../src/control-plane/frontend.js";

const baseState: FrontendWorkspaceState = {
  session: { signedIn: true, displayName: "Alex" },
  workspace: null,
  connections: { github: false, chat: false, chatProvider: "telegram" },
  events: [],
  links: {
    telegramUrl: "https://t.me/agent_bridge_bot?start=workspace",
    discordUrl: "https://discord.com/channels/@me",
    supportUrl: "mailto:support@example.com",
  },
};

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("control-plane frontend", () => {
  it("renders the welcome/create workspace screen with sign-in placeholder", () => {
    const html = renderControlPlaneFrontend(baseState);

    expect(text(html)).toContain("Welcome, Alex");
    expect(text(html)).toContain("Create your workspace");
    expect(text(html)).toContain("Agent Bridge runs from chat");
    expect(html).toContain("data-action=\"create-workspace\"");
  });

  it("renders pending creation with launch checklist and product-language timeline", () => {
    const html = renderControlPlaneFrontend({
      ...baseState,
      workspace: { id: "ws-1", status: "installing_appliance", projectName: "Launch Project" },
      connections: { github: true, chat: false, chatProvider: "telegram" },
      events: [
        { type: "workspace_created", createdAt: "2026-07-01T10:00:00.000Z" },
        { type: "provisioning_started", createdAt: "2026-07-01T10:00:01.000Z" },
        { type: "infrastructure_ready", createdAt: "2026-07-01T10:00:02.000Z" },
        { type: "appliance_installing", createdAt: "2026-07-01T10:00:03.000Z" },
      ],
    });

    expect(text(html)).toContain("Creating your workspace");
    expect(text(html)).toContain("GitHub Connected");
    expect(text(html)).toContain("Chat Not connected");
    expect(text(html)).toContain("Workspace started");
    expect(text(html)).toContain("Agent Bridge is joining");
    expect(html).toContain("Connect Telegram");
  });

  it("renders ready state with primary CTA to chat", () => {
    const html = renderControlPlaneFrontend({
      ...baseState,
      workspace: { id: "ws-1", status: "ready", projectName: "Launch Project" },
      connections: { github: true, chat: true, chatProvider: "telegram" },
      events: [
        { type: "appliance_registered", createdAt: "2026-07-01T10:00:04.000Z" },
        { type: "workspace_ready", createdAt: "2026-07-01T10:00:05.000Z" },
      ],
    });

    expect(text(html)).toContain("Workspace ready");
    expect(text(html)).toContain("Open Agent Bridge");
    expect(html).toContain("https://t.me/agent_bridge_bot?start=workspace");
    expect(text(html)).toContain("Read-only status");
  });

  it("renders failed state with retry/support copy", () => {
    const html = renderControlPlaneFrontend({
      ...baseState,
      workspace: { id: "ws-1", status: "failed", projectName: "Launch Project" },
      events: [{ type: "workspace_failed", createdAt: "2026-07-01T10:00:06.000Z", message: "Provider error: Elastic IP failed" }],
    });

    expect(text(html)).toContain("Workspace setup needs attention");
    expect(text(html)).toContain("Try again");
    expect(text(html)).toContain("Contact support");
  });

  it("redacts infrastructure and provider terminology from rendered HTML", () => {
    const html = renderControlPlaneFrontend({
      ...baseState,
      workspace: { id: "ws-1", status: "failed", projectName: "Launch Project" },
      events: [
        {
          type: "workspace_failed",
          createdAt: "2026-07-01T10:00:06.000Z",
          message: "Aruba VPS SSH Caddy systemd SQLite Elastic IP security group provider error",
        },
      ],
    });

    const forbidden = ["Aruba", "VPS", "SSH", "Caddy", "systemd", "SQLite", "Elastic IP", "security group", "provider error"];
    for (const term of forbidden) {
      expect(html).not.toContain(term);
    }
    expect(text(html)).toContain("Workspace setup needs attention");
  });
});
