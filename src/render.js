export function splitTelegramText(text, limit = 3500) {
  const value = String(text || "");
  if (value.length <= limit) return [value];

  const chunks = [];
  let remaining = value;

  while (remaining.length > limit) {
    // Try to split at a natural boundary
    let splitAt = -1;

    // 1. Try double newline (paragraph)
    splitAt = remaining.lastIndexOf("\n\n", limit);

    // 2. Try single newline
    if (splitAt < Math.floor(limit * 0.7)) {
      splitAt = remaining.lastIndexOf("\n", limit);
    }

    // 3. Try space
    if (splitAt < Math.floor(limit * 0.7)) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }

    // 4. Force split if no good boundary found
    if (splitAt <= 0) {
      splitAt = limit;
    }

    let chunk = remaining.slice(0, splitAt).trim();
    
    // Handle code blocks: if we have an odd number of triple backticks, 
    // we are likely splitting inside a code block.
    const backticks = (chunk.match(/```/g) || []).length;
    if (backticks % 2 !== 0) {
      // Find the last triple backtick before the split
      const lastBacktick = chunk.lastIndexOf("```");
      if (lastBacktick > Math.floor(limit * 0.5)) {
        // Split right before the code block if it's not too far back
        splitAt = lastBacktick;
        chunk = remaining.slice(0, splitAt).trim();
      } else {
        // Otherwise, close the code block in this chunk and reopen in the next
        chunk += "\n```";
        remaining = "```\n" + remaining.slice(splitAt).trimStart();
        chunks.push(chunk);
        continue;
      }
    }

    chunks.push(chunk);
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

export function renderTelegramPlainText(text) {
  return String(text || "").trim();
}

export function escapeTelegramMarkdownV2(text) {
  return String(text || "").replace(/([_\*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

export function escapeTelegramHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
