import { describe, expect, it } from "vitest";
import {
  constrainAdvisorConfidence,
  reconcileAdvisorEvidence,
  type AdvisorEvidenceEnvelopeInput,
} from "../src/advisorEvidenceEnvelope.js";

const base: AdvisorEvidenceEnvelopeInput = {
  assessmentGoal: "Decide whether the rollout can proceed",
  currentState: [
    { id: "state-old", claim: "The rollout preflight passed", source: "preflight", observedAt: "2026-07-20T10:00:00Z", authority: "deterministic" },
    { id: "state-new", claim: "The rollout preflight is blocked by two legacy rows", source: "preflight", observedAt: "2026-07-20T10:05:00Z", authority: "deterministic", supersedes: ["state-old"] },
  ],
  latestBlocker: { id: "blocker-1", claim: "legacy queue count is nonzero: 2", source: "preflight", observedAt: "2026-07-20T10:05:00Z", authority: "deterministic" },
  acceptedDecisions: [{ decision: "Retain the existing sudo membership as accepted risk", decidedAt: "2026-07-19T09:00:00Z" }],
  completedActions: [{ action: "Removed broad NOPASSWD access", evidenceId: "action-1", observedAt: "2026-07-19T08:00:00Z" }],
  unresolvedRisks: ["The host-side queue disposition is not yet verified"],
    staleEvidence: ["Previous host health snapshot"],
    unavailableEvidence: ["Current service health after the preflight"],
  explicitQuestion: "What is the next safe gate?",
};

describe("advisor evidence envelope", () => {
  it("keeps the newest deterministic state, records supersession, and preserves accepted decisions", () => {
    const envelope = reconcileAdvisorEvidence(base);

    expect(envelope.currentState.map((item) => item.id)).toEqual(["state-new"]);
    expect(envelope.supersededFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ finding: "The rollout preflight passed", supersededBy: "state-new" }),
    ]));
    expect(envelope.latestBlocker?.id).toBe("blocker-1");
    expect(envelope.acceptedDecisions[0]?.decision).toContain("accepted risk");
    expect(envelope.completedActions[0]?.evidenceId).toBe("action-1");
  });

  it("downgrades high confidence when a load-bearing fact is unavailable or conflicting", () => {
    const envelope = reconcileAdvisorEvidence(base);

    expect(constrainAdvisorConfidence("high", envelope)).toBe("medium");
    expect(constrainAdvisorConfidence("low", envelope)).toBe("low");
    expect(constrainAdvisorConfidence("medium", { ...envelope, unavailableEvidence: [], staleEvidence: [], conflicts: [] })).toBe("medium");
  });

  it("does not allow inferred load-bearing state to claim high confidence", () => {
    const envelope = reconcileAdvisorEvidence({
      ...base,
      currentState: [{ id: "inferred", claim: "The host is healthy", source: "operator", observedAt: "2026-07-20T10:00:00Z", authority: "inferred" }],
      unavailableEvidence: [],
      staleEvidence: [],
    });
    expect(constrainAdvisorConfidence("high", envelope)).toBe("medium");
  });

  it("rejects malformed evidence timestamps and oversized claims", () => {
    expect(() => reconcileAdvisorEvidence({
      ...base,
      currentState: [{ ...base.currentState[0], observedAt: "yesterday" }],
    })).toThrow(/observed_at/i);
    expect(() => reconcileAdvisorEvidence({
      ...base,
      explicitQuestion: "x".repeat(2_001),
    })).toThrow(/bounded/i);
  });
});
