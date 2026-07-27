# Analytics Agent Guide

Read [README.md](./README.md) first.

## Boundaries

- dbt owns expensive ClickHouse transformations under `models/`; do not embed
  equivalent serving transformations in TypeScript request paths.
- Every new expensive model must be incremental, use domain-and-grain naming,
  and read canonical deduped inputs where provider overlap applies.
- Preserve bounded microbatch or dirty-key behavior. Historical backfills need
  explicit start/end bounds and operator intent.
- Declare dependencies with `ref()` and sources with `source()`.
- Do not add `REFRESH EVERY` materialized views or request-time full refreshes.
- Follow
  [`../docs/performance/loading-performance-runbook.md`](../docs/performance/loading-performance-runbook.md)
  before creating a route-facing read model.

## Validation

Run `pnpm lint:analytics-sql`, `pnpm lint:analytics-policy`, and the relevant
database-backed integration tier. Static SQL string tests do not replace an
executable ClickHouse behavior test.

dbt's incremental-model and microbatch behavior is documented in
[incremental models](https://docs.getdbt.com/docs/build/incremental-models)
and
[microbatch backfills](https://docs.getdbt.com/docs/build/incremental-microbatch#backfills).
