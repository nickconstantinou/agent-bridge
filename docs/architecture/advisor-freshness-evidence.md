# Advisor freshness-aware evidence

The advisor is advice-only. Agent Bridge remains authoritative for evidence
collection, deterministic verification, mutation, approval, deployment and
rollback.

## Envelope

Advisor callers may supply a freshness-aware evidence envelope through
`AdvisorEvidenceInput.envelope`. Each current-state item has a stable `id`,
claim, source, ISO-8601 `observedAt` timestamp and an authority of
`deterministic`, `reported` or `inferred`. The envelope also separates:

- the latest blocker;
- accepted decisions and completed actions;
- superseded findings;
- unresolved risks, stale evidence and unavailable evidence;
- the explicit assessment question.

`reconcileAdvisorEvidence()` validates and bounds the envelope before it is
used. Findings explicitly named by a newer item in `supersedes` are removed
from current state only when the replacement has a strictly newer observation
time and equal or stronger authority; a reported/inferred item cannot erase
deterministic state. Supersession targets must exist.

Claims do not conflict merely because they share a source. A caller must name
the semantic relationship with `conflictsWith` evidence IDs. Unknown,
superseded or otherwise invalid conflict targets fail closed. `latestBlocker`
must name the matching current deterministic state item, so stale or inferred
items cannot be promoted by labelling them a blocker. Superseded-history items
are subject to the same bounded-list limit as every other envelope list.

The same envelope is rendered into both ordinary advisor prompts and the
worker-debug selection/final prompts. This prevents manual and worker
assessments from applying different authority rules.

## Confidence and evidence

The model may request only the existing typed, Bridge-owned read-only tools.
Tool results carry stable evidence identifiers and the debug parser requires
evidence-based claims to cite them. A `high` confidence result is downgraded
to `medium` when the envelope records stale, unavailable or conflicting
load-bearing evidence, or when the bounded investigation has incomplete
results. Deterministic evidence remains authoritative over advisor opinion.

Envelope text is redacted at the trusted service boundary. No new database
schema, direct SQL, provider-native tool, shell, service-control or mutation
capability is introduced by this slice.
