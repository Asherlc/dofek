# ClickHouse CDC Health Runbook

Use this when dashboards or analytics read models look stale while Postgres
source tables are current, or when `scripts/check-clickhouse-cdc.ts` fails.

## Prevention

`scripts/check-clickhouse-cdc.ts` checks the required PeerDB logical replication
slots and selected active ClickHouse mirrors.

It fails on:

- Any required PeerDB slot with `wal_status = 'lost'`.
- Any required PeerDB slot with `restart_lsn IS NULL`.
- Any required PeerDB slot that is inactive.
- Retained WAL for a required slot at or above 48 GiB.
- Active mirrored tables with rows but stale `_peerdb_synced_at`.

It warns on:

- Retained WAL at or above 32 GiB.
- Empty mirrors, which can be valid in staging.

Run it locally with production secrets:

```bash
pnpm check:clickhouse-cdc
```

Do not run this as a deployment gate. Stale mirrors and lost slots are
operational incidents, and blocking unrelated deploys on existing CDC health
makes recovery harder.

The durability control is the production WAL and PeerDB work-unit budget:
Postgres allows six logical slots/senders and caps each slot at 64 GiB, while
PeerDB mirrors use 100,000-row CDC batches and single-worker 100,000-row initial
snapshot partitions. The production `cdc-health` service runs this check every
five minutes and reports failures to logs/Sentry; local runs are still useful
when actively triaging an incident.

## Triage

Confirm source Postgres has fresher rows than ClickHouse:

```sql
SELECT count(*), max(started_at), max(ended_at)
FROM fitness.sleep_session;
```

```sql
SELECT count(), max(_peerdb_synced_at), max(started_at), max(ended_at)
FROM postgres_fitness.sleep_session
WHERE _peerdb_is_deleted = 0;
```

Check slot state:

```sql
SELECT
  slot_name,
  active,
  wal_status,
  restart_lsn,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots
WHERE slot_name LIKE 'peerflow_slot_dofek_%'
ORDER BY slot_name;
```

If `wal_status = 'lost'`, retries and container restarts cannot recover the slot.
Recreate the affected mirror from a fresh slot and then backfill or resnapshot
the affected ClickHouse destination tables.

## Bounded Metric-Stream Catch-Up

For `dofek_metric_stream_analytics`, repair the recent missing ClickHouse rows
from Postgres directly before considering a full `metric_stream` resnapshot. The
catch-up path inserts non-IMU rows from `fitness.metric_stream` into
`postgres_fitness.metric_stream` for an explicit half-open UTC window, skips ids
already present in ClickHouse, and leaves PeerDB slot recreation as a separate
step.

Dry-run the planned windows first:

```bash
pnpm catch-up:metric-stream -- --start 2026-06-03T21:57:00Z --end 2026-06-05T23:59:59Z
```

Execute only after verifying the source window and the expected affected user or
activity:

```bash
pnpm catch-up:metric-stream -- --start 2026-06-03T21:57:00Z --end 2026-06-05T23:59:59Z --execute
```

If the range is large, keep the default one-hour windows or set
`--window-minutes` lower. Increase `--max-windows` only after confirming the
range is intentionally broad.

After catch-up, run the bounded analytics build so the route-facing tables
consume the repaired rows:

```bash
dbt build --project-dir analytics --profiles-dir analytics --threads 1 --select sensor_scalar_sample deduped_sensor activity_sensor_sample activity_summary_rows daily_activity_load daily_strain
```

## Recovery

1. Identify the affected mirror and destination tables:

   | PeerDB mirror | Postgres source tables | ClickHouse destination tables |
   | --- | --- | --- |
   | `dofek_metric_stream_analytics` | `fitness.metric_stream` | `postgres_fitness.metric_stream` |
   | `dofek_fitness_raw_analytics` | `fitness.activity`, `fitness.sleep_session`, `fitness.sleep_stage`, `fitness.daily_metrics`, `fitness.provider`, `fitness.provider_priority`, `fitness.device_priority`, `fitness.user_profile` | `postgres_fitness.activity`, `postgres_fitness.sleep_session`, `postgres_fitness.sleep_stage`, `postgres_fitness.daily_metrics`, `postgres_fitness.provider`, `postgres_fitness.provider_priority`, `postgres_fitness.device_priority`, `postgres_fitness.user_profile` |
   | `dofek_provider_inventory_raw_analytics` | `fitness.food_entry`, `fitness.health_event`, `fitness.lab_panel`, `fitness.lab_result`, `fitness.journal_entry` | `postgres_fitness.food_entry`, `postgres_fitness.health_event`, `postgres_fitness.lab_panel`, `postgres_fitness.lab_result`, `postgres_fitness.journal_entry` |
   | `dofek_sensor_priority_raw_analytics` | `fitness.sensor_provider_priority`, `fitness.sensor_device_priority` | `postgres_fitness.sensor_provider_priority`, `postgres_fitness.sensor_device_priority` |

   This mapping matches `src/db/peerdb/metric-stream-cdc.sql` and
   `src/db/clickhouse-cdc.ts` as of commit `ec487f3`.
2. Drop the affected PeerDB mirror through PeerDB SQL:

   ```sql
   DROP MIRROR dofek_fitness_raw_analytics;
   ```

3. If PeerDB no longer has a catalog row but Postgres still has the lost inactive
   slot, drop the orphaned slot directly in Postgres:

   ```sql
   SELECT pg_drop_replication_slot('peerflow_slot_dofek_metric_stream_analytics')
   WHERE EXISTS (
     SELECT 1
     FROM pg_replication_slots
     WHERE slot_name = 'peerflow_slot_dofek_metric_stream_analytics'
       AND active = false
   );
   ```

4. Truncate only destination tables that will be safely resnapshotted by the
   recreated mirror. Do not truncate `postgres_fitness.metric_stream` during an
   urgent dashboard freshness fix unless a bounded metric-stream backfill plan is
   ready.
5. Run the checked-in setup path:

   ```bash
   ./scripts/with-env.sh tsx src/db/setup-clickhouse-cdc.ts
   ```

6. If setup claims the mirror exists but PeerDB catalog does not list it, check
   Temporal for an orphaned workflow:

   ```bash
   temporal --address peerdb-temporal:7233 --namespace default \
     workflow list --query "WorkflowId = 'dofek_metric_stream_analytics-peerflow'"
   ```

   Terminate the orphaned workflow before rerunning setup:

   ```bash
   temporal --address peerdb-temporal:7233 --namespace default \
     workflow terminate \
     --workflow-id dofek_metric_stream_analytics-peerflow \
     --reason "recover lost Postgres replication slot"
   ```

7. Rerun `pnpm check:clickhouse-cdc` and verify the user-facing read model.

## Follow-Up

After any lost-slot incident, record the incident in
`docs/production-incident-baseline.md` with the first fatal PeerDB/Postgres log
line, the affected slots, the recovery commands, and whether any large mirror
was restarted without a full resnapshot.
