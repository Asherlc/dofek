# WHOOP startup implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Keep WHOOP upload initialization off application lifecycle callbacks while preserving durable storage and background completion delivery.

**Architecture:** A native upload bootstrap owns one serial utility queue, its uploader factory, and the successfully initialized uploader. Synchronous native consumers still obtain that same uploader, while module creation and background-session callbacks enqueue initialization without blocking their callers. Storage errors remain visible through the module capture-failure path or native Sentry reporting.

**Tech stack:** Existing Swift, Foundation DispatchQueue, SQLite, XCTest; no new dependencies.

**Spec:** [Approved Sentry triage and proposed direction](../../incidents/2026-11-01-sentry-triage.md#implementation-direction-proposed-after-triage), approved in conversation on November 1.

## Global constraints

- Preserve committed-before-return sample capture, exact batch acknowledgment, account ownership, and device erasure cutoffs.
- One canonical uploader and SQLite store; no optional-module shim or second consumer.
- Native-only behavior; web has no corresponding native callback.
- No timeout, retry, durability, or error-filter changes in this startup correction.
- Use the existing isolated workspace; push new commits automatically. Do not switch branches.

## Review focus

- A background callback arriving while initialization is blocked must return promptly.
- Concurrent startup and synchronous consumers must create only one uploader.
- Failed initialization must report the original error and release the OS completion on main exactly once.
- Successful background completion must remain owned by the uploader's finish-events lifecycle.
- A failed initialization must not cache a broken uploader or permanently prevent later successful initialization.

### Task 1: Serialize runtime creation away from lifecycle callers

**Files:**
- Create `packages/mobile/modules/whoop-ble/ios/WhoopBleUploadBootstrap.swift` and focused `Tests/WhoopBleUploadBootstrapTests.swift`.
- Modify `ios/WhoopBleUploadRuntime.swift`, `ios/WhoopBleUploadAppDelegateSubscriber.swift`, and `ios/WhoopBleModule.swift` in that module.
- Update the module README and incident baseline with evidence and validation boundaries.

**Interfaces:**
- Bootstrap initializer consumes `makeUploader: () throws -> WhoopBleBackgroundUploader` and `reportError: (Error) -> Void`.
- `shared() throws -> WhoopBleBackgroundUploader` serializes successful construction.
- `prepare(onFailure: @escaping (Error) -> Void)` schedules initialization.
- `handleBackgroundEvents(completionHandler: @escaping () -> Void)` schedules attachment and releases failed initialization's completion on main.
- Runtime retains its existing `shared()` API and delegates new asynchronous lifecycle methods to this bootstrap.

- [x] Write XCTest regressions for blocked initialization and prompt lifecycle return, concurrent shared identity, preparation error propagation/recovery, successful finish-events delivery, and failed attachment's exactly-once main completion. Use real temporary SQLite stores and a stub transport; control factory blocking with semaphores rather than sleeps.
- [x] Run `swift test --package-path packages/mobile/modules/whoop-ble --filter WhoopBleUploadBootstrapTests`. Expected: RED because the new bootstrap API is absent.
- [x] Implement the bootstrap with a serial utility queue. Only cache a successfully constructed uploader. Keep callbacks free of synchronous queue cycles.
- [x] Delegate runtime creation to the bootstrap; enqueue module preparation with failure returned asynchronously to the BLE queue. Delegate the app subscriber's matching-session callback to asynchronous attachment; preserve immediate completion for other sessions.
- [x] Run the focused tests and full standalone `swift test --package-path packages/mobile/modules/whoop-ble`. Expected: PASS. Run strict SwiftLint on changed Swift files and compile the real Expo bridge when local prerequisites permit; retain exact prerequisite failures rather than treating SwiftPM as bridge validation.
- [x] Review the entire diff for callback ordering, account erasure, singleton identity, and original error propagation; record findings in the execution ledger.
- [x] Commit and push the correction, then record test output and remaining physical-device/native-release validation.

Disk-write remediation follows a separate evidence-based change after measurements. Verified Sentry closures and provider reporting classification are tracked separately on the progress dashboard; they do not change the bootstrap interface.

Apple recommends asynchronous file access and avoiding immediate main-thread I/O in its [file-system performance guidance](https://developer.apple.com/documentation/foundation/improving-performance-and-stability-when-accessing-the-file-system).
