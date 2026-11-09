# Restore Direct CD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Restore direct server CD and let automatic OTA/TestFlight publication continue independently of the production lock.

**Architecture:** The user approved direct server CD with independent automatic mobile releases and preserved deployment gates. `Deploy Web` calls the existing environment workflow directly after successful main-push CI. Only its production job holds `deploy-web-production`; matching mobile jobs depend on successful server output and retain their own locks. Automatic deployment requires the CI source SHA to equal the caller workflow SHA, preventing the previously observed workflow/source mismatch without tags or dispatch polling. Superseded CI completions wait for current main to pass instead of selecting an older successful ancestor.

**Tech Stack:** Existing GitHub Actions workflows, actionlint, Vitest. No new dependencies or custom orchestration.

**Spec:** User approval in this conversation: “Yes, restore the simpler flow.” The design above records the implementation choices within that approval.

## Global Constraints

- Keep the current isolated worktree and branch; no branch switching.
- Preserve immutable-image/source checks, Terraform, migration, CDC, rollout, backup and Sentry gates.
- Keep automatic OTA and TestFlight publication after successful server deployment; failed/cancelled server deployment cannot publish.
- Use stock job-level concurrency, never cancel an active production rollout.
- Manual Deploy releases must also release their production lock before mobile publication.
- Remove obsolete handoff/selection code and its tests; do not add absence tests or static-config tests.
- Do not cancel existing releases, move release tags, merge, or dispatch production as part of local qualification.

## Review Focus

- Successful CI from an older SHA must not combine newer workflow definitions with older source/image.
- Failed CI and non-push CI cannot enter production serialization or displace eligible work.
- Manual and automatic server jobs must share production serialization without locking mobile jobs.
- Both mobile publishers consume the successful server's verified source SHA and remain blocked on server failure.
- Removed selector references must not remain in active docs or workflow callers.

### Task 1: Restore direct deployment and scope production serialization

**Files:** `.github/workflows/deploy-web.yml`, `.github/workflows/deploy.yml`; delete `.github/workflows/deploy-web.test.ts`, `scripts/select-web-deploy.ts`, `scripts/select-web-deploy.test.ts`.

**Interfaces:** Existing environment workflow receives the exact successful CI SHA and run ID, or manual image input; its verified `commit_sha` output feeds OTA/iOS.

- [x] Run existing focused workflow/selector/image-resolution tests before edits.
- [x] Replace selector/handoff jobs with the direct environment call, guarded by successful main-push CI at the workflow's SHA, plus existing manual dispatch support.
- [x] Add independent OTA/iOS calls after successful production using its verified output.
- [x] Move production serialization from workflow scope to the server job in both entrypoints; retain existing stack, Terraform and mobile locks.
- [x] Delete obsolete runtime selection/handoff implementations and their tests.
- [x] Run actionlint, retained workflow/image tests, and source-policy lint; inspect the actual diff against every Review Focus item. Expected: all pass with no deployment gate changes.

### Task 2: Update operations documentation and qualify the whole change

**Files:** `README.md`, `deploy/README.md`, `scripts/README.md`, `docs/production-incident-baseline.md`.

**Interfaces:** Documentation describes the exact workflow behavior delivered by Task 1.

- [x] Replace active handoff/tag/selector instructions with direct server CD, exact-current-main eligibility, independent mobile lock ownership, and direct server-job inspection. Cite official GitHub behavior.
- [x] Record the durable fix, validation and remaining production rollout limitation in the incident baseline.
- [x] Run the Docker-free unit/mobile suite, typecheck, actionlint, canonical source spelling and diff checks. Expected: all pass; report any external prerequisite failure explicitly.
- [x] Obtain a fresh whole-diff review using the Architect profile; resolve important findings while preserving the approved approach.
- [x] Commit and push the final changes automatically; open a reviewable PR and monitor its checks without merging or dispatching production.

## Working Notes

- Design checkpoint: user approved the simpler flow before implementation; no additional approval is needed for routine edits or validation.
- Review checkpoints: inspect Task 1's real diff before documentation; review the complete final diff independently before claiming completion.
- Local checks passed and the independent review's two stale documentation statements were corrected. [PR #3249](https://github.com/Asherlc/dofek/pull/3249) contains the implementation; CI is monitored separately and production execution requires merge.
