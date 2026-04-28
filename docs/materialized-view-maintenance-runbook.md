# Materialized View Maintenance Runbook

This runbook covers planned materialized-view maintenance in production. It is
for explicit maintenance windows, not normal deploys.

## Operating Rules

- Do not drop and recreate existing production materialized views during normal
  deploy or app startup.
- Do not run materialized-view refresh while Timescale compression backfill,
  chunk migration, or other full-history database maintenance is active.
- Prefer `REFRESH MATERIALIZED VIEW CONCURRENTLY` for every populated canonical
  view listed below.
- Run one heavy view at a time.
- Treat an async `202 Accepted` maintenance response as insufficient evidence.
  A maintenance run is done only when the command exits successfully and the
  post-checks pass.

## Maintenance Command

The repo-owned entry point is:

```bash
pnpm tsx src/db/run-materialized-view-maintenance.ts <command>
```

Commands:

```bash
pnpm tsx src/db/run-materialized-view-maintenance.ts inventory
pnpm tsx src/db/run-materialized-view-maintenance.ts preflight
pnpm tsx src/db/run-materialized-view-maintenance.ts refresh fitness.v_daily_metrics
pnpm tsx src/db/run-materialized-view-maintenance.ts cancel-refreshes fitness.provider_stats
pnpm tsx src/db/run-materialized-view-maintenance.ts rebuild fitness.provider_stats
pnpm tsx src/db/run-materialized-view-maintenance.ts sync
```

`refresh <view>` waits for one concurrent refresh to finish. It holds the same
Postgres advisory lock used by materialized-view sync, sets a short lock timeout,
sets a statement timeout, and prints the final duration.

`sync` runs the quiet-DB preflight and then runs `syncMaterializedViews()` as a
blocking command. This is the path used by manual deploys when
`refresh_materialized_views=true`.

`cancel-refreshes <view>` cancels active `REFRESH MATERIALIZED VIEW` statements
for the selected canonical view.

`rebuild <view>` is the explicit maintenance-window path for an existing
canonical materialized view whose definition changed. It holds the same advisory
lock, runs the quiet-DB preflight, drops the named view with `CASCADE`, recreates
it from `drizzle/_views`, and records the new hash.

## GitHub Manual Action

For the common production case, use **Actions → Materialized View Maintenance →
Run workflow**. The defaults run against production and rebuild
`fitness.provider_stats` from the `latest` image. Override `image_tag` only when
you need maintenance to run from a specific deployed image tag.

The workflow:

1. checks that Postgres is writable;
2. prints the current materialized-view sync plan;
3. cancels active refreshes for the selected canonical materialized view;
4. rebuilds the selected canonical materialized view;
5. runs the normal blocking materialized-view sync; and
6. fails if the planner still reports `required=true`.

## Production One-Shot Command

Run the maintenance command from the deployed image attached to the swarm network:

```bash
timeout 50m docker run --rm --network dofek_default \
  --env-file .env.prod \
  --entrypoint sh \
  ghcr.io/asherlc/dofek:<tag> \
  -euc 'export DATABASE_URL="postgres://health:${POSTGRES_PASSWORD}@db:5432/health"; exec node --experimental-transform-types src/db/run-materialized-view-maintenance.ts preflight'
```

Replace `preflight` with `inventory`, `sync`, `refresh <view-name>`,
`cancel-refreshes <view-name>`, or `rebuild <view-name>` as needed. Use the
exact image tag being deployed or investigated.

## Quiet Database Preflight

Run this before any planned materialized-view maintenance:

```bash
pnpm tsx src/db/run-materialized-view-maintenance.ts preflight
```

The preflight fails if:

- Postgres is in recovery;
- another session is waiting on a lock.

The preflight warns if long-running maintenance-like work is active, including:

- `REFRESH MATERIALIZED VIEW`;
- Timescale chunk compression/decompression;
- continuous aggregate refresh;
- long `metric_stream` scans.

Manual checks to run around the scripted preflight:

```sql
SELECT pg_is_in_recovery();

SELECT schemaname, matviewname, ispopulated
FROM pg_matviews
WHERE schemaname = 'fitness'
ORDER BY matviewname;

SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'fitness'
  AND tablename IN (
    'v_activity',
    'v_sleep',
    'v_body_measurement',
    'v_daily_metrics',
    'deduped_sensor',
    'activity_summary',
    'provider_stats'
  )
ORDER BY tablename, indexname;

SELECT view_name,
       left(hash, 12) AS hash,
       left(dependency_fingerprint_hash, 12) AS dependency_hash,
       applied_at
FROM drizzle.__view_hashes
ORDER BY view_name;
```

Host checks:

```bash
df -h /mnt/dofek-data
docker service ps dofek_db
docker stats --no-stream
curl -fsS https://dofek.fit/healthz
```

Do not proceed if the database is in recovery, there are lock waits, free disk is
already in the danger zone, or another full-history maintenance job is running.

## Concurrent Refresh Inventory

All canonical materialized views currently have a unique index that can support
`REFRESH MATERIALIZED VIEW CONCURRENTLY`, assuming the view exists and is already
populated.

| View | Unique index | Risk | Notes |
|------|--------------|------|-------|
| `fitness.v_activity` | `v_activity_id_idx` | Medium | Activity de-duplication uses recursive overlap logic. |
| `fitness.v_sleep` | `v_sleep_id_idx` | Medium | Sleep de-duplication uses recursive overlap logic. |
| `fitness.v_body_measurement` | `v_body_measurement_id_idx` | Low | Smaller body measurement de-duplication view. |
| `fitness.v_daily_metrics` | `v_daily_metrics_date_idx` | Medium | Dashboard-facing daily metric priority view. |
| `fitness.deduped_sensor` | `deduped_sensor_pk` | High | Scans metric stream data and joins activity data. |
| `fitness.activity_summary` | `activity_summary_pk` | High | Depends on deduped sensor data and windowed calculations. |
| `fitness.provider_stats` | `provider_stats_user_provider_idx` | High | Aggregates across many tables, including metric stream data. |

`CONCURRENTLY` keeps readers available, but it does not make the refresh cheap.
The high-risk views still scan large history and can consume meaningful CPU, IO,
memory, and temporary disk.

## Planned Refresh Procedure

1. Confirm the maintenance reason:

   ```bash
   pnpm tsx src/db/run-view-sync-planner.ts
   ```

2. Run the inventory and preflight:

   ```bash
   pnpm tsx src/db/run-materialized-view-maintenance.ts inventory
   pnpm tsx src/db/run-materialized-view-maintenance.ts preflight
   ```

3. Refresh one view at a time for direct view refreshes:

   ```bash
   pnpm tsx src/db/run-materialized-view-maintenance.ts refresh fitness.v_daily_metrics
   ```

4. For deploy/manual sync maintenance, use the blocking sync command:

   ```bash
   pnpm tsx src/db/run-materialized-view-maintenance.ts sync
   ```

   For a definition change on an existing view, rebuild that one view first:

   ```bash
   pnpm tsx src/db/run-materialized-view-maintenance.ts rebuild fitness.provider_stats
   pnpm tsx src/db/run-materialized-view-maintenance.ts sync
   ```

5. Record the run in `.context/` with:

   - date and operator;
   - command used;
   - image tag or commit SHA;
   - preflight output;
   - start/end timestamps;
   - final `synced`, `skipped`, `refreshed`, or `duration_ms` output.

6. Validate:

   ```sql
   SELECT schemaname, matviewname, ispopulated
   FROM pg_matviews
   WHERE schemaname = 'fitness'
   ORDER BY matviewname;
   ```

   ```bash
   pnpm tsx src/db/run-view-sync-planner.ts
   curl -fsS https://dofek.fit/healthz
   ```

The planner should report `required=false` unless the change requires deeper
definition maintenance that cannot be completed by refresh alone.

## If Maintenance Fails

First capture evidence:

- exact command;
- first fatal line;
- active sessions and lock waits;
- Postgres logs around the failure;
- `pg_matviews.ispopulated` state;
- current disk and memory pressure.

Do not rerun immediately if the failure was resource pressure, lock waits, or
recovery mode. Stop and identify the blocking query or database state first.

If a populated view refresh fails, the old view remains available. If an
unpopulated view exists after an interrupted create or recovery event, use the
blocking `sync` path after the quiet-DB preflight and inspect the logs carefully.

## Rollup Candidates

These are the realistic candidates for future continuous aggregates or explicit
rollup tables. They are not all immediate changes.

Good candidates:

- `metric_stream` time buckets by `user_id`, `provider_id`, `channel`, and day
  or hour, storing count, first/last sample time, min, max, average, and sum
  where the channel is additive.
- Long-range chart rollups by `user_id`, `channel`, and day for year-over-year
  comparisons after old raw data moves to cold storage.
- The `metric_stream` portion of `provider_stats`, so provider statistics do not
  need to count raw stream rows from scratch.
- Simple daily activity totals after de-duplication is resolved, if the source
  query can be expressed as stable grouped time buckets.

Poor candidates for direct continuous aggregates:

- `v_activity`, `v_sleep`, and `v_body_measurement`, because they encode
  provider-priority and overlap de-duplication logic.
- `deduped_sensor`, because it is a de-duplication view over raw streams and
  activity windows, not a simple time bucket.
- `activity_summary`, because it depends on windowed GPS/altitude calculations
  and de-duplicated sensor streams.
- `v_daily_metrics`, because it chooses the best source by provider priority
  rather than simply aggregating rows.

Near-term recommendation: keep these as roadmap work. The first useful rollup is
a daily `metric_stream` rollup that supports long-range charts and cold-storage
verification without changing ingestion semantics.
