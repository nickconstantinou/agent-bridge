import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSoulContext, renderSoulContract } from "../src/soul.js";

const tempDirs: string[] = [];

function tempSoulFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-soul-"));
  tempDirs.push(dir);
  const path = join(dir, "SOUL.md");
  writeFileSync(path, content, "utf8");
  return path;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("SOUL.md runtime context", () => {
  it("returns null when mode is off or the file is missing", () => {
    expect(loadSoulContext({ mode: "off", path: "/does/not/exist" })).toBeNull();
    expect(loadSoulContext({ mode: "summary", path: "/does/not/exist" })).toBeNull();
  });

  it("renders the 9 SOUL.md sections in stable order for summary mode", () => {
    const path = tempSoulFile([
      "# SOUL",
      "## Communication Style",
      "Warm and concise.",
      "## Identity",
      "Chas, a calm teammate.",
      "## Values",
      "Clarity before cleverness.",
      "## Expertise",
      "TypeScript and Telegram bots.",
      "## Boundaries",
      "Never bypass safeguards.",
      "## Workflow",
      "Discover, test, verify.",
      "## Tool Usage",
      "Use tools deliberately.",
      "## Memory Policy",
      "Persist durable decisions only.",
      "## Example Interactions",
      "Good: concise status update.",
    ].join("\n"));

    const context = loadSoulContext({ mode: "summary", path });
    expect(context).toContain("Identity");
    expect(context).toContain("Values");
    expect(context).toContain("Communication Style");
    expect(context!.indexOf("Identity")).toBeLessThan(context!.indexOf("Values"));
    expect(context!.indexOf("Values")).toBeLessThan(context!.indexOf("Communication Style"));
    expect(context).toContain("Higher-priority bridge/system/developer instructions always win.");
  });

  it("keeps subsection content inside canonical SOUL.md sections", () => {
    const path = tempSoulFile([
      "# SOUL",
      "## Identity",
      "Agent Bridge Operator.",
      "## Example Interactions",
      "### Good success update",
      "Done. Tests passed.",
    ].join("\n"));

    const context = loadSoulContext({ mode: "summary", path });
    expect(context).toContain("## Example Interactions");
    expect(context).toContain("### Good success update");
    expect(context).toContain("Done. Tests passed.");
  });

  it("caps oversized SOUL.md content", () => {
    const path = tempSoulFile(`# SOUL\n\n## Identity\n${"x".repeat(20_000)}`);
    const context = loadSoulContext({ mode: "full", path, maxChars: 1024 });
    expect(context).not.toBeNull();
    expect(context!.length).toBeLessThanOrEqual(1200);
    expect(context).toContain("[truncated]");
  });

  it("preserves all 9 section headings in summary mode even for long SOUL.md files", () => {
    const path = tempSoulFile([
      "# SOUL",
      "## Identity",
      `Agent Bridge Operator. ${"identity ".repeat(120)}`,
      "## Values",
      `Reliability before cleverness. ${"values ".repeat(120)}`,
      "## Communication Style",
      `Direct answer first. ${"style ".repeat(120)}`,
      "## Expertise",
      `Telegram CLI bridge operations. ${"expertise ".repeat(120)}`,
      "## Boundaries",
      `Never bypass safeguards. ${"boundaries ".repeat(120)}`,
      "## Workflow",
      `Red-green TDD. ${"workflow ".repeat(120)}`,
      "## Tool Usage",
      `Use tools deliberately. ${"tools ".repeat(120)}`,
      "## Memory Policy",
      `Persist durable facts only. ${"memory ".repeat(120)}`,
      "## Example Interactions",
      `Good: concise status update. ${"example ".repeat(120)}`,
    ].join("\n"));

    const context = loadSoulContext({ mode: "summary", path });
    expect(context).toContain("## Identity");
    expect(context).toContain("## Values");
    expect(context).toContain("## Communication Style");
    expect(context).toContain("## Expertise");
    expect(context).toContain("## Boundaries");
    expect(context).toContain("## Workflow");
    expect(context).toContain("## Tool Usage");
    expect(context).toContain("## Memory Policy");
    expect(context).toContain("## Example Interactions");
    expect(context!.length).toBeLessThanOrEqual(4_000);
  });

  it("wraps loaded content in a Soul contract block", () => {
    const rendered = renderSoulContract("Identity: Chas");
    expect(rendered).toContain("Soul contract:");
    expect(rendered).toContain("Identity: Chas");
  });
});
