import type { ApplianceDb } from "./state.js";

export interface HealthResult {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error: string | null;
}

export async function checkHealth(
  url: string,
  timeoutMs = 10_000
): Promise<HealthResult> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      return { ok: res.ok, status: res.status, latencyMs, error: null };
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    const isTimeout = err?.name === "AbortError";
    return {
      ok: false,
      status: null,
      latencyMs,
      error: isTimeout
        ? `timeout after ${timeoutMs}ms`
        : (err?.message ?? String(err)),
    };
  }
}

export async function recordHealthIncident(
  db: ApplianceDb,
  appName: string,
  healthUrl: string,
  result: HealthResult,
  logs: string
): Promise<number> {
  return db.insertIncident({
    app_name: appName,
    detected_at: new Date().toISOString(),
    health_url: healthUrl,
    http_status: result.status,
    error: result.error,
    logs,
    resolved_at: null,
  });
}
