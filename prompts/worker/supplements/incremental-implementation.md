# Incremental implementation

Use this supplement when a worker prompt asks the CLI to change code.

- Implement one coherent slice at a time.
- Touch only files required by the approved plan and current slice.
- Do not perform adjacent cleanup, cosmetic rewrites, import churn, broad renames, or opportunistic refactors.
- Keep the project buildable after each slice.
- Prefer simple code over abstractions for hypothetical future use.
- Use safe defaults and preserve existing behavior unless the task explicitly changes it.
- If incomplete work must remain hidden, use an explicit feature flag or preserve the existing public behavior.
- Make changes rollback-friendly with small commits.
- Stop and report when the required change exceeds the approved scope.