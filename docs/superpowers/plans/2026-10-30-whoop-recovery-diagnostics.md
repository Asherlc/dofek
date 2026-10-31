# WHOOP Recovery and Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Keep automatic WHOOP collection alive after transient setup failure and bound synchronous queue diagnostics.
**Architecture:** Reuse cancellation/disconnection recovery in the native connection manager. Read queue sizes from existing transactional counters and timestamp bounds from a covering index.
**Tech Stack:** Swift, CoreBluetooth, SQLite, XCTest.
**Spec:** [Approved scope and design](../specs/2026-10-30-whoop-recovery-diagnostics-design.md).

## Global Constraints

- Preserve explicit Disconnect, Stop, typed explicit connection errors, account isolation, erasure and exact reservations.
- No timeout increases, new retry delays, duplicate sensor storage, test-only production API or remote mutations.
- Stay on the current isolated branch. Push commits automatically.

## Review Focus

- Cancellation must retain the actual peripheral until its disconnect callback and ignore late setup callbacks.
- Explicit Disconnect or Stop during cancellation must prevent renewed collection/IMU restoration respectively.
- Structural incompatibility must not produce an endless automatic reconnect loop.
- Counter-derived counts must include reserved rows and survive erasure, purge, rollback and reopen.
- Bounds must use sample time rather than insertion order and work for empty streams.

### Task 1: Preserve automatic recovery

**Files:** `WhoopBleConnectionManager+Handshake.swift`, `WhoopBleConnectionState.swift`, `WhoopBleClient.swift`, and their existing tests under `packages/mobile/modules/whoop-ble/`.
**Interfaces:** Existing `abortHandshake`, `handleDisconnection`, and readiness transitions; internal disconnecting state maps to public connecting.

- [x] Add regressions for passive timeout and transient discovery/subscription errors, repeated failure, late callbacks and Stop/Disconnect during cancellation; run the focused Swift tests and observe failure.
- [x] Retain automatic recovery through cancellation, then reuse disconnect-driven reconnect. Keep explicit and structural failures terminal.
- [x] Run connection/handshake/client tests and review the state transitions.
- [x] Commit and push the recovery correction.

### Task 2: Bound diagnostic work

**Files:** `WhoopBleSampleStore.swift`, `WhoopBleSampleStoreTests.swift`, local test helpers if needed.
**Interfaces:** Existing `queuedCount(stream:limit:)` and `statistics(stream:)` payload remain unchanged.

- [x] Add a real SQLite instruction-budget regression for a populated queue and exact mixed-stream/time-bound fixtures; observe scan failures before changing queries.
- [x] Derive count from lifecycle counters and use separate bounds through the covering stream/time index.
- [x] Run store/uploader tests and benchmark the copied incident queue, including first-open index creation.
- [x] Commit and push the diagnostics correction.

### Task 3: Whole-change validation and review

- [x] Run the full WHOOP Swift suite, native lint and applicable TypeScript checks.
- [x] Update module documentation and incident evidence, including first-open index cost and native rebuild requirement.
- [x] Obtain a fresh reviewer, address material findings with regressions, and rerun affected checks.
- [x] Commit/push final documentation and report validation and deployment limits.

## Working notes

Scope approved in the conversation. Execute inline without repeating the approval request. The two changes share no code interfaces. Their review gates are focused red/green tests per task and a final independent diff review.
