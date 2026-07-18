import { describe, expect, it } from "vitest";
import {
  WORKER_BLOCKED_RESULT_MARKER,
  formatWorkerBlockedResult,
  parseWorkerBlockedResult,
} from "../src/workerBlockedResult.js";

describe("worker blocked result contract", () => {
  it("returns null for normal executor output", () => {
    expect(parseWorkerBlockedResult("Slice complete. Tests passed.")).toBeNull();
  });

  it("parses and bounds a structured BLOCKED / NEEDS_ADVISOR result", () => {
    const result = parseWorkerBlockedResult(`${WORKER_BLOCKED_RESULT_MARKER} ${JSON.stringify({
      status: "BLOCKED",
      reason: "NEEDS_ADVISOR",
      hypothesis: "The parser rejects the new state",
      attempted_steps: ["Read the parser", "Ran the focused test"],
      failing_evidence: "expected accepted, received rejected",
      relevant_files: ["src/parser.ts", "test/parser.test.ts"],
      decision_needed: "Confirm whether the state should be accepted",
    })}`);

    expect(result).toMatchObject({
      status: "BLOCKED",
      reason: "NEEDS_ADVISOR",
      relevantFiles: ["src/parser.ts", "test/parser.test.ts"],
    });
    expect(formatWorkerBlockedResult(result!)).toContain("Ran the focused test");
  });

  it("redacts secret-shaped values before carrying blocked evidence", () => {
    const result = parseWorkerBlockedResult(`${WORKER_BLOCKED_RESULT_MARKER} ${JSON.stringify({
      status: "BLOCKED",
      reason: "NEEDS_ADVISOR",
      hypothesis: "token=super-secret-value",
      attempted_steps: ["api_key=also-secret"],
      failing_evidence: "password=hunter2",
      relevant_files: ["src/auth.ts"],
      decision_needed: "secret=do-not-store",
    })}`)!;

    expect(JSON.stringify(result)).not.toContain("super-secret-value");
    expect(JSON.stringify(result)).not.toContain("also-secret");
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("fails closed for malformed or wrong-status marked output", () => {
    expect(() => parseWorkerBlockedResult(`${WORKER_BLOCKED_RESULT_MARKER} nope`)).toThrow(/expected JSON/i);
    expect(() => parseWorkerBlockedResult(`${WORKER_BLOCKED_RESULT_MARKER} {"status":"DONE"}`)).toThrow(/BLOCKED \/ NEEDS_ADVISOR/i);
  });
});
