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

## Local Validation

Start dependencies before integration tests:

```bash
docker compose up -d db redis clickhouse
docker compose ps db redis clickhouse
```

Run the normal gates:

```bash
pnpm lint
pnpm test:changed
pnpm tsc --noEmit
cd packages/server && pnpm tsc --noEmit
cd packages/web && pnpm tsc --noEmit
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
