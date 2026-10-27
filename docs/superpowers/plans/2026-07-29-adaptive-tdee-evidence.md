# Adaptive TDEE Evidence TDD Plan

**Goal:** Make adaptive TDEE available in the deterministic review fixture and explain the estimate's exact input sufficiency, calendar window, exclusions, observed range, or unavailability on web and mobile.

**Behavior:** The review seed supplies canonical body-weight samples without replacing unrelated sensor data. The API evaluates real calendar-day windows and returns server-owned evidence. Both clients render the same evidence and never infer the estimate's validity or range.

**Scope:** This plan keeps the existing energy-balance formula and 28-day/70%-calorie eligibility rule. It does not add a probabilistic confidence interval, consume provider calorie-expenditure estimates, treat DEXA as a daily-weight source, or add a compatibility path around canonical ClickHouse sensor analytics.

**Issue:** [#2137](https://github.com/Asherlc/dofek/issues/2137)

---

## Current Evidence

- An isolated review seed produced 90 available calorie days in `fitness.v_nutrition_daily` and two DEXA records, but zero `body_weight` rows for the review user in canonical ClickHouse `ingest.metric_stream`.
- `nutritionAnalytics.adaptiveTdee` reads weight through deduped `analytics.daily_body_measurement`; DEXA is not an input.
- `scripts/seed-review-clickhouse.ts` refreshes relational mirrors while preserving, but not populating, canonical metric-stream rows. Retrying cannot make the fixture sufficient.
- The estimator currently advances across available nutrition rows rather than calendar days, so missing and source-conflict dates do not count against a 28-day window.
- The existing `confidence` value is a coverage ratio rather than calibrated uncertainty, and mobile formats its 0–1 value as though it were already a percentage.

## Test Strategy

- Unit: prove calendar-day window behavior, evidence counts, accepted rolling estimate range, and exact server-authored unavailability reasons.
- Integration: prove canonical Postgres source conflicts are excluded and reported, and prove the review ClickHouse seed inserts deterministic body-weight rows while preserving unrelated metric-stream rows.
- Web/mobile parity: prove available and unavailable responses render the same server-provided window, coverage, exclusion, range, and reason details; update both Storybook fixtures.

## File Structure

- Modify `scripts/seed-review-clickhouse.ts` and its integration test for canonical review weight samples.
- Modify `packages/server/src/repositories/nutrition-analytics-repository.ts` and colocated tests for calendar evaluation and evidence.
- Modify `packages/server/src/routers/nutrition-analytics.ts` and the nutrition analytics integration suite for the response contract.
- Modify web and mobile adaptive-TDEE components/tests/stories for parity.
- Update review-fixture documentation to state the canonical weight fixture.

## Tasks

### Task 1: Add Failing Server and Seed Tests

- [x] Add unit tests for true 28-calendar-day windows, conflict/missing-day exclusions, observed rolling estimate range, and distinct calorie/weight insufficiency reasons.
- [x] Add a real Postgres/ClickHouse integration case proving the response reports canonical conflict exclusion semantics.
- [x] Extend the review ClickHouse seed integration test to require deterministic canonical body-weight samples and preservation of the existing sentinel row.
- [x] Run focused Vitest unit and integration commands and confirm failures identify the missing behavior.

### Task 2: Implement the Server and Fixture Contract

- [x] Seed deterministic review-user body-weight samples in `ingest.metric_stream` without truncating or replacing unrelated rows.
- [x] Build dense server-side calendar input from canonical nutrition statuses and deduped body weight.
- [x] Return status, fit requirements, coverage, exclusions, unavailability reason, and observed rolling estimate range from the server.
- [x] Remove the misleading confidence field from the shared response.
- [x] Run the focused server and seed tests to green.

### Task 3: Add Failing Dual-Platform Rendering Tests

- [x] Add web tests for available evidence and server-authored unavailable evidence.
- [x] Add mobile tests for the same contract and wording.
- [x] Confirm both focused suites fail before UI implementation.

### Task 4: Implement Web/Mobile Parity and Stories

- [x] Render fit window, coverage, exclusions, observed estimate range, and unavailability reason on web.
- [x] Render the same server-owned evidence on mobile.
- [x] Add consistent available and unavailable stories on both platforms.
- [x] Run focused web/mobile tests and Storybook type/build validation.

### Task 5: Final Verification and Delivery

- [x] Run formatting, lint, typecheck, focused unit/integration tests, and required changed-test checks.
- [x] Re-run the isolated review seed and prove canonical calories, body weight, and an available adaptive-TDEE response.
- [x] Update review fixture documentation with the validated canonical data path.
- [ ] Open a PR with `Fixes #2137`, link it from the issue, address CI and review feedback, and merge after required checks pass.
