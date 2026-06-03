export function parseHealthEnabled(env: Record<string, string | undefined>): boolean {
  return env.HEALTH_MONITOR_ENABLED === "true";
}

export function parseCadenceSeconds(env: Record<string, string | undefined>): number {
  const n = Number(env.HEALTH_MONITOR_CADENCE_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 3600;
}
