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
`activity_vo2max_estimate` reads group-keyed `activity_sensor_sample` to keep the
expensive VO2 max activity/sample joins out of web/API requests. `deduped_activities` materializes
persisted PostgreSQL activity groups, and `deduped_activity_members` exposes canonical
activity/member aliases for downstream models. `activity_duplicate_matches`
retains overlap evidence for integrity diagnostics; `activity_duplicate_groups`
projects `activity_source_records.group_id` without deriving identity from those
edges. `activity_effort_identity` projects current evidence at
`(user_id, source_activity_id, kind, namespace, normalized_value, source_field)`
grain: it joins every current `activity_source_records` member to
`deduped_activity_members`, so a representative never hides a contributing
source's route, workout/template/class, segment, standardized-test, or weak
name evidence. Its explicit v1 raw-field map is `pelotonClassId`, `templateId`,
`workoutTemplateId`, and `classId` for provider workouts; `routeId` and
`courseId` for provider routes; `segmentId` for segments; and
`standardizedTestId` and `testId` for standardized tests. `external_id` stays
provider-instance provenance and is never emitted as a reusable identity.
Names are emitted only as `activity_name` with `weak_similarity`. Evidence is a
bounded map of the classified raw field/value and source-record identifiers.
The append-incremental model uses source/member sync timestamps plus canonical
membership changes for invalidation; routine upstream `refreshed_at` changes do
not dirty identity rows. Explicit user/activity refresh scopes include current
and prior source members. It writes a `ReplacingMergeTree` tombstone when an emitted
identity disappears or its source is no longer current. This follows dbt's
[incremental-model lifecycle](https://docs.getdbt.com/docs/build/incremental-models)
and preserves the structured source evidence consumed by MCP tools under the
[MCP specification](https://modelcontextprotocol.io/specification/2026-07-28).
The [activity model](models/read_models/deduped_activities.sql) uses the
group UUID as `activity_id` and the chosen member UUID as `primary_activity_id`.
Representative selection orders deduped sensor presence, sample count, elevation
presence, specific canonical type, provider-type refinement, provider priority,
then member UUID. Samples count toward a member only when the winning sample's
nullable `source_activity_id` equals that member's UUID and its timestamp lies
within the inclusive normalized window; overlapping same-provider members do not
share payload credit. The group's served sample union accepts unlinked ambient
samples and samples linked to any current member, never only the representative.
The display name follows the selected representative, including a null name;
notes and raw provenance retain their existing fallbacks.
Incremental `deduped_activities` builds compare the complete current group row
with the latest target state. Target-equivalent rows are not appended and keep
their lifecycle version; membership, representative, display, ranking, sensor,
absence, or other served-content transitions append a strictly newer version.
That version is the causal watermark used by downstream activity payload models,
while [`ReplacingMergeTree`](https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/replacingmergetree)
uses it to retain the latest state for each activity group. Full refreshes still
emit the complete current state.
Location payload and
relational strength sets are not available to this upstream scalar projection.
Missing persisted membership fails the build. Existing deployments must apply
[migration 0079](../src/db/clickhouse-migrations/0079_stable_activity_group_id.ts)
and deliver PostgreSQL membership through CDC before refreshing these models;
the migration only adds nullable columns, using ClickHouse's
[ADD COLUMN](https://clickhouse.com/docs/reference/statements/alter/column#add-column)
without inventing membership for existing rows.
[Migration 0080](../src/db/clickhouse-migrations/0080_sensor_source_activity_id.ts)
adds nullable source-activity columns to existing scalar and deduped sensor tables.
Reprocess the required sensor history through `sensor_scalar_sample` and then
`deduped_sensor` before rebuilding activity representatives; old projected samples
remain unlinked until that refresh and must not be credited by provider/time inference.
The [staging model](models/staging/sensor_scalar_sample.sql) preserves the latest
nullable link, and the [deduplication model](models/read_models/deduped_sensor.sql)
keeps it with the winning sample using tuple-valued
[argMin](https://clickhouse.com/docs/sql-reference/aggregate-functions/reference/argmin).
`activity_sensor_sample` is a bounded microbatch intermediary over source
refresh time. `activity_location_sample` is an append-incremental current-state
reconciliation: changed activity, membership, and scoped repair keys identify
affected stable groups, then provider selection reads each affected group's
complete current tracks before replacing or tombstoning route points. `body_measurement` incrementally rebuilds only users whose body samples
or priority inputs changed, and `analytics.v_body_measurement` is a thin
active-row view over that dbt-owned canonical table. Insert-triggered
materialized views reduce provider changes to compact `(user_id, provider_id)`
arrival markers; `provider_change_watermark` reads only that compact state.
Existing deployments must apply
[migration 0083](../src/db/clickhouse-migrations/0083_activity_location_source_refresh.ts)
before the next incremental `activity_location_sample` build. It adds the
model's `source_refreshed_at` lifecycle watermark to targets created by the
older schema and initializes legacy rows from their existing `refreshed_at`
watermark. The migration is safe when dbt has not created the target yet and
uses ClickHouse's idempotent
[`ADD COLUMN IF NOT EXISTS`](https://clickhouse.com/docs/sql-reference/statements/alter/column#add-column)
operation when the target exists.
[Migration 0084](../src/db/clickhouse-migrations/0084_activity_location_source_refresh_default.ts)
makes that legacy default null-safe because older targets allowed nullable
`refreshed_at` values. `activity_location_sample` compares each stable group's
latest location and lifecycle timestamps with that group's persisted
`source_refreshed_at` watermark. [Migration
0086](../src/db/clickhouse-migrations/0086_activity_location_member_change.ts)
backfills a compact per-member location freshness index once and installs an
incremental materialized view that advances it for new source inserts. The
index retains whether a member has ever had a live location sample so a later
all-deleted history can still emit target tombstones. ClickHouse incremental
materialized views process inserted blocks as they arrive, shifting recurring
aggregation from query time to ingestion time:
<https://clickhouse.com/docs/materialized-view/incremental-materialized-view>.
Its `AggregatingMergeTree` combines the per-member maximum timestamp and live
history flag during background merges:
<https://clickhouse.com/docs/engines/table-engines/mergetree-family/aggregatingmergetree>.
Unscoped builds join this member-cardinality index to current group membership,
select the 250 oldest dirty groups, and only then read complete raw tracks for
those groups; later builds keep selecting dirty groups until the backlog is
empty. Explicit activity repair scopes retain their caller-supplied bounds.
Per-group watermarks make the bounded progression safe: completing a newer
group cannot hide an older group that has not run yet. New groups with no
historical live point are excluded because they have no target state to change;
groups with historical live samples remain eligible so a later all-deleted
source state can write the required tombstones. The one-use raw-track CTE
remains streaming so it is
aggregated without buffering a second full copy; reused bounded key and result
CTEs are materialized. Each raw location version is resolved with one
tuple-valued `argMax`, keeping all fields from the same latest row while
maintaining one aggregate state instead of one state per field. ClickHouse
documents tuple arguments as the way to return associated columns from the row
selected by
[`argMax`](https://clickhouse.com/docs/sql-reference/aggregate-functions/reference/argmax).
`activity_route_identity` follows `activity_location_sample` at canonical
cycling-activity grain. It reads `deduped_activities FINAL`,
`activity_location_sample FINAL`, `activity_effort_identity FINAL`, and the
`altitude` channel of `activity_sensor_sample FINAL`, preserving explicit provider route/course
claims separately from a deterministic, 64-point coordinate-quantized ordered
polyline and its reverse fingerprint. Its route distance, time-gap coverage,
provider/device provenance, and lifecycle watermark refresh only when an
activity, deduplicated location state, altitude evidence, or explicit route evidence changes; a
route whose live geometry disappears emits a `ReplacingMergeTree` tombstone.
Scoped builds resolve `activity_refresh_user_id` and
`activity_refresh_activity_ids` (canonical or member IDs) before reading route
points, and include scoped prior route keys so removed activities can be
tombstoned. Unscoped incremental builds discover dirty keys from activity,
location, altitude, and identity watermarks before aggregating selected geometry. See the
[route model](models/read_models/activity_route_identity.sql) and the shared
[activity scope macros](macros/activity_refresh_scope.sql). The server's
[route matcher](../packages/server/src/repositories/route-equivalence.ts) returns
`left_quality` and `right_quality` on both accepted and rejected complete
comparisons: geometry status, coverage percentage (0–100), and largest gap in
seconds. Missing quality observations remain null; coverage describes the
observed location interval, not the entire activity duration.
The bounded elevation profile is derived from available `altitude` sensor
samples and remains unavailable when those samples do not exist. Geometry is Level B
`strong_inferred` only when the server matcher accepts overlap at least 90%,
both endpoints within 250 m, relative distance difference at most 10%, and
elevation similarity at least 0.85 when both profiles are available. dbt
documents the incremental rebuild contract in its
[incremental model guide](https://docs.getdbt.com/docs/build/incremental-models),
and ClickHouse documents `ReplacingMergeTree` lifecycle replacement in its
[engine reference](https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree).
Its model-local
`enable_materialized_cte` setting prevents those reused intermediates from
being re-evaluated across current-row and tombstone branches; ClickHouse
introduced this explicit single-evaluation behavior in
[version 26.3](https://clickhouse.com/blog/clickhouse-release-26-03).
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
The activity sample, sensor summary, location summary, activity summary, and
VO2 max models use the persisted activity-group UUID as their lifecycle key.
Member and alias UUIDs are accepted only as dirty lookup inputs and resolve to
both the current group and any superseded group row that must be tombstoned.
Scalar channels are unioned from deduplicated samples across every member;
location selects one coherent provider track for the group so overlapping
routes are not combined. Consequently, changing the display representative
does not change the group's heart rate, GPS, elevation, or other populated
summary values. `source_activity_id` remains nullable sample provenance used
to rank payload-bearing representatives and to remove samples whose linked member
leaves the group. A null source stays eligible as ambient sensor data; a non-null
source is eligible for every group that currently contains that member.

The TypeScript bootstrap views use the same persisted group identity contract.
[Migration 0081](../src/db/clickhouse-migrations/0081_stable_activity_read_views.ts)
recreates pre-dbt activity views so an upgraded deployment cannot retain the
older dynamic/minimum-member identity behavior. Apply ClickHouse migrations
before refreshing dbt models.
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

## Cycling power-duration semantics and refresh

`activity_power_curve` computes rolling power against elapsed time, not sample
count. Samples are treated as a left-continuous step function. For samples
`(t_i, P_i)`, segment energy is `P_i * (t_(i+1) - t_i)` and a candidate of
duration `d` is `(E(t + d) - E(t)) / d`. Energy at a fractional endpoint uses
the containing segment, so irregular samples are time-weighted correctly and
do not require a sample exactly at `t + d`. Native zero watts contributes zero
energy; it is never converted to missing. ClickHouse documents the array and
cumulative-array functions used by the model in its
[array-functions reference](https://clickhouse.com/docs/sql-reference/functions/array-functions).

For each activity, the median positive sample interval defines the source
resolution. Durations shorter than that resolution are unavailable. A gap
larger than `max(5 seconds, 2 * median interval)` marks a discontinuity, and no
winning window may cross it. Active rows preserve the winning start offset,
observed sample count, coverage, median interval, largest gap, selected
providers/devices, and direct/estimated/unknown power evidence. Request-time
custom durations use the same semantics over bounded
`analytics.activity_sensor_sample` input.

Per-activity MCP workout metrics intentionally do not add another stored source of truth. The
server pages canonical rows from `cycling_activity`, resolves identity and timezone evidence from
`deduped_activities`, and reads only power, heart-rate, and cadence channels for those selected
activity IDs from `activity_sensor_sample FINAL`. It joins standard-duration evidence from
`activity_power_curve FINAL` and effective-dated thresholds from Postgres at request time. This
bounded fan-out keeps native samples out of the LLM payload while preserving missing-time and
measurement-kind evidence. The duplicate test fixture inserts the same ride through two source
members and verifies that canonical activity duration and work are calculated once.

Because `activity_power_curve` is append-incremental, a formula or
standard-duration change does not rewrite unchanged historical activities.
Before rebuilding, record the active row/activity count, oldest activity, and
duration inventory:

```sql
SELECT
    countIf(is_deleted = 0) AS active_curve_rows,
    uniqExactIf(activity_id, is_deleted = 0) AS active_activities,
    minIf(started_at, is_deleted = 0) AS oldest_activity,
    arraySort(groupUniqArrayIf(duration_seconds, is_deleted = 0)) AS durations
FROM analytics.activity_power_curve FINAL;
```

Then run a monitored, model-only full refresh from the production analytics
environment. Do not add this historical operation to deploys, scheduled
workers, request paths, or test setup:

```sh
pnpm tsx scripts/with-env.ts -- env \
  DBT_TARGET=prod \
  UV_PROJECT_ENVIRONMENT=../.venv-analytics \
  uv run --project analytics dbt build \
  --project-dir analytics \
  --profiles-dir analytics \
  --threads 1 \
  --full-refresh \
  --select activity_power_curve
```

Repeat the preflight query after success. Verify the retained activity range is
unchanged unless the maintenance record explains a source-data delta, and
verify the duration inventory includes `1, 5, 15, 30, 60, 120, 180, 300, 420,
600, 720, 1200, 1800, 2400, 3600, 5400, 7200` where source resolution and
activity length support them. dbt recommends a full refresh when incremental
model logic changes because existing rows retain the old transformation
([dbt incremental model guidance](https://docs.getdbt.com/docs/build/incremental-models#how-do-i-rebuild-an-incremental-model)).

Production `DBT_SAFE_MODELS` currently selects `sensor_scalar_sample`,
`deduped_sensor`, `activity_source_records`, `activity_duplicate_matches`,
`activity_duplicate_groups`, `deduped_activities`, `deduped_activity_members`,
`activity_effort_identity`, `activity_route_identity`,
`provider_metric_stream_daily`, `provider_change_watermark`, `sleep_heart_rate_window`,
`sleep_heart_rate_sample`, `resting_heart_rate_sleep_window`,
`daily_sleep`, `daily_recovery_inputs`, `daily_recovery`, `activity_sensor_sample`, `activity_location_sample`,
`activity_sensor_summary_rows`, `activity_location_summary_rows`,
`activity_stream_points`, `activity_heart_rate_zones`, `activity_summary_rows`,
`hiking_activity`, `body_measurement`, `activity_vo2max_estimate`,
`activity_aerobic_efficiency`, `activity_polarization_zones`,
`activity_power_curve`, `cycling_activity`, `daily_cycling`, `provider_stats`,
`daily_activity_load`, `daily_strain`, `healthspan_activity_zone_minutes`,
and `weekly_healthspan`. Scalar activity sample models use dbt's `microbatch`
incremental strategy with daily batches and short lookbacks so ClickHouse
processes bounded windows instead of one large activity/window query. Activity
stream staging uses the `metric_stream_freshness` source alias and batches by
`_peerdb_synced_at`; downstream activity sample membership models
(`activity_sensor_sample`) use upstream source freshness as their microbatch
event time so late provider stream syncs and late activity dedupe changes can
reattach older workout samples outside the normal recorded-time lookback.
Location reconciliation deliberately is not event-time microbatched: its
provider counts must see complete current tracks for affected groups, and its
target reconciliation is limited to those groups. Dirty discovery aggregates
source freshness at group cardinality before the bounded group selection, and
point-level latest-version reconstruction runs only for the selected batch.
Selected groups that resolve to no live points write a deleted checkpoint row
so their persisted watermark advances without exposing a synthetic live
sample; see the
[`activity_location_sample` model](./models/read_models/activity_location_sample.sql).
`deduped_activities` and `deduped_activity_members`
materialize canonical activity identity once, but incremental runs only rebuild
activity groups affected by scoped member or group IDs; provider/device priority
changes can change representative selection globally while persisted group IDs
remain stable. The final resting heart rate, activity
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
microbatch models, and monitor ClickHouse capacity while the run is active.
For stable activity-group repair, use the ordered procedure below: its bounded
microbatch command intentionally runs only after stable identity and membership
have been rebuilt.

For a microbatch replay, choose the smallest interval that contains the data
being repaired and advance long backfills in separately observed windows. This
bounded replay guidance does not define the retention boundary for the full
`activity_summary_rows` rebuild below. dbt's microbatch documentation defines
these flags as the supported historical backfill controls and recommends
providing both bounds:
<https://docs.getdbt.com/docs/build/incremental-microbatch#backfills>.

When activity grouping or an `activity_sensor_summary_rows`,
`activity_location_summary_rows`, `activity_summary_rows`, or
`activity_vo2max_estimate` field changes, existing append-incremental rows are
not rewritten by the model change alone. Use this order and stop when an
earlier verification fails:

1. From a one-shot container built from the target release, with that
   environment's `DATABASE_URL` and `CLICKHOUSE_URL` injected, run the standard
   migration entrypoint:

   ```sh
   ./entrypoint.sh migrate
   ```

   It applies pending migrations in registry order. Verify migrations
   `0079_stable_activity_group_id`, `0080_sensor_source_activity_id`, and
   `0081_stable_activity_read_views` are present in
   `analytics.schema_migrations` before continuing. See the standard
   [`entrypoint.sh`](../entrypoint.sh) and ordered
   [migration registry](../src/db/clickhouse-migrations/registry.ts).

   ```sql
   SELECT id
   FROM analytics.schema_migrations
   WHERE id IN (
       '0079_stable_activity_group_id',
       '0080_sensor_source_activity_id',
       '0081_stable_activity_read_views'
   )
   ORDER BY id;
   ```

   The query must return exactly those three rows.
2. Run `pnpm check:clickhouse-cdc`, then query
   `postgres_fitness.activity FINAL` for the repaired member IDs. Compare every
   mirrored `id` and `group_id` with the PostgreSQL `fitness.v_activity` result
   already verified by the repair runbook. Do not start dbt until all expected
   members are present under the expected persisted group ID.

   ```sql
   SELECT id, group_id, _peerdb_synced_at
   FROM postgres_fitness.activity FINAL
   WHERE user_id = toUUID('<user-uuid>')
     AND id IN (
         toUUID('<member-uuid-1>'),
         toUUID('<member-uuid-2>')
     )
     AND _peerdb_is_deleted = 0
   ORDER BY id;
   ```

3. Rebuild stable identity and membership before any sensor-to-activity
   association. This selection includes the source and duplicate-evidence
   inputs needed by `deduped_activities`, followed by its member projection:

   ```sh
   pnpm tsx scripts/with-env.ts -- env \
     DBT_TARGET=dev \
     UV_PROJECT_ENVIRONMENT=../.venv-analytics \
     uv run --project analytics dbt build \
     --project-dir analytics \
     --profiles-dir analytics \
     --threads 1 \
     --full-refresh \
     --select "activity_source_records activity_duplicate_matches activity_duplicate_groups deduped_activities deduped_activity_members"
   ```

4. Run the bounded sensor microbatch for the affected historical interval:

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
     --select "sensor_scalar_sample deduped_sensor activity_sensor_sample"
   ```

   Replace both dates with the smallest interval containing the affected
   samples. The dependency order is `sensor_scalar_sample`, `deduped_sensor`,
   then `activity_sensor_sample`. The replay is required for historical
   membership changes and for provenance written before migration 0077; a
   normal incremental run processes only recent batches.

5. Before the downstream full refresh, calculate `required_lookback_days`
   below. The value must cover every retained activity that should remain in
   the rebuilt identity, payload, and summary tables. dbt recommends rebuilding an
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
  --threads 1 \
  --full-refresh \
  --vars '{"initial_lookback_days": 3650}' \
  --select "deduped_activities deduped_activity_members activity_location_sample activity_sensor_summary_rows activity_location_summary_rows activity_stream_points activity_summary_rows activity_vo2max_estimate"
```

The lookback is a full-refresh retention boundary, not just the scope of the
semantic change. A full refresh drops rows older than
`initial_lookback_days`, and later incremental runs will not re-add those
unchanged activities. The eight selected models must all report `PASS` with
no warnings or errors before the operator treats the rebuild as complete.
`activity_sensor_sample` is intentionally absent because it sets
`full_refresh=false`; the bounded microbatch in step 4 is its historical
rebuild path. `activity_source_records` and the duplicate projections are not
rebuilt twice. `deduped_activities` and `deduped_activity_members` are
intentionally refreshed again because representative sensor richness consumes
the newly replayed `deduped_sensor` provenance. dbt then orders those models
before their location, stream, summary, and VO2 max consumers through their
`ref()` dependencies.

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
Verify that `active_cycling_rows` matches the preflight count, unless the
maintenance record documents and justifies an expected delta. Record both
checks, verify that `oldest_active_activity` matches its preflight value unless
the maintenance record documents and justifies the expected change, and record
all three checks with the model run result before treating the maintenance
change as successful. This
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
