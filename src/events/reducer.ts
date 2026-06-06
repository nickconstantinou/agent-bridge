import type { BridgeEvent } from "./types.js";

export interface RunView {
  runId: string;
  status: "idle" | "running" | "done" | "failed" | "cancelled";
  text: string;
  error?: string;
  sessionId?: string | null;
  updatedAt: string;
}

const INITIAL: RunView = {
  runId: "",
  status: "idle",
  text: "",
  sessionId: null,
  updatedAt: new Date().toISOString(),
};

export function reduce(events: BridgeEvent[]): RunView {
  let view: RunView = { ...INITIAL };

  for (const event of events) {
    const updatedAt = event.timestamp;

    switch (event.type) {
      case "run.started":
        view = { ...view, runId: event.runId, status: "running", text: "", error: undefined, updatedAt };
        break;

      case "text.delta":
        view = { ...view, text: view.text + event.text, updatedAt };
        break;

      case "run.completed":
        view = { ...view, status: "done", text: event.text, sessionId: event.sessionId, updatedAt };
        break;

      case "run.failed":
        view = { ...view, status: "failed", error: event.error, updatedAt };
        break;

      case "run.cancelled":
        view = { ...view, status: "cancelled", updatedAt };
        break;
    }
  }

  return view;
}
