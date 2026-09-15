# Activity Sensor Replay Recovery Design

**Date:** 2026-09-15

**Status:** Approved and implemented; production validation pending

**Scope:** ClickHouse/dbt activity sensor pipeline and bounded production recovery

## Incident and root cause

Activity records after September 9 are now present in the serving read models, but the
analytics worker cannot complete a healthy cycle. Its September 13
`activity_sensor_sample` microbatch repeatedly exceeds ClickHouse's memory limit, which
keeps downstream activity sensor analytics from advancing reliably.

The root cause is the combination of two behaviors:

1. `activity_sensor_sample` constructs high-cardinality `DISTINCT` membership state and
   reuses it across active-row and tombstone branches. ClickHouse evaluates that state
   independently under the `UNION ALL` branches, and the September 13 refresh exhausts
   memory in `DistinctTransform`.
2. All three scalar sensor models replay three prior freshness days on every cycle.
   September 13 contains a large historical provider refresh spanning years of recorded
   samples, so a historical recovery batch is being treated as recurring steady-state
   work.

Production evidence captured during diagnosis:

- The deployed compact-membership query failed at 8.70 GiB peak memory after 34.8 seconds.
- A full-materialized variant failed at 9.10 GiB peak memory after 45.7 seconds.
- A narrow hybrid still failed in `DistinctTransform` at 5.81 GiB tracked memory.
- A read-only current-state prototype removed `DISTINCT`, stayed at 3.51 GiB peak memory,
  and read 156.5 million rows before its 120-second diagnostic limit. It proved the query
  shape is memory-safe but also proved that recurring historical replay remains too much
  steady-state work.
- `analytics.activity_sensor_sample` currently has about 108.9 million physical rows.
  Its `ReplacingMergeTree` target must resolve those versions when reconciling stale rows.

ClickHouse background merges do not guarantee current-state results for
`ReplacingMergeTree`; query-time `FINAL` is the correctness mechanism while multiple
physical versions remain ([ClickHouse guidance](https://clickhouse.com/resources/engineering/clickhouse-optimize-table-final)).

## Goals

- Preserve every logical active activity/sample association and required tombstone.
- Make recurring analytics cycles exclude the September 13 historical refresh.
- Complete the September 13 repair once as an explicit, bounded operator action.
- Keep the worker's existing memory, timeout, retry, and health budgets unchanged.
- Validate the fix against real ClickHouse semantics before deployment.

## Non-goals

- No UI or API behavior changes.
- No new ClickHouse table, projection, index, migration, or duplicate source of truth.
- No larger memory limit, timeout, retry count, startup delay, or health grace period.
- No hour-sliced replay: `refreshed_at` is not in the source or target sorting key, so
  slicing would repeat broad scans and mutations.
- No permanent incident flag or special September 13 branch in steady-state code.

## Steady-state query design

`activity_sensor_sample` will operate on logical current state:

1. Enable ClickHouse's query-level `final` setting for the model. This resolves one
   current row per `ReplacingMergeTree` sorting key for `deduped_sensor`,
   `deduped_activities`, and the existing target without relying on asynchronous merges.
2. Stream the filtered `deduped_sensor` batch directly into the activity-day join.
   `activity_days` remains the bounded `(user_id, recorded_date)` join input, followed by
   the existing inclusive activity timestamp and member-provenance predicates.
3. Remove `batch_sample_keys`, `activity_sample_membership`, their `DISTINCT` operators,
   and `enable_materialized_cte`. Once the source and activity tables are read as logical
   current state, those intermediates do not provide additional correctness.
4. For incremental reconciliation, stream current target rows and use an `INNER ANY JOIN`
   to the logically unique batch source key `(user_id, channel, recorded_at)`. Emit a
   tombstone when the latest source is deleted, the activity group is deleted, the sample
   falls outside the current activity window, or its non-null source activity is no longer
   a member of the group.

The `ANY` join is exact here because `deduped_sensor`'s logical grain and
`ReplacingMergeTree` sorting key are `(user_id, channel, recorded_date, recorded_at)`,
where `recorded_date` is derived from `recorded_at`. `FINAL` therefore presents at most one
source row for each join key. An ambient sample with null `source_activity_id` remains
eligible for every overlapping current group; a linked sample remains eligible only for
groups containing that member.

## Freshness lookback design

Set `lookback=1` on:

- `sensor_scalar_sample`
- `deduped_sensor`
- `activity_sensor_sample`

With daily microbatches, this preserves the previous and current freshness-day batches
for normal overlap/retry behavior. The models batch on ingestion/source freshness, not the
historical `recorded_at` date, so newly arriving historical samples enter a current
freshness batch. Repairs or replays whose freshness timestamp is older than that window
remain explicit bounded operator actions. dbt documents `lookback` as reprocessing prior
microbatches and `--event-time-start`/`--event-time-end` as the supported bounded backfill
interface ([dbt microbatch documentation](https://docs.getdbt.com/docs/build/incremental-microbatch#backfills)).

## Tests and validation

Executable ClickHouse integration tests must demonstrate:

- An activity/sample join produces one join result per logical association rather than a
  second membership-to-payload join.
- Two unmerged physical versions of one `deduped_sensor` key produce one current activity
  sample row.
- A source member moving between activity groups emits the new active association and a
  tombstone for the old association.
- Deleted sources, deleted groups, window changes, overlapping activities, linked samples,
  ambient samples, and cross-midnight activities retain their existing behavior.

Repository validation consists of the focused ClickHouse integration suite,
`pnpm lint:analytics-sql`, `pnpm lint:analytics-policy`, affected unit tests, type checking,
and the repository's changed-test gate. No test may merely assert that old SQL text is
absent.

## Deployment and bounded recovery

1. Merge and deploy the tested model/configuration change through the normal workflow.
2. Verify the first recurring worker cycle processes only the previous and current
   freshness days and completes every selected model without code 241.
3. During the worker's normal idle interval, run one production dbt microbatch for
   `activity_sensor_sample` bounded to `[2026-09-13, 2026-09-14)`, with one dbt thread.
   Do not rebuild already-successful upstream September 13 batches.
4. Monitor `system.processes` and `system.query_log`; stop on memory pressure or a fatal
   query rather than increasing limits.
5. Verify the bounded batch completes, its active/tombstone state agrees with the current
   source and activity groups, and downstream activity summaries advance on the next
   worker cycle.
6. Require two consecutive complete worker cycles, current activity/sensor maxima, and UI
   confirmation before closing the incident.

The historical run is an operator action, not a scheduled path. This follows the existing
analytics runbook and dbt's explicit bounded-backfill interface.

## Risks and mitigations

- **Shorter automatic replay window:** A source correction that retains an old freshness
  timestamp may require an explicit bounded backfill. The runbook already requires explicit
  bounds for historical repair; ordinary late arrivals receive current ingestion freshness.
- **`FINAL` scan cost:** The bounded September 13 run remains slower than a normal batch
  because the target has many physical versions. The read-only benchmark established a
  stable 3.51 GiB memory profile, and the operation runs once during an idle interval.
- **Incorrect stale-row predicate:** Real-engine tests cover deletions, membership moves,
  windows, physical versions, and overlapping activities before production execution.
- **Concurrent production load:** The operator waits for the worker's normal sleep window
  and does not change service scale or health settings.

## Acceptance criteria

- Focused integration tests fail against the old query and pass against the new query.
- CI and deploy workflows complete without skipped or relaxed checks.
- The recurring worker performs only two daily freshness batches per sensor microbatch
  model and completes without OOM.
- The bounded September 13 `activity_sensor_sample` run completes without a memory or
  timeout override.
- Two consecutive production worker cycles complete successfully, downstream activity
  analytics are current, and activities after September 9 remain visible in the UI.
