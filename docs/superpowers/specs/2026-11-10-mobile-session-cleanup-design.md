# Responsive native session cleanup

## Requirement and evidence

The latest iPhone installation shows a loading spinner and tabs that cannot be pressed online; the same navigation responds offline. Public session verification returns HTTP 401 in 3–4 ms. On TestFlight build 1794334431, native operation `1924D220-5C3E-4AD0-99B1-AE7F5C760C20` reaches `uploader_store_purge` at 18:43:38 UTC, after queue acquisition and task cancellation, without completion or failure. [Sentry cleanup logs](https://east-bay-software.sentry.io/explore/logs/?project=4511073386627073&logsQuery=message%3A%22WHOOP%20cleanup%20stage%22) record the operation.

The [bridge](../../../packages/mobile/modules/whoop-ble/ios/WhoopBleModule.swift) exposes `disableUploads` as a synchronous function. [Session cleanup](../../../packages/mobile/lib/auth.ts) calls it inside a Promise executor, which still executes synchronously. Expo documents that [synchronous functions block JavaScript and AsyncFunction runs native work asynchronously](https://docs.expo.dev/modules/module-api/).

## Proposed approach

Use stock Expo `AsyncFunction` for disk-backed cleanup and any diagnostics that can wait on the same uploader queue during teardown. Await those operations in their existing callers. Reserve the existing session-persistence queue position immediately, and await native cleanup within that serialized operation before clearing credentials or allowing a subsequent session write. Preserve native capture suspension, task cancellation, ownership/generation invalidation, sample deletion, failure reporting and account-erasure ordering. No new coordinator, retry, timeout or cleanup bypass.

This addresses the proven JavaScript blocking boundary. SQLite purge must also be exercised against a real backlog and reach completion; asynchronous dispatch alone is insufficient evidence of successful sign-out or recovery. If that validation exposes a separate database defect, record it and seek agreement before changing the deletion strategy.

## Alternatives and scope

Keeping synchronous disk work cannot meet the responsive UI requirement. Deferring the same synchronous bridge call with a JavaScript timer still blocks once invoked. Automatic token replacement or skipping native cleanup would violate session ownership. The stock asynchronous bridge is the proposed minimum change; it requires updating the actual native callers rather than carrying compatibility aliases.

This is native-specific work. Shared server behavior and the web client do not use this bridge. Preserve the current user-facing errors and cleanup gates; add no unrelated UI feature or database framework.

## Acceptance

- Regression coverage proves pending native cleanup cannot let a later session write overtake it, and cleanup failures remain actionable/reportable.
- Real SQLite cleanup removes samples and retired upload identities and completes with representative queued data.
- Native bridge verification demonstrates JavaScript remains responsive while cleanup is pending; follow-up diagnostics cannot synchronously re-block teardown.
- Existing auth, WHOOP, ownership and account-erasure tests pass, along with repository lint/typechecks and relevant Swift checks.
- Review the actual diff, push, release through the canonical workflow, then verify online startup on the affected iPhone. Keep the current hang issue open until that succeeds.

Status: proposed, awaiting operator agreement before implementation.
