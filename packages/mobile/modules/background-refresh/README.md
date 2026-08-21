# Background Refresh

An iOS-only local Expo module that bridges `BGAppRefreshTask` wake-up events
to an asynchronous JavaScript handler. Dofek uses it to restart background
device work and flush buffered data.

The CocoaPods target supports iOS 16.4 and later. It exposes the native module
as `BackgroundRefresh`; `index.ts` is the public TypeScript entry point.

## Runtime flow

1. `BackgroundRefreshAppDelegateSubscriber` registers
   `com.dofek.accelerometer-refresh` during app launch and submits a refresh
   request.
2. Every submitted request sets `earliestBeginDate` to 15 minutes in the
   future. That date is only a lower bound: iOS decides when, or whether, to
   launch the task and can delay it substantially. See Apple's
   [`earliestBeginDate` documentation](https://developer.apple.com/documentation/backgroundtasks/bgtaskrequest/earliestbegindate).
3. On a wake-up, the subscriber schedules the next request and passes a unique
   task ID through the native module's `onBackgroundRefresh` event.
4. The TypeScript listener waits for its handler to settle, then completes the
   matching native task as successful or failed. Expiration, listener removal,
   and a missing listener fail the task. The coordinator removes the stored
   completion before calling it, so racing paths can invoke the native
   completion at most once. Apple requires apps to report task completion
   before the allotted time expires; see
   [`setTaskCompleted(success:)`](https://developer.apple.com/documentation/backgroundtasks/bgtask/settaskcompleted(success:)).

## Public API

```ts
import {
  addBackgroundRefreshListener,
  isBackgroundRefreshAvailable,
  scheduleRefresh,
} from "./modules/background-refresh";

const subscription = addBackgroundRefreshListener(async () => {
  await performRequiredBackgroundWork();
});

if (isBackgroundRefreshAvailable()) {
  scheduleRefresh();
}

subscription.remove();
```

- `scheduleRefresh(): void` submits another refresh request with the 15-minute
  earliest start date.
- `isBackgroundRefreshAvailable(): boolean` reports whether UIKit currently
  considers Background App Refresh available. Apple documents the possible
  user, device-management, and power-state restrictions in
  [`backgroundRefreshStatus`](https://developer.apple.com/documentation/uikit/uiapplication/backgroundrefreshstatus).
- `addBackgroundRefreshListener(callback): EventSubscription` registers one
  asynchronous handler. Resolution completes the task successfully; rejection
  completes it unsuccessfully. Remove the returned subscription during
  teardown.

## Native configuration

The task identifier must remain listed in
[`packages/mobile/app.json`](../../app.json) under
`BGTaskSchedulerPermittedIdentifiers`, and `UIBackgroundModes` must include
`fetch`. These are requirements for `BGAppRefreshTask`; see Apple's
[background-task setup guide](https://developer.apple.com/documentation/uikit/using-background-tasks-to-update-your-app).

[`expo-module.config.json`](./expo-module.config.json) registers both the module
and its app-delegate subscriber. Expo documents this lifecycle hook in
[iOS AppDelegate subscribers](https://docs.expo.dev/modules/appdelegate-subscribers/)
and the native-to-JavaScript event bridge in the
[Expo Modules API](https://docs.expo.dev/modules/module-api/#sending-events).

## Development

Run from the repository root:

```sh
pnpm exec vitest run --project mobile packages/mobile/modules/background-refresh/index.test.ts
swift test --package-path packages/mobile/modules/background-refresh
pnpm --filter dofek-mobile typecheck
```

The TypeScript tests cover promise-to-native completion. `Package.swift`
excludes the Expo-bound files and tests only
`BackgroundRefreshTaskCoordinator`; validate changes to the full native bridge
with an iOS app build.
