/**
 * PURPOSE: Compact Telegram callback data parser and builder for autonomous agent bridge jobs/work items.
 * Grammar:
 *   wi:<id>:view
 *   wi:<id>:appv
 *   wi:<id>:clse
 *   job:<id>:cncl
 *   ap:<id>:yes
 *   ap:<id>:no
 */

export type WorkCallbackAction =
  | { type: "wi_view"; id: number }
  | { type: "wi_appv"; id: number }
  | { type: "wi_clse"; id: number }
  | { type: "job_cncl"; id: number }
  | { type: "ap_yes"; id: number }
  | { type: "ap_no"; id: number };

export function parseWorkCallback(data: string): WorkCallbackAction | null {
  if (data.length > 64) return null;
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const [prefix, rawId, action] = parts;
  const id = Number(rawId);
  if (!rawId || !Number.isInteger(id) || id <= 0 || String(id) !== rawId) return null;

  if (prefix === "wi") {
    if (action === "view") return { type: "wi_view", id };
    if (action === "appv") return { type: "wi_appv", id };
    if (action === "clse") return { type: "wi_clse", id };
  }
  if (prefix === "job") {
    if (action === "cncl") return { type: "job_cncl", id };
  }
  if (prefix === "ap") {
    if (action === "yes") return { type: "ap_yes", id };
    if (action === "no") return { type: "ap_no", id };
  }
  return null;
}

export function buildWorkCallback(action: WorkCallbackAction): string {
  let prefix = "";
  let actionStr = "";
  if (action.type.startsWith("wi_")) {
    prefix = "wi";
    actionStr = action.type.slice(3);
  } else if (action.type.startsWith("job_")) {
    prefix = "job";
    actionStr = action.type.slice(4);
  } else if (action.type.startsWith("ap_")) {
    prefix = "ap";
    actionStr = action.type.slice(3);
  }
  const payload = `${prefix}:${action.id}:${actionStr}`;
  if (payload.length > 64) {
    throw new Error(`Callback payload exceeds 64 bytes limit: ${payload}`);
  }
  return payload;
}
