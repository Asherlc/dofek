# Redpanda Metric Stream Replay Plan

## Goal

Make `metric_stream` durable enough to rebuild Postgres and ClickHouse after CDC, database, or ClickHouse failures.

The target architecture is:

1. Providers and mobile imports write metric samples to a Redpanda topic first.
2. Postgres `fitness.metric_stream` consumes from Redpanda and remains the relational app copy.
3. ClickHouse consumes from Redpanda and remains the analytics serving copy.
4. A Redpanda Connect pipeline writes immutable batches to Cloudflare R2 so the Redpanda topic can be replayed long term even if local Redpanda retention or disks fail.

Assumption: "r3" means Cloudflare R2. Self-managed Redpanda tiered storage appears to require Redpanda Enterprise, so this plan uses Redpanda Connect `aws_s3` output to archive the topic to R2 instead of depending on Redpanda tiered storage. If Redpanda Enterprise or Redpanda Cloud is available, the Connect archive pipeline can be replaced by Redpanda tiered storage after a separate approval.

## Current Context

- `src/db/peerdb/metric-stream-cdc.sql` mirrors `fitness.metric_stream` into `postgres_fitness.metric_stream` through PeerDB.
- `src/db/clickhouse-cdc.ts` creates the filtered `peerdb_metric_stream_no_imu` publication.
- `deploy/stack.yml` runs `db`, `clickhouse`, `peerdb-flow-worker`, `cdc-health`, and `analytics-worker`.
- `deploy/storage.tf` already creates R2 buckets for exports, DB backups, OTA, Storybook, and training data.
- `@aws-sdk/client-s3` is already present in root `package.json`.
- Redpanda image version checked on 2026-06-06: `redpandadata/redpanda:v26.1.9`.
- Redpanda Connect docs checked on 2026-06-06: self-managed `aws_s3` output is not enterprise-licensed and supports Cloudflare R2 with `endpoint` and `force_path_style_urls`.
- Redpanda Connect version from current install docs example checked on 2026-06-06: `4.94.1`.

## Invariants

- No dual writes from providers to both Postgres and Redpanda.
- Do not switch additional production metric-stream writers to Redpanda-first until the Postgres sink, ClickHouse sink, and R2 archive path are deployed and validated. HealthKit quantity metric-stream samples now use the Redpanda writer boundary.
- No empty-string absent values.
- Redpanda/R2 message schema is versioned and validated with Zod at every runtime boundary.
- Consumers are idempotent. Replaying the same batch must not duplicate rows.
- ClickHouse analytics must continue reading deduped ClickHouse read models, not raw Postgres.
- Postgres remains canonical for users, providers, activities, tokens, settings, food, and other app state. This plan only changes `fitness.metric_stream`.
- Any R2 object containing canonical replay data must have no lifecycle deletion rule.

## Phase 1: Core Event Model and Producer

Files:

- Add `src/metric-stream/events.ts`
- Add `src/metric-stream/redpanda-producer.ts`
- Add `src/metric-stream/redpanda-producer.test.ts`
- Add `src/metric-stream/write-metric-stream.ts`
- Add `src/metric-stream/write-metric-stream.test.ts`
- Update `packages/server/src/routers/health-kit-sync-processors.ts` to use the Redpanda writer boundary for HealthKit quantity metric-stream samples.

Tasks:

1. Run `pnpm view kafkajs version` and add the current stable Kafka client dependency.
2. Define `MetricStreamEventV1` with the existing row shape: `id`, `recordedAt`, `userId`, `providerId`, `externalId`, `deviceId`, `sourceType`, `channel`, `activityId`, `scalar`, `vector`, `point`, `metadata`.
3. Add a Zod parser for producer input and consumer input.
4. Add `writeMetricStreamRows()` as the single production API for inserting metric-stream rows.
5. Unit-test that `writeMetricStreamRows()` publishes Redpanda events and does not write directly to Postgres when Redpanda publishing succeeds.
6. Leave non-HealthKit production writers on Postgres until Phase 5 cutover.

Validation:

- `pnpm vitest run src/metric-stream/write-metric-stream.test.ts`
- Existing HealthKit router tests use a mocked metric-stream publisher for unit coverage.

## Phase 2: Postgres Sink

Files:

- Add `src/metric-stream/postgres-sink.ts`
- Add `src/metric-stream/postgres-sink.test.ts`
- Update `src/index.ts` to add command `metric-stream-postgres-sink`
- Update `deploy/stack.yml` to add service `metric-stream-postgres-sink`

Tasks:

1. Consume `metric-stream-v1` from Redpanda with consumer group `metric-stream-postgres-sink`.
2. Insert into `fitness.metric_stream` in batches.
3. Use `ON CONFLICT (id, recorded_at) DO NOTHING` or the actual existing primary/unique key after confirming the table definition.
4. Commit Redpanda offsets only after the Postgres transaction commits.
5. Surface unexpected errors to Sentry and exit loudly on missing env vars.

Validation:

- Unit test idempotent duplicate handling.
- Integration test with local Postgres and a mocked Kafka client boundary.
- Manual local smoke test with Docker Redpanda once Phase 4 adds the service.

## Phase 3: ClickHouse Sink

Files:

- Add `src/metric-stream/clickhouse-sink.ts`
- Add `src/metric-stream/clickhouse-sink.test.ts`
- Update `src/index.ts` to add command `metric-stream-clickhouse-sink`
- Update `deploy/stack.yml` to add service `metric-stream-clickhouse-sink`
- Update `docs/clickhouse-cdc-health-runbook.md`

Tasks:

1. Consume `metric-stream-v1` from Redpanda with consumer group `metric-stream-clickhouse-sink`.
2. Insert non-IMU rows into `postgres_fitness.metric_stream`, preserving current analytics source table names.
3. Preserve current PeerDB metadata columns with deterministic values suitable for non-PeerDB ingestion.
4. Commit Redpanda offsets only after ClickHouse confirms insert success.
5. Keep `src/db/peerdb/metric-stream-cdc.sql` in place until parity has been proven, then remove the metric-stream mirror in a later cleanup.

Validation:

- Unit test mapping from `MetricStreamEventV1` to ClickHouse insert rows.
- Integration test against local ClickHouse for idempotent replay.
- `pnpm analytics:build` after seeded sink rows.

## Phase 4: Redpanda Connect R2 Archive and Replay

Files:

- Add `src/metric-stream/r2-replay.ts`
- Add `src/metric-stream/r2-replay.test.ts`
- Add `scripts/replay-metric-stream-from-r2.ts`
- Add `scripts/check-metric-stream-replay-health.ts`
- Add `deploy/redpanda/metric-stream-r2-archive.connect.yml`
- Update `deploy/stack.yml` to add service `metric-stream-r2-archive`
- Update `deploy/storage.tf` to add `cloudflare_r2_bucket.metric_stream_archive`
- Add `docs/metric-stream-redpanda-r2-runbook.md`
- Update `docs/README.md`

Tasks:

1. Create dedicated bucket `dofek-metric-stream-archive` in R2.
2. Configure Redpanda Connect to consume `metric-stream-v1` and write immutable gzip-compressed JSONL batches to:
   `metric-stream/v1/date=YYYY-MM-DD/hour=HH/<topic>-<partition>-<firstOffset>-<lastOffset>.jsonl.gz`
3. Use Redpanda Connect metadata and object naming to preserve topic, partition, and offset range.
4. Rely on Redpanda Connect back pressure and output acknowledgement semantics so offsets are not advanced before R2 writes succeed.
5. Add replay script that reads a bounded R2 prefix and replays to Redpanda, Postgres, or ClickHouse explicitly selected by CLI flag.
6. Add health script that checks Redpanda consumer lag, newest R2 archive object, Postgres freshness, ClickHouse freshness, and sink error counters.

Validation:

- Unit test object key parsing, checksum validation, and bounded replay filtering.
- Dry-run `scripts/replay-metric-stream-from-r2.ts` against fixture R2-compatible local mock.
- Production smoke check must show archive freshness within one batch interval before any PeerDB metric-stream mirror is disabled.

## Phase 5: Production Infra

Files:

- Update `deploy/stack.yml`
- Update `deploy/README.md`
- Update remaining direct writers after sinks and archive are live:
  - `packages/server/src/routers/activity-recording.ts`
  - `src/providers/strava.ts`
  - `src/providers/ride-with-gps.ts`
  - `src/providers/coros.ts`
  - `src/providers/polar/sync-service.ts`
  - `src/providers/fitbit/persisters.ts`
  - Provider files found by `rg "insert\\(metricStream\\)|INSERT INTO fitness.metric_stream|delete\\(metricStream\\)" src packages/server`
- Update Infisical production secrets before deploy:
  - `REDPANDA_BROKERS`
  - `METRIC_STREAM_TOPIC`
  - `METRIC_STREAM_R2_BUCKET`
  - `R2_ENDPOINT`
  - existing `R2_ACCESS_KEY_ID`
  - existing `R2_SECRET_ACCESS_KEY`

Tasks:

1. Add `redpanda` service using pinned `redpandadata/redpanda:v26.1.9`.
2. Mount Redpanda data under `/mnt/dofek-data/redpanda`.
3. Add a Redpanda healthcheck.
4. Add sink workers and Redpanda Connect archive service with explicit env vars.
5. Keep PeerDB metric-stream CDC running during initial production shadow validation.
6. Switch production direct writers to `writeMetricStreamRows()` only after the sink and archive services are healthy.
7. Run production shadow validation comparing Redpanda-sourced ClickHouse rows with PeerDB-sourced rows over a bounded recent window.

Validation:

- `docker compose config` or equivalent Swarm config validation for `deploy/stack.yml`.
- `terraform -chdir=deploy plan` for R2 bucket change.
- Production health script reports:
  - Redpanda reachable.
  - Postgres sink lag under threshold.
  - ClickHouse sink lag under threshold.
  - R2 archive object fresh.
  - `analytics.daily_strain` has recent non-zero candidate inputs when user data exists.

## Phase 6: Cutover and Cleanup

Files:

- Update `src/db/peerdb/metric-stream-cdc.sql`
- Update `src/db/clickhouse-cdc.ts`
- Update `scripts/check-clickhouse-cdc.ts`
- Update `docs/clickhouse-cdc-health-runbook.md`
- Update `docs/production-incident-baseline.md`

Tasks:

1. Stop new reliance on the PeerDB metric-stream mirror only after Redpanda, Postgres sink, ClickHouse sink, and Redpanda Connect R2 archive have passed shadow validation.
2. Remove metric-stream from PeerDB health expectations.
3. Keep PeerDB for lower-volume Postgres-to-ClickHouse tables if still useful.
4. Add incident-baseline entry summarizing the architectural fix and replay validation.

Validation:

- A bounded R2 replay into a temporary ClickHouse table recreates the same row count/checksum for a recent hour.
- Postgres and ClickHouse can be rebuilt for a bounded range from R2 archive without reading the original production Postgres table.

## Rollback

1. Disable `writeMetricStreamRows()` Redpanda-first mode by reverting the writer migration commit.
2. Keep PeerDB metric-stream mirror active until cutover validation passes.
3. Redpanda sink workers and the Redpanda Connect archive service can be stopped without affecting current PeerDB CDC during shadow mode.
4. R2 archive objects are append-only and do not need rollback.

## Open Decision

Confirmed: self-managed Redpanda Enterprise or Redpanda Cloud is not assumed. Use Redpanda Connect to archive the topic to R2 as the canonical long-term replay store.
