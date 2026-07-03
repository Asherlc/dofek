# Provider Sync All Resilience Verification TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation. If executing this plan task-by-task, also use superpowers:executing-plans or superpowers:subagent-driven-development as appropriate. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining Provider Sync All Resilience follow-up by proving the shipped per-provider sync outcome behavior, filling missing regression coverage, and reconciling the stale unchecked plan.

**Behavior:** Sync-all returns per-provider outcomes without hiding other providers behind one cooldown, duplicate job, or queue failure; web and mobile display those outcomes; queue backpressure remains visible through the implemented route; the roadmap plan reflects the current implementation state.

**Scope:** Verification, missing tests, and documentation cleanup only. Do not redesign provider queues, add retry knobs, change cooldown behavior, or introduce compatibility response shapes unless a failing test proves the current behavior is wrong.

**Docs:** Existing stale plan: [`docs/superpowers/plans/incident-informed-repo-audit/provider-sync-all-resilience.md`](incident-informed-repo-audit/provider-sync-all-resilience.md). Current implementation is in [`packages/server/src/routers/sync.ts`](../../../packages/server/src/routers/sync.ts), [`packages/web/src/components/DataSourcesPanel.tsx`](../../../packages/web/src/components/DataSourcesPanel.tsx), and [`packages/mobile/app/providers/index.tsx`](../../../packages/mobile/app/providers/index.tsx).

---

## Current Evidence

- `sync.triggerSync` already returns `providerResults` with `started`, `skippedCooldown`, `alreadyQueued`, and `failed` statuses.
- Server tests already cover sync-all cooldown, already queued, and failed provider outcomes in `packages/server/src/routers/sync.test.ts`.
- Queue visibility landed as admin `sync.queueBackpressure`, not as `queueDepth` on `activeSyncs`.
- Mobile provider tests cover skipped cooldown rendering, but the old plan still has unchecked tasks and web coverage does not directly exercise provider outcome rendering through `DataSourcesPanel`.

## Test Strategy

- Unit: server router tests prove response contracts and queue backpressure behavior.
- Web: component tests prove sync-all provider outcomes update the correct provider card and poll only pollable results.
- Mobile: component tests prove parity for skipped, failed, started, and already queued outcomes.
- Docs: update the stale plan to distinguish completed implementation from any intentional route-shape differences.

## File Structure

- Modify: `packages/web/src/components/DataSourcesPanel.test.tsx` - add provider outcome regression tests around sync-all.
- Modify: `packages/mobile/app/providers/index.test.tsx` - backfill failed and already queued provider outcome cases if missing.
- Modify: `docs/superpowers/plans/incident-informed-repo-audit/provider-sync-all-resilience.md` - mark completed work or add a short reconciliation note.
- Modify if needed: `docs/roadmap.md` - link the active verification issue only if roadmap tracking still lists this as outstanding.

## Tasks

### Task 1: Add Failing Web Outcome Tests

**Files:**
- Modify: `packages/web/src/components/DataSourcesPanel.test.tsx`

- [x] Write failing tests that click `Sync All` and prove `skippedCooldown`, `failed`, `started`, and `alreadyQueued` provider results update only the matching provider card.
- [x] Write a failing test proving `started` and `alreadyQueued` results poll the returned provider-scoped job ID, while `skippedCooldown` and `failed` do not poll fake jobs.
- [x] Run `rtk pnpm vitest run --project unit packages/web/src/components/DataSourcesPanel.test.tsx`.
- [x] Confirm the tests pass against existing behavior; no production web change was needed.

### Task 2: Implement Minimal Web Coverage Or Fixes

**Files:**
- Modify: `packages/web/src/components/DataSourcesPanel.tsx`
- Modify: `packages/web/src/components/DataSourcesPanel.test.tsx`

- [x] If the tests expose a real behavior gap, implement the smallest change in `DataSourcesPanel.tsx`.
- [x] Behavior already works, so keep production code unchanged and commit only the regression tests.
- [x] Run `rtk pnpm vitest run --project unit packages/web/src/components/DataSourcesPanel.test.tsx`.
- [x] Confirm the tests pass.

### Task 3: Backfill Mobile Outcome Parity Gaps

**Files:**
- Modify: `packages/mobile/app/providers/index.test.tsx`
- Modify if needed: `packages/mobile/app/providers/index.tsx`

- [x] Add or confirm mobile tests for `skippedCooldown`, `failed`, `started`, and `alreadyQueued` provider results from sync-all.
- [x] Prove `started` and `alreadyQueued` poll the returned provider-scoped job ID.
- [x] Prove `skippedCooldown` and `failed` surface the server message without polling.
- [x] Run `rtk pnpm vitest run --project mobile packages/mobile/app/providers/index.test.tsx`.
- [x] Confirm mobile behavior matches web behavior.

### Task 4: Reconcile Queue Visibility And Stale Plan

**Files:**
- Modify: `docs/superpowers/plans/incident-informed-repo-audit/provider-sync-all-resilience.md`
- Modify if needed: `docs/roadmap.md`

- [x] Document that queue visibility is provided by `sync.queueBackpressure` instead of `queueDepth` on `activeSyncs`, unless a failing test proves user-facing active syncs still need queue depth.
- [x] Mark completed checklist items or add a top-level reconciliation note so this plan no longer appears fully outstanding.
- [x] Run `rtk pnpm vitest run --project unit packages/server/src/routers/sync.test.ts --testNamePattern "triggerSync|queueBackpressure"`.
- [x] Confirm the server behavior matches the reconciled documentation.

### Task 5: Final Verification

- [x] Run `rtk pnpm vitest run --project unit packages/server/src/routers/sync.test.ts packages/web/src/components/DataSourcesPanel.test.tsx`.
- [x] Run `rtk pnpm vitest run --project mobile packages/mobile/app/providers/index.test.tsx`.
- [x] Run `rtk pnpm tsc --noEmit`.
- [x] Run `rtk pnpm lint`.
- [ ] Commit and push if implementation work is requested after this issue is picked up.

Verification note (2026-07-03): focused server/web tests, focused mobile tests, and `rtk pnpm tsc --noEmit` passed. `rtk pnpm lint` passed Biome, then failed in `pnpm lint:analytics-sql` because dbt/sqlfluff could not connect to local ClickHouse at `http://127.0.0.1:8123` (`Connection refused`). This is an environment service blocker, not a changed-file lint failure.
