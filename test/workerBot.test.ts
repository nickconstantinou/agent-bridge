/**
 * Tests for the worker bot's command handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock repoRegistry before importing workerBot
vi.mock("../src/repoRegistry.js", () => ({
  buildRepoKeyboard: vi.fn().mockResolvedValue({
    inline_keyboard: [[{ text: "agent-bridge", callback_data: "rs:agent-bridge:r" }]],
  }),
  buildRepoSetKeyboard: vi.fn().mockResolvedValue({
    inline_keyboard: [
      [{ text: "agent-bridge", callback_data: "rd:agent-bridge" }],
      [{ text: "📝 Custom repo…", callback_data: "rd:__custom__" }],
    ],
  }),
  resolveGithubOwner: vi.fn().mockReturnValue("testuser"),
}));
vi.mock("../src/featureBriefCapture.js", () => ({
  setPendingFeatureBrief: vi.fn(),
  setPendingRepoBrief: vi.fn(),
  captureFeatureBrief: vi.fn().mockReturnValue(null),
  hasPendingFeatureBrief: vi.fn().mockReturnValue(false),
  clearPendingFeatureBrief: vi.fn(),
}));

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
  it("recognises Telegram-safe GitHub issue command aliases", () => {
    expect(isWorkerCommand("/github_issues")).toBe(true);
    expect(isWorkerCommand("/github_issues owner/repo")).toBe(true);
    expect(isWorkerCommand("/import_issue owner/repo#42")).toBe(true);
  });
  it("ignores regular text", () => expect(isWorkerCommand("hello")).toBe(false));
  it("ignores other slash commands", () => expect(isWorkerCommand("/reset")).toBe(false));
});

describe("handleWorkerCommand /jobs", () => {
  it("returns a message result", async () => {
    const result = await handleWorkerCommand("/jobs", { workerEnabled: false });
    expect(result!.kind).toBe("message");
  });

  it("indicates worker is not yet active when WORKER_ENABLED=false", async () => {
    const result = await handleWorkerCommand("/jobs", { workerEnabled: false });
    expect(result!.kind).toBe("message");
    if (result!.kind === "message") {
      expect(result!.text.toLowerCase()).toMatch(/no jobs|worker.*not.*active|enabled/i);
    }
  });
});

describe("handleWorkerCommand /issues", () => {
  it("returns a message result", async () => {
    const result = await handleWorkerCommand("/issues", { workerEnabled: false });
    expect(result!.kind).toBe("message");
  });

  it("indicates no issues when worker is inactive", async () => {
    const result = await handleWorkerCommand("/issues", { workerEnabled: false });
    if (result!.kind === "message") {
      expect(result!.text.toLowerCase()).toMatch(/no issues|worker.*not.*active|enabled/i);
    }
  });
});

describe("handleWorkerCommand /review", () => {
  it("returns a message result", async () => {
    const result = await handleWorkerCommand("/review", { workerEnabled: false });
    expect(result!.kind).toBe("message");
  });

  it("acknowledges the review request even when worker inactive", async () => {
    const result = await handleWorkerCommand("/review", { workerEnabled: false });
    if (result!.kind === "message") {
      expect(result!.text.toLowerCase()).toMatch(/review|worker.*not.*active|enabled/i);
    }
  });

  it("extracts repo arg from /review agent-bridge", async () => {
    const result = await handleWorkerCommand("/review agent-bridge", { workerEnabled: false });
    expect(result!.kind).toBe("message");
    if (result!.kind === "message") {
      expect(result!.text).toContain("agent-bridge");
    }
  });
});

describe("handleWorkerCommand unknown", () => {
  it("returns null for unrecognised commands", async () => {
    expect(await handleWorkerCommand("/reset", { workerEnabled: false })).toBeNull();
    expect(await handleWorkerCommand("hello", { workerEnabled: false })).toBeNull();
  });
});

// ── /chain keyboard ───────────────────────────────────────────────────────────

describe("isWorkerCommand /chain", () => {
  it("recognises /chain", () => expect(isWorkerCommand("/chain")).toBe(true));
  it("does not claim /models", () => expect(isWorkerCommand("/models")).toBe(false));
});

describe("handleWorkerCommand /chain", () => {
  it("returns a keyboard_message result", async () => {
    const result = await handleWorkerCommand("/chain", { workerEnabled: false, cliChain: ["codex", "claude", "antigravity"] });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("keyboard_message");
  });

  it("keyboard includes one button per CLI in the chain", async () => {
    const result = await handleWorkerCommand("/chain", { workerEnabled: false, cliChain: ["codex", "claude", "antigravity"] });
    expect(result!.kind).toBe("keyboard_message");
    const kb = result as WorkerKeyboardMessageResult;
    const allButtons = kb.reply_markup.inline_keyboard.flat();
    const texts = allButtons.map((b: any) => b.text);
    expect(texts.some((t: string) => t.includes("codex"))).toBe(true);
    expect(texts.some((t: string) => t.includes("claude"))).toBe(true);
    expect(texts.some((t: string) => t.includes("antigravity"))).toBe(true);
  });

  it("uses default chain when cliChain not provided", async () => {
    const result = await handleWorkerCommand("/chain", { workerEnabled: false });
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

  it("includes /chain command", () => {
    expect(buildWorkerCommands().some(c => c.command === "chain")).toBe(true);
  });

  it("does not include /models command", () => {
    expect(buildWorkerCommands().some(c => c.command === "models")).toBe(false);
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

  it("lists active and pending jobs on /jobs", async () => {
    db.createWorkJob({ task_type: "defect_scan", idempotency_key: "scan:1" });
    const result = await handleWorkerCommand("/jobs", { workerEnabled: true, db });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("keyboard_message");
    expect(result!.text).toContain("Active and Pending Jobs");
    expect(result!.text).toContain("defect_scan");
    expect((result as any).reply_markup.inline_keyboard.flat().length).toBe(1);
  });

  it("shows job details on /job <id>", async () => {
    const job = db.createWorkJob({ task_type: "defect_scan", idempotency_key: "scan:1" });
    const result = await handleWorkerCommand(`/job ${job.id}`, { workerEnabled: true, db });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("keyboard_message");
    expect(result!.text).toContain(`**Job ID**: ${job.id}`);
    expect(result!.text).toContain("defect_scan");
  });

  it("lists proposed issues on /issues", async () => {
    db.createWorkItem({ kind: "defect", source: "defect_scan", title: "A bug", created_by: "worker", repository: "agent-bridge" });
    const result = await handleWorkerCommand("/issues", { workerEnabled: true, db });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("keyboard_message");
    expect(result!.text).toContain("Proposed Work Items");
    expect(result!.text).toContain("A bug");
    expect(result!.text).toContain("repo: `agent-bridge`");
    expect((result as any).reply_markup.inline_keyboard.flat().length).toBe(3); // view, approve, close buttons
  });

  it("shows issue details on /issue <id>", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "defect_scan", title: "A bug", created_by: "worker" });
    const result = await handleWorkerCommand(`/issue ${item.id}`, { workerEnabled: true, db, chatId: 123 });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("keyboard_message");
    expect(result!.text).toContain(`**Work Item ID**: ${item.id}`);
    expect(result!.text).toContain("A bug");
    expect(db.getSetting("active_work_item:123")).toBe(String(item.id));
  });

  it("creates a defect scan job on /review", async () => {
    const result = await handleWorkerCommand("/review", { workerEnabled: true, db, defaultRepo: "agent-bridge" });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("message");
    expect(result!.text).toContain("Defect scan queued");
    const jobs = db.listWorkJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].task_type).toBe("defect_scan");
    expect(JSON.parse(jobs[0].input_json).repository).toBe("agent-bridge");
  });

  it("uses configured default repo for /review when no repo argument is provided", async () => {
    const result = await handleWorkerCommand("/review", { workerEnabled: true, db, defaultRepo: "content-crawler" });
    expect(result!.text).toContain("content-crawler");
    const jobs = db.listWorkJobs();
    expect(JSON.parse(jobs[0].input_json).repository).toBe("content-crawler");
  });

  it("idempotently returns info if defect scan is already active", async () => {
    await handleWorkerCommand("/review repo-a", { workerEnabled: true, db });
    const result = await handleWorkerCommand("/review repo-a", { workerEnabled: true, db });
    expect(result!.text).toContain("already in progress");
    expect(db.listWorkJobs().length).toBe(1);
  });

  it("stores notify chat and thread in input_json when provided in context", async () => {
    await handleWorkerCommand("/review", { workerEnabled: true, db, chatId: 99999, threadId: 77, defaultRepo: "agent-bridge" });
    const jobs = db.listWorkJobs();
    expect(jobs.length).toBe(1);
    const input = JSON.parse(jobs[0].input_json);
    expect(input.notify_chat_id).toBe(99999);
    expect(input.notify_thread_id).toBe(77);
  });

  it("omits notify_chat_id when no chatId is provided", async () => {
    await handleWorkerCommand("/review", { workerEnabled: true, db, defaultRepo: "agent-bridge" });
    const jobs = db.listWorkJobs();
    expect(jobs.length).toBe(1);
    const input = JSON.parse(jobs[0].input_json);
    expect(input.notify_chat_id).toBeUndefined();
    expect(input.notify_thread_id).toBeUndefined();
  });

  it("asks for a repo when /review has no repo and no default repo is configured", async () => {
    const oldDefault = process.env.WORKER_DEFAULT_REPO;
    delete process.env.WORKER_DEFAULT_REPO;
    try {
      const result = await handleWorkerCommand("/review", { workerEnabled: true, db });
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

  it("returns a message prompting for a brief when called with no args", async () => {
    const result = await handleWorkerCommand("/feature", { workerEnabled: true, db });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("message");
    expect(result!.text.toLowerCase()).toMatch(/brief|describe|what feature/i);
  });

  it("creates a feature_plan record on /feature <brief> when defaultRepo is set", async () => {
    await handleWorkerCommand("/feature add dark mode support", {
      workerEnabled: true, db, chatId: 42, userId: "user-1", defaultRepo: "agent-bridge",
    });
    const plan = db.getActivePlanForChat("42");
    expect(plan).not.toBeNull();
    expect(plan!.brief).toBe("add dark mode support");
    expect(plan!.status).toBe("drafting");
  });

  it("stores userId from context on the feature plan", async () => {
    await handleWorkerCommand("/feature improve logging", {
      workerEnabled: true, db, chatId: 100, userId: "user-99", defaultRepo: "agent-bridge",
    });
    const plan = db.getActivePlanForChat("100");
    expect(plan!.user_id).toBe("user-99");
  });

  it("returns an acknowledgement message with the brief when defaultRepo is set", async () => {
    const result = await handleWorkerCommand("/feature refactor auth module", {
      workerEnabled: true, db, chatId: 7, userId: "u", defaultRepo: "agent-bridge",
    });
    expect(result!.text).toContain("refactor auth module");
  });

  it("replaces an existing drafting plan when /feature is called again", async () => {
    await handleWorkerCommand("/feature first idea", { workerEnabled: true, db, chatId: 55, userId: "u", defaultRepo: "agent-bridge" });
    await handleWorkerCommand("/feature second idea", { workerEnabled: true, db, chatId: 55, userId: "u", defaultRepo: "agent-bridge" });
    const plan = db.getActivePlanForChat("55");
    expect(plan!.brief).toBe("second idea");
  });

  it("includes repository in feature_plan job input when defaultRepo is set", async () => {
    const result = await handleWorkerCommand("/feature add caching layer", {
      workerEnabled: true, db, chatId: 42, threadId: 99, userId: "u", defaultRepo: "agent-bridge",
    });
    const jobs = db.listWorkJobs();
    const job = jobs.find((j: any) => j.task_type === "feature_plan");
    expect(job).toBeDefined();
    const input = JSON.parse(job!.input_json);
    expect(input.repository).toBe("agent-bridge");
    expect(input.notify_thread_id).toBe(99);
    expect(result!.text).toContain("Repository: `agent-bridge`");
  });

  it("shows keyboard picker when /feature has no default repo configured", async () => {
    const oldDefault = process.env.WORKER_DEFAULT_REPO;
    delete process.env.WORKER_DEFAULT_REPO;
    try {
      const result = await handleWorkerCommand("/feature add dark mode", {
        workerEnabled: true, db, chatId: 43, userId: "u",
      });
      // With no defaultRepo, repo picker keyboard is shown
      expect(result!.kind).toBe("keyboard_message");
      expect(db.listWorkJobs()).toHaveLength(0);
    } finally {
      if (oldDefault === undefined) delete process.env.WORKER_DEFAULT_REPO;
      else process.env.WORKER_DEFAULT_REPO = oldDefault;
    }
  });

  it("falls back to WORKER_DEFAULT_REPO when defaultRepo is not passed", async () => {
    const oldDefault = process.env.WORKER_DEFAULT_REPO;
    process.env.WORKER_DEFAULT_REPO = "agent-bridge";
    try {
      await handleWorkerCommand("/feature add queue audit", {
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

  it("includes start_message in feature_plan job input", async () => {
    await handleWorkerCommand("/feature add search", {
      workerEnabled: true, db, chatId: 44, userId: "u", defaultRepo: "agent-bridge",
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

  it("reports when there are no pending approvals", async () => {
    const result = await handleWorkerCommand("/approvals", { workerEnabled: true, db });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("message");
    expect(result!.text.toLowerCase()).toMatch(/no pending approvals/i);
  });

  it("lists a pending merge_pr approval with merge/close buttons re-attached", async () => {
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

    const result = await handleWorkerCommand("/approvals", { workerEnabled: true, db }) as WorkerKeyboardMessageResult;
    expect(result.kind).toBe("keyboard_message");
    expect(result.text).toContain("merge_pr");
    expect(result.text).toContain("https://github.com/owner/repo/pull/12");

    const buttons = result.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
    expect(buttons).toContain(`wi:${item.id}:mrgpr`);
    expect(buttons).toContain(`wi:${item.id}:clspr`);
  });

  it("lists other pending approvals with approve/reject buttons", async () => {
    const item = db.createWorkItem({
      kind: "ops", source: "telegram", title: "Restart svc", created_by: "worker",
    });
    const appr = db.createApproval({
      approval_type: "restart_service",
      requested_by: "agent",
      work_item_id: item.id,
    });

    const result = await handleWorkerCommand("/approvals", { workerEnabled: true, db }) as WorkerKeyboardMessageResult;
    expect(result.kind).toBe("keyboard_message");
    const buttons = result.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
    expect(buttons).toContain(`ap:${appr.id}:yes`);
    expect(buttons).toContain(`ap:${appr.id}:no`);
  });

  it("does not list resolved approvals", async () => {
    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Done already", created_by: "worker",
    });
    const appr = db.createApproval({
      approval_type: "merge_pr",
      requested_by: "agent",
      work_item_id: item.id,
    });
    db.resolveApproval(appr.id, "approved", "u1");

    const result = await handleWorkerCommand("/approvals", { workerEnabled: true, db });
    expect(result!.kind).toBe("message");
    expect(result!.text.toLowerCase()).toMatch(/no pending approvals/i);
  });

  it("reconciles locally merged PR approvals before listing", async () => {
    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Already merged", created_by: "worker",
      repository: "owner/repo",
    });
    const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 21, branch_name: "agent/work-21" });
    db.updatePrState(link.id, "merged");
    const appr = db.createApproval({
      approval_type: "merge_pr",
      requested_by: "agent",
      work_item_id: item.id,
      payload: { pr_url: "https://github.com/owner/repo/pull/21", pr_number: 21, repository: "owner/repo" },
    });

    const result = await handleWorkerCommand("/approvals", { workerEnabled: true, db });

    expect(result!.kind).toBe("message");
    expect(result!.text.toLowerCase()).toMatch(/no pending approvals/i);
    const row = db.raw.prepare("SELECT status FROM approvals WHERE id = ?").get(appr.id) as any;
    expect(row.status).toBe("approved");
    expect(db.getWorkItem(item.id)!.status).toBe("resolved");
  });

  it("reconciles live GitHub closed PR approvals before listing", async () => {
    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Already closed", created_by: "worker",
      repository: "owner/repo",
    });
    const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 22, branch_name: "agent/work-22" });
    db.updatePrState(link.id, "ready_to_merge");
    const appr = db.createApproval({
      approval_type: "merge_pr",
      requested_by: "agent",
      work_item_id: item.id,
      payload: { pr_url: "https://github.com/owner/repo/pull/22", pr_number: 22, repository: "owner/repo" },
    });
    const runCommand = vi.fn().mockResolvedValue(JSON.stringify({ state: "CLOSED" }));

    const result = await handleWorkerCommand("/approvals", { workerEnabled: true, db, runCommand });

    expect(runCommand).toHaveBeenCalledWith("gh", ["pr", "view", "22", "--repo", "owner/repo", "--json", "state"]);
    expect(result!.kind).toBe("message");
    expect(result!.text.toLowerCase()).toMatch(/no pending approvals/i);
    const row = db.raw.prepare("SELECT status FROM approvals WHERE id = ?").get(appr.id) as any;
    expect(row.status).toBe("rejected");
    expect(db.getWorkItem(item.id)!.status).toBe("closed");
  });

  it("closes the linked issue when live GitHub reconciliation sees a merged PR", async () => {
    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Already merged", created_by: "worker",
      repository: "owner/repo",
    });
    db.linkGithubIssue({ work_item_id: item.id, repository: "owner/repo", issue_number: 44 });
    const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 23, branch_name: "agent/work-23" });
    db.updatePrState(link.id, "ready_to_merge");
    db.createApproval({
      approval_type: "merge_pr",
      requested_by: "agent",
      work_item_id: item.id,
      payload: { pr_url: "https://github.com/owner/repo/pull/23", pr_number: 23, repository: "owner/repo" },
    });
    const runCommand = vi.fn(async (_binary: string, args: string[]) => {
      if (args.includes("view")) return JSON.stringify({ state: "MERGED" });
      return "";
    });

    await handleWorkerCommand("/approvals", { workerEnabled: true, db, runCommand });

    expect(runCommand).toHaveBeenCalledWith("gh", [
      "issue", "close", "44",
      "--repo", "owner/repo",
      "--comment", "Closed by Agent Bridge: implemented by merged PR #23.",
    ]);
  });
});

// ── /refactor command ─────────────────────────────────────────────────────────

describe("/refactor command", () => {
  it("is recognised as a worker command", () => {
    expect(isWorkerCommand("/refactor")).toBe(true);
    expect(isWorkerCommand("/refactor agent-bridge")).toBe(true);
  });

  it("appears in buildWorkerCommands list", () => {
    const cmds = buildWorkerCommands();
    expect(cmds.some(c => c.command === "refactor")).toBe(true);
  });

  it("returns keyboard_message with repo picker when no repo provided", async () => {
    const result = await handleWorkerCommand("/refactor", {
      workerEnabled: true,
      db: { createWorkJob: vi.fn(), listWorkJobs: vi.fn().mockReturnValue([]) } as any,
      chatId: 123,
    });
    expect(result?.kind).toBe("keyboard_message");
  });
});

describe("/review no-repo keyboard", () => {
  it("returns keyboard_message when no repo and no default", async () => {
    const db = openDb(":memory:");
    try {
      const result = await handleWorkerCommand("/review", {
        workerEnabled: true,
        db,
        chatId: 123,
      });
      expect(result?.kind).toBe("keyboard_message");
    } finally {
      db.close();
    }
  });
});

describe("/feature no-repo keyboard", () => {
  it("returns keyboard_message and stores pending brief when no default repo", async () => {
    const { setPendingRepoBrief } = await import("../src/featureBriefCapture.js");
    const db = openDb(":memory:");
    try {
      const result = await handleWorkerCommand("/feature add dark mode", {
        workerEnabled: true,
        db,
        chatId: 456,
      });
      expect(result?.kind).toBe("keyboard_message");
      expect(setPendingRepoBrief).toHaveBeenCalledWith("456", "add dark mode");
    } finally {
      db.close();
    }
  });
});

describe("/repo command", () => {
  it("returns keyboard with repo list and current default", async () => {
    const { openDb } = await import("../src/db.js");
    const db = openDb(":memory:");
    try {
      db.setChatRepo("789", "owner/my-repo");
      const result = await handleWorkerCommand("/repo", {
        workerEnabled: true,
        db,
        chatId: 789,
      });
      expect(result?.kind).toBe("keyboard_message");
      expect(result?.text).toContain("owner/my-repo");
      expect(result?.text).toContain("chat override");
      const km = result as { kind: "keyboard_message"; reply_markup: { inline_keyboard: unknown[][] } };
      const flat = km.reply_markup.inline_keyboard.flat() as Array<{ callback_data: string }>;
      expect(flat.some(b => b.callback_data === "rd:__custom__")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("shows env fallback when no chat override", async () => {
    const { openDb } = await import("../src/db.js");
    const db = openDb(":memory:");
    process.env.WORKER_DEFAULT_REPO = "owner/env-repo";
    try {
      const result = await handleWorkerCommand("/repo", {
        workerEnabled: true,
        db,
        chatId: 101,
      });
      expect(result?.text).toContain("owner/env-repo");
      expect(result?.text).toContain("env");
    } finally {
      delete process.env.WORKER_DEFAULT_REPO;
      db.close();
    }
  });

  it("shows 'no default' when nothing configured", async () => {
    const { openDb } = await import("../src/db.js");
    const db = openDb(":memory:");
    delete process.env.WORKER_DEFAULT_REPO;
    try {
      const result = await handleWorkerCommand("/repo", {
        workerEnabled: true,
        db,
        chatId: 202,
      });
      expect(result?.text).toContain("No default");
    } finally {
      db.close();
    }
  });
});

describe("WORKER_DEFAULT_REPO test isolation", () => {
  it("allows a worker bot test to set an env default", () => {
    process.env.WORKER_DEFAULT_REPO = "owner/leaky-default";

    expect(process.env.WORKER_DEFAULT_REPO).toBe("owner/leaky-default");
  });

  it("keeps no-default repo picker scenarios isolated from previous env mutations", async () => {
    expect(process.env.WORKER_DEFAULT_REPO).toBeUndefined();

    const reviewDb = openDb(":memory:");
    const featureDb = openDb(":memory:");
    try {
      const refactorResult = await handleWorkerCommand("/refactor", {
        workerEnabled: true,
        db: { createWorkJob: vi.fn(), listWorkJobs: vi.fn().mockReturnValue([]) } as any,
        chatId: 123,
      });
      const reviewResult = await handleWorkerCommand("/review", {
        workerEnabled: true,
        db: reviewDb,
        chatId: 124,
      });
      const featureResult = await handleWorkerCommand("/feature add dark mode", {
        workerEnabled: true,
        db: featureDb,
        chatId: 125,
      });

      expect(refactorResult?.kind).toBe("keyboard_message");
      expect(reviewResult?.kind).toBe("keyboard_message");
      expect(featureResult?.kind).toBe("keyboard_message");
    } finally {
      reviewDb.close();
      featureDb.close();
    }
  });
});
