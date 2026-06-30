import { createServer, type Server } from "node:http";
import { readWorkspaceState, writeWorkspaceState, type WorkspaceState } from "./state.js";

export function verifySessionToken(state: WorkspaceState, token: string): boolean {
  if (!state.sessionToken) return false;
  if (state.sessionToken.token !== token) return false;
  if (state.sessionToken.used) return false;
  if (new Date(state.sessionToken.expiresAt).getTime() <= Date.now()) return false;
  return true;
}

export function createSetupServer(state: WorkspaceState, statePath: string): Server {
  return createServer((req, res) => {
    const url = req.url || "";
    const method = req.method || "GET";

    const match = url.match(/^\/setup\/([a-zA-Z0-9-]+)(?:\/(github|chat|cli|repo|complete))?$/);
    if (!match) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const token = match[1];
    const action = match[2];

    const currentState = readWorkspaceState(statePath) || state;

    if (!verifySessionToken(currentState, token)) {
      res.writeHead(403, { "Content-Type": "text/html" });
      res.end("<h1>403 Forbidden</h1><p>Invalid, expired, or already used onboarding session token.</p>");
      return;
    }

    if (method === "GET" && !action) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(renderSetupPage(currentState, token));
      return;
    }

    if (method === "POST" && action) {
      if (action === "github") {
        currentState.githubConnected = true;
      } else if (action === "chat") {
        currentState.chatConnected = true;
        currentState.chatChannel = "telegram";
        currentState.chatId = "123456789";
      } else if (action === "cli") {
        currentState.cliAuthenticated = true;
      } else if (action === "repo") {
        currentState.repo = "github-owner/my-first-repo";
      } else if (action === "complete") {
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
      }

      writeWorkspaceState(statePath, currentState);

      if (action === "complete") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Success</h1><p>Onboarding complete! You can now manage your workspace via Telegram/Discord.</p>");
      } else {
        res.writeHead(302, { Location: `/setup/${token}` });
        res.end();
      }
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
    form {
      margin: 0;
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
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>Workspace Onboarding</h1>
      <p class="subtitle">Complete the setup checklist to activate your Agent Bridge workspace</p>
      
      <div class="status-badge">Status: ${state.status.toUpperCase()}</div>

      <div class="checklist">
        <div class="checklist-item">
          <div class="item-info">
            <div class="status-dot ${isGithub ? "complete" : ""}"></div>
            <div>
              <div class="item-title">GitHub Connection</div>
              <div class="item-detail">${isGithub ? "Connected successfully" : "Link your GitHub account"}</div>
            </div>
          </div>
          ${
            isGithub
              ? '<button class="btn disabled" disabled>Connected</button>'
              : `<form action="/setup/${token}/github" method="POST"><button class="btn" type="submit">Connect GitHub</button></form>`
          }
        </div>

        <div class="checklist-item">
          <div class="item-info">
            <div class="status-dot ${isChat ? "complete" : ""}"></div>
            <div>
              <div class="item-title">Telegram / Discord Bot</div>
              <div class="item-detail">${isChat ? "Linked successfully" : "Connect your chat channel"}</div>
            </div>
          </div>
          ${
            isChat
              ? '<button class="btn disabled" disabled>Connected</button>'
              : `<form action="/setup/${token}/chat" method="POST"><button class="btn" type="submit">Connect Chat</button></form>`
          }
        </div>

        <div class="checklist-item">
          <div class="item-info">
            <div class="status-dot ${isCli ? "complete" : ""}"></div>
            <div>
              <div class="item-title">CLI Authentication</div>
              <div class="item-detail">${isCli ? "CLI Authenticated" : "Verify coding CLI access"}</div>
              ${
                !isCli
                  ? '<div class="cli-instructions">npm install -g @google/agy-cli<br>agy auth login</div>'
                  : ""
              }
            </div>
          </div>
          ${
            isCli
              ? '<button class="btn disabled" disabled>Verified</button>'
              : `<form action="/setup/${token}/cli" method="POST"><button class="btn" type="submit">Verify Auth</button></form>`
          }
        </div>

        <div class="checklist-item">
          <div class="item-info">
            <div class="status-dot ${isRepo ? "complete" : ""}"></div>
            <div>
              <div class="item-title">Select First Repository</div>
              <div class="item-detail">${isRepo ? `Selected: ${state.repo}` : "Choose a repository to manage"}</div>
            </div>
          </div>
          ${
            isRepo
              ? '<button class="btn disabled" disabled>Selected</button>'
              : `<form action="/setup/${token}/repo" method="POST"><button class="btn" type="submit">Select Repo</button></form>`
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
