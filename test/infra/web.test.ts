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
    server.closeAllConnections();
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

  it("integrates GitHub callback boundary", async () => {
    // 1. Invalid OAuth code prefix
    const resBadCode = await fetch(`http://localhost:${serverPort}/setup/github/callback?state=session-123&code=bad_code`);
    expect(resBadCode.status).toBe(400);

    // 2. Invalid session token
    const resBadState = await fetch(`http://localhost:${serverPort}/setup/github/callback?state=invalid-state&code=github_code_123`);
    expect(resBadState.status).toBe(403);

    // 3. Valid OAuth callback
    const resOk = await fetch(`http://localhost:${serverPort}/setup/github/callback?state=session-123&code=github_code_123`, { redirect: "manual" });
    expect(resOk.status).toBe(302);
    expect(resOk.headers.get("location")).toBe("/setup/session-123");

    // Read state to verify metadata
    const updatedState = readWorkspaceState(statePath)!;
    expect(updatedState.githubConnected).toBe(true);
    expect(updatedState.githubUsername).toBe("github_user");
    expect(updatedState.githubInstallationId).toBe("inst_999");
  });

  it("integrates chat pairing boundary", async () => {
    // Trigger pairing code generation by loading the setup page
    await fetch(`http://localhost:${serverPort}/setup/session-123`);

    // Read state to get pairing code
    let currentState = readWorkspaceState(statePath)!;
    expect(currentState.pairingCode).toBeDefined();
    const code = currentState.pairingCode!.code;

    // 1. Post wrong pairing code
    const resBadPair = await fetch(`http://localhost:${serverPort}/setup/session-123/chat/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `code=999999&chatChannel=telegram&chatId=11111`
    });
    expect(resBadPair.status).toBe(400);

    // 2. Post correct pairing code
    const resOk = await fetch(`http://localhost:${serverPort}/setup/session-123/chat/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `code=${code}&chatChannel=telegram&chatId=12345`
    });
    expect(resOk.status).toBe(200);

    // Read state to verify pairing
    const updatedState = readWorkspaceState(statePath)!;
    expect(updatedState.chatConnected).toBe(true);
    expect(updatedState.chatChannel).toBe("telegram");
    expect(updatedState.chatId).toBe("12345");
    expect(updatedState.pairingCode).toBeUndefined();
  });

  it("integrates CLI verification boundary", async () => {
    // 1. Post invalid credentials
    const resBad = await fetch(`http://localhost:${serverPort}/setup/session-123/cli/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `provider=claude&token=invalid_token`,
      redirect: "manual"
    });
    expect(resBad.status).toBe(302);
    expect(resBad.headers.get("location")).toBe("/setup/session-123?error=cli_verification_failed");

    // 2. Post valid credentials
    const resOk = await fetch(`http://localhost:${serverPort}/setup/session-123/cli/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `provider=claude&token=valid_my_token`,
      redirect: "manual"
    });
    expect(resOk.status).toBe(302);
    expect(resOk.headers.get("location")).toBe("/setup/session-123");

    // Read state to verify cli status
    const updatedState = readWorkspaceState(statePath)!;
    expect(updatedState.cliAuthenticated).toBe(true);
    expect(updatedState.cliProvider).toBe("claude");
  });

  it("integrates repo selection boundary and enforces GitHub connection dependency", async () => {
    // 1. Attempt selecting repo when GitHub is not connected
    const resNoGithub = await fetch(`http://localhost:${serverPort}/setup/session-123/repo`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `repo=owner/repo`
    });
    expect(resNoGithub.status).toBe(400);

    // 2. Mark GitHub connected directly in state
    let currentState = readWorkspaceState(statePath)!;
    currentState.githubConnected = true;
    writeFileSync(statePath, JSON.stringify(currentState, null, 2));

    // 3. Attempt selecting repo now
    const resOk = await fetch(`http://localhost:${serverPort}/setup/session-123/repo`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `repo=owner/my-first-repo`,
      redirect: "manual"
    });
    expect(resOk.status).toBe(302);

    // Read state to verify repo is set
    const updatedState = readWorkspaceState(statePath)!;
    expect(updatedState.repo).toBe("owner/my-first-repo");
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
