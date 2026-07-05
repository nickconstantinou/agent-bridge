You are preparing the test-only pass for work item {work_item_id}.

Work item title:
{title}

Execution contract:
{execution_contract}

Relevant plan excerpt, if provided:
{plan_text}

Instructions:
- Use the execution contract as the primary source of scope.
- Edit test files only.
- Leave application/runtime files unchanged.
- Add the smallest test or characterization coverage required by the approved contract.
- For features and defects, the new coverage should fail for the expected reason before implementation.
- For pure refactors, preserve behavior with characterization coverage or existing tests as described in the contract.
- Run only the narrow verification command first.
- Stage only test files.
- Do not create a commit.

Report:
- Test files changed.
- Command run.
- Expected failure or characterization result.
- Any blocker.
