# Activity Rollups Runbook

<!-- cspell:ignore Rollups rebuildable rollups hypertables -->

`fitness.*` is the raw source of truth. `analytics.*` contains rebuildable read models
derived from canonical data.

## Purpose

`analytics.activity_training_summary` stores one derived row per canonical activity. It
keeps expensive activity-level training aggregates and histograms out of app request
queries while preserving the raw-data-only rule for `fitness.*`.

This projection does not replace:

- `fitness.metric_stream`
- `fitness.deduped_sensor`
- `fitness.activity_summary`
- activity detail streams
- duration curves that need ordered raw samples

## Safe Rollout

1. Deploy the migration and CLI.
2. Refresh the canonical activity views with the materialized-view maintenance runbook.
3. Enqueue every canonical activity for backfill:

   ```bash
   pnpm tsx src/db/run-activity-rollups.ts enqueue-backfill
   ```

4. Drain in small batches:

   ```bash
   pnpm tsx src/db/run-activity-rollups.ts drain 100
   ```

5. Repeat the drain command until it prints `refreshed=0`.
6. Verify row counts before moving app read paths:

   ```sql
   SELECT count(*) FROM fitness.v_activity;
   SELECT count(*) FROM analytics.activity_training_summary;
   SELECT count(*) FROM analytics.activity_rollup_dirty;
   ```

Only migrate app queries after `activity_training_summary` has the expected activity
count and `activity_rollup_dirty` is empty.

## Rebuild

The projection can be rebuilt from scratch:

```sql
TRUNCATE analytics.activity_training_summary;
```

Then enqueue and drain:

```bash
pnpm tsx src/db/run-activity-rollups.ts enqueue-backfill
pnpm tsx src/db/run-activity-rollups.ts drain 100
```

Repeat the drain command until it prints `refreshed=0`.

## Dirty Queue

The migration adds triggers that mark affected activities dirty when activity rows or
linked metric stream rows change. The trigger only queues work; the refresh happens
when the drain command runs.

The `fitness.metric_stream` insert trigger uses a statement-level transition
table on a Timescale hypertable. Delete and update use row-level triggers because
Timescale does not support delete transition tables on hypertables. Keep
production on TimescaleDB 2.18 or newer; the current deployment image is
`timescale/timescaledb:2.26.2-pg18`.

Use smaller batch sizes during traffic windows if database pressure is elevated.

## Rollback

Do not drop `analytics.*` during an emergency rollback. The tables are derived
projections and can remain unused. If a later app read-path migration needs rollback,
revert the app query change and leave the projection in place.
