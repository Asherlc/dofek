# Loading Performance Monitors

These monitor specs live in `scripts/loading-performance-monitors.ts`. They are not automatically applied; validate the APL against the production `dofek-logs` schema before creating or updating Axiom monitors.

## Required monitors

| Monitor | Query signal | Threshold | Owner response |
| --- | --- | --- | --- |
| Loading perf: slow tRPC procedure | `db_duration_ms` p95 and `total_duration_ms` max grouped by `procedure` | p95 above 5000 ms for 2 of 3 runs | Classify the slow procedure with the loading runbook before changing query code. |
| Loading perf: ClickHouse queue wait | `clickhouse.queue_wait` span p95 and max grouped by `clickhouse.queue.name` | p95 above 1000 ms for 2 of 3 runs | Check queue depth and active ClickHouse work before adding retries or broader timeouts. |
| Loading perf: ClickHouse infrastructure errors | ClickHouse DNS, connection refused, timeout, and memory messages | Any matching event | Treat the event as root-cause evidence and fix the infrastructure cause directly. |

## Creation workflow

1. Run Axiom schema discovery for `dofek-logs` and confirm the fields used by each query exist in the target window. On 2026-07-02, dataset discovery succeeded but `getschema` was blocked by the Axiom limiter with trace `895049a092736a1149ccd3904e5d1bcd`; rerun schema discovery before creating live monitors.
2. Dry-run each `aplQuery` from `scripts/loading-performance-monitors.ts` against recent production data.
3. Create or update Axiom monitors with the checked-in names, thresholds, ranges, intervals, and group notification settings.
4. Record the monitor IDs next to the issue or incident that creates them.

Axiom documents monitor management through the `/v2/monitors` API, threshold and match monitor behavior in monitor examples, and `percentile()` as an APL aggregation function for distribution thresholds. See the Axiom monitor API docs, monitor examples, and percentile docs for the current platform details:

- https://axiom.co/docs/restapi/endpoints/getMonitors
- https://axiom.co/docs/monitor-data/monitor-examples
- https://axiom.co/docs/apl/aggregation-function/percentile

## Regression policy

Client loading checks use `shouldShowBlockingLoading()` helpers in web and mobile tests. Existing data must stay visible during background refetches; blocking loading states are reserved for the first request when no data is available yet.
