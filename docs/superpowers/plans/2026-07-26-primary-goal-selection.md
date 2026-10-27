# Primary Goal Selection TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation. If executing this plan task-by-task, also use superpowers:executing-plans or superpowers:subagent-driven-development as appropriate. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a primary goal chosen during onboarding and let users change it later in settings, with web/mobile parity.

**Behavior:** New and existing users can select one of four roadmap-aligned goals (`racePreparation`, `sleepConsistency`, `strengthProgression`, `weightTrend`). The choice is stored in `fitness.user_settings` under `primaryGoal` and is readable/writable via the existing `settings` tRPC router. Onboarding and Settings on web and mobile show the same options and persist selection immediately.

**Scope:**
- Included: shared goal metadata in `@dofek/onboarding`, whitelist `primaryGoal` on `settings.set`, goal selector on web/mobile onboarding + settings, stories, tests, roadmap update.
- Non-goals: event dates, planned-work imports, merged calendars, compliance explanations, recommendation adjustments, analytics on goal.

**Docs:** Roadmap PR https://github.com/Asherlc/dofek/pull/2034 (“Next: Goals, Calendar, and Plan Compliance”); prior onboarding plan `docs/superpowers/plans/2026-05-28-get-started-onboarding.md`.

---

## Current Evidence

- Web/mobile onboarding renders `GET_STARTED_STEPS` only; no goal UI or persistence.
- `settings.set` whitelists `unitSystem`, `dashboardLayout`, `whoop.wearLocation` only.
- `fitness.user_settings` already stores arbitrary JSONB values; no migration needed.
- WHOOP wear-location and unit-system pickers are the persistence/UI patterns to copy.

## Test Strategy

- Unit (`@dofek/onboarding`): option IDs, labels, setting key, parse helper accepts valid IDs and rejects unknown/null.
- Integration (`settings` router): set/get `primaryGoal`, reject invalid values, cache invalidation.
- Web: `PrimaryGoalSelector` optimistic write/rollback/error display; onboarding and settings render options.
- Mobile: same selector behavior on onboarding and settings screens.

## File Structure

- Create: `packages/onboarding/src/primary-goal.ts` (+ `.test.ts`)
- Modify: `packages/onboarding/package.json` exports, `README.md`
- Modify: `packages/server/src/routers/settings.ts`, `settings.integration.test.ts`
- Create: `packages/web/src/components/PrimaryGoalSelector.tsx` (+ `.test.tsx`, `.stories.tsx`)
- Modify: `packages/web/src/pages/OnboardingPage.tsx` (+ test), `SettingsPage.tsx`
- Create: `packages/mobile/components/PrimaryGoalSelector.tsx` (+ `.test.tsx`, `.stories.tsx`)
- Modify: `packages/mobile/app/onboarding.tsx` (+ test), `settings.tsx` (+ test as needed)
- Modify: `docs/roadmap.md`

## Tasks

### Task 1: Shared primary-goal domain

**Files:**
- Create: `packages/onboarding/src/primary-goal.ts`
- Create: `packages/onboarding/src/primary-goal.test.ts`
- Modify: `packages/onboarding/package.json`
- Modify: `packages/onboarding/README.md`

- [x] Write failing tests for options, setting key, and `parsePrimaryGoal`.
- [x] Run `pnpm vitest run packages/onboarding/src/primary-goal.test.ts`.
- [x] Implement metadata + helpers; confirm tests pass.

### Task 2: Server settings whitelist

**Files:**
- Modify: `packages/server/src/routers/settings.ts`
- Modify: `packages/server/src/routers/settings.integration.test.ts`

- [x] Extend integration tests for valid `primaryGoal` round-trip and invalid rejection.
- [x] Run `pnpm vitest run packages/server/src/routers/settings.integration.test.ts --project integration` (or workspace equivalent).
- [x] Add `primaryGoal` to `settingInputSchema` using shared option IDs; confirm tests pass.

### Task 3: Web selector + surfaces

**Files:**
- Create: `packages/web/src/components/PrimaryGoalSelector.tsx`
- Create: `packages/web/src/components/PrimaryGoalSelector.test.tsx`
- Create: `packages/web/src/components/PrimaryGoalSelector.stories.tsx`
- Modify: `packages/web/src/pages/OnboardingPage.tsx`, `OnboardingPage.test.tsx`
- Modify: `packages/web/src/pages/SettingsPage.tsx`

- [x] Write failing selector tests (render options, optimistic set, rollback on error, read error).
- [x] Update onboarding test to expect goal options.
- [x] Implement selector and wire into onboarding + settings; add Storybook stories.
- [x] Run focused web unit tests; confirm pass.

### Task 4: Mobile parity

**Files:**
- Create: `packages/mobile/components/PrimaryGoalSelector.tsx`
- Create: `packages/mobile/components/PrimaryGoalSelector.test.tsx`
- Create: `packages/mobile/components/PrimaryGoalSelector.stories.tsx`
- Modify: `packages/mobile/app/onboarding.tsx`, `onboarding.test.tsx`
- Modify: `packages/mobile/app/settings.tsx` (+ test coverage)

- [x] Write failing mobile selector/onboarding tests.
- [x] Implement and wire into onboarding + settings.
- [x] Run focused mobile tests; confirm pass.

### Task 5: Docs and verification

**Files:**
- Modify: `docs/roadmap.md`
- Modify: `docs/superpowers/plans/2026-07-26-primary-goal-selection.md` (check off tasks)

- [x] Document shipped primary-goal selection under Near-Term Product Opportunities; explicitly defer calendar/compliance.
- [x] Run `pnpm lint`, focused unit/mobile tests, and typecheck for touched packages.
- [x] Commit, push, open PR against `main`.
