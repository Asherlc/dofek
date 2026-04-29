# ClickHouse Metric Stream Projection

`fitness.metric_stream` remains canonical in Postgres/Timescale. ClickHouse stores
a rebuildable raw-row projection for activity stream and zone queries that would
otherwise scan or refresh expensive Postgres materialized views.

```text
Postgres/Timescale fitness.metric_stream
        |
        | src/db/run-sync-clickhouse.ts
        v
ClickHouse fitness.metric_stream
        |
        v
Activity stream and power-zone reads
```

The projection contains raw metric rows only. Do not sync `deduped_sensor`,
`activity_summary`, or any other derived rows back into Postgres.

## Local Development

Start the backing services:

```bash
docker compose up -d db clickhouse redis
pnpm migrate
pnpm tsx src/db/run-sync-clickhouse.ts
```

Use these local URLs:

- `DATABASE_URL=postgres://health:health@localhost:5435/health`
- `CLICKHOUSE_URL=http://localhost:8123`

## Query Model

Activity routes still resolve `fitness.v_activity` in Postgres first. That keeps
authorization, billing access windows, and canonical activity membership in the
relational source of truth. The bounded activity window and member activity IDs
are then passed to ClickHouse, which selects the best linked provider per channel
from raw rows and falls back to ambient rows only for channels with no linked
samples.

## Sync Model

`src/db/run-sync-clickhouse.ts` bootstraps the ClickHouse database/table and then
copies Postgres `metric_stream` rows in batches. Repeated syncs re-copy a recent
lookback window so short late-arriving imports can converge. For large historical
repairs, rebuild the ClickHouse table from Postgres instead of editing
ClickHouse directly.
