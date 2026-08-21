# Retiring the Postgres metric stream

Tracks the completed work to remove `fitness.metric_stream` from Postgres.
Metric-stream samples now flow provider/mobile → Redpanda → ClickHouse sink +
R2 archive; Postgres is no longer a metric-stream source or sink.

## Current state

- **Writers:** off Postgres. `db/metric-stream-writer.ts` only publishes to
  Redpanda (`publishRows`/`replaceRows`); the Postgres sink was removed.
- **`fitness.metric_stream` (Postgres):** retired and dropped. Historical rows
  were exported to R2 before the destructive migration.
- **ClickHouse serving copy:** `ingest.metric_stream`, fed by the
  Redpanda `metric-stream-clickhouse-sink` (non-IMU only). Source for
  `analytics.deduped_sensor` and all downstream dbt sensor models. **Kept.**
- **PeerDB PG→CH metric_stream mirror:** retired. The ClickHouse serving table
  is fed by Redpanda, not Postgres CDC.
- **R2 archive:** every channel (incl. `imu`) archived as
  `metric-stream/v1/date=…/hour=…/*.jsonl.gz`. Only data written *after* the
  Redpanda cutover is present in the live stream; the historical Postgres rows
  were backfilled separately (see "Historical backfill" below).

## Historical backfill (Postgres → R2 direct export)

The live archive only held post-cutover data, so the historical
`fitness.metric_stream` rows were exported to R2 before the table was dropped.

Backfilling *through the Redpanda topic* risks duplicate R2 objects: the live
archiver names objects by Kafka offset range, so any re-published row (e.g. a
crash-retry) lands under a new offset = a second copy, and R2 has no read-side
dedup (row-level dedup lives in ClickHouse on the deterministic event id). The
bounded single-node topic also can't buffer hundreds of GB.

Historical rows were written **straight to R2**, bypassing the topic, by the
now-removed one-time exporter:

- Output is byte-compatible with the live archive: each line is
  `JSON.stringify(createMetricStreamEvent(row))`, gzipped, partitioned by
  `date=/hour=`, keyed `metric-stream-v1-0-{first}-{last}.jsonl.gz` (matches
  `r2-replay.ts`'s `ARCHIVE_KEY_PATTERN`). Parity is unit-tested against the
  producer's serialization in `r2-export.test.ts`.
- Object keys are **deterministic** (derived from a (date,hour) bucket's own
  rows under a byte budget, never from offsets), so re-running a window
  overwrites the same objects rather than duplicating them — the property that
  keeps R2 free of duplicate rows under retries.
- It streams via `MetricStreamArchiveChunker` (one open object in memory) so it
  runs safely as a one-shot container on the memory-constrained production host.
- Run window must stay **below the live-stream cutoff** (earliest recordedAt
  already in the topic/R2) so it never overlaps already-archived data.
- The `Backfill metric_stream to R2` GitHub Actions workflow and one-time export
  code were removed after the backfill completed.

## Historical implementation plan

> The remaining sections are the original transition plan. They are retained
> as decision history, not as current instructions. The completed
> implementation chose `ingest.metric_stream`, not the proposed
> `metric_stream.events`, and current readers must follow the code and active
> runbooks.

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

## P2 — Delete IMU debug pages (resolved: delete, not repoint)

The original plan was to repoint the IMU debug reads at an R2 object-coverage
signal. That turned out to be infeasible: the R2 archive keys are
`metric-stream/v1/date=…/hour=…/{topic}-{partition}-{first}-{last}.jsonl.gz` —
partition/offset-scoped, so one object batches **all users and all channels**
together. The IMU reads are user-scoped and IMU-channel-scoped, so object
listing (no decompress) cannot reproduce them, and IMU is excluded from
ClickHouse (`channel !== "imu"`), so there is no fast user/channel-scoped
source. The pages are debug/observability only, so they were **deleted**
outright rather than rebuilt on a heavier read path.

Done:

1. Deleted the read/debug path: `routers/inertial-measurement-unit.ts`,
   `repositories/inertial-measurement-unit-repository.ts` (the last
   `fitness.metric_stream` reader), web `InertialMeasurementUnitPage.tsx` +
   route, mobile `app/inertial-measurement-unit.tsx`, the settings nav link, and
   their tests; removed the `inertialMeasurementUnit` router registration.
2. Kept the **ingest** path (`inertialMeasurementUnitSync`, mobile sync
   services/adapters) — IMU still flows provider/watch → Redpanda → R2 archive.
   Raw IMU remains queryable from R2 if observability is ever rebuilt
   deliberately (on object-content reads or by adding `imu` to the CH sink).
3. Left the live on-device WHOOP BLE orientation screen (`imu-visualization`)
   untouched — it reads the native module, not `metric_stream`.

## P3 — Drop Postgres metric_stream + cleanup

Done:

1. Retired the PeerDB metric_stream CDC mirror; ClickHouse is fed by Redpanda.
2. Deleted one-time backfill/export code after the R2 backfill completed.
3. Added the Drizzle migration that drops `fitness.metric_stream` and removed
   the table from `schema.ts`.
4. Removed Postgres-shaped metric-stream writer/schema code while keeping the
   Redpanda event types.
5. Updated docs and regenerated schema diagrams.

## Validation gates (every P)

- `pnpm lint`, `pnpm test:unit`, relevant `*.integration.test.ts`, all-package
  `tsc --noEmit`.
- Integration tests run against real Postgres + ClickHouse (`docker compose up -d
  db clickhouse redis`); never mock the DB for SQL/query changes.
- Each PR small, TDD, dual-platform parity (web + mobile).
