# Provider Metric-Stream Counts Design

## Status

Approved direction; written-spec review pending.

## Problem and evidence

The production Sentry issue `DOFEK-SERVER-5Q` reports `AnalyticsBuildError`
from `provider_stats`. ClickHouse returns code 159 after the server's
240-second execution limit. The production `system.query_log` entry at
2026-08-02 04:24:17 UTC read 49,057,569 rows (8.35 GiB) while recounting one
dirty provider.

`ingest.metric_stream` already has the
`by_provider_current_state` projection on every active part, and the failing
query selected it. That projection reduces replacement resolution to one row
per `(user_id, provider_id, id)`, but `provider_stats` still has to aggregate
every current ID for the dirty provider. The remaining cost is therefore
proportional to provider cardinality, not to the number of changed rows.

The existing incident runbook correctly treats this as a read-model design
problem rather than a reason to increase `max_execution_time`, add retries, or
force a larger memory budget. ClickHouse's latest-state guidance describes
precomputed `argMax` state as the appropriate pattern when repeatedly resolving
raw `ReplacingMergeTree` history is too expensive:
<https://clickhouse.com/resources/engineering/clickhouse-optimize-table-final>.

## Goals

- Keep the exact `provider_stats.metric_stream` count semantics.
- Make refresh work proportional to changed recorded days, not all current
  metric IDs for a provider.
- Detect late-arriving rows through ingestion-time change markers.
- Preserve replacements, tombstones, and resurrection semantics.
- Keep raw metric data canonical and keep the serving transformation dbt-owned.
- Make historical rollout explicit and observable rather than hiding it in a
  deploy migration.

## Non-goals

- Changing provider inventory API shapes or client behavior.
- Replacing the existing provider dirty-watermark workflow.
- Changing raw metric-stream ingestion or deleting historical raw data.
- Increasing ClickHouse or client timeouts, adding retries, or weakening the
  analytics failure path.
- Building a generic metric-stream aggregate for unrelated routes.

## Proposed architecture

### 1. Date-aware latest-state projection

Add a ClickHouse projection to `ingest.metric_stream` named
`by_provider_current_state_recorded_at`. It will group by
`(user_id, provider_id, id)` and expose the latest `recorded_at`,
`ingested_at`, `version`, and `is_deleted` using the same ordering tuple as
the existing current-state projection: `(version, ingested_at)`. Its sort order
will be `(user_id, provider_id, recorded_at, id)`.

The projection is an optimizer support structure, not a second application
source of truth. Queries will retain an `argMax`-based exact fallback so a
partially materialized projection cannot produce incorrect counts. The dbt
model will prefer the date-aware projection, and rollout verification will
require it to be present on every active metric-stream part. ClickHouse requires
an explicit `MATERIALIZE PROJECTION` operation for historical parts after a
projection is added:
<https://clickhouse.com/docs/data-modeling/projections#filtering-on-columns-which-arent-in-the-primary-key>.

### 2. Compact metric-stream day-change state

Add a migration-owned change marker table
`analytics.metric_stream_day_change` with one aggregate row per
`(user_id, provider_id, recorded_date)` and the maximum source change time.
Add an insert-triggered materialized view from `ingest.metric_stream` that
writes the changed day keys for every raw insert, including tombstone inserts.
This table is only a compact invalidation source; it does not store counts or
replace the raw metric stream.

Historical day keys will be bootstrapped as an explicit operator action after
the projection is materialized. The bootstrap is intentionally outside the
deploy migration because it scans existing data and rewrites projection parts.

### 3. dbt-owned daily count model

Add `analytics/models/read_models/provider_metric_stream_daily.sql`, an
incremental `ReplacingMergeTree` model with one row per
`(user_id, provider_id, recorded_date)`. Each invocation selects a bounded
batch of day keys whose change time is newer than the model's existing row,
then recomputes the exact current state for only those keys:

1. Read dirty day keys from `metric_stream_day_change`.
2. Select current metric rows for those keys from `ingest.metric_stream`.
3. Resolve each ID with `argMax(..., tuple(version, ingested_at))`.
4. Count rows whose latest `is_deleted` value is zero.
5. Emit a replacement row, including a zero count when a day has become fully
   tombstoned.

The model will use a configurable bounded day-key batch size with a conservative
production default. It will use `max_threads=1` like the existing offline
analytics models. Its source query will prefer the date-aware projection so
ClickHouse reads only the selected provider/day ranges; the exact `argMax`
query remains the correctness contract.

The day model must converge over successive worker cycles. A provider is not
eligible for a new `provider_stats` row while any metric-stream day key for
that provider remains newer than the corresponding daily count row. This keeps
partial historical catch-up from being reported as a complete provider count.

### 4. Provider-stats integration

Update `provider_stats` so `metric_stream_counts` sums the compact daily rows
for the selected providers instead of scanning `ingest.metric_stream`. The
existing provider dirty-watermark selection and one-provider batch fairness
remain in place. The new daily model will run immediately before
`provider_stats` in the production dbt selection order.

The production and E2E model lists, microbatch-bound resolver, source aliases,
analytics model contracts, and model-policy tests will be updated together so
the dependency is explicit and cannot be omitted from the worker DAG.

## Data correctness

- A replacement keeps the same metric ID and a higher version; `argMax` picks
  the replacement.
- A tombstone remains in the latest-state projection and contributes zero.
- A later live row for the same ID contributes one again.
- Scoped delete-and-replace events mark the affected recorded days through the
  tombstones and replacement inserts.
- Late ingestion of an older recorded day marks that day through the change
  materialized view and causes a bounded recomputation.
- Daily rows are read with `FINAL` when summed by `provider_stats`, so old
  `ReplacingMergeTree` versions cannot be double-counted before background
  merges complete.

Metric IDs are expected to retain their recorded-day identity, as the canonical
metric-stream ID is derived from the provider/external identity and recorded
timestamp. If a future writer intentionally moves a stable ID across recorded
days, that writer must emit a tombstone for the old row; the existing deletion
protocol already preserves the old recorded day for that tombstone.

## Testing

Add executable ClickHouse coverage for:

- migration creation of the day-change table, materialized view, and projection;
- projection readiness and date-aware filtering;
- daily counts across live rows, replacements, tombstones, resurrection, and
  late-arriving older recorded days;
- zero-count daily rows after full deletion;
- provider stats summing daily rows without reading the raw metric stream;
- provider readiness remaining blocked while dirty day keys are outstanding;
- successive bounded batches converging to the exact raw current-state count.

Add focused static model tests for configuration, source aliases, batch bounds,
projection preference, selection order, and the absence of timeout/retry
workarounds. Database behavior will be tested against ClickHouse rather than
only by asserting SQL substrings. dbt incremental models will follow the
repository's documented incremental-model conventions:
<https://docs.getdbt.com/docs/build/incremental-models>.

## Rollout and verification

1. Deploy the forward-only migration that adds the projection and day-change
   state/MV.
2. Materialize the date-aware projection and monitor the ClickHouse mutation
   until it succeeds.
3. Bootstrap historical day-change keys from the materialized current-state
   projection as an explicit operator action.
4. Run the analytics worker. It will process daily keys in bounded batches and
   leave provider watermarks dirty until each provider's daily source catches
   up.
5. Verify every active raw part has the new projection, no provider day keys
   remain dirty, `provider_stats` has a `QueryFinish` row, analytics processing
   has recorded success, and downstream freshness has advanced.

No production mutation is part of implementation validation in this workspace.
The operator commands and stop conditions will be added to the ClickHouse
read-model deploy runbook before rollout.

## Failure behavior

Missing projection materialization, missing change-state tables, or an
incomplete daily source must fail the analytics build or leave the provider
watermark visibly dirty. The implementation will not fall back to stale counts,
empty counts, warning-and-continue behavior, or longer timeouts.
