# Dofek MCP Data Quality and Coverage Design

## Goal

Make Dofek's MCP health and activity analysis numerically trustworthy: missing
data is explicit, aggregates carry metric-level coverage, invalid observations
are rejected at ingestion, and previously opaque activity/body-data gaps become
diagnosable or are corrected from preserved provider history.

## Scope

This work implements all P0, P1, and P2 items in the request. It retains the
existing provider-agnostic raw-data model and uses the existing Postgres,
ClickHouse, dbt, tRPC, and MCP boundaries. It does not add client-side metric
calculation.

`total_calories` is removed from the MCP activity contract rather than populated:
the repository policy forbids serving provider/device calorie-expenditure
estimates. Nutrition intake and weight-change-derived TDEE remain the only
permitted calorie concepts.

## Data-quality contract

All absent numeric observations serialize as `null`; values are never replaced
by `0`, `-1`, or an omitted key. The shared daily-metric serialization boundary
will preserve valid zeroes only for metrics whose domain permits zero, while
HRV, resting heart rate, sleep efficiency, and weight are positive-only.

Ingestion validates those positive-only values before storage. Rejected rows are
recorded with user, provider, metric, local date, rejected value, and rejection
reason, then reported through the existing structured sync result and Sentry.
The ingest path does not repair invalid values at read time.

The health explorer response changes from one global observed-day count to:

```ts
coverage: {
  requested_days: number;
  by_metric: Record<string, {
    observed_days: number;
    missing_days: string[];
    missing_days_truncated_count: number;
  }>;
}
```

`missing_days` has at most 30 ISO local dates. Every aggregate reports its
corresponding coverage adjacent to the aggregate value, including trend and
activity summaries where an aggregate is emitted.

## MCP contracts

`get_health_trends` returns an envelope for every valid request:

```ts
{
  range: { start_date, end_date, granularity, timezone },
  requested_metrics: string[],
  series: [{ metric, label, unit, points, note?: "no_data_in_range", coverage }],
  diagnostics: {
    metrics_with_no_data: string[];
    range_clamped: boolean;
    earliest_available: string | null;
  }
}
```

The request's metrics remain present even if no samples exist. Dead health
metrics are identified from the canonical ingestion/read-model inventory before
implementation: each is either wired to an actual source or removed from the
input enum and presentation map. A new `get_data_coverage` read tool returns
first/last local date, total observed days, and contributing provider IDs for
every supported metric.

`render_health_explorer` consumes the same series builder, so it cannot develop
a separate missing-value or coverage policy. Its dated fixtures include
2026-08-21, 2026-08-23, 2026-08-30, 2026-08-13, 2026-08-20, and 2026-08-28.

`get_activity_summary` adds `unclassified_pct` for the selected range and group.
`raw_type` is retained on the activity model and returned in activity detail so
future canonical-mapping misses are directly inspectable. The tool drops the
permanently-null calorie field. An `other` rate above 5% is treated as a
regression in coverage tests and surfaced in the response, not silently hidden.

## Storage and ingestion

Daily-grain body rows become unique on `(user_id, metric, date,
source_provider)`. The schema migration deterministically keeps the newest
ingested row; if timestamps tie, it keeps the row with the most non-null
measurement fields, then the stable row ID. The migration removes duplicates
before adding the constraint. All writers use the same conflict key and update
the retained raw row idempotently.

The ClickHouse body projection reads the canonical row, and its serving query
will return per-source values plus a server-authored reconciled value. The
reconciliation policy is explicit and metric-specific: a configured primary
source wins when present; otherwise the newest valid source observation wins;
the response retains the per-source values and chosen source. This prevents
downstream averaging of mutually overlapping provider data.

## Activity classification and training analytics

An evidence query reports every raw activity type currently mapping to `other`,
with provider, count, and total duration ordered by frequency. Mapping changes
cover the head of that exact distribution, including climbing disciplines,
hangboard/fingerboard, strength variants, walking, hiking, HIIT, functional
training, cardio, kayaking, paddling, and running variants. Existing provider
mapping modules remain isolated; there is no cross-provider classifier.

Climbing and hangboard sessions retain provider raw fields and expose structured
per-session measurements: climbing discipline, grade/attempt/send distribution,
wall angle, and vertical total; hangboard edge depth, grip, hang/rest duration,
added/removed load, and total time under tension. `get_finger_loading` exposes
its input terms and formula, not only its effective-load output.

Cycling analytics are dbt-owned incremental ClickHouse models sourced from
deduped sensor/activity data. They provide per-ride normalized power, intensity
factor, 5-second/1-minute/5-minute/20-minute mean-maximal power, elevation gain,
rolling-90-day bests, and an explicitly labeled estimated FTP series. A
normalized training-load model derives power load where available and HR-based
TRIMP only where power is absent; the API exposes 7-day and 28-day load and
their ratio without client calculation.

## Historical evidence and backfills

Before any historical modification, the implementation gathers production
evidence: source-connection state, provider payload availability, raw 2022
cycling power fields, observed-date boundaries by metric, and source data for
the 2026 activity-type distribution. This distinguishes device-adoption gaps
from failed or truncated ingestion.

When upstream history exists, a TypeScript `pnpm tsx` operational command
performs a dry run by default and requires `--execute` to write. It is user/date
bounded, idempotent, checkpointed, reports proposed and completed changes, and
is documented in a runbook. Deploy migrations contain schema/data-consistency
work only; they never launch provider fetches or replay historical data. The
authorized production execution occurs only after dry-run evidence confirms the
exact rows and source fields to be restored.

## Tests and verification

Each behavioral change follows a red-green-refactor cycle. Unit tests cover
contract serialization, aggregation, coverage, explicit no-data series, mapping,
and validation. Real-database integration tests cover the body uniqueness
constraint, deterministic dedupe, idempotent upsert, and ClickHouse/dbt serving
behavior. Historical backfill tests use minimal preserved-payload fixtures and
do not replay broad production migrations.

The final verification includes the five supplied MCP calls, the duplicate-body
SQL query, the raw-type distribution report, production backfill dry-run and
post-execution counts where applicable, relevant unit/integration suites,
analytics policy checks, lint, and typecheck.

## Delivery order

1. Establish the nullable-only, per-metric coverage, and health-trends envelope
   contracts, with regression fixtures.
2. Add ingest validation, body uniqueness/upserts, reconciliation, and database
   integration coverage.
3. Audit live raw/source data, classify activities, remove dead calorie output,
   and complete data-coverage diagnostics.
4. Implement and verify bounded historic repair where source evidence permits.
5. Add climbing/hangboard detail, cycling fitness, and workload analytics as
   incremental, deduped ClickHouse read models.
