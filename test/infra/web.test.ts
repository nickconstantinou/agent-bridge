import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSetupServer } from "../../src/infra/web.js";
import { isCommandAllowed } from "../../src/infra/auth.js";
import { readWorkspaceState, type WorkspaceState } from "../../src/infra/state.js";

describe("Setup Web Portal", () => {
  let tmpDir: string;
  let statePath: string;
  let state: WorkspaceState;
  let server: Server;
  let serverPort: number;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ab-web-test-"));
    statePath = join(tmpDir, "workspace-state.json");

    state = {
      workspaceId: "ws-123",
      customerId: "cust-456",
      repo: "",
      branch: "main",
      domain: "app.example.com",
      status: "bootstrap",
      provider: "aruba",
      serverId: "server-1",
      serverName: "ab-ws-123",
      firewallId: "sg-1",
      sshKeyId: "key-1",
      ip: "198.51.100.10",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: {},
      setupToken: {
        token: "setup-token",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        used: true, // Used for registration already
      },
      // Setup session token
      githubConnected: false,
      chatConnected: false,
      cliAuthenticated: false,
    };

    // Store a valid setup session token
    (state as any).sessionToken = {
      token: "session-123",
      expiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour
      used: false,
    };

    writeFileSync(statePath, JSON.stringify(state, null, 2));

    server = createSetupServer(state, statePath);
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        serverPort = (server.address() as any).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders the setup page for a valid session token", async () => {
    const res = await fetch(`http://localhost:${serverPort}/setup/session-123`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Workspace Onboarding");
    expect(html).toContain("checklist");
  });

  it("rejects invalid or expired session tokens with 403", async () => {
    const res = await fetch(`http://localhost:${serverPort}/setup/invalid-session-token`);
    expect(res.status).toBe(403);
  });

  it("updates checklist items when corresponding actions are posted", async () => {
    // 1. Post GitHub connection
    const resGithub = await fetch(`http://localhost:${serverPort}/setup/session-123/github`, { method: "POST" });
    expect(resGithub.status).toBe(200);
    
    // 2. Post Chat connection
    const resChat = await fetch(`http://localhost:${serverPort}/setup/session-123/chat`, { method: "POST" });
    expect(resChat.status).toBe(200);

    // 3. Post CLI authentication
    const resCli = await fetch(`http://localhost:${serverPort}/setup/session-123/cli`, { method: "POST" });
    expect(resCli.status).toBe(200);

    // 4. Post first repo selection
    const resRepo = await fetch(`http://localhost:${serverPort}/setup/session-123/repo`, { method: "POST" });
    expect(resRepo.status).toBe(200);

    // Read state to verify updates
    const updatedState = readWorkspaceState(statePath)!;
    expect(updatedState.githubConnected).toBe(true);
    expect(updatedState.chatConnected).toBe(true);
    expect(updatedState.cliAuthenticated).toBe(true);
    expect(updatedState.repo).toBe("github-owner/my-first-repo");
  });

  it("prevents onboarding completion if checklist is incomplete", async () => {
    const res = await fetch(`http://localhost:${serverPort}/setup/session-123/complete`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Checklist is not fully completed");

    // Command gating should still block
    const updatedState = readWorkspaceState(statePath)!;
    expect(isCommandAllowed(updatedState, "/deploy")).toBe(false);
  });

  it("allows onboarding completion and releases bot gating when checklist is complete", async () => {
    // Complete all items in state
    state.githubConnected = true;
    state.chatConnected = true;
    state.cliAuthenticated = true;
    state.repo = "owner/repo";
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    const res = await fetch(`http://localhost:${serverPort}/setup/session-123/complete`, { method: "POST" });
    expect(res.status).toBe(200);

    // Read state to verify workspace is ready and session is consumed
    const updatedState = readWorkspaceState(statePath)!;
    expect(updatedState.status).toBe("ready");
    expect((updatedState as any).sessionToken.used).toBe(true);

    // Bot commands must be allowed now
    expect(isCommandAllowed(updatedState, "/deploy")).toBe(true);
  });
});
