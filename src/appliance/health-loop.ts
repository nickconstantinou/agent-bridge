import type { ApplianceDb } from "./state.js";
import { checkHealth, recordHealthIncident } from "./health.js";

export interface HealthLoopOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

export interface HealthLoopHandle {
  stop(): void;
}

const RUNNING_STATUSES = new Set(["deployed", "rollback-success", "restarted"]);

export function startHealthLoop(
  db: ApplianceDb,
  opts: HealthLoopOptions = {}
): HealthLoopHandle {
  const intervalMs = opts.intervalMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 5_000;

  const tick = async (): Promise<void> => {
    const apps = db.listApps();
    for (const app of apps) {
      if (!app.last_deploy_status || !RUNNING_STATUSES.has(app.last_deploy_status)) {
        continue;
      }
      const healthUrl = `http://localhost:${app.port}/health`;
      try {
        const result = await checkHealth(healthUrl, timeoutMs);
        if (!result.ok) {
          await recordHealthIncident(db, app.name, healthUrl, result, "health-loop");
        }
      } catch {
        // Per-app errors must not crash the loop
      }
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
