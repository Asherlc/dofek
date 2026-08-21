# ClickHouse Body Measurement Staleness Runbook

Use this when a recent body weight or other body measurement is absent from a
ClickHouse-backed API response.

The current path is:

```text
provider/mobile writer
  -> Redpanda metric-stream-v1
  -> metric-stream-clickhouse-sink
  -> ClickHouse ingest.metric_stream
  -> analytics.body_measurement_sample_ingest
  -> analytics.body_measurement_sample
  -> dbt analytics.body_measurement
  -> analytics.v_body_measurement / analytics.daily_body_measurement
```

Postgres `fitness.metric_stream` and the PeerDB metric-stream mirror are
retired. Do not query or repair either one.

## 1. Capture the Failure

Before changing state, record:

1. The missing measurement's user, provider, channel, and expected timestamp.
2. The first fatal log line from the sink or analytics worker.
3. Freshness at every ClickHouse layer below.

Use a narrow time range and user/provider filter when available. The broad
query below is an initial freshness check, not proof that one user's row
exists:

```bash
ssh dofek-server 'bash -s' <<'REMOTE'
set -euo pipefail
clickhouse=$(docker ps --format '{{.Names}}' | grep dofek_clickhouse | head -1)
docker exec -i "$clickhouse" sh -lc 'clickhouse-client --password "$CLICKHOUSE_PASSWORD"' <<'SQL'
SELECT source, latest, rows
FROM
(
  SELECT 'ingest.metric_stream' AS source, max(recorded_at) AS latest, count() AS rows
  FROM ingest.metric_stream FINAL
  WHERE is_deleted = 0 AND channel = 'body_weight'

  UNION ALL

  SELECT 'analytics.body_measurement_sample', max(recorded_at), count()
  FROM analytics.body_measurement_sample FINAL
  WHERE _peerdb_is_deleted = 0 AND channel = 'body_weight'

  UNION ALL

  SELECT 'analytics.v_body_measurement', max(recorded_at), count()
  FROM analytics.v_body_measurement

  UNION ALL

  SELECT 'analytics.daily_body_measurement', max(toDate(date)), count()
  FROM analytics.daily_body_measurement FINAL
  WHERE is_deleted = 0
)
ORDER BY source;
SQL
REMOTE
```

Also capture service state and recent errors:

```bash
ssh dofek-server 'docker service ps dofek_metric-stream-clickhouse-sink --no-trunc'
ssh dofek-server 'docker service ps dofek_analytics-worker --no-trunc'
ssh dofek-server 'docker service logs --since 30m dofek_metric-stream-clickhouse-sink 2>&1'
ssh dofek-server 'docker service logs --since 30m dofek_analytics-worker 2>&1'
```

## 2. Classify the Broken Layer

### Raw row missing from `ingest.metric_stream`

Check Redpanda sink consumer lag and the R2 archive freshness using
[metric-stream-redpanda-r2-runbook.md](metric-stream-redpanda-r2-runbook.md).

- If the required offsets remain in Redpanda, fix the evidenced sink failure
  and let the existing consumer group catch up.
- If the offsets have expired, stop. Bounded R2 replay automation is not
  currently shipped; implement and validate that recovery path rather than
  copying from retired Postgres storage.

### Raw row present, projection row missing

First confirm that `analytics.body_measurement_sample_ingest` exists and points
at `ingest.metric_stream`:

```sql
SHOW CREATE TABLE analytics.body_measurement_sample_ingest;
```

Current migrations recreate that materialized view. After the view is healthy,
use the checked-in bounded repair script to count only missing projection rows:

```bash
pnpm backfill:body-measurements -- \
  --start "<start>" \
  --end "<end>"
```

Copy `<start>` and `<end>` from the incident evidence captured above. The
command is a dry run unless `--execute` is supplied. Verify the incident-specific
window and missing-row count before executing:

```bash
pnpm backfill:body-measurements -- \
  --start "<start>" \
  --end "<end>" \
  --execute
```

Run the command only in an approved environment whose `CLICKHOUSE_URL` targets
the intended deployment. Keep the interval as small as the evidence allows.
The script anti-joins on row ID and version, so it inserts only missing or
outdated projection rows.

### Projection row present, serving model missing

Inspect the analytics worker's first failing dbt step. Fix that model or
prerequisite before rebuilding. For local validation, the canonical command is:

```bash
pnpm analytics:build
```

That command uses the local `dev` dbt target; it is not a production repair
command. In production, confirm the deployed `analytics-worker` completes its
next scheduled cycle after the source repair. Do not add retries, refresh loops,
or request-time fallback queries. The `body_measurement` and
`daily_body_measurement` models are incremental and must advance through the
normal analytics worker/release path.

## 3. Check Active ClickHouse Work

If the host is saturated, record active work before cancelling anything:

```sql
SELECT
  query_id,
  elapsed,
  formatReadableSize(read_bytes) AS read_bytes,
  formatReadableSize(memory_usage) AS memory,
  left(query, 220) AS query
FROM system.processes
WHERE query NOT LIKE '%system.processes%'
ORDER BY elapsed DESC
LIMIT 20;
```

Cancel a query only after identifying it as the failing or runaway operation
and preserving its ID and first fatal evidence:

```sql
KILL QUERY WHERE query_id = '<query-id>' SYNC;
```

Cancelling work is containment, not the root-cause fix.

## 4. Verify

Rerun the layer-freshness query and the user/provider/time-bounded query that
reproduced the missing row. Healthy means:

- the expected live row exists in `ingest.metric_stream`;
- the same ID/version exists in `analytics.body_measurement_sample`;
- `analytics.v_body_measurement` contains the canonical measurement;
- any affected daily consumer contains the expected date;
- the API response and both clients show the same server-computed value.

Finally check service and application health:

```bash
curl -fsS https://dofek.asherlc.com/healthz
ssh dofek-server 'docker service ls --format "{{.Name}} {{.Replicas}}" | sort'
```

Append production incidents to
`docs/production-incident-baseline.md` with symptoms, user impact, exact
evidence, root cause, fix, validation, remaining risk, and follow-up work.
