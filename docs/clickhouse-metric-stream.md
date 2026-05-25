# ClickHouse Metric Stream Projection

`fitness.metric_stream` remains canonical in Postgres/Timescale. ClickHouse
keeps a native `MergeTree` copy of the raw stream and backfills it from
Postgres by real Timescale chunk ranges. We do not use ClickHouse
`MaterializedPostgreSQL` for this hypertable because the hypertable root does
not contain the physical rows; the data live in Timescale chunk tables.
PeerDB is the CDC path for ongoing Postgres-to-ClickHouse replication.
`dofek_metric_stream_analytics` replicates into
`postgres_fitness.metric_stream`, the active analytics source.

```text
Postgres/Timescale fitness.metric_stream
        |                         |
        | chunk-range native backfill | PeerDB CDC mirror
        |                         |   (dofek_metric_stream_analytics)
        v                         v
ClickHouse postgres_fitness.metric_stream
        |
        | native incremental projection
        v
ClickHouse analytics.sensor_scalar_sample
        |
        | dirty-key bounded recompute
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
docker compose up -d db clickhouse redis
pnpm migrate
```

To run the CDC path locally (not part of the default compose profile):

```bash
docker compose -f docker-compose.yml -f docker-compose.peerdb.yml up -d
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
counts. The provider detail UI still treats these as raw provider-owned record
counts, not deduped analytical sample counts.

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
`deploy/clickhouse/users.d/allow-experimental-nullable-tuple-type.xml`.

ClickHouse migrations create and update the databases and read models:

- `postgres_fitness.metric_stream`: a ClickHouse-native `MergeTree` copy of the
  raw metric stream and the active PeerDB CDC sink for analytics refreshers.
  Historical/backfilled location rows can have `point Nullable(Point)` for
  location projections, but current PeerDB metric-stream mirrors exclude
  `point` because PeerDB sends the Postgres geometry value in a format
  ClickHouse cannot cast directly into `Nullable(Point)`. As a consequence,
  new rows arrive with `point = NULL`, so location projections derived from
  `analytics.deduped_location` (and GPS-derived fields in
  `analytics.activity_summary`) stop updating for new data until a replacement
  geometry replication strategy is in place.
- `postgres_fitness`: app-managed native ClickHouse raw mirrors with PeerDB CDC
  metadata columns. Besides the activity/sleep/body/daily/metric stream
  analytics sources, this includes provider inventory mirrors for `food_entry`,
  `health_event`, `lab_panel`, `lab_result`, and `journal_entry`, plus
  `sensor_provider_priority` and `sensor_device_priority` for sensor-channel
  deduplication.
- `analytics.v_activity`, `analytics.v_activity_members`, `analytics.v_sleep`,
  `analytics.v_body_measurement`, `analytics.v_daily_metrics`, and
  `analytics.provider_stats`: normal ClickHouse views over the raw mirrors and
  body sample projection.
- `analytics.body_measurement_sample`: a narrow `ReplacingMergeTree`
  projection of body-related `metric_stream` channels. It is backfilled once by
  migration and kept current by `analytics.body_measurement_sample_ingest`, so
  `analytics.v_body_measurement` does not scan the full metric stream mirror.
- `analytics.sensor_scalar_sample`: a narrow `ReplacingMergeTree` projection of
  activity sensor scalar channels. It is backfilled once by migration and kept
  current by `analytics.sensor_scalar_sample_ingest`.
- `analytics.sensor_dirty_key`: a bounded queue of changed
  `(user_id, channel, recorded_at)` keys. The post-sync worker recomputes only
  those keys into `analytics.deduped_sensor`.
- `analytics.deduped_sensor`: an activity-agnostic `ReplacingMergeTree` table
  containing the best live scalar sample per `(user_id, channel, recorded_at)`
  according to mirrored sensor provider/device priority tables. It has no
  `activity_id`; activity reads join samples to activities by time window.
- `analytics.deduped_location`: a normal view over
  `postgres_fitness.metric_stream` location rows. While the PeerDB mirror
  excludes `point`, new rows have `point = NULL` and this view does not advance
  for new data.
- `analytics.activity_summary`: a normal view over `analytics.deduped_sensor`,
  `analytics.deduped_location`, and `analytics.v_activity`.
- `analytics.activity_trend_daily`: a normal view with one activity-linked
  sensor trend row per user and UTC day. It is derived from
  `analytics.deduped_sensor`.

Because `postgres_fitness.metric_stream` is an existing app-managed ClickHouse
table rather than a table created by PeerDB, it must include PeerDB's CDC
metadata columns before the analytics mirror is submitted:
`_peerdb_synced_at`, `_peerdb_is_deleted`, and `_peerdb_version`. The deploy CDC
setup command repairs these columns idempotently with `ALTER TABLE ... ADD
COLUMN IF NOT EXISTS` before PeerDB validates the mirror.

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
