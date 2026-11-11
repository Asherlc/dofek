# Uploader cleanup stages implementation plan

Approved scope and validation checkpoints for the native cleanup telemetry change.

**Goal:** Locate a stalled native uploader cleanup without a JavaScript timer.

**Architecture:** Pass a synchronous stage callback from the existing Expo cleanup logger into the uploader. Reuse the same operation ID, elapsed clock, and failure logger; the standalone Swift package stays independent of Sentry.

**Tech Stack:** Swift, XCTest, existing Sentry Cocoa and Expo/Hermes bridge tests.

**Spec:** The user approved extending native telemetry inside uploader shutdown after the November 10 affected-phone operation stopped at `uploader_disable`. This is observability only. Direct native logging already exists; a per-call callback is the smallest connection between the dependency-free uploader and that logger. Additional SDK dependencies or a logging framework are unnecessary.

## Global Constraints

- Keep cleanup order, synchronous behavior, data deletion, account isolation, and error propagation unchanged.
- Preserve existing stages, `operationId`, `durationMs`, and `failedStage`; do not log credentials, account IDs, paths, or health payloads.
- No branch switches, new dependencies, retries, timeouts, or release publication. Work in the existing branch. Push every new commit.

## Review Focus

- Queue contention must emit the waiting stage before acquiring the queue.
- Stage callbacks execute synchronously; no stored callback or cross-operation correlation.
- A throwing cleanup operation must remain thrown and identify its entered stage.
- Ordinary Swift callers and erasure cleanup retain their current behavior without requiring a logger.
- The Expo bridge must deliver all inner stages to the native SDK with the original operation ID.

### Task 1: Instrument uploader boundaries

**Files:** `packages/mobile/modules/whoop-ble/ios/WhoopBleBackgroundUploader.swift`, `ios/WhoopBleModule.swift`, `Tests/WhoopBleBackgroundUploaderTests.swift`, `ios/BridgeTests/WhoopBleModuleTests.swift`, module `README.md`, `docs/production-incident-baseline.md`.

**Interfaces:** `disable(onStage: (String) -> Void = { _ in }) throws`. The bridge passes its existing local `recordStage`. Private `disableLocked` accepts the same callback; `purge(cutoff:)` supplies a no-op callback. No SDK imports in the uploader.

- [x] Update existing bridge assertions FIRST: the successful sequence gains `uploader_queue_wait`, `uploader_cancel_tasks`, `uploader_store_purge`, `uploader_remove_bodies` between `uploader_disable` and `completed`; filesystem failure identifies `uploader_remove_bodies`. Run the bridge suite and confirm the new expectations fail for missing stages before production edits. If generation/build is blocked, report the exact blocker to the lead.
- [x] Implement the callback. Emit `uploader_queue_wait` before `queue.sync`; emit `uploader_cancel_tasks` immediately before `cancelOwnedTasks()`, `uploader_store_purge` before `store.purge()`, and `uploader_remove_bodies` before `removeBodies()`. Preserve all existing statements and order. The bridge's existing catch reports the latest callback stage.
- [x] Add an uploader XCTest holding its serial queue using a test transport hook during reconciliation. Assert the waiting callback is observed while cleanup remains blocked; release using a semaphore with deferred release, then assert ordered stages and actual persisted cleanup. Use test-only synchronization helpers, no production hooks or sleeps. Existing success/error bridge tests prove SDK mapping and failure propagation.
- [x] Run standalone `swift test`, full `pnpm test:ios:bridge`, strict SwiftLint on changed Swift files, module typecheck, README spelling, and `git diff --check`. Record commands/results, including RED evidence. Do not run unrelated repository tests.
- [x] Document stage meaning, affected-phone evidence, unresolved freeze, validation, and required new native build. Cite existing source links and official native logging docs. Retain previous incident entries.
- [x] Lead reviews the actual diff and evidence, obtains independent spec/quality review, corrects findings, then commits and pushes. Do not publish an iOS build or open another PR unless requested.
