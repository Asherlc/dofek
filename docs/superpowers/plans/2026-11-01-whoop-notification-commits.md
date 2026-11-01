# WHOOP notification commits implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this single task.

**Goal:** Reduce measured SQLite page writes while committing every BLE notification before returning.

**Architecture:** Store and uploader expose one canonical `append(deviceId:samplesByStream:)` operation. The bridge supplies all streams already decoded from one notification. One SQLite transaction commits them in sensor-record, realtime, IMU order; uploads retain separate reservations and routes.

**Tech stack:** Existing Swift, SQLite, XCTest; no new dependencies or schema/index changes.

**Spec:** [Approved Sentry triage](../../incidents/2026-11-01-sentry-triage.md#implementation-direction-proposed-after-triage). Real synthetic SQLite measurements of the existing append path showed 13,711 versus 10,392 cache-page writes for 1,000 paired realtime/raw notifications, and 30,957 versus 22,926 when each also contains 20 IMU rows. These count SQLite page writes, not physical-device bytes. Apple's [disk-write guidance](https://developer.apple.com/documentation/xcode/reducing-disk-writes) recommends grouping database work in transactions.

## Global constraints

- Keep `synchronous=FULL`, WAL settings, and committed-before-return capture unchanged.
- Never buffer across notifications; account changes and erasure keep their existing semantics.
- One canonical append API; migrate its production and test callers rather than adding a compatibility overload.
- A malformed stream rolls back the complete notification and all of its counters.

## Review focus

- Zero, one, or several populated streams; no placeholder samples.
- Malformed late stream cannot leave earlier streams or counters committed.
- Reopening the store preserves all committed streams.
- Device cutoff applies to each stream; account generations still fence reservations.
- Upload schedules remain coalesced and streams progress independently.

### Task 1: Commit a decoded notification atomically

**Files:** SampleStore, BackgroundUploader, module connection delegate, their existing focused XCTest files, SQLiteWorkProbe in test helpers, module README, incident baseline.

**Interfaces:** Canonical store/uploader `append(deviceId: String, samplesByStream: [WhoopUploadStream: [[String: Any]]]) throws` replaces the single-stream append; no other public API changes.

- [x] Add failing real-SQLite tests for mixed-stream reopen, cross-stream rollback, cutoff/counters, and fewer cache-page writes than separate per-stream commits. Instrument the existing connection with SQLite's [cache-write counter](https://sqlite.org/c3ref/c_dbstatus_options.html) in test helpers only.
- [x] Run `swift test --package-path packages/mobile/modules/whoop-ble --filter WhoopBleSampleStoreTests`. Expected RED for the absent grouped API.
- [x] Implement one transaction around all present streams; extract the existing per-stream insertion body as a private locked helper. Update uploader scheduling once per notification, then migrate all callers to the canonical API.
- [x] Run the full standalone `swift test --package-path packages/mobile/modules/whoop-ble` and strict SwiftLint over changed Swift files. Expected PASS, including existing reservation, account-switch, erasure, retry and independent-stream cases.
- [x] Review API migration and rollback boundaries; document measured scope and native-build limitation. Commit and push.
