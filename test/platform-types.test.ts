import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "vitest";

describe("MessagingPlatform type safety", () => {
  it("rejects invalid platform payloads and exposes typed responses", () => {
    const repoRoot = process.cwd();
    const tsc = join(repoRoot, "node_modules", ".bin", "tsc");
    const fixture = join(repoRoot, "test", "type-fixtures", "messaging-platform-contract.ts");

    try {
      execFileSync(
        tsc,
        [
          "--noEmit",
          "--pretty",
          "false",
          "--strict",
          "--target",
          "ES2022",
          "--module",
          "ESNext",
          "--moduleResolution",
          "Bundler",
          "--lib",
          "ES2022",
          "--types",
          "node",
          "--skipLibCheck",
          fixture,
        ],
        { cwd: repoRoot, encoding: "utf8", stdio: "pipe" },
      );
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      throw new Error(
        [
          "Expected MessagingPlatform type contract fixture to compile.",
          err.stdout?.trim(),
          err.stderr?.trim(),
        ].filter(Boolean).join("\n"),
      );
    }
  });
});
