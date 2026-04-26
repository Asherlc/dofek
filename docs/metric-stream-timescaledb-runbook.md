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

Do not run this while materialized-view refresh is rebuilding `deduped_sensor`,
`activity_summary`, or `provider_stats`. Those jobs scan `metric_stream` and can
fight chunk compression for locks.

Check active work first:

```sql
SELECT pid, now() - query_start AS age, wait_event_type, wait_event, state, left(query, 220) AS query
FROM pg_stat_activity
WHERE datname = 'health'
  AND state <> 'idle'
  AND (
    query ILIKE '%metric_stream%'
    OR query ILIKE '%deduped_sensor%'
    OR query ILIKE '%activity_summary%'
    OR query ILIKE '%provider_stats%'
  )
ORDER BY query_start NULLS LAST;
```

If a view refresh is already running and blocking maintenance, cancel that backend
instead of stacking compression behind it:

```sql
SELECT pg_cancel_backend(pid)
FROM pg_stat_activity
WHERE datname = 'health'
  AND pid <> pg_backend_pid()
  AND (
    query ILIKE '%deduped_sensor%'
    OR query ILIKE '%activity_summary%'
    OR query ILIKE '%provider_stats%'
  );
```

Compress old chunks one at a time with short lock timeouts. This records chunks
that resist compression without blocking production indefinitely:

```bash
container=$(docker ps --filter label=com.docker.swarm.service.name=dofek_db --format '{{.ID}}' | head -n 1)
run_id=$(date -u +%Y%m%dT%H%M%SZ)
chunk_file="/tmp/metric_stream_chunks_${run_id}.txt"
failed_file="/tmp/metric_stream_compression_failed_${run_id}.txt"
: > "$failed_file"

docker exec -i "$container" psql -U health -d health -At -P pager=off > "$chunk_file" <<'SQL'
SELECT format('%I.%I', chunk_schema, chunk_name)
FROM timescaledb_information.chunks
WHERE hypertable_schema = 'fitness'
  AND hypertable_name = 'metric_stream'
  AND NOT is_compressed
  AND range_end < now() - INTERVAL '7 days'
ORDER BY range_start NULLS LAST, chunk_schema, chunk_name;
SQL

while IFS= read -r chunk; do
  echo "compressing $chunk"
  if ! docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U health -d health -At -P pager=off <<SQL
SET lock_timeout = '3s';
SET statement_timeout = '180s';
SET maintenance_work_mem = '32MB';
SELECT compress_chunk('$chunk'::regclass, if_not_compressed => TRUE);
SQL
  then
    echo "$chunk" >> "$failed_file"
  fi
done < "$chunk_file"

echo "failed_file=$failed_file"
cat "$failed_file"
```

Treat `already compressed` / `already converted to columnstore` notices as
non-blocking. They can happen when the background compression policy or a prior
loop compressed a chunk after the chunk list was generated.

Do not force-compress the active writer chunk while app services are writing.
If a chunk holds relation locks long enough to block inserts, cancel that
`compress_chunk` backend and record the chunk name, range, and elapsed time.

Reconcile from Timescale metadata after every pass:

```sql
SELECT is_compressed, count(*) AS chunks
FROM timescaledb_information.chunks
WHERE hypertable_schema = 'fitness'
  AND hypertable_name = 'metric_stream'
GROUP BY is_compressed
ORDER BY is_compressed;

SELECT chunk_schema, chunk_name, range_start, range_end, is_compressed
FROM timescaledb_information.chunks
WHERE hypertable_schema = 'fitness'
  AND hypertable_name = 'metric_stream'
  AND NOT is_compressed
ORDER BY range_start NULLS LAST, chunk_schema, chunk_name;

SELECT pg_size_pretty(hypertable_size('fitness.metric_stream')) AS hypertable_size;
```

Record resistant chunks in `.context/metric-stream-compression-YYYY-MM-DD.md`
with the error, elapsed time, and whether inserts were blocked.

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
