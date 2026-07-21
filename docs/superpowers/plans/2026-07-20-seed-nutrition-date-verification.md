# Verify Review-Seed Nutrition Dates TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation. If executing this plan task-by-task, also use superpowers:executing-plans or superpowers:subagent-driven-development as appropriate. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make review-data validation prove the advertised number of distinct nutrition days.

**Behavior:** Seed verification fails unless the reviewer user has food entries on at least 85 distinct calendar dates.

**Scope:** Correct the nutrition-day verification query and add a real-database regression test. Do not change generated nutrition data unless the corrected assertion exposes a separate seed-data defect.

**Docs:** [`scripts/README.md`](../../../scripts/README.md), [`docs/testing.md`](../../testing.md)

---

## Current Evidence

- The `"nutrition days"` verifier executes `COUNT(*) FROM fitness.food_entry`, which counts food rows.
- The next `"food entries"` verifier executes the same query with a lower threshold.
- Therefore 85 food rows on one date satisfy a check labeled and documented as 85 nutrition days.

## Test Strategy

- Unit: not sufficient because the defect is SQL aggregation semantics.
- Integration: seed multiple food rows on fewer dates in real Postgres and prove the corrected query counts distinct dates and fails the threshold.
- UI/mobile/web parity: both review clients consume the same seeded nutrition history.

## File Structure

- Modify: `scripts/seed-dev-db.ts` - count distinct canonical nutrition dates for the reviewer user.
- Create/modify: a real-database seed verification integration test - distinguish row count from date count.

## Tasks

### Task 1: Add Failing Tests

- [ ] Add a Postgres integration fixture with many food rows on fewer than 85 distinct dates.
- [ ] Run `rtk pnpm vitest run --project integration <test-path>`.
- [ ] Confirm the current query incorrectly passes the nutrition-day condition.

### Task 2: Implement the Minimal Fix

- [ ] Change only the `nutrition days` query to count distinct canonical food-entry dates.
- [ ] Preserve the separate total `food entries` assertion.
- [ ] Run the focused integration test.

### Task 3: Final Verification

- [ ] Run the full review seeder against a fresh disposable database.
- [ ] Confirm output reports at least 85 distinct nutrition dates and at least 20 entries.
- [ ] Run `rtk pnpm lint`, `rtk pnpm typecheck`, and the focused integration test.
