# Dashboard Query Family Optimization TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation.

**Goal:** Optimize only dashboard query families that fresh evidence proves remain slow after client rendering, persistence, batching, and queueing fixes.

**Behavior:** Each slow dashboard family gets a small, targeted fix with a failing query-shape or read-model test first.

**Scope:** Recovery, workload, sleep, healthspan, insights, anomaly, daily metrics, and mobile dashboard procedures. Non-goals: umbrella refactors or speculative dbt models.

**Docs:** `analytics/README.md`, `packages/server/src/routers/mobile-dashboard.ts`, recovery/sleep/healthspan routers, Axiom baseline issue.

---

## Current Evidence

- Historical dashboard batches reached ~19.5s, with RHR/sleep/healthspan ClickHouse issues documented.
- Later Axiom evidence showed some long spans were queue wait rather than ClickHouse execution.
- Therefore this issue is gated on fresh Axiom naming a current slow family.

## Test Strategy

- Evidence: Axiom baseline must name the procedure and bottleneck type.
- Unit: query-shape tests prove bounded joins, serving table reads, or no raw sensor scans.
- Analytics: dbt model tests/lints if adding an incremental model.

## File Structure

- Modify only files for the specific named family, such as:
- `packages/server/src/routers/recovery.ts`
- `packages/server/src/routers/sleep.ts`
- `packages/server/src/routers/healthspan*.ts`
- `packages/server/src/routers/anomaly-detection.ts`
- `analytics/models/**`

## Tasks

### Task 1: Evidence Gate

- [ ] Link Axiom baseline rows naming one slow family.
- [ ] Capture exact procedure, max/avg/p95 duration, queue wait if present, and ClickHouse query evidence.
- [ ] State why client/cache/queue fixes do not already address it.

### Task 2: Add Failing Query Test

- [ ] Write a failing test for the specific regression: unbounded join, raw/deduped sensor scan, missing serving table read, or repeated request-time aggregation.
- [ ] Run the focused route/service test, e.g. `rtk pnpm vitest run packages/server/src/routers/<route>.test.ts --project unit`.

### Task 3: Implement Minimal Fix

- [ ] Prefer reading an existing named serving table.
- [ ] If adding dbt, create an incremental model with domain/grain-specific name.
- [ ] Keep API response shape unchanged unless explicitly approved.

### Task 4: Verification

- [ ] Run focused server tests.
- [ ] Run `rtk pnpm lint:analytics-sql` and `rtk pnpm lint:analytics-policy` if SQL changed.
- [ ] Run `rtk pnpm analytics:build` if analytics models changed and local ClickHouse is up.
- [ ] Record before/after Axiom evidence.
