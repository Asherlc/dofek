# Verify Review-Seed Nutrition Dates TDD Plan

**Goal:** Make review-data validation prove the advertised number of distinct nutrition days.

**Behavior:** Seed verification fails unless the reviewer user has food entries on at least 85 distinct calendar dates.

**Scope:** Correct the nutrition-day verification query and add a real-database regression test. Do not change generated nutrition data unless the corrected assertion exposes a separate seed-data defect.

**Docs:** [`scripts/README.md`](../../../scripts/README.md), [`docs/testing.md`](../../testing.md)

---

## Current Evidence

- The `"nutrition days"` verifier executes `COUNT(*) FROM fitness.food_entry`, which counts food rows.
- The next `"food entries"` verifier executes the same query with a lower threshold.
- Therefore 85 food rows on one date satisfy a check labeled and documented as 85 nutrition days.

Primary sources: the verifier in [`seed-dev-db.ts`](../../../scripts/seed-dev-db.ts),
the canonical seed writer's `fitness.food_entry.date` input in
[`nutrition.ts`](../../../scripts/seed/nutrition.ts), and PostgreSQL's
[`COUNT(DISTINCT expression)` aggregate semantics](https://www.postgresql.org/docs/current/functions-aggregate.html).

## Test Strategy

- Unit: not sufficient because the defect is SQL aggregation semantics.
- Integration: count the canonical `fitness.food_entry.date` SQL `date` column directly, with no timezone conversion. Seed multiple rows on fewer dates and include `logged_at` timestamps on both sides of UTC/local midnight to prove timestamps cannot change the calendar-date count.
- UI/mobile/web parity: both review clients consume the same seeded nutrition history.

## File Structure

- Modify: `scripts/seed-dev-db.ts` - count distinct canonical nutrition dates for the reviewer user.
- Create/modify: a real-database seed verification integration test - distinguish row count from date count.

## Tasks

### Task 1: Add Failing Tests

- [ ] Add a Postgres integration fixture with many food rows on fewer than 85 distinct `date` values, including midnight-boundary `logged_at` values.
- [ ] Run `rtk pnpm vitest run --project integration <test-path>`.
- [ ] Confirm the current query incorrectly passes the nutrition-day condition.

### Task 2: Implement the Minimal Fix

- [ ] Change only the `nutrition days` query to count distinct canonical food-entry dates.
- [ ] Preserve the separate total `food entries` assertion.
- [ ] Run the focused integration test.

### Task 3: Final Verification

- [ ] Run the full review seeder against a fresh disposable database.
- [ ] Confirm output reports at least 85 distinct nutrition dates and at least 20 entries.
- [ ] Prove exactly 85 distinct dates succeeds, fewer than 85 fails, and the separate total-row assertion remains independently enforced.
- [ ] Run `rtk pnpm lint`, `rtk pnpm typecheck`, and the focused integration test.
- [ ] Record a short retrospective covering root cause, direct fix, validation evidence, and a concrete documentation or skill improvement.
