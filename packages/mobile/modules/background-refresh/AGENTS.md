# Background Refresh Agent Guidelines

Read the [README.md](./README.md) first for the runtime contract, public API,
native configuration, and authoritative platform references.

## Ownership

- Keep launch-time registration and native task rescheduling in
  `BackgroundRefreshAppDelegateSubscriber.swift`.
- Keep event bridging and exported native functions in
  `BackgroundRefreshModule.swift`; keep `index.ts` as the only TypeScript entry
  point.
- Keep task lifecycle state in `BackgroundRefreshTaskCoordinator.swift`.
  Expiration, JavaScript completion, and listener teardown may race, but each
  stored native completion may run at most once.
- Keep `com.dofek.accelerometer-refresh` synchronized with
  `BGTaskSchedulerPermittedIdentifiers` in `packages/mobile/app.json`.
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
  behavior, and `BackgroundRefreshTaskCoordinatorTests.swift` for native
  lifecycle and race behavior.
- Preserve focused cases for success, rejection, expiration, no listener,
  listener removal, and duplicate late completion.
- `swift test` does not compile the Expo module or app-delegate subscriber
  because `Package.swift` excludes those files. Use an iOS app build when
  changing the native bridge or registration.
- Run the focused TypeScript test, Swift test, and mobile typecheck commands in
  the README.
