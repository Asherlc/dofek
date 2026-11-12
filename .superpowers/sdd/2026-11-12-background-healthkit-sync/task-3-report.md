# Task 3 report — shared Apple Health sync ownership

**Status:** complete, verified, committed, and pushed.
**Commit:** pending commit SHA.
**Scope:** authenticated app-owned manual sync controller, shared observer gate,
  account retirement/erasure ordering, production route delegation, and focused tests.

## Production interface for Task 4

`packages/mobile/lib/health-kit-manual-sync-context.tsx`

```ts
function useHealthKitManualSync(): {
  controller: HealthKitManualSyncOwner | null;
  state: HealthKitManualSyncState;
};

type HealthKitManualSyncState = {
  status: "idle" | "running" | "paused" | "error" | "complete";
  message: string | null;
  completedStageCount: number;
  totalStageCount: number;
  error: string | null;
};
```

The authenticated root owns `HealthKitManualSyncController` and passes it through
`HealthKitManualSyncProvider`. Both provider list and detail callers already receive it
through the hook. Their `appleHealth.sync({ syncRangeDays })` call delegates to
`controller.start(syncRangeDays)` and remains `Promise<SyncResult>` compatible;
`controller.resume()` resumes the saved fixed window. The controller exposes `userId`,
`subscribe`, `getSnapshot`, `start`, `resume`, and `retire` through the context. Read
progress and status from `state`; the old `onProgress` callback is not the state source.

`AppleHealthSyncService.syncManualCheckpointed` executes a fixed-window stage attempt
without per-attempt logging. `recordManualOutcome(result, error, durationMs)` records one
terminal result; pauses are not terminal records. Task 4 can update progress and Resume
presentation without adding another sync path.

## Implementation

- Added a root-owned, account-bound controller with `useSyncExternalStore` state. It
  persists one fixed window/request ID, creates a fresh native task ID for each attempt,
  restores saved work as paused, and preserves the checkpoint across resource disposal.
- Manual and observer data attempts share one promise gate. Pause waits happen after
  releasing that gate. Observer deliveries remain pending for catch-up if a native callback
  expires or the controller is temporarily unavailable.
- Manual query/upload/stage/anchor boundaries and observer query/upload/anchor boundaries
  check account lifetime before side effects. Retired work cannot start a late checkpoint
  save or final log write.
- Retry once only for a recognized transient upload failure whose active request crossed
  into background; wait for active and connected first. HealthKit locked-data errors wait
  for foreground/unlock under the existing grant. Expiration requires a fresh Resume tap;
  unsupported native background execution pauses until foreground.
- Provider list/detail manual calls route through the authenticated controller. Expected
  interruption is surfaced as paused control flow without an error capture or per-attempt
  `recordSync` call.
- Account erasure stops/retires the matching owner and strictly deletes its checkpoint
  while the unattempted preparation still has `ownerUserId`, before confirmation strips
  that identity. Failed deletion blocks confirmation and the next tap retries deletion;
  cleanup lease ownership is checked on both sides of the await.
- Uses installed `expo-crypto` `randomUUID()` for runtime-safe task and request IDs,
  following [Expo Crypto](https://docs.expo.dev/versions/latest/sdk/crypto/#cryptorandomuuid).

## Validation

Focused mobile command:

```sh
pnpm exec vitest run --project mobile \
  packages/mobile/lib/health-kit-manual-sync.test.ts \
  packages/mobile/lib/apple-health-provider.test.ts \
  packages/mobile/lib/background-health-kit-sync.test.ts \
  packages/mobile/lib/mobile-account-purge.test.ts \
  packages/mobile/components/AccountErasurePanel.test.tsx \
  packages/mobile/app-tests/_layout.cleanup.test.tsx
```

Result: **6 files passed, 118 tests passed.** Coverage includes grant-before-query,
duplicate start, gate release during pause, restoration, expired task requiring explicit
Resume, background-crossing transport retry and fresh failure, actual locked HealthKit
pause, unsupported background execution, observer catch-up after callback expiry, root
same-account disposal and account replacement, late write rejection, and erasure deletion
failure/retry before confirmation.

- `pnpm --dir packages/mobile typecheck` — pass (`tsc --noEmit`).
- `pnpm --dir packages/mobile lint` — pass (Biome, mobile error telemetry policy, and
  Expo Router route-file check).
- `git diff --check` — pass.

Warnings in the focused test run are existing React Native web `autoCorrect` and root
cleanup `act(...)` diagnostics; tests pass.

## Review notes

No native files or Task 4 UI were changed. The lead should run the final native build and
review the integration before Task 4 consumes the interface above. The context provider
is intentionally only a context boundary; controller creation and disposal remain at the
authenticated root, avoiding a second lifecycle owner.

## Retrospective

The most useful investigation was tracing the root auth/effect lifetime together with the
erasure preparation boundary; that exposed why a checkpoint purge must be retried after
resource disposal and before identity is stripped. Splitting the React context from the
controller also kept Expo native runtime imports out of provider-hook consumers and tests.
For a similar task, use the existing Task 2 interface report and the app-root cleanup tests
before choosing ownership boundaries. No new skill appears necessary; the Paseo Progress
workflow was useful for keeping T03 review status current.

Potential documentation improvement for approval: add a short mobile sync ownership note
to the mobile README describing that authenticated root context owns manual sync and that
callers should read `useHealthKitManualSync().state` for progress. This remains a proposal;
the Task 3 brief already provides the interface for Task 4.
