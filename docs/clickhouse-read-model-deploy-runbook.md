# ClickHouse Read Model Deploy Runbook

This runbook covers deploy failures involving ClickHouse CDC, ClickHouse
analytics read models, or legacy Postgres fitness view DDL. It exists because
normal deploys must not rebuild hot Postgres read models.

## Rules

- Do not add deploy-time Postgres `CREATE OR REPLACE VIEW`, `DROP VIEW`, or
  materialized-view refresh work for hot fitness read models.
- Do not restore `refresh_materialized_views` deploy inputs or post-sync
  refresh hooks as a shortcut.
- Use ClickHouse-native `postgres_fitness.*` mirror tables and `analytics.*`
  read models for sensor and fitness analytics paths.
- Missing CDC prerequisites must fail loudly with explicit table or column
  names.
- Capture the failing step, the first fatal log line, and the causal chain
  before changing code.

## Fast Triage

Inspect the deploy with `gh`:

```bash
gh run view <run-id> --repo Asherlc/dofek --json status,conclusion,url,jobs
gh run view <run-id> --repo Asherlc/dofek --job <job-id> --log
```

The important deploy steps are:

1. `Run migrations`
2. `Deploy stack`
3. `Wait for PeerDB`
4. `Configure ClickHouse CDC`

If the job times out, identify the last active step and inspect both GitHub
logs and server state before retrying.

## Known Failure: PeerDB Destination Validation

Symptom:

```text
invalid mirror: rpc error: code = FailedPrecondition desc = failed to validate destination connector ... not all PeerDB columns found in destination table <table>
```

Cause:

The ClickHouse destination table does not match the columns PeerDB expects. For
Postgres-to-ClickHouse mirrors, every mirrored raw table must include the PeerDB
metadata columns used by the mirror:

- `_peerdb_synced_at`
- `_peerdb_is_deleted`
- `_peerdb_version`

Fix pattern:

1. Add the missing columns to the ClickHouse raw mirror DDL.
2. Add or update tests that assert the mirror table includes PeerDB metadata.
3. Rerun the deploy; do not bypass CDC setup.

## Known Failure: Deploy Migration Timeout

Symptom:

```text
Migration exceeded 3300s
```

Possible causal SQL:

```sql
CREATE OR REPLACE VIEW fitness.v_daily_metrics AS ...
```

Diagnosis:

Check for blocked DDL and lock queues on Postgres. SSH is allowed for reading
logs and state only; do not edit server config manually.

Useful read-only checks:

```sql
SELECT pid,
       wait_event_type,
       wait_event,
       state,
       now() - query_start AS age,
       left(query, 250) AS query
FROM pg_stat_activity
WHERE state <> 'idle'
ORDER BY query_start;

SELECT blocked.pid AS blocked_pid,
       blocked_activity.query AS blocked_query,
       blocking.pid AS blocking_pid,
       blocking_activity.query AS blocking_query
FROM pg_locks blocked
JOIN pg_stat_activity blocked_activity ON blocked_activity.pid = blocked.pid
JOIN pg_locks blocking
  ON blocking.locktype = blocked.locktype
 AND blocking.database IS NOT DISTINCT FROM blocked.database
 AND blocking.relation IS NOT DISTINCT FROM blocked.relation
 AND blocking.page IS NOT DISTINCT FROM blocked.page
 AND blocking.tuple IS NOT DISTINCT FROM blocked.tuple
 AND blocking.virtualxid IS NOT DISTINCT FROM blocked.virtualxid
 AND blocking.transactionid IS NOT DISTINCT FROM blocked.transactionid
 AND blocking.classid IS NOT DISTINCT FROM blocked.classid
 AND blocking.objid IS NOT DISTINCT FROM blocked.objid
 AND blocking.objsubid IS NOT DISTINCT FROM blocked.objsubid
 AND blocking.pid <> blocked.pid
JOIN pg_stat_activity blocking_activity ON blocking_activity.pid = blocking.pid
WHERE NOT blocked.granted
ORDER BY blocked_activity.query_start;
```

Fix pattern:

1. Remove deploy-time Postgres view DDL for hot read models.
2. Move the read model to ClickHouse if it belongs to the fitness analytics
   path.
3. Keep Postgres migrations forward-only and cheap.
4. Rerun the deploy from the branch after local validation.

## Known Failure: `provider_stats` Current-State Scan Timeout

Symptom:

```text
Code: 159, e.displayText() = DB::Exception: Timeout exceeded: elapsed ...
```

The analytics worker logs the model name and the ClickHouse query log records
the authoritative duration, rows, bytes, and exception code. ClickHouse's
[`system.query_log`](https://clickhouse.com/docs/operations/system-tables/query_log)
is the source of truth for this diagnosis; do not infer the cause from the
worker's retry cadence.

Capture service state and the first fatal log line without changing production
state. The deploy runbook uses the OCI host in the `ORACLE_SERVER_HOST`
GitHub Actions variable ([production host configuration](../deploy/README.md)):

```bash
oracle_host=$(gh variable get ORACLE_SERVER_HOST --repo Asherlc/dofek)
ssh ubuntu@"$oracle_host" 'docker service ps --no-trunc dofek_analytics-worker'
ssh ubuntu@"$oracle_host" 'docker service logs --since 2h --raw --timestamps dofek_analytics-worker 2>&1'
```

Inspect the exact model query and its resource footprint from the ClickHouse
container:

```bash
ssh ubuntu@"$oracle_host" 'bash -s' <<'REMOTE'
set -euo pipefail
clickhouse=$(docker ps --format '{{.Names}}' | grep dofek_clickhouse | head -1)
test -n "$clickhouse"
docker exec -i "$clickhouse" sh -lc 'clickhouse-client --password "$CLICKHOUSE_PASSWORD"' <<'SQL'
SELECT
  event_time,
  type,
  query_duration_ms,
  read_rows,
  formatReadableSize(read_bytes) AS read_bytes,
  memory_usage,
  exception_code,
  left(exception, 240) AS exception,
  query_id
FROM system.query_log
WHERE event_time >= now() - INTERVAL 6 HOUR
  AND positionCaseInsensitive(query, 'model.dofek_analytics.provider_stats') > 0
  AND type IN ('ExceptionWhileProcessing', 'QueryFinish')
ORDER BY event_time DESC
LIMIT 50;
SQL
REMOTE
```

Check whether the current-state projection is present on every active raw
table part. A newly created projection is maintained for new inserts, but
existing parts require an explicit
[`MATERIALIZE PROJECTION`](https://clickhouse.com/docs/data-modeling/projections#filtering-on-columns-which-arent-in-the-primary-key)
operation:

```bash
ssh ubuntu@"$oracle_host" 'bash -s' <<'REMOTE'
set -euo pipefail
clickhouse=$(docker ps --format '{{.Names}}' | grep dofek_clickhouse | head -1)
docker exec -i "$clickhouse" sh -lc 'clickhouse-client --password "$CLICKHOUSE_PASSWORD"' <<'SQL'
SELECT
  countIf(NOT has(projections, 'by_provider_current_state')) AS missing_projection_parts,
  count() AS active_parts
FROM system.parts
WHERE active
  AND database = 'ingest'
  AND table = 'metric_stream';

SELECT
  name,
  rows,
  formatReadableSize(bytes_on_disk) AS bytes_on_disk,
  has(projections, 'by_provider_current_state') AS has_current_state_projection
FROM system.parts
WHERE active
  AND database = 'ingest'
  AND table = 'metric_stream'
ORDER BY rows DESC
LIMIT 20;

SELECT
  user_id,
  provider_id,
  changed_at,
  refreshed_at
FROM analytics.provider_change_watermark FINAL
WHERE changed_at > refreshed_at
ORDER BY changed_at ASC
LIMIT 50;
SQL
REMOTE
```

Interpret the evidence in this order:

1. If active parts are missing `by_provider_current_state`, materialize that
   projection as an approved maintenance operation, monitor the mutation to
   completion, and rerun the same query. The existing projection rollout is
   documented in [clickhouse-metric-stream.md](clickhouse-metric-stream.md).
2. If the projection is present but `provider_stats` still reads tens of
   millions of current-state IDs before reaching the existing execution
   boundary, the projection is working but is not a compact per-provider
   count. The exact count remains proportional to the dirty provider's
   current record cardinality. This is a read-model design problem, not a
   reason to raise `max_execution_time`, add retries, or force a larger memory
   budget; ClickHouse documents that setting as an execution limit, not a
   query optimization ([`max_execution_time`](https://clickhouse.com/docs/operations/settings/settings#max_execution_time)).
3. Record the model-specific failure fingerprint and leave the dirty watermark
   visible until a dbt-owned compact provider-count source is implemented and
   validated against tombstones and replacements. The split design calls for
   that compact source explicitly ([slow-query optimization design](superpowers/specs/2026-06-04-slow-query-optimization-split-design.md)).

Never mark the refresh successful merely because the worker retries. Verify
the next `QueryFinish` row, the analytics processing marker, and the affected
read-model freshness before closing the incident.

## Local Validation

Start dependencies before integration tests:

```bash
pnpm compose:up
pnpm compose -- ps db redis clickhouse redpanda
```

Run the normal gates:

```bash
pnpm lint
pnpm test:changed
pnpm typecheck
pnpm test:changed:all
```

ClickHouse-heavy integration tests create isolated raw mirror databases and
refresh read models. If local ClickHouse starts returning `socket hang up`
during concurrent setup, verify the test configuration is not running those
files in parallel and restart ClickHouse only after preserving the first fatal
test command.

## Deploy Retry

After committing and pushing the fix branch:

```bash
gh workflow run "Deploy" --repo Asherlc/dofek --ref <branch> -f target=web-stack
gh run watch <run-id> --repo Asherlc/dofek --interval 20 --exit-status
```

Successful evidence must include:

- Docker image build success.
- `Run migrations` success.
- `Deploy stack` success.
- `Configure ClickHouse CDC` success.
- Production health check:

```bash
curl -fsS https://dofek.asherlc.com/healthz
```

Record the incident in `docs/production-incident-baseline.md` with symptoms,
impact, evidence, root cause, fix, remaining risk, and follow-up work.
