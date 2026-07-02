# Performance Monitors And Regression Tests TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation.

**Goal:** Prevent loading regressions from returning silently.

**Behavior:** Tests catch full-page blanking with existing data, and Axiom monitors catch slow tRPC, dashboard queue wait, and ClickHouse infrastructure errors.

**Scope:** Test helpers, Axiom monitor definitions/runbook, and CI-safe regression checks. Non-goals: changing product UI or backend query implementations.

**Docs:** Axiom alerting skill, existing metrics in `packages/server/src/lib/metrics.ts`, Axiom baseline plan.

---

## Current Evidence

- Loading regressions span client behavior and backend queueing.
- Prior incidents were diagnosed through Axiom slow-query logs and queue wait evidence.

## Test Strategy

- Unit: helper tests assert loading policy.
- Monitor dry run: Axiom queries return expected fields before monitor creation.
- CI: no local E2E unless this issue adds E2E tests.

## File Structure

- Create/modify: `docs/performance/loading-monitors.md`
- Modify: relevant Axiom monitor config/scripts if present.
- Modify: client test helpers if repeated loading assertions need extraction.

## Tasks

### Task 1: Add Regression Test Helpers

- [ ] Extract client test helper for "renders existing data while refetching".
- [ ] Use it in representative web/mobile tests.
- [ ] Run focused client tests.

### Task 2: Define Axiom Monitors

- [ ] Query p95/max slow tRPC procedure duration.
- [ ] Query `clickhouse.queue_wait` p95 by queue.
- [ ] Query ClickHouse infrastructure errors: DNS, connection refused, timeout, memory exceeded.
- [ ] Create monitor specs only after field names are verified by Axiom discovery/schema.

### Task 3: Verification

- [ ] Run `rtk pnpm test:unit`.
- [ ] Run `rtk pnpm test:mobile`.
- [ ] Document monitor thresholds and owner response in `docs/performance/loading-monitors.md`.
