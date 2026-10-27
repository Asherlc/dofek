# Mobile Activities loading evidence — 2026-10-23

Operator measurements below were captured on October 24 UTC (October 23 in
America/Los_Angeles) while investigating the mobile Activities spinner.
The candidate is [commit 8cb92ff](https://github.com/Asherlc/dofek/commit/8cb92ff54db4a80fab38415220d25564f51f96d5).
[Hosted validation](https://github.com/Asherlc/dofek/actions/runs/40059234752)
tracks that implementation. No production view was replaced during profiling.

## Request and database logs

The Axiom CLI queried `dofek-logs` for `calendar.` and `clickhouse.queue_wait`,
projecting timestamps, message, wait duration, queue, and trace ID. Relevant
captured messages for trace `efe9601acec64f2bc62f0336788cad05`:

```text
2026-10-24T03:20:23.293Z [trpc] Slow query procedure=calendar.calendarData type=query authenticated=true db_duration_ms=36737 total_duration_ms=36746 cache_hit=false app_version=1.13
2026-10-24T03:21:14.048Z [trpc] Slow query procedure=calendar.activityOverview type=query authenticated=true db_duration_ms=87491 total_duration_ms=87500 cache_hit=false app_version=1.13
2026-10-24T03:21:31.307Z [trpc] Slow query procedure=calendar.weekList type=query authenticated=true db_duration_ms=104751 total_duration_ms=104760 cache_hit=false app_version=1.13
2026-10-24T03:21:31.327Z [web] POST /api/trpc/processing.status,processing.alerts,sync.providers,providerGuide.status,anomalyDetection.check,settings.get,calendar.calendarData,calendar.weekList,calendar.activityOverview,processing.status?batch=1 200 104794ms
```

The aggregate query over the preceding two hours returned:

```json
{"attributes.queue":"regular","maxWait":60.56100000021979,"n":21,"p95":45.88235000008717}
{"attributes.queue":"dashboard","maxWait":3.080682000145316,"n":15,"p95":3.080682000145316}
```

`system.query_log` showed the initial activity SELECT starting at 03:19:46 UTC,
reading 12,077 rows in 190 ms. PostgreSQL service logs separately recorded:

```text
2026-10-24 03:21:32.868 UTC [3910382] LOG: duration: 19699.168 ms execute <unnamed>: SELECT id::text AS id
  FROM fitness.v_activity
  WHERE user_id = $1::uuid AND id IN ($2::uuid, ...)
```

`axiom dataset list` contained `dofek-logs` and `dofek-metrics`, but no
`dofek-traces`. Querying the latter returned `unable to find dataset
'dofek-traces'`. Database execution plans supplied the missing engine timings.

## Read-only PostgreSQL plans

The initial `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` selected `id` from
`fitness.v_activity` for the affected user with `started_at >= '2026-09-26'`.
The captured plan summary was:

```json
{"planningMs":14.324,"executionMs":12801.830,"rows":69}
{"node":"Aggregate","rows":1706,"loops":1,"totalMs":12417.134}
```

The expensive aggregate grouped origin members by group and user; its input
read 3,672 ranked members for that user. The requested date filter ultimately
returned 69 groups.

The final comparison ran both SELECTs sequentially inside one
`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction. The old SELECT
used the deployed view; the candidate wrapped the checked-in
[`01_v_activity.sql`](../../drizzle/_views/01_v_activity.sql) query body in a
CTE. Both selected `id` using the same user and September 26 lower bound.
The transaction ended with `ROLLBACK`:

```json
{"version":"OLD","executionMs":13946.956,"planningMs":63.758,"rows":68}
{"version":"NEW","executionMs":440.785,"planningMs":5.137,"rows":68}
```

Separate all-history SELECTs for the same user returned 1,757 groups:

```json
{"version":"NEW","executionMs":16945.329,"rows":1757}
{"version":"OLD repeated baseline","executionMs":13714.313,"rows":1757}
```

Those broad reads ran sequentially against the live system rather than inside
the shared snapshot. They establish a measured approximately 24% broad-read
tradeoff, not an all-history speedup. PostgreSQL describes execution-plan
measurements in its [EXPLAIN guide](https://www.postgresql.org/docs/current/using-explain.html).

## Local validation transcripts

The new date-filter test initially failed with aggregate input `[26]` versus
expected `[2]`; the ID-filter case already passed. After the view change:

```text
pnpm test:integration -- src/db/activity-origin.integration.test.ts src/db/apple-health-workout-revisions.integration.test.ts src/db/provider-activity-absence.integration.test.ts src/db/activity-field-priority.integration.test.ts src/db/migrate.integration.test.ts packages/server/src/repositories/climbing-activity-log-entry-repository.integration.test.ts --retry 0
Test Files 6 passed (6)
Tests 118 passed (118)

pnpm test --run
Test Files 1323 passed | 2 skipped (1325)
Tests 20439 passed | 19 skipped (20458)
```

Root, server, and web TypeScript checks exited zero. `pnpm lint:sandbox`,
`pnpm spellcheck`, SQLFluff on the canonical view and migration, migration
policy, and `pnpm lint:analytics-sql` also exited zero.

The broader cross-store command failed before its assertions, both initially
and when rerun in isolation:

```text
pnpm test:integration -- packages/server/src/repositories/activity-visibility-consistency.integration.test.ts --retry 0
2026-10-24T03:29:56.598Z ClickHouseError: (total) memory limit exceeded: would use 1.22 GiB, current RSS: 1.16 GiB, maximum: 1.22 GiB.
ClickHouse test command failed: INSERT INTO analytics_test_<isolated-id>.v_activity WITH legacy AS (...)
Test Files 1 failed (1)
Tests 5 skipped (5)
```

`pnpm analytics:build` initially failed with `Database ingest does not exist`.
The documented `pnpm setup-db` initialized this fresh workspace (161 PostgreSQL
and 104 ClickHouse migrations), after which the unchanged build passed:

```text
pnpm analytics:build
PASS=45 WARN=0 ERROR=0 SKIP=0
```

The [testing guide](../testing.md#integration-dependencies) explains the local
service prerequisites. Hosted cross-store results are available in the
[implementation CI run](https://github.com/Asherlc/dofek/actions/runs/40059234752).
