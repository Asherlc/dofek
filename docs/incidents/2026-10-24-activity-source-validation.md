# 2026-10-24 — Activity source validation: retained local evidence

These excerpts record local validation for [PR 3077](https://github.com/Asherlc/dofek/pull/3077) on October 24, 2026 in America/Los_Angeles (October 25 UTC). Only command output relevant to the result is reproduced; workstation paths, routine container output, and the long generated SQL body are omitted. No credentials or full raw logs are included.

The original RSS 1.26 GiB / maximum 1.25 GiB measurements and container/server cap inspections mentioned in the [incident baseline](../production-incident-baseline.md#2026-10-24--local-activity-source-validation-exceeded-clickhouse-fixture-memory) were not retained as raw output. The later failure below is separate evidence with different measured values.

## Focused calendar hydration passed

Source: `dofek-pr3077-merged-integration.log`. Its container output timestamps the run at `2026-10-24T21:47:03-07:00`; Vitest reports the test start at `21:47:05`. The full source log's SHA-256 is `c9b7a3c24f221609a46aae5ab8ea262b17bc69c3a13e241752421d6c55aa53a7`.

The `pnpm test:integration packages/server/src/repositories/activities-calendar-repository.integration.test.ts -t 'Activities list source tree hydration'` invocation emitted this package-script command:

```text
$ tsx scripts/run-tests.ts integration packages/server/src/repositories/activities-calendar-repository.integration.test.ts -t 'Activities list source tree hydration'
```

Its result excerpt records two passing cases and three skipped cases:

```text
 Test Files  1 passed (1)
      Tests  2 passed | 3 skipped (5)
   Start at  21:47:05
   Duration  14.38s (transform 1.29s, setup 0ms, import 2.76s, tests 11.49s, environment 0ms)
```

The [test source](../../packages/server/src/repositories/activities-calendar-repository.integration.test.ts) defines the fixture and assertions; the output above is the evidence for the recorded result.

## Later visibility fixture setup failed

Source: `dofek-pr3077-visibility-contract-validation.log`. Its container output timestamps the run at `2026-10-24T22:09:10-07:00`; the engine request failure is timestamped `2026-10-25T05:09:29.949Z`. The full source log's SHA-256 is `65795ec6a32ece015370c7b95dc4482be2d7038a026a385acb66bd22d13e0303`.

The retained package-script command was:

```text
$ tsx scripts/run-tests.ts integration -- packages/server/src/repositories/activity-visibility-consistency.integration.test.ts --retry 0
```

The first fatal engine error and its code were:

```text
Caused by: ClickHouseError: (total) memory limit exceeded: would use 875.11 MiB (attempt to allocate chunk of 0.00 B), current RSS: 1.18 GiB, maximum: 1.18 GiB. OvercommitTracker decision: Query was selected to stop by OvercommitTracker. Untracked memory across all threads: -13.46 MiB.
  code: '241',
  type: 'MEMORY_LIMIT_EXCEEDED'
```

Selected failure-context lines identify the legacy insertion and fixture call path. The intervening generated SQL and stack formatting are omitted:

```text
Error: ClickHouse test command failed: INSERT INTO analytics_test_8492de97e149.v_activity
WITH legacy AS (WITH
 ❯ rebuildClickHouseSensorAnalyticsWithClient packages/server/src/routers/clickhouse-integration-test-helpers.ts:963:5
 ❯ syncClickHouseTestActivitySensorStoreWithClient packages/server/src/routers/clickhouse-integration-test-helpers.ts:811:3
 ❯ createClickHouseTestStore packages/server/src/routers/clickhouse-integration-test-helpers.ts:545:5
 ❯ packages/server/src/repositories/activity-visibility-consistency.integration.test.ts:113:19
```

The run failed during setup; it did not execute the five assertions:

```text
 Test Files  1 failed (1)
      Tests  5 skipped (5)
   Start at  22:09:12
   Duration  21.35s (transform 2.55s, setup 0ms, import 4.36s, tests 16.82s, environment 0ms)

[ELIFECYCLE] Command failed with exit code 1.
```

This output supports a local legacy-fixture memory failure. It does not establish a production incident, the older memory figures, or a passing visibility-consistency assertion. Hosted validation remains available in the [PR checks](https://github.com/Asherlc/dofek/pull/3077/checks).
