# Provider Metric-Stream Counts Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the production `provider_stats` raw metric-stream recount with a bounded, exact, dbt-owned daily count source that converges from compact day-change keys and preserves replacement, tombstone, resurrection, and late-arrival semantics.

**Architecture:** Add a date-aware covering projection to `ingest.metric_stream`; add migration-owned `analytics.metric_stream_day_change` state plus an insert-triggered materialized view; add an incremental `analytics.provider_metric_stream_daily` ReplacingMergeTree model that recomputes only dirty provider/day keys; make `provider_stats` sum the daily rows and block provider publication while any day key is outstanding. Historical marker bootstrap and projection materialization remain explicit operator actions documented in the deploy runbook.

**Tech Stack:** TypeScript, ClickHouse migrations, dbt-clickhouse incremental models, Vitest ClickHouse integration tests, existing analytics worker model contracts.

## Global Constraints

- Follow the approved design in `docs/superpowers/specs/2026-08-01-provider-metric-stream-counts-design.md`.
- Keep `ingest.metric_stream` as the only raw canonical source; projections and day-change state are support/invalidation structures, not alternate application sources of truth.
- Preserve exact latest-state semantics with `argMax(..., tuple(version, ingested_at))`; never solve the incident by increasing timeouts, retries, memory, or warning-and-continuing.
- Keep the transformation dbt-owned and incremental. Do not add a request-time TypeScript aggregation or a naive ClickHouse materialized view containing counts.
- Use TDD: add a failing test for each changed behavior before implementing it, and execute database behavior against ClickHouse rather than only checking SQL strings.
- Do not mutate production during workspace validation. Rollout commands belong in the runbook and must include stop conditions.
- Use `pnpm compose -- ...` for local Compose operations. Preserve unrelated workspace Docker resources if the known address-pool exhaustion blocks integration setup.
- Keep provider stats’ existing dirty-provider batching/fairness and public API shape unchanged.

---

## Task 1: Extend metric-stream schema support and migration registry

**Files:**

- Modify `src/metric-stream/clickhouse-table.ts`.
- Add `src/db/clickhouse-migrations/0068_provider_metric_stream_daily_counts.ts`.
- Add `src/db/clickhouse-migrations/0068_provider_metric_stream_daily_counts.integration.test.ts`.
- Modify `src/db/clickhouse-migrations/registry.ts`.
- Modify `src/db/clickhouse-migrations/registry.test.ts`.

**Step 1 — Write failing schema/migration tests.**

Add assertions in `src/metric-stream/clickhouse-table.test.ts` for the new projection name, grouping/order expressions, and fresh-table DDL. Add registry assertions for migration `0068_provider_metric_stream_daily_counts`, including the day-change table, its ingest materialized view, and the projection alteration. Add the new migration integration test that applies the migration statements to isolated replacement tables and proves an inserted metric row creates a `(user_id, provider_id, recorded_date)` marker.

**Step 2 — Run the focused tests to verify they fail.**

Run:

```sh
pnpm vitest run src/db/clickhouse-migrations/registry.test.ts src/db/clickhouse-migrations/0068_provider_metric_stream_daily_counts.integration.test.ts src/metric-stream/clickhouse-table.test.ts
```

If the repository uses a different existing metric-stream schema test path, locate it with `rg` and run that focused file instead; do not skip the failing test.

**Step 3 — Implement the schema and forward-only migration.**

- Define the date-aware covering projection in the shared metric-stream DDL builder. It must cover `user_id, provider_id, id, recorded_at, ingested_at, version, is_deleted` and sort by `(user_id, provider_id, recorded_at, id, version, ingested_at)`. Exact latest-state resolution remains in the model's tuple-valued `argMax` query because ClickHouse rejects the aggregate projection shape.
- Include that projection in fresh `ingest.metric_stream` table creation.
- Add migration `0068_provider_metric_stream_daily_counts` that:
  - creates `analytics.metric_stream_day_change` as an `AggregatingMergeTree` keyed by `(user_id, provider_id, recorded_date)` with an aggregate maximum change timestamp;
  - creates an insert-triggered materialized view from `ingest.metric_stream` that emits `toDate(recorded_at)` for every raw insert, including tombstones and late arrivals;
  - adds the date-aware projection to the existing raw table with `ADD PROJECTION IF NOT EXISTS`.
- Register the migration after `0067` without changing branch history or renumbering prior migrations.

Do not materialize the projection or scan/bootstrap historical rows in the deploy migration.

**Step 4 — Run focused tests to verify they pass.**

Run the registry, schema, and migration integration tests from Step 2. Confirm the test exercises live inserts and a tombstone marker, not only DDL text.

**Step 5 — Commit.**

```sh
git add src/metric-stream/clickhouse-table.ts src/db/clickhouse-migrations/0068_provider_metric_stream_daily_counts.ts src/db/clickhouse-migrations/0068_provider_metric_stream_daily_counts.integration.test.ts src/db/clickhouse-migrations/registry.ts src/db/clickhouse-migrations/registry.test.ts src/metric-stream/clickhouse-table.test.ts
git commit -m "feat: track metric stream changed days"
```

## Task 2: Add the dbt daily provider metric-stream count model

**Files:**

- Modify `analytics/models/sources.yml`.
- Add `analytics/models/read_models/provider_metric_stream_daily.sql`.
- Add `analytics/models/read_models/provider_metric_stream_daily.sql.test.ts`.
- Add or modify the colocated ClickHouse integration test for the model, using the repository’s read-model SQL helpers and isolated database setup.

**Step 1 — Write failing model and ClickHouse behavior tests.**

Add static tests that require:

- an incremental, `full_refresh=false`, `ReplacingMergeTree` model ordered by `(user_id, provider_id, recorded_date)`;
- a bounded dirty-day batch with a conservative configurable default;
- the unfiltered source alias for current-state metric data and the day-change source;
- the date-aware projection preference and `max_threads=1`;
- no timeout, retry, raw-count fallback, or warning-and-continue behavior.

Add an executable ClickHouse integration test that seeds current-state raw rows and day-change keys, renders the model SQL, and verifies:

- live rows count once;
- a higher-version replacement is counted according to the replacement;
- a tombstone removes the ID from the count;
- a later live row resurrects it;
- a late row for an older recorded day marks and recomputes only that day;
- a fully deleted day emits a zero-count replacement row;
- a small day-key batch leaves the remaining day keys dirty for a subsequent run.

**Step 2 — Run the new tests to verify they fail.**

Run the new static test and integration test directly with the repository’s supported Vitest command. The integration test must use a real ClickHouse instance and must not use module-level mocks.

**Step 3 — Implement the model.**

- Add a source alias for the raw `metric_stream` table without an event-time filter so the selected recorded-day keys control the scan, plus a source declaration for `analytics.metric_stream_day_change`; retain the existing freshness source unchanged for sensor models.
- Read compact day keys from `analytics.metric_stream_day_change`, compare their aggregate change timestamp with the existing daily target read using `FINAL`, order deterministically, and apply a configurable bounded limit.
- Resolve the selected days’ latest rows using the date-aware projection as an optimizer hint while retaining the exact `argMax` resolution contract. Group by `(user_id, provider_id, id)` before counting live rows.
- Emit one replacement row per selected day, including zero counts, source change time, refresh version, and refresh timestamp. Ensure target rows are read with `FINAL` wherever convergence comparisons or downstream sums require it.
- Keep the model append/bounded-key workflow independent of the existing sensor microbatch time bounds; do not add an unused global timestamp bound merely to satisfy a model-list contract.

**Step 4 — Run the focused tests to verify they pass.**

Run the model static test and the executable ClickHouse test. Inspect the generated SQL if ClickHouse rejects a projection setting or aggregate type, then make the smallest schema-consistent correction and rerun the test.

**Step 5 — Commit.**

```sh
git add analytics/models/sources.yml analytics/models/read_models/provider_metric_stream_daily.sql analytics/models/read_models/provider_metric_stream_daily.sql.test.ts packages/server/src/repositories/provider-metric-stream-daily.integration.test.ts
git commit -m "feat: add daily metric stream counts"
```

## Task 3: Replace the raw provider-stats recount with the compact source

**Files:**

- Modify `analytics/models/read_models/provider_stats.sql`.
- Modify `analytics/models/read_models/provider_stats.sql.test.ts`.
- Modify `packages/server/src/repositories/provider-stats-read-model.integration.test.ts`.

**Step 1 — Write failing provider-stats tests.**

Update the integration fixture to create/seed the daily count target and day-change marker. Add assertions that provider stats sums daily rows exactly, remains dirty while any day key is newer than its daily row, and converges after successive bounded daily batches. Preserve coverage for other provider-stat sources and existing provider dirty-watermark fairness.

Replace tests whose only purpose is to assert that `provider_stats` directly resolves raw metric IDs with tests of the daily model; do not retain obsolete negative tests for deleted implementation. Keep exact raw current-state coverage in the daily-model/migration integration suite.

Update static assertions to require the daily model ref, compact day-dirty readiness check, `FINAL` daily summation, and no direct `source('ingest', 'metric_stream')` provider recount or timeout workaround.

**Step 2 — Run the focused tests to verify they fail.**

Run:

```sh
pnpm vitest run analytics/models/read_models/provider_stats.sql.test.ts packages/server/src/repositories/provider-stats-read-model.integration.test.ts
```

**Step 3 — Implement the handoff.**

- Remove the raw `metric_stream_current` and raw metric count aggregation from `provider_stats`.
- Add `ref('provider_metric_stream_daily')` and sum `metric_stream_count` for the selected provider keys with `FINAL`.
- Add a compact daily-source readiness predicate to the provider candidate selection. A provider with any day-change marker newer than its daily target row must remain dirty and must not publish a partial provider count.
- Preserve the existing provider-change watermark, one-provider batch size, source freshness metadata, and output columns.

**Step 4 — Run the focused tests to verify they pass.**

Run both focused tests, then inspect the rendered query plan/explain fixture if available to verify the provider-stats SQL no longer reads the raw metric stream.

**Step 5 — Commit.**

```sh
git add analytics/models/read_models/provider_stats.sql analytics/models/read_models/provider_stats.sql.test.ts packages/server/src/repositories/provider-stats-read-model.integration.test.ts
git commit -m "perf: sum compact provider metric counts"
```

## Task 4: Wire the worker DAG, model contracts, and policy tests

**Files:**

- Modify `src/processing/dataset-contracts.ts`.
- Modify `src/processing/dataset-contracts.test.ts`.
- Modify `entrypoint.sh`.
- Modify `analytics/models/read_models/read_model_microbatch.sql.test.ts`.
- Modify only the analytics build/processing tests that assert the exact production model order, if the focused test run identifies one beyond the contract and read-model tests.
- Modify `src/processing/analytics-microbatch-bounds.ts` tests only if needed to document that the daily dirty-key model intentionally uses key batching rather than sensor time bounds.

**Step 1 — Write failing DAG/contract tests.**

Require `provider_metric_stream_daily` immediately before `provider_change_watermark`/`provider_stats` in every production and E2E analytics selection list, and require the dataset contract to declare the daily model dependency. Add a policy assertion that the production order cannot run `provider_stats` before the compact daily source. Verify the existing four sensor microbatch bounds remain unchanged and no unused bound is introduced.

**Step 2 — Run the focused tests to verify they fail.**

Run the dataset-contract, read-model microbatch, analytics-build, and analytics-worker script tests that cover model selection.

**Step 3 — Implement the wiring.**

- Insert the daily model before the watermark/provider-stats models in `PRODUCTION_DBT_MODELS` and the worker’s `DBT_ACTIVITY_MODELS` list.
- Keep `scripts/run-analytics-build.ts` using the existing production model list and existing sensor bound resolver. The daily model owns a conservative default dirty-day batch size through `var('provider_metric_stream_day_batch_size', 32)`, so production and E2E builds do not need a new global time bound or runner-only configuration.
- Update contracts and expected model arrays together so worker startup and build selection cannot silently omit the dependency.

**Step 4 — Run focused tests to verify they pass.**

Run the tests from Step 2 and confirm the model list order is stable and the existing microbatch-bound tests still pass.

**Step 5 — Commit.**

```sh
git add src/processing/dataset-contracts.ts src/processing/dataset-contracts.test.ts entrypoint.sh analytics/models/read_models/read_model_microbatch.sql.test.ts
git commit -m "chore: wire daily provider count model"
```

Only include files actually changed; do not add unrelated test files to the commit.

## Task 5: Add rollout runbook and incident baseline evidence

**Files:**

- Modify `analytics/README.md`.
- Modify `docs/clickhouse-metric-stream.md`.
- Modify `docs/clickhouse-read-model-deploy-runbook.md`.
- Append to `docs/production-incident-baseline.md`.

**Step 1 — Write documentation review checks.**

Before editing, search for every statement that says `provider_stats` directly counts current metric-stream IDs or that treats the existing projection as the final performance fix. The updated docs must describe the compact daily source, historical bootstrap, projection materialization, readiness checks, and rollback/stop conditions without promising that this workspace changed production.

**Step 2 — Implement documentation.**

- Document the new daily serving grain, marker semantics, and exact latest-state behavior.
- Add copyable operator commands for applying the forward migration, materializing the projection, waiting/checking mutation completion, bootstrapping historical day keys, and verifying all active parts have the projection. Use the repository’s approved Compose/production procedures and explicit table names; do not include an automatic deploy-time historical scan.
- Add verification queries for outstanding dirty day keys, daily source freshness, provider-stats `QueryFinish`, analytics processing success, and downstream freshness. Include stop conditions for failed mutations or continued raw scans.
- Append the August 2026 incident entry with the exact Sentry/query-log evidence, root cause, direct code fix, current rollout status, remaining risk, and follow-up ownership. State unresolved rollout items explicitly until an operator deploys and verifies them.

**Step 3 — Review docs for unsupported claims.**

Check that third-party behavior claims cite ClickHouse/dbt primary documentation, and that no timeout or retry is presented as remediation. Confirm commands do not mutate production as part of local validation.

**Step 4 — Commit.**

```sh
git add analytics/README.md docs/clickhouse-metric-stream.md docs/clickhouse-read-model-deploy-runbook.md docs/production-incident-baseline.md
git commit -m "docs: document provider count rollout"
```

## Task 6: Full validation and handoff

**Files:**

- No new production code expected; inspect the complete diff and generated SQL.

**Step 1 — Run fast validation.**

Run formatting, lint/typecheck targets for changed TypeScript/dbt files, all focused unit tests, and the ClickHouse migration/model integration tests.

**Step 2 — Run repository test tiers appropriate to the change.**

Run the documented integration tier through `pnpm test:integration` or the narrow equivalent after starting dependencies with `pnpm compose -- ...`. If the known Docker address-pool exhaustion still prevents container creation, record the exact command and first fatal line; do not prune unrelated workspace resources or claim integration success.

**Step 3 — Inspect behavior and diff.**

Verify:

- no provider-stats query reads `ingest.metric_stream` directly;
- no new timeout, retry, fallback, empty-count, or warning-and-continue path exists;
- daily rows are keyed by provider/day and zero rows are emitted for fully deleted days;
- model ordering and readiness checks prevent partial provider publication;
- migration registry order, fresh schema DDL, and docs agree;
- `git diff origin/main...` contains only the approved incident fix and documentation.

**Step 4 — Report with evidence.**

Provide the user the root cause, changed files/commits, tests actually passing, any Docker-environment blocker, and the production rollout commands/status. Include the required retrospective: what went well, what investigation was needed, useful next-time context, proposed `AGENTS.md`/README/runbook improvements, and relevant skills for a future incident.
