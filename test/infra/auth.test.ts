import { describe, expect, it, beforeEach } from "vitest";
import {
  generateSetupToken,
  verifySetupToken,
  consumeSetupToken,
  registerAppliance,
  isCommandAllowed,
  getOnboardingStatus,
} from "../../src/infra/auth.js";
import type { WorkspaceState } from "../../src/infra/state.js";

describe("Agent Bridge MVP Onboarding & Auth", () => {
  let mockState: WorkspaceState;

  beforeEach(() => {
    mockState = {
      workspaceId: "ws-123",
      customerId: "cust-456",
      repo: "",
      branch: "main",
      domain: "app.example.com",
      status: "creating",
      provider: "aruba",
      serverId: "server-1",
      serverName: "ab-ws-123",
      firewallId: "sg-1",
      sshKeyId: "key-1",
      ip: "198.51.100.10",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: {},
    };
  });

  describe("Setup Token Lifecycle", () => {
    it("generates a setup token with correct properties", () => {
      const token = generateSetupToken(mockState, 1000 * 60); // 1 minute
      expect(token).toBeDefined();
      expect(mockState.setupToken).toBeDefined();
      expect(mockState.setupToken?.token).toBe(token);
      expect(mockState.setupToken?.used).toBe(false);
      expect(new Date(mockState.setupToken!.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("verifies a valid token", () => {
      const token = generateSetupToken(mockState, 1000 * 60);
      expect(verifySetupToken(mockState, token)).toBe(true);
    });

    it("rejects an invalid token", () => {
      generateSetupToken(mockState, 1000 * 60);
      expect(verifySetupToken(mockState, "invalid-token")).toBe(false);
    });

    it("rejects an expired token", () => {
      const token = generateSetupToken(mockState, -1000); // Expired 1 second ago
      expect(verifySetupToken(mockState, token)).toBe(false);
    });

    it("rejects an already used token", () => {
      const token = generateSetupToken(mockState, 1000 * 60);
      consumeSetupToken(mockState, token);
      expect(verifySetupToken(mockState, token)).toBe(false);
    });
  });

  describe("Outbound Registration", () => {
    it("successfully registers the appliance and transition state", () => {
      const token = generateSetupToken(mockState, 1000 * 60);
      const success = registerAppliance(mockState, token);
      expect(success).toBe(true);
      expect(mockState.status).toBe("bootstrap");
      expect(mockState.setupToken?.used).toBe(true);
    });

    it("fails registration if token is invalid or expired", () => {
      generateSetupToken(mockState, -1000); // Expired
      const success = registerAppliance(mockState, "expired-or-invalid");
      expect(success).toBe(false);
      expect(mockState.status).toBe("creating");
    });
  });

  describe("Setup Checklist / Onboarding Status", () => {
    it("returns correct checklist status for each step", () => {
      const initialStatus = getOnboardingStatus(mockState);
      expect(initialStatus.workspaceProvisioned).toBe(true); // serverId is set
      expect(initialStatus.applianceRegistered).toBe(false);
      expect(initialStatus.githubConnected).toBe(false);
      expect(initialStatus.chatConnected).toBe(false);
      expect(initialStatus.cliAuthenticated).toBe(false);
      expect(initialStatus.isReady).toBe(false);

      // Connect everything
      mockState.setupToken = { token: "tok", expiresAt: new Date(Date.now() + 60000).toISOString(), used: true };
      mockState.status = "bootstrap";
      mockState.githubConnected = true;
      mockState.chatConnected = true;
      mockState.chatChannel = "telegram";
      mockState.chatId = "12345";
      mockState.cliAuthenticated = true;

      const updatedStatus = getOnboardingStatus(mockState);
      expect(updatedStatus.applianceRegistered).toBe(true);
      expect(updatedStatus.githubConnected).toBe(true);
      expect(updatedStatus.chatConnected).toBe(true);
      expect(updatedStatus.cliAuthenticated).toBe(true);

      // Now set overall workspace status to ready
      mockState.status = "ready";
      expect(getOnboardingStatus(mockState).isReady).toBe(true);
    });
  });

  describe("Bot Command Gating", () => {
    it("blocks management commands if onboarding is not complete", () => {
      mockState.status = "bootstrap";
      expect(isCommandAllowed(mockState, "/deploy")).toBe(false);
      expect(isCommandAllowed(mockState, "/status")).toBe(false);
      expect(isCommandAllowed(mockState, "/health")).toBe(false);
    });

    it("allows commands once the workspace is ready", () => {
      mockState.status = "ready";
      expect(isCommandAllowed(mockState, "/deploy")).toBe(true);
      expect(isCommandAllowed(mockState, "/status")).toBe(true);
      expect(isCommandAllowed(mockState, "/health")).toBe(true);
      expect(isCommandAllowed(mockState, "/fix")).toBe(true);
      expect(isCommandAllowed(mockState, "/rollback")).toBe(true);
    });
  });
});
