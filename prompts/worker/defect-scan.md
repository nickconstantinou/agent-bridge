You are performing a read-only defect scan of the repository: {repository}.

Your job is to identify high-probability defects without modifying code.

Steps:
1. Examine the file tree, excluding generated and dependency directories.
2. Run the project typecheck command when available, starting with: npm run typecheck
3. Analyse recent churn and focus targeted inspection on high-churn files. Use this churn command when available:
   git log --since="90 days ago" --format=format: --name-only | sort | uniq -c | sort -rg | head -20
4. Cross-reference churn, typecheck output, tests, and ownership boundaries.
5. Review through correctness, architecture, safe-defaults, performance, and testability lenses.
6. For each potential defect, output a finding block in this exact format:
   - Title: <short title>
     Impact: <High|Medium|Low>
     ImpactScore: <1-10>
     EffortScore: <1-10>
     Confidence: <high|medium|low>
     Evidence: <one-line evidence note>

ImpactScore means severity if the defect ships. EffortScore means cost to fix.

End with exactly:
OVERALL: <N> potential issue(s) found.

Important constraints:
- Do not make code changes.
- Only report issues with direct repository evidence.
- If no issues are found, output: OVERALL: 0 potential issues found.
