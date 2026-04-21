# gh-fix-ci

Root-cause-first workflow for fixing failing GitHub Actions checks.

## When to use
Use this skill when the user asks to fix CI or deploy workflow failures.

## Required sequence
1. Inspect the failing run with `gh` and identify the exact failed step/command.
2. Extract the first fatal error line from logs (not downstream noise).
3. Prove the causal chain from that error to the failure.
4. Implement the minimum fix that addresses that root cause directly.
5. Validate locally with required checks for touched code.
6. Rerun the workflow and confirm pass (or capture new first-failure if different).
7. Report: root cause (one sentence), fix, and evidence (step + fatal line + passing rerun).

## Guardrails
- Do not treat reruns as a fix.
- Do not add sleeps/retries/timeouts as primary remediation.
- Do not use warning-and-continue behavior for required prerequisites.
- If root cause remains unknown after initial investigation, stop and ask the user.
