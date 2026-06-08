/**
 * Tests for the worker bot's command handling (Phase 0 — no job execution yet).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  handleWorkerCommand,
  isWorkerCommand,
  buildWorkerCommands,
  type WorkerCommandResult,
  type WorkerKeyboardMessageResult,
} from "../src/workerBot.js";

describe("isWorkerCommand", () => {
  it("recognises /jobs", () => expect(isWorkerCommand("/jobs")).toBe(true));
  it("recognises /issues", () => expect(isWorkerCommand("/issues")).toBe(true));
  it("recognises /review", () => expect(isWorkerCommand("/review")).toBe(true));
  it("recognises /review with repo arg", () => expect(isWorkerCommand("/review agent-bridge")).toBe(true));
  it("ignores regular text", () => expect(isWorkerCommand("hello")).toBe(false));
  it("ignores other slash commands", () => expect(isWorkerCommand("/reset")).toBe(false));
});

describe("handleWorkerCommand /jobs", () => {
  it("returns a message result", () => {
    const result = handleWorkerCommand("/jobs", { workerEnabled: false });
    expect(result.kind).toBe("message");
  });

  it("indicates worker is not yet active when WORKER_ENABLED=false", () => {
    const result = handleWorkerCommand("/jobs", { workerEnabled: false });
    expect(result.kind).toBe("message");
    if (result.kind === "message") {
      expect(result.text.toLowerCase()).toMatch(/no jobs|worker.*not.*active|enabled/i);
    }
  });
});

describe("handleWorkerCommand /issues", () => {
  it("returns a message result", () => {
    const result = handleWorkerCommand("/issues", { workerEnabled: false });
    expect(result.kind).toBe("message");
  });

  it("indicates no issues when worker is inactive", () => {
    const result = handleWorkerCommand("/issues", { workerEnabled: false });
    if (result.kind === "message") {
      expect(result.text.toLowerCase()).toMatch(/no issues|worker.*not.*active|enabled/i);
    }
  });
});

describe("handleWorkerCommand /review", () => {
  it("returns a message result", () => {
    const result = handleWorkerCommand("/review", { workerEnabled: false });
    expect(result.kind).toBe("message");
  });

  it("acknowledges the review request even when worker inactive", () => {
    const result = handleWorkerCommand("/review", { workerEnabled: false });
    if (result.kind === "message") {
      expect(result.text.toLowerCase()).toMatch(/review|worker.*not.*active|enabled/i);
    }
  });

  it("extracts repo arg from /review agent-bridge", () => {
    const result = handleWorkerCommand("/review agent-bridge", { workerEnabled: false });
    expect(result.kind).toBe("message");
    if (result.kind === "message") {
      expect(result.text).toContain("agent-bridge");
    }
  });
});

describe("handleWorkerCommand unknown", () => {
  it("returns null for unrecognised commands", () => {
    expect(handleWorkerCommand("/reset", { workerEnabled: false })).toBeNull();
    expect(handleWorkerCommand("hello", { workerEnabled: false })).toBeNull();
  });
});

// ── /models keyboard ──────────────────────────────────────────────────────────

describe("isWorkerCommand /models", () => {
  it("recognises /models", () => expect(isWorkerCommand("/models")).toBe(true));
});

describe("handleWorkerCommand /models", () => {
  it("returns a keyboard_message result", () => {
    const result = handleWorkerCommand("/models", { workerEnabled: false, cliChain: ["codex", "claude", "antigravity"] });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("keyboard_message");
  });

  it("keyboard includes one button per CLI in the chain", () => {
    const result = handleWorkerCommand("/models", { workerEnabled: false, cliChain: ["codex", "claude", "antigravity"] });
    expect(result!.kind).toBe("keyboard_message");
    const kb = result as WorkerKeyboardMessageResult;
    const allButtons = kb.reply_markup.inline_keyboard.flat();
    const texts = allButtons.map((b: any) => b.text);
    expect(texts.some((t: string) => t.includes("codex"))).toBe(true);
    expect(texts.some((t: string) => t.includes("claude"))).toBe(true);
    expect(texts.some((t: string) => t.includes("antigravity"))).toBe(true);
  });

  it("uses default chain when cliChain not provided", () => {
    const result = handleWorkerCommand("/models", { workerEnabled: false });
    expect(result!.kind).toBe("keyboard_message");
  });
});

// ── buildWorkerCommands ───────────────────────────────────────────────────────

describe("buildWorkerCommands", () => {
  it("includes /jobs command", () => {
    expect(buildWorkerCommands().some(c => c.command === "jobs")).toBe(true);
  });

  it("includes /issues command", () => {
    expect(buildWorkerCommands().some(c => c.command === "issues")).toBe(true);
  });

  it("includes /review command", () => {
    expect(buildWorkerCommands().some(c => c.command === "review")).toBe(true);
  });

  it("all entries have non-empty descriptions", () => {
    for (const cmd of buildWorkerCommands()) {
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });

  it("includes /models command", () => {
    expect(buildWorkerCommands().some(c => c.command === "models")).toBe(true);
  });
});

// ── Slice 4: Work Item Renderers and Commands with DB ────────────────────────

import { openDb } from "../src/db.js";

describe("worker commands with DB (Slice 4)", () => {
  let db: any;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("lists active and pending jobs on /jobs", () => {
    db.createWorkJob({ task_type: "defect_scan", idempotency_key: "scan:1" });
    const result = handleWorkerCommand("/jobs", { workerEnabled: true, db });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("keyboard_message");
    expect(result!.text).toContain("Active and Pending Jobs");
    expect(result!.text).toContain("defect_scan");
    expect((result as any).reply_markup.inline_keyboard.flat().length).toBe(1);
  });

  it("shows job details on /job <id>", () => {
    const job = db.createWorkJob({ task_type: "defect_scan", idempotency_key: "scan:1" });
    const result = handleWorkerCommand(`/job ${job.id}`, { workerEnabled: true, db });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("keyboard_message");
    expect(result!.text).toContain(`**Job ID**: ${job.id}`);
    expect(result!.text).toContain("defect_scan");
  });

  it("lists proposed issues on /issues", () => {
    db.createWorkItem({ kind: "defect", source: "defect_scan", title: "A bug", created_by: "worker" });
    const result = handleWorkerCommand("/issues", { workerEnabled: true, db });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("keyboard_message");
    expect(result!.text).toContain("Proposed Work Items");
    expect(result!.text).toContain("A bug");
    expect((result as any).reply_markup.inline_keyboard.flat().length).toBe(3); // view, approve, close buttons
  });

  it("shows issue details on /issue <id>", () => {
    const item = db.createWorkItem({ kind: "defect", source: "defect_scan", title: "A bug", created_by: "worker" });
    const result = handleWorkerCommand(`/issue ${item.id}`, { workerEnabled: true, db });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("keyboard_message");
    expect(result!.text).toContain(`**Work Item ID**: ${item.id}`);
    expect(result!.text).toContain("A bug");
  });

  it("creates a defect scan job on /review", () => {
    const result = handleWorkerCommand("/review", { workerEnabled: true, db });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("message");
    expect(result!.text).toContain("Defect scan queued");
    const jobs = db.listWorkJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].task_type).toBe("defect_scan");
  });

  it("idempotently returns info if defect scan is already active", () => {
    handleWorkerCommand("/review repo-a", { workerEnabled: true, db });
    const result = handleWorkerCommand("/review repo-a", { workerEnabled: true, db });
    expect(result!.text).toContain("already in progress");
    expect(db.listWorkJobs().length).toBe(1);
  });

  it("stores notify_chat_id in input_json when chatId is provided in context", () => {
    handleWorkerCommand("/review", { workerEnabled: true, db, chatId: 99999 });
    const jobs = db.listWorkJobs();
    expect(jobs.length).toBe(1);
    const input = JSON.parse(jobs[0].input_json);
    expect(input.notify_chat_id).toBe(99999);
  });

  it("omits notify_chat_id when no chatId is provided", () => {
    handleWorkerCommand("/review", { workerEnabled: true, db });
    const jobs = db.listWorkJobs();
    expect(jobs.length).toBe(1);
    const input = JSON.parse(jobs[0].input_json);
    expect(input.notify_chat_id).toBeUndefined();
  });
});

