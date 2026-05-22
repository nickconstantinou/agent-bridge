/**
 * PURPOSE: Classify Telegram polling errors and produce a logging+backoff plan.
 * INPUTS: Caught polling errors and a stateful PollErrorState carried by the caller.
 * OUTPUTS: PollErrorPlan describing how to log and how long to back off.
 * NEIGHBORS: src/index.ts (polling loop), src/telegram.ts (error shape).
 * LOGIC: HTTP 409 (duplicate getUpdates) is treated as an operator condition —
 *        warn once, suppress duplicates, exponential backoff to 60s. Other
 *        errors keep the previous behavior (full stack, caller-supplied sleep).
 */

const BACKOFF_409_MS = [5_000, 10_000, 30_000, 60_000] as const;

export interface PollErrorState {
  consecutive409: number;
  in409Mode: boolean;
}

export type PollErrorLogKind = "warn-once" | "warn-suppress" | "error-stack";

export interface PollErrorPlan {
  logKind: PollErrorLogKind;
  message: string;
  sleepMs: number;
}

export function createPollErrorState(): PollErrorState {
  return { consecutive409: 0, in409Mode: false };
}

function is409(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as any).status === 409;
}

export function planPollError(
  error: unknown,
  state: PollErrorState,
  defaultSleepMs: number,
): PollErrorPlan {
  if (is409(error)) {
    const wasIn409 = state.in409Mode;
    state.in409Mode = true;
    state.consecutive409 += 1;
    const idx = Math.min(state.consecutive409 - 1, BACKOFF_409_MS.length - 1);
    return {
      logKind: wasIn409 ? "warn-suppress" : "warn-once",
      message: "polling conflict: another instance is using this bot token; backing off",
      sleepMs: BACKOFF_409_MS[idx],
    };
  }

  state.in409Mode = false;
  state.consecutive409 = 0;
  return {
    logKind: "error-stack",
    message: "polling failed",
    sleepMs: defaultSleepMs,
  };
}

export function notePollSuccess(state: PollErrorState): boolean {
  if (!state.in409Mode && state.consecutive409 === 0) return false;
  state.in409Mode = false;
  state.consecutive409 = 0;
  return true;
}
