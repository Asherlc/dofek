# Background Refresh

An iOS-only local Expo module that bridges `BGAppRefreshTask` wake-up events
to an asynchronous JavaScript handler. Dofek uses it to restart background
device work and flush buffered data. The app-delegate subscriber also owns
the app's native data-collection notifications.

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

## Data-collection notifications

`enableCollectionNotifications(requestPermission: boolean): Promise<boolean>`
enables native alerts using existing authorization, including after an
authenticated background launch. Passing `true` allows requesting alert and
sound permission while the app is active. It returns `false` when permission
is denied or a background launch still needs authorization. The app checks permission again
when returning to the foreground. `disableCollectionNotifications(): void`
disables both alerts and removes their pending and delivered notifications
when the session ends. Notification permission uses Apple's
[User Notifications authorization API](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications).
Authentication restoration and deferred service startup preserve native alerts;
only a confirmed session end or account cleanup disables them. A denied foreground
authorization check explains how to enable notifications in iOS Settings.

The two notifications have separate triggers, identifiers, messages, and
cancellation rules:

| Notification | Trigger | Cancellation |
| --- | --- | --- |
| WHOOP disconnected | A native unexpected disconnect after a successful WHOOP connection; a five-minute grace period allows automatic reconnection. | Reconnection, intentional disconnect, or session end. |
| Dofek closed | The native `applicationWillTerminate` callback schedules a general collection warning for delivery one second later when a native collector is active, independently of WHOOP. | The next launch/foreground or session end. |

WHOOP's connection manager publishes the internal Foundation event
`WhoopBle.connectionStateChanged` with `state` values `connected`,
`disconnected`, and `intentionallyDisconnected`. The subscriber listens
natively so alert delivery does not depend on JavaScript receiving an event.
The [WHOOP connection manager](../whoop-ble/ios/WhoopBleConnectionManager.swift)
and [notification service](ios/CollectionNotificationService.swift) define
this contract; the standalone WHOOP client has no dependency on Dofek's
notification service.

At termination, `NativeCollectionActivity` synchronously queries native collectors
through `Dofek.collectionActivityRequested`. WHOOP and other heart-rate monitors
answer from confirmed subscription readiness. Phone motion answers from its
authorized, unexpired recording window; Watch motion uses the Watch's latest
confirmed recording window, delivered through
[`WCSession.receivedApplicationContext`](https://developer.apple.com/documentation/watchconnectivity/wcsession/receivedapplicationcontext).
Pairing, authentication, and an old recording-start marker alone do not count.
Recording windows expire at Apple's maximum
[`CMSensorRecorder` duration](https://developer.apple.com/documentation/coremotion/cmsensorrecorder/recordaccelerometer(forduration:)).

Each scheduled request has its own identifier under its alert's logical prefix.
Late save callbacks remove only their own obsolete request, preserving a newer
disconnect's five-minute grace period. Cancellation also enumerates prior-process
requests through Apple's [pending-notification API](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/getpendingnotificationrequests(completionhandler:)).

The closure warning is **best effort**. iOS can terminate a suspended app
without calling `applicationWillTerminate`, and scheduling a notification is
asynchronous. It therefore cannot warn about every force-quit, crash, or system
termination. Moving to the background, suspension, and missing sensor samples
are not treated as app closure. See Apple's
[termination callback documentation](https://developer.apple.com/documentation/uikit/uiapplicationdelegate/applicationwillterminate(_:))
and [local notification delivery guidance](https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app).
Both alerts require notification permission; iOS controls their final delivery.

`CollectionNotificationCoordinatorTests` exercises active collection, trigger separation,
reconnection, deliberate disconnect, independent cancellation, and disabled
sessions. `CollectionNotificationServiceTests` controls settings, authorization,
notification-save, and persisted-request callbacks to cover sign-out and reconnection
races. The Apple delivery adapter and Expo callbacks additionally require an iOS
build. Validate real BLE loss, permission changes, reconnect-before-delivery,
and app termination on a physical iPhone; the
[iOS Simulator does not provide Bluetooth hardware](https://docs.expo.dev/workflow/ios-simulator/#limitations).

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
excludes the Expo-bound files and tests the background-task coordinator, native
activity query, and complete notification service. Validate the Apple delivery adapter and full native bridge with an
iOS app build.
