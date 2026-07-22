# Comprehensive Processing Status TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation. If executing this plan task-by-task, also use superpowers:executing-plans or superpowers:subagent-driven-development as appropriate. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the partial readiness banner with a durable, scoped processing-status backend and equivalent web/mobile widget covering ingest, canonical commit, CDC, analytics, cache refresh, and readiness.

**Behavior:** Users can see what is processing, which provider and datasets it affects, the exact current stage, progress and timestamps, and actionable failures without hiding already available data or showing unrelated account activity.

**Scope:** Durable processing operations/events, typed dataset contracts, provider/import/CDC/dbt/cache instrumentation, reconciliation, tRPC status/history APIs, web/mobile widget parity, observability, migration, and removal of the superseded `sync.dataHealth` path. Non-goals are documented in the approved specification.

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

## Test Strategy

- **Unit:** Dataset contract validation, event state reduction, precedence, stage messages, filtering, idempotency keys, dbt artifact parsing, reconciler decisions, and shared UI formatting.
- **Postgres integration:** Migration constraints, append-only event persistence, tenant isolation, cursor history, idempotent writes, and transactional canonical-commit events.
- **ClickHouse integration:** CDC watermark observations and dataset reconciliation against real mirrored/read-model fixtures.
- **Worker integration:** Provider/import lifecycle, dbt per-model result capture, partial model failure, cache refresh failure, and repeatable reconciliation.
- **Web/mobile parity:** Default, active, delayed, partial, failed, ready, empty-history, scoped-provider, scoped-dataset, loading, and API-error stories/tests on both platforms.
- **Regression:** Kaya historical import, unrelated active provider, failure precedence, stale cached stats, and already-rendered data preservation.

## File Structure

- Create: `src/db/schema/processing.ts` — processing operation and append-only stage-event tables.
- Create: `drizzle/0055_processing_status.sql` and journal metadata — schema migration.
- Create: `src/processing/dataset-contracts.ts` — typed user-facing dataset dependency registry.
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

- [ ] Write failing tests requiring every production dbt model to be assigned to a user-facing dataset or explicitly marked internal.
- [ ] Cover provider/dataset applicability, dependency validation, failure-first precedence, partial readiness, stalled stages, and terminal-state reduction.
- [ ] Run `rtk pnpm vitest run src/processing/dataset-contracts.test.ts src/processing/processing-state.test.ts --project unit` and confirm expected failures.
- [ ] Implement the minimum typed registry and pure reducer.
- [ ] Re-run the focused unit tests and confirm they pass.

### Task 2: Add the Durable Append-Only Ledger

**Files:**
- Create: `src/db/schema/processing.ts`
- Modify: `src/db/schema/index.ts`
- Create: `drizzle/0055_processing_status.sql`
- Create: `src/processing/processing-event-store.integration.test.ts`
- Create: `src/processing/processing-event-store.ts`

- [ ] Write failing Postgres integration tests for operation creation, append-only stage events, tenant isolation, idempotent event insertion, ordered history, and current-state projection.
- [ ] Run the focused suite through `rtk pnpm test:integration -- src/processing/processing-event-store.integration.test.ts` and verify the first failure.
- [ ] Add schema, constraints, indexes, migration, runtime Zod parsing, and repository implementation.
- [ ] Apply the migration in the workspace integration database and rerun the suite.

### Task 3: Instrument Provider Syncs and Imports

**Files:**
- Modify: provider sync enqueue/worker/process modules.
- Modify: import queue/process modules and canonical import transaction boundaries.
- Create/modify: focused unit and integration tests colocated with each changed source.

- [ ] Write failing tests for queued, running, progress, canonical-commit, succeeded, failed, and cancelled events.
- [ ] Verify historical imports use ingestion/commit watermarks rather than domain timestamps.
- [ ] Verify retries reuse the operation and idempotency keys instead of duplicating events.
- [ ] Implement lifecycle instrumentation with sanitized errors and Sentry reporting.
- [ ] Run focused provider/import tests and the relevant integration tier.

### Task 4: Capture CDC Evidence and Reconcile Operations

**Files:**
- Modify: `src/db/clickhouse-cdc-health.ts`
- Create: `src/processing/processing-reconciler.integration.test.ts`
- Create: `src/processing/processing-reconciler.ts`

- [ ] Write real ClickHouse integration fixtures proving CDC remains waiting until every required mirror covers the canonical commit watermark.
- [ ] Cover partial mirrors, inactive/lost slots, historical records, deletions, unknown evidence, and idempotent reruns.
- [ ] Expand mirror freshness observations to every registered source table without replacing per-operation watermark proof with a broad health check.
- [ ] Implement and schedule the reconciler.
- [ ] Run focused ClickHouse/Postgres integration tests.

### Task 5: Record Every dbt Model Result

**Files:**
- Create: `src/processing/dbt-run-results.test.ts`
- Create: `src/processing/dbt-run-results.ts`
- Create: `scripts/run-analytics-build.ts`
- Modify: `entrypoint.sh`

- [ ] Write failing tests against success, skipped, warning, error, and malformed `run_results.json` fixtures.
- [ ] Require all 35 production models to emit a terminal model event for each attempted run.
- [ ] Implement a TypeScript analytics runner that invokes pinned dbt commands, parses artifacts through Zod, persists run/model events, and exits nonzero on model failures.
- [ ] Preserve strict sequential resource limits and current retry semantics without adding waits or fallbacks.
- [ ] Validate a successful local analytics build and a controlled failing-model fixture.

### Task 6: Record Cache Refresh Outcomes

**Files:**
- Modify: `scripts/warm-query-cache.test.ts`
- Modify: `scripts/warm-query-cache.ts`
- Modify: processing reconciler tests.

- [ ] Write failing tests requiring per-query-family success/failure events and dataset association.
- [ ] Preserve hard failure when any registered refresh fails.
- [ ] Implement cache-refresh evidence and advance only covered datasets to ready.
- [ ] Verify retries are idempotent and failed refreshes remain visible.

### Task 7: Add Scoped Status and History APIs

**Files:**
- Create: `packages/server/src/repositories/processing-repository.test.ts`
- Create: `packages/server/src/repositories/processing-repository.ts`
- Create: `packages/server/src/routers/processing.test.ts`
- Create: `packages/server/src/routers/processing.ts`
- Modify: `packages/server/src/router.ts`

- [ ] Write failing tests for account, provider, and dataset scopes; tenant isolation; failure precedence; progress; watermarks; last-ready state; bounded history; and actionable messages.
- [ ] Verify model/infrastructure details are absent from ordinary user responses.
- [ ] Implement `processing.status` and cursor-paginated `processing.history` with runtime output schemas.
- [ ] Run focused server unit and integration tests.

### Task 8: Build the Shared Presentation Model

**Files:**
- Create: `packages/providers-meta/src/processing-status.test.ts`
- Create: `packages/providers-meta/src/processing-status.ts`
- Modify: package exports.

- [ ] Write failing tests for layman-readable headings, stage descriptions, progress, relative/absolute timestamps, scope summaries, and actionable failure text.
- [ ] Implement the shared platform-neutral presentation logic.
- [ ] Confirm no infrastructure acronyms or unexpanded technical terms reach user copy.

### Task 9: Build the Web Widget

**Files:**
- Create: `packages/web/src/components/ProcessingStatusWidget.test.tsx`
- Create: `packages/web/src/components/ProcessingStatusWidget.stories.tsx`
- Create: `packages/web/src/components/ProcessingStatusWidget.tsx`
- Modify: relevant web page hosts.

- [ ] Write failing component tests and stories for all material states and provider/dataset scopes.
- [ ] Implement compact and expanded timeline views with accessible live-region behavior that avoids repetitive announcements.
- [ ] Preserve previous page data during background processing and show API failures through the existing query error model.
- [ ] Run focused web tests and Storybook build.

### Task 10: Build the Mobile Widget

**Files:**
- Create: `packages/mobile/components/ProcessingStatusWidget.test.tsx`
- Create: `packages/mobile/components/ProcessingStatusWidget.stories.tsx`
- Create: `packages/mobile/components/ProcessingStatusWidget.tsx`
- Modify: relevant mobile screen hosts.

- [ ] Mirror every web state and scope in mobile tests and stories.
- [ ] Implement an accessible expandable stage timeline and refresh behavior.
- [ ] Preserve rendered data during background refetches and report unexpected client errors to Sentry.
- [ ] Run focused mobile tests and Storybook build.

### Task 11: Remove the Superseded Readiness System

**Files:**
- Remove/modify: `sync.dataHealth`, repository helpers, shared readiness helpers, and both `DataReadinessBanner` implementations/tests/stories.

- [ ] Update existing positive behavior tests to use the processing API/widget.
- [ ] Remove the old implementation without adding tests that merely assert its absence.
- [ ] Confirm there is one canonical status system and no dual-read compatibility layer.

### Task 12: Final Verification and Operational Documentation

- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm typecheck`.
- [ ] Run `rtk pnpm test`.
- [ ] Run `rtk pnpm test:integration` with the workspace Compose dependencies.
- [ ] Run relevant Storybook builds and `rtk pnpm size`.
- [ ] Run `rtk pnpm test:changed:all` if the focused suites do not cover every changed boundary.
- [ ] Document deployment ordering, migration, event retention, reconciliation, dashboards/alerts, and incident diagnosis.
- [ ] Append the confirmed Kaya discrepancy and replacement architecture to `docs/production-incident-baseline.md`.
- [ ] Confirm success without ad-hoc waits, retries, warning-and-continue behavior, or threshold inflation.

