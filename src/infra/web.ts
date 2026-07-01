import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readWorkspaceState, writeWorkspaceState, type WorkspaceState } from "./state.js";
import {
  verifySessionToken,
  generatePairingCode,
  pairChat,
  verifyAndRecordCli,
} from "./auth.js";

async function parseBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const result: Record<string, string> = {};
      for (const [key, value] of params.entries()) {
        result[key] = value;
      }
      resolve(result);
    });
  });
}

export function createSetupServer(state: WorkspaceState, statePath: string): Server {
  return createServer(async (req, res) => {
    res.setHeader("Connection", "close");
    const url = req.url || "";
    const method = req.method || "GET";
    const parsedUrl = new URL(url, "http://localhost");

    // 1. GitHub Callback Route (does not contain token in path, uses state query param)
    if (parsedUrl.pathname === "/setup/github/callback") {
      const stateToken = parsedUrl.searchParams.get("state") || "";
      const code = parsedUrl.searchParams.get("code") || "";
      const currentState = readWorkspaceState(statePath) || state;

      if (!verifySessionToken(currentState, stateToken)) {
        res.writeHead(403, { "Content-Type": "text/html" });
        res.end("<h1>403 Forbidden</h1><p>Invalid or expired state session.</p>");
        return;
      }

      if (!code || !code.startsWith("github_")) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid code");
        return;
      }

      currentState.githubConnected = true;
      currentState.githubUsername = "github_user";
      currentState.githubInstallationId = "inst_999";
      writeWorkspaceState(statePath, currentState);

      res.writeHead(302, { Location: `/setup/${stateToken}` });
      res.end();
      return;
    }

    // 2. Token-scoped routes
    const match = parsedUrl.pathname.match(/^\/setup\/([a-zA-Z0-9-]+)(?:\/(github\/oauth|chat\/pair|cli\/verify|repo|complete))?$/);
    if (!match) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const token = match[1];
    const subRoute = match[2];

    const currentState = readWorkspaceState(statePath) || state;

    if (!verifySessionToken(currentState, token)) {
      res.writeHead(403, { "Content-Type": "text/html" });
      res.end("<h1>403 Forbidden</h1><p>Invalid or expired session token.</p>");
      return;
    }

    // GET /setup/:token -> Render Page
    if (method === "GET" && !subRoute) {
      // Ensure pairing code exists and is active
      if (!currentState.pairingCode || new Date(currentState.pairingCode.expiresAt).getTime() <= Date.now()) {
        generatePairingCode(currentState);
        writeWorkspaceState(statePath, currentState);
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(renderSetupPage(currentState, token));
      return;
    }

    // GET /setup/:token/github/oauth -> Redirect to GitHub OAuth simulation
    if (method === "GET" && subRoute === "github/oauth") {
      res.writeHead(302, { Location: `/setup/github/callback?state=${token}&code=github_code_123` });
      res.end();
      return;
    }

    // POST /setup/:token/chat/pair -> Bot Command simulation/call
    if (method === "POST" && subRoute === "chat/pair") {
      const body = await parseBody(req);
      const code = body.code || parsedUrl.searchParams.get("code") || "";
      const chatChannel = (body.chatChannel || parsedUrl.searchParams.get("chatChannel") || "telegram") as "telegram" | "discord";
      const chatId = body.chatId || parsedUrl.searchParams.get("chatId") || "";

      const ok = pairChat(currentState, code, chatChannel, chatId);
      if (!ok) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid or expired pairing code");
        return;
      }

      writeWorkspaceState(statePath, currentState);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Paired successfully");
      return;
    }

    // POST /setup/:token/cli/verify -> CLI verification form handler
    if (method === "POST" && subRoute === "cli/verify") {
      const body = await parseBody(req);
      const provider = body.provider || "";
      const cliToken = body.token || "";

      const ok = await verifyAndRecordCli(currentState, provider, cliToken);
      if (!ok) {
        res.writeHead(302, { Location: `/setup/${token}?error=cli_verification_failed` });
        res.end();
        return;
      }

      writeWorkspaceState(statePath, currentState);
      res.writeHead(302, { Location: `/setup/${token}` });
      res.end();
      return;
    }

    // POST /setup/:token/repo -> Repo selection handler
    if (method === "POST" && subRoute === "repo") {
      if (!currentState.githubConnected) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("GitHub must be connected first");
        return;
      }

      const body = await parseBody(req);
      const repo = body.repo || "";
      if (!repo) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Repo is required");
        return;
      }

      currentState.repo = repo;
      writeWorkspaceState(statePath, currentState);
      res.writeHead(302, { Location: `/setup/${token}` });
      res.end();
      return;
    }

    // POST /setup/:token/complete -> Onboarding completion validator
    if (method === "POST" && subRoute === "complete") {
      const isComplete =
        currentState.githubConnected &&
        currentState.chatConnected &&
        currentState.cliAuthenticated &&
        currentState.repo;

      if (!isComplete) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Checklist is not fully completed");
        return;
      }

      currentState.status = "ready";
      if (currentState.sessionToken) {
        currentState.sessionToken.used = true;
      }
      writeWorkspaceState(statePath, currentState);

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Success</h1><p>Onboarding complete! You can now manage your workspace via Telegram/Discord.</p>");
      return;
    }

    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
  });
}

function renderSetupPage(state: WorkspaceState, token: string): string {
  const isGithub = !!state.githubConnected;
  const isChat = !!state.chatConnected;
  const isCli = !!state.cliAuthenticated;
  const isRepo = !!state.repo;
  const allDone = isGithub && isChat && isCli && isRepo;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Workspace Onboarding - Agent Bridge</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: #0f172a;
      --card-bg: #1e293b;
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --success: #10b981;
      --border: #334155;
    }
    body {
      font-family: 'Outfit', sans-serif;
      background-color: var(--bg-color);
      color: var(--text-primary);
      margin: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .container {
      max-width: 600px;
      width: 100%;
      padding: 2rem;
    }
    .card {
      background-color: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 2.5rem;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
    }
    h1 {
      font-size: 2rem;
      font-weight: 800;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, #a5b4fc, #6366f1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle {
      color: var(--text-secondary);
      margin-bottom: 2rem;
    }
    .status-badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.875rem;
      font-weight: 600;
      background-color: var(--primary);
      color: white;
      margin-bottom: 1.5rem;
    }
    .checklist {
      margin-bottom: 2.5rem;
    }
    .checklist-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-bottom: 1rem;
      background-color: rgba(255, 255, 255, 0.01);
      transition: all 0.2s ease;
    }
    .checklist-item:hover {
      border-color: var(--primary);
      background-color: rgba(99, 102, 241, 0.03);
    }
    .item-info {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .status-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background-color: var(--text-secondary);
    }
    .status-dot.complete {
      background-color: var(--success);
    }
    .item-title {
      font-weight: 600;
    }
    .item-detail {
      font-size: 0.875rem;
      color: var(--text-secondary);
    }
    .btn {
      background-color: var(--primary);
      color: white;
      border: none;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
      font-weight: 600;
      text-decoration: none;
      display: inline-block;
      transition: background-color 0.2s;
    }
    .btn:hover {
      background-color: var(--primary-hover);
    }
    .btn.disabled {
      background-color: var(--border);
      color: var(--text-secondary);
      cursor: not-allowed;
    }
    .btn.complete-btn {
      width: 100%;
      padding: 0.875rem;
      font-size: 1rem;
      background-color: var(--success);
    }
    .btn.complete-btn:hover {
      background-color: #059669;
    }
    .btn.complete-btn.disabled {
      background-color: var(--border);
      color: var(--text-secondary);
    }
    .cli-instructions {
      margin-top: 0.5rem;
      background: rgba(0, 0, 0, 0.3);
      padding: 0.75rem;
      border-radius: 6px;
      font-family: monospace;
      font-size: 0.8rem;
      color: var(--text-secondary);
    }
    .form-group {
      margin-top: 0.5rem;
      display: flex;
      gap: 0.5rem;
    }
    .form-input {
      background-color: var(--bg-color);
      border: 1px solid var(--border);
      color: white;
      padding: 0.5rem;
      border-radius: 6px;
      font-family: inherit;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>Workspace Onboarding</h1>
      <p class="subtitle">Complete the setup checklist to activate your Agent Bridge workspace</p>
      
      <div class="status-badge">Status: ${state.status.toUpperCase()}</div>

      <div class="checklist">
        <!-- GitHub Connection -->
        <div class="checklist-item">
          <div class="item-info">
            <div class="status-dot ${isGithub ? "complete" : ""}"></div>
            <div>
              <div class="item-title">GitHub Connection</div>
              <div class="item-detail">${isGithub ? `Connected as @${state.githubUsername}` : "Link your GitHub account"}</div>
            </div>
          </div>
          ${
            isGithub
              ? '<button class="btn disabled" disabled>Connected</button>'
              : `<a class="btn" href="/setup/${token}/github/oauth">Connect GitHub</a>`
          }
        </div>

        <!-- Chat Connection -->
        <div class="checklist-item">
          <div class="item-info">
            <div class="status-dot ${isChat ? "complete" : ""}"></div>
            <div>
              <div class="item-title">Telegram / Discord Bot</div>
              <div class="item-detail">${isChat ? `Linked to ${state.chatChannel} (${state.chatId})` : "Pair your chat application"}</div>
              ${
                !isChat && state.pairingCode
                  ? `<div class="cli-instructions">Message the bot: /pair ${state.pairingCode.code}</div>`
                  : ""
              }
            </div>
          </div>
          <button class="btn disabled" disabled>${isChat ? "Connected" : "Pending bot /pair"}</button>
        </div>

        <!-- CLI Authentication -->
        <div class="checklist-item">
          <div class="item-info">
            <div class="status-dot ${isCli ? "complete" : ""}"></div>
            <div>
              <div class="item-title">CLI Authentication</div>
              <div class="item-detail">${isCli ? `Verified: ${state.cliProvider}` : "Verify coding CLI access"}</div>
              ${
                !isCli
                  ? `
                  <form action="/setup/${token}/cli/verify" method="POST" class="form-group">
                    <select name="provider" class="form-input">
                      <option value="claude">Claude</option>
                      <option value="codex">Codex</option>
                      <option value="gemini">Gemini</option>
                    </select>
                    <input type="password" name="token" placeholder="Key (starts with valid_)" class="form-input" required />
                    <button class="btn" type="submit">Verify</button>
                  </form>`
                  : ""
              }
            </div>
          </div>
          ${isCli ? '<button class="btn disabled" disabled>Verified</button>' : ""}
        </div>

        <!-- Select First Repo -->
        <div class="checklist-item">
          <div class="item-info">
            <div class="status-dot ${isRepo ? "complete" : ""}"></div>
            <div>
              <div class="item-title">Select First Repository</div>
              <div class="item-detail">${isRepo ? `Selected: ${state.repo}` : "Choose a repository to manage"}</div>
              ${
                !isRepo && isGithub
                  ? `
                  <form action="/setup/${token}/repo" method="POST" class="form-group">
                    <input type="text" name="repo" placeholder="owner/repo" class="form-input" required />
                    <button class="btn" type="submit">Select</button>
                  </form>`
                  : ""
              }
            </div>
          </div>
          ${
            isRepo
              ? '<button class="btn disabled" disabled>Selected</button>'
              : !isGithub
              ? '<button class="btn disabled" disabled>Requires GitHub</button>'
              : ""
          }
        </div>
      </div>

      <form action="/setup/${token}/complete" method="POST">
        <button class="btn complete-btn ${allDone ? "" : "disabled"}" type="submit" ${allDone ? "" : "disabled"}>
          Complete Setup & Activate Bot
        </button>
      </form>
    </div>
  </div>
</body>
</html>`;
}
