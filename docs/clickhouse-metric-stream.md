# ClickHouse Metric Stream Projection

`metric_stream` samples publish to Redpanda first. Redpanda Connect archives the
topic to Cloudflare R2 for long-term replay, and
`metric-stream-clickhouse-sink` writes the analytics copy into
`ingest.metric_stream`. Postgres is no longer the normal forward
ingestion path for metric-stream samples, and PeerDB does not mirror
`fitness.metric_stream`.

```text
Redpanda metric-stream-v1
        |                         |
        | R2 archive              | ClickHouse sink
        v                         v
Cloudflare R2 replay archive
ClickHouse ingest.metric_stream
        |
        | dbt microbatch projection by recorded_at
        v
ClickHouse analytics.sensor_scalar_sample
        |
        | dbt microbatch dedupe by recorded_at
        v
ClickHouse analytics.deduped_sensor
        |
        | normal view
        v
ClickHouse analytics.activity_summary
        |
        | normal view
        v
ClickHouse analytics.activity_trend_daily
        |
        v
Activity stream, zone, summary, and trend reads
```

Location rows are exposed through `analytics.deduped_location`, also as a normal
view. There are no ClickHouse full-refresh read models in this chain.

Runtime API queries must read `analytics.deduped_sensor`,
`analytics.activity_summary`, or `analytics.activity_trend_daily`, not the raw
metric stream. The raw ClickHouse table exists only as the source for the
deduped sensor incremental projection and normal analytics views. Derived rows
are never synced back to Postgres.

## Local Development

Start the backing services:

```bash
pnpm compose -- up -d db clickhouse redis
pnpm migrate
```

To run the CDC path locally (not part of the default compose profile):

```bash
pnpm compose -- -f docker-compose.yml -f docker-compose.peerdb.yml up -d
pnpm clickhouse-cdc
```

Use these local URLs:

- `DATABASE_URL=postgres://health:health@localhost:5435/health`
- `CLICKHOUSE_URL=http://default:health@localhost:8123`

## Query Model

Activity routes resolve authorization, access windows, and canonical activity
membership in Postgres. Stream and heart-rate/power-zone reads query
`analytics.deduped_sensor` by user, channel, and activity time window; the
sensor table does not store `activity_id`. Activity summary, location, provider
stats, sleep/body/daily metrics, and trend reads query normal ClickHouse
`analytics.*` views over the raw mirrors and incremental projection tables. The
app does not issue raw `metric_stream` analytical reads for those endpoints.
Daily and weekly trend reads use `analytics.activity_trend_daily`; weekly rows
are rolled up from daily rows at query time.

Provider record inventory uses the ClickHouse `analytics.provider_stats` read
model for all provider-owned record counts displayed by sync/provider detail:
activity, daily metric, sleep, body measurement, food entry, health event,
metric stream, distinct nutrition day, lab panel, lab result, and journal entry
counts. Metric-stream counts are maintained by the incremental
`analytics.provider_metric_stream_daily` model at
`(user_id, provider_id, recorded_date)` grain. It reads compact
`analytics.metric_stream_day_change` keys, resolves exact latest state with
`argMax(tuple(recorded_at, ingested_at, version, is_deleted),
tuple(version, ingested_at))`, and emits zero rows for fully tombstoned days.
`provider_stats` sums the daily rows only after every marked day for the
provider has caught up. The selected-day raw scan prefers the covering
`ingest.metric_stream.by_provider_current_state_recorded_at` projection;
projections are optimizer support structures rather than an application source
of truth:
<https://clickhouse.com/docs/data-modeling/projections>. The provider detail UI
still treats these as raw provider-owned record counts, not deduped analytical
sample counts. Historical marker bootstrap and projection materialization are
explicit operator actions; use the
[read-model deploy runbook](clickhouse-read-model-deploy-runbook.md#known-failure-provider_stats-current-state-scan-timeout)
for rollout verification and stop conditions if the daily model remains dirty
or raw provider recounts return.

## Scalar And Location Projections

Scalar sensor samples and location samples use separate ClickHouse projections
because they have different deduplication semantics.

`analytics.deduped_sensor` is optimized for scalar channels such as heart rate,
power, cadence, speed, and altitude. For those channels, the useful atomic unit
is one `(user_id, channel, recorded_at)` key. The incremental pipeline can
recompute a single changed key and select the best live sample with
provider/device priority rules.

GPS location is different. The useful unit is a coherent route for an activity,
not an independently selected point at each timestamp. Providers can report the
same route with different sampling rates, timestamp rounding, pause trimming,
smoothing, altitude correction, and GPS filtering. If location were deduped
point-by-point with the scalar rules, a derived route could silently stitch
Apple, Garmin, Strava, or other provider points together. That stitched route
may not match any route a provider actually recorded, and route-sensitive
metrics such as distance, centroid, and map shape can be inflated, deflated, or
visibly jagged by small provider-to-provider differences.

For that reason, `analytics.deduped_location` remains a separate activity-route
projection. It selects a route source for an activity, currently by valid
location sample count with deterministic provider tie-breaking, and then uses
that source's ordered points for GPS-derived activity summary fields. This is
not mainly a table-shape constraint; the table shape could change. The core
constraint is preserving route coherence while keeping scalar sensor dedupe a
small per-key incremental pipeline.

## Sync Model

ClickHouse migrations run from the normal one-shot `migrate` container when
`CLICKHOUSE_URL` is set. Destructive cleanup, such as dropping obsolete
ClickHouse read models or old custom sync tables, belongs there so API startup
does not repeatedly delete analytical state.

ClickHouse `Nullable(Point)` columns require
`allow_experimental_nullable_tuple_type=1`. The app ClickHouse client sends
that setting with its requests, and Docker deployments also load the checked-in
server profile at
`deploy/clickhouse/users.d/default-query-guardrails.xml`.

ClickHouse migrations create and update the databases and read models:

- `ingest.metric_stream`: a ClickHouse-native `ReplacingMergeTree` copy of the
  raw metric stream populated by `metric-stream-clickhouse-sink`. Historical
  rows may still have been backfilled from Postgres, but new forward rows come
  from Redpanda events. Its `version` and `is_deleted` columns encode replacement
  order and logical deletion so current-state queries can select the latest live
  row. Its `by_provider_current_state` aggregate projection computes the same
  latest-row state in advance at provider-record grain for exact inventory counts
  ([ReplacingMergeTree](https://clickhouse.com/docs/en/guides/replacing-merge-tree),
  [projections](https://clickhouse.com/docs/data-modeling/projections)).
- `ingest.metric_stream_delete_acknowledgement`: one receipt per version 2
  deletion event, written only after the sink's tombstone insert completes.
- `ingest.metric_stream_processing_acknowledgement`: one receipt per stable
  processing batch ID, written after the sink applies that batch's events and
  marker. Processing status requires the operation ID and expected event count
  to match the Postgres expectation; the table stores evidence, not metric
  payloads ([acknowledgement table migration](../src/db/clickhouse-migrations/0051_metric_stream_processing_acknowledgement.ts),
  [reconciliation logic](../src/processing/processing-reconciler.ts)).
- `postgres_fitness`: app-managed native ClickHouse raw mirrors with PeerDB CDC
  metadata columns for lower-volume Postgres-backed raw tables, including
  activity, sleep, daily metrics, provider inventory, and sensor priority
  tables. The fitness and provider-inventory mirrors write the shared Postgres
  processing marker into distinct ClickHouse destination tables so each flow's
  causal fence can be proven independently. Metric-stream rows use compatible
  metadata columns but are not a PeerDB mirror
  ([marker table migration](../src/db/clickhouse-migrations/0052_processing_flow_markers.ts),
  [reconciliation logic](../src/processing/processing-reconciler.ts)).
- `analytics.v_activity`, `analytics.v_activity_members`, `analytics.v_sleep`,
  `analytics.v_body_measurement`, and `analytics.v_daily_metrics`: normal
  ClickHouse views over the raw mirrors and body sample projection.
- `analytics.provider_metric_stream_daily` and `analytics.provider_stats`:
  dbt-owned incremental `ReplacingMergeTree` serving tables for bounded
  provider metric counts and their provider-inventory sum.
- `analytics.body_measurement_sample`: a narrow `ReplacingMergeTree`
  projection of body-related `metric_stream` channels. It is backfilled once by
  migration and kept current by `analytics.body_measurement_sample_ingest`, so
  `analytics.v_body_measurement` does not scan the full metric stream mirror.
- `analytics.sensor_scalar_sample`: a narrow dbt `microbatch` incremental
  `ReplacingMergeTree` projection of activity sensor scalar channels. It uses
  `recorded_at` as its dbt event time, writes one current row per raw
  `metric_stream.id`, and maps the raw stream's `version` into its
  `_peerdb_version` projection column inside the bounded batch query.
- `analytics.deduped_sensor`: an activity-agnostic dbt `microbatch`
  incremental `ReplacingMergeTree` table containing the best live scalar sample
  per `(user_id, channel, recorded_at)` according to mirrored sensor
  provider/device priority tables. It uses `recorded_at` as its dbt event time
  and has no `activity_id`; activity reads join samples to activities by time
  window.
- `analytics.deduped_location`: a normal view over
  `ingest.metric_stream` location rows. The Redpanda ClickHouse sink
  converts EWKT point payloads into ClickHouse point-compatible values.
- `analytics.activity_summary`: a normal view over `analytics.deduped_sensor`,
  `analytics.deduped_location`, and `analytics.v_activity`.
- `analytics.activity_trend_daily`: a normal view with one activity-linked
  sensor trend row per user and UTC day. It is derived from
  `analytics.deduped_sensor`.

### Provider inventory projection rollout

Migration `0061_provider_current_state_projection` adds the
`by_provider_current_state` definition. New metric-stream parts populate it
automatically, but existing parts do not receive a newly added projection until
an operator materializes it. ClickHouse documents `MATERIALIZE PROJECTION` as
the required existing-data step:
<https://clickhouse.com/docs/data-modeling/projections#filtering-on-columns-which-arent-in-the-primary-key>.

Materialization rewrites historical parts, so it is an explicit maintenance
operation rather than a deploy migration:

```sql
ALTER TABLE ingest.metric_stream
MATERIALIZE PROJECTION by_provider_current_state;
```

Monitor the mutation until `is_done = 1` and `latest_fail_reason` is empty:

```sql
SELECT
  mutation_id,
  command,
  is_done,
  latest_fail_reason
FROM system.mutations
WHERE database = 'ingest'
  AND table = 'metric_stream'
ORDER BY create_time DESC;
```

Then verify every active base-table part contains the projection:

```sql
SELECT countIf(NOT has(
  projections,
  'by_provider_current_state'
)) AS missing_projection_parts
FROM system.parts
WHERE active
  AND database = 'ingest'
  AND table = 'metric_stream';
```

### Daily provider metric-count rollout

Migration `0068_provider_metric_stream_daily_counts` adds the compact
`analytics.metric_stream_day_change` table and its insert-triggered materialized
view, plus the covering
`by_provider_current_state_recorded_at` projection. The daily dbt model is
ordered before `provider_change_watermark` and `provider_stats`; it processes a
bounded default batch of 32 dirty provider/day keys and leaves provider
publication dirty while a selected day has not caught up. The model's exact
latest-state query remains the source of truth; the projection only narrows
selected-day reads. ClickHouse incremental materialized views consume newly
inserted blocks, and dbt incremental models own the bounded serving transform:
[ClickHouse incremental materialized views](https://clickhouse.com/docs/materialized-view/incremental-materialized-view),
[dbt incremental models](https://docs.getdbt.com/docs/build/incremental-models).

Apply the forward migration through the normal migration container, then
materialize the projection as an explicit maintenance action. Do not combine
the historical scan with deploy-time migration execution:

```sql
ALTER TABLE ingest.metric_stream
MATERIALIZE PROJECTION by_provider_current_state_recorded_at;
```

Stop if the mutation reports a non-empty `latest_fail_reason`. Do not continue
to the active-part check or historical bootstrap until every relevant mutation
row reports `is_done = 1` and an empty `latest_fail_reason`:

```sql
SELECT
  mutation_id,
  command,
  is_done,
  latest_fail_reason
FROM system.mutations
WHERE database = 'ingest'
  AND table = 'metric_stream'
ORDER BY create_time DESC;

SELECT countIf(NOT has(
  projections,
  'by_provider_current_state_recorded_at'
)) AS missing_projection_parts
FROM system.parts
WHERE active
  AND database = 'ingest'
  AND table = 'metric_stream';
```

The active-part result must contain at least one active part and
`missing_projection_parts = 0`. Bootstrap historical dirty days only after
that gate passes. Use one explicit provider/date window per bounded batch, keep
the window checkpoint with the rollout record, and resume at the next window;
do not run an unrestricted `GROUP BY` over the raw table. The query reads the
raw canonical table with the materialized covering projection forced and writes
invalidation keys, not counts:

```sql
INSERT INTO analytics.metric_stream_day_change
  (user_id, provider_id, recorded_date, changed_at)
SELECT
  user_id,
  provider_id,
  toDate(recorded_at) AS recorded_date,
  now64(9, 'UTC') AS changed_at
FROM ingest.metric_stream
WHERE user_id = toUUID('00000000-0000-0000-0000-000000000000')
  AND provider_id = 'REPLACE_WITH_PROVIDER_ID'
  AND recorded_at >= toDateTime64('2020-01-01 00:00:00', 6, 'UTC')
  AND recorded_at < toDateTime64('2020-01-02 00:00:00', 6, 'UTC')
GROUP BY user_id, provider_id, recorded_date
SETTINGS
  force_optimize_projection = 1,
  force_optimize_projection_name = 'by_provider_current_state_recorded_at';
```

Replace the example user, provider, and date window before each batch. Record
the last completed `(user_id, provider_id, recorded_date)` window and resume
with the next deterministic window. `MATERIALIZE PROJECTION` rewrites existing
raw parts; this bootstrap only appends compact marker state, so the two costs
and completion checks remain separate.

After the analytics worker has run, verify that no day marker is newer than its
daily replacement row:

```sql
WITH source_days AS (
  SELECT
    user_id,
    provider_id,
    recorded_date,
    max(changed_at) AS source_changed_at
  FROM analytics.metric_stream_day_change
  GROUP BY user_id, provider_id, recorded_date
), daily_rows AS (
  SELECT
    user_id,
    provider_id,
    recorded_date,
    max(source_changed_at) AS source_changed_at
  FROM analytics.provider_metric_stream_daily FINAL
  GROUP BY user_id, provider_id, recorded_date
)
SELECT
  source_days.user_id,
  source_days.provider_id,
  source_days.recorded_date,
  source_days.source_changed_at,
  daily_rows.source_changed_at AS daily_changed_at
FROM source_days
LEFT JOIN daily_rows
  ON daily_rows.user_id = source_days.user_id
 AND daily_rows.provider_id = source_days.provider_id
 AND daily_rows.recorded_date = source_days.recorded_date
WHERE daily_rows.recorded_date IS NULL
   OR source_days.source_changed_at > daily_rows.source_changed_at
ORDER BY source_days.source_changed_at
LIMIT 50;
```

Stop rollout if this query returns rows, if any projection mutation fails, or
if `provider_stats` resumes reading the raw metric stream instead of summing
`provider_metric_stream_daily`. Confirm a successful `QueryFinish` for the
model in `system.query_log`, a successful analytics processing marker, and
downstream provider-inventory freshness before declaring the rollout complete.

### Deletion protocol

New metric-stream deletions are version 2 Redpanda events with a unique event
ID. The ClickHouse sink first filters `ingest.metric_stream` to the deletion
scope, selects the latest version of each matching ID, inserts a newer
`is_deleted = 1` version, and then writes the event ID to
`ingest.metric_stream_delete_acknowledgement`. The provider deletion worker
waits for that acknowledgement before rebuilding dbt models and invalidating
the user's analytics cache; it does not scan the full raw table to infer that
the event was applied. Archived version 1 deletion events remain replayable,
but do not have acknowledgement IDs.

The native-table backfill is resumable within a successful migration attempt,
but migration `0006_backfill_native_metric_stream` intentionally drops the
backfill checkpoint table before rebuilding the raw table. If the migration
container fails before recording the migration, the next retry starts from a
clean raw table instead of trusting stale chunk checkpoints.

Postgres runs with `wal_level=logical`, `max_replication_slots`, and
`max_wal_senders` enabled for PeerDB. The deploy workflow runs
`src/db/setup-clickhouse-cdc.ts` after `docker stack deploy`; that command
loads `src/db/peerdb/metric-stream-cdc.sql`, substitutes deployment
connection values, and applies the declarative PeerDB peer and mirror
definition. Provider inventory tables are mirrored by
`dofek_provider_inventory_raw_analytics` so existing raw analytics mirrors do
not need to be rebuilt when inventory coverage expands. Sensor priority tables
are mirrored by `dofek_sensor_priority_raw_analytics` so priority changes do
not require rebuilding the broader raw analytics mirrors.

**Mirror reconciliation**: The deploy CDC setup checks whether each mirror's
table list matches the expected mapping in `rawAnalyticsMirrorTableMappings`.
If any expected table is missing from an existing mirror's config, the setup
drops and recreates the entire mirror, triggering a full initial snapshot of
all tables in that mirror. This is destructive on a resource-constrained
server — only add tables to a mirror mapping if a ClickHouse read model
actually consumes them.

The mirrors use a
dedicated publication name, exclude `device_id`, `source_type`, `vector`,
`point`, and `metadata` from the metric stream mirrors, and enable soft deletes
so delete events are represented in ClickHouse.
ClickHouse's built-in `MaterializedPostgreSQL` engine is not the CDC path for
`metric_stream`.

API startup only verifies that the migrated ClickHouse tables exist. It must not
create or rewrite analytical schema, because production runs multiple web
replicas and schema ownership belongs to the one-shot migration path.
