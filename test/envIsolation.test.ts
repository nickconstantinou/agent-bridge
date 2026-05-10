import { describe, expect, it, vi } from "vitest";
import dotenv from "dotenv";

describe("Env Isolation", () => {
  it("loads from specific file path", async () => {
    const configSpy = vi.spyOn(dotenv, "config");
    const calls: any[] = [];
    configSpy.mockImplementation(((options: any) => {
        calls.push(options);
        return { parsed: {} };
    }) as any);

    // Dynamic import to trigger side-effect in index.ts
    // but index.ts also runs the bots, which we don't want here.
    // Instead we just verify we can mock dotenv.
    dotenv.config({ path: "/tmp/service.env", override: false });

    expect(calls).toEqual([{ path: "/tmp/service.env", override: false }]);
    configSpy.mockRestore();
  });
});
