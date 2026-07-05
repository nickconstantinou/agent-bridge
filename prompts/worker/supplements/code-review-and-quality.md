# Code review and quality

Use this supplement for scan, triage, review, and release-readiness prompts.

Review through these axes:

1. Correctness: broken behavior, edge cases, invalid state, race conditions, stale assumptions.
2. Simplicity: unnecessary abstractions, duplicated branches, excessive indirection, unclear naming.
3. Architecture: ownership drift, boundary violations, misplaced state, orchestration leaking into business logic.
4. Security: missing authorization checks, unsafe input handling, accidental secret exposure, overly broad permissions, destructive actions.
5. Performance: unbounded work, synchronous hot-path operations, repeated external calls, avoidable repeated queries.

Report only findings with direct repository evidence. Avoid speculative style preferences. Prefer findings that can be fixed with a small, verifiable change.