# Nutrition Analytics Source Breakdown TDD Plan

**Goal:** Make nutrient analytics distinguish itemized food, provider daily totals, and explicitly taken supplements while showing selected-window completeness and source overlap before adequacy interpretation.

**Behavior:** The nutrition analytics response reports how many selected days contain nutrition data, how many are usable, how many contain overlapping sources, and which sources contribute or are excluded. Each nutrient reports separate daily averages for itemized food, provider daily totals, and supplements plus per-source contribution rows. Web and iOS show this context before the nutrient chart and render the server-computed values without recomputing them.

**Scope:** Issue [#2136](https://github.com/Asherlc/dofek/issues/2136). All values remain query-time projections over the canonical row nutrient tables and source-resolution views. No schema migration, duplicate totals, ingestion filtering, or provider-specific storage is included. PostgreSQL views are virtual query-defined tables, so the existing canonical projections remain the source of truth ([PostgreSQL `CREATE VIEW`](https://www.postgresql.org/docs/current/sql-createview.html)).

---

## Current Evidence

- `fitness.v_nutrition_canonical_nutrient` already retains provider, food-entry, and supplement-dose attribution after applying the daily source-resolution decision.
- `NutritionAnalyticsRepository.getMicronutrientSafetyReview` currently collapses every food-entry contribution into `foodDailyAverage`, so an itemized meal and a selected provider daily aggregate are indistinguishable in the response.
- The same repository omits days whose food sources conflict because canonical nutrient rows intentionally do not exist for those days, but the analytics response does not expose the conflict or selected-window coverage.
- Web and iOS render only the adequacy percentage and recorded nutrient-day count, so users cannot assess source composition or overlap before interpreting the chart.

## Test Strategy

- Executable Postgres integration: seed itemized entries, daily aggregates, taken supplements, resolved overlaps, and unresolved conflicts; call the repository and prove query-time classification, per-source amounts, and coverage.
- Repository unit: prove DTO rounding and mapping for the three intake types and source rows.
- Router: prove the V2 response includes the selected-window data-quality context.
- Web and iOS: prove completeness, overlap warnings, contributing/excluded sources, and intake-type breakdown appear before adequacy interpretation.
- Stories: cover complete, partial, overlapping, loading, and empty source-context states on both clients.

## File Structure

- Modify `packages/server/src/repositories/nutrition-analytics-repository.ts` and colocated tests — source-aware query and server-owned data-quality DTO.
- Add `packages/server/src/repositories/nutrition-analytics-source-breakdown.integration.test.ts` — real PostgreSQL behavior across canonical views.
- Modify `packages/server/src/routers/nutrition-analytics.ts` and router tests — extended V2 contract.
- Create web and mobile nutrition-source context components with colocated tests and stories.
- Modify the web and mobile nutrition analytics pages — render context before the micronutrient chart.
- Modify `packages/nutrition/README.md` — document the analytics source and completeness contract.

## Tasks

### Task 1: Add Failing Server Tests

- [x] Add an executable database fixture with itemized food, a provider daily total, a taken supplement, a resolved overlap, and a conflicted day.
- [x] Assert separate itemized-food, provider-daily-total, and supplement averages plus per-source contribution rows.
- [x] Assert selected-window days with data, usable days, overlap days, conflict days, and contributing/excluded labels.
- [x] Run the focused repository and router tests and confirm the new assertions fail for the missing response fields.

### Task 2: Implement the Server Contract

- [x] Derive the breakdown from canonical nutrient and source-resolution views without adding stored totals.
- [x] Add the data-quality context to `micronutrientAdequacyV2`.
- [x] Preserve the existing adequacy and supplement-safety semantics while splitting itemized food from provider daily totals.
- [x] Re-run focused repository, router, and integration tests and confirm they pass.

### Task 3: Add Failing Web and iOS Tests

- [x] Assert both clients show selected-window completeness and overlap before nutrient interpretation.
- [x] Assert both clients show readable itemized-food, provider-daily-total, and supplement contributions.
- [x] Assert contributing and excluded sources remain visible.
- [x] Run the focused web and mobile tests and confirm they fail for the missing UI.

### Task 4: Render Dual-Platform Context

- [x] Add one focused source-context component per client.
- [x] Render only server-provided values; do not calculate totals, percentages, or source selection in client code.
- [x] Add stories for complete, partial, overlapping, loading, and empty states.
- [x] Re-run focused client tests and confirm they pass.

### Task 5: Final Verification and Delivery

- [x] Run repository lint and capture the unrelated ClickHouse-availability failure after all code and policy checks pass.
- [x] Run root, server, web, and mobile typechecks.
- [x] Run the full unit/mobile suite and focused Postgres integration suite; capture the unrelated Docker-induced Vitest RPC timeout after all tests pass.
- [x] Build web and mobile Storybook.
- [x] Review the complete diff for provider-agnostic storage, query-time source resolution, server-side computation, and web/mobile parity.
- [ ] Commit, push, open a PR with `Fixes #2136`, backlink the issue, monitor CI and review feedback, and merge only after all requirements pass.
