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
import { createBackgroundRefreshDiagnostics } from "../../lib/background-refresh-diagnostics";
import {
  addBackgroundRefreshListener,
  isBackgroundRefreshAvailable,
  scheduleRefresh,
} from "./modules/background-refresh";

const diagnostics = createBackgroundRefreshDiagnostics();
const subscription = addBackgroundRefreshListener(async () => {
  await performRequiredBackgroundWork();
}, diagnostics.report);

if (isBackgroundRefreshAvailable()) {
  scheduleRefresh();
}

diagnostics.remove();
subscription.remove();
```

- `scheduleRefresh(): void` submits another refresh request with the 15-minute
  earliest start date.
- `isBackgroundRefreshAvailable(): boolean` reports whether UIKit currently
  considers Background App Refresh available. Apple documents the possible
  user, device-management, and power-state restrictions in
  [`backgroundRefreshStatus`](https://developer.apple.com/documentation/uikit/uiapplication/backgroundrefreshstatus).
- `addBackgroundRefreshListener(callback, reportDiagnostics): EventSubscription` registers one
  asynchronous handler. Resolution completes the task successfully; rejection
  completes it unsuccessfully. Remove the returned subscription during
  teardown.

## Apple Health continued processing

The same native module owns one user-started Apple Health sync lifetime on iOS
26 and later. It uses
[`BGContinuedProcessingTask`](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask),
which starts in the foreground in response to a person's Sync/Resume tap and can
continue while the app is backgrounded. The periodic accelerometer refresh task
is independent and keeps its own identifier.

```ts
import {
  addHealthKitSyncExpirationListener,
  completeHealthKitSync,
  startHealthKitSync,
  updateHealthKitSyncProgress,
} from "./modules/background-refresh";

const expiration = addHealthKitSyncExpirationListener(({ taskId }) => {
  // pause and wait for an explicit Resume tap; do not restart automatically
});
const { supported } = await startHealthKitSync(taskId);
if (supported) {
  updateHealthKitSyncProgress(taskId, completedStages, totalStages, "Uploading workouts");
  completeHealthKitSync(taskId, true);
}
expiration.remove();
```

- `startHealthKitSync(taskId)`: Promise. It resolves `{ supported: true }` only
  after the native launch handler grants the task, and `{ supported: false }` on
  iOS versions without continued processing (nothing is submitted). Invalid task
  IDs, registration failures, submission failures, and abandoned starts reject
  with a specific message; calling it with no expiration listener installed
  rejects immediately with the listener-unavailable message. Submission uses the
  `.fail` strategy so a second job is never queued behind work JavaScript
  already began.
- Listener ownership is captured **before the first asynchronous dispatch.** Expo
  queues an `AsyncFunction` body, so a body that read the live generation would
  bind an invocation to a listener that replaced it while the body was queued.
  The public wrapper therefore snapshots the live generation synchronously with
  the internal `getHealthKitSyncListenerGeneration()` native function and passes
  it as the native start's second argument; the native side validates exactly
  that generation and never re-reads the current one. Apple/Expo's threading and
  queue behavior is documented in
  [`AsyncFunction`](https://docs.expo.dev/modules/module-api/#asyncfunction).
- **Caller precondition: pass a fresh native `taskId` for every attempt.** The
  native `taskId` identifies one bounded continued-processing attempt, not a
  durable sync checkpoint. Keep the durable checkpoint/`requestId` used for
  resuming work separate, and generate a new native `taskId` (for example a new
  UUID) each time a person taps Sync or Resume. The coordinator records each
  submitted native ID for the process lifetime and rejects a repeat with
  "was already submitted. Use a fresh task ID for each attempt." Apple's
  registration rule is the reason the ID is single-use: an identifier may be
  registered only once per process, and a duplicate
  `BGTaskScheduler.register` terminates the app (see the wildcard and
  registration links below).
- Each request submits the exact identifier
  `com.dofek.app.healthkit-sync.<taskId>`, covered by the permitted wildcard
  `com.dofek.app.healthkit-sync.*`. The exact identifier is registered once in
  the foreground immediately before submission; the recorded registration is
  only there so the launch handler can be recognized when the system later
  launches that same request, never to rescue a retried ID. Apple exempts
  `BGContinuedProcessingTask` registrations from the launch-time registration
  rule and warns that a second registration of the same identifier kills the
  app, so a rejected or expired attempt must resume under a new `taskId`. Apple
  documents the wildcard identifier form in the
  [`BGContinuedProcessingTaskRequest` initializer](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtaskrequest/init(identifier:title:subtitle:)),
  registration in
  [`BGTaskScheduler.register(forTaskWithIdentifier:using:launchHandler:)`](https://developer.apple.com/documentation/backgroundtasks/bgtaskscheduler/register(fortaskwithidentifier:using:launchhandler:)),
  and the foreground submission constraint in
  [`BGTaskScheduler.submit(_:)`](https://developer.apple.com/documentation/backgroundtasks/bgtaskscheduler/submit(_:)).
- `updateHealthKitSyncProgress(taskId, completed, total, message)`: reports
  completed semantic stages to the system `Progress` and uses `message` as the
  Live Activity subtitle. Values are clamped, and updates for a different or
  already-completed task are ignored.
- `completeHealthKitSync(taskId, success)`: completes the native task at most
  once. Duplicate and late completions are ignored.
- `addHealthKitSyncExpirationListener(callback)`: subscribes to
  `onHealthKitSyncExpired` with the correlated `taskId`. Apple invokes the same
  expiration callback for system expiration and a person's cancellation, so the
  app pauses and requires an explicit Resume tap instead of restarting work.
  The live subscription is also the **expiration-listener owner** of native
  work, and every listener activation gets its own ownership generation — even
  when the same native module is reused after a sign-out/sign-in, which removes
  and re-adds the subscription without recreating the module. A queued
  `startHealthKitSync` retains the generation that scheduled it, so removing
  the subscription (or destroying the native module) rejects that pending start
  even when a replacement listener already exists, and submits nothing. An
  active task owned by a retired listener completes unsuccessfully once.
  Callback errors go to the mobile Sentry path.
- Native work requires a live owner. Calling `startHealthKitSync` before the
  expiration subscription is installed rejects with the listener-unavailable
  message rather than submitting work nobody can observe.

[`HealthKitSyncTaskCoordinator`](ios/HealthKitSyncTaskCoordinator.swift) owns the
Foundation-testable state machine; the thin
[`HealthKitContinuedProcessingAdapter`](ios/HealthKitContinuedProcessingAdapter.swift)
wraps the iOS 26 scheduler and task. Grant installation and start settlement are
serialized against retirement, so a teardown or expiration that wins during
launch setup rejects the start and leaves no expiration handler on the grant. A
late launch for an abandoned request completes its own task unsuccessfully and
cannot touch a newer request. The module's `OnDestroy` hook runs the same
owner-correlated cleanup as subscription removal, so native pending/active
ownership cannot outlive the JavaScript module.

## Native refresh diagnostics

[`BackgroundRefreshDiagnostics`](ios/BackgroundRefreshDiagnostics.swift) retains
64 lifecycle events plus `overflowCount` in UserDefaults. Reads do not consume
history; events keep the same IDs and occurrence times across journal recreation.
Persistence is metadata only: no samples, account identifiers, tokens, or credentials.
UserDefaults writes to disk asynchronously, so the final event is not guaranteed
to survive abrupt process termination ([Apple UserDefaults](https://developer.apple.com/documentation/foundation/userdefaults)).

Public bridge functions, exported through `index.ts`:

- `getDiagnostics(): { events, overflowCount }` returns a snapshot.
- `recordRefreshReceived(taskId): void` records JavaScript receipt; the listener
  invokes this before starting its handler.
- `clearDiagnostics(): void` erases retained events and resets overflow; account
  erasure invokes it under the existing cleanup-ownership lease.

Every event has `eventId`, ISO UTC `occurredAt`, `nativeSessionId`, `processId`,
and `event`. Optional fields are `taskId`, `taskIdentifier`, `earliestBeginAt`,
`success`, `reason`, `backgroundRefreshStatus`, `lowPowerModeEnabled`,
`errorDomain`, `errorCode`, and `errorDescription`. Task IDs are canonicalized as UUIDs before storage; the reporter validates UUIDs and timestamps before logging. Registration and schedule
boundaries capture UIKit availability and Low Power Mode. The emitted names are:

| Event | Meaning |
| --- | --- |
| `registration_result` | Native scheduler registration result. |
| `schedule_requested`, `schedule_succeeded`, `schedule_failed` | Submission attempt and result, with the requested earliest date and structured OS error on failure. |
| `task_launched` | A native refresh reached the task coordinator, including when no JavaScript listener exists. |
| `listener_changed` | Listener became `available` or `unavailable` in `reason`. |
| `bridge_dispatched`, `js_received` | Native event dispatch and confirmed JavaScript receipt. |
| `completion_requested` | JavaScript requested success/failure; `no_pending_task` identifies an ignored late/duplicate completion. |
| `task_completed` | The coordinator consumed its one native completion, with `javascript_success`, `javascript_failure`, `missing_listener`, `listener_removed`, or `expired`. |
| `task_expired` | iOS expiration callback, including an ignored callback after completion (`no_pending_task`). |

`nativeOccurredAt` is the diagnostic call's time. The
[coordinator](ios/BackgroundRefreshTaskCoordinator.swift) records outside its state
lock, so concurrent transitions can appear out of decision order. Correlate task
IDs and completion reasons rather than treating timestamp order as strict causality.

The app's authenticated service lifetime owns
[`createBackgroundRefreshDiagnostics`](../../lib/background-refresh-diagnostics.ts).
It validates the snapshot, strips unknown fields, and replays events at initial
setup, foreground activation, handler receipt, and handler settlement. Its
retained-ID set is bounded by the journal's 64-event window. Removing the reporter
removes its [AppState subscription](https://reactnative.dev/docs/appstate) and
retires late reporting. The listener preserves handler success/failure even when
diagnostic reporting fails; unexpected bridge errors go to the existing mobile
Sentry path, while scheduler failures use the native RNSentry SDK.

Logs use category `background-refresh`, `event=native_background_refresh_event`,
`nativeEvent`, `nativeOccurredAt`, `diagnosticAccountProvenance=unknown`, and
`historyOverflowCount`. Existing telemetry supplies authenticated and build/runtime
context. A logged-in user at replay time does not establish ownership of retained
native events. See the [WHOOP diagnostic runbook](../../../../docs/whoop-ble-protocol.md#native-background-refresh-evidence)
for Axiom queries and interpretation.

These native APIs require a new app binary. The existing fingerprint runtime
policy derives compatibility from native changes; do not publish this JavaScript
to an older native runtime or replace the policy with a manual runtime version
([Expo runtime compatibility](https://docs.expo.dev/eas-update/runtime-versions/)).
The diagnostic path preserves the existing earliest date, upload triggers,
completion and expiration policy, retries, and timeouts. In particular, a
cold-start task with no listener still fails immediately, and expiration still
completes native work without cancelling JavaScript work. These events expose
those existing boundaries for investigation.

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

The disconnect alert asks users to check device proximity and Bluetooth. It does
not infer that foregrounding the app will restore a lost connection; Core
Bluetooth supports connecting to peripherals in the background ([Apple's
background-processing guide](https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/CoreBluetoothBackgroundProcessingForIOSApps/PerformingTasksWhileYourAppIsInTheBackground.html)).
The instruction to reopen Dofek belongs to the separate app-closed warning,
triggered by the [termination callback](https://developer.apple.com/documentation/uikit/uiapplicationdelegate/applicationwillterminate(_:)).

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
The Apple Health continued-processing
[wildcard pattern](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtaskrequest/init(identifier:title:subtitle:))
`com.dofek.app.healthkit-sync.*` is listed alongside the periodic refresh
identifier. Each submitted request appends its task ID to that pattern.

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

The TypeScript tests cover promise-to-native completion, receipt/settlement diagnostics, replay validation/deduplication, cleanup ownership, and Apple Health start/progress/completion/expiration correlation. `Package.swift`
excludes the Expo-bound files and scheduler/continued-processing adapters and tests the background-task coordinator, Apple Health task coordinator, native
activity query, and complete notification service. Validate the Apple delivery adapter and full native bridge with an
iOS app build.
