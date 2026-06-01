# Development Practice — Red-Green-Refactor TDD

**All implementation work uses red-green-refactor TDD. No exceptions.**

1. **Red** — write a failing test that describes the desired behaviour before touching production code.
2. **Green** — make the smallest change that passes the test.
3. **Refactor** — clean up with tests green.

By work type:
- **Feature:** write the first acceptance or unit test before implementation.
- **Bug fix:** reproduce with a failing regression test before fixing.
- **Refactor:** add characterization tests that lock existing behaviour before restructuring.

Run `npm test` for the full suite. Report: red test → green change → suite result.

---

# Persistent memory

You have access to a local memory CLI named `agent-memory`.

Use it when the task depends on previous project decisions, architecture, bugs, conventions, commands, or unresolved TODOs.

Before making architectural decisions or modifying important behaviour, run:

```bash
agent-memory recall --query "<short relevant query>" --scope project --limit 10
```

When you learn a durable project fact, decision, bug fix, convention, or recurring issue, save it:

```bash
agent-memory add --type decision --scope project --text "<concise memory>"
```

Do not save secrets, API keys, passwords, transient logs, or private personal information.
Do not rely on MCP for memory.
