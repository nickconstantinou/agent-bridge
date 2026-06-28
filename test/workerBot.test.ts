/**
 * Tests for the worker bot's command handling (Phase 0 — no job execution yet).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  handleWorkerCommand,
  handleWorkerConversationText,
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
    db.createWorkItem({ kind: "defect", source: "defect_scan", title: "A bug", created_by: "worker", repository: "agent-bridge" });
    const result = handleWorkerCommand("/issues", { workerEnabled: true, db });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("keyboard_message");
    expect(result!.text).toContain("Proposed Work Items");
    expect(result!.text).toContain("A bug");
    expect(result!.text).toContain("repo: `agent-bridge`");
    expect((result as any).reply_markup.inline_keyboard.flat().length).toBe(3); // view, approve, close buttons
  });

  it("shows issue details on /issue <id>", () => {
    const item = db.createWorkItem({ kind: "defect", source: "defect_scan", title: "A bug", created_by: "worker" });
    const result = handleWorkerCommand(`/issue ${item.id}`, { workerEnabled: true, db, chatId: 123 });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("keyboard_message");
    expect(result!.text).toContain(`**Work Item ID**: ${item.id}`);
    expect(result!.text).toContain("A bug");
    expect(db.getSetting("active_work_item:123")).toBe(String(item.id));
  });

  it("creates a defect scan job on /review", () => {
    const result = handleWorkerCommand("/review", { workerEnabled: true, db, defaultRepo: "agent-bridge" });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("message");
    expect(result!.text).toContain("Defect scan queued");
    const jobs = db.listWorkJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].task_type).toBe("defect_scan");
    expect(JSON.parse(jobs[0].input_json).repository).toBe("agent-bridge");
  });

  it("uses configured default repo for /review when no repo argument is provided", () => {
    const result = handleWorkerCommand("/review", { workerEnabled: true, db, defaultRepo: "content-crawler" });
    expect(result!.text).toContain("content-crawler");
    const jobs = db.listWorkJobs();
    expect(JSON.parse(jobs[0].input_json).repository).toBe("content-crawler");
  });

  it("idempotently returns info if defect scan is already active", () => {
    handleWorkerCommand("/review repo-a", { workerEnabled: true, db });
    const result = handleWorkerCommand("/review repo-a", { workerEnabled: true, db });
    expect(result!.text).toContain("already in progress");
    expect(db.listWorkJobs().length).toBe(1);
  });

  it("stores notify_chat_id in input_json when chatId is provided in context", () => {
    handleWorkerCommand("/review", { workerEnabled: true, db, chatId: 99999, defaultRepo: "agent-bridge" });
    const jobs = db.listWorkJobs();
    expect(jobs.length).toBe(1);
    const input = JSON.parse(jobs[0].input_json);
    expect(input.notify_chat_id).toBe(99999);
  });

  it("omits notify_chat_id when no chatId is provided", () => {
    handleWorkerCommand("/review", { workerEnabled: true, db, defaultRepo: "agent-bridge" });
    const jobs = db.listWorkJobs();
    expect(jobs.length).toBe(1);
    const input = JSON.parse(jobs[0].input_json);
    expect(input.notify_chat_id).toBeUndefined();
  });

  it("asks for a repo when /review has no repo and no default repo is configured", () => {
    const oldDefault = process.env.WORKER_DEFAULT_REPO;
    delete process.env.WORKER_DEFAULT_REPO;
    try {
      const result = handleWorkerCommand("/review", { workerEnabled: true, db });
      expect(result!.text).toContain("Which repo");
      expect(db.listWorkJobs()).toHaveLength(0);
    } finally {
      if (oldDefault === undefined) delete process.env.WORKER_DEFAULT_REPO;
      else process.env.WORKER_DEFAULT_REPO = oldDefault;
    }
  });
});

describe("worker conversation context", () => {
  let db: any;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => db.close());

  it("amends the active work item from plain follow-up text", () => {
    const item = db.createWorkItem({
      kind: "feature",
      source: "telegram",
      title: "Add approval context",
      body: "Initial scope.",
      created_by: "worker",
      repository: "agent-bridge",
    });
    db.setSetting("active_work_item:77", String(item.id));

    const result = handleWorkerConversationText("Also make replies update the pending item.", {
      workerEnabled: true,
      db,
      chatId: 77,
      userId: "42",
    });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe("keyboard_message");
    expect(result!.text).toContain(`Updated item #${item.id}`);
    const updated = db.getWorkItem(item.id)!;
    expect(updated.body).toContain("Initial scope.");
    expect(updated.body).toContain("Also make replies update the pending item.");
    expect(db.getSetting("active_work_item:77")).toBe(String(item.id));
  });

  it("blocks plain-text amendments after the active item is approved", () => {
    const item = db.createWorkItem({
      kind: "feature",
      source: "telegram",
      title: "Already approved",
      created_by: "worker",
      repository: "agent-bridge",
    });
    db.updateWorkItemStatus(item.id, "approved");
    db.setSetting("active_work_item:88", String(item.id));

    const result = handleWorkerConversationText("Change the scope after approval.", {
      workerEnabled: true,
      db,
      chatId: 88,
      userId: "42",
    });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe("message");
    expect(result!.text).toMatch(/already approved|revise|requeue/i);
    expect(db.getSetting("active_work_item:88")).toBeNull();
  });

  it("returns null when no active workflow context exists", () => {
    const result = handleWorkerConversationText("ordinary chat", {
      workerEnabled: true,
      db,
      chatId: 99,
      userId: "42",
    });
    expect(result).toBeNull();
  });
});

// ── /feature command ──────────────────────────────────────────────────────────

describe("handleWorkerCommand /feature", () => {
  let db: ReturnType<typeof import("../src/db.js").openDb>;

  beforeEach(async () => {
    const { openDb } = await import("../src/db.js");
    db = openDb(":memory:");
  });

  afterEach(() => db.close());

  it("isWorkerCommand recognises /feature", () => {
    expect(isWorkerCommand("/feature add dark mode")).toBe(true);
    expect(isWorkerCommand("/feature")).toBe(true);
  });

  it("returns a message prompting for a brief when called with no args", () => {
    const result = handleWorkerCommand("/feature", { workerEnabled: true, db });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("message");
    expect(result!.text.toLowerCase()).toMatch(/brief|describe|what feature/i);
  });

  it("creates a feature_plan record on /feature <brief>", () => {
    handleWorkerCommand("/feature add dark mode support", {
      workerEnabled: true, db, chatId: 42, userId: "user-1",
    });
    const plan = db.getActivePlanForChat("42");
    expect(plan).not.toBeNull();
    expect(plan!.brief).toBe("add dark mode support");
    expect(plan!.status).toBe("drafting");
  });

  it("stores userId from context on the feature plan", () => {
    handleWorkerCommand("/feature improve logging", {
      workerEnabled: true, db, chatId: 100, userId: "user-99",
    });
    const plan = db.getActivePlanForChat("100");
    expect(plan!.user_id).toBe("user-99");
  });

  it("returns an acknowledgement message with the brief", () => {
    const result = handleWorkerCommand("/feature refactor auth module", {
      workerEnabled: true, db, chatId: 7, userId: "u",
    });
    expect(result!.text).toContain("refactor auth module");
  });

  it("replaces an existing drafting plan when /feature is called again", () => {
    handleWorkerCommand("/feature first idea", { workerEnabled: true, db, chatId: 55, userId: "u" });
    handleWorkerCommand("/feature second idea", { workerEnabled: true, db, chatId: 55, userId: "u" });
    const plan = db.getActivePlanForChat("55");
    expect(plan!.brief).toBe("second idea");
  });

  it("includes repository in feature_plan job input when defaultRepo is set", () => {
    const result = handleWorkerCommand("/feature add caching layer", {
      workerEnabled: true, db, chatId: 42, userId: "u", defaultRepo: "agent-bridge",
    });
    const jobs = db.listWorkJobs();
    const job = jobs.find((j: any) => j.task_type === "feature_plan");
    expect(job).toBeDefined();
    const input = JSON.parse(job!.input_json);
    expect(input.repository).toBe("agent-bridge");
    expect(result!.text).toContain("Repository: `agent-bridge`");
  });

  it("omits repository from feature_plan job input when defaultRepo is not set", () => {
    const oldDefault = process.env.WORKER_DEFAULT_REPO;
    delete process.env.WORKER_DEFAULT_REPO;
    try {
      handleWorkerCommand("/feature add dark mode", {
        workerEnabled: true, db, chatId: 43, userId: "u",
      });
      const jobs = db.listWorkJobs();
      const job = jobs.find((j: any) => j.task_type === "feature_plan");
      expect(job).toBeDefined();
      const input = JSON.parse(job!.input_json);
      expect(input.repository).toBeUndefined();
    } finally {
      if (oldDefault === undefined) delete process.env.WORKER_DEFAULT_REPO;
      else process.env.WORKER_DEFAULT_REPO = oldDefault;
    }
  });

  it("falls back to WORKER_DEFAULT_REPO when defaultRepo is not passed", () => {
    const oldDefault = process.env.WORKER_DEFAULT_REPO;
    process.env.WORKER_DEFAULT_REPO = "agent-bridge";
    try {
      handleWorkerCommand("/feature add queue audit", {
        workerEnabled: true, db, chatId: 45, userId: "u",
      });
      const jobs = db.listWorkJobs();
      const job = jobs.find((j: any) => j.task_type === "feature_plan");
      expect(job).toBeDefined();
      const input = JSON.parse(job!.input_json);
      expect(input.repository).toBe("agent-bridge");
    } finally {
      if (oldDefault === undefined) delete process.env.WORKER_DEFAULT_REPO;
      else process.env.WORKER_DEFAULT_REPO = oldDefault;
    }
  });

  it("includes start_message in feature_plan job input", () => {
    handleWorkerCommand("/feature add search", {
      workerEnabled: true, db, chatId: 44, userId: "u",
    });
    const jobs = db.listWorkJobs();
    const job = jobs.find((j: any) => j.task_type === "feature_plan");
    expect(job).toBeDefined();
    const input = JSON.parse(job!.input_json);
    expect(typeof input.start_message).toBe("string");
    expect(input.start_message.toLowerCase()).toMatch(/plan|analys|draft/i);
  });
});


// ── /approvals — re-surface pending approvals with their keyboards ───────────

describe("handleWorkerCommand /approvals", () => {
  let db: ReturnType<typeof import("../src/db.js").openDb>;

  beforeEach(async () => {
    const { openDb } = await import("../src/db.js");
    db = openDb(":memory:");
  });

  afterEach(() => db.close());

  it("isWorkerCommand recognises /approvals", () => {
    expect(isWorkerCommand("/approvals")).toBe(true);
  });

  it("buildWorkerCommands includes approvals", () => {
    expect(buildWorkerCommands().some(c => c.command === "approvals")).toBe(true);
  });

  it("reports when there are no pending approvals", () => {
    const result = handleWorkerCommand("/approvals", { workerEnabled: true, db });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("message");
    expect(result!.text.toLowerCase()).toMatch(/no pending approvals/i);
  });

  it("lists a pending merge_pr approval with merge/close buttons re-attached", () => {
    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Fix leak", created_by: "worker",
      repository: "owner/repo",
    });
    db.createApproval({
      approval_type: "merge_pr",
      requested_by: "agent",
      work_item_id: item.id,
      payload: { pr_url: "https://github.com/owner/repo/pull/12", pr_number: 12, repository: "owner/repo" },
    });

    const result = handleWorkerCommand("/approvals", { workerEnabled: true, db }) as WorkerKeyboardMessageResult;
    expect(result.kind).toBe("keyboard_message");
    expect(result.text).toContain("merge_pr");
    expect(result.text).toContain("https://github.com/owner/repo/pull/12");

    const buttons = result.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
    expect(buttons).toContain(`wi:${item.id}:mrgpr`);
    expect(buttons).toContain(`wi:${item.id}:clspr`);
  });

  it("lists other pending approvals with approve/reject buttons", () => {
    const item = db.createWorkItem({
      kind: "ops", source: "telegram", title: "Restart svc", created_by: "worker",
    });
    const appr = db.createApproval({
      approval_type: "restart_service",
      requested_by: "agent",
      work_item_id: item.id,
    });

    const result = handleWorkerCommand("/approvals", { workerEnabled: true, db }) as WorkerKeyboardMessageResult;
    expect(result.kind).toBe("keyboard_message");
    const buttons = result.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
    expect(buttons).toContain(`ap:${appr.id}:yes`);
    expect(buttons).toContain(`ap:${appr.id}:no`);
  });

  it("does not list resolved approvals", () => {
    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Done already", created_by: "worker",
    });
    const appr = db.createApproval({
      approval_type: "merge_pr",
      requested_by: "agent",
      work_item_id: item.id,
    });
    db.resolveApproval(appr.id, "approved", "u1");

    const result = handleWorkerCommand("/approvals", { workerEnabled: true, db });
    expect(result!.kind).toBe("message");
    expect(result!.text.toLowerCase()).toMatch(/no pending approvals/i);
  });
});
