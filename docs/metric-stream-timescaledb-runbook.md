# Metric Stream Timescale Runbook

This runbook converts `fitness.metric_stream` from a regular table to a Timescale hypertable, then enables compression.

Use this during a planned maintenance window. Do not run this as an automatic deploy migration while app traffic is writing to `metric_stream`.

## Why this exists

- `metric_stream` growth is the main storage driver in production.
- Regular-table storage + large indexes eventually exhausted host disk.
- Timescale hypertables + compression provide sustained storage control.

## Preconditions

1. **Take a fresh backup/snapshot first** (required).
2. Ensure **free disk headroom** before migration (target at least 20GB free).
3. Ensure sufficient DB memory headroom for conversion. On current production data volume (~77M rows in `metric_stream`), `create_hypertable(... migrate_data => TRUE)` can be OOM-killed on low-memory hosts.
4. If host memory is constrained, use a staged-copy conversion (new empty hypertable + batched inserts + table swap) instead of direct `migrate_data`.
5. Ensure Terraform-managed data volume is provisioned (`data_volume_size_gb`, default `100`) and applied.
6. Plan a write pause for app services that insert into `metric_stream` (`web`, `worker`, `training-export-worker`).

## 1) Verify current state

```sql
SELECT extname, extversion
FROM pg_extension
WHERE extname = 'timescaledb';

SELECT hypertable_schema, hypertable_name
FROM timescaledb_information.hypertables
WHERE hypertable_schema = 'fitness'
  AND hypertable_name = 'metric_stream';
```

## 2) Pause writers

Scale down app services (keep `db`, `redis`, `traefik` running):

```bash
docker service scale dofek_web=0 dofek_worker=0 dofek_training-export-worker=0
```

## 3) Convert table to hypertable

This is now codified in migration `drizzle/0007_metric_stream_hypertable.sql` (idempotent).
It auto-converts only when `fitness.metric_stream` is empty (fresh setup).
For existing production data, migration `0007` intentionally no-ops and requires this runbook-based maintenance conversion.

```sql
SELECT create_hypertable(
  'fitness.metric_stream',
  by_range('recorded_at', INTERVAL '1 day'),
  migrate_data => TRUE,
  if_not_exists => TRUE
);
```

## 4) Apply Timescale policies

After conversion, run standard migrations so `drizzle/0006_metric_stream_timescale_policies.sql` applies:

```bash
pnpm migrate
```

That migration configures:
- chunk interval: `1 day`
- compression enabled
- segment by: `user_id,provider_id,channel`
- order by: `recorded_at DESC`
- compression policy: compress chunks older than `7 days`

## 5) Backfill compression for old chunks

Run in batches to avoid long locks:

```sql
SELECT compress_chunk(c, if_not_compressed => TRUE)
FROM show_chunks('fitness.metric_stream', older_than => INTERVAL '7 days') AS c
LIMIT 20;
```

Repeat until complete.

## 6) Resume services

```bash
docker service scale dofek_web=2 dofek_worker=1 dofek_training-export-worker=1
```

## 7) Validate

```sql
SELECT hypertable_schema, hypertable_name, compression_enabled
FROM timescaledb_information.hypertables
WHERE hypertable_schema = 'fitness'
  AND hypertable_name = 'metric_stream';

SELECT job_id, proc_name, hypertable_schema, hypertable_name, schedule_interval, config
FROM timescaledb_information.jobs
WHERE hypertable_schema = 'fitness'
  AND hypertable_name = 'metric_stream';
```

Check app health:

```bash
curl -fsS https://dofek.asherlc.com/healthz
```

## Optional next step: retention

Retention is intentionally not auto-enabled in migrations because it is a product/data-retention decision.

When agreed, add policy explicitly:

```sql
SELECT add_retention_policy(
  'fitness.metric_stream',
  drop_after => INTERVAL '180 days',
  if_not_exists => TRUE
);
```
