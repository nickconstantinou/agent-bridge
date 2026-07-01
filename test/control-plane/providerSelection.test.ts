import { describe, expect, it } from "vitest";
import { MockWorkspaceProvider } from "../../src/control-plane/mockProvider.js";
import { ControlPlaneArubaProvider } from "../../src/control-plane/arubaProvider.js";
import { createWorkspaceProviderFromEnv } from "../../src/control-plane/providerFactory.js";

describe("control-plane provider selection", () => {
  it("defaults to the mocked provider", () => {
    const provider = createWorkspaceProviderFromEnv({});
    expect(provider).toBeInstanceOf(MockWorkspaceProvider);
  });

  it("keeps live Aruba disabled unless explicitly enabled", () => {
    const provider = createWorkspaceProviderFromEnv({
      CONTROL_PLANE_PROVIDER: "aruba",
      ARUBA_LIVE_DRY_RUN: "true",
    });
    expect(provider).toBeInstanceOf(MockWorkspaceProvider);
  });

  it("selects Aruba only with explicit provider and live enable flags", () => {
    const provider = createWorkspaceProviderFromEnv({
      CONTROL_PLANE_PROVIDER: "aruba",
      ARUBA_LIVE_ENABLED: "true",
      ARUBA_LIVE_DRY_RUN: "true",
      ARUBA_PROJECT_ID: "project-123",
      ARUBA_ALLOWED_PROJECT_IDS: "project-123",
    });
    expect(provider).toBeInstanceOf(ControlPlaneArubaProvider);
    expect((provider as ControlPlaneArubaProvider).dryRun).toBe(true);
  });
});
