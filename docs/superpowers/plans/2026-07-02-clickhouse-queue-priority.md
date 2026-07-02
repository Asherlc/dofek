# ClickHouse Queue Priority TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation.

**Goal:** Ensure long detail/exploratory ClickHouse reads cannot starve dashboard-critical reads.

**Behavior:** Dashboard-critical query families enter a dashboard-priority queue, queue wait is observable in Axiom, and route classification is tested.

**Scope:** `LimitedActivitySensorStore`, priority markers, queue-wait spans/logs, and tests. Non-goals: changing query SQL unless evidence shows priority is insufficient.

**Docs:** `packages/server/src/repositories/limited-activity-sensor-store.ts`, production baseline 2026-06-18 Axiom evidence.

---

## Current Evidence

- Axiom evidence showed `activity.stream` occupied the shared ClickHouse limiter for about `122s` while web recovery/workload spans waited, even though their child ClickHouse HTTP spans were short.
- Current code has separate dashboard and regular limiters, but classification must stay current as new dashboard-critical read models are added.

## Test Strategy

- Unit: priority routing and in-flight dedupe behavior.
- Telemetry: queue wait logs/spans include queue name, active count, depth, concurrency, and wait.
- Axiom: post-deploy queue wait p95 for dashboard queue is tracked.

## File Structure

- Modify: `packages/server/src/repositories/limited-activity-sensor-store.ts`
- Modify: `packages/server/src/repositories/limited-activity-sensor-store.test.ts`
- Modify route/service call sites that should pass `{ priority: "dashboard" }`.

## Tasks

### Task 1: Add Failing Queue Tests

- [ ] Test dashboard-priority queries use dashboard limiter while regular queries use regular limiter.
- [ ] Test identical in-flight queries dedupe within the same priority.
- [ ] Test queue wait telemetry fields are emitted without health data.
- [ ] Run `rtk pnpm vitest run packages/server/src/repositories/limited-activity-sensor-store.test.ts --project unit`.

### Task 2: Implement/Repair Priority Classification

- [ ] Add explicit priority at dashboard-critical call sites named by Axiom baseline.
- [ ] Keep regular/detail queries out of dashboard queue.
- [ ] Add tests for every named dashboard-critical route.

### Task 3: Verification

- [ ] Re-run focused tests.
- [ ] Use Axiom baseline issue to compare dashboard queue wait p95 before/after.
- [ ] Run `rtk pnpm test:unit`.
