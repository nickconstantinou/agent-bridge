import type { AdvisorConfidence } from "./advisorTypes.js";

type AdvisorEvidenceAuthority = "deterministic" | "reported" | "inferred";

interface AdvisorEvidenceItemInput {
  id: string;
  claim: string;
  source: string;
  observedAt: string;
  authority: AdvisorEvidenceAuthority;
  supersedes?: string[];
}

interface AdvisorDecisionInput {
  decision: string;
  decidedAt: string;
}

interface AdvisorCompletedActionInput {
  action: string;
  evidenceId: string;
  observedAt: string;
}

interface AdvisorSupersededFinding {
  finding: string;
  supersededBy: string;
  supersededAt: string;
}

export interface AdvisorEvidenceEnvelopeInput {
  assessmentGoal: string;
  currentState: AdvisorEvidenceItemInput[];
  latestBlocker?: AdvisorEvidenceItemInput;
  acceptedDecisions: AdvisorDecisionInput[];
  completedActions: AdvisorCompletedActionInput[];
  supersededFindings?: AdvisorSupersededFinding[];
  unresolvedRisks: string[];
  unavailableEvidence: string[];
  staleEvidence?: string[];
  explicitQuestion: string;
}

interface AdvisorEvidenceEnvelope extends AdvisorEvidenceEnvelopeInput {
  currentState: AdvisorEvidenceItemInput[];
  supersededFindings: AdvisorSupersededFinding[];
  staleEvidence: string[];
  inferredEvidence: string[];
  conflicts: string[];
  evidenceIds: string[];
}

const MAX_TEXT = 2_000;
const MAX_LIST = 32;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function boundedText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty bounded string`);
  const text = value.trim();
  if (text.length > MAX_TEXT) throw new Error(`${field} exceeds bounded length`);
  return text;
}

function timestamp(value: unknown, field: string): string {
  const text = boundedText(value, field);
  if (!ISO_TIMESTAMP.test(text) || Number.isNaN(Date.parse(text))) throw new Error(`${field} must be an ISO-8601 observed_at timestamp`);
  return text;
}

function list<T>(value: unknown, field: string, map: (item: unknown, index: number) => T): T[] {
  if (!Array.isArray(value) || value.length > MAX_LIST) throw new Error(`${field} must be a bounded list`);
  return value.map(map);
}

function evidenceItem(value: unknown, index: number): AdvisorEvidenceItemInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`current_state[${index}] must be an object`);
  const item = value as Record<string, unknown>;
  const supersedes = item.supersedes == null
    ? undefined
    : list(item.supersedes, `current_state[${index}].supersedes`, (entry, childIndex) => boundedText(entry, `current_state[${index}].supersedes[${childIndex}]`));
  if (!["deterministic", "reported", "inferred"].includes(String(item.authority))) {
    throw new Error(`current_state[${index}].authority is invalid`);
  }
  return {
    id: boundedText(item.id, `current_state[${index}].id`),
    claim: boundedText(item.claim, `current_state[${index}].claim`),
    source: boundedText(item.source, `current_state[${index}].source`),
    observedAt: timestamp(item.observedAt, `current_state[${index}].observed_at`),
    authority: item.authority as AdvisorEvidenceAuthority,
    ...(supersedes?.length ? { supersedes } : {}),
  };
}

function decision(value: unknown, index: number): AdvisorDecisionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`accepted_decisions[${index}] must be an object`);
  const item = value as Record<string, unknown>;
  return {
    decision: boundedText(item.decision, `accepted_decisions[${index}].decision`),
    decidedAt: timestamp(item.decidedAt, `accepted_decisions[${index}].decided_at`),
  };
}

function completedAction(value: unknown, index: number): AdvisorCompletedActionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`completed_actions[${index}] must be an object`);
  const item = value as Record<string, unknown>;
  return {
    action: boundedText(item.action, `completed_actions[${index}].action`),
    evidenceId: boundedText(item.evidenceId, `completed_actions[${index}].evidence_id`),
    observedAt: timestamp(item.observedAt, `completed_actions[${index}].observed_at`),
  };
}

function textList(value: unknown, field: string): string[] {
  return list(value, field, (item, index) => boundedText(item, `${field}[${index}]`));
}

export function reconcileAdvisorEvidence(input: AdvisorEvidenceEnvelopeInput): AdvisorEvidenceEnvelope {
  const assessmentGoal = boundedText(input.assessmentGoal, "assessment_goal");
  const states = list(input.currentState, "current_state", evidenceItem);
  const acceptedDecisions = list(input.acceptedDecisions, "accepted_decisions", decision);
  const completedActions = list(input.completedActions, "completed_actions", completedAction);
  const unresolvedRisks = textList(input.unresolvedRisks, "unresolved_risks");
  const unavailableEvidence = textList(input.unavailableEvidence, "unavailable_evidence");
  const staleEvidence = textList(input.staleEvidence ?? [], "stale_evidence");
  const explicitQuestion = boundedText(input.explicitQuestion, "explicit_question");
  const latestBlocker = input.latestBlocker == null ? undefined : evidenceItem(input.latestBlocker, 0);
  const explicitSuperseded = [...(input.supersededFindings ?? [])].map((finding, index) => {
    if (!finding || typeof finding !== "object") throw new Error(`superseded_findings[${index}] must be an object`);
    const item = finding as unknown as Record<string, unknown>;
    return {
      finding: boundedText(item.finding, `superseded_findings[${index}].finding`),
      supersededBy: boundedText(item.supersededBy, `superseded_findings[${index}].superseded_by`),
      supersededAt: timestamp(item.supersededAt, `superseded_findings[${index}].superseded_at`),
    };
  });

  const supersededIds = new Map<string, string>();
  for (const state of states) for (const id of state.supersedes ?? []) supersededIds.set(id, state.id);
  const currentState = states.filter((state) => !supersededIds.has(state.id));
  const supersededFindings = [
    ...explicitSuperseded,
    ...states.flatMap((state) => (state.supersedes ?? []).flatMap((id) => {
      const old = states.find((candidate) => candidate.id === id);
      return old ? [{ finding: old.claim, supersededBy: state.id, supersededAt: state.observedAt }] : [];
    })),
  ];
  const conflicts = currentState
    .filter((state) => state.authority !== "deterministic")
    .flatMap((state) => currentState
      .filter((other) => other.id !== state.id && other.source === state.source && other.authority === "deterministic")
      .filter((other) => Date.parse(other.observedAt) >= Date.parse(state.observedAt))
      .map((other) => `${state.id} conflicts with newer deterministic evidence ${other.id}`));
  const inferredEvidence = currentState.filter((state) => state.authority === "inferred").map((state) => state.id);

  return {
    assessmentGoal,
    currentState,
    ...(latestBlocker ? { latestBlocker } : {}),
    acceptedDecisions,
    completedActions,
    supersededFindings,
    unresolvedRisks,
    unavailableEvidence,
    staleEvidence,
    inferredEvidence,
    explicitQuestion,
    conflicts,
    evidenceIds: [...currentState, ...(latestBlocker ? [latestBlocker] : []), ...completedActions.map((action) => ({ id: action.evidenceId }))]
      .map((item) => item.id)
      .filter((id, index, all) => all.indexOf(id) === index),
  };
}

export function constrainAdvisorConfidence(confidence: AdvisorConfidence, envelope: Pick<AdvisorEvidenceEnvelope, "unavailableEvidence" | "staleEvidence" | "inferredEvidence" | "conflicts">): AdvisorConfidence {
  if (confidence === "high" && (envelope.unavailableEvidence.length > 0 || envelope.staleEvidence.length > 0 || envelope.inferredEvidence.length > 0 || envelope.conflicts.length > 0)) return "medium";
  return confidence;
}

export function formatAdvisorEvidenceEnvelope(envelope: AdvisorEvidenceEnvelope): string {
  return JSON.stringify({
    assessment_goal: envelope.assessmentGoal,
    current_state: envelope.currentState,
    latest_blocker: envelope.latestBlocker ?? null,
    accepted_decisions: envelope.acceptedDecisions,
    completed_actions: envelope.completedActions,
    superseded_findings: envelope.supersededFindings,
    unresolved_risks: envelope.unresolvedRisks,
    unavailable_evidence: envelope.unavailableEvidence,
    stale_evidence: envelope.staleEvidence,
    inferred_evidence: envelope.inferredEvidence,
    explicit_question: envelope.explicitQuestion,
    conflicts: envelope.conflicts,
  });
}
