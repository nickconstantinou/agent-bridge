/**
 * Tests for the worker bot's command handling (Phase 0 — no job execution yet).
 */

import { describe, it, expect } from "vitest";
import {
  handleWorkerCommand,
  isWorkerCommand,
  type WorkerCommandResult,
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
