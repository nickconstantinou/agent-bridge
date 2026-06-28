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
});
