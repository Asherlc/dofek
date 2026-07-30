# Strength Workout Scope TDD Plan

**Goal:** Make the Strength analytics and workout list use one activity-type definition and explain the exact selected period and workout scope.

**Behavior:** Structured strength sets from strength, strength training, functional strength, and functional fitness activities contribute to Strength analytics, while the workout section lists the same types for the selected 7-day, 14-day, 30-day, 90-day, 1-year, or all-time range.

**Scope:** Add one shared strength activity-type contract, apply it to the existing server queries and web Strength route, and clarify the existing web section copy. Do not change ingestion or add a new mobile Strength route.

**Docs:** [Issue #2111](https://github.com/Asherlc/dofek/issues/2111)

---

## Current Evidence

- The deterministic seed returns 13 chart workouts and 13 list workouts in the same 180-day window, so current seeded data does not reproduce the empty list.
- `StrengthRepository` independently filters `strength` and `strength_training`.
- The web Strength route independently filters `strength`, `strength_training`, `functional_strength`, and `functional_fitness`.
- “Recent Strength Workouts” does not identify the selected range.

## Test Strategy

- Contract: prove the selected route and repository behavior use the shared strength types.
- Integration: seed structured sets under functional strength and functional fitness activities in real Postgres, then prove the Strength analytics and activity list include the same selected-window workouts.
- Web: prove the route passes the shared type contract to the activity list and renders exact dynamic period/type copy for finite and all-time ranges.
- Mobile parity: no mobile Strength analytics route exists; both clients retain access to the shared server/domain contract without adding an unrelated screen.

## File Structure

- Create: `docs/superpowers/plans/2026-07-29-strength-recent-activity.md` - record the confirmed approach and validation.
- Modify: `packages/training/src/training.ts` - define the canonical strength activity-type contract.
- Modify: `packages/server/src/repositories/strength-repository.ts` - use the shared contract in every Strength query.
- Create: `packages/server/src/repositories/strength-repository.integration.test.ts` - execute the reconciled Strength and activity-list repository behavior against Postgres.
- Modify: `packages/web/src/routes/training/strength.lazy.tsx` - use the shared contract and render exact scope copy.
- Modify: `packages/web/src/routes/training/strength.lazy.test.tsx` - cover query inputs and copy for finite/all-time ranges.
- Modify: `packages/web/src/routes/training/range-plumbing.test-helper.tsx` - expose Strength route props to its focused test.
- Modify: `packages/web/src/components/ActivityList.tsx` - allow the scoped section to supply an exact empty-state message.
- Modify: `packages/web/src/components/ActivityList.test.tsx` - cover the custom empty state.
- Modify: `packages/web/src/components/ActivityList.stories.tsx` - preserve default/loading/empty scenarios and add the scoped strength empty state.
- Modify: `packages/web/src/components/RecentActivitiesSection.tsx` - forward the scoped empty-state message.
- Modify: `packages/web/src/components/RecentActivitiesSection.test.tsx` - cover forwarding without changing query behavior.
- Modify: `packages/web/src/components/RecentActivitiesSection.stories.tsx` - preserve default/loading/empty scenarios and add the scoped strength variant.

## Tasks

### Task 1: Add Failing Contract and UI Tests

- [x] Add route expectations for the shared types, selected-range copy, and all-time copy.
- [x] Add component expectations for the scoped empty-state message.
- [x] Add scoped Storybook variants alongside the existing default, loading, and empty scenarios.
- [x] Run `pnpm vitest run packages/training/src/training.test.ts packages/web/src/routes/training/strength.lazy.test.tsx packages/web/src/components/ActivityList.test.tsx packages/web/src/components/RecentActivitiesSection.test.tsx`.
- [x] Confirm failures identify the missing shared contract and copy behavior.

### Task 2: Add the Failing Database Regression

- [x] Seed all four strength activity types with structured sets in a focused repository integration fixture.
- [x] Assert the Strength and activity-list repositories include the same selected-window variants.
- [x] Run `pnpm vitest run --project integration packages/server/src/repositories/strength-repository.integration.test.ts`.
- [x] Confirm the current two-type repository predicate excludes the functional variants.

### Task 3: Implement the Minimal Reconciliation

- [x] Add the shared contract to `@dofek/training`.
- [x] Replace repository and route-local type lists with the shared contract.
- [x] Render exact selected-period/type subtitle and empty-state copy.
- [x] Re-run the focused unit and integration commands and confirm they pass.

### Task 4: Final Verification

- [x] Run `pnpm lint:sandbox`.
- [x] Run `pnpm tsc --noEmit`.
- [x] Run `pnpm --dir packages/server exec tsc --noEmit`.
- [x] Run `pnpm --dir packages/web exec tsc --noEmit`.
- [x] Run `pnpm test`.
- [x] Run the focused Postgres integration suite.
- [x] Build the web application and web Storybook.
- [ ] Commit, push, open a PR with `Fixes #2111`, link it from the issue, and monitor all checks and review feedback through merge.
