# Strava durable resume implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Follow TDD and retain explicit verification/review checkpoints.

**Goal:** Resume interrupted Strava window syncs without repeating committed activity detail/stream requests or losing authoritative presence evidence.

**Architecture:** Reuse the existing `SyncRun.options.checkpoint` store, which the queue persists in job data. Keep Strava's provider-owned state and validation in `src/providers/strava/sync-checkpoint.ts`; no new dependencies, tables, infrastructure, or client behavior. Pin checkpoint state to the requested window, retain completed activity IDs only after all required activity writes finish. Re-list inventory from page one on every attempt, skip completed detail/stream downloads, and reconcile only from the fresh complete inventory. Preserve existing error reporting and provider rate limits. BullMQ documents [stalled job recovery](https://docs.bullmq.io/guide/jobs/stalled); Strava documents [activity pagination and time bounds](https://developers.strava.com/docs/reference/#api-Activities-getLoggedInAthleteActivities).

**Tech Stack:** TypeScript, Zod, Vitest, MSW, existing PostgreSQL integration fixtures.

**Spec:** User-approved durable resume fix, supported by the production evidence in [the incident baseline](../../production-incident-baseline.md#approved-full-history-activity-resync--running): the full job stalled at 238 activities and restarted with no checkpoint. Keep the current retry and website monitoring running.

## Global constraints

- Work on the current isolated worktree/branch; no branch switching.
- Write failing regressions before production changes; run meaningful unit and real-Postgres absence tests.
- Do not add retries, sleeps, timeout increases, new dependencies, schema changes, or source-specific app-state fields.
- Shared provider behavior serves web and mobile; no separate UI implementation is required.
- Push new commits; deployment/merge remain separate from implementation verification.

## Review focus

- Failure after metadata but before stream persistence must retry that activity.
- Restart within a page must skip completed detail/stream work while retaining its presence.
- Restart on a later page must retain earlier presence for reconciliation.
- Wrong-window or malformed checkpoints must fail loudly rather than silently skip data.
- Incomplete/error/degraded runs must retain their last safe checkpoint and avoid partial absence reconciliation.

### Task 1: Checkpoint and verify Strava window sync

**Files:** Modify `src/providers/strava/provider.ts`, colocate its existing unit suite at `src/providers/strava/provider.test.ts`, extend `src/providers/strava-sync.integration.test.ts`, and update `src/providers/README.md` and `docs/production-incident-baseline.md` with cited behavior/evidence.

**Interfaces:** Consume `SyncRun.options.checkpoint.load/save/clear` without changing the shared contract. Keep checkpoint parsing private to the provider. The provider's public `sync(run)` result and existing worker queue are the production consumers.

- [x] Write unit regressions for mid-page retry, fresh-inventory resume, pre-stream failure, checkpoint validation, and completion cleanup. Assert actual requests/public results and existing presence reconciliation behavior.
- [x] Run the focused unit suite; confirm the new resume regressions fail for missing behavior.
- [x] Implement validated window-bound checkpoint state and completed-work persistence in the provider, preserving the existing error semantics.
- [x] Extend a real-Postgres/MSW test to interrupt and resume, then assert completed and remaining rides remain present with no duplicate stream publication for committed work.
- [x] Run focused unit/integration suites, typecheck, relevant lint, and the Docker-free full unit/mobile suite. Record any environmental blockers with exact failing commands and evidence.
- [x] Review the complete change independently with a fresh reviewer; address important findings with failing tests first.
- [x] Commit/push the verified fix and incident evidence; report deployment status honestly.

Expected completion: all targeted regressions and required checks pass; no production deployment is implied by a pushed branch.
