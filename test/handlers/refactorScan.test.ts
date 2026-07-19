import { describe, it, expect, vi } from "vitest";
import { createRefactorScanHandler } from "../../src/handlers/refactorScan.js";

describe("createRefactorScanHandler", () => {
  it("returns a function (handler)", () => {
    const handler = createRefactorScanHandler({ runCli: vi.fn() });
    expect(typeof handler).toBe("function");
  });

  it("throws when input.repository is missing", async () => {
    const handler = createRefactorScanHandler({ runCli: vi.fn() });
    await expect(handler({} as any, {} as any)).rejects.toThrow("input.repository is required");
  });

  it("calls runCli with repository name in prompt", async () => {
    const runCli = vi.fn().mockResolvedValue(`[]`);
    const mockDb = {
      createWorkItem: vi.fn().mockReturnValue({ id: 1 }),
      raw: { prepare: vi.fn().mockReturnValue({ run: vi.fn() }) },
    };
    const handler = createRefactorScanHandler({ runCli });
    await handler({ repository: "test-repo" }, { db: mockDb } as any);
    expect(runCli).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([expect.stringContaining("test-repo")]),
      expect.any(String),
    );
  });

  it("creates refactor work items from JSON line findings", async () => {
    const runCli = vi.fn().mockResolvedValue(
      `{"title":"Extract worker router","rationale":"workerBot is doing too much","files":["src/workerBot.ts"]}`,
    );
    const { openDb } = await import("../../src/db.js");
    const db = openDb(":memory:");
    try {
      const handler = createRefactorScanHandler({
        runCli,
        resolveRepoPath: () => process.cwd(),
      });
      await handler({ repository: "owner/repo" }, { db, workerId: "w", phase: "initial", phaseData: {} });
      const items = db.listWorkItems();
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe("refactor");
      expect(items[0].source).toBe("refactor_scan");
      expect(items[0].repository).toBe("owner/repo");
      expect(items[0].priority).toBe("normal");
    } finally {
      db.close();
    }
  });
});
