You are completing the implementation pass for work item {work_item_id}.

Work item title:
{title}

Execution contract:
{execution_contract}

Approved plan excerpt, including Architectural Intent and Red Tests when available:
{plan_text}

Instructions:
- Use the approved plan, committed red tests, and execution contract as the complete source of scope.
- Leave committed tests unchanged. Do not weaken assertions, alter fixtures to bypass behaviour, or replace the authoritative oracle.
- Edit only production/runtime files required by the approved contract.
- Make the smallest coherent change that satisfies the committed red tests, product intent, architectural intent, invariants, compatibility, and applicable lifecycle/security/operations requirements.
- Ensure the real production caller uses the intended abstraction or ownership boundary; unused classes, helpers, or parallel paths do not satisfy architectural acceptance.
- Do not perform unrelated cleanup, broad refactoring, dependency changes, schema changes, operational actions, or scope expansion.
- Never add test imports, test hooks, or test-only environment cleanup to production source.
- Run the focused verification command first, then the required sibling and broader suite commands.
- Stage only approved production/runtime files.
- Do not create a commit.

Stop and report `NEEDS_HUMAN_REVIEW` when the required change exceeds the approved contract, changes test expectations, contradicts product intent, crosses a permission or ownership boundary, introduces migration/rollback implications not planned, or requires a human decision.

Report:
- Runtime files changed.
- Red-test IDs satisfied.
- Product and architectural intent satisfied.
- Commands and results.
- Sibling behaviour remaining green.
- Residual risk or blocker.