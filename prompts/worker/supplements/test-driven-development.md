# Test-driven development

Use this supplement when a worker prompt asks for red/green implementation.

- Write or identify the failing test before production changes.
- For defects, reproduce the reported bug with a regression test before fixing it.
- Red means the test fails for the expected reason.
- Green means the smallest production change makes the committed tests pass.
- Prefer behavior/state assertions over implementation-detail assertions.
- Prefer real implementations or focused fakes over broad mocks.
- Keep tests descriptive: names should read like specifications.
- Do not skip, delete, weaken, or rewrite unrelated tests to make the suite pass.
- Run the narrow verification command first, then the broader suite where available.
- Leave refactoring until after red and green are proven.