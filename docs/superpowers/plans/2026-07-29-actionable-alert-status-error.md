# Actionable Alert Status Error TDD Plan

**Goal:** Make alert-status query failures explain their scope and offer one retry without hiding previously loaded alerts.

**Behavior:** Web and mobile distinguish an unavailable initial alert-status check from a failed refresh of cached alerts, state that synced health data remains available and the status check did not pause syncs or imports, preserve cached alerts, show the server error, and expose one `Retry alert status` action.

**Scope:** Shared alert-failure presentation, paired web/mobile rendering, focused tests, and error/stale Storybook scenarios. No server, processing pipeline, database, polling, or retry-policy changes.

**Docs:** GitHub issue #2172; `packages/providers-meta/src/processing-alerts.ts`; `packages/web/src/pages/AlertsPage.tsx`; `packages/mobile/app/alerts.tsx`.

---

## Current Evidence

- The initial web failure says only “Alerts could not be loaded. Refresh the page to try again.”
- The initial mobile failure says only “Pull down or reopen this screen to try again.”
- Neither initial failure exposes the existing query refetch action.
- TanStack Query marks cached query data stale and refetches stale queries in the background ([TanStack Query important defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults)). In the current clients, a failed refresh leaves both `data` and `error` observable, but both clients silently render the cached alert list without identifying it as potentially stale.
- `processing.alerts` is a read-only status query; its failure does not itself mutate synced data or pause sync/import processing.

## Test Strategy

- Unit: shared presentation tests distinguish missing versus retained snapshots and retain the exact server error.
- Web: page tests cover the unavailable status, retry action, retained stale alerts, and in-flight retry state.
- Mobile: screen tests cover the same observable behavior and navigation remains unchanged.
- UI/mobile/web parity: update the existing web Alerts story with unavailable/stale variants and add the corresponding mobile screen stories.

## File Structure

- Modify: `packages/providers-meta/src/processing-alerts.ts` — shared user-facing failure presentation.
- Modify: `packages/providers-meta/src/processing-alerts.test.ts` — presentation behavior.
- Modify: `packages/web/src/components/QueryStatePanel.tsx` — allow the existing error panel to use a domain-specific title, matching mobile.
- Modify: `packages/web/src/components/QueryStatePanel.test.tsx` and `.stories.tsx` — title contract.
- Modify: `packages/web/src/pages/AlertsPage.tsx` and `.test.tsx` — unavailable/stale alert status and retry.
- Modify: `packages/web/src/pages/AlertsPage.stories.tsx` — visual error variants.
- Modify: `packages/mobile/app/alerts.tsx` and `.test.tsx` — paired unavailable/stale alert status and retry.
- Create: `packages/mobile/app/alerts.stories.tsx` — paired visual error variants.

## Tasks

### Task 1: Add Failing Shared and Client Tests

**Files:**
- Modify: `packages/providers-meta/src/processing-alerts.test.ts`
- Modify: `packages/web/src/components/QueryStatePanel.test.tsx`
- Modify: `packages/web/src/pages/AlertsPage.test.tsx`
- Modify: `packages/mobile/app/alerts.test.tsx`

- [x] Write failing tests for initial unavailable status, cached stale status, server error visibility, and one retry action.
- [x] Run `rtk pnpm vitest run --project unit packages/providers-meta/src/processing-alerts.test.ts packages/web/src/components/QueryStatePanel.test.tsx packages/web/src/pages/AlertsPage.test.tsx`.
- [x] Run `rtk pnpm vitest run --project mobile packages/mobile/app/alerts.test.tsx`.
- [x] Confirm the tests fail because the current clients lack the scoped explanation and retry.

### Task 2: Implement the Minimum Shared and Paired Fix

**Files:**
- Modify: `packages/providers-meta/src/processing-alerts.ts`
- Modify: `packages/web/src/components/QueryStatePanel.tsx`
- Modify: `packages/web/src/pages/AlertsPage.tsx`
- Modify: `packages/mobile/app/alerts.tsx`

- [x] Add the shared presentation contract for unavailable versus stale alert status.
- [x] Preserve cached alerts while rendering the refresh failure above them.
- [x] Wire the existing query `refetch()` to one retry action and disable it while fetching.
- [x] Run the focused test commands and confirm they pass.

### Task 3: Add Visual Scenarios

**Files:**
- Modify: `packages/web/src/components/QueryStatePanel.stories.tsx`
- Modify: `packages/web/src/pages/AlertsPage.stories.tsx`
- Create: `packages/mobile/app/alerts.stories.tsx`

- [x] Add initial-unavailable and retained-stale-alert scenarios on both platforms.
- [x] Run `rtk pnpm --dir packages/web build-storybook`.
- [x] Run `rtk pnpm --dir packages/mobile build-storybook`.

### Task 4: Final Verification

- [x] Run `rtk pnpm lint`.
- [x] Run root, server, web, mobile, and providers package typechecks.
- [x] Run `rtk pnpm test`.
- [ ] Open a PR with `Fixes #2172`, link it from the issue, monitor CI/reviews, and merge only after every required check passes.
