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
- Retained WAL for a required slot at or above 12 GiB.
- Active mirrored tables with rows but stale `_peerdb_synced_at`.

It warns on:

- Retained WAL at or above 8 GiB.
- Empty mirrors, which can be valid in staging.

Run it locally with production secrets:

```bash
pnpm check:clickhouse-cdc
```

Do not run this as a deployment gate. Stale mirrors and lost slots are
operational incidents, and blocking unrelated deploys on existing CDC health
makes recovery harder.

The durability control is the production WAL and PeerDB work-unit budget:
Postgres allows six logical slots/senders and caps each slot at 16 GiB, while
PeerDB mirrors use 100,000-row CDC batches and single-worker 100,000-row initial
snapshot partitions. The check is only a manual validation that this budget has
not already been exhausted.

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

## Recovery

1. Identify the affected mirror and its destination tables from
   `src/db/clickhouse-cdc.ts`.
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
   node --experimental-transform-types --enable-source-maps \
     --disable-warning=ExperimentalWarning src/db/setup-clickhouse-cdc.ts
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

7. Rerun `scripts/check-clickhouse-cdc.ts` and verify the user-facing read model.

## Follow-Up

After any lost-slot incident, record the incident in
`docs/production-incident-baseline.md` with the first fatal PeerDB/Postgres log
line, the affected slots, the recovery commands, and whether any large mirror
was restarted without a full resnapshot.
