import { ControlPlaneArubaProvider } from "./arubaProvider.js";
import { MockWorkspaceProvider } from "./mockProvider.js";
import type { WorkspaceProvider } from "./types.js";

export function createWorkspaceProviderFromEnv(env: Record<string, string | undefined> = process.env): WorkspaceProvider {
  const selected = (env.CONTROL_PLANE_PROVIDER || "mock").toLowerCase();
  if (selected !== "aruba") return new MockWorkspaceProvider();
  if (env.ARUBA_LIVE_ENABLED !== "true") return new MockWorkspaceProvider();
  return new ControlPlaneArubaProvider({
    env,
    dryRun: env.ARUBA_LIVE_DRY_RUN !== "false",
    projectId: env.ARUBA_PROJECT_ID,
  });
}
