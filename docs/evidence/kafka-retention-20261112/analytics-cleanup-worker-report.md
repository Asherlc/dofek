# Analytics queue cleanup worker report

Date: 2026-11-12
Worktree: `/Users/asherlc/.paseo/worktrees/3b2webx6/noxious-goat`
Scope: Task 3 only. No branch switch, commit, push, production access/action, or documentation edit.

## Evidence and implementation

- Diagnosis source: `/tmp/kafka-retention-20261112/analytics-shutdown-diagnosis.md`.
- The process Redis singleton created its own BullMQ client but passed `shared: true`, which prevents its wrapper from closing that client. The sync router also created an independent module-level Queue that was not part of `closeAllQueueResources()`.
- Removed the `shared: true` ownership option from the process-owned `RedisConnection` while retaining the process singleton.
- Added `getSyncQueue()` using the existing cached-queue pattern. Kept `createSyncQueue(connection?)` unchanged. The sync router now uses the cached getter, and `closeAllQueueResources()` closes and resets the sync Queue.
- `runAnalyticsWorker()` now calls `closeAllQueueResources()` after `worker.run()`, the explicit refresh Queue drain, and health-server closure, then closes Sentry last.

## RED evidence

- `rtk pnpm vitest run src/jobs/queues.test.ts` failed before implementation as expected: the Redis wrapper was still constructed with `shared: true`, and `getSyncQueue` did not exist. The other 69 queue tests passed.
- `rtk pnpm vitest run scripts/run-analytics-worker.test.ts` failed before implementation as expected: the held worker drained, the refresh Queue and health server closed, then Sentry closed without process-wide resource cleanup. The other 3 analytics worker tests passed.
- Genuine native RED command, with `src/jobs/queues.ts` and `packages/server/src/routers/sync.ts` temporarily replaced by their exact `HEAD` contents and restored afterward:
  `rtk bash -lc 'set -a; . ./.env.local; set +a; pnpm vitest run --project integration --retry 0 src/jobs/queue-resource-cleanup.integration.test.ts'`
  Result: reached `closeAllQueueResources()`, logged `cleanup-complete ready`, then failed its parent-owned natural-close deadline because the Redis client remained ready and the child did not exit. This reproduces the old resource leak rather than an absent-API failure. The two working source files were copied back byte-for-byte and verified with `rtk cmp` before GREEN.

## GREEN evidence

- Focused unit command:
  `rtk pnpm vitest run --project unit src/jobs/queues.test.ts packages/server/src/routers/sync.test.ts packages/server/src/routers/sync-registration.test.ts packages/server/src/routers/sync-helpers.test.ts scripts/run-analytics-worker.test.ts`
  Result: 5 files passed, 184 tests passed.
- Real Redis integration command:
  `rtk bash -lc 'set -a; . ./.env.local; set +a; pnpm vitest run --project integration --retry 0 src/jobs/queue-resource-cleanup.integration.test.ts'`
  Result: 1 test passed. The child uses `NODE_ENV=production` and `DEPLOY_ENVIRONMENT=development`, asserts production selected `RedisCacheStore`, imports the real `RedisQueryCacheRegistry` and `appRouter`, runs the registry lookup, calls the existing process cleanup API, records the registry client's post-cleanup status, and exits naturally. The parent awaits the child's `close` event (stdio drained), confirms status `end`, exit code 0, and no signal. No held-work wrapper or direct new getter/backend inspection remains in the native fixture; entrypoint drain order is covered by the unit test. No queue jobs or Redis data were deleted.
- Root TypeScript: `rtk pnpm typecheck` passed (`TypeScript: No errors found`).
- Server TypeScript: `rtk pnpm --dir packages/server typecheck` passed.
- Changed-file lint: `rtk pnpm exec biome check src/jobs/queues.ts src/jobs/queues.test.ts src/jobs/queue-resource-cleanup.integration.test.ts packages/server/src/routers/sync.ts packages/server/src/routers/sync.test.ts scripts/run-analytics-worker.ts scripts/run-analytics-worker.test.ts` passed (`Checked 7 files ... No fixes applied`).
- Whitespace: `rtk git diff --check` passed.
- The analytics entrypoint unit regression removes only the SIGINT/SIGTERM listeners added during its run in `finally`, leaving preexisting process listeners untouched.
- Started only this worktree's Redis with `rtk pnpm compose -- up -d --wait redis` and stopped it after validation with `rtk pnpm compose -- stop redis`; the worktree's named Redis volume was preserved.

## Changed files

- `src/jobs/queues.ts`
- `src/jobs/queues.test.ts`
- `src/jobs/queue-resource-cleanup.integration.test.ts` (new)
- `packages/server/src/routers/sync.ts`
- `packages/server/src/routers/sync.test.ts`
- `scripts/run-analytics-worker.ts`
- `scripts/run-analytics-worker.test.ts`

## Remaining qualification

The native child proves Redis resource closure and natural exit through the production registry/router imports with the installed BullMQ and Redis. It does not initialize the analytics worker's production Sentry/OpenTelemetry configuration. The mocked entrypoint unit test verifies teardown ordering, but it does not qualify telemetry socket shutdown. Lead should account for enabled telemetry handles in full worker native acceptance and must not infer that this Redis fixture proves the production worker exits with telemetry enabled. No implementation uncertainty remains in Task 3 scope.

## Retrospective

The diagnosis tied the live Redis sockets to two concrete ownership gaps, and the Redis-only native child made the lifecycle result directly observable. The main investigation detail was BullMQ 6.3.14's distinction between a process singleton and a client marked externally shared. The native RED/GREEN pair now exercises only production imports and cleanup APIs, while entrypoint unit coverage verifies held-work ordering.

For future shutdown tasks, the brief can explicitly require both (a) a Redis-only natural-exit fixture and (b) separate accounting for telemetry handles when production telemetry is enabled. This should be recorded alongside the lead's release receipts; no additional docs were edited within this task's scope. Reuse `superpowers:test-driven-development` and `integration-tests-ready` for similar changes. No new skill is needed.

## Follow-up CI test corrections

After the lead reported two full-suite failures, updated only these tests:

- `packages/server/src/index.test.ts`: added the `getSyncQueue` mock required when the index imports the real router.
- `packages/server/src/lib/redis-query-cache-registry.test.ts`: renamed the expectation to process-owned and removed the obsolete `shared: true` option from its exact `RedisConnection` expectation.

Searched test sources for `getSyncQueue`, `createSyncQueue`, and `shared: true`. The other `createSyncQueue` mocks belong to worker-health/account-erasure tests and `sync-registration.test.ts`, which do not import the sync router; the latter was already covered by the focused suite. Existing `shared: true` expectations in unrelated Redis-store tests were left unchanged.

Checks:

- `rtk pnpm vitest run --project unit packages/server/src/index.test.ts packages/server/src/lib/redis-query-cache-registry.test.ts`: 2 files, 52 tests passed.
- `rtk pnpm vitest run --project unit packages/server/src/index.test.ts packages/server/src/lib/redis-query-cache-registry.test.ts src/jobs/queues.test.ts packages/server/src/routers/sync.test.ts packages/server/src/routers/sync-registration.test.ts packages/server/src/routers/sync-helpers.test.ts scripts/run-analytics-worker.test.ts`: 7 files, 236 tests passed.
- `rtk pnpm exec biome check packages/server/src/index.test.ts packages/server/src/lib/redis-query-cache-registry.test.ts src/jobs/queues.ts src/jobs/queues.test.ts src/jobs/queue-resource-cleanup.integration.test.ts packages/server/src/routers/sync.ts packages/server/src/routers/sync.test.ts scripts/run-analytics-worker.ts scripts/run-analytics-worker.test.ts`: passed, 9 files checked.
- `rtk git diff --check`: passed.

No production code, TypeScript types, or docs were changed in this correction round. `docs/production-incident-baseline.md` was already modified in the shared worktree by the lead and was left untouched. The lead will rerun the full suite.

## Queue test assertion review

Restored exact assertions in `src/jobs/queues.test.ts` after lead review:

- `getRedisConnection` now compares all four parsed/default connection cases against the full returned options, including `maxRetriesPerRequest`, `connectTimeout`, and `lazyConnect`.
- `createProviderSyncQueue` checks the explicit connection object exactly; its default Redis case still checks the default host, port, and `commandTimeout`.

Checks after correction:

- Queue unit suite: 1 file, 70 tests passed.
- Combined focused suite: 7 files, 235 tests passed.
- Biome, `git diff --check`, and the 1,000-line limit passed (975 lines).
