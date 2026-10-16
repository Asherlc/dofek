# Provider Sync Execution Ordering Implementation Plan

**Goal:** Prevent overlapping jobs for one owner/provider from fetching an old
source snapshot and committing it after a newer refresh.

**Architecture:** Extend the existing account-erasure work guard with optional
provider scope. Reuse its dedicated PostgreSQL session and four-connection
budget to hold an exclusive owner/provider advisory lock around one complete
worker callback, including HTTP acquisition and persistence. Keep ordinary
database transactions short. PostgreSQL documents session lock lifetime,
explicit release, and consistent acquisition order in its
[advisory-lock and deadlock guidance](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).

**Scope:** This covers common provider execution across manual, scheduled, MCP,
reconnect, shared-queue, and inline CLI origins. Mountain Project acquires and
persists its complete snapshot within one such execution. WHOOP/Garmin retain
checkpoints across jobs; this change makes no claim about ordering an entire
logical refresh across those continuations. Keep existing pools, dependencies,
schema, timeouts, cooldowns, retries, and queue semantics. Add no TTL or lease.

## Evidence and acceptance

The real-PostgreSQL/MSW regression in
[mountain-project-sync.integration.test.ts](../../../src/providers/mountain-project-sync.integration.test.ts),
`orders overlapping source snapshots before fetching so older metadata cannot
hide newer ticks`, failed before implementation: final Area metadata was
`Old crag` at longitude/latitude `-105, 39`, replacing expected `Current crag`
at `-106, 40`. The controlled older response reached persistence last. This is
synthetic reproduction evidence, not an observed production overlap.

The corrected test must retain the newer Area name/GPS and newly added tick,
without falsely marking it absent. A second execution for the same key must
wait before its first source request, including across separate guard-pool
instances. Different keys may run concurrently within the existing four-session
budget; waiting jobs still consume that bounded budget.

## Task 1: Serialize the complete provider execution

**Source:** `src/jobs/account-erasure-work-guard.ts`,
`src/jobs/worker-queues.ts`, `src/cli-sync.ts`.

**Interfaces:** Append `providerId?: string` to both
`AccountErasureWorkLockPool.runWithSharedUserLock(userId, work, providerId?)`
and `runQueuedUserWorkUnlessAccountErasing(pool, database, userId, workKind,
work, providerId?)`. Keep the lock name internal:
`provider-sync:${userId}:${providerId}`.

- [x] Preserve the failing MP fixture and add real-database guard tests for
  same-key exclusion across pools and independent owner/provider keys.
- [x] When provider scope exists, acquire its exclusive session advisory lock
  before the existing shared queued-user-work erasure barrier. Check the
  erasure fence after acquiring both; hold both through the complete callback.
  Release the shared barrier first, then the provider lock. A coordinator with
  no provider scope retains its existing fan-out behavior.
- [x] Pass `job.data.providerId` through per-provider workers, the shared sync
  worker, and the inline CLI sync worker. Preserve cancellation, continuation,
  and `WaitingChildrenError` handling. Update their existing test mocks.
- [x] Exercise erasure activation while one provider execution runs and another
  waits: active work drains without a user-write-lock deadlock; the waiter
  checks the activated fence and performs no HTTP request.
- [x] Run the MP integration regression and existing guard, worker-wiring, and
  CLI tests. Review lock order and all three entry points before proceeding.

## Task 2: Stop immediately when the lock session is lost

**Source:** `src/jobs/account-erasure-work-guard.ts`.
**Tests:** Its colocated unit/integration tests and an isolated TypeScript
subprocess fixture under `src/jobs/fixtures/`.

Production initializes both Sentry 10.45.0 and PostHog Node 5.47.3 exception
handlers. Each suppresses its fatal callback when another handler exists, so
neither initiates shutdown in this configuration
([Sentry handler](https://github.com/getsentry/sentry-javascript/blob/10.45.0/packages/node-core/src/integrations/onuncaughtexception.ts),
[PostHog handler](https://github.com/PostHog/posthog-js/blob/posthog-node%405.47.3/packages/node/src/extensions/error-tracking/autocapture.ts)).
Sentry's fatal callback, when invoked, also waits asynchronously for
`client.close()` before exiting
([shutdown source](https://github.com/getsentry/sentry-javascript/blob/10.45.0/packages/node-core/src/utils/errorhandling.ts)).
Neither behavior safely stops a pending HTTP callback from writing through the
separate application pool after PostgreSQL releases its session lock. An idle-pool
error handler does not protect a checked-out client
([node-postgres client events](https://node-postgres.com/apis/client#events),
[pool error events](https://node-postgres.com/apis/pool#error)).

- [x] Preserve the real-database subprocess regression with both production
  handlers enabled and a controlled transport. Terminate the held PostgreSQL
  backend while HTTP is pending. Synchronize on exception capture, rather than
  waiting for a flush that never starts, then release the response after the
  replacement refresh commits. The observed RED completed the old callback,
  restored `Old disconnected crag` and its GPS, and marked the new tick absent.
- [x] Install a checked-out session error listener before lock acquisition.
  Attempt exception capture and a static log, then synchronously call
  `process.exit(1)` in `finally`, even if reporting throws. Do not await a flush,
  run graceful shutdown, merely set `exitCode`, or race an uncancelled callback.
  Node documents immediate termination and the risk of truncating asynchronous
  output in its [process.exit reference](https://nodejs.org/api/process.html#processexitcode);
  reporting is best effort at this boundary.
- [x] Keep the listener through verified unlocks or intentional session
  destruction. Verify each unlock result; destroy the client on acquisition or
  cleanup failure. Preserve the callback's original failure while reporting
  cleanup errors. Never return a session with uncertain lock ownership.
- [x] Prove exit status 1 and no stale persistence before exit. Cover partial
  acquisition, either unlock failing or returning false, synchronous callback
  errors, normal cleanup, and pool shutdown. Review without adding public
  test-only APIs or production test branches.

## Task 3: Verify and document the bounded contract

- [x] Update `src/jobs/README.md` with the per-execution contract, lock order,
  existing connection budget, immediate session-loss behavior, and continuation
  boundary, citing the primary references above.
- [x] Run focused integration tests through the workspace dependency wrapper:
  `rtk pnpm test:integration -- src/providers/mountain-project-sync.integration.test.ts src/jobs/account-erasure-work-guard.integration.test.ts`.
  Run the corresponding unit/worker/CLI suites, `rtk pnpm typecheck`, and
  `rtk pnpm lint`; require successful exits.
- [x] Independently review the complete diff for source ownership, absence
  semantics, lock ordering, cleanup, pool usage, and subprocess failure timing.
  Keep production deployment and health-data backfills in their separate
  reviewed operational sequence.

Review lesson: a persistence-only lock cannot order source acquisition, and
telemetry handlers do not establish immediate process termination.
Keep both executable regressions as future framework safeguards.
