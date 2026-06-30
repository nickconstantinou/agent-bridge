import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface HeartbeatPayload {
  workspaceId: string;
  status: string;
  timestamp: string;
  apps: {
    name: string;
    port: number;
    domain: string;
    healthStatus: string | null;
  }[];
}

export async function sendHeartbeat(
  controlPlaneUrl: string,
  workspaceId: string,
  status = "ready",
  apps: HeartbeatPayload["apps"] = []
): Promise<void> {
  const payload: HeartbeatPayload = {
    workspaceId,
    status,
    timestamp: new Date().toISOString(),
    apps,
  };

  const response = await fetch(`${controlPlaneUrl}/api/workspaces/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Failed to send heartbeat to control plane: ${response.statusText}`);
  }
}

export function startHeartbeatLoop(
  controlPlaneUrl: string,
  workspaceId: string,
  intervalMs = 30000
): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const apps: HeartbeatPayload["apps"] = [];
      await sendHeartbeat(controlPlaneUrl, workspaceId, "ready", apps);
    } catch (err) {
      // Swallow error to avoid crashing the loop
    }
  }, intervalMs);
}
