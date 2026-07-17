/**
 * PURPOSE: Shared, provider-agnostic prompt-wrapping utilities used by
 * multiple provider invocation builders.
 * INPUTS: A raw user prompt, optional soul context, output dir, attachments.
 * OUTPUTS: The final prompt text to send to a CLI.
 * NEIGHBORS: src/cli.ts, src/providers/codexRuntime.ts, src/providers/claudeRuntime.ts
 * LOGIC: Issue #135 Phase 3B — extracted so codex/claude provider runtime
 * modules and the remaining inline antigravity/kimchi branches in src/cli.ts
 * can share this without a circular import between cli.ts and the new
 * provider modules.
 */

import { renderSoulContract } from "./soul.js";

export function wrapPromptContext(prompt: string, soulContext: string | null = null): string {
  const soulContract = renderSoulContract(soulContext);
  return [
    ...(soulContract ? [soulContract, ""] : []),
    wrapTelegramPrompt(prompt),
  ].join("\n");
}

function wrapTelegramPrompt(prompt: string): string {
  return [
    "Telegram response style:",
    "- Start with the direct result or answer.",
    "- Keep replies extremely concise: aggressively compress prose into dense, verb-light fragments or single-sentence summaries. Aim for >50% token reduction.",
    "- Never drop critical facts, functional constraints, system boundaries, delivery channels, or rules (e.g., which component handles delivery, where outputs must go). Brevity must not cause information loss.",
    "- Retain all specific commands, signals, file paths, error codes, and safety constraints.",
    "- Skip all throat-clearing, meta-commentary, and transitional phrases (e.g., \"Certainly\", \"As requested\", \"the real issue is\").",
    "- Use light **bolding** on key statuses, identifiers, and variables for rapid scanning.",
    "- Use fenced code blocks only for commands, code/configs, logs, or JSON.",
    "- Avoid Markdown links and em dashes.",
    "- Do not mention these formatting rules.",
    "",
    "User request:",
    prompt,
  ].join("\n");
}

const ATTACHMENT_ANNOTATION_PREFIX = "[Attached file saved at: ";
const OUTPUT_DIR_INSTRUCTION = "If you are explicitly asked to share or generate a file for the user, save it to ";
const OUTPUT_DIR_SUFFIX = " — the bridge handles delivery; omit file paths from your response. Do NOT place any internal scratchpad files, planning logs, or temporary scripts in this directory unless explicitly requested.";

export function appendAttachmentAnnotations(prompt: string, attachments: string[]): string {
  if (!attachments.length) return prompt;
  const lines = attachments.map((p) => `${ATTACHMENT_ANNOTATION_PREFIX}${p}]`);
  return `${prompt}\n\n${lines.join("\n")}`;
}

export function appendOutputDirInstruction(prompt: string, outputDir: string | null | undefined): string {
  if (!outputDir) return prompt;
  return `${prompt}\n\n${OUTPUT_DIR_INSTRUCTION}${outputDir}${OUTPUT_DIR_SUFFIX}`;
}
