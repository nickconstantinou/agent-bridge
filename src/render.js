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

export function toTelegramEntitiesText(text) {
  const value = String(text || "");
  const entities = [];
  const output = [];

  let i = 0;
  while (i < value.length) {
    if (value.startsWith("**", i)) {
      const end = value.indexOf("**", i + 2);
      if (end > i + 2) {
        const start = output.join("").length;
        const inner = value.slice(i + 2, end);
        output.push(inner);
        entities.push({ type: "bold", offset: start, length: inner.length });
        i = end + 2;
        continue;
      }
    }

    if (value[i] === "`") {
      if (value.startsWith("```", i)) {
        const end = value.indexOf("```", i + 3);
        if (end > i + 3) {
          const start = output.join("").length;
          const inner = value.slice(i + 3, end).replace(/^\n/, "");
          output.push(inner);
          entities.push({ type: "pre", offset: start, length: inner.length });
          i = end + 3;
          continue;
        }
      } else {
        const end = value.indexOf("`", i + 1);
        if (end > i + 1) {
          const start = output.join("").length;
          const inner = value.slice(i + 1, end);
          output.push(inner);
          entities.push({ type: "code", offset: start, length: inner.length });
          i = end + 1;
          continue;
        }
      }
    }

    output.push(value[i]);
    i += 1;
  }

  return { text: output.join(""), entities };
}
