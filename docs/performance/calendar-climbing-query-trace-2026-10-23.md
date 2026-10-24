# Calendar and climbing query trace — October 23, 2026

## Incident

At 03:31–03:34 UTC on October 24 (20:31–20:34 Pacific on October 23),
production release `4179f298c4a0fe176025055fcff002915cbb1a98` reported
[session](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-5K),
[billing](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-71), and
[climbing](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-72)
connection-acquisition timeouts. Mobile received
[HTTP 524 responses](https://east-bay-software.sentry.io/issues/DOFEK-MOBILE-1G).
Swarm logs showed calendar requests taking 120–152 seconds; Postgres logged
activity/climbing queries taking 81–95 seconds. One unhealthy web task was
replaced. Both replicas subsequently ran, while SQL remained slow.

## Execution evidence

Source-generated queries were measured through the existing production
Postgres container using `psql -U health -d health`, read-only transactions,
`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON)`, a 15-second
statement deadline, and a one-second lock deadline. These deadlines bounded
operator diagnostics; no application or service setting changed.
PostgreSQL documents that [`EXPLAIN ANALYZE` executes the statement](https://www.postgresql.org/docs/18/using-explain.html#USING-EXPLAIN-ANALYZE).
The single-ID control used a five-second deadline. Queries ran separately.

| Query | Planning | Execution | Result rows | Full-raw origin aggregation |
| --- | ---: | ---: | ---: | ---: |
| Single known activity ID | 11.920 ms | 105.590 ms | 1 | Selected group only |
| Calendar visibility, October 1–November 1 | 13.387 ms | 13,922.904 ms | 52 | 13,781.371 ms, 1,762 groups |
| Climbing grade progression, previous 90 days | 25.993 ms | 12,198.391 ms | 142 | 12,013.755 ms, 1,747 groups |

The calendar aggregate consumed 3,672 user activity rows. Its child scan took
0.956 ms and its in-memory sort took 5.396 ms. The aggregate constructed
`JSONB_AGG(JSONB_BUILD_OBJECT(..., 'raw', ranked.raw) ORDER BY ranked.id)`
before date filtering rejected 1,705 joined groups and retained 52. All 13,255
shared block reads appeared at this aggregate; there was no temporary spill.
The plan does not separately time payload retrieval or decompression.

The climbing measurement reproduced the same bottleneck with warm buffers:
its raw aggregate recorded 16,309 shared hits and zero shared reads. Its
climbing-specific `rock_logs` CTE took only 73.285 ms for 247 rows. The
calendar's recursive origin resolver ran for the selected 52 groups, taking
about 10.5 ms in total; it was not the expensive operation.

A separate size-only query over active, undeleted raw activities counted
3,922 rows and 104,083,687 stored raw bytes. Ride with GPS accounted for
96.83 MiB across 873 records. This measurement selected sizes and provider
labels, not payload contents. PostgreSQL documents
[`pg_column_size`](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-ADMIN-DBSIZE)
as reporting a value's storage size, including compression where applicable.

## Source paths

- [`ActivityOverviewRepository.getActivityOverview`](../../packages/server/src/repositories/activity-overview-repository.ts)
  requests combined-period and current-period visible IDs sequentially before
  its ClickHouse aggregates. Both expand `fitness.v_activity`.
- [`ActivitiesCalendarRepository`](../../packages/server/src/repositories/activities-calendar-repository.ts)
  checks returned calendar IDs through
  [`ActivityVisibilityRepository`](../../packages/server/src/repositories/activity-visibility-repository.ts),
  which also reads the shared view.
- [`ClimbingRepository`](../../packages/server/src/repositories/climbing-repository.ts)
  joins activity-bound logs through that same view. The mobile training
  service separately requests progression, volume, and session summaries.
- [`origin_group_members`](../../drizzle/_views/01_v_activity.sql)
  groups complete raw member payloads before the view joins origins and
  callers apply local-date filters. The live plan confirms this work survives
  ID-only selection.

## Read-only comparison and proposed correction

The complete transitive origin input uses only four raw fields:
`sourceBundle` and `device_name` in the
[origin resolver](../../drizzle/_views/00_activity_origin.sql), plus `platform`
and `deviceType` in its
[copy-identity helper](../../drizzle/_views/00_activity_copy_identity.sql).
The recursive origin algorithm consumes the derived member/edge values.

A comparison inlined the canonical view into the same SELECT and changed
only the origin member's nested raw object to
`JSONB_BUILD_OBJECT('sourceBundle', raw -> 'sourceBundle', 'device_name', raw -> 'device_name', 'platform', raw -> 'platform', 'deviceType', raw -> 'deviceType')`.
It performed no schema or data writes.

| Query | Original execution | Narrow-input execution | Result rows | Narrow-input aggregation |
| --- | ---: | ---: | ---: | ---: |
| Calendar visibility | 13,922.904 ms | 1,243.480 ms | 52 | 1,135.000 ms |
| Climbing progression | 12,198.391 ms | 1,194.436 ms | 142 | 1,049.686 ms |

This isolates full-payload JSON construction as the measured bottleneck and
supports narrowing the resolver input as the smallest correction to assess.
The proposed scope preserves stored raw data and the public activity raw
projection. It retains historical grouping and metadata extraction, whose
remaining cost is visible above.

These are individual operator measurements, not a concurrent benchmark.
Matching result counts does not establish complete result parity. An
implementation still needs real-Postgres regression coverage for all five
origin outputs, including conflicting, missing, and JSON-null metadata, plus
the existing visibility, entitlement, deduplication, and climbing fixtures.
No implementation, migration, deployment, or Sentry status update was made.

Historical pool occupancy was not recovered: the later idle snapshot cannot
prove saturation during the incident. Correlate the existing
`postgres.pool.connections.total`, `postgres.pool.connections.idle`, and
`postgres.pool.requests.waiting`
[metrics](../../src/db/pool-metrics.ts) with slow SQL next time. The bounded
measurements prove the current query bottleneck; they do not quantify the
additional contention that stretched incident queries to 81–95 seconds.

## Approved implementation and local validation

The approved correction narrows only the nested origin input in the
[canonical view](../../drizzle/_views/01_v_activity.sql).
[Migration 0160](../../drizzle/0160_bound_activity_origin_input.sql) installs
the identical view through the normal forward migration path. Stored payloads,
public raw data, the resolver algorithm, and activity visibility remain intact.

The [real-Postgres regression](../../src/db/activity-origin.integration.test.ts)
observes the resolver's actual input while delegating to its real implementation.
A 64 KiB vendor fixture first failed with 65,752 input bytes against a generous
1,024-byte bound, before production SQL changed. The same test passes after
the correction and positively verifies the complete public payload and all
five origin outputs. Ten view cases cover the retained metadata fields,
conflicts, and missing/SQL-null/JSON-null evidence with literal expectations.

Local validation completed:

- The four origin, origin read-model, climbing-log-entry, and migration suites
  passed all 107 tests, including 42 origin tests.
- `pnpm migrate` applied the migration through the actual local migration path,
  separately from test helpers that replay canonical views.
- Full lint, root/server/web typechecks, new-migration SQLFluff, explicit
  migration policy, and canonical/migration byte comparison passed.
- The full unit/mobile run passed 20,439 tests, with 19 skipped; all 45 dbt
  models built successfully on empty local sources, with no errors or skips.

The [visibility consistency suite](../../packages/server/src/repositories/activity-visibility-consistency.integration.test.ts)
remains unverified: both the broader run and an isolated diagnostic run failed
its ClickHouse fixture setup before its five tests executed. Query
`43c2e392-5ae1-42df-9d8c-bfeca56a29de` logged Code 241 at 04:03:55 UTC:
`(total) memory limit exceeded ... current RSS: 1.25 GiB, maximum: 1.25 GiB`.
Its recorded query allocation was 799,650,792 bytes. This was an
`INSERT INTO analytics_test_*.v_activity` fixture query; its cause beyond the
observed memory ceiling remains unresolved. No limit or query setting was
changed to pass it.

Production deployment and post-deploy measurements remain outstanding.
No retry, timeout, memory limit, or optimizer adjustment accompanies the fix.
For future investigations, reuse bounded execution plans and the real-function
input regression pattern; add migration-only verification and changed-file
policy coverage to the testing guide, since canonical replay and HEAD-based
diffs can otherwise conceal an omitted migration.
