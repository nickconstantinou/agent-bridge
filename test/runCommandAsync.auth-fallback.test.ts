import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (path: string, options: any) => {
      if ((globalThis as any).__mockReadFileSync) {
        const res = (globalThis as any).__mockReadFileSync(path, options);
        if (res !== undefined) return res;
      }
      return actual.readFileSync(path, options);
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      binary: string,
      args: string[],
      opts: any,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if ((globalThis as any).__mockExecFile) {
        const res = (globalThis as any).__mockExecFile(binary, args, opts, cb);
        if (res !== undefined) return res;
      }
      return actual.execFile(binary, args, opts, cb);
    },
    execFileSync: (binary: string, args: string[], opts: any) => {
      if ((globalThis as any).__mockExecFileSync) {
        const res = (globalThis as any).__mockExecFileSync(binary, args, opts);
        if (res !== undefined) return res;
      }
      return actual.execFileSync(binary, args, opts);
    },
  };
});

describe("createRunCommand GH token fallback", () => {
  const prevTokenFile = process.env.GITHUB_TOKEN_FILE;
  const prevHome = process.env.HOME;

  beforeEach(() => {
    vi.resetModules();
    process.env.HOME = "/home/content-crawler";
    process.env.GITHUB_TOKEN_FILE = "/tmp/missing-gh-token.txt";
    (globalThis as any).__mockReadFileSync = (path: string) => {
      if (path === "/tmp/missing-gh-token.txt") {
        const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return undefined;
    };
    (globalThis as any).__mockExecFileSync = (binary: string, args: string[]) => {
      if (binary === "gh" && args.join(" ") === "auth token") return "fallback-gh-token\n";
      return undefined;
    };
    (globalThis as any).__mockExecFile = (
      binary: string,
      args: string[],
      opts: any,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (binary === "node" && args[0] === "-e") {
        cb(null, String(opts.env.GH_TOKEN || ""), "");
        return;
      }
      return undefined;
    };
  });

  afterEach(() => {
    if (prevTokenFile === undefined) delete process.env.GITHUB_TOKEN_FILE;
    else process.env.GITHUB_TOKEN_FILE = prevTokenFile;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    delete (globalThis as any).__mockReadFileSync;
    delete (globalThis as any).__mockExecFileSync;
    delete (globalThis as any).__mockExecFile;
  });

  it("falls back to gh auth token when the token file is missing", async () => {
    const { createRunCommand } = await import("../src/runCommandAsync.js");
    const run = createRunCommand({ loadGhToken: true });
    const out = await run("node", ["-e", "console.log(process.env.GH_TOKEN)"]);
    expect(out).toBe("fallback-gh-token");
  });
});
