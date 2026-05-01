# ClickHouse Metric Stream Projection

`fitness.metric_stream` remains canonical in Postgres/Timescale. ClickHouse
keeps a native `MergeTree` scalar copy of the raw stream and backfills it from
Postgres by real Timescale chunk ranges. We do not use ClickHouse
`MaterializedPostgreSQL` for this hypertable because the hypertable root does
not contain the physical rows; the data live in Timescale chunk tables.

```text
Postgres/Timescale fitness.metric_stream
        |
        | chunk-range native backfill
        v
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
        v
Activity stream, zone, and summary reads
```

Runtime API queries must read `analytics.deduped_sensor` or
`analytics.activity_summary`, not the raw metric stream. The raw ClickHouse table
exists only as the source for ClickHouse refresh jobs. Derived rows are never
synced back to Postgres.

## Local Development

Start the backing services:

```bash
docker compose up -d db clickhouse redis
pnpm migrate
```

Use these local URLs:

- `DATABASE_URL=postgres://health:health@localhost:5435/health`
- `CLICKHOUSE_URL=http://default:health@localhost:8123`

## Query Model

Activity routes resolve authorization, access windows, and canonical activity
membership in Postgres. Stream, heart-rate-zone, power-zone, and activity
summary reads then query stored ClickHouse `analytics.*` materialized views. The
app does not issue raw `metric_stream` analytical reads for those endpoints.

## Sync Model

ClickHouse migrations run from the normal one-shot `migrate` container when
`CLICKHOUSE_URL` is set. Destructive cleanup, such as dropping obsolete
ClickHouse read models or old custom sync tables, belongs there so API startup
does not repeatedly delete analytical state.

ClickHouse migrations create and update the databases and read models:

- `postgres_fitness.metric_stream`: a ClickHouse-native `MergeTree` scalar copy
  of the raw metric stream.
- `postgres_fitness_live`: a PostgreSQL database bridge for scalar-only views in
  the Postgres `clickhouse` schema:
  `clickhouse.v_activity` and `clickhouse.v_activity_members`.
- `analytics.deduped_sensor`: a refreshable materialized view refreshed every
  minute from the copied raw rows and activity membership.
- `analytics.activity_summary`: a refreshable materialized view refreshed from
  `analytics.deduped_sensor`.

The native-table backfill is resumable within a successful migration attempt,
but migration `0006_backfill_native_metric_stream` intentionally drops the
backfill checkpoint table before rebuilding the raw table. If the migration
container fails before recording the migration, the next retry starts from a
clean raw table instead of trusting stale chunk checkpoints.

Postgres still runs with `wal_level=logical`, `max_replication_slots`, and
`max_wal_senders` enabled for future CDC tooling. ClickHouse's built-in
`MaterializedPostgreSQL` engine is not the CDC path for `metric_stream`.

API startup only verifies that the migrated ClickHouse tables exist. It must not
create or rewrite analytical schema, because production runs multiple web
replicas and schema ownership belongs to the one-shot migration path.
