# ClickHouse Metric Stream Projection

`fitness.metric_stream` remains canonical in Postgres/Timescale. ClickHouse
keeps a native `MergeTree` copy of the raw stream and backfills it from
Postgres by real Timescale chunk ranges. We do not use ClickHouse
`MaterializedPostgreSQL` for this hypertable because the hypertable root does
not contain the physical rows; the data live in Timescale chunk tables.
PeerDB is the CDC path for ongoing Postgres-to-ClickHouse replication. It now
writes to two targets: `peerdb.metric_stream` for validation and
`postgres_fitness.metric_stream` for the active analytics source.

```text
Postgres/Timescale fitness.metric_stream
        |                         |
        | chunk-range native backfill | peerdb peer
        |                         |
        |                         |  PeerDB CDC mirrors
        |                         |                |
        |                         |                +--> peerdb.metric_stream (validation target)
        v                         +----------------+
ClickHouse postgres_fitness.metric_stream
        |
        | refreshable materialized view
        v
ClickHouse analytics.deduped_sensor
        |
        | refreshable materialized view
        v
ClickHouse analytics.activity_summary
        |
        | refreshable materialized view
        v
ClickHouse analytics.activity_trend_daily
        |
        v
Activity stream, zone, summary, and trend reads
```

Runtime API queries must read `analytics.deduped_sensor`,
`analytics.activity_summary`, or `analytics.activity_trend_daily`, not the raw
metric stream. The raw ClickHouse table exists only as the source for
ClickHouse refresh jobs. Derived rows are never synced back to Postgres.

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
membership in Postgres. Stream, heart-rate-zone, power-zone, and activity
summary reads then query stored ClickHouse `analytics.*` materialized views. The
app does not issue raw `metric_stream` analytical reads for those endpoints.
Daily and weekly trend reads use `analytics.activity_trend_daily`; weekly rows
are rolled up from daily rows at query time.

Provider record inventory uses the ClickHouse `analytics.provider_stats` read
model for all provider-owned record counts displayed by sync/provider detail:
activity, daily metric, sleep, body measurement, food entry, health event,
metric stream, distinct nutrition day, lab panel, lab result, and journal entry
counts. The provider detail UI still treats these as raw provider-owned record
counts, not deduped analytical sample counts.

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
  raw metric stream and the active PeerDB CDC sink for analytics refreshers. It
  stores location rows as `point Nullable(Point)` and projects latitude and
  longitude only in the location read model.
- `peerdb.metric_stream`: the PeerDB CDC validation target.
- `postgres_fitness`: app-managed native ClickHouse raw mirrors with PeerDB CDC
  metadata columns. Besides the activity/sleep/body/daily/metric stream
  analytics sources, this includes provider inventory mirrors for `food_entry`,
  `health_event`, `lab_panel`, `lab_result`, and `journal_entry`.
- `analytics.v_activity`, `analytics.v_activity_members`, `analytics.v_sleep`,
  `analytics.v_body_measurement`, and `analytics.v_daily_metrics`: ClickHouse
  read models over the raw mirrors.
- `analytics.deduped_sensor`: a refreshable materialized view refreshed every
  minute from the copied raw rows and activity membership.
- `analytics.activity_summary`: a refreshable materialized view refreshed from
  `analytics.deduped_sensor`.
- `analytics.activity_trend_daily`: a refreshable materialized view with one
  activity-linked sensor trend row per user and UTC day. It is derived from
  `analytics.deduped_sensor` and is safe to drop and rebuild.

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
not need to be rebuilt when inventory coverage expands. The mirrors use a
dedicated publication name, exclude `device_id`, `source_type`, `vector`, and
`metadata` from the metric stream mirrors, and enable soft deletes so delete
events are represented in ClickHouse.
ClickHouse's built-in `MaterializedPostgreSQL` engine is not the CDC path for
`metric_stream`.

API startup only verifies that the migrated ClickHouse tables exist. It must not
create or rewrite analytical schema, because production runs multiple web
replicas and schema ownership belongs to the one-shot migration path.
