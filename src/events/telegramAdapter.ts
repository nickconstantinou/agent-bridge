import { splitTelegramText, toTelegramEntitiesText } from "../render.js";
import type { RunView } from "./reducer.js";

/**
 * Converts a RunView into the Telegram-ready text string for the final message.
 * Applies entity encoding (code blocks → pre entities) but does NOT split long
 * text — use runViewToTelegramChunks for multi-chunk delivery.
 */
export function runViewToTelegramText(view: RunView): string {
  const raw = resolveRawText(view);
  return toTelegramEntitiesText(raw).text;
}

/**
 * Converts a RunView into one or more Telegram-safe text chunks.
 * Splits on paragraph/word boundaries using the same logic as sendTelegramMessage.
 */
export function runViewToTelegramChunks(view: RunView): string[] {
  const raw = resolveRawText(view);
  return splitTelegramText(raw);
}

function resolveRawText(view: RunView): string {
  if (view.status === "failed") {
    return `❌ ${view.error ?? "An error occurred"}`;
  }
  if (view.status === "cancelled") {
    return "⏹ Run cancelled.";
  }
  return view.text;
}
