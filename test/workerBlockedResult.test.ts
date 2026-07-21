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

  it("redacts conversational and repository credential forms before carrying blocked evidence", () => {
    const jwt = "eyJabcdefghijk.eyJabcdefghijkl.mnopqrstuvwxyz";
    const result = parseWorkerBlockedResult(`${WORKER_BLOCKED_RESULT_MARKER} ${JSON.stringify({
      status: "BLOCKED",
      reason: "NEEDS_ADVISOR",
      hypothesis: 'client_secret: "client-secret-value"',
      attempted_steps: ["Authorization: Bearer bearer-secret-value", "api_key=also-secret"],
      failing_evidence: `DATABASE_URL=postgres://user:pass@db.example/app session=${jwt}`,
      relevant_files: ["src/auth.ts"],
      decision_needed: "AWS_SECRET_ACCESS_KEY=aws-secret-value",
    })}`)!;
    const carried = JSON.stringify(result);

    for (const secret of ["client-secret-value", "bearer-secret-value", "also-secret", "user:pass", jwt, "aws-secret-value"]) {
      expect(carried).not.toContain(secret);
    }
    expect(carried).toContain("[REDACTED");
  });

  it("fails closed for malformed or wrong-status marked output", () => {
    expect(() => parseWorkerBlockedResult(`${WORKER_BLOCKED_RESULT_MARKER} nope`)).toThrow(/expected JSON/i);
    expect(() => parseWorkerBlockedResult(`${WORKER_BLOCKED_RESULT_MARKER} {"status":"DONE"}`)).toThrow(/BLOCKED \/ NEEDS_ADVISOR/i);
  });
});
