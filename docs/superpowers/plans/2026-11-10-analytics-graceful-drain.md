# Analytics graceful drain implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` task by task, with explicit verification and final diff review.

**Goal:** Let the existing analytics shutdown handler finish active work during normal deployment instead of exhausting Docker's default stop grace.

**Architecture:** Keep the current BullMQ consumer and publication owner. Use Docker's stock `stop_grace_period: 30m`, matching the main worker; retain fail-closed admission for abnormal or uncertain termination. No takeover timer, retries, custom coordinator or ownership bypass.

**Tech stack:** Docker Swarm, BullMQ, TypeScript, Vitest and Redis.

**Spec:** [Approved recovery and evidence](../../incidents/2026-11-10-sentry-remediation.md). The operator explicitly approved the 30-minute grace and real-service drain verification in this task conversation.

## Constraints and review focus

- Do not switch branches, change images or clear owners automatically.
- Keep existing query, health and deployment deadlines. Report any actual conflict rather than enlarging them.
- Preserve the queued follow-up request when shutdown interrupts an active build.
- Shutdown must await the active callback and stop admitting further callbacks.
- A hard kill can still require verified recovery; a graceful drain is not crash recovery.

Docker defines the [stop grace and forced-kill boundary](https://docs.docker.com/reference/compose-file/services/#stop_grace_period); BullMQ's [close operation](https://docs.bullmq.io/guide/workers/graceful-shutdown) waits for active work.

## Task 1: Qualify the existing drain

**Files:** `src/analytics-refresh-queue.integration.test.ts`; production caller `src/analytics-refresh-queue.ts`.

- [x] Add a Redis integration regression that starts a callback, queues its follow-up, aborts the consumer, verifies shutdown is still pending while the callback is active, then releases the callback and verifies shutdown completes with the follow-up still queued.
- [x] Run the focused suite with zero retries through `pnpm test:integration`. This characterizes the existing correct application drain; the defect is the deployment grace, not a missing queue implementation.
- [x] Review the test and its cleanup without adding production helpers or static-config unit tests.

## Task 2: Apply the approved platform setting

**Files:** `deploy/stack.yml`, `deploy/README.md`, `docs/production-incident-baseline.md`, remediation ledger.

- [x] Set only analytics-worker's `stop_grace_period` to `30m`; document why the service needs to outlive its current build.
- [x] Validate rendered stack parsing. The operator explicitly waived local Terraform plan/apply for this stack-only change because its token is available only in GitHub secrets; no Terraform files changed.
- [x] Run lint, relevant tests and root/server/web typechecks; review the actual diff, commit and push.
- [ ] Release through the canonical workflow only. Keep the incident open until a deployed shutdown/replay proves recovery. Deployment verification of a successful first cycle is a separate recommended follow-up, not implemented by this plan.
