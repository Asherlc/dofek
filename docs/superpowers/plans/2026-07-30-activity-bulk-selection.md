# Activity Bulk Selection TDD Plan

**Goal:** Make activity-selection controls explain their actual bulk action and announce the current selection count on web and mobile.

**Behavior:** Every activity-selection entry point says “Select activities,” delete-only surfaces explain that selected activities can be deleted, the web hidden-activity state also explains restoration, and count changes are exposed as accessible live status updates.

**Scope:** Update the existing web Activities page, reusable web `ActivityList`, and mobile Activities screen without adding bulk actions, changing mutations, or introducing another selection state model.

**Docs:** [Issue #2122](https://github.com/Asherlc/dofek/issues/2122)

---

## Current Evidence

- `packages/web/src/pages/ActivitiesPage.tsx` renders a visible “Select” label and passive `{count} selected` text; it can delete visible selections and restore hidden selections.
- `packages/web/src/components/ActivityList.tsx` renders the same ambiguous label and passive count; it is consumed by recent and training activity lists and can bulk-delete.
- `packages/mobile/app/(tabs)/activities.tsx` has an accessible name of “Select activities” but still renders the ambiguous visible label “Select,” with a passive selection count; it can bulk-delete.
- The live issue audit and bounded strategy are recorded in [the issue comment](https://github.com/Asherlc/dofek/issues/2122#issuecomment-5127778421).

## Test Strategy

- Unit: render each selection controller, verify the explicit entry label and reachable-action guidance, enter selection mode, select an activity, and verify a grammatically correct accessible count status.
- Integration: not required because existing mutations and API behavior do not change.
- UI/mobile/web parity: cover both web controllers and the mobile screen; add selection-mode Storybook stories for the reusable web list and mobile Activities screen.

## File Structure

- Modify: `packages/web/src/pages/ActivitiesPage.test.tsx` - test the page-level selection guidance and status.
- Modify: `packages/web/src/pages/ActivitiesPage.tsx` - clarify delete/restore selection and add live count semantics.
- Modify: `packages/web/src/components/ActivityList.test.tsx` - test reusable list guidance and status.
- Modify: `packages/web/src/components/ActivityList.tsx` - clarify delete selection and add live count semantics.
- Modify: `packages/web/src/components/ActivityList.stories.tsx` - show the clarified selection mode.
- Modify: `packages/mobile/app/(tabs)/activities.test.tsx` - test mobile guidance and live count properties.
- Modify: `packages/mobile/app/(tabs)/activities.tsx` - clarify delete selection and expose a polite live count.
- Modify: `packages/mobile/app/(tabs)/activities.stories.tsx` - show the clarified mobile selection mode.

## Tasks

### Task 1: Add Failing Tests

**Files:**
- Modify: `packages/web/src/pages/ActivitiesPage.test.tsx`
- Modify: `packages/web/src/components/ActivityList.test.tsx`
- Modify: `packages/mobile/app/(tabs)/activities.test.tsx`

- [x] Write failing tests for explicit “Select activities” labels and reachable-action guidance.
- [x] Write failing tests for singular/plural accessible count status behavior.
- [x] Run the focused web tests (`rtk` was unavailable, so the equivalent direct `pnpm exec vitest` command was used).
- [x] Run the focused mobile tests (`rtk` was unavailable, so the equivalent direct `pnpm exec vitest` command was used).
- [x] Confirm the tests fail because the labels, guidance, and live semantics are absent.

### Task 2: Implement Minimal Fix

**Files:**
- Modify: `packages/web/src/pages/ActivitiesPage.tsx`
- Modify: `packages/web/src/components/ActivityList.tsx`
- Modify: `packages/mobile/app/(tabs)/activities.tsx`

- [x] Rename every visible selection entry point to “Select activities.”
- [x] Add visible guidance that names only each surface's existing reachable action.
- [x] Add polite, atomic web count statuses and a polite mobile live region with singular/plural count text.
- [x] Run the focused web tests.
- [x] Run the focused mobile tests.
- [x] Confirm the focused tests pass.

### Task 3: Add Paired Stories

**Files:**
- Modify: `packages/web/src/components/ActivityList.stories.tsx`
- Modify: `packages/mobile/app/(tabs)/activities.stories.tsx`

- [x] Add web and mobile selection-mode stories that enter the real existing interaction.
- [x] Run the web typecheck.
- [x] Run the mobile typecheck.

### Task 4: Final Verification

- [x] Run lint (with this workspace's ClickHouse URL because the default local port was not assigned).
- [x] Run the root TypeScript check.
- [x] Run the server TypeScript check.
- [x] Run the web TypeScript check.
- [x] Run `pnpm test`.
- [x] Review the diff against `origin/main` for scope, web/mobile parity, and story coverage.
- [ ] Commit, push, open the linked PR with `Fixes #2122`, and carry review/CI through merge.
