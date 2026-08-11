# ClickHouse Analytics Models

This directory is a dbt project. Files under `analytics/models/` are not imported by
TypeScript directly; dbt discovers them by path and runs them as models.

The call sites are:

- `pnpm analytics:build` for local/manual runs.
- `entrypoint.sh` `migrate`, `sync`, `worker`, and `analytics` modes, which
  build the ordered activity and sleep/dashboard model groups with one dbt
  thread.
- `entrypoint.sh` `analytics-worker` mode, which delegates the scheduled build
  loop to `scripts/run-analytics-worker.ts`. The worker exposes loopback
  `/readyz` state for the current step, last failure, and last successful
  cycle. A failed first cycle is unhealthy immediately; after a prior success,
  health becomes unavailable when that success is older than the configured
  build interval plus retry delay. Production keeps the bounded retry delay as
  a recovery path, while Docker health reflects refresh progress independently.
  Docker documents that healthcheck command exit status determines container
  health: <https://docs.docker.com/reference/dockerfile/#healthcheck>.

Model dependencies are declared with dbt `ref()` calls. `sensor_scalar_sample`
stages scalar metric samples, `deduped_sensor` reads `sensor_scalar_sample`, and
`activity_vo2max_estimate` reads `deduped_sensor` to keep the expensive VO2 max
activity/sample joins out of web/API requests. `deduped_activities` materializes
the activity overlap graph once, and `deduped_activity_members` exposes canonical
activity/member aliases for downstream models. `activity_sensor_sample` and
`activity_location_sample` are bounded microbatch intermediates over sample
time. `body_measurement` incrementally rebuilds only users whose body samples
or priority inputs changed, and `analytics.v_body_measurement` is a thin
active-row view over that dbt-owned canonical table. Insert-triggered
materialized views reduce provider changes to compact `(user_id, provider_id)`
arrival markers; `provider_change_watermark` reads only that compact state.
`provider_metric_stream_daily` then recomputes at most 32 dirty
`(user_id, provider_id, recorded_date)` keys per build from exact latest metric
state, including replacements, tombstones, resurrection, and late arrivals.
`provider_stats` sums those daily rows and keeps a provider dirty while any day
marker is newer than its daily row, so provider inventory work cannot publish a
partial count. The daily model's selected-day raw scan prefers the covering
`by_provider_current_state_recorded_at` projection and retains tuple-valued
`argMax` resolution as the correctness contract. ClickHouse projections are
optimizer support structures maintained for new inserts:
<https://clickhouse.com/docs/data-modeling/projections>. A separate insert-triggered view
reduces heart-rate arrivals to user/day markers. `sleep_heart_rate_window`
uses those markers to process at most 32 exact sleep windows, including
processed-empty and lifecycle rows, before `sleep_heart_rate_sample` reads
canonical deduped samples only for the selected sleep keys. ClickHouse
documents that incremental materialized views process newly inserted blocks
and shift repeated computation from query time to insert time:
<https://clickhouse.com/docs/materialized-view/incremental-materialized-view>.
dbt documents incremental models as
transforming only the rows selected by the model's incremental filter:
<https://docs.getdbt.com/docs/build/incremental-models>.
`resting_heart_rate_sleep_window` aggregates the
sleep sample intermediary, while `activity_sensor_summary_rows` and
`activity_location_summary_rows` aggregate the activity sample intermediaries
before `activity_stream_points`, `activity_heart_rate_zones`, and
`activity_summary_rows` join or aggregate those compact per-activity samples.
`activity_sensor_sample` expands each activity into its inclusive UTC calendar
dates and joins samples on `(user_id, recorded_date)` before applying the exact
activity timestamp bounds. This preserves overlapping and cross-midnight
activity membership without generating cross-day sample/activity candidates;
ClickHouse recommends reducing the volume entering a join:
<https://clickhouse.com/blog/common-getting-started-issues-with-clickhouse#joins>.
`activity_sensor_summary_rows` enables ClickHouse materialized CTE execution
for its reused dirty-key, latest-sample, and cumulative-power stages so each
stage is evaluated once per build instead of being inlined into every aggregate
branch. ClickHouse introduced materialized CTEs for exactly this shared-result
reuse and requires `enable_materialized_cte`:
<https://clickhouse.com/blog/clickhouse-release-26-03>.
The serving-facing `analytics.activity_summary` object is a thin ClickHouse view
over `analytics.activity_summary_rows FINAL`; the expensive activity/sample
joins belong in incremental dbt models, not in web/API requests. Complex
offline ClickHouse models can set dbt `query_settings` locally and use
`max_threads=1` so offline builds do not compete with request traffic.
`hiking_activity` materializes the per-activity hiking/walking/trail-running
fields used by the hiking training page so its grade-adjusted pace, elevation,
and route-comparison procedures do not repeatedly scan the broad activity
summary view at request time.
`cycling_activity` materializes the per-ride fields used by cycling activity
cards, variability, aerobic-efficiency, and ascent charts. `daily_cycling`
groups the activity-level inputs needed by the cycling performance contract so
fitness, fatigue, form, threshold-power trend, and power summaries do not fan
out across request-time sensor queries. Both models use dbt incremental
materializations and explicit row lifecycle handling; see dbt's official
[incremental model documentation](https://docs.getdbt.com/docs/build/incremental-models).
For loading-performance work, follow
[`docs/performance/loading-performance-runbook.md`](../docs/performance/loading-performance-runbook.md)
before adding or changing analytics models. A new route-facing model is allowed
only after fresh Axiom or recorded incident evidence names a request-time
ClickHouse bottleneck, and the model should materialize the domain/grain needed
by that route instead of becoming a generic `_summary`, `_aggregate`, or
`_read_model` table.
`daily_recovery`, `daily_strain`, `daily_sleep`, and
`weekly_healthspan` are the named dashboard serving models. They build on compact ingredient
models such as `daily_recovery_inputs`, `daily_activity_load`, and
`healthspan_activity_zone_minutes` so dashboard, recovery, stress,
sleep-need, and healthspan routes do not recompute broad windows at request
time. `provider_stats` materializes provider record counts for the sync
provider inventory route so the API does not compute all-provider counts on
request.
`daily_recovery_inputs`, `daily_activity_load`, and
`healthspan_activity_zone_minutes` are compact serving models over daily
metrics, sleep, activity summaries, and bounded activity samples for dashboard,
recovery, stress, sleep-need, and healthspan routes.

Production `DBT_SAFE_MODELS` currently selects `sensor_scalar_sample`,
`deduped_sensor`, `activity_source_records`, `activity_duplicate_matches`,
`activity_duplicate_groups`, `deduped_activities`, `deduped_activity_members`,
`provider_metric_stream_daily`, `provider_change_watermark`, `sleep_heart_rate_window`,
`sleep_heart_rate_sample`, `resting_heart_rate_sleep_window`,
`daily_sleep`, `daily_recovery_inputs`, `daily_recovery`, `activity_sensor_sample`, `activity_location_sample`,
`activity_sensor_summary_rows`, `activity_location_summary_rows`,
`activity_stream_points`, `activity_heart_rate_zones`, `activity_summary_rows`,
`hiking_activity`, `body_measurement`, `activity_vo2max_estimate`,
`activity_aerobic_efficiency`, `activity_polarization_zones`,
`activity_power_curve`, `cycling_activity`, `daily_cycling`, `provider_stats`,
`daily_activity_load`, `daily_strain`, `healthspan_activity_zone_minutes`,
and `weekly_healthspan`. Activity sample-time models use dbt's `microbatch`
incremental strategy with daily batches and short lookbacks so ClickHouse
processes bounded windows instead of one large activity/window query. Activity
stream staging uses the `metric_stream_freshness` source alias and batches by
`_peerdb_synced_at`; downstream activity sample membership models
(`activity_sensor_sample` and `activity_location_sample`) use upstream source
freshness as their microbatch event time so late provider stream syncs and
late activity dedupe changes can reattach older workout samples outside the
normal recorded-time lookback. `deduped_activities` and `deduped_activity_members`
materialize canonical activity identity once, but incremental runs only rebuild
activity windows affected by new raw activity changes; provider/device priority
changes intentionally rebuild the full activity dedupe graph because they can
change canonical selection globally. The final resting heart rate, activity
aggregate, and activity summary models use dirty keys from those intermediates
and `max_threads=1` to keep the offline aggregate work out of web/API requests.
`activity_vo2max_estimate` also uses dirty activity/user keys and
`max_threads=1`; it materializes reusable per-activity VO2 max estimates, not
final API responses. `daily_recovery`, `daily_strain`,
`daily_sleep`, and `weekly_healthspan` are the final route-facing dashboard models; the
lower-level recovery, activity-load, and zone-minute models remain internal
ingredients. `provider_stats` remains the route-facing provider inventory model
so request paths do not recompute provider counts from raw source tables.

## Microbatch start bounds and historical backfills

The production analytics runner and `pnpm analytics:build` resolve one lower
bound for scalar sensor models and one for location models from the earliest
relevant `ingest.metric_stream.ingested_at` value. When a source group is
empty, its bound is the current UTC day, so a fresh database schedules only the
current daily batch. Direct dbt invocations have the same current-day fallback
in the four model configs. dbt documents `begin` as the initial/full-refresh
starting point and notes that it does not discover the earliest event timestamp
from the data automatically:
<https://docs.getdbt.com/reference/resource-configs/begin>.

Historical replay must be an explicit, bounded operator action. Supply both
`--event-time-start` and `--event-time-end`, select only the required
microbatch models, and monitor ClickHouse capacity while the run is active:

```sh
pnpm tsx scripts/with-env.ts -- env \
  DBT_TARGET=dev \
  UV_PROJECT_ENVIRONMENT=../.venv-analytics \
  uv run --project analytics dbt run \
  --project-dir analytics \
  --profiles-dir analytics \
  --threads 1 \
  --event-time-start "2025-01-01" \
  --event-time-end "2025-02-01" \
  --select "sensor_scalar_sample deduped_sensor activity_sensor_sample activity_location_sample"
```

For a microbatch replay, choose the smallest interval that contains the data
being repaired and advance long backfills in separately observed windows. This
bounded replay guidance does not define the retention boundary for the full
`activity_summary_rows` rebuild below. dbt's microbatch documentation defines
these flags as the supported historical backfill controls and recommends
providing both bounds:
<https://docs.getdbt.com/docs/build/incremental-microbatch#backfills>.

When the semantics of an `activity_sensor_summary_rows` or
`activity_summary_rows` field change, existing append-incremental rows are not
rewritten by the model change alone. Run an explicit, monitored rebuild of the
upstream sensor summary, location summary, and downstream activity summary, in
dependency order, with an `initial_lookback_days` that covers every retained
activity that should remain in all three tables. dbt recommends rebuilding an
incremental model when its logic changes because historical transformations
remain in the target table, using `--full-refresh` for the rebuild:
<https://docs.getdbt.com/docs/build/incremental-models#how-do-i-rebuild-an-incremental-model>.

Before starting, query the oldest active activity in ClickHouse and use the
larger of the returned age and the configured retention window as the minimum
lookback. The query includes a one-day safety margin; do not silently accept
the model default of 120 days:

```sql
SELECT
    count() AS active_activity_count,
    min(started_at) AS oldest_active_activity,
    dateDiff('day', toDate(min(started_at)), toDate(now('UTC'))) + 1
        AS required_lookback_days
FROM postgres_fitness.activity FINAL
WHERE _peerdb_is_deleted = 0
    AND provider_absent_at IS NULL
    AND deleted_at IS NULL;
```

Record the chosen lookback and the preflight row count/oldest date with the
maintenance change. The `3650` value below is an example only; replace it with
the verified retention-covering value when it is smaller or larger. Do not put
this full refresh in a deploy, scheduled worker, request path, or test:

The command below uses the local `dev` dbt target. For a production repair,
run the same arguments from the production analytics environment with its
`DBT_TARGET=prod` credentials; never point a local target at production by
accident.

```sh
pnpm tsx scripts/with-env.ts -- env \
  DBT_TARGET=dev \
  UV_PROJECT_ENVIRONMENT=../.venv-analytics \
  uv run --project analytics dbt build \
  --project-dir analytics \
  --profiles-dir analytics \
  --full-refresh \
  --vars '{"initial_lookback_days": 3650}' \
  --select activity_sensor_summary_rows activity_location_summary_rows activity_summary_rows
```

The lookback is a full-refresh retention boundary, not just the scope of the
semantic change. A full refresh drops rows older than
`initial_lookback_days`, and later incremental runs will not re-add those
unchanged activities. The three selected models must all report `PASS` with no
warnings or errors before the operator treats the rebuild as complete.

The `cycling_activity` modality normalization requires the same explicit
operator action for existing append-incremental rows. Before the repair, record
the retained rows that still contain an empty modality:

```sql
SELECT
    count() AS active_cycling_rows,
    countIf(modality = '') AS empty_modality_rows,
    min(started_at) AS oldest_active_activity
FROM analytics.cycling_activity FINAL
WHERE is_deleted = 0;
```

Run the model-only full refresh from the production analytics environment after
reviewing that preflight count; do not put this command in deploys, the
scheduled worker, request paths, or tests:

```sh
pnpm tsx scripts/with-env.ts -- env \
  DBT_TARGET=prod \
  UV_PROJECT_ENVIRONMENT=../.venv-analytics \
  uv run --project analytics dbt build \
  --project-dir analytics \
  --profiles-dir analytics \
  --full-refresh \
  --select cycling_activity
```

After the build succeeds, repeat the query and verify `empty_modality_rows = 0`.
Record both counts and the model run result with the maintenance change. This
bounded, operator-invoked rebuild follows dbt's guidance for rewriting existing
incremental rows after a model semantic change:
<https://docs.getdbt.com/docs/build/incremental-models#how-do-i-rebuild-an-incremental-model>.

While the build is active, watch the analytics-worker/dbt output and the
currently running ClickHouse queries. `system.processes` exposes the active
query's elapsed time, rows/bytes read, and memory usage:
<https://clickhouse.com/docs/operations/system-tables/processes>.

```sql
SELECT
    query_id,
    elapsed,
    read_rows,
    read_bytes,
    memory_usage,
    query
FROM system.processes
WHERE query ILIKE '%activity_sensor_summary_rows%'
    OR query ILIKE '%activity_location_summary_rows%'
    OR query ILIKE '%activity_summary_rows%'
ORDER BY elapsed DESC;
```

After the build, inspect completed and failed statements in
`system.query_log`, then compare the post-build counts and oldest date with the
preflight evidence. `system.query_log` records finished and failed query
metadata:
<https://clickhouse.com/docs/operations/system-tables/query_log>.

```sql
SELECT
    count() AS active_summary_rows,
    min(started_at) AS oldest_summary_activity,
    countIf(elevation_loss_m IS NULL) AS unavailable_elevation_loss_rows,
    countIf(elevation_loss_m = 0) AS measured_zero_elevation_loss_rows
FROM analytics.activity_summary_rows FINAL
WHERE is_deleted = 0;
```

If ClickHouse memory/CPU pressure, a failed model, or a stale worker health
signal appears, stop and capture the first fatal dbt/ClickHouse query before
rerunning the bounded procedure. Do not compensate with a larger timeout,
unbounded lookback, or silent retry. Once the three-model build and semantic
checks pass, continue with the normal cache-warm step below.

After both safe dbt build groups succeed, `scripts/warm-query-cache.ts` replays
every live query key registered in Redis with its original user, timezone,
procedure path, and input. Refresh mode bypasses the old value and overwrites it
only after a successful procedure call, so an individual refresh failure does
not destroy the last successful cached response. Redis key expiry remains the
source of truth for which registered queries are live; see Redis's official
[expiration documentation](https://redis.io/docs/latest/commands/expire/).

Append-incremental models backed by `ReplacingMergeTree(refresh_version)` must
handle row lifecycle explicitly. A model that can lose a previously emitted row
at its `ORDER BY` grain must emit a newer tombstone row with `is_deleted = 1`,
and serving queries must read `FINAL` plus `is_deleted = 0`. Downstream dbt models
that read another append table must first choose the latest row for the upstream
grain with `ORDER BY refresh_version DESC LIMIT 1 BY ...`, then filter
`is_deleted = 0`; filtering before selecting the latest row can preserve stale
active rows until ClickHouse background merges finish. This follows ClickHouse's
documented `ReplacingMergeTree` behavior, where replacement occurs during merges
and `FINAL` forces query-time replacement:
<https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree>.
