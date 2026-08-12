# Provider Freshness Implementation Plan

> **Required subskill:** Use `superpowers:executing-plans` to implement this plan task by task.

**Goal:** Stop treating a missing same-day dashboard observation as a stale provider, and expose a server-authored freshness state based only on each connected pull provider's most recent successful scheduled sync.

**Architecture:** The server will read both the latest sync attempt and the latest successful sync from `fitness.sync_log`. A small server service will compare the successful timestamp with the configured scheduler cadence plus one cadence of grace and return a render-ready status. `sync.providers` will attach that status only to connected pull providers. Web and iOS will render it directly; neither dashboard will trigger provider-wide syncs from `dashboardOverview.latestDate`. The existing iOS Dofek-food-to-HealthKit writeback remains, but is separated and explicitly named as coverage-driven rather than provider freshness.

**Tech Stack:** TypeScript, tRPC + Zod, Drizzle SQL, Vitest, React, React Native/Expo.

**Global Constraints:**

- Freshness is evaluated only on the server; clients render the API status without date comparisons.
- A successful scheduled sync is the source of freshness. A later failed attempt must not make a provider look fresh.
- The scheduler cadence has one canonical default (`SYNC_INTERVAL_MINUTES`, default 30); freshness is overdue after two cadence intervals.
- Push-only and import-only providers have no scheduled-sync freshness state.
- Preserve the existing `lastSyncedAt` attempt timestamp for compatibility; add a separately named successful timestamp for freshness and display.
- Keep current connection, authorization, manual Sync, and HealthKit ingestion semantics intact.
- Tests precede every production-code change; do not add client-side calculations or test-only production branches.

---

## File Structure

- Modify: `src/jobs/scheduled-sync.ts` — export the canonical default scheduled-sync cadence.
- Create: `packages/server/src/services/provider-sync-freshness.ts` — server-only evaluation of successful-sync timestamps.
- Create: `packages/server/src/services/provider-sync-freshness.test.ts` — unit tests for current, overdue, and unknown freshness states.
- Modify: `packages/server/src/repositories/sync-repository.ts` — query the latest successful sync per provider separately from the latest attempt.
- Modify: `packages/server/src/repositories/sync-repository.test.ts` — assert successful-sync query semantics.
- Modify: `packages/server/src/routers/sync.ts` — add successful-sync and server-authored freshness fields to `sync.providers`.
- Modify: `packages/server/src/routers/sync.test.ts` — verify pull, import, and push provider API rows.
- Modify: `packages/web/src/components/SyncProviderCard.tsx` and its colocated test — render the supplied overdue/current state without evaluating timestamps.
- Delete: `packages/web/src/hooks/useAutoSync.ts` and `packages/web/src/hooks/useAutoSync.test.ts` — remove the observation-date-driven provider-wide auto-sync behavior.
- Modify: `packages/web/src/pages/Dashboard.tsx` and affected dashboard tests — remove the deleted hook call.
- Rename/refactor: `packages/mobile/lib/useAutoSync.ts` and `packages/mobile/lib/useAutoSync.test.ts` to a HealthKit-food-writeback-specific hook and test; remove only API-provider sync/polling behavior.
- Modify: `packages/mobile/app/(tabs)/index.tsx` and its route test — call the renamed food writeback hook, not provider auto-sync.
- Modify: `packages/mobile/app/providers/provider-card.tsx`, its screen test, and typed fixtures/stories — render the server freshness status directly.

## Task 1: Make scheduler cadence reusable

**Files:**

- Modify: `src/jobs/scheduled-sync.ts`
- Modify: `src/jobs/worker.ts`
- Modify: `src/jobs/scheduled-sync.test.ts`

1. Add a failing scheduler unit test asserting the exported default cadence is 30 minutes and `setupScheduledSync()` uses it.
2. Run `pnpm vitest run src/jobs/scheduled-sync.test.ts`; confirm the new export assertion fails.
3. Export `DEFAULT_SCHEDULED_SYNC_INTERVAL_MINUTES` from `scheduled-sync.ts`; use it as `setupScheduledSync`'s default.
4. Replace the worker's duplicated `30` default with that export while preserving its environment validation and startup failure behavior.
5. Re-run `pnpm vitest run src/jobs/scheduled-sync.test.ts src/jobs/worker.test.ts`; confirm green.
6. Commit: `refactor: share scheduled sync cadence`.

## Task 2: Define and test server-owned provider freshness

**Files:**

- Create: `packages/server/src/services/provider-sync-freshness.ts`
- Create: `packages/server/src/services/provider-sync-freshness.test.ts`

1. Write failing tests for an exported `evaluateProviderSyncFreshness({ now, lastSuccessfulSyncAt, intervalMinutes })` contract:
   - no successful sync returns `{ status: "unknown", label: "Sync status unknown", ... }`;
   - a timestamp at or inside `2 * intervalMinutes` returns `{ status: "current", label: "Sync current", ... }`;
   - a timestamp beyond that boundary returns `{ status: "overdue", label: "Sync overdue", ... }`;
   - exactly on the boundary remains current, avoiding a premature overdue state.
2. Run `pnpm vitest run packages/server/src/services/provider-sync-freshness.test.ts`; confirm it fails because the service is absent.
3. Implement the service with a discriminated `ProviderSyncFreshness` type containing server-authored `status`, `label`, and `description`. Derive the overdue boundary from the supplied cadence plus one cadence grace; do not import client formatting utilities.
4. Run the focused service test and confirm green.
5. Commit: `feat: evaluate provider sync freshness on server`.

## Task 3: Query successful syncs independently of attempts

**Files:**

- Modify: `packages/server/src/repositories/sync-repository.ts`
- Modify: `packages/server/src/repositories/sync-repository.test.ts`

1. Add a failing repository test for `getLastSuccessfulSyncTimes()` that checks its SQL limits rows to `status = 'success'` and maps provider IDs/timestamps using the existing `LastSync` domain shape.
2. Run `pnpm vitest run packages/server/src/repositories/sync-repository.test.ts`; confirm the test fails because the method is absent.
3. Add `getLastSuccessfulSyncTimes()` using `MAX(synced_at)` grouped by provider and filtered to successful records. Leave `getLastSyncTimes()` unchanged so `lastSyncedAt` continues to represent the latest attempt.
4. Re-run the repository unit test; confirm both latest-attempt and latest-successful queries pass.
5. Commit: `feat: query last successful provider syncs`.

## Task 4: Extend `sync.providers` with freshness data

**Files:**

- Modify: `packages/server/src/routers/sync.ts`
- Modify: `packages/server/src/routers/sync.test.ts`

1. Add failing router tests covering the `sync.providers` response for:
   - a connected pull provider with a recent successful sync (`syncFreshness.status === "current"`);
   - a connected pull provider whose success is beyond the grace boundary (`"overdue"`);
   - a connected pull provider with no success (`"unknown"`);
   - disconnected, import-only, and push-only providers returning `syncFreshness: null`.
   Also assert `lastSyncedAt` remains the latest attempt while `lastSuccessfulSyncAt` is the success timestamp.
2. Run `pnpm vitest run packages/server/src/routers/sync.test.ts`; confirm the response-schema assertions fail.
3. Extend `syncProviderRowOutputSchema` with nullable `lastSuccessfulSyncAt` and nullable `syncFreshness` object fields.
4. Fetch successful-sync rows in the existing batch, build a successful-sync map, and call the server freshness service only for connected providers that are neither import-only nor push-only. Use the canonical scheduler default; use the request-time server clock.
5. Preserve the current auth-error calculation and the complete current row shape for all other fields.
6. Re-run the focused router test, then `pnpm typecheck`; confirm green.
7. Commit: `feat: expose provider sync freshness`.

## Task 5: Render API freshness on the web and remove false auto-sync

**Files:**

- Modify: `packages/web/src/components/SyncProviderCard.tsx`
- Modify: `packages/web/src/components/SyncProviderCard.test.tsx`
- Modify: `packages/web/src/components/SyncProviderCard.stories.tsx`
- Delete: `packages/web/src/hooks/useAutoSync.ts`
- Delete: `packages/web/src/hooks/useAutoSync.test.ts`
- Modify: `packages/web/src/pages/Dashboard.tsx`
- Modify: affected `packages/web/src/pages/Dashboard*.test.tsx`

1. Add failing card tests that pass server response data and expect an overdue treatment and the server-provided label/description. Include a current state assertion that does not produce an alert. Do not create a test that merely asserts `useAutoSync` is absent.
2. Run the focused card test; confirm the freshness props/text are not yet supported.
3. Extend the card's typed provider pick with `lastSuccessfulSyncAt` and `syncFreshness`. Render the supplied status and description for connected pull providers, with the overdue state visually actionable next to the existing manual Sync control. Do not compare dates in the component.
4. Update stories to supply the new response fields; rename the old story-only “Stale Provider” scenario to the actual server state it represents.
5. Remove the `useAutoSync` dashboard import and call. Delete the now-unreferenced hook and its tests rather than retaining a dead feature.
6. Update dashboard test setup only as needed for the removed hook; keep dashboard query refresh behavior unchanged.
7. Run `pnpm vitest run packages/web/src/components/SyncProviderCard.test.tsx <affected-dashboard-tests>` and `pnpm typecheck`; confirm green.
8. Commit: `fix: stop dashboard observation auto-sync on web`.

## Task 6: Preserve iOS food writeback while removing provider auto-sync

**Files:**

- Rename: `packages/mobile/lib/useAutoSync.ts` → `packages/mobile/lib/useHealthKitFoodWriteback.ts`
- Rename: `packages/mobile/lib/useAutoSync.test.ts` → `packages/mobile/lib/useHealthKitFoodWriteback.test.ts`
- Modify: `packages/mobile/app/(tabs)/index.tsx`
- Modify: `packages/mobile/app-tests/(tabs)/index.test.tsx` (or the actual colocated route-test path)

1. Write failing tests for the renamed hook that retain the Dofek-food writeback behavior when dashboard coverage is before today, and explicitly verify no `sync.triggerSync`, `activeSyncs`, or sync-status polling is used.
2. Run the focused mobile hook test; confirm it fails because the renamed hook does not exist.
3. Move the HealthKit authorization/writeback portion into `useHealthKitFoodWriteback`. Keep the coverage-date condition solely to decide the food writeback range; rename the helper and telemetry source away from “auto-sync” so it cannot be interpreted as provider health.
4. Remove all provider trigger, active-sync query, polling, cache-invalidation, and provider-error paths from that hook. Continue reporting unexpected HealthKit errors to Sentry.
5. Update the Today route to call `useHealthKitFoodWriteback(dashboardData?.latestDate)`.
6. Run the focused mobile hook and Today route tests, then the mobile typecheck/test tier; confirm green.
7. Commit: `fix: separate iOS food writeback from provider sync`.

## Task 7: Render API freshness on iOS

**Files:**

- Modify: `packages/mobile/app/providers/provider-card.tsx`
- Modify: `packages/mobile/app-tests/providers/index.test.tsx`
- Modify: `packages/mobile/app-stories/providers/*` and other typed provider fixtures found by TypeScript

1. Add a failing provider-screen test that supplies `syncFreshness` from the API and expects the overdue label/description; assert a current state is rendered as normal status. Do not calculate expected status from timestamps in the test.
2. Run `pnpm vitest run packages/mobile/app-tests/providers/index.test.tsx`; confirm it fails before the card consumes the new fields.
3. Extend the local provider response type and card props with nullable `lastSuccessfulSyncAt` and nullable server freshness object fields.
4. Render the server-authored label/description for connected pull providers and retain the existing Connected/Expired/Not connected and manual Sync flows.
5. Update stories/fixtures to satisfy the new type. No test files may be added under `packages/mobile/app/`.
6. Re-run the provider-screen test and mobile typecheck; confirm green.
7. Commit: `feat: show provider freshness on ios`.

## Task 8: Full verification and delivery

**Files:**

- Modify only files required by fixes uncovered during verification.

1. Run `pnpm lint`, `pnpm typecheck`, and `pnpm test:changed` (or the repository-prescribed equivalent that includes all changed unit/mobile tests).
2. If a test fails, reproduce it in its focused command, make the smallest root-cause correction, and re-run the failing focused test before the full tier.
3. Inspect `git diff --check`, `git status --short`, and the final diff. Confirm the pre-existing untracked `paseo.json` is neither staged nor committed.
4. Commit the final verified changes if verification required edits, then push every new commit to the configured remote.
5. Report the root cause, behavior change, successful validation commands, and the fact that provider freshness now reflects successful syncs rather than health-data coverage.

## Review Checklist

- [ ] No web or iOS code compares `latestDate` with today to determine provider freshness or start provider sync.
- [ ] The server alone derives freshness from a successful `fitness.sync_log` record and canonical cadence.
- [ ] A failed latest attempt cannot mark a provider current.
- [ ] Push-only, import-only, and disconnected providers receive no scheduled freshness state.
- [ ] Web and iOS render the same server-authored status, label, and description.
- [ ] Existing manual Sync, authorization, and HealthKit food writeback remain functional.
- [ ] Tests were red before implementation and green afterward; unrelated `paseo.json` is preserved.
