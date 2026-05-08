export function createStreamingLineParser({ onRecord }) {
  let buffer = "";

  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        onRecord(trimmed);
      }
    },
    flush() {
      const trimmed = buffer.trim();
      if (trimmed) onRecord(trimmed);
      buffer = "";
    },
  };
}
