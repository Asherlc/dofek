# gh-fix-ci

Root-cause-first workflow for fixing failing GitHub Actions checks.

## When to use
Use this skill when the user asks to fix CI or deploy workflow failures.

## Required sequence
1. Inspect the failing run with `gh` and identify the exact failed step/command.
2. Extract the first fatal error line from logs (not downstream noise).
3. Identify the regression window: last known good run/commit vs first bad run/commit, and list the relevant changes between them.
4. Prove the causal chain from the first fatal error and regression evidence to the failure.
5. Implement the minimum fix that addresses that root cause directly.
6. Validate locally with required checks for touched code.
7. Rerun the workflow and confirm pass (or capture new first-failure if different).
8. Report: root cause (one sentence), regression cause (what changed and when), fix, and evidence (step + fatal line + passing rerun).

## Guardrails
- Do not treat reruns as a fix.
- Do not add sleeps/retries/timeouts as primary remediation.
- Do not use warning-and-continue behavior for required prerequisites.
- If root cause remains unknown after initial investigation, stop and ask the user.
- Do not skip regression analysis when the user indicates the system previously worked.
