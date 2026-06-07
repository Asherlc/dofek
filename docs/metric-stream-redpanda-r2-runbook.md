# Metric Stream Redpanda and R2 Runbook

Use this for the Redpanda metric-stream replay path. HealthKit quantity
metric-stream samples publish through Redpanda first. Other providers may still
write directly to Postgres until their individual writer cutovers are complete.
PeerDB may still mirror non-IMU Postgres rows into ClickHouse during shadow
validation and bounded recovery.

## Purpose

`fitness.metric_stream` is high-volume sensor data. A single Postgres logical
replication slot is not durable enough for this table because a lost slot can
leave ClickHouse stale even while Postgres still has fresh source rows.

The target durable path is:

```text
provider/mobile import
  -> Redpanda topic metric-stream-v1
  -> ClickHouse sink -> postgres_fitness.metric_stream
  -> Redpanda Connect archive -> Cloudflare R2
```

R2 is the long-term replay store for metric-stream events, and ClickHouse is the
analytics serving copy; both are rebuildable from Redpanda/R2 for bounded ranges.
Metric-stream samples are no longer written back into `fitness.metric_stream` from
Redpanda — the project is moving off the Postgres metric stream. Any existing
`fitness.metric_stream` rows are legacy data written by direct provider paths that
have not yet been cut over; the canonical analytics copy is ClickHouse. Postgres
remains canonical for users, providers, activities, tokens, settings, food, and
other app state.

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

Event fields:

Required:

- `version`
- `id`
- `recordedAt`
- `userId`
- `providerId`
- `sourceType`
- `channel`

Optional:

- `externalId`
- `deviceId`
- `activityId`
- `scalar`
- `vector`
- `point`
- `metadata`

Use `null` for absent optional values. Do not write empty strings as absent
values.

Delete events use the same topic and schema version with
`eventType: "metric_stream_deleted"`. They carry a bounded `scope` such as an
`activityId` or `{ userId, providerId, recordedAtStart }`, plus a `partitionKey`.
Replacement writers must publish the delete event and replacement row events on
that same partition key so Redpanda preserves delete-before-insert order.

The ClickHouse sink applies delete events by marking matching
`postgres_fitness.metric_stream` rows with `_peerdb_is_deleted = 1` before
inserting replacement row events.

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

Run concrete freshness checks from the production host:

```bash
docker service ps dofek_redpanda --no-trunc
docker service ps dofek_metric-stream-clickhouse-sink --no-trunc
docker service ps dofek_metric-stream-r2-archive --no-trunc
```

Check Redpanda consumer lag for each durable consumer group:

```bash
docker exec "$(docker ps --filter name=dofek_redpanda -q | head -n1)" \
  rpk group describe metric-stream-clickhouse-sink metric-stream-r2-archive
```

Check ClickHouse freshness:

```bash
docker exec -i "$(docker ps --filter name=dofek_clickhouse -q | head -n1)" \
  sh -lc 'clickhouse-client --password "$CLICKHOUSE_PASSWORD" --query "select max(recorded_at) from postgres_fitness.metric_stream"'
```

Check archive service logs for recent R2 write failures:

```bash
docker service logs --since 15m dofek_metric-stream-r2-archive
```

The freshness checks must cover:

- Redpanda broker reachability.
- `metric-stream-clickhouse-sink` consumer lag.
- `metric-stream-r2-archive` consumer lag.
- Newest R2 archive object age.
- Newest `postgres_fitness.metric_stream.recorded_at` in ClickHouse.
- Newest dbt analytics rows that depend on metric stream, especially
  `analytics.daily_activity_load` and `analytics.daily_strain`.

Treat R2 archive staleness as a production durability incident. Do not cut over
writers to Redpanda-first unless the R2 archive is fresh.

## Historical Postgres Backfill

Use the one-time Postgres-to-Redpanda backfill to port existing
`fitness.metric_stream` rows into `metric-stream-v1`:

```bash
./scripts/with-env.sh pnpm tsx scripts/backfill-metric-stream-to-redpanda.ts \
  --start 2024-01-01T00:00:00Z \
  --end 2024-02-01T00:00:00Z \
  --batch-size 5000
```

The script requires a bounded `--start` and `--end`, reads Postgres with keyset
pagination over `(recorded_at, id)`, preserves the original Postgres `id`, and
publishes through the versioned Redpanda producer. Run it in bounded windows and
do not use `OFFSET`-based ad hoc SQL for this migration.

Do not run the historical backfill until all durable consumers are healthy:

1. `metric-stream-clickhouse-sink` is running and idempotent by event id.
2. `metric-stream-r2-archive` is writing fresh R2 objects.
3. Redpanda consumer lag is acceptable for all metric-stream groups.

Provider replacement syncs must use the scoped replacement publisher path so
ClickHouse and R2 see the same delete/replacement sequence.

## Replay

Replay must always be bounded by time or explicit R2 prefix. Do not run an
unbounded archive replay.

R2 replay automation is not shipped yet. Until `scripts/replay-metric-stream-from-r2.ts`
exists, do not use R2 replay as an incident mitigation path. Use the existing
bounded ClickHouse repair runbooks and scripts for ClickHouse-only repair, or
implement the replay script before cutting over any additional metric-stream
writers to Redpanda-first.

After any bounded ClickHouse repair, rebuild the dependent analytics models:

```bash
dbt build --project-dir analytics --profiles-dir analytics --threads 1 \
  --select sensor_scalar_sample deduped_sensor activity_sensor_sample activity_summary_rows daily_activity_load daily_strain
```

## Cutover Checklist

Do not switch production writers to Redpanda-first until all checks pass:

1. `redpanda` is healthy.
2. ClickHouse sink can insert duplicate events idempotently.
3. Redpanda Connect archive writes fresh R2 objects.
4. A bounded R2 replay into a temporary ClickHouse table matches row counts and
   checksums from the original archive.
5. PeerDB metric-stream CDC remains active during shadow validation.
6. Recent Redpanda-sourced ClickHouse rows match PeerDB-sourced rows over a
   bounded recent window.

Only after this checklist passes should additional provider and mobile
metric-stream writers move from direct Postgres writes to
`writeMetricStreamRows()`. HealthKit quantity metric-stream samples already use
that writer boundary.

## Incident Triage

If strain, activity load, or other metric-stream analytics go stale:

1. Check Redpanda sink lag and archive freshness.
2. Check ClickHouse freshness:

   ```sql
   SELECT max(recorded_at)
   FROM postgres_fitness.metric_stream
   WHERE _peerdb_is_deleted = 0;
   ```

3. If Redpanda and R2 are fresh but ClickHouse is stale, replay the bounded
   affected R2 prefix to ClickHouse and rebuild dependent dbt models.
4. If R2 is stale, treat it as a canonical backup failure. Fix the archive
   service before continuing ingestion cutover.
5. Record the incident in `docs/production-incident-baseline.md`.

## References

- Redpanda tiered storage self-managed docs:
  <https://docs.redpanda.com/25.3/manage/tiered-storage/>
- Redpanda Connect `aws_s3` output:
  <https://docs.redpanda.com/redpanda-connect/components/outputs/aws_s3/>
- Redpanda Connect component catalog:
  <https://docs.redpanda.com/redpanda-connect/components/about/>
