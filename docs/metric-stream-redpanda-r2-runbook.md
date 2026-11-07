# Metric Stream broker and R2 Runbook

> **Current vs target (2026-11-07):** **Production today** still publishes and
> consumes through Swarm **Redpanda** (`dofek_redpanda`, `REDPANDA_BROKERS`,
> v1 topics) — see Lane 87 census in
> [`deploy/kafka/README.md`](../deploy/kafka/README.md#live-baseline-lane-87-exclusive-census--2026-11-07t050843z).
> **Local Compose / checked-in `deploy/stack.yml`** target the **Apache Kafka
> 4.4** service and `KAFKA_BROKERS` (no compose `redpanda` service). JSONL
> archive remains **[Redpanda Connect](https://docs.redpanda.com/redpanda-connect/)**
> (`redpanda` input name is the product identifier — do not rename for branding).
> Cutover is **not** executed; existing Deploy Web is **not** a safe cutover
> sequencer.

Use this for production Redpanda drain/freshness, ClickHouse sink, and R2
archive operations, plus planning a bounded replay implementation. HealthKit
quantity metric-stream samples and provider metric-stream samples publish
through the live Kafka-protocol broker first (production: Redpanda). Postgres
no longer stores the metric stream.

## Purpose

Metric-stream is high-volume sensor data. It is intentionally not stored in
Postgres; the Kafka-protocol hot ingest log buffers it, R2 is the durable
archive, and ClickHouse is the analytics serving copy.

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
the hot log. Historical Postgres rows were archived to R2 before the Postgres table
was retired. Postgres remains canonical for users, providers, activities,
tokens, settings, food, and other app state.

## Canonical Storage Policy

- Live and historical ingestion use separate topics; the legacy topic remains
  assigned to its existing consumers. See the [deployment renderer](../scripts/deploy-service-environment.ts)
  for the required route contract (renderer target keys use `KAFKA_BROKERS`).
- `dofek-metric-stream-archive` is the long-term replay archive in Cloudflare R2.
- The R2 metric-stream archive must not have lifecycle deletion rules.
- Hot-log local retention is a buffering and operations setting, not the
  long-term source of truth. Production Redpanda retention still applies until
  cutover; Kafka TS (dedicated R2) is the post-cutover cold path — see
  [`deploy/kafka/README.md`](../deploy/kafka/README.md).
- Postgres remains canonical for users, providers, activities, tokens, settings,
  food, and other app state. This runbook only changes metric-stream samples.

## Required Services

| Service | Purpose |
| --- | --- |
| Production: `dofek_redpanda` | Live Kafka-compatible hot ingest log (**today**). |
| Local / stack target: `kafka` | Apache Kafka 4.4 in Compose / `deploy/stack.yml` (**not** cut over in prod). |
| `metric-stream-clickhouse-sink` / `metric-stream-r2-archive` | Legacy consumers of `METRIC_STREAM_LEGACY_TOPIC` (`metric-stream-v1` in prod today). |
| `metric-stream-live-clickhouse-sink` / `metric-stream-live-r2-archive` | Live consumers of `METRIC_STREAM_LIVE_TOPIC` (`metric-stream-live-v1` in prod today). |
| `metric-stream-history-clickhouse-sink` / `metric-stream-history-r2-archive` | History consumers of `METRIC_STREAM_HISTORY_TOPIC` (`metric-stream-history-v1` in prod today). |
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
| `REDPANDA_BROKERS` | `redpanda:9092` | **Production today** (web/worker/sinks/archives per census). |
| `KAFKA_BROKERS` | `kafka:9092` / `kafka:29092` | **Local Compose + post-cutover stack renderer** ([Apache Kafka listeners](https://kafka.apache.org/documentation/#listenerconfigs)); no `REDPANDA_` alias in the renderer. |
| `METRIC_STREAM_LEGACY_TOPIC` | `metric-stream-v1` | Existing topic assigned only to legacy consumers (v2 names required before Kafka-target deploy). |
| `METRIC_STREAM_LIVE_TOPIC` | `metric-stream-live-v1` | Live producer/consumer route. |
| `METRIC_STREAM_HISTORY_TOPIC` | `metric-stream-history-v1` | History producer/consumer route. |
| `METRIC_STREAM_R2_BUCKET` | `dofek-metric-stream-archive` | Dedicated archive bucket. |
| `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` | Cloudflare R2 S3-compatible endpoint. |
| `R2_ACCESS_KEY_ID` | n/a | Existing R2 S3 credential. |
| `R2_SECRET_ACCESS_KEY` | n/a | Existing R2 S3 credential. |

Missing secrets must fail service startup. Do not use blank defaults.

The external production topic contract contains exactly the three explicit route keys.
Create/verify them in Infisical before deployment. The
[service renderer](../scripts/deploy-service-environment.ts) fails before
writing any service files if a required route is missing or blank. Web and worker
receive the live/history keys; each consumer receives only its designated topic
as internal `METRIC_STREAM_TOPIC` plus its fixed `METRIC_STREAM_CONSUMER_GROUP`.
Do not create a generic topic or group in Infisical for these services.
The shared archive configuration reads both internal values through
[Redpanda Connect environment interpolation](https://docs.redpanda.com/connect/configuration/interpolation/#environment-variables).

The pre-migration dependency apply is the only producer exception: it selects
`web-pre-migration.env`, which also maps the explicit legacy topic to the generic
key expected by the previously deployed web image. The two requested-image
deployment phases select the normal `web.env`. This is an isolated deployment
artifact, not an external generic topic or a steady-state producer fallback;
see the [deployment environment procedure](../deploy/README.md#production-secrets).

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
that same partition key so the broker preserves delete-before-insert order.

The ClickHouse sink applies delete events by inserting newer matching
`ingest.metric_stream` rows with `is_deleted = 1` before inserting replacement
row events.

## Prepared Pulsar key recognition

The archive eraser also recognizes the explicit native key layout:

```text
metric-stream/v1/date=YYYY-MM-DD/hour=HH/pulsar/epoch=<encoded-epoch>/topic=<encoded-concrete-topic>/first=<hex>/last=<hex>.jsonl.gz
```

Epoch and topic use canonical `encodeURIComponent` escaping. The topic must
have the concrete `persistent://tenant/namespace/topic` shape. The UTC date and
hour are validated; endpoint fields must be nonempty lowercase, even-length
hex. Native keys must fit the [S3 1,024-byte key limit](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html).
Legacy flat keys remain supported. Unknown nested layouts fail before object
access or erasure checkpoint advancement. See the
[shared parser](../src/metric-stream/r2-replay.ts).

The endpoint bytes are opaque original-upload provenance. Recognition does
not decode native message IDs or prove ordering, partition consistency or
replay validity. The writer and replay consumers must qualify those properties
where they use positions. Erasure determines ownership from the validated
JSONL payload and retained identifiers, then uses conditional ETag-protected
replacement; it does not derive ownership from the key. See the
[archive eraser](../src/account-erasure/archive-erasure.ts).

No Pulsar writer is activated by this support. The parser and eraser must be
deployed before or together with the first native archive object. The existing
gzip JSONL payload format and legacy flat-key layout remain unchanged. Account
erasure still rewrites matching objects in place.

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

Run concrete freshness checks from the production host (**stock Redpanda
commands while `dofek_redpanda` is the live broker** — re-record before any
mutate; do not invent a parallel Kafka drain path for today's production):

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

- Live hot-log broker reachability (`dofek_redpanda` today).
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
part of the rollout. Deploy through the canonical workflow, which stops all
three ClickHouse sinks until migrations and CDC readiness pass; see the
[deployment procedure](../deploy/README.md#production-secrets).

Treat R2 archive staleness as a production durability incident. Writers are
already broker-first; restore the archive before deploying writer changes or
allowing required hot-log offsets to expire.

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

Production writers are already broker-first (today: Redpanda). Keep these
invariants true:

1. The live hot-log Swarm service is healthy (`dofek_redpanda` until cutover).
2. ClickHouse sink can insert duplicate events idempotently.
3. Redpanda Connect archive writes fresh R2 objects.
4. Recent broker-sourced ClickHouse rows match the corresponding R2 archive
   rows over a bounded recent window when validating replay behavior.

Bounded R2 replay automation remains an explicit recovery gap. Do not describe
the archive as ready for operator replay until a checked-in replay command validates
row counts and checksums against a temporary ClickHouse table.

All provider and mobile metric-stream writers should use `writeMetricStreamRows()`
or the scoped replacement helpers.

## Incident Triage

If strain, activity load, or other metric-stream analytics go stale:

1. Check live hot-log sink lag and archive freshness (`rpk` / service logs).
2. Check ClickHouse freshness with a **usable** signal (census FINDING: bare
   `max(recorded_at)` can be nonsensical — do not treat a future timestamp as
   catch-up proof):

   ```sql
   SELECT max(recorded_at)
   FROM ingest.metric_stream FINAL
   WHERE is_deleted = 0;
   ```

3. If the broker and R2 are fresh but ClickHouse is stale, inspect the sink's
   consumer lag and first fatal log line. If the required offsets remain in
   the live hot log, fix the sink failure and let the same consumer group catch
   up. If the offsets have expired, stop: bounded R2 replay automation is not
   shipped, so an approved implementation is required before recovery.
4. If R2 is stale, treat it as a durability failure. Fix the archive service
   before relying on archive recovery or allowing the needed hot-log offsets
   to expire.
5. Record the incident in `docs/production-incident-baseline.md`.

## Kafka hot-log cutover (pointer only)

Production cutover from Redpanda → stock Kafka 4.4 + RSM is **not executed**
from this runbook. The concrete operator sequence, Lane 87 live census
(2026-11-07T05:08:43Z), rollback boundary, and remaining approvals live in
[`deploy/kafka/README.md`](../deploy/kafka/README.md#production-cutover--rollback-review-not-executed).
Keep using this document for Redpanda freshness, quarantine inspect, and
archive durability checks during any approved drain. Do **not** treat
ClickHouse `max(recorded_at)` as freshness while it reports a nonsensical
future timestamp (census FINDING). Terraform `KAFKA_TIERED_STORAGE_*`
provisioning is **done**; topic-value edits, cutover execution, and
`/mnt/dofek-data/redpanda` deletion (retain **38 GiB**) remain separately
approved.

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
