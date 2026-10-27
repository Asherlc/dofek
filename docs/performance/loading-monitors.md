# Loading Performance Monitors

These monitor specs live in [scripts/loading-performance-monitors.ts](../../scripts/loading-performance-monitors.ts). They are not automatically applied; validate each APL query against its production dataset before creating or updating Axiom monitors.

Logs use `dofek-logs`; spans use `dofek-traces`, following Axiom's
[dedicated dataset requirement for each OpenTelemetry signal](https://axiom.co/docs/send-data/opentelemetry).
Log messages are in `body`, severity is in `severity_text`, and log metadata is
grouped into the `attributes.custom` map before export. Use
`['attributes.custom']['consumer_lag']`, for example. Custom trace attributes
also use `attributes.custom`, accessed as
`['attributes.custom']['clickhouse.queue.wait_ms']`. Axiom documents these
[map-field access paths](https://axiom.co/docs/apl/data-types/map-fields).
The [collector](../../deploy/otel-collector-config.yaml) and
[direct mobile exporter](../../packages/mobile/lib/telemetry.ts) group log
metadata before sending it to Axiom.

The slow tRPC monitor parses durations and procedure names from `body` because
the [tRPC logger](../../packages/server/src/trpc.ts) writes them as message text.
The metric-stream monitors read structured metadata emitted by the
[consumer](../../src/metric-stream/redpanda-consumer.ts), while queue wait uses
the [ClickHouse limiter's span attributes](../../packages/server/src/repositories/limited-activity-sensor-store.ts).

## Required monitors

| Monitor | Query signal | Threshold | Owner response |
| --- | --- | --- | --- |
| Loading perf: slow tRPC procedure | `db_duration_ms` p95 and `total_duration_ms` max grouped by `procedure` | p95 above 5000 ms for 2 of 3 runs | Classify the slow procedure with the loading runbook before changing query code. |
| Loading perf: ClickHouse queue wait | `clickhouse.queue_wait` span p95 and max grouped by `clickhouse.queue.name` | p95 above 1000 ms for 2 of 3 runs | Check queue depth and active ClickHouse work before adding retries or broader timeouts. |
| Loading perf: ClickHouse infrastructure errors | ClickHouse DNS, connection refused, timeout, and memory messages | Any matching event | Treat the event as root-cause evidence and fix the infrastructure cause directly. |
| Metric stream: absolute ClickHouse sink lag | Maximum `consumer_lag` by partition | Above 100,000 for 2 of 3 runs | Determine whether the backlog is growing or draining before intervening. |
| Metric stream: ClickHouse sink lag growth | Maximum `consumer_lag_growth_per_second` by partition | Above 100 offsets/second for 2 of 3 runs | Compare producer rate, event mix, and sink latency. |
| Metric stream: slow ClickHouse sink events | p95 `average_batch_event_cost_ms` by partition | Above 100 ms for 2 of 3 runs | Inspect the event class and ClickHouse query cost. |
| Metric stream: elevated deletion-event rate | Maximum `deletion_events_per_second` by partition | Above 50/second for 2 of 3 runs | Confirm whether a deliberate replacement sync is running and correlate with external-ID lookup latency. |

## Creation workflow

1. Run Axiom schema discovery for both `dofek-logs` and `dofek-traces`, then confirm that each query's fields are populated in the target window.
2. Dry-run each `aplQuery` from `scripts/loading-performance-monitors.ts` against recent production data.
3. Create or update Axiom monitors with the checked-in names, thresholds, ranges, intervals, and group notification settings.
4. Record the monitor IDs next to the issue or incident that creates them.

The metric-stream monitors require a deployed sink that emits
`metric_stream.consumer_batch`. Validate actual events rather than guessing
field names or treating historical authentication failures as current evidence.
Attribute grouping applies to newly emitted logs; historical flattened fields
retain their previous paths. These monitor queries target the current map
schema. Axiom treats [map properties and flattened fields as separate fields](https://axiom.co/docs/apl/data-types/map-fields#map-fields-and-flattened-fields).

Axiom documents monitor management through the `/v2/monitors` API, threshold and match monitor behavior in monitor examples, and `percentile()` as an APL aggregation function for distribution thresholds. See the Axiom monitor API docs, monitor examples, and percentile docs for the current platform details:

- https://axiom.co/docs/restapi/endpoints/getMonitors
- https://axiom.co/docs/monitor-data/monitor-examples
- https://axiom.co/docs/apl/aggregation-function/percentile

## Regression policy

Client loading checks use `shouldShowBlockingLoading()` helpers in web and mobile tests. Existing data must stay visible during background refetches; blocking loading states are reserved for the first request when no data is available yet.
