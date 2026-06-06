---
name: diagnose-cdc
description: "Diagnose PeerDB Postgres-to-ClickHouse CDC health (replication slot status, mirror row counts vs Postgres source, and dbt read-model freshness) for the three Dofek flows: dofek_metric_stream_analytics, dofek_fitness_raw_analytics, dofek_provider_inventory_raw_analytics. Use when the web shows partial/empty data for recent activities, when read models look stale, or after a large migration."
---

# Diagnose CDC

Use this skill when activity pages, dashboards, or any ClickHouse-backed view show empty or stale data for rows that exist in Postgres. The most common cause is a broken PeerDB CDC flow, not the read-model SQL.

## Signals that point here

- A specific activity page (e.g. `/activity/<id>`) loads `activity.byId` but `activity.stream`, `activity.hrZones`, `activity.powerZones` return empty / all-null aggregates.
- "No heart rate zone data" / missing Performance / missing Route Map for a recent activity that has data on the provider side (Strava, Garmin, WHOOP).
- Dashboards that read from `analytics.v_activity`, `analytics.activity_summary`, `analytics.deduped_sensor`, `analytics.deduped_location` show stale or missing rows.
- The deploy that introduced the regression involved a large migration / backfill that churned WAL.

## 1) Check Postgres replication slot health

Lost slots are the most common failure mode. WAL files are gone, so the slot can never recover on its own.

```bash
ssh dofek-server 'docker exec $(docker ps --format "{{.Names}}" | grep -E "dofek[_-]db" | head -1) bash -lc "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -c \"SELECT slot_name, active, wal_status, restart_lsn, confirmed_flush_lsn FROM pg_replication_slots ORDER BY slot_name;\""'
```

Healthy looks like `active = t`, `wal_status = 'reserved'`, non-null `restart_lsn`. Broken looks like `active = f`, `wal_status IN ('lost', 'unreserved')`, empty `restart_lsn`.

For repeat slot-loss incidents, also capture the WAL budget and lag:

```bash
ssh dofek-server 'docker exec $(docker ps --format "{{.Names}}" | grep -E "^dofek_db" | head -1) bash -lc "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -P pager=off -c \"SHOW max_slot_wal_keep_size; SELECT slot_name, active, wal_status, safe_wal_size, pg_size_pretty(safe_wal_size) AS safe_wal_size_pretty, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS retained_lag FROM pg_replication_slots ORDER BY slot_name;\""' 
```

If `retained_lag` exceeds `max_slot_wal_keep_size`, the lost slot is explained by a PeerDB outage or write burst outlasting the configured WAL budget. Treat that as a recurring durability problem, not just a mirror-resync task.

The three Dofek slots:

- `peerflow_slot_dofek_metric_stream_analytics` — feeds `postgres_fitness.metric_stream`.
- `peerflow_slot_dofek_fitness_raw_analytics` — feeds `postgres_fitness.activity`, plus the rest of `fitness.*` mirror tables.
- `peerflow_slot_dofek_provider_inventory_raw_analytics` — feeds `postgres_fitness.provider_inventory_*` mirrors.

## 2) Check PeerDB worker logs for the actual error

```bash
ssh dofek-server 'docker logs $(docker ps --format "{{.Names}}" | grep peerdb-flow-worker | head -1) --since 24h 2>&1 | grep -iE "error|SQLSTATE" | tail -30'
```

Look for `SQLSTATE 55000` ("can no longer access replication slot") — confirms the slot is lost. Other PeerDB-specific errors (peer connection failures, ClickHouse insert errors, schema drift) point to different remediation paths.

## 3) Compare row counts: Postgres source vs ClickHouse mirror

For each suspected mirror table:

```bash
# Postgres (source of truth)
ssh dofek-server 'docker exec $(docker ps --format "{{.Names}}" | grep -E "dofek[_-]db" | head -1) bash -lc "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -c \"SELECT count(*), max(started_at) FROM fitness.activity;\""'

# ClickHouse mirror
ssh dofek-server "docker exec \$(docker ps --format '{{.Names}}' | grep -E 'dofek_clickhouse' | head -1) clickhouse-client -q \"SELECT count(), toString(max(_peerdb_synced_at)) FROM postgres_fitness.activity FINAL WHERE _peerdb_is_deleted = 0\""
```

If `max(_peerdb_synced_at)` is hours/days behind `max(started_at)` from Postgres, CDC is stalled or stopped for that flow. Run the same comparison for `fitness.metric_stream` ↔ `postgres_fitness.metric_stream` and any other affected mirror.

## 4) Check whether ClickHouse read models are catching up

Some read models are normal ClickHouse views, while expensive derived tables are
incremental dbt models populated by the `analytics-worker` service. First check
the worker logs:

```bash
ssh dofek-server 'docker service logs --tail 100 dofek_analytics-worker'
```

Then inspect the dbt-owned target tables directly:

```sql
-- ClickHouse
SELECT max(refreshed_at) FROM analytics.deduped_sensor;
SELECT max(refreshed_at) FROM analytics.resting_heart_rate_sleep_window;
```

If these timestamps are current but rows are missing, the upstream mirror or raw
source data is the problem. If timestamps are stale, debug `analytics-worker`
and run `dbt build --project-dir analytics --profiles-dir analytics --select
sensor_scalar_sample deduped_sensor resting_heart_rate_sleep_window` from a
configured app container.

The relevant read models:

- `analytics.v_activity` — reads `postgres_fitness.activity`, `provider_priority`, `device_priority`.
- `analytics.v_activity_members` — reads `analytics.v_activity`.
- `analytics.sensor_scalar_sample` — dbt microbatch staging table over scalar `postgres_fitness.metric_stream`, event-timed by `recorded_at`.
- `analytics.deduped_sensor` — dbt microbatch table over `analytics.sensor_scalar_sample`, event-timed by `recorded_at`.
- `analytics.deduped_location` — same, location channel only.
- `analytics.activity_summary` — aggregates the above per `activity_id`.
- `analytics.resting_heart_rate_sleep_window` — dbt incremental table for resting heart rate.

Because every read model `INNER JOIN`s `v_activity_members`, a missing row in `postgres_fitness.activity` cascades to empty results in all of them, even if `postgres_fitness.metric_stream` has the samples.

## 5) Decide between slot recreate vs full mirror resync

- **`wal_status = 'lost'`**: no recovery option from Postgres side. The slot must be dropped and recreated. Whether that requires a full ClickHouse mirror resnapshot depends on data volume and how stale the mirror is.
- **`wal_status = 'unreserved'`** (slot still has retention room but is inactive): the slot may recover on its own once PeerDB reconnects — try restarting `dofek_peerdb-flow-worker` first.
- **PeerDB peer errors** (network, auth, schema drift): no slot recreate needed; fix the underlying connectivity / schema issue and restart the flow.

## 6) Remediation (lost slot)

This is destructive on the PeerDB side — confirm with the user before running.

For each broken flow:

1. Drop the broken slot in Postgres:

   ```sql
   SELECT pg_drop_replication_slot('peerflow_slot_dofek_<flow_name>');
   ```

2. In the PeerDB UI / API, "Resync" the corresponding mirror. This will:
   - Create a fresh logical replication slot.
   - Take an initial snapshot of the source tables into the ClickHouse mirror.
   - Resume CDC from the new slot's start LSN.

3. For the `metric_stream` flow specifically, prefer the bounded catch-up script
   before a full `metric_stream` resnapshot when the missing range is known:

   ```bash
   pnpm catch-up:metric-stream -- --start <utc-start> --end <utc-end> --execute
   ```

   This direct-inserts non-IMU `fitness.metric_stream` rows into
   `postgres_fitness.metric_stream` for an explicit half-open window and skips
   ids already present in ClickHouse. It repairs recent analytics input but does
   not recreate the lost PeerDB slot; the mirror still needs a fresh slot.

4. Verify the mirrors fill in (`count(*)` matches Postgres within tolerance) and that `analytics.v_activity` / `analytics.deduped_sensor` repopulate within ~1 refresh interval.

## 7) Prevent the next occurrence

- Production currently caps each slot at `max_slot_wal_keep_size=64GB`.
  Investigate before increasing it again; unlimited (`-1`) requires reliable
  disk monitoring and slot-lag alerting.
- Keep the `cdc-health` service running so `pg_replication_slots.wal_status IN
  ('lost', 'unreserved')`, inactive slots, stale mirrors, and high retained-WAL
  thresholds are continuously surfaced to logs/Sentry.
- Add a heartbeat that compares Postgres `fitness.activity` row count to `postgres_fitness.activity FINAL` row count and alarms if they diverge.
- Record the incident in `docs/production-incident-baseline.md` with timestamps, evidence, root cause, and follow-up actions.

If this is not the first lost-slot incident, do not stop at recreating the mirror. Record the observed `max_slot_wal_keep_size`, slot lag, and the first PeerDB fatal line, then propose one of:

- Increase the bounded WAL budget if the host disk budget can absorb it.
- Set `max_slot_wal_keep_size=-1` only if disk monitoring and slot-lag alerting are already reliable enough to prevent filling the data volume.
- Replace or supplement PeerDB for high-volume `metric_stream` with a bounded direct backfill/catch-up path that can restore recent rows without relying on an old logical slot.
- Add a scheduled CDC health check/alert using `scripts/check-clickhouse-cdc.ts` or an equivalent monitor, because dashboard correctness depends on this mirror freshness.
