# ClickHouse Metric Stream Projection

`fitness.metric_stream` remains canonical in Postgres/Timescale. After
`drizzle/0009_metric_stream_id_not_null_primary_key.sql` backfilled stable row
IDs and added the Timescale-compatible `(id, recorded_at)` primary key,
ClickHouse migration `0004_reenable_materialized_metric_stream` re-enabled raw
`metric_stream` replication through a `MaterializedPostgreSQL` source.

```text
Postgres/Timescale fitness.metric_stream
        |
        | raw MaterializedPostgreSQL replication
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

- `postgres_fitness.metric_stream`: a `MaterializedPostgreSQL` replica of the
  raw metric stream.
- `postgres_fitness_live`: a PostgreSQL database bridge for scalar-only views in
  the Postgres `clickhouse` schema:
  `clickhouse.v_activity` and `clickhouse.v_activity_members`.
- `analytics.deduped_sensor`: a refreshable materialized view refreshed every
  minute from the replicated raw rows and activity membership.
- `analytics.activity_summary`: a refreshable materialized view refreshed from
  `analytics.deduped_sensor`.

Postgres still runs with `wal_level=logical`, `max_replication_slots`, and
`max_wal_senders` enabled so ClickHouse can subscribe to raw metric stream
changes.

API startup only verifies that the migrated ClickHouse tables exist. It must not
create or rewrite analytical schema, because production runs multiple web
replicas and schema ownership belongs to the one-shot migration path.
