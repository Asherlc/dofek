# Comprehensive Processing Status TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation. If executing this plan task-by-task, also use superpowers:executing-plans or superpowers:subagent-driven-development as appropriate. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the partial readiness banner with a durable, scoped processing-status backend and equivalent web/mobile widget covering ingest, canonical commit, CDC, analytics, cache refresh, and readiness.

**Behavior:** Users can see what is processing, which provider and datasets it affects, the exact current stage, progress and timestamps, and actionable failures without hiding already available data or showing unrelated account activity.

**Scope:** Durable processing operations/events, conditional output-path contracts, provider/import/CDC/dbt/cache instrumentation, reconciliation, tRPC status/history APIs, web/mobile widget parity, observability, migration, and removal of the superseded `sync.dataHealth` path. Relational Postgres output and Redpanda metric-stream output remain independent; no metric payload is routed through Postgres for status coordination. Non-goals are documented in the approved specification.

**Docs:** [`docs/superpowers/specs/2026-07-21-processing-status-system.md`](../specs/2026-07-21-processing-status-system.md), `docs/production-incident-baseline.md`, `docs/testing.md`, `packages/server/src/routers/sync.ts`, `entrypoint.sh`.

---

## Current Evidence

- The current readiness API hard-codes only `dailyMetrics`, `sleep`, and `activity`, while the production analytics worker builds 35 dbt models.
- `provider_stats`, which supplies provider record counts, is outside readiness coverage.
- The API assigns `cdcLagSeconds` and `readModelLagSeconds` from the same raw-vs-serving timestamp comparison.
- Provider detail calls unscoped readiness, so unrelated active provider jobs can produce its heading.
- Kaya committed 7 activities/63 climbing entries at `2026-07-22T00:11:28Z`; the provider-stats query began before PeerDB delivered those activity rows and published an empty snapshot.
- Maximum domain timestamps cannot detect late-arriving historical imports.
- CDC health checks replication slots and only the `sleep_session` mirror freshness by default.
- dbt builds and cache warming have no durable per-run/per-model application state.
- The obsolete `dofek_metric_stream_analytics` PeerDB flow is not part of the current metric-stream architecture; metric samples reach ClickHouse through Redpanda.
- Relational activity records and metric-stream samples are both valid independently, so a static contract requiring both would invent a domain dependency and could leave legitimate operations waiting forever.

## Test Strategy

- **Unit:** Conditional output-contract validation, event state reduction, precedence, stage messages, filtering, idempotency keys, dbt artifact parsing, reconciler decisions, and shared UI formatting.
- **Postgres integration:** Migration constraints, append-only event persistence, tenant isolation, cursor history, idempotent writes, and relational causal-fence markers committed transactionally with reconciliation dispatch after relational writes complete.
- **ClickHouse integration:** Exact PeerDB marker observations, exact Redpanda sink acknowledgements per emitted batch/partition, and dataset reconciliation against real mirrored/read-model fixtures.
- **Worker integration:** Provider/import lifecycle, output manifests, legitimate skipped paths, independent relational/metric partial failure, dbt per-model result capture, cache refresh failure, and repeatable reconciliation.
- **Web/mobile parity:** Default, active, delayed, partial, failed, ready, empty-history, scoped-provider, scoped-dataset, loading, and API-error stories/tests on both platforms.
- **Regression:** Kaya historical import, unrelated active provider, failure precedence, stale cached stats, and already-rendered data preservation.

## File Structure

- Create: `src/db/schema/processing.ts` — processing operation, append-only stage-event, flow-marker, and queue-outbox tables.
- Create: `drizzle/0056_processing_status.sql` and journal metadata — schema migration.
- Create: `src/processing/dataset-contracts.ts` — typed user-facing dataset registry with conditional relational and metric-stream output dependencies.
- Create: `src/processing/processing-event-store.ts` — persistence and current-state queries.
- Create: `src/processing/processing-state.ts` — pure state reduction and precedence.
- Create: `src/processing/processing-reconciler.ts` — CDC/model/cache/ready advancement.
- Create: `src/processing/dbt-run-results.ts` — Zod-validated dbt artifact parsing.
- Create/modify: provider/import job processors — operation lifecycle instrumentation.
- Create/modify: `scripts/check-clickhouse-cdc.ts`, analytics runner, and `scripts/warm-query-cache.ts` — durable stage evidence.
- Create: `packages/server/src/routers/processing.ts` and repository — protected status/history API.
- Create: `packages/providers-meta/src/processing-status.ts` — shared presentation model.
- Create: web/mobile `ProcessingStatusWidget.tsx`, colocated tests and stories.
- Modify: web/mobile page hosts — replace the old readiness banner with scoped processing status.
- Remove after parity: old readiness API/repository helpers, shared banner helper, and web/mobile banner components/tests/stories.
- Update: `docs/production-incident-baseline.md` and relevant README/runbook documentation.

## Tasks

### Task 1: Define Dataset Contracts and State Semantics

**Files:**
- Create: `src/processing/dataset-contracts.test.ts`
- Create: `src/processing/processing-state.test.ts`
- Create: `src/processing/dataset-contracts.ts`
- Create: `src/processing/processing-state.ts`

- [x] Write failing tests requiring every production dbt model to be assigned to a user-facing dataset or explicitly marked internal.
- [x] Cover provider/dataset applicability, conditional output-path dependencies, legitimate absent/skipped paths, failure-first precedence, partial readiness, stalled-stage derivation, and terminal-state reduction without persisting derived conditions.
- [x] Prove that relational activity output does not require metric-stream output, metric-stream output does not require relational activity output, and dependencies apply only when the operation's output manifest says that path emitted records.
- [x] Run `rtk pnpm vitest run src/processing/dataset-contracts.test.ts src/processing/processing-state.test.ts --project unit` and confirm expected failures.
- [x] Implement the minimum typed registry and pure reducer.
- [x] Re-run the focused unit tests and confirm they pass.

### Task 2: Add the Durable Append-Only Ledger

**Files:**
- Create: `src/db/schema/processing.ts`
- Modify: `src/db/schema/index.ts`
- Create: `drizzle/0056_processing_status.sql`
- Create: `src/processing/processing-event-store.integration.test.ts`
- Create: `src/processing/processing-event-store.ts`

- [x] Write failing Postgres integration tests for operation creation, append-only stage events, monotonic ordering, tenant isolation, idempotent event insertion, relational CDC markers and reconciliation-queue outbox rows in one causal-fence transaction, ordered history, and current-state projection.
- [x] Verify the processing queue outbox contains only reconciliation work; it must not duplicate metric-stream payloads in Postgres.
- [x] Run the focused suite through `rtk pnpm test:integration -- src/processing/processing-event-store.integration.test.ts` and verify the first failure.
- [x] Add schema, constraints, indexes, migration, runtime Zod parsing, and repository implementation.
- [x] Apply the migration in the workspace integration database and rerun the suite.

### Task 3: Instrument Provider Syncs and Imports

**Files:**
- Modify: provider sync enqueue/worker/process modules.
- Modify: import queue/process modules and canonical import transaction boundaries.
- Create/modify: focused unit and integration tests colocated with each changed source.

- [x] Write failing tests for queued, running, progress, output-manifest, canonical-commit, succeeded, failed, cancelled, and legitimately skipped events.
- [x] Record relational and metric-stream outputs independently, including per-batch Redpanda publication acknowledgements with stable operation identifiers.
- [x] Verify activities without metric samples and metric samples without activities both complete without fabricated dependencies.
- [x] Verify historical imports use ingestion/commit watermarks rather than domain timestamps.
- [x] Verify retries reuse the operation and idempotency keys instead of duplicating events.
- [x] Implement lifecycle instrumentation with sanitized errors and Sentry reporting.
- [x] Run focused provider/import tests and the relevant integration tier.

### Task 4: Capture CDC Evidence and Reconcile Operations

**Files:**
- Modify: `src/db/clickhouse-cdc-health.ts`
- Create: `src/processing/processing-reconciler.integration.test.ts`
- Create: `src/processing/processing-reconciler.ts`

- [x] Write real ClickHouse integration fixtures proving relational CDC remains waiting until every applicable mirror contains the exact operation marker.
- [x] Write real sink fixtures proving metric-stream CDC remains waiting until ClickHouse contains acknowledgements for every batch/partition actually emitted by the operation.
- [x] Cover relational-only, metric-only, combined, legitimate no-output, partial mirrors, partial sink batches, inactive/lost slots, historical records, deletions, unknown evidence, and idempotent reruns.
- [x] Use an exact per-operation marker in every applicable mirror as the authoritative proof; keep broad table freshness as a diagnostic rather than treating rarely changing domain timestamps as a correctness gate.
- [x] Implement and schedule the reconciler.
- [x] Run focused ClickHouse/Postgres integration tests.

### Task 5: Record Every dbt Model Result

**Files:**
- Create: `src/processing/dbt-run-results.test.ts`
- Create: `src/processing/dbt-run-results.ts`
- Create: `scripts/run-analytics-build.ts`
- Modify: `entrypoint.sh`

- [x] Write failing tests against success, skipped, warning, error, and malformed `run_results.json` fixtures.
- [x] Require all 35 production models to emit a terminal model event for each attempted run.
- [x] Implement a TypeScript analytics runner that gives each invocation a distinct artifact directory, invokes pinned dbt commands, reconciles `run_results.json` with `manifest.json` through Zod, persists run/model events, and exits nonzero on failed or selected-but-unattempted required models.
- [x] Preserve strict sequential resource limits and current retry semantics without adding waits or fallbacks.
- [x] Validate dbt compilation plus successful and controlled-failure artifact fixtures without replaying heavyweight historical microbatches in the validation path.

### Task 6: Record Cache Refresh Outcomes

**Files:**
- Modify: `scripts/warm-query-cache.test.ts`
- Modify: `scripts/warm-query-cache.ts`
- Modify: processing reconciler tests.

- [x] Write failing tests requiring per-query-family success/failure events and dataset association.
- [x] Preserve hard failure when any registered refresh fails.
- [x] Implement cache-refresh evidence and advance only covered datasets to ready.
- [x] Verify retries are idempotent and failed refreshes remain visible.

### Task 7: Add Scoped Status and History APIs

**Files:**
- Create: `packages/server/src/repositories/processing-repository.test.ts`
- Create: `packages/server/src/repositories/processing-repository.ts`
- Create: `packages/server/src/routers/processing.test.ts`
- Create: `packages/server/src/routers/processing.ts`
- Modify: `packages/server/src/router.ts`

- [x] Write failing tests for account, provider, and dataset scopes; tenant isolation; failure precedence; progress; watermarks; last-ready state; bounded history; and actionable messages.
- [x] Verify model/infrastructure details are absent from ordinary user responses.
- [x] Implement `processing.status` and cursor-paginated `processing.history` with runtime output schemas.
- [x] Run focused server unit and integration tests.

### Task 8: Build the Shared Presentation Model

**Files:**
- Create: `packages/providers-meta/src/processing-status.test.ts`
- Create: `packages/providers-meta/src/processing-status.ts`
- Modify: package exports.

- [x] Write failing tests for layman-readable headings, stage descriptions, progress, relative/absolute timestamps, scope summaries, and actionable failure text.
- [x] Implement the shared platform-neutral presentation logic.
- [x] Confirm no infrastructure acronyms or unexpanded technical terms reach user copy.

### Task 9: Build the Web Widget

**Files:**
- Create: `packages/web/src/components/ProcessingStatusWidget.test.tsx`
- Create: `packages/web/src/components/ProcessingStatusWidget.stories.tsx`
- Create: `packages/web/src/components/ProcessingStatusWidget.tsx`
- Modify: relevant web page hosts.

- [x] Write failing component tests and stories for all material states and provider/dataset scopes.
- [x] Implement compact and expanded timeline views with determinate/indeterminate progress semantics, polite live-region behavior that avoids repetitive announcements, and adaptive polling that stops at terminal state.
- [x] Preserve previous page data during background processing and show API failures through the existing query error model.
- [x] Run focused web tests and Storybook build.

### Task 10: Build the Mobile Widget

**Files:**
- Create: `packages/mobile/components/ProcessingStatusWidget.test.tsx`
- Create: `packages/mobile/components/ProcessingStatusWidget.stories.tsx`
- Create: `packages/mobile/components/ProcessingStatusWidget.tsx`
- Modify: relevant mobile screen hosts.

- [x] Mirror every web state and scope in mobile tests and stories.
- [x] Implement an accessible expandable stage timeline, equivalent progress semantics, and adaptive foreground polling tied to native app state.
- [x] Preserve rendered data during background refetches and report unexpected client errors to Sentry.
- [x] Run focused mobile tests and Storybook build.

### Task 11: Remove the Superseded Readiness System

**Files:**
- Remove/modify: `sync.dataHealth`, repository helpers, shared readiness helpers, and both `DataReadinessBanner` implementations/tests/stories.

- [x] Update existing positive behavior tests to use the processing API/widget.
- [x] Remove the old implementation without adding tests that merely assert its absence.
- [x] Confirm there is one canonical status system and no dual-read compatibility layer.

### Task 12: Final Verification and Operational Documentation

- [x] Run `rtk pnpm lint`.
- [x] Run `rtk pnpm typecheck`.
- [x] Run `rtk pnpm test`.
- [x] Run `rtk pnpm test:integration` with the workspace Compose dependencies.
- [x] Run relevant Storybook builds and `rtk pnpm size`.
- [x] Use the complete unit/mobile and integration tiers because they cover every changed boundary more broadly than `test:changed:all`.
- [x] Document deployment ordering, migration, event retention, reconciliation, dashboards/alerts, and incident diagnosis.
- [x] Append the confirmed Kaya discrepancy and replacement architecture to `docs/production-incident-baseline.md`.
- [x] Confirm success without ad-hoc waits, retries, warning-and-continue behavior, or threshold inflation.
- [x] Confirm metric-stream payloads still travel directly through Redpanda and are not duplicated in a Postgres outbox.
