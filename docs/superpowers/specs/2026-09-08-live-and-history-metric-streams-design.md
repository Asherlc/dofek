# Live and Historical Metric Streams Design

## Goal

Keep newly synced health data visible promptly while a large initial-history
sync is processed independently, and restore sustained throughput for the
currently stalled metric-stream backlog.

## Scope

This design adds distinct live and full-history metric-stream routes, retains
the legacy route until its existing backlog drains, and increases ClickHouse's
durable CPU allocation from one to 1.5 cores. It does not rate-limit history,
drop or reorder existing messages, replay the current queue, or alter client
status semantics.

## Evidence

On 2026-09-08, the production `metric-stream-clickhouse-sink` consumer lag was
44,859,880 messages. Its committed message timestamp was 2026-09-06T15:58:55Z
while the topic head was 2026-09-08T22:22:38Z. The consumer was stable, but
ClickHouse was CPU-saturated at its configured one-core limit. Withings ingest
and relational CDC completed; only its metric-stream acknowledgement remained
pending. The existing one-partition topic therefore couples historical and
live visibility.

## Architecture

```text
legacy metric-stream-v1 ──> legacy sink ──> ClickHouse  (existing backlog only)

normal/provider live sync ──> metric-stream-live-v1 ──> live sink ──> ClickHouse
initial full sync         ──> metric-stream-history-v1 ──> history sink ──> ClickHouse
```

The existing `metric-stream-v1` topic and its consumer remain unchanged until
the consumer reaches its head. New normal syncs publish to
`metric-stream-live-v1`; a sync job whose `targetRefreshWindow.type` is `full`
publishes to `metric-stream-history-v1`.

Each topic has one partition and its own consumer group, retaining in-topic
ordering for delete, replacement-row, and processing-marker sequences. Kafka
guarantees ordering within a partition, not across partitions or topics
([Kafka documentation](https://kafka.apache.org/documentation/#semantics)).
Cross-route overlap remains correct because the existing metric-stream write
path allocates every operation revision from the shared
`fitness.metric_ingest_operation_revision_seq`; the ClickHouse sink writes that
value as its `ReplacingMergeTree(version)` version. The design must test that a newer live
replacement remains visible when an older history replacement completes later.

The live, history, and legacy sinks all write the same canonical
`ingest.metric_stream` table and acknowledgement table. No second ClickHouse
copy of raw metric data is introduced; the existing topic-qualified R2 archive
remains the separate durable raw-data copy. Processing reconciliation continues
to use the existing batch IDs and acknowledgement records without
route-specific logic.

## Configuration

Production configuration defines three explicit topics:

- `METRIC_STREAM_LEGACY_TOPIC=metric-stream-v1` is consumed only to drain
  pre-migration traffic.
- `METRIC_STREAM_LIVE_TOPIC=metric-stream-live-v1` is the default producer and
  live-sink topic.
- `METRIC_STREAM_HISTORY_TOPIC=metric-stream-history-v1` is selected only for
  initial full provider syncs and consumed by the history sink.

All three topics use the existing retention and replication policy. The R2
archive service consumes all three topics and preserves the topic name in each
object key so recovery remains route-aware.

`METRIC_STREAM_LIVE_TOPIC` and `METRIC_STREAM_HISTORY_TOPIC` are new required
production configuration keys. They must be created in every relevant
Infisical environment before deployment and verified by key name only, using
the documented Infisical CLI configuration workflow
([Infisical CLI overview](https://infisical.com/docs/cli/overview)).

ClickHouse receives a sustained 1.5-core service allocation, leaving capacity
on the four-core production host while addressing the measured one-core
saturation. This is a production capacity requirement for concurrent serving
and ingestion, not an incident-only timeout, retry, or manual override.

## Failure handling and rollout

Missing topic configuration is a startup error. A sink must not fall back to
another route. The live and history sinks use the existing readiness endpoint,
Kafka lifecycle signals, malformed-event quarantine, and Sentry reporting.

Deployment order:

1. Add the two topics and archive routing while retaining the legacy topic.
2. Deploy the route-selecting producer and the live/history sinks.
3. Verify a new live marker reaches ClickHouse and becomes ready without
   waiting behind the legacy consumer.
4. Monitor all three consumer lags independently. Retire the legacy route only
   after its consumer reaches the topic head and a fresh-message delivery check
   succeeds.

No existing offset is moved, skipped, or replayed. The legacy sink continues
processing the current incident backlog in order.

## Tests and verification

Unit tests prove route selection for full versus non-full sync jobs and reject
missing topic configuration. Producer tests prove that each selected route
emits row/delete/processing-marker sequences to its configured topic.
ClickHouse integration coverage proves that a late older-history replacement
cannot supersede a newer live replacement. Stack/config validation confirms
three sinks and an archive consumer for every route.

Production verification records the consumer offset and timestamp for all
three routes, waits for a new live processing acknowledgement, and confirms
the corresponding processing operation reaches ready. It also verifies that
the legacy consumer continues advancing and that archive objects are fresh for
each new route.

## Non-goals

- Historical rate limiting or pausing.
- A broad historical replay tool.
- Changing provider APIs, provider queues, or client UI.
- Dropping the current legacy backlog.
