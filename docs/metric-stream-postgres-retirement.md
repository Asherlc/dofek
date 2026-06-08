# Retiring the Postgres metric stream

Tracks the work to remove `fitness.metric_stream` from Postgres. Metric-stream
samples now flow provider/mobile → Redpanda → ClickHouse sink + R2 archive;
Postgres is no longer a metric-stream source or sink. This plan migrates the
remaining readers off Postgres so the table (and the PeerDB mirror that fed it)
can be dropped.

## Current state

- **Writers:** off Postgres. `db/metric-stream-writer.ts` only publishes to
  Redpanda (`publishRows`/`replaceRows`); the Postgres sink was removed.
- **`fitness.metric_stream` (Postgres):** frozen — receives no new rows. Readers
  below are serving stale data for anything written after the cutover.
- **ClickHouse serving copy:** `postgres_fitness.metric_stream`, fed by the
  Redpanda `metric-stream-clickhouse-sink` (non-IMU only). Source for
  `analytics.deduped_sensor` and all downstream dbt sensor models. **Kept.**
- **PeerDB PG→CH metric_stream mirror:** legacy shadow-validation path. To be
  retired (redundant with the Redpanda sink; impossible once the PG table is
  gone).
- **R2 archive:** every channel (incl. `imu`) archived as
  `metric-stream/v1/date=…/hour=…/*.jsonl.gz`.

## Naming decision

The ClickHouse table lives in `postgres_fitness` (a schema of genuine PeerDB
mirrors of `fitness.*`), but metric_stream is now Redpanda-fed, not a PG mirror.
Move just that table to its own home:

- **New name: `metric_stream.events`** (dedicated schema; parallels topic
  `metric-stream-v1`). Keeps the `_peerdb_is_deleted/_version/_synced_at`
  ReplacingMergeTree columns the dbt models expect.

## Readers to migrate (API-serving, read `fitness.metric_stream`)

| Reader | Channels | New source |
| --- | --- | --- |
| `routers/heart-rate.ts` | `heart_rate` (scalar) | `metric_stream.events` |
| `repositories/health-kit-sync-repository.ts` (SpO2, skin temp → daily_metrics) | scalar | `metric_stream.events` |
| `repositories/provider-detail-repository.ts` | counts/range per provider | `metric_stream.events` |
| `repositories/inertial-measurement-unit-repository.ts` | `imu`/IMU vectors | R2 object-coverage (see P2) |

IMU is excluded from ClickHouse by the sink (`channel !== "imu"`) and is ~97% of
the table. The IMU pages (web `/inertial-measurement-unit`, mobile
`app/inertial-measurement-unit.tsx`) are **debug/observability** ("are we
receiving + storing IMU"), so they don't need raw samples — only presence/volume
per day, served cheaply from R2 object listing.

---

## P0 — Rename CH `postgres_fitness.metric_stream` → `metric_stream.events`

Prerequisite for P1 (readers should land on the final name once).

1. Bootstrap DDL (`src/db/clickhouse-metric-stream-bootstrap.ts`): create
   `metric_stream.events` (same columns/engine); keep helper that returns the
   statements.
2. `clickhouse-sink.ts`: insert target → `metric_stream.events`. Update the
   narrow insert interface table literal + integration test.
3. dbt: update the source feeding `deduped_sensor.sql` (and any model/source
   yml referencing `postgres_fitness.metric_stream`) to `metric_stream.events`.
   Run `pnpm lint:analytics-policy` + `pnpm lint:analytics-sql`.
4. CH migration: `RENAME TABLE postgres_fitness.metric_stream TO
   metric_stream.events` (metadata-only on ReplacingMergeTree). Coordinate with
   sink cutover (deploy sink + DDL together; rename is fast).
5. Delete-scope SQL (`clickhouse-sink.ts` delete path) → new table.
6. Validate: integration test inserts a row, dbt `deduped_sensor` still builds,
   dashboards (recovery/strain) unaffected.

## P1 — Migrate scalar readers to ClickHouse  ← starting now

Each reader: failing test first (integration against real CH), then swap query.

1. `routers/heart-rate.ts`: `heart_rate` 1-min downsample → query
   `metric_stream.events` (dedup with `FINAL` / `_peerdb_is_deleted = 0`).
2. `repositories/health-kit-sync-repository.ts`: SpO2 + wrist-temp daily
   aggregation reads → ClickHouse. (Writes to `daily_metrics` unchanged.)
3. `repositories/provider-detail-repository.ts`: per-provider counts/time-range
   → ClickHouse.
4. Drop the `fitness.v_metric_stream` materialized view + any other PG
   metric_stream views/indexes once no reader references them.
5. Dual-platform: no client query shape change expected (server returns same
   payload); verify web + mobile pages still render.

## P2 — IMU debug pages → R2 coverage

The IMU repo's hot reads are debug-only. Replace raw PG reads with a cheap R2
object-coverage signal (no full scan, no decompress, no dedup needed).

1. New read path: list R2 objects under `metric-stream/v1/date=…` (Cloudflare R2
   S3 API or ClickHouse `s3()` listing of `_path`/`_size`), aggregate by day →
   presence + bytes. "Receiving" = recent objects; "storing" = bytes/day.
2. Repoint `inertialMeasurementUnitRouter` (`getDailyHeatmap`,
   `getCoverageTimeline`, `getSyncStatus`) at the R2-coverage source.
3. Delete `InertialMeasurementUnitRepository`'s `fitness.metric_stream` queries.
4. Dual-platform: update web `InertialMeasurementUnitPage.tsx` + mobile
   `app/inertial-measurement-unit.tsx` only if response shape changes; keep it
   stable to avoid client churn.

## P3 — Drop Postgres metric_stream + cleanup

Only after P0–P2 are merged and verified, and the historical backfill is complete.

1. Retire PeerDB metric_stream CDC mirror (so CH is fed only by Redpanda).
2. Delete `scripts/backfill-metric-stream-to-redpanda.ts` + its test (one-time
   PG→Redpanda migration; source is being dropped).
3. Drizzle migration: drop `fitness.metric_stream` (+ remaining views, indexes,
   any leftover triggers). Remove from `schema.ts`.
4. Remove `MetricStreamSourceRow`/PG-shaped types that only described the PG
   table; keep the Redpanda event types (`events.ts`).
5. Docs: update `metric-stream-redpanda-r2-runbook.md` + `schema.md` to reflect
   the dropped table; regenerate schema diagrams.

## Validation gates (every P)

- `pnpm lint`, `pnpm test:unit`, relevant `*.integration.test.ts`, all-package
  `tsc --noEmit`.
- Integration tests run against real Postgres + ClickHouse (`docker compose up -d
  db clickhouse redis`); never mock the DB for SQL/query changes.
- Each PR small, TDD, dual-platform parity (web + mobile).
