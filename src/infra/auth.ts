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
