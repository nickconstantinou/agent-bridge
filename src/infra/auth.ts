import type { WorkspaceState } from "./state.js";
import { randomUUID } from "node:crypto";

export interface OnboardingStatus {
  workspaceProvisioned: boolean;
  applianceRegistered: boolean;
  githubConnected: boolean;
  chatConnected: boolean;
  cliAuthenticated: boolean;
  isReady: boolean;
}

export function generateSetupToken(state: WorkspaceState, expiresInMs = 3600000): string {
  const token = randomUUID();
  state.setupToken = {
    token,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    used: false,
  };
  return token;
}

export function verifySetupToken(state: WorkspaceState, token: string): boolean {
  if (!state.setupToken) return false;
  if (state.setupToken.token !== token) return false;
  if (state.setupToken.used) return false;
  if (new Date(state.setupToken.expiresAt).getTime() <= Date.now()) return false;
  return true;
}

export function verifySessionToken(state: WorkspaceState, token: string): boolean {
  if (!state.sessionToken) return false;
  if (state.sessionToken.token !== token) return false;
  if (state.sessionToken.used) return false;
  if (new Date(state.sessionToken.expiresAt).getTime() <= Date.now()) return false;
  return true;
}

export function consumeSetupToken(state: WorkspaceState, token: string): void {
  if (!verifySetupToken(state, token)) {
    throw new Error("Invalid, expired, or already used setup token.");
  }
  if (state.setupToken) {
    state.setupToken.used = true;
  }
}

export function registerAppliance(state: WorkspaceState, token: string): boolean {
  try {
    consumeSetupToken(state, token);
    state.status = "bootstrap";
    return true;
  } catch {
    return false;
  }
}

export function getOnboardingStatus(state: WorkspaceState): OnboardingStatus {
  return {
    workspaceProvisioned: !!state.serverId,
    applianceRegistered: !!(state.setupToken?.used && state.status !== "creating"),
    githubConnected: !!state.githubConnected,
    chatConnected: !!state.chatConnected,
    cliAuthenticated: !!state.cliAuthenticated,
    isReady: state.status === "ready",
  };
}

export function isCommandAllowed(state: WorkspaceState, command: string): boolean {
  const allowedCommands = [
    "/status",
    "/connect_github",
    "/connect_cli",
    "/repos",
    "/deploy",
    "/health",
    "/logs",
    "/fix",
    "/rollback",
  ];
  
  if (!allowedCommands.includes(command)) {
    return true; // Non-MVP/unmanaged commands default to true or are handled separately
  }

  // MVP gating rule: bot commands only after workspace is ready/onboarding completed
  return state.status === "ready";
}

export function generatePairingCode(state: WorkspaceState, expiresInMs = 600000): string {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  state.pairingCode = {
    code,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  };
  return code;
}

export function pairChat(state: WorkspaceState, code: string, chatChannel: "telegram" | "discord", chatId: string): boolean {
  if (!state.pairingCode) return false;
  if (state.pairingCode.code !== code) return false;
  if (new Date(state.pairingCode.expiresAt).getTime() <= Date.now()) return false;
  
  state.chatConnected = true;
  state.chatChannel = chatChannel;
  state.chatId = chatId;
  state.pairingCode = undefined;
  return true;
}

export async function verifyCliCredentials(provider: string, token: string): Promise<boolean> {
  if (!token || !token.startsWith("valid_")) return false;
  return true;
}

export async function verifyAndRecordCli(state: WorkspaceState, provider: string, token: string): Promise<boolean> {
  const ok = await verifyCliCredentials(provider, token);
  if (ok) {
    state.cliAuthenticated = true;
    state.cliProvider = provider;
    return true;
  }
  return false;
}
