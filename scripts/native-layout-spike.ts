/**
 * Native Telegram layout spike.
 *
 * Isolated prototype for table flattening, HTML payload generation, and
 * in-memory Markdown document fallback. This file is intentionally separate
 * from production message routing.
 */

export type NativeLayoutRoute =
  | { kind: "document"; reason: "length" | "code_blocks"; codeBlocks: number; length: number }
  | { kind: "message"; reason: "default"; codeBlocks: number; length: number };

export type NativeLayoutPayload = {
  method: "sendMessage" | "sendDocument" | "sendPhoto";
  body: FormData | Record<string, unknown>;
};

export const DOCUMENT_LENGTH_THRESHOLD = 3_500;
export const DOCUMENT_CODE_BLOCK_THRESHOLD = 3;

export function countCodeBlocks(markdown: string): number {
  return markdown.match(/```/g)?.length ? Math.floor((markdown.match(/```/g) ?? []).length / 2) : 0;
}

export function routeNativeLayout(markdown: string): NativeLayoutRoute {
  const codeBlocks = countCodeBlocks(markdown);
  const length = markdown.length;
  if (length > DOCUMENT_LENGTH_THRESHOLD) return { kind: "document", reason: "length", codeBlocks, length };
  if (codeBlocks > DOCUMENT_CODE_BLOCK_THRESHOLD) return { kind: "document", reason: "code_blocks", codeBlocks, length };
  return { kind: "message", reason: "default", codeBlocks, length };
}

export function buildNativeLayoutPayload(markdown: string, chatId: string | number): NativeLayoutPayload {
  const route = routeNativeLayout(markdown);
  if (route.kind === "document") {
    const body = new FormData();
    body.set("chat_id", String(chatId));
    body.set("caption", `Full response attached as response.md (${route.reason})`);
    body.set("document", new File([Buffer.from(markdown, "utf8")], "response.md", { type: "text/markdown" }));
    return { method: "sendDocument", body };
  }

  return {
    method: "sendMessage",
    body: {
      chat_id: String(chatId),
      text: markdown,
    },
  };
}

export function buildNativePhotoPayload(
  imageBytes: Buffer,
  chatId: string | number,
  filename = "response.png",
  caption = "Rendered response preview",
): NativeLayoutPayload {
  const body = new FormData();
  body.set("chat_id", String(chatId));
  body.set("caption", caption);
  body.set("photo", new File([imageBytes], filename, { type: "image/png" }));
  return { method: "sendPhoto", body };
}

export const spikeInputs = {
  logDump: Array.from({ length: 140 }, (_, i) => `[${i.toString().padStart(3, "0")}] worker lane event: ${"x".repeat(26)}`).join("\n"),
  table4Col: [
    "| Service | Status | Latency | Owner |",
    "|---|---|---:|---|",
    "| web-api | healthy | 12ms | platform |",
    "| queue | amber | 240ms | ops |",
    "| discord | healthy | 40ms | bridge |",
  ].join("\n"),
  nestedList: [
    "- Root",
    "  - Child",
    "    - Grandchild",
    "      - Deep item with <unsafe> chars & quotes",
  ].join("\n"),
};

async function main(): Promise<void> {
  const chatId = process.env.TELEGRAM_LAYOUT_SPIKE_CHAT_ID ?? "0";
  for (const [name, input] of Object.entries(spikeInputs)) {
    const route = routeNativeLayout(input);
    const payload = buildNativeLayoutPayload(input, chatId);
    console.log(JSON.stringify({
      name,
      route,
      method: payload.method,
      bodyType: payload.body instanceof FormData ? "FormData" : "json",
    }, null, 2));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
