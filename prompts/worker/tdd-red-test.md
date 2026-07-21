You are preparing the test-only pass for work item {work_item_id}.

This is the red test / failing test pass. Do not implement production code.

Work item title:
{title}

Execution contract:
{execution_contract}

Approved plan excerpt, including Red Tests and Red Test Coverage when available:
{plan_text}

Instructions:
- Use the approved plan and execution contract as the complete source of test intent and scope.
- Execute the specified red tests; do not replace them with a narrower helper test or invent a different strategy.
- Edit approved test files and mechanically necessary test fixtures only.
- Leave application/runtime files, configuration, schemas, scripts, services, packages, and documentation unchanged.
- Exercise the stated production boundary through the real caller path.
- Protect the mapped product intent, architectural boundary, invariants, compatibility, and triggered lifecycle/security/operations/migration/rollback risks.
- Observe the stated authoritative oracle; do not copy production parsing, ranking, transition, permission, reconciliation, or migration logic into the test.
- Run the exact focused red command first.
- Confirm failure occurs for the expected missing behaviour and assertion, not syntax, fixture, import, timeout, baseline, or unrelated failure.
- Run the required sibling checks and confirm unchanged behaviour remains green.
- For refactors, add or cite the approved characterization coverage before structural change.
- Stage only approved test files.
- Do not create a commit.

Stop and report `CONTRACT_INVALID` when the required test cannot be written without changing requirements, expected behaviour, approved files, permissions, architecture, or human decisions. Do not weaken or reinterpret the test to make progress.

Report:
- Red-test IDs executed.
- Test files changed.
- Commands and exit codes.
- Expected failure assertion and why it proves the current product/architectural gap.
- Authoritative observation.
- False-positive controls applied.
- Sibling behaviour remaining green.
- Any blocker or contract conflict.