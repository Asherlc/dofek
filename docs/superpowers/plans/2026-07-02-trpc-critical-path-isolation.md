# tRPC Critical Path Isolation TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation.

**Goal:** Prevent slow noncritical sibling requests from delaying dashboard-critical UI responses.

**Behavior:** Core dashboard/readiness/strain data loads independently from anomaly, insight, and other noncritical queries.

**Scope:** tRPC link routing, batching exclusions, query enablement/deferment, and tests. Non-goals: optimizing the underlying ClickHouse query shape.

**Docs:** `packages/mobile/app/_layout.tsx`, `packages/web/src/lib/trpc.ts`, `packages/web/src/pages/Dashboard.tsx`, `packages/mobile/app/(tabs)/index.tsx`.

---

## Current Evidence

- Checked-in Axiom evidence shows a mobile parent trace took `3.40s` because sibling `anomalyDetection.check` took `3.39s`, while `mobileDashboard.dashboard` itself was fast.
- Mobile already has special unbatched links for some dashboard queries; web uses streamed batching.

## Test Strategy

- Unit: link split conditions classify critical procedures correctly.
- Component: noncritical queries are disabled until core data exists.
- Axiom: after deploy, parent dashboard span should not wait on anomaly/insight siblings.

## File Structure

- Modify: `packages/mobile/app/_layout.tsx`
- Modify: `packages/mobile/app/_layout.cleanup.test.tsx`
- Modify: `packages/web/src/lib/trpc.ts`
- Modify: `packages/web/src/lib/trpc.test.ts`
- Modify: web/mobile dashboard screens and tests.

## Tasks

### Task 1: Add Failing Critical Path Tests

- [ ] Test mobile critical query paths route through unbatched/nonblocking links.
- [ ] Test web critical paths are not batched with known slow noncritical queries where evidence requires isolation.
- [ ] Test anomaly/insight queries are enabled only after core dashboard data exists.
- [ ] Run `rtk pnpm vitest run packages/mobile/app/_layout.cleanup.test.tsx packages/web/src/lib/trpc.test.ts packages/web/src/pages/Dashboard.test.tsx packages/mobile/app/'(tabs)'/index.test.tsx --project unit --project mobile`.

### Task 2: Implement Isolation

- [ ] Update link split conditions with explicit tests for every route path.
- [ ] Defer anomaly/insight queries until core data exists.
- [ ] Do not remove error reporting; show noncritical errors in local panels only.

### Task 3: Verification

- [ ] Re-run focused tests.
- [ ] Compare Axiom parent spans before/after when access is available.
- [ ] Run `rtk pnpm lint` and relevant typechecks.
