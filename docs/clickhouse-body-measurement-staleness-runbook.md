# ClickHouse Body Measurement Staleness Runbook

Use this when recent body weight or other body measurements exist in Postgres
but are missing from ClickHouse-backed reads.

## Symptoms

- The UI does not show yesterday's or today's body weight.
- Postgres `fitness.metric_stream` has recent `body_weight` rows.
- ClickHouse `postgres_fitness.metric_stream`,
  `analytics.body_measurement_sample`, or `analytics.v_body_measurement` is
  stale.

## 1. Verify Source and Read Model Freshness

Check Postgres, the PeerDB slot, and the three ClickHouse layers before making
changes:

```bash
ssh dofek-server 'bash -s' <<'REMOTE'
set -euo pipefail
db=$(docker ps --format '{{.Names}}' | grep -E 'dofek[_-]db' | head -1)
docker exec -i "$db" sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT channel, max(recorded_at) AS postgres_latest,
       count(*) FILTER (WHERE recorded_at >= now() - interval '3 days') AS rows_last_3d
FROM fitness.metric_stream
WHERE channel = 'body_weight'
GROUP BY channel;

SELECT slot_name, active, wal_status,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS flush_lag,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_lag
FROM pg_replication_slots
WHERE slot_name LIKE 'peerflow_slot_dofek_%'
ORDER BY slot_name;
SQL
REMOTE
```

```bash
ssh dofek-server 'bash -s' <<'REMOTE'
set -euo pipefail
clickhouse=$(docker ps --format '{{.Names}}' | grep dofek_clickhouse | head -1)
docker exec -i "$clickhouse" sh -lc 'clickhouse-client --password "$CLICKHOUSE_PASSWORD"' <<'SQL'
SELECT database, view, status, last_refresh_time, last_success_time, exception
FROM system.view_refreshes
WHERE database = 'analytics'
  AND view = 'deduped_sensor'
ORDER BY view;

SELECT source, latest, rows FROM
(
  SELECT 'postgres_fitness.metric_stream' AS source, max(recorded_at) AS latest, count() AS rows
  FROM postgres_fitness.metric_stream FINAL
  WHERE channel = 'body_weight'
  UNION ALL
  SELECT 'analytics.body_measurement_sample' AS source, max(recorded_at) AS latest, count() AS rows
  FROM analytics.body_measurement_sample FINAL
  UNION ALL
  SELECT 'analytics.v_body_measurement' AS source, max(recorded_at) AS latest, count() AS rows
  FROM analytics.v_body_measurement
)
ORDER BY source;
SQL
REMOTE
```

## 2. Check for Host-Saturating Refreshes

If production is timing out, check active ClickHouse work:

```bash
ssh dofek-server 'bash -s' <<'REMOTE'
set -euo pipefail
clickhouse=$(docker ps --format '{{.Names}}' | grep dofek_clickhouse | head -1)
docker exec -i "$clickhouse" sh -lc 'clickhouse-client --password "$CLICKHOUSE_PASSWORD"' <<'SQL'
SELECT query_id, elapsed, formatReadableSize(read_bytes) AS read_bytes,
       formatReadableSize(memory_usage) AS memory, left(query, 220) AS query
FROM system.processes
WHERE query NOT LIKE '%system.processes%'
ORDER BY elapsed DESC
LIMIT 20;
SQL
REMOTE
```

If a ClickHouse query is scanning all of `postgres_fitness.metric_stream FINAL`
and the host is unhealthy, stop the active query after recording the query ID.
The current sensor pipeline is incremental; do not pause or depend on a
refreshable sensor view.

```sql
KILL QUERY WHERE query_id IN ('<query-id-1>', '<query-id-2>') SYNC;
```

Then inspect `analytics.sensor_dirty_key` backlog and the latest
`analytics.sensor_scalar_sample._peerdb_synced_at` to confirm the incremental
pipeline is advancing. Document the incident in
`docs/production-incident-baseline.md`.

## 3. Decide Whether CDC Missed a Gap

If the PeerDB metric-stream slot is active and `wal_status = 'reserved'`, but
ClickHouse is still behind Postgres, CDC may have been recreated after the
missing rows were written. Do not force a full PeerDB resnapshot unless the slot
is lost or the user explicitly approves the heavier recovery.

For a narrow body-measurement gap, copy only missing body-measurement channels
after the last ClickHouse body timestamp.

First set the gap lower bound from the stale ClickHouse result, then count the
bounded source rows:

```bash
GAP_START='2026-05-20 14:09:23+00'
ssh dofek-server 'bash -s' <<REMOTE
set -euo pipefail
db=\$(docker ps --format '{{.Names}}' | grep -E 'dofek[_-]db' | head -1)
docker exec -i "\$db" sh -lc 'psql -v ON_ERROR_STOP=1 -U "\$POSTGRES_USER" -d "\$POSTGRES_DB"' <<SQL
SELECT channel, count(*) AS rows, min(recorded_at), max(recorded_at)
FROM fitness.metric_stream
WHERE channel IN (
  'body_weight', 'body_fat_percentage', 'muscle_mass', 'bone_mass',
  'body_water_percentage', 'body_mass_index', 'height', 'waist_circumference',
  'systolic_blood_pressure', 'diastolic_blood_pressure', 'heart_pulse',
  'body_temperature'
)
  AND recorded_at > '$GAP_START'
GROUP BY channel
ORDER BY channel;
SQL
REMOTE
```

If the row count is small and matches the symptom, copy the bounded rows:

```bash
GAP_START='2026-05-20 14:09:23+00'
ssh dofek-server 'bash -s' <<REMOTE
set -euo pipefail
db=\$(docker ps --format '{{.Names}}' | grep -E 'dofek[_-]db' | head -1)
clickhouse=\$(docker ps --format '{{.Names}}' | grep dofek_clickhouse | head -1)
body_channels="'body_weight','body_fat_percentage','muscle_mass','bone_mass','body_water_percentage','body_mass_index','height','waist_circumference','systolic_blood_pressure','diastolic_blood_pressure','heart_pulse','body_temperature'"

docker exec -i "\$db" sh -lc 'psql -v ON_ERROR_STOP=1 -U "\$POSTGRES_USER" -d "\$POSTGRES_DB"' <<SQL \
  | docker exec -i "\$clickhouse" sh -lc 'clickhouse-client --password "\$CLICKHOUSE_PASSWORD" --query "INSERT INTO postgres_fitness.metric_stream (recorded_at, user_id, provider_id, external_id, device_id, source_type, channel, activity_id, scalar, id) FORMAT TSV"'
COPY (
  SELECT
    to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS recorded_at,
    user_id,
    provider_id,
    external_id,
    device_id,
    source_type,
    channel,
    activity_id,
    scalar,
    id
  FROM fitness.metric_stream
  WHERE channel IN (\$body_channels)
    AND recorded_at > '$GAP_START'
  ORDER BY recorded_at, id
) TO STDOUT;
SQL
REMOTE
```

The ClickHouse materialized view
`analytics.body_measurement_sample_ingest` should ingest these inserted raw rows
into `analytics.body_measurement_sample`.

## 4. Verify the Body Read Model

```bash
ssh dofek-server 'bash -s' <<'REMOTE'
set -euo pipefail
clickhouse=$(docker ps --format '{{.Names}}' | grep dofek_clickhouse | head -1)
docker exec -i "$clickhouse" sh -lc 'clickhouse-client --password "$CLICKHOUSE_PASSWORD"' <<'SQL'
SELECT source, latest, rows FROM
(
  SELECT 'postgres_fitness.metric_stream' AS source, max(recorded_at) AS latest, count() AS rows
  FROM postgres_fitness.metric_stream FINAL
  WHERE channel = 'body_weight'
  UNION ALL
  SELECT 'analytics.body_measurement_sample' AS source, max(recorded_at) AS latest, count() AS rows
  FROM analytics.body_measurement_sample FINAL
  UNION ALL
  SELECT 'analytics.v_body_measurement' AS source, max(recorded_at) AS latest, count() AS rows
  FROM analytics.v_body_measurement
)
ORDER BY source;
SQL
REMOTE
```

Healthy for this incident means all three ClickHouse layers show the same
latest body-weight timestamp as Postgres.

## 5. Final Health Checks

```bash
curl -fsS -w '\nhttp_code=%{http_code} total_time=%{time_total}\n' https://dofek.asherlc.com/healthz
ssh dofek-server 'docker service ls --format "{{.Name}} {{.Replicas}}" | sort'
ssh dofek-server 'uptime'
```

After any mitigation or backfill, append the incident to
`docs/production-incident-baseline.md` with symptoms, evidence, root cause, fix,
remaining risk, and follow-up work.
