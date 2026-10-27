# Remove calorie-expenditure examples TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation. If executing this plan task-by-task, also use superpowers:executing-plans or superpowers:subagent-driven-development as appropriate. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove provider-estimated workout calories and active-energy values from marketing, Storybook fixtures, review/test fixtures, and the affected App Store activity screenshot, with web/mobile parity.

**Behavior:** User-visible examples show observational metrics (for example Respiratory Rate) and Training Stress Score only. Nutrition intake and weight-inferred energy concepts remain unchanged.

**Scope:**
- Included: landing-page health monitor preview, web/mobile activity Storybook and test fixtures, DashboardEvidenceOverview story mock, App Store `04-activities-map.png`, roadmap checkbox for this item.
- Non-goals: regenerating every App Store screenshot asset, subscription pricing copy, product analytics events, medication-dose docs, Xcode workspace docs, correlation statistics audit.

**Docs:** [`docs/roadmap.md`](../../roadmap.md) Trust and Measurement release gate; AGENTS.md “Never use provider-estimated calorie expenditure”; server `formatActivityStats` already returns Training Stress Score only.

---

## Current Evidence

- Production activity cards already serve Training Stress Score only (`packages/server/src/repositories/activities-calendar-repository.ts` `formatActivityStats`).
- Landing page still markets Active Energy as `407 kcal` (`packages/web/src/pages/LandingPage.tsx`).
- Web ActivityCardContent stories and mobile activities Storybook still include workout calorie stats (`380 kcal` / `109 kcal` / `612 kcal`).
- App Store screenshot `04-activities-map.png` shows Strength session Calories `380 kcal`.
- Nutrition intake kcal and Adaptive TDEE remain valid and must be preserved.

## Test Strategy

- Unit: landing-page test expects Respiratory Rate instead of active-energy kcal.
- UI/mobile/web parity: activity fixtures on both platforms match server stats (TSS only).
- Visual: regenerate and inspect `04-activities-map.png` so Strength shows TSS without Calories.

## File Structure

- Modify: `packages/web/src/pages/LandingPage.test.tsx` — failing test first
- Modify: `packages/web/src/pages/LandingPage.tsx` — replace Active Energy
- Modify: `packages/web/src/components/DashboardEvidenceOverview.stories.tsx`
- Modify: `packages/web/src/components/ActivityCardContent.stories.tsx`
- Modify: `packages/web/src/components/ActivityCardContent.test.tsx`
- Modify: `packages/web/src/pages/ActivitiesPage.test.tsx`
- Modify: `packages/mobile/app/(tabs)/activities.stories.tsx`
- Modify: `packages/mobile/app/(tabs)/activities.test.tsx`
- Modify: `packages/server/src/routers/calendar.test.ts` — drop stale Calories fixture stats
- Modify: `packages/mobile/app-store/screenshots/04-activities-map.png` (+ manifest if rewritten)
- Modify: `docs/roadmap.md` — check off this gate item when done

## Tasks

### Task 1: Add Failing Landing-Page Test

**Files:**
- Modify: `packages/web/src/pages/LandingPage.test.tsx`

- [x] Change the unit-formatting test to expect Respiratory Rate `14 breaths/min` instead of `407 kcal`.
- [x] Run `pnpm exec vitest run packages/web/src/pages/LandingPage.test.tsx`.
- [x] Confirm the test fails because Active Energy is still rendered.

### Task 2: Replace Landing-Page Active Energy

**Files:**
- Modify: `packages/web/src/pages/LandingPage.tsx`

- [x] Replace Active Energy with Respiratory Rate `14 breaths/min`.
- [x] Drop unused `formatCaloriesMeasurement` import if no longer referenced.
- [x] Re-run the landing-page test and confirm it passes.

### Task 3: Align Web/Mobile Activity Fixtures

**Files:**
- Modify web ActivityCardContent stories/tests and ActivitiesPage test fixtures
- Modify mobile activities stories/tests
- Modify calendar router test mocks that still include Calories stats
- Modify DashboardEvidenceOverview story health-monitor mock

- [x] Remove workout Calories stats and leftover `calories` activity fields from fixtures.
- [x] Keep Training Stress Score as the activity example metric.
- [x] Replace Active Energy in DashboardEvidenceOverview story with Respiratory Rate.
- [x] Run focused web and mobile activity tests.

### Task 4: Regenerate Activity App Store Screenshot

**Files:**
- Modify: `packages/mobile/app-store/screenshots/04-activities-map.png`

- [x] Run `pnpm --filter dofek-mobile app-store:assets` (or build + screenshots).
- [x] Visually verify Strength session no longer shows `380 kcal`.
- [x] Re-audit user-visible examples for expenditure kcal while preserving nutrition/TDEE.
- [x] Align `@storybook/react-native-web-vite` to `10.4.0` so screenshot capture can render.
- [x] Seed ready `processing.status` in activities Storybook so App Store capture has no fetch-error banner.

### Task 5: Docs, Checks, Ship

- [x] Check off the roadmap calorie-expenditure examples item.
- [ ] Run `pnpm lint`, focused unit/mobile tests, and package typechecks.
- [ ] Commit, push, open PR against `main`, monitor CI and review feedback.
