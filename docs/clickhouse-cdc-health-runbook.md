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
- Retained WAL for a required slot at or above 32 GiB.
- Active mirrored tables with rows but stale `_peerdb_synced_at`.

It warns on:

- Retained WAL at or above 16 GiB.
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
five minutes and atomically records each bounded CDC result. The separate
`processing-reconciliation` service runs one synchronous reconciliation at a
time every 300 seconds. Its script reports failures to Sentry, and its
entrypoint logs a nonzero exit before the next scheduled retry. Reconciliation
does not affect CDC state or delay the next CDC check. The CDC health probe tolerates one
failed report so the next scheduled check can demonstrate recovery, then fails
after a second consecutive failure. A missing or stale result also fails after
one interval plus 60 seconds, covering a stuck monitor. The probe runs every ten
seconds and Docker marks the container unhealthy after three consecutive probe
failures; Swarm then replaces the failed task. Docker documents both
[healthcheck status transitions](https://docs.docker.com/reference/dockerfile/#healthcheck)
and [Swarm task replacement after a failed healthcheck](https://docs.docker.com/engine/swarm/how-swarm-mode-works/services/#tasks-and-scheduling).
Local runs are still useful when actively triaging an incident.

Inspect the latest monitor evidence inside the current task:

```bash
docker exec "$(docker ps --filter name=dofek_cdc-health -q | head -n 1)" \
  cat /tmp/dofek-cdc-health-state.json
```

`lastCheckedAt`, `lastSuccessfulAt`, and `consecutiveFailures` distinguish a
currently failing check from a monitor that stopped updating. A passing check
resets the failure count and updates both timestamps. A separate reconciliation
failure cannot change that CDC state.

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

## Metric-Stream Freshness

`metric_stream` is no longer a PeerDB mirror. Do not recreate
`dofek_metric_stream_analytics` during CDC recovery. Metric-stream freshness is
owned by Redpanda, the Redpanda Connect R2 archive, and
`metric-stream-clickhouse-sink`; use
[`docs/metric-stream-redpanda-r2-runbook.md`](./metric-stream-redpanda-r2-runbook.md)
for freshness checks and replay planning.

Do not run the retired Postgres catch-up script during CDC recovery. It reads
the removed `fitness.metric_stream` path and cannot repair current Redpanda
ingestion.

## Recovery

1. Identify the affected mirror and destination tables:

   | PeerDB mirror | Postgres source tables | ClickHouse destination tables |
   | --- | --- | --- |
   | `dofek_fitness_raw_analytics` | `fitness.activity`, `fitness.sleep_session`, `fitness.sleep_stage`, `fitness.daily_metrics`, `fitness.provider`, `fitness.provider_connection`, `fitness.provider_priority`, `fitness.device_priority`, `fitness.processing_flow_marker`, `fitness.user_profile` | `postgres_fitness.activity`, `postgres_fitness.sleep_session`, `postgres_fitness.sleep_stage`, `postgres_fitness.daily_metrics`, `postgres_fitness.provider`, `postgres_fitness.provider_connection`, `postgres_fitness.provider_priority`, `postgres_fitness.device_priority`, `postgres_fitness.processing_flow_marker`, `postgres_fitness.user_profile` |
   | `dofek_provider_inventory_raw_analytics` | `fitness.food_entry`, `fitness.health_event`, `fitness.lab_panel`, `fitness.lab_result`, `fitness.journal_entry`, `fitness.processing_flow_marker` | `postgres_fitness.food_entry`, `postgres_fitness.health_event`, `postgres_fitness.lab_panel`, `postgres_fitness.lab_result`, `postgres_fitness.journal_entry`, `postgres_fitness.processing_flow_marker_provider_inventory` |
   | `dofek_sensor_priority_raw_analytics` | `fitness.sensor_provider_priority`, `fitness.sensor_device_priority` | `postgres_fitness.sensor_provider_priority`, `postgres_fitness.sensor_device_priority` |

   This mapping matches `src/db/peerdb/metric-stream-cdc.sql` and
   `src/db/clickhouse-cdc.ts`.
2. Drop the affected PeerDB mirror through PeerDB SQL:

   ```sql
   DROP MIRROR dofek_fitness_raw_analytics;
   ```

3. If PeerDB no longer has a catalog row but Postgres still has the lost inactive
   slot for the affected raw-table mirror, drop the orphaned slot directly in
   Postgres:

   ```sql
   SELECT pg_drop_replication_slot('peerflow_slot_dofek_fitness_raw_analytics')
   WHERE EXISTS (
     SELECT 1
     FROM pg_replication_slots
     WHERE slot_name = 'peerflow_slot_dofek_fitness_raw_analytics'
       AND active = false
   );
   ```

4. Truncate only destination tables that will be safely resnapshotted by the
   recreated mirror.
5. Re-run CDC setup through the canonical production deploy workflow. The
   immutable tag passed to `--ref` must point to the validated image's exact
   `SENTRY_RELEASE` commit; the workflow runs the setup image inside the Swarm
   network with production PeerDB, Postgres, and ClickHouse endpoints:

   ```bash
   gh workflow run deploy-web.yml \
     --ref '<immutable-tag-at-image-sentry-release>' \
     -f environment=production \
     -f image_tag='<validated-image-tag>'
   ```

   Do not use a branch or a movable tag for `--ref`: either can advance between
   image validation and workflow dispatch. The deploy workflow also verifies
   the checked-out SHA against the image's `SENTRY_RELEASE` before changing the
   stack.

   Do not use local `pnpm clickhouse-cdc` for production recovery. Its default
   PeerDB endpoint is `127.0.0.1:9900`. GitHub documents source-ref selection
   for manual workflow runs in the
   [`gh workflow run` manual](https://cli.github.com/manual/gh_workflow_run).

6. If setup claims the mirror exists but PeerDB catalog does not list it, check
   Temporal for the exact orphaned workflow from a one-shot admin container on
   the production Swarm network:

   ```bash
   docker --context prod run --rm --network dofek_default \
     --entrypoint temporal temporalio/admin-tools:1.29 \
     --address peerdb-temporal:7233 --namespace default --color never \
     workflow list \
     --query "WorkflowId = 'dofek_fitness_raw_analytics-peerflow'"
   ```

   After confirming that exact workflow is orphaned, terminate it before
   rerunning the canonical deploy:

   ```bash
   docker --context prod run --rm --network dofek_default \
     --entrypoint temporal temporalio/admin-tools:1.29 \
     --address peerdb-temporal:7233 --namespace default --color never \
     workflow terminate \
     --workflow-id dofek_fitness_raw_analytics-peerflow \
     --reason "recover lost Postgres replication slot"
   ```

7. Inspect the next `cdc-health` report, verify the recreated mirror's row
   freshness, and confirm the user-facing read model.

## Follow-Up

After any lost-slot incident, record the incident in
`docs/production-incident-baseline.md` with the first fatal PeerDB/Postgres log
line, the affected slots, the recovery commands, and whether any large mirror
was restarted without a full resnapshot.
