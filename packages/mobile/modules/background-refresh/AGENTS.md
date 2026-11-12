# Background Refresh Agent Guidelines

Read the [README.md](./README.md) first for the runtime contract, public API,
native configuration, and authoritative platform references.

## Ownership

- Keep launch-time registration and native task rescheduling in
  `BackgroundRefreshAppDelegateSubscriber.swift`.
- Keep event bridging and exported native functions in
  `BackgroundRefreshModule.swift`; keep `index.ts` as the only TypeScript entry
  point. Expose the Apple Health start/progress/completion/expiration surface from
  that same entry point; do not create a second module or task scheduler.
- Keep task lifecycle state in `BackgroundRefreshTaskCoordinator.swift` and
  `HealthKitSyncTaskCoordinator.swift`. Expiration, JavaScript completion, and
  listener teardown may race, but each stored native completion may run at most
  once. Apple Health work starts only after the native launch handler grants it.
- Own native Apple Health work through an explicit expiration-listener owner.
  `OnStartObserving`/`OnStopObserving` activate and retire that owner; `OnDestroy`
  must run the same owner-correlated cleanup. A start queued to the main queue
  carries the owner that scheduled it and rejects if that owner is no longer the
  live listener, even when a replacement listener exists. Grant installation and
  start settlement are serialized against retirement so a teardown or expiration
  that wins during launch setup rejects the start and retains no handler. Expo
  documents the module lifecycle hooks in
  [Module lifecycle](https://docs.expo.dev/modules/module-api/#lifecycle-events);
  Apple documents the single expiration callback in
  [`BGContinuedProcessingTask`](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask).
- Keep the iOS 26 `BGTaskScheduler`/`BGContinuedProcessingTask` calls in
  `HealthKitContinuedProcessingAdapter.swift`; the coordinator stays
  Foundation-testable so `swift test` can exercise lifecycle races.
- Keep `com.dofek.accelerometer-refresh` and the Apple Health wildcard
  `com.dofek.app.healthkit-sync.*` synchronized with
  `BGTaskSchedulerPermittedIdentifiers` in `packages/mobile/app.json`. Submit
  `com.dofek.app.healthkit-sync.<taskId>` with the `.fail` strategy.
- Require a **fresh native `taskId` for every submitted attempt**. Keep the
  durable sync checkpoint/request ID separate from the native task ID, and
  reject a repeated native ID. An identifier may be registered only once per
  process and registering it twice terminates the app, so the coordinator never
  re-registers a submitted ID; see Apple's
  [`BGContinuedProcessingTaskRequest` identifier](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtaskrequest/init(identifier:title:subtitle:))
  and
  [`BGTaskScheduler.register(forTaskWithIdentifier:using:launchHandler:)`](https://developer.apple.com/documentation/backgroundtasks/bgtaskscheduler/register(fortaskwithidentifier:using:launchhandler:)).
  Submission must happen in the foreground; see
  [`BGTaskScheduler.submit(_:)`](https://developer.apple.com/documentation/backgroundtasks/bgtaskscheduler/submit(_:)).
- Do not describe the 15-minute earliest date as a guaranteed refresh
  interval. Apple documents
  [`earliestBeginDate`](https://developer.apple.com/documentation/backgroundtasks/bgtaskrequest/earliestbegindate)
  as the earliest requested start time; scheduling remains system-controlled.

## JavaScript completion

- Await all required work in the callback passed to
  `addBackgroundRefreshListener`; never acknowledge the native task before that
  promise settles.
- Preserve resolution as success and rejection as failure.
- The bridge consumes callback rejection to complete the native task. Report
  unexpected callback errors to Sentry before they reject; never silently
  swallow them or convert failure into success.
- Remove the event subscription during application teardown so pending work
  fails deterministically.

## Tests

- Write the failing test first. Use `index.test.ts` for event and promise-bridge
  behavior, and `BackgroundRefreshTaskCoordinatorTests.swift` /
  `HealthKitSyncTaskCoordinatorTests.swift` for native lifecycle and race
  behavior.
- Preserve focused cases for success, rejection, expiration, no listener,
  listener removal, duplicate late completion, launch gating, registration and
  submission failures, invalid task IDs, stale launches from abandoned
  requests, reused native task IDs, and owner interleavings (teardown or
  expiration during launch-handler installation, queued start followed by
  listener retirement and replacement, and old-owner destruction not ending a
  replacement owner's request).
- `swift test` does not compile the Expo module or app-delegate subscriber
  because `Package.swift` excludes those files. Use an iOS app build when
  changing the native bridge or registration.
- Run the focused TypeScript test, Swift test, and mobile typecheck commands in
  the README.
