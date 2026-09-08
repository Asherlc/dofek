# Metric Stream Redpanda and R2 Runbook

Use this for Redpanda ingest, ClickHouse sink, and R2 archive operations, plus
planning a bounded replay implementation. HealthKit quantity metric-stream
samples and provider metric-stream samples publish through Redpanda first.
Postgres no longer stores the metric stream.

## Purpose

Metric-stream is high-volume sensor data. It is intentionally not stored in
Postgres; Redpanda is the hot ingest log, R2 is the durable archive, and
ClickHouse is the analytics serving copy.

The current archive path is:

```text
live ingestion -> metric-stream-live-v1    -> live sink + live archive
history import -> metric-stream-history-v1 -> history sink + history archive
legacy backlog -> metric-stream-v1         -> legacy sink + legacy archive
                                             |-> ClickHouse ingest.metric_stream
                                             `-> Cloudflare R2 archive
```

R2 is the long-term archive for metric-stream events, and ClickHouse is the
analytics serving copy. A checked-in R2-to-ClickHouse replay command does not
yet exist, so the archive is not currently an operator-ready recovery path.
Metric-stream samples are no longer written back into `fitness.metric_stream` from
Redpanda. Historical Postgres rows were archived to R2 before the Postgres table
was retired. Postgres remains canonical for users, providers, activities,
tokens, settings, food, and other app state.

## Canonical Storage Policy

- Live and historical ingestion use separate topics; the legacy topic remains
  assigned to its existing consumers. See the [deployment renderer](../scripts/deploy-service-environment.ts)
  for the required route contract.
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
| `metric-stream-clickhouse-sink` / `metric-stream-r2-archive` | Legacy consumers of `METRIC_STREAM_LEGACY_TOPIC` (`metric-stream-v1`). |
| `metric-stream-live-clickhouse-sink` / `metric-stream-live-r2-archive` | Live consumers of `METRIC_STREAM_LIVE_TOPIC` (`metric-stream-live-v1`). |
| `metric-stream-history-clickhouse-sink` / `metric-stream-history-r2-archive` | History consumers of `METRIC_STREAM_HISTORY_TOPIC` (`metric-stream-history-v1`). |
| `analytics-worker` | Rebuilds dbt-owned ClickHouse analytics read models from ClickHouse source tables. |

Each sink writes non-IMU rows to `ingest.metric_stream`; each archive writes
topic-qualified batches to the same R2 bucket. Each consumer's group is its
service name, preserving the legacy groups and giving the new routes independent
offsets. Redpanda Connect resumes from committed offsets for the configured
[consumer group](https://docs.redpanda.com/connect/components/inputs/redpanda/#consumer-groups).
The [stack](../deploy/stack.yml) raises only ClickHouse's CPU limit to `1.5`;
its memory settings and each consumer's existing resource limits are retained.
Docker documents this as a maximum CPU allocation, not a reservation:
[Compose CPU limits](https://docs.docker.com/reference/compose-file/deploy/#cpus).

## Required Secrets

Store these in Infisical before enabling the services:

| Secret | Example | Notes |
| --- | --- | --- |
| `REDPANDA_BROKERS` | `redpanda:9092` | Comma-separated broker list. |
| `METRIC_STREAM_LEGACY_TOPIC` | `metric-stream-v1` | Existing topic assigned only to legacy consumers. |
| `METRIC_STREAM_LIVE_TOPIC` | `metric-stream-live-v1` | Live producer/consumer route. |
| `METRIC_STREAM_HISTORY_TOPIC` | `metric-stream-history-v1` | History producer/consumer route. |
| `METRIC_STREAM_R2_BUCKET` | `dofek-metric-stream-archive` | Dedicated archive bucket. |
| `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` | Cloudflare R2 S3-compatible endpoint. |
| `R2_ACCESS_KEY_ID` | n/a | Existing R2 S3 credential. |
| `R2_SECRET_ACCESS_KEY` | n/a | Existing R2 S3 credential. |

Missing secrets must fail service startup. Do not use blank defaults.

The production topic contract contains exactly the three explicit route keys.
Create/verify them in Infisical before deployment. The
[service renderer](../scripts/deploy-service-environment.ts) fails before
writing any service files if a required route is missing or blank. Web and worker
receive the live/history keys; each consumer receives only its designated topic
as internal `METRIC_STREAM_TOPIC` plus its fixed `METRIC_STREAM_CONSUMER_GROUP`.
Do not create a generic topic or group in Infisical for these services.
The shared archive configuration reads both internal values through
[Redpanda Connect environment interpolation](https://docs.redpanda.com/connect/configuration/interpolation/#environment-variables).

## R2 Object Layout

Archive objects use partitioned prefixes:

```text
metric-stream/v1/date=YYYY-MM-DD/hour=HH/<topic>-<partition>-<first-offset>-<last-offset>.jsonl.gz
```

Each object contains newline-delimited JSON records. Every record must validate
against `metricStreamRedpandaEventSchema` in `src/metric-stream/events.ts`.
Current producers emit:

- version 2 row events with `operationRevision`, `generation`, row identity,
  timestamps, ownership, channel, and scalar/vector/point payload fields;
- version 3 delete events with `eventId`, `operationRevision`, a bounded
  `scope`, and `partitionKey`;
- version 1 batch-completion events with `operationId`, `batchId`,
  `datasetKeys`, `expectedEventCount`, and `partitionKey`.

The union still accepts older archived row and delete versions for replay
compatibility. Validate the exact record variant before interpreting its fields.

Use `null` for absent optional values. Do not write empty strings as absent
values.

Delete events use the same topic with
`eventType: "metric_stream_deleted"`. They carry a bounded `scope` such as an
`activityId` or `{ userId, providerId, recordedAtStart }`, plus a `partitionKey`.
Replacement writers must publish the delete event and replacement row events on
that same partition key so Redpanda preserves delete-before-insert order.

The ClickHouse sink applies delete events by inserting newer matching
`ingest.metric_stream` rows with `is_deleted = 1` before inserting replacement
row events.

## Redpanda Connect Archive Expectations

The archive service should use Redpanda Connect with:

- `redpanda` input consuming its designated `METRIC_STREAM_TOPIC` with its own
  `METRIC_STREAM_CONSUMER_GROUP`.
- `aws_s3` output targeting Cloudflare R2.
- `endpoint` set to `R2_ENDPOINT`.
- `force_path_style_urls: true`.
- `region: auto`.
- gzip compression on batches.
- object keys that preserve topic, partition, and offset range.

Redpanda Connect documents `aws_s3` as self-managed and non-enterprise, and it
documents Cloudflare R2 support through custom endpoint and path-style settings.

## Malformed-event quarantine

The ClickHouse consumer creates and enforces a dedicated
`<source-topic>.quarantine.v1` topic before it begins consuming the source
topic. The quarantine is intentionally bounded:

- cleanup policy: `delete`
- time retention: 604800000 ms (7 days)
- size retention: 1073741824 bytes (1 GiB per partition)

Redpanda supports topic-level `retention.ms` and `retention.bytes` overrides
through the Kafka Admin API. Both limits make old records eligible for
deletion, so investigate quarantine events promptly instead of treating the
topic as a second archive.

Each quarantined record's value is the exact original payload bytes. Keeping
the payload raw avoids base64 size expansion near Kafka's message limit. Its
headers provide `dofek-quarantine-version`, `dofek-quarantined-at`,
`dofek-source-topic`, `dofek-source-partition`, `dofek-source-offset`,
`dofek-error-name`, and `dofek-error-message`.

The record key is `<source-topic>:<partition>:<offset>`. The consumer publishes
with `acks: -1`, which requires every in-sync replica to acknowledge the
quarantine write. It resolves the source batch only after every malformed
payload is quarantined and every valid event in the batch reaches ClickHouse.
If parsing, quarantine, or ClickHouse fails, no source offset in that batch is
resolved; a later valid event therefore cannot bypass an earlier unhandled
offset in the same partition.

Inspect recent quarantine records without joining a consumer group:

```bash
docker exec "$(docker ps --filter name=dofek_redpanda -q | head -n1)" \
  rpk topic consume metric-stream-v1.quarantine.v1 \
  --offset start --num 100 --format json
```

Before replaying, deploy the schema or payload correction, validate the raw
record value against the current metric-stream schema, and produce it to the
partition recorded in the headers with all-replica acknowledgement.
Do not delete the quarantine record manually; retain its original coordinates
as incident evidence and let the configured bounds expire it. Redpanda's
`rpk topic produce --partition` flag can target the recorded partition, while
`--acks=-1` requests all in-sync replicas.

## Freshness Checks

Run concrete freshness checks from the production host:

```bash
docker service ps dofek_redpanda --no-trunc
docker service ps dofek_metric-stream-clickhouse-sink --no-trunc
docker service ps dofek_metric-stream-r2-archive --no-trunc
docker service ps dofek_metric-stream-live-clickhouse-sink --no-trunc
docker service ps dofek_metric-stream-live-r2-archive --no-trunc
docker service ps dofek_metric-stream-history-clickhouse-sink --no-trunc
docker service ps dofek_metric-stream-history-r2-archive --no-trunc
```

Check Redpanda consumer lag for each durable consumer group:

```bash
docker exec "$(docker ps --filter name=dofek_redpanda -q | head -n1)" \
  rpk group describe metric-stream-clickhouse-sink metric-stream-r2-archive \
  metric-stream-live-clickhouse-sink metric-stream-live-r2-archive \
  metric-stream-history-clickhouse-sink metric-stream-history-r2-archive
```

Alert on both absolute lag and lag growth rate. A large shrinking backlog and a
smaller growing backlog require different responses. The ClickHouse sink also
emits `metric_stream.consumer_batch` with `consumer_lag`,
`sink_duration_ms`, `consumer_lag_growth_per_second`,
`average_batch_event_cost_ms`, `deletion_event_count`, and
`deletion_events_per_second`; alerting must cover sink latency and delete rate,
not only batch commits. KafkaJS exposes the batch high watermark and requires
manual offset resolution before commit when `eachBatchAutoResolve` is disabled;
see its [consumer documentation](https://kafka.js.org/docs/consuming#eachbatch).

Check ClickHouse freshness:

```bash
docker exec -i "$(docker ps --filter name=dofek_clickhouse -q | head -n1)" \
  sh -lc 'clickhouse-client --password "$CLICKHOUSE_PASSWORD" --query "select max(recorded_at) from ingest.metric_stream"'
```

Check archive service logs for recent R2 write failures:

```bash
docker service logs --since 15m dofek_metric-stream-r2-archive
docker service logs --since 15m dofek_metric-stream-live-r2-archive
docker service logs --since 15m dofek_metric-stream-history-r2-archive
```

The freshness checks must cover:

- Redpanda broker reachability.
- Consumer lag for each legacy/live/history ClickHouse sink and archive group.
- Newest R2 archive object age for each topic with recent traffic.
- Newest `ingest.metric_stream.recorded_at` in ClickHouse.
- Newest dbt analytics rows that depend on metric stream, especially
  `analytics.daily_activity_load` and `analytics.daily_strain`.

Do not declare a sink backlog resolved from service health alone. Prove that
the committed offset reaches the topic head, publish a fresh post-drain message
and observe it in `ingest.metric_stream`, then verify the affected activities
hydrate with their expected sensor fields.

If the committed offset stays fixed and sink logs report `HTML Form Exception:
Too many form fields`, inspect the adjacent deletion run. Each deletion scope
adds up to seven query parameters. The sink bounds each sequential request to
100 scopes, retaining delete-before-replacement order and acknowledging each
scope only after its request succeeds. ClickHouse's default `http_max_fields`
is 1,000 and covers request headers, query parameters, and form data; reduce
the request size instead of increasing that limit
([ClickHouse settings source](https://github.com/ClickHouse/ClickHouse/blob/v26.6.1.1193-stable/src/Core/Settings.cpp#L2451-L2453),
[sink implementation](../src/metric-stream/clickhouse-sink.ts)).

## Full-refresh visibility window

Historical refreshes now have their own topic and consumer pair, while the
legacy pair continues from its existing offsets. This separates the consumer
queues, but all routes still share ClickHouse and host capacity; verify live
freshness while history drains using the per-route lag and sink-latency evidence
above. The [stack](../deploy/stack.yml) and
[producer routing](../src/metric-stream/redpanda-producer.ts) define these routes.

Keep each scoped delete and its replacement rows on the same route and partition
key. KafkaJS documents partition keys as the way to preserve message order for
the same entity: [producing messages](https://kafka.js.org/docs/producing#key).
Do not reset offsets or move an existing consumer group to a different topic as
part of the rollout. Deploy through the canonical workflow, which quiesces all
three ClickHouse sinks until migrations and CDC readiness pass; see the
[deployment procedure](../deploy/README.md#production-secrets).

Treat R2 archive staleness as a production durability incident. Writers are
already Redpanda-first; restore the archive before deploying writer changes or
allowing required Redpanda offsets to expire.

## External-ID deletion projection

Scoped replacement deletes filter by `(user_id, provider_id, external_id)`.
The base table's activity-oriented ordering cannot prune that lookup, so
`by_provider_external_id` stores a covering copy ordered for the delete path.
ClickHouse automatically considers projections when their physical ordering
matches a query's filters; use `force_optimize_projection_name` during
verification to fail if the intended projection is not eligible:
<https://clickhouse.com/blog/10-best-practice-tips#use-projections-for-common-filter-patterns>.

Migration `0074_metric_stream_external_id_projection` adds the definition for
new parts. It intentionally does not rewrite historical parts during deploy.
After the metric-stream consumer reaches the topic head and the fresh-message
delivery gate passes, materialize the existing parts in an approved maintenance
window:

```sql
ALTER TABLE ingest.metric_stream
MATERIALIZE PROJECTION by_provider_external_id;
```

Monitor `system.mutations` until the command is done, then verify every active
base-table part contains the projection:

```sql
SELECT
  count() AS active_parts,
  countIf(NOT has(projections, 'by_provider_external_id')) AS missing_projection_parts
FROM system.parts
WHERE active
  AND database = 'ingest'
  AND table = 'metric_stream';
```

Do not declare the optimization complete unless `missing_projection_parts` is
zero and an `EXPLAIN projections = 1` of the scoped external-ID lookup names
`by_provider_external_id`. Existing parts require explicit materialization;
ClickHouse documents this separately from adding the projection definition:
<https://clickhouse.com/docs/data-modeling/projections#filtering-on-columns-which-arent-in-the-primary-key>.

## Historical Postgres Backfill

The one-time `fitness.metric_stream` to R2 historical backfill has completed and
the exporter code has been removed. Do not introduce a new Postgres-to-Redpanda
or Postgres-to-R2 backfill path without a fresh migration plan and explicit
operator approval. A future repair may replay bounded R2 prefixes only after a
checked-in command validates the target range, row counts, and checksums.

Provider replacement syncs must use the scoped replacement publisher path so
ClickHouse and R2 see the same delete/replacement sequence.

## Replay

Replay must always be bounded by time or explicit R2 prefix. Do not run an
unbounded archive replay.

R2 replay automation is not shipped yet. Until `scripts/replay-metric-stream-from-r2.ts`
exists, do not claim R2 replay as an available incident mitigation path and do
not substitute the retired Postgres catch-up script. If the required Redpanda
offsets have expired, implement and validate the bounded replay command before
attempting recovery.

After a recent repair, local validation can run the repository analytics build:

```bash
pnpm analytics:build
```

This uses the local `dev` target. Production read models advance through the
deployed `analytics-worker`; verify a successful worker cycle after repairing
the production source.

Historical model repair must use explicit `--event-time-start` and
`--event-time-end` bounds from the
[analytics backfill procedure](../analytics/README.md#microbatch-start-bounds-and-historical-backfills);
do not invoke bare `dbt build`.

## Durability Invariants

Production writers are already Redpanda-first. Keep these invariants true:

1. `redpanda` is healthy.
2. ClickHouse sink can insert duplicate events idempotently.
3. Redpanda Connect archive writes fresh R2 objects.
4. Recent Redpanda-sourced ClickHouse rows match the corresponding R2 archive
   rows over a bounded recent window when validating replay behavior.

Bounded R2 replay automation remains an explicit recovery gap. Do not describe
the archive as operator-replayable until a checked-in replay command validates
row counts and checksums against a temporary ClickHouse table.

All provider and mobile metric-stream writers should use `writeMetricStreamRows()`
or the scoped replacement helpers.

## Incident Triage

If strain, activity load, or other metric-stream analytics go stale:

1. Check Redpanda sink lag and archive freshness.
2. Check ClickHouse freshness:

   ```sql
   SELECT max(recorded_at)
   FROM ingest.metric_stream FINAL
   WHERE is_deleted = 0;
   ```

3. If Redpanda and R2 are fresh but ClickHouse is stale, inspect the sink's
   consumer lag and first fatal log line. If the required offsets remain in
   Redpanda, fix the sink failure and let the same consumer group catch up.
   If the offsets have expired, stop: bounded R2 replay automation is not
   shipped, so an approved implementation is required before recovery.
4. If R2 is stale, treat it as a durability failure. Fix the archive service
   before relying on archive recovery or allowing the needed Redpanda offsets
   to expire.
5. Record the incident in `docs/production-incident-baseline.md`.

## References

- Redpanda tiered storage self-managed docs:
  <https://docs.redpanda.com/25.3/manage/tiered-storage/>
- Redpanda Connect `aws_s3` output:
  <https://docs.redpanda.com/redpanda-connect/components/outputs/aws_s3/>
- Redpanda Connect component catalog:
  <https://docs.redpanda.com/redpanda-connect/components/about/>
- Redpanda topic configuration properties:
  <https://docs.redpanda.com/current/reference/properties/topic-properties/>
- Redpanda `rpk topic consume`:
  <https://docs.redpanda.com/current/reference/rpk/rpk-topic/rpk-topic-consume/>
- Redpanda `rpk topic produce`:
  <https://docs.redpanda.com/current/reference/rpk/rpk-topic/rpk-topic-produce/>
- KafkaJS producing acknowledgements:
  <https://kafka.js.org/docs/producing>
- KafkaJS manual batch offset resolution:
  <https://kafka.js.org/docs/consuming>
