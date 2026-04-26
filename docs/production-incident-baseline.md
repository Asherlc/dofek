# Production Incident Baseline

This document summarizes production failure modes observed so far. It is not a
full incident log or a replacement for runbooks. Use it to build shared memory
about the kinds of issues this system encounters, the signals that identified
them, and the durability work they suggest.

## 2026-04-25: Materialized View Refresh Saturated Production

### Impact

Production became effectively unavailable:

- Public `/healthz` and `/` requests timed out without a useful response.
- Direct host checks accepted TCP but did not return normal HTTP responses.
- SSH to the host timed out during banner exchange.
- Dashboard routes depending on activity/training analytics failed when
  materialized views were missing or unpopulated.

### What Happened

A deploy path triggered materialized-view sync work in production. The refresh
attempt involved heavy full-history work for views such as
`fitness.deduped_sensor`, `fitness.activity_summary`, and `fitness.provider_stats`.
Those views read from the large `fitness.metric_stream` hypertable.

The dangerous behavior was the combination of:

- automatic deploy-triggered materialized-view maintenance;
- destructive drop/create rebuild behavior for existing views;
- asynchronous refresh acceptance without waiting for a verified successful end
  state;
- a small single-node production host with a 2 GiB DB container memory cap;
- large historical `metric_stream` data and indexes;
- concurrent dashboard queries, materialized-view refreshes, and Timescale
  maintenance competing for the same DB resources.

When the refresh failed or was canceled, production could be left with missing
or stale materialized-view state. Follow-up repair required inspecting
`pg_matviews`, `pg_indexes`, active sessions, lock waits, and the
`drizzle.__view_hashes` metadata.

### Evidence That Mattered

Useful signals:

- External health checks timed out from both the public domain and direct host.
- Axiom showed `[views-refresh] Started` / accepted refresh logs without a
  matching completion log.
- Postgres logs showed missing `fitness.deduped_sensor` and
  `fitness.activity_summary` relations.
- Active sessions showed materialized-view refreshes, lock waits, and long
  dashboard queries blocking each other.
- `pg_stat_statements` and slow statement logs helped identify `metric_stream`
  as the main heavy table, although OOM-killed statements may not survive long
  enough to appear clearly in cumulative stats.

### Root Cause

Normal deploy/runtime paths could start full-history materialized-view
maintenance against live production data. That work was expensive enough to
saturate or OOM the small DB host, and the destructive rebuild path could remove
serving views before replacements were safely available.

### Fixes Applied

- Deploy no longer silently proceeds when materialized-view maintenance is
  required.
- Existing changed materialized views are no longer dropped/rebuilt
  automatically by `syncMaterializedViews()`.
- Missing views can still be created, but definition drift now requires explicit
  maintenance.
- A blocking materialized-view maintenance CLI and runbook were added, including
  quiet-DB preflight and a concurrent-refresh inventory.
- Production materialized-view metadata and missing indexes/views were repaired.
- Blocking materialized-view refresh fallback was removed in the follow-up PR.
- `metric_stream` was converted to a compressed Timescale workload:
  - compression enabled;
  - segment by `user_id, provider_id, channel`;
  - order by `recorded_at DESC`;
  - compression policy for chunks older than 7 days;
  - existing old chunks manually backfilled.
- Migrations were compacted into `drizzle/0000_baseline.sql`, with explicit
  Timescale setup preserved because schema dumps do not capture hypertable
  registration as ordinary table DDL.
- A runbook was added for `metric_stream` Timescale maintenance.

### Remaining Risks

- Materialized-view definition changes still require a safe planned maintenance
  workflow. The system now refuses dangerous automatic rebuilds, but the manual
  path should become blocking, observable, and bounded.
- Full-history analytical SQL can still overwhelm the single-node DB if run
  without limits.
- Compression reduces storage and IO pressure but does not solve unbounded raw
  data growth.
- The current architecture needs explicit retention policy decisions before a
  larger beta.
- Backups exist operationally, but point-in-time restore and restore drills
  should be proven separately.

### Lessons

- Hypertables do not make data smaller by themselves. Compression, retention,
  chunk sizing, and query shape determine whether large time-series data is
  operationally safe.
- Full-history maintenance must not run as an invisible side effect of normal
  deploys.
- An async `202 Accepted` maintenance endpoint is not a durability guarantee.
  It must be paired with completion tracking and post-condition checks.
- Canceling individual DB backends is only a temporary recovery action if the
  process issuing the work is still alive and can restart it.
- Compression backfill and materialized-view refresh should not run together;
  they compete for locks, IO, CPU, and memory.
- `pg_dump`-based migration compaction needs explicit checks for Timescale
  metadata and materialized-view population state.

## Patterns To Watch

### Long-Running DB Work During Deploy

Symptoms:

- deploy appears stuck after migrations or stack update;
- `/healthz` slows or times out;
- Axiom has a start log without a done/fail log;
- `pg_stat_activity` shows long-running `REFRESH MATERIALIZED VIEW`,
  `CREATE MATERIALIZED VIEW`, compression, migration, or dashboard SQL.

Rule of thumb: identify the first fatal/blocking DB statement before changing
deploy behavior. Do not add retries, sleeps, or longer timeouts until the
blocking SQL is understood.

### Missing Or Unpopulated Materialized Views

Symptoms:

- dashboard/API errors mention missing relations;
- `pg_matviews.ispopulated = false`;
- planner reports view maintenance required;
- stored hashes do not match canonical `drizzle/_views` definitions.

Treat this as a repair/maintenance incident, not a reason to re-enable
automatic drop/create rebuilds.

### Unbounded Time-Series Storage

Symptoms:

- `metric_stream` dominates database size;
- indexes are close to table data size;
- future-dated chunks appear;
- compression policy leaves unexpected chunks uncompressed;
- dashboard queries scan wide historical ranges.

Compression is a mitigation. Retention and rollups are the slope-changing fix.

Current product constraint: raw data should not be permanently deleted. That
means the long-term mitigation is not simple deletion from Postgres. The likely
roadmap direction is a three-tier storage model:

- recent raw data stays in Postgres/Timescale for detailed app queries, sync
  repair, and deduplication;
- durable rollups stay in Postgres for long-range and year-over-year charts;
- old raw data is archived immutably to object storage such as R2, with
  manifests, checksums, schema versions, and rehydration metadata.

Before old raw rows leave the hot DB, the system must verify that required
rollups exist for that range and that the cold archive has been written and
read back successfully. This is roadmap work, not an immediate mitigation.

### Maintenance Jobs Fighting Each Other

Symptoms:

- compression waits on relation locks;
- materialized-view refresh and chunk compression run at the same time;
- active writer chunks resist compression;
- inserts queue behind metadata/DDL locks.

Maintenance should be serialized with advisory locks or an explicit maintenance
window. Record resistant chunks and retry later instead of forcing active writer
chunks under live traffic.

### Single-Node Capacity Limits

Symptoms:

- DB memory approaches the container cap during analytical work;
- SSH and Traefik degrade together with Postgres;
- worker fanout can enqueue more write work than the DB can absorb;
- one user's import/sync can dominate the host.

This is the main reason broader beta readiness requires global DB backpressure,
retention, restore drills, and capacity tests.

## Follow-Up Durability Work

Prioritized next work:

1. Continue hardening the materialized-view maintenance workflow with restore
   drills and production rehearsal notes.
2. Design the hot-rollup-cold storage roadmap for `metric_stream`: hot raw
   retention, durable rollups for long-range charts, and cold raw archive in R2
   or equivalent object storage.
3. Add point-in-time recovery with WAL archiving and a restore drill.
4. Add global sync/import backpressure across all BullMQ queues, separate from
   per-provider API rate limits.
5. Convert simple time-bucketed summaries to Timescale continuous aggregates
   where the query shape fits.
6. Add a synthetic capacity test for 10, 50, and 100 active users.
7. Document migration compaction steps, including Timescale and materialized-view
   verification.

## Related Docs

- [deploy/README.md](../deploy/README.md): production architecture, deploy flow,
  DB diagnostics, and rollback boundaries.
- [metric-stream-timescaledb-runbook.md](metric-stream-timescaledb-runbook.md):
  Timescale conversion, compression, and chunk backfill maintenance.
- [materialized-view-maintenance-runbook.md](materialized-view-maintenance-runbook.md):
  blocking materialized-view maintenance, preflight, and refresh inventory.
- [schema.md](schema.md): materialized-view and continuous-aggregate modeling
  rules.
- [ci-debugging.md](ci-debugging.md): CI/deploy log inspection patterns.
