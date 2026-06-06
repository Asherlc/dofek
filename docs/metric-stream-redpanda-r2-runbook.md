# Metric Stream Redpanda and R2 Runbook

Use this after the Redpanda metric-stream replay path is deployed. Until then,
`fitness.metric_stream` still writes through Postgres and PeerDB still mirrors
non-IMU rows into ClickHouse.

## Purpose

`fitness.metric_stream` is high-volume sensor data. A single Postgres logical
replication slot is not durable enough for this table because a lost slot can
leave ClickHouse stale even while Postgres still has fresh source rows.

The target durable path is:

```text
provider/mobile import
  -> Redpanda topic metric-stream-v1
  -> Postgres sink -> fitness.metric_stream
  -> ClickHouse sink -> postgres_fitness.metric_stream
  -> Redpanda Connect archive -> Cloudflare R2
```

R2 is the long-term replay store for metric-stream events. Postgres remains the
relational app copy, and ClickHouse remains the analytics serving copy. Both are
rebuildable from Redpanda/R2 for bounded ranges after the cutover is complete.

## Canonical Storage Policy

- `metric-stream-v1` is the hot ingest log.
- `dofek-metric-stream-archive` is the long-term replay archive in Cloudflare R2.
- The R2 metric-stream archive must not have lifecycle deletion rules.
- Redpanda local retention is a buffering and operations setting, not the
  long-term source of truth.
- Postgres remains canonical for users, providers, activities, tokens, settings,
  food, and other app state. This runbook only changes metric-stream samples.
- If Redpanda self-managed tiered storage is later enabled, verify the license
  first. Redpanda documents self-managed tiered storage as Enterprise-gated.

## Required Services

| Service | Purpose |
| --- | --- |
| `redpanda` | Kafka-compatible hot ingest log. |
| `metric-stream-postgres-sink` | Consumes `metric-stream-v1` and writes `fitness.metric_stream`. |
| `metric-stream-clickhouse-sink` | Consumes `metric-stream-v1` and writes non-IMU rows to `postgres_fitness.metric_stream`. |
| `metric-stream-r2-archive` | Redpanda Connect pipeline that writes immutable batches to R2. |
| `analytics-worker` | Rebuilds dbt-owned ClickHouse analytics read models from ClickHouse source tables. |

## Required Secrets

Store these in Infisical before enabling the services:

| Secret | Example | Notes |
| --- | --- | --- |
| `REDPANDA_BROKERS` | `redpanda:9092` | Comma-separated broker list. |
| `METRIC_STREAM_TOPIC` | `metric-stream-v1` | Topic for versioned metric-stream events. |
| `METRIC_STREAM_R2_BUCKET` | `dofek-metric-stream-archive` | Dedicated archive bucket. |
| `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` | Cloudflare R2 S3-compatible endpoint. |
| `R2_ACCESS_KEY_ID` | n/a | Existing R2 S3 credential. |
| `R2_SECRET_ACCESS_KEY` | n/a | Existing R2 S3 credential. |

Missing secrets must fail service startup. Do not use blank defaults.

## R2 Object Layout

Archive objects use partitioned prefixes:

```text
metric-stream/v1/date=YYYY-MM-DD/hour=HH/<topic>-<partition>-<first-offset>-<last-offset>.jsonl.gz
```

Each object contains newline-delimited JSON events. Every event must validate
against `MetricStreamEventV1` from `src/metric-stream/events.ts`.

Required event fields:

- `version`
- `id`
- `recordedAt`
- `userId`
- `providerId`
- `sourceType`
- `channel`
- `externalId`
- `deviceId`
- `activityId`
- `scalar`
- `vector`
- `point`
- `metadata`

Use `null` for absent optional values. Do not write empty strings as absent
values.

## Redpanda Connect Archive Expectations

The archive service should use Redpanda Connect with:

- `redpanda` input consuming `metric-stream-v1`.
- `aws_s3` output targeting Cloudflare R2.
- `endpoint` set to `R2_ENDPOINT`.
- `force_path_style_urls: true`.
- `region: auto`.
- gzip compression on batches.
- object keys that preserve topic, partition, and offset range.

Redpanda Connect documents `aws_s3` as self-managed and non-enterprise, and it
documents Cloudflare R2 support through custom endpoint and path-style settings.

## Freshness Checks

Run the health script once implemented:

```bash
pnpm tsx scripts/check-metric-stream-replay-health.ts
```

The script must check:

- Redpanda broker reachability.
- `metric-stream-postgres-sink` consumer lag.
- `metric-stream-clickhouse-sink` consumer lag.
- `metric-stream-r2-archive` consumer lag.
- Newest R2 archive object age.
- Newest `fitness.metric_stream.recorded_at` in Postgres.
- Newest `postgres_fitness.metric_stream.recorded_at` in ClickHouse.
- Newest dbt analytics rows that depend on metric stream, especially
  `analytics.daily_activity_load` and `analytics.daily_strain`.

Treat R2 archive staleness as a production durability incident. Do not cut over
writers to Redpanda-first unless the R2 archive is fresh.

## Replay

Replay must always be bounded by time or explicit R2 prefix. Do not run an
unbounded archive replay.

Dry-run a bounded replay:

```bash
pnpm tsx scripts/replay-metric-stream-from-r2.ts \
  --prefix metric-stream/v1/date=2026-06-06/hour=15/ \
  --target redpanda \
  --dry-run
```

Replay to Redpanda:

```bash
pnpm tsx scripts/replay-metric-stream-from-r2.ts \
  --prefix metric-stream/v1/date=2026-06-06/hour=15/ \
  --target redpanda \
  --execute
```

Replay directly to ClickHouse only for bounded incident repair:

```bash
pnpm tsx scripts/replay-metric-stream-from-r2.ts \
  --prefix metric-stream/v1/date=2026-06-06/hour=15/ \
  --target clickhouse \
  --execute
```

After replaying to ClickHouse, rebuild the dependent analytics models:

```bash
dbt build --project-dir analytics --profiles-dir analytics --threads 1 \
  --select sensor_scalar_sample deduped_sensor activity_sensor_sample activity_summary_rows daily_activity_load daily_strain
```

## Cutover Checklist

Do not switch production writers to Redpanda-first until all checks pass:

1. `redpanda` is healthy.
2. Postgres sink can insert duplicate events idempotently.
3. ClickHouse sink can insert duplicate events idempotently.
4. Redpanda Connect archive writes fresh R2 objects.
5. A bounded R2 replay into a temporary ClickHouse table matches row counts and
   checksums from the original archive.
6. PeerDB metric-stream CDC remains active during shadow validation.
7. Recent Redpanda-sourced ClickHouse rows match PeerDB-sourced rows over a
   bounded recent window.

Only after this checklist passes should provider and mobile metric-stream
writers move from direct Postgres writes to `writeMetricStreamRows()`.

## Incident Triage

If strain, activity load, or other metric-stream analytics go stale:

1. Check Redpanda sink lag and archive freshness.
2. Check Postgres freshness:

   ```sql
   SELECT max(recorded_at)
   FROM fitness.metric_stream;
   ```

3. Check ClickHouse freshness:

   ```sql
   SELECT max(recorded_at)
   FROM postgres_fitness.metric_stream
   WHERE _peerdb_is_deleted = 0;
   ```

4. If Redpanda and R2 are fresh but ClickHouse is stale, replay the bounded
   affected R2 prefix to ClickHouse and rebuild dependent dbt models.
5. If R2 is stale, treat it as a canonical backup failure. Fix the archive
   service before continuing ingestion cutover.
6. Record the incident in `docs/production-incident-baseline.md`.

## References

- Redpanda tiered storage self-managed docs:
  <https://docs.redpanda.com/25.3/manage/tiered-storage/>
- Redpanda Connect `aws_s3` output:
  <https://docs.redpanda.com/redpanda-connect/components/outputs/aws_s3/>
- Redpanda Connect component catalog:
  <https://docs.redpanda.com/redpanda-connect/components/about/>
